import { useState, useEffect, useCallback, useRef, useId } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ════════════════════════════════════════════════════════════════════════════
// RICT CMMS — Student Holds data layer
// ════════════════════════════════════════════════════════════════════════════
//
// Three hooks + two constants:
//
//   useMyActiveHolds()   — student-facing. Returns the logged-in user's
//                          uncleared target rows with nested hold details.
//                          Used by the lockout / reminder / nudge overlays.
//
//   useAllHolds()        — instructor-facing. Returns every hold with nested
//                          targets for management in the Announcements tab.
//
//   useHoldActions()     — mutations (create, delete, clear, ack, view).
//                          Clearing routes through SECURITY DEFINER RPCs so
//                          audit logging and permission checks stay DB-side.
//
//   HOLD_TEMPLATES       — pre-filled title+message for common hold reasons.
//   SEVERITY_META        — label / description / color for each severity.
//
// NOTE ON CHANNEL NAMES
//   Each hook instance generates a unique channel suffix via useId() so
//   that multiple components calling the same hook (e.g. HoldLockoutModal
//   and HoldReminderModal both using useMyActiveHolds) don't collide on
//   the Supabase realtime channel. Colliding names return the same
//   channel object from supabase.channel(), which tears down for all
//   subscribers when any one unmounts.
// ════════════════════════════════════════════════════════════════════════════


// Sanitize useId output (e.g. ':r0:') to a safe channel-name fragment.
function cleanId(id) {
  return (id || '').replace(/[^a-zA-Z0-9]/g, '')
}


// ════════════════════════════════════════════════════════════════════════════
// useMyActiveHolds
// ────────────────────────────────────────────────────────────────────────────
// Returns the current user's UNCLEARED hold targets, joined to their master
// hold record, filtered to ACTIVE + unexpired holds, sorted by severity
// (hold → reminder → nudge).
//
// IMPORTANT: reads the EFFECTIVE `profile.email` — so when Super Admin
// emulates a student, the Super Admin's session DOES see that student's
// holds. This is deliberate: emulation is meant to show exactly what the
// student sees, including any lockouts / reminders / nudges.
//
// Escape hatch: the EmulationBar renders at z-index 9999 which is above
// the lockout modal (z-index 9000), so the "Stop Emulating" button stays
// reachable even during an emulated lockout.
// ════════════════════════════════════════════════════════════════════════════

