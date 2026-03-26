import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, ShadingType, BorderStyle,
  UnderlineType, PageBreak, Header, ImageRun, LevelFormat,
} from 'docx'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  X, ChevronRight, ChevronLeft, Plus, Trash2, Save, Download,
  BookOpen, Check, AlertCircle, CheckCircle2, FileEdit, Loader2,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { PROGRAMS } from './ProgramRevisionWizard'
import { DEFAULT_COLLEGE_OUTCOMES } from './CourseProposalWizard'
import { buildCourseOutline } from './courseOutlineDocx'

// ─── Hook: load college outcomes from Supabase (falls back to defaults) ───────
function useCollegeOutcomes() {
  const [outcomes, setOutcomes] = useState(DEFAULT_COLLEGE_OUTCOMES)
  useEffect(() => {
    supabase.from('settings').select('setting_value')
      .eq('setting_key','college_outcomes_list').maybeSingle()
      .then(({ data }) => {
        if (data?.setting_value) {
          try { setOutcomes(JSON.parse(data.setting_value)) } catch {}
        }
      })
  }, [])
  return outcomes
}

// ─── SCTCC Logo (same embedded PNG as other wizards) ─────────────────────────
// Reuse the b64 constant from CourseRevisionWizard via a direct import or duplicate.
// We embed a minimal placeholder — swap with the real base64 if needed.
const SCTCC_LOGO_B64 = (() => {
  // Pull from document body if running in browser — otherwise blank
  try {
    const el = document.querySelector('[data-sctcc-logo]')
    if (el) return el.dataset.sctccLogo
  } catch {}
  return ''
})()

// ─── Steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Course',      desc: 'Course & basic info' },
  { id: 2, label: 'Changes',     desc: 'What is changing' },
  { id: 3, label: 'Justify',     desc: 'Justification & registrar' },
  { id: 4, label: 'Outcomes',    desc: 'Outcomes alignment' },
  { id: 5, label: 'Outline',     desc: 'Course outline form' },
  { id: 6, label: 'Review',      desc: 'Review, download & approve' },
]

const MNTC_GOAL_AREAS = [
  '1 – Communication', '2 – Critical Thinking', '3 – Natural Sciences',
  '4 – Mathematical/Logical Reasoning', '5 – History & The Social & Behavioral Sciences',
  '6 – The Humanities / Fine Arts', '7 – Human Diversity', '8 – Global Perspective',
  '9 – Ethical & Civic Responsibility', '10 – People & The Environment',
]

const OTHER_CHANGES_ITEMS = [
  { key: 'course_description',  label: 'Course Description' },
  { key: 'min_prereq_gpa',      label: 'Minimum Prerequisite GPA' },
  { key: 'student_outcomes',    label: 'Student Learning Outcomes' },
  { key: 'course_content',      label: 'Course Content / Topics' },
  { key: 'prereqs',             label: 'Pre-Reqs' },
  { key: 'coreqs',              label: 'Co-Reqs' },
  { key: 'test_scores',         label: 'Test Scores' },
  { key: 'major_restricted',    label: 'Major Restricted' },
  { key: 'grading_method',      label: 'Grading Method' },
  { key: 'course_notes',        label: 'Course Notes to be added' },
]

// ─── Default state ────────────────────────────────────────────────────────────
const EMPTY = {
  revision_id: null,
  // Step 1
  date_submitting: new Date().toLocaleDateString('en-US'),
  faculty_submitting: '',
  current_course_num: '',
  current_course_title: '',
  effective_date: '',
  program: [],
  // Step 2 — name/number change
  new_course_name: '',
  new_course_number: '',
  name_number_explanation: '',
  // Step 2 — credits
  current_credits_total: '',
  current_credits_lec: '',
  current_credits_lab: '',
  current_credits_soe: '',
  proposed_credits_total: '',
  proposed_credits_lec: '',
  proposed_credits_lab: '',
  proposed_credits_soe: '',
  credit_change_explanation: '',
  // Step 2 — other changes checklist (true = Yes)
  change_flags: {
    course_description: false, min_prereq_gpa: false, student_outcomes: false,
    course_content: false, prereqs: false, coreqs: false, test_scores: false,
    major_restricted: false, grading_method: false, course_notes: false,
  },
  other_change_detail: '',
  // Step 3
  reason_justification: '',
  checked_registrar: false,
  registrar_contact: '',
  other_dept_affected: false,
  affected_departments: '',
  // Step 4
  is_mntc: false,
  outcomes_alignment: [
    { outcome: '', assessment: '', college_outcome: '' },
    { outcome: '', assessment: '', college_outcome: '' },
    { outcome: '', assessment: '', college_outcome: '' },
    { outcome: '', assessment: '', college_outcome: '' },
    { outcome: '', assessment: '', college_outcome: '' },
  ],
  mntc_goal_areas: [],
  mntc_goal_description: '',
  mntc_competency_alignment: [
    { goal_area_competency: '', outcome: '', assessment: '' },
    { goal_area_competency: '', outcome: '', assessment: '' },
    { goal_area_competency: '', outcome: '', assessment: '' },
  ],
  // Step 5 — course outline
  outline_course_num: '',
  outline_title: '',
  outline_lec: '',
  outline_lab: '',
  outline_soe: '',
  outline_min_gpa: 'none',
  outline_prereqs: '',
  outline_coreqs: '',
  outline_cip_code: '',
  outline_major_restricted: false,
  outline_majors: '',
  outline_suggested_skills: '',
  outline_description: '',
  outline_slos: ['', '', ''],
  outline_topics: ['', '', ''],
  outline_materials: [''],
  outline_grading: 'letter',
  outline_prepared_by: '',
  status: 'draft',
}

// ─── DOCX helpers ─────────────────────────────────────────────────────────────
const FW   = 9360   // content width at 1" margins (DXA)
const MARGIN = { top: 1440, right: 1440, bottom: 1440, left: 1440 }
const CM   = { top: 60, bottom: 60, left: 100, right: 100 }
const TH   = { style: BorderStyle.SINGLE, size: 4, color: '000000' }
const TH_B = { top: TH, bottom: TH, left: TH, right: TH }
const NO   = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
const NO_B = { top: NO, bottom: NO, left: NO, right: NO }
const LGRAY  = { fill: 'D9D9D9', type: ShadingType.CLEAR }
const GRAY   = { fill: 'BFBFBF', type: ShadingType.CLEAR }
const LINE   = (n) => '_'.repeat(n)

const dp  = (runs, opts={}) => new Paragraph({ children: Array.isArray(runs) ? runs : [new TextRun(String(runs||''))], ...opts })
const dr  = (t,o={}) => new TextRun({ text: String(t||''), font:'Arial', size:20, ...o })
const drb = (t,o={}) => dr(t, { bold:true, ...o })
const dri = (t,o={}) => dr(t, { italics:true, ...o })
const dru = (t,i=false) => dr(t, { underline:{ type:UnderlineType.SINGLE }, italics:i })
const dsp = (s) => new Paragraph({ spacing:{before:s,after:0}, children:[dr('')] })

function sectionHeader(title) {
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[FW], rows:[
    new TableRow({ children:[
      new TableCell({ borders:TH_B, shading:LGRAY, width:{size:FW,type:WidthType.DXA},
        margins:CM, children:[dp([drb(title,{size:22})],{alignment:AlignmentType.CENTER})] })
    ]})
  ]})
}

function b64ToUint8Array(b64) {
  if (!b64) return new Uint8Array(0)
  const binary = atob(b64.replace(/^data:image\/[a-z]+;base64,/, ''))
  const arr = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return arr
}

