/**
 * RICT CMMS — useAccountabilityReport
 *
 * Data layer for the Accountability Report page. Gathers everything one
 * student can be held to for one academic term and hands it to the pure rules
 * in src/lib/accountabilityRules.js. Nothing here judges anything; it only
 * fetches, normalises, and reuses the engines other pages already trust:
 *
 *   generateUserReport()             Time Cards — late / early / walk-in / wrong class
 *   computeWeeklySignupStatus()      Dashboard — weekly sign-up short / met / All Done
 *   fetchMakeupOverlay()             make-up hours added to a week
 *   fetchClosureOverlay()            closed lab days + finals proration
 *   computeStudentScoresForWindows() WOC Ratio — late / team late / stale
 *   volunteerStanding()              Volunteer Hours standing (rules lib)
 *   help_requests                    wait for "On My Way" / time to cleared (rules lib)
 *
 * Exports
 *   loadShared(term)                             → term-wide data every student shares
 *   loadStudentReport(student, term, shared, o)  → { student, report, errors }
 *   useAccountabilityStudent({ student, term, studentView, canViewNotes, enabled })
 *   useAccountabilityClass({ classId, term, canViewNotes, enabled })
 *   useTermClasses(term)                         → classes in the term (+ rosters)
 *
 * Conventions honored
 *   - Reads that feed a user-visible number go through mustData(); optional
 *     decorations (notes, holds, acknowledgements) are soft reads that log
 *     and fall back to empty so the report still renders.
 *   - ilike is used for case-insensitive email match, then pinned to the exact
 *     address afterwards ("_" and "%" are wildcards to ilike).
 *   - Date-only strings + 'T00:00:00'; fake-UTC columns are never toISOString()'d.
 *   - Realtime is deliberately NOT used: the report is a point-in-time read
 *     with a Refresh button (it pulls from a dozen tables).
 *
 * File: src/hooks/useAccountabilityReport.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { generateUserReport } from '@/hooks/useTimeCards'
import { computeWeeklySignupStatus, requestWeekMonday } from '@/lib/weeklySignupStatus'
import { fetchMakeupOverlay } from '@/hooks/useMakeupHours'
import { fetchClosureOverlay } from '@/lib/closureProration'
import { computeStudentScoresForWindows } from '@/hooks/useWOCRatio'
import { resolveVolunteerWindow } from '@/lib/volunteerWindow'
import {
  buildReport, volunteerStanding, classInTerm, enrolledIn, mondaysBetween, toDateKey, dateOnly, lower, fakeUtcDateKey,
  DEFAULT_GRACE_MINUTES, DEFAULT_LATE_CANCEL_HOURS, DEFAULT_TREND_WEEKS,
} from '@/lib/accountabilityRules'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SETTING_KEYS = [
  'grace_period_minutes', 'late_cancel_hours', 'standing_trend_weeks',
  'volunteer_semester_total_hours', 'volunteer_midpoint_hours', 'volunteer_midpoint_week',
]

function num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  const n = parseFloat(v)
  return isNaN(n) ? fallback : n
}

function mine(email) {
  const me = lower(email)
  return r => lower(r.user_email) === me
}

/** Soft read: log and return [] instead of throwing (decorations only). */
async function soft(promise, label) {
  try {
    const { data, error } = await promise
    if (error) { console.warn(`AccountabilityReport: ${label} unavailable:`, error.message); return [] }
    return data || []
  } catch (e) {
    console.warn(`AccountabilityReport: ${label} threw:`, e?.message || e)
    return []
  }
}

/** Week number of `dateStr` relative to a Monday-anchored semester start (1-based). */
function weekNumberOf(semesterStart, dateStr) {
  if (!semesterStart || !dateStr) return 0
  const a = new Date(mondayOf(semesterStart) + 'T00:00:00')
  const b = new Date(mondayOf(dateStr) + 'T00:00:00')
  return Math.max(0, Math.floor((b - a) / (7 * 86400000)) + 1)
}
function mondayOf(dateStr) {
  const d = new Date(dateOnly(dateStr) + 'T00:00:00')
  const day = d.getDay()
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1))
  return toDateKey(d)
}

