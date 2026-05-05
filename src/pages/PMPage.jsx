import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import {
  usePMSchedules, usePMActions, useActiveAssets, usePMGlobalPause, calculateNextDueDate
} from '@/hooks/usePMSchedules'
import {
  Wrench, Plus, Search, Calendar, AlertTriangle, CheckCircle2,
  Clock, Play, Pause, Trash2, Edit3, ChevronDown, ChevronUp,
  Loader2, Settings, Zap, X, FileText, Upload, Download,
  Eye, XCircle, ShieldAlert, PauseCircle, PlayCircle, Info,
  RotateCcw, Link2
} from 'lucide-react'

function fmtDate(d) {
  if (!d) return '—'
  // Extract the YYYY-MM-DD portion and parse as LOCAL midnight to avoid the UTC→CST
  // off-by-one shift. Works for bare dates, "+00:00" offsets, and "Z" suffixes.
  if (typeof d === 'string') {
    const datePart = d.substring(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      const dt = new Date(datePart + 'T00:00:00')
      if (!isNaN(dt)) return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }
  }
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const FREQ_OPTIONS = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Annually', 'Custom']

// Map frequency → human-readable due date description
function getDueDateLabel(freq) {
  switch (freq) {
    case 'Daily': return 'Due: Next day'
    case 'Weekly': return 'Due: 1 week out'
    default: return 'Due: 3 weeks out'
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function PMPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('PM')
  const { schedules, loading, refresh } = usePMSchedules()
  const actions = usePMActions()
  const assets = useActiveAssets()
  const globalPause = usePMGlobalPause()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('Active')
  const [showForm, setShowForm] = useState(false)
  const [editingPM, setEditingPM] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [openWOMap, setOpenWOMap] = useState({}) // pm_id -> open WO info
  const [sopLinkedPMIds, setSopLinkedPMIds] = useState(new Set()) // pm_ids that have a linked SOP

  // Load open PM work orders to show duplicate status
  useEffect(() => {
    async function loadOpenPMWOs() {
      try {
        const { data } = await supabase
          .from('work_orders')
          .select('wo_id, pm_id, status')
          .not('pm_id', 'is', null)
          .neq('pm_id', '')
        if (data) {
          const map = {}
          data.forEach(wo => {
            if (wo.pm_id) map[wo.pm_id] = wo
          })
          setOpenWOMap(map)
        }
      } catch {}
    }
    loadOpenPMWOs()
  }, [schedules])

  // Load PM IDs that have a linked SOP — with Realtime so badge updates live
  useEffect(() => {
    async function loadSopLinkedPMs() {
      try {
        const { data } = await supabase
          .from('sop_pm_schedules')
          .select('pm_id')
        if (data) setSopLinkedPMIds(new Set(data.map(r => r.pm_id)))
      } catch {}
    }
    loadSopLinkedPMs()
    const channel = supabase
      .channel('sop-pm-schedules-pm-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sop_pm_schedules' }, () => loadSopLinkedPMs())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, []) // own lifecycle — no dependency on schedules

  const filtered = useMemo(() => {
    let list = schedules
    if (statusFilter) list = list.filter(s => s.status === statusFilter)
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(pm =>
        (pm.pm_name || '').toLowerCase().includes(s) ||
        (pm.asset_name || '').toLowerCase().includes(s) ||
        (pm.pm_id || '').toLowerCase().includes(s)
      )
    }
    return list
  }, [schedules, search, statusFilter])

  const overdue = schedules.filter(s => s.isOverdue && s.status === 'Active').length
  const dueSoon = schedules.filter(s => s.isDueSoon && s.status === 'Active').length
  const activeCount = schedules.filter(s => s.status === 'Active').length
  const pausedCount = schedules.filter(s => s.status === 'Paused').length
  const archivedCount = schedules.filter(s => s.status === 'Archived').length
  const withProcedure = schedules.filter(s => !!s.procedure_file_id || sopLinkedPMIds.has(s.pm_id)).length

  const handleEdit = (pm) => {
    setEditingPM(pm)
    setShowForm(true)
  }

  const handleDelete = async (pmId) => {
    if (!confirm('Delete this PM schedule? This cannot be undone.')) return
    await actions.deletePM(pmId)
    refresh()
  }

  const handleGenerate = async (pmId) => {
    // Check for open WO first (UI-level check)
    const existing = openWOMap[pmId]
    if (existing) {
      if (!confirm(`⚠️ ${existing.wo_id} (${existing.status}) is still open for this PM.\n\nThe system will not generate a duplicate. Close the existing WO first.\n\nOpen the Work Orders page instead?`)) return
      return
    }
    if (!confirm('Generate a work order from this PM schedule?')) return
    const woId = await actions.generateWO(pmId)
    if (woId) refresh()
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
            <Wrench size={20} className="text-brand-600" /> Preventive Maintenance
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {activeCount} active schedule{activeCount !== 1 && 's'}
            {withProcedure > 0 && <> · {withProcedure} with procedure</>}
            {archivedCount > 0 && <> · {archivedCount} archived</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasPerm('create_pm') && (
            <button onClick={() => { setEditingPM(null); setShowForm(true) }} className="btn-primary text-sm gap-1.5">
              <Plus size={14} /> New PM Schedule
            </button>
          )}
        </div>
      </div>

      {/* ── Global Pause Banner (Instructor only) ── */}
      {hasPerm('pause_generation') && (
        <div className={`rounded-xl border-2 px-4 py-3 flex items-center justify-between transition-all ${
          globalPause.paused
            ? 'bg-amber-50 border-amber-300'
            : 'bg-emerald-50 border-emerald-200'
        }`}>
          <div className="flex items-center gap-3">
            {globalPause.paused ? (
              <PauseCircle size={22} className="text-amber-600 flex-shrink-0" />
            ) : (
              <PlayCircle size={22} className="text-emerald-600 flex-shrink-0" />
            )}
            <div>
              <div className={`text-sm font-semibold ${globalPause.paused ? 'text-amber-800' : 'text-emerald-800'}`}>
                PM Generation: {globalPause.paused ? 'PAUSED' : 'ACTIVE'}
              </div>
              <div className="text-xs text-surface-500">
                {globalPause.paused
                  ? 'All PM work order generation is paused. Use this during summer/winter break.'
                  : 'PM work orders will generate according to their schedules.'}
              </div>
            </div>
          </div>
          <button
            onClick={globalPause.toggle}
            disabled={globalPause.saving}
            className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all ${
              globalPause.paused
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-amber-500 text-white hover:bg-amber-600'
            } disabled:opacity-50`}
          >
            {globalPause.saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : globalPause.paused ? (
              <Play size={14} />
            ) : (
              <Pause size={14} />
            )}
            {globalPause.paused ? 'Resume Generation' : 'Pause for Break'}
          </button>
        </div>
      )}

      {/* Non-manager pause notice */}
      {!hasPerm('pause_generation') && globalPause.paused && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3">
          <PauseCircle size={18} className="text-amber-600 flex-shrink-0" />
          <span className="text-sm text-amber-800">PM work order generation is currently paused by an instructor.</span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-surface-200 p-3 text-center">
          <div className="text-2xl font-bold text-surface-900">{activeCount}</div>
          <div className="text-xs text-surface-500">Active</div>
        </div>
        <div className={`rounded-xl border p-3 text-center ${overdue > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-surface-200'}`}>
          <div className={`text-2xl font-bold ${overdue > 0 ? 'text-red-600' : 'text-surface-900'}`}>{overdue}</div>
          <div className="text-xs text-surface-500">Overdue</div>
        </div>
        <div className={`rounded-xl border p-3 text-center ${dueSoon > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-white border-surface-200'}`}>
          <div className={`text-2xl font-bold ${dueSoon > 0 ? 'text-yellow-600' : 'text-surface-900'}`}>{dueSoon}</div>
          <div className="text-xs text-surface-500">Due This Week</div>
        </div>
        <div className="bg-white rounded-xl border border-surface-200 p-3 text-center">
          <div className="text-2xl font-bold text-surface-900">{pausedCount}</div>
          <div className="text-xs text-surface-500">Paused</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search schedules..." className="input pl-9 text-sm" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input text-sm w-auto">
          <option value="">All Status</option>
          <option value="Active">Active</option>
          <option value="Paused">Paused</option>
          <option value="Archived">Archived</option>
        </select>
      </div>

      {/* Create/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) { setShowForm(false); setEditingPM(null) } }}>
          <PMForm pm={editingPM} assets={assets} actions={actions}
            onClose={() => { setShowForm(false); setEditingPM(null) }}
            onSaved={() => { setShowForm(false); setEditingPM(null); refresh() }} />
        </div>
      )}

      {/* Schedule List */}
      {loading ? (
        <div className="text-center py-12 text-surface-400">
          <Loader2 size={24} className="animate-spin mx-auto mb-2" />
          Loading PM schedules...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <Wrench size={36} className="mx-auto mb-3 text-surface-300" />
          <p className="text-sm text-surface-400">No PM schedules found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(pm => (
            <PMCard key={pm.pm_id} pm={pm}
              expanded={expandedId === pm.pm_id}
              onToggle={() => setExpandedId(expandedId === pm.pm_id ? null : pm.pm_id)}
              onEdit={() => handleEdit(pm)}
              onDelete={() => handleDelete(pm.pm_id)}
              onGenerate={() => handleGenerate(pm.pm_id)}
              saving={actions.saving}
              openWO={openWOMap[pm.pm_id] || null}
              globalPaused={globalPause.paused}
              sopLinkedPMIds={sopLinkedPMIds}
              actions={actions} />
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PM CARD
// ═══════════════════════════════════════════════════════════════════════════════

function PMCard({ pm, expanded, onToggle, onEdit, onDelete, onGenerate, saving, openWO, globalPaused, sopLinkedPMIds = new Set(), actions }) {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('PM')

  // Linked SOP names — loaded lazily when the card first expands
  const [linkedSOPs, setLinkedSOPs] = useState([])
  const [sopsLoading, setSopsLoading] = useState(false)
  const fetchedRef = useState(false) // [value, setter] — use index 0

  const statusColor = pm.isOverdue
    ? 'border-l-red-500 bg-red-50/50'
    : pm.isDueSoon
      ? 'border-l-yellow-500 bg-yellow-50/50'
      : pm.status === 'Paused'
        ? 'border-l-surface-300 bg-surface-50'
        : pm.status === 'Archived'
          ? 'border-l-surface-200 bg-surface-50/60 opacity-75'
          : 'border-l-emerald-500'

  // Has a directly-attached procedure file
  const hasFileProcedure = !!pm.procedure_file_id
  // Has a procedure via a linked SOP (even if no direct file)
  const hasSopProcedure = !hasFileProcedure && sopLinkedPMIds.has(pm.pm_id)
  // Show the badge if either source provides a procedure
  const hasProcedure = hasFileProcedure || hasSopProcedure

  // Fetch linked SOP names once when the card expands and hasSopProcedure is true
  useEffect(() => {
    if (!expanded || !hasSopProcedure || fetchedRef[0]) return
    fetchedRef[0] = true
    setSopsLoading(true)
    ;(async () => {
      try {
        const { data: links } = await supabase
          .from('sop_pm_schedules')
          .select('sop_id')
          .eq('pm_id', pm.pm_id)
        if (links?.length) {
          const { data: sops } = await supabase
            .from('sops')
            .select('sop_id, name')
            .in('sop_id', links.map(l => l.sop_id))
          setLinkedSOPs(sops || [])
        }
      } catch {}
      finally { setSopsLoading(false) }
    })()
  }, [expanded, hasSopProcedure]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewProcedure = (e) => {
    e.stopPropagation()
    if (!pm.procedure_file_id) return
    const url = actions.getProcedureUrl(pm.procedure_file_id)
    if (url) window.open(url, '_blank')
  }

  // Determine if generate is disabled
  const generateDisabled = saving || pm.status === 'Paused' || pm.status === 'Archived' || globalPaused || !!openWO

  let generateTooltip = 'Generate work order'
  if (globalPaused) generateTooltip = 'PM generation is paused for break'
  else if (pm.status === 'Paused') generateTooltip = 'This PM is paused'
  else if (pm.status === 'Archived') generateTooltip = 'This PM is archived (asset retired)'
  else if (openWO) generateTooltip = `${openWO.wo_id} is still open — close it first`

  return (
    <div className={`bg-white rounded-xl border border-surface-200 border-l-4 ${statusColor} overflow-hidden`}>
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-50/50 transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-surface-900">{pm.pm_name}</span>
            <span className="text-[10px] font-mono text-surface-400">{pm.pm_id}</span>
            {pm.status === 'Paused' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-200 text-surface-500 flex items-center gap-0.5">
                <Pause size={8} /> Paused
              </span>
            )}
            {pm.status === 'Archived' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-400 flex items-center gap-0.5" title="Asset is archived — PM no longer generates">
                <Trash2 size={8} aria-hidden="true" /> Archived
              </span>
            )}
            {hasProcedure && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600 flex items-center gap-0.5">
                <FileText size={8} /> Procedure
              </span>
            )}
            {openWO && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-600 flex items-center gap-0.5">
                <Link2 size={8} /> {openWO.wo_id}
              </span>
            )}
          </div>
          <div className="text-xs text-surface-500 mt-0.5">
            {pm.asset_name || 'No asset'} — {pm.frequency}
            {pm.frequency === 'Custom' ? ` (${pm.frequency_value} days)` : ''}
            <span className="text-surface-300 mx-1">·</span>
            <span className="text-surface-400">{getDueDateLabel(pm.frequency)}</span>
          </div>
        </div>
        <div className="text-right mr-2 flex-shrink-0">
          {pm.isOverdue ? (
            <span className="text-xs font-semibold text-red-600 flex items-center gap-1"><AlertTriangle size={12} /> Overdue — {fmtDate(pm.next_due_date)}</span>
          ) : pm.isDueSoon ? (
            <span className="text-xs font-semibold text-yellow-600 flex items-center gap-1"><Clock size={12} /> Generates: {fmtDate(pm.next_due_date)}</span>
          ) : pm.status === 'Active' ? (
            <span className="text-xs text-surface-400">Next: {fmtDate(pm.next_due_date)}</span>
          ) : null}
        </div>
        {expanded ? <ChevronUp size={14} className="text-surface-400" /> : <ChevronDown size={14} className="text-surface-400" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t border-surface-100 pt-3 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-surface-400 block">Next Due</span>
              <span className="font-medium">{fmtDate(pm.next_due_date)}</span>
            </div>
            <div>
              <span className="text-surface-400 block">Last Generated</span>
              <span className="font-medium">{fmtDate(pm.last_generated)}</span>
            </div>
            <div>
              <span className="text-surface-400 block">Created</span>
              <span className="font-medium">{fmtDate(pm.created_at)}</span>
            </div>
            <div>
              <span className="text-surface-400 block">Created By</span>
              <span className="font-medium">{pm.created_by || '—'}</span>
            </div>
          </div>

          {/* Procedure File — direct attachment */}
          {hasFileProcedure && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex items-center gap-2">
              <FileText size={14} className="text-blue-600 flex-shrink-0" />
              <span className="text-xs text-blue-800 font-medium flex-1">
                Procedure attached: <span className="font-normal text-blue-600">{pm.procedure_file_id?.split('/').pop()}</span>
              </span>
              <button onClick={handleViewProcedure}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1">
                <Download size={12} /> View
              </button>
            </div>
          )}

          {/* Procedure via linked SOP — shows SOP name(s) */}
          {hasSopProcedure && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex items-start gap-2">
              <FileText size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <span className="text-xs text-blue-800 font-medium">Procedure via linked SOP</span>
                {sopsLoading ? (
                  <div className="flex items-center gap-1 mt-0.5">
                    <Loader2 size={10} className="animate-spin text-blue-400" />
                    <span className="text-[10px] text-blue-400">Loading...</span>
                  </div>
                ) : linkedSOPs.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {linkedSOPs.map(s => (
                      <span key={s.sop_id} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
                        {s.name} <span className="font-normal opacity-70">({s.sop_id})</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[10px] text-blue-500 mt-0.5">View on the SOPs page.</div>
                )}
              </div>
              <a href="/sops" onClick={e => e.stopPropagation()}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 flex-shrink-0">
                <Eye size={12} /> SOPs
              </a>
            </div>
          )}

          {/* Open WO Warning */}
          {openWO && (
            <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 flex items-center gap-2">
              <ShieldAlert size={14} className="text-orange-600 flex-shrink-0" />
              <span className="text-xs text-orange-800">
                <strong>{openWO.wo_id}</strong> ({openWO.status}) is still open. A new WO will not generate until it's closed.
              </span>
            </div>
          )}

          {(hasPerm('generate_wo') || hasPerm('edit_pm') || hasPerm('delete_pm')) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {hasPerm('generate_wo') && (
                <button onClick={onGenerate} disabled={generateDisabled}
                  title={generateTooltip}
                  className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                  <Zap size={12} /> Generate WO
                </button>
              )}
              {hasPerm('edit_pm') && (
                <button onClick={onEdit}
                  className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs font-medium hover:bg-surface-200 flex items-center gap-1">
                  <Edit3 size={12} /> Edit
                </button>
              )}
              {hasPerm('delete_pm') && (
                <button onClick={onDelete} disabled={saving}
                  className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 flex items-center gap-1">
                  <Trash2 size={12} /> Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PM FORM (Create / Edit with Procedure Upload)
// ═══════════════════════════════════════════════════════════════════════════════

function PMForm({ pm, assets, actions, onClose, onSaved }) {
  const [form, setForm] = useState({
    pmName: pm?.pm_name || '',
    assetId: pm?.asset_id || '',
    assetName: pm?.asset_name || '',
    frequency: pm?.frequency || 'Monthly',
    frequencyValue: pm?.frequency_value || 0,
    status: pm?.status || 'Active',
    nextDueDate: pm?.next_due_date ? pm.next_due_date.substring(0, 10) : ''
  })
  const [procedureFile, setProcedureFile] = useState(null) // New file to upload
  const [removeProcedure, setRemoveProcedure] = useState(false)
  const existingProcedure = pm?.procedure_file_id || ''

  const handleFileSelect = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          alert('File must be under 10MB')
          return
        }
        setProcedureFile(file)
        setRemoveProcedure(false)
      }
    }
    input.click()
  }

  const handleRemoveProcedure = () => {
    setProcedureFile(null)
    setRemoveProcedure(true)
  }

  const handleSubmit = async () => {
    if (!form.pmName.trim()) return alert('PM name is required')
    try {
      if (pm) {
        // ── Update existing PM ──
        const updates = {
          pm_name: form.pmName,
          asset_id: form.assetId,
          asset_name: form.assetName || assets.find(a => a.asset_id === form.assetId)?.name || '',
          frequency: form.frequency,
          frequency_value: parseInt(form.frequencyValue) || 0,
          status: form.status
        }
        if (form.nextDueDate) updates.next_due_date = form.nextDueDate  // store as plain YYYY-MM-DD — no toISOString() conversion here

        // Handle procedure file changes
        if (procedureFile) {
          updates._newProcedureFile = procedureFile
          updates._oldProcedureFileId = existingProcedure
        } else if (removeProcedure && existingProcedure) {
          updates._removeProcedure = true
          updates._oldProcedureFileId = existingProcedure
        }

        await actions.updatePM(pm.pm_id, updates)
      } else {
        // ── Create new PM ──
        await actions.createPM({
          ...form,
          procedureFile: procedureFile || null
        })
      }
      onSaved()
    } catch {}
  }

  // Show which procedure will be active after save
  const effectiveProcedure = procedureFile
    ? procedureFile.name
    : (removeProcedure ? null : (existingProcedure ? existingProcedure.split('/').pop() : null))

  return (
    <div className="bg-white rounded-xl border border-surface-200 p-5 space-y-3 shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
      onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-900">{pm ? 'Edit PM Schedule' : 'New PM Schedule'}</h3>
        <button onClick={onClose} className="text-surface-400 hover:text-surface-600"><X size={16} /></button>
      </div>

      {/* PM Name */}
      <div>
        <label className="label">PM Name / Description *</label>
        <input value={form.pmName} onChange={e => setForm(f => ({ ...f, pmName: e.target.value }))}
          className="input text-sm" placeholder="e.g. Monthly Filter Change — follow attached procedure" />
      </div>

      {/* Asset */}
      <div>
        <label className="label">Asset</label>
        <select value={form.assetId} onChange={e => {
          const a = assets.find(a => a.asset_id === e.target.value)
          setForm(f => ({ ...f, assetId: e.target.value, assetName: a?.name || '' }))
        }} className="input text-sm">
          <option value="">None</option>
          {assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.name} ({a.asset_id})</option>)}
        </select>
      </div>

      {/* Frequency + Custom Value */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Frequency</label>
          <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))} className="input text-sm">
            {FREQ_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <p className="text-[10px] text-surface-400 mt-0.5">{getDueDateLabel(form.frequency)}</p>
        </div>
        {form.frequency === 'Custom' && (
          <div>
            <label className="label">Every X Days</label>
            <input type="number" min={1} value={form.frequencyValue}
              onChange={e => setForm(f => ({ ...f, frequencyValue: e.target.value }))}
              className="input text-sm" />
          </div>
        )}
        {pm && (
          <div>
            <label className="label">Status</label>
            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="input text-sm">
              <option value="Active">Active</option>
              <option value="Paused">Paused</option>
              <option value="Archived">Archived</option>
            </select>
          </div>
        )}
      </div>

      {pm && (
        <div>
          <label className="label">Next Due Date</label>
          <input type="date" value={form.nextDueDate}
            onChange={e => setForm(f => ({ ...f, nextDueDate: e.target.value }))}
            className="input text-sm" />
        </div>
      )}

      {/* ── Procedure File Section ── */}
      <div>
        <label className="label flex items-center gap-1">
          <FileText size={12} className="text-brand-600" /> Procedure File
        </label>
        <p className="text-[10px] text-surface-400 mb-1.5">
          Attach a procedure document (PDF, DOC, image). It will automatically follow through to generated work orders.
        </p>

        {effectiveProcedure ? (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex items-center gap-2">
            <FileText size={14} className="text-blue-600 flex-shrink-0" />
            <span className="text-xs text-blue-800 flex-1 truncate">{effectiveProcedure}</span>
            {procedureFile && <span className="text-[10px] text-blue-500 italic">(new)</span>}
            <button onClick={handleFileSelect}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-0.5">
              <RotateCcw size={10} /> Replace
            </button>
            <button onClick={handleRemoveProcedure}
              className="text-xs text-red-500 hover:text-red-700 font-medium flex items-center gap-0.5">
              <XCircle size={10} /> Remove
            </button>
          </div>
        ) : (
          <button onClick={handleFileSelect}
            className="w-full border-2 border-dashed border-surface-200 rounded-lg px-3 py-3 text-xs text-surface-400 hover:border-brand-300 hover:text-brand-600 hover:bg-brand-50/30 transition-all flex items-center justify-center gap-2">
            <Upload size={14} /> Click to attach a procedure file
          </button>
        )}
      </div>

      {/* Due Date Info */}
      <div className="bg-surface-50 rounded-lg px-3 py-2 flex items-start gap-2">
        <Info size={14} className="text-surface-400 mt-0.5 flex-shrink-0" />
        <div className="text-[11px] text-surface-500 space-y-0.5">
          <div><strong>Due date rules:</strong> Daily = next day, Weekly = 1 week, all others = 3 weeks.</div>
          <div><strong>Duplicate prevention:</strong> A new WO will not generate while one is still open for this PM.</div>
          {effectiveProcedure && (
            <div><strong>Procedure:</strong> Will be automatically attached to generated work orders.</div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button onClick={handleSubmit} disabled={actions.saving} className="btn-primary text-sm gap-1.5">
          {actions.saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {pm ? 'Update' : 'Create'} Schedule
        </button>
        <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
      </div>
    </div>
  )
}
