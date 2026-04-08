import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0]
}

/** Get Monday of the week containing the given date */
function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  const monday = new Date(d)
  monday.setDate(diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

/** Calculate which week number we're in relative to a start date */
function getWeekNumber(semesterStart, targetDate = new Date()) {
  if (!semesterStart) return 0
  const start = getWeekStart(new Date(semesterStart))
  const target = getWeekStart(targetDate)
  const diffMs = target.getTime() - start.getTime()
  const diffWeeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000))
  return Math.max(0, diffWeeks + 1) // 1-based, minimum 0
}

/** Round decimal hours to the nearest minute */
function roundToMinute(h) {
  return Math.round((h || 0) * 60) / 60
}

/**
 * Extract YYYY-MM-DD from a fake-UTC timestamp
 * e.g. "2026-03-05T15:05:00+00" → "2026-03-05"
 */
function extractDateFromTimestamp(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const yr = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dy = String(d.getUTCDate()).padStart(2, '0')
  return `${yr}-${mo}-${dy}`
}

/**
 * Build a fake-UTC ISO timestamp from a date string + time string (HH:MM).
 * The "+00" suffix means Postgres stores it as-is without timezone conversion,
 * matching the legacy GAS convention already in the DB.
 */
function buildFakeUtcTimestamp(dateStr, timeStr) {
  // e.g. "2026-03-05" + "15:05" → "2026-03-05T15:05:00+00"
  return `${dateStr}T${timeStr}:00+00`
}

/**
 * Generate the next TER request ID.
 * Reads the highest existing TER number and increments.
 */
async function generateTerRequestId() {
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
  return `TER${String(nextNum).padStart(6, '0')}`
}


// ─── Class Period Detection ─────────────────────────────────────────────────

/**
 * Determine which half of the semester a class falls in.
 * Returns 'first', 'second', or 'full'.
 *
 * We compute a midpoint date from semesterStart + midpointWeek weeks.
 * - Class ends on or before midpoint date → first half
 * - Class starts after midpoint date → second half
 * - Otherwise → full semester (spans both halves)
 */
function getClassPeriod(cls, semesterStart, midpointWeek) {
  if (!cls.start_date || !cls.end_date || !semesterStart || !midpointWeek) return 'full'

  // Midpoint date = start of the week *after* the midpoint week
  // e.g. if semesterStart is Jan 12 and midpointWeek is 8,
  // midpointDate = Jan 12 + (8 * 7) = Mar 9 (Monday of week 9)
  const semStart = new Date(semesterStart + 'T00:00:00')
  const midpointDate = new Date(semStart)
  midpointDate.setDate(midpointDate.getDate() + (midpointWeek * 7))

  const classEnd = new Date(cls.end_date + 'T00:00:00')
  const classStart = new Date(cls.start_date + 'T00:00:00')

  if (classEnd < midpointDate) return 'first'
  if (classStart >= midpointDate) return 'second'
  return 'full'
}

/**
 * Given a student's enrolled course IDs and the qualifying classes,
 * compute their personalized volunteer requirement.
 */
function getStudentRequirements(studentCourseIds, qualifyingClasses, hoursPerHalf) {
  if (!studentCourseIds || studentCourseIds.length === 0 || !qualifyingClasses || qualifyingClasses.length === 0) {
    return { totalRequired: 0, midpointApplies: false, secondHalfApplies: false, hasRequirement: false }
  }

  // Find which qualifying classes this student is enrolled in
  const enrolled = qualifyingClasses.filter(c => studentCourseIds.includes(c.course_id))
  if (enrolled.length === 0) {
    return { totalRequired: 0, midpointApplies: false, secondHalfApplies: false, hasRequirement: false }
  }

  const coversFirst = enrolled.some(c => c.period === 'first' || c.period === 'full')
  const coversSecond = enrolled.some(c => c.period === 'second' || c.period === 'full')
  const totalRequired = (coversFirst ? hoursPerHalf : 0) + (coversSecond ? hoursPerHalf : 0)

  return { totalRequired, midpointApplies: coversFirst, secondHalfApplies: coversSecond, hasRequirement: true }
}

/**
 * Fetch active classes that have requires_volunteer_hours = true,
 * and annotate each with its period ('first', 'second', 'full').
 */
