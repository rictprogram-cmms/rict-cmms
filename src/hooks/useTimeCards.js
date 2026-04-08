import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
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
        if (r.status === 'No Show' || r.entry_type === 'Volunteer' || r.entry_type === 'Work Study' || r.entry_type === 'All Done') return
        const d = extractDateFromTimestamp(r.punch_in)
        if (!d) return
        const piMin = extractTimeMinutes(r.punch_in)
        const poMin = extractTimeMinutes(r.punch_out)
        const isStillIn = r.status === 'Punched In'
        if (!daySpans[d]) daySpans[d] = { firstPunchIn: Infinity, lastPunchOut: 0, hasStillIn: false, firstRecordId: null, lastRecordId: null }
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

        // Early check: use day's latest departure (only if no one still in)
        if (!span.hasStillIn && span.lastPunchOut > 0 && span.lastRecordId && daySignup.endMin > 0) {
          const earlyBy = daySignup.endMin - span.lastPunchOut
          dayEarlyInfo[date] = { isEarly: earlyBy > gracePeriod, earlyMinutes: earlyBy > gracePeriod ? earlyBy : 0 }
          if (earlyBy > gracePeriod) earlyFlagRecords.add(span.lastRecordId)
        }
      })

      // 7. Analyze each entry for attendance flags using pre-computed day-span data
      let lateCount = 0, earlyCount = 0, noShowCount = 0, walkInCount = 0
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
          .select('class_id, course_id, course_name, required_hours, status, start_date, end_date')
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

      classesData.forEach(c => {
        const key = c.course_id || c.class_id
        const hasEntries = !!classHrsFromEntries[key]
        const isEnrolled = enrolledClasses.includes(c.class_id) ||
          enrolledClasses.includes(c.course_id)
        const isInRange = classActiveInRange(c, startDate, endDate)

        if (isEnrolled && isInRange) {
          // Class was running during this period — always show tile
          classHrs[key] = {
            hours: classHrsFromEntries[key]?.hours || 0,
            requiredHours: parseFloat(c.required_hours) || 0,
            courseName: c.course_name || '',
          }
        } else if (hasEntries) {
          // Class is outside range or student no longer enrolled but has actual entries —
          // still show so history isn't lost
          classHrs[key] = {
            hours: classHrsFromEntries[key].hours,
            requiredHours: parseFloat(c.required_hours) || 0,
            courseName: c.course_name || '',
          }
        }
        // Otherwise: class not in range and no entries → hidden (e.g. future class on a past week)
      })

      // Safety net: if an entry's course_id didn't match any class record, still show it
      coursesWithEntries.forEach(key => {
        if (!classHrs[key]) {
          classHrs[key] = {
            hours: classHrsFromEntries[key].hours,
            requiredHours: 0,
            courseName: '',
          }
        }
      })

      setClassSummary(classHrs)
      setTotalHours(total)

      // 8. Attendance summary
      const nonVolunteerEntries = enrichedRecords.filter(r => r.entry_type !== 'Volunteer' && r.entry_type !== 'Work Study')
      const totalEntries = nonVolunteerEntries.length
      const scoreDenom = totalEntries - nonVolunteerEntries.filter(r => r.flags.isNoShow).length
      const attendanceScore = scoreDenom > 0
        ? Math.round((onTimeCount / scoreDenom) * 100)
        : 100

      setAttendanceSummary({
        lateArrivals: lateCount,
        earlyDepartures: earlyCount,
        noShows: noShowCount,
        walkIns: walkInCount,
        totalLateMinutes: totalLateMins,
        totalEarlyMinutes: totalEarlyMins,
        onTimeCount,
        totalEntries,
        attendanceScore,
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
            .select('user_email, date, start_time, end_time, status')
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
          if (!signupsByDate[d]) signupsByDate[d] = { startMin: Infinity, endMin: 0 }
          const sMin = timeToMinutes(s.start_time)
          const eMin = timeToMinutes(s.end_time)
          if (sMin !== null && sMin < signupsByDate[d].startMin) signupsByDate[d].startMin = sMin
          if (eMin !== null && eMin > signupsByDate[d].endMin) signupsByDate[d].endMin = eMin
        })

        // Build day spans from ALL records (cross-class) for accurate attendance
        const daySpans = {}
        allUserRecords.forEach(r => {
          if (r.entry_type === 'All Done') return
          const d = extractDateFromTimestamp(r.punch_in)
          if (!d) return
          const piMin = extractTimeMinutes(r.punch_in)
          const poMin = extractTimeMinutes(r.punch_out)
          const isStillIn = r.status === 'Punched In'
          if (!daySpans[d]) daySpans[d] = { firstPunchIn: Infinity, lastPunchOut: 0, hasStillIn: false, firstRecordId: null, lastRecordId: null }
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
          if (!span.hasStillIn && span.lastPunchOut > 0 && span.lastRecordId && daySignup.endMin > 0) {
            if ((daySignup.endMin - span.lastPunchOut) > gracePeriod) {
              earlyFlagRecords.add(span.lastRecordId)
            }
          }
        })

        // Count attendance flags — only for THIS class's records, using day-span data
        let lateCount = 0, earlyCount = 0, walkInCount = 0
        userRecords.forEach(r => {
          if (r.entry_type === 'All Done') return
          const entryDate = extractDateFromTimestamp(r.punch_in)
          const daySignup = entryDate ? signupsByDate[entryDate] : null
          if (!daySignup || daySignup.startMin === Infinity) { walkInCount++; return }
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
