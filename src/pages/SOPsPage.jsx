/**
 * RICT CMMS — SOPs (Standard Operating Procedures) Page
 *
 * Features:
 *  - Search bar that searches name, description, document_name, sop_id — highlights matches
 *  - Card grid with SOP name, description preview, document badge, linked-item counts, metadata
 *  - Permission-gated: view_page, create_sop, edit_sop, delete_sop,
 *    upload_document, replace_document, delete_document, link_items
 *  - View SOP modal: full detail, linked Assets / PMs / WOs, inline PDF viewer, print button
 *  - Link picker modals: multi-select assets, PMs, work orders with search
 *  - Create / Edit / Delete modals with confirmation dialogs
 *  - Document management: upload, replace, delete (each permission-gated)
 *  - Print: opens PDF in new tab for native browser printing
 *  - Real-time updates via Supabase subscription
 *  - Audit logging for all actions
 *
 * FIX (v3.1): Replaced inline permission system with usePermissions('SOPs') so that
 *             temp permission grants (e.g. SOPs: create_sop) are respected correctly.
 *
 * Supabase tables: sops, sop_assets, sop_pm_schedules, sop_work_orders
 * Supabase storage bucket: sop-documents
 * Permission page key: 'SOPs'
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Search Highlight ────────────────────────────────────────────────────
function HL({ text, q }) {
  if (!q || !text) return <>{text || ''}</>
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = String(text).split(regex)
  return <>{parts.map((p, i) => regex.test(p) ? <mark key={i} style={{ background: '#fff3bf', color: '#495057', padding: '0 2px', borderRadius: 2 }}>{p}</mark> : <span key={i}>{p}</span>)}</>
}

// ─── Linked count badges for cards ───────────────────────────────────────
function useLinkCounts(sops) {
  const [counts, setCounts] = useState({})
  useEffect(() => {
    if (!sops.length) return
    ;(async () => {
      try {
        const ids = sops.map(s => s.sop_id)
        const [{ data: a }, { data: p }, { data: w }] = await Promise.all([
          supabase.from('sop_assets').select('sop_id').in('sop_id', ids),
          supabase.from('sop_pm_schedules').select('sop_id').in('sop_id', ids),
          supabase.from('sop_work_orders').select('sop_id').in('sop_id', ids),
        ])
        const c = {}
        ids.forEach(id => { c[id] = { assets: 0, pms: 0, wos: 0 } })
        ;(a || []).forEach(r => { if (c[r.sop_id]) c[r.sop_id].assets++ })
        ;(p || []).forEach(r => { if (c[r.sop_id]) c[r.sop_id].pms++ })
        ;(w || []).forEach(r => { if (c[r.sop_id]) c[r.sop_id].wos++ })
        setCounts(c)
      } catch {}
    })()
  }, [sops])
  return counts
}

export default function SOPsPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── FIXED: Use the shared usePermissions hook so temp permission grants are respected ──
  const { hasPerm, permsLoading } = usePermissions('SOPs')

  const [sops, setSOPs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // Asset filter (from ?asset= URL param)
  const [assetFilter, setAssetFilter] = useState(null)      // { asset_id, name }
  const [assetFilterSopIds, setAssetFilterSopIds] = useState(null) // Set<sop_id> | null

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showViewModal, setShowViewModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDeleteDocConfirm, setShowDeleteDocConfirm] = useState(false)
  const [showReplaceModal, setShowReplaceModal] = useState(false)
  const [showLinkModal, setShowLinkModal] = useState(null) // 'assets' | 'pms' | 'wos' | null

  // Form
  const [formData, setFormData] = useState({ name: '', description: '' })
  const [selectedFile, setSelectedFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [selectedSOP, setSelectedSOP] = useState(null)

  // Linked items for selected SOP
  const [linkedAssets, setLinkedAssets] = useState([])
  const [linkedPMs, setLinkedPMs] = useState([])
  const [linkedWOs, setLinkedWOs] = useState([])
  const [linksLoading, setLinksLoading] = useState(false)

  // Available items for link pickers
  const [allAssets, setAllAssets] = useState([])
  const [allPMs, setAllPMs] = useState([])
  const [allWOs, setAllWOs] = useState([])
  const [linkSearch, setLinkSearch] = useState('')
  const [linkSelected, setLinkSelected] = useState({})

  const fileInputRef = useRef(null)
  const replaceFileRef = useRef(null)
  const uploadFileRef = useRef(null)
  const templateFileRef = useRef(null)

  // ── SOP Template state ──
  const [templateUrl, setTemplateUrl] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [templateFile, setTemplateFile] = useState(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const [showManageTemplate, setShowManageTemplate] = useState(false)
  const [showRemoveTemplateConfirm, setShowRemoveTemplateConfirm] = useState(false)
  const [templateDragging, setTemplateDragging] = useState(false)
  const [templateError, setTemplateError] = useState('')

  const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : 'Unknown'

  // Link counts for card badges
  const linkCounts = useLinkCounts(sops)

  // ── Fetch SOPs ──
  const fetchSOPs = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('sops').select('*').order('name', { ascending: true })
      if (error) throw error
      setSOPs(data || [])
    } catch (err) { console.error('Error fetching SOPs:', err) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchSOPs() }, [fetchSOPs])

  // ── Fetch SOP Template settings ──
  const fetchTemplate = useCallback(async () => {
    try {
      const { data } = await supabase.from('settings').select('setting_key, setting_value').in('setting_key', ['sop_template_url', 'sop_template_name'])
      if (data) {
        const url = data.find(r => r.setting_key === 'sop_template_url')?.setting_value || ''
        const name = data.find(r => r.setting_key === 'sop_template_name')?.setting_value || ''
        setTemplateUrl(url)
        setTemplateName(name)
      }
    } catch {}
  }, [])

  useEffect(() => { fetchTemplate() }, [fetchTemplate])

  useEffect(() => {
    const ch = supabase.channel('sops-page').on('postgres_changes', { event: '*', schema: 'public', table: 'sops' }, () => fetchSOPs()).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [fetchSOPs])

  useEffect(() => {
    const h = () => { if (document.visibilityState === 'visible') fetchSOPs() }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [fetchSOPs])

  // ── Handle ?asset= URL param — filter SOPs to those linked to an asset ──
  useEffect(() => {
    const assetId = searchParams.get('asset')
    if (!assetId) {
      setAssetFilter(null)
      setAssetFilterSopIds(null)
      return
    }
    ;(async () => {
      try {
        const [{ data: assetData }, { data: links }] = await Promise.all([
          supabase.from('assets').select('asset_id, name').eq('asset_id', assetId).single(),
          supabase.from('sop_assets').select('sop_id').eq('asset_id', assetId),
        ])
        setAssetFilter(assetData || { asset_id: assetId, name: assetId })
        setAssetFilterSopIds(new Set((links || []).map(r => r.sop_id)))
      } catch {
        setAssetFilter(null)
        setAssetFilterSopIds(null)
      }
    })()
  }, [searchParams])

  // ── Handle ?open= URL param — auto-open a specific SOP's view modal ──
  useEffect(() => {
    const sopId = searchParams.get('open')
    if (!sopId || !sops.length) return
    const sop = sops.find(s => s.sop_id === sopId)
    if (sop) {
      setSelectedSOP(sop)
      setShowViewModal(true)
      fetchLinks(sop.sop_id)
      // Strip the param so back-navigation works cleanly
      setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('open'); return next }, { replace: true })
    }
  }, [searchParams, sops])

  // ── Fetch Links for selected SOP ──
  const fetchLinks = useCallback(async (sopId) => {
    if (!sopId) return
    setLinksLoading(true)
    try {
      const { data: aL } = await supabase.from('sop_assets').select('asset_id').eq('sop_id', sopId)
      const { data: pL } = await supabase.from('sop_pm_schedules').select('pm_id').eq('sop_id', sopId)
      const { data: wL } = await supabase.from('sop_work_orders').select('wo_id').eq('sop_id', sopId)

      const aIds = (aL || []).map(r => r.asset_id)
      const pIds = (pL || []).map(r => r.pm_id)
      const wIds = (wL || []).map(r => r.wo_id)

      if (aIds.length) { const { data } = await supabase.from('assets').select('asset_id, name, category, location, status').in('asset_id', aIds).order('name'); setLinkedAssets(data || []) } else setLinkedAssets([])
      if (pIds.length) { const { data } = await supabase.from('pm_schedules').select('pm_id, pm_name, asset_name, frequency, next_due_date, status').in('pm_id', pIds).order('pm_name'); setLinkedPMs(data || []) } else setLinkedPMs([])
      if (wIds.length) {
        const { data: od } = await supabase.from('work_orders').select('wo_id, description, asset_name, priority, status, assigned_to').in('wo_id', wIds)
        const { data: cd } = await supabase.from('work_orders_closed').select('wo_id, description, asset_name, priority, status, assigned_to').in('wo_id', wIds)
        const m = new Map(); (od || []).forEach(w => m.set(w.wo_id, w)); (cd || []).forEach(w => { if (!m.has(w.wo_id)) m.set(w.wo_id, w) })
        setLinkedWOs(Array.from(m.values()))
      } else setLinkedWOs([])
    } catch (err) { console.error('Error fetching SOP links:', err) }
    finally { setLinksLoading(false) }
  }, [])

  // ── Load available items for link picker ──
  const loadAvailable = useCallback(async (type) => {
    try {
      if (type === 'assets') { const { data } = await supabase.from('assets').select('asset_id, name, category, location, status').order('name'); setAllAssets(data || []) }
      if (type === 'pms') { const { data } = await supabase.from('pm_schedules').select('pm_id, pm_name, asset_name, frequency, status').order('pm_name'); setAllPMs(data || []) }
      if (type === 'wos') {
        const { data: od } = await supabase.from('work_orders').select('wo_id, description, asset_name, priority, status, assigned_to').order('wo_id', { ascending: false })
        const { data: cd } = await supabase.from('work_orders_closed').select('wo_id, description, asset_name, priority, status, assigned_to').order('wo_id', { ascending: false })
        const m = new Map(); (od || []).forEach(w => m.set(w.wo_id, w)); (cd || []).forEach(w => { if (!m.has(w.wo_id)) m.set(w.wo_id, w) })
        setAllWOs(Array.from(m.values()))
      }
    } catch {}
  }, [])

  // ── Filtered SOPs ──
  const filtered = useMemo(() => {
    let list = sops
    // Apply asset filter first (from ?asset= URL param)
    if (assetFilterSopIds !== null) {
      list = list.filter(s => assetFilterSopIds.has(s.sop_id))
    }
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.document_name || '').toLowerCase().includes(q) ||
      (s.sop_id || '').toLowerCase().includes(q) ||
      (s.created_by || '').toLowerCase().includes(q)
    )
  }, [sops, search, assetFilterSopIds])

  // ── Helpers ──
  const genId = async () => { try { const { data } = await supabase.rpc('get_next_id', { p_type: 'sop' }); if (data) return data } catch {}; return `SOP-${Date.now().toString().slice(-6)}` }
  const uploadDoc = async (sopId, file) => {
    const path = `${sopId}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error } = await supabase.storage.from('sop-documents').upload(path, file, { contentType: 'application/pdf', upsert: false })
    if (error) throw error
    const { data } = supabase.storage.from('sop-documents').getPublicUrl(path)
    return { url: data.publicUrl, name: file.name, path }
  }
  const auditLog = async (action, entityId, details) => {
    try { await supabase.from('audit_log').insert({ user_email: profile.email, user_name: userName, action, entity_type: 'SOP', entity_id: entityId, details }) } catch {}
  }

  // ── Template Handlers ──
  const handleUploadTemplate = async () => {
    if (!templateFile) return
    setTemplateUploading(true)
    setTemplateError('')
    try {
      // Remove old file from storage if one exists
      if (templateUrl) {
        try {
          const oldPath = templateUrl.split('/templates/')[1]
          if (oldPath) await supabase.storage.from('templates').remove([oldPath])
        } catch {}
      }
      const safeName = templateFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `_template/${Date.now()}_${safeName}`
      // Use octet-stream so bucket MIME restrictions don't block .docx/.doc files
      const { error: upErr } = await supabase.storage.from('templates').upload(path, templateFile, { contentType: 'application/octet-stream', upsert: false })
      if (upErr) throw upErr
      const { data: urlData } = supabase.storage.from('templates').getPublicUrl(path)
      const publicUrl = urlData.publicUrl
      // Use UPDATE since both rows are guaranteed to exist (inserted via SQL migration)
      const now = new Date().toISOString()
      await supabase.from('settings').update({ setting_value: publicUrl, updated_at: now, updated_by: userName }).eq('setting_key', 'sop_template_url').select()
      await supabase.from('settings').update({ setting_value: templateFile.name, updated_at: now, updated_by: userName }).eq('setting_key', 'sop_template_name').select()
      await auditLog('Upload SOP Template', 'TEMPLATE', `Uploaded SOP template: ${templateFile.name}`)
      setTemplateUrl(publicUrl)
      setTemplateName(templateFile.name)
      setTemplateFile(null)
      if (templateFileRef.current) templateFileRef.current.value = ''
      setShowManageTemplate(false)
    } catch (err) { setTemplateError(err.message || 'Failed to upload template. Please try again.') }
    setTemplateUploading(false)
  }

  const handleRemoveTemplate = async () => {
    setTemplateUploading(true)
    setTemplateError('')
    try {
      if (templateUrl) {
        try {
          const oldPath = templateUrl.split('/templates/')[1]
          if (oldPath) await supabase.storage.from('templates').remove([oldPath])
        } catch {}
      }
      const now = new Date().toISOString()
      await supabase.from('settings').update({ setting_value: '', updated_at: now, updated_by: userName }).eq('setting_key', 'sop_template_url').select()
      await supabase.from('settings').update({ setting_value: '', updated_at: now, updated_by: userName }).eq('setting_key', 'sop_template_name').select()
      await auditLog('Remove SOP Template', 'TEMPLATE', 'Removed SOP template file')
      setTemplateUrl('')
      setTemplateName('')
      setShowRemoveTemplateConfirm(false)
      setShowManageTemplate(false)
    } catch (err) { setTemplateError(err.message || 'Failed to remove template. Please try again.') }
    setTemplateUploading(false)
  }
  const handleCreate = async () => {
    if (!formData.name.trim()) return alert('Please enter a name.')
    if (selectedFile && selectedFile.type !== 'application/pdf') return alert('Only PDF files are allowed.')
    setSaving(true)
    try {
      const sopId = await genId()
      let d = { url: '', name: '', path: '' }
      if (selectedFile) d = await uploadDoc(sopId, selectedFile)
      const { error } = await supabase.from('sops').insert({
        sop_id: sopId, name: formData.name.trim(), description: (formData.description || '').trim(),
        document_url: d.url, document_name: d.name, document_path: d.path,
        created_at: new Date().toISOString(), created_by: userName,
        updated_at: new Date().toISOString(), updated_by: userName, status: 'Active',
      })
      if (error) throw error
      await auditLog('Create', sopId, `Created SOP: ${formData.name}${selectedFile ? ` with doc: ${selectedFile.name}` : ''}`)
      setShowCreateModal(false); setFormData({ name: '', description: '' }); setSelectedFile(null)
      fetchSOPs()
    } catch (err) { alert('Error: ' + (err.message || 'Failed to create SOP')) }
    setSaving(false)
  }

  const handleEdit = async () => {
    if (!formData.name.trim()) return alert('Please enter a name.')
    setSaving(true)
    try {
      const { error } = await supabase.from('sops').update({ name: formData.name.trim(), description: (formData.description || '').trim(), updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', selectedSOP.sop_id)
      if (error) throw error
      await auditLog('Update', selectedSOP.sop_id, `Updated SOP: ${formData.name}`)
      setSelectedSOP(prev => ({ ...prev, name: formData.name.trim(), description: (formData.description || '').trim(), updated_at: new Date().toISOString(), updated_by: userName }))
      setShowEditModal(false); fetchSOPs()
    } catch (err) { alert('Error: ' + (err.message || 'Failed to update SOP')) }
    setSaving(false)
  }

  const handleDelete = async () => {
    setSaving(true)
    try {
      if (selectedSOP.document_path) { try { await supabase.storage.from('sop-documents').remove([selectedSOP.document_path]) } catch {} }
      await supabase.from('sop_assets').delete().eq('sop_id', selectedSOP.sop_id)
      await supabase.from('sop_pm_schedules').delete().eq('sop_id', selectedSOP.sop_id)
      await supabase.from('sop_work_orders').delete().eq('sop_id', selectedSOP.sop_id)
      const { error } = await supabase.from('sops').delete().eq('sop_id', selectedSOP.sop_id)
      if (error) throw error
      await auditLog('Delete', selectedSOP.sop_id, `Deleted SOP: ${selectedSOP.name}`)
      setShowDeleteConfirm(false); setShowViewModal(false); setSelectedSOP(null); fetchSOPs()
    } catch (err) { alert('Error: ' + (err.message || 'Failed to delete SOP')) }
    setSaving(false)
  }

  const handleReplaceDoc = async () => {
    if (!selectedFile || selectedFile.type !== 'application/pdf') return alert('Please select a PDF file.')
    setSaving(true)
    try {
      if (selectedSOP.document_path) { try { await supabase.storage.from('sop-documents').remove([selectedSOP.document_path]) } catch {} }
      const u = await uploadDoc(selectedSOP.sop_id, selectedFile)
      const { error } = await supabase.from('sops').update({ document_url: u.url, document_name: u.name, document_path: u.path, updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', selectedSOP.sop_id)
      if (error) throw error
      await auditLog('Replace Document', selectedSOP.sop_id, `Replaced document with: ${selectedFile.name}`)
      setSelectedSOP(prev => ({ ...prev, document_url: u.url, document_name: u.name, document_path: u.path, updated_at: new Date().toISOString(), updated_by: userName }))
      setShowReplaceModal(false); setSelectedFile(null); fetchSOPs()
    } catch (err) { alert('Error: ' + (err.message || 'Failed to replace document')) }
    setSaving(false)
  }

  const handleUploadDoc = async () => {
    if (!selectedFile || selectedFile.type !== 'application/pdf') return alert('Please select a PDF file.')
    setSaving(true)
    try {
      const u = await uploadDoc(selectedSOP.sop_id, selectedFile)
      const { error } = await supabase.from('sops').update({ document_url: u.url, document_name: u.name, document_path: u.path, updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', selectedSOP.sop_id)
      if (error) throw error
      await auditLog('Upload Document', selectedSOP.sop_id, `Uploaded document: ${selectedFile.name}`)
      setSelectedSOP(prev => ({ ...prev, document_url: u.url, document_name: u.name, document_path: u.path }))
      setSelectedFile(null); fetchSOPs()
    } catch (err) { alert('Error: ' + (err.message || 'Failed to upload document')) }
    setSaving(false)
  }

  const handleDeleteDoc = async () => {
    setSaving(true)
    try {
      if (selectedSOP.document_path) { try { await supabase.storage.from('sop-documents').remove([selectedSOP.document_path]) } catch {} }
      const { error } = await supabase.from('sops').update({ document_url: '', document_name: '', document_path: '', updated_at: new Date().toISOString(), updated_by: userName }).eq('sop_id', selectedSOP.sop_id)
      if (error) throw error
      await auditLog('Delete Document', selectedSOP.sop_id, 'Deleted SOP document')
      setSelectedSOP(prev => ({ ...prev, document_url: '', document_name: '', document_path: '' }))
      setShowDeleteDocConfirm(false); fetchSOPs()
    } catch (err) { alert('Error: ' + (err.message || 'Failed to delete document')) }
    setSaving(false)
  }

  // ── Link Handlers ──
  const openLinkModal = async (type) => {
    setLinkSearch(''); setLinkSelected({})
    await loadAvailable(type)
    setShowLinkModal(type)
  }

  const handleSaveLinks = async () => {
    const ids = Object.keys(linkSelected).filter(k => linkSelected[k])
    if (!ids.length) return
    setSaving(true)
    try {
      const sopId = selectedSOP.sop_id
      if (showLinkModal === 'assets') {
        const { error } = await supabase.from('sop_assets').insert(ids.map(id => ({ sop_id: sopId, asset_id: id })))
        if (error) throw error
        await auditLog('Link Assets', sopId, `Linked ${ids.length} asset(s)`)
      } else if (showLinkModal === 'pms') {
        const { error } = await supabase.from('sop_pm_schedules').insert(ids.map(id => ({ sop_id: sopId, pm_id: id })))
        if (error) throw error
        await auditLog('Link PMs', sopId, `Linked ${ids.length} PM(s)`)
      } else if (showLinkModal === 'wos') {
        const { error } = await supabase.from('sop_work_orders').insert(ids.map(id => ({ sop_id: sopId, wo_id: id })))
        if (error) throw error
        await auditLog('Link WOs', sopId, `Linked ${ids.length} WO(s)`)
      }
      setShowLinkModal(null)
      fetchLinks(sopId)
    } catch (err) { alert('Error: ' + (err.message || 'Failed to link items')) }
    setSaving(false)
  }

  const handleUnlink = async (type, itemId) => {
    const sopId = selectedSOP.sop_id
    try {
      if (type === 'asset') { await supabase.from('sop_assets').delete().eq('sop_id', sopId).eq('asset_id', itemId) }
      else if (type === 'pm') { await supabase.from('sop_pm_schedules').delete().eq('sop_id', sopId).eq('pm_id', itemId) }
      else if (type === 'wo') { await supabase.from('sop_work_orders').delete().eq('sop_id', sopId).eq('wo_id', itemId) }
      fetchLinks(sopId)
    } catch (err) { alert('Error: ' + (err.message || 'Failed to unlink')) }
  }

  // ── Print Handler ──
  const handlePrint = () => {
    if (!selectedSOP?.document_url) return
    const printWindow = window.open(selectedSOP.document_url, '_blank')
    if (printWindow) {
      printWindow.addEventListener('load', () => { printWindow.print() })
    }
  }

  // ── Material Icons ──
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const l = document.createElement('link'); l.href = 'https://fonts.googleapis.com/icon?family=Material+Icons'; l.rel = 'stylesheet'; document.head.appendChild(l)
    }
  }, [])

  // ── Items available for link picker (filter out already linked) ──
  const linkPickerItems = useMemo(() => {
    const q = linkSearch.toLowerCase()
    if (showLinkModal === 'assets') {
      const linked = new Set(linkedAssets.map(a => a.asset_id))
      return allAssets.filter(a => !linked.has(a.asset_id)).filter(a => !q || (a.name || '').toLowerCase().includes(q) || (a.asset_id || '').toLowerCase().includes(q) || (a.category || '').toLowerCase().includes(q) || (a.location || '').toLowerCase().includes(q))
    }
    if (showLinkModal === 'pms') {
      const linked = new Set(linkedPMs.map(p => p.pm_id))
      return allPMs.filter(p => !linked.has(p.pm_id)).filter(p => !q || (p.pm_name || '').toLowerCase().includes(q) || (p.pm_id || '').toLowerCase().includes(q) || (p.asset_name || '').toLowerCase().includes(q))
    }
    if (showLinkModal === 'wos') {
      const linked = new Set(linkedWOs.map(w => w.wo_id))
      return allWOs.filter(w => !linked.has(w.wo_id)).filter(w => !q || (w.description || '').toLowerCase().includes(q) || (w.wo_id || '').toLowerCase().includes(q) || (w.asset_name || '').toLowerCase().includes(q) || (w.assigned_to || '').toLowerCase().includes(q))
    }
    return []
  }, [showLinkModal, linkSearch, allAssets, allPMs, allWOs, linkedAssets, linkedPMs, linkedWOs])

  // ── No Access ──
  if (!permsLoading && !loading && !hasPerm('view_page')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#868e96' }}>
        <span className="material-icons" style={{ fontSize: 48, marginBottom: 12, display: 'block' }}>lock</span>
        <h3 style={{ margin: 0 }}>Access Denied</h3>
        <p>You don't have permission to view this page.</p>
      </div>
    )
  }

  // ═════════════════════════════ RENDER ═══════════════════════════════════
  return (
    <div className="sops-root">
      {/* ── Header ── */}
      <div className="sops-header">
        <div className="sops-header-left">
          <span className="material-icons sops-header-icon">description</span>
          <div>
            <h2 className="sops-title">Standard Operating Procedures</h2>
            <p className="sops-subtitle">{loading ? 'Loading...' : `${filtered.length} SOP${filtered.length !== 1 ? 's' : ''}${search ? ' found' : ''}`}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {hasPerm('download_template') && templateUrl && (
            <a
              href={templateUrl}
              download={templateName || 'SOP_Template.docx'}
              className="sops-btn-outline"
              style={{ textDecoration: 'none' }}
              title="Download the blank SOP template"
            >
              <span className="material-icons" style={{ fontSize: 17 }}>download</span>
              SOP Template
            </a>
          )}
          {hasPerm('manage_template') && (
            <button
              className="sops-btn-sm"
              onClick={() => { setTemplateFile(null); setTemplateError(''); setShowManageTemplate(true) }}
              title="Upload or replace the SOP template"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span className="material-icons" style={{ fontSize: 15 }}>settings</span>
              Template
            </button>
          )}
          {hasPerm('create_sop') && (
            <button className="sops-btn-primary" onClick={() => { setFormData({ name: '', description: '' }); setSelectedFile(null); setShowCreateModal(true) }}>
              <span className="material-icons" style={{ fontSize: 18 }}>add</span> New SOP
            </button>
          )}
        </div>
      </div>

      {/* ── Search ── */}
      <div className="sops-search-wrap">
        <span className="material-icons sops-search-icon">search</span>
        <input className="sops-search-input" type="text" placeholder="Search SOPs by name, description, document, or ID..." value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button className="sops-search-clear" onClick={() => setSearch('')}><span className="material-icons" style={{ fontSize: 18 }}>close</span></button>}
      </div>

      {/* ── Asset filter banner ── */}
      {assetFilter && (
        <div className="sops-asset-filter-banner">
          <span className="material-icons" style={{ fontSize: 18, color: '#1971c2' }}>precision_manufacturing</span>
          <span>
            Showing SOPs linked to <strong>{assetFilter.name}</strong>
            <span style={{ color: '#868e96', fontSize: '0.85rem', marginLeft: 6 }}>({assetFilter.asset_id})</span>
          </span>
          <button
            className="sops-asset-filter-clear"
            onClick={() => {
              setSearchParams({}, { replace: true })
              setAssetFilter(null)
              setAssetFilterSopIds(null)
            }}
            title="Clear filter"
          >
            <span className="material-icons" style={{ fontSize: 16 }}>close</span>
            Clear filter
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {(loading || permsLoading) && <div style={{ textAlign: 'center', padding: 60, color: '#868e96' }}><span className="material-icons" style={{ fontSize: 36, animation: 'spin 1s linear infinite' }}>sync</span><p style={{ marginTop: 12 }}>Loading SOPs...</p></div>}

      {/* ── Empty ── */}
      {!loading && !permsLoading && filtered.length === 0 && (
        <div className="sops-empty">
          <span className="material-icons" style={{ fontSize: 48, color: '#dee2e6', marginBottom: 12 }}>
            {assetFilter ? 'link_off' : search ? 'search_off' : 'description'}
          </span>
          <h3 style={{ margin: '0 0 4px', color: '#495057' }}>
            {assetFilter
              ? `No SOPs linked to ${assetFilter.name}`
              : search ? 'No SOPs match your search' : 'No SOPs yet'}
          </h3>
          <p style={{ margin: 0, color: '#868e96', fontSize: '0.88rem' }}>
            {assetFilter
              ? 'No SOPs have been linked to this asset yet. Open an SOP and use "Link Assets" to connect one.'
              : search ? 'Try different keywords or clear your search.'
              : hasPerm('create_sop') ? 'Click "New SOP" to create your first procedure.' : 'No standard operating procedures have been created yet.'}
          </p>
        </div>
      )}

      {/* ── Card Grid ── */}
      {!loading && !permsLoading && filtered.length > 0 && (
        <div className="sops-grid">
          {filtered.map(sop => {
            const hasDoc = !!(sop.document_url && sop.document_url.length > 0)
            const lc = linkCounts[sop.sop_id] || { assets: 0, pms: 0, wos: 0 }
            const totalLinks = lc.assets + lc.pms + lc.wos
            return (
              <div key={sop.sop_id} className="sops-card" onClick={() => { setSelectedSOP(sop); setShowViewModal(true); fetchLinks(sop.sop_id) }}>
                <div className="sops-card-top">
                  <div className={`sops-card-doc-badge ${hasDoc ? 'has-doc' : 'no-doc'}`}>
                    <span className="material-icons" style={{ fontSize: 16 }}>{hasDoc ? 'picture_as_pdf' : 'note_add'}</span>
                    {hasDoc ? 'PDF' : 'No Doc'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {totalLinks > 0 && (
                      <span className="sops-card-links-badge">
                        <span className="material-icons" style={{ fontSize: 12 }}>link</span> {totalLinks}
                      </span>
                    )}
                    <span className="sops-card-id">{sop.sop_id}</span>
                  </div>
                </div>
                <h3 className="sops-card-name"><HL text={sop.name} q={search} /></h3>
                {sop.description && <p className="sops-card-desc"><HL text={sop.description.length > 120 ? sop.description.slice(0, 120) + '...' : sop.description} q={search} /></p>}
                {search && hasDoc && (sop.document_name || '').toLowerCase().includes(search.toLowerCase()) && (
                  <p className="sops-card-doc-name"><span className="material-icons" style={{ fontSize: 14, verticalAlign: -2 }}>attach_file</span> <HL text={sop.document_name} q={search} /></p>
                )}
                <div className="sops-card-footer">
                  <span className="sops-card-meta"><span className="material-icons" style={{ fontSize: 14, verticalAlign: -2 }}>person</span> <HL text={sop.created_by || '—'} q={search} /></span>
                  <span className="sops-card-meta">{fmtDate(sop.updated_at || sop.created_at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ═══════════════════════════ VIEW MODAL ═══════════════════════════════ */}
      {showViewModal && selectedSOP && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && (setShowViewModal(false), setSelectedSOP(null))}>
          <div className="sops-modal sops-modal-lg">
            <div className="sops-modal-header">
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem' }}>
                <span className="material-icons" style={{ color: '#228be6' }}>description</span>
                {selectedSOP.name}
              </h4>
              <button className="sops-modal-close" onClick={() => { setShowViewModal(false); setSelectedSOP(null) }}>&times;</button>
            </div>
            <div className="sops-modal-body" style={{ padding: 0 }}>
              {/* Detail */}
              <div style={{ padding: 20 }}>
                <div className="sops-detail-grid">
                  <div className="sops-detail-row"><span className="sops-detail-label">SOP ID</span><span className="sops-detail-value">{selectedSOP.sop_id}</span></div>
                  <div className="sops-detail-row"><span className="sops-detail-label">Name</span><span className="sops-detail-value">{selectedSOP.name}</span></div>
                  {selectedSOP.description && <div className="sops-detail-row" style={{ gridColumn: '1 / -1' }}><span className="sops-detail-label">Description</span><span className="sops-detail-value" style={{ whiteSpace: 'pre-wrap' }}>{selectedSOP.description}</span></div>}
                  <div className="sops-detail-row"><span className="sops-detail-label">Created By</span><span className="sops-detail-value">{selectedSOP.created_by || '—'}</span></div>
                  <div className="sops-detail-row"><span className="sops-detail-label">Created</span><span className="sops-detail-value">{fmtDate(selectedSOP.created_at)}</span></div>
                  <div className="sops-detail-row"><span className="sops-detail-label">Last Updated</span><span className="sops-detail-value">{fmtDate(selectedSOP.updated_at)}</span></div>
                  <div className="sops-detail-row"><span className="sops-detail-label">Updated By</span><span className="sops-detail-value">{selectedSOP.updated_by || '—'}</span></div>
                </div>
                <div className="sops-view-actions">
                  {hasPerm('edit_sop') && <button className="sops-btn-outline" onClick={() => { setFormData({ name: selectedSOP.name, description: selectedSOP.description || '' }); setShowEditModal(true) }}><span className="material-icons" style={{ fontSize: 16 }}>edit</span> Edit</button>}
                  {selectedSOP.document_url && <button className="sops-btn-outline" onClick={handlePrint}><span className="material-icons" style={{ fontSize: 16 }}>print</span> Print</button>}
                  {hasPerm('delete_sop') && <button className="sops-btn-danger-outline" onClick={() => setShowDeleteConfirm(true)}><span className="material-icons" style={{ fontSize: 16 }}>delete</span> Delete SOP</button>}
                </div>
              </div>

              {/* ── Linked Assets ── */}
              <div className="sops-link-section">
                <div className="sops-link-section-header">
                  <h5 className="sops-link-section-title"><span className="material-icons" style={{ fontSize: 18, color: '#228be6' }}>precision_manufacturing</span> Linked Assets ({linkedAssets.length})</h5>
                  {hasPerm('link_items') && <button className="sops-btn-sm" onClick={() => openLinkModal('assets')}><span className="material-icons" style={{ fontSize: 14 }}>add_link</span> Link Assets</button>}
                </div>
                {linksLoading ? <p className="sops-link-empty">Loading...</p> : linkedAssets.length === 0 ? <p className="sops-link-empty">No assets linked to this SOP.</p> : (
                  <div className="sops-link-list">
                    {linkedAssets.map(a => (
                      <div key={a.asset_id} className="sops-link-item">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="sops-link-item-name">{a.name}</div>
                          <div className="sops-link-item-sub">{a.asset_id}{a.category ? ` · ${a.category}` : ''}{a.location ? ` · ${a.location}` : ''}</div>
                        </div>
                        {hasPerm('link_items') && <button className="sops-btn-icon" onClick={() => handleUnlink('asset', a.asset_id)} title="Unlink"><span className="material-icons" style={{ fontSize: 16, color: '#fa5252' }}>link_off</span></button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Linked PMs ── */}
              <div className="sops-link-section">
                <div className="sops-link-section-header">
                  <h5 className="sops-link-section-title"><span className="material-icons" style={{ fontSize: 18, color: '#40c057' }}>event_repeat</span> Linked PM Schedules ({linkedPMs.length})</h5>
                  {hasPerm('link_items') && <button className="sops-btn-sm" onClick={() => openLinkModal('pms')}><span className="material-icons" style={{ fontSize: 14 }}>add_link</span> Link PMs</button>}
                </div>
                {linksLoading ? <p className="sops-link-empty">Loading...</p> : linkedPMs.length === 0 ? <p className="sops-link-empty">No PM schedules linked to this SOP.</p> : (
                  <div className="sops-link-list">
                    {linkedPMs.map(p => (
                      <div key={p.pm_id} className="sops-link-item">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="sops-link-item-name">{p.pm_name}</div>
                          <div className="sops-link-item-sub">{p.pm_id} · {p.asset_name || 'No asset'} · {p.frequency}{p.next_due_date ? ` · Due: ${fmtDate(p.next_due_date)}` : ''}</div>
                        </div>
                        <span className={`sops-status-dot ${p.status === 'Active' ? 'active' : 'paused'}`}>{p.status}</span>
                        {hasPerm('link_items') && <button className="sops-btn-icon" onClick={() => handleUnlink('pm', p.pm_id)} title="Unlink"><span className="material-icons" style={{ fontSize: 16, color: '#fa5252' }}>link_off</span></button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Linked WOs ── */}
              <div className="sops-link-section">
                <div className="sops-link-section-header">
                  <h5 className="sops-link-section-title"><span className="material-icons" style={{ fontSize: 18, color: '#fab005' }}>assignment</span> Linked Work Orders ({linkedWOs.length})</h5>
                  {hasPerm('link_items') && <button className="sops-btn-sm" onClick={() => openLinkModal('wos')}><span className="material-icons" style={{ fontSize: 14 }}>add_link</span> Link WOs</button>}
                </div>
                {linksLoading ? <p className="sops-link-empty">Loading...</p> : linkedWOs.length === 0 ? <p className="sops-link-empty">No work orders linked to this SOP.</p> : (
                  <div className="sops-link-list">
                    {linkedWOs.map(w => (
                      <div key={w.wo_id} className="sops-link-item">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="sops-link-item-name">{w.wo_id}: {(w.description || '').slice(0, 80)}{(w.description || '').length > 80 ? '...' : ''}</div>
                          <div className="sops-link-item-sub">{w.asset_name || 'No asset'} · {w.priority} · {w.status}{w.assigned_to ? ` · ${w.assigned_to}` : ''}</div>
                        </div>
                        <span className={`sops-status-dot ${w.status === 'Closed' ? 'closed' : 'active'}`}>{w.status}</span>
                        {hasPerm('link_items') && <button className="sops-btn-icon" onClick={() => handleUnlink('wo', w.wo_id)} title="Unlink"><span className="material-icons" style={{ fontSize: 16, color: '#fa5252' }}>link_off</span></button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Document Section ── */}
              <div className="sops-link-section">
                <div className="sops-link-section-header">
                  <h5 className="sops-link-section-title"><span className="material-icons" style={{ fontSize: 18, color: '#e03131' }}>attach_file</span> Document</h5>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {selectedSOP.document_url ? (
                      <>
                        <button className="sops-btn-sm" onClick={handlePrint}><span className="material-icons" style={{ fontSize: 14 }}>print</span> Print</button>
                        <a href={selectedSOP.document_url} target="_blank" rel="noopener noreferrer" className="sops-btn-sm" style={{ textDecoration: 'none' }}><span className="material-icons" style={{ fontSize: 14 }}>open_in_new</span> Open</a>
                        {hasPerm('replace_document') && <button className="sops-btn-sm" onClick={() => { setSelectedFile(null); setShowReplaceModal(true) }}><span className="material-icons" style={{ fontSize: 14 }}>swap_horiz</span> Replace</button>}
                        {hasPerm('delete_document') && <button className="sops-btn-sm sops-btn-sm-danger" onClick={() => setShowDeleteDocConfirm(true)}><span className="material-icons" style={{ fontSize: 14 }}>delete</span> Remove</button>}
                      </>
                    ) : hasPerm('upload_document') && (
                      <div>
                        <input ref={uploadFileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files[0]; if (f && f.type !== 'application/pdf') { alert('Only PDF files.'); e.target.value = ''; return }; setSelectedFile(f || null) }} />
                        {selectedFile ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '0.8rem', color: '#495057' }}>{selectedFile.name}</span>
                            <button className="sops-btn-sm" onClick={handleUploadDoc} disabled={saving}>{saving ? 'Uploading...' : 'Upload'}</button>
                            <button className="sops-btn-icon" onClick={() => { setSelectedFile(null); if (uploadFileRef.current) uploadFileRef.current.value = '' }}><span className="material-icons" style={{ fontSize: 16 }}>close</span></button>
                          </div>
                        ) : <button className="sops-btn-sm" onClick={() => uploadFileRef.current?.click()}><span className="material-icons" style={{ fontSize: 14 }}>upload_file</span> Upload PDF</button>}
                      </div>
                    )}
                  </div>
                </div>
                {selectedSOP.document_url ? (
                  <div>
                    <div className="sops-doc-info">
                      <span className="material-icons" style={{ color: '#e03131', fontSize: 22 }}>picture_as_pdf</span>
                      <span style={{ flex: 1, fontWeight: 500, fontSize: '0.88rem', color: '#495057' }}>{selectedSOP.document_name || 'SOP Document'}</span>
                    </div>
                    <div className="sops-pdf-viewer">
                      <iframe src={`${selectedSOP.document_url}#toolbar=1&navpanes=0`} title={selectedSOP.document_name || 'SOP Document'} style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }} />
                    </div>
                  </div>
                ) : (
                  <div className="sops-no-doc">
                    <span className="material-icons" style={{ fontSize: 36, color: '#dee2e6' }}>note_add</span>
                    <p style={{ margin: '8px 0 0', color: '#868e96', fontSize: '0.88rem' }}>No document attached to this SOP.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ CREATE MODAL ═════════════════════════════ */}
      {showCreateModal && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowCreateModal(false)}>
          <div className="sops-modal">
            <div className="sops-modal-header"><h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem' }}><span className="material-icons" style={{ color: '#228be6' }}>add_circle</span> New SOP</h4><button className="sops-modal-close" onClick={() => setShowCreateModal(false)}>&times;</button></div>
            <div className="sops-modal-body">
              <label className="sops-label">Name <span style={{ color: '#fa5252' }}>*</span></label>
              <input className="sops-input" placeholder="Enter SOP name..." value={formData.name} onChange={(e) => setFormData(f => ({ ...f, name: e.target.value }))} autoFocus />
              <label className="sops-label">Description</label>
              <textarea className="sops-input" placeholder="Describe this SOP..." value={formData.description} onChange={(e) => setFormData(f => ({ ...f, description: e.target.value }))} rows={4} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
              {hasPerm('upload_document') && (
                <>
                  <label className="sops-label">Document (PDF only)</label>
                  <div className="sops-file-drop">
                    <input ref={fileInputRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files[0]; if (f && f.type !== 'application/pdf') { alert('Only PDF files.'); e.target.value = ''; return }; setSelectedFile(f || null) }} />
                    {selectedFile ? (
                      <div className="sops-file-selected">
                        <span className="material-icons" style={{ color: '#e03131', fontSize: 20 }}>picture_as_pdf</span>
                        <span style={{ flex: 1, fontSize: '0.88rem', color: '#495057' }}>{selectedFile.name}</span>
                        <button className="sops-btn-icon" onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}><span className="material-icons" style={{ fontSize: 18 }}>close</span></button>
                      </div>
                    ) : (
                      <button className="sops-file-browse" onClick={() => fileInputRef.current?.click()}>
                        <span className="material-icons" style={{ fontSize: 24, color: '#228be6' }}>cloud_upload</span>
                        <span style={{ fontSize: '0.88rem', color: '#495057' }}>Click to browse for a PDF</span>
                        <span style={{ fontSize: '0.75rem', color: '#adb5bd' }}>Optional — you can add a document later</span>
                      </button>
                    )}
                  </div>
                </>
              )}
              <p style={{ margin: '16px 0 0', fontSize: '0.8rem', color: '#868e96' }}>You can link this SOP to assets, PMs, and work orders after creating it.</p>
            </div>
            <div className="sops-modal-footer"><button className="sops-btn-cancel" onClick={() => setShowCreateModal(false)}>Cancel</button><button className="sops-btn-primary" onClick={handleCreate} disabled={saving}>{saving ? 'Creating...' : 'Create SOP'}</button></div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ EDIT MODAL ═══════════════════════════════ */}
      {showEditModal && selectedSOP && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowEditModal(false)}>
          <div className="sops-modal">
            <div className="sops-modal-header"><h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem' }}><span className="material-icons" style={{ color: '#fab005' }}>edit</span> Edit SOP</h4><button className="sops-modal-close" onClick={() => setShowEditModal(false)}>&times;</button></div>
            <div className="sops-modal-body">
              <label className="sops-label">Name <span style={{ color: '#fa5252' }}>*</span></label>
              <input className="sops-input" value={formData.name} onChange={(e) => setFormData(f => ({ ...f, name: e.target.value }))} autoFocus />
              <label className="sops-label">Description</label>
              <textarea className="sops-input" value={formData.description} onChange={(e) => setFormData(f => ({ ...f, description: e.target.value }))} rows={4} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div className="sops-modal-footer"><button className="sops-btn-cancel" onClick={() => setShowEditModal(false)}>Cancel</button><button className="sops-btn-primary" onClick={handleEdit} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button></div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ REPLACE DOC MODAL ═════════════════════════ */}
      {showReplaceModal && selectedSOP && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowReplaceModal(false)}>
          <div className="sops-modal">
            <div className="sops-modal-header"><h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem' }}><span className="material-icons" style={{ color: '#fab005' }}>swap_horiz</span> Replace Document</h4><button className="sops-modal-close" onClick={() => setShowReplaceModal(false)}>&times;</button></div>
            <div className="sops-modal-body">
              <p style={{ margin: '0 0 12px', fontSize: '0.88rem', color: '#495057' }}>Current: <strong>{selectedSOP.document_name || 'Unknown'}</strong></p>
              <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: '#868e96' }}>This will permanently delete the current document and replace it.</p>
              <div className="sops-file-drop">
                <input ref={replaceFileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files[0]; if (f && f.type !== 'application/pdf') { alert('Only PDF files.'); e.target.value = ''; return }; setSelectedFile(f || null) }} />
                {selectedFile ? (
                  <div className="sops-file-selected"><span className="material-icons" style={{ color: '#e03131', fontSize: 20 }}>picture_as_pdf</span><span style={{ flex: 1, fontSize: '0.88rem', color: '#495057' }}>{selectedFile.name}</span><button className="sops-btn-icon" onClick={() => { setSelectedFile(null); if (replaceFileRef.current) replaceFileRef.current.value = '' }}><span className="material-icons" style={{ fontSize: 18 }}>close</span></button></div>
                ) : (
                  <button className="sops-file-browse" onClick={() => replaceFileRef.current?.click()}><span className="material-icons" style={{ fontSize: 24, color: '#228be6' }}>cloud_upload</span><span style={{ fontSize: '0.88rem', color: '#495057' }}>Click to browse for a PDF</span></button>
                )}
              </div>
            </div>
            <div className="sops-modal-footer"><button className="sops-btn-cancel" onClick={() => setShowReplaceModal(false)}>Cancel</button><button className="sops-btn-primary" onClick={handleReplaceDoc} disabled={saving || !selectedFile}>{saving ? 'Replacing...' : 'Replace Document'}</button></div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ LINK PICKER MODAL ═════════════════════════ */}
      {showLinkModal && selectedSOP && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowLinkModal(null)}>
          <div className="sops-modal sops-modal-lg">
            <div className="sops-modal-header">
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem' }}>
                <span className="material-icons" style={{ color: '#228be6' }}>add_link</span>
                Link {showLinkModal === 'assets' ? 'Assets' : showLinkModal === 'pms' ? 'PM Schedules' : 'Work Orders'}
              </h4>
              <button className="sops-modal-close" onClick={() => setShowLinkModal(null)}>&times;</button>
            </div>
            <div className="sops-modal-body">
              <div className="sops-search-wrap" style={{ marginBottom: 12 }}>
                <span className="material-icons sops-search-icon">search</span>
                <input className="sops-search-input" type="text" placeholder={`Search ${showLinkModal === 'assets' ? 'assets' : showLinkModal === 'pms' ? 'PM schedules' : 'work orders'}...`} value={linkSearch} onChange={(e) => setLinkSearch(e.target.value)} autoFocus />
                {linkSearch && <button className="sops-search-clear" onClick={() => setLinkSearch('')}><span className="material-icons" style={{ fontSize: 18 }}>close</span></button>}
              </div>
              <p style={{ margin: '0 0 8px', fontSize: '0.78rem', color: '#868e96' }}>{Object.values(linkSelected).filter(Boolean).length} selected · {linkPickerItems.length} available</p>
              <div className="sops-link-picker-list">
                {linkPickerItems.length === 0 && <p style={{ textAlign: 'center', padding: 20, color: '#868e96', fontSize: '0.85rem' }}>{linkSearch ? 'No matches found.' : 'All items are already linked.'}</p>}
                {linkPickerItems.map(item => {
                  const id = showLinkModal === 'assets' ? item.asset_id : showLinkModal === 'pms' ? item.pm_id : item.wo_id
                  const checked = !!linkSelected[id]
                  return (
                    <label key={id} className={`sops-link-picker-item ${checked ? 'selected' : ''}`}>
                      <input type="checkbox" checked={checked} onChange={() => setLinkSelected(prev => ({ ...prev, [id]: !prev[id] }))} style={{ marginRight: 10, accentColor: '#228be6' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: '0.85rem', color: '#495057' }}>
                          {showLinkModal === 'assets' ? item.name : showLinkModal === 'pms' ? item.pm_name : `${item.wo_id}: ${(item.description || '').slice(0, 70)}${(item.description || '').length > 70 ? '...' : ''}`}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#868e96' }}>
                          {showLinkModal === 'assets' ? `${item.asset_id}${item.category ? ` · ${item.category}` : ''}${item.location ? ` · ${item.location}` : ''}` :
                           showLinkModal === 'pms' ? `${item.pm_id} · ${item.asset_name || 'No asset'} · ${item.frequency}` :
                           `${item.asset_name || 'No asset'} · ${item.priority} · ${item.status}${item.assigned_to ? ` · ${item.assigned_to}` : ''}`}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
            <div className="sops-modal-footer">
              <button className="sops-btn-cancel" onClick={() => setShowLinkModal(null)}>Cancel</button>
              <button className="sops-btn-primary" onClick={handleSaveLinks} disabled={saving || Object.values(linkSelected).filter(Boolean).length === 0}>
                {saving ? 'Linking...' : `Link ${Object.values(linkSelected).filter(Boolean).length} Item${Object.values(linkSelected).filter(Boolean).length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ DELETE CONFIRMS ═══════════════════════════ */}
      {showDeleteConfirm && selectedSOP && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowDeleteConfirm(false)}>
          <div className="sops-modal" style={{ maxWidth: 400 }}>
            <div className="sops-modal-header"><h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', color: '#e03131' }}><span className="material-icons">warning</span> Delete SOP</h4><button className="sops-modal-close" onClick={() => setShowDeleteConfirm(false)}>&times;</button></div>
            <div className="sops-modal-body">
              <p style={{ margin: 0, fontSize: '0.9rem', color: '#495057' }}>Are you sure you want to delete <strong>{selectedSOP.name}</strong>?</p>
              {selectedSOP.document_url && <p style={{ margin: '8px 0 0', fontSize: '0.85rem', color: '#868e96' }}>The attached document will also be permanently deleted.</p>}
              {(linkedAssets.length > 0 || linkedPMs.length > 0 || linkedWOs.length > 0) && <p style={{ margin: '8px 0 0', fontSize: '0.85rem', color: '#868e96' }}>All linked assets ({linkedAssets.length}), PMs ({linkedPMs.length}), and WOs ({linkedWOs.length}) will be unlinked.</p>}
              <p style={{ margin: '12px 0 0', fontSize: '0.85rem', color: '#fa5252', fontWeight: 500 }}>This action cannot be undone.</p>
            </div>
            <div className="sops-modal-footer"><button className="sops-btn-cancel" onClick={() => setShowDeleteConfirm(false)}>Cancel</button><button className="sops-btn-danger" onClick={handleDelete} disabled={saving}>{saving ? 'Deleting...' : 'Delete'}</button></div>
          </div>
        </div>
      )}

      {showDeleteDocConfirm && selectedSOP && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowDeleteDocConfirm(false)}>
          <div className="sops-modal" style={{ maxWidth: 400 }}>
            <div className="sops-modal-header"><h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', color: '#e03131' }}><span className="material-icons">warning</span> Remove Document</h4><button className="sops-modal-close" onClick={() => setShowDeleteDocConfirm(false)}>&times;</button></div>
            <div className="sops-modal-body">
              <p style={{ margin: 0, fontSize: '0.9rem', color: '#495057' }}>Remove <strong>{selectedSOP.document_name}</strong>?</p>
              <p style={{ margin: '12px 0 0', fontSize: '0.85rem', color: '#fa5252', fontWeight: 500 }}>The document will be permanently deleted from storage.</p>
            </div>
            <div className="sops-modal-footer"><button className="sops-btn-cancel" onClick={() => setShowDeleteDocConfirm(false)}>Cancel</button><button className="sops-btn-danger" onClick={handleDeleteDoc} disabled={saving}>{saving ? 'Removing...' : 'Remove'}</button></div>
          </div>
        </div>
      )}

      {/* ═══════════════════════ MANAGE TEMPLATE MODAL ════════════════════════ */}
      {showManageTemplate && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowManageTemplate(false)}>
          <div className="sops-modal" style={{ maxWidth: 460 }}>
            <div className="sops-modal-header">
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem' }}>
                <span className="material-icons" style={{ color: '#228be6' }}>description</span>
                Manage SOP Template
              </h4>
              <button className="sops-modal-close" onClick={() => { setShowManageTemplate(false); setTemplateError('') }}>&times;</button>
            </div>
            <div className="sops-modal-body">
              {/* ── Error banner ── */}
              {templateError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: '#fff5f5', border: '1px solid #ffc9c9', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
                  <span className="material-icons" style={{ color: '#e03131', fontSize: 20, flexShrink: 0, marginTop: 1 }}>error</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#c92a2a', marginBottom: 2 }}>Upload Failed</div>
                    <div style={{ fontSize: '0.82rem', color: '#c92a2a' }}>{templateError}</div>
                  </div>
                  <button className="sops-btn-icon" onClick={() => setTemplateError('')} style={{ flexShrink: 0 }}>
                    <span className="material-icons" style={{ fontSize: 16, color: '#e03131' }}>close</span>
                  </button>
                </div>
              )}
              <p style={{ margin: '0 0 16px', fontSize: '0.88rem', color: '#495057' }}>
                This template is available for download by all users when creating a new SOP. Upload a <strong>.docx</strong> file — students will fill it out and upload the completed version as a PDF.
              </p>

              {/* Current Template Status */}
              {templateUrl ? (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-icons" style={{ color: '#16a34a', fontSize: 22 }}>check_circle</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#15803d' }}>Template Active</div>
                    <div style={{ fontSize: '0.78rem', color: '#166534', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{templateName || 'SOP_Template.docx'}</div>
                  </div>
                  <a href={templateUrl} download={templateName || 'SOP_Template.docx'} className="sops-btn-sm" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
                    <span className="material-icons" style={{ fontSize: 14 }}>download</span> Download
                  </a>
                </div>
              ) : (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-icons" style={{ color: '#d97706', fontSize: 22 }}>warning</span>
                  <div style={{ fontSize: '0.85rem', color: '#92400e' }}>No template uploaded yet. Upload one below to make it available for download.</div>
                </div>
              )}

              {/* File picker */}
              <label className="sops-label">{templateUrl ? 'Replace Template File' : 'Upload Template File'}</label>
              <p style={{ margin: '0 0 8px', fontSize: '0.8rem', color: '#868e96' }}>Accepted formats: .docx, .doc, .pdf</p>
              <input
                ref={templateFileRef}
                type="file"
                accept=".docx,.doc,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files[0]; setTemplateFile(f || null) }}
              />
              {templateFile ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f8f9fa', borderRadius: 8, border: '1px solid #e9ecef' }}>
                  <span className="material-icons" style={{ color: '#228be6', fontSize: 20 }}>description</span>
                  <span style={{ flex: 1, fontSize: '0.85rem', color: '#495057', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{templateFile.name}</span>
                  <button className="sops-btn-icon" onClick={() => { setTemplateFile(null); if (templateFileRef.current) templateFileRef.current.value = '' }}>
                    <span className="material-icons" style={{ fontSize: 16 }}>close</span>
                  </button>
                </div>
              ) : (
                <div
                  className="sops-file-drop"
                  style={templateDragging ? { borderColor: '#228be6', background: '#e7f5ff' } : {}}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setTemplateDragging(true) }}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setTemplateDragging(true) }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setTemplateDragging(false) }}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation(); setTemplateDragging(false)
                    const f = e.dataTransfer.files[0]
                    if (!f) return
                    const allowed = ['.docx', '.doc', '.pdf']
                    const ext = '.' + f.name.split('.').pop().toLowerCase()
                    if (!allowed.includes(ext)) { alert('Please drop a .docx, .doc, or .pdf file.'); return }
                    setTemplateFile(f)
                  }}
                >
                  <button className="sops-file-browse" onClick={() => templateFileRef.current?.click()}>
                    <span className="material-icons" style={{ fontSize: 32, color: templateDragging ? '#228be6' : '#adb5bd' }}>upload_file</span>
                    <span style={{ fontSize: '0.85rem', color: templateDragging ? '#228be6' : '#495057', fontWeight: 500 }}>
                      {templateDragging ? 'Drop to upload' : 'Click or drag file here'}
                    </span>
                    <span style={{ fontSize: '0.78rem', color: '#adb5bd' }}>.docx, .doc, or .pdf</span>
                  </button>
                </div>
              )}
            </div>
            <div className="sops-modal-footer" style={{ justifyContent: templateUrl ? 'space-between' : 'flex-end' }}>
              {templateUrl && (
                <button className="sops-btn-danger-outline" onClick={() => setShowRemoveTemplateConfirm(true)} style={{ fontSize: '0.82rem' }}>
                  <span className="material-icons" style={{ fontSize: 15 }}>delete</span> Remove Template
                </button>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="sops-btn-cancel" onClick={() => setShowManageTemplate(false)}>Cancel</button>
                <button className="sops-btn-primary" onClick={handleUploadTemplate} disabled={!templateFile || templateUploading}>
                  {templateUploading ? 'Uploading...' : templateUrl ? 'Replace Template' : 'Upload Template'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ REMOVE TEMPLATE CONFIRM ═══════════════════════════ */}
      {showRemoveTemplateConfirm && (
        <div className="sops-overlay" onClick={(e) => e.target === e.currentTarget && setShowRemoveTemplateConfirm(false)}>
          <div className="sops-modal" style={{ maxWidth: 400 }}>
            <div className="sops-modal-header">
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', color: '#e03131' }}>
                <span className="material-icons">warning</span> Remove Template
              </h4>
              <button className="sops-modal-close" onClick={() => setShowRemoveTemplateConfirm(false)}>&times;</button>
            </div>
            <div className="sops-modal-body">
              <p style={{ margin: 0, fontSize: '0.9rem', color: '#495057' }}>Remove <strong>{templateName || 'the current template'}</strong>?</p>
              <p style={{ margin: '12px 0 0', fontSize: '0.85rem', color: '#fa5252', fontWeight: 500 }}>The file will be permanently deleted and the Download Template button will be hidden from users.</p>
            </div>
            <div className="sops-modal-footer">
              <button className="sops-btn-cancel" onClick={() => setShowRemoveTemplateConfirm(false)}>Cancel</button>
              <button className="sops-btn-danger" onClick={handleRemoveTemplate} disabled={templateUploading}>{templateUploading ? 'Removing...' : 'Remove'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ STYLES ════════════════════════════════════ */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .sops-root { max-width: 1100px; margin: 0 auto; padding: 0 0 40px; }
        .sops-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
        .sops-header-left { display: flex; align-items: center; gap: 12px; }
        .sops-header-icon { font-size: 2rem; color: #228be6; background: #e7f5ff; border-radius: 10px; padding: 8px; }
        .sops-title { margin: 0; font-size: 1.4rem; font-weight: 700; color: #1a1a2e; }
        .sops-subtitle { margin: 2px 0 0; font-size: 0.85rem; color: #868e96; }
        .sops-search-wrap { position: relative; margin-bottom: 20px; }
        .sops-search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); font-size: 20px; color: #adb5bd; pointer-events: none; }
        .sops-search-input { width: 100%; padding: 12px 40px 12px 44px; border: 1px solid #dee2e6; border-radius: 10px; font-size: 0.9rem; background: white; box-sizing: border-box; transition: border-color 0.2s; }
        .sops-search-input:focus { border-color: #228be6; outline: none; box-shadow: 0 0 0 3px rgba(34,139,230,0.1); }
        .sops-search-input::placeholder { color: #adb5bd; }
        .sops-search-clear { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; color: #868e96; padding: 4px; display: flex; align-items: center; }
        .sops-empty { text-align: center; padding: 60px 20px; }
        .sops-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
        .sops-card { background: white; border: 1px solid #e9ecef; border-radius: 12px; padding: 20px; cursor: pointer; transition: all 0.2s; }
        .sops-card:hover { border-color: #228be6; box-shadow: 0 4px 12px rgba(34,139,230,0.12); transform: translateY(-2px); }
        .sops-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .sops-card-doc-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 0.7rem; font-weight: 600; padding: 3px 8px; border-radius: 4px; }
        .sops-card-doc-badge.has-doc { background: #ffe3e3; color: #c92a2a; }
        .sops-card-doc-badge.no-doc { background: #f1f3f5; color: #868e96; }
        .sops-card-links-badge { display: inline-flex; align-items: center; gap: 2px; font-size: 0.68rem; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: #e7f5ff; color: #1971c2; }
        .sops-card-id { font-size: 0.72rem; color: #adb5bd; font-weight: 500; }
        .sops-card-name { margin: 0 0 6px; font-size: 1rem; font-weight: 600; color: #1a1a2e; line-height: 1.3; }
        .sops-card-desc { margin: 0 0 8px; font-size: 0.83rem; color: #868e96; line-height: 1.45; }
        .sops-card-doc-name { margin: 0 0 8px; font-size: 0.78rem; color: #495057; }
        .sops-card-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 10px; border-top: 1px solid #f1f3f5; }
        .sops-card-meta { font-size: 0.75rem; color: #adb5bd; display: flex; align-items: center; gap: 4px; }
        .sops-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
        .sops-modal { background: white; border-radius: 12px; width: 100%; max-width: 480px; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; }
        .sops-modal-lg { max-width: 720px; }
        .sops-modal-header { padding: 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .sops-modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; line-height: 1; }
        .sops-modal-close:hover { color: #495057; }
        .sops-modal-body { padding: 20px; overflow-y: auto; flex: 1; }
        .sops-modal-footer { padding: 16px 20px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; flex-shrink: 0; }
        .sops-label { display: block; font-size: 0.85rem; font-weight: 500; margin: 12px 0 6px; color: #495057; }
        .sops-label:first-child { margin-top: 0; }
        .sops-input { width: 100%; padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box; }
        .sops-input:focus { border-color: #228be6; outline: none; box-shadow: 0 0 0 3px rgba(34,139,230,0.1); }
        .sops-file-drop { border: 2px dashed #dee2e6; border-radius: 10px; overflow: hidden; }
        .sops-file-browse { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px; width: 100%; background: none; border: none; cursor: pointer; transition: background 0.15s; }
        .sops-file-browse:hover { background: #f8f9fa; }
        .sops-file-selected { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #f8f9fa; }
        .sops-btn-primary { background: #228be6; color: white; border: none; border-radius: 8px; padding: 10px 20px; font-size: 0.88rem; font-weight: 500; cursor: pointer; transition: background 0.2s; display: inline-flex; align-items: center; gap: 6px; }
        .sops-btn-primary:hover { background: #1c7ed6; }
        .sops-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .sops-btn-cancel { background: #f1f3f5; color: #495057; border: none; border-radius: 8px; padding: 10px 20px; font-size: 0.88rem; cursor: pointer; }
        .sops-btn-cancel:hover { background: #e9ecef; }
        .sops-btn-danger { background: #fa5252; color: white; border: none; border-radius: 8px; padding: 10px 20px; font-size: 0.88rem; font-weight: 500; cursor: pointer; }
        .sops-btn-danger:hover { background: #e03131; }
        .sops-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
        .sops-btn-outline { background: white; color: #228be6; border: 1.5px solid #228be6; border-radius: 8px; padding: 8px 16px; font-size: 0.85rem; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s; }
        .sops-btn-outline:hover { background: #e7f5ff; }
        .sops-btn-danger-outline { background: white; color: #fa5252; border: 1.5px solid #fa5252; border-radius: 8px; padding: 8px 16px; font-size: 0.85rem; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s; }
        .sops-btn-danger-outline:hover { background: #fff5f5; }
        .sops-btn-sm { background: #f1f3f5; border: 1px solid #dee2e6; border-radius: 6px; padding: 5px 12px; font-size: 0.78rem; cursor: pointer; color: #495057; display: inline-flex; align-items: center; gap: 4px; transition: all 0.15s; }
        .sops-btn-sm:hover { background: #e9ecef; }
        .sops-btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
        .sops-btn-sm-danger { color: #e03131; border-color: #ffc9c9; }
        .sops-btn-sm-danger:hover { background: #fff5f5; }
        .sops-btn-icon { background: none; border: none; cursor: pointer; color: #868e96; padding: 4px; display: inline-flex; align-items: center; }
        .sops-btn-icon:hover { color: #495057; }
        .sops-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
        .sops-detail-row { display: flex; flex-direction: column; gap: 2px; }
        .sops-detail-label { font-size: 0.75rem; font-weight: 600; color: #868e96; text-transform: uppercase; letter-spacing: 0.3px; }
        .sops-detail-value { font-size: 0.88rem; color: #495057; }
        .sops-view-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .sops-doc-info { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #f8f9fa; border-radius: 8px; margin-bottom: 12px; }
        .sops-pdf-viewer { width: 100%; height: 400px; border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden; background: #f8f9fa; }
        .sops-no-doc { text-align: center; padding: 30px 20px; background: #f8f9fa; border-radius: 8px; border: 1px dashed #dee2e6; }
        .sops-link-section { border-top: 1px solid #e9ecef; padding: 16px 20px; }
        .sops-link-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .sops-link-section-title { margin: 0; font-size: 0.88rem; color: #495057; display: flex; align-items: center; gap: 6px; font-weight: 600; }
        .sops-link-empty { font-size: 0.83rem; color: #adb5bd; padding: 8px 0; margin: 0; }
        .sops-link-list { display: flex; flex-direction: column; gap: 4px; }
        .sops-link-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #f8f9fa; border-radius: 8px; border: 1px solid #f1f3f5; }
        .sops-link-item-name { font-size: 0.85rem; font-weight: 500; color: #495057; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sops-link-item-sub { font-size: 0.73rem; color: #adb5bd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sops-status-dot { font-size: 0.68rem; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
        .sops-status-dot.active { background: #d3f9d8; color: #2b8a3e; }
        .sops-status-dot.paused { background: #f1f3f5; color: #868e96; }
        .sops-status-dot.closed { background: #e7f5ff; color: #1971c2; }
        .sops-link-picker-list { max-height: 360px; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 8px; }
        .sops-link-picker-item { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid #f1f3f5; cursor: pointer; transition: background 0.1s; }
        .sops-link-picker-item:last-child { border-bottom: none; }
        .sops-link-picker-item:hover { background: #f8f9fa; }
        .sops-link-picker-item.selected { background: #e7f5ff; }
        @media (max-width: 640px) {
          .sops-grid { grid-template-columns: 1fr; }
          .sops-detail-grid { grid-template-columns: 1fr; }
          .sops-modal-lg { max-width: 100%; }
          .sops-pdf-viewer { height: 300px; }
          .sops-header { flex-direction: column; align-items: flex-start; }
        }
        .sops-asset-filter-banner { display: flex; align-items: center; gap: 10px; background: #e7f5ff; border: 1px solid #a5d8ff; border-radius: 8px; padding: 10px 16px; margin-bottom: 16px; font-size: 0.88rem; color: #1e3a5f; }
        .sops-asset-filter-clear { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; background: white; border: 1px solid #a5d8ff; border-radius: 6px; padding: 4px 10px; font-size: 0.78rem; color: #1971c2; cursor: pointer; transition: all 0.15s; font-weight: 500; }
        .sops-asset-filter-clear:hover { background: #d0ebff; border-color: #74c0fc; }
      `}</style>
    </div>
  )
}
