// ═══════════════════════════════════════════════════════════════════════════════
// RICT CMMS — Program Budget import (college budget printout → ledger)
// File: src/lib/budgetImport.js
//
// Pure functions (no Supabase, no React) so they can be tested in Node.
//
//   parseBudgetRows(rows)  rows = array of arrays from SheetJS / CSV
//     → { format, meta, additions, lines, warnings }
//     • Finds the header row ("Date … Company … Dollar Value") and reads each
//       column BY ITS HEADER NAME, so the FY2027 layout (no spacer columns) and
//       the older layout (spacer columns) both work.
//     • Summary block: every labelled amount between "Beginning Balance" and
//       "Current Balance" (e.g. "ARC - PO 110951  $6,763") is a budget addition.
//     • Detail rows stop at TOTALS; blanket orders below it are ignored.
//     • E/P: P / done → Paid, e → Encumbered, Liq → Liquidated. Blank E/P:
//       CC or Direct Pay → Paid, a PO number → Encumbered.
//     • "Partial Paid" / "Grant / Partial Paid" column → paid so far on an
//       encumbered line (never income).
//
//   planImport({ parsed, existing, orders, schoolYear })
//     → { additions, newLines, changedLines, unchangedLines, unlinkedOrders, … }
//     • A line whose college PO (or CC/Direct Pay date+vendor+amount) is already
//       in the ledger is UPDATED (changes listed), never duplicated.
//     • New lines get suggested CMMS order links (one order is only ever used by
//       one group of lines). Order of passes: College PO # typed on the order →
//       exact amount → several orders adding up to the line → closest single
//       order within 10% → several lines adding up to one order → best
//       remaining same-vendor orders.
// ═══════════════════════════════════════════════════════════════════════════════

import { COMMITTED_ORDER_STATUSES, orderInSchoolYear, orderVendor, isExcludedOrder } from './budgetMath.js'

// ─── Cell helpers ────────────────────────────────────────────────────────────

export function parseNumber(val) {
  if (val == null) return 0
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0
  const s = String(val).trim()
  if (!s || s === '-' || s === '—') return 0
  const neg = /^\(.*\)$/.test(s)
  const n = parseFloat(s.replace(/[()$,\s]/g, ''))
  if (!Number.isFinite(n)) return 0
  return neg ? -n : n
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Cell → "YYYY-MM-DD" (local calendar date) or null. */
export function parseDate(val) {
  if (val == null || val === '') return null
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null
    // SheetJS may return local midnight, UTC midnight, or a few seconds either
    // side. Adding 12 hours lands on the intended calendar day in every case
    // for US time zones.
    return ymd(new Date(val.getTime() + 12 * 3600 * 1000))
  }
  if (typeof val === 'number' && val > 30000 && val < 70000) {
    const ms = Math.round((val - 25569) * 86400000)          // Excel serial → UTC ms
    const u = new Date(ms)
    return ymd(new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()))
  }
  const s = String(val).trim()
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return ymd(new Date(y, Number(m[1]) - 1, Number(m[2])))
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const serial = parseFloat(s)
  if (/^\d+(\.\d+)?$/.test(s) && serial > 30000 && serial < 70000) return parseDate(serial)
  return null
}

const cellText = (c) => (c == null ? '' : c instanceof Date ? ymd(c) : String(c).trim())
const normHeader = (c) => cellText(c).toLowerCase().replace(/[^a-z0-9]/g, '')

/** Vendor name → comparison key ("Amazon - scanners" → "amazon", "LAB Midwest LLC" → "labmidwest"). */
export function vendorKey(name) {
  let s = String(name || '').toLowerCase()
  s = s.split(/\s+[-–—]\s*|\s*[-–—]\s+/)[0]               // drop " - detail"
  s = s.replace(/\b(llc|inc|co|corp|corporation|company|group|ltd)\b\.?/g, '')
  return s.replace(/[^a-z0-9]/g, '')
}

