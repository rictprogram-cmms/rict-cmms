// ═══════════════════════════════════════════════════════════════════════════════
// RICT CMMS — Program Budget math (single source of truth)
// File: src/lib/budgetMath.js
//
// Every balance figure on the Program Budget page, the Year Mgmt cards and the
// Purchase Orders "Budget Remaining" tile comes from computeBudget(), so they
// can never disagree.
//
// Model (2026-11, college ledger):
//   • program_budget rows are the ledger. Rows imported from the college budget
//     printout have source = 'college_report' and carry the college PO number in
//     `reference`, the E/P status in `payment_status`, and partial payments in
//     `paid_amount`. Hand-entered rows (source = 'manual') work as before.
//   • CMMS orders count against the budget from Approved onward. Once an order
//     is linked to a college line (program_budget.linked_order_ids) it stops
//     counting on its own — the college line's amount is used instead.
//   • Pending orders are "requested": shown, never subtracted.
//   • Orders marked "not charged to budget" (paid out of pocket, donated, paid
//     from another account) are listed separately and never counted.
//
// Figures:
//   totalBudget          = starting balance + income/grants + adjustments
//   paid                 = money the business office has paid
//   encumberedOpen       = encumbered − paid so far on encumbered lines
//   committedOrders      = CMMS orders (Approved+) not yet on a college report
//   availableAfterEnc    = totalBudget − paid − encumberedOpen − committedOrders
//                          (the college's "Present Balance", kept current)
//   availableBeforeEnc   = totalBudget − paid − committedOrders
//                          (what is left if every open encumbrance were released)
//
// Hand-entered expenses with no status (or Pending) count as Paid, which is how
// the page has always treated them.
// ═══════════════════════════════════════════════════════════════════════════════

/** Order statuses that count against the budget (money is committed). */
export const COMMITTED_ORDER_STATUSES = ['Approved', 'Ready', 'Submitted', 'Ordered', 'Partial', 'Received']
/** Order statuses shown as "requested" (awaiting approval) — never subtracted. */
export const REQUESTED_ORDER_STATUSES = ['Pending']
/** Everything the budget hooks need to fetch from `orders`. */
export const BUDGET_ORDER_STATUSES = [...COMMITTED_ORDER_STATUSES, ...REQUESTED_ORDER_STATUSES]

export const ORDER_BUDGET_COLUMNS =
  'order_id, vendor_name, other_vendor, order_date, approved_date, ordered_date, ordered_by, status, total, notes, college_po, ' +
  'budget_excluded_reason, budget_excluded_note, budget_excluded_by, budget_excluded_at'

/** Reasons an order is "not charged to budget" (orders.budget_excluded_reason). */
export const BUDGET_EXCLUDED_REASONS = ['Paid out of pocket', 'Donated', 'Paid from another account']

/** True when the order was marked as not charged to the program budget. */
export function isExcludedOrder(o) {
  return !!(o && o.budget_excluded_reason)
}

/** Statuses on a ledger line that leave money encumbered. */
const ENCUMBERED_STATUSES = new Set(['Encumbered', 'Partial'])

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** "2025-2026" → { start: 2025-07-01 local, end: 2026-07-01 local (exclusive) } */
export function schoolYearRange(sy) {
  const [a, b] = String(sy || '').split('-').map(Number)
  return { start: new Date(a, 6, 1), end: new Date(b, 6, 1) }
}

/** The date an order belongs to for budget purposes. */
export function orderBudgetDate(o) {
  const raw = o?.ordered_date || o?.approved_date || o?.order_date
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

export function orderInSchoolYear(o, sy) {
  const d = orderBudgetDate(o)
  if (!d) return false
  const { start, end } = schoolYearRange(sy)
  return d >= start && d < end
}

export function orderVendor(o) {
  return o?.vendor_name || o?.other_vendor || 'Unknown'
}

/** Paid portion and open (still encumbered) portion of one expense line. */
export function lineMoney(e) {
  const amount = num(e.amount)
  const status = e.payment_status || ''
  if (ENCUMBERED_STATUSES.has(status)) {
    const paid = Math.min(Math.max(num(e.paid_amount), 0), Math.max(amount, 0))
    return { amount, paid: round2(paid), open: round2(amount - paid), encumbered: true }
  }
  // Paid, Liquidated, Pending, or no status → all of it is spent.
  return { amount, paid: round2(amount), open: 0, encumbered: false }
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000)
}

function monthKey(d) {
  return `${d.getMonth() + 1}/${d.getFullYear()}`
}

/** Entry dates are stored as noon UTC — read them back as a local calendar date. */
function entryLocalDate(raw) {
  if (!raw) return null
  const s = String(raw).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return new Date(`${s}T00:00:00`)
}

/**
 * Compute every budget figure for one school year.
 *
 * @param {object}   args
 * @param {object[]} args.entries  program_budget rows for the year (Voided rows are ignored)
 * @param {object[]} args.orders   orders rows (any year — filtered here)
 * @param {string}   args.schoolYear "YYYY-YYYY"
 * @param {Date}     [args.now]
 */
