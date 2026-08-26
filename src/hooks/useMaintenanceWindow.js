// ═══════════════════════════════════════════════════════════════════════════════
// useMaintenanceWindow — shared reader for the Planned Maintenance schedule
//
// Settings keys (all stored in the `settings` table, category 'System'):
//   maintenance_start_at     fake-UTC timestamp — when the shutdown begins
//   maintenance_end_at       fake-UTC timestamp — expected return (optional)
//   maintenance_message      one-line note shown to users (optional)
//   maintenance_notice_days  how many days before start the banner appears
//
// The schedule is informational: it drives the dashboard banner and the copy
// on the locked screens. The actual lockout is still the `lab_access_mode`
// setting, flipped manually by the super admin (see LabAccessModeCard).
//
// Fake-UTC convention: timestamps store local wall-clock time tagged +00.
// Always read them with getUTC*() and write them with localToUtcIso().
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { localToUtcIso } from '@/hooks/useAssetCheckouts'

export { localToUtcIso }

export const MAINTENANCE_KEYS = [
  'maintenance_start_at',
  'maintenance_end_at',
  'maintenance_message',
  'maintenance_notice_days',
]

export const DEFAULT_NOTICE_DAYS = 14

// ── Fake-UTC helpers ─────────────────────────────────────────────────────────

/** Fake-UTC ISO → real local Date (wall-clock values preserved). */
export function fakeUtcToLocalDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  )
}

/** Fake-UTC ISO → value for an <input type="datetime-local"> (YYYY-MM-DDTHH:MM). */
export function fakeUtcToInputValue(iso) {
  const d = fakeUtcToLocalDate(iso)
  if (!d) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** <input type="datetime-local"> value → fake-UTC ISO (or null when empty). */
export function inputValueToFakeUtc(value) {
  if (!value) return null
  // datetime-local values have no offset, so new Date() parses them as local.
  return localToUtcIso(new Date(value))
}

/** "Fri, Aug 29 at 5:00 PM" */
export function formatMaintenanceDateTime(iso) {
  const d = fakeUtcToLocalDate(iso)
  if (!d) return ''
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} at ${time}`
}

/** Human countdown from `now` to `target`: "3 days", "5 hours", "20 minutes". */
export function formatCountdown(target, now = new Date()) {
  if (!target) return ''
  const ms = target.getTime() - now.getTime()
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(ms / 3600000)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(ms / 86400000)
  return `${days} day${days === 1 ? '' : 's'}`
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Reads the maintenance schedule once, keeps it live via realtime, and
 * re-derives countdown state every 60 seconds.
 *
 * Returns:
 *   loading        — true until the first fetch resolves
 *   startAt/endAt  — raw fake-UTC strings (or null)
 *   startDate/endDate — local Date objects (or null)
 *   message        — string ('' when unset)
 *   noticeDays     — number (default 14)
 *   isScheduled    — a valid start time exists
 *   hasStarted     — now >= start
 *   isWithinNotice — now >= start − noticeDays
 *   countdown      — "3 days" / "now" / ''
 *   refresh()      — manual re-fetch
 */
export function useMaintenanceWindow() {
  const [loading, setLoading] = useState(true)
  const [values, setValues] = useState({})
  const [now, setNow] = useState(() => new Date())

  const fetchAll = useCallback(async () => {
    try {
      const rows = mustData(await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', MAINTENANCE_KEYS), 'settings.select')
      const next = {}
      ;(rows || []).forEach(r => { next[r.setting_key] = r.setting_value })
      setValues(next)
    } catch (e) {
      console.warn('[MaintenanceWindow] fetch error:', e?.message || e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Realtime — any change to one of the four keys updates local state.
  // Unfiltered on the table so INSERT (first-time seed) and UPDATE both land;
  // the key check keeps unrelated settings out.
  useEffect(() => {
    const channelId = `maintenance-window-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const channel = subscribeWithReconnect(channelId, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload) => {
        const key = payload.new?.setting_key || payload.old?.setting_key
        if (!MAINTENANCE_KEYS.includes(key)) return
        setValues(prev => ({ ...prev, [key]: payload.eventType === 'DELETE' ? null : payload.new?.setting_value }))
      }))
    return () => { channel() }
  }, [])

  // Once-a-minute tick so countdowns stay honest without flooding live regions
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  return useMemo(() => {
    const startAt = values.maintenance_start_at || null
    const endAt = values.maintenance_end_at || null
    const message = (values.maintenance_message || '').trim()
    const parsedDays = parseInt(values.maintenance_notice_days, 10)
    const noticeDays = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : DEFAULT_NOTICE_DAYS

    const startDate = fakeUtcToLocalDate(startAt)
    const endDate = fakeUtcToLocalDate(endAt)
    const isScheduled = !!startDate
    const hasStarted = isScheduled && now.getTime() >= startDate.getTime()
    const noticeFrom = isScheduled ? new Date(startDate.getTime() - noticeDays * 86400000) : null
    const isWithinNotice = isScheduled && now.getTime() >= noticeFrom.getTime()

    return {
      loading,
      startAt, endAt, startDate, endDate, message, noticeDays,
      isScheduled, hasStarted, isWithinNotice,
      countdown: isScheduled ? formatCountdown(startDate, now) : '',
      now,
      refresh: fetchAll,
    }
  }, [values, now, loading, fetchAll])
}
