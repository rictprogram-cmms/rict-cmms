/**
 * RICT CMMS — AllDoneModal
 *
 * The instructor-swipe "All Done" dialog. Moved here from
 * WeeklyLabsTrackerPage.jsx (retired 2026-09 — labs are tracked in D2L now)
 * so the Time Cards page can open it; students confirm their hours there
 * before leaving, which is when All Done happens.
 *
 * What it checks before the badge input unlocks:
 *   • every open WO assigned to the student has a work log this week
 *   • every late WO (anyone's) has a work log this week
 *   • every weekly reminder in scope has been acknowledged
 *   Make-up hours owed this week are shown for the instructor to review.
 * The lab sign-off gate that used to sit in front of these is gone.
 *
 * On a recognised instructor badge it calls onAllDone(instructor); the caller
 * (AllDoneSection) runs useLabTrackerActions().markAllDone, which cancels the
 * week's remaining signups, writes the time_clock 'All Done' marker and the
 * audit row. This modal never punches the student out — a note says so.
 *
 * Props
 *   isOpen, onClose
 *   studentName, studentEmail
 *   weekNumber, weekDate ("9/14 — 9/18"), weekStartDate, weekEndDate (ISO)
 *   classes    — [{ className, classId }] enrolled classes with a current week
 *   onAllDone  — async (instructor) => void
 *   punchedIn  — boolean, shows the punch-out reminder wording
 *
 * Accessibility: useDialogA11y (focus in, Tab trap, Esc, focus return),
 * role="dialog" + aria-modal, labelled badge input, 44px controls, live
 * regions on the checklist / error, role="note" reminder.
 *
 * File: src/components/AllDoneModal.jsx
 */

