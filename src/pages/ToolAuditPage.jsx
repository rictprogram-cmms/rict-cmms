/**
 * RICT CMMS — Tool Count Audit
 * Route: /inventory/tool-audit   (opened from Inventory → Tool Audit)
 *
 * A tool audit is one count of the program's tools — all of them or one
 * location — usually at the end of a term. Instructors only
 * (Inventory → run_tool_audit; the database enforces the same permission).
 *
 * Views
 *   List    — every audit (newest first) with its status and progress, and
 *             "Start audit".
 *   Count   — an Open audit. One card per tool: how many are there, how many
 *             of those are worn or broken, and a note. This is a BLIND count:
 *             the expected number is not shown, so the counter is not led by
 *             it. Each tool saves when you leave its fields. "Scan label"
 *             reads a tool's QR label and jumps to that tool.
 *   Report  — a Completed audit: expected vs counted, shortages, print, CSV.
 *             "Apply to inventory" writes the counts back once
 *             (apply_tool_audit): the shortfall becomes Missing, worn and
 *             broken are updated, and tools nobody counted are left alone.
 *             After that the audit is a fixed record.
 *
 * Two scopes (since tool kits, 20261124d_tool_kits.sql):
 *   General stock — all locations or one. Expects only what is NOT assigned
 *             to a kit (owned minus kit quantities).
 *   One kit   — a "kit check": the audit lists that kit's tool list. Started
 *             here or from the Tool Kits page.
 *   Applying either one replaces only the part it covered, so the tool's
 *   totals never double-count.
 *
 * Data: tool_audits, tool_audit_lines, start_tool_audit(),
 * start_tool_kit_check(), apply_tool_audit()
 * (supabase/migrations/20261124c_tool_audits.sql, 20261124d_tool_kits.sql). Reads go through
 * mustData(); writes through assertWrite(). No realtime channel — one person
 * counts at a time; the lists reload after every change and on Refresh.
 *
 * Timestamps (started_at, completed_at, applied_at, counted_at) are REAL UTC
 * (Convention B in TIMESTAMP_CONVENTIONS.md) and shown with toLocaleString().
 *
 * Accessibility (WCAG 2.1 AA / Section 508): labelled inputs, 44px targets,
 * focus-visible rings, statuses carried by text (never colour alone), a polite
 * live region for save / finish / apply results, tables with scoped headers,
 * useDialogA11y on the start and scan dialogs, ConfirmDialog for finish,
 * cancel and apply.
 *
 * File: src/pages/ToolAuditPage.jsx
 */

import { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ClipboardCheck, ArrowLeft, Plus, Search, ScanLine, Printer, Download, Loader2,
  AlertCircle, Check, X, RotateCcw, RefreshCw, Lock,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite, isRlsBlock } from '@/lib/supabaseData'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { currentTerm, sortTerms } from '@/lib/academicTerms'

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1'
const BTN = `inline-flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`
const BTN_PRIMARY = `${BTN} bg-brand-600 hover:bg-brand-700 text-white`
const BTN_PLAIN = `${BTN} border border-surface-300 bg-white text-surface-800 hover:bg-surface-50`
const BTN_DANGER = `${BTN} border border-red-300 bg-white text-red-800 hover:bg-red-50`
const INPUT = `w-full px-3 min-h-[44px] text-sm border border-surface-300 rounded-lg bg-white ${FOCUS}`

const STATUS_STYLE = {
  Open:      'bg-blue-50 text-blue-800 border-blue-200',
  Completed: 'bg-amber-50 text-amber-900 border-amber-200',
  Applied:   'bg-green-50 text-green-800 border-green-200',
  Cancelled: 'bg-surface-100 text-surface-700 border-surface-300',
}

/* ── Pure helpers ─────────────────────────────────────────────────── */

// An audit whose results were written back shows as "Applied"
const statusOf = (a) => (a?.applied_at ? 'Applied' : a?.status || 'Open')
const fmtWhen = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const toCount = (v) => Math.max(0, Math.floor(Number(v) || 0))
// What an audit covers: one kit, or the general stock at a location / everywhere
const scopeOf = (a) => (a?.kit_id ? `Kit: ${a.kit_name || a.kit_id}` : `${a?.location || 'All locations'} (general stock)`)
const isCounted = (l) => l.counted_qty !== null && l.counted_qty !== undefined
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const friendly = (err, fallback) => {
  if (isRlsBlock(err)) return 'You do not have permission for that. Tool audits need Inventory → run_tool_audit.'
  const msg = String(err?.cause?.message || err?.message || '').replace(/^[a-z_.]+:\s*/i, '')
  return msg || fallback
}

/** Totals for a set of lines — used by the list, the count header and the report. */
function summarize(lines) {
  const s = { total: lines.length, counted: 0, short: 0, unitsShort: 0, over: 0, unitsOver: 0, worn: 0, broken: 0 }
  for (const l of lines) {
    if (!isCounted(l)) continue
    s.counted++
    const diff = l.counted_qty - (l.expected_qty || 0)
    if (diff < 0) { s.short++; s.unitsShort += -diff }
    if (diff > 0) { s.over++; s.unitsOver += diff }
    s.worn += l.counted_worn || 0
    s.broken += l.counted_broken || 0
  }
  s.uncounted = s.total - s.counted
  return s
}

/** Tool ID out of a scanned label: the scan link (?partId=TL-0001) or a bare TL-0001. */
function toolIdFromScan(text) {
  try {
    const id = new URL(text, window.location.origin).searchParams.get('partId')
    if (id) return id.trim().toUpperCase()
  } catch { /* not a link — fall through */ }
  const m = String(text || '').match(/TL-?\d+/i)
  return m ? m[0].toUpperCase() : ''
}

function StatusBadge({ audit }) {
  const s = statusOf(audit)
  return <span className={`inline-block px-2.5 py-0.5 rounded-full border text-xs font-semibold ${STATUS_STYLE[s] || STATUS_STYLE.Cancelled}`}>{s}</span>
}

