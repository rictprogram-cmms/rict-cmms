/**
 * RICT CMMS — Absence Request hooks
 *
 * Backing logic for the Absence Request page (Program Policy Section 4.1–4.3).
 * Students (or instructors on their behalf) submit an absence with a
 * make-up plan; instructors approve (choosing the deduction outcome) or
 * reject, and can later check off "Make-up complete".
 *
 * Exports:
 *   useAbsenceRequests()        — list + realtime + submit/approve/reject/
 *                                 toggleMakeupComplete actions
 *   useAbsenceClasses(profile)  — active classes, optionally narrowed to the
 *                                 given profile's enrolled classes
 *                                 (dual-format course_id / class_id matching)
 *   useAbsenceStudentOptions()  — active non-instructor profiles for the
 *                                 instructor "submit on behalf" picker
 *
 * Conventions honored:
 *   - Fake-UTC timestamps via localToUtcIso() for absence_requests rows
 *   - announcements inserts use new Date().toISOString() (matches existing
 *     WO-assignment bell notification pattern exactly)
 *   - Safe ID generation mirroring generateSafeTcId (RPC → MAX fallback →
 *     collision retry → counter sync); prefix ABS, counter 'absence_request'
 *   - .select() on every insert/update with row-count validation
 *     (RLS failures return empty arrays, not errors)
 *   - Unique per-mount realtime channel name + removeChannel cleanup
 *   - Super admin email never shown in user-facing pickers
 *
 * File: src/hooks/useAbsenceRequests.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

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

/**
 * Monday of the week containing the given date-only string.
 * Parses with T00:00:00 (local midnight) per project convention to avoid
 * the UTC date-shift bug. Returns 'YYYY-MM-DD'.
 */
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
      const { data: rows } = await supabase
        .from('absence_requests')
        .select('request_id')
        .like('request_id', `${ABS_PREFIX}%`)
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
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
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

  // ── Initial load + realtime ─────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    fetchRequests()

    if (!enabled) return undefined

    const channel = supabase
      .channel(channelIdRef.current)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'absence_requests' },
        () => fetchRequests() // silent refresh — loading spinner only on first load
      )
      .subscribe()

    return () => {
      mountedRef.current = false
      supabase.removeChannel(channel)
    }
  }, [enabled, fetchRequests])

  // ── Submit (self, or instructor on behalf of a student) ────────────────────
  /**
   * @param {object} p
   * @param {object} p.student      { user_id, user_name, user_email } — the
   *                                student the absence belongs to. For a
   *                                self-submission, pass the user's own info.
   * @param {string} p.classId      class_id (CLSxxxx) — may be ''
   * @param {string} p.courseId     course_id (RICTxxxx) — may be ''
   * @param {string} p.absenceDate  'YYYY-MM-DD'
   * @param {number} p.hoursMissed
   * @param {string} p.reason
   * @param {string} p.makeupPlan
   */
  const submitRequest = useCallback(async ({ student, classId, courseId, absenceDate, hoursMissed, reason, makeupPlan }) => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!student?.user_email) return { success: false, message: 'Missing student.' }
    if (!absenceDate) return { success: false, message: 'Missing absence date.' }
    if (!reason?.trim()) return { success: false, message: 'A reason is required.' }
    if (!makeupPlan?.trim()) return { success: false, message: 'A make-up plan is required.' }
    if (!(Number(hoursMissed) > 0)) return { success: false, message: 'Hours missed is required (greater than 0).' }

    const weekStart = mondayOf(absenceDate)
    if (!weekStart) return { success: false, message: 'Invalid absence date.' }

    setSaving(true)
    try {
      const requestId = await generateSafeAbsenceId()
      const isOnBehalf = student.user_email.toLowerCase() !== profile.email.toLowerCase()

      const row = {
        request_id: requestId,
        user_id: student.user_id || null,
        user_name: student.user_name || student.user_email,
        user_email: student.user_email.toLowerCase(),
        class_id: classId || null,
        course_id: courseId || null,
        absence_date: absenceDate,
        week_start: weekStart,
        hours_missed: Number(hoursMissed) || 0,
        reason: reason.trim(),
        makeup_plan: makeupPlan.trim(),
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

      await writeAudit(
        profile,
        'ABSENCE_REQUEST_SUBMIT',
        row.request_id,
        null, null, null,
        isOnBehalf
          ? `Submitted on behalf of ${row.user_name} (${row.user_email}) for ${absenceDate} (${courseId || classId || 'no class'})`
          : `Submitted for ${absenceDate} (${courseId || classId || 'no class'})`
      )

      // If an instructor filed it on the student's behalf, let the student
      // know via the bell so the record is never a surprise.
      if (isOnBehalf) {
        await sendAbsenceBellNotification(
          profile,
          row.user_email,
          `Absence Request Filed: ${row.request_id}`,
          `An absence request for ${formatDateHuman(absenceDate)} was submitted on your behalf by ${senderNameFrom(profile)}. You can view it on the Absence Request page.`
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
   */
  const approveRequest = useCallback(async (request, deductionStatus, reviewNotes = '') => {
    if (!profile?.email) return { success: false, message: 'Not signed in.' }
    if (!request?.request_id) return { success: false, message: 'Missing request.' }
    if (!['20% Deduction', 'Waived'].includes(deductionStatus)) {
      return { success: false, message: 'A deduction decision is required to approve.' }
    }

    setSaving(true)
    try {
      const { data: updated, error: updErr } = await supabase
        .from('absence_requests')
        .update({
          status: 'Approved',
          deduction_status: deductionStatus,
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
        'ABSENCE_REQUEST_APPROVE',
        request.request_id,
        'status', 'Pending', 'Approved',
        `Deduction: ${deductionStatus}${reviewNotes ? ` — Notes: ${reviewNotes.trim()}` : ''}`
      )

      const deductionLine = deductionStatus === 'Waived'
        ? 'The 20% assignment deduction is WAIVED (institutional excused absence).'
        : 'The automatic 20% assignment deduction applies (maximum score 80%) per program policy Section 5.2.'
      // Make-up hours line: added to the following week's required lab hours
      // unless the class has already ended (then they simply can't be made up).
      const mkWeek = makeupWeekOf(request.week_start)
      const hrs = Number(request.hours_missed) || 0
      const pastEnd = makeupPastClassEnd(request.week_start, request.class_end_date)
      const makeupLine = hrs > 0 && mkWeek && !pastEnd
        ? ` ${hrs} make-up hour${hrs === 1 ? '' : 's'} for ${request.course_id || request.class_id || 'this class'} have been added to your required lab time for the week of ${formatDateHuman(mkWeek)} — sign up for them on the first two lab days of that week. They'll be marked complete automatically once you've logged the time.`
        : hrs > 0 && pastEnd
          ? ' This absence falls in the final week of the class, so the hours cannot be made up and were not added to a later week.'
          : ''
      await sendAbsenceBellNotification(
        profile,
        request.user_email,
        `Absence Request Approved: ${request.request_id}`,
        `Your absence request for ${formatDateHuman(request.absence_date)} was approved. ${deductionLine}${makeupLine} Your plan: "${request.makeup_plan}"`
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
        'ABSENCE_REQUEST_REJECT',
        request.request_id,
        'status', 'Pending', 'Rejected',
        `Reason: ${reason.trim()}`
      )

      await sendAbsenceBellNotification(
        profile,
        request.user_email,
        `Absence Request Rejected: ${request.request_id}`,
        `Your absence request for ${formatDateHuman(request.absence_date)} was rejected. Reason: ${reason.trim()}. Per program policy, unapproved absences are not eligible for the make-up window.`
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
        .eq('status', 'Approved') // only approved absences have a make-up to complete
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
        'ABSENCE_REQUEST_DELETE',
        request.request_id,
        null, null, null,
        `Deleted ${request.status} request for ${request.user_name} (${request.user_email}), absence ${request.absence_date}`
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
    submitRequest,
    approveRequest,
    rejectRequest,
    toggleMakeupComplete,
    deleteRequest,
  }
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
        const { data } = await supabase
          .from('classes')
          .select('class_id, course_id, course_name, status, end_date')
          .eq('status', 'Active')
          .order('course_id', { ascending: true })
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
        const { data } = await supabase
          .from('profiles')
          .select('user_id, email, first_name, last_name, role, status, classes, time_clock_only')
          .eq('status', 'Active')
          .order('last_name', { ascending: true })
        const list = (data || []).filter(p =>
          p.role !== 'Instructor' &&
          p.time_clock_only !== 'Yes' &&
          (p.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL
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
