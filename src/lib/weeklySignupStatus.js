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
 *   - ALL DONE (2026-09-21). An instructor's All Done swipe records that the
 *     student has completed the week's lab hours. It writes a zero-length
 *     time_clock row (entry_type = 'All Done') — the only record of it now the
 *     weekly tracker is retired — and CANCELS the student's remaining sign-ups
 *     for the week, which is exactly why they used to show as 0/8 short. Time
 *     Cards already treats one swipe as closing out every class for that
 *     Monday–Sunday week; this engine does the same: `allDone` is set, `met` is
 *     true for every class, and the UI says "All Done" instead of a count.
 *
 * Enrollment follows Lab Signup exactly: profiles.classes (the cache the
 * class_enrollments trigger maintains), matched to the Active class offering
 * whose start..end/finals window overlaps the week. Both course_id and
 * class_id formats are accepted everywhere (dual-format rule).
 *
 * SIGN-UP WINDOW
 *   Students can only change a week until 11:59 PM on the SUNDAY THAT STARTS
 *   IT (isDeadlinePassed() in useLabSignup.js — Lab Signup weeks are
 *   Sunday-anchored; this engine is Monday-anchored, so the deadline for the
 *   week of Monday M is M − 1 day, 23:59:59). The week you are IN is therefore
 *   always locked: a red X there can only be fixed by an approved
 *   post-deadline change request (lab_signup_requests) or by an instructor
 *   through Lab Signup → Admin Signup. A red X on a FUTURE week is still the
 *   student's to fix. `requestPending` marks a short student who has a
 *   Pending change request for that week — "short and waiting on me" rather
 *   than "short and doing nothing". It never changes `met`.
 *
 * Exports
 *   weekRangeOf(dateStr)                       → { monday, sunday }
 *   addWeeks(mondayKey, n)                     → mondayKey
 *   classesForWeek(classRows, monday, sunday)  → rows in session that week
 *   signupDeadlineFor(mondayKey)               → Date (local)
 *   describeSignupWindow(mondayKey, now)       → { locked, text, deadline }    (pure)
 *   requestWeekMonday(weekStart)               → mondayKey for a lab_signup_requests.week_start
 *   computeWeeklySignupStatus({...})           → Map<emailLower, WeekStatus>   (pure)
 *   summarizeWeek(byEmail)                     → { owing, short, pending, rows } (pure)
 *   formatHoursShort(n)                        → '8' | '6.4'
 *   formatWeekLabel(mondayKey)                 → 'Sep 21 – 27'
 *   describeWeekStatus(status)                 → { short, long }               (pure)
 *   formatDayShort('2026-09-22')               → 'Tue, Sep 22'
 *   fetchWeeklySignupStatuses({ mondays })     → Promise<Map<mondayKey, { mondayKey, byEmail }>>
 *   fetchWeeklySignupStatus({ dateStr })       → Promise<{ mondayKey, byEmail }>
 *   mergeSignupBlocks(rows)                    → [{ date, start, end, classId, hours, isMakeup }] (pure)
 *   fetchStudentWeek({ student, dateStr })     → Promise<{ mondayKey, status, blocks }>
 *                                                one student's week for Lab Signup → Admin Signup
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

/** Monday key n weeks after (or before) mondayKey. */
export function addWeeks(mondayKey, n) {
  const monday = mondayKeyOf(mondayKey)
  if (!monday) return null
  const d = new Date(monday + 'T00:00:00')
  d.setDate(d.getDate() + 7 * (Number(n) || 0))
  return toKey(d)
}

// ─── Sign-up window ───────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Last moment a student can change the week of `mondayKey` themselves:
 * 11:59:59 PM local on the Sunday before that Monday. Mirrors
 * isDeadlinePassed() in useLabSignup.js.
 */
export function signupDeadlineFor(mondayKey) {
  const monday = mondayKeyOf(mondayKey)
  if (!monday) return null
  const d = new Date(monday + 'T00:00:00')
  d.setDate(d.getDate() - 1)
  d.setHours(23, 59, 59, 999)
  return d
}