/* ══════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════ */
export default function ToolAuditPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Inventory')
  const canAudit = hasPerm('run_tool_audit')
  const [params, setParams] = useSearchParams()
  const auditId = params.get('id') || ''

  const [audits, setAudits] = useState([])
  const [progress, setProgress] = useState({})       // audit_id -> summarize() for audits not yet applied
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [showStart, setShowStart] = useState(false)
  const [announce, setAnnounce] = useState('')
  const say = useCallback((msg) => { setAnnounce(''); setTimeout(() => setAnnounce(msg), 50) }, [])

  const userShort = profile ? `${profile.first_name || ''} ${profile.last_name?.charAt(0) || ''}.`.trim() : ''

  const loadAudits = useCallback(async () => {
    try {
      const rows = mustData(await supabase.from('tool_audits').select('*').order('started_at', { ascending: false }), 'tool_audits.select') || []
      setAudits(rows)
      // Progress only for audits still in play — applied and cancelled ones don't need it.
      const live = rows.filter(a => !a.applied_at && a.status !== 'Cancelled').map(a => a.audit_id)
      const map = {}
      if (live.length) {
        const lines = mustData(await supabase.from('tool_audit_lines')
          .select('audit_id, expected_qty, counted_qty, counted_worn, counted_broken')
          .in('audit_id', live).limit(5000), 'tool_audit_lines.select') || []
        for (const id of live) map[id] = summarize(lines.filter(l => l.audit_id === id))
      }
      setProgress(map)
      setLoadError('')
    } catch (e) {
      console.error('ToolAudit load:', e)
      setLoadError(friendly(e, 'Could not load the tool audits.'))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (permsLoading) return
    if (!canAudit) { setLoading(false); return }
    loadAudits()
  }, [permsLoading, canAudit, loadAudits])

  const openAudit = (id) => setParams(id ? { id } : {})
  const current = audits.find(a => a.audit_id === auditId) || null

  /* ── Not allowed ── */
  if (!permsLoading && !canAudit) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-start gap-3 bg-surface-50 border border-surface-200 rounded-xl px-5 py-4" role="alert">
          <Lock size={20} className="mt-0.5 shrink-0 text-surface-600" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-bold text-surface-900">Tool audits are for instructors</h1>
            <p className="text-sm text-surface-700 mt-1">You need the Inventory permission &ldquo;run_tool_audit&rdquo; to open this page.</p>
            <button type="button" onClick={() => navigate('/inventory')} className={`${BTN_PLAIN} mt-3`}>
              <ArrowLeft size={16} aria-hidden="true" /> Back to Inventory
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{announce}</div>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
          <ClipboardCheck size={22} className="text-brand-700" aria-hidden="true" />
        </div>
        <div className="mr-auto">
          <h1 className="text-xl font-bold text-surface-900">Tool Count Audit</h1>
          <p className="text-sm text-surface-600">Count the tools, see what is short, and update the tool inventory.</p>
        </div>
        {current ? (
          <button type="button" onClick={() => openAudit('')} className={BTN_PLAIN}>
            <ArrowLeft size={16} aria-hidden="true" /> All audits
          </button>
        ) : (
          <button type="button" onClick={() => navigate('/inventory')} className={BTN_PLAIN}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to Inventory
          </button>
        )}
      </div>

      {loadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-sm" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{loadError}</span>
          <button type="button" onClick={loadAudits} className={`ml-auto underline font-semibold min-h-[44px] px-2 ${FOCUS}`}>Try again</button>
        </div>
      )}

      {loading || permsLoading ? (
        <p className="flex items-center gap-2 text-sm text-surface-600 py-8 justify-center">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading tool audits…
        </p>
      ) : auditId && !current ? (
        <div className="bg-surface-50 border border-surface-200 rounded-xl px-5 py-4 text-sm text-surface-800" role="alert">
          Audit {auditId} was not found. <button type="button" onClick={() => openAudit('')} className={`underline font-semibold min-h-[44px] px-1 ${FOCUS}`}>See all audits</button>
        </div>
      ) : current ? (
        <AuditDetail key={current.audit_id} audit={current} userShort={userShort} userEmail={profile?.email || ''}
          say={say} onChanged={loadAudits} />
      ) : (
        <AuditList audits={audits} progress={progress} onOpen={openAudit} onStart={() => setShowStart(true)} onRefresh={loadAudits} />
      )}

      {showStart && (
        <StartDialog userShort={userShort} onClose={() => setShowStart(false)}
          onStarted={async (id) => { setShowStart(false); await loadAudits(); openAudit(id); say(`Audit ${id} started`) }} />
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   List of audits
   ══════════════════════════════════════════════════════════════════════ */
function AuditList({ audits, progress, onOpen, onStart, onRefresh }) {
  return (
    <section aria-labelledby="ta-list-title" className="bg-white border border-surface-200 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-surface-200">
        <h2 id="ta-list-title" className="text-base font-bold text-surface-900 mr-auto">Audits</h2>
        <button type="button" onClick={onRefresh} className={BTN_PLAIN}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        <button type="button" onClick={onStart} className={BTN_PRIMARY}><Plus size={16} aria-hidden="true" /> Start audit</button>
      </div>
      {audits.length === 0 ? (
        <p className="px-4 py-8 text-sm text-surface-700 text-center">
          No tool audits yet. Start one to count the general stock at a location (or everywhere), or to check one kit.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-surface-600 border-b border-surface-200">
                <th scope="col" className="px-4 py-2.5">Audit</th>
                <th scope="col" className="px-4 py-2.5">Term</th>
                <th scope="col" className="px-4 py-2.5">Covers</th>
                <th scope="col" className="px-4 py-2.5">Status</th>
                <th scope="col" className="px-4 py-2.5">Progress</th>
                <th scope="col" className="px-4 py-2.5">Started</th>
                <th scope="col" className="px-4 py-2.5"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {audits.map(a => {
                const p = progress[a.audit_id]
                return (
                  <tr key={a.audit_id} className="border-b border-surface-100 last:border-0">
                    <th scope="row" className="px-4 py-3 text-left font-semibold text-surface-900">
                      {a.name}<br /><span className="text-xs font-normal text-surface-600">{a.audit_id}</span>
                    </th>
                    <td className="px-4 py-3 text-surface-800">{a.term || '—'}</td>
                    <td className="px-4 py-3 text-surface-800">{scopeOf(a)}</td>
                    <td className="px-4 py-3"><StatusBadge audit={a} /></td>
                    <td className="px-4 py-3 text-surface-800">
                      {p ? <>{p.counted} of {p.total} counted{a.status === 'Completed' && p.short > 0 ? <><br /><span className="text-xs font-semibold text-red-800">{p.short} short</span></> : null}</>
                        : a.applied_at ? `Applied ${fmtWhen(a.applied_at)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-surface-800">{fmtWhen(a.started_at)}<br /><span className="text-xs text-surface-600">{a.started_by}</span></td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => onOpen(a.audit_id)} className={BTN_PLAIN}
                        aria-label={`${a.status === 'Open' ? 'Continue counting' : 'View'} ${a.name}`}>
                        {a.status === 'Open' ? 'Continue' : 'View'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Start dialog
   ══════════════════════════════════════════════════════════════════════ */
function StartDialog({ userShort, onClose, onStarted }) {
  const dialogRef = useDialogA11y(true, onClose)
  const titleId = useId()
  const [terms, setTerms] = useState([])
  const [tools, setTools] = useState(null)       // null = still loading
  const [name, setName] = useState('')
  const [term, setTerm] = useState('')
  const [location, setLocation] = useState('')
  const [scope, setScope] = useState('general')   // 'general' | 'kit'
  const [kits, setKits] = useState([])            // active kits of active kit types, with their type name
  const [kitItems, setKitItems] = useState([])    // every kit type's tool list
  const [kitId, setKitId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameTouched = useRef(false)
  const termName = useRef('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [t, inv, kt, kk, ki] = await Promise.all([
          supabase.from('academic_terms').select('term_id, name, season, year, begin_date, end_date, status'),
          supabase.from('inventory').select('part_id, location, qty_in_stock').eq('item_type', 'Tool').eq('status', 'Active'),
          supabase.from('tool_kit_types').select('type_id, name, status'),
          supabase.from('tool_kits').select('kit_id, type_id, name, location, status'),
          supabase.from('tool_kit_type_items').select('type_id, part_id, qty'),
        ])
        const toolRows = mustData(inv, 'inventory.select') || []
        // Kits decide what the general stock is expected to hold, so their reads must succeed too.
        const types = mustData(kt, 'tool_kit_types.select') || []
        const activeTypes = Object.fromEntries(types.filter(x => x.status === 'Active').map(x => [x.type_id, x.name]))
        const kitRows = (mustData(kk, 'tool_kits.select') || [])
          .filter(k => k.status === 'Active' && activeTypes[k.type_id])
          .map(k => ({ ...k, type_name: activeTypes[k.type_id] }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        const itemRows = mustData(ki, 'tool_kit_type_items.select') || []
        // Terms are optional here — a failed load just leaves the dropdown empty.
        const termRows = t.error ? [] : sortTerms((t.data || []).filter(x => x.status !== 'Archived'))
        if (!alive) return
        setTools(toolRows)
        setTerms(termRows)
        setKits(kitRows)
        setKitItems(itemRows)
        const cur = currentTerm(termRows)
        termName.current = cur?.name || ''
        if (cur) { setTerm(cur.name); if (!nameTouched.current) setName(`${cur.name} tool count`) }
        else if (!nameTouched.current) setName('Tool count')
      } catch (e) {
        if (alive) { setTools([]); setError(friendly(e, 'Could not load the tools.')) }
      }
    })()
    return () => { alive = false }
  }, [])

  // Tools a general audit lists: the same rule as start_tool_audit() — a tool
  // whose whole quantity is assigned to kits has nothing in general stock.
  const generalTools = useMemo(() => {
    const kitsPerType = {}
    for (const k of kits) kitsPerType[k.type_id] = (kitsPerType[k.type_id] || 0) + 1
    const inKits = {}
    for (const it of kitItems) inKits[it.part_id] = (inKits[it.part_id] || 0) + it.qty * (kitsPerType[it.type_id] || 0)
    return (tools || []).filter(t => !inKits[t.part_id] || (Number(t.qty_in_stock) || 0) > inKits[t.part_id])
  }, [tools, kits, kitItems])

  const locations = useMemo(() => {
    const counts = {}
    for (const t of generalTools) { const k = (t.location || '').trim(); if (k) counts[k] = (counts[k] || 0) + 1 }
    return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
  }, [generalTools])
  const kit = kits.find(k => k.kit_id === kitId) || null
  const kitToolCount = kit ? kitItems.filter(it => it.type_id === kit.type_id).length : 0
  const toolCount = scope === 'kit' ? kitToolCount
    : location ? (locations.find(l => l[0] === location)?.[1] || 0) : generalTools.length

  // Keep the suggested name in step with what is being counted, until it is typed over
  const suggestName = (nextScope, nextKit) => {
    if (nameTouched.current) return
    if (nextScope === 'kit') setName(nextKit ? `${nextKit.name} check` : 'Kit check')
    else setName(termName.current ? `${termName.current} tool count` : 'Tool count')
  }

  const start = async () => {
    if (!name.trim()) { setError('Give the audit a name.'); return }
    if (scope === 'kit' && !kit) { setError('Choose which kit to check.'); return }
    setBusy(true); setError('')
    try {
      const id = scope === 'kit'
        ? mustData(await supabase.rpc('start_tool_kit_check', {
            p_kit_id: kit.kit_id, p_name: name.trim(), p_term: term, p_by: userShort,
          }), 'start_tool_kit_check')
        : mustData(await supabase.rpc('start_tool_audit', {
        p_name: name.trim(), p_term: term, p_location: location, p_by: userShort,
      }), 'start_tool_audit')
      if (!id) throw new Error('The audit was not created.')
      toast.success(`Audit ${id} started`)
      onStarted(id)
    } catch (e) {
      setError(friendly(e, 'Could not start the audit.'))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200">
          <h2 id={titleId} className="text-lg font-bold text-surface-900">Start a tool audit</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className={`w-11 h-11 inline-flex items-center justify-center rounded-lg text-surface-600 hover:bg-surface-100 ${FOCUS}`}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <fieldset>
            <legend className="block text-sm font-semibold text-surface-800 mb-1">What are you counting?</legend>
            <label className="flex items-start gap-2 min-h-[44px] py-1.5 text-sm text-surface-900 cursor-pointer">
              <input type="radio" name="ta-start-scope" className="mt-1 w-4 h-4" checked={scope === 'general'}
                onChange={() => { setScope('general'); suggestName('general', null) }} />
              <span><strong>General stock</strong><span className="block text-xs text-surface-700">Tools in the cabinets and cribs. Tools assigned to kits are not included.</span></span>
            </label>
            <label className="flex items-start gap-2 min-h-[44px] py-1.5 text-sm text-surface-900 cursor-pointer">
              <input type="radio" name="ta-start-scope" className="mt-1 w-4 h-4" checked={scope === 'kit'} disabled={kits.length === 0}
                onChange={() => { setScope('kit'); suggestName('kit', kit) }} />
              <span><strong>One kit</strong><span className="block text-xs text-surface-700">
                {kits.length === 0 ? 'No active kits yet. Add them on the Tool Kits page.' : 'A bench or toolbox, against its own tool list.'}
              </span></span>
            </label>
          </fieldset>
          <div>
            <label htmlFor="ta-start-name" className="block text-sm font-semibold text-surface-800 mb-1">Audit name</label>
            <input id="ta-start-name" type="text" className={INPUT} value={name} maxLength={120}
              onChange={e => { nameTouched.current = true; setName(e.target.value) }} />
          </div>
          <div>
            <label htmlFor="ta-start-term" className="block text-sm font-semibold text-surface-800 mb-1">Term</label>
            <select id="ta-start-term" className={INPUT} value={term} onChange={e => setTerm(e.target.value)}>
              <option value="">No term</option>
              {terms.map(t => <option key={t.term_id} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          {scope === 'kit' ? (
            <div>
              <label htmlFor="ta-start-kit" className="block text-sm font-semibold text-surface-800 mb-1">Kit</label>
              <select id="ta-start-kit" className={INPUT} value={kitId} aria-describedby="ta-start-kit-help"
                onChange={e => { setKitId(e.target.value); suggestName('kit', kits.find(k => k.kit_id === e.target.value) || null) }}>
                <option value="">Choose a kit…</option>
                {kits.map(k => <option key={k.kit_id} value={k.kit_id}>{k.name} — {k.type_name}</option>)}
              </select>
              <p id="ta-start-kit-help" className="text-xs text-surface-700 mt-1.5">
                {!kit ? 'The check lists the tools that kit is supposed to hold.'
                  : toolCount === 0 ? 'This kit has no tools on its list yet. Add tools to its kit type on the Tool Kits page.'
                  : `This check will list the ${toolCount} tool${toolCount === 1 ? '' : 's'} ${kit.name} should hold.`}
              </p>
            </div>
          ) : (
          <div>
            <label htmlFor="ta-start-loc" className="block text-sm font-semibold text-surface-800 mb-1">Location</label>
            <select id="ta-start-loc" className={INPUT} value={location} aria-describedby="ta-start-loc-help"
              onChange={e => setLocation(e.target.value)}>
              <option value="">All locations</option>
              {locations.map(([loc, n]) => <option key={loc} value={loc}>{loc} ({n})</option>)}
            </select>
            <p id="ta-start-loc-help" className="text-xs text-surface-700 mt-1.5">
              {tools === null ? 'Loading tools…'
                : toolCount === 0 ? 'There are no active tools in general stock to count here. Add tools on the Inventory page first.'
                : `This audit will list ${toolCount} active tool${toolCount === 1 ? '' : 's'}, as the inventory stands right now.`}
            </p>
          </div>
          )}
          {error && <p className="text-sm font-semibold text-red-800" role="alert">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-surface-200">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_PLAIN}>Cancel</button>
          <button type="button" onClick={start} disabled={busy || tools === null || toolCount === 0 || (scope === 'kit' && !kit)} className={BTN_PRIMARY}>
            {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Start audit
          </button>
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   One audit: count (Open) or report (Completed / Applied / Cancelled)
   ══════════════════════════════════════════════════════════════════════ */
function AuditDetail({ audit, userShort, userEmail, say, onChanged }) {
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(null)     // 'finish' | 'cancel' | 'apply' | 'reopen'
  const [busy, setBusy] = useState(false)

  const loadLines = useCallback(async () => {
    try {
      const rows = mustData(await supabase.from('tool_audit_lines').select('*')
        .eq('audit_id', audit.audit_id).order('location').order('part_name').limit(5000), 'tool_audit_lines.select') || []
      setLines(rows)
      setError('')
    } catch (e) {
      console.error('ToolAudit lines:', e)
      setError(friendly(e, 'Could not load this audit.'))
    }
    setLoading(false)
  }, [audit.audit_id])

  useEffect(() => { loadLines() }, [loadLines])

  const sum = useMemo(() => summarize(lines), [lines])
  const status = statusOf(audit)

  /** Finish / reopen / cancel: a plain status change (allowed until the audit is applied). */
  const setStatus = async (next) => {
    setBusy(true)
    try {
      const patch = next === 'Completed'
        ? { status: 'Completed', completed_at: new Date().toISOString(), completed_by: userShort }
        : next === 'Open' ? { status: 'Open', completed_at: null, completed_by: null }
        : { status: 'Cancelled' }
      const { error: err } = assertWrite(
        await supabase.from('tool_audits').update(patch).eq('audit_id', audit.audit_id).select(), 'tool_audits.update')
      if (err) throw err
      const msg = next === 'Completed' ? 'Count finished — here is the report' : next === 'Open' ? 'Count reopened' : 'Audit cancelled'
      toast.success(msg); say(msg)
      setConfirm(null)
      await onChanged()
    } catch (e) {
      toast.error(friendly(e, 'Could not update the audit.'))
    }
    setBusy(false)
  }

  const apply = async () => {
    setBusy(true)
    try {
      const n = mustData(await supabase.rpc('apply_tool_audit', { p_audit_id: audit.audit_id, p_by: userShort }), 'apply_tool_audit')
      // Trail in the audit log (best effort — the apply itself already succeeded)
      try {
        await supabase.from('audit_log').insert({
          user_email: userEmail, user_name: userShort, action: 'Tool Audit Applied',
          entity_type: 'Inventory', entity_id: audit.audit_id,
          details: `Applied tool audit "${audit.name}" (${audit.audit_id}): ${n} tool${n === 1 ? '' : 's'} updated, ${sum.unitsShort} missing, ${sum.unitsOver} more than recorded`,
        })
      } catch { /* non-fatal */ }
      const msg = `Inventory updated for ${n} tool${n === 1 ? '' : 's'}`
      toast.success(msg); say(msg)
      setConfirm(null)
      await onChanged()
    } catch (e) {
      toast.error(friendly(e, 'Could not apply the audit.'))
    }
    setBusy(false)
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-surface-600 py-8 justify-center">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading audit…
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Audit header */}
      <section aria-labelledby="ta-audit-title" className="bg-white border border-surface-200 rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="ta-audit-title" className="text-lg font-bold text-surface-900">{audit.name}</h2>
          <StatusBadge audit={audit} />
        </div>
        <p className="text-sm text-surface-700 mt-1">
          {audit.audit_id} · {audit.term || 'No term'} · {scopeOf(audit)}{audit.kit_id && audit.location ? ` · at ${audit.location}` : ''} · started {fmtWhen(audit.started_at)}{audit.started_by ? ` by ${audit.started_by}` : ''}
        </p>
        {audit.completed_at && <p className="text-sm text-surface-700">Count finished {fmtWhen(audit.completed_at)}{audit.completed_by ? ` by ${audit.completed_by}` : ''}</p>}
        {audit.applied_at && <p className="text-sm text-surface-700">Applied to inventory {fmtWhen(audit.applied_at)}{audit.applied_by ? ` by ${audit.applied_by}` : ''}</p>}
      </section>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-sm" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={loadLines} className={`ml-auto underline font-semibold min-h-[44px] px-2 ${FOCUS}`}>Try again</button>
        </div>
      )}

      {audit.status === 'Open' ? (
        <CountView audit={audit} lines={lines} setLines={setLines} sum={sum} userShort={userShort} say={say}
          onFinish={() => setConfirm('finish')} onCancel={() => setConfirm('cancel')} />
      ) : (
        <ReportView audit={audit} lines={lines} sum={sum} status={status}
          onApply={() => setConfirm('apply')} onReopen={() => setConfirm('reopen')} />
      )}

      {confirm === 'finish' && (
        <ConfirmDialog open variant="primary" busy={busy} title="Finish the count?"
          message={sum.uncounted > 0
            ? <>{sum.uncounted} of {sum.total} tools {sum.uncounted === 1 ? 'has' : 'have'} not been counted. {sum.uncounted === 1 ? 'It' : 'They'} will show as &ldquo;Not counted&rdquo; in the report and will be left unchanged in the inventory. You can reopen the count until it is applied.</>
            : <>All {sum.total} tools are counted. You will see the report next; nothing changes in the inventory until you apply it.</>}
          confirmLabel="Finish count" cancelLabel="Keep counting"
          onConfirm={() => setStatus('Completed')} onClose={() => setConfirm(null)} />
      )}
      {confirm === 'cancel' && (
        <ConfirmDialog open variant="danger" busy={busy} title="Cancel this audit?"
          message={<>Cancel <strong>{audit.name}</strong>? The counts entered so far are kept for the record, but the audit can no longer be finished or applied. Nothing changes in the inventory.</>}
          confirmLabel="Cancel audit" cancelLabel="Keep audit"
          onConfirm={() => setStatus('Cancelled')} onClose={() => setConfirm(null)} />
      )}
      {confirm === 'reopen' && (
        <ConfirmDialog open variant="primary" busy={busy} title="Reopen the count?"
          message="The audit goes back to counting so numbers can be corrected. Nothing has changed in the inventory."
          confirmLabel="Reopen count" cancelLabel="Leave it finished"
          onConfirm={() => setStatus('Open')} onClose={() => setConfirm(null)} />
      )}
      {confirm === 'apply' && (
        <ConfirmDialog open variant="primary" busy={busy} title="Apply this audit to the inventory?"
          message={<>
            This updates {sum.counted} counted tool{sum.counted === 1 ? '' : 's'}: {sum.unitsShort} will be marked missing{audit.kit_id ? ' from this kit' : ''}
            {sum.unitsOver > 0 && !audit.kit_id ? <>, {sum.unitsOver} extra will be added to the totals</> : null}, and worn and broken counts for {audit.kit_id ? 'this kit' : 'the general stock'} are replaced with what was counted.
            {audit.kit_id ? ' The general stock and the other kits are not touched.' : ' What the kits\u2019 own checks recorded is kept.'}
            {sum.uncounted > 0 ? <> The {sum.uncounted} tool{sum.uncounted === 1 ? '' : 's'} not counted {sum.uncounted === 1 ? 'is' : 'are'} left unchanged.</> : null}
            {' '}This can be done once and the audit cannot be reopened afterwards.
          </>}
          confirmLabel="Apply to inventory" cancelLabel="Not yet"
          onConfirm={apply} onClose={() => setConfirm(null)} />
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Count view (blind — the expected number is never shown here)
   ══════════════════════════════════════════════════════════════════════ */
function CountView({ audit, lines, setLines, sum, userShort, say, onFinish, onCancel }) {
  const [search, setSearch] = useState('')
  const [onlyUncounted, setOnlyUncounted] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [focusId, setFocusId] = useState(null)     // line to scroll to and focus after a scan

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return lines.filter(l =>
      (!onlyUncounted || !isCounted(l)) &&
      (!q || l.part_name.toLowerCase().includes(q) || l.part_id.toLowerCase().includes(q) || (l.location || '').toLowerCase().includes(q)))
  }, [lines, search, onlyUncounted])

  /** Save one tool's count. `values.counted === null` clears it back to "not counted". */
  const saveLine = useCallback(async (line, values) => {
    const cleared = values.counted === null
    const patch = cleared
      ? { counted_qty: null, counted_worn: 0, counted_broken: 0, note: values.note || '', counted_at: null, counted_by: null }
      : { counted_qty: values.counted, counted_worn: values.worn, counted_broken: values.broken, note: values.note || '',
          counted_at: new Date().toISOString(), counted_by: userShort }
    const { data, error } = assertWrite(
      await supabase.from('tool_audit_lines').update(patch).eq('line_id', line.line_id).select(), 'tool_audit_lines.update')
    if (error) throw error
    const saved = data[0]
    setLines(prev => prev.map(l => (l.line_id === saved.line_id ? saved : l)))
    say(cleared ? `${line.part_name} cleared` : `${line.part_name} saved: ${values.counted} counted`)
  }, [setLines, say, userShort])

  const onScan = (text) => {
    setShowScanner(false)
    const id = toolIdFromScan(text)
    const line = id && lines.find(l => l.part_id.toUpperCase() === id)
    if (!line) {
      toast.error(id ? `${id} is not in this audit` : 'That label is not a tool label')
      return
    }
    setSearch(''); setOnlyUncounted(false)
    setFocusId(line.line_id)
  }

  return (
    <>
      <section aria-label="Count progress and tools" className="bg-white border border-surface-200 rounded-xl">
        <div className="px-4 py-3 border-b border-surface-200 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-surface-900 mr-auto" aria-live="polite">
              {sum.counted} of {sum.total} tools counted
            </p>
            <button type="button" onClick={onCancel} className={BTN_DANGER}>Cancel audit</button>
            <button type="button" onClick={onFinish} className={BTN_PRIMARY}><Check size={16} aria-hidden="true" /> Finish count</button>
          </div>
          <div className="h-2 rounded-full bg-surface-100 overflow-hidden" aria-hidden="true">
            <div className="h-full bg-brand-600" style={{ width: `${sum.total ? Math.round((sum.counted / sum.total) * 100) : 0}%` }} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" aria-hidden="true" />
              <input type="search" className={`${INPUT} pl-9`} placeholder="Search tools…" aria-label="Search tools in this audit"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <label className={`inline-flex items-center gap-2 px-2 min-h-[44px] text-sm text-surface-800 cursor-pointer`}>
              <input type="checkbox" className="w-4 h-4" checked={onlyUncounted} onChange={e => setOnlyUncounted(e.target.checked)} />
              Not counted only
            </label>
            <button type="button" onClick={() => setShowScanner(true)} className={BTN_PLAIN}>
              <ScanLine size={16} aria-hidden="true" /> Scan label
            </button>
          </div>
          <p className="text-xs text-surface-700">
            Enter how many of each tool are actually there, then how many of those are worn or broken. Each tool saves when you leave its fields. Leave a tool blank if you did not count it.
          </p>
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-8 text-sm text-surface-700 text-center">
            {lines.length === 0 ? 'This audit has no tools.' : onlyUncounted && !search ? 'Every tool has been counted.' : 'No tools match.'}
          </p>
        ) : (
          <ul className="divide-y divide-surface-100">
            {shown.map(l => (
              <CountRow key={l.line_id} line={l} onSave={saveLine}
                autoFocus={focusId === l.line_id} onFocused={() => setFocusId(null)} />
            ))}
          </ul>
        )}
      </section>

      {showScanner && <ScannerDialog onResult={onScan} onClose={() => setShowScanner(false)} />}
    </>
  )
}

function CountRow({ line, onSave, autoFocus, onFocused }) {
  const uid = useId()
  const rowRef = useRef(null)
  const countRef = useRef(null)
  const str = (v) => (v === null || v === undefined ? '' : String(v))
  const [counted, setCounted] = useState(str(line.counted_qty))
  const [worn, setWorn] = useState(str(line.counted_worn || ''))
  const [broken, setBroken] = useState(str(line.counted_broken || ''))
  const [note, setNote] = useState(line.note || '')
  const [state, setState] = useState('idle')        // idle | saving | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!autoFocus) return
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    countRef.current?.focus()
    onFocused()
  }, [autoFocus, onFocused])

  const problem = useMemo(() => {
    if (counted.trim() === '') return (worn.trim() || broken.trim()) ? 'Enter how many were counted first.' : ''
    const c = toCount(counted)
    return toCount(worn) + toCount(broken) > c ? `Worn + broken can't be more than the ${c} counted.` : ''
  }, [counted, worn, broken])

  const dirty = counted.trim() !== str(line.counted_qty) || toCount(worn) !== (line.counted_worn || 0)
    || toCount(broken) !== (line.counted_broken || 0) || note !== (line.note || '')

  const save = async () => {
    if (!dirty || problem || state === 'saving') return
    setState('saving'); setMessage('')
    try {
      const cleared = counted.trim() === ''
      await onSave(line, cleared
        ? { counted: null, note }
        : { counted: toCount(counted), worn: toCount(worn), broken: toCount(broken), note })
      // Show exactly what was stored ("07" -> "7", a cleared row loses its worn / broken)
      setCounted(cleared ? '' : String(toCount(counted)))
      setWorn(cleared || !toCount(worn) ? '' : String(toCount(worn)))
      setBroken(cleared || !toCount(broken) ? '' : String(toCount(broken)))
      setState('idle')
    } catch (e) {
      setState('error')
      setMessage(friendly(e, 'Not saved.'))
    }
  }

  // Save when focus leaves the whole row (not on every hop between its fields)
  const onBlurRow = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) save() }

  const statusText = state === 'saving' ? 'Saving…'
    : state === 'error' ? `Not saved: ${message}`
    : problem ? problem
    : dirty ? 'Not saved yet'
    : isCounted(line) ? `Saved${line.counted_by ? ` · ${line.counted_by}` : ''}` : 'Not counted'
  const statusCls = state === 'error' || problem ? 'text-red-800 font-semibold'
    : !dirty && isCounted(line) ? 'text-green-800 font-semibold' : 'text-surface-700'
  const num = `w-full px-2 min-h-[44px] text-base text-center border border-surface-300 rounded-lg bg-white ${FOCUS}`

  return (
    <li ref={rowRef} className="px-4 py-3" onBlur={onBlurRow}>
      <fieldset className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <legend className="sr-only">{line.part_name} ({line.part_id})</legend>
        <div className="flex-1 min-w-[180px] self-center" aria-hidden="true">
          <p className="font-semibold text-surface-900">{line.part_name}</p>
          <p className="text-xs text-surface-700">{line.part_id}{line.location ? ` · ${line.location}` : ''}</p>
        </div>
        <div className="w-24">
          <label htmlFor={`${uid}-c`} className="block text-xs font-semibold text-surface-800 mb-1">Counted</label>
          <input ref={countRef} id={`${uid}-c`} type="number" inputMode="numeric" min="0" step="1" className={num}
            aria-describedby={`${uid}-s`} value={counted} onChange={e => setCounted(e.target.value)} />
        </div>
        <div className="w-20">
          <label htmlFor={`${uid}-w`} className="block text-xs font-semibold text-surface-800 mb-1">Worn</label>
          <input id={`${uid}-w`} type="number" inputMode="numeric" min="0" step="1" className={num}
            aria-describedby={`${uid}-s`} value={worn} onChange={e => setWorn(e.target.value)} />
        </div>
        <div className="w-20">
          <label htmlFor={`${uid}-b`} className="block text-xs font-semibold text-surface-800 mb-1">Broken</label>
          <input id={`${uid}-b`} type="number" inputMode="numeric" min="0" step="1" className={num}
            aria-describedby={`${uid}-s`} value={broken} onChange={e => setBroken(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label htmlFor={`${uid}-n`} className="block text-xs font-semibold text-surface-800 mb-1">Note</label>
          <input id={`${uid}-n`} type="text" maxLength={200} className={INPUT} value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </fieldset>
      <p id={`${uid}-s`} className={`text-xs mt-1.5 ${statusCls}`} role={state === 'error' || problem ? 'alert' : undefined}>{statusText}</p>
    </li>
  )
}

/* ── QR scanner (same reader the Cycle Count page uses) ───────────── */
function ScannerDialog({ onResult, onClose }) {
  const dialogRef = useDialogA11y(true, onClose)
  const readerId = `ta-qr-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const qrRef = useRef(null)
  const [error, setError] = useState('')
  const resultRef = useRef(onResult)
  resultRef.current = onResult

  useEffect(() => {
    let stopped = false
    const stop = () => {
      const q = qrRef.current
      qrRef.current = null
      if (q) q.stop().then(() => q.clear()).catch(() => {})
    }
    ;(async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode')
        if (stopped) return
        const q = new Html5Qrcode(readerId)
        qrRef.current = q
        await q.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s } } },
          (text) => { stop(); resultRef.current(text) }, () => {})
        if (stopped) stop()
      } catch (e) {
        console.error('Camera error:', e)
        setError('The camera could not be opened. Check the camera permission, or use Search instead.')
      }
    })()
    return () => { stopped = true; stop() }
  }, [readerId])

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ta-scan-title"
        className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface-200">
          <h2 id="ta-scan-title" className="text-lg font-bold text-surface-900">Scan a tool label</h2>
          <button type="button" onClick={onClose} aria-label="Close scanner"
            className={`w-11 h-11 inline-flex items-center justify-center rounded-lg text-surface-600 hover:bg-surface-100 ${FOCUS}`}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="p-4">
          <div id={readerId} className="w-full min-h-[240px] bg-surface-900 rounded-lg overflow-hidden" />
          {error
            ? <p className="text-sm font-semibold text-red-800 mt-3" role="alert">{error}</p>
            : <p className="text-sm text-surface-700 mt-3">Point the camera at the tool&rsquo;s QR label. The list jumps to that tool.</p>}
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Report view
   ══════════════════════════════════════════════════════════════════════ */
function ReportView({ audit, lines, sum, status, onApply, onReopen }) {
  const [filter, setFilter] = useState('all')      // all | short | over | uncounted

  const rows = useMemo(() => lines.map(l => {
    const counted = isCounted(l)
    const diff = counted ? l.counted_qty - (l.expected_qty || 0) : null
    return { ...l, counted, diff, result: !counted ? 'Not counted' : diff < 0 ? `${-diff} short` : diff > 0 ? `${diff} over` : 'OK' }
  }), [lines])

  const shown = rows.filter(r =>
    filter === 'all' ? true : filter === 'short' ? r.diff < 0 : filter === 'over' ? r.diff > 0 : !r.counted)

  const exportCsv = () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const head = ['Tool ID', 'Tool', 'Location', 'Expected', 'Counted', 'Difference', 'Result', 'Worn', 'Broken', 'Note', 'Counted by']
    const body = shown.map(r => [r.part_id, r.part_name, r.location, r.expected_qty, r.counted ? r.counted_qty : '', r.counted ? r.diff : '',
      r.result, r.counted ? r.counted_worn : '', r.counted ? r.counted_broken : '', r.note, r.counted_by || ''].map(q).join(','))
    const blob = new Blob(['﻿' + [head.map(q).join(','), ...body].join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tool-audit-${audit.audit_id}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const printReport = () => {
    const body = shown.map(r => `<tr>
      <td>${esc(r.part_id)}</td><td>${esc(r.part_name)}</td><td>${esc(r.location || '—')}</td>
      <td class="n">${r.expected_qty}</td><td class="n">${r.counted ? r.counted_qty : '—'}</td>
      <td class="${r.diff < 0 ? 'bad' : ''}">${esc(r.result)}</td>
      <td class="n">${r.counted ? r.counted_worn : '—'}</td><td class="n">${r.counted ? r.counted_broken : '—'}</td>
      <td>${esc(r.note)}</td></tr>`).join('')
    const w = window.open('', '_blank')
    if (!w) { toast.error('The print window was blocked. Allow pop-ups for this site.'); return }
    w.document.write(`<html lang="en"><head><title>Tool audit ${esc(audit.audit_id)}</title><style>
      @page { size: landscape; margin: 0.5in; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin: 0; }
      h1 { font-size: 16px; margin: 0 0 4px; } .meta { font-size: 11px; color: #444; margin-bottom: 10px; }
      table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #999; padding: 5px 8px; text-align: left; }
      th { background: #eee; font-size: 11px; text-transform: uppercase; } td.n { text-align: right; } td.bad { font-weight: bold; }
    </style></head><body>
      <h1>RICT CMMS — Tool audit: ${esc(audit.name)}</h1>
      <div class="meta">${esc(audit.audit_id)} · ${esc(audit.term || 'No term')} · ${esc(scopeOf(audit))} · ${esc(status)} · started ${esc(fmtWhen(audit.started_at))}${audit.started_by ? ' by ' + esc(audit.started_by) : ''}<br>
        ${sum.counted} of ${sum.total} tools counted · ${sum.short} short (${sum.unitsShort} missing) · ${sum.over} over (${sum.unitsOver} extra) · ${sum.worn} worn · ${sum.broken} broken${filter !== 'all' ? ' · showing: ' + esc(filter) : ''} · printed ${esc(new Date().toLocaleDateString())}</div>
      <table><thead><tr><th scope="col">Tool ID</th><th scope="col">Tool</th><th scope="col">Location</th><th scope="col">Expected</th><th scope="col">Counted</th><th scope="col">Result</th><th scope="col">Worn</th><th scope="col">Broken</th><th scope="col">Note</th></tr></thead>
      <tbody>${body}</tbody></table></body></html>`)
    w.document.close()
    setTimeout(() => w.print(), 400)
  }

  const tiles = [
    { label: 'Counted', value: `${sum.counted} of ${sum.total}` },
    { label: 'Tools short', value: sum.short, sub: `${sum.unitsShort} missing` },
    { label: 'Tools over', value: sum.over, sub: `${sum.unitsOver} extra` },
    { label: 'Worn', value: sum.worn },
    { label: 'Broken', value: sum.broken },
  ]
  const filters = [
    { k: 'all', label: `All (${rows.length})` },
    { k: 'short', label: `Short (${sum.short})` },
    { k: 'over', label: `Over (${sum.over})` },
    { k: 'uncounted', label: `Not counted (${sum.uncounted})` },
  ]

  return (
    <section aria-labelledby="ta-report-title" className="bg-white border border-surface-200 rounded-xl">
      <div className="px-4 py-3 border-b border-surface-200 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="ta-report-title" className="text-base font-bold text-surface-900 mr-auto">
            {audit.status === 'Cancelled' ? 'Counts entered before the audit was cancelled' : 'Report'}
          </h3>
          <button type="button" onClick={printReport} className={BTN_PLAIN}><Printer size={16} aria-hidden="true" /> Print</button>
          <button type="button" onClick={exportCsv} className={BTN_PLAIN}><Download size={16} aria-hidden="true" /> CSV</button>
          {status === 'Completed' && (
            <>
              <button type="button" onClick={onReopen} className={BTN_PLAIN}><RotateCcw size={16} aria-hidden="true" /> Reopen count</button>
              <button type="button" onClick={onApply} disabled={sum.counted === 0} className={BTN_PRIMARY}>
                <Check size={16} aria-hidden="true" /> Apply to inventory
              </button>
            </>
          )}
        </div>
        {status === 'Completed' && (
          <p className="text-sm text-surface-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {sum.counted === 0
              ? 'Nothing was counted, so there is nothing to apply. Reopen the count to enter numbers.'
              : 'The inventory has not been changed yet. Review the report, then use Apply to inventory.'}
          </p>
        )}
        <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {tiles.map(t => (
            <div key={t.label} className="bg-surface-50 border border-surface-200 rounded-lg px-3 py-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-surface-700">{t.label}</dt>
              <dd className="text-lg font-bold text-surface-900">{t.value}{t.sub ? <span className="block text-xs font-normal text-surface-700">{t.sub}</span> : null}</dd>
            </div>
          ))}
        </dl>
        <div role="group" aria-label="Show which tools" className="flex flex-wrap gap-2">
          {filters.map(f => (
            <button key={f.k} type="button" aria-pressed={filter === f.k} onClick={() => setFilter(f.k)}
              className={`px-3 min-h-[44px] rounded-lg text-sm font-semibold border ${FOCUS} ${
                filter === f.k ? 'bg-brand-600 border-brand-700 text-white' : 'bg-white border-surface-300 text-surface-800 hover:bg-surface-50'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-surface-700">
          {audit.kit_id
            ? 'Expected is what this kit should hold, from its kit type\u2019s tool list when the check started.'
            : 'Expected is the general stock when the audit started: the total owned minus what is assigned to kits.'}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-8 text-sm text-surface-700 text-center">No tools in this view.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-surface-600 border-b border-surface-200">
                <th scope="col" className="px-4 py-2.5">Tool</th>
                <th scope="col" className="px-4 py-2.5">Location</th>
                <th scope="col" className="px-4 py-2.5 text-right">Expected</th>
                <th scope="col" className="px-4 py-2.5 text-right">Counted</th>
                <th scope="col" className="px-4 py-2.5">Result</th>
                <th scope="col" className="px-4 py-2.5 text-right">Worn</th>
                <th scope="col" className="px-4 py-2.5 text-right">Broken</th>
                <th scope="col" className="px-4 py-2.5">Note</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.line_id} className="border-b border-surface-100 last:border-0">
                  <th scope="row" className="px-4 py-2.5 text-left font-semibold text-surface-900">
                    {r.part_name}<br /><span className="text-xs font-normal text-surface-600">{r.part_id}</span>
                  </th>
                  <td className="px-4 py-2.5 text-surface-800">{r.location || '—'}</td>
                  <td className="px-4 py-2.5 text-right text-surface-800">{r.expected_qty}</td>
                  <td className="px-4 py-2.5 text-right text-surface-800">{r.counted ? r.counted_qty : '—'}</td>
                  <td className={`px-4 py-2.5 font-semibold ${r.diff < 0 ? 'text-red-800' : !r.counted ? 'text-surface-700' : r.diff > 0 ? 'text-amber-900' : 'text-green-800'}`}>{r.result}</td>
                  <td className="px-4 py-2.5 text-right text-surface-800">{r.counted ? r.counted_worn : '—'}</td>
                  <td className="px-4 py-2.5 text-right text-surface-800">{r.counted ? r.counted_broken : '—'}</td>
                  <td className="px-4 py-2.5 text-surface-800">{r.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
