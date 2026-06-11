import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * useLabDays — single source of truth for the `lab_visible_days` setting.
 *
 * The setting drives every page that depends on which weekdays the lab is
 * open: Lab Signup grid columns, Equipment Scheduling columns, the Weekly
 * Lab Tracker week ranges (Mon → last open day), the Classes-tab week
 * preview on the Settings page, and the WOC Ratio "school day" definition.
 *
 * Storage format: comma-separated day numbers in the `settings` table,
 * e.g. "1,2,3,4,5" (Sun=0, Mon=1, …, Sat=6). parseLabVisibleDays() also
 * tolerates a JSON-array string ("[1,2,3,4]") and real arrays defensively —
 * a JSON.parse on the comma format silently broke Equipment Scheduling once,
 * so ALL consumers must parse through this module rather than rolling their
 * own. (See changelog — Lab Open Days consistency fix.)
 *
 * Weeks are always anchored to Monday throughout the app (week_start keys,
 * tracker weeks, time cards). The "week end" is derived as the LAST open day
 * of the Monday-anchored week:
 *   Mon=offset 0 … Sat=offset 5, Sun=offset 6 (Sunday closes the week).
 *   Default Mon–Thu → offset 3. Mon–Fri → offset 4.
 */

// Default matches the app's historical Mon–Thu behavior.
export const DEFAULT_LAB_DAYS = [1, 2, 3, 4]

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Normalize any candidate list to sorted, unique ints 0–6. Empty → default. */
function normalizeDays(list) {
  const days = [...new Set(
    (list || [])
      .map(d => parseInt(d, 10))
      .filter(d => !isNaN(d) && d >= 0 && d <= 6)
  )].sort((a, b) => a - b)
  return days.length > 0 ? days : [...DEFAULT_LAB_DAYS]
}

/**
 * Parse a `lab_visible_days` setting value into an array of day numbers.
 * Accepts: comma string ("1,2,3,4,5"), JSON-array string ("[1,2,3,4]"),
 * or an actual array. Anything unparseable falls back to DEFAULT_LAB_DAYS.
 */
export function parseLabVisibleDays(value) {
  if (Array.isArray(value)) return normalizeDays(value)
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t) return [...DEFAULT_LAB_DAYS]
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        if (Array.isArray(parsed)) return normalizeDays(parsed)
      } catch {
        // fall through to comma parsing
      }
    }
    return normalizeDays(t.split(','))
  }
  return [...DEFAULT_LAB_DAYS]
}

/**
 * Offset (in days) from Monday to the last open day of the week.
 * Weeks are Monday-anchored app-wide, so Mon→0, Tue→1, … Sat→5, Sun→6.
 * Mon–Thu → 3 (historical default). Mon–Fri → 4.
 */
export function weekEndOffsetFromDays(days) {
  const list = (days && days.length > 0) ? days : DEFAULT_LAB_DAYS
  const offsets = list.map(d => (d === 0 ? 6 : d - 1))
  return Math.max(...offsets)
}

/** Full name of the day a Monday-anchored week ends on (offset 3 → "Thursday"). */
export function weekEndDayName(weekEndOffset) {
  return DAY_NAMES[(weekEndOffset + 1) % 7]
}

/**
 * Human label for the open days, e.g. "Mon–Fri" when contiguous,
 * otherwise a comma list like "Mon, Wed, Fri".
 */
export function formatLabDaysShort(days) {
  const list = normalizeDays(days)
  // Order by Monday-anchored position so Sunday sorts last, then check contiguity
  const ordered = [...list].sort((a, b) => (a === 0 ? 6 : a - 1) - (b === 0 ? 6 : b - 1))
  const offsets = ordered.map(d => (d === 0 ? 6 : d - 1))
  const contiguous = offsets.every((o, i) => i === 0 || o === offsets[i - 1] + 1)
  if (contiguous && ordered.length > 1) {
    return `${DAY_NAMES_SHORT[ordered[0]]}–${DAY_NAMES_SHORT[ordered[ordered.length - 1]]}`
  }
  return ordered.map(d => DAY_NAMES_SHORT[d]).join(', ')
}

// ─── Module-level cache ──────────────────────────────────────────────────────
// buildClassWeeks() (useWeeklyLabs.js) is a synchronous pure function called
// from several hooks — including useTimeCards, which doesn't fetch this
// setting itself. The cache gives those callers the live value via the
// default parameter without making buildClassWeeks async. The cache is
// warmed eagerly at module load (below) and refreshed by every
// fetchLabVisibleDays() call, so by the time any data-driven render happens
// it reflects the database.

let cachedDays = [...DEFAULT_LAB_DAYS]
let cachedWeekEndOffset = weekEndOffsetFromDays(DEFAULT_LAB_DAYS)

export function getCachedLabDays() { return cachedDays }
export function getCachedWeekEndOffset() { return cachedWeekEndOffset }

/**
 * Fetch the current lab_visible_days value, update the module cache, and
 * return the parsed day array. On any error the previous cache is returned
 * unchanged (never throws).
 */
export async function fetchLabVisibleDays() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('setting_value')
      .eq('setting_key', 'lab_visible_days')
      .maybeSingle()
    if (error) throw error
    const days = parseLabVisibleDays(data?.setting_value)
    cachedDays = days
    cachedWeekEndOffset = weekEndOffsetFromDays(days)
    return days
  } catch (err) {
    console.error('Error loading lab_visible_days:', err)
    return cachedDays
  }
}

// Eager warm-up: kick off one fetch as soon as this module is imported so the
// cache is populated before any page's data fetches complete. Fire-and-forget;
// errors are already swallowed inside fetchLabVisibleDays.
fetchLabVisibleDays()

// ─── React hook ──────────────────────────────────────────────────────────────

/**
 * useLabVisibleDays — live lab-days value with realtime updates.
 *
 * Returns { days, weekEndOffset, loaded }:
 *   days          — sorted array of open day numbers (Sun=0…Sat=6)
 *   weekEndOffset — offset from Monday to the last open day (Thu=3, Fri=4)
 *   loaded        — true once the first fetch has resolved
 *
 * Subscribes to settings-table changes filtered to lab_visible_days, so
 * toggling a day on the Settings page updates consumers (Classes-tab week
 * preview, Equipment Scheduling columns, etc.) without a reload. Channel
 * name is unique per mount to avoid collisions (app convention).
 */
export function useLabVisibleDays() {
  const [days, setDays] = useState(() => getCachedLabDays())
  const [loaded, setLoaded] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    // Only swap state when the value actually changed — keeps the array
    // identity stable so consumers using `days` in dependency arrays
    // (e.g. useEquipmentBookingsData) don't refetch needlessly.
    const apply = (next) => {
      if (!mountedRef.current) return
      setDays(prev => (prev.join(',') === next.join(',') ? prev : next))
    }

    fetchLabVisibleDays().then(d => {
      apply(d)
      if (mountedRef.current) setLoaded(true)
    })

    const channelName = `lab-days-${Math.random().toString(36).slice(2)}-${Date.now()}`
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settings', filter: 'setting_key=eq.lab_visible_days' },
        () => { fetchLabVisibleDays().then(apply) }
      )
      .subscribe()

    return () => {
      mountedRef.current = false
      supabase.removeChannel(channel)
    }
  }, [])

  return { days, weekEndOffset: weekEndOffsetFromDays(days), loaded }
}
