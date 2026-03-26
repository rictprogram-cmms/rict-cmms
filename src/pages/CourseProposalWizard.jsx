import { useState, useCallback, useEffect } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, ShadingType, BorderStyle,
  UnderlineType, PageBreak, Header, ImageRun,
} from 'docx'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  X, ChevronRight, ChevronLeft, Plus, Trash2, Save, Download,
  FileText, Check, AlertCircle, CheckCircle2, Loader2,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ─── SCTCC Logo (embedded PNG, 150px wide, extracted from official document) ──
const SCTCC_LOGO_B64 = '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'

function b64ToUint8Array(b64) {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

// ─── Default SCTCC College Outcomes & Competencies ───────────────────────────
export const DEFAULT_COLLEGE_OUTCOMES = [
  {
    outcome: 'Demonstrate Personal & Social Accountability',
    competencies: [
      'Demonstrate personal and professional growth',
      'Develop skills for better physical and emotional health',
      'Demonstrate teamwork and collaboration',
      'Model and uphold ethical, legal, and moral responsibility',
    ],
  },
  {
    outcome: 'Think Critically',
    competencies: [
      'Synthesize and evaluate information',
      'Articulate and justify ideas',
      'Create innovative solutions',
      'Use analytical, deductive, and inductive reasoning',
      'Develop mathematical and scientific reasoning',
      'Employ reflective thinking to assimilate, relate, and adapt',
    ],
  },
  {
    outcome: 'Communicate Effectively',
    competencies: [
      'Demonstrate effective listening',
      'Comprehend and critique written material',
      'Convey ideas and words of others accurately',
      'Practice effective oral communication in interpersonal, group and public settings',
      'Discover, develop, revise, and present ideas in writing',
    ],
  },
  {
    outcome: 'Understand Social & Global Perspectives',
    competencies: [
      'Practice civic involvement and social responsibility',
      'Develop a broader awareness of the impact of economic conditions and political change',
      'Understand and adopt stewardship of the environment',
      'Appreciate and value diversity',
      'Develop and understand social processes and culture',
      'Comprehend human values within an historical and social context through expressions of the arts and the humanities',
    ],
  },
  {
    outcome: 'Apply Knowledge',
    competencies: [
      'Compare and contrast approaches to knowledge and skills acquisition',
      'Assess alternatives to improve, design, or creatively solve a problem or situation',
      'Develop technological competence for personal and/or career application',
      'Manage time and other resources efficiently and effectively',
      'Research and manage information effectively',
    ],
  },
]

// ─── Hook: load college outcomes from Supabase (falls back to defaults) ───────
function useCollegeOutcomes() {
  const [outcomes, setOutcomes] = useState(DEFAULT_COLLEGE_OUTCOMES)
  useEffect(() => {
    supabase.from('settings')
      .select('setting_value')
      .eq('setting_key', 'college_outcomes_list')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.setting_value) {
          try { setOutcomes(JSON.parse(data.setting_value)) } catch {}
        }
      })
  }, [])
  return outcomes
}


// ─── Steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Basic Info',    desc: 'Faculty, program, division' },
  { id: 2, label: 'Course ID',     desc: 'Title, credits, justification' },
  { id: 3, label: 'Outcomes A',    desc: 'Section A learning outcomes' },
  { id: 4, label: 'MnTC B–D',      desc: 'Transfer curriculum (if applicable)' },
  { id: 5, label: 'Outline',       desc: 'Description, topics, materials' },
  { id: 6, label: 'Prerequisites', desc: 'CIP, prereqs, grading method' },
  { id: 7, label: 'Review',        desc: 'Review, save & download' },
]

const GOAL_AREAS = [
  '1 \u2013 Written & Oral Communication',
  '2 \u2013 Critical Thinking',
  '3 \u2013 Natural Sciences',
  '4 \u2013 Mathematical',
  '5 \u2013 History & The Social & Behavioral Sciences',
  '6 \u2013 The Humanities \u2013 Arts, Literature & Philosophy',
  '7 \u2013 Human Diversity',
  '8 \u2013 Global Perspective',
  '9 \u2013 Ethical & Civic Responsibility',
  '10 \u2013 People & The Environment',
]

const EMPTY = {
  proposal_id: null,
  faculty_name: '', proposal_date: new Date().toLocaleDateString('en-US'),
  program: 'Robotics & Industrial Controls', department: 'Energy & Electronics',
  division: 'Technology', effective_term: '', course_max: '',
  course_title: '', course_subject: '', course_number: '',
  total_credits: '', lecture_credits: '', lab_credits: '', soe_credits: '0',
  content_offered_elsewhere: false, content_elsewhere_explanation: '',
  justification: '',
  learning_outcomes: [
    { outcome: '', assessment: '', college_outcome: '' },
    { outcome: '', assessment: '', college_outcome: '' },
    { outcome: '', assessment: '', college_outcome: '' },
  ],
  is_mntc: false, mntc_goal_areas: [], mntc_goal_area_descriptions: '',
  mntc_competencies: [
    { goal_area: '', student_outcome: '', assessment: '' },
    { goal_area: '', student_outcome: '', assessment: '' },
    { goal_area: '', student_outcome: '', assessment: '' },
  ],
  checked_with_registrar: false, registrar_staff_name: '',
  cip_code: '', min_prereq_gpa: 'none', prerequisites: '',
  corequisites: '', major_restriction: false, major_restriction_list: '',
  suggested_background: '', course_description: '',
  course_outcomes: ['', '', ''], course_topics: ['', '', ''],
  suggested_materials: '', grading_method: 'letter', status: 'draft',
}

// ─── DOCX helpers ─────────────────────────────────────────────────────────────
const TH   = { style: BorderStyle.SINGLE, size: 4,  color: '000000' }
const TH_B = { top: TH, bottom: TH, left: TH, right: TH }
const NO   = { style: BorderStyle.NONE,   size: 0,  color: 'FFFFFF' }
const NO_B = { top: NO, bottom: NO, left: NO, right: NO }
const GRAY  = { fill: 'D9D9D9', type: ShadingType.CLEAR, color: 'auto' }
const CM    = { top: 60, bottom: 60, left: 80, right: 80 }
// page margin matches original: narrow sides, moderate top
const MARGIN = { top: 720, right: 1080, bottom: 720, left: 1080 }
const FW = 12240 - MARGIN.left - MARGIN.right  // 10080 DXA content width

const dr  = (text, x={}) => new TextRun({ text: String(text||''), ...x })
const drb = (text, x={}) => new TextRun({ text: String(text||''), bold: true, ...x })
const dru = (text, bold=false) => new TextRun({ text: String(text||''), bold, underline: { type: UnderlineType.SINGLE } })
const dp  = (ch, opts={}) => new Paragraph({ children: Array.isArray(ch) ? ch : [typeof ch==='string' ? dr(ch) : ch], ...opts })
const dsp = (b=120) => new Paragraph({ children: [dr('')], spacing: { before: b, after: 0 } })

// ─── Logo header (rendered on every page) ────────────────────────────────────
function makeLogoHeader(logoData) {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [
          new ImageRun({
            data: logoData,
            transformation: { width: 157, height: 93 }, // matches original: 1.631" x 0.971"
            type: 'png',
          })
        ]
      })
    ]
  })
}

