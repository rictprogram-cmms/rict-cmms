import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { usePermissions } from '@/hooks/usePermissions'

// ─── Super Admin Check ────────────────────────────────────────────────────────
const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

// ─── Auto-close delay (days) ─────────────────────────────────────────────────
const AUTO_CLOSE_DAYS = 15

// ─── Bug Requests Hook ────────────────────────────────────────────────────────

export function useBugRequests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('bug_tracker')
        .select('*')
        .order('submitted_date', { ascending: false })
      if (error) {
        console.error('Bug tracker query error:', error.message, error.details, error.hint)
        throw error
      }
      console.log('Bug tracker loaded:', (data || []).length, 'records')
      setRequests(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Bug tracker fetch error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load bug requests: ' + (err.message || 'Unknown error'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when bug_tracker changes
  useEffect(() => {
    const channel = supabase
      .channel('bug-tracker-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bug_tracker' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { requests, loading, refresh: fetch }
}

// ─── Bug Actions Hook (with permissions from DB) ─────────────────────────────

export function useBugActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''
  const userEmail = profile?.email || ''

  // Use the shared permissions hook — respects temp grants and emulation
  const { hasPerm, isSuperAdmin } = usePermissions('Bug Tracker')

  const createRequest = async (data) => {
    setSaving(true)
    try {
      // Generate next ID
      const { data: existing } = await supabase
        .from('bug_tracker')
        .select('request_id')
        .order('request_id', { ascending: false })
        .limit(1)

      let nextNum = 1001
      if (existing && existing.length > 0) {
        const lastId = existing[0].request_id || ''
        const num = parseInt(lastId.replace(/\D/g, ''))
        if (!isNaN(num)) nextNum = num + 1
      }
      const requestId = `ENF${nextNum}`

      const now = new Date().toISOString()
      const insertData = {
        request_id: requestId,
        type: data.type || 'Bug',
        title: data.title,
        description: data.description || '',
        priority: data.priority || 'Medium',
        status: isSuperAdmin ? 'Open' : 'Pending',
        submitted_by: userName,
        submitter_email: userEmail,
        submitted_date: now,
        resolution_notes: '',
        resolved_date: null,
        updated_at: now,
        updated_by: userName,
        laste_updated: new Date().toLocaleString()
      }

      const { error } = await supabase.from('bug_tracker').insert(insertData)
      if (error) throw error

      // Audit log
      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: now,
        user_email: userEmail,
        user_name: userName,
        action: 'Create',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: `Created ${data.type}: ${data.title}`
      })

      toast.success(isSuperAdmin ? 'Request created!' : 'Request submitted for approval!')
      return { success: true, requestId }
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const updateRequest = async (requestId, updates) => {
    setSaving(true)
    try {
      const now = new Date().toISOString()
      const updateData = {
        ...updates,
        updated_at: now,
        updated_by: userName,
        laste_updated: new Date().toLocaleString()
      }

      // If status changed to Completed, set resolved_date
      if (updates.status === 'Completed') {
        updateData.resolved_date = now
      }

      const { error } = await supabase
        .from('bug_tracker')
        .update(updateData)
        .eq('request_id', requestId)
      if (error) throw error

      // If status changed to Closed, add changelog entry and bump version
      if (updates.status === 'Closed') {
        await addChangelogEntry(requestId, updates.type, updates.title, userName)
      }

      // Audit log
      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: now,
        user_email: userEmail,
        user_name: userName,
        action: 'Update',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: `Updated request${updates.status ? ' - Status: ' + updates.status : ''}`
      })

      toast.success('Request updated!')
      return { success: true }
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const deleteRequest = async (requestId) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('bug_tracker')
        .delete()
        .eq('request_id', requestId)
      if (error) throw error

      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: new Date().toISOString(),
        user_email: userEmail,
        user_name: userName,
        action: 'Delete',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: `Deleted request ${requestId}`
      })

      toast.success('Request deleted')
      return { success: true }
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const approveRequest = async (requestId) => {
    setSaving(true)
    try {
      const now = new Date().toISOString()
      const { error } = await supabase
        .from('bug_tracker')
        .update({
          status: 'Open',
          updated_at: now,
          updated_by: userName,
          laste_updated: new Date().toLocaleString()
        })
        .eq('request_id', requestId)
      if (error) throw error

      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: now,
        user_email: userEmail,
        user_name: userName,
        action: 'Approve',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: `Approved request ${requestId}`
      })

      toast.success('Request approved!')
      return { success: true }
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const rejectRequest = async (requestId, reason = '') => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('bug_tracker')
        .delete()
        .eq('request_id', requestId)
      if (error) throw error

      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: new Date().toISOString(),
        user_email: userEmail,
        user_name: userName,
        action: 'Reject',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: `Rejected request: ${reason || 'No reason given'}`
      })

      toast.success('Request rejected and removed')
      return { success: true }
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return {
    saving, isSuperAdmin, hasPerm,
    createRequest, updateRequest, deleteRequest,
    approveRequest, rejectRequest
  }
}

