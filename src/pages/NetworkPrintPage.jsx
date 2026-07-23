/**
 * RICT CMMS — Network Map Print Page
 *
 * 11×17 PORTRAIT print-optimized view for the RICT lab network.
 * Each /24 subnet is split into FOUR pages of ~64 IPs in a single column,
 * matching the original Excel printing layout used for wall postings.
 *
 * Layout:
 *   • 3 subnets × 4 pages = 12 pages total
 *   • One page per ~64 contiguous IPs (.1–.64, .65–.128, .129–.192, .193–.254)
 *   • Header repeats on every page so wall-mounted sheets are self-explanatory
 *   • Single-column table for maximum row height and readability
 *
 * How to print at 11×17:
 *   - Open this page (/network-map/print)
 *   - Ctrl-P (or Cmd-P on Mac)
 *   - Paper size: Tabloid (11 × 17 in)
 *   - Layout: Portrait
 *   - Margins: Default (or "None")
 *   - Background graphics: ON (so the "Do Not Use" shading prints)
 *   - Headers and footers: OFF (keeps framed sheets clean)
 *
 * Row sizing note: 64 rows + repeating header must fit one 17in sheet.
 * line-height 1.2 + 3px cell padding ≈ 20px/row → ~14.9in total, leaving
 * >1in of slack inside the 16.2in printable area. If rows are ever added
 * per page or padding increased, re-check that a page still fits one sheet.
 *
 * WCAG 2.1 AA: semantic table per page, ≥ 4.5:1 contrast,
 * non-color-only "Do Not Use" indicator, h1 per page. Stale-sheet banner
 * uses role="status" + aria-live; confirm modal uses useDialogA11y.
 *
 * Stale-sheet tracking: reads network_print_status (flagged by DB triggers
 * on network_devices / assets). Screen-only banner lists outdated sheets
 * with their PDF sheet numbers; after printing (or via the manual button),
 * users with the 'print_map' permission can mark sheets printed, which
 * stamps last_printed_at/by and clears the flags.
 *
 * File: src/pages/NetworkPrintPage.jsx
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { NETWORK_CONFIG, isDoNotUseIp } from '@/lib/networkConfig'
import { Printer, ArrowLeft, Loader2, AlertTriangle, CheckCircle2, X } from 'lucide-react'

const GATEWAY = NETWORK_CONFIG.gateway
const PAGES_PER_SUBNET = 4
const ROWS_PER_PAGE = Math.ceil(254 / PAGES_PER_SUBNET) // 64

export default function NetworkPrintPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Network Map')
  const [devices, setDevices] = useState([])
  const [assets, setAssets] = useState([])
  const [printStatus, setPrintStatus] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [printedAt] = useState(() => new Date())
  const [showConfirm, setShowConfirm] = useState(false)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState(null)
  const [justMarked, setJustMarked] = useState(false)

  // Whoever can print can mark sheets as printed (decision: same permission).
  const canMarkPrinted = hasPerm('print_map')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [devRes, assetRes, printRes] = await Promise.all([
          supabase.from('network_devices').select('*').order('ip_address', { ascending: true }),
          supabase.from('assets').select('asset_id, name, status').eq('status', 'Active'),
          supabase.from('network_print_status').select('*').order('sheet_index', { ascending: true }),
        ])
        if (cancelled) return
        if (devRes.error) { setError(devRes.error.message); return }
        if (assetRes.error) { setError(assetRes.error.message); return }
        if (printRes.error) { setError(printRes.error.message); return }
        setDevices(devRes.data || [])
        setAssets(assetRes.data || [])
        setPrintStatus(printRes.data || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // ── Stale sheet tracking ──────────────────────────────────────────────
  // A sheet is stale when it changed after it was last printed.
  const staleSheets = useMemo(() =>
    printStatus
      .filter(s =>
        s.last_changed_at &&
        (!s.last_printed_at || new Date(s.last_changed_at) > new Date(s.last_printed_at))
      )
      .sort((a, b) => (a.sheet_index || 0) - (b.sheet_index || 0)),
    [printStatus]
  )

  const staleIndexSet = useMemo(
    () => new Set(staleSheets.map(s => s.sheet_index)),
    [staleSheets]
  )

  // "2, 5, 9" — paste straight into the browser Pages field to print only
  // the outdated sheets.
  const pagesFieldValue = useMemo(
    () => staleSheets.map(s => s.sheet_index).join(', '),
    [staleSheets]
  )

  // Most recent print stamp across all sheets (shown when nothing is stale)
  const lastPrintedInfo = useMemo(() => {
    let best = null
    printStatus.forEach(s => {
      if (s.last_printed_at && (!best || new Date(s.last_printed_at) > new Date(best.last_printed_at))) {
        best = s
      }
    })
    return best
  }, [printStatus])

  const actorName = useCallback(() => {
    if (!profile) return 'Unknown'
    const first = profile.first_name || ''
    const lastInitial = (profile.last_name || '').charAt(0)
    return lastInitial ? `${first} ${lastInitial}.` : first || profile.email || 'Unknown'
  }, [profile])

  // Mark the currently-stale sheets as printed. .select() row-count guard
  // catches silent RLS blocks.
  const markAllPrinted = useCallback(async () => {
    const ids = staleSheets.map(s => s.sheet_id)
    if (ids.length === 0) return
    setMarking(true)
    setMarkError(null)
    try {
      const { data, error: upErr } = await supabase
        .from('network_print_status')
        .update({
          last_printed_at: new Date().toISOString(),
          last_printed_by: actorName(),
        })
        .in('sheet_id', ids)
        .select()
      if (upErr) throw new Error(upErr.message)
      if (!data || data.length !== ids.length) {
        throw new Error(`Updated ${data?.length || 0} of ${ids.length} sheets — check permissions.`)
      }
      // Merge updated rows into local state
      setPrintStatus(prev => {
        const byId = new Map(prev.map(s => [s.sheet_id, s]))
        data.forEach(s => byId.set(s.sheet_id, s))
        return Array.from(byId.values()).sort((a, b) => (a.sheet_index || 0) - (b.sheet_index || 0))
      })
      // Audit — non-critical
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email || '',
          user_name: `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim(),
          action: 'Mark Printed',
          entity_type: 'Network Print Sheet',
          entity_id: ids.join(', '),
          details: `Marked ${ids.length} wall sheet${ids.length === 1 ? '' : 's'} as printed`,
        })
      } catch (auditErr) {
        console.warn('[NetworkPrintPage] Audit log write failed:', auditErr.message)
      }
      setShowConfirm(false)
      setJustMarked(true)
      setTimeout(() => setJustMarked(false), 4000)
    } catch (e) {
      setMarkError(e.message)
    } finally {
      setMarking(false)
    }
  }, [staleSheets, profile, actorName])

  // Print, then (if permitted and sheets were stale) offer to clear the flags.
  // window.print() blocks until the browser dialog closes; we can't know
  // whether the user actually printed, so we ask instead of assuming.
  const handlePrint = useCallback(() => {
    const hadStale = staleSheets.length > 0
    window.print()
    if (hadStale && canMarkPrinted) setShowConfirm(true)
  }, [staleSheets, canMarkPrinted])

  // Effective name resolver — if a device is linked to an active asset,
  // use the asset's current name; otherwise use the device_name snapshot.
  const assetById = useMemo(() => {
    const m = new Map()
    assets.forEach(a => m.set(a.asset_id, a))
    return m
  }, [assets])

  const effectiveDeviceName = (d) => {
    if (!d) return ''
    if (d.asset_id) {
      const a = assetById.get(d.asset_id)
      if (a?.name) return a.name
    }
    return d.device_name || ''
  }

  // Build the flat page list: 3 subnets × 4 chunks = 12 pages
  const allPages = useMemo(() => {
    // One-pass lookup map — avoids devices.find() scanning the whole
    // list for each of the 762 IPs (O(n) per IP → O(1) per IP).
    const deviceByIp = new Map()
    devices.forEach(d => deviceByIp.set(d.ip_address, d))

    const out = []
    NETWORK_CONFIG.subnets.forEach(subnet => {
      // Build 254 rows for this subnet
      const subnetRows = []
      for (let octet = 1; octet <= 254; octet++) {
        const ip = `${subnet.prefix}${octet}`
        const device = deviceByIp.get(ip) || null
        subnetRows.push({
          ip, octet, device,
          isReserved: device?.is_reserved || isDoNotUseIp(ip),
          isGateway: ip === GATEWAY,
        })
      }
      // Split into 4 pages
      for (let p = 0; p < PAGES_PER_SUBNET; p++) {
        const start = p * ROWS_PER_PAGE
        const end = Math.min(start + ROWS_PER_PAGE, subnetRows.length)
        const slice = subnetRows.slice(start, end)
        if (slice.length === 0) continue
        out.push({
          subnet,
          pageNumber: p + 1,
          totalPages: PAGES_PER_SUBNET,
          rows: slice,
          startIp: slice[0].ip,
          endIp: slice[slice.length - 1].ip,
        })
      }
    })
    return out
  }, [devices])

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Loader2 size={28} className="animate-spin" aria-hidden="true" style={{ color: '#6b7280' }} />
        <p style={{ marginTop: 8, color: '#6b7280' }}>Loading network map…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#991b1b' }} role="alert">
        Failed to load: {error}
      </div>
    )
  }

  return (
    <div className="network-print-root">
      {/* Screen-only toolbar */}
      <div className="no-print" style={toolbarStyle}>
        <button onClick={() => navigate('/network-map')} style={btnStyle} aria-label="Back to Network Map">
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        <div style={{ fontSize: 13, color: '#64748b' }}>
          <strong style={{ color: '#0f172a' }}>Network Map — Print View ({allPages.length} pages).</strong>{' '}
          Set paper size to <strong>Tabloid / 11×17</strong>, orientation <strong>Portrait</strong>, enable <strong>Background graphics</strong>, and turn <strong>Headers and footers OFF</strong> for clean framed sheets.
        </div>
        <button onClick={handlePrint} style={{ ...btnStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }}>
          <Printer size={14} aria-hidden="true" /> Print
        </button>
      </div>

      {/* Screen-only stale-sheet banner */}
      {staleSheets.length > 0 ? (
        <div
          className="no-print"
          role="status"
          aria-live="polite"
          style={{
            margin: '12px auto', maxWidth: '11in',
            background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10,
            padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={18} style={{ color: '#b45309', flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <div style={{ flex: 1, fontSize: 13, color: '#78350f' }}>
            <strong>
              {staleSheets.length} wall {staleSheets.length === 1 ? 'sheet has' : 'sheets have'} changed since last print:
            </strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {staleSheets.map(s => (
                <li key={s.sheet_id} style={{ marginBottom: 2 }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.subnet_id}</span>
                  {' '}page {s.page_number} (.{s.start_octet}–.{s.end_octet}) — <strong>PDF sheet {s.sheet_index}</strong>
                  {s.last_changed_by && <span style={{ color: '#92400e' }}> · changed by {s.last_changed_by}</span>}
                </li>
              ))}
            </ul>
            <p style={{ margin: '8px 0 0' }}>
              To reprint only these, enter <strong style={{ fontFamily: 'monospace' }}>{pagesFieldValue}</strong>{' '}
              in the print dialog's <strong>Pages</strong> field.
            </p>
          </div>
          {canMarkPrinted && (
            <button
              onClick={() => { setMarkError(null); setShowConfirm(true) }}
              style={{
                ...btnStyle, flexShrink: 0,
                background: '#b45309', color: '#fff', borderColor: '#b45309',
              }}
            >
              <CheckCircle2 size={14} aria-hidden="true" /> Mark as printed
            </button>
          )}
        </div>
      ) : (
        <div
          className="no-print"
          role="status"
          style={{
            margin: '12px auto', maxWidth: '11in',
            background: justMarked ? '#ecfdf5' : '#f8fafc',
            border: `1px solid ${justMarked ? '#6ee7b7' : '#e2e8f0'}`,
            borderRadius: 10, padding: '10px 16px',
            display: 'flex', gap: 10, alignItems: 'center',
            fontSize: 13, color: justMarked ? '#065f46' : '#475569',
          }}
        >
          <CheckCircle2 size={16} style={{ color: '#059669', flexShrink: 0 }} aria-hidden="true" />
          <span>
            {justMarked ? 'Sheets marked as printed. ' : ''}
            All wall sheets are up to date
            {lastPrintedInfo?.last_printed_at && (
              <> · last printed {new Date(lastPrintedInfo.last_printed_at).toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
              })}{lastPrintedInfo.last_printed_by ? ` by ${lastPrintedInfo.last_printed_by}` : ''}</>
            )}.
          </span>
        </div>
      )}

      {allPages.map((page, idx) => (
        <section
          key={`${page.subnet.id}-${page.pageNumber}`}
          className="print-page"
          aria-labelledby={`print-heading-${page.subnet.id}-${page.pageNumber}`}
          style={{
            pageBreakAfter: idx < allPages.length - 1 ? 'always' : 'auto',
            breakAfter: idx < allPages.length - 1 ? 'page' : 'auto',
          }}
        >
          <header style={headerStyle}>
            <div>
              <h1 id={`print-heading-${page.subnet.id}-${page.pageNumber}`} style={h1Style}>
                RICT Network Map — {page.subnet.name}
              </h1>
              <p style={subtitleStyle}>{page.subnet.description}</p>
              <p style={rangeStyle}>
                <span>{page.startIp} — {page.endIp}</span>
                <span style={pageBadgeStyle}>
                  Page {page.pageNumber} of {page.totalPages}
                </span>
                {staleIndexSet.has(idx + 1) && (
                  <span className="no-print" style={changedRibbonStyle}>
                    <AlertTriangle size={10} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
                    Changed since last print
                  </span>
                )}
              </p>
            </div>
            <div style={metaBlock}>
              <div><strong>Network:</strong> {NETWORK_CONFIG.networkCidr}</div>
              <div><strong>Subnet Mask:</strong> {NETWORK_CONFIG.subnetMask}</div>
              <div><strong>Gateway:</strong> {NETWORK_CONFIG.gateway}</div>
              <div><strong>DHCP Pool:</strong> {NETWORK_CONFIG.dhcpPool.prefix}x (student laptops)</div>
              <div style={{ marginTop: 4, color: '#991b1b' }}>
                <strong>Do not use:</strong> {NETWORK_CONFIG.doNotUse.subnet.replace('.0', '')}.250 – .254
              </div>
              <div style={{ marginTop: 4, color: '#6b7280', fontSize: 10 }}>
                Printed {printedAt.toLocaleString()}
              </div>
            </div>
          </header>

          <PrintTable rows={page.rows} effectiveDeviceName={effectiveDeviceName} />
        </section>
      ))}

      {showConfirm && (
        <ConfirmPrintedModal
          count={staleSheets.length}
          sheets={staleSheets}
          saving={marking}
          error={markError}
          onConfirm={markAllPrinted}
          onClose={() => { if (!marking) { setShowConfirm(false); setMarkError(null) } }}
        />
      )}

      <style>{`
        .network-print-root {
          background: #fff;
          color: #0f172a;
          font-family: 'Helvetica Neue', Arial, sans-serif;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .print-page {
          padding: 0.5in;
          min-height: 16.5in;
          width: 11in;
          box-sizing: border-box;
        }

        @media screen {
          .print-page {
            margin: 16px auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            border-radius: 4px;
          }
        }

        @media print {
          @page {
            size: 11in 17in;
            margin: 0.4in;
          }
          .no-print { display: none !important; }
          .print-page {
            margin: 0;
            padding: 0;
            box-shadow: none;
            border-radius: 0;
            min-height: auto;
            width: auto;
          }
          .print-page table { line-height: 1.2; }
          .print-page tr {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .print-page thead { display: table-header-group; }
        }
      `}</style>
    </div>
  )
}

