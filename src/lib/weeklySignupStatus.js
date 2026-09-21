/**
 * RICT CMMS — Weekly lab sign-up status (has a student booked their required hours?)
 *
 * Answers one question per student for one Monday-anchored week:
 *   "Across all of their classes, have they signed up for every hour they owe?"
 *
 * Used by the instructor Dashboard's Day View (green check / red X beside the
 * name). The numbers come from the SAME engine Lab Signup and Attendance
 * Reports use, so the dashboard can never disagree with what the student sees:
 *
 *   required (per class) = weekBaseRequirement()   ← closures, first/last partial
 *                                                    week, finals / split week
 *                        + approved make-up hours  ← fetchMakeupOverlay()
 *   signed   (per class) = Confirmed lab_signup rows that week for that class
 *                          (one row = one hour, as on Lab Signup)
 *
 * RULES (confirmed with Aaron, 2026-09-21)
 *   - EVERY class must be met. Extra hours booked under one class do not cover
 *     another, so the numerator caps each class at its own requirement:
 *     8 + 2 required, 10 booked all under class A → 8/10, not met.
 *   - The week is the week of the day being viewed, not always "this week".
 *   - A person whose total requirement is 0 (Time Clock Only, lab staff, all
 *     online classes, week before/after their classes, fully closed week) has
 *     NO status — `required === 0` — and the UI shows nothing for them.
 *
 * Enrollment follows Lab Signup exactly: profiles.classes (the cache the
 * class_enrollments trigger maintains), matched to the Active class offering
 * whose start..end/finals window overlaps the week. Both course_id and
 * class_id formats are accepted everywhere (dual-format rule).
 *
 * Exports
 *   weekRangeOf(dateStr)                       → { monday, sunday }
 *   classesForWeek(classRows, monday, sunday)  → rows in session that week
 *   computeWeeklySignupStatus({...})           → Map<emailLower, WeekStatus>   (pure)
 *   formatHoursShort(n)                        → '8' | '6.4'
 *   describeWeekStatus(status)                 → { short, long }               (pure)
 *   fetchWeeklySignupStatus({ dateStr })       → Promise<{ mondayKey, byEmail }>
 *
 * Conventions honored
 *   - Date-only strings parsed with 'T00:00:00' (local); never toISOString()
 *   - Reads that feed a user-visible number go through mustData()
 *
 * File: src/lib/weeklySignupStatus.js
 */

import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { fetchClosureOverlay, weekBaseRequirement, mondayKeyOf } from '@/lib/closureProration'
import { fetchMakeupOverlay, getMakeupHours } from '@/hooks/useMakeupHours'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0') }
function toKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function dateOnly(v) { return v ? String(v).substring(0, 10) : null }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }
function lower(s) { return String(s || '').toLowerCase().trim() }

/** Monday..Sunday ('YYYY-MM-DD') of the week containing dateStr. */
export function weekRangeOf(dateStr) {
  const monday = mondayKeyOf(dateStr)
  if (!monday) return { monday: null, sunday: null }
  const d = new Date(monday + 'T00:00:00')
  d.setDate(d.getDate() + 6)
  return { monday, sunday: toKey(d) }
}

/**
 * Active class offerings in session during [monday, sunday]. A class counts
 * when it has started by Sunday and its last day (end_date or finals_end,
 * whichever is later) is on/after Monday. Missing dates never exclude.
 */
export function classesForWeek(classRows, monday, sunday) {
  return (classRows || []).filter(c => {
    if (c.status && c.status !== 'Active') return false
    const start = dateOnly(c.start_date)
    const lastDay = [dateOnly(c.end_date), dateOnly(c.finals_end)].filter(Boolean).sort().pop() || null
    if (start && sunday && start > sunday) return false
    if (lastDay && monday && lastDay < monday) return false
    return true
  })
}

/** '8', '6.4', '6.75' — trailing zeros dropped. */
export function formatHoursShort(n) {
  return String(round2(n))
}

/**
 * @typedef {Object} WeekStatus
 * @property {number}  required   total hours owed this week, all classes (2 dp)
 * @property {number}  counted    hours that count toward it — each class capped at its own requirement
 * @property {number}  signed     every hour booked for their classes (uncapped)
 * @property {boolean} met        every class with a requirement is fully booked
 * @property {Array<{courseId:string, classId:string, required:number, signed:number, met:boolean, makeup:number}>} perClass
 */

/**
 * Pure calculation. Nothing here touches the network.
 *
 * @param {Object}   p
 * @param {string}   p.mondayKey
 * @param {Array}    p.people          [{ email, classes }]  classes = profiles.classes string
 * @param {Array}    p.classRows       classes rows (any status/dates; filtered here)
 * @param {Array}    p.signups         Confirmed lab_signup rows for the week [{ user_email, class_id, date }]
 * @param {Object}   p.closureOverlay  from fetchClosureOverlay / buildClosureOverlay
 * @param {Object}   [p.makeupOverlay] from fetchMakeupOverlay
 * @returns {Map<string, WeekStatus>}  keyed by lowercased email
 */
