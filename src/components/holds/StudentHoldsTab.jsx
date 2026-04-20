import { useState, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  useAllHolds,
  useHoldActions,
  HOLD_TEMPLATES,
  SEVERITY_META,
} from '@/hooks/useStudentHolds'
import {
  Plus, X, Search, Loader2, Trash2, ChevronDown, ChevronUp,
  ShieldAlert, AlertTriangle, Info, Calendar, ShieldCheck,
  Eye, CheckCircle2, Clock, Zap,
} from 'lucide-react'

// ════════════════════════════════════════════════════════════════════════════
// StudentHoldsTab — instructor-facing management UI for student holds
// ────────────────────────────────────────────────────────────────────────────
// Mounted by AnnouncementsPage when the user has the 'manage_holds' permission.
// Contents:
//   - "New Hold" button → reveals CreateHoldForm inline
//   - CreateHoldForm: severity picker + template library + title/message +
//     optional auto-expire + multi-student target picker
//   - ActiveHoldsPanel: list of every active hold with:
//       * Per-target status (acknowledged / unread / cleared)
//       * View counts + last viewed
//       * Per-target remote clear (any instructor)
//       * Super Admin force clear (with purple badge)
//       * Whole-hold delete (cascade removes all targets)
// ════════════════════════════════════════════════════════════════════════════

export default function StudentHoldsTab() {
  const [showForm, setShowForm] = useState(false)

  return (
    <div className="space-y-3">
      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 flex items-center gap-1.5 shadow-sm"
        >
          <Plus size={14} /> New Hold
        </button>
      )}

      {showForm && (
        <CreateHoldForm
          onCancel={() => setShowForm(false)}
          onSuccess={() => setShowForm(false)}
        />
      )}

      <ActiveHoldsPanel />
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════════
// CreateHoldForm — inline form for creating a new hold
// ════════════════════════════════════════════════════════════════════════════

