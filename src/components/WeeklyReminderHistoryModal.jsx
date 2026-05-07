/**
 * RICT CMMS — Weekly Reminder History Modal
 *
 * Shows the append-only audit trail of every reminder change (create/update/clear)
 * with optional filtering by scope (all / global / specific class). Each entry
 * shows the old → new transition rendered as markdown so instructors see exactly
 * what students saw at the time.
 *
 * Auto-pruned server-side to last 100 changes per scope.
 *
 * Accessibility:
 *   • Uses shared useDialogA11y hook (Escape, focus trap, focus restore)
 *   • role="dialog" + aria-modal + aria-labelledby
 *   • Scope filter is a labeled <select> with proper htmlFor binding
 *   • Empty state and loading state are announced via aria-live
 *
 * File: src/components/WeeklyReminderHistoryModal.jsx
 */

import { useMemo, useState, useId } from 'react'
import { X, History, Loader2, MessageSquareText, Trash2, Plus, Edit3, Globe } from 'lucide-react'
import { useReminderHistory } from '@/hooks/useSettings'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// ─── Markdown preview (shared with the popup; safe to render — no raw HTML) ──
function MarkdownPreview({ text }) {
  if (!text || !text.trim()) {
    return <em className="text-surface-400 text-xs">(empty)</em>
  }
  return (
    <div className="reminder-markdown text-sm leading-snug">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-indigo-700 hover:text-indigo-900 focus-visible:ring-2 focus-visible:ring-indigo-400 rounded"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
          p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
          code: ({ children }) => (
            <code className="px-1 py-0.5 rounded bg-surface-100 text-[0.85em] font-mono">{children}</code>
          ),
          h1: ({ children }) => <p className="font-bold text-base mb-1.5">{children}</p>,
          h2: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
          h3: ({ children }) => <p className="font-semibold text-sm mb-1">{children}</p>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// ─── Format ISO timestamp (fake-UTC convention is OK here — display only) ────
function formatTimestamp(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

// ─── Action pill (Create / Update / Clear) ───────────────────────────────────
function ActionPill({ oldMessage, newMessage }) {
  if (!newMessage || !newMessage.trim()) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-50 text-red-700 rounded text-[10px] font-bold uppercase tracking-wide">
        <Trash2 size={10} aria-hidden="true" /> Cleared
      </span>
    )
  }
  if (!oldMessage || !oldMessage.trim()) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[10px] font-bold uppercase tracking-wide">
        <Plus size={10} aria-hidden="true" /> Created
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-bold uppercase tracking-wide">
      <Edit3 size={10} aria-hidden="true" /> Updated
    </span>
  )
}

// ─── Main modal ─────────────────────────────────────────────────────────────
export default function WeeklyReminderHistoryModal({ isOpen, onClose, classes = [] }) {
  // 'all' | 'global' (mapped to NULL) | <class_id>
  const [scopeKey, setScopeKey] = useState('all')
  const dialogRef = useDialogA11y(isOpen, onClose)
  const titleId = useId()
  const filterId = useId()

  // Translate UI scopeKey → hook filter shape
  const scopeFilter = scopeKey === 'all' ? 'all' : scopeKey === 'global' ? null : scopeKey
  const { history, loading } = useReminderHistory(scopeFilter)

  const scopeOptions = useMemo(() => {
    const opts = [
      { key: 'all', label: 'All scopes' },
      { key: 'global', label: 'Global (All Classes)' },
    ]
    classes.forEach(c => {
      const lbl = c.semester ? `${c.course_id} (${c.semester})` : (c.course_id || c.class_id)
      opts.push({ key: c.class_id, label: lbl })
    })
    return opts
  }, [classes])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
          <div className="flex items-center gap-2.5 min-w-0">
            <History size={20} className="text-indigo-600 flex-shrink-0" aria-hidden="true" />
            <h2 id={titleId} className="text-lg font-bold text-surface-900 truncate">
              Reminder History
            </h2>
            <span className="text-xs text-surface-400 hidden sm:inline">
              · last 100 changes per scope
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-500 focus-visible:ring-2 focus-visible:ring-indigo-400 focus:outline-none"
            aria-label="Close history"
          >
            <X size={20} />
          </button>
        </div>

        {/* Scope filter */}
        <div className="px-6 py-3 border-b border-surface-200 bg-surface-50 flex items-center gap-3 flex-wrap">
          <label htmlFor={filterId} className="text-xs font-semibold text-surface-600">
            Filter by scope:
          </label>
          <select
            id={filterId}
            value={scopeKey}
            onChange={e => setScopeKey(e.target.value)}
            className="text-sm px-3 py-1.5 border border-surface-300 rounded-md bg-white focus-visible:ring-2 focus-visible:ring-indigo-400 focus:outline-none"
          >
            {scopeOptions.map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <span className="text-xs text-surface-400 ml-auto" aria-live="polite">
            {loading ? 'Loading…' : `${history.length} ${history.length === 1 ? 'entry' : 'entries'}`}
          </span>
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3" role="region" aria-live="polite">
          {loading ? (
            <div className="text-center py-8 text-surface-400">
              <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
              <p className="text-sm">Loading history…</p>
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-12 text-surface-400">
              <MessageSquareText size={32} className="mx-auto mb-3 opacity-50" aria-hidden="true" />
              <p className="text-sm font-medium">No history entries for this scope.</p>
              <p className="text-xs mt-1 text-surface-300">
                Changes will appear here once you set or update a reminder.
              </p>
            </div>
          ) : (
            history.map(h => {
              const isGlobal = !h.class_id
              return (
                <div
                  key={h.id}
                  className="border border-surface-200 rounded-lg p-3 bg-white hover:border-surface-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      {isGlobal ? (
                        <Globe size={13} className="text-indigo-500 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <MessageSquareText size={13} className="text-surface-500 flex-shrink-0" aria-hidden="true" />
                      )}
                      <span className="font-semibold text-sm text-surface-900 truncate">
                        {h.class_label || (isGlobal ? 'All Classes' : h.class_id)}
                      </span>
                      <ActionPill oldMessage={h.old_message} newMessage={h.new_message} />
                    </div>
                    <div className="text-xs text-surface-500 flex items-center gap-1.5 flex-shrink-0">
                      <span>{formatTimestamp(h.changed_at)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-surface-600">{h.changed_by || 'Unknown'}</span>
                    </div>
                  </div>

                  <div className="space-y-2 mt-2">
                    {h.old_message && h.old_message.trim() && (
                      <div>
                        <div className="text-[10px] font-bold text-surface-400 uppercase tracking-wide mb-1">
                          Previous
                        </div>
                        <div className="px-3 py-2 bg-red-50 border border-red-100 rounded text-red-900">
                          <MarkdownPreview text={h.old_message} />
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-[10px] font-bold text-surface-400 uppercase tracking-wide mb-1">
                        {h.old_message && h.old_message.trim() ? 'Changed to' : 'New message'}
                      </div>
                      <div
                        className={`px-3 py-2 border rounded ${
                          h.new_message && h.new_message.trim()
                            ? 'bg-emerald-50 border-emerald-100 text-emerald-900'
                            : 'bg-surface-50 border-surface-200 text-surface-500 italic text-xs'
                        }`}
                      >
                        {h.new_message && h.new_message.trim() ? (
                          <MarkdownPreview text={h.new_message} />
                        ) : (
                          <span>(message cleared)</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-surface-200 bg-surface-50 text-xs text-surface-500 text-center">
          History is automatically pruned to the most recent 100 entries per scope.
          Older entries are removed by the database.
        </div>
      </div>
    </div>
  )
}
