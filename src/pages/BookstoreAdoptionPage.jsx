/**
 * RICT CMMS — Bookstore Adoption
 *
 * One page to have open while doing book adoption on the bookstore site:
 * pick a term (Spring / Fall), see every RICT course running that term, and
 * under each course every tool, supply, software, and textbook its syllabus
 * requires — marked
 *
 *   • Required      — this course is where the student first needs it
 *   • Already Have  — an earlier course in the program already required it
 *
 * Where the data comes from
 *   • Courses for the term — the term's class schedule (classes.semester).
 *     If no classes exist for that term yet, falls back to the approved
 *     master planners: Semester I / III = Fall, II / IV = Spring (Fall start).
 *   • Items for each course — the syllabus saved for that exact term; if none,
 *     the newest syllabus at or before the term; if none, the newest overall;
 *     if no syllabus at all, the course catalog's suggested materials.
 *   • Required vs Already Have — the SAME engine Program Cost uses
 *     (buildCostBreakdown), walked through each approved program planner.
 *     When a course sits in more than one program and an item is first
 *     required in one but already owned in another, it is marked Required
 *     (safe for the bookstore) with a note naming the program that already
 *     has it.
 *   • Non-RICT courses (MATH, ENGL, …) are left off.
 *
 * Read-only: nothing on this page writes to the database.
 *
 * Accessibility (WCAG 2.1 AA / Section 508): labelled term select and
 * search, filter buttons with aria-pressed, 44px targets, focus-visible
 * rings, status badges carry text + icon (never colour alone), tables with
 * captions and scoped headers, and a polite live region announcing counts
 * whenever the term or filter changes.
 *
 * File: src/pages/BookstoreAdoptionPage.jsx
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShoppingBag, ChevronLeft, Printer, Copy, Search, AlertCircle, Link2Off,
  CheckCircle2, PackageCheck, DollarSign, CalendarRange, Loader2, RefreshCw, FileText,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useSemesterOptions } from '@/hooks/useClassSchedule'
import { useAcademicTerms } from '@/hooks/useAcademicTerms'
import { parseTermName, currentTerm, termAfter } from '@/lib/academicTerms'
import { buildCostBreakdown } from '@/pages/ProgramCostPage'

// Same column sets Program Cost selects, so the engine sees identical input.
const TOOL_COLS     = 'tool_id,item_name,part_number,cost,item_type,status'
const TEMPLATE_COLS = 'course_id,course_type,required_materials,required_material_ids,semester,status,updated_at'

const CATEGORY_ORDER = { Tool: 1, Software: 2, Material: 3, Supply: 4, Textbook: 5, Other: 6 }

const fmtCurrency = (n) =>
  n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'TBD'

const normId  = (s) => String(s || '').toUpperCase().replace(/\s+/g, '')
const isRict  = (s) => normId(s).startsWith('RICT')
const itemKey = (t) => `${String(t.name || '').trim().toLowerCase()}|${String(t.partNumber || '').trim().toLowerCase()}`
const esc     = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

/**
 * One syllabus row per course for the chosen term:
 *   exact term → newest at or before the term → newest overall.
 * Archived syllabi are ignored. Returns an array suitable to hand straight to
 * buildCostBreakdown (whose own picker then sees exactly one row per course).
 */
export function chooseTemplatesForTerm(rows, termName) {
  const target = parseTermName(termName)
  const byCourse = {}
  ;(rows || []).forEach(t => {
    if (!t.course_id) return
    if (String(t.status || '').toLowerCase() === 'archived') return
    ;(byCourse[t.course_id] = byCourse[t.course_id] || []).push(t)
  })
  const order = (t) => (t.semester ? parseTermName(t.semester).order || 0 : 0)
  const newest = (list) => [...list].sort((a, b) =>
    (order(b) - order(a)) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0]

  return Object.values(byCourse).map(list => {
    const exact = list.filter(t => t.semester && parseTermName(t.semester).name === target.name)
    if (exact.length) return newest(exact)
    const notAfter = list.filter(t => order(t) <= (target.order || Infinity))
    return newest(notAfter.length ? notAfter : list)
  })
}

