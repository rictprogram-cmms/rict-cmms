import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
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
  Check, Ban, ChevronUp
} from 'lucide-react'
import toast from 'react-hot-toast'

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
  const [tab, setTab] = useState('overview')
  const [schoolYear, setSchoolYear] = useState(getCurrentSchoolYear())
  const [refreshKey, setRefreshKey] = useState(0)
  const triggerRefresh = () => setRefreshKey(k => k + 1)

  // Instructors get the same full access as super admin
  const isInstructor = profile?.role?.toLowerCase() === 'instructor'
  const hasFullAccess = isSuperAdmin || isInstructor

  if (permsLoading) {
    return (
      <div className="p-6 text-center py-20">
        <Loader2 size={24} className="mx-auto mb-3 text-surface-400 animate-spin" />
        <p className="text-sm text-surface-500">Loading...</p>
      </div>
    )
  }

  // Full access users always see the page; others check permission
  if (!hasFullAccess && !hasPerm('view_page')) {
    return (
      <div className="p-6 text-center py-20">
        <DollarSign size={40} className="mx-auto mb-3 text-surface-300" />
        <p className="text-sm text-surface-500">You do not have permission to access Program Budget.</p>
      </div>
    )
  }

  // Helper: full access users bypass permission checks
  const can = (feature) => hasFullAccess || hasPerm(feature)

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
        <DollarSign size={20} className="text-brand-600" /> Program Budget
      </h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
              tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
            }`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab schoolYear={schoolYear} setSchoolYear={setSchoolYear} refreshKey={refreshKey} />}
      {tab === 'transactions' && (
        <TransactionsTab
          schoolYear={schoolYear}
          refreshKey={refreshKey}
          onRefresh={triggerRefresh}
          canEdit={can('edit_entries')}
          canDelete={can('delete_entries')}
          isSuperAdmin={isSuperAdmin}
        />
      )}
      {tab === 'add' && <AddEntryTab schoolYear={schoolYear} onAdded={triggerRefresh} />}
      {tab === 'import' && <ImportTab schoolYear={schoolYear} onImported={triggerRefresh} />}
      {tab === 'years' && <YearManagementTab onRefresh={triggerRefresh} refreshKey={refreshKey} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ═══════════════════════════════════════════════════════════════════════════════

function OverviewTab({ schoolYear, setSchoolYear, refreshKey }) {
  const { overview, availableYears, loading, refresh } = useBudgetOverview(schoolYear)

  // re-fetch when refreshKey changes
  useEffect(() => { refresh() }, [refreshKey])

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading budget overview…</p>
      </div>
    )
  }

  if (!overview) return <div className="text-center py-12 text-sm text-surface-400">No data available</div>

  const o = overview
  const remainColor = o.percentUsed > 90 ? 'text-red-600' : o.percentUsed > 75 ? 'text-amber-600' : 'text-emerald-600'
  const barColor = o.percentUsed > 90 ? 'bg-red-500' : o.percentUsed > 75 ? 'bg-amber-500' : 'bg-emerald-500'

  // Category chart data
  const catEntries = Object.entries(o.categoryTotals).sort((a, b) => b[1] - a[1])
  const maxCat = catEntries.length > 0 ? catEntries[0][1] : 1

  // Monthly chart data
  const maxMonth = Math.max(...(o.monthlyTrend || []).map(m => m.amount), 1)

  return (
    <div className="space-y-4">
      {/* Hero Card */}
      <div className="bg-white rounded-2xl border border-surface-200 p-5 shadow-sm">
        {/* Year selector */}
        <div className="flex items-center gap-3 mb-4">
          <label className="text-xs text-surface-500 font-medium">School Year</label>
          <select value={schoolYear} onChange={e => setSchoolYear(e.target.value)}
            className="bg-surface-50 text-surface-900 border border-surface-200 rounded-lg px-3 py-1.5 text-sm font-medium">
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* Balance grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          <BalanceItem label="Total Budget" value={fmt(o.totalBudget)} />
          <BalanceItem label="Total Spent" value={fmt(o.totalSpent)} className="text-red-600" />
          <BalanceItem label="Remaining" value={fmt(o.remaining)} className={remainColor} />
          <BalanceItem label="% Used" value={`${o.percentUsed}%`} className={remainColor} />
        </div>

        {/* Progress bar */}
        <div>
          <div className="h-2.5 bg-surface-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-700 ${barColor}`}
              style={{ width: `${Math.min(o.percentUsed, 100)}%` }} />
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] text-surface-400">
            <span>$0</span>
            <span>{fmt(o.totalBudget)}</span>
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard icon={DollarSign} label="Starting Balance" value={fmt(o.startingBalance)} color="bg-purple-100 text-purple-600" />
        <MetricCard icon={ArrowUpCircle} label="Income/Grants" value={fmt(o.income)} color="bg-emerald-100 text-emerald-600" />
        <MetricCard icon={CreditCard} label="Manual Expenses" value={fmt(o.manualExpenses)} color="bg-red-100 text-red-600" />
        <MetricCard icon={ShoppingCart} label={`POs (${o.poCount})`} value={fmt(o.poExpenses)} color="bg-amber-100 text-amber-600" />
      </div>

      {/* Payment Status breakdown */}
      {(o.paidTotal > 0 || o.encumberedTotal > 0 || o.partialTotal > 0) && (
        <div className="bg-white rounded-xl border border-surface-200 p-4">
          <h3 className="text-sm font-semibold text-surface-900 mb-3 flex items-center gap-1.5">
            <CreditCard size={14} className="text-brand-500" /> Payment Status Breakdown
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-emerald-50 rounded-lg p-3 text-center">
              <div className="text-[10px] uppercase tracking-wide text-emerald-600 font-medium">Paid</div>
              <div className="text-sm font-bold text-emerald-700 mt-0.5">{fmt(o.paidTotal)}</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3 text-center">
              <div className="text-[10px] uppercase tracking-wide text-amber-600 font-medium">Encumbered</div>
              <div className="text-sm font-bold text-amber-700 mt-0.5">{fmt(o.encumberedTotal)}</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <div className="text-[10px] uppercase tracking-wide text-blue-600 font-medium">Partial</div>
              <div className="text-sm font-bold text-blue-700 mt-0.5">{fmt(o.partialTotal)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Charts row */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Category breakdown */}
        <div className="bg-white rounded-xl border border-surface-200 p-4">
          <h3 className="text-sm font-semibold text-surface-900 mb-3 flex items-center gap-1.5">
            <PieChart size={14} className="text-brand-500" /> Category Breakdown
          </h3>
          {catEntries.length === 0 ? (
            <p className="text-xs text-surface-400 py-4 text-center">No spending data yet</p>
          ) : (
            <div className="space-y-2.5">
              {catEntries.map(([cat, amt], i) => (
                <div key={cat}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="font-medium text-surface-700">{cat}</span>
                    <span className="text-surface-500">{fmt(amt)}</span>
                  </div>
                  <div className="h-1.5 bg-surface-100 rounded-full overflow-hidden">
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
            <BarChart3 size={14} className="text-brand-500" /> Monthly Spending
          </h3>
          {(o.monthlyTrend || []).length === 0 ? (
            <p className="text-xs text-surface-400 py-4 text-center">No monthly data yet</p>
          ) : (
            <div className="flex items-end gap-1 h-40 pt-2">
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
          )}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS TAB
// ═══════════════════════════════════════════════════════════════════════════════

function TransactionsTab({ schoolYear, refreshKey, onRefresh, canEdit, canDelete, isSuperAdmin }) {
  const { transactions, loading, refresh } = useBudgetTransactions(schoolYear)
  const actions = useBudgetActions()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [expandedId, setExpandedId] = useState(null)

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
      if (t.status === 'Voided') return
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
    })
  }

  const saveEdit = async () => {
    const ok = await actions.editEntry(editingId, editForm)
    if (ok) { setEditingId(null); refresh(); onRefresh() }
  }

  const handleVoid = async (txn) => {
    if (!confirm(`Void entry "${txn.description}"? It will appear with a strikethrough.`)) return
    const ok = await actions.voidEntry(txn.id)
    if (ok) { refresh(); onRefresh() }
  }

  const handlePermanentDelete = async (txn) => {
    if (!confirm(`Permanently delete "${txn.description}" (${fmt(txn.amount)})?\n\nThis will remove it completely from the database and cannot be undone.`)) return
    const ok = await actions.deleteEntry(txn.id)
    if (ok) { refresh(); onRefresh() }
  }

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading transactions…</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search all fields… PO#, amount, code, date…" className="input pl-9 text-sm" />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          className="input text-sm w-auto">
          <option value="all">All Types</option>
          <option value="manual">Manual Only</option>
          <option value="po">POs Only</option>
          <option value="Starting Balance">Starting Balance</option>
          <option value="Manual Expense">Expenses</option>
          <option value="Income/Grant">Income/Grants</option>
          <option value="Adjustment">Adjustments</option>
        </select>
        <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)}
          className="input text-sm w-auto">
          <option value="all">All Statuses</option>
          {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={refresh} className="p-2.5 rounded-lg bg-surface-100 hover:bg-surface-200 text-surface-500">
          <RefreshCw size={14} />
        </button>
      </div>

      <p className="text-xs text-surface-400">{filtered.length} transaction{filtered.length !== 1 ? 's' : ''} · {schoolYear}</p>

      {/* Transaction list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <Receipt size={32} className="mx-auto mb-2 text-surface-300" />
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
                    <input type="text" value={editForm.description}
                      onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                      className="input text-sm" placeholder="Description" />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <input type="number" step="0.01" value={editForm.amount}
                        onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                        className="input text-sm" placeholder="Amount" />
                      <select value={editForm.category}
                        onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                        className="input text-sm">
                        {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                        <option>Purchase Orders</option>
                        <option>Budget</option>
                      </select>
                      <input type="text" value={editForm.reference || ''}
                        onChange={e => setEditForm(f => ({ ...f, reference: e.target.value }))}
                        className="input text-sm" placeholder="PO # / Reference" />
                      <select value={editForm.paymentStatus || ''}
                        onChange={e => setEditForm(f => ({ ...f, paymentStatus: e.target.value }))}
                        className="input text-sm">
                        <option value="">No Status</option>
                        {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select value={editForm.objectCode || ''}
                        onChange={e => setEditForm(f => ({ ...f, objectCode: e.target.value }))}
                        className="input text-sm">
                        <option value="">No Object Code</option>
                        {Object.entries(OBJECT_CODES).map(([code, label]) => (
                          <option key={code} value={code}>{code} - {label}</option>
                        ))}
                      </select>
                      <input type="text" value={editForm.notes || ''}
                        onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                        className="input text-sm" placeholder="Notes" />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={saveEdit}
                        className="px-3 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium">
                        <Save size={11} className="inline mr-1" /> Save
                      </button>
                      <button onClick={() => setEditingId(null)}
                        className="px-3 py-1 rounded-lg bg-surface-100 text-xs text-surface-600">
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
                          iconEl = <ArrowUpCircle size={14} className="text-emerald-600" />
                        } else if (txn.source === 'po') {
                          iconBg = 'bg-amber-100'
                          iconEl = <ShoppingCart size={14} className="text-amber-600" />
                        } else if (isImported) {
                          iconBg = 'bg-blue-100'
                          iconEl = <FileSpreadsheet size={14} className="text-blue-600" />
                        } else {
                          iconBg = 'bg-red-100'
                          iconEl = <ArrowDownCircle size={14} className="text-red-600" />
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
                          <SourceBadge source={txn.source} notes={txn.notes} />
                          {txn.paymentStatus && <PaymentStatusBadge status={txn.paymentStatus} />}
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
                        </div>
                      </div>

                      {/* Amount */}
                      <span className={`text-sm font-bold flex-shrink-0 ${
                        txn.isCredit ? 'text-emerald-600' : 'text-red-600'
                      }`}>
                        {txn.isCredit ? '+' : '-'}<Highlight text={fmt(txn.amount)} search={debouncedSearch} />
                      </span>

                      {/* Expand / Actions */}
                      <div className="flex gap-0.5 flex-shrink-0">
                        {(txn.notes || txn.objectCode) && (
                          <button onClick={() => setExpandedId(isExpanded ? null : txn.id)} title="Details"
                            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-surface-600">
                            {isExpanded ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        )}
                        {txn.source === 'manual' && !isVoided && canEdit && (
                          <button onClick={() => startEdit(txn)} title="Edit"
                            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-brand-600">
                            <Edit3 size={12} />
                          </button>
                        )}
                        {txn.source === 'manual' && !isVoided && canDelete && !isSuperAdmin && (
                          <button onClick={() => handleVoid(txn)} title="Void"
                            className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-600">
                            <Trash2 size={12} />
                          </button>
                        )}
                        {txn.source === 'manual' && canDelete && isSuperAdmin && (
                          <button onClick={() => handlePermanentDelete(txn)}
                            title={isVoided ? 'Permanently delete' : 'Delete'}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-600">
                            <Trash2 size={12} />
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
          <Plus size={16} className="text-brand-600" /> New Budget Entry
          <span className="ml-auto text-[10px] font-normal text-surface-400 bg-surface-100 px-2 py-0.5 rounded-full">{schoolYear}</span>
        </h2>

        {/* Type */}
        <div>
          <label className="text-xs font-semibold text-surface-500 mb-1 block">Type *</label>
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            className="input text-sm">
            {ENTRY_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>

        {/* Description */}
        <div>
          <label className="text-xs font-semibold text-surface-500 mb-1 block">Description *</label>
          <input type="text" value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="e.g. Viking Electric" className="input text-sm" />
        </div>

        {/* Amount + Date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Amount ($) *</label>
            <input type="number" step="0.01" value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              placeholder="0.00" className="input text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Date</label>
            <input type="date" value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="input text-sm" />
          </div>
        </div>

        {/* Reference + Payment Status */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">PO # / Reference</label>
            <input type="text" value={form.reference}
              onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
              placeholder="PO#, CC, Direct Pay…" className="input text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Payment Status</label>
            <select value={form.paymentStatus} onChange={e => setForm(f => ({ ...f, paymentStatus: e.target.value }))}
              className="input text-sm">
              <option value="">Not Set</option>
              {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Object Code + Category */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Object Code</label>
            <select value={form.objectCode} onChange={e => handleCodeChange(e.target.value)}
              className="input text-sm">
              <option value="">None</option>
              {Object.entries(OBJECT_CODES).map(([code, label]) => (
                <option key={code} value={code}>{code} - {label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Category</label>
            <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              className="input text-sm">
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="text-xs font-semibold text-surface-500 mb-1 block">Notes</label>
          <textarea value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Optional notes…" rows={2} className="input text-sm resize-y" />
        </div>

        <button onClick={handleSubmit} disabled={actions.saving}
          className="w-full py-2.5 rounded-xl bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2">
          {actions.saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add Entry
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT TAB  (Suggestion #3 – Spreadsheet Import)
// ═══════════════════════════════════════════════════════════════════════════════

function ImportTab({ schoolYear, onImported }) {
  const actions = useBudgetActions()
  const importer = useSpreadsheetImport(schoolYear)
  const [selectedRows, setSelectedRows] = useState(new Set())
  const [step, setStep] = useState('upload')  // upload → preview → done
  const [isDragging, setIsDragging] = useState(false)

  // Track review decisions for potential matches: 'accepted' | 'declined' | undefined
  const [reviewDecisions, setReviewDecisions] = useState({})
  // Track which review card is expanded for side-by-side
  const [expandedReview, setExpandedReview] = useState(null)

  const processFile = async (file) => {
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['xls', 'xlsx', 'csv'].includes(ext)) {
      toast.error('Please upload a .xls, .xlsx, or .csv file')
      return
    }
    await importer.parseFile(file)
    setStep('preview')
    setReviewDecisions({})
    setExpandedReview(null)
  }

  const handleFile = async (e) => {
    processFile(e.target.files?.[0])
  }

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

  // Pull parsed data
  const newEntries = importer.parsed?.newEntries || []
  const exactDuplicates = importer.parsed?.exactDuplicates || []
  const potentialMatches = importer.parsed?.potentialMatches || []
  const meta = importer.parsed?.meta || {}

  // Entries accepted from review
  const acceptedFromReview = potentialMatches
    .filter((_, i) => reviewDecisions[i] === 'accepted')
    .map(pm => pm.entry)

  // Combined importable entries: confirmed new + accepted from review
  const allImportable = [...newEntries, ...acceptedFromReview]

  // Selection management (indexes into newEntries only; accepted review items always included)
  useEffect(() => {
    if (importer.parsed?.newEntries) {
      setSelectedRows(new Set(importer.parsed.newEntries.map((_, i) => i)))
    }
  }, [importer.parsed?.newEntries])

  const selectAll = () => setSelectedRows(new Set(newEntries.map((_, i) => i)))
  const selectNone = () => setSelectedRows(new Set())
  const toggleRow = (idx) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  // Review actions
  const acceptMatch = (idx) => setReviewDecisions(d => ({ ...d, [idx]: 'accepted' }))
  const declineMatch = (idx) => setReviewDecisions(d => ({ ...d, [idx]: 'declined' }))
  const resetMatch = (idx) => setReviewDecisions(d => {
    const next = { ...d }
    delete next[idx]
    return next
  })
  const acceptAllMatches = () => {
    const all = {}
    potentialMatches.forEach((_, i) => { all[i] = 'accepted' })
    setReviewDecisions(all)
  }
  const declineAllMatches = () => {
    const all = {}
    potentialMatches.forEach((_, i) => { all[i] = 'declined' })
    setReviewDecisions(all)
  }

  // Count pending reviews
  const pendingReviews = potentialMatches.filter((_, i) => !reviewDecisions[i]).length

  const handleImport = async () => {
    const selectedNew = newEntries.filter((_, i) => selectedRows.has(i))
    const rowsToImport = [...selectedNew, ...acceptedFromReview]
    if (rowsToImport.length === 0) return toast.error('No entries selected')

    const ok = await actions.bulkImport(rowsToImport, schoolYear)
    if (ok) { setStep('done'); onImported() }
  }

  const handleReset = () => {
    importer.reset()
    setStep('upload')
    setSelectedRows(new Set())
    setReviewDecisions({})
    setExpandedReview(null)
  }

  // Date formatter
  const fmtDate = (d) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      if (isNaN(dt.getTime())) return '—'
      return dt.toLocaleDateString('en-US', { timeZone: 'UTC' })
    } catch { return '—' }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border border-surface-200 p-5">
        <h2 className="text-sm font-bold text-surface-900 flex items-center gap-2 mb-1">
          <FileSpreadsheet size={16} className="text-brand-600" /> Import Budget from Spreadsheet
          <span className="ml-auto text-[10px] font-normal text-surface-400 bg-surface-100 px-2 py-0.5 rounded-full">{schoolYear}</span>
        </h2>
        <p className="text-xs text-surface-500">
          Upload a .xls, .xlsx, or .csv file. The RICT budget format is auto-detected. Exact duplicates are skipped, and similar entries are flagged for your review.
        </p>
      </div>

      {/* Step: Upload */}
      {step === 'upload' && (
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`bg-white rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
            isDragging ? 'border-brand-400 bg-brand-50/50' : 'border-surface-300'
          }`}
        >
          <Upload size={32} className={`mx-auto mb-3 transition-colors ${isDragging ? 'text-brand-500' : 'text-surface-400'}`} />
          <p className="text-sm font-medium text-surface-700 mb-1">
            {isDragging ? 'Drop your file here…' : 'Drag & drop a spreadsheet here, or click to browse'}
          </p>
          <p className="text-xs text-surface-400 mb-4">Supports .xls, .xlsx, .csv files</p>
          <label className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 text-white text-sm font-semibold cursor-pointer hover:bg-brand-700 transition-colors">
            <FileSpreadsheet size={16} />
            Choose File
            <input type="file" accept=".xls,.xlsx,.csv" onChange={handleFile} className="hidden" />
          </label>
        </div>
      )}

      {/* Parsing indicator */}
      {importer.parsing && (
        <div className="text-center py-12">
          <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
          <p className="text-sm text-surface-400">Parsing spreadsheet and checking for duplicates…</p>
        </div>
      )}

      {/* Error */}
      {importer.error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to parse file</p>
            <p className="text-xs text-red-600 mt-1">{importer.error}</p>
            <button onClick={handleReset} className="mt-2 text-xs font-medium text-red-700 underline">Try again</button>
          </div>
        </div>
      )}

      {/* Step: Preview */}
      {step === 'preview' && importer.parsed && (
        <>
          {/* Meta info */}
          {meta.program && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <h3 className="text-xs font-bold text-blue-800 mb-2 flex items-center gap-1.5">
                <FileText size={13} /> Detected RICT Budget Format
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {meta.program && (
                  <div><span className="text-blue-500">Program:</span> <span className="font-medium text-blue-800">{meta.program}</span></div>
                )}
                {meta.fiscalYear && (
                  <div><span className="text-blue-500">FY:</span> <span className="font-medium text-blue-800">{meta.fiscalYear}</span></div>
                )}
                {meta.account && (
                  <div><span className="text-blue-500">Account:</span> <span className="font-medium text-blue-800">{meta.account}</span></div>
                )}
                {meta.beginningBalance > 0 && (
                  <div><span className="text-blue-500">Beginning Bal:</span> <span className="font-medium text-blue-800">{fmt(meta.beginningBalance)}</span></div>
                )}
              </div>
            </div>
          )}

          {/* Summary cards — 4 columns now */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-surface-200 p-3 text-center">
              <div className="text-lg font-bold text-surface-900">{importer.parsed.totalFromFile}</div>
              <div className="text-[10px] text-surface-500 uppercase tracking-wide">In File</div>
            </div>
            <div className="bg-emerald-50 rounded-xl border border-emerald-200 p-3 text-center">
              <div className="text-lg font-bold text-emerald-700">{newEntries.length}</div>
              <div className="text-[10px] text-emerald-600 uppercase tracking-wide">New</div>
            </div>
            <div className="bg-orange-50 rounded-xl border border-orange-200 p-3 text-center">
              <div className="text-lg font-bold text-orange-700">{potentialMatches.length}</div>
              <div className="text-[10px] text-orange-600 uppercase tracking-wide">Needs Review</div>
            </div>
            <div className="bg-surface-50 rounded-xl border border-surface-200 p-3 text-center">
              <div className="text-lg font-bold text-surface-500">{exactDuplicates.length}</div>
              <div className="text-[10px] text-surface-400 uppercase tracking-wide">Exact Duplicates</div>
            </div>
          </div>

          {/* ═══ SECTION 1: Potential Matches — Needs Review ═══ */}
          {potentialMatches.length > 0 && (
            <div className="bg-white rounded-xl border border-orange-200 overflow-hidden">
              <div className="p-3 border-b border-orange-100 bg-orange-50/50">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-orange-800 flex items-center gap-1.5">
                    <HelpCircle size={13} className="text-orange-500" />
                    {potentialMatches.length} Potential Match{potentialMatches.length !== 1 ? 'es' : ''} — Please Review
                    {pendingReviews > 0 && (
                      <span className="text-[9px] bg-orange-200 text-orange-800 px-1.5 py-0.5 rounded-full ml-1">
                        {pendingReviews} pending
                      </span>
                    )}
                  </h3>
                  <div className="flex gap-2">
                    <button onClick={declineAllMatches}
                      className="text-[10px] font-medium text-surface-500 hover:text-red-600 hover:underline">
                      Skip All
                    </button>
                    <button onClick={acceptAllMatches}
                      className="text-[10px] font-medium text-emerald-600 hover:underline">
                      Import All
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-orange-600 mt-1">
                  These entries look similar to records already in the system. Compare side-by-side and decide whether to import.
                </p>
              </div>

              <div className="divide-y divide-surface-100 max-h-[500px] overflow-y-auto">
                {potentialMatches.map((pm, idx) => {
                  const decision = reviewDecisions[idx]
                  const isExpanded = expandedReview === idx

                  return (
                    <div key={idx} className={`transition-colors ${
                      decision === 'accepted' ? 'bg-emerald-50/40' :
                      decision === 'declined' ? 'bg-surface-50/60 opacity-60' : ''
                    }`}>
                      {/* Summary row */}
                      <div className="px-4 py-3 flex items-center gap-3">
                        {/* Status indicator */}
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                          decision === 'accepted' ? 'bg-emerald-100' :
                          decision === 'declined' ? 'bg-surface-200' :
                          'bg-orange-100'
                        }`}>
                          {decision === 'accepted' ? <Check size={12} className="text-emerald-600" /> :
                           decision === 'declined' ? <Ban size={12} className="text-surface-400" /> :
                           <HelpCircle size={12} className="text-orange-500" />}
                        </div>

                        {/* Entry info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-surface-900">{pm.entry.description}</span>
                            <span className="font-bold text-surface-700">{fmt(pm.entry.amount)}</span>
                            <span className="text-surface-400">{fmtDate(pm.entry.date)}</span>
                          </div>
                          <div className="text-[10px] text-surface-400 mt-0.5 flex items-center gap-1">
                            <span>Similar to:</span>
                            <span className="font-medium text-surface-600">{pm.match.description}</span>
                            <span>({fmt(pm.match.amount)})</span>
                            <span className="italic text-orange-500 ml-1">
                              {pm.match.source === 'po' ? 'Purchase Order' : 'Budget Entry'}
                            </span>
                          </div>
                        </div>

                        {/* Expand toggle */}
                        <button
                          onClick={() => setExpandedReview(isExpanded ? null : idx)}
                          className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-surface-600 flex-shrink-0"
                          title="Compare side-by-side"
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <Eye size={14} />}
                        </button>

                        {/* Action buttons */}
                        {!decision ? (
                          <div className="flex gap-1.5 flex-shrink-0">
                            <button onClick={() => declineMatch(idx)}
                              className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-surface-100 text-surface-600 hover:bg-red-50 hover:text-red-600 transition-colors"
                              title="Skip — it's a duplicate">
                              Skip
                            </button>
                            <button onClick={() => acceptMatch(idx)}
                              className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors"
                              title="Import — it's a new entry">
                              Import
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => resetMatch(idx)}
                            className="px-2.5 py-1.5 rounded-lg text-[10px] font-medium text-surface-400 hover:text-surface-600 hover:bg-surface-100">
                            Undo
                          </button>
                        )}
                      </div>

                      {/* Expanded side-by-side comparison */}
                      {isExpanded && (
                        <div className="px-4 pb-4">
                          <div className="grid grid-cols-2 gap-3">
                            {/* From Spreadsheet */}
                            <div className="bg-blue-50 rounded-lg border border-blue-200 p-3">
                              <div className="text-[9px] font-bold text-blue-600 uppercase tracking-wide mb-2 flex items-center gap-1">
                                <FileSpreadsheet size={10} /> From Spreadsheet
                              </div>
                              <CompareField label="Vendor" value={pm.entry.description} otherValue={pm.match.description} />
                              <CompareField label="Amount" value={fmt(pm.entry.amount)} otherValue={fmt(pm.match.amount)} />
                              <CompareField label="Date" value={fmtDate(pm.entry.date)} otherValue={fmtDate(pm.match.date)} />
                              <CompareField label="Reference" value={pm.entry.reference || '—'} otherValue={pm.match.reference || '—'} />
                              {pm.entry.objectCode && (
                                <div className="text-[10px] mt-1">
                                  <span className="text-surface-500">Code:</span>{' '}
                                  <span className="font-mono text-surface-700">{pm.entry.objectCode}</span>
                                </div>
                              )}
                              {pm.entry.paymentStatus && (
                                <div className="mt-1">
                                  <PaymentStatusBadge status={pm.entry.paymentStatus} />
                                </div>
                              )}
                            </div>

                            {/* Existing in Database */}
                            <div className="bg-surface-50 rounded-lg border border-surface-200 p-3">
                              <div className="text-[9px] font-bold text-surface-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                                <Receipt size={10} /> Existing in Database
                                <span className="text-[8px] font-normal ml-auto bg-surface-200 px-1.5 py-0.5 rounded-full">
                                  {pm.match.source === 'po' ? 'Purchase Order' : 'Budget Entry'}
                                </span>
                              </div>
                              <CompareField label="Vendor" value={pm.match.description} otherValue={pm.entry.description} reverse />
                              <CompareField label="Amount" value={fmt(pm.match.amount)} otherValue={fmt(pm.entry.amount)} reverse />
                              <CompareField label="Date" value={fmtDate(pm.match.date)} otherValue={fmtDate(pm.entry.date)} reverse />
                              <CompareField label="Reference" value={pm.match.reference || '—'} otherValue={pm.entry.reference || '—'} reverse />
                              {pm.match.type && (
                                <div className="text-[10px] mt-1">
                                  <span className="text-surface-500">Type:</span>{' '}
                                  <span className="text-surface-700">{pm.match.type}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Quick decision from expanded view */}
                          {!decision && (
                            <div className="flex justify-center gap-3 mt-3">
                              <button onClick={() => declineMatch(idx)}
                                className="px-4 py-2 rounded-lg text-xs font-semibold bg-surface-100 text-surface-600 hover:bg-red-50 hover:text-red-600 flex items-center gap-1.5">
                                <Ban size={12} /> Same entry — Skip
                              </button>
                              <button onClick={() => acceptMatch(idx)}
                                className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-100 text-emerald-700 hover:bg-emerald-200 flex items-center gap-1.5">
                                <Check size={12} /> Different entry — Import
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ═══ SECTION 2: Exact Duplicates (collapsed) ═══ */}
          {exactDuplicates.length > 0 && (
            <div className="bg-surface-50 border border-surface-200 rounded-xl p-4">
              <h3 className="text-xs font-bold text-surface-500 mb-2 flex items-center gap-1.5">
                <CheckCircle2 size={13} className="text-surface-400" />
                {exactDuplicates.length} Exact Duplicate{exactDuplicates.length !== 1 ? 's' : ''} (auto-skipped)
              </h3>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {exactDuplicates.map((d, i) => (
                  <div key={i} className="text-xs text-surface-500 flex gap-2">
                    <span className="font-medium">{d.entry.description}</span>
                    <span>{fmt(d.entry.amount)}</span>
                    <span className="text-surface-400">— matches {d.match.source === 'po' ? 'PO' : 'budget entry'}: {d.match.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ═══ SECTION 3: New Entries to Import ═══ */}
          {(newEntries.length > 0 || acceptedFromReview.length > 0) ? (
            <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
              <div className="p-3 border-b border-surface-100 flex items-center justify-between">
                <h3 className="text-xs font-bold text-surface-900">
                  Entries to Import
                  <span className="font-normal text-surface-400 ml-1.5">
                    {newEntries.length > 0 && `${selectedRows.size} of ${newEntries.length} new selected`}
                    {acceptedFromReview.length > 0 && (newEntries.length > 0 ? ' + ' : '') + `${acceptedFromReview.length} from review`}
                  </span>
                </h3>
                {newEntries.length > 0 && (
                  <div className="flex gap-2">
                    <button onClick={selectAll} className="text-[10px] font-medium text-brand-600 hover:underline">Select All</button>
                    <button onClick={selectNone} className="text-[10px] font-medium text-surface-500 hover:underline">Deselect All</button>
                  </div>
                )}
              </div>

              <div className="max-h-[400px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-surface-50 sticky top-0">
                    <tr>
                      <th className="w-8 p-2"></th>
                      <th className="text-left p-2 font-semibold text-surface-500">Date</th>
                      <th className="text-left p-2 font-semibold text-surface-500">Description</th>
                      <th className="text-left p-2 font-semibold text-surface-500">Reference</th>
                      <th className="text-left p-2 font-semibold text-surface-500">Code</th>
                      <th className="text-left p-2 font-semibold text-surface-500">Status</th>
                      <th className="text-right p-2 font-semibold text-surface-500">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* New entries (selectable) */}
                    {newEntries.map((entry, idx) => (
                      <tr key={`new-${idx}`}
                        onClick={() => toggleRow(idx)}
                        className={`cursor-pointer border-t border-surface-50 transition-colors ${
                          selectedRows.has(idx) ? 'bg-brand-50/50' : 'hover:bg-surface-50'
                        }`}>
                        <td className="p-2 text-center">
                          <input type="checkbox" checked={selectedRows.has(idx)}
                            onChange={() => toggleRow(idx)}
                            className="w-3.5 h-3.5 rounded border-surface-300 text-brand-600" />
                        </td>
                        <td className="p-2 text-surface-600 whitespace-nowrap">{fmtDate(entry.date)}</td>
                        <td className="p-2 font-medium text-surface-900">{entry.description}</td>
                        <td className="p-2 text-surface-500 font-mono">{entry.reference || '—'}</td>
                        <td className="p-2 text-surface-500 font-mono">{entry.objectCode || '—'}</td>
                        <td className="p-2">
                          {entry.paymentStatus ? (
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${getPaymentStatusColor(entry.paymentStatus)}`}>
                              {entry.paymentStatus}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="p-2 text-right font-bold text-surface-900">{fmt(entry.amount)}</td>
                      </tr>
                    ))}

                    {/* Accepted from review (always included, shown with green indicator) */}
                    {acceptedFromReview.map((entry, idx) => (
                      <tr key={`review-${idx}`}
                        className="border-t border-surface-50 bg-emerald-50/30">
                        <td className="p-2 text-center">
                          <Check size={12} className="text-emerald-500 mx-auto" />
                        </td>
                        <td className="p-2 text-surface-600 whitespace-nowrap">{fmtDate(entry.date)}</td>
                        <td className="p-2 font-medium text-surface-900">
                          {entry.description}
                          <span className="text-[9px] ml-1.5 text-emerald-600 bg-emerald-100 px-1 py-0.5 rounded">from review</span>
                        </td>
                        <td className="p-2 text-surface-500 font-mono">{entry.reference || '—'}</td>
                        <td className="p-2 text-surface-500 font-mono">{entry.objectCode || '—'}</td>
                        <td className="p-2">
                          {entry.paymentStatus ? (
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${getPaymentStatusColor(entry.paymentStatus)}`}>
                              {entry.paymentStatus}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="p-2 text-right font-bold text-surface-900">{fmt(entry.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-surface-50 border-t border-surface-200">
                    <tr>
                      <td colSpan={6} className="p-2 text-right font-semibold text-surface-600">
                        Import Total:
                      </td>
                      <td className="p-2 text-right font-bold text-surface-900">
                        {fmt(
                          newEntries.filter((_, i) => selectedRows.has(i)).reduce((sum, e) => sum + e.amount, 0) +
                          acceptedFromReview.reduce((sum, e) => sum + e.amount, 0)
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Action bar */}
              <div className="p-3 border-t border-surface-200 bg-surface-50 flex items-center justify-between">
                <button onClick={handleReset}
                  className="px-4 py-2 rounded-lg bg-surface-200 text-surface-600 text-xs font-medium hover:bg-surface-300">
                  <X size={12} className="inline mr-1" /> Cancel
                </button>
                <div className="flex items-center gap-3">
                  {pendingReviews > 0 && (
                    <span className="text-[10px] text-orange-600 flex items-center gap-1">
                      <AlertTriangle size={10} /> {pendingReviews} match{pendingReviews !== 1 ? 'es' : ''} still need review
                    </span>
                  )}
                  <button onClick={handleImport}
                    disabled={actions.saving || (selectedRows.size === 0 && acceptedFromReview.length === 0)}
                    className="px-5 py-2 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2">
                    {actions.saving ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    Import {selectedRows.size + acceptedFromReview.length} Entr{(selectedRows.size + acceptedFromReview.length) === 1 ? 'y' : 'ies'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
              <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-400" />
              <p className="text-sm font-medium text-surface-700">
                {potentialMatches.length > 0
                  ? 'Review the potential matches above, then import any accepted entries.'
                  : 'All entries already exist in the database'}
              </p>
              <p className="text-xs text-surface-400 mt-1">Nothing new to import</p>
              <button onClick={handleReset} className="mt-3 text-xs font-medium text-brand-600 hover:underline">Upload a different file</button>
            </div>
          )}
        </>
      )}

      {/* Step: Done */}
      {step === 'done' && (
        <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3 text-emerald-500" />
          <h3 className="text-sm font-bold text-surface-900 mb-1">Import Complete</h3>
          <p className="text-xs text-surface-500 mb-4">
            Successfully imported entries into the {schoolYear} budget.
          </p>
          <div className="flex gap-3 justify-center">
            <button onClick={handleReset}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-xs font-medium hover:bg-surface-200">
              Import More
            </button>
            <button onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700">
              View Budget
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Side-by-side field comparison — highlights differences */
function CompareField({ label, value, otherValue, reverse = false }) {
  const isDifferent = value !== otherValue && value !== '—' && otherValue !== '—'
  return (
    <div className="text-[10px] mt-1 flex items-baseline gap-1.5">
      <span className="text-surface-400 w-14 flex-shrink-0">{label}:</span>
      <span className={`font-medium ${
        isDifferent
          ? (reverse ? 'text-surface-700' : 'text-blue-800')
          : 'text-surface-700'
      }`}>
        {value}
      </span>
      {isDifferent && (
        <span className={`text-[9px] px-1 py-0.5 rounded ${
          reverse ? 'bg-blue-100 text-blue-600' : 'bg-surface-200 text-surface-500'
        }`}>
          ≠
        </span>
      )}
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
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading year data…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Set Starting Balance */}
      <div className="bg-white rounded-xl border border-surface-200 p-4 max-w-lg">
        <h3 className="text-sm font-bold text-surface-900 mb-3 flex items-center gap-1.5">
          <Calendar size={14} className="text-brand-500" /> Set Starting Balance
        </h3>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-surface-500 mb-1 block">School Year</label>
              <select value={setupYear} onChange={e => setSetupYear(e.target.value)}
                className="input text-sm">
                <option value="">Select…</option>
                {yearOptions.map(y => <option key={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-surface-500 mb-1 block">Amount ($)</label>
              <input type="number" step="0.01" value={setupAmount}
                onChange={e => setSetupAmount(e.target.value)}
                placeholder="e.g. 25000" className="input text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Notes</label>
            <input type="text" value={setupNotes}
              onChange={e => setSetupNotes(e.target.value)}
              placeholder="Optional notes…" className="input text-sm" />
          </div>
          <button onClick={handleSetBalance} disabled={actions.saving}
            className="px-4 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50">
            {actions.saving ? <Loader2 size={12} className="inline animate-spin mr-1" /> : null}
            Set Balance
          </button>
        </div>
      </div>

      {/* Year cards */}
      {summaries.length === 0 ? (
        <div className="text-center py-8">
          <Calendar size={32} className="mx-auto mb-2 text-surface-300" />
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
                  <YearStat label="Manual" value={fmt(s.manualExpenses)} className="text-red-600" />
                  <YearStat label={`POs (${s.poCount})`} value={fmt(s.poExpenses)} className="text-amber-600" />
                  <YearStat label="Remaining" value={fmt(s.remaining)} className={remainColor} />
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

function MetricCard({ icon: Icon, label, value, color }) {
  return (
    <div className="bg-white rounded-xl border border-surface-200 p-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${color}`}>
        <Icon size={14} />
      </div>
      <div className="text-[10px] text-surface-500 uppercase tracking-wide">{label}</div>
      <div className="text-sm font-bold text-surface-900 mt-0.5">{value}</div>
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

function SourceBadge({ source, notes }) {
  if (source === 'po') return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">PO</span>
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
