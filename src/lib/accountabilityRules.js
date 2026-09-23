/**
 * RICT CMMS — Accountability Report rules (pure)
 *
 * Every check the Accountability Report makes lives here as a plain function
 * of data already in hand. Nothing in this file touches the network or React,
 * so each rule can be reasoned about (and unit-checked) on its own, and other
 * pages can reuse a rule without inheriting the page.
 *
 * The 37 checks (numbers match the checklist Aaron approved on 2026-09-21):
 *
 *   A. Lab sign-ups            1 week short · 2 missed sign-up deadline ·
 *                              3 post-deadline changes · 4 late cancellations ·
 *                              5 cancelled and left short · 6 no-shows ·
 *                              7 change request pending (info)
 *   B. Time clock              8 late · 9 left early (unexcused) ·
 *                              10 left early (excused, info) · 11 walk-ins ·
 *                              12 wrong class · 13 forgot to punch out ·
 *                              14 short day (punched < booked) ·
 *                              15 time-entry requests · 16 All Done vs hours (info)
 *   C. Absences / late work    17 absence requests · 18 filed after the fact ·
 *                              19 make-up not completed · 20 late submissions ·
 *                              21 late work past due · 22 deductions (info)
 *   D. Work orders             23 own WOs late · 24 team WOs late · 25 stale WOs ·
 *                              26 assigned with no work log · 27 WOC score (info)
 *   E. Equipment               28 overdue checkouts · 29 damaged / lost ·
 *                              30 never acknowledged
 *   F. Program                 31 volunteer standing · 32 holds ·
 *                              33 reminders not acknowledged · 34 absence notes (info) ·
 *                              38 help requests — wait for a response / time to cleared (info)
 *   G. Summary                 35 scores (info) · 36 total · 37 trend
 *
 * "Infraction count" (decision 2026-09-21): a plain count of events. Every
 * check marked `counts: true` contributes its `count` to the total; info rows
 * never do. Each check also carries a `severity` so the table can show it
 * beside the number (never colour alone).
 *
 * Conventions honored
 *   - Fake-UTC columns (lab_signup.date/start_time/created_at/cancelled_at,
 *     time_clock.punch_in/punch_out, asset_checkouts.*, absence_requests.
 *     created_at) are compared in "fake-UTC milliseconds": new Date(ts).getTime()
 *     of the stored value, against Date.UTC(local wall-clock parts). Never
 *     toISOString(), never toLocale*() on these.
 *   - Real-UTC columns (time_entry_requests, lab_signup_requests,
 *     reminder_acknowledgements, audit_log) are ordinary timestamps.
 *   - Date-only strings parse with 'T00:00:00'.
 *
 * File: src/lib/accountabilityRules.js
 */

import { mondayKeyOf } from '@/lib/closureProration'
import { requestWeekMonday, weekRangeOf } from '@/lib/weeklySignupStatus'
import { workDueState, ordinal, makeupWeekOf } from '@/hooks/useAbsenceRequests'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Reminder acknowledgements were not stored before this date; weeks before it are never flagged. */
export const ACK_TRACKING_START = '2026-09-22'

export const DEFAULT_LATE_CANCEL_HOURS = 24
export const DEFAULT_TREND_WEEKS = 3
export const DEFAULT_GRACE_MINUTES = 10

/** Sections in display order. */
export const SECTIONS = [
  { key: 'signups',    label: 'Lab sign-ups' },
  { key: 'timeclock',  label: 'Time clock' },
  { key: 'absences',   label: 'Absences & late work' },
  { key: 'workorders', label: 'Work orders' },
  { key: 'equipment',  label: 'Equipment' },
  { key: 'program',    label: 'Program' },
]

export const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }

// ─── Small helpers (exported for the page / hook) ────────────────────────────

export function lower(s) { return String(s || '').toLowerCase().trim() }
export function dateOnly(v) { return v ? String(v).substring(0, 10) : '' }
export function pad2(n) { return String(n).padStart(2, '0') }
export function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

/** Local calendar date 'YYYY-MM-DD' of a Date (never toISOString). */
export function toDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * Parse a stored timestamp defensively. PostgREST returns '…T09:05:00+00:00',
 * but rows written by localToUtcIso() carry a bare '+00' and some exports use
 * a space instead of 'T' — both are Invalid Date to V8 unless normalised.
 */
export function parseTs(ts) {
  if (!ts) return null
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts
  let s = String(ts).trim()
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T')
  if (/[+-]\d{2}$/.test(s)) s += ':00'
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** Fake-UTC ms of a stored fake-UTC timestamp (or null). */
export function fakeUtcMs(ts) {
  const d = parseTs(ts)
  return d ? d.getTime() : null
}

/** Fake-UTC ms for a local wall-clock Date (default: now). */
export function nowFakeUtcMs(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds())
}

/** Fake-UTC ms for 'YYYY-MM-DD' + 'HH:MM[:SS]'. */
export function slotMs(dateStr, timeStr) {
  const d = dateOnly(dateStr)
  if (!d) return null
  const [y, m, day] = d.split('-').map(Number)
  const [hh = 0, mm = 0, ss = 0] = String(timeStr || '00:00').split(':').map(Number)
  return Date.UTC(y, m - 1, day, hh, mm, ss)
}

/** 'HH:MM:SS' → minutes since midnight (null on blank). */
export function timeToMinutes(t) {
  if (!t) return null
  const p = String(t).split(':')
  return parseInt(p[0], 10) * 60 + parseInt(p[1] || '0', 10)
}

