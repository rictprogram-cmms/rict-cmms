/**
 * RICT CMMS — Lab sign-up warning UI (stage 1)
 *
 *   <LabWarningBadge summary />        small status chip under a student name
 *   <LabWarningHistory summary />      the permanent record, newest step last
 *   <LabWarningPanel … />              dialog: history + send next / log past /
 *                                      reset. Opened from the Dashboard
 *                                      "Lab sign-ups" list and the Metrics
 *                                      Report Student tab.
 *
 * Data and writes live in src/hooks/useLabWarnings.js. The panel never
 * guesses the level: it passes the level it is showing as `expectedLevel`,
 * and the database refuses the write if another instructor acted first.
 *
 * Accessibility (WCAG 2.1 AA / Section 508)
 *   • useDialogA11y: focus moves in, Tab trapped, Escape closes the top-most
 *     layer only (the panel stacks above the Dashboard list modal), focus
 *     returns to the student name that opened it.
 *   • Every button ≥ 44 px with a focus-visible ring; icon-only Close has an
 *     aria-label. Form fields have visible labels; errors use role="alert"
 *     and aria-describedby; results are announced in a polite live region.
 *   • Status is never colour-only: badges carry text ("Warned 2 of 3").
 *   • The history is an ordered list; each message is behind a disclosure
 *     button with aria-expanded / aria-controls.
 *
 * File: src/components/LabWarnings.jsx
 */

