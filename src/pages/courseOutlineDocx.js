/**
 * courseOutlineDocx.js
 *
 * Shared utility for generating Course Outline DOCX documents and
 * print-to-PDF HTML windows.
 *
 * Used by:
 *   - CourseOutlineRevisionWizard.jsx  (page 4 of the full revision package)
 *   - CourseOutlineExportPage.jsx      (standalone outline download)
 *
 * The wizard imports buildCourseOutline and calls it inside its own buildDocx,
 * which adds the page break + rule separator itself.  The export page calls
 * buildStandaloneOutlineDocx / openOutlinePrintWindow directly.
 */
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, ShadingType, BorderStyle, UnderlineType, PageBreak,
} from 'docx'

// ─── Layout constants (US Letter, 1" margins) ─────────────────────────────────
const FW     = 9360   // content width in DXA
const MARGIN = { top: 1440, right: 1440, bottom: 1440, left: 1440 }
const CM     = { top: 60, bottom: 60, left: 100, right: 100 }
const TH     = { style: BorderStyle.SINGLE, size: 4, color: '000000' }
const TH_B   = { top: TH, bottom: TH, left: TH, right: TH }
const LGRAY  = { fill: 'D9D9D9', type: ShadingType.CLEAR }
const GRAY   = { fill: 'BFBFBF', type: ShadingType.CLEAR }
const LINE   = (n) => '_'.repeat(n)

// ─── DOCX paragraph / run helpers ────────────────────────────────────────────
const dp  = (runs, opts = {}) =>
  new Paragraph({ children: Array.isArray(runs) ? runs : [new TextRun(String(runs || ''))], ...opts })
const dr  = (t, o = {}) =>
  new TextRun({ text: String(t || ''), font: 'Arial', size: 20, ...o })
const drb = (t, o = {}) => dr(t, { bold: true, ...o })
const dri = (t, o = {}) => dr(t, { italics: true, ...o })
const dsp = (s) => new Paragraph({ spacing: { before: s, after: 0 }, children: [dr('')] })

// ─── Full SCTCC boilerplate text ──────────────────────────────────────────────
const ACADEMIC_INTEGRITY_TEXT = [
  'Academic integrity is highly valued at St. Cloud Technical & Community College and throughout higher education. Maintaining academic integrity is the responsibility of every member of the college community: faculty, staff, administrators, and students. Academic integrity requires students to refrain from engaging in or tolerating acts including, but not limited to, submitting false academic records, cheating, plagiarizing, altering, forging, or misusing a college academic record; acquiring or using test materials without faculty permission; acting alone or in cooperation with another to falsify records or to obtain dishonest grades, honors, or awards.',
  'Any violation of the St. Cloud Technical & Community College\'s Academic Integrity Policy S3.28 is considered a disciplinary offense and will be subject to the policies of this instructor, entrance into the Academic Integrity Database, and possible disciplinary action as outlined in the Academic Integrity Procedure S3.28.1. Students accused of academic dishonesty may appeal the decision. Students may review the Academic Integrity process and access the Academic Integrity Appeal Form at https://www.sctcc.edu/academic-integrity.',
]

const ACCOMMODATIONS_TEXT = [
  'St. Cloud Technical & Community College is committed to supporting students with disabilities in obtaining, understanding, and advocating for equitable and inclusive access in all aspects of their education and campus life. It is the role of Accessibility Services to provide and/or arrange reasonable accommodations to qualified students who have a disability (or have acquired a disability) during any point of their tenure at SCTCC. Accommodations are established through collaboration between students, Accessibility Services, faculty, and staff to empower students to pursue their academic goals free from barriers while upholding the integrity of the academic experience.',
  'Disabilities take on several forms including but not limited to mental health, cognitive, learning, behavioral, chronic health/systemic, and physical.',
  'If you have a disability (or think you may have a disability) contact Accessibility Services at 320-308-5064 or acc@sctcc.edu to establish an accommodation plan.',
  'It is the responsibility of the student requesting accommodations to provide their instructor with their accommodation plan via email. It is encouraged that students with approved accommodations connect with their instructor as soon as they are able, in order to proactively discuss how reasonable accommodation will be implemented in class and/or to address any concerns regarding emergency procedures. Students may submit their plan to faculty at any time during the semester, but accommodations cannot be retroactively applied.',
  'More information and guidelines are available at www.sctcc.edu/accessibility.',
  'This syllabus is available in alternate formats upon request by contacting Accessibility Services at 320-308-5757, 1-800-222-1009, or acc@sctcc.edu. TTY users may call MN Relay Service at 711 to contact the college. Discrimination against individuals on the grounds of disability is prohibited.',
]

