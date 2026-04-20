import { useState, useEffect, useRef, useMemo } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useMyActiveHolds,
  useHoldActions,
  SEVERITY_META,
} from '@/hooks/useStudentHolds'
import {
  AlertTriangle,
  LogOut,
  CheckCircle2,
  Clock,
} from 'lucide-react'

// ════════════════════════════════════════════════════════════════════════════
// HoldReminderModal — tier-2 blocking reminder
// ────────────────────────────────────────────────────────────────────────────
// Amber-coloured modal shown on login and when a reminder is pushed mid-
// session via realtime. Blocks navigation until dismissed. Dismissal
// requires:
//   (1) A 30-second countdown to complete
//   (2) The student to tick the "I have read this and will follow up" box
//
// "Dismiss" here means "hide for this browser session", not "clear from DB".
// A dismissed reminder returns on the next login until an instructor clears
// it or it auto-expires. Dismissed target_ids live in sessionStorage.
//
// If the student has any active 'hold'-severity target, this modal defers —
// it renders nothing so the lockout modal owns the screen. Once the lockout
// is cleared, the reminder modal takes over.
//
// Not a badge-swipe path. Reminders are student-dismissible; holds are not.
// ════════════════════════════════════════════════════════════════════════════

const COUNTDOWN_SECONDS = 30
const FOCUS_REFRESH_MS = 500
const SESSION_STORAGE_KEY = 'rict_cmms_dismissed_reminders'


// ── sessionStorage helpers ────────────────────────────────────────────────

function loadDismissed() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveDismissed(set) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    /* ignore — sessionStorage might be disabled in private mode */
  }
}


export default function HoldReminderModal() {
  const { holds } = useMyActiveHolds()
  const { acknowledgeTarget, recordView } = useHoldActions()
  const { signOut, realProfile } = useAuth()

  // ── Defer to the lockout modal if any hold-tier target is active ──────
  const hasActiveLockout = useMemo(
    () => holds.some(h => h.hold?.severity === 'hold'),
    [holds]
  )

  // ── Pull just the reminder-tier targets ───────────────────────────────
  const reminderTargets = useMemo(
    () => holds.filter(h => h.hold?.severity === 'reminder'),
    [holds]
  )

  // ── Per-session dismissed set ─────────────────────────────────────────
  const [dismissedIds, setDismissedIds] = useState(() => loadDismissed())

  // Prune dismissedIds entries for targets that no longer exist (instructor
  // deleted/cleared them). Keeps sessionStorage from growing unbounded.
  useEffect(() => {
    const validIds = new Set(reminderTargets.map(t => t.target_id))
    const pruned = new Set([...dismissedIds].filter(id => validIds.has(id)))
    if (pruned.size !== dismissedIds.size) {
      setDismissedIds(pruned)
      saveDismissed(pruned)
    }
  }, [reminderTargets, dismissedIds])

  // ── Filter to the reminders we still need to show ─────────────────────
  const pendingReminders = useMemo(
    () => reminderTargets.filter(t => !dismissedIds.has(t.target_id)),
    [reminderTargets, dismissedIds]
  )
  const currentTarget = pendingReminders[0] || null
  const totalPending = pendingReminders.length

  // ── Block Escape globally while this modal is up ──────────────────────
  useEffect(() => {
    if (!currentTarget || hasActiveLockout) return
    const blockEscape = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', blockEscape, true)
    return () => document.removeEventListener('keydown', blockEscape, true)
  }, [currentTarget, hasActiveLockout])

  const handleDismiss = () => {
    if (!currentTarget) return
    const next = new Set(dismissedIds)
    next.add(currentTarget.target_id)
    setDismissedIds(next)
    saveDismissed(next)
  }

  // Nothing to show, or lockout is taking over
  if (!currentTarget || hasActiveLockout) return null

  // key={target_id} forces a fresh mount when the active reminder changes
  // (dismissal, instructor remote clear, etc.)
  return (
    <ReminderDialog
      key={currentTarget.target_id}
      target={currentTarget}
      totalCount={totalPending}
      userFirstName={realProfile?.first_name || ''}
      onAcknowledge={acknowledgeTarget}
      onRecordView={recordView}
      onDismiss={handleDismiss}
      onSignOut={signOut}
    />
  )
}


// ════════════════════════════════════════════════════════════════════════════
// ReminderDialog — the actual modal UI
// ════════════════════════════════════════════════════════════════════════════

