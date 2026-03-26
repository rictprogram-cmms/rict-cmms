import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

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

export const PAYMENT_STATUSES = ['Paid', 'Encumbered', 'Partial', 'Pending']

export function getPaymentStatusColor(status) {
  switch (status) {
    case 'Paid': return 'bg-emerald-50 text-emerald-700'
    case 'Encumbered': return 'bg-amber-50 text-amber-700'
    case 'Partial': return 'bg-blue-50 text-blue-700'
    case 'Pending': return 'bg-surface-100 text-surface-600'
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

/**
 * Safely parse a date from a cell value that may be:
 *  - a JS Date object (from cellDates: true)
 *  - a formatted date string ("10/31/2025", "2025-10-31")
 *  - an Excel serial number
 *  - null/undefined/empty
 * Returns ISO date string "YYYY-MM-DD" or null
 */
function parseDate(val) {
  if (!val) return null

  // Already a Date object
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null
    return val.toISOString().split('T')[0]
  }

  // Raw Excel serial number (numeric type, not string)
  if (typeof val === 'number' && val > 30000 && val < 70000) {
    const excelEpoch = new Date(1899, 11, 30) // Excel epoch
    const msPerDay = 86400000
    const jsDate = new Date(excelEpoch.getTime() + val * msPerDay)
    if (!isNaN(jsDate.getTime())) {
      return jsDate.toISOString().split('T')[0]
    }
  }

  const str = String(val).trim()
  if (!str) return null

  // Try direct parse
  const d = new Date(str)
  if (!isNaN(d.getTime())) {
    // Guard against year-only or garbage dates
    if (d.getFullYear() >= 2000 && d.getFullYear() <= 2100) {
      return d.toISOString().split('T')[0]
    }
  }

  // Try Excel serial number (string representation e.g. "45930")
  const serial = parseFloat(str)
  if (!isNaN(serial) && serial > 30000 && serial < 70000) {
    const excelEpoch = new Date(1899, 11, 30)
    const msPerDay = 86400000
    const jsDate = new Date(excelEpoch.getTime() + serial * msPerDay)
    if (!isNaN(jsDate.getTime())) {
      return jsDate.toISOString().split('T')[0]
    }
  }

  return null
}

// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetOverview  –  hero card, category totals, monthly trend
// ═══════════════════════════════════════════════════════════════════════════════

export function useBudgetOverview(schoolYear) {
  const [overview, setOverview] = useState(null)
  const [availableYears, setAvailableYears] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const sy = schoolYear || getCurrentSchoolYear()

      // 1) Manual budget entries for this school year
      const { data: entries, error: eErr } = await supabase
        .from('program_budget')
        .select('*')
        .eq('school_year', sy)
        .neq('status', 'Voided')

      if (eErr) throw eErr

      let startingBalance = 0, manualExpenses = 0, adjustments = 0, income = 0
      let paidTotal = 0, encumberedTotal = 0, partialTotal = 0
      const categoryTotals = {}
      const monthlyManual = {}

      ;(entries || []).forEach(e => {
        const amt = parseFloat(e.amount) || 0
        const cat = e.category || 'Other'
        const mk = e.entry_date ? monthKey(e.entry_date) : ''

        switch (e.type) {
          case 'Starting Balance': startingBalance += amt; break
          case 'Manual Expense':
            manualExpenses += amt
            categoryTotals[cat] = (categoryTotals[cat] || 0) + amt
            if (mk) monthlyManual[mk] = (monthlyManual[mk] || 0) + amt
            // Track payment status totals
            switch (e.payment_status) {
              case 'Paid': paidTotal += amt; break
              case 'Encumbered': encumberedTotal += amt; break
              case 'Partial': partialTotal += amt; break
              default: paidTotal += amt; break  // Default to paid if no status
            }
            break
          case 'Adjustment': adjustments += amt; break
          case 'Income/Grant': income += amt; break
        }
      })

      // 2) Purchase Orders (Ordered / Partial / Received) within school year
      const dates = parseSchoolYearDates(sy)
      const { data: orders, error: oErr } = await supabase
        .from('orders')
        .select('order_id, vendor_name, other_vendor, order_date, ordered_date, ordered_by, status, total, notes')
        .in('status', ['Ordered', 'Partial', 'Received'])

      if (oErr) throw oErr

      let poExpenses = 0, poCount = 0
      const poOrders = []

      ;(orders || []).forEach(o => {
        const d = new Date(o.ordered_date || o.order_date)
        if (isNaN(d.getTime()) || d < dates.start || d > dates.end) return
        const total = parseFloat(o.total) || 0
        poExpenses += total
        poCount++
        categoryTotals['Purchase Orders'] = (categoryTotals['Purchase Orders'] || 0) + total
        const mk2 = monthKey(d)
        monthlyManual[mk2] = (monthlyManual[mk2] || 0) + total // reuse bucket
        poOrders.push({
          orderId: o.order_id,
          vendor: o.vendor_name || o.other_vendor || 'Unknown',
          date: d.toISOString(),
          orderedBy: o.ordered_by,
          status: o.status,
          total,
          notes: o.notes,
        })
      })

      // 3) Monthly trend (ordered Jul→Jun)
      const monthlyTrend = buildMonthlyTrend(dates, monthlyManual)

      const totalBudget = startingBalance + income + adjustments
      const totalSpent = manualExpenses + poExpenses
      const remaining = totalBudget - totalSpent
      const percentUsed = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0

      // 4) Available years
      const years = await getAvailableYears()

      setOverview({
        schoolYear: sy,
        startingBalance, income, adjustments, totalBudget,
        manualExpenses, poExpenses, totalSpent, remaining, percentUsed,
        poCount, entryCount: (entries || []).length,
        categoryTotals, monthlyTrend, poOrders,
        paidTotal, encumberedTotal, partialTotal,
      })
      setAvailableYears(years)
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Budget overview error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load budget overview')
    } finally {
      setLoading(false)
    }
  }, [schoolYear])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when program_budget or orders change
  useEffect(() => {
    const channel = supabase
      .channel('budget-overview-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { overview, availableYears, loading, refresh: fetch }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetTransactions  –  combined manual + PO entries
// ═══════════════════════════════════════════════════════════════════════════════

export function useBudgetTransactions(schoolYear) {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const sy = schoolYear || getCurrentSchoolYear()
      const dates = parseSchoolYearDates(sy)

      // Manual entries
      const { data: entries } = await supabase
        .from('program_budget')
        .select('*')
        .eq('school_year', sy)
        .order('entry_date', { ascending: false })

      const txns = (entries || []).map(e => ({
        id: e.id,
        entryId: e.entry_id,
        source: 'manual',
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
      }))

      // POs
      const { data: orders } = await supabase
        .from('orders')
        .select('order_id, vendor_name, other_vendor, order_date, ordered_date, ordered_by, status, total, notes')
        .in('status', ['Ordered', 'Partial', 'Received'])

      ;(orders || []).forEach(o => {
        const d = new Date(o.ordered_date || o.order_date)
        if (isNaN(d.getTime()) || d < dates.start || d > dates.end) return
        txns.push({
          id: o.order_id,
          entryId: o.order_id,
          source: 'po',
          type: 'Purchase Order',
          description: `PO to ${o.vendor_name || o.other_vendor || 'Unknown'}`,
          reference: o.order_id,
          amount: parseFloat(o.total) || 0,
          date: d.toISOString(),
          createdBy: o.ordered_by,
          category: 'Purchase Orders',
          notes: o.notes || '',
          status: o.status,
          isCredit: false,
          paymentStatus: o.status === 'Received' ? 'Paid' : 'Encumbered',
          objectCode: '',
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
    const channel = supabase
      .channel('budget-transactions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
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

      const { error } = await supabase.from('program_budget').insert(row)
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

      const { error } = await supabase.from('program_budget').update(clean).eq('id', id)
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
      const { error } = await supabase.from('program_budget')
        .update({ status: 'Voided' })
        .eq('id', id)
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
      const { error } = await supabase.from('program_budget')
        .delete()
        .eq('id', id)
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
      const { data: existing } = await supabase
        .from('program_budget')
        .select('id')
        .eq('school_year', schoolYear)
        .eq('type', 'Starting Balance')
        .neq('status', 'Voided')
        .maybeSingle()

      if (existing) {
        // Update
        const upd = { amount: parseFloat(amount) }
        if (notes !== undefined) upd.notes = notes
        const { error } = await supabase.from('program_budget').update(upd).eq('id', existing.id)
        if (error) throw error
        toast.success(`Starting balance updated for ${schoolYear}`)
      } else {
        // Insert
        const dates = parseSchoolYearDates(schoolYear)
        const { error } = await supabase.from('program_budget').insert({
          school_year: schoolYear,
          type: 'Starting Balance',
          description: `Starting Budget for ${schoolYear}`,
          amount: parseFloat(amount),
          entry_date: dates.start.toISOString(),
          created_by: userName,
          category: 'Budget',
          status: 'Active',
          notes: notes || '',
        })
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
        const { error } = await supabase.from('program_budget').insert(batch)
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

  return { addEntry, editEntry, voidEntry, deleteEntry, setStartingBalance, bulkImport, saving }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useBudgetYearSummary  –  year-over-year comparison
// ═══════════════════════════════════════════════════════════════════════════════

export function useBudgetYearSummary() {
  const [summaries, setSummaries] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      // Get all budget entries
      const { data: entries } = await supabase
        .from('program_budget')
        .select('*')
        .neq('status', 'Voided')

      // Group by school year
      const yearMap = {}
      ;(entries || []).forEach(e => {
        const sy = e.school_year
        if (!sy) return
        if (!yearMap[sy]) yearMap[sy] = { entries: [], poExpenses: 0, poCount: 0 }
        yearMap[sy].entries.push(e)
      })

      // Get POs for each year
      const { data: orders } = await supabase
        .from('orders')
        .select('order_id, order_date, ordered_date, status, total')
        .in('status', ['Ordered', 'Partial', 'Received'])

      ;(orders || []).forEach(o => {
        const d = new Date(o.ordered_date || o.order_date)
        if (isNaN(d.getTime())) return
        const sy = getSchoolYearForDate(d)
        if (!yearMap[sy]) yearMap[sy] = { entries: [], poExpenses: 0, poCount: 0 }
        yearMap[sy].poExpenses += parseFloat(o.total) || 0
        yearMap[sy].poCount++
      })

      const currentYear = getCurrentSchoolYear()
      const results = Object.entries(yearMap).map(([sy, data]) => {
        let startingBalance = 0, manualExpenses = 0, income = 0, adjustments = 0
        data.entries.forEach(e => {
          const amt = parseFloat(e.amount) || 0
          switch (e.type) {
            case 'Starting Balance': startingBalance += amt; break
            case 'Manual Expense': manualExpenses += amt; break
            case 'Income/Grant': income += amt; break
            case 'Adjustment': adjustments += amt; break
          }
        })
        const totalBudget = startingBalance + income + adjustments
        const totalSpent = manualExpenses + data.poExpenses
        return {
          schoolYear: sy,
          isCurrent: sy === currentYear,
          startingBalance,
          income,
          adjustments,
          totalBudget,
          manualExpenses,
          poExpenses: data.poExpenses,
          poCount: data.poCount,
          totalSpent,
          remaining: totalBudget - totalSpent,
          percentUsed: totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0,
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
    const channel = supabase
      .channel('budget-year-summary-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { summaries, loading, refresh: fetch }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useSpreadsheetImport  –  parse Excel/CSV, detect duplicates, preview
// ═══════════════════════════════════════════════════════════════════════════════

export function useSpreadsheetImport(schoolYear) {
  const [parsed, setParsed] = useState(null)     // { entries, meta, duplicates, newEntries }
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
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')
        const buffer = await file.arrayBuffer()
        // raw: true → returns raw numbers (not formatted strings like "1,599.00")
        // cellDates: true → converts Excel date serials to JS Date objects
        const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })
      } else {
        throw new Error('Unsupported file type. Please use .csv, .xls, or .xlsx')
      }

      // Detect the RICT budget format
      const result = detectAndParseRICTFormat(rawData)

      // Now check for duplicates against existing DB entries AND purchase orders
      const sy = schoolYear || getCurrentSchoolYear()
      const dates = parseSchoolYearDates(sy)

      const { data: existing } = await supabase
        .from('program_budget')
        .select('description, amount, entry_date, reference, status')
        .eq('school_year', sy)
        .neq('status', 'Voided')

      // Also fetch PO orders within this school year to catch PO-sourced duplicates
      const { data: orders } = await supabase
        .from('orders')
        .select('order_id, vendor_name, other_vendor, order_date, ordered_date, status, total, notes')
        .in('status', ['Ordered', 'Partial', 'Received'])

      // Filter orders to current school year
      const yearOrders = (orders || []).filter(o => {
        const d = new Date(o.ordered_date || o.order_date)
        return !isNaN(d.getTime()) && d >= dates.start && d <= dates.end
      })

      const { exactDuplicates, potentialMatches, newEntries } = detectDuplicates(result.entries, existing || [], yearOrders)

      setParsed({
        ...result,
        exactDuplicates,
        potentialMatches,
        newEntries,
        totalFromFile: result.entries.length,
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
// SPREADSHEET PARSING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Detect and parse the RICT budget spreadsheet format */
function detectAndParseRICTFormat(rows) {
  const meta = {
    program: '',
    fiscalYear: '',
    account: '',
    beginningBalance: 0,
    marketing: 0,
    currentBalance: 0,
    presentBalance: 0,
  }

  // Try to detect RICT format from header rows
  let headerRowIdx = -1
  let isRICTFormat = false

  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i]
    if (!row) continue
    const joined = row.filter(Boolean).map(c => String(c).toLowerCase()).join(' ')

    // Look for program name
    if (joined.includes('robotics') || joined.includes('fy20')) {
      const rowStr = row.filter(Boolean).map(String)
      meta.program = rowStr.find(s => /^[A-Z]+$/.test(s.trim())) || ''
      meta.fiscalYear = rowStr.find(s => /FY\d{4}/i.test(s)) || ''
      isRICTFormat = true
    }

    // Look for account number
    if (joined.includes('010603') || joined.match(/\d{6}/)) {
      const found = row.filter(Boolean).map(String).find(s => /^\d{6}$/.test(s.trim()))
      if (found) meta.account = found
    }

    // Balance lines - use parseNumber for safety
    if (joined.includes('beginning balance')) {
      const num = row.find(c => typeof c === 'number' || (c && !isNaN(parseFloat(String(c).replace(/[$,]/g, '')))))
      if (num) meta.beginningBalance = parseNumber(num)
    }
    if (joined.includes('marketing')) {
      const num = row.find(c => typeof c === 'number' || (c && !isNaN(parseFloat(String(c).replace(/[$,]/g, '')))))
      if (num) meta.marketing = parseNumber(num)
    }
    if (joined.includes('current balance')) {
      const num = row.find(c => typeof c === 'number' || (c && !isNaN(parseFloat(String(c).replace(/[$,]/g, '')))))
      if (num) meta.currentBalance = parseNumber(num)
    }
    if (joined.includes('present balance')) {
      const num = row.find(c => typeof c === 'number' || (c && !isNaN(parseFloat(String(c).replace(/[$,]/g, '')))))
      if (num) meta.presentBalance = parseNumber(num)
    }

    // Find header row: "Date ... Company ... Dollar Value"
    if (joined.includes('date') && (joined.includes('company') || joined.includes('dollar'))) {
      headerRowIdx = i
    }
  }

  const entries = []

  if (isRICTFormat && headerRowIdx >= 0) {
    // Parse RICT format: columns are Date, _, PO No, _, Company, E/P, Code, _, Dollar Value, Partial Paid
    let lastDate = null
    let hitTotals = false

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue

      const company = row[4] ? String(row[4]).trim() : ''

      // Stop parsing when we hit the TOTALS row — everything below is
      // summary/backorder data, not regular budget entries
      if (company === 'TOTALS') {
        hitTotals = true
        continue
      }

      // Skip everything after TOTALS (backorders, summaries, etc.)
      if (hitTotals) continue

      // Skip empty company rows
      if (!company) continue

      const dateVal = row[0]
      const poNo = row[2] ? String(row[2]).trim() : ''
      const ep = row[5] ? String(row[5]).trim() : ''
      const rawCode = row[6]
      // Object code: could be number 3000 or string "3000" — normalize to string without decimals
      const code = rawCode != null ? String(rawCode).trim().replace(/\.0+$/, '') : ''
      const dollarVal = row[8]
      const partialPaid = row[9]

      // Parse date using robust helper
      let entryDate = parseDate(dateVal)
      if (entryDate) {
        lastDate = entryDate
      } else {
        entryDate = lastDate
      }

      // Parse amounts using robust helper (handles commas, $, etc.)
      const amount = parseNumber(dollarVal)
      const partial = parseNumber(partialPaid) || null

      // Skip rows with zero amount and no meaningful data
      if (amount === 0 && !partial) continue

      // Map E/P to payment status
      let paymentStatus = ''
      const epLower = ep.toLowerCase()
      if (epLower === 'p' || epLower === 'paid') paymentStatus = 'Paid'
      else if (epLower === 'e' || epLower === 'encumbered') paymentStatus = 'Encumbered'
      else if (epLower === 'done' || epLower === 'complete') paymentStatus = 'Paid'
      else if (partial) paymentStatus = 'Partial'

      // Build notes
      const notesParts = []
      if (code) notesParts.push(`Object Code: ${code}`)
      if (partial) notesParts.push(`Partial Paid: $${partial.toFixed(2)}`)
      notesParts.push('Imported from spreadsheet')

      entries.push({
        date: entryDate ? `${entryDate}T12:00:00Z` : new Date().toISOString(),
        description: company,
        reference: poNo,
        amount,
        type: amount < 0 ? 'Adjustment' : 'Manual Expense',
        category: objectCodeToCategory(code),
        objectCode: code,
        paymentStatus,
        notes: notesParts.join(' | '),
        _raw: { ep, code, partialPaid: partial },
      })
    }
  } else {
    // Try generic CSV/spreadsheet format
    // Look for columns by name
    const header = rows[0] || []
    const colMap = {}
    header.forEach((h, i) => {
      if (!h) return
      const hl = String(h).toLowerCase().trim()
      if (hl.includes('date')) colMap.date = i
      if (hl.includes('description') || hl.includes('company') || hl.includes('vendor')) colMap.description = i
      if (hl.includes('amount') || hl.includes('dollar') || hl.includes('value')) colMap.amount = i
      if (hl.includes('reference') || hl.includes('po') || hl.includes('ref')) colMap.reference = i
      if (hl.includes('category') || hl.includes('cat')) colMap.category = i
      if (hl.includes('type')) colMap.type = i
      if (hl.includes('code') || hl.includes('object')) colMap.objectCode = i
      if (hl.includes('payment') || hl.includes('status') || hl.includes('e/p')) colMap.paymentStatus = i
      if (hl.includes('note')) colMap.notes = i
    })

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue

      const desc = colMap.description !== undefined ? String(row[colMap.description] || '').trim() : ''
      if (!desc) continue

      const amount = colMap.amount !== undefined ? parseNumber(row[colMap.amount]) : 0
      let dateStr = colMap.date !== undefined ? parseDate(row[colMap.date]) : null

      entries.push({
        date: dateStr ? `${dateStr}T12:00:00Z` : new Date().toISOString(),
        description: desc,
        reference: colMap.reference !== undefined ? String(row[colMap.reference] || '').trim() : '',
        amount,
        type: amount < 0 ? 'Adjustment' : 'Manual Expense',
        category: colMap.category !== undefined ? String(row[colMap.category] || '').trim() : 'Other',
        objectCode: colMap.objectCode !== undefined ? String(row[colMap.objectCode] || '').trim() : '',
        paymentStatus: colMap.paymentStatus !== undefined ? String(row[colMap.paymentStatus] || '').trim() : '',
        notes: colMap.notes !== undefined ? String(row[colMap.notes] || '').trim() : 'Imported from spreadsheet',
      })
    }
  }

  return { entries, meta, format: isRICTFormat ? 'RICT' : 'Generic' }
}

/**
 * Three-tier duplicate detection:
 *  1. exactDuplicates  – high-confidence match, auto-skipped
 *  2. potentialMatches – similar entries that need user review (side-by-side)
 *  3. newEntries       – no match found, safe to import
 *
 * Matching is done against both program_budget rows AND PO orders.
 */
function detectDuplicates(parsed, existingBudget, existingOrders) {
  const normalize = s => (s || '').toLowerCase().trim().replace(/[-\s]/g, '')
  const exactDuplicates = []
  const potentialMatches = []
  const newEntries = []

  // Build a unified pool of existing records for comparison
  const existingPool = []

  // From program_budget
  ;(existingBudget || []).forEach(ex => {
    existingPool.push({
      source: 'budget',
      description: ex.description || '',
      amount: parseFloat(ex.amount) || 0,
      date: ex.entry_date || '',
      reference: ex.reference || '',
      type: ex.type || 'Manual Expense',
    })
  })

  // From orders (POs)
  ;(existingOrders || []).forEach(po => {
    const vendor = po.vendor_name || po.other_vendor || ''
    existingPool.push({
      source: 'po',
      description: vendor,
      amount: parseFloat(po.total) || 0,
      date: po.ordered_date || po.order_date || '',
      reference: po.order_id || '',
      type: 'Purchase Order',
      poVendor: vendor,
    })
  })

  for (const entry of parsed) {
    const entryDesc = normalize(entry.description)
    const entryAmt = entry.amount || 0
    const entryRef = normalize(entry.reference)
    const entryDate = entry.date ? new Date(entry.date) : null

    let bestMatch = null
    let matchType = null // 'exact' | 'potential'

    for (const ex of existingPool) {
      const exDesc = normalize(ex.description)
      const exAmt = ex.amount
      const exRef = normalize(ex.reference)
      const exDate = ex.date ? new Date(ex.date) : null

      const amtExact = Math.abs(entryAmt - exAmt) < 0.01
      const descExact = entryDesc && exDesc && entryDesc === exDesc
      const descContains = entryDesc && exDesc && (entryDesc.includes(exDesc) || exDesc.includes(entryDesc))
      const refExact = entryRef && exRef && entryRef === exRef

      // Also match "PO to <vendor>" patterns from the orders table
      const exPoDesc = normalize(ex.poVendor || '')
      const descMatchesPO = exPoDesc && entryDesc && (
        entryDesc.includes(exPoDesc) || exPoDesc.includes(entryDesc)
      )

      // ── EXACT MATCH ─────────────────────────────────────────────
      // Same amount + exact description or reference match
      if (amtExact && (descExact || refExact)) {
        bestMatch = ex
        matchType = 'exact'
        break // No need to check further
      }

      // Same amount + description contains the other (e.g. "Postal Charges" vs "Postal Charge")
      if (amtExact && (descContains || descMatchesPO)) {
        bestMatch = ex
        matchType = 'exact'
        break
      }

      // ── POTENTIAL MATCH ─────────────────────────────────────────
      // Same amount + similar vendor name (first 4+ chars match)
      if (amtExact && entryDesc && exDesc) {
        const shortEntry = entryDesc.slice(0, 4)
        const shortEx = exDesc.slice(0, 4)
        const shortPO = exPoDesc ? exPoDesc.slice(0, 4) : ''
        if (shortEntry === shortEx || (shortPO && shortEntry === shortPO)) {
          if (!bestMatch || matchType !== 'exact') {
            bestMatch = ex
            matchType = 'potential'
          }
          continue
        }
      }

      // Same amount + dates within 7 days
      if (amtExact && entryDate && exDate && !isNaN(entryDate) && !isNaN(exDate)) {
        const daysDiff = Math.abs(entryDate - exDate) / (1000 * 60 * 60 * 24)
        if (daysDiff <= 7) {
          if (!bestMatch || matchType !== 'exact') {
            bestMatch = ex
            matchType = 'potential'
          }
          continue
        }
      }

      // Similar vendor + close amount (within 10%)
      if (descContains || descMatchesPO) {
        const amtRatio = entryAmt > 0 && exAmt > 0
          ? Math.min(entryAmt, exAmt) / Math.max(entryAmt, exAmt)
          : 0
        if (amtRatio > 0.90) {
          if (!bestMatch || matchType !== 'exact') {
            bestMatch = ex
            matchType = 'potential'
          }
          continue
        }
      }
    }

    if (matchType === 'exact') {
      exactDuplicates.push({ entry, match: bestMatch })
    } else if (matchType === 'potential') {
      potentialMatches.push({ entry, match: bestMatch })
    } else if (entryAmt > 0) {
      newEntries.push(entry)
    }
  }

  return { exactDuplicates, potentialMatches, newEntries }
}

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

function monthKey(date) {
  const d = new Date(date)
  return `${d.getMonth() + 1}/${d.getFullYear()}`
}

function buildMonthlyTrend(dates, monthlyData) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const trend = []
  const now = new Date()
  const d = new Date(dates.start)
  while (d <= dates.end && d <= now) {
    const mk = `${d.getMonth() + 1}/${d.getFullYear()}`
    trend.push({
      label: `${months[d.getMonth()]} ${d.getFullYear()}`,
      shortLabel: months[d.getMonth()],
      amount: monthlyData[mk] || 0,
    })
    d.setMonth(d.getMonth() + 1)
  }
  return trend
}

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
