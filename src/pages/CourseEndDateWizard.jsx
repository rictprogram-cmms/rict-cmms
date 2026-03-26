import { useState, useEffect, useCallback } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle, UnderlineType,
} from 'docx'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  X, ChevronRight, ChevronLeft, Save, Download, Check, AlertCircle,
  CheckCircle2, Search, Plus, Trash2, Calendar, Archive, Loader2,
  BookOpen, Clock,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ─── Steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Select Courses',   desc: 'Choose courses to end-date from the catalog' },
  { id: 2, label: 'End Date Details', desc: 'Last semester offered & effective end date' },
  { id: 3, label: 'Rationale',        desc: 'Reason, student impact & registrar check' },
  { id: 4, label: 'Review',           desc: 'Approvals, download & submit' },
]

const EMPTY = {
  record_id:             null,
  courses:               [],   // [{course_id, course_name, credits, last_semester, effective_end_date}]
  reason:                '',
  student_impact:        '',
  registrar_checked:     '',   // 'yes' | 'no'
  registrar_contact:     '',
  impacted_instructors:  '',
  dean_decision:         '',   // 'recommended' | 'not_recommended'
  dean_date:             '',
  aasc_decision:         '',   // 'passed' | 'not_passed'
  aasc_date:             '',
  vp_decision:           '',   // 'approved' | 'not_approved'
  vp_date:               '',
  status:                'draft',
  created_by:            '',
}