function ReminderDialog({
  target,
  totalCount,
  userFirstName,
  onAcknowledge,
  onRecordView,
  onDismiss,
  onSignOut,
}) {
  const hold = target.hold
  const meta = SEVERITY_META.reminder

  // ── UI state ───────────────────────────────────────────────────────────
  const [acknowledged, setAcknowledged] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS)
  const [readyAnnouncement, setReadyAnnouncement] = useState('')

  const modalRef = useRef(null)
  const ackRef = useRef(null)
  const viewRecordedRef = useRef(false)

  // ── Record a view exactly once per target ─────────────────────────────
  useEffect(() => {
    if (!viewRecordedRef.current && target.target_id) {
      onRecordView(target.target_id)
      viewRecordedRef.current = true
    }
  }, [target.target_id, onRecordView])

  // ── Countdown ticker ──────────────────────────────────────────────────
  useEffect(() => {
    if (secondsLeft <= 0) return
    const timer = setTimeout(() => setSecondsLeft(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [secondsLeft])

  // ── Announce readiness once (not every second — too chatty) ───────────
  useEffect(() => {
    if (secondsLeft === 0 && !readyAnnouncement) {
      setReadyAnnouncement(
        'You may now acknowledge and dismiss this reminder.'
      )
    }
  }, [secondsLeft, readyAnnouncement])

  // ── Focus trap within modal ───────────────────────────────────────────
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

  // ── Initial focus on the ack checkbox (usable at any time) ────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      if (ackRef.current) ackRef.current.focus()
    }, FOCUS_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [])

  const handleAckChange = (e) => {
    const checked = e.target.checked
    setAcknowledged(checked)
    if (checked && target.target_id) {
      onAcknowledge(target.target_id)
    }
  }

  const canDismiss = secondsLeft === 0 && acknowledged

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
      aria-labelledby="reminder-dialog-title"
      aria-describedby="reminder-dialog-message"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 8500,   // below lockout (9000) so lockout always wins if both mount
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
          maxWidth: 520,
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.28)',
          overflow: 'hidden',
          margin: 'auto',
        }}
      >
        {/* Colored header bar */}
        <div
          style={{
            background: meta.color,
            color: 'white',
            padding: '16px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <AlertTriangle size={24} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 1,
                opacity: 0.88,
              }}
            >
              Reminder
            </div>
            <div style={{ fontSize: '0.98rem', fontWeight: 700 }}>
              {userFirstName ? `Please read, ${userFirstName}` : 'Please read'}
            </div>
          </div>
          {totalCount > 1 && (
            <span
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: '0.72rem',
                fontWeight: 600,
              }}
              aria-label={`Reminder 1 of ${totalCount}`}
            >
              Reminder 1 of {totalCount}
            </span>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '22px 22px 18px' }}>
          <h2
            id="reminder-dialog-title"
            style={{
              margin: '0 0 10px',
              fontSize: '1.1rem',
              fontWeight: 700,
              color: '#0f172a',
              lineHeight: 1.3,
            }}
          >
            {hold.title}
          </h2>
          <p
            id="reminder-dialog-message"
            style={{
              margin: '0 0 12px',
              fontSize: '0.92rem',
              color: '#334155',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {hold.message}
          </p>
          <p style={{ margin: '0 0 18px', fontSize: '0.74rem', color: '#64748b' }}>
            From {hold.created_by_name}
            {createdLine ? ` · ${createdLine}` : ''}
          </p>

          {/* Live region for the ready announcement (one-time, not chatty) */}
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {readyAnnouncement}
          </div>

          {/* Acknowledgment */}
          <div
            style={{
              background: '#fffbeb',
              border: `1px solid ${meta.borderColor}`,
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
                ref={ackRef}
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
                <span
                  style={{
                    display: 'block',
                    color: '#78716c',
                    fontSize: '0.78rem',
                    marginTop: 2,
                  }}
                >
                  You can tick this box at any time.
                </span>
              </span>
            </label>
          </div>

          {/* Readiness indicator */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.82rem',
              color: secondsLeft > 0 ? '#78716c' : '#047857',
              padding: '8px 12px',
              background: secondsLeft > 0 ? '#f5f5f4' : '#ecfdf5',
              border: `1px solid ${secondsLeft > 0 ? '#e7e5e4' : '#a7f3d0'}`,
              borderRadius: 8,
            }}
          >
            {secondsLeft > 0 ? (
              <>
                <Clock size={14} aria-hidden="true" />
                <span>
                  Please take a moment to read. Dismiss available in{' '}
                  <strong>{secondsLeft}s</strong>
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>
                  {acknowledged
                    ? 'Ready to dismiss.'
                    : 'Ready. Tick the checkbox above, then click Dismiss.'}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            borderTop: '1px solid #e2e8f0',
            padding: '14px 22px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: '#fafaf9',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={onSignOut}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              background: 'white',
              color: '#57534e',
              border: '1px solid #d6d3d1',
              borderRadius: 8,
              fontSize: '0.82rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
            onMouseOver={(e) => { e.currentTarget.style.background = '#f5f5f4' }}
            onMouseOut={(e) => { e.currentTarget.style.background = 'white' }}
          >
            <LogOut size={14} aria-hidden="true" />
            Sign Out
          </button>
          <button
            onClick={onDismiss}
            disabled={!canDismiss}
            aria-disabled={!canDismiss}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '9px 20px',
              background: canDismiss ? meta.color : '#e7e5e4',
              color: canDismiss ? 'white' : '#a8a29e',
              border: 'none',
              borderRadius: 8,
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: canDismiss ? 'pointer' : 'not-allowed',
              transition: 'background 150ms',
            }}
          >
            {secondsLeft > 0 ? `Dismiss (${secondsLeft}s)` : 'Dismiss'}
          </button>
        </div>
      </div>

      <style>{`
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