export function computeBudget({ entries = [], orders = [], schoolYear, now = new Date() }) {
  let startingBalance = 0, income = 0, adjustments = 0
  let manualExpenses = 0, paid = 0, encumberedTotal = 0, encumberedOpen = 0, partialPaid = 0
  let releaseRequestedTotal = 0
  const categoryTotals = {}
  const monthly = {}
  const openEncumbrances = []
  const linkedOrderIds = new Set()
  const lineByOrder = {}

  for (const e of entries) {
    if (e.status === 'Voided') continue
    const amt = num(e.amount)
    for (const id of e.linked_order_ids || []) {
      linkedOrderIds.add(id)
      if (!lineByOrder[id]) lineByOrder[id] = e
    }
    switch (e.type) {
      case 'Starting Balance': startingBalance += amt; break
      case 'Income/Grant': income += amt; break
      case 'Adjustment': adjustments += amt; break
      case 'Manual Expense': {
        manualExpenses += amt
        const cat = e.category || 'Other'
        categoryTotals[cat] = (categoryTotals[cat] || 0) + amt
        const d = entryLocalDate(e.entry_date)
        if (d) monthly[monthKey(d)] = (monthly[monthKey(d)] || 0) + amt

        const m = lineMoney(e)
        paid += m.paid
        if (m.encumbered) {
          encumberedTotal += m.amount
          partialPaid += m.paid
          encumberedOpen += m.open
          if (m.open > 0.004) {
            const releaseAmt = e.release_requested_at ? num(e.release_amount) : 0
            releaseRequestedTotal += releaseAmt
            openEncumbrances.push({
              id: e.id,
              description: e.description,
              reference: e.reference || '',
              amount: m.amount,
              paid: m.paid,
              open: m.open,
              date: e.entry_date,
              ageDays: d ? Math.max(daysBetween(d, now), 0) : null,
              objectCode: e.object_code || '',
              linkedOrderIds: e.linked_order_ids || [],
              releaseRequestedAt: e.release_requested_at || null,
              releaseRequestedBy: e.release_requested_by || '',
              releaseAmount: e.release_requested_at ? num(e.release_amount) : 0,
              releaseNote: e.release_note || '',
              source: e.source || 'manual',
            })
          }
        }
        break
      }
      default: break
    }
  }

  // Orders
  let committedOrders = 0, requestedOrders = 0, excludedOrders = 0
  const committedOrderList = [], requestedOrderList = [], linkedOrderList = [], excludedOrderList = []
  for (const o of orders) {
    if (!orderInSchoolYear(o, schoolYear)) continue
    const total = num(o.total)
    const d = orderBudgetDate(o)
    const row = {
      orderId: o.order_id,
      vendor: orderVendor(o),
      date: d ? d.toISOString() : null,
      status: o.status,
      total,
      orderedBy: o.ordered_by || '',
      notes: o.notes || '',
      collegePo: o.college_po || '',
    }
    if (isExcludedOrder(o)) {
      if (!REQUESTED_ORDER_STATUSES.includes(o.status) && !COMMITTED_ORDER_STATUSES.includes(o.status)) continue
      excludedOrders += total
      excludedOrderList.push({
        ...row,
        reason: o.budget_excluded_reason,
        note: o.budget_excluded_note || '',
        by: o.budget_excluded_by || '',
        at: o.budget_excluded_at || null,
      })
      continue
    }
    if (REQUESTED_ORDER_STATUSES.includes(o.status)) {
      requestedOrders += total
      requestedOrderList.push(row)
      continue
    }
    if (!COMMITTED_ORDER_STATUSES.includes(o.status)) continue
    if (linkedOrderIds.has(o.order_id)) {
      const line = lineByOrder[o.order_id]
      linkedOrderList.push({ ...row, lineId: line?.id, lineReference: line?.reference || '', lineDescription: line?.description || '' })
      continue
    }
    committedOrders += total
    committedOrderList.push(row)
    categoryTotals['Purchase Orders'] = (categoryTotals['Purchase Orders'] || 0) + total
    if (d) monthly[monthKey(d)] = (monthly[monthKey(d)] || 0) + total
  }

  const totalBudget = startingBalance + income + adjustments
  const totalSpent = manualExpenses + committedOrders
  const availableAfterEnc = totalBudget - paid - encumberedOpen - committedOrders
  const availableBeforeEnc = totalBudget - paid - committedOrders
  const percentUsed = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0

  openEncumbrances.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0) || b.open - a.open)
  committedOrderList.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  requestedOrderList.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  excludedOrderList.sort((a, b) => String(a.date).localeCompare(String(b.date)))

  return {
    schoolYear,
    startingBalance: round2(startingBalance),
    income: round2(income),
    adjustments: round2(adjustments),
    totalBudget: round2(totalBudget),
    manualExpenses: round2(manualExpenses),
    paid: round2(paid),
    encumberedTotal: round2(encumberedTotal),
    partialPaid: round2(partialPaid),
    encumberedOpen: round2(encumberedOpen),
    releaseRequestedTotal: round2(releaseRequestedTotal),
    committedOrders: round2(committedOrders),
    committedOrderCount: committedOrderList.length,
    requestedOrders: round2(requestedOrders),
    requestedOrderCount: requestedOrderList.length,
    excludedOrders: round2(excludedOrders),
    excludedOrderCount: excludedOrderList.length,
    totalSpent: round2(totalSpent),
    availableAfterEnc: round2(availableAfterEnc),
    availableBeforeEnc: round2(availableBeforeEnc),
    // Back-compatible names used by existing tiles:
    remaining: round2(availableAfterEnc),
    poExpenses: round2(committedOrders),
    poCount: committedOrderList.length,
    percentUsed,
    categoryTotals,
    monthly,
    openEncumbrances,
    committedOrderList,
    requestedOrderList,
    linkedOrderList,
    excludedOrderList,
    linkedOrderIds,
  }
}

/** Jul → Jun month buckets up to today, for the Monthly Spending chart. */
export function buildMonthlyTrend(schoolYear, monthly, now = new Date()) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const { start, end } = schoolYearRange(schoolYear)
  const out = []
  const d = new Date(start)
  while (d < end && d <= now) {
    const mk = monthKey(d)
    out.push({ label: `${names[d.getMonth()]} ${d.getFullYear()}`, shortLabel: names[d.getMonth()], amount: round2(monthly[mk] || 0) })
    d.setMonth(d.getMonth() + 1)
  }
  return out
}
