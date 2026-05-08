/**
 * RICT CMMS — WhatsNewModal
 *
 * One-time popup that surfaces new changelog entries to a user after a
 * release. Driven by useChangelog (src/hooks/useChangelog.js) — see that
 * hook for the open/dismiss state machine and the per-user marker.
 *
 * Accessibility (WCAG 2.1 AA):
 *   • role="dialog" + aria-modal="true" + aria-labelledby/aria-describedby
 *   • Focus trapped inside the dialog (via useDialogA11y)
 *   • Escape key closes the dialog (via useDialogA11y)
 *   • Focus returns to the previously focused element on close
 *   • Real <button> elements (not div role="button")
 *   • Lucide icons marked aria-hidden; semantic text labels carry meaning
 *   • prefers-reduced-motion respected (see whats-new-modal.css)
 *   • 44×44 touch targets on mobile (see whats-new-modal.css)
 *
 * The modal is intentionally read-only — there is no "remind me later"
 * action. Dismissing marks all shown entries as seen. Users can revisit
 * the full changelog any time via the Bug Tracker page.
 *
 * File: src/components/WhatsNewModal.jsx
 */

import { Sparkles, Bug, Wrench, X, Megaphone, FileText } from 'lucide-react'
import useDialogA11y from '@/hooks/useDialogA11y'
import '@/styles/whats-new-modal.css'

// Map changelog `type` values to badge styling + a Lucide icon. Keys are
// matched case-insensitively. Any unknown type falls back to a neutral grey.
const TYPE_CONFIG = {
  feature:     { icon: Sparkles,  label: 'New Feature',  bg: '#e7f5ff', color: '#1971c2' },
  'new feature': { icon: Sparkles, label: 'New Feature', bg: '#e7f5ff', color: '#1971c2' },
  bug:         { icon: Bug,       label: 'Bug Fix',      bg: '#fff5f5', color: '#c92a2a' },
  'bug fix':   { icon: Bug,       label: 'Bug Fix',      bg: '#fff5f5', color: '#c92a2a' },
  fix:         { icon: Bug,       label: 'Bug Fix',      bg: '#fff5f5', color: '#c92a2a' },
  improvement: { icon: Wrench,    label: 'Improvement',  bg: '#fff9db', color: '#856404' },
  enhancement: { icon: Wrench,    label: 'Improvement',  bg: '#fff9db', color: '#856404' },
  release:     { icon: Megaphone, label: 'Release',      bg: '#f3e8ff', color: '#7c3aed' },
  major:       { icon: Megaphone, label: 'Major Update', bg: '#f3e8ff', color: '#7c3aed' },
  docs:        { icon: FileText,  label: 'Docs',         bg: '#f1f3f5', color: '#495057' },
}

function getTypeConfig(type) {
  const key = String(type || '').trim().toLowerCase()
  return (
    TYPE_CONFIG[key] ||
    { icon: Sparkles, label: type || 'Update', bg: '#f1f3f5', color: '#495057' }
  )
}

// Format YYYY-MM-DD into "Mon D, YYYY" using local time (no UTC shift).
// Falls back to the raw string if it can't be parsed.
function formatDate(dateStr) {
  if (!dateStr) return ''
  const s = String(dateStr).slice(0, 10)
  const parts = s.split('-')
  if (parts.length !== 3) return dateStr
  const [y, m, d] = parts.map(Number)
  if (!y || !m || !d) return dateStr
  const dt = new Date(y, m - 1, d)
  if (Number.isNaN(dt.getTime())) return dateStr
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function WhatsNewModal({ open, entries, onDismiss }) {
  // useDialogA11y returns a ref + manages focus/Escape/focus-trap.
  // Safe to call unconditionally — internally bails when open=false.
  const dialogRef = useDialogA11y(open, onDismiss)

  if (!open || !entries || entries.length === 0) return null

  // Group entries by version. Each group renders as a section with a
  // version-level <h3> and the entries below it. We sort groups by date
  // descending so the newest version sits at the top.
  const byVersion = new Map()
  for (const e of entries) {
    const key = e.version || '(unversioned)'
    if (!byVersion.has(key)) {
      byVersion.set(key, { version: key, release_date: e.release_date, items: [] })
    }
    const group = byVersion.get(key)
    group.items.push(e)
    // Track latest date in the group for sorting + display.
    if (e.release_date > group.release_date) group.release_date = e.release_date
  }
  const groups = Array.from(byVersion.values()).sort((a, b) => {
    if (b.release_date > a.release_date) return 1
    if (b.release_date < a.release_date) return -1
    return 0
  })

  return (
    <div className="wn-modal-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="wn-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wn-modal-title"
        aria-describedby="wn-modal-desc"
      >
        <div className="wn-modal-header">
          <div className="wn-modal-title-wrap">
            <span className="wn-modal-icon" aria-hidden="true">
              <Sparkles size={20} />
            </span>
            <h2 id="wn-modal-title" className="wn-modal-title">What's New</h2>
          </div>
          <button
            type="button"
            className="wn-modal-close"
            onClick={onDismiss}
            aria-label="Close What's New dialog"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="wn-modal-body">
          <p id="wn-modal-desc" className="wn-modal-desc">
            Here's what's been updated since you last visited. You can revisit
            the full changelog any time on the Bug Tracker page.
          </p>

          {groups.map(group => {
            const headingId = `wn-version-${String(group.version).replace(/\W+/g, '-')}`
            return (
              <section
                key={group.version}
                className="wn-version-group"
                aria-labelledby={headingId}
              >
                <header className="wn-version-header">
                  <h3 id={headingId} className="wn-version-title">
                    Version {group.version}
                  </h3>
                  <span className="wn-version-date">{formatDate(group.release_date)}</span>
                </header>
                <ul className="wn-entry-list">
                  {group.items.map((item, idx) => {
                    const cfg = getTypeConfig(item.type)
                    const Icon = cfg.icon
                    const key = item.request_id || `${group.version}-${idx}`
                    return (
                      <li key={key} className="wn-entry">
                        <span
                          className="wn-entry-badge"
                          style={{ background: cfg.bg, color: cfg.color }}
                        >
                          <Icon size={12} aria-hidden="true" />
                          <span>{cfg.label}</span>
                        </span>
                        <span className="wn-entry-title">{item.title}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>

        <div className="wn-modal-footer">
          <button type="button" className="wn-btn-primary" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