// ─── Page 1: Course Revision Form ────────────────────────────────────────────
function buildRevisionForm(d) {
  const children = []

  // Title
  children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[FW], rows:[
    new TableRow({ children:[
      new TableCell({ borders:TH_B, shading:GRAY, width:{size:FW,type:WidthType.DXA},
        margins:{top:80,bottom:80,left:120,right:120},
        children:[dp([drb('Course Revision Form',{size:28})],{alignment:AlignmentType.CENTER})] })
    ]})
  ]}))
  children.push(dsp(60))

  // Header row
  children.push(dp([drb('Date: '),dr(d.date_submitting||LINE(20)),dr('     '),drb('Faculty Submitting: '),dr(d.faculty_submitting||LINE(30))],{spacing:{before:60,after:40}}))
  children.push(dp([drb('Current Course #: '),dr(d.current_course_num||LINE(18)),dr('     '),drb('Current Title: '),dr(d.current_course_title||LINE(35))],{spacing:{before:0,after:40}}))
  children.push(dp([drb('Effective Date of Change (1 year out): '),dr(d.effective_date||LINE(20)),dr('     '),drb('Program: '),dr(Array.isArray(d.program) ? d.program.join(', ') : (d.program||LINE(30)))],{spacing:{before:0,after:80}}))

  // Name/Number Change
  children.push(sectionHeader('Course Name or Number Change'))
  children.push(dp([dri('(Enter details ONLY if changing Name or Number)')],{alignment:AlignmentType.CENTER,spacing:{before:40,after:60}}))
  children.push(dp([drb('New Course Name (50 Character max): '),dr(d.new_course_name||LINE(40))],{spacing:{before:0,after:40}}))
  children.push(dp([drb('New Course Number (get from AA office): '),dr(d.new_course_number||LINE(35))],{spacing:{before:0,after:40}}))
  children.push(dp([drb('Explanation of change: '),dr(d.name_number_explanation||LINE(60))],{spacing:{before:0,after:80}}))

  // Credit Change
  children.push(sectionHeader('Credit Change'))
  children.push(dp([dri('(Enter details here ONLY if changing credits. You will need a new course number from AA office)')],{alignment:AlignmentType.CENTER,spacing:{before:40,after:60}}))
  const curTot = d.current_credits_total||LINE(6)
  const curLec = d.current_credits_lec||LINE(6)
  const curLab = d.current_credits_lab||LINE(6)
  const curSoe = d.current_credits_soe||LINE(6)
  const proTot = d.proposed_credits_total||LINE(6)
  const proLec = d.proposed_credits_lec||LINE(6)
  const proLab = d.proposed_credits_lab||LINE(6)
  const proSoe = d.proposed_credits_soe||LINE(6)
  children.push(dp([drb('Current Credits: '),drb('Total: '),dr(String(curTot)),dr('   '),drb('Lecture Credits: '),dr(String(curLec)),dr('   '),drb('Lab Credits: '),dr(String(curLab)),dr('   '),drb('SOE: '),dr(String(curSoe))],{spacing:{before:0,after:40}}))
  children.push(dp([drb('Proposed Credits: '),drb('Total: '),dr(String(proTot)),dr('   '),drb('Lecture Credits: '),dr(String(proLec)),dr('   '),drb('Lab Credits: '),dr(String(proLab)),dr('   '),drb('SOE: '),dr(String(proSoe))],{spacing:{before:0,after:40}}))
  children.push(dp([drb('Explanation of the change: '),dr(d.credit_change_explanation||LINE(55))],{spacing:{before:0,after:80}}))

  // Other Changes table
  const otherRows = [
    new TableRow({ children:[
      new TableCell({ columnSpan:2, borders:TH_B, shading:GRAY, width:{size:FW,type:WidthType.DXA},
        margins:CM, children:[dp([drb('Other Changes Being Made:')]),dp([dri('Enter Yes/No for each item below — then make changes on Outline Form on page 4')])] }),
    ]}),
    ...OTHER_CHANGES_ITEMS.map(item => {
      const val = d.change_flags?.[item.key] ? 'Yes' : 'No'
      return new TableRow({ children:[
        new TableCell({ borders:TH_B, width:{size:FW*0.7,type:WidthType.DXA}, margins:CM, children:[dp([drb(item.label)])] }),
        new TableCell({ borders:TH_B, width:{size:FW*0.3,type:WidthType.DXA}, margins:CM, children:[dp([dr(val,{bold: val==='Yes'})])] }),
      ]})
    }),
    new TableRow({ children:[
      new TableCell({ borders:TH_B, width:{size:FW*0.7,type:WidthType.DXA}, margins:CM, children:[dp([drb('Other: '),dr(d.other_change_detail||'')])] }),
      new TableCell({ borders:TH_B, width:{size:FW*0.3,type:WidthType.DXA}, margins:CM, children:[dp('')] }),
    ]}),
  ]
  children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[Math.round(FW*0.7),Math.round(FW*0.3)], rows:otherRows }))

  children.push(dsp(60))
  children.push(dp([drb('Reason / Justification for these changes:')],{spacing:{before:60,after:40}}))
  if (d.reason_justification) {
    children.push(dp([dr(d.reason_justification)],{spacing:{before:0,after:40}}))
  } else {
    ;[LINE(88),LINE(88),LINE(88)].forEach(l=>children.push(dp([dr(l)],{spacing:{before:0,after:40}})))
  }

  return children
}

// ─── Page 2: Outcomes Alignment ───────────────────────────────────────────────
function buildOutcomesPage(d) {
  const children = []
  children.push(new Paragraph({ children:[new PageBreak()] }))
  children.push(dp([dri('If Learning Outcomes have changed or if an alignment has not been done for this course, complete section(s) below')],{spacing:{before:0,after:40}}))
  children.push(dp([dr('• Complete Section A if course is '),drb('not'),dr(' designed for the Minnesota Transfer Curriculum (MnTC).')],{spacing:{before:20,after:20}}))
  children.push(dp([dr('• Complete Section B-E if course is designed for the MnTC.')],{spacing:{before:0,after:60}}))

  // Section A
  children.push(dp([drb('A.  Align each student learning outcome with the assessment method and college outcome/competency:')],{spacing:{before:40,after:40}}))
  const cA1=Math.round(FW*0.38), cA2=Math.round(FW*0.31), cA3=FW-cA1-cA2
  const aRows = [
    new TableRow({ children:[
      new TableCell({ borders:TH_B, shading:LGRAY, width:{size:cA1,type:WidthType.DXA}, margins:CM, children:[dp([drb('Student Learning Outcome')])] }),
      new TableCell({ borders:TH_B, shading:LGRAY, width:{size:cA2,type:WidthType.DXA}, margins:CM, children:[dp([drb('Assessment')])] }),
      new TableCell({ borders:TH_B, shading:LGRAY, width:{size:cA3,type:WidthType.DXA}, margins:CM, children:[dp([drb('College Outcome / Competency')])] }),
    ]}),
    ...(d.outcomes_alignment||[]).map(row => new TableRow({ height:{value:500,rule:'atLeast'}, children:[
      new TableCell({ borders:TH_B, width:{size:cA1,type:WidthType.DXA}, margins:CM, children:[dp([dr(row.outcome||'')])] }),
      new TableCell({ borders:TH_B, width:{size:cA2,type:WidthType.DXA}, margins:CM, children:[dp([dr(row.assessment||'')])] }),
      new TableCell({ borders:TH_B, width:{size:cA3,type:WidthType.DXA}, margins:CM, children:[dp([dr(row.college_outcome||'')])] }),
    ]})),
  ]
  children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[cA1,cA2,cA3], rows:aRows }))
  children.push(dp([dri('*Actual methods of assessment are at the discretion of the instructor')],{spacing:{before:40,after:80}}))

  if (d.is_mntc) {
    children.push(dp([drb('B.  List Goal Areas (check all that apply)')],{spacing:{before:40,after:20}}))
    MNTC_GOAL_AREAS.forEach(ga => {
      const checked = (d.mntc_goal_areas||[]).includes(ga)
      children.push(dp([dr(`${checked?'☑':'☐'} ${ga}`)],{indent:{left:360},spacing:{before:20,after:0}}))
    })
    children.push(dsp(40))
    children.push(dp([drb('C.  List Goal Area Description & Competencies')],{spacing:{before:40,after:20}}))
    children.push(dp([dr(d.mntc_goal_description||LINE(88))],{indent:{left:360},spacing:{before:0,after:60}}))
    children.push(dp([drb('D.  List Competencies for each Goal Area and Align Course Measurable Student Outcomes:')],{spacing:{before:40,after:40}}))
    const cB1=Math.round(FW*0.3), cB2=Math.round(FW*0.4), cB3=FW-cB1-cB2
    const bRows = [
      new TableRow({ children:[
        new TableCell({ borders:TH_B, shading:LGRAY, width:{size:cB1,type:WidthType.DXA}, margins:CM, children:[dp([drb('Goal Area Competency')])] }),
        new TableCell({ borders:TH_B, shading:LGRAY, width:{size:cB2,type:WidthType.DXA}, margins:CM, children:[dp([drb('Student Learning Outcome')])] }),
        new TableCell({ borders:TH_B, shading:LGRAY, width:{size:cB3,type:WidthType.DXA}, margins:CM, children:[dp([drb('Assessment')])] }),
      ]}),
      ...(d.mntc_competency_alignment||[]).map(row => new TableRow({ height:{value:500,rule:'atLeast'}, children:[
        new TableCell({ borders:TH_B, width:{size:cB1,type:WidthType.DXA}, margins:CM, children:[dp([dr(row.goal_area_competency||'')])] }),
        new TableCell({ borders:TH_B, width:{size:cB2,type:WidthType.DXA}, margins:CM, children:[dp([dr(row.outcome||'')])] }),
        new TableCell({ borders:TH_B, width:{size:cB3,type:WidthType.DXA}, margins:CM, children:[dp([dr(row.assessment||'')])] }),
      ]})),
    ]
    children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[cB1,cB2,cB3], rows:bRows }))
    children.push(dsp(60))
  }

  children.push(dp([drb('Attach AACCA feedback form or advisory committee minutes in support of the course revisions.')],{spacing:{before:60,after:40}}))
  children.push(dp([drb('Did you check with Registrar\'s Office? '),dr(d.checked_registrar?'Yes':'No'),dr('   '),drb('If yes, who with: '),dr(d.registrar_contact||LINE(30))],{spacing:{before:0,after:40}}))
  children.push(dp([drb('Will students from any other department be affected by this revision? '),dr(d.other_dept_affected?'Yes':'No'),dr('   '),drb('List department(s): '),dr(d.affected_departments||LINE(25))],{spacing:{before:0,after:80}}))
  children.push(dp([dri('Created 8-22-2023')],{spacing:{before:40,after:0}}))

  return children
}

// ─── Page 3: Signature Page ───────────────────────────────────────────────────
function buildSignaturePage(d) {
  const children = []
  children.push(new Paragraph({ children:[new PageBreak()] }))
  children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[FW], rows:[
    new TableRow({ children:[
      new TableCell({ borders:TH_B, shading:GRAY, width:{size:FW,type:WidthType.DXA}, margins:CM,
        children:[dp([drb('Signature Page for Curriculum Revisions',{size:24})],{alignment:AlignmentType.CENTER})] })
    ]})
  ]}))
  children.push(dp([drb('Course Name: '),dr(d.current_course_title||LINE(40))],{spacing:{before:60,after:40}}))
  children.push(dp([drb('Course Number: '),dr(d.current_course_num||LINE(35))],{spacing:{before:0,after:60}}))
  children.push(dp([drb('Impacted Instructors\' Signatures:')],{spacing:{before:0,after:40}}))
  const sigW = Math.round(FW/3)
  ;[1,2,3,4].forEach(()=>{
    children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[sigW,sigW,sigW], rows:[
      new TableRow({ children:[
        new TableCell({ borders:NO_B, width:{size:sigW,type:WidthType.DXA}, margins:{top:0,bottom:0,left:0,right:40}, children:[dp([dr(LINE(27))],{spacing:{before:40,after:40}})] }),
        new TableCell({ borders:NO_B, width:{size:sigW,type:WidthType.DXA}, margins:{top:0,bottom:0,left:20,right:20}, children:[dp([dr(LINE(27))],{spacing:{before:40,after:40}})] }),
        new TableCell({ borders:NO_B, width:{size:sigW,type:WidthType.DXA}, margins:{top:0,bottom:0,left:40,right:0}, children:[dp([dr(LINE(27))],{spacing:{before:40,after:40}})] }),
      ]})
    ]}))
  })
  children.push(dsp(60))
  children.push(dp([drb('Dean\'s Signature '),dri('(Dean signs before submitting to AASC but after faculty have signed)')],{spacing:{before:40,after:20}}))
  children.push(dp([dr('Circle one: '),dru('Recommended / Not Recommended'),dr('   Signature: '),dr(LINE(30)),dr('   Date: '),dr(LINE(14))],{spacing:{before:0,after:60}}))
  children.push(dp([drb('AASC Chair '),dri('(signs after AASC meeting)'),dr(':   Signature: '),dr(LINE(30)),dr('   Date: '),dr(LINE(14))],{spacing:{before:0,after:60}}))
  children.push(dp([drb('VP of Academic Affairs '),dri('(signs after AASC meeting)'),dr(':   Signature: '),dr(LINE(25)),dr('   Date: '),dr(LINE(14))],{spacing:{before:0,after:0}}))
  return children
}

