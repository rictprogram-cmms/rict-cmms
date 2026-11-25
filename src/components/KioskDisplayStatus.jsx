/**
 * RICT CMMS — KioskDisplayStatus
 *
 * Shown in Settings → General → TV Displays, under "Reload TVs now".
 * Lists every Raspberry Pi kiosk that checks in (once a minute) through
 * kiosk_heartbeat(): online / late / offline, page health, power and
 * temperature warnings, memory, uptime. Instructors can rename a display,
 * restart its browser, reboot the Pi, or remove it from the list.
 *
 * Data:   public.kiosk_devices (migration 20261124f_kiosk_device_status.sql)
 *         Real-UTC timestamps (Convention B) — only ever shown as "x min ago".
 * Access: same as "Reload TVs now" — Settings view_page (RLS mirrors it).
 * Remote commands are queued in pending_command; the Pi picks them up at its
 * next check-in (within about a minute) and the row clears itself.
 *
 * Accessibility (WCAG 2.1 AA / Section 508):
 *   - Status is text + icon, never colour alone
 *   - 44px minimum targets, focus-visible rings, aria-labels naming the display
 *   - role="status" live region announces actions and load errors
 *   - Confirm dialogs (ConfirmDialog → useDialogA11y) for reboot and remove
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  CheckCircle2, Clock, WifiOff, AlertTriangle, RotateCcw, Power, Trash2,
  Edit3, Check, X, Loader2, Thermometer, Zap, MemoryStick, Monitor,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import ConfirmDialog from '@/components/ConfirmDialog'

// Pis check in every 60 s. Allow for a slow network before calling it late.
const ONLINE_SECONDS = 150
const LATE_SECONDS = 600

const PAGE_STATE_TEXT = {
  blank: 'Page is blank',
  error: 'Page showed an error',
  not_answering: 'Page not answering',
  starting: 'Browser starting',
}

const COMMAND_TEXT = {
  restart_browser: 'Restart browser',
  reboot: 'Reboot',
}

function ageSeconds(iso, now) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.max(0, Math.round((now - t) / 1000))
}

function ago(sec) {
  if (sec == null) return 'never'
  if (sec < 60) return 'just now'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hr ago`
  return `${Math.round(h / 24)} days ago`
}

function duration(sec) {
  if (sec == null) return ''
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`
  if (sec < 86400 * 2) return `${Math.round(sec / 3600)} hr`
  return `${Math.round(sec / 86400)} days`
}

function pageName(url) {
  if (!url) return 'Unknown page'
  try {
    const path = new URL(url).pathname
    if (path.startsWith('/tv-display')) return 'TV Display'
    if (path.startsWith('/lab-status')) return 'Lab Status'
    if (path.startsWith('/time-clock')) return 'Time Clock'
    return path
  } catch {
    return url
  }
}

function connection(device, now) {
  const age = ageSeconds(device.last_seen_at, now)
  if (age == null) return { key: 'offline', label: 'Never checked in', age }
  if (age <= ONLINE_SECONDS) return { key: 'online', label: 'Online', age }
  if (age <= LATE_SECONDS) return { key: 'late', label: 'Late', age }
  return { key: 'offline', label: 'Offline', age }
}

const BADGE = {
  online:  { Icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-800 border-emerald-300' },
  late:    { Icon: Clock,        cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  offline: { Icon: WifiOff,      cls: 'bg-red-50 text-red-800 border-red-300' },
}

function warningsFor(d, conn) {
  const w = []
  if (conn.key === 'online' && d.page_state && d.page_state !== 'ok') {
    w.push({ Icon: AlertTriangle, text: PAGE_STATE_TEXT[d.page_state] || `Page: ${d.page_state}` })
  }
  if (d.undervolt_now) w.push({ Icon: Zap, text: 'Low power right now — check the power supply' })
  else if (d.undervolt_since_boot) w.push({ Icon: Zap, text: 'Low power since start-up — check the power supply' })
  if (d.hot_now) w.push({ Icon: Thermometer, text: `Running hot${d.cpu_temp_c != null ? ` (${d.cpu_temp_c} °C)` : ''} — slowing itself down` })
  if (d.mem_free_mb != null && d.mem_free_mb < 150) w.push({ Icon: MemoryStick, text: `Low memory (${d.mem_free_mb} MB free)` })
  if (d.screen_fixes > 0) w.push({ Icon: Monitor, text: `Black screen fixed ${d.screen_fixes} time${d.screen_fixes === 1 ? '' : 's'} since start-up` })
  return w
}

const btn = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[44px] min-w-[44px] text-sm font-medium rounded-lg border focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed'
const btnNeutral = `${btn} border-surface-300 bg-white text-surface-800 hover:bg-surface-50`
const btnDanger = `${btn} border-red-300 bg-white text-red-700 hover:bg-red-50`

export default function KioskDisplayStatus() {
  const { profile } = useAuth()
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''
  const [devices, setDevices] = useState(undefined)   // undefined = loading
  const [loadError, setLoadError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState('')                 // `${device}:${action}`
  const [editing, setEditing] = useState(null)         // device_name
  const [labelDraft, setLabelDraft] = useState('')
  const [confirm, setConfirm] = useState(null)         // { device, action }
  const [status, setStatus] = useState('')
  const labelInputRef = useRef(null)

  const fetchDevices = useCallback(async () => {
    try {
      const rows = mustData(await supabase
        .from('kiosk_devices')
        .select('*')
        .order('device_name'), 'kiosk_devices.select')
      setDevices(rows || [])
      setLoadError('')
    } catch (err) {
      setDevices(prev => prev || [])
      setLoadError(err?.message || 'Could not load displays')
    }
  }, [])

  useEffect(() => { fetchDevices() }, [fetchDevices])

  useEffect(() => {
    const channelId = `kiosk-devices-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const unsubscribe = subscribeWithReconnect(channelId, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kiosk_devices' },
        () => { fetchDevices() }),
      { onReconnect: fetchDevices })
    return () => { unsubscribe() }
  }, [fetchDevices])

  // Re-age the badges, and re-read as a safety net if a realtime event is missed
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()) }, 30_000)
    const poll = setInterval(fetchDevices, 120_000)
    return () => { clearInterval(id); clearInterval(poll) }
  }, [fetchDevices])

  useEffect(() => {
    if (editing && labelInputRef.current) labelInputRef.current.focus()
  }, [editing])

  const displayName = (d) => d.label ? `${d.label} (${d.device_name})` : d.device_name

  const audit = async (action, d, details) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: profile?.email || 'unknown',
        user_name: profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown',
        action,
        entity_type: 'Kiosk Display',
        entity_id: d.device_name,
        details,
      })
    } catch (e) {
      console.warn('[KioskDisplayStatus] Audit log failed (non-fatal):', e?.message)
    }
  }

  const announce = (msg, ok = true) => {
    setStatus(msg)
    if (ok) toast.success(msg); else toast.error(msg)
  }

  const queueCommand = async (d, command) => {
    setBusy(`${d.device_name}:${command}`)
    try {
      const rows = mustData(await supabase
        .from('kiosk_devices')
        .update({
          pending_command: command,
          command_requested_at: new Date().toISOString(),
          command_requested_by: userName,
        })
        .eq('device_name', d.device_name)
        .select('device_name'), 'kiosk_devices.update')
      if (!rows || rows.length === 0) throw new Error('You do not have permission to control displays.')
      await audit(command === 'reboot' ? 'Reboot Kiosk Display' : 'Restart Kiosk Browser', d,
        `${COMMAND_TEXT[command]} requested for ${displayName(d)}.`)
      announce(`${COMMAND_TEXT[command]} sent to ${displayName(d)}. It happens at the display's next check-in, within about a minute.`)
      fetchDevices()
    } catch (err) {
      announce(`${COMMAND_TEXT[command]} not sent: ${err?.message || 'unknown error'}`, false)
    } finally {
      setBusy('')
    }
  }

  const cancelCommand = async (d) => {
    setBusy(`${d.device_name}:cancel`)
    try {
      const rows = mustData(await supabase
        .from('kiosk_devices')
        .update({ pending_command: null, command_requested_at: null, command_requested_by: null })
        .eq('device_name', d.device_name)
        .select('device_name'), 'kiosk_devices.update')
      if (!rows || rows.length === 0) throw new Error('Nothing was changed.')
      announce(`Cancelled the request for ${displayName(d)}.`)
      fetchDevices()
    } catch (err) {
      announce(`Could not cancel: ${err?.message || 'unknown error'}`, false)
    } finally {
      setBusy('')
    }
  }

  const saveLabel = async (d) => {
    const label = labelDraft.trim().slice(0, 60) || null
    setBusy(`${d.device_name}:label`)
    try {
      const rows = mustData(await supabase
        .from('kiosk_devices')
        .update({ label })
        .eq('device_name', d.device_name)
        .select('device_name'), 'kiosk_devices.update')
      if (!rows || rows.length === 0) throw new Error('You do not have permission to rename displays.')
      announce(label ? `Renamed ${d.device_name} to "${label}".` : `Removed the name from ${d.device_name}.`)
      setEditing(null)
      fetchDevices()
    } catch (err) {
      announce(`Name not saved: ${err?.message || 'unknown error'}`, false)
    } finally {
      setBusy('')
    }
  }

  const removeDevice = async (d) => {
    setBusy(`${d.device_name}:remove`)
    try {
      const rows = mustData(await supabase
        .from('kiosk_devices')
        .delete()
        .eq('device_name', d.device_name)
        .select('device_name'), 'kiosk_devices.delete')
      if (!rows || rows.length === 0) throw new Error('You do not have permission to remove displays.')
      await audit('Remove Kiosk Display', d, `Removed ${displayName(d)} from the display list.`)
      announce(`Removed ${displayName(d)}. If it is still running it will reappear at its next check-in.`)
      fetchDevices()
    } catch (err) {
      announce(`Not removed: ${err?.message || 'unknown error'}`, false)
    } finally {
      setBusy('')
      setConfirm(null)
    }
  }

  const onConfirm = () => {
    if (!confirm) return
    const { device, action } = confirm
    if (action === 'remove') removeDevice(device)
    else { setConfirm(null); queueCommand(device, action) }
  }

  const sorted = (devices || []).slice()
  const counts = sorted.reduce((acc, d) => {
    acc[connection(d, now).key] += 1
    return acc
  }, { online: 0, late: 0, offline: 0 })

  return (
    <div id="setting-kiosk_display_status" className="px-4 py-4 border-t border-surface-200" aria-labelledby="kiosk-status-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h3 id="kiosk-status-heading" className="text-sm font-semibold text-surface-900">
          Display status
        </h3>
        {devices && devices.length > 0 && (
          <p className="text-xs text-surface-600">
            {counts.online} online
            {counts.late > 0 && ` · ${counts.late} late`}
            {counts.offline > 0 && ` · ${counts.offline} offline`}
          </p>
        )}
      </div>

      <span className="sr-only" role="status" aria-live="polite">{status}</span>

      {loadError && (
        <p className="mb-3 text-sm text-red-700 flex items-center gap-1.5" role="alert">
          <AlertTriangle size={14} aria-hidden="true" /> {loadError}
        </p>
      )}

      {devices === undefined ? (
        <p className="text-sm text-surface-600 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading displays…
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-surface-600">
          No displays have checked in yet. A Raspberry Pi appears here a minute after it is set up
          with the kiosk token (setup-kiosk.sh --kiosk-token …).
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Kiosk displays">
          {sorted.map(d => {
            const conn = connection(d, now)
            const badge = BADGE[conn.key]
            const warns = warningsFor(d, conn)
            const headingId = `kiosk-${d.device_name}-name`
            const isBusy = (a) => busy === `${d.device_name}:${a}`
            const anyBusy = busy.startsWith(`${d.device_name}:`)
            const offline = conn.key === 'offline'
            return (
              <li key={d.device_name} className="rounded-lg border border-surface-200 bg-white p-3" aria-labelledby={headingId}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    {editing === d.device_name ? (
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => { e.preventDefault(); saveLabel(d) }}
                      >
                        <label htmlFor={`kiosk-label-${d.device_name}`} className="sr-only">
                          Name for display {d.device_name}
                        </label>
                        <input
                          id={`kiosk-label-${d.device_name}`}
                          ref={labelInputRef}
                          value={labelDraft}
                          maxLength={60}
                          onChange={(e) => setLabelDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null) }}
                          placeholder="e.g. Shop TV"
                          className="px-3 py-2 min-h-[44px] text-sm border border-surface-300 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        />
                        <button type="submit" className={btnNeutral} disabled={isBusy('label')}
                          aria-label={`Save name for ${d.device_name}`}>
                          {isBusy('label') ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                        </button>
                        <button type="button" className={btnNeutral} onClick={() => setEditing(null)}
                          aria-label={`Cancel renaming ${d.device_name}`}>
                          <X size={16} aria-hidden="true" />
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center gap-1">
                        <h4 id={headingId} className="text-sm font-semibold text-surface-900 truncate">
                          {d.label || d.device_name}
                          {d.label && <span className="font-normal text-surface-600"> · {d.device_name}</span>}
                        </h4>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-surface-500 hover:text-surface-900 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          onClick={() => { setEditing(d.device_name); setLabelDraft(d.label || '') }}
                          aria-label={`Rename ${displayName(d)}`}
                        >
                          <Edit3 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    <p className="text-xs text-surface-600">
                      {pageName(d.page_url)}
                      {d.model ? ` · ${d.model.replace(/^Raspberry Pi /, 'Pi ').replace(/ Rev [\d.]+$/, '')}` : ''}
                      {d.ip_address ? ` · ${d.ip_address}` : ''}
                    </p>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full border ${badge.cls}`}>
                    <badge.Icon size={13} aria-hidden="true" />
                    {conn.label}
                    <span className="font-normal">· {conn.age == null ? 'never' : `seen ${ago(conn.age)}`}</span>
                  </span>
                </div>

                {warns.length > 0 && (
                  <ul className="mt-2 space-y-1" aria-label={`Warnings for ${displayName(d)}`}>
                    {warns.map((w, i) => (
                      <li key={i} className="flex items-center gap-1.5 text-xs text-amber-900">
                        <w.Icon size={13} aria-hidden="true" className="shrink-0" /> {w.text}
                      </li>
                    ))}
                  </ul>
                )}

                <dl className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                  <div><dt className="text-surface-500">Temperature</dt><dd className="text-surface-900">{d.cpu_temp_c != null ? `${d.cpu_temp_c} °C` : '—'}</dd></div>
                  <div><dt className="text-surface-500">Free memory</dt><dd className="text-surface-900">{d.mem_free_mb != null ? `${d.mem_free_mb} MB` : '—'}</dd></div>
                  <div><dt className="text-surface-500">Pi running for</dt><dd className="text-surface-900">{duration(d.uptime_sec) || '—'}</dd></div>
                  <div><dt className="text-surface-500">Browser restarts</dt><dd className="text-surface-900">{d.browser_restarts ?? '—'}{d.browser_uptime_sec != null ? ` (up ${duration(d.browser_uptime_sec)})` : ''}</dd></div>
                </dl>

                {d.pending_command ? (
                  <p className="mt-2 text-xs text-surface-700 flex flex-wrap items-center gap-2">
                    <Clock size={13} aria-hidden="true" />
                    {COMMAND_TEXT[d.pending_command] || d.pending_command} requested
                    {d.command_requested_by ? ` by ${d.command_requested_by}` : ''}
                    {' '}{ago(ageSeconds(d.command_requested_at, now))} — waiting for the display to check in.
                    <button type="button" className={btnNeutral} onClick={() => cancelCommand(d)}
                      disabled={anyBusy} aria-label={`Cancel the request for ${displayName(d)}`}>
                      {isBusy('cancel') ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
                      Cancel
                    </button>
                  </p>
                ) : d.last_command && d.last_command_sent_at ? (
                  <p className="mt-2 text-xs text-surface-600">
                    Last: {COMMAND_TEXT[d.last_command] || d.last_command} carried out {ago(ageSeconds(d.last_command_sent_at, now))}.
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={btnNeutral}
                    onClick={() => queueCommand(d, 'restart_browser')}
                    disabled={anyBusy || !!d.pending_command}
                    aria-label={`Restart the browser on ${displayName(d)}`}>
                    {isBusy('restart_browser') ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
                    Restart browser
                  </button>
                  <button type="button" className={btnNeutral}
                    onClick={() => setConfirm({ device: d, action: 'reboot' })}
                    disabled={anyBusy || !!d.pending_command}
                    aria-label={`Reboot ${displayName(d)}`}>
                    {isBusy('reboot') ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}
                    Reboot Pi
                  </button>
                  <button type="button" className={btnDanger}
                    onClick={() => setConfirm({ device: d, action: 'remove' })}
                    disabled={anyBusy}
                    aria-label={`Remove ${displayName(d)} from the list`}>
                    {isBusy('remove') ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
                    Remove
                  </button>
                </div>
                {offline && (
                  <p className="mt-2 text-xs text-surface-600">
                    While a display is offline, a restart or reboot waits until it checks in again.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirm}
        variant={confirm?.action === 'remove' ? 'danger' : 'primary'}
        title={confirm?.action === 'remove' ? 'Remove this display?' : 'Reboot this display?'}
        message={confirm ? (
          confirm.action === 'remove'
            ? <>Remove <strong>{displayName(confirm.device)}</strong> from the list? Use this for a Pi you no longer use. If it is still running, it will reappear at its next check-in (its name will need re-entering).</>
            : <>Reboot <strong>{displayName(confirm.device)}</strong>? The screen goes dark for about two minutes while the Pi restarts. On a weak power supply a Pi 3 may not come back until it is unplugged and plugged in again.</>
        ) : ''}
        confirmLabel={confirm?.action === 'remove' ? 'Remove display' : 'Reboot Pi'}
        cancelLabel="Cancel"
        busy={!!confirm && isBusyRemove(busy, confirm)}
        onConfirm={onConfirm}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}

function isBusyRemove(busy, confirm) {
  return confirm?.action === 'remove' && busy === `${confirm.device.device_name}:remove`
}
