import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import { parseTermName } from '@/lib/academicTerms'
import {
  DollarSign, Printer, ChevronDown, ChevronRight, ChevronLeft,
  GraduationCap, AlertCircle, Settings, Check, Wifi, Building2,
  Search, Download, ArrowUpDown, X, Link2Off,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ─── Constants ────────────────────────────────────────────────────────────────
const PROGRAMS = [
  { id: 'IPC-AAS',   name: 'Instrumentation & Process Control AAS',  keywords: ['instrumentation','process control','ipc'] },
  { id: 'MECH-AAS',  name: 'Mechatronics AAS',                        keywords: ['mechatronics'] },
  { id: 'MECH-CERT', name: 'Mechatronics Certificate',                keywords: ['mechatronics','certificate'] },
]

const CATEGORY_CONFIG = {
  Tuition:   { color: 'bg-blue-100 text-blue-700 border-blue-200',      icon: '🎓', order: 1 },
  Tool:      { color: 'bg-amber-100 text-amber-700 border-amber-200',   icon: '🔧', order: 2 },
  Software:  { color: 'bg-purple-100 text-purple-700 border-purple-200',icon: '💻', order: 3 },
  Material:  { color: 'bg-teal-100 text-teal-700 border-teal-200',      icon: '📦', order: 4 },
  Supply:    { color: 'bg-rose-100 text-rose-700 border-rose-200',      icon: '🗂️', order: 5 },
  Textbook:  { color: 'bg-orange-100 text-orange-700 border-orange-200',icon: '📚', order: 6 },
  Other:     { color: 'bg-surface-100 text-surface-700 border-surface-200', icon: '📎', order: 7 },
}

// Kept at module scope so the initial load and the realtime refetches below can
// never drift apart on which columns they select.
const TOOL_COLS     = 'tool_id,item_name,part_number,cost,item_type,status'
const TEMPLATE_COLS = 'course_id,course_type,required_materials,required_material_ids,semester,status,updated_at'

const DEFAULT_TUITION_RATES = {
  resident_per_credit:    0,
  online_per_credit:      0,
  fee_student_life:       0,
  fee_technology:         0,
  fee_health:             0,
  fee_parking:            0,
  fee_student_assoc:      0,
}

const fmtCurrencyShort = (n) =>
  n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'

function totalFeesPerCredit(r) {
  return (r.fee_student_life || 0) + (r.fee_technology || 0) + (r.fee_health || 0)
       + (r.fee_parking || 0) + (r.fee_student_assoc || 0)
}

function calcTuition(credits, isOnline, rates) {
  const cr = parseFloat(credits) || 0
  if (cr === 0) return 0
  const base = isOnline ? (rates.online_per_credit || 0) : (rates.resident_per_credit || 0)
  return cr * (base + totalFeesPerCredit(rates))
}


// ─── Tuition Settings Modal ───────────────────────────────────────────────────
function TuitionSettingsModal({ rates, onSave, onClose }) {
  const dialogRef = useDialogA11y(true, onClose)
  const [local, setLocal] = useState({ ...DEFAULT_TUITION_RATES, ...rates })
  const set = (key, val) => setLocal(p => ({ ...p, [key]: parseFloat(val) || 0 }))

  const feeTotal = totalFeesPerCredit(local)
  const resTotal = (local.resident_per_credit || 0) + feeTotal
  const onlineTotal = (local.online_per_credit || 0) + feeTotal

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Tuition and fee rates" className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-surface-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-bold text-surface-900">Tuition &amp; Fee Rates</h2>
            <p className="text-xs text-surface-400 mt-0.5">Per-credit rates — apply across all programs</p>
          </div>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600 text-xl leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">x</button>
        </div>
        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          <div>
            <p className="text-xs font-bold text-surface-600 uppercase tracking-wide mb-3">Base Tuition (per credit)</p>
            <div className="space-y-2.5">
              {[
                { key: 'resident_per_credit', label: 'Resident / Non-resident', icon: 'building' },
                { key: 'online_per_credit',   label: 'Online Classes',          icon: 'wifi' },
              ].map(({ key, label, icon }) => (
                <div key={key} className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 flex-1">
                    {icon === 'building'
                      ? <Building2 size={13} className="text-blue-500" aria-hidden="true" />
                      : <Wifi size={13} className="text-violet-500" aria-hidden="true" />}
                    <label htmlFor={`pc-rate-${key}`} className="text-sm text-surface-700">{label}</label>
                  </div>
                  <div className="relative w-28">
                    <span className="absolute left-3 top-2 text-surface-400 text-sm" aria-hidden="true">$</span>
                    <input id={`pc-rate-${key}`} type="number" min={0} step={0.01} value={local[key] ?? ''}
                      onChange={e => set(key, e.target.value)}
                      className="w-full pl-7 pr-3 py-1.5 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/40"/>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t border-surface-100"/>
          <div>
            <p className="text-xs font-bold text-surface-600 uppercase tracking-wide mb-1">Per-Credit Fees</p>
            <p className="text-[11px] text-surface-400 mb-3">Added on top of base tuition — same for all delivery modes</p>
            <div className="space-y-2.5">
              {[
                { key: 'fee_student_life',  label: 'Student Life / Activity Fee' },
                { key: 'fee_technology',    label: 'Technology Fee' },
                { key: 'fee_health',        label: 'Health Services Fee' },
                { key: 'fee_parking',       label: 'Parking Access Fee' },
                { key: 'fee_student_assoc', label: 'Student Association Fee' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center gap-3">
                  <label htmlFor={`pc-fee-${key}`} className="text-sm text-surface-700 flex-1">{label}</label>
                  <div className="relative w-28">
                    <span className="absolute left-3 top-2 text-surface-400 text-sm" aria-hidden="true">$</span>
                    <input id={`pc-fee-${key}`} type="number" min={0} step={0.01} value={local[key] ?? ''}
                      onChange={e => set(key, e.target.value)}
                      className="w-full pl-7 pr-3 py-1.5 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/40"/>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {(resTotal > 0 || onlineTotal > 0) && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-wide mb-2">Effective Cost per Credit</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center">
                  <p className="text-[10px] text-emerald-600 mb-0.5">Resident / Non-res</p>
                  <p className="text-lg font-bold text-emerald-800">{fmtCurrencyShort(resTotal)}</p>
                  <p className="text-[10px] text-emerald-500">tuition + all fees</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-emerald-600 mb-0.5">Online</p>
                  <p className="text-lg font-bold text-emerald-800">{fmtCurrencyShort(onlineTotal)}</p>
                  <p className="text-[10px] text-emerald-500">tuition + all fees</p>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2 shrink-0 border-t border-surface-100 pt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">Cancel</button>
          <button onClick={() => { onSave(local); onClose() }}
            className="px-5 py-2 text-sm font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            Save Rates
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Material string helpers ──────────────────────────────────────────────────
// required_materials stores display strings like
//   "RICT TEST LEAD SET SILICONE (Part #: 2810050012254)"
// These mirror the normalizers in SyllabusWizard and in the SQL migration.
const cleanMaterialName = (s) =>
  String(s || '').replace(/\s*\(Part\s*#:.*\)\s*$/i, '').trim()
const materialKey = (s) => cleanMaterialName(s).toLowerCase()
const materialPartNumber = (s) =>
  (String(s || '').match(/\(Part\s*#:\s*([^)]+)\)/i)?.[1] || '').trim()

/**
 * One syllabus template per course: newest non-archived semester wins.
 *
 * The previous version selected every template row and assigned
 * templateMap[course_id] in a forEach, so whichever row Postgres happened to
 * return LAST silently drove the cost sheet — an archived or prior-year
 * syllabus could override the current one. Templates are keyed
 * (course_id, semester), so the tie-break is semester recency, then updated_at.
 */
export function pickActiveTemplates(rows) {
  const byCourse = {}
  ;(rows || []).forEach(t => {
    if (!t.course_id) return
    if (String(t.status || '').toLowerCase() === 'archived') return
    if (!byCourse[t.course_id]) byCourse[t.course_id] = []
    byCourse[t.course_id].push(t)
  })
  const picked = {}
  Object.keys(byCourse).forEach(cid => {
    picked[cid] = byCourse[cid].sort((a, b) => {
      const ao = a.semester ? (parseTermName(a.semester).order || 0) : 0
      const bo = b.semester ? (parseTermName(b.semester).order || 0) : 0
      if (bo !== ao) return bo - ao
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    })[0]
  })
  return picked
}

// ─── Cost engine ──────────────────────────────────────────────────────────────
// Exported for testing — pure function, no React or Supabase dependency.
export function buildCostBreakdown(planner, courses, toolCatalog, tuitionRates, syllabusTemplates, externalCosts, deliveryModes) {
  const activeTemplate = pickActiveTemplates(syllabusTemplates)
  // courseTypeMap: course_id → 'online' | 'hybrid' | 'traditional'
  // Used as automatic delivery mode when no manual override has been set
  const courseTypeMap = {}
  Object.entries(activeTemplate).forEach(([cid, t]) => {
    if (t.course_type) courseTypeMap[cid] = t.course_type
  })

  // Catalog indexes. Retired rows are kept so a syllabus item pointing at one
  // still shows its price (flagged "retired") instead of silently becoming TBD,
  // but an Active row always wins a name/part-number collision.
  const preferActive = (a, b) => (!a ? b : (a.status !== 'Active' && b.status === 'Active' ? b : a))
  const toolById = {}, toolByName = {}, toolByPart = {}
  ;(toolCatalog || []).forEach(t => {
    if (t.tool_id) toolById[t.tool_id] = t
    const n = (t.item_name || '').trim().toLowerCase()
    const p = (t.part_number || '').trim().toLowerCase()
    if (n) toolByName[n] = preferActive(toolByName[n], t)
    if (p) toolByPart[p] = preferActive(toolByPart[p], t)
  })

  /**
   * Resolve one syllabus entry to a catalog row.
   * tool_id first — that link survives catalog renames, which is the whole
   * point of required_material_ids. Then exact name, then part number, then a
   * substring match ONLY when exactly one candidate matches, so an ambiguous
   * name can never silently bind to the wrong item's price.
   */
  const resolveMaterial = (raw, linkedId) => {
    if (linkedId && toolById[linkedId]) return toolById[linkedId]
    const clean = materialKey(raw)
    if (clean && toolByName[clean]) return toolByName[clean]
    const part = materialPartNumber(raw).toLowerCase()
    if (part && toolByPart[part]) return toolByPart[part]
    if (clean.length > 3) {
      const hits = (toolCatalog || []).filter(t => {
        const tn = (t.item_name || '').trim().toLowerCase()
        return tn.length > 3 && (tn.includes(clean) || clean.includes(tn))
      })
      if (hits.length === 1) return hits[0]
    }
    return null
  }

  // key → the course that first requires it. Items are PRICED once across the
  // program, but every course still lists everything its syllabus requires —
  // repeats are shown with a "counted in <course>" note and add $0 here.
  const seenTools = new Map()

  const semesters = (planner.planner_semesters || []).map(sem => {
    const courseRows = (sem.courses || []).filter(c => c.course_num || c.course_title)
    const courseCosts = courseRows.map(planCourse => {
      const catalogCourse = courses.find(c => c.course_id === planCourse.course_num)
      const lec      = parseFloat(catalogCourse?.credits_lecture || planCourse.credits_lec) || 0
      const lab      = parseFloat(catalogCourse?.credits_lab    || planCourse.credits_lab)  || 0
      const soe      = parseFloat(catalogCourse?.credits_soe    || planCourse.credits_soe)  || 0
      const flatCr   = parseFloat(planCourse.credits) || 0
      const totalCr  = flatCr || lec + lab + soe || 0
      const effLec   = lec || (flatCr > 0 ? flatCr : 0)

      // Delivery mode: manual toggle takes priority; falls back to course_type from Syllabus Wizard;
      // 'online' course_type → online rate; 'hybrid' or 'traditional' → resident rate
      const manualMode   = deliveryModes?.[planCourse.course_num]
      const syllabusType = courseTypeMap[planCourse.course_num]  // 'online' | 'hybrid' | 'traditional'
      const resolvedMode = manualMode ?? (syllabusType === 'online' ? 'online' : 'in-person')
      const isOnline   = resolvedMode === 'online'
      const isExternal = planCourse.course_num ? !planCourse.course_num.toUpperCase().startsWith('RICT') : false
      const tuitionCost = calcTuition(totalCr, isOnline, tuitionRates)

      const toolItems = []
      const tmplRow = planCourse.course_num ? (activeTemplate[planCourse.course_num] || null) : null
      let materialSource = null

      if (isExternal) {
        const amt = parseFloat(externalCosts?.[planCourse.course_num]) || 0
        if (amt > 0) toolItems.push({ name: 'Materials & Supplies', cost: amt, category: 'Material', partNumber: '', firstOccurrence: true, isManual: true, linked: true })
      } else {
        const tmplMats = Array.isArray(tmplRow?.required_materials) ? tmplRow.required_materials : []
        const tmplIds  = Array.isArray(tmplRow?.required_material_ids) ? tmplRow.required_material_ids : []
        const usingTemplate = tmplMats.length > 0
        materialSource = usingTemplate
          ? { kind: 'syllabus', semester: tmplRow?.semester || '' }
          : ((catalogCourse?.suggested_materials || '').trim() ? { kind: 'catalog', semester: '' } : null)

        const matArr = usingTemplate
          ? tmplMats
          : (catalogCourse?.suggested_materials || '').split('\n').map(s => s.trim()).filter(Boolean)

        matArr.forEach((line, i) => {
          const clean = materialKey(line)
          if (!clean) return
          const match = resolveMaterial(line, usingTemplate ? (tmplIds[i] ?? null) : null)
          const key   = match ? (match.tool_id || match.item_name) : `unlinked:${clean}`
          const firstCourse     = seenTools.get(key)
          const firstOccurrence = firstCourse === undefined
          const here            = planCourse.course_num || planCourse.course_title || ''
          // Same item listed twice on one syllabus — show it once
          if (!firstOccurrence && firstCourse === here) return
          if (firstOccurrence) seenTools.set(key, here)
          toolItems.push({
            name:       match ? match.item_name : cleanMaterialName(line),
            cost:       match ? match.cost : null,
            category:   match ? (match.item_type || 'Other') : 'Other',
            partNumber: match ? (match.part_number || '') : materialPartNumber(line),
            linked:     !!match,
            inactive:   !!match && match.status !== 'Active',
            firstOccurrence,
            countedIn:  firstOccurrence ? null : firstCourse,
          })
        })
      }

      // toolTotal charges each item ONCE across the program (first course to
      // require it). toolListTotal is the full retail value of everything this
      // course's syllabus requires, shown so the two numbers are never confused.
      const toolTotal     = toolItems.reduce((s, t) => s + (t.firstOccurrence ? (t.cost || 0) : 0), 0)
      const toolListTotal = toolItems.reduce((s, t) => s + (t.cost || 0), 0)
      const sharedCount   = toolItems.filter(t => !t.firstOccurrence).length
      const unlinkedCount = toolItems.filter(t => !t.linked).length
      return {
        course_num: planCourse.course_num,
        course_title: planCourse.course_title || catalogCourse?.course_name || '',
        credits: totalCr, lec: effLec, lab, soe,
        isOnline, isExternal, syllabusType, tuitionCost, toolItems, toolTotal,
        toolListTotal, sharedCount, unlinkedCount, materialSource,
        courseTotal: tuitionCost + toolTotal,
      }
    })
    const semTuition = courseCosts.reduce((s,c) => s+c.tuitionCost, 0)
    const semTools   = courseCosts.reduce((s,c) => s+c.toolTotal, 0)
    return { label: sem.label, courses: courseCosts, semTuition, semTools, semTotal: semTuition+semTools }
  })

  const grandTuition = semesters.reduce((s,sem) => s+sem.semTuition, 0)
  const grandTools   = semesters.reduce((s,sem) => s+sem.semTools, 0)
  const grandTotal   = grandTuition + grandTools
  // categoryTotals also carries the full item list behind each total so the
  // "Breakdown by Category" tiles can open a drill-down of every item.
  // Items are recorded at their FIRST occurrence only (shared RICT items are
  // counted once), so course/semester = where the item first enters the program.
  const categoryTotals = {}
  semesters.forEach(sem => sem.courses.forEach(c => c.toolItems.forEach(t => {
    // Repeats are listed on their course for clarity but must not be counted
    // a second time here, or the category tiles would double the grand total.
    if (!t.firstOccurrence) return
    if (!categoryTotals[t.category]) categoryTotals[t.category] = { count:0, total:0, items:[] }
    categoryTotals[t.category].count++
    categoryTotals[t.category].total += t.cost || 0
    categoryTotals[t.category].items.push({
      name: t.name,
      cost: t.cost ?? null,
      partNumber: t.partNumber || '',
      category: t.category,
      isManual: !!t.isManual,
      course_num: c.course_num || '',
      course_title: c.course_title || '',
      semester: sem.label || '',
    })
  })))

  // Syllabus items with no catalog match. These carry no price, so they are
  // absent from every total — previously that happened silently. They are
  // surfaced in a banner so the gap gets fixed instead of quietly understating
  // the program cost.
  const unlinkedMap = {}
  semesters.forEach(sem => sem.courses.forEach(c => c.toolItems.forEach(t => {
    if (t.linked) return
    const k = t.name.toLowerCase()
    if (!unlinkedMap[k]) unlinkedMap[k] = { name: t.name, partNumber: t.partNumber || '', courses: [] }
    const label = c.course_num || c.course_title || ''
    if (label && !unlinkedMap[k].courses.includes(label)) unlinkedMap[k].courses.push(label)
  })))
  const unlinked = Object.values(unlinkedMap).sort((a, b) => a.name.localeCompare(b.name))

  // Courses whose materials still come from the catalog's free-text
  // suggested_materials rather than a saved syllabus.
  const coursesWithoutSyllabus = []
  semesters.forEach(sem => sem.courses.forEach(c => {
    if (c.isExternal) return
    if (c.materialSource?.kind === 'syllabus') return
    if (c.credits > 0 || c.toolItems.length > 0) coursesWithoutSyllabus.push(c.course_num || c.course_title || '')
  }))

  return { semesters, grandTuition, grandTools, grandTotal, categoryTotals, unlinked, coursesWithoutSyllabus }
}

// ─── Print ────────────────────────────────────────────────────────────────────
function printCostReport(programName, breakdown, tuitionRates) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const fmt = n => n!=null ? `$${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : 'TBD'
  const feeTotal = totalFeesPerCredit(tuitionRates)

  const semHtml = breakdown.semesters.map(sem => {
    if (!sem.courses.some(c => c.credits>0||c.toolItems.length>0||c.isExternal)) return ''
    const rows = sem.courses.filter(c=>c.credits>0||c.toolItems.length>0||c.isExternal).map(c => {
      const toolRows = c.toolItems.map(t => {
        const note = t.isManual   ? ' <em style="color:#999;font-size:7.5pt">(manual)</em>'
                   : !t.linked    ? ' <em style="color:#b91c1c;font-size:7.5pt">(not in catalog — not counted)</em>'
                   : t.inactive   ? ' <em style="color:#b45309;font-size:7.5pt">(retired)</em>'
                   : ''
        // Repeats are listed so the course shows its full required kit, but
        // they contribute $0 — the price was charged to the first course.
        const shared = !t.firstOccurrence
        const amt = shared
          ? `<span style="color:#999">${t.cost!=null?fmt(t.cost):'TBD'} · $0.00</span>`
          : (t.cost!=null?fmt(t.cost):'TBD')
        const sharedNote = shared
          ? ` <em style="color:#999;font-size:7.5pt">(counted in ${esc(t.countedIn||'an earlier course')})</em>`
          : ''
        return `<tr class="tr"><td></td><td style="padding-left:20px${shared?';color:#888':''}">${esc(t.name)}${note}${sharedNote}</td><td class="cat">${esc(t.category)}</td><td class="amt">${amt}</td></tr>`
      }).join('')
      const noMat = c.isExternal&&c.toolItems.length===0
        ? `<tr class="tr"><td></td><td colspan="2" style="color:#bbb;font-style:italic">No materials cost entered</td><td class="amt">—</td></tr>` : ''
      return `<tr class="cr"><td class="cn">${esc(c.course_num)}</td>
        <td>${esc(c.course_title)}${c.isOnline?' <span class="b online">Online</span>':''}${c.isExternal?' <span class="b ext">External</span>':''}</td>
        <td class="cat">Tuition</td><td class="amt">${c.tuitionCost>0?fmt(c.tuitionCost):'—'}</td></tr>
        ${toolRows}${noMat}
        <tr class="st"><td colspan="3" style="text-align:right">Course Total</td><td class="amt">${fmt(c.courseTotal)}</td></tr>`
    }).join('')
    return `<div class="sem"><div class="sh"><span>${esc(sem.label)}</span>
      <span>Tuition:${fmt(sem.semTuition)} | Materials:${fmt(sem.semTools)} | <b>Semester:${fmt(sem.semTotal)}</b></span></div>
      <table><thead><tr><th scope="col">Course #</th><th scope="col">Description</th><th scope="col">Category</th><th scope="col" class="amt">Cost</th></tr></thead>
      <tbody>${rows}<tr class="st2"><td colspan="3" style="text-align:right;font-weight:bold">Semester Total</td><td class="amt"><b>${fmt(sem.semTotal)}</b></td></tr></tbody></table></div>`
  }).join('')

  const html = `<!DOCTYPE html><html><head><title>Program Cost — ${programName}</title><style>
    *{box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:9.5pt;margin:.6in;color:#111}
    h1{font-size:15pt;color:#065f46;margin:0 0 4px}.sub{font-size:9pt;color:#555;margin-bottom:14px}
    .rates{font-size:7.5pt;color:#555;background:#f0fdf4;border:1px solid #a7f3d0;border-radius:4px;padding:5px 8px;margin-bottom:14px}
    .sem{margin-bottom:16px;break-inside:avoid;page-break-inside:avoid}
    .sem + .sem{page-break-before:always;margin-top:0}.sh{display:flex;justify-content:space-between;align-items:center;background:#065f46;color:white;padding:5px 8px;border-radius:3px 3px 0 0;font-size:9pt;font-weight:bold}
    table{width:100%;border-collapse:collapse;font-size:8.5pt}th{background:#d1fae5;padding:3px 6px;text-align:left;border:1px solid #6ee7b7}
    td{padding:3px 6px;border:1px solid #ddd}.amt{text-align:right;width:80px}.cn{width:80px;font-weight:bold}
    .cr{background:#f8fafc}.cr td{font-weight:500}.tr td{background:white;font-size:8pt;color:#444}
    .cat{width:80px;font-size:8pt;color:#666}.st td{background:#f0fdf4;font-size:8pt}.st2 td{background:#d1fae5;font-weight:bold}
    .grand{margin-top:14px;border:2px solid #065f46;border-radius:4px;padding:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
    .gi{text-align:center}.gl{font-size:8pt;color:#555;margin-bottom:2px}.gv{font-size:12pt;font-weight:bold;color:#065f46}
    .b{font-size:7pt;padding:1px 4px;border-radius:3px;font-weight:bold;margin-left:4px}
    .online{background:#ede9fe;color:#6d28d9}.ext{background:#fef3c7;color:#b45309}
    @media print{body{margin:.5in}.sem{break-inside:avoid;page-break-inside:avoid}.sem+.sem{page-break-before:always}}
  </style></head><body>
  <h1>Program Cost Estimate</h1>
  <div class="sub">${esc(programName)} · Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
  <div class="rates">
    <b>Resident/Non-res:</b> ${fmt((tuitionRates.resident_per_credit||0)+feeTotal)}/cr &nbsp;|&nbsp;
    <b>Online:</b> ${fmt((tuitionRates.online_per_credit||0)+feeTotal)}/cr &nbsp;|&nbsp;
    Fees/cr: Student Life ${fmt(tuitionRates.fee_student_life||0)} · Technology ${fmt(tuitionRates.fee_technology||0)} · Health ${fmt(tuitionRates.fee_health||0)} · Parking ${fmt(tuitionRates.fee_parking||0)} · Student Assoc ${fmt(tuitionRates.fee_student_assoc||0)}
  </div>
  ${semHtml}
  <div class="grand">
    <div class="gi"><div class="gl">Total Tuition &amp; Fees</div><div class="gv">${fmt(breakdown.grandTuition)}</div></div>
    <div class="gi"><div class="gl">Total Materials &amp; Tools</div><div class="gv">${fmt(breakdown.grandTools)}</div></div>
    <div class="gi"><div class="gl">PROGRAM GRAND TOTAL</div><div class="gv">${fmt(breakdown.grandTotal)}</div></div>
  </div>
  ${breakdown.unlinked?.length ? `<div style="margin-top:12px;border:1px solid #fecaca;background:#fef2f2;border-radius:4px;padding:8px">
    <b style="font-size:8pt;color:#991b1b">${breakdown.unlinked.length} syllabus item${breakdown.unlinked.length!==1?'s are':' is'} not in the tools catalog and ${breakdown.unlinked.length!==1?'are':'is'} NOT included in these totals:</b>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:7.5pt;color:#b91c1c">
      ${breakdown.unlinked.map(u => `<li>${esc(u.name)}${u.courses.length?` — ${esc(u.courses.join(', '))}`:''}</li>`).join('')}
    </ul></div>` : ''}
  <p style="font-size:7.5pt;color:#888;margin-top:10px">* Estimates only. Tuition/fees subject to change. RICT material costs from catalog. Each course lists every item its syllabus requires; items shared across courses are charged once, to the first course that requires them, and show $0.00 thereafter. External course material costs manually entered.</p>
  </body></html>`
  const w = window.open('','_blank')
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(),300) }
}

// ─── SemesterBlock ────────────────────────────────────────────────────────────
function SemesterBlock({ sem, defaultOpen, externalCosts, deliveryModes, onManualCostSave, onDeliveryModeChange }) {
  const [open, setOpen] = useState(defaultOpen || false)
  return (
    <div className="border border-surface-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o=>!o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-emerald-700 hover:bg-emerald-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} className="text-emerald-200" aria-hidden="true" /> : <ChevronRight size={14} className="text-emerald-200" aria-hidden="true" />}
          <span className="text-sm font-bold text-white">{sem.label}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-emerald-200">
          <span>Tuition: <strong className="text-white">{fmtCurrencyShort(sem.semTuition)}</strong></span>
          <span>Materials: <strong className="text-white">{fmtCurrencyShort(sem.semTools)}</strong></span>
          <span className="bg-emerald-900/50 px-2.5 py-1 rounded-full text-emerald-100 font-bold">Semester: {fmtCurrencyShort(sem.semTotal)}</span>
        </div>
      </button>
      {open && (
        <div className="divide-y divide-surface-100">
          {sem.courses.filter(c=>c.credits>0||c.toolItems.length>0||c.isExternal).map((course,ci)=>(
            <CourseBlock key={ci} course={course}
              manualCost={externalCosts?.[course.course_num]??null}
              deliveryMode={deliveryModes?.[course.course_num]||null}
              onManualCostSave={onManualCostSave}
              onDeliveryModeChange={onDeliveryModeChange}
            />
          ))}
          <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-50">
            <span className="text-xs font-bold text-emerald-800 uppercase tracking-wide">Semester Total</span>
            <span className="text-sm font-bold text-emerald-700">{fmtCurrencyShort(sem.semTotal)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CourseBlock ──────────────────────────────────────────────────────────────
function CourseBlock({ course, manualCost, deliveryMode, onManualCostSave, onDeliveryModeChange }) {
  const [open, setOpen]       = useState(false)
  const [inputVal, setInputVal] = useState(manualCost!=null ? String(manualCost) : '')
  const [saved, setSaved]     = useState(false)
  const saveTimer = useRef(null)

  useEffect(() => {
    if (manualCost!=null && inputVal==='') setInputVal(String(manualCost))
  }, [manualCost]) // eslint-disable-line

  const handleMaterialSave = useCallback(() => {
    const amt = parseFloat(inputVal) || 0
    if (saveTimer.current) clearTimeout(saveTimer.current)
    onManualCostSave(course.course_num, amt)
    setSaved(true)
    saveTimer.current = setTimeout(()=>setSaved(false), 1800)
  }, [inputVal, course.course_num, onManualCostSave])

  // deliveryMode prop = manual override if set, otherwise null (auto from Syllabus Wizard)
  const isManualOverride = deliveryMode != null
  const isOnline = course.isOnline  // resolved value already computed in buildCostBreakdown

  // Label for the toggle source
  const syllabusLabel = course.syllabusType
    ? { hybrid: 'Hybrid', traditional: 'Traditional', online: 'Online' }[course.syllabusType] || null
    : null
  const byCategory = {}
  course.toolItems.forEach(t => {
    const cat = t.category||'Other'
    if (!byCategory[cat]) byCategory[cat]=[]
    byCategory[cat].push(t)
  })
  const sortedCats = Object.entries(byCategory).sort(([a],[b])=>(CATEGORY_CONFIG[a]?.order||99)-(CATEGORY_CONFIG[b]?.order||99))

  return (
    <div className="bg-white">
      {/* Row header */}
      <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-surface-50 transition-colors">
        <button onClick={()=>setOpen(o=>!o)} className="flex items-center gap-2 flex-1 text-left min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
          {open ? <ChevronDown size={12} className="text-surface-400 shrink-0" aria-hidden="true" /> : <ChevronRight size={12} className="text-surface-400 shrink-0" aria-hidden="true" />}
          <span className="text-xs font-bold text-surface-700 w-20 shrink-0">{course.course_num}</span>
          <span className="text-xs text-surface-700 flex-1 truncate">{course.course_title}</span>
        </button>

        {/* Inline delivery toggle */}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <div className="flex items-center rounded-lg border border-surface-200 overflow-hidden text-[10px] font-semibold">
            <button
              onClick={()=>onDeliveryModeChange(course.course_num,'in-person')}
              title="Apply Resident / Non-resident rate"
              className={`flex items-center gap-1 px-2 py-1 transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${!isOnline ? 'bg-blue-600 text-white' : 'bg-white text-surface-500 hover:bg-surface-50'}`}>
              <Building2 size={10} aria-hidden="true" /> In-Person
            </button>
            <button
              onClick={()=>onDeliveryModeChange(course.course_num,'online')}
              title="Apply Online rate"
              className={`flex items-center gap-1 px-2 py-1 transition-colors border-l border-surface-200 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${isOnline ? 'bg-violet-600 text-white' : 'bg-white text-surface-500 hover:bg-surface-50'}`}>
              <Wifi size={10} aria-hidden="true" /> Online
            </button>
            {isManualOverride && (
              <button
                onClick={()=>onDeliveryModeChange(course.course_num,'auto')}
                title="Reset to Syllabus Wizard setting"
                className="flex items-center gap-1 px-2 py-1 bg-white text-surface-400 hover:bg-surface-50 hover:text-surface-600 transition-colors border-l border-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
                ↺
              </button>
            )}
          </div>
          {/* Source indicator */}
          {!isManualOverride && syllabusLabel && (
            <span className="text-[9px] text-emerald-600 font-medium">⚡ Auto: {syllabusLabel}</span>
          )}
          {isManualOverride && (
            <span className="text-[9px] text-amber-600 font-medium">✏ Manual override</span>
          )}
          {!isManualOverride && !syllabusLabel && (
            <span className="text-[9px] text-surface-300 font-medium">default: in-person</span>
          )}
        </div>

        {/* Meta + total */}
        <div className="flex items-center gap-2 shrink-0 ml-1">
          {course.isExternal && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">external</span>}
          {course.toolItems.length>0 && !course.isExternal && (
            <span className="text-[10px] text-surface-400">
              {course.toolItems.length} item{course.toolItems.length!==1?'s':''}
            </span>
          )}
          {course.unlinkedCount>0 && !course.isExternal && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
              {course.unlinkedCount} unpriced
            </span>
          )}
          <span className="text-xs font-semibold text-emerald-700 w-20 text-right">{fmtCurrencyShort(course.courseTotal)}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div className="px-4 pb-3 space-y-2 bg-surface-50/50">
          {/* Tuition */}
          {course.tuitionCost > 0 && (
            <div className={`flex items-center justify-between py-1.5 px-3 rounded-lg border ${isOnline?'bg-violet-50 border-violet-100':'bg-blue-50 border-blue-100'}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm">{isOnline?'🌐':'🎓'}</span>
                <div>
                  <p className={`text-xs font-medium ${isOnline?'text-violet-800':'text-blue-800'}`}>
                    Tuition &amp; Fees — {isOnline?'Online Rate':'Resident / Non-resident Rate'}
                  </p>
                  <p className={`text-[10px] ${isOnline?'text-violet-500':'text-blue-500'}`}>
                    {course.credits} credit{course.credits!==1?'s':''}
                    {course.lec>0&&course.lab>0?` (${course.lec} Lec · ${course.lab} Lab)`:''}
                  </p>
                </div>
              </div>
              <span className={`text-xs font-semibold ${isOnline?'text-violet-700':'text-blue-700'}`}>{fmtCurrencyShort(course.tuitionCost)}</span>
            </div>
          )}

          {/* External: manual material entry */}
          {course.isExternal && (
            <div className="py-1.5 px-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm">📦</span>
                  <div>
                    <p className="text-xs font-semibold text-amber-800">Materials &amp; Supplies</p>
                    <p className="text-[10px] text-amber-500">External course — enter estimated cost below</p>
                  </div>
                </div>
                {course.toolTotal>0 && <span className="text-xs font-semibold text-amber-700">{fmtCurrencyShort(course.toolTotal)}</span>}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1.5 text-amber-500 text-xs font-medium pointer-events-none">$</span>
                  <input type="number" min="0" step="0.01" placeholder="0.00" aria-label={`Estimated materials cost for ${course.course_num || course.course_title || 'course'}`}
                    value={inputVal}
                    onChange={e=>{setInputVal(e.target.value);setSaved(false)}}
                    onKeyDown={e=>e.key==='Enter'&&handleMaterialSave()}
                    className="w-full pl-6 pr-3 py-1.5 text-xs border border-amber-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 text-right"/>
                </div>
                <button onClick={handleMaterialSave}
                  className={`flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all shrink-0 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${saved?'bg-emerald-100 text-emerald-700 border border-emerald-200':'bg-amber-600 text-white hover:bg-amber-700'}`}>
                  {saved?<><Check size={11} aria-hidden="true" /> Saved</>:'Save'}
                </button>
              </div>
            </div>
          )}

          {/* Where this course's material list came from */}
          {!course.isExternal && course.materialSource && (
            <p className="text-[10px] text-surface-400 pl-1">
              {course.materialSource.kind === 'syllabus'
                ? <>Materials from the <strong className="text-surface-500">{course.materialSource.semester || 'saved'}</strong> syllabus</>
                : <>Materials from the course catalog — no saved syllabus for this course yet</>}
            </p>
          )}

          {/* RICT items by category */}
          {!course.isExternal && sortedCats.map(([cat,items])=>{
            const cfg = CATEGORY_CONFIG[cat]||CATEGORY_CONFIG.Other
            // Only first-occurrence items contribute — repeats are listed for
            // completeness but were already charged to an earlier course
            const catTotal = items.reduce((s,t)=>s+(t.firstOccurrence?(t.cost||0):0),0)
            return (
              <div key={cat}>
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.color}`}>{cfg.icon} {cat}</span>
                  <span className="text-[10px] text-surface-400">{fmtCurrencyShort(catTotal)}</span>
                </div>
                {items.map((item,ii)=>(
                  <div key={ii} className="flex items-start justify-between py-1 pl-6 pr-2 gap-3">
                    <span className={`text-xs flex-1 min-w-0 ${item.firstOccurrence?'text-surface-600':'text-surface-400'}`}>
                      <span className="truncate">{item.name}</span>
                      {!item.firstOccurrence && (
                        <span className="ml-1.5 text-[10px] text-surface-400 italic">
                          already counted in {item.countedIn || 'an earlier course'}
                        </span>
                      )}
                      {item.inactive && (
                        <span className="ml-1.5 text-[10px] font-semibold text-amber-700">retired from catalog</span>
                      )}
                      {!item.linked && (
                        <span className="ml-1.5 text-[10px] font-semibold text-rose-600">not in catalog</span>
                      )}
                    </span>
                    <span className="text-xs shrink-0 ml-3 text-right">
                      {item.cost==null
                        ? <span className="text-surface-400 italic text-[10px]">no price</span>
                        : item.firstOccurrence
                          ? <span className="font-medium text-surface-700">{fmtCurrencyShort(item.cost)}</span>
                          : <span className="text-surface-400">{fmtCurrencyShort(item.cost)} · $0.00 here</span>}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}

          {!course.isExternal&&course.toolItems.length===0&&course.tuitionCost>0&&(
            <p className="text-[11px] text-surface-400 italic pl-3">No materials listed for this course.</p>
          )}

          <div className="pt-1.5 border-t border-surface-200">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-surface-600 uppercase tracking-wide">Course Total</span>
              <span className="text-sm font-bold text-emerald-700">{fmtCurrencyShort(course.courseTotal)}</span>
            </div>
            {!course.isExternal && course.sharedCount > 0 && (
              <p className="text-[10px] text-surface-400 mt-1">
                Full kit value {fmtCurrencyShort(course.toolListTotal)} — {course.sharedCount} item{course.sharedCount!==1?'s':''} already
                charged to an earlier course, so only {fmtCurrencyShort(course.toolTotal)} is added here.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Category drill-down helpers ──────────────────────────────────────────────
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCategoryCsv(category, rows, programName) {
  const header = ['Item', 'Part Number', 'Category', 'First Used In (Course)', 'Course Title', 'Semester', 'Cost']
  const body = rows.map(r => [
    r.name, r.partNumber, r.category, r.course_num, r.course_title, r.semester,
    r.cost != null ? Number(r.cost).toFixed(2) : 'TBD',
  ])
  const totalKnown = rows.reduce((s, r) => s + (r.cost || 0), 0)
  body.push(['', '', '', '', '', 'TOTAL', totalKnown.toFixed(2)])
  const csv = [header, ...body].map(line => line.map(csvCell).join(',')).join('\r\n')
  // BOM so Excel reads UTF-8 item names correctly
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const slug = s => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  a.href = url
  a.download = `program-cost-${slug(programName) || 'program'}-${slug(category) || 'items'}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function printCategoryList(category, rows, programName) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const fmt = n => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'TBD'
  const total = rows.reduce((s, r) => s + (r.cost || 0), 0)
  const tbd = rows.filter(r => r.cost == null).length
  const body = rows.map(r => `<tr>
      <td>${esc(r.name)}${r.isManual ? ' <em style="color:#999;font-size:7.5pt">(manual)</em>' : ''}</td>
      <td class="pn">${esc(r.partNumber) || '—'}</td>
      <td class="cn">${esc(r.course_num) || '—'}</td>
      <td>${esc(r.semester)}</td>
      <td class="amt">${r.cost != null ? fmt(r.cost) : 'TBD'}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html><html><head><title>${esc(category)} Items — ${esc(programName)}</title><style>
    *{box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:9.5pt;margin:.6in;color:#111}
    h1{font-size:15pt;color:#065f46;margin:0 0 4px}.sub{font-size:9pt;color:#555;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:8.5pt}
    th{background:#d1fae5;padding:4px 6px;text-align:left;border:1px solid #6ee7b7}
    td{padding:3px 6px;border:1px solid #ddd;vertical-align:top}
    .amt{text-align:right;width:85px}.pn{width:110px;color:#555}.cn{width:80px;font-weight:bold}
    tr:nth-child(even) td{background:#f8fafc}
    tfoot td{background:#d1fae5;font-weight:bold}
    .note{font-size:7.5pt;color:#888;margin-top:10px}
    @media print{body{margin:.5in}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}}
  </style></head><body>
  <h1>${esc(category)} — Item List</h1>
  <div class="sub">${esc(programName)} · ${rows.length} item${rows.length !== 1 ? 's' : ''} · Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
  <table>
    <thead><tr><th scope="col">Item</th><th scope="col">Part #</th><th scope="col">Course</th><th scope="col">Semester</th><th scope="col" class="amt">Cost</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td colspan="4" style="text-align:right">Total</td><td class="amt">${fmt(total)}</td></tr></tfoot>
  </table>
  <p class="note">* Items shared across courses are counted once — "Course" is where the item first enters the program.${tbd > 0 ? ` ${tbd} item${tbd !== 1 ? 's have' : ' has'} no catalog price (TBD) and ${tbd !== 1 ? 'are' : 'is'} not included in the total.` : ''}</p>
  </body></html>`
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300) }
}

// ─── Category Items Modal ─────────────────────────────────────────────────────
function CategoryItemsModal({ categoryTotals, initialCategory, programName, onClose }) {
  const dialogRef = useDialogA11y(true, onClose)
  const [category, setCategory] = useState(initialCategory)
  const [query, setQuery]       = useState('')
  const [sort, setSort]         = useState({ key: 'name', dir: 'asc' })

  const cats = useMemo(
    () => Object.keys(categoryTotals).sort((a, b) => (CATEGORY_CONFIG[a]?.order || 99) - (CATEGORY_CONFIG[b]?.order || 99)),
    [categoryTotals]
  )
  const cfg = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.Other
  const allItems = categoryTotals[category]?.items || []

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? allItems.filter(i =>
          (i.name || '').toLowerCase().includes(q) ||
          (i.partNumber || '').toLowerCase().includes(q) ||
          (i.course_num || '').toLowerCase().includes(q) ||
          (i.course_title || '').toLowerCase().includes(q) ||
          (i.semester || '').toLowerCase().includes(q))
      : allItems.slice()
    const dir = sort.dir === 'asc' ? 1 : -1
    return filtered.sort((a, b) => {
      if (sort.key === 'cost') {
        // Unpriced (TBD) items always sort to the bottom regardless of direction
        if (a.cost == null && b.cost == null) return 0
        if (a.cost == null) return 1
        if (b.cost == null) return -1
        return (a.cost - b.cost) * dir
      }
      const av = String(a[sort.key] || '')
      const bv = String(b[sort.key] || '')
      return av.localeCompare(bv, 'en', { numeric: true, sensitivity: 'base' }) * dir
    })
  }, [allItems, query, sort])

  const shownTotal = rows.reduce((s, r) => s + (r.cost || 0), 0)
  const tbdCount   = rows.filter(r => r.cost == null).length
  const isFiltered = query.trim().length > 0

  const toggleSort = (key) =>
    setSort(p => p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'cost' ? 'desc' : 'asc' })

  const ariaSort = (key) => sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'

  const SortHeader = ({ label, sortKey, className = '', align = 'left' }) => (
    <th scope="col" aria-sort={ariaSort(sortKey)} className={`px-3 py-2 ${className}`}>
      <button
        onClick={() => toggleSort(sortKey)}
        aria-label={`Sort by ${label}${sort.key === sortKey ? (sort.dir === 'asc' ? ', currently ascending' : ', currently descending') : ''}`}
        className={`flex items-center gap-1 w-full min-h-[44px] text-[11px] font-bold uppercase tracking-wide rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${align === 'right' ? 'justify-end' : ''} ${sort.key === sortKey ? 'text-emerald-700' : 'text-surface-500 hover:text-surface-700'}`}
      >
        {label}
        {sort.key === sortKey
          ? <span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span>
          : <ArrowUpDown size={10} className="opacity-40" aria-hidden="true" />}
      </button>
    </th>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pc-cat-modal-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-100 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 id="pc-cat-modal-title" className="text-base font-bold text-surface-900 flex items-center gap-2">
              <span aria-hidden="true">{cfg.icon}</span> {category} — Item List
            </h2>
            <p className="text-xs text-surface-400 mt-0.5 truncate">
              {programName} · shared items counted once
            </p>
          </div>
          <button onClick={onClose} aria-label="Close item list"
            className="shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-surface-400 hover:text-surface-700 hover:bg-surface-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Category switcher */}
        <div className="px-6 pt-3 shrink-0">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Switch category">
            {cats.map(c => {
              const ccfg = CATEGORY_CONFIG[c] || CATEGORY_CONFIG.Other
              const active = c === category
              const { count, total } = categoryTotals[c]
              return (
                <button key={c} onClick={() => { setCategory(c); setQuery('') }}
                  aria-pressed={active}
                  aria-label={`${c}: ${count} item${count !== 1 ? 's' : ''}, ${fmtCurrencyShort(total)}`}
                  className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] rounded-xl border text-xs font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${active ? `${ccfg.color} ring-2 ring-emerald-400` : 'bg-white border-surface-200 text-surface-500 hover:bg-surface-50'}`}>
                  <span aria-hidden="true">{ccfg.icon}</span>
                  <span>{c}</span>
                  <span className="opacity-70 font-medium">({count})</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Search + actions */}
        <div className="px-6 py-3 flex items-center gap-2 flex-wrap shrink-0">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" aria-hidden="true" />
            <input id="pc-cat-search" type="search" value={query} onChange={e => setQuery(e.target.value)}
              placeholder={`Search ${category.toLowerCase()} items, part #, course…`}
              aria-label={`Search ${category} items by name, part number, course, or semester`}
              className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/40"/>
          </div>
          <button onClick={() => downloadCategoryCsv(category, rows, programName)}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-xs font-semibold border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            <Download size={13} aria-hidden="true" /> CSV
          </button>
          <button onClick={() => printCategoryList(category, rows, programName)}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-xs font-semibold border border-emerald-200 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            <Printer size={13} aria-hidden="true" /> Print
          </button>
        </div>

        {/* Live region — announces filtered result count to screen readers */}
        <p aria-live="polite" className="sr-only">
          {rows.length} {category} item{rows.length !== 1 ? 's' : ''} shown
          {isFiltered ? ` of ${allItems.length}` : ''}, totalling {fmtCurrencyShort(shownTotal)}
        </p>

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6">
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-surface-500 font-medium">
                {isFiltered ? 'No items match your search' : 'No items in this category'}
              </p>
              {isFiltered && (
                <button onClick={() => setQuery('')}
                  className="mt-2 px-3 py-2 min-h-[44px] text-xs font-semibold text-emerald-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 rounded">
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <caption className="sr-only">{category} items for {programName}</caption>
              <thead className="sticky top-0 bg-white z-10">
                <tr className="border-b border-surface-200">
                  <SortHeader label="Item" sortKey="name" />
                  <SortHeader label="Part #" sortKey="partNumber" className="hidden sm:table-cell w-32" />
                  <SortHeader label="Course" sortKey="course_num" className="w-28" />
                  <SortHeader label="Semester" sortKey="semester" className="hidden md:table-cell w-44" />
                  <SortHeader label="Cost" sortKey="cost" className="w-28" align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {rows.map((r, i) => (
                  <tr key={`${r.category}-${r.name}-${i}`} className="hover:bg-surface-50 transition-colors">
                    <td className="px-3 py-2.5 text-xs text-surface-700">
                      {r.name}
                      {r.isManual && <span className="ml-1.5 text-[9px] text-surface-400 italic">(manual)</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-surface-500 hidden sm:table-cell">{r.partNumber || '—'}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-surface-700">{r.course_num || '—'}</td>
                    <td className="px-3 py-2.5 text-[11px] text-surface-500 hidden md:table-cell">{r.semester}</td>
                    <td className="px-3 py-2.5 text-xs font-medium text-surface-800 text-right">
                      {r.cost != null ? fmtCurrencyShort(r.cost) : <span className="text-surface-400 italic text-[10px]">TBD</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer totals */}
        <div className="px-6 py-3.5 border-t border-surface-100 flex items-center justify-between gap-4 shrink-0 bg-surface-50/60 rounded-b-2xl">
          <p className="text-[11px] text-surface-500">
            Showing <strong className="text-surface-700">{rows.length}</strong>
            {isFiltered ? ` of ${allItems.length}` : ''} item{allItems.length !== 1 ? 's' : ''}
            {tbdCount > 0 && <span className="text-surface-400"> · {tbdCount} with no catalog price (TBD, not in total)</span>}
          </p>
          <p className="text-sm font-bold text-emerald-700">
            <span className="text-[10px] font-semibold text-surface-500 uppercase tracking-wide mr-2">
              {isFiltered ? 'Filtered total' : 'Category total'}
            </span>
            {fmtCurrencyShort(shownTotal)}
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ProgramCostPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [selectedProgram, setSelectedProgram]   = useState(null)
  const [tuitionRates, setTuitionRates]         = useState(DEFAULT_TUITION_RATES)
  const [showTuitionModal, setShowTuitionModal] = useState(false)
  const [openCategory, setOpenCategory]         = useState(null)
  const [masterPlanners, setMasterPlanners]     = useState([])
  const [courses, setCourses]                   = useState([])
  const [toolCatalog, setToolCatalog]           = useState([])
  const [syllabusTemplates, setSyllabusTemplates] = useState([])
  const [externalCosts, setExternalCosts]       = useState({})
  const [deliveryModes, setDeliveryModes]       = useState({})
  const [loading, setLoading]                   = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const [plannersRes,coursesRes,toolsRes,templatesRes,ratesRes,extRes,delivRes] = await Promise.all([
        supabase.from('program_revisions').select('revision_id,current_program_name,planner_semesters,planner_name,academic_year,major,approved_at,course_id').eq('status','approved').not('planner_semesters','is',null),
        supabase.from('syllabus_courses').select('course_id,course_name,credits_lecture,credits_lab,credits_soe,suggested_materials'),
        // Retired items are loaded too: a syllabus pointing at one should show
        // its price flagged "retired", not silently fall out of the totals.
        supabase.from('program_tools').select(TOOL_COLS),
        // status/semester/updated_at drive "newest non-archived syllabus wins";
        // required_material_ids is the rename-proof link to program_tools.
        supabase.from('syllabus_templates').select(TEMPLATE_COLS),
        supabase.from('settings').select('setting_value').eq('setting_key','program_cost_tuition_rates').maybeSingle(),
        supabase.from('settings').select('setting_value').eq('setting_key','program_cost_external_costs').maybeSingle(),
        supabase.from('settings').select('setting_value').eq('setting_key','program_cost_delivery_modes').maybeSingle(),
      ])
      setMasterPlanners(plannersRes.data||[])
      setCourses(coursesRes.data||[])
      setToolCatalog(toolsRes.data||[])
      setSyllabusTemplates(templatesRes.data||[])
      if (ratesRes.data?.setting_value)   { try { setTuitionRates({...DEFAULT_TUITION_RATES,...JSON.parse(ratesRes.data.setting_value)}) } catch{} }
      if (extRes.data?.setting_value)     { try { setExternalCosts(JSON.parse(extRes.data.setting_value)) } catch{} }
      if (delivRes.data?.setting_value)   { try { setDeliveryModes(JSON.parse(delivRes.data.setting_value)) } catch{} }
      setLoading(false)
    }
    load()

    // Keep the sheet live in BOTH directions:
    //   • program_tools     — a price edited in Required Tools & Materials
    //   • syllabus_templates — a tool/software added or removed in the Syllabus
    //                          Generator, which previously needed a full reload
    //                          before it showed up here at all
    const refetchTools = async () => {
      const { data } = await supabase.from('program_tools').select(TOOL_COLS)
      if (data) setToolCatalog(data)
    }
    const refetchTemplates = async () => {
      const { data } = await supabase.from('syllabus_templates').select(TEMPLATE_COLS)
      if (data) setSyllabusTemplates(data)
    }

    const chTools = subscribeWithReconnect('program_cost_tools_rt', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_tools' }, refetchTools), { onReconnect: refetchTools })
    const chTemplates = subscribeWithReconnect('program_cost_syllabi_rt', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'syllabus_templates' }, refetchTemplates), { onReconnect: refetchTemplates })

    // A dropped socket can silently miss events; re-pull on reconnect so the
    // page never sits on stale numbers. Each channel passes its own refetch as
    // `onReconnect`, which subscribeWithReconnect calls after a channel rebuild
    // AND on AuthContext's `supabase-reconnected` (tab return) — that replaces
    // the window listener this page used to add itself, which only covered
    // tab return.

    return () => {
      chTools()
      chTemplates()
    }
  }, [])

  const saveTuitionRates = useCallback(async (rates) => {
    setTuitionRates(rates)
    await supabase.from('settings').upsert({ setting_key:'program_cost_tuition_rates', setting_value:JSON.stringify(rates), description:'Tuition and per-credit fee rates for Program Cost calculator', category:'program_cost', updated_at:new Date().toISOString(), updated_by:user?.email||'' },{ onConflict:'setting_key' })
    toast.success('Tuition rates saved!')
  }, [user])

  const saveExternalCost = useCallback(async (courseNum, amount) => {
    if (!courseNum) return
    const updated = { ...externalCosts, [courseNum]: amount }
    if (amount===0) delete updated[courseNum]
    setExternalCosts(updated)
    await supabase.from('settings').upsert({ setting_key:'program_cost_external_costs', setting_value:JSON.stringify(updated), description:'Manually entered material costs for external (non-RICT) courses', category:'program_cost', updated_at:new Date().toISOString(), updated_by:user?.email||'' },{ onConflict:'setting_key' })
  }, [externalCosts, user])

  const saveDeliveryMode = useCallback(async (courseNum, mode) => {
    if (!courseNum) return
    const updated = { ...deliveryModes, [courseNum]: mode }
    // 'auto' or 'in-person' (default) — remove manual override so Syllabus Wizard setting takes over
    if (mode === 'auto' || mode === 'in-person') delete updated[courseNum]
    setDeliveryModes(updated)
    await supabase.from('settings').upsert({ setting_key:'program_cost_delivery_modes', setting_value:JSON.stringify(updated), description:'Per-course delivery mode for Program Cost tuition calculation', category:'program_cost', updated_at:new Date().toISOString(), updated_by:user?.email||'' },{ onConflict:'setting_key' })
  }, [deliveryModes, user])

  const activePlanner = useMemo(() => {
    if (!selectedProgram||!masterPlanners.length) return null
    const prog = PROGRAMS.find(p=>p.id===selectedProgram)
    if (!prog) return null
    return masterPlanners.find(p=>prog.keywords.some(kw=>(p.current_program_name||p.planner_name||'').toLowerCase().includes(kw)))||masterPlanners[0]
  }, [selectedProgram, masterPlanners])

  const breakdown = useMemo(() => {
    if (!activePlanner) return null
    return buildCostBreakdown(activePlanner, courses, toolCatalog, tuitionRates, syllabusTemplates, externalCosts, deliveryModes)
  }, [activePlanner, courses, toolCatalog, tuitionRates, syllabusTemplates, externalCosts, deliveryModes])

  const programName = selectedProgram ? PROGRAMS.find(p=>p.id===selectedProgram)?.name : ''
  const hasTuitionRates = Object.values(tuitionRates).some(v=>v>0)
  const feeTotal = totalFeesPerCredit(tuitionRates)

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/instructor-tools')}
            className="flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600 hover:bg-surface-100 px-2 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            <ChevronLeft size={15} aria-hidden="true" /> Back
          </button>
          <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center">
            <DollarSign size={22} className="text-emerald-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Program Cost</h1>
            <p className="text-sm text-surface-500">Full cost breakdown from start to finish by semester, course, and category.</p>
          </div>
        </div>
        <button onClick={()=>setShowTuitionModal(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
          <Settings size={13} aria-hidden="true" /> Tuition Rates
        </button>
      </div>

      {/* Rate summary pills */}
      {hasTuitionRates && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700">
            <Building2 size={11} aria-hidden="true" />
            <span>Resident/Non-res: <strong>{fmtCurrencyShort((tuitionRates.resident_per_credit||0)+feeTotal)}/cr</strong></span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 border border-violet-200 rounded-full text-xs text-violet-700">
            <Wifi size={11} aria-hidden="true" />
            <span>Online: <strong>{fmtCurrencyShort((tuitionRates.online_per_credit||0)+feeTotal)}/cr</strong></span>
          </div>
          <span className="text-[10px] text-surface-400 italic">incl. all per-credit fees · click "Tuition Rates" to edit</span>
        </div>
      )}

      {/* Tuition warning */}
      {!hasTuitionRates && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertCircle size={15} className="text-amber-500 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-amber-800">Tuition rates not set</p>
            <p className="text-[11px] text-amber-600">Cost totals will show $0.00 for tuition. Click "Tuition Rates" to configure rates and fees.</p>
          </div>
          <button onClick={()=>setShowTuitionModal(true)}
            className="px-3 py-1.5 text-xs font-semibold bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            Set Rates
          </button>
        </div>
      )}

      {/* Program selector */}
      <div className="bg-white border border-surface-200 rounded-2xl p-5">
        <p className="text-sm font-semibold text-surface-700 mb-3">Select Program</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PROGRAMS.map(prog => {
            const planner = masterPlanners.find(p=>prog.keywords.some(kw=>(p.current_program_name||p.planner_name||'').toLowerCase().includes(kw)))
            const hasPlanner = !!planner
            return (
              <button key={prog.id} onClick={()=>{ if(!hasPlanner) return; setOpenCategory(null); setSelectedProgram(prog.id) }} disabled={!hasPlanner}
                className={`relative flex flex-col gap-1.5 px-4 py-3.5 rounded-xl border-2 text-left transition-all min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${selectedProgram===prog.id?'bg-emerald-50 border-emerald-400 shadow-sm':hasPlanner?'bg-white border-surface-200 hover:border-emerald-300 hover:bg-emerald-50/30':'bg-surface-50 border-surface-100 opacity-50 cursor-not-allowed'}`}>
                <span className="text-sm font-semibold text-surface-900 leading-tight">{prog.name}</span>
                {hasPlanner?<span className="text-[10px] text-emerald-600 font-medium">✓ Approved planner available</span>:<span className="text-[10px] text-surface-400 italic">No approved planner yet</span>}
                {selectedProgram===prog.id&&<span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-emerald-500"/>}
              </button>
            )
          })}
        </div>
      </div>

      {loading && <div className="text-sm text-surface-400 text-center py-12">Loading program data…</div>}
      {!loading&&!selectedProgram&&(
        <div className="bg-surface-50 border border-surface-200 rounded-2xl p-12 text-center">
          <GraduationCap size={40} className="text-surface-300 mx-auto mb-3" aria-hidden="true" />
          <p className="text-surface-600 font-medium">Select a program above to view the cost breakdown</p>
        </div>
      )}
      {!loading&&selectedProgram&&!activePlanner&&(
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-8 text-center">
          <AlertCircle size={32} className="text-amber-400 mx-auto mb-3" aria-hidden="true" />
          <p className="text-amber-700 font-medium">No approved program revision found for this program</p>
          <p className="text-sm text-amber-600 mt-1">Approve a Program Revision with planner data to generate cost estimates.</p>
        </div>
      )}

      {!loading&&breakdown&&(
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label:'Total Tuition & Fees',    value:breakdown.grandTuition, icon:'🎓', color:'border-blue-200 bg-blue-50' },
              { label:'Total Materials & Tools',  value:breakdown.grandTools,   icon:'🔧', color:'border-amber-200 bg-amber-50' },
              { label:'Program Grand Total',       value:breakdown.grandTotal,   icon:'💰', color:'border-emerald-300 bg-emerald-50', bold:true },
            ].map((card,i)=>(
              <div key={i} className={`rounded-2xl border-2 ${card.color} px-5 py-4 text-center`}>
                <div className="text-2xl mb-1">{card.icon}</div>
                <p className="text-[11px] font-semibold text-surface-500 uppercase tracking-wide mb-1">{card.label}</p>
                <p className={`text-2xl font-bold ${card.bold?'text-emerald-700':'text-surface-800'}`}>{fmtCurrencyShort(card.value)}</p>
              </div>
            ))}
          </div>

          {/* Category summary */}
          {Object.keys(breakdown.categoryTotals).length>0&&(
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
                <p className="text-xs font-bold text-surface-600 uppercase tracking-wide">Breakdown by Category</p>
                <p className="text-[10px] text-surface-400 italic">Click a category to see every item in it</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(breakdown.categoryTotals).sort(([a],[b])=>(CATEGORY_CONFIG[a]?.order||99)-(CATEGORY_CONFIG[b]?.order||99)).map(([cat,{count,total}])=>{
                  const cfg=CATEGORY_CONFIG[cat]||CATEGORY_CONFIG.Other
                  return (
                    <button key={cat} onClick={()=>setOpenCategory(cat)}
                      aria-label={`View all ${count} ${cat} item${count!==1?'s':''}, totalling ${fmtCurrencyShort(total)}`}
                      className={`flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-xl border text-left transition-all hover:shadow-sm hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${cfg.color}`}>
                      <span className="text-base" aria-hidden="true">{cfg.icon}</span>
                      <div>
                        <p className="text-xs font-bold leading-tight">{cat}</p>
                        <p className="text-[10px] opacity-75">{count} item{count!==1?'s':''} · {fmtCurrencyShort(total)}</p>
                      </div>
                      <ChevronRight size={13} className="opacity-50 shrink-0" aria-hidden="true" />
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Print + title */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-surface-900">{programName}</h2>
              <p className="text-xs text-surface-400">
                {activePlanner?.current_program_name||activePlanner?.planner_name}
                {activePlanner?.academic_year?` · ${activePlanner.academic_year}`:''}
                &nbsp;·&nbsp; RICT items shared across courses counted once
              </p>
            </div>
            <button onClick={()=>printCostReport(programName,breakdown,tuitionRates)}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold border border-emerald-200 bg-emerald-50 text-emerald-700 rounded-xl hover:bg-emerald-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
              <Printer size={14} aria-hidden="true" /> Print Cost Report
            </button>
          </div>

          {/* Help banners */}
          {breakdown.semesters.some(s=>s.courses.some(c=>c.isExternal))&&(
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <span className="text-base shrink-0 mt-0.5">📦</span>
              <p className="text-xs text-amber-700"><strong>External courses</strong> (MATH, ENGL, PHYS, TECH, CRTK, RNEW, WELD, etc.) are not in the RICT catalog. Expand each one to enter an estimated materials &amp; supplies cost.</p>
            </div>
          )}
          {/* Unlinked syllabus items — these carry no price and are missing
              from every total, so they are named rather than hidden. */}
          <div aria-live="polite" className="sr-only">
            {breakdown.unlinked.length === 0
              ? 'All syllabus materials are linked to the tools catalog.'
              : `${breakdown.unlinked.length} syllabus material${breakdown.unlinked.length !== 1 ? 's are' : ' is'} not linked to the tools catalog and ${breakdown.unlinked.length !== 1 ? 'are' : 'is'} excluded from the totals.`}
          </div>
          {breakdown.unlinked.length > 0 && (
            <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
              <Link2Off size={15} className="text-rose-500 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-rose-800">
                  {breakdown.unlinked.length} syllabus item{breakdown.unlinked.length !== 1 ? 's are' : ' is'} not in the tools catalog — not included in any total
                </p>
                <p className="text-[11px] text-rose-600 mt-0.5">
                  The program cost below is understated by whatever {breakdown.unlinked.length !== 1 ? 'these items' : 'this item'} cost.
                  Add {breakdown.unlinked.length !== 1 ? 'them' : 'it'} in Required Tools &amp; Materials, then re-pick {breakdown.unlinked.length !== 1 ? 'them' : 'it'} on the syllabus so the price flows through.
                </p>
                <ul className="mt-2 space-y-0.5">
                  {breakdown.unlinked.map((u, i) => (
                    <li key={i} className="text-[11px] text-rose-700">
                      <strong>{u.name}</strong>
                      {u.partNumber && <span className="ml-1.5 font-mono text-[10px] text-rose-500">ISBN: {u.partNumber}</span>}
                      {u.courses.length > 0 && <span className="text-rose-500"> — {u.courses.join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <button onClick={() => navigate('/instructor-tools')}
                className="shrink-0 px-3 py-2 min-h-[44px] text-xs font-semibold bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
                Open Tools
              </button>
            </div>
          )}

          {breakdown.coursesWithoutSyllabus.length > 0 && (
            <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              <span className="text-base shrink-0 mt-0.5" aria-hidden="true">📄</span>
              <p className="text-xs text-blue-700">
                <strong>{breakdown.coursesWithoutSyllabus.length} course{breakdown.coursesWithoutSyllabus.length !== 1 ? 's have' : ' has'} no saved syllabus</strong> —
                materials fall back to the course catalog's suggested list, which may be out of date:{' '}
                <span className="font-semibold">{breakdown.coursesWithoutSyllabus.join(', ')}</span>
              </p>
            </div>
          )}

          <div className="flex items-start gap-3 bg-surface-50 border border-surface-200 rounded-xl px-4 py-3">
            <span className="text-base shrink-0 mt-0.5">🔀</span>
            <p className="text-xs text-surface-500">Use the <strong className="text-blue-700">In-Person</strong> / <strong className="text-violet-700">Online</strong> toggle on each course to apply the correct tuition rate. Selections are saved automatically. Items required by more than one course are listed on every course that needs them but charged only once.</p>
          </div>

          {/* Semesters */}
          <div className="space-y-3">
            {breakdown.semesters.filter(s=>s.courses.some(c=>c.credits>0||c.toolItems.length>0||c.isExternal)).map((sem,i)=>(
              <SemesterBlock key={i} sem={sem} defaultOpen={i===0}
                externalCosts={externalCosts} deliveryModes={deliveryModes}
                onManualCostSave={saveExternalCost} onDeliveryModeChange={saveDeliveryMode}/>
            ))}
          </div>

          {/* Grand total */}
          <div className="bg-emerald-700 rounded-2xl px-6 py-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-emerald-200 uppercase tracking-wide">Program Grand Total</p>
              <p className="text-[11px] text-emerald-300 mt-0.5">All semesters · All courses · All materials (no duplicates)</p>
            </div>
            <p className="text-3xl font-bold text-white">{fmtCurrencyShort(breakdown.grandTotal)}</p>
          </div>
        </>
      )}

      {showTuitionModal&&(
        <TuitionSettingsModal rates={tuitionRates} onSave={saveTuitionRates} onClose={()=>setShowTuitionModal(false)}/>
      )}

      {openCategory&&breakdown?.categoryTotals?.[openCategory]&&(
        <CategoryItemsModal
          categoryTotals={breakdown.categoryTotals}
          initialCategory={openCategory}
          programName={programName}
          onClose={()=>setOpenCategory(null)}
        />
      )}
    </div>
  )
}
