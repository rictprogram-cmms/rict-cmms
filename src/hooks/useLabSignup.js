import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { fetchMakeupOverlay, getMakeupInfo, mondayKeyOf, firstTwoLabDays } from '@/hooks/useMakeupHours'

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Pre-semester signup lead window (days).
 *
 * A student's class appears in the Lab Signup picker starting this many days
 * BEFORE the class's start_date, so students can book week-1 lab slots ahead
 * of the semester. Previously classes were hidden until start_date itself,
 * which locked everyone out of signup during the week before classes began.
 *
 * This only controls picker visibility — the lab calendar remains the gate
 * on which days/slots are actually open, and the weekly deadline / approval
 * flow is unchanged. Other pages (Time Clock, Dashboard, Weekly Labs,
 * Volunteer Hours) intentionally still hide classes until start_date, since
 * hours can't be earned before a class begins.
 */
export const SIGNUP_LEAD_DAYS = 14

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function formatHour(hour) {
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h = hour % 12 || 12
  return `${h}:00 ${ampm}`
}

function getHourFromTime(timeStr) {
  if (!timeStr) return null
  if (typeof timeStr === 'string') {
    const match24 = timeStr.match(/^(\d{2}):(\d{2})/)
    if (match24) return parseInt(match24[1])
    const matchAmPm = timeStr.toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/)
    if (matchAmPm) {
      let h = parseInt(matchAmPm[1])
      const ap = matchAmPm[3]
      if (ap === 'PM' && h !== 12) h += 12
      if (ap === 'AM' && h === 12) h = 0
      return h
    }
  }
  return null
}

function getWeekStart(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay()) // Sunday
  d.setHours(0, 0, 0, 0)
  return d
}

function isDeadlinePassed(weekStartDate) {
  // Deadline is Sunday at 11:59 PM Central Time
  const now = new Date()
  const deadline = new Date(weekStartDate)
  deadline.setHours(23, 59, 59, 999)
  return now > deadline
}

// ─── Closure-block helpers ──────────────────────────────────────────────────
// closed_blocks is a JSONB array of { start: 'HH:MM', end: 'HH:MM', reason: string }.
// Times are 24-hour local. `end` is exclusive. `reason` is a short label.

/** Parse 'HH:MM' or 'HH:MM:SS' into total minutes-since-midnight. Returns null on parse failure. */
function timeToMinutes(timeStr) {
  if (typeof timeStr !== 'string') return null
  const m = timeStr.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (isNaN(h) || isNaN(mm)) return null
  return h * 60 + mm
}

