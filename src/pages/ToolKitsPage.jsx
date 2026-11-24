/**
 * RICT CMMS — Tool Kits
 * Route: /inventory/tool-kits   (opened from Inventory → Tool Kits)
 *
 * A kit is a fixed set of tools kept together in one place — a student bench,
 * a toolbox. The benches are supposed to be identical, so the tool list lives
 * ONCE on a "kit type" (e.g. "Student bench") and every kit of that type
 * ("Bench 1" … "Bench 8") shares it. A one-off toolbox is simply a kit type
 * with one kit.
 *
 * What the page does
 *   - Kit types: add, rename, make inactive, delete.
 *   - A type's tool list: which tools and how many of each per kit. Shows how
 *     many that needs across all active kits against how many are owned.
 *   - Kits: add several at once ("Bench" 1–8), rename, set each kit's own
 *     location, make inactive, delete, print QR labels.
 *   - "Check kit" starts a kit check — a tool audit scoped to that one kit —
 *     and opens it on the Tool Audit page. What the last check found (missing
 *     / worn / broken) is shown beside each kit.
 *
 * Kit tools are PART OF the tool's total on the Inventory page (8 owned, 4 in
 * kits, 4 in general stock). A general tool audit expects only the general
 * stock; kits are checked here.
 *
 * Permissions (Inventory page; the database enforces the same):
 *   manage_tool_kits — create and change kit types and kits
 *   run_tool_audit   — check a kit
 *   view_tool_kits   — read-only (students): which tools belong in each kit.
 *                      No check results, no owned / needed numbers, no labels.
 *   Any one of them opens the page.
 *
 * A scanned kit label (?kit=TK-0001) opens the page with that kit's own tool
 * list at the top — what a student sees when they scan the label on a bench.
 *
 * Data: tool_kit_types, tool_kit_type_items, tool_kits, tool_kit_holdings,
 * create_tool_kit_type(), create_tool_kits(), start_tool_kit_check()
 * (supabase/migrations/20261124d_tool_kits.sql). Reads go through mustData();
 * writes through assertWrite(). Timestamps are REAL UTC.
 *
 * Accessibility (WCAG 2.1 AA / Section 508): labelled inputs with help text,
 * 44px targets, focus-visible rings, statuses and warnings carried by text
 * (never colour alone), polite live region for results, tables with scoped
 * headers, useDialogA11y dialogs, ConfirmDialog for deletes.
 *
 * File: src/pages/ToolKitsPage.jsx
 */

import { useState, useEffect, useMemo, useCallback, useId } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Boxes, ArrowLeft, Plus, Pencil, Trash2, Loader2, AlertCircle, AlertTriangle, X, Lock,
  ClipboardCheck, Printer, RefreshCw,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite, isRlsBlock } from '@/lib/supabaseData'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { ConfirmDialog } from '@/components/ConfirmDialog'

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1'
const BTN = `inline-flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`
const BTN_PRIMARY = `${BTN} bg-brand-600 hover:bg-brand-700 text-white`
const BTN_PLAIN = `${BTN} border border-surface-300 bg-white text-surface-800 hover:bg-surface-50`
const BTN_ICON = `inline-flex items-center justify-center w-11 h-11 rounded-lg text-surface-700 hover:bg-surface-100 disabled:opacity-50 ${FOCUS}`
const INPUT = `w-full px-3 min-h-[44px] text-sm border border-surface-300 rounded-lg bg-white ${FOCUS}`
const LABEL = 'block text-sm font-semibold text-surface-800 mb-1'
const BADGE = 'inline-block px-2.5 py-0.5 rounded-full border text-xs font-semibold'

/* ── Pure helpers ─────────────────────────────────────────────────── */
const toCount = (v) => Math.max(0, Math.floor(Number(v) || 0))
const naturalSort = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
const fmtWhen = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const friendly = (err, fallback) => {
  if (isRlsBlock(err)) return 'You do not have permission for that. Changing kits needs Inventory → manage_tool_kits.'
  const msg = String(err?.cause?.message || err?.message || '').replace(/^[a-z_.]+:\s*/i, '')
  return msg || fallback
}

/** What the last check found in one kit, as text. */
function kitFinding(kit, holdings) {
  if (!kit.last_checked_at) return { text: 'Never checked', ok: null }
  const mine = holdings.filter(h => h.kit_id === kit.kit_id)
  const m = mine.reduce((n, h) => n + h.qty_missing, 0)
  const w = mine.reduce((n, h) => n + h.qty_worn, 0)
  const b = mine.reduce((n, h) => n + h.qty_broken, 0)
  const parts = [m && `${m} missing`, b && `${b} broken`, w && `${w} worn`].filter(Boolean)
  return parts.length ? { text: parts.join(', '), ok: false } : { text: 'Complete', ok: true }
}

