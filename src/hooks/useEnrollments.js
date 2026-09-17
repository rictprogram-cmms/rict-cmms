/**
 * RICT CMMS — useEnrollments
 *
 * Enrollment per class offering (class_enrollments). profiles.classes is a
 * derived cache kept by a database trigger, so nothing here writes to it.
 *
 *   useEnrollmentCounts()          → { byClass: Map<class_id, [{email,name,archived}]>, loading }
 *                                    realtime on class_enrollments + profiles
 *   useClassRoster(classId)        → { roster: [{ enrollment_id, email, name, archived }], loading, refresh }
 *   useStudentEnrollments(email)   → { enrollments: [{ enrollment_id, class }], loading }
 *   useEnrollmentActions()         → { saving, setRoster(cls, emails), enroll(cls, email), unenroll(cls, email) }
 *
 * Every write is validated (row counts) and audited ("Enrollment" /
 * class_id, details name the students). Instructors only (RLS + UI).
 *
 * File: src/hooks/useEnrollments.js
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

const fullName = (p) => `${p?.first_name || ''} ${p?.last_name || ''}`.trim() || p?.email || ''

/** Every enrollment joined to the student's profile, grouped by class. */
export function useEnrollmentCounts() {
  const [byClass, setByClass] = useState(new Map())
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [enr, profs] = await Promise.all([
        supabase.from('class_enrollments').select('enrollment_id, class_id, student_email'),
        supabase.from('profiles').select('email, first_name, last_name, status').in('role', ['Student', 'Work Study']),
      ])
      const rows = mustData(enr, 'class_enrollments.select') || []
      const people = new Map((mustData(profs, 'profiles.select') || []).map(p => [String(p.email || '').toLowerCase(), p]))
      const m = new Map()
      for (const r of rows) {
        const p = people.get(String(r.student_email).toLowerCase())
        if (!m.has(r.class_id)) m.set(r.class_id, [])
        m.get(r.class_id).push({ enrollment_id: r.enrollment_id, email: r.student_email, name: p ? fullName(p) : r.student_email, archived: p?.status === 'Archived', unknown: !p })
      }
      for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name))
      setByClass(m)
    } catch (e) {
      console.error('useEnrollmentCounts:', e)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => subscribeWithReconnect(`enrollment-counts-${Math.random().toString(36).slice(2)}`, ch => ch
    .on('postgres_changes', { event: '*', schema: 'public', table: 'class_enrollments' }, load)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, load)
  , { tag: 'Enrollments' }), [load])

  return { byClass, loading, refresh: load }
}

