/**
 * RICT CMMS - Volunteer Hours Page
 *
 * Student/Work Study view:
 *   - Progress ring showing hours completed vs required
 *   - Midpoint checkpoint status card
 *   - Table of all volunteer entries (approved, pending, rejected)
 *   - "Log Volunteer Hours" button → modal to submit manual entry
 *   - "Request Edit" button on time-clock entries → modal to request a time correction (requires instructor approval)
 *
 * Instructor view:
 *   - Summary cards: total students, complete, on track, at risk, behind
 *   - Table of all Work Study students with progress bars and status
 *   - Click to expand individual student entries
 *   - "Add Entry" button → instructor can manually add a Volunteer or Club Activity entry (no approval needed)
 *   - Edit button on each entry → instructor can directly update times (no approval needed)
 *   - Delete button on each entry → instructor can remove an entry with audit trail
 *   - Report button → printable report (all students OR individual)
 */

import React, { useState, useMemo, useEffect, useCallback, useId } from 'react'
import {
  Heart, Plus, Clock, CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronUp,
  RefreshCw, Send, X, Loader2, Calendar, Timer, Award, Target, TrendingUp,
  Filter, Search, Info, CircleAlert, Printer, FileText, ArrowLeft, Users, User,
  Edit3, FilePenLine, Save, Trash2
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { formatWindowDate } from '@/lib/volunteerWindow'
import { usePermissions } from '@/hooks/usePermissions'
import { useVolunteerData, useVolunteerOverview, useStudentVolunteerDetail } from '@/hooks/useVolunteerHours'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import toast from 'react-hot-toast'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0]
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function fmtDateShort(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function fmtTime(t) {
  if (!t) return ''
  const parts = t.split(':')
  const hr = parseInt(parts[0])
  const mn = parts[1] || '00'
  const ampm = hr >= 12 ? 'PM' : 'AM'
  const h12 = hr % 12 || 12
  return `${h12}:${mn} ${ampm}`
}

function fmtTimeFromISO(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const hr = d.getUTCHours()
  const mn = String(d.getUTCMinutes()).padStart(2, '0')
  const ampm = hr >= 12 ? 'PM' : 'AM'
  const h12 = hr % 12 || 12
  return `${h12}:${mn} ${ampm}`
}

/** Extract HH:MM (24hr) from a fake-UTC ISO timestamp */
function isoToTimeInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Extract YYYY-MM-DD from a fake-UTC ISO timestamp */
function isoToDateInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** Round decimal hours to the nearest minute */
function roundToMinute(h) {
  return Math.round((h || 0) * 60) / 60
}

/** Format decimal hours as "Xh Ym" (rounds to nearest minute first) */
function fmtHoursMin(h) {
  const totalMins = Math.round((h || 0) * 60)
  if (totalMins <= 0) return '0h'
  const hrs = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hrs === 0) return `${mins}m`
  if (mins === 0) return `${hrs}h`
  return `${hrs}h ${mins}m`
}

// ─── Shared UI Components ────────────────────────────────────────────────────

// Backdrop only. Each modal puts ref/role="dialog"/aria-labelledby on its own
// card div and calls useDialogA11y (focus trap, Escape, focus restore).
function ModalOverlay({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4" onClick={onClose}>
      {children}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-surface-500 mb-1">{label}</span>
      {children}
    </label>
  )
}

