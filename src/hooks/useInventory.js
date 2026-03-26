import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

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

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('inventory-changes')
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
      let partId = `INV${Date.now().toString().slice(-4)}`
      try {
        const { data: counter } = await supabase.rpc('get_next_id', { id_type: 'inventory' })
        if (counter) partId = counter
      } catch (e) { console.log('get_next_id not available') }

      const { data, error } = await supabase
        .from('inventory')
        .insert({
          part_id: partId,
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
        .select().single()

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Create', entity_type: 'Inventory', entity_id: partId,
          details: `Created part: ${itemData.partName}`,
        })
      } catch (e) {}

      toast.success(`Part ${partId} created!`)
      return data
    } catch (err) {
      console.error('Error creating inventory item:', err)
      toast.error(err.message || 'Failed to create item')
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
