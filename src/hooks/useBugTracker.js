import { useState, useEffect, useCallback, useRef } from 'react'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { usePermissions } from '@/hooks/usePermissions'

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOT ATTACHMENTS (Supabase Storage bucket: bug-screenshots)
// ═══════════════════════════════════════════════════════════════════════════════

/** Statuses that can be bulk-released as one version (Pending must be approved first; Rejected never). */
export const RELEASABLE_STATUSES = ['Open', 'In Progress', 'Completed']

export const BUG_SCREENSHOT_BUCKET = 'bug-screenshots'
export const MAX_SCREENSHOTS = 5
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024       // bucket limit
export const SCREENSHOT_MAX_WIDTH = 1920                  // resize cap (px)
export const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function safeFileName(name) {
  return (name || 'screenshot.png').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

/**
 * Downscale an image to SCREENSHOT_MAX_WIDTH and re-encode so a 4K PNG
 * doesn't land as 4 MB. Small images and GIFs (animation) pass through.
 * Returns a File (possibly the original).
 */
export async function prepareScreenshot(file) {
  if (!file || !SCREENSHOT_TYPES.includes(file.type)) return file
  if (file.type === 'image/gif') return file
  if (file.size <= 800 * 1024) return file                  // ≤ 800 KB: keep as-is

  const bitmap = await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not read image'))
    img.src = URL.createObjectURL(file)
  })
  try {
    const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / bitmap.naturalWidth)
    const w = Math.round(bitmap.naturalWidth * scale)
    const h = Math.round(bitmap.naturalHeight * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
    // PNG keeps UI text crisp; JPEG only if PNG is still big
    let blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
    let type = 'image/png', ext = 'png'
    if (!blob || blob.size > 1.5 * 1024 * 1024) {
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85))
      type = 'image/jpeg'; ext = 'jpg'
    }
    if (!blob) return file
    const base = safeFileName(file.name).replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.${ext}`, { type })
  } finally {
    URL.revokeObjectURL(bitmap.src)
  }
}

/** Validate a candidate file; returns an error string or null. */
export function validateScreenshot(file, currentCount) {
  if (!file) return 'No file.'
  if (!SCREENSHOT_TYPES.includes(file.type)) return `${file.name || 'File'} is not a PNG, JPG, WebP or GIF image.`
  if (file.size > MAX_SCREENSHOT_BYTES * 4) return `${file.name} is too large (over 20 MB).`
  if (currentCount >= MAX_SCREENSHOTS) return `Maximum ${MAX_SCREENSHOTS} screenshots per request.`
  return null
}

// ─── Super Admin Check ────────────────────────────────────────────────────────
// (super admin identity lives in src/lib/superAdmin.js)

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
      const existing = mustData(await supabase
        .from('bug_tracker')
        .select('request_id')
        .order('request_id', { ascending: false })
        .limit(1), 'bug_tracker.select')

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

      const { error } = assertWrite(
      await supabase.from('bug_tracker').insert(insertData).select(),
      'bug_tracker.insert'
    )
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

  /**
   * Upload screenshots for a request and append them to bug_tracker.screenshots.
   * Images are resized client-side (prepareScreenshot). Failures are per-file:
   * the request keeps whatever uploaded and the caller gets { uploaded, failed }.
   */
  const uploadScreenshots = async (requestId, files) => {
    if (!requestId || !files?.length) return { uploaded: [], failed: [] }
    setSaving(true)
    const uploaded = []
    const failed = []
    try {
      // Current list (so concurrent edits don't clobber each other)
      const { data: row, error: readErr } = await supabase
        .from('bug_tracker').select('screenshots').eq('request_id', requestId).single()
      if (readErr) throw readErr
      const existing = Array.isArray(row?.screenshots) ? row.screenshots : []
      const room = Math.max(0, MAX_SCREENSHOTS - existing.length)
      const batch = Array.from(files).slice(0, room)
      if (batch.length < files.length) failed.push(`Only ${room} more screenshot(s) allowed (max ${MAX_SCREENSHOTS}).`)

      for (let i = 0; i < batch.length; i++) {
        const original = batch[i]
        try {
          const file = await prepareScreenshot(original)
          if (file.size > MAX_SCREENSHOT_BYTES) { failed.push(`${original.name}: still over 5 MB after resizing.`); continue }
          const path = `${requestId}/${Date.now()}-${i}-${safeFileName(file.name)}`
          const { error: upErr } = await supabase.storage
            .from(BUG_SCREENSHOT_BUCKET)
            .upload(path, file, { contentType: file.type, upsert: false })
          if (upErr) { failed.push(`${original.name}: ${upErr.message}`); continue }
          const { data: pub } = supabase.storage.from(BUG_SCREENSHOT_BUCKET).getPublicUrl(path)
          uploaded.push({
            url: pub?.publicUrl || '',
            path,
            name: file.name,
            size: file.size,
            uploaded_by: userName,
            uploaded_at: new Date().toISOString(),
          })
        } catch (e) {
          failed.push(`${original.name}: ${e.message}`)
        }
      }

      if (uploaded.length > 0) {
        const now = new Date().toISOString()
        const { data: upd, error: updErr } = await supabase
          .from('bug_tracker')
          .update({ screenshots: [...existing, ...uploaded], updated_at: now, updated_by: userName })
          .eq('request_id', requestId)
          .select('request_id')
        if (updErr) throw updErr
        if (!upd || upd.length === 0) throw new Error('Screenshot save blocked by permissions (no rows updated).')

        await supabase.from('audit_log').insert({
          log_id: `AUD${Date.now()}`,
          timestamp: now,
          user_email: userEmail,
          user_name: userName,
          action: 'Attach Screenshot',
          entity_type: 'Bug Request',
          entity_id: requestId,
          details: `Attached ${uploaded.length} screenshot(s): ${uploaded.map(u => u.name).join(', ')}`
        })
      }
      return { uploaded, failed }
    } catch (err) {
      toast.error(err.message)
      return { uploaded, failed: [...failed, err.message] }
    } finally {
      setSaving(false)
    }
  }

  /** Remove one screenshot (storage object + jsonb entry). */
  const removeScreenshot = async (requestId, path) => {
    if (!requestId || !path) return false
    setSaving(true)
    try {
      const { data: row, error: readErr } = await supabase
        .from('bug_tracker').select('screenshots').eq('request_id', requestId).single()
      if (readErr) throw readErr
      const existing = Array.isArray(row?.screenshots) ? row.screenshots : []
      const target = existing.find(s => s.path === path)
      const remaining = existing.filter(s => s.path !== path)

      const { error: rmErr } = await supabase.storage.from(BUG_SCREENSHOT_BUCKET).remove([path])
      if (rmErr) throw rmErr

      const now = new Date().toISOString()
      const { data: upd, error: updErr } = await supabase
        .from('bug_tracker')
        .update({ screenshots: remaining, updated_at: now, updated_by: userName })
        .eq('request_id', requestId)
        .select('request_id')
      if (updErr) throw updErr
      if (!upd || upd.length === 0) throw new Error('Screenshot removal blocked by permissions (no rows updated).')

      await supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: now,
        user_email: userEmail,
        user_name: userName,
        action: 'Remove Screenshot',
        entity_type: 'Bug Request',
        entity_id: requestId,
        details: `Removed screenshot: ${target?.name || path}`
      })
      toast.success('Screenshot removed')
      return true
    } catch (err) {
      toast.error(err.message)
      return false
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

      const { error } = assertWrite(
      await supabase
        .from('bug_tracker')
        .update(updateData)
        .eq('request_id', requestId).select(),
      'bug_tracker.update'
    )
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
      const { error } = assertWrite(
      await supabase
        .from('bug_tracker')
        .delete()
        .eq('request_id', requestId).select(),
      'bug_tracker.delete'
    )
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
      const { error } = assertWrite(
      await supabase
        .from('bug_tracker')
        .update({
          status: 'Open',
          updated_at: now,
          updated_by: userName,
          laste_updated: new Date().toLocaleString()
        })
        .eq('request_id', requestId).select(),
      'bug_tracker.update'
    )
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
      const { error } = assertWrite(
      await supabase
        .from('bug_tracker')
        .delete()
        .eq('request_id', requestId).select(),
      'bug_tracker.delete'
    )
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

  // ── Bulk release ────────────────────────────────────────────────────────
  // Close several requests as ONE version: a single bump, one release_date,
  // one changelog row per request (plus an optional headline row with
  // request_id = null) all sharing the new version string. The changelog
  // table and What's New already group rows by version, so this needs no
  // schema change.
  //
  //   requestIds          — Open / In Progress / Completed requests only
  //   bumpVersion         — 'auto' (patch if all Bugs, minor if any Feature
  //                         Request) | 'minor' | 'major' | 'none'
  //   headlineTitle       — optional release headline (own changelog row, shown
  //                         first within the version group)
  //   headlineDescription — optional, stored only with a headline title
  //
  // Write order is chosen so a mid-way failure is recoverable, not silent:
  //   1. all changelog rows in ONE insert (atomic per statement)
  //   2. each request → Closed, one at a time, failures collected
  //   3. app_version written once (unless 'none')
  //   4. audit rows
  // If a close in step 2 fails, its changelog row already exists under the
  // new version; re-closing that request from the Edit modal with "no bump"
  // completes it without a duplicate version.
  //
  // Returns { success, partial, version, closed, failed: [{ request_id, error }] }.
  const releaseRequests = async ({ requestIds, bumpVersion = 'auto', headlineTitle = '', headlineDescription = '' }) => {
    if (!isSuperAdmin) {
      toast.error('Only the super admin can release requests')
      return { success: false }
    }
    const ids = [...new Set((requestIds || []).filter(Boolean))]
    if (ids.length === 0) {
      toast.error('Select at least one request')
      return { success: false }
    }
    const mode = ['minor', 'major', 'none'].includes(bumpVersion) ? bumpVersion : 'auto'

    setSaving(true)
    try {
      // Load the rows fresh — statuses may have changed since the list rendered.
      const rows = mustData(await supabase
        .from('bug_tracker')
        .select('request_id, type, title, status, resolved_date')
        .in('request_id', ids), 'bug_tracker.select') || []
      const byId = new Map(rows.map(r => [r.request_id, r]))
      const notReleasable = ids.filter(id => {
        const r = byId.get(id)
        return !r || !RELEASABLE_STATUSES.includes(r.status)
      })
      if (notReleasable.length > 0) {
        throw new Error(`Not releasable (must be Open, In Progress or Completed): ${notReleasable.join(', ')}`)
      }
      const eligible = ids.map(id => byId.get(id))

      const currentVersion = await fetchCurrentVersion()
      const releaseType = eligible.some(r => r.type === 'Feature Request') ? 'Feature Request' : 'Bug'
      const newVersion = computeNextVersion(currentVersion, mode, releaseType)

      // Headline gets the later timestamp so it sorts to the top of the group
      // (ChangelogTable sorts release_date descending within a version).
      const now = new Date()
      const headlineDate = now.toISOString()
      const itemDate = new Date(now.getTime() - 1000).toISOString()

      const cleanHeadline = (headlineTitle || '').trim()
      const cleanHeadlineDesc = (headlineDescription || '').trim()
      const payload = []
      if (cleanHeadline) {
        const headlineRow = {
          version: newVersion,
          release_date: headlineDate,
          request_id: null,
          type: releaseType,
          title: cleanHeadline,
          released_by: userName,
        }
        if (cleanHeadlineDesc) headlineRow.description = cleanHeadlineDesc
        payload.push(headlineRow)
      }
      eligible.forEach(r => payload.push({
        version: newVersion,
        release_date: itemDate,
        request_id: r.request_id,
        type: r.type || 'Bug',
        title: r.title || '',
        released_by: userName,
      }))

      // 1. Changelog rows — one statement
      const inserted = mustData(await supabase.from('changelog').insert(payload).select(), 'changelog.insert') || []
      if (inserted.length !== payload.length) {
        throw new Error(`Changelog insert wrote ${inserted.length} of ${payload.length} rows — nothing was closed`)
      }

      // 2. Close each request
      const nowIso = new Date().toISOString()
      const failed = []
      const closed = []
      for (const r of eligible) {
        try {
          const updateData = {
            status: 'Closed',
            updated_at: nowIso,
            updated_by: userName,
            laste_updated: new Date().toLocaleString(),
          }
          if (!r.resolved_date) updateData.resolved_date = nowIso
          const { error } = assertWrite(
            await supabase.from('bug_tracker').update(updateData).eq('request_id', r.request_id).select(),
            'bug_tracker.update'
          )
          if (error) throw error
          closed.push(r.request_id)
        } catch (e) {
          console.error(`releaseRequests: failed to close ${r.request_id}:`, e)
          failed.push({ request_id: r.request_id, error: e.message })
        }
      }

      // 3. Version — the changelog rows exist under newVersion, so bump even
      //    if a close failed; the operator fixes the straggler with "no bump".
      if (mode !== 'none') await writeAppVersion(newVersion, userName)

      // 4. Audit
      try {
        const auditRows = closed.map(id => ({
          log_id: `AUD${Date.now()}${Math.floor(Math.random() * 1000)}`,
          timestamp: nowIso,
          user_email: userEmail,
          user_name: userName,
          action: 'Update',
          entity_type: 'Bug Request',
          entity_id: id,
          details: `Closed in release v${newVersion}${cleanHeadline ? ` — ${cleanHeadline}` : ''}`,
        }))
        auditRows.push({
          log_id: `AUD${Date.now()}R`,
          timestamp: nowIso,
          user_email: userEmail,
          user_name: userName,
          action: 'Release',
          entity_type: 'Changelog',
          entity_id: newVersion,
          details: `Released v${newVersion} (${mode === 'none' ? 'no bump' : mode + ' bump'} from ${currentVersion || 'none'}): ${closed.length} closed${failed.length ? `, ${failed.length} failed (${failed.map(f => f.request_id).join(', ')})` : ''}${cleanHeadline ? ` — ${cleanHeadline}` : ''}`,
        })
        await supabase.from('audit_log').insert(auditRows)
      } catch (auditErr) {
        console.error('Release audit log error:', auditErr)
      }

      if (failed.length > 0) {
        toast.error(
          `Released v${newVersion} but ${failed.length} request${failed.length === 1 ? '' : 's'} did not close: ${failed.map(f => f.request_id).join(', ')}. Close them from Edit with "no version bump".`,
          { duration: 10000 }
        )
        return { success: true, partial: true, version: newVersion, closed: closed.length, failed }
      }
      toast.success(mode === 'none'
        ? `${closed.length} request${closed.length === 1 ? '' : 's'} closed under v${newVersion} (no bump)`
        : `Released v${newVersion} — ${closed.length} request${closed.length === 1 ? '' : 's'} closed 🚀`)
      return { success: true, partial: false, version: newVersion, closed: closed.length, failed: [] }
    } catch (err) {
      console.error('releaseRequests error:', err)
      toast.error(err.message || 'Release failed')
      return { success: false, error: err.message }
    } finally {
      setSaving(false)
    }
  }

  return {
    saving, isSuperAdmin, hasPerm,
    createRequest, updateRequest, deleteRequest,
    approveRequest, rejectRequest,
    addManualChangelogEntry,
    releaseRequests,
    uploadScreenshots, removeScreenshot,
  }
}

// ─── Version helpers (shared by single close, manual entry, and bulk release) ──

/**
 * Current app version: settings.app_version, falling back to the highest
 * changelog version. Returns null when neither exists.
 */
export async function fetchCurrentVersion() {
  const settingsData = mustData(await supabase
    .from('settings')
    .select('setting_value')
    .eq('setting_key', 'app_version')
    .maybeSingle(), 'settings.select')
  if (settingsData?.setting_value) return settingsData.setting_value

  const latestChangelog = mustData(await supabase
    .from('changelog')
    .select('version')
    .order('version', { ascending: false })
    .limit(1), 'changelog.select')
  return latestChangelog?.[0]?.version || null
}

/**
 * Pure version arithmetic. mode: 'auto' | 'minor' | 'major' | 'none'.
 *   auto  — Bug → patch (x.y.z → x.y.z+1); Feature Request → minor (x.y.z → x.y+1.0)
 *   minor — x.y.z → x.y+1.0 regardless of type
 *   major — x.y.z → x+1.0.0
 *   none  — unchanged (defaults to '0.0.1' if nothing is known)
 * Mirrors the historical rules exactly (including the '2.0.1' auto fallback
 * and '1.0.0' major fallback when no current version exists).
 */
export function computeNextVersion(currentVersion, mode = 'auto', type = 'Bug') {
  if (mode === 'none') return currentVersion || '0.0.1'
  if (mode === 'major') {
    if (!currentVersion) return '1.0.0'
    const parts = currentVersion.split('.').map(p => parseInt(p) || 0)
    return `${(parts[0] || 0) + 1}.0.0`
  }
  if (!currentVersion) return '2.0.1'
  const parts = currentVersion.split('.').map(p => parseInt(p) || 0)
  const major = parts[0] || 2
  let minor = parts[1] || 0
  let patch = parts[2] || 0
  if (mode === 'minor' || type === 'Feature Request') { minor += 1; patch = 0 }
  else { patch += 1 }
  return `${major}.${minor}.${patch}`
}

/** Write the new app_version and tell the layout so the sidebar updates now. */
async function writeAppVersion(newVersion, updatedBy) {
  const { error: settingsError } = assertWrite(
    await supabase
      .from('settings')
      .update({
        setting_value: newVersion,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy || 'System'
      })
      .eq('setting_key', 'app_version').select(),
    'settings.update'
  )
  if (settingsError) console.error('Settings version update error:', settingsError)
  window.dispatchEvent(new CustomEvent('app-version-updated', { detail: { version: newVersion } }))
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
      // multiple "no-bump" entries can legitimately share a version.
      // (release_date is now a timestamptz — pre-migration rows may still
      // share a midnight timestamp.) Including manual entries in the
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
        const { error: updateError } = assertWrite(
      await supabase
          .from('bug_tracker')
          .update({
            status: 'Closed',
            updated_at: closeTime,
            updated_by: 'System (Auto-Close)',
            laste_updated: new Date().toLocaleString()
          })
          .eq('request_id', item.request_id).select(),
      'bug_tracker.update'
    )

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
    // Current version (settings.app_version → latest changelog → null) and
    // the version this entry files under — see fetchCurrentVersion() and
    // computeNextVersion() above; the bulk release uses the same two helpers.
    const currentVersion = await fetchCurrentVersion()
    const newVersion = computeNextVersion(currentVersion, mode, type)

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

    const { error: changelogError } = assertWrite(
      await supabase.from('changelog').insert(insertPayload).select(),
      'changelog.insert'
    )

    if (changelogError) {
      console.error('Changelog insert error:', changelogError)
      return null
    }

    // When bumping (auto OR major), update app_version in settings so sidebar
    // + settings page reflect the change. When 'none', skip both the settings
    // update and the version-updated event so the displayed version stays put.
    if (mode !== 'none') {
      await writeAppVersion(newVersion, releasedBy)
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