export function useMyActiveHolds() {
  const { profile } = useAuth()
  const [holds, setHolds] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)
  const instanceId = cleanId(useId())

  const load = useCallback(async (silent = false) => {
    if (!profile?.email) {
      setHolds([])
      setLoading(false)
      return
    }
    if (!silent && !hasLoadedRef.current) setLoading(true)

    try {
      const email = profile.email.toLowerCase()

      // Pull uncleared target rows with their master hold via FK join.
      // RLS ensures the user can only see their own rows anyway; the
      // ilike is for case-insensitive match on stored user_email.
      const { data, error } = await supabase
        .from('student_hold_targets')
        .select(`
          target_id, hold_id, user_email, user_name,
          acknowledged_at, cleared_at, cleared_by_email, cleared_by_name,
          cleared_method, view_count, last_viewed_at,
          hold:student_holds!inner (
            hold_id, title, message, severity, template_type,
            created_by_email, created_by_name, created_at,
            expires_at, status
          )
        `)
        .ilike('user_email', email)
        .is('cleared_at', null)
        .eq('hold.status', 'active')

      if (error) throw error

      // Defensive expiry filter (cron may not have run yet on edge timing)
      const now = Date.now()
      const fresh = (data || []).filter(t => {
        if (!t.hold) return false
        if (!t.hold.expires_at) return true
        return new Date(t.hold.expires_at).getTime() > now
      })

      // Sort: hold > reminder > nudge, then oldest first within a tier
      const sevOrder = { hold: 0, reminder: 1, nudge: 2 }
      fresh.sort((a, b) => {
        const sa = sevOrder[a.hold?.severity] ?? 99
        const sb = sevOrder[b.hold?.severity] ?? 99
        if (sa !== sb) return sa - sb
        return new Date(a.hold?.created_at || 0) - new Date(b.hold?.created_at || 0)
      })

      setHolds(fresh)
      hasLoadedRef.current = true
    } catch (err) {
      // Silent fail — we don't want to toast a student every time a
      // transient network blip prevents a hold refresh.
      console.warn('[useMyActiveHolds] load error:', err?.message || err)
    } finally {
      setLoading(false)
    }
  }, [profile?.email])

  useEffect(() => { load() }, [load])

  // Realtime: react to target changes (new holds pushed to us, clears from
  // instructors) AND to master-hold status changes (expires, cleared sweep).
  useEffect(() => {
    if (!profile?.email) return
    const email = profile.email.toLowerCase()

    const channel = supabase
      .channel(`my-active-holds-${email}-${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'student_hold_targets',
          filter: `user_email=eq.${email}`,
        },
        () => { load(true) }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'student_holds' },
        () => { load(true) }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, load, instanceId])

  return { holds, loading, refresh: () => load(true) }
}


// ════════════════════════════════════════════════════════════════════════════
// useAllHolds
// ────────────────────────────────────────────────────────────────────────────
// Instructor view of every hold with its targets nested. Used by the Student
// Holds tab in Announcements. Defaults to active only; pass
// `{ includeClosed: true }` to see cleared / expired history.
// ════════════════════════════════════════════════════════════════════════════

export function useAllHolds(options = {}) {
  const { includeClosed = false } = options
  const [holds, setHolds] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)
  const instanceId = cleanId(useId())

  const load = useCallback(async (silent = false) => {
    if (!silent && !hasLoadedRef.current) setLoading(true)

    try {
      let q = supabase
        .from('student_holds')
        .select(`
          hold_id, title, message, severity, template_type,
          created_by_email, created_by_name, created_at,
          expires_at, status,
          targets:student_hold_targets (
            target_id, user_email, user_name,
            acknowledged_at, cleared_at, cleared_by_email, cleared_by_name,
            cleared_method, view_count, last_viewed_at
          )
        `)
        .order('created_at', { ascending: false })

      if (!includeClosed) q = q.eq('status', 'active')

      const { data, error } = await q
      if (error) throw error

      setHolds(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('[useAllHolds] load error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load student holds')
    } finally {
      setLoading(false)
    }
  }, [includeClosed])

  useEffect(() => { load() }, [load])

  // Realtime: any change to either table refreshes the list. Instructor-facing
  // so volume should be low. Channel name includes the filter flag and a
  // per-instance id so toggling includeClosed or mounting this hook multiple
  // times doesn't collide.
  useEffect(() => {
    const channel = supabase
      .channel(`all-holds-${includeClosed ? 'full' : 'active'}-${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'student_holds' },
        () => { load(true) }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'student_hold_targets' },
        () => { load(true) }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [load, includeClosed, instanceId])

  return { holds, loading, refresh: () => load(true) }
}


// ════════════════════════════════════════════════════════════════════════════
// useHoldActions
// ────────────────────────────────────────────────────────────────────────────
// All mutation paths in one hook. createHold / deleteHold go through direct
// table ops (gated by RLS); clearing goes through the DB-side RPCs so the
// badge-swipe flow and audit logging live server-side.
// ════════════════════════════════════════════════════════════════════════════