/** One class's roster. */
export function useClassRoster(classId) {
  const [roster, setRoster] = useState([])
  const [loading, setLoading] = useState(!!classId)

  const load = useCallback(async () => {
    if (!classId) { setRoster([]); setLoading(false); return }
    try {
      const rows = mustData(await supabase.from('class_enrollments').select('enrollment_id, student_email, enrolled_at, enrolled_by').eq('class_id', classId), 'class_enrollments.select') || []
      const emails = rows.map(r => r.student_email)
      let people = new Map()
      if (emails.length) {
        const profs = mustData(await supabase.from('profiles').select('email, first_name, last_name, status, role').in('email', emails), 'profiles.select') || []
        people = new Map(profs.map(p => [String(p.email).toLowerCase(), p]))
      }
      setRoster(rows.map(r => {
        const p = people.get(String(r.student_email).toLowerCase())
        return { ...r, email: r.student_email, name: p ? fullName(p) : r.student_email, archived: p?.status === 'Archived', unknown: !p }
      }).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) {
      console.error('useClassRoster:', e)
    }
    setLoading(false)
  }, [classId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!classId) return undefined
    return subscribeWithReconnect(`roster-${classId}-${Math.random().toString(36).slice(2)}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'class_enrollments', filter: `class_id=eq.${classId}` }, load)
    , { tag: 'Enrollments' })
  }, [classId, load])

  return { roster, loading, refresh: load }
}

/** Everything one student is enrolled in, with the class rows. */
export function useStudentEnrollments(email) {
  const [enrollments, setEnrollments] = useState([])
  const [loading, setLoading] = useState(!!email)

  const load = useCallback(async () => {
    if (!email) { setEnrollments([]); setLoading(false); return }
    try {
      const rows = mustData(await supabase.from('class_enrollments').select('enrollment_id, class_id, enrolled_at').ilike('student_email', email), 'class_enrollments.select') || []
      const ids = rows.map(r => r.class_id)
      let classes = []
      if (ids.length) classes = mustData(await supabase.from('classes').select('class_id, course_id, course_name, semester, term_id, status, start_date, end_date, instructor').in('class_id', ids), 'classes.select') || []
      const byId = new Map(classes.map(c => [c.class_id, c]))
      setEnrollments(rows.map(r => ({ ...r, class: byId.get(r.class_id) || null })).filter(r => r.class))
    } catch (e) {
      console.error('useStudentEnrollments:', e)
    }
    setLoading(false)
  }, [email])

  useEffect(() => { load() }, [load])
  return { enrollments, loading, refresh: load }
}

export function useEnrollmentActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const who = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''

  const audit = async (cls, details) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: profile?.email, user_name: who, action: 'Update',
        entity_type: 'Enrollment', entity_id: cls.class_id,
        details: `${cls.course_id} ${cls.semester || ''}: ${details}`.trim(),
      })
    } catch (e) { console.error('enrollment audit:', e) }
  }

  /**
   * Make the class roster exactly `emails` (adds the missing, removes the
   * rest). `labels` maps email → display name for the audit line.
   */
  const setRoster = useCallback(async (cls, emails, labels = {}) => {
    setSaving(true)
    try {
      const want = new Set(emails.map(e => String(e).toLowerCase()))
      const current = mustData(await supabase.from('class_enrollments').select('enrollment_id, student_email').eq('class_id', cls.class_id), 'class_enrollments.select') || []
      const have = new Map(current.map(r => [String(r.student_email).toLowerCase(), r]))
      const toAdd = [...want].filter(e => !have.has(e))
      const toRemove = current.filter(r => !want.has(String(r.student_email).toLowerCase()))

      if (toAdd.length) {
        const rows = toAdd.map(e => ({ class_id: cls.class_id, student_email: e, enrolled_by: who }))
        const ins = mustData(await supabase.from('class_enrollments').insert(rows).select('enrollment_id'), 'class_enrollments.insert') || []
        if (ins.length !== rows.length) throw new Error(`Enrolled ${ins.length} of ${rows.length} — you may not have permission to manage enrollment`)
      }
      if (toRemove.length) {
        const { error } = assertWrite(await supabase.from('class_enrollments').delete().in('enrollment_id', toRemove.map(r => r.enrollment_id)).select('enrollment_id'), 'class_enrollments.delete')
        if (error) throw error
      }
      if (toAdd.length || toRemove.length) {
        const nm = e => labels[e] || e
        const parts = []
        if (toAdd.length) parts.push(`enrolled ${toAdd.map(nm).join(', ')}`)
        if (toRemove.length) parts.push(`unenrolled ${toRemove.map(r => nm(String(r.student_email).toLowerCase())).join(', ')}`)
        await audit(cls, parts.join('; '))
        toast.success(`Enrollment updated — ${toAdd.length} added, ${toRemove.length} removed`)
      } else {
        toast('No enrollment changes', { icon: 'ℹ️' })
      }
      return true
    } catch (e) {
      toast.error(e.message || 'Enrollment not saved')
      return false
    } finally { setSaving(false) }
  }, [who, profile?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  const enroll = useCallback(async (cls, email, label) => {
    setSaving(true)
    try {
      const ins = mustData(await supabase.from('class_enrollments').upsert({ class_id: cls.class_id, student_email: String(email).toLowerCase(), enrolled_by: who }, { onConflict: 'class_id,student_email' }).select('enrollment_id'), 'class_enrollments.upsert') || []
      if (!ins.length) throw new Error('Enroll was blocked — you may not have permission')
      await audit(cls, `enrolled ${label || email}`)
      return true
    } catch (e) { toast.error(e.message); return false } finally { setSaving(false) }
  }, [who, profile?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  const unenroll = useCallback(async (cls, email, label) => {
    setSaving(true)
    try {
      const { error, data } = assertWrite(await supabase.from('class_enrollments').delete().eq('class_id', cls.class_id).ilike('student_email', email).select('enrollment_id'), 'class_enrollments.delete')
      if (error) throw error
      if (!data || !data.length) throw new Error('Nothing removed — the student may not be enrolled')
      await audit(cls, `unenrolled ${label || email}`)
      return true
    } catch (e) { toast.error(e.message); return false } finally { setSaving(false) }
  }, [who, profile?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  return { saving, setRoster, enroll, unenroll }
}

/** Helper for pages that only have profile rows: current course numbers from the cache. */
export function cachedCourseIds(profileRow) {
  return String(profileRow?.classes || '').split(',').map(s => s.trim()).filter(Boolean)
}

export default useEnrollmentActions
