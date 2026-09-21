/**
 * RICT CMMS — send-schedule-change-email Edge Function
 *
 * Tells ONE student that an instructor changed their lab sign-ups from
 * Lab Signup → Admin Signup → "This student's week": hours removed and/or
 * hours moved to a different class. One email per action, listing every hour
 * touched — not one email per hour.
 *
 * Same sender, Resend secret and table-based layout as
 * send-closure-notification, so students see a familiar message.
 *
 * SECURITY — unlike the older notification functions, this one checks who is
 * calling. It is deployed with --no-verify-jwt (so CORS preflight works) and
 * then verifies the session itself, the same way send-push's direct path does:
 *   1. The Authorization bearer must be a real signed-in session (auth.getUser).
 *   2. That user's profiles.role must be Instructor or Super Admin. (A Work
 *      Study on an active temp Instructor grant has role = Instructor, so they
 *      pass exactly while the grant is live.)
 *   3. The recipient must be an existing profile's email — it cannot be used
 *      to mail arbitrary addresses.
 *   4. "Changed by" is taken from the CALLER'S profile, never from the request
 *      body, so it cannot be spoofed.
 *   A service-role bearer is also accepted (server-side callers / testing).
 *
 * Required Supabase secrets (all already exist):
 *   RESEND_API_KEY
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (provided by the platform)
 *
 * Deployment (from the repo root):
 *   npx supabase functions deploy send-schedule-change-email --no-verify-jwt
 *
 * Request body:
 *   {
 *     "studentEmail": "student@minnstate.edu",
 *     "weekLabel":    "Sep 21 – 27",                 // optional, display only
 *     "note":         "Moved these to the right class for you.",   // optional, ≤ 500 chars
 *     "statusLine":   "Signed up for 8 of 8 required lab hours this week.",  // optional
 *     "changes": [                                     // 1–60 entries
 *       { "type": "removed",       "date": "2026-09-22", "startTime": "08:00", "endTime": "09:00", "classId": "RICT1610", "isMakeup": false },
 *       { "type": "class_changed", "date": "2026-09-22", "startTime": "09:00", "endTime": "10:00", "fromClassId": "", "toClassId": "RICT1610" }
 *     ],
 *     "dryRun": true                                   // optional: return the HTML, send nothing
 *   }
 *
 * Returns: { sent: true, to } | { dryRun: true, subject, html, text } | { error }
 *
 * File: supabase/functions/send-schedule-change-email/index.ts
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const FROM_EMAIL = 'RICT CMMS <noreply@abctechllc.com>'
const APP_URL = 'https://rict-cmms.vercel.app/lab-signup'
const ALLOWED_ROLES = ['Instructor', 'Super Admin']
const MAX_CHANGES = 60
const MAX_NOTE = 500

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function bearerToken(req: Request): string {
  const h = req.headers.get('Authorization') ?? ''
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''
}

type Change = {
  type: 'removed' | 'class_changed'
  date: string
  startTime: string
  endTime: string
  classId?: string
  fromClassId?: string
  toClassId?: string
  isMakeup?: boolean
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase environment not configured')
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // ── Who is calling? ───────────────────────────────────────────────────────
    const bearer = bearerToken(req)
    let changedBy = 'An instructor'
    if (!bearer) return json({ error: 'Missing Authorization header' }, 401)
    if (bearer !== SUPABASE_SERVICE_ROLE_KEY) {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      })
      const { data: { user: callerUser }, error: callerErr } = await callerClient.auth.getUser()
      if (callerErr || !callerUser?.email) return json({ error: 'Invalid or expired session' }, 401)

      const { data: callerProfile, error: profileErr } = await admin
        .from('profiles')
        .select('email, role, first_name, last_name')
        .ilike('email', callerUser.email)
        .limit(5)
      // ilike treats "_" and "%" as wildcards; pin to the exact address.
      const me = (callerProfile || []).find((p: any) => String(p.email || '').toLowerCase() === callerUser.email!.toLowerCase())
      if (profileErr || !me) return json({ error: 'Could not verify caller profile' }, 403)
      if (!ALLOWED_ROLES.includes(String(me.role))) {
        return json({ error: 'Forbidden: only instructors can send schedule-change emails' }, 403)
      }
      const name = `${me.first_name || ''} ${me.last_name || ''}`.trim()
      if (name) changedBy = name
    }

    // ── Validate the request ──────────────────────────────────────────────────
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return json({ error: 'Body must be JSON' }, 400)

    const studentEmail = String(body.studentEmail || '').trim()
    if (!studentEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail)) {
      return json({ error: 'Missing or invalid `studentEmail`' }, 400)
    }
    const rawChanges = Array.isArray(body.changes) ? body.changes : []
    if (rawChanges.length === 0) return json({ error: 'Missing or empty `changes` array' }, 400)
    if (rawChanges.length > MAX_CHANGES) return json({ error: `Too many changes (max ${MAX_CHANGES})` }, 400)

    const changes: Change[] = []
    for (const c of rawChanges) {
      const type = c?.type === 'class_changed' ? 'class_changed' : c?.type === 'removed' ? 'removed' : null
      const date = String(c?.date || '').substring(0, 10)
      if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}/.test(String(c?.startTime || ''))) {
        return json({ error: 'Each change needs type (removed | class_changed), date (YYYY-MM-DD) and startTime (HH:MM)' }, 400)
      }
      changes.push({
        type, date,
        startTime: String(c.startTime), endTime: String(c.endTime || ''),
        classId: String(c.classId || ''), fromClassId: String(c.fromClassId || ''), toClassId: String(c.toClassId || ''),
        isMakeup: !!c.isMakeup,
      })
    }

    // Recipient must be a real profile — never an arbitrary address.
    const { data: studentRows, error: studentErr } = await admin
      .from('profiles')
      .select('email, first_name')
      .ilike('email', studentEmail)
      .limit(5)
    // ilike treats "_" and "%" as wildcards; pin to the exact address.
    const student = (studentRows || []).find((p: any) => String(p.email || '').toLowerCase() === studentEmail.toLowerCase())
    if (studentErr || !student) return json({ error: 'Recipient is not a CMMS user' }, 400)

    const weekLabel = String(body.weekLabel || '').substring(0, 60)
    const note = String(body.note || '').trim().substring(0, MAX_NOTE)
    const statusLine = String(body.statusLine || '').trim().substring(0, 300)

    // ── Build the message ─────────────────────────────────────────────────────
    const removed = mergeBlocks(changes.filter(c => c.type === 'removed'))
    const moved = mergeBlocks(changes.filter(c => c.type === 'class_changed'))
    const removedHours = changes.filter(c => c.type === 'removed').length
    const movedHours = changes.filter(c => c.type === 'class_changed').length

    const parts: string[] = []
    if (removedHours) parts.push(`${removedHours} hour${removedHours === 1 ? '' : 's'} removed`)
    if (movedHours) parts.push(`${movedHours} hour${movedHours === 1 ? '' : 's'} moved to another class`)
    const subject = `Your lab sign-ups were changed — ${parts.join(', ')}`

    const firstName = String(student.first_name || '').trim()
    const html = buildHtml({ firstName, changedBy, weekLabel, removed, moved, note, statusLine })
    const text = buildText({ firstName, changedBy, weekLabel, removed, moved, note, statusLine })

    if (body.dryRun === true) return json({ dryRun: true, subject, html, text })

    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [student.email], subject, html, text }),
    })
    if (!resendRes.ok) {
      const errData = await resendRes.json().catch(() => ({}))
      console.error('Resend API error for', student.email, errData)
      return json({ error: errData?.message || `Resend returned ${resendRes.status}` }, 502)
    }
    return json({ sent: true, to: student.email })
  } catch (err) {
    console.error('send-schedule-change-email error:', err)
    return json({ error: (err as Error)?.message || 'Unexpected error' }, 500)
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Block = { date: string; start: string; end: string; hours: number; from: string; to: string; isMakeup: boolean }

/** Back-to-back hours on the same day with the same class(es) read as one line. */
function mergeBlocks(list: Change[]): Block[] {
  const hhmm = (t: string) => {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/)
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
  }
  const rows = list
    .map(c => ({
      date: c.date, start: hhmm(c.startTime), end: hhmm(c.endTime),
      from: c.type === 'class_changed' ? (c.fromClassId || '') : (c.classId || ''),
      to: c.type === 'class_changed' ? (c.toClassId || '') : '',
      isMakeup: !!c.isMakeup,
    }))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
  const out: Block[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.date === r.date && last.end && last.end === r.start && last.from === r.from && last.to === r.to && last.isMakeup === r.isMakeup) {
      last.end = r.end
      last.hours += 1
    } else {
      out.push({ ...r, hours: 1 })
    }
  }
  return out
}

