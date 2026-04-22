/**
 * RICT CMMS — Network Map Page
 *
 * Single source of truth for reserved IPs on the 10.171.192.0/22 network.
 * Replaces the Excel spreadsheet previously kept by the instructor.
 *
 * Permissions (feature on page 'Network Map'):
 *   view_page       — everyone (default)
 *   suggest_changes — student / work_study / instructor
 *   edit_devices    — instructor
 *   add_devices     — instructor
 *   delete_devices  — instructor
 *   approve_changes — instructor
 *   print_map       — everyone
 *   export_data     — work_study / instructor
 *
 * WCAG 2.1 AA: semantic table, keyboard focus, aria labels on icon buttons,
 * high-contrast "Do Not Use" rows with non-color indicators, live regions
 * for async state, focus trap in modals.
 *
 * File: src/pages/NetworkMapPage.jsx
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useNetworkMap } from '@/hooks/useNetworkMap'
import { useRejectionNotification } from '@/hooks/useRejectionNotification'
import RejectionModal from '@/components/RejectionModal'
import {
  NETWORK_CONFIG, buildIp, isDoNotUseIp, isValidMac, normaliseMac,
} from '@/lib/networkConfig'
import {
  Network, Search, Printer, Download, Plus, Edit3, Trash2, Send, X,
  CheckCircle2, XCircle, AlertTriangle, Inbox, Info, Loader2, Lock,
  ChevronDown, ChevronRight, FileSpreadsheet, ClipboardList, Clock,
  History, Filter, Link2, ExternalLink,
} from 'lucide-react'

// ── Constants ───────────────────────────────────────────────────────────────

const COLUMN_LABELS = {
  device_name: 'Device',
  mac_address: 'MAC Address',
  profinet_name: 'Profinet Name',
  location: 'Location',
  notes: 'Notes',
  asset_id: 'Linked Asset',
}

const DEFAULT_SUBNET = NETWORK_CONFIG.subnets[0].id

// ── Small utils ─────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch { return '—' }
}

function statusBadge(isReserved, isGateway, hasDevice) {
  if (isGateway) return { bg: '#fef3c7', color: '#92400e', label: 'Gateway', icon: Lock }
  if (isReserved) return { bg: '#fee2e2', color: '#991b1b', label: 'Do Not Use', icon: Lock }
  if (hasDevice) return { bg: '#d1fae5', color: '#065f46', label: 'Assigned', icon: CheckCircle2 }
  return { bg: '#e5e7eb', color: '#6b7280', label: 'Available', icon: null }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════════════════

export default function NetworkMapPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Network Map')
  const { sendRejectionNotification } = useRejectionNotification()
  const {
    devices, changeRequests, loading, error,
    activeAssets, assetById, linkedAssetIds, effectiveDeviceName,
    devicesBySubnet, deviceByIp, pendingByDevice, pendingCount,
    findDuplicateMac,
    addDevice, updateDevice, deleteDevice,
    submitChangeRequest, cancelChangeRequest,
    approveChangeRequest, rejectChangeRequest,
  } = useNetworkMap()

  const [activeTab, setActiveTab] = useState(DEFAULT_SUBNET)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all') // all | assigned | available | reserved
  const [toast, setToast] = useState(null)    // { msg, type }

  // Modals
  const [editTarget, setEditTarget] = useState(null)      // device row (instructor edit)
  const [addTarget, setAddTarget] = useState(null)        // { subnet, octet } or null
  const [suggestTarget, setSuggestTarget] = useState(null) // { device, ip, subnet, mode }
  const [deleteTarget, setDeleteTarget] = useState(null)  // device row
  const [approveTarget, setApproveTarget] = useState(null) // change request
  const [rejectTarget, setRejectTarget] = useState(null)   // change request
  const [historyTarget, setHistoryTarget] = useState(null) // device row

  const canEdit = hasPerm('edit_devices')
  const canAdd = hasPerm('add_devices')
  const canDelete = hasPerm('delete_devices')
  const canSuggest = hasPerm('suggest_changes')
  const canApprove = hasPerm('approve_changes')
  const canPrint = hasPerm('print_map')
  const canExport = hasPerm('export_data')

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3200)
  }, [])

  // ── Build the rendered row list for the active subnet ─────────────────
  // Every octet 1..254 gets a row so available IPs are visible to everyone.
  const activeSubnet = NETWORK_CONFIG.subnets.find(s => s.id === activeTab)
  const subnetRows = useMemo(() => {
    if (!activeSubnet) return []
    const rows = []
    for (let octet = 1; octet <= 254; octet++) {
      const ip = `${activeSubnet.prefix}${octet}`
      const device = deviceByIp.get(ip) || null
      const pending = pendingByDevice.get(device?.device_id || ip) || []
      const doNotUse = isDoNotUseIp(ip)
      rows.push({
        ip, octet, device, pending,
        subnetId: activeSubnet.id,
        isReserved: (device?.is_reserved) || doNotUse,
        isGateway: ip === NETWORK_CONFIG.gateway,
      })
    }
    return rows
  }, [activeSubnet, deviceByIp, pendingByDevice])

  // ── Build the cross-subnet row list (used during search) ─────────────
  // 3 × 254 = 762 rows. Memoized so it only rebuilds when devices change.
  const allSubnetRows = useMemo(() => {
    const rows = []
    NETWORK_CONFIG.subnets.forEach(s => {
      for (let octet = 1; octet <= 254; octet++) {
        const ip = `${s.prefix}${octet}`
        const device = deviceByIp.get(ip) || null
        const pending = pendingByDevice.get(device?.device_id || ip) || []
        const doNotUse = isDoNotUseIp(ip)
        rows.push({
          ip, octet, device, pending,
          subnetId: s.id,
          isReserved: (device?.is_reserved) || doNotUse,
          isGateway: ip === NETWORK_CONFIG.gateway,
        })
      }
    })
    return rows
  }, [deviceByIp, pendingByDevice])

  const isSearching = search.trim().length > 0

  // ── Smart matching (multi-token AND, MAC-format-agnostic) ─────────
  // Returns true if every token from the query appears somewhere in the
  // row's haystack. The MAC field is included twice — once as-is and once
  // with separators stripped — so users can search "AC-64-17", "AC:64:17",
  // or "AC6417" interchangeably.
  const tokens = useMemo(() => {
    const raw = search.trim().toLowerCase()
    if (!raw) return []
    return raw.split(/\s+/).filter(Boolean).map(t => {
      // If a token looks like a MAC fragment (hex + separators), strip separators
      if (/^[0-9a-f][0-9a-f-:]+$/i.test(t) && /[a-f]/i.test(t.replace(/[^a-f]/gi, ''))) {
        return t.replace(/[-:]/g, '')
      }
      return t
    })
  }, [search])

  const matchesQuery = useCallback((row) => {
    if (tokens.length === 0) return true
    const d = row.device
    const macRaw = (d?.mac_address || '').toLowerCase()
    const macStripped = macRaw.replace(/[-:]/g, '')
    // Include the live asset-resolved name so searching finds freshly renamed assets
    const liveName = effectiveDeviceName(d)
    const haystack = [
      row.ip,
      d?.device_name, liveName, d?.profinet_name, d?.location, d?.notes,
      d?.asset_id,
      macRaw, macStripped,
    ].filter(Boolean).join(' ').toLowerCase()
    return tokens.every(t => haystack.includes(t))
  }, [tokens, effectiveDeviceName])

  // ── Apply search + filter ────────────────────────────────────────────
  // When searching, search ALL three subnets and hide empty/available rows
  // (those have no device data to match against). When NOT searching, show
  // the active subnet's full 254-row list as today.
  const filteredRows = useMemo(() => {
    const baseRows = isSearching ? allSubnetRows : subnetRows
    return baseRows.filter(r => {
      // status filter pass
      if (filter === 'assigned' && (!r.device || r.isReserved)) return false
      if (filter === 'available' && r.device) return false
      if (filter === 'reserved' && !r.isReserved && !r.isGateway) return false
      // search pass — when searching, hide empty rows that don't match by IP
      if (isSearching) {
        if (!r.device && !matchesQuery(r)) return false
        return matchesQuery(r)
      }
      return true
    })
  }, [subnetRows, allSubnetRows, isSearching, filter, matchesQuery])

  // Per-subnet match counts (used to show "(N)" badges next to tabs while searching)
  const matchCountsBySubnet = useMemo(() => {
    if (!isSearching) return null
    const counts = {}
    NETWORK_CONFIG.subnets.forEach(s => { counts[s.id] = 0 })
    filteredRows.forEach(r => { counts[r.subnetId] = (counts[r.subnetId] || 0) + 1 })
    return counts
  }, [isSearching, filteredRows])

  // ── Subnet summary counts ────────────────────────────────────────────
  const subnetSummaries = useMemo(() => {
    return NETWORK_CONFIG.subnets.map(s => {
      const list = devicesBySubnet[s.id] || []
      const assigned = list.filter(d => !d.is_reserved).length
      const reserved = list.filter(d => d.is_reserved).length
      return {
        ...s,
        assigned,
        reserved,
        available: 254 - assigned - reserved,
      }
    })
  }, [devicesBySubnet])

  // ── Pending requests filtered for "My Requests" vs All ──────────────
  const visiblePending = useMemo(() => {
    const list = changeRequests.filter(r => r.status === 'Pending')
    if (canApprove) return list
    return list.filter(r => r.submitted_by?.toLowerCase() === profile?.email?.toLowerCase())
  }, [changeRequests, canApprove, profile])

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleEditSave = async (patch) => {
    try {
      await updateDevice(editTarget.device_id, patch)
      showToast(`Updated ${editTarget.ip_address}`, 'success')
      setEditTarget(null)
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleAddSave = async (values) => {
    try {
      await addDevice(values)
      showToast(`Added ${values.ip_address}`, 'success')
      setAddTarget(null)
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleSuggestSubmit = async ({ changeType, currentValues, proposedValues, reason }) => {
    try {
      await submitChangeRequest({
        changeType,
        deviceId: suggestTarget.device?.device_id || null,
        ipAddress: suggestTarget.ip,
        subnet: suggestTarget.subnet,
        currentValues,
        proposedValues,
        reason,
      })
      showToast('Change request submitted for review', 'success')
      setSuggestTarget(null)
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleDeleteConfirm = async () => {
    try {
      await deleteDevice(deleteTarget.device_id)
      showToast(`Deleted ${deleteTarget.ip_address}`, 'success')
      setDeleteTarget(null)
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleApprove = async (reviewNotes) => {
    try {
      await approveChangeRequest(approveTarget.request_id, reviewNotes)
      showToast(`Change ${approveTarget.request_id} approved`, 'success')
      setApproveTarget(null)
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleReject = async (reason) => {
    const req = rejectTarget
    try {
      await rejectChangeRequest(req.request_id, reason)
      // Fire email + in-app notification using shared flow
      if (req.submitted_by) {
        await sendRejectionNotification({
          recipientEmail: req.submitted_by,
          recipientName: req.submitted_by_name || '',
          requestType: 'Network Change Request',
          requestId: req.request_id,
          reason,
          extraDetails: `Proposed change for ${req.ip_address}`,
        })
      }
      showToast(`Change ${req.request_id} rejected`, 'success')
      setRejectTarget(null)
    } catch (e) {
      showToast(e.message, 'error')
      throw e
    }
  }

  const handleCancelPending = async (requestId) => {
    try {
      await cancelChangeRequest(requestId)
      showToast('Request cancelled', 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // ── Excel export ──────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      NETWORK_CONFIG.subnets.forEach(subnet => {
        const rows = []
        rows.push(['Device', 'MAC Address', 'Profinet Name', 'IP Address', 'Location', 'Notes', 'Status', 'Linked Asset'])
        const list = devicesBySubnet[subnet.id] || []
        for (let octet = 1; octet <= 254; octet++) {
          const ip = `${subnet.prefix}${octet}`
          const d = list.find(x => x.last_octet === octet)
          const status = (d?.is_reserved || isDoNotUseIp(ip)) ? 'Reserved'
                       : d ? 'Assigned' : 'Available'
          rows.push([
            effectiveDeviceName(d) || (isDoNotUseIp(ip) ? 'Do Not Use' : ''),
            d?.mac_address || '',
            d?.profinet_name || (ip === NETWORK_CONFIG.gateway ? 'DHCP' : ''),
            ip,
            d?.location || '',
            d?.notes || '',
            status,
            d?.asset_id || '',
          ])
        }
        const ws = XLSX.utils.aoa_to_sheet(rows)
        ws['!cols'] = [
          { wch: 40 }, { wch: 20 }, { wch: 24 }, { wch: 16 }, { wch: 20 }, { wch: 40 }, { wch: 12 }, { wch: 12 },
        ]
        XLSX.utils.book_append_sheet(wb, ws, subnet.shortLabel.replace(/[^\w.]/g, '_'))
      })
      const stamp = new Date().toISOString().substring(0, 10)
      XLSX.writeFile(wb, `RICT_Network_Map_${stamp}.xlsx`)
      showToast('Network map exported', 'success')
    } catch (e) {
      showToast(`Export failed: ${e.message}`, 'error')
    }
  }, [devicesBySubnet, showToast])

  // ── Guards ────────────────────────────────────────────────────────────
  if (permsLoading) return <LoadingState label="Loading permissions…" />
  if (!hasPerm('view_page')) {
    return (
      <div className="p-6 max-w-2xl mx-auto text-center">
        <Network size={40} className="mx-auto mb-3 text-surface-300" aria-hidden="true" />
        <p className="text-surface-500 text-sm">You do not have permission to view the Network Map.</p>
      </div>
    )
  }
  if (loading) return <LoadingState label="Loading network map…" />
  if (error) {
    return (
      <div className="p-6 max-w-2xl mx-auto text-center" role="alert">
        <AlertTriangle size={36} className="mx-auto mb-2 text-red-500" aria-hidden="true" />
        <p className="text-sm text-red-700">Failed to load: {error}</p>
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════════════════════
  return (
    <div className="space-y-4 max-w-7xl mx-auto">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
            <Network size={20} className="text-brand-600" aria-hidden="true" />
            Network Map
          </h1>
          <p className="text-xs text-surface-500 mt-0.5">
            RICT lab network {NETWORK_CONFIG.networkCidr} · Gateway {NETWORK_CONFIG.gateway}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canPrint && (
            <button
              onClick={() => navigate('/network-map/print')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg
                bg-white border border-surface-200 text-surface-700
                hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label="Open print view"
            >
              <Printer size={14} aria-hidden="true" /> Print 11×17
            </button>
          )}
          {canExport && (
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg
                bg-white border border-surface-200 text-surface-700
                hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label="Export to Excel"
            >
              <FileSpreadsheet size={14} aria-hidden="true" /> Export
            </button>
          )}
          {canAdd && (
            <button
              onClick={() => setAddTarget({ subnet: activeTab })}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg
                bg-brand-600 text-white shadow-sm
                hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Plus size={14} aria-hidden="true" /> Add Device
            </button>
          )}
        </div>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5" role="region" aria-label="Subnet usage">
        <InfoCard
          title="DHCP Pool"
          subtitle={NETWORK_CONFIG.dhcpPool.label}
          body={NETWORK_CONFIG.dhcpPool.range}
          bg="#f0f9ff"
          color="#0369a1"
        />
        {subnetSummaries.map(s => (
          <SubnetCard
            key={s.id}
            subnet={s}
            active={activeTab === s.id}
            onClick={() => setActiveTab(s.id)}
          />
        ))}
        {canApprove && (
          <PendingCard
            count={pendingCount}
            onClick={() => {
              const panel = document.getElementById('pending-changes-panel')
              panel?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          />
        )}
      </div>

      {/* ── Subnet tabs ── */}
      <div
        role="tablist"
        aria-label="Subnet selector"
        className="flex gap-1 bg-surface-100 rounded-xl p-1 overflow-x-auto"
      >
        {NETWORK_CONFIG.subnets.map(s => {
          const matchCount = matchCountsBySubnet?.[s.id]
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={activeTab === s.id && !isSearching}
              aria-controls={`panel-${s.id}`}
              onClick={() => setActiveTab(s.id)}
              disabled={isSearching}
              className={`px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                disabled:opacity-60 disabled:cursor-not-allowed ${
                activeTab === s.id && !isSearching
                  ? 'bg-white text-brand-700 shadow-sm'
                  : 'text-surface-600 hover:text-surface-900'
              }`}
            >
              {s.name}
              {isSearching && matchCount !== undefined && (
                <span
                  className="ml-1.5 inline-flex items-center justify-center min-w-[18px] px-1 py-0.5 rounded-full text-[10px] font-bold bg-brand-100 text-brand-700"
                  aria-label={`${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}
                >
                  {matchCount}
                </span>
              )}
            </button>
          )
        })}
        {isSearching && (
          <div className="ml-auto flex items-center px-3 text-[11px] font-medium text-brand-700">
            <Search size={11} className="mr-1" aria-hidden="true" />
            Searching all subnets
          </div>
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className="bg-white rounded-xl border border-surface-200 p-3 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="nm-search" className="block text-xs font-medium text-surface-500 mb-1">
            Search all subnets — device, MAC, Profinet, location
          </label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
            <input
              id="nm-search"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSearch('') }}
              placeholder="Try: bench plc · AC-64-17 · 193.10 · cognex"
              className="w-full pl-9 pr-9 py-2 text-sm border border-surface-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-surface-400 hover:text-surface-700 hover:bg-surface-100
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                aria-label="Clear search"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <div className="min-w-[140px]">
          <label htmlFor="nm-filter" className="block text-xs font-medium text-surface-500 mb-1">Filter</label>
          <select
            id="nm-filter"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg bg-white
              focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="all">All rows</option>
            <option value="assigned">Assigned only</option>
            <option value="available">Available only</option>
            <option value="reserved">Reserved only</option>
          </select>
        </div>
        <div aria-live="polite" className="text-xs text-surface-500 ml-auto">
          {isSearching ? (
            <>
              Found <span className="font-semibold text-surface-700">{filteredRows.length}</span>{' '}
              {filteredRows.length === 1 ? 'match' : 'matches'} across all subnets
            </>
          ) : (
            <>Showing {filteredRows.length} of 254 addresses</>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div
        id={`panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="bg-white rounded-xl border border-surface-200 overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={`Devices on ${activeSubnet?.name || ''}`}>
            <caption className="sr-only">
              Device assignments for subnet {activeSubnet?.name}. Contains {filteredRows.length} visible rows.
            </caption>
            <thead className="bg-surface-50 border-b border-surface-200">
              <tr>
                <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">IP</th>
                <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">Status</th>
                <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">Device</th>
                <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">MAC Address</th>
                <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">Profinet Name</th>
                <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">Location</th>
                <th scope="col" className="text-right px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, idx) => (
                <NetworkRow
                  key={r.ip}
                  row={r}
                  zebra={idx % 2 === 1}
                  showSubnetTag={isSearching}
                  effectiveDeviceName={effectiveDeviceName}
                  assetById={assetById}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  canSuggest={canSuggest}
                  onEdit={() => setEditTarget(r.device)}
                  onDelete={() => setDeleteTarget(r.device)}
                  onSuggest={(mode) => setSuggestTarget({
                    device: r.device, ip: r.ip, subnet: r.subnetId, mode,
                  })}
                  onAdd={() => setAddTarget({ subnet: r.subnetId, octet: r.octet })}
                  onHistory={() => setHistoryTarget(r.device)}
                />
              ))}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-surface-400 text-sm">
                    No rows match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Pending Changes Panel ── */}
      {visiblePending.length > 0 && (
        <div
          id="pending-changes-panel"
          className="bg-white rounded-xl border border-amber-200 overflow-hidden"
          role="region"
          aria-label="Pending network change requests"
        >
          <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
            <Inbox size={16} className="text-amber-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-amber-900">
              {canApprove ? 'Pending Network Changes' : 'My Pending Requests'} · {visiblePending.length}
            </h2>
          </div>
          <ul className="divide-y divide-surface-100">
            {visiblePending.map(req => (
              <PendingRequestCard
                key={req.request_id}
                req={req}
                canApprove={canApprove}
                isOwn={req.submitted_by?.toLowerCase() === profile?.email?.toLowerCase()}
                assetById={assetById}
                onApprove={() => setApproveTarget(req)}
                onReject={() => setRejectTarget(req)}
                onCancel={() => handleCancelPending(req.request_id)}
              />
            ))}
          </ul>
        </div>
      )}

      {/* ── Modals ── */}
      {editTarget && (
        <DeviceFormModal
          mode="edit"
          initial={editTarget}
          subnetId={editTarget.subnet}
          fixedIp={editTarget.ip_address}
          findDuplicateMac={findDuplicateMac}
          activeAssets={activeAssets}
          linkedAssetIds={linkedAssetIds}
          onCancel={() => setEditTarget(null)}
          onSubmit={handleEditSave}
        />
      )}
      {addTarget && (
        <DeviceFormModal
          mode="add"
          subnetId={addTarget.subnet}
          initialOctet={addTarget.octet}
          takenOctets={new Set((devicesBySubnet[addTarget.subnet] || []).map(d => d.last_octet))}
          findDuplicateMac={findDuplicateMac}
          activeAssets={activeAssets}
          linkedAssetIds={linkedAssetIds}
          onCancel={() => setAddTarget(null)}
          onSubmit={handleAddSave}
        />
      )}
      {suggestTarget && (
        <SuggestChangeModal
          target={suggestTarget}
          activeAssets={activeAssets}
          linkedAssetIds={linkedAssetIds}
          assetById={assetById}
          effectiveDeviceName={effectiveDeviceName}
          onCancel={() => setSuggestTarget(null)}
          onSubmit={handleSuggestSubmit}
        />
      )}
      {deleteTarget && (
        <ConfirmDeleteModal
          device={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}
      {approveTarget && (
        <ApproveChangeModal
          req={approveTarget}
          device={deviceByIp.get(approveTarget.ip_address) || null}
          assetById={assetById}
          onCancel={() => setApproveTarget(null)}
          onConfirm={handleApprove}
        />
      )}
      {historyTarget && (
        <DeviceHistoryModal
          device={historyTarget}
          changeRequests={changeRequests}
          onClose={() => setHistoryTarget(null)}
        />
      )}

      {/* Rejection uses shared RejectionModal */}
      <RejectionModal
        open={!!rejectTarget}
        title="Reject Network Change Request"
        subtitle={rejectTarget ? `${rejectTarget.request_id} — ${rejectTarget.ip_address}` : ''}
        requestType="Network Change Request"
        requestId={rejectTarget?.request_id || ''}
        recipientEmail={rejectTarget?.submitted_by || ''}
        recipientName={rejectTarget?.submitted_by_name || ''}
        onConfirm={handleReject}
        onClose={() => setRejectTarget(null)}
      />

      {/* ── Toast ── */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-20 right-4 px-4 py-2.5 rounded-lg shadow-lg text-white text-sm z-[1500]"
          style={{
            background: toast.type === 'success' ? '#16a34a'
                      : toast.type === 'error'   ? '#dc2626'
                      : '#2563eb',
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Child components
// ═══════════════════════════════════════════════════════════════════════════

function LoadingState({ label }) {
  return (
    <div className="p-10 text-center">
      <Loader2 size={28} className="mx-auto mb-3 text-surface-400 animate-spin" aria-hidden="true" />
      <p className="text-surface-500 text-sm">{label}</p>
    </div>
  )
}

function InfoCard({ title, subtitle, body, bg, color }) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{ background: bg, borderColor: color + '33' }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>{title}</p>
      <p className="text-sm font-semibold text-surface-800 mt-1">{subtitle}</p>
      <p className="text-xs text-surface-600 mt-0.5 font-mono">{body}</p>
    </div>
  )
}

function SubnetCard({ subnet, active, onClick }) {
  const pct = Math.round(((subnet.assigned + subnet.reserved) / 254) * 100)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${subnet.name} — ${subnet.assigned} assigned, ${subnet.available} available`}
      className={`text-left rounded-xl border p-3 transition-all
        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        active
          ? 'bg-brand-50 border-brand-300 shadow-sm'
          : 'bg-white border-surface-200 hover:border-brand-200'
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">{subnet.shortLabel}</p>
      <p className="text-lg font-bold text-surface-900 mt-1">{subnet.assigned}<span className="text-xs font-normal text-surface-400"> / 254</span></p>
      <div className="h-1 bg-surface-100 rounded-full mt-2 overflow-hidden" aria-hidden="true">
        <div className="h-full bg-brand-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-surface-500 mt-1">
        {subnet.available} available · {subnet.reserved} reserved
      </p>
    </button>
  )
}

function PendingCard({ count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-3 transition-all
        focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
        count > 0
          ? 'bg-amber-50 border-amber-300 hover:shadow-sm'
          : 'bg-white border-surface-200'
      }`}
      aria-label={`${count} pending change requests`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">Pending Changes</p>
      <div className="flex items-center gap-2 mt-1">
        <Inbox size={18} className={count > 0 ? 'text-amber-700' : 'text-surface-300'} aria-hidden="true" />
        <p className="text-lg font-bold text-surface-900">{count}</p>
      </div>
      <p className="text-[11px] text-surface-500 mt-1">
        {count === 0 ? 'All caught up' : 'Awaiting review'}
      </p>
    </button>
  )
}

// ── Table row ──────────────────────────────────────────────────────────────
function NetworkRow({
  row, zebra, showSubnetTag, effectiveDeviceName, assetById,
  canEdit, canDelete, canSuggest, onEdit, onDelete, onSuggest, onAdd, onHistory,
}) {
  const navigate = useNavigate()
  const { ip, device, pending, isReserved, isGateway, subnetId } = row
  const badge = statusBadge(isReserved, isGateway, !!device)
  const BadgeIcon = badge.icon
  const hasDevice = !!device
  const hasPending = pending.length > 0
  const liveName = device ? (effectiveDeviceName?.(device) || device.device_name || '') : ''
  const linkedAsset = device?.asset_id ? assetById?.get(device.asset_id) : null

  // Short subnet label (e.g. ".193.0") when shown
  const subnetShort = useMemo(() => {
    if (!subnetId) return ''
    const s = NETWORK_CONFIG.subnets.find(n => n.id === subnetId)
    return s?.shortLabel || subnetId
  }, [subnetId])

  // Styling: Do-Not-Use rows get a distinctive background, never color-only
  const rowBg = isGateway || isReserved
    ? 'bg-red-50 hover:bg-red-100'
    : zebra ? 'bg-surface-25 hover:bg-surface-50' : 'bg-white hover:bg-surface-50'

  return (
    <tr className={`${rowBg} transition-colors`} style={isReserved || isGateway ? { borderLeft: '3px solid #dc2626' } : undefined}>
      <td className="px-3 py-2 font-mono text-xs text-surface-700">
        <div className="flex items-center gap-2">
          {showSubnetTag && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide bg-brand-100 text-brand-700"
              aria-label={`Subnet ${subnetShort}`}
              title={`Subnet ${subnetShort}`}
            >
              {subnetShort}
            </span>
          )}
          <span>{ip}</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
          style={{ background: badge.bg, color: badge.color }}
          aria-label={`Status: ${badge.label}`}
        >
          {BadgeIcon && <BadgeIcon size={10} aria-hidden="true" />}
          {badge.label}
        </span>
        {hasPending && (
          <span
            className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-800"
            title={`${pending.length} pending change request${pending.length !== 1 ? 's' : ''}`}
          >
            <Clock size={9} aria-hidden="true" /> {pending.length}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-surface-700">
        {liveName ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span>{liveName}</span>
            {linkedAsset && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); navigate(`/assets?focus=${linkedAsset.asset_id}`) }}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold
                  bg-purple-50 text-purple-700 border border-purple-200
                  hover:bg-purple-100 hover:border-purple-300
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                title={`Linked to asset ${linkedAsset.asset_id} — click to open`}
                aria-label={`Linked asset ${linkedAsset.asset_id}, open on Assets page`}
              >
                <Link2 size={9} aria-hidden="true" />
                {linkedAsset.asset_id}
              </button>
            )}
          </div>
        ) : isReserved ? (
          <span className="italic text-red-700">Do not use</span>
        ) : (
          <span className="text-surface-300 italic">—</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-surface-600">{device?.mac_address || ''}</td>
      <td className="px-3 py-2 text-surface-600">{device?.profinet_name || (isGateway ? 'DHCP' : '')}</td>
      <td className="px-3 py-2 text-surface-600">{device?.location || ''}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <div className="flex justify-end gap-1">
          {hasDevice && (
            <button
              type="button"
              onClick={onHistory}
              className="p-1.5 rounded-md text-surface-400 hover:text-surface-700 hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`View history for ${ip}`}
              title="View change history"
            >
              <History size={14} aria-hidden="true" />
            </button>
          )}
          {canEdit && hasDevice && (
            <button
              type="button"
              onClick={onEdit}
              className="p-1.5 rounded-md text-brand-600 hover:bg-brand-50
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Edit ${ip}`}
              title="Edit device"
            >
              <Edit3 size={14} aria-hidden="true" />
            </button>
          )}
          {canDelete && hasDevice && !isGateway && (
            <button
              type="button"
              onClick={onDelete}
              className="p-1.5 rounded-md text-red-600 hover:bg-red-50
                focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              aria-label={`Delete ${ip}`}
              title="Delete device"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
          {/* Student/work-study: Suggest change */}
          {!canEdit && canSuggest && hasDevice && !isGateway && (
            <button
              type="button"
              onClick={() => onSuggest('edit')}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
                text-brand-700 bg-brand-50 hover:bg-brand-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Suggest change to ${ip}`}
            >
              <Send size={11} aria-hidden="true" /> Suggest
            </button>
          )}
          {/* Add for an empty non-reserved cell */}
          {canEdit && !hasDevice && !isReserved && !isGateway && (
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
                text-surface-600 bg-surface-50 hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Add device at ${ip}`}
            >
              <Plus size={11} aria-hidden="true" /> Add
            </button>
          )}
          {/* Student/work-study: Suggest add on empty cell */}
          {!canEdit && canSuggest && !hasDevice && !isReserved && !isGateway && (
            <button
              type="button"
              onClick={() => onSuggest('add')}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
                text-surface-600 bg-surface-50 hover:bg-surface-100
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Suggest adding a device at ${ip}`}
            >
              <Send size={11} aria-hidden="true" /> Suggest add
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Pending request card (in panel) ────────────────────────────────────────
function PendingRequestCard({ req, canApprove, isOwn, assetById, onApprove, onReject, onCancel }) {
  const [expanded, setExpanded] = useState(false)
  const diff = req.proposed_values || {}
  const current = req.current_values || {}
  const diffKeys = Object.keys(diff)

  // Render a value for display — if the field is asset_id, resolve to "name (id)"
  const displayValue = (field, val) => {
    const v = val ?? ''
    if (field === 'asset_id') {
      if (!v) return null
      const asset = assetById?.get(v)
      return asset ? `${asset.name} (${v})` : v
    }
    return v === '' ? null : String(v)
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-semibold text-surface-700">{req.request_id}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-100 text-surface-600">
              {req.change_type}
            </span>
            <span className="font-mono text-sm font-semibold text-brand-700">{req.ip_address}</span>
          </div>
          <p className="text-xs text-surface-600 mt-1">
            by <span className="font-medium">{req.submitted_by_name || req.submitted_by}</span>
            {' · '}{formatDate(req.submitted_date)}
          </p>
          {req.reason && (
            <p className="text-xs text-surface-700 mt-1 italic">"{req.reason}"</p>
          )}
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline mt-2
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? 'Hide' : 'Show'} changes
          </button>
          {expanded && (
            <div className="mt-2 p-2 bg-surface-50 rounded-lg border border-surface-200">
              {req.change_type === 'delete' ? (
                <p className="text-xs text-red-700">Request to remove this device entry.</p>
              ) : diffKeys.length === 0 ? (
                <p className="text-xs text-surface-500 italic">No field changes recorded.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-surface-500">
                      <th scope="col" className="text-left font-semibold py-1">Field</th>
                      <th scope="col" className="text-left font-semibold py-1">Current</th>
                      <th scope="col" className="text-left font-semibold py-1">Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffKeys.map(k => {
                      const curDisp = displayValue(k, current[k])
                      const newDisp = displayValue(k, diff[k])
                      return (
                        <tr key={k} className="border-t border-surface-100">
                          <td className="py-1 font-medium text-surface-600">{COLUMN_LABELS[k] || k}</td>
                          <td className="py-1 text-surface-500 font-mono">{curDisp ?? <em className="text-surface-300 not-italic">(empty)</em>}</td>
                          <td className="py-1 text-brand-700 font-mono font-semibold">{newDisp ?? <em className="text-surface-300 not-italic">(empty)</em>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {canApprove && (
            <>
              <button
                type="button"
                onClick={onApprove}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-green-600 text-white hover:bg-green-700
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
              >
                <CheckCircle2 size={12} aria-hidden="true" /> Approve
              </button>
              <button
                type="button"
                onClick={onReject}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-white border border-red-200 text-red-700 hover:bg-red-50
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <XCircle size={12} aria-hidden="true" /> Reject
              </button>
            </>
          )}
          {isOwn && !canApprove && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                bg-white border border-surface-200 text-surface-600 hover:bg-surface-50
                focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-500"
            >
              <X size={12} aria-hidden="true" /> Cancel
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════════════════

// Shared modal shell (focus trap + escape-to-close)
function ModalShell({ title, subtitle, onClose, children, icon: Icon, size = 'md' }) {
  const ref = useRef(null)
  const titleId = 'nm-modal-title'
  const descId = 'nm-modal-desc'

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const t = setTimeout(() => {
      const first = ref.current?.querySelector('input, textarea, select, button:not([aria-hidden="true"])')
      first?.focus()
    }, 40)

    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'Tab' && ref.current) {
        const els = ref.current.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (els.length === 0) return
        const first = els[0]
        const last = els[els.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('keydown', keyHandler)
      document.body.style.overflow = prevOverflow
      clearTimeout(t)
    }
  }, [onClose])

  const maxW = size === 'lg' ? 'max-w-3xl' : size === 'sm' ? 'max-w-sm' : 'max-w-xl'

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descId : undefined}
        className={`bg-white rounded-2xl w-full ${maxW} shadow-xl overflow-hidden max-h-[90vh] flex flex-col`}
      >
        <div className="px-5 py-3 border-b border-surface-200 flex items-start gap-3 bg-surface-50 flex-shrink-0">
          {Icon && <Icon size={18} className="text-brand-600 mt-0.5 flex-shrink-0" aria-hidden="true" />}
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-base font-bold text-surface-900">{title}</h2>
            {subtitle && <p id={descId} className="text-xs text-surface-500 mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-200 hover:text-surface-700
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Close dialog"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

// ── Device form modal (Add + Edit for instructors) ────────────────────────
// ── Asset Picker (searchable combobox) ─────────────────────────────────────
// Shows active assets. Excludes assets already linked to OTHER devices.
// Fully keyboard-accessible: ArrowUp/Down + Enter to select, Escape to close.
function AssetPicker({
  value,              // currently selected asset_id (string or '')
  onChange,           // (asset_id | '') => void
  activeAssets,       // [{asset_id, name, status}]
  linkedAssetIds,     // Set<asset_id> of assets linked to OTHER devices
  currentDeviceId,    // device being edited (so its linked asset is still selectable)
  currentAssetId,     // same as `value` but pre-edit (for exclude logic)
  label = 'Linked Asset',
  help = 'Optional. When linked, the device name is synced from the asset.',
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const containerRef = useRef(null)

  // Assets eligible for selection: active, minus those linked to other devices
  const eligible = useMemo(() => {
    return activeAssets.filter(a => {
      if (!linkedAssetIds) return true
      // Always include the asset currently linked to THIS device (editing it should still show)
      if (currentAssetId && a.asset_id === currentAssetId) return true
      return !linkedAssetIds.has(a.asset_id)
    })
  }, [activeAssets, linkedAssetIds, currentAssetId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return eligible
    return eligible.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.asset_id || '').toLowerCase().includes(q)
    )
  }, [eligible, query])

  const selected = value ? activeAssets.find(a => a.asset_id === value) : null

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Reset activeIdx when filter changes
  useEffect(() => { setActiveIdx(0) }, [query])

  const handleSelect = (assetId) => {
    onChange(assetId || '')
    setOpen(false)
    setQuery('')
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActiveIdx(i => Math.min(i + 1, filtered.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      // Index 0 = "None"; others are filtered[activeIdx - 1]
      if (activeIdx === 0) handleSelect('')
      else {
        const picked = filtered[activeIdx - 1]
        if (picked) handleSelect(picked.asset_id)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const inputId = 'asset-picker-input'

  return (
    <div ref={containerRef}>
      <label htmlFor={inputId} className="block text-xs font-semibold text-surface-600 mb-1">
        {label}
      </label>
      <div className="relative">
        <div
          className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg bg-white
            focus-within:ring-2 focus-within:ring-brand-500 focus-within:border-transparent
            flex items-center gap-2 min-h-[38px]"
        >
          <Link2 size={14} className="text-surface-400 flex-shrink-0" aria-hidden="true" />
          {selected && !open ? (
            <>
              <span className="flex-1 truncate">
                <span className="font-medium">{selected.name}</span>
                <span className="ml-1.5 text-xs text-surface-400 font-mono">({selected.asset_id})</span>
              </span>
              <button
                type="button"
                onClick={() => onChange('')}
                className="p-0.5 rounded text-surface-400 hover:text-red-600 hover:bg-red-50
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                aria-label="Unlink asset"
                title="Unlink asset"
              >
                <X size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 10) }}
                className="text-xs text-brand-600 hover:text-brand-700 hover:underline
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded px-1"
              >
                Change
              </button>
            </>
          ) : (
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls="asset-picker-listbox"
              aria-activedescendant={open ? `asset-option-${activeIdx}` : undefined}
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true) }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder={selected ? selected.name : 'Type to search active assets…'}
              className="flex-1 text-sm outline-none border-0 bg-transparent"
            />
          )}
        </div>

        {open && (
          <ul
            ref={listRef}
            role="listbox"
            id="asset-picker-listbox"
            className="absolute z-20 mt-1 w-full max-h-64 overflow-auto bg-white border border-surface-200 rounded-lg shadow-lg"
          >
            <li
              id="asset-option-0"
              role="option"
              aria-selected={!value && activeIdx === 0}
              onClick={() => handleSelect('')}
              onMouseEnter={() => setActiveIdx(0)}
              className={`px-3 py-2 text-sm cursor-pointer border-b border-surface-100
                ${activeIdx === 0 ? 'bg-brand-50' : 'hover:bg-surface-50'}`}
            >
              <span className="italic text-surface-500">(None — use free-text device name)</span>
            </li>
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-surface-400 italic">
                No matching active assets. Try a different search, or leave unlinked.
              </li>
            ) : (
              filtered.map((a, idx) => {
                const isActive = idx + 1 === activeIdx
                const isSelected = a.asset_id === value
                return (
                  <li
                    key={a.asset_id}
                    id={`asset-option-${idx + 1}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(a.asset_id)}
                    onMouseEnter={() => setActiveIdx(idx + 1)}
                    className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2
                      ${isActive ? 'bg-brand-50' : 'hover:bg-surface-50'}
                      ${isSelected ? 'font-semibold' : ''}`}
                  >
                    <span className="flex-1 truncate">{a.name}</span>
                    <span className="text-xs text-surface-400 font-mono flex-shrink-0">{a.asset_id}</span>
                    {isSelected && <CheckCircle2 size={12} className="text-brand-600 flex-shrink-0" aria-hidden="true" />}
                  </li>
                )
              })
            )}
          </ul>
        )}
      </div>
      {help && <p className="text-[11px] text-surface-400 mt-1">{help}</p>}
    </div>
  )
}

function DeviceFormModal({ mode, initial, subnetId, fixedIp, initialOctet, takenOctets, findDuplicateMac, activeAssets, linkedAssetIds, onCancel, onSubmit }) {
  const subnet = NETWORK_CONFIG.subnets.find(s => s.id === subnetId)
  const [octet, setOctet] = useState(() => {
    if (fixedIp) return parseInt(fixedIp.split('.')[3], 10)
    if (initialOctet) return initialOctet
    return ''
  })
  const [form, setForm] = useState({
    device_name: initial?.device_name || '',
    mac_address: initial?.mac_address || '',
    profinet_name: initial?.profinet_name || '',
    location: initial?.location || '',
    notes: initial?.notes || '',
    is_reserved: !!initial?.is_reserved,
    asset_id: initial?.asset_id || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const ip = fixedIp || (octet ? `${subnet?.prefix || ''}${octet}` : '')
  const macInvalid = form.mac_address && !isValidMac(form.mac_address)
  const duplicate = form.mac_address && isValidMac(form.mac_address)
    ? findDuplicateMac(form.mac_address, initial?.device_id)
    : null

  const handleChange = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async () => {
    setError('')
    if (!ip) { setError('IP is required.'); return }
    if (macInvalid) { setError('MAC address is not in a valid format (XX-XX-XX-XX-XX-XX).'); return }
    if (mode === 'add') {
      if (!octet) { setError('Please select a last octet.'); return }
      if (takenOctets?.has(parseInt(octet, 10))) { setError('That IP is already assigned.'); return }
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        ip_address: ip,
        mac_address: form.mac_address ? normaliseMac(form.mac_address) : '',
      }
      await onSubmit(payload)
    } catch (e) {
      setError(e.message || 'Save failed.')
      setSaving(false)
    }
  }

  const availableOctets = useMemo(() => {
    if (mode !== 'add') return []
    const out = []
    for (let o = 1; o <= 254; o++) {
      if (takenOctets?.has(o)) continue
      out.push(o)
    }
    return out
  }, [mode, takenOctets])

  return (
    <ModalShell
      title={mode === 'add' ? 'Add Network Device' : `Edit ${ip}`}
      subtitle={mode === 'add' ? `Subnet ${subnet?.name || ''}` : 'Change device details'}
      icon={mode === 'add' ? Plus : Edit3}
      onClose={onCancel}
    >
      <div className="p-5 space-y-4">
        {/* IP / Octet */}
        <div>
          <label className="block text-xs font-semibold text-surface-600 mb-1">IP Address</label>
          {mode === 'edit' ? (
            <p className="font-mono text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2">
              {ip}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-surface-600">{subnet?.prefix}</span>
              <select
                value={octet}
                onChange={(e) => setOctet(e.target.value ? parseInt(e.target.value, 10) : '')}
                className="px-3 py-2 text-sm border border-surface-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-brand-500"
                aria-label="Last octet"
              >
                <option value="">Select last octet…</option>
                {availableOctets.map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <AssetPicker
          value={form.asset_id}
          onChange={(assetId) => {
            // When linking, pre-fill device_name from the selected asset
            if (assetId) {
              const picked = activeAssets?.find(a => a.asset_id === assetId)
              setForm(f => ({ ...f, asset_id: assetId, device_name: picked?.name || f.device_name }))
            } else {
              setForm(f => ({ ...f, asset_id: '' }))
            }
          }}
          activeAssets={activeAssets || []}
          linkedAssetIds={linkedAssetIds}
          currentDeviceId={initial?.device_id}
          currentAssetId={initial?.asset_id}
        />

        {form.asset_id ? (
          <div>
            <label className="block text-xs font-semibold text-surface-600 mb-1">Device Name</label>
            <div className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg bg-surface-50 text-surface-600 flex items-center gap-2">
              <Link2 size={14} className="text-purple-500 flex-shrink-0" aria-hidden="true" />
              <span className="flex-1">{form.device_name || '(asset has no name)'}</span>
              <span className="text-[10px] uppercase tracking-wide font-semibold text-purple-600">Synced</span>
            </div>
            <p className="text-[11px] text-surface-400 mt-1">Name is synced from the linked asset. Unlink above to use a custom name.</p>
          </div>
        ) : (
          <FormField label="Device Name" value={form.device_name} onChange={handleChange('device_name')} placeholder="e.g. Bench #3 — 1500 PLC" />
        )}
        <FormField
          label="MAC Address"
          value={form.mac_address}
          onChange={handleChange('mac_address')}
          placeholder="XX-XX-XX-XX-XX-XX"
          monospace
          invalid={macInvalid}
          help={macInvalid ? 'Format must be six pairs of hex separated by - or :' : 'Optional. Auto-uppercased on save.'}
        />
        {duplicate && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200" role="alert">
            <AlertTriangle size={14} className="text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p className="text-xs text-amber-800">
              This MAC is already assigned to <span className="font-semibold">{duplicate.device_name || '(unnamed)'}</span> at <span className="font-mono">{duplicate.ip_address}</span>. Save anyway if this is intentional.
            </p>
          </div>
        )}
        <FormField label="Profinet Name" value={form.profinet_name} onChange={handleChange('profinet_name')} placeholder="e.g. PLC_Bench_3" monospace />
        <FormField label="Location" value={form.location} onChange={handleChange('location')} placeholder="e.g. Lab A, Rack 2" />
        <FormField label="Notes" value={form.notes} onChange={handleChange('notes')} multiline placeholder="Optional notes…" />

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="nm-reserved"
            checked={form.is_reserved}
            onChange={(e) => setForm(f => ({ ...f, is_reserved: e.target.checked }))}
            className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
          />
          <label htmlFor="nm-reserved" className="text-xs text-surface-600">
            Mark as reserved / Do Not Use
          </label>
        </div>

        {error && (
          <div role="alert" className="p-2.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 flex justify-end gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg
            hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg
            hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
            disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Saving…</> : (mode === 'add' ? 'Add Device' : 'Save Changes')}
        </button>
      </div>
    </ModalShell>
  )
}

function FormField({ label, value, onChange, placeholder, multiline, monospace, invalid, help }) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-surface-600 mb-1">{label}</label>
      <Tag
        id={id}
        value={value || ''}
        onChange={onChange}
        placeholder={placeholder}
        rows={multiline ? 3 : undefined}
        aria-invalid={!!invalid}
        aria-describedby={help ? `${id}-help` : undefined}
        className={`w-full px-3 py-2 text-sm border rounded-lg resize-none transition-colors
          focus:outline-none focus:ring-2 focus:border-transparent
          ${monospace ? 'font-mono' : ''}
          ${invalid ? 'border-red-300 focus:ring-red-500' : 'border-surface-200 focus:ring-brand-500'}`}
      />
      {help && <p id={`${id}-help`} className={`text-[11px] mt-1 ${invalid ? 'text-red-600' : 'text-surface-400'}`}>{help}</p>}
    </div>
  )
}

// ── Suggest Change modal (students / work study) ───────────────────────────
function SuggestChangeModal({ target, activeAssets, linkedAssetIds, assetById, effectiveDeviceName, onCancel, onSubmit }) {
  const { device, ip, subnet, mode } = target
  const changeType = device ? 'edit' : 'add'
  const [form, setForm] = useState({
    device_name: device?.device_name || '',
    mac_address: device?.mac_address || '',
    profinet_name: device?.profinet_name || '',
    location: device?.location || '',
    notes: device?.notes || '',
    asset_id: device?.asset_id || '',
  })
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const macInvalid = form.mac_address && !isValidMac(form.mac_address)

  const handleChange = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async () => {
    setError('')
    if (reason.trim().length < 5) { setError('Please provide a reason (at least 5 characters).'); return }
    if (macInvalid) { setError('MAC address is not in a valid format.'); return }
    setSaving(true)
    try {
      const currentValues = {
        device_name: device?.device_name || '',
        mac_address: device?.mac_address || '',
        profinet_name: device?.profinet_name || '',
        location: device?.location || '',
        notes: device?.notes || '',
        asset_id: device?.asset_id || '',
      }
      const proposedValues = {
        device_name: form.device_name || '',
        mac_address: form.mac_address ? normaliseMac(form.mac_address) : '',
        profinet_name: form.profinet_name || '',
        location: form.location || '',
        notes: form.notes || '',
        asset_id: form.asset_id || '',
      }
      await onSubmit({ changeType, currentValues, proposedValues, reason })
    } catch (e) {
      setError(e.message || 'Submit failed.')
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title={`Suggest ${changeType === 'add' ? 'New Device' : 'Change'} for ${ip}`}
      subtitle="An instructor will review your request before it is applied."
      icon={Send}
      onClose={onCancel}
      size="lg"
    >
      <div className="p-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Current */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-2">Current</p>
            <div className="space-y-2 text-sm">
              <ReadOnlyRow label="Device" value={device ? (effectiveDeviceName?.(device) || device.device_name) : ''} />
              <ReadOnlyRow
                label="Linked Asset"
                value={device?.asset_id ? `${assetById?.get(device.asset_id)?.name || '(unknown)'} (${device.asset_id})` : ''}
              />
              <ReadOnlyRow label="MAC" value={device?.mac_address} mono />
              <ReadOnlyRow label="Profinet" value={device?.profinet_name} mono />
              <ReadOnlyRow label="Location" value={device?.location} />
              <ReadOnlyRow label="Notes" value={device?.notes} />
            </div>
          </div>
          {/* Proposed */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-brand-700 mb-2">Proposed</p>
            <div className="space-y-2">
              <AssetPicker
                value={form.asset_id}
                onChange={(assetId) => {
                  if (assetId) {
                    const picked = activeAssets?.find(a => a.asset_id === assetId)
                    setForm(f => ({ ...f, asset_id: assetId, device_name: picked?.name || f.device_name }))
                  } else {
                    setForm(f => ({ ...f, asset_id: '' }))
                  }
                }}
                activeAssets={activeAssets || []}
                linkedAssetIds={linkedAssetIds}
                currentDeviceId={device?.device_id}
                currentAssetId={device?.asset_id}
                help="Link to an active asset so the device name stays in sync."
              />
              {form.asset_id ? (
                <div>
                  <label className="block text-xs font-semibold text-surface-600 mb-1">Device Name</label>
                  <div className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg bg-surface-50 text-surface-600 flex items-center gap-2">
                    <Link2 size={14} className="text-purple-500 flex-shrink-0" aria-hidden="true" />
                    <span className="flex-1">{form.device_name || '(asset has no name)'}</span>
                    <span className="text-[10px] uppercase tracking-wide font-semibold text-purple-600">Synced</span>
                  </div>
                </div>
              ) : (
                <FormField label="Device Name" value={form.device_name} onChange={handleChange('device_name')} placeholder="e.g. Bench #3 PLC" />
              )}
              <FormField label="MAC Address" value={form.mac_address} onChange={handleChange('mac_address')} placeholder="XX-XX-XX-XX-XX-XX" monospace invalid={macInvalid} />
              <FormField label="Profinet Name" value={form.profinet_name} onChange={handleChange('profinet_name')} monospace />
              <FormField label="Location" value={form.location} onChange={handleChange('location')} />
              <FormField label="Notes" value={form.notes} onChange={handleChange('notes')} multiline />
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="nm-reason" className="block text-xs font-semibold text-surface-600 mb-1">
            Reason for change <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <textarea
            id="nm-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Explain why this change should be made (e.g., Bench was rewired, MAC pulled from device label)"
            className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg resize-none
              focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-required="true"
          />
          <p className="text-[11px] text-surface-400 mt-1">
            {reason.trim().length < 5 ? `${5 - reason.trim().length} more character${5 - reason.trim().length !== 1 ? 's' : ''} needed` : `${reason.trim().length} characters`}
          </p>
        </div>

        {error && (
          <div role="alert" className="p-2.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 flex justify-end gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg
            hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg
            hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
            disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Sending…</> : <><Send size={14} aria-hidden="true" /> Submit for Review</>}
        </button>
      </div>
    </ModalShell>
  )
}

function ReadOnlyRow({ label, value, mono }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-surface-400 font-medium">{label}</p>
      <p className={`text-sm text-surface-700 ${mono ? 'font-mono' : ''} ${!value ? 'italic text-surface-300' : ''}`}>
        {value || '—'}
      </p>
    </div>
  )
}

// ── Confirm delete ─────────────────────────────────────────────────────────
function ConfirmDeleteModal({ device, onCancel, onConfirm }) {
  const [saving, setSaving] = useState(false)
  const handleConfirm = async () => {
    setSaving(true)
    try { await onConfirm() } catch { setSaving(false) }
  }
  return (
    <ModalShell
      title="Delete Network Device"
      subtitle={`${device.ip_address} — ${device.device_name || '(no name)'}`}
      icon={Trash2}
      onClose={onCancel}
      size="sm"
    >
      <div className="p-5">
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
          <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="text-sm text-red-900">
            This will permanently remove the device assignment for <span className="font-mono font-semibold">{device.ip_address}</span>.
            The IP will become available again.
          </div>
        </div>
      </div>
      <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving}
          className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg hover:bg-surface-100">
          Cancel
        </button>
        <button type="button" onClick={handleConfirm} disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
          {saving ? 'Deleting…' : 'Delete Device'}
        </button>
      </div>
    </ModalShell>
  )
}

// ── Approve change modal ───────────────────────────────────────────────────
function ApproveChangeModal({ req, device, assetById, onCancel, onConfirm }) {
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setError('')
    setSaving(true)
    try { await onConfirm(notes) }
    catch (e) { setError(e.message); setSaving(false) }
  }

  const diff = req.proposed_values || {}
  const current = req.current_values || {}
  const keys = Object.keys(diff)

  const displayValue = (field, val) => {
    const v = val ?? ''
    if (field === 'asset_id') {
      if (!v) return null
      const asset = assetById?.get(v)
      return asset ? `${asset.name} (${v})` : v
    }
    return v === '' ? null : String(v)
  }

  return (
    <ModalShell
      title={`Approve ${req.request_id}`}
      subtitle={`${req.change_type.toUpperCase()} for ${req.ip_address}`}
      icon={CheckCircle2}
      onClose={onCancel}
      size="lg"
    >
      <div className="p-5 space-y-4">
        <div>
          <p className="text-xs text-surface-500 mb-1">Requested by <span className="font-medium text-surface-700">{req.submitted_by_name || req.submitted_by}</span> — {formatDate(req.submitted_date)}</p>
          {req.reason && <p className="text-sm italic text-surface-700">"{req.reason}"</p>}
        </div>

        {req.change_type === 'delete' ? (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-900">
            Approving will <strong>remove</strong> the device entry at <span className="font-mono font-semibold">{req.ip_address}</span>.
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-surface-500 italic">No field changes recorded in this request.</p>
        ) : (
          <div className="border border-surface-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-50">
                <tr>
                  <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wider">Field</th>
                  <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-surface-600 uppercase tracking-wider">Current</th>
                  <th scope="col" className="text-left px-3 py-2 text-xs font-semibold text-brand-700 uppercase tracking-wider">Proposed</th>
                </tr>
              </thead>
              <tbody>
                {keys.map(k => {
                  const curDisp = displayValue(k, current[k])
                  const newDisp = displayValue(k, diff[k])
                  return (
                    <tr key={k} className="border-t border-surface-100">
                      <td className="px-3 py-2 font-medium text-surface-700">{COLUMN_LABELS[k] || k}</td>
                      <td className="px-3 py-2 text-surface-500 font-mono">{curDisp ?? <em className="text-surface-300 not-italic">(empty)</em>}</td>
                      <td className="px-3 py-2 text-brand-700 font-mono font-semibold">{newDisp ?? <em className="text-surface-300 not-italic">(empty)</em>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <label htmlFor="nm-review-notes" className="block text-xs font-semibold text-surface-600 mb-1">Notes (optional)</label>
          <textarea
            id="nm-review-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes about this approval"
            className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg resize-none
              focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {error && (
          <div role="alert" className="p-2.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}
      </div>
      <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 flex justify-end gap-2 flex-shrink-0">
        <button type="button" onClick={onCancel} disabled={saving}
          className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg hover:bg-surface-100">
          Cancel
        </button>
        <button type="button" onClick={handleConfirm} disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2">
          {saving ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Approving…</> : <><CheckCircle2 size={14} aria-hidden="true" /> Approve &amp; Apply</>}
        </button>
      </div>
    </ModalShell>
  )
}

// ── Device history modal ──────────────────────────────────────────────────
function DeviceHistoryModal({ device, changeRequests, onClose }) {
  // Pull audit_log + change requests filtered by this device
  const [auditRows, setAuditRows] = useState([])
  const [loadingAudit, setLoadingAudit] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { supabase } = await import('@/lib/supabase')
        const { data } = await supabase
          .from('audit_log')
          .select('*')
          .eq('entity_type', 'Network Device')
          .eq('entity_id', device.device_id)
          .order('timestamp', { ascending: false })
          .limit(50)
        if (!cancelled) setAuditRows(data || [])
      } finally {
        if (!cancelled) setLoadingAudit(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [device.device_id])

  const deviceChanges = useMemo(() =>
    changeRequests.filter(r => r.device_id === device.device_id || r.ip_address === device.ip_address)
                  .sort((a, b) => new Date(b.submitted_date) - new Date(a.submitted_date)),
    [changeRequests, device]
  )

  return (
    <ModalShell
      title={`History — ${device.ip_address}`}
      subtitle={device.device_name || '(no name)'}
      icon={History}
      onClose={onClose}
      size="lg"
    >
      <div className="p-5 space-y-4">
        {/* Change requests */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-2">Change Requests ({deviceChanges.length})</h3>
          {deviceChanges.length === 0 ? (
            <p className="text-sm text-surface-400 italic">No change requests for this device.</p>
          ) : (
            <ul className="space-y-2">
              {deviceChanges.map(r => (
                <li key={r.request_id} className="border border-surface-200 rounded-lg p-2.5 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-semibold">{r.request_id}</span>
                    <StatusPill status={r.status} />
                    <span className="text-surface-500">{r.change_type}</span>
                    <span className="text-surface-400 ml-auto">{formatDate(r.submitted_date)}</span>
                  </div>
                  <p className="mt-1 text-surface-600">{r.submitted_by_name || r.submitted_by} — "{r.reason}"</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Audit log */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-2">Audit Log ({auditRows.length})</h3>
          {loadingAudit ? (
            <p className="text-sm text-surface-400">Loading…</p>
          ) : auditRows.length === 0 ? (
            <p className="text-sm text-surface-400 italic">No audit entries recorded.</p>
          ) : (
            <ul className="space-y-1.5">
              {auditRows.map(a => (
                <li key={a.log_id} className="text-xs border-l-2 border-surface-200 pl-3 py-1">
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="font-semibold text-surface-700">{a.action}</span>
                    <span className="text-surface-500">by {a.user_name || a.user_email}</span>
                    <span className="text-surface-400 ml-auto">{formatDate(a.timestamp)}</span>
                  </div>
                  {a.details && <p className="text-surface-500 mt-0.5">{a.details}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 flex justify-end flex-shrink-0">
        <button type="button" onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg hover:bg-surface-100">
          Close
        </button>
      </div>
    </ModalShell>
  )
}

function StatusPill({ status }) {
  const styles = {
    Pending:   { bg: '#fff3bf', color: '#92400e' },
    Approved:  { bg: '#d1fae5', color: '#065f46' },
    Rejected:  { bg: '#fee2e2', color: '#991b1b' },
    Cancelled: { bg: '#e5e7eb', color: '#6b7280' },
  }
  const s = styles[status] || styles.Cancelled
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: s.bg, color: s.color }}>
      {status}
    </span>
  )
}
