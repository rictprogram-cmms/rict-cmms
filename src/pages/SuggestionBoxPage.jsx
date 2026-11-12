/**
 * RICT CMMS — RICT Club Suggestion Box
 *
 * Students (and anyone with Suggestion Box → submit) drop ideas for the RICT
 * Club in a box — named, or TRULY anonymous. Each send gets a random, silly
 * animation (see components/suggestionBox/SubmitAnimation.jsx).
 *
 * Views (buttons with aria-pressed, shown by permission):
 *   Send          — the form, the one-time tracking code after an anonymous
 *                   send, and "Check a tracking code".
 *   My suggestions— your NAMED suggestions with their status and reply.
 *   All suggestions (viewers + manage) — every suggestion; set status and a
 *                   public reply. manage also deletes and closes out a
 *                   school year (archives it).
 *   Viewers (manage_viewers) — pick who is on the viewer list. Viewers also
 *                   get a bell notification for each new suggestion.
 *
 * Anonymous: the database never stores the author or time of day for an
 * anonymous suggestion (submit_suggestion() in 20261110_suggestion_box.sql),
 * and nothing is written to audit_log. The tracking code is shown once.
 *
 * Accessibility (WCAG 2.1 AA / Section 508): labelled controls with help text
 * tied by aria-describedby, 44px targets, focus-visible rings, status badges
 * carry text (never colour alone), polite live region for send / save / copy
 * results, ConfirmDialog (useDialogA11y) for destructive actions. The send
 * animation always plays (2026-11-11: the opt-out checkbox was removed); it
 * stays skippable and is replaced by a fade under prefers-reduced-motion.
 *
 * Instructors (Suggestion Box → manage) get "Reset today's limit" on the Send
 * view — everyone's limit at once, never per person, so nobody can see who
 * sent suggestions today.
 *
 * File: src/pages/SuggestionBoxPage.jsx
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Lightbulb, Send, EyeOff, Inbox, Users, Search, Copy, Check, Loader2, AlertCircle,
  Trash2, Archive, KeyRound, UserPlus, X, MessageSquare, Lock, RotateCcw,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import {
  useSuggestionBox, SUGGESTION_CATEGORIES, SUGGESTION_STATUSES, SUGGESTION_MAX_LEN,
  SUGGESTION_DAILY_LIMIT, schoolYearFor, friendlyError,
} from '@/hooks/useSuggestionBox'
import SubmitAnimation, { pickAnimation, captionFor } from '@/components/suggestionBox/SubmitAnimation'
import { ConfirmDialog } from '@/components/ConfirmDialog'

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1'

const STATUS_STYLE = {
  'New':          'bg-blue-50 text-blue-800 border-blue-200',
  'Under review': 'bg-amber-50 text-amber-900 border-amber-200',
  'Planned':      'bg-violet-50 text-violet-800 border-violet-200',
  'Done':         'bg-green-50 text-green-800 border-green-200',
  'Not doing':    'bg-surface-100 text-surface-700 border-surface-300',
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full border text-xs font-semibold ${STATUS_STYLE[status] || STATUS_STYLE['Not doing']}`}>
      {status}
    </span>
  )
}

/** 'YYYY-MM-DD' (+ optional real-UTC timestamp) → readable local text. */
function whenText(createdOn, createdAt) {
  if (createdAt) {
    const d = new Date(createdAt)
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  }
  if (!createdOn) return ''
  return new Date(`${createdOn}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function personName(p) {
  if (!p) return ''
  return `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email
}

// ─────────────────────────────────────────────────────────────────────────────

export default function SuggestionBoxPage() {
  const location = useLocation()
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Suggestion Box')
  const canSubmit = hasPerm('submit')
  const canManage = hasPerm('manage')
  const canManageViewers = hasPerm('manage_viewers')

  const box = useSuggestionBox({ canManageViewers })
  const { canView } = box

  const [view, setView] = useState(location.state?.view || 'send')
  const [announce, setAnnounce] = useState('')

  // Follow the bell (navigate state) when it changes.
  useEffect(() => {
    if (location.state?.view) setView(location.state.view)
  }, [location.state])

  // Fall back to Send if the chosen view is not allowed.
  useEffect(() => {
    if (box.loading || permsLoading) return
    if (view === 'all' && !canView) setView('send')
    if (view === 'viewers' && !canManageViewers) setView('send')
  }, [view, canView, canManageViewers, box.loading, permsLoading])

  const say = useCallback((msg) => {
    setAnnounce('')
    setTimeout(() => setAnnounce(msg), 50)
  }, [])

  if (permsLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-surface-600" role="status">
        <Loader2 size={20} className="animate-spin mr-2" aria-hidden="true" /> Loading Suggestion Box…
      </div>
    )
  }

  if (!hasPerm('view_page')) {
    return (
      <div className="max-w-xl mx-auto mt-16 bg-white border border-surface-200 rounded-2xl p-8 text-center">
        <Lock size={28} className="mx-auto text-surface-500 mb-3" aria-hidden="true" />
        <h1 className="text-lg font-bold text-surface-900">Suggestion Box</h1>
        <p className="text-sm text-surface-600 mt-1">You do not have access to this page.</p>
      </div>
    )
  }

  const openCount = box.suggestions.filter(s => s.status === 'New' && !s.archived).length

  const views = [
    { k: 'send', label: 'Send a suggestion', icon: Send, show: true },
    { k: 'mine', label: `My suggestions${box.mine.length ? ` (${box.mine.length})` : ''}`, icon: MessageSquare, show: true },
    { k: 'all', label: `All suggestions${canView && openCount ? ` (${openCount} new)` : ''}`, icon: Inbox, show: canView },
    { k: 'viewers', label: 'Viewers', icon: Users, show: canManageViewers },
  ].filter(v => v.show)

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{announce}</div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center">
          <Lightbulb size={22} className="text-amber-600" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-surface-900">RICT Club Suggestion Box</h1>
          <p className="text-sm text-surface-600">Got an idea for the Club? Drop it in the box — with your name or without.</p>
        </div>
      </div>

      {box.loadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-sm" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{box.loadError}</span>
          <button type="button" onClick={box.refresh} className={`ml-auto underline font-semibold min-h-[44px] px-2 ${FOCUS}`}>Try again</button>
        </div>
      )}

      {/* View switch */}
      <div role="group" aria-label="Suggestion Box sections" className="flex flex-wrap gap-2">
        {views.map(v => (
          <button
            key={v.k}
            type="button"
            aria-pressed={view === v.k}
            onClick={() => setView(v.k)}
            className={`flex items-center gap-2 px-4 min-h-[44px] rounded-xl text-sm font-semibold border transition-colors ${FOCUS} ${
              view === v.k ? 'bg-amber-500 border-amber-600 text-surface-900' : 'bg-white border-surface-200 text-surface-700 hover:bg-surface-50'}`}
          >
            <v.icon size={16} aria-hidden="true" /> {v.label}
          </button>
        ))}
      </div>

      {view === 'send' && (
        <SendView box={box} canSubmit={canSubmit} canManage={canManage} say={say} />
      )}
      {view === 'mine' && <MineView mine={box.mine} loading={box.loading} />}
      {view === 'all' && canView && (
        <AllView box={box} canManage={canManage} say={say} myEmail={(profile?.email || '').toLowerCase()} />
      )}
      {view === 'viewers' && canManageViewers && <ViewersView box={box} say={say} myEmail={(profile?.email || '').toLowerCase()} />}
    </div>
  )
}

