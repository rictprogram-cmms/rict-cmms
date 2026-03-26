import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import toast from 'react-hot-toast'

// ─── PO Dashboard Summary ────────────────────────────────────────────────────

export function usePODashboard(viewAll = true) {
  const { profile } = useAuth()
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : null

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      let query = supabase
        .from('orders')
        .select('order_id, vendor_name, other_vendor, ordered_by, status, total, order_date')
        .order('order_date', { ascending: false })

      // If user cannot view all POs, filter to only their own
      if (!viewAll && userName) {
        query = query.eq('ordered_by', userName)
      }

      const { data, error } = await query

      if (error) throw error

      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const yearStart = new Date(now.getFullYear(), 0, 1)
      const s = {
        pendingApproval: 0, approved: 0, onOrder: 0, partiallyReceived: 0,
        received: 0, cancelled: 0, rejected: 0, totalOrders: 0,
        monthlySpend: 0, yearlySpend: 0, recentOrders: []
      }

      ;(data || []).forEach(o => {
        s.totalOrders++
        const total = parseFloat(o.total) || 0
        switch (o.status) {
          case 'Pending': s.pendingApproval++; break
          case 'Approved': case 'Ready': case 'Submitted': s.approved++; break
          case 'Ordered': s.onOrder++; break
          case 'Partial': s.partiallyReceived++; break
          case 'Received': s.received++; break
          case 'Cancelled': s.cancelled++; break
          case 'Rejected': s.rejected++; break
        }
        if (o.order_date) {
          const od = new Date(o.order_date)
          if (['Ordered', 'Partial', 'Received'].includes(o.status)) {
            if (od >= monthStart) s.monthlySpend += total
            if (od >= yearStart) s.yearlySpend += total
          }
        }
        if (s.recentOrders.length < 5) {
          s.recentOrders.push({
            orderId: o.order_id,
            vendor: o.vendor_name || o.other_vendor || 'Unknown',
            orderedBy: o.ordered_by || '',
            total: total.toFixed(2),
            status: o.status,
            orderDate: o.order_date
          })
        }
      })
      setSummary(s)
      hasLoadedRef.current = true
    } catch (err) {
      console.error('PO Dashboard error:', err)
    } finally {
      setLoading(false)
    }
  }, [viewAll, userName])

  useEffect(() => { fetch() }, [fetch])

  // Realtime: refresh dashboard when orders change
  useEffect(() => {
    const channel = supabase.channel('po-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => fetch())
      .subscribe()
    const onPOUpdate = () => fetch()
    window.addEventListener('po-updated', onPOUpdate)
    return () => { supabase.removeChannel(channel); window.removeEventListener('po-updated', onPOUpdate) }
  }, [fetch])

  // Re-fetch when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        fetch()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetch])

  return { summary, loading, refresh: fetch }
}

// ─── All Orders List ─────────────────────────────────────────────────────────

