/**
 * RICT CMMS — Class delivery formats and the required-hours rule
 *
 * One place for the program rule so Settings → Classes, the Class Schedule
 * and anything else that needs "how many lab hours per week does this class
 * expect" agree:
 *
 *   Face-to-Face  1 hr per lecture credit + 2 hr per lab credit
 *   Hybrid        2 hr per lab credit (lecture is online)
 *   Online        0 — no campus hours expected (a class can still be given
 *                 hours by hand, and it still appears on the Class Schedule)
 *
 *   An 8-week section (start → end ≤ ~10 weeks) meets twice as many hours
 *   per week so the total over the term is unchanged — the same doubling the
 *   Syllabus Wizard has always applied.
 *
 * File: src/lib/classDelivery.js
 */

export const DELIVERY_OPTIONS = ['Face-to-Face', 'Hybrid', 'Online']
export const DEFAULT_DELIVERY = 'Hybrid'

/** Normalise stored / legacy values ('traditional', 'f2f', …) to one of DELIVERY_OPTIONS. */
export function normalizeDelivery(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return DEFAULT_DELIVERY
  if (s === 'online') return 'Online'
  if (s === 'hybrid') return 'Hybrid'
  if (s === 'face-to-face' || s === 'face to face' || s === 'f2f' || s === 'traditional' || s === 'in-person' || s === 'in person') return 'Face-to-Face'
  return DELIVERY_OPTIONS.find(o => o.toLowerCase() === s) || DEFAULT_DELIVERY
}

/** Whole weeks between two YYYY-MM-DD (or ISO) dates, or null when either is missing/invalid. */
export function weeksBetween(start, end) {
  if (!start || !end) return null
  const s = new Date(String(start).substring(0, 10) + 'T00:00:00')
  const e = new Date(String(end).substring(0, 10) + 'T00:00:00')
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null
  return (e - s) / (7 * 86400000)
}

/** True for an 8-week section: dates span ≤ 10.5 weeks. Null dates → false (treated as 16-week). */
export function isEightWeek(start, end) {
  const w = weeksBetween(start, end)
  return w != null && w <= 10.5
}

/**
 * Required lab hours per week for a class.
 *   { delivery, credits_lecture, credits_lab, start_date, end_date }
 * Returns a number (may be 0). Never negative; halves allowed.
 */
export function computeRequiredHours({ delivery, credits_lecture, credits_lab, start_date, end_date } = {}) {
  const d = normalizeDelivery(delivery)
  const lec = Math.max(0, parseFloat(credits_lecture) || 0)
  const lab = Math.max(0, parseFloat(credits_lab) || 0)
  let base = 0
  if (d === 'Face-to-Face') base = lec + 2 * lab
  else if (d === 'Hybrid') base = 2 * lab
  else base = 0
  if (isEightWeek(start_date, end_date)) base *= 2
  return Math.round(base * 2) / 2
}

/** Short human explanation of the rule for the value shown, e.g. "2 hr × 2 lab credits × 2 (8-week)". */
export function explainRequiredHours({ delivery, credits_lecture, credits_lab, start_date, end_date } = {}) {
  const d = normalizeDelivery(delivery)
  const lec = parseFloat(credits_lecture) || 0
  const lab = parseFloat(credits_lab) || 0
  const eight = isEightWeek(start_date, end_date)
  let parts
  if (d === 'Online') parts = ['online — no campus hours']
  else if (d === 'Face-to-Face') parts = [`${lec} lecture cr × 1 hr`, `${lab} lab cr × 2 hr`]
  else parts = [`${lab} lab cr × 2 hr`]
  if (eight && d !== 'Online') parts.push('× 2 for an 8-week section')
  return parts.join(' + ').replace(' + × 2', ' × 2')
}