export function vendorsMatch(a, b) {
  const x = vendorKey(a), y = vendorKey(b)
  if (!x || !y) return false
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true
  return x.length >= 5 && y.length >= 5 && x.slice(0, 5) === y.slice(0, 5)
}

/** Reference → kind. */
export function refKind(ref) {
  const r = String(ref || '').trim().toLowerCase()
  if (!r) return 'none'
  if (r === 'cc' || r === 'credit card' || r === 'p-card' || r === 'pcard') return 'cc'
  if (r.replace(/\s/g, '') === 'directpay') return 'direct'
  if (/^\d{4,}$/.test(r)) return 'po'
  return 'other'
}

const normRef = (ref) => {
  const k = refKind(ref)
  if (k === 'cc') return 'CC'
  if (k === 'direct') return 'Direct Pay'
  return String(ref || '').trim()
}

export const OBJECT_CODE_CATEGORY = {
  '3000': 'Supplies', '1420': 'Equipment', '1730': 'Software', '1040': 'Training',
  '1850': 'Supplies', '1870': 'Supplies', '1871': 'Supplies', '2010': 'Supplies',
  '2360': 'Supplies', '2870': 'Other', '2891': 'Other',
}

/** E/P cell + reference → { status, note } */
export function mapStatus(ep, ref) {
  const e = String(ep || '').trim().toLowerCase()
  if (['p', 'paid', 'done', 'complete', 'completed'].includes(e)) return 'Paid'
  if (['e', 'enc', 'encumbered'].includes(e)) return 'Encumbered'
  if (['liq', 'liquidated', 'l'].includes(e)) return 'Liquidated'
  // Blank E/P: a college PO not yet marked is an open commitment; card charges,
  // direct pays and anything without a PO number are already paid.
  return refKind(ref) === 'po' ? 'Encumbered' : 'Paid'
}

// ─── Parse ───────────────────────────────────────────────────────────────────

const HEADER_TESTS = {
  date: (h) => h === 'date' || h === 'entrydate' || h === 'transactiondate',
  reference: (h) => ['pono', 'po', 'ponumber', 'po#', 'reference', 'ref', 'collegepo'].includes(h),
  description: (h) => ['company', 'vendor', 'description', 'payee'].includes(h),
  ep: (h) => h === 'ep' || h === 'status' || h === 'paymentstatus',
  objectCode: (h) => h === 'objectcode' || h === 'code' || h === 'object',
  amount: (h) => h === 'dollarvalue' || h === 'amount' || h === 'dollaramount' || h === 'value',
  partial: (h) => h.includes('partial') || h === 'grant',
}

const LEGACY_COLUMNS = { date: 0, reference: 2, description: 4, ep: 5, objectCode: 6, amount: 8, partial: 9 }

function findColumns(row) {
  const cols = {}
  row.forEach((c, i) => {
    const h = normHeader(c)
    if (!h) return
    for (const [key, test] of Object.entries(HEADER_TESTS)) {
      if (cols[key] === undefined && test(h)) { cols[key] = i; break }
    }
  })
  return cols
}

function firstNumber(row) {
  for (const c of row) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string' && /^\s*\(?\$?\s*-?[\d,]+(\.\d+)?\)?\s*$/.test(c)) return parseNumber(c)
  }
  return null
}

function firstLabel(row) {
  for (const c of row) {
    if (typeof c === 'string' && /[a-z]/i.test(c)) return c.trim()
  }
  return ''
}

/**
 * @param {Array<Array<any>>} rows
 */
