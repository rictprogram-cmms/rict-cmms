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
 *
 * STUDENT E-SIGNATURE FLOW (added in 3.4.0):
 *   - requestCheckout()           — instructor's session creates a pending row
 *   - acknowledgeCheckout()       — student's session signs (server enforces
 *                                   auth.email == row.user_email)
 *   - declineCheckout()           — student declines
 *   - cancelPendingCheckout()     — instructor cancels before student responds
 *   - instructorAttestedCheckout()— legacy fast-path (in-person hand-off);
 *                                   exposed as `checkOut` alias for back-compat
 *
 * NEW HOOKS:
 *   - useUserPendingAcknowledgments(userEmail) — for the bell + dashboard banner
 *
 * NEW UTILITIES:
 *   - formatCountdown(iso, [now])   — countdown label + urgency flags
 *   - DEFAULT_PENDING_EXPIRY_HOURS  — 24, the default request lifetime
 *
 * POOLED ITEMS (added for magnetic barcode readers):
 *   Pooled assets (assets.is_pooled = true) are interchangeable units tracked
 *   as ONE asset record that can have many open checkouts at once — one per
 *   student. Issue / check-in / lost happen on the Users page; the student
 *   signs through the same PendingAcknowledgmentModal as a normal checkout.
 *   - POOLED_SCANNER_ASSET_ID          — 'POOL-SCANNER'
 *   - buildPooledAcknowledgmentText()  — client preview of the server text
 *   - usePooledCheckouts(assetId)      — open pooled rows keyed by email
 *   - useCheckoutActions().issuePooled / checkInPooled / markPooledLost
 *   - acknowledgeCheckout() auto-routes pooled rows to acknowledge_pooled_checkout
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { useAuth } from '@/contexts/AuthContext'
import { withNetworkRetry, warmSession } from '@/lib/supabaseRetry'
import toast from 'react-hot-toast'

/* ── Constants ────────────────────────────────────────────────────── */

export const DEFAULT_PENDING_EXPIRY_HOURS = 24

// The single pooled asset record for the magnetic barcode readers.
// Seeded by the 2026-08-20_pooled_scanner_checkouts.sql migration.
export const POOLED_SCANNER_ASSET_ID = 'POOL-SCANNER'
export const POOLED_SCANNER_LABEL    = 'Magnetic Barcode Reader'

/**
 * Client-side preview of the acknowledgment sentence the server stores for a
 * pooled item (see _pooled_ack_text in the migration). Keep the two in sync.
 */
export function buildPooledAcknowledgmentText(checkout, typedName) {
  const name = typedName?.trim() || '[your name]'
  const item = checkout?.asset_name || 'pooled item'
  return `I, ${name}, acknowledge that I have been issued one ${item} by the RICT program. ` +
         `I accept responsibility for it and agree to return one in working condition, ` +
         `or to purchase a replacement if it is lost or damaged.`
}

/* ── Time helpers ─────────────────────────────────────────────────── */

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

/**
 * Compute a countdown label and urgency flags for a fake-UTC expiry timestamp.
 * Returns null if no expiry is set.
 *
 * @param {string|null} expiresAtIso  fake-UTC ISO from the database
 * @param {number}      [fromMs]      reference time in ms (defaults to Date.now())
 *
 * @returns { expired, label, ariaLabel, urgent, soon, totalMs } | null
 *   - expired:   true once we're past the deadline
 *   - urgent:    < 30 minutes remaining (red)
 *   - soon:      < 2 hours remaining (amber)
 *   - label:     short form, e.g. "18h 23m"
 *   - ariaLabel: long form for screen readers, e.g. "Expires in 18 hours and 23 minutes"
 */
export function formatCountdown(expiresAtIso, fromMs = Date.now()) {
  if (!expiresAtIso) return null
  const targetMs = new Date(expiresAtIso).getTime()
  if (isNaN(targetMs)) return null
  const diff = targetMs - fromMs

  if (diff <= 0) {
    return {
      expired: true,
      label: 'Expired',
      ariaLabel: 'This request has expired',
      urgent: true,
      soon: false,
      totalMs: 0,
    }
  }

  const totalMin = Math.floor(diff / 60000)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60

  let label
  let ariaLabel
  if (days > 0) {
    label = `${days}d ${hours}h`
    ariaLabel = `Expires in ${days} day${days === 1 ? '' : 's'} and ${hours} hour${hours === 1 ? '' : 's'}`
  } else if (hours > 0) {
    label = `${hours}h ${mins}m`
    ariaLabel = `Expires in ${hours} hour${hours === 1 ? '' : 's'} and ${mins} minute${mins === 1 ? '' : 's'}`
  } else {
    label = `${mins}m`
    ariaLabel = `Expires in ${mins} minute${mins === 1 ? '' : 's'}`
  }

  return {
    expired: false,
    label,
    ariaLabel,
    urgent: totalMin < 30,
    soon: totalMin < 120,
    totalMs: diff,
  }
}