// ─── Page 4: Course Outline ───────────────────────────────────────────────────
// Built by the shared courseOutlineDocx.js utility (imported above).
// The page break and separator rule are added here so the shared function
// stays self-contained when used standalone by CourseOutlineExportPage.

async function buildDocx(d) {
  const children = [
    ...buildRevisionForm(d),
    ...buildOutcomesPage(d),
    ...buildSignaturePage(d),
    // Page break + visual separator before the outline section
    new Paragraph({ children: [new PageBreak()] }),
    dp([dr('_'.repeat(100))], { spacing: { before: 0, after: 40 } }),
    ...buildCourseOutline(d),
  ]
  const doc = new Document({
    sections:[{
      properties:{ page:{ size:{width:12240,height:15840}, margin:MARGIN } },
      children,
    }]
  })
  return Packer.toBlob(doc)
}

async function patchAndDownload(blob, filename) {
  const buffer = await blob.arrayBuffer()
  const b = new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})
  const url = URL.createObjectURL(b)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(()=>URL.revokeObjectURL(url), 60_000)
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function StepProgress({ current, maxStep, onStep }) {
  return (
    <div className="px-6 pb-4 border-b border-surface-100">
      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const done     = step.id < current
          const active   = step.id === current
          const unlocked = step.id <= maxStep
          return (
            <div key={step.id} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => unlocked && onStep(step.id)}
                  disabled={!unlocked}
                  title={unlocked ? step.label : undefined}
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all
                    ${done || active ? 'bg-blue-600 text-white' : 'bg-surface-100 text-surface-400'}
                    ${active ? 'ring-2 ring-blue-200' : ''}
                    ${unlocked && !active ? 'cursor-pointer hover:scale-110 hover:shadow-sm' : ''}
                    ${!unlocked ? 'cursor-default' : ''}`}>
                  {done ? <Check size={12}/> : step.id}
                </button>
                <span className={`text-[10px] font-medium text-center hidden sm:block mt-0.5
                  ${active ? 'text-blue-600' : done ? 'text-blue-500' : 'text-surface-300'}`}>
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 mb-4 ${done ? 'bg-blue-600' : 'bg-surface-100'}`}/>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Field({ label, required, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-surface-700 mb-1.5">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[10px] text-surface-400 mt-1">{hint}</p>}
    </div>
  )
}
const ic = 'w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400'
const Inp = ({value,onChange,placeholder,className=''}) => <input value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className={`${ic} ${className}`}/>
const Tex = ({value,onChange,placeholder,rows=3}) => <textarea value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} className={`${ic} resize-vertical`}/>
const Num = ({value,onChange,min=0,max=10}) => <input type="number" value={value||''} onChange={e=>onChange(e.target.value)} min={min} max={max} className={ic}/>

function ItemList({ items, onChange, placeholder, addLabel='Add Item' }) {
  return (
    <div className="space-y-2">
      {items.map((item,i) => (
        <div key={i} className="flex gap-2">
          <input value={item} onChange={e=>onChange(items.map((x,j)=>j===i?e.target.value:x))} placeholder={placeholder}
            className="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"/>
          <button onClick={()=>onChange(items.filter((_,j)=>j!==i))}
            className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
            <Trash2 size={14}/>
          </button>
        </div>
      ))}
      <button onClick={()=>onChange([...items,''])} className="flex items-center gap-1.5 text-xs text-blue-600 font-medium hover:text-blue-700 py-1">
        <Plus size={13}/> {addLabel}
      </button>
    </div>
  )
}

// ─── Step 1: Course Info ──────────────────────────────────────────────────────
function Step1({ data, update, catalog }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Course & Basic Information</h3>
        <p className="text-xs text-surface-500">Select the course being revised and provide submission details.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Current Course #" required>
          <input
            list="course-catalog-list"
            value={data.current_course_num || ''}
            onChange={e => {
              const typed = e.target.value.toUpperCase()
              const row = catalog.find(c => c.course_id === typed)
              update('current_course_num', typed)
              if (row) update('current_course_title', row.course_name || '')
              // Pre-fill outline fields from catalog
              if (row) {
                if (!data.outline_course_num) update('outline_course_num', row.course_id)
                if (!data.outline_title)      update('outline_title',      row.course_name || '')
                if (!data.outline_prereqs)    update('outline_prereqs',    row.prerequisites || '')
                if (!data.outline_description) update('outline_description', row.course_description || '')
                if (!data.outline_slos?.some(s=>s.trim()) && Array.isArray(row.student_outcomes))
                  update('outline_slos', row.student_outcomes.length ? row.student_outcomes : ['','',''])
                // New fields
                if (!data.outline_cip_code)        update('outline_cip_code',        row.cip_code || '')
                if (!data.outline_suggested_skills) update('outline_suggested_skills', row.suggested_skills || '')
                if (!data.outline_topics?.some(t=>t.trim()) && Array.isArray(row.course_topics) && row.course_topics.length)
                  update('outline_topics', row.course_topics)
                if (!data.outline_materials?.some(m=>m.trim()) && row.suggested_materials)
                  update('outline_materials', [row.suggested_materials])
                if (!data.outline_grading && row.grading_method)
                  update('outline_grading', row.grading_method)
                // Store full learning_outcomes for Step 4 seeding (assessment + college_outcome)
                if (Array.isArray(row.learning_outcomes) && row.learning_outcomes.length)
                  update('_catalog_learning_outcomes', row.learning_outcomes)
                // ── Snapshot originals for diff at review step ──────────────────
                update('_orig_description',  row.course_description || '')
                update('_orig_prereqs',      row.prerequisites || '')
                update('_orig_cip',          row.cip_code || '')
                update('_orig_skills',       row.suggested_skills || '')
                update('_orig_topics',       Array.isArray(row.course_topics) ? row.course_topics : [])
                update('_orig_materials',    row.suggested_materials || '')
                update('_orig_grading',      row.grading_method || 'letter')
                update('_orig_min_gpa',      'none') // default; not stored in catalog yet
                update('_orig_major_restricted', false)
                const lec = parseFloat(row.credits_lecture)||0
                const lab = parseFloat(row.credits_lab)||0
                const soe = parseFloat(row.credits_soe)||0
                if (!data.current_credits_total && (lec+lab+soe)>0) {
                  update('current_credits_total', String(lec+lab+soe))
                  update('current_credits_lec', String(lec))
                  update('current_credits_lab', String(lab))
                  update('current_credits_soe', String(soe))
                  update('outline_lec', String(lec))
                  update('outline_lab', String(lab))
                  update('outline_soe', String(soe))
                }
              }
            }}
            placeholder="e.g. RICT1610"
            className={`${ic} uppercase`}
          />
          <datalist id="course-catalog-list">
            {catalog.map(c => <option key={c.course_id} value={c.course_id}>{c.course_name}</option>)}
          </datalist>
        </Field>
        <Field label="Current Course Title" required>
          <Inp value={data.current_course_title} onChange={v=>update('current_course_title',v)} placeholder="e.g. Print Reading & Design"/>
        </Field>
        <Field label="Faculty Submitting" required>
          <Inp value={data.faculty_submitting} onChange={v=>update('faculty_submitting',v)} placeholder="Your name"/>
        </Field>
        <Field label="Date Submitting" required>
          <Inp value={data.date_submitting} onChange={v=>update('date_submitting',v)} placeholder="MM/DD/YYYY"/>
        </Field>
        <Field label="Effective Date of Change (1 year out)" required>
          <Inp value={data.effective_date} onChange={v=>update('effective_date',v)} placeholder="e.g. Fall 2027"/>
        </Field>
        <Field label="Program(s)" required hint="Select all programs this course belongs to">
          <div className="space-y-1.5 mt-0.5">
            {PROGRAMS.map(p => {
              const selected = Array.isArray(data.program) ? data.program.includes(p.name) : data.program === p.name
              return (
                <label key={p.id} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors
                  ${selected ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-surface-200 text-surface-700 hover:bg-surface-50'}`}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={e => {
                      const cur = Array.isArray(data.program) ? data.program : (data.program ? [data.program] : [])
                      update('program', e.target.checked ? [...cur, p.name] : cur.filter(x => x !== p.name))
                    }}
                    className="accent-blue-600"
                  />
                  <span className="text-sm font-medium">{p.name}</span>
                </label>
              )
            })}
          </div>
          {Array.isArray(data.program) && data.program.length > 0 && (
            <p className="text-[10px] text-blue-600 mt-1.5 font-medium">{data.program.length} program{data.program.length > 1 ? 's' : ''} selected</p>
          )}
        </Field>
      </div>

      {data.current_course_num && catalog.find(c=>c.course_id===data.current_course_num) && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-800">
          <span className="font-semibold">Catalog data loaded — </span>
          Course info, credits, description & outcomes pre-filled into the outline form. Edit only what's changing.
        </div>
      )}
    </div>
  )
}

