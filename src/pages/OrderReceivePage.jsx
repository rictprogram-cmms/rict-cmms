/**
 * RICT CMMS - Order Receive Page (Public, No Auth Required)
 * Mobile-first page for receiving purchase orders via QR code scan.
 * URL: /orders/receive?orderId=PO-XXXX
 *
 * Features:
 *  - Order header with ID, vendor, ordered by, status badge
 *  - Line items list with ordered qty vs received qty inputs
 *  - Received qty inputs auto-highlight green when fully received
 *  - Progress summary (total received / total ordered)
 *  - Save received items button (updates Supabase)
 *  - Camera button to scan another QR code (html5-qrcode)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'

export default function OrderReceivePage() {
  const [searchParams] = useSearchParams()
  const orderId = searchParams.get('orderId') || ''

  const [order, setOrder] = useState(null)
  const [lineItems, setLineItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [showScanner, setShowScanner] = useState(false)
  const [mobileSettings, setMobileSettings] = useState({})
  const html5QrRef = useRef(null)

  // Load mobile settings
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from('settings').select('key, value').in('key', [
          'mobile_base_font', 'mobile_header_font', 'mobile_form_font'
        ])
        const s = {}
        ;(data || []).forEach(r => { s[r.key] = parseFloat(r.value) || 0 })
        setMobileSettings(s)
      } catch {}
    })()
  }, [])

  const baseFont = mobileSettings.mobile_base_font || 20
  const headerFont = mobileSettings.mobile_header_font || 2
  const formFont = mobileSettings.mobile_form_font || 1.4

  // Load order
  const loadOrder = useCallback(async () => {
    if (!orderId) {
      setError({ title: 'No Order Scanned', message: 'Please scan a valid order QR code.' })
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Load order
      const { data: orderData, error: orderErr } = await supabase
        .from('orders')
        .select('*')
        .eq('order_id', orderId)
        .single()

      if (orderErr || !orderData) {
        setError({ title: 'Order Not Found', message: `Order "${orderId}" was not found in the system.` })
        setLoading(false)
        return
      }

      setOrder(orderData)

      // Load line items
      const { data: items } = await supabase
        .from('order_line_items')
        .select('*')
        .eq('order_id', orderId)
        .order('line_id', { ascending: true })

      const mapped = (items || []).map(item => ({
        ...item,
        receivedQty: item.received_qty || 0
      }))
      setLineItems(mapped)
    } catch {
      setError({ title: 'Error', message: 'Failed to load order data.' })
    }
    setLoading(false)
  }, [orderId])

  useEffect(() => { loadOrder() }, [loadOrder])

  function updateReceivedQty(idx, value) {
    setLineItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], receivedQty: Math.min(Math.max(0, parseInt(value) || 0), next[idx].quantity || 999) }
      return next
    })
  }

  async function saveReceived() {
    if (!order || lineItems.length === 0) return
    setSaving(true)
    try {
      // Update each line item
      for (const item of lineItems) {
        await supabase
          .from('order_line_items')
          .update({ received_qty: item.receivedQty })
          .eq('line_id', item.line_id)
      }

      // Determine order status
      const totalOrdered = lineItems.reduce((s, i) => s + (i.quantity || 0), 0)
      const totalReceived = lineItems.reduce((s, i) => s + (i.receivedQty || 0), 0)
      let newStatus = order.status
      if (totalReceived >= totalOrdered) {
        newStatus = 'Received'
      } else if (totalReceived > 0) {
        newStatus = 'Partial'
      }

      if (newStatus !== order.status) {
        await supabase
          .from('orders')
          .update({
            status: newStatus,
            ...(newStatus === 'Received' ? { received_date: new Date().toISOString() } : {})
          })
          .eq('order_id', orderId)
        setOrder(prev => ({ ...prev, status: newStatus }))
      }

      // Update inventory quantities for received items
      for (const item of lineItems) {
        if (item.receivedQty > 0 && item.part_id) {
          const oldReceived = item.received_qty || 0
          const delta = item.receivedQty - oldReceived
          if (delta > 0) {
            // Get current inventory qty
            const { data: invItem } = await supabase
              .from('inventory')
              .select('qty_in_stock')
              .eq('part_id', item.part_id)
              .single()

            if (invItem) {
              await supabase
                .from('inventory')
                .update({
                  qty_in_stock: (invItem.qty_in_stock || 0) + delta,
                  last_updated: new Date().toISOString(),
                  last_updated_by: 'QR Receive'
                })
                .eq('part_id', item.part_id)
            }
          }
        }
      }

      showToastMsg(newStatus === 'Received' ? 'Order fully received!' : 'Received items saved!', 'success')
      // Reload to refresh data
      setTimeout(() => loadOrder(), 1500)
    } catch (e) {
      showToastMsg('Error saving: ' + (e.message || 'Unknown error'), 'error')
    }
    setSaving(false)
  }

  function showToastMsg(msg, type) {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // QR Scanner
  async function openScanner() {
    setShowScanner(true)
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      if (!html5QrRef.current) {
        html5QrRef.current = new Html5Qrcode('qr-reader-order')
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
          if (text.includes('/inventory/scan') || text.includes('/assets/scan') || text.includes('/orders/receive')) {
            window.location.href = text
          } else {
            showToastMsg('Invalid QR code', 'error')
          }
        },
        () => {}
      )
    } catch {
      showToastMsg('Unable to access camera', 'error')
      setShowScanner(false)
    }
  }

  function closeScanner() {
    setShowScanner(false)
    if (html5QrRef.current) {
      html5QrRef.current.stop().catch(() => {})
    }
  }

  const totalOrdered = lineItems.reduce((s, i) => s + (i.quantity || 0), 0)
  const totalReceived = lineItems.reduce((s, i) => s + (i.receivedQty || 0), 0)

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: '#f8f9fa', minHeight: '100vh', fontSize: `${baseFont}px` }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #fab005 0%, #e67700 100%)', color: 'white', padding: '28px 24px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
          <h1 style={{ fontSize: `${headerFont}rem`, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="material-icons" style={{ fontSize: `${headerFont * 1.25}rem` }}>local_shipping</span>
            Receive Order
          </h1>
          <button onClick={openScanner} title="Scan another order" style={{
            position: 'absolute', right: 0, background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
            width: 56, height: 56, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <span className="material-icons" style={{ fontSize: '2rem' }}>qr_code_scanner</span>
          </button>
        </div>
      </div>

      {/* Scanner Modal */}
      {showScanner && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 2000, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', background: 'rgba(0,0,0,0.8)', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
            <h2 style={{ color: 'white', fontSize: '1.3rem', fontWeight: 600 }}>Scan QR Code</h2>
            <button onClick={closeScanner} style={{ background: '#fa5252', border: 'none', color: 'white', width: 48, height: 48, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="material-icons" style={{ fontSize: '1.8rem' }}>close</span>
            </button>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <div id="qr-reader-order" style={{ width: '100%', height: '100%' }} />
            <p style={{ color: 'white', textAlign: 'center', padding: 20, fontSize: '1.1rem', position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.8))' }}>
              Point your camera at an order QR code
            </p>
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ padding: 24, maxWidth: '100%', margin: '0 auto' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 28 }}>
            <div style={{ width: 80, height: 80, border: '6px solid #e9ecef', borderTopColor: '#fab005', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <div style={{ fontSize: '1.8rem', color: '#495057', fontWeight: 500 }}>Loading order...</div>
          </div>
        ) : error ? (
          <div style={{ background: 'white', borderRadius: 24, boxShadow: '0 4px 24px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ textAlign: 'center', padding: '80px 32px' }}>
              <span className="material-icons" style={{ fontSize: '7rem', color: '#fa5252', marginBottom: 28, display: 'block' }}>
                {error.title === 'No Order Scanned' ? 'qr_code_scanner' : 'error_outline'}
              </span>
              <h2 style={{ color: '#1a1a2e', marginBottom: 16, fontSize: '2.2rem' }}>{error.title}</h2>
              <p style={{ color: '#868e96', fontSize: '1.5rem' }}>{error.message}</p>
            </div>
          </div>
        ) : order && (
          <>
            <div style={{ background: 'white', borderRadius: 24, boxShadow: '0 4px 24px rgba(0,0,0,0.1)', overflow: 'hidden', marginBottom: 28 }}>
              {/* Order Header */}
              <div style={{ padding: 28, borderBottom: '1px solid #e9ecef' }}>
                <h2 style={{ fontSize: '1.8rem', fontWeight: 700, color: '#1a1a2e', marginBottom: 8 }}>
                  {order.order_id} — {order.vendor_name || order.other_vendor || 'Vendor'}
                </h2>
                <p style={{ fontSize: '1.1rem', color: '#868e96' }}>
                  Ordered by: {order.ordered_by || 'Unknown'} &nbsp;|&nbsp; Status:&nbsp;
                  <span style={{
                    display: 'inline-block', padding: '4px 12px', borderRadius: 8, fontWeight: 600, fontSize: '0.95rem',
                    background: order.status === 'Received' ? '#d3f9d8' : order.status === 'Partial' ? '#fff3bf' : '#e7f5ff',
                    color: order.status === 'Received' ? '#2b8a3e' : order.status === 'Partial' ? '#e67700' : '#1971c2'
                  }}>
                    {order.status}
                  </span>
                </p>
              </div>

              {/* Line Items */}
              <div style={{ padding: 28 }}>
                {lineItems.map((item, idx) => {
                  const isFullyReceived = item.receivedQty >= (item.quantity || 0)
                  return (
                    <div key={item.line_id || idx} style={{ padding: '20px 0', borderBottom: idx < lineItems.length - 1 ? '1px solid #e9ecef' : 'none' }}>
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 600, fontSize: '1.2rem', color: '#1a1a2e', marginBottom: 4 }}>
                          {item.description || item.part_name || 'Item'}
                        </div>
                        {item.part_number && (
                          <div style={{ fontSize: '0.95rem', color: '#868e96' }}>Part #: {item.part_number}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: '0.85rem', color: '#868e96', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>Ordered</div>
                          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#1a1a2e' }}>{item.quantity || 0}</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: '0.85rem', color: '#868e96', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>Received</div>
                          <input
                            type="number"
                            value={item.receivedQty}
                            min={0}
                            max={item.quantity || 999}
                            onChange={e => updateReceivedQty(idx, e.target.value)}
                            onFocus={e => setTimeout(() => e.target.select(), 50)}
                            onClick={e => e.target.select()}
                            style={{
                              width: 90, height: 56, textAlign: 'center',
                              fontSize: '1.6rem', fontWeight: 700,
                              border: `3px solid ${isFullyReceived ? '#40c057' : '#dee2e6'}`,
                              borderRadius: 12, outline: 'none',
                              background: isFullyReceived ? '#d3f9d8' : 'white',
                              color: isFullyReceived ? '#2b8a3e' : '#1a1a2e',
                              WebkitAppearance: 'none'
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Summary */}
              <div style={{ padding: '20px 28px', background: '#f8f9fa', borderTop: '1px solid #e9ecef' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: '1.1rem', color: '#495057' }}>
                  <span>Total Items:</span>
                  <span style={{ fontWeight: 600 }}>{lineItems.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.3rem', fontWeight: 700, color: '#1a1a2e' }}>
                  <span>Progress:</span>
                  <span style={{ color: totalReceived >= totalOrdered ? '#2b8a3e' : '#e67700' }}>
                    {totalReceived} / {totalOrdered}
                  </span>
                </div>
              </div>
            </div>

            {/* Save Button */}
            <button onClick={saveReceived} disabled={saving} style={{
              width: '100%', padding: 28, borderRadius: 20, fontSize: '1.5rem', fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
              background: saving ? '#adb5bd' : '#40c057', color: 'white',
              WebkitAppearance: 'none', touchAction: 'manipulation'
            }}>
              <span className="material-icons" style={{ fontSize: '2rem' }}>check_circle</span>
              {saving ? 'Saving...' : 'Save Received Items'}
            </button>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 140, left: 24, right: 24, padding: '24px 32px',
          borderRadius: 20, color: 'white', fontWeight: 600, fontSize: '1.2rem', zIndex: 1000,
          textAlign: 'center', animation: 'slideUp 0.3s ease',
          background: toast.type === 'success' ? '#40c057' : '#fa5252'
        }}>
          {toast.msg}
        </div>
      )}

      {/* Saving overlay */}
      {saving && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.95)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
          <div style={{ width: 80, height: 80, border: '6px solid #e9ecef', borderTopColor: '#fab005', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <div style={{ fontSize: '1.8rem', color: '#495057', fontWeight: 500 }}>Saving...</div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
    </div>
  )
}
