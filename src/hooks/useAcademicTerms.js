/**
 * RICT CMMS — useAcademicTerms / useTermActions
 *
 * Data layer for Settings → Terms and for every page that needs the
 * semester list or the current semester (Classes, Class Schedule, Syllabus
 * Wizard, Program Planner). Pure date logic lives in src/lib/academicTerms.js.
 *
 *   useAcademicTerms()  → { terms (newest first), current, loading, refresh }
 *                         realtime on academic_terms
 *   useTermActions()    → { saving, saveTerm, archiveTerm, previewPropagation,
 *                           propagateTerm }
 *
 * Writes are validated (assertWrite / row counts) and each save writes ONE
 * audit_log row ("Academic Term" / term_id) with a plain-English change list.
 *
 * Propagation: when a term's dates change, classes linked to it that do NOT
 * override the term calendar, and syllabus_templates for that semester whose
 * dates still equal the OLD term dates, can be updated in one go — the
 * caller shows the counts and asks first (never silent).
 *
 * File: src/hooks/useAcademicTerms.js
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { sortTerms, currentTerm, datesForRuns, calendarFromTerm, parseTermName, fmtDate } from '@/lib/academicTerms'

const TERM_COLS = 'term_id, name, season, year, begin_date, end_date, spring_break_start, spring_break_end, finals_start, finals_end, last_drop_date, last_withdraw_date, first_half_end, second_half_start, status, notes, created_at, created_by, updated_at, updated_by'
const DATE_FIELDS = ['begin_date', 'end_date', 'spring_break_start', 'spring_break_end', 'finals_start', 'finals_end', 'last_drop_date', 'last_withdraw_date', 'first_half_end', 'second_half_start']
const FIELD_LABELS = {
  begin_date: 'Begin', end_date: 'End', spring_break_start: 'Spring break start', spring_break_end: 'Spring break end',
  finals_start: 'Finals start', finals_end: 'Finals end', last_drop_date: 'Last day to drop', last_withdraw_date: 'Last day to withdraw',
  first_half_end: 'First 8 weeks end', second_half_start: 'Second 8 weeks start', status: 'Status', notes: 'Notes',
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function useAcademicTerms() {
  const [terms, setTerms] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const rows = mustData(await supabase.from('academic_terms').select(TERM_COLS), 'academic_terms.select') || []
      setTerms(sortTerms(rows))
    } catch (e) {
      console.error('useAcademicTerms:', e)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => subscribeWithReconnect(`academic-terms-${Math.random().toString(36).slice(2)}`, ch => ch
    .on('postgres_changes', { event: '*', schema: 'public', table: 'academic_terms' }, load)
  , { tag: 'AcademicTerms', onReconnect: load }), [load])

  const current = useMemo(() => currentTerm(terms), [terms])
  const active = useMemo(() => terms.filter(t => t.status !== 'Archived'), [terms])
  return { terms, active, current, loading, refresh: load }
}

// ─── Write ────────────────────────────────────────────────────────────────────

const clean = (t) => {
  const out = {}
  for (const k of ['term_id', 'name', 'season', 'year', 'status', 'notes', ...DATE_FIELDS]) {
    let v = t[k]
    if (DATE_FIELDS.includes(k)) v = v ? String(v).substring(0, 10) : null
    if (k === 'notes') v = v || null
    if (k === 'year') v = parseInt(v, 10) || 0
    out[k] = v
  }
  return out
}

function diffTerms(prev, next) {
  const lines = []
  if (!prev) return [`Added ${next.name} (${fmtDate(next.begin_date)} → ${fmtDate(next.end_date)})`]
  for (const k of [...DATE_FIELDS, 'status', 'notes']) {
    const a = prev[k] ? String(prev[k]).substring(0, 10) : '', b = next[k] ? String(next[k]).substring(0, 10) : ''
    if (k === 'status' || k === 'notes') { if ((prev[k] || '') !== (next[k] || '')) lines.push(`${FIELD_LABELS[k]}: ${prev[k] || '—'} → ${next[k] || '—'}`) }
    else if (a !== b) lines.push(`${FIELD_LABELS[k]}: ${a ? fmtDate(a) : '—'} → ${b ? fmtDate(b) : '—'}`)
  }
  return lines
}

export function useTermActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const who = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''

  const audit = async (termId, action, details) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: profile?.email, user_name: who, action,
        entity_type: 'Academic Term', entity_id: termId, details,
      })
    } catch (e) { console.error('term audit:', e) }
  }

  /** Create or update. `prev` is the stored row (null for new). Returns the saved row or null. */
  const saveTerm = useCallback(async (term, prev = null) => {
    const row = clean(term)
    if (!row.name) { toast.error('Give the term a name (e.g. Spring 2027)'); return null }
    if (!row.begin_date || !row.end_date) { toast.error('Begin and end dates are required'); return null }
    if (row.end_date <= row.begin_date) { toast.error('End date must be after the begin date'); return null }
    const parsed = parseTermName(row.name)
    row.name = parsed.name; row.season = parsed.season; row.year = parsed.year
    if (!['Spring', 'Fall'].includes(row.season) || !row.year) { toast.error('Name the term "Spring YYYY" or "Fall YYYY"'); return null }
    row.term_id = prev?.term_id || parsed.term_id
    row.updated_at = new Date().toISOString(); row.updated_by = who
    if (!prev) row.created_by = who

    setSaving(true)
    try {
      const saved = mustData(await supabase.from('academic_terms').upsert(row, { onConflict: 'term_id' }).select(TERM_COLS), 'academic_terms.upsert')
      if (!saved || saved.length === 0) throw new Error('Save was blocked — you may not have permission to manage terms')
      // Keep classes.semester text in step if the term was renamed.
      if (prev && prev.name !== row.name) {
        await supabase.from('classes').update({ semester: row.name }).eq('term_id', row.term_id).select('class_id')
      }
      const lines = diffTerms(prev, row)
      if (lines.length) await audit(row.term_id, prev ? 'Update' : 'Create', `${row.name}: ${lines.join('; ')}`)
      toast.success(prev ? `${row.name} updated` : `${row.name} added`)
      return saved[0]
    } catch (e) {
      toast.error('Term not saved: ' + e.message)
      return null
    } finally { setSaving(false) }
  }, [who, profile?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  const archiveTerm = useCallback(async (term, archived = true) => {
    setSaving(true)
    try {
      const { error } = assertWrite(await supabase.from('academic_terms')
        .update({ status: archived ? 'Archived' : 'Active', updated_at: new Date().toISOString(), updated_by: who })
        .eq('term_id', term.term_id).select('term_id'), 'academic_terms.update')
      if (error) throw error
      await audit(term.term_id, 'Update', `${term.name}: Status: ${term.status} → ${archived ? 'Archived' : 'Active'}`)
      toast.success(`${term.name} ${archived ? 'archived' : 'restored'}`)
      return true
    } catch (e) { toast.error(e.message); return false } finally { setSaving(false) }
  }, [who]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What would change if `term`'s calendar is pushed out?
   *   classes  — linked, not overriding, whose dates differ from what the term now gives
   *   syllabi  — syllabus_templates for this semester whose dates still equal the OLD term's
   * `prev` is the term as it was before the edit (for the syllabus match).
   */
  const previewPropagation = useCallback(async (term, prev) => {
    const classes = mustData(await supabase.from('classes')
      .select('class_id, course_id, course_name, runs, start_date, end_date, spring_break_start, spring_break_end, finals_start, finals_end, override_term_dates')
      .eq('term_id', term.term_id), 'classes.select') || []
    const eq = (a, b) => String(a || '').substring(0, 10) === String(b || '').substring(0, 10)
    const classesToUpdate = classes.filter(c => {
      if (c.override_term_dates) return false
      const d = datesForRuns(term, c.runs || 'full')
      const cal = calendarFromTerm(term, { runs: c.runs || 'full' })
      return !(eq(c.start_date, d.start_date) && eq(c.end_date, d.end_date)
        && eq(c.spring_break_start, cal.spring_break_start) && eq(c.spring_break_end, cal.spring_break_end)
        && eq(c.finals_start, cal.finals_start) && eq(c.finals_end, cal.finals_end))
    })
    const overriding = classes.filter(c => c.override_term_dates)

    let syllabiToUpdate = []
    try {
      const syl = mustData(await supabase.from('syllabus_templates')
        .select('course_id, semester, runs, begin_date, end_date, spring_break_start, spring_break_end, finals_start, finals_end')
        .eq('semester', term.name), 'syllabus_templates.select') || []
      const old = prev || term
      // A syllabus "still matches" when every date it has equals what the OLD
      // term gave a section of its length (blank syllabus dates don't block).
      // Compared per `runs` — an 8-week section legitimately holds half-term
      // dates, and comparing those against the full term's would wrongly treat
      // every half-semester syllabus as hand-edited and skip it forever.
      // Drop / withdraw are per class and never touched here.
      syllabiToUpdate = syl.filter(s => {
        const r = ['full', 'first', 'second'].includes(s.runs) ? s.runs : 'full'
        const od = datesForRuns(old, r)
        const oc = calendarFromTerm(old, { runs: r })
        return (!s.begin_date || eq(s.begin_date, od.start_date)) && (!s.end_date || eq(s.end_date, od.end_date))
          && (!s.spring_break_start || eq(s.spring_break_start, oc.spring_break_start)) && (!s.spring_break_end || eq(s.spring_break_end, oc.spring_break_end))
          && (!s.finals_start || eq(s.finals_start, oc.finals_start)) && (!s.finals_end || eq(s.finals_end, oc.finals_end))
      })
    } catch { /* syllabus table may be read-restricted for some users; classes still propagate */ }
    return { classesToUpdate, overriding, syllabiToUpdate }
  }, [])

  /** Apply the term's calendar to the given classes (by row) and syllabi (by course_id). Returns counts. */
  const propagateTerm = useCallback(async (term, { classes = [], syllabi = [] }) => {
    setSaving(true)
    let classesDone = 0, syllabiDone = 0
    try {
      const nowIso = new Date().toISOString()
      for (const c of classes) {
        const d = datesForRuns(term, c.runs || 'full')
        const cal = calendarFromTerm(term, { runs: c.runs || 'full' })
        const { error } = assertWrite(await supabase.from('classes').update({
          start_date: d.start_date || null, end_date: d.end_date || null,
          spring_break_start: cal.spring_break_start || null, spring_break_end: cal.spring_break_end || null,
          finals_start: cal.finals_start || null, finals_end: cal.finals_end || null,
          // No updated_at — the classes table has no such column. Sending it
          // made this whole loop fail on its first class, so applying a term
          // calendar to classes never worked. The audit() call below records it.
          semester: term.name,
        }).eq('class_id', c.class_id).select('class_id'), 'classes.update')
        if (error) throw error
        classesDone++
      }
      for (const s of syllabi) {
        // Per syllabus, exactly as the classes loop above does per class.
        // This previously wrote term.begin_date / term.end_date to EVERY
        // syllabus, which flattened half-semester sections back to full-term
        // dates whenever a term was edited.
        const r = ['full', 'first', 'second'].includes(s.runs) ? s.runs : 'full'
        const d = datesForRuns(term, r)
        const cal = calendarFromTerm(term, { runs: r })
        const { error } = assertWrite(await supabase.from('syllabus_templates').update({
          begin_date: d.start_date || null, end_date: d.end_date || null,
          spring_break_start: cal.spring_break_start || null, spring_break_end: cal.spring_break_end || null,
          finals_start: cal.finals_start || null, finals_end: cal.finals_end || null,
          updated_at: nowIso, updated_by: profile?.email || '',
        }).eq('course_id', s.course_id).eq('semester', term.name).select('course_id'), 'syllabus_templates.update')
        if (error) throw error
        syllabiDone++
      }
      if (classesDone || syllabiDone) {
        await audit(term.term_id, 'Update', `${term.name}: term calendar applied to ${classesDone} class${classesDone === 1 ? '' : 'es'}${syllabiDone ? ` and ${syllabiDone} syllab${syllabiDone === 1 ? 'us' : 'i'}` : ''}`)
        toast.success(`Updated ${classesDone} class${classesDone === 1 ? '' : 'es'}${syllabiDone ? ` and ${syllabiDone} syllab${syllabiDone === 1 ? 'us' : 'i'}` : ''}`)
      }
      return { classesDone, syllabiDone }
    } catch (e) {
      toast.error(`Stopped after ${classesDone} class${classesDone === 1 ? '' : 'es'}: ${e.message}`)
      return { classesDone, syllabiDone, error: e.message }
    } finally { setSaving(false) }
  }, [profile?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  return { saving, saveTerm, archiveTerm, previewPropagation, propagateTerm }
}
