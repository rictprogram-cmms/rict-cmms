import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { vendorsMatch } from '@/lib/budgetImport'
import {
  useBudgetOverview, useBudgetTransactions, useBudgetActions,
  useBudgetYearSummary, useSpreadsheetImport, getCurrentSchoolYear,
  OBJECT_CODES, PAYMENT_STATUSES, getPaymentStatusColor,
  objectCodeToCategory,
} from '@/hooks/useProgramBudget'
import {
  DollarSign, TrendingUp, TrendingDown, PieChart, BarChart3,
  Plus, Search, Filter, Edit3, Trash2, X, Loader2, Save,
  Calendar, Receipt, CreditCard, ShoppingCart, ChevronDown,
  ArrowUpCircle, ArrowDownCircle, Clock, RefreshCw, AlertCircle,
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, FileText,
  Hash, ChevronsUpDown, Eye, EyeOff, HelpCircle, ArrowRight,
  Check, Ban, ChevronUp, Link2, Unlink
} from 'lucide-react'
import toast from 'react-hot-toast'
import ConfirmDialog from '@/components/ConfirmDialog'

const ENTRY_TYPES = ['Manual Expense', 'Income/Grant', 'Adjustment']
const CATEGORIES = ['Supplies', 'Equipment', 'Materials', 'Software', 'Services', 'Travel', 'Training', 'Maintenance', 'Other']
const CATEGORY_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#14b8a6', '#64748b',
]

