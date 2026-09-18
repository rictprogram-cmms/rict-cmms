/**
 * RICT CMMS — SyllabusLibraryModal
 *
 * Course × semester grid of every saved syllabus template, so instructors can
 * see at a glance which semesters have saved work, open any of them directly
 * in the Syllabus Wizard, and archive/restore old semesters.
 *
 *   • Rows = courses, columns = semesters (chronological), cells = saved drafts
 *   • Cell shows last-saved date, saved-by, PDF-generated badge, and whether
 *     semester dates have been entered
 *   • Click "Open →" on a filled active cell → opens the Syllabus Wizard at
 *     the Review & export step (the syllabus already went through the wizard);
 *     "Edit in wizard" opens the same syllabus at step 1 for a full walkthrough
 *     (via onOpenSyllabus(course_id, semester, mode) — mode 'review' | 'edit')
 *   • Instructors: archive (with confirm) and restore
 *   • Super admin only: permanent delete (with danger confirm)
 *   • "Show archived" toggle reveals archived drafts (muted, restore-able)
 *
 * Accessibility (WCAG 2.1 AA):
 *   • useDialogA11y — focus trap, Escape close, focus return
 *   • role="dialog" + aria-modal + aria-labelledby + aria-describedby
 *   • Real <table> with caption, scope="col" / scope="row" headers
 *   • All icon buttons have aria-labels; focus-visible rings throughout
 *   • Action results announced via react-hot-toast (ARIA live region)
 *
 * Requires: syllabus_templates.status column ('active' | 'archived') — see
 *           syllabus_library_migration.sql
 *
 * File: src/components/SyllabusLibraryModal.jsx
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import useDialogA11y from '@/hooks/useDialogA11y'
import ConfirmDialog from '@/components/ConfirmDialog'
import { useAcademicTerms, useTermActions } from '@/hooks/useAcademicTerms'
import { useClassActions } from '@/hooks/useSettings'
import { proposeSameSeasonNextYear, RUNS, fmtDate as fmtTermDate,
         datesForRuns, calendarFromTerm } from '@/lib/academicTerms'
import { planRollForward, buildSyllabusCopy, templateRuns } from '@/lib/syllabusTemplates'
import { normalizeDelivery } from '@/lib/classDelivery'
import {
  X, Library, Archive, ArchiveRestore, Trash2,
  FileText, CalendarCheck, RefreshCw, CalendarPlus, ArrowRight, AlertCircle, Check,
} from 'lucide-react'
import toast from 'react-hot-toast'

// Syllabus course_type → the classes table's delivery wording.
const COURSE_TYPE_TO_DELIVERY = { hybrid: 'Hybrid', traditional: 'Face-to-Face', online: 'Online' }

// ─── Semester ordering ─────────────────────────────────────────────────────────
// Chronological sort key for strings like "Spring 2026" / "Summer 2026" / "Fall 2026".
// Unrecognized formats sort last (alphabetically) so nothing ever disappears.
const SEASON_RANK = { Spring: 1, Summer: 2, Fall: 3 }
function semesterSortKey(sem) {
  const m = /^(Spring|Summer|Fall)\s+(\d{4})$/.exec((sem || '').trim())
  if (!m) return Number.MAX_SAFE_INTEGER
  return parseInt(m[2], 10) * 10 + SEASON_RANK[m[1]]
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString()
}

// Short display name from an email ("aaron.barker@x.edu" → "aaron.barker")
function shortUser(email) {
  return (email || '').split('@')[0]
}

// ─── Roll-forward dialog ───────────────────────────────────────────────────────
/**
 * Offered when a syllabus is archived (or rolled forward on demand) and next
 * year's same-season syllabus doesn't exist yet: Spring 2026 → Spring 2027,
 * Fall 2026 → Fall 2027.
 *
 * Shows only the steps that will actually succeed. Creating a class needs
 * Settings → manage_classes and creating a term needs manage_terms; neither is
 * implied by the Instructor Tools permission that opens this library, so each
 * is checked up front rather than offered and then blocked.
 *
 * The term step is opt-in and never silent: a term is program-wide and every
 * course in it inherits the dates, so it is only ever created from an explicit
 * tick plus dates the instructor has looked at.
 */
