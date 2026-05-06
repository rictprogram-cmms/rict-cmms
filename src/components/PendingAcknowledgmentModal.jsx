/**
 * RICT CMMS — PendingAcknowledgmentModal
 *
 * Modal a STUDENT sees in their own session when an instructor has requested
 * a checkout that needs the student's e-signature.
 *
 * The student typed-name + accept here is what creates the audit trail.
 * The server (acknowledge_asset_checkout RPC) verifies that
 *   auth.jwt().email === checkout.user_email
 * so an instructor cannot accidentally (or deliberately) sign on the
 * student's behalf — that's the entire point of this flow.
 *
 * The legacy "instructor-attested" hand-off lives elsewhere in the app and
 * sets handoff_method='instructor_attested' on the row, so the audit trail
 * can distinguish the two methods.
 *
 * Accessibility (WCAG 2.1 AA):
 *   - useDialogA11y (Esc closes, focus trap, focus restoration)
 *   - aria-modal="true", aria-labelledby, aria-describedby
 *   - Real <button> elements throughout
 *   - aria-live="polite" on the countdown — screen reader announces the
 *     state every minute or so without being torture (we throttle by only
 *     re-rendering the live region when the displayed text changes)
 *   - aria-required + aria-invalid on the typed-name field
 *   - Color is never the only signal: status pills carry icon + text,
 *     countdown urgency carries icon + text, error messages have icons
 *   - Decline path goes through a confirmation step so a misclick can't
 *     kill the request
 *   - Keyboard tab order matches visual order
 *
 * File: src/components/PendingAcknowledgmentModal.jsx
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  X, AlertTriangle, CheckCircle2, Loader2, Clock, ShieldCheck,
  ArrowLeft, Package,
} from 'lucide-react'
import useDialogA11y from '@/hooks/useDialogA11y'
import {
  useCheckoutActions,
  formatCountdown,
  fakeUtcToDisplay,
} from '@/hooks/useAssetCheckouts'

/* ───────────────────────────── Helpers ───────────────────────────── */

// Live re-rendering ticker — recomputes formatCountdown() every 30 seconds
// from inside the modal so it stays accurate even if the parent doesn't
// re-render. Kept lightweight: one interval per mounted modal.
function useNowTick() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

// Build the legal text exactly the way the server will when the row is signed.
// Shown to the student up-front so they know what they're agreeing to.
function buildAcknowledgmentText(checkout, typedName) {
  if (!checkout) return ''
  const namePart = typedName?.trim() || '[your name]'
  const sn = checkout.asset_serial_number ? `, SN ${checkout.asset_serial_number}` : ''
  const dueDate = checkout.expected_return
    ? fakeUtcToDisplay(checkout.expected_return)?.date || 'returned'
    : 'returned'
  return `I, ${namePart}, accept responsibility for asset ${checkout.asset_id} ` +
         `(${checkout.asset_name || ''}${sn}) ` +
         `until ${dueDate}, and agree to return it in the same condition.`
}

