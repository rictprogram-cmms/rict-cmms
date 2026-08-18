/**
 * syllabusDocx.js
 *
 * Accessible Word (.docx) export for the Syllabus Generator.
 *
 * Why this exists: the browser Print → "Save as PDF" path (Chrome/Chromium)
 * cannot produce a fully tagged PDF — its list items are missing the <Lbl>
 * substructure that accessibility checkers (Anthology Ally in D2L, Adobe
 * Acrobat checker) require, so a print-generated syllabus can never score
 * 100%. Microsoft Word's own "Save As → PDF" export DOES emit complete
 * heading, list, and table tags. This module builds the syllabus as a real
 * Word document with:
 *
 *   - True heading styles (Heading 1–4) for every section level
 *   - Native Word bullet / numbered lists (materials, technology, outcomes,
 *     and any bulleted/numbered lines inside the common policy sections)
 *   - A data table with a marked header row for the assessment points
 *   - Alt text on the college logo and course photo
 *   - Document title / author metadata
 *   - Live hyperlinks (email, Academic Calendar, eServices)
 *
 * Instructors download the .docx, open it in Word, and use
 * File → Save As → PDF to produce the compliant PDF for D2L.
 *
 * Used by: SyllabusWizard.jsx (Step 8 — "Download Accessible Word (.docx)")
 * Patterns follow courseOutlineDocx.js.
 */
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, ShadingType, BorderStyle, HeadingLevel,
  LevelFormat, ExternalHyperlink, ImageRun, Footer, PageNumber, TabStopType,
} from 'docx'

// ─── Layout constants (US Letter, 1" side margins to match the print CSS) ────
const FW     = 9360                                   // content width in DXA
const NAVY   = '1A3A5C'
const LINKBL = '1155CC'
const MARGIN = { top: 1080, right: 1440, bottom: 1296, left: 1440 } // 0.75/1/0.9/1 in

// ─── Run / paragraph helpers (Calibri to match the HTML template) ────────────
const r   = (t, o = {}) => new TextRun({ text: String(t ?? ''), font: 'Calibri', size: 21, ...o })
const rb  = (t, o = {}) => r(t, { bold: true, ...o })
const ri  = (t, o = {}) => r(t, { italics: true, ...o })
const p   = (runs, o = {}) =>
  new Paragraph({ children: Array.isArray(runs) ? runs : [r(runs)], spacing: { after: 100 }, ...o })
const gap = (before = 100) => new Paragraph({ spacing: { before, after: 0 }, children: [r('')] })

const link = (text, url, o = {}) => new ExternalHyperlink({
  link: url,
  children: [new TextRun({ text: String(text), font: 'Calibri', size: 21, color: LINKBL, underline: {}, ...o })],
})

// ─── Heading builders — real Word heading levels, styled like the print CSS ──
const h1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER,
  spacing: { before: 0, after: 60 },
  children: [new TextRun({ text: t, font: 'Calibri', size: 30, bold: true, smallCaps: true, color: '000000' })],
})
const h2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 260, after: 120 }, keepNext: true,
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY, space: 2 } },
  children: [new TextRun({ text: t, font: 'Calibri', size: 23, bold: true, smallCaps: true, color: NAVY })],
})
const h3 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 160, after: 60 }, keepNext: true,
  children: [new TextRun({ text: t, font: 'Calibri', size: 19, bold: true, smallCaps: true, color: NAVY, underline: {} })],
})
const h4 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_4,
  spacing: { before: 120, after: 60 }, keepNext: true,
  children: [new TextRun({ text: t, font: 'Calibri', size: 19, bold: true, color: '000000' })],
})

// ─── List item builders (native Word numbering → tagged <L>/<LI>/<Lbl>) ──────
const INDENT = { left: 460 }
const bullet = (t) => new Paragraph({
  numbering: { reference: 'syl-bullets', level: 0 },
  indent: INDENT, spacing: { after: 40 },
  children: [r(t)],
})
const numbered = (t, instance) => new Paragraph({
  numbering: { reference: 'syl-numbers', level: 0, instance },
  indent: INDENT, spacing: { after: 40 },
  children: [r(t)],
})

