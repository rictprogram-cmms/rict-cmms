/**
 * RICT CMMS — "Not charged to budget" dialog + save helper
 *
 * Marks a CMMS order as not charged to the program budget (paid out of pocket,
 * donated, or paid from another account). A marked order keeps its total for
 * the record but is left out of every Program Budget figure and is never
 * suggested as a link when a college report is imported (src/lib/budgetMath.js,
 * src/lib/budgetImport.js).
 *
 * Used by the Program Budget page (Not Yet on College Report list) and the
 * Purchase Orders order detail. Editable by people who can approve POs.
 *
 * Accessibility (WCAG 2.1 AA): useDialogA11y (focus trap, Escape, focus
 * return), role="dialog" + aria-modal + labelled/described, 44px targets,
 * focus-visible rings, inline error announced with role="alert".
 *
 * File: src/components/BudgetExcludeDialog.jsx
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { supabase } from '@/lib/supabase'
import { assertWrite } from '@/lib/supabaseData'
import { BUDGET_EXCLUDED_REASONS } from '@/lib/budgetMath'

/** Local wall-clock time stored with a +00 offset (fake-UTC convention). */
function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}+00`
}

/**
 * Save or clear the "not charged to budget" mark on an order.
 * @param {string} orderId
 * @param {{reason: string, note?: string}|null} values  null = count in budget again
 * @param {string} userName
 * @returns {Promise<{ error: Error|null }>}
 */
export async function saveOrderBudgetExclusion(orderId, values, userName) {
  const upd = values
    ? {
        budget_excluded_reason: values.reason,
        budget_excluded_note: (values.note || '').trim() || null,
        budget_excluded_by: userName || null,
        budget_excluded_at: localToUtcIso(new Date()),
      }
    : { budget_excluded_reason: null, budget_excluded_note: null, budget_excluded_by: null, budget_excluded_at: null }
  const { error } = assertWrite(
    await supabase.from('orders').update(upd).eq('order_id', orderId).select('order_id'),
    'orders.update'
  )
  return { error: error ? new Error(error.message) : null }
}

/** Fake-UTC timestamp → "11/5/2026" */
export function fmtExcludedAt(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { timeZone: 'UTC' })
}

/**
 * @param {object} props
 * @param {{orderId: string, vendor: string, total: number}} props.order
 * @param {boolean} props.saving
 * @param {(values: {reason: string, note: string}) => void} props.onSave
 * @param {() => void} props.onClose
 */
export default function BudgetExcludeDialog({ order, saving, onSave, onClose }) {
  const [reason, setReason] = useState(BUDGET_EXCLUDED_REASONS[0])
  const [note, setNote] = useState('')
  const dialogRef = useDialogA11y(true, onClose)
  const titleId = `budget-excl-title-${order.orderId}`
  const descId = `budget-excl-desc-${order.orderId}`
  const money = '$' + (Number(order.total) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}
        onSubmit={e => { e.preventDefault(); onSave({ reason, note }) }}
        className="bg-white rounded-xl w-full max-w-md shadow-xl p-5 space-y-3">
        <h2 id={titleId} className="text-sm font-bold text-surface-900">Not charged to budget</h2>
        <p id={descId} className="text-xs text-surface-600">
          {order.orderId} · {order.vendor} · {money}. The order keeps its total for your records, but it won&rsquo;t count against the program budget and won&rsquo;t be matched to college report lines. You can undo this any time.
        </p>
        <fieldset>
          <legend className="text-xs font-semibold text-surface-600 mb-1">Reason</legend>
          <div className="space-y-0.5">
            {BUDGET_EXCLUDED_REASONS.map(r => (
              <label key={r} className="flex items-center gap-2 min-h-[44px] cursor-pointer text-sm text-surface-800">
                <input type="radio" name={`budget-excl-reason-${order.orderId}`} value={r} checked={reason === r}
                  onChange={() => setReason(r)} className="w-4 h-4 text-brand-600" />
                {r}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor={`budget-excl-note-${order.orderId}`} className="text-xs font-semibold text-surface-600 block mb-1">Note (optional)</label>
          <textarea id={`budget-excl-note-${order.orderId}`} rows={2} value={note} onChange={e => setNote(e.target.value)}
            placeholder="e.g. Bought on my own card — not reimbursed" className="input text-sm resize-y" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-4 rounded-lg bg-surface-100 text-surface-700 text-xs font-medium hover:bg-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="px-4 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 min-h-[44px] inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            {saving && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Keep off budget
          </button>
        </div>
      </form>
    </div>
  )
}
