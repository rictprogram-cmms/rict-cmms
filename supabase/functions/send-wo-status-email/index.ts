/**
 * RICT CMMS — send-wo-status-email Edge Function
 *
 * Emails the person who submitted a work order request (typically faculty in
 * another department, via the public /request-work-order page) when:
 *
 *   event = 'approved'  → their request became a work order
 *   event = 'closed'    → that work order was completed
 *
 * Modeled on send-rejection-email — same RESEND_API_KEY secret, same
 * noreply@abctechllc.com sender, same table-based HTML layout for email
 * client compatibility.
 *
 * Required Supabase secrets:
 *   RESEND_API_KEY — your Resend API key (Full access)
 *
 * Deployment:
 *   npx supabase functions deploy send-wo-status-email --no-verify-jwt
 *
 * Request body shape:
 *   {
 *     "event":         "approved" | "closed",
 *     "to":            "jdoe@sctcc.edu",
 *     "requesterName": "Jane Doe",          // optional
 *     "requestId":     "REQ-0042",
 *     "woId":          "WO-1234",
 *     "description":   "Won't strike an arc", // original request text (optional)
 *     "assetName":     "Lincoln MIG welder",  // optional
 *     "location":      "Welding – Rm 112",    // optional
 *     "assignedTo":    "Aaron B.",            // approved only, optional
 *     "actorName":     "Brad W.",             // instructor who approved / closed (optional)
 *     "closedDate":    "2026-09-03",          // closed only (YYYY-MM-DD, optional)
 *     "closingNotes":  "Replaced liner…"      // closed only, optional
 *   }
 *
 * Returns: { success: true } or { error }
 *
 * File: supabase/functions/send-wo-status-email/index.ts
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const FROM_EMAIL = 'RICT CMMS <noreply@abctechllc.com>'
const REQUEST_URL = 'https://rict-cmms.vercel.app/request-work-order'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (!RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY not configured')
    }

    const body = await req.json()
    const event = String(body.event || '').toLowerCase()
    const to = String(body.to || '').trim().toLowerCase()

    if (!to || !to.includes('@')) {
      return json({ error: 'Missing or invalid `to` address' }, 400)
    }
    if (event !== 'approved' && event !== 'closed') {
      return json({ error: '`event` must be "approved" or "closed"' }, 400)
    }

    const requesterName = str(body.requesterName)
    const requestId     = str(body.requestId)
    const woId          = str(body.woId)
    const description   = str(body.description)
    const assetName     = str(body.assetName)
    const location      = str(body.location)
    const assignedTo    = str(body.assignedTo)
    const actorName     = str(body.actorName)
    const closedDate    = formatDateLong(str(body.closedDate))
    const closingNotes  = str(body.closingNotes)

    const isApproved = event === 'approved'
    const headerColor = isApproved ? '#1e40af' : '#166534'
    const headerText  = isApproved ? 'Work Order Request Approved' : 'Work Order Completed'
    const subject = isApproved
      ? `Your request ${requestId || ''} is now work order ${woId || ''}`.replace(/\s+/g, ' ').trim()
      : `Work order ${woId || ''} for your request ${requestId || ''} is complete`.replace(/\s+/g, ' ').trim()

    const greeting = `Hi${requesterName ? ` ${escapeHtml(requesterName)}` : ''},`

    const intro = isApproved
      ? `Your maintenance request${requestId ? ` <strong>${escapeHtml(requestId)}</strong>` : ''} has been reviewed and approved by the RICT program. It is now work order${woId ? ` <strong>${escapeHtml(woId)}</strong>` : ''}.`
      : `Work order${woId ? ` <strong>${escapeHtml(woId)}</strong>` : ''} for your maintenance request${requestId ? ` <strong>${escapeHtml(requestId)}</strong>` : ''} has been completed${closedDate ? ` on ${escapeHtml(closedDate)}` : ''}.`

    const rows = []
    if (assetName)   rows.push(['Equipment', assetName])
    if (location)    rows.push(['Location', location])
    if (description) rows.push(['Reported problem', description])
    if (isApproved)  rows.push(['Assigned to', assignedTo || 'Not yet assigned — a student will be assigned soon'])
    if (!isApproved && closingNotes) rows.push(['Closing notes', closingNotes])
    if (actorName)   rows.push([isApproved ? 'Approved by' : 'Closed by', actorName])

    const detailRows = rows.map(([label, value]) => `
              <tr>
                <td style="padding:6px 0; color:#6c757d; font-size:13px; vertical-align:top; width:130px;">${escapeHtml(label)}</td>
                <td style="padding:6px 0; color:#212529; font-size:13px; white-space:pre-wrap;">${escapeHtml(value)}</td>
              </tr>`).join('')

    const outro = isApproved
      ? 'You will get another email when the work is finished. If the problem gets worse in the meantime, reply to the RICT instructors directly.'
      : 'If the problem comes back or the repair did not solve it, submit a new request and mention this work order number.'

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#f8f9fa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:12px; border:1px solid #e9ecef; overflow:hidden;">

          <tr>
            <td style="background:${headerColor}; padding:20px 24px;">
              <h1 style="margin:0; color:#ffffff; font-size:16px; font-weight:600;">${headerText}</h1>
            </td>
          </tr>

          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">${greeting}</p>
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">${intro}</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa; border-radius:8px; padding:12px 16px; margin:0 0 16px;">
                ${detailRows}
              </table>

              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">${outro}</p>
              <p style="margin:0; color:#6c757d; font-size:13px; line-height:1.5;">
                Submit another request: <a href="${REQUEST_URL}" style="color:#1e40af;">${REQUEST_URL}</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px; background:#f8f9fa; border-top:1px solid #e9ecef;">
              <p style="margin:0; color:#adb5bd; font-size:12px;">
                RICT CMMS — Robotics &amp; Industrial Controls Technician Program
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

    const text = [
      headerText,
      '',
      `Hi${requesterName ? ` ${requesterName}` : ''},`,
      '',
      isApproved
        ? `Your maintenance request ${requestId} has been reviewed and approved by the RICT program. It is now work order ${woId}.`
        : `Work order ${woId} for your maintenance request ${requestId} has been completed${closedDate ? ` on ${closedDate}` : ''}.`,
      '',
      ...rows.map(([label, value]) => `  ${label}: ${value}`),
      '',
      outro,
      '',
      `Submit another request: ${REQUEST_URL}`,
      '',
      '— RICT CMMS',
    ].join('\n')

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html, text }),
    })

    if (!resendRes.ok) {
      const errData = await resendRes.json().catch(() => ({}))
      console.error('Resend API error:', errData)
      throw new Error((errData && errData.message) || `Resend HTTP ${resendRes.status}`)
    }

    return json({ success: true })
  } catch (err) {
    console.error('send-wo-status-email error:', err)
    return json({ error: err.message || String(err) }, 500)
  }
})

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function str(v) {
  return v == null ? '' : String(v).trim()
}

/** Escape HTML special characters to prevent injection in the email body */
function escapeHtml(s) {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Format a YYYY-MM-DD date string as "Wednesday, May 13, 2026" */
function formatDateLong(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return dateStr || ''
  const dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0)
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
