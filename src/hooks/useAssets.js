import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

/**
 * Hook for fetching all assets with search/filter
 */
export function useAssetsList() {
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const hasLoadedRef = useRef(false)

  const fetchAssets = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    setError(null)

    try {
      const { data, error: fetchError } = await supabase
        .from('assets')
        .select('*')
        .order('name', { ascending: true })

      if (fetchError) throw fetchError
      setAssets(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching assets:', err)
      setError(err.message)
      if (!hasLoadedRef.current) toast.error('Failed to load assets')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAssets()
  }, [fetchAssets])

  // Real-time subscription
  useEffect(() => {
    const channel = supabase
      .channel('assets-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assets' },
        () => { fetchAssets() }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchAssets])

  // Re-fetch when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        fetchAssets()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetchAssets])

  return { assets, loading, error, refresh: fetchAssets }
}

/**
 * Hook for fetching a single asset with related work orders
 */
export function useAssetDetail(assetId) {
  const [asset, setAsset] = useState(null)
  const [workOrders, setWorkOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetchDetail = useCallback(async () => {
    if (!assetId) return
    if (!hasLoadedRef.current) setLoading(true)

    try {
      // Fetch asset
      const { data: assetData, error: assetError } = await supabase
        .from('assets')
        .select('*')
        .eq('asset_id', assetId)
        .single()

      if (assetError) throw assetError
      setAsset(assetData)

      // Fetch related work orders
      const { data: woData } = await supabase
        .from('work_orders')
        .select('wo_id, description, status, priority, created_at')
        .eq('asset_id', assetId)
        .order('created_at', { ascending: false })
        .limit(10)

      setWorkOrders(woData || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching asset:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load asset details')
    } finally {
      setLoading(false)
    }
  }, [assetId])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  return { asset, workOrders, loading, refresh: fetchDetail }
}

/**
 * Asset mutation functions
 */
export function useAssetActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  /**
   * Create a new asset
   */
  const createAsset = async (assetData) => {
    setSaving(true)
    try {
      // Generate asset ID via get_next_id RPC (p_type param, counter_name = 'asset')
      let assetId = null
      try {
        const { data: counter, error: rpcError } = await supabase.rpc('get_next_id', { p_type: 'asset' })
        if (rpcError) throw rpcError
        if (counter) assetId = counter
      } catch (e) {
        console.warn('get_next_id RPC failed, using safe client-side fallback:', e.message)
      }

      // Safe fallback: AST + 4-digit number based on timestamp (never produces long IDs)
      if (!assetId) {
        assetId = 'AST' + (1000 + Math.floor(Math.random() * 8999))
      }

      const insertData = {
        asset_id: assetId,
        name: assetData.name,
        description: assetData.description || '',
        category: assetData.category || '',
        location: assetData.location || '',
        status: assetData.status || 'Active',
        image_file_id: assetData.imageFileId || '',
        created_date: new Date().toISOString(),
        created_by: userName,
        last_updated: new Date().toISOString(),
        last_updated_by: userName,
      }

      const { data, error } = await supabase
        .from('assets')
        .insert(insertData)
        .select()
        .single()

      if (error) throw error

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Create',
          entity_type: 'Asset',
          entity_id: assetId,
          details: `Created asset: ${assetData.name}`,
        })
      } catch (e) { console.log('Audit log error (non-critical):', e) }

      toast.success(`Asset ${assetId} created!`)
      return data
    } catch (err) {
      console.error('Error creating asset:', err)
      toast.error(err.message || 'Failed to create asset')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Update an existing asset
   */
  const updateAsset = async (assetId, updates) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('assets')
        .update({
          ...updates,
          last_updated: new Date().toISOString(),
          last_updated_by: userName,
        })
        .eq('asset_id', assetId)

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Update',
          entity_type: 'Asset',
          entity_id: assetId,
          details: `Updated asset`,
        })
      } catch (e) { console.log('Audit log error (non-critical):', e) }

      toast.success('Asset updated!')
    } catch (err) {
      console.error('Error updating asset:', err)
      toast.error(err.message || 'Failed to update asset')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Delete an asset
   */
  const deleteAsset = async (assetId, assetName) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('assets')
        .delete()
        .eq('asset_id', assetId)

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Delete',
          entity_type: 'Asset',
          entity_id: assetId,
          details: `Deleted asset: ${assetName}`,
        })
      } catch (e) { console.log('Audit log error (non-critical):', e) }

      toast.success('Asset deleted!')
    } catch (err) {
      console.error('Error deleting asset:', err)
      toast.error(err.message || 'Failed to delete asset')
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, createAsset, updateAsset, deleteAsset }
}

/**
 * Hook for fetching locations (for dropdowns)
 */
export function useLocations() {
  const [locations, setLocations] = useState([])

  useEffect(() => {
    async function fetch() {
      try {
        const { data } = await supabase
          .from('locations')
          .select('*')
          .order('name')
        setLocations(data || [])
      } catch (e) {
        // If locations table doesn't exist, use defaults
        console.log('Locations table not found, using defaults')
        setLocations([])
      }
    }
    fetch()
  }, [])

  return locations
}

/**
 * Hook for fetching asset categories
 */
export function useCategories() {
  const [categories, setCategories] = useState([])

  useEffect(() => {
    async function fetch() {
      try {
        const { data } = await supabase
          .from('categories')
          .select('*')
          .order('name')
        if (data?.length) {
          setCategories(data.map(c => c.name || c.category_name || c.category))
        }
      } catch (e) {
        console.log('Categories table not found, using defaults')
        setCategories([])
      }
    }
    fetch()
  }, [])

  return categories
}
