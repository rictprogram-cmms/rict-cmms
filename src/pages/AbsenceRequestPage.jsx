/**
 * RICT CMMS — Absence & Late Submission Request Page
 *
 * Implements the manual tracking workflow for Program Policy Section 4.1–4.3
 * and 5.2. One page, two request types:
 *
 *   Absence          — student notifies of missed lab time WITH a make-up plan
 *   Late Submission  — student reports work turned in late: which assignment,
 *                      original due date, when it was submitted, why, their
 *                      plan, and optionally extra lab time (added to the
 *                      following week exactly like absence make-up hours)
 *
 * Instructors approve (choosing "20% Deduction" or "Waived" AND setting a new
 * due date/time for the missed/late work — default: second open lab day of
 * the following week at lab end time) or reject, then later check off
 * "Make-up complete" (lab hours) and "Work received" (the assignment). Work
 * not received by the new due date shows "Past due — score 0" (derived from
 * the timestamps, never stored; ticking Work received later accepts it).
 *
 * Student / Work Study view:
 *   - "Submit Request" button → modal (type toggle, class, dates, hours,
 *     reason, plan; late adds assignment + original due date)
 *   - List of their own requests with status, deduction, and due outcome
 *
 * Instructor view (permission-gated):
 *   - Filters: status, type, semester, week, student search
 *   - Approve → modal requiring the deduction decision + new due date
 *   - Reject → shared RejectionModal (reason required)
 *   - Make-up complete + Work received checkboxes on Approved rows
 *   - "Nth late this semester" chip on late-submission cards
 *   - Instructor-only follow-up notes per request (absence_request_notes,
 *     RLS-hidden from students)
 *   - "Submit on behalf" — student picker appears in the submit modal
 *     (urgent phone-call situations)
 *
 * Accessibility (WCAG 2.1 AA / Section 508):
 *   - useDialogA11y on every modal (focus trap, Escape, focus restore)
 *   - role="status" aria-live="polite" announcements for filter results and
 *     for the submit form switching between request types
 *   - Radio groups in fieldset/legend; every control labelled
 *   - Status / type / due outcome conveyed by text + icon, never color alone
 *   - aria-hidden on decorative icons; visible focus-visible rings; 44px
 *     targets on every button, checkbox row, and icon button
 *
 * File: src/pages/AbsenceRequestPage.jsx
 */

