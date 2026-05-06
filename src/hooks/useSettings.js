import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── General Settings ────────────────────────────────────────────────────────

export function useSettings() {
  const [settings, setSettings] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .order('category')
        .order('setting_key')
      if (error) throw error
      setSettings(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Settings fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when settings change
  useEffect(() => {
    const channel = supabase
      .channel('settings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { settings, loading, refresh: fetch }
}

export function useSettingsActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  const updateSetting = async (key, value, meta = {}) => {
    setSaving(true)
    try {
      const { data: existing } = await supabase
        .from('settings')
        .select('setting_key')
        .eq('setting_key', key)
        .maybeSingle()

      if (existing) {
        const { data: rows, error } = await supabase.from('settings').update({
          setting_value: value,
          updated_at: new Date().toISOString(),
          updated_by: userName
        }).eq('setting_key', key).select()
        if (error) throw error
        if (!rows || rows.length === 0) {
          toast.error('Setting update failed — you may not have permission.')
          return
        }
      } else {
        // Brand-new setting: optionally tag it with category/description so it
        // shows up in the right place in the UI. Backward compatible — old
        // callers that didn't pass meta still get the original behavior.
        const insertPayload = {
          setting_key: key,
          setting_value: value,
          updated_at: new Date().toISOString(),
          updated_by: userName
        }
        if (meta.category)    insertPayload.category    = meta.category
        if (meta.description) insertPayload.description = meta.description

        const { data: rows, error } = await supabase.from('settings')
          .insert(insertPayload).select()
        if (error) throw error
        if (!rows || rows.length === 0) {
          toast.error('Setting create failed — you may not have permission.')
          return
        }
      }
      toast.success('Setting updated')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, updateSetting }
}

// ─── Generic CRUD for lookup tables ──────────────────────────────────────────

export function useLookupTable(tableName, idColumn, nameColumn, orderColumn) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .order(orderColumn || nameColumn || idColumn)
      if (error) throw error
      setItems(data || [])
    } catch (err) {
      console.error(`${tableName} fetch error:`, err)
    } finally {
      setLoading(false)
    }
  }, [tableName])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when the lookup table changes
  useEffect(() => {
    const channel = supabase
      .channel(`lookup-${tableName}-changes`)
      .on('postgres_changes', { event: '*', schema: 'public', table: tableName }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [tableName, fetch])

  return { items, loading, refresh: fetch }
}

/**
 * Drift-resistant lookup-table ID generator.
 *
 * Reads both the `counters` row AND the actual max numeric ID from the target
 * table, then returns `prefix + (max(counter, table_max) + 1)`. Writes the
 * corrected value back to `counters` so the row self-heals.
 *
 * Returns `null` if there is no counter row configured for this table — caller
 * should let the insert fail naturally in that case (matches prior behavior).
 *
 * Why client-side max calc instead of just trusting the counter:
 *   Bulk imports (e.g. SQL inserts during data migration) can populate the
 *   table without bumping the counter, leaving the counter behind the actual
 *   max. The next add then collides with `inventory_locations_pkey` and fails.
 *   See userMemory: "Client-side fallbacks must write corrected values back
 *   to counters or drift occurs."
 *
 * Lookup tables are small (<2000 rows in normal use), so pulling all IDs to
 * compute max is cheap. If a table grows beyond that, move this to an RPC.
 */
async function generateLookupId(counterName, tableName, idColumn) {
  // 1. Read counter
  const { data: counter, error: counterErr } = await supabase
    .from('counters')
    .select('current_value, prefix')
    .eq('counter_name', counterName)
    .maybeSingle()

  if (counterErr || !counter) return null

  const counterVal = counter.current_value || 1000
  const prefix = counter.prefix || ''

  // 2. Read actual max numeric ID from the target table (drift detection).
  //    Note: lex-sort is unsafe (e.g. "INV9999" > "INV10000" lexically), so
  //    we pull the column and compute max numerically in JS.
  let tableMax = 0
  try {
    const { data: rows } = await supabase.from(tableName).select(idColumn)
    if (rows && rows.length > 0) {
      for (const r of rows) {
        const raw = (r[idColumn] || '').toString()
        const digits = raw.replace(/\D/g, '')
        const n = digits ? parseInt(digits, 10) : 0
        if (Number.isFinite(n) && n > tableMax) tableMax = n
      }
    }
  } catch (e) {
    console.warn(`generateLookupId: max scan failed for ${tableName}, using counter only:`, e.message)
  }

  // 3. Use whichever is higher, then +1
  const nextVal = Math.max(counterVal, tableMax) + 1

  // 4. Heal the counter row so future calls don't repeat the work
  try {
    await supabase.from('counters').update({
      current_value: nextVal,
      updated_at: new Date().toISOString()
    }).eq('counter_name', counterName)
  } catch (e) {
    // Non-fatal — we still have a valid ID to attempt the insert with
    console.warn(`generateLookupId: counter update failed for ${counterName}:`, e.message)
  }

  return `${prefix}${nextVal}`
}

export function useLookupActions(tableName, idColumn) {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  const addItem = async (data) => {
    setSaving(true)
    try {
      const wasAutoGen = !data[idColumn]
      const counterName = getCounterName(tableName)

      // Auto-generate ID if not provided
      if (wasAutoGen) {
        const newId = await generateLookupId(counterName, tableName, idColumn)
        if (newId) data[idColumn] = newId
        // If no counter is configured (newId === null), let the insert fail
        // naturally below — preserves prior behavior for tables without counters.
      }

      // Insert with retry-on-duplicate-key (handles concurrent insert races
      // and any lingering drift). Only retries when WE generated the ID.
      const maxAttempts = wasAutoGen ? 3 : 1
      let inserted = null
      let lastError = null

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { data: rows, error } = await supabase.from(tableName).insert(data).select()

        if (!error) {
          if (!rows || rows.length === 0) {
            // RLS blocked the insert — preserve original message
            toast.error('Add failed — you may not have permission.')
            return
          }
          inserted = rows
          break
        }

        lastError = error

        // 23505 = unique_violation. If we auto-gen'd and have retries left,
        // recompute the ID (drift may have just been observed) and try again.
        if (error.code === '23505' && wasAutoGen && attempt < maxAttempts - 1) {
          const retryId = await generateLookupId(counterName, tableName, idColumn)
          if (retryId) {
            data[idColumn] = retryId
            continue
          }
        }

        // Non-retryable, or retries exhausted — throw to outer catch
        throw error
      }

      if (!inserted) return

      // Audit
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action: 'Create',
          entity_type: tableName,
          entity_id: data[idColumn] || '',
          details: `Created ${tableName}: ${JSON.stringify(data)}`
        })
      } catch {}

      toast.success('Added successfully')
    } catch (err) {
      // Friendlier message for unique-violation; otherwise show raw message
      if (err && err.code === '23505') {
        toast.error('Could not generate a unique ID — please refresh and try again.')
      } else {
        toast.error(err.message || 'Add failed')
      }
      throw err
    } finally {
      setSaving(false)
    }
  }

  const updateItem = async (id, updates) => {
    setSaving(true)
    try {
      const { data: rows, error } = await supabase.from(tableName).update(updates).eq(idColumn, id).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Update failed — you may not have permission.')
        return
      }

      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action: 'Update',
          entity_type: tableName,
          entity_id: id,
          details: `Updated ${tableName}`
        })
      } catch {}

      toast.success('Updated successfully')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const deleteItem = async (id) => {
    setSaving(true)
    try {
      const { data: rows, error } = await supabase.from(tableName).delete().eq(idColumn, id).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Delete failed — you may not have permission.')
        return
      }

      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action: 'Delete',
          entity_type: tableName,
          entity_id: id,
          details: `Deleted from ${tableName}`
        })
      } catch {}

      toast.success('Deleted')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, addItem, updateItem, deleteItem }
}