const DIVERSITY_TEXT = [
  'The entire class will benefit from the wealth of diversity brought by each individual, so you are asked to extend every courtesy and respect that you in turn would expect from the class.',
  'This college is committed to creating a positive, supportive environment, which welcomes diversity of opinions and ideas for students. There will be no tolerance of race discrimination/harassment, sexual discrimination/harassment, or discrimination/harassment based on age, disability, color, creed, national origin, religion, sexual orientation, marital status, status with regard to public assistance or membership in a local commission.',
  'Please refer to the Student Handbook for the complete list of Student Rights, Responsibilities, and Procedures.',
]

// ─── GPA checkbox display ─────────────────────────────────────────────────────
function gpaCheckboxLabel(val) {
  if (!val || val === 'none') return 'X None   \u2610 2.0   \u2610 Other'
  if (val === '2.0')          return '\u2610 None   X 2.0   \u2610 Other'
  return `\u2610 None   \u2610 2.0   X Other (${val})`
}

// ─── Grading checkbox display ─────────────────────────────────────────────────
function gradingCheckboxLabel(val) {
  const opts = {
    letter:        'X Letter Grade   \u2610 Pass/No Credit (Pass/Fail)   \u2610 Developmental',
    pass_fail:     '\u2610 Letter Grade   X Pass/No Credit (Pass/Fail)   \u2610 Developmental',
    developmental: '\u2610 Letter Grade   \u2610 Pass/No Credit (Pass/Fail)   X Developmental',
  }
  return opts[val] || opts.letter
}