import { useState, useEffect, useId, useMemo } from 'react'
import { AlertTriangle, AlertOctagon, CheckCircle2, Circle, Loader2, Mail, NotebookPen, RotateCcw, Send, X, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import {
  useLabWarnings, useLabWarningActions, MAX_WARNING_LEVEL, WARNING_METHODS,
  levelLabel, nextStepLabel, fmtDay, fmtStamp,
} from '@/hooks/useLabWarnings'

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2'
const BTN = `min-h-[44px] px-4 py-2 text-sm font-medium rounded-lg inline-flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed ${FOCUS}`
const BTN_PRIMARY = `${BTN} bg-brand-600 text-white hover:bg-brand-700`
const BTN_DANGER = `${BTN} bg-red-600 text-white hover:bg-red-700`
const BTN_SECONDARY = `${BTN} bg-white border border-surface-300 text-surface-700 hover:bg-surface-50`

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── Badge ────────────────────────────────────────────────────────────────────

export function LabWarningBadge({ summary, className = '' }) {
  const level = summary?.level || 0
  const last = summary?.lastWarning
  if (!level) {
    if (!summary?.resets?.length) return null
    return (
      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-surface-100 text-surface-700 ${className}`}>
        <RotateCcw size={12} aria-hidden="true" /> Reset {fmtDay(summary.resets[summary.resets.length - 1].sent_on)}
      </span>
    )
  }
  const final = level >= MAX_WARNING_LEVEL
  const Icon = final ? AlertOctagon : AlertTriangle
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-md border ${final ? 'bg-red-50 text-red-800 border-red-200' : 'bg-amber-50 text-amber-900 border-amber-200'} ${className}`}>
      <Icon size={12} aria-hidden="true" />
      {levelLabel(level)}{last ? ` · ${fmtDay(last.sent_on)}` : ''}
    </span>
  )
}

// ─── History ──────────────────────────────────────────────────────────────────

function EventRow({ ev, studentView }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const isReset = ev.kind === 'reset'
  const manual = ev.source === 'manual'
  const who = ev.actor_name || ev.actor_email || 'Instructor'

  if (isReset) {
    return (
      <li className="py-2 flex gap-3">
        <RotateCcw size={18} className="text-surface-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <div className="font-medium text-surface-900">Warnings reset</div>
          <div className="text-surface-600">{fmtDay(ev.sent_on, true)} · by {who}{ev.reason ? ` — “${ev.reason}”` : ''}</div>
        </div>
      </li>
    )
  }

  const stepName = ev.level >= MAX_WARNING_LEVEL ? 'Final warning' : `Warning ${ev.level} of ${MAX_WARNING_LEVEL}`
  return (
    <li className="py-2 flex gap-3">
      <CheckCircle2 size={18} className={`${ev.level >= MAX_WARNING_LEVEL ? 'text-red-600' : 'text-amber-600'} mt-0.5 flex-shrink-0`} aria-hidden="true" />
      <div className="min-w-0 text-sm flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium text-surface-900">{stepName}</span>
          <span className="text-surface-600">{fmtDay(ev.sent_on, true)}{manual ? ` · ${ev.method}` : ''}</span>
        </div>
        <div className="text-surface-600">
          {manual
            ? <>Logged manually by {who} on {fmtDay(String(ev.created_at || '').substring(0, 10) || ev.sent_on)}</>
            : <>Sent by CMMS · {who}</>}
          {ev.week_of ? <> · week of {fmtDay(ev.week_of)}</> : null}
        </div>
        {ev.shortage && <div className="text-surface-700">Short: {ev.shortage}</div>}
        {!manual && (
          <div className="text-surface-600 inline-flex items-center gap-1">
            {ev.seen_at
              ? <><Eye size={14} aria-hidden="true" /> {studentView ? 'You opened it' : 'Opened'} {fmtStamp(ev.seen_at)}</>
              : <><EyeOff size={14} aria-hidden="true" /> Not opened yet</>}
          </div>
        )}
        {ev.message && (
          <div className="mt-1">
            <button
              type="button"
              className={`min-h-[44px] -ml-1 px-1 inline-flex items-center gap-1 text-brand-700 underline underline-offset-2 rounded ${FOCUS}`}
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen(o => !o)}
            >
              {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              {manual ? 'View note / email' : 'View message'}
            </button>
            {open && (
              <div id={bodyId} className="mt-1 p-3 rounded-lg bg-surface-50 border border-surface-200 text-surface-800 whitespace-pre-wrap break-words">
                {ev.subject && <div className="font-medium mb-1">{ev.subject}</div>}
                {ev.message}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export function LabWarningHistory({ summary, studentView = false, showUpcoming = true }) {
  const [showOld, setShowOld] = useState(false)
  const oldId = useId()
  const level = summary?.level || 0
  const current = summary?.current || []
  // Everything up to and including the last reset, in order.
  const older = useMemo(() => {
    const ev = summary?.events || []
    const lastReset = summary?.resets?.[summary.resets.length - 1]
    if (!lastReset) return []
    return ev.slice(0, ev.indexOf(lastReset) + 1)
  }, [summary])

  return (
    <div>
      <ol className="divide-y divide-surface-100" aria-label={studentView ? 'Your lab sign-up warnings this term' : 'Lab sign-up warnings this term'}>
        {current.map(ev => <EventRow key={ev.id} ev={ev} studentView={studentView} />)}
        {showUpcoming && Array.from({ length: Math.max(0, MAX_WARNING_LEVEL - level) }, (_, i) => level + i + 1).map(n => (
          <li key={`next-${n}`} className="py-2 flex gap-3 text-sm text-surface-500">
            <Circle size={18} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{n === MAX_WARNING_LEVEL ? 'Final warning' : `Warning ${n} of ${MAX_WARNING_LEVEL}`} — not sent</span>
          </li>
        ))}
      </ol>
      {!current.length && !showUpcoming && (
        <p className="text-sm text-surface-600 py-2">{studentView ? 'You have no lab sign-up warnings this term.' : 'No warnings this term.'}</p>
      )}
      {older.length > 0 && (
        <div className="mt-2 border-t border-surface-100 pt-1">
          <button
            type="button"
            className={`min-h-[44px] px-1 inline-flex items-center gap-1 text-sm text-surface-700 rounded ${FOCUS}`}
            aria-expanded={showOld}
            aria-controls={oldId}
            onClick={() => setShowOld(s => !s)}
          >
            {showOld ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            Before the last reset ({older.filter(e => e.kind === 'warning').length} warning{older.filter(e => e.kind === 'warning').length === 1 ? '' : 's'})
          </button>
          {showOld && (
            <ol id={oldId} className="divide-y divide-surface-100 opacity-90">
              {older.map(ev => <EventRow key={ev.id} ev={ev} studentView={studentView} />)}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

/**
 * Props
 *   open, onClose
 *   student   { email, name }
 *   term      { term_id, name, begin_date } — the term the warnings belong to
 *   context   { weekOf: 'YYYY-MM-DD', weekLabel, shortage } — optional; set
 *             when opened from a week's list so the warning names the week
 *   canManage boolean — Lab Signup → manage_warnings
 *   onChanged optional callback after any successful write
 */
export function LabWarningPanel({ open, onClose, student, term, context = null, canManage = false, onChanged }) {
  const [mode, setMode] = useState('main')     // main | confirmSend | log | reset
  const [status, setStatus] = useState('')     // live-region message
  const [formError, setFormError] = useState('')
  const titleId = useId()
  const errId = useId()
  const ids = { date: useId(), method: useId(), msg: useId(), short: useId(), reason: useId() }

  const { byEmail, loading, error } = useLabWarnings({ termId: term?.term_id, studentEmail: student?.email, enabled: open && !!student?.email })
  const { busy, sendWarning, logWarning, resetWarnings } = useLabWarningActions()
  const summary = byEmail.get(String(student?.email || '').toLowerCase()) || null
  const level = summary?.level || 0
  const next = nextStepLabel(level)

  const [log, setLog] = useState({ sentOn: '', method: 'Email', message: '', shortage: '' })
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!open) return
    setMode('main'); setStatus(''); setFormError('')
    setLog({ sentOn: '', method: 'Email', message: '', shortage: '' }); setReason('')
  }, [open, student?.email])

  const close = () => { if (!busy) onClose() }
  const dialogRef = useDialogA11y(open, close)

  if (!open || !student) return null

  const go = m => { setFormError(''); setMode(m) }
  const done = msg => { setStatus(msg); setMode('main'); onChanged?.() }

  const doSend = async () => {
    setFormError('')
    try {
      const row = await sendWarning({ email: student.email, weekOf: context?.weekOf, shortage: context?.shortage, expectedLevel: level })
      done(`${row.level >= MAX_WARNING_LEVEL ? 'Final warning' : `Warning ${row.level} of ${MAX_WARNING_LEVEL}`} sent to ${student.name}.`)
    } catch (e) { setFormError(e.message) }
  }

  const doLog = async e => {
    e.preventDefault()
    setFormError('')
    if (!log.sentOn) return setFormError('Enter the date you warned the student.')
    if (log.sentOn > todayStr()) return setFormError('The date can’t be in the future.')
    if (log.message.trim().length < 3) return setFormError('Paste the email or write a short note about what was said.')
    try {
      const row = await logWarning({ email: student.email, sentOn: log.sentOn, method: log.method, message: log.message.trim(), shortage: log.shortage.trim(), expectedLevel: level })
      setLog({ sentOn: '', method: 'Email', message: '', shortage: '' })
      done(`Past warning recorded as ${row.level >= MAX_WARNING_LEVEL ? 'the final warning' : `warning ${row.level} of ${MAX_WARNING_LEVEL}`}.`)
    } catch (err) { setFormError(err.message) }
  }

  const doReset = async () => {
    setFormError('')
    try {
      await resetWarnings({ email: student.email, termId: term.term_id, reason: reason.trim() })
      setReason('')
      done(`${student.name}’s warnings were reset. Their history is kept.`)
    } catch (e) { setFormError(e.message) }
  }

  return (
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/50 p-4" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-xl w-full max-w-lg shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-surface-200">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-surface-900">Lab warnings · {student.name}</h2>
            <p className="text-sm text-surface-600">{term?.name || 'No term'}{summary ? ` · ${levelLabel(level)}` : ''}</p>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Close lab warnings" className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-surface-500 hover:bg-surface-100 ${FOCUS}`}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {context?.shortage && (
            <p className="text-sm text-surface-700 mb-3">
              Short {context.weekLabel ? <>the week of <strong>{context.weekLabel}</strong></> : 'this week'}: {context.shortage}
            </p>
          )}

          <div role="status" aria-live="polite" className="text-sm min-h-[1.25rem] mb-1">
            {loading && <span className="inline-flex items-center gap-2 text-surface-600"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading history…</span>}
            {!loading && status && <span className="inline-flex items-center gap-1 text-green-800"><CheckCircle2 size={14} aria-hidden="true" /> {status}</span>}
          </div>
          {error && <p role="alert" className="text-sm text-red-700 mb-2">{error}</p>}

          {!term ? (
            <p className="text-sm text-red-700" role="alert">No academic term covers this week. Add it under Settings → Terms.</p>
          ) : (
            <LabWarningHistory summary={summary} />
          )}

          {/* ── Confirm send ── */}
          {mode === 'confirmSend' && next && (
            <div className="mt-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-900">
              <p className="font-medium">Send the {next} to {student.name}?</p>
              <p className="mt-1">They get a notification in the CMMS right away (and a push notification if they turned those on). It can’t be taken back — only reset.</p>
              {level + 1 >= MAX_WARNING_LEVEL && (
                <p className="mt-1">The final warning tells them their lab time will be scheduled for them. Auto-scheduling isn’t built yet, so book them with Admin Signup for now.</p>
              )}
            </div>
          )}

          {/* ── Log a past warning ── */}
          {mode === 'log' && (
            <form id="lab-warning-log-form" onSubmit={doLog} className="mt-4 p-3 rounded-lg border border-surface-200 bg-surface-50 space-y-3" noValidate>
              <p className="text-sm text-surface-700">
                Records a warning you already gave (for example an Outlook email). No notification is sent. It will be saved as <strong>{next || '—'}</strong>.
                Log older warnings before sending new ones so they stay in order.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={ids.date} className="label">Date you warned them</label>
                  <input id={ids.date} type="date" className="input min-h-[44px]" value={log.sentOn} max={todayStr()} min={term?.begin_date ? String(term.begin_date).substring(0, 10) : undefined}
                    onChange={e => setLog(l => ({ ...l, sentOn: e.target.value }))} aria-describedby={formError ? errId : undefined} required />
                </div>
                <div>
                  <label htmlFor={ids.method} className="label">How</label>
                  <select id={ids.method} className="input min-h-[44px]" value={log.method} onChange={e => setLog(l => ({ ...l, method: e.target.value }))}>
                    {WARNING_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor={ids.msg} className="label">Email you sent, or a note about what was said</label>
                <textarea id={ids.msg} rows={5} className="input" value={log.message} maxLength={8000}
                  onChange={e => setLog(l => ({ ...l, message: e.target.value }))} aria-describedby={formError ? errId : undefined} required />
              </div>
              <div>
                <label htmlFor={ids.short} className="label">What they were short (optional)</label>
                <input id={ids.short} type="text" className="input min-h-[44px]" value={log.shortage} maxLength={300} placeholder="RICT1510 0 of 8 the week of Nov 2"
                  onChange={e => setLog(l => ({ ...l, shortage: e.target.value }))} />
              </div>
            </form>
          )}

          {/* ── Reset ── */}
          {mode === 'reset' && (
            <div className="mt-4 p-3 rounded-lg border border-surface-200 bg-surface-50 space-y-2">
              <p className="text-sm text-surface-700">
                Starts {student.name} over at 0 warnings for {term?.name}. Their history stays on record, and they get a notification that they can manage their own sign-ups again.
              </p>
              <label htmlFor={ids.reason} className="label">Reason (optional)</label>
              <textarea id={ids.reason} rows={2} className="input" value={reason} maxLength={1000} placeholder="Back on track for 3 weeks" onChange={e => setReason(e.target.value)} />
            </div>
          )}

          {formError && <p id={errId} role="alert" className="mt-3 text-sm text-red-700">{formError}</p>}
        </div>

        {canManage && term && (
          <div className="flex flex-wrap justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50 rounded-b-xl">
            {mode === 'main' && (
              <>
                {level > 0 && (
                  <button type="button" className={BTN_SECONDARY} onClick={() => go('reset')} disabled={busy || loading}>
                    <RotateCcw size={16} aria-hidden="true" /> Reset warnings
                  </button>
                )}
                {next && (
                  <button type="button" className={BTN_SECONDARY} onClick={() => go('log')} disabled={busy || loading}>
                    <NotebookPen size={16} aria-hidden="true" /> Log a past warning
                  </button>
                )}
                {next ? (
                  <button type="button" className={level + 1 >= MAX_WARNING_LEVEL ? BTN_DANGER : BTN_PRIMARY} onClick={() => go('confirmSend')} disabled={busy || loading}>
                    <Send size={16} aria-hidden="true" /> Send {next}
                  </button>
                ) : (
                  <span className="text-sm text-surface-600 self-center">Final warning sent. Reset to start over.</span>
                )}
              </>
            )}
            {mode === 'confirmSend' && (
              <>
                <button type="button" className={BTN_SECONDARY} onClick={() => go('main')} disabled={busy}>Cancel</button>
                <button type="button" className={level + 1 >= MAX_WARNING_LEVEL ? BTN_DANGER : BTN_PRIMARY} onClick={doSend} disabled={busy}>
                  {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />} Yes, send {next}
                </button>
              </>
            )}
            {mode === 'log' && (
              <>
                <button type="button" className={BTN_SECONDARY} onClick={() => go('main')} disabled={busy}>Cancel</button>
                <button type="submit" form="lab-warning-log-form" className={BTN_PRIMARY} disabled={busy}>
                  {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Save past warning
                </button>
              </>
            )}
            {mode === 'reset' && (
              <>
                <button type="button" className={BTN_SECONDARY} onClick={() => go('main')} disabled={busy}>Cancel</button>
                <button type="button" className={BTN_PRIMARY} onClick={doReset} disabled={busy}>
                  {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Reset warnings
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default LabWarningPanel
