/**
 * RICT CMMS — useClassSchedule
 *
 * Data layer for the Class Schedule page (src/pages/ClassSchedulePage.jsx).
 * The pure scheduling math lives in src/lib/scheduleModel.js; this file only
 * talks to Supabase and keeps the working document in React state.
 *
 *   useSemesterOptions()  — distinct classes.semester values (newest first)
 *                           and the classes in each; realtime on `classes`.
 *   useClassSchedule()    — the working doc for one semester:
 *       • load: classes for that semester + class_schedules row +
 *         class_schedule_items → merged doc. Linked classes take code /
 *         title / instructor / hours LIVE from Settings on every load;
 *         missing items get defaults (span derived from the class dates,
 *         colour by position, no room, no blocks) and only become rows the
 *         first time the schedule is saved.
 *       • commit(mutator): edit a clone, normalise, debounce-save (500 ms).
 *       • save: upsert the schedule row, upsert changed items (deterministic
 *         item_id so no "new vs existing" bookkeeping), delete removed
 *         ad-hoc items, then ONE audit_log row with the plain-English diff.
 *         Every write is validated (assertWrite / row counts) — RLS blocks
 *         surface as an error state, never a silent no-op.
 *       • realtime: item / schedule changes from another instructor reload
 *         the doc when nothing is pending locally.
 *       • history: audit_log rows for this schedule (entity_type
 *         'Class Schedule', entity_id = schedule_id).
 *       • copyFromSemester: seed empty classes from an earlier semester's
 *         layout by course number (room, colour, note, blocks, groups).
 *
 * Permissions: the page passes canEdit = hasPerm('edit_schedule'). Without
 * it nothing is ever written (RLS also refuses non-instructors).
 *
 * File: src/hooks/useClassSchedule.js
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import {
  HUES, normalize, clone, ensure, emptyWeek, diffDocs, parseSemester,
  deriveSpan, semesterBounds, termsOf, primaryTerm, uid, DAYS,
} from '@/lib/scheduleModel'
import { normalizeDelivery } from '@/lib/classDelivery'
import { useAcademicTerms } from '@/hooks/useAcademicTerms'
import { semesterOptions, currentTerm as pickCurrentTerm, parseTermName } from '@/lib/academicTerms'

const CLASS_COLS = 'class_id, course_id, course_name, instructor, instructor_email, required_hours, semester, status, start_date, end_date, delivery, term_id, runs, override_term_dates'
const ITEM_COLS = 'item_id, schedule_id, class_id, is_adhoc, code, title, instructor, hours, room, span, color, group_key, note, slots_a, slots_b, sort_order, updated_at, updated_by'
const SAVE_DEBOUNCE_MS = 500
const MAX_AUDIT_LINES = 40

// ─── Semesters ────────────────────────────────────────────────────────────────

export function useSemesterOptions() {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const loadedRef = useRef(false)
  // Settings → Terms is the semester list of record; distinct classes.semester
  // values are only a fallback for data older than the terms calendar.
  const { terms, loading: termsLoading } = useAcademicTerms()

  const load = useCallback(async () => {
    try {
      const rows = mustData(await supabase.from('classes').select(CLASS_COLS).order('course_id'), 'classes.select') || []
      setClasses(rows)
      loadedRef.current = true
    } catch (e) {
      console.error('useSemesterOptions:', e)
      if (!loadedRef.current) toast.error('Could not load classes: ' + e.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => subscribeWithReconnect(`class-sched-classes-${Date.now()}`, ch => ch
    .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, load)
  , { tag: 'ClassSchedule' }), [load])

  const semesters = useMemo(() => {
    const names = semesterOptions(terms.filter(t => t.status !== 'Archived'), classes.map(c => c.semester))
    return names.map(n => ({ ...parseSemester(n), name: n }))
  }, [terms, classes])
  const classesBySemester = useMemo(() => {
    const m = new Map()
    for (const c of classes) {
      const n = String(c.semester || '').trim()
      if (!n) continue
      if (!m.has(n)) m.set(n, [])
      m.get(n).push(c)
    }
    return m
  }, [classes])

  /** The current term (Settings → Terms); else the semester whose classes are in session, next up, or newest.
   *  Empty until the class list has loaded, so the first schedule load never runs with no classes. */
  const defaultSemester = useMemo(() => {
    if (loading || termsLoading) return ''
    const cur = pickCurrentTerm(terms)
    if (cur) return cur.name
    if (!semesters.length) return ''
    const today = new Date(); today.setHours(0, 0, 0, 0)
    let upcoming = null
    for (const s of semesters) {
      const b = semesterBounds(classesBySemester.get(s.name))
      if (b.start && b.end && today >= b.start && today <= b.end) return s.name
      if (b.start && b.start > today && (!upcoming || b.start < upcoming.start)) upcoming = { start: b.start, name: s.name }
    }
    return upcoming ? upcoming.name : semesters[0].name
  }, [terms, semesters, classesBySemester, loading, termsLoading])

  return { classes, semesters, classesBySemester, defaultSemester, loading: loading || termsLoading, refresh: load }
}

