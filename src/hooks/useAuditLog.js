/**
 * RICT CMMS — useAuditLog Hook
 *
 * Loads paginated audit_log entries with smart search, filters, sort,
 * realtime new-entry detection, export to CSV/XLSX, view tracking,
 * suspicious activity detection, failed-write counter, and retention purge.
 *
 * Permissions resolved via usePermissions('Audit Log'):
 *   view_page          — full view, all filters, all features
 *   view_own           — restricted to current user's entries only
 *   export             — show export buttons
 *   view_suspicious    — show suspicious activity banner
 *   view_failed_writes — show failed-write banner
 *   manage_retention   — Super Admin only; checked in Settings page
 *
 * RLS at the DB layer enforces "users see own rows" — this hook does NOT
 * leak data even if a UI bug forgets to apply the eq('user_email', …) filter.
 *
 * Smart search parses intent:
 *   • Looks like email → ILIKE on user_email
 *   • Looks like known ID prefix + digits (WO1234, AST12) → entity_id prefix
 *   • Matches an action keyword (delete, approve, etc.) → action filter
 *   • Matches an entity type keyword (work order, asset, etc.) → entity_type filter
 *   • Otherwise → free-text ILIKE across user_name, details, entity_id,
 *                 old_value, new_value (trigram-indexed for speed)
 *
 * File: src/hooks/useAuditLog.js
 */

import { assertWrite } from '@/lib/supabaseData'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'

const EXPORT_ROW_CAP = 10000

// ──────────────────────────────────────────────────────────────────────────────
// Smart search parser
// ──────────────────────────────────────────────────────────────────────────────

const ID_PREFIXES = ['WO', 'AST', 'EQ', 'PO', 'TC', 'EB', 'DOC', 'ENF', 'AUD', 'LOG', 'PM']

const ACTION_MAP = {
  'create': 'Create', 'created': 'Create', 'add': 'Create', 'added': 'Create',
  'update': 'Update', 'updated': 'Update', 'edit': 'Update', 'edited': 'Update', 'modified': 'Update',
  'delete': 'Delete', 'deleted': 'Delete', 'remove': 'Delete', 'removed': 'Delete',
  'approve': 'Approve', 'approved': 'Approve',
  'reject': 'Reject', 'rejected': 'Reject', 'denied': 'Reject',
  'close': 'Close', 'closed': 'Close',
  'reopen': 'Reopen', 'reopened': 'Reopen',
  'view': 'View', 'viewed': 'View', 'read': 'View',
  'export': 'Export', 'exported': 'Export',
  'purge': 'Purge', 'purged': 'Purge',
}

const ENTITY_MAP = {
  'work order': 'Work Order', 'workorder': 'Work Order', 'work orders': 'Work Order',
  'asset': 'Asset', 'assets': 'Asset',
  'inventory': 'Inventory', 'part': 'Inventory', 'parts': 'Inventory',
  'user': 'User', 'users': 'User', 'profile': 'User',
  'purchase order': 'Purchase Order', 'purchase orders': 'Purchase Order',
  'bug': 'Bug Request', 'bug request': 'Bug Request',
  'equipment': 'Equipment',
  'lab signup': 'Lab Signup',
  'time clock': 'Time Clock', 'time card': 'Time Clock',
  'announcement': 'Announcement', 'announcements': 'Announcement',
  'volunteer': 'Volunteer Hours', 'volunteer hours': 'Volunteer Hours',
  'temp access': 'Temp Access',
  'audit log': 'Audit Log',
  'permission': 'Permission', 'permissions': 'Permission',
  'sop': 'SOP', 'sops': 'SOP',
}

