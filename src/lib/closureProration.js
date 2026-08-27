/**
 * RICT CMMS — Closure-day proration of weekly required lab hours
 *
 * PROGRAM POLICY
 *   When the college is closed on a scheduled lab day, that week's required
 *   lab hours are reduced proportionally:
 *
 *       adjusted = required_hours × (open lab days / scheduled lab days)
 *
 *   e.g. Labor Day week with a Mon–Fri lab schedule → 4 / 5 = 0.8, so an
 *   8-hour requirement becomes 6.4 hours.
 *
 * DEFINITIONS (confirmed with program staff)
 *   scheduled days — the weekdays in the `lab_visible_days` setting
 *                    (Mon–Fri → 5, Mon–Thu → 4). Changing the setting changes
 *                    the denominator.
 *   closed day     — a `lab_calendar` row whose `status` is 'Closed'. Days with
 *                    no calendar row ("Not Set") count as open. Hour-level
 *                    closures inside an Open day (`closed_blocks`) do NOT
 *                    prorate.
 *   out-of-range   — scheduled days before the class `start_date` or after its
 *                    `end_date` (first / last partial week) also count as
 *                    not-open, so a Wednesday start is 3/5 that week.
 *   order          — prorate the BASE requirement, then add make-up hours:
 *                    (8 × 0.8) + 2 = 8.4, never (8 + 2) × 0.8.
 *   zero open days — a fully closed week computes to 0 required hours.
 *   rounding       — exact value, rounded to 2 decimals for display (6.4).
 *   FINALS WEEK    — a week whose Monday is inside finals_start..finals_end
 *                    requires a flat `finals_required_hours` (settings, default
 *                    2) per class to sit the exam. Closures do NOT prorate it;
 *                    make-up hours still add on top.
 *   SPLIT WEEK     — finals starting mid-week (e.g. Thursday): the days before
 *                    finals_start are regular lab days and prorate normally
 *                    (Mon–Wed of a Mon–Fri schedule = 3/5), the finals days do
 *                    not count as regular days, and the exam hours are added
 *                    on top when SPLIT_WEEK_ADDS_EXAM_HOURS is true:
 *                    8 × 3/5 + 2 = 6.8. Set it false for 4.8.
 *
 * This is a pure OVERLAY, exactly like useMakeupHours.js: nothing is written
 * to `classes`. Every consumer multiplies at compute time, so marking a day
 * Closed on the Lab Calendar (today, tomorrow, or last month) re-prorates
 * that week everywhere instantly, and un-marking it restores full hours.
 *
 * Exports
 *   labDaysOfWeek(mondayKey, visibleDays)              → ['YYYY-MM-DD', …]
 *   prorationForWeek({ mondayKey, visibleDays, closedDates, classStart, classEnd })
 *                                                       → ProrationInfo
 *   prorateHours(baseHours, info)                       → number (2 dp)
 *   describeProration(info)                             → short label or ''
 *   fetchClosedLabDays({ rangeStart, rangeEnd })        → Promise<{ closedDates:Set, reasons:{} }>
 *   fetchClosureOverlay({ rangeStart, rangeEnd })       → Promise<ClosureOverlay>
 *   fetchWeekProration({ mondayKey, classStart, classEnd }) → Promise<ProrationInfo>
 *   isFinalsWeek(mondayKey, cls)                        → boolean (matches buildClassWeeks)
 *   weekBaseRequirement(overlay, { baseHours, mondayKey, cls, isFinals }) → WeekRequirement
 *   fetchWeekRequirement({ baseHours, mondayKey, cls })  → Promise<WeekRequirement>
 *   useClosureOverlay({ rangeStart, rangeEnd, enabled }) React hook (realtime)
 *
 * Conventions honored
 *   - Date-only strings parsed with 'T00:00:00' (local), never toISOString()
 *   - Reads that feed a user-visible number go through mustData()
 *   - Realtime via subscribeWithReconnect() with a unique per-mount name
 *
 * File: src/lib/closureProration.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { fetchLabVisibleDays, getCachedLabDays } from '@/hooks/useLabDays'

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0') }

function toKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseLocal(dateStr) {
  if (!dateStr) return null
  const s = String(dateStr).length >= 10 ? String(dateStr).substring(0, 10) : String(dateStr)
  const d = new Date(s + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

/** Monday 'YYYY-MM-DD' for any date string. Sunday belongs to the PRIOR Monday week. */
export function mondayKeyOf(dateStr) {
  const d = parseLocal(dateStr)
  if (!d) return null
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return toKey(d)
}