// ─── Doc ↔ rows ───────────────────────────────────────────────────────────────

function buildDoc({ semester, scheduleRow, items, classes }) {
  const scheduleId = scheduleRow?.schedule_id || parseSemester(semester).key
  const bounds = semesterBounds(classes)
  const byClass = new Map(items.filter(i => i.class_id).map(i => [i.class_id, i]))
  const courses = []
  const assign = {}

  const sortedClasses = [...classes].sort((a, b) =>
    String(a.course_id || '').localeCompare(String(b.course_id || '')) || String(a.course_name || '').localeCompare(String(b.course_name || '')))
  sortedClasses.forEach((cls, i) => {
    const it = byClass.get(cls.class_id)
    const id = it?.item_id || `CSI-${scheduleId}-${cls.class_id}`
    courses.push({
      id, classId: cls.class_id, adhoc: false,
      code: cls.course_id || '', title: cls.course_name || '', instructor: cls.instructor || '', instructorEmail: cls.instructor_email || '',
      hours: parseFloat(cls.required_hours) || 0,
      // Half of term: the class's own "runs" (Settings) wins; dates are the fallback for legacy rows.
      room: it?.room || '', span: it?.span || (cls.runs === 'first' ? 'first' : cls.runs === 'second' ? 'second' : cls.runs === 'full' ? 'both' : deriveSpan(cls, bounds)),
      color: it?.color || HUES[i % HUES.length].k, group: it?.group_key || '', note: it?.note || '',
      status: cls.status || 'Active', delivery: normalizeDelivery(cls.delivery),
    })
    assign[id] = { A: it?.slots_a || emptyWeek(), B: it?.slots_b || emptyWeek() }
  })
  items.filter(i => i.is_adhoc).forEach(it => {
    courses.push({
      id: it.item_id, classId: null, adhoc: true,
      code: it.code || '', title: it.title || '', instructor: it.instructor || '',
      hours: parseFloat(it.hours) || 0, room: it.room || '', span: it.span || 'first',
      color: it.color || 'blue', group: it.group_key || '', note: it.note || '', status: 'Active',
    })
    assign[it.item_id] = { A: it.slots_a || emptyWeek(), B: it.slots_b || emptyWeek() }
  })

  return normalize({
    scheduleId, semester,
    startHour: scheduleRow?.start_hour ?? 8,
    endHour: scheduleRow?.end_hour ?? 18,
    courses, assign,
  })
}

function itemRow(doc, c, order, who) {
  const a = ensure(doc, c.id)
  return {
    item_id: c.id, schedule_id: doc.scheduleId,
    class_id: c.adhoc ? null : c.classId, is_adhoc: !!c.adhoc,
    code: c.code || '', title: c.title || '', instructor: c.instructor || '', hours: +c.hours || 0,
    room: c.room || '', span: c.span || 'first', color: c.color || 'blue',
    group_key: c.group || '', note: c.note || '',
    slots_a: a.A, slots_b: a.B, sort_order: order,
    updated_at: new Date().toISOString(), updated_by: who,
  }
}
const rowKey = (r) => JSON.stringify([r.class_id, r.is_adhoc, r.code, r.title, r.instructor, r.hours, r.room, r.span, r.color, r.group_key, r.note, r.slots_a, r.slots_b, r.sort_order])

// ─── Schedule hook ────────────────────────────────────────────────────────────