// ─── Send ────────────────────────────────────────────────────────────────────

function SendView({ box, canSubmit, canManage, say }) {
  const [body, setBody] = useState('')
  const [category, setCategory] = useState('Other')
  const [anonymous, setAnonymous] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [anim, setAnim] = useState(null)              // { kind, note }
  const [trackingCode, setTrackingCode] = useState('')
  const [copied, setCopied] = useState(false)

  const textRef = useRef(null)
  const codeHeadingRef = useRef(null)
  const pendingCodeRef = useRef('')

  const trimmed = body.trim()
  const tooShort = trimmed.length < 3
  const remaining = SUGGESTION_MAX_LEN - body.length

  const [resetting, setResetting] = useState(false)

  const resetLimits = async () => {
    setResetting(true)
    try {
      await box.resetLimits()
      setError('')
      toast.success("Today's suggestion limit was reset for everyone")
      say("Today's suggestion limit was reset for everyone.")
    } catch (err) {
      toast.error(friendlyError(err, 'Could not reset the limit.'))
    } finally {
      setResetting(false)
    }
  }

  const afterSend = (caption, code) => {
    say(`${caption} Suggestion received.${code ? ` Your tracking code is ${code.split('').join(' ')}.` : ''}`)
    if (code) {
      setTrackingCode(code)
      setTimeout(() => codeHeadingRef.current?.focus(), 60)
    } else {
      setTimeout(() => textRef.current?.focus(), 60)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (tooShort || sending) return
    setSending(true)
    setError('')
    const note = { body: trimmed, category }
    try {
      const res = await box.submit({ body: trimmed, category, anonymous })
      setBody('')
      setAnonymous(false)
      setCopied(false)
      setTrackingCode('')
      pendingCodeRef.current = res.tracking_code || ''
      setAnim({ kind: pickAnimation(), note })
    } catch (err) {
      const msg = friendlyError(err, 'Your suggestion could not be sent. Please try again.')
      setError(msg)
      say(msg)
    } finally {
      setSending(false)
    }
  }

  const onAnimDone = () => {
    const kind = anim?.kind
    setAnim(null)
    afterSend(captionFor(kind), pendingCodeRef.current)
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(trackingCode)
      setCopied(true)
      say('Tracking code copied.')
    } catch {
      say('Could not copy automatically — please write the code down.')
    }
  }

  return (
    <div className="space-y-5">
      {anim && <SubmitAnimation kind={anim.kind} note={anim.note} onDone={onAnimDone} />}

      {trackingCode && (
        <section aria-labelledby="sb-code-h" className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-5">
          <h2 id="sb-code-h" ref={codeHeadingRef} tabIndex={-1} className="flex items-center gap-2 text-base font-bold text-surface-900 focus:outline-none">
            <KeyRound size={18} className="text-amber-700" aria-hidden="true" /> Your anonymous tracking code
          </h2>
          <p className="text-sm text-surface-700 mt-1">
            Save this now — it is the only way to check on your suggestion, and it <strong>cannot be shown again</strong>.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <code className="text-2xl font-bold tracking-widest bg-white border border-amber-300 rounded-lg px-4 py-2 text-surface-900">{trackingCode}</code>
            <button type="button" onClick={copyCode}
              className={`flex items-center gap-1.5 px-4 min-h-[44px] rounded-lg bg-white border border-amber-300 text-sm font-semibold text-surface-800 hover:bg-amber-100 ${FOCUS}`}>
              {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />} {copied ? 'Copied' : 'Copy code'}
            </button>
            <button type="button" onClick={() => { setTrackingCode(''); textRef.current?.focus() }}
              className={`px-4 min-h-[44px] rounded-lg text-sm font-semibold text-surface-700 hover:bg-amber-100 ${FOCUS}`}>
              I saved it
            </button>
          </div>
        </section>
      )}

      {canSubmit ? (
        <form onSubmit={handleSubmit} className="bg-white border border-surface-200 rounded-2xl p-5 space-y-4" noValidate>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="sb-category" className="block text-sm font-semibold text-surface-800 mb-1.5">Category</label>
              <select id="sb-category" value={category} onChange={e => setCategory(e.target.value)}
                className={`w-full px-3 min-h-[44px] text-sm border border-surface-300 rounded-lg bg-white ${FOCUS}`}>
                {SUGGESTION_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="sb-body" className="block text-sm font-semibold text-surface-800 mb-1.5">Your suggestion</label>
            <textarea
              id="sb-body"
              ref={textRef}
              value={body}
              onChange={e => setBody(e.target.value.slice(0, SUGGESTION_MAX_LEN))}
              rows={5}
              maxLength={SUGGESTION_MAX_LEN}
              aria-describedby="sb-body-help sb-body-count"
              aria-invalid={!!error || undefined}
              placeholder="What should the Club do, build, buy, or change?"
              className={`w-full px-3 py-2 text-sm border border-surface-300 rounded-lg ${FOCUS}`}
            />
            <div className="flex justify-between gap-3 text-xs text-surface-600 mt-1">
              <span id="sb-body-help">Be specific — what, and why it would help. Up to {SUGGESTION_DAILY_LIMIT} suggestions a day.</span>
              <span id="sb-body-count">{remaining} characters left</span>
            </div>
          </div>

          <div className="rounded-xl border border-surface-200 bg-surface-50 p-4">
            <div className="flex items-start gap-3">
              <input id="sb-anon" type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)}
                aria-describedby="sb-anon-help"
                className="mt-1 w-5 h-5 accent-amber-600 cursor-pointer" />
              <div>
                <label htmlFor="sb-anon" className="flex items-center gap-1.5 text-sm font-semibold text-surface-900 cursor-pointer min-h-[28px]">
                  <EyeOff size={15} aria-hidden="true" /> Send anonymously
                </label>
                <p id="sb-anon-help" className="text-xs text-surface-700 mt-0.5">
                  {anonymous
                    ? 'Your name is not saved anywhere — not even instructors can see who sent it. You will get a tracking code to check for a reply.'
                    : 'Your name will be shown to the Club members who read suggestions, and you will be notified when it is updated.'}
                </p>
              </div>
            </div>
          </div>

          {error && (
            <p className="flex items-start gap-2 text-sm text-red-700" role="alert">
              <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
            </p>
          )}

          <button type="submit" disabled={tooShort || sending}
            className={`flex items-center gap-2 px-5 min-h-[44px] rounded-xl bg-amber-500 hover:bg-amber-400 text-surface-900 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`}>
            {sending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            {sending ? 'Sending…' : 'Drop it in the box'}
          </button>
        </form>
      ) : (
        <p className="bg-white border border-surface-200 rounded-2xl p-5 text-sm text-surface-700">
          You do not have permission to send suggestions.
        </p>
      )}

      {canManage && (
        <section aria-labelledby="sb-limit-h" className="bg-white border border-surface-200 rounded-2xl p-5 flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[240px]">
            <h2 id="sb-limit-h" className="text-base font-bold text-surface-900">Daily limit <span className="text-xs font-semibold text-surface-600">(instructors only)</span></h2>
            <p className="text-sm text-surface-700 mt-0.5">
              Each person can send {SUGGESTION_DAILY_LIMIT} suggestions a day. Resetting clears today's count for everyone —
              it can't be done per person, so no one can see who sent suggestions today.
            </p>
          </div>
          <button type="button" onClick={resetLimits} disabled={resetting}
            className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg border border-surface-300 bg-white text-sm font-semibold text-surface-800 hover:bg-surface-50 disabled:opacity-50 ${FOCUS}`}>
            {resetting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
            Reset today's limit
          </button>
        </section>
      )}

      <TrackingLookup lookup={box.lookup} say={say} />
    </div>
  )
}

function TrackingLookup({ lookup, say }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(undefined)   // undefined = not searched, null = not found
  const [error, setError] = useState('')

  const go = async (e) => {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setError('')
    try {
      const row = await lookup(code.trim())
      setResult(row)
      say(row ? `Found suggestion number ${row.id}. Status: ${row.status}.` : 'No suggestion matches that code.')
    } catch (err) {
      const msg = friendlyError(err, 'Could not look up that code.')
      setError(msg)
      say(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="sb-lookup-h" className="bg-white border border-surface-200 rounded-2xl p-5">
      <h2 id="sb-lookup-h" className="text-base font-bold text-surface-900">Check an anonymous suggestion</h2>
      <form onSubmit={go} className="flex flex-wrap items-end gap-3 mt-3">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="sb-code" className="block text-sm font-semibold text-surface-800 mb-1.5">Tracking code</label>
          <input id="sb-code" value={code} onChange={e => setCode(e.target.value)} placeholder="SB-XXXX-XXXX" autoComplete="off"
            className={`w-full px-3 min-h-[44px] text-sm uppercase tracking-wider border border-surface-300 rounded-lg ${FOCUS}`} />
        </div>
        <button type="submit" disabled={busy || !code.trim()}
          className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg border border-surface-300 bg-white text-sm font-semibold text-surface-800 hover:bg-surface-50 disabled:opacity-50 ${FOCUS}`}>
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Search size={15} aria-hidden="true" />} Check
        </button>
      </form>
      {error && <p className="text-sm text-red-700 mt-3">{error}</p>}
      {result === null && <p className="text-sm text-surface-700 mt-3">No suggestion matches that code. Check for typos (codes look like SB-K7Q4-M2XP).</p>}
      {result && (
        <div className="mt-4 border border-surface-200 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-surface-600">
            <span className="font-semibold text-surface-800">#{result.id}</span>
            <span>· {result.category}</span>
            <span>· {whenText(result.created_on)}</span>
            <StatusBadge status={result.status} />
            {result.archived && <span className="text-surface-600">(archived)</span>}
          </div>
          <p className="text-sm text-surface-900 whitespace-pre-wrap mt-2">{result.body}</p>
          <ReplyBlock reply={result.reply} by={result.reply_by_name} at={result.replied_at} />
        </div>
      )}
    </section>
  )
}

