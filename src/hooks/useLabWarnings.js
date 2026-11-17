/**
 * RICT CMMS — useLabWarnings
 *
 * Lab sign-up warnings (stage 1). Three steps per term — warning 1, warning
 * 2, final — sent from the Dashboard "Lab sign-ups" list, or logged by hand
 * for warnings given before this feature existed. Every event is a permanent
 * row in `lab_warnings` (the database refuses edits; the app has no delete).
 * A reset adds a row, so history is never erased; a student's current level
 * is the number of warnings since their last reset in that term.
 *
 *   useLabWarnings({ termId, studentEmail?, enabled })
 *       → { rows, byEmail, loading, error, refresh }
 *       rows      — every event for the term (one student when studentEmail
 *                   is given), oldest first
 *       byEmail   — Map<email, summary> (see summarizeLabWarnings)
 *       Realtime on lab_warnings; reads go through mustData() so a failed
 *       read keeps the last good result instead of showing "no warnings".
 *
 *   useLabWarningActions()
 *       → { busy, sendWarning, logWarning, resetWarnings }
 *       All writes go through SECURITY DEFINER RPCs (migration
 *       20261116_lab_warnings.sql), which check Lab Signup → manage_warnings,
 *       lock the student+term, and refuse if `expectedLevel` no longer
 *       matches (another instructor acted a moment earlier). Each returns
 *       the saved row, or throws an Error with a plain-English message.
 *
 *   summarizeLabWarnings(rows) → Map<email, {
 *       email, name, level (0..3), isFinal, lastWarning, current[], previous[],
 *       resets[], events[] }>
 *
 *   termForDate(terms, 'YYYY-MM-DD') → the term covering that day (or the
 *       week starting that Monday) — same rule as lab_warning_term_for().
 *
 * Timestamps: created_at / seen_at are REAL UTC (Convention B); sent_on and
 * week_of are date-only strings (parse with T00:00:00).
 *
 * File: src/hooks/useLabWarnings.js
 */

import { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'

export const MAX_WARNING_LEVEL = 3

export const WARNING_METHODS = ['Email', 'In person', 'Teams', 'Phone', 'Other']

const COLS = 'id, student_email, student_name, term_id, kind, level, source, method, sent_on, week_of, shortage, subject, message, reason, actor_email, actor_name, created_at, announcement_id, seen_at, email_status, email_sent_at'

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function levelLabel(level) {
  if (!level) return 'No warnings'
  if (level >= MAX_WARNING_LEVEL) return 'Final warning sent'
  return `Warned ${level} of ${MAX_WARNING_LEVEL}`
}

export function nextStepLabel(level) {
  const next = (level || 0) + 1
  if (next > MAX_WARNING_LEVEL) return null
  return next === MAX_WARNING_LEVEL ? 'final warning' : `warning ${next} of ${MAX_WARNING_LEVEL}`
}

/** 'YYYY-MM-DD' → 'Nov 9' (or 'Nov 9, 2026' with year). */
export function fmtDay(s, withYear = false) {
  if (!s) return ''
  const d = new Date(`${String(s).substring(0, 10)}T00:00:00`)
  if (isNaN(d)) return ''
  return d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
}

/** Real-UTC timestamp → 'Nov 9, 2:14 PM'. */
export function fmtStamp(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d)) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function summarizeLabWarnings(rows) {
  const map = new Map()
  for (const r of rows || []) {
    const email = String(r.student_email || '').toLowerCase()
    if (!map.has(email)) {
      map.set(email, { email, name: r.student_name || email, level: 0, isFinal: false, lastWarning: null, current: [], previous: [], resets: [], events: [] })
    }
    const s = map.get(email)
    s.events.push(r)
    if (r.kind === 'reset') {
      s.previous.push(...s.current)
      s.current = []
      s.resets.push(r)
    } else {
      s.current.push(r)
    }
  }
  for (const s of map.values()) {
    s.level = s.current.length
    s.isFinal = s.level >= MAX_WARNING_LEVEL
    s.lastWarning = s.current[s.current.length - 1] || null
  }
  return map
}