/** { locked, deadline, text } — text is ready to show, e.g. "Sign-up closed Sun, Sep 20". */
export function describeSignupWindow(mondayKey, now = new Date()) {
  const deadline = signupDeadlineFor(mondayKey)
  if (!deadline) return { locked: false, deadline: null, text: '' }
  const locked = now > deadline
  const day = `Sun, ${MONTHS[deadline.getMonth()]} ${deadline.getDate()}`
  return {
    locked, deadline,
    text: locked ? `Sign-up closed ${day}` : `Sign-up open until ${day}, 11:59 PM`,
  }
}

/** 'Sep 21 – 27' / 'Sep 28 – Oct 4' for the Mon–Sun week. */
export function formatWeekLabel(mondayKey) {
  const { monday, sunday } = weekRangeOf(mondayKey)
  if (!monday) return ''
  const a = new Date(monday + 'T00:00:00')
  const b = new Date(sunday + 'T00:00:00')
  const left = `${MONTHS[a.getMonth()]} ${a.getDate()}`
  const right = a.getMonth() === b.getMonth() ? `${b.getDate()}` : `${MONTHS[b.getMonth()]} ${b.getDate()}`
  return `${left} – ${right}`
}

/**
 * lab_signup_requests.week_start is the SUNDAY that starts the Lab Signup
 * week. That Sunday belongs to the Monday-week that FOLLOWS it here, so a
 * Sunday maps forward one day; any other day maps to its own Monday.
 */
export function requestWeekMonday(weekStart) {
  const key = dateOnly(weekStart)
  if (!key) return null
  const d = new Date(key + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  if (d.getDay() === 0) { d.setDate(d.getDate() + 1); return toKey(d) }
  return mondayKeyOf(key)
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
 * @property {string}  email      as stored on the profile
 * @property {string}  name       'First Last' (falls back to the email)
 * @property {boolean} requestPending  short AND has a Pending post-deadline change request for this week
 * @property {boolean} allDone     an instructor All Done swipe this week — hours complete regardless of sign-ups
 * @property {string}  allDoneDate 'YYYY-MM-DD' of the (first) swipe, '' when none
 * @property {Array<{courseId:string, classId:string, required:number, signed:number, met:boolean, makeup:number}>} perClass
 */

/**
 * Pure calculation. Nothing here touches the network.
 *
 * @param {Object}   p
 * @param {string}   p.mondayKey
 * @param {Array}    p.people          [{ email, classes, first_name?, last_name? }]  classes = profiles.classes string
 * @param {Array}    [p.pendingRequests] Pending lab_signup_requests rows [{ user_email, week_start }] (any week; filtered here)
 * @param {Array}    [p.allDoneRows]     time_clock rows with entry_type 'All Done' [{ user_email, punch_in }] (any week; filtered here)
 * @param {Array}    p.classRows       classes rows (any status/dates; filtered here)
 * @param {Array}    p.signups         Confirmed lab_signup rows for the week [{ user_email, class_id, date }]
 * @param {Object}   p.closureOverlay  from fetchClosureOverlay / buildClosureOverlay
 * @param {Object}   [p.makeupOverlay] from fetchMakeupOverlay
 * @returns {Map<string, WeekStatus>}  keyed by lowercased email
 */
export function computeWeeklySignupStatus({ mondayKey, people, classRows, signups, closureOverlay, makeupOverlay, pendingRequests, allDoneRows } = {}) {
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

  // Students with a Pending change request for THIS week
  const pendingEmails = new Set()
  ;(pendingRequests || []).forEach(r => {
    if (r.status && r.status !== 'Pending') return
    if (requestWeekMonday(r.week_start) !== monday) return
    const email = lower(r.user_email)
    if (email) pendingEmails.add(email)
  })

  // All Done swipes THIS week: email → date of the first one
  const allDoneBy = new Map()
  ;(allDoneRows || []).forEach(r => {
    if (r.entry_type && r.entry_type !== 'All Done') return
    const d = dateOnly(r.punch_in)
    if (!d || d < monday || d > sunday) return
    const email = lower(r.user_email)
    if (!email) return
    if (!allDoneBy.has(email) || d < allDoneBy.get(email)) allDoneBy.set(email, d)
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
    const allDoneDate = allDoneBy.get(email) || ''
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
        met: !!allDoneDate || signed >= required,
      }
    })

    const required = round2(perClass.reduce((s, c) => s + c.required, 0))
    const counted = round2(perClass.reduce((s, c) => s + Math.min(c.signed, c.required), 0))
    const signed = perClass.reduce((s, c) => s + c.signed, 0)
    const met = perClass.every(c => c.required <= 0 || c.met)
    const name = `${person.first_name || ''} ${person.last_name || ''}`.trim() || person.email
    out.set(email, {
      required, counted, signed, met, perClass,
      email: person.email, name,
      requestPending: !met && required > 0 && pendingEmails.has(email),
      allDone: !!allDoneDate,
      allDoneDate,
    })
  })

  return out
}