function fmt(n) { return '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function ProgramBudgetPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading, isSuperAdmin } = usePermissions('Program Budget')
  // Linking orders and release requests: same people who can approve POs
  const { hasPerm: hasPoPerm, permsLoading: poPermsLoading } = usePermissions('Purchase Orders')
  const [tab, setTab] = useState('overview')
  const [schoolYear, setSchoolYear] = useState(getCurrentSchoolYear())
  const [refreshKey, setRefreshKey] = useState(0)
  const triggerRefresh = () => setRefreshKey(k => k + 1)

  // Instructors get the same full access as super admin
  const isInstructor = profile?.role?.toLowerCase() === 'instructor'
  const hasFullAccess = isSuperAdmin || isInstructor

  if (permsLoading || poPermsLoading) {
    return (
      <div className="p-6 text-center py-20" role="status">
        <Loader2 size={24} className="mx-auto mb-3 text-surface-400 animate-spin" aria-hidden="true" />
        <p className="text-sm text-surface-500">Loading...</p>
      </div>
    )
  }

  // Full access users always see the page; others check permission
  if (!hasFullAccess && !hasPerm('view_page')) {
    return (
      <div className="p-6 text-center py-20">
        <DollarSign size={40} className="mx-auto mb-3 text-surface-300" aria-hidden="true" />
        <p className="text-sm text-surface-500">You do not have permission to access Program Budget.</p>
      </div>
    )
  }

  // Helper: full access users bypass permission checks
  const can = (feature) => hasFullAccess || hasPerm(feature)
  const canManageLedger = hasFullAccess || hasPoPerm('approve_po')

  // Build tabs based on permissions
  const tabs = [
    { id: 'overview', label: 'Overview', icon: PieChart },
    ...(can('view_transactions') ? [{ id: 'transactions', label: 'Transactions', icon: Receipt }] : []),
    ...(can('add_entries') ? [{ id: 'add', label: 'Add Entry', icon: Plus }] : []),
    ...(can('import_data') ? [{ id: 'import', label: 'Import', icon: Upload }] : []),
    ...(can('manage_years') ? [{ id: 'years', label: 'Year Mgmt', icon: Calendar }] : []),
  ]

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">
      <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
        <DollarSign size={20} className="text-brand-600" aria-hidden="true" /> Program Budget
      </h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1">
        {tabs.map(t => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-2 min-h-[44px] rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
              tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
            }`}>
            <t.icon size={14} aria-hidden="true" /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab schoolYear={schoolYear} setSchoolYear={setSchoolYear} refreshKey={refreshKey} canManage={canManageLedger} />}
      {tab === 'transactions' && (
        <TransactionsTab
          schoolYear={schoolYear}
          refreshKey={refreshKey}
          onRefresh={triggerRefresh}
          canEdit={can('edit_entries')}
          canDelete={can('delete_entries')}
          canManage={canManageLedger}
          isSuperAdmin={isSuperAdmin}
        />
      )}
      {tab === 'add' && <AddEntryTab schoolYear={schoolYear} onAdded={triggerRefresh} />}
      {tab === 'import' && <ImportTab schoolYear={schoolYear} onImported={triggerRefresh} onViewOverview={() => setTab('overview')} />}
      {tab === 'years' && <YearManagementTab onRefresh={triggerRefresh} refreshKey={refreshKey} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ═══════════════════════════════════════════════════════════════════════════════

function fmtEntryDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { timeZone: 'UTC' })
}
function fmtLocalDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US')
}
function refLabel(ref) {
  if (!ref) return ''
  if (/^\d{4,}$/.test(ref)) return `PO# ${ref}`
  if (ref.toLowerCase() === 'cc') return 'Credit Card'
  return ref
}

function OverviewTab({ schoolYear, setSchoolYear, refreshKey, canManage }) {
  const { overview, availableYears, loading, loadError, refresh } = useBudgetOverview(schoolYear)
  const actions = useBudgetActions()
  const [releaseTarget, setReleaseTarget] = useState(null)   // open encumbrance row
  const [cancelTarget, setCancelTarget] = useState(null)     // open encumbrance row
  const [linkTarget, setLinkTarget] = useState(null)         // committed order row
  const [showRequested, setShowRequested] = useState(false)
  const [liveMsg, setLiveMsg] = useState('')

  // re-fetch when refreshKey changes
  useEffect(() => { refresh() }, [refreshKey])

  if (loading) {
    return (
      <div className="text-center py-16" role="status">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" aria-hidden="true" />
        <p className="text-sm text-surface-400">Loading budget overview…</p>
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="text-center py-12 text-sm text-surface-500" role="alert">
        {loadError ? `Could not load the budget: ${loadError}` : 'No data available'}
      </div>
    )
  }

  const o = overview
  const availColor = o.availableAfterEnc < 0 ? 'text-red-600' : o.percentUsed > 90 ? 'text-amber-600' : 'text-emerald-600'
  const barColor = o.percentUsed > 100 ? 'bg-red-500' : o.percentUsed > 90 ? 'bg-amber-500' : 'bg-emerald-500'
  const additions = o.income + o.adjustments

  // Category chart data
  const catEntries = Object.entries(o.categoryTotals).sort((a, b) => b[1] - a[1])
  const maxCat = catEntries.length > 0 ? catEntries[0][1] : 1

  // Monthly chart data
  const maxMonth = Math.max(...(o.monthlyTrend || []).map(m => m.amount), 1)

  const saveRelease = async (values) => {
    const ok = await actions.requestRelease(releaseTarget.id, values)
    if (ok) {
      setLiveMsg(`Release of ${fmt(values.amount)} requested for ${releaseTarget.description}.`)
      setReleaseTarget(null)
      refresh()
    }
  }
  const runCancelRelease = async () => {
    const t = cancelTarget
    setCancelTarget(null)
    if (!t) return
    const ok = await actions.cancelRelease(t.id)
    if (ok) { setLiveMsg(`Release request cancelled for ${t.description}.`); refresh() }
  }
  const saveLink = async (lineId) => {
    const ok = await actions.linkOrders(lineId, [linkTarget.orderId])
    if (ok) {
      const line = o.collegeLines.find(l => l.id === lineId)
      setLiveMsg(`${linkTarget.orderId} linked to ${line ? `${line.description} ${refLabel(line.reference)}` : 'the college line'}.`)
      setLinkTarget(null)
      refresh()
    }
  }

  return (
    <div className="space-y-4">
      <p className="sr-only" aria-live="polite" role="status">{liveMsg}</p>

      {releaseTarget && (
        <ReleaseDialog target={releaseTarget} saving={actions.saving}
          onSave={saveRelease} onClose={() => setReleaseTarget(null)} />
      )}
      {linkTarget && (
        <LinkOrderDialog order={linkTarget} lines={o.collegeLines} saving={actions.saving}
          onSave={saveLink} onClose={() => setLinkTarget(null)} />
      )}
      <ConfirmDialog
        open={!!cancelTarget}
        title="Cancel this release request?"
        message={cancelTarget ? `The release request for ${cancelTarget.description} ${refLabel(cancelTarget.reference)} (${fmt(cancelTarget.releaseAmount)}) will be removed. The encumbrance itself is not changed.` : ''}
        confirmLabel="Cancel request"
        cancelLabel="Keep request"
        onConfirm={runCancelRelease}
        onClose={() => setCancelTarget(null)}
      />

      {/* Hero Card */}
      <div className="bg-white rounded-2xl border border-surface-200 p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <label htmlFor="pb-fld-school-year-1" className="text-xs text-surface-500 font-medium">School Year</label>
          <select id="pb-fld-school-year-1" value={schoolYear} onChange={e => setSchoolYear(e.target.value)}
            className="bg-surface-50 text-surface-900 border border-surface-200 rounded-lg px-3 py-1.5 text-sm font-medium min-h-[44px]">
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* The two numbers that matter */}
        <div className="grid sm:grid-cols-2 gap-4 mb-5">
          <div className="rounded-xl border border-surface-200 p-4">
            <div className="text-[11px] uppercase tracking-wider text-surface-500 font-semibold">Available — counting encumbrances</div>
            <div className={`text-2xl font-bold mt-1 ${availColor}`}>{fmt(o.availableAfterEnc)}</div>
            <p className="text-[11px] text-surface-500 mt-1">
              What you can spend today. Matches the college&rsquo;s Present Balance, less CMMS orders not on the report yet.
            </p>
          </div>
          <div className="rounded-xl border border-surface-200 p-4">
            <div className="text-[11px] uppercase tracking-wider text-surface-500 font-semibold">Available — not counting encumbrances</div>
            <div className={`text-2xl font-bold mt-1 ${o.availableBeforeEnc < 0 ? 'text-red-600' : 'text-surface-900'}`}>{fmt(o.availableBeforeEnc)}</div>
            <p className="text-[11px] text-surface-500 mt-1">
              If every open encumbrance ({fmt(o.encumberedOpen)}) were released.
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-[11px] text-surface-500 mb-1">
            <span>{o.percentUsed}% of budget used or committed</span>
            <span>{fmt(o.totalBudget)}</span>
          </div>
          <div className="h-2.5 bg-surface-100 rounded-full overflow-hidden" role="progressbar"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(o.percentUsed, 100)}
            aria-label={`${o.percentUsed}% of the ${schoolYear} budget used or committed`}>
            <div className={`h-full rounded-full transition-all duration-700 ${barColor}`}
              style={{ width: `${Math.min(o.percentUsed, 100)}%` }} />
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard icon={DollarSign} label="Budget" value={fmt(o.totalBudget)} color="bg-purple-100 text-purple-600"
          sub={additions ? `${fmt(o.startingBalance)} + ${fmt(additions)} added` : `Starting balance`} />
        <MetricCard icon={CheckCircle2} label="Paid" value={fmt(o.paid)} color="bg-emerald-100 text-emerald-600" />
        <MetricCard icon={Clock} label="Open encumbered" value={fmt(o.encumberedOpen)} color="bg-amber-100 text-amber-600"
          sub={o.releaseRequestedTotal > 0 ? `${fmt(o.releaseRequestedTotal)} release requested` : `${o.openEncumbrances.length} line${o.openEncumbrances.length === 1 ? '' : 's'}`} />
        <MetricCard icon={ShoppingCart} label="Not yet on college report" value={fmt(o.committedOrders)} color="bg-blue-100 text-blue-600"
          sub={`${o.committedOrderCount} CMMS order${o.committedOrderCount === 1 ? '' : 's'}`} />
        <MetricCard icon={HelpCircle} label="Requested (not counted)" value={fmt(o.requestedOrders)} color="bg-surface-100 text-surface-600"
          sub={`${o.requestedOrderCount} pending approval`} />
      </div>

      {/* Open encumbrances */}
      <section className="bg-white rounded-xl border border-surface-200" aria-labelledby="pb-open-enc-h">
        <div className="p-4 border-b border-surface-100">
          <h3 id="pb-open-enc-h" className="text-sm font-semibold text-surface-900 flex items-center gap-1.5">
            <Clock size={14} className="text-amber-500" aria-hidden="true" /> Open Encumbrances
          </h3>
          <p className="text-[11px] text-surface-500 mt-0.5">
            Money set aside on college POs but not yet paid. Unused money can be released to free it up — record the request here after you ask the business office; it clears when a later report shows it released.
          </p>
        </div>
        {o.openEncumbrances.length === 0 ? (
          <p className="text-xs text-surface-500 p-4 text-center">No open encumbrances.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">Open encumbrances for {schoolYear}, oldest first</caption>
              <thead className="bg-surface-50">
                <tr>
                  <th scope="col" className="text-left p-2 font-semibold text-surface-500">Line</th>
                  <th scope="col" className="text-left p-2 font-semibold text-surface-500">Date</th>
                  <th scope="col" className="text-right p-2 font-semibold text-surface-500">Age</th>
                  <th scope="col" className="text-right p-2 font-semibold text-surface-500">Encumbered</th>
                  <th scope="col" className="text-right p-2 font-semibold text-surface-500">Paid</th>
                  <th scope="col" className="text-right p-2 font-semibold text-surface-500">Unused</th>
                  <th scope="col" className="text-left p-2 font-semibold text-surface-500">Release</th>
                  {canManage && <th scope="col" className="p-2"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {o.openEncumbrances.map(e => (
                  <tr key={e.id} className="border-t border-surface-100">
                    <td className="p-2">
                      <div className="font-medium text-surface-900">{e.description}</div>
                      <div className="text-[10px] text-surface-500">{refLabel(e.reference)}{e.objectCode ? ` · Code ${e.objectCode}` : ''}</div>
                    </td>
                    <td className="p-2 whitespace-nowrap text-surface-600">{fmtEntryDate(e.date)}</td>
                    <td className="p-2 text-right whitespace-nowrap text-surface-600">{e.ageDays != null ? `${e.ageDays} days` : '—'}</td>
                    <td className="p-2 text-right whitespace-nowrap">{fmt(e.amount)}</td>
                    <td className="p-2 text-right whitespace-nowrap text-surface-600">{fmt(e.paid)}</td>
                    <td className="p-2 text-right whitespace-nowrap font-bold text-amber-700">{fmt(e.open)}</td>
                    <td className="p-2">
                      {e.releaseRequestedAt ? (
                        <span className="inline-flex flex-col">
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 w-fit">Requested {fmt(e.releaseAmount)}</span>
                          <span className="text-[10px] text-surface-500 mt-0.5">{fmtEntryDate(e.releaseRequestedAt)}{e.releaseRequestedBy ? ` · ${e.releaseRequestedBy}` : ''}</span>
                          {e.releaseNote && <span className="text-[10px] text-surface-500 italic">{e.releaseNote}</span>}
                        </span>
                      ) : <span className="text-surface-400">—</span>}
                    </td>
                    {canManage && (
                      <td className="p-2 text-right whitespace-nowrap">
                        {e.releaseRequestedAt ? (
                          <button type="button" onClick={() => setCancelTarget(e)}
                            aria-label={`Cancel release request for ${e.description} ${refLabel(e.reference)}`}
                            className="px-3 rounded-lg text-[11px] font-medium bg-surface-100 text-surface-600 hover:bg-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                            Cancel request
                          </button>
                        ) : (
                          <button type="button" onClick={() => setReleaseTarget(e)}
                            aria-label={`Request release of unused money on ${e.description} ${refLabel(e.reference)}`}
                            className="px-3 rounded-lg text-[11px] font-semibold bg-amber-50 text-amber-800 hover:bg-amber-100 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                            Request release
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface-50 border-t border-surface-200">
                <tr>
                  <th scope="row" colSpan={3} className="p-2 text-right font-semibold text-surface-600">Totals</th>
                  <td className="p-2 text-right font-semibold">{fmt(o.openEncumbrances.reduce((s, e) => s + e.amount, 0))}</td>
                  <td className="p-2 text-right font-semibold">{fmt(o.openEncumbrances.reduce((s, e) => s + e.paid, 0))}</td>
                  <td className="p-2 text-right font-bold text-amber-700">{fmt(o.encumberedOpen)}</td>
                  <td colSpan={canManage ? 2 : 1} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* CMMS orders not yet on the college report */}
      <section className="bg-white rounded-xl border border-surface-200" aria-labelledby="pb-not-on-report-h">
        <div className="p-4 border-b border-surface-100">
          <h3 id="pb-not-on-report-h" className="text-sm font-semibold text-surface-900 flex items-center gap-1.5">
            <ShoppingCart size={14} className="text-blue-500" aria-hidden="true" /> Not Yet on College Report
          </h3>
          <p className="text-[11px] text-surface-500 mt-0.5">
            Approved CMMS orders that no college budget line covers yet. They count against the budget at the CMMS total until the next report import links them (or you link one by hand).
          </p>
        </div>
        {o.committedOrderList.length === 0 ? (
          <p className="text-xs text-surface-500 p-4 text-center">Every approved order is on a college report.</p>
        ) : (
          <ul className="divide-y divide-surface-100">
            {o.committedOrderList.map(ord => (
              <li key={ord.orderId} className="px-4 py-2 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[180px]">
                  <div className="text-xs font-medium text-surface-900">{ord.vendor} <span className="text-surface-500 font-normal">· {ord.orderId}</span></div>
                  <div className="text-[10px] text-surface-500">
                    {ord.status} · {fmtLocalDate(ord.date)}{ord.orderedBy ? ` · ${ord.orderedBy}` : ''}{ord.collegePo ? ` · College PO# ${ord.collegePo}` : ''}
                  </div>
                </div>
                <span className="text-xs font-bold text-surface-900">{fmt(ord.total)}</span>
                {canManage && o.collegeLines.length > 0 && (
                  <button type="button" onClick={() => setLinkTarget(ord)}
                    aria-label={`Link ${ord.orderId} (${ord.vendor}) to a college budget line`}
                    className="px-3 rounded-lg text-[11px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 inline-flex items-center gap-1">
                    <Link2 size={12} aria-hidden="true" /> Link to college line
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {o.requestedOrderList.length > 0 && (
          <div className="border-t border-surface-100 px-4 py-2">
            <button type="button" onClick={() => setShowRequested(v => !v)} aria-expanded={showRequested}
              className="text-[11px] font-medium text-surface-600 hover:text-surface-800 min-h-[44px] inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 rounded">
              {showRequested ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
              {o.requestedOrderList.length} pending order{o.requestedOrderList.length === 1 ? '' : 's'} awaiting approval ({fmt(o.requestedOrders)}) — not counted
            </button>
            {showRequested && (
              <ul className="mt-1 space-y-1">
                {o.requestedOrderList.map(ord => (
                  <li key={ord.orderId} className="text-[11px] text-surface-600 flex justify-between gap-2">
                    <span>{ord.vendor} · {ord.orderId} · {fmtLocalDate(ord.date)}</span>
                    <span>{fmt(ord.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Charts row */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Category breakdown */}
        <div className="bg-white rounded-xl border border-surface-200 p-4">
          <h3 className="text-sm font-semibold text-surface-900 mb-3 flex items-center gap-1.5">
            <PieChart size={14} className="text-brand-500" aria-hidden="true" /> Category Breakdown
          </h3>
          {catEntries.length === 0 ? (
            <p className="text-xs text-surface-400 py-4 text-center">No spending data yet</p>
          ) : (
            <div className="space-y-2.5">
              {catEntries.map(([cat, amt], i) => (
                <div key={cat}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="font-medium text-surface-700">{cat === 'Purchase Orders' ? 'CMMS orders not on report' : cat}</span>
                    <span className="text-surface-500">{fmt(amt)}</span>
                  </div>
                  <div className="h-1.5 bg-surface-100 rounded-full overflow-hidden" aria-hidden="true">
                    <div className="h-full rounded-full transition-all"
                      style={{
                        width: `${(amt / maxCat) * 100}%`,
                        backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
                      }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Monthly trend */}
        <div className="bg-white rounded-xl border border-surface-200 p-4">
          <h3 className="text-sm font-semibold text-surface-900 mb-3 flex items-center gap-1.5">
            <BarChart3 size={14} className="text-brand-500" aria-hidden="true" /> Monthly Spending
          </h3>
          {(o.monthlyTrend || []).length === 0 ? (
            <p className="text-xs text-surface-400 py-4 text-center">No monthly data yet</p>
          ) : (
            <>
              <div className="flex items-end gap-1 h-40 pt-2" aria-hidden="true">
                {o.monthlyTrend.map((m, i) => {
                  const pct = maxMonth > 0 ? (m.amount / maxMonth) * 100 : 0
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                      {/* Tooltip */}
                      <div className="hidden group-hover:block absolute bottom-full mb-1 bg-slate-800 text-white text-[10px] px-2 py-1 rounded-lg whitespace-nowrap z-10">
                        {m.label}: {fmt(m.amount)}
                      </div>
                      <div className="w-full max-w-[32px] rounded-t transition-all bg-brand-500 hover:bg-brand-600"
                        style={{ height: `${Math.max(pct, 2)}%` }} />
                      <span className="text-[9px] text-surface-400 mt-1 leading-tight">{m.shortLabel}</span>
                    </div>
                  )
                })}
              </div>
              <ul className="sr-only">
                {o.monthlyTrend.map(m => <li key={m.label}>{m.label}: {fmt(m.amount)}</li>)}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Request release of unused money on an open encumbrance. */
function ReleaseDialog({ target, saving, onSave, onClose }) {
  const [amount, setAmount] = useState(target.open.toFixed(2))
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const dialogRef = useDialogA11y(true, onClose)

  const submit = (e) => {
    e.preventDefault()
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) return setErr('Enter an amount greater than $0.')
    if (amt > target.open + 0.005) return setErr(`The most that can be released is the unused ${fmt(target.open)}.`)
    setErr('')
    onSave({ amount: amt, note })
  }

  return (
    <div className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pb-release-title" aria-describedby="pb-release-desc"
        onSubmit={submit} className="bg-white rounded-xl w-full max-w-md shadow-xl p-5 space-y-3">
        <h2 id="pb-release-title" className="text-sm font-bold text-surface-900">Request release</h2>
        <p id="pb-release-desc" className="text-xs text-surface-600">
          {target.description} {refLabel(target.reference)} — encumbered {fmt(target.amount)}, paid {fmt(target.paid)}, unused <strong>{fmt(target.open)}</strong>.
          Record this after you ask the business office to release the money. It clears automatically when a later report shows the line reduced, paid or liquidated.
        </p>
        <div>
          <label htmlFor="pb-release-amount" className="text-xs font-semibold text-surface-600 block mb-1">Amount to release ($)</label>
          <input id="pb-release-amount" type="number" step="0.01" min="0.01" max={target.open} value={amount}
            onChange={e => setAmount(e.target.value)} className="input text-sm" required
            aria-invalid={!!err} aria-describedby={err ? 'pb-release-err' : undefined} />
        </div>
        <div>
          <label htmlFor="pb-release-note" className="text-xs font-semibold text-surface-600 block mb-1">Note (optional)</label>
          <textarea id="pb-release-note" rows={2} value={note} onChange={e => setNote(e.target.value)}
            placeholder="e.g. Emailed business office 11/5 — need funds for trainer parts" className="input text-sm resize-y" />
        </div>
        {err && <p id="pb-release-err" role="alert" className="text-xs text-red-700">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-4 rounded-lg bg-surface-100 text-surface-700 text-xs font-medium hover:bg-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="px-4 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 min-h-[44px] inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            {saving && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Record request
          </button>
        </div>
      </form>
    </div>
  )
}

/** Link a CMMS order to a college budget line by hand. */
function LinkOrderDialog({ order, lines, saving, onSave, onClose }) {
  const sorted = useMemo(() => {
    const score = (l) => (vendorsMatch(l.description, order.vendor) ? 0 : 1)
    return [...lines].sort((a, b) => score(a) - score(b) || String(b.date).localeCompare(String(a.date)))
  }, [lines, order.vendor])
  const [lineId, setLineId] = useState(sorted[0]?.id || '')
  const dialogRef = useDialogA11y(true, onClose)

  return (
    <div className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pb-link-title" aria-describedby="pb-link-desc"
        onSubmit={e => { e.preventDefault(); if (lineId) onSave(lineId) }}
        className="bg-white rounded-xl w-full max-w-md shadow-xl p-5 space-y-3">
        <h2 id="pb-link-title" className="text-sm font-bold text-surface-900">Link {order.orderId} to a college line</h2>
        <p id="pb-link-desc" className="text-xs text-surface-600">
          {order.vendor} · {fmt(order.total)} · {order.status}. Once linked, this order stops counting on its own — the college line&rsquo;s amount is used instead.
        </p>
        <div>
          <label htmlFor="pb-link-line" className="text-xs font-semibold text-surface-600 block mb-1">College budget line</label>
          <select id="pb-link-line" value={lineId} onChange={e => setLineId(e.target.value)} className="input text-sm" required>
            {sorted.map(l => (
              <option key={l.id} value={l.id}>
                {l.description} — {refLabel(l.reference) || 'no ref'} — {fmt(l.amount)} — {fmtEntryDate(l.date)}{l.linkedOrderIds.length ? ` (linked: ${l.linkedOrderIds.join(', ')})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-4 rounded-lg bg-surface-100 text-surface-700 text-xs font-medium hover:bg-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            Cancel
          </button>
          <button type="submit" disabled={saving || !lineId}
            className="px-4 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 min-h-[44px] inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            {saving && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Link order
          </button>
        </div>
      </form>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS TAB
// ═══════════════════════════════════════════════════════════════════════════════

function TransactionsTab({ schoolYear, refreshKey, onRefresh, canEdit, canDelete, canManage, isSuperAdmin }) {
  const { transactions, loading, refresh } = useBudgetTransactions(schoolYear)
  const actions = useBudgetActions()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [expandedId, setExpandedId] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null) // { kind: 'void' | 'delete' | 'unlink', txn }

  // Debounce search input by 200ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(timer)
  }, [search])

  // re-fetch on refreshKey
  useEffect(() => { refresh() }, [refreshKey])

  const filtered = useMemo(() => {
    let result = transactions
    if (typeFilter !== 'all') {
      if (typeFilter === 'manual') result = result.filter(t => t.source === 'manual')
      else if (typeFilter === 'po') result = result.filter(t => t.source === 'po')
      else if (typeFilter === 'college') result = result.filter(t => t.ledgerSource === 'college_report')
      else if (typeFilter === 'po-unlinked') result = result.filter(t => t.source === 'po' && !t.linkedTo)
      else result = result.filter(t => t.type === typeFilter)
    }
    if (paymentFilter !== 'all') {
      result = result.filter(t => t.paymentStatus === paymentFilter)
    }
    if (debouncedSearch) {
      const s = debouncedSearch.toLowerCase().replace(/^\$/, '')  // strip leading $ for amount searches
      result = result.filter(t => {
        // Text fields
        if (t.description?.toLowerCase().includes(s)) return true
        if (t.reference?.toLowerCase().includes(s)) return true
        if (t.createdBy?.toLowerCase().includes(s)) return true
        if (t.category?.toLowerCase().includes(s)) return true
        if (t.objectCode?.toLowerCase().includes(s)) return true
        if (t.notes?.toLowerCase().includes(s)) return true
        if (t.type?.toLowerCase().includes(s)) return true
        if (t.paymentStatus?.toLowerCase().includes(s)) return true
        if (t.source?.toLowerCase().includes(s)) return true
        if (t.entryId?.toLowerCase().includes(s)) return true
        if (t.status?.toLowerCase().includes(s)) return true
        if (t.collegePo?.toLowerCase().includes(s)) return true
        if (t.linkedTo?.reference?.toLowerCase().includes(s)) return true
        if (t.linkedOrderIds?.some(id => id.toLowerCase().includes(s))) return true

        // Object code label lookup (e.g. searching "Equipment" matches code "1420")
        if (t.objectCode && OBJECT_CODES[t.objectCode]?.toLowerCase().includes(s)) return true

        // Dollar amount - match formatted or raw number (e.g. "150", "150.00", "1,234")
        if (t.amount != null) {
          const amtStr = t.amount.toFixed(2)
          const amtFormatted = t.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          if (amtStr.includes(s) || amtFormatted.toLowerCase().includes(s)) return true
        }

        // Date - match various formats (e.g. "Jan", "2025", "1/15", "01/15/2025")
        if (t.date) {
          try {
            const d = new Date(t.date)
            const localeDate = d.toLocaleDateString('en-US', { timeZone: 'UTC' })
            const isoDate = d.toISOString().split('T')[0]
            const monthName = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase()
            const monthShort = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toLowerCase()
            if (localeDate.toLowerCase().includes(s) || isoDate.includes(s) ||
                monthName.includes(s) || monthShort.includes(s)) return true
          } catch {}
        }

        // PO# display format (searching "PO# 12345" or "po 12345")
        if (t.reference && `po# ${t.reference}`.toLowerCase().includes(s)) return true
        if (t.reference && `po ${t.reference}`.toLowerCase().includes(s)) return true

        // "Credit Card" / "Direct Pay" display aliases
        if (t.reference?.toLowerCase() === 'cc' && 'credit card'.includes(s)) return true
        if (t.reference === 'Direct Pay' && 'direct pay'.includes(s)) return true

        return false
      })
    }
    return result
  }, [transactions, debouncedSearch, typeFilter, paymentFilter])

  // Running balance calculation
  const withBalance = useMemo(() => {
    // Get all non-voided transactions sorted by date ascending
    const sorted = [...filtered].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    let running = 0
    const balances = {}
    sorted.forEach(t => {
      if (t.status === 'Voided' || t.countsInBalance === false) return
      running += t.isCredit ? t.amount : -t.amount
      balances[t.id] = running
    })
    return balances
  }, [filtered])

  const startEdit = (txn) => {
    setEditingId(txn.id)
    setEditForm({
      description: txn.description,
      amount: txn.amount,
      category: txn.category,
      notes: txn.notes,
      reference: txn.reference,
      paymentStatus: txn.paymentStatus || '',
      objectCode: txn.objectCode || '',
      paidAmount: txn.paidAmount ?? 0,
    })
  }

  const saveEdit = async () => {
    const ok = await actions.editEntry(editingId, editForm)
    if (ok) { setEditingId(null); refresh(); onRefresh() }
  }

  const handleVoid = (txn) => setConfirmAction({ kind: 'void', txn })
  const handlePermanentDelete = (txn) => setConfirmAction({ kind: 'delete', txn })
  const runConfirmedAction = async () => {
    const act = confirmAction
    setConfirmAction(null)
    if (!act) return
    const ok = act.kind === 'void' ? await actions.voidEntry(act.txn.id)
      : act.kind === 'unlink' ? await actions.unlinkOrder(act.txn.linkedTo.id, act.txn.id)
      : await actions.deleteEntry(act.txn.id)
    if (ok) { refresh(); onRefresh() }
  }

  if (loading) {
    return (
      <div className="text-center py-16" role="status">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" aria-hidden="true" />
        <p className="text-sm text-surface-400">Loading transactions…</p>
      </div>
    )
  }

  const confirmDialog = (
    <ConfirmDialog
      open={!!confirmAction}
      title={confirmAction?.kind === 'void' ? 'Void this entry?'
        : confirmAction?.kind === 'unlink' ? 'Unlink this order?' : 'Permanently delete this entry?'}
      message={confirmAction?.kind === 'void'
        ? `"${confirmAction?.txn?.description}" will remain in the list with a strikethrough.`
        : confirmAction?.kind === 'unlink'
        ? `${confirmAction?.txn?.id} will no longer be covered by ${confirmAction?.txn?.linkedTo?.description} ${refLabel(confirmAction?.txn?.linkedTo?.reference)}. It will count on its own again (${fmt(confirmAction?.txn?.amount)}) under "Not yet on college report".`
        : `"${confirmAction?.txn?.description}" (${fmt(confirmAction?.txn?.amount)}) will be removed completely from the database. This cannot be undone.`}
      confirmLabel={confirmAction?.kind === 'void' ? 'Void entry' : confirmAction?.kind === 'unlink' ? 'Unlink order' : 'Delete permanently'}
      cancelLabel="Cancel"
      onConfirm={runConfirmedAction}
      onClose={() => setConfirmAction(null)}
    />
  )

  return (
    <div className="space-y-3">
      {confirmDialog}
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search transactions"
            placeholder="Search all fields… PO#, amount, code, date…" className="input pl-9 text-sm" />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} aria-label="Filter by type"
          className="input text-sm w-auto">
          <option value="all">All Types</option>
          <option value="manual">Ledger Entries Only</option>
          <option value="college">College Report Lines</option>
          <option value="po">CMMS Orders Only</option>
          <option value="po-unlinked">CMMS Orders Not on Report</option>
          <option value="Starting Balance">Starting Balance</option>
          <option value="Manual Expense">Expenses</option>
          <option value="Income/Grant">Income/Grants</option>
          <option value="Adjustment">Adjustments</option>
        </select>
        <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)} aria-label="Filter by payment status"
          className="input text-sm w-auto">
          <option value="all">All Statuses</option>
          {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="button" onClick={refresh} aria-label="Refresh transactions" className="p-2.5 rounded-lg bg-surface-100 hover:bg-surface-200 text-surface-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      <p className="text-xs text-surface-400">{filtered.length} transaction{filtered.length !== 1 ? 's' : ''} · {schoolYear}</p>

      {/* Transaction list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <Receipt size={32} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
          <p className="text-sm text-surface-500">No transactions found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(txn => {
            const isVoided = txn.status === 'Voided'
            const isEditing = editingId === txn.id
            const isExpanded = expandedId === txn.id

            return (
              <div key={txn.id}
                className={`bg-white rounded-xl border border-surface-200 p-3 transition-opacity ${
                  isVoided ? 'opacity-40 line-through' : ''
                }`}>
                {isEditing ? (
                  /* Inline edit form */
                  <div className="space-y-2">
                    <input aria-label="Description (editing)" type="text" value={editForm.description}
                      onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                      className="input text-sm" placeholder="Description" />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <input aria-label="Amount (editing)" type="number" step="0.01" value={editForm.amount}
                        onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                        className="input text-sm" placeholder="Amount" />
                      <select aria-label="Category (editing)" value={editForm.category}
                        onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                        className="input text-sm">
                        {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                        <option>Purchase Orders</option>
                        <option>Budget</option>
                      </select>
                      <input aria-label="PO number or reference (editing)" type="text" value={editForm.reference || ''}
                        onChange={e => setEditForm(f => ({ ...f, reference: e.target.value }))}
                        className="input text-sm" placeholder="PO # / Reference" />
                      <select aria-label="Payment status (editing)" value={editForm.paymentStatus || ''}
                        onChange={e => setEditForm(f => ({ ...f, paymentStatus: e.target.value }))}
                        className="input text-sm">
                        <option value="">No Status</option>
                        {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select aria-label="Object code (editing)" value={editForm.objectCode || ''}
                        onChange={e => setEditForm(f => ({ ...f, objectCode: e.target.value }))}
                        className="input text-sm">
                        <option value="">No Object Code</option>
                        {Object.entries(OBJECT_CODES).map(([code, label]) => (
                          <option key={code} value={code}>{code} - {label}</option>
                        ))}
                      </select>
                      <input aria-label="Notes (editing)" type="text" value={editForm.notes || ''}
                        onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                        className="input text-sm" placeholder="Notes" />
                    </div>
                    {['Encumbered', 'Partial'].includes(editForm.paymentStatus) && (
                      <div className="grid grid-cols-2 gap-2 items-center">
                        <label htmlFor={`pb-edit-paid-${txn.id}`} className="text-xs text-surface-600">Paid so far on this encumbrance ($)</label>
                        <input id={`pb-edit-paid-${txn.id}`} type="number" step="0.01" min="0" value={editForm.paidAmount ?? 0}
                          onChange={e => setEditForm(f => ({ ...f, paidAmount: e.target.value }))}
                          className="input text-sm" />
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button onClick={saveEdit}
                        className="px-3 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                        <Save size={11} className="inline mr-1" aria-hidden="true" /> Save
                      </button>
                      <button onClick={() => setEditingId(null)}
                        className="px-3 py-1 rounded-lg bg-surface-100 text-xs text-surface-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal display row */
                  <>
                    <div className="flex items-center gap-3">
                      {/* Type icon — green=credit, amber=PO, blue=imported, red=manual expense */}
                      {(() => {
                        const isImported = (txn.notes || '').includes('Imported from spreadsheet')
                        let iconBg, iconEl
                        if (txn.isCredit) {
                          iconBg = 'bg-emerald-100'
                          iconEl = <ArrowUpCircle size={14} className="text-emerald-600" aria-hidden="true" />
                        } else if (txn.source === 'po' && txn.linkedTo) {
                          iconBg = 'bg-surface-100'
                          iconEl = <Link2 size={14} className="text-surface-500" aria-hidden="true" />
                        } else if (txn.source === 'po') {
                          iconBg = 'bg-amber-100'
                          iconEl = <ShoppingCart size={14} className="text-amber-600" aria-hidden="true" />
                        } else if (isImported) {
                          iconBg = 'bg-blue-100'
                          iconEl = <FileSpreadsheet size={14} className="text-blue-600" aria-hidden="true" />
                        } else {
                          iconBg = 'bg-red-100'
                          iconEl = <ArrowDownCircle size={14} className="text-red-600" aria-hidden="true" />
                        }
                        return (
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                            {iconEl}
                          </div>
                        )
                      })()}

                      {/* Details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-surface-900 truncate">
                            <Highlight text={txn.description} search={debouncedSearch} />
                          </span>
                          <TypeBadge type={txn.type} />
                          <SourceBadge source={txn.source} notes={txn.notes} ledgerSource={txn.ledgerSource} />
                          {txn.paymentStatus && <PaymentStatusBadge status={txn.paymentStatus} />}
                          {txn.source === 'po' && (txn.linkedTo ? (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-600">
                              On college {refLabel(txn.linkedTo.reference) || 'line'} — not counted separately
                            </span>
                          ) : (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">Not yet on college report</span>
                          ))}
                          {txn.releaseRequestedAt && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">Release requested {fmt(txn.releaseAmount)}</span>
                          )}
                        </div>
                        <div className="text-[10px] text-surface-400 mt-0.5 flex flex-wrap gap-x-3">
                          {txn.date && <span><Highlight text={new Date(txn.date).toLocaleDateString('en-US', { timeZone: 'UTC' })} search={debouncedSearch} /></span>}
                          {txn.reference && (
                            <span className="font-medium text-surface-500">
                              <Highlight
                                text={txn.reference.match(/^\d{5,}$/) ? `PO# ${txn.reference}` :
                                     txn.reference.toLowerCase() === 'cc' ? 'Credit Card' :
                                     txn.reference === 'Direct Pay' ? 'Direct Pay' :
                                     `Ref: ${txn.reference}`}
                                search={debouncedSearch}
                              />
                            </span>
                          )}
                          {txn.objectCode && (
                            <span className="font-mono text-surface-500">
                              Code: <Highlight
                                text={`${txn.objectCode}${OBJECT_CODES[txn.objectCode] ? ` (${OBJECT_CODES[txn.objectCode]})` : ''}`}
                                search={debouncedSearch}
                              />
                            </span>
                          )}
                          {txn.category && txn.category !== 'Other' && <span><Highlight text={txn.category} search={debouncedSearch} /></span>}
                          {txn.createdBy && <span><Highlight text={txn.createdBy} search={debouncedSearch} /></span>}
                          {txn.openAmount > 0 && <span className="text-amber-700">Paid {fmt(txn.paidAmount)} · {fmt(txn.openAmount)} still encumbered</span>}
                          {txn.linkedOrderIds?.length > 0 && <span>Covers <Highlight text={txn.linkedOrderIds.join(', ')} search={debouncedSearch} /></span>}
                          {txn.collegePo && <span>College <Highlight text={`PO# ${txn.collegePo}`} search={debouncedSearch} /></span>}
                        </div>
                      </div>

                      {/* Amount */}
                      <span className={`text-sm font-bold flex-shrink-0 ${
                        txn.countsInBalance === false ? 'text-surface-400' : txn.isCredit ? 'text-emerald-600' : 'text-red-600'
                      }`}>
                        {txn.isCredit ? '+' : '-'}<Highlight text={fmt(txn.amount)} search={debouncedSearch} />
                      </span>

                      {/* Expand / Actions */}
                      <div className="flex gap-0.5 flex-shrink-0">
                        {(txn.notes || txn.objectCode) && (
                          <button type="button" onClick={() => setExpandedId(isExpanded ? null : txn.id)} title="Details" aria-expanded={isExpanded} aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${txn.description}`}
                            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-surface-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                            {isExpanded ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
                          </button>
                        )}
                        {txn.source === 'po' && txn.linkedTo && canManage && (
                          <button type="button" onClick={() => setConfirmAction({ kind: 'unlink', txn })} title="Unlink from college line"
                            aria-label={`Unlink ${txn.id} from ${txn.linkedTo.description} ${refLabel(txn.linkedTo.reference)}`}
                            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                            <Unlink size={12} aria-hidden="true" />
                          </button>
                        )}
                        {txn.source === 'manual' && !isVoided && canEdit && (
                          <button type="button" onClick={() => startEdit(txn)} title="Edit" aria-label={`Edit ${txn.description}`}
                            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                            <Edit3 size={12} aria-hidden="true" />
                          </button>
                        )}
                        {txn.source === 'manual' && !isVoided && canDelete && !isSuperAdmin && (
                          <button type="button" onClick={() => handleVoid(txn)} title="Void" aria-label={`Void ${txn.description}`}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        )}
                        {txn.source === 'manual' && canDelete && isSuperAdmin && (
                          <button type="button" onClick={() => handlePermanentDelete(txn)}
                            title={isVoided ? 'Permanently delete' : 'Delete'} aria-label={`${isVoided ? 'Permanently delete' : 'Delete'} ${txn.description}`}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="mt-2 pt-2 border-t border-surface-100 text-xs text-surface-500 space-y-1">
                        {txn.notes && (
                          <div className="flex gap-2">
                            <span className="font-medium text-surface-600 flex-shrink-0">Notes:</span>
                            <span><Highlight text={txn.notes} search={debouncedSearch} /></span>
                          </div>
                        )}
                        {txn.objectCode && (
                          <div className="flex gap-2">
                            <span className="font-medium text-surface-600 flex-shrink-0">Object Code:</span>
                            <span className="font-mono">
                              <Highlight text={`${txn.objectCode} – ${OBJECT_CODES[txn.objectCode] || 'Unknown'}`} search={debouncedSearch} />
                            </span>
                          </div>
                        )}
                        {txn.reference && (
                          <div className="flex gap-2">
                            <span className="font-medium text-surface-600 flex-shrink-0">Reference:</span>
                            <span><Highlight text={txn.reference} search={debouncedSearch} /></span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD ENTRY TAB
// ═══════════════════════════════════════════════════════════════════════════════

function AddEntryTab({ schoolYear, onAdded }) {
  const actions = useBudgetActions()
  const [form, setForm] = useState({
    type: 'Manual Expense',
    description: '',
    amount: '',
    category: 'Supplies',
    reference: '',
    notes: '',
    date: new Date().toISOString().split('T')[0],
    paymentStatus: 'Paid',
    objectCode: '',
  })

  const handleCodeChange = (code) => {
    const category = objectCodeToCategory(code)
    setForm(f => ({ ...f, objectCode: code, ...(code ? { category } : {}) }))
  }

  const handleSubmit = async () => {
    const ok = await actions.addEntry({
      ...form,
      schoolYear,
      amount: parseFloat(form.amount),
    })
    if (ok) {
      setForm(f => ({ ...f, description: '', amount: '', reference: '', notes: '', objectCode: '' }))
      onAdded()
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-white rounded-xl border border-surface-200 p-5 space-y-4">
        <h2 className="text-sm font-bold text-surface-900 flex items-center gap-2">
          <Plus size={16} className="text-brand-600" aria-hidden="true" /> New Budget Entry
          <span className="ml-auto text-[10px] font-normal text-surface-400 bg-surface-100 px-2 py-0.5 rounded-full">{schoolYear}</span>
        </h2>

        {/* Type */}
        <div>
          <label htmlFor="pb-fld-type-2" className="text-xs font-semibold text-surface-500 mb-1 block">Type *</label>
          <select id="pb-fld-type-2" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            className="input text-sm">
            {ENTRY_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="pb-fld-description-3" className="text-xs font-semibold text-surface-500 mb-1 block">Description *</label>
          <input id="pb-fld-description-3" type="text" value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="e.g. Viking Electric" className="input text-sm" />
        </div>

        {/* Amount + Date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="pb-fld-amount-4" className="text-xs font-semibold text-surface-500 mb-1 block">Amount ($) *</label>
            <input id="pb-fld-amount-4" type="number" step="0.01" value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              placeholder="0.00" className="input text-sm" />
          </div>
          <div>
            <label htmlFor="pb-fld-date-5" className="text-xs font-semibold text-surface-500 mb-1 block">Date</label>
            <input id="pb-fld-date-5" type="date" value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="input text-sm" />
          </div>
        </div>

        {/* Reference + Payment Status */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="pb-fld-po-reference-6" className="text-xs font-semibold text-surface-500 mb-1 block">PO # / Reference</label>
            <input id="pb-fld-po-reference-6" type="text" value={form.reference}
              onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
              placeholder="PO#, CC, Direct Pay…" className="input text-sm" />
          </div>
          <div>
            <label htmlFor="pb-fld-payment-status-7" className="text-xs font-semibold text-surface-500 mb-1 block">Payment Status</label>
            <select id="pb-fld-payment-status-7" value={form.paymentStatus} onChange={e => setForm(f => ({ ...f, paymentStatus: e.target.value }))}
              className="input text-sm">
              <option value="">Not Set</option>
              {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Object Code + Category */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="pb-fld-object-code-8" className="text-xs font-semibold text-surface-500 mb-1 block">Object Code</label>
            <select id="pb-fld-object-code-8" value={form.objectCode} onChange={e => handleCodeChange(e.target.value)}
              className="input text-sm">
              <option value="">None</option>
              {Object.entries(OBJECT_CODES).map(([code, label]) => (
                <option key={code} value={code}>{code} - {label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pb-fld-category-9" className="text-xs font-semibold text-surface-500 mb-1 block">Category</label>
            <select id="pb-fld-category-9" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              className="input text-sm">
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="pb-fld-notes-10" className="text-xs font-semibold text-surface-500 mb-1 block">Notes</label>
          <textarea id="pb-fld-notes-10" value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Optional notes…" rows={2} className="input text-sm resize-y" />
        </div>

        <button onClick={handleSubmit} disabled={actions.saving}
          className="w-full py-2.5 rounded-xl bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
          {actions.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          Add Entry
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT TAB  –  college budget printout → ledger (add, update, link orders)
// ═══════════════════════════════════════════════════════════════════════════════

const LINK_HOW_LABEL = {
  college_po: 'College PO # on the order',
  exact: 'same vendor and amount',
  sum: 'orders add up to this line',
  close: 'same vendor, amount within 10%',
  split: 'this line and another add up to the order',
  loose: 'same vendor, nearby date — amounts differ',
}

function ImportTab({ schoolYear, onImported, onViewOverview }) {
  const actions = useBudgetActions()
  const importer = useSpreadsheetImport(schoolYear)
  const [step, setStep] = useState('upload')  // upload → preview → done
  const [isDragging, setIsDragging] = useState(false)
  const [choices, setChoices] = useState({ additions: new Set(), newLines: {}, changed: new Set() })
  const [result, setResult] = useState(null)
  const [liveMsg, setLiveMsg] = useState('')

  const data = importer.parsed
  const plan = data?.plan

  // Default choices: import every new line with its suggested links, apply every update,
  // add every new budget addition.
  useEffect(() => {
    if (!plan) return
    const newLines = {}
    plan.newLines.forEach((n, i) => { newLines[i] = { include: true, orderIds: [...n.suggestedOrderIds] } })
    setChoices({
      additions: new Set(plan.additions.map((a, i) => (a.status === 'new' ? i : null)).filter(i => i != null)),
      newLines,
      changed: new Set(plan.changedLines.map((_, i) => i)),
    })
    const n = plan.newLines.length, c = plan.changedLines.length
    setLiveMsg(`Report read: ${data.totalFromFile} lines. ${n} new, ${c} to update, ${plan.unchangedLines.length} already up to date.`)
  }, [plan])

  const processFile = async (file) => {
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['xls', 'xlsx', 'csv'].includes(ext)) {
      toast.error('Please upload a .xls, .xlsx, or .csv file')
      return
    }
    setResult(null)
    await importer.parseFile(file)
    setStep('preview')
  }

  const handleFile = (e) => { processFile(e.target.files?.[0]); e.target.value = '' }

  // ─── Drag & Drop handlers ─────────────────────────────────────────────────
  const handleDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }
  const handleDragLeave = (e) => {
    e.preventDefault(); e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget)) return
    setIsDragging(false)
  }
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false)
    processFile(e.dataTransfer?.files?.[0])
  }

  const toggleSet = (key, idx) => setChoices(c => {
    const next = new Set(c[key])
    next.has(idx) ? next.delete(idx) : next.add(idx)
    return { ...c, [key]: next }
  })
  const toggleLine = (idx) => setChoices(c => ({
    ...c, newLines: { ...c.newLines, [idx]: { ...c.newLines[idx], include: !c.newLines[idx]?.include } },
  }))
  const toggleLink = (idx, orderId) => setChoices(c => {
    const cur = c.newLines[idx] || { include: true, orderIds: [] }
    const ids = cur.orderIds.includes(orderId) ? cur.orderIds.filter(x => x !== orderId) : [...cur.orderIds, orderId]
    return { ...c, newLines: { ...c.newLines, [idx]: { ...cur, orderIds: ids } } }
  })
  const setAllNew = (include) => setChoices(c => {
    const nl = {}
    Object.entries(c.newLines).forEach(([k, v]) => { nl[k] = { ...v, include } })
    return { ...c, newLines: nl }
  })

  const handleReset = () => {
    importer.reset()
    setStep('upload')
    setResult(null)
    setLiveMsg('')
  }

  const newCount = plan ? plan.newLines.filter((_, i) => choices.newLines[i]?.include).length : 0
  const changedCount = choices.changed.size
  const additionCount = choices.additions.size
  const linkCount = plan ? plan.newLines.reduce((s, _, i) => s + (choices.newLines[i]?.include ? (choices.newLines[i].orderIds || []).length : 0), 0) : 0
  const nothingToDo = plan && plan.newLines.length === 0 && plan.changedLines.length === 0 && !plan.additions.some(a => a.status === 'new')
  const checkCount = plan ? plan.newLines.filter((n, i) => n.needsCheck && choices.newLines[i]?.include && (choices.newLines[i].orderIds || []).length).length : 0

  const handleImport = async () => {
    if (!newCount && !changedCount && !additionCount) return toast.error('Nothing selected to import')
    const res = await actions.applyCollegeImport({ plan, parsed: data.parsed, choices, schoolYear })
    setResult(res)
    if (res.ok) {
      setStep('done')
      setLiveMsg(`Import complete: ${res.added} added, ${res.updated} updated, ${res.additions} budget additions, ${res.linked} CMMS orders linked.`)
      onImported()
    }
  }

  const meta = data?.meta || {}
  const linesTotal = data ? data.parsed.lines.reduce((s, l) => s + l.amount, 0) : 0
  const totalsMismatch = meta.totals != null && Math.abs(meta.totals - linesTotal) > 0.01

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <p className="sr-only" aria-live="polite" role="status">{liveMsg}</p>

      {/* Header */}
      <div className="bg-white rounded-xl border border-surface-200 p-5">
        <h2 className="text-sm font-bold text-surface-900 flex items-center gap-2 mb-1">
          <FileSpreadsheet size={16} className="text-brand-600" aria-hidden="true" /> Import College Budget Report
          <span className="ml-auto text-[10px] font-normal text-surface-500 bg-surface-100 px-2 py-0.5 rounded-full">{schoolYear}</span>
        </h2>
        <p className="text-xs text-surface-500">
          Upload the college budget printout as .xls, .xlsx or .csv. Columns are found by their headings. Lines already in the CMMS are updated (paid, encumbered, amounts) instead of duplicated, and CMMS orders are linked to the college line that covers them so nothing is counted twice.
        </p>
      </div>

      {/* Step: Upload */}
      {step === 'upload' && !importer.parsing && (
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`bg-white rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
            isDragging ? 'border-brand-400 bg-brand-50/50' : 'border-surface-300'
          }`}
        >
          <Upload size={32} className={`mx-auto mb-3 transition-colors ${isDragging ? 'text-brand-500' : 'text-surface-400'}`} aria-hidden="true" />
          <p className="text-sm font-medium text-surface-700 mb-1">
            {isDragging ? 'Drop your file here…' : 'Drag & drop a spreadsheet here, or choose a file'}
          </p>
          <p className="text-xs text-surface-500 mb-4">Supports .xls, .xlsx, .csv files</p>
          <label className="inline-flex items-center gap-2 px-5 min-h-[44px] rounded-xl bg-brand-600 text-white text-sm font-semibold cursor-pointer hover:bg-brand-700 transition-colors focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2">
            <FileSpreadsheet size={16} aria-hidden="true" />
            Choose File
            <input type="file" accept=".xls,.xlsx,.csv" onChange={handleFile} className="sr-only" />
          </label>
        </div>
      )}

      {/* Parsing indicator */}
      {importer.parsing && (
        <div className="text-center py-12" role="status">
          <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" aria-hidden="true" />
          <p className="text-sm text-surface-500">Reading the report and matching it to the CMMS…</p>
        </div>
      )}

      {/* Error */}
      {importer.error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3" role="alert">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-red-800">This file could not be imported</p>
            <p className="text-xs text-red-700 mt-1">{importer.error}</p>
            <button type="button" onClick={handleReset} className="mt-2 text-xs font-medium text-red-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Choose a different file</button>
          </div>
        </div>
      )}

      {/* Step: Preview */}
      {step === 'preview' && data && plan && (
        <>
          {/* Report info + checks */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
              <FileText size={13} aria-hidden="true" /> {data.format === 'RICT' ? 'College budget report' : 'Spreadsheet'} detected
            </h3>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {meta.program && <div><dt className="text-blue-700 inline">Program: </dt><dd className="font-medium text-blue-900 inline">{meta.program}</dd></div>}
              {meta.fiscalYear && <div><dt className="text-blue-700 inline">FY: </dt><dd className="font-medium text-blue-900 inline">{meta.fiscalYear}</dd></div>}
              {meta.account && <div><dt className="text-blue-700 inline">Account: </dt><dd className="font-medium text-blue-900 inline">{meta.account}</dd></div>}
              {meta.balancedAsOf && <div><dt className="text-blue-700 inline">Balanced as of: </dt><dd className="font-medium text-blue-900 inline">{fmtEntryDate(`${meta.balancedAsOf}T12:00:00Z`)}</dd></div>}
              {meta.beginningBalance != null && <div><dt className="text-blue-700 inline">Beginning: </dt><dd className="font-medium text-blue-900 inline">{fmt(meta.beginningBalance)}</dd></div>}
              {meta.currentBalance != null && <div><dt className="text-blue-700 inline">Current: </dt><dd className="font-medium text-blue-900 inline">{fmt(meta.currentBalance)}</dd></div>}
              {meta.presentBalance != null && <div><dt className="text-blue-700 inline">Present: </dt><dd className="font-medium text-blue-900 inline">{fmt(meta.presentBalance)}</dd></div>}
              <div><dt className="text-blue-700 inline">Lines read: </dt><dd className="font-medium text-blue-900 inline">{data.totalFromFile} ({fmt(linesTotal)})</dd></div>
            </dl>
            {(data.yearMismatch || totalsMismatch || (meta.beginningBalance != null && Math.abs((data.startingBalance || 0) - meta.beginningBalance) > 0.005) || data.warnings.length > 0) && (
              <ul className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
                {data.yearMismatch && <li className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />This report is for {meta.fiscalYear} ({data.yearMismatch}) but you are importing into {schoolYear}. Change the school year on the Overview tab if that&rsquo;s not intended.</li>}
                {totalsMismatch && <li className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />Lines read add up to {fmt(linesTotal)} but the report&rsquo;s TOTALS row says {fmt(meta.totals)}. Some rows may not have been read.</li>}
                {meta.beginningBalance != null && Math.abs((data.startingBalance || 0) - meta.beginningBalance) > 0.005 && (
                  <li className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />The report&rsquo;s beginning balance is {fmt(meta.beginningBalance)}; the CMMS starting balance for {schoolYear} is {fmt(data.startingBalance || 0)}. Set it on the Year Mgmt tab if it should match.</li>
                )}
                {data.warnings.map((w, i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{w}</li>)}
              </ul>
            )}
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryCount label="New lines" value={plan.newLines.length} tone="emerald" />
            <SummaryCount label="To update" value={plan.changedLines.length} tone="blue" />
            <SummaryCount label="Already up to date" value={plan.unchangedLines.length} tone="surface" />
            <SummaryCount label="Budget additions" value={plan.additions.filter(a => a.status === 'new').length} tone="purple" />
          </div>

          {nothingToDo ? (
            <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
              <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-500" aria-hidden="true" />
              <p className="text-sm font-medium text-surface-700">This report is already fully imported</p>
              <p className="text-xs text-surface-500 mt-1">All {data.totalFromFile} lines match the CMMS — nothing changed since the last import.</p>
              <button type="button" onClick={handleReset} className="mt-3 text-xs font-medium text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Upload a different file</button>
            </div>
          ) : (
            <>
              {/* Budget additions */}
              {plan.additions.length > 0 && (
                <section className="bg-white rounded-xl border border-purple-200" aria-labelledby="pb-imp-add-h">
                  <h3 id="pb-imp-add-h" className="text-xs font-bold text-purple-900 p-3 border-b border-purple-100">
                    Budget additions from the report summary
                  </h3>
                  <ul className="divide-y divide-surface-100">
                    {plan.additions.map((a, i) => (
                      <li key={i} className="px-3 py-1 flex items-center gap-3">
                        {a.status === 'new' ? (
                          <label className="flex items-center gap-2 flex-1 min-h-[44px] cursor-pointer text-xs">
                            <input type="checkbox" checked={choices.additions.has(i)} onChange={() => toggleSet('additions', i)}
                              className="w-4 h-4 rounded border-surface-300 text-brand-600" />
                            <span className="font-medium text-surface-900">{a.description}</span>
                            <span className="text-surface-500">added to the budget as Income/Grant</span>
                          </label>
                        ) : (
                          <span className="flex-1 text-xs text-surface-500 min-h-[44px] flex items-center gap-2">
                            <Check size={12} className="text-emerald-600" aria-hidden="true" /> {a.description} — already in the CMMS
                          </span>
                        )}
                        <span className="text-xs font-bold text-emerald-700">+{fmt(a.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* New lines */}
              {plan.newLines.length > 0 && (
                <section className="bg-white rounded-xl border border-surface-200 overflow-hidden" aria-labelledby="pb-imp-new-h">
                  <div className="p-3 border-b border-surface-100 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 id="pb-imp-new-h" className="text-xs font-bold text-surface-900">
                        New lines <span className="font-normal text-surface-500">({newCount} of {plan.newLines.length} selected)</span>
                      </h3>
                      <p className="text-[11px] text-surface-500 mt-0.5">
                        Suggested CMMS orders are already ticked. Untick any that aren&rsquo;t part of that college line — they will stay under &ldquo;Not yet on college report&rdquo; and can be linked later.
                        {checkCount > 0 && <> <strong className="text-amber-800">{checkCount} link{checkCount === 1 ? '' : 's'} marked &ldquo;Check&rdquo;</strong> have amounts that differ more than usual.</>}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setAllNew(true)} className="text-[11px] font-medium text-brand-700 hover:underline min-h-[44px] px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 rounded">Select all</button>
                      <button type="button" onClick={() => setAllNew(false)} className="text-[11px] font-medium text-surface-600 hover:underline min-h-[44px] px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 rounded">Deselect all</button>
                    </div>
                  </div>
                  <div className="max-h-[560px] overflow-auto">
                    <table className="w-full text-xs">
                      <caption className="sr-only">New lines from the college report and the CMMS orders each one covers</caption>
                      <thead className="bg-surface-50 sticky top-0 z-[1]">
                        <tr>
                          <th scope="col" className="w-10 p-2"><span className="sr-only">Import</span></th>
                          <th scope="col" className="text-left p-2 font-semibold text-surface-500">Date</th>
                          <th scope="col" className="text-left p-2 font-semibold text-surface-500">College line</th>
                          <th scope="col" className="text-left p-2 font-semibold text-surface-500">Status</th>
                          <th scope="col" className="text-right p-2 font-semibold text-surface-500">Amount</th>
                          <th scope="col" className="text-left p-2 font-semibold text-surface-500">Covers CMMS orders</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.newLines.map((n, idx) => {
                          const c = choices.newLines[idx] || { include: false, orderIds: [] }
                          const l = n.line
                          const lineLabel = `${l.description} ${refLabel(l.reference)}`
                          return (
                            <tr key={idx} className={`border-t border-surface-100 align-top ${c.include ? '' : 'opacity-60'}`}>
                              <td className="p-1 text-center">
                                <label className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] cursor-pointer">
                                  <input type="checkbox" checked={!!c.include} onChange={() => toggleLine(idx)}
                                    aria-label={`Import ${lineLabel}, ${fmt(l.amount)}`}
                                    className="w-4 h-4 rounded border-surface-300 text-brand-600" />
                                </label>
                              </td>
                              <td className="p-2 whitespace-nowrap text-surface-600">{l.date ? fmtEntryDate(`${l.date}T12:00:00Z`) : '—'}</td>
                              <td className="p-2">
                                <div className="font-medium text-surface-900">{l.description}</div>
                                <div className="text-[10px] text-surface-500">{refLabel(l.reference) || '—'}{l.objectCode ? ` · Code ${l.objectCode}` : ''}</div>
                              </td>
                              <td className="p-2">
                                <PaymentStatusBadge status={l.paymentStatus} />
                                {l.paymentStatus === 'Encumbered' && l.paidAmount > 0 && (
                                  <div className="text-[10px] text-surface-500 mt-0.5">paid {fmt(l.paidAmount)} so far</div>
                                )}
                                {!l.epRaw && <div className="text-[10px] text-surface-500 mt-0.5">E/P blank</div>}
                              </td>
                              <td className="p-2 text-right font-bold text-surface-900 whitespace-nowrap">{fmt(l.amount)}</td>
                              <td className="p-2">
                                {n.linkedOrders.length === 0 ? (
                                  <span className="text-[11px] text-surface-500">None — not a CMMS order</span>
                                ) : (
                                  <div className="space-y-0.5">
                                    {n.linkedOrders.map(o => (
                                      <label key={o.order_id} className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                                        <input type="checkbox" checked={c.orderIds.includes(o.order_id)} disabled={!c.include}
                                          onChange={() => toggleLink(idx, o.order_id)}
                                          className="w-4 h-4 rounded border-surface-300 text-brand-600" />
                                        <span className="text-[11px]">
                                          <span className="font-medium text-surface-900">{o.order_id}</span>{' '}
                                          <span className="text-surface-600">{o.vendor_name || o.other_vendor} · {fmt(parseFloat(o.total) || 0)} · {fmtLocalDate(o.ordered_date || o.order_date)}</span>
                                        </span>
                                      </label>
                                    ))}
                                    <div className="text-[10px] text-surface-500">
                                      Matched by {LINK_HOW_LABEL[n.linkHow] || 'vendor'}
                                      {n.sharedWithRows.length > 0 && ` (shared with report row ${n.sharedWithRows.join(', ')})`}
                                      {Math.abs(n.diff) >= 0.01 && <> · college {n.diff > 0 ? 'higher' : 'lower'} by {fmt(Math.abs(n.diff))}</>}
                                    </div>
                                    {n.needsCheck && (
                                      <div className="text-[10px] font-semibold text-amber-800 flex items-center gap-1">
                                        <AlertTriangle size={10} aria-hidden="true" /> Check: amounts differ by {fmt(Math.abs(n.diff))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* Updated lines */}
              {plan.changedLines.length > 0 && (
                <section className="bg-white rounded-xl border border-blue-200" aria-labelledby="pb-imp-upd-h">
                  <h3 id="pb-imp-upd-h" className="text-xs font-bold text-blue-900 p-3 border-b border-blue-100">
                    Lines already in the CMMS that changed on this report <span className="font-normal text-surface-500">({changedCount} of {plan.changedLines.length} selected)</span>
                  </h3>
                  <ul className="divide-y divide-surface-100">
                    {plan.changedLines.map((ch, i) => (
                      <li key={i} className="px-3 py-1">
                        <label className="flex items-start gap-2 min-h-[44px] cursor-pointer text-xs py-2">
                          <input type="checkbox" checked={choices.changed.has(i)} onChange={() => toggleSet('changed', i)}
                            className="w-4 h-4 mt-0.5 rounded border-surface-300 text-brand-600" />
                          <span className="flex-1">
                            <span className="font-medium text-surface-900">{ch.line.description} {refLabel(ch.line.reference)}</span>
                            <span className="block text-[11px] text-surface-600">
                              {ch.changes.map((c, k) => (
                                <span key={k} className="mr-3">
                                  {c.label}: {typeof c.from === 'number' ? fmt(c.from) : c.from} → <strong>{typeof c.to === 'number' ? fmt(c.to) : c.to}</strong>
                                </span>
                              ))}
                              {ch.becomesCollege && ch.changes.length === 0 && <span className="mr-3">Mark as a college report line</span>}
                              {ch.clearRelease && <span className="text-blue-800 font-semibold">Clears the release request</span>}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Unchanged + informational lists */}
              {plan.unchangedLines.length > 0 && (
                <details className="bg-surface-50 border border-surface-200 rounded-xl p-3">
                  <summary className="text-xs font-semibold text-surface-600 cursor-pointer min-h-[44px] flex items-center">
                    {plan.unchangedLines.length} line{plan.unchangedLines.length === 1 ? '' : 's'} already up to date (skipped)
                  </summary>
                  <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                    {plan.unchangedLines.map((u, i) => (
                      <li key={i} className="text-[11px] text-surface-600 flex justify-between gap-2">
                        <span>{u.line.description} {refLabel(u.line.reference)}</span><span>{fmt(u.line.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.unlinkedOrders.length > 0 && (
                <details className="bg-surface-50 border border-surface-200 rounded-xl p-3">
                  <summary className="text-xs font-semibold text-surface-600 cursor-pointer min-h-[44px] flex items-center">
                    {plan.unlinkedOrders.length} approved CMMS order{plan.unlinkedOrders.length === 1 ? '' : 's'} not on this report — will stay under &ldquo;Not yet on college report&rdquo;
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {plan.unlinkedOrders.map(o => (
                      <li key={o.order_id} className="text-[11px] text-surface-600 flex justify-between gap-2">
                        <span>{o.order_id} · {o.vendor_name || o.other_vendor} · {o.status} · {fmtLocalDate(o.ordered_date || o.order_date)}</span><span>{fmt(parseFloat(o.total) || 0)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.missingFromReport.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
                    <AlertTriangle size={12} aria-hidden="true" /> {plan.missingFromReport.length} college line{plan.missingFromReport.length === 1 ? ' is' : 's are'} in the CMMS but not on this report
                  </p>
                  <p className="text-[11px] text-amber-900 mt-0.5">Nothing is changed. If the college removed or cancelled them, void them on the Transactions tab.</p>
                  <ul className="mt-1 space-y-0.5">
                    {plan.missingFromReport.map(e => (
                      <li key={e.id} className="text-[11px] text-amber-900 flex justify-between gap-2">
                        <span>{e.description} {refLabel(e.reference)}</span><span>{fmt(parseFloat(e.amount) || 0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Action bar */}
              <div className="bg-white rounded-xl border border-surface-200 p-3 flex flex-wrap items-center justify-between gap-3">
                <button type="button" onClick={handleReset}
                  className="px-4 rounded-lg bg-surface-100 text-surface-700 text-xs font-medium hover:bg-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                  <X size={12} className="inline mr-1" aria-hidden="true" /> Cancel
                </button>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] text-surface-600">
                    {newCount} new · {changedCount} updates · {additionCount} additions · {linkCount} order link{linkCount === 1 ? '' : 's'}
                  </span>
                  <button type="button" onClick={handleImport}
                    disabled={actions.saving || (!newCount && !changedCount && !additionCount)}
                    className="px-5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                    {actions.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
                    Import
                  </button>
                </div>
              </div>
              {result && !result.ok && (
                <p role="alert" className="text-xs text-red-700">The import stopped part-way. Re-import the same file — lines already saved will show as up to date and only the rest will be added.</p>
              )}
            </>
          )}
        </>
      )}

      {/* Step: Done */}
      {step === 'done' && result && (
        <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3 text-emerald-500" aria-hidden="true" />
          <h3 className="text-sm font-bold text-surface-900 mb-1">Import Complete</h3>
          <p className="text-xs text-surface-600 mb-4">
            {result.added} new line{result.added === 1 ? '' : 's'}, {result.updated} updated, {result.additions} budget addition{result.additions === 1 ? '' : 's'} and {result.linked} CMMS order link{result.linked === 1 ? '' : 's'} saved to the {schoolYear} budget.
          </p>
          <div className="flex gap-3 justify-center">
            <button type="button" onClick={handleReset}
              className="px-4 rounded-lg bg-surface-100 text-surface-700 text-xs font-medium hover:bg-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
              Import another file
            </button>
            {onViewOverview && (
              <button type="button" onClick={onViewOverview}
                className="px-4 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                View Budget
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCount({ label, value, tone }) {
  const tones = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    surface: 'bg-surface-50 border-surface-200 text-surface-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-800',
  }
  return (
    <div className={`rounded-xl border p-3 text-center ${tones[tone]}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// YEAR MANAGEMENT TAB
// ═══════════════════════════════════════════════════════════════════════════════

function YearManagementTab({ onRefresh, refreshKey }) {
  const { summaries, loading, refresh } = useBudgetYearSummary()
  const actions = useBudgetActions()

  // Setup new year form
  const [setupYear, setSetupYear] = useState('')
  const [setupAmount, setSetupAmount] = useState('')
  const [setupNotes, setSetupNotes] = useState('')

  // re-fetch on refreshKey
  useEffect(() => { refresh() }, [refreshKey])

  // Generate year options (current + 2 future)
  const now = new Date()
  const yearOptions = []
  for (let y = now.getFullYear() - 3; y <= now.getFullYear() + 2; y++) {
    yearOptions.push(`${y}-${y + 1}`)
  }

  const handleSetBalance = async () => {
    if (!setupYear) return toast.error('Select a school year')
    const ok = await actions.setStartingBalance(setupYear, setupAmount, setupNotes)
    if (ok) {
      setSetupAmount('')
      setSetupNotes('')
      refresh()
      onRefresh()
    }
  }

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" aria-hidden="true" />
        <p className="text-sm text-surface-400">Loading year data…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Set Starting Balance */}
      <div className="bg-white rounded-xl border border-surface-200 p-4 max-w-lg">
        <h3 className="text-sm font-bold text-surface-900 mb-3 flex items-center gap-1.5">
          <Calendar size={14} className="text-brand-500" aria-hidden="true" /> Set Starting Balance
        </h3>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pb-fld-school-year-11" className="text-xs font-semibold text-surface-500 mb-1 block">School Year</label>
              <select id="pb-fld-school-year-11" value={setupYear} onChange={e => setSetupYear(e.target.value)}
                className="input text-sm">
                <option value="">Select…</option>
                {yearOptions.map(y => <option key={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="pb-fld-amount-12" className="text-xs font-semibold text-surface-500 mb-1 block">Amount ($)</label>
              <input id="pb-fld-amount-12" type="number" step="0.01" value={setupAmount}
                onChange={e => setSetupAmount(e.target.value)}
                placeholder="e.g. 25000" className="input text-sm" />
            </div>
          </div>
          <div>
            <label htmlFor="pb-fld-notes-13" className="text-xs font-semibold text-surface-500 mb-1 block">Notes</label>
            <input id="pb-fld-notes-13" type="text" value={setupNotes}
              onChange={e => setSetupNotes(e.target.value)}
              placeholder="Optional notes…" className="input text-sm" />
          </div>
          <button onClick={handleSetBalance} disabled={actions.saving}
            className="px-4 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            {actions.saving ? <Loader2 size={12} className="inline animate-spin mr-1" aria-hidden="true" /> : null}
            Set Balance
          </button>
        </div>
      </div>

      {/* Year cards */}
      {summaries.length === 0 ? (
        <div className="text-center py-8">
          <Calendar size={32} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
          <p className="text-sm text-surface-500">No budget years set up yet</p>
          <p className="text-xs text-surface-400 mt-1">Use the form above to set a starting balance</p>
        </div>
      ) : (
        <div className="space-y-3">
          {summaries.map(s => {
            const remainColor = s.remaining < 0 ? 'text-red-600' : s.remaining < s.totalBudget * 0.1 ? 'text-amber-600' : 'text-emerald-600'
            return (
              <div key={s.schoolYear}
                className={`bg-white rounded-xl border overflow-hidden ${
                  s.isCurrent ? 'border-brand-300 ring-1 ring-brand-100' : 'border-surface-200'
                }`}>
                {/* Header */}
                <div className="px-4 py-3 flex items-center justify-between border-b border-surface-100">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-surface-900">{s.schoolYear}</h3>
                    {s.isCurrent && (
                      <span className="text-[9px] font-bold bg-brand-600 text-white px-2 py-0.5 rounded-full">CURRENT</span>
                    )}
                  </div>
                  <span className={`text-xs font-medium ${remainColor}`}>
                    {s.percentUsed}% used
                  </span>
                </div>

                {/* Stats grid */}
                <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <YearStat label="Budget" value={fmt(s.totalBudget)} />
                  <YearStat label="Ledger expenses" value={fmt(s.manualExpenses)} className="text-red-600" />
                  <YearStat label={`CMMS orders not on report (${s.poCount})`} value={fmt(s.poExpenses)} className="text-amber-600" />
                  <YearStat label="Available" value={fmt(s.remaining)} className={remainColor} />
                </div>

                {/* Mini progress */}
                <div className="px-4 pb-3">
                  <div className="h-1.5 bg-surface-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${
                      s.percentUsed > 90 ? 'bg-red-500' : s.percentUsed > 75 ? 'bg-amber-500' : 'bg-brand-500'
                    }`} style={{ width: `${Math.min(s.percentUsed, 100)}%` }} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Highlights matching search text with a yellow background */
function Highlight({ text, search }) {
  if (!search || !text) return text || null
  const s = search.toLowerCase().replace(/^\$/, '')
  if (!s) return text
  const str = String(text)
  const idx = str.toLowerCase().indexOf(s)
  if (idx === -1) return str
  return (
    <>
      {str.slice(0, idx)}
      <mark className="bg-amber-200/70 text-inherit rounded-sm px-0.5">{str.slice(idx, idx + s.length)}</mark>
      {str.slice(idx + s.length)}
    </>
  )
}

function BalanceItem({ label, value, className = 'text-surface-900' }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-surface-400 font-medium mb-0.5">{label}</div>
      <div className={`text-lg font-bold ${className}`}>{value}</div>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, color, sub }) {
  return (
    <div className="bg-white rounded-xl border border-surface-200 p-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${color}`}>
        <Icon size={14} aria-hidden="true" />
      </div>
      <div className="text-[10px] text-surface-500 uppercase tracking-wide">{label}</div>
      <div className="text-sm font-bold text-surface-900 mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-surface-500 mt-0.5">{sub}</div>}
    </div>
  )
}

function TypeBadge({ type }) {
  const styles = {
    'Starting Balance': 'bg-purple-50 text-purple-700',
    'Manual Expense': 'bg-red-50 text-red-700',
    'Income/Grant': 'bg-emerald-50 text-emerald-700',
    'Adjustment': 'bg-blue-50 text-blue-700',
    'Purchase Order': 'bg-amber-50 text-amber-700',
  }
  return (
    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${styles[type] || 'bg-surface-100 text-surface-600'}`}>
      {type}
    </span>
  )
}

function SourceBadge({ source, notes, ledgerSource }) {
  if (source === 'po') return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">CMMS Order</span>
  )
  if (ledgerSource === 'college_report') return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">College Report</span>
  )
  if ((notes || '').includes('Imported from spreadsheet')) return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">Excel Import</span>
  )
  return null
}

function PaymentStatusBadge({ status }) {
  if (!status) return null
  return (
    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${getPaymentStatusColor(status)}`}>
      {status}
    </span>
  )
}

function YearStat({ label, value, className = 'text-surface-900' }) {
  return (
    <div className="bg-surface-50 rounded-lg p-2">
      <div className="text-[9px] text-surface-500 uppercase tracking-wide">{label}</div>
      <div className={`text-xs font-bold mt-0.5 ${className}`}>{value}</div>
    </div>
  )
}
