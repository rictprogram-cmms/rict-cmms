import { useState, useEffect, useCallback, useRef } from 'react'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { supabase } from '@/lib/supabase'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── All Users ───────────────────────────────────────────────────────────────

export function useAllUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('last_name', { ascending: true })

      if (error) throw error
      setUsers(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Users fetch error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when profiles change
  useEffect(() => {
    return subscribeWithReconnect('all-users-changes', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetch() })
    , { tag: 'Users', onReconnect: fetch })
  }, [fetch])

  return { users, loading, refresh: fetch }
}

// ─── Archive reasons ─────────────────────────────────────────────────────────
// Why a user was archived. Stored in profile_archive_info (one row per archived
// user), NOT on profiles: every signed-in user can read profiles, and the
// reason is for instructors only. Row security on that table is staff-only, so
// for anyone else the read below simply comes back empty.
//
// The row itself is created / removed by a database trigger whenever
// profiles.status moves to or away from 'Archived' — the app only fills in
// `reason` and `note`. Values must match the CHECK constraint in
// supabase/migrations/20261005_user_archive_reason.sql.

export const ARCHIVE_REASONS = [
  { value: 'Graduated',        label: 'Graduated',          hint: 'Completed the program' },
  { value: 'Dropped/Withdrew', label: 'Dropped / Withdrew', hint: 'Left the program or stopped attending' },
  { value: 'Other',            label: 'Other',              hint: 'Anything else — add a note' },
]

/** Display label for a stored reason ('' / null → "No reason recorded"). */
export function archiveReasonLabel(reason) {
  const r = ARCHIVE_REASONS.find(x => x.value === reason)
  return r ? r.label : 'No reason recorded'
}

/** True when the reason + note pair is complete enough to save. */
export function archiveReasonValid(reason, note) {
  if (!reason) return false
  if (!ARCHIVE_REASONS.some(r => r.value === reason)) return false
  if (reason === 'Other' && !String(note || '').trim()) return false
  return true
}

/**
 * useArchiveInfo(enabled)
 * Map of profiles.id → { reason, note, archived_at, archived_by } for archived
 * users. Pass enabled=false for non-instructors (nothing is fetched).
 * `available` turns false when the table is missing (migration not run yet) so
 * pages can fall back to the old behaviour instead of showing errors.
 *
 * Also returns `historyByUserId`: profiles.id → past archives that ended in a
 * restore (newest first), from profile_archive_history. That table is written
 * only by the database trigger, so a restore never erases that a student had,
 * say, previously dropped. `historyAvailable` is false until its migration
 * (20261005_user_archive_history.sql) is live.
 */