export function useHoldActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userDisplayName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  // ── createHold ─────────────────────────────────────────────────────────
  // Creates a new hold and bulk-inserts one target row per student.
  // If target inserts fail, the master row is rolled back so we don't
  // leave an orphan hold with no targets.
  //
  // Params:
  //   title         — short headline shown to the student
  //   message       — full body text
  //   severity      — 'nudge' | 'reminder' | 'hold'
  //   templateType  — 'advising' | 'volunteer_hours' | 'equipment' | 'custom' | null
  //   expiresAt     — YYYY-MM-DD string or ISO string or null
  //   targets       — [{ email, name }] — one entry per target student
  //
  // Returns the new hold_id on success, null on failure.
  // ──────────────────────────────────────────────────────────────────────
  const createHold = async ({
    title,
    message,
    severity,
    templateType = null,
    expiresAt = null,
    targets = [],
  }) => {
    // Validation
    if (!title?.trim()) { toast.error('Title is required'); return null }
    if (!message?.trim()) { toast.error('Message is required'); return null }
    if (!['nudge', 'reminder', 'hold'].includes(severity)) {
      toast.error('Invalid severity'); return null
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      toast.error('Select at least one student'); return null
    }

    setSaving(true)
    try {
      // 1. Next HOLD#### id from the atomic counter
      const { data: holdId, error: idErr } = await supabase.rpc('get_next_id', {
        p_type: 'student_holds',
      })
      if (idErr) throw idErr
      if (!holdId) throw new Error('Failed to generate hold id')

      // 2. Insert master row
      const { data: holdRows, error: holdErr } = await supabase
        .from('student_holds')
        .insert({
          hold_id: holdId,
          title: title.trim(),
          message: message.trim(),
          severity,
          template_type: templateType || null,
          created_by_email: profile.email,
          created_by_name: userDisplayName,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        })
        .select()

      if (holdErr) throw holdErr
      if (!holdRows || holdRows.length === 0) {
        throw new Error('Create failed — you do not have permission to create holds')
      }

      // 3. Bulk-insert target rows
      const targetRows = targets
        .filter(t => t?.email)
        .map(t => ({
          hold_id: holdId,
          user_email: t.email.toLowerCase(),
          user_name: (t.name || t.email).trim(),
        }))

      const { data: insertedTargets, error: tgtErr } = await supabase
        .from('student_hold_targets')
        .insert(targetRows)
        .select()

      if (tgtErr) {
        // Roll back the master row to avoid orphans
        try { await supabase.from('student_holds').delete().eq('hold_id', holdId) } catch {}
        throw tgtErr
      }
      if (!insertedTargets || insertedTargets.length !== targetRows.length) {
        try { await supabase.from('student_holds').delete().eq('hold_id', holdId) } catch {}
        throw new Error('Target rows were not fully inserted (RLS or duplicate?)')
      }

      // 4. Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userDisplayName,
          action: 'Create Hold',
          entity_type: 'Student Hold',
          entity_id: holdId,
          details: `${severity}: "${title.trim()}" → ${targetRows.length} student(s)`,
        })
      } catch {}

      const typeLabel =
        severity === 'hold' ? 'Lockout' :
        severity === 'reminder' ? 'Reminder' : 'Nudge'
      toast.success(
        `${typeLabel} created for ${targetRows.length} student${targetRows.length !== 1 ? 's' : ''}`
      )
      return holdId
    } catch (err) {
      console.error('[createHold]', err)
      toast.error(err.message || 'Failed to create hold')
      return null
    } finally {
      setSaving(false)
    }
  }

  // ── deleteHold ─────────────────────────────────────────────────────────
  // Deletes the master row; FK cascade removes all targets.
  // ──────────────────────────────────────────────────────────────────────
  const deleteHold = async (holdId, titleForDisplay) => {
    setSaving(true)
    try {
      const { data: delRows, error } = await supabase
        .from('student_holds')
        .delete()
        .eq('hold_id', holdId)
        .select()

      if (error) throw error
      if (!delRows || delRows.length === 0) {
        toast.error('Delete failed — you may not have permission')
        return false
      }

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userDisplayName,
          action: 'Delete Hold',
          entity_type: 'Student Hold',
          entity_id: holdId,
          details: `Deleted hold: ${titleForDisplay || holdId}`,
        })
      } catch {}

      toast.success('Hold deleted')
      return true
    } catch (err) {
      console.error('[deleteHold]', err)
      toast.error(err.message || 'Failed to delete hold')
      return false
    } finally {
      setSaving(false)
    }
  }

  // ── clearTargetRemote ─────────────────────────────────────────────────
  // Instructor remote clear of a single target. RPC handles auth + audit.
  // ──────────────────────────────────────────────────────────────────────
  const clearTargetRemote = async (targetId) => {
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('clear_hold_target', {
        p_target_id: targetId,
        p_method: 'remote',
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'Clear failed')
      toast.success('Hold cleared')
      return true
    } catch (err) {
      console.error('[clearTargetRemote]', err)
      toast.error(err.message || 'Failed to clear hold')
      return false
    } finally {
      setSaving(false)
    }
  }

  // ── forceClearTarget ──────────────────────────────────────────────────
  // Super Admin override. RPC enforces that only the super admin can
  // actually run this; any other caller gets a silent server-side denial.
  // ──────────────────────────────────────────────────────────────────────
  const forceClearTarget = async (targetId) => {
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('clear_hold_target', {
        p_target_id: targetId,
        p_method: 'super_admin_override',
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'Force clear failed')
      toast.success('Hold force-cleared')
      return true
    } catch (err) {
      console.error('[forceClearTarget]', err)
      toast.error(err.message || 'Failed to force-clear hold')
      return false
    } finally {
      setSaving(false)
    }
  }

  // ── clearTargetByBadge ────────────────────────────────────────────────
  // Called from the student's lockout modal when an instructor swipes
  // their badge. The RPC server-side verifies the card_id maps to an
  // active Instructor or Super Admin, clears the target, and logs to
  // audit_log. Failed swipes (unknown card, student card, archived
  // instructor) are also logged for visibility.
  //
  // Returns { success: bool, cleared_by?: string, error?: string }.
  // Does NOT toast — the modal provides its own visual feedback.
  // ──────────────────────────────────────────────────────────────────────
  const clearTargetByBadge = async (holdId, cardId) => {
    try {
      const { data, error } = await supabase.rpc('clear_hold_by_badge', {
        p_hold_id: holdId,
        p_card_id: cardId,
      })
      if (error) return { success: false, error: error.message }
      if (!data?.success) return { success: false, error: data?.error || 'Clear failed' }
      return { success: true, cleared_by: data.cleared_by }
    } catch (err) {
      console.error('[clearTargetByBadge]', err)
      return { success: false, error: err.message || 'Clear failed' }
    }
  }

  // ── acknowledgeTarget ─────────────────────────────────────────────────
  // Student-side ack. Only writes if acknowledged_at is still NULL, so
  // the very first ack timestamp is preserved (for telemetry — how long
  // did Steve stare at the modal before ticking the box?).
  //
  // Writes to audit_log with the authenticated user's email. If a Super
  // Admin is emulating and ticks the box, the audit log shows the super
  // admin's email — so the provenance is traceable even though the
  // target row's acknowledged_at is Steve's.
  // ──────────────────────────────────────────────────────────────────────
  const acknowledgeTarget = async (targetId) => {
    try {
      const { data: updated, error } = await supabase
        .from('student_hold_targets')
        .update({ acknowledged_at: new Date().toISOString() })
        .eq('target_id', targetId)
        .is('acknowledged_at', null)
        .select()
      if (error) {
        console.warn('[acknowledgeTarget]', error.message)
        return
      }
      // Only log if we actually flipped a row from unacked → acked
      if (updated && updated.length > 0 && profile?.email) {
        try {
          await supabase.from('audit_log').insert({
            user_email: profile.email,
            user_name: userDisplayName,
            action: 'Acknowledge Hold',
            entity_type: 'Student Hold',
            entity_id: updated[0].hold_id || targetId,
            details: `Acknowledged target for ${updated[0].user_email}`,
          })
        } catch {}
      }
    } catch (err) {
      console.warn('[acknowledgeTarget]', err)
    }
  }

  // ── recordView ────────────────────────────────────────────────────────
  // Best-effort view counter + last_viewed_at. Race conditions on the
  // increment are harmless (it's analytics, not accounting). Callers
  // should guard against double-fires with a ref in the component.
  // ──────────────────────────────────────────────────────────────────────
  const recordView = async (targetId) => {
    try {
      const { data: current } = await supabase
        .from('student_hold_targets')
        .select('view_count')
        .eq('target_id', targetId)
        .maybeSingle()

      await supabase
        .from('student_hold_targets')
        .update({
          view_count: (current?.view_count || 0) + 1,
          last_viewed_at: new Date().toISOString(),
        })
        .eq('target_id', targetId)
    } catch (err) {
      console.warn('[recordView]', err)
    }
  }

  return {
    saving,
    createHold,
    deleteHold,
    clearTargetRemote,
    forceClearTarget,
    clearTargetByBadge,
    acknowledgeTarget,
    recordView,
  }
}


