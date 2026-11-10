/**
 * RICT CMMS — send-rejection-email Edge Function
 *
 * Sends a rejection notification email to a student via Resend.
 * Called from the useRejectionNotification hook as a fallback
 * to ensure students see rejection reasons even if they miss
 * the in-app notification.
 *
 * Required Supabase secrets:
 *   RESEND_API_KEY — your Resend API key (Full access)
 *
 * Deployment:
 *   supabase functions deploy send-rejection-email --no-verify-jwt
 *
 * File: supabase/functions/send-rejection-email/index.ts
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

    const {
      to,
      studentName,
      requestType,
      requestId,
      reason,
      rejectedBy,
      extraDetails,
    } = await req.json()

    if (!to || !reason) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: to, reason' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const subject = `${requestType || 'Request'} Rejected${requestId ? `: ${requestId}` : ''}`

    // Build a clean, accessible HTML email
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
            <td style="background:#dc3545; padding:20px 24px;">
              <h1 style="margin:0; color:#ffffff; font-size:16px; font-weight:600;">
                ${requestType || 'Request'} Rejected
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 16px; color:#212529; font-size:14px; line-height:1.5;">
                Hi${studentName ? ` ${studentName}` : ''},
              </p>

              <p style="margin:0 0 16px; color:#495057; font-size:14px; line-height:1.5;">
                Your <strong>${(requestType || 'request').toLowerCase()}</strong>${requestId ? ` (${requestId})` : ''} has been rejected.
              </p>

              <!-- Reason box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                <tr>
                  <td style="background:#fff5f5; border:1px solid #ffc9c9; border-left:4px solid #dc3545; border-radius:8px; padding:14px 16px;">
                    <p style="margin:0 0 4px; font-size:11px; font-weight:600; color:#c92a2a; text-transform:uppercase; letter-spacing:0.5px;">
                      Reason
                    </p>
                    <p style="margin:0; color:#495057; font-size:14px; line-height:1.5;">
                      ${escapeHtml(reason)}
                    </p>
                  </td>
                </tr>
              </table>

              ${extraDetails ? `
              <p style="margin:0 0 16px; color:#868e96; font-size:13px; line-height:1.5;">
                ${escapeHtml(extraDetails).replace(/\n/g, '<br>')}
              </p>
              ` : ''}

              ${rejectedBy ? `
              <p style="margin:0 0 16px; color:#868e96; font-size:13px;">
                Reviewed by: <strong>${escapeHtml(rejectedBy)}</strong>
              </p>
              ` : ''}

              <hr style="border:none; border-top:1px solid #e9ecef; margin:20px 0;">

              <p style="margin:0; color:#868e96; font-size:13px; line-height:1.5;">
                If you have questions about this decision, please speak with your instructor.
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
      `${requestType || 'Request'} Rejected${requestId ? `: ${requestId}` : ''}`,
      '',
      `Hi${studentName ? ` ${studentName}` : ''},`,
      '',
      `Your ${(requestType || 'request').toLowerCase()}${requestId ? ` (${requestId})` : ''} has been rejected.`,
      '',
      `Reason: ${reason}`,
      extraDetails ? `\n${extraDetails}` : '',
      rejectedBy ? `\nReviewed by: ${rejectedBy}` : '',
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
        to: [to],
        subject,
        html,
        text,
      }),
    })

    const resendData = await resendRes.json()

    if (!resendRes.ok) {
      console.error('Resend API error:', resendData)
      return new Response(
        JSON.stringify({ error: resendData.message || 'Resend API error', details: resendData }),
        { status: resendRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, id: resendData.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('send-rejection-email error:', err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/** Escape HTML special characters to prevent XSS in email body */
function escapeHtml(str) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