// ─── Page 1: gray info box ────────────────────────────────────────────────────
function makeInfoBox(d) {
  const h = FW / 2
  const row = (l1, v1, l2, v2) => new TableRow({ children: [
    new TableCell({ borders: NO_B, shading: GRAY, width: { size: h, type: WidthType.DXA }, margins: CM,
      children: [dp([drb(l1+' '), dr(v1||'')])] }),
    new TableCell({ borders: NO_B, shading: GRAY, width: { size: h, type: WidthType.DXA }, margins: CM,
      children: [dp([drb(l2+' '), dr(v2||'')])] }),
  ]})
  return new Table({
    width: { size: FW, type: WidthType.DXA }, columnWidths: [h, h],
    borders: { top: TH, bottom: TH, left: TH, right: TH,
               insideH: { style: BorderStyle.NONE, size: 0 },
               insideV: { style: BorderStyle.NONE, size: 0 } },
    rows: [
      row('Faculty Proposing:', d.faculty_name, 'Date:', d.proposal_date),
      row('Program:', d.program, 'Department:', d.department),
      row('Division:', d.division, 'Effective Term (1 year out) :', d.effective_term),
      new TableRow({ children: [
        new TableCell({ columnSpan: 2, borders: NO_B, shading: GRAY,
          width: { size: FW, type: WidthType.DXA }, margins: CM,
          children: [dp([drb('Course Maximum'), dr(' (determined at program level) : '), dr(d.course_max ? String(d.course_max) : '')])] })
      ]})
    ]
  })
}

// ─── SLO Table (Section A) ────────────────────────────────────────────────────
function makeSloTable(rows=[]) {
  const cw = [Math.round(FW*0.4), Math.round(FW*0.3), FW-Math.round(FW*0.4)-Math.round(FW*0.3)]
  const hRow = new TableRow({ children:
    ['Student Learning\nOutcome','Assessment','College\nOutcome/Competency'].map((h,i) =>
      new TableCell({ borders: TH_B, shading: GRAY, width:{size:cw[i],type:WidthType.DXA}, margins:CM,
        children:[dp([drb(h,{size:18})],{alignment:AlignmentType.CENTER})] }))
  })
  const dRows = Array.from({length: Math.max(5, rows.length)}, (_,i) => {
    const r = rows[i]||{}
    return new TableRow({ children:[
      new TableCell({borders:TH_B,width:{size:cw[0],type:WidthType.DXA},margins:CM,children:[dp(r.outcome||'')]}),
      new TableCell({borders:TH_B,width:{size:cw[1],type:WidthType.DXA},margins:CM,children:[dp(r.assessment||'')]}),
      new TableCell({borders:TH_B,width:{size:cw[2],type:WidthType.DXA},margins:CM,children:[dp(r.college_outcome||'')]}),
    ]})
  })
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:cw, rows:[hRow,...dRows] })
}

// ─── Goal Areas 2-col table (Section B) ──────────────────────────────────────
function makeGoalAreasTable(sel=[]) {
  const h = FW/2
  const mkCell = i => new TableCell({ borders:NO_B, width:{size:h,type:WidthType.DXA},
    margins:{top:30,bottom:30,left:60,right:60},
    children:[dp([dr((sel.includes(i+1)?'\u2611':'\u25a1')+' '+GOAL_AREAS[i])])] })
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[h,h],
    borders:{top:NO,bottom:NO,left:NO,right:NO,insideH:NO,insideV:NO},
    rows:[0,1,2,3,4].map(i=>new TableRow({children:[mkCell(i),mkCell(i+5)]})) })
}

// ─── MnTC Competency table (Section D) ───────────────────────────────────────
function makeMntcTable(rows=[]) {
  const cw = [Math.round(FW*0.33), Math.round(FW*0.37), FW-Math.round(FW*0.33)-Math.round(FW*0.37)]
  const hRow = new TableRow({ children:
    ['Goal Area\nCompetency','Student Learning\nOutcome','Assessment'].map((h,i) =>
      new TableCell({borders:TH_B,shading:GRAY,width:{size:cw[i],type:WidthType.DXA},margins:CM,
        children:[dp([drb(h,{size:18})],{alignment:AlignmentType.CENTER})]}))
  })
  const dRows = Array.from({length: Math.max(5, rows.length)}, (_,i) => {
    const r = rows[i]||{}
    return new TableRow({children:[
      new TableCell({borders:TH_B,width:{size:cw[0],type:WidthType.DXA},margins:CM,children:[dp(r.goal_area||'')]}),
      new TableCell({borders:TH_B,width:{size:cw[1],type:WidthType.DXA},margins:CM,children:[dp(r.student_outcome||'')]}),
      new TableCell({borders:TH_B,width:{size:cw[2],type:WidthType.DXA},margins:CM,children:[dp(r.assessment||'')]}),
    ]})
  })
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:cw, rows:[hRow,...dRows] })
}

// ─── Page 3: Proposal Signature Page ─────────────────────────────────────────
function makeProposalSigTable(d) {
  const c1=Math.round(FW*0.52), c2=FW-Math.round(FW*0.52)
  const subj = [d.course_subject, d.course_number].filter(Boolean).join(' ') || '____________'
  const sigRow = (label, opt1, opt2) => new TableRow({children:[
    new TableCell({borders:TH_B,width:{size:c1,type:WidthType.DXA},margins:{top:400,bottom:400,left:80,right:80},
      children:[dp([dr(label)])]}),
    new TableCell({borders:TH_B,width:{size:c2,type:WidthType.DXA},margins:CM,children:[
      dp([dr(opt1+' \u2022'), dr('   '), dr('Not '+opt2+' \u2022')],{spacing:{before:80}}),
      dp(''),
      dp([drb('Date:')],{spacing:{before:80}}),
    ]}),
  ]})
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[c1,c2], rows:[
    new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
        margins:{top:60,bottom:60,left:80,right:80},children:[
          dp([drb('New Course Proposal Signature Page')],{alignment:AlignmentType.CENTER}),
          dp([dr('Subject/Number: '+subj)],{alignment:AlignmentType.CENTER,spacing:{before:40}}),
        ]})
    ]}),
    new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,width:{size:FW,type:WidthType.DXA},margins:CM,children:[
        dp([dr('Instructors Impacted:'), dr('     '), dr('Comments (if any):')]),
        dp(''),dp(''),dp(''),dp(''),dp(''),
      ]}),
    ]}),
    sigRow('Dean:', 'Recommended', 'Recommended'),
    sigRow('AASC Chair:', 'Passed', 'Passed'),
    sigRow('V.P. Academic Affairs:', 'Approved', 'Approved'),
    new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,width:{size:FW,type:WidthType.DXA},
        margins:{top:80,bottom:80,left:80,right:80},children:[
          dp([dr('Person submitting a new course to AASC and appropriate academic dean shall be')],{alignment:AlignmentType.CENTER}),
          dp([dr('at the AASC meeting when the new course is reviewed.')],{alignment:AlignmentType.CENTER,spacing:{before:40}}),
          dp([drb('ALL INFORMATION MUST BE COMPLETE.')],{alignment:AlignmentType.CENTER,spacing:{before:80}}),
        ]})
    ]}),
  ]})
}

// ─── Page 4: Course Outline header box ───────────────────────────────────────
function makeCourseOutlineBox(d) {
  const subj = [d.course_subject, d.course_number].filter(Boolean).join(' ') || ''
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[FW],
    rows:[new TableRow({children:[
      new TableCell({borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
        margins:{top:80,bottom:80,left:120,right:120},children:[
          dp([drb('St. Cloud Technical & Community College',{size:28})],
            {alignment:AlignmentType.CENTER,spacing:{before:40,after:40}}),
          // %%HIGHLIGHT%% markers are patched to yellow after zip generation
          dp([dr('%%HIGHLIGHT%%NEW Course%%ENDHIGHLIGHT%%',{bold:true,size:24}), drb(' Outline',{size:24})],
            {alignment:AlignmentType.CENTER,spacing:{before:0,after:80}}),
          dp([drb('Course Subject and Number: '), dr(subj)]),
          dp([drb('Course Title: '), dru(d.course_title||'')],{spacing:{before:60,after:40}}),
        ]})
    ]})]
  })
}

