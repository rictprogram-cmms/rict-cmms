import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  X, ChevronRight, ChevronLeft, Plus, Trash2,
  BookOpen, Printer, Save, Check, AlertCircle,
  Copy, Upload, RefreshCw, Eye, Clock,
  UserPlus, User, GraduationCap, PlusCircle, Search, Pencil,
  FileText, Download, ChevronUp, ChevronDown
} from 'lucide-react'
import { downloadSyllabusDocx, PASS_FAIL_STATEMENT } from './syllabusDocx'
import toast from 'react-hot-toast'
import { useDialogA11y } from '@/hooks/useDialogA11y'

// ─── Step Definitions ──────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Course',      desc: 'Select or create course' },
  { id: 2, label: 'Instructor',  desc: 'Instructor details' },
  { id: 3, label: 'Course Info', desc: 'Credits & format' },
  { id: 4, label: 'Dates',       desc: 'Semester dates' },
  { id: 5, label: 'Materials',   desc: 'Tools & prerequisites' },
  { id: 6, label: 'Description', desc: 'Outcomes & description' },
  { id: 7, label: 'Grading',     desc: 'Assessment structure' },
  { id: 8, label: 'Preview',     desc: 'Review & export PDF' },
]

const SEMESTERS = [
  'Spring 2026', 'Summer 2026', 'Fall 2026',
  'Spring 2027', 'Summer 2027', 'Fall 2027',
  'Spring 2028', 'Summer 2028', 'Fall 2028',
]

// ─── Default State ─────────────────────────────────────────────────────────────
const EMPTY_SYLLABUS = {
  id: null,
  course_id: '',
  semester: 'Spring 2026',
  instructor_name: '',
  instructor_email: '',
  instructor_phone: '',
  instructor_office: '',
  instructor_office_hours: 'Tuesday – Thursday 8AM – 4PM, needs to be scheduled.',
  instructor2_enabled: false,
  instructor2_name: '',
  instructor2_email: '',
  instructor2_phone: '',
  instructor2_office: '',
  instructor2_office_hours: '',
  logo_url: '',
  course_photo_url: '',   // course-specific photo shown next to contact info in PDF
  course_photo_alt: '',   // instructor-written alt text for the course photo (accessibility)
  course_name: '',
  credits_lecture: 1,
  credits_lab: 1,
  credits_soe: 0,
  course_type: 'hybrid',
  semester_length: '16',        // '16' = full semester, '8' = half semester
  required_hours_per_week: 4,  // auto-calculated: lab_credits × 2 (16wk) or × 4 (8wk)
  revised_date: new Date().toISOString().split('T')[0],
  begin_date: '',
  end_date: '',
  last_drop_date: '',
  last_withdraw_date: '',
  spring_break_start: '',
  spring_break_end: '',
  finals_start: '',
  finals_end: '',
  required_materials: [],
  required_technology: [
    'Active SCTCC email account',
    'Internet access',
    'Microsoft Office Suite',
  ],
  prerequisites: '',
  restricted_to: 'Instrumentation & Process Control AAS',
  course_description: '',
  student_outcomes: [],
  assessments: [
    { id: 1, name: 'Syllabus Quiz',         points: 50,  description: '' },
    { id: 2, name: 'Homework',              points: 400, description: '50 points each, 8 total' },
    { id: 3, name: 'Tests',                 points: 150, description: '2 Total, 75 pts each' },
    { id: 4, name: 'Lab Score',             points: 400, description: 'All labs must be completed' },
    { id: 5, name: 'Participation',         points: 300, description: 'Includes participation and volunteer hours' },
    { id: 6, name: 'Work Order Completion', points: 100, description: '' },
    { id: 7, name: 'Final Exam',            points: 200, description: '' },
  ],
  volunteer_hours_required: 5,
  grading_mode: 'graded',   // 'graded' | 'pass_fail' — pass_fail drops the letter-grade scale
  grading_a_min: 90,
  grading_b_min: 80,
  grading_c_min: 70,
  time_commitment_notes: '',
  pdf_generated_at: null,
  pdf_generated_count: 0,
}

// ─── Default Common Section Content ───────────────────────────────────────────
export const DEFAULT_COMMON_SECTIONS = {
  academic_integrity: {
    title: 'Academic Integrity',
    order: 1,
    content: `Academic integrity is highly valued at St. Cloud Technical & Community College and throughout higher education. Maintaining academic integrity is the responsibility of every member of the college community: faculty, staff, administrators and students. Academic integrity requires students to refrain from engaging in or tolerating acts including, but not limited to, submitting false academic records, cheating, plagiarizing, altering, forging, or misusing a college academic record; acquiring or using test materials without faculty permission; acting alone or in cooperation with another to falsify records or to obtain dishonest grades, honors, or awards.

Any violation of the St. Cloud Technical & Community College's Academic Integrity Policy S3.28 is considered a disciplinary offense and will be subject to the policies of this instructor, entrance into the Academic Integrity Database, and possible disciplinary action as outlined in the Academic Integrity Procedure S3.28.1. Students accused of academic dishonesty may appeal the decision. Students may review the Academic Integrity process and access the Academic Integrity Appeal Form at https://www.sctcc.edu/academic-integrity.

Academic dishonesty in a learning environment could involve:
• Having a tutor or friend complete a portion of your assignments.
• Having a reviewer make extensive revisions to an assignment.
• Copying work submitted by another student.
• Using information from online information services without proper citation.
• Using a paper you have/had written for another class to fulfill an assignment in this class unless you have permission of both instructors.
• Sharing or receiving answers on tests before the test has been completed.

A first instance of academic dishonesty will result in a zero for the assignment and a second instance will result in an "F" grade for the course.`,
  },
  accommodations: {
    title: 'Accommodations',
    order: 2,
    content: `St. Cloud Technical & Community College is committed to supporting students with disabilities in obtaining, understanding, and advocating for equitable and inclusive access in all aspects of their education and campus life. It is the role of Accessibility Services to provide and/or arrange reasonable accommodations to qualified students who have a disability during any point of their tenure at SCTCC. Accommodations are established through collaboration between students, Accessibility Services, faculty, and staff.

Disabilities take on several forms including but not limited to mental health, cognitive, learning, behavioral, chronic health/systemic, and physical.

If you have a disability (or think you may have a disability) contact Accessibility Services at 320-308-5064 or acc@sctcc.edu to establish an accommodation plan.

It is the responsibility of the student requesting accommodations to provide their instructor with their accommodation plan via email. It is encouraged that students with approved accommodations connect with their instructor as soon as possible. Accommodations cannot be retroactively applied.

More information and guidelines are available at www.sctcc.edu/accessibility.

This syllabus is available in alternate formats upon request by contacting Accessibility Services at 320-308-5757, 1-800-222-1009, or acc@sctcc.edu. TTY users may call MN Relay Service at 711 to contact the college. Discrimination against individuals on the grounds of disability is prohibited.`,
  },
  diversity: {
    // NOTE: section_key stays 'diversity' for compatibility with existing
    // syllabus_common_sections rows in the database — only the DISPLAY title
    // changed when the college replaced "Statement of Diversity" with the
    // "Nondiscrimination and Title IX" section (2026 syllabus template update).
    title: 'Nondiscrimination and Title IX',
    order: 3,
    content: `SCTCC is committed to creating a safe, supportive learning and working environment for all members of our campus community.

College policy prohibits discrimination on the basis of age, color, creed, disability, familial status, gender identity, local human rights commission activity, marital status, national origin, public assistance status, race, religion, sex (including pregnancy), and/or sexual orientation in admission and access to, and treatment and employment in, its educational programs and activities. College policy also prohibits sexual misconduct, including dating, intimate partner, and relationship violence; non-forcible sex acts; sexual assault; sexual exploitation; stalking; Title IX sexual harassment and/or related retaliation.`,
  },
  attendance: {
    title: 'Attendance Policy',
    order: 4,
    content: `WEEK 1 REQUIREMENT
Students who do not attend class during the first week of the semester will be dropped from the course for non-attendance.

GENERAL EXPECTATIONS
This program expects 100% participation. Attendance is mandatory to receive a passing grade. Unless special arrangements are made ahead of time, students must attend at least 85% of class sessions or they will receive a failing grade. Arriving late or leaving early will result in being marked absent for the entire class period. School-related events and uncontrollable absences may be excused at the instructor's discretion, but only if pre-notification via email is received.

LAB HOURS & SCHEDULING
• Students must sign up for weekly lab hours using the link in the D2L shell for Robotics & Industrial Controls.
• Signed-up lab hours are mandatory. Students are expected to be present for the hours they select.
• Students who fail to follow their self-selected schedule will receive a warning. Continued failure to follow the schedule will result in assignment to the fixed schedule listed in eServices.
• Students are required to attend: 2 hours per week for each lab credit in full-semester courses; 4 hours per week for each lab credit in half-semester courses.

WEATHER-RELATED CANCELLATIONS
If class or lab sessions are canceled due to weather, students are still required to make up the missed time during the same week or within a timeline agreed upon with instructor. It is the student's responsibility to reschedule and complete the required hours.

COMPLETION OF WEEKLY REQUIREMENTS
Weekly lab hours will be considered complete if the student:
1. Completes all required work for the week.
2. Has no work orders pending in the system.
3. Has no late or missing assignments.
4. Communicates with the instructor to confirm completion.

ADMINISTRATIVE WITHDRAWAL
Students who do not attend class for two consecutive weeks during the semester will be administratively withdrawn, in accordance with federal financial aid regulations.

ATTENDANCE VERIFICATION
To be considered in attendance, students must:
1. Sign up for lab time on signup.com.
2. Check in and out of classes using their student ID at the kiosks.
3. Be class-ready (program shirt, steel-toe shoes, tool bag).
4. Report errors (e.g., check-in issues, time discrepancies) to instructors immediately.

COMMUNICATION
Attendance-related issues must be communicated via school email. Your SCTCC email address is automatically entered in D2L and will be used for all official communication.

LATE POLICY
Late work is not accepted. All assignments are due the date they are posted.`,
  },
  d2l: {
    title: 'Navigating D2L & Technical Support',
    order: 5,
    content: `We will use a course management system called D2L Brightspace for this course. The Materials/Content menu will contain all the content information for the course, including weekly outlines, lectures, projects, etc. The Communications/Classlist menu gives you the ability to contact your classmates and your instructor through email.

Sending EMAIL to the Instructor: use the Communications/Classlist menu. Include in the SUBJECT line – Course Title, Name, and Topic of the email.

Although not every tool on D2L Brightspace works well on a mobile device, you can track assignments due dates, receive course announcements, monitor your grades, and so on using the free Pulse app.

TECHNICAL SUPPORT
D2L log-in tech support is found through SCTCC's Computer Help Desk in room 1-405 / phone 320.308.6445.
After hours tech support is found through Minnesota State IT Service Desk / phone 1.877.466.6728.

STUDENT SERVICES & ACADEMIC SUPPORT
Information about and links to technical support, accessibility policies, academic support, student services, financial aid, the student handbook, and eOrientation can be found under the Resources Tab in D2L.`,
  },
  class_environment: {
    title: 'Class Environment',
    order: 6,
    content: `In order to assure that we can have a free and open discussion and help each other, we expect each person to respect the confidentiality of what your classmates are willing to share while at the same time we ask that each of you exercise good judgment in what you choose to share, avoiding non-public or sensitive information. All your assignments in this course can be shared with the class.

Students are reminded to follow basic rules of civil communications. There will be no inappropriate language, threats, or negative personal comments tolerated. All such correspondence will be forwarded to the Student Conduct Officer for appropriate action.

Additionally, students are urged to report to the instructor immediately any harassment by a classmate, whether by email or on the Discussion Board and to forward the offending messages.

Refer to the Energy & Electronics Rules posted in the Electronics D2L Shell, under "Materials" and "Program Policies and Rules". These rules apply to this class and will be addressed as posted.`,
  },
  college_footer: {
    title: 'College Footer',
    order: 7,
    content: `SCTCC is a member of Minnesota State and is accredited by the Higher Learning Commission
ADA Accessible Facility. Affirmative Action/Equal Opportunity Educator and Employer.
TTY users may call MN Relay Service at 711 to contact the college.
St. Cloud Technical & Community College – 320-308-5000 – 800-222-1009 – 1540 Northway Drive, St. Cloud, MN 56303`,
  },
}

// ─── HTML / PDF Generator ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function fmtDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtDateShort(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
}
// Accessibility: consecutive bullet/numbered lines are wrapped in real <ul>/<ol>
// elements (loose <li> is invalid HTML and produces broken PDF list tags), and
// ALL-CAPS mini-headings render as real <h4> elements so tagged PDFs expose
// proper heading structure to assistive technology.
function renderSection(text) {
  if (!text) return ''
  const out = []
  let listType = null // 'ul' | 'ol' | null
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }
  const openList = (type) => {
    if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type }
  }
  text.split('\n').forEach(line => {
    const t = line.replace(/\u00a0/g, ' ').trim()
    if (!t) { closeList(); out.push('<br>'); return }
    if (t.startsWith('•')) { openList('ul'); out.push(`<li>${escHtml(t.slice(1).trim())}</li>`); return }
    if (/^\d+\.\s/.test(t)) { openList('ol'); out.push(`<li>${escHtml(t.replace(/^\d+\.\s/, ''))}</li>`); return }
    closeList()
    if (t === t.toUpperCase() && t.length > 3) { out.push(`<h4 class="subsub-head">${escHtml(t)}</h4>`); return }
    out.push(`<p>${escHtml(t)}</p>`)
  })
  closeList()
  return out.join('\n')
}