function ReplyBlock({ reply, by, at }) {
  if (!reply) return null
  return (
    <div className="mt-3 border-l-4 border-amber-400 bg-amber-50 rounded-r-lg px-3 py-2">
      <p className="text-xs font-semibold text-surface-700">
        Reply from {by || 'the Club'}{at ? ` · ${whenText(null, at)}` : ''}
      </p>
      <p className="text-sm text-surface-900 whitespace-pre-wrap mt-0.5">{reply}</p>
    </div>
  )
}

// ─── Mine ────────────────────────────────────────────────────────────────────

function MineView({ mine, loading }) {
  if (loading) return <p className="text-sm text-surface-600" role="status">Loading…</p>
  return (
    <section aria-labelledby="sb-mine-h" className="space-y-3">
      <h2 id="sb-mine-h" className="text-base font-bold text-surface-900">My suggestions</h2>
      <p className="text-xs text-surface-600">Suggestions you sent with your name. Anonymous ones are not listed here — check them with your tracking code.</p>
      {mine.length === 0 && (
        <p className="bg-white border border-surface-200 rounded-2xl p-5 text-sm text-surface-700">You have not sent any named suggestions yet.</p>
      )}
      <ul className="space-y-3">
        {mine.map(s => (
          <li key={s.id} className="bg-white border border-surface-200 rounded-2xl p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-surface-600">
              <span className="font-semibold text-surface-800">#{s.id}</span>
              <span>· {s.category}</span>
              <span>· {whenText(s.created_on, s.created_at)}</span>
              <StatusBadge status={s.status} />
              {s.archived && <span>(archived)</span>}
            </div>
            <p className="text-sm text-surface-900 whitespace-pre-wrap mt-2">{s.body}</p>
            <ReplyBlock reply={s.reply} by={s.reply_by_name} at={s.replied_at} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── All (viewers) ───────────────────────────────────────────────────────────

function AllView({ box, canManage, say }) {
  const currentYear = schoolYearFor()
  const years = useMemo(() => {
    const set = new Set([currentYear, ...box.suggestions.map(s => s.school_year)])
    return [...set].sort().reverse()
  }, [box.suggestions, currentYear])

  const [year, setYear] = useState(currentYear)
  const [status, setStatus] = useState('All')
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return box.suggestions.filter(s =>
      s.school_year === year &&
      (showArchived || !s.archived) &&
      (status === 'All' || s.status === status) &&
      (category === 'All' || s.category === category) &&
      (!q || s.body.toLowerCase().includes(q) || (s.reply || '').toLowerCase().includes(q) || (s.author_name || '').toLowerCase().includes(q))
    )
  }, [box.suggestions, year, showArchived, status, category, query])

  const openInYear = box.suggestions.filter(s => s.school_year === year && !s.archived).length

  useEffect(() => {
    if (!box.loading) say(`Showing ${list.length} suggestion${list.length === 1 ? '' : 's'}.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, status, category, showArchived])

  const doDelete = async () => {
    if (!confirmDelete) return
    setBusy(true)
    try {
      await box.remove(confirmDelete.id)
      toast.success(`Suggestion #${confirmDelete.id} deleted`)
      say(`Suggestion number ${confirmDelete.id} deleted.`)
      setConfirmDelete(null)
    } catch (err) {
      toast.error(friendlyError(err, 'Could not delete the suggestion.'))
    } finally {
      setBusy(false)
    }
  }

  const doArchive = async () => {
    setBusy(true)
    try {
      const n = await box.archiveYear(year)
      toast.success(`Archived ${n} suggestion${n === 1 ? '' : 's'} from ${year}`)
      say(`Archived ${n} suggestions from ${year}.`)
      setConfirmArchive(false)
    } catch (err) {
      toast.error(friendlyError(err, 'Could not close out the school year.'))
    } finally {
      setBusy(false)
    }
  }

  const selectCls = `w-full px-3 min-h-[44px] text-sm border border-surface-300 rounded-lg bg-white ${FOCUS}`

  return (
    <section aria-labelledby="sb-all-h" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sb-all-h" className="text-base font-bold text-surface-900">All suggestions</h2>
        {canManage && (
          <button type="button" onClick={() => setConfirmArchive(true)} disabled={!openInYear}
            className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg border border-surface-300 bg-white text-sm font-semibold text-surface-800 hover:bg-surface-50 disabled:opacity-50 ${FOCUS}`}>
            <Archive size={15} aria-hidden="true" /> Close out {year}
          </button>
        )}
      </div>

      <div className="bg-white border border-surface-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <div>
          <label htmlFor="sb-f-year" className="block text-xs font-semibold text-surface-700 mb-1">School year</label>
          <select id="sb-f-year" value={year} onChange={e => setYear(e.target.value)} className={selectCls}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="sb-f-status" className="block text-xs font-semibold text-surface-700 mb-1">Status</label>
          <select id="sb-f-status" value={status} onChange={e => setStatus(e.target.value)} className={selectCls}>
            <option value="All">All statuses</option>
            {SUGGESTION_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="sb-f-cat" className="block text-xs font-semibold text-surface-700 mb-1">Category</label>
          <select id="sb-f-cat" value={category} onChange={e => setCategory(e.target.value)} className={selectCls}>
            <option value="All">All categories</option>
            {SUGGESTION_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="sb-f-q" className="block text-xs font-semibold text-surface-700 mb-1">Search</label>
          <input id="sb-f-q" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Words in the suggestion or reply"
            className={selectCls} />
        </div>
        <div className="sm:col-span-2 lg:col-span-4 flex items-center gap-2">
          <input id="sb-f-arch" type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="w-5 h-5 accent-amber-600 cursor-pointer" />
          <label htmlFor="sb-f-arch" className="text-sm text-surface-800 cursor-pointer min-h-[28px] flex items-center">Show archived</label>
        </div>
      </div>

      <p className="text-xs text-surface-600">Showing {list.length} suggestion{list.length === 1 ? '' : 's'}.</p>

      {box.loading ? (
        <p className="text-sm text-surface-600" role="status">Loading…</p>
      ) : list.length === 0 ? (
        <p className="bg-white border border-surface-200 rounded-2xl p-5 text-sm text-surface-700">Nothing here yet.</p>
      ) : (
        <ul className="space-y-3">
          {list.map(s => (
            <SuggestionCard key={s.id} s={s} canManage={canManage} update={box.update} say={say} onDelete={() => setConfirmDelete(s)} />
          ))}
        </ul>
      )}

      {confirmDelete && (
        <ConfirmDialog
          open
          variant="danger"
          title={`Delete suggestion #${confirmDelete.id}?`}
          message="This permanently removes the suggestion and its reply. It cannot be undone. To keep it on record, set it to Not doing instead."
          confirmLabel="Delete"
          busy={busy}
          onConfirm={doDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
      {confirmArchive && (
        <ConfirmDialog
          open
          variant="primary"
          title={`Close out school year ${year}?`}
          message={`This archives all ${openInYear} open suggestion${openInYear === 1 ? '' : 's'} from ${year}. They stay viewable with "Show archived", and anonymous tracking codes keep working.`}
          confirmLabel="Archive"
          busy={busy}
          onConfirm={doArchive}
          onClose={() => setConfirmArchive(false)}
        />
      )}
    </section>
  )
}

function SuggestionCard({ s, canManage, update, say, onDelete }) {
  const [status, setStatus] = useState(s.status)
  const [reply, setReply] = useState(s.reply || '')
  const [saving, setSaving] = useState(false)
  const readOnly = s.archived && !canManage

  // Pick up changes made by someone else (realtime refresh).
  useEffect(() => { setStatus(s.status) }, [s.status])
  useEffect(() => { setReply(s.reply || '') }, [s.reply])

  const dirty = status !== s.status || reply.trim() !== (s.reply || '')

  const save = async () => {
    setSaving(true)
    try {
      await update(s.id, { status, reply: reply.trim() })
      toast.success(`Suggestion #${s.id} updated`)
      say(`Suggestion number ${s.id} saved. Status ${status}.`)
    } catch (err) {
      toast.error(friendlyError(err, 'Could not save the change.'))
    } finally {
      setSaving(false)
    }
  }

  const idBase = `sb-s-${s.id}`

  return (
    <li className={`bg-white border rounded-2xl p-4 ${s.status === 'New' && !s.archived ? 'border-blue-300' : 'border-surface-200'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-surface-600">
        <span className="font-semibold text-surface-800">#{s.id}</span>
        <span>· {s.category}</span>
        <span>· {whenText(s.created_on, s.created_at)}</span>
        <span>·</span>
        {s.is_anonymous
          ? <span className="inline-flex items-center gap-1 font-semibold text-surface-700"><EyeOff size={12} aria-hidden="true" /> Anonymous</span>
          : <span className="font-semibold text-surface-700">{s.author_name || s.author_email}</span>}
        <StatusBadge status={s.status} />
        {s.archived && <span>(archived)</span>}
      </div>
      <p className="text-sm text-surface-900 whitespace-pre-wrap mt-2">{s.body}</p>

      {readOnly ? (
        <ReplyBlock reply={s.reply} by={s.reply_by_name} at={s.replied_at} />
      ) : (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3 items-start">
          <div>
            <label htmlFor={`${idBase}-st`} className="block text-xs font-semibold text-surface-700 mb-1">Status</label>
            <select id={`${idBase}-st`} value={status} onChange={e => setStatus(e.target.value)}
              className={`w-full px-3 min-h-[44px] text-sm border border-surface-300 rounded-lg bg-white ${FOCUS}`}>
              {SUGGESTION_STATUSES.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idBase}-rp`} className="block text-xs font-semibold text-surface-700 mb-1">
              Public reply <span className="font-normal text-surface-600">(the sender can see this)</span>
            </label>
            <textarea id={`${idBase}-rp`} value={reply} onChange={e => setReply(e.target.value.slice(0, SUGGESTION_MAX_LEN))} rows={2}
              className={`w-full px-3 py-2 text-sm border border-surface-300 rounded-lg ${FOCUS}`} />
            {s.reply && s.reply_by_name && (
              <p className="text-xs text-surface-600 mt-0.5">Last reply by {s.reply_by_name}{s.replied_at ? ` · ${whenText(null, s.replied_at)}` : ''}</p>
            )}
          </div>
          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={!dirty || saving}
              className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg bg-amber-500 hover:bg-amber-400 text-surface-900 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`}>
              {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />} Save
            </button>
            {canManage && (
              <button type="button" onClick={onDelete} aria-label={`Delete suggestion number ${s.id}`}
                className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg border border-red-200 text-red-700 text-sm font-semibold hover:bg-red-50 ${FOCUS}`}>
                <Trash2 size={15} aria-hidden="true" /> Delete
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

// ─── Viewers (manage_viewers) ────────────────────────────────────────────────

function ViewersView({ box, say, myEmail }) {
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(null)

  const byEmail = useMemo(() => {
    const m = {}
    box.people.forEach(p => { m[(p.email || '').toLowerCase()] = p })
    return m
  }, [box.people])

  const listed = new Set(box.viewers.map(v => v.email))
  const options = useMemo(() => box.people
    .filter(p => p.email && !listed.has(p.email.toLowerCase()))
    .sort((a, b) => (a.last_name || '').localeCompare(b.last_name || '') || (a.first_name || '').localeCompare(b.first_name || '')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [box.people, box.viewers])

  const add = async (e) => {
    e.preventDefault()
    if (!pick) return
    setBusy(true)
    try {
      await box.addViewer(pick)
      const name = personName(byEmail[pick]) || pick
      toast.success(`${name} can now read suggestions`)
      say(`${name} added to viewers.`)
      setPick('')
    } catch (err) {
      toast.error(friendlyError(err, 'Could not add that person.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirmRemove) return
    setBusy(true)
    const name = personName(byEmail[confirmRemove]) || confirmRemove
    try {
      await box.removeViewer(confirmRemove)
      toast.success(`${name} removed from viewers`)
      say(`${name} removed from viewers.`)
      setConfirmRemove(null)
    } catch (err) {
      toast.error(friendlyError(err, 'Could not remove that person.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="sb-viewers-h" className="space-y-4">
      <div>
        <h2 id="sb-viewers-h" className="text-base font-bold text-surface-900">Who can read suggestions</h2>
        <p className="text-sm text-surface-600 mt-1">
          People on this list see every suggestion, can set its status and reply, and get a bell notification when a new one arrives.
          Instructors can always read suggestions — add yourself if you also want the notifications.
          Anonymous suggestions never show who sent them, to anyone.
        </p>
      </div>

      <form onSubmit={add} className="bg-white border border-surface-200 rounded-2xl p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="sb-add-viewer" className="block text-xs font-semibold text-surface-700 mb-1">Add a person</label>
          <select id="sb-add-viewer" value={pick} onChange={e => setPick(e.target.value)}
            className={`w-full px-3 min-h-[44px] text-sm border border-surface-300 rounded-lg bg-white ${FOCUS}`}>
            <option value="">Choose someone…</option>
            {options.map(p => (
              <option key={p.email} value={p.email.toLowerCase()}>
                {personName(p)} ({p.role}){p.email.toLowerCase() === myEmail ? ' — you' : ''}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={!pick || busy}
          className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg bg-amber-500 hover:bg-amber-400 text-surface-900 text-sm font-bold disabled:opacity-50 ${FOCUS}`}>
          <UserPlus size={15} aria-hidden="true" /> Add viewer
        </button>
      </form>

      {box.viewers.length === 0 ? (
        <p className="bg-white border border-surface-200 rounded-2xl p-5 text-sm text-surface-700">No one is on the list yet.</p>
      ) : (
        <div className="bg-white border border-surface-200 rounded-2xl overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Suggestion Box viewers</caption>
            <thead className="bg-surface-50 text-left text-xs text-surface-700">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">Name</th>
                <th scope="col" className="px-4 py-2 font-semibold">Role</th>
                <th scope="col" className="px-4 py-2 font-semibold">Added</th>
                <th scope="col" className="px-4 py-2 font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {box.viewers.map(v => {
                const p = byEmail[v.email]
                const name = personName(p) || v.email
                return (
                  <tr key={v.email} className="border-t border-surface-100">
                    <td className="px-4 py-2 text-surface-900">
                      {name}
                      {!p && <span className="ml-2 text-xs text-amber-800">(not an active user — not receiving)</span>}
                    </td>
                    <td className="px-4 py-2 text-surface-700">{p?.role || '—'}</td>
                    <td className="px-4 py-2 text-surface-700">
                      {v.added_at ? new Date(v.added_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button type="button" onClick={() => setConfirmRemove(v.email)} aria-label={`Remove ${name} from viewers`}
                        className={`inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg text-red-700 text-sm font-semibold hover:bg-red-50 ${FOCUS}`}>
                        <X size={15} aria-hidden="true" /> Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          open
          variant="danger"
          title="Remove viewer?"
          message={`${personName(byEmail[confirmRemove]) || confirmRemove} will no longer see suggestions or get notifications.`}
          confirmLabel="Remove"
          busy={busy}
          onConfirm={remove}
          onClose={() => setConfirmRemove(null)}
        />
      )}
    </section>
  )
}