// ─── Date formatting (mirrors SyllabusWizard.jsx helpers) ────────────────────
function fmtDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtDateShort(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
}

// ─── Common-section text → docx paragraphs ───────────────────────────────────
// Mirrors renderSection() in SyllabusWizard.jsx: blank lines become spacing,
// "• " lines become native bullets, "1. " lines become native numbered lists
// (each run restarts at 1 via a fresh numbering instance), and ALL-CAPS lines
// become real Heading 4 paragraphs.
function sectionToDocx(text, numCtx) {
  if (!text) return []
  const out = []
  let inNumberList = false
  text.split('\n').forEach(line => {
    const t = line.replace(/\u00a0/g, ' ').trim()
    if (!t) { inNumberList = false; out.push(gap(60)); return }
    if (t.startsWith('\u2022')) { inNumberList = false; out.push(bullet(t.slice(1).trim())); return }
    if (/^\d+\.\s/.test(t)) {
      if (!inNumberList) { numCtx.instance += 1; inNumberList = true }
      out.push(numbered(t.replace(/^\d+\.\s/, ''), numCtx.instance))
      return
    }
    inNumberList = false
    if (t === t.toUpperCase() && t.length > 3) { out.push(h4(t)); return }
    out.push(p(t))
  })
  return out
}

// ─── Image helpers ───────────────────────────────────────────────────────────
// Reads PNG / JPEG pixel dimensions from the byte stream so images keep their
// aspect ratio without hardcoding sizes.
function getImageSize(bytes, type) {
  try {
    if (type === 'png' && bytes.length > 24) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { w: dv.getUint32(16), h: dv.getUint32(20) }
    }
    if (type === 'jpg') {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let off = 2
      while (off < bytes.length - 9) {
        if (dv.getUint8(off) !== 0xFF) { off += 1; continue }
        const marker = dv.getUint8(off + 1)
        // SOF0–SOF15 (excluding DHT/DAC/RST markers) carry dimensions
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
          return { h: dv.getUint16(off + 5), w: dv.getUint16(off + 7) }
        }
        off += 2 + dv.getUint16(off + 2)
      }
    }
  } catch { /* fall through to default */ }
  return { w: 1, h: 1 }
}

async function fetchImage(url) {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    let type = 'png'
    if (ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g(\?|$)/i.test(url)) type = 'jpg'
    else if (ct.includes('gif') || /\.gif(\?|$)/i.test(url)) type = 'gif'
    const data = new Uint8Array(await res.arrayBuffer())
    const size = getImageSize(data, type)
    return { data, type, ...size }
  } catch {
    return null // image is decorative-adjacent; the document still builds without it
  }
}

// Scale to a target CSS-pixel width, capping height, preserving aspect ratio
function scaleTo(img, targetW, maxH) {
  const ratio = img.h > 0 && img.w > 0 ? img.h / img.w : 1
  let w = targetW
  let h = Math.round(w * ratio)
  if (maxH && h > maxH) { h = maxH; w = Math.round(h / ratio) }
  return { width: w, height: h }
}

