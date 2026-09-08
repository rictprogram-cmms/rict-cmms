/**
 * RICT CMMS — Absence / Late Submission Request hooks
 *
 * Backing logic for the Absence & Late Submission Request page (Program
 * Policy Section 4.1–4.3 and 5.2). Two request types share one table:
 *
 *   'Absence'          — student missed lab time; hours_missed > 0 required
 *   'Late Submission'  — work was turned in late; assignment_name + due_date
 *                        required, hours_missed = ADDITIONAL LAB HOURS
 *                        REQUESTED (0 allowed)
 *
 * Students (or instructors on their behalf) submit with a plan; instructors
 * approve (choosing the deduction outcome AND a new due date/time for the
 * missed/late work) or reject, and can later check off "Make-up complete"
 * (lab hours) and "Work received" (the assignment). Work not received by
 * new_due_at scores 0 — that outcome is DERIVED here from the timestamps
 * (see workDueState), never stored.
 *
 * Approved requests with hours_missed > 0 add those hours to the FOLLOWING
 * week's requirement for the same course (useMakeupHours.js overlay +
 * trg_auto_makeup_complete) — identical for both types.
 *
 * Exports:
 *   useAbsenceRequests()          — list + realtime + submit/approve/reject/
 *                                   toggleMakeupComplete/toggleWorkReceived/
 *                                   deleteRequest/fetchDefaultDueAt
 *   useAbsenceRequestNotes()      — instructor-only follow-up notes
 *                                   (absence_request_notes, RLS-hidden from
 *                                   students) + add/delete
 *   useAbsenceClasses(profile)    — active classes, optionally narrowed to the
 *                                   given profile's enrolled classes
 *                                   (dual-format course_id / class_id matching)
 *   useAbsenceStudentOptions()    — active non-instructor profiles for the
 *                                   instructor "submit on behalf" picker
 *   REQUEST_TYPES, isLateSubmission, requestTypeLabel
 *   workDueState, fakeUtcToLocalDate, formatDueAt,
 *   toDatetimeLocalValue, datetimeLocalToFakeUtc, ordinal
 *   mondayOf, makeupWeekOf, makeupPastClassEnd
 *
 * Conventions honored:
 *   - Fake-UTC timestamps via localToUtcIso() for absence_requests rows;
 *     reads use getUTC*() (see fakeUtcToLocalDate)
 *   - announcements inserts use new Date().toISOString() (matches existing
 *     WO-assignment bell notification pattern exactly)
 *   - Safe ID generation mirroring generateSafeTcId (RPC → MAX fallback →
 *     collision retry → counter sync); prefix ABS, counter 'absence_request'
 *   - .select() on every insert/update with row-count validation
 *     (RLS failures return empty arrays, not errors)
 *   - Realtime via subscribeWithReconnect() (unique per-mount channel name)
 *   - Super admin email never shown in user-facing pickers
 *
 * File: src/hooks/useAbsenceRequests.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import { isSuperAdminEmail } from '@/lib/superAdmin'

// ─── Request types ────────────────────────────────────────────────────────────

export const REQUEST_TYPES = ['Absence', 'Late Submission']

export function isLateSubmission(requestOrType) {
  const t = typeof requestOrType === 'string' ? requestOrType : requestOrType?.request_type
  return t === 'Late Submission'
}

/** Short noun for messages: "absence" / "late submission". */
export function requestTypeLabel(requestOrType, { capitalize = false } = {}) {
  const s = isLateSubmission(requestOrType) ? 'late submission' : 'absence'
  return capitalize ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Per project rule: channel names must be unique per mounted component to
// prevent conflicts when multiple instances of a hook are alive at once.
function makeChannelSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// Fake-UTC convention: local wall-clock time stored with +00 offset.
function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}+00`
}

function pad(n, width) {
  return String(n).padStart(width, '0')
}

// ─── Fake-UTC read helpers ────────────────────────────────────────────────────

/**
 * Parse a fake-UTC timestamp ('…+00' / '…Z') into a LOCAL Date whose
 * wall-clock fields equal the stored ones. Uses getUTC*() per convention so
 * the browser's zone never shifts the value. Returns null when unparseable.
 */
export function fakeUtcToLocalDate(ts) {
  if (!ts) return null
  // Postgres returns '+00:00', but localToUtcIso()/datetimeLocalToFakeUtc()
  // emit a bare '+00'. new Date() rejects the bare form (NaN), so normalize.
  const normalized = typeof ts === 'string' ? ts.replace(/([+-]\d{2})$/, '$1:00') : ts
  const d = new Date(normalized)
  if (isNaN(d.getTime())) return null
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()
  )
}

/** "Tue, Sep 15, 2026, 4:00 PM" for a fake-UTC timestamp. */
export function formatDueAt(ts) {
  const d = fakeUtcToLocalDate(ts)
  if (!d) return ''
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

/** Fake-UTC timestamp → 'YYYY-MM-DDTHH:MM' for <input type="datetime-local">. */
export function toDatetimeLocalValue(ts) {
  const d = fakeUtcToLocalDate(ts)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`
}