// ─── DOCX Builder — matches official SCTCC form exactly ──────────────────────
async function buildDocx(data) {
  // ── Shorthand helpers ──────────────────────────────────────────────────────
  const TNR  = 'Times New Roman'
  const sp   = { before: 0, after: 0 }
  const nil  = { style: BorderStyle.NIL, size: 0, color: 'auto' }
  const s18  = { style: BorderStyle.SINGLE, size: 18, space: 0, color: '000000' }
  const s4   = { style: BorderStyle.SINGLE, size: 4,  space: 0, color: 'auto' }
  const nilB = { top: nil, bottom: nil, left: nil, right: nil }
  const noM  = { top: 0, bottom: 0, left: 80, right: 80 }

  const r = (text, opts = {}) =>
    new TextRun({ text: text ?? '', font: TNR, size: 22, ...opts })
  const rb = (text, opts = {}) => r(text, { bold: true, ...opts })
  const p  = (children, opts = {}) =>
    new Paragraph({ children, spacing: sp, ...opts })

  // Cell builder: explicit top/bottom/left/right border objects
  const cell = (children, w, { top = nil, bottom = nil, left = nil, right = nil,
    span = 1, vAlign = 'top', height } = {}) => {
    const borders = { top, bottom, left, right }
    const tc = new TableCell({
      borders,
      margins: noM,
      width: { size: w, type: WidthType.DXA },
      children,
      verticalAlign: vAlign,
      ...(span > 1 ? { columnSpan: span } : {}),
    })
    return tc
  }

  // ── Course table (exact XML column widths) ─────────────────────────────────
  const COL = [1980, 3847, 1080, 1890, 2160]  // sum = 10957
  const allBdr = { top: s4, bottom: s4, left: s4, right: s4 }

  const ctCell = (children, i) =>
    new TableCell({ borders: allBdr, margins: noM,
      width: { size: COL[i], type: WidthType.DXA }, children })

  const courses = data.courses || []
  const dataRows = [...courses]
  while (dataRows.length < 7) dataRows.push(null)  // pad to 7 rows

  const coursesTable = new Table({
    columnWidths: COL,
    rows: [
      // Header
      new TableRow({ children: [
        ctCell([p([rb('Course Subject/s and Number/s', { size: 22 })], { alignment: AlignmentType.CENTER })], 0),
        ctCell([p([rb('Course Name/s',                 { size: 22 })], { alignment: AlignmentType.CENTER })], 1),
        ctCell([p([rb('Credits',                       { size: 22 })], { alignment: AlignmentType.CENTER })], 2),
        ctCell([p([rb('Last Semester Offered',         { size: 22 })], { alignment: AlignmentType.CENTER })], 3),
        ctCell([p([rb('Effective Date to End Date Course/s', { size: 22 })], { alignment: AlignmentType.CENTER })], 4),
      ]}),
      // Data rows
      ...dataRows.map((c) =>
        new TableRow({
          height: { value: 504, rule: 'atLeast' },
          children: [
            ctCell([p([r(c?.course_id        || '')])], 0),
            ctCell([p([r(c?.course_name      || '')])], 1),
            ctCell([p([r(c ? String(c.credits ?? '') : '')])], 2),
            ctCell([p([r(c?.last_semester    || '')])], 3),
            ctCell([p([r(c?.effective_end_date || '')])], 4),
          ],
        })
      ),
    ],
  })

  // ── Body table (TableGrid style, 11272 wide, 8 cols) ──────────────────────
  // Columns: 3600, 236, 1312, 2288, 236, 356, 3042, 202 = 11272
  const BCOL = [3600, 236, 1312, 2288, 236, 356, 3042, 202]

  // Full-width cell (span 8 = 11272)
  const fw = (children, borders = nilB, h) =>
    new TableRow({
      ...(h ? { height: { value: h, rule: 'exact' } } : {}),
      children: [cell(children, 11272, { ...borders, span: 8 })],
    })

  // Writing line row: full-width underline, bottom-aligned
  const writeLine = (h, topBdr = nil) =>
    new TableRow({
      height: { value: h, rule: 'exact' },
      children: [cell(
        [p([r('')])],
        11070,
        { top: topBdr, bottom: s18, left: nil, right: nil, span: 7, vAlign: 'bottom' }
      ), cell([p([r('')])], 202)],
    })

  // Registrar line text
  const regContact = data.registrar_contact ? data.registrar_contact : '________________________'
  const regLine = data.registrar_checked === 'yes'
    ? `Did you check with Registrar\u2019s Office?  Yes: \u2611  with: ${regContact} (staff name)  No: ___`
    : data.registrar_checked === 'no'
    ? `Did you check with Registrar\u2019s Office?  Yes: ___  with: ________________________ (staff name)  No: \u2611`
    : `Did you check with Registrar\u2019s Office?  Yes: ___  with: ________________________ (staff name)  No: ___`

  // Impacted instructors text
  const instrText = data.impacted_instructors
    ? `Impacted Instructors\u2019 Signatures:  ${data.impacted_instructors}`
    : `Impacted Instructors\u2019 Signatures:`

  // 3-column signature rows (underline cells): 3600 | 236 | 3900 | 236 | 3300
  const sigRow = (h) =>
    new TableRow({
      height: { value: h, rule: 'exact' },
      children: [
        cell([p([r('')])], 3600,  { bottom: s18, vAlign: 'bottom' }),
        cell([p([r('')])], 236,   { ...nilB }),
        cell([p([r('')])], 3600,  { bottom: s18, span: 2, vAlign: 'bottom' }),
        cell([p([r('')])], 236,   { ...nilB }),
        cell([p([r('')])], 3600,  { bottom: s18, span: 3, vAlign: 'bottom' }),
      ],
    })

  // Approval row pattern: label cell | spacer | Date label
  //   Row A: signature line above  (bottom border only, vAlign bottom)
  //   Row B: label row             (top border on label + Date cols)
  //   Row C: signature line below  (bottom border, vAlign bottom)
  const approvalBlock = (labelText) => [
    // Signature line above
    new TableRow({
      height: { value: 450, rule: 'exact' },
      children: [
        cell([p([r('')])], 5148, { bottom: s18, span: 3, vAlign: 'bottom' }),
        cell([p([r('')])], 2880, { ...nilB, span: 3 }),
        cell([p([r('')])], 3244, { bottom: s18, span: 2, vAlign: 'bottom' }),
      ],
    }),
    // Label row
    new TableRow({
      children: [
        cell([p([rb(`${labelText}   \u25A1   \u25A1`, { size: 22 })])],
          5148, { top: s18, span: 3 }),
        cell([p([r('')])], 2880, { ...nilB, span: 3 }),
        cell([p([rb('Date', { size: 22 })])], 3244, { top: s18, span: 2 }),
      ],
    }),
    // Signature line below
    new TableRow({
      height: { value: 522, rule: 'exact' },
      children: [
        cell([p([r('')])], 5148, { bottom: s18, span: 3, vAlign: 'bottom' }),
        cell([p([r('')])], 2880, { ...nilB, span: 3 }),
        cell([p([r('')])], 3244, { bottom: s18, span: 2, vAlign: 'bottom' }),
      ],
    }),
  ]

  const bodyTable = new Table({
    columnWidths: BCOL,
    rows: [
      // Reason label
      fw([p([rb('Reason for end-dating course(s):', { size: 22 })])], { ...nilB }),
      // Reason writing lines
      new TableRow({
        height: { value: 387, rule: 'exact' },
        children: [cell([p([r(data.reason || '')])], 11272, { bottom: s18, span: 8, vAlign: 'bottom' })],
      }),
      writeLine(405, s18),   // second reason line
      // Student impact label + writing lines
      new TableRow({
        height: { value: 252, rule: 'exact' },
        children: [cell(
          [p([r('')]), p([rb('What, if any, is the student impact?', { size: 22 })])],
          11070, { top: s18, span: 7, vAlign: 'bottom' }
        ), cell([p([r('')])], 202)],
      }),
      writeLine(369),
      writeLine(414, s18),
      // Tiny spacer
      fw([p([r('', { size: 4 })])], { top: s18, bottom: nil, left: nil, right: nil }, 189),
      // Registrar + Instructors block
      fw([
        p([rb(regLine, { size: 22 })]),
        p([r('')]),
        p([rb(instrText, { size: 22 })]),
      ], { ...nilB }),
      // 3 instructor signature line rows
      sigRow(324),
      sigRow(495),
      sigRow(495),
      // Approval blocks
      ...approvalBlock('Dean     Recommended'),
      ...approvalBlock('AASC Chair       Passed'),
      ...approvalBlock('V.P. Academic Affairs     Approved'),
    ],
  })

  // ── Document ────────────────────────────────────────────────────────────────
  const doc = new Document({
    styles: {
      default: { document: { run: { font: TNR, size: 22 } } },
    },
    sections: [{
      properties: {
        page: {
          size:   { width: 12240, height: 15840 },
          margin: { top: 432, right: 576, bottom: 432, left: 576 },
        },
      },
      children: [
        // Title line (matches Heading1 style in original)
        p([
          rb('St. Cloud Technical & Community College', { size: 24 }),
          r('\t', { size: 24 }),
          rb('COURSE END DATE', { size: 36 }),
        ]),
        // Blank paragraph
        p([r('')]),
        // Horizontal rule paragraph
        new Paragraph({
          children: [r('')],
          spacing: sp,
          border: { top: { style: BorderStyle.SINGLE, size: 24, space: 1, color: 'auto' } },
        }),
        coursesTable,
        // Horizontal rule
        new Paragraph({
          children: [r('')],
          spacing: sp,
          border: { top: { style: BorderStyle.SINGLE, size: 24, space: 7, color: 'auto' } },
        }),
        bodyTable,
        // Footer
        p([r('')]),
        p([rb('If the end-dated course is a pre-req for another course, the outline will need to go thru AASC.',
          { size: 22, underline: { type: UnderlineType.SINGLE } })]),
        p([rb('Reminder: Be sure to update your syllabus to reflect changes.',
          { size: 22, underline: { type: UnderlineType.SINGLE } })]),
        p([r('')]),
        p([r('Revised 12/13/2018', { italics: true, size: 20 })]),
      ],
    }],
  })

  return Packer.toBlob(doc)
}