/**
 * All scheduled lab dates in the Monday-anchored week that starts on
 * `mondayKey`, in calendar order. Weeks are Monday-anchored app-wide, so
 * Sunday (0) maps to offset 6 (the end of the week).
 */
export function labDaysOfWeek(mondayKey, visibleDays = getCachedLabDays()) {
  const monday = parseLocal(mondayKey)
  if (!monday) return []
  const offsets = [...new Set((visibleDays || []).map(d => (d === 0 ? 6 : d - 1)))].sort((a, b) => a - b)
  return offsets.map(off => {
    const d = new Date(monday)
    d.setDate(d.getDate() + off)
    return toKey(d)
  })
}

// ─── Core calculation ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProrationInfo
 * @property {number}   scheduled   scheduled lab days this week (denominator)
 * @property {number}   open        days that count toward the requirement (numerator)
 * @property {number}   closed      days marked Closed on the Lab Calendar
 * @property {number}   outOfRange  scheduled days outside the class start/end window
 * @property {number}   factor      open / scheduled (1 when nothing is closed)
 * @property {boolean}  adjusted    true when factor < 1
 * @property {string[]} closedDates 'YYYY-MM-DD' dates marked Closed this week
 * @property {string[]} outOfRangeDates 'YYYY-MM-DD' dates outside the class window
 * @property {number}   finalsDays  scheduled days on/after finals_start (not regular lab days)
 * @property {string[]} finalsDates
 */

const FULL_WEEK = Object.freeze({
  scheduled: 0, open: 0, closed: 0, outOfRange: 0,
  factor: 1, adjusted: false, closedDates: [], outOfRangeDates: [],
  finalsDays: 0, finalsDates: [],
})

/**
 * Compute the proration for one Monday-anchored week.
 *
 * @param {Object}          p
 * @param {string}          p.mondayKey     'YYYY-MM-DD' Monday of the week (any date is normalized)
 * @param {number[]}        [p.visibleDays] lab_visible_days (Sun=0…Sat=6); defaults to the cached setting
 * @param {Set|string[]}    [p.closedDates] dates marked Closed (any range; only this week's are used)
 * @param {string}          [p.classStart]  class start_date — days before it are not-open
 * @param {string}          [p.classEnd]    class end_date   — days after it are not-open
 * @param {string}          [p.finalsStart] class finals_start — days on/after it are finals days, not regular lab days
 * @returns {ProrationInfo}
 */
export function prorationForWeek({ mondayKey, visibleDays, closedDates, classStart, classEnd, finalsStart } = {}) {
  const monday = mondayKeyOf(mondayKey)
  if (!monday) return { ...FULL_WEEK }
  const days = labDaysOfWeek(monday, visibleDays || getCachedLabDays())
  if (days.length === 0) return { ...FULL_WEEK }

  const closedSet = closedDates instanceof Set ? closedDates : new Set(closedDates || [])
  const start = classStart ? String(classStart).substring(0, 10) : null
  const end = classEnd ? String(classEnd).substring(0, 10) : null
  const fStart = finalsStart ? String(finalsStart).substring(0, 10) : null

  const closedHere = []
  const outOfRangeHere = []
  const finalsHere = []
  let open = 0
  for (const d of days) {
    if (closedSet.has(d)) { closedHere.push(d); continue }
    if ((start && d < start) || (end && d > end)) { outOfRangeHere.push(d); continue }
    if (fStart && d >= fStart) { finalsHere.push(d); continue }
    open++
  }

  const scheduled = days.length
  const factor = scheduled > 0 ? open / scheduled : 1
  return {
    scheduled,
    open,
    closed: closedHere.length,
    outOfRange: outOfRangeHere.length,
    factor,
    adjusted: factor < 1,
    closedDates: closedHere,
    outOfRangeDates: outOfRangeHere,
    finalsDays: finalsHere.length,
    finalsDates: finalsHere,
  }
}

