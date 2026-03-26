import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  GraduationCap, Plus, Printer, X, ChevronRight, ChevronLeft,
  Search, Trash2, Save, Check, AlertCircle, BookOpen, RefreshCw,
  StickyNote, Sun, PlusCircle, Copy,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ─── Constants ────────────────────────────────────────────────────────────────
const PROGRAMS = [
  { id: 'IPC-AAS',   name: 'Instrumentation & Process Control AAS',  color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { id: 'MECH-AAS',  name: 'Mechatronics AAS',                        color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { id: 'MECH-CERT', name: 'Mechatronics Certificate',                color: 'bg-violet-100 text-violet-700 border-violet-200' },
]
const PROGRAM_COLORS = {
  'IPC-AAS':   { bg: 'bg-blue-100',    text: 'text-blue-700',    border: 'border-blue-300' },
  'MECH-AAS':  { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-300' },
  'MECH-CERT': { bg: 'bg-violet-100',  text: 'text-violet-700',  border: 'border-violet-300' },
}
const SEMESTERS_LIST = [
  'Fall 2025','Spring 2026','Summer 2026',
  'Fall 2026','Spring 2027','Summer 2027',
  'Fall 2027','Spring 2028','Summer 2028',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a numeric sort key for chronological ordering.
 * Spring 2026 (1) < Summer 2026 (2) < Fall 2026 (3) < Spring 2027 (11) < ...
 */
function semesterSortKey(label) {
  const parts = (label || '').trim().split(' ')
  const term = parts[0]
  const year = parseInt(parts[1]) || 0
  const order = term === 'Spring' ? 1 : term === 'Summer' ? 2 : 3
  return year * 10 + order
}

function sortSemestersChronologically(sems) {
  return [...sems].sort((a, b) => semesterSortKey(a.label) - semesterSortKey(b.label))
}

/**
 * "Add Semester" — cycles Fall then Spring only. Summer is never auto-inserted.
 *   Fall YYYY   → Spring YYYY+1
 *   Spring YYYY → Fall YYYY  (same year)
 *   Summer YYYY → Fall YYYY  (same year)
 */
function nextSemesterLabel(lastLabel) {
  const parts = (lastLabel || 'Fall 2026').trim().split(' ')
  const term = parts[0]
  const year = parseInt(parts[1]) || 2026
  if (term === 'Fall') return `Spring ${year + 1}`
  return `Fall ${year}`
}

function buildMergedPlan(masterSemesters, startSemester) {
  if (!masterSemesters?.length) return []

  const startTerm = startSemester.split(' ')[0]
  const startYear = parseInt(startSemester.split(' ')[1]) || 2026
  const rotateBy  = startTerm === 'Spring' ? 1 : 0

  const rotated = [...masterSemesters.slice(rotateBy), ...masterSemesters.slice(0, rotateBy)]

  // Label Fall/Spring only — correct academic-year progression:
  // Fall YYYY → Spring YYYY+1 → Fall YYYY+1 → Spring YYYY+2 → ...
  const termOrder = ['Fall', 'Spring']
  let termIdx = startTerm === 'Spring' ? 1 : 0
  let year = startYear

  return rotated.map((sem) => {
    const label = `${termOrder[termIdx]} ${year}`
    const result = { ...sem, label, _originalLabel: sem.label, courses: sem.courses || [] }
    const prevIdx = termIdx
    termIdx = (termIdx + 1) % 2
    if (prevIdx === 0) year++ // was Fall → next is Spring of NEXT year
    return result
  })
}

function mergePlannerSemesters(plannerSemestersA, plannerSemestersB) {
  const result = []
  const maxLen = Math.max(plannerSemestersA.length, plannerSemestersB.length)
  for (let i = 0; i < maxLen; i++) {
    const semA = plannerSemestersA[i] || { label: `Semester ${i+1}`, courses: [] }
    const semB = plannerSemestersB[i] || { courses: [] }
    const merged = []
    ;(semA.courses || []).forEach(c => {
      merged.push({ ...c, _programs: c.course_num ? [semA._programId || 'A'] : [] })
    })
    ;(semB.courses || []).forEach(c => {
      if (!c.course_num) return
      const existing = merged.find(m => m.course_num === c.course_num)
      if (existing) {
        if (!existing._programs.includes(semB._programId || 'B')) existing._programs.push(semB._programId || 'B')
      } else {
        merged.push({ ...c, _programs: [semB._programId || 'B'] })
      }
    })
    result.push({ ...semA, courses: merged })
  }
  return result
}

/**
 * Fix plans generated with old 3-term (Fall/Spring/Summer) rotation.
 * Relabels bad Summer semesters (those containing RICT courses) with correct Fall/Spring labels.
 * Intentional Gen-Ed-only Summers are preserved unchanged.
 * Returns { semesters: [...], migrated: boolean }
 */
function migrateLegacySummerSemesters(semesters, startSemester) {
  if (!semesters?.length) return { semesters: [], migrated: false }
  const raw = JSON.parse(JSON.stringify(semesters))
  const hasBadSummer = raw.some(sem =>
    sem.label?.toLowerCase().includes('summer') &&
    (sem.courses || []).some(c => (c.course_num || '').toUpperCase().startsWith('RICT'))
  )
  if (!hasBadSummer) return { semesters: raw, migrated: false }

  let startTerm = 'Fall', startYear = 2026
  if (startSemester) {
    const p = startSemester.trim().split(' ')
    startTerm = p[0] || 'Fall'; startYear = parseInt(p[1]) || 2026
  } else {
    const first = raw.find(s => !s.label?.toLowerCase().includes('summer'))
    if (first?.label) { const p = first.label.trim().split(' '); startTerm = p[0] || 'Fall'; startYear = parseInt(p[1]) || 2026 }
  }

  const termOrder = ['Fall', 'Spring']
  let termIdx = startTerm === 'Spring' ? 1 : 0, year = startYear

  const result = raw.map(sem => {
    const isSummer = sem.label?.toLowerCase().includes('summer')
    const isGoodSummer = isSummer && !(sem.courses||[]).some(c => (c.course_num||'').toUpperCase().startsWith('RICT'))
    if (isGoodSummer) return sem
    const label = `${termOrder[termIdx]} ${year}`
    const prevIdx = termIdx; termIdx = (termIdx + 1) % 2; if (prevIdx === 0) year++
    return { ...sem, label }
  })
  return { semesters: result, migrated: true }
}

// ─── DonutChart ───────────────────────────────────────────────────────────────
function DonutChart({ completed, total, size = 80 }) {
  const pct = total > 0 ? Math.min(1, completed / total) : 0
  const r = 26, circ = 2 * Math.PI * r, dash = circ * pct, gap = circ - dash
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="shrink-0">
      <circle cx="32" cy="32" r={r} fill="none" stroke="#e2e8f0" strokeWidth="9"/>
      {pct > 0 && (
        <circle cx="32" cy="32" r={r} fill="none" stroke="#16a34a" strokeWidth="9"
          strokeDasharray={`${dash.toFixed(2)} ${gap.toFixed(2)}`} strokeLinecap="round"
          transform="rotate(-90 32 32)" style={{ transition: 'stroke-dasharray 0.6s ease' }}/>
      )}
      <text x="32" y="29" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#0f172a">{Math.round(pct * 100)}%</text>
      <text x="32" y="40" textAnchor="middle" fontSize="7.5" fill="#94a3b8">done</text>
    </svg>
  )
}

// ─── Print helper ─────────────────────────────────────────────────────────────
function printPlan(plan, studentName) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const totalCr   = (plan.semesters||[]).reduce((s,sem)=>s+(sem.courses||[]).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
  const doneCr    = (plan.semesters||[]).reduce((s,sem)=>s+(sem.courses||[]).filter(c=>c.completed).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
  const pct = totalCr > 0 ? Math.round((doneCr/totalCr)*100) : 0
  const printedDate = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})

  const semHtml = (plan.semesters||[]).map(sem => {
    const isSummer = sem.label?.toLowerCase().includes('summer')
    const semTotal = (sem.courses||[]).reduce((s,c)=>s+(parseFloat(c.credits)||0),0)
    const rows = (sem.courses||[]).filter(c=>c.course_num||c.course_title).map(c=>`
      <tr class="${c.completed?'done':''}">
        <td style="text-align:center">${c.completed?'✓':'○'}</td>
        <td>${esc(c.course_num)}</td>
        <td>${esc(c.course_title)}${c._programs?.length>1?'<span class="shared"> ★ Shared</span>':''}</td>
        <td>${esc(c.prerequisites)}</td>
        <td class="cr">${esc(c.credits)}</td>
        <td>${esc(c.offered)}</td>
      </tr>`).join('')
    const doneCount = (sem.courses||[]).filter(c=>(c.course_num||c.course_title)&&c.completed).length
    const totalRows = (sem.courses||[]).filter(c=>c.course_num||c.course_title).length
    const doneLabel = doneCount > 0 ? ` — ${doneCount}/${totalRows} complete` : ''
    if (!rows) return ''
    return `
      <div class="sem ${isSummer?'sem-summer':''}">
        <div class="sem-head"><span>${esc(sem.label)}${doneLabel}${isSummer?' ☀ Gen Ed Only':''}</span><span>${semTotal} cr</span></div>
        ${isSummer?'<div class="summer-note">Summer — General Education courses only. No RICT program courses offered in summer.</div>':''}
        <table>
          <thead><tr><th style="width:22px;text-align:center">✓</th><th>Course #</th><th>Course Title</th><th>Prerequisites</th><th class="cr">Cr</th><th>Offered</th></tr></thead>
          <tbody>${rows}<tr class="sem-total"><td></td><td colspan="3" style="text-align:right;font-weight:bold">Semester Total</td><td class="cr">${semTotal}</td><td></td></tr></tbody>
        </table>
      </div>`
  }).join('')

  const progressHtml = totalCr > 0 ? `
    <div class="progress-section">
      <div class="progress-row"><span>Progress: <strong>${doneCr} of ${totalCr} credits complete (${pct}%)</strong></span><span>${totalCr-doneCr} cr remaining</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>` : ''

  const html = `<!DOCTYPE html><html><head><title>Program Plan — ${esc(studentName)}</title>
  <style>
    *{box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:10pt;margin:0.6in;color:#111}
    h1{font-size:16pt;margin:0 0 2px;color:#1e3a8a}
    .meta{display:flex;gap:20px;font-size:9pt;color:#555;margin-bottom:4px;flex-wrap:wrap}.meta span b{color:#111}
    .meta-sub{font-size:8pt;color:#94a3b8;margin-bottom:12px}
    .progress-section{margin-bottom:16px;padding:8px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:5px}
    .progress-row{display:flex;justify-content:space-between;font-size:9pt;margin-bottom:5px}
    .progress-track{height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden}
    .progress-fill{height:8px;background:#16a34a;border-radius:4px}
    .sem{margin-bottom:18px;break-inside:avoid}
    .sem-head{display:flex;justify-content:space-between;background:#1e3a8a;color:white;padding:5px 8px;font-weight:bold;font-size:10pt;border-radius:3px 3px 0 0}
    .sem-summer .sem-head{background:#b45309}
    .summer-note{font-size:8pt;color:#92400e;background:#fef3c7;border:1px solid #fde68a;padding:4px 8px;font-style:italic}
    table{width:100%;border-collapse:collapse;font-size:9pt}
    th{background:#dbeafe;padding:4px 6px;text-align:left;border:1px solid #93c5fd}
    td{padding:4px 6px;border:1px solid #ddd;vertical-align:top}.cr{text-align:center;width:48px}
    .sem-total td{background:#f0f9ff}.shared{font-size:7.5pt;color:#7c3aed;margin-left:4px}
    tr.done td{color:#888;text-decoration:line-through;background:#f0fdf4}
    tr.done td:first-child{text-decoration:none;color:#16a34a;font-weight:bold}
    .total{margin-top:12px;font-size:11pt;font-weight:bold;text-align:right;color:#1e3a8a}
    .dar-note{margin-top:14px;padding:7px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;font-size:8pt;color:#64748b}
    .dar-note b{color:#334155}
    @media print{body{margin:0.5in}.sem{break-inside:avoid}}
  </style></head><body>
  <h1>Program Plan — ${esc(studentName)}</h1>
  <div class="meta">
    <span><b>Programs:</b> ${esc((plan.programs||[]).map(pid=>PROGRAMS.find(p=>p.id===pid)?.name||pid).join(', '))}</span>
    <span><b>Start:</b> ${esc(plan.start_semester)}</span>
    <span><b>Plan:</b> ${esc(plan.plan_name||'My Plan')}</span>
    <span><b>Total Credits:</b> ${totalCr}</span>
  </div>
  <div class="meta-sub">Student: ${esc(plan.student_email||'')} &nbsp;|&nbsp; Printed: ${printedDate}</div>
  ${progressHtml}${semHtml}
  <div class="total">Total Program Credits: ${totalCr}</div>
  <div class="dar-note"><b>Note:</b> This plan is for advising purposes only and does not replace an official Degree Audit Report (DAR). Contact your instructor or advisor to request a DAR through the college's student records system.</div>
  </body></html>`

  const w = window.open('','_blank')
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(),300) }
}

