import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, ShadingType, BorderStyle,
  UnderlineType, PageBreak, Header, ImageRun, VerticalAlign,
} from 'docx'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  X, ChevronRight, ChevronLeft, Plus, Trash2, Save, Download,
  FileEdit, Check, AlertCircle, CheckCircle2, BookOpen, Loader2,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ─── Program options (the 3 programs offered) ─────────────────────────────────
export const PROGRAMS = [
  { id: 'IPC-AAS',   name: 'Instrumentation & Process Control AAS' },
  { id: 'MECH-AAS',  name: 'Mechatronics AAS' },
  { id: 'MECH-CERT', name: 'Mechatronics Certificate' },
]

// ─── SCTCC Logo (embedded, 150px wide) ───────────────────────────────────────
const SCTCC_LOGO_B64 = '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'
function b64ToUint8Array(b64) {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

// ─── Default program-level settings (used by gear modal) ─────────────────────
export const DEFAULT_REVISION_SETTINGS = {
  default_program_name:    'Robotics & Industrial Controls AAS',
  default_planner_name:    'Robotics & Industrial Controls',
  default_major:           'Robotics & Industrial Controls AAS',
  default_faculty_name:    '',
}

// ─── Hook: load revision settings from Supabase (falls back to defaults) ──────
export function useRevisionSettings() {
  const [settings, setSettings] = useState(DEFAULT_REVISION_SETTINGS)
  useEffect(()=>{
    supabase.from('settings')
      .select('setting_value')
      .eq('setting_key','revision_program_settings')
      .maybeSingle()
      .then(({data})=>{
        if(data?.setting_value){
          try{ setSettings({...DEFAULT_REVISION_SETTINGS,...JSON.parse(data.setting_value)}) }catch{}
        }
      })
  },[])
  return settings
}


// ─── Steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Course',       desc: 'Select course & basic info' },
  { id: 2, label: 'Changes',      desc: 'Name, credit & description changes' },
  { id: 3, label: 'Other',        desc: 'Other changes & outcomes' },
  { id: 4, label: 'DEI',          desc: 'DEI statement & registrar' },
  { id: 5, label: 'Planner',      desc: 'Program planner grid' },
  { id: 6, label: 'Review',       desc: 'Review, download & approve' },
]

const SEMESTERS_OFFERED = ['F', 'S', 'SS', 'F/S', 'F/SS', 'S/SS', 'F/S/SS']

const EMPTY_COURSE_ROW = { course_num: '', course_title: '', prerequisites: '', credits: '', offered: '', grade: '' }
const EMPTY_SEMESTER = (label) => ({
  label,
  courses: [
    { ...EMPTY_COURSE_ROW },
    { ...EMPTY_COURSE_ROW },
    { ...EMPTY_COURSE_ROW },
    { ...EMPTY_COURSE_ROW },
  ]
})

const EMPTY = {
  revision_id: null,
  course_id: '',
  faculty_name: '',
  submission_date: new Date().toLocaleDateString('en-US'),
  effective_semester: '',
  current_program_name: 'Robotics & Industrial Controls AAS',
  proposed_name_change: '',
  name_change_explanation: '',
  current_credits: '',
  current_credits_lec: '',
  current_credits_lab: '',
  current_credits_soe: '',
  proposed_credits: '',
  proposed_credits_lec: '',
  proposed_credits_lab: '',
  proposed_credits_soe: '',
  credit_change_explanation: '',
  program_description: '',
  other_changes: '',
  other_changes_justification: '',
  program_outcomes: ['', '', '', ''],
  dei_statement: '',
  checked_with_registrar: false,
  registrar_staff_name: '',
  student_impact: '',
  planner_name: 'Robotics & Industrial Controls',
  academic_year: '',
  major: 'Robotics & Industrial Controls AAS',
  planner_semesters: [
    EMPTY_SEMESTER('Suggested Technical Studies Semester I'),
    EMPTY_SEMESTER('Suggested Technical Studies Semester II'),
    EMPTY_SEMESTER('Suggested Technical Studies Semester III'),
    EMPTY_SEMESTER('Suggested Technical Studies Semester IV'),
  ],
  credit_totals: {
    program_requirements: '',
    program_electives: '',
    mntc_requirements: '',
    health_fitness: '',
    general_electives: '',
  },
  status: 'draft',
}

// ─── DOCX helpers ─────────────────────────────────────────────────────────────
const TH   = { style: BorderStyle.SINGLE, size: 4,  color: '000000' }
const TH_B = { top: TH, bottom: TH, left: TH, right: TH }
const NO   = { style: BorderStyle.NONE,   size: 0,  color: 'FFFFFF' }
const NO_B = { top: NO, bottom: NO, left: NO, right: NO }
const GRAY  = { fill: 'BFBFBF', type: ShadingType.CLEAR, color: 'auto' }
const LGRAY = { fill: 'E0E0E0', type: ShadingType.CLEAR, color: 'auto' }
const CM    = { top: 60, bottom: 60, left: 80, right: 80 }
const MARGIN = { top: 720, right: 1080, bottom: 720, left: 1080 }
const FW = 12240 - MARGIN.left - MARGIN.right  // 10080

const dr  = (t, x={}) => new TextRun({ text: String(t||''), ...x })
const drb = (t, x={}) => new TextRun({ text: String(t||''), bold: true, ...x })
const dri = (t, x={}) => new TextRun({ text: String(t||''), italics: true, ...x })
const dru = (t, b=false) => new TextRun({ text: String(t||''), bold: b, underline: { type: UnderlineType.SINGLE } })
const dp  = (ch, opts={}) => new Paragraph({ children: Array.isArray(ch)?ch:[typeof ch==='string'?dr(ch):ch], ...opts })
const dsp = (b=120) => new Paragraph({ children: [dr('')], spacing: { before: b, after: 0 } })
const LINE = (len=70) => '_'.repeat(len)

// Gray section header spanning full width
function sectionHeader(text) {
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[FW], rows:[
    new TableRow({ children:[
      new TableCell({ borders:TH_B, shading:GRAY, width:{size:FW,type:WidthType.DXA},
        margins:{top:60,bottom:60,left:120,right:120},
        children:[dp([drb(text,{size:22})],{alignment:AlignmentType.CENTER})] })
    ]})
  ]})
}

function logoHeader(logoData) {
  return new Header({ children:[
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before:0, after:60 },
      children:[
        new ImageRun({ data:logoData, transformation:{width:157,height:93}, type:'png' })
      ]
    })
  ]})
}

// Signature line row: label | blank space
function sigLine(label, lineLen=50) {
  return dp([drb(label), dr(' '), dr(LINE(lineLen))], {spacing:{before:80,after:40}})
}

