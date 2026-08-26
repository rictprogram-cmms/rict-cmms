import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { generateSafeTcId } from '@/utils/generateSafeTcId'
import { resolveVolunteerWindow } from '@/lib/volunteerWindow'
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
    countStart: '',
    countEnd: '',
    includesBreak: false,
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

      // 2. Semester + hours-counting windows come from the shared resolver
      //    (src/lib/volunteerWindow.js) so this hook, the Dashboard grade
      //    card, and the GB Items report all agree. countStart reaches back
      //    to the day after the previous term ended, so summer hours roll
      //    into Fall and winter-break hours roll into Spring.
      const win = await resolveVolunteerWindow()

      setSettings({
        totalHoursRequired: parseFloat(map.volunteer_semester_total_hours) || 10,
        midpointHours: parseFloat(map.volunteer_midpoint_hours) || 5,
        midpointWeek: parseInt(map.volunteer_midpoint_week) || 8,
        currentSemester: win.currentSemester,
        semesterStart: win.semesterStart,
        semesterEnd: win.semesterEnd,
        countStart: win.countStart,
        countEnd: win.countEnd,
        includesBreak: win.includesBreak,
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
      // Hours-counting window (includes the preceding break) — see volunteerWindow.js
      const semStart = settings.countStart || settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.countEnd || settings.semesterEnd || toDateStr(new Date())

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
      const rejData = mustData(await supabase
        .from('time_entry_requests')
        .select('*')
        .eq('user_email', profile.email)
        .eq('status', 'Rejected')
        .or('entry_type.eq.Volunteer,class_id.eq.VOLUNTEER,class_id.eq.CLUB_ACTIVITY')
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: false }), 'time_entry_requests.select')

      setRejectedEntries(rejData || [])
      hasLoadedRef.current = true

    } catch (err) {
      console.error('Volunteer data fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [profile?.email, settings.semesterStart, settings.semesterEnd, settings.countStart, settings.countEnd])

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

      const { error } = assertWrite(
      await supabase.from('time_entry_requests').insert({
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
      }).select(),
      'time_entry_requests.insert'
    )

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

      const { error } = assertWrite(
      await supabase.from('time_entry_requests').insert({
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
      }).select(),
      'time_entry_requests.insert'
    )

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
      const existingReq = mustData(await supabase
        .from('time_entry_requests')
        .select('request_id')
        .eq('time_clock_record_id', entry.record_id)
        .eq('status', 'Pending')
        .maybeSingle(), 'time_entry_requests.select')

      if (existingReq) {
        toast.error('There is already a pending edit request for this entry')
        setSaving(false)
        return
      }

      const requestId = await generateTerRequestId()

      const { error } = assertWrite(
      await supabase.from('time_entry_requests').insert({
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
      }).select(),
      'time_entry_requests.insert'
    )

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
      // Hours-counting window (includes the preceding break) — see volunteerWindow.js
      const semStart = settings.countStart || settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.countEnd || settings.semesterEnd || toDateStr(new Date())

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

      // 2. Fetch ALL volunteer + club activity time_clock entries for the semester.
      // Club Activity total_hours is already credited (0.25x actual), so summing both entry_types is correct.
      const { data: tcData, error: tcErr } = await supabase
        .from('time_clock')
        .select('record_id, user_email, total_hours, punch_in, punch_out, approval_status, status, entry_type')
        .in('entry_type', ['Volunteer', 'Club Activity'])
        .gte('punch_in', semStart + 'T00:00:00')
        .lte('punch_in', semEnd + 'T23:59:59')

      if (tcErr) throw tcErr

      // 3. Fetch pending volunteer + club activity time_entry_requests
      const reqData = mustData(await supabase
        .from('time_entry_requests')
        .select('request_id, user_email, total_hours, status, entry_type, class_id')
        .eq('status', 'Pending')
        .or('entry_type.eq.Volunteer,entry_type.eq.Club Activity,class_id.eq.VOLUNTEER,class_id.eq.CLUB_ACTIVITY'), 'time_entry_requests.select')

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
      // Hours-counting window (includes the preceding break) — see volunteerWindow.js
      const semStart = settings.countStart || settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.countEnd || settings.semesterEnd || toDateStr(new Date())

      // All volunteer + club activity time_clock entries (approved + pending)
      // Club Activity total_hours is already the credited (0.25x) amount, so summing is correct.
      const tcData = mustData(await supabase
        .from('time_clock')
        .select('*')
        .eq('user_email', studentEmail)
        .in('entry_type', ['Volunteer', 'Club Activity'])
        .gte('punch_in', semStart + 'T00:00:00')
        .lte('punch_in', semEnd + 'T23:59:59')
        .order('punch_in', { ascending: false }), 'time_clock.select')

      setEntries(tcData || [])

      // All time_entry_requests for this student (Pending, Approved, Rejected)
      // Includes Volunteer, Club Activity, and Edit-request entries.
      const reqData = mustData(await supabase
        .from('time_entry_requests')
        .select('*')
        .eq('user_email', studentEmail)
        .or('entry_type.eq.Volunteer,entry_type.eq.Club Activity,class_id.eq.VOLUNTEER,class_id.eq.CLUB_ACTIVITY')
        .order('created_at', { ascending: false }), 'time_entry_requests.select')

      const editReqs = (reqData || []).filter(r => r.entry_type === 'Edit')
      const manualReqs = (reqData || []).filter(r => r.entry_type !== 'Edit')
      setPendingEntries(manualReqs)
      setPendingEdits(editReqs)
    } catch (err) {
      console.error('Student volunteer detail error:', err)
    } finally {
      setLoading(false)
    }
  }, [studentEmail, settings.semesterStart, settings.semesterEnd, settings.countStart, settings.countEnd])

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

  // ── Instructor: directly add a new volunteer or club activity entry ──
  // Inserts directly into time_clock as an already-approved row (no approval workflow).
  // For Club Activity, applies the 0.25× crediting multiplier — total_hours stored is the
  // *credited* amount, matching the convention used elsewhere (student club submissions).
  const instructorAddEntry = async ({ entryType, date, startTime, endTime, reason }) => {
    if (!profile) { toast.error('Not authorized'); return { success: false } }
    if (!studentEmail) { toast.error('No student selected'); return { success: false } }
    if (!entryType || !['Volunteer', 'Club Activity'].includes(entryType)) {
      toast.error('Invalid entry type'); return { success: false }
    }
    if (!date || !startTime || !endTime) {
      toast.error('Date and times are required'); return { success: false }
    }
    if (!reason || !reason.trim()) {
      toast.error('Reason is required'); return { success: false }
    }

    setSaving(true)
    try {
      // Validate times
      const start = new Date(`${date}T${startTime}`)
      const end = new Date(`${date}T${endTime}`)
      if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('Invalid date/time')
      if (end <= start) throw new Error('End time must be after start time')

      const rawHours = roundToMinute((end - start) / 3600000)
      if (rawHours <= 0) throw new Error('Duration too short')

      const isClub = entryType === 'Club Activity'
      // Club Activity stores credited (0.25×) hours as total_hours — same convention as student club submissions
      const totalHours = isClub ? roundToMinute(rawHours * 0.25) : rawHours
      if (totalHours <= 0) throw new Error('Duration too short to earn credit')

      // Look up student profile for user_id and display name
      const { data: studentProfile, error: profErr } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, email')
        .eq('email', studentEmail)
        .maybeSingle()

      if (profErr) throw profErr
      if (!studentProfile) throw new Error('Student profile not found')

      // Format student name as "First L." to match TimeClockPage convention
      const studentDisplayName = `${studentProfile.first_name || ''} ${(studentProfile.last_name || '').charAt(0)}.`.trim()

      // Generate next TC record_id via shared collision-safe helper
      // (handles drift, RPC fallback, and counter sync — see generateSafeTcId).
      const recordId = await generateSafeTcId()

      // Build fake-UTC timestamps (project convention: local time stored with +00 offset)
      const punchIn = buildFakeUtcTimestamp(date, startTime)
      const punchOut = buildFakeUtcTimestamp(date, endTime)

      // Compute Monday of week using local date components (avoids UTC-midnight shift)
      const [yr, mo, dy] = date.split('-').map(n => parseInt(n, 10))
      const localDate = new Date(yr, mo - 1, dy)
      const dow = localDate.getDay()
      const mondayOffset = dow === 0 ? -6 : 1 - dow
      const monday = new Date(localDate)
      monday.setDate(localDate.getDate() + mondayOffset)
      const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`

      const instructorName = `${profile.first_name} ${profile.last_name}`.trim()
      const description = isClub
        ? `[Club Activity — ${rawHours}h actual → ${totalHours}h credited] Manually added by instructor — ${reason.trim()}`
        : `Manually added by instructor — ${reason.trim()}`

      const { data: inserted, error } = await supabase.from('time_clock').insert({
        record_id: recordId,
        user_id: studentProfile.user_id,
        user_name: studentDisplayName,
        user_email: studentProfile.email,
        class_id: isClub ? 'CLUB_ACTIVITY' : 'VOLUNTEER',
        course_id: isClub ? 'Club Activity' : 'Volunteer',
        punch_in: punchIn,
        punch_out: punchOut,
        total_hours: totalHours,
        status: 'Punched Out',
        week_start: weekStart,
        entry_type: entryType,
        description,
        approval_status: 'Approved',
        approved_by: instructorName,
        approved_date: new Date().toISOString(),
      }).select()

      if (error) throw error
      if (!inserted || inserted.length === 0) throw new Error('Insert failed — no rows added (RLS?)')

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: instructorName,
          action: 'Instructor Add Volunteer Entry',
          entity_type: 'Time Clock',
          entity_id: recordId,
          details: `Added ${entryType} entry for ${studentEmail}: ${date} ${startTime}–${endTime}` +
            (isClub ? ` (${rawHours}h actual → ${totalHours}h credited)` : ` (${totalHours}h)`) +
            ` — ${reason.trim()}`,
        })
      } catch {}

      toast.success(`${entryType} entry added`)
      await fetchDetail()
      return { success: true, recordId, totalHours, rawHours }
    } catch (err) {
      console.error('Instructor add entry error:', err)
      toast.error(err.message || 'Failed to add entry')
      return { success: false, error: err.message }
    } finally {
      setSaving(false)
    }
  }

  // ── Instructor: delete a time_clock volunteer/club activity entry ──
  // Hard delete with thorough audit_log entry capturing all original data.
  const instructorDeleteTimeClock = async (entry, reason = '') => {
    if (!profile) { toast.error('Not authorized'); return { success: false } }
    if (!entry?.record_id) { toast.error('Invalid entry'); return { success: false } }
    setSaving(true)
    try {
      // Capture full snapshot for the audit trail BEFORE deleting
      const snapshot = {
        record_id: entry.record_id,
        user_email: entry.user_email,
        user_name: entry.user_name,
        entry_type: entry.entry_type,
        punch_in: entry.punch_in,
        punch_out: entry.punch_out,
        total_hours: entry.total_hours,
        approval_status: entry.approval_status,
        description: entry.description,
      }

      const { error, count } = await supabase
        .from('time_clock')
        .delete({ count: 'exact' })
        .eq('record_id', entry.record_id)

      if (error) throw error
      if (count === 0) throw new Error('Delete failed — no rows affected (RLS?)')

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Instructor Delete Volunteer Entry',
          entity_type: 'Time Clock',
          entity_id: entry.record_id,
          old_value: JSON.stringify(snapshot),
          new_value: null,
          details: `Deleted ${entry.entry_type || 'Volunteer'} entry ${entry.record_id} for ${studentEmail}` +
            ` (${parseFloat(entry.total_hours || 0)}h)` +
            (reason && reason.trim() ? ` — ${reason.trim()}` : ''),
        })
      } catch {}

      toast.success('Entry deleted')
      await fetchDetail()
      return { success: true }
    } catch (err) {
      console.error('Instructor delete time clock error:', err)
      toast.error(err.message || 'Failed to delete entry')
      return { success: false, error: err.message }
    } finally {
      setSaving(false)
    }
  }

  // ── Instructor: delete a time_entry_request (manual submission, not yet approved/rejected) ──
  const instructorDeleteRequest = async (request, reason = '') => {
    if (!profile) { toast.error('Not authorized'); return { success: false } }
    if (!request?.request_id) { toast.error('Invalid request'); return { success: false } }
    setSaving(true)
    try {
      const snapshot = {
        request_id: request.request_id,
        user_email: request.user_email,
        user_name: request.user_name,
        entry_type: request.entry_type,
        class_id: request.class_id,
        requested_date: request.requested_date,
        start_time: request.start_time,
        end_time: request.end_time,
        total_hours: request.total_hours,
        status: request.status,
        reason: request.reason,
      }

      const { error, count } = await supabase
        .from('time_entry_requests')
        .delete({ count: 'exact' })
        .eq('request_id', request.request_id)

      if (error) throw error
      if (count === 0) throw new Error('Delete failed — no rows affected (RLS?)')

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name} ${profile.last_name}`,
          action: 'Instructor Delete Volunteer Request',
          entity_type: 'Time Entry Request',
          entity_id: request.request_id,
          old_value: JSON.stringify(snapshot),
          new_value: null,
          details: `Deleted ${request.entry_type || 'Volunteer'} request ${request.request_id} for ${studentEmail}` +
            ` (${parseFloat(request.total_hours || 0)}h, status: ${request.status || 'Pending'})` +
            (reason && reason.trim() ? ` — ${reason.trim()}` : ''),
        })
      } catch {}

      toast.success('Request deleted')
      await fetchDetail()
      return { success: true }
    } catch (err) {
      console.error('Instructor delete request error:', err)
      toast.error(err.message || 'Failed to delete request')
      return { success: false, error: err.message }
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
    instructorAddEntry,
    instructorDeleteTimeClock,
    instructorDeleteRequest,
  }
}