// ─── Changelog Hook ───────────────────────────────────────────────────────────

export function useChangelog() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('changelog')
        .select('*')
        .order('version', { ascending: false })
      if (error) throw error
      // Deduplicate by version+request_id (migration may have created dupes)
      const seen = new Set()
      const deduped = (data || []).filter(e => {
        const key = `${e.version}|${e.request_id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setEntries(deduped)
    } catch (err) {
      console.error('Changelog fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when changelog changes
  useEffect(() => {
    const channel = supabase
      .channel('changelog-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'changelog' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { entries, loading, refresh: fetch }
}

// ─── Fetch Single Bug Request (for changelog detail lookups) ─────────────────

export function useBugRequestLookup() {
  const [lookupLoading, setLookupLoading] = useState(false)

  const lookupRequest = useCallback(async (requestId) => {
    if (!requestId) return null
    setLookupLoading(true)
    try {
      const { data, error } = await supabase
        .from('bug_tracker')
        .select('*')
        .eq('request_id', requestId)
        .maybeSingle()
      if (error) throw error
      return data
    } catch (err) {
      console.error('Bug request lookup error:', err)
      return null
    } finally {
      setLookupLoading(false)
    }
  }, [])

  return { lookupRequest, lookupLoading }
}

// ─── Auto-Close Hook ─────────────────────────────────────────────────────────
// Checks for Completed items older than AUTO_CLOSE_DAYS and auto-closes them,
// creating changelog entries and bumping the version for each.

export function useAutoClose() {
  const hasRun = useRef(false)
  const [processing, setProcessing] = useState(false)

  const runAutoClose = useCallback(async () => {
    // Only run once per page load
    if (hasRun.current) return { closed: 0 }
    hasRun.current = true
    setProcessing(true)

    try {
      // Fetch all Completed items
      const { data: completedItems, error } = await supabase
        .from('bug_tracker')
        .select('*')
        .eq('status', 'Completed')

      if (error) throw error
      if (!completedItems || completedItems.length === 0) {
        setProcessing(false)
        return { closed: 0 }
      }

      const now = new Date()
      const closedIds = []

      for (const item of completedItems) {
        // Use resolved_date to determine if 15 days have passed
        const resolvedDate = item.resolved_date ? new Date(item.resolved_date) : null
        if (!resolvedDate) continue

        const daysSinceResolved = Math.floor((now - resolvedDate) / (1000 * 60 * 60 * 24))
        if (daysSinceResolved < AUTO_CLOSE_DAYS) continue

        // Auto-close this item
        const closeTime = new Date().toISOString()
        const { error: updateError } = await supabase
          .from('bug_tracker')
          .update({
            status: 'Closed',
            updated_at: closeTime,
            updated_by: 'System (Auto-Close)',
            laste_updated: new Date().toLocaleString()
          })
          .eq('request_id', item.request_id)

        if (updateError) {
          console.error(`Auto-close failed for ${item.request_id}:`, updateError)
          continue
        }

        // Add changelog entry + bump version
        await addChangelogEntry(item.request_id, item.type, item.title, 'System (Auto-Close)')

        // Audit log
        await supabase.from('audit_log').insert({
          log_id: `AUD${Date.now()}_${item.request_id}`,
          timestamp: closeTime,
          user_email: 'system',
          user_name: 'System (Auto-Close)',
          action: 'Auto-Close',
          entity_type: 'Bug Request',
          entity_id: item.request_id,
          details: `Auto-closed after ${AUTO_CLOSE_DAYS} days in Completed status`
        })

        closedIds.push(item.request_id)
        console.log(`Auto-closed ${item.request_id} (${item.type}: ${item.title}) after ${daysSinceResolved} days`)
      }

      if (closedIds.length > 0) {
        toast.success(`Auto-closed ${closedIds.length} item${closedIds.length > 1 ? 's' : ''} after ${AUTO_CLOSE_DAYS} days`)
      }

      setProcessing(false)
      return { closed: closedIds.length, ids: closedIds }
    } catch (err) {
      console.error('Auto-close error:', err)
      setProcessing(false)
      return { closed: 0 }
    }
  }, [])

  return { runAutoClose, processing }
}

// ─── Helper: Add Changelog Entry ──────────────────────────────────────────────
// Bug → increment patch (3rd digit): 2.1.8 → 2.1.9
// Feature Request → increment minor (2nd digit) and reset patch: 2.1.8 → 2.2.0

async function addChangelogEntry(requestId, type, title, releasedBy) {
  try {
    // Get current version from settings first, fall back to changelog
    let currentVersion = null

    const { data: settingsData } = await supabase
      .from('settings')
      .select('setting_value')
      .eq('setting_key', 'app_version')
      .maybeSingle()

    if (settingsData?.setting_value) {
      currentVersion = settingsData.setting_value
    }

    // Fall back to latest changelog version if settings doesn't have it
    if (!currentVersion) {
      const { data: latestChangelog } = await supabase
        .from('changelog')
        .select('version')
        .order('version', { ascending: false })
        .limit(1)

      if (latestChangelog && latestChangelog.length > 0) {
        currentVersion = latestChangelog[0].version
      }
    }

    // Calculate new version based on type
    let newVersion = '2.0.1'
    if (currentVersion) {
      const parts = currentVersion.split('.').map(p => parseInt(p) || 0)
      const major = parts[0] || 2
      let minor = parts[1] || 0
      let patch = parts[2] || 0

      if (type === 'Feature Request') {
        // Feature Request → increment minor, reset patch to 0
        minor += 1
        patch = 0
      } else {
        // Bug (default) → increment patch
        patch += 1
      }

      newVersion = `${major}.${minor}.${patch}`
    }

    // Insert changelog entry
    const { error: changelogError } = await supabase.from('changelog').insert({
      version: newVersion,
      release_date: new Date().toISOString(),
      request_id: requestId,
      type: type || 'Bug',
      title: title || '',
      released_by: releasedBy || ''
    })

    if (changelogError) {
      console.error('Changelog insert error:', changelogError)
      return
    }

    // Update app_version in settings so sidebar + settings page reflect the change
    const { error: settingsError } = await supabase
      .from('settings')
      .update({
        setting_value: newVersion,
        updated_at: new Date().toISOString(),
        updated_by: releasedBy || 'System'
      })
      .eq('setting_key', 'app_version')

    if (settingsError) {
      console.error('Settings version update error:', settingsError)
    }

    // Dispatch a custom event so AppLayout (and any other listener) can update immediately
    window.dispatchEvent(new CustomEvent('app-version-updated', { detail: { version: newVersion } }))

    console.log(`Version bumped: ${currentVersion || 'none'} → ${newVersion} (${type})`)
  } catch (err) {
    console.error('Changelog entry error:', err)
  }
}
