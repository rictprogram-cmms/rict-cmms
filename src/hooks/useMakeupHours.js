/**
 * RICT CMMS — Make-Up Hours overlay
 *
 * Approved absence requests add their `hours_missed` to the student's required
 * lab hours for the FOLLOWING week (absence `week_start` + 7 days), for the
 * same course. Program policy: make-up hours are completed during the first
 * two lab days of that week (Section 4.3).
 *
 * This module is a pure OVERLAY. Nothing is written to `classes` — consumers
 * add the returned hours to `classes.required_hours` at render/compute time,
 * so un-approving or deleting a request removes the extra hours instantly.
 *
 * Exports
 *   fetchMakeupOverlay({ emails, rangeStart, rangeEnd, classesById })
 *       → Promise<MakeupOverlay>
 *   makeupWeekMonday(absenceWeekStart)      'YYYY-MM-DD' of the make-up week Monday
 *   mondayKeyOf(dateStr)                    Monday 'YYYY-MM-DD' for any date (Sun → prior Monday)
 *   overlayKey(email, mondayKey, courseId)  lookup key builder
 *   getMakeupHours(overlay, email, mondayKey, courseOrClassId) → number
 *   getMakeupInfo(overlay, email, mondayKey, courseOrClassId)  → { hours, requests[] } | null
 *   firstTwoLabDays(weekDays, visibleDays)  first two OPEN lab days from a lab-signup week
 *   useMakeupOverlay({ emails, rangeStart, rangeEnd, enabled }) React hook (realtime-refreshing)
 *
 * Conventions honored
 *   - Date-only strings parsed with 'T00:00:00' (local), never toISOString()
 *   - Dual-format matching: requests may carry course_id (RICT1610) and/or
 *     class_id (CLS1020); both are indexed so any consumer key works
 *   - Unique per-mount realtime channel name + removeChannel cleanup
 *
 * File: src/hooks/useMakeupHours.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0') }

function toKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseLocal(dateStr) {
  if (!dateStr) return null
  const s = String(dateStr).length >= 10 ? String(dateStr).substring(0, 10) : String(dateStr)
  const d = new Date(s + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

/** Monday 'YYYY-MM-DD' for any date string. Sunday belongs to the PRIOR Monday week. */
export function mondayKeyOf(dateStr) {
  const d = parseLocal(dateStr)
  if (!d) return null
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return toKey(d)
}

/** Make-up week Monday for an absence week_start (Monday) → +7 days. */
export function makeupWeekMonday(absenceWeekStart) {
  const d = parseLocal(absenceWeekStart)
  if (!d) return null
  d.setDate(d.getDate() + 7)
  return toKey(d)
}

/**
 * First two OPEN lab days from a lab-signup `week.days` array (objects with
 * { date, dayOfWeek, isOpen }). `visibleDays` is the lab_visible_days setting
 * (array of JS day numbers). Closed days (holidays) roll to the next open day.
 * Falls back to the first two visible days when no day is flagged open.
 */
