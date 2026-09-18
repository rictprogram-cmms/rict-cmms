/**
 * RICT CMMS — Class Schedule page
 *
 * The RICT Term Scheduler, moved into the CMMS (2026-09). Instructors block
 * out class time on a Mon–Fri half-hour grid for the first / second 8 weeks
 * of a semester; students and work study see the same grid read-only.
 *
 * Data
 *   • Semesters come from the distinct `semester` values on Settings →
 *     Classes; the class list, weekly hours and instructor for each are read
 *     live from those rows (edit them in Settings). The schedule owns room,
 *     half of term (derived from the class dates the first time), colour,
 *     combined group, note, and the blocks. Ad-hoc "unlisted" classes cover
 *     an outside instructor. See src/hooks/useClassSchedule.js.
 *   • Every save writes one audit_log row ("Class Schedule" / schedule_id)
 *     with a plain-English change list; the History button shows them.
 *
 * Interaction (ported from the artifact)
 *   • Click a class card (or a block) to load it, then drag down a day
 *     column to add time; drag over its own block to clear; drag a block's
 *     top/bottom edge to resize; ✕ on a block clears that run. A class
 *     stops at its weekly hours — extra drag time hands over to a combined
 *     partner with hours left. Erase mode clears whatever it passes over.
 *   • Combined classes (same time, different rooms) paint together; the
 *     "Only this" toggle paints the loaded class alone.
 *   • Conflicts chip: same instructor or same room at the same time
 *     (combined classes are exempt from the instructor rule); combined
 *     groups that don't line up yet show as notes.
 *   • First / Second / Both tabs; 16-week classes appear in both halves.
 *   • Copy layout from an earlier semester (classes with no blocks only).
 *   • Print PDF — landscape, rail hidden.
 *
 * Permissions: 'Class Schedule' / view_page + edit_schedule (instructor by
 * default). Without edit_schedule the board is read-only; RLS enforces it too.
 *
 * Accessibility: cards and blocks are keyboard reachable (Enter/Space loads
 * a class); every control ≥ 44px with focus-visible rings; live regions for
 * save state, hint, conflicts and the filter count; dialogs use
 * useDialogA11y; colour never carries meaning alone (codes, text, badges).
 *
 * File: src/pages/ClassSchedulePage.jsx
 */

import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useSemesterOptions, useClassSchedule } from '@/hooks/useClassSchedule'
import {
  DAYS, HUES, SPANS, SPAN_LONG, SLOT_PX, hueOf, fmt, fmtRange, hrs, clamp,
  termsOf, ensure, byId, mates, segments, segAt, segsAt, scheduledHours, sharedHours,
  placedIn, meterState, layoutLanes, conflicts, groupNotes, dragOps, dayAfter, paintTargets, paintAll,
  liveHours, setCombined, matches,
} from '@/lib/scheduleModel'
import {
  Loader2, Search, X, Eraser, History, Printer, Copy, Plus, Pencil, Trash2, Link2,
  AlertTriangle, CheckCircle2, Lock, Info,
} from 'lucide-react'
import toast from 'react-hot-toast'
import '@/styles/class-schedule.css'

const TERMS = [['A', 'First 8 weeks', 'Weeks 1–8'], ['B', 'Second 8 weeks', 'Weeks 9–16']]
const SPAN_ORDER = { first: 0, both: 1, second: 2 }

function Mark({ text, query }) {
  const t = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const s = String(text ?? '')
  if (!t.length || !s) return s
  const re = new RegExp('(' + t.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig')
  const parts = s.split(re)
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))
}