function parseSearchTerm(term) {
  const raw = (term || '').toString()
  const t = raw.trim()
  if (!t) return { type: 'none', label: '', value: '', raw }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
    return { type: 'user_email', label: 'Email', value: t.toLowerCase(), raw }
  }

  for (const prefix of ID_PREFIXES) {
    if (new RegExp('^' + prefix + '\\d*$', 'i').test(t)) {
      return { type: 'entity_id', label: 'Entity ID', value: t.toUpperCase(), raw }
    }
  }

  const lower = t.toLowerCase()
  if (ACTION_MAP[lower]) {
    return { type: 'action', label: 'Action', value: ACTION_MAP[lower], raw }
  }
  if (ENTITY_MAP[lower]) {
    return { type: 'entity_type', label: 'Entity Type', value: ENTITY_MAP[lower], raw }
  }

  return { type: 'fulltext', label: 'Text', value: t, raw }
}

// Escape an ILIKE pattern so %, _, and \ are literal
function escapeIlike(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}


// ──────────────────────────────────────────────────────────────────────────────
// Main hook
// ──────────────────────────────────────────────────────────────────────────────

export function useAuditLog() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading, isSuperAdmin } = usePermissions('Audit Log')

  const canViewAll      = hasPerm('view_page') || isSuperAdmin
  const canViewOwnOnly  = !canViewAll && hasPerm('view_own')
  const canView         = canViewAll || canViewOwnOnly

  // ── Data state ──
  const [entries, setEntries] = useState([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  // ── Pagination ──
  const [page,     setPage]     = useState(1)
  const [pageSize, setPageSize] = useState(100)

  // ── Filter defaults: last 30 days ──
  const defaultStart = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }, [])

  const [filters, setFilters] = useState({
    startDate:  defaultStart,
    endDate:    null,
    userEmail:  null,
    entityType: null,
    entityId:   null,
    action:     null,
  })

  // ── Smart search (with debounce) ──
  const [searchTerm,      setSearchTerm]      = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const parsedSearch = useMemo(() => parseSearchTerm(debouncedSearch), [debouncedSearch])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 300)
    return () => clearTimeout(t)
  }, [searchTerm])

  // ── Sort ──
  const [sortColumn,    setSortColumn]    = useState('timestamp')
  const [sortDirection, setSortDirection] = useState('desc')

  // ── Realtime new-entry counter ──
  const [newEntriesCount, setNewEntriesCount] = useState(0)

  // ── Dropdown options ──
  const [distinctUsers,       setDistinctUsers]       = useState([])
  const [distinctEntityTypes, setDistinctEntityTypes] = useState([])
  const [distinctActions,     setDistinctActions]     = useState([])

  // ── Banners ──
  const [failedCount,         setFailedCount]         = useState(0)
  const [suspiciousFlags,     setSuspiciousFlags]     = useState([])
  const [dismissedFlagIds,    setDismissedFlagIds]    = useState(() => new Set())

  // ── Reset page when result set changes (but not on first render) ──
  const filterFingerprint = useMemo(
    () => JSON.stringify({ filters, debouncedSearch, pageSize, sortColumn, sortDirection }),
    [filters, debouncedSearch, pageSize, sortColumn, sortDirection]
  )
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    setPage(1)
  }, [filterFingerprint])

  // ──────────────────────────────────────────────────────────────────────────
  // Query builder — used by both load and export
  // ──────────────────────────────────────────────────────────────────────────
  const buildQuery = useCallback((withCount = false) => {
    let q = withCount
      ? supabase.from('audit_log').select('*', { count: 'exact' })
      : supabase.from('audit_log').select('*')

    if (canViewOwnOnly) {
      q = q.eq('user_email', profile?.email || '')
    }

    if (filters.startDate) q = q.gte('timestamp', filters.startDate)
    if (filters.endDate)   q = q.lte('timestamp', filters.endDate)

    if (filters.userEmail)  q = q.eq('user_email',  filters.userEmail)
    if (filters.entityType) q = q.eq('entity_type', filters.entityType)
    if (filters.entityId)   q = q.eq('entity_id',   filters.entityId)
    if (filters.action)     q = q.eq('action',      filters.action)

    const ps = parsedSearch
    if (ps.type === 'user_email') {
      q = q.ilike('user_email', '%' + escapeIlike(ps.value) + '%')
    } else if (ps.type === 'entity_id') {
      q = q.ilike('entity_id', escapeIlike(ps.value) + '%')
    } else if (ps.type === 'action') {
      q = q.eq('action', ps.value)
    } else if (ps.type === 'entity_type') {
      q = q.eq('entity_type', ps.value)
    } else if (ps.type === 'fulltext') {
      const v   = ps.value
      const esc = escapeIlike(v)
      // .or() splits on commas — fall back to single-column when term has one
      if (v.includes(',')) {
        q = q.ilike('details', '%' + esc + '%')
      } else {
        q = q.or(
          'user_name.ilike.%' + esc + '%,details.ilike.%' + esc + '%,entity_id.ilike.%' + esc + '%,old_value.ilike.%' + esc + '%,new_value.ilike.%' + esc + '%'
        )
      }
    }

    return q
  }, [filters, parsedSearch, canViewOwnOnly, profile?.email])


  // ──────────────────────────────────────────────────────────────────────────
  // Load entries
  // ──────────────────────────────────────────────────────────────────────────
  const loadEntries = useCallback(async () => {
    if (permsLoading) return
    if (!canView) { setLoading(false); return }

    setLoading(true)
    setError(null)
    setNewEntriesCount(0)

    try {
      let q = buildQuery(true)
      q = q
        .order(sortColumn, { ascending: sortDirection === 'asc' })
        .range((page - 1) * pageSize, page * pageSize - 1)

      const { data, error: err, count } = await q
      if (err) throw err

      setEntries(data || [])
      setTotal(count || 0)
    } catch (e) {
      console.error('Audit log load error:', e)
      setError(e.message || 'Failed to load audit log')
      setEntries([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [buildQuery, canView, page, pageSize, permsLoading, sortColumn, sortDirection])

  useEffect(() => { loadEntries() }, [loadEntries])


  // ──────────────────────────────────────────────────────────────────────────
  // Distinct values for dropdowns (last 90 days)
  // ──────────────────────────────────────────────────────────────────────────
  const loadDistincts = useCallback(async () => {
    if (permsLoading || !canView) return

    try {
      const since = new Date()
      since.setDate(since.getDate() - 90)

      const { data } = await supabase
        .from('audit_log')
        .select('user_email, user_name, entity_type, action')
        .gte('timestamp', since.toISOString())
        .limit(10000)

      const userMap     = new Map()
      const entityTypes = new Set()
      const actions     = new Set()

      ;(data || []).forEach(r => {
        if (r.user_email && !userMap.has(r.user_email)) {
          userMap.set(r.user_email, r.user_name || r.user_email)
        }
        if (r.entity_type) entityTypes.add(r.entity_type)
        if (r.action)      actions.add(r.action)
      })

      const userList = Array.from(userMap.entries())
        .map(([email, name]) => ({ email, name }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

      setDistinctUsers(userList)
      setDistinctEntityTypes(Array.from(entityTypes).sort())
      setDistinctActions(Array.from(actions).sort())
    } catch (e) {
      console.warn('Audit log distincts load failed:', e.message)
    }
  }, [canView, permsLoading])

  useEffect(() => { loadDistincts() }, [loadDistincts])


  // ──────────────────────────────────────────────────────────────────────────
  // Realtime
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (permsLoading || !canView) return

    const channelName = 'audit-log-rt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'audit_log' },
        (payload) => {
          if (canViewOwnOnly && payload?.new?.user_email !== profile?.email) return
          setNewEntriesCount(c => c + 1)
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [canView, canViewOwnOnly, permsLoading, profile?.email])


  // ──────────────────────────────────────────────────────────────────────────
  // Failed-write counter
  // ──────────────────────────────────────────────────────────────────────────
  const loadFailedCount = useCallback(async () => {
    if (!hasPerm('view_failed_writes') && !isSuperAdmin) return
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'audit_failed_count')
        .maybeSingle()
      setFailedCount(Number(data?.setting_value) || 0)
    } catch {
      setFailedCount(0)
    }
  }, [hasPerm, isSuperAdmin])

  useEffect(() => { loadFailedCount() }, [loadFailedCount])

  const resetFailedCount = useCallback(async () => {
    try {
      const { error: err } = assertWrite(
      await supabase
        .from('settings')
        .update({
          setting_value: '0',
          updated_at:    new Date().toISOString(),
          updated_by:    profile?.email || 'system',
        })
        .eq('setting_key', 'audit_failed_count').select(),
      'settings.update'
    )
      if (err) throw err
      setFailedCount(0)

      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name:  profile
            ? (profile.first_name || '') + ' ' + (profile.last_name || '').charAt(0) + '.'
            : 'Unknown',
          action:      'Reset',
          entity_type: 'Audit Log',
          entity_id:   'FAILED_COUNT',
          details:     'Reset failed audit write counter to 0',
        })
      } catch {}

      return true
    } catch (e) {
      console.error('Failed to reset audit_failed_count:', e)
      return false
    }
  }, [profile])


  // ──────────────────────────────────────────────────────────────────────────
  // Suspicious activity
  // ──────────────────────────────────────────────────────────────────────────
  const loadSuspicious = useCallback(async () => {
    if (!hasPerm('view_suspicious') && !isSuperAdmin) return
    try {
      const { data: sets } = await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .eq('category', 'audit')

      const cfg = {}
      ;(sets || []).forEach(s => { cfg[s.setting_key] = s.setting_value })

      const { data, error: err } = await supabase.rpc('audit_log_suspicious_activity', {
        p_lookback_hours:    24,
        p_deletes_threshold: Number(cfg.audit_suspicious_deletes_threshold) || 5,
        p_deletes_minutes:   Number(cfg.audit_suspicious_deletes_minutes)   || 60,
        p_updates_threshold: Number(cfg.audit_suspicious_updates_threshold) || 20,
        p_updates_minutes:   Number(cfg.audit_suspicious_updates_minutes)   || 5,
      })
      if (err) throw err
      setSuspiciousFlags(data || [])
    } catch (e) {
      console.warn('Suspicious activity load failed:', e.message)
      setSuspiciousFlags([])
    }
  }, [hasPerm, isSuperAdmin])

  useEffect(() => { loadSuspicious() }, [loadSuspicious])

  // ── Per-user persistent dismissal of suspicious-activity flags ──
  // Stored in localStorage so the dismissal sticks across reloads for THIS user
  // on THIS device. Each flag is uniquely identified by (user_email, flag_type,
  // window_start). Dismissed IDs older than 30 days are pruned automatically so
  // storage doesn't grow forever. If the same burst pattern recurs later, it
  // produces a new flag_id and will re-appear (correct behavior).
  //
  // Cross-device sync (Brad dismisses on desktop → laptop also hides it) would
  // require a small DB table; not in Phase 1 scope.

  const flagKey = useCallback(
    (f) => (f ? `${f.user_email}::${f.flag_type}::${f.window_start}` : null),
    []
  )
  const storageKey = useMemo(
    () => (profile?.email ? `rict-audit-dismissed-flags::${profile.email}` : null),
    [profile?.email]
  )

  // Hydrate dismissed set from localStorage on mount / user change
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw)
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const fresh = items.filter(x => x && typeof x.id === 'string' && typeof x.ts === 'number' && x.ts > cutoff)
      setDismissedFlagIds(new Set(fresh.map(x => x.id)))
      // Write pruned list back if anything was dropped
      if (fresh.length !== items.length) {
        window.localStorage.setItem(storageKey, JSON.stringify({ items: fresh }))
      }
    } catch (e) {
      console.warn('Audit dismissal hydrate failed:', e.message)
    }
  }, [storageKey])

  const dismissSuspicious = useCallback(() => {
    // Dismiss every flag currently in the list (the banner X is a "dismiss all")
    if (!storageKey || typeof window === 'undefined') return
    const ids = suspiciousFlags.map(flagKey).filter(Boolean)
    if (ids.length === 0) return

    setDismissedFlagIds(prev => {
      const next = new Set(prev)
      ids.forEach(id => next.add(id))
      return next
    })

    try {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : { items: [] }
      const existingIds = new Set((parsed.items || []).map(x => x?.id))
      const additions = ids
        .filter(id => !existingIds.has(id))
        .map(id => ({ id, ts: Date.now() }))
      parsed.items = [...(parsed.items || []), ...additions]
      window.localStorage.setItem(storageKey, JSON.stringify(parsed))
    } catch (e) {
      console.warn('Audit dismissal persist failed:', e.message)
    }
  }, [storageKey, suspiciousFlags, flagKey])

  // Visible flags = all current flags MINUS anything already dismissed by this user
  const visibleSuspiciousFlags = useMemo(
    () => suspiciousFlags.filter(f => !dismissedFlagIds.has(flagKey(f))),
    [suspiciousFlags, dismissedFlagIds, flagKey]
  )


  // ──────────────────────────────────────────────────────────────────────────
  // Retention purge
  // ──────────────────────────────────────────────────────────────────────────
  const purgePreview = useCallback(async (days) => {
    const { data, error: err } = await supabase.rpc('audit_log_purge_preview', { p_days_to_keep: Number(days) })
    if (err) throw err
    return data
  }, [])

  const executePurge = useCallback(async (days) => {
    if (!isSuperAdmin) throw new Error('Only Super Admin can purge audit log')
    const { data, error: err } = await supabase.rpc('audit_log_purge', { p_days_to_keep: Number(days) })
    if (err) throw err
    await loadEntries()
    return data
  }, [isSuperAdmin, loadEntries])


  // ──────────────────────────────────────────────────────────────────────────
  // Export (CSV + XLSX)
  // ──────────────────────────────────────────────────────────────────────────
  const buildExportRows = useCallback(async () => {
    let q = buildQuery(false)
    q = q.order(sortColumn, { ascending: sortDirection === 'asc' }).limit(EXPORT_ROW_CAP)
    const { data, error: err } = await q
    if (err) throw err
    return data || []
  }, [buildQuery, sortColumn, sortDirection])

  const auditExport = useCallback(async (format, rowCount) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: profile?.email,
        user_name:  profile
          ? (profile.first_name || '') + ' ' + (profile.last_name || '').charAt(0) + '.'
          : 'Unknown',
        action:      'Export',
        entity_type: 'Audit Log',
        entity_id:   format,
        details:     'Exported ' + rowCount + ' audit log entries to ' + format,
      })
    } catch (e) {
      console.warn('Audit log export-tracking failed:', e.message)
    }
  }, [profile])

  const exportCSV = useCallback(async () => {
    if (!hasPerm('export') && !isSuperAdmin) throw new Error('No export permission')
    const rows = await buildExportRows()
    const headers = [
      'Log ID', 'Timestamp', 'User Name', 'User Email',
      'Action', 'Entity Type', 'Entity ID',
      'Field Changed', 'Old Value', 'New Value', 'Details',
    ]
    const csvLines = [headers.join(',')]

    rows.forEach(r => {
      const cells = [
        r.log_id, r.timestamp, r.user_name, r.user_email,
        r.action, r.entity_type, r.entity_id,
        r.field_changed, r.old_value, r.new_value, r.details,
      ].map(v => {
        const s = (v ?? '').toString()
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
        return s
      })
      csvLines.push(cells.join(','))
    })

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = 'audit-log-' + new Date().toISOString().slice(0, 10) + '.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    await auditExport('CSV', rows.length)
    return { count: rows.length, capped: rows.length === EXPORT_ROW_CAP }
  }, [auditExport, buildExportRows, hasPerm, isSuperAdmin])

  const exportXLSX = useCallback(async () => {
    if (!hasPerm('export') && !isSuperAdmin) throw new Error('No export permission')
    const rows = await buildExportRows()
    const XLSX = await import('xlsx')

    const sheetData = rows.map(r => ({
      'Log ID':        r.log_id || '',
      'Timestamp':     r.timestamp || '',
      'User Name':     r.user_name || '',
      'User Email':    r.user_email || '',
      'Action':        r.action || '',
      'Entity Type':   r.entity_type || '',
      'Entity ID':     r.entity_id || '',
      'Field Changed': r.field_changed || '',
      'Old Value':     r.old_value || '',
      'New Value':     r.new_value || '',
      'Details':       r.details || '',
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(sheetData)
    ws['!cols'] = [
      { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 30 },
      { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 18 },
      { wch: 28 }, { wch: 28 }, { wch: 60 },
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Log')
    XLSX.writeFile(wb, 'audit-log-' + new Date().toISOString().slice(0, 10) + '.xlsx')

    await auditExport('XLSX', rows.length)
    return { count: rows.length, capped: rows.length === EXPORT_ROW_CAP }
  }, [auditExport, buildExportRows, hasPerm, isSuperAdmin])


  // ──────────────────────────────────────────────────────────────────────────
  // View tracking
  // ──────────────────────────────────────────────────────────────────────────
  const trackView = useCallback(async (entityType, entityId, details) => {
    if (!profile?.email) return
    try {
      const { data: cfg } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'audit_track_view_entities')
        .maybeSingle()

      const trackedList = (cfg?.setting_value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      if (!trackedList.includes(entityType)) return

      await supabase.from('audit_log').insert({
        user_email: profile.email,
        user_name:  ((profile.first_name || '') + ' ' + (profile.last_name || '').charAt(0) + '.').trim(),
        action:      'View',
        entity_type: entityType,
        entity_id:   entityId || '',
        details:     details || ('Viewed ' + entityType + (entityId ? ' (' + entityId + ')' : '')),
      })
    } catch (e) {
      console.warn('View tracking failed:', e.message)
    }
  }, [profile])


  // ──────────────────────────────────────────────────────────────────────────
  // Public helpers
  // ──────────────────────────────────────────────────────────────────────────
  const setFilter = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }, [])

  const resetFilters = useCallback(() => {
    setFilters({
      startDate:  defaultStart,
      endDate:    null,
      userEmail:  null,
      entityType: null,
      entityId:   null,
      action:     null,
    })
    setSearchTerm('')
    setSortColumn('timestamp')
    setSortDirection('desc')
  }, [defaultStart])

  const setSort = useCallback((col) => {
    if (sortColumn === col) {
      setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(col)
      setSortDirection('desc')
    }
  }, [sortColumn])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return {
    // Data
    entries, total, loading, error,

    // Pagination
    page, setPage, pageSize, setPageSize, totalPages,

    // Filters
    filters, setFilter, resetFilters,

    // Search
    searchTerm, setSearchTerm, parsedSearch,

    // Sort
    sortColumn, sortDirection, setSort,

    // Realtime
    newEntriesCount, refresh: loadEntries,

    // Dropdowns
    distinctUsers, distinctEntityTypes, distinctActions,
    refreshDistincts: loadDistincts,

    // Banners
    failedCount, resetFailedCount,
    suspiciousFlags: visibleSuspiciousFlags,
    dismissSuspicious, refreshSuspicious: loadSuspicious,

    // Retention
    purgePreview, executePurge,

    // Export
    exportCSV, exportXLSX,

    // View tracking
    trackView,

    // Permissions
    hasPerm, permsLoading, isSuperAdmin,
    canViewAll, canViewOwnOnly, canView,
  }
}

export default useAuditLog
