/**
 * RICT CMMS - SOPs (Standard Operating Procedures) Hook
 * 
 * Provides data fetching, CRUD operations, document upload/replace/delete,
 * and many-to-many linking to Assets, PM Schedules, and Work Orders.
 * 
 * Supabase tables:
 *   sops               - Main SOP records
 *   sop_assets          - Junction: SOP ↔ Assets (many-to-many)
 *   sop_pm_schedules    - Junction: SOP ↔ PM Schedules (many-to-many)
 *   sop_work_orders     - Junction: SOP ↔ Work Orders (many-to-many)
 * 
 * Supabase storage bucket: sop-documents (public, PDF only)
 * Counter: sop (prefix: SOP)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── List Hook ───────────────────────────────────────────────────────────
export function useSOPsList() {
  const [sops, setSOPs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const hasLoadedRef = useRef(false)

  const fetchSOPs = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    setError(null)

    try {
      const { data, error: fetchError } = await supabase
        .from('sops')
        .select('*')
        .order('name', { ascending: true })

      if (fetchError) throw fetchError
      setSOPs(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching SOPs:', err)
      setError(err.message)
      if (!hasLoadedRef.current) toast.error('Failed to load SOPs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSOPs() }, [fetchSOPs])

  // Real-time subscription
  useEffect(() => {
    const channel = supabase
      .channel('sops-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sops' }, () => fetchSOPs())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchSOPs])

  // Re-fetch when tab becomes visible
  useEffect(() => {
    const handleVis = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) fetchSOPs()
    }
    document.addEventListener('visibilitychange', handleVis)
    return () => document.removeEventListener('visibilitychange', handleVis)
  }, [fetchSOPs])

  return { sops, loading, error, refresh: fetchSOPs }
}

// ─── Linked Items Hook ───────────────────────────────────────────────────
export function useSOPLinks(sopId) {
  const [linkedAssets, setLinkedAssets] = useState([])
  const [linkedPMs, setLinkedPMs] = useState([])
  const [linkedWOs, setLinkedWOs] = useState([])
  const [loading, setLoading] = useState(false)

  const fetchLinks = useCallback(async () => {
    if (!sopId) return
    setLoading(true)
    try {
      const { data: assetLinks } = await supabase.from('sop_assets').select('asset_id').eq('sop_id', sopId)
      const { data: pmLinks } = await supabase.from('sop_pm_schedules').select('pm_id').eq('sop_id', sopId)
      const { data: woLinks } = await supabase.from('sop_work_orders').select('wo_id').eq('sop_id', sopId)

      const assetIds = (assetLinks || []).map(a => a.asset_id)
      const pmIds = (pmLinks || []).map(p => p.pm_id)
      const woIds = (woLinks || []).map(w => w.wo_id)

      if (assetIds.length > 0) {
        const { data } = await supabase.from('assets').select('asset_id, name, category, location, status').in('asset_id', assetIds).order('name')
        setLinkedAssets(data || [])
      } else { setLinkedAssets([]) }

      if (pmIds.length > 0) {
        const { data } = await supabase.from('pm_schedules').select('pm_id, pm_name, asset_name, frequency, next_due_date, status').in('pm_id', pmIds).order('pm_name')
        setLinkedPMs(data || [])
      } else { setLinkedPMs([]) }

      if (woIds.length > 0) {
        const { data: openData } = await supabase.from('work_orders').select('wo_id, description, asset_name, priority, status, assigned_to').in('wo_id', woIds)
        const { data: closedData } = await supabase.from('work_orders_closed').select('wo_id, description, asset_name, priority, status, assigned_to').in('wo_id', woIds)
        const merged = new Map()
        ;(openData || []).forEach(w => merged.set(w.wo_id, w))
        ;(closedData || []).forEach(w => { if (!merged.has(w.wo_id)) merged.set(w.wo_id, w) })
        setLinkedWOs(Array.from(merged.values()))
      } else { setLinkedWOs([]) }
    } catch (err) {
      console.error('Error fetching SOP links:', err)
    } finally { setLoading(false) }
  }, [sopId])

  useEffect(() => { fetchLinks() }, [fetchLinks])

  useEffect(() => {
    if (!sopId) return
    const channel = supabase
      .channel(`sop-links-${sopId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sop_assets' }, () => fetchLinks())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sop_pm_schedules' }, () => fetchLinks())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sop_work_orders' }, () => fetchLinks())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [sopId, fetchLinks])

  return { linkedAssets, linkedPMs, linkedWOs, loading, refresh: fetchLinks }
}

// ─── Available Items for Linking ─────────────────────────────────────────
export function useAvailableAssets() {
  const [assets, setAssets] = useState([])
  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('assets').select('asset_id, name, category, location, status').order('name')
      setAssets(data || [])
    })()
  }, [])
  return assets
}

export function useAvailablePMs() {
  const [pms, setPMs] = useState([])
  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('pm_schedules').select('pm_id, pm_name, asset_name, frequency, status').order('pm_name')
      setPMs(data || [])
    })()
  }, [])
  return pms
}

export function useAvailableWOs() {
  const [wos, setWOs] = useState([])
  useEffect(() => {
    ;(async () => {
      const { data: openData } = await supabase.from('work_orders').select('wo_id, description, asset_name, priority, status, assigned_to').order('wo_id', { ascending: false })
      const { data: closedData } = await supabase.from('work_orders_closed').select('wo_id, description, asset_name, priority, status, assigned_to').order('wo_id', { ascending: false })
      const merged = new Map()
      ;(openData || []).forEach(w => merged.set(w.wo_id, w))
      ;(closedData || []).forEach(w => { if (!merged.has(w.wo_id)) merged.set(w.wo_id, w) })
      setWOs(Array.from(merged.values()))
    })()
  }, [])
  return wos
}

// ─── Actions Hook ────────────────────────────────────────────────────────
export function useSOPActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const auditLog = async (action, entityId, details, fieldChanged, oldVal, newVal) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: profile.email, user_name: userName, action,
        entity_type: 'SOP', entity_id: entityId,
        field_changed: fieldChanged || '', old_value: oldVal || '',
        new_value: newVal || '', details: details || '',
      })
    } catch (e) { console.log('Audit log (non-critical):', e) }
  }

  const uploadDoc = async (sopId, file) => {
    const timestamp = Date.now()
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath = `${sopId}/${timestamp}_${sanitizedName}`
    const { error: upErr } = await supabase.storage.from('sop-documents').upload(storagePath, file, { contentType: 'application/pdf', upsert: false })
    if (upErr) throw upErr
    const { data: urlData } = supabase.storage.from('sop-documents').getPublicUrl(storagePath)
    return { url: urlData.publicUrl, name: file.name, path: storagePath }
  }

  const createSOP = async (sopData, file) => {
    setSaving(true)
    try {
      let sopId = `SOP-${Date.now().toString().slice(-6)}`
      try { const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'sop' }); if (counter) sopId = counter } catch {}

      let docUrl = '', docName = '', docPath = ''
      if (file) { const u = await uploadDoc(sopId, file); docUrl = u.url; docName = u.name; docPath = u.path }

      const { data, error } = await supabase.from('sops').insert({
        sop_id: sopId, name: sopData.name.trim(), description: (sopData.description || '').trim(),
        document_url: docUrl, document_name: docName, document_path: docPath,
        created_at: new Date().toISOString(), created_by: userName,
        updated_at: new Date().toISOString(), updated_by: userName, status: 'Active',
      }).select().single()
      if (error) throw error

      await auditLog('Create', sopId, `Created SOP: ${sopData.name}${file ? ` with document: ${file.name}` : ''}`)
      toast.success(`SOP ${sopId} created!`)
      return data
    } catch (err) { console.error('Create SOP error:', err); toast.error(err.message || 'Failed to create SOP'); throw err }
    finally { setSaving(false) }
  }

  const updateSOP = async (sopId, updates) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('sops').update({ ...updates, updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', sopId)
      if (error) throw error
      await auditLog('Update', sopId, `Updated SOP`)
      toast.success('SOP updated!')
    } catch (err) { console.error('Update SOP error:', err); toast.error(err.message || 'Failed to update SOP'); throw err }
    finally { setSaving(false) }
  }

  const deleteSOP = async (sopId, sopName, documentPath) => {
    setSaving(true)
    try {
      if (documentPath) { try { await supabase.storage.from('sop-documents').remove([documentPath]) } catch {} }
      await supabase.from('sop_assets').delete().eq('sop_id', sopId)
      await supabase.from('sop_pm_schedules').delete().eq('sop_id', sopId)
      await supabase.from('sop_work_orders').delete().eq('sop_id', sopId)
      const { error } = await supabase.from('sops').delete().eq('sop_id', sopId)
      if (error) throw error
      await auditLog('Delete', sopId, `Deleted SOP: ${sopName}`)
      toast.success('SOP deleted!')
    } catch (err) { console.error('Delete SOP error:', err); toast.error(err.message || 'Failed to delete SOP'); throw err }
    finally { setSaving(false) }
  }

  const replaceDocument = async (sopId, oldPath, newFile) => {
    setSaving(true)
    try {
      if (oldPath) { try { await supabase.storage.from('sop-documents').remove([oldPath]) } catch {} }
      const upload = await uploadDoc(sopId, newFile)
      const { error } = await supabase.from('sops').update({ document_url: upload.url, document_name: upload.name, document_path: upload.path, updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', sopId)
      if (error) throw error
      await auditLog('Replace Document', sopId, `Replaced document with: ${newFile.name}`, 'document')
      toast.success('Document replaced!')
      return upload
    } catch (err) { console.error('Replace document error:', err); toast.error(err.message || 'Failed to replace document'); throw err }
    finally { setSaving(false) }
  }

  const deleteDocument = async (sopId, documentPath) => {
    setSaving(true)
    try {
      if (documentPath) { try { await supabase.storage.from('sop-documents').remove([documentPath]) } catch {} }
      const { error } = await supabase.from('sops').update({ document_url: '', document_name: '', document_path: '', updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', sopId)
      if (error) throw error
      await auditLog('Delete Document', sopId, `Deleted SOP document`, 'document')
      toast.success('Document deleted!')
    } catch (err) { console.error('Delete document error:', err); toast.error(err.message || 'Failed to delete document'); throw err }
    finally { setSaving(false) }
  }

  // ── Link / Unlink ──
  const linkAssets = async (sopId, assetIds) => {
    try {
      const { error } = await supabase.from('sop_assets').insert(assetIds.map(id => ({ sop_id: sopId, asset_id: id })))
      if (error) throw error
      await auditLog('Link Assets', sopId, `Linked ${assetIds.length} asset(s): ${assetIds.join(', ')}`, 'linked_assets')
    } catch (err) { toast.error(err.message || 'Failed to link assets'); throw err }
  }
  const unlinkAsset = async (sopId, assetId) => {
    try {
      const { error } = await supabase.from('sop_assets').delete().eq('sop_id', sopId).eq('asset_id', assetId)
      if (error) throw error
      await auditLog('Unlink Asset', sopId, `Unlinked asset: ${assetId}`, 'linked_assets')
    } catch (err) { toast.error(err.message || 'Failed to unlink asset'); throw err }
  }

  const linkPMs = async (sopId, pmIds) => {
    try {
      const { error } = await supabase.from('sop_pm_schedules').insert(pmIds.map(id => ({ sop_id: sopId, pm_id: id })))
      if (error) throw error
      await auditLog('Link PMs', sopId, `Linked ${pmIds.length} PM(s): ${pmIds.join(', ')}`, 'linked_pms')
    } catch (err) { toast.error(err.message || 'Failed to link PMs'); throw err }
  }
  const unlinkPM = async (sopId, pmId) => {
    try {
      const { error } = await supabase.from('sop_pm_schedules').delete().eq('sop_id', sopId).eq('pm_id', pmId)
      if (error) throw error
      await auditLog('Unlink PM', sopId, `Unlinked PM: ${pmId}`, 'linked_pms')
    } catch (err) { toast.error(err.message || 'Failed to unlink PM'); throw err }
  }

  const linkWOs = async (sopId, woIds) => {
    try {
      const { error } = await supabase.from('sop_work_orders').insert(woIds.map(id => ({ sop_id: sopId, wo_id: id })))
      if (error) throw error
      await auditLog('Link WOs', sopId, `Linked ${woIds.length} WO(s): ${woIds.join(', ')}`, 'linked_wos')
    } catch (err) { toast.error(err.message || 'Failed to link work orders'); throw err }
  }
  const unlinkWO = async (sopId, woId) => {
    try {
      const { error } = await supabase.from('sop_work_orders').delete().eq('sop_id', sopId).eq('wo_id', woId)
      if (error) throw error
      await auditLog('Unlink WO', sopId, `Unlinked WO: ${woId}`, 'linked_wos')
    } catch (err) { toast.error(err.message || 'Failed to unlink work order'); throw err }
  }

  return {
    saving, createSOP, updateSOP, deleteSOP,
    replaceDocument, deleteDocument,
    linkAssets, unlinkAsset, linkPMs, unlinkPM, linkWOs, unlinkWO,
  }
}