export function generateSyllabusHTML(data, commonSections) {
  const get = (key) => {
    const row = (commonSections || []).find(s => s.section_key === key)
    return row ? row.content : (DEFAULT_COMMON_SECTIONS[key]?.content || '')
  }
  const totalPoints = (data.assessments || []).reduce((sum, a) => sum + (parseInt(a.points) || 0), 0)
  const aMin = Math.round(totalPoints * data.grading_a_min / 100)
  const bMin = Math.round(totalPoints * data.grading_b_min / 100)
  const cMin = Math.round(totalPoints * data.grading_c_min / 100)
  const creditsTotal = (parseInt(data.credits_lecture) || 0) + (parseInt(data.credits_lab) || 0) + (parseInt(data.credits_soe) || 0)
  const creditsStr = `${creditsTotal} credit${creditsTotal !== 1 ? 's' : ''}: Lecture \u2013 ${data.credits_lecture}, Laboratory \u2013 ${data.credits_lab}, SOE \u2013 ${data.credits_soe}`
  const revisedStr = data.revised_date ? new Date(data.revised_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''
  const labHoursPolicy = data.course_type === 'online'
    ? `<p>This is a fully online course. All lectures, assignments, and coursework are completed remotely. There are no required on-campus hours unless otherwise stated by the instructor.</p>`
    : data.course_type === 'hybrid'
    ? `<p>This is a hybrid course that does not have a designated meeting time. Students are responsible for signing up for their lab hours on a weekly basis. Please review the attendance policy for details. This course requires each student to be on campus for <strong>${data.required_hours_per_week} hours a week</strong>, unless otherwise stated by instructor.</p><p>The lecture component of this course is online and is expected to be done outside of class time.</p>`
    : `<p>This course meets at the times listed in eServices. Students are expected to attend all scheduled class sessions. Students are required to be on campus for <strong>${data.required_hours_per_week} hours a week</strong>.</p>`
  const springBreakNote = (data.spring_break_start && data.spring_break_end) ? `<p><strong>Spring Break:</strong> ${fmtDate(data.spring_break_start)} \u2013 ${fmtDate(data.spring_break_end)}</p>` : ''
  const finalsNote = (data.finals_start && data.finals_end) ? `<p>The Final will be taken the week of ${fmtDateShort(data.finals_start)}\u2013${fmtDateShort(data.finals_end)} during class.</p>` : ''
  const timeNote = data.time_commitment_notes || `You should expect to spend two hours outside of class for each hour of lecture and one hour outside of class for each hour of lab. For this course, that means a total expectation of ${(parseInt(data.credits_lecture) || 0) * 2 + (parseInt(data.credits_lab) || 0)} hours per week outside of the classroom. If you do not feel you can fulfill this expectation, you should consider whether this class best fits this term for you.`
  const passFail = data.grading_mode === 'pass_fail'
  const assessmentRows = (data.assessments || []).map(a => `<tr><td>${escHtml(a.name)}${a.description ? ` &ndash; <em>${escHtml(a.description)}</em>` : ''}</td>${passFail ? '' : `<td class="pts">${a.points > 0 ? a.points + ' pts' : '&ndash;'}</td>`}</tr>`).join('\n')
  // Pass/fail: single-column "Required Activity" list, no points / total / letter scale
  const gradeTableHtml = (!passFail || (data.assessments || []).length > 0) ? `
    <table class="grade-table">
      <thead><tr><th scope="col">${passFail ? 'Required Activity' : 'Assessment'}</th>${passFail ? '' : '<th scope="col" class="r">Points</th>'}</tr></thead>
      <tbody>${assessmentRows}${passFail ? '' : `<tr class="total"><td>Total Points</td><td class="pts">${totalPoints} pts</td></tr>`}</tbody>
    </table>
    <p class="note">(Subject to change depending on course content)</p>` : ''
  const gradingScaleHtml = passFail ? '' : `
  <h3 class="sub-head">Grading Scale</h3>
  <div class="block">
    <p>A = ${data.grading_a_min}\u2013100% = ${aMin}\u2013${totalPoints} points</p>
    <p>B = ${data.grading_b_min}\u2013${data.grading_a_min - 1}% = ${bMin}\u2013${aMin - 1} points</p>
    <p>C = ${data.grading_c_min}\u2013${data.grading_b_min - 1}% = ${cMin}\u2013${bMin - 1} points</p>
    <p>F = ${data.grading_c_min - 1} and below = &lt;${cMin} points</p>
  </div>`
  // Accessibility: real ordered list so screen readers announce list semantics
  const outcomesHtml = (data.student_outcomes || []).length > 0 ? `<p><strong>Student Learning Outcomes:</strong></p>\n<ol class="outcomes">` + (data.student_outcomes || []).map(o => `<li>${escHtml(o)}</li>`).join('\n') + `</ol>` : ''
  // Strip " (Part #: ...)" suffix — part numbers are for the catalog, not the PDF
  const materialsHtml = (data.required_materials || []).length > 0 ? `<ul>${(data.required_materials || []).map(m => `<li>${escHtml(m.replace(/ \(Part #:.*?\)$/i, '').trim())}</li>`).join('\n')}</ul>` : '<p>None</p>'
  const techHtml = `<ul>${(data.required_technology || []).map(t => `<li>${escHtml(t)}</li>`).join('\n')}</ul>`
  const footerText = get('college_footer').replace(/\n/g, '<br>')
  const logoHtml = data.logo_url ? `<img src="${escHtml(data.logo_url)}" alt="St. Cloud Technical &amp; Community College logo" style="width:64px;height:auto;display:block;margin-bottom:6px;">` : ''
  // Accessibility: prefer the instructor-written alt text; fall back to a
  // generated description so the image is never missing alternative text.
  const coursePhotoAlt = (data.course_photo_alt || '').trim() || `Course photo for ${data.course_id}: ${data.course_name}`
  const coursePhotoHtml = data.course_photo_url
    ? `<img src="${escHtml(data.course_photo_url)}" alt="${escHtml(coursePhotoAlt)}" style="float:right;width:180px;height:auto;max-height:140px;object-fit:cover;border-radius:4px;margin:0 0 8px 16px;border:1px solid #dde4f0;">`
    : ''
  const coursePhotoClear = data.course_photo_url ? '<div style="clear:both"></div>' : ''  
  const hasInstructor2 = data.instructor2_enabled && data.instructor2_name
  const instructor2Html = hasInstructor2 ? `
  <h3 class="sub-head">Co-Instructor Office &amp; Office Hours</h3>
  <div class="block"><p>${escHtml(data.instructor2_office || '')}</p><p>${escHtml(data.instructor2_office_hours || '')}</p></div>
  <h3 class="sub-head">Co-Instructor Contact</h3>
  <div class="block">
    <p>${escHtml(data.instructor2_name)}</p>
    ${data.instructor2_email ? `<p><a href="mailto:${escHtml(data.instructor2_email)}">${escHtml(data.instructor2_email)}</a></p>` : ''}
    ${data.instructor2_phone ? `<p>${escHtml(data.instructor2_phone)}</p>` : ''}
  </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escHtml(data.course_id)}: ${escHtml(data.course_name)} \u2013 ${escHtml(data.semester)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page {
      size: letter; margin: 0.75in 1in 0.9in 1in;
      @bottom-left { content: "St. Cloud Technical & Community College  ${escHtml(data.course_id)}: ${escHtml(data.course_name)} Course Syllabus"; font-family: Calibri, 'Segoe UI', sans-serif; font-size: 7.5pt; color: #444; }
      @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: Calibri, 'Segoe UI', sans-serif; font-size: 7.5pt; color: #444; }
      @bottom-center { content: ""; border-top: 0.5px solid #aaa; }
    }
    body { font-family: Calibri, 'Segoe UI', Tahoma, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #000; }
    .doc-top { display: flex; justify-content: flex-end; margin-bottom: 12px; }
    .revised { font-size: 8.5pt; color: #444; }
    .title-row { display: flex; gap: 18px; align-items: flex-start; margin-bottom: 18px; }
    .sidebar { min-width: 128px; max-width: 140px; border: 1px solid #c0cde0; border-radius: 4px; padding: 8px 10px; background: #f4f7fc; }
    .sidebar-college { font-size: 9.5pt; font-weight: 700; color: #1a3a5c; line-height: 1.3; text-transform: uppercase; letter-spacing: 0.02em; }
    .sidebar-sub { font-size: 7.5pt; color: #555; margin-top: 3px; font-style: italic; }
    .sidebar-mission { font-size: 7.5pt; color: #555; margin-top: 6px; font-style: italic; line-height: 1.35; border-top: 1px solid #c0cde0; padding-top: 5px; }
    .title-center { flex: 1; text-align: center; }
    .course-title { font-size: 15pt; font-weight: 700; font-variant: small-caps; letter-spacing: 0.04em; }
    .semester-label { font-size: 10.5pt; font-variant: small-caps; font-weight: 600; letter-spacing: 0.02em; margin: 3px 0 8px; }
    .official-notice { font-size: 9.5pt; font-weight: 700; margin-bottom: 6px; }
    .nav-line { font-size: 8.5pt; }
    .nav-line a { color: #1155cc; text-decoration: underline; }
    h1, h2, h3, h4 { font-weight: inherit; }
    .sec-head { font-size: 11.5pt; font-weight: 700; font-variant: small-caps; letter-spacing: 0.05em; color: #1a3a5c; border-bottom: 1.5px solid #1a3a5c; padding-bottom: 2px; margin-top: 18px; margin-bottom: 8px; page-break-after: avoid; }
    .sub-head { font-size: 9.5pt; font-weight: 600; font-variant: small-caps; color: #1a3a5c; text-decoration: underline; margin-top: 10px; margin-bottom: 3px; page-break-after: avoid; }
    .subsub-head { font-size: 9.5pt; font-weight: 700; margin-top: 7px; margin-bottom: 3px; }
    p { margin-bottom: 5px; } ul, ol { margin-left: 20px; margin-bottom: 5px; } li { margin-bottom: 2px; }
    .block { margin-left: 16px; } ol.outcomes { margin-left: 34px; } ol.outcomes li { margin-bottom: 3px; }
    .grade-table { width: 58%; border-collapse: collapse; margin: 8px 0; font-size: 10pt; }
    .grade-table th { background: #1a3a5c; color: #fff; font-weight: 600; font-variant: small-caps; padding: 5px 10px; text-align: left; }
    .grade-table th.r, .grade-table .pts { text-align: right; min-width: 70px; }
    .grade-table tr:nth-child(even) td { background: #f2f5fb; }
    .grade-table td { padding: 4px 10px; border-bottom: 1px solid #d8e2f0; }
    .grade-table .total td { font-weight: 700; border-top: 2px solid #1a3a5c; background: #e6ecf7 !important; }
    .note { font-size: 8.5pt; color: #666; margin-top: 3px; }
    .doc-footer { margin-top: 28px; border-top: 1px solid #bbb; padding-top: 8px; font-size: 8.5pt; color: #444; }
    @media print { .sec-head { page-break-inside: avoid; } }
  </style>
</head>
<body>
  <div class="doc-top"><span class="revised">Revised: ${escHtml(revisedStr)}</span></div>
  <div class="title-row">
    <div class="sidebar">
      ${logoHtml}
      <div class="sidebar-college">St. Cloud<br>Technical &amp;<br>Community<br>College</div>
      <div class="sidebar-sub">A member of Minnesota State</div>
      <div class="sidebar-mission"><em>We provide the education, training, and support necessary for equitable participation in our society, economy, and democracy.</em></div>
    </div>
    <div class="title-center">
      <h1 class="course-title">${escHtml(data.course_id)}: ${escHtml(data.course_name)}</h1>
      <div class="semester-label">${escHtml(data.semester)}</div>
      <p class="official-notice">This syllabus is the official course document. The instructor${hasInstructor2 ? 's reserve' : ' reserves'} the right to make changes to this document. Students will be notified when changes are made.</p>
      <nav class="nav-line" aria-label="Syllabus sections"><a href="#sec-instructor">Instructor Information</a> / <a href="#sec-course">Course Information</a> / <a href="#sec-college-policies">College Policies &amp; Procedures</a> / <a href="#sec-course-policies">Course Policies &amp; Procedures</a> / <a href="#sec-grading">Grading</a></nav>
    </div>
  </div>
  <h2 class="sec-head" id="sec-instructor">Instructor Information</h2>
  <h3 class="sub-head">Office &amp; Office Hours</h3>
  <div class="block"><p>${escHtml(data.instructor_office)}</p><p>${escHtml(data.instructor_office_hours)}</p></div>
  <h3 class="sub-head">Contact Information</h3>
  <div class="block">
    ${coursePhotoHtml}
    <p>${escHtml(data.instructor_name)}</p>
    ${data.instructor_email ? `<p><a href="mailto:${escHtml(data.instructor_email)}">${escHtml(data.instructor_email)}</a></p>` : ''}
    ${data.instructor_phone ? `<p>${escHtml(data.instructor_phone)}</p>` : ''}
    <p>The best way to contact us is by <strong>email/telephone/text</strong>.</p>
    <p>You can expect a response to email questions within 24 hours Mondays-Thursdays.</p>
    ${coursePhotoClear}
  </div>
  ${instructor2Html}
  <h2 class="sec-head" id="sec-course">Course Information</h2>
  <h3 class="sub-head">General Information</h3>
  <div class="block">
    <p><strong>${escHtml(data.course_id)}: ${escHtml(data.course_name)}</strong></p>
    <p>${escHtml(creditsStr)}</p>
    ${labHoursPolicy}
    <p>Begin date: ${escHtml(fmtDateShort(data.begin_date))} - End date: ${escHtml(fmtDateShort(data.end_date))}</p>
    <br>
    <p><a href="https://www.sctcc.edu/student-resources/registration/academic-calendar">SCTCC Academic Calendar</a> and <a href="https://eservices.minnstate.edu">eServices</a></p>
    <p>Last day to drop and receive full refund is ${escHtml(fmtDate(data.last_drop_date))}.</p>
    <p>Last day to withdraw with a grade of &ldquo;W&rdquo; is ${escHtml(fmtDate(data.last_withdraw_date))}.</p>
    <p>Students not attending class during the first week shall be dropped from the course for non-attendance.</p>
    <br>
    <p>Students who do not meet outlined participation requirements in this class for two consecutive weeks during the semester shall be administratively withdrawn from the class; this action is based on federal financial aid regulations.</p>
    ${springBreakNote}
  </div>
  <h3 class="sub-head">Materials</h3>
  <div class="block">
    <p><strong>Required</strong></p>${materialsHtml}
    <p><strong>Required Technology</strong></p>${techHtml}
    <p><strong>Suggested Technical Skills</strong></p>
    <p>Microsoft Training is available for free at your convenience.</p>
  </div>
  <h3 class="sub-head">Pre/Co-Requisites</h3>
  <div class="block">
    <p>${escHtml(data.prerequisites) || 'None'}</p>
    ${data.restricted_to ? `<p>Restricted to the following major(s): ${escHtml(data.restricted_to)}</p>` : ''}
  </div>
  <h3 class="sub-head">Course Description &amp; Outcomes</h3>
  <div class="block"><p>${escHtml(data.course_description)}</p>${outcomesHtml}</div>
  <h2 class="sec-head" id="sec-college-policies">College Policies &amp; Procedures</h2>
  <h3 class="sub-head">Academic Integrity</h3><div class="block">${renderSection(get('academic_integrity'))}</div>
  <h3 class="sub-head">Accommodations</h3><div class="block">${renderSection(get('accommodations'))}</div>
  <h3 class="sub-head">Nondiscrimination and Title IX</h3><div class="block">${renderSection(get('diversity'))}</div>
  <h2 class="sec-head" id="sec-course-policies">Course Policies &amp; Procedures</h2>
  <h3 class="sub-head">Attendance</h3><div class="block">${renderSection(get('attendance'))}</div>
  <h3 class="sub-head">Navigating D2L &amp; Technical Support</h3><div class="block">${renderSection(get('d2l'))}</div>
  <h3 class="sub-head">Class Environment</h3><div class="block">${renderSection(get('class_environment'))}</div>
  <h2 class="sec-head" id="sec-grading">Grading</h2>
  ${passFail ? `<h3 class="sub-head">Pass/Fail Course</h3>
  <div class="block"><p>${escHtml(PASS_FAIL_STATEMENT)}</p></div>` : ''}
  <h3 class="sub-head">${passFail ? 'Required Activities' : 'Assignments &amp; Points'}</h3>
  <div class="block">
    ${(parseInt(data.volunteer_hours_required) || 0) > 0 ? `<p>All students are expected to put in <strong>${escHtml(String(data.volunteer_hours_required))} hours of volunteer hours</strong>. These hours need to be approved by the instructor. They must support the program. Examples are VEX Robotics tournaments, Ambassador program, Epic, etc.</p>` : ''}
    <p>Weekly attendance \u2013 Your time sheet will need to match up to your signup days for lab. You will need <strong>${escHtml(String(data.required_hours_per_week))} hours a week</strong> of lab time.</p>
    <br>${gradeTableHtml}
  </div>${gradingScaleHtml}
  <h3 class="sub-head">Grades</h3>
  <div class="block">
    <p>You can check your grade through D2L Brightspace ASSESSMENTS/GRADES at any point during the semester.</p>
    ${passFail ? '' : `<p>You can expect to have graded assignments returned within 3\u20135 days of the due date of the assignment.</p>
    <p>Your grade will reflect how well you have mastered the material, not how hard you have worked.</p>`}
  </div>
  <h3 class="sub-head">Time Commitment</h3>
  <div class="block"><p>${escHtml(timeNote)}</p></div>
  <h3 class="sub-head">Course Calendar</h3>
  <div class="block">
    <p>A detailed schedule is available on D2L. Instructors may adjust or change. Notifications will be given in class prior to change.</p>
    ${finalsNote}
  </div>
  <div class="doc-footer">${footerText}<br>Template Updated ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
</body>
</html>`
}

// ─── Create CMMS Class Modal ───────────────────────────────────────────────────
// Shown after PDF is generated — offers to create the class in the CMMS classes table

/**
 * Two-tier class ID generator (matches generateLookupId in useSettings.js).
 *
 * Tier 1 (default): atomic `get_next_id` RPC with p_type='class'. Race-safe at
 *   the DB level. Returns the full prefixed ID (e.g. "CLS1019").
 *
 * Tier 2 (fallback / drift recovery): drift-resistant client-side max scan.
 *   Reads `counters` AND the actual MAX numeric class_id from the classes
 *   table, uses `MAX(counter, table_max) + 1`, and heals the counter row.
 *   Used when the RPC fails or when the caller passes `forceClient: true`
 *   (used for retry-after-23505 unique violations).
 *
 * Never uses Date.now() for IDs (project rule).
 */
async function generateClassId(options = {}) {
  const { forceClient = false } = options

  // ── Tier 1: atomic RPC ─────────────────────────────────────────────────────
  if (!forceClient) {
    try {
      const { data: rpcId, error: rpcErr } = await supabase.rpc('get_next_id', { p_type: 'class' })
      if (!rpcErr && rpcId) return rpcId
      if (rpcErr) console.warn('generateClassId: RPC error, falling through:', rpcErr.message)
    } catch (e) {
      console.warn('generateClassId: RPC threw, falling through:', e.message)
    }
  }

  // ── Tier 2: drift-resistant client-side ────────────────────────────────────
  let counterVal = 1000
  let prefix = 'CLS'
  try {
    const { data: counter } = await supabase
      .from('counters')
      .select('current_value, prefix')
      .eq('counter_name', 'class')
      .maybeSingle()
    if (counter) {
      counterVal = counter.current_value || 1000
      prefix = counter.prefix || 'CLS'
    }
  } catch (e) {
    console.warn('generateClassId: counter read failed, using defaults:', e.message)
  }

  // Numeric max scan of existing class_ids (lex-sort is unsafe, e.g. CLS9999 > CLS10000)
  let tableMax = 0
  try {
    const { data: rows } = await supabase.from('classes').select('class_id')
    if (rows && rows.length > 0) {
      for (const r of rows) {
        const digits = (r.class_id || '').toString().replace(/\D/g, '')
        const n = digits ? parseInt(digits, 10) : 0
        if (Number.isFinite(n) && n > tableMax) tableMax = n
      }
    }
  } catch (e) {
    console.warn('generateClassId: max scan failed, using counter only:', e.message)
  }

  const nextVal = Math.max(counterVal, tableMax) + 1

  // Heal the counter row so future RPC calls return correct values (non-fatal)
  try {
    await supabase.from('counters').update({
      current_value: nextVal,
      updated_at: new Date().toISOString(),
    }).eq('counter_name', 'class')
  } catch (e) {
    console.warn('generateClassId: counter heal failed:', e.message)
  }

  return `${prefix}${nextVal}`
}

function CreateCMSSClassModal({ syllabusData, onClose }) {
  const { user, profile } = useAuth()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)
  const [createdClassId, setCreatedClassId] = useState('')
  const [alreadyExists, setAlreadyExists] = useState(false)
  const [confirmDuplicate, setConfirmDuplicate] = useState(false)

  // WCAG 2.1 AA — focus trap, Escape-to-close, focus restore (SC 2.1.1, 2.4.3)
  const dialogRef = useDialogA11y(true, onClose)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : (user?.email || 'Unknown')

  // Class fields — pre-filled from syllabus data
  const semLen = syllabusData.semester_length || '16'
  const [classData, setClassData] = useState({
    course_id: syllabusData.course_id || '',
    course_name: syllabusData.course_name || '',
    required_hours: syllabusData.required_hours_per_week || calcHours(syllabusData.credits_lab || 1, semLen),
    instructor: syllabusData.instructor_name || '',
    semester: syllabusData.semester || 'Spring 2026',
    status: 'Active',
    start_date: syllabusData.begin_date || '',
    end_date: syllabusData.end_date || '',
    spring_break_start: syllabusData.spring_break_start || '',
    spring_break_end: syllabusData.spring_break_end || '',
    finals_start: syllabusData.finals_start || '',
    finals_end: syllabusData.finals_end || '',
  })

  const upd = (k, v) => setClassData(p => ({ ...p, [k]: v }))

  // Check if a CMMS class already exists for this course+semester
  useEffect(() => {
    if (!syllabusData.course_id || !syllabusData.semester) return
    supabase.from('classes')
      .select('class_id')
      .eq('course_id', syllabusData.course_id)
      .eq('semester', syllabusData.semester)
      .maybeSingle()
      .then(({ data }) => { if (data) setAlreadyExists(true) })
  }, [syllabusData.course_id, syllabusData.semester])

  const handleCreate = async () => {
    // Duplicate guard — an existing course+semester class requires explicit opt-in
    if (alreadyExists && !confirmDuplicate) return

    setCreating(true)
    try {
      // Insert with retry-on-duplicate-key. On a 23505 collision, switch to the
      // drift-resistant client ID path (which heals the counter) and retry.
      const maxAttempts = 3
      let insertedRows = null
      let lastError = null

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const classId = await generateClassId({ forceClient: attempt > 0 })
        if (!classId) {
          lastError = new Error('Could not generate a class ID — the "class" counter may be missing.')
          break
        }

        const { data: rows, error } = await supabase.from('classes').insert({
          class_id:           classId,
          course_id:          classData.course_id,
          course_name:        classData.course_name,
          required_hours:     parseFloat(classData.required_hours) || 4,
          instructor:         classData.instructor,
          semester:           classData.semester,
          status:             classData.status,
          start_date:         classData.start_date || null,
          end_date:           classData.end_date || null,
          spring_break_start: classData.spring_break_start || null,
          spring_break_end:   classData.spring_break_end || null,
          finals_start:       classData.finals_start || null,
          finals_end:         classData.finals_end || null,
          created_at:         new Date().toISOString(),
        }).select()

        if (!error) {
          if (!rows || rows.length === 0) {
            // RLS silently blocked the insert — surface it as a real failure
            lastError = new Error('Insert was blocked — you may not have permission to create classes.')
            break
          }
          insertedRows = rows
          setCreatedClassId(classId)
          break
        }

        lastError = error
        // 23505 = unique_violation — retry with the forced client path
        if (error.code !== '23505') break
      }

      if (!insertedRows) {
        toast.error('Failed to create class: ' + (lastError?.message || 'Unknown error'))
        return
      }

      // Audit log (non-critical)
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email || user?.email,
          user_name: userName,
          action: 'Create',
          entity_type: 'classes',
          entity_id: insertedRows[0].class_id,
          details: `Created class ${classData.course_id} – ${classData.course_name} (${classData.semester}) from Syllabus Generator`,
        })
      } catch (e) { console.log('Audit log error (non-critical):', e) }

      setCreated(true)
      toast.success(`${classData.course_id} added to CMMS — ready for student enrollment!`)
    } finally {
      setCreating(false)
    }
  }

  if (created) {
    return (
      <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ccm-success-title"
          className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check size={28} className="text-emerald-600" aria-hidden="true" />
          </div>
          <h3 id="ccm-success-title" className="text-lg font-bold text-surface-900 mb-2">Class Created!</h3>
          <div role="status">
            <p className="text-sm text-surface-500 mb-1">
              <strong>{classData.course_id} – {classData.course_name}</strong>
            </p>
            <p className="text-sm text-surface-500 mb-2">
              {classData.semester} · {classData.instructor}
            </p>
            {createdClassId && (
              <p className="text-xs font-semibold text-surface-500 mb-4">
                Class ID: <span className="font-mono text-surface-700">{createdClassId}</span>
              </p>
            )}
          </div>
          <p className="text-xs text-surface-400 mb-6">
            The class is now visible in the CMMS. Go to Settings to enroll students.
          </p>
          <button onClick={onClose} className="w-full py-2.5 min-h-[44px] bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
            Done
          </button>
        </div>
      </div>
    )
  }

  const createDisabled = creating || !classData.course_id || (alreadyExists && !confirmDuplicate)

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ccm-title" aria-describedby="ccm-desc"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center">
              <GraduationCap size={16} className="text-emerald-600" aria-hidden="true" />
            </div>
            <div>
              <h2 id="ccm-title" className="text-base font-bold text-surface-900">Create CMMS Class</h2>
              <p id="ccm-desc" className="text-xs text-surface-400">Add this course to the CMMS for student enrollment</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close dialog" className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
            <X size={18} className="text-surface-400" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {alreadyExists && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-sm text-amber-700" aria-live="polite">
              <div className="flex items-start gap-2">
                <AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>A CMMS class for <strong>{syllabusData.course_id}</strong> in <strong>{syllabusData.semester}</strong> already exists. Duplicate classes ripple into the time clock, lab signup, and weekly tracker — manage the existing class from the Settings page instead.</span>
              </div>
              <label htmlFor="ccm-confirm-dup" className="mt-2.5 flex items-start gap-2 cursor-pointer font-medium">
                <input id="ccm-confirm-dup" type="checkbox" checked={confirmDuplicate}
                  onChange={e => setConfirmDuplicate(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-amber-300 text-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500/60" />
                <span>I understand this will create a duplicate class and I want to proceed anyway.</span>
              </label>
            </div>
          )}

          <div className="bg-surface-50 rounded-xl border border-surface-100 p-4">
            <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-3">
              Pre-filled from your syllabus — verify before creating
              <span className={`ml-2 px-2 py-0.5 rounded-full font-semibold normal-case tracking-normal ${semLen === '8' ? 'bg-amber-100 text-amber-700' : 'bg-brand-50 text-brand-600'}`}>
                {semLen}-week class
              </span>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ccm-course-id" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Course ID</label>
                <input id="ccm-course-id" value={classData.course_id} onChange={e => upd('course_id', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label htmlFor="ccm-course-name" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Course Name</label>
                <input id="ccm-course-name" value={classData.course_name} onChange={e => upd('course_name', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label htmlFor="ccm-instructor" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Instructor</label>
                <input id="ccm-instructor" value={classData.instructor} onChange={e => upd('instructor', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label htmlFor="ccm-semester" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Semester</label>
                <input id="ccm-semester" value={classData.semester} readOnly
                  className="w-full px-3 py-2 border border-surface-100 rounded-lg text-sm bg-surface-50 text-surface-500" />
              </div>
              <div>
                <label htmlFor="ccm-hours" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Required Hours/Week</label>
                <input id="ccm-hours" type="number" value={classData.required_hours} onChange={e => upd('required_hours', e.target.value)} min={1} max={40}
                  aria-describedby="ccm-hours-hint"
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                <p id="ccm-hours-hint" className="text-[10px] text-surface-400 mt-1">
                  Formula: {syllabusData.credits_lab || 1} lab cr × {semLen === '8' ? '4' : '2'} ({semLen}-wk) = {calcHours(syllabusData.credits_lab || 1, semLen)} hrs/wk
                </p>
              </div>
              <div>
                <label htmlFor="ccm-status" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Status</label>
                <select id="ccm-status" value={classData.status} onChange={e => upd('status', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40">
                  <option>Active</option>
                  <option>Inactive</option>
                  <option>Pending</option>
                </select>
              </div>
              <div>
                <label htmlFor="ccm-start" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Start Date</label>
                <input id="ccm-start" type="date" value={classData.start_date} onChange={e => upd('start_date', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label htmlFor="ccm-end" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">End Date</label>
                <input id="ccm-end" type="date" value={classData.end_date} onChange={e => upd('end_date', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              {(syllabusData.spring_break_start || syllabusData.finals_start) && (
                <>
                  <div>
                    <label htmlFor="ccm-sb-start" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Spring Break Start</label>
                    <input id="ccm-sb-start" type="date" value={classData.spring_break_start} onChange={e => upd('spring_break_start', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                  <div>
                    <label htmlFor="ccm-sb-end" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Spring Break End</label>
                    <input id="ccm-sb-end" type="date" value={classData.spring_break_end} onChange={e => upd('spring_break_end', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                  <div>
                    <label htmlFor="ccm-finals-start" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Finals Start</label>
                    <input id="ccm-finals-start" type="date" value={classData.finals_start} onChange={e => upd('finals_start', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                  <div>
                    <label htmlFor="ccm-finals-end" className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Finals End</label>
                    <input id="ccm-finals-end" type="date" value={classData.finals_end} onChange={e => upd('finals_end', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                </>
              )}
            </div>
          </div>

          <p className="text-xs text-surface-400">
            The class will appear in the CMMS Settings page where you can enroll students. Time clock, lab signup, and weekly lab tracker will all be linked to this class automatically.
          </p>
        </div>

        <div className="border-t border-surface-100 px-6 py-4 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 min-h-[44px] border border-surface-200 text-sm font-medium text-surface-600 rounded-xl hover:bg-surface-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
            Skip for Now
          </button>
          <button onClick={handleCreate} disabled={createDisabled}
            className="flex-1 py-2.5 min-h-[44px] bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
            <PlusCircle size={15} aria-hidden="true" />
            {creating ? 'Creating…' : 'Create CMMS Class'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Reusable Form Helpers ─────────────────────────────────────────────────────
function Field({ label, required, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-surface-400 mt-1">{hint}</p>}
    </div>
  )
}
function TI({ value, onChange, placeholder, type = 'text', className = '' }) {
  return <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    className={`w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-400 ${className}`} />
}
function NI({ value, onChange, min, max, step = 1, ariaLabel }) {
  return <input type="number" value={value ?? ''} onChange={e => onChange(e.target.value)} min={min} max={max} step={step} aria-label={ariaLabel}
    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-400" />
}
function TA({ value, onChange, rows = 4, placeholder }) {
  return <textarea value={value ?? ''} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder}
    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-400 resize-y" />
}
function Sel({ value, onChange, options }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-400 bg-white">
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
function ItemList({ items, onChange, placeholder, addLabel = 'Add Item' }) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2">
          <input value={item} onChange={e => onChange(items.map((x, idx) => idx === i ? e.target.value : x))} placeholder={placeholder}
            className="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
          <button onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...items, ''])} className="flex items-center gap-1.5 text-xs text-brand-600 font-medium hover:text-brand-700 py-1">
        <Plus size={13} /> {addLabel}
      </button>
    </div>
  )
}

// ─── Hours Calculator ─────────────────────────────────────────────────────────
// Rule: lab credits × 2 for a 16-week class, lab credits × 4 for an 8-week class
function calcHours(labCredits, semesterLength) {
  const lab = parseInt(labCredits) || 0
  return semesterLength === '8' ? lab * 4 : lab * 2
}

// ─── Step 1: Course Catalog Select ────────────────────────────────────────────
// Pulls from syllabus_courses (catalog only — NOT the CMMS classes table)
function Step1CourseSelect({ data, update, courseCatalog, setCatalog, savedExists, otherSemesters = [], onDuplicate }) {
  const { user } = useAuth()
  const [mode, setMode] = useState('existing')
  const [showDuplicate, setShowDuplicate] = useState(false)
  const [dupSemester, setDupSemester] = useState('')
  const [duplicating, setDuplicating] = useState(false)
  const [showAddCourse, setShowAddCourse] = useState(false)
  const [newCourse, setNewCourse] = useState({ course_id: '', course_name: '', credits_lecture: 1, credits_lab: 1, credits_soe: 0, required_hours: 4 })
  const [savingCourse, setSavingCourse] = useState(false)

  const availableSemesters = SEMESTERS.filter(s => s !== data.semester)

  const handleDuplicate = async () => {
    if (!dupSemester) return
    setDuplicating(true)
    await onDuplicate(dupSemester)
    setDuplicating(false)
    setShowDuplicate(false)
  }

  const handleAddCourse = async () => {
    if (!newCourse.course_id.trim() || !newCourse.course_name.trim()) {
      toast.error('Course ID and name are required')
      return
    }
    setSavingCourse(true)
    const { data: row, error } = await supabase
      .from('syllabus_courses')
      .upsert({ ...newCourse, updated_at: new Date().toISOString() }, { onConflict: 'course_id' })
      .select()
      .single()
    setSavingCourse(false)
    if (error) { toast.error('Could not add course: ' + error.message); return }
    setCatalog(prev => {
      const filtered = prev.filter(c => c.course_id !== row.course_id)
      return [...filtered, row].sort((a, b) => a.course_id.localeCompare(b.course_id))
    })
    // Select it
    update('course_id', row.course_id)
    update('course_name', row.course_name)
    update('credits_lecture', row.credits_lecture)
    update('credits_lab', row.credits_lab)
    update('credits_soe', row.credits_soe)
    update('required_hours_per_week', row.required_hours)
    setShowAddCourse(false)
    setNewCourse({ course_id: '', course_name: '', credits_lecture: 1, credits_lab: 1, credits_soe: 0, required_hours: 4 })
    toast.success(`${row.course_id} added to course catalog`)
    setMode('existing')
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-surface-500">
        Select a course from the syllabus catalog, or add a new course entry. Semester enrollment in the CMMS is handled separately after the syllabus is generated.
      </p>

      {/* Course catalog select */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide">
            Course <span className="text-red-500">*</span>
          </label>
          <button onClick={() => setShowAddCourse(v => !v)}
            className="flex items-center gap-1 text-xs text-brand-600 font-medium hover:text-brand-700 transition-colors">
            <PlusCircle size={13} />
            {showAddCourse ? 'Cancel' : 'Add Course to Catalog'}
          </button>
        </div>

        <select
          value={data.course_id || ''}
          onChange={e => {
            const course = courseCatalog.find(c => c.course_id === e.target.value)
            if (course) {
              update('course_id', course.course_id)
              update('course_name', course.course_name)
              update('credits_lecture', course.credits_lecture ?? 1)
              update('credits_lab', course.credits_lab ?? 1)
              update('credits_soe', course.credits_soe ?? 0)
              // Auto-calculate hours from lab credits + current semester length
              update('required_hours_per_week', calcHours(course.credits_lab ?? 1, data.semester_length || '16'))
              // Pre-fill description, outcomes, and prerequisites from catalog
              update('course_description', course.course_description || '')
              update('student_outcomes', Array.isArray(course.student_outcomes) ? course.student_outcomes : [])
              update('prerequisites', course.prerequisites || '')
            } else {
              update('course_id', '')
              update('course_name', '')
            }
          }}
          className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 bg-white"
        >
          <option value="">-- Select a course --</option>
          {courseCatalog.map(c => (
            <option key={c.course_id} value={c.course_id}>
              {c.course_id} – {c.course_name}
            </option>
          ))}
        </select>

        {data.course_id && (
          <div role="status" className={`border rounded-lg p-3 text-sm ${savedExists ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-brand-50 border-brand-100 text-brand-700'}`}>
            <Check size={14} className="inline mr-1.5" aria-hidden="true" />
            {savedExists
              ? `Saved syllabus loaded for ${data.semester} — verify details and step through each section.`
              : `No saved syllabus found for ${data.course_id} in ${data.semester} — starting fresh.`}
          </div>
        )}

        {/* Saved drafts exist under other semesters — surface them so work is never "lost" */}
        {data.course_id && !savedExists && otherSemesters.length > 0 && (
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-3" role="status">
            <p className="text-sm font-semibold text-amber-800 flex items-center gap-1.5">
              <AlertCircle size={14} aria-hidden="true" />
              Saved syllabi found for {data.course_id} under other semesters
            </p>
            <p className="text-xs text-amber-700 mt-1">
              Select one below to load it, or stay on {data.semester} to start fresh. You can also load one and use
              &ldquo;Duplicate to New Semester&rdquo; to carry it forward.
            </p>
            <ul className="mt-2 space-y-1.5">
              {otherSemesters.map(o => (
                <li key={o.semester} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-amber-800">
                    {o.semester}
                    {o.updated_at && (
                      <span className="text-xs text-amber-600 ml-2">
                        last saved {new Date(o.updated_at).toLocaleDateString()}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => update('semester', o.semester)}
                    aria-label={`Load saved syllabus for ${data.course_id}, ${o.semester}`}
                    className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-amber-800 bg-white border border-amber-300 rounded-lg hover:bg-amber-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                  >
                    Load {o.semester}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Inline "add to catalog" form */}
        {showAddCourse && (
          <div className="border border-brand-100 bg-brand-50/50 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-brand-700 uppercase tracking-wide flex items-center gap-1.5">
              <PlusCircle size={12} /> New Course Entry
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">Course ID <span className="text-red-500">*</span></label>
                <input value={newCourse.course_id} onChange={e => setNewCourse(p => ({ ...p, course_id: e.target.value.toUpperCase() }))}
                  placeholder="RICT1650"
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">Course Name <span className="text-red-500">*</span></label>
                <input value={newCourse.course_name} onChange={e => setNewCourse(p => ({ ...p, course_name: e.target.value }))}
                  placeholder="e.g. Advanced Robotics"
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">Lecture Credits</label>
                <input type="number" value={newCourse.credits_lecture} min={0} max={6} onChange={e => setNewCourse(p => ({ ...p, credits_lecture: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">Lab Credits</label>
                <input type="number" value={newCourse.credits_lab} min={0} max={6} onChange={e => setNewCourse(p => ({ ...p, credits_lab: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">Campus Hrs/Week</label>
                <input type="number" value={newCourse.required_hours} min={1} max={40} step={0.5} onChange={e => setNewCourse(p => ({ ...p, required_hours: parseFloat(e.target.value) || 4 }))}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
            </div>
            <button onClick={handleAddCourse} disabled={savingCourse || !newCourse.course_id || !newCourse.course_name}
              className="w-full py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50">
              {savingCourse ? 'Saving…' : 'Save to Catalog & Select'}
            </button>
          </div>
        )}
      </div>

      {/* Semester */}
      <Field label="Semester" required>
        <Sel value={data.semester} onChange={v => update('semester', v)}
          options={SEMESTERS.map(s => ({ value: s, label: s }))} />
      </Field>

      {/* Duplicate panel */}
      {savedExists && (
        <div className="border border-surface-200 rounded-xl p-4 bg-surface-50">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-surface-700 flex items-center gap-1.5">
                <Copy size={14} className="text-surface-400" /> Duplicate to New Semester
              </p>
              <p className="text-xs text-surface-400 mt-0.5">
                Copy all content to a new semester — dates will be cleared for re-entry.
              </p>
            </div>
            <button onClick={() => { setShowDuplicate(v => !v); setDupSemester(availableSemesters[0] || '') }}
              className="px-3 py-1.5 text-xs font-medium text-brand-600 border border-brand-200 bg-white rounded-lg hover:bg-brand-50 transition-colors">
              {showDuplicate ? 'Cancel' : 'Duplicate'}
            </button>
          </div>
          {showDuplicate && (
            <div className="mt-4 pt-4 border-t border-surface-200 flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">Target Semester</label>
                <select value={dupSemester} onChange={e => setDupSemester(e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40">
                  {availableSemesters.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button onClick={handleDuplicate} disabled={!dupSemester || duplicating}
                className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50">
                {duplicating ? 'Duplicating…' : 'Confirm Duplicate'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Step 2: Instructor ────────────────────────────────────────────────────────
function Step2Instructor({ data, update, commonSections }) {
  // Get shared logo from common sections (uploaded once via the gear settings)
  const sharedLogo = (commonSections || []).find(s => s.section_key === 'shared_logo')?.content || ''

  // Determine logo source:
  //   'shared'   — using the shared logo, no per-course override
  //   'custom'   — instructor uploaded/pasted a course-specific logo
  //   'none'     — shared logo exists but instructor explicitly removed it for this course
  const logoSource = !data.logo_url
    ? (sharedLogo ? 'shared' : 'none')
    : data.logo_url === sharedLogo
      ? 'shared'
      : 'custom'

  const activeLogoUrl = logoSource === 'shared' ? sharedLogo : data.logo_url

  // Auto-apply shared logo if no per-course value is set yet. Also heal
  // blob: URLs — they only live as long as the browser session that created
  // them, so a saved draft holding one is always dead after a reload.
  useEffect(() => {
    const cur = String(data.logo_url || '').trim()
    if (sharedLogo && (!cur || cur.startsWith('blob:'))) {
      update('logo_url', sharedLogo)
    }
  }, [sharedLogo]) // eslint-disable-line

  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 600_000) { toast.error('Image too large — please use an image under 600 KB.'); return }
    const reader = new FileReader()
    reader.onload = () => update('logo_url', reader.result)
    reader.readAsDataURL(file)
  }

  const resetToShared = () => update('logo_url', sharedLogo)
  const removeLogo    = () => update('logo_url', '')

  return (
    <div className="space-y-5">
      <p className="text-sm text-surface-500">Instructor details that appear at the top of the syllabus.</p>

      {/* Primary instructor */}
      <div className="rounded-xl border border-surface-200 p-4 space-y-4">
        <p className="text-xs font-semibold text-surface-600 flex items-center gap-1.5 uppercase tracking-wide">
          <User size={13} className="text-brand-500" /> Primary Instructor
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" required><TI value={data.instructor_name} onChange={v => update('instructor_name', v)} placeholder="Aaron Barker" /></Field>
          <Field label="Email" required><TI value={data.instructor_email} onChange={v => update('instructor_email', v)} placeholder="abarker@sctcc.edu" type="email" /></Field>
          <Field label="Phone"><TI value={data.instructor_phone} onChange={v => update('instructor_phone', v)} placeholder="320.308.6518" /></Field>
          <Field label="Office Location" hint="e.g. 1-352A"><TI value={data.instructor_office} onChange={v => update('instructor_office', v)} placeholder="Location – 1-352A" /></Field>
        </div>
        <Field label="Office Hours">
          <TI value={data.instructor_office_hours} onChange={v => update('instructor_office_hours', v)} placeholder="Tuesday – Thursday 8AM – 4PM, needs to be scheduled." />
        </Field>
      </div>

      {/* Co-instructor */}
      <div className="rounded-xl border border-surface-200 overflow-hidden">
        <button onClick={() => update('instructor2_enabled', !data.instructor2_enabled)}
          className={`w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors ${data.instructor2_enabled ? 'bg-violet-50 text-violet-700' : 'bg-surface-50 text-surface-600 hover:bg-surface-100'}`}>
          <span className="flex items-center gap-2"><UserPlus size={15} /> Co-Instructor (optional)</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${data.instructor2_enabled ? 'bg-violet-100 text-violet-700' : 'bg-surface-200 text-surface-500'}`}>
            {data.instructor2_enabled ? 'Enabled' : 'Off'}
          </span>
        </button>
        {data.instructor2_enabled && (
          <div className="p-4 space-y-4 border-t border-surface-100">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name"><TI value={data.instructor2_name} onChange={v => update('instructor2_name', v)} placeholder="Brad Wanous" /></Field>
              <Field label="Email"><TI value={data.instructor2_email} onChange={v => update('instructor2_email', v)} placeholder="brad.wanous@sctcc.edu" type="email" /></Field>
              <Field label="Phone"><TI value={data.instructor2_phone} onChange={v => update('instructor2_phone', v)} placeholder="320.308.5360" /></Field>
              <Field label="Office Location"><TI value={data.instructor2_office} onChange={v => update('instructor2_office', v)} placeholder="Location – 1-352A" /></Field>
            </div>
            <Field label="Office Hours"><TI value={data.instructor2_office_hours} onChange={v => update('instructor2_office_hours', v)} placeholder="Tuesday – Thursday 8AM – 4PM" /></Field>
          </div>
        )}
      </div>

      {/* Revised date */}
      <Field label="Revised Date" hint="Appears top-right of the document">
        <TI value={data.revised_date} onChange={v => update('revised_date', v)} type="date" className="max-w-[220px]" />
      </Field>

      {/* ── Logo section ── */}
      <div className="rounded-xl border border-surface-200 overflow-hidden">
        <div className="px-4 py-3 bg-surface-50 border-b border-surface-100 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-surface-700">College Logo</p>
            <p className="text-xs text-surface-400 mt-0.5">Appears in the PDF sidebar above the college name.</p>
          </div>
          {/* Status badge */}
          {logoSource === 'shared' && sharedLogo && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-full">
              <Check size={11} /> Using shared logo
            </span>
          )}
          {logoSource === 'custom' && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-2.5 py-1 rounded-full">
              Course-specific override
            </span>
          )}
          {!sharedLogo && !data.logo_url && (
            <span className="text-xs text-surface-400 italic">No logo set</span>
          )}
        </div>

        <div className="p-4 space-y-3">
          {/* Preview */}
          {activeLogoUrl && (
            <div className="flex items-center gap-4 bg-surface-50 border border-surface-100 rounded-lg p-3">
              <img src={activeLogoUrl} alt="Logo preview" className="h-12 w-auto object-contain bg-white border border-surface-200 rounded p-1 shrink-0" />
              <div className="flex-1 min-w-0">
                {logoSource === 'shared' ? (
                  <p className="text-xs text-emerald-600 font-medium">
                    Shared logo — uploaded once in the ⚙ Settings gear and applied to all syllabi.
                  </p>
                ) : (
                  <p className="text-xs text-amber-600 font-medium">
                    Custom logo for this course only.
                    {sharedLogo && (
                      <button onClick={resetToShared} className="ml-2 underline hover:no-underline">
                        Reset to shared logo
                      </button>
                    )}
                  </p>
                )}
              </div>
              <button onClick={removeLogo} className="p-1.5 text-surface-300 hover:text-red-400 hover:bg-red-50 rounded-lg transition-colors shrink-0" title="Remove logo">
                <Trash2 size={14} />
              </button>
            </div>
          )}

          {/* Web-link logo warning — cross-site image links render fine in the
              browser preview but almost always fail to embed in the Word
              export (other sites block cross-origin pixel access). Surface
              that mismatch here instead of letting it fail silently at export. */}
          {logoSource === 'custom' && data.logo_url && !/^data:/i.test(String(data.logo_url).trim()) && (
            <div role="alert" className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
              <AlertCircle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                This course's logo is a <strong>web link</strong>. It may display in the preview but
                usually cannot be embedded in the Word export, because other websites block
                cross-site image access. Upload the image file itself instead
                {sharedLogo && (
                  <>, or{' '}
                    <button onClick={resetToShared} className="underline font-semibold hover:no-underline">
                      switch to the shared college logo
                    </button>
                  </>
                )}.
              </span>
            </div>
          )}

          {/* Upload / URL controls — shown when no logo, or as override option */}
          {logoSource !== 'shared' || !sharedLogo ? (
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 px-3 py-2 text-xs font-medium border border-surface-200 rounded-lg cursor-pointer hover:bg-surface-50 transition-colors text-surface-600">
                <Upload size={13} /> Upload Logo
                <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
              </label>
              <span className="text-xs text-surface-400">or paste URL:</span>
              <input type="url"
                value={data.logo_url && !data.logo_url.startsWith('data:') ? data.logo_url : ''}
                onChange={e => update('logo_url', e.target.value)}
                placeholder="https://..."
                className="flex-1 min-w-0 px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
            </div>
          ) : (
            /* Shared logo is active — show subtle override option */
            <div className="flex items-center gap-3 pt-1">
              <p className="text-xs text-surface-400 flex-1">
                To use a different logo for this course only:
              </p>
              <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-surface-200 rounded-lg cursor-pointer hover:bg-surface-50 transition-colors text-surface-500">
                <Upload size={12} /> Override for this course
                <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
              </label>
            </div>
          )}

          {/* Nudge to upload shared logo if none set at all */}
          {!sharedLogo && !data.logo_url && (
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
              <span className="shrink-0 mt-0.5">💡</span>
              <span>
                Upload the logo once in the <strong>⚙ Settings gear</strong> on the Instructor Tools page
                and it will automatically appear in all syllabi — no need to upload it here each time.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Course Photo ── */}
      <div className="rounded-xl border border-surface-200 overflow-hidden">
        <div className="px-4 py-3 bg-surface-50 border-b border-surface-100 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-surface-700">Course Photo</p>
            <p className="text-xs text-surface-400 mt-0.5">Floats right next to instructor contact info in the PDF. Optional.</p>
          </div>
          {data.course_photo_url && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-full">
              <Check size={11} /> Photo set
            </span>
          )}
        </div>
        <div className="p-4 space-y-3">
          {data.course_photo_url && (
            <div className="flex items-center gap-4 bg-surface-50 border border-surface-100 rounded-lg p-3">
              <img src={data.course_photo_url} alt="Course photo preview" className="h-16 w-24 object-cover border border-surface-200 rounded flex-shrink-0" />
              <div className="flex-1 text-xs text-surface-500">
                {data.course_photo_url.startsWith('data:') ? 'Uploaded image' : data.course_photo_url.slice(0, 60) + '…'}
              </div>
              <button onClick={() => update('course_photo_url', '')}
                className="p-1.5 text-surface-300 hover:text-red-400 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0" title="Remove photo">
                <Trash2 size={14} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 px-3 py-2 text-xs font-medium border border-surface-200 rounded-lg cursor-pointer hover:bg-surface-50 transition-colors text-surface-600">
              <Upload size={13} /> {data.course_photo_url ? 'Replace Photo' : 'Upload Photo'}
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={e => {
                const file = e.target.files?.[0]
                if (!file) return
                if (file.size > 800_000) { toast.error('Image too large — use an image under 800 KB'); return }
                const reader = new FileReader()
                reader.onload = () => update('course_photo_url', reader.result)
                reader.readAsDataURL(file)
              }} />
            </label>
            <span className="text-xs text-surface-400">or paste URL:</span>
            <input type="url"
              value={data.course_photo_url && !data.course_photo_url.startsWith('data:') ? data.course_photo_url : ''}
              onChange={e => update('course_photo_url', e.target.value)}
              placeholder="https://…"
              className="flex-1 min-w-0 px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
          </div>

          {/* Alt text — federal accessibility requirement for meaningful images */}
          {data.course_photo_url && (
            <div className="space-y-1.5 pt-1">
              <label htmlFor="syl-course-photo-alt" className="text-xs font-semibold text-surface-600">
                Photo description (alt text) <span className="text-red-500" aria-hidden="true">*</span>
                <span className="font-normal text-surface-400"> — required for accessibility</span>
              </label>
              <input
                id="syl-course-photo-alt"
                type="text"
                required
                aria-required="true"
                maxLength={250}
                value={data.course_photo_alt || ''}
                onChange={e => update('course_photo_alt', e.target.value)}
                placeholder={`e.g. "Allen-Bradley PLC trainer with wired input and output modules"`}
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${(data.course_photo_alt || '').trim() ? 'border-surface-200' : 'border-amber-300 bg-amber-50/40'}`}
                aria-describedby="syl-course-photo-alt-hint"
              />
              <p id="syl-course-photo-alt-hint" className="text-xs text-surface-400 leading-snug">
                Describe what the photo shows for students using a screen reader — the equipment,
                the activity, the scene. Avoid starting with "Photo of" or "Image of."
                The syllabus cannot be exported until this is filled in.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Step3CourseInfo({ data, update }) {
  const labCredits   = parseInt(data.credits_lab) || 0
  const semLen       = data.semester_length || '16'
  const calcedHours  = calcHours(labCredits, semLen)
  const isOverridden = data.required_hours_per_week !== calcedHours
  const [manualOverride, setManualOverride] = useState(isOverridden)

  // Recalculate hours whenever lab credits or semester length changes,
  // unless the instructor has manually overridden the value.
  useEffect(() => {
    if (!manualOverride) {
      update('required_hours_per_week', calcedHours)
    }
  }, [labCredits, semLen]) // eslint-disable-line

  const handleSemLenChange = (val) => {
    update('semester_length', val)
    if (!manualOverride) {
      update('required_hours_per_week', calcHours(labCredits, val))
    }
  }

  const handleLabChange = (val) => {
    update('credits_lab', parseInt(val) || 0)
    if (!manualOverride) {
      update('required_hours_per_week', calcHours(parseInt(val) || 0, semLen))
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-surface-500">Verify the credit structure (auto-filled from the course catalog).</p>

      {/* Credits */}
      <div className="grid grid-cols-3 gap-4">
        <Field label="Lecture Credits" required>
          <NI value={data.credits_lecture} onChange={v => update('credits_lecture', parseInt(v)||0)} min={0} max={6} />
        </Field>
        <Field label="Lab Credits" required hint="Used to calculate required hours">
          <NI value={data.credits_lab} onChange={handleLabChange} min={0} max={6} />
        </Field>
        <Field label="SOE Credits">
          <NI value={data.credits_soe} onChange={v => update('credits_soe', parseInt(v)||0)} min={0} max={6} />
        </Field>
      </div>
      <p className="text-xs text-surface-400 -mt-3">
        Total: {(parseInt(data.credits_lecture)||0)+(parseInt(data.credits_lab)||0)+(parseInt(data.credits_soe)||0)} credits
      </p>

      {/* Course format */}
      <Field label="Course Delivery Format" required>
        <Sel value={data.course_type} onChange={v => {
          update('course_type', v)
          if (v === 'online') {
            update('required_hours_per_week', 0)
          } else if (!manualOverride) {
            update('required_hours_per_week', calcHours(labCredits, semLen))
          }
        }} options={[
          { value: 'hybrid',      label: 'Hybrid – Online lecture + scheduled lab hours' },
          { value: 'traditional', label: 'Traditional – Scheduled class meetings' },
          { value: 'online',      label: 'Online – No required campus hours' },
        ]} />
      </Field>

      {/* Semester length + hours — hidden for fully online courses */}
      {data.course_type !== 'online' && (
      <div className="space-y-5">
      <Field label="Semester Length" required hint="Determines required campus hours per week">
        <div className="flex gap-3 mt-0.5">
          {[
            { val: '16', label: '16-Week (Full Semester)', formula: `${labCredits} lab cr × 2 = ${calcHours(labCredits, '16')} hrs/wk` },
            { val: '8',  label: '8-Week (Half Semester)',  formula: `${labCredits} lab cr × 4 = ${calcHours(labCredits, '8')} hrs/wk` },
          ].map(opt => (
            <button
              key={opt.val}
              onClick={() => handleSemLenChange(opt.val)}
              className={`flex-1 flex flex-col items-start px-4 py-3 rounded-xl border text-left transition-colors ${
                semLen === opt.val
                  ? 'bg-brand-50 border-brand-300 text-brand-700'
                  : 'border-surface-200 text-surface-600 hover:bg-surface-50'
              }`}
            >
              <span className="text-sm font-semibold">{opt.label}</span>
              <span className={`text-xs mt-0.5 font-mono ${semLen === opt.val ? 'text-brand-500' : 'text-surface-400'}`}>
                {opt.formula}
              </span>
            </button>
          ))}
        </div>
      </Field>

      {/* Calculated hours — read-only with optional override */}
      <div className="rounded-xl border border-surface-200 p-4 bg-surface-50 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-surface-700">Required Campus Hours Per Week</p>
            <p className="text-xs text-surface-400 mt-0.5">
              {manualOverride
                ? 'Manually set — auto-calculation disabled'
                : `Auto-calculated: ${labCredits} lab credit${labCredits !== 1 ? 's' : ''} × ${semLen === '8' ? '4' : '2'} (${semLen}-week) = ${calcedHours} hrs/wk`
              }
            </p>
          </div>
          <button
            onClick={() => {
              if (manualOverride) {
                // Reset to calculated value
                update('required_hours_per_week', calcedHours)
                setManualOverride(false)
              } else {
                setManualOverride(true)
              }
            }}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
              manualOverride
                ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                : 'bg-surface-200 text-surface-500 hover:bg-surface-300'
            }`}
          >
            {manualOverride ? 'Reset to Calculated' : 'Override'}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-20 h-10 rounded-lg border-2 text-xl font-bold transition-colors ${
            manualOverride ? 'border-amber-300 text-amber-700 bg-amber-50' : 'border-brand-300 text-brand-700 bg-brand-50'
          }`}>
            {data.required_hours_per_week}
          </div>
          <span className="text-sm text-surface-500">hours per week on campus</span>
          {manualOverride && (
            <NI
              value={data.required_hours_per_week}
              onChange={v => update('required_hours_per_week', parseFloat(v) || 0)}
              min={1} max={40} step={0.5}
            />
          )}
        </div>
      </div>
      </div>
      )}

      {/* Online notice */}
      {data.course_type === 'online' && (
        <div className="flex items-center gap-2.5 bg-surface-50 border border-surface-200 rounded-xl px-4 py-3 text-sm text-surface-500">
          <Check size={15} className="text-emerald-500 shrink-0" />
          Online course — no required campus hours. Students complete all work remotely.
        </div>
      )}
    </div>
  )
}

function Step4Dates({ data, update }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-surface-500">Enter all important semester dates. Spring break and finals are optional.</p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Course Begin Date" required><TI value={data.begin_date} onChange={v => update('begin_date', v)} type="date" /></Field>
        <Field label="Course End Date" required><TI value={data.end_date} onChange={v => update('end_date', v)} type="date" /></Field>
        <Field label="Last Day to Drop (Full Refund)" required><TI value={data.last_drop_date} onChange={v => update('last_drop_date', v)} type="date" /></Field>
        <Field label="Last Day to Withdraw (Grade 'W')" required><TI value={data.last_withdraw_date} onChange={v => update('last_withdraw_date', v)} type="date" /></Field>
      </div>
      <div className="border-t border-surface-100 pt-4">
        <p className="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-3">Optional Dates</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Spring Break Start"><TI value={data.spring_break_start} onChange={v => update('spring_break_start', v)} type="date" /></Field>
          <Field label="Spring Break End"><TI value={data.spring_break_end} onChange={v => update('spring_break_end', v)} type="date" /></Field>
          <Field label="Finals Week Start"><TI value={data.finals_start} onChange={v => update('finals_start', v)} type="date" /></Field>
          <Field label="Finals Week End"><TI value={data.finals_end} onChange={v => update('finals_end', v)} type="date" /></Field>
        </div>
      </div>
    </div>
  )
}

// ─── Catalog Picker Modal (used by Step5Materials) ────────────────────────────
function CatalogPickerModal({ currentMaterials, onAdd, onRemove, onClose }) {
  const [tools, setTools]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [typeFilter, setType]   = useState('All')

  useEffect(() => {
    supabase.from('program_tools').select('*').eq('status', 'Active')
      .order('item_type').order('item_name')
      .then(({ data: rows }) => { setTools(rows || []); setLoading(false) })
  }, [])

  // Format a catalog tool as the string stored in required_materials
  function fmt(tool) {
    return tool.part_number
      ? `${tool.item_name} (Part #: ${tool.part_number})`
      : tool.item_name
  }

  function isAdded(tool) { return currentMaterials.includes(fmt(tool)) }

  const filtered = tools.filter(t => {
    const q = search.toLowerCase()
    const matchType = typeFilter === 'All' || t.item_type === typeFilter
    const matchSearch = !q || t.item_name?.toLowerCase().includes(q) || t.part_number?.toLowerCase().includes(q)
    return matchType && matchSearch
  })

  const TYPE_DOT = { Tool: 'bg-blue-400', Material: 'bg-violet-400', Supply: 'bg-teal-400', Software: 'bg-purple-400', Textbook: 'bg-orange-400' }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200 shrink-0">
          <div>
            <h3 className="text-sm font-bold text-surface-900">Browse Materials Catalog</h3>
            <p className="text-xs text-surface-500 mt-0.5">Click items to add or remove from this syllabus</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-surface-100 flex items-center justify-center transition-colors">
            <X size={15} className="text-surface-400" />
          </button>
        </div>

        {/* Search + filter */}
        <div className="flex gap-2 px-5 py-3 border-b border-surface-100 shrink-0">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search catalog…"
              className="w-full pl-7 pr-3 py-1.5 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400"
            />
          </div>
          <select value={typeFilter} onChange={e => setType(e.target.value)}
            className="px-2.5 py-1.5 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white">
            <option value="All">All</option>
            <option>Tool</option>
            <option>Material</option>
            <option>Supply</option>
            <option>Software</option>
            <option>Textbook</option>
          </select>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-surface-400 gap-2">
              <RefreshCw size={16} className="animate-spin" /><span className="text-sm">Loading…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-surface-400">
              <p className="text-sm">
                {tools.length === 0
                  ? 'Catalog is empty — add items in Required Tools & Materials'
                  : 'No items match your search'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-surface-100">
              {filtered.map(tool => {
                const added = isAdded(tool)
                return (
                  <button
                    key={tool.tool_id}
                    type="button"
                    onClick={() => added ? onRemove(fmt(tool)) : onAdd(fmt(tool))}
                    className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors
                      ${added ? 'bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-surface-50'}`}
                  >
                    {/* Check / circle */}
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors
                      ${added ? 'bg-emerald-500 border-emerald-500' : 'border-surface-300'}`}>
                      {added && <Check size={10} className="text-white" strokeWidth={3} />}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TYPE_DOT[tool.item_type] || 'bg-surface-400'}`} />
                        <span className="text-sm font-medium text-surface-800 truncate">{tool.item_name}</span>
                      </div>
                      {tool.part_number && (
                        <span className="ml-3.5 font-mono text-[11px] text-surface-500">ISBN: {tool.part_number}</span>
                      )}
                    </div>

                    {/* Cost */}
                    {tool.cost != null && (
                      <span className="text-xs font-semibold text-surface-600 flex-shrink-0">
                        ${Number(tool.cost).toFixed(2)}
                      </span>
                    )}

                    {/* Added badge */}
                    {added && (
                      <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded flex-shrink-0">
                        Added
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-100 flex items-center justify-between shrink-0 bg-surface-50">
          <span className="text-xs text-surface-500">
            {currentMaterials.length} item{currentMaterials.length !== 1 ? 's' : ''} added to syllabus
          </span>
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 5: Materials ─────────────────────────────────────────────────────────
function Step5Materials({ data, update, catalogRefreshKey = 0 }) {
  const { user, profile } = useAuth()

  const [showPicker, setShowPicker]   = useState(false)
  const [showAddNew, setShowAddNew]   = useState(false)
  const [savingNew, setSavingNew]     = useState(false)
  const [newItem, setNewItem]         = useState({ item_name: '', item_type: 'Tool', part_number: '', cost: '' })
  const [newItemError, setNewItemError] = useState('')
  const [dupMatch, setDupMatch]       = useState(null) // { type: 'catalog'|'syllabus', entry } 

  // ── Catalog cache for price lookup + edit ───────────────────────────────────
  const [catalog, setCatalog]         = useState([])    // all program_tools rows
  const [editingPrice, setEditingPrice] = useState(null) // { index, tool_id, value }
  const [savingPrice, setSavingPrice]   = useState(false)

  // Reload catalog whenever step 5 becomes active (catalogRefreshKey increments)
  useEffect(() => {
    supabase.from('program_tools').select('tool_id, item_name, part_number, cost, item_type')
      .then(({ data: rows }) => setCatalog(rows || []))
  }, [catalogRefreshKey])

  // Look up catalog entry — try exact name match first, then part number match
  function findCatalogEntry(itemStr) {
    const clean = itemStr.replace(/ \(Part #:.*?\)$/i, '').trim().toLowerCase()
    // Extract part number from string if present
    const partMatch = itemStr.match(/\(Part #:\s*([^)]+)\)/i)
    const partNum = partMatch?.[1]?.trim().toLowerCase()

    // 1. Exact name match
    let entry = catalog.find(t => t.item_name?.trim().toLowerCase() === clean)
    if (entry) return entry

    // 2. Part number match (if part number in string)
    if (partNum) {
      entry = catalog.find(t => t.part_number?.trim().toLowerCase() === partNum)
      if (entry) return entry
    }

    // 3. Contains match — handles slight naming differences
    entry = catalog.find(t => {
      const tName = t.item_name?.trim().toLowerCase()
      return tName && (tName.includes(clean) || clean.includes(tName))
    })
    return entry || null
  }

  function checkDuplicate(name) {
    if (!name.trim()) { setDupMatch(null); return }
    const q = name.trim().toLowerCase()
    // Check catalog
    const catalogHit = catalog.find(t => {
      const tName = t.item_name?.trim().toLowerCase()
      return tName === q || tName?.includes(q) || q.includes(tName)
    })
    if (catalogHit) { setDupMatch({ type: 'catalog', entry: catalogHit }); return }
    // Check already on this syllabus
    const syllabusHit = data.required_materials.find(m => {
      const clean = m.replace(/ \(Part #:.*?\)$/i, '').trim().toLowerCase()
      return clean === q || clean.includes(q) || q.includes(clean)
    })
    if (syllabusHit) { setDupMatch({ type: 'syllabus', item: syllabusHit }); return }
    setDupMatch(null)
  }

  function setNI(k, v) {
    setNewItem(p => ({ ...p, [k]: v }))
    if (k === 'item_name') checkDuplicate(v)
  }

  // ── Add from catalog ────────────────────────────────────────────────────────
  function handleAddFromCatalog(str) {
    if (!data.required_materials.includes(str)) {
      update('required_materials', [...data.required_materials, str])
      // Refresh catalog so new items show price immediately
      supabase.from('program_tools').select('tool_id, item_name, part_number, cost, item_type')
        .then(({ data: rows }) => setCatalog(rows || []))
    }
  }

  function handleRemoveFromCatalog(str) {
    update('required_materials', data.required_materials.filter(m => m !== str))
  }

  function removeItem(i) {
    update('required_materials', data.required_materials.filter((_, idx) => idx !== i))
  }

  // ── Save updated price back to program_tools ─────────────────────────────────
  async function handleSavePrice() {
    if (!editingPrice) return
    setSavingPrice(true)
    const newCost = editingPrice.value === '' ? null : parseFloat(editingPrice.value)

    try {
      if (editingPrice.tool_id) {
        // Existing catalog entry — update it
        const { error } = await supabase
          .from('program_tools')
          .update({ cost: newCost, updated_by: profile?.email || user?.email })
          .eq('tool_id', editingPrice.tool_id)
        if (error) throw error
        toast.success('Price updated in master catalog')
      } else {
        // Item not in catalog yet — create it
        const newId = 'PT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()
        const { error } = await supabase.from('program_tools').insert({
          tool_id:     newId,
          item_name:   editingPrice.item_name,
          item_type:   'Tool',
          part_number: editingPrice.part_number || null,
          cost:        newCost,
          status:      'Active',
          created_by:  profile?.email || user?.email,
          updated_by:  profile?.email || user?.email,
        })
        if (error) throw error
        toast.success(`"${editingPrice.item_name}" added to catalog with price`)
      }

      // Refresh catalog cache
      const { data: rows } = await supabase.from('program_tools')
        .select('tool_id, item_name, part_number, cost, item_type')
      setCatalog(rows || [])
      setEditingPrice(null)
    } catch (err) {
      toast.error('Price save failed: ' + err.message)
    } finally {
      setSavingPrice(false)
    }
  }

  // ── Save new item → program_tools + add to list ─────────────────────────────
  async function handleSaveNew() {
    if (!newItem.item_name.trim()) { setNewItemError('Item name is required'); return }
    setNewItemError('')
    setSavingNew(true)
    try {
      // Generate ID client-side — avoids get_next_id table-name dependency
      const idData = 'PT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()

      const { data: row, error } = await supabase
        .from('program_tools')
        .insert({
          tool_id:     idData,
          item_name:   newItem.item_name.trim(),
          item_type:   newItem.item_type || 'Tool',
          part_number: newItem.part_number?.trim() || null,
          cost:        newItem.cost !== '' ? parseFloat(newItem.cost) : null,
          status:      'Active',
          created_by:  profile?.email || user?.email,
          updated_by:  profile?.email || user?.email,
        })
        .select()
        .single()

      if (error) throw error

      // Format and add to syllabus materials list
      const str = row.part_number
        ? `${row.item_name} (Part #: ${row.part_number})`
        : row.item_name

      update('required_materials', [...data.required_materials, str])
      // Refresh catalog so price shows immediately without needing to save/reload
      const { data: freshCatalog } = await supabase
        .from('program_tools').select('tool_id, item_name, part_number, cost, item_type')
      setCatalog(freshCatalog || [])
      toast.success(`"${row.item_name}" saved to catalog and added to syllabus`)
      setNewItem({ item_name: '', item_type: 'Tool', part_number: '', cost: '' })
      setDupMatch(null)
      setShowAddNew(false)
    } catch (err) {
      toast.error('Failed to save: ' + err.message)
    } finally {
      setSavingNew(false)
    }
  }

  return (
    <div className="space-y-6">

      {/* ── Course context reminder ── */}
      {data.course_id && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5 text-sm text-blue-800">
          <BookOpen size={14} className="text-blue-500 flex-shrink-0" />
          <span>
            Materials for <span className="font-semibold">{data.course_id}</span>
            {data.course_name ? ` — ${data.course_name}` : ''}
            {data.semester ? ` · ${data.semester}` : ''}
          </span>
        </div>
      )}

      {/* ── Required Materials ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide">
            Required Materials
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setShowAddNew(false); setShowPicker(true) }}
              className="flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <BookOpen size={12} />
              Browse Catalog
            </button>
            <button
              type="button"
              onClick={() => { setShowPicker(false); setShowAddNew(v => !v) }}
              className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-800 bg-amber-50 hover:bg-amber-100 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <Plus size={12} />
              Add New Item
            </button>
          </div>
        </div>
        <p className="text-xs text-surface-400 mb-3">
          Pick from the program catalog or add a new item. New items are saved to the master catalog automatically.
        </p>

        {/* Current materials list */}
        {data.required_materials.length > 0 ? (
          <div className="space-y-1.5 mb-3">
            {data.required_materials.map((item, i) => {
              const entry = findCatalogEntry(item)
              const isEditingThis = editingPrice?.index === i
              const displayName = item.replace(/ \(Part #:.*?\)$/i, '').trim()
              const partNum = entry?.part_number || (item.match(/\(Part #:\s*([^)]+)\)/)?.[1] || null)
              return (
                <div key={i} className="flex items-center gap-2 bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 group">
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-400 flex-shrink-0" />
                  <span className="flex-1 text-sm text-surface-800">
                    {displayName}
                    {partNum && <span className="ml-1.5 font-mono text-[11px] text-surface-400">ISBN: {partNum}</span>}
                  </span>

                  {/* Price display / edit */}
                  {isEditingThis ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-xs text-surface-400">$</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={editingPrice.value}
                        onChange={e => setEditingPrice(p => ({ ...p, value: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') handleSavePrice(); if (e.key === 'Escape') setEditingPrice(null) }}
                        className="w-20 px-2 py-0.5 text-sm border border-brand-300 rounded outline-none focus:border-brand-500 bg-white"
                        autoFocus
                      />
                      <button type="button" onClick={handleSavePrice} disabled={savingPrice}
                        className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition-colors">
                        <Check size={13} />
                      </button>
                      <button type="button" onClick={() => setEditingPrice(null)}
                        className="p-1 text-surface-400 hover:bg-surface-100 rounded transition-colors">
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {entry?.cost != null ? (
                        <span className="text-xs font-semibold text-surface-700">${Number(entry.cost).toFixed(2)}</span>
                      ) : (
                        <span className="text-xs text-surface-400 italic">No price</span>
                      )}
                      {/* Show pencil for catalog entries AND for items not yet in catalog */}
                      <button
                        type="button"
                        onClick={() => setEditingPrice({
                          index: i,
                          tool_id: entry?.tool_id || null,
                          item_name: displayName,
                          part_number: partNum || null,
                          value: entry?.cost != null ? String(entry.cost) : ''
                        })}
                        className="opacity-0 group-hover:opacity-100 p-1 text-surface-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-all ml-0.5"
                        title={entry ? "Edit price" : "Set price (will add to catalog)"}
                      >
                        <Pencil size={11} />
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-all ml-1 flex-shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="border border-dashed border-surface-200 rounded-xl px-4 py-6 text-center mb-3">
            <p className="text-sm text-surface-400">No materials added yet.</p>
            <p className="text-xs text-surface-400 mt-1">Use "Browse Catalog" to pick from existing items, or "Add New Item" to create one.</p>
          </div>
        )}

        {/* Add New Item inline form */}
        {showAddNew && (
          <div className="border border-amber-200 bg-amber-50/60 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-amber-800 uppercase tracking-wide flex items-center gap-1.5">
              <Plus size={11} /> New Item — Saves to Master Catalog
            </p>
            <div>
              <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">
                Item Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newItem.item_name}
                onChange={e => { setNI('item_name', e.target.value); setNewItemError('') }}
                placeholder="e.g. Wire Stripper — Needle Nose"
                className={`w-full px-3 py-2 text-sm border rounded-lg outline-none bg-white
                  ${newItemError ? 'border-red-300 focus:border-red-400' : 'border-surface-200 focus:border-brand-400'}`}
              />
              {newItemError && <p className="mt-1 text-xs text-red-500">{newItemError}</p>}
            </div>

            {/* Duplicate warning */}
            {dupMatch && (
              <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-1.5
                ${dupMatch.type === 'syllabus' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                <p className={`font-semibold flex items-center gap-1.5 ${dupMatch.type === 'syllabus' ? 'text-red-700' : 'text-amber-800'}`}>
                  <AlertCircle size={12} />
                  {dupMatch.type === 'syllabus'
                    ? 'Already on this syllabus'
                    : 'Similar item exists in catalog'}
                </p>
                {dupMatch.type === 'catalog' && (
                  <p className="text-amber-700">
                    Found: <strong>{dupMatch.entry.item_name}</strong>
                    {dupMatch.entry.part_number && <span className="ml-1 font-mono">#{dupMatch.entry.part_number}</span>}
                    {dupMatch.entry.cost != null && <span className="ml-1">(${Number(dupMatch.entry.cost).toFixed(2)})</span>}
                  </p>
                )}
                {dupMatch.type === 'syllabus' && (
                  <p className="text-red-700">Already added: <strong>{dupMatch.item.replace(/ \(Part #:.*?\)$/i, '')}</strong></p>
                )}
                <div className="flex gap-2 pt-0.5">
                  {dupMatch.type === 'catalog' && (
                    <button type="button"
                      onClick={() => {
                        const str = dupMatch.entry.part_number
                          ? `${dupMatch.entry.item_name} (Part #: ${dupMatch.entry.part_number})`
                          : dupMatch.entry.item_name
                        handleAddFromCatalog(str)
                        setShowAddNew(false)
                        setNewItem({ item_name: '', item_type: 'Tool', part_number: '', cost: '' })
                        setDupMatch(null)
                      }}
                      className="px-2.5 py-1 text-[11px] font-semibold bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors">
                      Use Existing Item
                    </button>
                  )}
                  <button type="button" onClick={() => setDupMatch(null)}
                    className="px-2.5 py-1 text-[11px] font-semibold border border-surface-300 text-surface-600 rounded-md hover:bg-surface-50 transition-colors">
                    Add Anyway
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Type</label>
                <select value={newItem.item_type} onChange={e => setNI('item_type', e.target.value)}
                  className="w-full px-2.5 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white">
                  <option>Tool</option>
                  <option>Material</option>
                  <option>Supply</option>
                  <option>Software</option>
                  <option>Textbook</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">ISBN Number</label>
                <input type="text" value={newItem.part_number} onChange={e => setNI('part_number', e.target.value)}
                  placeholder="e.g. 12120-N"
                  className="w-full px-2.5 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Cost</label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-surface-400 select-none">$</span>
                  <input type="number" step="0.01" min="0" value={newItem.cost} onChange={e => setNI('cost', e.target.value)}
                    placeholder="0.00"
                    className="w-full pl-5 pr-2 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => { setShowAddNew(false); setNewItemError(''); setDupMatch(null) }}
                className="flex-1 py-2 text-sm font-medium border border-surface-200 text-surface-600 rounded-lg hover:bg-surface-50 transition-colors bg-white">
                Cancel
              </button>
              <button type="button" onClick={handleSaveNew} disabled={savingNew}
                className="flex-1 py-2 text-sm font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                {savingNew
                  ? <><RefreshCw size={13} className="animate-spin" /> Saving…</>
                  : <><Check size={13} /> Save & Add to Syllabus</>
                }
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Required Technology ── */}
      <div className="border-t border-surface-100 pt-4">
        <Field label="Required Technology" hint="Pre-filled with standard SCTCC requirements — edit as needed">
          <ItemList items={data.required_technology} onChange={v => update('required_technology', v)}
            placeholder="e.g. Active SCTCC email account" addLabel="Add Technology" />
        </Field>
      </div>

      {/* ── Pre/Co-Reqs ── */}
      <div className="border-t border-surface-100 pt-4 space-y-4">
        <Field label="Pre/Co-Requisites" hint="e.g. ETEC 1512 – AC Electronics">
          <TI value={data.prerequisites} onChange={v => update('prerequisites', v)} placeholder="RICT 1510 – AC Electronics" />
        </Field>
        <Field label="Restricted to Major(s)">
          <TI value={data.restricted_to} onChange={v => update('restricted_to', v)} placeholder="Instrumentation & Process Control AAS" />
        </Field>
      </div>

      {/* Catalog picker modal */}
      {showPicker && (
        <CatalogPickerModal
          currentMaterials={data.required_materials}
          onAdd={handleAddFromCatalog}
          onRemove={handleRemoveFromCatalog}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

function Step6Description({ data, update }) {
  return (
    <div className="space-y-5">
      <Field label="Course Description" required hint="Paragraph describing what the course covers">
        <TA value={data.course_description} onChange={v => update('course_description', v)} rows={5} placeholder="This course provides a comprehensive introduction to..." />
      </Field>
      <Field label="Student Learning Outcomes" hint="Each outcome will be numbered automatically in the PDF">
        <ItemList items={data.student_outcomes} onChange={v => update('student_outcomes', v)} placeholder="e.g. Understand the working principles of various sensors." addLabel="Add Outcome" />
      </Field>
    </div>
  )
}

function Step7Grading({ data, update }) {
  const totalPoints = (data.assessments || []).reduce((s, a) => s + (parseInt(a.points) || 0), 0)
  const passFail = data.grading_mode === 'pass_fail'
  // Announced to screen readers when the grading fields show/hide
  const [modeAnnounce, setModeAnnounce] = useState('')
  const setMode = (mode) => {
    if (mode === data.grading_mode) return
    update('grading_mode', mode)
    setModeAnnounce(mode === 'pass_fail'
      ? 'Pass/Fail selected. Letter-grade minimums and point values are hidden; the syllabus will state that this is a pass/fail course.'
      : 'Graded selected. Letter-grade minimums and point values are shown.')
  }

  // ── Volunteer hours toggle ───────────────────────────────────────────────────
  // No new DB column: "no volunteer hours" is expressed as volunteer_hours_required = 0.
  // Drafts saved with 0 automatically load with the checkbox checked; older drafts
  // (5, 6, etc.) load unchecked with their saved value intact.
  const noVolunteerHours = (parseInt(data.volunteer_hours_required) || 0) === 0
  // Remember the last non-zero value so unchecking the box restores what was there.
  const lastVolunteerHours = useRef(
    (parseInt(data.volunteer_hours_required) || 0) > 0 ? parseInt(data.volunteer_hours_required) : 5
  )
  const toggleNoVolunteer = (checked) => {
    if (checked) {
      const current = parseInt(data.volunteer_hours_required) || 0
      if (current > 0) lastVolunteerHours.current = current
      update('volunteer_hours_required', 0)
    } else {
      update('volunteer_hours_required', lastVolunteerHours.current || 5)
    }
  }

  const addA    = () => update('assessments', [...(data.assessments||[]), { id: Date.now(), name: '', points: 0, description: '' }])
  const removeA = (id) => update('assessments', (data.assessments||[]).filter(a => a.id !== id))
  const updateA = (id, f, v) => update('assessments', (data.assessments||[]).map(a => a.id === id ? { ...a, [f]: v } : a))

  // ── Drag-to-reorder ──────────────────────────────────────────────────────────
  const dragId  = useRef(null)
  const dragOver = useRef(null)

  function handleDragStart(id) { dragId.current = id }
  function handleDragEnter(id) { dragOver.current = id }
  function handleDragEnd() {
    if (dragId.current === null || dragOver.current === null || dragId.current === dragOver.current) return
    const list = [...(data.assessments || [])]
    const fromIdx = list.findIndex(a => a.id === dragId.current)
    const toIdx   = list.findIndex(a => a.id === dragOver.current)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = list.splice(fromIdx, 1)
    list.splice(toIdx, 0, moved)
    update('assessments', list)
    dragId.current = null
    dragOver.current = null
  }
  // Keyboard-accessible alternative to dragging (WCAG 2.1.1)
  function moveA(id, dir) {
    const list = [...(data.assessments || [])]
    const idx = list.findIndex(a => a.id === id)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= list.length) return
    const [moved] = list.splice(idx, 1)
    list.splice(to, 0, moved)
    update('assessments', list)
  }
  const rowCols = passFail ? 'grid-cols-[20px_1fr_2fr_56px_36px]' : 'grid-cols-[20px_1fr_2fr_100px_56px_36px]'

  return (
    <div className="space-y-6">
      {/* ── Grading mode ─────────────────────────────────────────────────────── */}
      <fieldset className="border border-surface-200 rounded-xl p-4">
        <legend className="px-1.5 text-sm font-semibold text-surface-700">How is this course graded?</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
          {[
            { value: 'graded',    title: 'Graded course',    desc: 'Letter grades (A/B/C/F) from a point-based scale. The syllabus shows the assessment points table and grading scale.' },
            { value: 'pass_fail', title: 'Pass/Fail course', desc: 'No letter grades. The grading scale and point values are removed and replaced with a Pass/Fail statement.' },
          ].map(opt => {
            const checked = (data.grading_mode || 'graded') === opt.value
            return (
              <label
                key={opt.value}
                htmlFor={`syllabus-grading-mode-${opt.value}`}
                className={`flex items-start gap-3 min-h-[44px] p-3 rounded-lg border cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-brand-500/40 ${checked ? 'border-brand-400 bg-brand-50/60' : 'border-surface-200 bg-white hover:border-brand-200'}`}
              >
                <input
                  type="radio"
                  id={`syllabus-grading-mode-${opt.value}`}
                  name="syllabus-grading-mode"
                  value={opt.value}
                  checked={checked}
                  onChange={() => setMode(opt.value)}
                  className="mt-0.5 h-4 w-4 border-surface-300 text-brand-600 focus:outline-none"
                />
                <span className="select-none">
                  <span className="block text-sm font-semibold text-surface-800">{opt.title}</span>
                  <span className="block text-xs text-surface-500 mt-0.5">{opt.desc}</span>
                </span>
              </label>
            )
          })}
        </div>
        <div aria-live="polite" className="sr-only">{modeAnnounce}</div>
      </fieldset>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-surface-700">{passFail ? 'Required Activities' : 'Assessment Items'}</p>
            <p className="text-xs text-surface-400 mt-0.5">
              {passFail
                ? 'Optional — list what students must complete to pass. No point values are shown on a pass/fail syllabus.'
                : 'Drag the ≡ handle or use the arrow buttons to reorder rows.'}
            </p>
          </div>
          {!passFail && <span className="text-xs bg-brand-50 text-brand-600 font-semibold px-2.5 py-1 rounded-full">Total: {totalPoints} pts</span>}
        </div>
        <div className="space-y-1.5">
          <div className={`grid ${rowCols} gap-2 px-3 py-1.5 bg-surface-50 rounded-lg text-xs font-semibold text-surface-500 uppercase tracking-wide`}>
            <span /><span>{passFail ? 'Activity Name' : 'Assessment Name'}</span><span>Note / Description</span>{!passFail && <span className="text-right">Points</span>}<span className="sr-only">Reorder</span><span className="sr-only">Remove</span>
          </div>
          {(data.assessments||[]).map((a, idx, arr) => {
            const rowName = a.name || `item ${idx + 1}`
            return (
            <div
              key={a.id}
              draggable
              onDragStart={() => handleDragStart(a.id)}
              onDragEnter={() => handleDragEnter(a.id)}
              onDragEnd={handleDragEnd}
              onDragOver={e => e.preventDefault()}
              className={`grid ${rowCols} gap-2 items-center bg-white border border-surface-100 rounded-lg px-2 py-1 hover:border-brand-200 transition-colors`}
            >
              {/* Drag handle (mouse) — keyboard users have the arrow buttons */}
              <div aria-hidden="true" className="flex items-center justify-center cursor-grab active:cursor-grabbing text-surface-300 hover:text-surface-500 select-none">
                <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
                  <circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>
                  <circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/>
                  <circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/>
                </svg>
              </div>
              <input value={a.name} onChange={e => updateA(a.id, 'name', e.target.value)} placeholder={passFail ? 'Activity name' : 'Assessment name'} aria-label={`${passFail ? 'Activity' : 'Assessment'} name, row ${idx + 1}`} className="px-2.5 py-1.5 border border-surface-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-400" />
              <input value={a.description} onChange={e => updateA(a.id, 'description', e.target.value)} placeholder="Optional note" aria-label={`Note for ${rowName}`} className="px-2.5 py-1.5 border border-surface-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-400" />
              {!passFail && (
                <input type="number" value={a.points} onChange={e => updateA(a.id, 'points', parseInt(e.target.value)||0)} min={0} aria-label={`Points for ${rowName}`} className="px-2.5 py-1.5 border border-surface-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-400" />
              )}
              <div className="flex items-center justify-center gap-0.5">
                <button type="button" onClick={() => moveA(a.id, -1)} disabled={idx === 0} aria-label={`Move ${rowName} up`} className="p-1 text-surface-400 hover:text-brand-600 hover:bg-brand-50 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 transition-colors"><ChevronUp size={14} aria-hidden="true" /></button>
                <button type="button" onClick={() => moveA(a.id, 1)} disabled={idx === arr.length - 1} aria-label={`Move ${rowName} down`} className="p-1 text-surface-400 hover:text-brand-600 hover:bg-brand-50 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 transition-colors"><ChevronDown size={14} aria-hidden="true" /></button>
              </div>
              <button type="button" onClick={() => removeA(a.id)} aria-label={`Remove ${rowName}`} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors"><Trash2 size={13} aria-hidden="true" /></button>
            </div>
            )
          })}
          <button type="button" onClick={addA} className="flex items-center gap-1.5 text-xs text-brand-600 font-medium hover:text-brand-700 py-1 mt-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 rounded"><Plus size={13} aria-hidden="true" /> {passFail ? 'Add Required Activity' : 'Add Assessment Item'}</button>
        </div>
      </div>
      {!passFail && (
        <div className="border-t border-surface-100 pt-4 grid grid-cols-3 gap-4">
          <Field label="Grade A Minimum %"><NI value={data.grading_a_min} onChange={v => update('grading_a_min', parseInt(v)||90)} min={50} max={100} /></Field>
          <Field label="Grade B Minimum %"><NI value={data.grading_b_min} onChange={v => update('grading_b_min', parseInt(v)||80)} min={40} max={99} /></Field>
          <Field label="Grade C Minimum %"><NI value={data.grading_c_min} onChange={v => update('grading_c_min', parseInt(v)||70)} min={30} max={99} /></Field>
        </div>
      )}
      <div className="border-t border-surface-100 pt-4 space-y-3">
        <div className="flex items-center gap-2.5 min-h-[44px]">
          <input
            type="checkbox"
            id="syllabus-no-volunteer-hours"
            checked={noVolunteerHours}
            onChange={e => toggleNoVolunteer(e.target.checked)}
            className="h-4 w-4 rounded border-surface-300 text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 cursor-pointer"
          />
          <label htmlFor="syllabus-no-volunteer-hours" className="text-sm text-surface-700 cursor-pointer select-none py-2">
            This course does <span className="font-semibold">not</span> require volunteer hours
            <span className="block text-xs text-surface-400 font-normal">Check for online or hybrid courses without a volunteer requirement — the volunteer hours paragraph is omitted from the syllabus.</span>
          </label>
        </div>
        {!noVolunteerHours && (
          <Field label="Volunteer Hours Required">
            <NI
              value={data.volunteer_hours_required}
              onChange={v => update('volunteer_hours_required', parseInt(v)||5)}
              min={1} max={50}
              ariaLabel="Volunteer hours required"
            />
          </Field>
        )}
      </div>
      <Field label="Time Commitment Note" hint="Leave blank to auto-generate based on credit hours">
        <TA value={data.time_commitment_notes} onChange={v => update('time_commitment_notes', v)} rows={3} placeholder="Leave blank to auto-generate…" />
      </Field>
    </div>
  )
}

// ─── Step 8: Preview ──────────────────────────────────────────────────────────
function Step8Review({ data, commonSections, onGenerate, onDownloadDocx, saving, docxBusy, onCreateClass, onJumpToStep }) {
  const totalPoints = (data.assessments||[]).reduce((s, a) => s + (parseInt(a.points)||0), 0)
  const blobRef = useRef(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [scale, setScale] = useState(72)

  // Each check carries the wizard step where it can be fixed — the rows are
  // clickable jumps, which matters now that the Syllabus Library opens
  // completed syllabi directly on this step (instructors no longer pass
  // through the earlier steps where a gap would have been noticed).
  const checks = [
    { label: 'Course selected',     ok: !!data.course_id,                                     step: 1 },
    { label: 'Instructor name',     ok: !!data.instructor_name,                               step: 2 },
    { label: 'Instructor email',    ok: !!data.instructor_email,                              step: 2 },
    { label: 'Begin & end dates',   ok: !!data.begin_date && !!data.end_date,                 step: 4 },
    { label: 'Drop/withdraw dates', ok: !!data.last_drop_date && !!data.last_withdraw_date,   step: 4 },
    { label: 'Course description',  ok: !!data.course_description,                            step: 6 },
    { label: 'Student outcomes',    ok: (data.student_outcomes||[]).length > 0,               step: 6 },
    // Pass/fail courses have no point values — only require a named activity list
    data.grading_mode === 'pass_fail'
      ? { label: 'Required activities', ok: (data.assessments||[]).some(a => (a.name||'').trim()), step: 7 }
      : { label: 'Assessments',         ok: (data.assessments||[]).length > 0 && totalPoints > 0, step: 7 },
    // Federal accessibility requirement: a course photo must have a description
    ...(data.course_photo_url ? [{ label: 'Photo description (alt text)', ok: !!(data.course_photo_alt || '').trim(), step: 2 }] : []),
  ]
  const missingCount = checks.filter(c => !c.ok).length
  const stepLabel = (id) => STEPS.find(s => s.id === id)?.label || `step ${id}`

  const refresh = useCallback(() => {
    setLoading(true)
    const html = generateSyllabusHTML(data, commonSections)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    if (blobRef.current) URL.revokeObjectURL(blobRef.current)
    const url = URL.createObjectURL(blob)
    blobRef.current = url
    setPreviewUrl(url)
  }, [data, commonSections])

  useEffect(() => {
    refresh()
    return () => { if (blobRef.current) URL.revokeObjectURL(blobRef.current) }
  }, []) // eslint-disable-line

  const fmtTs = ts => {
    if (!ts) return null
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Left panel */}
      <div className="flex flex-col border-r border-surface-100 overflow-y-auto shrink-0" style={{ width: 272 }}>
        <div className="flex-1 px-5 pt-5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide">Readiness</p>
              {missingCount > 0 ? (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                  {missingCount} to fix
                </span>
              ) : (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                  All set
                </span>
              )}
            </div>
            <div className="space-y-1">
              {checks.map(c => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => onJumpToStep && onJumpToStep(c.step)}
                  aria-label={`${c.label}: ${c.ok ? 'complete' : 'needs attention'}. Go to the ${stepLabel(c.step)} step.`}
                  className={`w-full min-h-[44px] flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 ${c.ok
                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
                >
                  {c.ok ? <Check size={11} className="shrink-0 text-emerald-500" aria-hidden="true" /> : <AlertCircle size={11} className="shrink-0 text-amber-500" aria-hidden="true" />}
                  <span className="flex-1">{c.label}</span>
                  <ChevronRight size={11} className="shrink-0 opacity-40" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <div className="border border-surface-100 rounded-xl p-3 bg-surface-50">
            <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Clock size={11} /> PDF Export History</p>
            {data.pdf_generated_at ? (
              <div className="space-y-0.5">
                <p className="text-xs text-surface-600">Last exported:</p>
                <p className="text-xs text-emerald-600 font-medium">{fmtTs(data.pdf_generated_at)}</p>
                <p className="text-xs text-surface-400">Total exports: {data.pdf_generated_count || 1}&times;</p>
              </div>
            ) : <p className="text-xs text-surface-400 italic">Not yet exported this semester.</p>}
          </div>
          <div>
            <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-2">Summary</p>
            <div className="space-y-1 text-xs">
              {[
                ['Course', `${data.course_id} – ${data.course_name}`],
                ['Semester', data.semester],
                ['Instructor', data.instructor_name || '—'],
                ...(data.instructor2_enabled && data.instructor2_name ? [['Co-Instructor', data.instructor2_name]] : []),
                ['Credits', `L${data.credits_lecture}/Lab${data.credits_lab}/SOE${data.credits_soe}`],
                ['Points', `${totalPoints} pts`],
                ['Outcomes', `${(data.student_outcomes||[]).length}`],
                ...(data.logo_url ? [['Logo', '✓ Embedded']] : []),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="text-surface-400 shrink-0">{k}</span>
                  <span className="text-surface-700 font-medium text-right truncate">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-surface-100 space-y-2">
          <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700 leading-snug" role="note">
            <FileText size={11} className="inline mr-1" aria-hidden="true" />
            <strong>For a fully accessible PDF (required for D2L/Ally compliance):</strong> download
            the Word file, open it in Microsoft Word, then choose <strong>File → Save As → PDF</strong>.
            Word embeds the heading and list structure that accessibility checkers require —
            the browser Print option below cannot.
            {' '}<strong>Do not use the Acrobat tab (&quot;Create PDF&quot; / PDFMaker) or
            Print → Adobe PDF</strong> — those converters strip the image alt text and the
            syllabus will fail the Ally check.
          </div>
          <button onClick={onDownloadDocx} disabled={saving || docxBusy}
            className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-sm">
            <Download size={15} aria-hidden="true" />{docxBusy ? 'Building Word file…' : 'Download Accessible Word (.docx)'}
          </button>
          <button onClick={onGenerate} disabled={saving || docxBusy}
            className="w-full py-2.5 bg-white text-surface-700 font-semibold rounded-xl border border-surface-200 hover:bg-surface-50 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-sm">
            <Printer size={15} aria-hidden="true" />{saving ? 'Saving…' : 'Print PDF (browser — not fully accessible)'}
          </button>

          {/* CMMS class prompt — only shown after at least one PDF has been generated */}
          {data.pdf_generated_at && (
            <div className="border border-emerald-200 rounded-xl bg-emerald-50 p-3 space-y-2">
              <p className="text-xs font-semibold text-emerald-800 flex items-center gap-1.5">
                <GraduationCap size={13} /> Add to CMMS?
              </p>
              <p className="text-xs text-emerald-700 leading-snug">
                Create a class entry in the CMMS so students can be enrolled for <strong>{data.semester}</strong>.
              </p>
              <button
                onClick={onCreateClass}
                className="w-full py-2 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center justify-center gap-1.5"
              >
                <PlusCircle size={13} /> Add Class to CMMS
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="flex-1 flex flex-col bg-surface-100 min-w-0 min-h-0">
        <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-surface-100 shrink-0">
          <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide flex items-center gap-1.5"><Eye size={12} /> Live Preview</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-surface-400">Zoom</span>
              <input type="range" min={40} max={100} step={5} value={scale} onChange={e => setScale(parseInt(e.target.value))} className="w-20 accent-brand-600" />
              <span className="text-xs text-surface-500 font-medium w-8">{scale}%</span>
            </div>
            <button onClick={refresh} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-surface-600 border border-surface-200 rounded-lg hover:bg-surface-50 transition-colors" title="Regenerate preview with latest data">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <div style={{ width: Math.round(816 * scale / 100), margin: '0 auto', position: 'relative' }}>
            {loading && <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 rounded"><RefreshCw size={20} className="animate-spin text-surface-400" /></div>}
            {previewUrl && (
              <iframe key={previewUrl} src={previewUrl} title="Syllabus Preview" onLoad={() => setLoading(false)}
                style={{ width: 816, height: 1100, border: 'none', background: 'white', display: 'block', transformOrigin: 'top left', transform: `scale(${scale / 100})`, boxShadow: '0 4px 24px rgba(0,0,0,0.15)', borderRadius: 3 }} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Step Progress Bar ────────────────────────────────────────────────────────
function StepProgress({ current, onClickStep }) {
  return (
    <div className="px-6 pb-4 border-b border-surface-100">
      <div className="flex items-center gap-0">
        {STEPS.map((step, i) => (
          <div key={step.id} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-0.5 min-w-0">
              <button onClick={() => { if (step.id < current) { if (step.id === 5) setCatalogRefreshKey && setCatalogRefreshKey(k => k + 1); onClickStep(step.id) } }} disabled={step.id > current}
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${step.id < current ? 'bg-brand-600 text-white hover:bg-brand-700 cursor-pointer' : step.id === current ? 'bg-brand-600 text-white ring-2 ring-brand-200' : 'bg-surface-100 text-surface-400 cursor-default'}`}>
                {step.id < current ? <Check size={12} /> : step.id}
              </button>
              <span className={`text-[10px] font-medium leading-tight text-center hidden sm:block ${step.id === current ? 'text-brand-600' : 'text-surface-400'}`}>{step.label}</span>
            </div>
            {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-1 ${step.id < current ? 'bg-brand-600' : 'bg-surface-100'}`} />}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
// initialCourseId / initialSemester: optional — when provided (e.g. launched from
// the Syllabus Library), the wizard opens preloaded to that course + semester.
// initialStep: which step to land on when the wizard opens. The Syllabus
// Library passes 8 (Review & export) for already-saved syllabi so instructors
// go straight to the finished document; the step bar and Back buttons still
// allow walking backward through the wizard from there.
// Defaults preserve the original blank-start behavior exactly.
export default function SyllabusWizard({ onClose, initialCourseId = null, initialSemester = null, initialStep = 1 }) {
  const { user } = useAuth()
  const [step, setStep] = useState(initialStep)
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0)
  const [data, setData] = useState(() => ({
    ...EMPTY_SYLLABUS,
    ...(initialCourseId ? { course_id: initialCourseId } : {}),
    ...(initialSemester ? { semester: initialSemester } : {}),
  }))
  const [courseCatalog, setCourseCatalog] = useState([])  // from syllabus_courses, NOT classes
  const [commonSections, setCommonSections] = useState([])
  const [saving, setSaving] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [savedExists, setSavedExists] = useState(false)
  const [otherSemesters, setOtherSemesters] = useState([]) // saved drafts for this course under OTHER semesters
  const [showCreateClass, setShowCreateClass] = useState(false) // post-PDF CMMS prompt

  const update = useCallback((field, value) => setData(prev => ({ ...prev, [field]: value })), [])

  // Load course catalog (syllabus_courses) + common sections — NOT CMMS classes
  useEffect(() => {
    supabase.from('syllabus_courses').select('*').eq('status', 'active').order('course_id')
      .then(({ data: rows }) => { if (rows) setCourseCatalog(rows) })
    supabase.from('syllabus_common_sections').select('*')
      .then(({ data: rows }) => { if (rows) setCommonSections(rows) })
  }, [])

  // Load saved syllabus template when course_id + semester changes.
  // Also fetches the catalog entry so description/outcomes are always backfilled
  // from syllabus_courses if the saved template has them blank.
  useEffect(() => {
    if (!data.course_id || !data.semester) return
    setLoadingData(true)
    setSavedExists(false)
    Promise.all([
      supabase.from('syllabus_templates').select('*')
        .eq('course_id', data.course_id).eq('semester', data.semester).maybeSingle(),
      supabase.from('syllabus_courses')
        .select('course_description,student_outcomes,prerequisites')
        .eq('course_id', data.course_id).maybeSingle(),
      // All saved semesters for this course — used to surface drafts saved under a
      // different semester so instructors never think their work was lost.
      // Archived templates are excluded (restore them via the Syllabus Library).
      supabase.from('syllabus_templates')
        .select('semester,updated_at')
        .eq('course_id', data.course_id)
        .neq('status', 'archived'),
    ]).then(([{ data: row }, { data: catalogRow }, { data: allRows }]) => {
      const others = (allRows || [])
        .filter(r => r.semester !== data.semester)
        .sort((a, b) => SEMESTERS.indexOf(a.semester) - SEMESTERS.indexOf(b.semester))
      setOtherSemesters(others)
      if (row) {
        setSavedExists(true)
        setData(prev => ({
          ...EMPTY_SYLLABUS,
          ...prev,
          ...row,
          required_materials:  Array.isArray(row.required_materials)  ? row.required_materials  : [],
          required_technology: Array.isArray(row.required_technology) ? row.required_technology : EMPTY_SYLLABUS.required_technology,
          course_photo_url:    row.course_photo_url || '',
          // Backfill from catalog if template has empty description/outcomes
          course_description:  row.course_description  || catalogRow?.course_description  || '',
          prerequisites:       row.prerequisites       || catalogRow?.prerequisites       || '',
          student_outcomes:    (Array.isArray(row.student_outcomes) && row.student_outcomes.length > 0)
            ? row.student_outcomes
            : (Array.isArray(catalogRow?.student_outcomes) ? catalogRow.student_outcomes : []),
          assessments:         Array.isArray(row.assessments) ? row.assessments : EMPTY_SYLLABUS.assessments,
          grading_mode:        row.grading_mode === 'pass_fail' ? 'pass_fail' : 'graded',
        }))
      } else if (catalogRow) {
        // No saved template — pre-populate description/outcomes from catalog
        setData(prev => ({
          ...prev,
          course_description: prev.course_description || catalogRow.course_description || '',
          student_outcomes:   (prev.student_outcomes?.length > 0)
            ? prev.student_outcomes
            : (Array.isArray(catalogRow.student_outcomes) ? catalogRow.student_outcomes : []),
          prerequisites:      prev.prerequisites || catalogRow.prerequisites || '',
        }))
      }
      setLoadingData(false)
    })
  }, [data.course_id, data.semester])

  const handleSave = useCallback(async (extraFields = {}) => {
    if (!data.course_id) { toast.error('Select a course first'); return false }
    setSaving(true)
    // Sanitize: convert empty strings to null for date columns so Postgres doesn't choke
    const DATE_FIELDS = ['begin_date','end_date','last_drop_date','last_withdraw_date',
      'spring_break_start','spring_break_end','finals_start','finals_end','revised_date']
    const sanitized = { ...data }
    DATE_FIELDS.forEach(f => { if (sanitized[f] === '') sanitized[f] = null })
    const payload = {
      ...sanitized, ...extraFields,
      // Ensure calculated hours are always in sync before saving
      required_hours_per_week: extraFields.required_hours_per_week ?? data.required_hours_per_week,
      updated_at:  new Date().toISOString(),
      updated_by:  user?.email || '',
      created_by:  data.created_by || user?.email || '',
    }
    delete payload.id
    const { data: savedRows, error } = await supabase.from('syllabus_templates')
      .upsert(payload, { onConflict: 'course_id,semester' }).select()
    setSaving(false)
    if (error) { toast.error('Save failed: ' + error.message); return false }
    // RLS silent-failure guard: a blocked write returns no error but zero rows
    if (!savedRows || savedRows.length === 0) {
      toast.error('Save was blocked — no rows written. Check permissions or contact an administrator.')
      return false
    }
    setSavedExists(true)
    toast.success(`Draft saved for ${data.course_id} · ${data.semester}`)
    return true
  }, [data, user])

  const [docxBusy, setDocxBusy] = useState(false)

  // Federal accessibility requirement: a course photo may not be exported
  // without a written description (alt text). Both export paths call this.
  const photoAltMissing = () => {
    if (data.course_photo_url && !(data.course_photo_alt || '').trim()) {
      toast.error('The course photo needs a description (alt text) before exporting — see the Course Photo section on the Instructor step.', { duration: 6000 })
      return true
    }
    return false
  }

  // Accessible Word export — the compliant path to a 100% Ally-scored PDF.
  // Saves the draft and bumps the export counter (same tracking as the print
  // path) so the "Add to CMMS" prompt and export history keep working.
  const handleDownloadDocx = async () => {
    if (photoAltMissing()) return
    const now = new Date().toISOString()
    const newCount = (data.pdf_generated_count || 0) + 1
    const ok = await handleSave({ pdf_generated_at: now, pdf_generated_count: newCount })
    if (!ok) return
    setData(prev => ({ ...prev, pdf_generated_at: now, pdf_generated_count: newCount }))
    setDocxBusy(true)
    try {
      const result = await downloadSyllabusDocx(data, commonSections, DEFAULT_COMMON_SECTIONS)
      toast.success('Word file downloaded — open in Word, then File → Save As → PDF (not the Acrobat tab, which strips alt text).', { duration: 8000 })
      if (result?.logoUsedFallback) {
        toast(`This course's saved logo could not be embedded, so the shared college logo was used instead. On the Instructor step, choose "Reset to shared logo" to clear the old value. (${result.logoStatus || ''})`, { icon: '⚠️', duration: 12000 })
      } else if (result?.logoMissing) {
        toast.error(`The college logo could not be embedded in the Word file (${result.logoStatus || 'unknown reason'}). Re-uploading the logo as a PNG in the Settings gear will fix it.`, { duration: 12000 })
      }
      if (result?.photoMissing) {
        toast.error(`The course photo could not be embedded in the Word file (${result.photoStatus || 'unknown reason'}). Try re-uploading the image.`, { duration: 12000 })
      }
    } catch (e) {
      toast.error('Word export failed: ' + (e?.message || String(e)))
    } finally {
      setDocxBusy(false)
    }
  }

  const handleGenerate = async () => {
    if (photoAltMissing()) return
    const now = new Date().toISOString()
    const newCount = (data.pdf_generated_count || 0) + 1
    const ok = await handleSave({ pdf_generated_at: now, pdf_generated_count: newCount })
    if (!ok) return
    setData(prev => ({ ...prev, pdf_generated_at: now, pdf_generated_count: newCount }))
    const html = generateSyllabusHTML(data, commonSections)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (win) {
      win.addEventListener('load', () => {
        setTimeout(() => { win.focus(); win.print() }, 350)
        win.addEventListener('afterprint', () => win.close())
      })
    } else {
      toast.error('Pop-up blocked — please allow pop-ups for this site.')
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000)
    toast.success('PDF opened — choose "Save as PDF" in the print dialog.')
  }

  const handleDuplicate = async (targetSemester) => {
    const newData = {
      ...data, id: null, semester: targetSemester,
      status: 'active',   // a duplicate is fresh working copy, even if the source was archived
      begin_date: '', end_date: '', last_drop_date: '', last_withdraw_date: '',
      spring_break_start: '', spring_break_end: '', finals_start: '', finals_end: '',
      pdf_generated_at: null, pdf_generated_count: 0,
      revised_date: new Date().toISOString().split('T')[0],
      created_by: user?.email || '',
    }
    const payload = { ...newData, updated_at: new Date().toISOString(), updated_by: user?.email || '' }
    delete payload.id
    const { data: dupRows, error } = await supabase.from('syllabus_templates')
      .upsert(payload, { onConflict: 'course_id,semester' }).select()
    if (error) { toast.error('Duplicate failed: ' + error.message); return }
    if (!dupRows || dupRows.length === 0) {
      toast.error('Duplicate was blocked — no rows written. Check permissions or contact an administrator.')
      return
    }
    setData(newData)
    setSavedExists(false)
    toast.success(`Duplicated to ${targetSemester} — dates cleared.`)
    setStep(4)
  }

  const isPreview = step === 8

  const stepContent = () => {
    switch (step) {
      case 1: return <Step1CourseSelect data={data} update={update} courseCatalog={courseCatalog} setCatalog={setCourseCatalog} savedExists={savedExists} otherSemesters={otherSemesters} onDuplicate={handleDuplicate} />
      case 2: return <Step2Instructor data={data} update={update} commonSections={commonSections} />
      case 3: return <Step3CourseInfo data={data} update={update} />
      case 4: return <Step4Dates data={data} update={update} />
      case 5: return <Step5Materials data={data} update={update} catalogRefreshKey={catalogRefreshKey} />
      case 6: return <Step6Description data={data} update={update} />
      case 7: return <Step7Grading data={data} update={update} />
      case 8: return <Step8Review data={data} commonSections={commonSections} onGenerate={handleGenerate} onDownloadDocx={handleDownloadDocx} saving={saving} docxBusy={docxBusy} onCreateClass={() => setShowCreateClass(true)} onJumpToStep={setStep} />
      default: return null
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3">
        <div className={`bg-white rounded-2xl shadow-2xl w-full flex flex-col transition-all duration-300 ${isPreview ? 'max-w-[92vw] h-[92vh]' : 'max-w-3xl max-h-[92vh]'}`}>

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
                <BookOpen size={16} className="text-blue-600" />
              </div>
              <div>
                <h2 className="text-base font-bold text-surface-900">Syllabus Generator</h2>
                <p className="text-xs text-surface-400">
                  {data.course_id ? `${data.course_id} · ${data.semester} · ` : ''}{STEPS[step - 1].desc}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
              <X size={18} className="text-surface-400" />
            </button>
          </div>

          {/* Step bar */}
          <div className="pt-4 shrink-0">
            <StepProgress current={step} onClickStep={setStep} />
          </div>

          {/* Content */}
          <div className={`flex-1 min-h-0 ${isPreview ? 'overflow-hidden' : 'overflow-y-auto px-6 py-5'}`}>
            {loadingData
              ? <div className="flex items-center justify-center h-32 text-sm text-surface-400">Loading saved data…</div>
              : stepContent()
            }
          </div>

          {/* Footer — normal steps */}
          {!isPreview && (
            <div className="border-t border-surface-100 px-6 py-4 flex items-center justify-between shrink-0">
              <button onClick={() => setStep(s => s - 1)} disabled={step === 1}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-50 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                <ChevronLeft size={15} /> Back
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => handleSave()} disabled={saving || !data.course_id}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-surface-200 text-surface-600 hover:bg-surface-50 rounded-lg transition-colors disabled:opacity-40">
                  <Save size={14} />{saving ? 'Saving…' : 'Save Draft'}
                </button>
                {step < STEPS.length && (
                  <button onClick={() => { const next = step + 1; if (next === 5) setCatalogRefreshKey(k => k + 1); setStep(next) }} disabled={step === 1 && !data.course_id}
                    className="flex items-center gap-1.5 px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-40">
                    Next <ChevronRight size={15} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Footer — preview step */}
          {isPreview && (
            <div className="border-t border-surface-100 px-6 py-3 flex items-center justify-between shrink-0">
              <button onClick={() => setStep(7)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-50 rounded-lg transition-colors">
                <ChevronLeft size={15} /> Back to Grading
              </button>
              <button onClick={() => handleSave()} disabled={saving || !data.course_id}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-surface-200 text-surface-600 hover:bg-surface-50 rounded-lg transition-colors disabled:opacity-40">
                <Save size={14} />{saving ? 'Saving…' : 'Save Draft'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Post-PDF: offer to create CMMS class */}
      {showCreateClass && (
        <CreateCMSSClassModal syllabusData={data} onClose={() => setShowCreateClass(false)} />
      )}
    </>
  )
}
