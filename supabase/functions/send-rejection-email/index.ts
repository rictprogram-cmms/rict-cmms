/**
 * RICT CMMS — send-closure-notification Edge Function
 *
 * Sends a "your lab signup was cancelled" email to each student affected
 * when an instructor adds an hour-level closure to a day that already has
 * student signups (e.g. faculty meeting 2-3pm). One email per signup.
 *
 * Modeled on send-rejection-email — uses the same RESEND_API_KEY secret
 * and the same noreply@abctechllc.com sender, and follows the same code
 * style for parity.
 *
 * Required Supabase secrets:
 *   RESEND_API_KEY — your Resend API key (Full access)
 *
 * Deployment:
 *   npx supabase functions deploy send-closure-notification --no-verify-jwt
 *
 * Request body shape:
 *   {
 *     "date":   "2026-05-13",                  // YYYY-MM-DD (display only)
 *     "reason": "Faculty meeting",             // Closure-block reason
 *     "signups": [
 *       {
 *         "email":     "student@minnstate.edu",
 *         "name":      "Aaron R.",
 *         "startTime": "14:00:00",
 *         "endTime":   "15:00:00",
 *         "classId":   "RICT2360"              // optional
 *       }
 *     ]
 *   }
 *
 * Returns: { sent, failed, errors: [{ email, error }] }
 *
 * File: supabase/functions/send-closure-notification/index.ts
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const FROM_EMAIL = 'RICT CMMS <noreply@abctechllc.com>'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (!RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY not configured')
    }

    const { date, reason, signups } = await req.json()

    if (!Array.isArray(signups) || signups.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Missing or empty `signups` array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const niceDate = formatDateLong(date)
    const blockReason = (reason && String(reason).trim()) || 'Lab unavailable'

    let sent = 0
    let failed = 0
    const errors = []

    // Send sequentially. Typical batches are <20 students; this gives us
    // per-recipient error reporting which a Promise.all bulk call would not.
    for (const s of signups) {
      const recipient = s && s.email
      if (!recipient) {
        failed++
        errors.push({ email: '(missing)', error: 'No email address provided' })
        continue
      }

      try {
        const niceStart = formatHour12(s.startTime)
        const niceEnd   = formatHour12(s.endTime)
        const studentName = s.name || ''
        const classId = s.classId || ''

        const subject = `Lab signup cancelled — ${niceDate}, ${niceStart}`

        // Build HTML email — matches send-rejection-email's table-based layout
        // for maximum email-client compatibility (Outlook, Gmail web, etc).
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

          <!-- Header -->
          <tr>
            <td style="background:#7f1d1d; padding:20px 24px;">
              <h1 style="margin:0; color:#ffffff; font-size:16px; font-weight:600;">
                Lab Signup Cancelled
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">
                Hi${studentName ? ` ${escapeHtml(studentName)}` : ''},
              </p>

              <p style="margin:0 0 16px; color:#495057; font-size:14px; line-height:1.5;">
                An instructor has closed part of the lab for the time slot you signed up for. Your signup has been <strong>cancelled</strong>.
              </p>

              <!-- Cancellation details box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                <tr>
                  <td style="background:#fff5f5; border:1px solid #ffc9c9; border-left:4px solid #dc3545; border-radius:8px; padding:14px 16px;">
                    <p style="margin:0 0 6px; color:#991b1b; font-size:14px; font-weight:600;">
                      ${escapeHtml(niceDate)}
                    </p>
                    <p style="margin:0 0 6px; color:#7f1d1d; font-size:14px;">
                      ${escapeHtml(niceStart)} – ${escapeHtml(niceEnd)}
                    </p>
                    ${classId ? `
                    <p style="margin:0 0 6px; color:#495057; font-size:13px;">
                      <strong>Class:</strong> ${escapeHtml(classId)}
                    </p>
                    ` : ''}
                    <p style="margin:6px 0 0; padding-top:6px; border-top:1px solid #ffc9c9; font-size:11px; font-weight:600; color:#c92a2a; text-transform:uppercase; letter-spacing:0.5px;">
                      Reason
                    </p>
                    <p style="margin:4px 0 0; color:#495057; font-size:14px; line-height:1.5;">
                      ${escapeHtml(blockReason)}
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px; color:#495057; font-size:14px; line-height:1.5;">
                Please sign up for another time slot if you still need to make up the hours.
              </p>

              <!-- Action button -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                <tr>
                  <td>
                    <a href="https://rict-cmms.vercel.app/lab-signup" style="display:inline-block; background:#1e4bbd; color:#ffffff; text-decoration:none; padding:10px 18px; border-radius:6px; font-size:14px; font-weight:600;">
                      Open Lab Signup
                    </a>
                  </td>
                </tr>
              </table>

              <hr style="border:none; border-top:1px solid #e9ecef; margin:20px 0;">

              <p style="margin:0; color:#868e96; font-size:13px; line-height:1.5;">
                If you have questions about this cancellation, please speak with your instructor.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fa; padding:16px 24px; border-top:1px solid #e9ecef;">
              <p style="margin:0; color:#adb5bd; font-size:11px; text-align:center;">
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

        // Plain text fallback
        const text = [
          'Lab Signup Cancelled',
          '',
          `Hi${studentName ? ` ${studentName}` : ''},`,
          '',
          'An instructor has closed part of the lab for the time slot you signed up for. Your signup has been cancelled:',
          '',
          `  ${niceDate}`,
          `  ${niceStart} - ${niceEnd}`,
          classId ? `  Class: ${classId}` : '',
          `  Reason: ${blockReason}`,
          '',
          'Please sign up for another time slot if you still need to make up the hours.',
          '',
          'Open Lab Signup: https://rict-cmms.vercel.app/lab-signup',
          '',
          'If you have questions, please speak with your instructor.',
          '',
          '— RICT CMMS',
        ].filter(Boolean).join('\n')

        // Send via Resend API
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [recipient],
            subject,
            html,
            text,
          }),
        })

        if (!resendRes.ok) {
          const errData = await resendRes.json().catch(() => ({}))
          console.error('Resend API error for', recipient, errData)
          failed++
          errors.push({
            email: recipient,
            error: (errData && errData.message) || `HTTP ${resendRes.status}`,
          })
        } else {
          sent++
        }
      } catch (err) {
        console.error('send-closure-notification per-recipient error:', recipient, err)
        failed++
        errors.push({ email: recipient, error: err.message || String(err) })
      }
    }

    return new Response(
      JSON.stringify({ sent, failed, errors }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('send-closure-notification error:', err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/** Escape HTML special characters to prevent XSS in email body */
function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Format an HH:MM or HH:MM:SS time string as "1:00 PM" / "9:30 AM" etc. */
function formatHour12(timeStr) {
  if (!timeStr) return ''
  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/)
  if (!m) return String(timeStr)
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const dispH = h % 12 || 12
  return mm === 0
    ? `${dispH}:00 ${ampm}`
    : `${dispH}:${String(mm).padStart(2, '0')} ${ampm}`
}

/** Format a YYYY-MM-DD date string as "Wednesday, May 13, 2026" */
function formatDateLong(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return dateStr || ''
  // Construct as local-noon to avoid any timezone shift
  const dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0)
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}