// ─── Progress Bar ──────────────────────────────────────────────────────────────
function StepBar({ step }) {
  return (
    <div className="mb-6">
      {/* Number + connector row */}
      <div className="flex items-center">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center flex-1 min-w-0">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 shrink-0 transition-all ${
              step > s.id
                ? 'bg-emerald-500 border-emerald-500 text-white'
                : step === s.id
                ? 'bg-orange-600 border-orange-600 text-white'
                : 'border-surface-300 bg-white text-surface-400'
            }`}>
              {step > s.id ? <Check size={13} /> : s.id}
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1.5 rounded transition-colors ${step > s.id ? 'bg-emerald-300' : 'bg-surface-200'}`} />
            )}
          </div>
        ))}
      </div>
      {/* Label row — separate line so nothing overlaps */}
      <div className="flex mt-2">
        {STEPS.map(s => (
          <div key={s.id} className="flex-1 min-w-0 pr-2">
            <p className={`text-xs font-semibold leading-tight ${
              step === s.id ? 'text-orange-700' : step > s.id ? 'text-emerald-700' : 'text-surface-400'
            }`}>{s.label}</p>
            <p className="text-[10px] text-surface-400 leading-tight mt-0.5">{s.desc}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Step 1: Select Courses ────────────────────────────────────────────────────
function Step1({ data, update }) {
  const [catalog, setCatalog]   = useState([])
  const [query,   setQuery]     = useState('')
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    setLoading(true)
    supabase.from('syllabus_courses')
      .select('course_id,course_name,credits_lecture,credits_lab,credits_soe,status')
      .eq('status', 'active')
      .order('course_id')
      .then(({ data: rows }) => {
        setCatalog(rows || [])
        setLoading(false)
      })
  }, [])

  const totalCredits = (c) => {
    const l = parseFloat(c.credits_lecture) || 0
    const b = parseFloat(c.credits_lab)     || 0
    const s = parseFloat(c.credits_soe)     || 0
    const tot = l + b + s
    return tot > 0 ? tot : null
  }

  const filtered = catalog.filter(c =>
    !query ||
    c.course_id.toLowerCase().includes(query.toLowerCase()) ||
    c.course_name.toLowerCase().includes(query.toLowerCase())
  )

  const selectedIds = new Set((data.courses || []).map(c => c.course_id))

  const toggle = (cat) => {
    const cur = data.courses || []
    if (selectedIds.has(cat.course_id)) {
      update('courses', cur.filter(c => c.course_id !== cat.course_id))
    } else {
      const credits = totalCredits(cat)
      update('courses', [...cur, {
        course_id:          cat.course_id,
        course_name:        cat.course_name,
        credits:            credits != null ? String(credits) : '',
        last_semester:      '',
        effective_end_date: '',
      }])
    }
  }

  const removeSelected = (id) => update('courses', (data.courses || []).filter(c => c.course_id !== id))

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Select Courses to End-Date</h3>
        <p className="text-sm text-surface-500">Choose one or more courses from the active catalog. Their details will pre-fill the form.</p>
      </div>

      {/* Selected chips */}
      {(data.courses || []).length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
          <p className="text-xs font-semibold text-orange-700 mb-2">Selected ({data.courses.length})</p>
          <div className="flex flex-wrap gap-2">
            {data.courses.map(c => (
              <span key={c.course_id} className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-orange-200 rounded-full text-xs font-medium text-orange-800">
                {c.course_id} — {c.course_name}
                <button onClick={() => removeSelected(c.course_id)} className="hover:text-red-500 transition-colors">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by course ID or name…"
          className="w-full pl-9 pr-3 py-2 text-sm border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/40"
        />
      </div>

      {/* Catalog list */}
      <div className="border border-surface-200 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
        {loading
          ? <div className="flex items-center justify-center py-8 text-surface-400 text-sm gap-2"><Loader2 size={16} className="animate-spin" /> Loading catalog…</div>
          : filtered.length === 0
          ? <div className="py-8 text-center text-sm text-surface-400">No courses match your search.</div>
          : filtered.map(c => {
              const sel = selectedIds.has(c.course_id)
              const cr = totalCredits(c)
              return (
                <button
                  key={c.course_id}
                  onClick={() => toggle(c)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-surface-100 last:border-b-0 transition-colors ${
                    sel ? 'bg-orange-50 hover:bg-orange-100' : 'bg-white hover:bg-surface-50'
                  }`}
                >
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                    sel ? 'bg-orange-500 border-orange-500' : 'border-surface-300'
                  }`}>
                    {sel && <Check size={11} className="text-white" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-surface-700">{c.course_id}</span>
                    <span className="text-xs text-surface-500 ml-2 truncate">{c.course_name}</span>
                  </div>
                  {cr != null && (
                    <span className="text-[10px] text-surface-400 shrink-0">{cr} cr</span>
                  )}
                </button>
              )
            })
        }
      </div>

      {(data.courses || []).length === 0 && (
        <p className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
          <AlertCircle size={13} /> Select at least one course to continue.
        </p>
      )}
    </div>
  )
}

// ─── Step 2: End Date Details ──────────────────────────────────────────────────
function Step2({ data, update }) {
  const updateCourse = useCallback((idx, field, val) => {
    const courses = (data.courses || []).map((c, i) => i === idx ? { ...c, [field]: val } : c)
    update('courses', courses)
  }, [data.courses, update])

  const SEMESTERS = [
    'Fall 2024','Spring 2025','Summer 2025',
    'Fall 2025','Spring 2026','Summer 2026',
    'Fall 2026','Spring 2027','Summer 2027',
  ]

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Last Semester & End Dates</h3>
        <p className="text-sm text-surface-500">For each course, specify the last semester it will be offered and the effective end date.</p>
      </div>

      {(data.courses || []).length === 0 && (
        <p className="text-sm text-surface-400 italic">No courses selected — go back to Step 1.</p>
      )}

      <div className="space-y-4">
        {(data.courses || []).map((c, i) => (
          <div key={c.course_id} className="border border-surface-200 rounded-xl p-4 space-y-3 bg-surface-50">
            <div className="flex items-center gap-2">
              <BookOpen size={14} className="text-orange-500" />
              <span className="text-sm font-bold text-surface-800">{c.course_id}</span>
              <span className="text-sm text-surface-500">— {c.course_name}</span>
              {c.credits && <span className="ml-auto text-xs text-surface-400">{c.credits} credits</span>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-surface-700 mb-1.5">
                  Last Semester Offered <span className="text-red-400">*</span>
                </label>
                <select
                  value={c.last_semester || ''}
                  onChange={e => updateCourse(i, 'last_semester', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500/40 bg-white"
                >
                  <option value="">Select semester…</option>
                  {SEMESTERS.map(s => <option key={s} value={s}>{s}</option>)}
                  <option value="OTHER">Other (type below)</option>
                </select>
                {c.last_semester === 'OTHER' && (
                  <input
                    className="mt-1.5 w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500/40"
                    placeholder="e.g. Spring 2028"
                    value={c.last_semester_custom || ''}
                    onChange={e => updateCourse(i, 'last_semester_custom', e.target.value)}
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-surface-700 mb-1.5">
                  Effective End Date <span className="text-red-400">*</span>
                </label>
                <input
                  type="date"
                  value={c.effective_end_date || ''}
                  onChange={e => updateCourse(i, 'effective_end_date', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500/40 bg-white"
                />
                <p className="text-[10px] text-surface-400 mt-1">
                  On approval, the course will be archived in the catalog on this date.
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {(data.courses || []).some(c => !c.last_semester || !c.effective_end_date) && (
        <p className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
          <AlertCircle size={13} /> Fill in both fields for every course.
        </p>
      )}
    </div>
  )
}

// ─── Step 3: Rationale & Impact ────────────────────────────────────────────────
function Step3({ data, update }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Rationale & Impact</h3>
        <p className="text-sm text-surface-500">Explain why the course(s) are being end-dated and any student considerations.</p>
      </div>

      {/* Reason */}
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-1.5">
          Reason for End-Dating Course(s) <span className="text-red-400">*</span>
        </label>
        <textarea
          rows={4}
          value={data.reason || ''}
          onChange={e => update('reason', e.target.value)}
          placeholder="Describe why this course is being retired…"
          className="w-full px-3 py-2.5 text-sm border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/40 resize-none"
        />
      </div>

      {/* Student impact */}
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-1.5">
          Student Impact <span className="text-red-400">*</span>
        </label>
        <textarea
          rows={4}
          value={data.student_impact || ''}
          onChange={e => update('student_impact', e.target.value)}
          placeholder="Describe any impact on currently enrolled or prospective students…"
          className="w-full px-3 py-2.5 text-sm border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/40 resize-none"
        />
      </div>

      {/* Registrar check */}
      <div className="border border-surface-200 rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-surface-800">Registrar&#39;s Office Consultation</p>
        <div className="flex gap-3">
          {[['yes', 'Yes'], ['no', 'No']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => update('registrar_checked', val)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                data.registrar_checked === val
                  ? 'bg-orange-500 border-orange-500 text-white'
                  : 'bg-white border-surface-200 text-surface-600 hover:border-orange-300'
              }`}
            >
              {data.registrar_checked === val && <Check size={12} />}
              {label}
            </button>
          ))}
        </div>
        {data.registrar_checked === 'yes' && (
          <div>
            <label className="block text-xs font-semibold text-surface-700 mb-1.5">Staff Name / Contact</label>
            <input
              value={data.registrar_contact || ''}
              onChange={e => update('registrar_contact', e.target.value)}
              placeholder="Name of the Registrar's Office staff member consulted"
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500/40"
            />
          </div>
        )}
      </div>

      {/* Impacted instructors */}
      <div>
        <label className="block text-xs font-semibold text-surface-700 mb-1.5">Impacted Instructors</label>
        <textarea
          rows={3}
          value={data.impacted_instructors || ''}
          onChange={e => update('impacted_instructors', e.target.value)}
          placeholder="List any impacted instructors (names)…"
          className="w-full px-3 py-2.5 text-sm border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/40 resize-none"
        />
      </div>
    </div>
  )
}

// ─── Step 4: Review & Download ────────────────────────────────────────────────
function Step4({ data }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-surface-900 mb-1">Review &amp; Download</h3>
        <p className="text-sm text-surface-500">
          Download the Word document, collect physical signatures from the Dean, AASC Chair,
          and VP Academic Affairs, then return here and click <strong>Approve &amp; Archive</strong>.
        </p>
      </div>

      {/* Course summary */}
      <div className="bg-surface-50 border border-surface-200 rounded-xl p-4 space-y-2">
        <p className="text-xs font-semibold text-surface-600 uppercase tracking-wider">Courses to be End-Dated</p>
        <div className="space-y-1.5">
          {(data.courses || []).map(c => (
            <div key={c.course_id} className="flex items-center gap-2 text-sm text-surface-700">
              <BookOpen size={12} className="text-orange-400 shrink-0" />
              <span className="font-semibold">{c.course_id}</span>
              <span className="text-surface-500">— {c.course_name}</span>
              {c.effective_end_date && (
                <span className="ml-auto text-xs text-surface-400 shrink-0 flex items-center gap-1">
                  <Calendar size={10} /> ends {c.effective_end_date}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Approval process */}
      <div className="border border-orange-200 bg-orange-50 rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-orange-800">Approval Process</p>
        <div className="space-y-2">
          {['Download the Word document below.', 'Obtain signatures: Dean, AASC Chair, V.P. Academic Affairs.', 'Return here and click Approve & Archive to retire the course(s) from the catalog.'].map((step, i) => (
            <div key={i} className="flex items-start gap-2.5 text-sm text-orange-700">
              <div className="w-5 h-5 rounded-full bg-orange-200 text-orange-800 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</div>
              <span>{step}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Reminders */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
        <p className="text-xs font-bold text-amber-800">Reminders</p>
        <p className="text-xs text-amber-700">• If this course is a pre-req for another course, the outline will need to go through AASC.</p>
        <p className="text-xs text-amber-700">• Be sure to update your syllabus to reflect these changes.</p>
      </div>
    </div>
  )
}

// ─── Main Wizard ───────────────────────────────────────────────────────────────
export default function CourseEndDateWizard({ initialData, onClose }) {
  const { user } = useAuth()
  const [step,   setStep]   = useState(1)
  const [data,   setData]   = useState(() => ({ ...EMPTY, ...(initialData || {}), created_by: initialData?.created_by || user?.email || '' }))
  const [saving, setSaving] = useState(false)
  const [dl,     setDl]     = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)

  const update = useCallback((field, val) => setData(p => ({ ...p, [field]: val })), [])

  // ─── Validation ─────────────────────────────────────────────────────────────
  const canNext = () => {
    switch (step) {
      case 1: return (data.courses || []).length > 0
      case 2: return (data.courses || []).every(c => c.last_semester && c.effective_end_date)
      case 3: return !!(data.reason?.trim()) && !!(data.student_impact?.trim())
      default: return true
    }
  }

  // ─── Save (draft or approved) ────────────────────────────────────────────────
  const handleSave = async (extra = {}) => {
    setSaving(true)
    const merged = { ...data, ...extra }
    const id = merged.record_id || ('CED-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase())
    const payload = {
      ...merged,
      record_id:  id,
      updated_at: new Date().toISOString(),
      updated_by: user?.email || '',
      created_by: merged.created_by || user?.email || '',
    }
    // Normalise last_semester for display — if 'OTHER', use custom value
    payload.courses = (payload.courses || []).map(c => ({
      ...c,
      last_semester: c.last_semester === 'OTHER' ? (c.last_semester_custom || '') : c.last_semester,
    }))

    const { error } = await supabase
      .from('course_end_dates')
      .upsert(payload, { onConflict: 'record_id' })
      .select()

    setSaving(false)
    if (error) { toast.error('Save failed: ' + error.message); return null }
    if (!data.record_id) setData(p => ({ ...p, record_id: id, created_by: user?.email || '' }))
    toast.success('Saved!')
    return id
  }

  // ─── Download ────────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    setDl(true)
    try {
      await handleSave()
      const blob = await buildDocx(data)
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      const slug = (data.courses || []).map(c => c.course_id).join('_').replace(/\s/g, '') || 'course_end_date'
      a.href     = url
      a.download = `${slug}_end_date.docx`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Document downloaded!')
    } catch (err) {
      console.error(err)
      toast.error('Generation failed: ' + err.message)
    } finally {
      setDl(false)
    }
  }

  // ─── Approve: save as approved + archive courses ─────────────────────────────
  const handleApprove = async () => {
    const id = await handleSave({ status: 'approved', approved_at: new Date().toISOString(), approved_by: user?.email || '' })
    if (!id) return
    setData(p => ({ ...p, status: 'approved' }))

    // Archive courses in syllabus_courses that have reached their end date
    const today = new Date().toISOString().substring(0, 10)
    const toArchiveNow = (data.courses || []).filter(c => {
      const ed = c.effective_end_date || c.last_semester_custom || ''
      return ed && ed <= today
    })

    for (const c of toArchiveNow) {
      const { error } = await supabase
        .from('syllabus_courses')
        .update({ status: 'inactive', updated_at: new Date().toISOString(), updated_by: user?.email || '' })
        .eq('course_id', c.course_id)
        .select()
      if (error) console.warn('Archive failed for', c.course_id, error.message)
    }

    if (toArchiveNow.length > 0) {
      toast.success(`✓ Approved! ${toArchiveNow.length} course(s) archived in catalog.`)
    } else {
      toast.success('✓ Approved! Courses will be archived on their effective end dates.')
    }
    onClose()
  }

  // ─── Delete draft ─────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!data.record_id) { onClose(); return }   // never saved — just close
    setDeleting(true)
    const { error } = await supabase
      .from('course_end_dates')
      .delete()
      .eq('record_id', data.record_id)
      .select()
    setDeleting(false)
    if (error) { toast.error('Delete failed: ' + error.message); return }
    toast.success('Draft deleted.')
    onClose()
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  const isApproved = data.status === 'approved'

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col relative">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center">
              <Archive size={18} className="text-orange-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">Course End Date</h2>
              <p className="text-xs text-surface-400">SCTCC Course End Date Form — {data.record_id || 'New'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isApproved && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-700 text-xs font-semibold rounded-full border border-emerald-200">
                <CheckCircle2 size={12} /> Approved
              </span>
            )}
            {!isApproved && data.status === 'draft' && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 text-amber-700 text-xs font-semibold rounded-full border border-amber-200">
                <Clock size={12} /> Draft
              </span>
            )}
            <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
              <X size={18} className="text-surface-400" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <StepBar step={step} />
          {step === 1 && <Step1 data={data} update={update} />}
          {step === 2 && <Step2 data={data} update={update} />}
          {step === 3 && <Step3 data={data} update={update} />}
          {step === 4 && <Step4 data={data} />}
        </div>

        {/* Footer */}
        <div className="border-t border-surface-100 px-6 py-3.5 flex items-center justify-between shrink-0 gap-2 flex-wrap">
          {/* Left */}
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-600 hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors"
              >
                <ChevronLeft size={14} /> Back
              </button>
            )}
            <button
              onClick={() => handleSave()}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-600 hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors disabled:opacity-40"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save Draft
            </button>
            {/* Delete draft — only show if not approved */}
            {!isApproved && (
              confirmDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-red-600 font-medium">Delete this draft?</span>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-40"
                  >
                    {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                    Yes, delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-2.5 py-1.5 text-xs text-surface-600 hover:bg-surface-100 border border-surface-200 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 hover:bg-red-50 border border-red-100 hover:border-red-200 rounded-lg transition-colors"
                >
                  <Trash2 size={13} /> Delete Draft
                </button>
              )
            )}
          </div>

          {/* Right */}
          <div className="flex items-center gap-2">
            {step === 4 && (
              <>
                <button
                  onClick={handleDownload}
                  disabled={dl}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-surface-700 hover:bg-surface-900 text-white rounded-lg transition-colors disabled:opacity-40"
                >
                  {dl ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Download .docx
                </button>
                {!isApproved && (
                  <button
                    onClick={() => setConfirmApprove(true)}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition-colors disabled:opacity-40"
                  >
                    <Archive size={13} /> Approve &amp; Archive
                  </button>
                )}
              </>
            )}
            {step < 4 && (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canNext()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Approve & Archive confirmation modal ── */}
      {confirmApprove && (
        <div className="absolute inset-0 z-10 bg-black/40 flex items-center justify-center rounded-2xl p-6">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            {/* Icon + title */}
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center shrink-0">
                <Archive size={20} className="text-red-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-surface-900">Approve &amp; Archive Courses</h3>
                <p className="text-sm text-surface-500 mt-0.5">
                  This will permanently retire the following course(s) from the active catalog.
                  This action cannot be undone.
                </p>
              </div>
            </div>

            {/* Course list */}
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-1.5">
              {(data.courses || []).map(c => (
                <div key={c.course_id} className="flex items-center gap-2 text-sm">
                  <BookOpen size={12} className="text-red-400 shrink-0" />
                  <span className="font-semibold text-red-800">{c.course_id}</span>
                  <span className="text-red-600">— {c.course_name}</span>
                  {c.effective_end_date && (
                    <span className="ml-auto text-xs text-red-400 shrink-0">ends {c.effective_end_date}</span>
                  )}
                </div>
              ))}
            </div>

            <p className="text-xs text-surface-500 bg-surface-50 rounded-lg p-2.5 border border-surface-200">
              ⚠️ Courses with an effective end date of today or earlier will be immediately set to
              <strong> inactive</strong>. Future-dated courses will be archived on their effective end date
              (requires a scheduled task, or re-open this record and click Approve again on that date).
            </p>

            {/* Buttons */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setConfirmApprove(false)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold border border-surface-200 text-surface-700 hover:bg-surface-50 rounded-xl transition-colors"
              >
                Cancel — Go Back
              </button>
              <button
                onClick={() => { setConfirmApprove(false); handleApprove() }}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors disabled:opacity-40"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
                Yes, Approve &amp; Archive
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
