/**
 * RICT CMMS — useNetworkMap Hook
 *
 * Loads all network_devices + network_change_requests and keeps them in sync
 * via Supabase realtime. Exposes CRUD helpers for direct edits (instructor)
 * and for student/work-study "suggest change" submissions.
 *
 * Writes are guarded at the UI layer via usePermissions; this hook only does
 * the data work.
 *
 * File: src/hooks/useNetworkMap.js
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { NETWORK_CONFIG, isDoNotUseIp, normaliseMac } from '@/lib/networkConfig'

const GATEWAY_IP = NETWORK_CONFIG.gateway

// ── Helpers ─────────────────────────────────────────────────────────────────

async function nextId(type) {
  const { data, error } = await supabase.rpc('get_next_id', { p_type: type })
  if (error) throw new Error(`Counter RPC failed (${type}): ${error.message}`)
  if (!data) throw new Error(`Counter RPC returned empty value for ${type}`)
  return data
}

function senderDisplayName(profile) {
  if (!profile) return 'Unknown'
  const first = profile.first_name || ''
  const lastInitial = (profile.last_name || '').charAt(0)
  return lastInitial ? `${first} ${lastInitial}.` : first || profile.email || 'Unknown'
}

async function writeAudit(profile, action, entityType, entityId, details) {
  try {
    await supabase.from('audit_log').insert({
      user_email: profile?.email || '',
      user_name: `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim(),
      action,
      entity_type: entityType,
      entity_id: entityId,
      details,
    })
  } catch (e) {
    // Non-critical — never fail the caller because audit logging broke
    console.warn('[useNetworkMap] Audit log write failed:', e.message)
  }
}

/**
 * Diff two device records and return only fields that actually changed.
 * Returns a plain object { field: { from, to } }.
 */
function diffDevice(current, proposed) {
  const fields = ['device_name', 'mac_address', 'profinet_name', 'location', 'notes', 'asset_id']
  const out = {}
  fields.forEach(f => {
    const a = (current?.[f] ?? '') || ''
    const b = (proposed?.[f] ?? '') || ''
    if (a !== b) out[f] = { from: a, to: b }
  })
  return out
}

// ── Main hook ───────────────────────────────────────────────────────────────

