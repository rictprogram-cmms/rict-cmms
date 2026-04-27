import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { buildClassWeeks } from '@/hooks/useWeeklyLabs'
import toast from 'react-hot-toast'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWeekRange(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Monday
  const start = new Date(d)
  start.setDate(diff)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function toDateStr(d) {
  return d.toISOString().split('T')[0]
}

/** Round decimal hours to the nearest minute */
function roundToMinute(h) {
  return Math.round((h || 0) * 60) / 60
}

/**
 * Returns true if a class's date window overlaps with the selected date range.
 * - Null start_date → no start restriction (e.g. Work Study)
 * - Null end_date   → no end restriction (ongoing class)
 * - Both null       → always active (e.g. Work Study with no dates)
 */
function classActiveInRange(c, rangeStart, rangeEnd) {
  const classStart = c.start_date ? c.start_date.split('T')[0] : null
  const classEnd   = c.end_date   ? c.end_date.split('T')[0]   : null
  if (!classStart && !classEnd) return true
  const startOk = !classStart || classStart <= rangeEnd
  const endOk   = !classEnd   || classEnd   >= rangeStart
  return startOk && endOk
}

/** Parse "HH:MM:SS" or "HH:MM" to minutes since midnight */
function timeToMinutes(timeStr) {
  if (!timeStr) return null
  const parts = timeStr.split(':')
  return parseInt(parts[0]) * 60 + parseInt(parts[1] || '0')
}

/** Extract local date string (YYYY-MM-DD) from a timestamp */
function extractDateFromTimestamp(ts) {
  if (!ts) return null
  // The timestamps are stored as UTC but actually represent local time
  // e.g. "2026-01-20 09:51:41+00" means 9:51 AM local
  // This will be normalized to proper UTC at spring break cutover.
  const d = new Date(ts)
  const yr = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dy = String(d.getUTCDate()).padStart(2, '0')
  return `${yr}-${mo}-${dy}`
}

/** Extract local time-of-day in minutes from a timestamp */
function extractTimeMinutes(ts) {
  if (!ts) return null
  const d = new Date(ts)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** Convert a local Date to an ISO string stored as UTC (local-as-UTC convention) */
function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}+00`
}

// ─── Users List (for instructor dropdown) ─────────────────────────────────────

export function useUsersForReports({ canViewAll = false } = {}) {
  const { profile } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!canViewAll) { setLoading(false); return }
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role, email, status')
        .eq('status', 'Active')
        .order('last_name')
      if (error) throw error
      const validUsers = (data || []).filter(u => u.user_id && u.user_id.trim() !== '')
      setUsers(validUsers)
    } catch (err) {
      console.error('Users for reports error:', err)
    } finally {
      setLoading(false)
    }
  }, [canViewAll])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when profiles change (new users, role changes, etc.)
  useEffect(() => {
    if (!canViewAll) return
    const channel = supabase
      .channel('tc-users-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [canViewAll, fetch])

  return { users, loading }
}

// ─── Classes list ─────────────────────────────────────────────────────────────

export function useClassesList({ includeInactive = false } = {}) {
  const [classes, setClasses] = useState([])

  const fetch = useCallback(async () => {
    try {
      let query = supabase.from('classes').select('*').order('course_id')
      // When includeInactive is false, restrict to Active only and exclude future classes.
      // When true, fetch all so historical reports can reference old classes.
      if (!includeInactive) {
        const todayStr = new Date().toISOString().substring(0, 10)
        query = query.eq('status', 'Active').or(`start_date.is.null,start_date.lte.${todayStr}`)
      }
      const { data, error } = await query
      if (error) throw error
      setClasses(data || [])
    } catch (err) {
      console.error('Classes fetch error:', err)
    }
  }, [includeInactive])

  useEffect(() => { fetch() }, [fetch])
  return { classes }
}

// ─── Time Card Data (with attendance analysis) ────────────────────────────────

export function useTimeCardData() {
  const { profile } = useAuth()
  const [entries, setEntries] = useState([])
  const [classSummary, setClassSummary] = useState({})
  const [totalHours, setTotalHours] = useState(0)
  const [loading, setLoading] = useState(false)
  const [pendingEdits, setPendingEdits] = useState({})
  const [attendanceSummary, setAttendanceSummary] = useState({
    lateArrivals: 0,
    earlyDepartures: 0,
    noShows: 0,
    walkIns: 0,
    wrongClass: 0,
    totalLateMinutes: 0,
    totalEarlyMinutes: 0,
    onTimeCount: 0,
    totalEntries: 0,
    attendanceScore: 100,
  })

  // Store the last fetched params so real-time can re-fetch with same filters
  const lastFetchParamsRef = useRef(null)

  const fetchTimeCard = useCallback(async (userId, startDate, endDate) => {
    if (!userId) return
    // Store params for real-time refetch
    lastFetchParamsRef.current = { userId, startDate, endDate }
    setLoading(true)
    try {
      // 1. Get user email for lab_signup matching
      const { data: userData } = await supabase
        .from('profiles')
        .select('email, classes')
        .eq('user_id', userId)
        .maybeSingle()

      const userEmail = userData?.email || ''

      // 2. Fetch grace period from settings
      let gracePeriod = 10 // default
      try {
        const { data: graceSetting } = await supabase
          .from('settings')
          .select('setting_value')
          .eq('setting_key', 'grace_period_minutes')
          .maybeSingle()
        if (graceSetting?.setting_value) {
          gracePeriod = parseInt(graceSetting.setting_value) || 10
        }
      } catch {}

      // 3. Fetch time clock entries
      const { data: tcData, error: tcError } = await supabase
        .from('time_clock')
        .select('*')
        .eq('user_id', userId)
        .gte('punch_in', startDate)
        .lte('punch_in', endDate + 'T23:59:59')
        .order('punch_in', { ascending: true })

      if (tcError) throw tcError
      const records = tcData || []

      // 3b. Fetch pending edit requests for this user's entries
      const pendingMap = {}
      if (userEmail) {
        try {
          const { data: pendingReqs } = await supabase
            .from('time_entry_requests')
            .select('request_id, time_clock_record_id, start_time, end_time, requested_date, reason, status')
            .eq('user_email', userEmail)
            .eq('status', 'Pending')
            .eq('entry_type', 'Edit')
          if (pendingReqs) {
            pendingReqs.forEach(r => {
              if (r.time_clock_record_id) {
                pendingMap[r.time_clock_record_id] = r
              }
            })
          }
        } catch {}
      }
      setPendingEdits(pendingMap)

      // 4. Fetch lab signups for this user in date range (Confirmed only)
      let signups = []
      if (userEmail) {
        try {
          const { data: suData } = await supabase
            .from('lab_signup')
            .select('date, start_time, end_time, class_id, status')
            .eq('user_email', userEmail)
            .eq('status', 'Confirmed')
            .gte('date', startDate)
            .lte('date', endDate + 'T23:59:59')
          signups = suData || []
        } catch (err) {
          console.warn('Lab signup fetch for attendance:', err)
        }
      }

      // 4b. Fetch weekly_lab_tracker rows for this user.
      // NOTE: We deliberately do NOT filter by week_start_date/week_end_date here —
      // most tracker rows have empty/NULL date columns (only week_number is reliably stored).
      // We match rows to the viewing period below using week_number + the class's calendar.
      let labTrackerRows = []
      if (userEmail) {
        try {
          const orFilter = [`user_email.eq.${userEmail}`]
          if (userId) orFilter.push(`user_id.eq.${userId}`)
          const { data: ltData } = await supabase
            .from('weekly_lab_tracker')
            .select('course_id, class_id, week_number, week_start_date, week_end_date, all_done, lab_complete, required_hours_met')
            .or(orFilter.join(','))
          labTrackerRows = ltData || []
        } catch (err) {
          console.warn('Weekly lab tracker fetch:', err)
        }
      }

      // 5. Group signups by date → earliest start, latest end
      const signupsByDate = {}
      signups.forEach(s => {
        // Extract just the date portion (lab_signup.date might be ISO or date string)
        const d = (s.date || '').split('T')[0]
        if (!d) return
        if (!signupsByDate[d]) signupsByDate[d] = { startMin: Infinity, endMin: 0, slots: [] }
        const sMin = timeToMinutes(s.start_time)
        const eMin = timeToMinutes(s.end_time)
        if (sMin !== null && sMin < signupsByDate[d].startMin) signupsByDate[d].startMin = sMin
        if (eMin !== null && eMin > signupsByDate[d].endMin) signupsByDate[d].endMin = eMin
        signupsByDate[d].slots.push({
          startTime: s.start_time,
          endTime: s.end_time,
          classId: s.class_id
        })
      })

      // 6. Pre-compute daily attendance spans (across all class entries on same day)
      // This prevents flagging class-switches as late/early
      const daySpans = {}
      records.forEach(r => {
        if (r.status === 'No Show' || r.entry_type === 'Volunteer' || r.entry_type === 'Work Study') return
        const d = extractDateFromTimestamp(r.punch_in)
        if (!d) return
        if (!daySpans[d]) daySpans[d] = { firstPunchIn: Infinity, lastPunchOut: 0, hasStillIn: false, firstRecordId: null, lastRecordId: null, hasAllDone: false }
        if (r.entry_type === 'All Done') {
          // Track that this day has an All Done swipe (used to suppress Left Early flags)
          // but exclude from firstPunchIn/lastPunchOut computation
          daySpans[d].hasAllDone = true
          return
        }
        const piMin = extractTimeMinutes(r.punch_in)
        const poMin = extractTimeMinutes(r.punch_out)
        const isStillIn = r.status === 'Punched In'
        if (piMin !== null && piMin < daySpans[d].firstPunchIn) {
          daySpans[d].firstPunchIn = piMin
          daySpans[d].firstRecordId = r.record_id
        }
        if (!isStillIn && poMin !== null && poMin > daySpans[d].lastPunchOut) {
          daySpans[d].lastPunchOut = poMin
          daySpans[d].lastRecordId = r.record_id
        }
        if (isStillIn) daySpans[d].hasStillIn = true
      })

      // Pre-compute which record_ids get late/early flags for each date
      const lateFlagRecords = new Set()
      const earlyFlagRecords = new Set()
      const dayLateInfo = {} // date → { isLate, lateMinutes }
      const dayEarlyInfo = {} // date → { isEarly, earlyMinutes }

      Object.entries(daySpans).forEach(([date, span]) => {
        const daySignup = signupsByDate[date]
        if (!daySignup || daySignup.startMin === Infinity) return

        // Late check: use day's earliest arrival
        if (span.firstPunchIn !== Infinity && span.firstRecordId) {
          const lateBy = span.firstPunchIn - daySignup.startMin
          dayLateInfo[date] = { isLate: lateBy > gracePeriod, lateMinutes: lateBy > gracePeriod ? lateBy : 0 }
          if (lateBy > gracePeriod) lateFlagRecords.add(span.firstRecordId)
        }

        // Early check: use day's latest departure (only if no one still in).
        // SKIP if the day has an All Done swipe — instructor closed out the day,
        // so the student leaving before signup end is sanctioned, not a left-early.
        if (!span.hasAllDone && !span.hasStillIn && span.lastPunchOut > 0 && span.lastRecordId && daySignup.endMin > 0) {
          const earlyBy = daySignup.endMin - span.lastPunchOut
          dayEarlyInfo[date] = { isEarly: earlyBy > gracePeriod, earlyMinutes: earlyBy > gracePeriod ? earlyBy : 0 }
          if (earlyBy > gracePeriod) earlyFlagRecords.add(span.lastRecordId)
        }
      })

      // 7. Analyze each entry for attendance flags using pre-computed day-span data
      let lateCount = 0, earlyCount = 0, noShowCount = 0, walkInCount = 0, wrongClassCount = 0
      let totalLateMins = 0, totalEarlyMins = 0, onTimeCount = 0

      const enrichedRecords = records.map(r => {
        const entryDate = extractDateFromTimestamp(r.punch_in)
        const isStillIn = r.status === 'Punched In'
        const isNoShow = r.status === 'No Show'
        const isVolunteer = r.entry_type === 'Volunteer'
        const isWorkStudy = r.entry_type === 'Work Study'

        // Default flags
        const flags = {
          isLate: false,
          lateMinutes: 0,
          isEarlyDeparture: false,
          earlyMinutes: 0,
          isWalkIn: false,
          isNoShow: false,
          isOnTime: false,
          isWrongClass: false,
          wrongClassExpected: null, // course_id(s) the student should have punched into
          scheduledStart: null,
          scheduledEnd: null,
          scheduledSlots: 0,
        }

        if (isNoShow) {
          flags.isNoShow = true
          noShowCount++
          return { ...r, flags }
        }

        if (isVolunteer || isWorkStudy) {
          return { ...r, flags }  // no attendance tracking for volunteer or work study
        }

        const isAllDone = r.entry_type === 'All Done'
        if (isAllDone) {
          flags.isOnTime = true
          onTimeCount++
          return { ...r, flags }
        }

        const daySignup = entryDate ? signupsByDate[entryDate] : null

        if (!daySignup || daySignup.startMin === Infinity) {
          flags.isWalkIn = true
          walkInCount++
          return { ...r, flags }
        }

        flags.scheduledStart = daySignup.startMin
        flags.scheduledEnd = daySignup.endMin
        flags.scheduledSlots = daySignup.slots.length

        // Wrong-class detection: student has signups that overlap this entry's time,
        // but none of those overlapping signup slots are for this entry's course.
        // Treat as neutral (excluded from on-time score) — informational only.
        const entryStartMin = extractTimeMinutes(r.punch_in)
        const entryEndMin = extractTimeMinutes(r.punch_out)
        const entryCourse = r.course_id || r.class_id || ''
        if (entryStartMin !== null && entryEndMin !== null && entryCourse) {
          const overlappingSlots = daySignup.slots.filter(s => {
            const sStart = timeToMinutes(s.startTime)
            const sEnd = timeToMinutes(s.endTime)
            if (sStart === null || sEnd === null) return false
            // overlap if entry start < slot end AND entry end > slot start
            return entryStartMin < sEnd && entryEndMin > sStart
          })
          if (overlappingSlots.length > 0) {
            const matchedSlot = overlappingSlots.some(s => s.classId === entryCourse)
            if (!matchedSlot) {
              flags.isWrongClass = true
              flags.wrongClassExpected = [...new Set(overlappingSlots.map(s => s.classId))].join(', ')
              wrongClassCount++
              return { ...r, flags }
            }
          }
        }

        // Late: only on the entry with the day's earliest punch_in
        if (lateFlagRecords.has(r.record_id)) {
          const info = dayLateInfo[entryDate]
          flags.isLate = true
          flags.lateMinutes = info.lateMinutes
          lateCount++
          totalLateMins += info.lateMinutes
        } else {
          flags.isOnTime = true
          onTimeCount++
        }

        // Early departure: only flag if entry_type is Left Early (instructor-approved keeps Class)
        if (earlyFlagRecords.has(r.record_id) && r.entry_type === 'Left Early') {
          const info = dayEarlyInfo[entryDate]
          flags.isEarlyDeparture = true
          flags.earlyMinutes = info.earlyMinutes
          earlyCount++
          totalEarlyMins += info.earlyMinutes
        }

        return { ...r, flags }
      })

      setEntries(enrichedRecords)

      // 7. Calculate class hours from actual time entries in this date range
      const classHrsFromEntries = {}
      let total = 0
      records.forEach(r => {
        const cls = r.course_id || r.class_id || 'Unknown'
        const hrs = parseFloat(r.total_hours) || 0
        const isVolunteer = r.entry_type === 'Volunteer'
        if (!isVolunteer) {
          if (!classHrsFromEntries[cls]) classHrsFromEntries[cls] = { hours: 0 }
          classHrsFromEntries[cls].hours += hrs
        }
        total += hrs
      })

      // Enrolled course IDs from the user's profile
      const enrolledClasses = (userData?.classes || '')
        .split(',').map(c => c.trim()).filter(c => c)

      // Fetch metadata for ALL relevant classes (no status filter) so we get
      // requiredHours / courseName for both active and inactive classes
      const coursesWithEntries = Object.keys(classHrsFromEntries)
      const allRelevantCourseIds = [...new Set([...enrolledClasses, ...coursesWithEntries])]

      let classesData = []
      if (allRelevantCourseIds.length > 0) {
        const { data } = await supabase
          .from('classes')
          .select('class_id, course_id, course_name, required_hours, status, start_date, end_date, spring_break_start, spring_break_end, finals_start, finals_end')
          .in('course_id', allRelevantCourseIds)
        classesData = data || []
      }

      // Build the final classHrs map using date-range awareness:
      //   - Enrolled class whose date window overlaps the selected range: always show
      //     (even 0 hrs — student is expected to be attending)
      //   - Class outside the selected date range: only show if there are actual entries
      //     (handles edge case of data entered on a wrong date)
      //   - Inactive class with no entries in range: hidden
      const classHrs = {}

      // Build "week-closed" map: per course_id, was there any all_done=Yes row
      // (or required_hours_met=Yes) for a week_number that overlaps the viewing period?
      //
      // Two independent signals are merged here:
      //   (a) weekly_lab_tracker rows with all_done=true — covers tracked classes
      //   (b) time_clock entries with entry_type='All Done' — covers ALL classes
      //       (including tracking_type='None' classes like ones tracked in D2L,
      //       which never get tracker rows created for them)
      //
      // Background: weekly_lab_tracker rows historically have empty week_start_date /
      // week_end_date columns — only week_number is reliably populated. So we match
      // tracker rows to the visible period by computing each class's week calendar
      // (via buildClassWeeks) and checking which week_numbers overlap the view.
      const isYes = (v) => v === 'Yes' || v === true

      // Per course_id, collect the set of week_numbers that fall in the viewing period
      // using each class's own calendar (handles spring break / finals correctly).
      const overlappingWeekNumsByCourse = {}
      classesData.forEach(c => {
        const key = c.course_id || c.class_id
        if (!key) return
        if (!c.start_date || !c.end_date) return
        const weeks = buildClassWeeks({
          startDate: c.start_date, endDate: c.end_date,
          springBreakStart: c.spring_break_start, springBreakEnd: c.spring_break_end,
          finalsStart: c.finals_start, finalsEnd: c.finals_end,
        })
        const overlapNums = weeks.filter(wk => {
          const wkStart = (wk.startDate || '').substring(0, 10)
          const wkEnd = (wk.endDate || '').substring(0, 10)
          if (!wkStart || !wkEnd) return false
          // overlap if wkEnd >= startDate AND wkStart <= endDate
          return wkEnd >= startDate && wkStart <= endDate
        }).map(w => w.weekNumber)
        if (overlapNums.length > 0) {
          overlappingWeekNumsByCourse[key] = new Set(overlapNums)
        }
      })

      const weekClosedByCourse = {}

      // Signal (a): weekly_lab_tracker rows
      labTrackerRows.forEach(lt => {
        const key = lt.course_id || lt.class_id
        if (!key) return
        const wkNum = parseInt(lt.week_number)
        if (isNaN(wkNum)) return

        // Match strategy: prefer week_number against the class calendar.
        // Fallback: if the tracker row has populated dates AND they overlap the view,
        // accept it (covers the rare row that does have dates, or off-calendar weeks).
        const overlapSet = overlappingWeekNumsByCourse[key]
        const matchedByWeekNum = overlapSet && overlapSet.has(wkNum)

        let matchedByDate = false
        if (lt.week_start_date && lt.week_end_date) {
          const ws = String(lt.week_start_date).substring(0, 10)
          const we = String(lt.week_end_date).substring(0, 10)
          matchedByDate = we >= startDate && ws <= endDate
        }

        if (!matchedByWeekNum && !matchedByDate) return

        if (!weekClosedByCourse[key]) {
          weekClosedByCourse[key] = { allDone: false, requiredHoursMet: false }
        }
        if (isYes(lt.all_done)) weekClosedByCourse[key].allDone = true
        if (isYes(lt.required_hours_met)) weekClosedByCourse[key].requiredHoursMet = true
      })

      // Signal (b): time_clock entries with entry_type='All Done'
      // Group All Done entries by Monday-of-week; any course that has ANY entry
      // (or is enrolled) in that same week gets the week-closed flag too.
      // This is what makes the tile turn green for D2L-tracked classes (RICT1610
      // and similar tracking_type='None' courses) which never get tracker rows.
      const allDoneWeeks = new Set()
      records.forEach(r => {
        if (r.entry_type !== 'All Done') return
        const d = extractDateFromTimestamp(r.punch_in)
        if (!d) return
        // Compute Monday of that week as a YYYY-MM-DD key
        const parts = d.split('-')
        const dt = new Date(+parts[0], +parts[1] - 1, +parts[2])
        const day = dt.getDay()
        const offsetToMon = day === 0 ? -6 : 1 - day
        dt.setDate(dt.getDate() + offsetToMon)
        const mondayKey = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
        allDoneWeeks.add(mondayKey)
      })

      if (allDoneWeeks.size > 0) {
        // Determine which courses had entries (or are enrolled) during any all-done week.
        // For simplicity in the typical 1-week view, if there's any All Done in the period,
        // every visible class gets the closed flag.
        const allCourseKeysInView = new Set([
          ...Object.keys(classHrsFromEntries),
          ...classesData.map(c => c.course_id || c.class_id),
        ])
        allCourseKeysInView.forEach(key => {
          if (!key) return
          if (!weekClosedByCourse[key]) {
            weekClosedByCourse[key] = { allDone: false, requiredHoursMet: false }
          }
          weekClosedByCourse[key].allDone = true
          weekClosedByCourse[key].requiredHoursMet = true
        })
      }

      classesData.forEach(c => {
        const key = c.course_id || c.class_id
        const hasEntries = !!classHrsFromEntries[key]
        const isEnrolled = enrolledClasses.includes(c.class_id) ||
          enrolledClasses.includes(c.course_id)
        const isInRange = classActiveInRange(c, startDate, endDate)
        const closure = weekClosedByCourse[key] || { allDone: false, requiredHoursMet: false }

        if (isEnrolled && isInRange) {
          // Class was running during this period — always show tile
          classHrs[key] = {
            hours: classHrsFromEntries[key]?.hours || 0,
            requiredHours: parseFloat(c.required_hours) || 0,
            courseName: c.course_name || '',
            allDone: closure.allDone,
            requiredHoursMet: closure.requiredHoursMet,
          }
        } else if (hasEntries) {
          // Class is outside range or student no longer enrolled but has actual entries —
          // still show so history isn't lost
          classHrs[key] = {
            hours: classHrsFromEntries[key].hours,
            requiredHours: parseFloat(c.required_hours) || 0,
            courseName: c.course_name || '',
            allDone: closure.allDone,
            requiredHoursMet: closure.requiredHoursMet,
          }
        }
        // Otherwise: class not in range and no entries → hidden (e.g. future class on a past week)
      })

      // Safety net: if an entry's course_id didn't match any class record, still show it
      coursesWithEntries.forEach(key => {
        if (!classHrs[key]) {
          const closure = weekClosedByCourse[key] || { allDone: false, requiredHoursMet: false }
          classHrs[key] = {
            hours: classHrsFromEntries[key].hours,
            requiredHours: 0,
            courseName: '',
            allDone: closure.allDone,
            requiredHoursMet: closure.requiredHoursMet,
          }
        }
      })

      setClassSummary(classHrs)
      setTotalHours(total)

      // 8. Attendance summary
      //
      // Per-week scoring (averaged across weeks for the displayed period):
      //   Each week starts at 100% if the student met their required hours OR got
      //   an All Done swipe. Otherwise, the week starts at (hours / required) × 100,
      //   so a student who didn't show up at all for a week's lab gets 0% for that week.
      //
      //   Then per-week deductions apply:
      //     − 10% per Late
      //     − 10% per Left Early (already suppressed at flag time on All Done days)
      //     − 20% per No Show
      //
      //   Walk-ins and Wrong Class are neutral (don't deduct).
      //   Each week is floored at 0%, and the period score is the average across weeks.

      // Build the list of (Monday-anchored) weeks in the visible period that
      // had at least one enrolled class running.
      const requiredHoursByMonday = {}
      classesData.forEach(c => {
        if (!c.start_date || !c.end_date) return
        const isEnrolled = enrolledClasses.includes(c.class_id) ||
          enrolledClasses.includes(c.course_id)
        if (!isEnrolled) return
        const weeks = buildClassWeeks({
          startDate: c.start_date, endDate: c.end_date,
          springBreakStart: c.spring_break_start, springBreakEnd: c.spring_break_end,
          finalsStart: c.finals_start, finalsEnd: c.finals_end,
        })
        weeks.forEach(wk => {
          const wkStart = (wk.startDate || '').substring(0, 10)
          const wkEnd = (wk.endDate || '').substring(0, 10)
          if (!wkStart || !wkEnd) return
          // Only count weeks that overlap the viewing period
          if (!(wkEnd >= startDate && wkStart <= endDate)) return
          requiredHoursByMonday[wkStart] = (requiredHoursByMonday[wkStart] || 0) + (parseFloat(c.required_hours) || 0)
        })
      })

      // Helper: compute the Monday-of-week (YYYY-MM-DD) for any date string
      const mondayOf = (yyyymmdd) => {
        const parts = (yyyymmdd || '').split('-')
        if (parts.length !== 3) return null
        const dt = new Date(+parts[0], +parts[1] - 1, +parts[2])
        const day = dt.getDay()
        const offsetToMon = day === 0 ? -6 : 1 - day
        dt.setDate(dt.getDate() + offsetToMon)
        return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
      }

      // Build a Set of Monday keys for weeks where the user has any tracker row
      // marked all_done=true (the week is closed even without a time_clock All Done).
      const allDoneTrackerMondays = new Set()
      labTrackerRows.forEach(lt => {
        if (!isYes(lt.all_done)) return
        // Prefer the row's own week_start_date if populated; else derive from class calendar
        if (lt.week_start_date) {
          const m = mondayOf(String(lt.week_start_date).substring(0, 10))
          if (m) allDoneTrackerMondays.add(m)
          return
        }
        const wkNum = parseInt(lt.week_number)
        if (isNaN(wkNum)) return
        const courseKey = lt.course_id || lt.class_id
        const cls = classesData.find(c => (c.course_id === courseKey) || (c.class_id === courseKey))
        if (!cls || !cls.start_date || !cls.end_date) return
        const cwks = buildClassWeeks({
          startDate: cls.start_date, endDate: cls.end_date,
          springBreakStart: cls.spring_break_start, springBreakEnd: cls.spring_break_end,
          finalsStart: cls.finals_start, finalsEnd: cls.finals_end,
        })
        const match = cwks.find(w => w.weekNumber === wkNum)
        if (match) {
          const m = mondayOf((match.startDate || '').substring(0, 10))
          if (m) allDoneTrackerMondays.add(m)
        }
      })

      // Group all enriched records by their Monday-of-week
      const recordsByMonday = {}
      enrichedRecords.forEach(r => {
        const d = extractDateFromTimestamp(r.punch_in)
        if (!d) return
        const m = mondayOf(d)
        if (!m) return
        if (!recordsByMonday[m]) recordsByMonday[m] = []
        recordsByMonday[m].push(r)
      })

      // Safety net: if the user has ANY All Done in the period (time_clock or tracker),
      // every week in the period is treated as closed. This prevents per-week-keying bugs
      // from producing a wrong score when an All Done is clearly present.
      const periodHasAllDone =
        records.some(r => r.entry_type === 'All Done') ||
        labTrackerRows.some(lt => isYes(lt.all_done))

      // For every week the period covers (and at least one class was running),
      // compute that week's score.
      const weekScores = []
      Object.entries(requiredHoursByMonday).forEach(([monday, weekRequired]) => {
        const wkRecs = recordsByMonday[monday] || []
        const nonVolunteerWk = wkRecs.filter(r => r.entry_type !== 'Volunteer' && r.entry_type !== 'Work Study')
        let wkLate = 0, wkEarly = 0, wkNoShow = 0
        let wkHours = 0
        let wkHasAllDone = allDoneTrackerMondays.has(monday) || periodHasAllDone
        wkRecs.forEach(r => {
          if (r.entry_type === 'All Done') wkHasAllDone = true
          if (r.entry_type !== 'Volunteer') wkHours += parseFloat(r.total_hours) || 0
        })
        nonVolunteerWk.forEach(r => {
          if (r.flags?.isLate) wkLate++
          if (r.flags?.isEarlyDeparture) wkEarly++
          if (r.flags?.isNoShow) wkNoShow++
        })

        // Base score: 100 if the week was completed (hours met OR All Done swiped),
        // else proportional to the hours achieved.
        let base = 100
        if (!wkHasAllDone && weekRequired > 0 && wkHours < weekRequired) {
          base = Math.min(100, Math.round((wkHours / weekRequired) * 100))
        }
        const score = Math.max(0, base - (wkLate * 10) - (wkEarly * 10) - (wkNoShow * 20))
        weekScores.push(score)
      })

      // Diagnostic: if the user has fetchTimeCard debug enabled, log breakdown.
      // Toggle with localStorage.setItem('rict.debugScore', '1') in the browser console.
      try {
        if (typeof window !== 'undefined' && window.localStorage?.getItem('rict.debugScore') === '1') {
          // eslint-disable-next-line no-console
          console.log('[score-debug]', {
            userId, startDate, endDate,
            enrolledClasses,
            periodHasAllDone,
            requiredHoursByMonday,
            allDoneTrackerMondays: [...allDoneTrackerMondays],
            recordsByMondayCounts: Object.fromEntries(Object.entries(recordsByMonday).map(([k, v]) => [k, v.length])),
            recordEntryTypes: records.map(r => ({ date: extractDateFromTimestamp(r.punch_in), type: r.entry_type, hours: r.total_hours })),
            weekScores,
          })
        }
      } catch {}

      const nonVolunteerEntries = enrichedRecords.filter(r => r.entry_type !== 'Volunteer' && r.entry_type !== 'Work Study')
      const totalEntries = nonVolunteerEntries.length
      const attendanceScore = weekScores.length > 0
        ? Math.round(weekScores.reduce((a, b) => a + b, 0) / weekScores.length)
        : 100

      setAttendanceSummary({
        lateArrivals: lateCount,
        earlyDepartures: earlyCount,
        noShows: noShowCount,
        walkIns: walkInCount,
        wrongClass: wrongClassCount,
        totalLateMinutes: totalLateMins,
        totalEarlyMinutes: totalEarlyMins,
        onTimeCount,
        totalEntries,
        attendanceScore,
        weeksEvaluated: weekScores.length,
        gracePeriod,
      })
    } catch (err) {
      console.error('Time card fetch error:', err)
      toast.error('Failed to load time card data')
    } finally {
      setLoading(false)
    }
  }, [])

  // Real-time: refresh when time_clock or time_entry_requests change
  useEffect(() => {
    const channel = supabase
      .channel('time-card-data-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, () => {
        if (lastFetchParamsRef.current) {
          const { userId, startDate, endDate } = lastFetchParamsRef.current
          fetchTimeCard(userId, startDate, endDate)
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entry_requests' }, () => {
        if (lastFetchParamsRef.current) {
          const { userId, startDate, endDate } = lastFetchParamsRef.current
          fetchTimeCard(userId, startDate, endDate)
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_lab_tracker' }, () => {
        if (lastFetchParamsRef.current) {
          const { userId, startDate, endDate } = lastFetchParamsRef.current
          fetchTimeCard(userId, startDate, endDate)
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchTimeCard])

  return {
    entries, classSummary, totalHours, loading,
    attendanceSummary, pendingEdits, fetchTimeCard
  }
}

// ─── Class Weekly Report ──────────────────────────────────────────────────────

export function useClassWeeklyReport() {
  const [students, setStudents] = useState([])
  const [classInfo, setClassInfo] = useState(null)
  const [loading, setLoading] = useState(false)

  // Store the last fetched params so real-time can re-fetch with same filters
  const lastFetchParamsRef = useRef(null)

  const fetchReport = useCallback(async (courseId, startDate, endDate) => {
    if (!courseId) return
    // Store params for real-time refetch
    lastFetchParamsRef.current = { courseId, startDate, endDate }
    setLoading(true)
    try {
      const { data: classData } = await supabase
        .from('classes')
        .select('*')
        .eq('course_id', courseId)
        .maybeSingle()

      setClassInfo(classData)
      const requiredHours = parseFloat(classData?.required_hours) || 0
      const classId = classData?.class_id || courseId

      const { data: allUsers } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role, classes, email')
        .eq('status', 'Active')
        .in('role', ['Student', 'Work Study'])

      const enrolled = (allUsers || []).filter(u => {
        if (!u.user_id || u.user_id.trim() === '') return false
        const cls = (u.classes || '').split(',').map(c => c.trim())
        return cls.includes(classId) || cls.includes(courseId)
      })

      const userIds = enrolled.map(u => u.user_id)
      let tcRecords = []
      if (userIds.length > 0) {
        const { data } = await supabase
          .from('time_clock')
          .select('*')
          .in('user_id', userIds)
          .gte('punch_in', startDate)
          .lte('punch_in', endDate + 'T23:59:59')
          .neq('entry_type', 'Volunteer')

        tcRecords = data || []
      }

      // Fetch lab signups for all enrolled students for attendance flags
      const emails = enrolled.map(u => u.email).filter(Boolean)
      let allSignups = []
      if (emails.length > 0) {
        try {
          const { data: suData } = await supabase
            .from('lab_signup')
            .select('user_email, date, start_time, end_time, class_id, status')
            .in('user_email', emails)
            .eq('status', 'Confirmed')
            .gte('date', startDate)
            .lte('date', endDate + 'T23:59:59')
          allSignups = suData || []
        } catch {}
      }

      // Fetch grace period
      let gracePeriod = 10
      try {
        const { data: gs } = await supabase
          .from('settings')
          .select('setting_value')
          .eq('setting_key', 'grace_period_minutes')
          .maybeSingle()
        if (gs?.setting_value) gracePeriod = parseInt(gs.setting_value) || 10
      } catch {}

      const studentList = enrolled.map(u => {
        // IMPORTANT: Filter records to only this class for hours calculation
        const userRecords = tcRecords.filter(r =>
          r.user_id === u.user_id &&
          (r.course_id === courseId || r.class_id === classId)
        )
        const totalHours = userRecords.reduce((sum, r) => sum + (parseFloat(r.total_hours) || 0), 0)

        // For attendance: use ALL of the student's records (across all classes) to build day spans
        // This prevents false late/early flags when students switch classes mid-day
        const allUserRecords = tcRecords.filter(r => r.user_id === u.user_id)

        // Build signup map for this student
        const userSignups = allSignups.filter(s => s.user_email === u.email)
        const signupsByDate = {}
        userSignups.forEach(s => {
          const d = (s.date || '').split('T')[0]
          if (!d) return
          if (!signupsByDate[d]) signupsByDate[d] = { startMin: Infinity, endMin: 0, slots: [] }
          const sMin = timeToMinutes(s.start_time)
          const eMin = timeToMinutes(s.end_time)
          if (sMin !== null && sMin < signupsByDate[d].startMin) signupsByDate[d].startMin = sMin
          if (eMin !== null && eMin > signupsByDate[d].endMin) signupsByDate[d].endMin = eMin
          signupsByDate[d].slots.push({
            startTime: s.start_time, endTime: s.end_time, classId: s.class_id
          })
        })

        // Build day spans from ALL records (cross-class) for accurate attendance
        const daySpans = {}
        allUserRecords.forEach(r => {
          const d = extractDateFromTimestamp(r.punch_in)
          if (!d) return
          if (!daySpans[d]) daySpans[d] = { firstPunchIn: Infinity, lastPunchOut: 0, hasStillIn: false, firstRecordId: null, lastRecordId: null, hasAllDone: false }
          if (r.entry_type === 'All Done') {
            daySpans[d].hasAllDone = true
            return
          }
          const piMin = extractTimeMinutes(r.punch_in)
          const poMin = extractTimeMinutes(r.punch_out)
          const isStillIn = r.status === 'Punched In'
          if (piMin !== null && piMin < daySpans[d].firstPunchIn) {
            daySpans[d].firstPunchIn = piMin
            daySpans[d].firstRecordId = r.record_id
          }
          if (!isStillIn && poMin !== null && poMin > daySpans[d].lastPunchOut) {
            daySpans[d].lastPunchOut = poMin
            daySpans[d].lastRecordId = r.record_id
          }
          if (isStillIn) daySpans[d].hasStillIn = true
        })

        // Pre-compute late/early flag record IDs
        // Skip early-departure flagging on days with an All Done swipe.
        const lateFlagRecords = new Set()
        const earlyFlagRecords = new Set()
        Object.entries(daySpans).forEach(([date, span]) => {
          const daySignup = signupsByDate[date]
          if (!daySignup || daySignup.startMin === Infinity) return
          if (span.firstPunchIn !== Infinity && span.firstRecordId) {
            if ((span.firstPunchIn - daySignup.startMin) > gracePeriod) {
              lateFlagRecords.add(span.firstRecordId)
            }
          }
          if (!span.hasAllDone && !span.hasStillIn && span.lastPunchOut > 0 && span.lastRecordId && daySignup.endMin > 0) {
            if ((daySignup.endMin - span.lastPunchOut) > gracePeriod) {
              earlyFlagRecords.add(span.lastRecordId)
            }
          }
        })

        // Count attendance flags — only for THIS class's records, using day-span data
        // Walk-ins (no signup that day) and wrong-class (signed up for a different course
        // at that time) are both treated as neutral — informational only.
        let lateCount = 0, earlyCount = 0, walkInCount = 0, wrongClassCount = 0
        userRecords.forEach(r => {
          if (r.entry_type === 'All Done') return
          const entryDate = extractDateFromTimestamp(r.punch_in)
          const daySignup = entryDate ? signupsByDate[entryDate] : null
          if (!daySignup || daySignup.startMin === Infinity) { walkInCount++; return }

          // Wrong-class check: is there an overlapping signup slot, and does its class match?
          const entryStartMin = extractTimeMinutes(r.punch_in)
          const entryEndMin = extractTimeMinutes(r.punch_out)
          const entryCourse = r.course_id || r.class_id || ''
          if (entryStartMin !== null && entryEndMin !== null && entryCourse) {
            const overlapping = daySignup.slots.filter(s => {
              const sStart = timeToMinutes(s.startTime)
              const sEnd = timeToMinutes(s.endTime)
              if (sStart === null || sEnd === null) return false
              return entryStartMin < sEnd && entryEndMin > sStart
            })
            if (overlapping.length > 0 && !overlapping.some(s => s.classId === entryCourse)) {
              wrongClassCount++
              return
            }
          }

          if (lateFlagRecords.has(r.record_id)) lateCount++
          if (earlyFlagRecords.has(r.record_id) && r.entry_type === 'Left Early') earlyCount++
        })

        return {
          userId: u.user_id,
          name: `${u.first_name} ${(u.last_name || '').charAt(0)}.`,
          fullName: `${u.first_name} ${u.last_name}`,
          role: u.role,
          totalHours: roundToMinute(totalHours),
          requiredHours,
          metRequirement: totalHours >= requiredHours,
          entryCount: userRecords.length,
          lateCount,
          earlyCount,
          walkInCount,
          wrongClassCount,
        }
      }).sort((a, b) => a.fullName.localeCompare(b.fullName))

      setStudents(studentList)
    } catch (err) {
      console.error('Class weekly report error:', err)
      toast.error('Failed to load class report')
    } finally {
      setLoading(false)
    }
  }, [])

  // Real-time: refresh when time_clock changes
  useEffect(() => {
    const channel = supabase
      .channel('class-weekly-report-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, () => {
        if (lastFetchParamsRef.current) {
          const { courseId, startDate, endDate } = lastFetchParamsRef.current
          fetchReport(courseId, startDate, endDate)
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchReport])

  return { students, classInfo, loading, fetchReport }
}

// ─── Time Entry Actions ──────────────────────────────────────────────────────

export function useTimeEntryActions({ canEdit = false } = {}) {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  // ── Instructor/authorized: direct add to time_clock ──
  const addEntry = async (userId, classId, courseName, punchIn, punchOut) => {
    if (!canEdit) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      const { data: user } = await supabase
        .from('profiles')
        .select('first_name, last_name, email')
        .eq('user_id', userId)
        .maybeSingle()

      if (!user) throw new Error('User not found')
      const uName = `${user.first_name} ${(user.last_name || '').charAt(0)}.`

      const piDate = new Date(punchIn)
      const poDate = punchOut ? new Date(punchOut) : null
      const totalHours = poDate ? roundToMinute((poDate - piDate) / 3600000) : 0

      const { data: latest } = await supabase
        .from('time_clock')
        .select('record_id')
        .like('record_id', 'TC%')
        .order('record_id', { ascending: false })
        .limit(1)

      let nextNum = 1
      if (latest && latest.length > 0) {
        const num = parseInt(latest[0].record_id.replace(/\D/g, ''))
        if (!isNaN(num)) nextNum = num + 1
      }
      const recordId = `TC${String(nextNum).padStart(6, '0')}`

      // Use UTC methods since timestamps are in local-as-UTC convention
      const day = piDate.getUTCDay()
      const mondayOffset = day === 0 ? -6 : 1 - day
      const weekStartDate = new Date(Date.UTC(piDate.getUTCFullYear(), piDate.getUTCMonth(), piDate.getUTCDate() + mondayOffset))
      const weekStart = `${weekStartDate.getUTCFullYear()}-${String(weekStartDate.getUTCMonth()+1).padStart(2,'0')}-${String(weekStartDate.getUTCDate()).padStart(2,'0')}`

      const { error } = await supabase.from('time_clock').insert({
        record_id: recordId,
        user_id: userId,
        user_name: uName,
        user_email: user.email,
        class_id: classId,
        course_id: courseName,
        punch_in: piDate.toISOString(),
        punch_out: poDate?.toISOString() || null,
        total_hours: totalHours,
        status: poDate ? 'Punched Out' : 'Punched In',
        week_start: weekStart
      })
      if (error) throw error

      toast.success('Time entry added')
      return { success: true, recordId, totalHours }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Student/Work Study: submit NEW entry request → pending instructor approval ──
  const submitTimeRequest = async (classId, courseName, date, startTime, endTime, reason) => {
    if (!profile) { toast.error('Not logged in'); return }
    setSaving(true)
    try {
      // Form values are local time strings; compute hours directly from minutes
      const startParts = startTime.split(':')
      const endParts = endTime.split(':')
      const startMins = parseInt(startParts[0]) * 60 + parseInt(startParts[1] || '0')
      const endMins = parseInt(endParts[0]) * 60 + parseInt(endParts[1] || '0')
      const totalHours = roundToMinute((endMins - startMins) / 60)

      if (totalHours <= 0) {
        toast.error('End time must be after start time')
        setSaving(false)
        return
      }

      const { data: latest } = await supabase
        .from('time_entry_requests')
        .select('request_id')
        .like('request_id', 'TER%')
        .order('request_id', { ascending: false })
        .limit(1)

      let nextNum = 1
      if (latest && latest.length > 0) {
        const num = parseInt(latest[0].request_id.replace(/\D/g, ''))
        if (!isNaN(num)) nextNum = num + 1
      }
      const requestId = `TER${String(nextNum).padStart(6, '0')}`

      const { error } = await supabase.from('time_entry_requests').insert({
        request_id: requestId,
        user_name: userName,
        user_email: profile.email,
        class_id: classId,
        course_id: courseName,
        requested_date: date,
        start_time: startTime + ':00',
        end_time: endTime + ':00',
        total_hours: totalHours,
        entry_type: 'New',
        reason: reason || '',
        status: 'Pending',
        created_at: new Date().toISOString()
      })

      if (error) throw error

      toast.success('Time entry request submitted for approval')
      return { success: true, requestId }
    } catch (err) {
      console.error('Submit time request error:', err)
      toast.error(err.message || 'Failed to submit request')
    } finally {
      setSaving(false)
    }
  }

  // ── Student/Work Study: submit EDIT request for an existing entry ──
  const submitEditRequest = async (entry, newStartTime, newEndTime, reason) => {
    if (!profile) { toast.error('Not logged in'); return }
    setSaving(true)
    try {
      // Extract date using UTC (local-as-UTC convention)
      const entryDate = entry.punch_in
        ? extractDateFromTimestamp(entry.punch_in)
        : toDateStr(new Date())

      // When the student is still punched in, newEndTime will be empty.
      // In that case we only validate/store the punch-in change.
      const isStillIn = !newEndTime

      let totalHours = 0
      if (!isStillIn) {
        // Compute hours from time strings directly
        const startParts = newStartTime.split(':')
        const endParts = newEndTime.split(':')
        const startMins = parseInt(startParts[0]) * 60 + parseInt(startParts[1] || '0')
        const endMins = parseInt(endParts[0]) * 60 + parseInt(endParts[1] || '0')
        totalHours = roundToMinute((endMins - startMins) / 60)
        if (totalHours <= 0) {
          toast.error('End time must be after start time')
          setSaving(false)
          return
        }
      }

      // Check if there's already a pending edit for this entry
      const { data: existingReq } = await supabase
        .from('time_entry_requests')
        .select('request_id')
        .eq('time_clock_record_id', entry.record_id)
        .eq('status', 'Pending')
        .maybeSingle()

      if (existingReq) {
        toast.error('There is already a pending edit request for this entry')
        setSaving(false)
        return
      }

      const { data: latest } = await supabase
        .from('time_entry_requests')
        .select('request_id')
        .like('request_id', 'TER%')
        .order('request_id', { ascending: false })
        .limit(1)

      let nextNum = 1
      if (latest && latest.length > 0) {
        const num = parseInt(latest[0].request_id.replace(/\D/g, ''))
        if (!isNaN(num)) nextNum = num + 1
      }
      const requestId = `TER${String(nextNum).padStart(6, '0')}`

      const { error } = await supabase.from('time_entry_requests').insert({
        request_id: requestId,
        user_name: userName,
        user_email: profile.email,
        class_id: entry.class_id || '',
        course_id: entry.course_id || '',
        requested_date: entryDate,
        start_time: newStartTime + ':00',
        end_time: isStillIn ? null : newEndTime + ':00',
        total_hours: totalHours,
        entry_type: 'Edit',
        reason: reason || '',
        status: 'Pending',
        created_at: new Date().toISOString(),
        time_clock_record_id: entry.record_id
      })

      if (error) throw error

      toast.success('Edit request submitted — an instructor will review it')
      return { success: true, requestId }
    } catch (err) {
      console.error('Submit edit request error:', err)
      toast.error(err.message || 'Failed to submit edit request')
    } finally {
      setSaving(false)
    }
  }

  const updateEntry = async (recordId, updates) => {
    if (!canEdit) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      const piDate = new Date(updates.punch_in)
      const poDate = updates.punch_out ? new Date(updates.punch_out) : null
      const totalHours = poDate ? roundToMinute((poDate - piDate) / 3600000) : 0

      const { error } = await supabase
        .from('time_clock')
        .update({
          punch_in: piDate.toISOString(),
          punch_out: poDate?.toISOString() || null,
          total_hours: totalHours,
          status: poDate ? 'Punched Out' : 'Punched In',
          ...(updates.class_id && { class_id: updates.class_id }),
          ...(updates.course_id && { course_id: updates.course_id })
        })
        .eq('record_id', recordId)
      if (error) throw error

      toast.success('Time entry updated')
      return { success: true, totalHours }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteEntry = async (recordId) => {
    if (!canEdit) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      const { error } = await supabase
        .from('time_clock')
        .delete()
        .eq('record_id', recordId)
      if (error) throw error
      toast.success('Time entry deleted')
      return { success: true }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Authorized user: punch out a student who forgot ──
  const punchOutEntry = async (recordId, punchInTime) => {
    if (!canEdit) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      const now = new Date()
      const piDate = new Date(punchInTime)
      // Both in local-as-UTC convention: convert current local time to same convention for correct diff
      const nowFakeUtcMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(),
        now.getHours(), now.getMinutes(), now.getSeconds())
      const totalHours = roundToMinute((nowFakeUtcMs - piDate.getTime()) / 3600000)

      const { error } = await supabase
        .from('time_clock')
        .update({
          punch_out: localToUtcIso(now),
          total_hours: totalHours,
          status: 'Punched Out',
        })
        .eq('record_id', recordId)
      if (error) throw error

      toast.success(`Punched out — ${totalHours}h recorded. You can edit the time if needed.`)
      return { success: true, totalHours }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Instructor: approve a pending time entry request ──
  const approveTimeRequest = async (request) => {
    if (!canEdit) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      if (request.entry_type === 'New') {
        // ── NEW request: create a time_clock entry from the request data ──
        const { data: reqUser } = await supabase
          .from('profiles')
          .select('user_id, first_name, last_name, email')
          .eq('email', request.user_email)
          .maybeSingle()

        if (!reqUser) throw new Error('Student profile not found')

        const date = request.requested_date
        const piStr = `${date}T${request.start_time}Z`
        const poStr = request.end_time ? `${date}T${request.end_time}Z` : null

        const piDate = new Date(piStr)
        const poDate = poStr ? new Date(poStr) : null
        const totalHours = poDate ? roundToMinute((poDate - piDate) / 3600000) : 0

        // Generate next TC record_id
        const { data: latest } = await supabase
          .from('time_clock')
          .select('record_id')
          .like('record_id', 'TC%')
          .order('record_id', { ascending: false })
          .limit(1)

        let nextNum = 1
        if (latest && latest.length > 0) {
          const num = parseInt(latest[0].record_id.replace(/\D/g, ''))
          if (!isNaN(num)) nextNum = num + 1
        }
        const recordId = `TC${String(nextNum).padStart(6, '0')}`

        // Compute week_start (Monday) using UTC (local-as-UTC convention)
        const day = piDate.getUTCDay()
        const mondayOffset = day === 0 ? -6 : 1 - day
        const weekStartDate = new Date(Date.UTC(piDate.getUTCFullYear(), piDate.getUTCMonth(), piDate.getUTCDate() + mondayOffset))
        const weekStart = `${weekStartDate.getUTCFullYear()}-${String(weekStartDate.getUTCMonth()+1).padStart(2,'0')}-${String(weekStartDate.getUTCDate()).padStart(2,'0')}`

        const uName = `${reqUser.first_name} ${(reqUser.last_name || '').charAt(0)}.`

        const { error: insertErr } = await supabase.from('time_clock').insert({
          record_id: recordId,
          user_id: reqUser.user_id,
          user_name: uName,
          user_email: reqUser.email,
          class_id: request.class_id || '',
          course_id: request.course_id || '',
          punch_in: piStr,
          punch_out: poStr,
          total_hours: totalHours,
          status: poDate ? 'Punched Out' : 'Punched In',
          week_start: weekStart,
        })
        if (insertErr) throw insertErr

      } else if (request.entry_type === 'Edit') {
        // ── EDIT request: update the existing time_clock entry ──
        if (!request.time_clock_record_id) throw new Error('No linked time clock record')

        const date = request.requested_date
        const piStr = `${date}T${request.start_time}Z`
        const poStr = request.end_time ? `${date}T${request.end_time}Z` : null

        const piDate = new Date(piStr)
        const poDate = poStr ? new Date(poStr) : null
        const totalHours = poDate ? roundToMinute((poDate - piDate) / 3600000) : 0

        const updateFields = {
          punch_in: piStr,
          total_hours: totalHours,
          status: poDate ? 'Punched Out' : 'Punched In',
        }
        // Only update punch_out if the edit request includes one
        // (student may have only changed punch_in while still clocked in)
        if (poStr) {
          updateFields.punch_out = poStr
        }

        const { error: updateErr } = await supabase
          .from('time_clock')
          .update(updateFields)
          .eq('record_id', request.time_clock_record_id)
        if (updateErr) throw updateErr
      }

      // ── Mark the request as Approved ──
      const { error: statusErr } = await supabase
        .from('time_entry_requests')
        .update({
          status: 'Approved',
          reviewed_by: userName,
          review_date: new Date().toISOString(),
        })
        .eq('request_id', request.request_id)
      if (statusErr) throw statusErr

      // ── Audit log ──
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
          action: 'Approve',
          entity_type: 'Time Entry Request',
          entity_id: request.request_id,
          details: `Approved ${request.entry_type} request for ${request.user_name || request.user_email}: ${request.course_id || request.class_id} on ${request.requested_date}`,
        })
      } catch {}

      toast.success(`Request ${request.request_id} approved`)
      return { success: true }
    } catch (err) {
      console.error('Approve time request error:', err)
      toast.error(err.message || 'Failed to approve request')
    } finally {
      setSaving(false)
    }
  }

  // ── Instructor: reject a pending time entry request ──
  // Reason is required and comes from the RejectionModal.
  // The caller (TimeCardsPage) is responsible for calling sendRejectionNotification.
  const rejectTimeRequest = async (requestId, reason) => {
    if (!canEdit) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      const { data: rejRows, error } = await supabase
        .from('time_entry_requests')
        .update({
          status: 'Rejected',
          rejection_reason: reason,
          reviewed_by: userName,
          review_date: new Date().toISOString(),
        })
        .eq('request_id', requestId)
        .select()

      if (error) throw error
      if (!rejRows || rejRows.length === 0) {
        toast.error('Reject failed — you may not have permission.')
        setSaving(false)
        return
      }

      // ── Audit log ──
      try {
        const req = rejRows[0]
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
          action: 'Reject',
          entity_type: 'Time Entry Request',
          entity_id: requestId,
          details: `Rejected ${req.entry_type || ''} request for ${req.user_name || req.user_email}. Reason: ${reason}`,
        })
      } catch {}

      toast.success(`Request ${requestId} rejected`)
      return { success: true }
    } catch (err) {
      console.error('Reject time request error:', err)
      toast.error(err.message || 'Failed to reject request')
    } finally {
      setSaving(false)
    }
  }

  return {
    saving, addEntry, submitTimeRequest, submitEditRequest,
    updateEntry, deleteEntry, punchOutEntry,
    approveTimeRequest, rejectTimeRequest,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pending Time Entry Requests (Instructor view)
// ═══════════════════════════════════════════════════════════════════════════════

export function usePendingTimeRequests({ enabled = false } = {}) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(false)

  const fetchRequests = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('time_entry_requests')
        .select('*')
        .eq('status', 'Pending')
        .order('created_at', { ascending: true })
      if (error) throw error
      setRequests(data || [])
    } catch (err) {
      console.error('Fetch pending time requests error:', err)
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  // Real-time: refresh when time_entry_requests change
  useEffect(() => {
    if (!enabled) return
    const channel = supabase
      .channel('pending-time-requests-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entry_requests' }, () => {
        fetchRequests()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [enabled, fetchRequests])

  return { requests, loading, refresh: fetchRequests }
}

export { getWeekRange, toDateStr }