// ─── Page 7: Course Outline Signature Page ───────────────────────────────────
function makeOutlineSigTable(d) {
  const c1=Math.round(FW*0.38), c2=FW-Math.round(FW*0.38)
  const subj = [d.course_subject, d.course_number].filter(Boolean).join(' ') || ''
  const grayHdr = text => new TableRow({children:[
    new TableCell({columnSpan:2,borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
      margins:{top:40,bottom:40,left:80,right:80},
      children:[dp([drb(text)],{alignment:AlignmentType.CENTER})]})
  ]})
  const sigRow = (label, opt1, opt2) => new TableRow({children:[
    new TableCell({borders:TH_B,width:{size:c1,type:WidthType.DXA},margins:{top:400,bottom:400,left:80,right:80},
      children:[dp([drb(label)])]}),
    new TableCell({borders:TH_B,width:{size:c2,type:WidthType.DXA},margins:CM,children:[
      dp([drb(opt1+' '), dr('\u25a1'), drb('   '+opt2+' '), dr('\u25a1')],{spacing:{before:80}}),
      dp(''),
      dp([drb('Date:')],{spacing:{before:80}}),dp(''),
    ]}),
  ]})
  return new Table({ width:{size:FW,type:WidthType.DXA}, columnWidths:[c1,c2], rows:[
    new TableRow({children:[
      new TableCell({borders:TH_B,width:{size:c1,type:WidthType.DXA},margins:CM,
        children:[dp([drb('Course Outline Signature Page')])]}),
      new TableCell({borders:TH_B,width:{size:c2,type:WidthType.DXA},margins:CM,
        children:[dp([drb('Subject/Number: '), dr(subj)])]}),
    ]}),
    new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},margins:CM,
        children:[dp([drb('OFFICIAL USE ONLY')])]})
    ]}),
    grayHdr('Dean Action'),
    sigRow('Dean:', 'Recommended', 'Not Recommended'),
    grayHdr('AASC Action'),
    sigRow('AASC Chairperson:', 'Passed', 'Not Passed'),
    grayHdr('Vice President Action'),
    sigRow('Vice President:', 'Approved', 'Not Approved'),
    new TableRow({children:[
      new TableCell({columnSpan:2,borders:TH_B,shading:GRAY,width:{size:FW,type:WidthType.DXA},
        margins:{top:120,bottom:120,left:80,right:80},children:[dp('')]})
    ]}),
  ]})
}

// ─── Policy text ──────────────────────────────────────────────────────────────
const ACAD_INTEGRITY = `Academic integrity is highly valued at St. Cloud Technical & Community College and throughout higher education. Maintaining academic integrity is the responsibility of every member of the college community: faculty, staff, administrators, and students. Academic integrity requires students to refrain from engaging in or tolerating acts including, but not limited to, submitting false academic records, cheating, plagiarizing, altering, forging, or misusing a college academic record; acquiring or using test materials without faculty permission; acting alone or in cooperation with another to falsify records or to obtain dishonest grades, honors, or awards.

Any violation of the St. Cloud Technical & Community College's Academic Integrity Policy S3.28 is considered a disciplinary offense and will be subject to the policies of this instructor, entrance into the Academic Integrity Database, and possible disciplinary action as outlined in the Academic Integrity Procedure S3.28.1. Students accused of academic dishonesty may appeal the decision. Students may review the Academic Integrity process and access the Academic Integrity Appeal Form at https://www.sctcc.edu/academic-integrity.`

const ACCOMMODATIONS = `St. Cloud Technical & Community College is committed to supporting students with disabilities in obtaining, understanding, and advocating for equitable and inclusive access in all aspects of their education and campus life. It is the role of Accessibility Services to provide and/or arrange reasonable accommodations to qualified students who have a disability (or have acquired a disability) during any point of their tenure at SCTCC. Accommodations are established through collaboration between students, Accessibility Services, faculty, and staff to empower students to pursue their academic goals free from barriers while upholding the integrity of the academic experience.

Disabilities take on several forms including but not limited to mental health, cognitive, learning, behavioral, chronic health/systemic, and physical.

If you have a disability (or think you may have a disability) contact Accessibility Services at 320-308-5064 or acc@sctcc.edu to establish an accommodation plan.

It is the responsibility of the student requesting accommodations to provide their instructor with their accommodation plan via email. It is encouraged that students with approved accommodations connect with their instructor as soon as they are able, in order to proactively discuss how reasonable accommodation will be implemented in class and/or to address any concerns regarding emergency procedures. Students may submit their plan to faculty at any time during the semester, but accommodations cannot be retroactively applied.

More information and guidelines are available at www.sctcc.edu/accessibility.

This syllabus is available in alternate formats upon request by contacting Accessibility Services at 320-308-5757, 1-800-222-1009, or acc@sctcc.edu. TTY users may call MN Relay Service at 711 to contact the college. Discrimination against individuals on the grounds of disability is prohibited.`

const DIVERSITY = `The entire class will benefit from the wealth of diversity brought by each individual, so you are asked to extend every courtesy and respect that you in turn would expect from the class.

This college is committed to creating a positive, supportive environment, which welcomes diversity of opinions and ideas for students. There will be no tolerance of race discrimination/harassment, sexual discrimination/ harassment, or discrimination/harassment based on age, disability, color, creed, national origin religion, sexual orientation, marital status, status with regard to public assistance or member in a local commission.

Please refer to the Student Handbook for the complete list of Student Rights, Responsibilities, and Procedures.`

function policyParas(text, indent=720) {
  return text.split('\n').filter(l=>l.trim()).map(line=>
    dp([dr(line.trim())], {indent:{left:indent},spacing:{before:60,after:40}}))
}