function lineFor(b: Block, kind: 'removed' | 'moved'): string {
  const when = `${formatDateShort(b.date)}, ${formatHour12(b.start)}${b.end ? ` – ${formatHour12(b.end)}` : ''} (${b.hours} hour${b.hours === 1 ? '' : 's'})`
  if (kind === 'moved') return `${when}: ${b.from || 'no class'} → ${b.to || 'no class'}`
  return `${when}${b.from ? ` · ${b.from}` : ''}${b.isMakeup ? ' · make-up hour' : ''}`
}

type MsgParts = { firstName: string; changedBy: string; weekLabel: string; removed: Block[]; moved: Block[]; note: string; statusLine: string }

function buildText(p: MsgParts): string {
  const out = [
    'Your Lab Sign-ups Were Changed',
    '',
    `Hi${p.firstName ? ` ${p.firstName}` : ''},`,
    '',
    `${p.changedBy} changed your lab sign-ups${p.weekLabel ? ` for the week of ${p.weekLabel}` : ''}.`,
  ]
  if (p.removed.length) { out.push('', 'REMOVED — you are no longer signed up for:'); p.removed.forEach(b => out.push(`  - ${lineFor(b, 'removed')}`)) }
  if (p.moved.length) { out.push('', 'MOVED TO A DIFFERENT CLASS — same time, now counted toward:'); p.moved.forEach(b => out.push(`  - ${lineFor(b, 'moved')}`)) }
  if (p.note) out.push('', `Note from ${p.changedBy}:`, `  ${p.note}`)
  if (p.statusLine) out.push('', `Where that leaves you: ${p.statusLine}`)
  out.push('', `Check your schedule: ${APP_URL}`, '', 'If you have questions about this change, please speak with your instructor.', '', 'RICT CMMS — Robotics & Industrial Controls Technician Program')
  return out.join('\n')
}