/**
 * Roll a week up for the "Short This Week" tiles and their list. Only people
 * who owe hours count. Rows: short first (furthest behind first), then met,
 * each group by name.
 *
 * @returns {{ owing:number, short:number, pending:number, rows:WeekStatus[] }}
 */
export function summarizeWeek(byEmail) {
  const rows = Array.from((byEmail || new Map()).values()).filter(s => s.required > 0)
  rows.sort((a, b) => {
    if (a.met !== b.met) return a.met ? 1 : -1
    if (!a.met) {
      const gap = (b.required - b.counted) - (a.required - a.counted)
      if (gap !== 0) return gap
    }
    return String(a.name || '').localeCompare(String(b.name || ''))
  })
  return {
    owing: rows.length,
    short: rows.filter(s => !s.met).length,
    pending: rows.filter(s => s.requestPending).length,
    allDone: rows.filter(s => s.allDone).length,
    rows,
  }
}

/**
 * Text for the UI. `short` is what shows beside the X ("6/8"); `long` is the
 * full sentence for screen readers / tooltip, naming the classes that are short.
 */
/** 'Tue, Sep 22' for a 'YYYY-MM-DD' key (local parse). */
export function formatDayShort(dateStr) {
  const key = dateOnly(dateStr)
  if (!key) return ''
  const d = new Date(key + 'T00:00:00')
  if (isNaN(d.getTime())) return key
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function describeWeekStatus(status) {
  if (!status || !(status.required > 0)) return { short: '', long: '' }
  if (status.allDone) {
    const before = status.counted > 0 ? ` ${formatHoursShort(status.counted)} of ${formatHoursShort(status.required)} hours were signed up before the swipe cancelled the rest.` : ''
    return {
      short: '',
      long: `All Done — an instructor confirmed the week's lab hours complete on ${formatDayShort(status.allDoneDate)}.${before}`,
    }
  }
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
    long: `Signed up for ${formatHoursShort(status.counted)} of ${formatHoursShort(status.required)} required lab hours this week. Short: ${shortClasses.join('; ')}.${status.requestPending ? ' A schedule change request is pending.' : ''}`,
  }
}

// ─── Data access ──────────────────────────────────────────────────────────────

/**
 * Load one or more weeks in one pass and compute every active student's
 * status for each. Profiles, classes, the closure overlay and the Pending
 * change requests are read ONCE and shared; sign-ups and make-up hours are
 * read per week (the viewed week can be far from this week, so one wide
 * range would drag in months of sign-ups).
 *
 * Throws when a required read fails (mustData), so the caller keeps its last
 * good result instead of showing a wrong mark.
 *
 * @param {Object}   p
 * @param {string[]} p.mondays   any dates; each is normalised to its Monday and de-duplicated
 * @returns {Promise<Map<string, { mondayKey: string, byEmail: Map<string, WeekStatus> }>>}
 */