/** 'first' | 'second' | 'full' — mirrors getClassPeriod() in useVolunteerHours.js. */
function classPeriod(cls, semesterStart, midpointWeek) {
  if (!cls.start_date || !cls.end_date || !semesterStart || !midpointWeek) return 'full'
  const mid = new Date(dateOnly(semesterStart) + 'T00:00:00')
  mid.setDate(mid.getDate() + midpointWeek * 7)
  const s = new Date(dateOnly(cls.start_date) + 'T00:00:00')
  const e = new Date(dateOnly(cls.end_date) + 'T00:00:00')
  if (e < mid) return 'first'
  if (s >= mid) return 'second'
  return 'full'
}

function termRange(term) {
  const begin = dateOnly(term?.begin_date)
  let end = dateOnly(term?.end_date)
  const fe = dateOnly(term?.finals_end)
  if (fe && fe > end) end = fe
  return { begin, end }
}

// ─── Shared (term-wide) data ──────────────────────────────────────────────────

/**
 * Everything that does not depend on the student. Loaded once per term and
 * reused for every row of a class report.
 */
export async function loadShared(term) {
  const { begin, end } = termRange(term)
  if (!begin || !end) throw new Error('The selected term has no begin / end dates.')
  const today = toDateKey(new Date())

  const [settingsRes, classesRes, closureOverlay, reminders] = await Promise.all([
    supabase.from('settings').select('setting_key, setting_value').in('setting_key', SETTING_KEYS),
    supabase.from('classes').select('*'),
    fetchClosureOverlay({ rangeStart: begin, rangeEnd: end }),
    soft(supabase.from('weekly_reminders').select('*'), 'weekly_reminders'),
  ])
  const settingsRows = mustData(settingsRes, 'settings.select') || []
  const map = new Map(settingsRows.map(r => [r.setting_key, r.setting_value]))
  const settings = {
    gracePeriod: Math.round(num(map.get('grace_period_minutes'), DEFAULT_GRACE_MINUTES)),
    lateCancelHours: num(map.get('late_cancel_hours'), DEFAULT_LATE_CANCEL_HOURS),
    trendWeeks: Math.round(num(map.get('standing_trend_weeks'), DEFAULT_TREND_WEEKS)),
    volunteer: {
      totalHoursRequired: num(map.get('volunteer_semester_total_hours'), 10),
      midpointHours: num(map.get('volunteer_midpoint_hours'), 5),
      midpointWeek: Math.round(num(map.get('volunteer_midpoint_week'), 8)),
    },
  }
  const classes = mustData(classesRes, 'classes.select') || []
  const termClasses = classes.filter(c => classInTerm(c, term))
  // computeWeeklySignupStatus() only considers Active rows; an archived past
  // term must still compute, so its classes are presented as Active for the
  // pure calculation (nothing is written back).
  const termClassesForStatus = termClasses.map(c => ({ ...c, status: 'Active' }))

  // Volunteer window: the shared resolver for the current term (it reaches
  // back over the preceding break), the term's own dates otherwise.
  const isCurrent = begin <= today && today <= end
  let volunteerWindow = { countStart: begin, countEnd: end, semesterStart: begin }
  if (isCurrent) {
    try {
      const w = await resolveVolunteerWindow()
      volunteerWindow = { countStart: w.countStart || begin, countEnd: w.countEnd || end, semesterStart: w.semesterStart || begin }
    } catch (e) { console.warn('AccountabilityReport: volunteer window fallback:', e?.message || e) }
  }
  const qualifyingClasses = termClasses
    .filter(c => c.requires_volunteer_hours === true || c.requires_volunteer_hours === 'true' || c.requires_volunteer_hours === 'Yes')
    .map(c => ({ ...c, period: classPeriod(c, volunteerWindow.semesterStart, settings.volunteer.midpointWeek) }))
  const currentWeek = weekNumberOf(volunteerWindow.semesterStart, today <= end ? today : end)

  const mondays = mondaysBetween(begin, end)

  return { term, begin, end, today, settings, classes, termClasses, termClassesForStatus, closureOverlay, reminders, volunteerWindow, qualifyingClasses, currentWeek, mondays }
}

// ─── One student ──────────────────────────────────────────────────────────────

/**
 * Gather one student's data and run the rules.
 *
 * @param {Object} student   profiles row (user_id, email, first_name, last_name, role, classes, id, created_at)
 * @param {Object} term      academic_terms row
 * @param {Object} shared    from loadShared(term)
 * @param {Object} [opts]    { studentView: boolean, canViewNotes: boolean, skipWoc: boolean }
 * @returns {Promise<{ student, report, errors: string[] }>}
 */