// ════════════════════════════════════════════════════════════════════════════
// HOLD_TEMPLATES
// ────────────────────────────────────────────────────────────────────────────
// Pre-filled title + message for common hold reasons. Shown as quick-pick
// buttons on the CreateHoldForm; the instructor can edit freely before
// saving. Add more entries here to expand the library — no DB changes
// needed because template_type is a CHECK constraint that only restricts
// which values can be stored, not which templates exist in UI.
//
// When adding a new template type, also extend the CHECK constraint in
// the migration (or add an ALTER TABLE follow-up) to keep them in sync.
// ════════════════════════════════════════════════════════════════════════════

export const HOLD_TEMPLATES = [
  {
    id: 'advising',
    label: 'Advising Follow-up',
    title: 'Please meet with an instructor',
    message:
      'You have not yet met with an instructor for advising. ' +
      'Please see us during lab hours to schedule a time to talk. ' +
      'This hold will be cleared once we have met.',
  },
  {
    id: 'volunteer_hours',
    label: 'Volunteer Hours',
    title: 'Volunteer hours follow-up needed',
    message:
      'Your volunteer hours are currently below the required amount. ' +
      'Please see an instructor during lab hours to discuss a plan to ' +
      'get caught up.',
  },
  {
    id: 'equipment',
    label: 'Equipment Not Returned',
    title: 'Please return borrowed equipment',
    message:
      'Our records show you have borrowed equipment that has not yet ' +
      'been returned. Please return it during lab hours and let an ' +
      'instructor know so this hold can be cleared.',
  },
  {
    id: 'custom',
    label: 'Custom (blank)',
    title: '',
    message: '',
  },
]


