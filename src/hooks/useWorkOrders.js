import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { generateSafeWoId, generateSafeLogId } from '@/utils/generateSafeWoId'

/**
 * Hook for fetching work orders list (open or closed)
 */
export function useWorkOrders(view = 'open') {
  const [workOrders, setWorkOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const hasLoadedRef = useRef(false)

  const fetchWorkOrders = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    setError(null)

    try {
      let query = supabase
        .from('work_orders')
        .select('*')

      if (view === 'open') {
        query = query.neq('status', 'Closed').order('created_at', { ascending: false })
      } else {
        query = query.eq('status', 'Closed').order('created_at', { ascending: false })
      }

      const { data, error: fetchError } = await query

      if (fetchError) throw fetchError
      setWorkOrders(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching work orders:', err)
      setError(err.message)
      if (!hasLoadedRef.current) toast.error('Failed to load work orders')
    } finally {
      setLoading(false)
    }
  }, [view])

  useEffect(() => {
    fetchWorkOrders()
  }, [fetchWorkOrders])

  // Set up real-time subscription
  useEffect(() => {
    const channel = supabase
      .channel('work-orders-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'work_orders' },
        () => {
          fetchWorkOrders()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchWorkOrders])

  // Re-fetch when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        fetchWorkOrders()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetchWorkOrders])

  return { workOrders, loading, error, refresh: fetchWorkOrders }
}

/**
 * Hook for fetching a single work order with all details
 */
export function useWorkOrder(woId) {
  const [workOrder, setWorkOrder] = useState(null)
  const [workLogs, setWorkLogs] = useState([])
  const [partsUsed, setPartsUsed] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetchDetails = useCallback(async () => {
    if (!woId) return
    if (!hasLoadedRef.current) setLoading(true)

    try {
      // Fetch work order
      const { data: wo, error: woError } = await supabase
        .from('work_orders')
        .select('*')
        .eq('wo_id', woId)
        .single()

      if (woError) throw woError
      setWorkOrder(wo)

      // Fetch work logs
      const { data: logs } = await supabase
        .from('work_log')
        .select('*')
        .eq('wo_id', woId)
        .order('timestamp', { ascending: false })

      setWorkLogs(logs || [])

      // Fetch parts used
      const { data: parts } = await supabase
        .from('work_order_parts')
        .select('*')
        .eq('wo_id', woId)
        .order('added_date', { ascending: false })

      setPartsUsed(parts || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error fetching work order:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load work order details')
    } finally {
      setLoading(false)
    }
  }, [woId])

  useEffect(() => {
    fetchDetails()
  }, [fetchDetails])

  return { workOrder, workLogs, partsUsed, loading, refresh: fetchDetails }
}

/**
 * Work order mutation functions
 */
export function useWorkOrderActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  /**
   * Create a new work order
   */
  const createWorkOrder = async (woData) => {
    setSaving(true)
    try {
      // Generate collision-safe WO ID (shared utility — same as PM generation)
      const woId = await generateSafeWoId()

      // Calculate due date from priority if not provided
      let dueDate = woData.dueDate
      if (!dueDate) {
        // Fetch priority day settings from the database
        let priorityDays = { Critical: 1, High: 7, Medium: 21, Low: 45 }
        try {
          const { data: settingsData } = await supabase
            .from('settings')
            .select('setting_key, setting_value')
            .in('setting_key', ['priority_high_days', 'priority_medium_days', 'priority_low_days'])
          if (settingsData?.length) {
            const map = {}
            settingsData.forEach(s => { map[s.setting_key] = parseInt(s.setting_value) })
            if (map.priority_high_days) priorityDays.High = map.priority_high_days
            if (map.priority_medium_days) priorityDays.Medium = map.priority_medium_days
            if (map.priority_low_days) priorityDays.Low = map.priority_low_days
          }
        } catch (e) { /* use defaults */ }

        const d = new Date()
        d.setDate(d.getDate() + (priorityDays[woData.priority] || 7))
        dueDate = d.toISOString()
      }

      const insertData = {
        wo_id: woId,
        description: woData.description,
        priority: woData.priority || 'Medium',
        status: woData.status || 'Open',
        asset_name: woData.assetName || '',
        assigned_to: woData.assignedTo || '',
        assigned_email: woData.assignedEmail || '',
        created_by: userName,
        due_date: dueDate,
        is_pm: woData.isPM || false,
        total_hours: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: userName,
      }

      // Only include asset_id if it's provided and not empty
      if (woData.assetId) {
        insertData.asset_id = woData.assetId
      }

      const { data, error } = await supabase
        .from('work_orders')
        .insert(insertData)
        .select()
        .single()

      if (error) throw error

      // Add audit log (don't fail if this errors)
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Create',
          entity_type: 'Work Order',
          entity_id: woId,
          details: `Created work order: ${woData.description}`,
        })
      } catch (e) {
        console.log('Audit log error (non-critical):', e)
      }

      toast.success(`Work order ${woId} created!`)
      return data
    } catch (err) {
      console.error('Error creating work order:', err)
      toast.error(err.message || 'Failed to create work order')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Update a work order
   */
  const updateWorkOrder = async (woId, updates) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('work_orders')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('wo_id', woId)

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Update',
          entity_type: 'Work Order',
          entity_id: woId,
          details: `Updated work order`,
        })
      } catch (e) {
        console.log('Audit log error (non-critical):', e)
      }

      toast.success('Work order updated!')
    } catch (err) {
      console.error('Error updating work order:', err)
      toast.error(err.message || 'Failed to update work order')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Change work order status
   */
  const changeStatus = async (woId, newStatus) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('work_orders')
        .update({
          status: newStatus,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('wo_id', woId)

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Status Change',
          entity_type: 'Work Order',
          entity_id: woId,
          details: `Changed status to ${newStatus}`,
        })
      } catch (e) {
        console.log('Audit log error (non-critical):', e)
      }

      toast.success(`Status changed to ${newStatus}`)
    } catch (err) {
      console.error('Error changing status:', err)
      toast.error(err.message || 'Failed to change status')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Close a work order
   */
  const closeWorkOrder = async (woId, closingNotes = '') => {
    setSaving(true)
    try {
      // Get current WO data for days open calculation
      const { data: wo } = await supabase
        .from('work_orders')
        .select('created_at, due_date')
        .eq('wo_id', woId)
        .single()

      const now = new Date()
      const created = new Date(wo.created_at)
      const daysOpen = Math.ceil((now - created) / 86400000)
      const wasLate = wo.due_date ? now > new Date(wo.due_date) : false

      const { error } = await supabase
        .from('work_orders')
        .update({
          status: 'Closed',
          closed_date: now.toISOString(),
          closed_by: userName,
          days_open: daysOpen,
          was_late: wasLate ? 'Yes' : 'No',
          updated_at: now.toISOString(),
          updated_by: userName,
        })
        .eq('wo_id', woId)

      if (error) throw error

      // Add closing notes as work log entry if provided
      if (closingNotes) {
        try {
          const logId = await generateSafeLogId()

          await supabase.from('work_log').insert({
            log_id: logId,
            wo_id: woId,
            timestamp: now.toISOString(),
            user_name: userName,
            user_email: profile.email,
            hours: 0,
            work_description: `[CLOSING NOTES] ${closingNotes}`,
            entry_type: 'Note',
          })
        } catch (e) {
          console.log('Work log error (non-critical):', e)
        }
      }

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Close',
          entity_type: 'Work Order',
          entity_id: woId,
          details: `Closed work order. Days open: ${daysOpen}, Was late: ${wasLate ? 'Yes' : 'No'}`,
        })
      } catch (e) {
        console.log('Audit log error (non-critical):', e)
      }

      toast.success('Work order closed!')
    } catch (err) {
      console.error('Error closing work order:', err)
      toast.error(err.message || 'Failed to close work order')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Reopen a closed work order (Instructor only)
   */
  const reopenWorkOrder = async (woId) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('work_orders')
        .update({
          status: 'Reopened',
          closed_date: null,
          closed_by: null,
          days_open: null,
          was_late: null,
          due_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('wo_id', woId)

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Reopen',
          entity_type: 'Work Order',
          entity_id: woId,
          details: 'Reopened work order',
        })
      } catch (e) {
        console.log('Audit log error (non-critical):', e)
      }

      toast.success('Work order reopened!')
    } catch (err) {
      console.error('Error reopening work order:', err)
      toast.error(err.message || 'Failed to reopen work order')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Delete a work order permanently
   */
  const deleteWorkOrder = async (woId) => {
    setSaving(true)
    try {
      // Delete associated work logs
      await supabase.from('work_log').delete().eq('wo_id', woId)

      // Delete associated parts
      await supabase.from('work_order_parts').delete().eq('wo_id', woId)

      // Delete the work order
      const { error } = await supabase
        .from('work_orders')
        .delete()
        .eq('wo_id', woId)

      if (error) throw error

      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Delete',
          entity_type: 'Work Order',
          entity_id: woId,
          details: 'Permanently deleted work order',
        })
      } catch (e) {
        console.log('Audit log error (non-critical):', e)
      }

      toast.success('Work order deleted!')
    } catch (err) {
      console.error('Error deleting work order:', err)
      toast.error(err.message || 'Failed to delete work order')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /**
   * Add a work log entry
   */
  const addWorkLog = async (woId, entryData) => {
    setSaving(true)
    try {
      const logId = await generateSafeLogId()

      // Round hours to nearest 0.25
      let hours = parseFloat(entryData.hours) || 0.25
      hours = Math.round(hours * 4) / 4
      if (hours < 0.25) hours = 0.25

      const { error } = await supabase.from('work_log').insert({
        log_id: logId,
        wo_id: woId,
        timestamp: new Date().toISOString(),
        user_name: userName,
        user_email: profile.email,
        hours,
        work_description: entryData.workDescription || '',
        parts_used: entryData.partsUsed || '',
        entry_type: entryData.entryType || 'Work',
      })

      if (error) throw error

      // Update total hours on work order
      const { data: wo } = await supabase
        .from('work_orders')
        .select('total_hours')
        .eq('wo_id', woId)
        .single()

      await supabase
        .from('work_orders')
        .update({
          total_hours: (wo?.total_hours || 0) + hours,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('wo_id', woId)

      toast.success(`Work log added (${hours}h)`)
      return { logId, hours }
    } catch (err) {
      console.error('Error adding work log:', err)
      toast.error(err.message || 'Failed to add work log')
      throw err
    } finally {
      setSaving(false)
    }
  }

  return {
    saving,
    createWorkOrder,
    updateWorkOrder,
    changeStatus,
    closeWorkOrder,
    reopenWorkOrder,
    deleteWorkOrder,
    addWorkLog,
  }
}

/**
 * Hook for fetching assets (for dropdowns)
 */
export function useAssets() {
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      try {
        const { data } = await supabase
          .from('assets')
          .select('asset_id, name, location, status')
          .eq('status', 'Active')
          .order('name')

        setAssets(data || [])
      } catch (e) {
        console.log('Error loading assets:', e)
      }
      setLoading(false)
    }
    fetch()
  }, [])

  return { assets, loading }
}

