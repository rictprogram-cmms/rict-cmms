import { useState, useEffect, useRef, useMemo } from 'react'
import {
  useMyActiveHolds,
  useHoldActions,
  SEVERITY_META,
} from '@/hooks/useStudentHolds'
import { Info, Check } from 'lucide-react'

// ════════════════════════════════════════════════════════════════════════════
// HoldNudgeBanner — tier-1 non-blocking nudge
// ────────────────────────────────────────────────────────────────────────────
// Sky-blue banner(s) rendered inline in the main content area, above the
// page <Outlet/>. Does NOT block navigation — students can do anything
// while a nudge is up.
//
// Dismissal:
//   - "Got it" button records acknowledgment in the DB (writes
//     acknowledged_at) and hides the banner for this browser session.
//   - Dismissed target_ids live in sessionStorage (separate key from
//     reminders, so they don't get crossed). On next login the nudge
//     returns until an instructor clears the hold in the DB.
//
// Multiple nudges stack vertically. No priority between nudges; they sort
// by created_at inside the hook already.
//
// Mounted inline (not overlay) so it renders behind any active Lockout or
// Reminder modal automatically via the stacking context. No hide-if-modal-
// open logic needed — screen readers also skip it because those modals use
// aria-modal="true".
// ════════════════════════════════════════════════════════════════════════════

const SESSION_STORAGE_KEY = 'rict_cmms_dismissed_nudges'


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
    /* ignore — sessionStorage may be disabled */
  }
}


export default function HoldNudgeBanner() {
  const { holds } = useMyActiveHolds()
  const { acknowledgeTarget, recordView } = useHoldActions()

  // Pull just the nudge-tier targets
  const nudgeTargets = useMemo(
    () => holds.filter(h => h.hold?.severity === 'nudge'),
    [holds]
  )

  // Per-session dismissed set
  const [dismissedIds, setDismissedIds] = useState(() => loadDismissed())

  // Prune dismissedIds entries for targets that no longer exist (instructor
  // cleared or deleted them). Keeps sessionStorage from growing unbounded.
  useEffect(() => {
    const validIds = new Set(nudgeTargets.map(t => t.target_id))
    const pruned = new Set([...dismissedIds].filter(id => validIds.has(id)))
    if (pruned.size !== dismissedIds.size) {
      setDismissedIds(pruned)
      saveDismissed(pruned)
    }
  }, [nudgeTargets, dismissedIds])

  // Filter to what we still need to show
  const pending = useMemo(
    () => nudgeTargets.filter(t => !dismissedIds.has(t.target_id)),
    [nudgeTargets, dismissedIds]
  )

  const handleDismiss = (target) => {
    // Record ack in the DB (only writes if acknowledged_at is still NULL)
    if (target.target_id) {
      acknowledgeTarget(target.target_id)
    }
    // Hide for this session
    const next = new Set(dismissedIds)
    next.add(target.target_id)
    setDismissedIds(next)
    saveDismissed(next)
  }

  if (pending.length === 0) return null

  return (
    <div
      role="region"
      aria-label="Important notices"
      style={{ marginBottom: 12 }}
    >
      {pending.map(target => (
        <NudgeCard
          key={target.target_id}
          target={target}
          recordView={recordView}
          onDismiss={() => handleDismiss(target)}
        />
      ))}
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════════
// NudgeCard — a single banner
// ════════════════════════════════════════════════════════════════════════════

function NudgeCard({ target, recordView, onDismiss }) {
  const hold = target.hold
  const meta = SEVERITY_META.nudge
  const viewedRef = useRef(false)

  // Record a view exactly once per card instance
  useEffect(() => {
    if (!viewedRef.current && target.target_id) {
      recordView(target.target_id)
      viewedRef.current = true
    }
  }, [target.target_id, recordView])

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
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        background: meta.bgColor,
        border: `1px solid ${meta.borderColor}`,
        borderLeft: `4px solid ${meta.color}`,
        borderRadius: 12,
        padding: '12px 16px',
        marginBottom: 10,
      }}
    >
      <Info
        size={20}
        color={meta.color}
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.88rem',
            fontWeight: 700,
            color: '#0c4a6e',
            marginBottom: 3,
            lineHeight: 1.3,
          }}
        >
          {hold.title}
        </div>
        <div
          style={{
            fontSize: '0.84rem',
            color: '#075985',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
          }}
        >
          {hold.message}
        </div>
        <div
          style={{
            fontSize: '0.72rem',
            color: '#0284c7',
            marginTop: 6,
          }}
        >
          From {hold.created_by_name}
          {createdLine ? ` · ${createdLine}` : ''}
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label={`Dismiss notice: ${hold.title}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 12px',
          background: 'white',
          border: `1px solid ${meta.borderColor}`,
          borderRadius: 6,
          fontSize: '0.78rem',
          fontWeight: 500,
          color: meta.color,
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'background 150ms',
        }}
        onMouseOver={(e) => { e.currentTarget.style.background = '#f0f9ff' }}
        onMouseOut={(e) => { e.currentTarget.style.background = 'white' }}
      >
        <Check size={12} aria-hidden="true" />
        Got it
      </button>
    </div>
  )
}
