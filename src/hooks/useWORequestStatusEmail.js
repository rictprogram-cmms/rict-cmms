/**
 * RICT CMMS — useWORequestStatusEmail Hook
 *
 * Emails the person who submitted a work order request when an instructor
 * (a) approves it into a work order, or (b) closes that work order. Both
 * calls go through the `send-wo-status-email` Edge Function (Resend).
 *
 * The request is the source of truth for who to notify: `work_orders` and
 * `work_orders_closed` carry `request_id`, so on close we look the requester
 * back up from `work_order_requests`. Work orders with no `request_id`
 * (manual WOs, PM WOs) are silently skipped.
 *
 * Every failure is non-fatal and returns false — the approve / close itself
 * must never depend on email delivery.
 *
 * Usage:
 *   const { sendApprovedEmail, sendClosedEmail } = useWORequestStatusEmail()
 *   await sendApprovedEmail({ request, woId, assignedTo })
 *   await sendClosedEmail({ wo, closedDate, closingNotes })
 *
 * File: src/hooks/useWORequestStatusEmail.js
 */

import { useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { mustData } from '@/lib/supabaseData'

/** "Welding – Rm 112" from the request's department / location fields. */
export function formatRequestLocation(req) {
  if (!req) return ''
  return [req.department, req.location].map(s => (s || '').trim()).filter(Boolean).join(' – ')
}

/**
 * Description written onto the WO when a request is approved. Puts where /
 * what / who at the top so the student doing the work can see it without
 * opening the request. Requests without the public-form fields (legacy or
 * internal) come through as the plain description, unchanged.
 */
export function buildWODescriptionFromRequest(req) {
  if (!req) return ''
  const where = formatRequestLocation(req)
  const what = (req.equipment_description || '').trim()
  const problem = (req.description || '').trim()
  const contact = [req.email, req.phone].map(s => (s || '').trim()).filter(Boolean).join(', ')
  const who = (req.name || '').trim()

  const hasPublicFields = Boolean(where || what || req.source === 'public_form')
  if (!hasPublicFields) return problem

  const header = [where, what ? `${what} (not in asset list)` : ''].filter(Boolean).join(' · ')
  const lines = []
  if (header) lines.push(header)
  if (problem) lines.push(problem)
  if (who || contact) lines.push(`Requested by ${who || 'unknown'}${contact ? ` (${contact})` : ''}`)
  return lines.join('\n')
}

export function useWORequestStatusEmail() {
  const { profile } = useAuth()

  const actorName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : ''

  const invoke = useCallback(async (payload) => {
    try {
      const { data, error } = await supabase.functions.invoke('send-wo-status-email', { body: payload })
      if (error) {
        console.warn('[WORequestStatusEmail] Edge Function error:', error.message)
        return false
      }
      if (data && data.error) {
        console.warn('[WORequestStatusEmail] Send failed:', data.error)
        return false
      }
      return true
    } catch (err) {
      console.warn('[WORequestStatusEmail] Invoke exception:', err.message)
      return false
    }
  }, [])

  /**
   * @param {Object} p
   * @param {Object} p.request     — the work_order_requests row being approved
   * @param {string} p.woId        — the new WO id
   * @param {string} [p.assignedTo]— display name of the assignee, if any
   * @returns {Promise<boolean>}
   */
  const sendApprovedEmail = useCallback(async ({ request, woId, assignedTo = '' }) => {
    const to = (request?.email || '').trim().toLowerCase()
    if (!to || !to.includes('@')) return false
    return invoke({
      event: 'approved',
      to,
      requesterName: request.name || '',
      requestId: request.request_id || '',
      woId: woId || '',
      description: request.description || '',
      assetName: request.asset_name || request.equipment_description || '',
      location: formatRequestLocation(request),
      assignedTo: assignedTo || '',
      actorName,
    })
  }, [invoke, actorName])

  /**
   * @param {Object} p
   * @param {Object} p.wo            — the work order being closed (needs request_id)
   * @param {string} [p.closedDate]  — YYYY-MM-DD (local)
   * @param {string} [p.closingNotes]
   * @returns {Promise<boolean>}
   */
  const sendClosedEmail = useCallback(async ({ wo, closedDate = '', closingNotes = '' }) => {
    const requestId = (wo?.request_id || '').trim()
    if (!requestId) return false

    let request = null
    try {
      request = mustData(await supabase
        .from('work_order_requests')
        .select('request_id, name, email, description, asset_name, equipment_description, department, location')
        .eq('request_id', requestId)
        .maybeSingle(), 'work_order_requests.select')
    } catch (err) {
      console.warn('[WORequestStatusEmail] Requester lookup failed:', err.message)
      return false
    }

    const to = (request?.email || '').trim().toLowerCase()
    if (!to || !to.includes('@')) return false

    return invoke({
      event: 'closed',
      to,
      requesterName: request.name || '',
      requestId,
      woId: wo.wo_id || '',
      description: request.description || '',
      assetName: request.asset_name || request.equipment_description || wo.asset_name || '',
      location: formatRequestLocation(request),
      actorName,
      closedDate: closedDate || '',
      closingNotes: closingNotes || '',
    })
  }, [invoke, actorName])

  return { sendApprovedEmail, sendClosedEmail }
}