// ─── Page 1 & 2: Program Revisions Form ──────────────────────────────────────
function buildRevisionPages(d) {
  const children = []

  // Title
  children.push(new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[FW], rows:[
    new TableRow({ children:[
      new TableCell({ borders:TH_B, shading:GRAY, width:{size:FW,type:WidthType.DXA},
        margins:{top:80,bottom:80,left:120,right:120},
        children:[dp([drb('PROGRAM REVISIONS (EXISTING PROGRAMS)',{size:28})],{alignment:AlignmentType.CENTER})] })
    ]})
  ]}))
  children.push(dp([dri('Attach:  Advisory Minutes, AA Advisory Council, Program Planners (Proposed and Current), etc.')],
    {alignment:AlignmentType.CENTER,spacing:{before:40,after:80}}))

  // Date / Faculty
  children.push(dp([drb('Date submitting: '),dr(d.submission_date||''),dr('          '),
    drb('Faculty Proposing Revision: '),dr(d.faculty_name||'')],{spacing:{before:60,after:40}}))
  children.push(dp([drb('Effective Semester of Change (1 year out)*: '),dr(d.effective_semester||''),dr('          '),
    drb('Current Program Name: '),dr(d.current_program_name||'')],{spacing:{before:40,after:120}}))

  // Name Change section
  children.push(sectionHeader('Proposed Name Change (if applicable)'))
  children.push(dp([drb('New Program Name: '),dr(d.proposed_name_change||'n/a if not changing')],{spacing:{before:80,after:40}}))
  children.push(dp([drb('Explanation of the change:')],{spacing:{before:40,after:40}}))
  children.push(dp([dr(d.name_change_explanation||LINE(90))],{indent:{left:360},spacing:{before:0,after:120}}))

  // Credit Adjustment section
  children.push(sectionHeader('Credit Adjustment (if applicable)'))
  const curLec = d.current_credits_lec !== undefined && d.current_credits_lec !== '' && d.current_credits_lec !== null ? d.current_credits_lec : null
  const curLab = d.current_credits_lab !== undefined && d.current_credits_lab !== '' && d.current_credits_lab !== null ? d.current_credits_lab : null
  const curSoe = d.current_credits_soe !== undefined && d.current_credits_soe !== '' && d.current_credits_soe !== null ? d.current_credits_soe : null
  const hasCurBreakdown = curLec !== null || curLab !== null || curSoe !== null
  const currentCrStr = hasCurBreakdown
    ? `${d.current_credits||'?'} total (${curLec||0} Lec / ${curLab||0} Lab / ${curSoe||0} SOE)`
    : (d.current_credits ? String(d.current_credits) : LINE(13))
  children.push(dp([drb('Current Number of Program Credits: '), dr(currentCrStr)], {spacing:{before:80,after:40}}))

  const propLec = d.proposed_credits_lec !== undefined && d.proposed_credits_lec !== '' && d.proposed_credits_lec !== null ? d.proposed_credits_lec : null
  const propLab = d.proposed_credits_lab !== undefined && d.proposed_credits_lab !== '' && d.proposed_credits_lab !== null ? d.proposed_credits_lab : null
  const propSoe = d.proposed_credits_soe !== undefined && d.proposed_credits_soe !== '' && d.proposed_credits_soe !== null ? d.proposed_credits_soe : null
  const hasPropBreakdown = propLec !== null || propLab !== null || propSoe !== null
  const proposedCrStr = hasPropBreakdown
    ? `${d.proposed_credits||'?'} total (${propLec||0} Lec / ${propLab||0} Lab / ${propSoe||0} SOE)`
    : (d.proposed_credits ? String(d.proposed_credits) : LINE(15))
  children.push(dp([drb('Proposed Number of Program Credits: '), dr(proposedCrStr),
    dr('          '), dri('*If AAS Degree now over 60 credits, use Review of AAS Degree Program Over 60 Credits Form')],
    {spacing:{before:40,after:40}}))
  children.push(dp([drb('Explanation of the change: What/Why? '), dr(d.credit_change_explanation||LINE(55))],
    {spacing:{before:40,after:120}}))

  // Program Description section
  children.push(sectionHeader('Program Description - Required'))
  children.push(dp([drb('New (or old description if not changed)')],{spacing:{before:80,after:40}}))
  if (d.program_description) {
    children.push(dp([dr(d.program_description)],{spacing:{before:0,after:40}}))
  } else {
    ;[LINE(88),LINE(96),LINE(96)].forEach(l=>children.push(dp([dr(l)],{spacing:{before:0,after:40}})))
  }
  children.push(dsp(40))

  // Other Changes section
  children.push(sectionHeader('Other Changes'))
  children.push(dp([drb('Including: Delivery mode, CIP code change, closing program, admission requirements, green program, collaborating institutions, SOC codes')],
    {spacing:{before:60,after:40}}))
  children.push(dp([drb('Proposed Change: '),dr(d.other_changes||LINE(68))],{spacing:{before:40,after:40}}))
  ;[LINE(96),LINE(96)].forEach(l=>children.push(dp([dr(l)],{spacing:{before:0,after:40}})))
  children.push(dp([drb('Reasons/Justification: '),dr(d.other_changes_justification||LINE(70))],{spacing:{before:40,after:40}}))
  ;[LINE(96),LINE(96),LINE(96),LINE(96)].forEach(l=>children.push(dp([dr(l)],{spacing:{before:0,after:40}})))
  children.push(dsp(40))

  // Program Outcomes section
  children.push(sectionHeader('Program Outcomes - required'))
  const outcomes = d.program_outcomes||[]
  children.push(dp([drb('Program Outcomes: '),dru('1) '),dr(outcomes[0]||LINE(60))],{spacing:{before:80,after:40}}))
  ;['2)','3)','etc'].forEach((n,i)=>{
    const val = outcomes[i+1]||LINE(90)
    children.push(dp([dru(n+' '),dr(val)],{spacing:{before:40,after:40}}))
  })
  children.push(dsp(40))
  children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:[FW],rows:[
    new TableRow({children:[
      new TableCell({borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
        margins:{top:60,bottom:60,left:120,right:120},
        children:[dp([drb('NEW- required',{size:22})],{alignment:AlignmentType.CENTER})]})
    ]})
  ]}))

  // ── PAGE 2 ─────────────────────────────────────────────────────────────────
  // DEI section
  children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:[FW],rows:[
    new TableRow({children:[
      new TableCell({borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
        margins:{top:60,bottom:60,left:120,right:120},children:[
          dp([drb('Diversity, Equity & Inclusion Statement',{size:22})],{alignment:AlignmentType.CENTER}),
          dp([drb('(or examples of your program action)',{size:20})],{alignment:AlignmentType.CENTER,spacing:{before:20}}),
          dp([dr('Describe how this program reflects diversity and inclusion.')],{spacing:{before:60,after:20}}),
          dp([dr('What does that looks like for your program?')],{spacing:{before:0,after:20}}),
          dp([dr('List all required courses. Identify MNTC courses and goal area.')],{spacing:{before:0,after:40}}),
          dp([drb('Equity 2030 Examples Occurring in Academic Programs')],{spacing:{before:20,after:20}}),
          dp([dr('\u2022  Intentional recruitment of students from underrepresented groups')],{indent:{left:360}}),
          dp([dr('\u2022  Revising program admission policies and standards to remove unintended barriers facing students across race and ethnicity, socioeconomic status and geographic location.')],{indent:{left:360},spacing:{before:20}}),
          dp([dr('\u2022  Identifying program course scheduling issues that negatively impact the participation of students along lines of race and ethnicity, socioeconomic status and geographic location.')],{indent:{left:360},spacing:{before:20}}),
          dp([dr('\u2022  Modification of course and program costs and fees that impair student success/provide financial assistance to students in need')],{indent:{left:360},spacing:{before:20}}),
          dp([dr('Additional information and examples are available from AA office')],{spacing:{before:40,after:20}}),
          dp([dr('The system office does not evaluate equity statements, they just look that you have equity and inclusive learning within the curriculum design.')],{spacing:{before:20,after:40}}),
          dp([drb('Statement: '),dr(d.dei_statement||LINE(60))],{spacing:{before:0,after:40}}),
        ]})
    ]})
  ]}))
  ;[LINE(96),LINE(96),LINE(96)].forEach(l=>children.push(dp([dr(l)],{spacing:{before:0,after:40}})))
  children.push(dsp(80))

  children.push(dp([drb('**REMINDER: If planner change impacts order of courses and consequently pre-reqs of courses, the individual course outlines will need to be changed via the Curriculum Revisions form.')],
    {spacing:{before:40,after:80}}))

  children.push(dp([
    drb('Did you check with Registrar\'s Office? Yes:'),
    dr(d.checked_with_registrar?' \u2713 ':'____ '),
    drb(' with:'),
    dr(' '+(d.registrar_staff_name||'______________')+' '),
    dr('(staff name)'),dr('     '),
    drb('No:'),dr(d.checked_with_registrar?'_____':' \u2713'),
  ],{spacing:{before:40,after:80}}))

  children.push(dp([drb('What, if any, is the student impact?     '),
    drb('Explain:'),dr(d.student_impact||LINE(55))],{spacing:{before:40,after:80}}))
  children.push(dp([dr(LINE(88))],{spacing:{before:0,after:80}}))

  children.push(dp([drb('Impacted Instructors\' Signatures:')],{spacing:{before:40,after:80}}))
  const sigW = FW/2
  ;[1,2,3].forEach(()=>{
    children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:[sigW,sigW],rows:[
      new TableRow({children:[
        new TableCell({borders:NO_B,width:{size:sigW,type:WidthType.DXA},
          margins:{top:0,bottom:0,left:0,right:40},
          children:[dp([dr(LINE(45))],{spacing:{before:40,after:40}})]}),
        new TableCell({borders:NO_B,width:{size:sigW,type:WidthType.DXA},
          margins:{top:0,bottom:0,left:40,right:0},
          children:[dp([dr(LINE(45))],{spacing:{before:40,after:40}})]}),
      ]})
    ]}))
  })
  children.push(dsp(80))

  // Dean / AASC / VP
  children.push(dp([drb('Dean: '),dr(LINE(42)),dr('     '),
    dru('Recommended: \u25a1  Recommend Changes: \u25a1  Date',true),
    dr(': '+LINE(14))],{spacing:{before:60,after:60}}))
  children.push(dp([drb('AASC Chair: '),dr(LINE(38)),dr('          '),
    dru('Passed: \u25a1  Not Passed: \u25a1  Date',true),dr(':')],{spacing:{before:40,after:60}}))
  children.push(dp([drb('V.P. Academic Affairs: '),dr(LINE(30)),dr('          '),
    dru('Approved: \u25a1  Not Approved: \u25a1',true),dr('  Date:')],{spacing:{before:40,after:80}}))

  children.push(dp([dri('Revised 2/15/2022')],{spacing:{before:60,after:0}}))

  return children
}