export async function loadStudentReport(student, term, shared, opts = {}) {
  const email = String(student?.email || '').trim()
  if (!email) throw new Error('Student has no email address.')
  const { begin, end, today } = shared
  const endTs = end + 'T23:59:59'
  const errors = []
  const isMine = mine(email)

  // ── Enrollment (class_enrollments first, profile cache as fallback) ───────
  const enrollmentRows = (await soft(
    supabase.from('class_enrollments').select('class_id, enrolled_at, student_email').ilike('student_email', email),
    'class_enrollments')).filter(r => lower(r.student_email) === lower(email))
  const enrolledClassIds = new Set(enrollmentRows.map(r => r.class_id))
  const cacheIds = String(student.classes || '').split(',').map(s => s.trim()).filter(Boolean)
  const enrolledAt = new Map(enrollmentRows.map(r => [r.class_id, r.enrolled_at]))
  const enrolledClasses = shared.termClasses
    .filter(c => enrolledClassIds.has(c.class_id) || enrolledIn(c, cacheIds))
    .map(c => ({ ...c, enrolled_at: enrolledAt.get(c.class_id) || null }))
  const enrolledIds = [...new Set(enrolledClasses.flatMap(c => [c.class_id, c.course_id]).filter(Boolean))]

  // ── Sign-ups (new columns may not exist until the migration runs) ─────────
  let signups = []
  {
    const cols = 'signup_id, date, start_time, end_time, class_id, status, created_at, is_makeup, cancelled_at, cancelled_by_email'
    let res = await supabase.from('lab_signup').select(cols).ilike('user_email', email).gte('date', begin).lte('date', endTs)
    if (res.error && /cancelled_at|cancelled_by_email/i.test(res.error.message || '')) {
      errors.push('Cancellation timing is not available yet (run migration 20260922).')
      res = await supabase.from('lab_signup').select('signup_id, date, start_time, end_time, class_id, status, created_at, is_makeup, user_email').ilike('user_email', email).gte('date', begin).lte('date', endTs)
    }
    signups = (mustData(res, 'lab_signup.select') || []).filter(r => r.user_email === undefined || isMine(r))
  }

  // ── Everything else, in parallel ──────────────────────────────────────────
  const [signupRequests, tcRes, makeupOverlay, absRes, timeRequests, checkouts, holdTargets, acks, volTc, volReq, assignRes, legacyAssigned, myLogs, helpRequests] = await Promise.all([
    soft(supabase.from('lab_signup_requests').select('request_id, user_email, class_id, course_id, week_start, reason, status, submitted_date, reviewed_by, reviewed_date').ilike('user_email', email), 'lab_signup_requests'),
    supabase.from('time_clock').select('*').ilike('user_email', email).gte('punch_in', begin + 'T00:00:00').lte('punch_in', endTs).order('punch_in', { ascending: true }),
    fetchMakeupOverlay({ emails: [email], rangeStart: begin, rangeEnd: end }),
    supabase.from('absence_requests').select('*').ilike('user_email', email),
    soft(supabase.from('time_entry_requests').select('*').ilike('user_email', email).gte('requested_date', begin).lte('requested_date', end), 'time_entry_requests'),
    soft(supabase.from('asset_checkouts').select('*').ilike('user_email', email), 'asset_checkouts'),
    soft(supabase.from('student_hold_targets').select(`
        target_id, hold_id, user_email, user_name, acknowledged_at, cleared_at, cleared_by_email, cleared_by_name, cleared_method,
        hold:student_holds!inner ( hold_id, title, message, severity, template_type, created_by_email, created_by_name, created_at, expires_at, status )
      `).ilike('user_email', email), 'student_hold_targets'),
    soft(supabase.from('reminder_acknowledgements').select('reminder_id, week_start, user_email').ilike('user_email', email).gte('week_start', begin).lte('week_start', end), 'reminder_acknowledgements'),
    soft(supabase.from('time_clock').select('record_id, user_email, total_hours, approval_status, entry_type, punch_in').ilike('user_email', email)
      .in('entry_type', ['Volunteer', 'Club Activity'])
      .gte('punch_in', shared.volunteerWindow.countStart + 'T00:00:00').lte('punch_in', shared.volunteerWindow.countEnd + 'T23:59:59'), 'time_clock.volunteer'),
    soft(supabase.from('time_entry_requests').select('request_id, user_email, total_hours, status, entry_type, class_id').ilike('user_email', email).eq('status', 'Pending')
      .or('entry_type.eq.Volunteer,entry_type.eq.Club Activity,class_id.eq.VOLUNTEER,class_id.eq.CLUB_ACTIVITY'), 'time_entry_requests.volunteer'),
    soft(supabase.from('work_order_assignments').select('wo_id, user_email').ilike('user_email', email), 'work_order_assignments'),
    soft(supabase.from('work_orders').select('wo_id, description, title, due_date, created_at, status, assigned_email').ilike('assigned_email', email).neq('status', 'Closed'), 'work_orders.assigned'),
    soft(supabase.from('work_log').select('wo_id, user_email').ilike('user_email', email), 'work_log'),
    // Help requests: requested_at / acknowledged_at / resolved_at are REAL UTC
    soft(supabase.from('help_requests').select('*').ilike('user_email', email)
      .gte('requested_at', begin + 'T00:00:00').lte('requested_at', end + 'T23:59:59.999'), 'help_requests'),
  ])

  const timeClock = (mustData(tcRes, 'time_clock.select') || []).filter(isMine)
  const absencesAll = (mustData(absRes, 'absence_requests.select') || []).filter(isMine)
  // Keep the requests that belong to this term (absence day, due day, or filing day inside it)
  const absences = absencesAll.filter(a => {
    const keys = [dateOnly(a.absence_date), dateOnly(a.due_date), dateOnly(a.week_start), dateOnly(a.created_at)].filter(Boolean)
    return keys.some(k => k >= begin && k <= end)
  })

  // Instructor-only notes (RLS hides them from students anyway; skip the read entirely for the student view)
  let absenceNotes = []
  if (opts.canViewNotes && absences.length) {
    absenceNotes = await soft(supabase.from('absence_request_notes').select('note_id, request_id, note, created_by, created_at').in('request_id', absences.map(a => a.request_id)).order('created_at', { ascending: true }), 'absence_request_notes')
  }

  // ── Time Cards engine (late / early / walk-in / wrong class / weekly scores) ─
  // Pass the term's enrolled ids as the class list so past terms work even
  // though profiles.classes only caches the current term.
  const userData = {
    user_id: student.user_id, email, first_name: student.first_name || '', last_name: student.last_name || '',
    role: student.role, id: student.id || '', classes: enrolledIds.join(','),
  }
  const userReport = await generateUserReport(userData, begin, end, shared.settings.gracePeriod, shared.classes)

  // ── Weekly sign-up status, every week of the term ─────────────────────────
  const person = { email, classes: enrolledIds.join(','), first_name: student.first_name || '', last_name: student.last_name || '' }
  const confirmed = signups.filter(s => s.status === 'Confirmed').map(s => ({ user_email: email, class_id: s.class_id, date: s.date }))
  const pendingRequests = signupRequests.filter(isMine).filter(r => r.status === 'Pending')
  const allDoneRows = timeClock.filter(r => r.entry_type === 'All Done').map(r => ({ user_email: email, punch_in: r.punch_in, entry_type: 'All Done' }))
  const weekStatuses = new Map()
  for (const monday of shared.mondays) {
    const byEmail = computeWeeklySignupStatus({
      mondayKey: monday, people: [person], classRows: shared.termClassesForStatus, signups: confirmed,
      closureOverlay: shared.closureOverlay, makeupOverlay, pendingRequests, allDoneRows,
    })
    const st = byEmail.get(lower(email))
    if (st) weekStatuses.set(monday, st)
  }

  // ── WOC Ratio for the term window (capped at today) ───────────────────────
  let woc = null
  if (opts.skipWoc) {
    // Alert sweep: the WOC engine re-reads every work order per student, which
    // is too heavy for a whole-program pass; work-order lateness for alerts
    // comes from meta.woLate (assigned open WOs vs due_date) instead.
  } else try {
    const scores = await computeStudentScoresForWindows(
      { user_id: student.user_id, email, role: student.role, first_name: student.first_name, last_name: student.last_name, created_at: student.created_at },
      [{ key: 'term', startDate: begin, endDate: today < end ? today : end }],
    )
    woc = scores?.term || null
  } catch (e) {
    errors.push('WOC Ratio could not be calculated.')
    console.warn('AccountabilityReport: WOC failed:', e?.message || e)
  }

  // Assigned open WOs (junction table + legacy assigned_email) and what the student has logged on
  const assignedIds = [...new Set(assignRes.filter(isMine).map(a => a.wo_id).filter(Boolean))]
  let assignedOpenWOs = legacyAssigned.filter(w => lower(w.assigned_email) === lower(email))
  if (assignedIds.length) {
    const more = await soft(supabase.from('work_orders').select('wo_id, description, title, due_date, created_at, status').in('wo_id', assignedIds).neq('status', 'Closed'), 'work_orders.assignments')
    const seen = new Set(assignedOpenWOs.map(w => w.wo_id))
    more.forEach(w => { if (!seen.has(w.wo_id)) { assignedOpenWOs.push(w); seen.add(w.wo_id) } })
  }
  const myLoggedWoIds = new Set(myLogs.filter(isMine).map(l => l.wo_id))

  // ── Volunteer standing ────────────────────────────────────────────────────
  const approvedHours = volTc.filter(isMine).filter(r => r.approval_status === 'Approved').reduce((s, r) => s + (parseFloat(r.total_hours) || 0), 0)
  const pendingHours = volReq.filter(isMine).filter(r => r.entry_type !== 'Edit').reduce((s, r) => s + (parseFloat(r.total_hours) || 0), 0)
  const studentCourseIds = enrolledClasses.map(c => c.course_id).filter(Boolean)
  const isTcOnly = student.time_clock_only === 'Yes' || student.time_clock_only === true
  const volunteer = isTcOnly ? null : volunteerStanding({
    approvedHours, pendingHours, studentCourseIds, qualifyingClasses: shared.qualifyingClasses,
    settings: { ...shared.settings.volunteer, semesterStart: shared.volunteerWindow.semesterStart }, currentWeek: shared.currentWeek,
  })

  // ── Trim the all-history reads to THIS term ───────────────────────────────
  // Everything the report counts must belong to the selected semester; the
  // reads above are per-student (not per-date) so they are cut down here.
  const inTerm = k => !!k && k >= begin && k <= end

  // Sign-up change requests: by the week they change (Sunday week_start maps
  // to the following Monday-week), falling back to the day they were filed.
  const termSignupRequests = signupRequests.filter(isMine).filter(r => {
    const week = requestWeekMonday(r.week_start) || dateOnly(r.week_start)
    return inTerm(week) || (!week && inTerm(dateOnly(r.submitted_date)))
  })

  // Checkouts: anything still open counts; closed ones only if the checkout,
  // expected return or actual return fell inside the term.
  const termCheckouts = checkouts.filter(isMine).filter(c => {
    if (c.status === 'checked_out' || c.status === 'pending_acknowledgment' || lower(c.status) === 'lost') return true
    return [fakeUtcDateKey(c.checked_out_at), fakeUtcDateKey(c.expected_return), fakeUtcDateKey(c.returned_at)].some(inTerm)
  })

  // Holds: open ones always count; cleared ones only if created in the term.
  const holds = holdTargets.filter(isMine).filter(t => t.hold)
    .filter(t => !t.cleared_at || inTerm(dateOnly(t.hold.created_at)))
    .map(t => ({ ...t.hold, target: t }))

  const report = buildReport({
    student, term, today, studentView: !!opts.studentView,
    settings: shared.settings, gracePeriod: shared.settings.gracePeriod, lateCancelHours: shared.settings.lateCancelHours,
    studentEmail: email, enrolledClasses, enrolledIds,
    signups, signupRequests: termSignupRequests, timeClock, userReport, weekStatuses, closureOverlay: shared.closureOverlay,
    absences, absenceNotes, timeRequests: timeRequests.filter(isMine).filter(r => !['Volunteer', 'Club Activity'].includes(r.entry_type) && !['VOLUNTEER', 'CLUB_ACTIVITY'].includes(r.class_id)),
    woc, assignedOpenWOs, myLoggedWoIds,
    checkouts: termCheckouts,
    holds, volunteer,
    reminders: shared.reminders, acks: acks.filter(isMine),
    helpRequests: helpRequests.filter(isMine),
  })

  return { student, report, errors }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** One student's report (own view or instructor pick). */
export function useAccountabilityStudent({ student, term, studentView = false, canViewNotes = false, enabled = true } = {}) {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const runId = useRef(0)

  const load = useCallback(async () => {
    if (!enabled || !student?.email || !term) { setResult(null); return }
    const id = ++runId.current
    setLoading(true); setError('')
    try {
      const shared = await loadShared(term)
      const r = await loadStudentReport(student, term, shared, { studentView, canViewNotes })
      if (id === runId.current) setResult(r)
    } catch (e) {
      console.error('useAccountabilityStudent:', e)
      if (id === runId.current) { setError(e?.message || 'The report could not be loaded.'); setResult(null) }
    } finally {
      if (id === runId.current) setLoading(false)
    }
  }, [enabled, student?.email, student?.user_id, term?.term_id, studentView, canViewNotes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  return { result, loading, error, refresh: load }
}

/** Every enrolled student of one class, computed a few at a time. */
export function useAccountabilityClass({ classId, term, canViewNotes = false, enabled = true } = {}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const runId = useRef(0)

  const load = useCallback(async () => {
    if (!enabled || !classId || !term) { setRows([]); return }
    const id = ++runId.current
    setLoading(true); setError(''); setProgress({ done: 0, total: 0 })
    try {
      const shared = await loadShared(term)
      const enrollment = mustData(await supabase.from('class_enrollments').select('student_email').eq('class_id', classId), 'class_enrollments.select') || []
      const emails = [...new Set(enrollment.map(r => lower(r.student_email)).filter(Boolean))]
      let people = []
      if (emails.length) {
        people = (mustData(await supabase.from('profiles').select('user_id, id, email, first_name, last_name, role, status, classes, created_at, time_clock_only').in('email', emails), 'profiles.select') || [])
        // profiles.email may differ in case from class_enrollments.student_email
        const found = new Set(people.map(p => lower(p.email)))
        const missing = emails.filter(e => !found.has(e))
        if (missing.length) {
          const extra = await soft(supabase.from('profiles').select('user_id, id, email, first_name, last_name, role, status, classes, created_at, time_clock_only').or(missing.map(e => `email.ilike.${e}`).join(',')), 'profiles.ilike')
          people = people.concat(extra.filter(p => missing.includes(lower(p.email))))
        }
      }
      people.sort((a, b) => `${a.last_name || ''} ${a.first_name || ''}`.localeCompare(`${b.last_name || ''} ${b.first_name || ''}`))
      setProgress({ done: 0, total: people.length })
      const out = []
      const CONCURRENCY = 3
      for (let i = 0; i < people.length; i += CONCURRENCY) {
        if (id !== runId.current) return
        const batch = people.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map(async p => {
          try { return await loadStudentReport(p, term, shared, { studentView: false, canViewNotes }) }
          catch (e) { console.error('AccountabilityReport row failed:', p.email, e); return { student: p, report: null, errors: [e?.message || 'failed'] } }
        }))
        out.push(...results)
        if (id === runId.current) { setProgress({ done: out.length, total: people.length }); setRows([...out]) }
      }
    } catch (e) {
      console.error('useAccountabilityClass:', e)
      if (id === runId.current) { setError(e?.message || 'The class report could not be loaded.'); setRows([]) }
    } finally {
      if (id === runId.current) setLoading(false)
    }
  }, [enabled, classId, term?.term_id, canViewNotes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  return { rows, loading, progress, error, refresh: load }
}

/** Classes offered in the term (for the class picker) — every status, newest course first. */
export function useTermClasses(term) {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!term) { setClasses([]); return }
      setLoading(true)
      try {
        const rows = mustData(await supabase.from('classes').select('class_id, course_id, course_name, semester, term_id, status, start_date, end_date, finals_end, instructor, required_hours'), 'classes.select') || []
        const inTerm = rows.filter(c => classInTerm(c, term)).sort((a, b) => String(a.course_id || '').localeCompare(String(b.course_id || '')))
        if (!cancelled) setClasses(inTerm)
      } catch (e) {
        console.error('useTermClasses:', e)
        if (!cancelled) setClasses([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [term?.term_id]) // eslint-disable-line react-hooks/exhaustive-deps
  return { classes, loading }
}