export function computeWeeklySignupStatus({ mondayKey, people, classRows, signups, closureOverlay, makeupOverlay } = {}) {
  const out = new Map()
  const { monday, sunday } = weekRangeOf(mondayKey)
  if (!monday || !closureOverlay) return out

  const weekClasses = classesForWeek(classRows, monday, sunday)

  // email → id (course_id or class_id as stored on the signup) → hours
  const signedBy = new Map()
  ;(signups || []).forEach(s => {
    const d = dateOnly(s.date)
    if (!d || d < monday || d > sunday) return
    const email = lower(s.user_email)
    const id = String(s.class_id || '').trim()
    if (!email || !id) return
    if (!signedBy.has(email)) signedBy.set(email, new Map())
    const m = signedBy.get(email)
    m.set(id, (m.get(id) || 0) + 1) // one row = one hour
  })

  ;(people || []).forEach(person => {
    const email = lower(person.email)
    if (!email) return
    const enrolledIds = String(person.classes || '').split(',').map(s => s.trim()).filter(Boolean)
    if (enrolledIds.length === 0) return

    // Dual-format rule: profiles.classes may hold course_id or class_id.
    // De-dupe by class_id so the same offering is never counted twice.
    const mine = []
    const seen = new Set()
    weekClasses.forEach(c => {
      if (!enrolledIds.includes(c.course_id) && !enrolledIds.includes(c.class_id)) return
      const key = c.class_id || c.course_id
      if (seen.has(key)) return
      seen.add(key)
      mine.push(c)
    })
    if (mine.length === 0) return

    const mySigned = signedBy.get(email) || new Map()
    const perClass = mine.map(c => {
      const base = weekBaseRequirement(closureOverlay, { baseHours: c.required_hours, mondayKey: monday, cls: c })
      const makeup = getMakeupHours(makeupOverlay, email, monday, c.course_id)
        || getMakeupHours(makeupOverlay, email, monday, c.class_id)
      const required = round2((base?.hours || 0) + makeup)
      // A signup may carry either id; when both ids are the same string count once.
      const ids = [...new Set([c.course_id, c.class_id].filter(Boolean))]
      const signed = ids.reduce((sum, id) => sum + (mySigned.get(id) || 0), 0)
      return {
        courseId: c.course_id || '', classId: c.class_id || '',
        required, signed, makeup: round2(makeup),
        met: signed >= required,
      }
    })

    const required = round2(perClass.reduce((s, c) => s + c.required, 0))
    const counted = round2(perClass.reduce((s, c) => s + Math.min(c.signed, c.required), 0))
    const signed = perClass.reduce((s, c) => s + c.signed, 0)
    const met = perClass.every(c => c.required <= 0 || c.met)
    out.set(email, { required, counted, signed, met, perClass })
  })

  return out
}

/**
 * Text for the UI. `short` is what shows beside the X ("6/8"); `long` is the
 * full sentence for screen readers / tooltip, naming the classes that are short.
 */
export function describeWeekStatus(status) {
  if (!status || !(status.required > 0)) return { short: '', long: '' }
  if (status.met) {
    return {
      short: '',
      long: `Signed up for all ${formatHoursShort(status.required)} required lab hours this week.`,
    }
  }
  const short = `${formatHoursShort(status.counted)}/${formatHoursShort(status.required)}`
  const shortClasses = status.perClass
    .filter(c => c.required > 0 && !c.met)
    .map(c => `${c.courseId || c.classId} ${formatHoursShort(Math.min(c.signed, c.required))} of ${formatHoursShort(c.required)}`)
  return {
    short,
    long: `Signed up for ${formatHoursShort(status.counted)} of ${formatHoursShort(status.required)} required lab hours this week. Short: ${shortClasses.join('; ')}.`,
  }
}

// ─── Data access ──────────────────────────────────────────────────────────────

/**
 * Load everything for the week containing `dateStr` and compute every active
 * student's status. Throws when a required read fails (mustData), so the
 * caller keeps its last good result instead of showing a wrong mark.
 *
 * @returns {Promise<{ mondayKey: string, byEmail: Map<string, WeekStatus> }>}
 */
export async function fetchWeeklySignupStatus({ dateStr } = {}) {
  const { monday, sunday } = weekRangeOf(dateStr)
  if (!monday) return { mondayKey: null, byEmail: new Map() }

  const [profRes, classRes, signupRes, closureOverlay] = await Promise.all([
    supabase.from('profiles')
      .select('email, role, classes')
      .eq('status', 'Active')
      .in('role', ['Student', 'Work Study']),
    supabase.from('classes')
      .select('class_id, course_id, required_hours, start_date, end_date, finals_start, finals_end, status')
      .eq('status', 'Active'),
    supabase.from('lab_signup')
      .select('user_email, class_id, date')
      .eq('status', 'Confirmed')
      .gte('date', monday)
      .lte('date', sunday + 'T23:59:59'),
    fetchClosureOverlay({ rangeStart: monday, rangeEnd: sunday }),
  ])

  const people = mustData(profRes, 'profiles.weekStatus') || []
  const classRows = mustData(classRes, 'classes.weekStatus') || []
  const signups = mustData(signupRes, 'lab_signup.weekStatus') || []

  // Make-up hours: index by this week's offerings so a make-up that lands
  // after a class has ended is dropped (same policy as Lab Signup).
  const classesById = {}
  classesForWeek(classRows, monday, sunday).forEach(c => {
    if (c.course_id) classesById[c.course_id] = c
    if (c.class_id) classesById[c.class_id] = c
  })
  const makeupOverlay = await fetchMakeupOverlay({ rangeStart: monday, rangeEnd: sunday, classesById })

  const byEmail = computeWeeklySignupStatus({ mondayKey: monday, people, classRows, signups, closureOverlay, makeupOverlay })
  return { mondayKey: monday, byEmail }
}