export async function fetchWeeklySignupStatuses({ mondays } = {}) {
  const weeks = [...new Set((mondays || []).map(m => mondayKeyOf(m)).filter(Boolean))].sort()
  const out = new Map()
  if (weeks.length === 0) return out

  const first = weeks[0]
  const lastSunday = weekRangeOf(weeks[weeks.length - 1]).sunday

  const [profRes, allDoneRes, classRes, reqRes, closureOverlay] = await Promise.all([
    supabase.from('profiles')
      .select('email, first_name, last_name, role, classes')
      .eq('status', 'Active')
      .in('role', ['Student', 'Work Study']),
    // All Done markers across the whole span — one small read shared by every
    // week (punch_in is fake-UTC, so the date prefix is the local day)
    supabase.from('time_clock')
      .select('user_email, punch_in')
      .eq('entry_type', 'All Done')
      .gte('punch_in', first + 'T00:00:00')
      .lte('punch_in', lastSunday + 'T23:59:59'),
    supabase.from('classes')
      .select('class_id, course_id, required_hours, start_date, end_date, finals_start, finals_end, status')
      .eq('status', 'Active'),
    // Pending only — a handful of rows at most (the notification bell reads the same set)
    supabase.from('lab_signup_requests')
      .select('user_email, week_start, status')
      .eq('status', 'Pending'),
    // Closed days only, so a wide range is still a tiny read
    fetchClosureOverlay({ rangeStart: first, rangeEnd: lastSunday }),
  ])

  const people = mustData(profRes, 'profiles.weekStatus') || []
  const classRows = mustData(classRes, 'classes.weekStatus') || []
  // An All Done that isn't seen turns a done student into a red X — a wrong
  // mark in the direction that causes a chase — so this read is required.
  const allDoneRows = mustData(allDoneRes, 'time_clock.allDone') || []
  // The pending tag is a decoration on top of the marks: if this read fails
  // the marks and counts are still right, so log it and carry on without tags
  // rather than throwing away the whole result.
  let pendingRequests = []
  if (reqRes.error) console.warn('weeklySignupStatus: pending change requests unavailable:', reqRes.error.message)
  else pendingRequests = reqRes.data || []

  await Promise.all(weeks.map(async (monday) => {
    const { sunday } = weekRangeOf(monday)

    // Make-up hours: index by this week's offerings so a make-up that lands
    // after a class has ended is dropped (same policy as Lab Signup).
    const classesById = {}
    classesForWeek(classRows, monday, sunday).forEach(c => {
      if (c.course_id) classesById[c.course_id] = c
      if (c.class_id) classesById[c.class_id] = c
    })

    const [signupRes, makeupOverlay] = await Promise.all([
      supabase.from('lab_signup')
        .select('user_email, class_id, date')
        .eq('status', 'Confirmed')
        .gte('date', monday)
        .lte('date', sunday + 'T23:59:59'),
      fetchMakeupOverlay({ rangeStart: monday, rangeEnd: sunday, classesById }),
    ])
    const signups = mustData(signupRes, 'lab_signup.weekStatus') || []

    out.set(monday, {
      mondayKey: monday,
      byEmail: computeWeeklySignupStatus({ mondayKey: monday, people, classRows, signups, closureOverlay, makeupOverlay, pendingRequests, allDoneRows }),
    })
  }))

  return out
}

/** Single-week convenience wrapper (week containing `dateStr`). */
export async function fetchWeeklySignupStatus({ dateStr } = {}) {
  const { monday } = weekRangeOf(dateStr)
  if (!monday) return { mondayKey: null, byEmail: new Map() }
  const all = await fetchWeeklySignupStatuses({ mondays: [monday] })
  return all.get(monday) || { mondayKey: monday, byEmail: new Map() }
}

// ─── One student's week (Lab Signup → Admin Signup) ───────────────────────────

function hhmm(t) { return String(t || '').substring(0, 5) }

/**
 * Collapse one-hour lab_signup rows into readable blocks: back-to-back hours
 * on the same day for the same class become one line (8:00–11:00, 3 hours).
 * A change of class or a gap starts a new block. Pure.
 *
 * Each block keeps its individual hours in `slots` (with the signup_id), so
 * Admin Signup can remove or re-class single hours out of a merged block.
 *
 * @param {Array} rows [{ signup_id, date, start_time, end_time, class_id, is_makeup }]
 * @returns {Array<{ date:string, start:string, end:string, classId:string, hours:number, isMakeup:boolean,
 *                   slots:Array<{ id:string, date:string, start:string, end:string, classId:string, isMakeup:boolean }> }>}
 */
