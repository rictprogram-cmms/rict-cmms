/**
 * RICT CMMS — useRequestHistory Hook
 *
 * Fetches and normalizes student requests from all 4 request tables:
 *   - lab_signup_requests   (post-deadline lab changes)
 *   - time_entry_requests   (new/edit time entries)
 *   - temp_access_requests  (role or permission requests)
 *   - work_order_requests   (work order submissions)
 *
 * Returns a unified list with common shape for the RequestHistoryPage.
 *
 * Instructors see all requests; students see only their own.
 * Supports semester-based date filtering at the Supabase query level
 * so only the relevant window of data is loaded.
 *
 * File: src/hooks/useRequestHistory.js
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSlotKey(key) {
  if (!key) return key
  const [dateStr, hourStr] = key.split('_')
  if (!dateStr || hourStr === undefined) return key
  const parts = dateStr.split('-')
  if (parts.length !== 3) return key
  const dt = new Date(+parts[0], +parts[1] - 1, +parts[2])
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hour = parseInt(hourStr)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${dayNames[dt.getDay()]} ${dt.getMonth() + 1}/${dt.getDate()} ${h12}:00 ${ampm}`
}

function formatTime12(timeStr) {
  if (!timeStr) return '—'
  const parts = timeStr.split(':')
  const h = parseInt(parts[0])
  const m = parts[1] || '00'
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

function parseSlots(raw) {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function parsePerms(raw) {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// ─── Normalization Functions ──────────────────────────────────────────────────

function normalizeLabRequest(r) {
  const currentSlots = parseSlots(r.current_slots)
  const requestedSlots = parseSlots(r.requested_slots)
  const cancelling = currentSlots.filter(s => !requestedSlots.includes(s))
  const adding = requestedSlots.filter(s => !currentSlots.includes(s))

  let summary = ''
  if (cancelling.length > 0 && adding.length > 0) {
    summary = `Cancel ${cancelling.length} slot${cancelling.length !== 1 ? 's' : ''}, add ${adding.length} slot${adding.length !== 1 ? 's' : ''}`
  } else if (cancelling.length > 0) {
    summary = `Cancel ${cancelling.length} slot${cancelling.length !== 1 ? 's' : ''}`
  } else if (adding.length > 0) {
    summary = `Add ${adding.length} slot${adding.length !== 1 ? 's' : ''}`
  } else {
    summary = 'No changes'
  }
  summary += ` — ${r.course_id || r.class_id || 'Unknown'}, Week of ${r.week_start || '—'}`

  return {
    id: r.request_id,
    type: 'Lab Change',
    typeColor: '#e67700',
    typeBg: '#fff9db',
    studentName: r.user_name || '',
    studentEmail: r.user_email || '',
    reason: r.reason || '',
    status: r.status || 'Pending',
    reviewedBy: r.reviewed_by || '',
    reviewDate: r.reviewed_date || '',
    rejectionReason: r.review_notes || '',
    submittedDate: r.submitted_date || '',
    summary,
    sourceLink: '/lab-signup',
    sourceLinkLabel: 'Lab Signup',
    details: {
      courseId: r.course_id || r.class_id || '',
      weekStart: r.week_start || '',
      cancelling: cancelling.map(formatSlotKey),
      adding: adding.map(formatSlotKey),
      currentSlots: currentSlots.map(formatSlotKey),
      requestedSlots: requestedSlots.map(formatSlotKey),
    },
  }
}

function normalizeTimeRequest(r) {
  const isEdit = r.entry_type === 'Edit'
  const label = isEdit ? 'Edit' : (r.entry_type || 'New')
  const summary = `${label} — ${r.course_id || r.class_id || 'Unknown'} on ${r.requested_date || '—'} (${formatTime12(r.start_time)} – ${formatTime12(r.end_time)})`

  return {
    id: r.request_id,
    type: 'Time Entry',
    typeColor: '#7048e8',
    typeBg: '#f3f0ff',
    studentName: r.user_name || '',
    studentEmail: r.user_email || '',
    reason: r.reason || '',
    status: r.status || 'Pending',
    reviewedBy: r.reviewed_by || '',
    reviewDate: r.review_date || '',
    rejectionReason: r.rejection_reason || '',
    submittedDate: r.created_at || '',
    summary,
    sourceLink: '/time-cards',
    sourceLinkLabel: 'Time Cards',
    details: {
      entryType: r.entry_type || '',
      courseId: r.course_id || r.class_id || '',
      requestedDate: r.requested_date || '',
      startTime: formatTime12(r.start_time),
      endTime: formatTime12(r.end_time),
      totalHours: r.total_hours || 0,
      linkedRecordId: r.time_clock_record_id || '',
    },
  }
}

function normalizeTempAccessRequest(r) {
  const isPermType = r.request_type === 'permissions'
  const requestedPerms = parsePerms(r.requested_permissions)
  const approvedPerms = parsePerms(r.approved_permissions)

  let summary = ''
  const daysReq = r.days_requested || 0
  const daysAppr = r.approved_days || 0
  const daysSuffix = daysAppr > 0 && daysAppr !== daysReq
    ? `${daysAppr}d approved (${daysReq}d requested)`
    : `${daysReq}d`

  if (isPermType) {
    const permCount = requestedPerms.length
    const approvedCount = approvedPerms.length
    const pages = [...new Set(requestedPerms.map(p => p.page))].join(', ')
    if (approvedCount > 0 && approvedCount < permCount) {
      summary = `${approvedCount} of ${permCount} permissions approved (${pages || 'N/A'}) for ${daysSuffix}`
    } else if (approvedCount > 0 && approvedCount === permCount) {
      summary = `${permCount} permission${permCount !== 1 ? 's' : ''} approved (${pages || 'N/A'}) for ${daysSuffix}`
    } else {
      summary = `${permCount} permission${permCount !== 1 ? 's' : ''} (${pages || 'N/A'}) for ${daysSuffix}`
    }
  } else {
    const roleLabel = r.approved_role && r.approved_role !== r.requested_role
      ? `${r.approved_role} (requested ${r.requested_role})`
      : (r.requested_role || '?')
    summary = `${roleLabel} access for ${daysSuffix}`
  }

  return {
    id: r.request_id,
    type: 'Temp Access',
    typeColor: '#1971c2',
    typeBg: '#e7f5ff',
    studentName: r.user_name || '',
    studentEmail: r.user_email || '',
    reason: r.reason || '',
    status: r.status || 'Pending',
    reviewedBy: r.reviewed_by || '',
    reviewDate: r.review_date || '',
    rejectionReason: r.review_notes || '',
    submittedDate: r.submitted_date || '',
    summary,
    sourceLink: null,
    sourceLinkLabel: null,
    details: {
      requestType: r.request_type || 'role',
      requestedRole: r.requested_role || '',
      approvedRole: r.approved_role || '',
      daysRequested: r.days_requested || 0,
      approvedDays: r.approved_days || 0,
      expiryDate: r.expiry_date || '',
      revertedDate: r.reverted_date || '',
      requestedPermissions: requestedPerms,
      approvedPermissions: approvedPerms,
    },
  }
}

function normalizeWorkOrderRequest(r) {
  const summary = `WO for ${r.asset_name || 'Unknown Asset'} — ${r.priority || 'Normal'} priority`

  return {
    id: r.request_id,
    type: 'Work Order',
    typeColor: '#2f9e44',
    typeBg: '#ebfbee',
    studentName: r.name || '',
    studentEmail: r.email || '',
    reason: r.description || '',
    status: r.status || 'Pending',
    reviewedBy: r.processed_by || '',
    reviewDate: r.processed_date || '',
    rejectionReason: r.rejection_reason || '',
    submittedDate: r.request_date || '',
    summary,
    sourceLink: r.wo_id ? '/work-orders' : null,
    sourceLinkLabel: r.wo_id ? `WO ${r.wo_id}` : null,
    details: {
      assetId: r.asset_id || '',
      assetName: r.asset_name || '',
      priority: r.priority || '',
      description: r.description || '',
      linkedWoId: r.wo_id || '',
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useSemesters — loads available semesters from classes table
// ═══════════════════════════════════════════════════════════════════════════════

export function useSemesters() {
  const [semesters, setSemesters] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        // Only load Active classes; filter out future-only classes
        const todayStr = new Date().toISOString().substring(0, 10)
        const { data, error } = await supabase
          .from('classes')
          .select('semester, start_date, end_date')
          .eq('status', 'Active')
          .not('start_date', 'is', null)
          .not('end_date', 'is', null)
          .order('start_date', { ascending: false })

        if (cancelled) return
        if (error) {
          console.warn('useSemesters query error:', error.message)
          setLoading(false)
          return
        }

        // Group by semester name → derive earliest start and latest end
        const map = new Map()
        ;(data || []).forEach(c => {
          if (!c.semester || !c.start_date || !c.end_date) return
          const existing = map.get(c.semester)
          if (!existing) {
            map.set(c.semester, { label: c.semester, startDate: c.start_date, endDate: c.end_date })
          } else {
            if (c.start_date < existing.startDate) existing.startDate = c.start_date
            if (c.end_date > existing.endDate) existing.endDate = c.end_date
          }
        })

        const list = Array.from(map.values())
        // Sort by startDate descending (most recent first)
        list.sort((a, b) => b.startDate.localeCompare(a.startDate))

        // If the DB returned nothing (RLS, no classes, etc.), add a synthetic
        // "current semester" so the page has a reasonable default window.
        if (list.length === 0) {
          const now = new Date()
          const month = now.getMonth() // 0-11
          const year = now.getFullYear()
          // Academic semesters: Spring = Jan–May, Summer = Jun–Aug, Fall = Sep–Dec
          let label, startDate, endDate
          if (month <= 4) {
            label = `Spring ${year}`
            startDate = `${year}-01-01`
            endDate = `${year}-05-31`
          } else if (month <= 7) {
            label = `Summer ${year}`
            startDate = `${year}-06-01`
            endDate = `${year}-08-31`
          } else {
            label = `Fall ${year}`
            startDate = `${year}-08-15`
            endDate = `${year}-12-31`
          }
          list.push({ label, startDate, endDate, synthetic: true })
        }

        if (!cancelled) setSemesters(list)
      } catch (err) {
        console.error('Error loading semesters:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Determine current semester (today falls within start–end range)
  // Falls back to most recent semester (index 0) — never returns null if semesters exist
  const currentSemester = useMemo(() => {
    if (semesters.length === 0) return null
    const today = new Date().toISOString().substring(0, 10)
    return semesters.find(s => s.startDate <= today && s.endDate >= today) || semesters[0]
  }, [semesters])

  return { semesters, currentSemester, loading }
}

// ═══════════════════════════════════════════════════════════════════════════════
// useRequestHistory — main hook with date-range filtering at query level
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} options
 * @param {string|null} options.dateFrom - ISO date string (YYYY-MM-DD) or null
 * @param {string|null} options.dateTo   - ISO date string (YYYY-MM-DD) or null
 */
