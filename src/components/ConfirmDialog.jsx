/**
 * RICT CMMS — ConfirmDialog
 *
 * Shared, themed replacement for window.confirm(). Renders a small modal
 * styled to match the program (surface/brand tokens, rounded-xl card,
 * black/50 overlay) with a danger or primary confirm button.
 *
 * Accessibility (WCAG 2.1 AA):
 *   - useDialogA11y: focus trap, Escape-to-close, focus restore on close,
 *     stacked-dialog aware (safe to open above another modal)
 *   - role="dialog", aria-modal, aria-labelledby, aria-describedby
 *   - 44px minimum touch targets on action buttons
 *   - focus-visible rings on all interactive elements
 *   - Icon is decorative (aria-hidden); meaning is carried by text
 *
 * Usage:
 *   {confirmTarget && (
 *     <ConfirmDialog
 *       open
 *       variant="danger"
 *       title="Retire equipment?"
 *       message={<>Retire <strong>{name}</strong>? Existing bookings remain.</>}
 *       confirmLabel="Retire equipment"
 *       cancelLabel="Keep active"
 *       busy={saving}
 *       onConfirm={handleConfirmed}
 *       onClose={() => setConfirmTarget(null)}
 *     />
 *   )}
 *
 * Props:
 *   open          boolean  — render/mount control (component returns null when false)
 *   title         string   — dialog heading
 *   message       node     — body content (string or JSX)
 *   confirmLabel  string   — confirm button text (default "Confirm")
 *   cancelLabel   string   — cancel button text (default "Cancel")
 *   variant       'danger' | 'primary' — confirm button styling (default 'danger')
 *   busy          boolean  — shows spinner on confirm button and disables it
 *   onConfirm     fn       — called when confirm is pressed
 *   onClose       fn       — called on cancel, X, Escape, or backdrop click
 *
 * File: src/components/ConfirmDialog.jsx
 */

import { useId } from 'react'
import { AlertTriangle, HelpCircle, Loader2, X } from 'lucide-react'
import { useDialogA11y } from '@/hooks/useDialogA11y'

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  busy = false,
  onConfirm,
  onClose,
}) {
  const dialogRef = useDialogA11y(open, onClose)
  const titleId = useId()
  const descId = useId()

  if (!open) return null

  const isDanger = variant === 'danger'
  const Icon = isDanger ? AlertTriangle : HelpCircle

  return (
    <div
      className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-xl w-full max-w-sm shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-surface-200">
          <div className="flex items-center gap-2.5">
            <span
              className={`flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full ${
                isDanger ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600'
              }`}
            >
              <Icon size={16} aria-hidden="true" />
            </span>
            <h2 id={titleId} className="text-base font-semibold text-surface-900">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-60"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div id={descId} className="p-4 text-sm text-surface-700">
          {message}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50 rounded-b-xl">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-lg border border-surface-300 text-surface-700 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`min-h-[44px] px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 inline-flex items-center gap-2 ${
              isDanger
                ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-600'
                : 'bg-brand-600 hover:bg-brand-700 focus-visible:ring-brand-600'
            }`}
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
