/**
 * RICT CMMS — Asset Checkouts Page
 * Route: /asset-checkouts
 *
 * Dashboard for tracking who has what, when it's due, and full history.
 *
 * Tabs:
 *  - Currently Out  (returned_at IS NULL, not overdue)
 *  - Overdue        (returned_at IS NULL, expected_return < now)
 *  - Recent Returns (returned_at IS NOT NULL, last 30 days)
 *  - All History    (everything)
 *
 * Features:
 *  - Filter by user, asset, date range, class.
 *  - Per-row Check In, Extend Due Date.
 *  - Excel export (SheetJS already installed).
 *  - End-of-semester "Who still has equipment?" printable report (HTML → print to PDF).
 *  - WCAG 2.1 AA: keyboard nav, focus traps via useDialogA11y, semantic table,
 *    ARIA tabs, descriptive labels, status announcements via aria-live.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import {
  useAssetCheckouts,
  useCheckoutActions,
  fakeUtcToDisplay,
  daysOverdue,
  daysUntilDue,
} from '@/hooks/useAssetCheckouts'
import {
  Box,
  Clock,
  AlertTriangle,
  CheckCircle2,
  History,
  Search,
  X,
  Filter,
  Download,
  Printer,
  ArrowLeft,
  RotateCcw,
  CalendarClock,
  User as UserIcon,
  FileText,
  Loader2,
} from 'lucide-react'

const STATUS_PILL = {
  Out:       { bg: '#e7f5ff', fg: '#1971c2', label: 'Out' },
  Overdue:   { bg: '#fff5f5', fg: '#c92a2a', label: 'Overdue' },
  Returned:  { bg: '#d3f9d8', fg: '#2b8a3e', label: 'Returned' },
  Available: { bg: '#f1f3f5', fg: '#495057', label: 'Available' },
}

function StatusPill({ checkout }) {
  let key = 'Returned'
  if (!checkout.returned_at) {
    key = checkout.expected_return && new Date(checkout.expected_return) < new Date() ? 'Overdue' : 'Out'
  }
  const cfg = STATUS_PILL[key] || STATUS_PILL.Returned
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 999,
        fontSize: '0.72rem', fontWeight: 600,
        background: cfg.bg, color: cfg.fg,
      }}
    >
      {key === 'Overdue' && <AlertTriangle size={11} aria-hidden="true" />}
      {key === 'Out' && <Clock size={11} aria-hidden="true" />}
      {key === 'Returned' && <CheckCircle2 size={11} aria-hidden="true" />}
      {cfg.label}
    </span>
  )
}

function fmt(iso) {
  if (!iso) return '—'
  const f = fakeUtcToDisplay(iso)
  return f ? `${f.date}, ${f.time}` : '—'
}

function fmtDate(iso) {
  if (!iso) return '—'
  const f = fakeUtcToDisplay(iso)
  return f ? f.date : '—'
}

export default function AssetCheckoutsPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const { hasPerm } = usePermissions('Asset Checkouts')
  const { checkouts, loading } = useAssetCheckouts()
  const { saving, checkIn, extendDueDate } = useCheckoutActions()

  const isInstructor = hasPerm('view_all') // works for instructor + work-study with view_all
  const myEmail = (profile?.email || '').toLowerCase()

  // ── Tab + filters ────────────────────────────────────────────────────
  const [tab, setTab] = useState('out') // 'out' | 'overdue' | 'recent' | 'all'
  const [search, setSearch] = useState('')
  const [userFilter, setUserFilter] = useState('')

  // Modals
  const [checkInTarget, setCheckInTarget] = useState(null)
  const [extendTarget, setExtendTarget] = useState(null)
  const [showReportModal, setShowReportModal] = useState(false)

  // Build the visible list
  const filtered = useMemo(() => {
    let list = checkouts

    // First, "view own" gating — students/work study without view_all see only their own
    if (!hasPerm('view_all')) {
      list = list.filter(c => (c.user_email || '').toLowerCase() === myEmail)
    }

    // Tab filter
    const now = new Date()
    if (tab === 'out') {
      list = list.filter(c => !c.returned_at && (!c.expected_return || new Date(c.expected_return) >= now))
    } else if (tab === 'overdue') {
      list = list.filter(c => !c.returned_at && c.expected_return && new Date(c.expected_return) < now)
    } else if (tab === 'recent') {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30)
      list = list.filter(c => c.returned_at && new Date(c.returned_at) >= cutoff)
    }
    // 'all' → no extra filter

    // Search
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(c =>
        (c.asset_id || '').toLowerCase().includes(s) ||
        (c.asset_name || '').toLowerCase().includes(s) ||
        (c.user_name || '').toLowerCase().includes(s) ||
        (c.user_email || '').toLowerCase().includes(s) ||
        (c.checkout_id || '').toLowerCase().includes(s) ||
        (c.asset_serial_number || '').toLowerCase().includes(s)
      )
    }

    if (userFilter) {
      list = list.filter(c => (c.user_email || '').toLowerCase() === userFilter.toLowerCase())
    }

    return list
  }, [checkouts, tab, search, userFilter, hasPerm, myEmail])

  // Counts shown on tab pills (computed from the user's own slice if not view_all)
  const counts = useMemo(() => {
    const visible = hasPerm('view_all')
      ? checkouts
      : checkouts.filter(c => (c.user_email || '').toLowerCase() === myEmail)
    const now = new Date()
    const out = visible.filter(c => !c.returned_at && (!c.expected_return || new Date(c.expected_return) >= now)).length
    const overdue = visible.filter(c => !c.returned_at && c.expected_return && new Date(c.expected_return) < now).length
    const recentCutoff = new Date(); recentCutoff.setDate(recentCutoff.getDate() - 30)
    const recent = visible.filter(c => c.returned_at && new Date(c.returned_at) >= recentCutoff).length
    return { out, overdue, recent, all: visible.length }
  }, [checkouts, hasPerm, myEmail])

  // Distinct users for the user dropdown (instructor only)
  const userOptions = useMemo(() => {
    const map = new Map()
    checkouts.forEach(c => {
      if (!c.user_email) return
      if (!map.has(c.user_email)) {
        map.set(c.user_email, { email: c.user_email, name: c.user_name || c.user_email })
      }
    })
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [checkouts])

  /* ── Excel export ────────────────────────────────────────────────── */
  const exportExcel = useCallback(async () => {
    if (!hasPerm('export_data')) return
    try {
      const XLSX = await import('xlsx')
      const rows = filtered.map(c => ({
        'Checkout ID':  c.checkout_id,
        'Asset ID':     c.asset_id,
        'Asset Name':   c.asset_name,
        'Serial #':     c.asset_serial_number || '',
        'User':         c.user_name,
        'Email':        c.user_email,
        'Checked Out':  fmt(c.checked_out_at),
        'Due':          fmtDate(c.expected_return),
        'Returned':     fmt(c.returned_at),
        'Days Overdue': c.returned_at ? '' : (c.expected_return ? Math.max(0, daysOverdue(c.expected_return)) : ''),
        'Out Cond.':    c.checkout_condition || '',
        'Return Cond.': c.return_condition || '',
        'Notes':        c.checkout_notes || '',
        'Return Notes': c.return_notes || '',
        'Issued By':    c.checked_out_by || '',
        'Received By':  c.checked_in_by || '',
        'Acknowledged': c.acknowledgment_name || '',
      }))
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(rows)
      XLSX.utils.book_append_sheet(wb, ws, 'Checkouts')
      const tabLabel = { out: 'Currently_Out', overdue: 'Overdue', recent: 'Recent_Returns', all: 'All_History' }[tab] || 'Checkouts'
      const filename = `RICT_Asset_Checkouts_${tabLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`
      XLSX.writeFile(wb, filename)
    } catch (e) {
      console.error('Excel export error:', e)
      alert('Excel export failed: ' + e.message)
    }
  }, [filtered, tab, hasPerm])

  /* ── Modal a11y refs ─────────────────────────────────────────────── */
  const closeCheckIn = useCallback(() => setCheckInTarget(null), [])
  const closeExtend = useCallback(() => setExtendTarget(null), [])
  const closeReport = useCallback(() => setShowReportModal(false), [])

  const checkInDialogRef = useDialogA11y(!!checkInTarget, closeCheckIn)
  const extendDialogRef = useDialogA11y(!!extendTarget, closeExtend)
  const reportDialogRef = useDialogA11y(showReportModal, closeReport)

  /* ── Material Icons (matches rest of Assets-area pages) ─────────── */
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link')
      link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons'
      link.rel = 'stylesheet'
      document.head.appendChild(link)
    }
  }, [])

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  RENDER                                                             */
  /* ═══════════════════════════════════════════════════════════════════ */

  if (!hasPerm('view_page')) {
    return (
      <div className="p-8 text-center text-surface-500">
        <Box size={36} className="mx-auto mb-3" aria-hidden="true" />
        <p>You don't have permission to view this page.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-surface-900 flex items-center gap-2">
            <Box size={20} className="text-brand-600" aria-hidden="true" />
            Asset Checkouts
          </h1>
          <p className="text-sm text-surface-500 mt-0.5">
            Track who has what, when it's due back, and full history.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {hasPerm('export_data') && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowReportModal(true)}
                aria-label="Generate end-of-semester equipment report"
              >
                <Printer size={14} aria-hidden="true" />
                Equipment Report
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={exportExcel}
                aria-label="Export current view to Excel"
              >
                <Download size={14} aria-hidden="true" />
                Excel
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1 flex-wrap" role="tablist" aria-label="Checkout views">
        {[
          { id: 'out',     label: 'Currently Out', count: counts.out, icon: Clock },
          { id: 'overdue', label: 'Overdue',       count: counts.overdue, icon: AlertTriangle },
          { id: 'recent',  label: 'Recent Returns', count: counts.recent, icon: CheckCircle2 },
          { id: 'all',     label: 'All History',   count: counts.all,    icon: History },
        ].map(({ id, label, count, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              aria-controls={`panel-${id}`}
              id={`tab-${id}`}
              type="button"
              onClick={() => setTab(id)}
              className={[
                'flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 min-w-[140px]',
                active ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700',
              ].join(' ')}
            >
              <Icon size={13} aria-hidden="true" />
              <span>{label}</span>
              {typeof count === 'number' && (
                <span
                  className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold"
                  style={{
                    background: id === 'overdue' && count > 0 ? '#fff5f5' : '#f1f3f5',
                    color:      id === 'overdue' && count > 0 ? '#c92a2a' : '#495057',
                  }}
                  aria-hidden="true"
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Filters ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-surface-200 p-3 flex flex-wrap gap-2 items-center">
        <label className="sr-only" htmlFor="checkout-search">Search checkouts</label>
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" aria-hidden="true" />
          <input
            id="checkout-search"
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by asset, user, ID, serial #…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-surface-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
        </div>
        {hasPerm('view_all') && (
          <>
            <label className="sr-only" htmlFor="checkout-user-filter">Filter by user</label>
            <select
              id="checkout-user-filter"
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className="px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <option value="">All users</option>
              {userOptions.map(u => (
                <option key={u.email} value={u.email}>{u.name}</option>
              ))}
            </select>
          </>
        )}
        {(search || userFilter) && (
          <button
            type="button"
            onClick={() => { setSearch(''); setUserFilter('') }}
            className="btn btn-secondary btn-sm"
            aria-label="Clear filters"
          >
            <X size={12} aria-hidden="true" />
            Clear
          </button>
        )}
      </div>

      {/* ── List ─────────────────────────────────────────────────── */}
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="bg-white rounded-xl border border-surface-200 overflow-hidden"
      >
        {loading ? (
          <div className="flex items-center justify-center p-10" role="status" aria-live="polite">
            <Loader2 size={20} className="animate-spin text-brand-600" aria-hidden="true" />
            <span className="sr-only">Loading checkouts…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center p-10 text-sm text-surface-500">
            <Box size={32} className="mx-auto text-surface-300 mb-3" aria-hidden="true" />
            {tab === 'overdue' ? 'No overdue checkouts. 🎉' :
             tab === 'recent' ? 'No returns in the last 30 days.' :
             tab === 'out' ? 'Nothing currently checked out.' :
             'No checkout history yet.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={`${tab} checkouts`}>
              <caption className="sr-only">{filtered.length} checkout records.</caption>
              <thead className="bg-surface-50 border-b border-surface-200">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Asset</th>
                  <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">User</th>
                  <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Out</th>
                  <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Due</th>
                  <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Status</th>
                  <th scope="col" className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-surface-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const isOut = !c.returned_at
                  const overdueDays = isOut && c.expected_return ? Math.max(0, daysOverdue(c.expected_return)) : 0
                  const dueIn = isOut && c.expected_return ? daysUntilDue(c.expected_return) : null
                  return (
                    <tr
                      key={c.checkout_id}
                      className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50"
                    >
                      <td className="px-3 py-2.5 align-top">
                        <button
                          type="button"
                          onClick={() => navigate(`/assets?focus=${encodeURIComponent(c.asset_id)}`)}
                          className="text-left font-medium text-surface-900 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded"
                          aria-label={`Open asset ${c.asset_name}`}
                          title="Open asset"
                        >
                          {c.asset_name}
                        </button>
                        <div className="text-[11px] text-surface-500 font-mono">
                          {c.asset_id}{c.asset_serial_number ? ` · SN ${c.asset_serial_number}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="font-medium text-surface-800">{c.user_name}</div>
                        <div className="text-[11px] text-surface-500 truncate max-w-[200px]">{c.user_email}</div>
                      </td>
                      <td className="px-3 py-2.5 align-top whitespace-nowrap">
                        <div className="text-surface-700">{fmt(c.checked_out_at)}</div>
                        <div className="text-[11px] text-surface-500">by {c.checked_out_by}</div>
                      </td>
                      <td className="px-3 py-2.5 align-top whitespace-nowrap">
                        {c.expected_return ? (
                          <>
                            <div className="text-surface-700">{fmtDate(c.expected_return)}</div>
                            {isOut && overdueDays > 0 && (
                              <div className="text-[11px] font-semibold" style={{ color: '#c92a2a' }}>
                                {overdueDays} day{overdueDays !== 1 ? 's' : ''} late
                              </div>
                            )}
                            {isOut && overdueDays === 0 && dueIn !== null && dueIn >= 0 && dueIn <= 3 && (
                              <div className="text-[11px] font-medium" style={{ color: '#d97706' }}>
                                Due {dueIn === 0 ? 'today' : `in ${dueIn} day${dueIn !== 1 ? 's' : ''}`}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-surface-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <StatusPill checkout={c} />
                      </td>
                      <td className="px-3 py-2.5 align-top text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          {isOut && hasPerm('checkin_assets') && (
                            <button
                              type="button"
                              onClick={() => setCheckInTarget(c)}
                              className="px-2 py-1 text-[11px] rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                              aria-label={`Check in ${c.asset_name}`}
                            >
                              <RotateCcw size={11} aria-hidden="true" />
                              Check In
                            </button>
                          )}
                          {isOut && hasPerm('extend_due_date') && (
                            <button
                              type="button"
                              onClick={() => setExtendTarget(c)}
                              className="px-2 py-1 text-[11px] rounded-md bg-surface-100 text-surface-700 hover:bg-surface-200 border border-surface-200 inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                              aria-label={`Extend due date for ${c.asset_name}`}
                            >
                              <CalendarClock size={11} aria-hidden="true" />
                              Extend
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Check In Modal ─────────────────────────────────────── */}
      {checkInTarget && (
        <CheckInModal
          dialogRef={checkInDialogRef}
          checkout={checkInTarget}
          saving={saving}
          onClose={closeCheckIn}
          onSubmit={async ({ condition, notes, needsRepair }) => {
            try {
              let relatedWoId = null
              if (needsRepair) {
                relatedWoId = await createRepairWorkOrder({
                  asset: { asset_id: checkInTarget.asset_id, name: checkInTarget.asset_name },
                  notes: notes || `Checkin condition: ${condition || 'Damaged'}`,
                  createdByEmail: profile?.email,
                  createdByName: profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : 'Unknown',
                })
              }
              await checkIn({
                checkoutId: checkInTarget.checkout_id,
                condition,
                notes,
                needsRepair,
                relatedWoId,
              })
              closeCheckIn()
            } catch (e) { /* toast handled in hook */ }
          }}
        />
      )}

      {/* ── Extend Due Date Modal ──────────────────────────────── */}
      {extendTarget && (
        <ExtendModal
          dialogRef={extendDialogRef}
          checkout={extendTarget}
          saving={saving}
          onClose={closeExtend}
          onSubmit={async (newDate) => {
            try {
              await extendDueDate(extendTarget.checkout_id, newDate)
              closeExtend()
            } catch (e) { /* toast in hook */ }
          }}
        />
      )}

      {/* ── End-of-Semester Report Modal ───────────────────────── */}
      {showReportModal && (
        <EquipmentReportModal
          dialogRef={reportDialogRef}
          checkouts={checkouts.filter(c => !c.returned_at)}
          onClose={closeReport}
        />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Helper: create a repair WO when an asset is returned damaged          */
/* ═══════════════════════════════════════════════════════════════════════ */

async function createRepairWorkOrder({ asset, notes, createdByEmail, createdByName }) {
  // Soft-fail: if WO creation fails, we still let the return go through.
  try {
    let woId = null
    try {
      const { data } = await supabase.rpc('get_next_id', { p_type: 'work_order' })
      if (data) woId = data
    } catch {}
    if (!woId) woId = 'WO' + String(Date.now()).slice(-6)

    const row = {
      wo_id:       woId,
      description: `Asset returned damaged — needs repair: ${asset.name}`,
      priority:    'Medium',
      status:      'Open',
      asset_id:    asset.asset_id,
      asset_name:  asset.name,
      asset:       asset.name,
      created_at:  new Date().toISOString(),
      created_by:  createdByName || createdByEmail,
      is_pm:       false,
    }
    const { error } = await supabase.from('work_orders').insert(row)
    if (error) {
      console.warn('Auto-WO creation failed:', error.message)
      return null
    }
    return woId
  } catch (e) {
    console.warn('Auto-WO creation exception:', e.message)
    return null
  }
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Modals                                                                 */
/* ═══════════════════════════════════════════════════════════════════════ */

function CheckInModal({ dialogRef, checkout, saving, onClose, onSubmit }) {
  const [condition, setCondition] = useState('Good')
  const [notes, setNotes] = useState('')
  const [needsRepair, setNeedsRepair] = useState(false)

  // If user marks needs repair, default condition to "Damaged"
  useEffect(() => {
    if (needsRepair && condition === 'Good') setCondition('Damaged')
  }, [needsRepair]) // eslint-disable-line

  const out = fmt(checkout.checked_out_at)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkin-title"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialogRef} className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-surface-200">
          <h2 id="checkin-title" className="font-semibold text-surface-900 flex items-center gap-2">
            <RotateCcw size={16} className="text-emerald-600" aria-hidden="true" />
            Check In Asset
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Close check-in dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <div className="bg-surface-50 rounded-lg p-3 text-xs space-y-1">
            <div><span className="text-surface-500">Asset:</span> <strong>{checkout.asset_name}</strong> <span className="text-surface-400 font-mono">({checkout.asset_id})</span></div>
            <div><span className="text-surface-500">User:</span> {checkout.user_name}</div>
            <div><span className="text-surface-500">Out since:</span> {out}</div>
          </div>

          <div>
            <label htmlFor="ci-condition" className="block text-xs font-medium text-surface-700 mb-1">Return condition</label>
            <select
              id="ci-condition"
              value={condition}
              onChange={e => setCondition(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <option>Good</option>
              <option>Fair</option>
              <option>Poor</option>
              <option>Damaged</option>
            </select>
          </div>

          <div>
            <label htmlFor="ci-notes" className="block text-xs font-medium text-surface-700 mb-1">
              Return notes <span className="text-surface-400">(optional)</span>
            </label>
            <textarea
              id="ci-notes"
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Came back missing power cable"
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            />
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={needsRepair}
              onChange={e => setNeedsRepair(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-surface-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-surface-700">
              Needs repair — auto-create a work order
              <span className="block text-xs text-surface-500 mt-0.5">
                A new Open work order will be created and linked to this asset.
              </span>
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 text-xs rounded-lg border border-surface-300 bg-white hover:bg-surface-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit({ condition, notes, needsRepair })}
            disabled={saving}
            className="px-3 py-2 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            {saving
              ? <><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Saving…</>
              : <><CheckCircle2 size={12} aria-hidden="true" /> Confirm return</>}
          </button>
        </div>
      </div>
    </div>
  )
}

function ExtendModal({ dialogRef, checkout, saving, onClose, onSubmit }) {
  const currentDue = checkout.expected_return ? new Date(checkout.expected_return) : new Date()
  const startStr = (() => {
    const d = currentDue
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const [dateStr, setDateStr] = useState(startStr)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="extend-title"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialogRef} className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-surface-200">
          <h2 id="extend-title" className="font-semibold text-surface-900 flex items-center gap-2">
            <CalendarClock size={16} className="text-brand-600" aria-hidden="true" />
            Extend Due Date
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Close extend dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="bg-surface-50 rounded-lg p-3 text-xs space-y-1">
            <div><span className="text-surface-500">Asset:</span> <strong>{checkout.asset_name}</strong></div>
            <div><span className="text-surface-500">User:</span> {checkout.user_name}</div>
            <div><span className="text-surface-500">Current due:</span> {fmtDate(checkout.expected_return)}</div>
          </div>

          <div>
            <label htmlFor="ex-date" className="block text-xs font-medium text-surface-700 mb-1">New due date</label>
            <input
              id="ex-date"
              type="date"
              value={dateStr}
              onChange={e => setDateStr(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            />
            <p className="text-[11px] text-surface-500 mt-1">Pick a date in the future. Leave the user a courtesy heads-up.</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 text-xs rounded-lg border border-surface-300 bg-white hover:bg-surface-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!dateStr) return
              // Build a Date at end-of-day in local time
              const [y, m, d] = dateStr.split('-').map(Number)
              const newDate = new Date(y, m - 1, d, 23, 59, 0)
              onSubmit(newDate)
            }}
            disabled={saving || !dateStr}
            className="px-3 py-2 text-xs rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {saving
              ? <><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Saving…</>
              : <>Update</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  End-of-Semester Equipment Report (HTML print → PDF)                   */
/* ═══════════════════════════════════════════════════════════════════════ */

function EquipmentReportModal({ dialogRef, checkouts, onClose }) {
  const [reportTitle, setReportTitle] = useState('End of Semester — Outstanding Equipment')
  const [groupBy, setGroupBy] = useState('user') // 'user' | 'asset'

  const totalOut = checkouts.length
  const overdue = checkouts.filter(c => c.expected_return && new Date(c.expected_return) < new Date()).length

  const printReport = () => {
    const groupedHtml = (() => {
      if (groupBy === 'user') {
        const groups = {}
        checkouts.forEach(c => {
          const key = c.user_email || 'unknown'
          if (!groups[key]) groups[key] = { name: c.user_name || c.user_email, email: c.user_email, items: [] }
          groups[key].items.push(c)
        })
        return Object.values(groups)
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
          .map(g => `
            <section class="grp">
              <h3>${escapeHtml(g.name)} <small>${escapeHtml(g.email || '')}</small></h3>
              <table>
                <thead><tr><th>Asset</th><th>ID</th><th>Serial #</th><th>Out</th><th>Due</th><th>Days Out</th></tr></thead>
                <tbody>
                  ${g.items.map(c => itemRow(c)).join('')}
                </tbody>
              </table>
            </section>
          `).join('')
      } else {
        // Group by asset
        return `
          <section class="grp">
            <table>
              <thead><tr><th>Asset</th><th>Serial #</th><th>User</th><th>Email</th><th>Out</th><th>Due</th><th>Days Out</th></tr></thead>
              <tbody>
                ${checkouts
                  .slice()
                  .sort((a, b) => (a.asset_name || '').localeCompare(b.asset_name || ''))
                  .map(c => `
                    <tr ${rowClass(c)}>
                      <td>${escapeHtml(c.asset_name)} <small>(${escapeHtml(c.asset_id)})</small></td>
                      <td class="mono">${escapeHtml(c.asset_serial_number || '—')}</td>
                      <td>${escapeHtml(c.user_name)}</td>
                      <td class="mono">${escapeHtml(c.user_email || '')}</td>
                      <td>${fmt(c.checked_out_at)}</td>
                      <td>${fmtDate(c.expected_return)}</td>
                      <td>${daysOutStr(c)}</td>
                    </tr>
                  `).join('')}
              </tbody>
            </table>
          </section>
        `
      }
    })()

    const css = `
      @page { size: letter; margin: 0.5in; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a2e; margin: 0; }
      h1 { margin: 0 0 4px; font-size: 18px; }
      h3 { margin: 18px 0 6px; font-size: 13px; padding-bottom: 4px; border-bottom: 1px solid #dee2e6; }
      h3 small { font-weight: 400; color: #868e96; font-size: 10px; margin-left: 8px; }
      .meta { color: #495057; font-size: 11px; margin-bottom: 6px; }
      .summary { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 8px 12px; margin: 10px 0 16px; display: flex; gap: 24px; font-size: 11px; }
      .summary strong { font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 4px; }
      th, td { border: 1px solid #dee2e6; padding: 4px 6px; text-align: left; vertical-align: top; }
      th { background: #f1f3f5; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
      tr.late td { background: #fff5f5; }
      tr.late td:first-child { font-weight: 600; }
      .mono { font-family: monospace; font-size: 10px; }
      .signature-block { margin-top: 36px; display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
      .sig-line { border-top: 1px solid #495057; padding-top: 4px; font-size: 10px; color: #495057; }
      @media print { .no-print { display: none; } }
    `

    const win = window.open('', '_blank')
    win.document.write(`
      <!doctype html><html><head><title>${escapeHtml(reportTitle)}</title>
      <style>${css}</style></head><body>
        <h1>${escapeHtml(reportTitle)}</h1>
        <div class="meta">RICT Program · Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
        <div class="summary">
          <div><strong>${totalOut}</strong> item${totalOut !== 1 ? 's' : ''} still out</div>
          <div><strong style="color:${overdue > 0 ? '#c92a2a' : '#2b8a3e'}">${overdue}</strong> overdue</div>
        </div>
        ${groupedHtml}
        <div class="signature-block">
          <div><div class="sig-line">Instructor signature / date</div></div>
          <div><div class="sig-line">Confirmed by / date</div></div>
        </div>
      </body></html>
    `)
    win.document.close()
    setTimeout(() => win.print(), 400)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialogRef} className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-surface-200">
          <h2 id="report-title" className="font-semibold text-surface-900 flex items-center gap-2">
            <FileText size={16} className="text-brand-600" aria-hidden="true" />
            Outstanding Equipment Report
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Close report dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm text-surface-600">
            Generates a printable list of every asset currently checked out — useful at end of semester for "Who still has equipment?" reconciliation. Use your browser's <strong>Save as PDF</strong> in the print dialog.
          </p>

          <div>
            <label htmlFor="rpt-title" className="block text-xs font-medium text-surface-700 mb-1">Report title</label>
            <input
              id="rpt-title"
              type="text"
              value={reportTitle}
              onChange={e => setReportTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            />
          </div>

          <fieldset>
            <legend className="block text-xs font-medium text-surface-700 mb-1">Group by</legend>
            <div className="flex gap-2">
              {[
                { id: 'user', label: 'User', desc: 'Best for end-of-semester' },
                { id: 'asset', label: 'Asset', desc: 'Single sortable list' },
              ].map(opt => (
                <label
                  key={opt.id}
                  className={[
                    'flex-1 cursor-pointer rounded-lg border-2 p-3 transition-colors',
                    groupBy === opt.id ? 'border-brand-600 bg-brand-50' : 'border-surface-200 hover:border-surface-300',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="group-by"
                    className="sr-only"
                    checked={groupBy === opt.id}
                    onChange={() => setGroupBy(opt.id)}
                  />
                  <div className="text-sm font-medium text-surface-900">{opt.label}</div>
                  <div className="text-[11px] text-surface-500">{opt.desc}</div>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="bg-surface-50 rounded-lg p-3 text-xs flex justify-between">
            <span><strong>{totalOut}</strong> item{totalOut !== 1 ? 's' : ''} will be included</span>
            <span style={{ color: overdue > 0 ? '#c92a2a' : '#2b8a3e' }}>
              <strong>{overdue}</strong> overdue
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs rounded-lg border border-surface-300 bg-white hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={printReport}
            disabled={totalOut === 0}
            className="px-3 py-2 text-xs rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Printer size={12} aria-hidden="true" />
            Generate &amp; Print
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Report row helpers ─────────────────────────────────────────────── */

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function daysOutStr(c) {
  if (!c.checked_out_at) return '—'
  const out = new Date(c.checked_out_at)
  const days = Math.floor((Date.now() - out.getTime()) / (1000 * 60 * 60 * 24))
  return `${days} day${days !== 1 ? 's' : ''}`
}

function rowClass(c) {
  if (c.expected_return && new Date(c.expected_return) < new Date()) return 'class="late"'
  return ''
}

function itemRow(c) {
  return `
    <tr ${rowClass(c)}>
      <td>${escapeHtml(c.asset_name)}</td>
      <td class="mono">${escapeHtml(c.asset_id)}</td>
      <td class="mono">${escapeHtml(c.asset_serial_number || '—')}</td>
      <td>${fmt(c.checked_out_at)}</td>
      <td>${fmtDate(c.expected_return)}</td>
      <td>${daysOutStr(c)}</td>
    </tr>
  `
}