/* ── List hook (every checkout, with realtime + visibility refetch) ── */

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

/* ── Per-asset history hook ───────────────────────────────────────── */

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
    const channelName = `asset-checkout-hist-${assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'asset_checkouts', filter: `asset_id=eq.${assetId}` },
        refresh)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [assetId, refresh])

  // "Open" = anything that still reserves the asset (returned_at IS NULL).
  // That includes pending_acknowledgment AND checked_out. Consumers that need
  // strictly "checked out" should filter on c.status === 'checked_out'.
  const open = history.find(c => !c.returned_at) || null
  return { history, openCheckout: open, loading, refresh }
}

/* ── Per-user open checkouts (assets they have right now) ────────── */

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

/* ── Per-user PENDING acknowledgments (for bell + dashboard banner) ──
   Returns rows the student needs to e-sign (or decline).
   Includes a ticking `now` value so consumers can render live countdowns
   without each managing their own setInterval.
*/

export function useUserPendingAcknowledgments(userEmail) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hasFiredFallbackRef = useRef(false)

  // Lowercase the email to match the RPC's normalization
  const normalizedEmail = (userEmail || '').toLowerCase()

  const refresh = useCallback(async () => {
    if (!normalizedEmail) {
      setRows([])
      return
    }
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('asset_checkouts')
        .select('*')
        .eq('user_email', normalizedEmail)
        .eq('status', 'pending_acknowledgment')
        .order('expires_at', { ascending: true })
      if (error) throw error
      setRows(data || [])
    } catch (err) {
      console.error('Error fetching pending acknowledgments:', err)
    } finally {
      setLoading(false)
    }
  }, [normalizedEmail])

  useEffect(() => { refresh() }, [refresh])

  // Realtime — listen for any pending row that becomes/changes for this user
  useEffect(() => {
    if (!normalizedEmail) return
    const channelName = `pending-ack-${normalizedEmail}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'asset_checkouts', filter: `user_email=eq.${normalizedEmail}` },
        refresh)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [normalizedEmail, refresh])

  // Tick the clock every 30 seconds for live countdowns
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Refresh on tab focus (in case rows were expired/acknowledged elsewhere).
  // warmSession() forces the auth token refresh NOW — on iOS Safari the
  // first fetch after resume often dies ("TypeError: Load failed"), and the
  // token refresh is usually that first fetch. Warming it here means the
  // student's Confirm tap rides a fresh connection + valid session.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        warmSession()
        setNow(Date.now())
        refresh()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh])

  // Client-side expiry fallback — if pg_cron is delayed/disabled and we
  // notice a row past its expiry, nudge the server to flip it. Fires at
  // most once per mount to avoid hammering on rapid re-renders.
  useEffect(() => {
    if (hasFiredFallbackRef.current) return
    const stale = rows.find(r =>
      r.expires_at && new Date(r.expires_at).getTime() < (Date.now() - 60_000)
    )
    if (stale) {
      hasFiredFallbackRef.current = true
      supabase.rpc('expire_pending_checkouts')
        .then(({ error }) => {
          if (error) console.warn('expire_pending_checkouts fallback:', error.message)
          else refresh()
        })
        .catch(err => console.warn('expire_pending_checkouts fallback threw:', err))
    }
  }, [rows, refresh])

  // Drop rows the client believes are already expired (server will catch up)
  const pending = rows.filter(r => {
    if (!r.expires_at) return true
    return new Date(r.expires_at).getTime() > now
  })

  return { pending, allRows: rows, loading, now, refresh }
}

/* ── Pooled items: open rows for one pooled asset, keyed by email ──
   Used by the Users page to render the Scanner column. "Open" means
   returned_at IS NULL — that includes pending_acknowledgment (issued, not
   yet signed) and checked_out (signed). Realtime keeps it fresh so the
   column flips the moment a student signs on their phone.
*/