function buildHtml(p: MsgParts): string {
  const box = (title: string, lines: string[], colors: { bg: string; border: string; bar: string; head: string }) => `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                <tr>
                  <td style="background:${colors.bg}; border:1px solid ${colors.border}; border-left:4px solid ${colors.bar}; border-radius:8px; padding:14px 16px;">
                    <h2 style="margin:0 0 8px; color:${colors.head}; font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px;">${escapeHtml(title)}</h2>
                    <ul style="margin:0; padding:0 0 0 18px; color:#212529; font-size:14px; line-height:1.6;">
                      ${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('\n                      ')}
                    </ul>
                  </td>
                </tr>
              </table>`

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your lab sign-ups were changed</title>
</head>
<body style="margin:0; padding:0; background:#f8f9fa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:12px; border:1px solid #e9ecef; overflow:hidden;">
          <tr>
            <td style="background:#1e3a8a; padding:20px 24px;">
              <h1 style="margin:0; color:#ffffff; font-size:16px; font-weight:600;">Your Lab Sign-ups Were Changed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">Hi${p.firstName ? ` ${escapeHtml(p.firstName)}` : ''},</p>
              <p style="margin:0 0 16px; color:#495057; font-size:14px; line-height:1.5;">
                <strong>${escapeHtml(p.changedBy)}</strong> changed your lab sign-ups${p.weekLabel ? ` for the week of <strong>${escapeHtml(p.weekLabel)}</strong>` : ''}.
              </p>
              ${p.removed.length ? box('Removed — you are no longer signed up for', p.removed.map(b => lineFor(b, 'removed')), { bg: '#fff5f5', border: '#ffc9c9', bar: '#dc3545', head: '#991b1b' }) : ''}
              ${p.moved.length ? box('Moved to a different class — same time', p.moved.map(b => lineFor(b, 'moved')), { bg: '#eff6ff', border: '#bfdbfe', bar: '#1e4bbd', head: '#1e3a8a' }) : ''}
              ${p.note ? `
              <p style="margin:0 0 4px; color:#495057; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px;">Note from ${escapeHtml(p.changedBy)}</p>
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">${escapeHtml(p.note)}</p>` : ''}
              ${p.statusLine ? `
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;"><strong>Where that leaves you:</strong> ${escapeHtml(p.statusLine)}</p>` : ''}
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                <tr>
                  <td>
                    <a href="${APP_URL}" style="display:inline-block; background:#1e4bbd; color:#ffffff; text-decoration:none; padding:12px 18px; border-radius:6px; font-size:14px; font-weight:600;">Open Lab Signup</a>
                  </td>
                </tr>
              </table>
              <hr style="border:none; border-top:1px solid #e9ecef; margin:20px 0;">
              <p style="margin:0; color:#495057; font-size:13px; line-height:1.5;">If you have questions about this change, please speak with your instructor.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#f8f9fa; padding:16px 24px; border-top:1px solid #e9ecef;">
              <p style="margin:0; color:#6c757d; font-size:11px; text-align:center;">RICT CMMS — Robotics &amp; Industrial Controls Technician Program</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** Escape HTML special characters to prevent injection into the email body */
function escapeHtml(str: string): string {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 'HH:MM' → '1:00 PM' */
function formatHour12(timeStr: string): string {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/)
  if (!m) return String(timeStr || '')
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const dispH = h % 12 || 12
  return `${dispH}:${String(mm).padStart(2, '0')} ${ampm}`
}

/** 'YYYY-MM-DD' → 'Tue, Sep 22' (constructed at local noon — no zone shift) */
function formatDateShort(dateStr: string): string {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return dateStr || ''
  const dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
