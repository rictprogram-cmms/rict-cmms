/**
 * RICT CMMS — useAccountabilityAlerts
 *
 * Data layer for the instructor Dashboard "Students to check on" card.
 *
 *   • The card READS accountability_alerts (fast — one small table).
 *   • A SWEEP re-evaluates every active Student / Work Study against the
 *     pattern rules in src/lib/accountabilityAlerts.js and reconciles the
 *     table: existing open alert → refresh last_seen / weeks_seen / detail;
 *     new pattern → insert; pattern gone → cleared_at. It runs in the
 *     background when an instructor opens the Dashboard and the last sweep is
 *     older than `accountability_sweep_hours` (default 6), or on demand.
 *   • Acknowledge is shared (one conversation with the student, not one per
 *     instructor): it hides the row from the card but leaves it open, so a
 *     pattern that persists comes back as "still open, week N".
 *
 * The sweep uses loadStudentReport() with skipWoc so a 60-student pass
 * doesn't re-read every work order 60 times; work-order lateness for alerts
 * comes from report.meta.woLate instead.
 *
 * Two tabs could start a sweep at once: the start time is written to the
 * `accountability_last_sweep` setting BEFORE the pass, so the second tab sees
 * a fresh stamp and skips. The unique partial index on (email, rule) WHERE
 * status='open' makes a duplicate insert harmless either way.
 *
 * Exports
 *   useAccountabilityAlerts({ enabled }) → { alerts, loading, sweeping, progress, lastSweep,
 *                                           error, acknowledge, unacknowledge, sweepNow, refresh }
 *
 * File: src/hooks/useAccountabilityAlerts.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import { SUPER_ADMIN_EMAIL } from '@/lib/superAdmin'
import { currentTerm } from '@/lib/academicTerms'
import { loadShared, loadStudentReport } from '@/hooks/useAccountabilityReport'
import { evaluateAlerts, readThresholds, ALERT_DEFAULTS } from '@/lib/accountabilityAlerts'
import { lower } from '@/lib/accountabilityRules'

const SETTING_KEYS = [...Object.keys(ALERT_DEFAULTS), 'accountability_last_sweep']
let sweepInFlight = false   // module-level: one sweep per browser tab at a time

function weeksBetween(a, b) {
  const t0 = new Date(a).getTime(), t1 = new Date(b).getTime()
  if (isNaN(t0) || isNaN(t1)) return 1
  return Math.max(1, Math.floor((t1 - t0) / (7 * 86400000)) + 1)
}

async function readSettings() {
  const rows = mustData(await supabase.from('settings').select('setting_key, setting_value').in('setting_key', SETTING_KEYS), 'settings.select') || []
  return new Map(rows.map(r => [r.setting_key, r.setting_value]))
}

async function writeLastSweep(value) {
  const { error } = await supabase.from('settings').update({ setting_value: value, updated_at: new Date().toISOString(), updated_by: 'alert sweep' }).eq('setting_key', 'accountability_last_sweep')
  if (error) console.warn('accountability_last_sweep not updated:', error.message)
}

/**
 * The stamp is 'started:<iso>' while a sweep is running and a bare '<iso>'
 * once it finished. The sweep runs in the instructor's browser tab, so a
 * closed tab or a reload kills it half-way; a 'started:' stamp older than
 * STALE_START_MIN is treated as abandoned and the next Dashboard visit runs
 * the sweep again (already-written alerts are simply refreshed).
 */
const STALE_START_MIN = 20
export function parseSweepStamp(value) {
  const v = String(value || '')
  if (v.startsWith('started:')) return { iso: v.slice(8), running: true }
  return { iso: v, running: false }
}
export function sweepIsDue(value, hours) {
  const { iso, running } = parseSweepStamp(value)
  if (!iso) return true
  const age = Date.now() - new Date(iso).getTime()
  if (isNaN(age)) return true
  if (running) return age > STALE_START_MIN * 60000        // abandoned mid-way
  return age > hours * 3600000
}

/**
 * Run one sweep. Pure orchestration; returns { students, fired, cleared }.
 * `onProgress(done, total)` is optional.
 */