// ─── Main DOCX generator ─────────────────────────────────────────────────────
async function buildDocx(d) {
  const logoData = b64ToUint8Array(SCTCC_LOGO_B64)
  const gpa = d.min_prereq_gpa || 'none'

  const children = [
    // ══ PAGE 1: Proposal Worksheet ══════════════════════════════════
    // "NEW COURSE" uses %%HIGHLIGHT%% marker — patched to yellow after zip
    dp([dr('%%HIGHLIGHT%%NEW COURSE%%ENDHIGHLIGHT%%',{bold:true,size:28}),
        drb(' PROPOSAL WORKSHEET',{size:28})],
      {alignment:AlignmentType.CENTER,spacing:{before:60,after:80}}),
    dp([drb('Attach Program Outcomes to New Course Proposal')],
      {alignment:AlignmentType.CENTER,spacing:{before:0,after:40}}),
    dp([drb('** Please complete '),dru('ALL',true),drb(' fields **')],
      {alignment:AlignmentType.CENTER,spacing:{before:0,after:120}}),

    makeInfoBox(d),
    dsp(120),

    dp([dru('Proposed Course Title:'),dr(' '+(d.course_title||''))],{spacing:{before:60,after:60}}),
    dp([dru('Proposed Course Subject:'),dr(' '+(d.course_subject||'')+'          '),
        dru('Proposed Course Number:'),dr(' '+(d.course_number||''))],{spacing:{before:0,after:30}}),
    dp([dr('(See registrar or AA office to obtain this number)')],
      {indent:{left:720},spacing:{before:0,after:80}}),

    dp([dr('Total Credits: '),dr(d.total_credits?String(d.total_credits):'_____')],{spacing:{before:60,after:20}}),
    dp([dr('Breakdown of credits')],{spacing:{before:0,after:20}}),
    dp([dr('Lecture Credits: '),dr(d.lecture_credits?String(d.lecture_credits):'___'),dr('    '),
        dr('Lab Credits '),dr(d.lab_credits?String(d.lab_credits):'___'),dr('    '),
        dr('Supervised Occupational Experience '),dru(d.soe_credits!==undefined?String(d.soe_credits):'___')],
      {spacing:{before:0,after:80}}),

    dp([dr('Is the course content offered in another program?')],{spacing:{before:80,after:40}}),
    dp([dr('Yes '),dr(d.content_offered_elsewhere?'\u2611':'\u25a1'),dr('          '),
        dr('No '),dr(!d.content_offered_elsewhere?'\u2611':'\u25a1'),dr('          '),
        dr('If yes; explain: '),dr(d.content_elsewhere_explanation||'_______________________________')],
      {spacing:{before:0,after:120}}),

    dp([dr('Reason(s) / Justification for this NEW Course:')],{spacing:{before:60,after:40}}),
    dp([dr(d.justification||'')],{indent:{left:360},spacing:{before:0,after:120}}),

    dp([dr('\u2022  Complete Section A if course is '),drb('not'),dr(' designed for the Minnesota Transfer Curriculum (MnTC).')],
      {indent:{left:360,hanging:240},spacing:{before:0,after:40}}),
    dp([dr('\u2022  Complete Section B-E if course is designed for the MnTC.')],
      {indent:{left:360,hanging:240},spacing:{before:0,after:160}}),

    dp([drb('A.',{size:22}),drb('   Align each student learning outcome with the assessment method and college outcome/competency:',{size:20})],
      {spacing:{before:80,after:80}}),
    makeSloTable(d.learning_outcomes||[]),
    dsp(60),
    dp([dr('*Actual methods of assessment are at the at the discretion of the instructor')],
      {spacing:{before:40,after:0}}),

    // ══ PAGE 2: Sections B–D + Registrar ════════════════════════════
    new Paragraph({children:[new PageBreak()]}),

    dp([drb('B.',{size:22}),drb('   List Goal Areas (check all that apply)',{size:20})],
      {spacing:{before:80,after:60}}),
    makeGoalAreasTable(d.mntc_goal_areas||[]),
    dsp(100),

    dp([drb('C.',{size:22}),drb('   List Goal Area Description & Competencies',{size:20})],
      {spacing:{before:80,after:60}}),
    dp([dr(d.mntc_goal_area_descriptions||'')],{indent:{left:360},spacing:{before:0,after:120}}),

    dp([drb('D.',{size:22}),drb('   List Competencies for each Goal Area and Align Course Measurable Student Outcomes and methods that will be used to assess each student outcome:',{size:20})],
      {spacing:{before:80,after:80}}),
    makeMntcTable(d.mntc_competencies||[]),
    dsp(120),

    dp([drb('Attach AACCA feedback form or advisory committee minutes in support of the new course')],
      {spacing:{before:80,after:120}}),
    dp([drb('Did you check with Registrar\'s Office?')],{spacing:{before:0,after:40}}),
    dp([drb('Yes:'),dr(d.checked_with_registrar?' \u2713 ':'_____ '),
        drb(' with:'),dr(' '+(d.registrar_staff_name||'_____________')+' '),
        dr('(staff name)'),dr('          '),
        drb('No:'),dr(d.checked_with_registrar?'_____':' \u2713')],
      {spacing:{before:0,after:0}}),

    // ══ PAGE 3: Proposal Signature Page ═════════════════════════════
    new Paragraph({children:[new PageBreak()]}),
    makeProposalSigTable(d),
    dsp(80),
    dp([dr('Revised 8/22/2023')],{alignment:AlignmentType.LEFT,spacing:{before:40,after:0}}),

    // ══ PAGE 4: Course Outline ═══════════════════════════════════════
    new Paragraph({children:[new PageBreak()]}),
    makeCourseOutlineBox(d),
    dsp(80),

    dp([drb('Credits: '),dr(d.total_credits?String(d.total_credits):''),dr('          '),
        drb('Lec: '),dr(d.lecture_credits?String(d.lecture_credits):''),dr('          '),
        drb('Lab: '),dr(d.lab_credits?String(d.lab_credits):''),dr('          '),
        drb('SOE: '),dr(d.soe_credits!==undefined?String(d.soe_credits):'')],
      {spacing:{before:60,after:60}}),

    dp([drb('Minimum Prerequisite GPA:'),dr('   '),
        dr(gpa==='none'?'\u2611':'\u25a1'),dr(' None     '),
        dr(gpa==='2.0'?'\u2611':'\u25a1'),dr(' 2.0     '),
        dr(gpa==='other'?'\u2611':'\u25a1'),dr(' Other     '),
        drb('Prerequisites/Test Scores: '),dr(d.prerequisites||'None')],
      {spacing:{before:0,after:60}}),

    dp([drb('Prerequisites/Test Scores: '),dr('(use \'and\' / \'or\' to clearly define prerequisites):')],
      {spacing:{before:60,after:40}}),
    dp([dr(d.prerequisites||'None')],{indent:{left:360},spacing:{before:0,after:60}}),
    dp([drb('Co-requisites: '),dr(d.corequisites||'None')],{spacing:{before:60,after:60}}),
    dp([drb('CIP Code: '),dr(d.cip_code||'')],{spacing:{before:60,after:60}}),

    dp([drb('Major/s Restriction:   '),
        dr(d.major_restriction?'\u2611':'\u25a1'),drb(' YES'),dr('      '),
        dr(!d.major_restriction?'\u2611':'\u25a1'),drb(' NO')],
      {spacing:{before:60,after:40}}),
    dp([drb('If yes list major/s: '),dr(d.major_restriction?(d.major_restriction_list||''):'')],
      {indent:{left:360},spacing:{before:0,after:60}}),
    dp([drb('Suggested skills or background'),dr(' (default note on course in e-services):')],
      {spacing:{before:60,after:40}}),
    dp([dr(d.suggested_background||'')],{indent:{left:360},spacing:{before:0,after:80}}),

    dsp(40),
    dp([drb('I.  COURSE DESCRIPTION:')],{spacing:{before:60,after:40}}),
    dp([dr(d.course_description||'')],{indent:{left:360},spacing:{before:0,after:80}}),

    dp([drb('II.  STUDENT LEARNING OUTCOMES:')],{spacing:{before:60,after:40}}),
    ...(d.course_outcomes||[]).filter(o=>o&&o.trim()).map(o=>
      dp([dr('\u2022    '+o)],{indent:{left:720,hanging:360},spacing:{before:30,after:0}})),
    ...((d.course_outcomes||[]).filter(o=>o&&o.trim()).length===0
      ?[dp([dr('\u2022')],{indent:{left:720}}),dp([dr('\u2022')],{indent:{left:720}}),dp([dr('\u2022')],{indent:{left:720}})]:[]),
    dsp(40),

    dp([drb('III.  COURSE CONTENT/TOPICS: '),dr('(use list format)')],{spacing:{before:60,after:40}}),
    ...(d.course_topics||[]).filter(t=>t&&t.trim()).map(t=>
      dp([dr('\u2022    '+t)],{indent:{left:720,hanging:360},spacing:{before:30,after:0}})),
    ...((d.course_topics||[]).filter(t=>t&&t.trim()).length===0
      ?[dp([dr('\u2022')],{indent:{left:720}}),dp([dr('\u2022')],{indent:{left:720}}),dp([dr('\u2022')],{indent:{left:720}})]:[]),
    dsp(40),

    dp([drb('IV.  SUGGESTED COURSE MATERIALS:')],{spacing:{before:60,after:40}}),
    dp([dr(d.suggested_materials||'')],{indent:{left:360},spacing:{before:0,after:80}}),

    dp([drb('V.  GRADING METHODS:'),dr('          '),
        dr(d.grading_method==='letter'?'\u2611':'\u25a1'),drb(' Letter Grade')],
      {spacing:{before:60,after:40}}),
    dp([dr(d.grading_method==='pass_fail'?'\u2611':'\u25a1'),drb(' Pass/No Credit (Pass/Fail)')],
      {indent:{left:1080},spacing:{before:0,after:40}}),
    dp([dr(d.grading_method==='developmental'?'\u2611':'\u25a1'),drb(' Developmental')],
      {indent:{left:1080},spacing:{before:0,after:80}}),

    // ══ PAGES 5–6: Course Policies ═══════════════════════════════════
    dp([drb('VI.  COURSE POLICIES/PRACTICES:')],{spacing:{before:80,after:60}}),
    dp([dr('1.'),dr('   '),drb('STATEMENT OF ACADEMIC INTEGRITY:')],
      {indent:{left:360},spacing:{before:40,after:40}}),
    ...policyParas(ACAD_INTEGRITY),
    dsp(60),
    dp([dr('2.'),dr('   '),drb('STATEMENT OF ACCOMMODATIONS:')],
      {indent:{left:360},spacing:{before:40,after:40}}),
    ...policyParas(ACCOMMODATIONS),
    dsp(60),
    dp([dr('3.'),dr('   '),drb('STATEMENT OF DIVERSITY:')],
      {indent:{left:360},spacing:{before:40,after:40}}),
    ...policyParas(DIVERSITY),
    dsp(80),

    dp([drb('VII.  PREPARED BY: '),dr(d.faculty_name||'')],{spacing:{before:80,after:60}}),
    dp([drb('VIII. DATE SUBMITTED: '),dr(d.proposal_date||'')],{spacing:{before:40,after:160}}),

    dp([dr('St. Cloud Technical & Community College is accredited by the Higher Learning Commission')],
      {alignment:AlignmentType.CENTER,spacing:{before:120,after:30}}),
    dp([dr('St. Cloud Technical & Community College is a member of the Minnesota State.')],
      {alignment:AlignmentType.CENTER,spacing:{before:0,after:30}}),
    dp([dr('ADA Accessible Facility \u25CF Affirmative Action/Equal Opportunity Educator and Employer')],
      {alignment:AlignmentType.CENTER,spacing:{before:0,after:0}}),

    // ══ PAGE 7: Outline Signature Page ════════════════════════════════
    new Paragraph({children:[new PageBreak()]}),
    dp([dr('Revised 8-22-2023')],{alignment:AlignmentType.LEFT,spacing:{before:0,after:80}}),
    makeOutlineSigTable(d),
  ]

  const doc = new Document({
    sections: [{
      headers: { default: makeLogoHeader(logoData) },
      properties: {
        page: { size: { width: 12240, height: 15840 }, margin: MARGIN }
      },
      children,
    }]
  })
  return Packer.toBlob(doc)
}