// ─── Assessment table (real header row → tagged <TH> cells in the PDF) ───────
function buildGradeTable(assessments, totalPoints) {
  const CW = [4200, 1230]
  const cellB = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8E2F0' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }
  const cell = (children, opts = {}) => new TableCell({
    borders: cellB, margins: { top: 60, bottom: 60, left: 140, right: 140 },
    ...opts, children,
  })
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell([p([new TextRun({ text: 'Assessment', font: 'Calibri', size: 20, bold: true, smallCaps: true, color: 'FFFFFF' })], { spacing: { after: 0 } })], { shading: { fill: NAVY, type: ShadingType.CLEAR }, width: { size: CW[0], type: WidthType.DXA } }),
      cell([p([new TextRun({ text: 'Points', font: 'Calibri', size: 20, bold: true, smallCaps: true, color: 'FFFFFF' })], { alignment: AlignmentType.RIGHT, spacing: { after: 0 } })], { shading: { fill: NAVY, type: ShadingType.CLEAR }, width: { size: CW[1], type: WidthType.DXA } }),
    ],
  })
  const rows = (assessments || []).map((a, i) => {
    const shade = i % 2 === 1 ? { fill: 'F2F5FB', type: ShadingType.CLEAR } : undefined
    const nameRuns = [r(a.name, { size: 20 })]
    if (a.description) nameRuns.push(r(' \u2013 ', { size: 20 }), ri(a.description, { size: 20 }))
    return new TableRow({ children: [
      cell([p(nameRuns, { spacing: { after: 0 } })], { shading: shade, width: { size: CW[0], type: WidthType.DXA } }),
      cell([p([r(a.points > 0 ? `${a.points} pts` : '\u2013', { size: 20 })], { alignment: AlignmentType.RIGHT, spacing: { after: 0 } })], { shading: shade, width: { size: CW[1], type: WidthType.DXA } }),
    ]})
  })
  const totalB = { ...cellB, top: { style: BorderStyle.SINGLE, size: 12, color: NAVY } }
  const totalRow = new TableRow({ children: [
    new TableCell({ borders: totalB, margins: { top: 60, bottom: 60, left: 140, right: 140 }, shading: { fill: 'E6ECF7', type: ShadingType.CLEAR }, width: { size: CW[0], type: WidthType.DXA },
      children: [p([rb('Total Points', { size: 20 })], { spacing: { after: 0 } })] }),
    new TableCell({ borders: totalB, margins: { top: 60, bottom: 60, left: 140, right: 140 }, shading: { fill: 'E6ECF7', type: ShadingType.CLEAR }, width: { size: CW[1], type: WidthType.DXA },
      children: [p([rb(`${totalPoints} pts`, { size: 20 })], { alignment: AlignmentType.RIGHT, spacing: { after: 0 } })] }),
  ]})
  return new Table({
    width: { size: CW[0] + CW[1], type: WidthType.DXA },
    columnWidths: CW,
    rows: [headerRow, ...rows, totalRow],
  })
}

