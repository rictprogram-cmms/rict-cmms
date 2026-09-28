import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  GraduationCap, Plus, Printer, X, ChevronRight, ChevronLeft,
  Search, Trash2, Save, Check, AlertCircle, BookOpen, RefreshCw,
  StickyNote, Sun, PlusCircle, Copy, Clock, ClipboardCheck,
} from 'lucide-react'
import toast from 'react-hot-toast'
import ConfirmDialog from '@/components/ConfirmDialog'
import { isSuperAdmin } from '@/lib/superAdmin'
import { useAcademicTerms } from '@/hooks/useAcademicTerms'
import { sortTermsAsc } from '@/lib/academicTerms'
import { mustData, assertWrite, isUniqueViolation } from '@/lib/supabaseData'

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
// Fallback only — the Start Semester dropdown reads Settings → Terms (Spring /
// Fall) when any exist; this list covers a database with no terms yet.
const SEMESTERS_LIST = [
  'Fall 2025','Spring 2026',
  'Fall 2026','Spring 2027',
  'Fall 2027','Spring 2028',
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

// ─── Course status (Not started → In progress → Done) ─────────────────────────
// Stored on each course in plan.semesters as two booleans: `completed` (the
// original flag — unchanged, so older plans read correctly) and `in_progress`
// (added 2026-09-28). `completed` wins if both are ever set.
const IN_PROGRESS_HEX = '#d97706'   // amber-600 — ≥3:1 against white / slate-200 track
const DONE_HEX        = '#16a34a'   // green-600
// Diagonal stripes so "in progress" doesn't rely on colour alone
const IN_PROGRESS_STRIPES = 'repeating-linear-gradient(135deg, rgba(255,255,255,0.35) 0 3px, transparent 3px 6px)'

function courseStatus(c) {
  if (c?.completed) return 'done'
  if (c?.in_progress) return 'progress'
  return 'none'
}
const STATUS_LABEL = { none: 'Not started', progress: 'In progress', done: 'Completed' }
const NEXT_STATUS  = { none: 'progress', progress: 'done', done: 'none' }
function statusFields(status) {
  return { completed: status === 'done', in_progress: status === 'progress' }
}

const hasContent = c => !!(c?.course_num || c?.course_title)

/** Credits for a list of semesters: { total, done, progress, remaining, donePct, progressPct } */
function creditTotals(sems) {
  let total = 0, done = 0, progress = 0
  ;(sems || []).forEach(sem => (sem.courses || []).forEach(c => {
    const cr = parseFloat(c.credits) || 0
    total += cr
    const st = courseStatus(c)
    if (st === 'done') done += cr
    else if (st === 'progress') progress += cr
  }))
  const donePct = total > 0 ? Math.round((done / total) * 100) : 0
  // Round the combined figure so the two bar segments never exceed 100%
  const progressPct = total > 0 ? Math.max(0, Math.min(100, Math.round(((done + progress) / total) * 100)) - donePct) : 0
  return { total, done, progress, remaining: Math.max(0, total - done - progress), donePct, progressPct }
}

/** "5/7 done · 2 in progress" for a semester header, or '' when nothing is marked. */
function semesterStatusLabel(courses) {
  const rows = (courses || []).filter(hasContent)
  const d = rows.filter(c => courseStatus(c) === 'done').length
  const p = rows.filter(c => courseStatus(c) === 'progress').length
  if (!d && !p) return ''
  return [d ? `${d}/${rows.length} done` : '', p ? `${p} in progress` : ''].filter(Boolean).join(' · ')
}

// ─── Advising helpers ─────────────────────────────────────────────────────────
/** Today as YYYY-MM-DD in local time (never toISOString — see conventions). */
function todayLocalDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 'YYYY-MM-DD' → 'Sep 28, 2026' (local parse). */
function fmtMetOn(s, withYear = true) {
  if (!s) return ''
  const d = new Date(`${String(s).substring(0, 10)}T00:00:00`)
  if (isNaN(d)) return ''
  return d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
}
/** Fallback term name when Settings → Terms is empty: Aug–Dec = Fall, Jan–Jul = Spring. */
function fallbackTermName(today = new Date()) {
  const m = today.getMonth()
  return m >= 7 ? `Fall ${today.getFullYear()}` : `Spring ${today.getFullYear()}`
}
const sortMeetings = list => [...(list || [])].sort((a, b) => semesterSortKey(a.term_name) - semesterSortKey(b.term_name))

// ─── ProgressBar (stacked: done + in progress) ────────────────────────────────
function ProgressBar({ totals, height = 'h-2.5' }) {
  const { done, progress, total, donePct, progressPct } = totals
  return (
    <div className={`w-full bg-surface-100 rounded-full ${height} overflow-hidden flex`}
      role="img" aria-label={`${done} of ${total} credits complete${progress ? `, ${progress} in progress` : ''}`}>
      {donePct > 0 && <div className={`bg-emerald-500 ${height} transition-all duration-700`} style={{ width: `${donePct}%` }}/>}
      {progressPct > 0 && (
        <div className={`${height} transition-all duration-700`}
          style={{ width: `${progressPct}%`, backgroundColor: IN_PROGRESS_HEX, backgroundImage: IN_PROGRESS_STRIPES }}/>
      )}
    </div>
  )
}

/** Small status marker used in read-only tables. */
function StatusMarker({ status }) {
  if (status === 'done') return (
    <span className="inline-flex w-5 h-5 bg-emerald-500 rounded-full items-center justify-center">
      <Check size={11} className="text-white" aria-hidden="true" /><span className="sr-only">Completed</span>
    </span>
  )
  if (status === 'progress') return (
    <span className="inline-flex w-5 h-5 rounded-full items-center justify-center" style={{ backgroundColor: IN_PROGRESS_HEX }}>
      <Clock size={11} className="text-white" aria-hidden="true" /><span className="sr-only">In progress</span>
    </span>
  )
  return <span className="inline-flex w-5 h-5 border-2 border-surface-200 rounded-full"><span className="sr-only">Not started</span></span>
}

// ─── DonutChart ───────────────────────────────────────────────────────────────
function DonutChart({ completed, inProgress = 0, total, size = 80 }) {
  const pct  = total > 0 ? Math.min(1, completed / total) : 0
  const pPct = total > 0 ? Math.max(0, Math.min(1 - pct, inProgress / total)) : 0
  const r = 26, circ = 2 * Math.PI * r
  const dash = circ * pct, pDash = circ * pPct
  const label = `${Math.round(pct * 100)}% of credits complete${inProgress ? `, ${Math.round(pPct * 100)}% in progress` : ''}`
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="shrink-0" role="img" aria-label={label}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="#e2e8f0" strokeWidth="9"/>
      {pPct > 0 && (
        // In-progress arc starts where the done arc ends
        <circle cx="32" cy="32" r={r} fill="none" stroke={IN_PROGRESS_HEX} strokeWidth="9"
          strokeDasharray={`${pDash.toFixed(2)} ${(circ - pDash).toFixed(2)}`} strokeDashoffset={(-dash).toFixed(2)}
          transform="rotate(-90 32 32)" style={{ transition: 'stroke-dasharray 0.6s ease' }}/>
      )}
      {pct > 0 && (
        <circle cx="32" cy="32" r={r} fill="none" stroke={DONE_HEX} strokeWidth="9"
          strokeDasharray={`${dash.toFixed(2)} ${(circ - dash).toFixed(2)}`} strokeLinecap={pPct > 0 ? 'butt' : 'round'}
          transform="rotate(-90 32 32)" style={{ transition: 'stroke-dasharray 0.6s ease' }}/>
      )}
      <text x="32" y="29" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#0f172a" aria-hidden="true">{Math.round(pct * 100)}%</text>
      <text x="32" y="40" textAnchor="middle" fontSize="7.5" fill="#64748b" aria-hidden="true">done</text>
    </svg>
  )
}