// ─── DeleteSemesterDialog ─────────────────────────────────────────────────────
function DeleteSemesterDialog({ semester, onConfirm, onCancel }) {
  const courseCount = (semester.courses||[]).filter(c=>c.course_num||c.course_title).length
  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center shrink-0">
            <Trash2 size={18} className="text-red-600"/>
          </div>
          <div>
            <h3 className="text-sm font-bold text-surface-900">Remove Semester</h3>
            <p className="text-xs text-surface-500">{semester.label}</p>
          </div>
        </div>
        {courseCount > 0 ? (
          <p className="text-sm text-surface-700 mb-5">
            This semester has <strong>{courseCount} course{courseCount !== 1 ? 's' : ''}</strong> in it.
            Removing it will delete all courses from this semester in the plan.
            <span className="block mt-1.5 text-xs text-red-600 font-medium">This is undoable by closing without saving.</span>
          </p>
        ) : (
          <p className="text-sm text-surface-700 mb-5">Remove the empty <strong>{semester.label}</strong> semester from this plan?</p>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 text-sm border border-surface-200 text-surface-600 rounded-lg hover:bg-surface-50">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700">Remove Semester</button>
        </div>
      </div>
    </div>
  )
}

// ─── PlanEditorModal ──────────────────────────────────────────────────────────
function PlanEditorModal({ plan, onSave, onClose }) {
  const [wasMigrated, setWasMigrated] = useState(false)
  const [semesters, setSemesters] = useState(() => {
    const raw = JSON.parse(JSON.stringify(plan.semesters || []))
    const { semesters: cleaned, migrated } = migrateLegacySummerSemesters(raw, plan.start_semester)
    if (migrated) setWasMigrated(true)
    return cleaned
  })
  const [saving, setSaving] = useState(false)
  const dragSrc  = useRef(null)
  const [dropTarget, setDropTarget] = useState(null)
  const [showSummerPicker, setShowSummerPicker] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null) // index of semester pending deletion

  // Credit validation
  const totalCredits = semesters.reduce((s,sem)=>s+(sem.courses||[]).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
  const creditWarning = totalCredits > 0 && (totalCredits < 55 || totalCredits > 72)
    ? totalCredits < 55
      ? `Only ${totalCredits} total credits — typical AAS programs require 60–65 cr.`
      : `${totalCredits} total credits — exceeds the typical AAS range (60–65 cr). Verify this is intentional.`
    : null

  const updRow = (si,ri,field,val) => setSemesters(prev=>prev.map((s,i)=>i!==si?s:{...s,courses:s.courses.map((c,j)=>j!==ri?c:{...c,[field]:val})}))
  const delRow = (si,ri) => setSemesters(prev=>prev.map((s,i)=>i!==si?s:{...s,courses:s.courses.filter((_,j)=>j!==ri)}))
  const addRow = (si) => setSemesters(prev=>prev.map((s,i)=>i!==si?s:{...s,courses:[...s.courses,{course_num:'',course_title:'',prerequisites:'',credits:'',offered:''}]}))

  // ── Semester management ──────────────────────────────────────────────────
  const addSemester = () => {
    const sorted = sortSemestersChronologically(semesters)
    const lastRegular = [...sorted].reverse().find(s => !s.label?.toLowerCase().includes('summer'))
    const lastLabel = lastRegular?.label || (sorted.length ? sorted[sorted.length-1].label : 'Fall 2026')
    const newLabel = nextSemesterLabel(lastLabel)
    if (semesters.some(s => s.label === newLabel)) { toast.error(`${newLabel} already exists`); return }
    setSemesters(prev => sortSemestersChronologically([...prev, { label: newLabel, courses: [] }]))
    toast.success(`Added ${newLabel}`)
  }

  const addSummerSemester = (year) => {
    const label = `Summer ${year}`
    if (semesters.some(s => s.label === label)) { toast.error(`${label} already exists`); return }
    setSemesters(prev => sortSemestersChronologically([...prev, { label, courses: [] }]))
    toast.success(`Added ${label} — add Gen Ed courses manually or drag them in`)
    setShowSummerPicker(false)
  }

  const doDeleteSemester = () => {
    if (deleteConfirm === null) return
    const label = semesters[deleteConfirm]?.label
    setSemesters(prev => prev.filter((_,i) => i !== deleteConfirm))
    setDeleteConfirm(null)
    toast(`Removed ${label}`, { icon: '🗑️' })
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const handleDragStart = (e,si,ri) => { dragSrc.current={si,ri}; e.dataTransfer.effectAllowed='move' }
  const handleDragOver  = (e,si,ri) => { e.preventDefault(); setDropTarget({si,ri}) }
  const handleDrop = (e,toSi,toRi) => {
    e.preventDefault(); setDropTarget(null)
    const src = dragSrc.current
    if (!src||(src.si===toSi&&src.ri===toRi)) return
    const dragged = semesters[src.si]?.courses[src.ri]
    if (!dragged) return
    setSemesters(prev => {
      const next = prev.map(s=>({...s,courses:[...s.courses]}))
      next[src.si].courses.splice(src.ri,1)
      const adjRi = src.si===toSi&&src.ri<toRi ? toRi-1 : toRi
      next[toSi].courses.splice(Math.max(0,adjRi),0,dragged)
      return next
    })
    dragSrc.current = null
  }

  const handleSave = async () => {
    setSaving(true)
    await onSave(sortSemestersChronologically(semesters))
    setSaving(false)
    setWasMigrated(false)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-start justify-center p-3 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-4">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <div>
            <h2 className="text-base font-bold text-surface-900">Edit Plan — {plan.student_name}</h2>
            <p className="text-xs text-surface-400 mt-0.5">Drag ⠿ to reorder courses. Semesters auto-sort chronologically on save.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>printPlan({...plan,semesters},plan.student_name)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50">
              <Printer size={13}/> Print
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50">
              <Save size={13}/>{saving ? 'Saving…' : 'Save Plan'}
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg">
              <X size={16} className="text-surface-400"/>
            </button>
          </div>
        </div>

        {/* ── Migration banner ── */}
        {wasMigrated && (
          <div className="mx-6 mt-4 flex items-start gap-3 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
            <span className="text-lg shrink-0">🔧</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-amber-800">Semester labels auto-corrected</p>
              <p className="text-xs text-amber-700 mt-0.5">
                This plan was created with an older semester rotation. Labels have been corrected to the proper Fall/Spring sequence.
                Review the semesters below, then save to make the fix permanent.
              </p>
            </div>
            <button onClick={handleSave} disabled={saving}
              className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50">
              Save Now
            </button>
          </div>
        )}

        {/* ── Credit warning ── */}
        {creditWarning && (
          <div className="mx-6 mt-3 flex items-center gap-2 bg-yellow-50 border border-yellow-300 rounded-xl px-4 py-2.5">
            <AlertCircle size={14} className="text-yellow-600 shrink-0"/>
            <p className="text-xs text-yellow-800">{creditWarning}</p>
          </div>
        )}

        {/* ── Semester list ── */}
        <div className="px-6 py-5 space-y-5">
          {semesters.map((sem, si) => {
            const isSummer = sem.label?.toLowerCase().includes('summer')
            const semTotal = (sem.courses||[]).reduce((s,c)=>s+(parseFloat(c.credits)||0),0)
            return (
              <div key={`${sem.label}-${si}`} className={`border rounded-xl overflow-hidden ${isSummer?'border-amber-300':'border-surface-200'}`}>

                {/* Semester header */}
                <div className={`border-b px-4 py-2.5 flex items-center justify-between gap-2 ${isSummer?'bg-amber-50 border-amber-200':'bg-brand-50 border-surface-200'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {isSummer && <Sun size={13} className="text-amber-500 shrink-0"/>}
                    <p className={`text-xs font-bold ${isSummer?'text-amber-700':'text-brand-700'}`}>{sem.label}</p>
                    {isSummer && (
                      <span className="text-[10px] font-semibold text-amber-600 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded-full shrink-0">
                        ☀ Gen Ed only — No RICT courses
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(sem.courses||[]).some(c=>c.completed) && (
                      <span className="text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">
                        {(sem.courses||[]).filter(c=>c.completed).length}/{(sem.courses||[]).filter(c=>c.course_num||c.course_title).length} complete
                      </span>
                    )}
                    <span className="text-xs text-surface-400">{semTotal} credits</span>
                    <button onClick={()=>setDeleteConfirm(si)} title={`Remove ${sem.label}`}
                      className="p-1 rounded-lg text-surface-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <Trash2 size={12}/>
                    </button>
                  </div>
                </div>

                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-surface-200">
                      <th className="p-2 w-5"/>
                      <th className="text-center p-2 font-semibold text-surface-600 w-[7%]">Done</th>
                      <th className="text-left p-2 font-semibold text-surface-600 w-[13%]">Course #</th>
                      <th className="text-left p-2 font-semibold text-surface-600 w-[28%]">Course Title</th>
                      <th className="text-left p-2 font-semibold text-surface-600 w-[24%]">Prerequisites</th>
                      <th className="text-center p-2 font-semibold text-surface-600 w-[8%]">Credits</th>
                      <th className="text-center p-2 font-semibold text-surface-600 w-[10%]">Offered</th>
                      <th className="p-2 w-7"/>
                    </tr>
                  </thead>
                  <tbody>
                    {(sem.courses||[]).length === 0 && (
                      <tr>
                        <td colSpan={8}
                          onDragOver={e=>{e.preventDefault();setDropTarget({si,ri:0})}}
                          onDrop={e=>handleDrop(e,si,0)} onDragLeave={()=>setDropTarget(null)}
                          className={`h-10 text-center text-xs italic ${dropTarget?.si===si?'bg-brand-50 text-brand-400':'text-surface-300'}`}>
                          {dropTarget?.si===si ? '↓ Drop here' : 'Drop a course here or click + Add course below'}
                        </td>
                      </tr>
                    )}
                    {(sem.courses||[]).map((course, ri) => {
                      const isShared = course._programs?.length > 1
                      return (
                        <tr key={ri} draggable
                          onDragStart={e=>handleDragStart(e,si,ri)} onDragOver={e=>handleDragOver(e,si,ri)}
                          onDrop={e=>handleDrop(e,si,ri)} onDragLeave={()=>setDropTarget(null)}
                          onDragEnd={()=>{dragSrc.current=null;setDropTarget(null)}}
                          className={`border-b border-surface-100 last:border-0 transition-colors
                            ${dropTarget?.si===si&&dropTarget?.ri===ri?'bg-brand-50 border-t-2 border-t-brand-400':''}
                            ${course.completed?'bg-emerald-50/50':isShared?'bg-violet-50/30':'hover:bg-surface-50/50'}`}>
                          <td className="pl-2 pr-0 cursor-grab select-none text-surface-300 hover:text-brand-400">
                            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                              <circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/>
                              <circle cx="2.5" cy="7" r="1.5"/><circle cx="7.5" cy="7" r="1.5"/>
                              <circle cx="2.5" cy="11.5" r="1.5"/><circle cx="7.5" cy="11.5" r="1.5"/>
                            </svg>
                          </td>
                          <td className="p-1 text-center">
                            <button onClick={()=>updRow(si,ri,'completed',!course.completed)}
                              title={course.completed?'Mark incomplete':'Mark complete'}
                              className={`w-6 h-6 rounded-full border-2 flex items-center justify-center mx-auto transition-colors
                                ${course.completed?'bg-emerald-500 border-emerald-500 text-white':'border-surface-300 hover:border-emerald-400 text-transparent'}`}>
                              <Check size={11}/>
                            </button>
                          </td>
                          <td className="p-1">
                            <input value={course.course_num||''} onChange={e=>updRow(si,ri,'course_num',e.target.value.toUpperCase())}
                              className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 uppercase"/>
                          </td>
                          <td className="p-1">
                            <div className="flex items-center gap-1">
                              <input value={course.course_title||''} onChange={e=>updRow(si,ri,'course_title',e.target.value)}
                                className={`flex-1 px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 ${course.completed?'line-through text-surface-400':''}`}/>
                              {isShared && <span className="text-[9px] font-bold text-violet-600 bg-violet-100 px-1 rounded shrink-0">★</span>}
                            </div>
                          </td>
                          <td className="p-1">
                            <input value={course.prerequisites||''} onChange={e=>updRow(si,ri,'prerequisites',e.target.value)}
                              className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"/>
                          </td>
                          <td className="p-1">
                            <input value={course.credits||''} onChange={e=>updRow(si,ri,'credits',e.target.value)}
                              className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded text-center focus:outline-none focus:ring-1 focus:ring-brand-400"/>
                          </td>
                          <td className="p-1 text-center text-surface-500">{course.offered||''}</td>
                          <td className="p-1 text-center">
                            <button onClick={()=>delRow(si,ri)} className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500 transition-colors">
                              <Trash2 size={11}/>
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="px-4 py-2 border-t border-surface-100 flex items-center justify-between">
                  <button onClick={()=>addRow(si)} className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium">
                    <Plus size={11}/> Add course
                  </button>
                  <span className="text-xs font-semibold text-surface-500">Total: {semTotal} cr</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Footer: Add Semester controls ── */}
        <div className="px-6 pb-5 pt-0 border-t border-surface-100 pt-4 flex flex-wrap items-center gap-2">
          <button onClick={addSemester}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-brand-300 bg-brand-50 text-brand-700 rounded-lg hover:bg-brand-100 transition-colors">
            <PlusCircle size={13}/> Add Semester
          </button>

          <div className="relative">
            <button onClick={()=>setShowSummerPicker(p=>!p)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-amber-300 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 transition-colors">
              <Sun size={13}/> Add Summer Semester
              <ChevronRight size={11} className={`transition-transform ${showSummerPicker?'rotate-90':''}`}/>
            </button>
            {showSummerPicker && (
              <div className="absolute bottom-full mb-1.5 left-0 bg-white border border-amber-200 rounded-xl shadow-xl p-2 z-20 min-w-[180px]">
                <p className="text-[10px] font-semibold text-amber-600 px-2 pb-1.5 border-b border-amber-100 mb-1">
                  ☀ Pick a summer year — inserts in order
                </p>
                {[2025,2026,2027,2028,2029,2030].map(yr => {
                  const label = `Summer ${yr}`
                  const exists = semesters.some(s=>s.label===label)
                  return (
                    <button key={yr} onClick={()=>addSummerSemester(yr)} disabled={exists}
                      className={`w-full text-left px-2 py-1.5 text-xs rounded-lg transition-colors ${exists?'text-surface-300 cursor-not-allowed':'text-amber-700 hover:bg-amber-50'}`}>
                      {label}{exists?' ✓ added':''}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <p className="ml-auto text-[11px] text-surface-400 italic hidden lg:block">
            Summer = Gen Ed only. Semesters auto-sort on save.
          </p>
        </div>
      </div>

      {deleteConfirm !== null && (
        <DeleteSemesterDialog
          semester={semesters[deleteConfirm]}
          onConfirm={doDeleteSemester}
          onCancel={()=>setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}

// ─── NewPlanModal ─────────────────────────────────────────────────────────────
function NewPlanModal({ onCreated, onClose }) {
  const { user } = useAuth()
  const [students, setStudents] = useState([])
  const [masterPlanners, setMasterPlanners] = useState([])
  const [form, setForm] = useState({ student_email:'', student_name:'', plan_name:'', programs:[], start_semester:'Fall 2026' })
  const [saving, setSaving] = useState(false)
  const [studentSearch, setStudentSearch] = useState('')

  useEffect(() => {
    supabase.from('profiles').select('email,first_name,last_name').in('role',['Student','Work Study']).eq('status','Active')
      .then(({data})=>setStudents(data||[]))
    supabase.from('program_revisions').select('revision_id,course_id,current_program_name,planner_semesters,planner_name')
      .eq('status','approved').not('planner_semesters','is',null).then(({data})=>setMasterPlanners(data||[]))
  }, [])

  const filteredStudents = students.filter(s =>
    `${s.first_name} ${s.last_name} ${s.email}`.toLowerCase().includes(studentSearch.toLowerCase())
  )

  const handleCreate = async () => {
    if (!form.student_email||!form.programs.length||!form.start_semester) {
      toast.error('Select a student, at least one program, and a start semester'); return
    }
    setSaving(true)
    try {
      const plannersByProgram = form.programs.map(pid => {
        const prog = PROGRAMS.find(p=>p.id===pid)
        const planner = masterPlanners.find(p=>
          p.current_program_name?.toLowerCase().includes(prog.name.toLowerCase().split(' ')[0]) ||
          p.course_id?.toLowerCase()===pid.toLowerCase()
        )
        return { pid, planner }
      })

      let mergedSems = []
      plannersByProgram.forEach(({ pid, planner }) => {
        if (!planner?.planner_semesters) return
        const rotated = buildMergedPlan(planner.planner_semesters, form.start_semester)
        if (!mergedSems.length) {
          mergedSems = rotated.map(s=>({...s,_programId:pid,courses:(s.courses||[]).map(c=>({...c,_programs:[pid]}))}))
        } else {
          const b = rotated.map(s=>({...s,_programId:pid,courses:(s.courses||[]).map(c=>({...c,_programs:[pid]}))}))
          mergedSems = mergePlannerSemesters(mergedSems, b)
        }
      })

      if (!mergedSems.length) {
        mergedSems = [0,1,2,3].map(i => {
          const termOrder=['Fall','Spring']
          const st = form.start_semester.split(' ')[0]
          let ti = st==='Spring'?1:0, yr=parseInt(form.start_semester.split(' ')[1])||2026
          for(let j=0;j<i;j++){const p=ti;ti=(ti+1)%2;if(p===0)yr++}
          return {label:`${termOrder[ti]} ${yr}`,courses:[]}
        })
      }

      const planId = 'PLAN-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase()
      const { error } = await supabase.from('student_program_plans').insert({
        plan_id: planId,
        student_email: form.student_email, student_name: form.student_name,
        plan_name: form.plan_name||`${form.student_name} — ${form.programs.map(pid=>PROGRAMS.find(p=>p.id===pid)?.name||pid).join(' + ')}`,
        programs: form.programs, start_semester: form.start_semester,
        semesters: sortSemestersChronologically(mergedSems),
        created_by: user?.email||'', updated_at: new Date().toISOString(),
      }).select()
      if (error) throw error
      toast.success('Plan created!'); onCreated(); onClose()
    } catch(err) { toast.error('Failed: '+err.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <h2 className="text-base font-bold text-surface-900">New Student Plan</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg"><X size={16} className="text-surface-400"/></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-surface-700 mb-1.5">Student <span className="text-red-500">*</span></label>
            <div className="relative mb-1.5">
              <Search size={13} className="absolute left-2.5 top-2.5 text-surface-400"/>
              <input value={studentSearch} onChange={e=>setStudentSearch(e.target.value)} placeholder="Search students…"
                className="w-full pl-7 pr-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40"/>
            </div>
            <div className="border border-surface-200 rounded-lg max-h-36 overflow-y-auto">
              {filteredStudents.length===0
                ? <p className="text-xs text-surface-400 italic p-3">No students found</p>
                : filteredStudents.map(s=>(
                    <button key={s.email} onClick={()=>{setForm(p=>({...p,student_email:s.email,student_name:`${s.first_name} ${s.last_name}`}));setStudentSearch(`${s.first_name} ${s.last_name}`)}}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-brand-50 transition-colors ${form.student_email===s.email?'bg-brand-50 text-brand-700 font-medium':''}`}>
                      {s.first_name} {s.last_name} <span className="text-surface-400 text-xs">{s.email}</span>
                    </button>
                  ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-surface-700 mb-1.5">Program(s) <span className="text-red-500">*</span></label>
            <div className="space-y-1.5">
              {PROGRAMS.map(p=>{
                const checked=form.programs.includes(p.id)
                return (
                  <label key={p.id} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm ${checked?'bg-brand-50 border-brand-300 text-brand-700 font-medium':'bg-white border-surface-200 text-surface-700 hover:bg-surface-50'}`}>
                    <input type="checkbox" checked={checked} onChange={e=>setForm(prev=>({...prev,programs:e.target.checked?[...prev.programs,p.id]:prev.programs.filter(x=>x!==p.id)}))} className="accent-brand-600"/>
                    {p.name}
                  </label>
                )
              })}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-surface-700 mb-1.5">Start Semester <span className="text-red-500">*</span></label>
            <select value={form.start_semester} onChange={e=>setForm(p=>({...p,start_semester:e.target.value}))}
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 bg-white">
              {SEMESTERS_LIST.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            {form.start_semester&&!form.start_semester.startsWith('Fall')&&(
              <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1"><AlertCircle size={11}/> Plan will be rotated to start from {form.start_semester}.</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-surface-700 mb-1.5">Plan Name (optional)</label>
            <input value={form.plan_name} onChange={e=>setForm(p=>({...p,plan_name:e.target.value}))} placeholder="Auto-generated if blank"
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40"/>
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-surface-200 text-surface-600 rounded-lg hover:bg-surface-50">Cancel</button>
          <button onClick={handleCreate} disabled={saving||!form.student_email||!form.programs.length}
            className="px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40">
            {saving?'Creating…':'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── StudentPlanView (read-only) ──────────────────────────────────────────────
export function StudentPlanView({ plan, onClose }) {
  const { semesters: cleanSemesters } = useMemo(
    () => migrateLegacySummerSemesters(plan?.semesters||[], plan?.start_semester),
    [plan]
  )
  const totalCredits     = cleanSemesters.reduce((s,sem)=>s+(sem.courses||[]).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
  const completedCredits = cleanSemesters.reduce((s,sem)=>s+(sem.courses||[]).filter(c=>c.completed).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
  const remainingCredits = totalCredits - completedCredits
  const pct = totalCredits > 0 ? Math.round((completedCredits/totalCredits)*100) : 0

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center">
              <GraduationCap size={16} className="text-brand-600"/>
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">My Program Plan</h2>
              <p className="text-xs text-surface-400">{plan?.plan_name||'Academic Plan'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>printPlan({...plan,semesters:cleanSemesters},plan?.student_name||'Student')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50">
              <Printer size={13}/> Print / Save PDF
            </button>
            {onClose&&<button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg"><X size={16} className="text-surface-400"/></button>}
          </div>
        </div>

        {/* Meta */}
        <div className="px-6 pt-4 pb-2 flex flex-wrap gap-3 shrink-0">
          {(plan?.programs||[]).map(pid=>{
            const prog=PROGRAMS.find(p=>p.id===pid)
            const col=PROGRAM_COLORS[pid]||{bg:'bg-surface-100',text:'text-surface-600',border:'border-surface-200'}
            return <span key={pid} className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${col.bg} ${col.text} ${col.border}`}>{prog?.name||pid}</span>
          })}
          <span className="text-xs text-surface-500">Starting: <strong>{plan?.start_semester}</strong></span>
          <span className="text-xs text-surface-500">Total: <strong>{totalCredits} credits</strong></span>
        </div>

        {plan?.programs?.length>1&&(
          <div className="px-6 pb-2 shrink-0">
            <p className="text-[11px] text-violet-600 bg-violet-50 border border-violet-200 rounded-lg px-3 py-1.5">
              ★ Courses marked with a star appear in multiple programs and count toward both degrees.
            </p>
          </div>
        )}

        {/* Progress + Donut */}
        <div className="px-6 pb-3 shrink-0">
          <div className="bg-gradient-to-r from-brand-50 to-emerald-50 border border-surface-200 rounded-xl px-4 py-3 flex items-center gap-4">
            <DonutChart completed={completedCredits} total={totalCredits} size={72}/>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-bold text-surface-800">Degree Progress</p>
                <p className="text-[11px] text-surface-500">
                  <span className="font-semibold text-emerald-600">{completedCredits} cr</span> done ·{' '}
                  <span className="font-semibold text-surface-600">{remainingCredits} cr</span> remaining
                </p>
              </div>
              <div className="w-full bg-surface-100 rounded-full h-2.5 overflow-hidden">
                <div className="bg-emerald-500 h-2.5 rounded-full transition-all duration-700" style={{width:`${pct}%`}}/>
              </div>
              <div className="flex justify-between mt-1">
                <p className="text-[10px] text-surface-400">{completedCredits} / {totalCredits} credits complete</p>
                <p className="text-[10px] text-emerald-600 font-semibold">{pct}%</p>
              </div>
              {totalCredits>0&&(
                <div className="flex gap-3 mt-2">
                  {[{label:'25%',cr:Math.round(totalCredits*.25)},{label:'50%',cr:Math.round(totalCredits*.5)},{label:'75%',cr:Math.round(totalCredits*.75)},{label:'100%',cr:totalCredits}].map(m=>(
                    <div key={m.label} className="text-center">
                      <div className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${completedCredits>=m.cr?'bg-emerald-100 text-emerald-700':'bg-surface-100 text-surface-400'}`}>{m.label}</div>
                      <div className="text-[9px] text-surface-400 mt-0.5">{m.cr} cr</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Semesters */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">
          {cleanSemesters.map((sem,si)=>{
            const isSummer=sem.label?.toLowerCase().includes('summer')
            const semTotal=(sem.courses||[]).reduce((s,c)=>s+(parseFloat(c.credits)||0),0)
            const rows=(sem.courses||[]).filter(c=>c.course_num||c.course_title)
            if (!rows.length) return null
            return (
              <div key={si} className={`border rounded-xl overflow-hidden ${isSummer?'border-amber-200':'border-surface-200'}`}>
                <div className={`px-4 py-2.5 flex items-center justify-between gap-2 ${isSummer?'bg-amber-600':'bg-brand-600'}`}>
                  <div className="flex items-center gap-2">
                    {isSummer&&<Sun size={13} className="text-amber-200 shrink-0"/>}
                    <p className="text-sm font-bold text-white">{sem.label}</p>
                    {isSummer&&<span className="text-[10px] font-semibold text-amber-100 bg-amber-700/60 border border-amber-400/40 px-1.5 py-0.5 rounded-full">Gen Ed only</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {rows.some(c=>c.completed)&&<span className="text-[10px] font-bold text-emerald-300">{rows.filter(c=>c.completed).length}/{rows.length} done</span>}
                    <span className={`text-xs ${isSummer?'text-amber-200':'text-brand-200'}`}>{semTotal} credits</span>
                  </div>
                </div>
                {isSummer&&(
                  <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5">
                    <p className="text-[11px] text-amber-700 flex items-center gap-1.5"><Sun size={10}/> Summer semester — General Education courses only. No RICT program courses are offered in summer.</p>
                  </div>
                )}
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-surface-200">
                      <th className="text-center p-2 font-semibold text-surface-600 w-[7%]">✓</th>
                      <th className="text-left p-2 font-semibold text-surface-600 w-[15%]">Course #</th>
                      <th className="text-left p-2 font-semibold text-surface-600">Course Title</th>
                      <th className="text-left p-2 font-semibold text-surface-600 w-[22%]">Prerequisites</th>
                      <th className="text-center p-2 font-semibold text-surface-600 w-[10%]">Credits</th>
                      <th className="text-center p-2 font-semibold text-surface-600 w-[13%]">Offered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((course,ri)=>{
                      const isShared=course._programs?.length>1
                      return (
                        <tr key={ri} className={`border-b border-surface-100 last:border-0 ${course.completed?'bg-emerald-50/60':isShared?'bg-violet-50/40':''}`}>
                          <td className="p-2 text-center">
                            {course.completed
                              ?<span className="inline-flex w-5 h-5 bg-emerald-500 rounded-full items-center justify-center"><Check size={11} className="text-white"/></span>
                              :<span className="inline-flex w-5 h-5 border-2 border-surface-200 rounded-full"/>}
                          </td>
                          <td className={`p-2 font-medium ${course.completed?'text-surface-400 line-through':'text-surface-800'}`}>{course.course_num}</td>
                          <td className={`p-2 ${course.completed?'text-surface-400 line-through':'text-surface-700'}`}>
                            {course.course_title}
                            {isShared&&<span className="ml-1.5 text-[9px] font-bold text-violet-600 bg-violet-100 px-1 rounded">★ Shared</span>}
                          </td>
                          <td className="p-2 text-surface-500">{course.prerequisites||'—'}</td>
                          <td className="p-2 text-center font-semibold text-surface-700">{course.credits}</td>
                          <td className="p-2 text-center text-surface-500">{course.offered||'—'}</td>
                        </tr>
                      )
                    })}
                    <tr className="bg-surface-50 border-t border-surface-200">
                      <td colSpan={3} className="p-2 text-right text-xs font-bold text-surface-600">Semester Total</td>
                      <td className="p-2 text-center text-xs font-bold text-brand-600">{semTotal}</td>
                      <td/>
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>

        {/* DAR Reference */}
        <div className="px-6 py-3 border-t border-surface-100 shrink-0 space-y-2">
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            <AlertCircle size={13} className="text-blue-500 mt-0.5 shrink-0"/>
            <div>
              <p className="text-[11px] font-semibold text-blue-700">Degree Audit Report (DAR)</p>
              <p className="text-[11px] text-blue-600">This plan is for advising purposes only. For your official degree audit and transfer credit evaluation, contact your instructor or advisor to request a DAR through the college's student records system.</p>
            </div>
          </div>
          <p className="text-xs text-surface-400 italic text-right">To make changes to this plan, see your instructor.</p>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ProgramPlannerPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const isInstructor = profile?.role==='Instructor'||profile?.email==='rictprogram@gmail.com'

  const [plans,setPlans]=useState([])
  const [masterPlanners,setMasterPlanners]=useState([])
  const [loadingMaster,setLoadingMaster]=useState(true)
  const [loading,setLoading]=useState(true)
  const [search,setSearch]=useState('')
  const [showNew,setShowNew]=useState(false)
  const [editing,setEditing]=useState(null)
  const [viewing,setViewing]=useState(null)
  const [expandedNoteId,setExpandedNoteId]=useState(null)
  const [noteText,setNoteText]=useState('')
  const [sortOrder,setSortOrder]=useState(()=>localStorage.getItem('plannerSortOrder')||'recent')
  const autoOpenDismissedRef = useRef(false)

  const handleSortChange = val => { setSortOrder(val); localStorage.setItem('plannerSortOrder',val) }

  const loadPlans = useCallback(async () => {
    setLoading(true)
    let query = supabase.from('student_program_plans').select('*').order('updated_at',{ascending:false})
    if (!isInstructor) query = query.eq('student_email',profile?.email)
    const {data,error}=await query
    if (error){setLoading(false);return}
    if (isInstructor&&data?.length){
      const emails=[...new Set(data.map(p=>p.student_email))]
      const {data:profileData}=await supabase.from('profiles').select('email,status').in('email',emails)
      const archivedSet=new Set((profileData||[]).filter(p=>p.status==='Archived').map(p=>p.email))
      setPlans((data||[]).filter(p=>!archivedSet.has(p.student_email)))
    } else { setPlans(data||[]) }
    setLoading(false)
  },[isInstructor,profile?.email])

  const loadMasterPlanners = useCallback(async () => {
    setLoadingMaster(true)
    const {data}=await supabase.from('program_revisions')
      .select('revision_id,course_id,current_program_name,planner_semesters,planner_name,academic_year,major,approved_at')
      .eq('status','approved').not('planner_semesters','is',null).order('approved_at',{ascending:false})
    setMasterPlanners(data||[])
    setLoadingMaster(false)
  },[])

  useEffect(()=>{loadPlans()},[loadPlans])
  useEffect(()=>{if(isInstructor)loadMasterPlanners()},[loadMasterPlanners,isInstructor])
  useEffect(()=>{
    if(!isInstructor&&plans.length>=1&&!viewing&&!autoOpenDismissedRef.current) setViewing(plans[0])
  },[plans,isInstructor])

  const handleSavePlan = async (planId,newSemesters) => {
    const {error}=await supabase.from('student_program_plans')
      .update({semesters:newSemesters,updated_at:new Date().toISOString()}).eq('plan_id',planId).select()
    if(error){toast.error('Save failed: '+error.message);return}
    toast.success('Plan saved!')
    setEditing(null); loadPlans()
  }

  const handleDeletePlan = async (planId) => {
    if(!window.confirm('Delete this plan? This cannot be undone.')) return
    const {error}=await supabase.from('student_program_plans').delete().eq('plan_id',planId)
    if(error){toast.error('Delete failed: '+error.message);return}
    toast.success('Plan deleted'); loadPlans()
  }

  const handleDuplicatePlan = async (plan) => {
    const newId='PLAN-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase()
    const {error}=await supabase.from('student_program_plans').insert({
      plan_id:newId, student_email:plan.student_email, student_name:plan.student_name,
      plan_name:`${plan.plan_name} (Copy)`, programs:plan.programs, start_semester:plan.start_semester,
      semesters:plan.semesters, created_by:profile?.email||'', updated_at:new Date().toISOString(),
      instructor_notes:plan.instructor_notes?`[Duplicated] ${plan.instructor_notes}`:'[Duplicated from existing plan]',
    }).select()
    if(error){toast.error('Duplicate failed: '+error.message);return}
    toast.success('Plan duplicated — edit the copy to customize'); loadPlans()
  }

  const handleSaveNote = async (planId,note) => {
    const plan=plans.find(p=>p.plan_id===planId)
    const oldNote=plan?.instructor_notes||''
    const {error}=await supabase.from('student_program_plans')
      .update({instructor_notes:note,updated_at:new Date().toISOString()}).eq('plan_id',planId).select()
    if(error){toast.error('Failed to save note: '+error.message);return}
    await supabase.from('audit_log').insert({
      user_email:profile?.email||'', user_name:profile?`${profile.first_name} ${profile.last_name}`.trim():'',
      action:oldNote?'UPDATE':'CREATE', entity_type:'student_program_plans', entity_id:planId,
      field_changed:'instructor_notes', old_value:oldNote||null, new_value:note||null,
      details:`Instructor note ${oldNote?'updated':'added'} for plan: ${plan?.plan_name||planId} (${plan?.student_name||''})`,
    })
    setPlans(prev=>prev.map(p=>p.plan_id===planId?{...p,instructor_notes:note}:p))
    setExpandedNoteId(null); toast.success('Note saved')
  }

  const toggleNote = (planId,currentNote) => {
    if(expandedNoteId===planId){setExpandedNoteId(null)}
    else{setNoteText(currentNote||'');setExpandedNoteId(planId)}
  }

  const filtered = plans
    .filter(p=>`${p.student_name} ${p.student_email} ${p.plan_name}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>{
      if(sortOrder==='first') return ((a.student_name||'').split(' ')[0]||'').localeCompare((b.student_name||'').split(' ')[0]||'')
      if(sortOrder==='last'){const l=n=>(n||'').trim().split(' ').slice(-1)[0]||'';return l(a.student_name).localeCompare(l(b.student_name))}
      return 0
    })

  // ── Student view ──────────────────────────────────────────────────────────
  if (!isInstructor) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center"><GraduationCap size={22} className="text-brand-600"/></div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">My Program Plan</h1>
            <p className="text-sm text-surface-500">Your academic course sequence — see your instructor to request changes.</p>
          </div>
        </div>
        {loading&&<div className="text-sm text-surface-400 text-center py-12">Loading your plan…</div>}
        {!loading&&plans.length===0&&(
          <div className="bg-white border border-surface-200 rounded-2xl p-12 text-center">
            <GraduationCap size={40} className="text-surface-300 mx-auto mb-3"/>
            <p className="text-surface-600 font-medium">No plan on file yet</p>
            <p className="text-sm text-surface-400 mt-1">Ask your instructor to set up your program plan.</p>
          </div>
        )}
        {!loading&&plans.length>0&&(
          <div className="space-y-4">
            {plans.map(plan=>{
              const {semesters:cleanSems}=migrateLegacySummerSemesters(plan.semesters||[],plan.start_semester)
              const totalCr=cleanSems.reduce((s,sem)=>s+(sem.courses||[]).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
              const doneCr=cleanSems.reduce((s,sem)=>s+(sem.courses||[]).filter(c=>c.completed).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
              const pct=totalCr>0?Math.round((doneCr/totalCr)*100):0
              return (
                <div key={plan.plan_id} className="bg-white border border-surface-200 rounded-2xl p-5 shadow-sm">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-sm font-bold text-surface-900">{plan.plan_name}</h3>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {(plan.programs||[]).map(pid=>{
                          const prog=PROGRAMS.find(p=>p.id===pid)
                          const col=PROGRAM_COLORS[pid]||{bg:'bg-surface-100',text:'text-surface-600',border:'border-surface-200'}
                          return <span key={pid} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${col.bg} ${col.text} ${col.border}`}>{prog?.name||pid}</span>
                        })}
                        <span className="text-[11px] text-surface-400">Starting {plan.start_semester}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={()=>printPlan({...plan,semesters:cleanSems},plan.student_name)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50">
                        <Printer size={13}/> Print
                      </button>
                      <button onClick={()=>setViewing(plan)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700">
                        <BookOpen size={13}/> View Plan
                      </button>
                    </div>
                  </div>
                  {totalCr>0&&(
                    <div className="mt-2">
                      <div className="flex justify-between text-[11px] text-surface-400 mb-1">
                        <span>{doneCr} / {totalCr} credits complete</span>
                        <span className="font-semibold text-emerald-600">{pct}%</span>
                      </div>
                      <div className="w-full bg-surface-100 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-emerald-500 h-1.5 rounded-full" style={{width:`${pct}%`}}/>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {viewing&&<StudentPlanView plan={viewing} onClose={()=>{autoOpenDismissedRef.current=true;setViewing(null)}}/>}
      </div>
    )
  }

  // ── Instructor view ────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={()=>navigate('/instructor-tools')}
            className="flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600 hover:bg-surface-100 px-2 py-1.5 rounded-lg transition-colors">
            <ChevronLeft size={15}/> Back
          </button>
          <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
            <GraduationCap size={22} className="text-brand-600"/>
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Program Planner</h1>
            <p className="text-sm text-surface-500">Create and manage student academic plans.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadPlans} className="p-2 text-surface-400 hover:text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"><RefreshCw size={16}/></button>
          <button onClick={()=>setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 transition-colors">
            <Plus size={15}/> New Student Plan
          </button>
        </div>
      </div>

      {/* Master Planners */}
      <div>
        <h2 className="text-sm font-bold text-surface-700 mb-3 flex items-center gap-2">
          <BookOpen size={15} className="text-brand-500"/> Program Master Planners
          <span className="text-[11px] font-normal text-surface-400">— Approved program plans for prospective & new students</span>
        </h2>
        {loadingMaster&&<div className="flex gap-3">{[1,2,3].map(i=><div key={i} className="h-24 w-56 bg-surface-100 rounded-xl animate-pulse shrink-0"/>)}</div>}
        {!loadingMaster&&masterPlanners.length===0&&(
          <div className="bg-surface-50 border border-surface-200 rounded-xl px-5 py-4 text-sm text-surface-400 italic">
            No approved program revisions with planners yet.
          </div>
        )}
        {!loadingMaster&&masterPlanners.length>0&&(
          <div className="flex flex-wrap gap-3">
            {masterPlanners.map(planner=>{
              const semCount=(planner.planner_semesters||[]).filter(s=>(s.courses||[]).some(c=>c.course_num)).length
              const totalCr=(planner.planner_semesters||[]).reduce((s,sem)=>(sem.courses||[]).reduce((a,c)=>a+(parseFloat(c.credits)||0),s),0)
              const approvedDate=planner.approved_at?new Date(planner.approved_at).toLocaleDateString('en-US',{month:'short',year:'numeric'}):''
              return (
                <div key={planner.revision_id}
                  className="bg-white border border-surface-200 rounded-xl px-4 py-3 shadow-sm hover:shadow-md hover:border-brand-200 transition-all flex flex-col gap-2 min-w-[220px] max-w-[260px]">
                  <div>
                    <p className="text-xs font-bold text-surface-900 leading-snug">{planner.current_program_name||planner.planner_name}</p>
                    {planner.academic_year&&<p className="text-[10px] text-surface-400">{planner.academic_year}</p>}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-surface-400">
                    <span>{semCount} semesters</span><span>·</span><span>{totalCr} credits</span>
                    {approvedDate&&<><span>·</span><span>Approved {approvedDate}</span></>}
                  </div>
                  <button onClick={()=>printPlan({plan_name:planner.current_program_name||planner.planner_name,programs:[],start_semester:(planner.planner_semesters?.[0]?.label)||'Fall',semesters:planner.planner_semesters||[],student_name:'Prospective Student',student_email:''},planner.current_program_name||planner.planner_name)}
                    className="flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold border border-brand-200 text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors w-full">
                    <Printer size={12}/> Print Generic Plan
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="border-t border-surface-200"/>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-surface-700 flex items-center gap-2">
          <GraduationCap size={15} className="text-brand-500"/> Student Custom Plans
        </h2>
        <div className="flex items-center gap-1 bg-surface-100 rounded-lg p-0.5">
          {[{val:'recent',label:'Recent'},{val:'first',label:'First Name'},{val:'last',label:'Last Name'}].map(opt=>(
            <button key={opt.val} onClick={()=>handleSortChange(opt.val)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${sortOrder===opt.val?'bg-white text-brand-700 shadow-sm':'text-surface-500 hover:text-surface-700'}`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-2.5 text-surface-400"/>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by student name, email, or plan name…"
          className="w-full pl-9 pr-4 py-2 text-sm border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/40"/>
      </div>

      {loading&&<div className="space-y-2">{[1,2,3].map(i=><div key={i} className="h-16 bg-surface-100 rounded-xl animate-pulse"/>)}</div>}

      {!loading&&filtered.length===0&&(
        <div className="bg-white border border-surface-200 rounded-2xl p-12 text-center">
          <GraduationCap size={40} className="text-surface-300 mx-auto mb-3"/>
          <p className="text-surface-600 font-medium">{search?'No plans match your search':'No student plans yet'}</p>
          <p className="text-sm text-surface-400 mt-1">Click "New Student Plan" to create one.</p>
        </div>
      )}

      {!loading&&filtered.length>0&&(
        <div className="space-y-1.5">
          {filtered.map(plan=>{
            const {semesters:cleanSems}=migrateLegacySummerSemesters(plan.semesters||[],plan.start_semester)
            const totalCr=cleanSems.reduce((s,sem)=>s+(sem.courses||[]).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
            const doneCr=cleanSems.reduce((s,sem)=>s+(sem.courses||[]).filter(c=>c.completed).reduce((a,c)=>a+(parseFloat(c.credits)||0),0),0)
            const semCount=cleanSems.filter(s=>(s.courses||[]).some(c=>c.course_num||c.course_title)).length
            const lastUpdated=new Date(plan.updated_at||plan.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
            const initials=(plan.student_name||'').split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()
            const isNoteOpen=expandedNoteId===plan.plan_id
            const hasNote=!!plan.instructor_notes?.trim()
            const pct=totalCr>0?Math.round((doneCr/totalCr)*100):0
            return (
              <div key={plan.plan_id} className="bg-white border border-surface-200 rounded-xl hover:border-brand-200 hover:shadow-sm transition-all">
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 font-bold text-sm flex items-center justify-center shrink-0 select-none">{initials}</div>
                  <div className="w-44 shrink-0 min-w-0">
                    <p className="text-sm font-semibold text-surface-900 truncate">{plan.student_name}</p>
                    <p className="text-[11px] text-surface-400 truncate">{plan.student_email}</p>
                  </div>
                  <p className="text-xs text-surface-500 flex-1 min-w-0 truncate hidden md:block">{plan.plan_name}</p>
                  <div className="flex flex-wrap gap-1 shrink-0">
                    {(plan.programs||[]).map(pid=>{
                      const prog=PROGRAMS.find(p=>p.id===pid)
                      const col=PROGRAM_COLORS[pid]||{bg:'bg-surface-100',text:'text-surface-600',border:'border-surface-200'}
                      return <span key={pid} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${col.bg} ${col.text} ${col.border}`}>{prog?.name?.split(' ')[0]||pid}</span>
                    })}
                  </div>
                  <div className="text-[11px] text-surface-400 shrink-0 hidden lg:block w-44">
                    <div className="flex justify-between mb-0.5">
                      <span>Start: <strong className="text-surface-600">{plan.start_semester}</strong></span>
                      <span>{semCount} sem · {totalCr} cr</span>
                    </div>
                    {totalCr>0&&(
                      <div>
                        <div className="w-full bg-surface-100 rounded-full h-1 overflow-hidden">
                          <div className="bg-emerald-500 h-1 rounded-full" style={{width:`${pct}%`}}/>
                        </div>
                        <div className="text-[10px] text-emerald-600 font-medium mt-0.5 text-right">{pct}% done</div>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-surface-300 shrink-0 w-24 text-right hidden xl:block">{lastUpdated}</p>
                  <button onClick={()=>toggleNote(plan.plan_id,plan.instructor_notes)}
                    title={hasNote?'View/edit instructor note':'Add instructor note'}
                    className={`p-1.5 rounded-lg transition-colors shrink-0 ${hasNote?'text-amber-500 bg-amber-50 hover:bg-amber-100':'text-surface-300 hover:text-amber-400 hover:bg-amber-50'}`}>
                    <StickyNote size={14}/>
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={()=>setViewing(plan)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 transition-colors">
                      <BookOpen size={11}/> View
                    </button>
                    <button onClick={()=>printPlan({...plan,semesters:cleanSems},plan.student_name)}
                      className="p-1.5 border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 transition-colors" title="Print">
                      <Printer size={12}/>
                    </button>
                    <button onClick={()=>setEditing(plan)}
                      className="px-2.5 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors">
                      Edit
                    </button>
                    <button onClick={()=>handleDuplicatePlan(plan)}
                      className="p-1.5 border border-surface-200 rounded-lg text-surface-500 hover:bg-violet-50 hover:text-violet-600 hover:border-violet-200 transition-colors" title="Duplicate plan">
                      <Copy size={12}/>
                    </button>
                    <button onClick={()=>handleDeletePlan(plan.plan_id)}
                      className="p-1.5 text-surface-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete plan">
                      <Trash2 size={12}/>
                    </button>
                  </div>
                </div>

                {isNoteOpen&&(
                  <div className="border-t border-amber-100 bg-amber-50/50 px-4 pb-3 pt-2.5 rounded-b-xl">
                    <p className="text-[11px] font-semibold text-amber-600 mb-1.5 flex items-center gap-1.5">
                      <StickyNote size={11}/> Instructor Note <span className="text-surface-400 font-normal">— not visible to students</span>
                    </p>
                    <textarea value={noteText} onChange={e=>setNoteText(e.target.value)}
                      placeholder="Add private notes about why this plan was created, exceptions made, advising context…"
                      rows={3} className="w-full text-xs border border-amber-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-amber-400/40 bg-white"/>
                    <div className="flex justify-end gap-2 mt-1.5">
                      <button onClick={()=>setExpandedNoteId(null)} className="px-3 py-1.5 text-xs border border-surface-200 rounded-lg text-surface-500 hover:bg-surface-50">Cancel</button>
                      <button onClick={()=>handleSaveNote(plan.plan_id,noteText)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600">
                        <Save size={11}/> Save Note
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showNew&&<NewPlanModal onCreated={loadPlans} onClose={()=>setShowNew(false)}/>}
      {editing&&<PlanEditorModal plan={editing} onSave={newSems=>handleSavePlan(editing.plan_id,newSems)} onClose={()=>setEditing(null)}/>}
      {viewing&&<StudentPlanView plan={viewing} onClose={()=>setViewing(null)}/>}
    </div>
  )
}