function StatusBadge({ status, size = 'sm' }) {
  const configs = {
    Approved: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
    Pending:  { bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200'   },
    Rejected: { bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200'     },
  }
  const c = configs[status] || configs.Pending
  const sizeClass = size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5'
  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${c.bg} ${c.text} ${c.border} ${sizeClass}`}>
      {status}
    </span>
  )
}

// ─── Progress Ring ───────────────────────────────────────────────────────────

function ProgressRing({ progress, approvedHours, totalRequired, size = 160 }) {
  const strokeWidth = 12
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (progress / 100) * circumference

  let color = '#ef4444'
  if (progress >= 100) color = '#22c55e'
  else if (progress >= 50) color = '#eab308'
  else if (progress >= 25) color = '#f97316'

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color}
          strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-surface-900">{fmtHoursMin(approvedHours)}</span>
        <span className="text-xs text-surface-400">of {fmtHoursMin(totalRequired)}</span>
      </div>
    </div>
  )
}

// ─── Mini Progress Bar (for instructor table) ────────────────────────────────

function MiniProgressBar({ progress, height = 6 }) {
  let color = 'bg-red-500'
  if (progress >= 100) color = 'bg-emerald-500'
  else if (progress >= 50) color = 'bg-amber-500'
  else if (progress >= 25) color = 'bg-orange-500'

  return (
    <div className="w-full rounded-full bg-surface-100" style={{ height }}>
      <div
        className={`rounded-full ${color} transition-all duration-500`}
        style={{ width: `${Math.min(100, progress)}%`, height }}
      />
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function VolunteerHoursPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Volunteer Hours')
  const isInstructor = hasPerm('view_all_students')

  return isInstructor ? <InstructorView /> : <StudentView />
}


// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT / WORK STUDY VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function StudentView() {
  const {
    entries, pendingEntries, rejectedEntries, pendingEditRequests,
    stats, settings, loading, saving, submitVolunteerEntry, submitClubActivityEntry, submitVolunteerEditRequest, refresh,
  } = useVolunteerData()

  const [showLogModal, setShowLogModal] = useState(false)
  const [showClubModal, setShowClubModal] = useState(false)
  const [editRequestEntry, setEditRequestEntry] = useState(null)

  // Build a set of record_ids that already have a pending edit request
  const pendingEditRecordIds = useMemo(() => {
    const set = new Set()
    ;(pendingEditRequests || []).forEach(r => {
      if (r.time_clock_record_id) set.add(r.time_clock_record_id)
    })
    return set
  }, [pendingEditRequests])

  const allEntries = useMemo(() => {
    const items = []

    entries.forEach(e => {
      const isClub = e.entry_type === 'Club Activity'
      items.push({
        id: e.record_id,
        rawEntry: e,
        date: e.punch_in,
        hours: parseFloat(e.total_hours) || 0,
        status: 'Approved',
        source: isClub ? 'Club Activity' : 'Time Clock',
        timeIn: fmtTimeFromISO(e.punch_in),
        timeOut: fmtTimeFromISO(e.punch_out),
        approvedBy: e.approved_by || 'Time Clock',
        description: e.description || '',
        hasPendingEdit: pendingEditRecordIds.has(e.record_id),
        isClubActivity: isClub,
      })
    })

    pendingEntries.forEach(e => {
      const isClub = e.entry_type === 'Club Activity' || e.class_id === 'CLUB_ACTIVITY'
      items.push({
        id: e.request_id,
        rawEntry: null,
        date: e.requested_date || e.created_at,
        hours: parseFloat(e.total_hours) || 0,
        status: 'Pending',
        source: isClub ? 'Club Activity' : 'Manual Entry',
        timeIn: fmtTime(e.start_time),
        timeOut: fmtTime(e.end_time),
        approvedBy: '',
        description: e.reason || '',
        hasPendingEdit: false,
        isClubActivity: isClub,
      })
    })

    rejectedEntries.forEach(e => {
      const isClub = e.entry_type === 'Club Activity' || e.class_id === 'CLUB_ACTIVITY'
      items.push({
        id: e.request_id,
        rawEntry: null,
        date: e.requested_date || e.created_at,
        hours: parseFloat(e.total_hours) || 0,
        status: 'Rejected',
        source: isClub ? 'Club Activity' : 'Manual Entry',
        timeIn: fmtTime(e.start_time),
        timeOut: fmtTime(e.end_time),
        approvedBy: e.reviewed_by || '',
        description: e.reason || '',
        rejectionReason: e.rejection_reason || '',
        hasPendingEdit: false,
        isClubActivity: isClub,
      })
    })

    items.sort((a, b) => new Date(b.date) - new Date(a.date))
    return items
  }, [entries, pendingEntries, rejectedEntries, pendingEditRecordIds])

  const handleLogSubmit = async (date, startTime, endTime, reason) => {
    const result = await submitVolunteerEntry(date, startTime, endTime, reason)
    if (result?.success) setShowLogModal(false)
  }

  const handleClubSubmit = async (date, startTime, endTime, reason) => {
    const result = await submitClubActivityEntry(date, startTime, endTime, reason)
    if (result?.success) setShowClubModal(false)
  }

  const handleEditRequestSubmit = async (entry, newStartTime, newEndTime, reason) => {
    const result = await submitVolunteerEditRequest(entry, newStartTime, newEndTime, reason)
    if (result?.success) setEditRequestEntry(null)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin text-brand-500" size={32} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <Heart size={20} className="text-purple-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Volunteer Hours</h1>
            <p className="text-sm text-surface-400">
              {settings.currentSemester || 'Current Semester'}
              {settings.includesBreak && settings.countStart && (
                <span className="block text-xs text-surface-400">
                  Counting hours from {formatWindowDate(settings.countStart)} — includes the break before this semester
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={refresh} aria-label="Refresh" className="p-2 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center" title="Refresh">
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button
            onClick={() => setShowClubModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            <Plus size={16} aria-hidden="true" /> Log Club Hours
          </button>
          <button
            onClick={() => setShowLogModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            <Plus size={16} aria-hidden="true" /> Log Volunteer Hours
          </button>
        </div>
      </div>

      {/* Stats Row */}
      {!stats.hasRequirement || stats.totalRequired === 0 ? (
        <div className="bg-white rounded-xl border border-surface-200 p-6 text-center">
          <Heart size={32} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
          <p className="text-sm font-medium text-surface-600">No volunteer hours required</p>
          <p className="text-xs text-surface-400 mt-1">None of your current classes require volunteer hours this semester.</p>
        </div>
      ) : (
      <div className={`grid grid-cols-1 md:grid-cols-2 ${stats.midpointApplies && stats.secondHalfApplies ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-4`}>
        <div className="bg-white rounded-xl border border-surface-200 p-6 flex flex-col items-center">
          <ProgressRing progress={stats.progress} approvedHours={stats.approvedHours} totalRequired={stats.totalRequired} />
          <div className="mt-3 text-center">
            <p className="text-sm font-medium text-surface-700">
              {stats.isComplete ? (
                <span className="text-emerald-600 flex items-center gap-1 justify-center"><CheckCircle2 size={16} aria-hidden="true" /> Complete!</span>
              ) : (
                <>{fmtHoursMin(stats.remaining)} remaining</>
              )}
            </p>
            {stats.pendingHours > 0 && (
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1 justify-center">
                <Clock size={12} aria-hidden="true" /> {fmtHoursMin(stats.pendingHours)} pending approval
              </p>
            )}
          </div>
        </div>

        {stats.midpointApplies && (
        <div className="bg-white rounded-xl border border-surface-200 p-6">
          <div className="flex items-center gap-2 mb-3">
            <Target size={18} className="text-purple-500" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-surface-700">1st Half Checkpoint</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Requirement</span>
              <span className="text-sm font-medium text-surface-800">{stats.midpointRequired}h by Week {stats.midpointWeek}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Current Week</span>
              <span className="text-sm font-medium text-surface-800">Week {stats.currentWeek}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Status</span>
              <MidpointBadge status={stats.midpointStatus} />
            </div>
          </div>
        </div>
        )}

        {stats.secondHalfApplies && (
        <div className="bg-white rounded-xl border border-surface-200 p-6">
          <div className="flex items-center gap-2 mb-3">
            <Target size={18} className="text-indigo-500" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-surface-700">2nd Half Checkpoint</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Requirement</span>
              <span className="text-sm font-medium text-surface-800">{stats.secondHalfTarget}h (Weeks {stats.midpointWeek + 1}–{stats.midpointWeek * 2})</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Earned toward 2nd Half</span>
              <span className="text-sm font-bold text-indigo-600">{fmtHoursMin(stats.secondHalfHours)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Status</span>
              <SecondHalfBadge status={stats.secondHalfStatus} hours={stats.secondHalfHours} target={stats.secondHalfTarget} />
            </div>
          </div>
        </div>
        )}

        <div className="bg-white rounded-xl border border-surface-200 p-6">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-blue-500" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-surface-700">Summary</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Approved Hours</span>
              <span className="text-sm font-bold text-emerald-600">{fmtHoursMin(stats.approvedHours)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Pending Hours</span>
              <span className="text-sm font-medium text-amber-600">{fmtHoursMin(stats.pendingHours)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Semester Goal</span>
              <span className="text-sm font-medium text-surface-800">{fmtHoursMin(stats.totalRequired)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-surface-500">Progress</span>
              <span className="text-sm font-bold text-surface-800">{stats.progress}%</span>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* How to Log Hours Info */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-start gap-3">
        <Info size={16} className="text-blue-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="text-sm text-blue-800">
          <strong>Two ways to log volunteer hours:</strong> Use the <strong>Time Clock kiosk</strong> to punch in/out when volunteering on-site,
          or click <strong>"Log Volunteer Hours"</strong> above to manually submit hours for approval.
          If a time clock entry has an error, click the <strong>edit icon</strong> to request a correction.
        </div>
      </div>

      {/* Entries Table */}
      <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-surface-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-700">Volunteer Log</h3>
          <span className="text-xs text-surface-400">{allEntries.length} entries</span>
        </div>
        {allEntries.length === 0 ? (
          <div className="text-center py-12 text-surface-400">
            <Heart size={32} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
            <p className="text-sm">No volunteer hours logged yet</p>
            <p className="text-xs mt-1">Use the Time Clock or click "Log Volunteer Hours" to get started</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 text-left">
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase">Date</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase">Time</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-right">Hours</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase">Source</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase">Description</th>
                  <th scope="col" className="px-4 py-2.5 w-16 print:hidden"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {allEntries.map(e => (
                  <tr key={e.id} className="hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-2.5 text-surface-800 whitespace-nowrap">{fmtDate(e.date)}</td>
                    <td className="px-4 py-2.5 text-surface-600 whitespace-nowrap">{e.timeIn} – {e.timeOut}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-surface-800">{fmtHoursMin(e.hours)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        e.source === 'Time Clock' ? 'bg-blue-50 text-blue-700' :
                        e.source === 'Club Activity' ? 'bg-orange-50 text-orange-700' :
                        'bg-purple-50 text-purple-700'
                      }`}>
                        {e.source}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <StatusBadge status={e.status} size="xs" />
                        {e.hasPendingEdit && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-600 border border-orange-200 font-medium whitespace-nowrap">
                            Edit Pending
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-surface-500 text-xs max-w-[200px] truncate">
                      {e.rejectionReason ? (
                        <span className="text-red-600" title={`Rejected: ${e.rejectionReason}`}>
                          Rejected: {e.rejectionReason}
                        </span>
                      ) : (
                        e.description || '—'
                      )}
                    </td>
                    {/* Request Edit — only for time clock approved entries that don't already have a pending edit */}
                    <td className="px-4 py-2.5 print:hidden">
                      {e.source === 'Time Clock' && e.status === 'Approved' && !e.hasPendingEdit && (
                        <button
                          type="button"
                          onClick={() => setEditRequestEntry(e.rawEntry)}
                          className="p-1.5 rounded-lg text-surface-400 hover:text-purple-600 hover:bg-purple-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                          title="Request time correction"
                          aria-label={`Request time correction for ${e.dateDisplay || e.date || 'this entry'}`}
                        >
                          <FilePenLine size={14} aria-hidden="true" />
                        </button>
                      )}
                      {e.hasPendingEdit && (
                        <span className="text-[10px] text-orange-500" title="Edit request pending instructor review">
                          <Clock size={13} aria-hidden="true" />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showLogModal && (
        <LogVolunteerModal
          saving={saving}
          onSubmit={handleLogSubmit}
          onClose={() => setShowLogModal(false)}
        />
      )}

      {showClubModal && (
        <LogClubModal
          saving={saving}
          onSubmit={handleClubSubmit}
          onClose={() => setShowClubModal(false)}
        />
      )}

      {editRequestEntry && (
        <VolunteerEditRequestModal
          entry={editRequestEntry}
          saving={saving}
          onSubmit={handleEditRequestSubmit}
          onClose={() => setEditRequestEntry(null)}
        />
      )}
    </div>
  )
}


// ─── Midpoint Badge ──────────────────────────────────────────────────────────

function MidpointBadge({ status }) {
  const configs = {
    met:      { icon: CheckCircle2, label: 'Met',      bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
    on_track: { icon: TrendingUp,   label: 'On Track', bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200'    },
    at_risk:  { icon: AlertTriangle,label: 'At Risk',  bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200'   },
    overdue:  { icon: XCircle,      label: 'Overdue',  bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200'     },
  }
  const c = configs[status] || configs.on_track
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${c.bg} ${c.text} ${c.border}`}>
      <Icon size={12} /> {c.label}
    </span>
  )
}


// ─── Log Volunteer Hours Modal ───────────────────────────────────────────────

function LogVolunteerModal({ saving, onSubmit, onClose }) {
  const titleId = useId()
  const dialogRef = useDialogA11y(true, onClose)
  const [form, setForm] = useState({
    date: toDateStr(new Date()),
    startTime: '08:00',
    endTime: '16:00',
    reason: '',
  })

  const previewHours = useMemo(() => {
    if (!form.startTime || !form.endTime) return 0
    const pi = new Date(`2000-01-01T${form.startTime}:00`)
    const po = new Date(`2000-01-01T${form.endTime}:00`)
    const hrs = (po - pi) / 3600000
    return hrs > 0 ? Math.round(hrs * 60) / 60 : 0
  }, [form.startTime, form.endTime])

  const handleSubmit = () => {
    if (!form.reason.trim()) return
    if (previewHours <= 0) return
    onSubmit(form.date, form.startTime, form.endTime, form.reason)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 id={titleId} className="font-semibold text-surface-900 flex items-center gap-2">
              <Heart size={16} className="text-purple-500" aria-hidden="true" /> Log Volunteer Hours
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">Requires instructor approval</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <Field label="Date *">
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              max={toDateStr(new Date())}
              className="input text-sm"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start Time *">
              <input type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} className="input text-sm" />
            </Field>
            <Field label="End Time *">
              <input type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} className="input text-sm" />
            </Field>
          </div>
          {previewHours > 0 && (
            <div className="flex items-center gap-2 text-sm text-surface-600 bg-purple-50 rounded-lg px-3 py-2">
              <Clock size={14} className="text-purple-500" aria-hidden="true" /> <span className="font-medium">{previewHours} hours</span>
            </div>
          )}
          <Field label="Description *">
            <textarea
              value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="What volunteer work did you do?"
              rows={3}
              className="input text-sm resize-none"
            />
          </Field>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.reason.trim() || previewHours <= 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            <Send size={14} aria-hidden="true" /> Submit for Approval
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ─── Log Club Activity Hours Modal ──────────────────────────────────────────

function LogClubModal({ saving, onSubmit, onClose }) {
  const titleId = useId()
  const dialogRef = useDialogA11y(true, onClose)
  const [form, setForm] = useState({
    date: toDateStr(new Date()),
    startTime: '08:00',
    endTime: '16:00',
    reason: '',
  })

  const rawHours = useMemo(() => {
    if (!form.startTime || !form.endTime) return 0
    const pi = new Date(`2000-01-01T${form.startTime}:00`)
    const po = new Date(`2000-01-01T${form.endTime}:00`)
    const hrs = (po - pi) / 3600000
    return hrs > 0 ? Math.round(hrs * 60) / 60 : 0
  }, [form.startTime, form.endTime])

  // Only 0.25 hrs credited per actual hour
  const creditedHours = useMemo(() => Math.round(rawHours * 0.25 * 60) / 60, [rawHours])

  const handleSubmit = () => {
    if (!form.reason.trim()) return
    if (rawHours <= 0) return
    onSubmit(form.date, form.startTime, form.endTime, form.reason)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 id={titleId} className="font-semibold text-surface-900 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
              </span>
              Log Club Activity Hours
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">Requires instructor approval · 0.25 hrs credit per hour</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <Field label="Date *">
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              max={toDateStr(new Date())}
              className="input text-sm"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start Time *">
              <input type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} className="input text-sm" />
            </Field>
            <Field label="End Time *">
              <input type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} className="input text-sm" />
            </Field>
          </div>
          {rawHours > 0 && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-surface-500 flex items-center gap-1.5">
                  <Clock size={13} className="text-orange-400" aria-hidden="true" /> Actual time attended
                </span>
                <span className="font-medium text-surface-700">{rawHours}h</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-orange-700 font-medium flex items-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                  </svg>
                  Hours credited (0.25×)
                </span>
                <span className="font-bold text-orange-700">{creditedHours}h</span>
              </div>
            </div>
          )}
          <Field label="Description *">
            <textarea
              value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="What club activity did you attend?"
              rows={3}
              className="input text-sm resize-none"
            />
          </Field>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.reason.trim() || rawHours <= 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            <Send size={14} aria-hidden="true" /> Submit for Approval
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ─── Volunteer Edit Request Modal (Student) ───────────────────────────────────
// Student requests a correction to an existing time-clock volunteer punch.
// Submitted as time_entry_requests → entry_type='Edit', needs instructor approval.

function VolunteerEditRequestModal({ entry, saving, onSubmit, onClose }) {
  const titleId = useId()
  const dialogRef = useDialogA11y(true, onClose)
  const currentPunchIn  = isoToTimeInput(entry.punch_in)
  const currentPunchOut = isoToTimeInput(entry.punch_out)
  const currentDate     = isoToDateInput(entry.punch_in)
  const currentHours = entry.total_hours ? roundToMinute(Number(entry.total_hours)) : 0

  const [form, setForm] = useState({
    startTime: currentPunchIn,
    endTime:   currentPunchOut,
    reason:    '',
  })

  const previewHours = useMemo(() => {
    if (!form.startTime || !form.endTime) return 0
    const pi = new Date(`2000-01-01T${form.startTime}:00`)
    const po = new Date(`2000-01-01T${form.endTime}:00`)
    const hrs = (po - pi) / 3600000
    return hrs > 0 ? Math.round(hrs * 60) / 60 : 0
  }, [form.startTime, form.endTime])

  const hasChanges = form.startTime !== currentPunchIn || form.endTime !== currentPunchOut

  const handleSubmit = () => {
    if (!form.reason.trim() || !hasChanges || previewHours <= 0) return
    onSubmit(entry, form.startTime, form.endTime, form.reason)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 id={titleId} className="font-semibold text-surface-900 flex items-center gap-2">
              <FilePenLine size={16} className="text-purple-500" aria-hidden="true" /> Request Time Correction
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">An instructor will review your request</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={18} aria-hidden="true" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Current Entry Summary */}
          <div className="bg-surface-50 rounded-lg px-3 py-3 space-y-1">
            <div className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider mb-1">Current Entry</div>
            <div className="flex items-center gap-3 text-sm text-surface-600">
              <span><strong>Date:</strong> {fmtDate(entry.punch_in)}</span>
              <span><strong>Hours:</strong> {currentHours}h</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-surface-600">
              <span><strong>In:</strong> {fmtTimeFromISO(entry.punch_in)}</span>
              <span><strong>Out:</strong> {fmtTimeFromISO(entry.punch_out)}</span>
            </div>
            <div className="text-[10px] text-surface-400 mt-1">Record: {entry.record_id}</div>
          </div>

          {/* Proposed Changes */}
          <div className="border border-purple-200 rounded-lg px-3 py-3 bg-purple-50/30">
            <div className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-2">Proposed Correction</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="New Punch In *">
                <input
                  type="time"
                  value={form.startTime}
                  onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                  className={`input text-sm ${form.startTime !== currentPunchIn ? 'ring-2 ring-purple-300 border-purple-400' : ''}`}
                />
              </Field>
              <Field label="New Punch Out *">
                <input
                  type="time"
                  value={form.endTime}
                  onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                  className={`input text-sm ${form.endTime !== currentPunchOut ? 'ring-2 ring-purple-300 border-purple-400' : ''}`}
                />
              </Field>
            </div>
            {previewHours > 0 && hasChanges && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <Clock size={14} className="text-purple-500" aria-hidden="true" />
                <span className="text-surface-500">{fmtHoursMin(Number(currentHours))}</span>
                <span className="text-purple-500 font-medium">→</span>
                <span className="font-medium text-purple-700">{fmtHoursMin(previewHours)}</span>
                {previewHours > Number(currentHours) && (
                  <span className="text-[10px] text-green-600 font-medium bg-green-100 px-1.5 py-0.5 rounded-full">
                    +{fmtHoursMin(previewHours - Number(currentHours))}
                  </span>
                )}
                {previewHours < Number(currentHours) && (
                  <span className="text-[10px] text-red-600 font-medium bg-red-100 px-1.5 py-0.5 rounded-full">
                    -{fmtHoursMin(Number(currentHours) - previewHours)}
                  </span>
                )}
              </div>
            )}
          </div>

          <Field label="Reason for Correction *">
            <textarea
              value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="Why do you need to correct this time? (e.g., forgot to punch out on time)"
              rows={3}
              className="input text-sm resize-none"
            />
          </Field>
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.reason.trim() || !hasChanges || previewHours <= 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            <Send size={14} aria-hidden="true" /> Submit Request
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// INSTRUCTOR VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function InstructorView() {
  const { students, summary, settings, loading, refresh } = useVolunteerOverview()
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expandedStudent, setExpandedStudent] = useState(null)
  const [showReportModal, setShowReportModal] = useState(false)
  const [reportData, setReportData] = useState(null)

  const filteredStudents = useMemo(() => {
    let filtered = students
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase()
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q)
      )
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter(s => s.overallStatus === statusFilter)
    }
    return filtered
  }, [students, searchTerm, statusFilter])

  // If report is active, show report view instead
  if (reportData) {
    return <VolunteerReportView reportData={reportData} onClose={() => setReportData(null)} />
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin text-brand-500" size={32} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <Heart size={20} className="text-purple-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Volunteer Hours</h1>
            <p className="text-sm text-surface-400">
              {settings.currentSemester || 'Current Semester'} — Week {summary.currentWeek}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={refresh} aria-label="Refresh" className="p-2 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center" title="Refresh">
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button
            onClick={() => setShowReportModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            <FileText size={14} aria-hidden="true" /> Report
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <SummaryCard label="Total Students" value={summary.total}
          color="text-surface-700" bg="bg-surface-50" border="border-surface-200" />
        <SummaryCard label="Complete" value={summary.complete}
          color="text-emerald-700" bg="bg-emerald-50" border="border-emerald-200"
          icon={<CheckCircle2 size={14} aria-hidden="true" />} />
        <SummaryCard label="On Track" value={summary.onTrack}
          color="text-blue-700" bg="bg-blue-50" border="border-blue-200"
          icon={<TrendingUp size={14} aria-hidden="true" />} />
        <SummaryCard label="At Risk" value={summary.atRisk}
          color="text-amber-700" bg="bg-amber-50" border="border-amber-200"
          icon={<AlertTriangle size={14} aria-hidden="true" />} />
        <SummaryCard label="Behind" value={summary.behind}
          color="text-red-700" bg="bg-red-50" border="border-red-200"
          icon={<XCircle size={14} aria-hidden="true" />} />
      </div>

      {/* Requirements Info */}
      <div className="bg-purple-50 border border-purple-200 rounded-xl px-4 py-3 flex items-start gap-3">
        <Award size={16} className="text-purple-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="text-sm text-purple-800">
          <strong>Requirements:</strong> {settings.midpointHours}h per half
          &nbsp;·&nbsp; Based on enrolled classes with volunteer requirement
          &nbsp;·&nbsp; Currently Week {summary.currentWeek}
          {summary.noRequirement > 0 && (
            <span className="text-purple-500"> &nbsp;·&nbsp; {summary.noRequirement} student{summary.noRequirement !== 1 ? 's' : ''} with no requirement</span>
          )}
        </div>
      </div>

      {/* Search & Filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
          <input
            type="text"
            placeholder="Search students..."
            aria-label="Search students"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="input text-sm pl-9 w-full"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter size={14} className="text-surface-400" aria-hidden="true" />
          {['all', 'complete', 'on_track', 'at_risk', 'behind'].map(f => (
            <button
              key={f}
              type="button"
              aria-pressed={statusFilter === f}
              onClick={() => setStatusFilter(f)}
              className={`px-2.5 py-1 min-h-[44px] rounded-lg text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
                statusFilter === f
                  ? 'bg-purple-600 text-white'
                  : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
              }`}
            >
              {f === 'all' ? 'All' : f === 'on_track' ? 'On Track' : f === 'at_risk' ? 'At Risk' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Students Table */}
      <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
        {filteredStudents.length === 0 ? (
          <div className="text-center py-12 text-surface-400">
            <Heart size={32} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
            <p className="text-sm">
              {students.length === 0 ? 'No students found' : 'No students match the current filter'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 text-left">
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase">Student</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-center">Approved</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-center">Required</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-center">Pending</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase w-[140px]">Progress</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-center">1st Half</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-center">2nd Half</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-surface-500 uppercase text-center">Status</th>
                  <th scope="col" className="px-4 py-2.5 w-8"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {filteredStudents.map(s => (
                  <React.Fragment key={s.email}>
                    <tr
                      className="hover:bg-surface-50 transition-colors cursor-pointer"
                      onClick={() => setExpandedStudent(expandedStudent === s.email ? null : s.email)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-surface-800">{s.name}</div>
                        <div className="text-xs text-surface-400">{s.email}</div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-bold text-emerald-600">{fmtHoursMin(s.approvedHours)}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {s.totalRequired > 0 ? (
                          <span className="text-xs font-medium text-surface-600">{fmtHoursMin(s.totalRequired)}</span>
                        ) : (
                          <span className="text-xs text-surface-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {s.pendingHours > 0 ? (
                          <span className="text-amber-600 font-medium">{fmtHoursMin(s.pendingHours)}</span>
                        ) : (
                          <span className="text-surface-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <MiniProgressBar progress={s.progress} />
                          <span className="text-xs font-medium text-surface-500 w-8 text-right">{s.progress}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {s.midpointApplies ? <MidpointBadge status={s.midpointStatus} /> : <span className="text-xs text-surface-300">N/A</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {s.secondHalfApplies ? (
                          <SecondHalfBadge status={s.secondHalfStatus} hours={s.secondHalfHours} target={settings.midpointHours} />
                        ) : (
                          <span className="text-xs text-surface-300">N/A</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center"><OverallStatusBadge status={s.overallStatus} /></td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          aria-expanded={expandedStudent === s.email}
                          aria-label={`${expandedStudent === s.email ? 'Collapse' : 'Expand'} details for ${s.name}`}
                          onClick={ev => { ev.stopPropagation(); setExpandedStudent(expandedStudent === s.email ? null : s.email) }}
                          className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-surface-400 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        >
                          {expandedStudent === s.email
                            ? <ChevronUp size={16} aria-hidden="true" />
                            : <ChevronDown size={16} aria-hidden="true" />}
                        </button>
                      </td>
                    </tr>
                    {expandedStudent === s.email && (
                      <tr>
                        <td colSpan={9} className="bg-surface-50 px-0 py-0">
                          <StudentDetailPanel studentEmail={s.email} studentName={s.name} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Report Modal */}
      {showReportModal && (
        <VolunteerReportModal
          students={students}
          settings={settings}
          summary={summary}
          onClose={() => setShowReportModal(false)}
          onGenerate={(data) => { setShowReportModal(false); setReportData(data) }}
        />
      )}
    </div>
  )
}


// ─── Summary Card (Instructor) ───────────────────────────────────────────────

function SummaryCard({ label, value, color, bg, border, icon }) {
  return (
    <div className={`rounded-xl border ${border} ${bg} px-4 py-3`}>
      <div className={`text-2xl font-bold ${color} flex items-center gap-1.5`}>
        {icon} {value}
      </div>
      <div className="text-xs text-surface-500 mt-0.5">{label}</div>
    </div>
  )
}


// ─── Overall Status Badge ────────────────────────────────────────────────────

function OverallStatusBadge({ status }) {
  const configs = {
    complete: { label: 'Complete', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
    on_track: { label: 'On Track', bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200'   },
    at_risk:  { label: 'At Risk',  bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200'  },
    behind:   { label: 'Behind',   bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200'    },
  }
  const c = configs[status] || configs.on_track
  return (
    <span className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${c.bg} ${c.text} ${c.border}`}>
      {c.label}
    </span>
  )
}


// ─── Second Half Status Badge ───────────────────────────────────────────────

function SecondHalfBadge({ status, hours, target }) {
  const configs = {
    met:      { label: 'Met',         bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
    on_track: { label: 'On Track',    bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200'   },
    at_risk:  { label: 'At Risk',     bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200'  },
    overdue:  { label: 'Overdue',     bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200'    },
    pending:  { label: '—',           bg: 'bg-surface-50',  text: 'text-surface-400', border: 'border-surface-200' },
  }
  const c = configs[status] || configs.pending
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${c.bg} ${c.text} ${c.border}`}>
        {c.label}
      </span>
      {status !== 'pending' && (
        <span className="text-[10px] text-surface-400">{fmtHoursMin(hours)}/{fmtHoursMin(target)}</span>
      )}
    </div>
  )
}

function secondHalfStatusLabel(status) {
  const map = { met: '✓ Met', on_track: 'On Track', at_risk: 'At Risk', overdue: 'Overdue', pending: '—' }
  return map[status] || '—'
}


// ─── Student Detail Panel (expanded row in instructor table) ─────────────────

function StudentDetailPanel({ studentEmail, studentName }) {
  const {
    entries, pendingEntries, pendingEdits,
    loading, saving,
    instructorEditTimeClock, instructorEditRequest,
    instructorAddEntry, instructorDeleteTimeClock, instructorDeleteRequest,
    refresh,
  } = useStudentVolunteerDetail(studentEmail)

  const [editTarget, setEditTarget] = useState(null) // { type: 'timeclock' | 'request', entry }
  const [showAddModal, setShowAddModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null) // { type, raw, summary }

  if (loading) {
    return (
      <div className="px-8 py-6 flex items-center gap-2 text-surface-400">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading entries...
      </div>
    )
  }

  // Merge all entries for display
  const allEntries = []

  entries.forEach(e => {
    const isClub = e.entry_type === 'Club Activity'
    allEntries.push({
      id: e.record_id,
      type: 'timeclock',
      raw: e,
      date: e.punch_in,
      hours: parseFloat(e.total_hours) || 0,
      status: e.approval_status || 'Approved',
      source: isClub ? 'Club Activity' : 'Time Clock',
      timeIn: fmtTimeFromISO(e.punch_in),
      timeOut: fmtTimeFromISO(e.punch_out),
      description: e.description || '',
      approvedBy: e.approved_by || '',
      dateInput: isoToDateInput(e.punch_in),
      startTimeInput: isoToTimeInput(e.punch_in),
      endTimeInput: isoToTimeInput(e.punch_out),
      hasPendingEdit: pendingEdits.some(ed => ed.time_clock_record_id === e.record_id && ed.status === 'Pending'),
      isClubActivity: isClub,
    })
  })

  pendingEntries.forEach(e => {
    const isClub = e.entry_type === 'Club Activity' || e.class_id === 'CLUB_ACTIVITY'
    allEntries.push({
      id: e.request_id,
      type: 'request',
      raw: e,
      date: e.requested_date || e.created_at,
      hours: parseFloat(e.total_hours) || 0,
      status: e.status || 'Pending',
      source: isClub ? 'Club Activity' : 'Manual Entry',
      timeIn: fmtTime(e.start_time),
      timeOut: fmtTime(e.end_time),
      description: e.reason || '',
      approvedBy: e.reviewed_by || '',
      dateInput: e.requested_date || '',
      startTimeInput: (e.start_time || '').substring(0, 5),
      endTimeInput: (e.end_time || '').substring(0, 5),
      hasPendingEdit: false,
      isClubActivity: isClub,
    })
  })

  // Also show approved manual entries in detail panel
  // (useStudentVolunteerDetail now returns all statuses)
  allEntries.sort((a, b) => new Date(b.date) - new Date(a.date))

  const handleSaveEdit = async (type, id, raw, date, startTime, endTime) => {
    let result
    if (type === 'timeclock') {
      result = await instructorEditTimeClock(raw, date, startTime, endTime)
    } else {
      result = await instructorEditRequest(id, date, startTime, endTime)
    }
    if (result?.success) setEditTarget(null)
  }

  const handleAddSubmit = async (formData) => {
    const result = await instructorAddEntry(formData)
    if (result?.success) setShowAddModal(false)
  }

  const handleDeleteConfirm = async (reason) => {
    if (!deleteTarget) return
    let result
    if (deleteTarget.type === 'timeclock') {
      result = await instructorDeleteTimeClock(deleteTarget.raw, reason)
    } else {
      result = await instructorDeleteRequest(deleteTarget.raw, reason)
    }
    if (result?.success) setDeleteTarget(null)
  }

  return (
    <div className="px-8 py-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-xs font-semibold text-surface-500 uppercase">
            {studentName} — Volunteer Entries
          </h4>
          {pendingEdits.filter(ed => ed.status === 'Pending').length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 border border-orange-200 font-medium">
              {pendingEdits.filter(ed => ed.status === 'Pending').length} pending edit request{pendingEdits.filter(ed => ed.status === 'Pending').length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-600 text-white hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-1 transition-colors print:hidden min-h-[44px]"
          aria-label={`Add a new volunteer or club activity entry for ${studentName}`}
        >
          <Plus size={14} aria-hidden="true" /> Add Entry
        </button>
      </div>

      {allEntries.length === 0 ? (
        <p className="text-xs text-surface-400 py-2">No volunteer entries found for this semester</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left">
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium">Date</th>
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium">Time</th>
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium text-right">Hours</th>
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium">Source</th>
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium">Status</th>
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium">Description</th>
              <th scope="col" className="px-3 py-1.5 text-surface-400 font-medium">Approved By</th>
              <th scope="col" className="px-3 py-1.5 w-20 print:hidden"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-100">
            {allEntries.map(e => (
              <tr key={e.id} className={`hover:bg-white ${e.hasPendingEdit ? 'bg-orange-50/40' : ''}`}>
                <td className="px-3 py-1.5 text-surface-700 whitespace-nowrap">{fmtDate(e.date)}</td>
                <td className="px-3 py-1.5 text-surface-600 whitespace-nowrap">{e.timeIn} – {e.timeOut}</td>
                <td className="px-3 py-1.5 text-right font-medium text-surface-800">{fmtHoursMin(e.hours)}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    e.source === 'Time Clock' ? 'bg-blue-50 text-blue-700' :
                    e.source === 'Club Activity' ? 'bg-orange-50 text-orange-700' :
                    'bg-purple-50 text-purple-700'
                  }`}>
                    {e.source}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1 flex-wrap">
                    <StatusBadge status={e.status} size="xs" />
                    {e.hasPendingEdit && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-orange-100 text-orange-600 font-medium whitespace-nowrap">
                        Edit Pending
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-surface-500 max-w-[160px] truncate" title={e.description}>{e.description || '—'}</td>
                <td className="px-3 py-1.5 text-surface-500">{e.approvedBy || '—'}</td>
                <td className="px-3 py-1.5 print:hidden">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setEditTarget(e)}
                      className="inline-flex items-center justify-center w-7 h-8 rounded text-surface-300 hover:text-brand-600 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 transition-colors min-h-[44px]"
                      aria-label={`Edit ${e.source} entry from ${fmtDate(e.date)}`}
                      title="Edit this entry directly"
                    >
                      <Edit3 size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(e)}
                      className="inline-flex items-center justify-center w-7 h-8 rounded text-surface-300 hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 transition-colors min-h-[44px]"
                      aria-label={`Delete ${e.source} entry from ${fmtDate(e.date)}`}
                      title="Delete this entry"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Pending edit requests section */}
      {pendingEdits.filter(ed => ed.status === 'Pending').length > 0 && (
        <div className="mt-4 border-t border-surface-100 pt-3">
          <h5 className="text-[10px] font-semibold text-orange-600 uppercase tracking-wide mb-2">
            Student Edit Requests (Pending)
          </h5>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left">
                <th scope="col" className="px-3 py-1 text-surface-400 font-medium">Requested Date</th>
                <th scope="col" className="px-3 py-1 text-surface-400 font-medium">New Time</th>
                <th scope="col" className="px-3 py-1 text-surface-400 font-medium text-right">New Hours</th>
                <th scope="col" className="px-3 py-1 text-surface-400 font-medium">Original Record</th>
                <th scope="col" className="px-3 py-1 text-surface-400 font-medium">Reason</th>
                <th scope="col" className="px-3 py-1 w-20 print:hidden"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-orange-100">
              {pendingEdits.filter(ed => ed.status === 'Pending').map(ed => (
                <tr key={ed.request_id} className="bg-orange-50/40">
                  <td className="px-3 py-1.5 text-surface-700">{fmtDate(ed.requested_date)}</td>
                  <td className="px-3 py-1.5 text-surface-600">
                    {fmtTime(ed.start_time)} – {fmtTime(ed.end_time)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium text-surface-800">
                    {fmtHoursMin(ed.total_hours)}
                  </td>
                  <td className="px-3 py-1.5 text-surface-400 text-[10px]">{ed.time_clock_record_id || '—'}</td>
                  <td className="px-3 py-1.5 text-surface-500 max-w-[180px] truncate" title={ed.reason}>{ed.reason || '—'}</td>
                  <td className="px-3 py-1.5 print:hidden">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setEditTarget({
                          id: ed.request_id,
                          type: 'request',
                          raw: ed,
                          dateInput: ed.requested_date || '',
                          startTimeInput: (ed.start_time || '').substring(0, 5),
                          endTimeInput: (ed.end_time || '').substring(0, 5),
                          hours: parseFloat(ed.total_hours) || 0,
                        })}
                        className="inline-flex items-center justify-center w-7 h-8 rounded text-surface-300 hover:text-brand-600 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 transition-colors min-h-[44px]"
                        aria-label={`Edit pending edit request ${ed.request_id}`}
                        title="Edit this request"
                      >
                        <Edit3 size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget({
                          id: ed.request_id,
                          type: 'request',
                          raw: ed,
                          source: 'Edit Request',
                          date: ed.requested_date,
                          hours: parseFloat(ed.total_hours) || 0,
                          timeIn: fmtTime(ed.start_time),
                          timeOut: fmtTime(ed.end_time),
                        })}
                        className="inline-flex items-center justify-center w-7 h-8 rounded text-surface-300 hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 transition-colors min-h-[44px]"
                        aria-label={`Delete pending edit request ${ed.request_id}`}
                        title="Delete this request"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Instructor Direct Edit Modal */}
      {editTarget && (
        <InstructorEditVolunteerModal
          entry={editTarget}
          saving={saving}
          onSave={handleSaveEdit}
          onClose={() => setEditTarget(null)}
        />
      )}

      {/* Instructor Add Entry Modal */}
      {showAddModal && (
        <InstructorAddVolunteerModal
          studentName={studentName}
          studentEmail={studentEmail}
          saving={saving}
          onSave={handleAddSubmit}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* Instructor Delete Confirm Modal */}
      {deleteTarget && (
        <InstructorDeleteVolunteerModal
          entry={deleteTarget}
          studentName={studentName}
          saving={saving}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}


// ─── Instructor Direct Edit Modal ────────────────────────────────────────────
// Instructor edits a volunteer entry directly — no approval required.

// ─── Instructor Direct Edit Modal ────────────────────────────────────────────
// Instructor edits a volunteer entry directly — no approval required.
//
// WCAG 2.1 AA compliant:
//   - useDialogA11y handles Escape, focus trap, focus return
//   - role="dialog" + aria-modal + aria-labelledby + aria-describedby
//   - Required fields marked with * AND aria-required
//   - Live preview uses aria-live so screen readers announce hour changes
//   - 28×32 px minimum touch targets on action buttons
//   - focus-visible outlines on all interactive elements
//   - aria-hidden on decorative icons

function InstructorEditVolunteerModal({ entry, saving, onSave, onClose }) {
  const titleId = useId()
  const descId = useId()
  const previewId = useId()
  const dialogRef = useDialogA11y(true, onClose)

  const [form, setForm] = useState({
    date:      entry.dateInput || '',
    startTime: entry.startTimeInput || '',
    endTime:   entry.endTimeInput || '',
  })

  const previewHours = useMemo(() => {
    if (!form.startTime || !form.endTime) return 0
    const pi = new Date(`2000-01-01T${form.startTime}:00`)
    const po = new Date(`2000-01-01T${form.endTime}:00`)
    const hrs = (po - pi) / 3600000
    return hrs > 0 ? Math.round(hrs * 60) / 60 : 0
  }, [form.startTime, form.endTime])

  const originalHours = fmtHoursMin(entry.hours || 0)
  const hasChanges =
    form.date !== (entry.dateInput || '') ||
    form.startTime !== (entry.startTimeInput || '') ||
    form.endTime !== (entry.endTimeInput || '')

  const isValid = !!form.date && !!form.startTime && !!form.endTime && previewHours > 0

  const handleSave = () => {
    if (!isValid || !hasChanges || saving) return
    onSave(entry.type, entry.id, entry.raw, form.date, form.startTime, form.endTime)
  }

  const sourceLabel = entry.type === 'timeclock' ? 'Time Clock Entry' : 'Manual Request'

  return (
    <ModalOverlay onClose={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 id={titleId} className="font-semibold text-surface-900 flex items-center gap-2">
              <Edit3 size={16} className="text-brand-500" aria-hidden="true" /> Edit Volunteer Entry
            </h3>
            <p id={descId} className="text-xs text-surface-400 mt-0.5">{sourceLabel} — No approval required</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-surface-100 text-surface-400 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 min-h-[44px]"
            aria-label="Close dialog without saving"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Entry identity */}
          <div className="bg-surface-50 rounded-lg px-3 py-2.5 text-xs text-surface-500">
            <span className="font-medium text-surface-700">ID:</span> {entry.id}
            {entry.hours > 0 && (
              <span className="ml-3"><span className="font-medium text-surface-700">Current:</span> {originalHours}</span>
            )}
          </div>

          <Field label="Date *">
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="input text-sm"
              aria-required="true"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Punch In *">
              <input
                type="time"
                value={form.startTime}
                onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                className={`input text-sm ${form.startTime !== entry.startTimeInput ? 'ring-2 ring-brand-300 border-brand-400' : ''}`}
                aria-required="true"
              />
            </Field>
            <Field label="Punch Out *">
              <input
                type="time"
                value={form.endTime}
                onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                className={`input text-sm ${form.endTime !== entry.endTimeInput ? 'ring-2 ring-brand-300 border-brand-400' : ''}`}
                aria-required="true"
              />
            </Field>
          </div>

          {/* Live preview region (announced to screen readers) */}
          <div id={previewId} aria-live="polite" className="min-h-[32px]">
            {previewHours > 0 && hasChanges && (
              <div className="flex items-center gap-2 text-sm bg-brand-50 rounded-lg px-3 py-2">
                <Clock size={14} className="text-brand-500" aria-hidden="true" />
                {entry.hours > 0 && (
                  <>
                    <span className="text-surface-500">{originalHours}</span>
                    <span className="text-brand-500 font-medium" aria-hidden="true">→</span>
                    <span className="sr-only">changes to</span>
                  </>
                )}
                <span className="font-medium text-brand-700">{fmtHoursMin(previewHours)}</span>
              </div>
            )}

            {!hasChanges && (
              <div className="text-xs text-surface-400 text-center py-1">No changes made yet</div>
            )}

            {form.startTime && form.endTime && previewHours <= 0 && (
              <div className="flex items-center gap-2 text-sm bg-red-50 rounded-lg px-3 py-2 text-red-700">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>End time must be after start time</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 min-h-[32px] rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges || !isValid}
            aria-disabled={saving || !hasChanges || !isValid}
            aria-describedby={previewId}
            className="px-4 py-2 min-h-[32px] rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            <Save size={14} aria-hidden="true" /> Save Changes
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ─── Instructor Add Entry Modal ─────────────────────────────────────────────
// Instructor manually adds a new Volunteer or Club Activity entry directly into
// time_clock as already-approved. No approval workflow needed since the instructor
// is the one creating it.
//
// WCAG 2.1 AA compliant:
//   - useDialogA11y handles Escape, focus trap, focus return
//   - role="dialog" + aria-modal + aria-labelledby + aria-describedby
//   - Required fields marked with * AND aria-required
//   - Submit button has aria-disabled when form is invalid
//   - Live preview uses aria-live so screen readers announce hour changes
//   - 28×32 px minimum touch targets on action buttons
//   - focus-visible outlines on all interactive elements

function InstructorAddVolunteerModal({ studentName, studentEmail, saving, onSave, onClose }) {
  const titleId = useId()
  const descId = useId()
  const previewId = useId()
  const dialogRef = useDialogA11y(true, onClose)

  const [form, setForm] = useState({
    entryType: 'Volunteer',          // 'Volunteer' | 'Club Activity'
    date:      toDateStr(new Date()),
    startTime: '',
    endTime:   '',
    reason:    '',
  })

  const isClub = form.entryType === 'Club Activity'

  // Raw hours (from start/end) and credited hours (raw × 0.25 for Club, otherwise raw)
  const { rawHours, creditedHours } = useMemo(() => {
    if (!form.startTime || !form.endTime) return { rawHours: 0, creditedHours: 0 }
    const pi = new Date(`2000-01-01T${form.startTime}:00`)
    const po = new Date(`2000-01-01T${form.endTime}:00`)
    const hrs = (po - pi) / 3600000
    if (hrs <= 0) return { rawHours: 0, creditedHours: 0 }
    const raw = roundToMinute(hrs)
    const credited = isClub ? roundToMinute(raw * 0.25) : raw
    return { rawHours: raw, creditedHours: credited }
  }, [form.startTime, form.endTime, isClub])

  const reasonTrim = form.reason.trim()
  const isValid = !!form.date && !!form.startTime && !!form.endTime && rawHours > 0 && creditedHours > 0 && !!reasonTrim

  const handleSave = () => {
    if (!isValid || saving) return
    onSave({
      entryType: form.entryType,
      date:      form.date,
      startTime: form.startTime,
      endTime:   form.endTime,
      reason:    reasonTrim,
    })
  }

  const headerColor = isClub ? 'text-orange-500' : 'text-purple-500'
  const submitColor = isClub
    ? 'bg-orange-600 hover:bg-orange-700 focus-visible:ring-orange-400'
    : 'bg-purple-600 hover:bg-purple-700 focus-visible:ring-purple-400'

  return (
    <ModalOverlay onClose={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 id={titleId} className="font-semibold text-surface-900 flex items-center gap-2">
              <Plus size={16} className={headerColor} aria-hidden="true" /> Add Volunteer Entry
            </h3>
            <p id={descId} className="text-xs text-surface-400 mt-0.5">
              For {studentName} — Saved as approved (no workflow)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 min-h-[44px]"
            aria-label="Close dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Entry type selector */}
          <fieldset>
            <legend className="block text-xs font-medium text-surface-500 mb-1.5">Entry Type *</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Entry type">
              <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-offset-1 ${
                !isClub
                  ? 'border-purple-300 bg-purple-50 focus-within:ring-purple-400'
                  : 'border-surface-200 hover:bg-surface-50 focus-within:ring-surface-400'
              }`}>
                <input
                  type="radio"
                  name="entryType"
                  value="Volunteer"
                  checked={!isClub}
                  onChange={() => setForm(f => ({ ...f, entryType: 'Volunteer' }))}
                  className="sr-only"
                  aria-required="true"
                />
                <Heart size={14} className={!isClub ? 'text-purple-600' : 'text-surface-400'} aria-hidden="true" />
                <span className={`text-sm font-medium ${!isClub ? 'text-purple-700' : 'text-surface-600'}`}>Volunteer</span>
              </label>
              <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-offset-1 ${
                isClub
                  ? 'border-orange-300 bg-orange-50 focus-within:ring-orange-400'
                  : 'border-surface-200 hover:bg-surface-50 focus-within:ring-surface-400'
              }`}>
                <input
                  type="radio"
                  name="entryType"
                  value="Club Activity"
                  checked={isClub}
                  onChange={() => setForm(f => ({ ...f, entryType: 'Club Activity' }))}
                  className="sr-only"
                  aria-required="true"
                />
                <Users size={14} className={isClub ? 'text-orange-600' : 'text-surface-400'} aria-hidden="true" />
                <span className={`text-sm font-medium ${isClub ? 'text-orange-700' : 'text-surface-600'}`}>Club Activity</span>
              </label>
            </div>
            {isClub && (
              <p className="text-[11px] text-orange-600 mt-1.5 flex items-start gap-1">
                <Info size={11} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>Club Activity earns 0.25h credited per hour worked.</span>
              </p>
            )}
          </fieldset>

          {/* Date */}
          <Field label="Date *">
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="input text-sm"
              aria-required="true"
              max={toDateStr(new Date())}
            />
          </Field>

          {/* Times */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start Time *">
              <input
                type="time"
                value={form.startTime}
                onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                className="input text-sm"
                aria-required="true"
              />
            </Field>
            <Field label="End Time *">
              <input
                type="time"
                value={form.endTime}
                onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                className="input text-sm"
                aria-required="true"
              />
            </Field>
          </div>

          {/* Reason (required) */}
          <Field label="Reason *">
            <textarea
              value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder={isClub
                ? "e.g., Robotics club open house event"
                : "e.g., Helped with lab clean-up after hours"}
              rows={3}
              className="input text-sm resize-none"
              aria-required="true"
            />
          </Field>

          {/* Live preview (announced to screen readers) */}
          <div
            id={previewId}
            aria-live="polite"
            className="min-h-[40px]"
          >
            {rawHours > 0 && creditedHours > 0 && (
              <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${
                isClub ? 'bg-orange-50' : 'bg-purple-50'
              }`}>
                <Clock size={14} className={isClub ? 'text-orange-500' : 'text-purple-500'} aria-hidden="true" />
                {isClub ? (
                  <span className="text-surface-700">
                    <span className="text-surface-500">{fmtHoursMin(rawHours)} actual</span>
                    {' '}
                    <span className="text-orange-500 font-medium">→</span>
                    {' '}
                    <span className="font-semibold text-orange-700">{fmtHoursMin(creditedHours)} credited</span>
                  </span>
                ) : (
                  <span className="font-semibold text-purple-700">
                    {fmtHoursMin(creditedHours)} will be credited
                  </span>
                )}
              </div>
            )}
            {form.startTime && form.endTime && rawHours <= 0 && (
              <div className="flex items-center gap-2 text-sm bg-red-50 rounded-lg px-3 py-2 text-red-700">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>End time must be after start time</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 min-h-[32px] rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isValid || saving}
            aria-disabled={!isValid || saving}
            aria-describedby={previewId}
            className={`px-4 py-2 min-h-[32px] rounded-lg text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${submitColor}`}
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            <Plus size={14} aria-hidden="true" /> Add Entry
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ─── Instructor Delete Confirm Modal ────────────────────────────────────────
// Confirmation dialog for deleting a volunteer entry. Shows full entry summary
// so the instructor can verify what's about to be deleted before confirming.
// Reason field is optional but logged to audit_log when provided.
//
// WCAG 2.1 AA compliant:
//   - useDialogA11y handles Escape, focus trap, focus return
//   - role="alertdialog" (destructive action)
//   - aria-labelledby + aria-describedby
//   - Initial focus lands on Cancel (safer default for destructive actions)

function InstructorDeleteVolunteerModal({ entry, studentName, saving, onConfirm, onClose }) {
  const titleId = useId()
  const descId = useId()
  const dialogRef = useDialogA11y(true, onClose)

  const [reason, setReason] = useState('')

  const handleConfirm = () => {
    if (saving) return
    onConfirm(reason.trim())
  }

  // Build a human-readable description of what will be deleted.
  const dateLabel = entry.date ? fmtDate(entry.date) : '—'
  const timeLabel = (entry.timeIn || entry.timeOut) ? `${entry.timeIn || ''} – ${entry.timeOut || ''}` : ''
  const hoursLabel = entry.hours > 0 ? fmtHoursMin(entry.hours) : ''
  const sourceLabel = entry.source || (entry.type === 'timeclock' ? 'Time Clock' : 'Manual Entry')

  return (
    <ModalOverlay onClose={onClose}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 id={titleId} className="font-semibold text-surface-900 flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-500" aria-hidden="true" /> Delete Volunteer Entry
            </h3>
            <p id={descId} className="text-xs text-surface-400 mt-0.5">
              This action cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-surface-100 text-surface-400 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 min-h-[44px]"
            aria-label="Close dialog without deleting"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* Entry summary */}
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-900">
            <p className="font-medium mb-1">You are about to delete:</p>
            <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-xs">
              <dt className="text-red-700 font-medium">Student:</dt>
              <dd>{studentName}</dd>
              <dt className="text-red-700 font-medium">ID:</dt>
              <dd className="font-mono">{entry.id}</dd>
              <dt className="text-red-700 font-medium">Source:</dt>
              <dd>{sourceLabel}</dd>
              <dt className="text-red-700 font-medium">Date:</dt>
              <dd>{dateLabel}</dd>
              {timeLabel && (<>
                <dt className="text-red-700 font-medium">Time:</dt>
                <dd>{timeLabel}</dd>
              </>)}
              {hoursLabel && (<>
                <dt className="text-red-700 font-medium">Hours:</dt>
                <dd className="font-medium">{hoursLabel}</dd>
              </>)}
            </dl>
          </div>

          {/* Optional reason (logged to audit trail) */}
          <Field label="Reason (optional, recorded in audit log)">
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g., Duplicate entry, entered by mistake"
              rows={2}
              className="input text-sm resize-none"
            />
          </Field>
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 min-h-[32px] rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-surface-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={saving}
            aria-disabled={saving}
            className="px-4 py-2 min-h-[32px] rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            <Trash2 size={14} aria-hidden="true" /> Delete Entry
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// VOLUNTEER REPORT MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function VolunteerReportModal({ students, settings, summary, onClose, onGenerate }) {
  const titleId = useId()
  const dialogRef = useDialogA11y(true, onClose)
  const [mode, setMode] = useState('all') // 'all' | 'individual'
  const [selectedEmail, setSelectedEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })

  const sortedStudents = useMemo(() =>
    [...students].sort((a, b) => a.name.localeCompare(b.name)),
  [students])

  const handleGenerate = async () => {
    setLoading(true)
    setProgress({ current: 0, total: 0 })
    try {
      // Hours-counting window (includes preceding break) — see volunteerWindow.js
      const semStart = settings.countStart || settings.semesterStart || `${new Date().getFullYear()}-01-01`
      const semEnd = settings.countEnd || settings.semesterEnd || toDateStr(new Date())

      const targetStudents = mode === 'all'
        ? sortedStudents
        : sortedStudents.filter(s => s.email === selectedEmail)

      if (targetStudents.length === 0) {
        toast.error('No students found for selection.')
        return
      }

      setProgress({ current: 0, total: targetStudents.length })

      const emails = targetStudents.map(s => s.email)

      // Batch fetch: all volunteer time_clock entries for target students
      const tcData = mustData(await supabase
        .from('time_clock')
        .select('*')
        .in('user_email', emails)
        .eq('entry_type', 'Volunteer')
        .gte('punch_in', semStart + 'T00:00:00')
        .lte('punch_in', semEnd + 'T23:59:59')
        .order('punch_in', { ascending: false }), 'time_clock.select')

      // Batch fetch: all pending/approved manual volunteer requests for target students
      const reqData = mustData(await supabase
        .from('time_entry_requests')
        .select('*')
        .in('user_email', emails)
        .or('entry_type.eq.Volunteer,class_id.eq.VOLUNTEER')
        .order('created_at', { ascending: false }), 'time_entry_requests.select')

      // Build per-email entry maps
      const tcByEmail = {}
      const reqByEmail = {}
      emails.forEach(e => { tcByEmail[e] = []; reqByEmail[e] = [] })
      ;(tcData || []).forEach(r => { if (tcByEmail[r.user_email]) tcByEmail[r.user_email].push(r) })
      ;(reqData || []).filter(r => r.entry_type !== 'Edit').forEach(r => { if (reqByEmail[r.user_email]) reqByEmail[r.user_email].push(r) })

      // Build student report objects
      const studentReports = targetStudents.map((s, i) => {
        setProgress({ current: i + 1, total: targetStudents.length })

        const entries = []

        ;(tcByEmail[s.email] || []).forEach(e => entries.push({
          id: e.record_id,
          date: e.punch_in,
          hours: parseFloat(e.total_hours) || 0,
          status: e.approval_status || 'Approved',
          source: 'Time Clock',
          timeIn: fmtTimeFromISO(e.punch_in),
          timeOut: fmtTimeFromISO(e.punch_out),
          description: e.description || '',
          approvedBy: e.approved_by || 'Time Clock',
        }))

        ;(reqByEmail[s.email] || []).forEach(e => entries.push({
          id: e.request_id,
          date: e.requested_date || e.created_at,
          hours: parseFloat(e.total_hours) || 0,
          status: e.status || 'Pending',
          source: 'Manual Entry',
          timeIn: fmtTime(e.start_time),
          timeOut: fmtTime(e.end_time),
          description: e.reason || '',
          approvedBy: e.reviewed_by || '',
          rejectionReason: e.rejection_reason || '',
        }))

        entries.sort((a, b) => new Date(b.date) - new Date(a.date))

        const approvedHours = entries
          .filter(e => e.status === 'Approved')
          .reduce((sum, e) => sum + e.hours, 0)

        return {
          ...s,
          approvedHoursComputed: roundToMinute(approvedHours),
          entries,
        }
      })

      onGenerate({
        mode,
        semester: settings.currentSemester || 'Current Semester',
        requirements: {
          totalRequired: settings.totalHoursRequired,
          midpointHours: settings.midpointHours,
          midpointWeek: settings.midpointWeek,
          currentWeek: summary.currentWeek,
        },
        classSummary: {
          total: summary.total,
          complete: summary.complete,
          onTrack: summary.onTrack,
          atRisk: summary.atRisk,
          behind: summary.behind,
        },
        studentReports,
        generatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error('Volunteer report generation error:', err)
    } finally {
      setLoading(false)
      setProgress({ current: 0, total: 0 })
    }
  }

  const isValid = mode === 'all' ? true : !!selectedEmail

  return (
    <ModalOverlay onClose={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-teal-100 flex items-center justify-center">
              <FileText size={16} className="text-teal-600" aria-hidden="true" />
            </div>
            <div>
              <h3 id={titleId} className="font-semibold text-surface-900">Generate Volunteer Report</h3>
              <p className="text-xs text-surface-400">Printable summary with entry detail</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-surface-100 text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={18} aria-hidden="true" /></button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {/* Mode Toggle */}
          <div>
            <div id="vh-report-type-label" className="block text-xs font-medium text-surface-600 mb-1.5">Report Type</div>
            <div className="flex gap-2" role="group" aria-labelledby="vh-report-type-label">
              <button
                type="button"
                aria-pressed={mode === 'all'}
                onClick={() => setMode('all')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] rounded-lg text-sm font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
                  mode === 'all'
                    ? 'bg-teal-50 border-teal-300 text-teal-700'
                    : 'bg-white border-surface-200 text-surface-500 hover:bg-surface-50'
                }`}
              >
                <Users size={15} aria-hidden="true" /> All Students
              </button>
              <button
                type="button"
                aria-pressed={mode === 'individual'}
                onClick={() => setMode('individual')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] rounded-lg text-sm font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
                  mode === 'individual'
                    ? 'bg-teal-50 border-teal-300 text-teal-700'
                    : 'bg-white border-surface-200 text-surface-500 hover:bg-surface-50'
                }`}
              >
                <User size={15} aria-hidden="true" /> Individual Student
              </button>
            </div>
          </div>

          {/* Individual: student picker */}
          {mode === 'individual' && (
            <Field label="Student">
              <select
                value={selectedEmail}
                onChange={e => setSelectedEmail(e.target.value)}
                className="input text-sm"
              >
                <option value="">Select a student…</option>
                {sortedStudents.map(s => (
                  <option key={s.email} value={s.email}>
                    {s.name} — {s.approvedHours}h approved ({s.progress}%)
                  </option>
                ))}
              </select>
            </Field>
          )}

          {/* Info */}
          <div className="bg-surface-50 rounded-lg px-3 py-2.5 text-xs text-surface-500 flex items-start gap-2">
            <Calendar size={14} className="text-surface-400 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {mode === 'all'
                ? `Generates a full report for all ${students.length} students showing hours, progress, and entry detail. Each student gets their own section with page breaks for printing.`
                : 'Generates a detailed report for the selected student showing all volunteer entries, hours breakdown, and status for the semester.'}
            </span>
          </div>

          {/* Progress */}
          {loading && progress.total > 0 && (
            <div>
              <div className="flex justify-between text-xs text-surface-500 mb-1">
                <span>Building report…</span>
                <span>{progress.current} / {progress.total} students</span>
              </div>
              <div className="h-2 bg-surface-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-teal-500 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]">
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading || !isValid}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
          >
            {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
            {loading ? 'Generating…' : mode === 'all' ? 'Generate Class Report' : 'Generate Report'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// VOLUNTEER REPORT VIEW — full-page printable
// ═══════════════════════════════════════════════════════════════════════════════

function VolunteerReportView({ reportData, onClose }) {
  const { mode, semester, requirements, classSummary, studentReports, generatedAt } = reportData

  const generatedDate = new Date(generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })

  const overallStatusLabel = (status) => {
    const map = { complete: 'Complete', on_track: 'On Track', at_risk: 'At Risk', behind: 'Behind' }
    return map[status] || 'On Track'
  }

  const midpointStatusLabel = (status) => {
    const map = { met: 'Met', on_track: 'On Track', at_risk: 'At Risk', overdue: 'Overdue' }
    return map[status] || 'On Track'
  }

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto print:p-0 print:max-w-none">

      {/* Toolbar — hidden when printing */}
      <div className="flex items-center justify-between mb-5 print:hidden">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-600 hover:bg-surface-100 rounded-lg border border-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back to Volunteer Hours
        </button>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px]"
        >
          <Printer size={14} aria-hidden="true" /> Print Report
        </button>
      </div>

      {/* ── Report Cover / Header ─────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm print:shadow-none print:border-none print:rounded-none mb-6 print:mb-4">

        {/* Title bar */}
        <div className="px-8 py-6 border-b border-surface-100 print:border-b print:border-black">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Heart size={20} className="text-purple-600 print:hidden" aria-hidden="true" />
                <h1 className="text-2xl font-bold text-surface-900">
                  {mode === 'all' ? 'Volunteer Hours — Class Report' : 'Volunteer Hours — Individual Report'}
                </h1>
              </div>
              <p className="text-surface-500">{semester}</p>
              <p className="text-xs text-surface-400 mt-1">Generated: {generatedDate}</p>
            </div>
            <div className="text-right text-xs text-surface-400 print:block hidden">
              RICT CMMS
            </div>
          </div>
        </div>

        {/* Requirements bar */}
        <div className="px-8 py-4 bg-purple-50 border-b border-purple-100 print:bg-white print:border-b print:border-black">
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <span className="text-surface-500">Required Total:</span>{' '}
              <span className="font-bold text-surface-900">{fmtHoursMin(requirements.totalRequired)}</span>
            </div>
            <div>
              <span className="text-surface-500">1st Half:</span>{' '}
              <span className="font-bold text-surface-900">{fmtHoursMin(requirements.midpointHours)} by Week {requirements.midpointWeek}</span>
            </div>
            <div>
              <span className="text-surface-500">Current Week:</span>{' '}
              <span className="font-bold text-surface-900">Week {requirements.currentWeek}</span>
            </div>
            {mode === 'all' && (
              <div>
                <span className="text-surface-500">Students:</span>{' '}
                <span className="font-bold text-surface-900">{studentReports.length}</span>
              </div>
            )}
          </div>
        </div>

        {/* Class summary row — all students mode only */}
        {mode === 'all' && (
          <div className="px-8 py-4 grid grid-cols-5 gap-4 border-b border-surface-100 print:border-b print:border-gray-300">
            {[
              { label: 'Total', value: classSummary.total, color: 'text-surface-700' },
              { label: 'Complete', value: classSummary.complete, color: 'text-emerald-600' },
              { label: 'On Track', value: classSummary.onTrack, color: 'text-blue-600' },
              { label: 'At Risk', value: classSummary.atRisk, color: 'text-amber-600' },
              { label: 'Behind', value: classSummary.behind, color: 'text-red-600' },
            ].map(s => (
              <div key={s.label} className="text-center">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-surface-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Summary table for all-students mode */}
        {mode === 'all' && (
          <div className="px-8 py-5">
            <h2 className="text-sm font-semibold text-surface-600 uppercase tracking-wide mb-3">Student Summary</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 print:bg-gray-100">
                  <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-surface-500 uppercase">Student</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">Approved Hrs</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">Required</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">Progress</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">1st Half</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">2nd Half</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">Status</th>
                  <th scope="col" className="px-3 py-2 text-center text-xs font-semibold text-surface-500 uppercase">Entries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {studentReports.map(s => (
                  <tr key={s.email} className="hover:bg-surface-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-surface-800">{s.name}</div>
                      <div className="text-xs text-surface-400">{s.email}</div>
                    </td>
                    <td className="px-3 py-2 text-center font-bold text-emerald-600">
                      {fmtHoursMin(s.approvedHours)}
                    </td>
                    <td className="px-3 py-2 text-center text-surface-600">
                      {fmtHoursMin(s.totalRequired || requirements.totalRequired)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center gap-2 justify-center">
                        <div className="w-16 h-1.5 rounded-full bg-surface-200 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${s.progress >= 100 ? 'bg-emerald-500' : s.progress >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                            style={{ width: `${Math.min(100, s.progress)}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium text-surface-600 w-8">{s.progress}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center text-xs font-medium">
                      <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
                        s.midpointStatus === 'met' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        s.midpointStatus === 'on_track' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                        s.midpointStatus === 'at_risk' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        'bg-red-50 text-red-700 border-red-200'
                      }`}>
                        {midpointStatusLabel(s.midpointStatus)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-xs font-medium">
                      <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
                        s.secondHalfStatus === 'met' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        s.secondHalfStatus === 'on_track' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                        s.secondHalfStatus === 'at_risk' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        s.secondHalfStatus === 'overdue' ? 'bg-red-50 text-red-700 border-red-200' :
                        'bg-surface-50 text-surface-400 border-surface-200'
                      }`}>
                        {secondHalfStatusLabel(s.secondHalfStatus)}
                      </span>
                      {s.secondHalfStatus !== 'pending' && (
                        <div className="text-[10px] text-surface-400 mt-0.5">{fmtHoursMin(s.secondHalfHours)}/{fmtHoursMin(requirements.midpointHours)}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
                        s.overallStatus === 'complete' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        s.overallStatus === 'on_track' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                        s.overallStatus === 'at_risk' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        'bg-red-50 text-red-700 border-red-200'
                      }`}>
                        {overallStatusLabel(s.overallStatus)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-surface-500 text-xs">
                      {s.entries.filter(e => e.status === 'Approved').length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Per-Student Detail Sections ───────────────────────────────── */}
      {studentReports.map((s, idx) => (
        <div
          key={s.email}
          className={`bg-white rounded-xl border border-surface-200 shadow-sm print:shadow-none print:border-none print:rounded-none mb-6 print:mb-0 ${
            idx > 0 ? 'print:break-before-page' : ''
          }`}
        >
          {/* Student header */}
          <div className="px-8 py-5 border-b border-surface-100 print:border-b print:border-black">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold text-surface-900">{s.name}</h2>
                <p className="text-sm text-surface-500">{s.email} · {s.role}</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-emerald-600">{fmtHoursMin(s.approvedHours)}</div>
                <div className="text-xs text-surface-400">of {fmtHoursMin(s.totalRequired || requirements.totalRequired)} required</div>
                <div className="mt-1">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                    s.overallStatus === 'complete' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    s.overallStatus === 'on_track' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                    s.overallStatus === 'at_risk' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                    'bg-red-50 text-red-700 border-red-200'
                  }`}>
                    {overallStatusLabel(s.overallStatus)}
                  </span>
                </div>
              </div>
            </div>

            {/* Mini stats row */}
            <div className="mt-4 grid grid-cols-5 gap-4 pt-4 border-t border-surface-100 print:border-t print:border-gray-300">
              <div>
                <div className="text-xs text-surface-500 mb-0.5">Approved Hours</div>
                <div className="text-base font-bold text-emerald-600">{fmtHoursMin(s.approvedHours)}</div>
              </div>
              <div>
                <div className="text-xs text-surface-500 mb-0.5">Progress</div>
                <div className="text-base font-bold text-surface-800">{s.progress}%</div>
              </div>
              <div>
                <div className="text-xs text-surface-500 mb-0.5">1st Half</div>
                <div className="text-base font-bold text-surface-800">{midpointStatusLabel(s.midpointStatus)}</div>
              </div>
              <div>
                <div className="text-xs text-surface-500 mb-0.5">2nd Half</div>
                <div className="text-base font-bold text-surface-800">
                  {secondHalfStatusLabel(s.secondHalfStatus)}
                  {s.secondHalfStatus !== 'pending' && (
                    <span className="text-xs font-normal text-surface-400 ml-1">({fmtHoursMin(s.secondHalfHours)}/{fmtHoursMin(requirements.midpointHours)})</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs text-surface-500 mb-0.5">Total Entries</div>
                <div className="text-base font-bold text-surface-800">{s.entries.filter(e => e.status === 'Approved').length}</div>
              </div>
            </div>
          </div>

          {/* Entry table */}
          <div className="px-8 py-5">
            <h3 className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-3">Volunteer Entries</h3>
            {s.entries.length === 0 ? (
              <p className="text-sm text-surface-400 py-4 text-center">No volunteer entries for this semester</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-50 print:bg-gray-100 text-left">
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase">Date</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase">Time</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase text-right">Hours</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase">Source</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase">Status</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase">Description</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase">Approved By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100">
                  {s.entries.map(e => (
                    <tr key={e.id} className="hover:bg-surface-50">
                      <td className="px-3 py-2 text-surface-700 whitespace-nowrap text-xs">{fmtDate(e.date)}</td>
                      <td className="px-3 py-2 text-surface-600 whitespace-nowrap text-xs">{e.timeIn} – {e.timeOut}</td>
                      <td className="px-3 py-2 text-right font-bold text-surface-800 text-xs">{fmtHoursMin(e.hours)}</td>
                      <td className="px-3 py-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium print:border ${
                          e.source === 'Time Clock' ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'
                        }`}>
                          {e.source}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
                          e.status === 'Approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                          e.status === 'Pending' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                          'bg-red-50 text-red-700 border-red-200'
                        }`}>
                          {e.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-surface-500 text-xs max-w-[160px]">
                        {e.rejectionReason
                          ? <span className="text-red-600">Rejected: {e.rejectionReason}</span>
                          : e.description || '—'}
                      </td>
                      <td className="px-3 py-2 text-surface-500 text-xs">{e.approvedBy || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-surface-200 print:border-t-2 print:border-black">
                    <td colSpan={2} className="px-3 py-2 text-xs font-semibold text-surface-600">
                      Total Approved
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-600 text-sm">
                      {fmtHoursMin(s.entries.filter(e => e.status === 'Approved').reduce((sum, e) => sum + e.hours, 0))}
                    </td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          {/* Footer line for print */}
          <div className="hidden print:block px-8 py-3 border-t border-gray-300 text-xs text-gray-400 flex justify-between">
            <span>RICT CMMS — Volunteer Hours Report</span>
            <span>{semester} · Week {requirements.currentWeek}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
