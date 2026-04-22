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
 *
 * WCAG 2.1 AA: semantic table per page, ≥ 4.5:1 contrast,
 * non-color-only "Do Not Use" indicator, h1 per page.
 *
 * File: src/pages/NetworkPrintPage.jsx
 */

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { NETWORK_CONFIG, isDoNotUseIp } from '@/lib/networkConfig'
import { Printer, ArrowLeft, Loader2 } from 'lucide-react'

const GATEWAY = NETWORK_CONFIG.gateway
const PAGES_PER_SUBNET = 4
const ROWS_PER_PAGE = Math.ceil(254 / PAGES_PER_SUBNET) // 64

export default function NetworkPrintPage() {
  const navigate = useNavigate()
  const [devices, setDevices] = useState([])
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [printedAt] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [devRes, assetRes] = await Promise.all([
          supabase.from('network_devices').select('*').order('ip_address', { ascending: true }),
          supabase.from('assets').select('asset_id, name, status').eq('status', 'Active'),
        ])
        if (cancelled) return
        if (devRes.error) { setError(devRes.error.message); return }
        if (assetRes.error) { setError(assetRes.error.message); return }
        setDevices(devRes.data || [])
        setAssets(assetRes.data || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

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
    const out = []
    NETWORK_CONFIG.subnets.forEach(subnet => {
      // Build 254 rows for this subnet
      const subnetRows = []
      for (let octet = 1; octet <= 254; octet++) {
        const ip = `${subnet.prefix}${octet}`
        const device = devices.find(d => d.ip_address === ip) || null
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
          Set paper size to <strong>Tabloid / 11×17</strong>, orientation <strong>Portrait</strong>, and enable <strong>Background graphics</strong>.
        </div>
        <button onClick={() => window.print()} style={{ ...btnStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }}>
          <Printer size={14} aria-hidden="true" /> Print
        </button>
      </div>

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
        }
      `}</style>
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
const metaBlock = { fontSize: 10, color: '#334155', textAlign: 'right', lineHeight: 1.5 }
const thStyle = {
  padding: '5px 8px', textAlign: 'left',
  fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
  borderBottom: '1px solid #1e3a8a',
}
const tdStyle = {
  padding: '4px 8px',
  borderBottom: '1px solid #e5e7eb',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