import { useState, useMemo, useCallback, useEffect, useId } from 'react'
import toast from 'react-hot-toast'
import {
  CalendarOff, CalendarCheck2, Plus, Loader2, Inbox, Info, User, Users,
  Calendar, Clock, FileText, CheckCircle2, XCircle, AlertTriangle,
  Search, X, ClipboardCheck, MessageSquareText, Trash2,
  CalendarClock, FileWarning, StickyNote, PackageCheck, Ban, BookOpen,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import RejectionModal from '@/components/RejectionModal'
import {
  useAbsenceRequests,
  useAbsenceRequestNotes,
  useAbsenceClasses,
  useAbsenceStudentOptions,
  mondayOf,
  makeupWeekOf,
  makeupPastClassEnd,
  isLateSubmission,
  requestTypeLabel,
  workDueState,
  fakeUtcToLocalDate,
  formatDueAt,
  toDatetimeLocalValue,
  datetimeLocalToFakeUtc,
  ordinal,
} from '@/hooks/useAbsenceRequests'
import { isSuperAdminEmail } from '@/lib/superAdmin'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(String(dateStr).substring(0, 10) + 'T00:00:00')
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatWeekLabel(weekStartStr) {
  if (!weekStartStr) return '—'
  const d = new Date(weekStartStr + 'T00:00:00')
  if (isNaN(d.getTime())) return weekStartStr
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/**
 * Semester label for a date-only string, matching the classes-table naming
 * convention ("Spring 2026"). Derived from the date so every request gets a
 * semester even when no class was selected: Jan-Jun = Spring, Jul-Dec = Fall
 * (no summer term).
 */
function semesterOf(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  // RICT has no summer term: Jan–Jun = Spring, Jul–Dec = Fall. (Fall classes
  // start in August; a late-August absence must land in Fall, not "Summer".)
  const m = d.getMonth()
  const season = m <= 5 ? 'Spring' : 'Fall'
  return `${season} ${d.getFullYear()}`
}

// Sort key for "Season Year" labels — newest first when sorted descending.
function semesterSortKey(label) {
  if (!label) return 0
  const [season, year] = label.split(' ')
  const rank = season === 'Spring' ? 1 : season === 'Summer' ? 2 : 3
  return (parseInt(year, 10) || 0) * 10 + rank
}

function formatHours(h) {
  const n = Number(h) || 0
  if (n <= 0) return '—'
  return n % 1 === 0 ? `${n}h` : `${n.toFixed(2)}h`
}

/**
 * Make-up week note shared by the submit form, approve modal and request card.
 * Explains where the missed / requested hours land (following week, first two
 * lab days) or that they can't be made up because the class has ended
 * (Policy #5). `late` switches the wording from "missed" to "requested".
 */
function MakeupWeekNote({ weekStart, hours, classEndDate, courseLabel, id, late = false }) {
  const mk = makeupWeekOf(weekStart)
  const hrs = Number(hours) || 0
  if (!mk) return null
  const pastEnd = makeupPastClassEnd(weekStart, classEndDate)
  const hrsText = hrs > 0
    ? `${hrs % 1 === 0 ? hrs : hrs.toFixed(2)} hour${hrs === 1 ? '' : 's'}`
    : (late ? 'The requested hours' : 'The missed hours')

  if (pastEnd) {
    return (
      <p id={id} role="note" className="flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5 mt-1">
        <AlertTriangle size={12} className="flex-shrink-0 mt-px" aria-hidden="true" />
        <span>
          Final week of {courseLabel || 'this class'} — the hours can't be {late ? 'added' : 'made up'} the following week and won't be added.
          {late ? '' : " The week's points are lost."}
        </span>
      </p>
    )
  }
  return (
    <p id={id} role="note" className="text-[11px] text-surface-500 mt-1">
      {late ? 'Lab time week' : 'Make-up week'}: <span className="font-medium text-surface-700">{formatWeekLabel(mk).replace('Week of ', '')}</span>
      {' '}— {hrsText} will be added to that week's required lab time (first two lab days).
    </p>
  )
}

function timeAgo(dateStr) {
  const local = fakeUtcToLocalDate(dateStr)
  if (!local) return ''
  const diff = Date.now() - local.getTime()
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

// ─── Badges (text + icon, never color alone) ─────────────────────────────────

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

function TypeBadge({ req }) {
  const late = isLateSubmission(req)
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
        late ? 'bg-violet-100 text-violet-800' : 'bg-surface-100 text-surface-700'
      }`}
      aria-label={`Type: ${late ? 'Late submission' : 'Absence'}`}
    >
      {late ? <FileWarning size={11} aria-hidden="true" /> : <CalendarOff size={11} aria-hidden="true" />}
      {late ? 'Late Submission' : 'Absence'}
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

/**
 * Due-date outcome for an Approved request (derived in workDueState):
 *   due       → "Work due <date time>"
 *   received  → "Work received"
 *   past_due  → "Past due — score 0"
 * Nothing is rendered for legacy rows without a new due date.
 */
function WorkDueBadge({ req }) {
  const state = workDueState(req)
  if (state === 'none') return null
  if (state === 'received') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800"
        aria-label={`Work received${req.work_received_by ? ` by ${req.work_received_by}` : ''}`}
      >
        <PackageCheck size={11} aria-hidden="true" />
        Work received
      </span>
    )
  }
  if (state === 'past_due') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-800"
        aria-label={`Past due — work not received by ${formatDueAt(req.new_due_at)}, score 0`}
      >
        <Ban size={11} aria-hidden="true" />
        Past due — score 0
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-800"
      aria-label={`Work due ${formatDueAt(req.new_due_at)}`}
    >
      <CalendarClock size={11} aria-hidden="true" />
      Due {formatDueAt(req.new_due_at)}
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMIT MODAL (Absence or Late Submission)
// ═══════════════════════════════════════════════════════════════════════════════

function SubmitRequestModal({ open, onClose, onSubmit, saving, canSubmitOnBehalf, profile }) {
  const [requestType, setRequestType] = useState('Absence')
  const [studentEmail, setStudentEmail] = useState('') // on-behalf target ('' = self)
  const [classChoice, setClassChoice] = useState('')   // value = `${class_id}|${course_id}`
  const [absenceDate, setAbsenceDate] = useState(todayStr()) // absence date, or date submitted (late)
  const [hoursMissed, setHoursMissed] = useState('')
  const [reason, setReason] = useState('')
  const [makeupPlan, setMakeupPlan] = useState('')
  // Late submission only
  const [assignmentName, setAssignmentName] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [needsLabTime, setNeedsLabTime] = useState('no') // 'no' | 'yes'
  const [formError, setFormError] = useState('')

  const late = isLateSubmission(requestType)

  const titleId = useId()
  const errId = useId()
  const typeGroupId = useId()
  const labTimeGroupId = useId()
  const classHelpId = useId()
  const makeupNoteId = useId()
  const dateHelpId = useId()
  const dialogRef = useDialogA11y(open, onClose)

  const { students, loading: studentsLoading } = useAbsenceStudentOptions({ enabled: open && canSubmitOnBehalf })

  // On-behalf: classes follow the SELECTED student's enrollment; self: own.
  const selectedStudent = useMemo(
    () => students.find(s => (s.email || '').toLowerCase() === studentEmail.toLowerCase()) || null,
    [students, studentEmail]
  )
  const classFilterProfile = canSubmitOnBehalf ? selectedStudent : profile
  const { classes, loading: classesLoading } = useAbsenceClasses(classFilterProfile)

  // Selected class (for its end_date / label in the make-up note)
  const selectedClass = useMemo(() => {
    if (!classChoice) return null
    const [cid] = classChoice.split('|')
    return classes.find(c => c.class_id === cid) || null
  }, [classChoice, classes])

  function resetForm() {
    setRequestType('Absence')
    setStudentEmail('')
    setClassChoice('')
    setAbsenceDate(todayStr())
    setHoursMissed('')
    setReason('')
    setMakeupPlan('')
    setAssignmentName('')
    setDueDate('')
    setNeedsLabTime('no')
    setFormError('')
  }

  // Effective hours: absences always use the field; late only when requested.
  const effectiveHours = late && needsLabTime !== 'yes' ? 0 : (parseFloat(hoursMissed) || 0)

  async function handleSubmit() {
    setFormError('')
    const noun = late ? 'late submission' : 'absence'

    if (canSubmitOnBehalf && !studentEmail) {
      setFormError(`Select the student this ${noun} is for.`)
      return
    }
    if (!classesLoading && classes.length === 0) {
      setFormError(`No classes are linked to this profile, so a ${noun} request can't be submitted. Contact your instructor.`)
      return
    }
    if (!classChoice) {
      setFormError(`Select the class this ${noun} is for — submit one request per class.`)
      return
    }
    if (late) {
      if (!assignmentName.trim()) {
        setFormError('Enter the name of the assignment that was late.')
        return
      }
      if (!dueDate) {
        setFormError('Select the original due date.')
        return
      }
      if (!absenceDate) {
        setFormError('Select the date the work was submitted.')
        return
      }
      if (absenceDate > todayStr()) {
        setFormError('The date submitted can\'t be in the future.')
        return
      }
      if (absenceDate < dueDate) {
        setFormError('The date submitted is before the original due date — this work wasn\'t late.')
        return
      }
      if (needsLabTime === 'yes' && !(Number(hoursMissed) > 0)) {
        setFormError('Enter the additional lab hours needed (greater than 0), or choose "No".')
        return
      }
    } else {
      if (!absenceDate) {
        setFormError('Select the date of the absence.')
        return
      }
      if (!(Number(hoursMissed) > 0)) {
        setFormError('Enter the hours missed (greater than 0) — they\'re added to next week\'s required lab time.')
        return
      }
    }
    if (!reason.trim()) {
      setFormError(late ? 'Explain why the work was late.' : 'A reason is required.')
      return
    }
    if (!makeupPlan.trim()) {
      setFormError(late
        ? 'A plan is required — how will you stay on schedule going forward?'
        : 'A make-up plan is required — when will the hours be made up?')
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
      requestType,
      classId,
      courseId,
      absenceDate,
      hoursMissed: effectiveHours,
      reason,
      makeupPlan,
      assignmentName: late ? assignmentName : '',
      dueDate: late ? dueDate : '',
    })

    if (result?.success) {
      resetForm()
      onClose()
    } else {
      setFormError(result?.message || 'Submission failed. Please try again.')
    }
  }

  if (!open) return null

  const typeOptionClass = (checked) =>
    `flex items-start gap-2.5 p-3 border rounded-lg cursor-pointer min-h-[44px] hover:bg-surface-50 ${
      checked ? 'border-brand-500 bg-brand-50' : 'border-surface-200'
    }`

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
              {late
                ? <FileWarning size={16} className="text-brand-600" aria-hidden="true" />
                : <CalendarOff size={16} className="text-brand-600" aria-hidden="true" />}
            </div>
            <h2 id={titleId} className="font-semibold text-surface-900">
              {late ? 'Report a Late Submission' : 'Submit Absence Request'}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-2 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Request type */}
          <fieldset>
            <legend id={typeGroupId} className="block text-xs font-semibold text-surface-700 mb-2">
              What are you reporting? <span className="text-red-600" aria-hidden="true">*</span>
            </legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={typeGroupId}>
              <label className={typeOptionClass(!late)}>
                <input
                  type="radio"
                  name="request-type"
                  value="Absence"
                  checked={!late}
                  onChange={() => { setRequestType('Absence'); setFormError('') }}
                  disabled={saving}
                  className="mt-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
                />
                <span>
                  <span className="block text-sm font-medium text-surface-900">Absence</span>
                  <span className="block text-[11px] text-surface-500">Missed / will miss lab time</span>
                </span>
              </label>
              <label className={typeOptionClass(late)}>
                <input
                  type="radio"
                  name="request-type"
                  value="Late Submission"
                  checked={late}
                  onChange={() => { setRequestType('Late Submission'); setFormError('') }}
                  disabled={saving}
                  className="mt-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
                />
                <span>
                  <span className="block text-sm font-medium text-surface-900">Late Submission</span>
                  <span className="block text-[11px] text-surface-500">Work turned in after the due date</span>
                </span>
              </label>
            </div>
            {/* Announce the form change to screen-reader users */}
            <p role="status" aria-live="polite" className="sr-only">
              {late
                ? 'Late submission form: assignment name, original due date, date submitted, optional lab time, reason, and plan.'
                : 'Absence form: date of absence, hours missed, reason, and make-up plan.'}
            </p>
          </fieldset>

          {/* Policy reminder */}
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 text-xs text-blue-800">
            <Info size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            {late ? (
              <p>
                Approved requests get a new due date (default: the second lab day of the following week at lab close).
                Work not received by that date scores 0. A 20% deduction applies unless your instructor waives it (Section 5.2).
                Submitting does not guarantee approval.
              </p>
            ) : (
              <p>
                Per program policy Section 4.1, notify before the missed lab time or within 24 hours after.
                Approval is required for the make-up window (first two lab days of the following week).
                Missed work gets a new due date on approval; work not received by then scores 0.
                Submitting does not guarantee approval.
              </p>
            )}
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
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white min-h-[44px]
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
              Class <span className="text-red-600" aria-hidden="true">*</span>
            </label>
            <select
              id="abs-class"
              value={classChoice}
              onChange={e => setClassChoice(e.target.value)}
              disabled={saving || classesLoading}
              required
              aria-required="true"
              aria-describedby={classHelpId}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white min-h-[44px]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">{classesLoading ? 'Loading classes…' : 'Select a class…'}</option>
              {classes.map(c => (
                <option key={c.class_id} value={`${c.class_id}|${c.course_id}`}>
                  {c.course_id} — {c.course_name}
                </option>
              ))}
            </select>
            <p id={classHelpId} className="text-[11px] text-surface-500 mt-1">
              {!classesLoading && classes.length === 0
                ? 'No classes are linked to this profile. Contact your instructor before submitting.'
                : late
                  ? 'More than one late assignment? Submit a separate request for each one.'
                  : 'Missed more than one class? Submit a separate request for each class.'}
            </p>
          </div>

          {/* ── LATE SUBMISSION fields ── */}
          {late && (
            <>
              <div>
                <label htmlFor="abs-assignment" className="block text-xs font-semibold text-surface-700 mb-1">
                  Assignment <span className="text-red-600" aria-hidden="true">*</span>
                </label>
                <input
                  id="abs-assignment"
                  type="text"
                  value={assignmentName}
                  onChange={e => setAssignmentName(e.target.value)}
                  disabled={saving}
                  required
                  aria-required="true"
                  maxLength={120}
                  placeholder="e.g. Lab 4 — Motor Control Report"
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="abs-due" className="block text-xs font-semibold text-surface-700 mb-1">
                    Original Due Date <span className="text-red-600" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="abs-due"
                    type="date"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                    disabled={saving}
                    required
                    aria-required="true"
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  />
                </div>
                <div>
                  <label htmlFor="abs-date" className="block text-xs font-semibold text-surface-700 mb-1">
                    Date Submitted <span className="text-red-600" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="abs-date"
                    type="date"
                    value={absenceDate}
                    max={todayStr()}
                    onChange={e => setAbsenceDate(e.target.value)}
                    disabled={saving}
                    required
                    aria-required="true"
                    aria-describedby={dateHelpId}
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  />
                  <p id={dateHelpId} className="text-[11px] text-surface-400 mt-1">
                    {absenceDate ? formatWeekLabel(mondayOf(absenceDate)) : 'When you turned it in'}
                  </p>
                </div>
              </div>

              {/* Extra lab time? */}
              <fieldset>
                <legend id={labTimeGroupId} className="block text-xs font-semibold text-surface-700 mb-2">
                  Do you need additional lab time? <span className="text-red-600" aria-hidden="true">*</span>
                </legend>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={labTimeGroupId}>
                  <label className={typeOptionClass(needsLabTime === 'no')}>
                    <input
                      type="radio"
                      name="needs-lab-time"
                      value="no"
                      checked={needsLabTime === 'no'}
                      onChange={() => { setNeedsLabTime('no'); setHoursMissed('') }}
                      disabled={saving}
                      className="mt-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    <span className="text-sm font-medium text-surface-900">No</span>
                  </label>
                  <label className={typeOptionClass(needsLabTime === 'yes')}>
                    <input
                      type="radio"
                      name="needs-lab-time"
                      value="yes"
                      checked={needsLabTime === 'yes'}
                      onChange={() => setNeedsLabTime('yes')}
                      disabled={saving}
                      className="mt-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    <span className="text-sm font-medium text-surface-900">Yes</span>
                  </label>
                </div>
                {needsLabTime === 'yes' && (
                  <div className="mt-2">
                    <label htmlFor="abs-hours" className="block text-xs font-semibold text-surface-700 mb-1">
                      Additional Lab Hours <span className="text-red-600" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="abs-hours"
                      type="number"
                      inputMode="decimal"
                      min="0.25"
                      max="24"
                      step="0.25"
                      value={hoursMissed}
                      onChange={e => setHoursMissed(e.target.value)}
                      disabled={saving}
                      required
                      aria-required="true"
                      aria-describedby={makeupNoteId}
                      placeholder="e.g. 2"
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    {absenceDate && (
                      <MakeupWeekNote
                        id={makeupNoteId}
                        weekStart={mondayOf(absenceDate)}
                        hours={hoursMissed}
                        classEndDate={selectedClass?.end_date}
                        courseLabel={selectedClass?.course_id}
                        late
                      />
                    )}
                  </div>
                )}
              </fieldset>
            </>
          )}

          {/* ── ABSENCE fields ── */}
          {!late && (
            <>
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
                    aria-required="true"
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  />
                  {absenceDate && (
                    <p className="text-[11px] text-surface-400 mt-1">{formatWeekLabel(mondayOf(absenceDate))}</p>
                  )}
                </div>
                <div>
                  <label htmlFor="abs-hours" className="block text-xs font-semibold text-surface-700 mb-1">
                    Hours Missed <span className="text-red-600" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="abs-hours"
                    type="number"
                    inputMode="decimal"
                    min="0.25"
                    max="24"
                    step="0.25"
                    value={hoursMissed}
                    onChange={e => setHoursMissed(e.target.value)}
                    disabled={saving}
                    required
                    aria-required="true"
                    aria-describedby={makeupNoteId}
                    placeholder="e.g. 4"
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  />
                </div>
              </div>
              {absenceDate && (
                <MakeupWeekNote
                  id={makeupNoteId}
                  weekStart={mondayOf(absenceDate)}
                  hours={hoursMissed}
                  classEndDate={selectedClass?.end_date}
                  courseLabel={selectedClass?.course_id}
                />
              )}
            </>
          )}

          {/* Reason */}
          <div>
            <label htmlFor="abs-reason" className="block text-xs font-semibold text-surface-700 mb-1">
              {late ? 'Why was it late?' : 'Reason'} <span className="text-red-600" aria-hidden="true">*</span>
            </label>
            <textarea
              id="abs-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={saving}
              rows={2}
              required
              aria-required="true"
              placeholder={late
                ? 'What kept you from turning it in on time?'
                : 'Why will/did you miss the scheduled lab time?'}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-y
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>

          {/* Plan */}
          <div>
            <label htmlFor="abs-plan" className="block text-xs font-semibold text-surface-700 mb-1">
              {late ? 'Your Plan' : 'Make-Up Plan'} <span className="text-red-600" aria-hidden="true">*</span>
            </label>
            <textarea
              id="abs-plan"
              value={makeupPlan}
              onChange={e => setMakeupPlan(e.target.value)}
              disabled={saving}
              rows={2}
              required
              aria-required="true"
              placeholder={late
                ? 'How will you stay on schedule from here? e.g. Finish Lab 5 by Thursday; use Monday lab time to catch up'
                : 'When will you make up the hours? e.g. Monday and Tuesday, 8 AM to 12 PM'}
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
                focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 min-h-[44px]"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-brand-600 text-white
                rounded-lg hover:bg-brand-700 active:bg-brand-800 disabled:opacity-50 shadow-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 min-h-[44px]"
            >
              {saving
                ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                : late
                  ? <FileWarning size={14} aria-hidden="true" />
                  : <CalendarOff size={14} aria-hidden="true" />}
              Submit Request
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPROVE MODAL (deduction decision + new due date required)
// ═══════════════════════════════════════════════════════════════════════════════