export function usePooledCheckouts(assetId = POOLED_SCANNER_ASSET_ID) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!assetId) return
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('asset_checkouts')
        .select('checkout_id, asset_id, asset_name, user_email, user_name, status, checked_out_at, requested_at, expires_at, acknowledgment_at, handoff_method, checkout_notes')
        .eq('asset_id', assetId)
        .eq('is_pooled', true)
        .is('returned_at', null)
      if (error) throw error
      setRows(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching pooled checkouts:', err)
    } finally {
      setLoading(false)
    }
  }, [assetId])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!assetId) return
    const channelName = `pooled-${assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'asset_checkouts', filter: `asset_id=eq.${assetId}` },
        refresh)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [assetId, refresh])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh])

  // Map: lowercased email → open row
  const byEmail = {}
  rows.forEach(r => { if (r.user_email) byEmail[r.user_email.toLowerCase()] = r })

  const issuedCount  = rows.filter(r => r.status === 'checked_out').length
  const pendingCount = rows.filter(r => r.status === 'pending_acknowledgment').length

  return { rows, byEmail, issuedCount, pendingCount, loading, refresh }
}

/* ── Mutation actions ──────────────────────────────────────────── */

export function useCheckoutActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const issuerEmail = profile?.email || ''
  const issuerShort = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  /* ───────────────────────────────────────────────────────────────
     NEW (3.4.0) — Student e-signature flow
     ─────────────────────────────────────────────────────────────── */

  /**
   * Step 1 of the student e-signature flow: instructor's session creates
   * a pending row. The asset is reserved (the partial unique index treats
   * pending rows as "open") but no signature exists yet.
   *
   * params: {
   *   asset:          { asset_id, name, serial_number },
   *   user:           { email, user_id, name },         // the student
   *   expectedReturn: Date | null,
   *   condition:      string,
   *   notes:          string,
   *   expiryHours:    number = 24,                      // request lifetime
   * }
   */
  const requestCheckout = async ({
    asset,
    user,
    expectedReturn,
    condition,
    notes,
    expiryHours = DEFAULT_PENDING_EXPIRY_HOURS,
  }) => {
    if (!asset?.asset_id) throw new Error('Asset is required')
    if (!user?.email) throw new Error('Student is required')

    setSaving(true)
    try {
      const requestedDate = new Date()
      const expiresDate   = new Date(requestedDate.getTime() + expiryHours * 60 * 60 * 1000)

      // Retry-safe: the RPC re-checks the partial unique index on every
      // attempt, so a retry of a write that secretly succeeded errors
      // loudly instead of double-reserving the asset.
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc('request_asset_checkout', {
          p_asset_id:            asset.asset_id,
          p_asset_name:          asset.name || '',
          p_asset_serial_number: asset.serial_number || null,
          p_user_id:             user.user_id || null,
          p_user_email:          user.email,
          p_user_name:           user.name || user.email,
          p_expected_return:     expectedReturn ? localToUtcIso(expectedReturn) : null,
          p_condition:           condition || 'Good',
          p_notes:               notes || '',
          p_expires_at:          localToUtcIso(expiresDate),
          p_requested_at:        localToUtcIso(requestedDate),
        })
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — the request was not sent. Please check your signal and try again.',
      })

      toast.success(`Sent to ${user.name || user.email} for acknowledgment`)
      return data
    } catch (err) {
      console.error('Request checkout error:', err)
      toast.error(err.message || 'Failed to request checkout')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Step 2: student e-signs. MUST be called from the student's session —
   * the RPC compares auth.jwt().email to the row's user_email and rejects
   * any mismatch.
   */
  const acknowledgeCheckout = async ({ checkoutId, acknowledgmentName, isPooled = false }) => {
    if (!checkoutId) throw new Error('Checkout ID is required')
    if (!acknowledgmentName?.trim()) throw new Error('Typed acknowledgment is required')

    setSaving(true)
    try {
      const ackAt = localToUtcIso(new Date())
      // Pooled rows (scanners) have their own RPC so the stored legal text
      // matches the pooled wording; everything else is unchanged.
      const rpcName = isPooled ? 'acknowledge_pooled_checkout' : 'acknowledge_asset_checkout'
      // Retry-safe: status-flip RPC. If a "failed" attempt actually landed,
      // the retry gets the server's "no longer pending" answer rather than
      // signing twice.
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc(rpcName, {
          p_checkout_id:         checkoutId,
          p_acknowledgment_name: acknowledgmentName.trim(),
          p_acknowledgment_at:   ackAt,
        })
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — your signature was not recorded. Please check your signal and tap Confirm again. The request is still pending.',
      })

      toast.success('Checkout acknowledged')
      return data
    } catch (err) {
      console.error('Acknowledge error:', err)
      toast.error(err.message || 'Failed to acknowledge checkout')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Student declines. Frees the asset (RPC sets returned_at) and notifies
   * the instructor via realtime + (eventually) push.
   */
  const declineCheckout = async ({ checkoutId, reason }) => {
    if (!checkoutId) throw new Error('Checkout ID is required')

    setSaving(true)
    try {
      const at = localToUtcIso(new Date())
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc('decline_asset_checkout', {
          p_checkout_id: checkoutId,
          p_reason:      reason || '',
          p_at:          at,
        })
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — the decline was not recorded. Please check your signal and try again.',
      })

      toast.success('Checkout declined')
      return data
    } catch (err) {
      console.error('Decline error:', err)
      toast.error(err.message || 'Failed to decline checkout')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Instructor cancels a pending request before the student responds.
   */
  const cancelPendingCheckout = async (checkoutId) => {
    if (!checkoutId) throw new Error('Checkout ID is required')

    setSaving(true)
    try {
      const at = localToUtcIso(new Date())
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc('cancel_pending_checkout', {
          p_checkout_id: checkoutId,
          p_at:          at,
        })
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — the cancellation was not recorded. Please check your signal and try again.',
      })

      toast.success('Pending request cancelled')
      return data
    } catch (err) {
      console.error('Cancel pending error:', err)
      toast.error(err.message || 'Failed to cancel pending request')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /* ───────────────────────────────────────────────────────────────
     POOLED ITEMS — barcode scanners (Users page)
     All three go through SECURITY DEFINER RPCs that verify the caller
     is an active Instructor, so RLS silent-failures can't happen here:
     the RPC either returns the row or raises.
     ─────────────────────────────────────────────────────────────── */

  /**
   * Issue one pooled item to a student → creates a pending_acknowledgment
   * row. The student signs via PendingAcknowledgmentModal (dashboard/bell).
   * Pass `quiet: true` when looping (bulk issue) to suppress the toast.
   */
  const issuePooled = async ({ assetId = POOLED_SCANNER_ASSET_ID, user, notes = '', expiryHours = DEFAULT_PENDING_EXPIRY_HOURS, quiet = false }) => {
    if (!user?.email) throw new Error('Student is required')
    setSaving(true)
    try {
      const requestedDate = new Date()
      const expiresDate   = new Date(requestedDate.getTime() + expiryHours * 60 * 60 * 1000)
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc('request_pooled_checkout', {
          p_asset_id:     assetId,
          p_user_email:   user.email,
          p_user_name:    user.name || user.email,
          p_user_id:      user.user_id || null,
          p_notes:        notes || '',
          p_requested_at: localToUtcIso(requestedDate),
          p_expires_at:   localToUtcIso(expiresDate),
        })
        if (error) throw error
        if (!row) throw new Error('No row returned — the issue may have been blocked.')
        return row
      }, {
        failureMessage: 'Connection problem — the scanner was not issued. Please check your signal and try again.',
      })
      if (!quiet) toast.success(`Scanner issued to ${user.name || user.email} — awaiting their signature`)
      return data
    } catch (err) {
      console.error('Issue pooled error:', err)
      if (!quiet) toast.error(err.message || 'Failed to issue scanner')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /** Check one pooled item back in (or cancel an unsigned issue). */
  const checkInPooled = async ({ checkoutId, notes = '', quiet = false }) => {
    if (!checkoutId) throw new Error('Checkout ID is required')
    setSaving(true)
    try {
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc('checkin_pooled_checkout', {
          p_checkout_id: checkoutId,
          p_at:          localToUtcIso(new Date()),
          p_notes:       notes || '',
        })
        if (error) throw error
        if (!row) throw new Error('No row returned — the check-in may have been blocked.')
        return row
      }, {
        failureMessage: 'Connection problem — the check-in was not saved. Please check your signal and try again.',
      })
      if (!quiet) toast.success(data?.status === 'cancelled' ? 'Unsigned issue cancelled' : 'Scanner checked in')
      return data
    } catch (err) {
      console.error('Check-in pooled error:', err)
      if (!quiet) toast.error(err.message || 'Failed to check in scanner')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Mark a signed pooled item lost. Server closes the row as Lost and
   * immediately opens a new checked_out row with the original signature
   * carried forward, so the student still shows as owing one.
   */
  const markPooledLost = async ({ checkoutId, notes = '' }) => {
    if (!checkoutId) throw new Error('Checkout ID is required')
    setSaving(true)
    try {
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.rpc('mark_pooled_checkout_lost', {
          p_checkout_id: checkoutId,
          p_at:          localToUtcIso(new Date()),
          p_notes:       notes || '',
        })
        if (error) throw error
        if (!row) throw new Error('No row returned — the update may have been blocked.')
        return row
      }, {
        failureMessage: 'Connection problem — the lost report was not saved. Please check your signal and try again.',
      })
      toast.success('Marked lost — replacement still owed')
      return data
    } catch (err) {
      console.error('Mark pooled lost error:', err)
      toast.error(err.message || 'Failed to mark scanner lost')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /* ───────────────────────────────────────────────────────────────
     LEGACY — Instructor-attested in-person hand-off (fast path)
     ─────────────────────────────────────────────────────────────── */

  /**
   * Skip the request/sign flow and check the asset out immediately.
   * Use this when the student is standing right there and either doesn't
   * have their phone or speed matters more than the audit trail.
   *
   * Same params as the original checkOut(). Inserts:
   *   status          = 'checked_out'
   *   handoff_method  = handoffMethod  (default 'instructor_attested';
   *                                     pass 'student_self' for self-checkouts)
   *   acknowledgment_*= populated by the issuing session
   *
   * params: {
   *   asset, user, expectedReturn, condition, notes, acknowledgmentName,
   *   handoffMethod = 'instructor_attested',
   * }
   */
  const instructorAttestedCheckout = async ({
    asset, user, expectedReturn, condition, notes, acknowledgmentName,
    handoffMethod = 'instructor_attested',
  }) => {
    if (!asset?.asset_id) throw new Error('Asset is required')
    if (!user?.email) throw new Error('User is required')
    if (!acknowledgmentName?.trim()) throw new Error('Typed acknowledgment is required')

    setSaving(true)
    try {
      // Pre-check: is this asset already out (or pending)?
      const openRow = mustData(await supabase
        .from('asset_checkouts')
        .select('checkout_id, user_name, status')
        .eq('asset_id', asset.asset_id)
        .eq('is_pooled', false)
        .is('returned_at', null)
        .maybeSingle(), 'asset_checkouts.select')

      if (openRow) {
        if (openRow.status === 'pending_acknowledgment') {
          throw new Error(`Asset has a pending acknowledgment from ${openRow.user_name || 'another student'}. Cancel that first.`)
        }
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
        user_email:          (user.email || '').toLowerCase(),
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
        // New fields (3.4.0):
        status:              'checked_out',
        handoff_method:      handoffMethod,
        requested_by:        issuerEmail,
        requested_at:        nowIso,
      }

      // Retry-safe: checkout_id was generated above, so a retry of an
      // insert that secretly succeeded hits the primary key and errors
      // loudly instead of double-inserting.
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase.from('asset_checkouts').insert(insertRow).select().single()
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — the checkout was not saved. Please check your signal and try again.',
      })

      // Audit log (non-critical)
      try {
        const isSelf = handoffMethod === 'student_self'
        await supabase.from('audit_log').insert({
          user_email:  issuerEmail,
          user_name:   issuerShort,
          action:      isSelf ? 'Checkout (Self-Signed)' : 'Checkout (Instructor-Attested)',
          entity_type: 'Asset Checkout',
          entity_id:   checkoutId,
          details:     isSelf
            ? `${asset.asset_id} self-checked out by ${user.name || user.email}`
            : `${asset.asset_id} checked out to ${user.name || user.email} (in-person hand-off)`,
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
   * Back-compat alias for any callers that haven't migrated yet.
   * @deprecated Prefer requestCheckout() (student e-sig) or
   *             instructorAttestedCheckout() (legacy fast path).
   */
  const checkOut = (params) => instructorAttestedCheckout(params)

  /* ───────────────────────────────────────────────────────────────
     Existing actions (unchanged)
     ─────────────────────────────────────────────────────────────── */

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
        status:           'returned',
      }

      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase
          .from('asset_checkouts')
          .update(update)
          .eq('checkout_id', checkoutId)
          .select()
          .single()
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — the return was not saved. Please check your signal and try again.',
      })

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
      const data = await withNetworkRetry(async () => {
        const { data: row, error } = await supabase
          .from('asset_checkouts')
          .update({ expected_return: newDueDate ? localToUtcIso(newDueDate) : null })
          .eq('checkout_id', checkoutId)
          .select()
          .single()
        if (error) throw error
        return row
      }, {
        failureMessage: 'Connection problem — the due date was not updated. Please check your signal and try again.',
      })

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

  return {
    saving,

    // New (student e-signature flow)
    requestCheckout,
    acknowledgeCheckout,
    declineCheckout,
    cancelPendingCheckout,

    // Pooled items (scanners)
    issuePooled,
    checkInPooled,
    markPooledLost,

    // Legacy fast path (and deprecated alias)
    instructorAttestedCheckout,
    checkOut,

    // Unchanged
    checkIn,
    extendDueDate,
  }
}