// ─── Step 2: Changes ──────────────────────────────────────────────────────────
function Step2({ data, update }) {
  const setFlag = (key, val) => update('change_flags', { ...data.change_flags, [key]: val })

  const propTotal = (parseFloat(data.proposed_credits_lec)||0)+(parseFloat(data.proposed_credits_lab)||0)+(parseFloat(data.proposed_credits_soe)||0)
  const curTotal  = parseFloat(data.current_credits_total)||0
  const updPropCredit = (field, val) => {
    update(field, val)
    const lec = field==='proposed_credits_lec' ? (parseFloat(val)||0) : (parseFloat(data.proposed_credits_lec)||0)
    const lab = field==='proposed_credits_lab' ? (parseFloat(val)||0) : (parseFloat(data.proposed_credits_lab)||0)
    const soe = field==='proposed_credits_soe' ? (parseFloat(val)||0) : (parseFloat(data.proposed_credits_soe)||0)
    update('proposed_credits_total', (lec+lab+soe)>0 ? String(lec+lab+soe) : '')
  }

  const nameChanged   = data.new_course_name?.trim()   && data.new_course_name.trim()   !== data.current_course_title
  const numberChanged = data.new_course_number?.trim()  && data.new_course_number.trim()  !== data.current_course_num
  const nameChanging  = data.new_course_name?.trim() || data.new_course_number?.trim()
  const creditChanging = propTotal > 0 && propTotal !== curTotal

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">What is Changing?</h3>
        <p className="text-xs text-surface-500">Current values are pre-loaded. Fill in proposed values only for fields that are changing — leave blank if not applicable.</p>
      </div>

      {/* Name/Number — DiffRow style */}
      <div className="bg-surface-50 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">Course Name or Number Change</p>
          {nameChanging && <span className="text-[11px] font-bold text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">Changes entered</span>}
        </div>
        <p className="text-[11px] text-surface-500 -mt-2">Enter ONLY if changing name or number. You will need a new course number from the AA office.</p>

        {/* Course Name diff */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-surface-500 uppercase tracking-wide mb-1">Current Course Name</label>
            <div className="px-3 py-2 text-sm bg-surface-100 border border-surface-200 rounded-lg text-surface-600 min-h-[38px]">
              {data.current_course_title || <span className="italic text-surface-400">—</span>}
            </div>
          </div>
          <div>
            <label className={`block text-[11px] font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5 ${nameChanged ? 'text-blue-700' : 'text-surface-500'}`}>
              Proposed Course Name (50 char max)
              {nameChanged && <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full">CHANGED</span>}
            </label>
            <input
              value={data.new_course_name||''}
              onChange={e=>update('new_course_name', e.target.value)}
              placeholder="Leave blank if not changing"
              maxLength={50}
              className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2
                ${nameChanged ? 'border-blue-300 bg-blue-50 focus:ring-blue-400' : 'border-surface-200 focus:ring-blue-400'}`}
            />
            {data.new_course_name && <p className="text-[10px] text-surface-400 mt-0.5 text-right">{data.new_course_name.length}/50</p>}
          </div>
        </div>

        {/* Course Number diff */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-surface-500 uppercase tracking-wide mb-1">Current Course Number</label>
            <div className="px-3 py-2 text-sm bg-surface-100 border border-surface-200 rounded-lg text-surface-600 min-h-[38px]">
              {data.current_course_num || <span className="italic text-surface-400">—</span>}
            </div>
          </div>
          <div>
            <label className={`block text-[11px] font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5 ${numberChanged ? 'text-blue-700' : 'text-surface-500'}`}>
              New Course Number (from AA office)
              {numberChanged && <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full">CHANGED</span>}
            </label>
            <input
              value={data.new_course_number||''}
              onChange={e=>update('new_course_number', e.target.value.toUpperCase())}
              placeholder="Leave blank if not changing"
              className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 uppercase
                ${numberChanged ? 'border-blue-300 bg-blue-50 focus:ring-blue-400' : 'border-surface-200 focus:ring-blue-400'}`}
            />
          </div>
        </div>

        {nameChanging && (
          <Field label="Explanation of change">
            <Tex value={data.name_number_explanation} onChange={v=>update('name_number_explanation',v)} placeholder="Explain the name/number change..." rows={2}/>
          </Field>
        )}
      </div>

      {/* Credits — DiffRow style */}
      <div className="bg-surface-50 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">Credit Change</p>
          {creditChanging && <span className="text-[11px] font-bold text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">Credits will change</span>}
        </div>
        <p className="text-[11px] text-surface-500 -mt-2">Enter ONLY if changing credits. You will need a new course number from AA office.</p>

        {/* Current credits — read-only */}
        <div>
          <label className="block text-[11px] font-semibold text-surface-500 uppercase tracking-wide mb-2">Current Credits</label>
          <div className="grid grid-cols-4 gap-2">
            {[['Total','current_credits_total'],['Lecture','current_credits_lec'],['Lab','current_credits_lab'],['SOE','current_credits_soe']].map(([label,field])=>(
              <div key={field}>
                <label className="block text-[10px] text-surface-400 mb-1">{label}</label>
                <div className="px-3 py-2 text-sm bg-surface-100 border border-surface-200 rounded-lg text-surface-600 min-h-[38px]">
                  {data[field] !== '' && data[field] !== null && data[field] !== undefined ? data[field] : <span className="italic text-surface-400">—</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Proposed credits — editable */}
        <div>
          <label className={`block text-[11px] font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5 ${creditChanging ? 'text-blue-700' : 'text-surface-500'}`}>
            Proposed Credits
            {creditChanging && <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full">CHANGED</span>}
          </label>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="block text-[10px] text-surface-400 mb-1">Total (auto)</label>
              <div className={`px-3 py-2 text-sm rounded-lg border font-semibold min-h-[38px] ${creditChanging ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-surface-100 border-surface-200 text-surface-400 italic'}`}>
                {propTotal > 0 ? propTotal : '—'}
                {creditChanging && curTotal > 0 && <span className="ml-1 text-[10px] font-normal text-surface-400">(was {curTotal})</span>}
              </div>
            </div>
            {[['Lecture','proposed_credits_lec'],['Lab','proposed_credits_lab'],['SOE','proposed_credits_soe']].map(([label,field])=>{
              const curField = field.replace('proposed_','current_')
              const changed = data[field] !== '' && data[field] !== null && data[field] !== undefined && String(data[field]) !== String(data[curField])
              return (
                <div key={field}>
                  <label className="block text-[10px] text-surface-400 mb-1">{label}</label>
                  <input type="number" min={0} max={10} step={1}
                    value={data[field]||''}
                    onChange={e=>updPropCredit(field, e.target.value)}
                    placeholder={data[curField] !== undefined ? String(data[curField]) : '0'}
                    className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2
                      ${changed ? 'border-blue-300 bg-blue-50 focus:ring-blue-400' : 'border-surface-200 focus:ring-blue-400'}`}
                  />
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-surface-400 mt-1">Leave blank to keep current values unchanged.</p>
        </div>

        {creditChanging && (
          <Field label="Explanation of the change">
            <Tex value={data.credit_change_explanation} onChange={v=>update('credit_change_explanation',v)} placeholder="Explain the credit change..." rows={2}/>
          </Field>
        )}
      </div>

      {/* Other Changes checklist */}
      <div className="bg-surface-50 rounded-xl p-4 space-y-3">
        <div>
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">Other Changes Being Made</p>
          <p className="text-[11px] text-surface-500 mt-1">Toggle Yes for each item that is changing. Update details on the Course Outline step.</p>
        </div>
        <div className="space-y-2">
          {OTHER_CHANGES_ITEMS.map(item => (
            <label key={item.key} className="flex items-center gap-3 py-2 px-3 bg-white border border-surface-200 rounded-lg cursor-pointer hover:bg-blue-50 hover:border-blue-200 transition-colors">
              <input type="checkbox" checked={!!data.change_flags?.[item.key]} onChange={e=>setFlag(item.key, e.target.checked)}
                className="accent-blue-600"/>
              <span className="text-sm text-surface-700 flex-1">{item.label}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${data.change_flags?.[item.key] ? 'bg-blue-100 text-blue-700' : 'bg-surface-100 text-surface-400'}`}>
                {data.change_flags?.[item.key] ? 'Yes' : 'No'}
              </span>
            </label>
          ))}
        </div>
        <Field label="Other (describe change)">
          <Inp value={data.other_change_detail} onChange={v=>update('other_change_detail',v)} placeholder="Describe any other change..."/>
        </Field>
      </div>
    </div>
  )
}

// ─── Step 3: Justification ────────────────────────────────────────────────────
function Step3({ data, update }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Justification & Registrar</h3>
      </div>
      <Field label="Reason / Justification for these changes" required>
        <Tex value={data.reason_justification} onChange={v=>update('reason_justification',v)} placeholder="Explain why these changes are being made..." rows={5}/>
      </Field>
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!data.checked_registrar} onChange={e=>update('checked_registrar',e.target.checked)} className="accent-amber-600"/>
          <span className="text-sm font-semibold text-amber-800">I have checked with the Registrar's Office</span>
        </label>
        {data.checked_registrar && (
          <Field label="Who did you speak with?">
            <Inp value={data.registrar_contact} onChange={v=>update('registrar_contact',v)} placeholder="Registrar staff name"/>
          </Field>
        )}
      </div>
      <div className="bg-surface-50 rounded-xl p-4 space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!data.other_dept_affected} onChange={e=>update('other_dept_affected',e.target.checked)} className="accent-blue-600"/>
          <span className="text-sm font-semibold text-surface-700">Students from another department will be affected</span>
        </label>
        {data.other_dept_affected && (
          <Field label="List affected department(s)">
            <Inp value={data.affected_departments} onChange={v=>update('affected_departments',v)} placeholder="e.g. Engineering Technology, HVAC"/>
          </Field>
        )}
      </div>
    </div>
  )
}

// ─── Step 4: Outcomes Alignment ───────────────────────────────────────────────
function Step4({ data, update }) {
  const collegeOutcomes = useCollegeOutcomes()

  // outcomes_alignment rows — seeded from catalog learning_outcomes (full) or outline_slos (bare text)
  const outcomes = data.outcomes_alignment || []
  const catalogSlos = data.outline_slos || []
  // catalog_learning_outcomes stores the full {outcome, assessment, college_outcome} rows saved during New Course Proposal
  const catalogLearningOutcomes = data._catalog_learning_outcomes || []

  // On first open, seed rows from catalog learning_outcomes (preferred) or bare SLOs
  const seedOutcomes = () => {
    if (outcomes.length === 0 || outcomes.every(o => !o.outcome?.trim())) {
      let seeded = []
      if (catalogLearningOutcomes.length > 0) {
        // Full data from New Course Proposal — includes assessment + college_outcome
        seeded = catalogLearningOutcomes.map(lo => ({
          outcome:        lo.outcome || '',
          assessment:     lo.assessment || '',
          college_outcome: lo.college_outcome || '',
          _from_catalog:  true,
        }))
      } else if (catalogSlos.some(s => s?.trim())) {
        // Fallback: only bare SLO text available
        seeded = catalogSlos.filter(s => s?.trim()).map(slo => ({
          outcome: slo, assessment: '', college_outcome: '', _from_catalog: true,
        }))
      }
      if (seeded.length > 0) {
        update('outcomes_alignment', [...seeded, { outcome: '', assessment: '', college_outcome: '', _from_catalog: false }])
      }
    }
  }

  useEffect(() => { seedOutcomes() }, []) // eslint-disable-line

  const updOutcome = (i, field, val) => update('outcomes_alignment',
    outcomes.map((o, j) => j === i ? { ...o, [field]: val, _from_catalog: field === 'outcome' ? false : o._from_catalog } : o)
  )
  const mntcComps = data.mntc_competency_alignment || []
  const updComp = (i, field, val) => update('mntc_competency_alignment', mntcComps.map((c,j)=>j===i?{...c,[field]:val}:c))

  const hasChangedOutcomes = outcomes.some(o => !o._from_catalog && o.outcome?.trim())

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Outcomes Alignment</h3>
        <p className="text-xs text-surface-500">Complete if learning outcomes have changed or alignment hasn't been done. SLOs are pre-loaded from the course catalog.</p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer bg-surface-50 rounded-xl px-4 py-3 border border-surface-200">
        <input type="checkbox" checked={!!data.is_mntc} onChange={e=>update('is_mntc',e.target.checked)} className="accent-blue-600"/>
        <span className="text-sm font-semibold text-surface-700">This course is designed for the Minnesota Transfer Curriculum (MnTC)</span>
      </label>

      {/* Section A — with pre-populated SLOs + college outcomes dropdown */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">
            Section A — Align outcomes with assessment method and college outcome/competency
          </p>
          {hasChangedOutcomes && (
            <span className="text-[11px] font-bold text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">Outcomes changed</span>
          )}
        </div>
        <p className="text-[11px] text-surface-400 mb-2">
          Rows with a <span className="text-amber-600 font-semibold">catalog</span> tag are pre-loaded from current course data. Edit the outcome text if it's changing.
        </p>
        <div className="overflow-x-auto rounded-xl border border-surface-200">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-50 border-b border-surface-200">
                <th className="text-left p-2 font-semibold text-surface-600 w-[38%]">Student Learning Outcome</th>
                <th className="text-left p-2 font-semibold text-surface-600 w-[25%]">Assessment Method</th>
                <th className="text-left p-2 font-semibold text-surface-600 w-[28%]">College Outcome / Competency</th>
                <th className="p-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((row, i) => {
                const isFromCatalog = row._from_catalog && !row.outcome?.trim() === false && row.outcome === catalogSlos[i]
                const outcomeChanged = row.outcome?.trim() && row.outcome !== catalogSlos[i]
                return (
                  <tr key={i} className={`border-b border-surface-100 last:border-0 ${isFromCatalog ? 'bg-amber-50/40' : ''}`}>
                    <td className="p-1.5">
                      <div className="relative">
                        {row._from_catalog && (
                          <span className="absolute -top-0.5 -right-0.5 text-[8px] font-bold text-amber-600 bg-amber-100 px-1 rounded z-10">catalog</span>
                        )}
                        <textarea
                          value={row.outcome || ''}
                          onChange={e => updOutcome(i, 'outcome', e.target.value)}
                          rows={2}
                          placeholder="Student learning outcome..."
                          className={`w-full px-2 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 resize-none
                            ${outcomeChanged ? 'border-blue-300 bg-blue-50 focus:ring-blue-500' : 'border-surface-200 focus:ring-blue-500'}`}
                        />
                      </div>
                    </td>
                    <td className="p-1.5">
                      <input
                        value={row.assessment || ''}
                        onChange={e => updOutcome(i, 'assessment', e.target.value)}
                        placeholder="e.g. Lab practical, Quiz"
                        className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="p-1.5">
                      <select
                        value={row.college_outcome || ''}
                        onChange={e => updOutcome(i, 'college_outcome', e.target.value)}
                        className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="">— Select —</option>
                        {collegeOutcomes.map(g => (
                          <optgroup key={g.outcome} label={g.outcome}>
                            <option value={g.outcome}>{g.outcome}</option>
                            {g.competencies.map(c => (
                              <option key={c} value={c}>&nbsp;&nbsp;↳ {c}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="p-1.5 text-center">
                      <button
                        onClick={() => update('outcomes_alignment', outcomes.filter((_, j) => j !== i))}
                        className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={12}/>
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between mt-2">
          <button
            onClick={() => update('outcomes_alignment', [...outcomes, { outcome: '', assessment: '', college_outcome: '', _from_catalog: false }])}
            className="flex items-center gap-1.5 text-xs text-blue-600 font-medium hover:text-blue-700"
          >
            <Plus size={13}/> Add row
          </button>
          {(catalogLearningOutcomes.length > 0 || catalogSlos.some(s => s?.trim())) && (
            <button
              onClick={() => {
                let seeded = []
                if (catalogLearningOutcomes.length > 0) {
                  seeded = catalogLearningOutcomes.map(lo => ({
                    outcome: lo.outcome||'', assessment: lo.assessment||'', college_outcome: lo.college_outcome||'', _from_catalog: true,
                  }))
                } else {
                  seeded = catalogSlos.filter(s=>s?.trim()).map(slo => ({
                    outcome: slo, assessment: '', college_outcome: '', _from_catalog: true,
                  }))
                }
                update('outcomes_alignment', [...seeded, { outcome: '', assessment: '', college_outcome: '', _from_catalog: false }])
              }}
              className="flex items-center gap-1.5 text-xs text-amber-600 font-medium hover:text-amber-700"
            >
              ↺ Reset from catalog
            </button>
          )}
        </div>
        <p className="text-[10px] text-surface-400 italic mt-1">*Actual methods of assessment are at the discretion of the instructor</p>
      </div>

      {/* MnTC Sections B-D */}
      {data.is_mntc && (
        <div className="space-y-4 border-t border-surface-200 pt-4">
          <div>
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-3">Section B — Goal Areas</p>
            <div className="grid grid-cols-2 gap-1.5">
              {MNTC_GOAL_AREAS.map(ga => (
                <label key={ga} className="flex items-center gap-2 cursor-pointer text-xs text-surface-700">
                  <input type="checkbox"
                    checked={(data.mntc_goal_areas||[]).includes(ga)}
                    onChange={e=>{
                      const cur = data.mntc_goal_areas||[]
                      update('mntc_goal_areas', e.target.checked ? [...cur,ga] : cur.filter(x=>x!==ga))
                    }}
                    className="accent-blue-600"/>
                  {ga}
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-2">Section C — Goal Area Description & Competencies</p>
            <Tex value={data.mntc_goal_description} onChange={v=>update('mntc_goal_description',v)} placeholder="e.g. Goal Area 1 and competencies 1,4,7" rows={2}/>
          </div>
          <div>
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-3">Section D — Competency Alignment</p>
            <div className="overflow-x-auto rounded-xl border border-surface-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50 border-b border-surface-200">
                    <th className="text-left p-2 font-semibold text-surface-600">Goal Area Competency</th>
                    <th className="text-left p-2 font-semibold text-surface-600">Student Learning Outcome</th>
                    <th className="text-left p-2 font-semibold text-surface-600">Assessment</th>
                  </tr>
                </thead>
                <tbody>
                  {mntcComps.map((row,i) => (
                    <tr key={i} className="border-b border-surface-100 last:border-0">
                      <td className="p-1"><input value={row.goal_area_competency||''} onChange={e=>updComp(i,'goal_area_competency',e.target.value)} className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"/></td>
                      <td className="p-1"><input value={row.outcome||''} onChange={e=>updComp(i,'outcome',e.target.value)} className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"/></td>
                      <td className="p-1"><input value={row.assessment||''} onChange={e=>updComp(i,'assessment',e.target.value)} className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"/></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={()=>update('mntc_competency_alignment',[...mntcComps,{goal_area_competency:'',outcome:'',assessment:''}])}
              className="flex items-center gap-1.5 text-xs text-blue-600 font-medium hover:text-blue-700 mt-2">
              <Plus size={13}/> Add row
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step 5: Course Outline ───────────────────────────────────────────────────
function Step5({ data, update }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Course Outline Form</h3>
        <p className="text-xs text-surface-500">This becomes page 4 of the document. Pre-filled from catalog if available.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Course Subject and Number">
          <Inp value={data.outline_course_num} onChange={v=>update('outline_course_num',v)} placeholder="e.g. RICT1610"/>
        </Field>
        <Field label="Title">
          <Inp value={data.outline_title} onChange={v=>update('outline_title',v)} placeholder="e.g. Print Reading & Design"/>
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Lecture Credits"><Num value={data.outline_lec} onChange={v=>update('outline_lec',v)}/></Field>
        <Field label="Lab Credits"><Num value={data.outline_lab} onChange={v=>update('outline_lab',v)}/></Field>
        <Field label="SOE Credits"><Num value={data.outline_soe} onChange={v=>update('outline_soe',v)}/></Field>
        <div>
          <label className="block text-xs font-semibold text-surface-700 mb-1.5">Total (auto)</label>
          <div className="px-3 py-2 text-sm bg-surface-100 border border-surface-200 rounded-lg text-surface-600 font-semibold">
            {((parseFloat(data.outline_lec)||0)+(parseFloat(data.outline_lab)||0)+(parseFloat(data.outline_soe)||0)) || '—'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Minimum Prerequisite GPA">
          <select value={data.outline_min_gpa||'none'} onChange={e=>update('outline_min_gpa',e.target.value)} className={ic}>
            <option value="none">None</option>
            <option value="2.0">2.0</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="CIP Code">
          <Inp value={data.outline_cip_code} onChange={v=>update('outline_cip_code',v)} placeholder="e.g. 15.0405"/>
        </Field>
        <Field label="Prerequisites / Test Scores">
          <Inp value={data.outline_prereqs} onChange={v=>update('outline_prereqs',v)} placeholder="e.g. RICT1500 or concurrent enrollment"/>
        </Field>
        <Field label="Co-requisites">
          <Inp value={data.outline_coreqs} onChange={v=>update('outline_coreqs',v)} placeholder="e.g. RICT1610L"/>
        </Field>
      </div>

      <div className="flex items-center gap-3 bg-surface-50 px-4 py-3 rounded-xl border border-surface-200">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!data.outline_major_restricted} onChange={e=>update('outline_major_restricted',e.target.checked)} className="accent-blue-600"/>
          <span className="text-sm font-semibold text-surface-700">Major Restricted</span>
        </label>
        {data.outline_major_restricted && (
          <Inp value={data.outline_majors} onChange={v=>update('outline_majors',v)} placeholder="List major(s)..." className="flex-1"/>
        )}
      </div>

      <Field label="Suggested skills or background (default note in eServices)">
        <Inp value={data.outline_suggested_skills} onChange={v=>update('outline_suggested_skills',v)} placeholder="e.g. Basic math skills"/>
      </Field>

      <Field label="Course Description" required>
        <Tex value={data.outline_description} onChange={v=>update('outline_description',v)} placeholder="This course provides..." rows={4}/>
      </Field>

      <Field label="Student Learning Outcomes" hint="Each outcome will be numbered with * in the document">
        <ItemList items={data.outline_slos||[]} onChange={v=>update('outline_slos',v)} placeholder="e.g. Students will be able to..." addLabel="Add Outcome"/>
      </Field>

      <Field label="Course Content / Topics">
        <ItemList items={data.outline_topics||[]} onChange={v=>update('outline_topics',v)} placeholder="e.g. Safety & Lab Procedures" addLabel="Add Topic"/>
      </Field>

      <Field label="Suggested Course Materials">
        <ItemList items={data.outline_materials||[]} onChange={v=>update('outline_materials',v)} placeholder="e.g. Wire Stripper (Part #: 12345)" addLabel="Add Material"/>
      </Field>

      <Field label="Grading Method">
        <select value={data.outline_grading||'letter'} onChange={e=>update('outline_grading',e.target.value)} className={ic}>
          <option value="letter">Letter Grade</option>
          <option value="pass_fail">Pass / No Credit (Pass/Fail)</option>
          <option value="developmental">Developmental</option>
        </select>
      </Field>

      <Field label="Prepared By">
        <Inp value={data.outline_prepared_by} onChange={v=>update('outline_prepared_by',v)} placeholder="Your name"/>
      </Field>
    </div>
  )
}

// ─── Step 6: Review ───────────────────────────────────────────────────────────
function buildChangeSummary(data) {
  const changes = []
  const catalogLO  = data._catalog_learning_outcomes || []
  const catalogSlos = data.outline_slos || []

  // Helper: only push if from ≠ to (trimmed)
  const diff = (section, from, to, note) => {
    const f = String(from||'').trim()
    const t = String(to||'').trim()
    if (t && t !== f) changes.push({ section, type: 'diff', from: f||'(none)', to: t, note })
  }

  // Helper: only push if arrays differ
  const diffList = (section, origArr, newArr) => {
    const orig = (origArr||[]).map(s=>String(s||'').trim()).filter(Boolean)
    const next = (newArr||[]).map(s=>String(s||'').trim()).filter(Boolean)
    const added   = next.filter(s=>!orig.includes(s))
    const removed = orig.filter(s=>!next.includes(s))
    if (added.length || removed.length) {
      changes.push({ section, type: 'listdiff', added, removed })
    }
  }

  // ── Name / Number ──────────────────────────────────────────────────────────
  diff('Course Name', data.current_course_title, data.new_course_name, data.name_number_explanation)
  diff('Course Number', data.current_course_num, data.new_course_number, data.name_number_explanation)

  // ── Credits ────────────────────────────────────────────────────────────────
  const propTotal = (parseFloat(data.proposed_credits_lec)||0)+(parseFloat(data.proposed_credits_lab)||0)+(parseFloat(data.proposed_credits_soe)||0)
  const curTotal  = parseFloat(data.current_credits_total)||0
  if (propTotal > 0 && propTotal !== curTotal) {
    const curStr  = `${curTotal} total  (${data.current_credits_lec||0} Lec / ${data.current_credits_lab||0} Lab / ${data.current_credits_soe||0} SOE)`
    const propStr = `${propTotal} total  (${data.proposed_credits_lec||0} Lec / ${data.proposed_credits_lab||0} Lab / ${data.proposed_credits_soe||0} SOE)`
    changes.push({ section: 'Credits', type: 'diff', from: curStr, to: propStr, note: data.credit_change_explanation })
  }

  // ── Justification ─────────────────────────────────────────────────────────
  if (data.reason_justification?.trim())
    changes.push({ section: 'Reason / Justification', type: 'text', value: data.reason_justification })

  // ── Student Learning Outcomes — row-level diff ─────────────────────────────
  const alignedOutcomes = (data.outcomes_alignment||[]).filter(o=>o.outcome?.trim())
  if (alignedOutcomes.length) {
    const origRows = catalogLO.length
      ? catalogLO
      : catalogSlos.filter(Boolean).map(s=>({ outcome:s, assessment:'', college_outcome:'' }))
    const outcomeRows = alignedOutcomes.map((row, i) => {
      const orig = origRows[i]
      const outcomeChanged    = orig ? row.outcome.trim() !== (orig.outcome||'').trim() : true
      const assessmentChanged = orig ? (row.assessment||'').trim() !== (orig.assessment||'').trim() : !!row.assessment?.trim()
      const collegeChanged    = orig ? (row.college_outcome||'').trim() !== (orig.college_outcome||'').trim() : !!row.college_outcome?.trim()
      return {
        ...row, _index: i+1,
        _outcomeChanged: outcomeChanged,
        _assessmentChanged: assessmentChanged,
        _collegeChanged: collegeChanged,
        _origOutcome: orig?.outcome||'',
        _origAssessment: orig?.assessment||'',
        _origCollege: orig?.college_outcome||'',
        _anyChange: outcomeChanged || assessmentChanged || collegeChanged,
      }
    })
    const anyChange = outcomeRows.some(r => r._anyChange)
    if (anyChange) changes.push({ section: 'Student Learning Outcomes', type: 'outcomes', rows: outcomeRows })
  }

  // ── Outline field diffs (only if changed from original) ────────────────────
  diff('Course Description',         data._orig_description,  data.outline_description,        null)
  diff('Prerequisites / Test Scores', data._orig_prereqs,      data.outline_prereqs,            null)
  diff('CIP Code',                    data._orig_cip,          data.outline_cip_code,           null)
  diff('Suggested Skills / Background', data._orig_skills,     data.outline_suggested_skills,   null)
  diffList('Course Content / Topics', data._orig_topics,       data.outline_topics)
  diff('Suggested Course Materials', data._orig_materials,
    (data.outline_materials||[]).filter(m=>m?.trim()).join('\n'), null)
  // Grading — only if changed
  const gradingLabels = { letter: 'Letter Grade', pass_fail: 'Pass / No Credit', developmental: 'Developmental' }
  if (data.outline_grading && data.outline_grading !== (data._orig_grading||'letter')) {
    changes.push({ section: 'Grading Method', type: 'diff',
      from: gradingLabels[data._orig_grading||'letter']||data._orig_grading||'Letter Grade',
      to:   gradingLabels[data.outline_grading]||data.outline_grading })
  }
  // Co-reqs — only if added (usually not in catalog)
  if (data.outline_coreqs?.trim())
    diff('Co-requisites', '', data.outline_coreqs, null)

  // ── Other flagged checklist items ─────────────────────────────────────────
  const flagged = Object.entries(data.change_flags||{}).filter(([,v])=>v)
    .map(([k])=>OTHER_CHANGES_ITEMS.find(i=>i.key===k)?.label).filter(Boolean)
  if (flagged.length) changes.push({ section: 'Other Changes Flagged as Yes', type: 'list', items: flagged })
  if (data.other_change_detail?.trim())
    diff('Other Change Detail', '', data.other_change_detail, null)

  return changes
}

function ChangeSummaryPanel({ data }) {
  const changes = buildChangeSummary(data)

  const handlePrint = () => {
    const escHtml = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const renderChange = c => {
      if (c.type === 'diff') return `
        <div class="change">
          <div class="change-label">${escHtml(c.section)}</div>
          <div class="diff-grid">
            <div class="diff-box current"><div class="diff-tag">Current</div><div class="diff-text strike">${escHtml(c.from||'—')}</div></div>
            <div class="diff-box proposed"><div class="diff-tag">Proposed</div><div class="diff-text">${escHtml(c.to||'—')}</div></div>
          </div>
          ${c.note ? `<div class="note"><strong>Explanation:</strong> ${escHtml(c.note)}</div>` : ''}
        </div>`
      if (c.type === 'list') return `
        <div class="change">
          <div class="change-label">${escHtml(c.section)}</div>
          <ul class="change-list">${c.items.map(i=>`<li>${escHtml(i)}</li>`).join('')}</ul>
        </div>`
      if (c.type === 'listdiff') return `
        <div class="change">
          <div class="change-label">${escHtml(c.section)}</div>
          ${c.removed.length ? `<div style="margin-bottom:6px"><div class="diff-tag">Removed</div><ul class="change-list" style="color:#ef4444">${c.removed.map(i=>`<li style="text-decoration:line-through">${escHtml(i)}</li>`).join('')}</ul></div>` : ''}
          ${c.added.length ? `<div><div class="diff-tag">Added</div><ul class="change-list" style="color:#1d4ed8">${c.added.map(i=>`<li>${escHtml(i)}</li>`).join('')}</ul></div>` : ''}
        </div>`
      if (c.type === 'text') return `
        <div class="change">
          <div class="change-label">${escHtml(c.section)}</div>
          <div class="change-text">${escHtml(c.value)}</div>
        </div>`
      if (c.type === 'outcomes') return `
        <div class="change">
          <div class="change-label">${escHtml(c.section)}</div>
          <table class="outcomes-table">
            <thead><tr><th>#</th><th>Student Learning Outcome</th><th>Assessment Method</th><th>College Outcome / Competency</th></tr></thead>
            <tbody>${c.rows.map(row => `
              <tr>
                <td>${row._index}</td>
                <td class="${row._outcomeChanged?'changed':''}">
                  ${row._outcomeChanged && row._origOutcome ? `<span class="old-val">${escHtml(row._origOutcome)}</span><span class="arrow">→</span>` : ''}
                  ${escHtml(row.outcome)}
                </td>
                <td class="${row._assessmentChanged?'changed':''}">${escHtml(row.assessment)}</td>
                <td class="${row._collegeChanged?'changed':''}">
                  ${row._collegeChanged && row._origCollege ? `<span class="old-val">${escHtml(row._origCollege)}</span><span class="arrow">→</span>` : ''}
                  ${escHtml(row.college_outcome)}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      return ''
    }
    const html = `<!DOCTYPE html><html><head><title>Course Revision Change Summary — ${data.current_course_num}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:Arial,sans-serif;font-size:10.5pt;margin:0.75in;color:#111;line-height:1.45}
      h1{font-size:16pt;margin:0 0 4px;border-bottom:2px solid #1d4ed8;padding-bottom:6px;color:#1e3a8a}
      .meta{font-size:9.5pt;color:#555;margin-bottom:20px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
      .meta-item{background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:6px 10px}
      .meta-item .meta-label{font-size:8pt;font-weight:bold;text-transform:uppercase;color:#888;margin-bottom:2px}
      .meta-item .meta-val{font-weight:bold;color:#111}
      .change{border:1px solid #ddd;border-radius:4px;padding:12px;margin-bottom:12px;break-inside:avoid}
      .change-label{font-size:9pt;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#1d4ed8;margin-bottom:8px}
      .diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px}
      .diff-box{background:#f5f5f5;border-radius:3px;padding:8px}
      .diff-box.proposed{background:#eff6ff;border:1px solid #bfdbfe}
      .diff-tag{font-size:8pt;color:#888;font-weight:bold;margin-bottom:3px}
      .diff-text{font-size:10pt}
      .strike{text-decoration:line-through;color:#666}
      .note{font-size:9pt;color:#555;border-top:1px solid #eee;margin-top:8px;padding-top:8px}
      .change-text{font-size:10pt;white-space:pre-wrap;background:#f9f9f9;padding:8px;border-radius:3px;border:1px solid #eee}
      .change-list{margin:4px 0 0 18px;padding:0;font-size:10pt}
      .change-list li{margin-bottom:3px}
      .outcomes-table{width:100%;border-collapse:collapse;font-size:9pt}
      .outcomes-table th{background:#dbeafe;padding:5px 7px;text-align:left;border:1px solid #93c5fd;font-size:8pt}
      .outcomes-table td{padding:5px 7px;border:1px solid #ddd;vertical-align:top}
      .outcomes-table td.changed{background:#fef9c3}
      .old-val{color:#ef4444;text-decoration:line-through;margin-right:4px;font-size:8.5pt}
      .arrow{color:#6b7280;margin-right:4px}
      @media print{body{margin:0.5in}.change{break-inside:avoid}}
    </style></head><body>
    <h1>Course Revision — Change Summary</h1>
    <div class="meta">
      <div class="meta-item"><div class="meta-label">Course</div><div class="meta-val">${data.current_course_num||'—'} — ${data.current_course_title||''}</div></div>
      <div class="meta-item"><div class="meta-label">Faculty</div><div class="meta-val">${data.faculty_submitting||'—'}</div></div>
      <div class="meta-item"><div class="meta-label">Effective</div><div class="meta-val">${data.effective_date||'—'}</div></div>
      <div class="meta-item"><div class="meta-label">Program(s)</div><div class="meta-val">${Array.isArray(data.program)?data.program.join(', '):(data.program||'—')}</div></div>
      <div class="meta-item"><div class="meta-label">Date Submitted</div><div class="meta-val">${data.date_submitting||'—'}</div></div>
      <div class="meta-item"><div class="meta-label">Status</div><div class="meta-val">${data.status||'draft'}</div></div>
    </div>
    ${changes.length === 0
      ? '<p style="color:#888;font-style:italic">No changes recorded yet — complete the wizard steps first.</p>'
      : changes.map(renderChange).join('')}
    </body></html>`
    const w = window.open('','_blank')
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(),300) }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-surface-700 uppercase tracking-wider">Change Summary</p>
        <button onClick={handlePrint}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-blue-200 text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
          🖨 Print Summary
        </button>
      </div>
      {changes.length === 0 ? (
        <p className="text-xs text-surface-400 italic px-1">No changes recorded yet — complete the wizard steps first.</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {changes.map((c, i) => (
            <div key={i} className="border border-surface-200 rounded-xl overflow-hidden">
              <div className="bg-surface-50 px-3 py-2">
                <span className="text-[11px] font-bold text-blue-700 uppercase tracking-wide">{c.section}</span>
              </div>
              <div className="px-3 py-2.5">
                {c.type === 'diff' && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><p className="text-[10px] text-surface-400 mb-1">Current</p><p className="line-through text-surface-500">{c.from||'—'}</p></div>
                    <div className="bg-blue-50 rounded-lg px-2 py-1.5"><p className="text-[10px] text-blue-400 mb-1">Proposed</p><p className="font-medium text-blue-800">{c.to||'—'}</p></div>
                  </div>
                )}
                {c.type === 'list' && (
                  <ul className="text-xs text-surface-700 space-y-0.5 list-disc list-inside">
                    {c.items.map((item, j) => <li key={j}>{item}</li>)}
                  </ul>
                )}
                {c.type === 'listdiff' && (
                  <div className="space-y-1.5 text-xs">
                    {c.removed.length > 0 && (
                      <div><p className="text-[10px] text-red-400 font-semibold mb-0.5">Removed</p>
                        <ul className="list-disc list-inside space-y-0.5">
                          {c.removed.map((item,j)=><li key={j} className="text-red-600 line-through">{item}</li>)}
                        </ul>
                      </div>
                    )}
                    {c.added.length > 0 && (
                      <div><p className="text-[10px] text-blue-500 font-semibold mb-0.5">Added</p>
                        <ul className="list-disc list-inside space-y-0.5">
                          {c.added.map((item,j)=><li key={j} className="text-blue-700">{item}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                {c.type === 'text' && <p className="text-xs text-surface-700 leading-relaxed line-clamp-3">{c.value}</p>}
                {c.type === 'outcomes' && (
                  <div className="space-y-1">
                    {c.rows.map((row, j) => (
                      <div key={j} className={`text-xs px-2 py-1.5 rounded ${row._outcomeChanged||row._assessmentChanged||row._collegeChanged ? 'bg-amber-50 border border-amber-200' : 'bg-surface-50'}`}>
                        <span className="font-semibold text-surface-600">{row._index}.</span>{' '}
                        {row._outcomeChanged ? <><span className="line-through text-surface-400">{row._origOutcome}</span> <span className="text-blue-700">→ {row.outcome}</span></> : <span>{row.outcome}</span>}
                        {row.assessment && <span className="ml-2 text-surface-400">| {row.assessment}</span>}
                        {row.college_outcome && <span className="ml-2 text-surface-400">| {row.college_outcome}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {c.note && <p className="text-[10px] text-amber-700 mt-1.5 border-t border-surface-100 pt-1.5"><span className="font-semibold">Explanation:</span> {c.note}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Step6({ data, status, saving, downloading, onDownload, onApprove }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-surface-900 mb-1">Review & Actions</h3>
          <p className="text-xs text-surface-500">Verify, download the Word document, and mark as approved.</p>
        </div>
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${status==='approved'?'bg-emerald-50 text-emerald-700':'bg-surface-100 text-surface-600'}`}>
          {status==='approved'?'Approved':'Draft'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          {label:'Course', value: data.current_course_num||'—'},
          {label:'Faculty', value: data.faculty_submitting||'—'},
          {label:'Effective', value: data.effective_date||'—'},
        ].map((r,i)=>(
          <div key={i} className="bg-surface-50 rounded-xl px-3 py-3 border border-surface-200">
            <p className="text-[10px] text-surface-400 uppercase tracking-wide mb-1">{r.label}</p>
            <p className="text-sm font-semibold text-surface-800 truncate">{r.value}</p>
          </div>
        ))}
      </div>

      <ChangeSummaryPanel data={data} />

      <div className="space-y-3 pt-2">
        <button onClick={onDownload} disabled={downloading||!data.current_course_num}
          className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-40 shadow-sm">
          {downloading
            ?<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Generating…</>
            :<><Download size={16}/>Download Word Document (.docx)</>}
        </button>
        <p className="text-xs text-surface-400 text-center">Generates the 4-page SCTCC Course Revision form matching the official format.</p>
        {status !== 'approved' ? (
          <button onClick={onApprove} disabled={saving||!data.current_course_num}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold rounded-xl hover:bg-emerald-100 transition-colors disabled:opacity-40">
            <CheckCircle2 size={14}/> Mark as Approved
          </button>
        ) : (
          <div className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold rounded-xl">
            <CheckCircle2 size={14}/> ✓ Approved
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
export default function CourseOutlineRevisionWizard({ onClose, initialData=null }) {
  const { user } = useAuth()
  const [step, setStep]       = useState(1)
  const [maxStep, setMaxStep] = useState(() => initialData?.revision_id ? STEPS.length : 1)

  const goNext = () => {
    const next = Math.min(step + 1, STEPS.length)
    setStep(next)
    setMaxStep(m => Math.max(m, next))
  }
  const [data, setData] = useState(() => initialData ? {
    ...EMPTY, ...initialData,
    change_flags:              initialData.change_flags && typeof initialData.change_flags==='object' ? initialData.change_flags : EMPTY.change_flags,
    outcomes_alignment:        Array.isArray(initialData.outcomes_alignment) ? initialData.outcomes_alignment : EMPTY.outcomes_alignment,
    mntc_goal_areas:           Array.isArray(initialData.mntc_goal_areas) ? initialData.mntc_goal_areas : [],
    mntc_competency_alignment: Array.isArray(initialData.mntc_competency_alignment) ? initialData.mntc_competency_alignment : EMPTY.mntc_competency_alignment,
    outline_slos:              Array.isArray(initialData.outline_slos) ? initialData.outline_slos : EMPTY.outline_slos,
    outline_topics:            Array.isArray(initialData.outline_topics) ? initialData.outline_topics : EMPTY.outline_topics,
    outline_materials:         Array.isArray(initialData.outline_materials) ? initialData.outline_materials : EMPTY.outline_materials,
  } : { ...EMPTY })
  const [saving, setSaving] = useState(false)
  const [dl, setDl] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [catalog, setCatalog] = useState([])

  const update = useCallback((f,v) => setData(p=>({...p,[f]:v})), [])

  // Keep outline_prepared_by in sync with faculty_submitting
  useEffect(() => {
    if (data.faculty_submitting && !data.outline_prepared_by) {
      setData(p => ({ ...p, outline_prepared_by: p.faculty_submitting }))
    }
  }, [data.faculty_submitting]) // eslint-disable-line

  useEffect(() => {
    supabase.from('syllabus_courses')
      .select('course_id,course_name,credits_lecture,credits_lab,credits_soe,course_description,student_outcomes,learning_outcomes,prerequisites,cip_code,suggested_skills,course_topics,suggested_materials,grading_method')
      .eq('status','active').order('course_id')
      .then(({data:rows}) => { if (rows) setCatalog(rows) })
  }, [])

  const NUMERIC_FIELDS = ['current_credits_total','current_credits_lec','current_credits_lab','current_credits_soe','proposed_credits_total','proposed_credits_lec','proposed_credits_lab','proposed_credits_soe','outline_lec','outline_lab','outline_soe']

  const handleSave = async (extra={}) => {
    setSaving(true)
    const merged = { ...data, ...extra }
    const pid = merged.revision_id || ('COR-'+Date.now()+'-'+Math.random().toString(36).slice(2,7).toUpperCase())
    const payload = { ...merged, revision_id: pid,
      updated_at: new Date().toISOString(), updated_by: user?.email||'',
      created_by: merged.created_by||user?.email||'' }
    // Strip _orig_* tracking fields — they live in state only, not in the DB table
    Object.keys(payload).forEach(k => { if (k.startsWith('_orig_')) delete payload[k] })
    NUMERIC_FIELDS.forEach(f => {
      if (payload[f]===''||payload[f]===undefined) payload[f]=null
      else if (payload[f]!==null) payload[f]=parseFloat(payload[f])||null
    })
    const { error } = await supabase.from('course_outline_revisions').upsert(payload,{onConflict:'revision_id'}).select()
    setSaving(false)
    if (error) { toast.error('Save failed: '+error.message); return false }
    if (!data.revision_id) setData(p=>({...p,revision_id:pid,created_by:user?.email||''}))
    toast.success('Saved!')
    return true
  }

  // ─── Delete draft ────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!data.revision_id) { onClose(); return }   // never saved — just close
    setDeleting(true)
    const { error } = await supabase.from('course_outline_revisions').delete().eq('revision_id', data.revision_id).select()
    setDeleting(false)
    if (error) { toast.error('Delete failed: '+error.message); return }
    toast.success('Draft deleted.')
    onClose()
  }

  const handleDownload = async () => {
    setDl(true)
    try {
      await handleSave()
      const blob = await buildDocx(data)
      const slug = (data.current_course_num||'course_revision').replace(/\s/g,'')
      await patchAndDownload(blob, `${slug}_course_revision.docx`)
      toast.success('Document downloaded!')
    } catch(err) {
      console.error(err)
      toast.error('Generation failed: '+err.message)
    } finally { setDl(false) }
  }

  const handleApprove = async () => {
    const ok = await handleSave({ status:'approved', approved_at:new Date().toISOString(), approved_by:user?.email })
    if (!ok) return
    setData(p=>({...p,status:'approved'}))
    // Update syllabus_courses with latest outline data
    if (data.current_course_num) {
      const catalogUpdates = { updated_at: new Date().toISOString() }
      if (data.outline_description?.trim())  catalogUpdates.course_description = data.outline_description.trim()
      if (data.outline_prereqs?.trim())       catalogUpdates.prerequisites = data.outline_prereqs.trim()
      if (data.outline_cip_code?.trim())      catalogUpdates.cip_code = data.outline_cip_code.trim()
      if (data.outline_suggested_skills?.trim()) catalogUpdates.suggested_skills = data.outline_suggested_skills.trim()
      if ((data.outline_topics||[]).some(t=>t?.trim())) catalogUpdates.course_topics = (data.outline_topics||[]).filter(t=>t?.trim())
      if ((data.outline_materials||[]).some(m=>m?.trim())) catalogUpdates.suggested_materials = (data.outline_materials||[]).filter(m=>m?.trim()).join('\n')
      if (data.outline_grading) catalogUpdates.grading_method = data.outline_grading
      if ((data.outline_slos||[]).some(s=>s?.trim())) catalogUpdates.student_outcomes = (data.outline_slos||[]).filter(s=>s?.trim())
      if (parseFloat(data.outline_lec)) catalogUpdates.credits_lecture = parseFloat(data.outline_lec)
      if (parseFloat(data.outline_lab)) catalogUpdates.credits_lab = parseFloat(data.outline_lab)
      if (parseFloat(data.outline_soe)) catalogUpdates.credits_soe = parseFloat(data.outline_soe)
      if (Object.keys(catalogUpdates).length > 1) {
        const { error } = await supabase.from('syllabus_courses')
          .update(catalogUpdates).eq('course_id', data.current_course_num).select()
        if (error) console.warn('Catalog update failed:', error.message)
        else toast.success('✓ Approved! Course catalog updated.')
      } else {
        toast.success('✓ Approved!')
      }
    } else {
      toast.success('✓ Approved!')
    }
    onClose()
  }

  const stepContent = () => {
    switch(step) {
      case 1: return <Step1 data={data} update={update} catalog={catalog}/>
      case 2: return <Step2 data={data} update={update}/>
      case 3: return <Step3 data={data} update={update}/>
      case 4: return <Step4 data={data} update={update}/>
      case 5: return <Step5 data={data} update={update}/>
      case 6: return <Step6 data={data} status={data.status} saving={saving} downloading={dl} onDownload={handleDownload} onApprove={handleApprove}/>
      default: return null
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
              <FileEdit size={16} className="text-blue-600"/>
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">Course Revision</h2>
              <p className="text-xs text-surface-400">
                {data.current_course_num ? `${data.current_course_num} · ` : ''}{STEPS[step-1].desc}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400"/>
          </button>
        </div>
        <div className="pt-4 shrink-0"><StepProgress current={step} maxStep={maxStep} onStep={setStep}/></div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">{stepContent()}</div>
        <div className="border-t border-surface-100 px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={()=>setStep(s=>s-1)} disabled={step===1}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-50 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              <ChevronLeft size={15}/> Back
            </button>
            {/* Delete draft — hidden once approved */}
            {data.status !== 'approved' && (
              confirmDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-red-600 font-medium">Delete this draft?</span>
                  <button onClick={handleDelete} disabled={deleting}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-40">
                    {deleting ? <Loader2 size={11} className="animate-spin"/> : <Trash2 size={11}/>}
                    Yes, delete
                  </button>
                  <button onClick={()=>setConfirmDelete(false)}
                    className="px-2.5 py-1.5 text-xs text-surface-600 hover:bg-surface-100 border border-surface-200 rounded-lg transition-colors">
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={()=>setConfirmDelete(true)}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 hover:bg-red-50 border border-red-100 hover:border-red-200 rounded-lg transition-colors">
                  <Trash2 size={13}/> Delete Draft
                </button>
              )
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>handleSave()} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-surface-200 text-surface-600 hover:bg-surface-50 rounded-lg transition-colors disabled:opacity-40">
              <Save size={14}/>{saving?'Saving…':'Save Draft'}
            </button>
            {step < STEPS.length && (
              <button onClick={goNext}
                className="flex items-center gap-1.5 px-5 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                Next <ChevronRight size={15}/>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