/** Apply a proration to a base weekly requirement. Exact value, 2 decimals. */
export function prorateHours(baseHours, info) {
  const base = Number(baseHours) || 0
  const f = info && typeof info.factor === 'number' ? info.factor : 1
  return Math.round(base * f * 100) / 100
}

/**
 * Short human label for an adjusted week, e.g. "4 of 5 lab days" — empty
 * string when the week is not adjusted. Consumers render this as visible
 * text (not tooltip-only) so screen readers announce it.
 */
export function describeProration(info) {
  if (!info?.adjusted) return ''
  return `${info.open} of ${info.scheduled} lab day${info.scheduled === 1 ? '' : 's'}`
}

/** Percent label, e.g. "80%". */
export function formatProrationPercent(info) {
  const f = info && typeof info.factor === 'number' ? info.factor : 1
  return `${Math.round(f * 100)}%`
}

// ─── Finals week ──────────────────────────────────────────────────────────────

export const DEFAULT_FINALS_REQUIRED_HOURS = 2

/**
 * When finals start mid-week, add the exam hours on top of the prorated
 * regular hours for that split week (8 × 3/5 + 2 = 6.8). false → 4.8 only.
 */
export const SPLIT_WEEK_ADDS_EXAM_HOURS = true

/**
 * True when the Monday-anchored week is a finals week for the class. Same
 * test as buildClassWeeks(): the week's Monday falls inside
 * [finals_start, finals_end]. Accepts snake_case (DB row) or camelCase.
 */
export function isFinalsWeek(mondayKey, cls) {
  const monday = mondayKeyOf(mondayKey)
  if (!monday || !cls) return false
  const fs = cls.finals_start || cls.finalsStart
  const fe = cls.finals_end || cls.finalsEnd
  if (!fs || !fe) return false
  return monday >= String(fs).substring(0, 10) && monday <= String(fe).substring(0, 10)
}

/**
 * @typedef {Object} WeekRequirement
 * @property {number}        hours         base requirement for the week (before make-up)
 * @property {number}        nominalHours  classes.required_hours
 * @property {boolean}       isFinals      finals hours applied (full or split week)
 * @property {boolean}       finalsSplit   finals started mid-week; regular days prorated
 * @property {number}        examHours     finals hours included in `hours` (0 if none)
 * @property {ProrationInfo} closure       proration used (FULL_WEEK on full finals weeks)
 * @property {string}        closureLabel  '' when not adjusted
 */

/**
 * Base weekly requirement with both policies applied, in order:
 *   finals week → flat finals hours (no closure proration)
 *   otherwise   → required_hours × closure factor
 * Make-up hours are added by the caller AFTER this.
 *
 * @param {ClosureOverlay} overlay
 * @param {Object}  p
 * @param {number}  p.baseHours   classes.required_hours
 * @param {string}  p.mondayKey   week start (any date in the week works)
 * @param {Object}  [p.cls]       class row (start/end/finals dates)
 * @param {boolean} [p.isFinals]  pass when already known (buildClassWeeks); else derived from cls
 */