function RollForwardDialog({ plan, row, alsoArchive, canManageClasses, canManageTerms, busy, onConfirm, onClose }) {
  const dialogRef = useDialogA11y(true, onClose)
  const proposed = useMemo(
    () => (plan.needsTerm && plan.sourceTerm ? proposeSameSeasonNextYear(plan.sourceTerm) : null),
    [plan.needsTerm, plan.sourceTerm]
  )
  const [createTerm, setCreateTerm] = useState(false)
  const [termDraft, setTermDraft] = useState(proposed || null)
  useEffect(() => { setTermDraft(proposed || null) }, [proposed])

  const canOfferTerm = plan.needsTerm && canManageTerms && !!proposed
  const setTermField = (k, v) => setTermDraft(d => ({ ...d, [k]: v }))
  const termDatesOk = !createTerm || !!(termDraft?.begin_date && termDraft?.end_date && termDraft.end_date > termDraft.begin_date)

  const runsLabel = RUNS[templateRuns(row)] || RUNS.full
  const willHaveTerm = !plan.needsTerm || createTerm

  const TERM_FIELDS = [
    ['begin_date', 'Term begins', true], ['end_date', 'Term ends', true],
    ['first_half_end', 'First 8 weeks end', false], ['second_half_start', 'Second 8 weeks start', false],
    ['spring_break_start', 'Spring break start', false], ['spring_break_end', 'Spring break end', false],
    ['finals_start', 'Finals start', false], ['finals_end', 'Finals end', false],
  ]

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="rf-title" aria-describedby="rf-desc"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">

        <div className="px-6 py-4 border-b border-surface-100 shrink-0">
          <h2 id="rf-title" className="text-base font-bold text-surface-900 flex items-center gap-2">
            <CalendarPlus size={17} className="text-brand-600" aria-hidden="true" />
            Set up {plan.targetSemester} first?
          </h2>
          <p id="rf-desc" className="text-xs text-surface-500 mt-1">
            {alsoArchive
              ? <>There's no <strong>{plan.targetSemester}</strong> syllabus for {row.course_id} yet. Roll it forward before archiving {row.semester}.</>
              : <>Copy {row.course_id} · {row.semester} forward to <strong>{plan.targetSemester}</strong>.</>}
          </p>
        </div>

        <div className="px-6 py-4 space-y-3 overflow-y-auto">
          {/* Syllabus */}
          <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5">
            <Check size={14} className="text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-xs text-emerald-900">
              <strong>Copy the syllabus</strong> to {plan.targetSemester} — materials, outcomes, grading and the{' '}
              <strong>{runsLabel.toLowerCase()}</strong> setting all carry over.{' '}
              {willHaveTerm
                ? <>Dates come from the {plan.targetSemester} calendar.</>
                : <>Dates are left blank and fill in automatically once the {plan.targetSemester} term exists.</>}
            </p>
          </div>

          {/* Class */}
          {plan.needsClass ? (
            canManageClasses ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5">
                <Check size={14} className="text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-xs text-emerald-900">
                  <strong>Create the CMMS class</strong> for {row.course_id} · {plan.targetSemester} — instructor,
                  delivery, credits and hours come from the syllabus.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                <AlertCircle size={14} className="text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-xs text-amber-800">
                  <strong>The class won't be created</strong> — that needs Settings → Classes permission.
                  Someone with access can add it, and this syllabus will pick it up automatically.
                </p>
              </div>
            )
          ) : (
            <div className="flex items-start gap-2.5 rounded-xl border border-surface-200 bg-surface-50 px-3.5 py-2.5">
              <Check size={14} className="text-surface-400 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-surface-600">The CMMS class for {plan.targetSemester} already exists — nothing to do.</p>
            </div>
          )}

          {/* Term */}
          {!plan.needsTerm ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-surface-200 bg-surface-50 px-3.5 py-2.5">
              <Check size={14} className="text-surface-400 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-surface-600">
                The <strong>{plan.targetSemester}</strong> term calendar already exists
                {plan.targetTerm?.begin_date ? <> ({fmtTermDate(plan.targetTerm.begin_date)} – {fmtTermDate(plan.targetTerm.end_date)})</> : null}.
              </p>
            </div>
          ) : canOfferTerm ? (
            <div className="rounded-xl border border-surface-200 px-3.5 py-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={createTerm} onChange={e => setCreateTerm(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-surface-300 text-brand-600 focus:ring-2 focus:ring-brand-500/40" />
                <span className="text-xs text-surface-700">
                  <strong>Also create the {plan.targetSemester} term</strong> — there isn't one yet.
                  Dates below are {plan.sourceTerm?.name} shifted a year and snapped to Mon/Fri.{' '}
                  <span className="text-amber-700 font-medium">Estimates — check them against the college calendar.</span>
                </span>
              </label>

              {createTerm && termDraft && (
                <div className="mt-3 grid grid-cols-2 gap-2.5">
                  {TERM_FIELDS.map(([f, label, req]) => (
                    <div key={f}>
                      <label htmlFor={`rf-${f}`} className="block text-[10px] font-semibold text-surface-500 uppercase tracking-wide mb-1">
                        {label}{req && <span className="text-red-500" aria-hidden="true"> *</span>}
                      </label>
                      <input id={`rf-${f}`} type="date" value={termDraft[f] || ''} required={req}
                        onChange={e => setTermField(f, e.target.value)}
                        className="w-full px-2 py-1.5 min-h-[44px] text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                    </div>
                  ))}
                  {!termDatesOk && (
                    <p className="col-span-2 text-[11px] text-red-600" role="alert">
                      A term needs a begin and an end date, and the end must come after the begin.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
              <AlertCircle size={14} className="text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-amber-800">
                <strong>No {plan.targetSemester} term calendar yet.</strong>{' '}
                {canManageTerms
                  ? <>Add it under Settings → Terms; the copied syllabus fills its dates in automatically once it exists.</>
                  : <>Creating one needs Settings → Terms permission. The syllabus is copied with blank dates and fills them in once someone adds the term.</>}
              </p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-surface-100 flex justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose} disabled={busy}
            className="px-4 py-2 min-h-[44px] text-sm border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            {alsoArchive ? 'Archive without copying' : 'Cancel'}
          </button>
          <button type="button" disabled={busy || !termDatesOk}
            onClick={() => onConfirm({ createTerm: createTerm && canOfferTerm, termDraft })}
            className="px-5 py-2 min-h-[44px] text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 inline-flex items-center gap-1.5">
            {busy ? 'Working…' : <>Roll forward{alsoArchive ? ' & archive' : ''} <ArrowRight size={14} aria-hidden="true" /></>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main modal ────────────────────────────────────────────────────────────────
export default function SyllabusLibraryModal({ onClose, onOpenSyllabus }) {
  const { user } = useAuth()
  const { isSuperAdmin } = usePermissions('Instructor Tools')
  // Terms and classes live under Settings, not Instructor Tools — reaching this
  // library does not imply the right to create either, so check both up front
  // and offer only the steps that will actually succeed.
  const { hasPerm: hasSettingsPerm } = usePermissions('Settings')
  const canManageClasses = hasSettingsPerm('manage_classes')
  const canManageTerms   = hasSettingsPerm('manage_terms')

  const { terms, refresh: refreshTerms } = useAcademicTerms()
  const { saveTerm } = useTermActions()
  const classActions = useClassActions()
  const dialogRef = useDialogA11y(true, onClose)

  const [rows, setRows] = useState([])
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [busyId, setBusyId] = useState(null)          // template id currently updating
  const [confirmAction, setConfirmAction] = useState(null) // { kind: 'archive'|'delete', row }
  const [rollForward, setRollForward] = useState(null)     // { row, plan, alsoArchive }

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data, error }, { data: cls }] = await Promise.all([
      supabase
        .from('syllabus_templates')
        .select('id, course_id, course_name, semester, status, updated_at, updated_by, pdf_generated_at, pdf_generated_count, begin_date, end_date, runs, semester_length')
        .order('course_id'),
      // Needed to tell whether next year's class already exists.
      supabase.from('classes').select('class_id, course_id, semester'),
    ])
    setLoading(false)
    if (error) { toast.error('Could not load syllabus library: ' + error.message); return }
    setRows(data || [])
    setClasses(cls || [])
  }, [])

  useEffect(() => { load() }, [load])

  // Build grid structure: courses (rows) × semesters (columns)
  const { courses, semesters, cellMap, archivedCount } = useMemo(() => {
    const visible = showArchived ? rows : rows.filter(r => r.status !== 'archived')
    const courseMap = new Map()   // course_id → course_name
    const semSet = new Set()
    const cells = new Map()       // `${course_id}|${semester}` → row
    visible.forEach(r => {
      if (!courseMap.has(r.course_id) || (!courseMap.get(r.course_id) && r.course_name)) {
        courseMap.set(r.course_id, r.course_name || '')
      }
      semSet.add(r.semester)
      cells.set(`${r.course_id}|${r.semester}`, r)
    })
    return {
      courses: [...courseMap.entries()]
        .map(([course_id, course_name]) => ({ course_id, course_name }))
        .sort((a, b) => a.course_id.localeCompare(b.course_id)),
      semesters: [...semSet].sort((a, b) =>
        semesterSortKey(a) - semesterSortKey(b) || a.localeCompare(b)),
      cellMap: cells,
      archivedCount: rows.filter(r => r.status === 'archived').length,
    }
  }, [rows, showArchived])

  // ─── Actions ─────────────────────────────────────────────────────────────────
  const setStatus = async (row, newStatus) => {
    setBusyId(row.id)
    const { data: updated, error } = await supabase
      .from('syllabus_templates')
      .update({ status: newStatus, updated_at: new Date().toISOString(), updated_by: user?.email || '' })
      .eq('id', row.id)
      .select()
    setBusyId(null)
    if (error) { toast.error('Update failed: ' + error.message); return false }
    // RLS silent-failure guard
    if (!updated || updated.length === 0) {
      toast.error('Update was blocked — no rows written. Check permissions or contact an administrator.')
      return false
    }
    toast.success(newStatus === 'archived'
      ? `Archived ${row.course_id} · ${row.semester}`
      : `Restored ${row.course_id} · ${row.semester}`)
    await load()
    return true
  }

  const hardDelete = async (row) => {
    setBusyId(row.id)
    const { data: deleted, error } = await supabase
      .from('syllabus_templates')
      .delete()
      .eq('id', row.id)
      .select()
    setBusyId(null)
    if (error) { toast.error('Delete failed: ' + error.message); return false }
    // RLS silent-failure guard
    if (!deleted || deleted.length === 0) {
      toast.error('Delete was blocked — no rows removed. Check permissions or contact an administrator.')
      return false
    }
    toast.success(`Permanently deleted ${row.course_id} · ${row.semester}`)
    await load()
    return true
  }

  const handleConfirm = async () => {
    if (!confirmAction) return
    const { kind, row } = confirmAction
    const ok = kind === 'delete' ? await hardDelete(row) : await setStatus(row, 'archived')
    if (ok) setConfirmAction(null)
  }

  // ─── Roll forward ────────────────────────────────────────────────────────────
  /** What rolling this row forward a year would involve. Null when unparseable. */
  const planFor = useCallback(
    (row) => planRollForward({ row, allTemplates: rows, terms, classes }),
    [rows, terms, classes]
  )

  /**
   * Archiving is where a gap in next year's calendar shows up, so that's where
   * the offer belongs. If next year is already set up (or the semester can't be
   * parsed), fall through to the plain archive confirmation unchanged.
   */
  const startArchive = (row) => {
    const plan = planFor(row)
    if (!plan || plan.nothingToDo) { setConfirmAction({ kind: 'archive', row }); return }
    setRollForward({ row, plan, alsoArchive: true })
  }

  const startRollForward = (row) => {
    const plan = planFor(row)
    if (!plan) { toast.error(`Can't tell what follows "${row.semester}" — expected a name like "Spring 2026".`); return }
    if (plan.nothingToDo) { toast.success(`${row.course_id} is already set up for ${plan.targetSemester}.`); return }
    setRollForward({ row, plan, alsoArchive: false })
  }

  const doRollForward = async ({ createTerm, termDraft }) => {
    const { row, plan, alsoArchive } = rollForward
    setBusyId(row.id)
    const done = []
    try {
      // 1. Term first — the syllabus and class both take their dates from it.
      let term = plan.targetTerm
      if (createTerm && termDraft && canManageTerms) {
        const saved = await saveTerm(termDraft, null)   // saveTerm toasts its own failure
        if (!saved) { setBusyId(null); return }         // stop rather than half-apply
        term = saved
        done.push(`created the ${saved.name} term`)
        await refreshTerms()
      }

      // 2. Syllabus copy. Read the full source row — the grid only holds a few columns.
      if (plan.needsSyllabus) {
        const { data: full, error: readErr } = await supabase
          .from('syllabus_templates').select('*').eq('id', row.id).maybeSingle()
        if (readErr || !full) throw new Error(readErr?.message || 'Could not read the source syllabus')

        const copy = buildSyllabusCopy(full, plan.targetSemester, term, user?.email || '')
        const { data: made, error } = await supabase.from('syllabus_templates')
          .upsert(copy, { onConflict: 'course_id,semester' }).select()
        if (error) throw error
        if (!made || made.length === 0) throw new Error('Copy was blocked — no rows written. Check permissions.')
        done.push(`copied the syllabus to ${plan.targetSemester}`)
      }

      // 3. Class, when the user may create one. Everything comes from the
      //    syllabus and the term, so there is nothing further to type.
      if (plan.needsClass && canManageClasses) {
        const { data: full } = await supabase
          .from('syllabus_templates').select('*').eq('id', row.id).maybeSingle()
        const runs = templateRuns(full || row)
        const cal = term
          ? { ...datesForRuns(term, runs), ...calendarFromTerm(term, { runs }) }
          : {}
        await classActions.addItem({
          course_id: row.course_id,
          course_name: row.course_name || full?.course_name || '',
          semester: plan.targetSemester,
          term_id: term?.term_id || null,
          runs,
          override_term_dates: false,
          instructor: full?.instructor_name || '',
          instructor_email: full?.instructor_email ? String(full.instructor_email).toLowerCase() : null,
          delivery: normalizeDelivery(COURSE_TYPE_TO_DELIVERY[full?.course_type] || 'Hybrid'),
          credits_lecture: full?.credits_lecture ?? null,
          credits_lab: full?.credits_lab ?? null,
          required_hours: full?.required_hours_per_week ?? null,
          start_date: cal.start_date || null,
          end_date: cal.end_date || null,
          spring_break_start: cal.spring_break_start || null,
          spring_break_end: cal.spring_break_end || null,
          finals_start: cal.finals_start || null,
          finals_end: cal.finals_end || null,
          status: 'Active',
        })
        done.push(`created the ${plan.targetSemester} class`)
      }

      // 4. Only now archive — never lose the source before the copy exists.
      if (alsoArchive) {
        const ok = await setStatus(row, 'archived')
        if (!ok) { setBusyId(null); return }
      }

      setRollForward(null)
      toast.success(`${row.course_id}: ${done.join(', ')}.`)
      await load()
    } catch (e) {
      toast.error('Roll forward failed: ' + e.message)
    } finally {
      setBusyId(null)
    }
  }

  // ─── Cell renderer ───────────────────────────────────────────────────────────
  const renderCell = (course, semester) => {
    const row = cellMap.get(`${course.course_id}|${semester}`)
    if (!row) {
      return (
        <td key={semester} className="px-3 py-3 text-center text-surface-300 align-top">
          <span aria-hidden="true">—</span>
          <span className="sr-only">No syllabus saved for {course.course_id} in {semester}</span>
        </td>
      )
    }

    const isArchived = row.status === 'archived'
    const busy = busyId === row.id
    const hasDates = !!(row.begin_date && row.end_date)
    const hasPdf = (row.pdf_generated_count || 0) > 0
    // Next year's same season, when the semester name can be parsed and that
    // syllabus doesn't already exist. Drives the "Roll forward" affordance.
    const plan = isArchived ? null : planFor(row)
    const rollTarget = plan && !plan.nothingToDo ? plan.targetSemester : null

    return (
      <td key={semester} className="px-2 py-2 align-top">
        <div className={`rounded-lg border p-2.5 ${isArchived
          ? 'bg-surface-50 border-surface-200 opacity-70'
          : 'bg-white border-surface-200 hover:border-brand-300 hover:shadow-sm transition-all'}`}>

          {/* Open button (active only) or archived label */}
          {isArchived ? (
            <p className="text-xs font-semibold text-surface-500 flex items-center gap-1.5">
              <Archive size={12} aria-hidden="true" />
              Archived
            </p>
          ) : (
            /* Open → jumps straight to the Review & export step (the syllabus
               has already been through the wizard); "Edit in wizard" is the
               secondary path that walks through from step 1. */
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpenSyllabus(row.course_id, row.semester, 'review')}
                aria-label={`Open syllabus for ${row.course_id}, ${row.semester}, at the review and export step`}
                className="min-h-[44px] flex-1 min-w-0 text-left text-sm font-semibold text-brand-700 hover:text-brand-800 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
              >
                Open →
              </button>
              <span aria-hidden="true" className="text-surface-200 select-none">|</span>
              <button
                type="button"
                onClick={() => onOpenSyllabus(row.course_id, row.semester, 'edit')}
                aria-label={`Edit syllabus for ${row.course_id}, ${row.semester}, step by step in the wizard`}
                className="min-h-[44px] shrink-0 text-[11px] font-medium text-surface-400 hover:text-brand-700 underline-offset-2 hover:underline rounded px-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
              >
                Edit in wizard
              </button>
            </div>
          )}

          {/* Metadata */}
          <dl className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-surface-500">
            <div>
              <dt className="sr-only">Last saved</dt>
              <dd>Saved {fmtDate(row.updated_at)}</dd>
            </div>
            {row.updated_by && (
              <div>
                <dt className="sr-only">Saved by</dt>
                <dd className="truncate" title={row.updated_by}>by {shortUser(row.updated_by)}</dd>
              </div>
            )}
          </dl>

          {/* Badges */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {hasPdf && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-semibold"
                title={`PDF generated ${row.pdf_generated_count} time${row.pdf_generated_count === 1 ? '' : 's'}`}>
                <FileText size={10} aria-hidden="true" />
                PDF ×{row.pdf_generated_count}
              </span>
            )}
            {hasDates ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-semibold">
                <CalendarCheck size={10} aria-hidden="true" />
                Dates set
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-semibold">
                No dates
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="mt-2 pt-2 border-t border-surface-100 flex items-center gap-1">
            {isArchived ? (
              <button
                type="button"
                onClick={() => setStatus(row, 'active')}
                disabled={busy}
                aria-label={`Restore syllabus for ${row.course_id}, ${row.semester}`}
                className="inline-flex items-center gap-1 px-2 py-1.5 min-h-[36px] text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
              >
                <ArchiveRestore size={12} aria-hidden="true" />
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => startArchive(row)}
                  disabled={busy}
                  aria-label={`Archive syllabus for ${row.course_id}, ${row.semester}`}
                  className="inline-flex items-center gap-1 px-2 py-1.5 min-h-[36px] text-[11px] font-medium text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
                >
                  <Archive size={12} aria-hidden="true" />
                  Archive
                </button>
                {/* Rolling forward and archiving are separate decisions — next
                    year can be set up in March while this year stays live. */}
                {rollTarget && (
                  <button
                    type="button"
                    onClick={() => startRollForward(row)}
                    disabled={busy}
                    aria-label={`Roll ${row.course_id} forward from ${row.semester} to ${rollTarget}`}
                    title={`Copy forward to ${rollTarget}`}
                    className="inline-flex items-center gap-1 px-2 py-1.5 min-h-[36px] text-[11px] font-medium text-brand-600 hover:text-brand-800 hover:bg-brand-50 rounded transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
                  >
                    <CalendarPlus size={12} aria-hidden="true" />
                    Roll forward
                  </button>
                )}
              </>
            )}
            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => setConfirmAction({ kind: 'delete', row })}
                disabled={busy}
                aria-label={`Permanently delete syllabus for ${row.course_id}, ${row.semester}`}
                className="inline-flex items-center gap-1 px-2 py-1.5 min-h-[36px] text-[11px] font-medium text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
              >
                <Trash2 size={12} aria-hidden="true" />
                Delete
              </button>
            )}
          </div>
        </div>
      </td>
    )
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="syllabus-library-title"
          aria-describedby="syllabus-library-desc"
          className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
                <Library size={16} className="text-blue-600" aria-hidden="true" />
              </div>
              <div>
                <h2 id="syllabus-library-title" className="text-base font-bold text-surface-900">Syllabus Library</h2>
                <p id="syllabus-library-desc" className="text-xs text-surface-400">
                  Every saved syllabus by course and semester — open, archive, or restore
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={load}
                disabled={loading}
                aria-label="Refresh syllabus library"
                className="p-2 min-h-[36px] min-w-[36px] rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Syllabus Library"
                className="p-2 min-h-[36px] min-w-[36px] rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div className="px-6 py-3 border-b border-surface-100 flex items-center justify-between shrink-0">
            <label className="flex items-center gap-2 text-sm text-surface-600 cursor-pointer select-none min-h-[36px]">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)}
                className="w-4 h-4 rounded border-surface-300 text-brand-600 focus:ring-2 focus:ring-brand-500/40"
              />
              Show archived
              {archivedCount > 0 && (
                <span className="text-xs text-surface-400">({archivedCount})</span>
              )}
            </label>
            <p className="text-xs text-surface-400">
              <span className="font-semibold text-brand-600">Open →</span> jumps to Review &amp; export · <span className="font-semibold text-brand-600">Edit in wizard</span> walks through the steps
            </p>
          </div>

          {/* Grid */}
          <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
            {loading ? (
              <div className="flex items-center justify-center h-32 text-sm text-surface-400" role="status">
                Loading syllabus library…
              </div>
            ) : courses.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-center" role="status">
                <Library size={28} className="text-surface-300 mb-2" aria-hidden="true" />
                <p className="text-sm font-medium text-surface-600">
                  {showArchived ? 'No saved syllabi yet' : 'No active syllabi'}
                </p>
                <p className="text-xs text-surface-400 mt-1 max-w-sm">
                  {showArchived
                    ? 'Save a draft in the Syllabus Generator and it will appear here.'
                    : archivedCount > 0
                      ? 'All saved syllabi are archived — turn on "Show archived" to see them.'
                      : 'Save a draft in the Syllabus Generator and it will appear here.'}
                </p>
              </div>
            ) : (
              <table className="w-full border-collapse min-w-[560px]">
                <caption className="sr-only">
                  Saved syllabi by course and semester. Each filled cell shows the last saved date and actions to open, archive, or restore that syllabus.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 bg-white text-left px-3 py-2 text-xs font-semibold text-surface-500 uppercase tracking-wide border-b border-surface-200">
                      Course
                    </th>
                    {semesters.map(sem => (
                      <th key={sem} scope="col" className="px-3 py-2 text-left text-xs font-semibold text-surface-500 uppercase tracking-wide border-b border-surface-200 min-w-[150px]">
                        {sem}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {courses.map(course => (
                    <tr key={course.course_id} className="border-b border-surface-100 last:border-b-0">
                      <th scope="row" className="sticky left-0 bg-white text-left px-3 py-3 align-top">
                        <span className="block text-sm font-bold text-surface-900">{course.course_id}</span>
                        {course.course_name && (
                          <span className="block text-xs text-surface-400 font-normal mt-0.5">{course.course_name}</span>
                        )}
                      </th>
                      {semesters.map(sem => renderCell(course, sem))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer note */}
          <div className="px-6 py-3 border-t border-surface-100 shrink-0">
            <p className="text-xs text-surface-400">
              Archiving hides a syllabus from this grid and from the wizard&rsquo;s &ldquo;other semesters&rdquo; suggestions — it can be restored anytime.
              {isSuperAdmin && ' Permanent delete is available to the super admin only and cannot be undone.'}
            </p>
          </div>
        </div>
      </div>

      {/* Archive confirmation */}
      <ConfirmDialog
        open={confirmAction?.kind === 'archive'}
        title="Archive this syllabus?"
        message={confirmAction ? `${confirmAction.row.course_id} · ${confirmAction.row.semester} will be hidden from the library grid and from wizard suggestions. You can restore it anytime with "Show archived".` : ''}
        confirmLabel="Archive"
        variant="primary"
        busy={busyId === confirmAction?.row?.id}
        onConfirm={handleConfirm}
        onClose={() => setConfirmAction(null)}
      />

      {/* Permanent delete confirmation (super admin only) */}
      <ConfirmDialog
        open={confirmAction?.kind === 'delete'}
        title="Permanently delete this syllabus?"
        message={confirmAction ? `${confirmAction.row.course_id} · ${confirmAction.row.semester} will be permanently deleted. This cannot be undone — consider archiving instead if you might need it later.` : ''}
        confirmLabel="Delete Permanently"
        variant="danger"
        busy={busyId === confirmAction?.row?.id}
        onConfirm={handleConfirm}
        onClose={() => setConfirmAction(null)}
      />

      {/* Roll forward to next year's same season, offered on archive or on demand */}
      {rollForward && (
        <RollForwardDialog
          plan={rollForward.plan}
          row={rollForward.row}
          alsoArchive={rollForward.alsoArchive}
          canManageClasses={canManageClasses}
          canManageTerms={canManageTerms}
          busy={busyId === rollForward.row.id}
          onConfirm={doRollForward}
          onClose={() => {
            // "Archive without copying" on the archive path — the original
            // intent still stands, so fall through to the plain confirmation.
            const { row, alsoArchive } = rollForward
            setRollForward(null)
            if (alsoArchive) setConfirmAction({ kind: 'archive', row })
          }}
        />
      )}
    </>
  )
}