/** Newest approved planner per program name. */
export function latestPlanners(revisions) {
  const by = new Map()
  ;(revisions || []).forEach(r => {
    const name = String(r.current_program_name || r.planner_name || '').trim()
    if (!name || !Array.isArray(r.planner_semesters)) return
    const k = name.toLowerCase()
    const prev = by.get(k)
    if (!prev || String(r.approved_at || '') > String(prev.approved_at || '')) by.set(k, r)
  })
  return [...by.values()].sort((a, b) =>
    String(a.current_program_name || a.planner_name).localeCompare(String(b.current_program_name || b.planner_name)))
}

const programLabel = (p) => String(p.current_program_name || p.planner_name || 'Program').trim()

/**
 * Which season a master-planner semester falls in. Explicit Fall/Spring/Summer
 * in the label wins; otherwise "Semester I/III" (odd) = Fall and "II/IV"
 * (even) = Spring; otherwise position among non-summer semesters.
 */
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 }
export function seasonOfPlannerSemester(label, idx) {
  const l = String(label || '').toLowerCase()
  if (/\bfall\b/.test(l))   return 'Fall'
  if (/\bspring\b/.test(l)) return 'Spring'
  if (/\bsummer\b/.test(l)) return 'Summer'
  const m = l.match(/semester\s+([ivx]+|\d+)\b/)
  if (m) {
    const n = ROMAN[m[1]] || parseInt(m[1], 10)
    if (n) return n % 2 === 1 ? 'Fall' : 'Spring'
  }
  return idx % 2 === 0 ? 'Fall' : 'Spring'
}

/** RICT courses the planners place in the given season (fallback when no schedule). */
export function plannerCoursesForSeason(planners, season) {
  const out = new Map()
  ;(planners || []).forEach(p => {
    let idx = 0
    ;(p.planner_semesters || []).forEach(sem => {
      const s = seasonOfPlannerSemester(sem.label, idx)
      if (s !== 'Summer') idx++
      if (s !== season) return
      ;(sem.courses || []).forEach(c => {
        if (!isRict(c.course_num)) return
        const k = normId(c.course_num)
        if (!out.has(k)) out.set(k, { course_id: c.course_num.trim(), course_name: c.course_title || '' })
      })
    })
  })
  return [...out.values()]
}

/**
 * The adoption list: one entry per course, each item marked required / have.
 */
