/**
 * RICT CMMS — Request History Page
 *
 * Unified view of all student requests across 4 types:
 *   - Lab Change Requests (post-deadline lab signup changes)
 *   - Time Entry Requests (new/edit time clock entries)
 *   - Temp Access Requests (role or permission grants)
 *   - Work Order Requests (student-submitted WOs)
 *
 * Instructors see all requests with full filtering.
 * Students see only their own requests (read-only).
 *
 * Features:
 *   - Semester dropdown (defaults to current, filters at query level)
 *   - Summary cards with counts per type
 *   - Filterable by student, type, status
 *   - Expandable detail rows with full request info
 *   - Clickable links back to source pages
 *   - Notification status indicator (email sent on rejection)
 *   - Excel export
 *   - WCAG 2.1 AA compliant
 *
 * File: src/pages/RequestHistoryPage.jsx
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useRequestHistory, useRequestStats, useSemesters } from '@/hooks/useRequestHistory'
import {
  Search, Filter, ChevronDown, ChevronUp, ChevronRight,
  Download, RefreshCcw, Loader2, Mail, MailX,
  FlaskConical, Clock, KeyRound, ClipboardList,
  ExternalLink, X, Inbox, Calendar,
} from 'lucide-react'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return '—' }
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '—' }
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  try {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 7) return `${days}d ago`
    return formatDateShort(dateStr)
  } catch { return '' }
}

const TYPE_ICONS = {
  'Lab Change': FlaskConical,
  'Time Entry': Clock,
  'Temp Access': KeyRound,
  'Work Order': ClipboardList,
}

const STATUS_STYLES = {
  Approved: { bg: '#d3f9d8', color: '#2b8a3e', label: 'Approved' },
  Rejected: { bg: '#ffe3e3', color: '#c92a2a', label: 'Rejected' },
  Pending:  { bg: '#fff3bf', color: '#e67700', label: 'Pending' },
  Active:   { bg: '#d3f9d8', color: '#2b8a3e', label: 'Active' },
  Revoked:  { bg: '#e9ecef', color: '#495057', label: 'Revoked' },
  Expired:  { bg: '#e9ecef', color: '#868e96', label: 'Expired' },
}

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || { bg: '#e9ecef', color: '#495057', label: status }
  return (
    <span
      role="status"
      aria-label={`Status: ${s.label}`}
      style={{
        display: 'inline-block', padding: '2px 10px', borderRadius: 20,
        fontSize: '0.72rem', fontWeight: 600,
        background: s.bg, color: s.color,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  )
}

function TypeBadge({ type, typeColor, typeBg }) {
  const Icon = TYPE_ICONS[type] || ClipboardList
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 10px', borderRadius: 20,
        fontSize: '0.72rem', fontWeight: 600,
        background: typeBg, color: typeColor,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={12} />
      {type}
    </span>
  )
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, icon: Icon, total, approved, rejected, pending, color, bg }) {
  return (
    <div
      className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 flex-1 min-w-[160px]"
      role="region"
      aria-label={`${label} summary`}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: bg }}
        >
          <Icon size={16} style={{ color }} />
        </div>
        <span className="text-sm font-semibold text-surface-700">{label}</span>
      </div>
      <div className="text-2xl font-bold text-surface-900 mb-1">{total}</div>
      <div className="flex items-center gap-3 text-xs text-surface-500">
        <span style={{ color: '#2b8a3e' }}>{approved} approved</span>
        <span style={{ color: '#c92a2a' }}>{rejected} rejected</span>
        {pending > 0 && <span style={{ color: '#e67700' }}>{pending} pending</span>}
      </div>
    </div>
  )
}

// ─── Expanded Detail Panel ────────────────────────────────────────────────────

function DetailPanel({ request, emailSent }) {
  const { details, type, reason, rejectionReason, reviewedBy, reviewDate, sourceLink, sourceLinkLabel } = request
  const navigate = useNavigate()

  return (
    <div
      className="bg-surface-50 border-t border-surface-100 px-5 py-4"
      role="region"
      aria-label={`Details for request ${request.id}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {/* Left column — request details */}
        <div className="space-y-3">
          <div>
            <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Reason</span>
            <p className="text-surface-700 mt-0.5 leading-relaxed">{reason || '—'}</p>
          </div>

          {/* Type-specific details */}
          {type === 'Lab Change' && details && (
            <>
              <div className="flex gap-6">
                <div>
                  <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Course</span>
                  <p className="text-surface-700 mt-0.5">{details.courseId || '—'}</p>
                </div>
                <div>
                  <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Week</span>
                  <p className="text-surface-700 mt-0.5">{details.weekStart || '—'}</p>
                </div>
              </div>
              {details.cancelling?.length > 0 && (
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#c92a2a' }}>
                    Cancelling ({details.cancelling.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {details.cancelling.map((s, i) => (
                      <span key={i} style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
                        background: '#ffe3e3', color: '#c92a2a', textDecoration: 'line-through',
                      }}>{s}</span>
                    ))}
                  </div>
                </div>
              )}
              {details.adding?.length > 0 && (
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#2b8a3e' }}>
                    Adding ({details.adding.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {details.adding.map((s, i) => (
                      <span key={i} style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
                        background: '#d3f9d8', color: '#2b8a3e',
                      }}>{s}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {type === 'Time Entry' && details && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Type</span>
                <p className="text-surface-700 mt-0.5">{details.entryType || '—'}</p>
              </div>
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Course</span>
                <p className="text-surface-700 mt-0.5">{details.courseId || '—'}</p>
              </div>
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Date</span>
                <p className="text-surface-700 mt-0.5">{formatDate(details.requestedDate)}</p>
              </div>
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Time</span>
                <p className="text-surface-700 mt-0.5">{details.startTime} – {details.endTime}</p>
              </div>
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Hours</span>
                <p className="text-surface-700 mt-0.5">{Number(details.totalHours || 0).toFixed(2)}h</p>
              </div>
            </div>
          )}

          {type === 'Temp Access' && details && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Request Type</span>
                <p className="text-surface-700 mt-0.5 capitalize">{details.requestType}</p>
              </div>
              {details.requestType !== 'permissions' && (
                <>
                  <div>
                    <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Requested Role</span>
                    <p className="text-surface-700 mt-0.5">{details.requestedRole || '—'}</p>
                  </div>
                  {details.approvedRole && (
                    <div>
                      <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Approved Role</span>
                      <p className="text-surface-700 mt-0.5">{details.approvedRole}</p>
                    </div>
                  )}
                </>
              )}
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Duration</span>
                <p className="text-surface-700 mt-0.5">{details.daysRequested} day{details.daysRequested !== 1 ? 's' : ''} requested</p>
              </div>
              {details.expiryDate && (
                <div>
                  <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Expiry</span>
                  <p className="text-surface-700 mt-0.5">{formatDate(details.expiryDate)}</p>
                </div>
              )}
              {details.requestType === 'permissions' && details.requestedPermissions?.length > 0 && (
                <div className="w-full">
                  <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Permissions Requested</span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {details.requestedPermissions.map((p, i) => (
                      <span key={i} style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 500,
                        background: '#f3f0ff', color: '#7048e8',
                      }}>
                        {p.page}: {p.feature}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {type === 'Work Order' && details && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Asset</span>
                <p className="text-surface-700 mt-0.5">{details.assetName || '—'} ({details.assetId || '—'})</p>
              </div>
              <div>
                <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Priority</span>
                <p className="text-surface-700 mt-0.5">{details.priority || '—'}</p>
              </div>
              {details.linkedWoId && (
                <div>
                  <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Created WO</span>
                  <p className="text-surface-700 mt-0.5 font-medium" style={{ color: '#228be6' }}>{details.linkedWoId}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right column — review info */}
        <div className="space-y-3">
          {rejectionReason && (
            <div style={{
              background: '#fff5f5', border: '1px solid #ffc9c9', borderRadius: 8,
              padding: '10px 14px',
            }}>
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#c92a2a' }}>
                Rejection Reason
              </span>
              <p className="text-sm mt-0.5 leading-relaxed" style={{ color: '#862e2e' }}>
                {rejectionReason}
              </p>
              {emailSent && (
                <div className="flex items-center gap-1.5 mt-2 text-xs" style={{ color: '#868e96' }}>
                  <Mail size={12} />
                  <span>Rejection email sent</span>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-6">
            <div>
              <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Reviewed By</span>
              <p className="text-surface-700 mt-0.5">{reviewedBy || '—'}</p>
            </div>
            <div>
              <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Review Date</span>
              <p className="text-surface-700 mt-0.5">{formatDate(reviewDate)}</p>
            </div>
          </div>

          <div>
            <span className="text-xs font-semibold text-surface-400 uppercase tracking-wide">Request ID</span>
            <p className="text-surface-700 mt-0.5 font-mono text-xs">{request.id}</p>
          </div>

          {sourceLink && (
            <button
              onClick={() => navigate(sourceLink)}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg
                bg-white border border-surface-200 text-brand-600
                hover:bg-brand-50 hover:border-brand-200
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
                transition-colors"
            >
              <ExternalLink size={12} />
              Go to {sourceLinkLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Export to Excel ───────────────────────────────────────────────────────────

async function exportToExcel(requests, filename) {
  try {
    const XLSX = await import('xlsx')
    const rows = requests.map(r => ({
      'Request ID': r.id,
      'Type': r.type,
      'Student': r.studentName,
      'Email': r.studentEmail,
      'Summary': r.summary,
      'Reason': r.reason,
      'Status': r.status,
      'Reviewed By': r.reviewedBy,
      'Review Date': formatDate(r.reviewDate),
      'Rejection Reason': r.rejectionReason,
      'Submitted': formatDate(r.submittedDate),
    }))

    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Request History')

    const colWidths = Object.keys(rows[0] || {}).map(key => ({
      wch: Math.max(key.length, ...rows.map(r => String(r[key] || '').length).slice(0, 50)) + 2
    }))
    ws['!cols'] = colWidths

    XLSX.writeFile(wb, filename || 'Request_History.xlsx')
  } catch (err) {
    console.error('Export error:', err)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

const SEMESTER_CUSTOM = '__custom__'
const SEMESTER_ALL = '__all__'

export default function RequestHistoryPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Request History')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // ── Semester state ──────────────────────────────────────────────────────────
  const { semesters, currentSemester, loading: semLoading } = useSemesters()
  const [selectedSemesterLabel, setSelectedSemesterLabel] = useState(null) // null = waiting for semesters to load

  // Once semesters load, default to current semester (never "All Time")
  useEffect(() => {
    if (!semLoading && selectedSemesterLabel === null) {
      if (currentSemester) {
        setSelectedSemesterLabel(currentSemester.label)
      } else if (semesters.length > 0) {
        // No current semester found — default to most recent
        setSelectedSemesterLabel(semesters[0].label)
      } else {
        // Truly no semesters at all (shouldn't happen with synthetic fallback) — show all
        setSelectedSemesterLabel(SEMESTER_ALL)
      }
    }
  }, [semLoading, currentSemester, semesters, selectedSemesterLabel])

  // Custom date range (only used when "Custom Range" is selected)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  // Derive the actual dateFrom/dateTo passed to the hook
  const { dateFrom, dateTo } = useMemo(() => {
    if (selectedSemesterLabel === SEMESTER_ALL) return { dateFrom: null, dateTo: null }
    if (selectedSemesterLabel === SEMESTER_CUSTOM) return { dateFrom: customFrom || null, dateTo: customTo || null }
    const sem = semesters.find(s => s.label === selectedSemesterLabel)
    if (sem) return { dateFrom: sem.startDate, dateTo: sem.endDate }
    return { dateFrom: null, dateTo: null }
  }, [selectedSemesterLabel, semesters, customFrom, customTo])

  // ── Request data (filtered at query level by date range) ────────────────────
  const { allRequests, loading, refresh, isInstructor, emailSentMap } = useRequestHistory({ dateFrom, dateTo })

  // ── Client-side filters ─────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [expandedId, setExpandedId] = useState(null)
  const [sortField, setSortField] = useState('submittedDate')
  const [sortDir, setSortDir] = useState('desc')

  // Pre-fill student filter from URL params (e.g. from Users page link)
  useEffect(() => {
    const studentParam = searchParams.get('student')
    if (studentParam) setSearch(studentParam)
  }, [searchParams])

  // ── Filtered + Sorted list ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = allRequests

    if (search.trim()) {
      const s = search.toLowerCase()
      list = list.filter(r =>
        r.studentName.toLowerCase().includes(s) ||
        r.studentEmail.toLowerCase().includes(s) ||
        r.id.toLowerCase().includes(s) ||
        r.summary.toLowerCase().includes(s) ||
        r.reason.toLowerCase().includes(s)
      )
    }

    if (typeFilter !== 'All') list = list.filter(r => r.type === typeFilter)
    if (statusFilter !== 'All') list = list.filter(r => r.status === statusFilter)

    // Sort
    list = [...list].sort((a, b) => {
      let aVal = a[sortField] || ''
      let bVal = b[sortField] || ''

      if (sortField === 'submittedDate' || sortField === 'reviewDate') {
        aVal = aVal ? new Date(aVal).getTime() : 0
        bVal = bVal ? new Date(bVal).getTime() : 0
      } else {
        aVal = String(aVal).toLowerCase()
        bVal = String(bVal).toLowerCase()
      }

      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1
      return 0
    })

    return list
  }, [allRequests, search, typeFilter, statusFilter, sortField, sortDir])

  const stats = useRequestStats(filtered)

  const handleSort = useCallback((field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }, [sortField])

  const hasFilters = search || typeFilter !== 'All' || statusFilter !== 'All'
  const clearFilters = () => { setSearch(''); setTypeFilter('All'); setStatusFilter('All') }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ChevronDown size={12} className="text-surface-300" />
    return sortDir === 'asc'
      ? <ChevronUp size={12} className="text-brand-600" />
      : <ChevronDown size={12} className="text-brand-600" />
  }

  const allStatuses = useMemo(() => {
    const set = new Set(allRequests.map(r => r.status))
    return ['All', ...Array.from(set).sort()]
  }, [allRequests])

  // ── Loading state ───────────────────────────────────────────────────────────
  if (semLoading || selectedSemesterLabel === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-brand-600" />
        <span className="ml-2 text-surface-500 text-sm">Loading…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-surface-900">
            {isInstructor ? 'Request History' : 'My Requests'}
          </h1>
          <p className="text-sm text-surface-500 mt-0.5">
            {isInstructor
              ? 'Review all student requests across lab changes, time entries, temp access, and work orders.'
              : 'View the status of your submitted requests.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Semester selector */}
          <div className="flex items-center gap-1.5">
            <Calendar size={14} className="text-surface-400" aria-hidden="true" />
            <select
              value={selectedSemesterLabel || ''}
              onChange={(e) => setSelectedSemesterLabel(e.target.value)}
              className="px-3 py-2 text-sm font-medium border border-surface-200 rounded-lg bg-white
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                text-surface-700"
              aria-label="Select semester"
            >
              {semesters.map(s => (
                <option key={s.label} value={s.label}>
                  {s.label}
                  {currentSemester && s.label === currentSemester.label ? ' (Current)' : ''}
                </option>
              ))}
              <option value={SEMESTER_ALL}>All Time</option>
              <option value={SEMESTER_CUSTOM}>Custom Range…</option>
            </select>
          </div>

          <button
            onClick={() => exportToExcel(filtered, `Request_History_${new Date().toISOString().substring(0, 10)}.xlsx`)}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium
              bg-white text-surface-600 border border-surface-200 rounded-lg
              hover:bg-surface-50 disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
              transition-colors"
            aria-label="Export filtered results to Excel"
          >
            <Download size={14} />
            Export
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium
              bg-white text-surface-600 border border-surface-200 rounded-lg
              hover:bg-surface-50 disabled:opacity-50
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
              transition-colors"
            aria-label="Refresh request history"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            Refresh
          </button>
        </div>
      </div>

      {/* ── Custom Date Range (only when "Custom Range" selected) ── */}
      {selectedSemesterLabel === SEMESTER_CUSTOM && (
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[150px]">
            <label htmlFor="rh-from" className="block text-xs font-medium text-surface-500 mb-1">From</label>
            <input
              id="rh-from"
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            />
          </div>
          <div className="min-w-[150px]">
            <label htmlFor="rh-to" className="block text-xs font-medium text-surface-500 mb-1">To</label>
            <input
              id="rh-to"
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            />
          </div>
          {(customFrom || customTo) && (
            <button
              onClick={() => { setCustomFrom(''); setCustomTo('') }}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium
                text-surface-500 hover:text-surface-700 rounded-lg hover:bg-surface-100
                transition-colors"
              aria-label="Clear custom date range"
            >
              <X size={14} /> Clear dates
            </button>
          )}
        </div>
      )}

      {/* ── Summary Cards ── */}
      <div className="flex flex-wrap gap-3" role="region" aria-label="Request statistics">
        <SummaryCard
          label="Lab Changes" icon={FlaskConical}
          color="#e67700" bg="#fff9db"
          {...stats.byType['Lab Change']}
        />
        <SummaryCard
          label="Time Entries" icon={Clock}
          color="#7048e8" bg="#f3f0ff"
          {...stats.byType['Time Entry']}
        />
        <SummaryCard
          label="Temp Access" icon={KeyRound}
          color="#1971c2" bg="#e7f5ff"
          {...stats.byType['Temp Access']}
        />
        <SummaryCard
          label="Work Orders" icon={ClipboardList}
          color="#2f9e44" bg="#ebfbee"
          {...stats.byType['Work Order']}
        />
      </div>

      {/* ── Filter Bar ── */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="rh-search" className="block text-xs font-medium text-surface-500 mb-1">
              {isInstructor ? 'Search student, ID, or reason' : 'Search request ID or reason'}
            </label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input
                id="rh-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={isInstructor ? 'Student name, email, or request ID…' : 'Request ID or keyword…'}
                className="w-full pl-9 pr-3 py-2 text-sm border border-surface-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                  placeholder:text-surface-400"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-surface-400 hover:text-surface-600"
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Type filter */}
          <div className="min-w-[140px]">
            <label htmlFor="rh-type" className="block text-xs font-medium text-surface-500 mb-1">Type</label>
            <select
              id="rh-type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg bg-white
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            >
              <option value="All">All Types</option>
              <option value="Lab Change">Lab Changes</option>
              <option value="Time Entry">Time Entries</option>
              <option value="Temp Access">Temp Access</option>
              <option value="Work Order">Work Orders</option>
            </select>
          </div>

          {/* Status filter */}
          <div className="min-w-[130px]">
            <label htmlFor="rh-status" className="block text-xs font-medium text-surface-500 mb-1">Status</label>
            <select
              id="rh-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg bg-white
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            >
              {allStatuses.map(s => (
                <option key={s} value={s}>{s === 'All' ? 'All Statuses' : s}</option>
              ))}
            </select>
          </div>

          {/* Clear filters */}
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium
                text-surface-500 hover:text-surface-700 rounded-lg hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                transition-colors"
              aria-label="Clear all filters"
            >
              <X size={14} /> Clear
            </button>
          )}
        </div>

        {/* Result count */}
        <div className="mt-3 text-xs text-surface-400">
          Showing {filtered.length} of {allRequests.length} request{allRequests.length !== 1 ? 's' : ''}
          {hasFilters && ' (filtered)'}
          {selectedSemesterLabel && selectedSemesterLabel !== SEMESTER_ALL && selectedSemesterLabel !== SEMESTER_CUSTOM && (
            <span className="ml-1">· {selectedSemesterLabel}</span>
          )}
          {loading && <Loader2 size={12} className="inline ml-2 animate-spin" />}
        </div>
      </div>

      {/* ── Results Table ── */}
      {filtered.length === 0 && !loading ? (
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-12">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-surface-100 flex items-center justify-center mx-auto mb-3">
              <Inbox size={20} className="text-surface-400" />
            </div>
            <p className="text-sm font-medium text-surface-700">
              {hasFilters ? 'No requests match your filters' : 'No requests found for this period'}
            </p>
            <p className="text-xs text-surface-400 mt-1">
              {hasFilters
                ? 'Try adjusting your search or filters.'
                : 'Try selecting a different semester or use "All Time".'}
            </p>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="mt-3 text-xs text-brand-600 hover:text-brand-700 font-medium
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Clear all filters
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" role="grid" aria-label="Request history table">
              <thead className="bg-surface-50 border-b border-surface-200">
                <tr>
                  <th scope="col" className="w-10 px-2 py-2.5"><span className="sr-only">Expand</span></th>

                  <th
                    scope="col"
                    className="px-3 py-2.5 text-left text-xs font-semibold text-surface-600 cursor-pointer select-none hover:text-surface-900"
                    onClick={() => handleSort('submittedDate')}
                    aria-sort={sortField === 'submittedDate' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <span className="inline-flex items-center gap-1">Date <SortIcon field="submittedDate" /></span>
                  </th>

                  {isInstructor && (
                    <th
                      scope="col"
                      className="px-3 py-2.5 text-left text-xs font-semibold text-surface-600 cursor-pointer select-none hover:text-surface-900"
                      onClick={() => handleSort('studentName')}
                      aria-sort={sortField === 'studentName' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <span className="inline-flex items-center gap-1">Student <SortIcon field="studentName" /></span>
                    </th>
                  )}

                  <th
                    scope="col"
                    className="px-3 py-2.5 text-left text-xs font-semibold text-surface-600 cursor-pointer select-none hover:text-surface-900"
                    onClick={() => handleSort('type')}
                    aria-sort={sortField === 'type' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <span className="inline-flex items-center gap-1">Type <SortIcon field="type" /></span>
                  </th>

                  <th scope="col" className="px-3 py-2.5 text-left text-xs font-semibold text-surface-600">Summary</th>

                  <th
                    scope="col"
                    className="px-3 py-2.5 text-left text-xs font-semibold text-surface-600 cursor-pointer select-none hover:text-surface-900"
                    onClick={() => handleSort('status')}
                    aria-sort={sortField === 'status' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <span className="inline-flex items-center gap-1">Status <SortIcon field="status" /></span>
                  </th>

                  {isInstructor && (
                    <th scope="col" className="px-3 py-2.5 text-left text-xs font-semibold text-surface-600">Reviewed By</th>
                  )}

                  <th scope="col" className="w-10 px-2 py-2.5 text-center">
                    <span className="sr-only">Notification</span>
                    <Mail size={12} className="inline text-surface-400" aria-hidden="true" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {filtered.map(r => {
                  const isExpanded = expandedId === r.id
                  const emailSent = emailSentMap[r.id]

                  return (
                    <tr key={r.id} className="group" role="row">
                      <td colSpan={isInstructor ? 8 : 6} className="p-0">
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : r.id)}
                          className="w-full text-left hover:bg-surface-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${r.type} request ${r.id} from ${r.studentName}`}
                        >
                          <div className="flex items-center">
                            <div className="w-10 px-2 py-3 flex-shrink-0 flex items-center justify-center">
                              <ChevronRight
                                size={14}
                                className={`text-surface-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                              />
                            </div>

                            <div className="px-3 py-3 min-w-[90px] flex-shrink-0">
                              <div className="text-sm text-surface-700">{formatDateShort(r.submittedDate)}</div>
                              <div className="text-[10px] text-surface-400">{timeAgo(r.submittedDate)}</div>
                            </div>

                            {isInstructor && (
                              <div className="px-3 py-3 min-w-[120px] flex-shrink-0">
                                <div className="text-sm font-medium text-surface-800 truncate max-w-[150px]">{r.studentName}</div>
                                <div className="text-[10px] text-surface-400 truncate max-w-[150px]">{r.studentEmail}</div>
                              </div>
                            )}

                            <div className="px-3 py-3 flex-shrink-0">
                              <TypeBadge type={r.type} typeColor={r.typeColor} typeBg={r.typeBg} />
                            </div>

                            <div className="px-3 py-3 flex-1 min-w-0">
                              <div className="text-sm text-surface-600 truncate">{r.summary}</div>
                              {r.reason && (
                                <div className="text-[11px] text-surface-400 truncate mt-0.5 italic">
                                  &ldquo;{r.reason.length > 80 ? r.reason.substring(0, 80) + '…' : r.reason}&rdquo;
                                </div>
                              )}
                            </div>

                            <div className="px-3 py-3 flex-shrink-0">
                              <StatusBadge status={r.status} />
                            </div>

                            {isInstructor && (
                              <div className="px-3 py-3 min-w-[80px] flex-shrink-0">
                                <div className="text-xs text-surface-500 truncate max-w-[100px]">{r.reviewedBy || '—'}</div>
                              </div>
                            )}

                            <div className="w-10 px-2 py-3 flex-shrink-0 flex items-center justify-center">
                              {r.status === 'Rejected' && emailSent && (
                                <Mail size={13} className="text-red-400" aria-label="Rejection email sent" title="Rejection email sent" />
                              )}
                              {r.status === 'Rejected' && !emailSent && r.rejectionReason && (
                                <MailX size={13} className="text-surface-300" aria-label="No email record found" title="No rejection email record" />
                              )}
                            </div>
                          </div>
                        </button>

                        {isExpanded && (
                          <DetailPanel request={r} emailSent={emailSent} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
