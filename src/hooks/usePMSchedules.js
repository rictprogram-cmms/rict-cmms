import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── Calculate Next Due Date ─────────────────────────────────────────────────
// Daily = next day, Weekly = 1 week, everything else = 3 weeks (21 days)
// This ensures appropriate lead time for Monthly, Quarterly, Annually, Custom

export function calculateNextDueDate(fromDate, frequency, frequencyValue) {
  // If fromDate is a bare YYYY-MM-DD string, parse as local midnight to avoid UTC shift.
  // If it's already a Date object or full ISO timestamp, use as-is.
  let next
  if (typeof fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromDate.substring(0, 10)) && fromDate.length === 10) {
    next = new Date(fromDate + 'T00:00:00')
  } else {
    next = new Date(fromDate)
  }
  switch (frequency) {
    case 'Daily':
      next.setDate(next.getDate() + 1)
      break
    case 'Weekly':
      next.setDate(next.getDate() + 7)
      break
    case 'Monthly':
    case 'Quarterly':
    case 'Annually':
    case 'Custom':
    default:
      next.setDate(next.getDate() + 21) // 3 weeks for everything else
      break
  }
  // Return as plain local YYYY-MM-DD — not toISOString() which would give UTC and shift the date
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

// ─── PM Schedules List + Client-Side Auto-Generation Fallback ────────────────
//
// Auto-generation logic:
//   The pg_cron job (auto_generate_pm_work_orders) runs every morning at 6am UTC.
//   This hook acts as a client-side fallback — it calls the same SQL function via
//   RPC on mount and on tab-return, so generation also triggers immediately
//   whenever anyone opens the PM page. Silent — no toasts shown to the user.
//   Push notifications to the assigned student fire via the existing Database
//   Webhook on work_orders INSERT (same as any other WO assignment).