export function parseBudgetRows(rows) {
  const meta = {
    program: '', fiscalYear: '', account: '', reportDate: null, balancedAsOf: null,
    beginningBalance: null, currentBalance: null, presentBalance: null, totals: null,
  }
  const additions = []
  const lines = []
  const warnings = []
  rows = (rows || []).map(r => (Array.isArray(r) ? r : []))

  // Header row
  let headerIdx = -1, cols = null
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = findColumns(rows[i])
    if (c.date !== undefined && c.description !== undefined && c.amount !== undefined) {
      headerIdx = i; cols = c; break
    }
  }

  // Top-of-sheet text (title, dates, account)
  const topText = rows.slice(0, headerIdx >= 0 ? headerIdx : 15)
    .map(r => r.map(cellText).filter(Boolean).join(' ')).join(' \n ')
  const fy = topText.match(/FY\s?(\d{4})/i)
  if (fy) meta.fiscalYear = `FY${fy[1]}`
  if (/robotics/i.test(topText)) meta.program = 'ROBOTICS'
  const acct = topText.match(/\b(0\d{5})\b/)
  if (acct) meta.account = acct[1]
  const asOf = topText.match(/balanced\s*\n?\s*as\s+of\s+(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i)
  if (asOf) meta.balancedAsOf = parseDate(asOf[1])
  const rpt = topText.match(/report\s+date\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
  if (rpt) meta.reportDate = parseDate(rpt[1])
  if (!meta.reportDate) {
    const firstDate = rows.slice(0, 4).flat().find(c => parseDate(c instanceof Date ? c : cellText(c)) && /\d+\/\d+\/\d{4}/.test(cellText(c)))
    if (firstDate) meta.reportDate = parseDate(cellText(firstDate))
  }

  const isRict = headerIdx >= 0 && (!!meta.fiscalYear || !!meta.program || /beginning balance/i.test(topText))

  // Summary block → balances and additions
  if (headerIdx > 0) {
    let inAdditions = false
    for (let i = 0; i < headerIdx; i++) {
      const row = rows[i]
      const label = firstLabel(row)
      const amount = firstNumber(row.filter(c => !(typeof c === 'string' && /[a-z]/i.test(c))))
      if (!label || amount == null) continue
      const l = label.toLowerCase()
      if (l.includes('beginning balance')) { meta.beginningBalance = amount; inAdditions = true; continue }
      if (l.includes('current balance')) { meta.currentBalance = amount; inAdditions = false; continue }
      if (l.includes('present balance')) { meta.presentBalance = amount; continue }
      if (inAdditions && amount !== 0 && !/total|balance|blanket/i.test(l)) {
        const po = label.match(/\b(\d{5,})\b/)
        additions.push({ description: label, amount: Math.abs(amount), reference: po ? po[1] : '', credit: amount > 0 })
      }
    }
  }

  // Detail rows
  if (headerIdx >= 0) {
    if (cols.reference === undefined || cols.ep === undefined) {
      // Header found but some columns unnamed — fall back to legacy slots only for missing ones.
      for (const [k, v] of Object.entries(LEGACY_COLUMNS)) if (cols[k] === undefined && rows[headerIdx][v] != null) cols[k] = v
    }
    let lastDate = null
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i]
      const get = (k) => (cols[k] === undefined ? null : row[cols[k]])
      const description = cellText(get('description'))
      if (/^totals?$/i.test(description)) { meta.totals = parseNumber(get('amount')); break }
      if (!description) continue

      const reference = normRef(cellText(get('reference')))
      const amount = parseNumber(get('amount'))
      const partial = parseNumber(get('partial'))
      const ep = cellText(get('ep'))
      const status = mapStatus(ep, reference)
      const rawCode = get('objectCode')
      const objectCode = rawCode == null ? '' : String(rawCode).trim().replace(/\.0+$/, '')

      let date = parseDate(get('date'))
      if (date) lastDate = date
      else date = lastDate

      // Group labels ("CLC Grant 311310-731.80") and empty lines have no amount.
      if (amount === 0 && status !== 'Liquidated') continue
      if (amount < 0) warnings.push(`Row ${i + 1}: negative amount for ${description} imported as an adjustment.`)

      const paidAmount = status === 'Encumbered' ? Math.min(Math.max(partial, 0), Math.abs(amount))
        : Math.abs(amount)
      lines.push({
        row: i + 1,
        date,
        description,
        reference,
        kind: refKind(reference),
        amount: Math.abs(amount),
        isCredit: amount < 0,
        paidAmount: Math.round(paidAmount * 100) / 100,
        partial: partial || 0,
        paymentStatus: status,
        epRaw: ep,
        objectCode,
        category: OBJECT_CODE_CATEGORY[objectCode] || 'Other',
      })
    }
  }

  // Generic CSV with a single header row and no RICT title still parses above
  // (header found at row 0). Nothing found at all → caller shows an error.
  return {
    format: isRict ? 'RICT' : headerIdx >= 0 ? 'Generic' : 'Unknown',
    meta, additions, lines, warnings,
    headerRow: headerIdx >= 0 ? headerIdx + 1 : null,
  }
}