// ── Confirm "mark as printed" modal ───────────────────────────────────────
// Themed to match the app's ModalShell look (white rounded-2xl card, surface
// header, footer actions). useDialogA11y provides focus trap, Escape-to-close
// and focus restore per the standing modal requirement.
function ConfirmPrintedModal({ count, sheets, saving, error, onConfirm, onClose }) {
  const dialogRef = useDialogA11y(true, onClose)
  const titleId = 'np-confirm-title'
  const descId = 'np-confirm-desc'

  return (
    <div
      className="no-print fixed inset-0 z-[2000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-2xl w-full max-w-sm shadow-xl overflow-hidden flex flex-col"
      >
        <div className="px-5 py-3 border-b border-surface-200 flex items-start gap-3 bg-surface-50">
          <Printer size={18} className="text-brand-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-base font-bold text-surface-900">Mark sheets as printed?</h2>
            <p id={descId} className="text-xs text-surface-500 mt-0.5">
              This clears the outdated flag for {count} {count === 1 ? 'sheet' : 'sheets'} and records who printed and when.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-200 hover:text-surface-700
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <ul className="text-sm text-surface-700 space-y-1">
            {sheets.map(s => (
              <li key={s.sheet_id} className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-amber-600 flex-shrink-0" aria-hidden="true" />
                <span className="font-mono">{s.subnet_id}</span> page {s.page_number}
                <span className="text-surface-400 text-xs ml-auto">sheet {s.sheet_index}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-surface-500">
            Only confirm if the sheets actually printed — if the dialog was cancelled, choose "Not yet".
          </p>
          {error && (
            <div role="alert" className="p-2.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
              <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-200 bg-surface-50 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg
              hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Not yet
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700
              disabled:opacity-50 flex items-center gap-2
              focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
          >
            {saving
              ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Saving…</>
              : <><CheckCircle2 size={14} aria-hidden="true" /> Mark {count === 1 ? 'sheet' : `${count} sheets`} printed</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Single-column print table ─────────────────────────────────────────────
function PrintTable({ rows, effectiveDeviceName }) {
  return (
    <table
      role="table"
      style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 11, tableLayout: 'fixed',
        marginTop: '0.2in',
      }}
    >
      <caption className="sr-only">Network device assignments</caption>
      <colgroup>
        <col style={{ width: '14%' }} />
        <col style={{ width: '32%' }} />
        <col style={{ width: '18%' }} />
        <col style={{ width: '20%' }} />
        <col style={{ width: '16%' }} />
      </colgroup>
      <thead>
        <tr style={{ background: '#1e3a8a', color: '#fff' }}>
          <th scope="col" style={thStyle}>IP Address</th>
          <th scope="col" style={thStyle}>Device</th>
          <th scope="col" style={thStyle}>MAC</th>
          <th scope="col" style={thStyle}>Profinet Name</th>
          <th scope="col" style={thStyle}>Location</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => {
          const isDoNotUse = r.isReserved || r.isGateway
          const bg = isDoNotUse
            ? '#fee2e2'
            : idx % 2 === 0 ? '#fff' : '#f8fafc'
          const color = isDoNotUse ? '#991b1b' : '#0f172a'
          return (
            <tr key={r.ip} style={{ background: bg, color }}>
              <td style={{ ...tdStyle, fontFamily: 'monospace', fontWeight: isDoNotUse ? 700 : 500 }}>
                {r.ip}
              </td>
              <td style={tdStyle}>
                {effectiveDeviceName(r.device) || (r.isGateway ? 'Gateway' : r.isReserved ? 'Do Not Use' : '')}
              </td>
              <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 10 }}>
                {r.device?.mac_address || ''}
              </td>
              <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 10 }}>
                {r.device?.profinet_name || (r.isGateway ? 'DHCP' : '')}
              </td>
              <td style={tdStyle}>
                {r.device?.location || ''}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Styles (inline so they print consistently) ─────────────────────────────
const toolbarStyle = {
  position: 'sticky', top: 0, zIndex: 50,
  background: '#fff', borderBottom: '1px solid #e2e8f0',
  padding: '10px 20px',
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
}
const btnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px', border: '1px solid #e2e8f0',
  borderRadius: 6, background: '#fff', color: '#334155',
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
const headerStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  gap: 20, paddingBottom: 8,
  borderBottom: '2px solid #1e3a8a',
}
const h1Style = { fontSize: 20, fontWeight: 700, margin: 0, color: '#0f172a' }
const subtitleStyle = { fontSize: 12, color: '#64748b', margin: '2px 0 0' }
const rangeStyle = {
  fontSize: 13, color: '#1e3a8a', margin: '6px 0 0',
  fontFamily: 'monospace', fontWeight: 600,
  display: 'flex', alignItems: 'center', gap: 12,
}
const pageBadgeStyle = {
  display: 'inline-block',
  padding: '2px 8px', borderRadius: 4,
  background: '#1e3a8a', color: '#fff',
  fontSize: 10, fontWeight: 700, fontFamily: 'Helvetica Neue, Arial, sans-serif',
  textTransform: 'uppercase', letterSpacing: '0.05em',
}
const changedRibbonStyle = {
  display: 'inline-block',
  padding: '2px 8px', borderRadius: 4,
  background: '#fef3c7', color: '#92400e',
  border: '1px solid #fcd34d',
  fontSize: 10, fontWeight: 700, fontFamily: 'Helvetica Neue, Arial, sans-serif',
  textTransform: 'uppercase', letterSpacing: '0.05em',
}
const metaBlock = { fontSize: 10, color: '#334155', textAlign: 'right', lineHeight: 1.5 }
const thStyle = {
  padding: '4px 8px', textAlign: 'left',
  fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
  lineHeight: 1.2,
  borderBottom: '1px solid #1e3a8a',
}
const tdStyle = {
  padding: '3px 8px',
  lineHeight: 1.2,
  borderBottom: '1px solid #e5e7eb',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
