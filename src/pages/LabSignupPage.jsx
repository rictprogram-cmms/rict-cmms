import { useState, useMemo, useCallback, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import {
  useLabSignupData, useLabSignupActions, useMySignups,
  useLabCalendar, useLabCalendarActions, useDailyRoster,
  useStudentsList, useInstructorSignup,
  formatDateKey, formatHour, getHourFromTime, getWeekStart,
  timeToMinutes, minutesToTimeStr, findOverlappingClosure,
} from '@/hooks/useLabSignup'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import {
  Calendar, Clock, ChevronLeft, ChevronRight, Plus, X, Trash2,
  CheckCircle2, XCircle, Users, UserPlus, Printer, AlertTriangle,
  Info, CalendarDays, ClipboardList, Shield, Loader2, Ban, Mail,
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

const TABS = [
  { id: 'signup', label: 'Weekly Sign Up', icon: CalendarDays },
  { id: 'mysignups', label: 'My Signups', icon: ClipboardList },
]

const INSTRUCTOR_TABS = [
  { id: 'calendar', label: 'Lab Calendar', icon: Calendar },
  { id: 'roster', label: 'Daily Roster', icon: Users },
  { id: 'adminsignup', label: 'Admin Signup', icon: UserPlus },
]

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function LabSignupPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Lab Signup')
  // Derive isInstructor from manage_others permission for backward compatibility
  const isInstructor = hasPerm('manage_others')
  const [activeTab, setActiveTab] = useState('signup')
  const tabs = isInstructor ? [...TABS, ...INSTRUCTOR_TABS] : TABS

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto">
      {/* Tabs */}
      <div className="flex gap-1 mb-6 overflow-x-auto pb-1">
        {tabs.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-white text-surface-600 hover:bg-surface-50 border border-surface-200'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab Panels */}
      {activeTab === 'signup' && <WeeklySignupTab />}
      {activeTab === 'mysignups' && <MySignupsTab />}
      {activeTab === 'calendar' && isInstructor && <LabCalendarTab />}
      {activeTab === 'roster' && isInstructor && <DailyRosterTab />}
      {activeTab === 'adminsignup' && isInstructor && <AdminSignupTab />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 1: WEEKLY SIGN UP (Major rewrite with multi-class, real-time updates)
// ═══════════════════════════════════════════════════════════════════════════

function WeeklySignupTab() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Lab Signup')
  const isInstructor = hasPerm('manage_others')
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()))

  // Load lab signup settings from DB
  const [labSettings, setLabSettings] = useState({ visibleDays: [1, 2, 3, 4], weeksToDisplay: 4 })
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  useEffect(() => {
    async function loadSettings() {
      const { data } = await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['lab_visible_days', 'lab_weeks_to_display'])

      if (data) {
        const map = {}
        data.forEach(s => { map[s.setting_key] = s.setting_value })

        const days = map.lab_visible_days
          ? map.lab_visible_days.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d))
          : [1, 2, 3, 4]
        const weeks = map.lab_weeks_to_display
          ? parseInt(map.lab_weeks_to_display) || 4
          : 4

        setLabSettings({ visibleDays: days, weeksToDisplay: weeks })
      }
      setSettingsLoaded(true)
    }
    loadSettings()
  }, [])

  // selections: { [classId]: [slotKey, ...] }  — tracks all selected slots per class
  const [selections, setSelections] = useState({})
  // cancellations: [signupId, ...]  — existing signups the user wants to cancel
  const [cancellations, setCancellations] = useState([])
  // Active class the user is currently assigning to
  const [activeClassId, setActiveClassId] = useState('')
  // Post-deadline reason modal
  const [reasonModal, setReasonModal] = useState(null) // { weekIdx, weekStart, deadlinePassed }
  const [reason, setReason] = useState('')
  // Instructor slot detail modal
  const [slotDetail, setSlotDetail] = useState(null) // { date, hour, students: [], loading }

  const openSlotDetail = useCallback(async (dateKey, hour, slot) => {
    const dt = new Date(dateKey + 'T12:00:00')
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const label = `${dayNames[dt.getDay()]}, ${dt.getMonth() + 1}/${dt.getDate()} — ${formatHour(hour)}`
    setSlotDetail({ label, maxStudents: slot.maxStudents, currentSignups: slot.currentSignups, students: [], loading: true })

    try {
      const startTime = `${String(hour).padStart(2, '0')}:00:00`
      const targetDate = new Date(dateKey + 'T00:00:00Z').toISOString()
      const { data } = await supabase
        .from('lab_signup')
        .select('signup_id, user_name, user_email, class_id, status')
        .eq('date', targetDate)
        .eq('start_time', startTime)
        .neq('status', 'Cancelled')
        .order('user_name')

      // Look up class names
      const classIds = [...new Set((data || []).map(s => s.class_id).filter(Boolean))]
      let classNames = {}
      if (classIds.length > 0) {
        const { data: classData } = await supabase
          .from('classes')
          .select('course_id, course_name')
          .in('course_id', classIds)
        ;(classData || []).forEach(c => { classNames[c.course_id] = c.course_name || '' })
      }

      setSlotDetail(prev => ({
        ...prev,
        loading: false,
        students: (data || []).map(s => ({
          name: s.user_name,
          email: s.user_email,
          classId: s.class_id || '',
          className: classNames[s.class_id] || '',
        }))
      }))
    } catch (err) {
      console.error('Slot detail fetch error:', err)
      setSlotDetail(prev => ({ ...prev, loading: false }))
    }
  }, [])

  const { weeks, hours, slots, classes, loading, refresh } = useLabSignupData(
    settingsLoaded ? weekStart.toISOString() : null, labSettings.weeksToDisplay, labSettings.visibleDays
  )
  const { signUpBatchMultiClass, cancelSignup, submitPostDeadlineRequest, saving } = useLabSignupActions()

  // Auto-select first class
  useEffect(() => {
    if (classes.length > 0 && !activeClassId) setActiveClassId(classes[0].courseId)
  }, [classes])

  // Build courseId → courseName map for cell display
  const classNameMap = useMemo(() => {
    const map = {}
    classes.forEach(c => { map[c.courseId] = c.courseName || '' })
    return map
  }, [classes])

  const prevWeek = () => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() - 7)
    setWeekStart(d)
    setSelections({})
    setCancellations([])
  }
  const nextWeek = () => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7)
    setWeekStart(d)
    setSelections({})
    setCancellations([])
  }

  // ── Selection helpers ──

  // All selected slot keys flattened across all classes
  const allSelectedKeys = useMemo(() => {
    const keys = new Set()
    Object.values(selections).forEach(arr => arr.forEach(k => keys.add(k)))
    return keys
  }, [selections])

  // Which class owns a given selected slot
  const classForSlot = useCallback((slotKey) => {
    for (const [cid, arr] of Object.entries(selections)) {
      if (arr.includes(slotKey)) return cid
    }
    return null
  }, [selections])

  // Toggle a slot for the active class
  const toggleSlot = (key) => {
    // Check if this key is already selected by any class
    const owningClass = classForSlot(key)
    if (owningClass) {
      // Deselect it
      setSelections(prev => ({
        ...prev,
        [owningClass]: (prev[owningClass] || []).filter(k => k !== key),
      }))
      return
    }

    if (!activeClassId && !isInstructor) {
      toast.error('Select a class first')
      return
    }

    const cid = isInstructor ? '__instructor__' : activeClassId
    setSelections(prev => ({
      ...prev,
      [cid]: [...(prev[cid] || []), key],
    }))
  }

  // Toggle cancellation of an existing signup
  const toggleCancel = (signupId) => {
    setCancellations(prev =>
      prev.includes(signupId) ? prev.filter(id => id !== signupId) : [...prev, signupId]
    )
  }

  // ── Per-week progress computation ──

  // Get confirmed signups for current user in a given week for a given class
  const getExistingWeekSignups = useCallback((weekIdx, courseId) => {
    const week = weeks[weekIdx]
    if (!week) return 0
    let count = 0
    week.days.forEach(day => {
      hours.forEach(hour => {
        const key = `${day.date}_${hour}`
        const slot = slots[key]
        if (slot?.mySignupId && slot.myClassId === courseId) {
          // Only count if not in cancellations
          if (!cancellations.includes(slot.mySignupId)) {
            count++
          }
        }
      })
    })
    return count
  }, [weeks, hours, slots, cancellations])

  // Get newly selected slots for a given week + class
  const getNewWeekSelections = useCallback((weekIdx, courseId) => {
    const week = weeks[weekIdx]
    if (!week) return 0
    const classSelections = selections[courseId] || []
    let count = 0
    classSelections.forEach(sel => {
      const selDate = sel.split('_')[0]
      if (week.days.some(d => d.date === selDate)) count++
    })
    return count
  }, [weeks, selections])

  // Total progress for a class in a given week = existing (minus cancellations) + new selections
  const getWeekProgress = useCallback((weekIdx, courseId) => {
    return getExistingWeekSignups(weekIdx, courseId) + getNewWeekSelections(weekIdx, courseId)
  }, [getExistingWeekSignups, getNewWeekSelections])

  // ── Get all week selections (new) across all classes for a specific week ──
  const getWeekAllNewSelections = useCallback((weekIdx) => {
    const week = weeks[weekIdx]
    if (!week) return {}
    const result = {}
    for (const [cid, arr] of Object.entries(selections)) {
      const weekSel = arr.filter(sel => {
        const selDate = sel.split('_')[0]
        return week.days.some(d => d.date === selDate)
      })
      if (weekSel.length > 0) result[cid] = weekSel
    }
    return result
  }, [weeks, selections])

  // ── Get cancellations for a specific week ──
  const getWeekCancellations = useCallback((weekIdx) => {
    const week = weeks[weekIdx]
    if (!week) return []
    const ids = []
    week.days.forEach(day => {
      hours.forEach(hour => {
        const key = `${day.date}_${hour}`
        const slot = slots[key]
        if (slot?.mySignupId && cancellations.includes(slot.mySignupId)) {
          ids.push(slot.mySignupId)
        }
      })
    })
    return ids
  }, [weeks, hours, slots, cancellations])

  // ── Count total pending changes for a week ──
  const getWeekChangeCount = useCallback((weekIdx) => {
    const newSel = getWeekAllNewSelections(weekIdx)
    const newCount = Object.values(newSel).reduce((sum, arr) => sum + arr.length, 0)
    const cancelCount = getWeekCancellations(weekIdx).length
    return newCount + cancelCount
  }, [getWeekAllNewSelections, getWeekCancellations])

  // ── Submit handler ──
  const handleSubmit = async (weekIdx) => {
    const week = weeks[weekIdx]
    if (!week) return

    const weekNewSelections = getWeekAllNewSelections(weekIdx)
    const weekCancelIds = getWeekCancellations(weekIdx)
    const hasNew = Object.values(weekNewSelections).some(arr => arr.length > 0)
    const hasCancels = weekCancelIds.length > 0

    if (!hasNew && !hasCancels) return

    // If deadline passed → go through approval flow
    if (week.deadlinePassed && !isInstructor) {
      setReasonModal({ weekIdx, weekStartDate: week.weekStart, deadlinePassed: true })
      return
    }

    // Normal flow — direct submit
    await executeSubmit(weekIdx)
  }

  const executeSubmit = async (weekIdx) => {
    const weekNewSelections = getWeekAllNewSelections(weekIdx)
    const weekCancelIds = getWeekCancellations(weekIdx)

    // Process cancellations
    for (const id of weekCancelIds) {
      await cancelSignup(id)
    }

    // Process new signups
    if (Object.values(weekNewSelections).some(arr => arr.length > 0)) {
      const result = await signUpBatchMultiClass(weekNewSelections)
      if (!result.success) return
    }

    // Clear selections for this week
    const week = weeks[weekIdx]
    setSelections(prev => {
      const next = { ...prev }
      for (const [cid, arr] of Object.entries(next)) {
        next[cid] = arr.filter(sel => {
          const selDate = sel.split('_')[0]
          return !week.days.some(d => d.date === selDate)
        })
        if (next[cid].length === 0) delete next[cid]
      }
      return next
    })
    setCancellations(prev => prev.filter(id => !weekCancelIds.includes(id)))
    refresh()
  }

  const handlePostDeadlineSubmit = async () => {
    if (!reasonModal || !reason.trim()) {
      toast.error('Please provide a reason for the change')
      return
    }

    const { weekIdx, weekStartDate } = reasonModal
    const weekNewSelections = getWeekAllNewSelections(weekIdx)
    const weekCancelIds = getWeekCancellations(weekIdx)
    const week = weeks[weekIdx]

    // Build current and requested slots per class
    // Gather existing signups by class for this week
    const existingByClass = {}
    week.days.forEach(day => {
      hours.forEach(hour => {
        const key = `${day.date}_${hour}`
        const slot = slots[key]
        if (slot?.mySignupId && slot.myClassId) {
          if (!existingByClass[slot.myClassId]) existingByClass[slot.myClassId] = []
          existingByClass[slot.myClassId].push(key)
        }
      })
    })

    // Get all affected classes (classes with new selections or cancellations)
    const affectedClasses = new Set([
      ...Object.keys(weekNewSelections),
      ...Object.keys(existingByClass).filter(cid => {
        // Check if any signup for this class is being cancelled
        return week.days.some(day =>
          hours.some(hour => {
            const key = `${day.date}_${hour}`
            const slot = slots[key]
            return slot?.mySignupId && slot.myClassId === cid && weekCancelIds.includes(slot.mySignupId)
          })
        )
      }),
    ])

    // Submit one request per affected class
    for (const classId of affectedClasses) {
      const currentSlots = (existingByClass[classId] || []).filter(key => {
        const slot = slots[key]
        return slot?.mySignupId && !weekCancelIds.includes(slot.mySignupId)
      })

      const requestedSlots = [
        ...currentSlots,
        ...(weekNewSelections[classId] || []),
      ]

      await submitPostDeadlineRequest(
        classId,
        weekStartDate,
        existingByClass[classId] || [],
        requestedSlots,
        reason.trim()
      )
    }

    // Clear state
    const weekToClean = weeks[weekIdx]
    setSelections(prev => {
      const next = { ...prev }
      for (const [cid, arr] of Object.entries(next)) {
        next[cid] = arr.filter(sel => {
          const selDate = sel.split('_')[0]
          return !weekToClean.days.some(d => d.date === selDate)
        })
        if (next[cid].length === 0) delete next[cid]
      }
      return next
    })
    setCancellations(prev => prev.filter(id => !weekCancelIds.includes(id)))
    setReasonModal(null)
    setReason('')
    refresh()
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-600" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Week Navigation */}
      <div className="bg-white rounded-xl border border-surface-200 p-4">
        <div className="flex items-center justify-center gap-4">
          <button onClick={prevWeek} className="p-2 rounded-lg hover:bg-surface-100">
            <ChevronLeft size={20} />
          </button>
          <span className="text-sm font-semibold text-surface-900 min-w-[200px] text-center">
            {weeks.length > 0 ? `${weeks[0].weekTitle} — ${weeks[weeks.length - 1].weekTitle}` : 'Loading...'}
          </span>
          <button onClick={nextWeek} className="p-2 rounded-lg hover:bg-surface-100">
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      {/* Weeks */}
      {weeks.map((week, wIdx) => {
        const changeCount = getWeekChangeCount(wIdx)
        return (
          <div key={week.weekStart} className="bg-white rounded-xl border border-surface-200 overflow-hidden">
            {/* Week Header */}
            <div className="px-4 py-3 bg-surface-50 border-b border-surface-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-surface-900">{week.weekTitle}</h3>
              <div className="flex items-center gap-2">
                {week.deadlinePassed && !isInstructor && (
                  <span className="text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded-md flex items-center gap-1">
                    <AlertTriangle size={12} /> Deadline Passed — Changes Require Approval
                  </span>
                )}
              </div>
            </div>

            {/* Class Tiles (Students / Work Study) */}
            {!isInstructor && classes.length > 0 && (
              <div className="px-4 py-3 border-b border-surface-100">
                <div className="flex gap-2 overflow-x-auto">
                  {classes.map(cls => {
                    const progress = getWeekProgress(wIdx, cls.courseId)
                    const required = cls.requiredHours
                    const isActive = activeClassId === cls.courseId
                    const isComplete = required > 0 && progress >= required

                    return (
                      <button
                        key={cls.courseId}
                        onClick={() => setActiveClassId(cls.courseId)}
                        className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg text-left border-2 transition-all min-w-[140px] ${
                          isActive
                            ? 'border-brand-500 bg-brand-50 shadow-sm'
                            : 'border-surface-200 hover:border-surface-300 hover:bg-surface-50'
                        }`}
                      >
                        {/* Course ID — primary */}
                        <span className={`text-sm font-bold ${isActive ? 'text-brand-700' : 'text-surface-900'}`}>
                          {cls.courseId}
                        </span>
                        {/* Course Name — secondary */}
                        <span className={`text-[10px] leading-tight ${isActive ? 'text-brand-500' : 'text-surface-400'}`}>
                          {cls.courseName}
                        </span>
                        {/* Progress bar */}
                        {required > 0 && (
                          <div className="w-full mt-1.5 flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  isComplete ? 'bg-emerald-500' : 'bg-brand-500'
                                }`}
                                style={{ width: `${Math.min(100, (progress / required) * 100)}%` }}
                              />
                            </div>
                            <span className={`text-[10px] font-bold tabular-nums ${
                              isComplete ? 'text-emerald-600' : isActive ? 'text-brand-600' : 'text-surface-500'
                            }`}>
                              {progress}/{required}
                            </span>
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Grid */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50">
                    <th className="px-3 py-2 text-left text-surface-500 font-medium w-20">Time</th>
                    {week.days.map(day => (
                      <th key={day.date} className="px-2 py-2 text-center font-medium text-surface-500">
                        <div>{day.dayShort}</div>
                        <div className="text-surface-900 text-sm">{day.dayNum}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hours.map(hour => (
                    <tr key={hour} className="border-t border-surface-100">
                      <td className="px-3 py-1.5 text-surface-500 font-medium whitespace-nowrap">
                        {formatHour(hour)}
                      </td>
                      {week.days.map(day => {
                        const key = `${day.date}_${hour}`
                        const slot = slots[key]
                        if (!slot) return <td key={key} className="px-2 py-1.5" />

                        const isLunch = slot.isLunch
                        const isMine = !!slot.mySignupId
                        const isMarkedCancel = isMine && cancellations.includes(slot.mySignupId)
                        const owningClass = classForSlot(key)
                        const isSelected = !!owningClass

                        // Lunch slots are now selectable — removed isLunch blocks
                        const canSelect = slot.isOpen && !slot.isFull && !isMine && !isSelected
                        const canSelectPostDeadline = slot.isOpen && !slot.isFull && !isMine && !isSelected &&
                          slot.deadlinePassed && !isInstructor
                        const canToggleCancel = isMine

                        // Build cell styles
                        let cellClass = 'w-full h-11 rounded text-[10px] font-bold transition-all relative flex flex-col items-center justify-center '
                        let cellContent = null

                        // Helper: render course ID + name
                        const courseLabel = (cid) => {
                          const name = classNameMap[cid]
                          return name ? (
                            <><span className="leading-tight">{cid}</span><span className="font-normal text-[8px] leading-tight opacity-75 truncate max-w-full">{name}</span></>
                          ) : cid
                        }

                        // Helper: lunch badge overlay
                        const lunchBadge = isLunch ? (
                          <span className="absolute top-0.5 right-0.5 text-[6px] font-bold bg-orange-400 text-white px-1 rounded leading-tight">LUNCH</span>
                        ) : null

                        if (!slot.isOpen) {
                          // Distinguish a within-day closure (e.g. faculty meeting
                          // 2-3pm) from the day being closed entirely. Both render
                          // non-interactive, but the closure case shows the reason.
                          if (slot.isHourClosed) {
                            cellClass += 'bg-red-50 text-red-500 cursor-default border border-red-200'
                            cellContent = (
                              <span className="inline-flex items-center gap-0.5 leading-none">
                                <Ban size={10} aria-hidden="true" />
                                <span className="text-[8px] font-semibold uppercase">Closed</span>
                              </span>
                            )
                          } else {
                            cellClass += 'bg-red-50 text-red-300 cursor-default'
                            cellContent = '—'
                          }
                        } else if (isMarkedCancel) {
                          cellClass += 'bg-red-100 border-2 border-red-400 text-red-500 cursor-pointer line-through'
                          cellContent = slot.myClassId ? courseLabel(slot.myClassId) : 'X'
                        } else if (isMine) {
                          cellClass += 'bg-amber-100 border-2 border-amber-400 text-amber-800 cursor-pointer hover:bg-amber-200'
                          cellContent = slot.myClassId ? courseLabel(slot.myClassId) : '✓'
                        } else if (isSelected) {
                          cellClass += 'bg-brand-600 text-white cursor-pointer shadow-sm hover:bg-brand-700'
                          cellContent = owningClass === '__instructor__' ? '✓' : courseLabel(owningClass)
                        } else if (slot.isFull) {
                          cellClass += 'bg-red-50 text-red-400 cursor-default'
                          cellContent = 'FULL'
                        } else if (isLunch) {
                          // Available lunch slot — distinct styling, still clickable
                          cellClass += 'bg-orange-50 border border-orange-200 text-orange-600 cursor-pointer hover:bg-orange-100'
                          cellContent = slot.availableSpots > 0 ? (
                            <><span>{slot.availableSpots}/{slot.maxStudents}</span><span className="font-normal text-[7px] opacity-70">LUNCH</span></>
                          ) : 'LUNCH'
                        } else if (slot.deadlinePassed && !isInstructor) {
                          cellClass += 'bg-amber-50 border border-dashed border-amber-300 text-amber-600 cursor-pointer hover:bg-amber-100'
                          cellContent = slot.availableSpots > 0 ? `${slot.availableSpots}/${slot.maxStudents}` : ''
                        } else {
                          cellClass += 'bg-emerald-50 border border-emerald-200 text-emerald-700 cursor-pointer hover:bg-emerald-100'
                          cellContent = slot.availableSpots > 0 ? `${slot.availableSpots}/${slot.maxStudents}` : ''
                        }

                        const handleClick = () => {
                          if (!slot.isOpen) return
                          // Instructor: open detail popup showing who's signed up
                          if (isInstructor) {
                            openSlotDetail(day.date, hour, slot)
                            return
                          }
                          if (isMine) {
                            if (canToggleCancel) toggleCancel(slot.mySignupId)
                            return
                          }
                          if (isSelected) {
                            toggleSlot(key)
                            return
                          }
                          if (slot.isFull) return
                          if (canSelect || canSelectPostDeadline) {
                            toggleSlot(key)
                          }
                        }

                        // Build accessible label that surfaces closure reason for screen readers
                        const titleText =
                          !slot.isOpen
                            ? (slot.isHourClosed
                                ? `Closed: ${slot.closureReason}`
                                : 'Lab closed')
                          : isInstructor ? `${slot.currentSignups}/${slot.maxStudents} signed up — click for details`
                          : isMarkedCancel ? 'Click to undo cancel'
                          : isMine && isLunch ? 'Lunch hour — click to cancel'
                          : isMine ? 'Click to cancel this signup'
                          : isSelected ? `${owningClass} — click to deselect`
                          : slot.isFull ? 'No spots available'
                          : isLunch ? `Lunch hour — ${slot.availableSpots} spot${slot.availableSpots !== 1 ? 's' : ''} (instructor on break)`
                          : `${slot.availableSpots} spot${slot.availableSpots !== 1 ? 's' : ''} open${slot.deadlinePassed && !isInstructor ? ' (requires approval)' : ''}`

                        return (
                          <td key={key} className="px-1 py-1">
                            <button
                              className={cellClass}
                              onClick={handleClick}
                              title={titleText}
                              aria-label={`${day.dayName} ${formatHour(hour)} — ${titleText}`}
                              disabled={!slot.isOpen}
                            >
                              {lunchBadge}
                              {cellContent}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Action Bar — shows when there are pending changes */}
            {changeCount > 0 && (
              <div className="px-4 py-3 border-t border-surface-200 bg-brand-50">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  {/* Summary of changes */}
                  <div className="flex flex-wrap gap-2 text-xs">
                    {/* New selections by class */}
                    {Object.entries(getWeekAllNewSelections(wIdx)).map(([cid, arr]) => (
                      <span key={cid} className="inline-flex items-center gap-1 px-2 py-1 bg-brand-100 text-brand-700 rounded-md">
                        <Plus size={10} /> {arr.length} new for <strong>{cid === '__instructor__' ? 'Override' : cid}</strong>
                      </span>
                    ))}
                    {/* Cancellations */}
                    {getWeekCancellations(wIdx).length > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 rounded-md">
                        <Trash2 size={10} /> {getWeekCancellations(wIdx).length} to cancel
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        // Clear only this week's changes
                        const week2 = weeks[wIdx]
                        setSelections(prev => {
                          const next = { ...prev }
                          for (const [cid, arr] of Object.entries(next)) {
                            next[cid] = arr.filter(sel => {
                              const selDate = sel.split('_')[0]
                              return !week2.days.some(d => d.date === selDate)
                            })
                            if (next[cid].length === 0) delete next[cid]
                          }
                          return next
                        })
                        setCancellations(prev => {
                          const weekCancelIds = getWeekCancellations(wIdx)
                          return prev.filter(id => !weekCancelIds.includes(id))
                        })
                      }}
                      className="px-3 py-2 text-xs font-medium text-surface-600 bg-white border border-surface-200 rounded-lg hover:bg-surface-50"
                    >
                      Clear Changes
                    </button>
                    <button
                      onClick={() => handleSubmit(wIdx)}
                      disabled={saving}
                      className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {saving ? <Loader2 size={14} className="animate-spin" /> : (
                        <>
                          {week.deadlinePassed && !isInstructor ? 'Submit for Approval' : 'Submit'}
                          <span className="bg-white/20 px-1.5 py-0.5 rounded text-[10px]">{changeCount}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Legend */}
      <div className="flex flex-wrap gap-4 justify-center text-xs text-surface-500 bg-white rounded-xl border border-surface-200 p-3">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-sm bg-emerald-50 border border-emerald-200 flex items-center justify-center text-[8px] text-emerald-700 font-bold">20</span>
          Available (spots open)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-sm bg-brand-600 flex items-center justify-center text-[7px] text-white font-bold">ID</span>
          Selected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-sm bg-amber-100 border-2 border-amber-400 flex items-center justify-center text-[7px] text-amber-800 font-bold">ID</span>
          Your Signup
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-sm bg-red-100 border-2 border-red-400" />
          Marked to Cancel
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-sm bg-red-50 border border-red-200" />
          Full / Closed
        </span>
        {!isInstructor && (
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-4 rounded-sm bg-amber-50 border border-dashed border-amber-300" />
            Past Deadline (needs approval)
          </span>
        )}
      </div>

      {/* Post-Deadline Reason Modal */}
      {reasonModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => { setReasonModal(null); setReason('') }}>
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-surface-200">
              <h3 className="text-base font-semibold text-surface-900">Change Request</h3>
              <p className="text-xs text-surface-500 mt-1">
                The Sunday midnight deadline has passed. Your changes will be sent to your instructor for approval.
              </p>
            </div>

            <div className="p-5">
              {/* Show summary of changes */}
              <div className="mb-4 space-y-1.5">
                {Object.entries(getWeekAllNewSelections(reasonModal.weekIdx)).map(([cid, arr]) => (
                  <div key={cid} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 bg-brand-500 rounded-full" />
                    <span className="text-surface-600">Adding <strong>{arr.length}</strong> slot{arr.length > 1 ? 's' : ''} for <strong>{cid}</strong></span>
                  </div>
                ))}
                {getWeekCancellations(reasonModal.weekIdx).length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 bg-red-500 rounded-full" />
                    <span className="text-surface-600">Cancelling <strong>{getWeekCancellations(reasonModal.weekIdx).length}</strong> existing slot{getWeekCancellations(reasonModal.weekIdx).length > 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>

              <label className="block text-sm font-medium text-surface-700 mb-1.5">
                Reason for change <span className="text-red-500">*</span>
              </label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                placeholder="e.g., Missed the deadline, had a scheduling conflict..."
                className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 resize-none"
                autoFocus
              />
            </div>

            <div className="px-5 py-3 border-t border-surface-200 flex justify-end gap-2">
              <button
                onClick={() => { setReasonModal(null); setReason('') }}
                className="px-4 py-2.5 text-sm font-medium text-surface-600 bg-surface-100 rounded-lg hover:bg-surface-200"
              >
                Cancel
              </button>
              <button
                onClick={handlePostDeadlineSubmit}
                disabled={saving || !reason.trim()}
                className="px-4 py-2.5 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Instructor Slot Detail Modal */}
      {slotDetail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={e => e.target === e.currentTarget && setSlotDetail(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-surface-200 flex items-center justify-between bg-brand-50">
              <div>
                <h3 className="text-sm font-bold text-surface-900">{slotDetail.label}</h3>
                <p className="text-xs text-surface-500 mt-0.5">
                  {slotDetail.currentSignups}/{slotDetail.maxStudents} signed up
                </p>
              </div>
              <button onClick={() => setSlotDetail(null)} className="p-1 hover:bg-surface-200 rounded-lg">
                <X size={18} className="text-surface-400" />
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {slotDetail.loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 size={20} className="animate-spin text-brand-600" />
                </div>
              ) : slotDetail.students.length === 0 ? (
                <div className="p-6 text-center text-surface-400 text-sm">No signups for this slot</div>
              ) : (
                <div className="divide-y divide-surface-100">
                  {slotDetail.students.map((s, i) => (
                    <div key={i} className="px-5 py-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-surface-900">{s.name}</div>
                        <div className="text-xs text-surface-400">{s.email}</div>
                      </div>
                      {s.classId && (
                        <div className="text-right">
                          <div className="text-xs font-bold text-brand-600">{s.classId}</div>
                          {s.className && <div className="text-[10px] text-surface-400">{s.className}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-surface-100 bg-surface-50 text-right">
              <button
                onClick={() => setSlotDetail(null)}
                className="px-4 py-2 text-sm font-medium text-surface-600 bg-white border border-surface-200 rounded-lg hover:bg-surface-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// TAB 2: MY SIGNUPS
// ═══════════════════════════════════════════════════════════════════════════

function MySignupsTab() {
  const { signups, loading, refresh } = useMySignups()
  const { cancelSignup, saving } = useLabSignupActions()
  const [classMap, setClassMap] = useState({})

  // Load class name map
  useEffect(() => {
    async function loadClasses() {
      const { data } = await supabase
        .from('classes')
        .select('course_id, course_name')
        .eq('status', 'Active')
      const map = {}
      ;(data || []).forEach(c => { map[c.course_id] = c.course_name || '' })
      setClassMap(map)
    }
    loadClasses()
  }, [])

  const handleCancel = async (signupId) => {
    if (!confirm('Cancel this signup?')) return
    const result = await cancelSignup(signupId)
    if (result.success) refresh()
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-600" /></div>
  }

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-200 bg-surface-50">
        <h3 className="text-sm font-semibold text-surface-900">My Upcoming Signups</h3>
      </div>
      {signups.length === 0 ? (
        <div className="p-8 text-center text-surface-400 text-sm">No upcoming signups</div>
      ) : (
        <div className="divide-y divide-surface-100">
          {signups.map(s => (
            <div key={s.signupId} className="px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-surface-900">{s.dateDisplay}</div>
                <div className="text-xs text-surface-500">
                  {s.startTime} — {s.endTime}
                  {s.classId && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-100 text-surface-600 font-medium">
                      {s.classId}
                      {classMap[s.classId] && <span className="text-surface-400 font-normal"> — {classMap[s.classId]}</span>}
                    </span>
                  )}
                </div>
              </div>
              {s.canCancel && (
                <button
                  onClick={() => handleCancel(s.signupId)}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 3: LAB CALENDAR (Instructor)
// ═══════════════════════════════════════════════════════════════════════════

function LabCalendarTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [editingDay, setEditingDay] = useState(null)
  const [conflictModal, setConflictModal] = useState(null)

  const { entries, loading, refresh } = useLabCalendar(year, month)
  const { saveDay, deleteDay, findConflictingSignups, cancelSignupsForClosure, saving } = useLabCalendarActions()

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const prevMonth = () => { if (month === 0) { setMonth(11); setYear(y => y - 1) } else setMonth(m => m - 1) }
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear(y => y + 1) } else setMonth(m => m + 1) }

  // Build calendar grid
  const calDays = useMemo(() => {
    const first = new Date(year, month, 1)
    const last = new Date(year, month + 1, 0)
    const startDay = first.getDay()
    const totalDays = last.getDate()
    const prevLast = new Date(year, month, 0).getDate()
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const cells = []
    for (let i = startDay - 1; i >= 0; i--) {
      const d = prevLast - i
      const dt = new Date(year, month - 1, d)
      cells.push({ day: d, date: formatDateKey(dt), isOther: true, isToday: false })
    }
    for (let d = 1; d <= totalDays; d++) {
      const dt = new Date(year, month, d)
      cells.push({ day: d, date: formatDateKey(dt), isOther: false, isToday: dt.getTime() === today.getTime() })
    }
    const rem = (cells.length % 7) ? 7 - (cells.length % 7) : 0
    for (let d = 1; d <= rem; d++) {
      const dt = new Date(year, month + 1, d)
      cells.push({ day: d, date: formatDateKey(dt), isOther: true, isToday: false })
    }
    return cells
  }, [year, month])

  const handleEditDay = (dateStr) => {
    const entry = entries[dateStr]
    setEditingDay({
      date: dateStr,
      status: entry?.status || 'Open',
      startTime: entry ? `${String(entry.startHour).padStart(2, '0')}:00` : '08:00',
      endTime: entry ? `${String(entry.endHour).padStart(2, '0')}:00` : '16:00',
      maxStudents: entry?.maxStudents || 24,
      lunchHour: entry?.lunchHour ?? 12,
      notes: entry?.notes || '',
      // Hour-level closures within an Open day (e.g. 2-3pm faculty meeting)
      closedBlocks: Array.isArray(entry?.closedBlocks)
        ? entry.closedBlocks.map(b => ({ ...b }))
        : [],
    })
  }

  // Validate closed_blocks before save: must have start < end, both within
  // day hours (when status === 'Open'), and no zero-length ranges. Returns
  // { ok: true, blocks } on success, { ok: false, message } on failure.
  const validateClosedBlocks = (day) => {
    const blocks = Array.isArray(day.closedBlocks) ? day.closedBlocks : []
    if (day.status !== 'Open' || blocks.length === 0) {
      return { ok: true, blocks: [] }
    }
    const dayStartMin = timeToMinutes(day.startTime)
    const dayEndMin   = timeToMinutes(day.endTime)
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const bs = timeToMinutes(b.start)
      const be = timeToMinutes(b.end)
      if (bs == null || be == null) {
        return { ok: false, message: `Closed period #${i + 1} is missing a start or end time.` }
      }
      if (be <= bs) {
        return { ok: false, message: `Closed period #${i + 1} ends before it starts.` }
      }
      if (dayStartMin != null && bs < dayStartMin) {
        return { ok: false, message: `Closed period #${i + 1} starts before the lab opens.` }
      }
      if (dayEndMin != null && be > dayEndMin) {
        return { ok: false, message: `Closed period #${i + 1} ends after the lab closes.` }
      }
    }
    return { ok: true, blocks }
  }

  const handleSave = async () => {
    if (!editingDay) return

    // Validate before any DB work
    const v = validateClosedBlocks(editingDay)
    if (!v.ok) {
      toast.error(v.message)
      return
    }

    // If the day is fully closed OR there are no closure blocks, no conflict
    // check needed — save directly.
    const blocks = v.blocks
    if (editingDay.status !== 'Open' || blocks.length === 0) {
      await saveDay({ ...editingDay, closedBlocks: [] })
      setEditingDay(null)
      refresh()
      return
    }

    // Check for existing student signups that overlap any new closure block.
    // Only the *new* (or expanded) closures need a warning — but for simplicity
    // and predictability we re-check all current blocks on save, and only show
    // signups still active. This way the modal correctly reflects what will
    // actually be cancelled when Save is pressed.
    const conflicts = await findConflictingSignups(editingDay.date, blocks)
    if (conflicts.length === 0) {
      await saveDay({ ...editingDay, closedBlocks: blocks })
      setEditingDay(null)
      refresh()
      return
    }

    // Open conflict modal to confirm + offer to email
    setConflictModal({
      day: { ...editingDay, closedBlocks: blocks },
      conflicts,
      sendEmail: true,
    })
  }

  // Called from the conflict modal's Confirm button
  const handleConfirmConflict = async () => {
    if (!conflictModal) return
    const { day, conflicts, sendEmail } = conflictModal

    // Cancel signups (and optionally email) BEFORE persisting the closure so
    // that, even if persistence fails, students don't see a stale signup that
    // was supposedly cancelled.
    const blockReason = (day.closedBlocks.find(b => (b.reason || '').trim())?.reason || 'Lab closed')
    const result = await cancelSignupsForClosure({
      dateStr:         day.date,
      blockReason:     blockReason,
      affectedSignups: conflicts,
      sendEmail,
    })

    // Persist the calendar day with closures
    await saveDay(day)

    if (sendEmail) {
      if (result.emailFailed > 0) {
        toast.error(`Cancelled ${result.cancelled}, but ${result.emailFailed} email${result.emailFailed === 1 ? '' : 's'} failed to send`)
      } else {
        toast.success(`Cancelled ${result.cancelled} signup${result.cancelled === 1 ? '' : 's'} and sent ${result.emailed} notification${result.emailed === 1 ? '' : 's'}`)
      }
    } else {
      toast.success(`Cancelled ${result.cancelled} signup${result.cancelled === 1 ? '' : 's'}`)
    }

    setConflictModal(null)
    setEditingDay(null)
    refresh()
  }

  const handleDelete = async () => {
    if (!editingDay) return
    await deleteDay(editingDay.date)
    setEditingDay(null)
    refresh()
  }

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
      {/* Month Nav */}
      <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-900">Lab Calendar</h3>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-1.5 rounded hover:bg-surface-100"><ChevronLeft size={16} /></button>
          <span className="text-sm font-medium min-w-[140px] text-center">{monthNames[month]} {year}</span>
          <button onClick={nextMonth} className="p-1.5 rounded hover:bg-surface-100"><ChevronRight size={16} /></button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 justify-center text-xs text-surface-500 py-2 border-b border-surface-100 flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300" /> Open</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-50 border border-red-200" /> Closed</span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300 relative">
            <Ban size={8} className="absolute -top-1 -right-1 text-red-500 bg-white rounded-full" aria-hidden="true" />
          </span>
          Open with closure(s)
        </span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-surface-50 border border-surface-200" /> Not Set</span>
      </div>

      {/* Calendar Grid */}
      <div className="p-3">
        <div className="grid grid-cols-7 gap-1">
          {dayHeaders.map(d => (
            <div key={d} className="p-1.5 text-center text-xs font-semibold text-surface-500 bg-surface-50 rounded">
              {d}
            </div>
          ))}
          {calDays.map((cell, i) => {
            const entry = entries[cell.date]
            const closureCount = (entry?.closedBlocks || []).length
            let bgClass = 'bg-white border-surface-200'
            if (cell.isOther) bgClass = 'bg-surface-50/50 border-surface-100 opacity-40'
            else if (cell.isToday) bgClass = 'bg-blue-50 border-blue-300'
            if (entry?.status === 'Open') bgClass = 'bg-emerald-50 border-emerald-300'
            if (entry?.status === 'Closed') bgClass = 'bg-red-50 border-red-200'

            return (
              <button
                key={i}
                type="button"
                onClick={() => handleEditDay(cell.date)}
                className={`text-left min-h-[70px] border-2 rounded-lg p-1.5 cursor-pointer hover:border-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors ${bgClass}`}
                aria-label={
                  `${cell.date}` +
                  (entry ? ` — ${entry.status}` : ' — Not set') +
                  (closureCount > 0 ? `, ${closureCount} closed period${closureCount === 1 ? '' : 's'}` : '') +
                  '. Click to edit.'
                }
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="text-sm font-bold text-surface-900">{cell.day}</div>
                  {closureCount > 0 && entry?.status === 'Open' && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[8px] font-bold bg-red-100 text-red-700 px-1 py-0.5 rounded leading-none"
                      title={`${closureCount} closed period${closureCount === 1 ? '' : 's'}`}
                    >
                      <Ban size={8} aria-hidden="true" /> {closureCount}
                    </span>
                  )}
                </div>
                {entry && (
                  <>
                    <div className={`text-[8px] font-bold mt-0.5 px-1 py-0.5 rounded inline-block ${
                      entry.status === 'Open' ? 'bg-emerald-400 text-white' : 'bg-red-400 text-white'
                    }`}>
                      {entry.status.toUpperCase()}
                    </div>
                    {entry.status === 'Open' && (
                      <div className="text-[9px] text-surface-500 mt-0.5">
                        {entry.startHour}-{entry.endHour}h · {entry.maxStudents}/hr
                      </div>
                    )}
                    {entry.notes && (
                      <div className="text-[9px] text-surface-400 truncate">{entry.notes}</div>
                    )}
                  </>
                )}
              </button>
            )
          })}
        </div>
        <p className="text-center text-xs text-surface-400 mt-3">Click any day to set hours</p>
      </div>

      {/* Edit Day Modal */}
      {editingDay && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setEditingDay(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Edit lab calendar for ${editingDay.date}`}
        >
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between flex-shrink-0">
              <span className="font-semibold text-sm">{editingDay.date}</span>
              <button onClick={() => setEditingDay(null)} aria-label="Close" className="text-surface-400 hover:text-surface-600"><X size={18} /></button>
            </div>
            <div className="p-4 space-y-4 overflow-y-auto">
              {/* Status Toggle */}
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingDay(d => ({ ...d, status: 'Open' }))}
                  className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${
                    editingDay.status === 'Open' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-surface-200 text-surface-500'
                  }`}
                  aria-pressed={editingDay.status === 'Open'}
                >Lab Open</button>
                <button
                  onClick={() => setEditingDay(d => ({ ...d, status: 'Closed' }))}
                  className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${
                    editingDay.status === 'Closed' ? 'border-red-500 bg-red-50 text-red-700' : 'border-surface-200 text-surface-500'
                  }`}
                  aria-pressed={editingDay.status === 'Closed'}
                >Lab Closed</button>
              </div>

              {editingDay.status === 'Open' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs font-medium text-surface-600">
                      Start
                      <input type="time" value={editingDay.startTime} onChange={e => setEditingDay(d => ({ ...d, startTime: e.target.value }))}
                        className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm" />
                    </label>
                    <label className="text-xs font-medium text-surface-600">
                      End
                      <input type="time" value={editingDay.endTime} onChange={e => setEditingDay(d => ({ ...d, endTime: e.target.value }))}
                        className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm" />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs font-medium text-surface-600">
                      Lunch Break
                      <select value={editingDay.lunchHour ?? ''} onChange={e => setEditingDay(d => ({ ...d, lunchHour: e.target.value ? parseInt(e.target.value) : null }))}
                        className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm">
                        <option value="">No Lunch</option>
                        <option value="11">11:00 AM</option>
                        <option value="12">12:00 PM</option>
                        <option value="13">1:00 PM</option>
                      </select>
                    </label>
                    <label className="text-xs font-medium text-surface-600">
                      Max/Hour
                      <input type="number" min="1" value={editingDay.maxStudents} onChange={e => setEditingDay(d => ({ ...d, maxStudents: parseInt(e.target.value) || 24 }))}
                        className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm" />
                    </label>
                  </div>

                  {/* ─── Closed Periods (hour-level closures) ─────────────── */}
                  <ClosedPeriodsEditor
                    blocks={editingDay.closedBlocks || []}
                    dayStartTime={editingDay.startTime}
                    dayEndTime={editingDay.endTime}
                    onChange={(blocks) => setEditingDay(d => ({ ...d, closedBlocks: blocks }))}
                  />
                </>
              )}

              <label className="text-xs font-medium text-surface-600">
                Notes
                <input type="text" value={editingDay.notes} onChange={e => setEditingDay(d => ({ ...d, notes: e.target.value }))}
                  placeholder="e.g. Holiday" className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm" />
              </label>
            </div>
            <div className="px-4 py-3 border-t border-surface-200 flex justify-between flex-shrink-0">
              <button onClick={handleDelete} disabled={saving}
                className="px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50">
                Remove
              </button>
              <div className="flex gap-2">
                <button onClick={() => setEditingDay(null)} className="px-3 py-2 text-xs font-medium bg-surface-100 rounded-lg hover:bg-surface-200">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="px-4 py-2 text-xs font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50">
                  {saving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Conflict Warning Sub-Modal */}
      {conflictModal && (
        <ClosureConflictModal
          modal={conflictModal}
          saving={saving}
          onCancel={() => setConflictModal(null)}
          onToggleEmail={(checked) => setConflictModal(m => ({ ...m, sendEmail: checked }))}
          onConfirm={handleConfirmConflict}
        />
      )}
    </div>
  )
}

// ─── Closed Periods Editor (sub-form of LabCalendarTab edit modal) ──────────
//
// Edits an array of { start, end, reason } closure blocks. Used inside the
// LabCalendarTab edit modal to mark hour ranges as closed within an Open day
// (e.g. "2-3pm offsite meeting"). Quick presets cover the common cases.

function ClosedPeriodsEditor({ blocks, dayStartTime, dayEndTime, onChange }) {
  const addBlock = (preset = null) => {
    const next = [...(blocks || [])]
    if (preset) {
      next.push(preset)
    } else {
      // Default new block: one hour starting at the day's start time
      const startMin = timeToMinutes(dayStartTime) ?? 8 * 60
      next.push({
        start:  minutesToTimeStr(startMin),
        end:    minutesToTimeStr(startMin + 60),
        reason: '',
      })
    }
    onChange(next)
  }

  const updateBlock = (idx, patch) => {
    const next = blocks.map((b, i) => i === idx ? { ...b, ...patch } : b)
    onChange(next)
  }

  const removeBlock = (idx) => {
    onChange(blocks.filter((_, i) => i !== idx))
  }

  return (
    <fieldset className="border border-surface-200 rounded-lg p-3 space-y-2">
      <legend className="text-xs font-semibold text-surface-700 px-1 inline-flex items-center gap-1">
        <Ban size={12} aria-hidden="true" /> Closed Periods
      </legend>
      <p className="text-[11px] text-surface-500 -mt-1">
        Mark specific hour ranges as closed (e.g. faculty meeting 2-3pm). Students will see these as closed in the signup grid.
      </p>

      {(blocks || []).length === 0 && (
        <p className="text-[11px] text-surface-400 italic py-1">No closed periods. Lab is open the entire scheduled time.</p>
      )}

      {(blocks || []).map((b, idx) => (
        <div key={idx} className="grid grid-cols-[1fr_1fr_1.2fr_auto] gap-2 items-end bg-surface-50 rounded-md p-2">
          <label className="text-[10px] font-medium text-surface-600">
            <span className="block mb-0.5">Start</span>
            <input
              type="time"
              value={b.start || ''}
              onChange={e => updateBlock(idx, { start: e.target.value })}
              className="w-full px-2 py-1.5 border border-surface-200 rounded text-xs"
              aria-label={`Closed period ${idx + 1} start time`}
            />
          </label>
          <label className="text-[10px] font-medium text-surface-600">
            <span className="block mb-0.5">End</span>
            <input
              type="time"
              value={b.end || ''}
              onChange={e => updateBlock(idx, { end: e.target.value })}
              className="w-full px-2 py-1.5 border border-surface-200 rounded text-xs"
              aria-label={`Closed period ${idx + 1} end time`}
            />
          </label>
          <label className="text-[10px] font-medium text-surface-600">
            <span className="block mb-0.5">Reason</span>
            <input
              type="text"
              value={b.reason || ''}
              onChange={e => updateBlock(idx, { reason: e.target.value })}
              placeholder="e.g. Faculty meeting"
              className="w-full px-2 py-1.5 border border-surface-200 rounded text-xs"
              aria-label={`Closed period ${idx + 1} reason`}
              maxLength={80}
            />
          </label>
          <button
            type="button"
            onClick={() => removeBlock(idx)}
            className="p-1.5 text-red-500 hover:bg-red-50 rounded border border-transparent hover:border-red-200 self-end"
            aria-label={`Remove closed period ${idx + 1}`}
            title="Remove this closed period"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => addBlock()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded hover:bg-brand-100"
        >
          <Plus size={12} aria-hidden="true" /> Add closed period
        </button>

        {/* Quick presets */}
        <button
          type="button"
          onClick={() => addBlock({ start: '14:00', end: '15:00', reason: '' })}
          className="px-2.5 py-1.5 text-[11px] font-medium text-surface-700 bg-surface-100 border border-surface-200 rounded hover:bg-surface-200"
          title="Add a 2:00–3:00 PM block"
        >
          + 2-3 PM
        </button>
        <button
          type="button"
          onClick={() => addBlock({ start: '09:00', end: '10:00', reason: '' })}
          className="px-2.5 py-1.5 text-[11px] font-medium text-surface-700 bg-surface-100 border border-surface-200 rounded hover:bg-surface-200"
          title="Add a 9:00–10:00 AM block"
        >
          + 9-10 AM
        </button>
        <button
          type="button"
          onClick={() => {
            const startMin = timeToMinutes(dayStartTime) ?? 8 * 60
            const endMin   = timeToMinutes(dayEndTime)   ?? 16 * 60
            const noonMin  = 12 * 60
            const closeStart = noonMin <= startMin ? startMin : noonMin
            if (closeStart >= endMin) return
            addBlock({ start: minutesToTimeStr(closeStart), end: minutesToTimeStr(endMin), reason: '' })
          }}
          className="px-2.5 py-1.5 text-[11px] font-medium text-surface-700 bg-surface-100 border border-surface-200 rounded hover:bg-surface-200"
          title="Closed afternoon (noon to end of day)"
        >
          + Afternoon
        </button>
      </div>
    </fieldset>
  )
}

// ─── Closure Conflict Warning Modal ────────────────────────────────────────
//
// Shown when an instructor tries to save closure(s) that overlap existing
// (non-cancelled) student signups. Lists every affected student and offers
// to email them when their signup is cancelled.

function ClosureConflictModal({ modal, saving, onCancel, onConfirm, onToggleEmail }) {
  const dialogRef = useDialogA11y(true, onCancel)
  const { conflicts, sendEmail, day } = modal

  // Group conflicts by hour for display
  const grouped = useMemo(() => {
    const map = new Map()
    for (const c of conflicts) {
      const key = `${c.startTime}-${c.endTime}`
      if (!map.has(key)) map.set(key, { startMin: c.startMin, items: [] })
      map.get(key).items.push(c)
    }
    return [...map.entries()]
      .sort((a, b) => a[1].startMin - b[1].startMin)
      .map(([key, v]) => ({ timeKey: key, ...v }))
  }, [conflicts])

  const fmt = (timeStr) => {
    const m = timeToMinutes(timeStr)
    if (m == null) return timeStr
    const h = Math.floor(m / 60)
    const mm = m % 60
    const ampm = h >= 12 ? 'PM' : 'AM'
    const dispH = h % 12 || 12
    return mm === 0 ? `${dispH}:00 ${ampm}` : `${dispH}:${String(mm).padStart(2, '0')} ${ampm}`
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="closure-conflict-title"
        aria-describedby="closure-conflict-desc"
        className="bg-white rounded-xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between flex-shrink-0 bg-amber-50">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-600" aria-hidden="true" />
            <span id="closure-conflict-title" className="font-semibold text-sm text-amber-900">
              Existing signups will be cancelled
            </span>
          </div>
          <button onClick={onCancel} aria-label="Cancel" className="text-surface-500 hover:text-surface-700">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <p id="closure-conflict-desc" className="text-xs text-surface-600 leading-relaxed">
            <strong>{conflicts.length}</strong> student signup{conflicts.length === 1 ? '' : 's'} on{' '}
            <strong>{day.date}</strong> overlap{conflicts.length === 1 ? 's' : ''} the closure period
            {(day.closedBlocks || []).length === 1 ? '' : 's'} you've added. Saving will cancel
            {conflicts.length === 1 ? ' this signup' : ' these signups'} so {conflicts.length === 1 ? 'the student' : 'students'} can pick a different time.
          </p>

          <div className="border border-surface-200 rounded-lg divide-y divide-surface-100 max-h-[40vh] overflow-y-auto">
            {grouped.map(group => (
              <div key={group.timeKey} className="bg-white">
                <div className="px-3 py-1.5 bg-red-50 text-red-700 text-[11px] font-bold uppercase tracking-wide">
                  {fmt(group.items[0].startTime)} – {fmt(group.items[0].endTime)}
                  <span className="ml-2 text-red-500 font-normal normal-case">
                    {group.items.length} signup{group.items.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="divide-y divide-surface-50">
                  {group.items.map(c => (
                    <li key={c.signupId} className="px-3 py-1.5 text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-surface-900 truncate">{c.userName || c.userEmail}</div>
                        <div className="text-surface-500 text-[10px] truncate">
                          {c.userEmail}{c.classId ? ` · ${c.classId}` : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <label className="flex items-start gap-2 p-2.5 bg-surface-50 border border-surface-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={!!sendEmail}
              onChange={e => onToggleEmail(e.target.checked)}
              className="mt-0.5"
              aria-describedby="closure-email-help"
            />
            <span className="flex-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-surface-800">
                <Mail size={12} aria-hidden="true" /> Email each student about the cancellation
              </span>
              <span id="closure-email-help" className="text-[10px] text-surface-500 block mt-0.5">
                Sends an automated note explaining their signup was cancelled and asking them to pick another time.
              </span>
            </span>
          </label>
        </div>

        <div className="px-4 py-3 border-t border-surface-200 flex justify-end gap-2 flex-shrink-0">
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-2 text-xs font-medium bg-surface-100 rounded-lg hover:bg-surface-200 disabled:opacity-50"
          >
            Back to edit
          </button>
          <button
            onClick={onConfirm}
            disabled={saving}
            className="px-4 py-2 text-xs font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
            {saving ? 'Working…' : `Cancel ${conflicts.length} signup${conflicts.length === 1 ? '' : 's'} & save closure`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 4: DAILY ROSTER (Instructor)
// ═══════════════════════════════════════════════════════════════════════════

function DailyRosterTab() {
  const [dateStr, setDateStr] = useState(formatDateKey(new Date()))
  const { signups, loading } = useDailyRoster(dateStr)
  const [classMap, setClassMap] = useState({})

  // Load class name map
  useEffect(() => {
    async function loadClasses() {
      const { data } = await supabase
        .from('classes')
        .select('course_id, course_name')
        .eq('status', 'Active')
      const map = {}
      ;(data || []).forEach(c => { map[c.course_id] = c.course_name || '' })
      setClassMap(map)
    }
    loadClasses()
  }, [])

  // Group by hour
  const grouped = useMemo(() => {
    const map = {}
    signups.forEach(s => {
      const hour = getHourFromTime(s.start_time) ?? 0
      if (!map[hour]) map[hour] = []
      map[hour].push(s)
    })
    return Object.entries(map).sort(([a], [b]) => parseInt(a) - parseInt(b))
  }, [signups])

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-900">Daily Roster</h3>
        <div className="flex items-center gap-2">
          <input type="date" value={dateStr} onChange={e => setDateStr(e.target.value)}
            className="px-3 py-1.5 border border-surface-200 rounded-lg text-sm" />
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-lg hover:bg-emerald-600">
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-600" /></div>
      ) : grouped.length === 0 ? (
        <div className="p-8 text-center text-surface-400 text-sm">No signups for this date</div>
      ) : (
        <div className="p-4 space-y-3">
          {grouped.map(([hour, students]) => (
            <div key={hour} className="border border-surface-200 rounded-lg overflow-hidden">
              <div className="bg-brand-600 text-white px-4 py-2.5 font-semibold text-sm">
                {formatHour(parseInt(hour))}
                <span className="ml-2 opacity-70 text-xs">({students.length} student{students.length > 1 ? 's' : ''})</span>
              </div>
              <div className="divide-y divide-surface-100">
                {students.map(s => (
                  <div key={s.signup_id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <span className="font-medium text-surface-900">{s.user_name}</span>
                    {s.class_id && (
                      <span className="text-xs text-surface-500">
                        <span className="font-medium text-surface-700">{s.class_id}</span>
                        {classMap[s.class_id] && (
                          <span className="text-surface-400 ml-1">— {classMap[s.class_id]}</span>
                        )}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 5: ADMIN SIGNUP (Instructor Override)
// ═══════════════════════════════════════════════════════════════════════════

function AdminSignupTab() {
  const { students, loading: studentsLoading } = useStudentsList()
  const { signUpStudent, saving } = useInstructorSignup()

  const [selectedStudent, setSelectedStudent] = useState(null)
  const [selectedClass, setSelectedClass] = useState('')
  const [dateStr, setDateStr] = useState(formatDateKey(new Date()))
  const [slots, setSlots] = useState([])
  const [selectedSlot, setSelectedSlot] = useState('')
  const [loadingSlots, setLoadingSlots] = useState(false)

  // Get student's classes when selected
  const studentClasses = useMemo(() => {
    if (!selectedStudent) return []
    return (selectedStudent.classes || '').split(',').map(c => c.trim()).filter(Boolean)
  }, [selectedStudent])

  // Load available slots when date changes
  useEffect(() => {
    if (!dateStr) return
    async function load() {
      setLoadingSlots(true)
      const targetDate = new Date(dateStr + 'T12:00:00')
      const dateKey = formatDateKey(targetDate)

      // Get calendar config
      const { data: calData } = await supabase
        .from('lab_calendar')
        .select('*')
        .eq('date', targetDate.toISOString())
        .maybeSingle()

      if (!calData || calData.status !== 'Open') {
        setSlots([])
        setLoadingSlots(false)
        return
      }

      const startH = getHourFromTime(calData.start_time) ?? 8
      const endH = getHourFromTime(calData.end_time) ?? 16
      const lunchH = calData.lunch_hour != null ? parseInt(calData.lunch_hour) : null
      const maxStudents = calData.max_students || 24

      // Get existing signup counts
      const { data: signupData } = await supabase
        .from('lab_signup')
        .select('start_time')
        .eq('date', targetDate.toISOString())
        .neq('status', 'Cancelled')

      const counts = {}
      ;(signupData || []).forEach(s => {
        const hr = getHourFromTime(s.start_time)
        if (hr !== null) counts[hr] = (counts[hr] || 0) + 1
      })

      const available = []
      for (let h = startH; h < endH; h++) {
        if (lunchH !== null && h === lunchH) continue
        const count = counts[h] || 0
        if (count < maxStudents) {
          available.push({ hour: h, display: formatHour(h), available: maxStudents - count, maxStudents })
        }
      }
      setSlots(available)
      setLoadingSlots(false)
    }
    load()
  }, [dateStr])

  const handleSignup = async () => {
    if (!selectedStudent || !selectedSlot || !dateStr) return
    const result = await signUpStudent(selectedStudent, dateStr, selectedSlot, selectedClass)
    if (result.success) {
      setSelectedSlot('')
      // Refresh slots
      setDateStr('')
      setTimeout(() => setDateStr(dateStr), 100)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-surface-900">Sign Up Student</h3>
      </div>

      <div className="p-4 space-y-4">
        {/* Warning */}
        <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <span>This bypasses the Sunday midnight deadline. Use when a student needs to sign up after the deadline has passed.</span>
        </div>

        {/* Student */}
        <label className="block text-xs font-medium text-surface-600">
          Student
          <select
            value={selectedStudent?.userId || ''}
            onChange={e => {
              const s = students.find(st => st.userId === e.target.value)
              setSelectedStudent(s || null)
              setSelectedClass('')
            }}
            className="mt-1 w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm"
          >
            <option value="">— Select Student —</option>
            {students.map(s => (
              <option key={s.userId} value={s.userId}>{s.displayName}</option>
            ))}
          </select>
        </label>

        {/* Class */}
        <label className="block text-xs font-medium text-surface-600">
          Class
          <select
            value={selectedClass}
            onChange={e => setSelectedClass(e.target.value)}
            disabled={!selectedStudent}
            className="mt-1 w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm disabled:bg-surface-50 disabled:text-surface-400"
          >
            <option value="">{selectedStudent ? '— Select Class —' : '— Select Student First —'}</option>
            {studentClasses.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        {/* Date */}
        <label className="block text-xs font-medium text-surface-600">
          Date
          <input type="date" value={dateStr} onChange={e => setDateStr(e.target.value)}
            className="mt-1 w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm" />
        </label>

        {/* Time Slot */}
        <label className="block text-xs font-medium text-surface-600">
          Time Slot
          <select
            value={selectedSlot}
            onChange={e => setSelectedSlot(e.target.value)}
            disabled={loadingSlots || slots.length === 0}
            className="mt-1 w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm disabled:bg-surface-50 disabled:text-surface-400"
          >
            <option value="">{loadingSlots ? 'Loading...' : slots.length === 0 ? '— Select Date First —' : '— Select Slot —'}</option>
            {slots.map(s => (
              <option key={s.hour} value={s.hour}>{s.display} ({s.available} available)</option>
            ))}
          </select>
        </label>

        {/* Submit */}
        <button
          onClick={handleSignup}
          disabled={saving || !selectedStudent || !selectedSlot || !dateStr}
          className="w-full py-3 bg-emerald-500 text-white font-semibold rounded-lg hover:bg-emerald-600 disabled:bg-surface-300 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Sign Up Student'}
        </button>
      </div>
    </div>
  )
}