export function useArchiveInfo(enabled = true) {
  const [byUserId, setByUserId] = useState({})
  // null = not known yet (first load still running). Only `true` unlocks the
  // reason fields, so a database without the migration never asks for a reason
  // it cannot save.
  const [available, setAvailable] = useState(null)
  const [historyByUserId, setHistoryByUserId] = useState({})
  const [historyAvailable, setHistoryAvailable] = useState(null)

  const loadHistory = useCallback(async () => {
    if (!enabled) { setHistoryByUserId({}); return }
    try {
      const rows = mustData(await supabase
        .from('profile_archive_history')
        .select('history_id, user_id, reason, note, archived_at, archived_by, restored_at, restored_by')
        .order('restored_at', { ascending: false }),
        'profile_archive_history.select') || []
      const map = {}
      rows.forEach(r => { (map[r.user_id] = map[r.user_id] || []).push(r) })
      setHistoryByUserId(map)
      setHistoryAvailable(true)
    } catch (err) {
      const code = err?.code || err?.cause?.code
      if (code === '42P01' || code === 'PGRST205') setHistoryAvailable(false)
      console.error('Archive history fetch error:', err)
    }
  }, [enabled])

  useEffect(() => { loadHistory() }, [loadHistory])

  useEffect(() => {
    if (!enabled || historyAvailable !== true) return undefined
    return subscribeWithReconnect('archive-history-changes', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profile_archive_history' }, () => { loadHistory() })
    , { tag: 'ArchiveHistory', onReconnect: loadHistory })
  }, [enabled, historyAvailable, loadHistory])

  const load = useCallback(async () => {
    if (!enabled) { setByUserId({}); return }
    try {
      const rows = mustData(await supabase
        .from('profile_archive_info')
        .select('user_id, reason, note, archived_at, archived_by, archived_by_email'),
        'profile_archive_info.select') || []
      const map = {}
      rows.forEach(r => { map[r.user_id] = r })
      setByUserId(map)
      setAvailable(true)
    } catch (err) {
      // Keep the last-known-good map on a network blip. A missing table
      // (42P01 / PGRST205) means the migration has not been run.
      const code = err?.code || err?.cause?.code
      if (code === '42P01' || code === 'PGRST205') setAvailable(false)
      console.error('Archive info fetch error:', err)
    }
  }, [enabled])

  useEffect(() => { load() }, [load])

  // Real-time: the trigger writes rows when a profile is archived / restored,
  // and another instructor may set a reason. Only once the table is known to
  // exist — never subscribe to a table that is not there. (profiles is not
  // listened to on purpose: its 5-minute heartbeat updates would refetch this
  // constantly, and the trigger's own write already raises an event here.)
  useEffect(() => {
    if (!enabled || available !== true) return undefined
    return subscribeWithReconnect('archive-info-changes', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profile_archive_info' }, () => { load() })
    , { tag: 'ArchiveInfo', onReconnect: load })
  }, [enabled, available, load])

  const refresh = useCallback(() => { load(); loadHistory() }, [load, loadHistory])

  return {
    byUserId, available: available === true, refresh,
    historyByUserId, historyAvailable: historyAvailable === true,
  }
}

// ─── User Actions ────────────────────────────────────────────────────────────