// ─── Main outline builder ─────────────────────────────────────────────────────
// Returns an array of docx children elements (no leading page break — callers
// are responsible for inserting a page break before these elements when needed,
// e.g. the wizard's buildDocx function).
export function buildCourseOutline(d) {
  const children = []

  // ── Header box ──────────────────────────────────────────────────────────────
  children.push(new Table({
    width: { size: FW, type: WidthType.DXA }, columnWidths: [FW],
    rows: [new TableRow({ children: [
      new TableCell({
        borders: TH_B, shading: LGRAY,
        width: { size: FW, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 160, right: 160 },
        children: [
          dp([drb('St. Cloud Technical & Community College', { size: 24 })], { alignment: AlignmentType.CENTER }),
          dp([drb('Course Outline', { size: 28 })], { alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 } }),
          dp([drb('Course Subject and Number: '), dr(d.outline_course_num || LINE(20)), dr('   '), drb('Course Title: '), dr(d.outline_title || LINE(30))]),
        ],
      }),
    ]})]
  }))
  children.push(dsp(40))

  // ── Credits ─────────────────────────────────────────────────────────────────
  const lec = (d.outline_lec !== undefined && d.outline_lec !== null && d.outline_lec !== '') ? d.outline_lec : '__'
  const lab = (d.outline_lab !== undefined && d.outline_lab !== null && d.outline_lab !== '') ? d.outline_lab : '__'
  const soe = (d.outline_soe !== undefined && d.outline_soe !== null && d.outline_soe !== '') ? d.outline_soe : '__'
  const tot = (parseFloat(d.outline_lec) || 0) + (parseFloat(d.outline_lab) || 0) + (parseFloat(d.outline_soe) || 0)
  children.push(dp([
    drb('Credits: '), dr(String(tot > 0 ? tot : '__')),
    dr('   '), drb('Lec: '), dr(String(lec)),
    dr('   '), drb('Lab: '), dr(String(lab)),
    dr('   '), drb('SOE: '), dr(String(soe)),
  ], { spacing: { before: 60, after: 40 } }))

  // ── GPA / prereqs / other fields ────────────────────────────────────────────
  children.push(dp([drb('Minimum Prerequisite GPA: '), dr(gpaCheckboxLabel(d.outline_min_gpa))], { spacing: { before: 0, after: 40 } }))
  children.push(dp([drb('Prerequisites / Test Scores: '), dr(d.outline_prereqs || LINE(55))], { spacing: { before: 0, after: 40 } }))
  children.push(dp([drb('Co-requisites: '), dr(d.outline_coreqs || 'None')], { spacing: { before: 0, after: 40 } }))
  children.push(dp([drb('CIP Code: '), dr(d.outline_cip_code || LINE(30))], { spacing: { before: 0, after: 40 } }))

  const majorRestrRuns = [drb('Major/s Restriction: '), dr(d.outline_major_restricted ? 'X YES   \u2610 NO' : '\u2610 YES   X NO')]
  if (d.outline_major_restricted && d.outline_majors) {
    majorRestrRuns.push(dr(`   If yes list major/s: ${d.outline_majors}`))
  }
  children.push(dp(majorRestrRuns, { spacing: { before: 0, after: 40 } }))
  children.push(dp([drb('Suggested skills or background (default note on course in e-services): '), dr(d.outline_suggested_skills || LINE(40))], { spacing: { before: 0, after: 60 } }))

  // ══ Block 1: Section I – III ═════════════════════════════════════════════════

  // I. Course Description
  children.push(dp([drb('I.   COURSE DESCRIPTION:')], { spacing: { before: 40, after: 20 } }))
  if (d.outline_description) {
    children.push(dp([dr(d.outline_description)], { indent: { left: 360 }, spacing: { before: 0, after: 60 } }))
  } else {
    ;[LINE(88), LINE(88), LINE(88)].forEach(l =>
      children.push(dp([dr(l)], { indent: { left: 360 }, spacing: { before: 0, after: 20 } })))
    children.push(dsp(40))
  }

  // II. Student Learning Outcomes
  children.push(dp([drb('II.   STUDENT LEARNING OUTCOMES:')], { spacing: { before: 40, after: 20 } }))
  const slos = (d.outline_slos || []).filter(s => String(s || '').trim())
  if (slos.length > 0) {
    slos.forEach(slo => children.push(dp([dr(`* ${slo}`)], { indent: { left: 360 }, spacing: { before: 20, after: 0 } })))
  } else {
    ;['* ' + LINE(80), '* ' + LINE(80), '* ' + LINE(80)].forEach(l =>
      children.push(dp([dr(l)], { indent: { left: 360 }, spacing: { before: 20, after: 0 } })))
  }
  children.push(dsp(40))

  // III. Course Content / Topics
  children.push(dp([drb('III.   COURSE CONTENT / TOPICS: (use list format)')], { spacing: { before: 40, after: 20 } }))
  const topics = (d.outline_topics || []).filter(t => String(t || '').trim())
  if (topics.length > 0) {
    topics.forEach(t => children.push(dp([dr(`\u2022  ${t}`)], { indent: { left: 360 }, spacing: { before: 20, after: 0 } })))
  } else {
    ;['\u2022  ' + LINE(80), '\u2022  ' + LINE(80)].forEach(l =>
      children.push(dp([dr(l)], { indent: { left: 360 }, spacing: { before: 20, after: 0 } })))
  }
  children.push(dsp(40))

  // ══ Block 2: Section I – III (roman numeral restart per template) ════════════

  // I. Suggested Course Materials
  children.push(dp([drb('I.   SUGGESTED COURSE MATERIALS:')], { spacing: { before: 40, after: 20 } }))
  const mats = (d.outline_materials || []).filter(m => String(m || '').trim())
  if (mats.length > 0) {
    mats.forEach(m => children.push(dp([dr(`\u2022  ${m}`)], { indent: { left: 360 }, spacing: { before: 20, after: 0 } })))
  } else {
    children.push(dp([dr('\u2022  ' + LINE(80))], { indent: { left: 360 }, spacing: { before: 20, after: 0 } }))
  }
  children.push(dsp(40))

  // II. Grading Methods
  children.push(dp([drb('II.   GRADING METHODS: '), dr(gradingCheckboxLabel(d.outline_grading))], { spacing: { before: 40, after: 60 } }))

  // III. Course Policies / Practices
  children.push(dp([drb('III.   COURSE POLICIES / PRACTICES:')], { spacing: { before: 40, after: 20 } }))

  // 1. Academic Integrity
  children.push(dp([drb('1.   STATEMENT OF ACADEMIC INTEGRITY:')], { indent: { left: 360 }, spacing: { before: 20, after: 10 } }))
  ACADEMIC_INTEGRITY_TEXT.forEach(para =>
    children.push(dp([dr(para)], { indent: { left: 720 }, spacing: { before: 0, after: 16 } })))
  children.push(dsp(16))

  // 2. Accommodations
  children.push(dp([drb('2.   STATEMENT OF ACCOMMODATIONS:')], { indent: { left: 360 }, spacing: { before: 20, after: 10 } }))
  ACCOMMODATIONS_TEXT.forEach(para =>
    children.push(dp([dr(para)], { indent: { left: 720 }, spacing: { before: 0, after: 16 } })))
  children.push(dsp(16))

  // 3. Diversity
  children.push(dp([drb('3.   STATEMENT OF DIVERSITY:')], { indent: { left: 360 }, spacing: { before: 20, after: 10 } }))
  DIVERSITY_TEXT.forEach(para =>
    children.push(dp([dr(para)], { indent: { left: 720 }, spacing: { before: 0, after: 16 } })))
  children.push(dsp(40))

  // ── Prepared by / Date ───────────────────────────────────────────────────────
  children.push(dp([
    drb('PREPARED BY: '), dr(d.outline_prepared_by || LINE(40)),
    dr('     '), drb('DATE SUBMITTED: '), dr(d.date_submitting || LINE(20)),
  ], { spacing: { before: 60, after: 40 } }))

  // ── SCTCC accreditation footer lines ────────────────────────────────────────
  children.push(dp([dri('St. Cloud Technical & Community College is accredited by the Higher Learning Commission')], { alignment: AlignmentType.CENTER, spacing: { before: 20, after: 4 } }))
  children.push(dp([dri('St. Cloud Technical & Community College is a member of Minnesota State.')], { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 4 } }))
  children.push(dp([dri('ADA Accessible Facility \u2022 Affirmative Action/Equal Opportunity Educator and Employer')], { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 40 } }))

  // ── Official Use / Signature table ──────────────────────────────────────────
  const oW1 = Math.round(FW * 0.5)
  const oW2 = FW - oW1
  const makeRow = (left, right, boldRight = true) =>
    new TableRow({ children: [
      new TableCell({ borders: TH_B, width: { size: oW1, type: WidthType.DXA }, margins: CM, children: [dp([drb(left)])] }),
      new TableCell({ borders: TH_B, width: { size: oW2, type: WidthType.DXA }, margins: CM, children: [dp(boldRight ? [drb(right)] : [dr(right)])] }),
    ]})

  children.push(new Table({
    width: { size: FW, type: WidthType.DXA }, columnWidths: [oW1, oW2],
    rows: [
      makeRow(`Course Outline Signature Page  Subject/Number: ${d.outline_course_num || ''}`, 'OFFICIAL USE ONLY'),
      makeRow('Dean Action', ''),
      makeRow('Dean:', 'Recommended      Not Recommended\n\nDate:'),
      makeRow('AASC Action', ''),
      makeRow('AASC Chairperson:', 'Passed      Not Passed\n\nDate:'),
      makeRow('Vice President Action', ''),
      makeRow('Vice President:', 'Approved      Not Approved\n\nDate:'),
      makeRow('', ''),
    ],
  }))
  children.push(dp([dri('Revised 8-22-2023')], { spacing: { before: 40, after: 0 } }))

  return children
}