function Modal({ title, onClose, busy, children, footer }) {
  const ref = useDialogA11y(true, onClose)
  const titleId = useId()
  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200">
          <h2 id={titleId} className="text-lg font-bold text-surface-900">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={BTN_ICON}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">{children}</div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-surface-200">{footer}</div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════ */
export default function ToolKitsPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Inventory')
  const canManage = hasPerm('manage_tool_kits')
  const canAudit = hasPerm('run_tool_audit')
  const isStaff = canManage || canAudit                    // sees check results and stock numbers
  const canView = isStaff || hasPerm('view_tool_kits')     // students: the lists only
  const [params] = useSearchParams()
  const focusKit = params.get('kit') || ''          // from a scanned kit label

  const [data, setData] = useState({ types: [], items: [], kits: [], holdings: [], tools: [], checks: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [typeDialog, setTypeDialog] = useState(null)   // { type } or { type: null } for new
  const [kitDialog, setKitDialog] = useState(null)     // kit being edited
  const [confirm, setConfirm] = useState(null)         // { kind: 'type' | 'kit', row }
  const [busy, setBusy] = useState(false)
  const [announce, setAnnounce] = useState('')
  const say = useCallback((msg) => { setAnnounce(''); setTimeout(() => setAnnounce(msg), 50) }, [])

  const userShort = profile ? `${profile.first_name || ''} ${profile.last_name?.charAt(0) || ''}.`.trim() : ''

  const load = useCallback(async () => {
    try {
      const [t, i, k, h, inv, a] = await Promise.all([
        supabase.from('tool_kit_types').select('*'),
        supabase.from('tool_kit_type_items').select('*'),
        supabase.from('tool_kits').select('*'),
        supabase.from('tool_kit_holdings').select('*'),
        supabase.from('inventory').select('part_id, part_name, qty_in_stock, status, location').eq('item_type', 'Tool'),
        supabase.from('tool_audits').select('audit_id, kit_id, status, applied_at').not('kit_id', 'is', null).is('applied_at', null).neq('status', 'Cancelled'),
      ])
      setData({
        types: (mustData(t, 'tool_kit_types.select') || []).sort((x, y) => naturalSort(x.name, y.name)),
        items: mustData(i, 'tool_kit_type_items.select') || [],
        kits: (mustData(k, 'tool_kits.select') || []).sort((x, y) => naturalSort(x.name, y.name)),
        holdings: mustData(h, 'tool_kit_holdings.select') || [],
        tools: (mustData(inv, 'inventory.select') || []).sort((x, y) => naturalSort(x.part_name, y.part_name)),
        // A check still in play needs run_tool_audit to read; without it this is just empty.
        checks: a.error ? [] : (a.data || []),
      })
      setLoadError('')
    } catch (e) {
      console.error('ToolKits load:', e)
      setLoadError(friendly(e, 'Could not load the tool kits.'))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (permsLoading) return
    if (!canView) { setLoading(false); return }
    load()
  }, [permsLoading, canView, load])

  // After a scanned label: bring that kit into view once the list is drawn
  useEffect(() => {
    if (!focusKit || loading) return
    const el = document.getElementById(`kit-row-${focusKit}`)
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus() }
  }, [focusKit, loading])

  const toolById = useMemo(() => Object.fromEntries(data.tools.map(t => [t.part_id, t])), [data.tools])

  // The kit named by a scanned label, with its type and tool list
  const scanned = useMemo(() => {
    const kit = focusKit && data.kits.find(k => k.kit_id === focusKit)
    const type = kit && data.types.find(t => t.type_id === kit.type_id)
    if (!kit || !type) return null
    const items = data.items.filter(i => i.type_id === type.type_id)
      .sort((a, b) => naturalSort(toolById[a.part_id]?.part_name || a.part_id, toolById[b.part_id]?.part_name || b.part_id))
    return { kit, type, items }
  }, [focusKit, data, toolById])

  /** part_id -> how many are assigned to ACTIVE kits of ACTIVE types (all types together). */
  const neededByTool = useMemo(() => {
    const activeKits = {}
    for (const k of data.kits) if (k.status === 'Active') activeKits[k.type_id] = (activeKits[k.type_id] || 0) + 1
    const activeTypes = new Set(data.types.filter(t => t.status === 'Active').map(t => t.type_id))
    const map = {}
    for (const it of data.items) {
      if (!activeTypes.has(it.type_id)) continue
      map[it.part_id] = (map[it.part_id] || 0) + it.qty * (activeKits[it.type_id] || 0)
    }
    return map
  }, [data])

  /* ── Actions ── */
  const run = async (fn, okMsg, failMsg) => {
    setBusy(true)
    try {
      await fn()
      if (okMsg) { toast.success(okMsg); say(okMsg) }
      await load()
      setBusy(false)
      return true
    } catch (e) {
      toast.error(friendly(e, failMsg))
      setBusy(false)
      return false
    }
  }

  const saveType = async (type, values) => {
    const ok = await run(async () => {
      if (type) {
        const { error } = assertWrite(await supabase.from('tool_kit_types')
          .update({ name: values.name, notes: values.notes, status: values.status, updated_at: new Date().toISOString(), updated_by: userShort })
          .eq('type_id', type.type_id).select(), 'tool_kit_types.update')
        if (error) throw error
      } else {
        mustData(await supabase.rpc('create_tool_kit_type', { p_name: values.name, p_notes: values.notes, p_by: userShort }), 'create_tool_kit_type')
      }
    }, type ? 'Kit type saved' : 'Kit type added', 'Could not save the kit type.')
    if (ok) setTypeDialog(null)
  }

  const saveKit = async (kit, values) => {
    const ok = await run(async () => {
      const { error } = assertWrite(await supabase.from('tool_kits')
        .update({ name: values.name, location: values.location, status: values.status, notes: values.notes })
        .eq('kit_id', kit.kit_id).select(), 'tool_kits.update')
      if (error) throw error
    }, 'Kit saved', 'Could not save the kit.')
    if (ok) setKitDialog(null)
  }

  const doDelete = async () => {
    const { kind, row } = confirm
    const ok = await run(async () => {
      const q = kind === 'type'
        ? supabase.from('tool_kit_types').delete().eq('type_id', row.type_id)
        : supabase.from('tool_kits').delete().eq('kit_id', row.kit_id)
      const { error } = assertWrite(await q.select(), `tool_${kind}.delete`)
      if (error) throw error
    }, kind === 'type' ? 'Kit type deleted' : 'Kit deleted', 'Could not delete it.')
    if (ok) setConfirm(null)
  }

  const checkKit = async (kit) => {
    const open = data.checks.find(c => c.kit_id === kit.kit_id)
    if (open) { navigate(`/inventory/tool-audit?id=${encodeURIComponent(open.audit_id)}`); return }
    setBusy(true)
    try {
      const id = mustData(await supabase.rpc('start_tool_kit_check', { p_kit_id: kit.kit_id, p_name: '', p_term: '', p_by: userShort }), 'start_tool_kit_check')
      if (!id) throw new Error('The check was not created.')
      navigate(`/inventory/tool-audit?id=${encodeURIComponent(id)}`)
    } catch (e) {
      toast.error(friendly(e, 'Could not start the kit check.'))
      setBusy(false)
    }
  }

  /* ── Not allowed ── */
  if (!permsLoading && !canView) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-start gap-3 bg-surface-50 border border-surface-200 rounded-xl px-5 py-4" role="alert">
          <Lock size={20} className="mt-0.5 shrink-0 text-surface-600" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-bold text-surface-900">You don&rsquo;t have access to tool kits</h1>
            <p className="text-sm text-surface-700 mt-1">Opening this page needs the Inventory permission &ldquo;view_tool_kits&rdquo;. Ask an instructor if you should have it.</p>
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
          <Boxes size={22} className="text-brand-700" aria-hidden="true" />
        </div>
        <div className="mr-auto">
          <h1 className="text-xl font-bold text-surface-900">Tool Kits</h1>
          <p className="text-sm text-surface-600">{isStaff ? 'Benches and toolboxes: what belongs in each, and what the last check found.' : 'What belongs in each bench and toolbox.'}</p>
        </div>
        <button type="button" onClick={() => navigate('/inventory')} className={BTN_PLAIN}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to Inventory
        </button>
        <button type="button" onClick={load} className={BTN_PLAIN}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        {canManage && (
          <button type="button" onClick={() => setTypeDialog({ type: null })} className={BTN_PRIMARY}>
            <Plus size={16} aria-hidden="true" /> New kit type
          </button>
        )}
      </div>

      {loadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-sm" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{loadError}</span>
          <button type="button" onClick={load} className={`ml-auto underline font-semibold min-h-[44px] px-2 ${FOCUS}`}>Try again</button>
        </div>
      )}

      {loading || permsLoading ? (
        <p className="flex items-center gap-2 text-sm text-surface-600 py-8 justify-center">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading tool kits…
        </p>
      ) : data.types.length === 0 ? (
        <div className="bg-white border border-surface-200 rounded-xl px-5 py-8 text-sm text-surface-800 text-center space-y-2">
          <p className="font-semibold text-surface-900">No kit types yet.</p>
          <p>A kit type is the shared tool list for a set of identical kits — for example &ldquo;Student bench&rdquo;. Add the type, list its tools, then add the benches.</p>
          {!canManage && isStaff && <p>You can check kits, but adding them needs Inventory → manage_tool_kits.</p>}
        </div>
      ) : (
        <>
        {/* From a scanned kit label: that kit's own list, first */}
        {scanned && (
          <section aria-labelledby="tk-scanned-title" className="bg-brand-50 border border-brand-200 rounded-xl px-4 py-3">
            <h2 id="tk-scanned-title" className="text-base font-bold text-surface-900">{scanned.kit.name}</h2>
            <p className="text-sm text-surface-800">
              {scanned.type.name}{scanned.kit.location && scanned.kit.location !== scanned.kit.name ? ` · ${scanned.kit.location}` : ''} · {scanned.kit.kit_id}
            </p>
            {scanned.items.length === 0 ? (
              <p className="text-sm text-surface-800 mt-2">No tools are listed for this kit yet.</p>
            ) : (
              <>
                <p className="text-sm font-semibold text-surface-900 mt-2">This kit should have:</p>
                <ul className="mt-1 text-sm text-surface-900 list-disc pl-5 space-y-0.5">
                  {scanned.items.map(it => (
                    <li key={it.part_id}><strong>{it.qty}</strong> × {toolById[it.part_id]?.part_name || it.part_id}</li>
                  ))}
                </ul>
                <p className="text-xs text-surface-800 mt-2">Something missing or broken? Tell your instructor.</p>
              </>
            )}
          </section>
        )}
        {(isStaff ? data.types : data.types.filter(t => t.status === 'Active')).map(type => (
          <TypeCard key={type.type_id} type={type} data={data} toolById={toolById} neededByTool={neededByTool}
            canManage={canManage} canAudit={canAudit} isStaff={isStaff} busy={busy} userShort={userShort} focusKit={focusKit}
            run={run} onEditType={() => setTypeDialog({ type })} onDeleteType={() => setConfirm({ kind: 'type', row: type })}
            onEditKit={setKitDialog} onDeleteKit={(kit) => setConfirm({ kind: 'kit', row: kit })} onCheckKit={checkKit} />
        ))}
        </>
      )}

      {typeDialog && <TypeDialog type={typeDialog.type} busy={busy} onClose={() => setTypeDialog(null)} onSave={saveType} />}
      {kitDialog && <KitDialog kit={kitDialog} busy={busy} onClose={() => setKitDialog(null)} onSave={saveKit} />}
      {confirm && (
        <ConfirmDialog open variant="danger" busy={busy}
          title={confirm.kind === 'type' ? 'Delete this kit type?' : 'Delete this kit?'}
          message={confirm.kind === 'type'
            ? <>Delete <strong>{confirm.row.name}</strong>, its tool list and its {data.kits.filter(k => k.type_id === confirm.row.type_id).length} kit(s)? The tools themselves stay in the inventory, and past kit checks stay in the audit history. To keep the record but stop using it, make it Inactive instead.</>
            : <>Delete <strong>{confirm.row.name}</strong>? Its tools go back to general stock. Anything its last check marked missing, worn or broken stays on the tool&rsquo;s totals. Past checks stay in the audit history.</>}
          confirmLabel="Delete" cancelLabel="Keep it"
          onConfirm={doDelete} onClose={() => setConfirm(null)} />
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   One kit type: its tool list and its kits
   ══════════════════════════════════════════════════════════════════════ */
function TypeCard({ type, data, toolById, neededByTool, canManage, canAudit, isStaff, busy, userShort, focusKit, run,
  onEditType, onDeleteType, onEditKit, onDeleteKit, onCheckKit }) {
  const uid = useId()
  const items = data.items.filter(i => i.type_id === type.type_id)
    .sort((a, b) => naturalSort(toolById[a.part_id]?.part_name || a.part_id, toolById[b.part_id]?.part_name || b.part_id))
  // Students see the kits in use; staff also see inactive ones
  const kits = data.kits.filter(k => k.type_id === type.type_id && (isStaff || k.status === 'Active'))
  const activeKits = kits.filter(k => k.status === 'Active').length
  const available = data.tools.filter(t => t.status === 'Active' && !items.some(i => i.part_id === t.part_id))

  const [addTool, setAddTool] = useState('')
  const [addQty, setAddQty] = useState('1')
  const [prefix, setPrefix] = useState('Bench')
  const [first, setFirst] = useState('')
  const [howMany, setHowMany] = useState('1')

  // Next free number for the prefix, so "Bench" 1–4 followed by "add 4 more" offers 5
  const nextNumber = useMemo(() => {
    const p = prefix.trim().toLowerCase()
    let max = 0
    for (const k of kits) {
      const m = k.name.trim().toLowerCase().match(/^(.*?)\s*(\d+)$/)
      if (m && m[1].trim() === p) max = Math.max(max, parseInt(m[2], 10))
    }
    return max + 1
  }, [kits, prefix])
  const start = first.trim() === '' ? nextNumber : toCount(first)
  const count = Math.min(100, Math.max(1, toCount(howMany) || 1))
  const newNames = Array.from({ length: count }, (_, n) => `${prefix.trim()} ${start + n}`.trim())
  const preview = count === 1 ? newNames[0] : `${newNames[0]} … ${newNames[count - 1]}`

  const addItem = () => run(async () => {
    const { error } = assertWrite(await supabase.from('tool_kit_type_items')
      .insert({ type_id: type.type_id, part_id: addTool, qty: Math.max(1, toCount(addQty)) }).select(), 'tool_kit_type_items.insert')
    if (error) throw error
    setAddTool(''); setAddQty('1')
  }, 'Tool added to the list', 'Could not add the tool.')

  const setItemQty = (item, value) => {
    const qty = Math.max(1, toCount(value))
    if (qty === item.qty) return
    run(async () => {
      const { error } = assertWrite(await supabase.from('tool_kit_type_items').update({ qty })
        .eq('type_id', item.type_id).eq('part_id', item.part_id).select(), 'tool_kit_type_items.update')
      if (error) throw error
    }, 'Quantity saved', 'Could not save the quantity.')
  }

  const removeItem = (item) => run(async () => {
    const { error } = assertWrite(await supabase.from('tool_kit_type_items').delete()
      .eq('type_id', item.type_id).eq('part_id', item.part_id).select(), 'tool_kit_type_items.delete')
    if (error) throw error
  }, 'Tool removed from the list', 'Could not remove the tool.')

  const addKits = () => run(async () => {
    mustData(await supabase.rpc('create_tool_kits', {
      p_type_id: type.type_id, p_names: newNames, p_locations: newNames.map(() => ''), p_by: userShort,
    }), 'create_tool_kits')
    setFirst(''); setHowMany('1')
  }, `${count} kit${count === 1 ? '' : 's'} added`, 'Could not add the kits.')

  const printLabels = async () => {
    const list = kits.filter(k => k.status === 'Active')
    if (!list.length) { toast.error('There are no active kits to print labels for.'); return }
    // Same label stock setting the Inventory labels use (falls back to 2" x 1")
    let w = 2, h = 1
    try {
      const dims = mustData(await supabase.from('settings').select('setting_key, setting_value')
        .in('setting_key', ['label_width_inches', 'label_height_inches']), 'settings.select')
      for (const d of dims || []) {
        const v = parseFloat(d.setting_value)
        if (!Number.isNaN(v) && v > 0) { if (d.setting_key === 'label_width_inches') w = v; if (d.setting_key === 'label_height_inches') h = v }
      }
    } catch (e) { console.warn('[ToolKits] label size fetch failed, using 2x1:', e?.message) }
    const qr = (h * 0.8).toFixed(3)
    const labels = list.map(k => {
      const url = `${window.location.origin}/inventory/tool-kits?kit=${encodeURIComponent(k.kit_id)}`
      return `<div class="label"><img alt="" src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}">
        <div class="info"><div class="name">${esc(k.name)}</div><div>${esc(type.name)}</div><div>${esc(k.kit_id)}</div></div></div>`
    }).join('')
    const win = window.open('', '_blank')
    if (!win) { toast.error('The print window was blocked. Allow pop-ups for this site.'); return }
    win.document.write(`<html lang="en"><head><title>Kit labels — ${esc(type.name)}</title><style>
      @page { size: ${w}in ${h}in; margin: 0; } body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
      .label { width: ${w}in; height: ${h}in; display: flex; align-items: center; gap: 0.06in; padding: 0.05in; box-sizing: border-box; page-break-after: always; overflow: hidden; }
      .label img { width: ${qr}in; height: ${qr}in; } .info { font-size: ${(7 * Math.min(w, h)).toFixed(1)}px; line-height: 1.25; overflow: hidden; }
      .name { font-weight: bold; font-size: ${(10 * Math.min(w, h)).toFixed(1)}px; }
    </style></head><body>${labels}</body></html>`)
    win.document.close()
    setTimeout(() => win.print(), 800)
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="bg-white border border-surface-200 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-surface-200">
        <div className="mr-auto">
          <h2 id={`${uid}-title`} className="text-base font-bold text-surface-900 inline">{type.name}</h2>
          {type.status !== 'Active' && <span className={`${BADGE} ml-2 bg-surface-100 text-surface-700 border-surface-300`}>Inactive</span>}
          <p className="text-xs text-surface-700">{type.type_id} · {items.length} tool{items.length === 1 ? '' : 's'} on the list · {activeKits} active kit{activeKits === 1 ? '' : 's'}{isStaff && type.notes ? ` · ${type.notes}` : ''}</p>
        </div>
        {isStaff && <button type="button" onClick={printLabels} className={BTN_PLAIN}><Printer size={16} aria-hidden="true" /> Kit labels</button>}
        {canManage && (
          <>
            <button type="button" onClick={onEditType} className={BTN_ICON} aria-label={`Edit kit type ${type.name}`}><Pencil size={18} aria-hidden="true" /></button>
            <button type="button" onClick={onDeleteType} className={BTN_ICON} aria-label={`Delete kit type ${type.name}`}><Trash2 size={18} aria-hidden="true" /></button>
          </>
        )}
      </div>

      {/* Tool list */}
      <div className="px-4 py-3 border-b border-surface-200">
        <h3 className="text-sm font-bold text-surface-900 mb-2">Tools in each kit</h3>
        {items.length === 0 ? (
          <p className="text-sm text-surface-700">No tools on the list yet.{canManage ? ' Add the tools every kit of this type should hold.' : ''}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-surface-600 border-b border-surface-200">
                  <th scope="col" className="py-2 pr-3">Tool</th>
                  <th scope="col" className="py-2 px-3">Per kit</th>
                  {isStaff && <th scope="col" className="py-2 px-3">Needed for kits</th>}
                  {isStaff && <th scope="col" className="py-2 px-3">Owned</th>}
                  {canManage && <th scope="col" className="py-2 pl-3"><span className="sr-only">Remove</span></th>}
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const tool = toolById[it.part_id]
                  const owned = Number(tool?.qty_in_stock) || 0
                  const needed = neededByTool[it.part_id] || 0
                  const name = tool?.part_name || it.part_id
                  return (
                    <tr key={it.part_id} className="border-b border-surface-100 last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-semibold text-surface-900">
                        {name}<br /><span className="text-xs font-normal text-surface-600">{it.part_id}</span>
                        {isStaff && !tool && <span className="block text-xs font-semibold text-red-800">This tool is no longer in the inventory.</span>}
                        {isStaff && tool && tool.status !== 'Active' && <span className="block text-xs font-semibold text-amber-900">This tool is inactive.</span>}
                      </th>
                      <td className="py-2 px-3">
                        {canManage ? (
                          <input type="number" min="1" step="1" inputMode="numeric" defaultValue={it.qty} key={`${it.part_id}-${it.qty}`}
                            aria-label={`How many ${name} in each kit`} disabled={busy}
                            className={`w-20 px-2 min-h-[44px] text-center border border-surface-300 rounded-lg bg-white ${FOCUS}`}
                            onBlur={e => setItemQty(it, e.target.value)} />
                        ) : it.qty}
                      </td>
                      {isStaff && <td className="py-2 px-3 text-surface-800">{needed}</td>}
                      {isStaff && (
                      <td className="py-2 px-3 text-surface-800">
                        {tool ? owned : '—'}
                        {tool && needed > owned && (
                          <span className="flex items-center gap-1 text-xs font-semibold text-red-800">
                            <AlertTriangle size={14} aria-hidden="true" /> {needed - owned} short for the kits
                          </span>
                        )}
                      </td>
                      )}
                      {canManage && (
                        <td className="py-2 pl-3 text-right">
                          <button type="button" onClick={() => removeItem(it)} disabled={busy} className={BTN_ICON}
                            aria-label={`Remove ${name} from ${type.name}`}><Trash2 size={18} aria-hidden="true" /></button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {canManage && (
          <div className="flex flex-wrap items-end gap-2 mt-3">
            <div className="flex-1 min-w-[200px]">
              <label htmlFor={`${uid}-tool`} className={LABEL}>Add a tool</label>
              <select id={`${uid}-tool`} className={INPUT} value={addTool} onChange={e => setAddTool(e.target.value)}>
                <option value="">{available.length ? 'Choose a tool…' : 'No more tools to add'}</option>
                {available.map(t => <option key={t.part_id} value={t.part_id}>{t.part_name} ({t.part_id})</option>)}
              </select>
            </div>
            <div className="w-24">
              <label htmlFor={`${uid}-qty`} className={LABEL}>Per kit</label>
              <input id={`${uid}-qty`} type="number" min="1" step="1" inputMode="numeric" className={`${INPUT} text-center`} value={addQty} onChange={e => setAddQty(e.target.value)} />
            </div>
            <button type="button" onClick={addItem} disabled={busy || !addTool} className={BTN_PLAIN}><Plus size={16} aria-hidden="true" /> Add tool</button>
          </div>
        )}
      </div>

      {/* Kits */}
      <div className="px-4 py-3">
        <h3 className="text-sm font-bold text-surface-900 mb-2">Kits</h3>
        {kits.length === 0 ? (
          <p className="text-sm text-surface-700">No kits of this type yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-surface-600 border-b border-surface-200">
                  <th scope="col" className="py-2 pr-3">Kit</th>
                  <th scope="col" className="py-2 px-3">Location</th>
                  {isStaff && <th scope="col" className="py-2 px-3">Last check</th>}
                  {isStaff && <th scope="col" className="py-2 pl-3"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {kits.map(k => {
                  const f = kitFinding(k, data.holdings)
                  const open = data.checks.find(c => c.kit_id === k.kit_id)
                  return (
                    <tr key={k.kit_id} id={`kit-row-${k.kit_id}`} tabIndex={-1}
                      className={`border-b border-surface-100 last:border-0 ${focusKit === k.kit_id ? 'bg-brand-50' : ''} focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}>
                      <th scope="row" className="py-2 pr-3 text-left font-semibold text-surface-900">
                        {k.name}
                        {k.status !== 'Active' && <span className={`${BADGE} ml-2 bg-surface-100 text-surface-700 border-surface-300`}>Inactive</span>}
                        <br /><span className="text-xs font-normal text-surface-600">{k.kit_id}{isStaff && k.notes ? ` · ${k.notes}` : ''}</span>
                      </th>
                      <td className="py-2 px-3 text-surface-800">{k.location || '—'}</td>
                      {isStaff && (
                      <td className="py-2 px-3">
                        <span className={`font-semibold ${f.ok === false ? 'text-red-800' : f.ok ? 'text-green-800' : 'text-surface-700'}`}>{f.text}</span>
                        {k.last_checked_at && <span className="block text-xs text-surface-700">{fmtWhen(k.last_checked_at)}{k.last_checked_by ? ` · ${k.last_checked_by}` : ''}</span>}
                        {open && <span className="block text-xs font-semibold text-blue-800">Check {open.status === 'Open' ? 'in progress' : 'finished, not applied yet'} ({open.audit_id})</span>}
                      </td>
                      )}
                      {isStaff && (
                      <td className="py-2 pl-3">
                        <div className="flex justify-end gap-1">
                          {canAudit && k.status === 'Active' && (
                            <button type="button" onClick={() => onCheckKit(k)} disabled={busy} className={BTN_PLAIN}
                              aria-label={`${open ? 'Continue the check of' : 'Check'} ${k.name}`}>
                              <ClipboardCheck size={16} aria-hidden="true" /> {open ? 'Continue' : 'Check kit'}
                            </button>
                          )}
                          {canManage && (
                            <>
                              <button type="button" onClick={() => onEditKit(k)} className={BTN_ICON} aria-label={`Edit ${k.name}`}><Pencil size={18} aria-hidden="true" /></button>
                              <button type="button" onClick={() => onDeleteKit(k)} className={BTN_ICON} aria-label={`Delete ${k.name}`}><Trash2 size={18} aria-hidden="true" /></button>
                            </>
                          )}
                        </div>
                      </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {canManage && (
          <fieldset className="mt-3 border border-surface-200 rounded-lg px-3 pt-2 pb-3">
            <legend className="px-1 text-sm font-semibold text-surface-800">Add kits</legend>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[140px]">
                <label htmlFor={`${uid}-prefix`} className={LABEL}>Name</label>
                <input id={`${uid}-prefix`} type="text" maxLength={60} className={INPUT} value={prefix} onChange={e => setPrefix(e.target.value)} />
              </div>
              <div className="w-28">
                <label htmlFor={`${uid}-first`} className={LABEL}>First number</label>
                <input id={`${uid}-first`} type="number" min="0" step="1" inputMode="numeric" className={`${INPUT} text-center`}
                  placeholder={String(nextNumber)} value={first} onChange={e => setFirst(e.target.value)} />
              </div>
              <div className="w-28">
                <label htmlFor={`${uid}-many`} className={LABEL}>How many</label>
                <input id={`${uid}-many`} type="number" min="1" max="100" step="1" inputMode="numeric" className={`${INPUT} text-center`}
                  aria-describedby={`${uid}-preview`} value={howMany} onChange={e => setHowMany(e.target.value)} />
              </div>
              <button type="button" onClick={addKits} disabled={busy || !prefix.trim()} className={BTN_PLAIN}><Plus size={16} aria-hidden="true" /> Add</button>
            </div>
            <p id={`${uid}-preview`} className="text-xs text-surface-700 mt-2" aria-live="polite">
              {prefix.trim() ? <>Will add: <strong>{preview}</strong>. Each kit&rsquo;s location starts as its name; change it with the pencil.</> : 'Enter a name, for example Bench.'}
            </p>
          </fieldset>
        )}
      </div>
    </section>
  )
}

/* ── Dialogs ──────────────────────────────────────────────────────── */
function TypeDialog({ type, busy, onClose, onSave }) {
  const [name, setName] = useState(type?.name || '')
  const [notes, setNotes] = useState(type?.notes || '')
  const [status, setStatus] = useState(type?.status || 'Active')
  const [error, setError] = useState('')
  const submit = () => {
    if (!name.trim()) { setError('Give the kit type a name.'); return }
    onSave(type, { name: name.trim(), notes: notes.trim(), status })
  }
  return (
    <Modal title={type ? 'Edit kit type' : 'New kit type'} onClose={onClose} busy={busy}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} className={BTN_PLAIN}>Cancel</button>
        <button type="button" onClick={submit} disabled={busy} className={BTN_PRIMARY}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Save
        </button>
      </>}>
      <div>
        <label htmlFor="tk-type-name" className={LABEL}>Name</label>
        <input id="tk-type-name" type="text" maxLength={80} className={INPUT} aria-describedby="tk-type-name-help"
          value={name} onChange={e => setName(e.target.value)} />
        <p id="tk-type-name-help" className="text-xs text-surface-700 mt-1.5">What the kits have in common, for example &ldquo;Student bench&rdquo;. The individual benches are added afterwards.</p>
      </div>
      <div>
        <label htmlFor="tk-type-notes" className={LABEL}>Notes (optional)</label>
        <input id="tk-type-notes" type="text" maxLength={200} className={INPUT} value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      {type && (
        <div>
          <label htmlFor="tk-type-status" className={LABEL}>Status</label>
          <select id="tk-type-status" className={INPUT} aria-describedby="tk-type-status-help" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="Active">Active</option><option value="Inactive">Inactive</option>
          </select>
          <p id="tk-type-status-help" className="text-xs text-surface-700 mt-1.5">Inactive: its kits stop counting toward tool totals and can&rsquo;t be checked, but nothing is deleted.</p>
        </div>
      )}
      {error && <p className="text-sm font-semibold text-red-800" role="alert">{error}</p>}
    </Modal>
  )
}

function KitDialog({ kit, busy, onClose, onSave }) {
  const [name, setName] = useState(kit.name)
  const [location, setLocation] = useState(kit.location || '')
  const [notes, setNotes] = useState(kit.notes || '')
  const [status, setStatus] = useState(kit.status)
  const [error, setError] = useState('')
  const submit = () => {
    if (!name.trim()) { setError('Give the kit a name.'); return }
    onSave(kit, { name: name.trim(), location: location.trim() || name.trim(), notes: notes.trim(), status })
  }
  return (
    <Modal title={`Edit ${kit.name}`} onClose={onClose} busy={busy}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} className={BTN_PLAIN}>Cancel</button>
        <button type="button" onClick={submit} disabled={busy} className={BTN_PRIMARY}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Save
        </button>
      </>}>
      <div>
        <label htmlFor="tk-kit-name" className={LABEL}>Name</label>
        <input id="tk-kit-name" type="text" maxLength={80} className={INPUT} value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="tk-kit-loc" className={LABEL}>Location</label>
        <input id="tk-kit-loc" type="text" maxLength={120} className={INPUT} aria-describedby="tk-kit-loc-help"
          value={location} onChange={e => setLocation(e.target.value)} />
        <p id="tk-kit-loc-help" className="text-xs text-surface-700 mt-1.5">Where this kit is, for example &ldquo;Room 354, Bench 3&rdquo;. Tools in the kit are understood to be here, not at the tool&rsquo;s general location.</p>
      </div>
      <div>
        <label htmlFor="tk-kit-notes" className={LABEL}>Notes (optional)</label>
        <input id="tk-kit-notes" type="text" maxLength={200} className={INPUT} value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      <div>
        <label htmlFor="tk-kit-status" className={LABEL}>Status</label>
        <select id="tk-kit-status" className={INPUT} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="Active">Active</option><option value="Inactive">Inactive</option>
        </select>
      </div>
      {error && <p className="text-sm font-semibold text-red-800" role="alert">{error}</p>}
    </Modal>
  )
}