export function usePMSchedules() {
  const [schedules, setSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)
  const autoGenRunningRef = useRef(false) // prevents concurrent auto-gen calls

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('pm_schedules')
        .select('*')
        .order('next_due_date', { ascending: true })

      if (error) throw error

      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const weekFromNow = new Date(today)
      weekFromNow.setDate(weekFromNow.getDate() + 7)

      const enriched = (data || []).map(pm => {
        let isOverdue = false, isDueSoon = false
        if (pm.next_due_date && pm.status === 'Active') {
          // Extract date portion and parse as LOCAL midnight to avoid UTC→CST shift.
          // Without this, a PM due March 17 appears overdue starting March 16 midnight CST.
          const datePart = typeof pm.next_due_date === 'string'
            ? pm.next_due_date.substring(0, 10)
            : null
          const due = (datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart))
            ? new Date(datePart + 'T00:00:00')
            : new Date(pm.next_due_date)
          isOverdue = due < today
          isDueSoon = due >= today && due <= weekFromNow
        }
        return { ...pm, isOverdue, isDueSoon }
      })

      setSchedules(enriched)
      hasLoadedRef.current = true
    } catch (err) {
      console.error('PM list error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load PM schedules')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Client-side auto-generation fallback ──────────────────────────────────
  // Calls the same SQL function that pg_cron uses. If pg_cron already ran this
  // morning the function will find no overdue PMs and return immediately (no-op).
  // Runs on mount + every tab-return. Guarded by autoGenRunningRef to prevent
  // concurrent executions if the user rapidly switches tabs.
  const runAutoGeneration = useCallback(async () => {
    if (autoGenRunningRef.current) return
    autoGenRunningRef.current = true
    try {
      const { data, error } = await supabase.rpc('auto_generate_pm_work_orders')
      if (error) {
        // Log but don't surface to the user — pg_cron is the primary engine
        console.warn('PM auto-gen fallback error:', error.message)
        return
      }
      if (data && data.length > 0) {
        // WOs were created — refresh the schedule list so counts update
        console.log(`[Auto-PM] Generated ${data.length} work order(s):`, data.map(r => r.out_wo_id))
        await fetch()
      }
    } catch (err) {
      console.warn('PM auto-gen fallback exception:', err)
    } finally {
      autoGenRunningRef.current = false
    }
  }, [fetch])

  // On mount: load schedules, then run auto-generation
  useEffect(() => {
    fetch().then(() => {
      runAutoGeneration()
    })
  }, [fetch, runAutoGeneration])

  // Re-fetch + re-run auto-gen when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        fetch().then(() => {
          runAutoGeneration()
        })
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetch, runAutoGeneration])

  // Real-time: refresh when pm_schedules change
  useEffect(() => {
    const channel = supabase
      .channel('pm-schedules-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pm_schedules' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { schedules, loading, refresh: fetch }
}

// ─── Global PM Pause Setting ────────────────────────────────────────────────

export function usePMGlobalPause() {
  const { profile } = useAuth()
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const hasLoadedRef = useRef(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'pm_generation_paused')
        .maybeSingle()
      setPaused(data?.setting_value === 'true')
      hasLoadedRef.current = true
    } catch (err) {
      console.error('PM pause setting error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const toggle = async () => {
    setSaving(true)
    const newVal = !paused
    try {
      // Upsert the setting
      const { data: existing } = await supabase
        .from('settings')
        .select('setting_key')
        .eq('setting_key', 'pm_generation_paused')
        .maybeSingle()

      if (existing) {
        const { error } = await supabase.from('settings').update({
          setting_value: String(newVal),
          updated_at: new Date().toISOString(),
          updated_by: userName
        }).eq('setting_key', 'pm_generation_paused')
        if (error) throw error
      } else {
        const { error } = await supabase.from('settings').insert({
          setting_key: 'pm_generation_paused',
          setting_value: String(newVal),
          description: 'When true, all PM work order auto-generation is paused (summer/winter break)',
          category: 'PM',
          updated_at: new Date().toISOString(),
          updated_by: userName
        })
        if (error) throw error
      }

      setPaused(newVal)

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: newVal ? 'Pause PM Generation' : 'Unpause PM Generation',
          entity_type: 'Settings',
          entity_id: 'pm_generation_paused',
          details: newVal
            ? 'All PM work order generation paused (break period)'
            : 'PM work order generation resumed'
        })
      } catch {}

      toast.success(newVal ? 'PM generation paused for break' : 'PM generation resumed!')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when settings change (another user might toggle pause)
  useEffect(() => {
    const channel = supabase
      .channel('pm-pause-setting-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload) => {
        // Only refetch if the pm_generation_paused setting changed
        if (payload.new?.setting_key === 'pm_generation_paused' || payload.old?.setting_key === 'pm_generation_paused') {
          fetch()
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { paused, loading, saving, toggle, refresh: fetch }
}

// ─── PM Actions ──────────────────────────────────────────────────────────────

export function usePMActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  // Upload procedure file to pm-procedure bucket
  const uploadProcedure = async (file) => {
    const ext = file.name.split('.').pop()
    const path = `procedures/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

    const { error: uploadError } = await supabase.storage
      .from('pm-procedures')
      .upload(path, file, { upsert: true })

    if (uploadError) throw uploadError
    return path
  }

  // Delete old procedure file from bucket
  const deleteProcedureFile = async (filePath) => {
    if (!filePath) return
    try {
      await supabase.storage.from('pm-procedures').remove([filePath])
    } catch (err) {
      console.warn('Could not delete old procedure file:', err)
    }
  }

  // Get public URL for a procedure file
  const getProcedureUrl = (filePath) => {
    if (!filePath) return null
    const { data } = supabase.storage.from('pm-procedures').getPublicUrl(filePath)
    return data?.publicUrl || null
  }

  // Create PM
  const createPM = async (pmData) => {
    setSaving(true)
    try {
      // Generate PM ID
      const { data: maxRow } = await supabase
        .from('pm_schedules')
        .select('pm_id')
        .order('pm_id', { ascending: false })
        .limit(1)
        .maybeSingle()

      let nextNum = 1
      if (maxRow?.pm_id) {
        const num = parseInt(maxRow.pm_id.replace(/\D/g, ''))
        if (!isNaN(num)) nextNum = num + 1
      }
      const pmId = `PM${String(nextNum).padStart(4, '0')}`

      // Get asset name if needed
      let assetName = pmData.assetName || ''
      if (pmData.assetId && !assetName) {
        const { data: asset } = await supabase
          .from('assets')
          .select('name')
          .eq('asset_id', pmData.assetId)
          .maybeSingle()
        if (asset) assetName = asset.name
      }

      const nextDue = calculateNextDueDate(new Date(), pmData.frequency, pmData.frequencyValue)

      // Upload procedure file if provided
      let procedureFileId = ''
      if (pmData.procedureFile) {
        procedureFileId = await uploadProcedure(pmData.procedureFile)
      }

      const { error } = await supabase.from('pm_schedules').insert({
        pm_id: pmId,
        pm_name: pmData.pmName,
        asset_id: pmData.assetId || '',
        asset_name: assetName,
        frequency: pmData.frequency,
        frequency_value: pmData.frequencyValue || 0,
        procedure_file_id: procedureFileId,
        procedure_url: '',
        last_generated: null,
        next_due_date: nextDue,
        status: 'Active',
        created_at: new Date().toISOString(),
        created_by: userName,
        updated_at: new Date().toISOString()
      })
      if (error) throw error

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Create PM', entity_type: 'PM Schedule', entity_id: pmId,
          details: `Created PM ${pmId}: ${pmData.pmName} (${pmData.frequency})`
        })
      } catch {}

      toast.success(`PM ${pmId} created!`)
      return pmId
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Update PM
  const updatePM = async (pmId, updates) => {
    setSaving(true)
    try {
      // Handle procedure file replacement
      if (updates._newProcedureFile) {
        // Delete old file if exists
        if (updates._oldProcedureFileId) {
          await deleteProcedureFile(updates._oldProcedureFileId)
        }
        updates.procedure_file_id = await uploadProcedure(updates._newProcedureFile)
        delete updates._newProcedureFile
        delete updates._oldProcedureFileId
      }

      // Handle procedure removal (user clicked remove)
      if (updates._removeProcedure) {
        if (updates._oldProcedureFileId) {
          await deleteProcedureFile(updates._oldProcedureFileId)
        }
        updates.procedure_file_id = ''
        delete updates._removeProcedure
        delete updates._oldProcedureFileId
      }

      const { error } = await supabase.from('pm_schedules').update({
        ...updates,
        updated_at: new Date().toISOString()
      }).eq('pm_id', pmId)
      if (error) throw error
      toast.success('PM schedule updated')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Delete PM (also clean up procedure file)
  const deletePM = async (pmId) => {
    setSaving(true)
    try {
      // Get file path first
      const { data: pm } = await supabase
        .from('pm_schedules')
        .select('procedure_file_id')
        .eq('pm_id', pmId)
        .maybeSingle()

      if (pm?.procedure_file_id) {
        await deleteProcedureFile(pm.procedure_file_id)
      }

      const { error } = await supabase.from('pm_schedules').delete().eq('pm_id', pmId)
      if (error) throw error

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Delete PM', entity_type: 'PM Schedule', entity_id: pmId,
          details: `Deleted PM schedule ${pmId}`
        })
      } catch {}

      toast.success('PM schedule deleted')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  // Check if a PM already has an open (non-closed) work order
  const checkOpenPMWorkOrder = async (pmId) => {
    // Check active work_orders table for any WO linked to this PM
    const { data: openWOs } = await supabase
      .from('work_orders')
      .select('wo_id, status')
      .eq('pm_id', pmId)
      .limit(1)

    if (openWOs && openWOs.length > 0) {
      return openWOs[0] // Return the open WO
    }
    return null
  }

  // Generate Work Order from PM
  const generateWO = async (pmId) => {
    setSaving(true)
    try {
      // ── Check global pause ──
      const { data: pauseSetting } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'pm_generation_paused')
        .maybeSingle()

      if (pauseSetting?.setting_value === 'true') {
        toast.error('PM generation is currently paused (break period). Unpause to generate work orders.')
        return null
      }

      // ── Check for existing open PM work order ──
      const existingWO = await checkOpenPMWorkOrder(pmId)
      if (existingWO) {
        toast.error(`Cannot generate — ${existingWO.wo_id} (${existingWO.status}) is still open for this PM. Close it first.`)
        return null
      }

      // Get PM details
      const { data: pm, error: pmError } = await supabase
        .from('pm_schedules')
        .select('*')
        .eq('pm_id', pmId)
        .single()
      if (pmError) throw pmError

      // Generate WO ID
      // Primary: try get_next_id RPC (p_type must match counter_name exactly)
      // Fallback: derive from actual max across both WO tables — no dash, no padding
      let woId
      try {
        const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'work_order' })
        if (counter) woId = counter
      } catch {}
      if (!woId) {
        // Query both open and closed WOs to find the true max
        const [{ data: openMax }, { data: closedMax }] = await Promise.all([
          supabase.from('work_orders').select('wo_id').order('wo_id', { ascending: false }).limit(1).maybeSingle(),
          supabase.from('work_orders_closed').select('wo_id').order('wo_id', { ascending: false }).limit(1).maybeSingle()
        ])
        const openNum   = openMax?.wo_id   ? parseInt(openMax.wo_id.replace(/\D/g, ''))   : 0
        const closedNum = closedMax?.wo_id  ? parseInt(closedMax.wo_id.replace(/\D/g, '')) : 0
        const n = Math.max(openNum, closedNum, 1100) + 1
        woId = `WO${n}` // No dash, no padding — matches WO1118 format
      }

      // Calculate due date for the WO itself
      // Daily PM → due tomorrow, Weekly → due in 7 days, else 21 days
      // Use local date math to avoid UTC-vs-CST off-by-one on late evenings
      const woDueDate = new Date()
      switch (pm.frequency) {
        case 'Daily': woDueDate.setDate(woDueDate.getDate() + 1); break
        case 'Weekly': woDueDate.setDate(woDueDate.getDate() + 7); break
        default: woDueDate.setDate(woDueDate.getDate() + 21); break
      }
      // Format as local YYYY-MM-DD (not UTC) so the stored date matches what the user expects
      const woDueDateStr = `${woDueDate.getFullYear()}-${String(woDueDate.getMonth() + 1).padStart(2, '0')}-${String(woDueDate.getDate()).padStart(2, '0')}`

      // Create work order — carry procedure_file_id through
      const now = new Date().toISOString()
      const { error: woError } = await supabase.from('work_orders').insert({
        wo_id: woId,
        description: `[PM] ${pm.pm_name}`,
        priority: 'Medium',
        status: 'Open',
        asset_id: pm.asset_id || '',
        asset_name: pm.asset_name || '',
        due_date: woDueDateStr,
        created_at: now,
        created_by: userName,
        is_pm: 'Yes',
        pm_id: pmId,
        updated_at: now,
        updated_by: userName
      })
      if (woError) throw woError

      // NOTE: The PM procedure is linked to the WO via pm_id.
      // The WorkOrdersPage should look up pm_schedules.procedure_file_id
      // when displaying a WO with is_pm='Yes' to show the procedure link.

      // Update PM: last generated + next due
      // Next due is calculated from TODAY, not from the previous due date
      const nextDue = calculateNextDueDate(new Date(), pm.frequency, pm.frequency_value)
      await supabase.from('pm_schedules').update({
        last_generated: now,
        next_due_date: nextDue,
        updated_at: now
      }).eq('pm_id', pmId)

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: 'Generate PM WO', entity_type: 'PM Schedule', entity_id: pmId,
          details: `Generated WO ${woId} from PM ${pmId} (${pm.pm_name})${pm.procedure_file_id ? ' [with procedure]' : ''}`
        })
      } catch {}

      toast.success(`Work Order ${woId} generated from PM!`)
      return woId
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, createPM, updatePM, deletePM, generateWO, uploadProcedure, deleteProcedureFile, getProcedureUrl, checkOpenPMWorkOrder }
}

// ─── Assets for PM dropdown ──────────────────────────────────────────────────

export function useActiveAssets() {
  const [assets, setAssets] = useState([])
  useEffect(() => {
    async function f() {
      const { data } = await supabase.from('assets').select('asset_id, name, location').eq('status', 'Active').order('name')
      setAssets(data || [])
    }
    f()
  }, [])
  return assets
}
