import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  DollarSign, Printer, ChevronDown, ChevronRight, ChevronLeft,
  GraduationCap, AlertCircle, Settings, Check, Wifi, Building2,
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
  const [local, setLocal] = useState({ ...DEFAULT_TUITION_RATES, ...rates })
  const set = (key, val) => setLocal(p => ({ ...p, [key]: parseFloat(val) || 0 }))

  const feeTotal = totalFeesPerCredit(local)
  const resTotal = (local.resident_per_credit || 0) + feeTotal
  const onlineTotal = (local.online_per_credit || 0) + feeTotal

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-surface-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-bold text-surface-900">Tuition &amp; Fee Rates</h2>
            <p className="text-xs text-surface-400 mt-0.5">Per-credit rates — apply across all programs</p>
          </div>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600 text-xl leading-none">x</button>
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
                      ? <Building2 size={13} className="text-blue-500"/>
                      : <Wifi size={13} className="text-violet-500"/>}
                    <label className="text-sm text-surface-700">{label}</label>
                  </div>
                  <div className="relative w-28">
                    <span className="absolute left-3 top-2 text-surface-400 text-sm">$</span>
                    <input type="number" min={0} step={0.01} value={local[key] ?? ''}
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
                  <label className="text-sm text-surface-700 flex-1">{label}</label>
                  <div className="relative w-28">
                    <span className="absolute left-3 top-2 text-surface-400 text-sm">$</span>
                    <input type="number" min={0} step={0.01} value={local[key] ?? ''}
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
          <button onClick={onClose} className="px-4 py-2 text-sm border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50">Cancel</button>
          <button onClick={() => { onSave(local); onClose() }}
            className="px-5 py-2 text-sm font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700">
            Save Rates
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Cost engine ──────────────────────────────────────────────────────────────
function buildCostBreakdown(planner, courses, toolCatalog, tuitionRates, syllabusTemplates, externalCosts, deliveryModes) {
  const templateMap = {}
  // courseTypeMap: course_id → 'online' | 'hybrid' | 'traditional'
  // Used as automatic delivery mode when no manual override has been set
  const courseTypeMap = {}
  ;(syllabusTemplates || []).forEach(t => {
    if (t.course_id) {
      templateMap[t.course_id]   = Array.isArray(t.required_materials) ? t.required_materials : []
      if (t.course_type) courseTypeMap[t.course_id] = t.course_type
    }
  })
  const toolByName = {}
  ;(toolCatalog || []).forEach(t => {
    if (t.item_name) toolByName[t.item_name.trim().toLowerCase()] = t
  })
  const seenTools = new Set()

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
      if (isExternal) {
        const amt = parseFloat(externalCosts?.[planCourse.course_num]) || 0
        if (amt > 0) toolItems.push({ name: 'Materials & Supplies', cost: amt, category: 'Material', firstOccurrence: true, isManual: true })
      } else {
        const tmpl = planCourse.course_num ? (templateMap[planCourse.course_num] || null) : null
        const matArr = (tmpl && tmpl.length > 0)
          ? tmpl
          : (catalogCourse?.suggested_materials || '').split('\n').map(s => s.trim()).filter(Boolean)
        matArr.forEach(line => {
          const clean = line.replace(/\s*\(Part #:.*?\)$/i, '').trim().toLowerCase()
          if (!clean) return
          let match = toolByName[clean]
          if (!match) match = toolCatalog.find(t => { const tn = (t.item_name||'').trim().toLowerCase(); return tn.length>3&&(clean.includes(tn)||tn.includes(clean)) })
          if (match) {
            const key = match.tool_id || match.item_name
            if (!seenTools.has(key)) { seenTools.add(key); toolItems.push({ name: match.item_name, cost: match.cost, category: match.item_type||'Other', firstOccurrence: true }) }
          } else {
            const key = `unknown:${clean}`
            if (!seenTools.has(key)) { seenTools.add(key); toolItems.push({ name: line.replace(/\s*\(Part #:.*?\)$/i,'').trim(), cost: null, category: 'Other', firstOccurrence: true }) }
          }
        })
      }

      const toolTotal = toolItems.reduce((s, t) => s + (t.cost || 0), 0)
      return {
        course_num: planCourse.course_num,
        course_title: planCourse.course_title || catalogCourse?.course_name || '',
        credits: totalCr, lec: effLec, lab, soe,
        isOnline, isExternal, syllabusType, tuitionCost, toolItems, toolTotal,
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
  const categoryTotals = {}
  semesters.forEach(sem => sem.courses.forEach(c => c.toolItems.forEach(t => {
    if (!categoryTotals[t.category]) categoryTotals[t.category] = { count:0, total:0 }
    categoryTotals[t.category].count++
    categoryTotals[t.category].total += t.cost || 0
  })))
  return { semesters, grandTuition, grandTools, grandTotal, categoryTotals }
}

// ─── Print ────────────────────────────────────────────────────────────────────
function printCostReport(programName, breakdown, tuitionRates) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const fmt = n => n!=null ? `$${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : 'TBD'
  const feeTotal = totalFeesPerCredit(tuitionRates)

  const semHtml = breakdown.semesters.map(sem => {
    if (!sem.courses.some(c => c.credits>0||c.toolItems.length>0||c.isExternal)) return ''
    const rows = sem.courses.filter(c=>c.credits>0||c.toolItems.length>0||c.isExternal).map(c => {
      const toolRows = c.toolItems.map(t =>
        `<tr class="tr"><td></td><td style="padding-left:20px">${esc(t.name)}${t.isManual?' <em style="color:#999;font-size:7.5pt">(manual)</em>':''}</td><td class="cat">${esc(t.category)}</td><td class="amt">${t.cost!=null?fmt(t.cost):'TBD'}</td></tr>`
      ).join('')
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
      <table><thead><tr><th>Course #</th><th>Description</th><th>Category</th><th class="amt">Cost</th></tr></thead>
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
  <p style="font-size:7.5pt;color:#888;margin-top:10px">* Estimates only. Tuition/fees subject to change. RICT material costs from catalog; items shared across courses counted once. External course material costs manually entered.</p>
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
        className="w-full flex items-center justify-between px-4 py-3 bg-emerald-700 hover:bg-emerald-800 transition-colors">
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} className="text-emerald-200"/> : <ChevronRight size={14} className="text-emerald-200"/>}
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
        <button onClick={()=>setOpen(o=>!o)} className="flex items-center gap-2 flex-1 text-left min-w-0">
          {open ? <ChevronDown size={12} className="text-surface-400 shrink-0"/> : <ChevronRight size={12} className="text-surface-400 shrink-0"/>}
          <span className="text-xs font-bold text-surface-700 w-20 shrink-0">{course.course_num}</span>
          <span className="text-xs text-surface-700 flex-1 truncate">{course.course_title}</span>
        </button>

        {/* Inline delivery toggle */}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <div className="flex items-center rounded-lg border border-surface-200 overflow-hidden text-[10px] font-semibold">
            <button
              onClick={()=>onDeliveryModeChange(course.course_num,'in-person')}
              title="Apply Resident / Non-resident rate"
              className={`flex items-center gap-1 px-2 py-1 transition-colors
                ${!isOnline ? 'bg-blue-600 text-white' : 'bg-white text-surface-500 hover:bg-surface-50'}`}>
              <Building2 size={10}/> In-Person
            </button>
            <button
              onClick={()=>onDeliveryModeChange(course.course_num,'online')}
              title="Apply Online rate"
              className={`flex items-center gap-1 px-2 py-1 transition-colors border-l border-surface-200
                ${isOnline ? 'bg-violet-600 text-white' : 'bg-white text-surface-500 hover:bg-surface-50'}`}>
              <Wifi size={10}/> Online
            </button>
            {isManualOverride && (
              <button
                onClick={()=>onDeliveryModeChange(course.course_num,'auto')}
                title="Reset to Syllabus Wizard setting"
                className="flex items-center gap-1 px-2 py-1 bg-white text-surface-400 hover:bg-surface-50 hover:text-surface-600 transition-colors border-l border-surface-200">
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
          {course.toolItems.length>0 && !course.isExternal && <span className="text-[10px] text-surface-400">{course.toolItems.length} item{course.toolItems.length!==1?'s':''}</span>}
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
                  <input type="number" min="0" step="0.01" placeholder="0.00"
                    value={inputVal}
                    onChange={e=>{setInputVal(e.target.value);setSaved(false)}}
                    onKeyDown={e=>e.key==='Enter'&&handleMaterialSave()}
                    className="w-full pl-6 pr-3 py-1.5 text-xs border border-amber-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 text-right"/>
                </div>
                <button onClick={handleMaterialSave}
                  className={`flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all shrink-0
                    ${saved?'bg-emerald-100 text-emerald-700 border border-emerald-200':'bg-amber-600 text-white hover:bg-amber-700'}`}>
                  {saved?<><Check size={11}/> Saved</>:'Save'}
                </button>
              </div>
            </div>
          )}

          {/* RICT items by category */}
          {!course.isExternal && sortedCats.map(([cat,items])=>{
            const cfg = CATEGORY_CONFIG[cat]||CATEGORY_CONFIG.Other
            const catTotal = items.reduce((s,t)=>s+(t.cost||0),0)
            return (
              <div key={cat}>
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.color}`}>{cfg.icon} {cat}</span>
                  <span className="text-[10px] text-surface-400">{fmtCurrencyShort(catTotal)}</span>
                </div>
                {items.map((item,ii)=>(
                  <div key={ii} className="flex items-center justify-between py-1 pl-6 pr-2">
                    <span className="text-xs text-surface-600 flex-1 truncate">{item.name}</span>
                    <span className="text-xs font-medium text-surface-700 shrink-0 ml-3">
                      {item.cost!=null?fmtCurrencyShort(item.cost):<span className="text-surface-400 italic text-[10px]">TBD</span>}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}

          {!course.isExternal&&course.toolItems.length===0&&course.tuitionCost>0&&(
            <p className="text-[11px] text-surface-400 italic pl-3">No materials listed for this course.</p>
          )}

          <div className="flex items-center justify-between pt-1.5 border-t border-surface-200">
            <span className="text-[11px] font-bold text-surface-600 uppercase tracking-wide">Course Total</span>
            <span className="text-sm font-bold text-emerald-700">{fmtCurrencyShort(course.courseTotal)}</span>
          </div>
        </div>
      )}
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
        supabase.from('program_tools').select('tool_id,item_name,part_number,cost,item_type').eq('status','Active'),
        supabase.from('syllabus_templates').select('course_id,course_type,required_materials'),
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

    // Keep tool prices live — if someone edits a price in Required Tools catalog
    // while this page is open, reloads just the tools without a full page refresh
    const ch = supabase.channel('program_cost_tools_rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_tools' },
        async () => {
          const { data } = await supabase
            .from('program_tools').select('tool_id,item_name,part_number,cost,item_type').eq('status','Active')
          if (data) setToolCatalog(data)
        }
      ).subscribe()
    return () => ch.unsubscribe()
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
            className="flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600 hover:bg-surface-100 px-2 py-1.5 rounded-lg transition-colors"
          >
            <ChevronLeft size={15} /> Back
          </button>
          <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center">
            <DollarSign size={22} className="text-emerald-600"/>
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Program Cost</h1>
            <p className="text-sm text-surface-500">Full cost breakdown from start to finish by semester, course, and category.</p>
          </div>
        </div>
        <button onClick={()=>setShowTuitionModal(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-surface-200 rounded-lg text-surface-600 hover:bg-surface-50 transition-colors">
          <Settings size={13}/> Tuition Rates
        </button>
      </div>

      {/* Rate summary pills */}
      {hasTuitionRates && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700">
            <Building2 size={11}/>
            <span>Resident/Non-res: <strong>{fmtCurrencyShort((tuitionRates.resident_per_credit||0)+feeTotal)}/cr</strong></span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 border border-violet-200 rounded-full text-xs text-violet-700">
            <Wifi size={11}/>
            <span>Online: <strong>{fmtCurrencyShort((tuitionRates.online_per_credit||0)+feeTotal)}/cr</strong></span>
          </div>
          <span className="text-[10px] text-surface-400 italic">incl. all per-credit fees · click "Tuition Rates" to edit</span>
        </div>
      )}

      {/* Tuition warning */}
      {!hasTuitionRates && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertCircle size={15} className="text-amber-500 shrink-0"/>
          <div className="flex-1">
            <p className="text-xs font-semibold text-amber-800">Tuition rates not set</p>
            <p className="text-[11px] text-amber-600">Cost totals will show $0.00 for tuition. Click "Tuition Rates" to configure rates and fees.</p>
          </div>
          <button onClick={()=>setShowTuitionModal(true)}
            className="px-3 py-1.5 text-xs font-semibold bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors shrink-0">
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
              <button key={prog.id} onClick={()=>hasPlanner&&setSelectedProgram(prog.id)} disabled={!hasPlanner}
                className={`relative flex flex-col gap-1.5 px-4 py-3.5 rounded-xl border-2 text-left transition-all
                  ${selectedProgram===prog.id?'bg-emerald-50 border-emerald-400 shadow-sm':hasPlanner?'bg-white border-surface-200 hover:border-emerald-300 hover:bg-emerald-50/30':'bg-surface-50 border-surface-100 opacity-50 cursor-not-allowed'}`}>
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
          <GraduationCap size={40} className="text-surface-300 mx-auto mb-3"/>
          <p className="text-surface-600 font-medium">Select a program above to view the cost breakdown</p>
        </div>
      )}
      {!loading&&selectedProgram&&!activePlanner&&(
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-8 text-center">
          <AlertCircle size={32} className="text-amber-400 mx-auto mb-3"/>
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
              <p className="text-xs font-bold text-surface-600 uppercase tracking-wide mb-3">Breakdown by Category</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(breakdown.categoryTotals).sort(([a],[b])=>(CATEGORY_CONFIG[a]?.order||99)-(CATEGORY_CONFIG[b]?.order||99)).map(([cat,{count,total}])=>{
                  const cfg=CATEGORY_CONFIG[cat]||CATEGORY_CONFIG.Other
                  return (
                    <div key={cat} className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${cfg.color}`}>
                      <span className="text-base">{cfg.icon}</span>
                      <div>
                        <p className="text-xs font-bold leading-tight">{cat}</p>
                        <p className="text-[10px] opacity-75">{count} item{count!==1?'s':''} · {fmtCurrencyShort(total)}</p>
                      </div>
                    </div>
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
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold border border-emerald-200 bg-emerald-50 text-emerald-700 rounded-xl hover:bg-emerald-100 transition-colors">
              <Printer size={14}/> Print Cost Report
            </button>
          </div>

          {/* Help banners */}
          {breakdown.semesters.some(s=>s.courses.some(c=>c.isExternal))&&(
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <span className="text-base shrink-0 mt-0.5">📦</span>
              <p className="text-xs text-amber-700"><strong>External courses</strong> (MATH, ENGL, PHYS, TECH, CRTK, RNEW, WELD, etc.) are not in the RICT catalog. Expand each one to enter an estimated materials &amp; supplies cost.</p>
            </div>
          )}
          <div className="flex items-start gap-3 bg-surface-50 border border-surface-200 rounded-xl px-4 py-3">
            <span className="text-base shrink-0 mt-0.5">🔀</span>
            <p className="text-xs text-surface-500">Use the <strong className="text-blue-700">In-Person</strong> / <strong className="text-violet-700">Online</strong> toggle on each course to apply the correct tuition rate. Selections are saved automatically.</p>
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
    </div>
  )
}