export function usePOList(statusFilter = 'all', viewAll = true) {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : null

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      let query = supabase
        .from('orders')
        .select('*')
        .order('order_date', { ascending: false })

      // If user cannot view all POs, filter to only their own
      if (!viewAll && userName) {
        query = query.eq('ordered_by', userName)
      }

      if (statusFilter && statusFilter !== 'all') {
        if (statusFilter === 'active') {
          query = query.not('status', 'in', '("Received","Cancelled","Rejected")')
        } else {
          query = query.eq('status', statusFilter)
        }
      }

      const { data, error } = await query
      if (error) throw error
      setOrders(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('PO list error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, viewAll, userName])

  useEffect(() => { fetch() }, [fetch])

  // Realtime: refresh list when orders change
  useEffect(() => {
    const channel = supabase.channel('po-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => fetch())
      .subscribe()
    const onPOUpdate = () => fetch()
    window.addEventListener('po-updated', onPOUpdate)
    return () => { supabase.removeChannel(channel); window.removeEventListener('po-updated', onPOUpdate) }
  }, [fetch])

  // Re-fetch when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        fetch()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetch])

  return { orders, loading, refresh: fetch }
}

// ─── Single Order Detail with Line Items ─────────────────────────────────────

export function usePODetail(orderId) {
  const [order, setOrder] = useState(null)
  const [lineItems, setLineItems] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!orderId) return
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const [orderRes, linesRes] = await Promise.all([
        supabase.from('orders').select('*').eq('order_id', orderId).single(),
        supabase.from('order_line_items').select('*').eq('order_id', orderId)
      ])
      if (orderRes.error) throw orderRes.error
      setOrder(orderRes.data)
      setLineItems(linesRes.data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('PO detail error:', err)
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => { fetch() }, [fetch])

  // Realtime: refresh detail when order or line items change
  useEffect(() => {
    if (!orderId) return
    const channel = supabase.channel(`po-detail-${orderId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        if (payload.new?.order_id === orderId || payload.old?.order_id === orderId) fetch()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_line_items' }, (payload) => {
        if (payload.new?.order_id === orderId || payload.old?.order_id === orderId) fetch()
      })
      .subscribe()
    const onPOUpdate = (e) => { if (!e.detail?.orderId || e.detail.orderId === orderId) fetch() }
    window.addEventListener('po-updated', onPOUpdate)
    return () => { supabase.removeChannel(channel); window.removeEventListener('po-updated', onPOUpdate) }
  }, [orderId, fetch])

  return { order, lineItems, loading, refresh: fetch }
}

// ─── Vendors for Dropdown ────────────────────────────────────────────────────

export function useVendors() {
  const [vendors, setVendors] = useState([])
  useEffect(() => {
    async function f() {
      const { data } = await supabase.from('vendors').select('*').eq('status', 'Active').order('vendor_name')
      setVendors(data || [])
    }
    f()
  }, [])
  return vendors
}

// ─── PO Actions ──────────────────────────────────────────────────────────────

export function usePOActions() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Purchase Orders')
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  // Use permission-based check instead of hardcoded role check
  const canApprove = hasPerm('approve_po')

  // Generate next order ID
  const getNextOrderId = async () => {
    try {
      const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'Order' })
      if (counter) return counter
    } catch {}
    const { data: maxRow } = await supabase
      .from('orders')
      .select('order_id')
      .order('order_id', { ascending: false })
      .limit(1)
      .maybeSingle()
    let next = 1016
    if (maxRow?.order_id) {
      const num = parseInt(maxRow.order_id.replace(/\D/g, ''))
      if (!isNaN(num)) next = num + 1
    }
    return `ORD${next}`
  }

  const getNextLineId = async () => {
    try {
      const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'OrderLine' })
      if (counter) return counter
    } catch {}
    const { data } = await supabase
      .from('order_line_items')
      .select('line_id')
      .order('line_id', { ascending: false })
      .limit(1)
      .maybeSingle()
    let next = 1022
    if (data?.line_id) {
      const num = parseInt(data.line_id.replace(/\D/g, ''))
      if (!isNaN(num)) next = num + 1
    }
    return `OLI${next}`
  }

  // Create PO
  const createOrder = async (orderData) => {
    setSaving(true)
    try {
      const orderId = await getNextOrderId()
      const now = new Date().toISOString()

      // Calculate total
      let total = 0
      ;(orderData.lineItems || []).forEach(li => {
        total += (parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0)
      })

      // Auto-approve if user has approve_po permission (not just role-based)
      const initialStatus = canApprove ? 'Approved' : 'Pending'

      const { error } = await supabase.from('orders').insert({
        order_id: orderId,
        vendor_id: orderData.vendorId || '',
        vendor_name: orderData.vendorName || '',
        other_vendor: orderData.otherVendor || '',
        work_order_id: orderData.workOrderId || '',
        order_date: now,
        ordered_by: userName,
        status: initialStatus,
        total: total.toFixed(2),
        notes: orderData.notes || '',
        approved_by: canApprove ? userName : '',
        approved_date: canApprove ? now : null,
      })
      if (error) throw error

      // Add line items
      for (const li of (orderData.lineItems || [])) {
        const lineId = await getNextLineId()
        const unitPrice = parseFloat(li.unitPrice) || 0
        const qty = parseInt(li.quantity) || 0
        await supabase.from('order_line_items').insert({
          line_id: lineId,
          order_id: orderId,
          part_number: li.partNumber || '',
          description: li.description || '',
          link: li.link || '',
          unit_price: unitPrice.toFixed(2),
          quantity: qty,
          subtotal: (unitPrice * qty).toFixed(2),
          received_qty: 0,
          status: 'Pending',
          inventory_part_id: li.inventoryPartId || '',
          wo_id: orderData.workOrderId || ''
        })
      }

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Create PO', entity_type: 'Purchase Order', entity_id: orderId,
          details: `Created PO for ${orderData.vendorName || orderData.otherVendor} - $${total.toFixed(2)}`
        })
      } catch {}

      // Auto-update linked Work Order status to "Awaiting Parts"
      if (orderData.workOrderId) {
        try {
          await supabase.from('work_orders').update({
            status: 'Awaiting Parts',
            updated_at: new Date().toISOString(),
            updated_by: userName
          }).eq('wo_id', orderData.workOrderId)
        } catch (woErr) {
          console.warn('Failed to update WO status:', woErr)
        }
      }

      const msg = initialStatus === 'Approved'
        ? `PO ${orderId} created and auto-approved!`
        : `PO ${orderId} submitted for approval!`
      toast.success(msg)
      return { orderId, status: initialStatus }
    } catch (err) {
      toast.error(err.message || 'Failed to create order')
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Approve PO
  const approveOrder = async (orderId) => {
    setSaving(true)
    try {
      const { data: rows, error } = await supabase.from('orders').update({
        status: 'Approved',
        approved_by: userName,
        approved_date: new Date().toISOString()
      }).eq('order_id', orderId).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error(`Approve failed — you may not have permission to approve orders.`)
        return
      }
      toast.success(`PO ${orderId} approved`)
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Reject PO
  const rejectOrder = async (orderId, reason) => {
    setSaving(true)
    try {
      // Clear order_date on linked inventory items
      const { data: linkedLines } = await supabase
        .from('order_line_items')
        .select('inventory_part_id')
        .eq('order_id', orderId)
      const inventoryPartIds = [...new Set(
        (linkedLines || []).map(l => l.inventory_part_id).filter(Boolean)
      )]
      for (const partId of inventoryPartIds) {
        const { data: otherLines } = await supabase
          .from('order_line_items')
          .select('order_id')
          .eq('inventory_part_id', partId)
          .neq('order_id', orderId)
          .limit(1)
        let hasOtherActive = false
        if (otherLines && otherLines.length > 0) {
          const { data: otherOrder } = await supabase
            .from('orders').select('status').eq('order_id', otherLines[0].order_id).single()
          hasOtherActive = otherOrder && !['Received', 'Cancelled', 'Rejected'].includes(otherOrder.status)
        }
        if (!hasOtherActive) {
          await supabase.from('inventory').update({ order_date: null }).eq('part_id', partId)
        }
      }

      const updates = {
        status: 'Rejected',
        approved_by: userName,
        approved_date: new Date().toISOString()
      }
      if (reason) {
        const { data: current } = await supabase.from('orders').select('notes').eq('order_id', orderId).single()
        updates.notes = current?.notes ? `${current.notes} | Rejection: ${reason}` : `Rejection: ${reason}`
      }
      const { data: rejRows, error } = await supabase.from('orders').update(updates).eq('order_id', orderId).select()
      if (error) throw error
      if (!rejRows || rejRows.length === 0) {
        toast.error(`Reject failed — you may not have permission.`)
        return
      }
      toast.success(`PO ${orderId} rejected`)
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Mark as Ordered
  const markOrdered = async (orderId) => {
    setSaving(true)
    try {
      const { data: ordRows, error } = await supabase.from('orders').update({
        status: 'Ordered',
        ordered_date: new Date().toISOString()
      }).eq('order_id', orderId).select()
      if (error) throw error
      if (!ordRows || ordRows.length === 0) {
        toast.error(`Mark ordered failed — you may not have permission.`)
        return
      }
      toast.success(`PO ${orderId} marked as ordered`)
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Receive Items
  const receiveItems = async (orderId, receivedItems) => {
    setSaving(true)
    try {
      let allReceived = true
      let anyReceived = false
      const woStatusMap = {} // { woId: { total: N, received: N } }

      for (const item of receivedItems) {
        const newQty = parseInt(item.receivedQty) || 0
        const { data: lineData } = await supabase
          .from('order_line_items')
          .select('quantity, received_qty, inventory_part_id, wo_id')
          .eq('line_id', item.lineId)
          .single()

        const orderedQty = parseInt(lineData?.quantity) || 0
        const clampedQty = Math.min(newQty, orderedQty)
        const previousQty = parseInt(lineData?.received_qty) || 0
        const lineStatus = clampedQty >= orderedQty ? 'Received' : (clampedQty > 0 ? 'Partial' : 'Pending')

        const { data: liRows, error: liErr } = await supabase.from('order_line_items').update({
          received_qty: clampedQty,
          status: lineStatus
        }).eq('line_id', item.lineId).select()
        if (liErr) throw liErr
        if (!liRows || liRows.length === 0) {
          toast.error('Receive failed — you may not have permission to receive items.')
          return
        }

        if (lineStatus !== 'Received') allReceived = false
        if (clampedQty > 0) anyReceived = true

        // Track per-WO receive status
        const lineWoId = lineData?.wo_id
        if (lineWoId) {
          if (!woStatusMap[lineWoId]) woStatusMap[lineWoId] = { total: 0, received: 0 }
          woStatusMap[lineWoId].total++
          if (lineStatus === 'Received') woStatusMap[lineWoId].received++
        }

        // Update inventory if linked
        const qtyIncrease = clampedQty - previousQty
        if (lineData?.inventory_part_id && qtyIncrease > 0) {
          const { data: invItem } = await supabase
            .from('inventory')
            .select('qty_in_stock')
            .eq('part_id', lineData.inventory_part_id)
            .single()
          if (invItem) {
            await supabase.from('inventory').update({
              qty_in_stock: (parseInt(invItem.qty_in_stock) || 0) + qtyIncrease,
              updated_at: new Date().toISOString(),
              updated_by: userName
            }).eq('part_id', lineData.inventory_part_id)
          }
        }
      }

      // Update order status
      const newStatus = allReceived ? 'Received' : (anyReceived ? 'Partial' : undefined)
      if (newStatus) {
        const updates = { status: newStatus }
        if (allReceived) {
          updates.received_date = new Date().toISOString()
          updates.received_by = userName
        }
        await supabase.from('orders').update(updates).eq('order_id', orderId).select()
      }

      // Per-WO status updates: if ALL line items for a given WO are received, update that WO
      // First, for items with no wo_id, try to assign from orders.work_order_id
      if (Object.keys(woStatusMap).length === 0 || woStatusMap['']) {
        try {
          const { data: orderData } = await supabase.from('orders').select('work_order_id').eq('order_id', orderId).single()
          if (orderData?.work_order_id) {
            // Move empty-key counts to the order-level WO
            if (woStatusMap['']) {
              if (!woStatusMap[orderData.work_order_id]) woStatusMap[orderData.work_order_id] = { total: 0, received: 0 }
              woStatusMap[orderData.work_order_id].total += woStatusMap[''].total
              woStatusMap[orderData.work_order_id].received += woStatusMap[''].received
              delete woStatusMap['']
            }
            // If no line-level wo_ids at all, use order-level
            if (Object.keys(woStatusMap).length === 0 && allReceived) {
              woStatusMap[orderData.work_order_id] = { total: 1, received: 1 }
            }
          }
        } catch {}
      }

      for (const [woId, counts] of Object.entries(woStatusMap)) {
        if (!woId) continue // skip empty
        if (counts.total > 0 && counts.received === counts.total) {
          // All items for this WO are received
          try {
            await supabase.from('work_orders').update({
              status: 'Part Received',
              updated_at: new Date().toISOString(),
              updated_by: userName
            }).eq('wo_id', woId)
          } catch (woErr) {
            console.warn(`Failed to update WO ${woId} status:`, woErr)
          }
        }
      }

      toast.success(allReceived ? 'All items received!' : 'Partial receipt saved')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Cancel PO
  const cancelOrder = async (orderId) => {
    setSaving(true)
    try {
      // Clear order_date on linked inventory items (same logic as delete)
      const { data: linkedLines } = await supabase
        .from('order_line_items')
        .select('inventory_part_id')
        .eq('order_id', orderId)
      const inventoryPartIds = [...new Set(
        (linkedLines || []).map(l => l.inventory_part_id).filter(Boolean)
      )]
      for (const partId of inventoryPartIds) {
        // Only clear if no OTHER active PO references this part
        const { data: otherLines } = await supabase
          .from('order_line_items')
          .select('order_id')
          .eq('inventory_part_id', partId)
          .neq('order_id', orderId)
          .limit(1)
        let hasOtherActive = false
        if (otherLines && otherLines.length > 0) {
          const { data: otherOrder } = await supabase
            .from('orders').select('status').eq('order_id', otherLines[0].order_id).single()
          hasOtherActive = otherOrder && !['Received', 'Cancelled', 'Rejected'].includes(otherOrder.status)
        }
        if (!hasOtherActive) {
          await supabase.from('inventory').update({ order_date: null }).eq('part_id', partId)
        }
      }

      const { data: cancelRows, error: cancelErr } = await supabase.from('orders').update({ status: 'Cancelled' }).eq('order_id', orderId).select()
      if (cancelErr) throw cancelErr
      if (!cancelRows || cancelRows.length === 0) {
        toast.error('Cancel failed — you may not have permission.')
        return
      }
      await supabase.from('order_line_items').update({ status: 'Cancelled' }).eq('order_id', orderId).select()
      toast.success(`PO ${orderId} cancelled`)
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Delete PO permanently — removes all related records
  const deleteOrder = async (orderId) => {
    setSaving(true)
    try {
      // 0. Find linked inventory items BEFORE deleting line items, and clear their order_date
      const { data: linkedLines } = await supabase
        .from('order_line_items')
        .select('inventory_part_id')
        .eq('order_id', orderId)
      const inventoryPartIds = [...new Set(
        (linkedLines || []).map(l => l.inventory_part_id).filter(Boolean)
      )]
      if (inventoryPartIds.length > 0) {
        // Check each part — only clear order_date if no OTHER active PO references it
        for (const partId of inventoryPartIds) {
          const { data: otherLines } = await supabase
            .from('order_line_items')
            .select('order_id')
            .eq('inventory_part_id', partId)
            .neq('order_id', orderId)
            .limit(1)
          // Check if those other orders are still active (not Received/Cancelled/Rejected)
          let hasOtherActive = false
          if (otherLines && otherLines.length > 0) {
            const { data: otherOrder } = await supabase
              .from('orders')
              .select('status')
              .eq('order_id', otherLines[0].order_id)
              .single()
            hasOtherActive = otherOrder && !['Received', 'Cancelled', 'Rejected'].includes(otherOrder.status)
          }
          if (!hasOtherActive) {
            await supabase.from('inventory').update({
              order_date: null,
              updated_at: new Date().toISOString(),
              updated_by: userName
            }).eq('part_id', partId)
          }
        }
      }

      // 1. Delete line items
      await supabase.from('order_line_items').delete().eq('order_id', orderId)

      // 2. Delete program_budget entries referencing this PO
      await supabase.from('program_budget').delete().eq('reference', orderId)

      // 3. Delete audit_log entries for this PO
      await supabase.from('audit_log').delete().eq('entity_id', orderId)

      // 4. Delete work_log entries that mention this PO
      const { data: relatedLogs } = await supabase.from('work_log')
        .select('log_id')
        .like('work_description', `%${orderId}%`)
      if (relatedLogs && relatedLogs.length > 0) {
        await supabase.from('work_log').delete().in('log_id', relatedLogs.map(l => l.log_id))
      }

      // 5. Delete the order itself
      const { error } = await supabase.from('orders').delete().eq('order_id', orderId)
      if (error) throw error

      toast.success(`PO ${orderId} and all related records permanently deleted`)
      return true
    } catch (err) {
      toast.error('Delete failed: ' + err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, createOrder, approveOrder, rejectOrder, markOrdered, receiveItems, cancelOrder, deleteOrder, getNextOrderId, getNextLineId, userName, canApprove,

    // Add line item(s) to an existing order
    addLineToOrder: async (orderId, lineItems) => {
      setSaving(true)
      try {
        let addedTotal = 0
        for (const li of lineItems) {
          const lineId = await getNextLineId()
          const unitPrice = parseFloat(li.unitPrice) || 0
          const qty = parseInt(li.quantity) || 1
          const subtotal = unitPrice * qty
          addedTotal += subtotal
          await supabase.from('order_line_items').insert({
            line_id: lineId,
            order_id: orderId,
            part_number: li.partNumber || '',
            description: li.description || '',
            link: li.link || '',
            unit_price: unitPrice.toFixed(2),
            quantity: qty,
            subtotal: subtotal.toFixed(2),
            received_qty: 0,
            status: 'Pending',
            inventory_part_id: li.inventoryPartId || '',
          })
        }
        // Update order total
        const { data: currentOrder } = await supabase.from('orders').select('total, status').eq('order_id', orderId).single()
        const newTotal = (parseFloat(currentOrder?.total) || 0) + addedTotal
        // If order was Approved, reset to Pending for re-approval (only if user can't approve)
        const statusUpdate = (!canApprove && currentOrder?.status === 'Approved') ? { status: 'Pending' } : {}
        await supabase.from('orders').update({
          total: newTotal.toFixed(2),
          ...statusUpdate
        }).eq('order_id', orderId)

        toast.success(`Added ${lineItems.length} item${lineItems.length > 1 ? 's' : ''} to ${orderId}`)
        window.dispatchEvent(new CustomEvent('po-updated', { detail: { orderId } }))
        return true
      } catch (err) {
        toast.error(err.message)
        throw err
      } finally {
        setSaving(false)
      }
    },

    // Find existing unplaced POs for a vendor
    findExistingPOForVendor: async (vendorName) => {
      if (!vendorName) return null
      const { data } = await supabase
        .from('orders')
        .select('order_id, vendor_name, other_vendor, status, total, order_date')
        .in('status', ['Pending', 'Approved'])
        .order('order_date', { ascending: false })
      // Match by vendor name (case-insensitive)
      const vLower = vendorName.toLowerCase()
      return (data || []).find(o =>
        (o.vendor_name || '').toLowerCase() === vLower ||
        (o.other_vendor || '').toLowerCase() === vLower
      ) || null
    }
  }
}

// ─── Low Stock Items ─────────────────────────────────────────────────────────

export function useLowStockItems() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('inventory')
        .select('part_id, part_name, description, primary_supplier, supplier_part_number, qty_in_stock, min_qty, max_qty, order_date, status')
        .eq('status', 'Active')

      if (error) throw error

      // Get all inventory part IDs that are actually on an active PO
      const { data: activeLines } = await supabase
        .from('order_line_items')
        .select('inventory_part_id, order_id')
        .neq('inventory_part_id', '')
        .not('status', 'in', '("Received","Cancelled")')
      // Get the orders to check their status too
      const activeOrderIds = [...new Set((activeLines || []).map(l => l.order_id))]
      let activeOrderSet = new Set()
      if (activeOrderIds.length > 0) {
        const { data: orders } = await supabase
          .from('orders')
          .select('order_id, status')
          .in('order_id', activeOrderIds)
          .not('status', 'in', '("Received","Cancelled","Rejected")')
        activeOrderSet = new Set((orders || []).map(o => o.order_id))
      }
      // Build set of part IDs that are truly on an active PO
      const partsOnActivePO = new Set(
        (activeLines || [])
          .filter(l => activeOrderSet.has(l.order_id))
          .map(l => l.inventory_part_id)
      )

      const lowStock = (data || []).filter(item => {
        const qty = parseInt(item.qty_in_stock) || 0
        const min = parseInt(item.min_qty) || 0
        return min > 0 && qty <= min
      }).map(item => {
        const trulyOrdered = partsOnActivePO.has(item.part_id)
        return {
          ...item,
          qty_in_stock: parseInt(item.qty_in_stock) || 0,
          min_qty: parseInt(item.min_qty) || 0,
          max_qty: parseInt(item.max_qty) || 0,
          orderQty: Math.max(0, (parseInt(item.max_qty) || 0) - (parseInt(item.qty_in_stock) || 0)),
          alreadyOrdered: trulyOrdered
        }
      })

      setItems(lowStock)
      hasLoadedRef.current = true

      // Also fix stale order_date flags — if inventory says ordered but no active PO exists, clear it
      try {
        const staleItems = lowStock.filter(i => !!i.order_date && !partsOnActivePO.has(i.part_id))
        if (staleItems.length > 0) {
          for (const item of staleItems) {
            await supabase.from('inventory').update({ order_date: null }).eq('part_id', item.part_id)
          }
          console.log(`[LowStock] Cleared stale order_date on ${staleItems.length} items`)
        }
      } catch (cleanupErr) {
        console.warn('[LowStock] Stale cleanup failed:', cleanupErr)
      }
    } catch (err) {
      console.error('Low stock error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])
  return { items, loading, refresh: fetch }
}