// ─── Normalize helpers ────────────────────────────────────────────────────────

/**
 * Convert a syllabus_courses row → the `d` shape expected by buildCourseOutline.
 * Used when no approved revision exists for a course.
 */
export function normalizeCatalogRow(cat) {
  return {
    outline_course_num:       cat.course_id || '',
    outline_title:            cat.course_name || '',
    outline_lec:              cat.credits_lecture != null ? String(cat.credits_lecture) : '',
    outline_lab:              cat.credits_lab    != null ? String(cat.credits_lab)    : '',
    outline_soe:              cat.credits_soe    != null ? String(cat.credits_soe)    : '',
    outline_min_gpa:          'none',
    outline_prereqs:          cat.prerequisites || '',
    outline_coreqs:           '',
    outline_cip_code:         cat.cip_code || '',
    outline_major_restricted: false,
    outline_majors:           '',
    outline_suggested_skills: cat.suggested_skills || '',
    outline_description:      cat.course_description || '',
    outline_slos:             Array.isArray(cat.student_outcomes) ? cat.student_outcomes : [],
    outline_topics:           Array.isArray(cat.course_topics) ? cat.course_topics : [],
    outline_materials:        cat.suggested_materials ? [cat.suggested_materials] : [],
    outline_grading:          cat.grading_method || 'letter',
    outline_prepared_by:      '',
    date_submitting:          '',
  }
}

