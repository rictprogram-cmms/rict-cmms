/**
 * lunchTime.js — one place to read and describe a lab day's lunch break.
 *
 * lab_calendar.lunch_hour holds the hour lunch STARTS, as a number of hours
 * past midnight. Whole hours are the original values (11, 12, 13); half hours
 * are stored as .5 (11.5 = 11:30 AM, 12.5 = 12:30 PM). Lunch always lasts
 * 60 minutes. NULL / '' = no lunch.
 *
 * Older code used parseInt(), which would quietly turn 11.5 into 11 — every
 * reader now goes through parseLunch() instead.
 */

/** Options offered in the Lab Calendar day editor, in order. */
export const LUNCH_OPTIONS = [
  { value: 11,   label: '11:00 AM' },
  { value: 11.5, label: '11:30 AM' },
  { value: 12,   label: '12:00 PM' },
  { value: 12.5, label: '12:30 PM' },
  { value: 13,   label: '1:00 PM' },
]

/** Raw DB / form value → hours as a number (e.g. 11.5), or null for no lunch. */
export function parseLunch(raw) {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).trim())
  if (!Number.isFinite(n) || n < 0 || n >= 24) return null
  // Snap to the nearest minute so 11.5000001 etc. compare cleanly
  return Math.round(n * 60) / 60
}

/** Lunch start in minutes past midnight, or null. */
export function lunchStartMin(raw) {
  const l = parseLunch(raw)
  return l == null ? null : Math.round(l * 60)
}

/** Lunch end (exclusive) in minutes past midnight, or null. */
export function lunchEndMin(raw) {
  const s = lunchStartMin(raw)
  return s == null ? null : s + 60
}

/** Is this minute-of-day inside lunch? (start inclusive, end exclusive) */
export function isLunchAtMinute(raw, minuteOfDay) {
  const s = lunchStartMin(raw)
  return s != null && minuteOfDay >= s && minuteOfDay < s + 60
}

/**
 * Does lunch overlap the one-hour sign-up slot that starts at `hour`?
 * With an 11:30 lunch, both the 11 AM and 12 PM slots overlap it.
 */
export function lunchOverlapsHour(raw, hour) {
  const s = lunchStartMin(raw)
  if (s == null) return false
  const slotStart = hour * 60
  return s < slotStart + 60 && s + 60 > slotStart
}

/** Minutes past midnight → '11:30 AM'. */
export function formatClockMinutes(min) {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

/** '11:30 AM' for a lunch value, or 'None'. */
export function formatLunchStart(raw) {
  const s = lunchStartMin(raw)
  return s == null ? 'None' : formatClockMinutes(s)
}

/** '11:30 AM – 12:30 PM' for a lunch value, or ''. */
export function formatLunchRange(raw) {
  const s = lunchStartMin(raw)
  return s == null ? '' : `${formatClockMinutes(s)} – ${formatClockMinutes(s + 60)}`
}

/**
 * Which part of the one-hour slot starting at `hour` is lunch.
 * Returns null when lunch doesn't touch the slot, otherwise
 *   { topPct, heightPct, full, part, label }
 *   part:  'full' | 'top' (lunch ends mid-slot) | 'bottom' (lunch starts mid-slot)
 *   label: short text for the cell, e.g. 'LUNCH 11:30' / 'LUNCH TO 12:30'
 * With an 11:30 lunch: the 11 AM slot is { part: 'bottom', topPct: 50, heightPct: 50 }
 * and the 12 PM slot is { part: 'top', topPct: 0, heightPct: 50 }.
 */
export function lunchPortionOfHour(raw, hour) {
  const s = lunchStartMin(raw)
  if (s == null) return null
  const slotStart = hour * 60
  const from = Math.max(s, slotStart)
  const to = Math.min(s + 60, slotStart + 60)
  if (to <= from) return null
  const topPct = ((from - slotStart) / 60) * 100
  const heightPct = ((to - from) / 60) * 100
  const full = heightPct >= 100
  const part = full ? 'full' : topPct > 0 ? 'bottom' : 'top'
  const short = (min) => formatClockMinutes(min).replace(/ (AM|PM)$/, '')
  const label = full ? 'LUNCH'
    : part === 'bottom' ? `LUNCH ${short(from)}`
    : `LUNCH TO ${short(to)}`
  return { topPct, heightPct, full, part, label }
}