// ════════════════════════════════════════════════════════════════════════════
// SEVERITY_META
// ────────────────────────────────────────────────────────────────────────────
// Presentation metadata shared across the three overlays and the instructor
// panel. Colors chosen for WCAG 2.1 AA contrast at standard text sizes.
// ════════════════════════════════════════════════════════════════════════════

export const SEVERITY_META = {
  nudge: {
    key: 'nudge',
    label: 'Nudge',
    description:
      'Dismissible banner at the top of every page. Does not block navigation.',
    color:       '#0369a1',  // sky-700
    bgColor:     '#e0f2fe',  // sky-100
    borderColor: '#7dd3fc',  // sky-300
  },
  reminder: {
    key: 'reminder',
    label: 'Reminder',
    description:
      'Blocking modal on login with a 30-second countdown before it can be dismissed.',
    color:       '#b45309',  // amber-700
    bgColor:     '#fef3c7',  // amber-100
    borderColor: '#fcd34d',  // amber-300
  },
  hold: {
    key: 'hold',
    label: 'Lockout',
    description:
      'Full-screen lockout. Cleared only by instructor badge swipe, remote clear, or auto-expiry.',
    color:       '#b91c1c',  // red-700
    bgColor:     '#fee2e2',  // red-100
    borderColor: '#fca5a5',  // red-300
  },
}