export function firstTwoLabDays(weekDays, visibleDays = [1, 2, 3, 4]) {
  const days = (weekDays || []).filter(d => visibleDays.includes(d.dayOfWeek))
  const open = days.filter(d => d.isOpen).slice(0, 2).map(d => d.date)
  if (open.length > 0) return open
  return days.slice(0, 2).map(d => d.date)
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

export function overlayKey(email, mondayKey, courseId) {
  return `${(email || '').toLowerCase().trim()}|${mondayKey || ''}|${(courseId || '').trim()}`
}

/**
 * @typedef {Object} MakeupOverlay
 * @property {Object<string,{hours:number, requests:Array}>} byKey  overlayKey → entry
 * @property {Array} requests                                     raw approved requests in scope
 */

/**
 * Load approved absence requests and build the overlay.
 *
 * @param {Object}   p
 * @param {string[]} [p.emails]       limit to these student emails (omit = all)
 * @param {string}   [p.rangeStart]   'YYYY-MM-DD' — include requests whose MAKE-UP week
 *                                    Monday is on/after this (minus a week of slack)
 * @param {string}   [p.rangeEnd]     'YYYY-MM-DD' — … and on/before this
 * @param {Object}   [p.classesById]  { [course_id|class_id]: { end_date, course_id, class_id } }
 *                                    used to IGNORE make-ups that land after the class ends.
 *                                    If omitted, classes are fetched here.
 * @returns {Promise<MakeupOverlay>}
 */
export async function fetchMakeupOverlay({ emails, rangeStart, rangeEnd, classesById } = {}) {
  const empty = { byKey: {}, requests: [] }

  let q = supabase
    .from('absence_requests')
    .select('request_id, user_email, course_id, class_id, absence_date, week_start, hours_missed, status, deduction_status, makeup_complete')
    .eq('status', 'Approved')
    .gt('hours_missed', 0)

  if (Array.isArray(emails) && emails.length > 0) {
    q = q.in('user_email', emails.map(e => (e || '').toLowerCase().trim()).filter(Boolean))
  }
  // Make-up week = week_start + 7, so filter week_start by (range − 7 days)
  if (rangeStart) {
    const d = parseLocal(rangeStart); d.setDate(d.getDate() - 14)
    q = q.gte('week_start', toKey(d))
  }
  if (rangeEnd) {
    const d = parseLocal(rangeEnd); d.setDate(d.getDate() - 7)
    q = q.lte('week_start', toKey(d))
  }

  const { data, error } = await q
  if (error) {
    console.error('fetchMakeupOverlay failed:', error.message)
    return empty
  }
  const rows = data || []
  if (rows.length === 0) return empty

  // Class end dates — needed to drop make-ups that fall after the class ends
  let classMap = classesById
  if (!classMap) {
    const ids = [...new Set(rows.flatMap(r => [r.course_id, r.class_id]).filter(Boolean))]
    const { data: cls } = await supabase
      .from('classes')
      .select('class_id, course_id, end_date')
      .or(`course_id.in.(${ids.join(',')}),class_id.in.(${ids.join(',')})`)
    classMap = {}
    ;(cls || []).forEach(c => {
      if (c.course_id) classMap[c.course_id] = c
      if (c.class_id) classMap[c.class_id] = c
    })
  }

  const byKey = {}
  const kept = []
  for (const r of rows) {
    const mk = makeupWeekMonday(r.week_start || mondayKeyOf(r.absence_date))
    if (!mk) continue

    const cls = classMap[r.course_id] || classMap[r.class_id] || null
    const endDate = cls?.end_date ? String(cls.end_date).substring(0, 10) : null
    // Policy #5: absence in the final week → nothing to make up, hours NOT added
    if (endDate && mk > endDate) continue

    const hours = Number(r.hours_missed) || 0
    const email = (r.user_email || '').toLowerCase().trim()
    const entry = {
      requestId: r.request_id,
      absenceDate: r.absence_date,
      hours,
      makeupComplete: !!r.makeup_complete,
      deductionStatus: r.deduction_status || '',
      courseId: r.course_id || '',
      classId: r.class_id || '',
      makeupWeekMonday: mk,
    }
    kept.push({ ...r, makeupWeekMonday: mk })

    // Index under BOTH ids (dual-format rule), plus the class's canonical ids
    const idSet = new Set([r.course_id, r.class_id, cls?.course_id, cls?.class_id].filter(Boolean))
    for (const id of idSet) {
      const k = overlayKey(email, mk, id)
      if (!byKey[k]) byKey[k] = { hours: 0, requests: [] }
      // Same request may hit the same key via multiple ids — guard once per key
      if (!byKey[k].requests.some(x => x.requestId === entry.requestId)) {
        byKey[k].hours += hours
        byKey[k].requests.push(entry)
      }
    }
  }

  return { byKey, requests: kept }
}

/** Hours to add for a given student/week/course (0 when none). */
export function getMakeupHours(overlay, email, mondayKey, courseOrClassId) {
  return getMakeupInfo(overlay, email, mondayKey, courseOrClassId)?.hours || 0
}

/** Full entry for a given student/week/course, or null. */
export function getMakeupInfo(overlay, email, mondayKey, courseOrClassId) {
  if (!overlay?.byKey || !mondayKey) return null
  const e = overlay.byKey[overlayKey(email, mondayKey, courseOrClassId)]
  return e && e.hours > 0 ? e : null
}

// ─── React hook ───────────────────────────────────────────────────────────────

function makeChannelSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Reactive overlay for a page. Refreshes on any absence_requests change.
 */
export function useMakeupOverlay({ emails, rangeStart, rangeEnd, enabled = true } = {}) {
  const [overlay, setOverlay] = useState({ byKey: {}, requests: [] })
  const [loading, setLoading] = useState(!!enabled)
  const emailsKey = Array.isArray(emails) ? emails.join(',') : ''
  const latest = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled) { setOverlay({ byKey: {}, requests: [] }); setLoading(false); return }
    const id = ++latest.current
    setLoading(true)
    const result = await fetchMakeupOverlay({
      emails: emailsKey ? emailsKey.split(',') : undefined,
      rangeStart, rangeEnd,
    })
    if (id === latest.current) { setOverlay(result); setLoading(false) }
  }, [enabled, emailsKey, rangeStart, rangeEnd])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!enabled) return undefined
    const channel = supabase
      .channel(`makeup-overlay-${makeChannelSuffix()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'absence_requests' }, refresh)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [enabled, refresh])

  return { overlay, loading, refresh }
}
