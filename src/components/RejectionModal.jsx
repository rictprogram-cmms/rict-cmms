/**
 * RICT CMMS — RejectionModal
 *
 * A shared, WCAG 2.1 AA accessible modal used by every page that rejects
 * a student request (time entry, access, work order, lab signup, temp access, PO).
 *
 * Accessibility features:
 *   - Focus trap (Tab / Shift+Tab cycle within modal)
 *   - Escape key closes modal
 *   - aria-labelledby / aria-describedby
 *   - Auto-focus on the textarea when opened
 *   - Visible focus rings (focus-visible)
 *   - role="dialog" + aria-modal="true"
 *   - Screen-reader-friendly error announcements (aria-live)
 *
 * Usage:
 *   <RejectionModal
 *     open={showRejectModal}
 *     title="Reject Time Entry Request"
 *     subtitle="TER000012 — John D. requested 2h on 3/15"
 *     requestType="Time Entry Request"
 *     requestId="TER000012"
 *     recipientEmail="john@example.com"
 *     recipientName="John D."
 *     onConfirm={async (reason) => { await doReject(reason) }}
 *     onClose={() => setShowRejectModal(false)}
 *   />
 *
 * File: src/components/RejectionModal.jsx
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { XCircle, Loader2, AlertTriangle } from 'lucide-react'

const MIN_REASON_LENGTH = 5

export default function RejectionModal({
  open,
  title = 'Reject Request',
  subtitle = '',
  requestType = '',
  requestId = '',
  recipientEmail = '',
  recipientName = '',
  onConfirm,
  onClose,
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const textareaRef = useRef(null)
  const modalRef = useRef(null)
  const firstFocusableRef = useRef(null)
  const lastFocusableRef = useRef(null)

  // ── Reset state when modal opens ──────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setReason('')
      setSaving(false)
      setError('')
      // Small delay to ensure DOM is rendered before focusing
      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [open])

  // ── Escape key handler ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !saving) {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, saving, onClose])

  // ── Focus trap ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || !modalRef.current) return

    const handleTab = (e) => {
      if (e.key !== 'Tab') return

      const focusableEls = modalRef.current.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusableEls.length === 0) return

      const first = focusableEls[0]
      const last = focusableEls[focusableEls.length - 1]

      if (e.shiftKey) {
        // Shift+Tab: if on first element, wrap to last
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab: if on last element, wrap to first
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleTab)
    return () => document.removeEventListener('keydown', handleTab)
  }, [open])

  // ── Lock body scroll when open ────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [open])

  // ── Confirm handler ───────────────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    const trimmed = reason.trim()
    if (trimmed.length < MIN_REASON_LENGTH) {
      setError(`Please provide a reason (at least ${MIN_REASON_LENGTH} characters).`)
      textareaRef.current?.focus()
      return
    }

    setError('')
    setSaving(true)

    try {
      await onConfirm(trimmed)
      // Parent is responsible for closing the modal on success
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.')
      setSaving(false)
    }
  }, [reason, onConfirm])

  if (!open) return null

  const titleId = 'rejection-modal-title'
  const descId = 'rejection-modal-desc'

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descId : undefined}
        className="bg-white rounded-2xl w-full max-w-md shadow-xl overflow-hidden"
      >
        {/* ── Header ── */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-surface-200 bg-red-50">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <XCircle size={18} className="text-red-600" aria-hidden="true" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-bold text-surface-900">
                {title}
              </h2>
              {subtitle && (
                <p id={descId} className="text-sm text-surface-500 mt-0.5">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-red-100 hover:text-surface-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
            aria-label="Close rejection dialog"
          >
            <span className="text-lg leading-none" aria-hidden="true">&times;</span>
          </button>
        </div>

        {/* ── Body ── */}
        <div className="px-5 py-4">
          {/* Info chips showing who/what is being rejected */}
          {(requestType || requestId || recipientName) && (
            <div className="flex flex-wrap gap-2 mb-3">
              {requestType && (
                <span className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full bg-surface-100 text-surface-600">
                  {requestType}
                </span>
              )}
              {requestId && (
                <span className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full bg-surface-100 text-surface-600">
                  {requestId}
                </span>
              )}
              {recipientName && (
                <span className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  To: {recipientName}
                </span>
              )}
            </div>
          )}

          <label
            htmlFor="rejection-reason"
            className="block text-sm font-semibold text-surface-700 mb-1.5"
          >
            Reason for Rejection <span className="text-red-500">*</span>
          </label>
          <p className="text-xs text-surface-400 mb-2">
            This will be sent to the student so they understand why their request was not approved.
          </p>
          <textarea
            ref={textareaRef}
            id="rejection-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              if (error) setError('')
            }}
            rows={4}
            placeholder="e.g., Hours exceed the scheduled lab time for that day..."
            className={`w-full px-3 py-2.5 text-sm border rounded-xl resize-none transition-colors
              focus:outline-none focus:ring-2 focus:border-transparent
              ${error
                ? 'border-red-300 focus:ring-red-500'
                : 'border-surface-200 focus:ring-brand-500'
              }`}
            aria-required="true"
            aria-invalid={!!error}
            aria-describedby={error ? 'rejection-error' : 'rejection-hint'}
            disabled={saving}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter to submit
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                handleConfirm()
              }
            }}
          />

          {/* Character count / hint */}
          {!error && (
            <p id="rejection-hint" className="text-xs text-surface-400 mt-1.5 text-right">
              {reason.trim().length < MIN_REASON_LENGTH
                ? `${MIN_REASON_LENGTH - reason.trim().length} more character${MIN_REASON_LENGTH - reason.trim().length !== 1 ? 's' : ''} needed`
                : `${reason.trim().length} characters`
              }
            </p>
          )}

          {/* Error message */}
          {error && (
            <div
              id="rejection-error"
              role="alert"
              aria-live="assertive"
              className="flex items-start gap-2 mt-2 p-2.5 rounded-lg bg-red-50 border border-red-200"
            >
              <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-5 py-3 border-t border-surface-200 flex justify-end gap-2 bg-surface-50">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg
              hover:bg-surface-100 transition-colors
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving || reason.trim().length < MIN_REASON_LENGTH}
            className="px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg
              hover:bg-red-700 active:bg-red-800 transition-colors shadow-sm
              focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2
              disabled:opacity-50 disabled:cursor-not-allowed
              flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Rejecting…
              </>
            ) : (
              'Reject & Notify Student'
            )}
          </button>
        </div>

        {/* Keyboard shortcut hint */}
        <div className="px-5 pb-3 bg-surface-50">
          <p className="text-[11px] text-surface-400 text-right">
            <kbd className="px-1.5 py-0.5 bg-surface-200 rounded text-[10px] font-mono">Ctrl</kbd>
            {' + '}
            <kbd className="px-1.5 py-0.5 bg-surface-200 rounded text-[10px] font-mono">Enter</kbd>
            {' to submit'}
          </p>
        </div>
      </div>
    </div>
  )
}
