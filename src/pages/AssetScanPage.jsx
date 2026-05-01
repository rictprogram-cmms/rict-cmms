/**
 * RICT CMMS - Asset Lookup Page (Authenticated, Mobile-Optimized)
 * Route: /assets/scan
 *
 * Protected page (requires login) for QR-based asset lookup.
 * Accessed via the "Asset Lookup" button on the Assets page.
 *
 * Features:
 *  - Auto-opens camera scanner on load when no assetId is provided
 *  - Scans asset QR code labels to load asset details
 *  - Mobile-first layout optimized for small phone screens
 *  - Asset image with lightbox (tap to enlarge)
 *  - Name, ID, location badge, description
 *  - Category & Status info grid
 *  - Permission-gated actions based on user's role:
 *    · View Work Orders (all users with view_page)
 *    · View/Upload Documents (upload_docs permission)
 *    · Edit Asset (edit_assets permission)
 *    · Delete Asset (delete_assets permission)
 *  - "Scan Next" button to scan another asset without leaving
 *  - "Back to Assets" navigation
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useCheckoutActions, fakeUtcToDisplay, daysOverdue } from '@/hooks/useAssetCheckouts'

export default function AssetScanPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { profile } = useAuth()

  const assetId = searchParams.get('assetId') || ''

  const [asset, setAsset] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [workOrders, setWorkOrders] = useState([])
  const [documents, setDocuments] = useState([])
  const [showWOs, setShowWOs] = useState(false)
  const [showDocs, setShowDocs] = useState(false)
  const [showClosedWOs, setShowClosedWOs] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [toast, setToast] = useState(null)
  const [showScanner, setShowScanner] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [categories, setCategories] = useState([])
  const [locations, setLocations] = useState([])
  const html5QrRef = useRef(null)
  const hasAutoOpenedRef = useRef(false)

  const userName = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : 'Unknown'
  const userShort = profile ? `${profile.first_name || ''} ${profile.last_name?.charAt(0) || ''}.`.trim() : 'Unknown'

  const { hasPerm } = usePermissions('Assets')
  const { hasPerm: hasCheckoutPerm } = usePermissions('Asset Checkouts')

  // Open checkout for the currently loaded asset (null if available / not checkoutable)
  const [openCheckout, setOpenCheckout] = useState(null)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [showCheckOut, setShowCheckOut] = useState(false)
  const [showCheckIn, setShowCheckIn] = useState(false)
  const checkoutActions = useCheckoutActions()

  /* ── Load Material Icons Font ────────────────────────────────────── */
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link')
      link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons'
      link.rel = 'stylesheet'
      document.head.appendChild(link)
    }
  }, [])

  /* ── Load Dropdowns for Edit ─────────────────────────────────────── */
  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('assets').select('category, location')
      if (data) {
        setCategories([...new Set(data.map(a => a.category).filter(Boolean))].sort())
        setLocations([...new Set(data.map(a => a.location).filter(Boolean))].sort())
      }
    })()
  }, [])

  /* ── Auto-open scanner if no assetId ─────────────────────────────── */
  useEffect(() => {
    if (!assetId && !hasAutoOpenedRef.current) {
      hasAutoOpenedRef.current = true
      setTimeout(() => openScanner(), 300)
    }
  }, [assetId])

  /* ── Load Asset ──────────────────────────────────────────────────── */
  const loadAsset = useCallback(async (id) => {
    const targetId = id || assetId
    if (!targetId) {
      setAsset(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    setShowWOs(false)
    setShowDocs(false)
    try {
      const { data, error: err } = await supabase
        .from('assets')
        .select('*')
        .eq('asset_id', targetId)
        .single()

      if (err || !data) {
        setError({ title: 'Asset Not Found', message: `Asset "${targetId}" was not found in the system.` })
        setAsset(null)
      } else {
        setAsset(data)
        loadWorkOrders(targetId)
        loadDocuments(targetId)
        loadOpenCheckout(targetId)
      }
    } catch {
      setError({ title: 'Error', message: 'Failed to load asset data.' })
    }
    setLoading(false)
  }, [assetId])

  /* ── Open Checkout ───────────────────────────────────────────────── */
  const loadOpenCheckout = useCallback(async (id) => {
    if (!id) return
    setCheckoutLoading(true)
    try {
      const { data } = await supabase
        .from('asset_checkouts')
        .select('*')
        .eq('asset_id', id)
        .is('returned_at', null)
        .limit(1)
        .maybeSingle()
      setOpenCheckout(data || null)
    } catch (e) {
      console.warn('loadOpenCheckout error:', e.message)
      setOpenCheckout(null)
    } finally {
      setCheckoutLoading(false)
    }
  }, [])

  useEffect(() => {
    if (assetId) loadAsset()
  }, [assetId, loadAsset])

  /* ── Work Orders ─────────────────────────────────────────────────── */
  async function loadWorkOrders(id) {
    try {
      const { data: openWOs } = await supabase
        .from('work_orders')
        .select('wo_id, description, priority, status, assigned_to, created_at')
        .eq('asset_id', id)
        .order('created_at', { ascending: false })

      const { data: closedWOs } = await supabase
        .from('work_orders_closed')
        .select('wo_id, description, priority, status, assigned_to, created_at, closed_date')
        .eq('asset_id', id)
        .order('closed_date', { ascending: false })

      const all = [
        ...(openWOs || []).map(wo => ({ ...wo, isClosed: false })),
        ...(closedWOs || []).map(wo => ({ ...wo, isClosed: true }))
      ]
      setWorkOrders(all)
    } catch { }
  }

  /* ── Documents ───────────────────────────────────────────────────── */
  async function loadDocuments(id) {
    try {
      const { data } = await supabase
        .from('asset_documents')
        .select('*')
        .eq('asset_id', id)
        .order('uploaded_at', { ascending: false })
      setDocuments(data || [])
    } catch { }
  }

  /* ── Upload Document ─────────────────────────────────────────────── */
  async function handleUploadDoc() {
    if (!asset) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,.doc,.docx,.txt,.xls,.xlsx,.png,.jpg,.jpeg'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) return

      setUploading(true)
      try {
        const path = `asset-docs/${asset.asset_id}/${Date.now()}-${file.name}`
        const { error: upErr } = await supabase.storage.from('asset-documents').upload(path, file)
        if (upErr) { showToastMsg('Upload error: ' + upErr.message, 'error'); setUploading(false); return }

        const { data: docRows, error: docErr } = await supabase.from('asset_documents').insert({
          asset_id: asset.asset_id,
          document_name: file.name,
          document_type: file.name.split('.').pop()?.toUpperCase() || 'Document',
          file_path: path,
          uploaded_by: userShort,
          uploaded_at: new Date().toISOString(),
        }).select()

        if (docErr || !docRows?.length) {
          showToastMsg('Upload failed — check permissions.', 'error')
        } else {
          showToastMsg('Document uploaded', 'success')
          loadDocuments(asset.asset_id)
        }
      } catch (err) {
        showToastMsg('Upload error: ' + err.message, 'error')
      }
      setUploading(false)
    }
    input.click()
  }

  /* ── Delete Document ─────────────────────────────────────────────── */
  async function handleDeleteDoc(docId) {
    if (!confirm('Delete this document?')) return
    const { data: rows, error } = await supabase.from('asset_documents').delete().eq('document_id', docId).select()
    if (error || !rows?.length) {
      showToastMsg('Delete failed — check permissions.', 'error')
      return
    }
    showToastMsg('Document deleted', 'success')
    loadDocuments(asset.asset_id)
  }

  /* ── Edit Asset ──────────────────────────────────────────────────── */
  function openEditModal() {
    if (!asset) return
    setEditForm({
      name: asset.name || '',
      description: asset.description || '',
      category: asset.category || '',
      location: asset.location || '',
      status: asset.status || 'Active',
    })
    setShowEditModal(true)
  }

  async function saveAssetEdit() {
    if (!editForm.name?.trim()) { showToastMsg('Asset name is required', 'error'); return }
    setSaving(true)
    try {
      const row = {
        name: editForm.name,
        description: editForm.description || '',
        category: editForm.category || '',
        location: editForm.location || '',
        status: editForm.status || 'Active',
        updated_at: new Date().toISOString(),
        updated_by: userShort,
      }
      const { data: rows, error } = await supabase.from('assets').update(row).eq('asset_id', asset.asset_id).select()
      if (error) throw error
      if (!rows?.length) {
        showToastMsg('Save failed — check permissions.', 'error')
        setSaving(false)
        return
      }
      setAsset(rows[0])
      setShowEditModal(false)
      showToastMsg('Asset updated', 'success')
    } catch (e) {
      showToastMsg('Error: ' + e.message, 'error')
    }
    setSaving(false)
  }

  /* ── Delete Asset ────────────────────────────────────────────────── */
  async function handleDeleteAsset() {
    if (!asset) return
    if (!confirm(`Delete "${asset.name}"? This cannot be undone.`)) return
    const { data: rows, error } = await supabase.from('assets').delete().eq('asset_id', asset.asset_id).select()
    if (error || !rows?.length) {
      showToastMsg('Delete failed — check permissions.', 'error')
      return
    }
    showToastMsg('Asset deleted', 'success')
    setTimeout(() => navigate('/assets'), 1000)
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */
  function getImageUrl(fileId) {
    if (!fileId) return null
    if (fileId.startsWith('http')) return fileId
    if (fileId.includes('/')) {
      return supabase.storage.from('asset-images').getPublicUrl(fileId).data?.publicUrl || null
    }
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`
  }

  function getDocUrl(filePath) {
    if (!filePath) return '#'
    return supabase.storage.from('asset-documents').getPublicUrl(filePath).data?.publicUrl || '#'
  }

  function showToastMsg(msg, type) {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  /* ── QR Scanner ──────────────────────────────────────────────────── */
  async function openScanner() {
    setShowScanner(true)
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      if (!html5QrRef.current) {
        html5QrRef.current = new Html5Qrcode('qr-reader-asset')
      }
      const config = {
        fps: 10,
        qrbox: (w, h) => {
          const size = Math.floor(Math.min(w, h) * 0.7)
          return { width: size, height: size }
        },
        aspectRatio: window.innerHeight / window.innerWidth
      }
      await html5QrRef.current.start(
        { facingMode: 'environment' },
        config,
        (text) => {
          closeScanner()
          // Parse asset QR codes
          try {
            const url = new URL(text)
            const scannedAssetId = url.searchParams.get('assetId')
            if (scannedAssetId) {
              setSearchParams({ assetId: scannedAssetId })
              return
            }
          } catch { }

          // Try other RICT CMMS QR codes
          if (text.includes('/inventory/scan') || text.includes('/assets/scan') || text.includes('/orders/receive')) {
            window.location.href = text
          } else {
            showToastMsg('Invalid QR code — not a recognized asset', 'error')
          }
        },
        () => { }
      )
    } catch {
      showToastMsg('Unable to access camera', 'error')
      setShowScanner(false)
    }
  }

  function closeScanner() {
    setShowScanner(false)
    if (html5QrRef.current) {
      html5QrRef.current.stop().catch(() => { })
    }
  }

  /* ── Computed ─────────────────────────────────────────────────────── */
  const imgUrl = asset ? getImageUrl(asset.image_url) : null
  const statusColor = asset?.status === 'Active' ? '#2b8a3e' : '#c92a2a'
  const filteredWOs = showClosedWOs ? workOrders : workOrders.filter(wo => !wo.isClosed)
  const openWOCount = workOrders.filter(wo => !wo.isClosed).length
  const docCount = documents.length

  /* ═══════════════════════════════════════════════════════════════════ */
  /*  RENDER                                                           */
  /* ═══════════════════════════════════════════════════════════════════ */

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: '#f8f9fa', minHeight: '100vh' }}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, #228be6 0%, #1971c2 100%)', color: 'white',
        padding: '16px 20px', position: 'sticky', top: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: '0 2px 12px rgba(0,0,0,0.15)'
      }}>
        <button onClick={() => navigate('/assets')} style={{
          background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white',
          width: 44, height: 44, borderRadius: 12, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          WebkitTapHighlightColor: 'transparent'
        }}>
          <span className="material-icons" style={{ fontSize: '1.4rem' }}>arrow_back</span>
        </button>

        <h1 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
          <span className="material-icons" style={{ fontSize: '1.4rem' }}>qr_code_scanner</span>
          Asset Lookup
        </h1>

        <button onClick={openScanner} title="Scan QR Code" style={{
          background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white',
          width: 44, height: 44, borderRadius: 12, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          WebkitTapHighlightColor: 'transparent'
        }}>
          <span className="material-icons" style={{ fontSize: '1.4rem' }}>photo_camera</span>
        </button>
      </div>

      {/* ── Scanner Fullscreen ─────────────────────────────────────── */}
      {showScanner && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 2000, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', background: 'rgba(0,0,0,0.85)',
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10
          }}>
            <h2 style={{ color: 'white', fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>Scan Asset QR Code</h2>
            <button onClick={closeScanner} style={{
              background: '#fa5252', border: 'none', color: 'white',
              width: 44, height: 44, borderRadius: '50%', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <span className="material-icons" style={{ fontSize: '1.5rem' }}>close</span>
            </button>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <div id="qr-reader-asset" style={{ width: '100%', height: '100%' }} />
            <p style={{
              color: 'white', textAlign: 'center', padding: '16px 20px', fontSize: '0.95rem',
              position: 'absolute', bottom: 0, left: 0, right: 0,
              background: 'linear-gradient(transparent, rgba(0,0,0,0.8))', margin: 0
            }}>
              Point your camera at an asset QR code
            </p>
          </div>
        </div>
      )}

      {/* ── Lightbox ───────────────────────────────────────────────── */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <button onClick={() => setLightbox(null)} style={{
            position: 'absolute', top: 16, right: 16, background: 'white', border: 'none',
            width: 44, height: 44, borderRadius: '50%', fontSize: '1.5rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>×</button>
          <img src={lightbox} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} referrerPolicy="no-referrer" />
        </div>
      )}

      {/* ── Edit Asset Modal ───────────────────────────────────────── */}
      {showEditModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center'
        }} onClick={e => e.target === e.currentTarget && setShowEditModal(false)}>
          <div style={{
            background: 'white', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 500,
            maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
            animation: 'slideUp 0.3s ease'
          }}>
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid #e9ecef',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-icons" style={{ color: '#228be6' }}>edit</span>
                Edit Asset
              </h3>
              <button onClick={() => setShowEditModal(false)} style={{
                background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#868e96', padding: 4
              }}>×</button>
            </div>
            <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Asset Name *</label>
                <input type="text" placeholder="Enter asset name"
                  value={editForm.name || ''}
                  onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                  style={{ width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Description</label>
                <textarea rows={3} placeholder="Enter description"
                  value={editForm.description || ''}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                  style={{ width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Category</label>
                  <select value={editForm.category || ''}
                    onChange={e => setEditForm({ ...editForm, category: e.target.value })}
                    style={{ width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box', background: 'white' }}>
                    <option value="">Select</option>
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Location</label>
                  <select value={editForm.location || ''}
                    onChange={e => setEditForm({ ...editForm, location: e.target.value })}
                    style={{ width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box', background: 'white' }}>
                    <option value="">Select</option>
                    {locations.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Status</label>
                <select value={editForm.status || 'Active'}
                  onChange={e => setEditForm({ ...editForm, status: e.target.value })}
                  style={{ width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box', background: 'white' }}>
                  <option value="Active">Active</option>
                  <option value="Archived">Archived</option>
                </select>
              </div>
            </div>
            <div style={{ padding: '12px 20px 20px', display: 'flex', gap: 12 }}>
              <button onClick={() => setShowEditModal(false)} style={{
                flex: 1, padding: 14, borderRadius: 12, fontSize: '1rem', fontWeight: 600,
                cursor: 'pointer', border: '1px solid #dee2e6', background: '#f8f9fa', color: '#495057'
              }}>Cancel</button>
              <button onClick={saveAssetEdit} disabled={saving} style={{
                flex: 1, padding: 14, borderRadius: 12, fontSize: '1rem', fontWeight: 600,
                cursor: 'pointer', border: 'none', background: '#228be6', color: 'white',
                opacity: saving ? 0.6 : 1
              }}>{saving ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile Check Out Modal ─────────────────────────────────── */}
      {showCheckOut && asset && (
        <ScanCheckOutModal
          asset={asset}
          profile={profile}
          actions={checkoutActions}
          hasCheckoutPerm={hasCheckoutPerm}
          onClose={() => setShowCheckOut(false)}
          onDone={() => { setShowCheckOut(false); loadOpenCheckout(asset.asset_id) }}
        />
      )}

      {/* ── Mobile Check In Modal ──────────────────────────────────── */}
      {showCheckIn && asset && openCheckout && (
        <ScanCheckInModal
          asset={asset}
          openCheckout={openCheckout}
          profile={profile}
          actions={checkoutActions}
          onClose={() => setShowCheckIn(false)}
          onDone={() => { setShowCheckIn(false); loadOpenCheckout(asset.asset_id) }}
        />
      )}

      {/* ── Content ────────────────────────────────────────────────── */}
      <div style={{ padding: '16px 16px 100px', maxWidth: 500, margin: '0 auto' }}>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 20 }}>
            <div style={{ width: 60, height: 60, border: '5px solid #e9ecef', borderTopColor: '#228be6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <div style={{ fontSize: '1.1rem', color: '#495057', fontWeight: 500 }}>Loading asset...</div>
          </div>
        ) : error ? (
          <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', marginTop: 20 }}>
            <div style={{ textAlign: 'center', padding: '60px 24px' }}>
              <span className="material-icons" style={{ fontSize: '4rem', color: '#fa5252', marginBottom: 16, display: 'block' }}>
                {error.title === 'Asset Not Found' ? 'search_off' : 'error_outline'}
              </span>
              <h2 style={{ color: '#1a1a2e', marginBottom: 12, fontSize: '1.4rem' }}>{error.title}</h2>
              <p style={{ color: '#868e96', fontSize: '1rem', marginBottom: 24 }}>{error.message}</p>
              <button onClick={openScanner} style={{
                padding: '14px 28px', borderRadius: 12, fontSize: '1rem', fontWeight: 600,
                cursor: 'pointer', border: 'none', background: '#228be6', color: 'white',
                display: 'inline-flex', alignItems: 'center', gap: 8
              }}>
                <span className="material-icons">qr_code_scanner</span>
                Scan Again
              </button>
            </div>
          </div>
        ) : !asset && !assetId ? (
          /* ── No asset loaded — prompt to scan ── */
          <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', marginTop: 20 }}>
            <div style={{ textAlign: 'center', padding: '60px 24px' }}>
              <span className="material-icons" style={{ fontSize: '4rem', color: '#228be6', marginBottom: 16, display: 'block' }}>qr_code_scanner</span>
              <h2 style={{ color: '#1a1a2e', marginBottom: 12, fontSize: '1.4rem' }}>Scan an Asset</h2>
              <p style={{ color: '#868e96', fontSize: '1rem', marginBottom: 24 }}>Point your camera at an asset QR code to look it up.</p>
              <button onClick={openScanner} style={{
                padding: '14px 28px', borderRadius: 12, fontSize: '1rem', fontWeight: 600,
                cursor: 'pointer', border: 'none', background: '#228be6', color: 'white',
                display: 'inline-flex', alignItems: 'center', gap: 8
              }}>
                <span className="material-icons">photo_camera</span>
                Open Camera
              </button>
            </div>
          </div>
        ) : asset && (
          <>
            {/* ── Main Asset Card ─────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', marginBottom: 16 }}>
              {/* Asset Image */}
              <div
                onClick={() => imgUrl && setLightbox(imgUrl)}
                style={{
                  width: '100%', height: 220, background: '#f1f3f5',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden', cursor: imgUrl ? 'pointer' : 'default'
                }}
              >
                {imgUrl ? (
                  <img src={imgUrl} alt={asset.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" />
                ) : (
                  <span className="material-icons" style={{ fontSize: '4rem', color: '#adb5bd' }}>precision_manufacturing</span>
                )}
              </div>

              <div style={{ padding: '20px 20px 24px' }}>
                {/* Name & ID */}
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#1a1a2e', marginBottom: 4, lineHeight: 1.2 }}>
                  {asset.name}
                </div>
                <div style={{ fontSize: '0.9rem', color: '#868e96', marginBottom: 16 }}>
                  {asset.asset_id}
                </div>

                {/* Location Badge */}
                {asset.location && (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    background: '#fff3bf', color: '#e67700', padding: '10px 16px',
                    borderRadius: 20, fontSize: '0.9rem', fontWeight: 600, marginBottom: 16
                  }}>
                    <span className="material-icons" style={{ fontSize: '1.1rem' }}>location_on</span>
                    {asset.location}
                  </div>
                )}

                {/* Description */}
                {asset.description && (
                  <div style={{ color: '#495057', lineHeight: 1.6, marginBottom: 20, padding: 16, background: '#f8f9fa', borderRadius: 12, fontSize: '0.95rem' }}>
                    {asset.description}
                  </div>
                )}

                {/* Info Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                  <div style={{ background: '#f8f9fa', padding: 16, borderRadius: 14, textAlign: 'center' }}>
                    <div style={{ fontSize: '0.7rem', color: '#868e96', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, fontWeight: 600 }}>Category</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1a1a2e' }}>
                      {asset.category || '-'}
                    </div>
                  </div>
                  <div style={{ background: '#f8f9fa', padding: 16, borderRadius: 14, textAlign: 'center' }}>
                    <div style={{ fontSize: '0.7rem', color: '#868e96', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, fontWeight: 600 }}>Status</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: statusColor }}>
                      {asset.status || '-'}
                    </div>
                  </div>
                </div>

                {/* ── Action Buttons ────────────────────────────────── */}

                {/* View Work Orders — always visible */}
                <button onClick={() => { setShowWOs(!showWOs); setShowDocs(false) }} style={{
                  width: '100%', padding: '16px 20px', borderRadius: 14, fontSize: '1rem', fontWeight: 600,
                  cursor: 'pointer', border: showWOs ? '2px solid #228be6' : '2px solid #e9ecef',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: showWOs ? '#e7f5ff' : 'white', color: showWOs ? '#1971c2' : '#495057',
                  WebkitAppearance: 'none', touchAction: 'manipulation', marginBottom: 10,
                  WebkitTapHighlightColor: 'transparent'
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="material-icons" style={{ fontSize: '1.3rem' }}>assignment</span>
                    Work Orders
                  </span>
                  <span style={{
                    background: openWOCount > 0 ? '#228be6' : '#adb5bd', color: 'white',
                    padding: '2px 10px', borderRadius: 12, fontSize: '0.8rem', fontWeight: 700
                  }}>{openWOCount}</span>
                </button>

                {/* View Documents — always visible */}
                <button onClick={() => { setShowDocs(!showDocs); setShowWOs(false) }} style={{
                  width: '100%', padding: '16px 20px', borderRadius: 14, fontSize: '1rem', fontWeight: 600,
                  cursor: 'pointer', border: showDocs ? '2px solid #228be6' : '2px solid #e9ecef',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: showDocs ? '#e7f5ff' : 'white', color: showDocs ? '#1971c2' : '#495057',
                  WebkitAppearance: 'none', touchAction: 'manipulation', marginBottom: 10,
                  WebkitTapHighlightColor: 'transparent'
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="material-icons" style={{ fontSize: '1.3rem' }}>attach_file</span>
                    Documents
                  </span>
                  <span style={{
                    background: docCount > 0 ? '#228be6' : '#adb5bd', color: 'white',
                    padding: '2px 10px', borderRadius: 12, fontSize: '0.8rem', fontWeight: 700
                  }}>{docCount}</span>
                </button>

                {/* ── Checkout Status Banner & Action ──────────────────── */}
                {asset.is_checkoutable && (() => {
                  const overdue = openCheckout?.expected_return && new Date(openCheckout.expected_return) < new Date()
                  const out = openCheckout ? fakeUtcToDisplay(openCheckout.checked_out_at) : null
                  const due = openCheckout ? fakeUtcToDisplay(openCheckout.expected_return) : null

                  if (checkoutLoading) {
                    return (
                      <div role="status" aria-live="polite" style={{
                        padding: 14, borderRadius: 14, marginTop: 6,
                        background: '#f1f3f5', color: '#495057', fontSize: '0.85rem', textAlign: 'center',
                      }}>
                        Loading checkout status…
                      </div>
                    )
                  }

                  if (!openCheckout) {
                    return (
                      <div style={{
                        padding: 14, borderRadius: 14, marginTop: 6,
                        background: '#ebfbee', border: '1px solid #c3fae8',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.95rem', fontWeight: 600, color: '#2b8a3e', marginBottom: 4 }}>
                          <span className="material-icons" aria-hidden="true">check_circle</span>
                          Available for checkout
                        </div>
                        {hasCheckoutPerm('checkout_self') && (
                          <button
                            onClick={() => setShowCheckOut(true)}
                            aria-label={`Check out ${asset.name}`}
                            style={{
                              width: '100%', padding: '14px 16px', borderRadius: 12, fontSize: '0.95rem',
                              fontWeight: 600, cursor: 'pointer', border: 'none',
                              background: '#2b8a3e', color: 'white',
                              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                              marginTop: 8,
                              WebkitAppearance: 'none', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
                            }}
                          >
                            <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.2rem' }}>logout</span>
                            Check Out
                          </button>
                        )}
                      </div>
                    )
                  }

                  return (
                    <div style={{
                      padding: 14, borderRadius: 14, marginTop: 6,
                      background: overdue ? '#fff5f5' : '#fff4e6',
                      border: `1px solid ${overdue ? '#ffc9c9' : '#ffe8cc'}`,
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        fontSize: '0.95rem', fontWeight: 600,
                        color: overdue ? '#c92a2a' : '#d9480f', marginBottom: 8,
                      }}>
                        <span className="material-icons" aria-hidden="true">{overdue ? 'warning' : 'schedule'}</span>
                        {overdue ? 'Overdue' : 'Currently checked out'}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#495057', lineHeight: 1.5 }}>
                        <div><strong>{openCheckout.user_name}</strong></div>
                        <div style={{ color: '#868e96', fontSize: '0.78rem' }}>{openCheckout.user_email}</div>
                        {out && <div style={{ marginTop: 4 }}>Out since {out.date}</div>}
                        {due && <div>{overdue ? 'Was due' : 'Due'} {due.date}{overdue ? ` · ${Math.max(0, daysOverdue(openCheckout.expected_return))} day${Math.max(0, daysOverdue(openCheckout.expected_return)) !== 1 ? 's' : ''} late` : ''}</div>}
                      </div>
                      {hasCheckoutPerm('checkin_assets') && (
                        <button
                          onClick={() => setShowCheckIn(true)}
                          aria-label={`Check in ${asset.name}`}
                          style={{
                            width: '100%', padding: '14px 16px', borderRadius: 12, fontSize: '0.95rem',
                            fontWeight: 600, cursor: 'pointer', border: 'none',
                            background: '#228be6', color: 'white',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                            marginTop: 10,
                            WebkitAppearance: 'none', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
                          }}
                        >
                          <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.2rem' }}>login</span>
                          Check In
                        </button>
                      )}
                    </div>
                  )
                })()}

                {/* Edit & Delete — permission-gated */}
                {(hasPerm('edit_assets') || hasPerm('delete_assets')) && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                    {hasPerm('edit_assets') && (
                      <button onClick={openEditModal} style={{
                        flex: 1, padding: '14px 16px', borderRadius: 14, fontSize: '0.95rem', fontWeight: 600,
                        cursor: 'pointer', border: 'none', background: '#228be6', color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        WebkitAppearance: 'none', touchAction: 'manipulation',
                        WebkitTapHighlightColor: 'transparent'
                      }}>
                        <span className="material-icons" style={{ fontSize: '1.2rem' }}>edit</span>
                        Edit Asset
                      </button>
                    )}
                    {hasPerm('delete_assets') && (
                      <button onClick={handleDeleteAsset} style={{
                        padding: '14px 16px', borderRadius: 14, fontSize: '0.95rem', fontWeight: 600,
                        cursor: 'pointer', border: 'none', background: '#ffe3e3', color: '#c92a2a',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        WebkitAppearance: 'none', touchAction: 'manipulation',
                        WebkitTapHighlightColor: 'transparent'
                      }}>
                        <span className="material-icons" style={{ fontSize: '1.2rem' }}>delete</span>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Work Orders Section ──────────────────────────────── */}
            {showWOs && (
              <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ padding: 20 }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#1a1a2e', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="material-icons" style={{ fontSize: '1.3rem', color: '#228be6' }}>assignment</span>
                    Work Orders
                  </h3>

                  {/* Toggle Open/All */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                    <button onClick={() => setShowClosedWOs(false)} style={{
                      flex: 1, padding: 10, borderRadius: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
                      border: `2px solid ${!showClosedWOs ? '#228be6' : '#dee2e6'}`,
                      background: !showClosedWOs ? '#e7f5ff' : 'white',
                      color: !showClosedWOs ? '#1971c2' : '#495057'
                    }}>Open ({openWOCount})</button>
                    <button onClick={() => setShowClosedWOs(true)} style={{
                      flex: 1, padding: 10, borderRadius: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
                      border: `2px solid ${showClosedWOs ? '#228be6' : '#dee2e6'}`,
                      background: showClosedWOs ? '#e7f5ff' : 'white',
                      color: showClosedWOs ? '#1971c2' : '#495057'
                    }}>All ({workOrders.length})</button>
                  </div>

                  {filteredWOs.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '30px 16px', color: '#868e96' }}>
                      <span className="material-icons" style={{ fontSize: '2.5rem', marginBottom: 8, display: 'block' }}>assignment_turned_in</span>
                      <p style={{ margin: 0, fontSize: '0.95rem' }}>{showClosedWOs ? 'No work orders found' : 'No open work orders'}</p>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {filteredWOs.map(wo => (
                        <div key={wo.wo_id} style={{
                          background: '#f8f9fa', padding: 14, borderRadius: 12,
                          borderLeft: `4px solid ${wo.isClosed ? '#40c057' : '#228be6'}`,
                          opacity: wo.isClosed ? 0.7 : 1
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1a1a2e' }}>{wo.wo_id}</span>
                            <span style={{
                              padding: '3px 10px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600,
                              background: wo.isClosed ? '#d3f9d8' : '#e7f5ff',
                              color: wo.isClosed ? '#2b8a3e' : '#1971c2'
                            }}>
                              {wo.isClosed ? 'Closed' : wo.status}
                            </span>
                          </div>
                          <div style={{ color: '#495057', fontSize: '0.9rem', marginBottom: 4 }}>{wo.description}</div>
                          <div style={{ fontSize: '0.8rem', color: '#868e96' }}>
                            Priority: {wo.priority}{wo.assigned_to ? ` · ${wo.assigned_to}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Documents Section ────────────────────────────────── */}
            {showDocs && (
              <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#1a1a2e', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="material-icons" style={{ fontSize: '1.3rem', color: '#fa5252' }}>attach_file</span>
                      Documents
                    </h3>
                    {hasPerm('upload_docs') && (
                      <button onClick={handleUploadDoc} disabled={uploading} style={{
                        padding: '8px 14px', borderRadius: 10, fontSize: '0.85rem', fontWeight: 600,
                        cursor: 'pointer', border: 'none', background: '#228be6', color: 'white',
                        display: 'flex', alignItems: 'center', gap: 6, opacity: uploading ? 0.6 : 1,
                        WebkitTapHighlightColor: 'transparent'
                      }}>
                        <span className="material-icons" style={{ fontSize: '1.1rem' }}>{uploading ? 'hourglass_empty' : 'upload_file'}</span>
                        {uploading ? 'Uploading...' : 'Upload'}
                      </button>
                    )}
                  </div>

                  {documents.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '30px 16px', color: '#868e96' }}>
                      <span className="material-icons" style={{ fontSize: '2.5rem', marginBottom: 8, display: 'block' }}>folder_open</span>
                      <p style={{ margin: 0, fontSize: '0.95rem' }}>No documents found</p>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {documents.map(doc => (
                        <div key={doc.document_id} style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          background: '#f8f9fa', padding: 14, borderRadius: 12
                        }}>
                          <div style={{
                            width: 44, height: 44, background: '#e7f5ff', borderRadius: 10,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                          }}>
                            <span className="material-icons" style={{ fontSize: '1.3rem', color: '#228be6' }}>description</span>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#1a1a2e', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {doc.document_name}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: '#868e96' }}>{doc.document_type || 'Document'}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <button onClick={() => window.open(getDocUrl(doc.file_path || doc.file_url), '_blank')} style={{
                              width: 38, height: 38, borderRadius: 8, border: '1px solid #dee2e6',
                              background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                            }}>
                              <span className="material-icons" style={{ fontSize: '1.1rem', color: '#228be6' }}>open_in_new</span>
                            </button>
                            {hasPerm('delete_assets') && (
                              <button onClick={() => handleDeleteDoc(doc.document_id)} style={{
                                width: 38, height: 38, borderRadius: 8, border: '1px solid #ffe3e3',
                                background: '#fff5f5', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                              }}>
                                <span className="material-icons" style={{ fontSize: '1.1rem', color: '#c92a2a' }}>delete</span>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Scan Another Button ──────────────────────────────── */}
            <button onClick={openScanner} style={{
              width: '100%', padding: '16px 20px', borderRadius: 14, fontSize: '1rem', fontWeight: 600,
              cursor: 'pointer', border: '2px solid #dee2e6', background: 'white', color: '#495057',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              WebkitAppearance: 'none', touchAction: 'manipulation', marginBottom: 12,
              WebkitTapHighlightColor: 'transparent'
            }}>
              <span className="material-icons" style={{ fontSize: '1.3rem' }}>qr_code_scanner</span>
              Scan Another Asset
            </button>
          </>
        )}
      </div>

      {/* ── Toast ──────────────────────────────────────────────────── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: 16, right: 16, padding: '14px 20px',
          borderRadius: 14, color: 'white', fontWeight: 600, fontSize: '0.95rem', zIndex: 3000,
          textAlign: 'center', animation: 'slideUp 0.3s ease', maxWidth: 500, margin: '0 auto',
          background: toast.type === 'success' ? '#40c057' : '#fa5252',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}>
          {toast.msg}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════════ */
/*  Mobile Check Out / Check In modals (bottom-sheet style to match page)   */
/* ════════════════════════════════════════════════════════════════════════ */

function ScanCheckOutModal({ asset, profile, actions, hasCheckoutPerm, onClose, onDone }) {
  const meEmail = profile?.email || ''
  const meName  = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : ''
  const meUserId = profile?.user_id || null

  const canCheckoutOthers = hasCheckoutPerm('checkout_others')
  const [mode, setMode] = useState('self')
  const [allProfiles, setAllProfiles] = useState([])
  const [selectedEmail, setSelectedEmail] = useState('')
  const [userSearch, setUserSearch] = useState('')

  const [dueDateStr, setDueDateStr] = useState('')
  const [condition, setCondition] = useState('Good')
  const [notes, setNotes] = useState('')
  const [acknowledgmentName, setAcknowledgmentName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Hand-off mode
  const [handoffMode, setHandoffMode] = useState(false)
  const [studentSignedAt, setStudentSignedAt] = useState(null)
  const ackInputRef = useRef(null)

  useEffect(() => {
    if (handoffMode && ackInputRef.current) {
      setTimeout(() => ackInputRef.current?.focus(), 100)
    }
  }, [handoffMode])

  // Invalidate signature if user/mode changes
  useEffect(() => {
    if (studentSignedAt) {
      setStudentSignedAt(null)
      setAcknowledgmentName('')
    }
  }, [selectedEmail, mode]) // eslint-disable-line

  useEffect(() => {
    if (mode !== 'other') return
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, user_id, email, first_name, last_name, role, status')
        .eq('status', 'Active')
        .order('first_name', { ascending: true })
      if (!cancelled) setAllProfiles((data || []).filter(p => p.email && p.email !== 'rictprogram@gmail.com'))
    })()
    return () => { cancelled = true }
  }, [mode])

  const setPreset = (days) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    setDueDateStr(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }

  const filteredProfiles = !userSearch ? allProfiles : allProfiles.filter(p => {
    const s = userSearch.toLowerCase()
    return (p.first_name || '').toLowerCase().includes(s) ||
      (p.last_name || '').toLowerCase().includes(s) ||
      (p.email || '').toLowerCase().includes(s)
  })

  const targetUser = (() => {
    if (mode === 'self') return { email: meEmail, name: meName, user_id: meUserId }
    const p = allProfiles.find(p => p.email === selectedEmail)
    if (!p) return null
    return {
      email: p.email,
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email,
      user_id: p.user_id || null,
    }
  })()

  const expectedName = targetUser?.name || ''
  const ackMatches = !!acknowledgmentName && expectedName &&
    acknowledgmentName.trim().toLowerCase() === expectedName.toLowerCase()
  // Same gate as desktop modal — student must sign in 'other' mode
  const canSubmit = !!targetUser && !submitting && (
    mode === 'self' ? ackMatches : !!studentSignedAt
  )

  const handleSubmit = async () => {
    if (!targetUser) return
    setSubmitting(true)
    try {
      const expectedReturn = dueDateStr
        ? (() => {
            const [y, m, d] = dueDateStr.split('-').map(Number)
            return new Date(y, m - 1, d, 23, 59, 0)
          })()
        : null
      await actions.checkOut({
        asset: { asset_id: asset.asset_id, name: asset.name, serial_number: asset.serial_number },
        user: targetUser,
        expectedReturn,
        condition,
        notes,
        acknowledgmentName: acknowledgmentName.trim(),
      })
      onDone?.()
    } catch (e) { /* toast */ } finally { setSubmitting(false) }
  }

  const inputStyle = { width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box' }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-co-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={e => e.target === e.currentTarget && !submitting && !handoffMode && onClose()}
      onKeyDown={e => {
        if (e.key !== 'Escape') return
        if (submitting) return
        if (handoffMode) { setHandoffMode(false); setAcknowledgmentName(''); return }
        onClose()
      }}
    >
      <div style={{
        background: 'white', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 500,
        maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        animation: 'slideUp 0.3s ease',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e9ecef', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="scan-co-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="material-icons" aria-hidden="true" style={{ color: '#2b8a3e' }}>logout</span>
            Check Out
          </h3>
          <button
            onClick={() => {
              if (submitting) return
              if (handoffMode) { setHandoffMode(false); setAcknowledgmentName(''); return }
              onClose()
            }}
            aria-label={handoffMode ? 'Cancel hand-off' : 'Close'}
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#868e96', padding: 4 }}
          >×</button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          <div style={{ background: '#f8f9fa', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: '0.85rem' }}>
            <div><strong>{asset.name}</strong> <span style={{ color: '#868e96', fontFamily: 'monospace' }}>({asset.asset_id})</span></div>
            {asset.serial_number && <div style={{ color: '#868e96', fontSize: '0.8rem' }}>SN: {asset.serial_number}</div>}
          </div>

          {/* Form fields — visually locked during hand-off */}
          <div
            aria-hidden={handoffMode}
            style={{
              opacity: handoffMode ? 0.4 : 1,
              pointerEvents: handoffMode ? 'none' : 'auto',
              transition: 'opacity 0.2s',
            }}
          >

          {canCheckoutOthers && (
            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
              <legend style={{ fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6, padding: 0 }}>For</legend>
              <div style={{ display: 'flex', gap: 8 }}>
                {[{ id: 'self', label: 'Myself' }, { id: 'other', label: 'Another user' }].map(opt => (
                  <label key={opt.id} style={{
                    flex: 1, padding: '10px 12px', borderRadius: 10, fontSize: '0.85rem', textAlign: 'center',
                    border: `2px solid ${mode === opt.id ? '#228be6' : '#dee2e6'}`,
                    background: mode === opt.id ? '#e7f5ff' : 'white',
                    color: mode === opt.id ? '#1971c2' : '#495057',
                    fontWeight: 500, cursor: 'pointer',
                  }}>
                    <input type="radio" name="scan-co-mode" className="sr-only" checked={mode === opt.id}
                      onChange={() => { setMode(opt.id); setAcknowledgmentName('') }} />
                    {opt.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {mode === 'other' && (
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="scan-co-search" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Select user *</label>
              {selectedEmail && targetUser ? (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 14px',
                    background: '#ebfbee',
                    border: '2px solid #40c057',
                    borderRadius: 12,
                  }}
                >
                  <span
                    className="material-icons"
                    aria-hidden="true"
                    style={{ color: '#2b8a3e', fontSize: '1.5rem' }}
                  >
                    check_circle
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#2b8a3e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Selected
                    </div>
                    <div style={{ fontWeight: 600, color: '#1a1a2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {targetUser.name}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#495057', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {targetUser.email}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setSelectedEmail(''); setUserSearch('') }}
                    style={{
                      padding: '8px 14px', borderRadius: 10,
                      border: '1px solid #40c057', background: 'white',
                      color: '#2b8a3e', fontSize: '0.85rem', fontWeight: 600,
                      cursor: 'pointer', flexShrink: 0,
                    }}
                    aria-label={`Change selected user (currently ${targetUser.name})`}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input id="scan-co-search" type="text" placeholder="Search by name or email…"
                    value={userSearch} onChange={e => setUserSearch(e.target.value)}
                    style={{ ...inputStyle, marginBottom: 8 }} />
                  <div role="listbox" aria-label="User list" style={{
                    maxHeight: 180, overflowY: 'auto', border: '1px solid #dee2e6', borderRadius: 10, background: 'white',
                  }}>
                    {filteredProfiles.length === 0 ? (
                      <div style={{ padding: 12, fontSize: '0.85rem', color: '#868e96', textAlign: 'center' }}>No users match</div>
                    ) : filteredProfiles.map(p => {
                      const fullName = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email
                      const sel = selectedEmail === p.email
                      return (
                        <button key={p.email} type="button" role="option" aria-selected={sel}
                          onClick={() => setSelectedEmail(p.email)}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '10px 12px', width: '100%', textAlign: 'left',
                            background: sel ? '#e7f5ff' : 'white', border: 'none',
                            borderBottom: '1px solid #f1f3f5', cursor: 'pointer', fontSize: '0.85rem',
                          }}>
                          <span><span style={{ fontWeight: 600 }}>{fullName}</span> <span style={{ color: '#868e96', marginLeft: 6 }}>{p.email}</span></span>
                          <span style={{ color: '#868e96', fontSize: '0.75rem' }}>{p.role}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="scan-co-due" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>
              Expected return <span style={{ color: '#868e96', fontWeight: 400 }}>(optional)</span>
            </label>
            <input id="scan-co-due" type="date" value={dueDateStr} onChange={e => setDueDateStr(e.target.value)} style={inputStyle} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {[{ d: 1, label: 'Tomorrow' }, { d: 7, label: '+1 wk' }, { d: 14, label: '+2 wk' }, { d: 30, label: '+30 d' }].map(opt => (
                <button key={opt.label} type="button" onClick={() => setPreset(opt.d)}
                  style={{
                    padding: '6px 10px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 500,
                    border: '1px solid #dee2e6', background: 'white', color: '#495057', cursor: 'pointer',
                  }}>{opt.label}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="scan-co-cond" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Condition</label>
            <select id="scan-co-cond" value={condition} onChange={e => setCondition(e.target.value)}
              style={{ ...inputStyle, background: 'white' }}>
              <option>Good</option><option>Fair</option><option>Poor</option>
            </select>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="scan-co-notes" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>
              Notes <span style={{ color: '#868e96', fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea id="scan-co-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
              style={{ ...inputStyle, resize: 'vertical' }} />
          </div>

          </div>{/* end form-fields wrapper */}

          {/* Acknowledgment — three states */}
          {studentSignedAt ? (
            // STATE 3: Signed
            <div
              role="status"
              aria-live="polite"
              style={{
                border: '2px solid #40c057', borderRadius: 12, padding: 14, background: '#ebfbee',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: '#2b8a3e', marginBottom: 6 }}>
                <span className="material-icons" aria-hidden="true">verified</span>
                Signed by {acknowledgmentName}
              </div>
              <p style={{ margin: '0 0 8px', fontSize: '0.8rem', color: '#2f9e44' }}>
                Captured {new Date(studentSignedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
                Tap "Confirm" below to complete.
              </p>
              <button
                type="button"
                onClick={() => { setStudentSignedAt(null); setAcknowledgmentName('') }}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: '#2f9e44', fontSize: '0.78rem', textDecoration: 'underline', cursor: 'pointer',
                }}
              >
                Clear and re-do
              </button>
            </div>
          ) : handoffMode ? (
            // STATE 2: Hand-off active
            <fieldset
              style={{
                border: '3px solid #228be6', borderRadius: 12, padding: 16,
                background: '#e7f5ff', margin: 0,
              }}
            >
              <legend
                style={{
                  fontWeight: 700, color: '#1971c2', fontSize: '0.95rem',
                  padding: '2px 10px', background: 'white', borderRadius: 6,
                  border: '2px solid #228be6',
                }}
              >
                <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.05rem', verticalAlign: 'middle', marginRight: 4 }}>phone_iphone</span>
                {expectedName}'s turn
              </legend>
              <p style={{ fontSize: '0.95rem', color: '#1971c2', margin: '4px 0 12px', fontWeight: 500 }}>
                Hand the device to <strong>{expectedName}</strong>:
              </p>
              <blockquote
                style={{
                  margin: '0 0 14px', padding: '12px 14px', background: 'white',
                  borderRadius: 8, fontSize: '0.9rem', color: '#1a1a2e',
                  fontStyle: 'italic', borderLeft: '4px solid #228be6', lineHeight: 1.5,
                }}
              >
                "I, <strong>{expectedName}</strong>, accept responsibility for asset {asset.asset_id} until {dueDateStr ? new Date(dueDateStr + 'T23:59:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'returned'}, and agree to return it in the same condition."
              </blockquote>
              <label htmlFor="scan-co-ack" style={{ display: 'block', fontSize: '0.95rem', fontWeight: 600, color: '#1971c2', marginBottom: 6 }}>
                Type your full name *
              </label>
              <input
                ref={ackInputRef}
                id="scan-co-ack"
                type="text"
                value={acknowledgmentName}
                onChange={e => setAcknowledgmentName(e.target.value)}
                placeholder={expectedName}
                aria-describedby="scan-co-ack-hint"
                style={{
                  ...inputStyle, fontFamily: 'cursive', fontSize: '1.15rem', padding: '14px 16px',
                  borderWidth: 2,
                  borderColor: ackMatches ? '#40c057' : (acknowledgmentName ? '#f59e0b' : '#dee2e6'),
                }}
              />
              <div id="scan-co-ack-hint" style={{ fontSize: '0.85rem', color: '#1971c2', marginTop: 8, fontWeight: 500 }}>
                {ackMatches ? '✓ Looks good. Tap "I confirm" below.'
                  : acknowledgmentName ? '⚠ Doesn\'t match — must be exact'
                  : `Type "${expectedName}" exactly.`}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => { setHandoffMode(false); setAcknowledgmentName('') }}
                  style={{
                    flex: 1, padding: 14, borderRadius: 12,
                    border: '1px solid #dee2e6', background: 'white',
                    color: '#495057', fontWeight: 500, fontSize: '0.9rem', cursor: 'pointer',
                  }}
                  aria-label="Cancel hand-off"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!ackMatches}
                  onClick={() => {
                    setStudentSignedAt(new Date().toISOString())
                    setHandoffMode(false)
                  }}
                  style={{
                    flex: 2, padding: 14, borderRadius: 12,
                    border: 'none',
                    background: ackMatches ? '#2b8a3e' : '#adb5bd',
                    color: 'white', fontWeight: 600, fontSize: '0.95rem',
                    cursor: ackMatches ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                  aria-label="Confirm signature and hand back to instructor"
                >
                  <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.1rem' }}>check</span>
                  I confirm
                </button>
              </div>
            </fieldset>
          ) : (
            // STATE 1: Default
            <fieldset style={{ border: '2px solid #fbbf24', borderRadius: 12, padding: 14, background: '#fffbeb', margin: 0 }}>
              <legend style={{ fontWeight: 700, color: '#92400e', fontSize: '0.85rem', padding: '0 6px' }}>
                Acknowledgment
              </legend>

              {mode === 'other' && targetUser ? (
                <>
                  <p style={{ fontSize: '0.85rem', color: '#92400e', margin: '0 0 10px' }}>
                    To complete, <strong>{expectedName}</strong> must sign by typing their full name.
                  </p>
                  <button
                    type="button"
                    onClick={() => setHandoffMode(true)}
                    style={{
                      width: '100%', padding: '14px', borderRadius: 12, border: 'none',
                      background: '#228be6', color: 'white', fontWeight: 600, fontSize: '0.95rem',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    }}
                    aria-label={`Hand the device to ${expectedName} to sign`}
                  >
                    <span className="material-icons" aria-hidden="true">phone_iphone</span>
                    Hand to {expectedName} to sign
                  </button>
                  <p style={{ fontSize: '0.78rem', color: '#92400e', marginTop: 8, marginBottom: 0 }}>
                    Tap to lock the form so {expectedName} can type their name.
                  </p>
                </>
              ) : mode === 'self' ? (
                <>
                  <p style={{ fontSize: '0.8rem', color: '#92400e', margin: '0 0 8px', lineHeight: 1.5 }}>
                    "I, <strong>{expectedName || '[user]'}</strong>, accept responsibility for asset {asset.asset_id} until {dueDateStr ? new Date(dueDateStr + 'T23:59:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'returned'}, and agree to return it in the same condition."
                  </p>
                  <label htmlFor="scan-co-ack" style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#92400e', marginBottom: 4 }}>Type full name to acknowledge *</label>
                  <input
                    id="scan-co-ack"
                    type="text"
                    value={acknowledgmentName}
                    onChange={e => setAcknowledgmentName(e.target.value)}
                    placeholder={expectedName}
                    aria-describedby="scan-co-ack-hint"
                    style={{
                      ...inputStyle, fontFamily: 'cursive',
                      borderColor: ackMatches ? '#40c057' : (acknowledgmentName ? '#f59e0b' : '#dee2e6'),
                    }}
                  />
                  <div id="scan-co-ack-hint" style={{ fontSize: '0.72rem', color: '#92400e', marginTop: 4 }}>
                    {ackMatches ? '✓ Matches.'
                      : acknowledgmentName ? '⚠ Doesn\'t match — must be exact.'
                      : `Type "${expectedName}" to confirm.`}
                  </div>
                </>
              ) : (
                <p style={{ fontSize: '0.85rem', color: '#92400e', margin: 0 }}>
                  Select a user above to enable acknowledgment.
                </p>
              )}
            </fieldset>
          )}
        </div>

        {!handoffMode && (
        <div style={{ padding: '12px 20px 20px', display: 'flex', gap: 12, borderTop: '1px solid #e9ecef' }}>
          <button onClick={() => !submitting && onClose()} disabled={submitting}
            style={{ flex: 1, padding: 14, borderRadius: 12, fontSize: '1rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #dee2e6', background: '#f8f9fa', color: '#495057' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit}
            title={
              !canSubmit && mode === 'other' && targetUser && !studentSignedAt
                ? `${expectedName} must sign before submitting`
                : undefined
            }
            style={{ flex: 1, padding: 14, borderRadius: 12, fontSize: '1rem', fontWeight: 600, cursor: 'pointer', border: 'none', background: '#2b8a3e', color: 'white', opacity: canSubmit ? 1 : 0.6 }}>
            {submitting ? 'Saving…' : 'Confirm'}
          </button>
        </div>
        )}
      </div>
    </div>
  )
}

function ScanCheckInModal({ asset, openCheckout, profile, actions, onClose, onDone }) {
  const [condition, setCondition] = useState('Good')
  const [notes, setNotes] = useState('')
  const [needsRepair, setNeedsRepair] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (needsRepair && condition === 'Good') setCondition('Damaged')
  }, [needsRepair]) // eslint-disable-line

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      let relatedWoId = null
      if (needsRepair) {
        try {
          let woId = null
          try {
            const { data } = await supabase.rpc('get_next_id', { p_type: 'work_order' })
            if (data) woId = data
          } catch {}
          if (!woId) woId = 'WO' + String(Date.now()).slice(-6)
          const fullName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : 'Unknown'
          const { error: woErr } = await supabase.from('work_orders').insert({
            wo_id: woId,
            description: `Asset returned damaged — needs repair: ${asset.name}`,
            priority: 'Medium',
            status: 'Open',
            asset_id: asset.asset_id,
            asset_name: asset.name,
            asset: asset.name,
            created_at: new Date().toISOString(),
            created_by: fullName,
            is_pm: false,
          })
          if (!woErr) relatedWoId = woId
        } catch (e) { console.warn('Auto-WO failed:', e.message) }
      }

      await actions.checkIn({
        checkoutId: openCheckout.checkout_id,
        condition, notes, needsRepair, relatedWoId,
      })
      onDone?.()
    } catch (e) { /* toast */ } finally { setSubmitting(false) }
  }

  const out = fakeUtcToDisplay(openCheckout.checked_out_at)
  const inputStyle = { width: '100%', padding: '12px 14px', border: '1px solid #dee2e6', borderRadius: 10, fontSize: '1rem', fontFamily: 'inherit', boxSizing: 'border-box' }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-ci-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={e => e.target === e.currentTarget && !submitting && onClose()}
      onKeyDown={e => e.key === 'Escape' && !submitting && onClose()}
    >
      <div style={{
        background: 'white', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 500,
        maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        animation: 'slideUp 0.3s ease',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e9ecef', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="scan-ci-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="material-icons" aria-hidden="true" style={{ color: '#228be6' }}>login</span>
            Check In
          </h3>
          <button onClick={() => !submitting && onClose()} aria-label="Close"
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#868e96', padding: 4 }}>×</button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          <div style={{ background: '#f8f9fa', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: '0.85rem' }}>
            <div><strong>{asset.name}</strong> <span style={{ color: '#868e96', fontFamily: 'monospace' }}>({asset.asset_id})</span></div>
            <div style={{ color: '#495057' }}>From: <strong>{openCheckout.user_name}</strong></div>
            {out && <div style={{ color: '#868e96', fontSize: '0.78rem' }}>Out since {out.date}</div>}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="scan-ci-cond" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>Return condition</label>
            <select id="scan-ci-cond" value={condition} onChange={e => setCondition(e.target.value)}
              style={{ ...inputStyle, background: 'white' }}>
              <option>Good</option><option>Fair</option><option>Poor</option><option>Damaged</option>
            </select>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="scan-ci-notes" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: '#495057', marginBottom: 6 }}>
              Notes <span style={{ color: '#868e96', fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea id="scan-ci-notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)}
              style={{ ...inputStyle, resize: 'vertical' }} />
          </div>

          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '12px 14px', borderRadius: 10,
            border: `1px solid ${needsRepair ? '#ffa94d' : '#dee2e6'}`,
            background: needsRepair ? '#fff4e6' : 'white', cursor: 'pointer', fontSize: '0.9rem',
          }}>
            <input type="checkbox" checked={needsRepair} onChange={e => setNeedsRepair(e.target.checked)}
              style={{ marginTop: 2, width: 20, height: 20 }} />
            <span>
              <strong style={{ color: needsRepair ? '#d9480f' : '#495057' }}>Needs repair</strong>
              <span style={{ display: 'block', fontSize: '0.78rem', color: '#868e96', marginTop: 2 }}>
                Auto-create a work order linked to this asset.
              </span>
            </span>
          </label>
        </div>

        <div style={{ padding: '12px 20px 20px', display: 'flex', gap: 12, borderTop: '1px solid #e9ecef' }}>
          <button onClick={() => !submitting && onClose()} disabled={submitting}
            style={{ flex: 1, padding: 14, borderRadius: 12, fontSize: '1rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #dee2e6', background: '#f8f9fa', color: '#495057' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={submitting}
            style={{ flex: 1, padding: 14, borderRadius: 12, fontSize: '1rem', fontWeight: 600, cursor: 'pointer', border: 'none', background: '#228be6', color: 'white', opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