function ago(ts) {
  const t = new Date(ts).getTime()
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + (Math.floor(s / 3600) === 1 ? ' hour ago' : ' hours ago')
  const d = new Date(t)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function ClassSchedulePage() {
  const { hasPerm } = usePermissions('Class Schedule')
  const canEdit = hasPerm('edit_schedule')
  const uid = useId()

  // Archived semesters are hidden by default so the list stays short as terms
  // pile up; the toggle below brings them back when an old one is needed.
  const [showArchived, setShowArchived] = useState(false)
  const { semesters, classesBySemester, defaultSemester, archivedHiddenCount, loading: semLoading } =
    useSemesterOptions({ showArchived })
  const [semester, setSemester] = useState('')
  useEffect(() => { if (!semester && defaultSemester) setSemester(defaultSemester) }, [defaultSemester, semester])
  // Turning "Show archived" back off while viewing an archived semester would
  // leave the selector pointing at an option that no longer exists — the grid
  // would keep rendering it while the dropdown showed something else. Fall back
  // to the default instead. Only runs once the list has loaded, so a slow load
  // never knocks the user off a semester they deliberately chose.
  useEffect(() => {
    if (semLoading || !semester || !semesters.length) return
    if (!semesters.some(s => s.name === semester) && defaultSemester) setSemester(defaultSemester)
  }, [semesters, semester, defaultSemester, semLoading])
  const semesterClasses = useMemo(() => (semester ? classesBySemester.get(semester) || [] : null), [classesBySemester, semester])

  const sched = useClassSchedule(semester, { canEdit, classes: semesterClasses })
  const { doc, loading, saveState, commit, retrySave, setPaused, history, historyLoading, refreshHistory,
          otherSchedules, copyFromSemester, addAdhoc, removeCourse } = sched

  // ── UI state ──
  const [view, setView] = useState('A')          // 'A' | 'B' | 'both'
  const [brush, setBrush] = useState(null)       // loaded class id
  const [soloMode, setSoloMode] = useState(false)
  const [eraser, setEraser] = useState(false)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(null)         // null | { mode: 'new' } | { mode: 'edit', id }
  const [confOpen, setConfOpen] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const [confirm, setConfirm] = useState(null)   // { title, message, onConfirm, confirmLabel, variant }
  const [copyOpen, setCopyOpen] = useState(false)
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const boardRef = useRef(null)

  useEffect(() => { setPaused(!!drag || !!form) }, [drag, form, setPaused])
  useEffect(() => { if (histOpen) refreshHistory() }, [histOpen, refreshHistory])
  // Close popovers on outside click
  useEffect(() => {
    if (!confOpen && !histOpen) return undefined
    const h = (e) => { if (e.target.closest('.cs-pop, [data-cs-pop-btn]')) return; setConfOpen(false); setHistOpen(false) }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [confOpen, histOpen])
  // Reset per-semester UI
  useEffect(() => { setBrush(null); setSoloMode(false); setEraser(false); setForm(null); setDrag(null) }, [semester])

  const conf = useMemo(() => (doc ? conflicts(doc) : { list: [], flagged: new Set() }), [doc])
  const notes = useMemo(() => (doc ? groupNotes(doc) : []), [doc])
  const brushCourse = doc && brush ? byId(doc, brush) : null
  const brushMates = brushCourse ? mates(doc, brushCourse) : []

  // ── brush ──
  const loadBrush = useCallback((id) => {
    if (!canEdit) return
    setBrush(prev => (prev === id ? null : id))
    setSoloMode(false)
    setEraser(false)
    const c = doc && byId(doc, id)
    if (c && view !== 'both' && !termsOf(c).includes(view)) setView(termsOf(c)[0])
  }, [canEdit, doc, view])

  const changeView = (v) => {
    setView(v)
    if (brushCourse && v !== 'both' && !termsOf(brushCourse).includes(v)) { setBrush(null); setSoloMode(false) }
    if (boardRef.current) boardRef.current.scrollTop = 0
  }

  // ── painting ──
  const slotFromEvent = (col, e) => {
    const r = col.getBoundingClientRect()
    const i = Math.floor((e.clientY - r.top) / SLOT_PX)
    return clamp(doc.startHour * 2 + i, doc.startHour * 2, doc.endHour * 2 - 1)
  }
  const updateDrag = (next) => { dragRef.current = next; setDrag(next ? { ...next } : null) }

  const eraseTargetsFor = (d) => {
    const lo = Math.min(d.start, d.end), hi = Math.max(d.start, d.end)
    const ids = new Set()
    for (let s = lo; s <= hi; s++) for (const g of segsAt(doc, d.term, d.day, s)) ids.add(g.cid)
    return [...ids]
  }

  const onPointerDown = (e) => {
    if (!canEdit || !doc) return
    const rz = e.target.closest('.rz')
    const blk = e.target.closest('.cs-blk')
    if (rz && blk) {
      const cid = blk.dataset.cid
      const d = { mode: 'resize', edge: rz.classList.contains('top') ? 'top' : 'bottom', col: blk.parentElement,
        cid, targets: paintTargets(doc, cid, soloMode), term: blk.dataset.term, day: +blk.dataset.day,
        start: +blk.dataset.start, end: +blk.dataset.end }
      blk.parentElement.setPointerCapture(e.pointerId)
      updateDrag(d)
      e.preventDefault(); return
    }
    if (e.target.closest('.x') && blk) {
      const cid = blk.dataset.cid
      commit(d => paintAll(d, paintTargets(d, cid, soloMode), blk.dataset.term, +blk.dataset.day, [{ a: +blk.dataset.start, b: +blk.dataset.end, erase: true }], cid))
      return
    }
    const col = e.target.closest('.cs-daycol'); if (!col) return
    const term = col.dataset.term, day = +col.dataset.day, slot = slotFromEvent(col, e)
    const hit = segAt(doc, term, day, slot, brush)
    if (!brush && !eraser) {
      if (hit) loadBrush(hit.cid)
      else toast('Pick a class on the left first.', { icon: '👈' })
      return
    }
    if (eraser) {
      const d = { mode: 'paint', col, cid: null, targets: [], term, day, start: slot, end: slot, erase: true, eraseAll: true, armed: false, x0: e.clientX, y0: e.clientY }
      d.targets = eraseTargetsFor(d)
      col.setPointerCapture(e.pointerId)
      updateDrag(d)
      e.preventDefault(); return
    }
    const erase = !!hit && hit.cid === brush
    const armed = !!hit   // tap = switch class, drag = draw
    const d = { mode: 'paint', col, cid: brush, targets: paintTargets(doc, brush, soloMode), term, day, start: slot, end: slot, erase, armed, hitCid: hit ? hit.cid : null, x0: e.clientX, y0: e.clientY }
    col.setPointerCapture(e.pointerId)
    updateDrag(d)
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    const d = dragRef.current; if (!d) return
    if (d.armed) {
      if (Math.abs(e.clientX - d.x0) < 5 && Math.abs(e.clientY - d.y0) < 5) return
      d.armed = false
    }
    const slot = slotFromEvent(d.col, e)
    if (d.mode === 'resize') {
      if (d.edge === 'top') { const ns = Math.min(d.end, slot); if (d.newStart === ns) return; d.newStart = ns }
      else { const ne = Math.max(d.start, slot); if (d.newEnd === ne) return; d.newEnd = ne }
    } else {
      if (d.end === slot) return
      d.end = slot
      if (d.eraseAll) d.targets = eraseTargetsFor(d)
    }
    updateDrag(d)
  }

  const endDrag = () => {
    const d = dragRef.current; if (!d) return
    updateDrag(null)
    if (d.armed) { if (d.hitCid && d.hitCid !== brush) loadBrush(d.hitCid); return }
    let result = null
    commit(nd => { result = paintAll(nd, d.targets, d.term, d.day, dragOps(d), d.cid) })
    if (result?.blocked) toast(result.blocked, { icon: 'ℹ️' })
    if (result?.full?.length) {
      toast(`${result.full.join(' + ')} ${result.full.length > 1 ? 'have' : 'has'} all its hours${result.rest.length ? ' — the extra time went to ' + result.rest.join(' + ') + ' only.' : '.'}`, { icon: '⏱️' })
    }
  }

  // ── card actions ──
  const askRemove = (c) => {
    setConfirm({
      title: c.adhoc ? 'Remove this class?' : 'Clear all blocks?',
      message: c.adhoc
        ? <>{c.code || c.title} and every block scheduled for it will be removed from {doc.semester}.</>
        : <>{c.code || c.title} stays on the list (it comes from Settings → Classes); every block scheduled for it in {doc.semester} will be cleared.</>,
      confirmLabel: c.adhoc ? 'Remove' : 'Clear blocks',
      onConfirm: () => { removeCourse(c.id); if (brush === c.id) setBrush(null); setConfirm(null) },
    })
  }

  // ── derived list ──
  const listCourses = useMemo(() => {
    if (!doc) return { all: [], shown: [], elsewhere: 0 }
    const inHalf = doc.courses.filter(c => view === 'both' || termsOf(c).includes(view))
    // Online classes sit at the bottom — they rarely need grid time.
    const all = [...inHalf].sort((a, b) => (a.delivery === 'Online' ? 1 : 0) - (b.delivery === 'Online' ? 1 : 0) || SPAN_ORDER[a.span] - SPAN_ORDER[b.span] || a.code.localeCompare(b.code))
    return { all, shown: all.filter(c => matches(c, query)), elsewhere: doc.courses.length - inHalf.length }
  }, [doc, view, query])

  const hint = !canEdit
    ? 'View only — instructors edit this schedule.'
    : eraser ? 'Eraser on — drag across any block to clear that time.'
    : brushCourse
      ? (brushMates.length
        ? `${brushCourse.code} is loaded. Dragging schedules it together with its combined class — switch to "${brushCourse.code} only" for hours it meets alone.`
        : `${brushCourse.code} is loaded. Drag a day column to add time; drag over its own block to clear. Click any other block to switch to that class.`)
      : 'Pick a class here — or click a block on the grid — then drag down a day column to block out time.'

  const saveFlag = {
    idle: '', unsaved: 'Unsaved…', saving: 'Saving…', saved: 'Saved', error: 'Not saved', readonly: 'View only',
  }[saveState]

  // ═══ render ═══
  if (semLoading && !semester) {
    return <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" /></div>
  }
  if (!semesters.length) {
    return (
      <div className="p-4 lg:p-6 max-w-3xl mx-auto">
        <div className="card p-8 text-center text-surface-500 text-sm">
          No semesters yet. Add a term under Settings → Terms (e.g. "Spring 2027") and classes for it under Settings → Classes, and they will appear here.
        </div>
      </div>
    )
  }

  return (
    <div className="cs-root p-4 lg:p-6 max-w-[1500px] mx-auto space-y-4">
      {/* ── Toolbar ── */}
      <div className="cs-toolbar card px-4 py-3 flex items-center gap-3 flex-wrap relative">
        <label htmlFor={`${uid}-sem`} className="text-xs font-semibold text-surface-600">Semester</label>
        <select id={`${uid}-sem`} value={semester} onChange={e => setSemester(e.target.value)} className="input text-sm w-auto min-h-[44px]">
          {semesters.map(s => (
            <option key={s.name} value={s.name}>{s.name}{s.archived ? ' (archived)' : ''}</option>
          ))}
        </select>
        {/* Offered only when it would actually reveal something. */}
        {(showArchived || archivedHiddenCount > 0) && (
          <label htmlFor={`${uid}-show-arch`}
            className="flex items-center gap-1.5 text-xs text-surface-500 cursor-pointer select-none min-h-[44px]">
            <input
              id={`${uid}-show-arch`}
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              className="w-4 h-4 rounded border-surface-300 text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
            />
            Show archived
            {!showArchived && archivedHiddenCount > 0 && (
              <span className="text-surface-400">({archivedHiddenCount})</span>
            )}
          </label>
        )}
        {/* Announce what changed — the dropdown's contents shift under the user. */}
        <span aria-live="polite" className="sr-only">
          {showArchived
            ? `Showing all ${semesters.length} semesters, including archived.`
            : `Showing ${semesters.length} active semester${semesters.length === 1 ? '' : 's'}${archivedHiddenCount > 0 ? `, ${archivedHiddenCount} archived hidden` : ''}.`}
        </span>
        {doc && canEdit && (
          <div className="flex items-center gap-1 text-xs text-surface-500">
            <label htmlFor={`${uid}-sh`} className="sr-only">Grid start hour</label>
            <select id={`${uid}-sh`} value={doc.startHour} onChange={e => commit(d => { d.startHour = +e.target.value })} className="input text-xs w-auto min-h-[44px] py-1" title="Grid start hour">
              {Array.from({ length: 23 }, (_, h) => <option key={h} value={h}>{fmt(h * 2)}</option>)}
            </select>
            <span aria-hidden="true">–</span>
            <label htmlFor={`${uid}-eh`} className="sr-only">Grid end hour</label>
            <select id={`${uid}-eh`} value={doc.endHour} onChange={e => commit(d => { d.endHour = +e.target.value })} className="input text-xs w-auto min-h-[44px] py-1" title="Grid end hour">
              {Array.from({ length: 24 - doc.startHour }, (_, i) => doc.startHour + 1 + i).map(h => <option key={h} value={h}>{fmt(h * 2)}</option>)}
            </select>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <span className={`text-xs ${saveState === 'error' ? 'text-red-600' : saveState === 'readonly' ? 'text-surface-400' : 'text-surface-500'}`} role="status" aria-live="polite">
            {saveState === 'readonly' && <Lock size={12} className="inline mr-1 -mt-0.5" aria-hidden="true" />}
            {saveFlag}
            {saveState === 'error' && <button type="button" onClick={retrySave} className="ml-2 underline text-brand-700 min-h-[44px]">Retry</button>}
          </span>
          <div className="relative">
            <button type="button" data-cs-pop-btn onClick={() => { setHistOpen(v => !v); setConfOpen(false) }}
              aria-expanded={histOpen} aria-controls={`${uid}-hist`}
              className={`btn-secondary btn-sm min-h-[44px] ${histOpen ? 'ring-2 ring-brand-500' : ''}`}>
              <History size={14} aria-hidden="true" /> History
            </button>
            {histOpen && (
              <div id={`${uid}-hist`} className="cs-pop" role="region" aria-label="Change history">
                <h4>Change history <span className="text-surface-400 font-normal normal-case tracking-normal">{doc?.semester}</span></h4>
                {historyLoading ? <p className="text-xs text-surface-400">Loading…</p>
                  : history.length === 0 ? <p className="text-xs text-surface-400">No changes recorded yet for this semester. Every save from here on is listed with who made it.</p>
                  : history.map(h => (
                    <div key={h.id} className="cs-he">
                      <div className="cs-he-top"><span className="cs-he-who">{h.who}</span><span className="cs-he-at" title={new Date(h.at).toLocaleString()}>{ago(h.at)}</span></div>
                      <ul className="cs-he-lines">{h.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                    </div>
                  ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button type="button" data-cs-pop-btn onClick={() => { setConfOpen(v => !v); setHistOpen(false) }}
              aria-expanded={confOpen} aria-controls={`${uid}-conf`}
              className={`btn btn-sm min-h-[44px] border ${conf.list.length ? 'bg-red-50 border-red-200 text-red-700' : notes.length ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
              {conf.list.length ? <AlertTriangle size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
              <span role="status" aria-live="polite">
                {conf.list.length ? `${conf.list.length} conflict${conf.list.length === 1 ? '' : 's'}` : notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : 'No conflicts'}
              </span>
            </button>
            {confOpen && (
              <div id={`${uid}-conf`} className="cs-pop" role="region" aria-label="Conflicts">
                <h4>Conflicts</h4>
                {conf.list.length ? conf.list.map((c, i) => (
                  <div key={i} className="cs-cf">
                    <div className="who">{c.kind}: {c.who}</div>
                    <div className="when">{c.term === 'A' ? '1st 8 wk' : '2nd 8 wk'} · {DAYS[c.day]} {fmtRange(c.start, c.end)}</div>
                    <div className="what">{c.a.code} {c.a.title} &nbsp;vs&nbsp; {c.b.code} {c.b.title}</div>
                  </div>
                )) : <p className="text-xs text-surface-400">Nothing double-booked. Every instructor and room is free where you put them.</p>}
                {notes.length > 0 && (
                  <>
                    <h4 className="mt-3">Combined classes</h4>
                    {notes.map((n, i) => <div key={i} className="cs-cf note"><div className="who"><Link2 size={12} className="inline mr-1" aria-hidden="true" />{n.who}</div><div className="what">{n.text}</div></div>)}
                  </>
                )}
              </div>
            )}
          </div>
          {canEdit && (
            <>
              <button type="button" onClick={() => { setEraser(v => !v); setBrush(null); setSoloMode(false) }} aria-pressed={eraser}
                className={`btn-secondary btn-sm min-h-[44px] ${eraser ? 'ring-2 ring-red-400 bg-red-50 text-red-700' : ''}`} title="Erase mode (E)">
                <Eraser size={14} aria-hidden="true" /> Erase
              </button>
              <button type="button" onClick={() => setCopyOpen(true)} disabled={!otherSchedules.length}
                className="btn-secondary btn-sm min-h-[44px]" title={otherSchedules.length ? 'Copy the layout from an earlier semester' : 'No other semester has a saved schedule yet'}>
                <Copy size={14} aria-hidden="true" /> Copy layout
              </button>
            </>
          )}
          <button type="button" onClick={() => window.print()} className="btn-secondary btn-sm min-h-[44px]" title="Print or save as PDF">
            <Printer size={14} aria-hidden="true" /> Print PDF
          </button>
        </div>
      </div>

      {loading || !doc ? (
        <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" /></div>
      ) : (
        <div className="cs-main">
          {/* ── Rail ── */}
          <aside className="cs-rail card p-3" aria-label="Classes">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-bold text-surface-900">Classes</h2>
              {canEdit && (
                <button type="button" onClick={() => setForm(f => (f?.mode === 'new' ? null : { mode: 'new' }))} className="btn-primary btn-sm min-h-[44px]">
                  <Plus size={14} aria-hidden="true" /> Unlisted class
                </button>
              )}
            </div>
            <div className="relative mb-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
              <input type="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }}
                placeholder="Filter: number, name, instructor, room" aria-label="Filter classes"
                className="input text-sm pl-8 pr-8 min-h-[44px]" />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear filter"
                  className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg text-surface-400 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="text-[11px] text-surface-500 mb-1" role="status" aria-live="polite">
              {query.trim() ? `${listCourses.shown.length} of ${listCourses.all.length} ${listCourses.all.length === 1 ? 'class' : 'classes'}` : `${listCourses.all.length} ${listCourses.all.length === 1 ? 'class' : 'classes'}`}
              {listCourses.elsewhere ? ` · ${listCourses.elsewhere} in the other half` : ''}
            </p>
            <p className="text-[11px] text-surface-500 leading-snug mb-2" aria-live="polite">{hint}</p>

            {brushCourse && brushMates.length > 0 && canEdit && (
              <div className="flex items-center justify-between gap-2 mb-2 px-2 py-1.5 rounded-lg bg-surface-50 border border-surface-200 text-xs">
                <span className="font-semibold text-surface-700 truncate"><Link2 size={12} className="inline mr-1" aria-hidden="true" />{brushCourse.code} + {brushMates.map(m => m.code).join(' + ')}</span>
                <div className="flex rounded-lg overflow-hidden border border-surface-200" role="group" aria-label="What to schedule">
                  <button type="button" onClick={() => setSoloMode(false)} aria-pressed={!soloMode} className={`px-2 min-h-[36px] text-[11px] font-medium ${!soloMode ? 'bg-brand-600 text-white' : 'bg-white text-surface-600'}`}>Both</button>
                  <button type="button" onClick={() => setSoloMode(true)} aria-pressed={soloMode} className={`px-2 min-h-[36px] text-[11px] font-medium ${soloMode ? 'bg-brand-600 text-white' : 'bg-white text-surface-600'}`}>{brushCourse.code} only</button>
                </div>
              </div>
            )}

            {form && canEdit && (
              <ClassForm
                key={form.mode === 'edit' ? form.id : 'new'}
                doc={doc} course={form.mode === 'edit' ? byId(doc, form.id) : null} view={view}
                onCancel={() => setForm(null)}
                onSave={(data, picked) => {
                  if (form.mode === 'edit') {
                    let saved = null
                    commit(d => {
                      const c = byId(d, form.id); if (!c) return
                      Object.assign(c, data)
                      if (c.span === 'both') {
                        const a = ensure(d, c.id)
                        for (let dd = 0; dd < 5; dd++) { const u = [...new Set([...a.A[dd], ...a.B[dd]])].sort((x, y) => x - y); a.A[dd] = u; a.B[dd] = [...u] }
                      }
                      setCombined(d, c.id, picked)
                      saved = { ...c }
                    })
                    if (saved && view !== 'both' && !termsOf(saved).includes(view)) setView(termsOf(saved)[0])
                  } else {
                    const created = addAdhoc(data)
                    if (created && picked.length) commit(d => setCombined(d, created.id, picked))
                    if (created) { setBrush(created.id); if (view !== 'both' && !termsOf(created).includes(view)) setView(termsOf(created)[0]) }
                  }
                  setForm(null)
                }}
              />
            )}

            <div className="cs-rail-scroll" role="list" aria-label="Class list">
              {listCourses.shown.length === 0 ? (
                <p className="text-xs text-surface-400 px-1 py-2">{query.trim() ? `Nothing matches "${query}" in this half.` : 'No classes run in this half yet.'}</p>
              ) : listCourses.shown.map(c => (
                <ClassCard key={c.id} doc={doc} c={c} query={query} selected={brush === c.id} canEdit={canEdit}
                  liveSch={drag && drag.targets?.includes(c.id) ? liveHours(doc, c, drag) : scheduledHours(doc, c)}
                  onLoad={() => loadBrush(c.id)} onEdit={() => setForm({ mode: 'edit', id: c.id })} onRemove={() => askRemove(c)} />
              ))}
            </div>
          </aside>

          {/* ── Board ── */}
          <main ref={boardRef} className={`cs-board ${!canEdit ? 'readonly' : eraser ? 'erasing' : brush ? 'painting' : ''}`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={() => updateDrag(null)}>
            <div className="cs-no-print flex items-center gap-3 flex-wrap mb-3">
              <div className="flex rounded-lg overflow-hidden border border-surface-200 bg-white" role="tablist" aria-label="Which half of the term to show">
                {[['A', 'First 8 weeks'], ['B', 'Second 8 weeks'], ['both', 'Both']].map(([v, l]) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => changeView(v)}
                    className={`px-3 min-h-[44px] text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${view === v ? 'bg-brand-600 text-white' : 'text-surface-600 hover:bg-surface-50'}`}>
                    {l}{v !== 'both' && <span className={`ml-1.5 text-[10px] px-1.5 rounded-full ${view === v ? 'bg-white/20' : 'bg-surface-100'}`}>{placedIn(doc, v)}</span>}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-surface-500">{view === 'both' ? '16-week classes appear in both halves.' : '16-week classes appear here and in the other half.'}</span>
            </div>

            <p className="text-[11px] text-surface-500 mb-2">
              <strong>{doc.semester}</strong>{query.trim() ? ` — showing only classes matching "${query.trim()}"` : ''} — 16-week classes appear in both halves.
            </p>

            {TERMS.filter(([t]) => view === 'both' || view === t).map(([t, label, sub]) => (
              <TermGrid key={t} doc={doc} term={t} label={label} sub={sub} flagged={conf.flagged} query={query} drag={drag} canEdit={canEdit} brush={brush} onLoad={loadBrush} />
            ))}
          </main>
        </div>
      )}

      {/* ── Dialogs ── */}
      <ConfirmDialog open={!!confirm} title={confirm?.title || ''} message={confirm?.message} confirmLabel={confirm?.confirmLabel}
        variant={confirm?.variant || 'danger'} onConfirm={confirm?.onConfirm} onClose={() => setConfirm(null)} />
      {copyOpen && doc && (
        <CopyLayoutDialog semester={doc.semester} others={otherSchedules} onClose={() => setCopyOpen(false)}
          onCopy={async (src) => {
            try {
              const r = await copyFromSemester(src)
              toast.success(`Copied ${r.copied} class${r.copied === 1 ? '' : 'es'} from ${src}${r.skipped ? ` · ${r.skipped} already had time and were left alone` : ''}`)
            } catch (e) { toast.error(e.message) }
            setCopyOpen(false)
          }} />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS CARD
// ═══════════════════════════════════════════════════════════════════════════════

function ClassCard({ doc, c, query, selected, canEdit, liveSch, onLoad, onEdit, onRemove }) {
  const st = meterState(c, liveSch)
  const ms = mates(doc, c)
  const sh = ms.length ? sharedHours(doc, c) : null
  const need = ms.length ? Math.min(c.hours || 0, ...ms.map(m => m.hours || 0)) : 0
  const pairBad = ms.length && need > 0 && sh < need
  const dim = query.trim() && !matches(c, query)
  return (
    <div role="listitem">
      <div className={`cs-cls ${selected ? 'sel' : ''} ${dim ? 'dim' : ''}`} style={{ '--hue': hueOf(c.color) }}
        role="button" tabIndex={0} aria-pressed={selected}
        aria-label={`${c.code} ${c.title}, ${c.instructor || 'no instructor'}, ${SPANS[c.span]}${c.delivery ? ', ' + c.delivery : ''}, ${hrs(liveSch)} of ${hrs(c.hours)} hours scheduled${selected ? ', loaded' : ''}`}
        onClick={onLoad} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLoad() } }}>
        <div className="cs-swatch" aria-hidden="true" />
        <div className="min-w-0">
          <div className="flex items-center flex-wrap">
            <span className="cs-code"><Mark text={c.code} query={query} /></span>
            <span className="cs-term">{SPANS[c.span]}</span>
            {c.adhoc && <span className="cs-adhoc">Unlisted</span>}
            {c.delivery === 'Online' && <span className="cs-delivery online">Online</span>}
            {c.delivery === 'Face-to-Face' && <span className="cs-delivery f2f">Face-to-Face</span>}
            {c.status && c.status !== 'Active' && <span className="cs-badge-inactive">{c.status}</span>}
          </div>
          <div className="cs-name"><Mark text={c.title} query={query} /></div>
          <div className="cs-meta"><Mark text={c.instructor || '—'} query={query} />{c.room ? <span className="cs-room"><Mark text={c.room} query={query} /></span> : null}</div>
          {ms.length > 0 && (
            <div className={`cs-pair ${pairBad ? 'short' : ''}`}>
              <Link2 size={11} aria-hidden="true" />
              <span className="font-semibold">{ms.map(m => m.code).join(' + ')}</span>
              <span className="tabular-nums">{hrs(sh)}{need ? ' of ' + hrs(need) : ''} hr together{liveSch > sh ? ` · ${hrs(liveSch - sh)} solo` : ''}</span>
            </div>
          )}
          {c.note && <div className="cs-memo"><Mark text={c.note} query={query} /></div>}
          <div className={`cs-meter ${st.cls} ${liveSch !== scheduledHours(doc, c) ? 'live' : ''}`}>
            <div className="cs-track"><div className="cs-fill" style={{ width: `${st.pct}%` }} /></div>
            <span className="cs-num">{hrs(st.sch)} / {hrs(st.need)} hr</span>
          </div>
          <div className="cs-meter-note">{c.delivery === 'Online' && !c.hours ? 'online — no lab time needed' : st.note}</div>
        </div>
        {canEdit && (
          <div className="cs-acts" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <button type="button" className="cs-icon" aria-label={`Edit ${c.code}`} title="Edit" onClick={onEdit}><Pencil size={14} aria-hidden="true" /></button>
            <button type="button" className="cs-icon del" aria-label={c.adhoc ? `Remove ${c.code}` : `Clear all blocks for ${c.code}`} title={c.adhoc ? 'Remove' : 'Clear blocks'} onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TERM GRID
// ═══════════════════════════════════════════════════════════════════════════════

function TermGrid({ doc, term, label, sub, flagged, query, drag, canEdit, brush, onLoad }) {
  const SH = doc.startHour, EH = doc.endHour, n = (EH - SH) * 2, H = n * SLOT_PX
  const placed = placedIn(doc, term)
  const previewFor = (day) => {
    if (!drag || drag.term !== term || drag.day !== day) return null
    let a, b, erase = false
    if (drag.mode === 'resize') { a = drag.edge === 'top' ? (drag.newStart ?? drag.start) : drag.start; b = drag.edge === 'top' ? drag.end : (drag.newEnd ?? drag.end) }
    else { a = drag.start; b = drag.end; erase = drag.erase }
    if (drag.armed) return null
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const c = drag.cid ? byId(doc, drag.cid) : null
    let span = (hi - lo + 1) * 0.5, full = false, sign = erase ? '−' : '+'
    if (c) {
      const delta = liveHours(doc, c, drag) - scheduledHours(doc, c)
      full = dayAfter(doc, c, drag.day, dragOps(drag)).capped
      sign = delta < 0 ? '−' : '+'
      span = Math.abs(delta)
    }
    return { lo, hi, erase, label: `${fmtRange(lo, hi)}`, delta: `${sign}${hrs(span)} hr`, full }
  }
  return (
    <section className="cs-term" aria-label={`${label}, ${doc.semester}`}>
      <div className="cs-term-head"><h3>{label}</h3><span className="sub">{sub}</span><span className="count">{placed} class{placed === 1 ? '' : 'es'} placed</span></div>
      <div className="cs-grid">
        <div className="cs-dhead gut" aria-hidden="true" />
        {DAYS.map(d => <div key={d} className="cs-dhead">{d}</div>)}
        <div className="cs-gutcol" style={{ height: H }} aria-hidden="true">
          {Array.from({ length: EH - SH + 1 }, (_, i) => {
            const h = SH + i, ap = h >= 12 ? 'pm' : 'am', hh = h % 12 === 0 ? 12 : h % 12
            return <div key={h} className="cs-tick" style={{ top: i * SLOT_PX * 2 }}>{hh}{ap}</div>
          })}
        </div>
        {DAYS.map((_, d) => {
          const segs = segments(doc, term, d).filter(s => s.end >= SH * 2 && s.start < EH * 2)
          const lanes = layoutLanes(segs)
          const pv = previewFor(d)
          return (
            <div key={d} className="cs-daycol" data-term={term} data-day={d} style={{ height: H }} aria-label={`${DAYS[d]}, ${label}`}>
              {segs.map(s => {
                const c = byId(doc, s.cid); if (!c) return null
                const top = (Math.max(s.start, SH * 2) - SH * 2) * SLOT_PX
                const hgt = (Math.min(s.end + 1, EH * 2) - Math.max(s.start, SH * 2)) * SLOT_PX - 2
                const L = lanes.get(s), w = 100 / L.of, left = L.i * w
                let bad = false
                for (let k = s.start; k <= s.end; k++) if (flagged.has(term + '|' + d + '|' + s.cid + '|' + k)) { bad = true; break }
                const size = hgt < 30 ? ' compact' : hgt < 50 ? ' mid' : ''
                const dim = query.trim() && !matches(c, query) ? ' dim' : ''
                const ms = mates(doc, c)
                const title = `${c.code} ${c.title} · ${fmtRange(s.start, s.end)} · ${c.instructor}${c.room ? ' · Rm ' + c.room : ''}${ms.length ? ' · combined with ' + ms.map(m => `${m.code} (Rm ${m.room || '?'})`).join(', ') : ''}${bad ? ' · CONFLICT' : ''}`
                return (
                  <div key={`${s.cid}-${s.start}`} className={`cs-blk${size}${bad ? ' conf' : ''}${dim}`}
                    style={{ '--hue': hueOf(c.color), top, height: hgt, left: `calc(${left}% + 1px)`, width: `calc(${w}% - 3px)` }}
                    data-cid={c.id} data-term={term} data-day={d} data-start={s.start} data-end={s.end}
                    title={title} role={canEdit ? 'button' : undefined} tabIndex={canEdit ? 0 : undefined}
                    aria-label={title} aria-pressed={canEdit ? brush === c.id : undefined}
                    onKeyDown={canEdit ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLoad(c.id) } } : undefined}>
                    {canEdit && <button type="button" className="x cs-no-print" aria-label={`Clear ${c.code} ${DAYS[d]} ${fmtRange(s.start, s.end)}`} title="Clear this block" tabIndex={-1}>✕</button>}
                    <div className="bc">{ms.length ? <Link2 size={10} className="inline mr-0.5 -mt-0.5" aria-hidden="true" /> : null}{c.code}</div>
                    <div className="bt">{c.title}</div>
                    {c.note && <div className="bn">{c.note}</div>}
                    <div className="bm">{c.instructor}{c.room ? ' · ' + c.room : ''} · {fmtRange(s.start, s.end)}</div>
                    {canEdit && <><div className="rz top cs-no-print" title="Drag to change the start time" /><div className="rz cs-no-print" title="Drag to change the end time" /></>}
                  </div>
                )
              })}
              {pv && (
                <div className={`cs-preview ${pv.erase ? 'erase' : ''}`} style={{ top: (pv.lo - SH * 2) * SLOT_PX, height: (pv.hi - pv.lo + 1) * SLOT_PX - 2 }} aria-hidden="true">
                  <span>{pv.label}<br /><b>{pv.delta}</b>{pv.full && <span className="cap">at full hours</span>}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS FORM (inline in the rail)
// ═══════════════════════════════════════════════════════════════════════════════

function ClassForm({ doc, course, view, onCancel, onSave }) {
  const uid = useId()
  const isNew = !course
  const linked = !!course && !course.adhoc
  const [f, setF] = useState(() => course
    ? { code: course.code, title: course.title, instructor: course.instructor, hours: course.hours, room: course.room, span: course.span, note: course.note, color: course.color }
    : { code: '', title: '', instructor: '', hours: 3, room: '', span: view === 'B' ? 'second' : 'first', note: '', color: HUES[doc.courses.length % HUES.length].k })
  const cur = course ? mates(doc, course).map(m => m.id) : []
  const [picked, setPicked] = useState(cur)
  const firstRef = useRef(null)
  useEffect(() => { firstRef.current?.focus() }, [])
  const others = doc.courses.filter(o => o.id !== course?.id && termsOf(o).some(t => termsOf({ span: f.span }).includes(t)))
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const submit = () => {
    if (!f.code.trim() && !f.title.trim()) { toast.error('Give the class a number or a name.'); return }
    const data = linked
      ? { room: f.room.trim(), span: f.span, note: f.note.trim(), color: f.color }
      : { code: f.code.trim(), title: f.title.trim(), instructor: f.instructor.trim(), hours: +f.hours || 0, room: f.room.trim(), span: f.span, note: f.note.trim(), color: f.color }
    onSave(data, picked)
  }
  return (
    <form className="mb-3 p-3 rounded-xl border border-brand-200 bg-brand-50/40 space-y-2" onSubmit={e => { e.preventDefault(); submit() }} aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="text-sm font-bold text-surface-900">{isNew ? 'New unlisted class' : `Edit ${course.code}`}</h3>
      {linked && (
        <p className="text-[11px] text-surface-500 flex items-start gap-1"><Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />Number, name, instructor and hours come from Settings → Classes. Room, term, notes, colour and combining are set here.</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${uid}-code`} className="text-[10px] text-surface-500 font-medium">Class number</label>
          <input id={`${uid}-code`} ref={!linked ? firstRef : null} value={f.code} onChange={e => set('code', e.target.value)} disabled={linked} placeholder="RICT1620" className="input text-sm min-h-[44px]" />
        </div>
        <div>
          <label htmlFor={`${uid}-room`} className="text-[10px] text-surface-500 font-medium">Room</label>
          <input id={`${uid}-room`} ref={linked ? firstRef : null} value={f.room} onChange={e => set('room', e.target.value)} placeholder="356" className="input text-sm min-h-[44px]" />
        </div>
      </div>
      <div>
        <label htmlFor={`${uid}-title`} className="text-[10px] text-surface-500 font-medium">Class name</label>
        <input id={`${uid}-title`} value={f.title} onChange={e => set('title', e.target.value)} disabled={linked} placeholder="Networking" className="input text-sm min-h-[44px]" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${uid}-inst`} className="text-[10px] text-surface-500 font-medium">Instructor</label>
          <input id={`${uid}-inst`} value={f.instructor} onChange={e => set('instructor', e.target.value)} disabled={linked} placeholder="A. Barker" className="input text-sm min-h-[44px]" />
        </div>
        <div>
          <label htmlFor={`${uid}-hours`} className="text-[10px] text-surface-500 font-medium">Hours / week</label>
          <input id={`${uid}-hours`} type="number" min="0" max="40" step="0.5" value={f.hours} onChange={e => set('hours', e.target.value)} disabled={linked} className="input text-sm min-h-[44px]" />
        </div>
      </div>
      <div>
        <label htmlFor={`${uid}-note`} className="text-[10px] text-surface-500 font-medium">Notes <span className="font-normal">(shown on the grid and the PDF)</span></label>
        <textarea id={`${uid}-note`} rows={2} value={f.note} onChange={e => set('note', e.target.value)} placeholder="Lab section, shared cart, guest week…" className="input text-sm resize-none" />
      </div>
      <div>
        <label htmlFor={`${uid}-span`} className="text-[10px] text-surface-500 font-medium">Runs</label>
        <select id={`${uid}-span`} value={f.span} onChange={e => set('span', e.target.value)} className="input text-sm min-h-[44px]">
          {Object.entries(SPAN_LONG).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <fieldset>
        <legend className="text-[10px] text-surface-500 font-medium">Combined with <span className="font-normal">(same time, different room)</span></legend>
        {others.length ? (
          <div className="max-h-32 overflow-y-auto border border-surface-200 rounded-lg bg-white divide-y divide-surface-100">
            {others.map(o => (
              <label key={o.id} className="flex items-center gap-2 px-2 min-h-[40px] text-xs cursor-pointer hover:bg-surface-50">
                <input type="checkbox" checked={picked.includes(o.id)} onChange={e => setPicked(p => (e.target.checked ? [...p, o.id] : p.filter(x => x !== o.id)))} className="w-4 h-4 rounded border-surface-300 text-brand-600 focus:ring-brand-500" />
                <b>{o.code}</b><span className="text-surface-500 truncate">{o.title}</span>
              </label>
            ))}
          </div>
        ) : <p className="text-[11px] text-surface-400 m-0">No other class runs in this half.</p>}
      </fieldset>
      <fieldset>
        <legend className="text-[10px] text-surface-500 font-medium">Colour</legend>
        <div className="flex flex-wrap gap-1.5">
          {HUES.map(h => (
            <button key={h.k} type="button" onClick={() => set('color', h.k)} aria-pressed={f.color === h.k} aria-label={h.k}
              className="w-7 h-7 rounded-full border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
              style={{ background: h.h, borderColor: f.color === h.k ? '#0f172a' : 'transparent' }} />
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="btn-secondary btn-sm min-h-[44px]">Cancel</button>
        <button type="submit" className="btn-primary btn-sm min-h-[44px]">{isNew ? 'Add class' : 'Save'}</button>
      </div>
    </form>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// COPY LAYOUT DIALOG
// ═══════════════════════════════════════════════════════════════════════════════

function CopyLayoutDialog({ semester, others, onClose, onCopy }) {
  const dialogRef = useDialogA11y(true, onClose)
  const uid = useId()
  const [src, setSrc] = useState(others[0]?.semester || '')
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={busy ? undefined : onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${uid}-t`} aria-describedby={`${uid}-d`}
        className="bg-white rounded-xl w-full max-w-md shadow-modal" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <h3 id={`${uid}-t`} className="font-semibold text-surface-900">Copy layout into {semester}</h3>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-surface-400 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p id={`${uid}-d`} className="text-xs text-surface-600">
            Classes in {semester} that have <strong>no time on the grid yet</strong> get the room, colour, notes, combined groups and blocks of the class with the same number from the semester you pick. Classes that already have time are left alone. You can change anything afterwards.
          </p>
          <div>
            <label htmlFor={`${uid}-src`} className="label text-xs">Copy from</label>
            <select id={`${uid}-src`} value={src} onChange={e => setSrc(e.target.value)} className="input text-sm min-h-[44px]">
              {others.map(o => <option key={o.schedule_id} value={o.semester}>{o.semester}</option>)}
            </select>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary btn-sm min-h-[44px]">Cancel</button>
          <button type="button" disabled={!src || busy} onClick={async () => { setBusy(true); await onCopy(src); setBusy(false) }} className="btn-primary btn-sm min-h-[44px]">
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} Copy
          </button>
        </div>
      </div>
    </div>
  )
}