export function buildAdoptionList({ termName, termCourses, planners, courses, toolCatalog, templates }) {
  const chosen = chooseTemplatesForTerm(templates, termName)
  const runs = (planners || []).map(p => ({
    program: programLabel(p),
    bd: buildCostBreakdown(p, courses || [], toolCatalog || [], {}, chosen, {}, {}),
  }))

  return (termCourses || []).map(tc => {
    const id = normId(tc.course_id)
    const hits = []
    runs.forEach(r => {
      for (const sem of r.bd.semesters) {
        const c = sem.courses.find(x => normId(x.course_num) === id)
        if (c) { hits.push({ program: r.program, course: c }); break }
      }
    })

    // Not in any approved planner — run it alone so its items still resolve
    // against the catalog. Nothing earlier exists, so everything is Required.
    let base = hits[0]?.course
    if (!base) {
      const solo = buildCostBreakdown(
        { planner_semesters: [{ label: '', courses: [{ course_num: tc.course_id, course_title: tc.course_name }] }] },
        courses || [], toolCatalog || [], {}, chosen, {}, {})
      base = solo.semesters[0]?.courses[0]
    }

    const items = (base?.toolItems || []).map(t => {
      const k = itemKey(t)
      const perProgram = hits.map(h => {
        const m = h.course.toolItems.find(x => itemKey(x) === k)
        return m ? { program: h.program, required: !!m.firstOccurrence, countedIn: m.countedIn || '' } : null
      }).filter(Boolean)
      const required = perProgram.length === 0 || perProgram.some(p => p.required)
      return {
        key: k,
        name: t.name,
        category: t.category || 'Other',
        partNumber: t.partNumber || '',
        cost: t.cost ?? null,
        linked: !!t.linked,
        inactive: !!t.inactive,
        status: required ? 'required' : 'have',
        alreadyFrom: perProgram.filter(p => !p.required).map(p => ({ program: p.program, course: p.countedIn })),
      }
    }).sort((a, b) =>
      (a.status === b.status ? 0 : a.status === 'required' ? -1 : 1)
      || ((CATEGORY_ORDER[a.category] || 99) - (CATEGORY_ORDER[b.category] || 99))
      || a.name.localeCompare(b.name))

    const catalogName = (courses || []).find(c => normId(c.course_id) === id)?.course_name
    return {
      course_id: tc.course_id,
      course_name: tc.course_name || base?.course_title || catalogName || '',
      programs: hits.map(h => h.program),
      inPlanner: hits.length > 0,
      materialSource: base?.materialSource || null,
      items,
      requiredCount: items.filter(i => i.status === 'required').length,
      haveCount: items.filter(i => i.status === 'have').length,
      requiredCost: items.filter(i => i.status === 'required').reduce((s, i) => s + (i.cost || 0), 0),
      unlinkedCount: items.filter(i => !i.linked).length,
    }
  }).sort((a, b) => normId(a.course_id).localeCompare(normId(b.course_id)))
}

/** "from RICT 1110" or "from RICT 1110 (Mechatronics AAS), RICT 1120 (IPC AAS)". */
function alreadyText(item, multiProgram) {
  const parts = item.alreadyFrom.map(a => multiProgram ? `${a.course || 'an earlier course'} (${a.program})` : (a.course || 'an earlier course'))
  return [...new Set(parts)].join(', ')
}