/**
 * Hook for fetching users (for assignment dropdowns)
 */
export function useUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, email, role, status, time_clock_only')
          .eq('status', 'Active')
          .order('first_name')

        // Filter out TCO users - they only punch in/out
        setUsers((data || []).filter(u => u.time_clock_only !== 'Yes'))
      } catch (e) {
        console.log('Error loading users:', e)
      }
      setLoading(false)
    }
    fetch()
  }, [])

  return { users, loading }
}

/**
 * Hook for fetching WO statuses
 */
export function useWOStatuses() {
  // Default statuses - will try to load from DB but fall back to these
  const [statuses, setStatuses] = useState([
    'Open', 'In Progress', 'Awaiting Parts', 'On Hold', 'Reopened'
  ])

  useEffect(() => {
    async function fetch() {
      try {
        const { data, error } = await supabase
          .from('wo_status')
          .select('*')

        if (!error && data?.length) {
          // Try to extract status names from whatever columns exist
          const names = data
            .filter(s => !s.is_closed_status && !s.is_closed)
            .map(s => s.status_name || s.name || s.status)
            .filter(Boolean)

          if (names.length) setStatuses(names)
        }
      } catch (e) {
        // Use defaults - that's fine
        console.log('Using default WO statuses')
      }
    }
    fetch()
  }, [])

  return statuses
}
