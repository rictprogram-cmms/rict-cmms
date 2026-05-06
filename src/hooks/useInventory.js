import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── Helper: unique realtime channel suffix ──────────────────────────────────
// Per project rule: channel names must be unique per mounted component to
// prevent conflicts when multiple instances of a hook are alive at once.
function makeChannelSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Two-tier inventory part-ID generator.
 *
 * Tier 1 (default): atomic `get_next_id` RPC with p_type='inventory'.
 *   Race-safe at the DB level. Returns the full prefixed ID (e.g. "INV2006").
 *
 * Tier 2 (fallback / drift recovery): drift-resistant client-side max scan.
 *   Reads `counters` AND the actual MAX numeric part_id from the inventory
 *   table, uses `MAX(counter, table_max) + 1`, and writes the corrected value
 *   back to `counters`. Used when the RPC fails or when the caller passes
 *   `forceClient: true` (used for retry-after-23505).
 *
 * Note: the previous fallback (`'INV' + Date.now().toString().slice(-4)`)
 * could directly collide with existing part_ids like INV1882, so it has been
 * replaced with this drift-resistant pattern to match useSettings.js.
 *
 * Returns `null` only if the counter row is missing AND the inventory table
 * scan fails — caller should treat that as an unrecoverable error.
 */
async function generateInventoryPartId(options = {}) {
  const { forceClient = false } = options

  // ── Tier 1: atomic RPC ─────────────────────────────────────────────────────
  if (!forceClient) {
    try {
      const { data: rpcId, error: rpcErr } = await supabase.rpc('get_next_id', { p_type: 'inventory' })
      if (!rpcErr && rpcId) return rpcId
      if (rpcErr) console.warn('generateInventoryPartId: RPC error, falling through:', rpcErr.message)
    } catch (e) {
      console.warn('generateInventoryPartId: RPC threw, falling through:', e.message)
    }
  }

  // ── Tier 2: drift-resistant client-side ────────────────────────────────────
  // 1. Read counter row (for current_value + prefix)
  let counterVal = 1000
  let prefix = 'INV'
  try {
    const { data: counter } = await supabase
      .from('counters')
      .select('current_value, prefix')
      .eq('counter_name', 'inventory')
      .maybeSingle()
    if (counter) {
      counterVal = counter.current_value || 1000
      prefix = counter.prefix || 'INV'
    }
  } catch (e) {
    console.warn('generateInventoryPartId: counter read failed, using defaults:', e.message)
  }

  // 2. Read actual max numeric part_id from inventory (drift detection).
  //    Lex-sort is unsafe (e.g. "INV9999" > "INV10000" lexically), so we pull
  //    just the part_id column and compute max numerically in JS.
  let tableMax = 0
  try {
    const { data: rows } = await supabase.from('inventory').select('part_id')
    if (rows && rows.length > 0) {
      for (const r of rows) {
        const raw = (r.part_id || '').toString()
        const digits = raw.replace(/\D/g, '')
        const n = digits ? parseInt(digits, 10) : 0
        if (Number.isFinite(n) && n > tableMax) tableMax = n
      }
    }
  } catch (e) {
    console.warn('generateInventoryPartId: max scan failed, using counter only:', e.message)
  }

  // 3. Use whichever is higher, then +1
  const nextVal = Math.max(counterVal, tableMax) + 1

  // 4. Heal the counter row so future RPC calls return correct values
  try {
    await supabase.from('counters').update({
      current_value: nextVal,
      updated_at: new Date().toISOString()
    }).eq('counter_name', 'inventory')
  } catch (e) {
    console.warn('generateInventoryPartId: counter update failed:', e.message)
  }

  return `${prefix}${nextVal}`
}

/**
 * Hook for fetching all inventory items
 *
 * Fix: separates initial load from background refresh to prevent
 * "stuck loading" when switching browser tabs. Only shows loading
 * spinner on first fetch; realtime/visibility refreshes update silently.
 */