/* ───────────────────────── Countdown Pill ────────────────────────── */
/* Shows the live "Expires in 18h 23m" badge with appropriate urgency.
   Color pairs with an icon + text label so it doesn't rely on color alone.
*/
function CountdownPill({ expiresAt, now }) {
  const cd = formatCountdown(expiresAt, now)
  if (!cd) return null

  // Pick visuals + the screen-reader label that goes in aria-live below
  let cls = 'bg-surface-100 text-surface-700 border-surface-200'
  let Icon = Clock
  let prefix = 'Expires in'
  if (cd.expired) {
    cls = 'bg-red-50 text-red-700 border-red-200'
    Icon = AlertTriangle
    prefix = ''
  } else if (cd.urgent) {
    cls = 'bg-red-50 text-red-700 border-red-200'
    Icon = AlertTriangle
    prefix = 'Expires in'
  } else if (cd.soon) {
    cls = 'bg-amber-50 text-amber-700 border-amber-200'
    Icon = Clock
    prefix = 'Expires in'
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border ${cls}`}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{prefix} {cd.label}</span>
    </span>
  )
}

/* ───────────────────────── Decline Confirm ───────────────────────── */
/* Inner confirmation step — student typed Decline, we ask them to confirm
   and capture an optional reason. Stacked dialog (useDialogA11y handles
   the dialog stack so Esc only closes this one).
*/
function DeclineConfirm({ open, onCancel, onConfirm, saving }) {
  const dialogRef = useDialogA11y(open, onCancel)
  const titleId = useId()
  const descId = useId()
  const [reason, setReason] = useState('')

  // Reset when re-opened
  useEffect(() => { if (open) setReason('') }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[2100] flex items-center justify-center p-4 bg-black/50"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-2xl w-full max-w-sm shadow-xl overflow-hidden"
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-surface-200 bg-amber-50">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <AlertTriangle size={18} className="text-amber-600" aria-hidden="true" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-bold text-surface-900">
                Decline this checkout?
              </h2>
              <p id={descId} className="text-sm text-surface-500 mt-0.5">
                The asset will return to available and your instructor will be notified.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-amber-100 hover:text-surface-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
            aria-label="Cancel decline"
          >
            <span className="text-lg leading-none" aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="px-5 py-4">
          <label
            htmlFor="decline-reason"
            className="block text-sm font-semibold text-surface-700 mb-1.5"
          >
            Reason <span className="text-surface-400 font-normal">(optional)</span>
          </label>
          <textarea
            id="decline-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            rows={3}
            maxLength={500}
            placeholder="e.g. I don't need this asset right now"
            className="w-full px-3 py-2.5 text-sm border border-surface-200 rounded-xl resize-none transition-colors
              focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
              disabled:bg-surface-50 disabled:text-surface-400"
          />
          <p className="text-xs text-surface-400 mt-1">
            {reason.length}/500
          </p>
        </div>

        <div className="px-5 py-3 border-t border-surface-200 flex justify-end gap-2 bg-surface-50">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2.5 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg
              hover:bg-surface-100 transition-colors
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
              disabled:opacity-50"
          >
            Keep request
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={saving}
            className="px-4 py-2.5 text-sm font-medium text-white bg-amber-600 rounded-lg
              hover:bg-amber-700 transition-colors
              focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2
              disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Declining…
              </>
            ) : (
              'Yes, decline'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── Main Modal ─────────────────────────────── */
/**
 * Props:
 *   isOpen        boolean
 *   onClose       () => void                      // dismiss without action
 *   checkout      asset_checkouts row             // the pending request
 *   userName      string                          // student's display name (placeholder)
 *   onAcknowledged?(updatedRow) => void           // called after successful sign
 *   onDeclined?(updatedRow) => void               // called after successful decline
 */
export default function PendingAcknowledgmentModal({
  isOpen,
  onClose,
  checkout,
  userName,
  onAcknowledged,
  onDeclined,
}) {
  const dialogRef = useDialogA11y(isOpen, onClose)
  const titleId = useId()
  const descId = useId()
  const countdownLiveId = useId()
  const errorId = useId()
  const acknowledgmentTextId = useId()

  const { saving, acknowledgeCheckout, declineCheckout } = useCheckoutActions()
  const now = useNowTick()

  const [typedName, setTypedName] = useState('')
  const [showDecline, setShowDecline] = useState(false)
  const [error, setError] = useState('')

  // Reset state every time the modal is opened with a new checkout
  useEffect(() => {
    if (isOpen) {
      setTypedName('')
      setShowDecline(false)
      setError('')
    }
  }, [isOpen, checkout?.checkout_id])

  // Throttle aria-live announcements: only update the announced text when
  // the displayed countdown label changes. Avoids the screen reader speaking
  // every 30 seconds when nothing visibly changed.
  const cd = useMemo(
    () => formatCountdown(checkout?.expires_at, now),
    [checkout?.expires_at, now]
  )
  const lastAnnouncedRef = useRef('')
  const announcedText = useMemo(() => {
    if (!cd) return ''
    const text = cd.expired ? 'This request has expired' : cd.ariaLabel
    if (text !== lastAnnouncedRef.current) {
      lastAnnouncedRef.current = text
      return text
    }
    return lastAnnouncedRef.current
  }, [cd])

  if (!isOpen || !checkout) return null

  const expectedName = (userName || '').trim()
  const namesMatch = expectedName
    ? typedName.trim().toLowerCase() === expectedName.toLowerCase()
    : typedName.trim().length > 0

  const isExpired = !!cd?.expired
  const requestedAt = fakeUtcToDisplay(checkout.requested_at)
  const expectedReturn = fakeUtcToDisplay(checkout.expected_return)
  const previewText = buildAcknowledgmentText(checkout, typedName)

  const handleAcknowledge = async () => {
    setError('')
    if (isExpired) {
      setError('This request has expired. Please ask your instructor to start a new one.')
      return
    }
    if (!typedName.trim()) {
      setError('Please type your full name to confirm.')
      return
    }
    if (expectedName && !namesMatch) {
      setError(`Please type your full name exactly: "${expectedName}".`)
      return
    }
    try {
      const updated = await acknowledgeCheckout({
        checkoutId: checkout.checkout_id,
        acknowledgmentName: typedName.trim(),
      })
      onAcknowledged?.(updated)
      onClose?.()
    } catch (err) {
      setError(err.message || 'Could not acknowledge this checkout.')
    }
  }

  const handleDecline = async (reason) => {
    setError('')
    try {
      const updated = await declineCheckout({
        checkoutId: checkout.checkout_id,
        reason,
      })
      onDeclined?.(updated)
      setShowDecline(false)
      onClose?.()
    } catch (err) {
      setError(err.message || 'Could not decline this checkout.')
      setShowDecline(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/50"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-surface-200 bg-brand-50">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <ShieldCheck size={18} className="text-brand-600" aria-hidden="true" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-bold text-surface-900">
                Acknowledge asset checkout
              </h2>
              <p id={descId} className="text-sm text-surface-500 mt-0.5">
                Please review and e-sign to accept this asset.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-brand-100 hover:text-surface-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
            aria-label="Close acknowledgment dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Asset summary */}
          <div className="px-5 py-4 border-b border-surface-200">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-surface-100 flex items-center justify-center flex-shrink-0">
                <Package size={20} className="text-surface-500" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-surface-900 break-words">
                  {checkout.asset_name || '(unnamed asset)'}
                </p>
                <p className="text-xs text-surface-500 mt-0.5">
                  {checkout.asset_id}
                  {checkout.asset_serial_number && (
                    <> · <span>SN {checkout.asset_serial_number}</span></>
                  )}
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {expectedReturn && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full bg-surface-100 text-surface-700 border border-surface-200">
                      <Clock size={12} aria-hidden="true" />
                      Due {expectedReturn.date}
                    </span>
                  )}
                  {checkout.checkout_condition && (
                    <span className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full bg-surface-100 text-surface-700 border border-surface-200">
                      Condition: {checkout.checkout_condition}
                    </span>
                  )}
                  <CountdownPill expiresAt={checkout.expires_at} now={now} />
                </div>
                {checkout.checkout_notes && (
                  <p className="text-xs text-surface-600 mt-2 italic break-words">
                    Note from instructor: {checkout.checkout_notes}
                  </p>
                )}
                {requestedAt && (
                  <p className="text-[11px] text-surface-400 mt-2">
                    Requested by {checkout.requested_by || 'instructor'} on {requestedAt.date} at {requestedAt.time}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Live region for the countdown — announces only when the label changes */}
          <span id={countdownLiveId} aria-live="polite" className="sr-only">
            {announcedText}
          </span>

          {/* Expired state */}
          {isExpired ? (
            <div className="px-5 py-6 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-50 mb-3">
                <AlertTriangle size={24} className="text-red-600" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-surface-900">
                This request has expired
              </p>
              <p className="text-xs text-surface-500 mt-1">
                Please ask your instructor to start a new checkout request.
              </p>
            </div>
          ) : (
            <>
              {/* The legal text — what the student is agreeing to */}
              <div className="px-5 py-4 border-b border-surface-200">
                <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-2">
                  Acknowledgment
                </p>
                <div
                  id={acknowledgmentTextId}
                  className="px-3 py-3 bg-surface-50 border border-surface-200 rounded-lg text-sm text-surface-700 italic break-words"
                >
                  &ldquo;{previewText}&rdquo;
                </div>
              </div>

              {/* Typed-name signature */}
              <div className="px-5 py-4">
                <label
                  htmlFor="ack-typed-name"
                  className="block text-sm font-semibold text-surface-700 mb-1.5"
                >
                  Type your full name to e-sign{' '}
                  <span className="text-red-500" aria-hidden="true">*</span>
                  <span className="sr-only">(required)</span>
                </label>
                <input
                  id="ack-typed-name"
                  type="text"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  disabled={saving}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={expectedName || 'Your full name'}
                  aria-required="true"
                  aria-invalid={!!error}
                  aria-describedby={`${acknowledgmentTextId}${error ? ` ${errorId}` : ''}`}
                  className={`w-full px-3 py-2.5 text-sm border rounded-xl transition-colors
                    focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
                    disabled:bg-surface-50 disabled:text-surface-400
                    ${error ? 'border-red-300' : 'border-surface-200'}`}
                />
                {expectedName && (
                  <p className="text-xs text-surface-400 mt-1.5">
                    Type{' '}
                    <span className="font-medium text-surface-600">&ldquo;{expectedName}&rdquo;</span>
                    {' '}exactly.
                  </p>
                )}

                {error && (
                  <div
                    id={errorId}
                    role="alert"
                    aria-live="assertive"
                    className="flex items-start gap-2 mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200"
                  >
                    <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <p className="text-xs text-red-700">{error}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer / actions */}
        <div className="px-5 py-3 border-t border-surface-200 flex flex-wrap items-center justify-end gap-2 bg-surface-50">
          {!isExpired && (
            <button
              type="button"
              onClick={() => setShowDecline(true)}
              disabled={saving}
              className="px-4 py-2.5 text-sm font-medium text-amber-700 bg-white border border-amber-200 rounded-lg
                hover:bg-amber-50 transition-colors
                focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2
                disabled:opacity-50 inline-flex items-center gap-2 mr-auto"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Decline
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg
              hover:bg-surface-100 transition-colors
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
              disabled:opacity-50"
          >
            {isExpired ? 'Close' : 'Decide later'}
          </button>

          {!isExpired && (
            <button
              type="button"
              onClick={handleAcknowledge}
              disabled={saving || !typedName.trim() || (expectedName && !namesMatch)}
              className="px-4 py-2.5 text-sm font-semibold text-white bg-brand-600 rounded-lg
                hover:bg-brand-700 transition-colors
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
                disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  Confirming…
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  I confirm — accept asset
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Stacked decline confirmation */}
      <DeclineConfirm
        open={showDecline}
        saving={saving}
        onCancel={() => setShowDecline(false)}
        onConfirm={handleDecline}
      />
    </div>
  )
}