import { useState, useEffect, useRef } from 'react'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { fetchMakeupOverlay } from '@/hooks/useMakeupHours'
import {
  Loader2, CheckCircle2, X, AlertTriangle, ClipboardList, Clock, Star,
  BookOpen, UserCircle, RotateCcw,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function AllDoneModal({ isOpen, onClose, studentName, studentEmail, weekNumber, weekDate, weekStartDate, weekEndDate, classes, onAllDone, punchedIn = false }) {
  const dialogRef = useDialogA11y(!!isOpen, onClose)
  const [badge, setBadge] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [studentWorkOrders, setStudentWorkOrders] = useState([])
  const [lateWorkOrders, setLateWorkOrders] = useState([])
  const [workOrderLogs, setWorkOrderLogs] = useState({})
  const [lateWorkOrderLogs, setLateWorkOrderLogs] = useState({})
  const [loadingWOs, setLoadingWOs] = useState(true)
  const [weeklyReminders, setWeeklyReminders] = useState([])  // [{id, class_id, class_label, message}]
  const [acknowledgedIds, setAcknowledgedIds] = useState(() => new Set())
  // Make-up hours owed THIS week from approved requests (absence / late submission) the week before:
  //   [{ requestId, courseId, owed, logged, windowDays: ['YYYY-MM-DD', …], complete }]
  const [makeups, setMakeups] = useState([])
  // Ref-based guard to prevent double-fire from rapid badge swipe events
  const processingRef = useRef(false)

  // Fetch weekly reminders when modal opens — global + any class-scoped
  // reminders for the classes this student is enrolled in for the current
  // week, plus any per-student reminders addressed to this specific student.
  useEffect(() => {
    if (!isOpen) return
    const enrolledClassIds = (classes || [])
      .map(c => c?.classId)
      .filter(Boolean)

    supabase
      .from('weekly_reminders')
      .select('*')
      .then(({ data, error }) => {
        if (error) {
          console.error('weekly_reminders fetch error:', error)
          setWeeklyReminders([])
          return
        }
        const all = data || []
        // Keep: non-empty message AND in scope for this student
        //   • class_id == null → global (always in scope)
        //   • class_id matches one of student's classes → in scope
        //   • user_email == null → not student-targeted (always in scope)
        //   • user_email matches this student → in scope
        const filtered = all
          .filter(r => r.message && r.message.trim())
          .filter(r => r.class_id == null || enrolledClassIds.includes(r.class_id))
          .filter(r => r.user_email == null || r.user_email === studentEmail)

        // Label + tier metadata for display
        const labeled = filtered.map(r => {
          const cls = r.class_id
            ? (classes || []).find(c => c?.classId === r.class_id)
            : null
          return {
            ...r,
            _label: r.class_id ? (cls?.className || r.class_id) : 'All Classes',
            _isGlobal: r.class_id == null,
            _isPerStudent: r.user_email != null,
          }
        }).sort((a, b) => {
          // D1: Per-Student → Per-Class → Global (most relevant first)
          const tier = (r) => r._isPerStudent ? 0 : r._isGlobal ? 2 : 1
          const ta = tier(a)
          const tb = tier(b)
          if (ta !== tb) return ta - tb
          return a._label.localeCompare(b._label)
        })

        setWeeklyReminders(labeled)
      })
      .catch(() => setWeeklyReminders([]))
  }, [isOpen, classes, studentEmail])

  // Fetch make-up hours owed this week (approved requests → first two open lab
  // days). Uses the same SQL window helper the auto-complete trigger uses so
  // the modal and the trigger always agree on which days count.
  useEffect(() => {
    if (!isOpen || !studentEmail || !weekStartDate || !weekEndDate) { setMakeups([]); return }
    let cancelled = false
    const ws = weekStartDate.substring(0, 10)
    const we = weekEndDate.substring(0, 10)

    async function loadMakeups() {
      try {
        const overlay = await fetchMakeupOverlay({ emails: [studentEmail], rangeStart: ws, rangeEnd: we })
        const inWeek = (overlay.requests || []).filter(r => r.makeupWeekMonday >= ws && r.makeupWeekMonday <= we)
        if (inWeek.length === 0) { if (!cancelled) setMakeups([]); return }

        const rows = []
        for (const r of inWeek) {
          let windowDays = []
          try {
            const { data } = await supabase.rpc('makeup_window_days', { p_monday: r.makeupWeekMonday })
            windowDays = Array.isArray(data) ? data.map(d => String(d).substring(0, 10)) : []
          } catch { /* fall through with empty window */ }

          let logged = 0
          if (windowDays.length > 0) {
            // Fake-UTC convention: punch_in wall-clock date == local date, so a
            // T00:00:00+00 … T23:59:59+00 range on the window days is exact.
            const from = `${windowDays[0]}T00:00:00+00`
            const to = `${windowDays[windowDays.length - 1]}T23:59:59+00`
            let q = supabase
              .from('time_clock')
              .select('punch_in, total_hours, entry_type, course_id, class_id')
              .eq('user_email', studentEmail)
              .gte('punch_in', from)
              .lte('punch_in', to)
            if (r.course_id) q = q.eq('course_id', r.course_id)
            else if (r.class_id) q = q.eq('class_id', r.class_id)
            const { data: tc } = await q
            ;(tc || []).forEach(e => {
              if (e.entry_type === 'Volunteer') return
              const d = String(e.punch_in || '').substring(0, 10)
              if (!windowDays.includes(d)) return
              logged += parseFloat(e.total_hours) || 0
            })
          }
          const owed = Number(r.hours_missed) || 0
          rows.push({
            requestId: r.request_id,
            courseId: r.course_id || r.class_id || '',
            owed,
            logged: Math.round(logged * 100) / 100,
            windowDays,
            complete: !!r.makeup_complete || logged >= owed,
          })
        }
        if (!cancelled) setMakeups(rows)
      } catch (err) {
        console.error('All Done make-up fetch error:', err)
        if (!cancelled) setMakeups([])
      }
    }
    loadMakeups()
    return () => { cancelled = true }
  }, [isOpen, studentEmail, weekStartDate, weekEndDate])

  // Fetch work orders when modal opens
  useEffect(() => {
    if (!isOpen || !studentEmail) return
    setLoadingWOs(true)
    setBadge('')
    setError('')
    setAcknowledgedIds(new Set())
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
          const logs = mustData(await supabase
            .from('work_log')
            .select('log_id, wo_id, timestamp, user_name, hours, work_description, entry_type')
            .in('wo_id', woIds)
            .eq('user_email', studentEmail)
            .order('timestamp', { ascending: false }), 'work_log.select')
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
          const lateLogs = mustData(await supabase
            .from('work_log')
            .select('log_id, wo_id, timestamp, user_name, user_email, hours, work_description, entry_type')
            .in('wo_id', lateWoIds)
            .order('timestamp', { ascending: false }), 'work_log.select')
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
  // Labs live in D2L now — there is no lab sign-off gate any more.
  const allLabsDone = true
  const hasMakeups = makeups.length > 0
  const makeupsOutstanding = makeups.filter(m => !m.complete)
  const fmtDay = (d) => {
    const dt = new Date(d + 'T00:00:00')
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })
  }
  const fmtH = (n) => (Number(n) % 1 === 0 ? String(Number(n)) : Number(n).toFixed(2))

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
  // All reminders must be acknowledged individually before badge swipe is allowed
  const allRemindersAcked = weeklyReminders.length === 0
    || weeklyReminders.every(r => acknowledgedIds.has(r.id))
  const canVerify = allLabsDone && allWOsHaveLogsThisWeek && allLateWOsHaveLogs && allRemindersAcked

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
        ref={dialogRef} role="dialog" aria-modal="true" aria-label="Mark week done"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header — Emerald gradient to distinguish from regular Sign Off */}
        <div className="relative bg-gradient-to-r from-emerald-600 to-emerald-700 px-6 py-5 text-white text-center flex-shrink-0">
          <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 p-1 rounded-full hover:bg-white/20 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
            <X size={20} aria-hidden="true" />
          </button>
          <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
            <Star size={28} aria-hidden="true" />
          </div>
          <h2 className="text-lg font-bold">Mark All Done</h2>
          <p className="text-sm opacity-80 mt-1">
            This records you as finished for the week, clears your remaining lab signups, and marks your hours as fulfilled.
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

          {/* ── CLASSES THIS WEEK ── */}
          <div className="px-6 py-4 border-b border-surface-200">
            <div className="flex items-center gap-2 mb-2">
              <BookOpen size={16} className="text-surface-500" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-surface-900">Classes this week</h3>
            </div>
            {(!classes || classes.length === 0) ? (
              <div className="text-sm text-surface-400 italic">No classes found for this week.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {classes.map((c, idx) => (
                  <span key={c.classId || idx} className="inline-flex items-center px-3 py-1 rounded-lg border border-surface-200 bg-surface-50 text-sm font-medium text-surface-800">
                    {c.className}
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-surface-500 mt-2">Lab completion is tracked in D2L. All Done here records that you are finished for the week.</p>
          </div>

          {/* ── MAKE-UP HOURS (approved requests → this week) ── */}
          {hasMakeups && (
            <div
              className={`px-6 py-4 border-b ${makeupsOutstanding.length > 0 ? 'border-amber-200 bg-amber-50/30' : 'border-emerald-200 bg-emerald-50/30'}`}
              role="region"
              aria-label="Make-up hours owed this week"
            >
              <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg ${
                makeupsOutstanding.length > 0 ? 'bg-amber-100 border border-amber-200' : 'bg-emerald-100 border border-emerald-200'
              }`}>
                <RotateCcw size={16} className={makeupsOutstanding.length > 0 ? 'text-amber-600' : 'text-emerald-600'} aria-hidden="true" />
                <h3 className={`text-sm font-semibold ${makeupsOutstanding.length > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
                  Make-Up Hours
                  <span className="font-normal opacity-70 ml-1">(approved request last week)</span>
                </h3>
              </div>
              <div className="space-y-2">
                {makeups.map(m => (
                  <div
                    key={m.requestId}
                    className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-sm ${
                      m.complete ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-surface-900">{m.courseId || 'Class'} <span className="text-xs font-normal text-surface-400">· {m.requestId}</span></div>
                      <div className="text-xs text-surface-500">
                        {fmtH(m.owed)} hr owed · must be logged on {m.windowDays.length > 0 ? m.windowDays.map(fmtDay).join(' / ') : 'the first two lab days'}
                      </div>
                    </div>
                    {m.complete ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700 whitespace-nowrap">
                        <CheckCircle2 size={14} aria-hidden="true" /> {fmtH(m.logged)}/{fmtH(m.owed)} hr — Complete
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs font-semibold text-amber-700 whitespace-nowrap">
                        <Clock size={14} aria-hidden="true" /> {fmtH(m.logged)}/{fmtH(m.owed)} hr — {fmtH(m.owed - m.logged)} short
                      </span>
                    )}
                  </div>
                ))}
                {makeupsOutstanding.length > 0 ? (
                  <div role="alert" className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 font-medium">
                    <AlertTriangle size={14} className="flex-shrink-0 mt-px" aria-hidden="true" />
                    <span>
                      Make-up hours are still outstanding. Marking All Done records this week's hours as fulfilled
                      (base + make-up) even though the make-up time hasn't been logged — instructor's call.
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 font-medium">
                    <CheckCircle2 size={14} aria-hidden="true" />
                    All make-up hours logged
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── OPEN WORK ORDERS (assigned to student) ── */}
          <div className={`px-6 py-4 border-b ${hasOpenWOs && anyWOMissingLog ? 'border-red-200 bg-red-50/30' : hasOpenWOs && !anyWOMissingLog ? 'border-emerald-200 bg-emerald-50/30' : 'border-surface-200'}`}>
            <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg ${
              hasOpenWOs && anyWOMissingLog
                ? 'bg-red-100 border border-red-200'
                : hasOpenWOs && !anyWOMissingLog
                ? 'bg-emerald-100 border border-emerald-200'
                : ''
            }`}>
              <ClipboardList size={16} className={hasOpenWOs && anyWOMissingLog ? 'text-red-600' : hasOpenWOs && !anyWOMissingLog ? 'text-emerald-600' : 'text-surface-500'} aria-hidden="true" />
              <h3 className={`text-sm font-semibold ${hasOpenWOs && anyWOMissingLog ? 'text-red-800' : hasOpenWOs && !anyWOMissingLog ? 'text-emerald-800' : 'text-surface-900'}`}>
                Open Work Orders
                <span className="font-normal opacity-70 ml-1">(assigned to {studentName})</span>
              </h3>
              {hasOpenWOs && anyWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-red-700 flex items-center gap-1">
                  <AlertTriangle size={11} aria-hidden="true" /> Missing log entries this week
                </span>
              )}
              {hasOpenWOs && !anyWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 size={11} aria-hidden="true" /> Log entries recorded this week
                </span>
              )}
            </div>

            {loadingWOs ? (
              <div className="flex justify-center py-4">
                <Loader2 size={20} className="animate-spin text-surface-400" aria-hidden="true" />
              </div>
            ) : studentWorkOrders.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
                <CheckCircle2 size={16} aria-hidden="true" />
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
                                  <AlertTriangle size={10} aria-hidden="true" /> LATE
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
                            <Clock size={11} className={hasLogThisWeek ? 'text-emerald-500' : 'text-red-400'} aria-hidden="true" />
                            <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasLogThisWeek ? 'text-emerald-700' : 'text-red-600'}`}>
                              Work Log — {logs.length} {logs.length === 1 ? 'entry' : 'entries'} &nbsp;·&nbsp; {logs.reduce((sum, l) => sum + (parseFloat(l.hours) || 0), 0).toFixed(2)} hrs total
                            </span>
                            {!hasLogThisWeek && (
                              <span className="ml-auto text-[10px] font-bold text-red-600 flex items-center gap-0.5">
                                <AlertTriangle size={10} aria-hidden="true" /> No entry this week
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
                          <Clock size={11} className="text-surface-300" aria-hidden="true" />
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
              <AlertTriangle size={16} className={hasLateWOs && anyLateWOMissingLog ? 'text-red-600' : hasLateWOs ? 'text-emerald-600' : 'text-red-500'} aria-hidden="true" />
              <h3 className={`text-sm font-semibold ${hasLateWOs && anyLateWOMissingLog ? 'text-red-800' : hasLateWOs ? 'text-emerald-800' : 'text-surface-900'}`}>
                Late Work Orders
                <span className="font-normal opacity-70 ml-1">(all students)</span>
              </h3>
              {hasLateWOs && anyLateWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-red-700 flex items-center gap-1">
                  <AlertTriangle size={11} aria-hidden="true" /> Missing log entries this week
                </span>
              )}
              {hasLateWOs && !anyLateWOMissingLog && (
                <span className="ml-auto text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 size={11} aria-hidden="true" /> All have log entries this week
                </span>
              )}
            </div>

            {loadingWOs ? (
              <div className="flex justify-center py-4">
                <Loader2 size={20} className="animate-spin text-surface-400" aria-hidden="true" />
              </div>
            ) : lateWorkOrders.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
                <CheckCircle2 size={16} aria-hidden="true" />
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
                                <AlertTriangle size={10} aria-hidden="true" /> LATE
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
                          <Clock size={11} className={hasLateLogThisWeek ? 'text-emerald-500' : 'text-red-400'} aria-hidden="true" />
                          <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasLateLogThisWeek ? 'text-emerald-700' : 'text-red-600'}`}>
                            {hasLateLogThisWeek
                              ? `This week — ${thisWeekLogs.length} ${thisWeekLogs.length === 1 ? 'entry' : 'entries'}`
                              : 'No work log entries this week'}
                          </span>
                          {!hasLateLogThisWeek && (
                            <span className="ml-auto text-[10px] font-bold text-red-600 flex items-center gap-0.5">
                              <AlertTriangle size={10} aria-hidden="true" /> Required
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
                            <Clock size={11} className="text-surface-300" aria-hidden="true" />
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
                <AlertTriangle size={14} className="flex-shrink-0" aria-hidden="true" />
                Instructor: Review the items above before approving All Done. Swiping your badge will mark everything complete regardless.
              </p>
            </div>
          )}

          {/* Weekly Reminder Messages — one card per scope (global + per-class) */}
          {weeklyReminders.length > 0 && (
            <div className="mx-4 my-3 space-y-3" role="region" aria-label="Instructor reminders">
              {weeklyReminders.length > 1 && (
                <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-surface-500">
                  <span>{weeklyReminders.length} messages from your instructor</span>
                  <span aria-live="polite">
                    {acknowledgedIds.size}/{weeklyReminders.length} acknowledged
                  </span>
                </div>
              )}
              {weeklyReminders.map(r => {
                const acked = acknowledgedIds.has(r.id)
                const toggle = () => {
                  setAcknowledgedIds(prev => {
                    const next = new Set(prev)
                    if (next.has(r.id)) next.delete(r.id)
                    else next.add(r.id)
                    return next
                  })
                }
                return (
                  <div
                    key={r.id}
                    className={`rounded-xl border-2 shadow-sm overflow-hidden transition-colors duration-300 ${
                      acked ? 'border-indigo-300 bg-indigo-50' : 'border-red-400 bg-red-50'
                    }`}
                  >
                    <div
                      className={`flex items-center gap-2 px-4 py-2 transition-colors duration-300 ${
                        acked ? 'bg-indigo-600' : 'bg-red-600'
                      }`}
                    >
                      {r._isPerStudent ? (
                        <UserCircle size={14} className="text-white flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <BookOpen size={14} className="text-white flex-shrink-0" aria-hidden="true" />
                      )}
                      <span className="text-xs font-bold text-white uppercase tracking-wide truncate">
                        {r._isPerStudent
                          ? `Personal Message for ${(studentName || '').split(' ')[0] || 'You'}`
                          : r._isGlobal
                            ? 'Message from Your Instructor'
                            : `Message for ${r._label}`}
                      </span>
                      {!acked && (
                        <span className="ml-auto text-[10px] font-bold text-white/90 flex items-center gap-1 flex-shrink-0">
                          <AlertTriangle size={11} aria-hidden="true" /> Must acknowledge
                        </span>
                      )}
                    </div>
                    <div className="px-4 py-3">
                      <div
                        className={`text-sm font-semibold mb-3 reminder-markdown ${
                          acked ? 'text-indigo-900' : 'text-red-900'
                        }`}
                      >
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current rounded"
                              >
                                {children}
                              </a>
                            ),
                            ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
                            p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-snug">{children}</p>,
                            code: ({ children }) => (
                              <code className="px-1 py-0.5 rounded bg-black/5 text-[0.85em] font-mono">{children}</code>
                            ),
                            h1: ({ children }) => <p className="font-bold text-base mb-1.5">{children}</p>,
                            h2: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
                            h3: ({ children }) => <p className="font-semibold text-sm mb-1">{children}</p>,
                          }}
                        >
                          {r.message}
                        </ReactMarkdown>
                      </div>
                      <label className="flex items-center gap-2.5 cursor-pointer select-none group">
                        <input
                          type="checkbox"
                          checked={acked}
                          onChange={toggle}
                          className="sr-only"
                          aria-label={`Acknowledge: ${r._isGlobal ? 'Message from Your Instructor' : `Message for ${r._label}`}`}
                        />
                        <div
                          aria-hidden="true"
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                            acked
                              ? 'bg-indigo-600 border-indigo-600'
                              : 'bg-white border-red-400 group-hover:border-red-500 group-focus-within:ring-2 group-focus-within:ring-red-400'
                          }`}
                        >
                          {acked && (
                            <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                              <path d="M1 4L4 7L10 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        <span
                          className={`text-xs font-semibold transition-colors ${
                            acked ? 'text-indigo-800' : 'text-red-800'
                          }`}
                        >
                          I have read and understood {weeklyReminders.length > 1 ? 'this message' : 'the message above'}
                        </span>
                      </label>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Badge Input */}
          <div className="px-6 py-5">
            {!canVerify && (
              <div className="mb-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 space-y-1">
                <p className="font-bold flex items-center gap-1.5"><AlertTriangle size={13} aria-hidden="true" /> Complete the following before the instructor can swipe:</p>
                {!allLabsDone && <p className="pl-4">• All labs must be signed off</p>}
                {anyWOMissingLog && <p className="pl-4">• Work log entry required for each open work order this week</p>}
                {anyLateWOMissingLog && <p className="pl-4">• Work log entry required for each late work order this week (any student)</p>}
                {weeklyReminders.length > 0 && !allRemindersAcked && (
                  <p className="pl-4">
                    • Acknowledge {weeklyReminders.length === 1
                      ? 'the instructor message above'
                      : `all ${weeklyReminders.length} instructor messages above (${acknowledgedIds.size}/${weeklyReminders.length} done)`}
                  </p>
                )}
              </div>
            )}
            <div
              className={`mb-3 px-4 py-2.5 rounded-lg border text-xs font-medium flex items-center gap-2 ${punchedIn ? 'bg-blue-50 border-blue-200 text-blue-800' : 'bg-surface-50 border-surface-200 text-surface-600'}`}
              role="note"
            >
              <Clock size={14} className="flex-shrink-0" aria-hidden="true" />
              {punchedIn
                ? 'All Done does not punch you out. Remember to punch out on the Time Clock before you leave.'
                : 'You are not punched in right now. All Done will still be recorded for today.'}
            </div>
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
                flex items-center justify-center gap-2 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${canVerify
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed'
                  : 'bg-surface-200 text-surface-400 cursor-not-allowed'
                }`}
            >
              {verifying ? (
                <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Verifying...</>
              ) : (
                <><Star size={18} aria-hidden="true" /> Verify & Mark All Done</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

