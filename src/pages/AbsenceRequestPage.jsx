/**
 * RICT CMMS — Absence Request Page
 *
 * Implements the manual tracking workflow for Program Policy Section 4.1–4.3:
 * students notify of an absence WITH a make-up plan; instructors approve
 * (choosing "20% Deduction" or "Waived — institutional excused") or reject,
 * and later check off "Make-up complete" when the student follows through.
 *
 * Student / Work Study view:
 *   - "Submit Absence Request" button → modal (class, date, hours, reason, plan)
 *   - List of their own requests with status + deduction outcome
 *
 * Instructor view (permission-gated):
 *   - Filters: status (defaults to Pending), week, student search
 *   - Approve → modal requiring the deduction decision (+ optional notes)
 *   - Reject → shared RejectionModal (reason required)
 *   - Make-up complete checkbox on Approved rows
 *   - "Submit on behalf" — student picker appears in the submit modal
 *     (urgent phone-call situations)
 *
 * Accessibility (WCAG 2.1 AA):
 *   - useDialogA11y on both modals (focus trap, Escape, focus restore)
 *   - role="status" aria-live="polite" announcements for filter results
 *   - Status conveyed by text + icon, never color alone
 *   - aria-hidden on decorative icons; visible focus-visible rings
 *   - Labels associated with every form control
 *
 * File: src/pages/AbsenceRequestPage.jsx
 */

