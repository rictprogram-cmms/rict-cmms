import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════════════════
// usePOBudgetSummary
// ─────────────────────────────────────────────────────────────────────────────
// Lean budget summary hook for the Purchase Orders dashboard "Budget Remaining"
// tile. Returns just the at-a-glance numbers for a given academic year.
//
// Mirrors the calculation used by useBudgetOverview in useProgramBudget.js so
// the numbers shown on the PO dashboard always match the Program Budget page:
//
//   totalBudget   = startingBalance + income + adjustments
//   totalSpent    = manualExpenses + poExpenses
//   remaining     = totalBudget - totalSpent
//   percentUsed   = round((totalSpent / totalBudget) * 100)
//
// PO contribution: orders with status Ordered, Partial, or Received whose
// ordered_date (or order_date if not yet ordered) falls inside the AY date range.
// Manual budget entries: program_budget rows for the matching school_year string,
// excluding rows with status = 'Voided'.
//
// Why not reuse useBudgetOverview?
//   This hook deliberately skips category breakdowns, monthly trends, payment
//   status totals, and PO order detail arrays — none of which the at-a-glance
//   tile needs. The full hook still exists for the Program Budget page.
//
// @param {number|null} ayStartYear - Academic year start year (e.g. 2025 for
//   AY 2025-26). Pass null when the caller lacks the spend permission to
//   short-circuit fetching entirely.
// @returns { summary, loading, refresh }
//   summary is null while loading or when ayStartYear is null. Otherwise:
//   { startingBalance, income, adjustments, manualExpenses, poExpenses,
//     totalBudget, totalSpent, remaining, percentUsed, schoolYear }
// ═══════════════════════════════════════════════════════════════════════════════
export function usePOBudgetSummary(ayStartYear) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    // Caller opted out (e.g. permission missing) — don't query.
    if (ayStartYear == null) {
      setSummary(null)
      setLoading(false)
      hasLoadedRef.current = false
      return
    }

    if (!hasLoadedRef.current) setLoading(true)
    try {
      // The program_budget table stores school_year as full "YYYY-YYYY"
      // (e.g. "2025-2026"). The PO page uses just the start year internally;
      // convert here so we never alter the budget schema.
      const schoolYear = `${ayStartYear}-${ayStartYear + 1}`

      // Academic year date range: Jul 1 ayStartYear → Jul 1 (ayStartYear + 1)
      // Half-open interval (>= start, < end) matches the convention used by
      // isInAcademicYear() on the PO page itself.
      const ayStart = new Date(ayStartYear, 6, 1, 0, 0, 0)
      const ayEnd = new Date(ayStartYear + 1, 6, 1, 0, 0, 0)

      const [budgetRes, ordersRes] = await Promise.all([
        supabase
          .from('program_budget')
          .select('type, amount')
          .eq('school_year', schoolYear)
          .neq('status', 'Voided'),
        supabase
          .from('orders')
          .select('ordered_date, order_date, total, status')
          .in('status', ['Ordered', 'Partial', 'Received']),
      ])

      if (budgetRes.error) throw budgetRes.error
      if (ordersRes.error) throw ordersRes.error

      const entries = budgetRes.data || []
      const orders = ordersRes.data || []

      // Categorize manual budget entries
      let startingBalance = 0
      let manualExpenses = 0
      let income = 0
      let adjustments = 0
      entries.forEach(e => {
        const amt = parseFloat(e.amount) || 0
        switch (e.type) {
          case 'Starting Balance': startingBalance += amt; break
          case 'Manual Expense':   manualExpenses += amt; break
          case 'Income/Grant':     income += amt; break
          case 'Adjustment':       adjustments += amt; break
          default: /* ignore unknown types */ break
        }
      })

      // Sum PO expenses within the AY date range
      let poExpenses = 0
      orders.forEach(o => {
        const raw = o.ordered_date || o.order_date
        if (!raw) return
        const d = new Date(raw)
        if (isNaN(d.getTime())) return
        if (d >= ayStart && d < ayEnd) {
          poExpenses += parseFloat(o.total) || 0
        }
      })

      const totalBudget = startingBalance + income + adjustments
      const totalSpent = manualExpenses + poExpenses
      const remaining = totalBudget - totalSpent
      const percentUsed = totalBudget > 0
        ? Math.round((totalSpent / totalBudget) * 100)
        : 0

      setSummary({
        schoolYear,
        startingBalance,
        income,
        adjustments,
        manualExpenses,
        poExpenses,
        totalBudget,
        totalSpent,
        remaining,
        percentUsed,
      })
      hasLoadedRef.current = true
    } catch (err) {
      console.error('[usePOBudgetSummary] fetch error:', err)
      // Don't toast — this is a passive at-a-glance tile, not a primary action.
      // The tile itself shows a "Budget not set" message when summary is null
      // or zero, which covers the error path too.
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [ayStartYear])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when budget entries or orders change. We subscribe even
  // when ayStartYear changes — the channel name is keyed on the AY so each
  // selected year gets its own subscription scope cleanly.
  useEffect(() => {
    if (ayStartYear == null) return
    const channel = supabase
      .channel(`po-budget-summary-${ayStartYear}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => fetch())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => fetch())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [ayStartYear, fetch])

  return {
    summary,
    loading,
    refresh: fetch,
  }
}
