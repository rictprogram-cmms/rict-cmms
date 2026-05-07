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

  // updateRequest accepts an optional `options` arg for close-time control:
  //   options.bumpVersion: 'auto' (default) | 'none' — only used when the
  //   status is being changed to 'Closed'. 'none' skips the version bump and
  //   logs the entry under the current version (useful for closing duplicates
  //   or trivial fixes you don't want to inflate the release sequence).
  const updateRequest = async (requestId, updates, options = {}) => {
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

      // If status changed to Closed, add changelog entry.
      // Defer to caller for whether to bump the version (defaults to auto-bump
      // to preserve historical behavior for callers that don't pass options).
      if (updates.status === 'Closed') {
        const closeBumpMode = options.bumpVersion === undefined ? true : options.bumpVersion
        await addChangelogEntry(requestId, updates.type, updates.title, userName, null, closeBumpMode)
      }

      // Audit log
      const auditDetails = updates.status === 'Closed' && options.bumpVersion === 'none'
        ? `Closed without version bump${updates.title ? ' - ' + updates.title : ''}`
        : `Updated request${updates.status ? ' - Status: ' + updates.status : ''}`
      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: now,
        user_email: userEmail,
        user_name: userName,
        action: 'Update',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: auditDetails
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

  // ─── Manual Changelog Entry (super admin only) ──────────────────────────
  // For changes made directly without a corresponding bug/feature request.
  // bumpVersion accepts:
  //   - 'auto' | true (default): bump per type rules
  //   - 'major'                : major bump (e.g. 3.3.3 → 4.0.0)
  //   - 'none' | false         : log under current version (no bump)
  const addManualChangelogEntry = async ({ type, title, description, bumpVersion = 'auto' }) => {
    if (!isSuperAdmin) {
      toast.error('Only the super admin can add manual changelog entries')
      return { success: false }
    }
    const cleanTitle = (title || '').trim()
    if (!cleanTitle) {
      toast.error('Title is required')
      return { success: false }
    }
    const cleanType = type === 'Feature Request' ? 'Feature Request' : 'Bug'
    const cleanDescription = (description || '').trim()

    // Normalize mode for messages/audit
    let mode = 'auto'
    if (bumpVersion === false || bumpVersion === 'none') mode = 'none'
    else if (bumpVersion === 'major') mode = 'major'

    setSaving(true)
    try {
      // request_id = null marks this as a manual entry
      const newVersion = await addChangelogEntry(
        null,
        cleanType,
        cleanTitle,
        userName,
        cleanDescription || null,
        bumpVersion
      )

      if (!newVersion) {
        toast.error('Failed to add changelog entry')
        return { success: false }
      }

      // Audit log
      const modeLabel = mode === 'major' ? 'major bump' : mode === 'none' ? 'no bump' : 'version bumped'
      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: new Date().toISOString(),
        user_email: userEmail,
        user_name: userName,
        action: 'Create',
        entity_type: 'Changelog Entry',
        entity_id: `v${newVersion}`,
        details: `Manual changelog entry (${cleanType}, ${modeLabel}): ${cleanTitle}`
      })

      // Toast
      const toastMsg = mode === 'major'
        ? `Major version bumped to v${newVersion} 🚀`
        : mode === 'none'
          ? `Changelog entry added under v${newVersion} (no bump)`
          : `Changelog entry added — v${newVersion}`
      toast.success(toastMsg)

      return { success: true, version: newVersion, mode }
    } catch (err) {
      console.error('Manual changelog entry error:', err)
      toast.error(err.message || 'Failed to add changelog entry')
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return {
    saving, isSuperAdmin, hasPerm,
    createRequest, updateRequest, deleteRequest,
    approveRequest, rejectRequest,
    addManualChangelogEntry
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
      // Deduplicate ONLY bug-backed entries (request_id present).
      //
      // The original dedup guarded against duplicate rows that the data
      // migration created for the same (version, request_id) pair. Manual
      // entries have request_id=null and are intentionally distinct —
      // multiple "no-bump" entries can legitimately share a version, and
      // since release_date is stored as a DATE (no time component), they
      // can also share a release_date. Including manual entries in the
      // dedup caused the later entry to silently hide the earlier one.
      const seen = new Set()
      const deduped = (data || []).filter(e => {
        if (!e.request_id) return true // never dedup manual entries
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
// Major → increment major (1st digit) and reset minor + patch: 2.1.8 → 3.0.0
//
// requestId may be null for manual entries added by super admin.
// description is optional (only stored if non-empty AND the column exists in DB).
// bumpVersion controls how the version is computed for this entry. Accepts:
//   - true | 'auto' (default): increment per type rules above (Bug/Feature)
//   - 'major'                : increment major, reset minor + patch to 0
//   - false | 'none'         : log under the CURRENT version (no increment)
// Used for trivial manual entries (typos, doc tweaks) or duplicate closes
// that the super admin wants tracked but shouldn't pollute the version
// sequence. Auto-close always bumps via 'auto'; bug-close defers to caller.
// Returns the new version string on success, or null on failure.

async function addChangelogEntry(requestId, type, title, releasedBy, description = null, bumpVersion = true) {
  // Normalize to one of: 'auto' | 'major' | 'none'
  let mode = 'auto'
  if (bumpVersion === false || bumpVersion === 'none') mode = 'none'
  else if (bumpVersion === 'major') mode = 'major'
  else mode = 'auto'

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

    // Calculate the version this entry will be filed under, based on `mode`.
    // - 'auto':  increment per type rules; fall back to "2.0.1" if no
    //            current version is known.
    // - 'major': increment major, reset minor + patch to 0.
    // - 'none':  file under the current version unchanged. If no current
    //            version is set anywhere, default to "0.0.1" so the row
    //            still has a valid version string (extremely unlikely).
    let newVersion
    if (mode === 'none') {
      newVersion = currentVersion || '0.0.1'
    } else if (mode === 'major') {
      if (currentVersion) {
        const parts = currentVersion.split('.').map(p => parseInt(p) || 0)
        const major = (parts[0] || 0) + 1
        newVersion = `${major}.0.0`
      } else {
        newVersion = '1.0.0'
      }
    } else {
      // 'auto'
      newVersion = '2.0.1'
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
    }

    // Insert changelog entry
    const insertPayload = {
      version: newVersion,
      release_date: new Date().toISOString(),
      request_id: requestId,
      type: type || 'Bug',
      title: title || '',
      released_by: releasedBy || ''
    }
    // Only include description if provided AND non-empty.
    // This keeps the existing bug-close path safe even if the description
    // column hasn't been added to the DB yet.
    if (description && String(description).trim()) {
      insertPayload.description = String(description).trim()
    }

    const { error: changelogError } = await supabase.from('changelog').insert(insertPayload)

    if (changelogError) {
      console.error('Changelog insert error:', changelogError)
      return null
    }

    // When bumping (auto OR major), update app_version in settings so sidebar
    // + settings page reflect the change. When 'none', skip both the settings
    // update and the version-updated event so the displayed version stays put.
    if (mode !== 'none') {
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
    }

    if (mode === 'major') {
      console.log(`MAJOR version bump: ${currentVersion || 'none'} → ${newVersion} (${type})`)
    } else if (mode === 'auto') {
      console.log(`Version bumped: ${currentVersion || 'none'} → ${newVersion} (${type})`)
    } else {
      console.log(`Changelog entry logged at v${newVersion} without bumping (${type})`)
    }
    return newVersion
  } catch (err) {
    console.error('Changelog entry error:', err)
    return null
  }
}