async function fetchQualifyingClasses(semesterStart, midpointWeek) {
  const todayStr = new Date().toISOString().substring(0, 10)
  const { data, error } = await supabase
    .from('classes')
    .select('class_id, course_id, course_name, start_date, end_date, requires_volunteer_hours')
    .eq('status', 'Active')
    .eq('requires_volunteer_hours', true)
    .or(`start_date.is.null,start_date.lte.${todayStr}`)

  if (error) {
    console.warn('Failed to fetch qualifying classes:', error)
    return []
  }

  return (data || []).map(cls => ({
    ...cls,
    period: getClassPeriod(cls, semesterStart, midpointWeek),
  }))
}


// ─── Volunteer Settings ──────────────────────────────────────────────────────

export function useVolunteerSettings() {
  const [settings, setSettings] = useState({
    totalHoursRequired: 10,
    midpointHours: 5,
    midpointWeek: 8,
    currentSemester: '',
    semesterStart: '',
    semesterEnd: '',
  })
  const [loading, setLoading] = useState(true)

  const fetchSettings = useCallback(async () => {
    try {
      // 1. Fetch volunteer-specific settings
      const keys = [
        'volunteer_semester_total_hours',
        'volunteer_midpoint_hours',
        'volunteer_midpoint_week',
        'volunteer_current_semester',
        'volunteer_semester_start',
        'volunteer_semester_end',
      ]
      const { data, error } = await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', keys)

      if (error) throw error

      const map = {}
      ;(data || []).forEach(s => { map[s.setting_key] = s.setting_value })

      let semesterStart = map.volunteer_semester_start || ''
      let semesterEnd = map.volunteer_semester_end || ''
      let currentSemester = map.volunteer_current_semester || ''

      // 2. If volunteer semester dates aren't configured OR are stale
      //    (today is past the configured end date), fall back to active class dates.
      //    This auto-detects a new semester without manual settings updates.
      const today = new Date()
      const configuredEndIsStale = semesterEnd && new Date(semesterEnd + 'T23:59:59') < today

      if (!semesterStart || !semesterEnd || configuredEndIsStale) {
        // Clear stale values so they get overwritten by active class dates
        if (configuredEndIsStale) {
          semesterStart = ''
          semesterEnd = ''
          currentSemester = ''
        }
        try {
          const { data: classData } = await supabase
            .from('classes')
            .select('start_date, end_date, semester')
            .eq('status', 'Active')
            .order('start_date', { ascending: true })
            .limit(10)

          if (classData && classData.length > 0) {
            const starts = classData.map(c => c.start_date).filter(Boolean).sort()
            const ends = classData.map(c => c.end_date).filter(Boolean).sort()
            if (!semesterStart && starts.length > 0) semesterStart = starts[0]
            if (!semesterEnd && ends.length > 0) semesterEnd = ends[ends.length - 1]
            if (!currentSemester && classData[0].semester) currentSemester = classData[0].semester
          }
        } catch (classErr) {
          console.warn('Could not fetch class dates for fallback:', classErr)
        }
      }

      // 3. Final fallback: use current year start/end
      if (!semesterStart) {
        const now = new Date()
        semesterStart = `${now.getFullYear()}-01-01`
      }
      if (!semesterEnd) {
        const now = new Date()
        semesterEnd = `${now.getFullYear()}-12-31`
      }

      setSettings({
        totalHoursRequired: parseFloat(map.volunteer_semester_total_hours) || 10,
        midpointHours: parseFloat(map.volunteer_midpoint_hours) || 5,
        midpointWeek: parseInt(map.volunteer_midpoint_week) || 8,
        currentSemester: currentSemester,
        semesterStart: semesterStart,
        semesterEnd: semesterEnd,
      })
    } catch (err) {
      console.error('Volunteer settings fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSettings() }, [fetchSettings])

  // Real-time: refresh when volunteer settings change
  useEffect(() => {
    const channel = supabase
      .channel('volunteer-settings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload) => {
        const key = payload.new?.setting_key || payload.old?.setting_key || ''
        if (key.startsWith('volunteer_')) {
          fetchSettings()
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchSettings])

  return { settings, loading, refresh: fetchSettings }
}


// ─── Student Volunteer Data ──────────────────────────────────────────────────

export function useVolunteerData() {
  const { profile } = useAuth()
  const { settings, loading: settingsLoading } = useVolunteerSettings()

  const [entries, setEntries] = useState([])               // volunteer time_clock records (auto-approved)
  const [pendingEntries, setPendingEntries] = useState([])  // pending time_entry_requests (manual submissions)
  const [rejectedEntries, setRejectedEntries] = useState([]) // recently rejected requests
  const [pendingEditRequests, setPendingEditRequests] = useState([]) // pending edit requests keyed by time_clock_record_id
  const [qualifyingClasses, setQualifyingClasses] = useState([]) // classes with requires_volunteer_hours
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const hasLoadedRef = useRef(false)

  const fetchData = useCallback(async () => {
    if (!profile?.email) {
      setLoading(false)
      return
    }
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const semStart = settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.semesterEnd || toDateStr(new Date())

      // 0. Fetch qualifying classes (requires_volunteer_hours = true)
      const qClasses = await fetchQualifyingClasses(settings.semesterStart, settings.midpointWeek)
      setQualifyingClasses(qClasses)

      // 1. All completed volunteer + club activity time_clock entries (approval_status = 'Approved').
      // Club Activity total_hours is already the credited amount (0.25x actual).
      const { data: tcData, error: tcErr } = await supabase
        .from('time_clock')
        .select('*')
        .eq('user_email', profile.email)
        .in('entry_type', ['Volunteer', 'Club Activity'])
        .eq('approval_status', 'Approved')
        .eq('status', 'Punched Out')
        .gte('punch_in', semStart + 'T00:00:00')
        .lte('punch_in', semEnd + 'T23:59:59')
        .order('punch_in', { ascending: false })

      if (tcErr) throw tcErr
      setEntries(tcData || [])

      // 2. Pending time_entry_requests for volunteer + club activity (manual entries awaiting approval)
      const { data: reqData, error: reqErr } = await supabase
        .from('time_entry_requests')
        .select('*')
        .eq('user_email', profile.email)
        .eq('status', 'Pending')
        .or('entry_type.eq.Volunteer,class_id.eq.VOLUNTEER,class_id.eq.CLUB_ACTIVITY')

      if (reqErr) throw reqErr
      // Separate manual "new" entries from "edit" requests
      const manualPending = (reqData || []).filter(r => r.entry_type !== 'Edit')
      const editPending = (reqData || []).filter(r => r.entry_type === 'Edit')
      setPendingEntries(manualPending)
      setPendingEditRequests(editPending)

      // 3. Recently rejected requests (last 30 days)
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      const { data: rejData } = await supabase
        .from('time_entry_requests')
        .select('*')
        .eq('user_email', profile.email)
        .eq('status', 'Rejected')
        .or('entry_type.eq.Volunteer,class_id.eq.VOLUNTEER,class_id.eq.CLUB_ACTIVITY')
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: false })

      setRejectedEntries(rejData || [])
      hasLoadedRef.current = true

    } catch (err) {
      console.error('Volunteer data fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [profile?.email, settings.semesterStart, settings.semesterEnd])

  useEffect(() => {
    if (!settingsLoading) fetchData()
  }, [fetchData, settingsLoading])

  // Real-time: refresh when time_clock or time_entry_requests change
  useEffect(() => {
    if (!profile?.email) return
    const channel = supabase
      .channel('volunteer-data-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entry_requests' }, () => { fetchData() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, fetchData])

  // ── Computed stats ──
  const stats = useMemo(() => {
    // Parse student's enrolled course IDs from profile
    const studentCourseIds = (profile?.classes || '').split(',').map(c => c.trim()).filter(Boolean)
    const reqs = getStudentRequirements(studentCourseIds, qualifyingClasses, settings.midpointHours)

    // If no qualifying classes found but qualifyingClasses haven't loaded yet, fall back to settings
    const totalRequired = reqs.hasRequirement ? reqs.totalRequired : settings.totalHoursRequired
    const midpointApplies = reqs.hasRequirement ? reqs.midpointApplies : true
    const secondHalfApplies = reqs.hasRequirement ? reqs.secondHalfApplies : true

    const approvedHours = entries.reduce((sum, e) => sum + (parseFloat(e.total_hours) || 0), 0)
    const pendingHours = pendingEntries.reduce((sum, e) => sum + (parseFloat(e.total_hours) || 0), 0)
    const remaining = Math.max(0, totalRequired - approvedHours)
    const progress = totalRequired > 0
      ? Math.min(100, Math.round((approvedHours / totalRequired) * 100))
      : 0
    const isComplete = totalRequired > 0 ? approvedHours >= totalRequired : true

    const currentWeek = getWeekNumber(settings.semesterStart)
    const pastMidpoint = currentWeek > settings.midpointWeek
    const atMidpoint = currentWeek === settings.midpointWeek

    // ── Midpoint tracking ──
    const midpointRequired = midpointApplies ? settings.midpointHours : 0
    const midpointMet = !midpointApplies || approvedHours >= midpointRequired
    let midpointStatus = 'not_applicable'
    if (midpointApplies) {
      midpointStatus = 'on_track'
      if (midpointMet) midpointStatus = 'met'
      else if (pastMidpoint) midpointStatus = 'overdue'
      else if (currentWeek >= settings.midpointWeek - 2) midpointStatus = 'at_risk'
    }

    // ── Second-half tracking ──
    const secondHalfTarget = secondHalfApplies ? settings.midpointHours : 0
    const secondHalfHours = secondHalfApplies ? Math.max(0, approvedHours - (midpointApplies ? settings.midpointHours : 0)) : 0
    const secondHalfProgress = secondHalfTarget > 0
      ? Math.min(100, Math.round((secondHalfHours / secondHalfTarget) * 100))
      : 0
    const totalSemesterWeeks = settings.midpointWeek * 2
    const secondHalfWeeksElapsed = Math.max(0, currentWeek - settings.midpointWeek)
    const secondHalfTotalWeeks = totalSemesterWeeks - settings.midpointWeek

    let secondHalfStatus = 'not_applicable'
    if (secondHalfApplies) {
      secondHalfStatus = 'pending'
      if (pastMidpoint || atMidpoint) {
        if (secondHalfHours >= secondHalfTarget) secondHalfStatus = 'met'
        else if (secondHalfWeeksElapsed >= secondHalfTotalWeeks) secondHalfStatus = 'overdue'
        else if (secondHalfWeeksElapsed >= secondHalfTotalWeeks - 2) secondHalfStatus = 'at_risk'
        else secondHalfStatus = 'on_track'
      }
    }

    return {
      approvedHours: roundToMinute(approvedHours),
      pendingHours: roundToMinute(pendingHours),
      remaining: roundToMinute(remaining),
      progress,
      isComplete,
      currentWeek,
      pastMidpoint,
      atMidpoint,
      midpointMet,
      midpointStatus,
      totalRequired,
      midpointRequired,
      midpointApplies,
      midpointWeek: settings.midpointWeek,
      secondHalfTarget,
      secondHalfHours: roundToMinute(secondHalfHours),
      secondHalfProgress,
      secondHalfStatus,
      secondHalfApplies,
      hasRequirement: reqs.hasRequirement,
    }
  }, [entries, pendingEntries, settings, profile?.classes, qualifyingClasses])

  // ── Submit manual volunteer entry ──
  const submitVolunteerEntry = async (date, startTime, endTime, reason) => {
    if (!profile) { console.warn('Not logged in'); return { success: false, error: 'Not logged in' } }
    setSaving(true)
    try {
      const start = new Date(`${date}T${startTime}`)
      const end = new Date(`${date}T${endTime}`)
      if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('Invalid date/time')
      if (end <= start) throw new Error('End time must be after start time')
      const totalHours = roundToMinute((end - start) / 3600000)

      const requestId = await generateTerRequestId()

      const { error } = await supabase.from('time_entry_requests').insert({
        request_id: requestId,
        user_name: `${profile.first_name} ${profile.last_name}`,
        user_email: profile.email,
        class_id: 'VOLUNTEER',
        course_id: 'Volunteer',
        requested_date: date,
        start_time: startTime,
        end_time: endTime,
        total_hours: totalHours,
        entry_type: 'Volunteer',
        reason: reason || 'Volunteer hours',
        status: 'Pending',
      })

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Submit Volunteer Entry',
          entity_type: 'Time Entry Request',
          entity_id: requestId,
          details: `Volunteer entry: ${date} ${startTime}–${endTime} (${totalHours}h) — ${reason || 'N/A'}`,
        })
      } catch {}

      await fetchData()
      return { success: true, requestId, totalHours }
    } catch (err) {
      console.error('Submit volunteer entry error:', err)
      return { success: false, error: err.message || 'Failed to submit request' }
    } finally {
      setSaving(false)
    }
  }

  // ── Submit manual club activity entry (0.25x credit per actual hour) ──
  const submitClubActivityEntry = async (date, startTime, endTime, reason) => {
    if (!profile) { console.warn('Not logged in'); return { success: false, error: 'Not logged in' } }
    setSaving(true)
    try {
      const start = new Date(`${date}T${startTime}`)
      const end = new Date(`${date}T${endTime}`)
      if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('Invalid date/time')
      if (end <= start) throw new Error('End time must be after start time')
      const rawHours = (end - start) / 3600000
      // Club Activity: only 0.25 hrs credited per actual hour
      const creditedHours = roundToMinute(rawHours * 0.25)
      if (creditedHours <= 0) throw new Error('Duration too short to earn credit')

      const requestId = await generateTerRequestId()

      const { error } = await supabase.from('time_entry_requests').insert({
        request_id: requestId,
        user_name: `${profile.first_name} ${profile.last_name}`,
        user_email: profile.email,
        class_id: 'CLUB_ACTIVITY',
        course_id: 'Club Activity',
        requested_date: date,
        start_time: startTime,
        end_time: endTime,
        total_hours: creditedHours,
        entry_type: 'Club Activity',
        reason: reason
          ? `[Club Activity — ${roundToMinute(rawHours)}h actual → ${creditedHours}h credited] ${reason}`
          : `Club Activity — ${roundToMinute(rawHours)}h actual → ${creditedHours}h credited`,
        status: 'Pending',
      })

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Submit Club Activity Entry',
          entity_type: 'Time Entry Request',
          entity_id: requestId,
          details: `Club Activity: ${date} ${startTime}–${endTime} (${roundToMinute(rawHours)}h actual → ${creditedHours}h credited) — ${reason || 'N/A'}`,
        })
      } catch {}

      await fetchData()
      return { success: true, requestId, creditedHours, rawHours: roundToMinute(rawHours) }
    } catch (err) {
      console.error('Submit club activity entry error:', err)
      return { success: false, error: err.message || 'Failed to submit request' }
    } finally {
      setSaving(false)
    }
  }

  // ── Student: submit an edit request for an existing time_clock volunteer entry ──
  // Goes to time_entry_requests as entry_type='Edit', class_id='VOLUNTEER', needs instructor approval
  const submitVolunteerEditRequest = async (entry, newStartTime, newEndTime, reason) => {
    if (!profile) { toast.error('Not logged in'); return }
    setSaving(true)
    try {
      const entryDate = extractDateFromTimestamp(entry.punch_in) || toDateStr(new Date())

      const startParts = newStartTime.split(':')
      const endParts = newEndTime.split(':')
      const startMins = parseInt(startParts[0]) * 60 + parseInt(startParts[1] || '0')
      const endMins = parseInt(endParts[0]) * 60 + parseInt(endParts[1] || '0')
      const totalHours = roundToMinute((endMins - startMins) / 60)

      if (totalHours <= 0) {
        toast.error('End time must be after start time')
        setSaving(false)
        return
      }

      // Prevent duplicate pending edits for same record
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

      const requestId = await generateTerRequestId()

      const { error } = await supabase.from('time_entry_requests').insert({
        request_id: requestId,
        user_name: `${profile.first_name} ${profile.last_name}`,
        user_email: profile.email,
        class_id: 'VOLUNTEER',
        course_id: 'Volunteer',
        requested_date: entryDate,
        start_time: newStartTime + ':00',
        end_time: newEndTime + ':00',
        total_hours: totalHours,
        entry_type: 'Edit',
        reason: reason || '',
        status: 'Pending',
        created_at: new Date().toISOString(),
        time_clock_record_id: entry.record_id,
      })

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Submit Volunteer Edit Request',
          entity_type: 'Time Entry Request',
          entity_id: requestId,
          details: `Volunteer edit request for ${entry.record_id}: ${entryDate} ${newStartTime}–${newEndTime} (${totalHours}h) — ${reason}`,
        })
      } catch {}

      toast.success('Edit request submitted — an instructor will review it')
      await fetchData()
      return { success: true, requestId }
    } catch (err) {
      console.error('Submit volunteer edit request error:', err)
      toast.error(err.message || 'Failed to submit edit request')
    } finally {
      setSaving(false)
    }
  }

  return {
    entries,
    pendingEntries,
    rejectedEntries,
    pendingEditRequests, // array of pending Edit requests (includes time_clock_record_id)
    stats,
    settings,
    loading: loading || settingsLoading,
    saving,
    submitVolunteerEntry,
    submitClubActivityEntry,
    submitVolunteerEditRequest,
    refresh: fetchData,
  }
}


