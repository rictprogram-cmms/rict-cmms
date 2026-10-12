/**
 * RICT CMMS — send-wo-due-reminders Edge Function
 *
 * Once a day, reminds students about open work orders that are coming due.
 * Every student assigned to an open work order that is due within the
 * reminder window (Settings → Work Orders → "Due Date Reminder — Days Before",
 * default 7) gets:
 *
 *   • ONE email listing all of their work orders coming due, and
 *   • ONE bell notification (an `announcements` row, notification_type
 *     'wo_due_reminder'). The existing push-announcements trigger turns that
 *     row into a phone push for students who have push turned on.
 *
 * Each student is reminded once per work order per due date. The record of
 * what was sent lives in `wo_due_reminders`; if an instructor moves the due
 * date, the student is reminded again for the new date. A student added to a
 * work order after the others were reminded gets their own reminder on the
 * next run.
 *
 * Who is reminded
 *   • Everyone in work_order_assignments for the WO, plus work_orders.assigned_email
 *     (older WOs that predate the assignments table). Deduplicated.
 *   • Only Active profiles, never Instructors, never the super-admin account.
 *
 * Which work orders
 *   • Rows still in `work_orders` (closed ones move to work_orders_closed),
 *     status not Closed / Cancelled, with a due date from today through
 *     today + N days (America/Chicago calendar dates). Overdue WOs are not
 *     reminded — they already show as Late.
 *   • Work orders whose window started inside N days (High priority, Weekly
 *     PMs) are caught on the next daily run, so they still get one reminder.
 *   • Work orders generated from a Daily PM are skipped (due the next day,
 *     every day — a reminder would be noise).
 *   • Unassigned WOs are skipped and not recorded, so whoever picks one up
 *     later still gets a reminder.
 *
 * Who calls it
 *   • pg_cron (supabase/migrations/20261012_wo_due_reminders.sql) — every day
 *     at 12:00 and 13:00 UTC with body {"expectLocalHour":7}. Only the slot
 *     that lands on 7 AM America/Chicago proceeds, so exactly one fires
 *     whether Minnesota is on CDT or CST. Auth: `x-webhook-secret` header
 *     (WEBHOOK_SECRET, shared with send-push and send-wo-weekly-summary).
 *   • A manual test — POST with the service-role key as the bearer token or
 *     the webhook secret:
 *       { "dryRun": true }           → JSON preview of who would get what; sends
 *                                      nothing, records nothing
 *       { "dryRun": true, "html": true } → the first student's email as HTML
 *       { "force": true }            → ignore the hour check
 *       { "to": "you@sctcc.edu" }    → send every email to this address instead,
 *                                      skip the bell, record nothing (safe test)
 *       { "days": 10 }               → override the window for this run (1–60)
 *       { "today": "2026-10-12" }    → pretend it is this date (testing)
 *
 * Required Supabase secrets:
 *   RESEND_API_KEY   — Resend API key (already used by the other mail functions)
 *   WEBHOOK_SECRET   — shared with send-push; the cron job sends it
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-provided
 *
 * Deployment (from the repo root):
 *   npx supabase functions deploy send-wo-due-reminders --no-verify-jwt
 *
 * Dates: work_orders.due_date may be a bare YYYY-MM-DD or a fake-UTC
 * timestamp; either way its first 10 characters are the local calendar date.
 * "Today" is the America/Chicago calendar date.
 *
 * File: supabase/functions/send-wo-due-reminders/index.ts
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const WEBHOOK_SECRET            = Deno.env.get('WEBHOOK_SECRET') ?? ''
const RESEND_API_KEY            = Deno.env.get('RESEND_API_KEY') ?? ''

const FROM_EMAIL        = 'RICT CMMS <noreply@abctechllc.com>'
const SYSTEM_SENDER     = 'noreply@abctechllc.com'
const SYSTEM_NAME       = 'RICT CMMS'
const APP_URL           = 'https://rict-cmms.vercel.app/work-orders'
const SETTING_KEY       = 'wo_due_reminder_days'
const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'
const TIME_ZONE         = 'America/Chicago'
const DEFAULT_DAYS      = 7
const NOTIF_TYPE        = 'wo_due_reminder'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
}

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenWO {
  wo_id: string
  description: string | null
  priority: string | null
  status: string | null
  asset_id: string | null
  asset_name: string | null
  assigned_email: string | null
  due_date: string | null
  is_pm: boolean | string | null
  pm_id: string | null
}

interface DueWO extends OpenWO {
  dueDay: string      // YYYY-MM-DD
  daysLeft: number    // 0 = due today
}

interface Profile {
  email: string
  first_name: string | null
  last_name: string | null
  role: string | null
  status: string | null
}

interface StudentBatch {
  email: string
  firstName: string
  fullName: string
  wos: DueWO[]
}

// ── Auth helpers (same pattern as send-push / send-wo-weekly-summary) ────────

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
    const result = await runReminders(createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), body, new Date())
    if (result.htmlPreview != null) {
      return new Response(result.htmlPreview, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
    }
    return json(result.payload, result.status)
  } catch (err) {
    console.error('send-wo-due-reminders error:', err)
    return json({ error: (err as Error).message || String(err) }, 500)
  }
})

// ── Core (exported shape kept simple so it can be exercised with a mock client)

// deno-lint-ignore no-explicit-any
export async function runReminders(supabase: SupabaseClient | any, body: any, now: Date): Promise<{ status: number; payload: unknown; htmlPreview?: string }> {
  const dryRun   = body?.dryRun === true
  const wantHtml = body?.html === true
  const force    = body?.force === true
  const testTo   = String(body?.to ?? '').trim().toLowerCase()
  const expectLocalHour = body?.expectLocalHour == null ? null : clampInt(body.expectLocalHour, 0, 23, -1)

  if (testTo && !testTo.includes('@')) return { status: 400, payload: { error: '"to" is not an email address' } }

  // DST guard: the cron job fires at two UTC hours; only the one that lands on
  // the expected Chicago hour proceeds.
  if (expectLocalHour != null && !force) {
    const localHour = parseInt(now.toLocaleString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false }), 10) % 24
    if (localHour !== expectLocalHour) {
      return { status: 200, payload: { skipped: true, reason: `Local hour is ${localHour}, expected ${expectLocalHour}` } }
    }
  }

  // 1. Window length from settings (0 / blank = feature off)
  let days: number
  if (body?.days != null) {
    days = clampInt(body.days, 1, 60, DEFAULT_DAYS)
  } else {
    const { data: setting, error: setErr } = await supabase
      .from('settings').select('setting_value').eq('setting_key', SETTING_KEY).maybeSingle()
    if (setErr) throw new Error(`settings lookup failed: ${setErr.message}`)
    const raw = setting == null ? String(DEFAULT_DAYS) : String(setting.setting_value ?? '').trim()
    const n = parseInt(raw, 10)
    if (!raw || !isFinite(n) || n <= 0) {
      return { status: 200, payload: { skipped: true, reason: `Reminders are off — settings.${SETTING_KEY} is ${raw ? `"${raw}"` : 'blank'}` } }
    }
    days = Math.min(60, n)
  }

  const today = body?.today && /^\d{4}-\d{2}-\d{2}$/.test(String(body.today)) ? String(body.today) : chicagoToday(now)
  const lastDay = addDays(today, days)

  // 2. Open work orders due today … today+N
  const { data: woRows, error: woErr } = await supabase
    .from('work_orders')
    .select('wo_id, description, priority, status, asset_id, asset_name, assigned_email, due_date, is_pm, pm_id')
    .not('due_date', 'is', null)
  if (woErr) throw new Error(`work_orders query failed: ${woErr.message}`)

  let due: DueWO[] = ((woRows ?? []) as OpenWO[])
    .filter((w) => !['closed', 'cancelled', 'canceled'].includes(String(w.status ?? '').trim().toLowerCase()))
    .map((w) => ({ ...w, dueDay: String(w.due_date ?? '').substring(0, 10) }))
    .filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.dueDay) && w.dueDay >= today && w.dueDay <= lastDay)
    .map((w) => ({ ...w, daysLeft: diffDays(today, w.dueDay) }))

  // 3. Skip work orders generated from a Daily PM
  const pmIds = [...new Set(due.filter((w) => yes(w.is_pm) && w.pm_id).map((w) => String(w.pm_id)))]
  let skippedDailyPm = 0
  if (pmIds.length > 0) {
    const { data: pms, error: pmErr } = await supabase
      .from('pm_schedules').select('pm_id, frequency').in('pm_id', pmIds)
    if (pmErr) throw new Error(`pm_schedules query failed: ${pmErr.message}`)
    const daily = new Set(((pms ?? []) as { pm_id: string; frequency: string | null }[])
      .filter((p) => String(p.frequency ?? '').trim().toLowerCase() === 'daily')
      .map((p) => String(p.pm_id)))
    const before = due.length
    due = due.filter((w) => !(yes(w.is_pm) && w.pm_id && daily.has(String(w.pm_id))))
    skippedDailyPm = before - due.length
  }

  if (due.length === 0) {
    return { status: 200, payload: { skipped: true, reason: `No open work orders due ${today} – ${lastDay}`, days, today, skippedDailyPm } }
  }

  // 4. Assignees (junction table + legacy primary column)
  const woIds = due.map((w) => w.wo_id)
  const { data: asg, error: asgErr } = await supabase
    .from('work_order_assignments').select('wo_id, user_email').in('wo_id', woIds)
  if (asgErr) throw new Error(`work_order_assignments query failed: ${asgErr.message}`)

  const assigneesByWO = new Map<string, Set<string>>()
  const addAssignee = (wo: string, email: string | null) => {
    const e = String(email ?? '').trim().toLowerCase()
    if (!e || !e.includes('@')) return
    if (!assigneesByWO.has(wo)) assigneesByWO.set(wo, new Set())
    assigneesByWO.get(wo)!.add(e)
  }
  for (const a of (asg ?? []) as { wo_id: string; user_email: string | null }[]) addAssignee(a.wo_id, a.user_email)
  for (const w of due) addAssignee(w.wo_id, w.assigned_email)

  const allEmails = [...new Set([...assigneesByWO.values()].flatMap((s) => [...s]))]
  if (allEmails.length === 0) {
    return { status: 200, payload: { skipped: true, reason: 'Work orders are coming due but none are assigned', days, today, dueCount: due.length } }
  }

  // 5. Profiles — Active, not Instructor, not super-admin. Read all Active
  //    profiles (a few hundred at most) and match case-insensitively, since
  //    some rows store mixed-case emails.
  const { data: profs, error: profErr } = await supabase
    .from('profiles').select('email, first_name, last_name, role, status').eq('status', 'Active')
  if (profErr) throw new Error(`profiles query failed: ${profErr.message}`)
  const profileByEmail = new Map<string, Profile>()
  for (const p of (profs ?? []) as Profile[]) {
    if (p.email) profileByEmail.set(String(p.email).toLowerCase(), p)
  }
  const eligible = (email: string): Profile | null => {
    const p = profileByEmail.get(email)
    if (!p) return null
    if (String(p.status ?? '') !== 'Active') return null
    if (String(p.role ?? '') === 'Instructor') return null
    if (email === SUPER_ADMIN_EMAIL) return null
    return p
  }

  // 6. What has already been sent for these WOs
  const { data: sentRows, error: sentErr } = await supabase
    .from('wo_due_reminders').select('wo_id, due_date, recipient_email').in('wo_id', woIds)
  if (sentErr) throw new Error(`wo_due_reminders query failed: ${sentErr.message}`)
  const sentKey = (wo: string, day: string, email: string) => `${wo}|${day}|${email}`
  const alreadySent = new Set(((sentRows ?? []) as { wo_id: string; due_date: string; recipient_email: string }[])
    .map((r) => sentKey(r.wo_id, String(r.due_date).substring(0, 10), String(r.recipient_email).toLowerCase())))

  // 7. Group by student
  const batches = new Map<string, StudentBatch>()
  let skippedIneligible = 0
  for (const w of due) {
    for (const email of assigneesByWO.get(w.wo_id) ?? []) {
      if (alreadySent.has(sentKey(w.wo_id, w.dueDay, email))) continue
      const p = eligible(email)
      if (!p) { skippedIneligible++; continue }
      if (!batches.has(email)) {
        const first = String(p.first_name ?? '').trim()
        batches.set(email, {
          email,
          firstName: first || 'there',
          fullName: `${first} ${String(p.last_name ?? '').trim()}`.trim() || email,
          wos: [],
        })
      }
      batches.get(email)!.wos.push(w)
    }
  }
  for (const b of batches.values()) b.wos.sort((a, c) => a.dueDay.localeCompare(c.dueDay) || a.wo_id.localeCompare(c.wo_id))

  const list = [...batches.values()]
  if (list.length === 0) {
    return { status: 200, payload: { skipped: true, reason: 'Everyone with a work order coming due has already been reminded', days, today, dueCount: due.length, skippedIneligible, skippedDailyPm } }
  }

  // 8. Dry run → preview only
  if (dryRun) {
    if (wantHtml) return { status: 200, payload: null, htmlPreview: buildEmail(list[0], today).html }
    return {
      status: 200,
      payload: {
        dryRun: true, days, today, lastDay, skippedIneligible, skippedDailyPm,
        students: list.map((b) => ({ email: b.email, name: b.fullName, workOrders: b.wos.map((w) => ({ wo_id: w.wo_id, due: w.dueDay, daysLeft: w.daysLeft })) })),
      },
    }
  }

  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')

  // 9. Send. Claim log rows first (unique key stops a double send if two runs
  //    ever overlap), send the email, release the claim if the email fails.
  const results: { email: string; sent: number; error?: string; bell?: string }[] = []
  for (const b of list) {
    const toAddr = testTo || b.email
    let claimed: DueWO[] = b.wos

    if (!testTo) {
      const rows = b.wos.map((w) => ({ wo_id: w.wo_id, due_date: w.dueDay, recipient_email: b.email, days_left: w.daysLeft }))
      const { data: ins, error: insErr } = await supabase
        .from('wo_due_reminders')
        .upsert(rows, { onConflict: 'wo_id,due_date,recipient_email', ignoreDuplicates: true })
        .select('wo_id')
      if (insErr) { results.push({ email: b.email, sent: 0, error: `claim failed: ${insErr.message}` }); continue }
      const got = new Set(((ins ?? []) as { wo_id: string }[]).map((r) => r.wo_id))
      claimed = b.wos.filter((w) => got.has(w.wo_id))
      if (claimed.length === 0) { results.push({ email: b.email, sent: 0, error: 'already claimed by another run' }); continue }
    }

    const batch = { ...b, wos: claimed }
    const { subject, html, text } = buildEmail(batch, today)
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: [toAddr], subject, html, text }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error((errData && errData.message) || `Resend HTTP ${res.status}`)
      }
    } catch (e) {
      console.error(`Resend failed for ${b.email}:`, e)
      if (!testTo) {
        // Release the claim so tomorrow's run tries again (one delete per due date).
        for (const d of new Set(claimed.map((w) => w.dueDay))) {
          await supabase.from('wo_due_reminders').delete()
            .eq('recipient_email', b.email).eq('due_date', d)
            .in('wo_id', claimed.filter((w) => w.dueDay === d).map((w) => w.wo_id))
        }
      }
      results.push({ email: b.email, sent: 0, error: (e as Error).message })
      continue
    }

    // Bell + push (non-critical; the email already went)
    let bell = 'skipped (test send)'
    if (!testTo) {
      const n = await supabase.from('announcements').insert({
        recipient_email: b.email,
        sender_email: SYSTEM_SENDER,
        sender_name: SYSTEM_NAME,
        subject: bellSubject(claimed),
        body: bellBody(claimed),
        read: false,
        notification_type: NOTIF_TYPE,
        created_at: new Date().toISOString(),
      }).select('id')
      bell = n.error ? `failed: ${n.error.message}` : ((n.data ?? []).length === 1 ? 'ok' : 'not written')
      if (n.error) console.warn(`Bell insert failed for ${b.email}:`, n.error.message)
    }
    results.push({ email: b.email, sent: claimed.length, bell })
  }

  const sentStudents = results.filter((r) => r.sent > 0).length
  const failed = results.filter((r) => r.error && r.sent === 0 && r.error !== 'already claimed by another run')
  return {
    status: failed.length > 0 && sentStudents === 0 ? 500 : 200,
    payload: {
      success: failed.length === 0,
      test: !!testTo, days, today, lastDay,
      students: sentStudents,
      workOrders: results.reduce((s, r) => s + r.sent, 0),
      skippedIneligible, skippedDailyPm,
      results,
    },
  }
}

// ── Message builders ─────────────────────────────────────────────────────────

function whenLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'due today'
  if (daysLeft === 1) return 'due tomorrow'
  return `due in ${daysLeft} days`
}

function bellSubject(wos: DueWO[]): string {
  if (wos.length === 1) return `Work Order Due Soon: ${wos[0].wo_id} (${fmtDay(wos[0].dueDay)})`
  return `${wos.length} Work Orders Due Soon`
}

function bellBody(wos: DueWO[]): string {
  const lines = wos.map((w) => `${w.wo_id}${w.asset_name ? ` — ${w.asset_name}` : ''}: ${whenLabel(w.daysLeft)} (${fmtDay(w.dueDay)})`)
  return `${lines.join('\n')}\n\nLog your work and close the work order before the due date, or talk to your instructor if you need more time.`
}

function buildEmail(b: StudentBatch, today: string) {
  const soonest = b.wos[0]
  const subject = b.wos.length === 1
    ? `Reminder: work order ${soonest.wo_id} is ${whenLabel(soonest.daysLeft)} (${fmtDay(soonest.dueDay)})`
    : `Reminder: ${b.wos.length} work orders coming due — first one ${whenLabel(soonest.daysLeft)}`

  const rows = b.wos.map((w) => {
    const equip = w.asset_name ? `${w.asset_name}${w.asset_id ? ` (${w.asset_id})` : ''}` : (w.asset_id || '—')
    const urgent = w.daysLeft <= 1
    return `
                <tr>
                  <th scope="row" style="padding:8px 8px 8px 0; text-align:left; font-size:14px; font-weight:600; color:#212529; vertical-align:top; white-space:nowrap; border-bottom:1px solid #f1f3f5;">${esc(w.wo_id)}</th>
                  <td style="padding:8px; font-size:14px; color:#212529; vertical-align:top; border-bottom:1px solid #f1f3f5;">${esc(equip)}${w.description ? `<br><span style="color:#495057; font-size:13px;">${esc(truncate(w.description, 160))}</span>` : ''}</td>
                  <td style="padding:8px; font-size:14px; color:#212529; vertical-align:top; white-space:nowrap; border-bottom:1px solid #f1f3f5;">${esc(w.priority || '—')}</td>
                  <td style="padding:8px 0 8px 8px; font-size:14px; vertical-align:top; white-space:nowrap; border-bottom:1px solid #f1f3f5; color:${urgent ? '#9a3412' : '#212529'};">${urgent ? '<strong>' : ''}${esc(fmtDay(w.dueDay))}<br><span style="font-size:13px;">${esc(whenLabel(w.daysLeft))}</span>${urgent ? '</strong>' : ''}</td>
                </tr>`
  }).join('')

  const intro = b.wos.length === 1
    ? `This is a reminder that a work order assigned to you is ${esc(whenLabel(soonest.daysLeft))}.`
    : `This is a reminder that ${b.wos.length} work orders assigned to you are coming due.`

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
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px; background:#ffffff; border-radius:12px; border:1px solid #e9ecef; overflow:hidden;">

          <tr>
            <td style="background:#1e3a8a; padding:20px 24px;">
              <h1 style="margin:0; color:#ffffff; font-size:17px; font-weight:600;">Work order${b.wos.length === 1 ? '' : 's'} coming due</h1>
              <p style="margin:4px 0 0; color:#dbeafe; font-size:13px;">RICT CMMS reminder · ${esc(fmtDay(today))}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 24px 8px; color:#212529; font-size:15px; line-height:1.55;">
              <p style="margin:0 0 12px;">Hi ${esc(b.firstName)},</p>
              <p style="margin:0 0 16px;">${intro}</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <caption style="text-align:left; font-size:0; line-height:0; color:transparent;">Work orders assigned to you that are coming due</caption>
                <thead>
                  <tr>
                    ${th('Work order', true)}${th('Equipment')}${th('Priority')}${th('Due')}
                  </tr>
                </thead>
                <tbody>${rows}
                </tbody>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px 8px; color:#212529; font-size:14px; line-height:1.55;">
              <p style="margin:0 0 8px;">Before the due date, please:</p>
              <ul style="margin:0 0 12px; padding-left:20px;">
                <li style="margin-bottom:4px;">Log your work on the work order (time and what you did).</li>
                <li style="margin-bottom:4px;">Close the work order with closing notes when the job is finished.</li>
                <li>If you need more time or parts, talk to your instructor before it is late.</li>
              </ul>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 24px 24px;">
              <a href="${APP_URL}" style="display:inline-block; background:#1e40af; color:#ffffff; text-decoration:none; font-size:15px; font-weight:600; padding:12px 20px; border-radius:8px; min-height:20px;">Open Work Orders in the CMMS</a>
              <p style="margin:10px 0 0; color:#6c757d; font-size:13px;">Or copy this link: <a href="${APP_URL}" style="color:#1e40af;">${APP_URL}</a></p>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px; background:#f8f9fa; border-top:1px solid #e9ecef;">
              <p style="margin:0; color:#6c757d; font-size:12px; line-height:1.5;">
                RICT CMMS — Robotics &amp; Industrial Controls Technician Program, St. Cloud Technical &amp; Community College. You get one reminder per work order when it comes due. This mailbox is not monitored — reply to your instructor instead.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const textLines = [
    `Hi ${b.firstName},`,
    '',
    b.wos.length === 1
      ? `This is a reminder that a work order assigned to you is ${whenLabel(soonest.daysLeft)}.`
      : `This is a reminder that ${b.wos.length} work orders assigned to you are coming due.`,
    '',
    ...b.wos.map((w) => `  ${w.wo_id} — ${w.asset_name || w.asset_id || 'No equipment'} — ${w.priority || '—'} priority — due ${fmtDay(w.dueDay)} (${whenLabel(w.daysLeft)})${w.description ? `\n    ${truncate(w.description, 160)}` : ''}`),
    '',
    'Before the due date, please:',
    '  - Log your work on the work order (time and what you did).',
    '  - Close the work order with closing notes when the job is finished.',
    '  - If you need more time or parts, talk to your instructor before it is late.',
    '',
    `Open Work Orders: ${APP_URL}`,
    '',
    '— RICT CMMS (automatic reminder; this mailbox is not monitored)',
  ]

  return { subject, html, text: textLines.join('\n') }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function th(text: string, first = false): string {
  return `<th scope="col" style="padding:4px 8px 6px ${first ? '0' : '8px'}; color:#495057; font-size:12px; font-weight:600; text-align:left; border-bottom:1px solid #dee2e6;">${esc(text)}</th>`
}

function esc(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(s: string, n: number): string {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
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

/** Today's calendar date in America/Chicago as YYYY-MM-DD */
function chicagoToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function dayToUtc(d: string): number {
  const [y, m, dd] = d.split('-').map(Number)
  return Date.UTC(y, m - 1, dd)
}

function addDays(d: string, n: number): string {
  return new Date(dayToUtc(d) + n * 86400000).toISOString().substring(0, 10)
}

function diffDays(from: string, to: string): number {
  return Math.round((dayToUtc(to) - dayToUtc(from)) / 86400000)
}

/** "Mon, Oct 19" for a YYYY-MM-DD calendar date */
function fmtDay(d: string): string {
  return new Date(dayToUtc(d) + 12 * 3600000).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}
