/**
 * RICT CMMS — Assets Page (React + Supabase)
 * Matches the look & functionality of the old Google Apps Script system.
 *
 * Features:
 *  - Search, category filter, location filter, status filter
 *  - Table layout with image, name, ID, tags, status — clickable rows open detail modal
 *  - View asset detail modal: image, detail rows, all actions (WO, Docs, Dup, Edit, Delete)
 *  - WCAG 2.1 AA accessible: role=dialog, aria-modal, keyboard nav, focus management
 *  - Add / Edit asset modal with name, status, description, category, location, image upload
 *  - Work Orders modal for asset (open + closed)
 *  - Documents modal with upload/delete
 *  - Print Labels modal: select assets, preview QR labels, print
 *  - Asset Lookup button: navigates to /assets/scan for QR-based asset lookup
 *  - Permission-gated (add_assets, edit_assets, delete_assets, upload_docs, print_labels)
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'

function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString()
}

export default function AssetsPage() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()

  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)

  // filters
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [locationFilter, setLocationFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // dropdowns
  const [categories, setCategories] = useState([])
  const [locations, setLocations] = useState([])

  // modals
  const [showAssetModal, setShowAssetModal] = useState(false)
  const [showViewModal, setShowViewModal] = useState(false)
  const [showWOModal, setShowWOModal] = useState(false)
  const [showDocsModal, setShowDocsModal] = useState(false)
  const [showLabelsModal, setShowLabelsModal] = useState(false)
  const [showLabelsPreview, setShowLabelsPreview] = useState(false)

  // form
  const [formData, setFormData] = useState({})
  const [imageData, setImageData] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [saving, setSaving] = useState(false)

  // duplicate
  const [showDuplicateModal, setShowDuplicateModal] = useState(false)
  const [duplicateSource, setDuplicateSource] = useState(null)
  const [duplicateSerial, setDuplicateSerial] = useState('')
  const [duplicateSaving, setDuplicateSaving] = useState(false)

  // view detail
  const [viewAsset, setViewAsset] = useState(null)

  // work orders & documents for an asset
  const [assetWOs, setAssetWOs] = useState([])
  const [assetDocs, setAssetDocs] = useState([])
  const [woAssetName, setWoAssetName] = useState('')
  const [docAssetId, setDocAssetId] = useState('')
  const [docAssetName, setDocAssetName] = useState('')

  // doc type modal
  const [showDocTypeModal, setShowDocTypeModal] = useState(false)
  const [pendingDocFile, setPendingDocFile] = useState(null)
  const [selectedDocType, setSelectedDocType] = useState('Document')
  const [docUploading, setDocUploading] = useState(false)

  // labels
  const [selectedLabelIds, setSelectedLabelIds] = useState([])

  const { hasPerm } = usePermissions('Assets')

  // SOP link counts keyed by asset_id
  const [assetSopCounts, setAssetSopCounts] = useState({})
  // Linked SOPs for the view modal
  const [viewModalSOPs, setViewModalSOPs] = useState([])
  const [viewModalSOPsLoading, setViewModalSOPsLoading] = useState(false)
  // Realtime channel ref
  const sopChannelRef = useRef(null)

  /* ── Load Material Icons Font ────────────────────────────────────── */
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
  }, []);

  /* ── Load ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!profile?.role) return
    loadDropdowns()
    loadAssets()
  }, [profile?.role])

  async function loadDropdowns() {
    // Load from the categories and asset_locations tables so new entries appear immediately
    const [{ data: catData }, { data: locData }] = await Promise.all([
      supabase.from('categories').select('category_id, category_name').eq('status', 'Active').order('category_name'),
      supabase.from('asset_locations').select('location_id, location_name').eq('status', 'Active').order('location_name'),
    ])
    if (catData) setCategories(catData)
    if (locData) setLocations(locData)
  }

  async function loadAssets() {
    setLoading(true)
    const [{ data }, { data: sopLinks }] = await Promise.all([
      supabase.from('assets').select('*').order('name'),
      supabase.from('sop_assets').select('asset_id'),
    ])
    setAssets(data || [])
    // Build a count map: { asset_id -> number_of_sops }
    const counts = {}
    ;(sopLinks || []).forEach(r => {
      counts[r.asset_id] = (counts[r.asset_id] || 0) + 1
    })
    setAssetSopCounts(counts)
    setLoading(false)
  }

  /* ── Realtime: sop_assets → keep badge counts live ─────────────── */
  useEffect(() => {
    if (!profile?.role) return
    const refreshCounts = async () => {
      const { data } = await supabase.from('sop_assets').select('asset_id')
      const counts = {}
      ;(data || []).forEach(r => {
        counts[r.asset_id] = (counts[r.asset_id] || 0) + 1
      })
      setAssetSopCounts(counts)
    }
    const ch = supabase
      .channel('assets-page-sop-links')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sop_assets' }, refreshCounts)
      .subscribe()
    sopChannelRef.current = ch
    return () => { supabase.removeChannel(ch) }
  }, [profile?.role])

  /* ── Fetch SOPs linked to a specific asset (for view modal) ─────── */
  async function fetchSOPsForAsset(assetId) {
    setViewModalSOPs([])
    setViewModalSOPsLoading(true)
    try {
      const { data: links } = await supabase
        .from('sop_assets')
        .select('sop_id')
        .eq('asset_id', assetId)
      const sopIds = (links || []).map(r => r.sop_id)
      if (sopIds.length) {
        const { data: sops } = await supabase
          .from('sops')
          .select('sop_id, name, description, document_url, updated_at, updated_by')
          .in('sop_id', sopIds)
          .order('name')
        setViewModalSOPs(sops || [])
      }
    } catch {}
    setViewModalSOPsLoading(false)
  }

  /* ── Filtering ──────────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    let list = assets
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(a =>
        (a.asset_id || '').toLowerCase().includes(s) ||
        (a.name || '').toLowerCase().includes(s) ||
        (a.description || '').toLowerCase().includes(s) ||
        (a.category || '').toLowerCase().includes(s) ||
        (a.location || '').toLowerCase().includes(s) ||
        (a.serial_number || '').toLowerCase().includes(s)
      )
    }
    if (categoryFilter) list = list.filter(a => a.category === categoryFilter)
    if (locationFilter) list = list.filter(a => a.location === locationFilter)
    if (statusFilter) list = list.filter(a => a.status === statusFilter)
    return list
  }, [assets, search, categoryFilter, locationFilter, statusFilter])

  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState('asc')

  const sortedAssets = useMemo(() => {
    if (!sortCol) return filtered
    return [...filtered].sort((a, b) => {
      const valA = (a[sortCol] || '').toString().toLowerCase()
      const valB = (b[sortCol] || '').toString().toLowerCase()
      if (valA < valB) return sortDir === 'asc' ? -1 : 1
      if (valA > valB) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [filtered, sortCol, sortDir])

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const highlightMatch = (text) => {
    if (!search || !text) return text || ''
    const str = String(text)
    const idx = str.toLowerCase().indexOf(search.toLowerCase())
    if (idx === -1) return str
    return (
      <>{str.substring(0, idx)}<mark style={{ background: '#fff3bf', padding: '0 1px', borderRadius: 2 }}>{str.substring(idx, idx + search.length)}</mark>{str.substring(idx + search.length)}</>
    )
  }

  /* ── Image helpers ──────────────────────────────────────────────── */
  function getImageUrl(fileId, size) {
    if (!fileId) return null
    if (fileId.startsWith('http')) return fileId
    // Supabase storage path
    if (fileId.includes('/')) {
      return supabase.storage.from('asset-images').getPublicUrl(fileId).data?.publicUrl
    }
    // Google Drive file ID
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size || 400}`
  }

  function handleImageSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) return alert('Image too large (max 5MB)')
    const reader = new FileReader()
    reader.onload = ev => {
      setImagePreview(ev.target.result)
      setImageData(file)
    }
    reader.readAsDataURL(file)
  }

  /* ── Open Add/Edit Modal ──────────────────────────────────────── */
  function openAddModal() {
    setFormData({ name: '', description: '', category: '', location: '', status: 'Active', serial_number: '' })
    setImageData(null); setImagePreview(null)
    setShowAssetModal(true)
  }

  function openEditModal(asset) {
    setFormData({ ...asset })
    setImagePreview(getImageUrl(asset.image_url))
    setImageData(null)
    setShowAssetModal(true)
  }

  /* ── Save Asset ────────────────────────────────────────────────── */
  async function saveAsset() {
    if (!formData.name?.trim()) return alert('Asset name is required')
    setSaving(true)
    try {
      let imageFileId = formData.image_url || ''

      if (imageData) {
        const path = `assets/${Date.now()}-${imageData.name}`
        const { error: upErr } = await supabase.storage.from('asset-images').upload(path, imageData)
        if (!upErr) imageFileId = path
      }

      const row = {
        name: formData.name,
        description: formData.description || '',
        category: formData.category || '',
        location: formData.location || '',
        status: formData.status || 'Active',
        serial_number: formData.serial_number || '',
        image_url: imageFileId,
        updated_at: new Date().toISOString(),
        updated_by: `${profile.first_name} ${profile.last_name?.charAt(0)}.`,
      }

      if (formData.asset_id) {
        const { data: rows, error } = await supabase.from('assets').update(row).eq('asset_id', formData.asset_id).select()
        if (error) throw error
        if (!rows || rows.length === 0) {
          alert('Save failed — you may not have permission to edit assets.')
          setSaving(false)
          return
        }
      } else {
        const { data: id } = await supabase.rpc('get_next_id', { p_type: 'asset' })
        row.asset_id = id || `AST-${Date.now()}`
        row.created_at = new Date().toISOString()
        row.created_by = `${profile.first_name} ${profile.last_name?.charAt(0)}.`
        const { data: rows, error } = await supabase.from('assets').insert(row).select()
        if (error) throw error
        if (!rows || rows.length === 0) {
          alert('Create failed — you may not have permission to add assets.')
          setSaving(false)
          return
        }
      }

      setShowAssetModal(false)
      loadAssets()
    } catch (e) {
      alert('Error: ' + e.message)
    }
    setSaving(false)
  }

  /* ── Delete Asset ──────────────────────────────────────────────── */
  async function deleteAsset(assetId) {
    if (!confirm('Delete this asset? This cannot be undone.')) return
    const { data: rows, error } = await supabase.from('assets').delete().eq('asset_id', assetId).select()
    if (error) { alert('Delete error: ' + error.message); return }
    if (!rows || rows.length === 0) {
      alert('Delete failed — you may not have permission to delete assets.')
      return
    }
    setShowViewModal(false)
    loadAssets()
  }

  /* ── Duplicate Asset ──────────────────────────────────────────── */
  function openDuplicateModal(asset) {
    setDuplicateSource(asset)
    setDuplicateSerial('')
    setShowDuplicateModal(true)
    setShowViewModal(false)
  }

  async function saveDuplicate() {
    if (!duplicateSerial.trim()) {
      alert('Serial number is required — each physical unit must have a unique serial number.')
      return
    }
    setDuplicateSaving(true)
    try {
      const fullName = `${profile.first_name} ${profile.last_name?.charAt(0)}.`
      const { data: id } = await supabase.rpc('get_next_id', { p_type: 'asset' })
      const row = {
        asset_id: id || `AST-${Date.now()}`,
        name: duplicateSource.name,
        description: duplicateSource.description || '',
        category: duplicateSource.category || '',
        location: duplicateSource.location || '',
        status: duplicateSource.status || 'Active',
        serial_number: duplicateSerial.trim(),
        image_url: duplicateSource.image_url || '',
        created_at: new Date().toISOString(),
        created_by: fullName,
        updated_at: new Date().toISOString(),
        updated_by: fullName,
      }
      const { data: rows, error } = await supabase.from('assets').insert(row).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        alert('Duplicate failed — you may not have permission to add assets.')
        setDuplicateSaving(false)
        return
      }
      setShowDuplicateModal(false)
      loadAssets()
    } catch (e) { alert('Error: ' + e.message) }
    setDuplicateSaving(false)
  }

  /* ── View Asset Detail ─────────────────────────────────────────── */
  function openViewModal(asset) {
    setViewAsset(asset)
    setShowViewModal(true)
    fetchSOPsForAsset(asset.asset_id)
  }

  /* ── Work Orders for Asset ─────────────────────────────────────── */
  async function openWOModal(assetId, assetName) {
    setWoAssetName(assetName)
    setAssetWOs([])
    setShowWOModal(true)

    // load open WOs
    const { data: openWOs } = await supabase
      .from('work_orders')
      .select('wo_id, description, priority, status')
      .eq('asset', assetName)
    // load closed WOs
    const { data: closedWOs } = await supabase
      .from('work_orders_closed')
      .select('wo_id, description, priority, status')
      .eq('asset', assetName)

    const combined = [
      ...(openWOs || []).map(w => ({ ...w, isClosed: false })),
      ...(closedWOs || []).map(w => ({ ...w, isClosed: true })),
    ]
    setAssetWOs(combined)
  }

  /* ── Documents for Asset ───────────────────────────────────────── */
  async function openDocsModal(assetId, assetName) {
    setDocAssetId(assetId)
    setDocAssetName(assetName)
    setAssetDocs([])
    setShowDocsModal(true)
    loadAssetDocs(assetId)
  }

  async function loadAssetDocs(assetId) {
    const { data } = await supabase
      .from('asset_documents')
      .select('*')
      .eq('asset_id', assetId)
    setAssetDocs(data || [])
  }

  async function uploadDoc() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,.doc,.docx,.txt,.xls,.xlsx,.png,.jpg,.jpeg'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      setPendingDocFile(file)
      setSelectedDocType('Document')
      setShowDocTypeModal(true)
    }
    input.click()
  }

  async function confirmDocUpload() {
    if (!pendingDocFile) return
    setDocUploading(true)
    try {
      const file = pendingDocFile
      const path = `asset-docs/${docAssetId}/${Date.now()}-${file.name}`
      const { error: upErr } = await supabase.storage.from('asset-documents').upload(path, file)
      if (upErr) { alert('Upload error: ' + upErr.message); return }

      const { data: nextId } = await supabase.rpc('get_next_id', { p_type: 'document' })
      const docId = nextId || `DOC-${Date.now()}`

      const { data: docRows, error: docErr } = await supabase.from('asset_documents').insert({
        document_id: docId,
        asset_id: docAssetId,
        document_name: file.name,
        document_type: selectedDocType,
        file_url: path,
        uploaded_by: `${profile.first_name} ${profile.last_name?.charAt(0)}.`,
        uploaded_at: new Date().toISOString(),
      }).select()
      if (docErr) { alert('Insert error: ' + docErr.message); return }
      if (!docRows || docRows.length === 0) {
        alert('Upload failed — file saved to storage but database insert was blocked. Check permissions.')
        return
      }
      loadAssetDocs(docAssetId)
    } finally {
      setDocUploading(false)
      setShowDocTypeModal(false)
      setPendingDocFile(null)
    }
  }

  async function deleteDoc(docId) {
    if (!confirm('Delete this document?')) return
    const { data: rows, error } = await supabase.from('asset_documents').delete().eq('document_id', docId).select()
    if (error) { alert('Delete error: ' + error.message); return }
    if (!rows || rows.length === 0) {
      alert('Delete failed — you may not have permission to delete documents.')
      return
    }
    loadAssetDocs(docAssetId)
  }

  function getDocUrl(filePath) {
    if (!filePath) return '#'
    return supabase.storage.from('asset-documents').getPublicUrl(filePath).data?.publicUrl || '#'
  }

  /* ── Print Labels ──────────────────────────────────────────────── */
  function openLabelsModal() {
    setSelectedLabelIds([])
    setShowLabelsModal(true)
  }

  function toggleLabelAsset(assetId) {
    setSelectedLabelIds(prev =>
      prev.includes(assetId) ? prev.filter(id => id !== assetId) : [...prev, assetId]
    )
  }

  function toggleAllLabels() {
    if (selectedLabelIds.length === assets.length) setSelectedLabelIds([])
    else setSelectedLabelIds(assets.map(a => a.asset_id))
  }

  function previewLabels() {
    if (selectedLabelIds.length === 0) return alert('Please select at least one asset')
    setShowLabelsPreview(true)
  }

  function getQRUrl(assetId) {
    const scanUrl = `${window.location.origin}/assets/scan?assetId=${encodeURIComponent(assetId)}`
    return `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(scanUrl)}`
  }

  function printLabels() {
    const selectedAssets = assets.filter(a => selectedLabelIds.includes(a.asset_id))
    const content = selectedAssets.map(a => {
      const qrUrl = getQRUrl(a.asset_id)
      const snLine = a.serial_number ? `<div class="asset-serial">SN: ${a.serial_number}</div>` : ''
      return `<div class="label-preview-item"><div class="qr-code"><img src="${qrUrl}"></div><div class="label-text"><div class="asset-num">${a.asset_id}</div><div class="asset-title">${a.name}</div>${snLine}</div></div>`
    }).join('')

    const printWin = window.open('', '_blank')
    printWin.document.write(`<html><head><title>Asset Labels</title><style>
      @page { size: 2in 1in; margin: 0; }
      body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
      .label-preview-item { width: 2in; height: 1in; border: 1px solid #ccc; padding: 10px 10px 2px 4px; display: flex; gap: 6px; page-break-after: always; box-sizing: border-box; }
      .qr-code { width: 0.8in; height: 0.8in; } .qr-code img { width: 100%; height: 100%; }
      .label-text { flex: 1; display: flex; flex-direction: column; justify-content: center; overflow: hidden; }
      .asset-num { font-size: 14px; font-weight: bold; margin-bottom: 2px; }
      .asset-title { font-size: 9px; line-height: 1.2; }
      .asset-serial { font-size: 8px; color: #555; margin-top: 2px; }
    </style></head><body>${content}</body></html>`)
    printWin.document.close()
    setTimeout(() => printWin.print(), 500)
    setShowLabelsPreview(false)
    setShowLabelsModal(false)
  }

  /* ── Print Asset List ────────────────────────────────────────────── */
  function printAssetList() {
    const listData = sortedAssets
    if (listData.length === 0) return alert('No assets to print — adjust your filters.')

    const rows = listData.map(a => {
      const sn = a.serial_number ? a.serial_number : '—'
      return `<tr>
        <td>${a.asset_id}</td>
        <td>${a.name}</td>
        <td style="font-family:monospace;font-size:0.85em">${sn}</td>
        <td>${a.category || '—'}</td>
        <td>${a.location || '—'}</td>
        <td>${a.status}</td>
      </tr>`
    }).join('')

    const filterNotes = []
    if (search) filterNotes.push(`Search: "${search}"`)
    if (categoryFilter) filterNotes.push(`Category: ${categoryFilter}`)
    if (locationFilter) filterNotes.push(`Location: ${locationFilter}`)
    if (statusFilter) filterNotes.push(`Status: ${statusFilter}`)
    const filterLine = filterNotes.length > 0
      ? `<div style="font-size:11px;color:#666;margin-bottom:8px">Filters: ${filterNotes.join(' · ')}</div>`
      : ''

    const printWin = window.open('', '_blank')
    printWin.document.write(`<html><head><title>Asset List</title><style>
      @page { size: landscape; margin: 0.5in; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin: 0; padding: 0; }
      h2 { margin: 0 0 4px; font-size: 16px; }
      .meta { font-size: 11px; color: #666; margin-bottom: 12px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
      th { background: #f0f0f0; font-size: 11px; text-transform: uppercase; }
      tr:nth-child(even) { background: #fafafa; }
    </style></head><body>
      <h2>RICT CMMS — Asset List</h2>
      <div class="meta">Printed ${new Date().toLocaleDateString()} · ${listData.length} item${listData.length !== 1 ? 's' : ''}</div>
      ${filterLine}
      <table>
        <thead><tr><th>Asset ID</th><th>Name</th><th>Serial #</th><th>Category</th><th>Location</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>`)
    printWin.document.close()
    setTimeout(() => printWin.print(), 400)
  }

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  RENDER                                                           */
  /* ═══════════════════════════════════════════════════════════════════ */

  return (
    <div className="assets-page">
      {/* ── Toolbar ───────────────────────────────────────────────── */}
      <div className="page-toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <span className="material-icons">search</span>
            <input type="text" placeholder="Search assets..." value={search} onChange={e => setSearch(e.target.value)} aria-label="Search assets" />
          </div>
          <select className="filter-select" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} aria-label="Filter by category">
            <option value="">All Categories</option>
            {categories.map(c => <option key={c.category_id} value={c.category_name}>{c.category_name}</option>)}
          </select>
          <select className="filter-select" value={locationFilter} onChange={e => setLocationFilter(e.target.value)} aria-label="Filter by location">
            <option value="">All Locations</option>
            {locations.map(l => <option key={l.location_id} value={l.location_name}>{l.location_name}</option>)}
          </select>
          <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter by status">
            <option value="">All Status</option>
            <option value="Active">Active</option>
            <option value="Archived">Archived</option>
          </select>
        </div>
        <div className="toolbar-right" style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={printAssetList} title="Print a clean one-line-per-asset list">
            <span className="material-icons">list_alt</span>Print List
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/assets/scan')} title="Scan QR code to look up an asset">
            <span className="material-icons">qr_code_scanner</span>Asset Lookup
          </button>
          {hasPerm('print_labels') && (
            <button className="btn btn-secondary" onClick={openLabelsModal}>
              <span className="material-icons">print</span>Print Labels
            </button>
          )}
          {hasPerm('add_assets') && (
            <button className="btn btn-primary" onClick={openAddModal}>
              <span className="material-icons">add</span>Add Asset
            </button>
          )}
        </div>
      </div>

      {/* ── Assets Table ──────────────────────────────────────────── */}
      {loading ? (
        <div className="loading-message">Loading assets...</div>
      ) : filtered.length === 0 ? (
        <div className="no-assets-message">
          <span className="material-icons">inventory_2</span>
          <h3>No Assets Found</h3>
          <p>No assets match your search criteria.</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <div className="table-header-bar">
            <span className="badge">{filtered.length}</span>
          </div>
          <table className="data-table" aria-label="Assets list">
            <thead>
              <tr>
                <th className="col-img" scope="col"><span className="sr-only">Image</span></th>
                <th className="sortable-th" onClick={() => handleSort('name')} scope="col">Name {sortCol === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th className="sortable-th" onClick={() => handleSort('serial_number')} scope="col">Serial # {sortCol === 'serial_number' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th className="sortable-th" onClick={() => handleSort('category')} scope="col">Category {sortCol === 'category' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th className="sortable-th" onClick={() => handleSort('location')} scope="col">Location {sortCol === 'location' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th className="sortable-th" onClick={() => handleSort('status')} scope="col">Status {sortCol === 'status' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</th>
              </tr>
            </thead>
            <tbody>
              {sortedAssets.map(asset => {
                const imgUrl = getImageUrl(asset.image_url)
                const statusClass = asset.status === 'Active' ? 'active' : 'archived'
                const rowClass = asset.status === 'Archived' ? 'inactive' : ''
                return (
                  <tr
                    key={asset.asset_id}
                    className={`${rowClass} clickable-row`}
                    onClick={() => openViewModal(asset)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewModal(asset) } }}
                    tabIndex={0}
                    role="button"
                    aria-label={`View details for ${asset.name}`}
                  >
                    <td className="col-img">
                      <div className="part-thumb">
                        {imgUrl
                          ? <img src={imgUrl} alt={asset.name} referrerPolicy="no-referrer" />
                          : <span className="material-icons" aria-hidden="true">precision_manufacturing</span>
                        }
                      </div>
                    </td>
                    <td>
                      <strong>{highlightMatch(asset.name)}</strong><br />
                      <small style={{ color: '#868e96' }}>{highlightMatch(asset.asset_id)}</small>
                      {assetSopCounts[asset.asset_id] > 0 && (
                        <button
                          className="sop-badge sop-badge-btn"
                          title={`${assetSopCounts[asset.asset_id]} SOP${assetSopCounts[asset.asset_id] > 1 ? 's' : ''} linked — click to view`}
                          onClick={e => { e.stopPropagation(); navigate(`/sops?asset=${asset.asset_id}`) }}
                          aria-label={`View ${assetSopCounts[asset.asset_id]} linked SOPs for ${asset.name}`}
                        >
                          📋 {assetSopCounts[asset.asset_id]} SOP{assetSopCounts[asset.asset_id] > 1 ? 's' : ''}
                        </button>
                      )}
                    </td>
                    <td>
                      {asset.serial_number
                        ? <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{highlightMatch(asset.serial_number)}</span>
                        : <span style={{ color: '#ced4da', fontSize: '0.8rem' }}>—</span>
                      }
                    </td>
                    <td>{highlightMatch(asset.category || '-')}</td>
                    <td>{highlightMatch(asset.location || '-')}</td>
                    <td><span className={`asset-status ${statusClass}`}>{asset.status}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* MODALS                                                        */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {/* ── Add/Edit Asset Modal ─────────────────────────────────── */}
      {showAssetModal && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title" onClick={e => e.target === e.currentTarget && setShowAssetModal(false)} onKeyDown={e => e.key === 'Escape' && setShowAssetModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="asset-modal-title">{formData.asset_id ? 'Edit Asset' : 'Add New Asset'}</h3>
              <button className="modal-close" onClick={() => setShowAssetModal(false)} aria-label="Close form">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Asset Name *</label>
                  <input type="text" className="form-input" placeholder="Enter asset name"
                    value={formData.name || ''}
                    onChange={e => setFormData({ ...formData, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Status</label>
                  <select className="form-input" value={formData.status || 'Active'}
                    onChange={e => setFormData({ ...formData, status: e.target.value })}>
                    <option value="Active">Active</option>
                    <option value="Archived">Archived</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Serial Number</label>
                  <input type="text" className="form-input" placeholder="e.g. SN-12345 (leave blank if N/A)"
                    style={{ fontFamily: 'monospace' }}
                    value={formData.serial_number || ''}
                    onChange={e => setFormData({ ...formData, serial_number: e.target.value })} />
                </div>
                <div className="form-group" />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-input" rows={3} placeholder="Enter description"
                  value={formData.description || ''}
                  onChange={e => setFormData({ ...formData, description: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Category</label>
                  <select className="form-input" value={formData.category || ''}
                    onChange={e => setFormData({ ...formData, category: e.target.value })}>
                    <option value="">Select category</option>
                    {categories.map(c => <option key={c.category_id} value={c.category_name}>{c.category_name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Location</label>
                  <select className="form-input" value={formData.location || ''}
                    onChange={e => setFormData({ ...formData, location: e.target.value })}>
                    <option value="">Select location</option>
                    {locations.map(l => <option key={l.location_id} value={l.location_name}>{l.location_name}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Image</label>
                <div className="image-upload-area" onClick={() => document.getElementById('asset-image-input')?.click()}>
                  <input type="file" id="asset-image-input" accept="image/*" style={{ display: 'none' }} onChange={handleImageSelect} />
                  {imagePreview ? (
                    <div className="image-preview-wrap">
                      <img src={imagePreview} alt="Preview" style={{ maxHeight: 200, borderRadius: 8 }} referrerPolicy="no-referrer" />
                      <button className="remove-image-btn" onClick={e => { e.stopPropagation(); setImagePreview(null); setImageData(null) }}>
                        <span className="material-icons">close</span>
                      </button>
                    </div>
                  ) : (
                    <div className="upload-placeholder">
                      <span className="material-icons">cloud_upload</span>
                      <p>Click or drag image here</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowAssetModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={saveAsset}>
                {saving ? 'Saving...' : 'Save Asset'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Asset Detail Modal ──────────────────────────────── */}
      {showViewModal && viewAsset && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="view-modal-title" onClick={e => e.target === e.currentTarget && setShowViewModal(false)} onKeyDown={e => e.key === 'Escape' && setShowViewModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="view-modal-title">Asset Details</h3>
              <button className="modal-close" onClick={() => setShowViewModal(false)} aria-label="Close asset details">&times;</button>
            </div>
            <div className="modal-body">
              <div className="asset-detail-header">
                <div className="asset-detail-image">
                  {getImageUrl(viewAsset.image_url)
                    ? <img src={getImageUrl(viewAsset.image_url)} alt="" referrerPolicy="no-referrer" />
                    : <span className="material-icons">precision_manufacturing</span>
                  }
                </div>
                <div className="asset-detail-info">
                  <h2>{viewAsset.name}</h2>
                  <div className="asset-detail-id">
                    {viewAsset.asset_id}{' '}
                    <span className={`asset-status ${viewAsset.status === 'Active' ? 'active' : 'archived'}`}>
                      {viewAsset.status}
                    </span>
                  </div>
                </div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Serial Number</div>
                <div className="detail-value">
                  {viewAsset.serial_number
                    ? <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{viewAsset.serial_number}</span>
                    : <span style={{ color: '#adb5bd' }}>Not recorded</span>
                  }
                </div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Description</div>
                <div className="detail-value">{viewAsset.description || '-'}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Category</div>
                <div className="detail-value">{viewAsset.category || '-'}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Location</div>
                <div className="detail-value">{viewAsset.location || '-'}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Created</div>
                <div className="detail-value">{viewAsset.created_by} — {formatDate(viewAsset.created_at)}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Last Updated</div>
                <div className="detail-value">{viewAsset.updated_by} — {formatDate(viewAsset.updated_at)}</div>
              </div>

              {/* ── Linked SOPs ──────────────────────────────────── */}
              <div className="linked-sops-section">
                <div className="linked-sops-header">
                  <span className="material-icons" style={{ color: '#1971c2', fontSize: '1.1rem' }}>menu_book</span>
                  <strong>Linked SOPs {viewModalSOPsLoading ? '' : `(${viewModalSOPs.length})`}</strong>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => navigate(`/sops?asset=${viewAsset.asset_id}`)}
                    title="Open SOPs page filtered to this asset"
                  >
                    <span className="material-icons" style={{ fontSize: '0.9rem' }}>open_in_new</span>View All
                  </button>
                </div>
                {viewModalSOPsLoading ? (
                  <div style={{ color: '#868e96', fontSize: '0.85rem', padding: '8px 0' }}>Loading…</div>
                ) : viewModalSOPs.length === 0 ? (
                  <div style={{ color: '#adb5bd', fontSize: '0.85rem', padding: '8px 0' }}>No SOPs linked to this asset.</div>
                ) : (
                  <div className="linked-sops-list">
                    {viewModalSOPs.map(sop => (
                      <div key={sop.sop_id} className="linked-sop-item">
                        <div className="linked-sop-icon">
                          <span className="material-icons">description</span>
                        </div>
                        <div className="linked-sop-info">
                          <div className="linked-sop-name">{sop.name}</div>
                          <div className="linked-sop-meta">{sop.sop_id} · Updated {formatDate(sop.updated_at)} by {sop.updated_by}</div>
                        </div>
                        <div className="linked-sop-actions">
                          {sop.document_url && (
                            <a
                              href={sop.document_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="action-btn"
                              title="Open PDF"
                              onClick={e => e.stopPropagation()}
                            >
                              <span className="material-icons">picture_as_pdf</span>
                            </a>
                          )}
                          <button
                            className="action-btn"
                            title="Go to SOP"
                            onClick={() => { setShowViewModal(false); navigate(`/sops?open=${sop.sop_id}`) }}
                          >
                            <span className="material-icons">open_in_new</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setShowViewModal(false); openWOModal(viewAsset.asset_id, viewAsset.name) }}
                  aria-label="View work orders for this asset"
                >
                  <span className="material-icons" style={{ fontSize: '1rem' }} aria-hidden="true">assignment</span>Work Orders
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setShowViewModal(false); openDocsModal(viewAsset.asset_id, viewAsset.name) }}
                  aria-label="View documents for this asset"
                >
                  <span className="material-icons" style={{ fontSize: '1rem' }} aria-hidden="true">description</span>Documents
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" onClick={() => setShowViewModal(false)}>Close</button>
                {hasPerm('duplicate_assets') && (
                  <button className="btn btn-secondary" style={{ color: '#7c3aed', borderColor: '#7c3aed' }}
                    onClick={() => openDuplicateModal(viewAsset)}
                    aria-label="Duplicate this asset">
                    <span className="material-icons" style={{ fontSize: '1rem' }} aria-hidden="true">content_copy</span>Duplicate
                  </button>
                )}
                {hasPerm('edit_assets') && (
                  <button className="btn btn-primary" onClick={() => { setShowViewModal(false); openEditModal(viewAsset) }}
                    aria-label="Edit this asset">Edit</button>
                )}
                {hasPerm('delete_assets') && (
                  <button className="btn btn-danger" onClick={() => deleteAsset(viewAsset.asset_id)}
                    aria-label="Delete this asset">Delete</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Duplicate Asset Modal ────────────────────────────────── */}
      {showDuplicateModal && duplicateSource && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="dup-modal-title" onClick={e => e.target === e.currentTarget && setShowDuplicateModal(false)} onKeyDown={e => e.key === 'Escape' && setShowDuplicateModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="dup-modal-title"><span className="material-icons" style={{ color: '#7c3aed' }} aria-hidden="true">content_copy</span>Duplicate Asset</h3>
              <button className="modal-close" onClick={() => setShowDuplicateModal(false)} aria-label="Close duplicate form">&times;</button>
            </div>
            <div className="modal-body">
              <div style={{ background: '#f3e8ff', border: '1px solid #d8b4fe', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10 }}>
                <span className="material-icons" style={{ color: '#7c3aed', fontSize: '1.1rem', marginTop: 1, flexShrink: 0 }}>info</span>
                <div>
                  <div style={{ fontWeight: 600, color: '#5b21b6', marginBottom: 2 }}>Creating a copy of this asset</div>
                  <div style={{ fontSize: '0.85rem', color: '#6b21a8' }}>
                    All fields below will be copied to the new asset with a new auto-assigned Asset ID.
                    You must enter a unique serial number for this specific unit.
                  </div>
                </div>
              </div>
              <div style={{ background: '#f8f9fa', borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#868e96', textTransform: 'uppercase', marginBottom: 10, letterSpacing: '0.5px' }}>
                  Copying from: {duplicateSource.asset_id}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: '0.875rem' }}>
                  <div><span style={{ color: '#868e96' }}>Name: </span><strong>{duplicateSource.name}</strong></div>
                  <div><span style={{ color: '#868e96' }}>Category: </span><strong>{duplicateSource.category || '—'}</strong></div>
                  <div><span style={{ color: '#868e96' }}>Location: </span><strong>{duplicateSource.location || '—'}</strong></div>
                  <div><span style={{ color: '#868e96' }}>Status: </span><strong>{duplicateSource.status || 'Active'}</strong></div>
                  {duplicateSource.description && (
                    <div style={{ gridColumn: '1/-1' }}>
                      <span style={{ color: '#868e96' }}>Description: </span>{duplicateSource.description}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ background: '#fffbeb', border: '2px solid #fbbf24', borderRadius: 8, padding: 16 }}>
                <label style={{ display: 'block', fontWeight: 700, color: '#92400e', marginBottom: 8, fontSize: '0.9rem' }}>
                  <span className="material-icons" style={{ fontSize: '1rem', verticalAlign: 'middle', marginRight: 4 }}>tag</span>
                  Serial Number for New Unit *
                </label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Enter the serial number found on this specific unit"
                  value={duplicateSerial}
                  onChange={e => setDuplicateSerial(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveDuplicate()}
                  autoFocus
                  style={{ fontFamily: 'monospace', fontSize: '1rem', borderColor: duplicateSerial.trim() ? '#fbbf24' : '#f87171' }}
                />
                <div style={{ fontSize: '0.78rem', color: '#92400e', marginTop: 6 }}>
                  Required — every physical unit needs its own serial number for proper asset tracking.
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowDuplicateModal(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
                disabled={duplicateSaving || !duplicateSerial.trim()}
                onClick={saveDuplicate}>
                <span className="material-icons" style={{ fontSize: '1rem' }}>content_copy</span>
                {duplicateSaving ? 'Creating...' : 'Confirm & Create Duplicate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Work Orders Modal ────────────────────────────────────── */}
      {showWOModal && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="wo-modal-title" onClick={e => e.target === e.currentTarget && setShowWOModal(false)} onKeyDown={e => e.key === 'Escape' && setShowWOModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="wo-modal-title"><span className="material-icons" aria-hidden="true">assignment</span>Work Orders for {woAssetName}</h3>
              <button className="modal-close" onClick={() => setShowWOModal(false)} aria-label="Close work orders">&times;</button>
            </div>
            <div className="modal-body">
              {assetWOs.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#868e96', padding: 40 }}>No work orders for this asset.</p>
              ) : (
                <div className="wo-list">
                  {assetWOs.map(wo => (
                    <div key={wo.wo_id} className={`wo-item${wo.isClosed ? ' closed' : ''}`}>
                      <div className="wo-info">
                        <h4>{wo.wo_id} — {wo.description}</h4>
                        <p>Priority: {wo.priority}</p>
                      </div>
                      <span className={`wo-status ${wo.isClosed ? 'closed' : 'open'}`}>
                        {wo.isClosed ? 'Closed' : wo.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowWOModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Documents Modal ──────────────────────────────────────── */}
      {showDocsModal && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="docs-modal-title" onClick={e => e.target === e.currentTarget && setShowDocsModal(false)} onKeyDown={e => e.key === 'Escape' && setShowDocsModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="docs-modal-title"><span className="material-icons" aria-hidden="true">description</span>Documents for {docAssetName}</h3>
              <button className="modal-close" onClick={() => setShowDocsModal(false)} aria-label="Close documents">&times;</button>
            </div>
            <div className="modal-body">
              {assetDocs.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#868e96', padding: 40 }}>No documents for this asset.</p>
              ) : (
                <div className="documents-list">
                  {assetDocs.map(d => (
                    <div className="document-item" key={d.document_id}>
                      <div className="document-icon">
                        <span className="material-icons">description</span>
                      </div>
                      <div className="document-info">
                        <h4>{d.document_name}</h4>
                        <p>{d.document_type}</p>
                      </div>
                      <div className="document-actions">
                        <a href={getDocUrl(d.file_url)} target="_blank" rel="noopener noreferrer"
                          className="btn btn-sm btn-secondary">
                          <span className="material-icons">visibility</span>
                        </a>
                        {hasPerm('delete_assets') && (
                          <button className="btn btn-sm btn-danger" onClick={() => deleteDoc(d.document_id)}>
                            <span className="material-icons">delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowDocsModal(false)}>Close</button>
              {hasPerm('upload_docs') && (
                <button className="btn btn-primary" onClick={uploadDoc}>
                  <span className="material-icons">upload_file</span>Upload
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Document Type Modal ───────────────────────────────── */}
      {showDocTypeModal && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="doctype-modal-title" onClick={e => e.target === e.currentTarget && !docUploading && (setShowDocTypeModal(false), setPendingDocFile(null))} onKeyDown={e => e.key === 'Escape' && !docUploading && (setShowDocTypeModal(false), setPendingDocFile(null))}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3 id="doctype-modal-title"><span className="material-icons" aria-hidden="true">label</span>Classify Document</h3>
              <button className="modal-close" onClick={() => { if (!docUploading) { setShowDocTypeModal(false); setPendingDocFile(null) } }} aria-label="Close document type selection">&times;</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '0.85rem', color: '#495057', marginTop: 0, marginBottom: 16 }}>
                Choose a category for <strong>{pendingDocFile?.name}</strong> so it's easy to find later.
              </p>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Document Type</label>
                <select
                  className="form-input"
                  value={selectedDocType}
                  onChange={e => setSelectedDocType(e.target.value)}
                >
                  <option value="Document">Document</option>
                  <option value="Manual">Manual</option>
                  <option value="Schematic">Schematic</option>
                  <option value="Wiring Diagram">Wiring Diagram</option>
                  <option value="Datasheet">Datasheet</option>
                  <option value="Safety Data Sheet">Safety Data Sheet</option>
                  <option value="Warranty">Warranty</option>
                  <option value="Invoice">Invoice</option>
                  <option value="Photo">Photo</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" disabled={docUploading} onClick={() => { setShowDocTypeModal(false); setPendingDocFile(null) }}>Cancel</button>
              <button className="btn btn-primary" disabled={docUploading} onClick={confirmDocUpload}>
                {docUploading ? (
                  <><span className="material-icons" style={{ fontSize: '1rem', animation: 'spin 1s linear infinite' }}>sync</span>Uploading...</>
                ) : (
                  <><span className="material-icons">upload_file</span>Upload</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Print Labels Selection Modal ─────────────────────────── */}
      {showLabelsModal && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="labels-modal-title" onClick={e => e.target === e.currentTarget && setShowLabelsModal(false)} onKeyDown={e => e.key === 'Escape' && setShowLabelsModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="labels-modal-title"><span className="material-icons" aria-hidden="true">print</span>Print Asset Labels</h3>
              <button className="modal-close" onClick={() => setShowLabelsModal(false)} aria-label="Close label selection">&times;</button>
            </div>
            <div className="modal-body">
              <div className="labels-select-header">
                <label className="select-all-label">
                  <input type="checkbox"
                    checked={selectedLabelIds.length === assets.length && assets.length > 0}
                    onChange={toggleAllLabels} />
                  <span>Select All</span>
                </label>
                <span className="labels-count">{selectedLabelIds.length} selected</span>
              </div>
              <div className="labels-asset-list">
                {assets.map(a => {
                  const thumbUrl = getImageUrl(a.image_url)
                  return (
                    <div key={a.asset_id} className="label-select-item"
                      onClick={() => toggleLabelAsset(a.asset_id)}>
                      <input type="checkbox"
                        checked={selectedLabelIds.includes(a.asset_id)}
                        onChange={() => { }}
                        onClick={e => e.stopPropagation()} />
                      <div className="asset-thumb">
                        {thumbUrl
                          ? <img src={thumbUrl} alt="" />
                          : <span className="material-icons">precision_manufacturing</span>
                        }
                      </div>
                      <div className="asset-details">
                        <strong>{a.asset_id}</strong>
                        <small>{a.name}</small>
                        {a.serial_number && <small style={{ color: '#7c3aed' }}>SN: {a.serial_number}</small>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowLabelsModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={previewLabels}>
                <span className="material-icons">visibility</span>Preview Labels
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Labels Preview Modal ─────────────────────────────────── */}
      {showLabelsPreview && (
        <div className="modal-overlay visible" role="dialog" aria-modal="true" aria-labelledby="preview-modal-title" onClick={e => e.target === e.currentTarget && setShowLabelsPreview(false)} onKeyDown={e => e.key === 'Escape' && setShowLabelsPreview(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3 id="preview-modal-title"><span className="material-icons" aria-hidden="true">visibility</span>Label Preview</h3>
              <button className="modal-close" onClick={() => setShowLabelsPreview(false)} aria-label="Close label preview">&times;</button>
            </div>
            <div className="modal-body">
              <div className="labels-preview-grid">
                {assets.filter(a => selectedLabelIds.includes(a.asset_id)).map(a => (
                  <div key={a.asset_id} className="label-preview-item">
                    <div className="qr-code">
                      <img src={getQRUrl(a.asset_id)} alt="QR" />
                    </div>
                    <div className="label-text">
                      <div className="asset-num">{a.asset_id}</div>
                      <div className="asset-title">{a.name}</div>
                      {a.serial_number && <div className="asset-serial-preview">SN: {a.serial_number}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowLabelsPreview(false)}>Back</button>
              <button className="btn btn-primary" onClick={printLabels}>
                <span className="material-icons">print</span>Print
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Styles (matching old GAS system) ─────────────────────── */}
      <style>{`
        .page-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
        .toolbar-left { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .search-box { display: flex; align-items: center; gap: 8px; background: white; border: 1px solid #dee2e6; border-radius: 8px; padding: 8px 12px; }
        .search-box input { border: none; outline: none; font-size: 0.9rem; min-width: 200px; }
        .search-box .material-icons { color: #868e96; }
        .filter-select { padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; background: white; }
        .filter-select:focus-visible { outline: 2px solid #228be6; outline-offset: 2px; }
        .table-wrapper { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .table-header-bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e9ecef; }
        .badge { background: #228be6; color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; }
        .data-table { width: 100%; border-collapse: collapse; }
        .data-table th, .data-table td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e9ecef; }
        .data-table th { background: #f8f9fa; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
        .sortable-th { cursor: pointer; user-select: none; white-space: nowrap; }
        .sortable-th:hover { background: #e9ecef; }
        .data-table tr:hover { background: #f8f9fa; }
        .data-table tr.clickable-row { cursor: pointer; transition: background 0.15s; }
        .data-table tr.clickable-row:focus-visible { outline: 2px solid #228be6; outline-offset: -2px; background: #e7f5ff; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .data-table tr.inactive { opacity: 0.5; }
        .col-img { width: 60px; }
        .part-thumb { width: 48px; height: 48px; background: #f8f9fa; border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .part-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .part-thumb .material-icons { font-size: 1.5rem; color: #dee2e6; }
        .action-btn { background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px; color: #495057; }
        .action-btn:hover { background: #e9ecef; }
        .action-btn.danger:hover { background: #ffe3e3; color: #c92a2a; }
        .action-btn .material-icons { font-size: 1.1rem; }
        .asset-status { font-size: 0.75rem; padding: 4px 8px; border-radius: 4px; font-weight: 500; }
        .asset-status.active { background: #d3f9d8; color: #2b8a3e; }
        .asset-status.archived { background: #ffe3e3; color: #c92a2a; }
        .no-assets-message { text-align: center; padding: 60px 20px; color: #868e96; }
        .no-assets-message .material-icons { font-size: 4rem; margin-bottom: 16px; display: block; }
        .no-assets-message h3 { margin: 0 0 8px; }
        .no-assets-message p { margin: 0; }
        .loading-message { text-align: center; padding: 60px 20px; color: #868e96; }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
        .modal-overlay.visible { display: flex; }
        .modal { background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; }
        .modal-lg { max-width: 700px; }
        .modal-header { padding: 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h3 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px; }
        .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; }
        .modal-close:focus-visible { outline: 2px solid #228be6; outline-offset: 2px; border-radius: 4px; }
        .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
        .modal-footer { padding: 16px 20px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 0.85rem; font-weight: 500; color: #495057; margin-bottom: 6px; }
        .form-input { width: 100%; padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; font-family: inherit; box-sizing: border-box; }
        .form-input:focus { outline: none; border-color: #228be6; }
        .image-upload-area { border: 2px dashed #dee2e6; border-radius: 8px; padding: 30px; text-align: center; cursor: pointer; transition: border-color 0.2s; }
        .image-upload-area:hover { border-color: #228be6; }
        .upload-placeholder .material-icons { font-size: 3rem; color: #dee2e6; }
        .upload-placeholder p { margin: 8px 0 0; color: #868e96; font-size: 0.85rem; }
        .image-preview-wrap { position: relative; display: inline-block; }
        .remove-image-btn { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.5); color: white; border: none; border-radius: 50%; width: 28px; height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .asset-detail-header { display: flex; gap: 20px; margin-bottom: 20px; }
        .asset-detail-image { width: 200px; height: 200px; background: #f8f9fa; border-radius: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .asset-detail-image img { width: 100%; height: 100%; object-fit: cover; }
        .asset-detail-image .material-icons { font-size: 4rem; color: #dee2e6; }
        .asset-detail-info { flex: 1; }
        .asset-detail-info h2 { margin: 0 0 8px; }
        .asset-detail-id { color: #868e96; font-size: 0.9rem; }
        .detail-row { display: flex; padding: 12px 0; border-bottom: 1px solid #e9ecef; }
        .detail-label { width: 140px; font-weight: 500; color: #495057; }
        .detail-value { flex: 1; }
        .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
        .btn:focus-visible { outline: 2px solid #228be6; outline-offset: 2px; }
        .btn-primary { background: #228be6; color: white; } .btn-primary:disabled { opacity: 0.6; }
        .btn-secondary { background: #f8f9fa; color: #495057; }
        .btn-danger { background: #fa5252; color: white; }
        .btn-sm { padding: 6px 12px; font-size: 0.8rem; }
        .wo-list { display: flex; flex-direction: column; gap: 12px; }
        .wo-item { display: flex; justify-content: space-between; align-items: center; padding: 16px; background: #f8f9fa; border-radius: 8px; }
        .wo-item.closed { opacity: 0.6; }
        .wo-info h4 { margin: 0 0 4px; font-size: 0.95rem; }
        .wo-info p { margin: 0; font-size: 0.85rem; color: #868e96; }
        .wo-status { padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
        .wo-status.open { background: #e7f5ff; color: #1971c2; }
        .wo-status.closed { background: #d3f9d8; color: #2b8a3e; }
        .documents-list { display: flex; flex-direction: column; gap: 12px; }
        .document-item { display: flex; align-items: center; gap: 16px; padding: 16px; background: #f8f9fa; border-radius: 8px; }
        .document-icon { width: 48px; height: 48px; background: #e7f5ff; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
        .document-icon .material-icons { color: #228be6; }
        .document-info { flex: 1; }
        .document-info h4 { margin: 0 0 4px; font-size: 0.95rem; }
        .document-info p { margin: 0; font-size: 0.8rem; color: #868e96; }
        .document-actions { display: flex; gap: 8px; }
        .labels-select-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #e7f5ff; border-radius: 8px; margin-bottom: 16px; }
        .select-all-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500; }
        .select-all-label input { width: 18px; height: 18px; cursor: pointer; }
        .labels-count { color: #495057; font-size: 0.9rem; }
        .labels-asset-list { max-height: 400px; overflow-y: auto; }
        .label-select-item { display: flex; align-items: center; gap: 12px; padding: 12px; border-bottom: 1px solid #e9ecef; cursor: pointer; }
        .label-select-item:hover { background: #f8f9fa; }
        .label-select-item input { width: 18px; height: 18px; cursor: pointer; }
        .asset-thumb { width: 50px; height: 50px; background: #f1f3f5; border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        .asset-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .asset-thumb .material-icons { color: #adb5bd; }
        .asset-details { flex: 1; }
        .asset-details strong { display: block; margin-bottom: 2px; }
        .asset-details small { color: #868e96; }
        .labels-preview-grid { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
        .label-preview-item { width: 200px; height: 100px; border: 1px solid #dee2e6; border-radius: 4px; padding: 8px; display: flex; gap: 8px; background: white; }
        .qr-code { width: 80px; height: 80px; flex-shrink: 0; }
        .qr-code img { width: 100%; height: 100%; }
        .label-text { flex: 1; display: flex; flex-direction: column; justify-content: center; overflow: hidden; }
        .asset-num { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
        .asset-title { font-size: 10px; color: #495057; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .asset-serial-preview { font-size: 9px; color: #7c3aed; margin-top: 3px; }
        .sop-badge { display: inline-flex; align-items: center; gap: 3px; margin-top: 4px; background: #e7f5ff; color: #1971c2; font-size: 0.72rem; font-weight: 600; padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
        .sop-badge-btn { border: none; cursor: pointer; transition: background 0.15s, transform 0.1s; }
        .sop-badge-btn:hover { background: #d0ebff; transform: translateY(-1px); }
        .linked-sops-section { margin-top: 20px; border-top: 1px solid #e9ecef; padding-top: 16px; }
        .linked-sops-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 0.95rem; }
        .linked-sops-list { display: flex; flex-direction: column; gap: 8px; }
        .linked-sop-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #f8f9fa; border-radius: 8px; border-left: 3px solid #339af0; }
        .linked-sop-icon { width: 34px; height: 34px; background: #e7f5ff; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .linked-sop-icon .material-icons { color: #1971c2; font-size: 1.1rem; }
        .linked-sop-info { flex: 1; min-width: 0; }
        .linked-sop-name { font-weight: 600; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .linked-sop-meta { font-size: 0.75rem; color: #868e96; margin-top: 2px; }
        .linked-sop-actions { display: flex; gap: 4px; flex-shrink: 0; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