/** Local date key of a fake-UTC timestamp — its UTC calendar day IS the local day. */
export function fakeUtcDateKey(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** Minutes since midnight of a fake-UTC timestamp. */
export function fakeUtcMinutes(ts) {
  const d = parseTs(ts)
  if (!d) return null
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** 'HH:MM' from minutes since midnight, 12-hour. */
export function fmtMinutes(min) {
  if (min === null || min === undefined || isNaN(min)) return ''
  const h = Math.floor(min / 60), m = min % 60
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`
}

/** Fake-UTC timestamp → 'Sep 21, 3:05 PM' (reads UTC parts on purpose). */
export function fmtFakeUtc(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  return `${mo} ${d.getUTCDate()}, ${fmtMinutes(d.getUTCHours() * 60 + d.getUTCMinutes())}`
}

/** 'YYYY-MM-DD' → 'Mon, Sep 21'. */
export function fmtDay(dateStr) {
  const k = dateOnly(dateStr)
  if (!k) return ''
  const d = new Date(k + 'T00:00:00')
  if (isNaN(d.getTime())) return k
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** 'YYYY-MM-DD' → 'Sep 21, 2026'. */
export function fmtDate(dateStr) {
  const k = dateOnly(dateStr)
  if (!k) return ''
  const d = new Date(k + 'T00:00:00')
  if (isNaN(d.getTime())) return k
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtHours(h) {
  const n = round2(h)
  return Number.isInteger(n) ? String(n) : String(n)
}

/** Every Monday key from the week containing `start` through the week containing `end`. */
export function mondaysBetween(start, end) {
  const first = mondayKeyOf(dateOnly(start))
  const last = mondayKeyOf(dateOnly(end))
  const out = []
  if (!first || !last) return out
  const d = new Date(first + 'T00:00:00')
  while (toDateKey(d) <= last) {
    out.push(toDateKey(d))
    d.setDate(d.getDate() + 7)
  }
  return out
}

/**
 * Sign-up deadline for the Monday-week `mondayKey`, in fake-UTC ms:
 * 11:59:59 PM on the Sunday before (isDeadlinePassed() in useLabSignup.js).
 */
export function signupDeadlineMs(mondayKey) {
  const m = mondayKeyOf(mondayKey)
  if (!m) return null
  const [y, mo, d] = m.split('-').map(Number)
  return Date.UTC(y, mo - 1, d - 1, 23, 59, 59)
}

/** Does this class belong to the selected term? (term_id, semester name, or date overlap). */
export function classInTerm(cls, term) {
  if (!cls || !term) return false
  if (cls.term_id && term.term_id && cls.term_id === term.term_id) return true
  if (cls.semester && term.name && lower(cls.semester) === lower(term.name)) return true
  const s = dateOnly(cls.start_date), e = dateOnly(cls.end_date) || dateOnly(cls.finals_end)
  const tb = dateOnly(term.begin_date), te = dateOnly(term.end_date)
  if (!s || !tb || !te) return false
  return s <= te && (!e || e >= tb)
}

/** Dual-format enrollment test (profiles.classes may hold course_id or class_id). */
export function enrolledIn(cls, enrolledIds) {
  return enrolledIds.includes(cls.class_id) || enrolledIds.includes(cls.course_id)
}

/** Every id a signup / punch may carry for this class. */
function classIds(cls) {
  return [...new Set([cls.class_id, cls.course_id].filter(Boolean))]
}

function makeCheck(def, items, extra = {}) {
  const list = items || []
  return {
    ...def,
    count: extra.count !== undefined ? extra.count : list.length,
    items: list,
    ...extra,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION A — LAB SIGN-UPS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 1. Weeks short on sign-ups (past and current weeks only).
 * `weekStatuses`: Map<mondayKey, WeekStatus> from computeWeeklySignupStatus.
 */
export function checkWeeksShort({ weekStatuses, today }) {
  const items = []
  for (const [monday, st] of weekStatuses || []) {
    if (!st || !(st.required > 0)) continue
    if (monday > today) continue                 // future weeks are still the student's to fix
    if (st.met || st.allDone) continue
    const shortClasses = (st.perClass || []).filter(c => c.required > 0 && !c.met)
      .map(c => `${c.courseId || c.classId} ${fmtHours(Math.min(c.signed, c.required))}/${fmtHours(c.required)}`)
    items.push({
      date: monday, week: monday,
      label: `Week of ${fmtDate(monday)} — ${fmtHours(st.counted)} of ${fmtHours(st.required)} hours signed up`,
      detail: `Short: ${shortClasses.join('; ')}${st.requestPending ? ' (change request pending)' : ''}`,
      hours: round2(st.required - st.counted),
    })
  }
  return makeCheck({ id: 'weekShort', num: 1, section: 'signups', label: 'Weeks short on sign-ups', severity: 'high', counts: true,
    help: 'Booked fewer lab hours than required for the week, per class (extra hours under one class never cover another). All Done weeks are excluded.' }, items)
}

/**
 * 2. Missed the sign-up deadline: hours on the books at 11:59 PM Sunday were
 * short of the week's requirement. Counts Confirmed rows created by the
 * deadline plus Cancelled rows that were still Confirmed at the deadline.
 */
export function checkDeadlineMissed({ weekStatuses, signups, today, enrolledClasses }) {
  const items = []
  const byWeek = new Map()
  for (const s of signups || []) {
    const m = mondayKeyOf(dateOnly(s.date))
    if (!m) continue
    if (!byWeek.has(m)) byWeek.set(m, [])
    byWeek.get(m).push(s)
  }
  for (const [monday, st] of weekStatuses || []) {
    if (!st || !(st.required > 0) || monday > today) continue
    const deadline = signupDeadlineMs(monday)
    if (deadline === null) continue
    const rows = byWeek.get(monday) || []
    // per class: hours on the books at the deadline (each row = 1 hour)
    const onBooksByClass = new Map()
    for (const r of rows) {
      const created = fakeUtcMs(r.created_at)
      if (created === null || created > deadline) continue
      if (r.status === 'Cancelled') {
        const cAt = fakeUtcMs(r.cancelled_at)
        if (cAt !== null && cAt <= deadline) continue      // cancelled before the deadline — never counted
        // cancelled after the deadline (or unknown when) → it WAS on the books
      } else if (r.status !== 'Confirmed') continue
      const id = String(r.class_id || '').trim()
      onBooksByClass.set(id, (onBooksByClass.get(id) || 0) + 1)
    }
    const shortAt = []
    let onBooks = 0
    for (const c of st.perClass || []) {
      if (!(c.required > 0)) continue
      const ids = [...new Set([c.courseId, c.classId].filter(Boolean))]
      const had = ids.reduce((sum, id) => sum + (onBooksByClass.get(id) || 0), 0)
      onBooks += Math.min(had, c.required)
      if (had < c.required) shortAt.push(`${c.courseId || c.classId} ${fmtHours(had)}/${fmtHours(c.required)}`)
    }
    if (shortAt.length === 0) continue
    // A student who was enrolled after the deadline can't be blamed for it
    const enrolledLate = (enrolledClasses || []).some(c => dateOnly(c.enrolled_at) && dateOnly(c.enrolled_at) > monday)
    items.push({
      date: monday, week: monday,
      label: `Week of ${fmtDate(monday)} — ${fmtHours(onBooks)} of ${fmtHours(st.required)} hours booked by the Sunday deadline`,
      detail: `${onBooks === 0 ? 'Nothing was signed up by the deadline. ' : ''}Short at deadline: ${shortAt.join('; ')}${enrolledLate ? ' (enrolled after this week started)' : ''}${st.allDone ? ' — week later closed by All Done' : ''}`,
      none: onBooks === 0,
    })
  }
  return makeCheck({ id: 'deadlineMissed', num: 2, section: 'signups', label: 'Missed the Sunday sign-up deadline', severity: 'medium', counts: true,
    help: 'Hours on the books at 11:59 PM Sunday were short of the week’s requirement, even if fixed later.' }, items)
}

/** 3. Post-deadline change requests (lab_signup_requests): approved, rejected, pending. */
export function checkPostDeadlineChanges({ signupRequests }) {
  const items = (signupRequests || [])
    .filter(r => r.status === 'Approved' || r.status === 'Rejected')
    .map(r => {
      const week = requestWeekMonday(r.week_start) || dateOnly(r.week_start)
      return {
        date: dateOnly(r.submitted_date) || week, week,
        label: `${r.status} — week of ${fmtDate(week)}${r.course_id || r.class_id ? ` (${r.course_id || r.class_id})` : ''}`,
        detail: `${r.reason ? `Reason: ${r.reason}. ` : ''}Submitted ${fmtDate(r.submitted_date)}${r.reviewed_by ? `, reviewed by ${r.reviewed_by}` : ''}.`,
        status: r.status,
      }
    })
  const approved = items.filter(i => i.status === 'Approved').length
  const rejected = items.length - approved
  return makeCheck({ id: 'postDeadlineChanges', num: 3, section: 'signups', label: 'Sign-up changes after the deadline', severity: 'low', counts: true,
    help: 'Change requests submitted after the Sunday deadline (approved or rejected). Pending ones are listed under #7.',
    summary: items.length ? `${approved} approved, ${rejected} rejected` : '' }, items)
}

/** 4. Late cancellations: the student cancelled inside `lateCancelHours` of the slot start (or after it). */
export function checkLateCancels({ signups, studentEmail, lateCancelHours }) {
  const hrs = Number(lateCancelHours) > 0 ? Number(lateCancelHours) : DEFAULT_LATE_CANCEL_HOURS
  const me = lower(studentEmail)
  const items = []
  for (const r of signups || []) {
    if (r.status !== 'Cancelled') continue
    if (lower(r.cancelled_by_email) !== me) continue     // instructor / closure cancels are not the student's
    const cAt = fakeUtcMs(r.cancelled_at)
    const start = slotMs(r.date, r.start_time)
    if (cAt === null || start === null) continue
    const leadHours = (start - cAt) / 3600000
    if (leadHours > hrs) continue
    const d = dateOnly(r.date)
    items.push({
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} ${fmtMinutes(timeToMinutes(r.start_time))}${r.class_id ? ` (${r.class_id})` : ''}`,
      detail: leadHours < 0
        ? `Cancelled ${fmtFakeUtc(r.cancelled_at)} — after the slot had already started.`
        : `Cancelled ${fmtFakeUtc(r.cancelled_at)} — ${leadHours < 1 ? `${Math.round(leadHours * 60)} minutes` : `${round2(leadHours)} hours`} before the slot (limit ${hrs}h).`,
      leadHours: round2(leadHours),
    })
  }
  return makeCheck({ id: 'lateCancels', num: 4, section: 'signups', label: `Late cancellations (inside ${hrs}h)`, severity: 'medium', counts: true,
    help: 'Sign-ups the student cancelled within the late-cancel window before the slot started. Cancels made by an instructor or a lab closure are not counted.' }, items)
}

/** 5. Cancelled hours that were never rebooked — the week ended short. */
export function checkCancelledLeftShort({ signups, weekStatuses, studentEmail, today }) {
  const me = lower(studentEmail)
  const cancelledByWeek = new Map()
  for (const r of signups || []) {
    if (r.status !== 'Cancelled' || lower(r.cancelled_by_email) !== me) continue
    const m = mondayKeyOf(dateOnly(r.date))
    if (!m) continue
    cancelledByWeek.set(m, (cancelledByWeek.get(m) || 0) + 1)
  }
  const items = []
  for (const [monday, n] of cancelledByWeek) {
    const st = weekStatuses?.get(monday)
    if (!st || !(st.required > 0) || monday > today) continue
    if (st.met || st.allDone) continue
    items.push({
      date: monday, week: monday,
      label: `Week of ${fmtDate(monday)} — cancelled ${n} hour${n === 1 ? '' : 's'}, ended ${fmtHours(st.counted)}/${fmtHours(st.required)}`,
      detail: 'Hours were cancelled and not booked again, leaving the week short.',
      hours: n,
    })
  }
  return makeCheck({ id: 'cancelledLeftShort', num: 5, section: 'signups', label: 'Cancelled and never rebooked', severity: 'medium', counts: true,
    help: 'Weeks where the student cancelled hours and the week still ended short (overlaps with #1 by design — it names the cause).' }, items)
}

