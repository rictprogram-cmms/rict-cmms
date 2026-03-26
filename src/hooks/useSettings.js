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

  const updateSetting = async (key, value) => {
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
        const { data: rows, error } = await supabase.from('settings').insert({
          setting_key: key,
          setting_value: value,
          updated_at: new Date().toISOString(),
          updated_by: userName
        }).select()
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

export function useLookupActions(tableName, idColumn) {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  const addItem = async (data) => {
    setSaving(true)
    try {
      // Auto-generate ID if not provided
      if (!data[idColumn]) {
        const { data: counter } = await supabase
          .from('counters')
          .select('current_value, prefix')
          .eq('counter_name', getCounterName(tableName))
          .maybeSingle()

        if (counter) {
          const nextVal = (counter.current_value || 1000) + 1
          data[idColumn] = `${counter.prefix}${nextVal}`
          await supabase.from('counters').update({
            current_value: nextVal,
            updated_at: new Date().toISOString()
          }).eq('counter_name', getCounterName(tableName))
        }
      }

      const { data: rows, error } = await supabase.from(tableName).insert(data).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Add failed — you may not have permission.')
        return
      }

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
      toast.error(err.message)
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