export function useRequestHistory({ dateFrom = null, dateTo = null } = {}) {
  const { profile } = useAuth()
  const [allRequests, setAllRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [emailSentMap, setEmailSentMap] = useState({})

  const isInstructor = profile?.role === 'Instructor'
  const userEmail = profile?.email || ''

  const fetchAll = useCallback(async () => {
    if (!profile) return
    setLoading(true)

    try {
      // ── Build date bounds for Supabase queries ──
      // Each table uses a different timestamp column for "submitted date":
      //   lab_signup_requests  → submitted_date
      //   time_entry_requests  → created_at
      //   temp_access_requests → submitted_date
      //   work_order_requests  → request_date
      const fromIso = dateFrom ? `${dateFrom}T00:00:00` : null
      const toIso = dateTo ? `${dateTo}T23:59:59` : null

      let labQ = supabase.from('lab_signup_requests').select('*').order('submitted_date', { ascending: false })
      let timeQ = supabase.from('time_entry_requests').select('*').order('created_at', { ascending: false })
      let tempQ = supabase.from('temp_access_requests').select('*').order('submitted_date', { ascending: false })
      let woQ = supabase.from('work_order_requests').select('*').order('request_date', { ascending: false })

      if (fromIso) {
        labQ = labQ.gte('submitted_date', fromIso)
        timeQ = timeQ.gte('created_at', fromIso)
        tempQ = tempQ.gte('submitted_date', fromIso)
        woQ = woQ.gte('request_date', fromIso)
      }
      if (toIso) {
        labQ = labQ.lte('submitted_date', toIso)
        timeQ = timeQ.lte('created_at', toIso)
        tempQ = tempQ.lte('submitted_date', toIso)
        woQ = woQ.lte('request_date', toIso)
      }

      const [labRes, timeRes, tempRes, woRes] = await Promise.all([labQ, timeQ, tempQ, woQ])

      const labData = (labRes.data || []).map(normalizeLabRequest)
      const timeData = (timeRes.data || []).map(normalizeTimeRequest)
      const tempData = (tempRes.data || []).map(normalizeTempAccessRequest)
      const woData = (woRes.data || []).map(normalizeWorkOrderRequest)

      let merged = [...labData, ...timeData, ...tempData, ...woData]

      // Students: filter to own requests only
      if (!isInstructor) {
        merged = merged.filter(r => r.studentEmail.toLowerCase() === userEmail.toLowerCase())
      }

      // Sort by submitted date descending
      merged.sort((a, b) => {
        const da = a.submittedDate ? new Date(a.submittedDate).getTime() : 0
        const db = b.submittedDate ? new Date(b.submittedDate).getTime() : 0
        return db - da
      })

      setAllRequests(merged)

      // ── Check audit_log for rejection emails sent ──
      try {
        const rejectedIds = merged
          .filter(r => r.status === 'Rejected')
          .map(r => r.id)
          .filter(Boolean)

        if (rejectedIds.length > 0) {
          const { data: auditData } = await supabase
            .from('audit_log')
            .select('entity_id, action, details')
            .in('entity_id', rejectedIds)
            .ilike('action', '%Reject%')

          const sentMap = {}
          ;(auditData || []).forEach(entry => {
            sentMap[entry.entity_id] = true
          })
          setEmailSentMap(sentMap)
        }
      } catch {
        // Non-critical
      }
    } catch (err) {
      console.error('Error fetching request history:', err)
    } finally {
      setLoading(false)
    }
  }, [profile, isInstructor, userEmail, dateFrom, dateTo])

  useEffect(() => { fetchAll() }, [fetchAll])

  return {
    allRequests,
    loading,
    refresh: fetchAll,
    isInstructor,
    emailSentMap,
  }
}

// ─── Stats helper ─────────────────────────────────────────────────────────────

export function useRequestStats(requests) {
  return useMemo(() => {
    const stats = {
      total: requests.length,
      byType: {},
      byStatus: { Approved: 0, Rejected: 0, Pending: 0, Other: 0 },
    }

    const types = ['Lab Change', 'Time Entry', 'Temp Access', 'Work Order']
    types.forEach(t => {
      stats.byType[t] = { total: 0, approved: 0, rejected: 0, pending: 0 }
    })

    requests.forEach(r => {
      const typeStats = stats.byType[r.type]
      if (typeStats) {
        typeStats.total++
        if (r.status === 'Approved') typeStats.approved++
        else if (r.status === 'Rejected') typeStats.rejected++
        else if (r.status === 'Pending') typeStats.pending++
      }

      if (r.status === 'Approved') stats.byStatus.Approved++
      else if (r.status === 'Rejected') stats.byStatus.Rejected++
      else if (r.status === 'Pending') stats.byStatus.Pending++
      else stats.byStatus.Other++
    })

    return stats
  }, [requests])
}