/**
 * 6. No-shows: a Confirmed sign-up on a past day with no punch overlapping it.
 * Excused when the week has an All Done swipe, the date has an approved
 * absence, or the lab was closed that day. One item per day per class.
 */
export function checkNoShows({ signups, timeClock, absences, closureOverlay, weekStatuses, today }) {
  const punches = (timeClock || []).filter(r => r.entry_type !== 'Volunteer' && r.entry_type !== 'Club Activity' && r.entry_type !== 'All Done' && r.status !== 'No Show')
  const byDay = new Map()
  for (const p of punches) {
    const d = fakeUtcDateKey(p.punch_in)
    if (!d) continue
    const inMin = fakeUtcMinutes(p.punch_in)
    const outMin = p.punch_out ? fakeUtcMinutes(p.punch_out) : (p.status === 'Punched In' ? 24 * 60 : inMin)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push({ inMin, outMin: Math.max(outMin ?? 0, inMin ?? 0) })
  }
  const excusedDates = new Set((absences || [])
    .filter(a => a.status === 'Approved' && a.request_type !== 'Late Submission' && dateOnly(a.absence_date))
    .map(a => dateOnly(a.absence_date)))
  const closed = closureOverlay?.closedDates instanceof Set ? closureOverlay.closedDates : new Set()

  const grouped = new Map()   // `${date}|${class}` → { date, classId, slots: [] }
  for (const s of signups || []) {
    if (s.status !== 'Confirmed') continue
    const d = dateOnly(s.date)
    if (!d || d >= today) continue                       // only days that are over
    if (excusedDates.has(d) || closed.has(d)) continue
    const monday = mondayKeyOf(d)
    const st = weekStatuses?.get(monday)
    if (st?.allDone && st.allDoneDate && d >= st.allDoneDate) continue   // swipe cancelled the rest of the week
    const sMin = timeToMinutes(s.start_time), eMin = timeToMinutes(s.end_time)
    if (sMin === null || eMin === null) continue
    const attended = (byDay.get(d) || []).some(p => p.inMin !== null && p.inMin < eMin && p.outMin > sMin)
    if (attended) continue
    const key = `${d}|${s.class_id || ''}`
    if (!grouped.has(key)) grouped.set(key, { date: d, classId: s.class_id || '', slots: [] })
    grouped.get(key).slots.push({ sMin, eMin })
  }
  const items = [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date)).map(g => {
    const sorted = g.slots.sort((a, b) => a.sMin - b.sMin)
    const first = sorted[0].sMin, last = sorted[sorted.length - 1].eMin
    const hours = sorted.length
    return {
      date: g.date, week: mondayKeyOf(g.date),
      label: `${fmtDay(g.date)} ${fmtMinutes(first)}–${fmtMinutes(last)}${g.classId ? ` (${g.classId})` : ''}`,
      detail: `Signed up for ${hours} hour${hours === 1 ? '' : 's'}; no punch overlapped the slot${(byDay.get(g.date) || []).length ? ' (punches that day fell outside it)' : ''}.`,
      hours,
    }
  })
  return makeCheck({ id: 'noShows', num: 6, section: 'signups', label: 'No-shows', severity: 'high', counts: true,
    help: 'A confirmed sign-up on a day that has passed with no time-clock punch overlapping it. Excused: approved absence for that date, lab closed that day, or an All Done swipe that week.' }, items)
}

/** 7. Pending sign-up change requests (info — explains a short week). */
export function checkPendingRequests({ signupRequests }) {
  const items = (signupRequests || []).filter(r => r.status === 'Pending').map(r => {
    const week = requestWeekMonday(r.week_start) || dateOnly(r.week_start)
    return {
      date: dateOnly(r.submitted_date) || week, week,
      label: `Week of ${fmtDate(week)}${r.course_id || r.class_id ? ` (${r.course_id || r.class_id})` : ''}`,
      detail: `Submitted ${fmtDate(r.submitted_date)}${r.reason ? ` — ${r.reason}` : ''}. Waiting for instructor review.`,
    }
  })
  return makeCheck({ id: 'pendingRequests', num: 7, section: 'signups', label: 'Change requests waiting on review', severity: 'info', counts: false,
    help: 'Not the student’s fault — a short week may be waiting on you.' }, items)
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION B — TIME CLOCK
// ═════════════════════════════════════════════════════════════════════════════

/** Flattened, flagged entries from generateUserReport (every class). */
function flaggedEntries(userReport) {
  const out = []
  for (const cr of userReport?.classReports || []) {
    for (const e of cr.entries || []) out.push({ ...e, _course: cr.courseId })
  }
  return out
}

function entryDate(e) { return fakeUtcDateKey(e.punch_in) }

/** 8. Late arrivals. */
export function checkLate({ userReport }) {
  const items = flaggedEntries(userReport).filter(e => e.flags?.isLate).map(e => {
    const d = entryDate(e)
    return {
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} — punched in ${fmtMinutes(fakeUtcMinutes(e.punch_in))}, scheduled ${fmtMinutes(e.flags.scheduledStart)} (${e._course})`,
      detail: `${e.flags.lateMinutes} minutes late (after the ${userReport.gracePeriod}-minute grace period).`,
      minutes: e.flags.lateMinutes,
    }
  })
  const total = items.reduce((s, i) => s + i.minutes, 0)
  return makeCheck({ id: 'late', num: 8, section: 'timeclock', label: 'Late arrivals', severity: 'medium', counts: true,
    help: 'First punch of the day after the sign-up start plus the grace period.',
    summary: items.length ? `${total} minutes total` : '' }, items)
}

/** 9. Left early without approval (unexcused, whether or not the score waived it). */
export function checkLeftEarly({ userReport }) {
  const items = flaggedEntries(userReport).filter(e => e.flags?.isEarlyDeparture && !e.flags.isEarlyApproved).map(e => {
    const d = entryDate(e)
    return {
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} — punched out ${fmtMinutes(fakeUtcMinutes(e.punch_out))}, scheduled until ${fmtMinutes(e.flags.scheduledEnd)} (${e._course})`,
      detail: `${e.flags.earlyMinutes} minutes early${e.flags.isEarlyWaived ? ' (hours for the week were met, so no score deduction)' : ''}.`,
      minutes: e.flags.earlyMinutes,
    }
  })
  return makeCheck({ id: 'leftEarly', num: 9, section: 'timeclock', label: 'Left early (unexcused)', severity: 'medium', counts: true,
    help: 'Last punch-out of the day before the sign-up end minus the grace period, with no instructor approval.' }, items)
}

/** 10. Left early WITH instructor approval (info). Reads the raw rows so approved rows that the score exempts still appear. */
export function checkLeftEarlyApproved({ timeClock }) {
  const items = (timeClock || []).filter(r => r.early_departure_approved_by).map(r => {
    const d = fakeUtcDateKey(r.punch_in)
    return {
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} — out ${fmtMinutes(fakeUtcMinutes(r.punch_out))} (${r.course_id || r.class_id || ''})`,
      detail: `Approved by ${r.early_departure_approved_by}.`,
    }
  })
  return makeCheck({ id: 'leftEarlyApproved', num: 10, section: 'timeclock', label: 'Left early (excused)', severity: 'info', counts: false,
    help: 'Listed so a pattern is visible even when each one was excused.' }, items)
}

/** 11. Walk-ins: punched in on a day with no sign-up. */
export function checkWalkIns({ userReport }) {
  const seen = new Set()
  const items = []
  for (const e of flaggedEntries(userReport)) {
    if (!e.flags?.isWalkIn) continue
    if (e.entry_type === 'Work Study' || e.entry_type === 'Volunteer' || e.entry_type === 'Club Activity') continue
    const d = entryDate(e)
    const key = `${d}|${e._course}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} — ${fmtMinutes(fakeUtcMinutes(e.punch_in))}${e.punch_out ? `–${fmtMinutes(fakeUtcMinutes(e.punch_out))}` : ''} (${e._course})`,
      detail: 'Punched in with no lab sign-up that day.',
    })
  }
  return makeCheck({ id: 'walkIns', num: 11, section: 'timeclock', label: 'Walk-ins (no sign-up)', severity: 'low', counts: true,
    help: 'Time was logged on a day with no sign-up. Work Study, volunteer and club punches are not counted.' }, items)
}

/** 12. Wrong class: punched under a class other than the one signed up for. */
export function checkWrongClass({ userReport }) {
  const items = flaggedEntries(userReport).filter(e => e.flags?.isWrongClass).map(e => {
    const d = entryDate(e)
    return {
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} — punched as ${e._course}, signed up for ${e.flags.wrongClassExpected}`,
      detail: 'Hours landed under the wrong class.',
    }
  })
  return makeCheck({ id: 'wrongClass', num: 12, section: 'timeclock', label: 'Punched into the wrong class', severity: 'low', counts: true,
    help: 'A sign-up slot existed for that time, but for a different class.' }, items)
}