// ─── Plan ────────────────────────────────────────────────────────────────────

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol
const dayMs = 86400000
const toDate = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`) : null)
const descKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Window for an order to be a candidate for a college line. */
function inWindow(order, lineDate, back = 45, fwd = 5) {
  const ld = toDate(lineDate)
  const created = order.order_date ? new Date(order.order_date) : null
  const od = created && !isNaN(created) ? created : (order.ordered_date ? new Date(order.ordered_date) : null)
  if (!ld || !od || isNaN(od)) return false
  const diff = (od - ld) / dayMs
  return diff >= -back && diff <= fwd
}

/**
 * @param {object} args
 * @param {object}   args.parsed      result of parseBudgetRows
 * @param {object[]} args.existing    program_budget rows for the school year (any status)
 * @param {object[]} args.orders      orders rows (any year; filtered here)
 * @param {string}   args.schoolYear
 */
export function planImport({ parsed, existing = [], orders = [], schoolYear }) {
  const active = existing.filter(e => e.status !== 'Voided')
  const expenses = active.filter(e => e.type === 'Manual Expense')
  const claimedExisting = new Set()

  // ── Additions (Income/Grant) ──
  const additions = parsed.additions.map(a => {
    const match = active.find(e =>
      (e.type === 'Income/Grant' || e.type === 'Adjustment') && !claimedExisting.has(e.id) &&
      near(Number(e.amount), a.amount) &&
      (a.reference ? String(e.reference || '') === a.reference || String(e.description || '').includes(a.reference) : descKey(e.description) === descKey(a.description)))
    if (match) claimedExisting.add(match.id)
    return { ...a, status: match ? 'exists' : 'new', existing: match || null }
  })

  // ── Lines: existing vs new ──
  const newLines = [], changedLines = [], unchangedLines = []
  for (const line of parsed.lines) {
    let match = null
    if (line.kind === 'po') {
      const group = expenses.filter(e => !claimedExisting.has(e.id) && String(e.reference || '').trim() === line.reference)
      match = group.find(e => descKey(e.description) === descKey(line.description))
        || group.find(e => near(Number(e.amount), line.amount))
        || (group.length === 1 ? group[0] : null)
    } else {
      const ld = toDate(line.date)
      match = expenses.find(e => {
        if (claimedExisting.has(e.id)) return false
        if (refKind(e.reference) !== line.kind && !(line.kind === 'none' && !e.reference)) return false
        if (!near(Number(e.amount), line.amount)) return false
        if (descKey(e.description) !== descKey(line.description) && !vendorsMatch(e.description, line.description)) return false
        const ed = toDate(e.entry_date)
        return !ld || !ed || Math.abs(ed - ld) <= 3 * dayMs
      }) || null
    }

    if (!match) { newLines.push({ line }); continue }
    claimedExisting.add(match.id)

    const changes = []
    const oldAmt = Number(match.amount) || 0
    if (!near(oldAmt, line.amount)) changes.push({ field: 'amount', label: 'Amount', from: oldAmt, to: line.amount })
    if ((match.payment_status || '') !== line.paymentStatus) changes.push({ field: 'payment_status', label: 'Status', from: match.payment_status || '—', to: line.paymentStatus })
    const oldPaid = Number(match.paid_amount) || 0
    const newPaid = line.paymentStatus === 'Encumbered' ? line.paidAmount : null
    if (newPaid != null && !near(oldPaid, newPaid)) changes.push({ field: 'paid_amount', label: 'Paid so far', from: oldPaid, to: newPaid })
    if (line.objectCode && (match.object_code || '') !== line.objectCode) changes.push({ field: 'object_code', label: 'Object code', from: match.object_code || '—', to: line.objectCode })
    const becomesCollege = (match.source || 'manual') !== 'college_report'

    // A release request clears once the college shows the money released.
    let clearRelease = false
    if (match.release_requested_at) {
      const relAmt = Number(match.release_amount) || 0
      if (['Paid', 'Liquidated'].includes(line.paymentStatus)) clearRelease = true
      else if (relAmt > 0 && line.amount <= oldAmt - relAmt + 0.005) clearRelease = true
    }

    if (changes.length || becomesCollege || clearRelease) changedLines.push({ line, existing: match, changes, becomesCollege, clearRelease })
    else unchangedLines.push({ line, existing: match })
  }

  // ── Order suggestions for new lines ──
  const linkedAlready = new Set()
  for (const e of active) for (const id of e.linked_order_ids || []) linkedAlready.add(id)
  const pool = orders.filter(o =>
    COMMITTED_ORDER_STATUSES.includes(o.status) && orderInSchoolYear(o, schoolYear) && !linkedAlready.has(o.order_id) &&
    !isExcludedOrder(o))   // "not charged to budget" orders are never suggested
  const claimed = new Set()
  const avail = (o) => !claimed.has(o.order_id)
  const total = (o) => Number(o.total) || 0
  const links = new Map(newLines.map(n => [n, { orderIds: [], how: null }]))
  const setLink = (n, ords, how) => { links.set(n, { orderIds: ords.map(o => o.order_id), how }); ords.forEach(o => claimed.add(o.order_id)) }
  const open = () => newLines.filter(n => links.get(n).orderIds.length === 0)
  const cands = (n, opts = {}) => pool.filter(o => avail(o) && vendorsMatch(orderVendor(o), n.line.description) && inWindow(o, n.line.date, opts.back, opts.fwd))

  // 1. College PO # typed on the order
  for (const n of newLines) {
    if (n.line.kind !== 'po') continue
    const exact = pool.filter(o => avail(o) && String(o.college_po || '').trim() === n.line.reference)
    if (exact.length) setLink(n, exact, 'college_po')
  }
  // 2. Exact amount (wider window — same amount is strong evidence)
  {
    const pairs = []
    for (const n of open()) for (const o of cands(n, { back: 90, fwd: 10 })) {
      if (near(total(o), n.line.amount, 0.02)) pairs.push({ n, o, d: Math.abs(new Date(o.order_date || o.ordered_date) - toDate(n.line.date)) })
    }
    pairs.sort((a, b) => a.d - b.d)
    for (const p of pairs) if (!links.get(p.n).orderIds.length && avail(p.o)) setLink(p.n, [p.o], 'exact')
  }
  // 3. Two or three orders adding up to the line
  for (const n of open()) {
    const c = cands(n)
    let best = null
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      const s2 = total(c[i]) + total(c[j])
      if (near(s2, n.line.amount, Math.max(0.05, n.line.amount * 0.005))) best = best || [c[i], c[j]]
      for (let k = j + 1; k < c.length && !best; k++) {
        if (near(s2 + total(c[k]), n.line.amount, Math.max(0.05, n.line.amount * 0.005))) best = [c[i], c[j], c[k]]
      }
    }
    if (best) setLink(n, best, 'sum')
  }
  // 4. Closest single order within 10%
  {
    const pairs = []
    for (const n of open()) for (const o of cands(n)) {
      const r = Math.min(total(o), n.line.amount) / Math.max(total(o), n.line.amount, 0.01)
      if (r >= 0.9) pairs.push({ n, o, r })
    }
    pairs.sort((a, b) => b.r - a.r)
    for (const p of pairs) if (!links.get(p.n).orderIds.length && avail(p.o)) setLink(p.n, [p.o], 'close')
  }
  // 5. Several lines (same vendor, same date) adding up to one order
  for (const o of pool.filter(avail)) {
    const group = open().filter(n => vendorsMatch(orderVendor(o), n.line.description) && inWindow(o, n.line.date))
    let done = false
    for (let i = 0; i < group.length && !done; i++) for (let j = i + 1; j < group.length && !done; j++) {
      const a = group[i], b = group[j]
      if (a.line.date !== b.line.date) continue
      const s = a.line.amount + b.line.amount
      if (Math.abs(s - total(o)) / Math.max(total(o), 0.01) <= 0.03) {
        links.set(a, { orderIds: [o.order_id], how: 'split' })
        links.set(b, { orderIds: [o.order_id], how: 'split' })
        claimed.add(o.order_id)
        done = true
      }
    }
  }
  // 6. Best remaining same-vendor orders (amounts may differ — flagged for review)
  for (const n of [...open()].sort((a, b) => String(a.line.date).localeCompare(String(b.line.date)))) {
    const c = cands(n)
    if (!c.length) continue
    let best = null, bestDiff = Infinity
    const consider = (set) => {
      const d = Math.abs(set.reduce((s, o) => s + total(o), 0) - n.line.amount)
      if (d < bestDiff) { bestDiff = d; best = set }
    }
    for (let i = 0; i < c.length; i++) {
      consider([c[i]])
      for (let j = i + 1; j < c.length; j++) {
        consider([c[i], c[j]])
        for (let k = j + 1; k < c.length; k++) consider([c[i], c[j], c[k]])
      }
    }
    if (best) setLink(n, best, 'loose')
  }

  const orderById = Object.fromEntries(orders.map(o => [o.order_id, o]))
  const newOut = newLines.map(n => {
    const l = links.get(n)
    const linked = l.orderIds.map(id => orderById[id]).filter(Boolean)
    const sharedWith = l.how === 'split'
      ? newLines.filter(m => m !== n && links.get(m).how === 'split' && links.get(m).orderIds[0] === l.orderIds[0]).map(m => m.line.row)
      : []
    const ordersTotal = linked.reduce((s, o) => s + total(o), 0)
    const compareAmount = l.how === 'split'
      ? n.line.amount + newLines.filter(m => sharedWith.includes(m.line.row)).reduce((s, m) => s + m.line.amount, 0)
      : n.line.amount
    const diff = Math.round((compareAmount - ordersTotal) * 100) / 100
    const flag = linked.length > 0 && (l.how === 'loose' || Math.abs(diff) > Math.max(1, compareAmount * 0.25))
    return {
      line: n.line,
      suggestedOrderIds: l.orderIds,
      linkHow: l.how,
      linkedOrders: linked,
      sharedWithRows: sharedWith,
      ordersTotal: Math.round(ordersTotal * 100) / 100,
      diff,
      needsCheck: flag,
    }
  })

  // Orders that stay "not yet on the college report" after this import
  const willLink = new Set(newOut.flatMap(n => n.suggestedOrderIds))
  const unlinkedOrders = pool.filter(o => !willLink.has(o.order_id))

  // Ledger lines in the CMMS that this report did not mention (college lines only)
  const seen = new Set([...changedLines, ...unchangedLines].map(c => c.existing.id))
  const missingFromReport = expenses.filter(e => (e.source === 'college_report') && !seen.has(e.id))

  return {
    additions,
    newLines: newOut,
    changedLines,
    unchangedLines,
    unlinkedOrders,
    missingFromReport,
    totalFromFile: parsed.lines.length,
  }
}

/** FY2027 → "2026-2027" */
export function fiscalYearToSchoolYear(fy) {
  const m = String(fy || '').match(/(\d{4})/)
  if (!m) return null
  const y = Number(m[1])
  return `${y - 1}-${y}`
}