export function weekBaseRequirement(overlay, { baseHours, mondayKey, cls, isFinals } = {}) {
  const nominal = Number(baseHours) || 0
  const examHours = Math.round((Number(overlay?.finalsHours ?? DEFAULT_FINALS_REQUIRED_HOURS) || 0) * 100) / 100
  const finals = typeof isFinals === 'boolean' ? isFinals : isFinalsWeek(mondayKey, cls)

  // Full finals week (Monday inside finals window): flat exam hours
  if (finals) {
    return { hours: examHours, nominalHours: nominal, isFinals: true, finalsSplit: false, examHours, closure: { ...FULL_WEEK }, closureLabel: '' }
  }

  const classStart = cls?.start_date || cls?.startDate
  const classEnd = cls?.end_date || cls?.endDate
  const finalsStart = cls?.finals_start || cls?.finalsStart
  const closure = overlay.forWeek(mondayKey, classStart, classEnd, finalsStart)

  // Split week: finals begin mid-week. Regular days prorate; exam hours add on top.
  if (closure.finalsDays > 0) {
    const regular = prorateHours(nominal, closure)
    const exam = SPLIT_WEEK_ADDS_EXAM_HOURS ? examHours : 0
    return {
      hours: Math.round((regular + exam) * 100) / 100,
      nominalHours: nominal, isFinals: true, finalsSplit: true, examHours: exam,
      closure, closureLabel: describeProration(closure),
    }
  }

  return { hours: prorateHours(nominal, closure), nominalHours: nominal, isFinals: false, finalsSplit: false, examHours: 0, closure, closureLabel: describeProration(closure) }
}

// ─── Data access ──────────────────────────────────────────────────────────────

/** Read `finals_required_hours` from settings (default 2; never throws). */
export async function fetchFinalsRequiredHours() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('setting_value')
      .eq('setting_key', 'finals_required_hours')
      .maybeSingle()
    if (error) throw error
    const n = parseFloat(data?.setting_value)
    return isNaN(n) || n < 0 ? DEFAULT_FINALS_REQUIRED_HOURS : n
  } catch (err) {
    console.error('Error loading finals_required_hours:', err?.message || err)
    return DEFAULT_FINALS_REQUIRED_HOURS
  }
}

/**
 * Fetch every Closed lab_calendar day in [rangeStart, rangeEnd] (date-only
 * strings, inclusive). Returns a Set of 'YYYY-MM-DD' plus a reasons map from
 * the row's `notes` (e.g. "Labor Day") for display.
 *
 * lab_calendar.date is stored as fake-UTC midnight; comparing on the
 * date-only prefix is safe for a whole-day range.
 */
export async function fetchClosedLabDays({ rangeStart, rangeEnd } = {}) {
  let q = supabase
    .from('lab_calendar')
    .select('date, status, notes')
    .eq('status', 'Closed')
  if (rangeStart) q = q.gte('date', `${String(rangeStart).substring(0, 10)}T00:00:00`)
  if (rangeEnd) q = q.lte('date', `${String(rangeEnd).substring(0, 10)}T23:59:59`)

  const rows = mustData(await q, 'lab_calendar.closed.select') || []
  const closedDates = new Set()
  const reasons = {}
  rows.forEach(r => {
    const key = String(r.date || '').substring(0, 10)
    if (!key) return
    closedDates.add(key)
    if (r.notes) reasons[key] = r.notes
  })
  return { closedDates, reasons }
}

/**
 * @typedef {Object} ClosureOverlay
 * @property {Set<string>}          closedDates
 * @property {Object<string,string>} reasons     date → notes
 * @property {number[]}             visibleDays  lab_visible_days in effect
 * @property {(mondayKey:string, classStart?:string, classEnd?:string) => ProrationInfo} forWeek
 */

/**
 * Load closed days for a range and return an overlay whose `forWeek()`
 * computes the ProrationInfo for any Monday inside it. Pads the range to
 * whole weeks so the first/last week are never partially loaded.
 */
export async function fetchClosureOverlay({ rangeStart, rangeEnd } = {}) {
  const [visibleDays, finalsHours] = await Promise.all([fetchLabVisibleDays(), fetchFinalsRequiredHours()])

  // Pad to whole Monday-anchored weeks
  let padStart = rangeStart ? mondayKeyOf(rangeStart) : undefined
  let padEnd
  if (rangeEnd) {
    const m = parseLocal(mondayKeyOf(rangeEnd))
    m.setDate(m.getDate() + 6)
    padEnd = toKey(m)
  }

  let closedDates = new Set()
  let reasons = {}
  try {
    const res = await fetchClosedLabDays({ rangeStart: padStart, rangeEnd: padEnd })
    closedDates = res.closedDates
    reasons = res.reasons
  } catch (err) {
    // A failed read must not silently inflate the requirement in the other
    // direction; log and fall back to "no closures" (full hours), matching
    // the make-up overlay's fail-safe behavior.
    console.error('fetchClosureOverlay failed:', err?.message || err)
  }

  return buildClosureOverlay({ closedDates, reasons, visibleDays, finalsHours })
}

