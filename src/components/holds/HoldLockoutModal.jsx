import { useState, useEffect, useRef, useMemo } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useMyActiveHolds,
  useHoldActions,
  SEVERITY_META,
} from '@/hooks/useStudentHolds'
import {
  ShieldAlert,
  LogOut,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from 'lucide-react'

// ════════════════════════════════════════════════════════════════════════════
// HoldLockoutModal — tier-3 full-screen lockout
// ────────────────────────────────────────────────────────────────────────────
// Mounts as an overlay sibling inside AppLayout. Renders nothing if the
// current user has no active 'hold'-tier targets. When one or more exist:
//   - If one was pushed mid-session (prior lockout count was 0),
//     show a 10-second grace overlay first so unsaved work isn't lost.
//   - Then show the full lockout dialog for the first uncleared target.
//   - When the current target clears (via badge swipe, instructor remote,
//     Super Admin override, or auto-expiry), the realtime subscription in
//     useMyActiveHolds shrinks the array and the next target takes its
//     place automatically. No manual navigation.
//
// Escape routes available from inside the modal:
//   - Instructor badge swipe (after student ticks acknowledgment box)
//   - Sign Out (always available)
//
// Not included here (separate components / files):
//   - Reminder tier (30s countdown modal) → HoldReminderModal.jsx
//   - Nudge tier (dismissible banner)     → HoldNudgeBanner.jsx
// ════════════════════════════════════════════════════════════════════════════

const GRACE_PERIOD_SECONDS = 10
const FOCUS_REFRESH_MS = 500
const ERROR_CLEAR_MS = 3500

export default function HoldLockoutModal() {
  const { holds, loading } = useMyActiveHolds()
  const {
    clearTargetByBadge,
    acknowledgeTarget,
    recordView,
  } = useHoldActions()
  const { signOut, realProfile } = useAuth()

  // Only the 'hold' severity triggers this modal. Reminders and nudges are
  // handled by their own components.
  const lockoutHolds = useMemo(
    () => holds.filter(h => h.hold?.severity === 'hold'),
    [holds]
  )
  const currentTarget = lockoutHolds[0] || null
  const totalCount = lockoutHolds.length

  // ── Grace period state ─────────────────────────────────────────────────
  // Fires only when the count transitions from 0 → N. Holds already present
  // on first load lock immediately (the student is seeing this on login).
  // ──────────────────────────────────────────────────────────────────────
  const [graceSeconds, setGraceSeconds] = useState(0)
  const firstLoadDoneRef = useRef(false)
  const prevCountRef = useRef(0)

  useEffect(() => {
    if (loading) return
    const count = lockoutHolds.length

    if (!firstLoadDoneRef.current) {
      prevCountRef.current = count
      firstLoadDoneRef.current = true
      return
    }

    if (prevCountRef.current === 0 && count > 0) {
      setGraceSeconds(GRACE_PERIOD_SECONDS)
    }
    prevCountRef.current = count
  }, [lockoutHolds, loading])

  // Grace countdown ticker
  useEffect(() => {
    if (graceSeconds <= 0) return
    const timer = setTimeout(() => setGraceSeconds(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [graceSeconds])

  // ── Block Escape key globally while locked ────────────────────────────
  // Escape is often bound to close modals elsewhere in the app; we don't
  // want it slipping through this one. Capture phase so we win before any
  // other handler.
  // ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (totalCount === 0) return
    const blockEscape = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', blockEscape, true)
    return () => document.removeEventListener('keydown', blockEscape, true)
  }, [totalCount])

  if (totalCount === 0) return null

  if (graceSeconds > 0) {
    return <GraceOverlay seconds={graceSeconds} pendingCount={totalCount} />
  }

  // key={currentTarget.target_id} forces a fresh mount when the active
  // target changes, automatically resetting checkbox / input / status.
  return (
    <LockoutDialog
      key={currentTarget.target_id}
      target={currentTarget}
      totalCount={totalCount}
      userFirstName={realProfile?.first_name || ''}
      onAcknowledge={acknowledgeTarget}
      onRecordView={recordView}
      onBadgeSwipe={clearTargetByBadge}
      onSignOut={signOut}
    />
  )
}


// ════════════════════════════════════════════════════════════════════════════
// GraceOverlay — 10-second warning before a newly-arrived hold takes over
// ════════════════════════════════════════════════════════════════════════════

function GraceOverlay({ seconds, pendingCount }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="hold-grace-title"
      aria-describedby="hold-grace-desc"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9000,
        padding: 20,
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 16,
          width: '100%',
          maxWidth: 440,
          padding: '28px 28px 24px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
          border: '1px solid #fca5a5',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: '#fee2e2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <Clock size={22} color="#b91c1c" />
          </div>
          <h2
            id="hold-grace-title"
            style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#0f172a' }}
          >
            New hold being placed on your account
          </h2>
        </div>
        <p
          id="hold-grace-desc"
          style={{
            margin: '0 0 16px',
            fontSize: '0.9rem',
            color: '#334155',
            lineHeight: 1.55,
          }}
        >
          {pendingCount === 1
            ? 'An instructor has placed a hold on your account. Please finish your current action — this app will lock shortly.'
            : `${pendingCount} holds have been placed on your account. Please finish your current action — this app will lock shortly.`}
        </p>
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 10,
            padding: '12px 16px',
            textAlign: 'center',
          }}
          aria-live="polite"
          aria-atomic="true"
        >
          <span style={{ fontSize: '0.82rem', color: '#7f1d1d' }}>
            Locking in{' '}
            <span style={{ fontWeight: 700, fontSize: '1rem' }}>{seconds}</span>{' '}
            second{seconds === 1 ? '' : 's'}…
          </span>
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════════
// LockoutDialog — the actual full-screen lockout
// ════════════════════════════════════════════════════════════════════════════

function LockoutDialog({
  target,
  totalCount,
  userFirstName,
  onAcknowledge,
  onRecordView,
  onBadgeSwipe,
  onSignOut,
}) {
  const hold = target.hold
  const meta = SEVERITY_META.hold

  // ── UI state ───────────────────────────────────────────────────────────
  const [acknowledged, setAcknowledged] = useState(false)
  const [cardInput, setCardInput] = useState('')
  const [swipeStatus, setSwipeStatus] = useState('idle') // idle | verifying | success | error
  const [swipeMessage, setSwipeMessage] = useState('')

  const modalRef = useRef(null)
  const inputRef = useRef(null)
  const viewRecordedRef = useRef(false)

  // ── Record a view exactly once per target ──────────────────────────────
  useEffect(() => {
    if (!viewRecordedRef.current && target.target_id) {
      onRecordView(target.target_id)
      viewRecordedRef.current = true
    }
  }, [target.target_id, onRecordView])

  // ── Focus trap within the modal ────────────────────────────────────────
  useEffect(() => {
    const node = modalRef.current
    if (!node) return

    const handleTab = (e) => {
      if (e.key !== 'Tab') return
      const focusables = node.querySelectorAll(
        'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return

      const first = focusables[0]
      const last = focusables[focusables.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleTab)
    return () => document.removeEventListener('keydown', handleTab)
  }, [])

  // ── Keep focus on badge input once ack is checked (HID readers need it) ─
  useEffect(() => {
    if (!acknowledged) return
    const timer = setInterval(() => {
      if (
        inputRef.current &&
        document.activeElement !== inputRef.current &&
        swipeStatus !== 'verifying'
      ) {
        inputRef.current.focus()
      }
    }, FOCUS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [acknowledged, swipeStatus])

  // ── Auto-clear error messages after a few seconds ──────────────────────
  useEffect(() => {
    if (swipeStatus !== 'error') return
    const t = setTimeout(() => {
      setSwipeStatus('idle')
      setSwipeMessage('')
    }, ERROR_CLEAR_MS)
    return () => clearTimeout(t)
  }, [swipeStatus])

  // ── Handle acknowledgment checkbox ─────────────────────────────────────
  const handleAckChange = (e) => {
    const checked = e.target.checked
    setAcknowledged(checked)
    if (checked && target.target_id) {
      onAcknowledge(target.target_id)
    }
  }

  // ── Handle badge swipe (Enter on HID input) ────────────────────────────
  const handleKeyDown = async (e) => {
    if (e.key !== 'Enter') return
    const cardId = cardInput.trim()
    if (!cardId) return
    if (!acknowledged) return // belt + suspenders; input is disabled anyway

    setCardInput('')
    setSwipeStatus('verifying')
    setSwipeMessage('')

    const result = await onBadgeSwipe(target.hold_id, cardId)

    if (result.success) {
      setSwipeStatus('success')
      setSwipeMessage(
        result.cleared_by ? `Cleared by ${result.cleared_by}` : 'Hold cleared'
      )
      // Realtime will dismiss / advance us; no manual action needed.
    } else {
      setSwipeStatus('error')
      setSwipeMessage(result.error || 'Badge not recognized. Please try again.')
    }
  }

  // Format creation date for the "from" line
  const createdLine = (() => {
    try {
      const d = new Date(hold.created_at)
      return d.toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    } catch {
      return ''
    }
  })()

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="hold-dialog-title"
      aria-describedby="hold-dialog-message"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.72)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9000,
        padding: 20,
        overflowY: 'auto',
      }}
    >
      <div
        ref={modalRef}
        style={{
          background: 'white',
          borderRadius: 16,
          width: '100%',
          maxWidth: 560,
          boxShadow: '0 24px 70px rgba(0, 0, 0, 0.35)',
          overflow: 'hidden',
          margin: 'auto',
        }}
      >
        {/* Colored header bar */}
        <div
          style={{
            background: meta.color,
            color: 'white',
            padding: '18px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <ShieldAlert size={26} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.85 }}>
              Student Hold
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700 }}>
              {userFirstName ? `Attention, ${userFirstName}` : 'Attention'}
            </div>
          </div>
          {totalCount > 1 && (
            <span
              style={{
                background: 'rgba(255, 255, 255, 0.18)',
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: '0.72rem',
                fontWeight: 600,
              }}
              aria-label={`Hold 1 of ${totalCount}`}
            >
              Hold 1 of {totalCount}
            </span>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '24px 24px 20px' }}>
          {/* Title + message */}
          <h2
            id="hold-dialog-title"
            style={{
              margin: '0 0 10px',
              fontSize: '1.15rem',
              fontWeight: 700,
              color: '#0f172a',
              lineHeight: 1.3,
            }}
          >
            {hold.title}
          </h2>
          <p
            id="hold-dialog-message"
            style={{
              margin: '0 0 14px',
              fontSize: '0.92rem',
              color: '#334155',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {hold.message}
          </p>
          <p
            style={{
              margin: '0 0 20px',
              fontSize: '0.75rem',
              color: '#64748b',
            }}
          >
            From {hold.created_by_name}
            {createdLine ? ` · ${createdLine}` : ''}
          </p>

          {/* Dismissal instructions (for screen readers) */}
          <p className="sr-only" aria-live="polite">
            This notice cannot be closed without an instructor. Read the message, tick
            the acknowledgment checkbox below, and either ask an instructor to swipe
            their badge or sign out.
          </p>

          {/* Acknowledgment */}
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: '12px 14px',
              marginBottom: 14,
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                cursor: 'pointer',
                fontSize: '0.88rem',
                color: '#1e293b',
                lineHeight: 1.5,
              }}
            >
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={handleAckChange}
                style={{
                  marginTop: 3,
                  width: 16,
                  height: 16,
                  cursor: 'pointer',
                  flexShrink: 0,
                  accentColor: meta.color,
                }}
              />
              <span>
                <strong>I have read this and will follow up.</strong>
                <span style={{ display: 'block', color: '#64748b', fontSize: '0.8rem', marginTop: 2 }}>
                  You must check this box before an instructor can clear the hold.
                </span>
              </span>
            </label>
          </div>

          {/* Badge-swipe area */}
          <div
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: '16px 14px',
              background: acknowledged ? 'white' : '#f1f5f9',
              transition: 'background 150ms',
            }}
          >
            <p
              style={{
                margin: '0 0 10px',
                fontSize: '0.82rem',
                color: acknowledged ? '#0f172a' : '#94a3b8',
                fontWeight: 600,
              }}
            >
              Ask an instructor to swipe their badge to clear this hold.
            </p>
            <input
              ref={inputRef}
              type="text"
              name="hold-badge-scan"
              data-1p-ignore
              data-lpignore="true"
              aria-label="Instructor badge swipe input"
              aria-disabled={!acknowledged}
              value={cardInput}
              onChange={(e) => setCardInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!acknowledged || swipeStatus === 'verifying'}
              placeholder={
                acknowledged
                  ? 'Swipe instructor badge…'
                  : 'Check the box above to enable'
              }
              className="badge-mask"
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: '0.95rem',
                textAlign: 'center',
                border: `2px solid ${acknowledged ? meta.borderColor : '#cbd5e1'}`,
                borderRadius: 8,
                outline: 'none',
                background: acknowledged ? 'white' : '#e2e8f0',
                color: acknowledged ? '#0f172a' : '#94a3b8',
                cursor: acknowledged ? 'text' : 'not-allowed',
                boxSizing: 'border-box',
              }}
              autoComplete="off"
              autoFocus={acknowledged}
            />

            {/* Swipe status (live region) */}
            <div
              aria-live="polite"
              aria-atomic="true"
              style={{ minHeight: 24, marginTop: 10 }}
            >
              {swipeStatus === 'verifying' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    color: '#475569',
                    fontSize: '0.85rem',
                  }}
                >
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
                  Verifying badge…
                </div>
              )}
              {swipeStatus === 'success' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    color: '#15803d',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                  }}
                >
                  <CheckCircle2 size={16} aria-hidden="true" />
                  {swipeMessage || 'Hold cleared'}
                </div>
              )}
              {swipeStatus === 'error' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    color: '#b91c1c',
                    fontSize: '0.85rem',
                    padding: '8px 10px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 6,
                  }}
                  role="alert"
                >
                  <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
                  <span>{swipeMessage}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer: Sign Out always available */}
        <div
          style={{
            borderTop: '1px solid #e2e8f0',
            padding: '14px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: '#f8fafc',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Need to come back later?
          </span>
          <button
            onClick={onSignOut}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 16px',
              background: 'white',
              color: '#475569',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              fontSize: '0.85rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = '#f1f5f9'
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = 'white'
            }}
          >
            <LogOut size={14} aria-hidden="true" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Minimal inline keyframes for the verify spinner */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
      `}</style>
    </div>
  )
}
