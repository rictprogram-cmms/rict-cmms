import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  X, ChevronRight, ChevronLeft, Plus, Trash2,
  BookOpen, Printer, Save, Check, AlertCircle,
  Copy, Upload, RefreshCw, Eye, Clock,
  UserPlus, User, GraduationCap, PlusCircle, Search, Pencil
} from 'lucide-react'
import toast from 'react-hot-toast'

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
    title: 'Statement of Diversity',
    order: 3,
    content: `The entire class will benefit from the wealth of diversity brought by each individual, so students are asked to extend every courtesy and respect that they, in turn, would expect from the class.

This college is committed to creating a positive, supportive environment that welcomes diversity of opinions and ideas for students. There will be no tolerance of race discrimination/harassment, sexual discrimination/harassment, or discrimination/harassment based on age, disability, color, creed, national origin, religion, sexual orientation, marital status, status with regard to public assistance, or membership in a local commission.

I am happy to work with you if you share that you are experiencing a pregnancy, related condition or parenting situation. Once you share this information, I will connect you with Title IX Pregnant & Parenting Student Resources.

I am happy to work with you if you share that you have a disability or underlying condition. Once you share this information, I will connect you with Accessibility Services so that you have the opportunity to obtain reasonable accommodations.`,
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
function renderSection(text) {
  if (!text) return ''
  return text.split('\n').map(line => {
    const t = line.replace(/\u00a0/g, ' ').trim()
    if (!t) return '<br>'
    if (t.startsWith('•')) return `<li>${escHtml(t.slice(1).trim())}</li>`
    if (/^\d+\.\s/.test(t)) return `<li>${escHtml(t.replace(/^\d+\.\s/, ''))}</li>`
    if (t === t.toUpperCase() && t.length > 3) return `<p class="subsub-head">${escHtml(t)}</p>`
    return `<p>${escHtml(t)}</p>`
  }).join('\n')
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
  const assessmentRows = (data.assessments || []).map(a => `<tr><td>${escHtml(a.name)}${a.description ? ` &ndash; <em>${escHtml(a.description)}</em>` : ''}</td><td class="pts">${a.points > 0 ? a.points + ' pts' : '&ndash;'}</td></tr>`).join('\n')
  const outcomesHtml = (data.student_outcomes || []).length > 0 ? `<p><strong>Student Learning Outcomes:</strong></p>` + (data.student_outcomes || []).map((o, i) => `<p class="outcome">${i + 1}.&nbsp; ${escHtml(o)}</p>`).join('\n') : ''
  // Strip " (Part #: ...)" suffix — part numbers are for the catalog, not the PDF
  const materialsHtml = (data.required_materials || []).length > 0 ? `<ul>${(data.required_materials || []).map(m => `<li>${escHtml(m.replace(/ \(Part #:.*?\)$/i, '').trim())}</li>`).join('\n')}</ul>` : '<p>None</p>'
  const techHtml = `<ul>${(data.required_technology || []).map(t => `<li>${escHtml(t)}</li>`).join('\n')}</ul>`
  const footerText = get('college_footer').replace(/\n/g, '<br>')
  const logoHtml = data.logo_url ? `<img src="${escHtml(data.logo_url)}" alt="SCTCC Logo" style="width:64px;height:auto;display:block;margin-bottom:6px;">` : ''
  const coursePhotoHtml = data.course_photo_url
    ? `<img src="${escHtml(data.course_photo_url)}" alt="Course photo" style="float:right;width:180px;height:auto;max-height:140px;object-fit:cover;border-radius:4px;margin:0 0 8px 16px;border:1px solid #dde4f0;">`
    : ''
  const coursePhotoClear = data.course_photo_url ? '<div style="clear:both"></div>' : ''  
  const hasInstructor2 = data.instructor2_enabled && data.instructor2_name
  const instructor2Html = hasInstructor2 ? `
  <div class="sub-head">Co-Instructor Office &amp; Office Hours</div>
  <div class="block"><p>${escHtml(data.instructor2_office || '')}</p><p>${escHtml(data.instructor2_office_hours || '')}</p></div>
  <div class="sub-head">Co-Instructor Contact</div>
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
    .nav-line { font-size: 8.5pt; color: #1155cc; text-decoration: underline; }
    .sec-head { font-size: 11.5pt; font-weight: 700; font-variant: small-caps; letter-spacing: 0.05em; color: #1a3a5c; border-bottom: 1.5px solid #1a3a5c; padding-bottom: 2px; margin-top: 18px; margin-bottom: 8px; page-break-after: avoid; }
    .sub-head { font-size: 9.5pt; font-weight: 600; font-variant: small-caps; color: #1a3a5c; text-decoration: underline; margin-top: 10px; margin-bottom: 3px; page-break-after: avoid; }
    .subsub-head { font-size: 9.5pt; font-weight: 700; margin-top: 7px; margin-bottom: 3px; }
    p { margin-bottom: 5px; } ul, ol { margin-left: 20px; margin-bottom: 5px; } li { margin-bottom: 2px; }
    .block { margin-left: 16px; } .outcome { margin-left: 14px; margin-bottom: 3px; }
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
      <div class="course-title">${escHtml(data.course_id)}: ${escHtml(data.course_name)}</div>
      <div class="semester-label">${escHtml(data.semester)}</div>
      <p class="official-notice">This syllabus is the official course document. The instructor${hasInstructor2 ? 's reserve' : ' reserves'} the right to make changes to this document. Students will be notified when changes are made.</p>
      <div class="nav-line">Instructor Information / Course Information / College Policies &amp; Procedures / Course Policies &amp; Procedures / Grading</div>
    </div>
  </div>
  <div class="sec-head">Instructor Information</div>
  <div class="sub-head">Office &amp; Office Hours</div>
  <div class="block"><p>${escHtml(data.instructor_office)}</p><p>${escHtml(data.instructor_office_hours)}</p></div>
  <div class="sub-head">Contact Information</div>
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
  <div class="sec-head">Course Information</div>
  <div class="sub-head">General Information</div>
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
  <div class="sub-head">Materials</div>
  <div class="block">
    <p><strong>Required</strong></p>${materialsHtml}
    <p><strong>Required Technology</strong></p>${techHtml}
    <p><strong>Suggested Technical Skills</strong></p>
    <p>Microsoft Training is available for free at your convenience.</p>
  </div>
  <div class="sub-head">Pre/Co-Requisites</div>
  <div class="block">
    <p>${escHtml(data.prerequisites) || 'None'}</p>
    ${data.restricted_to ? `<p>Restricted to the following major(s): ${escHtml(data.restricted_to)}</p>` : ''}
  </div>
  <div class="sub-head">Course Description &amp; Outcomes</div>
  <div class="block"><p>${escHtml(data.course_description)}</p>${outcomesHtml}</div>
  <div class="sec-head">College Policies &amp; Procedures</div>
  <div class="sub-head">Academic Integrity</div><div class="block">${renderSection(get('academic_integrity'))}</div>
  <div class="sub-head">Accommodations</div><div class="block">${renderSection(get('accommodations'))}</div>
  <div class="sub-head">Statement of Diversity</div><div class="block">${renderSection(get('diversity'))}</div>
  <div class="sec-head">Course Policies &amp; Procedures</div>
  <div class="sub-head">Attendance</div><div class="block">${renderSection(get('attendance'))}</div>
  <div class="sub-head">Navigating D2L &amp; Technical Support</div><div class="block">${renderSection(get('d2l'))}</div>
  <div class="sub-head">Class Environment</div><div class="block">${renderSection(get('class_environment'))}</div>
  <div class="sec-head">Grading</div>
  <div class="sub-head">Assignments &amp; Points</div>
  <div class="block">
    <p>All students are expected to put in <strong>${escHtml(String(data.volunteer_hours_required))} hours of volunteer hours</strong>. These hours need to be approved by the instructor. They must support the program. Examples are VEX Robotics tournaments, Ambassador program, Epic, etc.</p>
    <p>Weekly attendance \u2013 Your time sheet will need to match up to your signup days for lab. You will need <strong>${escHtml(String(data.required_hours_per_week))} hours a week</strong> of lab time.</p>
    <br>
    <table class="grade-table">
      <thead><tr><th>Assessment</th><th class="r">Points</th></tr></thead>
      <tbody>${assessmentRows}<tr class="total"><td>Total Points</td><td class="pts">${totalPoints} pts</td></tr></tbody>
    </table>
    <p class="note">(Subject to change depending on course content)</p>
  </div>
  <div class="sub-head">Grading Scale</div>
  <div class="block">
    <p>A = ${data.grading_a_min}\u2013100% = ${aMin}\u2013${totalPoints} points</p>
    <p>B = ${data.grading_b_min}\u2013${data.grading_a_min - 1}% = ${bMin}\u2013${aMin - 1} points</p>
    <p>C = ${data.grading_c_min}\u2013${data.grading_b_min - 1}% = ${cMin}\u2013${bMin - 1} points</p>
    <p>F = ${data.grading_c_min - 1} and below = &lt;${cMin} points</p>
  </div>
  <div class="sub-head">Grades</div>
  <div class="block">
    <p>You can check your grade through D2L Brightspace ASSESSMENTS/GRADES at any point during the semester.</p>
    <p>You can expect to have graded assignments returned within 3\u20135 days of the due date of the assignment.</p>
    <p>Your grade will reflect how well you have mastered the material, not how hard you have worked.</p>
  </div>
  <div class="sub-head">Time Commitment</div>
  <div class="block"><p>${escHtml(timeNote)}</p></div>
  <div class="sub-head">Course Calendar</div>
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
function CreateCMSSClassModal({ syllabusData, onClose }) {
  const { user } = useAuth()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)
  const [alreadyExists, setAlreadyExists] = useState(false)

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
    setCreating(true)
    const { error } = await supabase.from('classes').insert({
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
    })
    setCreating(false)
    if (error) {
      toast.error('Failed to create class: ' + error.message)
    } else {
      setCreated(true)
      toast.success(`${classData.course_id} added to CMMS — ready for student enrollment!`)
    }
  }

  if (created) {
    return (
      <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check size={28} className="text-emerald-600" />
          </div>
          <h3 className="text-lg font-bold text-surface-900 mb-2">Class Created!</h3>
          <p className="text-sm text-surface-500 mb-1">
            <strong>{classData.course_id} – {classData.course_name}</strong>
          </p>
          <p className="text-sm text-surface-500 mb-6">
            {classData.semester} · {classData.instructor}
          </p>
          <p className="text-xs text-surface-400 mb-6">
            The class is now visible in the CMMS. Go to Settings to enroll students.
          </p>
          <button onClick={onClose} className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors">
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center">
              <GraduationCap size={16} className="text-emerald-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">Create CMMS Class</h2>
              <p className="text-xs text-surface-400">Add this course to the CMMS for student enrollment</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {alreadyExists && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg p-3 text-sm text-amber-700">
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              <span>A CMMS class for <strong>{syllabusData.course_id}</strong> in <strong>{syllabusData.semester}</strong> already exists. Creating again will add a duplicate — proceed only if needed.</span>
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
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Course ID</label>
                <input value={classData.course_id} onChange={e => upd('course_id', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Course Name</label>
                <input value={classData.course_name} onChange={e => upd('course_name', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Instructor</label>
                <input value={classData.instructor} onChange={e => upd('instructor', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Semester</label>
                <input value={classData.semester} readOnly
                  className="w-full px-3 py-2 border border-surface-100 rounded-lg text-sm bg-surface-50 text-surface-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Required Hours/Week</label>
                <input type="number" value={classData.required_hours} onChange={e => upd('required_hours', e.target.value)} min={1} max={40}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                <p className="text-[10px] text-surface-400 mt-1">
                  Formula: {syllabusData.credits_lab || 1} lab cr × {semLen === '8' ? '4' : '2'} ({semLen}-wk) = {calcHours(syllabusData.credits_lab || 1, semLen)} hrs/wk
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Status</label>
                <select value={classData.status} onChange={e => upd('status', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40">
                  <option>Active</option>
                  <option>Inactive</option>
                  <option>Pending</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Start Date</label>
                <input type="date" value={classData.start_date} onChange={e => upd('start_date', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">End Date</label>
                <input type="date" value={classData.end_date} onChange={e => upd('end_date', e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>
              {(syllabusData.spring_break_start || syllabusData.finals_start) && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Spring Break Start</label>
                    <input type="date" value={classData.spring_break_start} onChange={e => upd('spring_break_start', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Spring Break End</label>
                    <input type="date" value={classData.spring_break_end} onChange={e => upd('spring_break_end', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Finals Start</label>
                    <input type="date" value={classData.finals_start} onChange={e => upd('finals_start', e.target.value)}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-surface-600 uppercase tracking-wide mb-1">Finals End</label>
                    <input type="date" value={classData.finals_end} onChange={e => upd('finals_end', e.target.value)}
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
          <button onClick={onClose} className="flex-1 py-2.5 border border-surface-200 text-sm font-medium text-surface-600 rounded-xl hover:bg-surface-50 transition-colors">
            Skip for Now
          </button>
          <button onClick={handleCreate} disabled={creating || !classData.course_id}
            className="flex-1 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            <PlusCircle size={15} />
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
function NI({ value, onChange, min, max, step = 1 }) {
  return <input type="number" value={value ?? ''} onChange={e => onChange(e.target.value)} min={min} max={max} step={step}
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
function Step1CourseSelect({ data, update, courseCatalog, setCatalog, savedExists, onDuplicate }) {
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
          <div className={`border rounded-lg p-3 text-sm ${savedExists ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-brand-50 border-brand-100 text-brand-700'}`}>
            <Check size={14} className="inline mr-1.5" />
            {savedExists
              ? 'Saved syllabus loaded — verify details and step through each section.'
              : 'No saved syllabus found for this course + semester — starting fresh.'}
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

  // Auto-apply shared logo if no per-course value is set yet
  useEffect(() => {
    if (!data.logo_url && sharedLogo) {
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

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-surface-700">Assessment Items</p>
            <p className="text-xs text-surface-400 mt-0.5">Drag the ≡ handle to reorder rows.</p>
          </div>
          <span className="text-xs bg-brand-50 text-brand-600 font-semibold px-2.5 py-1 rounded-full">Total: {totalPoints} pts</span>
        </div>
        <div className="space-y-1.5">
          <div className="grid grid-cols-[20px_1fr_2fr_100px_36px] gap-2 px-3 py-1.5 bg-surface-50 rounded-lg text-xs font-semibold text-surface-500 uppercase tracking-wide">
            <span /><span>Assessment Name</span><span>Note / Description</span><span className="text-right">Points</span><span />
          </div>
          {(data.assessments||[]).map(a => (
            <div
              key={a.id}
              draggable
              onDragStart={() => handleDragStart(a.id)}
              onDragEnter={() => handleDragEnter(a.id)}
              onDragEnd={handleDragEnd}
              onDragOver={e => e.preventDefault()}
              className="grid grid-cols-[20px_1fr_2fr_100px_36px] gap-2 items-center bg-white border border-surface-100 rounded-lg px-2 py-1 hover:border-brand-200 transition-colors"
            >
              {/* Drag handle */}
              <div className="flex items-center justify-center cursor-grab active:cursor-grabbing text-surface-300 hover:text-surface-500 select-none">
                <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
                  <circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>
                  <circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/>
                  <circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/>
                </svg>
              </div>
              <input value={a.name} onChange={e => updateA(a.id, 'name', e.target.value)} placeholder="Assessment name" className="px-2.5 py-1.5 border border-surface-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-400" />
              <input value={a.description} onChange={e => updateA(a.id, 'description', e.target.value)} placeholder="Optional note" className="px-2.5 py-1.5 border border-surface-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-400" />
              <input type="number" value={a.points} onChange={e => updateA(a.id, 'points', parseInt(e.target.value)||0)} min={0} className="px-2.5 py-1.5 border border-surface-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-400" />
              <button onClick={() => removeA(a.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          <button onClick={addA} className="flex items-center gap-1.5 text-xs text-brand-600 font-medium hover:text-brand-700 py-1 mt-1"><Plus size={13} /> Add Assessment Item</button>
        </div>
      </div>
      <div className="border-t border-surface-100 pt-4 grid grid-cols-3 gap-4">
        <Field label="Grade A Minimum %"><NI value={data.grading_a_min} onChange={v => update('grading_a_min', parseInt(v)||90)} min={50} max={100} /></Field>
        <Field label="Grade B Minimum %"><NI value={data.grading_b_min} onChange={v => update('grading_b_min', parseInt(v)||80)} min={40} max={99} /></Field>
        <Field label="Grade C Minimum %"><NI value={data.grading_c_min} onChange={v => update('grading_c_min', parseInt(v)||70)} min={30} max={99} /></Field>
      </div>
      <div className="border-t border-surface-100 pt-4">
        <Field label="Volunteer Hours Required"><NI value={data.volunteer_hours_required} onChange={v => update('volunteer_hours_required', parseInt(v)||5)} min={0} max={50} /></Field>
      </div>
      <Field label="Time Commitment Note" hint="Leave blank to auto-generate based on credit hours">
        <TA value={data.time_commitment_notes} onChange={v => update('time_commitment_notes', v)} rows={3} placeholder="Leave blank to auto-generate…" />
      </Field>
    </div>
  )
}

// ─── Step 8: Preview ──────────────────────────────────────────────────────────
function Step8Review({ data, commonSections, onGenerate, saving, onCreateClass }) {
  const totalPoints = (data.assessments||[]).reduce((s, a) => s + (parseInt(a.points)||0), 0)
  const blobRef = useRef(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [scale, setScale] = useState(72)

  const checks = [
    { label: 'Course selected',    ok: !!data.course_id },
    { label: 'Instructor name',     ok: !!data.instructor_name },
    { label: 'Instructor email',    ok: !!data.instructor_email },
    { label: 'Begin & end dates',   ok: !!data.begin_date && !!data.end_date },
    { label: 'Drop/withdraw dates', ok: !!data.last_drop_date && !!data.last_withdraw_date },
    { label: 'Course description',  ok: !!data.course_description },
    { label: 'Student outcomes',    ok: (data.student_outcomes||[]).length > 0 },
    { label: 'Assessments',         ok: (data.assessments||[]).length > 0 && totalPoints > 0 },
  ]

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
            <p className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-2">Readiness</p>
            <div className="space-y-1">
              {checks.map(c => (
                <div key={c.label} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${c.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                  {c.ok ? <Check size={11} className="shrink-0 text-emerald-500" /> : <AlertCircle size={11} className="shrink-0 text-amber-500" />}
                  {c.label}
                </div>
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
          <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700 leading-snug">
            <Printer size={11} className="inline mr-1" />
            Opens a new tab — choose <strong>Save as PDF</strong> in the print dialog.
          </div>
          <button onClick={onGenerate} disabled={saving}
            className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-sm">
            <Printer size={15} />{saving ? 'Saving…' : 'Generate & Print PDF'}
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
export default function SyllabusWizard({ onClose }) {
  const { user } = useAuth()
  const [step, setStep] = useState(1)
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0)
  const [data, setData] = useState(EMPTY_SYLLABUS)
  const [courseCatalog, setCourseCatalog] = useState([])  // from syllabus_courses, NOT classes
  const [commonSections, setCommonSections] = useState([])
  const [saving, setSaving] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [savedExists, setSavedExists] = useState(false)
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
    ]).then(([{ data: row }, { data: catalogRow }]) => {
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
    const { error } = await supabase.from('syllabus_templates')
      .upsert(payload, { onConflict: 'course_id,semester' }).select()
    setSaving(false)
    if (error) { toast.error('Save failed: ' + error.message); return false }
    setSavedExists(true)
    toast.success('Draft saved!')
    return true
  }, [data, user])

  const handleGenerate = async () => {
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
      begin_date: '', end_date: '', last_drop_date: '', last_withdraw_date: '',
      spring_break_start: '', spring_break_end: '', finals_start: '', finals_end: '',
      pdf_generated_at: null, pdf_generated_count: 0,
      revised_date: new Date().toISOString().split('T')[0],
      created_by: user?.email || '',
    }
    const payload = { ...newData, updated_at: new Date().toISOString(), updated_by: user?.email || '' }
    delete payload.id
    const { error } = await supabase.from('syllabus_templates')
      .upsert(payload, { onConflict: 'course_id,semester' }).select()
    if (error) { toast.error('Duplicate failed: ' + error.message); return }
    setData(newData)
    setSavedExists(false)
    toast.success(`Duplicated to ${targetSemester} — dates cleared.`)
    setStep(4)
  }

  const isPreview = step === 8

  const stepContent = () => {
    switch (step) {
      case 1: return <Step1CourseSelect data={data} update={update} courseCatalog={courseCatalog} setCatalog={setCourseCatalog} savedExists={savedExists} onDuplicate={handleDuplicate} />
      case 2: return <Step2Instructor data={data} update={update} commonSections={commonSections} />
      case 3: return <Step3CourseInfo data={data} update={update} />
      case 4: return <Step4Dates data={data} update={update} />
      case 5: return <Step5Materials data={data} update={update} catalogRefreshKey={catalogRefreshKey} />
      case 6: return <Step6Description data={data} update={update} />
      case 7: return <Step7Grading data={data} update={update} />
      case 8: return <Step8Review data={data} commonSections={commonSections} onGenerate={handleGenerate} saving={saving} onCreateClass={() => setShowCreateClass(true)} />
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
