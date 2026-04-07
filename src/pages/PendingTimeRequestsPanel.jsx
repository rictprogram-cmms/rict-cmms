/**
 * RICT CMMS — PendingTimeRequestsPanel
 *
 * Instructor-only panel that shows all pending time_entry_requests.
 * Instructors can approve (creates/edits time_clock entries) or reject
 * (with required reason via RejectionModal + notification to student).
 *
 * Used as a tab panel inside TimeCardsPage.
 *
 * Accessibility:
 *   - Semantic table with scope="col" headers and aria-sort
 *   - All interactive elements have visible focus rings
 *   - Status badges use aria-label for screen readers
 *   - RejectionModal handles its own WCAG compliance
 *
 * File: src/components/PendingTimeRequestsPanel.jsx
 */

import { useState, useCallback } from 'react'
import {
  Loader2, CheckCircle2, XCircle, Clock, User,
  Calendar, AlertTriangle, FileText, Inbox
} from 'lucide-react'
import { usePendingTimeRequests } from '@/hooks/useTimeCards'
import { useRejectionNotification } from '@/hooks/useRejectionNotification'
import RejectionModal from '@/components/RejectionModal'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime12(timeStr) {
  if (!timeStr) return '—'
  const parts = timeStr.split(':')
  const h = parseInt(parts[0])
  const m = parts[1] || '00'
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatHours(h) {
  const totalMins = Math.round((Number(h) || 0) * 60)
  if (totalMins <= 0) return '0h'
  const hrs = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hrs === 0) return `${mins}m`
  if (mins === 0) return `${hrs}h`
  return `${hrs}h ${mins}m`
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function PendingTimeRequestsPanel({ actions }) {
  const { requests, loading } = usePendingTimeRequests({ enabled: true })
  const { sendRejectionNotification } = useRejectionNotification()

  // Rejection modal state
  const [rejectTarget, setRejectTarget] = useState(null) // the request being rejected
  const [processingId, setProcessingId] = useState(null) // request_id currently being processed

  // ── Approve handler ─────────────────────────────────────────────────────────
  const handleApprove = useCallback(async (request) => {
    setProcessingId(request.request_id)
    try {
      const result = await actions.approveTimeRequest(request)
      if (!result?.success) {
        setProcessingId(null)
      }
      // On success, realtime will refresh the list and remove this request
    } catch {
      setProcessingId(null)
    }
  }, [actions])

  // ── Reject handler (called from RejectionModal's onConfirm) ─────────────────
  const handleReject = useCallback(async (reason) => {
    if (!rejectTarget) return

    const result = await actions.rejectTimeRequest(rejectTarget.request_id, reason)
    if (!result?.success) {
      throw new Error('Rejection failed')
    }

    // Send notification to the student
    await sendRejectionNotification({
      recipientEmail: rejectTarget.user_email,
      recipientName: rejectTarget.user_name || rejectTarget.user_email,
      requestType: 'Time Entry Request',
      requestId: rejectTarget.request_id,
      reason,
      extraDetails: `Request details: ${rejectTarget.entry_type} entry for ${rejectTarget.course_id || rejectTarget.class_id} on ${formatDate(rejectTarget.requested_date)} (${formatTime12(rejectTarget.start_time)} – ${formatTime12(rejectTarget.end_time)})`,
    })

    setRejectTarget(null)
    setProcessingId(null)
  }, [rejectTarget, actions, sendRejectionNotification])

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-12">
        <div className="flex items-center justify-center gap-2 text-surface-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading pending requests…
        </div>
      </div>
    )
  }

  if (requests.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-12">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
            <Inbox size={20} className="text-green-600" />
          </div>
          <p className="text-sm font-medium text-surface-700">No pending requests</p>
          <p className="text-xs text-surface-400 mt-1">All time entry requests have been reviewed.</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <FileText size={16} className="text-purple-600" />
            </div>
            <div>
              <h3 className="font-semibold text-surface-900">Pending Time Entry Requests</h3>
              <p className="text-xs text-surface-400">
                {requests.length} request{requests.length !== 1 ? 's' : ''} awaiting review
              </p>
            </div>
          </div>
        </div>

        {/* Request cards */}
        <div className="divide-y divide-surface-100">
          {requests.map(req => {
            const isProcessing = processingId === req.request_id
            const isNew = req.entry_type === 'New'
            const isEdit = req.entry_type === 'Edit'

            return (
              <div
                key={req.request_id}
                className={`px-5 py-4 transition-opacity ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}
              >
                {/* Top row: student info + type badge + timestamp */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-surface-100 flex items-center justify-center flex-shrink-0">
                      <User size={13} className="text-surface-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-surface-900 truncate">
                        {req.user_name || req.user_email}
                      </p>
                      <p className="text-[11px] text-surface-400 truncate">{req.user_email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        isNew
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-purple-100 text-purple-700'
                      }`}
                      aria-label={`Request type: ${req.entry_type}`}
                    >
                      {isNew ? 'New Entry' : 'Edit'}
                    </span>
                    <span className="text-[10px] text-surface-400" title={req.created_at}>
                      {timeAgo(req.created_at)}
                    </span>
                  </div>
                </div>

                {/* Details row */}
                <div className="ml-9 space-y-1.5">
                  {/* Class + Date + Time */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-600">
                    {(req.course_id || req.class_id) && (
                      <span className="flex items-center gap-1">
                        <FileText size={11} className="text-surface-400" />
                        {req.course_id || req.class_id}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Calendar size={11} className="text-surface-400" />
                      {formatDate(req.requested_date)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock size={11} className="text-surface-400" />
                      {formatTime12(req.start_time)} – {formatTime12(req.end_time)}
                    </span>
                    {req.total_hours > 0 && (
                      <span className="font-medium text-surface-700">
                        {formatHours(req.total_hours)}
                      </span>
                    )}
                  </div>

                  {/* Reason */}
                  {req.reason && (
                    <div className="bg-surface-50 rounded-lg px-3 py-2 text-xs text-surface-600 border border-surface-100">
                      <span className="font-medium text-surface-500">Reason: </span>
                      {req.reason}
                    </div>
                  )}

                  {/* Linked record (for edits) */}
                  {isEdit && req.time_clock_record_id && (
                    <p className="text-[10px] text-surface-400">
                      Editing record: {req.time_clock_record_id}
                    </p>
                  )}

                  {/* Request ID */}
                  <p className="text-[10px] text-surface-400">
                    {req.request_id}
                  </p>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => handleApprove(req)}
                      disabled={isProcessing || actions.saving}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                        bg-green-600 text-white rounded-lg hover:bg-green-700 active:bg-green-800
                        disabled:opacity-50 disabled:cursor-not-allowed
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2
                        transition-colors shadow-sm"
                      aria-label={`Approve request ${req.request_id}`}
                    >
                      {isProcessing ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <CheckCircle2 size={12} />
                      )}
                      Approve
                    </button>
                    <button
                      onClick={() => { setRejectTarget(req); setProcessingId(req.request_id) }}
                      disabled={isProcessing || actions.saving}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                        bg-white text-red-600 border border-red-200 rounded-lg
                        hover:bg-red-50 active:bg-red-100
                        disabled:opacity-50 disabled:cursor-not-allowed
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2
                        transition-colors"
                      aria-label={`Reject request ${req.request_id}`}
                    >
                      <XCircle size={12} />
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Rejection Modal ── */}
      <RejectionModal
        open={!!rejectTarget}
        title="Reject Time Entry Request"
        subtitle={rejectTarget
          ? `${rejectTarget.user_name || rejectTarget.user_email} — ${rejectTarget.entry_type} entry for ${rejectTarget.course_id || rejectTarget.class_id || 'Unknown'} on ${formatDate(rejectTarget?.requested_date)}`
          : ''
        }
        requestType="Time Entry Request"
        requestId={rejectTarget?.request_id || ''}
        recipientEmail={rejectTarget?.user_email || ''}
        recipientName={rejectTarget?.user_name || ''}
        onConfirm={handleReject}
        onClose={() => { setRejectTarget(null); setProcessingId(null) }}
      />
    </>
  )
}