export function termForDate(terms, dateStr) {
  if (!dateStr) return null
  const d = new Date(`${String(dateStr).substring(0, 10)}T00:00:00`)
  if (isNaN(d)) return null
  const hits = (terms || []).filter(t => {
    if (!t.begin_date || !t.end_date) return false
    const b = new Date(`${String(t.begin_date).substring(0, 10)}T00:00:00`)
    const e = new Date(`${String(t.end_date).substring(0, 10)}T00:00:00`)
    b.setDate(b.getDate() - 6)
    return d >= b && d <= e
  })
  hits.sort((a, b) => String(b.begin_date).localeCompare(String(a.begin_date)))
  return hits[0] || null
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function useLabWarnings({ termId, studentEmail = '', enabled = true } = {}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(!!(enabled && termId))
  const [error, setError] = useState('')
  const seq = useRef(0)
  const uid = useId()
  const email = String(studentEmail || '').toLowerCase()

  const load = useCallback(async () => {
    if (!enabled || !termId) { setRows([]); setLoading(false); return }
    const my = ++seq.current
    try {
      let q = supabase.from('lab_warnings').select(COLS).eq('term_id', termId)
      if (email) q = q.eq('student_email', email)
      const data = mustData(await q.order('id', { ascending: true }), 'lab_warnings.select') || []
      if (my === seq.current) { setRows(data); setError('') }
    } catch (e) {
      console.warn('useLabWarnings: read failed (keeping last result):', e?.message || e)
      if (my === seq.current) setError('Couldn’t load lab warnings. Showing the last loaded list.')
    }
    if (my === seq.current) setLoading(false)
  }, [enabled, termId, email])

  useEffect(() => { setLoading(!!(enabled && termId)); load() }, [load, enabled, termId])

  useEffect(() => {
    if (!enabled || !termId) return undefined
    return subscribeWithReconnect(`lab-warnings-${uid}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_warnings' }, load)
    , { tag: 'LabWarnings', onReconnect: load })
  }, [enabled, termId, load, uid])

  const byEmail = useMemo(() => summarizeLabWarnings(rows), [rows])
  return { rows, byEmail, loading, error, refresh: load }
}

// ─── Write ────────────────────────────────────────────────────────────────────

function friendly(err, fallback) {
  const msg = err?.cause?.message || err?.message || ''
  // RPC errors arrive as "lab_warning_send: <message>" from mustData()
  const clean = msg.replace(/^lab_warning_\w+:\s*/, '').trim()
  return new Error(clean || fallback)
}

export function useLabWarningActions() {
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (fn, args, fallback) => {
    setBusy(true)
    try {
      const data = mustData(await supabase.rpc(fn, args), fn)
      const row = Array.isArray(data) ? data[0] : data
      if (!row || !row.id) throw new Error(`${fn}: nothing was saved`)
      return row
    } catch (e) {
      throw friendly(e, fallback)
    } finally {
      setBusy(false)
    }
  }, [])

  /** Send the next warning from the app (bell notification to the student). */
  const sendWarning = useCallback(({ email, weekOf, shortage, expectedLevel }) => run('lab_warning_send', {
    p_student_email: email,
    p_week_of: weekOf || null,
    p_shortage: shortage || null,
    p_expected_level: expectedLevel ?? null,
  }, 'The warning could not be sent.'), [run])

  /** Record a warning given before (Outlook email, in person…). No notification. */
  const logWarning = useCallback(({ email, sentOn, method, message, weekOf, shortage, expectedLevel }) => run('lab_warning_log', {
    p_student_email: email,
    p_sent_on: sentOn,
    p_method: method,
    p_message: message,
    p_week_of: weekOf || null,
    p_shortage: shortage || null,
    p_expected_level: expectedLevel ?? null,
  }, 'The past warning could not be saved.'), [run])

  /** Start the student over at 0 for this term (history is kept). */
  const resetWarnings = useCallback(({ email, termId, reason }) => run('lab_warning_reset', {
    p_student_email: email,
    p_term_id: termId,
    p_reason: reason || null,
  }, 'The warnings could not be reset.'), [run])

  return { busy, sendWarning, logWarning, resetWarnings }
}
