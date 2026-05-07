/**
 * RICT CMMS - Bug Tracker Page (React/Supabase)
 *
 * Features:
 * - Search + type/status/priority filters
 * - Stat cards: Pending, Open Bugs, Feature Requests, In Progress, Completed
 * - Data table with type/priority/status badges
 * - New Request modal (non-admin submits as Pending)
 * - View detail modal with metadata grid
 * - Edit modal (permission gated via DB permissions)
 * - Approve/Reject workflow for Pending items (super admin only)
 * - Delete with confirmation (permission gated)
 * - Changelog section grouped by version with clickable detail modals
 * - Manual changelog entries (super admin only) — for changes made
 *   without a corresponding bug or feature request
 * - Closed items hidden from main table (shown in changelog)
 * - Full permission gating via hasPerm() from permissions table
 * - Auto-close: Completed items are automatically closed after 15 days,
 *   creating a changelog entry and bumping the version number
 * - Version bumping: Bug → patch (2.1.8 → 2.1.9), Feature → minor (2.1.8 → 2.2.0)
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useBugRequests, useBugActions, useChangelog, useBugRequestLookup, useAutoClose } from '@/hooks/useBugTracker'
import {
  Search, Plus, Bug, Lightbulb, Clock, CheckCircle2, Loader2,
  Eye, Edit3, Trash2, CheckCircle, XCircle, History, AlertCircle,
  HelpCircle, X, Hourglass, ExternalLink, FileText, ChevronDown, ChevronRight
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const TYPES = ['Bug', 'Feature Request']
const PRIORITIES = ['Low', 'Medium', 'High']
const STATUSES_FILTER = ['Pending', 'Open', 'In Progress', 'Completed', 'Rejected']
const STATUSES_FORM = ['Open', 'In Progress', 'Completed', 'Closed']

const TYPE_STYLES = {
  Bug: 'bg-red-50 text-red-700 border border-red-200',
  'Feature Request': 'bg-amber-50 text-amber-700 border border-amber-200',
}
const PRIORITY_STYLES = {
  High: 'bg-red-100 text-red-800 font-semibold',
  Medium: 'bg-amber-100 text-amber-800',
  Low: 'bg-emerald-100 text-emerald-800',
}
const STATUS_STYLES = {
  Pending: 'bg-yellow-100 text-yellow-800',
  Open: 'bg-blue-100 text-blue-800',
  'In Progress': 'bg-violet-100 text-violet-800',
  Completed: 'bg-green-100 text-green-800',
  Closed: 'bg-gray-100 text-gray-600',
  Rejected: 'bg-red-100 text-red-700',
}

function Badge({ text, styleMap }) {
  const cls = styleMap?.[text] || 'bg-surface-100 text-surface-600'
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${cls}`}>
      {text}
    </span>
  )
}

function formatDate(val) {
  if (!val) return '—'
  try { return new Date(val).toLocaleDateString() } catch { return '—' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function BugTrackerPage() {
  const { profile } = useAuth()
  const { requests, loading, refresh } = useBugRequests()
  const actions = useBugActions()
  const { entries: changelogEntries, loading: changelogLoading, refresh: refreshChangelog } = useChangelog()
  const { lookupRequest, lookupLoading } = useBugRequestLookup()
  const { runAutoClose, processing: autoCloseProcessing } = useAutoClose()

  // ── Auto-close check on mount ──
  // Runs once per page load to find Completed items older than 15 days
  // and automatically close them (creating changelog entries + version bumps)
  useEffect(() => {
    const checkAutoClose = async () => {
      const result = await runAutoClose()
      if (result.closed > 0) {
        // Refresh both requests and changelog since items were auto-closed
        refresh()
        refreshChangelog()
      }
    }
    // Wait for requests to load before running auto-close
    if (!loading && requests.length > 0) {
      checkAutoClose()
    }
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Filters
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')

  // Modals
  const [showAddModal, setShowAddModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showViewModal, setShowViewModal] = useState(false)
  const [showConfirm, setShowConfirm] = useState(null)
  const [currentItem, setCurrentItem] = useState(null)

  // Changelog detail modal
  const [showChangelogDetail, setShowChangelogDetail] = useState(false)
  const [changelogDetailItem, setChangelogDetailItem] = useState(null)
  const [changelogBugData, setChangelogBugData] = useState(null)

  // Add-changelog-entry modal (super admin only)
  const [showAddChangelogModal, setShowAddChangelogModal] = useState(false)

  // Active requests = exclude Closed (those appear in changelog)
  const activeRequests = useMemo(() =>
    requests.filter(r => r.status !== 'Closed'), [requests]
  )

  // Filtered list
  const filtered = useMemo(() => {
    return activeRequests.filter(r => {
      const s = search.toLowerCase()
      const matchSearch = !s ||
        (r.title || '').toLowerCase().includes(s) ||
        (r.description || '').toLowerCase().includes(s) ||
        (r.request_id || '').toLowerCase().includes(s)
      const matchType = !typeFilter || r.type === typeFilter
      const matchStatus = !statusFilter || r.status === statusFilter
      const matchPriority = !priorityFilter || r.priority === priorityFilter
      return matchSearch && matchType && matchStatus && matchPriority
    })
  }, [activeRequests, search, typeFilter, statusFilter, priorityFilter])

  // Stats
  const stats = useMemo(() => {
    const d = activeRequests
    return {
      pending: d.filter(r => r.status === 'Pending').length,
      openBugs: d.filter(r => r.type === 'Bug' && (r.status === 'Open' || r.status === 'In Progress')).length,
      features: d.filter(r => r.type === 'Feature Request' && r.status !== 'Completed' && r.status !== 'Rejected').length,
      inProgress: d.filter(r => r.status === 'In Progress').length,
      completed: d.filter(r => r.status === 'Completed').length,
    }
  }, [activeRequests])

  // Handlers
  const handleView = (item) => { setCurrentItem(item); setShowViewModal(true) }
  const handleEdit = (item) => { setCurrentItem(item); setShowEditModal(true) }
  const handleDelete = (item) => {
    setShowConfirm({
      title: 'Delete Request',
      message: `Delete "${item.title}"?`,
      okText: 'Delete',
      danger: true,
      onOk: async () => {
        await actions.deleteRequest(item.request_id)
        refresh()
        setShowConfirm(null)
      }
    })
  }
  const handleApprove = (item) => {
    setShowConfirm({
      title: 'Approve Request',
      message: `Approve "${item.title}"?`,
      okText: 'Approve',
      onOk: async () => {
        await actions.approveRequest(item.request_id)
        refresh()
        setShowConfirm(null)
      }
    })
  }
  const handleReject = (item) => {
    setShowConfirm({
      title: 'Reject Request',
      message: `Reject "${item.title}"? This will remove the request.`,
      okText: 'Reject',
      danger: true,
      prompt: true,
      promptLabel: 'Reason (optional)',
      onOk: async (reason) => {
        await actions.rejectRequest(item.request_id, reason)
        refresh()
        setShowConfirm(null)
      }
    })
  }
  const handleSaved = () => { refresh(); refreshChangelog() }

  // Changelog detail click handler
  const handleChangelogClick = async (changelogItem) => {
    setChangelogDetailItem(changelogItem)
    setChangelogBugData(null)
    setShowChangelogDetail(true)

    // Try to look up the full bug request data
    if (changelogItem.request_id) {
      const bugData = await lookupRequest(changelogItem.request_id)
      setChangelogBugData(bugData)
    }
  }

  // Permission shorthand
  const canSubmit = actions.hasPerm('submit_bugs')
  const canUpdateStatus = actions.hasPerm('update_status')
  const canMarkComplete = actions.hasPerm('mark_complete')
  const canDelete = actions.hasPerm('delete_bugs')
  // Approve/Reject is always super admin only (it's the initial approval gate)
  const canApprove = actions.isSuperAdmin

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-5">

      {/* ─── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="flex items-center bg-white border border-surface-200 rounded-lg px-3 py-2 gap-2 w-full sm:w-auto">
            <Search size={15} className="text-surface-400 shrink-0" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search requests…"
              className="bg-transparent outline-none text-sm text-surface-700 placeholder:text-surface-400 w-full sm:w-48"
            />
          </div>
          {/* Filters */}
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="text-xs border border-surface-200 rounded-lg px-3 py-2 bg-white text-surface-700">
            <option value="">All Types</option>
            {TYPES.map(t => <option key={t} value={t}>{t}s</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="text-xs border border-surface-200 rounded-lg px-3 py-2 bg-white text-surface-700">
            <option value="">All Statuses</option>
            {STATUSES_FILTER.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}
            className="text-xs border border-surface-200 rounded-lg px-3 py-2 bg-white text-surface-700">
            <option value="">All Priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        {canSubmit && (
          <button onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors shrink-0">
            <Plus size={15} /> New Request
          </button>
        )}
      </div>

      {/* ─── Stat Cards ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard icon={<Hourglass size={20} />} label="Pending Approval" value={stats.pending}
          gradient="from-yellow-400 to-amber-500" />
        <StatCard icon={<Bug size={20} />} label="Open Bugs" value={stats.openBugs}
          gradient="from-red-500 to-red-600" />
        <StatCard icon={<Lightbulb size={20} />} label="Feature Requests" value={stats.features}
          gradient="from-amber-400 to-yellow-500" />
        <StatCard icon={<Clock size={20} />} label="In Progress" value={stats.inProgress}
          gradient="from-blue-500 to-blue-600" />
        <StatCard icon={<CheckCircle2 size={20} />} label="Completed" value={stats.completed}
          gradient="from-emerald-500 to-green-600" />
      </div>

      {/* ─── Requests Table ────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-900">Bug & Feature Requests</h3>
          <span className="bg-brand-600 text-white text-[11px] font-semibold px-2.5 py-0.5 rounded-full">
            {filtered.length}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-surface-400 gap-2 text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading requests…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-surface-400 text-sm">
            {activeRequests.length === 0 ? 'No requests found' : 'No matching requests'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 text-left">
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500 w-24">ID</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Type</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Title</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Priority</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Status</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Submitted By</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Date</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-surface-500 w-28">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {filtered.map(item => (
                  <tr key={item.request_id} className="hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-2.5 font-semibold text-surface-900 text-xs">{item.request_id}</td>
                    <td className="px-4 py-2.5"><Badge text={item.type} styleMap={TYPE_STYLES} /></td>
                    <td className="px-4 py-2.5 text-surface-700 max-w-xs truncate">{item.title}</td>
                    <td className="px-4 py-2.5"><Badge text={item.priority} styleMap={PRIORITY_STYLES} /></td>
                    <td className="px-4 py-2.5"><Badge text={item.status} styleMap={STATUS_STYLES} /></td>
                    <td className="px-4 py-2.5 text-surface-600 text-xs">{item.submitted_by || '—'}</td>
                    <td className="px-4 py-2.5 text-surface-500 text-xs">{formatDate(item.submitted_date)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-0.5">
                        <ActionBtn icon={<Eye size={14} />} tip="View" onClick={() => handleView(item)} />
                        {/* Approve/Reject: super admin only, pending items */}
                        {canApprove && item.status === 'Pending' && (
                          <>
                            <ActionBtn icon={<CheckCircle size={14} />} tip="Approve"
                              className="text-green-500 hover:bg-green-50" onClick={() => handleApprove(item)} />
                            <ActionBtn icon={<XCircle size={14} />} tip="Reject"
                              className="text-red-400 hover:bg-red-50" onClick={() => handleReject(item)} />
                          </>
                        )}
                        {/* Edit: requires update_status permission, non-pending */}
                        {canUpdateStatus && item.status !== 'Pending' && (
                          <ActionBtn icon={<Edit3 size={14} />} tip="Edit" onClick={() => handleEdit(item)} />
                        )}
                        {/* Delete: requires delete_bugs permission, non-pending */}
                        {canDelete && item.status !== 'Pending' && (
                          <ActionBtn icon={<Trash2 size={14} />} tip="Delete"
                            className="text-red-400 hover:bg-red-50" onClick={() => handleDelete(item)} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Changelog Section ─────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-100 flex items-center gap-2">
          <History size={16} className="text-brand-600" />
          <h3 className="text-sm font-semibold text-surface-900">Changelog</h3>
          <div className="ml-auto flex items-center gap-2">
            {changelogEntries.length > 0 && (
              <span className="bg-surface-100 text-surface-600 text-[11px] font-semibold px-2 py-0.5 rounded-full">
                {changelogEntries.length} entries
              </span>
            )}
            {actions.isSuperAdmin && (
              <button
                onClick={() => setShowAddChangelogModal(true)}
                aria-label="Add manual changelog entry"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 text-white text-xs font-medium rounded-lg transition-colors"
              >
                <Plus size={13} aria-hidden="true" /> Add Entry
              </button>
            )}
          </div>
        </div>
        {changelogLoading ? (
          <div className="flex items-center justify-center py-12 text-surface-400 gap-2 text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading changelog…
          </div>
        ) : changelogEntries.length === 0 ? (
          <div className="text-center py-12 text-surface-400 text-sm">
            No changelog entries yet. Entries are added when requests are closed.
          </div>
        ) : (
          <ChangelogTable entries={changelogEntries} onItemClick={handleChangelogClick} />
        )}
      </div>

      {/* ─── Modals ────────────────────────────────────────────────────── */}
      {showAddModal && (
        <AddEditModal
          onClose={() => setShowAddModal(false)}
          onSaved={handleSaved}
          actions={actions}
          canUpdateStatus={canUpdateStatus}
          canMarkComplete={canMarkComplete}
        />
      )}
      {showEditModal && currentItem && (
        <AddEditModal
          item={currentItem}
          onClose={() => { setShowEditModal(false); setCurrentItem(null) }}
          onSaved={handleSaved}
          actions={actions}
          canUpdateStatus={canUpdateStatus}
          canMarkComplete={canMarkComplete}
        />
      )}
      {showViewModal && currentItem && (
        <ViewModal
          item={currentItem}
          onClose={() => { setShowViewModal(false); setCurrentItem(null) }}
          onEdit={canUpdateStatus ? () => { setShowViewModal(false); setShowEditModal(true) } : null}
        />
      )}
      {showConfirm && (
        <ConfirmModal
          {...showConfirm}
          onCancel={() => setShowConfirm(null)}
        />
      )}
      {showChangelogDetail && changelogDetailItem && (
        <ChangelogDetailModal
          changelogItem={changelogDetailItem}
          bugData={changelogBugData}
          loading={lookupLoading}
          onClose={() => { setShowChangelogDetail(false); setChangelogDetailItem(null); setChangelogBugData(null) }}
        />
      )}
      {showAddChangelogModal && (
        <AddChangelogModal
          onClose={() => setShowAddChangelogModal(false)}
          onSaved={() => { refreshChangelog() }}
          actions={actions}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAT CARD
// ═══════════════════════════════════════════════════════════════════════════════

function StatCard({ icon, label, value, gradient }) {
  return (
    <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center text-white shrink-0`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-surface-900">{value}</div>
        <div className="text-[11px] text-surface-500 leading-tight">{label}</div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION BUTTON
// ═══════════════════════════════════════════════════════════════════════════════

function ActionBtn({ icon, tip, onClick, className = '' }) {
  return (
    <button
      onClick={onClick}
      title={tip}
      className={`p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 hover:text-brand-600 transition-colors ${className}`}
    >
      {icon}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGELOG TABLE (grouped by version, clickable rows)
// ═══════════════════════════════════════════════════════════════════════════════

function ChangelogTable({ entries, onItemClick }) {
  // Group by version
  const grouped = useMemo(() => {
    const map = {}
    entries.forEach(e => {
      const v = e.version || 'unknown'
      if (!map[v]) map[v] = []
      map[v].push(e)
    })
    // Sort versions descending
    const versions = Object.keys(map).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true })
    )
    // Within each version, sort by release_date descending (newest first).
    // Falls back to title for stable ordering when release_dates collide
    // (release_date is stored as DATE, so multiple same-day entries tie).
    return versions.map(v => ({
      version: v,
      items: [...map[v]].sort((a, b) => {
        const da = a.release_date || ''
        const db = b.release_date || ''
        if (da !== db) return db.localeCompare(da)
        return (a.title || '').localeCompare(b.title || '')
      })
    }))
  }, [entries])

  // Track collapsed version groups
  const [collapsed, setCollapsed] = useState({})
  const toggleCollapse = (version) => {
    setCollapsed(prev => ({ ...prev, [version]: !prev[version] }))
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-50 text-left">
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500 w-28">Version</th>
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Release Date</th>
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Request ID</th>
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Type</th>
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Description</th>
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500">Released By</th>
            <th className="px-4 py-2.5 text-xs font-semibold text-surface-500 w-16"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-100">
          {grouped.map(group => {
            const isCollapsed = collapsed[group.version]
            return (
              <React.Fragment key={group.version}>
                {/* Version header row */}
                <tr
                  className="bg-surface-25 hover:bg-surface-50 cursor-pointer transition-colors"
                  onClick={() => toggleCollapse(group.version)}
                >
                  <td className="px-4 py-2.5 font-bold text-brand-600 text-base">
                    <div className="flex items-center gap-1.5">
                      {isCollapsed
                        ? <ChevronRight size={14} className="text-surface-400" />
                        : <ChevronDown size={14} className="text-surface-400" />
                      }
                      v{group.version}
                    </div>
                  </td>
                  <td colSpan={6} className="px-4 py-2.5 text-surface-500 text-xs">
                    {group.items.length} {group.items.length === 1 ? 'change' : 'changes'}
                  </td>
                </tr>
                {/* Item rows */}
                {!isCollapsed && group.items.map((item, idx) => (
                  <tr
                    key={`${group.version}-${idx}`}
                    className="hover:bg-blue-50/50 cursor-pointer transition-colors group"
                    onClick={() => onItemClick(item)}
                  >
                    <td className="px-4 py-2.5"></td>
                    <td className="px-4 py-2.5 text-surface-600 text-xs">{formatDate(item.release_date)}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {item.request_id ? (
                        <span className="text-brand-600 font-medium group-hover:underline">
                          {item.request_id}
                        </span>
                      ) : (
                        <span
                          className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 border border-purple-200"
                          title="Manual changelog entry (no linked request)"
                        >
                          Manual
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5"><Badge text={item.type} styleMap={TYPE_STYLES} /></td>
                    <td className="px-4 py-2.5 text-surface-700">{item.title}</td>
                    <td className="px-4 py-2.5 text-surface-500 text-xs">{item.released_by}</td>
                    <td className="px-4 py-2.5 text-surface-300 group-hover:text-brand-500">
                      <ExternalLink size={13} aria-hidden="true" />
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGELOG DETAIL MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function ChangelogDetailModal({ changelogItem, bugData, loading, onClose }) {
  const isManual = !changelogItem.request_id

  return (
    <ModalOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-detail-title"
        className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center text-white shrink-0">
              <FileText size={16} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 id="changelog-detail-title" className="font-semibold text-surface-900 truncate">
                {isManual
                  ? changelogItem.title
                  : `${changelogItem.request_id}: ${changelogItem.title}`}
              </h3>
              <div className="text-[11px] text-surface-400">
                {isManual ? 'Manual Entry' : 'Changelog Entry'} — v{changelogItem.version}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg hover:bg-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500 text-surface-400 shrink-0"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Changelog Info */}
          <div>
            <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-2">Release Info</h4>
            <div className="grid grid-cols-2 gap-3 p-3 bg-surface-50 rounded-lg">
              <MetaItem label="Version">
                <span className="text-sm font-bold text-brand-600">v{changelogItem.version}</span>
              </MetaItem>
              <MetaItem label="Release Date">
                <span className="text-sm text-surface-700">{formatDate(changelogItem.release_date)}</span>
              </MetaItem>
              <MetaItem label="Type"><Badge text={changelogItem.type} styleMap={TYPE_STYLES} /></MetaItem>
              <MetaItem label="Released By">
                <span className="text-sm font-medium text-surface-800">{changelogItem.released_by || '—'}</span>
              </MetaItem>
            </div>
          </div>

          {/* Bug Request Details (loaded from DB) — manual entries skip lookup */}
          {isManual ? (
            <div>
              <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-2">
                Manual Entry Details
              </h4>
              <div className="p-3 bg-purple-50 border border-purple-100 rounded-lg flex items-start gap-2 mb-3">
                <AlertCircle size={14} className="text-purple-600 shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-xs text-purple-800">
                  This entry was added directly to the changelog by the super admin
                  and is not linked to a bug or feature request.
                </p>
              </div>
              {changelogItem.description ? (
                <div>
                  <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-1">
                    Description
                  </h4>
                  <div className="p-3 bg-surface-50 rounded-lg">
                    <p className="text-sm text-surface-700 whitespace-pre-wrap">
                      {changelogItem.description}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-surface-500 italic">
                  No additional description provided.
                </p>
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-6 text-surface-400 gap-2 text-sm">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading request details…
            </div>
          ) : bugData ? (
            <div>
              <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-2">Request Details</h4>
              <div className="grid grid-cols-2 gap-3 p-3 bg-surface-50 rounded-lg">
                <MetaItem label="Request ID">
                  <span className="text-sm font-semibold text-surface-900">{bugData.request_id}</span>
                </MetaItem>
                <MetaItem label="Priority"><Badge text={bugData.priority} styleMap={PRIORITY_STYLES} /></MetaItem>
                <MetaItem label="Status"><Badge text={bugData.status} styleMap={STATUS_STYLES} /></MetaItem>
                <MetaItem label="Submitted By">
                  <span className="text-sm font-medium text-surface-800">{bugData.submitted_by || '—'}</span>
                </MetaItem>
                <MetaItem label="Submitted Date">
                  <span className="text-sm text-surface-700">{formatDate(bugData.submitted_date)}</span>
                </MetaItem>
                <MetaItem label="Resolved Date">
                  <span className="text-sm text-surface-700">{formatDate(bugData.resolved_date)}</span>
                </MetaItem>
                {bugData.updated_by && (
                  <MetaItem label="Last Updated By">
                    <span className="text-sm text-surface-700">{bugData.updated_by}</span>
                  </MetaItem>
                )}
                {bugData.updated_at && (
                  <MetaItem label="Last Updated">
                    <span className="text-sm text-surface-700">{formatDate(bugData.updated_at)}</span>
                  </MetaItem>
                )}
              </div>

              {/* Description */}
              {bugData.description && (
                <div className="mt-3">
                  <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-1">Description</h4>
                  <div className="p-3 bg-surface-50 rounded-lg">
                    <p className="text-sm text-surface-700 whitespace-pre-wrap">{bugData.description}</p>
                  </div>
                </div>
              )}

              {/* Resolution Notes */}
              {bugData.resolution_notes && (
                <div className="mt-3">
                  <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-1">Resolution Notes</h4>
                  <div className="p-3 bg-green-50 rounded-lg border border-green-100">
                    <p className="text-sm text-surface-700 whitespace-pre-wrap">{bugData.resolution_notes}</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-100 flex items-start gap-2">
              <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-800">Original request not found</p>
                <p className="text-xs text-amber-600 mt-0.5">
                  The bug request ({changelogItem.request_id}) may have been deleted or was not migrated to the new system.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">
            Close
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD / EDIT MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function AddEditModal({ item, onClose, onSaved, actions, canUpdateStatus, canMarkComplete }) {
  const isEdit = !!item
  const [form, setForm] = useState({
    type: item?.type || 'Bug',
    priority: item?.priority || 'Medium',
    title: item?.title || '',
    description: item?.description || '',
    status: item?.status || 'Open',
    resolution_notes: item?.resolution_notes || '',
    bumpVersionOnClose: true, // only used when status → Closed (super admin only)
  })

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    if (!form.title.trim()) return
    try {
      if (isEdit) {
        // Pass bumpVersion option only when status is being set to Closed.
        // When status isn't Closed, options is ignored (preserves old behavior).
        const options = form.status === 'Closed'
          ? { bumpVersion: form.bumpVersionOnClose ? 'auto' : 'none' }
          : {}
        await actions.updateRequest(item.request_id, {
          type: form.type,
          priority: form.priority,
          title: form.title.trim(),
          description: form.description.trim(),
          status: form.status,
          resolution_notes: form.resolution_notes.trim(),
        }, options)
      } else {
        await actions.createRequest({
          type: form.type,
          priority: form.priority,
          title: form.title.trim(),
          description: form.description.trim(),
        })
      }
      onSaved()
      onClose()
    } catch {}
  }

  // Build available statuses based on permissions
  const availableStatuses = useMemo(() => {
    if (actions.isSuperAdmin) return STATUSES_FORM
    const statuses = []
    if (canUpdateStatus) {
      statuses.push('Open', 'In Progress')
    }
    if (canMarkComplete) {
      statuses.push('Completed')
    }
    // Super admin only can set Closed
    if (actions.isSuperAdmin) {
      statuses.push('Closed')
    }
    // If current status isn't in the list, add it so the dropdown shows correctly
    if (item?.status && !statuses.includes(item.status)) {
      statuses.unshift(item.status)
    }
    return statuses.length > 0 ? statuses : [item?.status || 'Open']
  }, [canUpdateStatus, canMarkComplete, actions.isSuperAdmin, item?.status])

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <h3 className="font-semibold text-surface-900">{isEdit ? 'Edit Request' : 'New Request'}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Type + Priority row */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Type *">
              <select value={form.type} onChange={e => set('type', e.target.value)} className="input text-sm">
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Priority *">
              <select value={form.priority} onChange={e => set('priority', e.target.value)} className="input text-sm">
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Title *">
            <input type="text" value={form.title} onChange={e => set('title', e.target.value)}
              placeholder="Brief description of the issue or request"
              className="input text-sm" />
          </Field>

          <Field label="Description">
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={4} placeholder="Detailed description, steps to reproduce, expected behavior, etc."
              className="input text-sm resize-none" />
          </Field>

          {/* Status (only for edit, requires update_status or mark_complete permission) */}
          {isEdit && (canUpdateStatus || canMarkComplete) && (
            <Field label="Status">
              <select value={form.status} onChange={e => set('status', e.target.value)} className="input text-sm">
                {availableStatuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}

          {/* Resolution Notes (only for edit, anyone with edit access can add notes) */}
          {isEdit && (
            <Field label="Resolution Notes">
              <textarea value={form.resolution_notes} onChange={e => set('resolution_notes', e.target.value)}
                rows={3} placeholder="Notes about how the issue was resolved…"
                className="input text-sm resize-none" />
            </Field>
          )}

          {/* Bump version on close — only when status is being set to Closed.
              Only super admin can set Closed, so this implicitly gates on role. */}
          {isEdit && form.status === 'Closed' && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50">
              <input
                type="checkbox"
                id="close-bump-version"
                checked={form.bumpVersionOnClose}
                onChange={e => set('bumpVersionOnClose', e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-amber-300 text-brand-600 focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <label
                  htmlFor="close-bump-version"
                  className="block text-sm font-medium text-surface-800 cursor-pointer"
                >
                  Bump version when closing
                </label>
                <p className="text-[11px] text-surface-600 mt-0.5">
                  Uncheck for duplicates or trivial closes — the changelog
                  entry will be logged under the current version without
                  incrementing it.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">
            Cancel
          </button>
          <button onClick={handleSave} disabled={actions.saving || !form.title.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 flex items-center gap-1.5">
            {actions.saving && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save Changes' : 'Submit'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function ViewModal({ item, onClose, onEdit }) {
  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <h3 className="font-semibold text-surface-900 truncate pr-4">
            {item.request_id}: {item.title}
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400 shrink-0"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-3 p-3 bg-surface-50 rounded-lg">
            <MetaItem label="Type"><Badge text={item.type} styleMap={TYPE_STYLES} /></MetaItem>
            <MetaItem label="Priority"><Badge text={item.priority} styleMap={PRIORITY_STYLES} /></MetaItem>
            <MetaItem label="Status"><Badge text={item.status} styleMap={STATUS_STYLES} /></MetaItem>
            <MetaItem label="Submitted By"><span className="text-sm font-medium text-surface-800">{item.submitted_by || '—'}</span></MetaItem>
            <MetaItem label="Submitted Date"><span className="text-sm text-surface-700">{formatDate(item.submitted_date)}</span></MetaItem>
            <MetaItem label="Resolved Date"><span className="text-sm text-surface-700">{formatDate(item.resolved_date)}</span></MetaItem>
          </div>

          {/* Description */}
          <div>
            <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-1">Description</h4>
            <p className="text-sm text-surface-700 whitespace-pre-wrap">
              {item.description || 'No description provided'}
            </p>
          </div>

          {/* Resolution Notes */}
          {item.resolution_notes && (
            <div>
              <h4 className="text-[11px] font-semibold text-surface-400 uppercase tracking-wider mb-1">Resolution Notes</h4>
              <p className="text-sm text-surface-700 whitespace-pre-wrap">{item.resolution_notes}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">
            Close
          </button>
          {onEdit && (
            <button onClick={onEdit}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 flex items-center gap-1.5">
              <Edit3 size={14} /> Edit
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM MODAL (with optional prompt input)
// ═══════════════════════════════════════════════════════════════════════════════

function ConfirmModal({ title, message, okText, danger, prompt, promptLabel, onOk, onCancel }) {
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)

  const handleOk = async () => {
    setWorking(true)
    try {
      await onOk(reason)
    } finally {
      setWorking(false)
    }
  }

  return (
    <ModalOverlay onClose={onCancel} zIndex="z-[60]">
      <div className="bg-white rounded-xl w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center gap-2">
          <HelpCircle size={18} className="text-amber-500 shrink-0" />
          <h3 className="font-semibold text-surface-900">{title || 'Confirm'}</h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-surface-600 text-center">{message}</p>
          {prompt && (
            <div className="mt-3">
              <label className="text-[11px] font-medium text-surface-500">{promptLabel || 'Reason'}</label>
              <input type="text" value={reason} onChange={e => setReason(e.target.value)}
                className="input text-sm mt-1" placeholder="Optional…" />
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-center gap-3">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">
            Cancel
          </button>
          <button onClick={handleOk} disabled={working}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-1.5 ${
              danger ? 'bg-red-500 hover:bg-red-600' : 'bg-brand-600 hover:bg-brand-700'
            } disabled:opacity-40`}>
            {working && <Loader2 size={14} className="animate-spin" />}
            {okText || 'OK'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function ModalOverlay({ children, onClose, zIndex = 'z-50' }) {
  return (
    <div className={`fixed inset-0 bg-black/40 ${zIndex} flex items-center justify-center p-4`}
      onClick={onClose}>
      {children}
    </div>
  )
}

function Field({ label, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-surface-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function MetaItem({ label, children }) {
  return (
    <div>
      <div className="text-[10px] text-surface-400 font-medium mb-0.5">{label}</div>
      {children}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD CHANGELOG MODAL (super admin only — manual entries)
// ═══════════════════════════════════════════════════════════════════════════════

function AddChangelogModal({ onClose, onSaved, actions }) {
  const [form, setForm] = useState({
    type: 'Bug',
    title: '',
    description: '',
    versionMode: 'auto', // 'auto' | 'major' | 'none'
  })
  const titleInputRef = React.useRef(null)

  // Auto-focus the title input on open
  useEffect(() => {
    titleInputRef.current?.focus()
  }, [])

  // ESC closes the modal (WCAG 2.1.2 — keyboard accessible)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    if (!form.title.trim()) return
    const result = await actions.addManualChangelogEntry({
      type: form.type,
      title: form.title.trim(),
      description: form.description.trim(),
      bumpVersion: form.versionMode,
    })
    if (result?.success) {
      onSaved?.()
      onClose()
    }
  }

  // Helper text shown beneath the type dropdown explains version impact.
  let versionHelper
  if (form.versionMode === 'none') {
    versionHelper = 'Will be logged under the current version (no bump)'
  } else if (form.versionMode === 'major') {
    versionHelper = 'Will bump the MAJOR version (e.g. 3.3.3 → 4.0.0)'
  } else if (form.type === 'Feature Request') {
    versionHelper = 'Will bump the minor version (e.g. 3.3.x → 3.4.0)'
  } else {
    versionHelper = 'Will bump the patch version (e.g. 3.3.3 → 3.3.4)'
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-changelog-title"
        aria-describedby="add-changelog-description"
        className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center text-white shrink-0">
              <History size={16} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 id="add-changelog-title" className="font-semibold text-surface-900">
                Add Changelog Entry
              </h3>
              <div className="text-[11px] text-surface-400">Manual entry — super admin only</div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg hover:bg-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500 text-surface-400 shrink-0"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Info banner */}
          <div
            id="add-changelog-description"
            className="p-3 bg-blue-50 border border-blue-100 rounded-lg flex items-start gap-2"
          >
            <AlertCircle size={14} className="text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-xs text-blue-800">
              Use this to log changes you made directly without a corresponding bug or
              feature request. The version will auto-bump based on the type you select.
            </p>
          </div>

          {/* Type */}
          <Field label="Type *" htmlFor="changelog-type">
            <select
              id="changelog-type"
              value={form.type}
              onChange={e => set('type', e.target.value)}
              className="input text-sm"
            >
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <p className="text-[11px] text-surface-500 mt-1" aria-live="polite">
              {versionHelper}
            </p>
          </Field>

          {/* Title */}
          <Field label="Title *" htmlFor="changelog-title-input">
            <input
              ref={titleInputRef}
              id="changelog-title-input"
              type="text"
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="Brief summary of what changed"
              className="input text-sm"
              maxLength={200}
              required
              aria-required="true"
            />
          </Field>

          {/* Description */}
          <Field label="Description (optional)" htmlFor="changelog-description-input">
            <textarea
              id="changelog-description-input"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={4}
              placeholder="Additional details about the change…"
              className="input text-sm resize-none"
            />
          </Field>

          {/* Version handling — 3 options */}
          <fieldset className="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <legend className="px-1 text-xs font-medium text-surface-600">Version handling</legend>
            <div className="space-y-1">
              <label
                htmlFor="vmode-auto"
                className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white"
              >
                <input
                  type="radio"
                  id="vmode-auto"
                  name="changelog-version-mode"
                  value="auto"
                  checked={form.versionMode === 'auto'}
                  onChange={() => set('versionMode', 'auto')}
                  className="mt-0.5 w-4 h-4 text-brand-600 focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-surface-800">Auto-bump (per type)</div>
                  <div className="text-[11px] text-surface-500">
                    Bug bumps patch (e.g. 3.3.3 → 3.3.4); Feature Request bumps minor (e.g. 3.3.x → 3.4.0)
                  </div>
                </div>
              </label>
              <label
                htmlFor="vmode-major"
                className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white"
              >
                <input
                  type="radio"
                  id="vmode-major"
                  name="changelog-version-mode"
                  value="major"
                  checked={form.versionMode === 'major'}
                  onChange={() => set('versionMode', 'major')}
                  className="mt-0.5 w-4 h-4 text-brand-600 focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-surface-800">Major version bump</div>
                  <div className="text-[11px] text-surface-500">
                    e.g. 3.3.3 → 4.0.0 — for milestones, big releases, or breaking changes
                  </div>
                </div>
              </label>
              <label
                htmlFor="vmode-none"
                className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white"
              >
                <input
                  type="radio"
                  id="vmode-none"
                  name="changelog-version-mode"
                  value="none"
                  checked={form.versionMode === 'none'}
                  onChange={() => set('versionMode', 'none')}
                  className="mt-0.5 w-4 h-4 text-brand-600 focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-surface-800">No bump</div>
                  <div className="text-[11px] text-surface-500">
                    Log under the current version — for typos, small tweaks, or duplicates
                  </div>
                </div>
              </label>
            </div>
          </fieldset>
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 focus:outline-none focus:ring-2 focus:ring-surface-400 border border-surface-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={actions.saving || !form.title.trim()}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-40 flex items-center gap-1.5 ${
              form.versionMode === 'major'
                ? 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500'
                : 'bg-brand-600 hover:bg-brand-700 focus:ring-brand-500'
            }`}
          >
            {actions.saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {form.versionMode === 'major' ? 'Add & Major Bump' : 'Add Entry'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