/**
 * Convert a course_outline_revisions row → the `d` shape expected by buildCourseOutline.
 * The revision table already stores outline_* fields, so this is mostly a safe passthrough
 * with null-guards.
 */
export function normalizeRevisionRow(rev) {
  return {
    outline_course_num:       rev.outline_course_num || rev.current_course_num || '',
    outline_title:            rev.outline_title || '',
    outline_lec:              rev.outline_lec    != null ? String(rev.outline_lec)    : '',
    outline_lab:              rev.outline_lab    != null ? String(rev.outline_lab)    : '',
    outline_soe:              rev.outline_soe    != null ? String(rev.outline_soe)    : '',
    outline_min_gpa:          rev.outline_min_gpa || 'none',
    outline_prereqs:          rev.outline_prereqs || '',
    outline_coreqs:           rev.outline_coreqs  || '',
    outline_cip_code:         rev.outline_cip_code || '',
    outline_major_restricted: !!rev.outline_major_restricted,
    outline_majors:           rev.outline_majors || '',
    outline_suggested_skills: rev.outline_suggested_skills || '',
    outline_description:      rev.outline_description || '',
    outline_slos:             Array.isArray(rev.outline_slos)     ? rev.outline_slos     : [],
    outline_topics:           Array.isArray(rev.outline_topics)   ? rev.outline_topics   : [],
    outline_materials:        Array.isArray(rev.outline_materials) ? rev.outline_materials : (rev.outline_materials ? [rev.outline_materials] : []),
    outline_grading:          rev.outline_grading || 'letter',
    outline_prepared_by:      rev.outline_prepared_by || '',
    date_submitting:          rev.date_submitting || '',
  }
}

// ─── Standalone DOCX builder (no preceding revision pages) ───────────────────
async function buildStandaloneOutlineDocx(d) {
  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: MARGIN } },
      children: buildCourseOutline(d),
    }],
  })
  return Packer.toBlob(doc)
}

