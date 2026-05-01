/**
 * RICT CMMS — useAssetCheckouts hook
 *
 * Manages asset checkout state, mutations and realtime updates.
 * Mirrors the patterns from useAssets.js and other hooks in the app.
 *
 * Storage convention ("fake-UTC"): all timestamps written with localToUtcIso()
 * so they keep the local clock-time values but carry a +00 offset, matching
 * how the rest of the app stores time-of-day-bearing fields.
 *
 * Hard rule: an asset can only have ONE open checkout at a time, enforced by
 * a partial unique index on the database side. This hook still pre-checks so
 * we can show a friendly error message before the round trip.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

/* ── Time helpers ─────────────────────────────────────────────────────── */

// Convert a JS Date (or anything new Date() can parse) to a "fake-UTC" ISO
// string per project convention: keep the local clock-time but tag +00.
export function localToUtcIso(date) {
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

// Reverse: read a stored fake-UTC string and produce display fields using
// getUTCHours()/getUTCDate() so the wall-clock values come back exactly as
// they were written (no zone shift).
export function fakeUtcToDisplay(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return {
    date: d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }),
    iso,
  }
}

// Days late (signed) for an open checkout. Positive = overdue.
export function daysOverdue(expectedReturn) {
  if (!expectedReturn) return 0
  const due = new Date(expectedReturn)
  const now = new Date()
  return Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24))
}

// Days remaining until expected return. Negative = overdue.
export function daysUntilDue(expectedReturn) {
  if (!expectedReturn) return null
  const due = new Date(expectedReturn)
  const now = new Date()
  const dayMs = 1000 * 60 * 60 * 24
  return Math.ceil((due.getTime() - now.getTime()) / dayMs)
}

/* ── List hook (every checkout, with realtime + visibility refetch) ───── */

