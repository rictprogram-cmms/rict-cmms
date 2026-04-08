import { useState, useMemo, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import { usePODashboard, usePOList, usePODetail, useVendors, usePOActions, useLowStockItems } from '@/hooks/usePurchaseOrders'
import toast from 'react-hot-toast'
import RejectionModal from '@/components/RejectionModal'
import { useRejectionNotification } from '@/hooks/useRejectionNotification'
import {
  ShoppingCart, Plus, Search, Filter, Package, Truck, CheckCircle2,
  XCircle, Clock, DollarSign, AlertTriangle, ChevronRight, Eye,
  Printer, X, Check, Ban, Send, FileText, Link, Trash2, ArrowLeft,
  TrendingUp, BarChart3, Loader2, SlidersHorizontal, ScanLine,
  Pencil
} from 'lucide-react'

const STATUS_COLORS = {
  Pending: 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-blue-100 text-blue-800',
  Ready: 'bg-blue-100 text-blue-800',
  Submitted: 'bg-blue-100 text-blue-800',
  Ordered: 'bg-indigo-100 text-indigo-800',
  Partial: 'bg-orange-100 text-orange-800',
  Received: 'bg-emerald-100 text-emerald-800',
  Cancelled: 'bg-surface-100 text-surface-600',
  Rejected: 'bg-red-100 text-red-800',
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[status] || 'bg-surface-100 text-surface-600'}`}>
      {status}
    </span>
  )
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtMoney(v) {
  return '$' + (parseFloat(v) || 0).toFixed(2)
}

// Statuses where line items can be edited
const EDITABLE_STATUSES = ['Pending', 'Approved', 'Ordered']

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function PurchaseOrdersPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Purchase Orders')
  const location = useLocation()
  const [tab, setTab] = useState(location.state?.tab || 'dashboard')
  const [viewingOrder, setViewingOrder] = useState(null)
  const [autoReceive, setAutoReceive] = useState(false)

  // QR Scanner state
  const [showScanner, setShowScanner] = useState(false)
  const html5QrRef = useRef(null)

  // Build tabs based on permissions
  const tabs = useMemo(() => {
    const t = []
    // Dashboard is always visible if user has view_page (they got here so they do)
    t.push({ id: 'dashboard', label: 'Dashboard', icon: BarChart3 })
    // All Orders / My Orders tab — show if view_orders permission
    if (hasPerm('view_orders')) {
      t.push({ id: 'orders', label: hasPerm('view_all_po') ? 'All Orders' : 'My Orders', icon: FileText })
    }
    // Create PO tab
    if (hasPerm('create_po')) {
      t.push({ id: 'create', label: 'Create PO', icon: Plus })
    }
    // Low Stock tab
    if (hasPerm('view_low_stock')) {
      t.push({ id: 'lowstock', label: 'Low Stock', icon: AlertTriangle })
    }
    return t
  }, [hasPerm])

  // If current tab is no longer allowed, reset to dashboard
  useEffect(() => {
    if (!permsLoading && tabs.length > 0 && !tabs.find(t => t.id === tab)) {
      setTab('dashboard')
    }
  }, [tabs, tab, permsLoading])

  // ── QR Scanner functions ──────────────────────────────────────────
  async function openScanner() {
    setShowScanner(true)
    await new Promise(r => setTimeout(r, 100))
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      if (!html5QrRef.current) {
        html5QrRef.current = new Html5Qrcode('qr-reader-po')
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
      toast.error('Unable to access camera. Please check permissions.')
      setShowScanner(false)
    }
  }

  function handleQrResult(text) {
    // The printed PO QR codes contain just the order ID (e.g. "ORD1017")
    // Also handle URL format: /orders/receive?orderId=XXXX
    let scannedOrderId = null

    // Try URL format first
    try {
      const url = new URL(text, window.location.origin)
      const idParam = url.searchParams.get('orderId')
      if (idParam) scannedOrderId = idParam
    } catch {}

    // Try direct order ID pattern (ORD followed by digits)
    if (!scannedOrderId) {
      const match = text.match(/ORD\d+/i)
      if (match) scannedOrderId = match[0]
    }

    // If the raw text looks like an order ID
    if (!scannedOrderId && text.startsWith('ORD')) {
      scannedOrderId = text.trim()
    }

    if (scannedOrderId) {
      setAutoReceive(true)
      setViewingOrder(scannedOrderId)
      setTab('orders')
      toast.success(`Loaded ${scannedOrderId} for receiving`)
    } else {
      toast.error('Invalid QR code — not a purchase order')
    }
  }

  function closeScanner() {
    setShowScanner(false)
    if (html5QrRef.current) {
      html5QrRef.current.stop().catch(() => {})
    }
  }

  if (permsLoading) {
    return (
      <div className="p-4 lg:p-6 max-w-7xl mx-auto">
        <div className="text-center py-12 text-surface-400 flex items-center justify-center gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-surface-100 rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setViewingOrder(null); setAutoReceive(false) }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
              }`}>
              <Icon size={14} /> {t.label}
            </button>
          )
        })}
        {/* QR Scan button — show if user has receive_po permission */}
        {hasPerm('receive_po') && (
          <button onClick={openScanner}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors text-surface-500 hover:text-surface-700 hover:bg-white/50 ml-auto"
            title="Scan QR code to receive an order">
            <ScanLine size={14} /> Scan to Receive
          </button>
        )}
      </div>

      {/* QR Scanner Modal */}
      {showScanner && (
        <div className="fixed inset-0 bg-black z-50 flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 bg-black/80 absolute top-0 left-0 right-0 z-10">
            <h2 className="text-white text-sm font-semibold flex items-center gap-2">
              <ScanLine size={16} /> Scan PO QR Code
            </h2>
            <button onClick={closeScanner}
              className="w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 relative">
            <div id="qr-reader-po" style={{ width: '100%', height: '100%' }} />
            <p className="text-white text-center text-sm px-6 py-4 absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent">
              Point your camera at a purchase order QR code
            </p>
          </div>
        </div>
      )}

      {/* Content */}
      {viewingOrder ? (
        <OrderDetailView orderId={viewingOrder} onBack={() => { setViewingOrder(null); setAutoReceive(false) }} hasPerm={hasPerm} autoReceive={autoReceive} />
      ) : tab === 'dashboard' ? (
        <DashboardTab onViewOrder={id => { setViewingOrder(id); setTab('orders') }} hasPerm={hasPerm} />
      ) : tab === 'orders' ? (
        <OrdersTab onViewOrder={setViewingOrder} hasPerm={hasPerm} />
      ) : tab === 'create' ? (
        <CreatePOTab onCreated={() => setTab('orders')} hasPerm={hasPerm} />
      ) : tab === 'lowstock' ? (
        <LowStockTab onCreatePO={() => setTab('create')} hasPerm={hasPerm} />
      ) : null}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD TAB
// ═══════════════════════════════════════════════════════════════════════════════