// ─── Download: single DOCX ───────────────────────────────────────────────────
export async function downloadOutlineDocx(d, filename) {
  const blob = await buildStandaloneOutlineDocx(d)
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename || `${d.outline_course_num || 'outline'}_Course_Outline.docx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ─── Download: ZIP of multiple DOCX files ────────────────────────────────────
export async function downloadOutlineZip(courses, zipFilename) {
  const { zipSync } = await import('fflate')
  const fileMap = {}

  for (const course of courses) {
    const blob   = await buildStandaloneOutlineDocx(course.outlineData)
    const buffer = await blob.arrayBuffer()
    const safe   = (course.course_id + '_' + course.course_name).replace(/[^a-z0-9_\-]/gi, '_').replace(/_+/g, '_').slice(0, 80)
    fileMap[`${safe}_Course_Outline.docx`] = new Uint8Array(buffer)
  }

  const zipped  = zipSync(fileMap)
  const zipBlob = new Blob([zipped], { type: 'application/zip' })
  const url     = URL.createObjectURL(zipBlob)
  const a       = document.createElement('a')
  a.href        = url
  a.download    = zipFilename || 'Course_Outlines.zip'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ─── Print-to-PDF: open HTML window and trigger browser print dialog ──────────
export function openOutlinePrintWindow(d) {
  const courseNum  = d.outline_course_num || ''
  const title      = d.outline_title || ''
  const lec        = (d.outline_lec !== undefined && d.outline_lec !== null && d.outline_lec !== '') ? d.outline_lec : '—'
  const lab        = (d.outline_lab !== undefined && d.outline_lab !== null && d.outline_lab !== '') ? d.outline_lab : '—'
  const soe        = (d.outline_soe !== undefined && d.outline_soe !== null && d.outline_soe !== '') ? d.outline_soe : '—'
  const tot        = (parseFloat(d.outline_lec) || 0) + (parseFloat(d.outline_lab) || 0) + (parseFloat(d.outline_soe) || 0)
  const prereqs    = d.outline_prereqs || 'None'
  const coreqs     = d.outline_coreqs  || 'None'
  const cip        = d.outline_cip_code || '—'
  const skills     = d.outline_suggested_skills || '—'
  const gpa        = gpaCheckboxLabel(d.outline_min_gpa)
  const majorRestr = d.outline_major_restricted ? 'X YES &nbsp;&nbsp; &#9744; NO' : '&#9744; YES &nbsp;&nbsp; X NO'
  const majorList  = (d.outline_major_restricted && d.outline_majors) ? `&nbsp;&nbsp; If yes list major/s: ${esc(d.outline_majors)}` : ''
  const grading    = {
    letter:        'X Letter Grade &nbsp;&nbsp; &#9744; Pass/No Credit (Pass/Fail) &nbsp;&nbsp; &#9744; Developmental',
    pass_fail:     '&#9744; Letter Grade &nbsp;&nbsp; X Pass/No Credit (Pass/Fail) &nbsp;&nbsp; &#9744; Developmental',
    developmental: '&#9744; Letter Grade &nbsp;&nbsp; &#9744; Pass/No Credit (Pass/Fail) &nbsp;&nbsp; X Developmental',
  }[d.outline_grading] || 'X Letter Grade &nbsp;&nbsp; &#9744; Pass/No Credit (Pass/Fail) &nbsp;&nbsp; &#9744; Developmental'

  const slos   = (d.outline_slos   || []).filter(s => String(s || '').trim())
  const topics = (d.outline_topics || []).filter(t => String(t || '').trim())
  const mats   = (d.outline_materials || []).filter(m => String(m || '').trim())

  const sloHTML   = slos.length   ? slos.map(s   => `<p class="item">* ${esc(s)}</p>`).join('')            : '<p class="blank">* _______________________________________________</p>'
  const topicHTML = topics.length ? topics.map(t => `<p class="item">&bull;&nbsp; ${esc(t)}</p>`).join('') : '<p class="blank">&bull; _______________________________________________</p>'
  const matHTML   = mats.length   ? mats.map(m   => `<p class="item">&bull;&nbsp; ${esc(m)}</p>`).join('') : '<p class="blank">&bull; _______________________________________________</p>'

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function policyHTML(paragraphs) {
    return paragraphs.map(p => `<p class="policy">${esc(p)}</p>`).join('')
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(courseNum)} &ndash; ${esc(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10.5pt;
    line-height: 1.35;
    color: #000;
    background: #fff;
  }
  @media screen {
    body { max-width: 8.5in; margin: 0.4in auto; padding: 1in; box-shadow: 0 0 16px rgba(0,0,0,.18); }
    .print-btn {
      position: fixed; top: 14px; right: 14px; z-index: 999;
      background: #1d4ed8; color: #fff; border: none; border-radius: 8px;
      padding: 10px 22px; font-size: 13px; font-weight: 700; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .print-btn:hover { background: #1e40af; }
  }
  @media print {
    body { margin: 0; padding: 0; }
    .print-btn { display: none !important; }
  }
  @page { size: letter; margin: 1in; }

  .header-box {
    border: 2px solid #000;
    background: #d9d9d9;
    padding: 10px 16px;
    margin-bottom: 10px;
    text-align: center;
  }
  .header-box .college  { font-size: 13pt; font-weight: bold; }
  .header-box .doctype  { font-size: 15pt; font-weight: bold; margin: 3px 0; }
  .header-box .courseid { font-size: 10.5pt; font-weight: bold; text-align: left; margin-top: 4px; }

  .field  { margin: 3px 0; }
  b       { font-weight: bold; }
  .sp     { margin-top: 8px; }

  .sec-head { font-weight: bold; margin: 10px 0 3px; }
  .sub-head { font-weight: bold; margin: 8px 0 3px; padding-left: 24px; }
  .item     { padding-left: 36px; margin: 1px 0; }
  .blank    { padding-left: 36px; margin: 1px 0; }
  .policy   { padding-left: 48px; margin: 2px 0; font-size: 9.5pt; }

  .accred   { text-align: center; font-style: italic; font-size: 9pt; margin: 2px 0; }

  table.sig { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.sig td {
    border: 1.5px solid #000;
    padding: 5px 8px;
    font-weight: bold;
    vertical-align: top;
    width: 50%;
  }
  .revised  { font-style: italic; margin-top: 6px; font-size: 9pt; }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">&#128438; Save as PDF / Print</button>

<div class="header-box">
  <div class="college">St. Cloud Technical &amp; Community College</div>
  <div class="doctype">Course Outline</div>
  <div class="courseid">
    <b>Course Subject and Number:</b> ${esc(courseNum)}
    &nbsp;&nbsp;&nbsp;
    <b>Course Title:</b> ${esc(title)}
  </div>
</div>

<div class="field"><b>Credits:</b> ${tot > 0 ? tot : '__'} &nbsp;&nbsp; <b>Lec:</b> ${esc(String(lec))} &nbsp;&nbsp; <b>Lab:</b> ${esc(String(lab))} &nbsp;&nbsp; <b>SOE:</b> ${esc(String(soe))}</div>
<div class="field"><b>Minimum Prerequisite GPA:</b> ${gpa}</div>
<div class="field"><b>Prerequisites / Test Scores:</b> ${esc(prereqs)}</div>
<div class="field"><b>Co-requisites:</b> ${esc(coreqs)}</div>
<div class="field"><b>CIP Code:</b> ${esc(cip)}</div>
<div class="field"><b>Major/s Restriction:</b> ${majorRestr}${majorList}</div>
<div class="field"><b>Suggested skills or background (default note on course in e-services):</b> ${esc(skills)}</div>
<div class="sp"></div>

<p class="sec-head">I.&nbsp;&nbsp; COURSE DESCRIPTION:</p>
${d.outline_description
  ? `<p class="item">${esc(d.outline_description)}</p>`
  : '<p class="blank">_______________________________________________</p>'}

<p class="sec-head">II.&nbsp;&nbsp; STUDENT LEARNING OUTCOMES:</p>
${sloHTML}

<p class="sec-head">III.&nbsp;&nbsp; COURSE CONTENT / TOPICS: (use list format)</p>
${topicHTML}
<div class="sp"></div>

<p class="sec-head">I.&nbsp;&nbsp; SUGGESTED COURSE MATERIALS:</p>
${matHTML}

<p class="sec-head">II.&nbsp;&nbsp; GRADING METHODS: ${grading}</p>

<p class="sec-head">III.&nbsp;&nbsp; COURSE POLICIES / PRACTICES:</p>

<p class="sub-head">1.&nbsp;&nbsp; STATEMENT OF ACADEMIC INTEGRITY:</p>
${policyHTML(ACADEMIC_INTEGRITY_TEXT)}

<p class="sub-head">2.&nbsp;&nbsp; STATEMENT OF ACCOMMODATIONS:</p>
${policyHTML(ACCOMMODATIONS_TEXT)}

<p class="sub-head">3.&nbsp;&nbsp; STATEMENT OF DIVERSITY:</p>
${policyHTML(DIVERSITY_TEXT)}
<div class="sp"></div>

<div class="field sp">
  <b>PREPARED BY:</b> ${esc(d.outline_prepared_by) || '______________________________'}
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <b>DATE SUBMITTED:</b> ${esc(d.date_submitting) || '________________'}
</div>

<div class="sp"></div>
<p class="accred">St. Cloud Technical &amp; Community College is accredited by the Higher Learning Commission</p>
<p class="accred">St. Cloud Technical &amp; Community College is a member of Minnesota State.</p>
<p class="accred">ADA Accessible Facility &bull; Affirmative Action/Equal Opportunity Educator and Employer</p>

<table class="sig">
  <tr>
    <td>Course Outline Signature Page&nbsp;&nbsp; Subject/Number: ${esc(courseNum)}</td>
    <td>OFFICIAL USE ONLY</td>
  </tr>
  <tr><td colspan="2">Dean Action</td></tr>
  <tr>
    <td>Dean:</td>
    <td>Recommended &nbsp;&nbsp;&nbsp; Not Recommended<br><br>Date:</td>
  </tr>
  <tr><td colspan="2">AASC Action</td></tr>
  <tr>
    <td>AASC Chairperson:</td>
    <td>Passed &nbsp;&nbsp;&nbsp; Not Passed<br><br>Date:</td>
  </tr>
  <tr><td colspan="2">Vice President Action</td></tr>
  <tr>
    <td>Vice President:</td>
    <td>Approved &nbsp;&nbsp;&nbsp; Not Approved<br><br>Date:</td>
  </tr>
  <tr><td>&nbsp;</td><td>&nbsp;</td></tr>
</table>

<p class="revised">Revised 8-22-2023</p>

<script>
  // Auto-trigger print after a short delay so styles render first
  setTimeout(() => window.print(), 700)
</script>
</body>
</html>`

  const win = window.open('', '_blank', 'width=900,height=700')
  if (win) {
    win.document.write(html)
    win.document.close()
  } else {
    alert('Please allow pop-ups for this site to use the PDF / Print feature.')
  }
}