export async function runAlertSweep({ profile, onProgress } = {}) {
  const settings = await readSettings()
  const thresholds = readThresholds(settings)

  const terms = mustData(await supabase.from('academic_terms').select('term_id, name, season, year, begin_date, end_date, finals_end, status'), 'academic_terms.select') || []
  const term = currentTerm(terms)
  if (!term) throw new Error('No current academic term — add one under Settings → Terms.')

  await writeLastSweep('started:' + new Date().toISOString())   // claim the sweep before the slow part

  const shared = await loadShared(term)
  const people = (mustData(await supabase.from('profiles')
    .select('user_id, id, email, first_name, last_name, role, status, classes, created_at, time_clock_only')
    .eq('status', 'Active').in('role', ['Student', 'Work Study']).neq('email', SUPER_ADMIN_EMAIL), 'profiles.select') || [])
    .filter(p => p.email && !(p.time_clock_only === 'Yes' || p.time_clock_only === true))

  const open = mustData(await supabase.from('accountability_alerts').select('*').eq('status', 'open'), 'accountability_alerts.select') || []
  const openByKey = new Map(open.map(a => [`${lower(a.user_email)}|${a.rule}`, a]))
  const now = new Date().toISOString()
  const seen = new Set()
  let fired = 0, cleared = 0, done = 0
  const CONCURRENCY = 3

  for (let i = 0; i < people.length; i += CONCURRENCY) {
    const batch = people.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async p => {
      try {
        const r = await loadStudentReport(p, term, shared, { studentView: false, canViewNotes: false, skipWoc: true })
        return { p, alerts: evaluateAlerts(r.report, thresholds) }
      } catch (e) {
        console.warn('alert sweep: student skipped', p.email, e?.message || e)
        return { p, alerts: null }   // null = unknown, do NOT clear their open alerts
      }
    }))
    for (const { p, alerts } of results) {
      if (!alerts) continue
      const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email
      for (const a of alerts) {
        const key = `${lower(p.email)}|${a.rule}`
        seen.add(key)
        const existing = openByKey.get(key)
        if (existing) {
          const { error } = await supabase.from('accountability_alerts').update({
            last_seen: now, weeks_seen: weeksBetween(existing.first_seen, now), detail: a.detail, tier: a.tier,
            class_ids: a.classIds || existing.class_ids, user_name: name, term_id: term.term_id,
          }).eq('alert_id', existing.alert_id)
          if (error) console.warn('alert update failed:', error.message)
        } else {
          const { error } = await supabase.from('accountability_alerts').insert({
            user_email: p.email, user_name: name, term_id: term.term_id, rule: a.rule, tier: a.tier,
            detail: a.detail, class_ids: a.classIds || null, status: 'open', first_seen: now, last_seen: now, weeks_seen: 1,
          })
          if (error && error.code !== '23505') console.warn('alert insert failed:', error.message)
          else if (!error) fired++
        }
      }
      // Rules that stopped firing for this student → clear
      for (const [key, existing] of openByKey) {
        if (!key.startsWith(`${lower(p.email)}|`) || seen.has(key)) continue
        const { error } = await supabase.from('accountability_alerts').update({ status: 'cleared', cleared_at: now }).eq('alert_id', existing.alert_id)
        if (!error) { cleared++; openByKey.delete(key) }
      }
    }
    done += batch.length
    onProgress?.(done, people.length)
  }

  await writeLastSweep(new Date().toISOString())
  return { students: people.length, fired, cleared, term }
}

export function useAccountabilityAlerts({ enabled = true } = {}) {
  const { profile } = useAuth()
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [sweeping, setSweeping] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [lastSweep, setLastSweep] = useState('')
  const [sweepHours, setSweepHours] = useState(ALERT_DEFAULTS.accountability_sweep_hours)
  const [error, setError] = useState('')
  // StrictMode (dev) mounts → unmounts → mounts again; the flag must be set
  // true on every mount, not only at first render, or every update is dropped.
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const refresh = useCallback(async () => {
    if (!enabled) { setLoading(false); return }
    try {
      const [rowsRes, settings] = await Promise.all([
        supabase.from('accountability_alerts').select('*').eq('status', 'open').order('tier').order('last_seen', { ascending: false }),
        readSettings(),
      ])
      const rows = mustData(rowsRes, 'accountability_alerts.select') || []
      if (!mounted.current) return
      setAlerts(rows)
      setLastSweep(parseSweepStamp(settings.get('accountability_last_sweep')).iso)
      const h = parseFloat(settings.get('accountability_sweep_hours'))
      setSweepHours(isNaN(h) || h <= 0 ? ALERT_DEFAULTS.accountability_sweep_hours : h)
      setError('')
    } catch (e) {
      console.error('useAccountabilityAlerts:', e)
      if (mounted.current) setError(e?.message || 'Alerts could not be loaded.')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [enabled])

  const sweepNow = useCallback(async () => {
    if (sweepInFlight) return
    sweepInFlight = true
    setSweeping(true); setProgress({ done: 0, total: 0 })
    try {
      await runAlertSweep({ profile, onProgress: (d, t) => { if (mounted.current) setProgress({ done: d, total: t }) } })
    } catch (e) {
      console.error('alert sweep failed:', e)
      if (mounted.current) setError(e?.message || 'The alert check failed.')
    } finally {
      sweepInFlight = false
      if (mounted.current) { setSweeping(false); refresh() }
    }
  }, [profile, refresh])

  // Initial read, then a background sweep if the last one is stale
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    ;(async () => {
      await refresh()
      if (cancelled) return
      try {
        const settings = await readSettings()
        const last = settings.get('accountability_last_sweep') || ''
        const h = parseFloat(settings.get('accountability_sweep_hours'))
        const hours = isNaN(h) || h <= 0 ? ALERT_DEFAULTS.accountability_sweep_hours : h
        if (sweepIsDue(last, hours) && !cancelled) sweepNow()
      } catch {}
    })()
    return () => { cancelled = true }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: another instructor acknowledging / a sweep elsewhere
  useEffect(() => {
    if (!enabled) return undefined
    return subscribeWithReconnect(`accountability-alerts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accountability_alerts' }, () => refresh())
    , { tag: 'AccountabilityAlerts', onReconnect: refresh })
  }, [enabled, refresh])

  const acknowledge = useCallback(async (alertId) => {
    const name = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : ''
    const { error: err } = assertWrite(await supabase.from('accountability_alerts')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: name, acknowledged_by_email: profile?.email || null })
      .eq('alert_id', alertId).select(), 'accountability_alerts.update')
    if (err) throw err
    await refresh()
  }, [profile, refresh])

  const unacknowledge = useCallback(async (alertId) => {
    const { error: err } = assertWrite(await supabase.from('accountability_alerts')
      .update({ acknowledged_at: null, acknowledged_by: null, acknowledged_by_email: null })
      .eq('alert_id', alertId).select(), 'accountability_alerts.update')
    if (err) throw err
    await refresh()
  }, [refresh])

  return { alerts, loading, sweeping, progress, lastSweep, sweepHours, error, acknowledge, unacknowledge, sweepNow, refresh }
}