export function useUserActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  // options.quiet — skip the success toast (used when Edit User goes on to
  // archive the user, which shows its own confirmation).
  const updateUser = async (userId, updates, options = {}) => {
    setSaving(true)
    try {
      // Map friendly field names to column names
      const dbUpdates = {}
      if (updates.firstName !== undefined) dbUpdates.first_name = updates.firstName
      if (updates.lastName !== undefined) dbUpdates.last_name = updates.lastName
      if (updates.role !== undefined) dbUpdates.role = updates.role
      if (updates.status !== undefined) dbUpdates.status = updates.status
      if (updates.classes !== undefined) dbUpdates.classes = updates.classes
      if (updates.cardId !== undefined) dbUpdates.card_id = updates.cardId
      if (updates.timeClockOnly !== undefined) dbUpdates.time_clock_only = updates.timeClockOnly ? 'Yes' : ''
      // Instructor contact (printed on syllabi — entered once here)
      if (updates.phone !== undefined) dbUpdates.phone = updates.phone || null
      if (updates.office !== undefined) dbUpdates.office = updates.office || null
      if (updates.officeHours !== undefined) dbUpdates.office_hours = updates.officeHours || null

      const { data: rows, error } = await supabase
        .from('profiles')
        .update(dbUpdates)
        .eq('id', userId)
        .select()

      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Update failed — you may not have permission to edit users.')
        return
      }

      // Audit
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Update User',
          entity_type: 'User',
          entity_id: userId,
          details: `Updated: ${JSON.stringify(updates)}`
        })
      } catch {}

      if (!options.quiet) toast.success('User updated!')
    } catch (err) {
      toast.error(err.message || 'Failed to update user')
      throw err
    } finally {
      setSaving(false)
    }
  }

  const assignCardId = async (userId, cardId) => {
    setSaving(true)
    try {
      // Check if card already assigned
      if (cardId && cardId.trim()) {
        const existing = mustData(await supabase
          .from('profiles')
          .select('id, first_name, last_name')
          .eq('card_id', cardId)
          .neq('id', userId)
          .maybeSingle(), 'profiles.select')

        if (existing) {
          toast.error(`Card ID already assigned to ${existing.first_name} ${existing.last_name}`)
          return
        }
      }

      const { data: rows, error } = await supabase
        .from('profiles')
        .update({ card_id: cardId || '' })
        .eq('id', userId)
        .select()

      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Card ID update failed — you may not have permission.')
        return
      }
      toast.success(cardId ? 'Card ID assigned!' : 'Card ID removed')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // ─── Archive reason (instructors only) ────────────────────────────────────
  // Writes reason + note onto the row the database trigger created when the
  // user was archived. Upsert, so it also works if that row is somehow
  // missing. Returns true when saved.
  //
  // PRIVACY: the reason and note are deliberately NOT written to audit_log —
  // any signed-in user can read audit_log, and the reason is instructor-only.

  const writeArchiveReason = async (userId, reason, note) => {
    const cleanNote = String(note || '').trim()
    const { error } = assertWrite(
      await supabase
        .from('profile_archive_info')
        .upsert({ user_id: userId, reason: reason || null, note: cleanNote || null }, { onConflict: 'user_id' })
        .select(),
      'profile_archive_info.upsert'
    )
    if (error) throw error
  }

  // Set or change the reason for a user who is ALREADY archived.
  const setArchiveReason = async (userId, fullName, { reason, note, quiet = false } = {}) => {
    setSaving(true)
    try {
      await writeArchiveReason(userId, reason, note)
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Update Archive Reason',
          entity_type: 'User',
          entity_id: userId,
          details: `Updated the archive reason for ${fullName}`
        })
      } catch {}
      if (!quiet) toast.success(`Archive reason saved for ${fullName}`)
      return true
    } catch (err) {
      console.error('Archive reason save error:', err)
      toast.error('The archive reason could not be saved. Please try again.')
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Remove ONE past-archive entry (instructors only) — for an archive that was
  // a mistake, e.g. the wrong person was archived and then restored. Entries
  // cannot be added or edited from the app; the database trigger writes them.
  const removeArchiveHistory = async (historyId, userId, fullName) => {
    setSaving(true)
    try {
      const { error } = assertWrite(
        await supabase.from('profile_archive_history').delete().eq('history_id', historyId).select(),
        'profile_archive_history.delete'
      )
      if (error) throw error
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Remove Archive History',
          entity_type: 'User',
          entity_id: userId,
          details: `Removed a past archive entry for ${fullName}`
        })
      } catch {}
      toast.success('Entry removed')
      return true
    } catch (err) {
      console.error('Archive history remove error:', err)
      toast.error('The entry could not be removed. Please try again.')
      throw err
    } finally {
      setSaving(false)
    }
  }

  // ─── Archive User ──────────────────────────────────────────────────────────
  // Sets status to 'Archived' - removes from rotations but preserves all data.
  // details.reason / details.note (optional, instructors only) record WHY —
  // Graduated, Dropped/Withdrew or Other. Callers without a reason (a
  // non-instructor with the Users permission) archive exactly as before.

  const archiveUser = async (userId, fullName, email, details = {}) => {
    setSaving(true)
    try {
      const { data: archRows, error } = await supabase
        .from('profiles')
        .update({ status: 'Archived' })
        .eq('id', userId)
        .select()

      if (error) throw error
      if (!archRows || archRows.length === 0) {
        toast.error('Archive failed — you may not have permission.')
        return
      }

      // Remove from WO assignment rotation
      try {
        await supabase
          .from('assignment_rotation')
          .update({ status: 'Inactive' })
          .eq('user_email', email)
      } catch (rotErr) {
        console.warn('assignment_rotation deactivation failed (non-fatal):', rotErr.message)
      }

      // Reason (instructors only). The user is already archived at this point,
      // so a failure here must not look like the archive failed.
      let reasonFailed = false
      if (details.reason) {
        try {
          await writeArchiveReason(userId, details.reason, details.note)
        } catch (reasonErr) {
          reasonFailed = true
          console.error('Archive reason save error:', reasonErr)
        }
      }

      // Audit log (no reason / note here — see PRIVACY above)
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Archive User',
          entity_type: 'User',
          entity_id: userId,
          details: `Archived user: ${fullName} (${email})`
        })
      } catch {}

      if (reasonFailed) {
        toast.error(`${fullName} was archived, but the reason could not be saved. Add it from the Archived list.`, { duration: 8000 })
      } else {
        toast.success(`${fullName} archived`)
      }
    } catch (err) {
      toast.error(err.message || 'Failed to archive user')
      throw err
    } finally {
      setSaving(false)
    }
  }

  // ─── Permanently Delete User ──────────────────────────────────────────────
  // Removes profile row entirely. Time clock and work order history preserved
  // (those tables reference by email/name, not by foreign key to profiles).

  const permanentlyDeleteUser = async (userId, fullName, email) => {
    setSaving(true)
    try {
      // Call the database function that deletes from profiles, access_requests, AND auth.users
      const { data, error } = await supabase.rpc('delete_user_completely', {
        user_email: email
      })

      if (error) {
        // Fallback: if the RPC doesn't exist yet, do the old profile-only delete
        console.warn('RPC delete_user_completely failed, falling back to profile delete:', error.message)
        
        try { await supabase.from('announcements').delete().eq('recipient_email', email) } catch {}
        try { await supabase.from('access_requests').delete().eq('email', email) } catch {}
        
        const { error: delError } = assertWrite(
      await supabase
          .from('profiles')
          .delete()
          .eq('id', userId).select(),
      'profiles.delete'
    )
        if (delError) throw delError
      } else if (data && !data.success) {
        throw new Error(data.error || 'Delete failed')
      }

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Delete User',
          entity_type: 'User',
          entity_id: userId,
          details: `Permanently deleted user: ${fullName} (${email})`
        })
      } catch {}

      toast.success(`${fullName} permanently deleted`)
    } catch (err) {
      toast.error(err.message || 'Failed to delete user')
      throw err
    } finally {
      setSaving(false)
    }
  }

  // ─── Reset Student Password ───────────────────────────────────────────────
  // Sets a temporary password directly via Admin API through Edge Function.
  // Only allowed for Student and Work Study accounts (enforced server-side too).
  //
  // IMPORTANT: uses profiles.id (UUID = auth.users UUID), NOT profiles.user_id
  // (the legacy USR#### string). Never pass user_id to the edge function.
  //
  // The Edge Function also stamps user_metadata.must_reset_password = true,
  // which forces the student to set a new password on their next login before
  // they can access any other page.

  const resetStudentPassword = async (userId, fullName, tempPassword) => {
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error('Session expired — please sign in again.')
        return false
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/set-temp-password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ user_id: userId, temp_password: tempPassword }),
        }
      )

      const json = await res.json()

      if (!res.ok || json.error) {
        const msg = json.error || `HTTP ${res.status}`
        toast.error(`Password reset failed: ${msg}`)
        return false
      }

      toast.success(`Temporary password set for ${fullName}`)
      return true
    } catch (err) {
      toast.error(err.message || 'Failed to reset password')
      return false
    } finally {
      setSaving(false)
    }
  }

  return { saving, updateUser, assignCardId, archiveUser, setArchiveReason, removeArchiveHistory, permanentlyDeleteUser, resetStudentPassword }
}

// ─── Access Requests ─────────────────────────────────────────────────────────

export function useAccessRequests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('access_requests')
        .select('*')
        .eq('status', 'Pending')
        .order('request_date', { ascending: false })

      if (error) throw error
      setRequests(data || [])
    } catch (err) {
      console.error('Access requests error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when access_requests change
  useEffect(() => {
    return subscribeWithReconnect('access-requests-changes', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'access_requests' }, () => { fetch() })
    , { tag: 'Users', onReconnect: fetch })
  }, [fetch])

  return { requests, loading, refresh: fetch }
}

// ─── Message Templates ───────────────────────────────────────────────────────

export function useMessageTemplates() {
  const [templates, setTemplates] = useState([])

  const fetch = useCallback(async () => {
    try {
      const data = mustData(await supabase
        .from('message_templates')
        .select('*')
        .order('template_name'), 'message_templates.select')
      setTemplates(data || [])
    } catch {}
  }, [])

  useEffect(() => { fetch() }, [fetch])
  return { templates, refresh: fetch }
}