export function useAssetCheckouts() {
  const [checkouts, setCheckouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const hasLoadedRef = useRef(false)

  const fetchCheckouts = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    setError(null)
    try {
      const { data, error: fetchError } = await supabase
        .from('asset_checkouts')
        .select('*')
        .order('checked_out_at', { ascending: false })
      if (fetchError) throw fetchError
      setCheckouts(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching checkouts:', err)
      setError(err.message)
      if (!hasLoadedRef.current) toast.error('Failed to load asset checkouts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchCheckouts() }, [fetchCheckouts])

  // Realtime — unique channel name per project rule (timestamp suffix)
  useEffect(() => {
    const channelName = `asset-checkouts-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'asset_checkouts' }, fetchCheckouts)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchCheckouts])

  // Refetch when tab becomes visible
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) fetchCheckouts()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [fetchCheckouts])

  return { checkouts, loading, error, refresh: fetchCheckouts }
}

/* ── Per-asset history hook ─────────────────────────────────────────── */

export function useAssetCheckoutHistory(assetId) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!assetId) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('asset_checkouts')
        .select('*')
        .eq('asset_id', assetId)
        .order('checked_out_at', { ascending: false })
      if (error) throw error
      setHistory(data || [])
    } catch (err) {
      console.error('Error fetching asset checkout history:', err)
    } finally {
      setLoading(false)
    }
  }, [assetId])

  useEffect(() => { refresh() }, [refresh])

  // Realtime — refresh when this asset's rows change
  useEffect(() => {
    if (!assetId) return
    const channelName = `asset-checkout-hist-${assetId}-${Date.now()}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'asset_checkouts', filter: `asset_id=eq.${assetId}` },
        refresh)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [assetId, refresh])

  const open = history.find(c => !c.returned_at) || null
  return { history, openCheckout: open, loading, refresh }
}

/* ── Per-user checkout hook (for student "what do I have out" view) ──── */

export function useUserOpenCheckouts(userEmail) {
  const [openCheckouts, setOpenCheckouts] = useState([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!userEmail) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('asset_checkouts')
        .select('*')
        .eq('user_email', userEmail)
        .is('returned_at', null)
        .order('checked_out_at', { ascending: false })
      if (error) throw error
      setOpenCheckouts(data || [])
    } catch (err) {
      console.error('Error fetching user open checkouts:', err)
    } finally {
      setLoading(false)
    }
  }, [userEmail])

  useEffect(() => { refresh() }, [refresh])
  return { openCheckouts, loading, refresh }
}

/* ── Mutation actions ──────────────────────────────────────────────── */

export function useCheckoutActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const issuerEmail = profile?.email || ''
  const issuerShort = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  /**
   * Create a checkout.
   *
   * params: {
   *   asset: { asset_id, name, serial_number },
   *   user:  { email, user_id, name },           // who is taking the asset
   *   expectedReturn: Date | null,
   *   condition: string,
   *   notes: string,
   *   acknowledgmentName: string,                 // typed signature
   * }
   */
  const checkOut = async ({ asset, user, expectedReturn, condition, notes, acknowledgmentName }) => {
    if (!asset?.asset_id) throw new Error('Asset is required')
    if (!user?.email) throw new Error('User is required')
    if (!acknowledgmentName?.trim()) throw new Error('Typed acknowledgment is required')

    setSaving(true)
    try {
      // Pre-check: is this asset already out?
      const { data: openRow } = await supabase
        .from('asset_checkouts')
        .select('checkout_id, user_name')
        .eq('asset_id', asset.asset_id)
        .is('returned_at', null)
        .maybeSingle()

      if (openRow) {
        throw new Error(`This asset is already checked out${openRow.user_name ? ` to ${openRow.user_name}` : ''}.`)
      }

      // Generate ID via the canonical RPC, with safe fallback per project convention.
      let checkoutId = null
      try {
        const { data: nextId, error: rpcErr } = await supabase.rpc('get_next_id', { p_type: 'asset_checkout' })
        if (rpcErr) throw rpcErr
        if (nextId) checkoutId = nextId
      } catch (e) {
        console.warn('get_next_id RPC failed for asset_checkout:', e.message)
      }
      if (!checkoutId) {
        // Fallback: AC + 6 digits derived from time
        checkoutId = 'AC' + String(Date.now()).slice(-6)
      }

      const dueDateLabel = expectedReturn
        ? new Date(expectedReturn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'returned'
      const acknowledgment_text =
        `I, ${acknowledgmentName.trim()}, accept responsibility for asset ${asset.asset_id} ` +
        `(${asset.name}${asset.serial_number ? `, SN ${asset.serial_number}` : ''}) ` +
        `until ${dueDateLabel}, and agree to return it in the same condition.`

      const nowIso = localToUtcIso(new Date())

      const insertRow = {
        checkout_id:         checkoutId,
        asset_id:            asset.asset_id,
        asset_name:          asset.name || '',
        asset_serial_number: asset.serial_number || null,
        user_id:             user.user_id || null,
        user_email:          user.email,
        user_name:           user.name || user.email,
        checked_out_at:      nowIso,
        expected_return:     expectedReturn ? localToUtcIso(expectedReturn) : null,
        returned_at:         null,
        checkout_condition:  condition || 'Good',
        checkout_notes:      notes || '',
        acknowledgment_name: acknowledgmentName.trim(),
        acknowledgment_text,
        acknowledgment_at:   nowIso,
        checked_out_by:      issuerEmail,
        needs_repair:        false,
      }

      const { data, error } = await supabase.from('asset_checkouts').insert(insertRow).select().single()
      if (error) throw error

      // Audit log (non-critical)
      try {
        await supabase.from('audit_log').insert({
          user_email:  issuerEmail,
          user_name:   issuerShort,
          action:      'Checkout',
          entity_type: 'Asset Checkout',
          entity_id:   checkoutId,
          details:     `${asset.asset_id} checked out to ${user.name || user.email}`,
        })
      } catch (e) { /* swallow */ }

      toast.success('Asset checked out')
      return data
    } catch (err) {
      console.error('Checkout error:', err)
      toast.error(err.message || 'Failed to check out asset')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Return a checkout.
   *
   * params: {
   *   checkoutId,
   *   condition,
   *   notes,
   *   needsRepair,                   // bool — if true, also creates a WO
   *   relatedWoId,                   // optional — link to created WO
   * }
   */
  const checkIn = async ({ checkoutId, condition, notes, needsRepair, relatedWoId }) => {
    if (!checkoutId) throw new Error('Checkout ID is required')
    setSaving(true)
    try {
      const update = {
        returned_at:      localToUtcIso(new Date()),
        return_condition: condition || 'Good',
        return_notes:     notes || '',
        needs_repair:     !!needsRepair,
        checked_in_by:    issuerEmail,
        related_wo_id:    relatedWoId || null,
      }

      const { data, error } = await supabase
        .from('asset_checkouts')
        .update(update)
        .eq('checkout_id', checkoutId)
        .select()
        .single()
      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email:  issuerEmail,
          user_name:   issuerShort,
          action:      'Checkin',
          entity_type: 'Asset Checkout',
          entity_id:   checkoutId,
          details:     `Returned. Condition: ${condition || 'Good'}${needsRepair ? ' (needs repair)' : ''}`,
        })
      } catch (e) { /* swallow */ }

      toast.success('Asset returned')
      return data
    } catch (err) {
      console.error('Check-in error:', err)
      toast.error(err.message || 'Failed to check in asset')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Extend the expected return date on an open checkout.
   */
  const extendDueDate = async (checkoutId, newDueDate) => {
    if (!checkoutId) throw new Error('Checkout ID is required')
    setSaving(true)
    try {
      const { data, error } = await supabase
        .from('asset_checkouts')
        .update({ expected_return: newDueDate ? localToUtcIso(newDueDate) : null })
        .eq('checkout_id', checkoutId)
        .select()
        .single()
      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email:  issuerEmail,
          user_name:   issuerShort,
          action:      'Extend',
          entity_type: 'Asset Checkout',
          entity_id:   checkoutId,
          details:     newDueDate ? `Extended due date to ${new Date(newDueDate).toLocaleDateString()}` : 'Cleared due date',
        })
      } catch (e) { /* swallow */ }

      toast.success('Due date updated')
      return data
    } catch (err) {
      console.error('Extend error:', err)
      toast.error(err.message || 'Failed to update due date')
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, checkOut, checkIn, extendDueDate }
}