// ─── Print helper ─────────────────────────────────────────────────────────────
// `advising` (optional): [{ term_name, met_on, notes?, advised_by? }]. Dates (and
// who advised) always print; notes print only when opts.includeNotes — instructor
// printouts follow the "Print advising notes" box, a student's own printout always
// includes them (students see their advising notes; the plan's Instructor Note is
// never passed here).
function printPlan(plan, studentName, advising = null, opts = {}) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const { total: totalCr, done: doneCr, progress: progCr, remaining: remainingCr, donePct: pct, progressPct: progPct } = creditTotals(plan.semesters)
  const printedDate = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})

  const semHtml = (plan.semesters||[]).map(sem => {
    const isSummer = sem.label?.toLowerCase().includes('summer')
    const semTotal = (sem.courses||[]).reduce((s,c)=>s+(parseFloat(c.credits)||0),0)
    const rows = (sem.courses||[]).filter(c=>c.course_num||c.course_title).map(c=>{
      const st = courseStatus(c)
      return `
      <tr class="${st==='done'?'done':st==='progress'?'prog':''}">
        <td style="text-align:center">${st==='done'?'✓':st==='progress'?'<span class="half" role="img" aria-label="In progress"></span>':'○'}</td>
        <td>${esc(c.course_num)}</td>
        <td>${esc(c.course_title)}${c._programs?.length>1?'<span class="shared"> ★ Shared</span>':''}${st==='progress'?'<span class="prog-tag"> In progress</span>':''}</td>
        <td>${esc(c.prerequisites)}</td>
        <td class="cr">${esc(c.credits)}</td>
        <td>${esc(c.offered)}</td>
      </tr>`}).join('')
    const statusText = semesterStatusLabel(sem.courses)
    const doneLabel = statusText ? ` — ${statusText}` : ''
    if (!rows) return ''
    return `
      <div class="sem ${isSummer?'sem-summer':''}">
        <div class="sem-head"><span>${esc(sem.label)}${doneLabel}${isSummer?' ☀ Gen Ed Only':''}</span><span>${semTotal} cr</span></div>
        ${isSummer?'<div class="summer-note">Summer — General Education courses only. No RICT program courses offered in summer.</div>':''}
        <table>
          <thead><tr><th scope="col" style="width:22px;text-align:center">✓</th><th scope="col">Course #</th><th scope="col">Course Title</th><th scope="col">Prerequisites</th><th scope="col" class="cr">Cr</th><th scope="col">Offered</th></tr></thead>
          <tbody>${rows}<tr class="sem-total"><td></td><td colspan="3" style="text-align:right;font-weight:bold">Semester Total</td><td class="cr">${semTotal}</td><td></td></tr></tbody>
        </table>
      </div>`
  }).join('')

  const progressHtml = totalCr > 0 ? `
    <div class="progress-section">
      <div class="progress-row"><span>Progress: <strong>${doneCr} of ${totalCr} credits complete (${pct}%)</strong>${progCr?` · <span class="prog-text">${progCr} cr in progress</span>`:''}</span><span>${remainingCr} cr remaining</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div><div class="progress-prog" style="width:${progPct}%"></div></div>
      ${progCr?'<div class="legend"><span><i class="sw sw-done"></i>Complete</span><span><i class="sw sw-prog"></i>In progress</span><span><i class="sw sw-rem"></i>Remaining</span></div>':''}
    </div>` : ''

  const printMeetings = sortMeetings(advising||[])
  const withNotes = !!opts.includeNotes && printMeetings.some(m=>m.notes?.trim())
  const advisingHtml = !printMeetings.length ? '' : withNotes ? `
    <div class="adv-box">
      <div class="adv-head">Advising Meetings</div>
      <table class="adv-table">
        <thead><tr><th scope="col" style="width:110px">Term</th><th scope="col" style="width:95px">Date</th><th scope="col">Notes</th></tr></thead>
        <tbody>${printMeetings.map(m=>`<tr><td style="white-space:nowrap">${esc(m.term_name)} ✓</td><td>${esc(fmtMetOn(m.met_on))}${m.advised_by?`<div class="adv-by">with ${esc(m.advised_by)}</div>`:''}</td><td class="adv-note">${esc(m.notes||'')}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : `
    <div class="advising"><b>Advising meetings:</b> ${printMeetings.map(m=>`${esc(m.term_name)} ✓ ${esc(fmtMetOn(m.met_on))}${m.advised_by?` (with ${esc(m.advised_by)})`:''}`).join(' &nbsp;·&nbsp; ')}</div>`

  const html = `<!DOCTYPE html><html><head><title>Program Plan — ${esc(studentName)}</title>
  <style>
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:Arial,sans-serif;font-size:10pt;margin:0.6in;color:#111}
    h1{font-size:16pt;margin:0 0 2px;color:#1e3a8a}
    .meta{display:flex;gap:20px;font-size:9pt;color:#555;margin-bottom:4px;flex-wrap:wrap}.meta span b{color:#111}
    .meta-sub{font-size:8pt;color:#94a3b8;margin-bottom:12px}
    /* Avery 5961 label = 4in × 1in; box is 1/16in larger on every side so the label sits inside the line */
    .label-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px;break-inside:avoid}
    .label-cap{font-size:9pt;color:#334155}
    .label-box{flex:0 0 auto;width:4.125in;height:1.125in;border:1.5px dashed #64748b;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;font-size:9pt}
    .label-box small{font-size:7pt;margin-top:2px}
    .progress-section{margin-bottom:16px;padding:8px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:5px}
    .progress-row{display:flex;justify-content:space-between;font-size:9pt;margin-bottom:5px}
    .progress-track{height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;display:flex}
    .progress-fill{height:8px;background:#16a34a}
    .progress-prog{height:8px;background:${IN_PROGRESS_HEX};background-image:${IN_PROGRESS_STRIPES}}
    .prog-text{color:#b45309;font-weight:bold}
    .legend{display:flex;gap:14px;font-size:8pt;color:#475569;margin-top:5px}
    .sw{display:inline-block;width:10px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
    .sw-done{background:#16a34a}.sw-prog{background:${IN_PROGRESS_HEX};background-image:${IN_PROGRESS_STRIPES}}.sw-rem{background:#e2e8f0}
    .advising{margin:-8px 0 14px;font-size:8.5pt;color:#334155}
    .adv-box{margin:-4px 0 16px;border:1px solid #bbf7d0;border-radius:5px;overflow:hidden;break-inside:avoid}
    .adv-head{background:#166534;color:white;font-weight:bold;font-size:9.5pt;padding:4px 8px}
    .adv-table th{background:#dcfce7;border:1px solid #bbf7d0}
    .adv-table td{border:1px solid #e2e8f0}
    .adv-note{white-space:pre-wrap}
    .adv-by{font-size:7.5pt;color:#475569}
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
    tr.prog td{background:#fffbeb}
    tr.prog td:first-child{color:#b45309;font-weight:bold}
    .half{display:inline-block;width:10px;height:10px;border-radius:50%;border:1.5px solid #b45309;background:linear-gradient(90deg,#b45309 50%,transparent 50%);vertical-align:middle;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .prog-tag{font-size:7.5pt;color:#b45309;font-weight:bold;margin-left:4px}
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
  ${opts.accessLabel ? `
  <div class="label-row">
    <div class="label-cap"><b>Registration Access Code</b><br>Use this code when you register for next term's classes.</div>
    <div class="label-box" role="img" aria-label="Space for Access Code label"><span>Place Access Code label here</span><small>Avery 5961 · 4&Prime; × 1&Prime;</small></div>
  </div>` : ''}
  ${progressHtml}${advisingHtml}${semHtml}
  <div class="total">Total Program Credits: ${totalCr}</div>
  <div class="dar-note"><b>Note:</b> This plan is for advising purposes only and does not replace an official Degree Audit Report (DAR). Contact your instructor or advisor to request a DAR through the college's student records system.</div>
  </body></html>`

  const w = window.open('','_blank')
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(),300) }
}

