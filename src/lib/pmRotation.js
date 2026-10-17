/**
 * RICT CMMS — PM rotation: "is this student in a class in session?"
 *
 * Mirrors private.pm_student_in_session() in
 * supabase/migrations/20261017_pm_rotation_in_session.sql, which decides who
 * auto_generate_pm_work_orders() may assign. The database is the authority;
 * this copy only drives labels (Users page, Work Orders assign picker) and the
 * Metrics Report alert sweep, so the screens say the same thing the PM
 * generator does.
 *
 * In session on `day` — per student, per semester:
 *   • only Active classes count (blank status counts as Active)
 *   • the student's classes are grouped by semester; each semester's span runs
 *     from its earliest start_date to its latest last day (the later of
 *     end_date / finals_end)
 *   • the student is in session when `day` falls inside any span — so the gap
 *     between first- and second-8-week classes is covered, breaks between
 *     semesters are not
 *   • a missing date never excludes
 * classInSessionOn() is the single-class test (kept for reuse).
 *
 *   chicagoToday()                                  → 'YYYY-MM-DD'
 *   classInSessionOn(cls, day)                      → boolean
 *   buildRotationStatus(enrollments, classes, day)  → Map<lowerEmail, { inSession, nextStart }>
 *   loadRotationStatus()                            → Promise<{ byEmail, available, day }>
 *
 * File: src/lib/pmRotation.js
 */

import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'

const lc = (s) => String(s || '').trim().toLowerCase()
const ymd = (v) => {
  const s = String(v || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

/** Today's date in America/Chicago as 'YYYY-MM-DD' (the PM generator's "today"). */
export function chicagoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (t) => parts.find(p => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function isActiveClass(cls) {
  const st = String(cls?.status || '').trim()
  return !st || st === 'Active'
}

function lastDayOf(cls) {
  return [ymd(cls?.end_date), ymd(cls?.finals_end)].filter(Boolean).sort().pop() || ''
}

/** True when the class is in session on `day` ('YYYY-MM-DD'). */
export function classInSessionOn(cls, day) {
  if (!cls || !isActiveClass(cls)) return false
  const start = ymd(cls.start_date)
  const last = lastDayOf(cls)
  if (start && start > day) return false
  if (last && last < day) return false
  return true
}

/**
 * Per student (lower-case email): whether they are in session on `day`, and —
 * when not — the earliest upcoming semester start ('' when none), so the label
 * can say when they join.
 */
export function buildRotationStatus(enrollments, classes, day) {
  const byId = new Map((classes || []).map(c => [String(c.class_id), c]))
  // email → Map<semesterKey, { first, last }>
  const spans = new Map()
  for (const e of enrollments || []) {
    const email = lc(e.student_email)
    if (!email) continue
    if (!spans.has(email)) spans.set(email, new Map())
    const cls = byId.get(String(e.class_id))
    if (!cls || !isActiveClass(cls)) continue
    const key = String(cls.semester || '').trim() || String(cls.term_id || '').trim() || `class:${cls.class_id}`
    const first = ymd(cls.start_date) || '0001-01-01'
    const last = lastDayOf(cls) || '9999-12-31'
    const cur = spans.get(email).get(key)
    if (!cur) spans.get(email).set(key, { first, last })
    else {
      if (first < cur.first) cur.first = first
      if (last > cur.last) cur.last = last
    }
  }
  const out = new Map()
  for (const [email, sems] of spans) {
    let inSession = false, nextStart = ''
    for (const { first, last } of sems.values()) {
      if (first <= day && last >= day) inSession = true
      else if (first > day && first !== '0001-01-01' && (!nextStart || first < nextStart)) nextStart = first
    }
    out.set(email, { inSession, nextStart: inSession ? '' : nextStart })
  }
  return out
}

/**
 * Read enrollments + classes and build the status map.
 * `available` is false when the read failed or returned no enrollments at all
 * (e.g. the viewer can't read rosters) — callers then show nothing rather
 * than labelling every student as out of the rotation.
 */
export async function loadRotationStatus() {
  const day = chicagoToday()
  try {
    const [enr, cls] = await Promise.all([
      supabase.from('class_enrollments').select('class_id, student_email'),
      supabase.from('classes').select('class_id, semester, term_id, status, start_date, end_date, finals_end'),
    ])
    const enrollments = mustData(enr, 'class_enrollments.select') || []
    const classes = mustData(cls, 'classes.select') || []
    if (!enrollments.length) return { byEmail: new Map(), available: false, day }
    return { byEmail: buildRotationStatus(enrollments, classes, day), available: true, day }
  } catch (e) {
    console.warn('PM rotation status unavailable:', e?.message || e)
    return { byEmail: new Map(), available: false, day }
  }
}

/** { inSession, nextStart } for one email; unknown students are not in session. */
export function rotationStatusFor(byEmail, email) {
  return byEmail?.get(lc(email)) || { inSession: false, nextStart: '' }
}

/** 'Jan 11' from 'YYYY-MM-DD' (no time-zone shift). */
export function shortDate(day) {
  const s = ymd(day)
  if (!s) return ''
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Short visible label for a student who is NOT in the rotation. */
export function rotationLabel(status) {
  if (!status || status.inSession) return ''
  return status.nextStart ? `PM rotation from ${shortDate(status.nextStart)}` : 'Not in PM rotation'
}

/** Longer explanation for title / screen readers. */
export function rotationExplanation(status) {
  if (!status || status.inSession) return ''
  return status.nextStart
    ? `Not in the PM rotation — no class in session. Joins when their first class starts on ${shortDate(status.nextStart)}.`
    : 'Not in the PM rotation — not enrolled in a class in session.'
}