/**
 * 'YYYY-MM-DDTHH:MM' (datetime-local) → fake-UTC 'YYYY-MM-DDTHH:MM:00+00:00'.
 * Uses the full '+00:00' offset so the value round-trips through new Date()
 * (a bare '+00' is NaN in every browser) before it is ever stored.
 */
export function datetimeLocalToFakeUtc(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null
  return `${value.substring(0, 16)}:00+00:00`
}

/**
 * Work due-date outcome for a request (derived, never stored):
 *   'none'      — not Approved, or legacy row with no new_due_at
 *   'received'  — instructor marked the work received
 *   'past_due'  — new_due_at has passed and work was not received → score 0
 *   'due'       — approved, due date in the future, awaiting work
 */
export function workDueState(request, now = new Date()) {
  if (!request || request.status !== 'Approved') return 'none'
  if (request.work_received) return 'received'
  const due = fakeUtcToLocalDate(request.new_due_at)
  if (!due) return 'none'
  return now.getTime() > due.getTime() ? 'past_due' : 'due'
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th" … */
export function ordinal(n) {
  const v = Number(n) || 0
  const mod100 = v % 100
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`
  switch (v % 10) {
    case 1: return `${v}st`
    case 2: return `${v}nd`
    case 3: return `${v}rd`
    default: return `${v}th`
  }
}

/**
 * Make-up week Monday = absence week_start + 7 days (Policy 4.3: hours are
 * made up during the first two lab days of the FOLLOWING week). Returns
 * 'YYYY-MM-DD' or null.
 */
export function makeupWeekOf(weekStartStr) {
  if (!weekStartStr) return null
  const d = new Date(weekStartStr + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() + 7)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * True when the make-up week falls AFTER the class end date — nothing can be
 * made up, so the missed hours are NOT added to any week (Policy #5).
 * `classEndDate` may be null/undefined (treated as "still eligible").
 */
export function makeupPastClassEnd(weekStartStr, classEndDate) {
  const mk = makeupWeekOf(weekStartStr)
  if (!mk || !classEndDate) return false
  return mk > String(classEndDate).substring(0, 10)
}

/**
 * Monday of the week containing the given date-only string.
 * Parses with T00:00:00 (local midnight) per project convention to avoid
 * the UTC date-shift bug. Returns 'YYYY-MM-DD'.
 */
export function mondayOf(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  const day = d.getDay() // 0 = Sunday … 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day // Sunday belongs to the prior Monday-start week
  d.setDate(d.getDate() + diff)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── Safe ID generation (mirrors generateSafeTcId) ────────────────────────────

const ABS_PREFIX = 'ABS'
const ABS_PAD = 6 // ABS######

async function generateSafeAbsenceId() {
  let absId = null
  let numericId = null
  let counterReturnedId = null

  // ── Step 1: Primary — database counter via RPC ─────────────────────────────
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'absence_request' })
    if (counter) {
      absId = counter
      numericId = parseInt(String(counter).replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch {
    console.log('get_next_id not available for absence_request, using fallback ID generation')
  }

  // ── Step 2: Fallback — derive from MAX(request_id), computed numerically ──
  if (!absId || !Number.isFinite(numericId)) {
    try {
      const rows = mustData(await supabase
        .from('absence_requests')
        .select('request_id')
        .like('request_id', `${ABS_PREFIX}%`), 'absence_requests.select')
      let maxNum = 0
      for (const r of rows || []) {
        const digits = String(r.request_id || '').replace(/\D/g, '')
        const n = digits ? parseInt(digits, 10) : 0
        if (Number.isFinite(n) && n > maxNum) maxNum = n
      }
      // Floor of 1000 keeps IDs at 4+ significant digits; +1 advances past max
      numericId = Math.max(maxNum, 1000) + 1
      absId = ABS_PREFIX + pad(numericId, ABS_PAD)
    } catch {
      // Last resort — timestamp-derived to guarantee uniqueness
      numericId = parseInt(Date.now().toString().slice(-6), 10) || 100000
      absId = ABS_PREFIX + pad(numericId, ABS_PAD)
    }
  }

  // ── Step 3: Collision check loop ───────────────────────────────────────────
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await supabase
      .from('absence_requests')
      .select('request_id')
      .eq('request_id', absId)
      .maybeSingle()

    if (!exists) {
      // ── Step 4: Counter sync if we bumped past the counter value ──────────
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'absence_request')
          console.log(`ABS counter synced: ${counterReturnedId} → ${numericId}`)
        } catch (e) {
          console.warn('ABS counter sync failed (non-critical):', e?.message || e)
        }
      }
      return absId
    }

    console.warn(`ABS ID collision detected for ${absId}, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`)
    numericId += 1
    absId = ABS_PREFIX + pad(numericId, ABS_PAD)
  }

  console.error('ABS ID collision persisted after retries, using timestamp suffix')
  return `${ABS_PREFIX}${pad(numericId, ABS_PAD)}-${Date.now().toString().slice(-4)}`
}

/** Note IDs: no counter row exists for notes; a UUID is collision-free. */
function generateNoteId() {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `ARN-${uuid}`
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function senderNameFrom(profile) {
  if (!profile) return 'Instructor'
  return `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() || 'Instructor'
}

function fullNameFrom(profile) {
  if (!profile) return ''
  return `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.email || ''
}

/**
 * Bell notification to the student via the announcements table.
 * Mirrors sendWOAssignmentNotification in WorkOrdersPage exactly.
 * Non-critical — failures are logged, never thrown.
 */
async function sendAbsenceBellNotification(profile, recipientEmail, subject, body) {
  if (!profile?.email || !recipientEmail) return
  // Don't notify yourself (e.g. instructor reviewing their own on-behalf entry
  // for themselves — defensive; shouldn't occur in normal flows)
  if (recipientEmail.toLowerCase() === profile.email.toLowerCase()) return
  try {
    await supabase.from('announcements').insert({
      recipient_email: recipientEmail.toLowerCase(),
      sender_email: profile.email,
      sender_name: senderNameFrom(profile),
      subject,
      body,
      read: false,
      notification_type: 'absence_review',
      created_at: new Date().toISOString(),
    })
  } catch (e) {
    console.warn('sendAbsenceBellNotification failed:', e.message)
  }
}

/** Audit log insert — matches the existing LOG + Date.now() pattern. */
async function writeAudit(profile, action, entityId, fieldChanged, oldValue, newValue, details) {
  try {
    await supabase.from('audit_log').insert({
      log_id: 'LOG' + Date.now(),
      timestamp: new Date().toISOString(),
      user_email: profile?.email || '',
      user_name: fullNameFrom(profile),
      action,
      entity_type: 'absence_request',
      entity_id: entityId,
      field_changed: fieldChanged || null,
      old_value: oldValue ?? null,
      new_value: newValue ?? null,
      details: details || null,
    })
  } catch {
    // Audit failures must never block the user action
  }
}

function formatDateHuman(dateStr) {
  if (!dateStr) return ''
  const d = new Date(String(dateStr).substring(0, 10) + 'T00:00:00')
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

/** Audit action prefix by type — keeps absence history greppable as before. */
function auditPrefix(requestOrType) {
  return isLateSubmission(requestOrType) ? 'LATE_SUBMISSION' : 'ABSENCE_REQUEST'
}

/** "absence request for Tue, Sep 8" / "late submission request for "Lab 4" (due Thu, Sep 3)". */
function describeRequest(request) {
  if (isLateSubmission(request)) {
    return `late submission request for "${request.assignment_name || 'assignment'}" (originally due ${formatDateHuman(request.due_date)})`
  }
  return `absence request for ${formatDateHuman(request.absence_date)}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useAbsenceRequests({ enabled = true } = {}) {
  const { profile } = useAuth()
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const hasLoadedRef = useRef(false)
  const mountedRef = useRef(true)
  const channelIdRef = useRef(`absence-requests-${makeChannelSuffix()}`)

  // ── Fetch (RLS scopes visibility: students see own rows, instructors all) ──
  const fetchRequests = useCallback(async () => {
    if (!enabled || !profile?.email) return
    if (!hasLoadedRef.current) setLoading(true)
    setError(null)
    try {
      const { data, error: fetchError } = await supabase
        .from('absence_requests')
        .select('*')
        .order('created_at', { ascending: false })
      if (fetchError) throw fetchError
      if (mountedRef.current) setRequests(data || [])
    } catch (e) {
      console.error('useAbsenceRequests fetch failed:', e.message)
      if (mountedRef.current) setError(e.message)
    } finally {
      hasLoadedRef.current = true
      if (mountedRef.current) setLoading(false)
    }
  }, [enabled, profile?.email])

  // ── Initial load + realtime (auto-reconnecting) ────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    fetchRequests()

    if (!enabled) return undefined

    const unsubscribe = subscribeWithReconnect(channelIdRef.current, ch => ch
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'absence_requests' },
        () => fetchRequests() // silent refresh — loading spinner only on first load
      )
    )

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [enabled, fetchRequests])

  // ── Default new due date/time for the Approve modal ────────────────────────
  /**
   * Second open lab day of the week following `weekStart`, at that day's lab
   * end time (default_work_due_at RPC). Returns a fake-UTC timestamp string
   * or null (instructor then fills it in by hand).
   */
  const fetchDefaultDueAt = useCallback(async (weekStart) => {
    if (!weekStart) return null
    try {
      const { data, error: rpcErr } = await supabase.rpc('default_work_due_at', { p_week_start: weekStart })
      if (rpcErr) throw rpcErr
      return data || null
    } catch (e) {
      console.warn('default_work_due_at failed:', e?.message || e)
      return null
    }
  }, [])

  // ── Submit (self, or instructor on behalf of a student) ────────────────────
  /**
   * @param {object} p
   * @param {object} p.student         { user_id, user_name, user_email } — the
   *                                   student the request belongs to. For a
   *                                   self-submission, pass the user's own info.
   * @param {string} [p.requestType]   'Absence' (default) | 'Late Submission'
   * @param {string} p.classId         class_id (CLSxxxx) — may be ''
   * @param {string} p.courseId        course_id (RICTxxxx) — may be ''
   * @param {string} p.absenceDate     'YYYY-MM-DD' — absence date, or for a
   *                                   late submission the date it was turned in
   * @param {number} p.hoursMissed     absence: hours missed (> 0 required);
   *                                   late: additional lab hours requested (≥ 0)
   * @param {string} p.reason          why absent / why late
   * @param {string} p.makeupPlan      the student's plan
   * @param {string} [p.assignmentName] late only — required
   * @param {string} [p.dueDate]       late only — 'YYYY-MM-DD', required
   */
  const submitRequest = useCallback(async ({
    student, requestType = 'Absence', classId, courseId, absenceDate, hoursMissed,
    reason, makeupPlan, assignmentName, dueDate,
  }) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!student?.user_email) return { success: false, message: 'Missing student.' }
    if (!REQUEST_TYPES.includes(requestType)) return { success: false, message: 'Invalid request type.' }
    const late = isLateSubmission(requestType)
    if (!absenceDate) return { success: false, message: late ? 'Missing date submitted.' : 'Missing absence date.' }
    if (!reason?.trim()) return { success: false, message: 'A reason is required.' }
    if (!makeupPlan?.trim()) return { success: false, message: 'A plan is required.' }
    const hrs = Number(hoursMissed) || 0
    if (late) {
      if (!assignmentName?.trim()) return { success: false, message: 'The assignment name is required.' }
      if (!dueDate) return { success: false, message: 'The original due date is required.' }
      if (hrs < 0) return { success: false, message: 'Lab hours cannot be negative.' }
    } else if (!(hrs > 0)) {
      return { success: false, message: 'Hours missed is required (greater than 0).' }
    }

    const weekStart = mondayOf(absenceDate)
    if (!weekStart) return { success: false, message: 'Invalid date.' }

    setSaving(true)
    try {
      const requestId = await generateSafeAbsenceId()
      const isOnBehalf = student.user_email.toLowerCase() !== profile.email.toLowerCase()

      const row = {
        request_id: requestId,
        request_type: requestType,
        user_id: student.user_id || null,
        user_name: student.user_name || student.user_email,
        user_email: student.user_email.toLowerCase(),
        class_id: classId || null,
        course_id: courseId || null,
        absence_date: absenceDate,
        week_start: weekStart,
        hours_missed: hrs,
        reason: reason.trim(),
        makeup_plan: makeupPlan.trim(),
        assignment_name: late ? assignmentName.trim() : null,
        due_date: late ? dueDate : null,
        status: 'Pending',
        submitted_by_email: profile.email.toLowerCase(),
        submitted_by_name: fullNameFrom(profile),
        created_at: localToUtcIso(new Date()),
      }

      const { data: inserted, error: insErr } = await supabase
        .from('absence_requests')
        .insert(row)
        .select()
      if (insErr) {
        // 23505 = unique violation — one retry with a fresh ID
        if (insErr.code === '23505') {
          row.request_id = await generateSafeAbsenceId()
          const { data: retryRows, error: retryErr } = await supabase
            .from('absence_requests')
            .insert(row)
            .select()
          if (retryErr) throw retryErr
          if (!retryRows || retryRows.length === 0) throw new Error('Insert blocked (no rows returned). Check permissions.')
        } else {
          throw insErr
        }
      } else if (!inserted || inserted.length === 0) {
        // RLS silent failure protection
        throw new Error('Insert blocked (no rows returned). Check permissions.')
      }

      const what = late
        ? `late submission of "${row.assignment_name}" (due ${dueDate}, submitted ${absenceDate}${hrs > 0 ? `, ${hrs} lab hr requested` : ''})`
        : `absence on ${absenceDate}`
      await writeAudit(
        profile,
        `${auditPrefix(requestType)}_SUBMIT`,
        row.request_id,
        null, null, null,
        isOnBehalf
          ? `Submitted on behalf of ${row.user_name} (${row.user_email}): ${what} (${courseId || classId || 'no class'})`
          : `Submitted: ${what} (${courseId || classId || 'no class'})`
      )

      // If an instructor filed it on the student's behalf, let the student
      // know via the bell so the record is never a surprise.
      if (isOnBehalf) {
        await sendAbsenceBellNotification(
          profile,
          row.user_email,
          `${requestTypeLabel(requestType, { capitalize: true })} Request Filed: ${row.request_id}`,
          late
            ? `A late submission request for "${row.assignment_name}" (originally due ${formatDateHuman(dueDate)}) was submitted on your behalf by ${senderNameFrom(profile)}. You can view it on the Absence / Late Request page.`
            : `An absence request for ${formatDateHuman(absenceDate)} was submitted on your behalf by ${senderNameFrom(profile)}. You can view it on the Absence / Late Request page.`
        )
      }

      fetchRequests() // direct refresh — don't depend on realtime for our own writes
      return { success: true, requestId: row.request_id }
    } catch (e) {
      console.error('submitRequest failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchRequests])

  // ── Approve (instructor; deduction decision required) ──────────────────────
  /**
   * @param {object} request          full request row
   * @param {string} deductionStatus  '20% Deduction' | 'Waived'
   * @param {string} [reviewNotes]
   * @param {string|null} [newDueAt]  fake-UTC timestamp for when the missed/
   *                                  late work is now due. null = no work was
   *                                  due (no zero rule applies).
   */
  const approveRequest = useCallback(async (request, deductionStatus, reviewNotes = '', newDueAt = null) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }
    if (!['20% Deduction', 'Waived'].includes(deductionStatus)) {
      return { success: false, message: 'A deduction decision is required to approve.' }
    }
    if (newDueAt && !fakeUtcToLocalDate(newDueAt)) {
      return { success: false, message: 'The new due date is invalid.' }
    }

    setSaving(true)
    try {
      const { data: updated, error: updErr } = await supabase
        .from('absence_requests')
        .update({
          status: 'Approved',
          deduction_status: deductionStatus,
          new_due_at: newDueAt || null,
          reviewed_by: fullNameFrom(profile),
          review_date: localToUtcIso(new Date()),
          review_notes: reviewNotes?.trim() || null,
          updated_at: localToUtcIso(new Date()),
          updated_by: fullNameFrom(profile),
        })
        .eq('request_id', request.request_id)
        .eq('status', 'Pending') // guard: never overwrite an already-reviewed row
        .select()
      if (updErr) throw updErr
      if (!updated || updated.length === 0) {
        throw new Error('Update blocked or request already reviewed. Refresh and try again.')
      }

      await writeAudit(
        profile,
        `${auditPrefix(request)}_APPROVE`,
        request.request_id,
        'status', 'Pending', 'Approved',
        `Deduction: ${deductionStatus}; Work due: ${newDueAt ? formatDueAt(newDueAt) : 'none'}${reviewNotes ? ` — Notes: ${reviewNotes.trim()}` : ''}`
      )

      const late = isLateSubmission(request)
      const deductionLine = deductionStatus === 'Waived'
        ? 'The 20% assignment deduction is WAIVED.'
        : 'The automatic 20% assignment deduction applies (maximum score 80%) per program policy Section 5.2.'
      const dueLine = newDueAt
        ? ` The ${late ? 'work' : 'missed work'} is now due by ${formatDueAt(newDueAt)}. Work not received by then is scored 0.`
        : ''
      // Make-up hours line: added to the following week's required lab hours
      // unless the class has already ended (then they simply can't be made up).
      const mkWeek = makeupWeekOf(request.week_start)
      const hrs = Number(request.hours_missed) || 0
      const pastEnd = makeupPastClassEnd(request.week_start, request.class_end_date)
      const makeupLine = hrs > 0 && mkWeek && !pastEnd
        ? ` ${hrs} ${late ? 'additional' : 'make-up'} lab hour${hrs === 1 ? '' : 's'} for ${request.course_id || request.class_id || 'this class'} ${hrs === 1 ? 'has' : 'have'} been added to your required lab time for the week of ${formatDateHuman(mkWeek)} — sign up for them on the first two lab days of that week. They'll be marked complete automatically once you've logged the time.`
        : hrs > 0 && pastEnd
          ? ` This ${requestTypeLabel(request)} falls in the final week of the class, so the lab hours cannot be made up and were not added to a later week.`
          : ''
      await sendAbsenceBellNotification(
        profile,
        request.user_email,
        `${requestTypeLabel(request, { capitalize: true })} Request Approved: ${request.request_id}`,
        `Your ${describeRequest(request)} was approved. ${deductionLine}${dueLine}${makeupLine} Your plan: "${request.makeup_plan}"`
      )

      fetchRequests() // direct refresh — don't depend on realtime for our own writes
      return { success: true }
    } catch (e) {
      console.error('approveRequest failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchRequests])

  // ── Reject (instructor; reason required — collected by RejectionModal) ─────
  const rejectRequest = useCallback(async (request, reason) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }
    if (!reason?.trim()) return { success: false, message: 'A rejection reason is required.' }

    setSaving(true)
    try {
      const { data: updated, error: updErr } = await supabase
        .from('absence_requests')
        .update({
          status: 'Rejected',
          rejection_reason: reason.trim(),
          reviewed_by: fullNameFrom(profile),
          review_date: localToUtcIso(new Date()),
          updated_at: localToUtcIso(new Date()),
          updated_by: fullNameFrom(profile),
        })
        .eq('request_id', request.request_id)
        .eq('status', 'Pending')
        .select()
      if (updErr) throw updErr
      if (!updated || updated.length === 0) {
        throw new Error('Update blocked or request already reviewed. Refresh and try again.')
      }

      await writeAudit(
        profile,
        `${auditPrefix(request)}_REJECT`,
        request.request_id,
        'status', 'Pending', 'Rejected',
        `Reason: ${reason.trim()}`
      )

      const tail = isLateSubmission(request)
        ? 'The original due date stands; contact your instructor with questions.'
        : 'Per program policy, unapproved absences are not eligible for the make-up window.'
      await sendAbsenceBellNotification(
        profile,
        request.user_email,
        `${requestTypeLabel(request, { capitalize: true })} Request Rejected: ${request.request_id}`,
        `Your ${describeRequest(request)} was rejected. Reason: ${reason.trim()}. ${tail}`
      )

      fetchRequests() // direct refresh — don't depend on realtime for our own writes
      return { success: true }
    } catch (e) {
      console.error('rejectRequest failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchRequests])

  // ── Make-up complete checkbox (instructor, approved rows only) ─────────────
  const toggleMakeupComplete = useCallback(async (request, value) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }

    setSaving(true)
    try {
      const { data: updated, error: updErr } = await supabase
        .from('absence_requests')
        .update({
          makeup_complete: !!value,
          makeup_complete_by: value ? fullNameFrom(profile) : null,
          makeup_complete_date: value ? localToUtcIso(new Date()) : null,
          updated_at: localToUtcIso(new Date()),
          updated_by: fullNameFrom(profile),
        })
        .eq('request_id', request.request_id)
        .eq('status', 'Approved') // only approved requests have a make-up to complete
        .select()
      if (updErr) throw updErr
      if (!updated || updated.length === 0) {
        throw new Error('Update blocked (request must be Approved). Refresh and try again.')
      }

      await writeAudit(
        profile,
        'ABSENCE_MAKEUP_COMPLETE',
        request.request_id,
        'makeup_complete',
        String(!!request.makeup_complete),
        String(!!value),
        null
      )

      fetchRequests() // direct refresh — don't depend on realtime for our own writes
      return { success: true }
    } catch (e) {
      console.error('toggleMakeupComplete failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchRequests])

  // ── Work received checkbox (instructor, approved rows only) ────────────────
  // Separate from make-up complete: this is the ASSIGNMENT, that is lab time.
  // Ticking it after new_due_at clears the derived "past due → 0" outcome
  // (instructor chose to accept the work).
  const toggleWorkReceived = useCallback(async (request, value) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }

    setSaving(true)
    try {
      const { data: updated, error: updErr } = await supabase
        .from('absence_requests')
        .update({
          work_received: !!value,
          work_received_by: value ? fullNameFrom(profile) : null,
          work_received_date: value ? localToUtcIso(new Date()) : null,
          updated_at: localToUtcIso(new Date()),
          updated_by: fullNameFrom(profile),
        })
        .eq('request_id', request.request_id)
        .eq('status', 'Approved')
        .select()
      if (updErr) throw updErr
      if (!updated || updated.length === 0) {
        throw new Error('Update blocked (request must be Approved). Refresh and try again.')
      }

      const wasPastDue = workDueState(request) === 'past_due'
      await writeAudit(
        profile,
        'ABSENCE_WORK_RECEIVED',
        request.request_id,
        'work_received',
        String(!!request.work_received),
        String(!!value),
        value && wasPastDue ? `Accepted after due date (${formatDueAt(request.new_due_at)})` : null
      )

      fetchRequests() // direct refresh — don't depend on realtime for our own writes
      return { success: true }
    } catch (e) {
      console.error('toggleWorkReceived failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchRequests])

  // ── Delete (super-admin cleanup, e.g. removing test requests) ──────────────
  // RLS limits deletes to instructor-role accounts; the page only exposes the
  // button to the super admin. Audit-logged like every other action.
  const deleteRequest = useCallback(async (request) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }

    setSaving(true)
    try {
      const { data: deleted, error: delErr } = await supabase
        .from('absence_requests')
        .delete()
        .eq('request_id', request.request_id)
        .select()
      if (delErr) throw delErr
      if (!deleted || deleted.length === 0) {
        throw new Error('Delete blocked (no rows returned). Check permissions.')
      }

      await writeAudit(
        profile,
        `${auditPrefix(request)}_DELETE`,
        request.request_id,
        null, null, null,
        `Deleted ${request.status} ${requestTypeLabel(request)} request for ${request.user_name} (${request.user_email}), date ${request.absence_date}`
      )

      fetchRequests() // direct refresh — don't depend on realtime for our own writes
      return { success: true }
    } catch (e) {
      console.error('deleteRequest failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchRequests])

  return {
    requests,
    loading,
    saving,
    error,
    refresh: fetchRequests,
    fetchDefaultDueAt,
    submitRequest,
    approveRequest,
    rejectRequest,
    toggleMakeupComplete,
    toggleWorkReceived,
    deleteRequest,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTRUCTOR FOLLOW-UP NOTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Instructor-only follow-up notes on requests (absence_request_notes). RLS
 * hides the table from students entirely, so pass `enabled: canReview` and
 * the hook stays idle for everyone else.
 *
 * Returns { notesByRequest: { [request_id]: note[] }, loading, saving,
 *           addNote(request, text), deleteNote(note) }
 */
export function useAbsenceRequestNotes({ enabled = false } = {}) {
  const { profile } = useAuth()
  const [notesByRequest, setNotesByRequest] = useState({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)
  const hasLoadedRef = useRef(false)
  const channelIdRef = useRef(`absence-request-notes-${makeChannelSuffix()}`)

  const fetchNotes = useCallback(async () => {
    if (!enabled || !profile?.email) return
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error: fetchError } = await supabase
        .from('absence_request_notes')
        .select('*')
        .order('created_at', { ascending: true })
      if (fetchError) throw fetchError
      const grouped = {}
      for (const n of data || []) {
        if (!grouped[n.request_id]) grouped[n.request_id] = []
        grouped[n.request_id].push(n)
      }
      if (mountedRef.current) setNotesByRequest(grouped)
    } catch (e) {
      console.warn('useAbsenceRequestNotes fetch failed:', e.message)
    } finally {
      hasLoadedRef.current = true
      if (mountedRef.current) setLoading(false)
    }
  }, [enabled, profile?.email])

  useEffect(() => {
    mountedRef.current = true
    if (!enabled) { setNotesByRequest({}); return undefined }
    fetchNotes()
    const unsubscribe = subscribeWithReconnect(channelIdRef.current, ch => ch
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'absence_request_notes' },
        () => fetchNotes()
      )
    )
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [enabled, fetchNotes])

  const addNote = useCallback(async (request, text) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }
    if (!text?.trim()) return { success: false, message: 'A note is required.' }
    setSaving(true)
    try {
      const row = {
        note_id: generateNoteId(),
        request_id: request.request_id,
        note: text.trim(),
        created_by: fullNameFrom(profile),
        created_by_email: profile.email.toLowerCase(),
        created_at: localToUtcIso(new Date()),
      }
      const { data: inserted, error: insErr } = await supabase
        .from('absence_request_notes')
        .insert(row)
        .select()
      if (insErr) throw insErr
      if (!inserted || inserted.length === 0) throw new Error('Insert blocked (no rows returned). Check permissions.')

      await writeAudit(profile, 'ABSENCE_NOTE_ADD', request.request_id, null, null, null, row.note)
      fetchNotes()
      return { success: true }
    } catch (e) {
      console.error('addNote failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchNotes])

  const deleteNote = useCallback(async (note) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!note?.note_id) return { success: false, message: 'Missing note.' }
    setSaving(true)
    try {
      const { data: deleted, error: delErr } = await supabase
        .from('absence_request_notes')
        .delete()
        .eq('note_id', note.note_id)
        .select()
      if (delErr) throw delErr
      if (!deleted || deleted.length === 0) throw new Error('Delete blocked (no rows returned). Check permissions.')

      await writeAudit(profile, 'ABSENCE_NOTE_DELETE', note.request_id, null, note.note, null, null)
      fetchNotes()
      return { success: true }
    } catch (e) {
      console.error('deleteNote failed:', e.message)
      return { success: false, message: e.message }
    } finally {
      setSaving(false)
    }
  }, [profile, fetchNotes])

  return { notesByRequest, loading, saving, addNote, deleteNote, refresh: fetchNotes }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORTING HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Active classes for the class dropdown.
 * If a profile is supplied, results are narrowed to that profile's enrolled
 * classes using dual-format matching (profiles.classes may hold course_id
 * and/or class_id values, comma-separated — pattern from useWeeklyLabs).
 * If the profile has no class list (or none match), the full active list is
 * returned so the form is never a dead end.
 */
export function useAbsenceClasses(profileForFilter = null) {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const data = mustData(await supabase
          .from('classes')
          .select('class_id, course_id, course_name, status, end_date')
          .eq('status', 'Active')
          .order('course_id', { ascending: true }), 'classes.select')
        let list = data || []

        if (profileForFilter?.classes) {
          const enrolled = String(profileForFilter.classes)
            .split(',')
            .map(c => c.trim())
            .filter(Boolean)
          if (enrolled.length > 0) {
            const narrowed = list.filter(c =>
              enrolled.includes(c.course_id) || enrolled.includes(c.class_id)
            )
            if (narrowed.length > 0) list = narrowed
          }
        }

        if (!cancelled) setClasses(list)
      } catch (e) {
        console.warn('useAbsenceClasses load failed:', e.message)
        if (!cancelled) setClasses([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [profileForFilter?.classes])

  return { classes, loading }
}

/**
 * Active, non-instructor profiles for the instructor "submit on behalf"
 * student picker. Excludes the super admin account and time-clock-only users.
 */
export function useAbsenceStudentOptions({ enabled = true } = {}) {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!enabled) { setStudents([]); setLoading(false); return undefined }
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const data = mustData(await supabase
          .from('profiles')
          .select('user_id, email, first_name, last_name, role, status, classes, time_clock_only')
          .eq('status', 'Active')
          .order('last_name', { ascending: true }), 'profiles.select')
        const list = (data || []).filter(p =>
          p.role !== 'Instructor' &&
          p.time_clock_only !== 'Yes' &&
          !isSuperAdminEmail(p.email)
        )
        if (!cancelled) setStudents(list)
      } catch (e) {
        console.warn('useAbsenceStudentOptions load failed:', e.message)
        if (!cancelled) setStudents([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [enabled])

  return { students, loading }
}

export default useAbsenceRequests