export function mergeSignupBlocks(rows) {
  const sorted = (rows || [])
    .map(r => ({ id: r.signup_id || '', date: dateOnly(r.date), start: hhmm(r.start_time), end: hhmm(r.end_time), classId: String(r.class_id || '').trim(), isMakeup: !!r.is_makeup }))
    .filter(r => r.date && r.start)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
  const out = []
  sorted.forEach(r => {
    const last = out[out.length - 1]
    const slot = { id: r.id, date: r.date, start: r.start, end: r.end, classId: r.classId, isMakeup: r.isMakeup }
    if (last && last.date === r.date && last.classId === r.classId && last.end === r.start && last.isMakeup === r.isMakeup) {
      last.end = r.end
      last.hours += 1
      last.slots.push(slot)
    } else {
      out.push({ date: r.date, start: r.start, end: r.end, classId: r.classId, isMakeup: r.isMakeup, hours: 1, slots: [slot] })
    }
  })
  return out
}

/**
 * Everything Admin Signup needs to show a student's week: the same WeekStatus
 * the Dashboard uses (so 6/8 here is 6/8 there) plus their sign-ups as blocks.
 * Works for ANY person in the Admin Signup picker — it takes the profile row's
 * email + classes directly rather than re-filtering profiles by role.
 *
 * Throws when a required read fails; the pending-request read is soft, as in
 * fetchWeeklySignupStatuses().
 *
 * @param {Object} p
 * @param {{ email:string, classes:string, firstName?:string, lastName?:string }} p.student
 * @param {string} p.dateStr  any date in the week
 */
export async function fetchStudentWeek({ student, dateStr } = {}) {
  const { monday, sunday } = weekRangeOf(dateStr)
  const email = String(student?.email || '').trim()
  if (!monday || !email) return { mondayKey: monday || null, status: null, blocks: [] }

  const [classRes, signupRes, reqRes, allDoneRes, closureOverlay] = await Promise.all([
    supabase.from('classes')
      .select('class_id, course_id, required_hours, start_date, end_date, finals_start, finals_end, status')
      .eq('status', 'Active'),
    supabase.from('lab_signup')
      .select('signup_id, user_email, class_id, date, start_time, end_time, is_makeup')
      .eq('status', 'Confirmed')
      .ilike('user_email', email)
      .gte('date', monday)
      .lte('date', sunday + 'T23:59:59'),
    supabase.from('lab_signup_requests')
      .select('user_email, week_start, status')
      .eq('status', 'Pending')
      .ilike('user_email', email),
    supabase.from('time_clock')
      .select('user_email, punch_in')
      .eq('entry_type', 'All Done')
      .ilike('user_email', email)
      .gte('punch_in', monday + 'T00:00:00')
      .lte('punch_in', sunday + 'T23:59:59'),
    fetchClosureOverlay({ rangeStart: monday, rangeEnd: sunday }),
  ])
  const classRows = mustData(classRes, 'classes.studentWeek') || []
  // ilike is only there for case-insensitivity; "_" and "%" in an address are
  // wildcards to it, so pin the result to the exact address afterwards.
  const mine = r => lower(r.user_email) === lower(email)
  const signups = (mustData(signupRes, 'lab_signup.studentWeek') || []).filter(mine)
  const allDoneRows = (mustData(allDoneRes, 'time_clock.studentWeek') || []).filter(mine)
  let pendingRequests = []
  if (reqRes.error) console.warn('weeklySignupStatus: pending change requests unavailable:', reqRes.error.message)
  else pendingRequests = (reqRes.data || []).filter(mine)

  const classesById = {}
  classesForWeek(classRows, monday, sunday).forEach(c => {
    if (c.course_id) classesById[c.course_id] = c
    if (c.class_id) classesById[c.class_id] = c
  })
  const makeupOverlay = await fetchMakeupOverlay({ emails: [email], rangeStart: monday, rangeEnd: sunday, classesById })

  const person = { email, classes: student.classes || '', first_name: student.firstName || student.first_name || '', last_name: student.lastName || student.last_name || '' }
  const byEmail = computeWeeklySignupStatus({ mondayKey: monday, people: [person], classRows, signups, closureOverlay, makeupOverlay, pendingRequests, allDoneRows })
  return { mondayKey: monday, status: byEmail.get(lower(email)) || null, blocks: mergeSignupBlocks(signups) }
}