/** Format minutes-since-midnight as 'HH:MM' (24-hour). */
function minutesToTimeStr(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Coerce a possibly-NULL/string/array `closed_blocks` value into a sanitized array. */
function normalizeClosedBlocks(raw) {
  let arr = raw
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map(b => {
      if (!b || typeof b !== 'object') return null
      const startMin = timeToMinutes(b.start)
      const endMin   = timeToMinutes(b.end)
      if (startMin == null || endMin == null) return null
      if (endMin <= startMin) return null
      return {
        start:  minutesToTimeStr(startMin),
        end:    minutesToTimeStr(endMin),
        reason: typeof b.reason === 'string' ? b.reason : '',
      }
    })
    .filter(Boolean)
}

/**
 * Returns the closure reason string if the time-range [slotStartMin, slotEndMin)
 * overlaps any block in closedBlocks, otherwise null. The first overlapping
 * block's reason wins.
 */
function findOverlappingClosure(slotStartMin, slotEndMin, closedBlocks) {
  if (!Array.isArray(closedBlocks) || closedBlocks.length === 0) return null
  for (const b of closedBlocks) {
    const bs = timeToMinutes(b.start)
    const be = timeToMinutes(b.end)
    if (bs == null || be == null) continue
    if (bs < slotEndMin && be > slotStartMin) {
      return (b.reason && String(b.reason).trim()) || 'Lab closed'
    }
  }
  return null
}

/** Convenience for hour-based slots: an hour H covers [H*60, H*60+60). */
function findClosureForHour(hour, closedBlocks) {
  return findOverlappingClosure(hour * 60, hour * 60 + 60, closedBlocks)
}

export {
  formatDateKey, formatHour, getHourFromTime, getWeekStart, isDeadlinePassed,
  timeToMinutes, minutesToTimeStr, normalizeClosedBlocks,
  findOverlappingClosure, findClosureForHour,
}

// ─── Timestamp helper (fake-UTC convention) ─────────────────────────────────
// Keep the local wall-clock time but tag it +00, per project convention.
// Used for created_at writes so lab tables match the rest of the app.
function localToUtcIso(date) {
  if (date == null) return null
  const d = (date instanceof Date) ? date : new Date(date)
  if (isNaN(d.getTime())) return null
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+00:00`
}

// ─── Audit-log helpers ──────────────────────────────────────────────────────
// Every write in this file now leaves an audit_log row so instructors can see
// who changed lab hours, who cancelled a signup, etc. Audit writes are
// non-critical: a failure is logged to the console but never blocks the save.

/**
 * Whether student self-signups / self-cancellations get audit rows.
 * Set to false if the volume becomes noise — instructor and calendar
 * actions are always logged regardless of this flag.
 */
const AUDIT_STUDENT_SIGNUPS = true

/** "First L." display name for audit rows — matches useSettings / screenshot convention. */
function auditNameOf(profile) {
  if (!profile) return ''
  const first = profile.first_name || ''
  const last  = profile.last_name || ''
  return `${first}${last ? ` ${last.charAt(0)}.` : ''}`.trim()
}

/** Insert one or many audit rows. Never throws. */
async function writeAudit(profile, entryOrEntries) {
  const list = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries]
  if (list.length === 0) return
  try {
    const rows = list.map(e => ({
      user_email: profile?.email || '',
      user_name:  auditNameOf(profile),
      ...e,
    }))
    const { error } = await supabase.from('audit_log').insert(rows)
    if (error) console.warn('Audit log write failed (non-critical):', error.message)
  } catch (e) {
    console.warn('Audit log write threw (non-critical):', e?.message || e)
  }
}

/** 'YYYY-MM-DD' → 'Mon, Aug 25, 2026' (local parse — no zone shift). */
function formatDateLabel(dateStr) {
  if (!dateStr) return ''
  const d = new Date(String(dateStr).substring(0, 10) + 'T00:00:00')
  if (isNaN(d.getTime())) return String(dateStr)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

/** lab_signup.date (ISO of local noon) → 'Mon, Aug 25, 2026'. */
function formatDateLabelFromIso(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

/** 'HH:MM' / 'HH:MM:SS' → '8:00 AM'. */
function formatTimeLabel(timeStr) {
  const min = timeToMinutes(timeStr)
  if (min == null) return timeStr ? String(timeStr) : '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

function formatLunchLabel(lunchHour) {
  if (lunchHour == null || lunchHour === '') return 'None'
  const n = parseInt(lunchHour, 10)
  return isNaN(n) ? 'None' : formatHour(n)
}

function formatBlocksLabel(blocks) {
  const arr = normalizeClosedBlocks(blocks)
  if (arr.length === 0) return 'None'
  return arr
    .map(b => `${formatTimeLabel(b.start)}–${formatTimeLabel(b.end)}${b.reason ? ` (${b.reason})` : ''}`)
    .join('; ')
}

/** One-line snapshot of a lab_calendar payload, for Create/Delete audit rows. */
function describeLabDay(row) {
  const parts = [row.status || 'Open']
  parts.push(`${formatTimeLabel(row.start_time)} – ${formatTimeLabel(row.end_time)}`)
  parts.push(`max ${row.max_students ?? 24}`)
  parts.push(`lunch ${formatLunchLabel(row.lunch_hour)}`)
  const blocks = formatBlocksLabel(row.closed_blocks)
  if (blocks !== 'None') parts.push(`closed ${blocks}`)
  if ((row.notes || '').trim()) parts.push(`notes: ${row.notes.trim()}`)
  return parts.join(', ')
}

/**
 * Compare the existing lab_calendar row against the update payload and
 * return [{ label, before, after }] for every field that actually changed.
 * Times are compared as minutes so '08:00' vs '08:00:00' is not a change.
 */
function diffLabDay(existing, next) {
  const changes = []
  const cmp = (label, before, after, beforeLabel, afterLabel) => {
    if (before !== after) {
      changes.push({ label, before: beforeLabel ?? String(before), after: afterLabel ?? String(after) })
    }
  }

  cmp('Status', existing.status || 'Open', next.status)

  const oldHours = `${timeToMinutes(existing.start_time)}-${timeToMinutes(existing.end_time)}`
  const newHours = `${timeToMinutes(next.start_time)}-${timeToMinutes(next.end_time)}`
  cmp('Hours', oldHours, newHours,
    `${formatTimeLabel(existing.start_time)} – ${formatTimeLabel(existing.end_time)}`,
    `${formatTimeLabel(next.start_time)} – ${formatTimeLabel(next.end_time)}`)

  cmp('Max students', Number(existing.max_students) || 24, Number(next.max_students) || 24)

  const oldLunch = existing.lunch_hour == null ? null : parseInt(existing.lunch_hour, 10)
  const newLunch = next.lunch_hour == null ? null : parseInt(next.lunch_hour, 10)
  cmp('Lunch hour', oldLunch, newLunch, formatLunchLabel(oldLunch), formatLunchLabel(newLunch))

  const oldNotes = (existing.notes || '').trim()
  const newNotes = (next.notes || '').trim()
  cmp('Notes', oldNotes, newNotes, oldNotes || '(none)', newNotes || '(none)')

  const oldBlocks = normalizeClosedBlocks(existing.closed_blocks)
  const newBlocks = normalizeClosedBlocks(next.closed_blocks)
  cmp('Closed periods', JSON.stringify(oldBlocks), JSON.stringify(newBlocks),
    formatBlocksLabel(oldBlocks), formatBlocksLabel(newBlocks))

  return changes
}

// ─── Collision-safe calendar ID ─────────────────────────────────────────────
/**
 * Generate the next lab_calendar ID (CAL####) without the MAX+1 race.
 *
 * Mirrors the generateSafeAssetId / generateSafeWoId pattern:
 *  1. Ask the `get_next_id` RPC (p_type = 'lab_calendar').
 *  2. Always also scan MAX(CAL####) — the counter row may be missing or
 *     behind reality; the higher of the two wins.
 *  3. Verify the candidate doesn't exist; bump and retry on collision.
 *  4. Write the final number back to `counters` so drift self-heals.
 *
 * Requires a `counters` row named 'lab_calendar' (see migration in the
 * release notes). If the row is missing, the MAX-scan path still works and
 * the sync step is a harmless no-op.
 */
const CAL_PREFIX = 'CAL'
const CAL_PAD = 4

async function generateSafeCalendarId() {
  let counterNum = null

  // Step 1 — database counter
  try {
    const { data: counter, error } = await supabase.rpc('get_next_id', { p_type: 'lab_calendar' })
    if (error) {
      console.warn('get_next_id(lab_calendar) RPC error, falling back:', error.message)
    } else if (counter) {
      const n = parseInt(String(counter).replace(/\D/g, ''), 10)
      if (!isNaN(n)) counterNum = n
    }
  } catch (e) {
    console.warn('get_next_id(lab_calendar) threw, falling back:', e?.message || e)
  }

  // Step 2 — MAX-scan of clean CAL#### IDs (cheap: the table is small)
  let scanMax = 0
  try {
    const { data: rows } = await supabase
      .from('lab_calendar')
      .select('calendar_id')
      .like('calendar_id', `${CAL_PREFIX}%`)
      .order('calendar_id', { ascending: false })
      .limit(200)
    ;(rows || []).forEach(r => {
      const m = new RegExp(`^${CAL_PREFIX}(\\d{1,8})$`).exec(r.calendar_id || '')
      if (m) {
        const n = parseInt(m[1], 10)
        if (n > scanMax) scanMax = n
      }
    })
  } catch (e) {
    console.warn('lab_calendar MAX-scan failed (non-critical):', e?.message || e)
  }

  let numericId = Math.max(counterNum ?? 0, scanMax + 1, 1)
  const format = n => `${CAL_PREFIX}${String(n).padStart(CAL_PAD, '0')}`
  let calendarId = format(numericId)

  // Step 3 — collision check
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await supabase
      .from('lab_calendar')
      .select('calendar_id')
      .eq('calendar_id', calendarId)
      .maybeSingle()

    if (!exists) {
      // Step 4 — keep the counter aligned with reality (no-op if row missing)
      if (counterNum === null || numericId > counterNum) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: localToUtcIso(new Date()) })
            .eq('counter_name', 'lab_calendar')
        } catch (e) {
          console.warn('lab_calendar counter sync failed (non-critical):', e?.message || e)
        }
      }
      return calendarId
    }

    console.warn(`Calendar ID collision for ${calendarId}, retrying (${attempt + 1}/${MAX_RETRIES})`)
    numericId += 1
    calendarId = format(numericId)
  }

  // Pathological fallback — still unique, still CAL-prefixed
  return `${CAL_PREFIX}${numericId}-${Date.now().toString().slice(-4)}`
}

// ─── Collision-safe signup IDs (batch-aware) ────────────────────────────────
/**
 * Reserve `count` consecutive lab_signup IDs (SU######) without the MAX+1
 * race that let two students submitting at the same moment collide.
 *
 *  1. Atomically reserve a block via the `reserve_next_ids` RPC
 *     (p_type = 'lab_signup'). The RPC bumps the counter by `count` in one
 *     UPDATE, so concurrent callers get non-overlapping blocks.
 *  2. Always also MAX-scan existing SU###### IDs — if the counter is behind
 *     reality (or the RPC/migration isn't deployed yet), start past the max.
 *  3. Verify the whole candidate block is free in one query; shift past any
 *     collision and retry (bounded).
 *  4. If we had to go beyond the reserved block, write the final number back
 *     to `counters` so drift self-heals.
 *
 * Exported so other call sites that insert lab_signup rows (e.g. the
 * approve-lab-change flow in NotificationBell.jsx) can share it.
 */
const SU_PREFIX = 'SU'
const SU_PAD = 6

export async function generateSafeSignupIds(count) {
  const n = Math.max(1, parseInt(count, 10) || 1)
  const format = num => `${SU_PREFIX}${String(num).padStart(SU_PAD, '0')}`

  // Step 1 — atomic block reservation
  let start = null
  let reservedEnd = null
  try {
    const { data, error } = await supabase.rpc('reserve_next_ids', {
      p_type: 'lab_signup',
      p_count: n,
    })
    if (error) {
      console.warn('reserve_next_ids(lab_signup) RPC error, falling back:', error.message)
    } else if (data != null) {
      const endNum = parseInt(String(data).replace(/[^0-9]/g, ''), 10)
      if (!isNaN(endNum) && endNum >= n) {
        reservedEnd = endNum
        start = endNum - n + 1
      }
    }
  } catch (e) {
    console.warn('reserve_next_ids(lab_signup) threw, falling back:', e?.message || e)
  }

  // Step 2 — MAX-scan safety net (counter behind reality, or RPC missing)
  let scanMax = 0
  try {
    const { data: idRows } = await supabase
      .from('lab_signup')
      .select('signup_id')
      .like('signup_id', `${SU_PREFIX}%`)
      .order('signup_id', { ascending: false })
      .limit(50)
    const rx = new RegExp(`^${SU_PREFIX}([0-9]{1,10})$`)
    ;(idRows || []).forEach(r => {
      const m = rx.exec(r.signup_id || '')
      if (m) {
        const num = parseInt(m[1], 10)
        if (num > scanMax) scanMax = num
      }
    })
  } catch (e) {
    console.warn('lab_signup MAX-scan failed (non-critical):', e?.message || e)
  }
  if (start === null || scanMax >= start) start = scanMax + 1

  // Step 3 — verify the whole block is free (single query per attempt)
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ids = Array.from({ length: n }, (_, i) => format(start + i))
    let taken = []
    try {
      const { data: existing } = await supabase
        .from('lab_signup')
        .select('signup_id')
        .in('signup_id', ids)
      taken = existing || []
    } catch (e) {
      console.warn('Signup ID collision check failed, assuming free:', e?.message || e)
    }

    if (taken.length === 0) {
      // Step 4 — keep the counter aligned if we drifted past the reservation
      const endNum = start + n - 1
      if (reservedEnd === null || endNum > reservedEnd) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: endNum, updated_at: localToUtcIso(new Date()) })
            .eq('counter_name', 'lab_signup')
        } catch (e) {
          console.warn('lab_signup counter sync failed (non-critical):', e?.message || e)
        }
      }
      return ids
    }

    // Shift past the highest colliding ID and retry
    let maxHit = start
    const rx = new RegExp(`^${SU_PREFIX}([0-9]{1,10})$`)
    taken.forEach(r => {
      const m = rx.exec(r.signup_id || '')
      if (m) {
        const num = parseInt(m[1], 10)
        if (num > maxHit) maxHit = num
      }
    })
    console.warn(`Signup ID collision at ${format(start)}…, shifting past ${format(maxHit)} (${attempt + 1}/${MAX_RETRIES})`)
    start = maxHit + 1
  }

  // Pathological fallback — timestamp-suffixed, still SU-prefixed and unique
  const stamp = Date.now().toString().slice(-4)
  return Array.from({ length: n }, (_, i) => `${format(start + i)}-${stamp}`)
}

// ─── Lab Calendar (Instructor) ──────────────────────────────────────────────

export function useLabCalendar(year, month) {
  const [entries, setEntries] = useState({})
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    const startDate = new Date(year, month, 1)
    const endDate = new Date(year, month + 1, 0, 23, 59, 59)

    const { data, error } = await supabase
      .from('lab_calendar')
      .select('*')
      .gte('date', startDate.toISOString())
      .lte('date', endDate.toISOString())

    if (error) {
      console.error('Error loading lab calendar:', error)
      setLoading(false)
      return
    }

    const map = {}
    ;(data || []).forEach(row => {
      let key
      if (typeof row.date === 'string' && row.date.length === 10) {
        key = row.date
      } else {
        const dateStr = (row.date || '').substring(0, 10)
        key = dateStr || formatDateKey(new Date(row.date))
      }
      map[key] = {
        calendarId: row.calendar_id,
        date: key,
        startHour: getHourFromTime(row.start_time) ?? 8,
        endHour: getHourFromTime(row.end_time) ?? 16,
        maxStudents: row.max_students || 24,
        status: row.status || 'Open',
        lunchHour: row.lunch_hour != null ? parseInt(row.lunch_hour) : null,
        notes: row.notes || '',
        closedBlocks: normalizeClosedBlocks(row.closed_blocks),
      }
    })
    setEntries(map)
    hasLoadedRef.current = true
    setLoading(false)
  }, [year, month])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_calendar changes
  useEffect(() => {
    const channel = supabase
      .channel('lab-calendar-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { entries, loading, refresh: fetch }
}

// ─── Save/Delete Calendar Day ───────────────────────────────────────────────

export function useLabCalendarActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const saveDay = async (dayData) => {
    setSaving(true)
    try {
      const dateStr = dayData.date
      const dateLabel = formatDateLabel(dateStr)

      // Pull the full row (not just the id) so we can diff for the audit log.
      const existing = mustData(await supabase
        .from('lab_calendar')
        .select('*')
        .eq('date', dateStr + 'T12:00:00')
        .maybeSingle(), 'lab_calendar')

      // Shared column payload for update + insert
      const payload = {
        start_time: dayData.startTime,
        end_time: dayData.endTime,
        max_students: dayData.maxStudents || 24,
        status: dayData.status || 'Open',
        lunch_hour: dayData.lunchHour || null,
        notes: dayData.notes || '',
        closed_blocks: normalizeClosedBlocks(dayData.closedBlocks),
      }

      if (existing) {
        const changes = diffLabDay(existing, payload)

        const { data: updated, error } = await supabase
          .from('lab_calendar')
          .update(payload)
          .eq('calendar_id', existing.calendar_id)
          .select('calendar_id')
        if (error) throw error
        if (!updated || updated.length === 0) {
          throw new Error('Update was blocked — no rows changed (check permissions)')
        }

        if (changes.length > 0) {
          await writeAudit(profile, {
            action: 'Update Lab Day',
            entity_type: 'Lab Calendar',
            entity_id: existing.calendar_id,
            field_changed: changes.map(c => c.label).join(', '),
            old_value: changes.map(c => `${c.label}: ${c.before}`).join('\n'),
            new_value: changes.map(c => `${c.label}: ${c.after}`).join('\n'),
            details: `Updated lab day ${dateLabel}: ${changes.map(c => `${c.label} ${c.before} → ${c.after}`).join('; ')}`,
          })
          toast.success('Day updated')
        } else {
          toast('No changes to save')
        }
      } else {
        const newId = await generateSafeCalendarId()

        const insertRow = {
          calendar_id: newId,
          date: dateStr + 'T12:00:00',
          ...payload,
          created_by: profile?.email,
          created_at: localToUtcIso(new Date()),
        }

        const { data: inserted, error } = await supabase
          .from('lab_calendar')
          .insert(insertRow)
          .select('calendar_id')
        if (error) throw error
        if (!inserted || inserted.length === 0) {
          throw new Error('Insert was blocked — no rows created (check permissions)')
        }

        await writeAudit(profile, {
          action: 'Create Lab Day',
          entity_type: 'Lab Calendar',
          entity_id: newId,
          new_value: describeLabDay(insertRow),
          details: `Added lab day ${dateLabel} (${describeLabDay(insertRow)})`,
        })
        toast.success('Day added')
      }
    } catch (err) {
      toast.error('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteDay = async (dateStr) => {
    setSaving(true)
    try {
      // Snapshot first so the audit row records what was removed.
      const existing = mustData(await supabase
        .from('lab_calendar')
        .select('*')
        .eq('date', dateStr + 'T12:00:00')
        .maybeSingle(), 'lab_calendar')

      const { data: deleted, error } = await supabase
        .from('lab_calendar')
        .delete()
        .eq('date', dateStr + 'T12:00:00')
        .select('calendar_id')
      if (error) throw error
      if (existing && (!deleted || deleted.length === 0)) {
        throw new Error('Delete was blocked — no rows removed (check permissions)')
      }

      if (existing) {
        await writeAudit(profile, {
          action: 'Delete Lab Day',
          entity_type: 'Lab Calendar',
          entity_id: existing.calendar_id,
          old_value: describeLabDay(existing),
          details: `Removed lab day ${formatDateLabel(dateStr)} (${describeLabDay(existing)})`,
        })
      }
      toast.success('Day removed')
    } catch (err) {
      toast.error('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  /**
   * Find existing (non-cancelled) signups for `dateStr` whose time slot overlaps
   * any of the given closure blocks. Returns an array of affected signup rows
   * shaped for display in the conflict-warning modal.
   *
   * Pure read — does NOT modify any data.
   */
  const findConflictingSignups = async (dateStr, closedBlocks) => {
    const blocks = normalizeClosedBlocks(closedBlocks)
    if (blocks.length === 0) return []
    try {
      const targetDate = new Date(dateStr + 'T12:00:00')
      const { data, error } = await supabase
        .from('lab_signup')
        .select('signup_id, user_name, user_email, class_id, start_time, end_time, status, date')
        .eq('date', targetDate.toISOString())
        .neq('status', 'Cancelled')
      if (error) throw error

      return (data || [])
        .map(row => {
          const sMin = timeToMinutes(row.start_time)
          // end_time may be missing for older rows; fall back to start + 60 min
          const eMin = timeToMinutes(row.end_time) ?? (sMin != null ? sMin + 60 : null)
          if (sMin == null || eMin == null) return null
          const reason = findOverlappingClosure(sMin, eMin, blocks)
          if (!reason) return null
          return {
            signupId:  row.signup_id,
            userName:  row.user_name || '',
            userEmail: row.user_email || '',
            classId:   row.class_id || '',
            startTime: row.start_time,
            endTime:   row.end_time,
            status:    row.status || '',
            startMin:  sMin,
            endMin:    eMin,
            reason,
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.startMin - b.startMin || a.userName.localeCompare(b.userName))
    } catch (err) {
      console.error('findConflictingSignups error:', err)
      toast.error('Could not check for conflicts: ' + err.message)
      return []
    }
  }

  /**
   * Cancel a list of signups (by signup_id) with status='Cancelled' and a
   * rejection_reason note. Optionally fires the send-closure-notification
   * Edge Function to email each affected student.
   *
   * Returns { cancelled, emailed, emailFailed, errors }
   */
  const cancelSignupsForClosure = async ({
    dateStr,
    blockReason,
    affectedSignups,
    sendEmail,
  }) => {
    if (!Array.isArray(affectedSignups) || affectedSignups.length === 0) {
      return { cancelled: 0, emailed: 0, emailFailed: 0, errors: [] }
    }
    setSaving(true)
    try {
      const ids = affectedSignups.map(s => s.signupId).filter(Boolean)
      const { data: cancelledRows, error: updateErr } = await supabase
        .from('lab_signup')
        .update({ status: 'Cancelled' })
        .in('signup_id', ids)
        .select('signup_id')
      if (updateErr) throw updateErr
      if (!cancelledRows || cancelledRows.length === 0) {
        throw new Error('Cancellation was blocked — no signups changed (check permissions)')
      }
      const cancelledIds = new Set(cancelledRows.map(r => r.signup_id))

      let emailed = 0
      let emailFailed = 0
      const errors = []
      const failedEmails = new Set()   // per-student email failures, for the audit rows
      let emailFnDown = false          // whole Edge Function call failed

      if (sendEmail) {
        try {
          const { data: fnData, error: fnErr } = await supabase.functions.invoke(
            'send-closure-notification',
            {
              body: {
                date:    dateStr,
                reason:  blockReason || 'Lab closed',
                signups: affectedSignups.map(s => ({
                  email:     s.userEmail,
                  name:      s.userName,
                  startTime: s.startTime,
                  endTime:   s.endTime,
                  classId:   s.classId,
                })),
              },
            }
          )
          if (fnErr) {
            // Edge function fully failed (network, deployment, auth, etc.)
            emailFailed = ids.length
            emailFnDown = true
            errors.push(fnErr.message || String(fnErr))
          } else if (fnData) {
            emailed     = fnData.sent || 0
            emailFailed = fnData.failed || 0
            if (Array.isArray(fnData.errors)) {
              fnData.errors.forEach(e => {
                errors.push(`${e.email}: ${e.error}`)
                if (e.email) failedEmails.add(String(e.email).toLowerCase())
              })
            }
          }
        } catch (err) {
          emailFailed = ids.length
          emailFnDown = true
          errors.push(err.message || String(err))
        }
      }

      // Audit — one row per cancelled signup so each student's record has a trail
      const dateLabel = formatDateLabel(dateStr)
      const reasonText = blockReason || 'Lab closed'
      await writeAudit(profile, affectedSignups
        .filter(s => cancelledIds.has(s.signupId))
        .map(s => {
          let emailNote = ''
          if (sendEmail) {
            const failed = emailFnDown || failedEmails.has(String(s.userEmail || '').toLowerCase())
            emailNote = failed ? '; email notification failed' : '; email notification sent'
          }
          return {
            action: 'Cancel Signup (Closure)',
            entity_type: 'Lab Signup',
            entity_id: s.signupId,
            field_changed: 'status',
            old_value: s.status || 'Confirmed',
            new_value: 'Cancelled',
            details: `Cancelled ${s.userName || s.userEmail} (${s.userEmail}) ${dateLabel} ${formatTimeLabel(s.startTime)}–${formatTimeLabel(s.endTime)}${s.classId ? ` (${s.classId})` : ''} — lab closed: ${reasonText}${emailNote}`,
          }
        }))

      return { cancelled: cancelledRows.length, emailed, emailFailed, errors }
    } catch (err) {
      toast.error('Error cancelling signups: ' + err.message)
      return { cancelled: 0, emailed: 0, emailFailed: 0, errors: [err.message || String(err)] }
    } finally {
      setSaving(false)
    }
  }

  return { saveDay, deleteDay, findConflictingSignups, cancelSignupsForClosure, saving }
}

// ─── Lab Signup Data (Combined Load) ────────────────────────────────────────

export function useLabSignupData(weekStart, weeksToDisplay = 4, visibleDays = [1, 2, 3, 4]) {
  const { profile } = useAuth()
  // makeup: { [weekStartKey]: { [courseId]: { hours, requests, windowDays } } }
  //   — approved-absence make-up hours that add to a class's required hours
  //     for that week (see useMakeupHours.js). Students / Work Study only.
  const [data, setData] = useState({ weeks: [], hours: [], slots: {}, classes: [], makeup: {} })
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!weekStart || !profile) return
    setLoading(true)

    try {
      const firstWeek = new Date(weekStart)
      firstWeek.setHours(0, 0, 0, 0)
      const overallEnd = new Date(firstWeek)
      overallEnd.setDate(overallEnd.getDate() + (weeksToDisplay * 7) - 1)
      overallEnd.setHours(23, 59, 59, 999)

      // 1. Get user's classes and progress (students/work-study only)
      let classes = []
      const userClasses = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean)

      if (userClasses.length > 0 && profile.role !== 'Instructor') {
        // Lead window: include classes starting up to SIGNUP_LEAD_DAYS from
        // now so students can sign up before the semester begins. Cutoff is
        // built from LOCAL date parts (project convention for date-only
        // strings) — toISOString() is real UTC and rolls a day ahead in the
        // evening.
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() + SIGNUP_LEAD_DAYS)
        const cutoffStr = formatDateKey(cutoff)
        const classData = mustData(await supabase
          .from('classes')
          .select('class_id, course_id, course_name, required_hours')
          .in('course_id', userClasses)
          .eq('status', 'Active')
          .or(`start_date.is.null,start_date.lte.${cutoffStr}`), 'classes')

        classes = (classData || []).map(c => ({
          classId: c.class_id,
          courseId: c.course_id,
          courseName: c.course_name || '',
          requiredHours: c.required_hours || 0,
        }))
      }

      // 2. Get calendar entries
      // These reads are required. A failed read used to render as an empty
      // grid / "no signups" for the student; mustData throws so the catch
      // below reports it and the previous grid stays on screen.
      const calData = mustData(await supabase
        .from('lab_calendar')
        .select('*')
        .gte('date', firstWeek.toISOString())
        .lte('date', overallEnd.toISOString()), 'lab_calendar')

      const calByDate = {}
      const allHoursSet = new Set()
      ;(calData || []).forEach(row => {
        const key = typeof row.date === 'string' && row.date.length >= 10 ? row.date.substring(0, 10) : formatDateKey(new Date(row.date))
        const startH = getHourFromTime(row.start_time) ?? 8
        const endH = getHourFromTime(row.end_time) ?? 16
        const lunchH = row.lunch_hour != null ? parseInt(row.lunch_hour) : null
        calByDate[key] = {
          startHour: startH,
          endHour: endH,
          maxStudents: row.max_students || 24,
          status: row.status || 'Open',
          notes: row.notes || '',
          lunchHour: isNaN(lunchH) ? null : lunchH,
          isOpen: row.status === 'Open',
          closedBlocks: normalizeClosedBlocks(row.closed_blocks),
        }
        if (row.status === 'Open') {
          for (let h = startH; h < endH; h++) allHoursSet.add(h)
        }
      })

      let allHours = Array.from(allHoursSet).sort((a, b) => a - b)
      if (allHours.length === 0) allHours = [8, 9, 10, 11, 12, 13, 14, 15]

      // 3. Get signups
      const signupData = mustData(await supabase
        .from('lab_signup')
        .select('signup_id, user_email, class_id, date, start_time, is_makeup, makeup_request_id')
        .neq('status', 'Cancelled')
        .gte('date', firstWeek.toISOString())
        .lte('date', overallEnd.toISOString()), 'lab_signup')

      // 3b. Make-up hours overlay (approved absences → next week's requirement)
      let makeupOverlay = { byKey: {}, requests: [] }
      if (classes.length > 0) {
        makeupOverlay = await fetchMakeupOverlay({
          emails: [profile.email],
          rangeStart: formatDateKey(firstWeek),
          rangeEnd: formatDateKey(overallEnd),
        })
      }

      const signupsByKey = {}
      ;(signupData || []).forEach(row => {
        const dk = typeof row.date === 'string' && row.date.length >= 10 ? row.date.substring(0, 10) : formatDateKey(new Date(row.date))
        const hr = getHourFromTime(row.start_time)
        if (hr === null) return
        const key = `${dk}_${hr}`
        if (!signupsByKey[key]) signupsByKey[key] = []
        signupsByKey[key].push({
          signupId: row.signup_id,
          userEmail: row.user_email,
          classId: row.class_id || '',
          isMakeup: !!row.is_makeup,
          makeupRequestId: row.makeup_request_id || '',
        })
      })

      // 4. Build weeks
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const weeks = []
      const slots = {}
      const makeup = {}

      for (let w = 0; w < weeksToDisplay; w++) {
        const ws = new Date(firstWeek)
        ws.setDate(ws.getDate() + (w * 7))
        const we = new Date(ws)
        we.setDate(we.getDate() + 6)

        const weekDeadlinePassed = profile.role !== 'Instructor' ? isDeadlinePassed(ws) : false
        const weekTitle = `${monthNames[ws.getMonth()]} ${ws.getDate()} - ${monthNames[we.getMonth()]} ${we.getDate()}`

        const days = []
        for (let d = 0; d < 7; d++) {
          if (!visibleDays.includes(d)) continue
          const dt = new Date(ws)
          dt.setDate(dt.getDate() + d)
          const dateKey = formatDateKey(dt)
          const config = calByDate[dateKey]

          days.push({
            date: dateKey,
            dayName: dayNames[dt.getDay()],
            dayShort: dayNames[dt.getDay()].substring(0, 3),
            dayNum: dt.getDate(),
            month: dt.getMonth() + 1,
            dayOfWeek: dt.getDay(),
            isOpen: config ? config.isOpen : false,
            isClosed: config ? !config.isOpen : false,
            startHour: config ? config.startHour : 8,
            endHour: config ? config.endHour : 16,
            maxStudents: config ? config.maxStudents : 24,
            lunchHour: config?.lunchHour ?? null,
            notes: config ? config.notes : '',
            hasEntry: !!config,
            closedBlocks: config?.closedBlocks || [],
          })

          // Build slots
          allHours.forEach(hour => {
            const key = `${dateKey}_${hour}`
            const signups = signupsByKey[key] || []
            const day = days[days.length - 1]
            const isLunch = day.lunchHour !== null && hour === day.lunchHour

            let mySignupId = ''
            let myClassId = ''
            let myIsMakeup = false
            let myMakeupRequestId = ''
            signups.forEach(s => {
              if (s.userEmail === profile.email) {
                mySignupId = s.signupId
                myClassId = s.classId || ''
                myIsMakeup = !!s.isMakeup
                myMakeupRequestId = s.makeupRequestId || ''
              }
            })

            // Hour-level closure check (e.g. 2-3pm offsite meeting)
            const closureReason = day.isOpen
              ? findClosureForHour(hour, day.closedBlocks)
              : null
            const withinDayHours = hour >= day.startHour && hour < day.endHour
            const isHourClosed = !!closureReason

            slots[key] = {
              date: dateKey,
              hour,
              maxStudents: day.maxStudents,
              currentSignups: signups.length,
              availableSpots: Math.max(0, day.maxStudents - signups.length),
              isFull: signups.length >= day.maxStudents,
              // isOpen now also requires that the hour is NOT inside a closure
              isOpen: day.isOpen && withinDayHours && !isHourClosed,
              isLunch,
              isHourClosed,
              closureReason: closureReason || '',
              mySignupId,
              myClassId,
              myIsMakeup,
              myMakeupRequestId,
              deadlinePassed: weekDeadlinePassed,
            }
          })
        }

        const weekStartKey = formatDateKey(ws)

        // Make-up hours for this week, per class. Lab-signup weeks start on
        // Sunday; the overlay is keyed by Monday, so look up the Monday of
        // this week. Make-up slots must land on the first two OPEN lab days.
        const mondayKey = mondayKeyOf(formatDateKey(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 1)))
        const weekMakeup = {}
        for (const cls of classes) {
          const info = getMakeupInfo(makeupOverlay, profile.email, mondayKey, cls.courseId)
            || getMakeupInfo(makeupOverlay, profile.email, mondayKey, cls.classId)
          if (info) {
            weekMakeup[cls.courseId] = {
              hours: info.hours,
              requests: info.requests,
              windowDays: firstTwoLabDays(days, visibleDays),
            }
          }
        }
        if (Object.keys(weekMakeup).length > 0) makeup[weekStartKey] = weekMakeup

        weeks.push({
          weekIndex: w,
          weekStart: weekStartKey,
          weekTitle,
          days,
          deadlinePassed: weekDeadlinePassed,
        })
      }

      setData({ weeks, hours: allHours, slots, classes, makeup })
    } catch (err) {
      console.error('Error loading lab signup data:', err)
      toast.error('Failed to load lab data')
    } finally {
      setLoading(false)
    }
  }, [weekStart, weeksToDisplay, visibleDays, profile])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_signup or lab_calendar changes
  useEffect(() => {
    if (!weekStart || !profile) return
    const channel = supabase
      .channel('lab-signup-data-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [weekStart, profile, fetch])

  return { ...data, loading, refresh: fetch }
}

// ─── Signup Actions (multi-class aware) ─────────────────────────────────────

export function useLabSignupActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  /**
   * signUpBatchMultiClass - takes a map of { classId: [slotKey, ...] }
   * and inserts all signups in one batch.
   *
   * @param {Object} [makeupTags]  { [slotKey]: absenceRequestId } — slots that
   *   satisfy an approved absence make-up are saved with is_makeup = true and
   *   makeup_request_id so Time Cards / the absence record can trace them.
   */
  const signUpBatchMultiClass = async (selectionsByClass, makeupTags = {}) => {
    setSaving(true)
    try {
      // Pass 1 — figure out which selected slots actually need a row
      // (skip ones the student already holds), WITHOUT assigning IDs yet.
      const pending = []
      for (const [classId, selections] of Object.entries(selectionsByClass)) {
        for (const sel of selections) {
          const [dateStr, hourStr] = sel.split('_')
          const hour = parseInt(hourStr)
          const targetDate = new Date(dateStr + 'T12:00:00')

          // Check if already exists
          const existing = mustData(await supabase
            .from('lab_signup')
            .select('signup_id')
            .eq('user_id', profile.id || profile.user_id)
            .eq('date', targetDate.toISOString())
            .eq('start_time', `${String(hour).padStart(2, '0')}:00:00`)
            .neq('status', 'Cancelled')
            .maybeSingle(), 'lab_signup duplicate check')

          if (existing) continue
          pending.push({ sel, classId, dateStr, hour, targetDate })
        }
      }

      // Pass 2 — reserve exactly the IDs we need in one atomic block, so two
      // students submitting at the same moment can't collide.
      const rows = []
      const auditMeta = []   // parallel to rows: { dateStr, hour } for audit details
      if (pending.length > 0) {
        const ids = await generateSafeSignupIds(pending.length)
        const userName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`

        pending.forEach((p, i) => {
          rows.push({
            signup_id: ids[i],
            user_id: null,
            user_name: userName,
            user_email: profile.email,
            class_id: p.classId || '',
            date: p.targetDate.toISOString(),
            start_time: `${String(p.hour).padStart(2, '0')}:00:00`,
            end_time: `${String(p.hour + 1).padStart(2, '0')}:00:00`,
            status: 'Confirmed',
            created_at: localToUtcIso(new Date()),
            is_makeup: !!makeupTags[p.sel],
            makeup_request_id: makeupTags[p.sel] || null,
          })
          auditMeta.push({ dateStr: p.dateStr, hour: p.hour })
        })
      }

      if (rows.length > 0) {
        const { data: inserted, error } = await supabase
          .from('lab_signup')
          .insert(rows)
          .select('signup_id')
        if (error) throw error
        if (!inserted || inserted.length === 0) {
          throw new Error('Signup was blocked — no rows created (check permissions)')
        }

        if (AUDIT_STUDENT_SIGNUPS) {
          await writeAudit(profile, rows.map((r, i) => ({
            action: 'Sign Up',
            entity_type: 'Lab Signup',
            entity_id: r.signup_id,
            details: `Signed up for ${formatDateLabel(auditMeta[i].dateStr)} ${formatHour(auditMeta[i].hour)}${r.class_id ? ` (${r.class_id})` : ''}${r.is_makeup ? ` — make-up for ${r.makeup_request_id}` : ''}`,
          })))
        }

        const muCount = rows.filter(r => r.is_makeup).length
        toast.success(`Signed up for ${rows.length} slot(s)${muCount > 0 ? ` (${muCount} make-up)` : ''}`)
      }
      return { success: true, count: rows.length }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Legacy single-class batch for backward compat */
  const signUpBatch = async (selections, classId) => {
    return signUpBatchMultiClass({ [classId]: selections })
  }

  const cancelSignup = async (signupId) => {
    setSaving(true)
    try {
      const { data: updated, error } = await supabase
        .from('lab_signup')
        .update({ status: 'Cancelled' })
        .eq('signup_id', signupId)
        .select('signup_id, date, start_time, end_time, class_id, is_makeup')
      if (error) throw error
      if (!updated || updated.length === 0) {
        throw new Error('Cancellation was blocked — no rows changed (check permissions)')
      }

      if (AUDIT_STUDENT_SIGNUPS) {
        const r = updated[0]
        await writeAudit(profile, {
          action: 'Cancel Signup',
          entity_type: 'Lab Signup',
          entity_id: signupId,
          field_changed: 'status',
          new_value: 'Cancelled',
          details: `Cancelled signup for ${formatDateLabelFromIso(r.date)} ${formatTimeLabel(r.start_time)}–${formatTimeLabel(r.end_time)}${r.class_id ? ` (${r.class_id})` : ''}${r.is_makeup ? ' — make-up slot' : ''}`,
        })
      }

      toast.success('Signup cancelled')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /**
   * submitPostDeadlineRequest - creates a lab_signup_requests record
   * for instructor approval when changes are made after Sunday deadline
   *
   * @param {string} courseId - course ID for the class
   * @param {string} weekStart - week start date string (YYYY-MM-DD)
   * @param {string[]} currentSlots - existing confirmed slot keys for this week+class
   * @param {string[]} requestedSlots - newly desired slot keys for this week+class
   * @param {string} reason - student's reason for the change
   */
  const submitPostDeadlineRequest = async (courseId, weekStart, currentSlots, requestedSlots, reason) => {
    setSaving(true)
    try {
      // Use timestamp-based ID to avoid collisions when submitting multiple classes
      const requestId = 'LSR' + Date.now()

      const userName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`

      // NOTE: intentionally no .select() here — students may not have a
      // SELECT policy on lab_signup_requests, and RETURNING would fail.
      const { error } = await supabase.from('lab_signup_requests').insert({
        request_id: requestId,
        user_id: null,
        user_name: userName,
        user_email: profile.email,
        class_id: courseId,
        course_id: courseId,
        week_start: weekStart,
        current_slots: JSON.stringify(currentSlots),
        requested_slots: JSON.stringify(requestedSlots),
        status: 'Pending',
        reason: reason || '',
        submitted_date: new Date().toISOString(),
      })

      if (error) throw error

      await writeAudit(profile, {
        action: 'Submit Lab Change',
        entity_type: 'Lab Signup Request',
        entity_id: requestId,
        old_value: `${(currentSlots || []).length} slot(s)`,
        new_value: `${(requestedSlots || []).length} slot(s)`,
        details: `Requested lab schedule change for week of ${formatDateLabel(weekStart)}${courseId ? ` (${courseId})` : ''}: ${(currentSlots || []).length} → ${(requestedSlots || []).length} slot(s).${reason ? ` Reason: ${reason}` : ''}`,
      })

      toast.success('Change request submitted for instructor approval')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return { signUpBatch, signUpBatchMultiClass, cancelSignup, submitPostDeadlineRequest, saving }
}

// ─── My Signups ─────────────────────────────────────────────────────────────

export function useMySignups() {
  const { profile } = useAuth()
  const [signups, setSignups] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const { data, error } = await supabase
      .from('lab_signup')
      .select('*')
      .eq('user_email', profile.email)
      .gte('date', today.toISOString())
      .neq('status', 'Cancelled')
      .order('date', { ascending: true })

    if (error) {
      console.error('Error loading signups:', error)
    } else {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      setSignups((data || []).map(s => {
        const parts = (s.date || '').substring(0, 10).split('-')
        const dt = parts.length === 3 ? new Date(+parts[0], +parts[1] - 1, +parts[2]) : new Date(s.date)
        return {
          signupId: s.signup_id,
          dateDisplay: `${dayNames[dt.getDay()]}, ${monthNames[dt.getMonth()]} ${dt.getDate()}`,
          startTime: formatHour(getHourFromTime(s.start_time) ?? 0),
          endTime: formatHour((getHourFromTime(s.end_time) ?? 1)),
          classId: s.class_id || '',
          status: s.status,
          canCancel: s.status !== 'Cancelled',
          isMakeup: !!s.is_makeup,
          makeupRequestId: s.makeup_request_id || '',
        }
      }))
    }
    setLoading(false)
  }, [profile])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_signup changes
  useEffect(() => {
    if (!profile) return
    const channel = supabase
      .channel('my-signups-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile, fetch])

  return { signups, loading, refresh: fetch }
}

// ─── Daily Roster (Instructor) ──────────────────────────────────────────────

export function useDailyRoster(dateStr) {
  const [signups, setSignups] = useState([])
  const [loading, setLoading] = useState(false)

  const fetch = useCallback(async () => {
    if (!dateStr) return
    setLoading(true)
    const targetDate = new Date(dateStr + 'T12:00:00')

    const { data, error } = await supabase
      .from('lab_signup')
      .select('*')
      .eq('date', targetDate.toISOString())
      .neq('status', 'Cancelled')
      .order('start_time', { ascending: true })

    if (error) console.error('Error loading roster:', error)
    setSignups(data || [])
    setLoading(false)
  }, [dateStr])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_signup changes
  useEffect(() => {
    if (!dateStr) return
    const channel = supabase
      .channel(`daily-roster-${dateStr}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [dateStr, fetch])

  return { signups, loading, refresh: fetch }
}

// ─── Students List (for Instructor Override) ────────────────────────────────

export function useStudentsList() {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email, classes, role, time_clock_only')
      .eq('status', 'Active')
      .neq('role', 'Instructor')
      .order('last_name')

    if (error) console.error('Error loading students:', error)
    setStudents((data || []).filter(s => s.time_clock_only !== 'Yes').map(s => ({
      userId: s.id,
      firstName: s.first_name || '',
      lastName: s.last_name || '',
      email: s.email,
      displayName: `${s.first_name} ${s.last_name} (${s.email})`,
      classes: s.classes || '',
    })))
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when profiles change (new students, class assignments)
  useEffect(() => {
    const channel = supabase
      .channel('lab-students-list-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { students, loading }
}

// ─── Instructor Signup Override ──────────────────────────────────────────────

export function useInstructorSignup() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const signUpStudent = async (student, dateStr, hour, classId) => {
    setSaving(true)
    try {
      const targetDate = new Date(dateStr + 'T12:00:00')
      const hourNum = parseInt(hour)

      const existing = mustData(await supabase
        .from('lab_signup')
        .select('signup_id')
        .eq('user_id', student.userId)
        .eq('date', targetDate.toISOString())
        .eq('start_time', `${String(hourNum).padStart(2, '0')}:00:00`)
        .neq('status', 'Cancelled')
        .maybeSingle(), 'lab_signup duplicate check')

      if (existing) {
        toast.error('Student already signed up for this slot')
        return { success: false }
      }

      const userName = `${student.firstName} ${(student.lastName || '').charAt(0)}.`
      const [signupId] = await generateSafeSignupIds(1)
      const { data: inserted, error } = await supabase.from('lab_signup').insert({
        signup_id: signupId,
        user_id: null,
        user_name: userName,
        user_email: student.email,
        class_id: classId || '',
        date: targetDate.toISOString(),
        start_time: `${String(hourNum).padStart(2, '0')}:00:00`,
        end_time: `${String(hourNum + 1).padStart(2, '0')}:00:00`,
        status: 'Confirmed',
        created_at: localToUtcIso(new Date()),
      }).select('signup_id')

      if (error) throw error
      if (!inserted || inserted.length === 0) {
        throw new Error('Signup was blocked — no rows created (check permissions)')
      }

      await writeAudit(profile, {
        action: 'Instructor Sign Up',
        entity_type: 'Lab Signup',
        entity_id: signupId,
        details: `Signed up ${userName} (${student.email}) for ${formatDateLabel(dateStr)} ${formatHour(hourNum)}${classId ? ` (${classId})` : ''} — instructor override`,
      })

      toast.success(`Signed up ${userName} (Instructor Override)`)
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return { signUpStudent, saving }
}
