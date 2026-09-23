/**
 * RICT CMMS — AccountabilityAlertsCard ("Students to check on")
 *
 * Instructor Dashboard card fed by accountability_alerts. Shows every open,
 * unacknowledged pattern alert grouped by student — drastic ones first —
 * with a shared Acknowledge button and a link into the student's
 * Accountability Report. Acknowledged alerts stay open (a pattern that keeps
 * going comes back as "still open, week N") and can be shown with a toggle.
 *
 * A background sweep refreshes the table when the last one is older than the
 * `accountability_sweep_hours` setting; "Check now" forces it.
 *
 * Collapsed by default (decision 2026-09-23): the header alone shows the open
 * / urgent count, and the list expands on click. The choice is remembered per
 * browser (localStorage, best-effort) the same way the Day View card does.
 *
 * Accessibility: card header is a real <h3>; live region for sweep progress;
 * 44px controls; focus-visible rings; tier shown as icon + text, never colour
 * alone; each alert is a list item with the student name as a link.
 *
 * File: src/components/AccountabilityAlertsCard.jsx
 */

import { useState, useMemo, useId } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccountabilityAlerts } from '@/hooks/useAccountabilityAlerts'
import { describeRule } from '@/lib/accountabilityAlerts'
import { AlertOctagon, AlertTriangle, CheckCircle2, RefreshCw, Loader2, ExternalLink, Undo2, ChevronDown, ChevronRight } from 'lucide-react'
import toast from 'react-hot-toast'