export function useInventoryList() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const hasLoadedRef = useRef(false)
  const channelIdRef = useRef(`inventory-changes-${makeChannelSuffix()}`)

  const fetchItems = useCallback(async () => {
    // Only show loading spinner on initial load
    if (!hasLoadedRef.current) setLoading(true)
    setError(null)

    try {
      const { data, error: fetchError } = await supabase
        .from('inventory')
        .select('*')
        .order('part_name', { ascending: true })

      if (fetchError) throw fetchError

      const enriched = (data || []).map(item => {
        const qty = parseFloat(item.qty_in_stock) || 0
        const min = parseFloat(item.min_qty) || 0
        const max = parseFloat(item.max_qty) || 0
        return {
          ...item,
          qty_in_stock: qty,
          min_qty: min,
          max_qty: max,
          is_low_stock: qty <= min && min > 0,
          is_out_of_stock: qty === 0,
          qty_needed: Math.max(0, max - qty),
        }
      })

      setItems(enriched)
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching inventory:', err)
      setError(err.message)
      if (!hasLoadedRef.current) toast.error('Failed to load inventory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchItems() }, [fetchItems])

  // Realtime subscription (unique channel per mount)
  useEffect(() => {
    const channel = supabase
      .channel(channelIdRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => { fetchItems() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchItems])

  // Re-fetch when tab becomes visible (handles stale token / disconnected realtime)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        fetchItems()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetchItems])

  return { items, loading, error, refresh: fetchItems }
}

/**
 * Inventory mutation functions
 */
export function useInventoryActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const createItem = async (itemData) => {
    setSaving(true)
    try {
      // Generate part ID via Tier 1 RPC, with drift-resistant Tier 2 fallback.
      let partId = await generateInventoryPartId()
      if (!partId) {
        throw new Error('Could not generate part ID — please try again')
      }

      const buildPayload = (id) => ({
        part_id: id,
        part_name: itemData.partName,
        description: itemData.description || '',
        primary_supplier: itemData.primarySupplier || '',
        supplier_part_number: itemData.supplierPartNumber || '',
        qty_in_stock: parseFloat(itemData.qtyInStock) || 0,
        min_qty: parseFloat(itemData.minQty) || 0,
        max_qty: parseFloat(itemData.maxQty) || 0,
        location: itemData.location || '',
        image_url: itemData.imageUrl || '',
        status: itemData.status || 'Active',
        updated_at: new Date().toISOString(),
        updated_by: userName,
      })

      // Insert with retry-on-duplicate-key. On collision, force the drift-
      // resistant client path (which heals the counter) and retry.
      let inserted = null
      let lastError = null
      const maxAttempts = 3

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { data, error } = await supabase
          .from('inventory')
          .insert(buildPayload(partId))
          .select().single()

        if (!error) {
          inserted = data
          break
        }

        lastError = error

        // 23505 = unique_violation. Force drift-resistant path and retry.
        if (error.code === '23505' && attempt < maxAttempts - 1) {
          const retryId = await generateInventoryPartId({ forceClient: true })
          if (retryId) {
            partId = retryId
            continue
          }
        }

        throw error
      }

      if (!inserted) throw lastError || new Error('Insert failed')

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Create', entity_type: 'Inventory', entity_id: partId,
          details: `Created part: ${itemData.partName}`,
        })
      } catch (e) {}

      toast.success(`Part ${partId} created!`)
      return inserted
    } catch (err) {
      console.error('Error creating inventory item:', err)
      if (err && err.code === '23505') {
        toast.error('Could not generate a unique ID — please refresh and try again.')
      } else {
        toast.error(err.message || 'Failed to create item')
      }
      throw err
    } finally { setSaving(false) }
  }

  const updateItem = async (partId, updates) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('inventory')
        .update({ ...updates, updated_at: new Date().toISOString(), updated_by: userName })
        .eq('part_id', partId)
      if (error) throw error
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Update', entity_type: 'Inventory', entity_id: partId,
          details: `Updated inventory item`,
        })
      } catch (e) {}
      toast.success('Item updated!')
    } catch (err) {
      console.error('Error updating inventory item:', err)
      toast.error(err.message || 'Failed to update item')
      throw err
    } finally { setSaving(false) }
  }

  const updateStock = async (partId, newQty, reason = '') => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('inventory')
        .update({ qty_in_stock: parseFloat(newQty) || 0, updated_at: new Date().toISOString(), updated_by: userName })
        .eq('part_id', partId)
      if (error) throw error
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Stock Update', entity_type: 'Inventory', entity_id: partId,
          details: `Updated stock to ${newQty}${reason ? ': ' + reason : ''}`,
        })
      } catch (e) {}
      toast.success(`Stock updated to ${newQty}`)
    } catch (err) {
      console.error('Error updating stock:', err)
      toast.error(err.message || 'Failed to update stock')
      throw err
    } finally { setSaving(false) }
  }

  const deleteItem = async (partId, partName) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('inventory').delete().eq('part_id', partId)
      if (error) throw error
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Delete', entity_type: 'Inventory', entity_id: partId,
          details: `Deleted part: ${partName}`,
        })
      } catch (e) {}
      toast.success('Item deleted!')
    } catch (err) {
      console.error('Error deleting inventory item:', err)
      toast.error(err.message || 'Failed to delete item')
      throw err
    } finally { setSaving(false) }
  }

  return { saving, createItem, updateItem, updateStock, deleteItem }
}