function ApproveRequestModal({ open, request, onClose, onConfirm, saving, fetchDefaultDueAt }) {
  const [deduction, setDeduction] = useState('')
  const [notes, setNotes] = useState('')
  const [dueLocal, setDueLocal] = useState('')        // 'YYYY-MM-DDTHH:MM' for the input
  const [noWorkDue, setNoWorkDue] = useState(false)   // skip the due-date rule
  const [dueLoading, setDueLoading] = useState(false)
  const [formError, setFormError] = useState('')

  const titleId = useId()
  const groupId = useId()
  const makeupNoteId = useId()
  const dueHelpId = useId()
  const dialogRef = useDialogA11y(open, onClose)

  const late = isLateSubmission(request)

  // Class end_date drives the "final week — can't be made up" note
  const { classes: allClasses } = useAbsenceClasses(null)
  const reqClass = useMemo(() => {
    if (!request) return null
    return allClasses.find(c => c.class_id === request.class_id || c.course_id === request.course_id) || null
  }, [allClasses, request])

  // Pre-fill the new due date from the DB default (second open lab day of the
  // following week at lab end time) each time a request is opened.
  useEffect(() => {
    if (!open || !request?.week_start) return undefined
    let cancelled = false
    setDeduction('')
    setNotes('')
    setNoWorkDue(false)
    setFormError('')
    setDueLocal('')
    setDueLoading(true)
    fetchDefaultDueAt(request.week_start).then(ts => {
      if (cancelled) return
      setDueLocal(ts ? toDatetimeLocalValue(ts) : '')
      setDueLoading(false)
    })
    return () => { cancelled = true }
  }, [open, request?.request_id, request?.week_start, fetchDefaultDueAt])

  async function handleConfirm() {
    setFormError('')
    if (!deduction) {
      setFormError('Choose the deduction outcome before approving.')
      return
    }
    let newDueAt = null
    if (!noWorkDue) {
      newDueAt = datetimeLocalToFakeUtc(dueLocal)
      if (!newDueAt) {
        setFormError('Enter the new due date and time, or tick "No work was due".')
        return
      }
    }
    // Pass the class end date along so the hook can word the notification correctly
    const result = await onConfirm(deduction, notes, reqClass?.end_date || null, newDueAt)
    if (result?.success) {
      setDeduction('')
      setNotes('')
      onClose()
    } else {
      setFormError(result?.message || 'Approval failed. Please try again.')
    }
  }

  if (!open || !request) return null

  const hrs = Number(request.hours_missed) || 0

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
        <div className="px-5 py-4 border-b border-surface-100 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
            <CheckCircle2 size={16} className="text-green-600" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="font-semibold text-surface-900">
              Approve {late ? 'Late Submission' : 'Absence'} Request
            </h2>
            <p className="text-xs text-surface-400">
              {request.user_name} — {late
                ? `"${request.assignment_name}" submitted ${formatDate(request.absence_date)}`
                : formatDate(request.absence_date)} ({request.request_id})
            </p>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Summary + where the lab hours land */}
          <div className="bg-surface-50 border border-surface-100 rounded-lg px-3 py-2 text-xs text-surface-600">
            {late ? (
              <>
                <span className="font-medium text-surface-700">Originally due {formatDate(request.due_date)}</span>
                {' '}· {request.course_id || request.class_id || 'No class'}
                {hrs > 0 ? ` · ${formatHours(hrs)} lab time requested` : ' · no extra lab time'}
              </>
            ) : (
              <>
                <span className="font-medium text-surface-700">{formatHours(hrs)} missed</span>
                {' '}· {request.course_id || request.class_id || 'No class'} · {formatWeekLabel(request.week_start)}
              </>
            )}
            {hrs > 0 && (
              <MakeupWeekNote
                id={makeupNoteId}
                weekStart={request.week_start}
                hours={hrs}
                classEndDate={reqClass?.end_date}
                courseLabel={request.course_id || request.class_id}
                late={late}
              />
            )}
          </div>

          {/* Deduction decision */}
          <fieldset>
            <legend id={groupId} className="block text-xs font-semibold text-surface-700 mb-2">
              Assignment Deduction (Policy Section 4.2 / 4.3 / 5.2) <span className="text-red-600" aria-hidden="true">*</span>
            </legend>
            <div className="space-y-2" role="radiogroup" aria-labelledby={groupId}>
              <label className="flex items-start gap-2.5 p-3 border border-surface-200 rounded-lg cursor-pointer min-h-[44px]
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
                    {late ? 'Late work' : 'Instructor-approved make-up'} — assignment max score 80% (Section 5.2)
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 p-3 border border-surface-200 rounded-lg cursor-pointer min-h-[44px]
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
                    Qualifying Section 4.3 event (closure, documented medical, military, jury duty, bereavement…)
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {/* New due date */}
          <div>
            <label htmlFor="approve-due" className="block text-xs font-semibold text-surface-700 mb-1">
              New Due Date &amp; Time for the {late ? 'Late' : 'Missed'} Work
              {!noWorkDue && <span className="text-red-600" aria-hidden="true"> *</span>}
            </label>
            <div className="relative">
              <input
                id="approve-due"
                type="datetime-local"
                value={dueLocal}
                onChange={e => setDueLocal(e.target.value)}
                disabled={saving || noWorkDue || dueLoading}
                required={!noWorkDue}
                aria-required={!noWorkDue}
                aria-describedby={dueHelpId}
                aria-busy={dueLoading}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm min-h-[44px]
                  disabled:bg-surface-50 disabled:text-surface-400
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              {dueLoading && (
                <Loader2 size={14} className="animate-spin absolute right-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
              )}
            </div>
            <p id={dueHelpId} className="text-[11px] text-surface-500 mt-1">
              {dueLoading
                ? 'Loading the default due date…'
                : 'Default: second lab day of the following week at lab close. Work not received by this time scores 0 — extend it here for longer situations (e.g. military).'}
            </p>
            <label className="inline-flex items-center gap-2 mt-2 cursor-pointer text-xs text-surface-700 min-h-[44px]">
              <input
                type="checkbox"
                checked={noWorkDue}
                onChange={e => setNoWorkDue(e.target.checked)}
                disabled={saving}
                className="w-4 h-4 rounded border-surface-300 text-brand-600
                  focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              <span>No work was due — skip the due-date rule</span>
            </label>
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="approve-notes" className="block text-xs font-semibold text-surface-700 mb-1">
              Review Notes (optional — shown to the student)
            </label>
            <textarea
              id="approve-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={saving}
              rows={2}
              placeholder={late
                ? 'e.g. Accepted; resubmit through D2L by the new due date'
                : 'e.g. Documentation received; make up Mon/Tue next week'}
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
                focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 min-h-[44px]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={saving || dueLoading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-green-600 text-white
                rounded-lg hover:bg-green-700 active:bg-green-800 disabled:opacity-50 shadow-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 min-h-[44px]"
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
// DELETE CONFIRM MODAL (super admin only — test cleanup)
// ═══════════════════════════════════════════════════════════════════════════════

function DeleteConfirmModal({ open, request, onClose, onConfirm, saving }) {
  const titleId = useId()
  const dialogRef = useDialogA11y(open, onClose)

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
        className="bg-white rounded-xl w-full max-w-sm shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-100 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
            <Trash2 size={16} className="text-red-600" aria-hidden="true" />
          </div>
          <h2 id={titleId} className="font-semibold text-surface-900">
            Delete {requestTypeLabel(request, { capitalize: true })} Request
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-surface-600">
            Permanently delete <span className="font-semibold">{request.request_id}</span> for{' '}
            <span className="font-semibold">{request.user_name || request.user_email}</span>{' '}
            ({formatDate(request.absence_date)})? This cannot be undone. The deletion is recorded
            in the audit log.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-surface-600 rounded-lg hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 min-h-[44px]"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-600 text-white
                rounded-lg hover:bg-red-700 active:bg-red-800 disabled:opacity-50 shadow-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 min-h-[44px]"
            >
              {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTRUCTOR NOTES (per request; hidden from students by RLS)
// ═══════════════════════════════════════════════════════════════════════════════

function InstructorNotes({ req, notes, saving, onAdd, onDelete }) {
  const [openPanel, setOpenPanel] = useState(false)
  const [text, setText] = useState('')
  const panelId = useId()
  const inputId = useId()
  const count = notes.length

  async function handleAdd() {
    if (!text.trim()) return
    const ok = await onAdd(req, text)
    if (ok) setText('')
  }

  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setOpenPanel(o => !o)}
        aria-expanded={openPanel}
        aria-controls={panelId}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-surface-600 rounded-lg
          hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 min-h-[44px]"
      >
        <StickyNote size={12} aria-hidden="true" />
        Instructor notes{count > 0 ? ` (${count})` : ''}
        <span className="sr-only">, instructors only</span>
      </button>

      {openPanel && (
        <div id={panelId} className="mt-1 space-y-2 bg-amber-50/60 border border-amber-100 rounded-lg p-3">
          <p className="text-[11px] text-amber-800">Visible to instructors only — never shown to the student.</p>
          {count === 0 ? (
            <p className="text-xs text-surface-500">No notes yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {notes.map(n => (
                <li key={n.note_id} className="flex items-start justify-between gap-2 text-xs text-surface-700 bg-white rounded-md border border-amber-100 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words">{n.note}</p>
                    <p className="text-[10px] text-surface-400 mt-0.5">
                      {n.created_by || 'Instructor'} · {timeAgo(n.created_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(n)}
                    disabled={saving}
                    className="p-1.5 rounded-lg text-surface-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                    aria-label={`Delete note by ${n.created_by || 'instructor'}`}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label htmlFor={inputId} className="sr-only">Add an instructor note for {req.request_id}</label>
            <textarea
              id={inputId}
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={saving}
              rows={2}
              maxLength={2000}
              placeholder="Follow-up note (e.g. spoke with student 9/8; D2L resubmission pending)"
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-xs resize-y bg-white
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            <div className="flex justify-end mt-1">
              <button
                type="button"
                onClick={handleAdd}
                disabled={saving || !text.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-600 text-white
                  rounded-lg hover:bg-brand-700 active:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 min-h-[44px]"
              >
                <Plus size={12} aria-hidden="true" />
                Add note
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST CARD (shared by student + instructor views)
// ═══════════════════════════════════════════════════════════════════════════════

function RequestCard({
  req, isReviewer, canMarkMakeup, canDelete, saving,
  onApprove, onReject, onToggleMakeup, onToggleWorkReceived, onDelete,
  classEndDate = null, lateOrdinal = null, notes = null, onAddNote, onDeleteNote,
}) {
  const late = isLateSubmission(req)
  const hrs = Number(req.hours_missed) || 0
  const isOnBehalf =
    req.submitted_by_email &&
    req.submitted_by_email.toLowerCase() !== (req.user_email || '').toLowerCase()
  const dueState = workDueState(req)

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
          <TypeBadge req={req} />
          {isOnBehalf && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700"
              title={`Submitted by ${req.submitted_by_name || req.submitted_by_email}`}
            >
              <Users size={10} aria-hidden="true" />
              By Instructor
            </span>
          )}
          {isReviewer && late && lateOrdinal && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-800"
              aria-label={`${ordinal(lateOrdinal)} late submission this semester for this student`}
              title="Late submissions by this student this semester (excluding rejected)"
            >
              <FileWarning size={10} aria-hidden="true" />
              {ordinal(lateOrdinal)} late this semester
            </span>
          )}
          <StatusBadge status={req.status} />
          <DeductionBadge deduction={req.deduction_status} />
          <WorkDueBadge req={req} />
          <span className="text-[10px] text-surface-400" title={req.created_at}>{timeAgo(req.created_at)}</span>
          {canDelete && (
            <button
              onClick={() => onDelete(req)}
              disabled={saving}
              className="p-1.5 rounded-lg text-surface-400 hover:text-red-600 hover:bg-red-50
                disabled:opacity-50 disabled:cursor-not-allowed
                focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
              aria-label={`Delete request ${req.request_id}`}
              title="Delete (super admin)"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Details */}
      <div className="ml-9 space-y-1.5">
        {late && (
          <div className="flex items-center gap-1.5 text-xs text-surface-800">
            <BookOpen size={12} className="text-surface-400 flex-shrink-0" aria-hidden="true" />
            <span className="font-medium">{req.assignment_name}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-600">
          {(req.course_id || req.class_id) && (
            <span className="flex items-center gap-1">
              <FileText size={11} className="text-surface-400" aria-hidden="true" />
              {req.course_id || req.class_id}
            </span>
          )}
          {late && (
            <span className="flex items-center gap-1">
              <CalendarClock size={11} className="text-surface-400" aria-hidden="true" />
              Due {formatDate(req.due_date)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Calendar size={11} className="text-surface-400" aria-hidden="true" />
            {late ? `Submitted ${formatDate(req.absence_date)}` : formatDate(req.absence_date)}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={11} className="text-surface-400" aria-hidden="true" />
            {late
              ? (hrs > 0 ? `${formatHours(hrs)} lab time requested` : 'No extra lab time')
              : `${formatHours(hrs)} missed`}
          </span>
          <span className="text-surface-400">{formatWeekLabel(req.week_start)}</span>
        </div>
        {req.status === 'Approved' && hrs > 0 && (
          <MakeupWeekNote
            weekStart={req.week_start}
            hours={hrs}
            classEndDate={classEndDate}
            courseLabel={req.course_id || req.class_id}
            late={late}
          />
        )}

        <div className="bg-surface-50 rounded-lg px-3 py-2 text-xs text-surface-600 border border-surface-100">
          <span className="font-medium text-surface-500">{late ? 'Why late: ' : 'Reason: '}</span>{req.reason}
        </div>
        <div className="bg-surface-50 rounded-lg px-3 py-2 text-xs text-surface-600 border border-surface-100">
          <span className="font-medium text-surface-500">{late ? 'Plan: ' : 'Make-up plan: '}</span>{req.makeup_plan}
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
        {dueState === 'past_due' && (
          <div className="flex items-start gap-1.5 bg-red-50 rounded-lg px-3 py-2 text-xs text-red-800 border border-red-100" role="note">
            <Ban size={12} className="flex-shrink-0 mt-px" aria-hidden="true" />
            <span>
              Work was due {formatDueAt(req.new_due_at)} and hasn't been marked received — this assignment scores 0.
              {isReviewer ? ' Tick "Work received" below if you choose to accept it.' : ''}
            </span>
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
              {late ? 'Lab time complete' : 'Make-up complete'}
              {req.makeup_complete_by ? ` (${req.makeup_complete_by})` : ''}
            </span>
          )}
          {req.work_received && req.work_received_by && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700">
              <PackageCheck size={11} aria-hidden="true" />
              Received ({req.work_received_by})
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
                focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 min-h-[44px]"
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
                focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 min-h-[44px]"
              aria-label={`Reject request ${req.request_id}`}
            >
              <XCircle size={12} aria-hidden="true" />
              Reject
            </button>
          </div>
        )}

        {/* Approved-row checkboxes (instructors) */}
        {req.status === 'Approved' && (canMarkMakeup || isReviewer) && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-0">
            {/* Make-up complete — lab hours (perm-gated); only meaningful with hours */}
            {canMarkMakeup && hrs > 0 && (
              <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-surface-700 min-h-[44px]">
                <input
                  type="checkbox"
                  checked={!!req.makeup_complete}
                  onChange={e => onToggleMakeup(req, e.target.checked)}
                  disabled={saving}
                  className="w-4 h-4 rounded border-surface-300 text-brand-600
                    focus-visible:ring-2 focus-visible:ring-brand-500"
                  aria-label={`Mark ${late ? 'lab time' : 'make-up'} complete for ${req.request_id}`}
                />
                <span className="font-medium">{late ? 'Lab time complete' : 'Make-up complete'}</span>
              </label>
            )}
            {/* Work received — the assignment (reviewers); shown whenever a due date exists */}
            {isReviewer && (req.new_due_at || req.work_received) && (
              <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-surface-700 min-h-[44px]">
                <input
                  type="checkbox"
                  checked={!!req.work_received}
                  onChange={e => onToggleWorkReceived(req, e.target.checked)}
                  disabled={saving}
                  className="w-4 h-4 rounded border-surface-300 text-brand-600
                    focus-visible:ring-2 focus-visible:ring-brand-500"
                  aria-label={`Mark work received for ${req.request_id}`}
                />
                <span className="font-medium">Work received</span>
              </label>
            )}
          </div>
        )}

        {/* Instructor follow-up notes (RLS-hidden from students) */}
        {isReviewer && notes && (
          <InstructorNotes
            req={req}
            notes={notes}
            saving={saving}
            onAdd={onAddNote}
            onDelete={onDeleteNote}
          />
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function AbsenceRequestPage() {
  const { profile, realProfile, isEmulating } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Absence Requests')

  const {
    requests, loading, saving,
    submitRequest, approveRequest, rejectRequest, toggleMakeupComplete, toggleWorkReceived,
    deleteRequest, fetchDefaultDueAt,
  } = useAbsenceRequests({ enabled: true })

  const isReviewer = hasPerm('review_requests')
  const canSubmit = hasPerm('submit_request')
  const canSubmitOnBehalf = hasPerm('submit_on_behalf')
  const canMarkMakeup = hasPerm('mark_makeup_complete')

  // Instructor follow-up notes — idle (and RLS-blocked anyway) for students
  const {
    notesByRequest, saving: notesSaving, addNote, deleteNote,
  } = useAbsenceRequestNotes({ enabled: isReviewer })

  // Class end dates (for the make-up week note on each card — Policy #5)
  const { classes: allClassesForCards } = useAbsenceClasses(null)
  const classEndById = useMemo(() => {
    const m = {}
    allClassesForCards.forEach(c => {
      if (c.course_id) m[c.course_id] = c.end_date || null
      if (c.class_id) m[c.class_id] = c.end_date || null
    })
    return m
  }, [allClassesForCards])
  const endDateFor = (req) => classEndById[req.course_id] ?? classEndById[req.class_id] ?? null

  // Delete is super-admin only (test cleanup). Checks the REAL account
  // (realProfile during emulation, profile otherwise) so an emulated user's
  // identity never grants it, and hides it while emulating so the emulated
  // view stays true to what that user would see.
  const isSuperAdmin =
    !isEmulating &&
    isSuperAdminEmail(realProfile?.email || profile?.email)

  // ── UI state ────────────────────────────────────────────────────────────────
  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [approveTarget, setApproveTarget] = useState(null)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  // Instructor filters
  const [statusFilter, setStatusFilter] = useState('All') // default: show every status
  const [typeFilter, setTypeFilter] = useState('All')     // 'All' | 'Absence' | 'Late Submission'
  const [semesterFilter, setSemesterFilter] = useState(() => semesterOf(todayStr()) || 'All')
  const [weekFilter, setWeekFilter] = useState('All')
  const [searchTerm, setSearchTerm] = useState('')

  // ── Derived data ────────────────────────────────────────────────────────────
  const myEmail = (profile?.email || '').toLowerCase()

  const myRequests = useMemo(
    () => requests.filter(r => (r.user_email || '').toLowerCase() === myEmail),
    [requests, myEmail]
  )

  // "Nth late this semester" — per student + semester, counting non-rejected
  // late submissions in submission order (instructors see every row via RLS).
  const lateOrdinalById = useMemo(() => {
    const groups = {}
    requests
      .filter(r => isLateSubmission(r) && r.status !== 'Rejected')
      .forEach(r => {
        const key = `${(r.user_email || '').toLowerCase()}|${semesterOf(r.absence_date) || ''}`
        if (!groups[key]) groups[key] = []
        groups[key].push(r)
      })
    const out = {}
    Object.values(groups).forEach(list => {
      list
        .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
        .forEach((r, i) => { out[r.request_id] = i + 1 })
    })
    return out
  }, [requests])

  // Semesters present in the data, plus the current one so the default
  // selection always exists even before any requests this term.
  const semesterOptions = useMemo(() => {
    const set = new Set(requests.map(r => semesterOf(r.absence_date)).filter(Boolean))
    const current = semesterOf(todayStr())
    if (current) set.add(current)
    return [...set].sort((a, b) => semesterSortKey(b) - semesterSortKey(a)) // newest first
  }, [requests])

  // Week dropdown scoped to the selected semester so it stays short.
  const weekOptions = useMemo(() => {
    const inSemester = semesterFilter === 'All'
      ? requests
      : requests.filter(r => semesterOf(r.absence_date) === semesterFilter)
    const weeks = [...new Set(inSemester.map(r => r.week_start).filter(Boolean))]
    weeks.sort((a, b) => (a < b ? 1 : -1)) // newest first
    return weeks
  }, [requests, semesterFilter])

  const filteredRequests = useMemo(() => {
    if (!isReviewer) return []
    const term = searchTerm.trim().toLowerCase()
    return requests.filter(r => {
      if (statusFilter !== 'All' && r.status !== statusFilter) return false
      if (typeFilter !== 'All' && (r.request_type || 'Absence') !== typeFilter) return false
      if (semesterFilter !== 'All' && semesterOf(r.absence_date) !== semesterFilter) return false
      if (weekFilter !== 'All' && r.week_start !== weekFilter) return false
      if (term) {
        const hay = `${r.user_name || ''} ${r.user_email || ''} ${r.course_id || ''} ${r.class_id || ''} ${r.request_id || ''} ${r.assignment_name || ''}`.toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [requests, isReviewer, statusFilter, typeFilter, semesterFilter, weekFilter, searchTerm])

  const pendingCount = useMemo(() => requests.filter(r => r.status === 'Pending').length, [requests])

  // ── Action handlers ─────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (payload) => {
    const result = await submitRequest(payload)
    if (result?.success) {
      toast.success(`${requestTypeLabel(payload.requestType, { capitalize: true })} request ${result.requestId} submitted`)
    }
    return result
  }, [submitRequest])

  const handleApproveConfirm = useCallback(async (deduction, notes, classEndDate = null, newDueAt = null) => {
    const result = await approveRequest({ ...approveTarget, class_end_date: classEndDate }, deduction, notes, newDueAt)
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

  const handleToggleWorkReceived = useCallback(async (req, value) => {
    const result = await toggleWorkReceived(req, value)
    if (result?.success) {
      toast.success(value ? 'Marked work received' : 'Work received cleared')
    } else {
      toast.error(result?.message || 'Update failed')
    }
  }, [toggleWorkReceived])

  const handleAddNote = useCallback(async (req, text) => {
    const result = await addNote(req, text)
    if (result?.success) {
      toast.success('Note added')
      return true
    }
    toast.error(result?.message || 'Note failed')
    return false
  }, [addNote])

  const handleDeleteNote = useCallback(async (note) => {
    const result = await deleteNote(note)
    if (result?.success) toast.success('Note deleted')
    else toast.error(result?.message || 'Delete failed')
  }, [deleteNote])

  const handleDeleteConfirm = useCallback(async () => {
    const result = await deleteRequest(deleteTarget)
    if (result?.success) {
      toast.success(`Request ${deleteTarget.request_id} deleted`)
      setDeleteTarget(null)
    } else {
      toast.error(result?.message || 'Delete failed')
    }
  }, [deleteRequest, deleteTarget])

  const anySaving = saving || notesSaving

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
            <h1 className="text-xl font-bold text-surface-900">Absence &amp; Late Submission Requests</h1>
            <p className="text-xs text-surface-400">
              Report a missed lab or late work with your plan — Program Policy Sections 4 and 5.2
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
            Submit Request
          </button>
        )}
      </div>

      {/* ── Policy banner ── */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-800">
        <Info size={15} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          <span className="font-semibold">Absences:</span> notify before the missed lab time, or within 24 hours after (Section 4.1).
          If approved, make-up hours are completed during the first two lab days of the following week (Section 4.2) — sign up and punch
          like any other hours.{' '}
          <span className="font-semibold">Late submissions:</span> report the assignment, why it was late, and your plan; request
          extra lab time if you need it.{' '}
          <span className="font-semibold">Both:</span> approval sets the assignment outcome — 20% deduction, or waived for institutional
          excused events (Section 4.3 / 5.2) — and a new due date (default: second lab day of the following week at lab close).
          Work not received by the new due date scores 0.
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
                  <h2 className="font-semibold text-surface-900">All Requests</h2>
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

              {/* Type filter */}
              <label htmlFor="filter-type" className="sr-only">Filter by request type</label>
              <select
                id="filter-type"
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value)}
                className="px-3 py-2 border border-surface-200 rounded-lg text-xs bg-white min-h-[44px] sm:min-h-0
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <option value="All">All Types</option>
                <option value="Absence">Absences</option>
                <option value="Late Submission">Late Submissions</option>
              </select>

              {/* Semester filter — keeps the list manageable across terms */}
              <label htmlFor="filter-semester" className="sr-only">Filter by semester</label>
              <select
                id="filter-semester"
                value={semesterFilter}
                onChange={e => { setSemesterFilter(e.target.value); setWeekFilter('All') }}
                className="px-3 py-2 border border-surface-200 rounded-lg text-xs bg-white min-h-[44px] sm:min-h-0
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {semesterOptions.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value="All">All Semesters</option>
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
                <label htmlFor="filter-search" className="sr-only">Search by student, class, assignment, or request ID</label>
                <input
                  id="filter-search"
                  type="search"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search student, class, assignment, or ID…"
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
                {statusFilter === 'Pending' ? 'All requests have been reviewed.' : 'Try adjusting the filters.'}
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
                  canDelete={isSuperAdmin}
                  saving={anySaving}
                  onApprove={setApproveTarget}
                  onReject={setRejectTarget}
                  onToggleMakeup={handleToggleMakeup}
                  onToggleWorkReceived={handleToggleWorkReceived}
                  onDelete={setDeleteTarget}
                  classEndDate={endDateFor(req)}
                  lateOrdinal={lateOrdinalById[req.request_id] || null}
                  notes={notesByRequest[req.request_id] || []}
                  onAddNote={handleAddNote}
                  onDeleteNote={handleDeleteNote}
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
              <p className="text-sm font-medium text-surface-700">No requests yet</p>
              <p className="text-xs text-surface-400 mt-1">
                If you need to miss a scheduled lab, or turned work in late, submit a request with your plan.
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
                  canDelete={isSuperAdmin}
                  saving={anySaving}
                  onApprove={() => {}}
                  onReject={() => {}}
                  onToggleMakeup={() => {}}
                  onToggleWorkReceived={() => {}}
                  onDelete={setDeleteTarget}
                  classEndDate={endDateFor(req)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      <SubmitRequestModal
        open={showSubmitModal}
        onClose={() => setShowSubmitModal(false)}
        onSubmit={handleSubmit}
        saving={saving}
        canSubmitOnBehalf={canSubmitOnBehalf}
        profile={profile}
      />

      <ApproveRequestModal
        open={!!approveTarget}
        request={approveTarget}
        onClose={() => setApproveTarget(null)}
        onConfirm={handleApproveConfirm}
        saving={saving}
        fetchDefaultDueAt={fetchDefaultDueAt}
      />

      <DeleteConfirmModal
        open={!!deleteTarget}
        request={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        saving={saving}
      />

      <RejectionModal
        open={!!rejectTarget}
        title={`Reject ${rejectTarget ? requestTypeLabel(rejectTarget, { capitalize: true }) : 'Absence'} Request`}
        subtitle={rejectTarget
          ? isLateSubmission(rejectTarget)
            ? `${rejectTarget.user_name || rejectTarget.user_email} — "${rejectTarget.assignment_name}" submitted ${formatDate(rejectTarget.absence_date)}`
            : `${rejectTarget.user_name || rejectTarget.user_email} — absence on ${formatDate(rejectTarget.absence_date)}`
          : ''
        }
        requestType={rejectTarget ? `${requestTypeLabel(rejectTarget, { capitalize: true })} Request` : 'Absence Request'}
        requestId={rejectTarget?.request_id || ''}
        recipientEmail={rejectTarget?.user_email || ''}
        recipientName={rejectTarget?.user_name || ''}
        onConfirm={handleRejectConfirm}
        onClose={() => setRejectTarget(null)}
      />
    </div>
  )
}