// ─── Main builder ────────────────────────────────────────────────────────────
// data:            the wizard's syllabus state object
// commonSections:  rows from syllabus_common_sections (may be empty)
// defaultSections: DEFAULT_COMMON_SECTIONS from SyllabusWizard.jsx (fallbacks)
// images:          { logo, photo } from fetchImage(), either may be null
export function buildSyllabusDoc(data, commonSections, defaultSections, images = {}) {
  const get = (key) => {
    const row = (commonSections || []).find(s => s.section_key === key)
    return row ? row.content : ((defaultSections || {})[key]?.content || '')
  }
  const numCtx = { instance: 0 } // fresh numbering instance per numbered list

  const totalPoints = (data.assessments || []).reduce((sum, a) => sum + (parseInt(a.points) || 0), 0)
  const aMin = Math.round(totalPoints * data.grading_a_min / 100)
  const bMin = Math.round(totalPoints * data.grading_b_min / 100)
  const cMin = Math.round(totalPoints * data.grading_c_min / 100)
  const creditsTotal = (parseInt(data.credits_lecture) || 0) + (parseInt(data.credits_lab) || 0) + (parseInt(data.credits_soe) || 0)
  const creditsStr = `${creditsTotal} credit${creditsTotal !== 1 ? 's' : ''}: Lecture \u2013 ${data.credits_lecture}, Laboratory \u2013 ${data.credits_lab}, SOE \u2013 ${data.credits_soe}`
  const revisedStr = data.revised_date ? fmtDate(data.revised_date) : ''
  const hasInstructor2 = data.instructor2_enabled && data.instructor2_name
  const timeNote = data.time_commitment_notes || `You should expect to spend two hours outside of class for each hour of lecture and one hour outside of class for each hour of lab. For this course, that means a total expectation of ${(parseInt(data.credits_lecture) || 0) * 2 + (parseInt(data.credits_lab) || 0)} hours per week outside of the classroom. If you do not feel you can fulfill this expectation, you should consider whether this class best fits this term for you.`

  const c = []

  // ── Revised date (top right) ───────────────────────────────────────────────
  c.push(p([r(`Revised: ${revisedStr}`, { size: 17, color: '444444' })], { alignment: AlignmentType.RIGHT, spacing: { after: 120 } }))

  // ── Masthead ───────────────────────────────────────────────────────────────
  // Rendered vertically (logo, college identity, then the centered title)
  // rather than in a side-by-side layout table: layout tables export to PDF as
  // data tables without headers, which accessibility checkers flag.
  if (images.logo) {
    const dims = scaleTo(images.logo, 64)
    c.push(new Paragraph({
      spacing: { after: 40 },
      children: [new ImageRun({
        data: images.logo.data, type: images.logo.type, transformation: dims,
        altText: { title: 'College logo', description: 'St. Cloud Technical & Community College logo', name: 'SCTCC logo' },
      })],
    }))
  }
  c.push(p([rb('St. Cloud Technical & Community College', { size: 19, color: NAVY, allCaps: true })], { spacing: { after: 20 } }))
  c.push(p([ri('A member of Minnesota State', { size: 15, color: '555555' })], { spacing: { after: 40 } }))
  c.push(p([ri('We provide the education, training, and support necessary for equitable participation in our society, economy, and democracy.', { size: 15, color: '555555' })], { spacing: { after: 160 } }))
  c.push(h1(`${data.course_id}: ${data.course_name}`))
  c.push(p([new TextRun({ text: data.semester, font: 'Calibri', size: 21, bold: true, smallCaps: true })], { alignment: AlignmentType.CENTER, spacing: { after: 120 } }))
  c.push(p([rb(`This syllabus is the official course document. The instructor${hasInstructor2 ? 's reserve' : ' reserves'} the right to make changes to this document. Students will be notified when changes are made.`, { size: 19 })], { alignment: AlignmentType.CENTER, spacing: { after: 60 } }))
  c.push(p([r('Instructor Information / Course Information / College Policies & Procedures / Course Policies & Procedures / Grading', { size: 17, color: NAVY })], { alignment: AlignmentType.CENTER, spacing: { after: 160 } }))

  // ── Instructor Information ─────────────────────────────────────────────────
  c.push(h2('Instructor Information'))
  c.push(h3('Office & Office Hours'))
  c.push(p(data.instructor_office))
  c.push(p(data.instructor_office_hours))
  c.push(h3('Contact Information'))
  if (images.photo) {
    const dims = scaleTo(images.photo, 180, 140)
    // Accessibility: prefer the instructor-written alt text; fall back to a
    // generated description so the image always carries alternative text.
    const photoAlt = (data.course_photo_alt || '').trim() || `Course photo for ${data.course_id}: ${data.course_name}`
    c.push(new Paragraph({
      spacing: { after: 60 },
      children: [new ImageRun({
        data: images.photo.data, type: images.photo.type, transformation: dims,
        altText: { title: 'Course photo', description: photoAlt, name: 'Course photo' },
      })],
    }))
  }
  c.push(p(data.instructor_name))
  if (data.instructor_email) c.push(new Paragraph({ spacing: { after: 100 }, children: [link(data.instructor_email, `mailto:${data.instructor_email}`)] }))
  if (data.instructor_phone) c.push(p(data.instructor_phone))
  c.push(p([r('The best way to contact us is by '), rb('email/telephone/text'), r('.')]))
  c.push(p('You can expect a response to email questions within 24 hours Mondays-Thursdays.'))
  if (hasInstructor2) {
    c.push(h3('Co-Instructor Office & Office Hours'))
    c.push(p(data.instructor2_office || ''))
    c.push(p(data.instructor2_office_hours || ''))
    c.push(h3('Co-Instructor Contact'))
    c.push(p(data.instructor2_name))
    if (data.instructor2_email) c.push(new Paragraph({ spacing: { after: 100 }, children: [link(data.instructor2_email, `mailto:${data.instructor2_email}`)] }))
    if (data.instructor2_phone) c.push(p(data.instructor2_phone))
  }

  // ── Course Information ─────────────────────────────────────────────────────
  c.push(h2('Course Information'))
  c.push(h3('General Information'))
  c.push(p([rb(`${data.course_id}: ${data.course_name}`)]))
  c.push(p(creditsStr))
  if (data.course_type === 'online') {
    c.push(p('This is a fully online course. All lectures, assignments, and coursework are completed remotely. There are no required on-campus hours unless otherwise stated by the instructor.'))
  } else if (data.course_type === 'hybrid') {
    c.push(p([r('This is a hybrid course that does not have a designated meeting time. Students are responsible for signing up for their lab hours on a weekly basis. Please review the attendance policy for details. This course requires each student to be on campus for '), rb(`${data.required_hours_per_week} hours a week`), r(', unless otherwise stated by instructor.')]))
    c.push(p('The lecture component of this course is online and is expected to be done outside of class time.'))
  } else {
    c.push(p([r('This course meets at the times listed in eServices. Students are expected to attend all scheduled class sessions. Students are required to be on campus for '), rb(`${data.required_hours_per_week} hours a week`), r('.')]))
  }
  c.push(p(`Begin date: ${fmtDateShort(data.begin_date)} - End date: ${fmtDateShort(data.end_date)}`))
  c.push(new Paragraph({ spacing: { before: 60, after: 100 }, children: [
    link('SCTCC Academic Calendar', 'https://www.sctcc.edu/student-resources/registration/academic-calendar'),
    r(' and '),
    link('eServices', 'https://eservices.minnstate.edu'),
  ]}))
  c.push(p(`Last day to drop and receive full refund is ${fmtDate(data.last_drop_date)}.`))
  c.push(p(`Last day to withdraw with a grade of \u201CW\u201D is ${fmtDate(data.last_withdraw_date)}.`))
  c.push(p('Students not attending class during the first week shall be dropped from the course for non-attendance.'))
  c.push(p('Students who do not meet outlined participation requirements in this class for two consecutive weeks during the semester shall be administratively withdrawn from the class; this action is based on federal financial aid regulations.', { spacing: { before: 60, after: 100 } }))
  if (data.spring_break_start && data.spring_break_end) {
    c.push(p([rb('Spring Break: '), r(`${fmtDate(data.spring_break_start)} \u2013 ${fmtDate(data.spring_break_end)}`)]))
  }
  c.push(h3('Materials'))
  c.push(p([rb('Required')]))
  const materials = (data.required_materials || []).map(m => m.replace(/ \(Part #:.*?\)$/i, '').trim())
  if (materials.length > 0) materials.forEach(m => c.push(bullet(m)))
  else c.push(p('None'))
  c.push(p([rb('Required Technology')], { spacing: { before: 80, after: 100 } }))
  ;(data.required_technology || []).forEach(t => c.push(bullet(t)))
  c.push(p([rb('Suggested Technical Skills')], { spacing: { before: 80, after: 100 } }))
  c.push(p('Microsoft Training is available for free at your convenience.'))
  c.push(h3('Pre/Co-Requisites'))
  c.push(p(data.prerequisites || 'None'))
  if (data.restricted_to) c.push(p(`Restricted to the following major(s): ${data.restricted_to}`))
  c.push(h3('Course Description & Outcomes'))
  c.push(p(data.course_description))
  if ((data.student_outcomes || []).length > 0) {
    c.push(p([rb('Student Learning Outcomes:')]))
    numCtx.instance += 1
    data.student_outcomes.forEach(o => c.push(numbered(o, numCtx.instance)))
  }

  // ── College Policies & Procedures ──────────────────────────────────────────
  c.push(h2('College Policies & Procedures'))
  c.push(h3('Academic Integrity'))
  c.push(...sectionToDocx(get('academic_integrity'), numCtx))
  c.push(h3('Accommodations'))
  c.push(...sectionToDocx(get('accommodations'), numCtx))
  c.push(h3('Nondiscrimination and Title IX'))
  c.push(...sectionToDocx(get('diversity'), numCtx))

  // ── Course Policies & Procedures ───────────────────────────────────────────
  c.push(h2('Course Policies & Procedures'))
  c.push(h3('Attendance'))
  c.push(...sectionToDocx(get('attendance'), numCtx))
  c.push(h3('Navigating D2L & Technical Support'))
  c.push(...sectionToDocx(get('d2l'), numCtx))
  c.push(h3('Class Environment'))
  c.push(...sectionToDocx(get('class_environment'), numCtx))

  // ── Grading ────────────────────────────────────────────────────────────────
  c.push(h2('Grading'))
  c.push(h3('Assignments & Points'))
  if ((parseInt(data.volunteer_hours_required) || 0) > 0) {
    c.push(p([r('All students are expected to put in '), rb(`${data.volunteer_hours_required} hours of volunteer hours`), r('. These hours need to be approved by the instructor. They must support the program. Examples are VEX Robotics tournaments, Ambassador program, Epic, etc.')]))
  }
  c.push(p([r('Weekly attendance \u2013 Your time sheet will need to match up to your signup days for lab. You will need '), rb(`${data.required_hours_per_week} hours a week`), r(' of lab time.')], { spacing: { after: 160 } }))
  c.push(buildGradeTable(data.assessments, totalPoints))
  c.push(p([r('(Subject to change depending on course content)', { size: 17, color: '666666' })], { spacing: { before: 60 } }))
  c.push(h3('Grading Scale'))
  c.push(p(`A = ${data.grading_a_min}\u2013100% = ${aMin}\u2013${totalPoints} points`))
  c.push(p(`B = ${data.grading_b_min}\u2013${data.grading_a_min - 1}% = ${bMin}\u2013${aMin - 1} points`))
  c.push(p(`C = ${data.grading_c_min}\u2013${data.grading_b_min - 1}% = ${cMin}\u2013${bMin - 1} points`))
  c.push(p(`F = ${data.grading_c_min - 1} and below = <${cMin} points`))
  c.push(h3('Grades'))
  c.push(p('You can check your grade through D2L Brightspace ASSESSMENTS/GRADES at any point during the semester.'))
  c.push(p('You can expect to have graded assignments returned within 3\u20135 days of the due date of the assignment.'))
  c.push(p('Your grade will reflect how well you have mastered the material, not how hard you have worked.'))
  c.push(h3('Time Commitment'))
  c.push(p(timeNote))
  c.push(h3('Course Calendar'))
  c.push(p('A detailed schedule is available on D2L. Instructors may adjust or change. Notifications will be given in class prior to change.'))
  if (data.finals_start && data.finals_end) {
    c.push(p(`The Final will be taken the week of ${fmtDateShort(data.finals_start)}\u2013${fmtDateShort(data.finals_end)} during class.`))
  }

  // ── Document footer text (in body, mirroring the print template) ───────────
  const footerLines = String(get('college_footer') || '').split('\n').filter(Boolean)
  c.push(new Paragraph({
    spacing: { before: 320, after: 40 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB', space: 4 } },
    children: [r(footerLines[0] || '', { size: 17, color: '444444' })],
  }))
  footerLines.slice(1).forEach(line => c.push(p([r(line, { size: 17, color: '444444' })], { spacing: { after: 40 } })))
  c.push(p([r(`Template Updated ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`, { size: 17, color: '444444' })], { spacing: { after: 0 } }))

  // ── Page footer: running title + page numbers ──────────────────────────────
  const pageFooter = new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: FW }],
      children: [
        r(`St. Cloud Technical & Community College  ${data.course_id}: ${data.course_name} Course Syllabus`, { size: 15, color: '444444' }),
        new TextRun({ font: 'Calibri', size: 15, color: '444444', children: ['\t', 'Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] }),
      ],
    })],
  })

  return new Document({
    title: `${data.course_id}: ${data.course_name} \u2013 ${data.semester}`,
    description: `Course syllabus for ${data.course_id}: ${data.course_name}, ${data.semester}, St. Cloud Technical & Community College`,
    creator: data.instructor_name || 'SCTCC RICT Program',
    numbering: {
      config: [
        {
          reference: 'syl-bullets',
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 820, hanging: 360 } } },
          }],
        },
        {
          reference: 'syl-numbers',
          levels: [{
            level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 820, hanging: 360 } } },
          }],
        },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: MARGIN } },
      footers: { default: pageFooter },
      children: c,
    }],
  })
}

// ─── Browser download entry point ────────────────────────────────────────────
export async function downloadSyllabusDocx(data, commonSections, defaultSections) {
  const [logo, photo] = await Promise.all([
    fetchImage(data.logo_url),
    fetchImage(data.course_photo_url),
  ])
  const doc = buildSyllabusDoc(data, commonSections, defaultSections, { logo, photo })
  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const sem = String(data.semester || '').replace(/\s+/g, '_')
  a.download = `${data.course_id || 'Course'}_Syllabus_${sem}.docx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
