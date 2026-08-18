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
import {
  X, Library, Archive, ArchiveRestore, Trash2,
  FileText, CalendarCheck, RefreshCw,
} from 'lucide-react'
import toast from 'react-hot-toast'

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

// ─── Main modal ────────────────────────────────────────────────────────────────
export default function SyllabusLibraryModal({ onClose, onOpenSyllabus }) {
  const { user } = useAuth()
  const { isSuperAdmin } = usePermissions('Instructor Tools')
  const dialogRef = useDialogA11y(true, onClose)

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [busyId, setBusyId] = useState(null)          // template id currently updating
  const [confirmAction, setConfirmAction] = useState(null) // { kind: 'archive'|'delete', row }

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('syllabus_templates')
      .select('id, course_id, course_name, semester, status, updated_at, updated_by, pdf_generated_at, pdf_generated_count, begin_date, end_date')
      .order('course_id')
    setLoading(false)
    if (error) { toast.error('Could not load syllabus library: ' + error.message); return }
    setRows(data || [])
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
              <button
                type="button"
                onClick={() => setConfirmAction({ kind: 'archive', row })}
                disabled={busy}
                aria-label={`Archive syllabus for ${row.course_id}, ${row.semester}`}
                className="inline-flex items-center gap-1 px-2 py-1.5 min-h-[36px] text-[11px] font-medium text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
              >
                <Archive size={12} aria-hidden="true" />
                Archive
              </button>
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
    </>
  )
}