function ago(iso) {
  if (!iso) return 'never'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (isNaN(m)) return 'unknown'
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1'
const EXPAND_KEY = 'dash_alerts_expanded'

function readExpanded() {
  try { return localStorage.getItem(EXPAND_KEY) === '1' } catch { return false }
}
function writeExpanded(v) {
  try { localStorage.setItem(EXPAND_KEY, v ? '1' : '0') } catch {}
}

export default function AccountabilityAlertsCard({ enabled = true }) {
  const navigate = useNavigate()
  const { alerts, loading, sweeping, progress, lastSweep, sweepHours, error, acknowledge, unacknowledge, sweepNow } = useAccountabilityAlerts({ enabled })
  const [showAcked, setShowAcked] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [expanded, setExpanded] = useState(readExpanded)
  const bodyId = useId()
  const toggle = () => setExpanded(v => { writeExpanded(!v); return !v })

  const { active, acked, grouped } = useMemo(() => {
    const active = alerts.filter(a => !a.acknowledged_at)
    const acked = alerts.filter(a => a.acknowledged_at)
    const list = showAcked ? alerts : active
    const byStudent = new Map()
    for (const a of list) {
      const k = String(a.user_email || '').toLowerCase()
      if (!byStudent.has(k)) byStudent.set(k, { email: a.user_email, name: a.user_name || a.user_email, alerts: [] })
      byStudent.get(k).alerts.push(a)
    }
    const grouped = [...byStudent.values()].map(g => ({ ...g, drastic: g.alerts.some(a => a.tier === 'drastic' && !a.acknowledged_at) }))
      .sort((a, b) => (a.drastic !== b.drastic ? (a.drastic ? -1 : 1) : b.alerts.length - a.alerts.length || a.name.localeCompare(b.name)))
    return { active, acked, grouped }
  }, [alerts, showAcked])

  const drasticCount = active.filter(a => a.tier === 'drastic').length

  const act = async (fn, id, okMsg) => {
    setBusyId(id)
    try { await fn(id); toast.success(okMsg) } catch (e) { toast.error(e?.message || 'Could not update the alert') } finally { setBusyId(null) }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="dash-card" style={drasticCount > 0 ? { borderColor: '#ffc9c9' } : {}}>
        <div className="dash-card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={toggle}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
            className={FOCUS}
            style={{ cursor: 'pointer', userSelect: 'none', flex: 1, minWidth: 0, minHeight: 44, display: 'flex', alignItems: 'center', gap: 8, borderRadius: 6 }}
          >
            <span aria-hidden="true" style={{ color: '#868e96', display: 'inline-flex' }}>{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
            <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#1a1a2e', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              Students to check on
              {!loading && (
                <span className="badge" style={{ background: active.length ? '#ffe3e3' : '#d3f9d8', color: active.length ? '#c92a2a' : '#237032' }}>
                  {active.length === 0 ? 'nothing open' : `${active.length} open${drasticCount ? ` · ${drasticCount} urgent` : ''}`}
                </span>
              )}
              <span className="sr-only">{expanded ? ', expanded' : ', collapsed — press to expand'}</span>
            </h3>
            <div style={{ fontSize: '0.7rem', color: '#666f78', marginTop: 2 }} role="status" aria-live="polite">
              {sweeping
                ? <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" />Checking students… {progress.total ? `${progress.done} of ${progress.total}` : ''}</span>
                : `Patterns, not single events · last checked ${ago(lastSweep)} · re-checks every ${sweepHours} h`}
              {error && <span style={{ color: '#c92a2a' }}> · {error}</span>}
            </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
            {expanded && acked.length > 0 && (
              <button type="button" className={`dash-btn-sm ${FOCUS}`} onClick={() => setShowAcked(v => !v)} aria-pressed={showAcked}>
                {showAcked ? 'Hide acknowledged' : `Show acknowledged (${acked.length})`}
              </button>
            )}
            <button type="button" className={`dash-btn-sm ${FOCUS}`} onClick={sweepNow} disabled={sweeping} aria-label="Check all students for patterns now">
              <RefreshCw size={12} aria-hidden="true" className={sweeping ? 'animate-spin' : ''} style={{ marginRight: 4 }} /> Check now
            </button>
          </div>
        </div>

        <div className="dash-card-body" id={bodyId} hidden={!expanded}>
          {loading ? (
            <div style={{ padding: 16, fontSize: '0.8rem', color: '#666f78' }}>Loading…</div>
          ) : grouped.length === 0 ? (
            <div style={{ padding: 16, fontSize: '0.85rem', color: '#237032', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={18} aria-hidden="true" /> Nothing needs attention right now.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {grouped.map(g => (
                <li key={g.email} style={{ padding: '10px 16px', borderTop: '1px solid #f1f3f5' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button"
                      onClick={() => navigate(`/accountability-report?student=${encodeURIComponent(g.email)}`)}
                      className={`inline-flex items-center gap-1 text-brand-700 hover:underline font-semibold min-h-[44px] ${FOCUS}`}
                      style={{ fontSize: '0.9rem' }}>
                      {g.name} <ExternalLink size={12} aria-hidden="true" /><span className="sr-only">, open accountability report</span>
                    </button>
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {g.alerts.map(a => {
                      const meta = describeRule(a.rule)
                      const drastic = a.tier === 'drastic'
                      const Icon = drastic ? AlertOctagon : AlertTriangle
                      const isAcked = !!a.acknowledged_at
                      return (
                        <li key={a.alert_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', opacity: isAcked ? 0.7 : 1 }}>
                          <span className="badge" style={{ background: drastic ? '#ffe3e3' : '#fff4e6', color: drastic ? '#c92a2a' : '#b23c0c', gap: 4, flexShrink: 0, marginTop: 2 }}>
                            <Icon size={12} aria-hidden="true" /> {drastic ? 'Urgent' : 'Watch'}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#1a1a2e' }}>
                              {meta.label}
                              {a.weeks_seen > 1 && <span style={{ fontWeight: 500, color: '#b23c0c' }}> · still open, week {a.weeks_seen}</span>}
                            </div>
                            <div style={{ fontSize: '0.76rem', color: '#495057' }}>{a.detail}</div>
                            {isAcked && <div style={{ fontSize: '0.68rem', color: '#666f78' }}>Acknowledged by {a.acknowledged_by || 'an instructor'} {ago(a.acknowledged_at)}</div>}
                          </div>
                          {isAcked ? (
                            <button type="button" className={`dash-btn-sm ${FOCUS}`} disabled={busyId === a.alert_id}
                              onClick={() => act(unacknowledge, a.alert_id, 'Alert reopened on the card')}
                              aria-label={`Undo acknowledgement for ${g.name}: ${meta.label}`}>
                              <Undo2 size={12} aria-hidden="true" style={{ marginRight: 4 }} /> Undo
                            </button>
                          ) : (
                            <button type="button" className={`dash-btn-sm ${FOCUS}`} disabled={busyId === a.alert_id}
                              onClick={() => act(acknowledge, a.alert_id, 'Acknowledged — it will come back if the pattern continues')}
                              aria-label={`Acknowledge ${g.name}: ${meta.label}`}>
                              Acknowledge
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