// ─── Instructor Volunteer Overview ───────────────────────────────────────────

export function useVolunteerOverview() {
  const { profile } = useAuth()
  const { settings, loading: settingsLoading } = useVolunteerSettings()
  const isInstructor = profile?.role === 'Instructor' || profile?.role === 'Super Admin'

  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchOverview = useCallback(async () => {
    if (!isInstructor) { setLoading(false); return }
    setLoading(true)
    try {
      const semStart = settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.semesterEnd || toDateStr(new Date())

      // 1. Get all Student + Work Study users (active, excluding time_clock_only)
      const { data: profilesData, error: profErr } = await supabase
        .from('profiles')
        .select('user_id, email, first_name, last_name, role, status, time_clock_only, classes')
        .eq('status', 'Active')
        .in('role', ['Student', 'Work Study'])
        .order('last_name')

      if (profErr) throw profErr

      const allStudents = (profilesData || []).filter(s =>
        !s.time_clock_only || s.time_clock_only === '' || s.time_clock_only === 'No'
      )

      // 1b. Fetch qualifying classes (requires_volunteer_hours = true)
      const qClasses = await fetchQualifyingClasses(settings.semesterStart, settings.midpointWeek)

      // 2. Fetch ALL volunteer time_clock entries for the semester
      const { data: tcData, error: tcErr } = await supabase
        .from('time_clock')
        .select('record_id, user_email, total_hours, punch_in, punch_out, approval_status, status')
        .eq('entry_type', 'Volunteer')
        .gte('punch_in', semStart + 'T00:00:00')
        .lte('punch_in', semEnd + 'T23:59:59')

      if (tcErr) throw tcErr

      // 3. Fetch pending volunteer time_entry_requests
      const { data: reqData } = await supabase
        .from('time_entry_requests')
        .select('request_id, user_email, total_hours, status')
        .eq('status', 'Pending')
        .or('entry_type.eq.Volunteer,class_id.eq.VOLUNTEER')

      // Build lookup maps
      const approvedByEmail = {}
      ;(tcData || []).forEach(r => {
        const email = r.user_email
        if (!email) return
        if (r.approval_status === 'Approved') {
          approvedByEmail[email] = (approvedByEmail[email] || 0) + (parseFloat(r.total_hours) || 0)
        }
      })

      const pendingReqByEmail = {}
      ;(reqData || []).filter(r => r.entry_type !== 'Edit').forEach(r => {
        const email = r.user_email
        if (!email) return
        pendingReqByEmail[email] = (pendingReqByEmail[email] || 0) + (parseFloat(r.total_hours) || 0)
      })

      const currentWeek = getWeekNumber(settings.semesterStart)
      const pastMidpoint = currentWeek > settings.midpointWeek

      const studentSummaries = allStudents.map(s => {
        // Parse this student's enrolled course IDs
        const studentCourseIds = (s.classes || '').split(',').map(c => c.trim()).filter(Boolean)
        const reqs = getStudentRequirements(studentCourseIds, qClasses, settings.midpointHours)

        // Use per-student requirement, or fall back to global settings if no qualifying classes data
        const totalRequired = reqs.hasRequirement ? reqs.totalRequired : settings.totalHoursRequired
        const midpointApplies = reqs.hasRequirement ? reqs.midpointApplies : true
        const secondHalfApplies = reqs.hasRequirement ? reqs.secondHalfApplies : true

        const approvedHours = roundToMinute(approvedByEmail[s.email] || 0)
        const pendingHours = roundToMinute(pendingReqByEmail[s.email] || 0)
        const remaining = Math.max(0, totalRequired - approvedHours)
        const progress = totalRequired > 0
          ? Math.min(100, Math.round((approvedHours / totalRequired) * 100))
          : 0
        const isComplete = totalRequired > 0 ? approvedHours >= totalRequired : true

        // Midpoint tracking
        const midpointRequired = midpointApplies ? settings.midpointHours : 0
        const midpointMet = !midpointApplies || approvedHours >= midpointRequired
        let midpointStatus = 'not_applicable'
        if (midpointApplies) {
          midpointStatus = 'on_track'
          if (midpointMet) midpointStatus = 'met'
          else if (pastMidpoint) midpointStatus = 'overdue'
          else if (currentWeek >= settings.midpointWeek - 2) midpointStatus = 'at_risk'
        }

        let overallStatus = 'on_track'
        if (isComplete) overallStatus = 'complete'
        else if (!reqs.hasRequirement || totalRequired === 0) overallStatus = 'complete'
        else if (midpointApplies && midpointStatus === 'overdue') overallStatus = 'behind'
        else if (midpointApplies && midpointStatus === 'at_risk') overallStatus = 'at_risk'

        // Second-half tracking
        const secondHalfTarget = secondHalfApplies ? settings.midpointHours : 0
        const secondHalfHours = secondHalfApplies
          ? roundToMinute(Math.max(0, approvedHours - (midpointApplies ? settings.midpointHours : 0)))
          : 0
        const secondHalfProgress = secondHalfTarget > 0
          ? Math.min(100, Math.round((secondHalfHours / secondHalfTarget) * 100))
          : 0
        const totalSemesterWeeks = settings.midpointWeek * 2
        const secondHalfWeeksElapsed = Math.max(0, currentWeek - settings.midpointWeek)
        const secondHalfTotalWeeks = totalSemesterWeeks - settings.midpointWeek

        let secondHalfStatus = 'not_applicable'
        if (secondHalfApplies) {
          secondHalfStatus = 'pending'
          if (pastMidpoint) {
            if (secondHalfHours >= secondHalfTarget) secondHalfStatus = 'met'
            else if (secondHalfWeeksElapsed >= secondHalfTotalWeeks) secondHalfStatus = 'overdue'
            else if (secondHalfWeeksElapsed >= secondHalfTotalWeeks - 2) secondHalfStatus = 'at_risk'
            else secondHalfStatus = 'on_track'
          }
        }

        // For second-half-only students who haven't met their requirement, check timing
        if (!midpointApplies && secondHalfApplies && !isComplete) {
          if (secondHalfStatus === 'overdue') overallStatus = 'behind'
          else if (secondHalfStatus === 'at_risk') overallStatus = 'at_risk'
        }

        return {
          userId: s.user_id,
          email: s.email,
          firstName: s.first_name,
          lastName: s.last_name,
          role: s.role,
          name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
          approvedHours,
          pendingHours,
          remaining,
          progress,
          isComplete,
          totalRequired,
          midpointApplies,
          midpointMet,
          midpointStatus,
          overallStatus,
          secondHalfApplies,
          secondHalfHours,
          secondHalfProgress,
          secondHalfStatus,
          hasRequirement: reqs.hasRequirement,
        }
      })

      setStudents(studentSummaries)
    } catch (err) {
      console.error('Volunteer overview fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [isInstructor, settings])

  useEffect(() => {
    if (!settingsLoading) fetchOverview()
  }, [fetchOverview, settingsLoading])

  // Real-time: refresh when time_clock, time_entry_requests, or profiles change
  useEffect(() => {
    if (!isInstructor) return
    const channel = supabase
      .channel('volunteer-overview-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, () => { fetchOverview() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entry_requests' }, () => { fetchOverview() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetchOverview() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [isInstructor, fetchOverview])

  const summary = useMemo(() => {
    const withReq = students.filter(s => s.hasRequirement && s.totalRequired > 0)
    const total = withReq.length
    const complete = withReq.filter(s => s.overallStatus === 'complete').length
    const onTrack = withReq.filter(s => s.overallStatus === 'on_track').length
    const atRisk = withReq.filter(s => s.overallStatus === 'at_risk').length
    const behind = withReq.filter(s => s.overallStatus === 'behind').length
    const noRequirement = students.filter(s => !s.hasRequirement || s.totalRequired === 0).length
    const currentWeek = getWeekNumber(settings.semesterStart)
    return { total, complete, onTrack, atRisk, behind, noRequirement, currentWeek, totalAll: students.length }
  }, [students, settings])

  return {
    students,
    summary,
    settings,
    loading: loading || settingsLoading,
    isInstructor,
    refresh: fetchOverview,
  }
}


// ─── Instructor: View individual student detail ──────────────────────────────

export function useStudentVolunteerDetail(studentEmail) {
  const { profile } = useAuth()
  const { settings } = useVolunteerSettings()
  const [entries, setEntries] = useState([])          // time_clock volunteer records
  const [pendingEntries, setPendingEntries] = useState([]) // time_entry_requests (non-Edit)
  const [pendingEdits, setPendingEdits] = useState([]) // time_entry_requests (Edit type)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const fetchDetail = useCallback(async () => {
    if (!studentEmail) return
    setLoading(true)
    try {
      const semStart = settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.semesterEnd || toDateStr(new Date())

      // All volunteer time_clock entries (approved + pending)
      const { data: tcData } = await supabase
        .from('time_clock')
        .select('*')
        .eq('user_email', studentEmail)
        .eq('entry_type', 'Volunteer')
        .gte('punch_in', semStart + 'T00:00:00')
        .lte('punch_in', semEnd + 'T23:59:59')
        .order('punch_in', { ascending: false })

      setEntries(tcData || [])

      // All time_entry_requests for this student (Pending, Approved, Rejected)
      const { data: reqData } = await supabase
        .from('time_entry_requests')
        .select('*')
        .eq('user_email', studentEmail)
        .or('entry_type.eq.Volunteer,class_id.eq.VOLUNTEER')
        .order('created_at', { ascending: false })

      const editReqs = (reqData || []).filter(r => r.entry_type === 'Edit')
      const manualReqs = (reqData || []).filter(r => r.entry_type !== 'Edit')
      setPendingEntries(manualReqs)
      setPendingEdits(editReqs)
    } catch (err) {
      console.error('Student volunteer detail error:', err)
    } finally {
      setLoading(false)
    }
  }, [studentEmail, settings.semesterStart, settings.semesterEnd])

  useEffect(() => { fetchDetail() }, [fetchDetail])

  // Real-time: refresh when time_clock or time_entry_requests change for this student
  useEffect(() => {
    if (!studentEmail) return
    const channel = supabase
      .channel(`volunteer-detail-${studentEmail}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, () => { fetchDetail() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entry_requests' }, () => { fetchDetail() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [studentEmail, fetchDetail])

  // ── Instructor: directly edit a time_clock volunteer entry (no approval needed) ──
  const instructorEditTimeClock = async (entry, date, newStartTime, newEndTime) => {
    if (!profile) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      // Reconstruct fake-UTC timestamps using the same convention as the rest of the DB
      const newPunchIn = buildFakeUtcTimestamp(date, newStartTime)
      const newPunchOut = buildFakeUtcTimestamp(date, newEndTime)

      const startMins = parseInt(newStartTime.split(':')[0]) * 60 + parseInt(newStartTime.split(':')[1] || '0')
      const endMins = parseInt(newEndTime.split(':')[0]) * 60 + parseInt(newEndTime.split(':')[1] || '0')
      const totalHours = roundToMinute((endMins - startMins) / 60)

      if (totalHours <= 0) {
        toast.error('End time must be after start time')
        setSaving(false)
        return
      }

      const { data: updated, error } = await supabase
        .from('time_clock')
        .update({
          punch_in: newPunchIn,
          punch_out: newPunchOut,
          total_hours: totalHours,
        })
        .eq('record_id', entry.record_id)
        .select()

      if (error) throw error
      if (!updated || updated.length === 0) throw new Error('Update failed — no rows affected (RLS?)')

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Instructor Edit Volunteer Entry',
          entity_type: 'Time Clock',
          entity_id: entry.record_id,
          details: `Edited ${entry.record_id} for ${entry.user_name || studentEmail}: ${date} ${newStartTime}–${newEndTime} (${totalHours}h)`,
        })
      } catch {}

      toast.success('Volunteer entry updated')
      await fetchDetail()
      return { success: true, totalHours }
    } catch (err) {
      console.error('Instructor edit time clock error:', err)
      toast.error(err.message || 'Failed to update entry')
    } finally {
      setSaving(false)
    }
  }

  // ── Instructor: directly edit a time_entry_request (manual or edit-request) ──
  const instructorEditRequest = async (requestId, date, newStartTime, newEndTime) => {
    if (!profile) { toast.error('Not authorized'); return }
    setSaving(true)
    try {
      const startMins = parseInt(newStartTime.split(':')[0]) * 60 + parseInt(newStartTime.split(':')[1] || '0')
      const endMins = parseInt(newEndTime.split(':')[0]) * 60 + parseInt(newEndTime.split(':')[1] || '0')
      const totalHours = roundToMinute((endMins - startMins) / 60)

      if (totalHours <= 0) {
        toast.error('End time must be after start time')
        setSaving(false)
        return
      }

      const { data: updated, error } = await supabase
        .from('time_entry_requests')
        .update({
          requested_date: date,
          start_time: newStartTime + ':00',
          end_time: newEndTime + ':00',
          total_hours: totalHours,
          updated_at: new Date().toISOString(),
        })
        .eq('request_id', requestId)
        .select()

      if (error) throw error
      if (!updated || updated.length === 0) throw new Error('Update failed — no rows affected (RLS?)')

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Instructor Edit Volunteer Request',
          entity_type: 'Time Entry Request',
          entity_id: requestId,
          details: `Edited ${requestId} for ${studentEmail}: ${date} ${newStartTime}–${newEndTime} (${totalHours}h)`,
        })
      } catch {}

      toast.success('Volunteer request updated')
      await fetchDetail()
      return { success: true, totalHours }
    } catch (err) {
      console.error('Instructor edit request error:', err)
      toast.error(err.message || 'Failed to update request')
    } finally {
      setSaving(false)
    }
  }

  return {
    entries,
    pendingEntries,
    pendingEdits,
    loading,
    saving,
    refresh: fetchDetail,
    instructorEditTimeClock,
    instructorEditRequest,
  }
}