// Map table names to counter names
function getCounterName(tableName) {
  const map = {
    categories: 'category',
    asset_locations: 'asset_location',
    inventory_locations: 'inventory_location',
    vendors: 'vendor',
    wo_status: 'wo_status',
    classes: 'class',
  }
  return map[tableName] || tableName
}

// ─── Specific table hooks ────────────────────────────────────────────────────

export function useCategories() { return useLookupTable('categories', 'category_id', 'category_name') }
export function useCategoryActions() { return useLookupActions('categories', 'category_id') }

export function useAssetLocations() { return useLookupTable('asset_locations', 'location_id', 'location_name') }
export function useAssetLocationActions() { return useLookupActions('asset_locations', 'location_id') }

export function useInventoryLocations() { return useLookupTable('inventory_locations', 'location_id', 'location_name') }
export function useInventoryLocationActions() { return useLookupActions('inventory_locations', 'location_id') }

export function useVendorsList() { return useLookupTable('vendors', 'vendor_id', 'vendor_name') }
export function useVendorActions() { return useLookupActions('vendors', 'vendor_id') }

export function useWOStatuses() { return useLookupTable('wo_status', 'status_id', 'status_name', 'display_order') }
export function useWOStatusActions() { return useLookupActions('wo_status', 'status_id') }

export function useClasses() { return useLookupTable('classes', 'class_id', 'course_id') }
export function useClassActions() { return useLookupActions('classes', 'class_id') }
