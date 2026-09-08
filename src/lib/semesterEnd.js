/**
 * RICT CMMS — semesterEnd
 *
 * fetchSemesterEnd()
 *
 * WHY THIS EXISTS
 * ───────────────
 * The "Rest of Semester" duration option for temporary access requests
 * needs to know when the current semester ends. Both the student-facing
 * request modal (AppLayout) and the instructor-facing approve modal
 * (NotificationBell) need the same answer, so the lookup lives here.
 *
 * The semester end is taken from the latest `end_date` among Active
 * classes whose start/end window contains today. If no class is in
 * session (semester break) or the end date is today or in the past,
 * the result is `null` and callers should hide the option.
 *
 * DATE CONVENTIONS
 * ────────────────
 * `classes.start_date` / `classes.end_date` are DATE columns (no time).
 * They are compared against today's *local* calendar date built from
 * local date parts — never `toISOString().substring(0, 10)`, which is the
 * UTC date and is one day ahead after ~7 PM Central.
 *
 * The returned `endDate` is parsed as a local date by appending
 * `T00:00:00` (no offset) so it does not shift a day in the browser.
 *
 * USAGE
 * ─────
 *   const sem = await fetchSemesterEnd()
 *   if (sem) {
 *     sem.endDate   // Date at local midnight on the semester end day
 *     sem.daysLeft  // whole days from today until endDate (>= 1)
 *     sem.label     // "Dec 18, 2026"
 *   }
 *
 *   semesterEndExpiry(sem.endDate) // Date at 23:59:59.999 local on the end day
 *
 * File: src/lib/semesterEnd.js
 */

import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'

const MS_PER_DAY = 1000 * 60 * 60 * 24

/** Today's calendar date in local time as YYYY-MM-DD. */
export function localTodayStr(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Format a Date as e.g. "Dec 18, 2026". */
export function formatSemesterEnd(date) {
  if (!date) return ''
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Compute { endDate, daysLeft, label } from a YYYY-MM-DD end date string.
 * Returns null if the date is invalid, today, or in the past.
 */
export function semesterInfoFromEndStr(endStr, now = new Date()) {
  if (!endStr) return null
  const end = new Date(String(endStr).substring(0, 10) + 'T00:00:00')
  if (Number.isNaN(end.getTime())) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const daysLeft = Math.round((end - today) / MS_PER_DAY)
  if (daysLeft <= 0) return null
  return { endDate: end, daysLeft, label: formatSemesterEnd(end) }
}

/**
 * The instant a "Rest of Semester" grant should expire: the last
 * millisecond of the semester end day, local time.
 */
export function semesterEndExpiry(endDate) {
  const d = new Date(endDate)
  d.setHours(23, 59, 59, 999)
  return d
}

/**
 * Look up the current semester's end date from Active classes.
 * Resolves to { endDate, daysLeft, label } or null.
 * Throws if the query fails (so callers can distinguish "no semester"
 * from "could not check").
 */
export async function fetchSemesterEnd() {
  const todayStr = localTodayStr()
  const data = mustData(await supabase
    .from('classes')
    .select('end_date')
    .eq('status', 'Active')
    .lte('start_date', todayStr)
    .gte('end_date', todayStr)
    .order('end_date', { ascending: false })
    .limit(1), 'classes.select')
  if (!data?.length) return null
  return semesterInfoFromEndStr(data[0].end_date)
}