// ─── Yellow highlight patch using fflate (browser-native zip) ─────────────────
// fflate must be installed: npm install fflate
async function patchAndDownload(docxBlob, filename) {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate')
  const buffer = await docxBlob.arrayBuffer()
  const files = unzipSync(new Uint8Array(buffer))
  for (const name of Object.keys(files)) {
    if (!name.endsWith('.xml')) continue
    let xml = strFromU8(files[name])
    if (!xml.includes('%%HIGHLIGHT%%')) continue
    // Case 1: run has rPr — inject highlight into it
    xml = xml.replace(
      /<w:r>(<w:rPr>)([\s\S]*?)<\/w:rPr>(<w:t[^>]*>)%%HIGHLIGHT%%([\s\S]*?)%%ENDHIGHLIGHT%%(<\/w:t>)<\/w:r>/g,
      (_, rO, rI, tO, text, tC) =>
        `<w:r>${rO}${rI}<w:highlight w:val="yellow"/></w:rPr>${tO}${text}${tC}</w:r>`
    )
    // Case 2: run has no rPr — wrap in one
    xml = xml.replace(
      /<w:r>(<w:t[^>]*>)%%HIGHLIGHT%%([\s\S]*?)%%ENDHIGHLIGHT%%(<\/w:t>)<\/w:r>/g,
      (_, tO, text, tC) =>
        `<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr>${tO}${text}${tC}</w:r>`
    )
    files[name] = strToU8(xml)
  }
  const patched = zipSync(files)
  const blob = new Blob([patched],
    {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ─── Step Progress Bar ────────────────────────────────────────────────────────
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
                    ${done || active ? 'bg-brand-600 text-white' : 'bg-surface-100 text-surface-400'}
                    ${active ? 'ring-4 ring-brand-100' : ''}
                    ${unlocked && !active ? 'cursor-pointer hover:scale-110 hover:shadow-sm' : ''}
                    ${!unlocked ? 'cursor-default' : ''}`}>
                  {done ? <Check size={13}/> : step.id}
                </button>
                <span className={`text-[10px] mt-1 whitespace-nowrap font-medium
                  ${active ? 'text-brand-600' : done ? 'text-brand-500' : 'text-surface-300'}`}>
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 mb-4 ${done ? 'bg-brand-600' : 'bg-surface-100'}`}/>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Shared field components ──────────────────────────────────────────────────
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
const inp = 'w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent'
const Inp = ({value,onChange,placeholder,className=''}) => (
  <input value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className={`${inp} ${className}`}/>
)
const Tex = ({value,onChange,placeholder,rows=3}) => (
  <textarea value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows}
    className={`${inp} resize-vertical`}/>
)

// ─── Step 1: Basic Info ───────────────────────────────────────────────────────
function Step1({data,update}) {
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Basic Information</h3>
        <p className="text-xs text-surface-500">Faculty proposing the course and program/department details.</p></div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Faculty Proposing" required><Inp value={data.faculty_name} onChange={v=>update('faculty_name',v)} placeholder="Your name"/></Field>
        <Field label="Proposal Date" required><Inp value={data.proposal_date} onChange={v=>update('proposal_date',v)} placeholder="MM/DD/YYYY"/></Field>
        <Field label="Program" required><Inp value={data.program} onChange={v=>update('program',v)} placeholder="e.g. Robotics & Industrial Controls"/></Field>
        <Field label="Department" required><Inp value={data.department} onChange={v=>update('department',v)} placeholder="e.g. Energy & Electronics"/></Field>
        <Field label="Division" required><Inp value={data.division} onChange={v=>update('division',v)} placeholder="e.g. Technology"/></Field>
        <Field label="Effective Term (1 year out)" required><Inp value={data.effective_term} onChange={v=>update('effective_term',v)} placeholder="e.g. Fall 2027"/></Field>
      </div>
      <Field label="Course Maximum (determined at program level)">
        <Inp value={data.course_max} onChange={v=>update('course_max',v)} placeholder="e.g. 18" className="max-w-xs"/>
      </Field>
    </div>
  )
}

// ─── Step 2: Course ID ────────────────────────────────────────────────────────
function Step2({data,update}) {
  const lec = parseFloat(data.lecture_credits)||0
  const lab = parseFloat(data.lab_credits)||0
  const soe = parseFloat(data.soe_credits)||0
  const total = lec+lab+soe
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Course Identification & Credits</h3>
        <p className="text-xs text-surface-500">Enter the proposed course details and credit breakdown.</p></div>
      <Field label="Proposed Course Title" required><Inp value={data.course_title} onChange={v=>update('course_title',v)} placeholder="e.g. PLC Programming & Automation"/></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Course Subject" required><Inp value={data.course_subject} onChange={v=>update('course_subject',v)} placeholder="e.g. RICT"/></Field>
        <Field label="Course Number"><Inp value={data.course_number} onChange={v=>update('course_number',v)} placeholder="e.g. 2210 (see registrar)"/></Field>
      </div>
      <div className="bg-surface-50 rounded-xl p-4">
        <p className="text-xs font-semibold text-surface-700 mb-3">Credit Breakdown</p>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Total Credits">
            <div className="px-3 py-2 text-sm border border-surface-200 rounded-lg bg-white text-surface-500 text-center font-semibold">{total>0?total:'—'}</div>
          </Field>
          <Field label="Lecture"><Inp value={data.lecture_credits} onChange={v=>update('lecture_credits',v)} placeholder="0"/></Field>
          <Field label="Lab"><Inp value={data.lab_credits} onChange={v=>update('lab_credits',v)} placeholder="0"/></Field>
          <Field label="SOE"><Inp value={data.soe_credits} onChange={v=>update('soe_credits',v)} placeholder="0"/></Field>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-surface-700 mb-2">Is the course content offered in another program?</p>
        <div className="flex gap-6">
          {[true,false].map(v=>(
            <label key={String(v)} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={data.content_offered_elsewhere===v} onChange={()=>update('content_offered_elsewhere',v)} className="accent-brand-600"/>
              <span className="text-sm text-surface-700">{v?'Yes':'No'}</span>
            </label>
          ))}
        </div>
        {data.content_offered_elsewhere&&<div className="mt-2"><Tex value={data.content_elsewhere_explanation} onChange={v=>update('content_elsewhere_explanation',v)} placeholder="Explain..." rows={2}/></div>}
      </div>
      <Field label="Reason(s) / Justification for this NEW Course" required>
        <Tex value={data.justification} onChange={v=>update('justification',v)} placeholder="Describe why this new course is needed..." rows={4}/>
      </Field>
    </div>
  )
}