export function useClassSchedule(semester, { canEdit = false, classes: semesterClasses = null } = {}) {
  const { profile } = useAuth()
  const who = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : ''
  const whoEmail = profile?.email || ''

  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  // 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'readonly'
  const [saveState, setSaveState] = useState('idle')
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [otherSchedules, setOtherSchedules] = useState([])

  const docRef = useRef(null)          // latest working doc
  const savedRef = useRef(null)        // last doc known to be in the DB (diff + change baseline)
  const timerRef = useRef(null)
  const savingRef = useRef(false)
  const dirtyRef = useRef(false)
  const pauseRef = useRef(false)       // true while dragging / a form is open — realtime reloads wait
  const semesterRef = useRef(semester)
  semesterRef.current = semester
  const classesRef = useRef(semesterClasses)
  classesRef.current = semesterClasses
  const loadSeqRef = useRef(0)         // a newer load always wins over an older one still in flight

  // ── load ──
  const load = useCallback(async (opts = {}) => {
    const name = semesterRef.current
    if (!name) { setDoc(null); docRef.current = null; savedRef.current = null; setLoading(false); return }
    // A silent reload (realtime / class list refresh) never clobbers edits
    // that haven't been saved yet — they'll be saved in a moment and the
    // next remote event reloads cleanly.
    if (opts.silent && (dirtyRef.current || savingRef.current)) return
    const mySeq = ++loadSeqRef.current
    if (!opts.silent) setLoading(true)
    try {
      const provided = classesRef.current
      const [classesRes, schedRes] = await Promise.all([
        provided
          ? Promise.resolve({ data: provided, error: null })
          : supabase.from('classes').select(CLASS_COLS).eq('semester', name).order('course_id'),
        supabase.from('class_schedules').select('*').eq('semester', name).maybeSingle(),
      ])
      const classes = mustData(classesRes, 'classes.select') || []
      const scheduleRow = mustData(schedRes, 'class_schedules.select')
      let items = []
      if (scheduleRow) {
        items = mustData(await supabase.from('class_schedule_items').select(ITEM_COLS)
          .eq('schedule_id', scheduleRow.schedule_id).order('sort_order'), 'class_schedule_items.select') || []
      }
      if (semesterRef.current !== name) return   // user switched while we were loading
      if (mySeq !== loadSeqRef.current) return    // a newer load superseded this one
      const built = buildDoc({ semester: name, scheduleRow, items, classes })
      docRef.current = built
      savedRef.current = clone(built)
      dirtyRef.current = false
      setDoc(built)
      setSaveState(canEdit ? 'saved' : 'readonly')
    } catch (e) {
      console.error('useClassSchedule load:', e)
      toast.error('Could not load the schedule: ' + e.message)
    }
    if (mySeq === loadSeqRef.current) setLoading(false)
  }, [canEdit])

  useEffect(() => { load() }, [load, semester])
  // Settings → Classes changed (hours, instructor, a new class in this
  // semester): refresh the merged doc without losing anything in flight.
  useEffect(() => {
    if (docRef.current && docRef.current.semester === semesterRef.current) load({ silent: true })
  }, [semesterClasses, load])

  // Other semesters that already have a saved schedule (for "Copy layout from…").
  const loadOthers = useCallback(async () => {
    try {
      const rows = mustData(await supabase.from('class_schedules').select('schedule_id, semester, updated_at'), 'class_schedules.select') || []
      setOtherSchedules(rows.filter(r => r.semester !== semesterRef.current)
        .sort((a, b) => parseSemester(b.semester).order - parseSemester(a.semester).order))
    } catch { /* non-essential */ }
  }, [])
  useEffect(() => { loadOthers() }, [loadOthers, semester])

  // ── history ──
  const refreshHistory = useCallback(async () => {
    const id = docRef.current?.scheduleId
    if (!id) { setHistory([]); return }
    setHistoryLoading(true)
    try {
      const rows = mustData(await supabase.from('audit_log')
        .select('log_id, timestamp, user_name, user_email, action, details')
        .eq('entity_type', 'Class Schedule').eq('entity_id', id)
        .order('timestamp', { ascending: false }).limit(100), 'audit_log.select') || []
      setHistory(rows.map(r => {
        const lines = String(r.details || '').split('\n').filter(Boolean)
        return { id: r.log_id, at: r.timestamp, who: r.user_name || r.user_email || 'Unknown', action: r.action, lines }
      }))
    } catch (e) {
      console.warn('history:', e.message)
    }
    setHistoryLoading(false)
  }, [])

  // ── save ──
  const save = useCallback(async () => {
    if (!canEdit || savingRef.current || !dirtyRef.current) return
    const current = docRef.current, base = savedRef.current
    if (!current) return
    savingRef.current = true
    setSaveState('saving')
    try {
      const nowIso = new Date().toISOString()
      // 1. schedule row (idempotent)
      const { error: sErr } = assertWrite(await supabase.from('class_schedules').upsert({
        schedule_id: current.scheduleId, semester: current.semester,
        start_hour: current.startHour, end_hour: current.endHour,
        updated_at: nowIso, updated_by: who,
      }, { onConflict: 'schedule_id', ignoreDuplicates: false }).select(), 'class_schedules.upsert')
      if (sErr) throw sErr

      // 2. changed / new items
      const baseRows = new Map()
      if (base) base.courses.forEach((c, i) => baseRows.set(c.id, rowKey(itemRow(base, c, i, who))))
      const upserts = []
      current.courses.forEach((c, i) => {
        const r = itemRow(current, c, i, who)
        if (baseRows.get(c.id) !== rowKey(r)) upserts.push(r)
      })
      if (upserts.length) {
        const written = mustData(await supabase.from('class_schedule_items')
          .upsert(upserts, { onConflict: 'item_id' }).select('item_id'), 'class_schedule_items.upsert') || []
        if (written.length !== upserts.length) throw new Error(`Saved ${written.length} of ${upserts.length} classes — you may not have permission to edit the schedule`)
      }

      // 3. removed ad-hoc items
      const gone = (base?.courses || []).filter(c => c.adhoc && !current.courses.some(x => x.id === c.id)).map(c => c.id)
      if (gone.length) {
        const { error: dErr } = assertWrite(await supabase.from('class_schedule_items').delete().in('item_id', gone).select('item_id'), 'class_schedule_items.delete')
        if (dErr) throw dErr
      }

      // 4. audit — one row per save, plain-English diff
      const lines = diffDocs(base, current)
      if (lines.length) {
        const shown = lines.slice(0, MAX_AUDIT_LINES)
        if (lines.length > MAX_AUDIT_LINES) shown.push(`+${lines.length - MAX_AUDIT_LINES} more change${lines.length - MAX_AUDIT_LINES === 1 ? '' : 's'}`)
        try {
          await supabase.from('audit_log').insert({
            log_id: `AUD${Date.now()}`,
            timestamp: nowIso,
            user_email: whoEmail,
            user_name: who,
            action: 'Update',
            entity_type: 'Class Schedule',
            entity_id: current.scheduleId,
            details: shown.join('\n'),
          })
        } catch (auditErr) {
          console.error('Class schedule audit error:', auditErr)
        }
      }

      savedRef.current = clone(current)
      dirtyRef.current = false
      setSaveState('saved')
      refreshHistory()
    } catch (e) {
      console.error('useClassSchedule save:', e)
      setSaveState('error')
      toast.error('Schedule not saved: ' + e.message)
    } finally {
      savingRef.current = false
      // Edits that landed while we were saving
      if (dirtyRef.current) { clearTimeout(timerRef.current); timerRef.current = setTimeout(save, SAVE_DEBOUNCE_MS) }
    }
  }, [canEdit, who, whoEmail, refreshHistory])

  const scheduleSave = useCallback(() => {
    if (!canEdit) return
    dirtyRef.current = true
    setSaveState('unsaved')
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(save, SAVE_DEBOUNCE_MS)
  }, [canEdit, save])

  /** Apply `mutator(docClone)` and schedule a save. Returns the new doc. */
  const commit = useCallback((mutator, { silent = false } = {}) => {
    if (!docRef.current) return null
    const next = clone(docRef.current)
    mutator(next)
    normalize(next)
    docRef.current = next
    setDoc(next)
    if (!silent) scheduleSave()
    return next
  }, [scheduleSave])

  const retrySave = useCallback(() => { dirtyRef.current = true; save() }, [save])

  // Flush on unmount / tab close so a half-second debounce never loses work.
  useEffect(() => {
    const flush = () => { if (dirtyRef.current && !savingRef.current) { clearTimeout(timerRef.current); save() } }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [save])

  // ── realtime ──
  useEffect(() => {
    const id = doc?.scheduleId
    if (!id) return undefined
    const onRemote = () => {
      if (pauseRef.current || dirtyRef.current || savingRef.current) return
      load({ silent: true })
    }
    return subscribeWithReconnect(`class-sched-${id}-${Date.now()}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'class_schedule_items', filter: `schedule_id=eq.${id}` }, onRemote)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'class_schedules', filter: `schedule_id=eq.${id}` }, onRemote)
    , { tag: 'ClassSchedule' })
  }, [doc?.scheduleId, load])

  const setPaused = useCallback((v) => { pauseRef.current = !!v }, [])

  // ── higher-level edits ──
  const addAdhoc = useCallback((data) => {
    let created = null
    commit(d => {
      created = {
        id: `CSI-${d.scheduleId}-adhoc-${uid()}`, classId: null, adhoc: true,
        code: data.code || '', title: data.title || '', instructor: data.instructor || '',
        hours: +data.hours || 0, room: data.room || '', span: data.span || 'first',
        color: data.color || HUES[d.courses.length % HUES.length].k, group: '', note: data.note || '',
      }
      d.courses.push(created)
      d.assign[created.id] = { A: emptyWeek(), B: emptyWeek() }
    })
    return created
  }, [commit])

  /** Ad-hoc classes are removed; linked classes only lose their blocks (they live in Settings). */
  const removeCourse = useCallback((id) => {
    commit(d => {
      const c = d.courses.find(x => x.id === id); if (!c) return
      if (c.adhoc) { d.courses = d.courses.filter(x => x.id !== id); delete d.assign[id] }
      else d.assign[id] = { A: emptyWeek(), B: emptyWeek() }
    })
  }, [commit])

  /**
   * Seed classes that have NO blocks yet from another semester's schedule,
   * matched by course number (same instructor preferred). Copies room,
   * colour, note and blocks; recreates combined groups when every member
   * copied. Never touches a class that already has time on the grid.
   */
  const copyFromSemester = useCallback(async (sourceSemester) => {
    const cur = docRef.current
    if (!cur || !canEdit) return { copied: 0, skipped: 0 }
    const src = mustData(await supabase.from('class_schedules').select('schedule_id, semester').eq('semester', sourceSemester).maybeSingle(), 'class_schedules.select')
    if (!src) throw new Error(`No saved schedule for ${sourceSemester}`)
    const srcItems = mustData(await supabase.from('class_schedule_items').select(ITEM_COLS).eq('schedule_id', src.schedule_id), 'class_schedule_items.select') || []
    const byCode = new Map()
    for (const it of srcItems) {
      const k = String(it.code || '').trim().toLowerCase(); if (!k) continue
      if (!byCode.has(k)) byCode.set(k, [])
      byCode.get(k).push(it)
    }
    let copied = 0, skipped = 0
    const groupMap = new Map()   // source group_key → new gid
    commit(d => {
      for (const c of d.courses) {
        const a = ensure(d, c.id)
        const hasTime = [...a.A, ...a.B].some(day => day.length)
        if (hasTime) { skipped++; continue }
        const cands = byCode.get(String(c.code || '').trim().toLowerCase()) || []
        if (!cands.length) continue
        const it = cands.find(x => x.instructor && c.instructor && x.instructor.trim().toLowerCase() === c.instructor.trim().toLowerCase()) || cands[0]
        c.room = it.room || c.room
        c.color = it.color || c.color
        c.note = it.note || c.note
        // Blocks: prefer the same half; if this class now runs in the other
        // half, carry the source's blocks across so nothing is lost.
        const sa = it.slots_a || emptyWeek(), sb = it.slots_b || emptyWeek()
        const pt = primaryTerm(c)
        const srcPrimary = pt === 'A' ? sa : sb, srcOther = pt === 'A' ? sb : sa
        const take = srcPrimary.some(dy => dy.length) ? srcPrimary : srcOther
        for (const t of termsOf(c)) d.assign[c.id][t] = clone(take)
        if (it.group_key) {
          if (!groupMap.has(it.group_key)) groupMap.set(it.group_key, 'g' + uid())
          c.group = groupMap.get(it.group_key)
        }
        copied++
      }
    })
    return { copied, skipped }
  }, [commit, canEdit])

  return {
    doc, loading, saveState, canEdit,
    commit, retrySave, setPaused,
    history, historyLoading, refreshHistory,
    otherSchedules, copyFromSemester,
    addAdhoc, removeCourse,
    reload: () => load(),
  }
}

export { DAYS }