// ─── Page 3: Program Planner ──────────────────────────────────────────────────
function buildPlannerPage(d, logoData) {
  const children = []
  children.push(new Paragraph({children:[new PageBreak()]}))

  // Title
  children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:[FW],rows:[
    new TableRow({children:[
      new TableCell({borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
        margins:{top:60,bottom:60,left:120,right:120},
        children:[dp([drb('PROGRAM PLANNER REVISIONS (EXISTING PROGRAMS)',{size:24})],{alignment:AlignmentType.CENTER})]})
    ]})
  ]}))
  children.push(dp([dri('Attach: Advisory Minutes, AA Advisory Council, Program Planners (Proposed and Current), etc.')],
    {alignment:AlignmentType.CENTER,spacing:{before:40,after:20}}))
  children.push(dp([drb('Submission Date: '),dr(d.submission_date||'')],{spacing:{before:0,after:80}}))

  // Program Planner header table (logo + "Program Planner" title)
  const halfFW = Math.round(FW*0.28)
  const restFW = FW - halfFW
  children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:[halfFW,restFW],rows:[
    new TableRow({children:[
      new TableCell({borders:TH_B,width:{size:halfFW,type:WidthType.DXA},margins:CM,
        children:[
          new Paragraph({children:[new ImageRun({data:logoData,transformation:{width:80,height:48},type:'png'})],spacing:{before:0,after:20}}),
          dp([drb('Program Planner',{size:14})],{spacing:{before:0,after:0}}),
        ]}),
      new TableCell({borders:TH_B,width:{size:restFW,type:WidthType.DXA},margins:CM,
        verticalAlign:VerticalAlign.CENTER,
        children:[dp([drb('Program Planner',{size:36})],{alignment:AlignmentType.CENTER})]}),
    ]})
  ]}))

  // Name / Academic Year / Major / Credits
  const c1=Math.round(FW*0.5), c2=FW-Math.round(FW*0.5)
  children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:[c1,c2],rows:[
    new TableRow({children:[
      new TableCell({borders:TH_B,width:{size:c1,type:WidthType.DXA},margins:CM,children:[dp([drb('Name: '),dr(d.planner_name||'')])]  }),
      new TableCell({borders:TH_B,width:{size:c2,type:WidthType.DXA},margins:CM,children:[dp([drb('Academic Year: '),dr(d.academic_year||'')])]  }),
    ]}),
    new TableRow({children:[
      new TableCell({borders:TH_B,width:{size:c1,type:WidthType.DXA},margins:CM,children:[dp([drb('Major: '),dr(d.major||'')])]  }),
      new TableCell({borders:TH_B,width:{size:c2,type:WidthType.DXA},margins:CM,children:[dp([drb('Credits: '),dr(computeTotalCredits(d))])]  }),
    ]}),
  ]}))

  // Column widths for course table: Course#, Title, Prerequisites, Credits, Semester, Grade
  const cCourse = 1200, cTitle = 3600, cPrereq = 2400, cCr = 700, cSem = 900, cGrade = 1280
  // cCourse+cTitle+cPrereq+cCr+cSem+cGrade should = FW (10080)
  // 1200+3600+2400+700+900+1280 = 10080 ✓

  const colW = [cCourse, cTitle, cPrereq, cCr, cSem, cGrade]

  // Header row for the table
  const plannerHeaderRow = new TableRow({children:[
    new TableCell({borders:TH_B,width:{size:cCourse,type:WidthType.DXA},shading:LGRAY,margins:CM,verticalAlign:VerticalAlign.BOTTOM,
      children:[dp([drb('Course#',{size:18})],{alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cTitle,type:WidthType.DXA},shading:LGRAY,margins:CM,verticalAlign:VerticalAlign.BOTTOM,
      children:[dp([drb('Course Title',{size:18})],{alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cPrereq,type:WidthType.DXA},shading:LGRAY,margins:CM,verticalAlign:VerticalAlign.BOTTOM,
      children:[dp([drb('Prerequisites',{size:18})],{alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cCr,type:WidthType.DXA},shading:LGRAY,margins:CM,verticalAlign:VerticalAlign.BOTTOM,
      children:[dp([drb('Credits',{size:18})],{alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cSem,type:WidthType.DXA},shading:LGRAY,margins:CM,verticalAlign:VerticalAlign.BOTTOM,
      children:[
        dp([drb('Semester:',{size:16})],{alignment:AlignmentType.CENTER}),
        dp([drb('Fall (F)',{size:14})],{alignment:AlignmentType.CENTER}),
        dp([drb('Spring (S)',{size:14})],{alignment:AlignmentType.CENTER}),
        dp([drb('Summer (SS)',{size:14})],{alignment:AlignmentType.CENTER}),
      ]}),
    new TableCell({borders:TH_B,width:{size:cGrade,type:WidthType.DXA},shading:LGRAY,margins:CM,verticalAlign:VerticalAlign.BOTTOM,
      children:[dp([drb('Grade (for students)',{size:16})],{alignment:AlignmentType.CENTER})]}),
  ]})

  const makeDataRow = (course) => new TableRow({height:{value:400,rule:'atLeast'},children:[
    new TableCell({borders:TH_B,width:{size:cCourse,type:WidthType.DXA},margins:CM,children:[dp(course.course_num||'')]}),
    new TableCell({borders:TH_B,width:{size:cTitle, type:WidthType.DXA},margins:CM,children:[dp(course.course_title||'')]}),
    new TableCell({borders:TH_B,width:{size:cPrereq,type:WidthType.DXA},margins:CM,children:[dp(course.prerequisites||'')]}),
    new TableCell({borders:TH_B,width:{size:cCr,    type:WidthType.DXA},margins:CM,children:[dp(course.credits||'',{alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cSem,   type:WidthType.DXA},margins:CM,children:[dp(course.offered||'',  {alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cGrade, type:WidthType.DXA},margins:CM,children:[dp('')]}),
  ]})

  const semesterLabelRow = (label) => new TableRow({children:[
    new TableCell({columnSpan:6,borders:TH_B,width:{size:FW,type:WidthType.DXA},margins:CM,
      children:[dp([drb(label,{size:18})])]}),
  ]})

  const semesterTotalRow = (semCourses) => {
    const total = semCourses.reduce((s,c)=>s+(parseFloat(c.credits)||0),0)
    return new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,width:{size:cCourse+cTitle,type:WidthType.DXA},margins:CM,children:[dp('')]}),
      new TableCell({borders:TH_B,width:{size:cPrereq,type:WidthType.DXA},margins:CM,
        children:[dp([drb('Semester Total')],{alignment:AlignmentType.RIGHT})]}),
      new TableCell({borders:TH_B,width:{size:cCr,type:WidthType.DXA},margins:CM,
        children:[dp(total>0?String(total):'',{alignment:AlignmentType.CENTER})]}),
      new TableCell({borders:TH_B,width:{size:cSem,type:WidthType.DXA},margins:CM,children:[dp('')]}),
      new TableCell({borders:TH_B,width:{size:cGrade,type:WidthType.DXA},margins:CM,children:[dp('')]}),
    ]})
  }

  const allRows = [plannerHeaderRow]
  const semesters = d.planner_semesters||[]
  semesters.forEach(sem=>{
    allRows.push(semesterLabelRow(sem.label))
    ;(sem.courses||[]).forEach(c=>allRows.push(makeDataRow(c)))
    allRows.push(semesterTotalRow(sem.courses||[]))
    allRows.push(new TableRow({children:[
      new TableCell({columnSpan:6,borders:TH_B,width:{size:FW,type:WidthType.DXA},margins:{top:80,bottom:80,left:80,right:80},children:[dp('')]}),
    ]}))
  })

  // Total Credits row
  const grandTotal = computeTotalCredits(d)
  allRows.push(new TableRow({children:[
    new TableCell({columnSpan:2,borders:TH_B,width:{size:cCourse+cTitle,type:WidthType.DXA},margins:CM,children:[dp([drb('Total Credits')])]}),
    new TableCell({borders:TH_B,width:{size:cPrereq,type:WidthType.DXA},margins:CM,children:[dp('')]}),
    new TableCell({borders:TH_B,width:{size:cCr,type:WidthType.DXA},margins:CM,children:[dp(grandTotal,{alignment:AlignmentType.CENTER})]}),
    new TableCell({borders:TH_B,width:{size:cSem,type:WidthType.DXA},margins:CM,children:[dp('')]}),
    new TableCell({borders:TH_B,width:{size:cGrade,type:WidthType.DXA},margins:CM,children:[dp('')]}),
  ]}))

  children.push(new Table({width:{size:FW,type:WidthType.DXA},columnWidths:colW,rows:allRows}))
  return children
}

// ─── Page 4: Credit Totals ────────────────────────────────────────────────────
function buildCreditTotalsPage(d) {
  const children = []
  const ct = d.credit_totals||{}
  const tW = Math.round(FW*0.45)
  const nW = Math.round(FW*0.2)
  const pad = Math.round((FW-tW-nW)/2) // center it

  const rows = [
    new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,shading:LGRAY,width:{size:tW+nW,type:WidthType.DXA},margins:CM,
        children:[
          dp([drb('Credit Totals')],{alignment:AlignmentType.CENTER}),
          dp([dr('List total credits in program')],{alignment:AlignmentType.CENTER,spacing:{before:20}}),
        ]})
    ]}),
    new TableRow({children:[
      new TableCell({borders:TH_B,width:{size:tW,type:WidthType.DXA},margins:CM,children:[dp('')]}),
      new TableCell({borders:TH_B,width:{size:nW,type:WidthType.DXA},margins:CM,children:[dp([drb('Number')],{alignment:AlignmentType.CENTER})]}),
    ]}),
    ...['Program Requirements','Program Electives','MNTC Requirements','Health/Fitness Requirement','General Electives'].map((label,i)=>{
      const key = ['program_requirements','program_electives','mntc_requirements','health_fitness','general_electives'][i]
      return new TableRow({children:[
        new TableCell({borders:TH_B,width:{size:tW,type:WidthType.DXA},margins:CM,children:[dp(label)]}),
        new TableCell({borders:TH_B,width:{size:nW,type:WidthType.DXA},margins:CM,children:[dp(ct[key]||'',{alignment:AlignmentType.CENTER})]}),
      ]})
    })
  ]

  // Center the table on the page using left indent
  children.push(new Paragraph({children:[new PageBreak()]}))
  children.push(new Table({
    width:{size:tW+nW,type:WidthType.DXA},
    columnWidths:[tW,nW],
    indent:{size:pad,type:WidthType.DXA},
    rows,
  }))
  children.push(dsp(200))
  children.push(dp([dri('Revised 2/15/2022')],{spacing:{before:40,after:0}}))
  return children
}

function computeTotalCredits(d) {
  const sems = d.planner_semesters||[]
  const total = sems.reduce((sum,sem)=>{
    return sum + (sem.courses||[]).reduce((s,c)=>s+(parseFloat(c.credits)||0),0)
  },0)
  return total>0?String(total):''
}

// ─── Main DOCX build ──────────────────────────────────────────────────────────
async function buildRevisionDocx(d) {
  const logoData = b64ToUint8Array(SCTCC_LOGO_B64)
  const children = [
    ...buildRevisionPages(d),
    ...buildPlannerPage(d, logoData),
    ...buildCreditTotalsPage(d),
  ]
  const doc = new Document({
    sections:[{
      headers:{ default: logoHeader(logoData) },
      properties:{ page:{ size:{width:12240,height:15840}, margin:MARGIN } },
      children,
    }]
  })
  return Packer.toBlob(doc)
}

async function patchAndDownload(docxBlob, filename) {
  const buffer = await docxBlob.arrayBuffer()
  const blob = new Blob([buffer],
    {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(()=>URL.revokeObjectURL(url), 60_000)
}

// ─── Step Progress ────────────────────────────────────────────────────────────
function StepProgress({ current, maxStep, onStep }) {
  return (
    <div className="px-6">
      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const done     = step.id < current
          const active   = step.id === current
          const unlocked = step.id <= maxStep
          return (
            <div key={step.id} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => unlocked && onStep(step.id)}
                  disabled={!unlocked}
                  title={unlocked ? step.label : undefined}
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all
                    ${done || active ? 'bg-rose-600 text-white' : 'bg-surface-100 text-surface-400'}
                    ${active ? 'ring-4 ring-rose-100' : ''}
                    ${unlocked && !active ? 'cursor-pointer hover:scale-110 hover:shadow-sm' : ''}
                    ${!unlocked ? 'cursor-default' : ''}`}>
                  {done ? <Check size={13}/> : step.id}
                </button>
                <span className={`text-[10px] mt-1 whitespace-nowrap font-medium
                  ${active ? 'text-rose-600' : done ? 'text-rose-500' : 'text-surface-300'}`}>
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 mb-4 ${done ? 'bg-rose-600' : 'bg-surface-100'}`}/>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Shared inputs ────────────────────────────────────────────────────────────
function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-surface-700 mb-1.5">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}
const ic = 'w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent'
const Inp = ({value,onChange,placeholder,className=''}) => (
  <input value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className={`${ic} ${className}`}/>
)
const Tex = ({value,onChange,placeholder,rows=3}) => (
  <textarea value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows}
    className={`${ic} resize-vertical`}/>
)

// ─── Step 1: Program + Basic Info ─────────────────────────────────────────────
function Step1({data, update}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Program & Basic Information</h3>
        <p className="text-xs text-surface-500">Select the program being revised and fill in submission details.</p>
      </div>

      <Field label="Program Being Revised" required>
        <select value={data.course_id} onChange={e => {
          const prog = PROGRAMS.find(p => p.id === e.target.value)
          update('course_id', e.target.value)
          if (prog) {
            update('current_program_name', prog.name)
            if (!data.proposed_name_change) update('proposed_name_change', prog.name)
          }
        }} className={ic}>
          <option value="">— Select a program —</option>
          {PROGRAMS.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </Field>

      {data.course_id && (
        <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-3 text-xs text-rose-800">
          <span className="font-semibold">Program selected: </span>
          {PROGRAMS.find(p => p.id === data.course_id)?.name}
          <span className="ml-1 text-rose-500">— Edit only what's changing.</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Faculty Proposing Revision" required>
          <Inp value={data.faculty_name} onChange={v=>update('faculty_name',v)} placeholder="Your name"/>
        </Field>
        <Field label="Date Submitting" required>
          <Inp value={data.submission_date} onChange={v=>update('submission_date',v)} placeholder="MM/DD/YYYY"/>
        </Field>
        <Field label="Effective Semester of Change (1 year out)" required>
          <Inp value={data.effective_semester} onChange={v=>update('effective_semester',v)} placeholder="e.g. Fall 2027"/>
        </Field>
        <Field label="Current Program Name">
          <Inp value={data.current_program_name} onChange={v=>update('current_program_name',v)} placeholder="e.g. Robotics & Industrial Controls AAS"/>
        </Field>
      </div>
    </div>
  )
}

// ─── Step 2: Name + Credit + Description changes ──────────────────────────────
function DiffRow({ label, currentVal, proposedVal, onProposedChange, isTextarea=false, rows=2 }) {
  const changed = proposedVal && proposedVal !== currentVal
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="block text-[11px] font-semibold text-surface-500 uppercase tracking-wide mb-1">
          Current {label}
        </label>
        <div className="px-3 py-2 text-sm bg-surface-100 border border-surface-200 rounded-lg text-surface-600 min-h-[38px]">
          {currentVal || <span className="italic text-surface-400">—</span>}
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5">
          <span className={changed ? 'text-rose-700' : 'text-surface-500'}>
            Proposed {label}
          </span>
          {changed && <span className="text-[10px] font-bold px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded-full">CHANGED</span>}
        </label>
        {isTextarea
          ? <textarea value={proposedVal||''} onChange={e=>onProposedChange(e.target.value)} rows={rows}
              className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 resize-vertical ${changed?'border-rose-300 bg-rose-50 focus:ring-rose-400':'border-surface-200 focus:ring-rose-400'}`}/>
          : <input value={proposedVal||''} onChange={e=>onProposedChange(e.target.value)}
              className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 ${changed?'border-rose-300 bg-rose-50 focus:ring-rose-400':'border-surface-200 focus:ring-rose-400'}`}/>
        }
      </div>
    </div>
  )
}

function Step2({data,update}) {
  const nameChanged = data.proposed_name_change && data.proposed_name_change !== data.current_program_name

  // Compute totals for display
  const currentTotal = (parseFloat(data.current_credits_lec)||0) + (parseFloat(data.current_credits_lab)||0) + (parseFloat(data.current_credits_soe)||0)
  const proposedTotal = (parseFloat(data.proposed_credits_lec)||0) + (parseFloat(data.proposed_credits_lab)||0) + (parseFloat(data.proposed_credits_soe)||0)
  const creditsChanged = proposedTotal > 0 && proposedTotal !== currentTotal

  // When any proposed credit field changes, also update the flat proposed_credits total
  const updateProposedCredit = (field, val) => {
    update(field, val)
    const lec = field === 'proposed_credits_lec' ? (parseFloat(val)||0) : (parseFloat(data.proposed_credits_lec)||0)
    const lab = field === 'proposed_credits_lab' ? (parseFloat(val)||0) : (parseFloat(data.proposed_credits_lab)||0)
    const soe = field === 'proposed_credits_soe' ? (parseFloat(val)||0) : (parseFloat(data.proposed_credits_soe)||0)
    update('proposed_credits', (lec + lab + soe) > 0 ? String(lec + lab + soe) : '')
  }

  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Proposed Changes</h3>
        <p className="text-xs text-surface-500">Current values are pre-loaded. Edit only what is changing — unchanged fields will stay as-is on the document.</p></div>

      <div className="bg-surface-50 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-rose-700 uppercase tracking-wider">Program Name</p>
          {nameChanged && <span className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">Name will change</span>}
        </div>
        <DiffRow
          label="Program Name"
          currentVal={data.current_program_name}
          proposedVal={data.proposed_name_change}
          onProposedChange={v=>update('proposed_name_change',v)}
        />
        {nameChanged && (
          <Field label="Explanation of the name change">
            <Tex value={data.name_change_explanation} onChange={v=>update('name_change_explanation',v)} placeholder="Explain the name change..." rows={2}/>
          </Field>
        )}
      </div>

      <div className="bg-surface-50 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-rose-700 uppercase tracking-wider">Program Credits</p>
          {creditsChanged && <span className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">Credits will change</span>}
        </div>

        {/* Current credits — read-only */}
        <div>
          <label className="block text-[11px] font-semibold text-surface-500 uppercase tracking-wide mb-2">Current Credits</label>
          <div className="grid grid-cols-3 gap-3">
            {[['Lecture', data.current_credits_lec], ['Lab', data.current_credits_lab], ['SOE', data.current_credits_soe]].map(([label, val]) => (
              <div key={label}>
                <label className="block text-[10px] text-surface-400 mb-1">{label}</label>
                <div className="px-3 py-2 text-sm bg-surface-100 border border-surface-200 rounded-lg text-surface-600 min-h-[38px]">
                  {val !== '' && val !== undefined && val !== null ? val : <span className="italic text-surface-400">—</span>}
                </div>
              </div>
            ))}
          </div>
          {currentTotal > 0 && (
            <p className="text-xs text-surface-400 mt-1.5">Total: <span className="font-semibold text-surface-600">{currentTotal} credits</span></p>
          )}
        </div>

        {/* Proposed credits — editable */}
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <span className={creditsChanged ? 'text-rose-700' : 'text-surface-500'}>Proposed Credits</span>
            {creditsChanged && <span className="text-[10px] font-bold px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded-full">CHANGED</span>}
          </label>
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Lecture', 'proposed_credits_lec', data.proposed_credits_lec],
              ['Lab',     'proposed_credits_lab', data.proposed_credits_lab],
              ['SOE',     'proposed_credits_soe', data.proposed_credits_soe],
            ].map(([label, field, val]) => {
              const currentVal = data[field.replace('proposed_','current_')]
              const changed = val !== '' && val !== null && val !== undefined && val !== currentVal
              return (
                <div key={label}>
                  <label className="block text-[10px] text-surface-400 mb-1">{label}</label>
                  <input
                    type="number" min={0} max={10} step={1}
                    value={val || ''}
                    onChange={e => updateProposedCredit(field, e.target.value)}
                    placeholder={currentVal || '0'}
                    className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2
                      ${changed ? 'border-rose-300 bg-rose-50 focus:ring-rose-400' : 'border-surface-200 focus:ring-rose-400'}`}
                  />
                </div>
              )
            })}
          </div>
          {proposedTotal > 0 && (
            <p className={`text-xs mt-1.5 ${creditsChanged ? 'text-rose-600 font-semibold' : 'text-surface-400'}`}>
              Total: <span className="font-semibold">{proposedTotal} credits</span>
              {creditsChanged && <span className="ml-1 text-surface-400">(was {currentTotal})</span>}
            </p>
          )}
          <p className="text-[10px] text-surface-400 mt-1">Leave blank to keep current values unchanged.</p>
        </div>

        {creditsChanged && (
          <Field label="Explanation of credit change: What/Why?">
            <Tex value={data.credit_change_explanation} onChange={v=>update('credit_change_explanation',v)} placeholder="Explain the credit change..." rows={2}/>
          </Field>
        )}
      </div>

      <div className="bg-surface-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-rose-700 uppercase tracking-wider">Program Description — Required</p>
        <p className="text-xs text-surface-500">Pre-loaded from catalog. Edit if the description is changing.</p>
        <Field label="Program Description">
          <Tex value={data.program_description} onChange={v=>update('program_description',v)}
            placeholder="Enter the program description..." rows={5}/>
        </Field>
      </div>
    </div>
  )
}

// ─── Step 3: Other Changes + Outcomes ────────────────────────────────────────
function Step3({data,update}) {
  const outcomes = data.program_outcomes||[]
  const updOutcome = (i,v)=>update('program_outcomes',outcomes.map((o,j)=>j===i?v:o))
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Other Changes & Program Outcomes</h3></div>

      <div className="bg-surface-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-rose-700 uppercase tracking-wider">Other Changes</p>
        <p className="text-xs text-surface-500">Including: Delivery mode, CIP code change, closing program, admission requirements, green program, collaborating institutions, SOC codes</p>
        <Field label="Proposed Change">
          <Tex value={data.other_changes} onChange={v=>update('other_changes',v)} placeholder="Describe the proposed changes..." rows={3}/>
        </Field>
        <Field label="Reasons / Justification">
          <Tex value={data.other_changes_justification} onChange={v=>update('other_changes_justification',v)} placeholder="Explain the justification..." rows={3}/>
        </Field>
      </div>

      <div>
        <p className="text-xs font-semibold text-rose-700 uppercase tracking-wider mb-2">Program Outcomes — Required</p>
        <div className="space-y-2">
          {outcomes.map((o,i)=>(
            <div key={i} className="flex gap-2 items-center">
              <span className="text-xs text-surface-400 min-w-[2rem] shrink-0">{i+1})</span>
              <input value={o} onChange={e=>updOutcome(i,e.target.value)}
                placeholder={`Outcome ${i+1}…`} className={`flex-1 ${ic}`}/>
              {outcomes.length>3&&(
                <button onClick={()=>update('program_outcomes',outcomes.filter((_,j)=>j!==i))}
                  className="p-1.5 hover:bg-red-50 rounded-lg text-surface-300 hover:text-red-500 transition-colors">
                  <Trash2 size={14}/>
                </button>
              )}
            </div>
          ))}
        </div>
        <button onClick={()=>update('program_outcomes',[...outcomes,''])}
          className="flex items-center gap-1.5 text-xs text-rose-600 hover:text-rose-700 font-medium mt-2">
          <Plus size={14}/> Add Outcome
        </button>
      </div>
    </div>
  )
}

// ─── Step 4: DEI + Registrar ──────────────────────────────────────────────────
function Step4({data,update}) {
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Diversity, Equity & Inclusion</h3>
        <p className="text-xs text-surface-500">Describe how this program reflects diversity and inclusion.</p></div>

      <div className="bg-rose-50 border border-rose-100 rounded-xl p-4 space-y-2">
        <p className="text-xs font-semibold text-rose-700">Equity 2030 Examples — your statement should reflect one or more of these:</p>
        <ul className="space-y-1 text-xs text-rose-800 list-disc list-inside">
          <li>Intentional recruitment of students from underrepresented groups</li>
          <li>Revising admission policies to remove unintended barriers</li>
          <li>Identifying scheduling issues that negatively impact student participation</li>
          <li>Modification of costs/fees that impair student success</li>
        </ul>
      </div>

      <Field label="DEI Statement" required>
        <Tex value={data.dei_statement} onChange={v=>update('dei_statement',v)}
          placeholder="Describe how this program reflects diversity, equity, and inclusion..." rows={5}/>
      </Field>

      <Field label="What, if any, is the student impact?">
        <Tex value={data.student_impact} onChange={v=>update('student_impact',v)}
          placeholder="Explain any student impact from these changes..." rows={2}/>
      </Field>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex gap-2">
        <AlertCircle size={15} className="text-amber-500 mt-0.5 shrink-0"/>
        <div>
          <p className="text-xs font-semibold text-amber-800">Registrar Check</p>
          <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
            <input type="checkbox" checked={!!data.checked_with_registrar} onChange={e=>update('checked_with_registrar',e.target.checked)} className="accent-rose-600"/>
            <span className="text-xs text-amber-800">I have checked with the Registrar's Office</span>
          </label>
          {data.checked_with_registrar&&(
            <div className="mt-2"><Inp value={data.registrar_staff_name} onChange={v=>update('registrar_staff_name',v)} placeholder="Registrar staff name"/></div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Step 5: Program Planner ──────────────────────────────────────────────────
function Step5({data,update,catalog}) {
  const semesters = data.planner_semesters||[]

  // ── drag state: tracks {si, ri} of the row being dragged ──────────────────
  const dragSrc  = useRef(null) // {si, ri}
  const dragOver = useRef(null) // {si, ri}
  const [dropTarget, setDropTarget] = useState(null) // {si, ri} for highlight

  // ── atomic multi-field update for one row (fixes stale-closure bug) ────────
  const updRowFields = (si, ri, fields) => {
    update('planner_semesters', semesters.map((s, i) => {
      if (i !== si) return s
      return { ...s, courses: s.courses.map((c, j) => j === ri ? { ...c, ...fields } : c) }
    }))
  }

  const updRow = (si, ri, field, val) => updRowFields(si, ri, { [field]: val })

  const addRow = (si) => {
    update('planner_semesters', semesters.map((s,i) =>
      i===si ? { ...s, courses: [...s.courses, {...EMPTY_COURSE_ROW}] } : s
    ))
  }

  const delRow = (si, ri) => {
    update('planner_semesters', semesters.map((s,i) =>
      i===si ? { ...s, courses: s.courses.filter((_,j)=>j!==ri) } : s
    ))
  }

  // ── drag handlers ──────────────────────────────────────────────────────────
  const handleDragStart = (e, si, ri) => {
    dragSrc.current = { si, ri }
    e.dataTransfer.effectAllowed = 'move'
    // ghost image — small so it doesn't obscure the drop zone
    const ghost = document.createElement('div')
    ghost.style.cssText = 'position:absolute;top:-9999px;padding:4px 8px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;font-size:11px;color:#991b1b;white-space:nowrap'
    const cid = semesters[si]?.courses[ri]?.course_num || 'Row'
    ghost.textContent = `⠿ ${cid}`
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 0, 0)
    setTimeout(() => document.body.removeChild(ghost), 0)
  }

  const handleDragOver = (e, si, ri) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    dragOver.current = { si, ri }
    setDropTarget({ si, ri })
  }

  const handleDragLeave = () => {
    setDropTarget(null)
  }

  const handleDrop = (e, toSi, toRi) => {
    e.preventDefault()
    setDropTarget(null)
    const src = dragSrc.current
    if (!src) return
    const { si: fromSi, ri: fromRi } = src
    if (fromSi === toSi && fromRi === toRi) return

    // Build a flat list of all courses with their semester index
    const allFlat = semesters.flatMap((s, si) => s.courses.map((c, ri) => ({ si, ri, course: c })))

    // Find the dragged course
    const dragged = semesters[fromSi]?.courses[fromRi]
    if (!dragged) return

    // Remove from source
    const newSemesters = semesters.map((s, si) => ({
      ...s,
      courses: si === fromSi ? s.courses.filter((_, ri) => ri !== fromRi) : [...s.courses]
    }))

    // Insert before the drop target in the destination semester
    const destCourses = newSemesters[toSi].courses
    const adjustedToRi = (fromSi === toSi && fromRi < toRi) ? toRi - 1 : toRi
    destCourses.splice(Math.max(0, adjustedToRi), 0, dragged)
    newSemesters[toSi] = { ...newSemesters[toSi], courses: destCourses }

    update('planner_semesters', newSemesters)
    dragSrc.current = null
  }

  const handleDragEnd = () => {
    dragSrc.current = null
    dragOver.current = null
    setDropTarget(null)
  }

  const ct = data.credit_totals||{}
  const updCT = (k,v)=>update('credit_totals',{...ct,[k]:v})
  const totalCredits = computeTotalCredits(data)

  const isDropTarget = (si, ri) => dropTarget?.si === si && dropTarget?.ri === ri

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Program Planner</h3>
        <p className="text-xs text-surface-500">Build the proposed program planner. This becomes page 3 of the document.</p>
        <p className="text-xs text-surface-400 mt-0.5 flex items-center gap-1">
          <span className="text-surface-300">⠿</span> Drag the handle to reorder rows — even across semesters. Type any Course # directly, or pick from the catalog suggestions.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Planner Name">
          <Inp value={data.planner_name} onChange={v=>update('planner_name',v)} placeholder="Program name"/>
        </Field>
        <Field label="Academic Year">
          <Inp value={data.academic_year} onChange={v=>update('academic_year',v)} placeholder="e.g. 2026-2027"/>
        </Field>
        <Field label="Major">
          <Inp value={data.major} onChange={v=>update('major',v)} placeholder="e.g. RICT AAS"/>
        </Field>
      </div>

      {semesters.map((sem, si) => (
        <div key={si} className="border border-surface-200 rounded-xl overflow-hidden">
          <div className="bg-rose-50 border-b border-surface-200 px-4 py-2.5 flex items-center justify-between">
            <p className="text-xs font-semibold text-rose-700">{sem.label}</p>
            <span className="text-xs text-surface-400">
              {sem.courses.reduce((s,c)=>s+(parseFloat(c.credits)||0),0)} credits
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="p-2 w-5"></th>{/* drag handle col */}
                  <th className="text-left p-2 font-semibold text-surface-600 w-[13%]">Course #</th>
                  <th className="text-left p-2 font-semibold text-surface-600 w-[30%]">Course Title</th>
                  <th className="text-left p-2 font-semibold text-surface-600 w-[25%]">Prerequisites</th>
                  <th className="text-center p-2 font-semibold text-surface-600 w-[8%]">Credits</th>
                  <th className="text-center p-2 font-semibold text-surface-600 w-[12%]">Offered</th>
                  <th className="p-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {/* Drop zone ABOVE first row when dragging from another semester */}
                {sem.courses.length === 0 && (
                  <tr>
                    <td colSpan={7}
                      onDragOver={e=>{e.preventDefault(); setDropTarget({si,ri:0})}}
                      onDragLeave={handleDragLeave}
                      onDrop={e=>handleDrop(e,si,0)}
                      className={`h-10 text-center text-xs italic transition-colors ${dropTarget?.si===si ? 'bg-rose-50 text-rose-400' : 'text-surface-300'}`}>
                      {dropTarget?.si===si ? '↓ Drop here' : 'Drop a course here'}
                    </td>
                  </tr>
                )}
                {sem.courses.map((course, ri) => (
                  <tr
                    key={ri}
                    draggable
                    onDragStart={e=>handleDragStart(e,si,ri)}
                    onDragOver={e=>handleDragOver(e,si,ri)}
                    onDragLeave={handleDragLeave}
                    onDrop={e=>handleDrop(e,si,ri)}
                    onDragEnd={handleDragEnd}
                    className={`border-b border-surface-100 last:border-0 transition-colors
                      ${isDropTarget(si,ri) ? 'bg-rose-50 border-t-2 border-t-rose-400' : 'hover:bg-surface-50/50'}`}
                  >
                    {/* Drag handle */}
                    <td className="pl-2 pr-0 text-center cursor-grab active:cursor-grabbing select-none text-surface-300 hover:text-rose-400">
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                        <circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/>
                        <circle cx="2.5" cy="7" r="1.5"/><circle cx="7.5" cy="7" r="1.5"/>
                        <circle cx="2.5" cy="11.5" r="1.5"/><circle cx="7.5" cy="11.5" r="1.5"/>
                      </svg>
                    </td>
                    <td className="p-1">
                      {/* Free-text input with catalog suggestions via datalist.
                          Typing a known course ID auto-fills title/credits/prereqs.
                          Typing anything else (gen-ed, elective, etc.) saves as typed. */}
                      <input
                        list={`catalog-list-${si}-${ri}`}
                        value={course.course_num || ''}
                        onChange={e => {
                          const typed = e.target.value.toUpperCase()
                          const row = catalog.find(c => c.course_id === typed)
                          if (row) {
                            const cr = (parseFloat(row.credits_lecture)||0) + (parseFloat(row.credits_lab)||0) + (parseFloat(row.credits_soe)||0)
                            updRowFields(si, ri, {
                              course_num:    typed,
                              course_title:  row.course_name || '',
                              prerequisites: row.prerequisites || course.prerequisites || '',
                              credits:       cr > 0 ? String(cr) : course.credits,
                            })
                          } else {
                            updRow(si, ri, 'course_num', e.target.value.toUpperCase())
                          }
                        }}
                        placeholder="e.g. ENGL1101"
                        className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-rose-500 bg-white uppercase"
                      />
                      <datalist id={`catalog-list-${si}-${ri}`}>
                        {catalog.map(c => <option key={c.course_id} value={c.course_id}>{c.course_name}</option>)}
                      </datalist>
                    </td>
                    <td className="p-1">
                      <input value={course.course_title || ''} onChange={e=>updRow(si,ri,'course_title',e.target.value)}
                        className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-rose-500"/>
                    </td>
                    <td className="p-1">
                      <input value={course.prerequisites || ''} onChange={e=>updRow(si,ri,'prerequisites',e.target.value)}
                        className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-rose-500"/>
                    </td>
                    <td className="p-1">
                      <input value={course.credits || ''} onChange={e=>updRow(si,ri,'credits',e.target.value)}
                        className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-rose-500 text-center"/>
                    </td>
                    <td className="p-1">
                      <select value={course.offered || ''} onChange={e=>updRow(si,ri,'offered',e.target.value)}
                        className="w-full px-1.5 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:ring-1 focus:ring-rose-500 bg-white text-center">
                        <option value=""></option>
                        {SEMESTERS_OFFERED.map(s=><option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="p-1 text-center">
                      <button onClick={()=>delRow(si,ri)}
                        className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500 transition-colors">
                        <Trash2 size={12}/>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-surface-100 flex justify-between items-center">
            <button onClick={()=>addRow(si)} className="flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 font-medium">
              <Plus size={12}/> Add row
            </button>
            <span className="text-xs font-semibold text-surface-600">
              Semester total: {sem.courses.reduce((s,c)=>s+(parseFloat(c.credits)||0),0)} cr
            </span>
          </div>
        </div>
      ))}

      {/* Credit Totals */}
      <div className="bg-surface-50 rounded-xl p-4">
        <p className="text-xs font-semibold text-surface-700 mb-3">Credit Totals Summary</p>
        <div className="grid grid-cols-2 gap-3">
          {[
            {key:'program_requirements',label:'Program Requirements'},
            {key:'program_electives',label:'Program Electives'},
            {key:'mntc_requirements',label:'MNTC Requirements'},
            {key:'health_fitness',label:'Health/Fitness Requirement'},
            {key:'general_electives',label:'General Electives'},
          ].map(({key,label})=>(
            <div key={key} className="flex items-center gap-2">
              <span className="text-xs text-surface-600 flex-1">{label}</span>
              <Inp value={ct[key]||''} onChange={v=>updCT(key,v)} placeholder="0" className="w-16 text-center"/>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-surface-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-surface-700">Grand Total (auto-calculated from planner)</span>
          <span className="text-sm font-bold text-surface-900">{totalCredits||'—'} credits</span>
        </div>
      </div>
    </div>
  )
}

// ─── Change Summary (printable) ──────────────────────────────────────────────
function ChangeSummary({ data }) {
  const changes = []

  if (data.proposed_name_change && data.proposed_name_change !== data.current_program_name) {
    changes.push({ label: 'Program Name', from: data.current_program_name, to: data.proposed_name_change, note: data.name_change_explanation })
  }
  if (data.proposed_credits && String(data.proposed_credits) !== String(data.current_credits||'')) {
    changes.push({ label: 'Program Credits', from: String(data.current_credits||'—'), to: String(data.proposed_credits), note: data.credit_change_explanation })
  }
  if (data.program_description) {
    changes.push({ label: 'Program Description', from: null, to: data.program_description, note: null })
  }
  if (data.other_changes) {
    changes.push({ label: 'Other Changes', from: null, to: data.other_changes, note: data.other_changes_justification })
  }
  const plannerCourses = (data.planner_semesters||[]).reduce((s,sem)=>s+(sem.courses||[]).filter(c=>c.course_num).length,0)
  if (plannerCourses > 0) {
    changes.push({ label: 'Program Planner', from: null, to: `${plannerCourses} courses across ${(data.planner_semesters||[]).length} semesters`, note: null })
  }
  const totalCr = computeTotalCredits(data)
  if (totalCr) {
    changes.push({ label: 'Total Credits (Planner)', from: String(data.current_credits||'—'), to: totalCr, note: null })
  }

  const handlePrint = () => {
    const html = `<!DOCTYPE html><html><head><title>Change Summary — ${data.course_id}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11pt;margin:1in;color:#000}
      h1{font-size:16pt;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:4px}
      h2{font-size:11pt;margin:0 0 2px 0}
      .meta{font-size:10pt;color:#444;margin-bottom:24px}
      .change{border:1px solid #ccc;border-radius:4px;padding:12px;margin-bottom:12px;break-inside:avoid}
      .label{font-size:9pt;font-weight:bold;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:6px}
      .box{background:#f5f5f5;border-radius:3px;padding:8px;font-size:10pt}
      .box.proposed{background:#fff3f3;border:1px solid #fca5a5}
      .box-label{font-size:8pt;color:#888;margin-bottom:3px}
      .note{font-size:9.5pt;color:#555;border-top:1px solid #eee;margin-top:8px;padding-top:8px}
      .no-changes{color:#666;font-style:italic;margin-top:24px}
      @media print{body{margin:0.75in}}
    </style></head><body>
    <h1>Program Revision — Change Summary</h1>
    <div class="meta">
      <strong>Course:</strong> ${data.course_id} — ${data.current_program_name||''}<br>
      <strong>Faculty:</strong> ${data.faculty_name||'—'}&nbsp;&nbsp;&nbsp;
      <strong>Effective:</strong> ${data.effective_semester||'—'}&nbsp;&nbsp;&nbsp;
      <strong>Date:</strong> ${data.submission_date||'—'}&nbsp;&nbsp;&nbsp;
      <strong>Status:</strong> ${data.status||'draft'}
    </div>
    ${changes.length === 0
      ? '<p class="no-changes">No specific changes recorded yet.</p>'
      : changes.map(c=>`
        <div class="change">
          <div class="label">${c.label}</div>
          ${c.from !== null
            ? `<div class="row">
                <div class="box"><div class="box-label">Current</div>${c.from||'—'}</div>
                <div class="box proposed"><div class="box-label">Proposed</div>${c.to||'—'}</div>
              </div>`
            : `<div class="box proposed"><div class="box-label">Proposed</div>${c.to||'—'}</div>`
          }
          ${c.note ? `<div class="note"><strong>Explanation:</strong> ${c.note}</div>` : ''}
        </div>`).join('')
    }
    </body></html>`
    const w = window.open('','_blank')
    if(w){ w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>{ w.print() },300) }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-surface-700 uppercase tracking-wider">Changes Summary</p>
        <button onClick={handlePrint}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-rose-200 text-rose-700 bg-rose-50 rounded-lg hover:bg-rose-100 transition-colors">
          🖨 Print Summary
        </button>
      </div>
      {changes.length === 0 ? (
        <p className="text-xs text-surface-400 italic px-1">No changes recorded yet — complete the wizard steps first.</p>
      ) : (
        <div className="space-y-2">
          {changes.map((c,i)=>(
            <div key={i} className="border border-surface-200 rounded-xl overflow-hidden">
              <div className="bg-surface-50 px-3 py-2 flex items-center gap-2">
                <span className="text-[11px] font-semibold text-surface-600 uppercase tracking-wide flex-1">{c.label}</span>
                {c.from !== null && c.from !== c.to && (
                  <span className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">CHANGED</span>
                )}
              </div>
              {c.from !== null ? (
                <div className="grid grid-cols-2 divide-x divide-surface-200">
                  <div className="px-3 py-2.5">
                    <p className="text-[10px] text-surface-400 mb-1">Current</p>
                    <p className="text-xs text-surface-700 line-through decoration-rose-300">{c.from||'—'}</p>
                  </div>
                  <div className="px-3 py-2.5 bg-rose-50/50">
                    <p className="text-[10px] text-rose-500 mb-1">Proposed</p>
                    <p className="text-xs font-semibold text-rose-800">{c.to||'—'}</p>
                  </div>
                </div>
              ) : (
                <div className="px-3 py-2.5">
                  <p className="text-xs text-surface-700 line-clamp-3">{c.to}</p>
                </div>
              )}
              {c.note && (
                <div className="border-t border-surface-100 px-3 py-2 bg-amber-50/50">
                  <p className="text-[10px] text-amber-700"><span className="font-semibold">Explanation:</span> {c.note}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Step 6: Review ───────────────────────────────────────────────────────────
function Step6({data,status,saving,downloading,onDownload,onApprove}) {
  const courseLabel = data.course_id || '(not set)'
  const statusCfg = {
    draft:    {bg:'bg-surface-100',text:'text-surface-600',label:'Draft'},
    approved: {bg:'bg-emerald-50',text:'text-emerald-700',label:'Approved'},
  }[status]||{bg:'bg-surface-100',text:'text-surface-600',label:'Draft'}

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h3 className="text-base font-bold text-surface-900 mb-1">Review & Actions</h3>
          <p className="text-xs text-surface-500">Review what's changed, download the Word document, and mark as approved.</p></div>
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${statusCfg.bg} ${statusCfg.text}`}>{statusCfg.label}</span>
      </div>

      {/* Quick summary row */}
      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          {label:'Course',value:courseLabel},
          {label:'Faculty',value:data.faculty_name||'—'},
          {label:'Effective',value:data.effective_semester||'—'},
        ].map((r,i)=>(
          <div key={i} className="bg-surface-50 rounded-xl px-3 py-3 border border-surface-200">
            <p className="text-[10px] text-surface-400 uppercase tracking-wide mb-1">{r.label}</p>
            <p className="text-sm font-semibold text-surface-800 truncate">{r.value}</p>
          </div>
        ))}
      </div>

      {/* Change summary with print button */}
      <ChangeSummary data={data}/>

      <div className="space-y-3 pt-2">
        <button onClick={onDownload} disabled={downloading||!data.course_id}
          className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-rose-600 text-white text-sm font-semibold rounded-xl hover:bg-rose-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm">
          {downloading
            ?<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Generating…</>
            :<><Download size={16}/>Download Word Document (.docx)</>}
        </button>
        <p className="text-xs text-surface-400 text-center">Generates the 4-page SCTCC Program Revision form matching the official format.</p>
        <div className="flex gap-3 pt-1">
          {status!=='approved'&&(
            <button onClick={onApprove} disabled={saving||!data.course_id}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold rounded-xl hover:bg-emerald-100 transition-colors disabled:opacity-40">
              <CheckCircle2 size={14}/> Mark as Approved
            </button>
          )}
          {status==='approved'&&(
            <div className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold rounded-xl">
              <CheckCircle2 size={14}/> ✓ Approved — Program revision complete
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
export default function CourseRevisionWizard({ onClose, initialData=null, programSettings=null }) {
  const { user } = useAuth()
  const [step, setStep]       = useState(1)
  const [maxStep, setMaxStep] = useState(() => initialData?.revision_id ? STEPS.length : 1)

  const goNext = () => {
    const next = Math.min(step + 1, STEPS.length)
    setStep(next)
    setMaxStep(m => Math.max(m, next))
  }
  const [data, setData]     = useState(()=>{
    const ps = programSettings || DEFAULT_REVISION_SETTINGS
    if (!initialData) return { ...EMPTY,
      faculty_name: ps.default_faculty_name || '',
      current_program_name: ps.default_program_name,
      planner_name: ps.default_planner_name,
      major: ps.default_major,
    }
    return {
      ...EMPTY, ...initialData,
      program_outcomes:    Array.isArray(initialData.program_outcomes)    ? initialData.program_outcomes    : EMPTY.program_outcomes,
      planner_semesters:   Array.isArray(initialData.planner_semesters)   ? initialData.planner_semesters   : EMPTY.planner_semesters,
      credit_totals:       initialData.credit_totals && typeof initialData.credit_totals==='object' ? initialData.credit_totals : EMPTY.credit_totals,
    }
  })
  const [saving, setSaving] = useState(false)
  const [dl, setDl]         = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [catalog, setCatalog] = useState([])

  const update = useCallback((f,v)=>setData(p=>({...p,[f]:v})),[])

  // Load catalog — and if a draft is opening with course_id already set,
  // backfill CURRENT values from catalog without overwriting proposed changes
  useEffect(()=>{
    supabase.from('syllabus_courses')
      .select('course_id,course_name,credits_lecture,credits_lab,credits_soe,course_description,student_outcomes,prerequisites')
      .eq('status','active').order('course_id')
      .then(({data:rows})=>{
        if(!rows) return
        setCatalog(rows)
        setData(prev=>{
          if(!prev.course_id) return prev
          const row = rows.find(r=>r.course_id===prev.course_id)
          if(!row) return prev
          const lec2 = parseFloat(row.credits_lecture)||0
          const lab2 = parseFloat(row.credits_lab)||0
          const soe2 = parseFloat(row.credits_soe)||0
          const totalCr = lec2 + lab2 + soe2
          return {
            ...prev,
            // Always refresh CURRENT values from live catalog
            current_program_name: row.course_name || prev.current_program_name,
            current_credits:      totalCr > 0 ? String(totalCr) : prev.current_credits,
            current_credits_lec:  totalCr > 0 ? String(lec2) : prev.current_credits_lec,
            current_credits_lab:  totalCr > 0 ? String(lab2) : prev.current_credits_lab,
            current_credits_soe:  totalCr > 0 ? String(soe2) : prev.current_credits_soe,
            // Only pre-fill proposed/description if the draft has them blank
            proposed_name_change: prev.proposed_name_change || row.course_name || '',
            program_description: prev.program_description || row.course_description || '',
            program_outcomes: (prev.program_outcomes||[]).every(o=>!o.trim()) && Array.isArray(row.student_outcomes) && row.student_outcomes.length
              ? [...row.student_outcomes, '', '']
              : prev.program_outcomes,
          }
        })
      })
  },[])

  const NUMERIC_FIELDS = ['current_credits','proposed_credits','current_credits_lec','current_credits_lab','current_credits_soe','proposed_credits_lec','proposed_credits_lab','proposed_credits_soe']

  const handleSave = async (extra={}) => {
    setSaving(true)
    const merged = { ...data, ...extra }
    const pid = merged.revision_id || ('REV-'+Date.now()+'-'+Math.random().toString(36).slice(2,7).toUpperCase())
    const payload = { ...merged, revision_id: pid,
      updated_at: new Date().toISOString(), updated_by: user?.email||'',
      created_by: merged.created_by||user?.email||'' }
    NUMERIC_FIELDS.forEach(f=>{
      if(payload[f]===''||payload[f]===undefined) payload[f]=null
      else if(payload[f]!==null) payload[f]=parseFloat(payload[f])||null
    })
    const { error } = await supabase.from('course_revisions').upsert(payload,{onConflict:'revision_id'}).select()
    setSaving(false)
    if(error){ toast.error('Save failed: '+error.message); return false }
    if(!data.revision_id) setData(p=>({...p,revision_id:pid,created_by:user?.email||''}))
    toast.success('Saved!')
    return true
  }

  // ─── Delete draft ────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!data.revision_id) { onClose(); return }   // never saved — just close
    setDeleting(true)
    const { error } = await supabase.from('course_revisions').delete().eq('revision_id', data.revision_id).select()
    setDeleting(false)
    if (error) { toast.error('Delete failed: '+error.message); return }
    toast.success('Draft deleted.')
    onClose()
  }

  const handleDownload = async () => {
    setDl(true)
    try {
      await handleSave()
      const docxBlob = await buildRevisionDocx(data)
      const slug = data.course_id?.replace(/\s/g,'') || 'program_revision'
      await patchAndDownload(docxBlob, `${slug}_revision.docx`)
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
    toast.success('✓ Approved! Program revision stamped and saved.')
    onClose()
  }

  const stepContent = () => {
    switch(step) {
      case 1: return <Step1 data={data} update={update}/>
      case 2: return <Step2 data={data} update={update}/>
      case 3: return <Step3 data={data} update={update}/>
      case 4: return <Step4 data={data} update={update}/>
      case 5: return <Step5 data={data} update={update} catalog={catalog}/>
      case 6: return <Step6 data={data} status={data.status} saving={saving} downloading={dl}
                      onDownload={handleDownload} onApprove={handleApprove}/>
      default: return null
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-rose-50 rounded-lg flex items-center justify-center">
              <FileEdit size={16} className="text-rose-600"/>
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">Course / Program Revision</h2>
              <p className="text-xs text-surface-400">
                {data.course_id?`${data.course_id} · `:''}
                {STEPS[step-1].desc}
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
            {step<STEPS.length&&(
              <button onClick={goNext}
                className="flex items-center gap-1.5 px-5 py-2 text-sm font-semibold bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors">
                Next <ChevronRight size={15}/>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