function courseCopyText(course, filter) {
  const lines = [`${course.course_id}${course.course_name ? ` — ${course.course_name}` : ''}`]
  const req  = course.items.filter(i => i.status === 'required')
  const have = course.items.filter(i => i.status === 'have')
  const fmtLine = (i) => `- ${i.name}${i.partNumber ? ` (Part #/ISBN: ${i.partNumber})` : ''}${i.cost != null ? ` — ${fmtCurrency(i.cost)}` : ''}`
  lines.push('', 'REQUIRED:')
  lines.push(...(req.length ? req.map(fmtLine) : ['- (none)']))
  if (filter !== 'required') {
    lines.push('', 'ALREADY HAVE:')
    lines.push(...(have.length ? have.map(i => `${fmtLine(i)} — from ${alreadyText(i, course.programs.length > 1)}`) : ['- (none)']))
  }
  return lines.join('\n')
}

function printAdoption(termName, list, filter, sourceNote) {
  const sections = list.map(c => {
    const items = filter === 'required' ? c.items.filter(i => i.status === 'required') : c.items
    const multi = c.programs.length > 1
    const rows = items.length
      ? items.map(i => {
          const status = i.status === 'required'
            ? `<b>Required</b>${i.alreadyFrom.length ? `<div class="note">Already have for ${esc(alreadyText(i, true))}</div>` : ''}`
            : `Already Have<div class="note">from ${esc(alreadyText(i, multi))}</div>`
          return `<tr class="${i.status}"><td>${esc(i.name)}</td><td class="mono">${esc(i.partNumber || '—')}</td><td>${esc(i.category)}</td><td class="amt">${esc(fmtCurrency(i.cost))}</td><td>${status}</td></tr>`
        }).join('')
      : `<tr><td colspan="5" class="empty">No ${filter === 'required' ? 'required ' : ''}items listed.</td></tr>`
    return `<section><h2>${esc(c.course_id)}${c.course_name ? ` — ${esc(c.course_name)}` : ''}</h2>
      <p class="meta">${c.requiredCount} required · ${c.haveCount} already have${c.programs.length ? ` · ${esc(c.programs.join(', '))}` : ''}</p>
      <table><thead><tr><th scope="col">Item</th><th scope="col">Part # / ISBN</th><th scope="col">Category</th><th scope="col" class="amt">Price</th><th scope="col">Status</th></tr></thead>
      <tbody>${rows}</tbody></table></section>`
  }).join('')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bookstore Adoption — ${esc(termName)}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111}
    h1{font-size:16pt;margin:0 0 2px}h2{font-size:11pt;margin:16px 0 2px}
    .sub,.meta{font-size:8.5pt;color:#444;margin:0 0 6px}
    table{width:100%;border-collapse:collapse;font-size:8.5pt}
    th{background:#e5e7eb;text-align:left;padding:3px 6px;border:1px solid #9ca3af}
    td{padding:3px 6px;border:1px solid #d1d5db;vertical-align:top}
    tr.have td{color:#444}
    .amt{text-align:right;white-space:nowrap}.mono{font-family:Consolas,monospace}
    .note{font-size:7.5pt;color:#555}.empty{color:#666;font-style:italic}
    section{break-inside:avoid;page-break-inside:avoid}
    @media print{body{margin:.5in}thead{display:table-header-group}}
  </style></head><body>
  <h1>Bookstore Adoption — ${esc(termName)}</h1>
  <p class="sub">${esc(sourceNote)} · ${filter === 'required' ? 'Required items only' : 'All items'} · Printed ${esc(new Date().toLocaleDateString('en-US'))}</p>
  ${sections || '<p>No RICT courses found for this term.</p>'}
  <p class="sub" style="margin-top:12px">Required = first course in the program that needs the item. Already Have = purchased for an earlier course. Prices are catalog estimates.</p>
  </body></html>`
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300) }
  else toast.error('Pop-up blocked — allow pop-ups for this site to print.')
}

// ─── UI pieces ───────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  return status === 'required'
    ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold bg-emerald-50 text-emerald-800 border-emerald-300 whitespace-nowrap">
        <CheckCircle2 size={12} aria-hidden="true" /> Required
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold bg-surface-100 text-surface-700 border-surface-300 whitespace-nowrap">
        <PackageCheck size={12} aria-hidden="true" /> Already Have
      </span>
    )
}

function CourseCard({ course, filter, onCopy }) {
  const items = filter === 'required' ? course.items.filter(i => i.status === 'required') : course.items
  const headingId = `ba-course-${normId(course.course_id)}`
  const multi = course.programs.length > 1
  const src = course.materialSource
  return (
    <section id={headingId} aria-labelledby={`${headingId}-h`} className="bg-white border border-surface-200 rounded-2xl overflow-hidden scroll-mt-4">
      <div className="px-5 py-4 border-b border-surface-100 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 id={`${headingId}-h`} className="text-base font-bold text-surface-900">
            {course.course_id}{course.course_name && <span className="font-medium text-surface-700"> — {course.course_name}</span>}
          </h2>
          <p className="text-xs text-surface-600 mt-0.5">
            <strong className="text-emerald-800">{course.requiredCount} required</strong>
            {' · '}{course.haveCount} already have
            {course.requiredCount > 0 && <> · required est. {fmtCurrency(course.requiredCost)}</>}
          </p>
          <p className="text-[11px] text-surface-600 mt-1 flex items-center gap-1.5 flex-wrap">
            <FileText size={11} aria-hidden="true" />
            {src?.kind === 'syllabus'
              ? <span>From the {src.semester || 'saved'} syllabus</span>
              : src?.kind === 'catalog'
                ? <span className="text-amber-800">No saved syllabus — using the course catalog's suggested materials</span>
                : <span className="text-amber-800">No syllabus or suggested materials on file</span>}
            {course.programs.length > 0
              ? <span>· {course.programs.join(', ')}</span>
              : <span className="text-amber-800">· Not in an approved program planner — all items shown as Required</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onCopy(course)}
          aria-label={`Copy item list for ${course.course_id}`}
          className="flex items-center gap-1.5 px-3 min-h-[44px] text-xs font-semibold border border-surface-200 rounded-lg text-surface-700 hover:bg-surface-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 shrink-0"
        >
          <Copy size={13} aria-hidden="true" /> Copy list
        </button>
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-surface-600 italic">
          {course.items.length === 0 ? 'No tools or materials listed for this course.' : 'Nothing new to buy — students already have everything for this course.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <caption className="sr-only">
              {`Items for ${course.course_id}${filter === 'required' ? ', required only' : ''}`}
            </caption>
            <thead>
              <tr className="bg-surface-50 text-[11px] uppercase tracking-wide text-surface-600">
                <th scope="col" className="px-4 py-2 font-semibold">Item</th>
                <th scope="col" className="px-3 py-2 font-semibold hidden sm:table-cell">Part # / ISBN</th>
                <th scope="col" className="px-3 py-2 font-semibold hidden md:table-cell">Category</th>
                <th scope="col" className="px-3 py-2 font-semibold text-right">Price</th>
                <th scope="col" className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.key} className={`border-t border-surface-100 ${i.status === 'have' ? 'bg-surface-50/40' : ''}`}>
                  <td className="px-4 py-2.5 text-sm text-surface-900">
                    {i.name}
                    {!i.linked && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-rose-700">
                        <Link2Off size={10} aria-hidden="true" /> not in catalog
                      </span>
                    )}
                    {i.inactive && <span className="ml-1.5 text-[10px] font-semibold text-amber-800">retired item</span>}
                    {i.partNumber && <span className="block sm:hidden text-[11px] text-surface-600 font-mono">{i.partNumber}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-surface-700 font-mono hidden sm:table-cell">{i.partNumber || '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-surface-700 hidden md:table-cell">{i.category}</td>
                  <td className="px-3 py-2.5 text-xs text-surface-700 text-right whitespace-nowrap">{fmtCurrency(i.cost)}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={i.status} />
                    {i.status === 'have' && (
                      <span className="block text-[11px] text-surface-600 mt-0.5">from {alreadyText(i, multi)}</span>
                    )}
                    {i.status === 'required' && i.alreadyFrom.length > 0 && (
                      <span className="block text-[11px] text-surface-600 mt-0.5">Already have for {alreadyText(i, true)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BookstoreAdoptionPage() {
  const navigate = useNavigate()
  const { semesters, classes, loading: semLoading } = useSemesterOptions()
  const { terms, loading: termsLoading } = useAcademicTerms()

  const [term, setTerm]       = useState('')
  const [filter, setFilter]   = useState('all')      // 'all' | 'required'
  const [query, setQuery]     = useState('')
  const [data, setData]       = useState(null)       // { revisions, courses, tools, templates }
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const loadedRef = useRef(false)

  // ── Load (every read feeds a user-visible list → mustData) ─────────────────
  const load = useCallback(async () => {
    try {
      const [revRes, coursesRes, toolsRes, tmplRes] = await Promise.all([
        supabase.from('program_revisions').select('revision_id,current_program_name,planner_semesters,planner_name,academic_year,approved_at').eq('status', 'approved').not('planner_semesters', 'is', null),
        supabase.from('syllabus_courses').select('course_id,course_name,credits_lecture,credits_lab,credits_soe,suggested_materials'),
        supabase.from('program_tools').select(TOOL_COLS),
        supabase.from('syllabus_templates').select(TEMPLATE_COLS),
      ])
      setData({
        revisions: mustData(revRes, 'program_revisions.select') || [],
        courses:   mustData(coursesRes, 'syllabus_courses.select') || [],
        tools:     mustData(toolsRes, 'program_tools.select') || [],
        templates: mustData(tmplRes, 'syllabus_templates.select') || [],
      })
      setError('')
      loadedRef.current = true
    } catch (e) {
      console.error('BookstoreAdoption load:', e)
      // Keep showing the last good data on a realtime refetch failure.
      if (!loadedRef.current) setError(e.message || 'Could not load adoption data.')
      else toast.error('Could not refresh adoption data: ' + (e.message || 'unknown error'))
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => subscribeWithReconnect(`bookstore-adoption-${Math.random().toString(36).slice(2)}`, ch => ch
    .on('postgres_changes', { event: '*', schema: 'public', table: 'program_tools' }, load)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'syllabus_templates' }, load)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'program_revisions' }, load)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'syllabus_courses' }, load)
  , { tag: 'BookstoreAdoption', onReconnect: load }), [load])

  // ── Term options: Spring / Fall only ───────────────────────────────────────
  const termOptions = useMemo(
    () => semesters.filter(s => ['Spring', 'Fall'].includes(parseTermName(s.name).season)),
    [semesters]
  )

  // Default to the NEXT term (adoption is done ahead of time); else current; else newest.
  useEffect(() => {
    if (term || semLoading || termsLoading || !termOptions.length) return
    const names = new Set(termOptions.map(t => t.name))
    const active = terms.filter(t => t.status !== 'Archived')
    const cur = currentTerm(active)
    const sorted = active.filter(t => ['Spring', 'Fall'].includes(parseTermName(t.name).season))
    let next = cur
    while (next && (next = termAfter(sorted, next)) && !names.has(next.name)) { /* skip non-listed */ }
    const pick = (next && names.has(next.name) && next.name)
      || (cur && names.has(cur.name) && cur.name)
      || termOptions[0].name
    setTerm(pick)
  }, [term, semLoading, termsLoading, termOptions, terms])

  const planners = useMemo(() => latestPlanners(data?.revisions), [data])

  // ── Courses running in the term ────────────────────────────────────────────
  const { termCourses, source } = useMemo(() => {
    if (!term) return { termCourses: [], source: 'none' }
    const target = parseTermName(term).name
    const seen = new Map()
    ;(classes || []).forEach(c => {
      if (parseTermName(c.semester).name !== target || !isRict(c.course_id)) return
      const k = normId(c.course_id)
      if (!seen.has(k)) seen.set(k, { course_id: String(c.course_id).trim(), course_name: c.course_name || '' })
    })
    if (seen.size) return { termCourses: [...seen.values()], source: 'schedule' }
    const season = parseTermName(term).season
    return { termCourses: plannerCoursesForSeason(planners, season), source: 'planner' }
  }, [term, classes, planners])

  const list = useMemo(() => {
    if (!data || !term) return []
    return buildAdoptionList({
      termName: term, termCourses, planners,
      courses: data.courses, toolCatalog: data.tools, templates: data.templates,
    })
  }, [data, term, termCourses, planners])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(c =>
      `${c.course_id} ${c.course_name}`.toLowerCase().includes(q)
      || c.items.some(i => `${i.name} ${i.partNumber}`.toLowerCase().includes(q)))
  }, [list, query])

  const totals = useMemo(() => ({
    courses:  visible.length,
    required: visible.reduce((s, c) => s + c.requiredCount, 0),
    have:     visible.reduce((s, c) => s + c.haveCount, 0),
    cost:     visible.reduce((s, c) => s + c.requiredCost, 0),
    unlinked: visible.reduce((s, c) => s + c.unlinkedCount, 0),
    noSyllabus: visible.filter(c => c.materialSource?.kind !== 'syllabus').map(c => c.course_id),
  }), [visible])

  const season = parseTermName(term).season
  const sourceNote = source === 'schedule'
    ? `Courses from the ${term} class schedule`
    : `No ${term} class schedule yet — courses from the program planners (${season === 'Fall' ? 'Semester I & III' : 'Semester II & IV'})`

  const handleCopy = useCallback(async (course) => {
    const text = courseCopyText(course, filter)
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg(`Copied the item list for ${course.course_id}.`)
      toast.success(`Copied ${course.course_id}`)
    } catch {
      setCopyMsg(`Could not copy the list for ${course.course_id}. Your browser blocked clipboard access.`)
      toast.error('Clipboard blocked by the browser')
    }
  }, [filter])

  const busy = loading || semLoading || termsLoading

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/instructor-tools')}
            className="flex items-center gap-1 text-sm text-surface-600 hover:text-brand-600 hover:bg-surface-100 px-2 min-h-[44px] rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            <ChevronLeft size={15} aria-hidden="true" /> Back
          </button>
          <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
            <ShoppingBag size={22} className="text-indigo-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Bookstore Adoption</h1>
            <p className="text-sm text-surface-600">What students must buy for each course this term — and what they already have.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/program-cost')}
            className="flex items-center gap-1.5 px-3 min-h-[44px] text-xs font-medium border border-surface-200 rounded-lg text-surface-700 hover:bg-surface-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            <DollarSign size={13} aria-hidden="true" /> Program Cost
          </button>
          <button
            type="button"
            onClick={() => printAdoption(term, visible, filter, sourceNote)}
            disabled={busy || !visible.length}
            className="flex items-center gap-1.5 px-4 min-h-[44px] text-sm font-semibold border border-indigo-200 bg-indigo-50 text-indigo-800 rounded-xl hover:bg-indigo-100 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            <Printer size={14} aria-hidden="true" /> Print
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white border border-surface-200 rounded-2xl p-5 grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
        <div>
          <label htmlFor="ba-term" className="block text-xs font-semibold text-surface-700 mb-1.5">Term</label>
          <div className="relative">
            <CalendarRange size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none" aria-hidden="true" />
            <select
              id="ba-term"
              value={term}
              onChange={e => setTerm(e.target.value)}
              disabled={!termOptions.length}
              className="w-full pl-9 pr-3 min-h-[44px] text-sm border border-surface-200 rounded-lg bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {!termOptions.length && <option value="">No Spring or Fall terms</option>}
              {termOptions.map(t => (
                <option key={t.name} value={t.name}>{t.name}{t.archived ? ' (archived)' : ''}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <span id="ba-filter-label" className="block text-xs font-semibold text-surface-700 mb-1.5">Show</span>
          <div role="group" aria-labelledby="ba-filter-label" className="flex rounded-lg border border-surface-200 overflow-hidden">
            {[
              { k: 'all',      label: 'All items' },
              { k: 'required', label: 'Required only' },
            ].map(opt => (
              <button
                key={opt.k}
                type="button"
                aria-pressed={filter === opt.k}
                onClick={() => setFilter(opt.k)}
                className={`flex-1 min-h-[44px] text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${filter === opt.k ? 'bg-indigo-600 text-white' : 'bg-white text-surface-700 hover:bg-surface-50'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="ba-search" className="block text-xs font-semibold text-surface-700 mb-1.5">Find a course or item</label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none" aria-hidden="true" />
            <input
              id="ba-search"
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. RICT 1110 or multimeter"
              className="w-full pl-9 pr-3 min-h-[44px] text-sm border border-surface-200 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>
        </div>
      </div>

      {/* Live region — counts after any term / filter / search change, and copy results */}
      <div aria-live="polite" role="status" className="sr-only">
        {busy ? 'Loading adoption list…'
          : term ? `${term}: ${totals.courses} course${totals.courses !== 1 ? 's' : ''}, ${totals.required} required item${totals.required !== 1 ? 's' : ''}, ${totals.have} already have.${filter === 'required' ? ' Showing required items only.' : ''}` : ''}
        {copyMsg ? ` ${copyMsg}` : ''}
      </div>

      {busy && (
        <div className="flex items-center justify-center gap-2 text-sm text-surface-600 py-12">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading adoption list…
        </div>
      )}

      {!busy && error && (
        <div role="alert" className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
          <AlertCircle size={16} className="text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-rose-800">Could not load the adoption list</p>
            <p className="text-xs text-rose-700 mt-0.5">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-1.5 px-3 min-h-[44px] text-xs font-semibold bg-rose-600 text-white rounded-lg hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            <RefreshCw size={13} aria-hidden="true" /> Retry
          </button>
        </div>
      )}

      {!busy && !error && term && (
        <>
          {/* Source + summary */}
          <div className={`flex items-start gap-3 rounded-xl px-4 py-3 border ${source === 'schedule' ? 'bg-surface-50 border-surface-200' : 'bg-amber-50 border-amber-200'}`}>
            <CalendarRange size={15} className={`${source === 'schedule' ? 'text-surface-600' : 'text-amber-700'} shrink-0 mt-0.5`} aria-hidden="true" />
            <p className={`text-xs ${source === 'schedule' ? 'text-surface-700' : 'text-amber-900'}`}>
              {sourceNote}.
              {source === 'planner' && ' Build the class schedule for this term to get the exact course list.'}
              {' '}Each course uses the syllabus saved for {term}, or the most recent one before it.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Courses',            value: totals.courses },
              { label: 'Required items',     value: totals.required, strong: true },
              { label: 'Already have',       value: totals.have },
              { label: 'Required est. total', value: fmtCurrency(totals.cost) },
            ].map(t => (
              <div key={t.label} className={`rounded-2xl border-2 px-4 py-3 text-center ${t.strong ? 'border-emerald-300 bg-emerald-50' : 'border-surface-200 bg-white'}`}>
                <p className="text-[11px] font-semibold text-surface-600 uppercase tracking-wide">{t.label}</p>
                <p className={`text-xl font-bold ${t.strong ? 'text-emerald-800' : 'text-surface-900'}`}>{t.value}</p>
              </div>
            ))}
          </div>

          {/* Warnings */}
          {totals.unlinked > 0 && (
            <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
              <Link2Off size={15} className="text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-rose-800">
                <strong>{totals.unlinked} item{totals.unlinked !== 1 ? 's are' : ' is'} not linked to the tools catalog</strong> (marked “not in catalog”).
                They have no price and can't be matched across courses, so they always show as Required. Link them in Required Tools &amp; Materials.
              </p>
            </div>
          )}
          {totals.noSyllabus.length > 0 && (
            <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              <FileText size={15} className="text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-blue-900">
                <strong>{totals.noSyllabus.length} course{totals.noSyllabus.length !== 1 ? 's have' : ' has'} no saved syllabus</strong> — items come from the course catalog's suggested list, which may be out of date: {totals.noSyllabus.join(', ')}
              </p>
            </div>
          )}

          {/* Jump-to-course */}
          {visible.length > 1 && (
            <nav aria-label="Jump to course" className="flex flex-wrap gap-2">
              {visible.map(c => (
                <a
                  key={c.course_id}
                  href={`#ba-course-${normId(c.course_id)}`}
                  className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg border border-surface-200 bg-white text-xs font-semibold text-surface-800 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {c.course_id}
                  <span className="text-[10px] font-medium text-emerald-800">{c.requiredCount} req</span>
                </a>
              ))}
            </nav>
          )}

          {/* Courses */}
          {visible.length === 0 ? (
            <div className="bg-surface-50 border border-surface-200 rounded-2xl p-10 text-center">
              <ShoppingBag size={36} className="text-surface-400 mx-auto mb-3" aria-hidden="true" />
              <p className="text-surface-700 font-medium">
                {query ? 'No courses or items match your search.' : `No RICT courses found for ${term}.`}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {visible.map(c => <CourseCard key={c.course_id} course={c} filter={filter} onCopy={handleCopy} />)}
            </div>
          )}

          <p className="text-[11px] text-surface-600">
            <strong>Required</strong> = the first course in the program that needs the item. <strong>Already Have</strong> = purchased for an earlier course.
            When a course is in more than one program and only some students already own an item, it's marked Required with a note. Prices are catalog estimates.
          </p>
        </>
      )}
    </div>
  )
}