import { useState, useMemo, useCallback, useId } from 'react'
import toast from 'react-hot-toast'
import {
  CalendarOff, CalendarCheck2, Plus, Loader2, Inbox, Info, User, Users,
  Calendar, Clock, FileText, CheckCircle2, XCircle, AlertTriangle,
  Search, Filter, X, ClipboardCheck, MessageSquareText,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import RejectionModal from '@/components/RejectionModal'
import {
  useAbsenceRequests,
  useAbsenceClasses,
  useAbsenceStudentOptions,
  mondayOf,
} from '@/hooks/useAbsenceRequests'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatWeekLabel(weekStartStr) {
  if (!weekStartStr) return '—'
  const d = new Date(weekStartStr + 'T00:00:00')
  if (isNaN(d.getTime())) return weekStartStr
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function formatHours(h) {
  const n = Number(h) || 0
  if (n <= 0) return '—'
  return n % 1 === 0 ? `${n}h` : `${n.toFixed(2)}h`
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── Status badge (text + icon, never color alone) ───────────────────────────

function StatusBadge({ status }) {
  const map = {
    Pending: { cls: 'bg-amber-100 text-amber-800', Icon: Clock },
    Approved: { cls: 'bg-green-100 text-green-800', Icon: CheckCircle2 },
    Rejected: { cls: 'bg-red-100 text-red-700', Icon: XCircle },
  }
  const { cls, Icon } = map[status] || { cls: 'bg-surface-100 text-surface-600', Icon: Info }
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}
      aria-label={`Status: ${status}`}
    >
      <Icon size={11} aria-hidden="true" />
      {status}
    </span>
  )
}

function DeductionBadge({ deduction }) {
  if (!deduction) return null
  const isWaived = deduction === 'Waived'
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
        isWaived ? 'bg-blue-100 text-blue-800' : 'bg-orange-100 text-orange-800'
      }`}
      aria-label={isWaived ? 'Deduction waived — institutional excused' : '20 percent deduction applies'}
    >
      {isWaived ? 'Deduction Waived' : '20% Deduction'}
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMIT MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function SubmitAbsenceModal({ open, onClose, onSubmit, saving, canSubmitOnBehalf, profile }) {
  const [studentEmail, setStudentEmail] = useState('') // on-behalf target ('' = self)
  const [classChoice, setClassChoice] = useState('')   // value = `${class_id}|${course_id}`
  const [absenceDate, setAbsenceDate] = useState(todayStr())
  const [hoursMissed, setHoursMissed] = useState('')
  const [reason, setReason] = useState('')
  const [makeupPlan, setMakeupPlan] = useState('')
  const [formError, setFormError] = useState('')

  const titleId = useId()
  const errId = useId()
  const dialogRef = useDialogA11y(open, onClose)

  const { students, loading: studentsLoading } = useAbsenceStudentOptions({ enabled: open && canSubmitOnBehalf })

  // On-behalf: classes follow the SELECTED student's enrollment; self: own.
  const selectedStudent = useMemo(
    () => students.find(s => (s.email || '').toLowerCase() === studentEmail.toLowerCase()) || null,
    [students, studentEmail]
  )
  const classFilterProfile = canSubmitOnBehalf ? selectedStudent : profile
  const { classes, loading: classesLoading } = useAbsenceClasses(classFilterProfile)

  function resetForm() {
    setStudentEmail('')
    setClassChoice('')
    setAbsenceDate(todayStr())
    setHoursMissed('')
    setReason('')
    setMakeupPlan('')
    setFormError('')
  }

  async function handleSubmit() {
    setFormError('')

    if (canSubmitOnBehalf && !studentEmail) {
      setFormError('Select the student this absence is for.')
      return
    }
    if (!absenceDate) {
      setFormError('Select the date of the absence.')
      return
    }
    if (!reason.trim()) {
      setFormError('A reason is required.')
      return
    }
    if (!makeupPlan.trim()) {
      setFormError('A make-up plan is required — when will the hours be made up?')
      return
    }

    const [classId, courseId] = classChoice ? classChoice.split('|') : ['', '']

    const target = canSubmitOnBehalf && selectedStudent
      ? {
          user_id: selectedStudent.user_id || null,
          user_name: `${selectedStudent.first_name || ''} ${selectedStudent.last_name || ''}`.trim() || selectedStudent.email,
          user_email: selectedStudent.email,
        }
      : {
          user_id: profile?.user_id || null,
          user_name: `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || profile?.email,
          user_email: profile?.email,
        }

    const result = await onSubmit({
      student: target,
      classId,
      courseId,
      absenceDate,
      hoursMissed: parseFloat(hoursMissed) || 0,
      reason,
      makeupPlan,
    })

    if (result?.success) {
      resetForm()
      onClose()
    } else {
      setFormError(result?.message || 'Submission failed. Please try again.')
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => { if (!saving) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-100 flex items-center justify-center">
              <CalendarOff size={16} className="text-brand-600" aria-hidden="true" />
            </div>
            <h2 id={titleId} className="font-semibold text-surface-900">Submit Absence Request</h2>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-2 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Policy reminder */}
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 text-xs text-blue-800">
            <Info size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              Per program policy Section 4.1, notify before the missed lab time or within 24 hours after.
              Approval is required for the make-up window (first two lab days of the following week).
              Submitting does not guarantee approval.
            </p>
          </div>

          {/* On-behalf student picker (instructors only) */}
          {canSubmitOnBehalf && (
            <div>
              <label htmlFor="abs-student" className="block text-xs font-semibold text-surface-700 mb-1">
                Student <span className="text-red-600" aria-hidden="true">*</span>
              </label>
              <select
                id="abs-student"
                value={studentEmail}
                onChange={e => { setStudentEmail(e.target.value); setClassChoice('') }}
                disabled={saving || studentsLoading}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <option value="">{studentsLoading ? 'Loading students…' : 'Select a student…'}</option>
                {students.map(s => (
                  <option key={s.email} value={s.email}>
                    {`${s.last_name || ''}, ${s.first_name || ''}`.replace(/^, /, '') || s.email}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-surface-400 mt-1">
                Submitting on the student's behalf — they'll be notified in their bell.
              </p>
            </div>
          )}

          {/* Class */}
          <div>
            <label htmlFor="abs-class" className="block text-xs font-semibold text-surface-700 mb-1">
              Class
            </label>
            <select
              id="abs-class"
              value={classChoice}
              onChange={e => setClassChoice(e.target.value)}
              disabled={saving || classesLoading}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">{classesLoading ? 'Loading classes…' : 'Select a class (optional)…'}</option>
              {classes.map(c => (
                <option key={c.class_id} value={`${c.class_id}|${c.course_id}`}>
                  {c.course_id} — {c.course_name}
                </option>
              ))}
            </select>
          </div>

          {/* Date + Hours */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="abs-date" className="block text-xs font-semibold text-surface-700 mb-1">
                Date of Absence <span className="text-red-600" aria-hidden="true">*</span>
              </label>
              <input
                id="abs-date"
                type="date"
                value={absenceDate}
                onChange={e => setAbsenceDate(e.target.value)}
                disabled={saving}
                required
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              {absenceDate && (
                <p className="text-[11px] text-surface-400 mt-1">{formatWeekLabel(mondayOf(absenceDate))}</p>
              )}
            </div>
            <div>
              <label htmlFor="abs-hours" className="block text-xs font-semibold text-surface-700 mb-1">
                Hours Missed
              </label>
              <input
                id="abs-hours"
                type="number"
                inputMode="decimal"
                min="0"
                max="24"
                step="0.25"
                value={hoursMissed}
                onChange={e => setHoursMissed(e.target.value)}
                disabled={saving}
                placeholder="e.g. 4"
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
            </div>
          </div>

          {/* Reason */}
          <div>
            <label htmlFor="abs-reason" className="block text-xs font-semibold text-surface-700 mb-1">
              Reason <span className="text-red-600" aria-hidden="true">*</span>
            </label>
            <textarea
              id="abs-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={saving}
              rows={2}
              required
              placeholder="Why will/did you miss the scheduled lab time?"
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-y
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>

          {/* Make-up plan */}
          <div>
            <label htmlFor="abs-plan" className="block text-xs font-semibold text-surface-700 mb-1">
              Make-Up Plan <span className="text-red-600" aria-hidden="true">*</span>
            </label>
            <textarea
              id="abs-plan"
              value={makeupPlan}
              onChange={e => setMakeupPlan(e.target.value)}
              disabled={saving}
              rows={2}
              required
              placeholder="When will you make up the hours? e.g. Monday and Tuesday, 8 AM to 12 PM"
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-y
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>

          {/* Error */}
          {formError && (
            <div
              id={errId}
              role="alert"
              className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-xs text-red-700"
            >
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
              {formError}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-surface-600 rounded-lg hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-brand-600 text-white
                rounded-lg hover:bg-brand-700 active:bg-brand-800 disabled:opacity-50 shadow-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CalendarOff size={14} aria-hidden="true" />}
              Submit Request
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPROVE MODAL (deduction decision required)
// ═══════════════════════════════════════════════════════════════════════════════

function ApproveAbsenceModal({ open, request, onClose, onConfirm, saving }) {
  const [deduction, setDeduction] = useState('')
  const [notes, setNotes] = useState('')
  const [formError, setFormError] = useState('')

  const titleId = useId()
  const groupId = useId()
  const dialogRef = useDialogA11y(open, onClose)

  async function handleConfirm() {
    setFormError('')
    if (!deduction) {
      setFormError('Choose the deduction outcome before approving.')
      return
    }
    const result = await onConfirm(deduction, notes)
    if (result?.success) {
      setDeduction('')
      setNotes('')
      onClose()
    } else {
      setFormError(result?.message || 'Approval failed. Please try again.')
    }
  }

  if (!open || !request) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => { if (!saving) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-100 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
            <CheckCircle2 size={16} className="text-green-600" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="font-semibold text-surface-900">Approve Absence Request</h2>
            <p className="text-xs text-surface-400">
              {request.user_name} — {formatDate(request.absence_date)} ({request.request_id})
            </p>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Deduction decision */}
          <fieldset>
            <legend id={groupId} className="block text-xs font-semibold text-surface-700 mb-2">
              Assignment Deduction (Policy Section 4.2 / Section 4.3) <span className="text-red-600" aria-hidden="true">*</span>
            </legend>
            <div className="space-y-2" role="radiogroup" aria-labelledby={groupId}>
              <label className="flex items-start gap-2.5 p-3 border border-surface-200 rounded-lg cursor-pointer
                hover:bg-surface-50 has-[:checked]:border-orange-400 has-[:checked]:bg-orange-50">
                <input
                  type="radio"
                  name="deduction"
                  value="20% Deduction"
                  checked={deduction === '20% Deduction'}
                  onChange={() => setDeduction('20% Deduction')}
                  disabled={saving}
                  className="mt-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
                />
                <span>
                  <span className="block text-sm font-medium text-surface-900">20% Deduction</span>
                  <span className="block text-xs text-surface-500">
                    Instructor-approved make-up — assignment max score 80% (Section 5.2)
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 p-3 border border-surface-200 rounded-lg cursor-pointer
                hover:bg-surface-50 has-[:checked]:border-blue-400 has-[:checked]:bg-blue-50">
                <input
                  type="radio"
                  name="deduction"
                  value="Waived"
                  checked={deduction === 'Waived'}
                  onChange={() => setDeduction('Waived')}
                  disabled={saving}
                  className="mt-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
                />
                <span>
                  <span className="block text-sm font-medium text-surface-900">Waived — Institutional Excused</span>
                  <span className="block text-xs text-surface-500">
                    Qualifying Section 4.3 event (closure, documented medical, jury duty, bereavement…)
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {/* Notes */}
          <div>
            <label htmlFor="approve-notes" className="block text-xs font-semibold text-surface-700 mb-1">
              Review Notes (optional)
            </label>
            <textarea
              id="approve-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={saving}
              rows={2}
              placeholder="e.g. Documentation received; make up Mon/Tue next week"
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-y
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>

          {formError && (
            <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-xs text-red-700">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
              {formError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-surface-600 rounded-lg hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-green-600 text-white
                rounded-lg hover:bg-green-700 active:bg-green-800 disabled:opacity-50 shadow-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
            >
              {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST CARD (shared by student + instructor views)
// ═══════════════════════════════════════════════════════════════════════════════

function RequestCard({ req, isReviewer, canMarkMakeup, saving, onApprove, onReject, onToggleMakeup }) {
  const isOnBehalf =
    req.submitted_by_email &&
    req.submitted_by_email.toLowerCase() !== (req.user_email || '').toLowerCase()

  return (
    <div className="px-5 py-4">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-surface-100 flex items-center justify-center flex-shrink-0">
            <User size={13} className="text-surface-500" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-surface-900 truncate">{req.user_name || req.user_email}</p>
            <p className="text-[11px] text-surface-400 truncate">{req.user_email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {isOnBehalf && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700"
              title={`Submitted by ${req.submitted_by_name || req.submitted_by_email}`}
            >
              <Users size={10} aria-hidden="true" />
              By Instructor
            </span>
          )}
          <StatusBadge status={req.status} />
          <DeductionBadge deduction={req.deduction_status} />
          <span className="text-[10px] text-surface-400" title={req.created_at}>{timeAgo(req.created_at)}</span>
        </div>
      </div>

      {/* Details */}
      <div className="ml-9 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-600">
          {(req.course_id || req.class_id) && (
            <span className="flex items-center gap-1">
              <FileText size={11} className="text-surface-400" aria-hidden="true" />
              {req.course_id || req.class_id}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Calendar size={11} className="text-surface-400" aria-hidden="true" />
            {formatDate(req.absence_date)}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={11} className="text-surface-400" aria-hidden="true" />
            {formatHours(req.hours_missed)} missed
          </span>
          <span className="text-surface-400">{formatWeekLabel(req.week_start)}</span>
        </div>

        <div className="bg-surface-50 rounded-lg px-3 py-2 text-xs text-surface-600 border border-surface-100">
          <span className="font-medium text-surface-500">Reason: </span>{req.reason}
        </div>
        <div className="bg-surface-50 rounded-lg px-3 py-2 text-xs text-surface-600 border border-surface-100">
          <span className="font-medium text-surface-500">Make-up plan: </span>{req.makeup_plan}
        </div>

        {req.status === 'Rejected' && req.rejection_reason && (
          <div className="bg-red-50 rounded-lg px-3 py-2 text-xs text-red-700 border border-red-100">
            <span className="font-medium">Rejected: </span>{req.rejection_reason}
          </div>
        )}
        {req.status === 'Approved' && req.review_notes && (
          <div className="bg-green-50 rounded-lg px-3 py-2 text-xs text-green-800 border border-green-100">
            <span className="font-medium">Instructor notes: </span>{req.review_notes}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-[10px] text-surface-400">{req.request_id}</p>
          {req.reviewed_by && (
            <p className="text-[10px] text-surface-400">Reviewed by {req.reviewed_by}</p>
          )}
          {req.makeup_complete && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700">
              <ClipboardCheck size={11} aria-hidden="true" />
              Make-up complete
              {req.makeup_complete_by ? ` (${req.makeup_complete_by})` : ''}
            </span>
          )}
        </div>

        {/* Reviewer actions */}
        {isReviewer && req.status === 'Pending' && (
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => onApprove(req)}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                bg-green-600 text-white rounded-lg hover:bg-green-700 active:bg-green-800
                disabled:opacity-50 disabled:cursor-not-allowed shadow-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
              aria-label={`Approve request ${req.request_id}`}
            >
              <CheckCircle2 size={12} aria-hidden="true" />
              Approve
            </button>
            <button
              onClick={() => onReject(req)}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                bg-white text-red-600 border border-red-200 rounded-lg hover:bg-red-50 active:bg-red-100
                disabled:opacity-50 disabled:cursor-not-allowed
                focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
              aria-label={`Reject request ${req.request_id}`}
            >
              <XCircle size={12} aria-hidden="true" />
              Reject
            </button>
          </div>
        )}

        {/* Make-up complete checkbox (Approved rows, instructors with perm) */}
        {canMarkMakeup && req.status === 'Approved' && (
          <label className="inline-flex items-center gap-2 pt-1 cursor-pointer text-xs text-surface-700">
            <input
              type="checkbox"
              checked={!!req.makeup_complete}
              onChange={e => onToggleMakeup(req, e.target.checked)}
              disabled={saving}
              className="w-4 h-4 rounded border-surface-300 text-brand-600
                focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Mark make-up complete for ${req.request_id}`}
            />
            <span className="font-medium">Make-up complete</span>
          </label>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function AbsenceRequestPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Absence Requests')

  const {
    requests, loading, saving,
    submitRequest, approveRequest, rejectRequest, toggleMakeupComplete,
  } = useAbsenceRequests({ enabled: true })

  const isReviewer = hasPerm('review_requests')
  const canSubmit = hasPerm('submit_request')
  const canSubmitOnBehalf = hasPerm('submit_on_behalf')
  const canMarkMakeup = hasPerm('mark_makeup_complete')

  // ── UI state ────────────────────────────────────────────────────────────────
  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [approveTarget, setApproveTarget] = useState(null)
  const [rejectTarget, setRejectTarget] = useState(null)

  // Instructor filters
  const [statusFilter, setStatusFilter] = useState('Pending')
  const [weekFilter, setWeekFilter] = useState('All')
  const [searchTerm, setSearchTerm] = useState('')

  // ── Derived data ────────────────────────────────────────────────────────────
  const myEmail = (profile?.email || '').toLowerCase()

  const myRequests = useMemo(
    () => requests.filter(r => (r.user_email || '').toLowerCase() === myEmail),
    [requests, myEmail]
  )

  const weekOptions = useMemo(() => {
    const weeks = [...new Set(requests.map(r => r.week_start).filter(Boolean))]
    weeks.sort((a, b) => (a < b ? 1 : -1)) // newest first
    return weeks
  }, [requests])

  const filteredRequests = useMemo(() => {
    if (!isReviewer) return []
    const term = searchTerm.trim().toLowerCase()
    return requests.filter(r => {
      if (statusFilter !== 'All' && r.status !== statusFilter) return false
      if (weekFilter !== 'All' && r.week_start !== weekFilter) return false
      if (term) {
        const hay = `${r.user_name || ''} ${r.user_email || ''} ${r.course_id || ''} ${r.class_id || ''} ${r.request_id || ''}`.toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [requests, isReviewer, statusFilter, weekFilter, searchTerm])

  const pendingCount = useMemo(() => requests.filter(r => r.status === 'Pending').length, [requests])

  // ── Action handlers ─────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (payload) => {
    const result = await submitRequest(payload)
    if (result?.success) toast.success(`Absence request ${result.requestId} submitted`)
    return result
  }, [submitRequest])

  const handleApproveConfirm = useCallback(async (deduction, notes) => {
    const result = await approveRequest(approveTarget, deduction, notes)
    if (result?.success) toast.success(`Request ${approveTarget.request_id} approved`)
    return result
  }, [approveRequest, approveTarget])

  const handleRejectConfirm = useCallback(async (reason) => {
    const result = await rejectRequest(rejectTarget, reason)
    if (!result?.success) throw new Error(result?.message || 'Rejection failed')
    toast.success(`Request ${rejectTarget.request_id} rejected`)
    setRejectTarget(null)
  }, [rejectRequest, rejectTarget])

  const handleToggleMakeup = useCallback(async (req, value) => {
    const result = await toggleMakeupComplete(req, value)
    if (result?.success) {
      toast.success(value ? 'Marked make-up complete' : 'Make-up complete cleared')
    } else {
      toast.error(result?.message || 'Update failed')
    }
  }, [toggleMakeupComplete])

  // ── Permission gate ─────────────────────────────────────────────────────────
  if (permsLoading) {
    return (
      <div className="p-4 lg:p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-center gap-2 text-surface-400 text-sm py-20">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading…
        </div>
      </div>
    )
  }

  if (!hasPerm('view_page')) {
    return (
      <div className="p-4 lg:p-6 max-w-5xl mx-auto">
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-12 text-center">
          <AlertTriangle size={24} className="text-amber-500 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm font-medium text-surface-700">You don't have access to this page.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto space-y-5">
      {/* ── Page header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
            <CalendarOff size={20} className="text-brand-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Absence Request</h1>
            <p className="text-xs text-surface-400">
              Notify of a missed lab with a make-up plan — Program Policy Section 4
            </p>
          </div>
        </div>
        {canSubmit && (
          <button
            onClick={() => setShowSubmitModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium bg-brand-600 text-white
              rounded-lg hover:bg-brand-700 active:bg-brand-800 shadow-sm min-h-[44px]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <Plus size={16} aria-hidden="true" />
            Submit Absence Request
          </button>
        )}
      </div>

      {/* ── Policy banner ── */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-800">
        <Info size={15} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          Notify before the missed lab time, or within 24 hours after (Section 4.1). If approved, make-up hours
          are completed during the first two lab days of the following week (Section 4.2) — sign up and punch
          like any other hours. Approval sets the assignment outcome: 20% deduction, or waived for
          institutional excused absences (Section 4.3).
        </p>
      </div>

      {/* ══ INSTRUCTOR REVIEW VIEW ══ */}
      {isReviewer && (
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
          {/* Header + filters */}
          <div className="px-5 py-4 border-b border-surface-100 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                  <MessageSquareText size={16} className="text-amber-600" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="font-semibold text-surface-900">All Absence Requests</h2>
                  <p className="text-xs text-surface-400">
                    {pendingCount} pending review
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Status filter */}
              <label htmlFor="filter-status" className="sr-only">Filter by status</label>
              <select
                id="filter-status"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="px-3 py-2 border border-surface-200 rounded-lg text-xs bg-white min-h-[44px] sm:min-h-0
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <option value="Pending">Pending</option>
                <option value="Approved">Approved</option>
                <option value="Rejected">Rejected</option>
                <option value="All">All Statuses</option>
              </select>

              {/* Week filter — the grading lookup */}
              <label htmlFor="filter-week" className="sr-only">Filter by week</label>
              <select
                id="filter-week"
                value={weekFilter}
                onChange={e => setWeekFilter(e.target.value)}
                className="px-3 py-2 border border-surface-200 rounded-lg text-xs bg-white min-h-[44px] sm:min-h-0
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <option value="All">All Weeks</option>
                {weekOptions.map(w => (
                  <option key={w} value={w}>{formatWeekLabel(w)}</option>
                ))}
              </select>

              {/* Search */}
              <div className="relative flex-1 min-w-[180px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
                <label htmlFor="filter-search" className="sr-only">Search by student, class, or request ID</label>
                <input
                  id="filter-search"
                  type="search"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search student, class, or ID…"
                  className="w-full pl-9 pr-3 py-2 border border-surface-200 rounded-lg text-xs min-h-[44px] sm:min-h-0
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                />
              </div>
            </div>

            {/* Screen-reader result announcement */}
            <p role="status" aria-live="polite" className="sr-only">
              {filteredRequests.length} request{filteredRequests.length !== 1 ? 's' : ''} shown
            </p>
          </div>

          {/* Results */}
          {loading ? (
            <div className="p-12 flex items-center justify-center gap-2 text-surface-400 text-sm">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading requests…
            </div>
          ) : filteredRequests.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                <Inbox size={20} className="text-green-600" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-surface-700">No matching requests</p>
              <p className="text-xs text-surface-400 mt-1">
                {statusFilter === 'Pending' ? 'All absence requests have been reviewed.' : 'Try adjusting the filters.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-surface-100">
              {filteredRequests.map(req => (
                <RequestCard
                  key={req.request_id}
                  req={req}
                  isReviewer
                  canMarkMakeup={canMarkMakeup}
                  saving={saving}
                  onApprove={setApproveTarget}
                  onReject={setRejectTarget}
                  onToggleMakeup={handleToggleMakeup}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ MY REQUESTS (students; also shown to instructors who have own rows) ══ */}
      {(!isReviewer || myRequests.length > 0) && (
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-surface-100 flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-100 flex items-center justify-center">
              <CalendarCheck2 size={16} className="text-brand-600" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-semibold text-surface-900">My Requests</h2>
              <p className="text-xs text-surface-400">
                {myRequests.length} request{myRequests.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="p-12 flex items-center justify-center gap-2 text-surface-400 text-sm">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading…
            </div>
          ) : myRequests.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-12 h-12 rounded-full bg-surface-100 flex items-center justify-center mx-auto mb-3">
                <Inbox size={20} className="text-surface-400" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-surface-700">No absence requests yet</p>
              <p className="text-xs text-surface-400 mt-1">
                If you need to miss a scheduled lab, submit a request with your make-up plan.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-surface-100">
              {myRequests.map(req => (
                <RequestCard
                  key={req.request_id}
                  req={req}
                  isReviewer={false}
                  canMarkMakeup={false}
                  saving={saving}
                  onApprove={() => {}}
                  onReject={() => {}}
                  onToggleMakeup={() => {}}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      <SubmitAbsenceModal
        open={showSubmitModal}
        onClose={() => setShowSubmitModal(false)}
        onSubmit={handleSubmit}
        saving={saving}
        canSubmitOnBehalf={canSubmitOnBehalf}
        profile={profile}
      />

      <ApproveAbsenceModal
        open={!!approveTarget}
        request={approveTarget}
        onClose={() => setApproveTarget(null)}
        onConfirm={handleApproveConfirm}
        saving={saving}
      />

      <RejectionModal
        open={!!rejectTarget}
        title="Reject Absence Request"
        subtitle={rejectTarget
          ? `${rejectTarget.user_name || rejectTarget.user_email} — absence on ${formatDate(rejectTarget.absence_date)}`
          : ''
        }
        requestType="Absence Request"
        requestId={rejectTarget?.request_id || ''}
        recipientEmail={rejectTarget?.user_email || ''}
        recipientName={rejectTarget?.user_name || ''}
        onConfirm={handleRejectConfirm}
        onClose={() => setRejectTarget(null)}
      />
    </div>
  )
}
