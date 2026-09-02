/**
 * RICT CMMS — Public Work Order Request Page  (PUBLIC / no auth required)
 *
 * Route: /request-work-order
 *
 * Lets faculty and staff in other SCTCC departments ask the RICT program to
 * repair a piece of equipment. No account needed — an @sctcc.edu email is
 * required and enforced server-side.
 *
 * Everything goes through one RPC, `submit_public_wo_request`, which validates,
 * rate-limits, generates the REQ-xxxx id and inserts into work_order_requests
 * with status 'Pending'. From there the existing instructor flow takes over:
 * push notification → Requests tab → Approve & assign → email to requester.
 *
 * Equipment picker reads `list_public_assets()` (asset_id + name of Active
 * assets only). "Not listed / other" reveals a free-text description.
 *
 * Deep link: /request-work-order?asset=AST-0123 pre-selects that asset (for
 * QR labels later — no other behavior depends on it).
 *
 * Accessibility (WCAG 2.1 AA / Section 508):
 *   • Every control has a visible <label>; required fields marked in the label
 *     text and with aria-required
 *   • Errors are tied to their field via aria-describedby + aria-invalid and
 *     announced through a role="alert" region; focus moves to the first invalid
 *     field on submit
 *   • Priority is a radio group inside <fieldset>/<legend>
 *   • 44px minimum targets, focus-visible rings, no motion
 *   • On success, focus moves to the confirmation heading
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Wrench, CheckCircle2, AlertCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const OTHER = '__other__'
const EMAIL_RE = /^[a-z0-9._%+-]+@sctcc\.edu$/i

const PRIORITIES = [
  { value: 'Low',    hint: 'Annoying, but the equipment still works' },
  { value: 'Medium', hint: 'Works poorly or only sometimes' },
  { value: 'High',   hint: 'Down completely or unsafe to use' },
]

const EMPTY = {
  name: '', email: '', phone: '',
  department: '', location: '',
  asset: '', equipment: '',
  description: '', priority: 'Medium',
}

export default function PublicWORequestPage() {
  const [searchParams] = useSearchParams()
  const [form, setForm] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [assets, setAssets] = useState([])
  const [assetsState, setAssetsState] = useState('loading') // loading | ready | failed
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submittedId, setSubmittedId] = useState('')

  const fieldRefs = useRef({})
  const successHeadingRef = useRef(null)

  useEffect(() => { document.title = 'Request equipment repair — RICT CMMS' }, [])

  // ── Asset list ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.rpc('list_public_assets')
        if (error) throw error
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        setAssets(list)
        setAssetsState('ready')
        // Deep link: ?asset=AST-0123 — only honored if it's in the list
        const wanted = (searchParams.get('asset') || '').trim()
        if (wanted && list.some(a => a.asset_id === wanted)) {
          setForm(f => ({ ...f, asset: wanted }))
        }
      } catch (err) {
        console.warn('[PublicWORequest] asset list failed:', err.message)
        if (cancelled) return
        setAssets([])
        setAssetsState('failed')
        setForm(f => ({ ...f, asset: OTHER }))
      }
    })()
    return () => { cancelled = true }
  }, [searchParams])

  // ── Helpers ────────────────────────────────────────────────────────────────
  const set = (key) => (e) => {
    const value = e.target.value
    setForm(f => ({ ...f, [key]: value }))
    if (errors[key]) setErrors(er => { const n = { ...er }; delete n[key]; return n })
    if (submitError) setSubmitError('')
  }

  const validate = useCallback(() => {
    const er = {}
    if (!form.name.trim()) er.name = 'Enter your name.'
    if (!form.email.trim()) er.email = 'Enter your SCTCC email.'
    else if (!EMAIL_RE.test(form.email.trim())) er.email = 'Use your SCTCC email address (ending in @sctcc.edu).'
    if (!form.department.trim()) er.department = 'Enter your department or program.'
    if (!form.location.trim()) er.location = 'Enter the building and room so we know where to go.'
    if (!form.asset) er.asset = 'Choose the equipment, or pick "Not listed" and describe it.'
    if (form.asset === OTHER && !form.equipment.trim()) er.equipment = 'Describe the equipment (make, model, or what it is).'
    if (!form.description.trim()) er.description = 'Describe what is wrong.'
    else if (form.description.trim().length > 2000) er.description = 'Keep the description under 2,000 characters.'
    return er
  }, [form])

  const focusFirstError = (er) => {
    const order = ['name', 'email', 'phone', 'department', 'location', 'asset', 'equipment', 'description']
    const first = order.find(k => er[k])
    if (first && fieldRefs.current[first]) fieldRefs.current[first].focus()
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    if (submitting) return
    const er = validate()
    setErrors(er)
    if (Object.keys(er).length > 0) { focusFirstError(er); return }

    setSubmitting(true)
    setSubmitError('')
    try {
      const { data, error } = await supabase.rpc('submit_public_wo_request', {
        p_name:                  form.name.trim(),
        p_email:                 form.email.trim().toLowerCase(),
        p_description:           form.description.trim(),
        p_phone:                 form.phone.trim() || null,
        p_department:            form.department.trim() || null,
        p_location:              form.location.trim() || null,
        p_asset_id:              form.asset && form.asset !== OTHER ? form.asset : null,
        p_equipment_description: form.asset === OTHER ? form.equipment.trim() : null,
        p_priority:              form.priority,
      })
      if (error) throw error
      if (!data) throw new Error('The request was not saved. Please try again.')
      setSubmittedId(String(data))
      setTimeout(() => successHeadingRef.current?.focus(), 0)
    } catch (err) {
      setSubmitError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const resetForm = () => {
    setForm({ ...EMPTY, asset: assetsState === 'failed' ? OTHER : '' })
    setErrors({})
    setSubmitError('')
    setSubmittedId('')
    setTimeout(() => fieldRefs.current.name?.focus(), 0)
  }

  const errId = (k) => `wor-${k}-error`
  const ref = (k) => (el) => { fieldRefs.current[k] = el }
  const fieldProps = (k, extra = {}) => ({
    id: `wor-${k}`,
    ref: ref(k),
    value: form[k],
    onChange: set(k),
    'aria-invalid': errors[k] ? 'true' : undefined,
    'aria-describedby': [errors[k] ? errId(k) : null, extra.describedBy || null].filter(Boolean).join(' ') || undefined,
    className: `input min-h-[44px] ${errors[k] ? 'input-error' : ''}`,
  })

  const fieldError = (k) => errors[k] ? (
    <p id={errId(k)} className="mt-1 text-sm text-red-700 flex items-start gap-1">
      <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{errors[k]}</span>
    </p>
  ) : null

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-surface-900 via-brand-950 to-surface-900 px-4 py-8 sm:py-12">
      <div className="relative w-full max-w-lg mx-auto">

        <header className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600 shadow-lg mb-4" aria-hidden="true">
            <Wrench size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Request equipment repair</h1>
          <p className="text-sm text-surface-300 mt-2 max-w-md mx-auto">
            For SCTCC faculty and staff. The RICT program reviews each request and assigns a student technician.
            You'll get an email when it's approved and again when the work is done.
          </p>
        </header>

        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">

          {submittedId ? (
            /* ════════ SUCCESS ════════ */
            <div className="p-6 sm:p-8 text-center" role="status">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-4" aria-hidden="true">
                <CheckCircle2 size={32} className="text-emerald-600" />
              </div>
              <h2
                ref={successHeadingRef}
                tabIndex={-1}
                className="text-lg font-semibold text-surface-900 mb-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
              >
                Request submitted for review
              </h2>
              <p className="text-sm text-surface-600 mb-1">Your request number is</p>
              <p className="text-2xl font-mono font-semibold text-surface-900 mb-4">{submittedId}</p>
              <p className="text-sm text-surface-600 mb-6 max-w-sm mx-auto">
                The RICT instructors will review it. Watch <span className="font-medium text-surface-800">{form.email.trim().toLowerCase()}</span> for
                an email when it's approved as a work order, and another when the work is complete.
              </p>
              <button type="button" onClick={resetForm} className="btn-secondary min-h-[44px]">
                Submit another request
              </button>
            </div>
          ) : (
            /* ════════ FORM ════════ */
            <form onSubmit={handleSubmit} noValidate className="p-6 sm:p-8">

              {submitError && (
                <div role="alert" className="mb-5 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{submitError}</span>
                </div>
              )}

              <p className="text-xs text-surface-500 mb-4">Required fields are marked with an asterisk (*).</p>

              {/* Who */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="wor-name" className="label">Your name *</label>
                  <input type="text" autoComplete="name" maxLength={120} aria-required="true" {...fieldProps('name')} />
                  {fieldError('name')}
                </div>
                <div>
                  <label htmlFor="wor-phone" className="label">Phone or extension</label>
                  <input type="tel" autoComplete="tel" maxLength={40} {...fieldProps('phone')} />
                </div>
              </div>

              <div className="mt-4">
                <label htmlFor="wor-email" className="label">SCTCC email *</label>
                <input
                  type="email" autoComplete="email" inputMode="email" maxLength={120} aria-required="true"
                  placeholder="you@sctcc.edu"
                  {...fieldProps('email', { describedBy: 'wor-email-hint' })}
                />
                <p id="wor-email-hint" className="mt-1 text-xs text-surface-500">Status updates go to this address. Must end in @sctcc.edu.</p>
                {fieldError('email')}
              </div>

              {/* Where */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                <div>
                  <label htmlFor="wor-department" className="label">Department or program *</label>
                  <input type="text" autoComplete="organization" maxLength={120} aria-required="true" placeholder="Welding" {...fieldProps('department')} />
                  {fieldError('department')}
                </div>
                <div>
                  <label htmlFor="wor-location" className="label">Building and room *</label>
                  <input type="text" maxLength={120} aria-required="true" placeholder="Northway 112" {...fieldProps('location')} />
                  {fieldError('location')}
                </div>
              </div>

              {/* What */}
              <div className="mt-4">
                <label htmlFor="wor-asset" className="label">Equipment *</label>
                <select
                  aria-required="true"
                  disabled={assetsState === 'loading'}
                  {...fieldProps('asset', { describedBy: 'wor-asset-hint' })}
                >
                  {assetsState === 'loading' && <option value="">Loading equipment list…</option>}
                  {assetsState === 'ready' && <option value="">Choose from the list…</option>}
                  {assets.map(a => (
                    <option key={a.asset_id} value={a.asset_id}>{a.name} ({a.asset_id})</option>
                  ))}
                  <option value={OTHER}>Not listed / other equipment</option>
                </select>
                <p id="wor-asset-hint" className="mt-1 text-xs text-surface-500">
                  {assetsState === 'failed'
                    ? 'The equipment list is unavailable right now — describe the equipment below.'
                    : 'Most equipment outside the RICT lab won\'t be listed. That\'s fine — choose "Not listed" and describe it.'}
                </p>
                {fieldError('asset')}
              </div>

              {form.asset === OTHER && (
                <div className="mt-4">
                  <label htmlFor="wor-equipment" className="label">Describe the equipment *</label>
                  <input
                    type="text" maxLength={200} aria-required="true"
                    placeholder="Lincoln MIG welder, serial on the side"
                    {...fieldProps('equipment')}
                  />
                  {fieldError('equipment')}
                </div>
              )}

              {/* Issue */}
              <div className="mt-4">
                <label htmlFor="wor-description" className="label">What's wrong? *</label>
                <textarea
                  rows={4} maxLength={2000} aria-required="true"
                  placeholder="What happens, when it started, and anything you've already tried."
                  {...fieldProps('description')}
                  className={`input min-h-[44px] resize-y ${errors.description ? 'input-error' : ''}`}
                />
                {fieldError('description')}
              </div>

              <fieldset className="mt-5">
                <legend className="label">How urgent is it?</legend>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {PRIORITIES.map(p => {
                    const checked = form.priority === p.value
                    return (
                      <label
                        key={p.value}
                        htmlFor={`wor-priority-${p.value}`}
                        className={`flex items-start gap-2 p-3 min-h-[44px] rounded-lg border cursor-pointer
                          ${checked ? 'border-brand-500 bg-brand-50' : 'border-surface-200 hover:bg-surface-50'}
                          focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-1`}
                      >
                        <input
                          type="radio"
                          id={`wor-priority-${p.value}`}
                          name="wor-priority"
                          value={p.value}
                          checked={checked}
                          onChange={set('priority')}
                          className="mt-1 h-4 w-4 text-brand-600 focus:ring-brand-500"
                        />
                        <span>
                          <span className="block text-sm font-medium text-surface-900">{p.value}</span>
                          <span className="block text-xs text-surface-500">{p.hint}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <button type="submit" disabled={submitting} className="btn-primary w-full min-h-[44px] mt-6">
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>

              <p className="mt-4 text-xs text-surface-500 text-center" aria-live="polite">
                {submitting ? 'Sending your request to the RICT program.' : 'Nothing is sent until you press Submit request.'}
              </p>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-surface-400 mt-6">
          RICT CMMS — Robotics &amp; Industrial Controls Technician Program
        </p>
      </div>
    </div>
  )
}