/**
 * 13. Forgot to punch out: an instructor closed the entry (closed_by_email —
 * stamped from 2026-09-22), or the punch-out landed on a later day than the
 * punch-in (history heuristic), or the entry is still open on a prior day.
 */
export function checkForgotPunchOut({ timeClock, today }) {
  const items = []
  for (const r of (timeClock || [])) {
    if (r.entry_type === 'All Done') continue
    const inDay = fakeUtcDateKey(r.punch_in)
    if (!inDay) continue
    const outDay = fakeUtcDateKey(r.punch_out)
    let why = ''
    if (r.closed_by_email) why = `Closed by ${r.closed_by_email}${r.closed_reason ? ` (${String(r.closed_reason).replace(/_/g, ' ')})` : ''}.`
    else if (r.status === 'Punched In' && inDay < today) why = 'Still punched in from a previous day.'
    else if (outDay && outDay > inDay) why = `Punched out ${fmtFakeUtc(r.punch_out)} — a later day than the punch-in.`
    if (!why) continue
    items.push({
      date: inDay, week: mondayKeyOf(inDay),
      label: `${fmtDay(inDay)} — in ${fmtMinutes(fakeUtcMinutes(r.punch_in))} (${r.course_id || r.class_id || ''})`,
      detail: why,
    })
  }
  return makeCheck({ id: 'forgotPunchOut', num: 13, section: 'timeclock', label: 'Forgot to punch out', severity: 'low', counts: true,
    help: 'An instructor had to close the entry, it is still open from an earlier day, or the punch-out landed on a later day.' }, items)
}

/**
 * 14. Short days: on days with a sign-up where the student DID show, punched
 * hours fell short of booked hours by more than the grace period.
 */
export function checkShortDays({ signups, timeClock, gracePeriod, weekStatuses, today }) {
  const grace = (Number(gracePeriod) || DEFAULT_GRACE_MINUTES) / 60
  const bookedByDay = new Map()
  for (const s of signups || []) {
    if (s.status !== 'Confirmed') continue
    const d = dateOnly(s.date)
    if (!d || d >= today) continue
    bookedByDay.set(d, (bookedByDay.get(d) || 0) + 1)
  }
  const punchedByDay = new Map()
  const allDoneDays = new Set()
  for (const r of timeClock || []) {
    const d = fakeUtcDateKey(r.punch_in)
    if (!d) continue
    if (r.entry_type === 'All Done') { allDoneDays.add(d); continue }
    if (r.entry_type === 'Volunteer' || r.entry_type === 'Club Activity' || r.status === 'Punched In') continue
    punchedByDay.set(d, (punchedByDay.get(d) || 0) + (parseFloat(r.total_hours) || 0))
  }
  const items = []
  for (const [d, booked] of bookedByDay) {
    const punched = punchedByDay.get(d)
    if (punched === undefined || punched <= 0) continue        // that's a no-show (#6), not a short day
    if (allDoneDays.has(d)) continue
    const st = weekStatuses?.get(mondayKeyOf(d))
    if (st?.allDone && st.allDoneDate && d >= st.allDoneDate) continue
    if (punched >= booked - grace) continue
    items.push({
      date: d, week: mondayKeyOf(d),
      label: `${fmtDay(d)} — ${fmtHours(punched)} of ${fmtHours(booked)} booked hours`,
      detail: `${fmtHours(round2(booked - punched))} hours short of what was signed up.`,
      hours: round2(booked - punched),
    })
  }
  items.sort((a, b) => a.date.localeCompare(b.date))
  return makeCheck({ id: 'shortDays', num: 14, section: 'timeclock', label: 'Short days (present, but fewer hours than booked)', severity: 'low', counts: true,
    help: 'Punched hours for the day were more than the grace period below the hours signed up.' }, items)
}

/** 15. Time-entry requests (New = forgot to punch entirely; Edit = asked to change a punch). */
export function checkTimeRequests({ timeRequests }) {
  const items = (timeRequests || []).map(r => ({
    date: dateOnly(r.requested_date) || dateOnly(r.created_at), week: mondayKeyOf(dateOnly(r.requested_date) || dateOnly(r.created_at)),
    label: `${r.entry_type === 'Edit' ? 'Edit' : 'New entry'} — ${fmtDay(r.requested_date)} ${String(r.start_time || '').substring(0, 5)}–${String(r.end_time || '').substring(0, 5)} (${r.course_id || r.class_id || ''}) — ${r.status}`,
    detail: `${r.reason ? `Reason: ${r.reason}. ` : ''}${r.reviewed_by ? `Reviewed by ${r.reviewed_by}.` : ''}`,
    kind: r.entry_type === 'Edit' ? 'Edit' : 'New',
    status: r.status,
  }))
  const news = items.filter(i => i.kind === 'New').length
  const edits = items.length - news
  const rejected = items.filter(i => i.status === 'Rejected').length
  return makeCheck({ id: 'timeRequests', num: 15, section: 'timeclock', label: 'Time-entry requests', severity: 'low', counts: true,
    help: '"New" means the student never punched and asked for the time afterwards; "Edit" asked to change a punch.',
    summary: items.length ? `${news} new, ${edits} edit, ${rejected} rejected` : '' }, items)
}

