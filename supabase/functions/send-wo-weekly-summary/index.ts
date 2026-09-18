/**
 * RICT CMMS — send-wo-weekly-summary Edge Function
 *
 * Once a week, emails the instructors' shared inbox one digest of every work
 * order closed in the last 7 days. Each work order gets a summary row PLUS
 * its complete work log, so instructors can see whether students are logging
 * their work properly (missing entries, blank descriptions, hours that don't
 * add up are flagged in the email).
 *
 * Nothing closed that week → nothing is sent (unless `force` is set).
 *
 * Who calls it
 *   • pg_cron (supabase/migrations/20260918_wo_weekly_summary.sql) — every
 *     Friday at 21:00 and 22:00 UTC with body {"expectLocalHour":16}. The
 *     function only sends when it is 4 PM in America/Chicago, so exactly one
 *     of the two slots fires whether Minnesota is on CDT or CST. The cron job
 *     authenticates with the `x-webhook-secret` header (same WEBHOOK_SECRET
 *     the push webhooks use).
 *   • A manual test — POST with the service-role key as the bearer token:
 *       { "dryRun": true }            → returns the rendered HTML, sends nothing
 *       { "force": true }             → sends even if 0 closed / wrong hour
 *       { "days": 14 }                → widen the window (default 7)
 *       { "to": "you@sctcc.edu" }     → override the recipient for a test
 *
 * Recipient
 *   settings.wo_close_summary_email (Settings → Work Orders → "Weekly Close
 *   Summary Email"). Blank = digest off.
 *
 * Required Supabase secrets:
 *   RESEND_API_KEY   — Resend API key (already used by the other mail functions)
 *   WEBHOOK_SECRET   — shared with send-push; the cron job sends it
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-provided
 *
 * Deployment (from the repo root):
 *   npx supabase functions deploy send-wo-weekly-summary --no-verify-jwt
 *
 * Timestamps: work_orders_closed.closed_date, work_orders_closed.created_at and
 * work_log.timestamp are real UTC (Convention B), so they are rendered with
 * timeZone 'America/Chicago'. due_date may be a bare YYYY-MM-DD.
 *
 * File: supabase/functions/send-wo-weekly-summary/index.ts
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const WEBHOOK_SECRET            = Deno.env.get('WEBHOOK_SECRET') ?? ''
const RESEND_API_KEY            = Deno.env.get('RESEND_API_KEY') ?? ''

const FROM_EMAIL   = 'RICT CMMS <noreply@abctechllc.com>'
const APP_URL      = 'https://rict-cmms.vercel.app/work-orders'
const SETTING_KEY  = 'wo_close_summary_email'
const TIME_ZONE    = 'America/Chicago'
const DEFAULT_DAYS = 7

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ClosedWO {
  wo_id: string
  description: string | null
  priority: string | null
  asset_id: string | null
  asset_name: string | null
  assigned_to: string | null
  created_at: string | null
  due_date: string | null
  closed_date: string | null
  closed_by: string | null
  created_by: string | null
  request_id: string | null
  is_pm: boolean | string | null
  pm_id: string | null
  total_hours: number | string | null
  days_open: number | string | null
  was_late: string | boolean | null
}

interface LogRow {
  wo_id: string
  timestamp: string | null
  user_name: string | null
  hours: number | string | null
  work_description: string | null
  entry_type: string | null
}

interface PartRow {
  wo_id: string
  part_name: string | null
  quantity_used: number | string | null
  from_inventory: string | boolean | null
}

// ── Auth helpers (same pattern as send-push) ─────────────────────────────────

function bearerToken(req: Request): string {
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function isAuthorized(req: Request): boolean {
  const secret = (req.headers.get('x-webhook-secret') ?? '').trim()
  if (WEBHOOK_SECRET && secret && safeEqual(secret, WEBHOOK_SECRET)) return true
  const bearer = bearerToken(req)
  const apikey = (req.headers.get('apikey') ?? '').trim()
  return SUPABASE_SERVICE_ROLE_KEY.length > 0 &&
    (safeEqual(bearer, SUPABASE_SERVICE_ROLE_KEY) || safeEqual(apikey, SUPABASE_SERVICE_ROLE_KEY))
}

// ── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    if (!isAuthorized(req)) return json({ error: 'Unauthorized' }, 401)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Project keys not available')

    const body = await req.json().catch(() => ({}))
    const dryRun = body.dryRun === true
    const force  = body.force === true
    const days   = clampInt(body.days, 1, 60, DEFAULT_DAYS)
    const expectLocalHour = body.expectLocalHour == null ? null : clampInt(body.expectLocalHour, 0, 23, -1)

    const now = new Date()

    // DST guard: the cron job fires at two UTC hours; only the one that lands
    // on the expected Chicago hour proceeds.
    if (expectLocalHour != null && !force) {
      const localHour = parseInt(now.toLocaleString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false }), 10) % 24
      if (localHour !== expectLocalHour) {
        return json({ skipped: true, reason: `Local hour is ${localHour}, expected ${expectLocalHour}` })
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // 1. Recipient
    let to = String(body.to ?? '').trim().toLowerCase()
    if (!to) {
      const { data: setting, error: setErr } = await supabase
        .from('settings').select('setting_value').eq('setting_key', SETTING_KEY).maybeSingle()
      if (setErr) throw new Error(`settings lookup failed: ${setErr.message}`)
      to = String(setting?.setting_value ?? '').trim().toLowerCase()
    }
    if (!to) return json({ skipped: true, reason: `No recipient — settings.${SETTING_KEY} is blank` })
    if (!to.includes('@')) return json({ error: `settings.${SETTING_KEY} is not an email address` }, 400)

    // 2. Closed work orders in the window
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    const { data: closed, error: closedErr } = await supabase
      .from('work_orders_closed')
      .select('wo_id, description, priority, asset_id, asset_name, assigned_to, created_at, due_date, closed_date, closed_by, created_by, request_id, is_pm, pm_id, total_hours, days_open, was_late')
      .gte('closed_date', since.toISOString())
      .lte('closed_date', now.toISOString())
      .order('closed_date', { ascending: true })
    if (closedErr) throw new Error(`work_orders_closed query failed: ${closedErr.message}`)

    const wos = (closed ?? []) as ClosedWO[]
    if (wos.length === 0 && !force && !dryRun) {
      return json({ skipped: true, reason: `No work orders closed since ${since.toISOString()}` })
    }

    // 3. Work logs + parts for those WOs (one query each)
    const ids = wos.map((w) => w.wo_id)
    let logs: LogRow[] = []
    let parts: PartRow[] = []
    if (ids.length > 0) {
      const [{ data: l, error: lErr }, { data: p, error: pErr }] = await Promise.all([
        supabase.from('work_log')
          .select('wo_id, timestamp, user_name, hours, work_description, entry_type')
          .in('wo_id', ids).order('timestamp', { ascending: true }),
        supabase.from('work_order_parts')
          .select('wo_id, part_name, quantity_used, from_inventory')
          .in('wo_id', ids).order('added_date', { ascending: true }),
      ])
      if (lErr) throw new Error(`work_log query failed: ${lErr.message}`)
      if (pErr) throw new Error(`work_order_parts query failed: ${pErr.message}`)
      logs = (l ?? []) as LogRow[]
      parts = (p ?? []) as PartRow[]
    }

    // 4. Build + send
    const { subject, html, text, stats } = buildDigest({ wos, logs, parts, since, now, days })

    if (dryRun) {
      return new Response(html, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
    }

    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html, text }),
    })
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      console.error('Resend API error:', errData)
      throw new Error((errData && errData.message) || `Resend HTTP ${res.status}`)
    }

    return json({ success: true, to, ...stats })
  } catch (err) {
    console.error('send-wo-weekly-summary error:', err)
    return json({ error: (err as Error).message || String(err) }, 500)
  }
})

// ── Digest builder ───────────────────────────────────────────────────────────

interface DigestInput {
  wos: ClosedWO[]
  logs: LogRow[]
  parts: PartRow[]
  since: Date
  now: Date
  days: number
}

function buildDigest({ wos, logs, parts, since, now, days }: DigestInput) {
  const logsByWO = groupBy(logs, (l) => l.wo_id)
  const partsByWO = groupBy(parts, (p) => p.wo_id)

  const rangeLabel = `${fmtDate(since)} – ${fmtDate(now)}`
  const subject = wos.length === 0
    ? `Weekly work order digest — nothing closed (${rangeLabel})`
    : `Weekly work order digest — ${wos.length} closed (${rangeLabel})`

  // Per-WO analysis
  const items = wos.map((wo) => {
    const all = logsByWO.get(wo.wo_id) ?? []
    const closeEntries = all.filter((l) => (l.entry_type ?? '') === 'Close')
    const workEntries  = all.filter((l) => (l.entry_type ?? '') !== 'Close')
    const closingNotes = closeEntries
      .map((l) => String(l.work_description ?? '').replace(/^CLOSING NOTES:\s*/i, '').trim())
      .filter(Boolean).join('\n')

    const loggedHours = round2(workEntries.reduce((s, l) => s + (num(l.hours) ?? 0), 0))
    const recordedHours = num(wo.total_hours)

    // Flags that help spot sloppy logging
    const flags: string[] = []
    if (workEntries.length === 0) flags.push('No work log entries')
    const blank = workEntries.filter((l) => !String(l.work_description ?? '').trim()).length
    if (blank > 0) flags.push(`${blank} entr${blank === 1 ? 'y' : 'ies'} with no description`)
    const zeroHrs = workEntries.filter((l) => (num(l.hours) ?? 0) <= 0).length
    if (workEntries.length > 0 && zeroHrs > 0) flags.push(`${zeroHrs} entr${zeroHrs === 1 ? 'y' : 'ies'} with 0 hours`)
    if (recordedHours != null && Math.abs(recordedHours - loggedHours) > 0.01) {
      flags.push(`Logged ${loggedHours} h but work order shows ${round2(recordedHours)} h`)
    }
    if (!closingNotes) flags.push('No closing notes')

    return { wo, workEntries, closingNotes, loggedHours, recordedHours, parts: partsByWO.get(wo.wo_id) ?? [], flags }
  })

  const totalHours = round2(items.reduce((s, i) => s + (i.recordedHours ?? i.loggedHours), 0))
  const lateCount  = items.filter((i) => yes(i.wo.was_late)).length
  const pmCount    = items.filter((i) => isPm(i.wo)).length
  const flagged    = items.filter((i) => i.flags.length > 0).length

  // ── HTML ──
  const summaryTiles = [
    ['Closed', String(wos.length)],
    ['Hours', String(totalHours)],
    ['Late', String(lateCount)],
    ['PM', String(pmCount)],
    ['Need a look', String(flagged)],
  ].map(([label, value]) => `
            <td style="padding:0 6px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8f9fa; border-radius:8px;">
                <tr><td style="padding:10px 12px; text-align:center;">
                  <div style="font-size:20px; font-weight:600; color:#212529;">${esc(value)}</div>
                  <div style="font-size:12px; color:#6c757d;">${esc(label)}</div>
                </td></tr>
              </table>
            </td>`).join('')

  const woBlocks = items.map(({ wo, workEntries, closingNotes, loggedHours, recordedHours, parts, flags }) => {
    const type = isPm(wo) ? `PM${wo.pm_id ? ` ${wo.pm_id}` : ''}` : (wo.request_id ? `Request ${wo.request_id}` : 'Manual')
    const equip = wo.asset_name ? `${wo.asset_name}${wo.asset_id ? ` (${wo.asset_id})` : ''}` : (wo.asset_id || 'No asset')
    const closedLine = `${fmtDateTime(wo.closed_date)}${wo.closed_by ? ` by ${wo.closed_by}` : ''}`
    const openLine = [
      wo.days_open != null && wo.days_open !== '' ? `${wo.days_open} days open` : '',
      yes(wo.was_late) ? 'LATE' : '',
    ].filter(Boolean).join(' · ')

    const facts: [string, string][] = [
      ['Equipment', equip],
      ['Priority', wo.priority || '—'],
      ['Type', type],
      ['Description', wo.description || '—'],
      ['Created', `${fmtDateTime(wo.created_at)}${wo.created_by ? ` by ${wo.created_by}` : ''}`],
      ['Due', fmtDateOnly(wo.due_date)],
      ['Closed', `${closedLine}${openLine ? ` — ${openLine}` : ''}`],
      ['Assigned to', wo.assigned_to || 'Unassigned'],
      ['Hours', recordedHours != null ? `${round2(recordedHours)} on work order · ${loggedHours} logged` : `${loggedHours} logged`],
    ]
    if (parts.length > 0) {
      facts.push(['Parts', parts.map((p) => `${p.quantity_used ?? 1} × ${p.part_name ?? ''}${yes(p.from_inventory) ? '' : ' (custom)'}`).join('; ')])
    }

    const factRows = facts.map(([k, v]) => `
                <tr>
                  <td style="padding:4px 0; color:#6c757d; font-size:13px; vertical-align:top; width:100px;">${esc(k)}</td>
                  <td style="padding:4px 0; color:#212529; font-size:13px; white-space:pre-wrap;">${esc(v)}</td>
                </tr>`).join('')

    const flagHtml = flags.length === 0 ? '' : `
              <p style="margin:8px 0 0; padding:8px 12px; background:#fff4e5; border-left:4px solid #b45309; color:#7c2d12; font-size:13px; line-height:1.5;">
                <strong>Check:</strong> ${flags.map(esc).join(' · ')}
              </p>`

    const logRows = workEntries.length === 0
      ? `<tr><td colspan="4" style="padding:8px 0; color:#6c757d; font-size:13px;">No work log entries.</td></tr>`
      : workEntries.map((l) => `
                  <tr>
                    <td style="padding:5px 8px 5px 0; color:#212529; font-size:13px; vertical-align:top; white-space:nowrap; border-bottom:1px solid #f1f3f5;">${esc(fmtDateTime(l.timestamp))}</td>
                    <td style="padding:5px 8px; color:#212529; font-size:13px; vertical-align:top; white-space:nowrap; border-bottom:1px solid #f1f3f5;">${esc(l.user_name ?? '')}</td>
                    <td style="padding:5px 8px; color:#212529; font-size:13px; vertical-align:top; text-align:right; white-space:nowrap; border-bottom:1px solid #f1f3f5;">${esc(String(round2(num(l.hours) ?? 0)))}</td>
                    <td style="padding:5px 0 5px 8px; color:${String(l.work_description ?? '').trim() ? '#212529' : '#b45309'}; font-size:13px; vertical-align:top; white-space:pre-wrap; border-bottom:1px solid #f1f3f5;">${esc(String(l.work_description ?? '').trim() || '(blank)')}</td>
                  </tr>`).join('')

    return `
          <tr>
            <td style="padding:0 24px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e9ecef; border-radius:8px;">
                <tr>
                  <td style="padding:12px 16px; background:#f8f9fa; border-bottom:1px solid #e9ecef; border-radius:8px 8px 0 0;">
                    <h2 style="margin:0; font-size:15px; font-weight:600; color:#212529;">${esc(wo.wo_id)} — ${esc(wo.asset_name || wo.description || '')}</h2>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${factRows}
                    </table>
                    ${flagHtml}

                    <h3 style="margin:14px 0 6px; font-size:13px; font-weight:600; color:#212529;">Closing notes</h3>
                    <p style="margin:0; font-size:13px; line-height:1.5; white-space:pre-wrap; color:${closingNotes ? '#212529' : '#6c757d'};">${esc(closingNotes || 'None entered.')}</p>

                    <h3 style="margin:14px 0 6px; font-size:13px; font-weight:600; color:#212529;">Work log (${workEntries.length})</h3>
                    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                      <caption style="text-align:left; font-size:0; line-height:0; color:transparent;">Work log for ${esc(wo.wo_id)}</caption>
                      <thead>
                        <tr>
                          ${th('When')}${th('Who')}${th('Hours', 'text-align:right;')}${th('Work done')}
                        </tr>
                      </thead>
                      <tbody>${logRows}
                      </tbody>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
  }).join('')

  const emptyBlock = wos.length === 0 ? `
          <tr>
            <td style="padding:0 24px 24px; color:#6c757d; font-size:14px;">No work orders were closed in this period.</td>
          </tr>` : ''

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0; padding:0; background:#f8f9fa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px; background:#ffffff; border-radius:12px; border:1px solid #e9ecef; overflow:hidden;">

          <tr>
            <td style="background:#166534; padding:20px 24px;">
              <h1 style="margin:0; color:#ffffff; font-size:16px; font-weight:600;">Weekly Work Order Digest</h1>
              <p style="margin:4px 0 0; color:#dcfce7; font-size:13px;">Closed ${esc(rangeLabel)} (last ${days} days)</p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 18px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>${summaryTiles}
                </tr>
              </table>
              <p style="margin:12px 6px 8px; color:#6c757d; font-size:13px; line-height:1.5;">
                Each work order below includes its full work log. Items marked <strong style="color:#7c2d12;">Check</strong> have missing entries, blank descriptions, zero-hour entries, hours that don't match, or no closing notes.
              </p>
            </td>
          </tr>
${emptyBlock}${woBlocks}
          <tr>
            <td style="padding:0 24px 24px; color:#6c757d; font-size:13px;">
              Open the Closed view in the CMMS: <a href="${APP_URL}" style="color:#1e40af;">${APP_URL}</a>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px; background:#f8f9fa; border-top:1px solid #e9ecef;">
              <p style="margin:0; color:#adb5bd; font-size:12px;">
                RICT CMMS — Robotics &amp; Industrial Controls Technician Program. Sent automatically every Friday at 4:00 PM; the address is set in Settings → Work Orders → Weekly Close Summary Email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  // ── Plain text ──
  const textLines: string[] = [
    'Weekly Work Order Digest',
    `Closed ${rangeLabel} (last ${days} days)`,
    '',
    `Closed: ${wos.length} · Hours: ${totalHours} · Late: ${lateCount} · PM: ${pmCount} · Need a look: ${flagged}`,
    '',
  ]
  if (wos.length === 0) textLines.push('No work orders were closed in this period.', '')
  for (const { wo, workEntries, closingNotes, loggedHours, recordedHours, parts, flags } of items) {
    const type = isPm(wo) ? `PM${wo.pm_id ? ` ${wo.pm_id}` : ''}` : (wo.request_id ? `Request ${wo.request_id}` : 'Manual')
    textLines.push(
      `== ${wo.wo_id} — ${wo.asset_name || wo.description || ''} ==`,
      `  Equipment: ${wo.asset_name || wo.asset_id || 'No asset'}${wo.asset_name && wo.asset_id ? ` (${wo.asset_id})` : ''}`,
      `  Priority: ${wo.priority || '—'} · Type: ${type}`,
      `  Description: ${wo.description || '—'}`,
      `  Created: ${fmtDateTime(wo.created_at)}${wo.created_by ? ` by ${wo.created_by}` : ''} · Due: ${fmtDateOnly(wo.due_date)}`,
      `  Closed: ${fmtDateTime(wo.closed_date)}${wo.closed_by ? ` by ${wo.closed_by}` : ''}${wo.days_open != null && wo.days_open !== '' ? ` · ${wo.days_open} days open` : ''}${yes(wo.was_late) ? ' · LATE' : ''}`,
      `  Assigned to: ${wo.assigned_to || 'Unassigned'}`,
      `  Hours: ${recordedHours != null ? `${round2(recordedHours)} on work order · ` : ''}${loggedHours} logged`,
    )
    if (parts.length > 0) textLines.push(`  Parts: ${parts.map((p) => `${p.quantity_used ?? 1} × ${p.part_name ?? ''}`).join('; ')}`)
    if (flags.length > 0) textLines.push(`  CHECK: ${flags.join(' · ')}`)
    textLines.push(`  Closing notes: ${closingNotes ? closingNotes.replace(/\n/g, '\n    ') : 'None entered.'}`)
    textLines.push(`  Work log (${workEntries.length}):`)
    if (workEntries.length === 0) textLines.push('    No work log entries.')
    for (const l of workEntries) {
      textLines.push(`    ${fmtDateTime(l.timestamp)} — ${l.user_name ?? ''} — ${round2(num(l.hours) ?? 0)} h — ${String(l.work_description ?? '').trim() || '(blank)'}`)
    }
    textLines.push('')
  }
  textLines.push(`Open the Closed view in the CMMS: ${APP_URL}`, '', '— RICT CMMS (automatic weekly digest)')

  return {
    subject,
    html,
    text: textLines.join('\n'),
    stats: { closed: wos.length, hours: totalHours, late: lateCount, pm: pmCount, flagged, since: since.toISOString() },
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function th(text: string, extra = ''): string {
  return `<th scope="col" style="padding:4px 8px 6px 0; color:#6c757d; font-size:12px; font-weight:600; text-align:left; border-bottom:1px solid #dee2e6; ${extra}">${esc(text)}</th>`
}

function esc(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  return m
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function yes(v: unknown): boolean {
  if (v === true || v === 1) return true
  return typeof v === 'string' && ['yes', 'y', 'true', 't', '1'].includes(v.trim().toLowerCase())
}

function isPm(wo: ClosedWO): boolean {
  return yes(wo.is_pm) && !!wo.pm_id
}

/** "Sep 18, 2026" in Chicago time */
function fmtDate(d: Date | string | null): string {
  if (!d) return '—'
  const dt = d instanceof Date ? d : new Date(d)
  if (isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Sep 18, 2026, 2:40 PM" in Chicago time */
function fmtDateTime(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return '—'
  return dt.toLocaleString('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** due_date may be a bare YYYY-MM-DD (a calendar date, not an instant) or a full timestamp */
function fmtDateOnly(d: string | null): string {
  if (!d) return '—'
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))
    return dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
  }
  return fmtDate(d)
}
