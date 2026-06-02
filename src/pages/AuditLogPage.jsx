/**
 * RICT CMMS — AuditLogPage
 *
 * Viewer for the audit_log table with smart search, filters, drill-down,
 * pagination, realtime new-entry detection, export (CSV/XLSX), suspicious
 * activity banner, failed-write banner, and an accessible detail modal
 * with diff viewer.
 *
 * Permissions (via usePermissions('Audit Log')):
 *   view_page          → full UI
 *   view_own           → only own rows, simplified UI (no user dropdown)
 *   export             → export buttons visible
 *   view_suspicious    → suspicious activity banner
 *   view_failed_writes → failed write banner
 *
 * WCAG 2.1 AA:
 *   • useDialogA11y on the detail modal
 *   • aria-sort on sortable column headers
 *   • aria-live polite region for filter result count
 *   • aria-busy during loads
 *   • focus-visible outlines, min 28×32 touch targets
 *   • role=dialog + aria-modal + aria-labelledby on modal
 *   • Proper table semantics with caption, scope=col headers
 *
 * File: src/pages/AuditLogPage.jsx
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  FileSearch, RefreshCw, Download, FileText, FileSpreadsheet,
  Search, HelpCircle, X, ChevronLeft, ChevronRight,
  AlertTriangle, AlertCircle, Eye, Filter, Calendar,
  User, Activity, Box, ArrowUpDown, ArrowUp, ArrowDown,
  ChevronDown, Loader2, Inbox, Clock, Mail, Tag, Hash,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/AuthContext'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { useAuditLog } from '@/hooks/useAuditLog'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function formatFullTimestamp(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return String(ts)
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true,
  })
}

function formatRelative(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const now = Date.now()
  const diff = Math.round((now - d.getTime()) / 1000)
  if (diff < 60)      return diff <= 5 ? 'just now' : `${diff}s ago`
  if (diff < 3600)    return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)   return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800)  return `${Math.floor(diff / 86400)}d ago`
  return d.toLocaleDateString()
}

function toDateInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  // YYYY-MM-DD in local time
  const yr = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${yr}-${mo}-${da}`
}

function fromDateInput(s, endOfDay = false) {
  if (!s) return null
  // Treat YYYY-MM-DD as local midnight; for endOfDay use 23:59:59.999
  const d = new Date(s + (endOfDay ? 'T23:59:59.999' : 'T00:00:00'))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function actionBadgeClass(action) {
  const a = (action || '').toLowerCase()
  if (a.startsWith('create') || a === 'add' || a.startsWith('added'))
    return 'bg-green-50 text-green-800 border-green-200'
  if (a.startsWith('update') || a.startsWith('edit') || a.startsWith('modif'))
    return 'bg-blue-50 text-blue-800 border-blue-200'
  if (a.startsWith('delete') || a.startsWith('remove') || a.startsWith('purge'))
    return 'bg-red-50 text-red-800 border-red-200'
  if (a.startsWith('approve'))
    return 'bg-emerald-50 text-emerald-800 border-emerald-200'
  if (a.startsWith('reject') || a.startsWith('den'))
    return 'bg-amber-50 text-amber-800 border-amber-200'
  if (a.startsWith('close'))
    return 'bg-slate-100 text-slate-700 border-slate-200'
  if (a.startsWith('reopen'))
    return 'bg-sky-50 text-sky-800 border-sky-200'
  if (a.startsWith('view') || a.startsWith('read'))
    return 'bg-purple-50 text-purple-800 border-purple-200'
  if (a.startsWith('export'))
    return 'bg-indigo-50 text-indigo-800 border-indigo-200'
  if (a.startsWith('reset'))
    return 'bg-orange-50 text-orange-800 border-orange-200'
  return 'bg-slate-50 text-slate-700 border-slate-200'
}

function truncate(s, n = 100) {
  if (!s) return ''
  const str = String(s)
  return str.length > n ? str.slice(0, n) + '…' : str
}


// ──────────────────────────────────────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────────────────────────────────────

export default function AuditLogPage() {
  const { profile } = useAuth()
  const audit = useAuditLog()

  const [selectedEntry, setSelectedEntry] = useState(null)
  const [showSearchTips, setShowSearchTips] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  // ── View tracking — fire once when access is confirmed ──
  const viewTracked = useRef(false)
  useEffect(() => {
    if (audit.permsLoading) return
    if (!audit.canView) return
    if (viewTracked.current) return
    viewTracked.current = true
    audit.trackView('Audit Log', 'PAGE', 'Viewed Audit Log page')
  }, [audit.permsLoading, audit.canView, audit.trackView])

  // ── Click-outside for popovers ──
  const tipsRef = useRef(null)
  const exportMenuRef = useRef(null)
  useEffect(() => {
    if (!showSearchTips && !exportMenuOpen) return
    function onDown(e) {
      if (showSearchTips && tipsRef.current && !tipsRef.current.contains(e.target)) {
        setShowSearchTips(false)
      }
      if (exportMenuOpen && exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false)
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        setShowSearchTips(false)
        setExportMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [showSearchTips, exportMenuOpen])

  // ── Drill-down handlers ──
  const drillDownUser = useCallback((email) => {
    if (!audit.canViewAll) return
    audit.setFilter('userEmail', email)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [audit])

  const drillDownEntity = useCallback((entityType, entityId) => {
    if (entityType) audit.setFilter('entityType', entityType)
    if (entityId)   audit.setFilter('entityId', entityId)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [audit])

  // ── Export ──
  const doExport = useCallback(async (format) => {
    setExportMenuOpen(false)
    setExporting(true)
    try {
      const fn = format === 'xlsx' ? audit.exportXLSX : audit.exportCSV
      const result = await fn()
      toast.success(
        `Exported ${result.count} entries${result.capped ? ' (capped at 10,000 — narrow filters for full set)' : ''}`
      )
    } catch (e) {
      toast.error(e.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }, [audit])

  // ── Active filter chips ──
  const activeChips = useMemo(() => {
    const chips = []
    if (audit.filters.userEmail)  chips.push({ key: 'userEmail',  label: 'User',   value: audit.filters.userEmail })
    if (audit.filters.entityType) chips.push({ key: 'entityType', label: 'Type',   value: audit.filters.entityType })
    if (audit.filters.entityId)   chips.push({ key: 'entityId',   label: 'ID',     value: audit.filters.entityId })
    if (audit.filters.action)     chips.push({ key: 'action',     label: 'Action', value: audit.filters.action })
    return chips
  }, [audit.filters])

  // ── Permission states ──
  if (audit.permsLoading) {
    return (
      <div className="p-6 flex items-center justify-center" role="status" aria-live="polite">
        <Loader2 size={20} className="animate-spin text-brand-600 mr-2" aria-hidden="true" />
        <span className="text-sm text-surface-600">Loading…</span>
      </div>
    )
  }

  if (!audit.canView) {
    return (
      <div className="p-6">
        <div className="max-w-md mx-auto text-center py-16">
          <FileSearch size={40} className="mx-auto text-surface-400 mb-3" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-surface-900 mb-1">Audit Log</h1>
          <p className="text-sm text-surface-500">You do not have permission to view the audit log.</p>
        </div>
      </div>
    )
  }


  // ──────────────────────────────────────────────────────────────────────────
  // Main render
  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 lg:p-6 space-y-3">

      {/* ── Failed-write banner ───────────────────────────────────────────── */}
      {(audit.hasPerm('view_failed_writes') || audit.isSuperAdmin) && audit.failedCount > 0 && (
        <FailedWriteBanner
          count={audit.failedCount}
          onReset={async () => {
            const ok = await audit.resetFailedCount()
            if (ok) toast.success('Failed-write counter reset to 0')
            else    toast.error('Could not reset counter')
          }}
          canReset={audit.isSuperAdmin}
        />
      )}

      {/* ── Suspicious activity banner ────────────────────────────────────── */}
      {(audit.hasPerm('view_suspicious') || audit.isSuperAdmin) && audit.suspiciousFlags.length > 0 && (
        <SuspiciousBanner
          flags={audit.suspiciousFlags}
          onDismiss={audit.dismissSuspicious}
          onJump={(flag) => {
            // Filter to the flagged user + action type window
            audit.setFilter('userEmail', flag.user_email)
            audit.setFilter('action', flag.flag_type.includes('Delete') ? 'Delete' : 'Update')
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
        />
      )}

      {/* ── Own-view notice (students/work-study) ─────────────────────────── */}
      {audit.canViewOwnOnly && (
        <div
          className="flex items-start gap-2.5 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900"
          role="status"
        >
          <Eye size={16} className="flex-shrink-0 mt-0.5 text-blue-600" aria-hidden="true" />
          <div>
            <strong>Showing only your activity.</strong> You can review every action you've taken in the system here.
          </div>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-surface-900 flex items-center gap-2">
            <FileSearch size={20} className="text-brand-600" aria-hidden="true" />
            Audit Log
          </h1>
          <p className="text-sm text-surface-500 mt-0.5">
            {audit.canViewAll
              ? 'Track every change across the system — who, what, when, and what changed.'
              : 'A complete history of your actions in the system.'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={audit.refresh}
            disabled={audit.loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] text-sm font-medium text-surface-700 bg-white border border-surface-300 rounded-lg hover:bg-surface-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Refresh audit log"
          >
            <RefreshCw size={14} className={audit.loading ? 'animate-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
          {(audit.hasPerm('export') || audit.isSuperAdmin) && (
            <div className="relative" ref={exportMenuRef}>
              <button
                type="button"
                onClick={() => setExportMenuOpen(v => !v)}
                disabled={exporting || audit.loading || audit.total === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                aria-label="Export audit log"
              >
                {exporting
                  ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  : <Download size={14} aria-hidden="true" />}
                Export
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 w-44 bg-white border border-surface-200 rounded-lg shadow-lg z-20 py-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => doExport('csv')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 hover:bg-surface-50 focus-visible:outline-none focus-visible:bg-surface-50"
                  >
                    <FileText size={14} aria-hidden="true" />
                    Export as CSV
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => doExport('xlsx')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 hover:bg-surface-50 focus-visible:outline-none focus-visible:bg-surface-50"
                  >
                    <FileSpreadsheet size={14} aria-hidden="true" />
                    Export as XLSX
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-surface-200 rounded-lg p-3 space-y-3">

        {/* Top row: date range + dropdowns + reset */}
        <div className="flex flex-wrap gap-2 items-end">
          <FilterField label="From" icon={Calendar}>
            <input
              type="date"
              value={toDateInput(audit.filters.startDate)}
              onChange={e => audit.setFilter('startDate', fromDateInput(e.target.value))}
              className="px-2.5 py-1.5 min-h-[32px] text-sm border border-surface-300 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              aria-label="Start date"
            />
          </FilterField>

          <FilterField label="To" icon={Calendar}>
            <input
              type="date"
              value={toDateInput(audit.filters.endDate)}
              onChange={e => audit.setFilter('endDate', fromDateInput(e.target.value, true))}
              className="px-2.5 py-1.5 min-h-[32px] text-sm border border-surface-300 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              aria-label="End date"
            />
          </FilterField>

          {audit.canViewAll && (
            <FilterField label="User" icon={User}>
              <select
                value={audit.filters.userEmail || ''}
                onChange={e => audit.setFilter('userEmail', e.target.value || null)}
                className="px-2.5 py-1.5 min-h-[32px] text-sm border border-surface-300 rounded-md bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 max-w-[180px]"
                aria-label="Filter by user"
              >
                <option value="">All users</option>
                {audit.distinctUsers.map(u => (
                  <option key={u.email} value={u.email}>{u.name}</option>
                ))}
              </select>
            </FilterField>
          )}

          <FilterField label="Entity" icon={Box}>
            <select
              value={audit.filters.entityType || ''}
              onChange={e => audit.setFilter('entityType', e.target.value || null)}
              className="px-2.5 py-1.5 min-h-[32px] text-sm border border-surface-300 rounded-md bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              aria-label="Filter by entity type"
            >
              <option value="">All types</option>
              {audit.distinctEntityTypes.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Action" icon={Activity}>
            <select
              value={audit.filters.action || ''}
              onChange={e => audit.setFilter('action', e.target.value || null)}
              className="px-2.5 py-1.5 min-h-[32px] text-sm border border-surface-300 rounded-md bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              aria-label="Filter by action"
            >
              <option value="">All actions</option>
              {audit.distinctActions.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </FilterField>

          <button
            type="button"
            onClick={audit.resetFilters}
            className="px-2.5 py-1.5 min-h-[32px] text-sm font-medium text-surface-700 bg-surface-50 border border-surface-300 rounded-md hover:bg-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Reset all filters"
          >
            Reset
          </button>
        </div>

        {/* Bottom row: smart search */}
        <div className="flex items-stretch gap-2">
          <div className="relative flex-1 min-w-0">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={audit.searchTerm}
              onChange={e => audit.setSearchTerm(e.target.value)}
              placeholder="Smart search — try WO1234, brad@email.com, delete, or any text…"
              className="w-full pl-8 pr-8 py-1.5 min-h-[32px] text-sm border border-surface-300 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              aria-label="Smart search audit log"
              aria-describedby="audit-search-chip audit-search-tip-button"
            />
            {audit.searchTerm && (
              <button
                type="button"
                onClick={() => audit.setSearchTerm('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-surface-400 hover:text-surface-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 rounded"
                aria-label="Clear search"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="relative" ref={tipsRef}>
            <button
              id="audit-search-tip-button"
              type="button"
              onClick={() => setShowSearchTips(v => !v)}
              className="px-2 py-1.5 min-h-[32px] min-w-[32px] text-sm text-surface-600 bg-white border border-surface-300 rounded-md hover:bg-surface-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
              aria-label="Search tips"
              aria-expanded={showSearchTips}
              aria-haspopup="dialog"
            >
              <HelpCircle size={14} aria-hidden="true" />
            </button>
            {showSearchTips && <SearchTipsPopover />}
          </div>
        </div>

        {/* Active chip display */}
        {(activeChips.length > 0 || audit.parsedSearch.type !== 'none') && (
          <div className="flex flex-wrap gap-1.5 pt-1" id="audit-search-chip">
            {audit.parsedSearch.type !== 'none' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-brand-50 text-brand-700 border border-brand-200 rounded-full">
                <Search size={10} aria-hidden="true" />
                <span className="font-semibold">{audit.parsedSearch.label}:</span>
                <span>{audit.parsedSearch.value}</span>
              </span>
            )}
            {activeChips.map(c => (
              <button
                key={c.key}
                type="button"
                onClick={() => audit.setFilter(c.key, null)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-surface-100 text-surface-700 border border-surface-300 rounded-full hover:bg-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                aria-label={`Remove ${c.label} filter: ${c.value}`}
              >
                <span className="font-semibold">{c.label}:</span>
                <span>{c.value}</span>
                <X size={10} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Results bar ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-3" aria-live="polite">
          <span className="text-surface-600">
            {audit.loading
              ? 'Loading…'
              : audit.total === 0
                ? 'No entries match these filters'
                : (() => {
                    const start = (audit.page - 1) * audit.pageSize + 1
                    const end   = Math.min(audit.page * audit.pageSize, audit.total)
                    return `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${audit.total.toLocaleString()}`
                  })()
            }
          </span>

          {audit.newEntriesCount > 0 && (
            <button
              type="button"
              onClick={audit.refresh}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded-full hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
              aria-label={`${audit.newEntriesCount} new entries — click to refresh`}
            >
              <RefreshCw size={11} aria-hidden="true" />
              {audit.newEntriesCount} new — click to refresh
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-surface-600 flex items-center gap-1.5">
            <span className="text-xs">Per page</span>
            <select
              value={audit.pageSize}
              onChange={e => audit.setPageSize(Number(e.target.value))}
              className="px-2 py-1 min-h-[28px] text-sm border border-surface-300 rounded-md bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              aria-label="Entries per page"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </label>

          <Pagination
            page={audit.page}
            totalPages={audit.totalPages}
            onChange={audit.setPage}
            disabled={audit.loading}
          />
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-surface-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-busy={audit.loading}>
            <caption className="sr-only">Audit log entries</caption>
            <thead className="bg-surface-50 border-b border-surface-200">
              <tr>
                <SortableTh
                  label="Timestamp"
                  column="timestamp"
                  sortColumn={audit.sortColumn}
                  sortDirection={audit.sortDirection}
                  onSort={audit.setSort}
                  className="min-w-[160px]"
                />
                <SortableTh
                  label="User"
                  column="user_name"
                  sortColumn={audit.sortColumn}
                  sortDirection={audit.sortDirection}
                  onSort={audit.setSort}
                  className="min-w-[140px]"
                />
                <SortableTh
                  label="Action"
                  column="action"
                  sortColumn={audit.sortColumn}
                  sortDirection={audit.sortDirection}
                  onSort={audit.setSort}
                  className="min-w-[110px]"
                />
                <SortableTh
                  label="Entity"
                  column="entity_type"
                  sortColumn={audit.sortColumn}
                  sortDirection={audit.sortDirection}
                  onSort={audit.setSort}
                  className="min-w-[170px]"
                />
                <th scope="col" className="px-3 py-2 text-left font-semibold text-surface-700">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-100">
              {audit.loading && audit.entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-surface-500">
                    <Loader2 size={20} className="mx-auto mb-2 animate-spin text-brand-500" aria-hidden="true" />
                    Loading audit entries…
                  </td>
                </tr>
              )}

              {audit.error && !audit.loading && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-red-600">
                    <AlertCircle size={20} className="mx-auto mb-2" aria-hidden="true" />
                    {audit.error}
                  </td>
                </tr>
              )}

              {!audit.loading && !audit.error && audit.entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-12 text-center text-surface-500">
                    <Inbox size={28} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
                    <div className="font-medium text-surface-700">No entries match these filters</div>
                    <div className="text-xs mt-1">Try widening the date range or clearing filters.</div>
                  </td>
                </tr>
              )}

              {audit.entries.map(entry => (
                <AuditRow
                  key={entry.log_id || `${entry.timestamp}-${entry.user_email}-${entry.action}-${entry.entity_id}`}
                  entry={entry}
                  onOpen={() => setSelectedEntry(entry)}
                  onUserClick={drillDownUser}
                  onEntityClick={drillDownEntity}
                  canDrillUser={audit.canViewAll}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Bottom pagination (mirrored for long pages) ─────────────────────── */}
      {audit.entries.length > 15 && (
        <div className="flex justify-end">
          <Pagination
            page={audit.page}
            totalPages={audit.totalPages}
            onChange={audit.setPage}
            disabled={audit.loading}
          />
        </div>
      )}

      {/* ── Detail modal ──────────────────────────────────────────────────── */}
      {selectedEntry && (
        <DetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onUserClick={(email) => { setSelectedEntry(null); drillDownUser(email) }}
          onEntityClick={(t, id) => { setSelectedEntry(null); drillDownEntity(t, id) }}
          canDrillUser={audit.canViewAll}
        />
      )}
    </div>
  )
}


// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────

function FilterField({ label, icon: Icon, children }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-surface-600 flex items-center gap-1">
        {Icon && <Icon size={11} aria-hidden="true" />}
        {label}
      </span>
      {children}
    </label>
  )
}

function SortableTh({ label, column, sortColumn, sortDirection, onSort, className = '' }) {
  const isActive = sortColumn === column
  const ariaSort = !isActive ? 'none' : (sortDirection === 'asc' ? 'ascending' : 'descending')
  const Icon = !isActive ? ArrowUpDown : (sortDirection === 'asc' ? ArrowUp : ArrowDown)
  return (
    <th scope="col" aria-sort={ariaSort} className={`px-3 py-2 text-left font-semibold text-surface-700 ${className}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 font-semibold text-surface-700 hover:text-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 rounded"
        aria-label={`Sort by ${label} (${isActive ? sortDirection + 'ending' : 'click to sort'})`}
      >
        {label}
        <Icon size={12} className={isActive ? 'text-brand-600' : 'text-surface-400'} aria-hidden="true" />
      </button>
    </th>
  )
}

function AuditRow({ entry, onOpen, onUserClick, onEntityClick, canDrillUser }) {
  return (
    <tr
      className="hover:bg-surface-50 focus-within:bg-surface-50 cursor-pointer"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open details for ${entry.action || 'audit entry'} by ${entry.user_name || entry.user_email}`}
    >
      <td className="px-3 py-2 align-top whitespace-nowrap">
        <div className="text-surface-900">{formatRelative(entry.timestamp)}</div>
        <div className="text-xs text-surface-500">{formatFullTimestamp(entry.timestamp)}</div>
      </td>
      <td className="px-3 py-2 align-top">
        {canDrillUser ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUserClick(entry.user_email) }}
            className="text-surface-900 hover:text-brand-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 rounded text-left"
            aria-label={`Filter to ${entry.user_name || entry.user_email}'s activity`}
          >
            <div className="font-medium">{entry.user_name || '—'}</div>
            <div className="text-xs text-surface-500">{entry.user_email}</div>
          </button>
        ) : (
          <div>
            <div className="font-medium text-surface-900">{entry.user_name || '—'}</div>
            <div className="text-xs text-surface-500">{entry.user_email}</div>
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top whitespace-nowrap">
        <span className={`inline-block px-2 py-0.5 text-xs font-medium border rounded-full ${actionBadgeClass(entry.action)}`}>
          {entry.action || '—'}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEntityClick(entry.entity_type, entry.entity_id) }}
          className="text-surface-900 hover:text-brand-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 rounded text-left"
          aria-label={`Filter to ${entry.entity_type} ${entry.entity_id}`}
          disabled={!entry.entity_type && !entry.entity_id}
        >
          <div className="text-xs text-surface-500">{entry.entity_type || '—'}</div>
          <div className="font-mono text-xs text-surface-700">{entry.entity_id || ''}</div>
        </button>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="text-surface-700 break-words" title={entry.details}>
          {truncate(entry.details, 140)}
        </div>
      </td>
    </tr>
  )
}


function Pagination({ page, totalPages, onChange, disabled }) {
  const canPrev = page > 1
  const canNext = page < totalPages
  return (
    <nav className="inline-flex items-center gap-1" aria-label="Audit log pagination">
      <button
        type="button"
        onClick={() => onChange(1)}
        disabled={disabled || !canPrev}
        className="px-2 py-1 min-h-[28px] min-w-[28px] text-xs text-surface-700 bg-white border border-surface-300 rounded-md hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        aria-label="First page"
      >
        ⏮
      </button>
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={disabled || !canPrev}
        className="inline-flex items-center px-2 py-1 min-h-[28px] min-w-[28px] text-sm text-surface-700 bg-white border border-surface-300 rounded-md hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        aria-label="Previous page"
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <span className="px-2 text-xs text-surface-600 whitespace-nowrap" aria-current="page">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={disabled || !canNext}
        className="inline-flex items-center px-2 py-1 min-h-[28px] min-w-[28px] text-sm text-surface-700 bg-white border border-surface-300 rounded-md hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        aria-label="Next page"
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onChange(totalPages)}
        disabled={disabled || !canNext}
        className="px-2 py-1 min-h-[28px] min-w-[28px] text-xs text-surface-700 bg-white border border-surface-300 rounded-md hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        aria-label="Last page"
      >
        ⏭
      </button>
    </nav>
  )
}


function FailedWriteBanner({ count, onReset, canReset }) {
  return (
    <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-lg" role="status">
      <AlertTriangle size={18} className="flex-shrink-0 mt-0.5 text-amber-600" aria-hidden="true" />
      <div className="flex-1 text-sm text-amber-900">
        <div className="font-semibold">
          {count.toLocaleString()} audit write{count !== 1 ? 's' : ''} failed since last reset
        </div>
        <div className="text-xs mt-0.5 text-amber-800">
          Phase 2's <code className="bg-amber-100 px-1 py-0.5 rounded">writeAudit()</code> helper increments this counter when an insert fails — a non-zero value indicates audit data may be incomplete. Check Supabase logs for the underlying cause.
        </div>
      </div>
      {canReset && (
        <button
          type="button"
          onClick={onReset}
          className="px-2.5 py-1 min-h-[28px] text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded-md hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          aria-label="Reset failed-write counter to zero"
        >
          Reset to 0
        </button>
      )}
    </div>
  )
}


function SuspiciousBanner({ flags, onDismiss, onJump }) {
  return (
    <div className="flex items-start gap-2.5 p-3 bg-orange-50 border border-orange-200 rounded-lg" role="status">
      <AlertTriangle size={18} className="flex-shrink-0 mt-0.5 text-orange-600" aria-hidden="true" />
      <div className="flex-1 text-sm text-orange-900">
        <div className="font-semibold mb-1">
          Activity worth reviewing ({flags.length})
        </div>
        <ul className="space-y-1 text-xs">
          {flags.slice(0, 5).map((f, i) => (
            <li key={`${f.user_email}-${f.flag_type}-${f.window_start}-${i}`} className="flex items-center gap-2">
              <span className="text-orange-800">
                <strong>{f.user_name || f.user_email}</strong>
                {' — '}
                {f.flag_type}: {f.event_count} actions between {formatFullTimestamp(f.window_start)} and {formatFullTimestamp(f.window_end)}
              </span>
              <button
                type="button"
                onClick={() => onJump(f)}
                className="ml-auto text-orange-700 hover:text-orange-900 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 rounded"
                aria-label={`Filter to ${f.user_name || f.user_email}'s ${f.flag_type.toLowerCase()} activity`}
              >
                View
              </button>
            </li>
          ))}
          {flags.length > 5 && (
            <li className="text-orange-700 italic">…and {flags.length - 5} more</li>
          )}
        </ul>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="p-1 min-h-[28px] min-w-[28px] flex items-center justify-center text-orange-700 hover:text-orange-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 rounded"
        aria-label="Dismiss suspicious activity banner"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}


function SearchTipsPopover() {
  return (
    <div
      role="dialog"
      aria-label="Search tips"
      className="absolute right-0 top-full mt-1 w-80 bg-white border border-surface-200 rounded-lg shadow-lg z-20 p-3 text-sm"
    >
      <div className="font-semibold text-surface-900 mb-2 flex items-center gap-1.5">
        <HelpCircle size={14} className="text-brand-600" aria-hidden="true" />
        Smart search understands:
      </div>
      <ul className="space-y-1.5 text-xs text-surface-700">
        <li className="flex items-start gap-2">
          <Mail size={11} className="mt-0.5 text-blue-500 flex-shrink-0" aria-hidden="true" />
          <div>
            <strong>Emails</strong> — e.g. <code className="bg-surface-100 px-1 rounded">brad@example.com</code> filters by user
          </div>
        </li>
        <li className="flex items-start gap-2">
          <Hash size={11} className="mt-0.5 text-purple-500 flex-shrink-0" aria-hidden="true" />
          <div>
            <strong>Entity IDs</strong> — e.g. <code className="bg-surface-100 px-1 rounded">WO1234</code>, <code className="bg-surface-100 px-1 rounded">AST12</code> (partial matches OK)
          </div>
        </li>
        <li className="flex items-start gap-2">
          <Activity size={11} className="mt-0.5 text-green-500 flex-shrink-0" aria-hidden="true" />
          <div>
            <strong>Action keywords</strong> — <code className="bg-surface-100 px-1 rounded">create</code>, <code className="bg-surface-100 px-1 rounded">delete</code>, <code className="bg-surface-100 px-1 rounded">approve</code>, etc.
          </div>
        </li>
        <li className="flex items-start gap-2">
          <Tag size={11} className="mt-0.5 text-orange-500 flex-shrink-0" aria-hidden="true" />
          <div>
            <strong>Entity types</strong> — <code className="bg-surface-100 px-1 rounded">work order</code>, <code className="bg-surface-100 px-1 rounded">asset</code>, <code className="bg-surface-100 px-1 rounded">user</code>, etc.
          </div>
        </li>
        <li className="flex items-start gap-2">
          <Search size={11} className="mt-0.5 text-surface-500 flex-shrink-0" aria-hidden="true" />
          <div>
            <strong>Anything else</strong> — searches user names, details, IDs, and before/after values
          </div>
        </li>
      </ul>
      <div className="mt-2 pt-2 border-t border-surface-200 text-xs text-surface-500">
        Tip: Combine with filters above to narrow further.
      </div>
    </div>
  )
}


// ──────────────────────────────────────────────────────────────────────────────
// Detail modal
// ──────────────────────────────────────────────────────────────────────────────

function DetailModal({ entry, onClose, onUserClick, onEntityClick, canDrillUser }) {
  const dialogRef = useDialogA11y(true, onClose)

  const hasDiff = !!(entry.old_value || entry.new_value)
  const fieldChanged = entry.field_changed

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-detail-title"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-200">
          <div className="flex items-center gap-2">
            <FileSearch size={18} className="text-brand-600" aria-hidden="true" />
            <h2 id="audit-detail-title" className="text-base font-semibold text-surface-900">
              Audit Entry Details
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 min-h-[32px] min-w-[32px] flex items-center justify-center text-surface-500 hover:text-surface-900 rounded-md hover:bg-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Close details"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4 space-y-3 text-sm">
          {/* Action badge + log id */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className={`inline-block px-3 py-1 text-sm font-medium border rounded-full ${actionBadgeClass(entry.action)}`}>
              {entry.action || 'Unknown action'}
            </span>
            {entry.log_id && (
              <span className="text-xs font-mono text-surface-500">{entry.log_id}</span>
            )}
          </div>

          {/* When */}
          <DetailRow label="When" icon={Clock}>
            <div className="text-surface-900">{formatFullTimestamp(entry.timestamp)}</div>
            <div className="text-xs text-surface-500">{formatRelative(entry.timestamp)}</div>
          </DetailRow>

          {/* Who */}
          <DetailRow label="Who" icon={User}>
            <div className="text-surface-900 font-medium">{entry.user_name || '—'}</div>
            <div className="text-xs text-surface-500 flex items-center gap-1">
              <Mail size={11} aria-hidden="true" />
              {entry.user_email || '—'}
            </div>
            {canDrillUser && entry.user_email && (
              <button
                type="button"
                onClick={() => onUserClick(entry.user_email)}
                className="mt-1 text-xs text-brand-600 hover:text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 rounded"
              >
                Show all entries by this user →
              </button>
            )}
          </DetailRow>

          {/* Entity */}
          {(entry.entity_type || entry.entity_id) && (
            <DetailRow label="Entity" icon={Box}>
              <div className="text-surface-900">{entry.entity_type || '—'}</div>
              {entry.entity_id && (
                <div className="text-xs font-mono text-surface-700">{entry.entity_id}</div>
              )}
              <button
                type="button"
                onClick={() => onEntityClick(entry.entity_type, entry.entity_id)}
                className="mt-1 text-xs text-brand-600 hover:text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 rounded"
              >
                Show all entries for this {entry.entity_id ? 'entity' : 'entity type'} →
              </button>
            </DetailRow>
          )}

          {/* Field changed + diff */}
          {(fieldChanged || hasDiff) && (
            <DetailRow label={fieldChanged ? `Field: ${fieldChanged}` : 'Change'} icon={Activity}>
              <DiffViewer oldValue={entry.old_value} newValue={entry.new_value} />
            </DetailRow>
          )}

          {/* Details */}
          {entry.details && (
            <DetailRow label="Details" icon={FileText}>
              <pre className="whitespace-pre-wrap break-words text-surface-900 text-sm bg-surface-50 border border-surface-200 rounded-md p-2 font-sans">
                {entry.details}
              </pre>
            </DetailRow>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-surface-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 min-h-[32px] text-sm font-medium text-surface-700 bg-white border border-surface-300 rounded-lg hover:bg-surface-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, icon: Icon, children }) {
  return (
    <div>
      <div className="text-xs font-semibold text-surface-500 uppercase tracking-wide flex items-center gap-1 mb-1">
        {Icon && <Icon size={11} aria-hidden="true" />}
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

function DiffViewer({ oldValue, newValue }) {
  const hasOld = oldValue !== null && oldValue !== undefined && String(oldValue).trim() !== ''
  const hasNew = newValue !== null && newValue !== undefined && String(newValue).trim() !== ''

  if (!hasOld && !hasNew) {
    return <div className="text-surface-500 italic text-xs">No before/after values recorded.</div>
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div>
        <div className="text-xs font-medium text-red-700 mb-1">Before</div>
        <pre className="whitespace-pre-wrap break-words text-sm bg-red-50 border border-red-200 rounded-md p-2 min-h-[2.5rem] font-sans">
          {hasOld ? String(oldValue) : <span className="italic text-red-400">(empty)</span>}
        </pre>
      </div>
      <div>
        <div className="text-xs font-medium text-green-700 mb-1">After</div>
        <pre className="whitespace-pre-wrap break-words text-sm bg-green-50 border border-green-200 rounded-md p-2 min-h-[2.5rem] font-sans">
          {hasNew ? String(newValue) : <span className="italic text-green-500">(empty)</span>}
        </pre>
      </div>
    </div>
  )
}