export function useNetworkMap() {
  const { profile } = useAuth()
  const [devices, setDevices] = useState([])
  const [changeRequests, setChangeRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Prevent state updates after unmount. Reset to true on EVERY mount
  // (refs persist across StrictMode unmount/remount cycles, so the cleanup
  // from the first mount would otherwise leave it permanently false).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── Initial + refresh loader ────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [devRes, ncrRes] = await Promise.all([
        supabase.from('network_devices').select('*').order('ip_address', { ascending: true }),
        supabase.from('network_change_requests').select('*').order('submitted_date', { ascending: false }),
      ])
      if (devRes.error) throw devRes.error
      if (ncrRes.error) throw ncrRes.error
      if (!mountedRef.current) return
      setDevices(devRes.data || [])
      setChangeRequests(ncrRes.data || [])
    } catch (e) {
      console.error('[useNetworkMap] Fetch failed:', e)
      if (mountedRef.current) setError(e.message || 'Failed to load network map')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // ── Realtime subscription ───────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('network-map-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'network_devices' }, (payload) => {
        setDevices(prev => {
          if (payload.eventType === 'DELETE') {
            return prev.filter(d => d.device_id !== payload.old.device_id)
          }
          const incoming = payload.new
          const next = prev.filter(d => d.device_id !== incoming.device_id)
          next.push(incoming)
          next.sort((a, b) => (a.ip_address || '').localeCompare(b.ip_address || '', undefined, { numeric: true }))
          return next
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'network_change_requests' }, (payload) => {
        setChangeRequests(prev => {
          if (payload.eventType === 'DELETE') {
            return prev.filter(r => r.request_id !== payload.old.request_id)
          }
          const incoming = payload.new
          const next = prev.filter(r => r.request_id !== incoming.request_id)
          next.unshift(incoming)
          return next
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── Derived lookups ─────────────────────────────────────────────────────
  const devicesBySubnet = useMemo(() => {
    const map = { '10.171.193.0': [], '10.171.194.0': [], '10.171.195.0': [] }
    devices.forEach(d => {
      if (!map[d.subnet]) map[d.subnet] = []
      map[d.subnet].push(d)
    })
    Object.keys(map).forEach(k => {
      map[k].sort((a, b) => (a.last_octet || 0) - (b.last_octet || 0))
    })
    return map
  }, [devices])

  const deviceByIp = useMemo(() => {
    const m = new Map()
    devices.forEach(d => m.set(d.ip_address, d))
    return m
  }, [devices])

  const pendingByDevice = useMemo(() => {
    const m = new Map()
    changeRequests.forEach(r => {
      if (r.status === 'Pending') {
        const key = r.device_id || r.ip_address
        if (!m.has(key)) m.set(key, [])
        m.get(key).push(r)
      }
    })
    return m
  }, [changeRequests])

  const pendingCount = useMemo(() =>
    changeRequests.filter(r => r.status === 'Pending').length,
    [changeRequests]
  )

  // Find duplicate MAC users (for warnings)
  const findDuplicateMac = useCallback((mac, excludeDeviceId = null) => {
    const norm = normaliseMac(mac)
    if (!norm) return null
    return devices.find(d =>
      d.device_id !== excludeDeviceId &&
      normaliseMac(d.mac_address || '') === norm
    ) || null
  }, [devices])

  // ═══════════════════════════════════════════════════════════════════════
  // Direct CRUD — instructor only (UI guards via hasPerm)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a new network_devices row (instructor direct-add or change-request approval).
   * Returns the inserted record on success.
   */
  const addDevice = useCallback(async (input) => {
    const ip = String(input.ip_address || '').trim()
    if (!ip) throw new Error('IP address is required.')
    const parts = ip.split('.')
    if (parts.length !== 4) throw new Error('Invalid IP address format.')
    const lastOctet = parseInt(parts[3], 10)
    if (isNaN(lastOctet) || lastOctet < 1 || lastOctet > 254) {
      throw new Error('Last octet must be 1–254.')
    }
    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0`

    const device_id = await nextId('network_device')
    const now = new Date().toISOString()
    const actor = senderDisplayName(profile)

    const row = {
      device_id,
      subnet,
      ip_address: ip,
      last_octet: lastOctet,
      device_name: input.device_name?.trim() || null,
      mac_address: input.mac_address ? normaliseMac(input.mac_address) : null,
      profinet_name: input.profinet_name?.trim() || null,
      location: input.location?.trim() || null,
      notes: input.notes?.trim() || null,
      asset_id: input.asset_id || null,
      is_reserved: !!input.is_reserved || isDoNotUseIp(ip),
      is_dhcp_gateway: ip === GATEWAY_IP,
      status: 'Active',
      created_at: now,
      created_by: actor,
      updated_at: now,
      updated_by: actor,
    }

    const { data, error } = await supabase
      .from('network_devices')
      .insert(row)
      .select()
      .single()
    if (error) throw new Error(error.message)

    await writeAudit(profile, 'Create', 'Network Device', device_id,
      `Added ${ip} — ${row.device_name || '(no name)'}`)

    return data
  }, [profile])

  /**
   * Update an existing network_devices row.
   */
  const updateDevice = useCallback(async (deviceId, patch) => {
    if (!deviceId) throw new Error('Missing device_id.')
    const existing = devices.find(d => d.device_id === deviceId)
    if (!existing) throw new Error('Device not found.')

    const updates = {
      device_name: patch.device_name === undefined ? existing.device_name : (patch.device_name?.trim() || null),
      mac_address: patch.mac_address === undefined
        ? existing.mac_address
        : (patch.mac_address ? normaliseMac(patch.mac_address) : null),
      profinet_name: patch.profinet_name === undefined ? existing.profinet_name : (patch.profinet_name?.trim() || null),
      location: patch.location === undefined ? existing.location : (patch.location?.trim() || null),
      notes: patch.notes === undefined ? existing.notes : (patch.notes?.trim() || null),
      asset_id: patch.asset_id === undefined ? existing.asset_id : (patch.asset_id || null),
      is_reserved: patch.is_reserved === undefined ? existing.is_reserved : !!patch.is_reserved,
      updated_at: new Date().toISOString(),
      updated_by: senderDisplayName(profile),
    }

    const { data, error } = await supabase
      .from('network_devices')
      .update(updates)
      .eq('device_id', deviceId)
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Audit — one entry per changed field is overkill; log a summary.
    const changedFields = Object.keys(updates)
      .filter(k => !['updated_at', 'updated_by'].includes(k))
      .filter(k => (existing[k] ?? '') !== (updates[k] ?? ''))
    if (changedFields.length > 0) {
      await writeAudit(profile, 'Update', 'Network Device', deviceId,
        `Edited ${existing.ip_address}: ${changedFields.join(', ')}`)
    }

    return data
  }, [devices, profile])

  /**
   * Delete a network_devices row (instructor).
   */
  const deleteDevice = useCallback(async (deviceId) => {
    const existing = devices.find(d => d.device_id === deviceId)
    const { error } = await supabase
      .from('network_devices')
      .delete()
      .eq('device_id', deviceId)
    if (error) throw new Error(error.message)
    await writeAudit(profile, 'Delete', 'Network Device', deviceId,
      `Deleted ${existing?.ip_address || deviceId} — ${existing?.device_name || ''}`.trim())
  }, [devices, profile])

  // ═══════════════════════════════════════════════════════════════════════
  // Change request workflow
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a change request. Used by student / work-study.
   * For `add` / `delete`: pass the appropriate proposed_values / current_values.
   * For `edit`: pass both current_values (snapshot) and proposed_values.
   */
  const submitChangeRequest = useCallback(async ({
    changeType,     // 'edit' | 'add' | 'delete'
    deviceId = null,
    ipAddress,
    subnet,
    currentValues = {},
    proposedValues = {},
    reason,
  }) => {
    if (!profile?.email) throw new Error('Not signed in.')
    if (!['edit', 'add', 'delete'].includes(changeType)) throw new Error('Invalid change type.')
    if (!ipAddress) throw new Error('IP address is required.')
    if (!reason || reason.trim().length < 5) {
      throw new Error('Please provide a reason (at least 5 characters).')
    }

    // If editing, strip proposed_values down to actual changes only
    let diff = proposedValues
    if (changeType === 'edit') {
      const actualDiff = diffDevice(currentValues, proposedValues)
      if (Object.keys(actualDiff).length === 0) {
        throw new Error('No changes to submit.')
      }
      diff = Object.fromEntries(
        Object.entries(actualDiff).map(([k, v]) => [k, v.to])
      )
    }

    // Normalise MAC in proposal
    if (diff.mac_address) diff.mac_address = normaliseMac(diff.mac_address)

    const request_id = await nextId('network_change_request')
    const row = {
      request_id,
      device_id: deviceId,
      ip_address: ipAddress,
      subnet: subnet || `${ipAddress.split('.').slice(0, 3).join('.')}.0`,
      change_type: changeType,
      current_values: currentValues,
      proposed_values: diff,
      reason: reason.trim(),
      submitted_by: profile.email.toLowerCase(),
      submitted_by_name: senderDisplayName(profile),
      submitted_date: new Date().toISOString(),
      status: 'Pending',
    }

    const { data, error } = await supabase
      .from('network_change_requests')
      .insert(row)
      .select()
      .single()
    if (error) throw new Error(error.message)

    await writeAudit(profile, 'Submit', 'Network Change Request', request_id,
      `${changeType === 'add' ? 'Add' : changeType === 'delete' ? 'Delete' : 'Edit'} request for ${ipAddress}`)

    return data
  }, [profile])

  /**
   * Cancel a pending change request (original submitter).
   */
  const cancelChangeRequest = useCallback(async (requestId) => {
    const existing = changeRequests.find(r => r.request_id === requestId)
    if (!existing) throw new Error('Request not found.')
    if (existing.submitted_by?.toLowerCase() !== profile?.email?.toLowerCase()) {
      throw new Error('You can only cancel your own requests.')
    }
    if (existing.status !== 'Pending') throw new Error('Only pending requests can be cancelled.')

    const { error } = await supabase
      .from('network_change_requests')
      .update({
        status: 'Cancelled',
        reviewed_date: new Date().toISOString(),
        reviewed_by: senderDisplayName(profile),
      })
      .eq('request_id', requestId)
    if (error) throw new Error(error.message)

    await writeAudit(profile, 'Cancel', 'Network Change Request', requestId,
      `Cancelled own request for ${existing.ip_address}`)
  }, [changeRequests, profile])

  /**
   * Approve a pending change request (instructor only).
   * Applies the proposed values to network_devices.
   */
  const approveChangeRequest = useCallback(async (requestId, reviewNotes = '') => {
    const req = changeRequests.find(r => r.request_id === requestId)
    if (!req) throw new Error('Request not found.')
    if (req.status !== 'Pending') throw new Error('Only pending requests can be approved.')

    const now = new Date().toISOString()
    const actor = senderDisplayName(profile)

    // Apply the change first
    if (req.change_type === 'add') {
      await addDevice({
        ip_address: req.ip_address,
        ...req.proposed_values,
      })
    } else if (req.change_type === 'delete') {
      if (req.device_id) await deleteDevice(req.device_id)
    } else {
      // edit
      if (!req.device_id) throw new Error('Missing device_id on edit request.')
      await updateDevice(req.device_id, req.proposed_values)
    }

    // Mark the request as approved
    const { error } = await supabase
      .from('network_change_requests')
      .update({
        status: 'Approved',
        reviewed_by: actor,
        reviewed_date: now,
        review_notes: reviewNotes || null,
      })
      .eq('request_id', requestId)
    if (error) throw new Error(error.message)

    await writeAudit(profile, 'Approve', 'Network Change Request', requestId,
      `Approved ${req.change_type} of ${req.ip_address}`)
  }, [changeRequests, profile, addDevice, updateDevice, deleteDevice])

  /**
   * Reject a pending change request (instructor only).
   * Reason is required and is fed through the existing useRejectionNotification
   * elsewhere; this hook just records the DB state change.
   */
  const rejectChangeRequest = useCallback(async (requestId, rejectionReason) => {
    if (!rejectionReason || rejectionReason.trim().length < 5) {
      throw new Error('Rejection reason is required (minimum 5 characters).')
    }
    const req = changeRequests.find(r => r.request_id === requestId)
    if (!req) throw new Error('Request not found.')
    if (req.status !== 'Pending') throw new Error('Only pending requests can be rejected.')

    const { error } = await supabase
      .from('network_change_requests')
      .update({
        status: 'Rejected',
        reviewed_by: senderDisplayName(profile),
        reviewed_date: new Date().toISOString(),
        rejection_reason: rejectionReason.trim(),
      })
      .eq('request_id', requestId)
    if (error) throw new Error(error.message)

    await writeAudit(profile, 'Reject', 'Network Change Request', requestId,
      `Rejected ${req.change_type} of ${req.ip_address}. Reason: ${rejectionReason.trim()}`)
  }, [changeRequests, profile])

  return {
    // state
    devices,
    changeRequests,
    loading,
    error,
    // derived
    devicesBySubnet,
    deviceByIp,
    pendingByDevice,
    pendingCount,
    findDuplicateMac,
    // crud
    addDevice,
    updateDevice,
    deleteDevice,
    // change requests
    submitChangeRequest,
    cancelChangeRequest,
    approveChangeRequest,
    rejectChangeRequest,
    // refresh
    refresh: fetchAll,
  }
}
