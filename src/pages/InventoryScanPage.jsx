/**
 * RICT CMMS - Inventory Cycle Count / Scan Page (Authenticated)
 * Route: /inventory/scan
 *
 * Protected page (requires login) for QR-based inventory cycle counting.
 * Accessed via the "Cycle Count" button on the Inventory page.
 *
 * Features:
 *  - Auto-opens camera scanner on load when no partId is provided
 *  - Scans inventory QR code labels to load part details
 *  - Mobile-first layout optimized for small phone screens
 *  - Part image (compact), name, ID, location badge
 *  - Current qty (color-coded: red=low, green=ok), min/max display
 *  - +/- quantity adjustment controls with large touch targets
 *  - Save changes (writes to Supabase with authenticated user info)
 *  - Real-time subscription — updates reflect instantly across devices
 *  - Audit log entries with actual user name/email
 *  - "Scan Next" button to scan another item without leaving the page
 *  - "Back to Inventory" navigation
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export default function InventoryScanPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { profile } = useAuth()

  const partId = searchParams.get('partId') || ''

  const [item, setItem] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [newQty, setNewQty] = useState(0)
  const [toast, setToast] = useState(null)
  const [showScanner, setShowScanner] = useState(false)
  const [scanCount, setScanCount] = useState(0)
  const scannerRef = useRef(null)
  const html5QrRef = useRef(null)
  const hasAutoOpenedRef = useRef(false)

  // Build user display name from auth
  const userName = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : 'Unknown'
  const userEmail = profile?.email || 'unknown'
  const userShort = profile ? `${profile.first_name || ''} ${profile.last_name?.charAt(0) || ''}.`.trim() : 'Unknown'

  // ── Load item when partId changes ─────────────────────────────────
  const loadItem = useCallback(async (id) => {
    const targetId = id || partId
    if (!targetId) {
      setItem(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('inventory')
        .select('*')
        .eq('part_id', targetId)
        .single()

      if (err || !data) {
        setError({ title: 'Item Not Found', message: `Part "${targetId}" was not found in the system.` })
        setItem(null)
      } else {
        setItem(data)
        setNewQty(data.qty_in_stock || 0)
        setError(null)
      }
    } catch {
      setError({ title: 'Error', message: 'Failed to load item data.' })
    }
    setLoading(false)
  }, [partId])

  useEffect(() => {
    if (partId) {
      loadItem()
    }
  }, [partId, loadItem])

  // ── Real-time subscription ────────────────────────────────────────
  // Listens for changes to the currently-viewed inventory item so that
  // updates made from the desktop Inventory page (or another phone)
  // appear instantly on this screen.
  useEffect(() => {
    if (!partId) return

    const channel = supabase
      .channel(`cycle-count-${partId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'inventory',
        filter: `part_id=eq.${partId}`
      }, (payload) => {
        const updated = payload.new
        if (updated) {
          setItem(prev => {
            if (!prev) return prev
            const merged = { ...prev, ...updated }
            // If user hasn't changed newQty from the old stock value,
            // update it to match the real-time value so they see the latest.
            setNewQty(current => {
              if (current === prev.qty_in_stock) {
                return updated.qty_in_stock ?? current
              }
              return current
            })
            return merged
          })
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [partId])

  // ── Auto-open camera on first load when no partId ─────────────────
  useEffect(() => {
    if (!partId && !hasAutoOpenedRef.current) {
      hasAutoOpenedRef.current = true
      const timer = setTimeout(() => { openScanner() }, 300)
      return () => clearTimeout(timer)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Image URL helper ──────────────────────────────────────────────
  function getImageUrl(fileId) {
    if (!fileId) return null
    if (fileId.startsWith('http')) return fileId
    if (fileId.includes('/')) {
      return supabase.storage.from('inventory-images').getPublicUrl(fileId).data?.publicUrl || null
    }
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`
  }

  // ── Qty adjustment ────────────────────────────────────────────────
  function adjustQty(delta) {
    setNewQty(prev => Math.max(0, prev + delta))
  }

  // ── Save quantity ─────────────────────────────────────────────────
  async function saveQuantity() {
    if (!item) return
    setSaving(true)
    try {
      const { error: err } = await supabase
        .from('inventory')
        .update({
          qty_in_stock: newQty,
          updated_at: new Date().toISOString(),
          updated_by: userShort
        })
        .eq('part_id', item.part_id)

      if (err) throw err

      // Audit log with authenticated user info
      try {
        await supabase.from('audit_log').insert({
          user_email: userEmail,
          user_name: userName,
          action: 'Cycle Count Adjust',
          entity_type: 'Inventory',
          entity_id: item.part_id,
          field_changed: 'qty_in_stock',
          old_value: String(item.qty_in_stock),
          new_value: String(newQty),
          details: `Cycle count adjustment from ${item.qty_in_stock} to ${newQty}`
        })
      } catch {}

      // Optimistic update
      setItem(prev => ({ ...prev, qty_in_stock: newQty }))
      setScanCount(prev => prev + 1)
      showToastMsg('Quantity updated!', 'success')
    } catch {
      showToastMsg('Error saving quantity', 'error')
    }
    setSaving(false)
  }

  function showToastMsg(msg, type) {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // ── QR Scanner ────────────────────────────────────────────────────
  async function openScanner() {
    setShowScanner(true)
    await new Promise(r => setTimeout(r, 100))
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      if (!html5QrRef.current) {
        html5QrRef.current = new Html5Qrcode('qr-reader-inv')
      }
      const config = {
        fps: 10,
        qrbox: (w, h) => {
          const size = Math.floor(Math.min(w, h) * 0.65)
          return { width: size, height: size }
        },
        aspectRatio: window.innerHeight / window.innerWidth
      }
      await html5QrRef.current.start(
        { facingMode: 'environment' },
        config,
        (text) => {
          closeScanner()
          handleQrResult(text)
        },
        () => {}
      )
    } catch (e) {
      console.error('Camera error:', e)
      showToastMsg('Unable to access camera. Please check permissions.', 'error')
      setShowScanner(false)
    }
  }

  function handleQrResult(text) {
    // Try to extract partId from URL format: /inventory/scan?partId=XXXX
    try {
      const url = new URL(text, window.location.origin)
      const scannedPartId = url.searchParams.get('partId')
      if (scannedPartId) {
        setSearchParams({ partId: scannedPartId })
        loadItem(scannedPartId)
        return
      }
    } catch {}

    // Also try matching just a part ID pattern (INV followed by digits)
    const partMatch = text.match(/INV\d+/i)
    if (partMatch) {
      setSearchParams({ partId: partMatch[0] })
      loadItem(partMatch[0])
      return
    }

    showToastMsg('Invalid QR code — not an inventory item', 'error')
  }

  function closeScanner() {
    setShowScanner(false)
    if (html5QrRef.current) {
      html5QrRef.current.stop().catch(() => {})
    }
  }

  function handleScanNext() {
    setItem(null)
    setError(null)
    setSearchParams({})
    openScanner()
  }

  const isLow = item ? (item.qty_in_stock <= (item.min_qty || 0)) : false
  const imgUrl = item ? getImageUrl(item.image_url) : null
  const hasChanged = item ? newQty !== item.qty_in_stock : false

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="cc-page">
      {/* Material Icons */}
      <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet" />

      {/* Header */}
      <div className="cc-header">
        <button onClick={() => navigate('/inventory')} className="cc-header-btn" title="Back to Inventory">
          <span className="material-icons">arrow_back</span>
        </button>
        <h1 className="cc-title">
          <span className="material-icons">qr_code_scanner</span>
          Cycle Count
        </h1>
        <button onClick={handleScanNext} className="cc-header-btn" title="Scan Item">
          <span className="material-icons">photo_camera</span>
        </button>
      </div>

      {/* Session counter */}
      {scanCount > 0 && (
        <div className="cc-session-count">
          {scanCount} item{scanCount !== 1 ? 's' : ''} updated this session
        </div>
      )}

      {/* Scanner Overlay */}
      {showScanner && (
        <div className="cc-scanner-overlay">
          <div className="cc-scanner-header">
            <h2>Scan Inventory QR Code</h2>
            <button onClick={closeScanner} className="cc-scanner-close">
              <span className="material-icons">close</span>
            </button>
          </div>
          <div className="cc-scanner-body">
            <div id="qr-reader-inv" ref={scannerRef} style={{ width: '100%', height: '100%' }} />
            <p className="cc-scanner-hint">Point your camera at an inventory QR code label</p>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="cc-content">
        {loading ? (
          <div className="cc-center-state">
            <div className="cc-spinner" />
            <div className="cc-state-text">Loading item...</div>
          </div>
        ) : error ? (
          /* Error state */
          <div className="cc-card">
            <div className="cc-center-state" style={{ padding: '40px 20px', minHeight: 'auto' }}>
              <span className="material-icons cc-state-icon" style={{ color: '#fa5252' }}>error_outline</span>
              <h2 className="cc-state-title">{error.title}</h2>
              <p className="cc-state-msg">{error.message}</p>
              <button onClick={handleScanNext} className="cc-btn cc-btn-primary">
                <span className="material-icons">qr_code_scanner</span>
                Scan Again
              </button>
            </div>
          </div>
        ) : !item ? (
          /* No item — prompt to scan */
          <div className="cc-card">
            <div className="cc-center-state" style={{ padding: '48px 20px' }}>
              <span className="material-icons cc-state-icon" style={{ color: '#228be6' }}>qr_code_scanner</span>
              <h2 className="cc-state-title">Ready to Count</h2>
              <p className="cc-state-msg">Scan an inventory QR code label to begin adjusting quantities.</p>
              <button onClick={openScanner} className="cc-btn cc-btn-primary cc-btn-lg">
                <span className="material-icons">photo_camera</span>
                Open Camera
              </button>
            </div>
          </div>
        ) : (
          /* Item loaded — show details & adjustment */
          <div className="cc-card">
            {/* Compact Part Header — image + info side by side */}
            <div className="cc-part-header">
              <div className="cc-part-thumb">
                {imgUrl ? (
                  <img src={imgUrl} alt={item.part_name} referrerPolicy="no-referrer" />
                ) : (
                  <span className="material-icons">inventory_2</span>
                )}
              </div>
              <div className="cc-part-info">
                <div className="cc-part-name">{item.part_name}</div>
                <div className="cc-part-id">
                  {item.part_id}
                  {item.supplier_part_number && <span> • {item.supplier_part_number}</span>}
                </div>
                {item.location && (
                  <div className="cc-location-badge">
                    <span className="material-icons">location_on</span>
                    {item.location}
                  </div>
                )}
              </div>
            </div>

            <div className="cc-body">
              {/* Info Grid */}
              <div className="cc-info-grid">
                <div className="cc-info-box">
                  <div className="cc-info-label">Current Qty</div>
                  <div className={`cc-info-value ${isLow ? 'low' : 'ok'}`}>{item.qty_in_stock}</div>
                </div>
                <div className="cc-info-box">
                  <div className="cc-info-label">Min / Max</div>
                  <div className="cc-info-value">{item.min_qty || 0} / {item.max_qty || 0}</div>
                </div>
              </div>

              {/* Quantity Adjustment */}
              <div className="cc-adjust-section">
                <h3 className="cc-adjust-title">
                  <span className="material-icons">edit</span>
                  Adjust Quantity
                </h3>
                <div className="cc-adjust-controls">
                  <button onClick={() => adjustQty(-1)} className="cc-adjust-btn cc-adjust-minus">−</button>
                  <input
                    type="number"
                    value={newQty}
                    min={0}
                    onChange={e => setNewQty(Math.max(0, parseInt(e.target.value) || 0))}
                    onFocus={e => setTimeout(() => e.target.select(), 50)}
                    onClick={e => e.target.select()}
                    className="cc-adjust-input"
                  />
                  <button onClick={() => adjustQty(1)} className="cc-adjust-btn cc-adjust-plus">+</button>
                </div>
                {hasChanged && (
                  <div className="cc-change-indicator">
                    {item.qty_in_stock} → {newQty} ({newQty > item.qty_in_stock ? '+' : ''}{newQty - item.qty_in_stock})
                  </div>
                )}
              </div>

              {/* Save Button */}
              <button
                onClick={saveQuantity}
                disabled={saving || !hasChanged}
                className={`cc-btn cc-btn-save ${!hasChanged ? 'disabled' : ''}`}
              >
                <span className="material-icons">save</span>
                {saving ? 'Saving...' : !hasChanged ? 'No Changes' : 'Save Changes'}
              </button>

              {/* Scan Next / Refresh */}
              <div className="cc-action-row">
                <button onClick={handleScanNext} className="cc-btn cc-btn-scan-next">
                  <span className="material-icons">qr_code_scanner</span>
                  Scan Next
                </button>
                <button onClick={() => loadItem()} className="cc-btn cc-btn-refresh">
                  <span className="material-icons">refresh</span>
                  Refresh
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`cc-toast ${toast.type === 'success' ? 'cc-toast-success' : 'cc-toast-error'}`}>
          {toast.msg}
        </div>
      )}

      {/* Saving overlay */}
      {saving && (
        <div className="cc-saving-overlay">
          <div className="cc-spinner" />
          <div className="cc-state-text">Saving...</div>
        </div>
      )}

      <style>{`
        /* ── Base ─────────────────────────────────────────── */
        .cc-page {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: #f8f9fa;
          min-height: 100vh;
          min-height: 100dvh;
        }

        /* ── Header ──────────────────────────────────────── */
        .cc-header {
          background: linear-gradient(135deg, #228be6 0%, #1971c2 100%);
          color: white;
          padding: 10px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          position: sticky;
          top: 0;
          z-index: 100;
        }
        .cc-header-btn {
          background: rgba(255,255,255,0.2);
          border: none;
          color: white;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          -webkit-tap-highlight-color: transparent;
        }
        .cc-header-btn .material-icons { font-size: 1.3rem; }
        .cc-title {
          font-size: 1.1rem;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 0;
        }
        .cc-title .material-icons { font-size: 1.3rem; }

        .cc-session-count {
          text-align: center;
          padding: 5px;
          font-size: 0.7rem;
          color: white;
          background: #1971c2;
        }

        /* ── Scanner ─────────────────────────────────────── */
        .cc-scanner-overlay {
          position: fixed;
          inset: 0;
          background: #000;
          z-index: 2000;
          display: flex;
          flex-direction: column;
        }
        .cc-scanner-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px;
          background: rgba(0,0,0,0.8);
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: 10;
        }
        .cc-scanner-header h2 {
          color: white;
          font-size: 1rem;
          font-weight: 600;
          margin: 0;
        }
        .cc-scanner-close {
          background: #fa5252;
          border: none;
          color: white;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cc-scanner-close .material-icons { font-size: 1.4rem; }
        .cc-scanner-body { flex: 1; position: relative; }
        .cc-scanner-hint {
          color: white;
          text-align: center;
          padding: 14px;
          font-size: 0.9rem;
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          background: linear-gradient(transparent, rgba(0,0,0,0.8));
          margin: 0;
        }

        /* ── Content ─────────────────────────────────────── */
        .cc-content {
          padding: 10px;
          max-width: 480px;
          margin: 0 auto;
        }

        /* ── Card ────────────────────────────────────────── */
        .cc-card {
          background: white;
          border-radius: 14px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.07);
          overflow: hidden;
          margin-bottom: 12px;
        }

        /* ── Center states (loading, error, empty) ───────── */
        .cc-center-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 50vh;
          gap: 14px;
          text-align: center;
        }
        .cc-state-icon { font-size: 3rem; display: block; }
        .cc-state-title { color: #1a1a2e; font-size: 1.2rem; margin: 0; }
        .cc-state-msg { color: #868e96; font-size: 0.9rem; margin: 0 0 12px; padding: 0 8px; }
        .cc-state-text { font-size: 1.1rem; color: #495057; font-weight: 500; }

        /* ── Part Header (compact — image + info side by side) */
        .cc-part-header {
          display: flex;
          gap: 12px;
          padding: 12px;
          border-bottom: 1px solid #f1f3f5;
          align-items: flex-start;
        }
        .cc-part-thumb {
          width: 64px;
          height: 64px;
          min-width: 64px;
          background: #f1f3f5;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .cc-part-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .cc-part-thumb .material-icons {
          font-size: 1.8rem;
          color: #adb5bd;
        }
        .cc-part-info {
          flex: 1;
          min-width: 0;
        }
        .cc-part-name {
          font-size: 0.95rem;
          font-weight: 700;
          color: #1a1a2e;
          line-height: 1.25;
          margin-bottom: 2px;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .cc-part-id {
          font-size: 0.7rem;
          color: #868e96;
          margin-bottom: 6px;
        }
        .cc-location-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          background: #fff3bf;
          color: #e67700;
          padding: 3px 8px;
          border-radius: 10px;
          font-size: 0.65rem;
          font-weight: 600;
        }
        .cc-location-badge .material-icons { font-size: 0.75rem; }

        /* ── Body ────────────────────────────────────────── */
        .cc-body { padding: 12px; }

        /* ── Info Grid ───────────────────────────────────── */
        .cc-info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 12px;
        }
        .cc-info-box {
          background: #f8f9fa;
          padding: 10px;
          border-radius: 10px;
          text-align: center;
        }
        .cc-info-label {
          font-size: 0.6rem;
          color: #868e96;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 2px;
          font-weight: 600;
        }
        .cc-info-value {
          font-size: 1.6rem;
          font-weight: 700;
          color: #1a1a2e;
        }
        .cc-info-value.low { color: #fa5252; }
        .cc-info-value.ok { color: #40c057; }

        /* ── Adjust Section ──────────────────────────────── */
        .cc-adjust-section {
          background: #e7f5ff;
          border-radius: 12px;
          padding: 14px;
          margin-bottom: 12px;
        }
        .cc-adjust-title {
          font-size: 0.9rem;
          font-weight: 600;
          color: #1971c2;
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 0 0 12px;
        }
        .cc-adjust-title .material-icons { font-size: 1.1rem; }
        .cc-adjust-controls {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
        }
        .cc-adjust-btn {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          border: none;
          font-size: 1.6rem;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          -webkit-appearance: none;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .cc-adjust-minus { background: #fff5f5; color: #fa5252; }
        .cc-adjust-plus { background: #e6fcf5; color: #40c057; }
        .cc-adjust-input {
          width: 96px;
          height: 60px;
          text-align: center;
          font-size: 1.8rem;
          font-weight: 700;
          border: 3px solid #dee2e6;
          border-radius: 12px;
          -webkit-appearance: none;
          outline: none;
          background: white;
          font-family: inherit;
        }
        .cc-adjust-input:focus { border-color: #228be6; }
        .cc-change-indicator {
          text-align: center;
          margin-top: 8px;
          font-size: 0.8rem;
          color: #1971c2;
          font-weight: 500;
        }

        /* ── Buttons ─────────────────────────────────────── */
        .cc-btn {
          border: none;
          border-radius: 12px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          -webkit-appearance: none;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
          font-family: inherit;
          transition: background 0.15s;
        }
        .cc-btn .material-icons { font-size: 1.1rem; }

        .cc-btn-primary {
          padding: 12px 24px;
          font-size: 0.95rem;
          background: #228be6;
          color: white;
        }
        .cc-btn-lg {
          padding: 16px 32px;
          font-size: 1.05rem;
        }
        .cc-btn-lg .material-icons { font-size: 1.3rem; }

        .cc-btn-save {
          width: 100%;
          padding: 14px;
          font-size: 1.05rem;
          background: #228be6;
          color: white;
          margin-bottom: 8px;
        }
        .cc-btn-save .material-icons { font-size: 1.3rem; }
        .cc-btn-save:disabled { cursor: not-allowed; }
        .cc-btn-save.disabled {
          background: #dee2e6;
          color: #868e96;
        }

        .cc-action-row {
          display: flex;
          gap: 8px;
        }
        .cc-btn-scan-next {
          flex: 1;
          padding: 12px;
          font-size: 0.85rem;
          background: #d3f9d8;
          color: #2b8a3e;
        }
        .cc-btn-refresh {
          flex: 1;
          padding: 12px;
          font-size: 0.85rem;
          background: #f1f3f5;
          color: #495057;
        }

        /* ── Toast ───────────────────────────────────────── */
        .cc-toast {
          position: fixed;
          bottom: 20px;
          left: 12px;
          right: 12px;
          padding: 12px 16px;
          border-radius: 12px;
          color: white;
          font-weight: 600;
          font-size: 0.9rem;
          z-index: 3000;
          text-align: center;
          animation: ccSlideUp 0.3s ease;
          max-width: 360px;
          margin: 0 auto;
          box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        }
        .cc-toast-success { background: #40c057; }
        .cc-toast-error { background: #fa5252; }

        /* ── Saving Overlay ──────────────────────────────── */
        .cc-saving-overlay {
          position: fixed;
          inset: 0;
          background: rgba(255,255,255,0.95);
          z-index: 3000;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
        }

        /* ── Spinner ─────────────────────────────────────── */
        .cc-spinner {
          width: 48px;
          height: 48px;
          border: 4px solid #e9ecef;
          border-top-color: #228be6;
          border-radius: 50%;
          animation: ccSpin 1s linear infinite;
        }

        /* ── Animations ──────────────────────────────────── */
        @keyframes ccSpin { to { transform: rotate(360deg); } }
        @keyframes ccSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

        /* ── Number input reset ──────────────────────────── */
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }

        /* ── Responsive: extra-small phones (≤360px) ─────── */
        @media (max-width: 360px) {
          .cc-content { padding: 6px; }
          .cc-part-header { padding: 10px; gap: 10px; }
          .cc-part-thumb { width: 52px; height: 52px; min-width: 52px; }
          .cc-part-name { font-size: 0.85rem; }
          .cc-body { padding: 10px; }
          .cc-info-value { font-size: 1.4rem; }
          .cc-adjust-btn { width: 52px; height: 52px; font-size: 1.4rem; }
          .cc-adjust-input { width: 80px; height: 52px; font-size: 1.5rem; }
          .cc-adjust-section { padding: 10px; }
        }

        /* ── Responsive: tablets / larger phones ─────────── */
        @media (min-width: 481px) {
          .cc-header { padding: 14px 16px; }
          .cc-content { padding: 16px; }
          .cc-part-header { padding: 16px; }
          .cc-part-thumb { width: 80px; height: 80px; min-width: 80px; }
          .cc-part-name { font-size: 1.1rem; }
          .cc-body { padding: 16px; }
          .cc-info-value { font-size: 2rem; }
          .cc-adjust-btn { width: 72px; height: 72px; }
          .cc-adjust-input { width: 110px; height: 72px; font-size: 2.2rem; }
        }
      `}</style>
    </div>
  )
}
