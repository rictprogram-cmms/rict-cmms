import { cn } from '@/lib/utils'
import { X, Loader2, Inbox } from 'lucide-react'
import { useEffect, useRef } from 'react'

// ─── Badge ──────────────────────────────────────────────────────────────────

export function Badge({ children, className, variant = 'default', ...props }) {
  return (
    <span className={cn('badge', className)} {...props}>
      {children}
    </span>
  )
}

export function PriorityBadge({ priority }) {
  const styles = {
    Critical: 'bg-red-100 text-red-800',
    High: 'bg-orange-100 text-orange-800',
    Medium: 'bg-yellow-100 text-yellow-800',
    Low: 'bg-green-100 text-green-800',
  }
  return <Badge className={styles[priority] || styles.Medium}>{priority}</Badge>
}

export function StatusBadge({ status }) {
  const styles = {
    Open: 'bg-blue-100 text-blue-800',
    'In Progress': 'bg-indigo-100 text-indigo-800',
    'Awaiting Parts': 'bg-amber-100 text-amber-800',
    'On Hold': 'bg-surface-200 text-surface-700',
    Reopened: 'bg-purple-100 text-purple-800',
    Closed: 'bg-emerald-100 text-emerald-800',
  }
  return <Badge className={styles[status] || 'bg-surface-100 text-surface-700'}>{status}</Badge>
}

// ─── Modal ──────────────────────────────────────────────────────────────────

export function Modal({ open, onClose, title, children, size = 'md', footer }) {
  const overlayRef = useRef()

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => {
    function handleEscape(e) {
      if (e.key === 'Escape') onClose?.()
    }
    if (open) document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open, onClose])

  if (!open) return null

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-[90vw]',
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 animate-fade-in"
      onClick={(e) => e.target === overlayRef.current && onClose?.()}
    >
      <div className="fixed inset-0 bg-surface-900/40 backdrop-blur-sm" />
      <div
        className={cn(
          'relative w-full bg-white rounded-2xl shadow-modal animate-slide-up',
          'max-h-[80vh] flex flex-col',
          sizes[size]
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <h2 className="text-lg font-semibold text-surface-900">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-surface-100 bg-surface-50 rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Confirm Dialog ─────────────────────────────────────────────────────────

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
}) {
  if (!open) return null

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <p className="text-sm text-surface-600">{message}</p>
      <div className="flex justify-end gap-3 mt-6">
        <button onClick={onClose} className="btn-secondary">
          {cancelLabel}
        </button>
        <button
          onClick={() => { onConfirm(); onClose() }}
          className={variant === 'danger' ? 'btn-danger' : 'btn-primary'}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

// ─── Loading States ─────────────────────────────────────────────────────────

export function Spinner({ size = 20, className }) {
  return <Loader2 size={size} className={cn('animate-spin text-brand-600', className)} />
}

export function LoadingScreen({ message = 'Loading...' }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
      <Spinner size={28} />
      <p className="text-sm text-surface-500">{message}</p>
    </div>
  )
}

export function PageLoading() {
  return (
    <div className="flex items-center justify-center h-full min-h-[60vh]">
      <Spinner size={32} />
    </div>
  )
}

// ─── Empty State ────────────────────────────────────────────────────────────

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-surface-100 flex items-center justify-center mb-4">
        <Icon size={24} className="text-surface-400" />
      </div>
      <h3 className="text-base font-semibold text-surface-900 mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-surface-500 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ─── LateBadge ──────────────────────────────────────────────────────────────

export function LateBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-red-600 text-white rounded">
      Late
    </span>
  )
}