function DashboardTab({ onViewOrder, hasPerm }) {
  const canViewAll = hasPerm('view_all_po')
  const canViewSpend = hasPerm('view_dashboard_spend')
  const { summary, loading } = usePODashboard(canViewAll)

  if (loading) return <div className="text-center py-12 text-surface-400">Loading dashboard...</div>
  if (!summary) return <div className="text-center py-12 text-surface-400">No data</div>

  const metrics = [
    { label: 'Pending Approval', value: summary.pendingApproval, icon: Clock, color: 'text-yellow-600 bg-yellow-50' },
    { label: 'Approved', value: summary.approved, icon: CheckCircle2, color: 'text-blue-600 bg-blue-50' },
    { label: 'On Order', value: summary.onOrder, icon: Truck, color: 'text-indigo-600 bg-indigo-50' },
    { label: 'Received', value: summary.received, icon: Package, color: 'text-emerald-600 bg-emerald-50' },
  ]

  return (
    <div className="space-y-4">
      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {metrics.map(m => {
          const Icon = m.icon
          return (
            <div key={m.label} className="bg-white rounded-xl border border-surface-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${m.color}`}><Icon size={16} /></div>
                <span className="text-xs text-surface-500 font-medium">{m.label}</span>
              </div>
              <div className="text-2xl font-bold text-surface-900">{m.value}</div>
            </div>
          )
        })}
      </div>

      {/* Spend — only if permission allows */}
      {canViewSpend && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl border border-surface-200 p-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign size={16} className="text-emerald-500" />
              <span className="text-xs text-surface-500 font-medium">Monthly Spend</span>
            </div>
            <div className="text-xl font-bold text-surface-900">{fmtMoney(summary.monthlySpend)}</div>
          </div>
          <div className="bg-white rounded-xl border border-surface-200 p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp size={16} className="text-brand-500" />
              <span className="text-xs text-surface-500 font-medium">Yearly Spend</span>
            </div>
            <div className="text-xl font-bold text-surface-900">{fmtMoney(summary.yearlySpend)}</div>
          </div>
        </div>
      )}

      {/* Recent Orders */}
      <div className="bg-white rounded-xl border border-surface-200">
        <div className="px-4 py-3 border-b border-surface-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-900">Recent Orders</h3>
          <span className="text-xs text-surface-400">{summary.totalOrders} total</span>
        </div>
        {summary.recentOrders.length === 0 ? (
          <div className="text-center py-8 text-surface-400 text-sm">No orders yet</div>
        ) : (
          <div className="divide-y divide-surface-100">
            {summary.recentOrders.map(o => (
              <button key={o.orderId} onClick={() => onViewOrder(o.orderId)}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-50 transition-colors text-left">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-surface-900">{o.orderId}</div>
                  <div className="text-xs text-surface-500 truncate">{o.vendor} — {o.orderedBy}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-surface-900">{fmtMoney(o.total)}</div>
                  <StatusBadge status={o.status} />
                </div>
                <ChevronRight size={14} className="text-surface-300" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS LIST TAB
// ═══════════════════════════════════════════════════════════════════════════════

function OrdersTab({ onViewOrder, hasPerm }) {
  const canViewAll = hasPerm('view_all_po')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const { orders, loading, refresh } = usePOList(statusFilter, canViewAll)

  const filtered = useMemo(() => {
    if (!search) return orders
    const s = search.toLowerCase()
    return orders.filter(o =>
      (o.order_id || '').toLowerCase().includes(s) ||
      (o.vendor_name || '').toLowerCase().includes(s) ||
      (o.other_vendor || '').toLowerCase().includes(s) ||
      (o.ordered_by || '').toLowerCase().includes(s)
    )
  }, [orders, search])

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search orders..." className="input pl-9 text-sm" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="input text-sm w-auto">
          <option value="all">All Status</option>
          <option value="active">Active Only</option>
          <option value="Pending">Pending</option>
          <option value="Approved">Approved</option>
          <option value="Ordered">Ordered</option>
          <option value="Partial">Partial</option>
          <option value="Received">Received</option>
          <option value="Cancelled">Cancelled</option>
          <option value="Rejected">Rejected</option>
        </select>
      </div>

      {/* Info banner for filtered view */}
      {!canViewAll && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 flex items-center gap-2">
          <Eye size={14} /> Showing only orders you created.
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-surface-400">Loading orders...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-surface-400">
          <ShoppingCart size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">No orders found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 text-left">
                  <th scope="col" className="px-4 py-2.5 font-semibold text-surface-600 text-xs">PO #</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-surface-600 text-xs">Vendor</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-surface-600 text-xs">Ordered By</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-surface-600 text-xs">Date</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-surface-600 text-xs text-right">Total</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-surface-600 text-xs">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {filtered.map(o => (
                  <tr key={o.order_id} onClick={() => onViewOrder(o.order_id)}
                    className="hover:bg-surface-50 cursor-pointer transition-colors">
                    <td className="px-4 py-2.5 font-medium text-brand-700">{o.order_id}</td>
                    <td className="px-4 py-2.5 text-surface-700">{o.vendor_name || o.other_vendor || '—'}</td>
                    <td className="px-4 py-2.5 text-surface-500">{o.ordered_by || '—'}</td>
                    <td className="px-4 py-2.5 text-surface-500">{fmtDate(o.order_date)}</td>
                    <td className="px-4 py-2.5 text-surface-900 font-semibold text-right">{fmtMoney(o.total)}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function OrderDetailView({ orderId, onBack, hasPerm, autoReceive = false }) {
  const { profile } = useAuth()
  const { order, lineItems, loading, refresh } = usePODetail(orderId)
  const actions = usePOActions()
  const [receiveMode, setReceiveMode] = useState(false)
  const [recQtys, setRecQtys] = useState({})
  const [showRejectModal, setShowRejectModal] = useState(false)
  const { sendRejectionNotification } = useRejectionNotification()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const autoReceiveTriggeredRef = useRef(false)

  // ── Edit mode state ──────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false)
  // editValues: { [line_id]: { unitPrice: string, quantity: string } }
  const [editValues, setEditValues] = useState({})
  const [editSavingId, setEditSavingId] = useState(null) // line_id currently saving
  const [editSaving, setEditSaving] = useState(false) // saving all on exit

  // ── Add line item state ──────────────────────────────────────────
  const [showAddLine, setShowAddLine] = useState(false)
  const [newLine, setNewLine] = useState({ partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' })
  const [addInvSearch, setAddInvSearch] = useState('')
  const [addInvResults, setAddInvResults] = useState([])
  const [addSaving, setAddSaving] = useState(false)

  // Permission-based action checks
  const canApprove = hasPerm('approve_po')
  const canSend = hasPerm('send_po')
  const canReceive = hasPerm('receive_po')
  const canCancel = hasPerm('cancel_po')
  const canPrint = hasPerm('print_po')
  const canEdit = hasPerm('edit_po')

  // Whether this order's line items can be edited
  const isEditable = canEdit && order && EDITABLE_STATUSES.includes(order.status)

  // Auto-enter receive mode when opened via QR scan
  useEffect(() => {
    if (autoReceive && order && lineItems.length > 0 && canReceive && !autoReceiveTriggeredRef.current) {
      if (['Ordered', 'Partial'].includes(order.status)) {
        autoReceiveTriggeredRef.current = true
        const qtys = {}
        lineItems.forEach(li => { qtys[li.line_id] = parseInt(li.received_qty) || 0 })
        setRecQtys(qtys)
        setReceiveMode(true)
      }
    }
  }, [autoReceive, order, lineItems, canReceive])

  if (loading) return <div className="text-center py-12 text-surface-400">Loading...</div>
  if (!order) return <div className="text-center py-12 text-surface-400">Order not found</div>

  // ── Edit mode helpers ────────────────────────────────────────────
  const enterEditMode = () => {
    const vals = {}
    lineItems.forEach(li => {
      vals[li.line_id] = {
        unitPrice: (parseFloat(li.unit_price) || 0).toString(),
        quantity: (parseInt(li.quantity) || 1).toString()
      }
    })
    setEditValues(vals)
    setEditMode(true)
    setReceiveMode(false)
  }
  const exitEditMode = async () => {
    // Save all changed rows before exiting
    const changedLines = lineItems.filter(li => {
      const ev = editValues[li.line_id]
      if (!ev) return false
      return ev.unitPrice !== (parseFloat(li.unit_price) || 0).toString() ||
             ev.quantity !== (parseInt(li.quantity) || 1).toString()
    })
    if (changedLines.length > 0) {
      setEditSaving(true)
      let anyFailed = false
      for (const li of changedLines) {
        const vals = editValues[li.line_id]
        const ok = await actions.updateLineItem(orderId, li.line_id, {
          unitPrice: vals.unitPrice,
          quantity: vals.quantity
        })
        if (!ok) anyFailed = true
      }
      setEditSaving(false)
      if (!anyFailed) {
        refresh()
      }
    }
    setEditMode(false)
    setEditValues({})
    setEditSavingId(null)
  }
  const updateEditValue = (lineId, field, value) => {
    setEditValues(prev => ({
      ...prev,
      [lineId]: { ...prev[lineId], [field]: value }
    }))
  }
  const handleSaveLineEdit = async (lineId) => {
    const vals = editValues[lineId]
    if (!vals) return
    setEditSavingId(lineId)
    const ok = await actions.updateLineItem(orderId, lineId, {
      unitPrice: vals.unitPrice,
      quantity: vals.quantity
    })
    setEditSavingId(null)
    if (ok) refresh()
  }
  const handleDeleteLine = async (lineId) => {
    if (!confirm('Remove this line item?')) return
    setEditSavingId(lineId)
    const ok = await actions.deleteLineItem(orderId, lineId)
    setEditSavingId(null)
    if (ok) {
      // Remove from editValues
      setEditValues(prev => {
        const next = { ...prev }
        delete next[lineId]
        return next
      })
      refresh()
    }
  }

  // ── Add line item helpers ────────────────────────────────────────
  const searchInventoryForAdd = async (term) => {
    if (term.length < 2) { setAddInvResults([]); return }
    const { data } = await supabase.from('inventory').select('part_id, part_name, supplier_part_number, qty_in_stock')
      .eq('status', 'Active').or(`part_name.ilike.%${term}%,part_id.ilike.%${term}%,supplier_part_number.ilike.%${term}%`).limit(10)
    setAddInvResults(data || [])
  }
  const selectInventoryItem = (item) => {
    setNewLine(prev => ({
      ...prev,
      partNumber: item.supplier_part_number || item.part_id,
      description: item.part_name,
      inventoryPartId: item.part_id
    }))
    setAddInvSearch('')
    setAddInvResults([])
  }
  const handleAddLineSubmit = async () => {
    if (!newLine.description.trim()) { toast.error('Description is required'); return }
    setAddSaving(true)
    try {
      await actions.addLineToOrder(orderId, [newLine])
      setNewLine({ partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' })
      setShowAddLine(false)
      refresh()
    } catch {} finally {
      setAddSaving(false)
    }
  }

  const handleApprove = async () => {
    await actions.approveOrder(orderId)
    refresh()
  }
  const handleReject = async (reason) => {
    await actions.rejectOrder(orderId, reason)

    // Notify the person who created the PO
    if (order?.ordered_by) {
      try {
        // Look up email from the ordered_by name
        const nameParts = (order.ordered_by || '').split(' ')
        const firstName = nameParts[0] || ''
        const { data: creator } = await supabase
          .from('profiles')
          .select('email, first_name, last_name')
          .ilike('first_name', firstName)
          .eq('status', 'Active')
          .limit(5)

        // Match by checking the formatted name pattern "First L."
        const match = (creator || []).find(p => {
          const formatted = `${p.first_name} ${(p.last_name || '').charAt(0)}.`
          return formatted === order.ordered_by
        })

        if (match?.email) {
          await sendRejectionNotification({
            recipientEmail: match.email,
            recipientName: order.ordered_by,
            requestType: 'Purchase Order',
            requestId: orderId,
            reason,
            extraDetails: `Vendor: ${order.vendor_name || ''}`,
          })
        }
      } catch (err) {
        console.warn('PO rejection notification lookup failed:', err.message)
      }
    }

    setShowRejectModal(false)
    refresh()
  }
  const handleMarkOrdered = async () => {
    await actions.markOrdered(orderId)
    refresh()
    // Auto-open print view after marking as ordered
    if (canPrint) {
      setTimeout(() => printPO(), 500)
    }
  }

  const printPO = () => {
    const vendor = order.vendor_name || order.other_vendor || 'Unknown'
    const qrData = encodeURIComponent(orderId)
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${qrData}`
    const now = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

    const linesHtml = lineItems.map((li, i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;text-align:center;color:#868e96;">${i + 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;font-family:monospace;font-size:0.85rem;">${li.part_number || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;">
          ${li.description || '—'}
          ${li.link ? `<br/><a href="${li.link}" style="font-size:0.75rem;color:#228be6;">Link</a>` : ''}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;font-size:0.8rem;color:#495057;">${li.wo_id || order.work_order_id || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;text-align:center;">${li.quantity}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;text-align:right;">${fmtMoney(li.unit_price)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e9ecef;text-align:right;font-weight:600;">${fmtMoney(li.subtotal)}</td>
      </tr>
    `).join('')

    const html = `<!DOCTYPE html>
<html><head><title>Purchase Order — ${orderId}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a2e; padding: 40px; max-width: 800px; margin: 0 auto; }
  @media print {
    body { padding: 20px; }
    .no-print { display: none !important; }
    @page { margin: 0.5in; }
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 3px solid #1a1a2e; }
  .header-left h1 { font-size: 1.6rem; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
  .header-left h2 { font-size: 1.1rem; font-weight: 400; color: #228be6; }
  .header-left p { font-size: 0.8rem; color: #868e96; margin-top: 4px; }
  .header-right { text-align: right; }
  .header-right img { margin-bottom: 6px; }
  .header-right p { font-size: 0.72rem; color: #868e96; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
  .info-box { background: #f8f9fa; border-radius: 8px; padding: 16px; }
  .info-box h3 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; color: #868e96; margin-bottom: 8px; font-weight: 600; }
  .info-box p { font-size: 0.88rem; color: #1a1a2e; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  thead th { background: #1a1a2e; color: #fff; padding: 10px 12px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  thead th:first-child { border-radius: 8px 0 0 0; }
  thead th:last-child { border-radius: 0 8px 0 0; }
  .total-row td { padding: 12px; font-weight: 700; font-size: 1rem; border-top: 2px solid #1a1a2e; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #dee2e6; display: flex; justify-content: space-between; align-items: flex-end; }
  .footer-left p { font-size: 0.78rem; color: #868e96; line-height: 1.8; }
  .footer-right { text-align: center; }
  .footer-right p { font-size: 0.7rem; color: #868e96; margin-top: 4px; }
  .receive-box { margin-top: 32px; border: 2px dashed #dee2e6; border-radius: 8px; padding: 20px; }
  .receive-box h3 { font-size: 0.82rem; font-weight: 600; margin-bottom: 12px; color: #495057; }
  .receive-line { display: flex; gap: 16px; margin-bottom: 8px; align-items: center; font-size: 0.82rem; }
  .receive-line .line { flex: 1; border-bottom: 1px solid #dee2e6; min-height: 20px; }
  .btn-print { display: inline-flex; align-items: center; gap: 6px; padding: 10px 24px; background: #228be6; color: #fff; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; margin-bottom: 20px; }
  .btn-print:hover { background: #1c7ed6; }
</style></head>
<body>
  <button class="btn-print no-print" onclick="window.print()">🖨️ Print Purchase Order</button>

  <div class="header">
    <div class="header-left">
      <h1>RICT CMMS</h1>
      <h2>Purchase Order</h2>
      <p>Printed ${now}</p>
    </div>
    <div class="header-right">
      <img src="${qrUrl}" width="120" height="120" alt="QR: ${orderId}" />
      <p>Scan to receive</p>
      <p style="font-weight:600;font-size:0.9rem;color:#1a1a2e;">${orderId}</p>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h3>Vendor</h3>
      <p style="font-weight:600;font-size:1rem;">${vendor}</p>
    </div>
    <div class="info-box">
      <h3>Order Details</h3>
      <p>Ordered by: <strong>${order.ordered_by || '—'}</strong></p>
      <p>Date: ${fmtDate(order.order_date)}</p>
      ${(() => {
        const woIds = [...new Set(lineItems.map(li => li.wo_id).filter(Boolean))]
        const allWos = woIds.length > 0 ? woIds : (order.work_order_id ? [order.work_order_id] : [])
        return allWos.length > 0 ? `<p>Work Order${allWos.length > 1 ? 's' : ''}: <strong>${allWos.join(', ')}</strong></p>` : ''
      })()}
      <p>Status: <strong>${order.status}</strong></p>
    </div>
  </div>

  ${order.notes ? `<div style="margin-bottom:20px;padding:10px 14px;background:#fff3bf;border-radius:8px;font-size:0.85rem;color:#e67700;">📝 ${order.notes}</div>` : ''}

  <table>
    <thead>
      <tr>
        <th style="text-align:center;width:40px;">#</th>
        <th style="text-align:left;">Part #</th>
        <th style="text-align:left;">Description</th>
        <th style="text-align:left;">WO</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml}
      <tr class="total-row">
        <td colspan="6" style="text-align:right;">Total</td>
        <td style="text-align:right;font-size:1.1rem;">${fmtMoney(order.total)}</td>
      </tr>
    </tbody>
  </table>

  <div class="receive-box">
    <h3>📦 Receiving Confirmation</h3>
    <div class="receive-line"><span style="min-width:100px;">Received by:</span><div class="line"></div></div>
    <div class="receive-line"><span style="min-width:100px;">Date:</span><div class="line"></div></div>
    <div class="receive-line"><span style="min-width:100px;">Condition:</span><div class="line"></div></div>
    <div class="receive-line"><span style="min-width:100px;">Notes:</span><div class="line"></div></div>
  </div>

  <div class="footer">
    <div class="footer-left">
      <p>RICT Maintenance System</p>
      <p>${orderId} · ${vendor} · ${fmtMoney(order.total)}</p>
    </div>
    <div class="footer-right">
      <img src="${qrUrl}" width="64" height="64" alt="QR" />
      <p>${orderId}</p>
    </div>
  </div>
</body></html>`

    const printWin = window.open('', '_blank', 'width=850,height=1100')
    printWin.document.write(html)
    printWin.document.close()
    printWin.onafterprint = () => printWin.close()
  }
  const handleReceive = async () => {
    const items = lineItems.map(li => ({
      lineId: li.line_id,
      receivedQty: recQtys[li.line_id] !== undefined ? recQtys[li.line_id] : (parseInt(li.received_qty) || 0)
    }))
    await actions.receiveItems(orderId, items)
    setReceiveMode(false)
    setRecQtys({})
    refresh()
  }
  const handleCancel = async () => {
    if (!confirm('Cancel this order?')) return
    await actions.cancelOrder(orderId)
    refresh()
  }
  const handleDelete = async () => {
    const deleted = await actions.deleteOrder(orderId)
    if (deleted) {
      setShowDeleteConfirm(false)
      onBack()
    }
  }

  // Build timeline
  const timeline = [{ status: 'Created', date: order.order_date, by: order.ordered_by, icon: '➕' }]
  if (order.status === 'Rejected') {
    timeline.push({ status: 'Rejected', date: order.approved_date, by: order.approved_by, icon: '❌' })
  } else if (order.status === 'Cancelled') {
    timeline.push({ status: 'Cancelled', date: '', by: '', icon: '🚫' })
  } else {
    if (order.approved_date) timeline.push({ status: 'Approved', date: order.approved_date, by: order.approved_by, icon: '✅' })
    if (order.ordered_date) timeline.push({ status: 'Ordered', date: order.ordered_date, by: '', icon: '🚚' })
    if (order.status === 'Partial') timeline.push({ status: 'Partial', date: '', by: '', icon: '📦' })
    if (order.received_date) timeline.push({ status: 'Received', date: order.received_date, by: order.received_by, icon: '✅' })
  }

  // Calculate whether a line's edit values differ from the original
  const lineHasChanges = (li) => {
    const ev = editValues[li.line_id]
    if (!ev) return false
    return ev.unitPrice !== (parseFloat(li.unit_price) || 0).toString() ||
           ev.quantity !== (parseInt(li.quantity) || 1).toString()
  }

  // Computed subtotal for edit mode
  const editSubtotal = (lineId) => {
    const ev = editValues[lineId]
    if (!ev) return 0
    return (parseFloat(ev.unitPrice) || 0) * (parseInt(ev.quantity) || 0)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-surface-100" aria-label="Go back"><ArrowLeft size={18} /></button>
        <div className="flex-1">
          <h2 className="text-lg font-bold text-surface-900">{orderId}</h2>
          <p className="text-sm text-surface-500">{order.vendor_name || order.other_vendor}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {/* Auto-receive banner */}
      {autoReceive && receiveMode && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-700 flex items-center gap-2">
          <ScanLine size={14} /> Opened via QR scan — update received quantities below and save.
        </div>
      )}

      {/* Actions — all permission-gated */}
      <div className="flex flex-wrap gap-2">
        {canApprove && order.status === 'Pending' && (
          <>
            <button onClick={handleApprove} className="btn-primary text-xs gap-1" disabled={actions.saving}>
              <Check size={14} /> Approve
            </button>
            <button onClick={() => setShowRejectModal(true)} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700">
              <Ban size={14} /> Reject
            </button>
          </>
        )}
        {canSend && ['Approved', 'Ready', 'Submitted'].includes(order.status) && (
          <button onClick={handleMarkOrdered} className="btn-primary text-xs gap-1" disabled={actions.saving}>
            <Send size={14} /> Mark Ordered
          </button>
        )}
        {canReceive && ['Ordered', 'Partial'].includes(order.status) && (
          <button onClick={() => {
            const qtys = {}
            lineItems.forEach(li => { qtys[li.line_id] = parseInt(li.received_qty) || 0 })
            setRecQtys(qtys)
            setReceiveMode(true)
            setEditMode(false)
          }} className="btn-primary text-xs gap-1">
            <Package size={14} /> Receive Items
          </button>
        )}
        {canCancel && !['Received', 'Cancelled', 'Rejected'].includes(order.status) && (
          <button onClick={handleCancel} className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs font-medium hover:bg-surface-200">
            <XCircle size={14} /> Cancel
          </button>
        )}
        {canPrint && !['Pending', 'Rejected', 'Cancelled'].includes(order.status) && (
          <button onClick={printPO} className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-700 text-xs font-medium hover:bg-surface-200 flex items-center gap-1">
            <Printer size={14} /> Print PO
          </button>
        )}
        {canCancel && (
          <button onClick={() => setShowDeleteConfirm(true)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 border border-red-200 flex items-center gap-1 ml-auto">
            <Trash2 size={14} /> Delete PO
          </button>
        )}
      </div>

      {/* Reject Modal */}
      <RejectionModal
        open={showRejectModal}
        title="Reject Purchase Order"
        subtitle={`${orderId} — ${order?.vendor_name || 'Unknown vendor'} (ordered by ${order?.ordered_by || 'unknown'})`}
        requestType="Purchase Order"
        requestId={orderId}
        recipientEmail=""
        recipientName={order?.ordered_by || ''}
        onConfirm={handleReject}
        onClose={() => setShowRejectModal(false)}
      />

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div className="bg-white rounded-xl border-2 border-red-300 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Trash2 size={16} className="text-red-600" />
            <h4 className="text-sm font-semibold text-red-700">Permanently Delete {orderId}?</h4>
          </div>
          <p className="text-xs text-surface-600 mb-3">
            This will permanently remove this purchase order and <strong>all related records</strong> including
            line items, work log entries, audit log entries, and program budget entries. This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button onClick={handleDelete} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 flex items-center gap-1" disabled={actions.saving}>
              {actions.saving ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              {actions.saving ? 'Deleting...' : 'Yes, Delete Everything'}
            </button>
            <button onClick={() => setShowDeleteConfirm(false)} className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs">Cancel</button>
          </div>
        </div>
      )}

      {/* Order Info */}
      <div className="bg-white rounded-xl border border-surface-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><span className="text-xs text-surface-400 block">Total</span><span className="font-bold text-lg">{fmtMoney(order.total)}</span></div>
          <div><span className="text-xs text-surface-400 block">Ordered By</span><span className="font-medium">{order.ordered_by || '—'}</span></div>
          <div><span className="text-xs text-surface-400 block">Order Date</span><span>{fmtDate(order.order_date)}</span></div>
          <div><span className="text-xs text-surface-400 block">WO Links</span><span className="font-medium">{
            (() => {
              const woIds = [...new Set(lineItems.map(li => li.wo_id).filter(Boolean))]
              if (woIds.length > 0) return woIds.join(', ')
              return order.work_order_id || '—'
            })()
          }</span></div>
        </div>
        {order.notes && <p className="text-xs text-surface-500 mt-3 italic border-t border-surface-100 pt-2">{order.notes}</p>}
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-xl border border-surface-200 p-4">
        <h3 className="text-sm font-semibold text-surface-900 mb-3">Timeline</h3>
        <div className="flex items-center gap-3 overflow-x-auto pb-1">
          {timeline.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              {i > 0 && <div className="w-6 h-0.5 bg-surface-200" />}
              <div className="flex flex-col items-center min-w-[80px]">
                <span className="text-lg">{t.icon}</span>
                <span className="text-xs font-semibold text-surface-700">{t.status}</span>
                <span className="text-[10px] text-surface-400">{fmtDate(t.date)}</span>
                {t.by && <span className="text-[10px] text-surface-400">{t.by}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Line Items */}
      <div className="bg-white rounded-xl border border-surface-200">
        <div className="px-4 py-3 border-b border-surface-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-900">Line Items ({lineItems.length})</h3>
          <div className="flex gap-2">
            {/* Edit mode toggle */}
            {isEditable && !receiveMode && !editMode && (
              <button onClick={enterEditMode}
                className="px-2.5 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs font-medium hover:bg-surface-200 flex items-center gap-1 transition-colors"
                aria-label="Edit line items">
                <Pencil size={12} /> Edit
              </button>
            )}
            {editMode && (
              <button onClick={exitEditMode}
                disabled={editSaving}
                className="px-2.5 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 flex items-center gap-1">
                {editSaving ? <><Loader2 size={12} className="animate-spin" /> Saving...</> : <><Check size={12} /> Save &amp; Close</>}
              </button>
            )}
            {/* Receive mode controls */}
            {receiveMode && (
              <>
                <button onClick={handleReceive} className="btn-primary text-xs" disabled={actions.saving}>
                  {actions.saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
                </button>
                <button onClick={() => setReceiveMode(false)} className="px-2 py-1 rounded bg-surface-100 text-xs">Cancel</button>
              </>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-50 text-left">
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600">Part #</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600">Description</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600">WO</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600 text-right">Price</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600 text-center">Qty</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600 text-right">Subtotal</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600 text-center">Received</th>
                <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600">Status</th>
                {editMode && <th scope="col" className="px-4 py-2 text-xs font-semibold text-surface-600 text-center">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-100">
              {lineItems.map(li => {
                const ev = editValues[li.line_id]
                const isSaving = editSavingId === li.line_id
                return (
                  <tr key={li.line_id} className="hover:bg-surface-50">
                    <td className="px-4 py-2 font-mono text-xs">{li.part_number || '—'}</td>
                    <td className="px-4 py-2">
                      <div className="text-surface-700">{li.description || '—'}</div>
                      {li.link && <a href={li.link} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-600 hover:underline flex items-center gap-0.5"><Link size={10} />Link</a>}
                    </td>
                    <td className="px-4 py-2 text-xs font-medium text-surface-500">{li.wo_id || order.work_order_id || '—'}</td>
                    <td className="px-4 py-2 text-right">
                      {editMode && ev ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={ev.unitPrice}
                          onChange={e => updateEditValue(li.line_id, 'unitPrice', e.target.value)}
                          className="input text-sm w-24 text-right"
                          aria-label={`Unit price for ${li.description || li.part_number}`}
                        />
                      ) : (
                        fmtMoney(li.unit_price)
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {editMode && ev ? (
                        <input
                          type="number"
                          min="1"
                          value={ev.quantity}
                          onChange={e => updateEditValue(li.line_id, 'quantity', e.target.value)}
                          className="input text-sm w-16 text-center"
                          aria-label={`Quantity for ${li.description || li.part_number}`}
                        />
                      ) : (
                        li.quantity
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-medium">
                      {editMode && ev ? fmtMoney(editSubtotal(li.line_id)) : fmtMoney(li.subtotal)}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {receiveMode ? (
                        <input type="number" min={0} max={li.quantity}
                          value={recQtys[li.line_id] ?? (parseInt(li.received_qty) || 0)}
                          onChange={e => setRecQtys(prev => ({ ...prev, [li.line_id]: parseInt(e.target.value) || 0 }))}
                          className="input text-sm w-16 text-center"
                          aria-label={`Received quantity for ${li.description || li.part_number}`} />
                      ) : (
                        <span>{li.received_qty || 0} / {li.quantity}</span>
                      )}
                    </td>
                    <td className="px-4 py-2"><StatusBadge status={li.status} /></td>
                    {editMode && (
                      <td className="px-4 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {lineHasChanges(li) && (
                            <button
                              onClick={() => handleSaveLineEdit(li.line_id)}
                              disabled={isSaving}
                              className="p-1 rounded text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-50"
                              aria-label={`Save changes for ${li.description || li.part_number}`}
                              title="Save changes"
                            >
                              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                            </button>
                          )}
                          <button
                            onClick={() => handleDeleteLine(li.line_id)}
                            disabled={isSaving || lineItems.length <= 1}
                            className="p-1 rounded text-red-500 hover:bg-red-50 transition-colors disabled:opacity-30"
                            aria-label={`Remove ${li.description || li.part_number}`}
                            title={lineItems.length <= 1 ? 'Cannot remove the last line item' : 'Remove line item'}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Add Line Item section */}
        {isEditable && (
          <div className="px-4 py-3 border-t border-surface-100">
            {!showAddLine ? (
              <button
                onClick={() => setShowAddLine(true)}
                className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1"
              >
                <Plus size={12} /> Add Line Item
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-surface-700">New Line Item</span>
                  <button onClick={() => { setShowAddLine(false); setAddInvSearch(''); setAddInvResults([]) }}
                    className="text-surface-400 hover:text-surface-600" aria-label="Cancel adding line item"><X size={14} /></button>
                </div>

                {/* Inventory search */}
                <div className="relative">
                  <label htmlFor="add-inv-search" className="text-[10px] text-surface-400 block mb-0.5">Search Inventory (optional)</label>
                  <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
                    <input
                      id="add-inv-search"
                      type="text"
                      value={addInvSearch}
                      onChange={e => { setAddInvSearch(e.target.value); searchInventoryForAdd(e.target.value) }}
                      placeholder="Search by name or part #..."
                      className="input text-sm pl-8 w-full"
                    />
                  </div>
                  {addInvResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-surface-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                      {addInvResults.map(item => (
                        <button key={item.part_id} onClick={() => selectInventoryItem(item)}
                          className="w-full text-left px-3 py-2 text-xs hover:bg-surface-50 border-b border-surface-100 last:border-0">
                          <span className="font-medium">{item.part_name}</span>
                          <span className="text-surface-400 ml-2">{item.supplier_part_number || item.part_id}</span>
                          <span className="text-surface-400 ml-2">({item.qty_in_stock} in stock)</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="add-part-num" className="text-[10px] text-surface-400">Part Number</label>
                    <input id="add-part-num" value={newLine.partNumber} onChange={e => setNewLine(l => ({ ...l, partNumber: e.target.value }))} className="input text-sm" placeholder="Part #" />
                  </div>
                  <div>
                    <label htmlFor="add-desc" className="text-[10px] text-surface-400">Description *</label>
                    <input id="add-desc" value={newLine.description} onChange={e => setNewLine(l => ({ ...l, description: e.target.value }))} className="input text-sm" placeholder="Description" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label htmlFor="add-price" className="text-[10px] text-surface-400">Unit Price</label>
                    <input id="add-price" type="number" step="0.01" min="0" value={newLine.unitPrice} onChange={e => setNewLine(l => ({ ...l, unitPrice: e.target.value }))} className="input text-sm" placeholder="0.00" />
                  </div>
                  <div>
                    <label htmlFor="add-qty" className="text-[10px] text-surface-400">Quantity</label>
                    <input id="add-qty" type="number" min={1} value={newLine.quantity} onChange={e => setNewLine(l => ({ ...l, quantity: parseInt(e.target.value) || 1 }))} className="input text-sm" />
                  </div>
                  <div>
                    <label className="text-[10px] text-surface-400">Subtotal</label>
                    <div className="input text-sm bg-surface-50 text-surface-700 font-medium">{fmtMoney((parseFloat(newLine.unitPrice) || 0) * (parseInt(newLine.quantity) || 0))}</div>
                  </div>
                </div>
                <div>
                  <label htmlFor="add-link" className="text-[10px] text-surface-400">Link (optional)</label>
                  <input id="add-link" value={newLine.link} onChange={e => setNewLine(l => ({ ...l, link: e.target.value }))} className="input text-sm" placeholder="https://..." />
                </div>
                <button onClick={handleAddLineSubmit} disabled={addSaving}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50 w-full">
                  {addSaving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                  {addSaving ? 'Adding...' : 'Add to Order'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE PO TAB
// ═══════════════════════════════════════════════════════════════════════════════

function CreatePOTab({ onCreated, hasPerm }) {
  const vendors = useVendors()
  const actions = usePOActions()
  const [form, setForm] = useState({ vendorId: '', vendorName: '', otherVendor: '', workOrderId: '', notes: '' })
  const [lines, setLines] = useState([{ partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' }])
  const [invSearch, setInvSearch] = useState('')
  const [invResults, setInvResults] = useState([])

  const total = lines.reduce((sum, li) => sum + ((parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0)), 0)

  const handleVendorChange = (vendorId) => {
    if (vendorId === 'OTHER') {
      setForm(f => ({ ...f, vendorId: '', vendorName: '', otherVendor: '' }))
    } else {
      const v = vendors.find(v => v.vendor_id === vendorId)
      setForm(f => ({ ...f, vendorId, vendorName: v?.vendor_name || '', otherVendor: '' }))
    }
  }

  const addLine = () => setLines(l => [...l, { partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' }])
  const removeLine = (i) => setLines(l => l.filter((_, idx) => idx !== i))
  const updateLine = (i, field, value) => setLines(l => l.map((li, idx) => idx === i ? { ...li, [field]: value } : li))

  // Inventory search
  const searchInventory = async (term) => {
    if (term.length < 2) { setInvResults([]); return }
    const { data } = await supabase.from('inventory').select('part_id, part_name, supplier_part_number, qty_in_stock')
      .eq('status', 'Active').or(`part_name.ilike.%${term}%,part_id.ilike.%${term}%`).limit(10)
    setInvResults(data || [])
  }

  const addFromInventory = (item, lineIdx) => {
    updateLine(lineIdx, 'partNumber', item.supplier_part_number || item.part_id)
    updateLine(lineIdx, 'description', item.part_name)
    updateLine(lineIdx, 'inventoryPartId', item.part_id)
    setInvSearch('')
    setInvResults([])
  }

  const handleSubmit = async () => {
    if (!form.vendorName && !form.otherVendor) { return alert('Select a vendor') }
    if (lines.length === 0 || !lines[0].description) { return alert('Add at least one line item') }
    try {
      await actions.createOrder({ ...form, lineItems: lines })
      setForm({ vendorId: '', vendorName: '', otherVendor: '', workOrderId: '', notes: '' })
      setLines([{ partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' }])
      onCreated()
    } catch {}
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Vendor */}
      <div className="bg-white rounded-xl border border-surface-200 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-surface-900">Order Details</h3>
        <div>
          <label className="label">Vendor</label>
          <select value={form.vendorId || (form.otherVendor ? 'OTHER' : '')} onChange={e => handleVendorChange(e.target.value)} className="input text-sm">
            <option value="">Select vendor...</option>
            {vendors.map(v => <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name}</option>)}
            <option value="OTHER">Other (type name)</option>
          </select>
        </div>
        {(!form.vendorId && form.vendorName === '') && (
          <div>
            <label className="label">Other Vendor Name</label>
            <input value={form.otherVendor} onChange={e => setForm(f => ({ ...f, otherVendor: e.target.value }))} className="input text-sm" placeholder="Vendor name" />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Linked WO (optional)</label>
            <input value={form.workOrderId} onChange={e => setForm(f => ({ ...f, workOrderId: e.target.value }))} className="input text-sm" placeholder="WO-0001" />
          </div>
          <div>
            <label className="label">Notes</label>
            <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input text-sm" placeholder="Notes..." />
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div className="bg-white rounded-xl border border-surface-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-900">Line Items</h3>
          <button onClick={addLine} className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1"><Plus size={12} /> Add Line</button>
        </div>

        {lines.map((li, i) => (
          <div key={i} className="border border-surface-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-surface-500">Item {i + 1}</span>
              {lines.length > 1 && <button onClick={() => removeLine(i)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-surface-400">Part Number</label>
                <input value={li.partNumber} onChange={e => updateLine(i, 'partNumber', e.target.value)} className="input text-sm" placeholder="Part #" />
              </div>
              <div>
                <label className="text-[10px] text-surface-400">Description</label>
                <input value={li.description} onChange={e => updateLine(i, 'description', e.target.value)} className="input text-sm" placeholder="Description" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-surface-400">Unit Price</label>
                <input type="number" step="0.01" value={li.unitPrice} onChange={e => updateLine(i, 'unitPrice', e.target.value)} className="input text-sm" placeholder="0.00" />
              </div>
              <div>
                <label className="text-[10px] text-surface-400">Quantity</label>
                <input type="number" min={1} value={li.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} className="input text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-surface-400">Subtotal</label>
                <div className="input text-sm bg-surface-50 text-surface-700 font-medium">{fmtMoney((parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0))}</div>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-surface-400">Link (optional)</label>
              <input value={li.link} onChange={e => updateLine(i, 'link', e.target.value)} className="input text-sm" placeholder="https://..." />
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between pt-2 border-t border-surface-100">
          <span className="text-sm font-semibold text-surface-700">Total</span>
          <span className="text-lg font-bold text-surface-900">{fmtMoney(total)}</span>
        </div>
      </div>

      <button onClick={handleSubmit} disabled={actions.saving}
        className="btn-primary w-full gap-2">
        {actions.saving ? <Loader2 size={16} className="animate-spin" /> : <ShoppingCart size={16} />}
        {actions.saving ? 'Creating...' : 'Submit Purchase Order'}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOW STOCK TAB
// ═══════════════════════════════════════════════════════════════════════════════

function LowStockTab({ onCreatePO, hasPerm }) {
  const { items, loading, refresh } = useLowStockItems()
  const { profile } = useAuth()
  const actions = usePOActions()
  const vendors = useVendors()

  const canCreatePO = hasPerm('create_po')
  const canEditInventory = hasPerm('edit_po')

  // Order modal state
  const [orderModal, setOrderModal] = useState(null) // the low stock item being ordered
  const [orderStep, setOrderStep] = useState('loading') // loading | choose | new | adding
  const [existingPO, setExistingPO] = useState(null)
  const [orderQty, setOrderQty] = useState(0)
  const [orderSaving, setOrderSaving] = useState(false)

  // Adjust modal state
  const [adjustModal, setAdjustModal] = useState(null)
  const [adjustMin, setAdjustMin] = useState(0)
  const [adjustMax, setAdjustMax] = useState(0)
  const [adjustSaving, setAdjustSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const openOrderModal = async (item) => {
    setOrderModal(item)
    setOrderQty(item.orderQty || 1)
    setOrderStep('loading')
    setExistingPO(null)

    // Check for existing unplaced PO from same vendor
    if (item.primary_supplier) {
      try {
        const found = await actions.findExistingPOForVendor(item.primary_supplier)
        if (found) {
          setExistingPO(found)
          setOrderStep('choose')
        } else {
          setOrderStep('new')
        }
      } catch {
        setOrderStep('new')
      }
    } else {
      setOrderStep('new')
    }
  }

  const closeOrderModal = () => {
    setOrderModal(null)
    setOrderStep('loading')
    setExistingPO(null)
  }

  // Adjust min/max modal
  const openAdjustModal = (item) => {
    setAdjustModal(item)
    setAdjustMin(item.min_qty || 0)
    setAdjustMax(item.max_qty || 0)
  }

  const handleSaveAdjust = async () => {
    if (!adjustModal) return
    setAdjustSaving(true)
    try {
      const newMin = parseInt(adjustMin) || 0
      const newMax = parseInt(adjustMax) || 0
      const { error, status } = await supabase.from('inventory').update({
        min_qty: newMin,
        max_qty: newMax,
        updated_at: new Date().toISOString(),
        updated_by: userName
      }).eq('part_id', adjustModal.part_id)
      console.log('[Adjust] Update result:', { error, status, partId: adjustModal.part_id, newMin, newMax })
      if (error) throw error
      toast.success(`Updated min/max for ${adjustModal.part_name}`)
      setAdjustModal(null)
      refresh()
    } catch (err) {
      console.error('[Adjust] Save error:', err)
      toast.error('Error: ' + (err?.message || 'Unknown error'))
    } finally {
      setAdjustSaving(false)
    }
  }

  // Build the line item from the low stock item
  const buildLineItem = (item, qty) => ({
    partNumber: item.supplier_part_number || '',
    description: item.part_name || '',
    link: '',
    unitPrice: '',
    quantity: qty,
    inventoryPartId: item.part_id || '',
  })

  // Mark inventory as on-order
  const markInventoryOrdered = async (partId) => {
    try {
      await supabase.from('inventory').update({
        order_date: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: userName
      }).eq('part_id', partId)
    } catch (err) {
      console.warn('Failed to mark inventory order_date:', err)
    }
  }

  // Create new PO for this item
  const handleCreateNew = async () => {
    if (!orderModal) return
    setOrderSaving(true)
    try {
      const item = orderModal
      // Find vendor_id from vendors list
      const vendor = vendors.find(v => v.vendor_name === item.primary_supplier)

      await actions.createOrder({
        vendorId: vendor?.vendor_id || '',
        vendorName: vendor?.vendor_name || item.primary_supplier || '',
        otherVendor: vendor ? '' : (item.primary_supplier || 'Unknown'),
        workOrderId: '',
        notes: `Low stock reorder for ${item.part_name}`,
        lineItems: [buildLineItem(item, orderQty)]
      })
      await markInventoryOrdered(item.part_id)
      closeOrderModal()
      refresh()
    } catch (err) {
      console.error('Create PO error:', err)
    } finally {
      setOrderSaving(false)
    }
  }

  // Add to existing PO
  const handleAddToExisting = async () => {
    if (!orderModal || !existingPO) return
    setOrderSaving(true)
    try {
      const item = orderModal
      await actions.addLineToOrder(existingPO.order_id, [buildLineItem(item, orderQty)])
      await markInventoryOrdered(item.part_id)
      closeOrderModal()
      refresh()
    } catch (err) {
      console.error('Add to PO error:', err)
    } finally {
      setOrderSaving(false)
    }
  }

  if (loading) return <div className="text-center py-12 text-surface-400">Loading low stock items...</div>

  const needsOrder = items.filter(i => !i.alreadyOrdered)
  const onOrder = items.filter(i => i.alreadyOrdered)

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <CheckCircle2 size={40} className="mx-auto mb-3 text-emerald-400" />
        <p className="text-surface-500">All inventory items are above minimum levels!</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-900 flex items-center gap-2">
          <AlertTriangle size={16} className="text-red-500" /> {items.length} items below minimum
        </h3>
      </div>

      {needsOrder.length > 0 && (
        <>
          <h4 className="text-xs font-bold text-red-700 uppercase tracking-wide">Needs Ordering ({needsOrder.length})</h4>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {needsOrder.map(item => (
              <div key={item.part_id} className="bg-white rounded-xl border border-red-200 p-3 space-y-2">
                <div className="text-sm font-semibold text-surface-900">{item.part_name}</div>
                <div className="text-xs text-surface-500">{item.primary_supplier || 'No vendor'} | {item.supplier_part_number || 'No part #'}</div>
                <div className="flex gap-3 text-xs">
                  <span className="text-red-600 font-medium">Current: {item.qty_in_stock}</span>
                  <span className="text-surface-400">Min: {item.min_qty}</span>
                  <span className="text-surface-400">Max: {item.max_qty}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-amber-700">Need to order: {item.orderQty}</div>
                  <div className="flex gap-1.5">
                    {canEditInventory && (
                      <button
                        onClick={() => openAdjustModal(item)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-surface-200 text-surface-600 hover:bg-surface-50 transition-colors"
                      >
                        <SlidersHorizontal size={11} /> Adjust
                      </button>
                    )}
                    {canCreatePO && (
                      <button
                        onClick={() => openOrderModal(item)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-700 transition-colors"
                      >
                        <ShoppingCart size={12} /> Order
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {onOrder.length > 0 && (
        <>
          <h4 className="text-xs font-bold text-emerald-700 uppercase tracking-wide mt-4">Already On Order ({onOrder.length})</h4>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {onOrder.map(item => (
              <div key={item.part_id} className="bg-white rounded-xl border border-emerald-200 p-3 space-y-1">
                <div className="text-sm font-semibold text-surface-900">{item.part_name}</div>
                <div className="text-xs text-surface-500">{item.primary_supplier || 'No vendor'} | On Order</div>
                <div className="flex gap-3 text-xs">
                  <span className="text-surface-600">Current: {item.qty_in_stock}</span>
                  <span className="text-surface-400">Min: {item.min_qty}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Order Modal */}
      {orderModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeOrderModal}>
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
              <h3 className="text-sm font-bold text-surface-900 flex items-center gap-2">
                <ShoppingCart size={16} className="text-brand-600" /> Order Part
              </h3>
              <button onClick={closeOrderModal} className="text-surface-400 hover:text-surface-600"><X size={16} /></button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Part info */}
              <div className="bg-surface-50 rounded-lg p-3 space-y-1">
                <div className="text-sm font-semibold text-surface-900">{orderModal.part_name}</div>
                <div className="text-xs text-surface-500">
                  {orderModal.primary_supplier || 'No vendor'} {orderModal.supplier_part_number ? `| ${orderModal.supplier_part_number}` : ''}
                </div>
                <div className="flex gap-3 text-xs mt-1">
                  <span className="text-red-600 font-medium">Current: {orderModal.qty_in_stock}</span>
                  <span className="text-surface-400">Min: {orderModal.min_qty}</span>
                  <span className="text-surface-400">Max: {orderModal.max_qty}</span>
                </div>
              </div>

              {/* Quantity */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">Order Quantity</label>
                <input
                  type="number" min={1} value={orderQty}
                  onChange={e => setOrderQty(parseInt(e.target.value) || 1)}
                  className="input text-sm w-28"
                />
                <span className="text-xs text-surface-400 ml-2">
                  (Suggested: {orderModal.orderQty} to reach max)
                </span>
              </div>

              {/* Loading state */}
              {orderStep === 'loading' && (
                <div className="text-center py-4 text-surface-400 flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" /> Checking for existing POs...
                </div>
              )}

              {/* Choose: existing PO found */}
              {orderStep === 'choose' && existingPO && (
                <div className="space-y-3">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <FileText size={14} className="text-blue-600" />
                      <span className="text-xs font-semibold text-blue-800">Existing PO found for {orderModal.primary_supplier}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-bold text-blue-900">{existingPO.order_id}</span>
                        <span className="ml-2"><StatusBadge status={existingPO.status} /></span>
                      </div>
                      <span className="text-sm font-semibold text-surface-700">{fmtMoney(existingPO.total)}</span>
                    </div>
                  </div>

                  <button
                    onClick={handleAddToExisting}
                    disabled={orderSaving}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    {orderSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    Add to {existingPO.order_id}
                  </button>

                  <div className="relative flex items-center">
                    <div className="flex-1 border-t border-surface-200" />
                    <span className="px-3 text-xs text-surface-400">or</span>
                    <div className="flex-1 border-t border-surface-200" />
                  </div>

                  <button
                    onClick={handleCreateNew}
                    disabled={orderSaving}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-surface-200 text-surface-700 hover:bg-surface-50 transition-colors disabled:opacity-50"
                  >
                    {orderSaving ? <Loader2 size={14} className="animate-spin" /> : <ShoppingCart size={14} />}
                    Create New PO
                  </button>
                </div>
              )}

              {/* New PO (no existing found) */}
              {orderStep === 'new' && (
                <div className="space-y-3">
                  <div className="bg-surface-50 rounded-lg p-3">
                    <div className="text-xs text-surface-500">
                      {orderModal.primary_supplier
                        ? `A new PO will be created for ${orderModal.primary_supplier}.`
                        : 'No vendor set on this part. A new PO will be created.'}
                    </div>
                  </div>

                  <button
                    onClick={handleCreateNew}
                    disabled={orderSaving}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
                  >
                    {orderSaving ? <Loader2 size={14} className="animate-spin" /> : <ShoppingCart size={14} />}
                    {orderSaving ? 'Creating PO...' : 'Create Purchase Order'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Adjust Min/Max Modal */}
      {adjustModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setAdjustModal(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
              <h3 className="text-sm font-bold text-surface-900 flex items-center gap-2">
                <SlidersHorizontal size={16} className="text-surface-500" /> Adjust Stock Levels
              </h3>
              <button onClick={() => setAdjustModal(null)} className="text-surface-400 hover:text-surface-600"><X size={16} /></button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div className="bg-surface-50 rounded-lg p-3">
                <div className="text-sm font-semibold text-surface-900">{adjustModal.part_name}</div>
                <div className="text-xs text-surface-500 mt-0.5">Current stock: {adjustModal.qty_in_stock}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-surface-600 mb-1 block">Min Qty</label>
                  <input type="number" min={0} value={adjustMin} onChange={e => setAdjustMin(e.target.value)}
                    className="input text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-surface-600 mb-1 block">Max Qty</label>
                  <input type="number" min={0} value={adjustMax} onChange={e => setAdjustMax(e.target.value)}
                    className="input text-sm" />
                </div>
              </div>
              {parseInt(adjustMin) === 0 && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  <AlertTriangle size={14} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <span className="text-xs text-amber-800">Setting min to 0 will remove this item from the low stock list.</span>
                </div>
              )}
              <button onClick={handleSaveAdjust} disabled={adjustSaving}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50">
                {adjustSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {adjustSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
