/**
 * RICT CMMS — useRejectionNotification Hook
 *
 * Provides a single `sendRejectionNotification()` function that:
 *   1. Inserts a rejection notification into the `announcements` table
 *      (powers the NotificationBell in-app)
 *   2. Logs the rejection to `audit_log`
 *   3. Sends a rejection email via Resend (Edge Function fallback)
 *
 * Usage:
 *   const { sendRejectionNotification } = useRejectionNotification()
 *
 *   await sendRejectionNotification({
 *     recipientEmail: 'student@example.com',
 *     recipientName: 'John D.',
 *     requestType: 'Time Entry Request',   // human-readable type
 *     requestId: 'TER000012',
 *     reason: 'Hours exceed the scheduled lab time.',
 *     notificationType: 'rejection',        // maps to announcements.notification_type
 *   })
 *
 * File: src/hooks/useRejectionNotification.js
 */

import { useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

// ── Human-readable labels for notification subjects ─────────────────────────
const REQUEST_TYPE_LABELS = {
  'Time Entry Request': 'Time Entry Request',
  'Access Request': 'Account Registration',
  'Work Order Request': 'Work Order Request',
  'Lab Signup Request': 'Lab Signup Change Request',
  'Temp Access Request': 'Temporary Access Request',
  'Purchase Order': 'Purchase Order',
}

export function useRejectionNotification() {
  const { profile } = useAuth()

  /**
   * Send a rejection notification to a student.
   *
   * @param {Object} params
   * @param {string} params.recipientEmail   — student's email
   * @param {string} params.recipientName    — student's display name (for audit)
   * @param {string} params.requestType      — e.g. 'Time Entry Request'
   * @param {string} params.requestId        — e.g. 'TER000012'
   * @param {string} params.reason           — instructor's rejection reason (required)
   * @param {string} [params.notificationType] — announcements.notification_type value (default: 'rejection')
   * @param {string} [params.extraDetails]   — any extra context appended to the body
   * @returns {Promise<boolean>} true if notification was sent successfully
   */
  const sendRejectionNotification = useCallback(async ({
    recipientEmail,
    recipientName = '',
    requestType = 'Request',
    requestId = '',
    reason,
    notificationType = 'rejection',
    extraDetails = '',
  }) => {
    if (!profile?.email || !recipientEmail || !reason) {
      console.warn('[RejectionNotification] Missing required params — skipping notification.')
      return false
    }

    const senderName = profile
      ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
      : 'Instructor'

    const label = REQUEST_TYPE_LABELS[requestType] || requestType
    const subject = `${label} Rejected${requestId ? `: ${requestId}` : ''}`

    // Build the notification body
    let body = `Your ${label.toLowerCase()}${requestId ? ` (${requestId})` : ''} has been rejected.`
    body += `\n\nReason: ${reason}`
    if (extraDetails) {
      body += `\n\n${extraDetails}`
    }
    body += `\n\nIf you have questions, please speak with your instructor.`

    try {
      // ── 1. Insert in-app notification (announcements table) ─────────────
      const { error: notifError } = await supabase.from('announcements').insert({
        recipient_email: recipientEmail.toLowerCase(),
        sender_email: profile.email,
        sender_name: senderName,
        subject,
        body,
        read: false,
        notification_type: notificationType,
        created_at: new Date().toISOString(),
      })

      if (notifError) {
        console.error('[RejectionNotification] Failed to insert notification:', notifError)
        // Non-fatal — continue to audit log and email
      }

      // ── 2. Audit log ───────────────────────────────────────────────────
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
          action: 'Reject',
          entity_type: requestType,
          entity_id: requestId || 'N/A',
          details: `Rejected ${label} for ${recipientName || recipientEmail}. Reason: ${reason}`,
        })
      } catch (auditErr) {
        // Audit log failure is non-critical
        console.warn('[RejectionNotification] Audit log insert failed:', auditErr.message)
      }

      // ── 3. Email fallback via Resend Edge Function ────────────────────
      try {
        const { error: fnError } = await supabase.functions.invoke('send-rejection-email', {
          body: {
            to: recipientEmail.toLowerCase(),
            studentName: recipientName,
            requestType: label,
            requestId,
            reason,
            rejectedBy: senderName,
            extraDetails,
          },
        })
        if (fnError) {
          console.warn('[RejectionNotification] Email fallback failed:', fnError.message)
        }
      } catch (emailErr) {
        // Email failure is non-critical — in-app notification is the primary channel
        console.warn('[RejectionNotification] Email fallback error:', emailErr.message)
      }

      return !notifError
    } catch (err) {
      console.error('[RejectionNotification] Unexpected error:', err)
      return false
    }
  }, [profile])

  return { sendRejectionNotification }
}
