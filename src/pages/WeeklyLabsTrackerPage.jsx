import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import {
  useLabClasses, useLabReport, useStudentLabReport,
  useLabTrackerActions, buildClassWeeks,
} from '@/hooks/useWeeklyLabs'
import {
  Printer, Loader2, CheckCircle2, Lock, BadgeCheck,
  ChevronDown, ChevronUp, BarChart3, ShieldCheck, X,
  AlertTriangle, ClipboardList, Clock, Star, BookOpen,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function WeeklyLabsTrackerPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Weekly Labs')
  const isInstructor = hasPerm('view_all_students')

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto">
      {/* User Info Bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-50 rounded-xl mb-5">
        <span className="text-sm font-medium text-surface-900">
          {profile?.first_name} {profile?.last_name}
        </span>
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
          isInstructor
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-amber-100 text-amber-700'
        }`}>
          {isInstructor ? 'Instructor — Full Access' : profile?.role || 'Student'}
        </span>
      </div>

      {isInstructor ? <InstructorView /> : <StudentView />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGN-OFF MODAL (Badge Swipe using card_id) — For individual lab sign-off
// ═══════════════════════════════════════════════════════════════════════════

function SignOffModal({ isOpen, onClose, studentName, weekNumber, weekDate, className, onSignOff }) {
  const [badge, setBadge] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  // Ref-based guard to prevent double-fire from rapid badge swipe events
  const processingRef = useRef(false)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setBadge('')
      setError('')
      setVerifying(false)
      processingRef.current = false
    }
  }, [isOpen])

  if (!isOpen) return null

  const doVerify = async (overrideValue) => {
    // Guard: if already processing, skip silently
    if (processingRef.current) {
      console.log('SignOffModal: already processing, ignoring duplicate swipe')
      return
    }

    const badgeValue = (overrideValue || badge).trim()
    if (!badgeValue) {
      setError('Please swipe your instructor badge')
      return
    }

    processingRef.current = true
    setVerifying(true)
    setError('')

    try {
      // Fetch all active instructors with their card_id
      const { data: instructors, error: fetchError } = await supabase
        .from('profiles')
        .select('first_name, last_name, email, role, card_id')
        .eq('role', 'Instructor')
        .eq('status', 'Active')

      if (fetchError) throw fetchError

      // Match the swiped badge against instructor card_id values
      const swipedValue = badgeValue
      const matchedInstructor = (instructors || []).find(i => {
        if (!i.card_id) return false
        if (i.card_id === swipedValue) return true
        if (i.card_id.trim() === swipedValue) return true
        return false
      })

      if (!matchedInstructor) {
        setError('Badge not recognized. Only instructor badges can sign off labs.')
        processingRef.current = false
        setVerifying(false)
        return
      }

      await onSignOff(matchedInstructor)
      setBadge('')
      setError('')
      onClose()
    } catch (err) {
      console.error('Sign-off error:', err)
      setError('Verification failed. Please try again.')
    } finally {
      processingRef.current = false
      setVerifying(false)
    }
  }

  const handleBadgeInput = (value) => {
    setBadge(value)
    setError('')
    // Only trigger verify on the terminal '?' character from card reader,
    // and only if not already processing
    if (value.length > 5 && value.endsWith('?') && !processingRef.current) {
      setTimeout(() => doVerify(value), 50)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doVerify()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative bg-gradient-to-r from-brand-600 to-brand-700 px-6 py-5 text-white text-center">
          <button onClick={onClose} className="absolute top-3 right-3 p-1 rounded-full hover:bg-white/20 transition">
            <X size={20} />
          </button>
          <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
            <ShieldCheck size={28} />
          </div>
          <h2 className="text-lg font-bold">Sign Off Lab</h2>
          <p className="text-sm opacity-80 mt-1">Have an instructor swipe their badge to sign off on this lab.</p>
        </div>

        {/* Info */}
        <div className="px-6 py-4 bg-surface-50 border-b border-surface-200">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-surface-500">Student</span>
              <span className="font-semibold text-surface-900">{studentName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-surface-500">Week</span>
              <span className="font-semibold text-surface-900">W{weekNumber} ({weekDate})</span>
            </div>
            <div className="flex justify-between">
              <span className="text-surface-500">Class</span>
              <span className="font-semibold text-surface-900">{className}</span>
            </div>
          </div>
        </div>

        {/* Badge Input */}
        <div className="px-6 py-5">
          <div className="relative">
            <input
              type="text"
              name="badge-scan"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              aria-label="Instructor badge swipe input"
              value={badge}
              onChange={e => handleBadgeInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Swipe instructor badge..."
              autoFocus
              className="w-full px-4 py-3.5 border-2 border-surface-200 rounded-xl text-center text-lg
                         focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100
                         transition placeholder:text-surface-300 badge-mask"
            />
            <p className="text-xs text-surface-400 text-center mt-2">
              Badge input will be masked for security
            </p>
          </div>

          {error && (
            <div className="mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 text-center">
              {error}
            </div>
          )}

          <button
            onClick={() => doVerify()}
            disabled={verifying || !badge.trim()}
            className="w-full mt-4 px-4 py-3 bg-brand-600 text-white rounded-xl font-semibold text-sm
                       hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition
                       flex items-center justify-center gap-2"
          >
            {verifying ? (
              <><Loader2 size={18} className="animate-spin" /> Verifying...</>
            ) : (
              <><ShieldCheck size={18} /> Verify & Sign Off</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ALL DONE MODAL (Badge Swipe with Work Order Check + Lab Status Summary)
// ═══════════════════════════════════════════════════════════════════════════

function AllDoneModal({ isOpen, onClose, studentName, studentEmail, weekNumber, weekDate, weekStartDate, weekEndDate, classes, labStatuses, onAllDone }) {
  const [badge, setBadge] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [studentWorkOrders, setStudentWorkOrders] = useState([])
  const [lateWorkOrders, setLateWorkOrders] = useState([])
  const [workOrderLogs, setWorkOrderLogs] = useState({})
  const [lateWorkOrderLogs, setLateWorkOrderLogs] = useState({})
  const [loadingWOs, setLoadingWOs] = useState(true)
  const [weeklyReminder, setWeeklyReminder] = useState('')
  const [reminderAcknowledged, setReminderAcknowledged] = useState(false)
  // Ref-based guard to prevent double-fire from rapid badge swipe events
  const processingRef = useRef(false)

  // Fetch weekly reminder message when modal opens
  useEffect(() => {
    if (!isOpen) return
    supabase
      .from('settings')
      .select('setting_value')
      .eq('setting_key', 'alldone_weekly_reminder')
      .maybeSingle()
      .then(({ data }) => setWeeklyReminder(data?.setting_value?.trim() || ''))
      .catch(() => setWeeklyReminder(''))
  }, [isOpen])

  // Fetch work orders when modal opens
  useEffect(() => {
    if (!isOpen || !studentEmail) return
    setLoadingWOs(true)
    setBadge('')
    setError('')
    setReminderAcknowledged(false)
    processingRef.current = false

    async function fetchWOs() {
      try {
        // 1. Open work orders assigned to THIS student
        const { data: studentWOs, error: woError } = await supabase
          .from('work_orders')
          .select('wo_id, description, priority, status, asset_name, due_date, created_at, days_open, was_late, assigned_to, assigned_email')
          .eq('assigned_email', studentEmail)
          .not('status', 'in', '("Closed","Completed","Cancelled")')
          .order('due_date', { ascending: true })

        if (woError) throw woError
        setStudentWorkOrders(studentWOs || [])

        // 1b. Work logs for those open WOs, by this student
        if (studentWOs && studentWOs.length > 0) {
          const woIds = studentWOs.map(w => w.wo_id)
          const { data: logs } = await supabase
            .from('work_log')
            .select('log_id, wo_id, timestamp, user_name, hours, work_description, entry_type')
            .in('wo_id', woIds)
            .eq('user_email', studentEmail)
            .order('timestamp', { ascending: false })
          // Group by wo_id (all logs)
          const grouped = {}
          ;(logs || []).forEach(l => {
            if (!grouped[l.wo_id]) grouped[l.wo_id] = []
            grouped[l.wo_id].push(l)
          })
          setWorkOrderLogs(grouped)
        } else {
          setWorkOrderLogs({})
        }

        // 2. Late work orders from ANYONE (overdue or flagged late)
        const todayStr = new Date().toISOString().substring(0, 10)
        const { data: allLateWOs, error: lateError } = await supabase
          .from('work_orders')
          .select('wo_id, description, priority, status, asset_name, due_date, assigned_to, assigned_email, was_late')
          .not('status', 'in', '("Closed","Completed","Cancelled")')
          .or(`was_late.eq.true,due_date.lt.${todayStr}`)
          .order('due_date', { ascending: true })

        if (lateError) throw lateError
        setLateWorkOrders(allLateWOs || [])

        // 2b. Work logs for late WOs — from ANYONE (not filtered by email)
        if (allLateWOs && allLateWOs.length > 0) {
          const lateWoIds = allLateWOs.map(w => w.wo_id)
          const { data: lateLogs } = await supabase
            .from('work_log')
            .select('log_id, wo_id, timestamp, user_name, user_email, hours, work_description, entry_type')
            .in('wo_id', lateWoIds)
            .order('timestamp', { ascending: false })
          const lateGrouped = {}
          ;(lateLogs || []).forEach(l => {
            if (!lateGrouped[l.wo_id]) lateGrouped[l.wo_id] = []
            lateGrouped[l.wo_id].push(l)
          })
          setLateWorkOrderLogs(lateGrouped)
        } else {
          setLateWorkOrderLogs({})
        }
      } catch (err) {
        console.error('Error loading work orders:', err)
        setStudentWorkOrders([])
        setLateWorkOrders([])
        setLateWorkOrderLogs({})
      } finally {
        setLoadingWOs(false)
      }
    }
    fetchWOs()
  }, [isOpen, studentEmail])

  if (!isOpen) return null

  const hasOpenWOs = studentWorkOrders.length > 0
  const hasLateWOs = lateWorkOrders.length > 0
  const allLabsDone = (labStatuses || []).every(ls => ls.labComplete)

  // Determine which WOs have a log entry this week and overall
  // weekStartDate may arrive as a full ISO string (e.g. "2026-03-23T05:00:00.000Z")
  // so extract the YYYY-MM-DD portion before appending a local-time suffix
  const weekStart = weekStartDate ? new Date(weekStartDate.substring(0, 10) + 'T00:00:00') : null
  const weekEnd = weekEndDate ? new Date(weekEndDate.substring(0, 10) + 'T23:59:59') : null
  const logsThisWeekByWO = {}
  if (weekStart && weekEnd) {
    studentWorkOrders.forEach(wo => {
      const logs = workOrderLogs[wo.wo_id] || []
      logsThisWeekByWO[wo.wo_id] = logs.some(l => {
        const ts = new Date(l.timestamp)
        return ts >= weekStart && ts <= weekEnd
      })
    })
  }
  // True if every open WO has at least one log entry this week
  const allWOsHaveLogsThisWeek = studentWorkOrders.length === 0 ||
    studentWorkOrders.every(wo => logsThisWeekByWO[wo.wo_id])
  // True if at least one open WO is missing a log this week
  const anyWOMissingLog = studentWorkOrders.some(wo => !logsThisWeekByWO[wo.wo_id])

  // For late WOs — check if each has ANY log entry this week (from anyone)
  const logsThisWeekByLateWO = {}
  if (weekStart && weekEnd) {
    lateWorkOrders.forEach(wo => {
      const logs = lateWorkOrderLogs[wo.wo_id] || []
      logsThisWeekByLateWO[wo.wo_id] = logs.some(l => {
        const ts = new Date(l.timestamp)
        return ts >= weekStart && ts <= weekEnd
      })
    })
  }
  // True if any late WO has no log entry this week from anyone
  const anyLateWOMissingLog = lateWorkOrders.some(wo => !logsThisWeekByLateWO[wo.wo_id])
  const allLateWOsHaveLogs = lateWorkOrders.length === 0 || lateWorkOrders.every(wo => logsThisWeekByLateWO[wo.wo_id])

  // Gate: all four conditions must be met before badge swipe is allowed
  const canVerify = allLabsDone && allWOsHaveLogsThisWeek && allLateWOsHaveLogs && (!weeklyReminder || reminderAcknowledged)

  const doVerify = async (overrideValue) => {
    // Guard: if already processing, skip silently
    if (processingRef.current) {
      console.log('AllDoneModal: already processing, ignoring duplicate swipe')
      return
    }

    const badgeValue = (overrideValue || badge).trim()
    if (!badgeValue) {
      setError('Please swipe your instructor badge')
      return
    }

    processingRef.current = true
    setVerifying(true)
    setError('')

    try {
      const { data: instructors, error: fetchError } = await supabase
        .from('profiles')
        .select('first_name, last_name, email, role, card_id')
        .eq('role', 'Instructor')
        .eq('status', 'Active')

      if (fetchError) throw fetchError

      const swipedValue = badgeValue
      const matchedInstructor = (instructors || []).find(i => {
        if (!i.card_id) return false
        if (i.card_id === swipedValue) return true
        if (i.card_id.trim() === swipedValue) return true
        return false
      })

      if (!matchedInstructor) {
        setError('Badge not recognized. Only instructor badges can mark All Done.')
        processingRef.current = false
        setVerifying(false)
        return
      }

      await onAllDone(matchedInstructor)
      setBadge('')
      setError('')
      onClose()
    } catch (err) {
      console.error('All Done error:', err)
      setError('Verification failed. Please try again.')
    } finally {
      processingRef.current = false
      setVerifying(false)
    }
  }

  const handleBadgeInput = (value) => {
    setBadge(value)
    setError('')
    // Only trigger verify on the terminal '?' character from card reader,
    // and only if not already processing and conditions are met
    if (value.length > 5 && value.endsWith('?') && !processingRef.current && canVerify) {
      setTimeout(() => doVerify(value), 50)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (canVerify) doVerify()
    }
  }

  const priorityColor = (p) => {
    switch (p) {
      case 'Critical': return 'bg-red-100 text-red-700 border-red-200'
      case 'High': return 'bg-orange-100 text-orange-700 border-orange-200'
      case 'Medium': return 'bg-amber-100 text-amber-700 border-amber-200'
      case 'Low': return 'bg-blue-100 text-blue-700 border-blue-200'
      default: return 'bg-surface-100 text-surface-600 border-surface-200'
    }
  }

  const statusColor = (s) => {
    switch (s) {
      case 'In Progress': return 'text-blue-700 bg-blue-50'
      case 'Awaiting Parts': return 'text-amber-700 bg-amber-50'
      case 'On Hold': return 'text-surface-600 bg-surface-100'
      default: return 'text-surface-600 bg-surface-50'
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header — Emerald gradient to distinguish from regular Sign Off */}
        <div className="relative bg-gradient-to-r from-emerald-600 to-emerald-700 px-6 py-5 text-white text-center flex-shrink-0">
          <button onClick={onClose} className="absolute top-3 right-3 p-1 rounded-full hover:bg-white/20 transition">
            <X size={20} />
          </button>
          <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
            <Star size={28} />
          </div>
          <h2 className="text-lg font-bold">Mark All Done</h2>
          <p className="text-sm opacity-80 mt-1">
            This will complete all labs for the week, clear remaining signups, and mark hours as fulfilled.
          </p>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1">
          {/* Student & Week Info */}
          <div className="px-6 py-4 bg-surface-50 border-b border-surface-200">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-surface-500">Student</span>
                <span className="font-semibold text-surface-900">{studentName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-surface-500">Week</span>
                <span className="font-semibold text-surface-900">W{weekNumber} ({weekDate})</span>
              </div>
            </div>
          </div>

          {/* ── LAB SIGN-OFF STATUS ── */}
          <div className="px-6 py-4 border-b border-surface-200">
            <div className="flex items-center gap-2 mb-3">
              <BookOpen size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-900">Lab Sign-Off Status</h3>
            </div>

            {(!labStatuses || labStatuses.length === 0) ? (
              <div className="text-sm text-surface-400 italic">No classes found for this week.</div>
            ) : (
              <div className="space-y-2">
                {labStatuses.map((ls, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm ${
                      ls.allDone
                        ? 'bg-emerald-50 border-emerald-200'
                        : ls.labComplete
                        ? 'bg-blue-50 border-blue-200'
                        : 'bg-amber-50 border-amber-200'
                    }`}
                  >
                    <span className="font-medium text-surface-900">{ls.className}</span>
                    {ls.allDone ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
                        <CheckCircle2 size={14} /> Done
                      </span>
                    ) : ls.labComplete ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-blue-700">
                        <CheckCircle2 size={14} /> Lab Signed Off
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs font-semibold text-amber-700">
                        <Clock size={14} /> Not Signed Off
                      </span>
                    )}
                  </div>
                ))}

                {allLabsDone ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 font-medium">
                    <CheckCircle2 size={14} />
                    All labs signed off — ready for All Done
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 font-medium">
                    <AlertTriangle size={14} />
                    Some labs not yet signed off — instructor can still approve All Done
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── OPEN WORK ORDERS (assigned to student) ── */}
          <div className={`px-6 py-4 border-b ${hasOpenWOs && anyWOMissingLog ? 'border-red-200 bg-red-50/30' : hasOpenWOs && !anyWOMissingLog ? 'border-emerald-200 bg-emerald-50/30' : 'border-surface-200'}`}>
            <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg ${
              hasOpenWOs && anyWOMissingLog
                ? 'bg-red-100 border border-red-200'
                : hasOpenWOs && !anyWOMissingLog
                ? 'bg-emerald-100 border border-emerald-200'
                : ''
            }`}>
              <ClipboardList size={16} className={hasOpenWOs && anyWOMissingLog ? 'text-red-600' : hasOpenWOs && !anyWOMissingLog ? 'text-emerald-600' : 'text-surface-500'} />
              <h3 className={`text-sm font-semibold ${hasOpenWOs && anyWOMissingLog ? 'text-red-800' : hasOpenWOs && !anyWOMissingLog ? 'text-emerald-800' : 'text-surface-900'}`}>
                Open Work Orders
                <span className="font-normal opacity-70 ml-1">(assigned to {studentName})</span>
              </h3>
              {hasOpenWOs && anyWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-red-700 flex items-center gap-1">
                  <AlertTriangle size={11} /> Missing log entries this week
                </span>
              )}
              {hasOpenWOs && !anyWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 size={11} /> Log entries recorded this week
                </span>
              )}
            </div>

            {loadingWOs ? (
              <div className="flex justify-center py-4">
                <Loader2 size={20} className="animate-spin text-surface-400" />
              </div>
            ) : studentWorkOrders.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
                <CheckCircle2 size={16} />
                No open work orders — good to go!
              </div>
            ) : (
              <div className="space-y-2">
                {studentWorkOrders.map(wo => {
                  const isLate = wo.was_late || (wo.due_date && new Date(wo.due_date) < new Date())
                  const dueDate = wo.due_date ? new Date(wo.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
                  const logs = workOrderLogs[wo.wo_id] || []
                  const hasLogThisWeek = logsThisWeekByWO[wo.wo_id] || false

                  return (
                    <div
                      key={wo.wo_id}
                      className={`rounded-lg border text-sm overflow-hidden ${
                        !hasLogThisWeek ? 'border-red-400' : isLate ? 'border-red-300' : 'border-emerald-300'
                      }`}
                    >
                      {/* WO Header */}
                      <div className={`px-3 py-2.5 ${!hasLogThisWeek ? 'bg-red-50' : isLate ? 'bg-red-50' : 'bg-emerald-50'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-semibold text-surface-900">{wo.wo_id}</span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${priorityColor(wo.priority)}`}>
                                {wo.priority}
                              </span>
                              {isLate && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 flex items-center gap-0.5">
                                  <AlertTriangle size={10} /> LATE
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-surface-600 mt-1 line-clamp-2">{wo.description}</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColor(wo.status)}`}>
                              {wo.status}
                            </span>
                            <div className="text-[10px] text-surface-400 mt-1">Due: {dueDate}</div>
                          </div>
                        </div>
                      </div>

                      {/* Work Logs */}
                      {logs.length > 0 ? (
                        <div className="border-t border-surface-200 divide-y divide-surface-100">
                          <div className={`px-3 py-1.5 flex items-center gap-1.5 ${hasLogThisWeek ? 'bg-emerald-50' : 'bg-red-50'}`}>
                            <Clock size={11} className={hasLogThisWeek ? 'text-emerald-500' : 'text-red-400'} />
                            <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasLogThisWeek ? 'text-emerald-700' : 'text-red-600'}`}>
                              Work Log — {logs.length} {logs.length === 1 ? 'entry' : 'entries'} &nbsp;·&nbsp; {logs.reduce((sum, l) => sum + (parseFloat(l.hours) || 0), 0).toFixed(2)} hrs total
                            </span>
                            {!hasLogThisWeek && (
                              <span className="ml-auto text-[10px] font-bold text-red-600 flex items-center gap-0.5">
                                <AlertTriangle size={10} /> No entry this week
                              </span>
                            )}
                          </div>
                          {logs.map(log => {
                            const ts = new Date(log.timestamp)
                            const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            const timeStr = ts.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                            const hrs = parseFloat(log.hours)
                            return (
                              <div key={log.log_id} className="px-3 py-2 bg-white">
                                <div className="flex items-center justify-between gap-2 mb-0.5">
                                  <span className="text-[10px] text-surface-400">{dateStr} at {timeStr}</span>
                                  {!isNaN(hrs) && hrs > 0 && hrs < 1000 && (
                                    <span className="text-[10px] font-semibold text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded">
                                      {hrs.toFixed(2)} hrs
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-surface-700 leading-snug line-clamp-3">
                                  {log.work_description || <span className="italic text-surface-400">No description</span>}
                                </p>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="border-t border-surface-200 px-3 py-2 bg-white flex items-center gap-1.5">
                          <Clock size={11} className="text-surface-300" />
                          <span className="text-[10px] text-surface-400 italic">No work log entries yet</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── LATE WORK ORDERS FROM ANYONE ── */}
          <div className={`px-6 py-4 border-b ${hasLateWOs && anyLateWOMissingLog ? 'border-red-200 bg-red-50/30' : hasLateWOs ? 'border-emerald-200 bg-emerald-50/30' : 'border-surface-200'}`}>
            <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg ${
              hasLateWOs && anyLateWOMissingLog
                ? 'bg-red-100 border border-red-200'
                : hasLateWOs
                ? 'bg-emerald-100 border border-emerald-200'
                : ''
            }`}>
              <AlertTriangle size={16} className={hasLateWOs && anyLateWOMissingLog ? 'text-red-600' : hasLateWOs ? 'text-emerald-600' : 'text-red-500'} />
              <h3 className={`text-sm font-semibold ${hasLateWOs && anyLateWOMissingLog ? 'text-red-800' : hasLateWOs ? 'text-emerald-800' : 'text-surface-900'}`}>
                Late Work Orders
                <span className="font-normal opacity-70 ml-1">(all students)</span>
              </h3>
              {hasLateWOs && anyLateWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-red-700 flex items-center gap-1">
                  <AlertTriangle size={11} /> Missing log entries this week
                </span>
              )}
              {hasLateWOs && !anyLateWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 size={11} /> All have log entries this week
                </span>
              )}
            </div>

            {loadingWOs ? (
              <div className="flex justify-center py-4">
                <Loader2 size={20} className="animate-spin text-surface-400" />
              </div>
            ) : lateWorkOrders.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
                <CheckCircle2 size={16} />
                No late work orders — everyone is on track!
              </div>
            ) : (
              <div className="space-y-2">
                {lateWorkOrders.map(wo => {
                  const dueDate = wo.due_date ? new Date(wo.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
                  const isThisStudent = wo.assigned_email === studentEmail
                  const lateLogs = lateWorkOrderLogs[wo.wo_id] || []
                  const hasLateLogThisWeek = logsThisWeekByLateWO[wo.wo_id] || false

                  // Filter to only this-week logs for display at top; show all others below
                  const thisWeekLogs = weekStart && weekEnd
                    ? lateLogs.filter(l => { const ts = new Date(l.timestamp); return ts >= weekStart && ts <= weekEnd })
                    : []
                  const olderLogs = weekStart && weekEnd
                    ? lateLogs.filter(l => { const ts = new Date(l.timestamp); return !(ts >= weekStart && ts <= weekEnd) })
                    : lateLogs

                  return (
                    <div
                      key={wo.wo_id}
                      className={`rounded-lg border text-sm overflow-hidden ${
                        !hasLateLogThisWeek
                          ? isThisStudent ? 'border-red-400' : 'border-red-300'
                          : isThisStudent ? 'border-emerald-400' : 'border-emerald-300'
                      }`}
                    >
                      {/* Card header */}
                      <div className={`px-3 py-2.5 ${!hasLateLogThisWeek ? (isThisStudent ? 'bg-red-50' : 'bg-red-50/60') : (isThisStudent ? 'bg-emerald-50' : 'bg-emerald-50/60')}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-semibold text-surface-900">{wo.wo_id}</span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${priorityColor(wo.priority)}`}>
                                {wo.priority}
                              </span>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 flex items-center gap-0.5">
                                <AlertTriangle size={10} /> LATE
                              </span>
                              {isThisStudent && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200">
                                  THIS STUDENT
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-surface-600 mt-1 line-clamp-1">{wo.description}</p>
                            <p className="text-[10px] text-surface-400 mt-0.5">
                              Assigned to: <span className="font-medium">{wo.assigned_to || wo.assigned_email || '—'}</span>
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColor(wo.status)}`}>
                              {wo.status}
                            </span>
                            <div className="text-[10px] text-surface-400 mt-1">Due: {dueDate}</div>
                          </div>
                        </div>
                      </div>

                      {/* Work logs sub-section */}
                      <div className="border-t border-surface-200 divide-y divide-surface-100">
                        {/* This-week logs header */}
                        <div className={`px-3 py-1.5 flex items-center gap-1.5 ${hasLateLogThisWeek ? 'bg-emerald-50' : 'bg-red-50'}`}>
                          <Clock size={11} className={hasLateLogThisWeek ? 'text-emerald-500' : 'text-red-400'} />
                          <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasLateLogThisWeek ? 'text-emerald-700' : 'text-red-600'}`}>
                            {hasLateLogThisWeek
                              ? `This week — ${thisWeekLogs.length} ${thisWeekLogs.length === 1 ? 'entry' : 'entries'}`
                              : 'No work log entries this week'}
                          </span>
                          {!hasLateLogThisWeek && (
                            <span className="ml-auto text-[10px] font-bold text-red-600 flex items-center gap-0.5">
                              <AlertTriangle size={10} /> Required
                            </span>
                          )}
                        </div>

                        {/* This-week log entries */}
                        {thisWeekLogs.map(log => {
                          const ts = new Date(log.timestamp)
                          const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          const timeStr = ts.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                          const hrs = parseFloat(log.hours)
                          return (
                            <div key={log.log_id} className="px-3 py-2 bg-white">
                              <div className="flex items-center justify-between gap-2 mb-0.5">
                                <span className="text-[10px] text-surface-500 font-medium">{log.user_name}</span>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] text-surface-400">{dateStr} at {timeStr}</span>
                                  {!isNaN(hrs) && hrs > 0 && hrs < 1000 && (
                                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                                      {hrs.toFixed(2)} hrs
                                    </span>
                                  )}
                                </div>
                              </div>
                              <p className="text-xs text-surface-700 leading-snug line-clamp-2">
                                {log.work_description || <span className="italic text-surface-400">No description</span>}
                              </p>
                            </div>
                          )
                        })}

                        {/* Older log entries (collapsed under a label) */}
                        {olderLogs.length > 0 && (
                          <>
                            <div className="px-3 py-1 bg-surface-50 flex items-center gap-1.5">
                              <span className="text-[10px] text-surface-400 uppercase tracking-wide font-semibold">
                                Prior entries ({olderLogs.length})
                              </span>
                            </div>
                            {olderLogs.slice(0, 3).map(log => {
                              const ts = new Date(log.timestamp)
                              const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                              const hrs = parseFloat(log.hours)
                              return (
                                <div key={log.log_id} className="px-3 py-1.5 bg-white">
                                  <div className="flex items-center justify-between gap-2 mb-0.5">
                                    <span className="text-[10px] text-surface-400">{log.user_name} · {dateStr}</span>
                                    {!isNaN(hrs) && hrs > 0 && hrs < 1000 && (
                                      <span className="text-[10px] text-surface-400">{hrs.toFixed(2)} hrs</span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-surface-500 leading-snug line-clamp-1">
                                    {log.work_description || <span className="italic">No description</span>}
                                  </p>
                                </div>
                              )
                            })}
                            {olderLogs.length > 3 && (
                              <div className="px-3 py-1 bg-white text-[10px] text-surface-400 italic">
                                + {olderLogs.length - 3} more prior {olderLogs.length - 3 === 1 ? 'entry' : 'entries'}
                              </div>
                            )}
                          </>
                        )}

                        {/* No logs at all */}
                        {lateLogs.length === 0 && (
                          <div className="px-3 py-2 bg-white flex items-center gap-1.5">
                            <Clock size={11} className="text-surface-300" />
                            <span className="text-[10px] text-surface-400 italic">No work log entries recorded</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Instructor Review Note */}
          {(hasOpenWOs || hasLateWOs || !allLabsDone) && (
            <div className="px-6 py-3 bg-amber-50 border-b border-amber-200">
              <p className="text-xs text-amber-800 font-medium flex items-center gap-2">
                <AlertTriangle size={14} className="flex-shrink-0" />
                Instructor: Review the items above before approving All Done. Swiping your badge will mark everything complete regardless.
              </p>
            </div>
          )}

          {/* Weekly Reminder Message — set by instructors in Settings → Weekly Labs */}
          {weeklyReminder && (
            <div className={`mx-4 my-3 rounded-xl border-2 shadow-sm overflow-hidden transition-colors duration-300 ${
              reminderAcknowledged ? 'border-indigo-300 bg-indigo-50' : 'border-red-400 bg-red-50'
            }`}>
              <div className={`flex items-center gap-2 px-4 py-2 transition-colors duration-300 ${
                reminderAcknowledged ? 'bg-indigo-600' : 'bg-red-600'
              }`}>
                <BookOpen size={14} className="text-white flex-shrink-0" />
                <span className="text-xs font-bold text-white uppercase tracking-wide">
                  Message from Your Instructor
                </span>
                {!reminderAcknowledged && (
                  <span className="ml-auto text-[10px] font-bold text-white/90 flex items-center gap-1">
                    <AlertTriangle size={11} /> Must acknowledge to continue
                  </span>
                )}
              </div>
              <div className="px-4 py-3">
                <p className={`text-sm font-semibold leading-snug mb-3 ${reminderAcknowledged ? 'text-indigo-900' : 'text-red-900'}`}>
                  {weeklyReminder}
                </p>
                <label className={`flex items-center gap-2.5 cursor-pointer select-none group`}>
                  <div
                    onClick={() => setReminderAcknowledged(v => !v)}
                    className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      reminderAcknowledged
                        ? 'bg-indigo-600 border-indigo-600'
                        : 'bg-white border-red-400 group-hover:border-red-500'
                    }`}
                  >
                    {reminderAcknowledged && (
                      <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                        <path d="M1 4L4 7L10 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <span
                    onClick={() => setReminderAcknowledged(v => !v)}
                    className={`text-xs font-semibold transition-colors ${reminderAcknowledged ? 'text-indigo-800' : 'text-red-800'}`}
                  >
                    I have read and understood the message above
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Badge Input */}
          <div className="px-6 py-5">
            {!canVerify && (
              <div className="mb-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 space-y-1">
                <p className="font-bold flex items-center gap-1.5"><AlertTriangle size={13} /> Complete the following before the instructor can swipe:</p>
                {!allLabsDone && <p className="pl-4">• All labs must be signed off</p>}
                {anyWOMissingLog && <p className="pl-4">• Work log entry required for each open work order this week</p>}
                {anyLateWOMissingLog && <p className="pl-4">• Work log entry required for each late work order this week (any student)</p>}
                {weeklyReminder && !reminderAcknowledged && <p className="pl-4">• Acknowledge the instructor message above</p>}
              </div>
            )}
            <div className="relative">
              <input
                type="text"
                name="badge-scan"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                aria-label="Instructor badge swipe input for all-done verification"
                value={badge}
                onChange={e => handleBadgeInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={canVerify ? 'Swipe instructor badge...' : 'Complete checklist above first...'}
                autoFocus
                disabled={!canVerify}
                className={`w-full px-4 py-3.5 border-2 rounded-xl text-center text-lg transition placeholder:text-surface-300 badge-mask
                  ${canVerify
                    ? 'border-surface-200 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100'
                    : 'border-surface-200 bg-surface-50 text-surface-400 cursor-not-allowed opacity-60'
                  }`}
              />
              <p className="text-xs text-surface-400 text-center mt-2">
                Badge input will be masked for security
              </p>
            </div>

            {error && (
              <div className="mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 text-center">
                {error}
              </div>
            )}

            <button
              onClick={() => canVerify && doVerify()}
              disabled={verifying || !badge.trim() || !canVerify}
              className={`w-full mt-4 px-4 py-3 rounded-xl font-semibold text-sm transition
                flex items-center justify-center gap-2
                ${canVerify
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed'
                  : 'bg-surface-200 text-surface-400 cursor-not-allowed'
                }`}
            >
              {verifying ? (
                <><Loader2 size={18} className="animate-spin" /> Verifying...</>
              ) : (
                <><Star size={18} /> Verify & Mark All Done</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTRUCTOR VIEW
// ═══════════════════════════════════════════════════════════════════════════

function InstructorView() {
  const { classes, loading: classesLoading } = useLabClasses()
  const [selectedClass, setSelectedClass] = useState('')
  const { report, loading: reportLoading, refresh } = useLabReport(selectedClass)
  const { updateStatus } = useLabTrackerActions()

  const handleCheckbox = async (student, weekNumber, field, checked) => {
    if (field === 'done' && checked) {
      if (!confirm(`Mark ${student.fullName} as Done for Week ${weekNumber}? This will also mark Lab as complete.`)) return
    }
    // Look up week date context from classWeeks for proper insert data
    const weekInfo = report.classWeeks?.find(w => w.weekNumber === weekNumber)
    const result = await updateStatus(
      student.userId, student.email, student.fullName,
      report.className, report.classId || '', weekNumber, field, checked,
      weekInfo?.startDate || '', weekInfo?.endDate || ''
    )
    if (result.success) refresh()
  }

  if (classesLoading) {
    return <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-600" /></div>
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex gap-4 items-end flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-surface-600 mb-1.5">Select Class</label>
          <select
            value={selectedClass}
            onChange={e => setSelectedClass(e.target.value)}
            className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm bg-white"
          >
            <option value="">— Select Class —</option>
            {classes.filter(cls => cls.trackingType !== 'None').map(cls => (
              <option key={cls.classId} value={cls.className}>
                {cls.className}{cls.description ? ` — ${cls.description}` : ''}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => window.print()}
          disabled={!report}
          className="flex items-center gap-2 px-4 py-2.5 bg-surface-100 text-surface-600 rounded-lg text-sm font-medium hover:bg-surface-200 disabled:opacity-40"
        >
          <Printer size={16} /> Print
        </button>
      </div>

      {/* Report */}
      {reportLoading ? (
        <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-600" /></div>
      ) : !selectedClass ? (
        <EmptyState text="Select a class to view student progress" />
      ) : !report ? (
        <EmptyState text="No data available" />
      ) : (
        <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-surface-200">
            <h3 className="text-base font-semibold text-surface-900">
              {report.className}
              {report.description && <span className="text-sm font-normal text-surface-400 ml-2">{report.description}</span>}
              <span className="text-sm font-normal text-surface-400 ml-2">({report.totalWeeks} weeks)</span>
            </h3>
            <p className="text-xs text-surface-400 mt-1">Generated: {report.generatedAt} · {report.students.length} students</p>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[700px]">
              <thead>
                <tr className="bg-surface-50">
                  <th className="px-3 py-2.5 text-left font-semibold text-surface-600 min-w-[180px]">Student Name</th>
                  {Array.from({ length: report.totalWeeks }, (_, i) => {
                    const wk = report.classWeeks?.[i]
                    const label = wk?.isFinals ? 'Finals' : `W${i + 1}`
                    let dateRange = ''
                    if (wk) {
                      const s = new Date(wk.startDate)
                      const e = new Date(wk.endDate)
                      dateRange = `${s.getMonth() + 1}/${s.getDate()}-${e.getMonth() + 1}/${e.getDate()}`
                    }
                    return (
                      <th key={i} className="px-2 py-2.5 text-center font-semibold text-surface-600 min-w-[80px]">
                        <div className={wk?.isFinals ? 'text-red-600' : ''}>{label}</div>
                        {dateRange && <div className="text-[10px] font-normal text-surface-400">{dateRange}</div>}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {report.students.length === 0 ? (
                  <tr><td colSpan={report.totalWeeks + 1} className="text-center py-8 text-surface-400">No students enrolled</td></tr>
                ) : (
                  report.students.map(student => (
                    <tr key={student.userId} className="border-t border-surface-100 hover:bg-blue-50/30">
                      <td className="px-3 py-2.5 font-medium text-surface-900">{student.fullName}</td>
                      {Array.from({ length: report.totalWeeks }, (_, i) => {
                        const wn = i + 1
                        const ws = student.weeks[wn] || { labComplete: false, allDone: false }
                        return (
                          <td key={i} className="px-2 py-2 text-center">
                            <div className="flex flex-col gap-1 items-center">
                              <label className="flex items-center gap-1 cursor-pointer text-[10px]">
                                <input
                                  type="checkbox"
                                  checked={ws.labComplete}
                                  onChange={e => handleCheckbox(student, wn, 'lab', e.target.checked)}
                                  className="cursor-pointer accent-blue-600"
                                />
                                Lab
                              </label>
                              <label className={`flex items-center gap-1 cursor-pointer text-[10px] ${ws.allDone ? 'opacity-60' : ''}`}>
                                <input
                                  type="checkbox"
                                  checked={ws.allDone}
                                  disabled={ws.allDone}
                                  onChange={e => handleCheckbox(student, wn, 'done', e.target.checked)}
                                  className="cursor-pointer accent-emerald-600"
                                />
                                Done
                              </label>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="px-4 py-3 border-t border-surface-100 text-xs text-surface-400 bg-surface-50">
            <strong>Legend:</strong>{' '}
            <span className="text-emerald-600">✓ Done</span> = Week Complete |{' '}
            <span className="text-blue-600">✓ Lab</span> = Lab Signed Off
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STUDENT VIEW
// ═══════════════════════════════════════════════════════════════════════════

function StudentView() {
  const { profile } = useAuth()
  const { report, loading, refresh } = useStudentLabReport()
  const { signOffLab, markAllDone } = useLabTrackerActions()
  const [showHistory, setShowHistory] = useState(true)

  // Sign Off modal state (for individual lab sign-offs)
  const [signOffModal, setSignOffModal] = useState({
    open: false,
    weekNumber: null,
    weekDate: '',
    className: '',
    classId: '',
    weekStartDate: '',
    weekEndDate: '',
  })

  // All Done modal state
  const [allDoneModal, setAllDoneModal] = useState({
    open: false,
    weekNumber: null,
    weekDate: '',
    classes: [],
    labStatuses: [],
  })

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-600" /></div>
  }

  if (!report || report.classes.length === 0) {
    return <EmptyState text="You are not enrolled in any classes" />
  }

  // Separate tracked classes (have weekly lab tracker) from non-tracked
  const trackedClasses = report.classes.filter(cls => cls.trackingType !== 'None')

  // Determine current week for each class
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const studentName = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim()

  const currentWeekInfos = report.classes.map(cls => {
    const cw = cls.classWeeks || []
    let currentWeek = null
    for (const wk of cw) {
      const wkStart = new Date(wk.startDate)
      wkStart.setHours(0, 0, 0, 0)
      const wkEnd = new Date(wk.endDate)
      wkEnd.setHours(23, 59, 59, 999)
      if (today >= wkStart && today <= wkEnd) { currentWeek = wk; break }
    }
    if (!currentWeek) {
      for (let i = 0; i < cw.length; i++) {
        const wkStart = new Date(cw[i].startDate)
        wkStart.setHours(0, 0, 0, 0)
        const nextStart = i + 1 < cw.length ? new Date(cw[i + 1].startDate) : null
        if (nextStart) nextStart.setHours(0, 0, 0, 0)
        if (today >= wkStart && (!nextStart || today < nextStart)) { currentWeek = cw[i]; break }
      }
    }
    const ws = currentWeek ? (cls.weeks[currentWeek.weekNumber] || { labComplete: false, allDone: false }) : null
    return { cls, currentWeek, status: ws }
  }).filter(info => info.currentWeek)

  // Tracked classes need lab sign-off; non-tracked are automatically satisfied
  const trackedWeekInfos = currentWeekInfos.filter(info => info.cls.trackingType !== 'None')

  // "All done" banner only shows when tracked classes exist AND all have allDone=true
  // Students with only non-tracked classes always see the All Done button flow
  const allClassesDone = currentWeekInfos.length > 0 &&
    trackedWeekInfos.length > 0 &&
    trackedWeekInfos.every(info => info.status?.allDone)

  // Build week date label from the first class that has a current week
  const firstWeekInfo = currentWeekInfos[0]
  const currentWeekNumber = firstWeekInfo?.currentWeek?.weekNumber
  const currentWeekLabel = firstWeekInfo ? (() => {
    const sd = new Date(firstWeekInfo.currentWeek.startDate)
    const ed = new Date(firstWeekInfo.currentWeek.endDate)
    return `${sd.getMonth() + 1}/${sd.getDate()} — ${ed.getMonth() + 1}/${ed.getDate()}`
  })() : ''

  // Open sign-off modal for a specific class/week
  const openSignOff = (cls, weekNumber, weekStartDate, weekEndDate) => {
    const sd = new Date(weekStartDate)
    const ed = new Date(weekEndDate)
    const dateLabel = `${sd.getMonth() + 1}/${sd.getDate()} — ${ed.getMonth() + 1}/${ed.getDate()}`

    setSignOffModal({
      open: true,
      weekNumber,
      weekDate: dateLabel,
      className: cls.className,
      classId: cls.classId || '',
      weekStartDate,
      weekEndDate,
    })
  }

  // Handle individual lab sign-off
  const handleSignOff = async (instructor) => {
    const result = await signOffLab(
      profile?.user_id,
      profile?.email,
      studentName,
      signOffModal.className,
      signOffModal.classId,
      signOffModal.weekNumber,
      signOffModal.weekStartDate,
      signOffModal.weekEndDate,
      instructor
    )
    if (result.success) refresh()
  }

  // Open All Done modal
  const openAllDone = () => {
    const classNames = currentWeekInfos.map(info => info.cls.className)
    // Lab statuses only for tracked classes (non-tracked don't need sign-off)
    const labStatuses = trackedWeekInfos.map(info => ({
      className: info.cls.className,
      labComplete: info.status?.labComplete || false,
      allDone: info.status?.allDone || false,
    }))

    const weekStartDate = firstWeekInfo?.currentWeek?.startDate || ''
    const weekEndDate = firstWeekInfo?.currentWeek?.endDate || ''

    setAllDoneModal({
      open: true,
      weekNumber: currentWeekNumber,
      weekDate: currentWeekLabel,
      weekStartDate,
      weekEndDate,
      classes: classNames,
      labStatuses,
    })
  }

  // Handle All Done badge verification
  const handleAllDone = async (instructor) => {
    // Pass all classes so markAllDone can compute week dates for signup cancellation;
    // trackingType tells markAllDone which classes to skip tracker row creation for
    const classInfos = currentWeekInfos.map(info => ({
      className: info.cls.className,
      classId: info.cls.classId || '',
      trackingType: info.cls.trackingType || 'Weekly',
      weekNumber: info.currentWeek.weekNumber,
      weekStartDate: info.currentWeek.startDate,
      weekEndDate: info.currentWeek.endDate,
    }))

    const result = await markAllDone(
      profile?.user_id,
      profile?.email,
      studentName,
      classInfos,
      instructor
    )
    if (result.success) {
      toast.success(`All Done — confirmed by ${instructor.first_name} ${instructor.last_name}`)
      refresh()
    }
  }

  return (
    <div className="space-y-5">
      {/* ── CURRENT WEEK STATUS ── */}
      {currentWeekInfos.length > 0 && (
        <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
          <div className="bg-gradient-to-r from-brand-600 to-brand-700 text-white px-4 py-3">
            <h3 className="font-semibold text-sm">
              This Week — W{currentWeekNumber}
              <span className="ml-2 font-normal opacity-80 text-xs">{currentWeekLabel}</span>
            </h3>
          </div>

          {trackedWeekInfos.map(({ cls, currentWeek, status }) => {
            const labDone = status?.labComplete
            const allDone = status?.allDone

            return (
              <div key={cls.className} className="px-4 py-3 border-b border-surface-100 last:border-b-0">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <span className="font-semibold text-sm text-surface-900">{cls.className}</span>
                    {cls.description && <span className="ml-2 text-xs text-surface-400">{cls.description}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {allDone ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-200">
                        <BadgeCheck size={14} /> Done
                      </span>
                    ) : labDone ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1.5 rounded-full border border-blue-200">
                        <CheckCircle2 size={14} /> Lab Signed Off
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs font-semibold text-surface-400 bg-surface-50 px-3 py-1.5 rounded-full border border-surface-200">
                        <Clock size={14} /> Not Signed Off
                      </span>
                    )}

                    {!labDone && !allDone && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          openSignOff(cls, currentWeek.weekNumber, currentWeek.startDate, currentWeek.endDate)
                        }}
                        className="flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full border border-amber-200
                                   hover:bg-amber-100 transition cursor-pointer"
                      >
                        <ShieldCheck size={14} /> Sign Off Lab
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          {/* ALL DONE Button — prominent, distinct emerald styling */}
          {allClassesDone ? (
            <div className="text-center py-3">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 bg-emerald-50 px-6 py-3 rounded-full">
                <BadgeCheck size={20} /> All Classes Done This Week
              </span>
            </div>
          ) : (() => {
            // Only tracked classes need lab sign-off; non-tracked are automatically satisfied
            const allLabsSigned = trackedWeekInfos.length === 0 || trackedWeekInfos.every(info => info.status?.labComplete)
            const unsignedCount = trackedWeekInfos.filter(info => !info.status?.labComplete).length
            return (
              <div className={`mt-4 p-4 rounded-xl border-2 ${allLabsSigned ? 'bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200' : 'bg-surface-50 border-surface-200'}`}>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <h4 className={`text-sm font-bold flex items-center gap-2 ${allLabsSigned ? 'text-emerald-900' : 'text-surface-500'}`}>
                      <Star size={16} className={allLabsSigned ? 'text-emerald-600' : 'text-surface-400'} />
                      All work completed for the week?
                    </h4>
                    {allLabsSigned ? (
                      <p className="text-xs text-emerald-700 mt-1">
                        {trackedWeekInfos.length > 0
                          ? 'All labs signed off — make sure no work orders are open or late, and no outstanding tasks remain from your instructor. An instructor badge swipe is required to confirm.'
                          : 'Make sure no work orders are open or late, and no outstanding tasks remain from your instructor. An instructor badge swipe is required to confirm.'}
                      </p>
                    ) : (
                      <p className="text-xs text-amber-700 mt-1 flex items-center gap-1.5">
                        <AlertTriangle size={12} className="flex-shrink-0" />
                        {unsignedCount === 1
                          ? '1 lab still needs to be signed off before you can mark All Done.'
                          : `${unsignedCount} labs still need to be signed off before you can mark All Done.`}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={allLabsSigned ? openAllDone : undefined}
                    disabled={!allLabsSigned}
                    title={!allLabsSigned ? 'All labs must be signed off first' : undefined}
                    className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition
                      ${allLabsSigned
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-emerald-200 active:scale-[0.98] cursor-pointer'
                        : 'bg-surface-200 text-surface-400 cursor-not-allowed'
                      }`}
                  >
                    <Star size={18} />
                    All Done
                  </button>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Print button */}
      <div>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 px-4 py-2 bg-surface-100 text-surface-600 rounded-lg text-sm font-medium hover:bg-surface-200"
        >
          <Printer size={16} /> Print Report
        </button>
      </div>

      {/* History Toggle */}
      <button
        onClick={() => setShowHistory(!showHistory)}
        className="flex items-center gap-2 px-4 py-2.5 bg-surface-50 border border-surface-200 rounded-lg text-sm font-medium text-surface-600 hover:bg-surface-100"
      >
        {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {showHistory ? 'Hide History' : 'Show Full History'}
      </button>

      {/* All Weeks Tables */}
      {showHistory && trackedClasses.map(cls => {
        const totalWeeks = cls.totalWeeks || 8
        const classWeeks = cls.classWeeks || []

        return (
          <div key={cls.className} className="bg-white rounded-xl border border-surface-200 overflow-hidden">
            {/* Class Header */}
            <div className="bg-gradient-to-r from-brand-600 to-brand-700 text-white px-4 py-3 font-semibold text-sm">
              {cls.className}
              {cls.description && <span className="ml-2 opacity-80 font-normal text-xs">{cls.description}</span>}
              <span className="ml-2 opacity-60 text-xs">({totalWeeks} weeks)</span>
            </div>

            {/* Weeks Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50">
                    {Array.from({ length: totalWeeks }, (_, i) => {
                      const wk = classWeeks[i]
                      const label = wk?.isFinals ? 'Finals' : `W${i + 1}`
                      let dateRange = ''
                      if (wk) {
                        const s = new Date(wk.startDate)
                        const e = new Date(wk.endDate)
                        dateRange = `${s.getMonth() + 1}/${s.getDate()}-${e.getMonth() + 1}/${e.getDate()}`
                      }
                      return (
                        <th key={i} className="px-2 py-2.5 text-center font-semibold text-surface-600 min-w-[80px]">
                          <div className={wk?.isFinals ? 'text-red-600' : ''}>{label}</div>
                          {dateRange && <div className="text-[10px] font-normal text-surface-400">{dateRange}</div>}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {Array.from({ length: totalWeeks }, (_, i) => {
                      const wn = i + 1
                      const ws = cls.weeks[wn] || { labComplete: false, allDone: false }
                      const wk = classWeeks[i]
                      const isSignable = wk ? today >= new Date(wk.startDate) : true

                      let content
                      if (ws.allDone) {
                        content = <span className="text-emerald-600 font-semibold">✓ Done</span>
                      } else if (ws.labComplete) {
                        content = <span className="text-blue-600 font-semibold">✓ Lab</span>
                      } else if (!isSignable) {
                        // Future week — locked
                        content = (
                          <div className="flex flex-col items-center">
                            <div className="w-8 h-8 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center">
                              <Lock size={16} className="text-amber-500" />
                            </div>
                          </div>
                        )
                      } else {
                        // Past/current signable week — clickable sign-off button
                        content = (
                          <button
                            onClick={() => openSignOff(cls, wn, wk?.startDate || '', wk?.endDate || '')}
                            className="w-8 h-8 rounded-lg bg-brand-50 border border-brand-200 flex items-center justify-center
                                       hover:bg-brand-100 hover:border-brand-300 transition cursor-pointer mx-auto
                                       active:scale-95"
                            title={`Sign off lab for Week ${wn}`}
                          >
                            <ShieldCheck size={16} className="text-brand-600" />
                          </button>
                        )
                      }

                      return (
                        <td key={i} className="px-2 py-3 text-center border-t border-surface-100">
                          {content}
                        </td>
                      )
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {/* Legend */}
      <div className="text-xs text-surface-400 bg-surface-50 rounded-xl p-3 flex flex-wrap gap-x-4 gap-y-1">
        <span><span className="text-emerald-600 font-semibold">✓ Done</span> = Week Complete</span>
        <span><span className="text-blue-600 font-semibold">✓ Lab</span> = Lab Signed Off</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex w-5 h-5 rounded bg-brand-50 border border-brand-200 items-center justify-center">
            <ShieldCheck size={10} className="text-brand-600" />
          </span>
          = Click to Sign Off
        </span>
        <span className="inline-flex items-center gap-1"><Lock size={12} className="text-amber-500" /> = Future Week (locked)</span>
      </div>

      {/* Sign Off Modal */}
      <SignOffModal
        isOpen={signOffModal.open}
        onClose={() => setSignOffModal(prev => ({ ...prev, open: false }))}
        studentName={studentName}
        weekNumber={signOffModal.weekNumber}
        weekDate={signOffModal.weekDate}
        className={signOffModal.className}
        onSignOff={handleSignOff}
      />

      {/* All Done Modal */}
      <AllDoneModal
        isOpen={allDoneModal.open}
        onClose={() => setAllDoneModal(prev => ({ ...prev, open: false }))}
        studentName={studentName}
        studentEmail={profile?.email}
        weekNumber={allDoneModal.weekNumber}
        weekDate={allDoneModal.weekDate}
        weekStartDate={allDoneModal.weekStartDate}
        weekEndDate={allDoneModal.weekEndDate}
        classes={allDoneModal.classes}
        labStatuses={allDoneModal.labStatuses}
        onAllDone={handleAllDone}
      />
    </div>
  )
}

// ─── Shared Components ──────────────────────────────────────────────────────

function EmptyState({ text }) {
  return (
    <div className="text-center py-16 text-surface-400">
      <BarChart3 size={40} className="mx-auto mb-4 text-surface-200" />
      <p className="text-sm">{text}</p>
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}