// ─── Step 3: Section A ────────────────────────────────────────────────────────
function Step3({data,update,collegeOutcomes}) {
  const outcomes = data.learning_outcomes||[]
  const upd = (i,f,v)=>update('learning_outcomes',outcomes.map((r,j)=>j===i?{...r,[f]:v}:r))
  return (
    <div className="space-y-4">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Section A — Student Learning Outcomes</h3>
        <p className="text-xs text-surface-500">Align each outcome with an assessment method and college competency.</p></div>
      <div className="overflow-x-auto rounded-xl border border-surface-200">
        <table className="w-full text-xs">
          <thead><tr className="bg-surface-50 border-b border-surface-200">
            <th className="text-left p-2.5 font-semibold text-surface-700 w-[42%]">Student Learning Outcome</th>
            <th className="text-left p-2.5 font-semibold text-surface-700 w-[25%]">Assessment Method</th>
            <th className="text-left p-2.5 font-semibold text-surface-700 w-[26%]">College Outcome/Competency</th>
            <th className="p-2.5 w-8"></th>
          </tr></thead>
          <tbody>
            {outcomes.map((row,i)=>(
              <tr key={i} className="border-b border-surface-100 last:border-0">
                <td className="p-1.5"><textarea value={row.outcome} onChange={e=>upd(i,'outcome',e.target.value)} rows={2}
                  className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"/></td>
                <td className="p-1.5"><input value={row.assessment} onChange={e=>upd(i,'assessment',e.target.value)}
                  className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"/></td>
                <td className="p-1.5">
                  <select value={row.college_outcome} onChange={e=>upd(i,'college_outcome',e.target.value)}
                    className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                    <option value="">— Select —</option>
                    {collegeOutcomes.map(g=>(
                      <optgroup key={g.outcome} label={g.outcome}>
                        <option value={g.outcome}>{g.outcome}</option>
                        {g.competencies.map(c=>(
                          <option key={c} value={c}>&nbsp;&nbsp;↳ {c}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </td>
                <td className="p-1.5 text-center">{outcomes.length>1&&(
                  <button onClick={()=>update('learning_outcomes',outcomes.filter((_,j)=>j!==i))}
                    className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500 transition-colors"><Trash2 size={13}/></button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={()=>update('learning_outcomes',[...outcomes,{outcome:'',assessment:'',college_outcome:''}])}
        className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium">
        <Plus size={14}/> Add Outcome
      </button>
      <p className="text-xs text-surface-400 italic">*Actual methods of assessment are at the discretion of the instructor</p>
    </div>
  )
}

// ─── Step 4: MnTC B–D ─────────────────────────────────────────────────────────
function Step4({data,update}) {
  const comps = data.mntc_competencies||[]
  const toggleGoal = n=>{
    const a = data.mntc_goal_areas||[]
    update('mntc_goal_areas', a.includes(n)?a.filter(x=>x!==n):[...a,n].sort((a,b)=>a-b))
  }
  const updComp = (i,f,v)=>update('mntc_competencies',comps.map((r,j)=>j===i?{...r,[f]:v}:r))
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">MnTC Sections B–D</h3>
        <p className="text-xs text-surface-500">Complete only if course is designed for the Minnesota Transfer Curriculum.</p></div>
      <label className="flex items-center gap-3 p-3 bg-surface-50 rounded-xl border border-surface-200 cursor-pointer">
        <input type="checkbox" checked={!!data.is_mntc} onChange={e=>update('is_mntc',e.target.checked)} className="w-4 h-4 accent-brand-600"/>
        <div>
          <p className="text-sm font-semibold text-surface-900">This course is designed for the MnTC</p>
          <p className="text-xs text-surface-500">Check to complete Sections B–D</p>
        </div>
      </label>
      {data.is_mntc&&(<>
        <div>
          <label className="block text-xs font-semibold text-surface-700 mb-2">Section B — Goal Areas</label>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {GOAL_AREAS.map((area,i)=>(
              <label key={i} className="flex items-start gap-2 p-2 rounded-lg hover:bg-surface-50 cursor-pointer">
                <input type="checkbox" className="mt-0.5 accent-brand-600"
                  checked={(data.mntc_goal_areas||[]).includes(i+1)} onChange={()=>toggleGoal(i+1)}/>
                <span className="text-xs text-surface-700">{area}</span>
              </label>
            ))}
          </div>
        </div>
        <Field label="Section C — Goal Area Description & Competencies">
          <Tex value={data.mntc_goal_area_descriptions} onChange={v=>update('mntc_goal_area_descriptions',v)} placeholder="Describe goal areas and competencies..." rows={4}/>
        </Field>
        <div>
          <label className="block text-xs font-semibold text-surface-700 mb-2">Section D — Competencies Table</label>
          <div className="overflow-x-auto rounded-xl border border-surface-200">
            <table className="w-full text-xs">
              <thead><tr className="bg-surface-50 border-b border-surface-200">
                <th className="text-left p-2.5 font-semibold text-surface-700 w-[32%]">Goal Area Competency</th>
                <th className="text-left p-2.5 font-semibold text-surface-700 w-[40%]">Student Learning Outcome</th>
                <th className="text-left p-2.5 font-semibold text-surface-700 w-[21%]">Assessment</th>
                <th className="p-2.5 w-8"></th>
              </tr></thead>
              <tbody>
                {comps.map((row,i)=>(
                  <tr key={i} className="border-b border-surface-100 last:border-0">
                    <td className="p-1.5"><textarea value={row.goal_area} onChange={e=>updComp(i,'goal_area',e.target.value)} rows={2}
                      className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"/></td>
                    <td className="p-1.5"><textarea value={row.student_outcome} onChange={e=>updComp(i,'student_outcome',e.target.value)} rows={2}
                      className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"/></td>
                    <td className="p-1.5"><input value={row.assessment} onChange={e=>updComp(i,'assessment',e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"/></td>
                    <td className="p-1.5 text-center">{comps.length>1&&(
                      <button onClick={()=>update('mntc_competencies',comps.filter((_,j)=>j!==i))}
                        className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500"><Trash2 size={13}/></button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={()=>update('mntc_competencies',[...comps,{goal_area:'',student_outcome:'',assessment:''}])}
            className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium mt-2">
            <Plus size={14}/> Add Row
          </button>
        </div>
      </>)}
      {!data.is_mntc&&(
        <div className="text-center py-8 text-surface-400 text-sm">
          <FileText size={28} className="mx-auto mb-2 text-surface-300"/>
          Not applicable — Sections B–D will be left blank on the document.
        </div>
      )}
    </div>
  )
}

// ─── Step 5: Course Outline ───────────────────────────────────────────────────
function Step5({data,update}) {
  const updList = (f,i,v)=>update(f,(data[f]||[]).map((x,j)=>j===i?v:x))
  const addItem = f=>update(f,[...(data[f]||[]),''])
  const delItem = (f,i)=>update(f,(data[f]||[]).filter((_,j)=>j!==i))
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Course Outline</h3>
        <p className="text-xs text-surface-500">Populates the Course Outline section (pages 4–6) of the document.</p></div>
      <Field label="I. Course Description" required>
        <Tex value={data.course_description} onChange={v=>update('course_description',v)} placeholder="Enter the catalog-style course description..." rows={4}/>
      </Field>
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-1.5">II. Student Learning Outcomes <span className="text-red-500">*</span></label>
        <div className="space-y-2">
          {(data.course_outcomes||[]).map((o,i)=>(
            <div key={i} className="flex gap-2 items-start">
              <span className="text-xs text-surface-400 mt-2.5 min-w-[1.25rem] text-center">{i+1}.</span>
              <input value={o} onChange={e=>updList('course_outcomes',i,e.target.value)}
                placeholder={`Outcome ${i+1}…`} className={`flex-1 ${inp}`}/>
              {(data.course_outcomes||[]).length>1&&(
                <button onClick={()=>delItem('course_outcomes',i)}
                  className="p-1.5 hover:bg-red-50 rounded-lg text-surface-300 hover:text-red-500 transition-colors mt-0.5"><Trash2 size={14}/></button>
              )}
            </div>
          ))}
        </div>
        <button onClick={()=>addItem('course_outcomes')} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium mt-2">
          <Plus size={14}/> Add Outcome
        </button>
      </div>
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-1.5">III. Course Content / Topics <span className="text-red-500">*</span></label>
        <div className="space-y-2">
          {(data.course_topics||[]).map((t,i)=>(
            <div key={i} className="flex gap-2 items-center">
              <span className="text-xs text-surface-400 min-w-[1.25rem] text-center">{i+1}.</span>
              <input value={t} onChange={e=>updList('course_topics',i,e.target.value)}
                placeholder={`Topic ${i+1}…`} className={`flex-1 ${inp}`}/>
              {(data.course_topics||[]).length>1&&(
                <button onClick={()=>delItem('course_topics',i)}
                  className="p-1.5 hover:bg-red-50 rounded-lg text-surface-300 hover:text-red-500 transition-colors"><Trash2 size={14}/></button>
              )}
            </div>
          ))}
        </div>
        <button onClick={()=>addItem('course_topics')} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium mt-2">
          <Plus size={14}/> Add Topic
        </button>
      </div>
      <Field label="IV. Suggested Course Materials">
        <Tex value={data.suggested_materials} onChange={v=>update('suggested_materials',v)} placeholder="Required textbooks, lab kits, software, etc." rows={3}/>
      </Field>
    </div>
  )
}

// ─── Step 6: Prerequisites & Grading ─────────────────────────────────────────
function Step6({data,update}) {
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-bold text-surface-900 mb-1">Prerequisites, Restrictions & Grading</h3>
        <p className="text-xs text-surface-500">Complete the remaining Course Outline fields.</p></div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="CIP Code"><Inp value={data.cip_code} onChange={v=>update('cip_code',v)} placeholder="e.g. 15.0405"/></Field>
        <Field label="Minimum Prerequisite GPA">
          <select value={data.min_prereq_gpa} onChange={e=>update('min_prereq_gpa',e.target.value)}
            className={inp}>
            <option value="none">None</option>
            <option value="2.0">2.0</option>
            <option value="other">Other</option>
          </select>
        </Field>
      </div>
      <Field label="Prerequisites / Test Scores">
        <Tex value={data.prerequisites} onChange={v=>update('prerequisites',v)}
          placeholder="Use 'and' / 'or' to clearly define. e.g. RICT 1110 with grade of C or better" rows={2}/>
      </Field>
      <Field label="Co-requisites">
        <Inp value={data.corequisites} onChange={v=>update('corequisites',v)} placeholder="e.g. None"/>
      </Field>
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-2">Major/s Restriction</label>
        <div className="flex gap-6 mb-2">
          {[true,false].map(v=>(
            <label key={String(v)} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={data.major_restriction===v} onChange={()=>update('major_restriction',v)} className="accent-brand-600"/>
              <span className="text-sm text-surface-700">{v?'Yes — restricted':'No restriction'}</span>
            </label>
          ))}
        </div>
        {data.major_restriction&&(
          <Inp value={data.major_restriction_list} onChange={v=>update('major_restriction_list',v)} placeholder="List restricted major(s)..."/>
        )}
      </div>
      <Field label="Suggested Skills or Background">
        <Tex value={data.suggested_background} onChange={v=>update('suggested_background',v)} placeholder="Default note for students in e-services..." rows={2}/>
      </Field>
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-2">V. Grading Method</label>
        <div className="space-y-2">
          {[{val:'letter',label:'Letter Grade'},{val:'pass_fail',label:'Pass/No Credit (Pass/Fail)'},{val:'developmental',label:'Developmental'}].map(opt=>(
            <label key={opt.val} className="flex items-center gap-2.5 cursor-pointer">
              <input type="radio" value={opt.val} checked={data.grading_method===opt.val}
                onChange={()=>update('grading_method',opt.val)} className="accent-brand-600"/>
              <span className="text-sm text-surface-700">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex gap-2">
        <AlertCircle size={15} className="text-amber-500 mt-0.5 shrink-0"/>
        <div>
          <p className="text-xs font-semibold text-amber-800">Registrar Check</p>
          <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
            <input type="checkbox" checked={!!data.checked_with_registrar} onChange={e=>update('checked_with_registrar',e.target.checked)} className="accent-brand-600"/>
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

// ─── Step 7: Review & Actions ─────────────────────────────────────────────────
function Step7({data,status,saving,downloading,onDownload,onApprove}) {
  const courseLabel = [data.course_subject,data.course_number,data.course_title].filter(Boolean).join(' ')
  const statusCfg = {
    draft:     {bg:'bg-surface-100',text:'text-surface-600',label:'Draft'},
    submitted: {bg:'bg-blue-50',text:'text-blue-700',label:'Submitted for Review'},
    approved:  {bg:'bg-emerald-50',text:'text-emerald-700',label:'Approved'},
    rejected:  {bg:'bg-red-50',text:'text-red-700',label:'Rejected'},
  }[status]||{bg:'bg-surface-100',text:'text-surface-600',label:'Draft'}
  const rows=[
    {label:'Faculty',value:data.faculty_name},
    {label:'Program',value:data.program},
    {label:'Course',value:courseLabel||'(not set)'},
    {label:'Credits',value:data.total_credits?`${(parseFloat(data.lecture_credits)||0)+(parseFloat(data.lab_credits)||0)+(parseFloat(data.soe_credits)||0)} total (${data.lecture_credits||0} Lec / ${data.lab_credits||0} Lab / ${data.soe_credits||0} SOE)`:'(not set)'},
    {label:'Effective Term',value:data.effective_term},
    {label:'Outcomes (A)',value:`${(data.learning_outcomes||[]).filter(r=>r.outcome).length} entered`},
    {label:'Course Topics',value:`${(data.course_topics||[]).filter(t=>t.trim()).length} entered`},
    {label:'MnTC',value:data.is_mntc?`Yes — ${(data.mntc_goal_areas||[]).length} goal area(s)`:'No'},
    {label:'Grading',value:data.grading_method==='letter'?'Letter Grade':data.grading_method==='pass_fail'?'Pass/No Credit':'Developmental'},
  ]
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h3 className="text-base font-bold text-surface-900 mb-1">Review & Actions</h3>
          <p className="text-xs text-surface-500">Verify your entries, download the Word document, and mark as approved to add to the Syllabus Generator.</p></div>
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${statusCfg.bg} ${statusCfg.text}`}>{statusCfg.label}</span>
      </div>
      <div className="bg-surface-50 rounded-xl border border-surface-200 overflow-hidden">
        {rows.map((r,i)=>(
          <div key={i} className={`flex gap-4 px-4 py-2.5 text-sm ${i%2===0?'bg-white':'bg-surface-50'}`}>
            <span className="text-surface-500 w-32 shrink-0">{r.label}</span>
            <span className="text-surface-900 font-medium">{r.value||<span className="text-surface-300 italic">—</span>}</span>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <p className="text-xs font-semibold text-surface-600 uppercase tracking-wider">Actions</p>
        <button onClick={onDownload} disabled={downloading||!data.course_title}
          className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm">
          {downloading
            ?<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Generating…</>
            :<><Download size={16}/>Download Word Document (.docx)</>}
        </button>
        <p className="text-xs text-surface-400 text-center">Generates the complete 7-page SCTCC proposal form with logo, exactly matching the official format.</p>
        <div className="flex gap-3 pt-1">
          {status!=='approved'&&(
            <button onClick={onApprove} disabled={saving||!data.course_title}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold rounded-xl hover:bg-emerald-100 transition-colors disabled:opacity-40">
              <CheckCircle2 size={14}/> Mark as Approved
            </button>
          )}
          {status==='approved'&&(
            <div className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold rounded-xl">
              <CheckCircle2 size={14}/> ✓ Approved — Available in Syllabus Generator
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
export default function CourseProposalWizard({ onClose, initialData=null }) {
  const { user } = useAuth()
  const [step, setStep]       = useState(1)
  const [maxStep, setMaxStep] = useState(() => initialData?.proposal_id ? STEPS.length : 1)

  const goNext = () => {
    const next = Math.min(step + 1, STEPS.length)
    setStep(next)
    setMaxStep(m => Math.max(m, next))
  }
  const [data, setData]       = useState(() => {
    if (!initialData) return { ...EMPTY }
    return {
      ...EMPTY, ...initialData,
      learning_outcomes: Array.isArray(initialData.learning_outcomes) ? initialData.learning_outcomes : EMPTY.learning_outcomes,
      mntc_goal_areas:   Array.isArray(initialData.mntc_goal_areas)   ? initialData.mntc_goal_areas   : [],
      mntc_competencies: Array.isArray(initialData.mntc_competencies) ? initialData.mntc_competencies : EMPTY.mntc_competencies,
      course_outcomes:   Array.isArray(initialData.course_outcomes)   ? initialData.course_outcomes   : EMPTY.course_outcomes,
      course_topics:     Array.isArray(initialData.course_topics)     ? initialData.course_topics     : EMPTY.course_topics,
    }
  })
  const [saving,        setSaving]        = useState(false)
  const [dl,            setDl]            = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const collegeOutcomes        = useCollegeOutcomes()

  const update = useCallback((f,v) => setData(p=>({...p,[f]:v})), [])

  const computeTotal = (d) => {
    const t = (parseFloat(d.lecture_credits)||0)+(parseFloat(d.lab_credits)||0)+(parseFloat(d.soe_credits)||0)
    return t > 0 ? t : d.total_credits
  }

  const handleSave = async (extra={}) => {
    setSaving(true)
    const merged = { ...data, ...extra, total_credits: computeTotal({...data,...extra}) }
    const pid = merged.proposal_id || ('PROP-'+Date.now()+'-'+Math.random().toString(36).slice(2,7).toUpperCase())

    // Coerce empty strings to null for all numeric columns so Postgres doesn't choke
    const NUMERIC_FIELDS = ['total_credits','lecture_credits','lab_credits','soe_credits','course_max']
    const payload = { ...merged, proposal_id: pid,
      updated_at: new Date().toISOString(), updated_by: user?.email||'',
      created_by: merged.created_by||user?.email||'' }
    NUMERIC_FIELDS.forEach(f => {
      if (payload[f] === '' || payload[f] === undefined) payload[f] = null
      else if (payload[f] !== null) payload[f] = parseFloat(payload[f]) || null
    })

    const { error } = await supabase.from('course_proposals').upsert(payload,{onConflict:'proposal_id'}).select()
    setSaving(false)
    if (error) { toast.error('Save failed: '+error.message); return false }
    if (!data.proposal_id) setData(p=>({...p,proposal_id:pid,created_by:user?.email||''}))
    toast.success('Saved!')
    return true
  }

  // ─── Delete draft ────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!data.proposal_id) { onClose(); return }   // never saved — just close
    setDeleting(true)
    const { error } = await supabase.from('course_proposals').delete().eq('proposal_id', data.proposal_id).select()
    setDeleting(false)
    if (error) { toast.error('Delete failed: '+error.message); return }
    toast.success('Draft deleted.')
    onClose()
  }

  const handleDownload = async () => {
    setDl(true)
    try {
      await handleSave()
      const merged = { ...data, total_credits: computeTotal(data) }
      const blob = await buildDocx(merged)
      const slug = [data.course_subject, data.course_number].filter(Boolean).join('_') || 'course_proposal'
      await patchAndDownload(blob, `${slug}_proposal.docx`)
      toast.success('Document downloaded!')
    } catch(err) {
      console.error(err)
      toast.error('Generation failed: '+err.message)
    } finally { setDl(false) }
  }

  const handleSubmit = async () => {
    const ok = await handleSave({ status:'submitted', submitted_at:new Date().toISOString(), submitted_by:user?.email })
    if (ok) { setData(p=>({...p,status:'submitted'})); toast.success('Submitted for approval!') }
  }

  const handleApprove = async () => {
    const ok = await handleSave({ status:'approved', approved_at:new Date().toISOString(), approved_by:user?.email })
    if (!ok) return
    setData(p=>({...p,status:'approved'}))
    // Build course_id with no space to match syllabus_courses format (e.g. "RICT2850")
    const courseId = [data.course_subject, data.course_number].filter(Boolean).join('')
    const labCr = parseFloat(data.lab_credits) || 0
    if (courseId) {
      // Only use columns confirmed to exist in syllabus_courses
      // (matches the fields used by the Syllabus Wizard's own "Add Course" form)
      const { data: row, error } = await supabase.from('syllabus_courses').upsert({
        course_id:          courseId,
        course_name:        data.course_title || '',
        credits_lecture:    parseFloat(data.lecture_credits) || 0,
        credits_lab:        labCr,
        credits_soe:        parseFloat(data.soe_credits) || 0,
        required_hours:     labCr * 2,
        status:             'active',
        course_description: data.course_description || '',
        student_outcomes:   (data.course_outcomes || []).filter(o => o && o.trim()),
        learning_outcomes:  (data.learning_outcomes || []).filter(r => r.outcome && r.outcome.trim()),
        prerequisites:      data.prerequisites || '',
        cip_code:           data.cip_code || '',
        suggested_skills:   data.suggested_skills || '',
        course_topics:      (data.course_topics || []).filter(t => t && t.trim()),
        suggested_materials: data.suggested_materials || '',
        grading_method:     data.grading_method || 'letter',
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'course_id' }).select().single()
      if (error) {
        console.error('syllabus_courses upsert error:', error)
        toast.error('Approved but catalog update failed: ' + error.message)
        return
      }
      console.log('Added to syllabus_courses:', row)
    }
    toast.success('✓ Approved! "' + courseId + '" is now in the Syllabus Generator. Close and reopen the Syllabus wizard to see it.')
  }

  const stepContent = () => {
    switch(step) {
      case 1: return <Step1 data={data} update={update}/>
      case 2: return <Step2 data={data} update={update}/>
      case 3: return <Step3 data={data} update={update} collegeOutcomes={collegeOutcomes}/>
      case 4: return <Step4 data={data} update={update}/>
      case 5: return <Step5 data={data} update={update}/>
      case 6: return <Step6 data={data} update={update}/>
      case 7: return <Step7 data={data} status={data.status} saving={saving} downloading={dl}
                      onDownload={handleDownload} onApprove={handleApprove}/>
      default: return null
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-violet-50 rounded-lg flex items-center justify-center">
              <FileText size={16} className="text-violet-600"/>
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">New Course Proposal</h2>
              <p className="text-xs text-surface-400">
                {data.course_title?`${[data.course_subject,data.course_number].filter(Boolean).join(' ')} · `:''}
                {STEPS[step-1].desc}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400"/>
          </button>
        </div>
        {/* Step progress */}
        <div className="pt-4 shrink-0"><StepProgress current={step} maxStep={maxStep} onStep={setStep}/></div>
        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">{stepContent()}</div>
        {/* Footer */}
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
                className="flex items-center gap-1.5 px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors">
                Next <ChevronRight size={15}/>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
