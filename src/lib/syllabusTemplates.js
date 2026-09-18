/**
 * RICT CMMS — syllabus_templates shared helpers
 *
 * Both the Syllabus Wizard and the Syllabus Library write to
 * syllabus_templates, and both need to copy a syllabus to another semester.
 * Keeping that knowledge here means the two can't drift — which is exactly how
 * "Duplicate to New Semester" ended up broken: the wizard's save path
 * sanitised dates and its duplicate path didn't.
 *
 * File: src/lib/syllabusTemplates.js
 */

import { datesForRuns, calendarFromTerm, nextSameSeasonName } from '@/lib/academicTerms'

/**
 * Columns typed as `date` in Postgres. A form uses '' for an empty date input;
 * Postgres rejects '' for a date column ("invalid input syntax for type date"),
 * so every write has to pass through withNullDates() first.
 */
export const SYLLABUS_DATE_FIELDS = [
  'begin_date', 'end_date', 'last_drop_date', 'last_withdraw_date',
  'spring_break_start', 'spring_break_end', 'finals_start', 'finals_end', 'revised_date',
]

/** '' → null on every date column. Returns a copy; the input is never mutated. */
export function withNullDates(obj) {
  const out = { ...obj }
  // Only '' is rewritten — a key the caller omitted stays omitted, so an upsert
  // never blanks a column it wasn't asked to touch.
  for (const f of SYLLABUS_DATE_FIELDS) if (out[f] === '') out[f] = null
  return out
}

/** Which part of the term a template runs, normalised. */
export function templateRuns(row) {
  if (['full', 'first', 'second'].includes(row?.runs)) return row.runs
  // Templates saved before `runs` existed recorded only the length.
  return String(row?.semester_length || '16') === '8' ? 'first' : 'full'
}

/** Fields that must never be carried onto a copy. */
const NOT_COPIED = [
  'id', 'created_at', 'created_by',
  'pdf_generated_at', 'pdf_generated_count',
]

/**
 * Build the row for a copy of `source` in `targetSemester`.
 *
 * When `targetTerm` is supplied, dates come from it for the section's own
 * `runs` — an 8-week section gets its half of the term, not the whole thing.
 * With no term yet, dates are left null for the instructor to fill in once the
 * calendar exists; the wizard's Dates step fills them automatically the moment
 * the term is added.
 *
 * Drop / withdraw are deliberately NOT carried over: they live on the class
 * record and are specific to a semester, so last year's would be wrong.
 */
export function buildSyllabusCopy(source, targetSemester, targetTerm = null, by = '') {
  const runs = templateRuns(source)
  const cal = targetTerm
    ? { ...datesForRuns(targetTerm, runs), ...calendarFromTerm(targetTerm, { runs }) }
    : null

  const row = { ...source }
  for (const f of NOT_COPIED) delete row[f]

  const copy = {
    ...row,
    semester: targetSemester,
    status: 'active',          // a copy is a fresh working draft, even from an archived source
    runs,
    begin_date: cal?.start_date || null,
    end_date: cal?.end_date || null,
    spring_break_start: cal?.spring_break_start || null,
    spring_break_end: cal?.spring_break_end || null,
    finals_start: cal?.finals_start || null,
    finals_end: cal?.finals_end || null,
    // Per class, and semester-specific — last year's dates would be wrong.
    last_drop_date: null,
    last_withdraw_date: null,
    revised_date: new Date().toISOString().split('T')[0],
    pdf_generated_at: null,
    pdf_generated_count: 0,
    created_by: by,
    updated_at: new Date().toISOString(),
    updated_by: by,
  }
  return withNullDates(copy)
}

/**
 * What rolling `row` forward one year would involve, given everything already
 * saved. Pure — it decides nothing and writes nothing, so the dialog and the
 * action that follows it always agree on the plan.
 */
export function planRollForward({ row, allTemplates = [], terms = [], classes = [] }) {
  const targetSemester = nextSameSeasonName(row?.semester)
  if (!targetSemester) return null

  const sameCourse = (t) => t.course_id === row.course_id && t.semester === targetSemester
  const existingSyllabus = allTemplates.find(sameCourse) || null
  const targetTerm = terms.find(t => t.name === targetSemester) || null
  const sourceTerm = terms.find(t => t.name === row.semester) || null
  const existingClass = classes.find(c => c.course_id === row.course_id && c.semester === targetSemester) || null

  return {
    targetSemester,
    sourceTerm,
    targetTerm,
    existingSyllabus,
    existingClass,
    needsSyllabus: !existingSyllabus,
    needsClass: !existingClass,
    needsTerm: !targetTerm,
    // Nothing to offer when next year is already fully set up.
    nothingToDo: !!existingSyllabus && !!existingClass,
  }
}
