import { useState, useEffect, useCallback, useRef } from 'react'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { supabase } from '@/lib/supabase'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import {
  computeBudget, buildMonthlyTrend, lineMoney,
  COMMITTED_ORDER_STATUSES, BUDGET_ORDER_STATUSES, ORDER_BUDGET_COLUMNS,
  orderInSchoolYear, orderBudgetDate, orderVendor,
} from '@/lib/budgetMath'
import { parseBudgetRows, planImport, fiscalYearToSchoolYear } from '@/lib/budgetImport'

/** Local wall-clock time stored with a +00 offset (fake-UTC convention). */
function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}+00`
}


// ═══════════════════════════════════════════════════════════════════════════════
// SCHOOL YEAR HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** School year runs July 1 – June 30. Jan 2026 → "2025-2026", Aug 2025 → "2025-2026" */
export function getSchoolYearForDate(date) {
  const d = date ? new Date(date) : new Date()
  const year = d.getFullYear()
  const month = d.getMonth()          // 0-based
  if (month >= 6) return `${year}-${year + 1}`   // Jul-Dec
  return `${year - 1}-${year}`                    // Jan-Jun
}

export function getCurrentSchoolYear() {
  return getSchoolYearForDate(new Date())
}

/** "2025-2026" → { start: 2025-07-01, end: 2026-06-30T23:59:59 } */
export function parseSchoolYearDates(sy) {
  const [startYear, endYear] = sy.split('-').map(Number)
  return {
    start: new Date(startYear, 6, 1),
    end: new Date(endYear, 5, 30, 23, 59, 59),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OBJECT CODE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

export const OBJECT_CODES = {
  '1040': 'Membership/Education',
  '1420': 'Equipment',
  '1730': 'Software',
  '1850': 'Food/Consumables',
  '1870': 'Gas/Cylinders',
  '1871': 'Uniforms/Apparel',
  '2010': 'Postal/Shipping',
  '2360': 'Fuel',
  '2870': 'Membership Fees',
  '2891': 'Hosting/Events',
  '3000': 'Supplies',
}

/** Map object code → category */
export function objectCodeToCategory(code) {
  const map = {
    '3000': 'Supplies',
    '1420': 'Equipment',
    '1730': 'Software',
    '1040': 'Training',
    '1850': 'Supplies',
    '1870': 'Supplies',
    '1871': 'Supplies',
    '2010': 'Supplies',
    '2360': 'Supplies',
    '2870': 'Other',
    '2891': 'Other',
  }
  return map[code] || 'Other'
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT STATUS HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export const PAYMENT_STATUSES = ['Paid', 'Encumbered', 'Partial', 'Pending', 'Liquidated']

export function getPaymentStatusColor(status) {
  switch (status) {
    case 'Paid': return 'bg-emerald-50 text-emerald-700'
    case 'Encumbered': return 'bg-amber-50 text-amber-700'
    case 'Partial': return 'bg-blue-50 text-blue-700'
    case 'Pending': return 'bg-surface-100 text-surface-600'
    case 'Liquidated': return 'bg-slate-100 text-slate-600'
    default: return 'bg-surface-100 text-surface-600'
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NUMBER PARSING HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely parse a number from a cell value that may be:
 *  - a raw number (1599.00)
 *  - a formatted string ("1,599.00")
 *  - a currency string ("$1,599.00")
 *  - null/undefined/empty
 */
function parseNumber(val) {
  if (val == null) return 0
  if (typeof val === 'number') return val
  // Strip $, commas, whitespace then parse
  const cleaned = String(val).replace(/[$,\s]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? 0 : num
}

// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetOverview  –  balances, encumbrances, orders not yet on the college
// report, category totals, monthly trend. All math is in src/lib/budgetMath.js.
// ═══════════════════════════════════════════════════════════════════════════════

/** Fetch everything computeBudget() needs for one school year. */
async function fetchBudgetInputs(sy) {
  const [entries, orders] = await Promise.all([
    supabase.from('program_budget').select('*').eq('school_year', sy),
    supabase.from('orders').select(ORDER_BUDGET_COLUMNS).in('status', BUDGET_ORDER_STATUSES),
  ])
  return {
    entries: mustData(entries, 'program_budget.select') || [],
    orders: mustData(orders, 'orders.select') || [],
  }
}

export function useBudgetOverview(schoolYear) {
  const [overview, setOverview] = useState(null)
  const [availableYears, setAvailableYears] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const sy = schoolYear || getCurrentSchoolYear()
      const { entries, orders } = await fetchBudgetInputs(sy)
      const b = computeBudget({ entries, orders, schoolYear: sy })
      const years = await getAvailableYears()

      // College lines available as link targets (for "Link to college line")
      const collegeLines = entries
        .filter(e => e.status !== 'Voided' && e.type === 'Manual Expense')
        .map(e => ({ id: e.id, description: e.description, reference: e.reference || '', amount: parseFloat(e.amount) || 0, date: e.entry_date, linkedOrderIds: e.linked_order_ids || [] }))
        .sort((a, b2) => String(b2.date).localeCompare(String(a.date)))

      setOverview({
        ...b,
        // Back-compatible names
        paidTotal: b.paid,
        encumberedTotal: b.encumberedOpen,
        partialTotal: b.partialPaid,
        entryCount: entries.length,
        monthlyTrend: buildMonthlyTrend(sy, b.monthly),
        collegeLines,
      })
      setAvailableYears(years)
      setLoadError(null)
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Budget overview error:', err)
      setLoadError(err.message || 'Failed to load budget overview')
      if (!hasLoadedRef.current) toast.error('Failed to load budget overview')
    } finally {
      setLoading(false)
    }
  }, [schoolYear])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when program_budget or orders change
  useEffect(() => {
    return subscribeWithReconnect(`budget-overview-changes-${Date.now()}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { fetch() })
    , { tag: 'ProgramBudget', onReconnect: fetch })
  }, [fetch])

  return { overview, availableYears, loading, loadError, refresh: fetch }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetTransactions  –  ledger lines + CMMS orders (linked orders are shown
// but do not count — their college line does)
// ═══════════════════════════════════════════════════════════════════════════════

export function useBudgetTransactions(schoolYear) {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const sy = schoolYear || getCurrentSchoolYear()

      // Ledger entries
      const entries = mustData(await supabase
        .from('program_budget')
        .select('*')
        .eq('school_year', sy)
        .order('entry_date', { ascending: false }), 'program_budget.select')

      const lineByOrder = {}
      ;(entries || []).forEach(e => {
        if (e.status === 'Voided') return
        ;(e.linked_order_ids || []).forEach(id => { if (!lineByOrder[id]) lineByOrder[id] = e })
      })

      const txns = (entries || []).map(e => {
        const m = lineMoney(e)
        return {
          id: e.id,
          entryId: e.entry_id,
          source: 'manual',
          ledgerSource: e.source || 'manual',
          type: e.type,
          description: e.description,
          reference: e.reference,
          amount: parseFloat(e.amount) || 0,
          date: e.entry_date,
          createdBy: e.created_by,
          category: e.category || 'Other',
          notes: e.notes,
          status: e.status || 'Active',
          isCredit: ['Starting Balance', 'Income/Grant', 'Adjustment'].includes(e.type),
          paymentStatus: e.payment_status || '',
          objectCode: e.object_code || '',
          paidAmount: e.type === 'Manual Expense' ? m.paid : 0,
          openAmount: e.type === 'Manual Expense' ? m.open : 0,
          linkedOrderIds: e.linked_order_ids || [],
          releaseRequestedAt: e.release_requested_at || null,
          releaseAmount: parseFloat(e.release_amount) || 0,
          reportAsOf: e.report_as_of || null,
          countsInBalance: true,
        }
      })

      // CMMS orders (Approved and later) in this school year
      const orders = mustData(await supabase
        .from('orders')
        .select(ORDER_BUDGET_COLUMNS)
        .in('status', COMMITTED_ORDER_STATUSES), 'orders.select')

      ;(orders || []).forEach(o => {
        if (!orderInSchoolYear(o, sy)) return
        const d = orderBudgetDate(o)
        const line = lineByOrder[o.order_id]
        txns.push({
          id: o.order_id,
          entryId: o.order_id,
          source: 'po',
          type: 'Purchase Order',
          description: `PO to ${orderVendor(o)}`,
          reference: o.order_id,
          amount: parseFloat(o.total) || 0,
          date: d ? d.toISOString() : null,
          createdBy: o.ordered_by,
          category: 'Purchase Orders',
          notes: o.notes || '',
          status: o.status,
          isCredit: false,
          paymentStatus: '',
          objectCode: '',
          collegePo: o.college_po || '',
          linkedTo: line ? { id: line.id, reference: line.reference || '', description: line.description } : null,
          countsInBalance: !line,
        })
      })

      // Sort by date desc
      txns.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      setTransactions(txns)
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Budget transactions error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load transactions')
    } finally {
      setLoading(false)
    }
  }, [schoolYear])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when program_budget or orders change
  useEffect(() => {
    return subscribeWithReconnect(`budget-transactions-changes-${Date.now()}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { fetch() })
    , { tag: 'ProgramBudget', onReconnect: fetch })
  }, [fetch])

  return { transactions, loading, refresh: fetch }
}


// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetActions  –  add / edit / void entries, set starting balance
// ═══════════════════════════════════════════════════════════════════════════════

export function useBudgetActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : ''

  const addEntry = async (data) => {
    if (!data.type) return toast.error('Type is required')
    if (!data.description?.trim()) return toast.error('Description is required')
    if (!data.amount || parseFloat(data.amount) <= 0) return toast.error('Amount must be > 0')

    setSaving(true)
    try {
      const row = {
        school_year: data.schoolYear || getCurrentSchoolYear(),
        type: data.type,
        description: data.description.trim(),
        reference: data.reference || '',
        amount: parseFloat(data.amount),
        entry_date: data.date || new Date().toISOString(),
        created_by: userName,
        category: data.category || 'Other',
        notes: data.notes || '',
        status: 'Active',
      }

      // Add optional new fields
      if (data.paymentStatus) row.payment_status = data.paymentStatus
      if (data.objectCode) row.object_code = data.objectCode

      const { error } = assertWrite(
      await supabase.from('program_budget').insert(row).select(),
      'program_budget.insert'
    )
      if (error) throw error
      toast.success('Budget entry added')
      return true
    } catch (err) {
      toast.error('Failed to add entry')
      return false
    } finally {
      setSaving(false)
    }
  }

  const editEntry = async (id, updates) => {
    setSaving(true)
    try {
      const clean = {}
      if (updates.description !== undefined) clean.description = updates.description
      if (updates.reference !== undefined) clean.reference = updates.reference
      if (updates.amount !== undefined) clean.amount = parseFloat(updates.amount)
      if (updates.category !== undefined) clean.category = updates.category
      if (updates.notes !== undefined) clean.notes = updates.notes
      if (updates.type !== undefined) clean.type = updates.type
      if (updates.paymentStatus !== undefined) clean.payment_status = updates.paymentStatus
      if (updates.objectCode !== undefined) clean.object_code = updates.objectCode
      if (updates.paidAmount !== undefined) clean.paid_amount = Math.max(parseFloat(updates.paidAmount) || 0, 0)

      const { error } = assertWrite(
      await supabase.from('program_budget').update(clean).eq('id', id).select(),
      'program_budget.update'
    )
      if (error) throw error
      toast.success('Entry updated')
      return true
    } catch {
      toast.error('Failed to update entry')
      return false
    } finally {
      setSaving(false)
    }
  }

  const voidEntry = async (id) => {
    setSaving(true)
    try {
      const { error } = assertWrite(
      await supabase.from('program_budget')
        .update({ status: 'Voided' })
        .eq('id', id).select(),
      'program_budget.update'
    )
      if (error) throw error
      toast.success('Entry voided')
      return true
    } catch {
      toast.error('Failed to void entry')
      return false
    } finally {
      setSaving(false)
    }
  }

  const deleteEntry = async (id) => {
    setSaving(true)
    try {
      const { error } = assertWrite(
      await supabase.from('program_budget')
        .delete()
        .eq('id', id).select(),
      'program_budget.delete'
    )
      if (error) throw error
      toast.success('Entry permanently deleted')
      return true
    } catch {
      toast.error('Failed to delete entry')
      return false
    } finally {
      setSaving(false)
    }
  }

  const setStartingBalance = async (schoolYear, amount, notes) => {
    if (!amount || parseFloat(amount) <= 0) return toast.error('Amount must be > 0')

    setSaving(true)
    try {
      // Check if one already exists
      const existing = mustData(await supabase
        .from('program_budget')
        .select('id')
        .eq('school_year', schoolYear)
        .eq('type', 'Starting Balance')
        .neq('status', 'Voided')
        .maybeSingle(), 'program_budget.select')

      if (existing) {
        // Update
        const upd = { amount: parseFloat(amount) }
        if (notes !== undefined) upd.notes = notes
        const { error } = assertWrite(
      await supabase.from('program_budget').update(upd).eq('id', existing.id).select(),
      'program_budget.update'
    )
        if (error) throw error
        toast.success(`Starting balance updated for ${schoolYear}`)
      } else {
        // Insert
        const dates = parseSchoolYearDates(schoolYear)
        const { error } = assertWrite(
      await supabase.from('program_budget').insert({
          school_year: schoolYear,
          type: 'Starting Balance',
          description: `Starting Budget for ${schoolYear}`,
          amount: parseFloat(amount),
          entry_date: dates.start.toISOString(),
          created_by: userName,
          category: 'Budget',
          status: 'Active',
          notes: notes || '',
        }).select(),
      'program_budget.insert'
    )
        if (error) throw error
        toast.success(`Starting balance set for ${schoolYear}`)
      }
      return true
    } catch {
      toast.error('Failed to set starting balance')
      return false
    } finally {
      setSaving(false)
    }
  }

  // ─── Bulk Import ────────────────────────────────────────────────────────────
  const bulkImport = async (rows, schoolYear) => {
    if (!rows || rows.length === 0) return toast.error('No rows to import')

    setSaving(true)
    try {
      const inserts = rows.map(r => {
        const row = {
          school_year: schoolYear || getCurrentSchoolYear(),
          type: r.type || 'Manual Expense',
          description: (r.description || '').trim(),
          reference: (r.reference || '').trim(),
          amount: parseNumber(r.amount),
          entry_date: r.date || new Date().toISOString(),
          created_by: userName || 'Import',
          category: r.category || 'Other',
          notes: r.notes || '',
          status: 'Active',
        }
        if (r.paymentStatus) row.payment_status = r.paymentStatus
        if (r.objectCode) row.object_code = r.objectCode
        return row
      })

      // Insert in batches of 50
      let imported = 0
      for (let i = 0; i < inserts.length; i += 50) {
        const batch = inserts.slice(i, i + 50)
        const { error } = assertWrite(
      await supabase.from('program_budget').insert(batch).select(),
      'program_budget.insert'
    )
        if (error) throw error
        imported += batch.length
      }

      toast.success(`Imported ${imported} entries`)
      return true
    } catch (err) {
      console.error('Bulk import error:', err)
      toast.error(`Import failed: ${err.message}`)
      return false
    } finally {
      setSaving(false)
    }
  }


  // ─── College report import (add + update + link) ───────────────────────────
  /**
   * @param {object} args
   * @param {object} args.plan        planImport() result
   * @param {object} args.parsed      parseBudgetRows() result
   * @param {object} args.choices     { additions: Set<idx>, newLines: { [idx]: { include, orderIds } }, changed: Set<idx> }
   * @param {string} args.schoolYear
   * @returns {Promise<{ ok: boolean, added: number, updated: number, linked: number, additions: number }>}
   */
  const applyCollegeImport = async ({ plan, parsed, choices, schoolYear }) => {
    const sy = schoolYear || getCurrentSchoolYear()
    const asOf = parsed?.meta?.balancedAsOf || parsed?.meta?.reportDate || null
    const isCollege = parsed?.format === 'RICT'
    const sourceTag = isCollege ? 'college_report' : 'manual'
    const asOfLabel = asOf ? new Date(`${asOf}T00:00:00`).toLocaleDateString('en-US') : ''
    const note = isCollege
      ? `Imported from spreadsheet (college report${asOfLabel ? ` balanced as of ${asOfLabel}` : ''})`
      : 'Imported from spreadsheet'
    const by = userName || 'Import'
    const result = { ok: false, added: 0, updated: 0, linked: 0, additions: 0 }

    setSaving(true)
    try {
      const inserts = []

      plan.additions.forEach((a, i) => {
        if (a.status !== 'new' || !choices.additions.has(i)) return
        inserts.push({
          school_year: sy,
          type: a.credit === false ? 'Adjustment' : 'Income/Grant',
          description: a.description,
          reference: a.reference || '',
          amount: a.amount,
          entry_date: `${asOf || new Date().toISOString().slice(0, 10)}T12:00:00Z`,
          created_by: by,
          category: 'Budget',
          notes: note,
          status: 'Active',
          source: sourceTag,
          report_as_of: asOf,
        })
        result.additions++
      })

      plan.newLines.forEach((n, i) => {
        const c = choices.newLines[i]
        if (!c?.include) return
        const l = n.line
        const orderIds = [...new Set(c.orderIds || [])]
        inserts.push({
          school_year: sy,
          type: l.isCredit ? 'Adjustment' : 'Manual Expense',
          description: l.description,
          reference: l.reference || '',
          amount: l.amount,
          entry_date: `${l.date || asOf || new Date().toISOString().slice(0, 10)}T12:00:00Z`,
          created_by: by,
          category: l.category || 'Other',
          notes: note,
          status: 'Active',
          payment_status: l.paymentStatus || null,
          paid_amount: l.paymentStatus === 'Encumbered' ? l.paidAmount : l.amount,
          object_code: l.objectCode || null,
          linked_order_ids: orderIds,
          source: sourceTag,
          report_as_of: asOf,
        })
        result.linked += orderIds.length
      })

      for (let i = 0; i < inserts.length; i += 50) {
        const batch = inserts.slice(i, i + 50)
        const { data, error } = assertWrite(
          await supabase.from('program_budget').insert(batch).select('id'),
          'program_budget.insert'
        )
        if (error) throw error
        if ((data || []).length !== batch.length) throw new Error(`Only ${(data || []).length} of ${batch.length} rows were saved`)
        result.added += batch.length
      }
      result.added -= result.additions

      for (let i = 0; i < plan.changedLines.length; i++) {
        if (!choices.changed.has(i)) continue
        const ch = plan.changedLines[i]
        const upd = { source: 'college_report', report_as_of: asOf }
        for (const c of ch.changes) upd[c.field] = c.to
        if (!ch.changes.some(c => c.field === 'paid_amount')) {
          const status = upd.payment_status || ch.existing.payment_status
          const amount = upd.amount ?? (parseFloat(ch.existing.amount) || 0)
          if (status !== 'Encumbered' && status !== 'Partial') upd.paid_amount = amount
        }
        if (ch.clearRelease) {
          upd.release_requested_at = null
          upd.release_requested_by = null
          upd.release_amount = null
          upd.release_note = null
        }
        const { error } = assertWrite(
          await supabase.from('program_budget').update(upd).eq('id', ch.existing.id).select('id'),
          'program_budget.update'
        )
        if (error) throw error
        result.updated++
      }

      result.ok = true
      const parts = []
      if (result.added) parts.push(`${result.added} new line${result.added === 1 ? '' : 's'}`)
      if (result.updated) parts.push(`${result.updated} updated`)
      if (result.additions) parts.push(`${result.additions} budget addition${result.additions === 1 ? '' : 's'}`)
      toast.success(parts.length ? `Imported: ${parts.join(', ')}` : 'Nothing to import')
      return result
    } catch (err) {
      console.error('College import error:', err)
      const done = result.added + result.additions
      toast.error(`Import stopped: ${err.message}${done || result.updated ? ` (${done} added, ${result.updated} updated before the error — re-import the same file to finish)` : ''}`)
      return result
    } finally {
      setSaving(false)
    }
  }

  // ─── Link / unlink CMMS orders to a college line ───────────────────────────
  const setLinkedOrders = async (entryId, mutate, successMsg) => {
    setSaving(true)
    try {
      const row = mustData(await supabase
        .from('program_budget')
        .select('id, linked_order_ids')
        .eq('id', entryId)
        .single(), 'program_budget.select')
      const next = [...new Set(mutate(row.linked_order_ids || []))]
      const { error } = assertWrite(
        await supabase.from('program_budget').update({ linked_order_ids: next }).eq('id', entryId).select('id'),
        'program_budget.update'
      )
      if (error) throw error
      toast.success(successMsg)
      return true
    } catch (err) {
      toast.error(`Could not update the link: ${err.message}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  const linkOrders = (entryId, orderIds) =>
    setLinkedOrders(entryId, ids => [...ids, ...orderIds], `Linked ${orderIds.join(', ')}`)

  const unlinkOrder = (entryId, orderId) =>
    setLinkedOrders(entryId, ids => ids.filter(id => id !== orderId), `Unlinked ${orderId}`)

  // ─── Release requests on open encumbrances ─────────────────────────────────
  const requestRelease = async (entryId, { amount, note }) => {
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) { toast.error('Enter an amount greater than $0'); return false }
    setSaving(true)
    try {
      const { error } = assertWrite(
        await supabase.from('program_budget').update({
          release_requested_at: localToUtcIso(new Date()),
          release_requested_by: userName,
          release_amount: Math.round(amt * 100) / 100,
          release_note: (note || '').trim() || null,
        }).eq('id', entryId).select('id'),
        'program_budget.update'
      )
      if (error) throw error
      toast.success('Release request recorded')
      return true
    } catch (err) {
      toast.error(`Could not record the release request: ${err.message}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  const cancelRelease = async (entryId) => {
    setSaving(true)
    try {
      const { error } = assertWrite(
        await supabase.from('program_budget').update({
          release_requested_at: null, release_requested_by: null, release_amount: null, release_note: null,
        }).eq('id', entryId).select('id'),
        'program_budget.update'
      )
      if (error) throw error
      toast.success('Release request cancelled')
      return true
    } catch (err) {
      toast.error(`Could not cancel the release request: ${err.message}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  return {
    addEntry, editEntry, voidEntry, deleteEntry, setStartingBalance, bulkImport,
    applyCollegeImport, linkOrders, unlinkOrder, requestRelease, cancelRelease,
    saving,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetYearSummary  –  year-over-year comparison (same math as Overview)
// ═══════════════════════════════════════════════════════════════════════════════

export function useBudgetYearSummary() {
  const [summaries, setSummaries] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const entries = mustData(await supabase
        .from('program_budget')
        .select('*')
        .neq('status', 'Voided'), 'program_budget.select')

      const orders = mustData(await supabase
        .from('orders')
        .select(ORDER_BUDGET_COLUMNS)
        .in('status', BUDGET_ORDER_STATUSES), 'orders.select')

      const years = new Set()
      ;(entries || []).forEach(e => { if (e.school_year?.includes('-')) years.add(e.school_year) })
      ;(orders || []).forEach(o => {
        const d = orderBudgetDate(o)
        if (d && COMMITTED_ORDER_STATUSES.includes(o.status)) years.add(getSchoolYearForDate(d))
      })

      const currentYear = getCurrentSchoolYear()
      const results = [...years].map(sy => {
        const b = computeBudget({ entries: (entries || []).filter(e => e.school_year === sy), orders: orders || [], schoolYear: sy })
        return {
          schoolYear: sy,
          isCurrent: sy === currentYear,
          startingBalance: b.startingBalance,
          income: b.income,
          adjustments: b.adjustments,
          totalBudget: b.totalBudget,
          manualExpenses: b.manualExpenses,
          poExpenses: b.committedOrders,
          poCount: b.committedOrderCount,
          totalSpent: b.totalSpent,
          remaining: b.availableAfterEnc,
          encumberedOpen: b.encumberedOpen,
          percentUsed: b.percentUsed,
        }
      })

      results.sort((a, b) => b.schoolYear.localeCompare(a.schoolYear))
      setSummaries(results)
    } catch (err) {
      console.error('Year summary error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when program_budget or orders change
  useEffect(() => {
    return subscribeWithReconnect(`budget-year-summary-changes-${Date.now()}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { fetch() })
    , { tag: 'ProgramBudget', onReconnect: fetch })
  }, [fetch])

  return { summaries, loading, refresh: fetch }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useSpreadsheetImport  –  read the file, plan adds/updates/links (preview only;
// nothing is written until applyCollegeImport runs)
// ═══════════════════════════════════════════════════════════════════════════════

export function useSpreadsheetImport(schoolYear) {
  const [parsed, setParsed] = useState(null)     // { parsed, plan, ... }
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState(null)

  const parseFile = useCallback(async (file) => {
    setParsing(true)
    setError(null)
    setParsed(null)

    try {
      const ext = file.name.split('.').pop().toLowerCase()
      let rawData

      if (ext === 'csv') {
        const text = await file.text()
        rawData = parseCSVText(text)
      } else if (['xls', 'xlsx'].includes(ext)) {
        // Dynamic import for SheetJS
        const XLSX = await import('xlsx')
        const buffer = await file.arrayBuffer()
        // raw: true → returns raw numbers (not formatted strings like "1,599.00")
        // cellDates: true → converts Excel date serials to JS Date objects
        const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })
      } else {
        throw new Error('Unsupported file type. Please use .csv, .xls, or .xlsx')
      }

      const result = parseBudgetRows(rawData)
      if (result.format === 'Unknown') {
        throw new Error('No column headings were found. The sheet needs a heading row with Date, Company (or Vendor/Description) and Dollar Value (or Amount).')
      }
      if (result.lines.length === 0 && result.additions.length === 0) {
        throw new Error(`No budget rows were read. The heading row was found on row ${result.headerRow}, but no row below it had a company and an amount. Check that the amounts are in the "Dollar Value" column.`)
      }

      const sy = schoolYear || getCurrentSchoolYear()
      const [existing, orders] = await Promise.all([
        supabase.from('program_budget').select('*').eq('school_year', sy),
        supabase.from('orders').select(ORDER_BUDGET_COLUMNS).in('status', COMMITTED_ORDER_STATUSES),
      ])
      const existingRows = mustData(existing, 'program_budget.select') || []
      const plan = planImport({
        parsed: result,
        existing: existingRows,
        orders: mustData(orders, 'orders.select') || [],
        schoolYear: sy,
      })

      const fySchoolYear = fiscalYearToSchoolYear(result.meta.fiscalYear)
      const starting = existingRows
        .filter(e => e.type === 'Starting Balance' && e.status !== 'Voided')
        .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)

      setParsed({
        parsed: result,
        plan,
        meta: result.meta,
        format: result.format,
        warnings: result.warnings,
        totalFromFile: result.lines.length,
        yearMismatch: fySchoolYear && fySchoolYear !== sy ? fySchoolYear : null,
        startingBalance: starting,
      })
    } catch (err) {
      console.error('Parse error:', err)
      setError(err.message || 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }, [schoolYear])

  const reset = () => {
    setParsed(null)
    setError(null)
  }

  return { parsed, parsing, error, parseFile, reset }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SPREADSHEET PARSING HELPERS (row parsing and matching live in src/lib/budgetImport.js)
// ═══════════════════════════════════════════════════════════════════════════════

/** Parse CSV text into array of arrays */
function parseCSVText(text) {
  const lines = text.split('\n')
  return lines.map(line => {
    const cells = []
    let inQuote = false
    let cell = ''
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === ',' && !inQuote) { cells.push(cell.trim()); cell = ''; continue }
      cell += ch
    }
    cells.push(cell.trim())
    return cells
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function getAvailableYears() {
  const years = new Set()
  const current = getCurrentSchoolYear()
  years.add(current)

  // From budget entries
  const { data: entries } = await supabase
    .from('program_budget')
    .select('school_year')
  ;(entries || []).forEach(e => { if (e.school_year?.includes('-')) years.add(e.school_year) })

  // From orders
  const { data: orders } = await supabase
    .from('orders')
    .select('order_date')
  ;(orders || []).forEach(o => {
    if (o.order_date) {
      const d = new Date(o.order_date)
      if (!isNaN(d.getTime())) years.add(getSchoolYearForDate(d))
    }
  })

  return [...years].sort().reverse()
}
