import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { computeBudget, BUDGET_ORDER_STATUSES, ORDER_BUDGET_COLUMNS } from '@/lib/budgetMath'

// ═══════════════════════════════════════════════════════════════════════════════
// usePOBudgetSummary
// ─────────────────────────────────────────────────────────────────────────────
// Lean budget summary hook for the Purchase Orders dashboard "Budget Remaining"
// tile. Returns just the at-a-glance numbers for a given academic year.
//
// Uses computeBudget() from src/lib/budgetMath.js — the same function the
// Program Budget page uses — so the two pages always show the same numbers:
//
//   totalBudget   = startingBalance + income + adjustments
//   totalSpent    = ledger expenses + CMMS orders (Approved+) not yet linked
//                   to a college budget line
//   remaining     = available after encumbrances (college "Present Balance",
//                   kept current with CMMS orders not yet on the report)
//   percentUsed   = round((totalSpent / totalBudget) * 100)
//
// Also returns availableBeforeEnc (left if every open encumbrance were
// released), encumberedOpen and requestedOrders (Pending, not subtracted).
//
// @param {number|null} ayStartYear - Academic year start year (e.g. 2025 for
//   AY 2025-26). Pass null when the caller lacks the spend permission to
//   short-circuit fetching entirely.
// @returns { summary, loading, refresh }
//   summary is null while loading or when ayStartYear is null. Otherwise:
//   { startingBalance, income, adjustments, manualExpenses, poExpenses,
//     totalBudget, totalSpent, remaining, percentUsed, schoolYear,
//     availableBeforeEnc, encumberedOpen, requestedOrders }
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

      const [budgetRes, ordersRes] = await Promise.all([
        supabase
          .from('program_budget')
          .select('type, amount, status, payment_status, paid_amount, linked_order_ids, entry_date, category, description, reference')
          .eq('school_year', schoolYear)
          .neq('status', 'Voided'),
        supabase
          .from('orders')
          .select(ORDER_BUDGET_COLUMNS)
          .in('status', BUDGET_ORDER_STATUSES),
      ])

      const entries = mustData(budgetRes, 'program_budget.select') || []
      const orders = mustData(ordersRes, 'orders.select') || []
      const b = computeBudget({ entries, orders, schoolYear })

      setSummary({
        schoolYear,
        startingBalance: b.startingBalance,
        income: b.income,
        adjustments: b.adjustments,
        manualExpenses: b.manualExpenses,
        poExpenses: b.committedOrders,
        totalBudget: b.totalBudget,
        totalSpent: b.totalSpent,
        remaining: b.availableAfterEnc,
        percentUsed: b.percentUsed,
        availableBeforeEnc: b.availableBeforeEnc,
        encumberedOpen: b.encumberedOpen,
        requestedOrders: b.requestedOrders,
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
    return subscribeWithReconnect(`po-budget-summary-${ayStartYear}-${Date.now()}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_budget' }, () => fetch())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => fetch())
    , { tag: 'POBudgetSummary', onReconnect: fetch })
  }, [ayStartYear, fetch])

  return {
    summary,
    loading,
    refresh: fetch,
  }
}