// ─── Advising report (for the college) ────────────────────────────────────────
// One page per term: who met for advising (date + instructor) and who has not.
// Every student with a program plan is listed (archived students are already
// excluded by loadPlans) — search/filter on screen do NOT narrow the report.
// Notes are never printed here.
function printAdvisingReport({ term, students, preparedBy }) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const lastName = n => (n||'').trim().split(' ').slice(-1)[0]||''
  const byLast = (a,b) => lastName(a.name).localeCompare(lastName(b.name)) || (a.name||'').localeCompare(b.name||'')
  const advised = students.filter(s=>s.meeting).sort((a,b)=>String(a.meeting.met_on).localeCompare(String(b.meeting.met_on)) || byLast(a,b))
  const notYet  = students.filter(s=>!s.meeting).sort(byLast)
  const total = students.length
  const pct = total ? Math.round(advised.length/total*100) : 0
  const printed = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})
  const progs = ids => (ids||[]).map(pid=>PROGRAMS.find(p=>p.id===pid)?.name||pid).join(', ')

  const advisedRows = advised.map((s,i)=>`<tr>
      <td class="n">${i+1}</td><td>${esc(s.name)}</td><td>${esc(s.email)}</td><td>${esc(progs(s.programs))}</td>
      <td class="nw">${esc(fmtMetOn(s.meeting.met_on))}</td><td>${esc(s.meeting.advised_by||s.meeting.advised_by_email||'')}</td></tr>`).join('')
  const notYetRows = notYet.map((s,i)=>`<tr>
      <td class="n">${i+1}</td><td>${esc(s.name)}</td><td>${esc(s.email)}</td><td>${esc(progs(s.programs))}</td>
      <td>${s.lastMeeting?`${esc(s.lastMeeting.term_name)} (${esc(fmtMetOn(s.lastMeeting.met_on))})`:'—'}</td></tr>`).join('')

  const html = `<!DOCTYPE html><html lang="en"><head><title>Advising Report — ${esc(term)}</title>
  <style>
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{font-family:Arial,sans-serif;font-size:10pt;margin:0.6in;color:#111}
    h1{font-size:16pt;margin:0 0 2px;color:#1e3a8a}
    .sub{font-size:9pt;color:#475569;margin-bottom:12px}
    .summary{display:flex;gap:24px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:5px;background:#f8fafc;margin-bottom:16px;font-size:10pt}
    .summary b{font-size:12pt}
    h2{font-size:11pt;margin:18px 0 6px;padding:5px 8px;color:white;border-radius:3px}
    h2.ok{background:#166534}h2.todo{background:#b45309}
    table{width:100%;border-collapse:collapse;font-size:9pt}
    th{background:#e2e8f0;text-align:left;padding:4px 6px;border:1px solid #cbd5e1}
    td{padding:4px 6px;border:1px solid #e2e8f0;vertical-align:top}
    tr{break-inside:avoid}td.n{width:26px;text-align:right;color:#64748b}.nw{white-space:nowrap}
    .empty{font-style:italic;color:#64748b;padding:6px 2px}
    .sign{margin-top:36px;display:flex;gap:40px;font-size:9.5pt}
    .sign div{flex:1;border-top:1px solid #111;padding-top:4px}
    .foot{margin-top:18px;font-size:8pt;color:#64748b}
    thead{display:table-header-group}
  </style></head><body>
  <h1>Student Advising Report — ${esc(term)}</h1>
  <div class="sub">Robotics &amp; Industrial Controls Technology (RICT) · St. Cloud Technical &amp; Community College · Printed ${printed}${preparedBy?` by ${esc(preparedBy)}`:''}</div>
  <div class="summary">
    <span>Students: <b>${total}</b></span>
    <span>Advised: <b>${advised.length}</b></span>
    <span>Not yet advised: <b>${notYet.length}</b></span>
    <span>Completion: <b>${pct}%</b></span>
  </div>

  <h2 class="ok">Advised — ${advised.length}</h2>
  ${advised.length?`<table><thead><tr><th scope="col">#</th><th scope="col">Student</th><th scope="col">Email</th><th scope="col">Program(s)</th><th scope="col">Date met</th><th scope="col">Met with</th></tr></thead><tbody>${advisedRows}</tbody></table>`:'<p class="empty">No students have been advised for this term yet.</p>'}

  <h2 class="todo">Not yet advised — ${notYet.length}</h2>
  ${notYet.length?`<table><thead><tr><th scope="col">#</th><th scope="col">Student</th><th scope="col">Email</th><th scope="col">Program(s)</th><th scope="col">Last advising meeting</th></tr></thead><tbody>${notYetRows}</tbody></table>`:'<p class="empty">Every student has been advised for this term.</p>'}

  <div class="sign"><div>Instructor signature</div><div>Date</div></div>
  <div class="foot">Includes every active student with a program plan in the RICT CMMS Program Planner. Advising notes are not included in this report.</div>
  </body></html>`

  const w = window.open('','_blank')
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(),300) }
  else toast.error('Pop-up blocked — allow pop-ups for this site to print the report')
}

// ─── DeleteSemesterDialog ─────────────────────────────────────────────────────
function DeleteSemesterDialog({ semester, onConfirm, onCancel }) {
  const dialogRef = useDialogA11y(true, onCancel)
  const courseCount = (semester.courses||[]).filter(c=>c.course_num||c.course_title).length
  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-label="Remove semester" className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center shrink-0">
            <Trash2 size={18} className="text-red-600" aria-hidden="true" />
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
          <button onClick={onCancel} className="px-4 py-2 text-sm border border-surface-200 text-surface-600 rounded-lg hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Remove Semester</button>
        </div>
      </div>
    </div>
  )
}

// ─── AdvisingSection (inside Edit / View, instructors only) ───────────────────
// The screen Aaron has open while advising a student: pick the term, set the
// meeting date, type notes, and check the student off — saved immediately
// (independent of "Save Plan"). History of earlier terms is listed below.
function AdvisingSection({ actions, studentName, idPrefix }) {
  const { meetings=[], defaultTerm, termOptions=[], currentTermName, busy, unavailable,
          printNotes, setPrintNotes, accessLabel, setAccessLabel, onAdvise, onUpdate, onRemove } = actions
  const [term, setTerm] = useState(defaultTerm)
  const row = meetings.find(m => m.term_name === term) || null
  const [draft, setDraft] = useState({ met_on: todayLocalDate(), notes: '' })
  const [liveMsg, setLiveMsg] = useState('')
  // Reset the draft when the term changes or the saved row changes underneath us
  useEffect(() => {
    setDraft(row
      ? { met_on: String(row.met_on).substring(0,10), notes: row.notes || '' }
      : { met_on: todayLocalDate(), notes: '' })
  }, [term, row?.meeting_id, row?.updated_at]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = row && (draft.met_on !== String(row.met_on).substring(0,10) || (draft.notes||'').trim() !== (row.notes||'').trim())
  const others = sortMeetings(meetings.filter(m => m.term_name !== term))
  const options = termOptions.includes(term) ? termOptions : [...termOptions, term]

  const doAdvise = async () => {
    const ok = await onAdvise(term, draft)
    if (ok) setLiveMsg(`${studentName} marked advised for ${term}`)
  }
  const doSave = async () => {
    const ok = await onUpdate(row, draft)
    if (ok) setLiveMsg(`Advising notes saved for ${term}`)
  }

  return (
    <section aria-labelledby={`${idPrefix}-adv-h`} className={`border rounded-xl overflow-hidden ${row ? 'border-emerald-300' : 'border-surface-200'}`}>
      <div className={`px-4 py-2.5 flex flex-wrap items-center gap-2 border-b ${row ? 'bg-emerald-50 border-emerald-200' : 'bg-surface-50 border-surface-200'}`}>
        <ClipboardCheck size={15} className={row ? 'text-emerald-700' : 'text-surface-500'} aria-hidden="true" />
        <h3 id={`${idPrefix}-adv-h`} className="text-xs font-bold text-surface-800">Advising</h3>
        <label htmlFor={`${idPrefix}-adv-term`} className="sr-only">Advising term</label>
        <select id={`${idPrefix}-adv-term`} value={term} onChange={e => setTerm(e.target.value)}
          className="px-2 py-1 text-xs border border-surface-200 rounded-lg bg-white min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          {options.map(n => <option key={n} value={n}>{n}{n === currentTermName ? ' (current)' : ''}</option>)}
        </select>
        {row
          ? <span className="text-xs font-semibold text-emerald-800 flex items-center gap-1"><Check size={13} aria-hidden="true" /> Advised {fmtMetOn(row.met_on)}{row.advised_by ? ` · ${row.advised_by}` : ''}</span>
          : <span className="text-xs text-surface-600">Not yet advised for {term}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-x-4">
          <label className="flex items-center gap-2 text-[11px] text-surface-700 cursor-pointer min-h-[44px]">
            <input type="checkbox" checked={!!printNotes} onChange={e => setPrintNotes(e.target.checked)}
              className="w-4 h-4 accent-emerald-600 focus-visible:ring-2 focus-visible:ring-brand-500" />
            Print advising notes
          </label>
          {setAccessLabel && (
            <label className="flex items-center gap-2 text-[11px] text-surface-700 cursor-pointer min-h-[44px]"
              title="Adds a 4″ × 1″ box to the printout for an Avery 5961 Access Code label">
              <input type="checkbox" checked={!!accessLabel} onChange={e => setAccessLabel(e.target.checked)}
                className="w-4 h-4 accent-emerald-600 focus-visible:ring-2 focus-visible:ring-brand-500" />
              Label spot for Access Code
            </label>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-2 bg-white">
        {unavailable && (
          <p role="alert" className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">{unavailable}</p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <label htmlFor={`${idPrefix}-adv-date`} className="block text-[11px] font-semibold text-surface-700 mb-1">Meeting date</label>
            <input id={`${idPrefix}-adv-date`} type="date" value={draft.met_on}
              onChange={e => setDraft(d => ({ ...d, met_on: e.target.value }))}
              className="px-2 py-1.5 text-xs border border-surface-200 rounded-lg bg-white min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" />
          </div>
          <div className="flex-1 min-w-[240px]">
            <label htmlFor={`${idPrefix}-adv-note`} className="block text-[11px] font-semibold text-surface-700 mb-1">
              Advising notes <span className="font-normal text-surface-600">— the student can see these on their plan</span>
            </label>
            <textarea id={`${idPrefix}-adv-note`} rows={3} value={draft.notes}
              onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
              placeholder="What you discussed, courses to register for next term, concerns, follow-ups…"
              className="w-full text-xs border border-surface-200 rounded-lg px-3 py-2 resize-y bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {row ? (
            <>
              <button type="button" onClick={() => onRemove(row)} disabled={busy}
                className="px-3 py-1.5 text-xs border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                Remove check-off
              </button>
              <button type="button" onClick={doSave} disabled={busy || !dirty}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                <Save size={12} aria-hidden="true" /> {busy ? 'Saving…' : dirty ? 'Save advising notes' : 'Saved'}
              </button>
            </>
          ) : (
            <button type="button" onClick={doAdvise} disabled={busy || !!unavailable}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
              <ClipboardCheck size={12} aria-hidden="true" /> {busy ? 'Saving…' : `Mark advised for ${term}`}
            </button>
          )}
        </div>
        <p className="text-[10px] text-surface-500">Saves right away — separate from Save Plan.</p>
        <p className="sr-only" aria-live="polite">{liveMsg}</p>

        {others.length > 0 && (
          <div className="border-t border-surface-100 pt-2">
            <p className="text-[11px] font-semibold text-surface-700 mb-1">Earlier advising meetings</p>
            <ul className="space-y-1">
              {others.map(m => (
                <li key={m.term_name} className="text-[11px] text-surface-700">
                  <span className="font-semibold">{m.term_name}</span> <span className="text-emerald-700" aria-hidden="true">✓</span> {fmtMetOn(m.met_on)}
                  {m.notes && <span className="block text-surface-600 whitespace-pre-wrap pl-3 border-l-2 border-emerald-200 mt-0.5">{m.notes}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

// ─── PlanEditorModal ──────────────────────────────────────────────────────────
function PlanEditorModal({ plan, advising = [], advisingActions = null, onSave, onClose }) {
  const dialogRef = useDialogA11y(true, onClose)
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
  // Not started → In progress → Done → Not started
  const cycleStatus = (si,ri) => setSemesters(prev=>prev.map((s,i)=>i!==si?s:{...s,courses:s.courses.map((c,j)=>j!==ri?c:{...c,...statusFields(NEXT_STATUS[courseStatus(c)])})}))
  const [statusMsg, setStatusMsg] = useState('')
  const editorTotals = creditTotals(semesters)
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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Edit plan" className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-4">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <div>
            <h2 className="text-base font-bold text-surface-900">Edit Plan — {plan.student_name}</h2>
            <p className="text-xs text-surface-400 mt-0.5">Drag ⠿ to reorder courses. Click the status circle to cycle Not started → In progress → Done. Semesters auto-sort chronologically on save.</p>
            <p className="text-[11px] text-surface-500 mt-1">
              <span className="font-semibold text-emerald-700">{editorTotals.done} cr done</span>
              {editorTotals.progress>0&&<> · <span className="font-semibold text-amber-700">{editorTotals.progress} cr in progress</span></>}
              {' '}· {editorTotals.remaining} cr remaining
            </p>
            {!advisingActions&&advising.length>0&&(
              <p className="text-[11px] text-surface-500 mt-0.5 flex items-center gap-1 flex-wrap">
                <ClipboardCheck size={11} className="text-emerald-600" aria-hidden="true" />
                <span className="font-semibold">Advised:</span>
                {sortMeetings(advising).map(m=>`${m.term_name} (${fmtMetOn(m.met_on,false)})`).join(' · ')}
              </p>
            )}
            <p className="sr-only" aria-live="polite">{statusMsg}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>printPlan({...plan,semesters},plan.student_name,advisingActions?.meetings||advising,{includeNotes:!!advisingActions?.printNotes,accessLabel:!!advisingActions?.accessLabel})}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
              <Printer size={13} aria-hidden="true" /> Print
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
              <Save size={13} aria-hidden="true" />{saving ? 'Saving…' : 'Save Plan'}
            </button>
            <button type="button" onClick={onClose} aria-label="Close plan editor" className="p-1.5 hover:bg-surface-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
              <X size={16} className="text-surface-400" aria-hidden="true" />
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
              className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
              Save Now
            </button>
          </div>
        )}

        {/* ── Credit warning ── */}
        {creditWarning && (
          <div className="mx-6 mt-3 flex items-center gap-2 bg-yellow-50 border border-yellow-300 rounded-xl px-4 py-2.5">
            <AlertCircle size={14} className="text-yellow-600 shrink-0" aria-hidden="true" />
            <p className="text-xs text-yellow-800">{creditWarning}</p>
          </div>
        )}

        {/* ── Advising (saved immediately, separate from Save Plan) ── */}
        {advisingActions && (
          <div className="px-6 pt-4">
            <AdvisingSection actions={advisingActions} studentName={plan.student_name} idPrefix={`edit-${plan.plan_id}`} />
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
                    {isSummer && <Sun size={13} className="text-amber-500 shrink-0" aria-hidden="true" />}
                    <p className={`text-xs font-bold ${isSummer?'text-amber-700':'text-brand-700'}`}>{sem.label}</p>
                    {isSummer && (
                      <span className="text-[10px] font-semibold text-amber-600 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded-full shrink-0">
                        ☀ Gen Ed only — No RICT courses
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(()=>{
                      const rows=(sem.courses||[]).filter(hasContent)
                      const d=rows.filter(c=>courseStatus(c)==='done').length
                      const p=rows.filter(c=>courseStatus(c)==='progress').length
                      return <>
                        {d>0&&<span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">{d}/{rows.length} complete</span>}
                        {p>0&&<span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">{p} in progress</span>}
                      </>
                    })()}
                    <span className="text-xs text-surface-400">{semTotal} credits</span>
                    <button onClick={()=>setDeleteConfirm(si)} title={`Remove ${sem.label}`} aria-label={`Remove ${sem.label}`}
                      className="p-1 rounded-lg text-surface-300 hover:text-red-500 hover:bg-red-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-surface-200">
                      <th scope="col" className="p-2 w-5"/>
                      <th scope="col" className="text-center p-2 font-semibold text-surface-600 w-[7%]">Status</th>
                      <th scope="col" className="text-left p-2 font-semibold text-surface-600 w-[13%]">Course #</th>
                      <th scope="col" className="text-left p-2 font-semibold text-surface-600 w-[28%]">Course Title</th>
                      <th scope="col" className="text-left p-2 font-semibold text-surface-600 w-[24%]">Prerequisites</th>
                      <th scope="col" className="text-center p-2 font-semibold text-surface-600 w-[8%]">Credits</th>
                      <th scope="col" className="text-center p-2 font-semibold text-surface-600 w-[10%]">Offered</th>
                      <th scope="col" className="p-2 w-7"/>
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
                            ${course.completed?'bg-emerald-50/50':course.in_progress?'bg-amber-50/60':isShared?'bg-violet-50/30':'hover:bg-surface-50/50'}`}>
                          <td className="pl-2 pr-0 cursor-grab select-none text-surface-300 hover:text-brand-400">
                            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                              <circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/>
                              <circle cx="2.5" cy="7" r="1.5"/><circle cx="7.5" cy="7" r="1.5"/>
                              <circle cx="2.5" cy="11.5" r="1.5"/><circle cx="7.5" cy="11.5" r="1.5"/>
                            </svg>
                          </td>
                          <td className="p-1 text-center">
                            {(()=>{
                              const st=courseStatus(course), next=NEXT_STATUS[st]
                              const name=course.course_num||course.course_title||`row ${ri + 1}`
                              return (
                                <button type="button"
                                  onClick={()=>{cycleStatus(si,ri);setStatusMsg(`${name}: ${STATUS_LABEL[next]}`)}}
                                  title={`${STATUS_LABEL[st]} — click for ${STATUS_LABEL[next]}`}
                                  aria-label={`${name} status: ${STATUS_LABEL[st]}. Activate to mark ${STATUS_LABEL[next]}.`}
                                  className="min-h-[44px] min-w-[44px] mx-auto flex items-center justify-center rounded-lg group focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                                  <span className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors
                                    ${st==='done'?'bg-emerald-500 border-emerald-500 text-white'
                                      :st==='progress'?'border-amber-600 text-white'
                                      :'border-surface-300 group-hover:border-amber-500 text-transparent'}`}
                                    style={st==='progress'?{backgroundColor:IN_PROGRESS_HEX}:undefined}>
                                    {st==='progress'?<Clock size={11} aria-hidden="true" />:<Check size={11} aria-hidden="true" />}
                                  </span>
                                </button>
                              )
                            })()}
                          </td>
                          <td className="p-1">
                            <input aria-label={`Course number, ${sem.label} row ${ri + 1}`} value={course.course_num||''} onChange={e=>updRow(si,ri,'course_num',e.target.value.toUpperCase())}
                              className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 uppercase"/>
                          </td>
                          <td className="p-1">
                            <div className="flex items-center gap-1">
                              <input aria-label={`Course title, ${sem.label} row ${ri + 1}`} value={course.course_title||''} onChange={e=>updRow(si,ri,'course_title',e.target.value)}
                                className={`flex-1 px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400 ${course.completed?'line-through text-surface-400':''}`}/>
                              {isShared && <span className="text-[9px] font-bold text-violet-600 bg-violet-100 px-1 rounded shrink-0">★</span>}
                            </div>
                          </td>
                          <td className="p-1">
                            <input aria-label={`Prerequisites, ${sem.label} row ${ri + 1}`} value={course.prerequisites||''} onChange={e=>updRow(si,ri,'prerequisites',e.target.value)}
                              className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"/>
                          </td>
                          <td className="p-1">
                            <input aria-label={`Credits, ${sem.label} row ${ri + 1}`} value={course.credits||''} onChange={e=>updRow(si,ri,'credits',e.target.value)}
                              className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded text-center focus:outline-none focus:ring-1 focus:ring-brand-400"/>
                          </td>
                          <td className="p-1 text-center text-surface-500">{course.offered||''}</td>
                          <td className="p-1 text-center">
                            <button type="button" onClick={()=>delRow(si,ri)} aria-label={`Remove course row ${ri + 1} from ${sem.label}`} className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
                              <Trash2 size={11} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="px-4 py-2 border-t border-surface-100 flex items-center justify-between">
                  <button onClick={()=>addRow(si)} className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                    <Plus size={11} aria-hidden="true" /> Add course
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
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-brand-300 bg-brand-50 text-brand-700 rounded-lg hover:bg-brand-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            <PlusCircle size={13} aria-hidden="true" /> Add Semester
          </button>

          <div className="relative">
            <button onClick={()=>setShowSummerPicker(p=>!p)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-amber-300 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
              <Sun size={13} aria-hidden="true" /> Add Summer Semester
              <ChevronRight size={11} className={`transition-transform ${showSummerPicker?'rotate-90':''}`} aria-hidden="true" />
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
                      className={`w-full text-left px-2 py-1.5 text-xs rounded-lg transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${exists?'text-surface-300 cursor-not-allowed':'text-amber-700 hover:bg-amber-50'}`}>
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
  const dialogRef = useDialogA11y(true, onClose)
  const { user } = useAuth()
  const [students, setStudents] = useState([])
  const [masterPlanners, setMasterPlanners] = useState([])
  const [form, setForm] = useState({ student_email:'', student_name:'', plan_name:'', programs:[], start_semester:'Fall 2026' })
  const [saving, setSaving] = useState(false)
  const [studentSearch, setStudentSearch] = useState('')
  // Start Semester options come from Settings → Terms (oldest → newest so a
  // plan can start next Fall); default to the current term.
  const { terms, current: currentTerm } = useAcademicTerms()
  const startSemesters = useMemo(() => {
    const fromTerms = sortTermsAsc(terms.filter(t => t.status !== 'Archived')).map(t => t.name)
    return fromTerms.length ? fromTerms : SEMESTERS_LIST
  }, [terms])
  const semDefaultedRef = useRef(false)
  useEffect(() => {
    if (semDefaultedRef.current || !currentTerm) return
    semDefaultedRef.current = true
    setForm(p => ({ ...p, start_semester: currentTerm.name }))
  }, [currentTerm])

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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="New student plan" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <h2 className="text-base font-bold text-surface-900">New Student Plan</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 hover:bg-surface-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={16} className="text-surface-400" aria-hidden="true" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-surface-700 mb-1.5">Student <span className="text-red-500">*</span></label>
            <div className="relative mb-1.5">
              <Search size={13} className="absolute left-2.5 top-2.5 text-surface-400" aria-hidden="true" />
              <input aria-label="Search students" value={studentSearch} onChange={e=>setStudentSearch(e.target.value)} placeholder="Search students…"
                className="w-full pl-7 pr-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40"/>
            </div>
            <div className="border border-surface-200 rounded-lg max-h-36 overflow-y-auto">
              {filteredStudents.length===0
                ? <p className="text-xs text-surface-400 italic p-3">No students found</p>
                : filteredStudents.map(s=>(
                    <button key={s.email} onClick={()=>{setForm(p=>({...p,student_email:s.email,student_name:`${s.first_name} ${s.last_name}`}));setStudentSearch(`${s.first_name} ${s.last_name}`)}}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-brand-50 transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${form.student_email===s.email?'bg-brand-50 text-brand-700 font-medium':''}`}>
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
            <label htmlFor="pp-fld-start-semester-1" className="block text-xs font-semibold text-surface-700 mb-1.5">Start Semester <span className="text-red-500">*</span></label>
            <select id="pp-fld-start-semester-1" value={form.start_semester} onChange={e=>setForm(p=>({...p,start_semester:e.target.value}))}
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 bg-white">
              {startSemesters.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            {form.start_semester&&!form.start_semester.startsWith('Fall')&&(
              <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1"><AlertCircle size={11} aria-hidden="true" /> Plan will be rotated to start from {form.start_semester}.</p>
            )}
          </div>
          <div>
            <label htmlFor="pp-fld-plan-name-optional-2" className="block text-xs font-semibold text-surface-700 mb-1.5">Plan Name (optional)</label>
            <input id="pp-fld-plan-name-optional-2" value={form.plan_name} onChange={e=>setForm(p=>({...p,plan_name:e.target.value}))} placeholder="Auto-generated if blank"
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40"/>
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-surface-200 text-surface-600 rounded-lg hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Cancel</button>
          <button onClick={handleCreate} disabled={saving||!form.student_email||!form.programs.length}
            className="px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            {saving?'Creating…':'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Instructor Note storage ──────────────────────────────────────────────────
// The private Instructor Note (sticky-note icon on the plan list) lives in the
// instructor-only table plan_instructor_notes (security phase 1, 2026-09-28) so
// students can never read it. Until that migration has run, the old
// student_program_plans.instructor_notes column is used as a fallback.
function isMissingTableError(e) {
  const err = e?.cause || e
  const code = err?.code
  return code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(err?.message || '')
}

// ─── StudentPlanView (read-only) ──────────────────────────────────────────────
// `advising`: [{ term_name, met_on, notes?, advised_by? }]; notes render when showNotes.
// Students pass showNotes too — their rows come from my_advising_meetings() (own rows
// only). The plan's private Instructor Note (instructor_notes) is never shown here.
export function StudentPlanView({ plan, onClose, advising = [], showNotes = false, advisingActions = null }) {
  const dialogRef = useDialogA11y(true, onClose)
  const { semesters: cleanSemesters } = useMemo(
    () => migrateLegacySummerSemesters(plan?.semesters||[], plan?.start_semester),
    [plan]
  )
  const totals = creditTotals(cleanSemesters)
  const { total: totalCredits, done: completedCredits, progress: progressCredits, remaining: remainingCredits, donePct: pct } = totals
  const meetings = sortMeetings(advising)

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Student plan" className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center">
              <GraduationCap size={16} className="text-brand-600" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">My Program Plan</h2>
              <p className="text-xs text-surface-400">{plan?.plan_name||'Academic Plan'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>printPlan({...plan,semesters:cleanSemesters},plan?.student_name||'Student',advisingActions?.meetings||meetings,{includeNotes:!!showNotes&&(advisingActions?!!advisingActions.printNotes:true),accessLabel:!!advisingActions?.accessLabel})}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
              <Printer size={13} aria-hidden="true" /> Print / Save PDF
            </button>
            {onClose&&<button type="button" onClick={onClose} aria-label="Close" className="p-1.5 hover:bg-surface-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={16} className="text-surface-400" aria-hidden="true" /></button>}
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
            <DonutChart completed={completedCredits} inProgress={progressCredits} total={totalCredits} size={72}/>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
                <p className="text-xs font-bold text-surface-800">Degree Progress</p>
                <p className="text-[11px] text-surface-600">
                  <span className="font-semibold text-emerald-700">{completedCredits} cr</span> done ·{' '}
                  {progressCredits>0&&<><span className="font-semibold text-amber-700">{progressCredits} cr</span> in progress ·{' '}</>}
                  <span className="font-semibold text-surface-700">{remainingCredits} cr</span> remaining
                </p>
              </div>
              <ProgressBar totals={totals}/>
              <div className="flex justify-between mt-1 gap-2 flex-wrap">
                <p className="text-[10px] text-surface-500">{completedCredits} / {totalCredits} credits complete</p>
                {progressCredits>0&&(
                  <p className="text-[10px] text-surface-600 flex items-center gap-3" aria-hidden="true">
                    <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2 rounded-sm bg-emerald-500"/>Complete</span>
                    <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2 rounded-sm" style={{backgroundColor:IN_PROGRESS_HEX,backgroundImage:IN_PROGRESS_STRIPES}}/>In progress</span>
                  </p>
                )}
                <p className="text-[10px] text-emerald-700 font-semibold">{pct}%</p>
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

        {/* Advising — instructors can check off / take notes right here */}
        {advisingActions&&(
          <div className="px-6 pb-3 shrink-0 max-h-[40vh] overflow-y-auto">
            <AdvisingSection actions={advisingActions} studentName={plan?.student_name||'Student'} idPrefix={`view-${plan?.plan_id}`} />
          </div>
        )}

        {/* Advising history (students: date, who advised, and the advising notes) */}
        {!advisingActions&&meetings.length>0&&(
          <div className="px-6 pb-3 shrink-0">
            <div className="bg-surface-50 border border-surface-200 rounded-xl px-4 py-2.5">
              <p className="text-[11px] font-bold text-surface-700 flex items-center gap-1.5 mb-1">
                <ClipboardCheck size={12} className="text-emerald-600" aria-hidden="true" /> Advising meetings
              </p>
              <ul className={showNotes&&meetings.some(m=>m.notes?.trim())?'space-y-1.5':'flex flex-wrap gap-x-4 gap-y-1'}>
                {meetings.map(m=>(
                  <li key={m.term_name} className="text-[11px] text-surface-600">
                    <span className="font-semibold text-surface-800">{m.term_name}</span> <span className="text-emerald-700" aria-hidden="true">✓</span> {fmtMetOn(m.met_on)}
                    {m.advised_by&&<span className="text-surface-600"> · with {m.advised_by}</span>}
                    {showNotes&&m.notes?.trim()&&<span className="block text-xs text-surface-700 whitespace-pre-wrap pl-3 border-l-2 border-emerald-200 mt-0.5">{m.notes}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

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
                    {isSummer&&<Sun size={13} className="text-amber-200 shrink-0" aria-hidden="true" />}
                    <p className="text-sm font-bold text-white">{sem.label}</p>
                    {isSummer&&<span className="text-[10px] font-semibold text-amber-100 bg-amber-700/60 border border-amber-400/40 px-1.5 py-0.5 rounded-full">Gen Ed only</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {(()=>{const d=rows.filter(c=>courseStatus(c)==='done').length,p=rows.filter(c=>courseStatus(c)==='progress').length;return <>
                      {d>0&&<span className="text-[10px] font-bold text-white">✓ {d}/{rows.length} done</span>}
                      {p>0&&<span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded-full">{p} in progress</span>}
                    </>})()}
                    <span className={`text-xs ${isSummer?'text-amber-200':'text-brand-200'}`}>{semTotal} credits</span>
                  </div>
                </div>
                {isSummer&&(
                  <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5">
                    <p className="text-[11px] text-amber-700 flex items-center gap-1.5"><Sun size={10} aria-hidden="true" /> Summer semester — General Education courses only. No RICT program courses are offered in summer.</p>
                  </div>
                )}
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-surface-200">
                      <th scope="col" className="text-center p-2 font-semibold text-surface-600 w-[7%]"><span aria-hidden="true">✓</span><span className="sr-only">Status</span></th>
                      <th scope="col" className="text-left p-2 font-semibold text-surface-600 w-[15%]">Course #</th>
                      <th scope="col" className="text-left p-2 font-semibold text-surface-600">Course Title</th>
                      <th scope="col" className="text-left p-2 font-semibold text-surface-600 w-[22%]">Prerequisites</th>
                      <th scope="col" className="text-center p-2 font-semibold text-surface-600 w-[10%]">Credits</th>
                      <th scope="col" className="text-center p-2 font-semibold text-surface-600 w-[13%]">Offered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((course,ri)=>{
                      const isShared=course._programs?.length>1
                      const st=courseStatus(course)
                      return (
                        <tr key={ri} className={`border-b border-surface-100 last:border-0 ${st==='done'?'bg-emerald-50/60':st==='progress'?'bg-amber-50/70':isShared?'bg-violet-50/40':''}`}>
                          <td className="p-2 text-center">
                            <StatusMarker status={st}/>
                          </td>
                          <td className={`p-2 font-medium ${course.completed?'text-surface-400 line-through':'text-surface-800'}`}>{course.course_num}</td>
                          <td className={`p-2 ${course.completed?'text-surface-400 line-through':'text-surface-700'}`}>
                            {course.course_title}
                            {isShared&&<span className="ml-1.5 text-[9px] font-bold text-violet-600 bg-violet-100 px-1 rounded">★ Shared</span>}
                            {st==='progress'&&<span className="ml-1.5 text-[9px] font-bold text-amber-800 bg-amber-100 px-1 rounded">In progress</span>}
                          </td>
                          <td className="p-2 text-surface-500">{course.prerequisites||'—'}</td>
                          <td className="p-2 text-center font-semibold text-surface-700">{course.credits}</td>
                          <td className="p-2 text-center text-surface-500">{course.offered||'—'}</td>
                        </tr>
                      )
                    })}
                    <tr className="bg-surface-50 border-t border-surface-200">
                      <td colSpan={4} className="p-2 text-right text-xs font-bold text-surface-600">Semester Total</td>
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
            <AlertCircle size={13} className="text-blue-500 mt-0.5 shrink-0" aria-hidden="true" />
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
  const isInstructor = profile?.role==='Instructor'||isSuperAdmin(profile)

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
  const [confirmDeletePlan,setConfirmDeletePlan]=useState(null) // plan pending delete confirmation
  const [deleting,setDeleting]=useState(false)
  const autoOpenDismissedRef = useRef(false)

  // ── Advising check-off state ──────────────────────────────────────────────
  // Instructors: every advising_meetings row (RLS: instructors only).
  // Students: their own term, date, advising notes and who advised them via the
  // my_advising_meetings() RPC (never other students' rows).
  const { terms, current: currentTermRow } = useAcademicTerms()
  const [advisingRows,setAdvisingRows]=useState([])
  const [advisingError,setAdvisingError]=useState('')
  const [advisingTerm,setAdvisingTerm]=useState(()=>fallbackTermName())
  const [advisingFilter,setAdvisingFilter]=useState('all') // all | done | todo
  const [advisingOpenId,setAdvisingOpenId]=useState(null)  // plan_id whose advising panel is open
  const [advisingDraft,setAdvisingDraft]=useState({met_on:'',notes:''})
  const [advisingBusy,setAdvisingBusy]=useState(false)
  const [confirmRemoveAdvising,setConfirmRemoveAdvising]=useState(null)
  const [advisingMsg,setAdvisingMsg]=useState('')
  const termPickedRef = useRef(false)
  // Instructor printouts include advising notes unless turned off (remembered per browser)
  const [printAdvisingNotes,setPrintAdvisingNotesState]=useState(()=>{ try{ return localStorage.getItem('plannerPrintAdvisingNotes')!=='0' }catch{ return true } })
  // Access Code label spot (Avery 5961) — only wanted when advising, so it starts off for every plan opened
  const [printAccessLabel,setPrintAccessLabel]=useState(false)
  const setPrintAdvisingNotes = v => { setPrintAdvisingNotesState(v); try{ localStorage.setItem('plannerPrintAdvisingNotes',v?'1':'0') }catch{} }

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
      // Instructor Notes come from the instructor-only table (fallback: old column)
      let withNotes=data||[]
      try {
        const noteRows=mustData(await supabase.from('plan_instructor_notes').select('plan_id,note'),'plan_instructor_notes.select')
        const noteMap=new Map((noteRows||[]).map(r=>[r.plan_id,r.note]))
        withNotes=withNotes.map(p=>({...p,instructor_notes:noteMap.has(p.plan_id)?noteMap.get(p.plan_id):(p.instructor_notes||null)}))
      } catch(e) {
        if(!isMissingTableError(e)){ console.error('ProgramPlanner instructor notes:',e); toast.error('Could not load instructor notes — try refreshing before editing a note.') }
      }
      setPlans(withNotes.filter(p=>!archivedSet.has(p.student_email)))
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

  const loadAdvising = useCallback(async () => {
    if (!profile?.email) return
    try {
      const rows = isInstructor
        ? mustData(await supabase.from('advising_meetings').select('*').order('met_on',{ascending:true}), 'advising_meetings.select')
        : mustData(await supabase.rpc('my_advising_meetings'), 'my_advising_meetings')
      setAdvisingRows(rows||[]); setAdvisingError('')
    } catch (e) {
      console.error('ProgramPlanner advising:', e)
      const code = e?.code || e?.cause?.code
      const missing = code==='42P01'||code==='PGRST205'||code==='PGRST202'||/does not exist|schema cache/i.test(e?.message||'')
      // Keep the last-known-good rows; tell instructors why the column may be stale
      setAdvisingError(missing
        ? 'Advising check-off is not set up yet — run the 20260928_advising_meetings.sql migration.'
        : 'Could not load advising check-offs. Showing the last loaded data — try Refresh.')
    }
  },[isInstructor,profile?.email])

  useEffect(()=>{loadPlans()},[loadPlans])
  useEffect(()=>{ setPrintAccessLabel(false) },[editing?.plan_id,viewing?.plan_id])
  useEffect(()=>{loadAdvising()},[loadAdvising])
  useEffect(()=>{if(isInstructor)loadMasterPlanners()},[loadMasterPlanners,isInstructor])
  // Default the advising term to the current term from Settings → Terms (once)
  useEffect(()=>{
    if(termPickedRef.current||!currentTermRow?.name) return
    setAdvisingTerm(currentTermRow.name)
  },[currentTermRow])
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

  const handleDeletePlanConfirmed = async () => {
    if(!confirmDeletePlan) return
    setDeleting(true)
    const {data,error}=await supabase.from('student_program_plans').delete().eq('plan_id',confirmDeletePlan.plan_id).select()
    setDeleting(false)
    if(error){toast.error('Delete failed: '+error.message);return}
    if(!data||data.length===0){toast.error('Delete blocked — no rows removed (check permissions)');return}
    toast.success('Plan deleted'); setConfirmDeletePlan(null); loadPlans()
  }

  const handleDuplicatePlan = async (plan) => {
    const newId='PLAN-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase()
    const dupNote=plan.instructor_notes?`[Duplicated] ${plan.instructor_notes}`:'[Duplicated from existing plan]'
    const {error}=await supabase.from('student_program_plans').insert({
      plan_id:newId, student_email:plan.student_email, student_name:plan.student_name,
      plan_name:`${plan.plan_name} (Copy)`, programs:plan.programs, start_semester:plan.start_semester,
      semesters:plan.semesters, created_by:profile?.email||'', updated_at:new Date().toISOString(),
    }).select()
    if(error){toast.error('Duplicate failed: '+error.message);return}
    // Carry the Instructor Note to the copy (instructor-only table; old column as fallback)
    const noteRes=await supabase.from('plan_instructor_notes')
      .upsert({plan_id:newId,note:dupNote,updated_at:new Date().toISOString(),updated_by_email:profile?.email||null},{onConflict:'plan_id'}).select()
    if(noteRes.error){
      if(isMissingTableError(noteRes.error)) await supabase.from('student_program_plans').update({instructor_notes:dupNote}).eq('plan_id',newId)
      else console.error('ProgramPlanner duplicate note:',noteRes.error)
    }
    toast.success('Plan duplicated — edit the copy to customize'); loadPlans()
  }

  const handleSaveNote = async (planId,note) => {
    const plan=plans.find(p=>p.plan_id===planId)
    const oldNote=plan?.instructor_notes||''
    const nowIso=new Date().toISOString()
    // Instructor-only table: save the note, or remove the row when cleared
    let res=(note||'').trim()
      ? await supabase.from('plan_instructor_notes')
          .upsert({plan_id:planId,note,updated_at:nowIso,updated_by_email:profile?.email||null},{onConflict:'plan_id'}).select()
      : await supabase.from('plan_instructor_notes').delete().eq('plan_id',planId).select()
    if(res.error&&isMissingTableError(res.error)){
      // Security migration not run yet — fall back to the old column
      res=await supabase.from('student_program_plans')
        .update({instructor_notes:note,updated_at:nowIso}).eq('plan_id',planId).select()
    } else if(!res.error){
      if((note||'').trim()&&!(res.data?.length)){toast.error('Note not saved — you may not have permission.');return}
      // Keep the plan's "Recent" position in step with its note, as before
      await supabase.from('student_program_plans').update({updated_at:nowIso}).eq('plan_id',planId)
    }
    if(res.error){toast.error('Failed to save note: '+res.error.message);return}
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

  // ── Advising check-off ────────────────────────────────────────────────────
  const advisingByEmail = useMemo(()=>{
    const m=new Map()
    ;(advisingRows||[]).forEach(r=>{
      const k=(r.student_email||'').toLowerCase()
      if(!m.has(k)) m.set(k,[])
      m.get(k).push(r)
    })
    return m
  },[advisingRows])
  const meetingsFor = email => advisingByEmail.get((email||'').toLowerCase())||[]
  const meetingThisTerm = email => meetingsFor(email).find(r=>r.term_name===advisingTerm)||null

  const advisingTermOptions = useMemo(()=>{
    const names=new Set(sortTermsAsc(terms||[]).map(t=>t.name).filter(n=>/^(Spring|Fall)\s/.test(n||'')))
    ;(advisingRows||[]).forEach(r=>r.term_name&&names.add(r.term_name))
    names.add(advisingTerm)
    if(!terms?.length) names.add(fallbackTermName())
    return [...names].sort((a,b)=>semesterSortKey(a)-semesterSortKey(b))
  },[terms,advisingRows,advisingTerm])

  const myName = profile?`${profile.first_name||''} ${profile.last_name||''}`.trim():''
  const auditAdvising = async (action, entityId, details, oldValue=null, newValue=null) => {
    try {
      await supabase.from('audit_log').insert({
        user_email:profile?.email||'', user_name:myName, action,
        entity_type:'advising_meetings', entity_id:String(entityId), field_changed:'advising',
        old_value:oldValue, new_value:newValue, details,
      })
    } catch (e) { console.error('advising audit:', e) }
  }

  // Shared by the list-row button and the Advising section inside Edit/View.
  // Returns true on success.
  const adviseStudent = async (plan, term, {met_on, notes}={}) => {
    if(advisingBusy) return false
    if(!term){ toast.error('Pick an advising term'); return false }
    setAdvisingBusy(true)
    try {
      const row={
        student_email:plan.student_email, student_name:plan.student_name,
        term_name:term, term_id:(terms||[]).find(t=>t.name===term)?.term_id||null,
        met_on:met_on||todayLocalDate(), notes:(notes||'').trim()||null,
        advised_by:myName, advised_by_email:profile?.email||'',
      }
      const res=assertWrite(await supabase.from('advising_meetings').insert(row).select(),'advising_meetings.insert')
      if(res.error){
        if(isUniqueViolation(res.error)){ toast(`${plan.student_name} was already checked off for ${term}`); await loadAdvising(); return false }
        throw res.error
      }
      const saved=res.data[0]
      setAdvisingRows(prev=>[...prev,saved])
      const msg=`${plan.student_name} marked advised for ${term}`
      setAdvisingMsg(msg); toast.success(msg)
      auditAdvising('CREATE',saved.meeting_id,`Advising check-off: ${plan.student_name} — ${term} (${fmtMetOn(saved.met_on)})${saved.notes?' with note':''}`,null,`${term} ${saved.met_on} ${saved.notes||''}`.trim())
      return true
    } catch(e){ toast.error('Could not save advising check-off: '+(e.message||e)); return false }
    finally{ setAdvisingBusy(false) }
  }
  const handleAdvise = (plan) => adviseStudent(plan, advisingTerm)

  const openAdvisingPanel = (plan) => {
    if(advisingOpenId===plan.plan_id){ setAdvisingOpenId(null); return }
    const row=meetingThisTerm(plan.student_email)
    setAdvisingDraft({met_on:row?.met_on?String(row.met_on).substring(0,10):todayLocalDate(),notes:row?.notes||''})
    setAdvisingOpenId(plan.plan_id)
  }

  // Shared update (date / note) — returns true on success.
  const updateMeeting = async (plan, row, {met_on, notes}) => {
    if(!row||advisingBusy) return false
    if(!met_on){ toast.error('Pick the meeting date'); return false }
    setAdvisingBusy(true)
    try {
      const patch={met_on,notes:(notes||'').trim()||null,updated_at:new Date().toISOString()}
      const res=assertWrite(await supabase.from('advising_meetings').update(patch).eq('meeting_id',row.meeting_id).select(),'advising_meetings.update')
      if(res.error) throw res.error
      const saved=res.data[0]
      setAdvisingRows(prev=>prev.map(r=>r.meeting_id===saved.meeting_id?saved:r))
      setAdvisingMsg(`Advising details saved for ${plan.student_name}`); toast.success('Advising details saved')
      const changes=[]
      if(String(row.met_on).substring(0,10)!==saved.met_on) changes.push(`date ${fmtMetOn(row.met_on)} → ${fmtMetOn(saved.met_on)}`)
      if((row.notes||'')!==(saved.notes||'')) changes.push(row.notes?'note updated':'note added')
      if(changes.length) auditAdvising('UPDATE',saved.meeting_id,`Advising ${row.term_name} for ${plan.student_name}: ${changes.join(', ')}`,`${row.met_on} ${row.notes||''}`.trim(),`${saved.met_on} ${saved.notes||''}`.trim())
      return true
    } catch(e){ toast.error('Could not save: '+(e.message||e)); return false }
    finally{ setAdvisingBusy(false) }
  }
  const handleSaveAdvising = async (plan) => {
    const ok = await updateMeeting(plan, meetingThisTerm(plan.student_email), advisingDraft)
    if(ok) setAdvisingOpenId(null)
  }

  // Whole-program advising report for the selected term (ignores search/filter)
  const handlePrintAdvisingReport = () => {
    const byEmail=new Map()
    plans.forEach(p=>{
      const k=(p.student_email||'').toLowerCase(); if(!k) return
      const cur=byEmail.get(k)||{name:p.student_name,email:p.student_email,programs:[]}
      ;(p.programs||[]).forEach(id=>{ if(!cur.programs.includes(id)) cur.programs.push(id) })
      byEmail.set(k,cur)
    })
    const students=[...byEmail.entries()].map(([k,s])=>{
      const all=sortMeetings(advisingByEmail.get(k)||[])
      const meeting=all.find(m=>m.term_name===advisingTerm)||null
      const earlier=all.filter(m=>semesterSortKey(m.term_name)<semesterSortKey(advisingTerm))
      return {...s,meeting,lastMeeting:earlier[earlier.length-1]||null}
    })
    if(!students.length){ toast.error('No student plans to report on'); return }
    printAdvisingReport({term:advisingTerm,students,preparedBy:myName})
  }

  // Props bundle for the Advising section inside the Edit and View modals
  const advisingActionsFor = (plan) => ({
    meetings: meetingsFor(plan.student_email),
    defaultTerm: advisingTerm,
    termOptions: advisingTermOptions,
    currentTermName: currentTermRow?.name||'',
    busy: advisingBusy,
    unavailable: advisingError,
    printNotes: printAdvisingNotes,
    accessLabel: printAccessLabel,
    setAccessLabel: setPrintAccessLabel,
    setPrintNotes: setPrintAdvisingNotes,
    onAdvise: (term, draft) => adviseStudent(plan, term, draft),
    onUpdate: (row, draft) => updateMeeting(plan, row, draft),
    onRemove: (row) => setConfirmRemoveAdvising({plan,row}),
  })

  const handleRemoveAdvisingConfirmed = async () => {
    const {plan,row}=confirmRemoveAdvising||{}
    if(!row) return
    setAdvisingBusy(true)
    try {
      const res=assertWrite(await supabase.from('advising_meetings').delete().eq('meeting_id',row.meeting_id).select(),'advising_meetings.delete')
      if(res.error) throw res.error
      setAdvisingRows(prev=>prev.filter(r=>r.meeting_id!==row.meeting_id))
      setConfirmRemoveAdvising(null); setAdvisingOpenId(null)
      const msg=`Advising check-off removed for ${plan.student_name} (${row.term_name})`
      setAdvisingMsg(msg); toast.success(msg)
      auditAdvising('DELETE',row.meeting_id,`Advising check-off removed: ${plan.student_name} — ${row.term_name} (was ${fmtMetOn(row.met_on)})`,`${row.term_name} ${row.met_on} ${row.notes||''}`.trim(),null)
    } catch(e){ toast.error('Could not remove: '+(e.message||e)) }
    finally{ setAdvisingBusy(false) }
  }

  const searched = plans
    .filter(p=>`${p.student_name} ${p.student_email} ${p.plan_name}`.toLowerCase().includes(search.toLowerCase()))
  // Advising counts are per STUDENT (a student with two plans counts once)
  const searchedStudents=[...new Set(searched.map(p=>(p.student_email||'').toLowerCase()))]
  const advisedCount=searchedStudents.filter(e=>meetingsFor(e).some(r=>r.term_name===advisingTerm)).length
  const notAdvisedCount=searchedStudents.length-advisedCount
  const filtered = searched
    .filter(p=>{
      if(advisingFilter==='all') return true
      const met=!!meetingThisTerm(p.student_email)
      return advisingFilter==='done'?met:!met
    })
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
          <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center"><GraduationCap size={22} className="text-brand-600" aria-hidden="true" /></div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">My Program Plan</h1>
            <p className="text-sm text-surface-500">Your academic course sequence — see your instructor to request changes.</p>
          </div>
        </div>
        {loading&&<div className="text-sm text-surface-400 text-center py-12">Loading your plan…</div>}
        {!loading&&plans.length===0&&(
          <div className="bg-white border border-surface-200 rounded-2xl p-12 text-center">
            <GraduationCap size={40} className="text-surface-300 mx-auto mb-3" aria-hidden="true" />
            <p className="text-surface-600 font-medium">No plan on file yet</p>
            <p className="text-sm text-surface-400 mt-1">Ask your instructor to set up your program plan.</p>
          </div>
        )}
        {!loading&&plans.length>0&&(
          <div className="space-y-4">
            {plans.map(plan=>{
              const {semesters:cleanSems}=migrateLegacySummerSemesters(plan.semesters||[],plan.start_semester)
              const totals=creditTotals(cleanSems)
              const {total:totalCr,done:doneCr,progress:progCr,donePct:pct}=totals
              const myMeetings=sortMeetings(advisingRows)
              const lastMeeting=myMeetings[myMeetings.length-1]
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
                      <button onClick={()=>printPlan({...plan,semesters:cleanSems},plan.student_name,advisingRows,{includeNotes:true})}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                        <Printer size={13} aria-hidden="true" /> Print
                      </button>
                      <button onClick={()=>setViewing(plan)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                        <BookOpen size={13} aria-hidden="true" /> View Plan
                      </button>
                    </div>
                  </div>
                  {totalCr>0&&(
                    <div className="mt-2">
                      <div className="flex justify-between text-[11px] text-surface-500 mb-1">
                        <span>{doneCr} / {totalCr} credits complete{progCr>0&&<> · <span className="font-semibold text-amber-700">{progCr} cr in progress</span></>}</span>
                        <span className="font-semibold text-emerald-700">{pct}%</span>
                      </div>
                      <ProgressBar totals={totals} height="h-1.5"/>
                    </div>
                  )}
                  {lastMeeting&&(
                    <p className="mt-2 text-[11px] text-surface-600 flex items-center gap-1.5">
                      <ClipboardCheck size={12} className="text-emerald-600" aria-hidden="true" />
                      Last advising meeting: <strong className="text-surface-800">{lastMeeting.term_name}</strong> — {fmtMetOn(lastMeeting.met_on)}{lastMeeting.advised_by?` with ${lastMeeting.advised_by}`:''}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {viewing&&<StudentPlanView plan={viewing} advising={advisingRows} showNotes onClose={()=>{autoOpenDismissedRef.current=true;setViewing(null)}}/>}
      </div>
    )
  }

  // ── Instructor view ────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={()=>navigate('/instructor-tools')}
            className="flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600 hover:bg-surface-100 px-2 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            <ChevronLeft size={15} aria-hidden="true" /> Back
          </button>
          <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
            <GraduationCap size={22} className="text-brand-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Program Planner</h1>
            <p className="text-sm text-surface-500">Create and manage student academic plans.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={()=>{loadPlans();loadAdvising()}} aria-label="Refresh plans" className="p-2 text-surface-400 hover:text-surface-600 hover:bg-surface-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><RefreshCw size={16} aria-hidden="true" /></button>
          <button onClick={()=>setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            <Plus size={15} aria-hidden="true" /> New Student Plan
          </button>
        </div>
      </div>

      {/* Master Planners */}
      <div>
        <h2 className="text-sm font-bold text-surface-700 mb-3 flex items-center gap-2">
          <BookOpen size={15} className="text-brand-500" aria-hidden="true" /> Program Master Planners
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
                    className="flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold border border-brand-200 text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                    <Printer size={12} aria-hidden="true" /> Print Generic Plan
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
          <GraduationCap size={15} className="text-brand-500" aria-hidden="true" /> Student Custom Plans
        </h2>
        <div className="flex items-center gap-1 bg-surface-100 rounded-lg p-0.5">
          {[{val:'recent',label:'Recent'},{val:'first',label:'First Name'},{val:'last',label:'Last Name'}].map(opt=>(
            <button key={opt.val} onClick={()=>handleSortChange(opt.val)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${sortOrder===opt.val?'bg-white text-brand-700 shadow-sm':'text-surface-500 hover:text-surface-700'}`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-2.5 text-surface-400" aria-hidden="true" />
        <input aria-label="Search plans" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by student name, email, or plan name…"
          className="w-full pl-9 pr-4 py-2 text-sm border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/40"/>
      </div>

      {/* Advising check-off toolbar */}
      <div className="flex flex-wrap items-center gap-3 bg-white border border-surface-200 rounded-xl px-4 py-2">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={15} className="text-emerald-600" aria-hidden="true" />
          <label htmlFor="pp-advising-term" className="text-xs font-semibold text-surface-700">Advising term</label>
          <select id="pp-advising-term" value={advisingTerm}
            onChange={e=>{termPickedRef.current=true;setAdvisingTerm(e.target.value);setAdvisingOpenId(null)}}
            className="px-2 py-1.5 text-xs border border-surface-200 rounded-lg bg-white min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            {advisingTermOptions.map(n=><option key={n} value={n}>{n}{n===currentTermRow?.name?' (current)':''}</option>)}
          </select>
        </div>
        <div role="group" aria-label="Filter by advising status" className="flex items-center gap-1 bg-surface-100 rounded-lg p-0.5">
          {[{val:'all',label:`All (${searchedStudents.length})`},{val:'done',label:`Advised (${advisedCount})`},{val:'todo',label:`Not yet advised (${notAdvisedCount})`}].map(opt=>(
            <button key={opt.val} type="button" aria-pressed={advisingFilter===opt.val} onClick={()=>setAdvisingFilter(opt.val)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${advisingFilter===opt.val?'bg-white text-brand-700 shadow-sm':'text-surface-600 hover:text-surface-800'}`}>
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-surface-600 ml-auto" aria-live="polite">
          <strong className="text-emerald-700">{advisedCount}</strong> of {searchedStudents.length} student{searchedStudents.length!==1?'s':''} advised for {advisingTerm}
        </p>
        <button type="button" onClick={handlePrintAdvisingReport} disabled={loading||!plans.length}
          title={`Print who has and hasn't met for advising in ${advisingTerm} (all students, ignores search and filter)`}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-emerald-300 bg-emerald-50 text-emerald-800 rounded-lg hover:bg-emerald-100 disabled:opacity-40 transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
          <Printer size={13} aria-hidden="true" /> Print Advising Report
        </button>
        <p className="sr-only" aria-live="polite">{advisingMsg}</p>
        {advisingError&&(
          <p role="alert" className="w-full text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
            <AlertCircle size={12} aria-hidden="true" /> {advisingError}
          </p>
        )}
      </div>

      {loading&&<div className="space-y-2">{[1,2,3].map(i=><div key={i} className="h-16 bg-surface-100 rounded-xl animate-pulse"/>)}</div>}

      {!loading&&filtered.length===0&&(
        <div className="bg-white border border-surface-200 rounded-2xl p-12 text-center">
          <GraduationCap size={40} className="text-surface-300 mx-auto mb-3" aria-hidden="true" />
          <p className="text-surface-600 font-medium">{advisingFilter!=='all'&&searched.length>0?(advisingFilter==='done'?`No students advised for ${advisingTerm} yet`:`Everyone has been advised for ${advisingTerm}`):search?'No plans match your search':'No student plans yet'}</p>
          <p className="text-sm text-surface-400 mt-1">Click "New Student Plan" to create one.</p>
        </div>
      )}

      {!loading&&filtered.length>0&&(
        <div className="space-y-1.5">
          {filtered.map(plan=>{
            const {semesters:cleanSems}=migrateLegacySummerSemesters(plan.semesters||[],plan.start_semester)
            const totals=creditTotals(cleanSems)
            const {total:totalCr,progressPct:progPct}=totals
            const advRow=meetingThisTerm(plan.student_email)
            const isAdvisingOpen=advisingOpenId===plan.plan_id
            const planMeetings=meetingsFor(plan.student_email)
            const semCount=cleanSems.filter(s=>(s.courses||[]).some(c=>c.course_num||c.course_title)).length
            const lastUpdated=new Date(plan.updated_at||plan.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
            const initials=(plan.student_name||'').split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()
            const isNoteOpen=expandedNoteId===plan.plan_id
            const hasNote=!!plan.instructor_notes?.trim()
            const pct=totals.donePct
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
                        <ProgressBar totals={totals} height="h-1"/>
                        <div className="text-[10px] font-medium mt-0.5 text-right">
                          <span className="text-emerald-700">{pct}% done</span>
                          {progPct>0&&<span className="text-amber-700"> · {progPct}% in progress</span>}
                        </div>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-surface-300 shrink-0 w-24 text-right hidden 2xl:block" title={`Plan last updated ${lastUpdated}`}>{lastUpdated}</p>
                  {advRow?(
                    <button type="button" onClick={()=>openAdvisingPanel(plan)} aria-expanded={isAdvisingOpen}
                      aria-label={`${plan.student_name} advised for ${advisingTerm} on ${fmtMetOn(advRow.met_on)}. Edit date or note, or remove the check-off.`}
                      title="Advised — click to edit date/note or remove"
                      className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition-colors shrink-0 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                      <Check size={12} aria-hidden="true" /> Advised {fmtMetOn(advRow.met_on,false)}
                      {advRow.notes&&<StickyNote size={10} className="text-emerald-600" aria-hidden="true" />}
                    </button>
                  ):(
                    <button type="button" onClick={()=>handleAdvise(plan)} disabled={advisingBusy||!!advisingError}
                      aria-label={`Mark ${plan.student_name} advised for ${advisingTerm}`}
                      title={`Check off: met for advising in ${advisingTerm}`}
                      className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded-lg border border-dashed border-surface-300 text-surface-600 hover:border-emerald-400 hover:text-emerald-700 hover:bg-emerald-50 transition-colors shrink-0 min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                      <ClipboardCheck size={12} aria-hidden="true" /> Advise
                    </button>
                  )}
                  <button onClick={()=>toggleNote(plan.plan_id,plan.instructor_notes)}
                    title={hasNote?'View/edit instructor note':'Add instructor note'} aria-label={hasNote?'View/edit instructor note':'Add instructor note'}
                    className={`p-1.5 rounded-lg transition-colors shrink-0 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${hasNote?'text-amber-500 bg-amber-50 hover:bg-amber-100':'text-surface-300 hover:text-amber-400 hover:bg-amber-50'}`}>
                    <StickyNote size={14} aria-hidden="true" />
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={()=>setViewing(plan)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                      <BookOpen size={11} aria-hidden="true" /> View
                    </button>
                    <button onClick={()=>printPlan({...plan,semesters:cleanSems},plan.student_name,planMeetings,{includeNotes:printAdvisingNotes})}
                      className="p-1.5 border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center" title="Print" aria-label="Print">
                      <Printer size={12} aria-hidden="true" />
                    </button>
                    <button onClick={()=>setEditing(plan)}
                      className="px-2.5 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                      Edit
                    </button>
                    <button type="button" aria-label={`Duplicate plan for ${plan.student_name}`} onClick={()=>handleDuplicatePlan(plan)}
                      className="p-1.5 border border-surface-200 rounded-lg text-surface-500 hover:bg-violet-50 hover:text-violet-600 hover:border-violet-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center" title="Duplicate plan">
                      <Copy size={12} aria-hidden="true" />
                    </button>
                    <button onClick={()=>setConfirmDeletePlan(plan)}
                      className="p-1.5 text-surface-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center" title="Delete plan" aria-label="Delete plan">
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {isAdvisingOpen&&advRow&&(
                  <div className="border-t border-emerald-100 bg-emerald-50/50 px-4 pb-3 pt-2.5">
                    <p className="text-[11px] font-semibold text-emerald-800 mb-1.5 flex items-center gap-1.5">
                      <ClipboardCheck size={11} aria-hidden="true" /> Advising — {advisingTerm}
                      {advRow.advised_by&&<span className="text-surface-500 font-normal">· checked off by {advRow.advised_by}</span>}
                    </p>
                    <div className="flex flex-wrap items-start gap-3">
                      <div>
                        <label htmlFor={`pp-adv-date-${plan.plan_id}`} className="block text-[11px] font-semibold text-surface-700 mb-1">Meeting date</label>
                        <input id={`pp-adv-date-${plan.plan_id}`} type="date" value={advisingDraft.met_on}
                          onChange={e=>setAdvisingDraft(d=>({...d,met_on:e.target.value}))}
                          className="px-2 py-1.5 text-xs border border-emerald-200 rounded-lg bg-white min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"/>
                      </div>
                      <div className="flex-1 min-w-[220px]">
                        <label htmlFor={`pp-adv-note-${plan.plan_id}`} className="block text-[11px] font-semibold text-surface-700 mb-1">
                          Advising note (optional) <span className="text-surface-600 font-normal">— the student can see this on their plan</span>
                        </label>
                        <textarea id={`pp-adv-note-${plan.plan_id}`} value={advisingDraft.notes} rows={2}
                          onChange={e=>setAdvisingDraft(d=>({...d,notes:e.target.value}))}
                          placeholder="What you discussed, next-term registration, concerns…"
                          className="w-full text-xs border border-emerald-200 rounded-lg px-3 py-2 resize-none bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"/>
                      </div>
                    </div>
                    {planMeetings.filter(m=>m.term_name!==advisingTerm).length>0&&(
                      <p className="text-[11px] text-surface-600 mt-1.5">
                        <span className="font-semibold">Other terms:</span>{' '}
                        {sortMeetings(planMeetings.filter(m=>m.term_name!==advisingTerm)).map(m=>`${m.term_name} (${fmtMetOn(m.met_on,false)})`).join(' · ')}
                      </p>
                    )}
                    <div className="flex flex-wrap justify-end gap-2 mt-2">
                      <button type="button" onClick={()=>setConfirmRemoveAdvising({plan,row:advRow})} disabled={advisingBusy}
                        className="px-3 py-1.5 text-xs border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] mr-auto">
                        Remove check-off
                      </button>
                      <button type="button" onClick={()=>setAdvisingOpenId(null)} className="px-3 py-1.5 text-xs border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Cancel</button>
                      <button type="button" onClick={()=>handleSaveAdvising(plan)} disabled={advisingBusy}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                        <Save size={11} aria-hidden="true" /> {advisingBusy?'Saving…':'Save'}
                      </button>
                    </div>
                  </div>
                )}

                {isNoteOpen&&(
                  <div className="border-t border-amber-100 bg-amber-50/50 px-4 pb-3 pt-2.5 rounded-b-xl">
                    <p className="text-[11px] font-semibold text-amber-600 mb-1.5 flex items-center gap-1.5">
                      <StickyNote size={11} aria-hidden="true" /> Instructor Note <span className="text-surface-400 font-normal">— not visible to students</span>
                    </p>
                    <textarea aria-label="Instructor note" value={noteText} onChange={e=>setNoteText(e.target.value)}
                      placeholder="Add private notes about why this plan was created, exceptions made, advising context…"
                      rows={3} className="w-full text-xs border border-amber-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-amber-400/40 bg-white"/>
                    <div className="flex justify-end gap-2 mt-1.5">
                      <button onClick={()=>setExpandedNoteId(null)} className="px-3 py-1.5 text-xs border border-surface-200 rounded-lg text-surface-500 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Cancel</button>
                      <button onClick={()=>handleSaveNote(plan.plan_id,noteText)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                        <Save size={11} aria-hidden="true" /> Save Note
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
      {editing&&<PlanEditorModal plan={editing} advising={meetingsFor(editing.student_email)} advisingActions={advisingActionsFor(editing)} onSave={newSems=>handleSavePlan(editing.plan_id,newSems)} onClose={()=>setEditing(null)}/>}
      {viewing&&<StudentPlanView plan={viewing} advising={meetingsFor(viewing.student_email)} showNotes advisingActions={advisingActionsFor(viewing)} onClose={()=>setViewing(null)}/>}

      {confirmRemoveAdvising&&(
        <ConfirmDialog
          open
          variant="danger"
          title="Remove advising check-off?"
          message={
            <>
              Remove the <strong>{confirmRemoveAdvising.row.term_name}</strong> advising check-off for{' '}
              <strong>{confirmRemoveAdvising.plan.student_name}</strong>
              {confirmRemoveAdvising.row.notes?' and its note':''}?
            </>
          }
          confirmLabel="Remove check-off"
          cancelLabel="Keep it"
          busy={advisingBusy}
          onConfirm={handleRemoveAdvisingConfirmed}
          onClose={()=>setConfirmRemoveAdvising(null)}
        />
      )}

      {confirmDeletePlan&&(
        <ConfirmDialog
          open
          variant="danger"
          title="Delete plan?"
          message={
            <>
              Delete <strong>{confirmDeletePlan.plan_name}</strong> for{' '}
              <strong>{confirmDeletePlan.student_name}</strong>? This cannot be undone.
            </>
          }
          confirmLabel="Delete plan"
          cancelLabel="Keep plan"
          busy={deleting}
          onConfirm={handleDeletePlanConfirmed}
          onClose={()=>setConfirmDeletePlan(null)}
        />
      )}
    </div>
  )
}