function CreateHoldForm({ onCancel, onSuccess }) {
  const { createHold, saving } = useHoldActions()

  // Form state
  const [severity, setSeverity] = useState('reminder')
  const [templateId, setTemplateId] = useState('custom')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [expiresDate, setExpiresDate] = useState('')
  const [selectedEmails, setSelectedEmails] = useState({})

  // User list
  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [search, setSearch] = useState('')

  // Load eligible users (Students + Work Study, Active, not TCO)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoadingUsers(true)
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('email, first_name, last_name, role, status, time_clock_only')
          .order('first_name')
        if (cancelled) return
        if (error) throw error
        const eligible = (data || []).filter(u =>
          u.status === 'Active' &&
          u.time_clock_only !== 'Yes' &&
          (u.role === 'Student' || u.role === 'Work Study')
        )
        setUsers(eligible)
      } catch (err) {
        console.error('Failed to load users:', err)
      } finally {
        if (!cancelled) setLoadingUsers(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const filteredUsers = useMemo(() => {
    if (!search) return users
    const s = search.toLowerCase()
    return users.filter(u =>
      `${u.first_name} ${u.last_name}`.toLowerCase().includes(s) ||
      u.email?.toLowerCase().includes(s)
    )
  }, [users, search])

  const selectedCount = Object.keys(selectedEmails).length

  const applyTemplate = (id) => {
    const tmpl = HOLD_TEMPLATES.find(t => t.id === id)
    if (!tmpl) return
    setTemplateId(id)
    if (id !== 'custom') {
      setTitle(tmpl.title)
      setMessage(tmpl.message)
    }
  }

  const toggleEmail = (email) => {
    setSelectedEmails(prev => {
      const next = { ...prev }
      if (next[email]) delete next[email]
      else next[email] = true
      return next
    })
  }

  const selectByRole = (role) => {
    const picks = { ...selectedEmails }
    users.filter(u => u.role === role).forEach(u => { picks[u.email] = true })
    setSelectedEmails(picks)
  }

  const clearSelection = () => setSelectedEmails({})

  const resetForm = () => {
    setSeverity('reminder')
    setTemplateId('custom')
    setTitle('')
    setMessage('')
    setExpiresDate('')
    setSelectedEmails({})
    setSearch('')
  }

  const handleSubmit = async () => {
    const targets = Object.keys(selectedEmails).map(email => {
      const u = users.find(x => x.email === email)
      return {
        email,
        name: u ? `${u.first_name} ${u.last_name}`.trim() : email,
      }
    })

    const holdId = await createHold({
      title,
      message,
      severity,
      templateType: templateId,
      expiresAt: expiresDate || null,
      targets,
    })

    if (holdId) {
      resetForm()
      onSuccess?.(holdId)
    }
  }

  const canSubmit =
    !saving &&
    selectedCount > 0 &&
    title.trim().length > 0 &&
    message.trim().length > 0

  return (
    <div className="bg-white rounded-xl border border-brand-200 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-surface-900 flex items-center gap-2">
          <ShieldAlert size={16} className="text-brand-600" /> New Student Hold
        </h3>
        {onCancel && (
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400"
            aria-label="Close form"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Severity picker */}
      <SeverityPicker value={severity} onChange={setSeverity} />

      {/* Template */}
      <div>
        <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1.5 block">
          Template
        </label>
        <div className="flex flex-wrap gap-1.5">
          {HOLD_TEMPLATES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t.id)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                templateId === t.id
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <div>
        <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
          Title *
        </label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Short headline the student will see"
          className="input text-sm"
          maxLength={200}
        />
      </div>

      {/* Message */}
      <div>
        <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
          Message *
        </label>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Full body text the student will read"
          rows={4}
          className="input text-sm resize-y min-h-[88px]"
        />
      </div>

      {/* Expiry */}
      <div>
        <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block flex items-center gap-1">
          <Calendar size={11} /> Auto-Expire (Optional)
        </label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={expiresDate}
            onChange={e => setExpiresDate(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="input text-sm w-48"
          />
          {expiresDate && (
            <button
              type="button"
              onClick={() => setExpiresDate('')}
              className="text-xs text-surface-500 hover:text-surface-700"
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-[11px] text-surface-400 mt-1">
          Leave blank for no auto-expiry. Instructors can always clear manually.
        </p>
      </div>

      {/* Target picker */}
      <div>
        <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1.5 block">
          Target Students{' '}
          <span className="text-surface-400 normal-case">
            ({selectedCount} selected)
          </span>
        </label>

        {/* Quick-select buttons */}
        <div className="flex flex-wrap gap-1.5 mb-2">
          <button
            type="button"
            onClick={() => selectByRole('Student')}
            className="px-2 py-0.5 rounded bg-blue-50 text-[10px] font-medium text-blue-700 hover:bg-blue-100"
          >
            + All Students
          </button>
          <button
            type="button"
            onClick={() => selectByRole('Work Study')}
            className="px-2 py-0.5 rounded bg-emerald-50 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100"
          >
            + All Work Study
          </button>
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={clearSelection}
              className="px-2 py-0.5 rounded bg-red-50 text-[10px] font-medium text-red-600 hover:bg-red-100"
            >
              Clear All
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search students..."
            className="input pl-8 text-xs py-1.5"
          />
        </div>

        {/* User list */}
        <div className="border border-surface-200 rounded-xl max-h-64 overflow-y-auto divide-y divide-surface-100">
          {loadingUsers ? (
            <div className="text-center py-6">
              <Loader2 size={16} className="mx-auto mb-1 text-brand-400 animate-spin" />
              <p className="text-xs text-surface-400">Loading students…</p>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="text-center py-6 text-xs text-surface-400">
              {search ? 'No matching students' : 'No eligible students found'}
            </div>
          ) : (
            filteredUsers.map(u => {
              const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email
              const isChecked = !!selectedEmails[u.email]
              return (
                <label
                  key={u.email}
                  className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-surface-50 transition-colors ${
                    isChecked ? 'bg-brand-50/40' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleEmail(u.email)}
                    className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-surface-800">{name}</span>
                    <span className="text-[10px] text-surface-400 ml-2">{u.email}</span>
                  </div>
                  <span
                    className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                      u.role === 'Work Study'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {u.role}
                  </span>
                </label>
              )
            })
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-surface-100">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-surface-100 text-xs font-medium text-surface-600 hover:bg-surface-200 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-4 py-2 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Creating…
            </>
          ) : (
            <>
              Create Hold for {selectedCount} Student
              {selectedCount !== 1 ? 's' : ''}
            </>
          )}
        </button>
      </div>
    </div>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// SeverityPicker — three-option segmented radio group
// ────────────────────────────────────────────────────────────────────────────

function SeverityPicker({ value, onChange }) {
  const tiers = [
    { id: 'nudge', Icon: Info, ...SEVERITY_META.nudge },
    { id: 'reminder', Icon: AlertTriangle, ...SEVERITY_META.reminder },
    { id: 'hold', Icon: ShieldAlert, ...SEVERITY_META.hold },
  ]

  const currentMeta = SEVERITY_META[value]

  return (
    <div>
      <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1.5 block">
        Severity *
      </label>
      <div
        className="grid grid-cols-3 gap-2"
        role="radiogroup"
        aria-label="Hold severity"
      >
        {tiers.map(t => {
          const selected = value === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              role="radio"
              aria-checked={selected}
              className="p-3 rounded-lg border-2 text-xs font-semibold transition-all flex flex-col items-center gap-1"
              style={{
                background: selected ? t.bgColor : 'white',
                borderColor: selected ? t.color : '#e2e8f0',
                color: selected ? t.color : '#64748b',
              }}
            >
              <t.Icon size={18} aria-hidden="true" />
              {t.label}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] text-surface-500 mt-1.5 italic">
        {currentMeta.description}
      </p>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════════
// ActiveHoldsPanel — list of every active hold with per-target controls
// ════════════════════════════════════════════════════════════════════════════

function ActiveHoldsPanel() {
  const { holds, loading } = useAllHolds({ includeClosed: false })
  const {
    clearTargetRemote,
    forceClearTarget,
    deleteHold,
    saving,
  } = useHoldActions()
  const { isSuperAdmin } = useAuth()

  const [expandedId, setExpandedId] = useState(null)
  const [search, setSearch] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)

  const filtered = useMemo(() => {
    if (!search) return holds
    const s = search.toLowerCase()
    return holds.filter(h =>
      h.title?.toLowerCase().includes(s) ||
      h.message?.toLowerCase().includes(s) ||
      h.created_by_name?.toLowerCase().includes(s) ||
      (h.targets || []).some(t =>
        t.user_name?.toLowerCase().includes(s) ||
        t.user_email?.toLowerCase().includes(s)
      )
    )
  }, [holds, search])

  const totalTargets = holds.reduce((s, h) => s + (h.targets?.length || 0), 0)
  const activeTargets = holds.reduce(
    (s, h) => s + (h.targets?.filter(t => !t.cleared_at).length || 0),
    0
  )

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading holds…</p>
      </div>
    )
  }

  return (
    <>
      {/* Stats */}
      {holds.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mt-3">
          <StatCard label="Active Holds" value={holds.length} color="text-surface-900" />
          <StatCard label="Students Affected" value={activeTargets} color="text-amber-600" />
          <StatCard label="Total Targets" value={totalTargets} color="text-surface-500" />
        </div>
      )}

      {/* Search */}
      {holds.length > 0 && (
        <div className="relative mt-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by title, student, or creator…"
            className="input pl-9 text-sm w-full"
          />
        </div>
      )}

      {/* Empty state */}
      {holds.length === 0 ? (
        <div className="text-center py-12 mt-3">
          <ShieldCheck size={36} className="mx-auto mb-2 text-emerald-300" />
          <p className="text-sm text-surface-500">No active holds</p>
          <p className="text-xs text-surface-400 mt-1">
            When you create one, it will appear here with per-student status.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10 mt-3">
          <Search size={24} className="mx-auto mb-2 text-surface-300" />
          <p className="text-sm text-surface-500">No matching holds</p>
        </div>
      ) : (
        <div className="space-y-3 mt-3">
          {filtered.map(hold => (
            <HoldCard
              key={hold.hold_id}
              hold={hold}
              expanded={expandedId === hold.hold_id}
              onToggleExpand={() =>
                setExpandedId(expandedId === hold.hold_id ? null : hold.hold_id)
              }
              onClearTarget={clearTargetRemote}
              onForceClear={forceClearTarget}
              onRequestDelete={() => setConfirmDelete(hold)}
              saving={saving}
              isSuperAdmin={isSuperAdmin}
            />
          ))}
        </div>
      )}

      {/* Confirm delete modal */}
      {confirmDelete && (
        <ConfirmDeleteModal
          hold={confirmDelete}
          onConfirm={async () => {
            const ok = await deleteHold(confirmDelete.hold_id, confirmDelete.title)
            if (ok) setConfirmDelete(null)
          }}
          onCancel={() => setConfirmDelete(null)}
          saving={saving}
        />
      )}
    </>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// HoldCard — a single collapsible hold with targets, actions
// ────────────────────────────────────────────────────────────────────────────

function HoldCard({
  hold,
  expanded,
  onToggleExpand,
  onClearTarget,
  onForceClear,
  onRequestDelete,
  saving,
  isSuperAdmin,
}) {
  const targets = hold.targets || []
  const active = targets.filter(t => !t.cleared_at)
  const meta = SEVERITY_META[hold.severity] || SEVERITY_META.reminder

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
      {/* Header — click to expand/collapse */}
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-50 transition-colors"
        aria-expanded={expanded}
      >
        <SeverityBadge severity={hold.severity} />

        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-surface-900 truncate">
            {hold.title}
          </div>
          <div className="text-[11px] text-surface-400 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{hold.created_by_name}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(hold.created_at)}</span>
            {hold.expires_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  <Clock size={9} className="inline mr-0.5" aria-hidden="true" />
                  Expires {formatDate(hold.expires_at)}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Active count */}
        <div className="text-right flex-shrink-0">
          <div className="text-xs font-semibold text-surface-700">
            {active.length} / {targets.length}
          </div>
          <div className="text-[10px] text-surface-400">active</div>
        </div>

        {expanded ? (
          <ChevronUp size={14} className="text-surface-400 flex-shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown size={14} className="text-surface-400 flex-shrink-0" aria-hidden="true" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-surface-100">
          {/* Message */}
          <div className="px-4 py-3 bg-surface-50 border-b border-surface-100">
            <div
              className="text-xs text-surface-700 whitespace-pre-wrap leading-relaxed"
              style={{ maxHeight: 240, overflowY: 'auto' }}
            >
              {hold.message}
            </div>
          </div>

          {/* Targets list */}
          <div className="px-4 py-3 space-y-2">
            <div className="text-[11px] font-semibold text-surface-500 uppercase tracking-wide">
              Targets ({targets.length})
            </div>
            {targets.length === 0 ? (
              <div className="text-xs text-surface-400 italic">
                No targets (this shouldn't happen — contact admin)
              </div>
            ) : (
              targets.map(target => (
                <TargetRow
                  key={target.target_id}
                  target={target}
                  onClear={() => onClearTarget(target.target_id)}
                  onForceClear={
                    isSuperAdmin ? () => onForceClear(target.target_id) : null
                  }
                  saving={saving}
                />
              ))
            )}
          </div>

          {/* Footer actions */}
          <div className="px-4 py-2.5 bg-surface-50 border-t border-surface-100 flex flex-wrap items-center gap-2">
            <div className="flex-1" />
            <button
              type="button"
              onClick={onRequestDelete}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 disabled:opacity-50 flex items-center gap-1"
            >
              <Trash2 size={11} /> Delete Hold
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// TargetRow — one student's state within a hold
// ────────────────────────────────────────────────────────────────────────────

function TargetRow({ target, onClear, onForceClear, saving }) {
  const isCleared = !!target.cleared_at
  const isAcked = !!target.acknowledged_at
  const views = target.view_count || 0

  return (
    <div
      className={`flex items-start gap-3 px-3 py-2 rounded-lg border ${
        isCleared
          ? 'bg-surface-50 border-surface-100'
          : 'bg-white border-surface-200'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div
          className={`text-xs font-medium ${
            isCleared ? 'text-surface-500' : 'text-surface-900'
          }`}
        >
          {target.user_name}
        </div>
        <div className="text-[10px] text-surface-400">{target.user_email}</div>
        <div className="text-[10px] mt-1 flex items-center gap-2 flex-wrap">
          {isCleared ? (
            <span className="flex items-center gap-1 text-emerald-600 font-medium">
              <CheckCircle2 size={10} aria-hidden="true" />
              Cleared via {formatMethod(target.cleared_method)}
              {target.cleared_by_name && (
                <span className="text-surface-400 font-normal">
                  {' '}· by {target.cleared_by_name}
                </span>
              )}
              {target.cleared_at && (
                <span className="text-surface-400 font-normal">
                  {' '}· {formatDate(target.cleared_at)}
                </span>
              )}
            </span>
          ) : (
            <>
              <span
                className={`flex items-center gap-0.5 font-medium ${
                  isAcked ? 'text-emerald-600' : 'text-amber-600'
                }`}
              >
                {isAcked ? '✓ Read' : '● Unread'}
              </span>
              <span className="text-surface-400 flex items-center gap-0.5">
                <Eye size={9} aria-hidden="true" />
                {views} view{views !== 1 ? 's' : ''}
              </span>
              {target.last_viewed_at && (
                <span className="text-surface-400">
                  · last seen {formatRelative(target.last_viewed_at)}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {!isCleared && (
        <div className="flex gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onClear}
            disabled={saving}
            className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium hover:bg-emerald-100 disabled:opacity-50"
            title="Clear this student's hold remotely"
          >
            Clear
          </button>
          {onForceClear && (
            <button
              type="button"
              onClick={onForceClear}
              disabled={saving}
              className="px-2 py-1 rounded bg-purple-50 text-purple-700 text-[10px] font-medium hover:bg-purple-100 disabled:opacity-50 flex items-center gap-0.5"
              title="Super Admin force clear"
            >
              <Zap size={9} aria-hidden="true" /> Force
            </button>
          )}
        </div>
      )}
    </div>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// SeverityBadge — small colored pill for a severity value
// ────────────────────────────────────────────────────────────────────────────

function SeverityBadge({ severity }) {
  const meta = SEVERITY_META[severity] || SEVERITY_META.reminder
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider flex-shrink-0"
      style={{
        background: meta.bgColor,
        color: meta.color,
        border: `1px solid ${meta.borderColor}`,
      }}
    >
      {meta.label}
    </span>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// StatCard — small stat tile for the top of the panel
// ────────────────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-xl border border-surface-200 p-3 text-center">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-surface-500 uppercase tracking-wide">
        {label}
      </div>
    </div>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// ConfirmDeleteModal — confirm before deleting a hold
// ────────────────────────────────────────────────────────────────────────────

function ConfirmDeleteModal({ hold, onConfirm, onCancel, saving }) {
  const targetCount = hold.targets?.length || 0

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={e => e.target === e.currentTarget && onCancel()}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
              <Trash2 size={18} className="text-red-600" />
            </div>
            <h3 className="text-base font-semibold text-surface-900">
              Delete this hold?
            </h3>
          </div>
          <p className="text-sm text-surface-600 leading-relaxed mb-3">
            <strong className="text-surface-900">"{hold.title}"</strong> will be
            permanently removed for all {targetCount} student
            {targetCount !== 1 ? 's' : ''}.
          </p>
          <p className="text-xs text-surface-500">
            If any target was still active, the student will no longer see this
            hold on their next refresh. This action cannot be undone.
          </p>
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-surface-600 bg-surface-100 hover:bg-surface-200 rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Deleting…
              </>
            ) : (
              <>Delete Hold</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function formatDate(dateStr) {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatRelative(dateStr) {
  if (!dateStr) return ''
  try {
    const then = new Date(dateStr).getTime()
    const now = Date.now()
    const diffSec = Math.round((now - then) / 1000)
    if (diffSec < 60) return 'just now'
    if (diffSec < 3600) {
      const m = Math.round(diffSec / 60)
      return `${m}m ago`
    }
    if (diffSec < 86400) {
      const h = Math.round(diffSec / 3600)
      return `${h}h ago`
    }
    const d = Math.round(diffSec / 86400)
    if (d < 7) return `${d}d ago`
    return formatDate(dateStr)
  } catch {
    return ''
  }
}

function formatMethod(method) {
  if (!method) return 'cleared'
  return {
    badge_swipe: 'badge swipe',
    remote: 'remote clear',
    auto_expiry: 'auto-expiry',
    super_admin_override: 'Super Admin force clear',
  }[method] || method
}
