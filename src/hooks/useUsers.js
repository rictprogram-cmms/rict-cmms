import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
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
    const channel = supabase
      .channel('all-users-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { users, loading, refresh: fetch }
}

// ─── User Actions ────────────────────────────────────────────────────────────

export function useUserActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const updateUser = async (userId, updates) => {
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

      toast.success('User updated!')
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
        const { data: existing } = await supabase
          .from('profiles')
          .select('id, first_name, last_name')
          .eq('card_id', cardId)
          .neq('id', userId)
          .maybeSingle()

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

  // ─── Archive User ──────────────────────────────────────────────────────────
  // Sets status to 'Archived' - removes from rotations but preserves all data

  const archiveUser = async (userId, fullName, email) => {
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

      // Audit log
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

      toast.success(`${fullName} archived`)
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
        
        const { error: delError } = await supabase
          .from('profiles')
          .delete()
          .eq('id', userId)
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

  return { saving, updateUser, assignCardId, archiveUser, permanentlyDeleteUser, resetStudentPassword }
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
    const channel = supabase
      .channel('access-requests-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'access_requests' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { requests, loading, refresh: fetch }
}

// ─── Message Templates ───────────────────────────────────────────────────────

export function useMessageTemplates() {
  const [templates, setTemplates] = useState([])

  const fetch = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('message_templates')
        .select('*')
        .order('template_name')
      setTemplates(data || [])
    } catch {}
  }, [])

  useEffect(() => { fetch() }, [fetch])
  return { templates, refresh: fetch }
}