/** Build an overlay from data already in hand (e.g. lab-signup week data). */
export function buildClosureOverlay({ closedDates, reasons = {}, visibleDays, finalsHours = DEFAULT_FINALS_REQUIRED_HOURS } = {}) {
  const set = closedDates instanceof Set ? closedDates : new Set(closedDates || [])
  const days = visibleDays && visibleDays.length > 0 ? visibleDays : getCachedLabDays()
  const cache = new Map()
  return {
    closedDates: set,
    reasons,
    visibleDays: days,
    finalsHours,
    forWeek(mondayKey, classStart, classEnd, finalsStart) {
      const key = `${mondayKey}|${classStart || ''}|${classEnd || ''}|${finalsStart || ''}`
      if (cache.has(key)) return cache.get(key)
      const info = prorationForWeek({ mondayKey, visibleDays: days, closedDates: set, classStart, classEnd, finalsStart })
      cache.set(key, info)
      return info
    },
  }
}

/** One-shot base requirement for a single week (used by the notification bell). */
export async function fetchWeekRequirement({ baseHours, mondayKey, cls } = {}) {
  const monday = mondayKeyOf(mondayKey)
  const overlay = monday
    ? await fetchClosureOverlay({ rangeStart: monday, rangeEnd: monday })
    : buildClosureOverlay({ closedDates: new Set(), finalsHours: await fetchFinalsRequiredHours() })
  return weekBaseRequirement(overlay, { baseHours, mondayKey: monday, cls })
}

/** One-shot proration for a single week. */
export async function fetchWeekProration({ mondayKey, classStart, classEnd } = {}) {
  const monday = mondayKeyOf(mondayKey)
  if (!monday) return { ...FULL_WEEK }
  const overlay = await fetchClosureOverlay({ rangeStart: monday, rangeEnd: monday })
  return overlay.forWeek(monday, classStart, classEnd)
}

// ─── React hook ───────────────────────────────────────────────────────────────

const EMPTY_OVERLAY = buildClosureOverlay({ closedDates: new Set() })

/**
 * Reactive closure overlay for a page. Refreshes on any lab_calendar change
 * and when lab_visible_days changes (denominator).
 *
 * @param {Object}  p
 * @param {string}  p.rangeStart  'YYYY-MM-DD'
 * @param {string}  p.rangeEnd    'YYYY-MM-DD'
 * @param {boolean} [p.enabled=true]
 * @returns {{ overlay: ClosureOverlay, loading: boolean, refresh: () => Promise<void> }}
 */
export function useClosureOverlay({ rangeStart, rangeEnd, enabled = true } = {}) {
  const [overlay, setOverlay] = useState(EMPTY_OVERLAY)
  const [loading, setLoading] = useState(!!enabled)
  const latest = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled || !rangeStart || !rangeEnd) {
      setOverlay(EMPTY_OVERLAY)
      setLoading(false)
      return
    }
    const id = ++latest.current
    setLoading(true)
    const result = await fetchClosureOverlay({ rangeStart, rangeEnd })
    if (id === latest.current) { setOverlay(result); setLoading(false) }
  }, [enabled, rangeStart, rangeEnd])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!enabled) return undefined
    return subscribeWithReconnect('closure-overlay', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings', filter: 'setting_key=eq.lab_visible_days' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings', filter: 'setting_key=eq.finals_required_hours' }, refresh)
    )
  }, [enabled, refresh])

  return { overlay, loading, refresh }
}