/** 16. Weeks released by All Done where hours were NOT actually met (info). */
export function checkAllDoneVsHours({ userReport }) {
  const seen = new Set()
  const items = []
  for (const cr of userReport?.classReports || []) {
    for (const w of cr.weeklyBreakdown || []) {
      if (!w.allDone || w.metHours) continue
      const key = `${w.startDate}|${cr.courseId}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        date: w.startDate, week: mondayKeyOf(w.startDate),
        label: `Week of ${fmtDate(w.startDate)} (${cr.courseId}) — ${fmtHours(w.hours)} of ${fmtHours(w.requiredHours)} hours punched`,
        detail: 'An instructor swiped All Done, so the week counts as complete.',
      })
    }
  }
  return makeCheck({ id: 'allDoneVsHours', num: 16, section: 'timeclock', label: 'All Done given with hours under requirement', severity: 'info', counts: false,
    help: 'Informational — the instructor released the week early.' }, items)
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C — ABSENCES & LATE WORK
// ═════════════════════════════════════════════════════════════════════════════

function isLateSub(a) { return a.request_type === 'Late Submission' }

/** 17. Absence requests this term (any status). */
export function checkAbsences({ absences }) {
  const items = (absences || []).filter(a => !isLateSub(a)).map(a => ({
    date: dateOnly(a.absence_date), week: mondayKeyOf(dateOnly(a.absence_date)),
    label: `${fmtDay(a.absence_date)} (${a.course_id || a.class_id || ''}) — ${fmtHours(a.hours_missed)} hours — ${a.status}`,
    detail: `${a.reason ? `Reason: ${a.reason}. ` : ''}${a.makeup_plan ? `Make-up plan: ${a.makeup_plan}.` : ''}`,
    status: a.status, hours: Number(a.hours_missed) || 0,
  }))
  const approved = items.filter(i => i.status === 'Approved')
  const hrs = approved.reduce((s, i) => s + i.hours, 0)
  return makeCheck({ id: 'absences', num: 17, section: 'absences', label: 'Absence requests', severity: 'low', counts: true,
    help: 'Every absence request filed this term, whatever its status.',
    summary: items.length ? `${approved.length} approved (${fmtHours(hrs)} h), ${items.filter(i => i.status === 'Rejected').length} rejected, ${items.filter(i => i.status === 'Pending').length} pending` : '' }, items)
}

/** 18. Absence filed after the absence date. */
export function checkFiledLate({ absences }) {
  const items = []
  for (const a of absences || []) {
    if (isLateSub(a)) continue
    const filed = fakeUtcDateKey(a.created_at)
    const day = dateOnly(a.absence_date)
    if (!filed || !day || filed <= day) continue
    const daysAfter = Math.round((new Date(filed + 'T00:00:00') - new Date(day + 'T00:00:00')) / 86400000)
    items.push({
      date: day, week: mondayKeyOf(day),
      label: `${fmtDay(day)} (${a.course_id || a.class_id || ''}) — filed ${fmtDate(filed)}`,
      detail: `${daysAfter} day${daysAfter === 1 ? '' : 's'} after the absence — ${a.status}.`,
      days: daysAfter,
    })
  }
  return makeCheck({ id: 'filedLate', num: 18, section: 'absences', label: 'Absence filed after the fact', severity: 'low', counts: true,
    help: 'The request was submitted after the day it covers.' }, items)
}

/** 19. Approved make-up hours not completed once the make-up week has passed. */
export function checkMakeupIncomplete({ absences, today }) {
  const items = []
  for (const a of absences || []) {
    if (a.status !== 'Approved' || !(Number(a.hours_missed) > 0)) continue
    if (a.makeup_complete) continue
    const mk = makeupWeekOf(dateOnly(a.week_start)) || (dateOnly(a.absence_date) ? makeupWeekOf(mondayKeyOf(dateOnly(a.absence_date))) : null)
    if (!mk) continue
    const { sunday } = weekRangeOf(mk)
    if (!sunday || sunday >= today) continue          // make-up week still running
    items.push({
      date: mk, week: mk,
      label: `${fmtHours(a.hours_missed)} hours for ${fmtDay(a.absence_date)} (${a.course_id || a.class_id || ''}) — make-up week of ${fmtDate(mk)}`,
      detail: 'Make-up week has passed and the hours are not marked complete.',
      hours: Number(a.hours_missed) || 0,
    })
  }
  return makeCheck({ id: 'makeupIncomplete', num: 19, section: 'absences', label: 'Make-up hours not completed', severity: 'medium', counts: true,
    help: 'Approved absences whose make-up week (the week after) has ended without the hours being marked complete.' }, items)
}

/** 20. Late-submission requests, with their "Nth this semester" position. */
export function checkLateSubmissions({ absences }) {
  const rows = (absences || []).filter(isLateSub).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  const items = rows.map((a, i) => ({
    date: dateOnly(a.due_date) || fakeUtcDateKey(a.created_at), week: mondayKeyOf(dateOnly(a.due_date) || fakeUtcDateKey(a.created_at)),
    label: `${ordinal(i + 1)} — ${a.assignment_name || 'assignment'} (${a.course_id || a.class_id || ''}) due ${fmtDate(a.due_date)} — ${a.status}`,
    detail: `${a.reason ? `Reason: ${a.reason}. ` : ''}${a.deduction_status ? `Deduction: ${a.deduction_status}.` : ''}`,
    status: a.status,
  }))
  return makeCheck({ id: 'lateSubmissions', num: 20, section: 'absences', label: 'Late-submission requests', severity: 'low', counts: true,
    help: 'Requests to turn work in late, in the order they were filed.' }, items)
}

/** 21. Approved late work whose new due date passed with nothing received. */
export function checkWorkPastDue({ absences, now }) {
  const items = (absences || []).filter(a => isLateSub(a) && workDueState(a, now) === 'past_due').map(a => ({
    date: fakeUtcDateKey(a.new_due_at), week: mondayKeyOf(fakeUtcDateKey(a.new_due_at)),
    label: `${a.assignment_name || 'assignment'} (${a.course_id || a.class_id || ''}) — was due ${fmtFakeUtc(a.new_due_at)}`,
    detail: 'Extended due date has passed and the work has not been marked received.',
  }))
  return makeCheck({ id: 'workPastDue', num: 21, section: 'absences', label: 'Late work still not received', severity: 'high', counts: true,
    help: 'Approved late submissions past their extended due date with work_received still unchecked.' }, items)
}

/** 22. Deduction status on late submissions (info). */
export function checkDeductions({ absences }) {
  const items = (absences || []).filter(a => isLateSub(a) && a.status === 'Approved' && a.deduction_status).map(a => ({
    date: dateOnly(a.due_date) || fakeUtcDateKey(a.created_at), week: mondayKeyOf(dateOnly(a.due_date) || fakeUtcDateKey(a.created_at)),
    label: `${a.assignment_name || 'assignment'} (${a.course_id || a.class_id || ''}) — ${a.deduction_status}`,
    detail: a.work_received ? `Work received ${fmtFakeUtc(a.work_received_date)}.` : 'Work not yet received.',
    deduction: a.deduction_status,
  }))
  const ded = items.filter(i => /deduction/i.test(i.deduction)).length
  return makeCheck({ id: 'deductions', num: 22, section: 'absences', label: 'Late-work deductions', severity: 'info', counts: false,
    help: 'Informational — how each approved late submission was scored.',
    summary: items.length ? `${ded} with deduction, ${items.length - ded} waived` : '' }, items)
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION D — WORK ORDERS  (woc = calculateScore() result for the term window)
// ═════════════════════════════════════════════════════════════════════════════

function wocItems(woc, type) {
  return (woc?.details || []).filter(d => d.type === type).map(d => ({
    date: '', week: '',
    label: `${d.woId} — ${d.description || ''}`.trim(),
    detail: type === 'stale'
      ? `${d.daysSinceUpdate} school days since the last update (${d.days} over the threshold).`
      : `${d.days} school day${d.days === 1 ? '' : 's'} late${d.source === 'closed' ? ' (closed late)' : ''}.`,
    days: d.days, woId: d.woId,
  }))
}

/** 23. Own work orders late. */
export function checkOwnWOsLate({ woc }) {
  const items = wocItems(woc, 'personal_late')
  return makeCheck({ id: 'ownWOsLate', num: 23, section: 'workorders', label: 'Own work orders past due', severity: 'high', counts: true,
    help: 'Work orders assigned to the student that ran past their due date (open or closed late).',
    summary: items.length ? `${items.reduce((s, i) => s + i.days, 0)} school days late in total` : '' }, items)
}

/** 24. Team work orders late (shared penalty). Hidden from students. */
export function checkTeamWOsLate({ woc }) {
  const own = new Set(wocItems(woc, 'personal_late').map(i => i.woId))
  const items = wocItems(woc, 'team_late').filter(i => !own.has(i.woId))
  return makeCheck({ id: 'teamWOsLate', num: 24, section: 'workorders', label: 'Team work orders past due', severity: 'low', counts: true, instructorOnly: true,
    help: 'Late work orders assigned to others — a shared penalty in the WOC score. Not shown to students.' }, items)
}

/** 25. Stale work orders. */
export function checkStaleWOs({ woc }) {
  const items = wocItems(woc, 'stale')
  return makeCheck({ id: 'staleWOs', num: 25, section: 'workorders', label: 'Stale work orders', severity: 'medium', counts: true,
    help: 'Assigned work orders with no update for longer than the stale threshold.' }, items)
}

/** 26. Assigned open work orders with no work log from this student. */
export function checkNoWorkLog({ assignedOpenWOs, myLoggedWoIds }) {
  const logged = myLoggedWoIds instanceof Set ? myLoggedWoIds : new Set(myLoggedWoIds || [])
  const items = (assignedOpenWOs || []).filter(w => !logged.has(w.wo_id)).map(w => ({
    date: dateOnly(w.created_at), week: '',
    label: `${w.wo_id} — ${w.description || w.title || ''}`.trim(),
    detail: `Assigned${w.due_date ? `, due ${fmtDate(w.due_date)}` : ''} — no work has been logged by the student.`,
    woId: w.wo_id,
  }))
  return makeCheck({ id: 'noWorkLog', num: 26, section: 'workorders', label: 'Assigned work orders with no work logged', severity: 'medium', counts: true,
    help: 'Open work orders assigned to the student where they have never logged time.' }, items)
}

/** 27. WOC Ratio score (info). */
export function checkWocScore({ woc }) {
  const items = woc ? [{
    date: '', week: '',
    label: `WOC score ${Math.round(woc.score)}% (base ${Math.round(woc.baseScore)}%, activity ${fmtHours(woc.activityHours)}/${fmtHours(woc.expectedHours)} h)`,
    detail: `Deductions ${round2(woc.totalDeduction)}%, rewards +${round2(woc.totalReward)}%.`,
  }] : []
  return makeCheck({ id: 'wocScore', num: 27, section: 'workorders', label: 'WOC Ratio score', severity: 'info', counts: false,
    help: 'The same score shown on the WOC Ratio page for this term.',
    summary: woc ? `${Math.round(woc.score)}%` : '' }, items, { count: woc ? Math.round(woc.score) : 0, isScore: true })
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION E — EQUIPMENT
// ═════════════════════════════════════════════════════════════════════════════

function checkoutLabel(c) { return `${c.asset_name || c.asset_id || 'item'}${c.asset_id && c.asset_name ? ` (${c.asset_id})` : ''}` }

/** 28. Overdue checkouts (still out past expected return, or returned late). */
export function checkOverdueCheckouts({ checkouts, nowMs }) {
  const items = []
  for (const c of checkouts || []) {
    const due = fakeUtcMs(c.expected_return)
    if (due === null) continue
    if (c.status === 'checked_out') {
      const days = Math.floor((nowMs - due) / 86400000)
      if (days < 1) continue
      items.push({ date: fakeUtcDateKey(c.expected_return), week: mondayKeyOf(fakeUtcDateKey(c.expected_return)),
        label: `${checkoutLabel(c)} — ${days} day${days === 1 ? '' : 's'} overdue, still out`,
        detail: `Checked out ${fmtFakeUtc(c.checked_out_at)}, expected back ${fmtFakeUtc(c.expected_return)}.`, days, stillOut: true })
    } else if (c.status === 'returned' && c.returned_at) {
      const ret = fakeUtcMs(c.returned_at)
      const days = ret === null ? 0 : Math.floor((ret - due) / 86400000)
      if (days < 1) continue
      items.push({ date: fakeUtcDateKey(c.returned_at), week: mondayKeyOf(fakeUtcDateKey(c.returned_at)),
        label: `${checkoutLabel(c)} — returned ${days} day${days === 1 ? '' : 's'} late`,
        detail: `Expected back ${fmtFakeUtc(c.expected_return)}, returned ${fmtFakeUtc(c.returned_at)}.`, days, stillOut: false })
    }
  }
  return makeCheck({ id: 'overdueCheckouts', num: 28, section: 'equipment', label: 'Overdue equipment', severity: 'medium', counts: true,
    help: 'Checkouts past their expected return date — still out, or returned late.' }, items)
}

/** 29. Returned damaged, or marked lost. */
export function checkDamagedLost({ checkouts }) {
  const items = []
  for (const c of checkouts || []) {
    if (String(c.status) === 'Lost' || lower(c.status) === 'lost') {
      items.push({ date: fakeUtcDateKey(c.checked_out_at), week: mondayKeyOf(fakeUtcDateKey(c.checked_out_at)),
        label: `${checkoutLabel(c)} — marked LOST`, detail: `Checked out ${fmtFakeUtc(c.checked_out_at)}.` })
      continue
    }
    const cond = lower(c.return_condition)
    if (c.status === 'returned' && cond && cond !== 'good' && cond !== 'ok' && cond !== 'fine') {
      items.push({ date: fakeUtcDateKey(c.returned_at), week: mondayKeyOf(fakeUtcDateKey(c.returned_at)),
        label: `${checkoutLabel(c)} — returned "${c.return_condition}"`, detail: c.return_notes || '' })
    }
  }
  return makeCheck({ id: 'damagedLost', num: 29, section: 'equipment', label: 'Returned damaged or lost', severity: 'high', counts: true,
    help: 'Return condition other than Good, or the checkout was marked Lost.' }, items)
}

/** 30. Checkouts the student never acknowledged (pending acknowledgment expired). */
export function checkUnacknowledged({ checkouts, nowMs }) {
  const items = (checkouts || []).filter(c => c.status === 'pending_acknowledgment' && fakeUtcMs(c.expires_at) !== null && fakeUtcMs(c.expires_at) < nowMs).map(c => ({
    date: fakeUtcDateKey(c.expires_at), week: mondayKeyOf(fakeUtcDateKey(c.expires_at)),
    label: `${checkoutLabel(c)} — acknowledgement expired ${fmtFakeUtc(c.expires_at)}`,
    detail: 'The student never confirmed the checkout.',
  }))
  return makeCheck({ id: 'unacknowledged', num: 30, section: 'equipment', label: 'Checkouts never acknowledged', severity: 'low', counts: true,
    help: 'Pending-acknowledgement checkouts that expired before the student confirmed them.' }, items)
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION F — PROGRAM
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Volunteer standing — mirrors useVolunteerOverview() in useVolunteerHours.js
 * (kept in step by hand; the overview hook's helpers are not exported).
 *
 * @param {Object} p
 * @param {number} p.approvedHours      approved Volunteer + Club Activity hours in the counting window
 * @param {number} p.pendingHours       pending volunteer requests
 * @param {string[]} p.studentCourseIds enrolled course ids
 * @param {Array} p.qualifyingClasses   [{ course_id, period: 'first'|'second'|'full' }]
 * @param {Object} p.settings           { totalHoursRequired, midpointHours, midpointWeek, semesterStart }
 * @param {number} p.currentWeek        1-based week number of the semester
 */
export function volunteerStanding({ approvedHours, pendingHours, studentCourseIds, qualifyingClasses, settings, currentWeek }) {
  const s = settings || {}
  const enrolled = (qualifyingClasses || []).filter(c => (studentCourseIds || []).includes(c.course_id))
  const hasRequirement = enrolled.length > 0
  const coversFirst = enrolled.some(c => c.period === 'first' || c.period === 'full')
  const coversSecond = enrolled.some(c => c.period === 'second' || c.period === 'full')
  const midpointHours = Number(s.midpointHours) || 0
  const midpointWeek = Number(s.midpointWeek) || 8
  const totalRequired = hasRequirement ? (coversFirst ? midpointHours : 0) + (coversSecond ? midpointHours : 0) : (Number(s.totalHoursRequired) || 0)
  const midpointApplies = hasRequirement ? coversFirst : true
  const secondHalfApplies = hasRequirement ? coversSecond : true
  const approved = round2(approvedHours)
  const isComplete = totalRequired > 0 ? approved >= totalRequired : true
  const pastMidpoint = currentWeek > midpointWeek

  let midpointStatus = 'not_applicable'
  if (midpointApplies) {
    midpointStatus = 'on_track'
    if (approved >= midpointHours) midpointStatus = 'met'
    else if (pastMidpoint) midpointStatus = 'overdue'
    else if (currentWeek >= midpointWeek - 2) midpointStatus = 'at_risk'
  }
  let overallStatus = 'on_track'
  if (isComplete || !hasRequirement || totalRequired === 0) overallStatus = 'complete'
  else if (midpointApplies && midpointStatus === 'overdue') overallStatus = 'behind'
  else if (midpointApplies && midpointStatus === 'at_risk') overallStatus = 'at_risk'

  const totalWeeks = midpointWeek * 2
  const secondElapsed = Math.max(0, currentWeek - midpointWeek)
  const secondTotal = totalWeeks - midpointWeek
  const secondHours = secondHalfApplies ? round2(Math.max(0, approved - (midpointApplies ? midpointHours : 0))) : 0
  let secondHalfStatus = 'not_applicable'
  if (secondHalfApplies) {
    secondHalfStatus = 'pending'
    if (pastMidpoint) {
      if (secondHours >= midpointHours) secondHalfStatus = 'met'
      else if (secondElapsed >= secondTotal) secondHalfStatus = 'overdue'
      else if (secondElapsed >= secondTotal - 2) secondHalfStatus = 'at_risk'
      else secondHalfStatus = 'on_track'
    }
  }
  if (!midpointApplies && secondHalfApplies && !isComplete) {
    if (secondHalfStatus === 'overdue') overallStatus = 'behind'
    else if (secondHalfStatus === 'at_risk') overallStatus = 'at_risk'
  }
  return { approvedHours: approved, pendingHours: round2(pendingHours), totalRequired, remaining: Math.max(0, round2(totalRequired - approved)),
    hasRequirement, midpointStatus, secondHalfStatus, overallStatus, isComplete }
}

/** 31. Volunteer hours standing (counts 1 when behind, 0 otherwise; at-risk is shown but not counted). */
export function checkVolunteer({ volunteer }) {
  const v = volunteer
  const label = { complete: 'Complete', on_track: 'On track', at_risk: 'At risk', behind: 'Behind' }
  const items = v ? [{
    date: '', week: '',
    label: `${label[v.overallStatus] || v.overallStatus} — ${fmtHours(v.approvedHours)} of ${fmtHours(v.totalRequired)} hours approved${v.pendingHours > 0 ? ` (+${fmtHours(v.pendingHours)} pending)` : ''}`,
    detail: v.hasRequirement ? `Midpoint: ${v.midpointStatus.replace(/_/g, ' ')}; second half: ${v.secondHalfStatus.replace(/_/g, ' ')}.` : 'No enrolled class requires volunteer hours this term.',
  }] : []
  return makeCheck({ id: 'volunteer', num: 31, section: 'program', label: 'Volunteer hours', severity: v?.overallStatus === 'behind' ? 'high' : v?.overallStatus === 'at_risk' ? 'medium' : 'info', counts: true,
    help: 'Same standing as the Volunteer Hours page. Counts one infraction when Behind.',
    summary: v ? (label[v.overallStatus] || v.overallStatus) : '' }, items, { count: v?.overallStatus === 'behind' ? 1 : 0, status: v?.overallStatus || '' })
}

/** 32. Student holds — active ones count; acknowledged / cleared listed for history. */
export function checkHolds({ holds }) {
  const items = (holds || []).map(h => {
    const t = h.target || {}
    const state = t.cleared_at ? 'cleared' : t.acknowledged_at ? 'acknowledged' : 'open'
    return {
      date: dateOnly(h.created_at), week: mondayKeyOf(dateOnly(h.created_at)),
      label: `${h.title || h.template_type || 'Hold'} (${h.severity || 'hold'}) — ${state}`,
      detail: `${h.message ? `${h.message} ` : ''}${t.cleared_at ? `Cleared ${fmtDate(t.cleared_at)} by ${t.cleared_by_name || t.cleared_by_email || ''}.` : t.acknowledged_at ? `Acknowledged ${fmtDate(t.acknowledged_at)}.` : 'Not yet acknowledged.'}`,
      state, severity: h.severity,
    }
  })
  const open = items.filter(i => i.state !== 'cleared').length
  return makeCheck({ id: 'holds', num: 32, section: 'program', label: 'Student holds', severity: open ? 'high' : 'info', counts: true,
    help: 'Holds, reminders and nudges addressed to the student. Counts the ones not yet cleared.',
    summary: items.length ? `${open} open, ${items.length - open} cleared` : '' }, items, { count: open })
}

/**
 * 33. Weekly reminders not acknowledged. Only weeks from ACK_TRACKING_START
 * onward, only past weeks where the student owed hours, and only reminders in
 * scope (global, their class, or addressed to them).
 */
export function checkReminderAcks({ reminders, acks, weekStatuses, enrolledIds, studentEmail, today }) {
  const me = lower(studentEmail)
  const inScope = (reminders || []).filter(r => r.message && String(r.message).trim())
    .filter(r => r.class_id == null || (enrolledIds || []).includes(r.class_id))
    .filter(r => r.user_email == null || lower(r.user_email) === me)
  if (inScope.length === 0) return makeCheck({ id: 'reminderAcks', num: 33, section: 'program', label: 'Weekly reminders not acknowledged', severity: 'low', counts: true,
    help: 'Reminders shown in the All Done modal that were never checked off. Tracked from 2026-09-22.' }, [])
  const ackSet = new Set((acks || []).map(a => `${dateOnly(a.week_start)}|${a.reminder_id}`))
  const items = []
  for (const [monday, st] of weekStatuses || []) {
    if (monday < ACK_TRACKING_START) continue
    const { sunday } = weekRangeOf(monday)
    if (!sunday || sunday >= today) continue
    if (!st || !(st.required > 0)) continue
    const missing = inScope.filter(r => !ackSet.has(`${monday}|${r.id}`))
    if (missing.length === 0) continue
    items.push({
      date: monday, week: monday,
      label: `Week of ${fmtDate(monday)} — ${missing.length} of ${inScope.length} reminder${inScope.length === 1 ? '' : 's'} not acknowledged`,
      detail: missing.map(r => r.class_id ? r.class_id : r.user_email ? 'personal' : 'all classes').join(', '),
      missing: missing.length,
    })
  }
  return makeCheck({ id: 'reminderAcks', num: 33, section: 'program', label: 'Weekly reminders not acknowledged', severity: 'low', counts: true,
    help: 'Reminders shown in the All Done modal that were never checked off. Tracked from 2026-09-22.' }, items)
}

/**
 * 38. Help requests (info). Two intervals per request, all REAL-UTC columns:
 *   wait     = requested_at → acknowledged_at   (instructor pressed "On My Way")
 *   cleared  = acknowledged_at → resolved_at    (student cleared it as helped;
 *              recorded from migration 20260922_help_request_resolved onward)
 * Cancelled / expired / dismissed requests are listed but carry no cleared
 * time. Never counts as an infraction — a slow response is on the instructor.
 * Extra fields on the check: requests, answered, avgWaitMin, medianWaitMin,
 * maxWaitMin, avgClearMin, clearedCount.
 */
export function checkHelpRequests({ helpRequests }) {
  const rows = (helpRequests || []).slice().sort((a, b) => String(a.requested_at || '').localeCompare(String(b.requested_at || '')))
  const mins = (a, b) => {
    const x = parseTs(a), y = parseTs(b)
    if (!x || !y) return null
    const m = (y.getTime() - x.getTime()) / 60000
    return m < 0 ? null : Math.round(m * 10) / 10
  }
  const waits = [], clears = []
  const items = rows.map(r => {
    const wait = mins(r.requested_at, r.acknowledged_at)
    const clear = r.status === 'resolved' ? mins(r.acknowledged_at, r.resolved_at) : null
    if (wait !== null) waits.push(wait)
    if (clear !== null) clears.push(clear)
    const reqDate = parseTs(r.requested_at)
    const date = reqDate ? toDateKey(reqDate) : ''
    const when = reqDate ? reqDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''
    const outcome = r.status === 'resolved' ? 'cleared' : r.status === 'acknowledged' ? 'acknowledged, not yet cleared'
      : r.status === 'pending' ? 'waiting' : r.status || ''
    return {
      date, week: mondayKeyOf(date),
      label: `${fmtDay(date)} ${when}${r.location ? ` — Room ${r.location}` : ''} — ${outcome}`,
      detail: wait === null
        ? (r.status === 'pending' ? 'No response yet.' : 'No instructor response recorded before it ended.')
        : `Response in ${wait} min${r.acknowledged_by ? ` (${r.acknowledged_by})` : ''}${clear !== null ? `; cleared ${clear} min after that` : r.status === 'expired' ? '; timed out without being cleared' : ''}.`,
      waitMin: wait, clearMin: clear, status: r.status,
    }
  })
  const avg = a => a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null
  const median = a => {
    if (!a.length) return null
    const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10
  }
  const stats = { requests: rows.length, answered: waits.length, avgWaitMin: avg(waits), medianWaitMin: median(waits),
    maxWaitMin: waits.length ? Math.max(...waits) : null, avgClearMin: avg(clears), clearedCount: clears.length }
  const summary = rows.length
    ? `${stats.answered}/${stats.requests} answered${stats.avgWaitMin !== null ? `, avg wait ${stats.avgWaitMin} min (median ${stats.medianWaitMin}, longest ${stats.maxWaitMin})` : ''}${stats.avgClearMin !== null ? `, avg ${stats.avgClearMin} min to cleared` : ''}`
    : ''
  return makeCheck({ id: 'helpRequests', num: 38, section: 'program', label: 'Help requests — response time', severity: 'info', counts: false,
    help: 'How long the student waited for "On My Way", and how long until they cleared the request. Informational — response time is the instructor\u2019s, not the student\u2019s.',
    summary }, items, { ...stats, count: rows.length })
}

/** 34. Instructor-only absence notes (info, instructor view only). */
export function checkAbsenceNotes({ absenceNotes, absences }) {
  const byReq = new Map((absences || []).map(a => [a.request_id, a]))
  const items = (absenceNotes || []).map(n => {
    const a = byReq.get(n.request_id)
    return {
      date: dateOnly(n.created_at), week: mondayKeyOf(dateOnly(n.created_at)),
      label: `${fmtDate(n.created_at)} — ${n.created_by || ''}${a ? ` on ${a.request_type === 'Late Submission' ? 'late submission' : 'absence'} ${fmtDay(a.absence_date || a.due_date)}` : ` (${n.request_id})`}`,
      detail: n.note || '',
    }
  })
  return makeCheck({ id: 'absenceNotes', num: 34, section: 'program', label: 'Instructor notes on requests', severity: 'info', counts: false, instructorOnly: true,
    help: 'Follow-up notes instructors left on absence / late-submission requests. Never shown to students.' }, items)
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION G — SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

/** 35. Scores: attendance per class (Time Cards engine) + the GB trio. */
export function summarizeScores({ userReport, woc, volunteer }) {
  const perClass = (userReport?.classReports || []).map(cr => ({
    courseId: cr.courseId, courseName: cr.courseName || '',
    attendanceScore: cr.attendance?.attendanceScore ?? null,
    hours: cr.totalHours, required: cr.totalRequiredHours,
    weeksDone: cr.weeksDone, weeksWithHours: cr.weeksWithHours, weeks: (cr.weeklyBreakdown || []).length,
  }))
  const attendanceAvg = perClass.length ? Math.round(perClass.reduce((s, c) => s + (c.attendanceScore || 0), 0) / perClass.length) : null
  return {
    perClass,
    attendanceAvg,
    woc: woc ? Math.round(woc.score) : null,
    volunteer: volunteer ? { status: volunteer.overallStatus, approved: volunteer.approvedHours, required: volunteer.totalRequired } : null,
  }
}

/** 36. Total: sum of every counting check. Also per-severity totals. */
export function totalInfractions(checks) {
  const out = { total: 0, high: 0, medium: 0, low: 0 }
  for (const c of checks || []) {
    if (!c.counts) continue
    const n = Number(c.count) || 0
    out.total += n
    if (c.severity in out) out[c.severity] += n
  }
  return out
}

/**
 * 37. Trend: average dated events per week over the last `trendWeeks`
 * completed weeks vs the whole term so far. Only dated, counting items.
 */
export function computeTrend({ checks, termStart, today, trendWeeks }) {
  const n = Number(trendWeeks) > 0 ? Number(trendWeeks) : DEFAULT_TREND_WEEKS
  const weeks = mondaysBetween(termStart, today).filter(m => m <= mondayKeyOf(today))
  if (weeks.length === 0) return { direction: 'steady', recentPerWeek: 0, overallPerWeek: 0, weeks: [], recentWeeks: 0 }
  const perWeek = new Map(weeks.map(w => [w, 0]))
  for (const c of checks || []) {
    if (!c.counts) continue
    for (const it of c.items || []) {
      const w = it.week || (it.date ? mondayKeyOf(it.date) : '')
      if (w && perWeek.has(w)) perWeek.set(w, perWeek.get(w) + 1)
    }
  }
  const series = weeks.map(w => ({ week: w, count: perWeek.get(w) || 0 }))
  const recent = series.slice(-n)
  const recentAvg = recent.reduce((s, x) => s + x.count, 0) / (recent.length || 1)
  const overallAvg = series.reduce((s, x) => s + x.count, 0) / (series.length || 1)
  let direction = 'steady'
  if (series.length > n) {
    if (recentAvg > 0 && recentAvg >= overallAvg * 1.25 && recentAvg - overallAvg >= 0.5) direction = 'worse'
    else if (recentAvg <= overallAvg * 0.75 && overallAvg - recentAvg >= 0.5) direction = 'better'
  }
  return { direction, recentPerWeek: round2(recentAvg), overallPerWeek: round2(overallAvg), weeks: series, recentWeeks: recent.length }
}

// ═════════════════════════════════════════════════════════════════════════════
// ASSEMBLY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run every rule over one student's gathered data.
 *
 * @param {Object} ctx  see useAccountabilityReport() for how each field is loaded
 * @returns {{ checks: Array, sections: Array, totals: Object, trend: Object, scores: Object }}
 */
export function buildReport(ctx) {
  const today = ctx.today || toDateKey(new Date())
  const now = ctx.now || new Date()
  const nowMs = nowFakeUtcMs(now)
  const base = { ...ctx, today, now, nowMs }

  const checks = [
    checkWeeksShort(base), checkDeadlineMissed(base), checkPostDeadlineChanges(base), checkLateCancels(base),
    checkCancelledLeftShort(base), checkNoShows(base), checkPendingRequests(base),
    checkLate(base), checkLeftEarly(base), checkLeftEarlyApproved(base), checkWalkIns(base), checkWrongClass(base),
    checkForgotPunchOut(base), checkShortDays(base), checkTimeRequests(base), checkAllDoneVsHours(base),
    checkAbsences(base), checkFiledLate(base), checkMakeupIncomplete(base), checkLateSubmissions(base), checkWorkPastDue(base), checkDeductions(base),
    checkOwnWOsLate(base), checkTeamWOsLate(base), checkStaleWOs(base), checkNoWorkLog(base), checkWocScore(base),
    checkOverdueCheckouts(base), checkDamagedLost(base), checkUnacknowledged(base),
    checkVolunteer(base), checkHolds(base), checkReminderAcks(base), checkHelpRequests(base), checkAbsenceNotes(base),
  ]
  const visible = ctx.studentView ? checks.filter(c => !c.instructorOnly) : checks
  const totals = totalInfractions(visible)
  const trend = computeTrend({ checks: visible, termStart: ctx.term?.begin_date, today, trendWeeks: ctx.settings?.trendWeeks })
  const scores = summarizeScores(base)
  const sections = SECTIONS.map(s => ({ ...s, checks: visible.filter(c => c.section === s.key) }))
  const meta = buildMeta(base)
  return { checks: visible, sections, totals, trend, scores, meta }
}

/**
 * Facts the alert rules (accountabilityAlerts.js) need that are not events:
 * which lab days the student actually attended, which completed weeks owed
 * hours and had no punches, and how late each open work order is.
 */
export function buildMeta(ctx) {
  const today = ctx.today || toDateKey(new Date())
  const attended = new Set()
  const punchWeeks = new Set()
  for (const r of ctx.timeClock || []) {
    if (r.entry_type === 'Volunteer' || r.entry_type === 'Club Activity' || r.entry_type === 'All Done' || r.status === 'No Show') continue
    const d = fakeUtcDateKey(r.punch_in)
    if (!d) continue
    attended.add(d)
    const m = mondayKeyOf(d)
    if (m) punchWeeks.add(m)
  }
  const absenceWeeks = new Set()
  for (const a of ctx.absences || []) {
    if (a.status !== 'Approved' || a.request_type === 'Late Submission') continue
    const m = mondayKeyOf(dateOnly(a.absence_date))
    if (m) absenceWeeks.add(m)
  }
  const weeks = []
  for (const [monday, st] of ctx.weekStatuses || []) {
    const { sunday } = weekRangeOf(monday)
    if (!sunday || sunday >= today) continue                 // completed weeks only
    weeks.push({
      monday, required: st?.required || 0, met: !!st?.met, allDone: !!st?.allDone,
      hasPunches: punchWeeks.has(monday), approvedAbsence: absenceWeeks.has(monday),
    })
  }
  weeks.sort((a, b) => a.monday.localeCompare(b.monday))
  const t0 = new Date(today + 'T00:00:00').getTime()
  const woLate = (ctx.assignedOpenWOs || []).map(w => {
    const due = dateOnly(w.due_date)
    if (!due) return null
    const days = Math.floor((t0 - new Date(due + 'T00:00:00').getTime()) / 86400000)
    return days > 0 ? { woId: w.wo_id, description: w.description || w.title || '', due, days } : null
  }).filter(Boolean)
  const openHolds = (ctx.holds || []).filter(h => !h.target?.cleared_at).length
  return { today, attendedDays: [...attended].sort(), weeks, woLate, openHolds }
}

/** Plain-English wording for the student's own view. */
export function studentFacingLabel(check) {
  const map = {
    weekShort: 'Weeks I was short on sign-ups',
    deadlineMissed: 'Weeks I missed the Sunday deadline',
    postDeadlineChanges: 'Schedule changes I asked for after the deadline',
    lateCancels: 'Sign-ups I cancelled at the last minute',
    cancelledLeftShort: 'Cancelled hours I never rebooked',
    noShows: 'Sign-ups I did not show up for',
    pendingRequests: 'My change requests waiting on review',
    late: 'Days I arrived late',
    leftEarly: 'Days I left early',
    leftEarlyApproved: 'Days I left early with permission',
    walkIns: 'Days I came in without a sign-up',
    wrongClass: 'Days I punched into the wrong class',
    forgotPunchOut: 'Days I forgot to punch out',
    shortDays: 'Days I stayed less than I signed up for',
    timeRequests: 'Time-entry requests I made',
    allDoneVsHours: 'Weeks released early by All Done',
    absences: 'My absence requests',
    filedLate: 'Absences I filed after the day',
    makeupIncomplete: 'Make-up hours I have not completed',
    lateSubmissions: 'My late-work requests',
    workPastDue: 'Late work I still owe',
    deductions: 'Late-work deductions',
    ownWOsLate: 'My work orders past due',
    staleWOs: 'My work orders with no recent update',
    noWorkLog: 'My work orders with no time logged',
    wocScore: 'My WOC score',
    overdueCheckouts: 'Equipment I returned late or still have out',
    damagedLost: 'Equipment returned damaged or lost',
    unacknowledged: 'Checkouts I never confirmed',
    volunteer: 'My volunteer hours',
    holds: 'Holds on my account',
    reminderAcks: 'Weekly reminders I did not acknowledge',
    helpRequests: 'My help requests — how long I waited',
  }
  return map[check.id] || check.label
}
