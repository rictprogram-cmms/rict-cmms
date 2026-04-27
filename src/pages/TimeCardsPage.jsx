/**
 * RICT CMMS - Time Cards Page (React/Supabase)
 *
 * Features:
 * - Individual Time Card tab (student sees own, instructor picks any)
 * - Class Weekly Report tab (instructor only)
 * - Week navigation + date range picker
 * - Class summary cards (hours vs required)
 * - Attendance analysis:
 *     · Late arrival detection (with grace period from settings)
 *     · Early departure detection (with grace period)
 *     · Walk-in detection (no lab signup for that date)
 *     · No-show indicator
 *     · Attendance score & accountability summary
 * - Add/Edit/Delete entries (instructor only — direct)
 * - Request Entry (student/work study — pending approval)
 * - Report: date-range report per class with WEEK-BY-WEEK breakdown
 *     · Shows each week's hours, attendance flags, and lab completion status
 *     · Individual student report OR batch class report (all students)
 * - Print-friendly layout with page breaks per student in batch mode
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import {
  useUsersForReports, useClassesList, useTimeCardData,
  useClassWeeklyReport, useTimeEntryActions, getWeekRange, toDateStr
} from '@/hooks/useTimeCards'
import { buildClassWeeks } from '@/hooks/useWeeklyLabs'
import {
  ChevronLeft, ChevronRight, Printer, Plus, Edit3, Trash2,
  Loader2, Clock, User, Users, AlertTriangle, CheckCircle2,
  X, Timer, Send, Shield, LogIn, LogOut, Footprints,
  FileText, Calendar, ArrowLeft, BookOpen, BadgeCheck,
  ChevronDown, ChevronUp, FilePenLine, MessageCircle
} from 'lucide-react'
import PendingTimeRequestsPanel from '@/components/PendingTimeRequestsPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// NOTE: Timestamps in the DB use "local-as-UTC" convention from the GAS migration.
// e.g. a 7:56 AM CST punch is stored as "07:56:00+00". We must read UTC components
// to display the correct local time. This will be normalized at spring break cutover.
function formatDate(val) {
  if (!val) return '—'
  try {
    const d = new Date(val)
    // Read UTC components (which actually represent local time)
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
      .toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        timeZone: 'UTC'
      })
  } catch { return '—' }
}

function formatTime(val) {
  if (!val) return '—'
  try {
    const d = new Date(val)
    // Read UTC components (which actually represent local time)
    const h = d.getUTCHours()
    const m = d.getUTCMinutes()
    const ampm = h >= 12 ? 'PM' : 'AM'
    const h12 = h % 12 || 12
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`
  } catch { return '—' }
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

function formatDateRange(start, end) {
  const s = new Date(start)
  const e = new Date(end)
  const opts = { month: 'short', day: 'numeric' }
  return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`
}

function formatDateLong(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function formatDateShort(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function minutesToTimeStr(min) {
  if (min === null || min === undefined) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

function formatMinutes(min) {
  if (!min) return ''
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${min}m`
}

function timeToMinutes(timeStr) {
  if (!timeStr) return null
  const parts = timeStr.split(':')
  return parseInt(parts[0]) * 60 + parseInt(parts[1] || '0')
}

function extractDateFromTimestamp(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const yr = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dy = String(d.getUTCDate()).padStart(2, '0')
  return `${yr}-${mo}-${dy}`
}

function extractTimeMinutes(ts) {
  if (!ts) return null
  const d = new Date(ts)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function parseSafeDate(d) {
  if (!d) return null
  const s = (typeof d === 'string' ? d : d.toISOString()).substring(0, 10).split('-')
  return new Date(+s[0], +s[1] - 1, +s[2])
}

function toSafeDateStr(d) {
  if (!d) return ''
  const yr = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dy = String(d.getDate()).padStart(2, '0')
  return `${yr}-${mo}-${dy}`
}

/**
 * Returns true if a class's date window overlaps with the selected date range.
 * Null start_date / end_date means no restriction on that side (e.g. Work Study).
 */
function classActiveInRange(c, rangeStart, rangeEnd) {
  const classStart = c.start_date ? c.start_date.split('T')[0] : null
  const classEnd   = c.end_date   ? c.end_date.split('T')[0]   : null
  if (!classStart && !classEnd) return true
  const startOk = !classStart || classStart <= rangeEnd
  const endOk   = !classEnd   || classEnd   >= rangeStart
  return startOk && endOk
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATION — reusable per-user logic
// ═══════════════════════════════════════════════════════════════════════════════

async function generateUserReport(userData, reportStart, reportEnd, gracePeriod, classesData) {
  const userEmail = userData.email || ''
  const userName = `${userData.first_name} ${userData.last_name}`
  const profileId = userData.id || ''

  // 1. Fetch time clock entries
  const { data: tcData, error: tcError } = await supabase
    .from('time_clock')
    .select('*')
    .eq('user_id', userData.user_id)
    .gte('punch_in', reportStart)
    .lte('punch_in', reportEnd + 'T23:59:59')
    .order('punch_in', { ascending: true })

  if (tcError) throw tcError
  const records = tcData || []

  // 2. Fetch lab signups
  let signups = []
  if (userEmail) {
    try {
      const { data: suData } = await supabase
        .from('lab_signup')
        .select('date, start_time, end_time, class_id, status')
        .eq('user_email', userEmail)
        .eq('status', 'Confirmed')
        .gte('date', reportStart)
        .lte('date', reportEnd + 'T23:59:59')
      signups = suData || []
    } catch {}
  }

  const enrolledClassIds = (userData.classes || '')
    .split(',').map(c => c.trim()).filter(c => c)

  // Only include enrolled classes whose date window overlaps the report range.
  // This prevents future classes (not started yet) and fully-ended classes from
  // appearing as "No time entries" sections in reports for periods outside their run.
  const enrolledClasses = (classesData || []).filter(c =>
    (enrolledClassIds.includes(c.class_id) || enrolledClassIds.includes(c.course_id)) &&
    classActiveInRange(c, reportStart, reportEnd)
  )

  // 3. Fetch weekly_lab_tracker
  let labTrackerData = []
  try {
    const orFilter = [`user_email.eq.${userEmail}`]
    if (profileId) orFilter.push(`user_id.eq.${profileId}`)
    const { data: ltData } = await supabase
      .from('weekly_lab_tracker')
      .select('*')
      .or(orFilter.join(','))
    labTrackerData = ltData || []
  } catch {}

  // 4. Group signups by date
  const signupsByDate = {}
  signups.forEach(s => {
    const d = (s.date || '').split('T')[0]
    if (!d) return
    if (!signupsByDate[d]) signupsByDate[d] = { startMin: Infinity, endMin: 0, slots: [] }
    const sMin = timeToMinutes(s.start_time)
    const eMin = timeToMinutes(s.end_time)
    if (sMin !== null && sMin < signupsByDate[d].startMin) signupsByDate[d].startMin = sMin
    if (eMin !== null && eMin > signupsByDate[d].endMin) signupsByDate[d].endMin = eMin
    signupsByDate[d].slots.push({
      startTime: s.start_time, endTime: s.end_time, classId: s.class_id
    })
  })

  // 5. Pre-compute daily attendance spans (across all class entries on same day)
  const daySpans = {}
  records.forEach(r => {
    if (r.status === 'No Show' || r.entry_type === 'Volunteer') return
    const d = extractDateFromTimestamp(r.punch_in)
    if (!d) return
    if (!daySpans[d]) daySpans[d] = { firstPunchIn: Infinity, lastPunchOut: 0, hasStillIn: false, firstRecordId: null, lastRecordId: null, hasAllDone: false }
    if (r.entry_type === 'All Done') {
      daySpans[d].hasAllDone = true
      return
    }
    const piMin = extractTimeMinutes(r.punch_in)
    const poMin = extractTimeMinutes(r.punch_out)
    const isStillIn = r.status === 'Punched In'
    if (piMin !== null && piMin < daySpans[d].firstPunchIn) {
      daySpans[d].firstPunchIn = piMin
      daySpans[d].firstRecordId = r.record_id
    }
    if (!isStillIn && poMin !== null && poMin > daySpans[d].lastPunchOut) {
      daySpans[d].lastPunchOut = poMin
      daySpans[d].lastRecordId = r.record_id
    }
    if (isStillIn) daySpans[d].hasStillIn = true
  })

  // Pre-compute which record_ids get late/early flags
  // Skip Left Early flagging on days with an All Done swipe.
  const lateFlagRecords = new Set()
  const earlyFlagRecords = new Set()
  const dayLateInfo = {}
  const dayEarlyInfo = {}

  Object.entries(daySpans).forEach(([date, span]) => {
    const daySignup = signupsByDate[date]
    if (!daySignup || daySignup.startMin === Infinity) return

    if (span.firstPunchIn !== Infinity && span.firstRecordId) {
      const lateBy = span.firstPunchIn - daySignup.startMin
      dayLateInfo[date] = { isLate: lateBy > gracePeriod, lateMinutes: lateBy > gracePeriod ? lateBy : 0 }
      if (lateBy > gracePeriod) lateFlagRecords.add(span.firstRecordId)
    }

    if (!span.hasAllDone && !span.hasStillIn && span.lastPunchOut > 0 && span.lastRecordId && daySignup.endMin > 0) {
      const earlyBy = daySignup.endMin - span.lastPunchOut
      dayEarlyInfo[date] = { isEarly: earlyBy > gracePeriod, earlyMinutes: earlyBy > gracePeriod ? earlyBy : 0 }
      if (earlyBy > gracePeriod) earlyFlagRecords.add(span.lastRecordId)
    }
  })

  // 6. Enrich entries with attendance flags using pre-computed day-span data
  const enrichedRecords = records.map(r => {
    const entryDate = extractDateFromTimestamp(r.punch_in)
    const isNoShow = r.status === 'No Show'
    const isVolunteer = r.entry_type === 'Volunteer'
    const isAllDone = r.entry_type === 'All Done'

    const flags = {
      isLate: false, lateMinutes: 0,
      isEarlyDeparture: false, earlyMinutes: 0,
      isWalkIn: false, isNoShow: false, isOnTime: false,
      isWrongClass: false, wrongClassExpected: null,
      scheduledStart: null, scheduledEnd: null,
    }

    if (isNoShow) { flags.isNoShow = true; return { ...r, flags } }
    if (isVolunteer) { return { ...r, flags } }
    if (isAllDone) { flags.isOnTime = true; return { ...r, flags } }

    const daySignup = entryDate ? signupsByDate[entryDate] : null
    if (!daySignup || daySignup.startMin === Infinity) {
      flags.isWalkIn = true
      return { ...r, flags }
    }

    flags.scheduledStart = daySignup.startMin
    flags.scheduledEnd = daySignup.endMin

    // Wrong-class detection: an overlapping signup slot exists but for a different course.
    // Treat as neutral (excluded from on-time score) — informational only.
    const entryStartMin = extractTimeMinutes(r.punch_in)
    const entryEndMin = extractTimeMinutes(r.punch_out)
    const entryCourse = r.course_id || r.class_id || ''
    if (entryStartMin !== null && entryEndMin !== null && entryCourse && Array.isArray(daySignup.slots)) {
      const overlapping = daySignup.slots.filter(s => {
        const sStart = timeToMinutes(s.startTime)
        const sEnd = timeToMinutes(s.endTime)
        if (sStart === null || sEnd === null) return false
        return entryStartMin < sEnd && entryEndMin > sStart
      })
      if (overlapping.length > 0 && !overlapping.some(s => s.classId === entryCourse)) {
        flags.isWrongClass = true
        flags.wrongClassExpected = [...new Set(overlapping.map(s => s.classId))].join(', ')
        return { ...r, flags }
      }
    }

    // Late: only on the entry with the day's earliest punch_in
    if (lateFlagRecords.has(r.record_id)) {
      const info = dayLateInfo[entryDate]
      flags.isLate = true
      flags.lateMinutes = info.lateMinutes
    } else {
      flags.isOnTime = true
    }

    // Early departure: only on the entry with the day's latest punch_out
    if (earlyFlagRecords.has(r.record_id)) {
      const info = dayEarlyInfo[entryDate]
      flags.isEarlyDeparture = true
      flags.earlyMinutes = info.earlyMinutes
    }

    return { ...r, flags }
  })

  // 6. Build per-class reports with week-by-week breakdown
  const classMap = {}
  enrichedRecords.forEach(r => {
    const cls = r.course_id || r.class_id || 'Unknown'
    if (!classMap[cls]) classMap[cls] = { entries: [], totalHours: 0, requiredHoursPerWeek: 0 }
    classMap[cls].entries.push(r)
    classMap[cls].totalHours += parseFloat(r.total_hours) || 0
  })

  enrolledClasses.forEach(c => {
    const key = c.course_id || c.class_id
    if (!classMap[key]) classMap[key] = { entries: [], totalHours: 0, requiredHoursPerWeek: 0 }
    classMap[key].requiredHoursPerWeek = parseFloat(c.required_hours) || 0
    classMap[key].courseName = c.course_name || ''
    classMap[key].classConfig = c
  })

  const classReports = Object.entries(classMap).map(([courseId, data]) => {
    const cfg = data.classConfig
    let classWeeks = []
    if (cfg) {
      classWeeks = buildClassWeeks({
        startDate: cfg.start_date, endDate: cfg.end_date,
        springBreakStart: cfg.spring_break_start, springBreakEnd: cfg.spring_break_end,
        finalsStart: cfg.finals_start, finalsEnd: cfg.finals_end,
      })
    }

    const classLabTracker = labTrackerData.filter(lt => lt.course_id === courseId)
    const labByWeek = {}
    classLabTracker.forEach(lt => {
      const wn = parseInt(lt.week_number)
      if (!isNaN(wn)) {
        labByWeek[wn] = {
          labComplete: lt.lab_complete === 'Yes' || lt.lab_complete === true,
          allDone: lt.all_done === 'Yes' || lt.all_done === true,
          requiredHoursMet: lt.required_hours_met === 'Yes' || lt.required_hours_met === true,
        }
      }
    })

    const weeklyBreakdown = classWeeks.map(wk => {
      const wkStartStr = toSafeDateStr(parseSafeDate(wk.startDate))
      const wkEndStr = toSafeDateStr(parseSafeDate(wk.endDate))

      const weekEntries = data.entries.filter(e => {
        const eDate = extractDateFromTimestamp(e.punch_in)
        if (!eDate) return false
        return eDate >= wkStartStr && eDate <= wkEndStr
      })

      let weekHours = 0
      let lateCount = 0, earlyCount = 0, walkInCount = 0, wrongClassCount = 0, noShowCount = 0, onTimeCount = 0
      let totalLateMins = 0, totalEarlyMins = 0

      const nonVolunteer = weekEntries.filter(e => e.entry_type !== 'Volunteer')
      nonVolunteer.forEach(e => {
        const f = e.flags
        if (f.isNoShow) noShowCount++
        else if (f.isLate) { lateCount++; totalLateMins += f.lateMinutes }
        if (f.isEarlyDeparture) { earlyCount++; totalEarlyMins += f.earlyMinutes }
        if (f.isWalkIn) walkInCount++
        if (f.isWrongClass) wrongClassCount++
        if (f.isOnTime) onTimeCount++
      })

      weekEntries.forEach(e => { weekHours += parseFloat(e.total_hours) || 0 })

      const labStatus = labByWeek[wk.weekNumber] || { labComplete: false, allDone: false, requiredHoursMet: false }

      // Per-week score:
      //   Base = 100% if hours met OR All Done given (lab_complete / required_hours_met
      //          from weekly_lab_tracker also count as a closure signal).
      //   Base = (hours / required) × 100 otherwise — so 0 hours = 0%, partial proportional.
      //   Then apply −10/Late, −10/Early, −20/NoShow. Floor at 0.
      const wkClosed = labStatus.allDone || labStatus.requiredHoursMet ||
        weekEntries.some(e => e.entry_type === 'All Done')
      const wkRequired = data.requiredHoursPerWeek || 0
      let wkBase = 100
      if (!wkClosed && wkRequired > 0 && weekHours < wkRequired) {
        wkBase = Math.min(100, Math.round((weekHours / wkRequired) * 100))
      }
      const weekScore = Math.max(0, wkBase - (lateCount * 10) - (earlyCount * 10) - (noShowCount * 20))

      return {
        weekNumber: wk.weekNumber,
        startDate: wkStartStr, endDate: wkEndStr,
        isFinals: wk.isFinals, entries: weekEntries,
        hours: Math.round(weekHours * 100) / 100,
        requiredHours: data.requiredHoursPerWeek,
        metHours: weekHours >= data.requiredHoursPerWeek,
        labComplete: labStatus.labComplete,
        allDone: labStatus.allDone,
        requiredHoursMet: labStatus.requiredHoursMet,
        attendance: {
          lateArrivals: lateCount, earlyDepartures: earlyCount,
          noShows: noShowCount, walkIns: walkInCount, wrongClass: wrongClassCount,
          onTimeCount,
          totalLateMinutes: totalLateMins, totalEarlyMinutes: totalEarlyMins,
          totalEntries: nonVolunteer.length,
          attendanceScore: weekScore,
        }
      }
    })

    const filteredWeeks = weeklyBreakdown.filter(wk =>
      wk.endDate >= reportStart && wk.startDate <= reportEnd
    )

    let lateCount = 0, earlyCount = 0, walkInCount = 0, wrongClassCount = 0, noShowCount = 0,
      onTimeCount = 0, totalLateMins = 0, totalEarlyMins = 0
    const nonVolunteer = data.entries.filter(e => e.entry_type !== 'Volunteer' && e.entry_type !== 'Work Study')
    nonVolunteer.forEach(e => {
      const f = e.flags
      if (f.isNoShow) noShowCount++
      else if (f.isLate) { lateCount++; totalLateMins += f.lateMinutes }
      if (f.isEarlyDeparture) { earlyCount++; totalEarlyMins += f.earlyMinutes }
      if (f.isWalkIn) walkInCount++
      if (f.isWrongClass) wrongClassCount++
      if (f.isOnTime) onTimeCount++
    })

    // Per-class on-time score = average of per-week scores within the report range.
    // Each week's score already factors in the hours-met / All Done base.
    const attendanceScore = filteredWeeks.length > 0
      ? Math.round(filteredWeeks.reduce((sum, w) => sum + (w.attendance.attendanceScore || 0), 0) / filteredWeeks.length)
      : 100
    const totalWeeks = classWeeks.length
    const weeksWithLab = filteredWeeks.filter(w => w.labComplete).length
    const weeksWithHours = filteredWeeks.filter(w => w.metHours || w.requiredHoursMet).length
    const weeksDone = filteredWeeks.filter(w => w.allDone).length
    const totalRequiredHours = data.requiredHoursPerWeek * filteredWeeks.length

    return {
      courseId, courseName: data.courseName || '',
      entries: data.entries,
      totalHours: Math.round(data.totalHours * 100) / 100,
      requiredHoursPerWeek: data.requiredHoursPerWeek,
      totalRequiredHours: Math.round(totalRequiredHours * 100) / 100,
      totalWeeks, weeklyBreakdown: filteredWeeks,
      weeksWithLab, weeksWithHours, weeksDone,
      attendance: {
        lateArrivals: lateCount, earlyDepartures: earlyCount,
        noShows: noShowCount, walkIns: walkInCount, wrongClass: wrongClassCount,
        onTimeCount,
        totalLateMinutes: totalLateMins, totalEarlyMinutes: totalEarlyMins,
        totalEntries: nonVolunteer.length, attendanceScore,
      }
    }
  }).sort((a, b) => a.courseId.localeCompare(b.courseId))

  const grandTotalHours = enrichedRecords.reduce((sum, r) => sum + (parseFloat(r.total_hours) || 0), 0)

  return {
    userName, userRole: userData.role, userEmail,
    startDate: reportStart, endDate: reportEnd,
    classReports,
    grandTotalHours: Math.round(grandTotalHours * 100) / 100,
    gracePeriod,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function TimeCardsPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Reports')
  // Use DB permission instead of hardcoded role check
  const isInstructor = hasPerm('view_all')
  const canEditTime = hasPerm('edit_time')
  const { users } = useUsersForReports({ canViewAll: isInstructor })
  // includeInactive: true so historical reports can reference old/inactive classes
  const { classes } = useClassesList({ includeInactive: true })
  // For add/request modals, only show currently active classes
  const activeClasses = useMemo(() => (classes || []).filter(c => c.status === 'Active'), [classes])
  const timeCard = useTimeCardData()
  const classReport = useClassWeeklyReport()
  const actions = useTimeEntryActions({ canEdit: canEditTime })

  const [tab, setTab] = useState('timecard')
  const [startDate, setStartDate] = useState(() => toDateStr(getWeekRange().start))
  const [endDate, setEndDate] = useState(() => toDateStr(getWeekRange().end))
  const [selectedUserId, setSelectedUserId] = useState('')
  const [selectedClass, setSelectedClass] = useState('')

  // Modals
  const [showAddModal, setShowAddModal] = useState(false)
  const [showRequestModal, setShowRequestModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [showEditRequestModal, setShowEditRequestModal] = useState(false)
  const [editRequestEntry, setEditRequestEntry] = useState(null)

  // Report
  const [showReportModal, setShowReportModal] = useState(false)
  const [reportData, setReportData] = useState(null)
  // Toggle to show/hide inactive (historical) classes in dropdowns
  const [showInactiveClasses, setShowInactiveClasses] = useState(false)

  useEffect(() => {
    if (profile && !isInstructor && profile.user_id) setSelectedUserId(profile.user_id)
  }, [profile, isInstructor])

  useEffect(() => {
    if (selectedUserId && startDate && endDate && tab === 'timecard')
      timeCard.fetchTimeCard(selectedUserId, startDate, endDate)
  }, [selectedUserId, startDate, endDate, tab])

  useEffect(() => {
    if (selectedClass && startDate && endDate && tab === 'classweekly')
      classReport.fetchReport(selectedClass, startDate, endDate)
  }, [selectedClass, startDate, endDate, tab])

  const nav = (offset) => {
    const d = new Date(startDate + 'T00:00:00')
    d.setDate(d.getDate() + offset)
    const range = getWeekRange(d)
    setStartDate(toDateStr(range.start))
    setEndDate(toDateStr(range.end))
  }
  const goThisWeek = () => {
    const range = getWeekRange()
    setStartDate(toDateStr(range.start))
    setEndDate(toDateStr(range.end))
  }

  const selectedUserName = useMemo(() => {
    if (!selectedUserId) return ''
    if (!isInstructor && profile) return `${profile.first_name} ${profile.last_name}`
    const u = users.find(u => u.user_id === selectedUserId)
    return u ? `${u.first_name} ${u.last_name}` : selectedUserId
  }, [selectedUserId, users, profile, isInstructor])

  const handleDelete = async (recordId) => {
    const res = await actions.deleteEntry(recordId)
    if (res?.success) { setConfirmDelete(null); timeCard.fetchTimeCard(selectedUserId, startDate, endDate) }
  }
  const handleEntrySaved = () => {
    setShowAddModal(false); setShowEditModal(false); setEditingEntry(null)
    timeCard.fetchTimeCard(selectedUserId, startDate, endDate)
  }
  const handleRequestSubmitted = () => setShowRequestModal(false)
  const handleEditRequestSubmitted = () => {
    setShowEditRequestModal(false)
    setEditRequestEntry(null)
    timeCard.fetchTimeCard(selectedUserId, startDate, endDate)
  }

  const canAddEntry = hasPerm('edit_time') && tab === 'timecard' && selectedUserId
  const canRequestEntry = !hasPerm('edit_time') && tab === 'timecard' && selectedUserId

  // If report is active, show the report view
  if (reportData) {
    return <ReportView reportData={reportData} onClose={() => setReportData(null)} />
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-5 print:p-0 print:space-y-3">

      {/* Tabs */}
      {isInstructor && (
        <div className="flex gap-2 print:hidden">
          <TabBtn active={tab === 'timecard'} icon={<User size={16} />}
            label="Individual Time Card" onClick={() => setTab('timecard')} />
          <TabBtn active={tab === 'classweekly'} icon={<Users size={16} />}
            label="Class Weekly Report" onClick={() => setTab('classweekly')} />
          <TabBtn active={tab === 'pending'} icon={<Clock size={16} />}
            label="Pending Requests" onClick={() => setTab('pending')} />
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <button onClick={() => nav(-7)} title="Previous Week"
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-surface-200 bg-white hover:bg-surface-50 text-surface-600">
              <ChevronLeft size={16} />
            </button>
            <button onClick={goThisWeek}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-surface-200 bg-white hover:bg-surface-50 text-surface-600">
              This Week
            </button>
            <button onClick={() => nav(7)} title="Next Week"
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-surface-200 bg-white hover:bg-surface-50 text-surface-600">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-600">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="px-2 py-1.5 border border-surface-200 rounded-lg text-xs bg-white" />
            <span className="text-surface-400">to</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-2 py-1.5 border border-surface-200 rounded-lg text-xs bg-white" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canAddEntry && (
            <button onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium rounded-lg">
              <Plus size={14} /> Add Entry
            </button>
          )}
          {canRequestEntry && (
            <button onClick={() => setShowRequestModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium rounded-lg">
              <Send size={14} /> Request Entry
            </button>
          )}
          <button onClick={() => setShowReportModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium rounded-lg">
            <FileText size={14} /> Report
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 border border-surface-200 bg-white text-surface-600 text-xs font-medium rounded-lg hover:bg-surface-50">
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      {/* ─── Individual Time Card ──────────────────────────────────────── */}
      {tab === 'timecard' && (
        <>
          {isInstructor && (
            <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 print:hidden">
              <label className="block text-xs font-medium text-surface-600 mb-1">Select Student:</label>
              <select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)}
                className="input text-sm max-w-md">
                <option value="">Select a student…</option>
                {users.filter(u => u.role !== 'Instructor').map((u, idx) => (
                  <option key={u.user_id || `user-${idx}`} value={u.user_id}>
                    {u.last_name}, {u.first_name} ({u.role})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
            <div className="p-6">
              {!selectedUserId ? (
                <div className="text-center py-12 text-surface-400 text-sm">
                  {isInstructor ? 'Select a student to view their time card.' : 'Loading your time card…'}
                </div>
              ) : timeCard.loading ? (
                <div className="flex items-center justify-center py-16 text-surface-400 gap-2 text-sm">
                  <Loader2 size={16} className="animate-spin" /> Loading time card…
                </div>
              ) : (
                <TimeCardContent
                  entries={timeCard.entries}
                  classSummary={timeCard.classSummary}
                  totalHours={timeCard.totalHours}
                  attendanceSummary={timeCard.attendanceSummary}
                  pendingEdits={timeCard.pendingEdits}
                  userName={selectedUserName}
                  dateRange={formatDateRange(startDate, endDate)}
                  isInstructor={isInstructor}
                  onEdit={entry => { setEditingEntry(entry); setShowEditModal(true) }}
                  onDelete={entry => setConfirmDelete(entry)}
                  onRequestEdit={entry => { setEditRequestEntry(entry); setShowEditRequestModal(true) }}
                  onPunchOut={async (entry) => {
                    const res = await actions.punchOutEntry(entry.record_id, entry.punch_in)
                    if (res?.success) timeCard.fetchTimeCard(selectedUserId, startDate, endDate)
                  }}
                  saving={actions.saving}
                />
              )}
            </div>
          </div>
        </>
      )}

      {/* ─── Class Weekly Report ───────────────────────────────────────── */}
      {tab === 'classweekly' && (
        <>
          <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 print:hidden">
            <label className="block text-xs font-medium text-surface-600 mb-1">Select Class:</label>
            <div className="flex items-center gap-3">
              <select value={selectedClass} onChange={e => setSelectedClass(e.target.value)}
                className="input text-sm flex-1 max-w-md">
                <option value="">Select a class…</option>
                {classes
                  .filter(c => showInactiveClasses || c.status === 'Active')
                  .map(c => (
                    <option key={c.class_id} value={c.course_id}>
                      {c.course_id}{c.course_name ? ` — ${c.course_name}` : ''}
                      {c.status !== 'Active' ? ` (${c.semester || 'Inactive'})` : ''}
                    </option>
                  ))}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-surface-500 cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={showInactiveClasses}
                  onChange={e => setShowInactiveClasses(e.target.checked)}
                  className="rounded border-surface-300 text-brand-600"
                />
                Show inactive
              </label>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
            <div className="p-6">
              {!selectedClass ? (
                <div className="text-center py-12 text-surface-400 text-sm">Select a class to generate the report.</div>
              ) : classReport.loading ? (
                <div className="flex items-center justify-center py-16 text-surface-400 gap-2 text-sm">
                  <Loader2 size={16} className="animate-spin" /> Loading class report…
                </div>
              ) : (
                <ClassWeeklyContent
                  students={classReport.students}
                  classInfo={classReport.classInfo}
                  dateRange={formatDateRange(startDate, endDate)}
                />
              )}
            </div>
          </div>
        </>
      )}

      {/* ─── Pending Time Entry Requests (Instructor) ─────────── */}
      {tab === 'pending' && isInstructor && (
        <PendingTimeRequestsPanel actions={actions} />
      )}

      {/* ─── Modals ────────────────────────────────────────────────────── */}
      {showAddModal && (
        <AddEntryModal userId={selectedUserId} classes={activeClasses} actions={actions}
          onClose={() => setShowAddModal(false)} onSaved={handleEntrySaved} />
      )}
      {showRequestModal && (
        <RequestEntryModal classes={activeClasses} actions={actions} profile={profile}
          onClose={() => setShowRequestModal(false)} onSubmitted={handleRequestSubmitted} />
      )}
      {showEditModal && editingEntry && (
        <EditEntryModal entry={editingEntry} classes={classes} actions={actions}
          onClose={() => { setShowEditModal(false); setEditingEntry(null) }} onSaved={handleEntrySaved} />
      )}
      {confirmDelete && (
        <ConfirmDeleteModal entry={confirmDelete} saving={actions.saving} classes={classes}
          onConfirm={() => handleDelete(confirmDelete.record_id)}
          onCancel={() => setConfirmDelete(null)} />
      )}
      {showReportModal && (
        <ReportModal
          profile={profile}
          isInstructor={isInstructor}
          users={users}
          classes={classes}
          selectedUserId={selectedUserId}
          onClose={() => setShowReportModal(false)}
          onGenerate={(data) => { setShowReportModal(false); setReportData(data) }}
          showInactiveDefault={showInactiveClasses}
        />
      )}
      {showEditRequestModal && editRequestEntry && (
        <RequestEditModal
          entry={editRequestEntry}
          actions={actions}
          profile={profile}
          classes={classes}
          onClose={() => { setShowEditRequestModal(false); setEditRequestEntry(null) }}
          onSubmitted={handleEditRequestSubmitted}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT MODAL — Individual OR Batch Class Report
// ═══════════════════════════════════════════════════════════════════════════════

function ReportModal({ profile, isInstructor, users, classes, selectedUserId, onClose, onGenerate, showInactiveDefault = false }) {
  const today = toDateStr(new Date())
  const [reportMode, setReportMode] = useState('individual')
  const [reportStart, setReportStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return toDateStr(d)
  })
  const [reportEnd, setReportEnd] = useState(today)
  const [reportUserId, setReportUserId] = useState(
    isInstructor ? (selectedUserId || '') : (profile?.user_id || '')
  )
  const [reportClassId, setReportClassId] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [showInactiveClasses, setShowInactiveClasses] = useState(showInactiveDefault)

  const handleGenerate = async () => {
    setLoading(true)
    setProgress({ current: 0, total: 0 })
    try {
      // Get grace period
      let gracePeriod = 10
      try {
        const { data: gs } = await supabase
          .from('settings').select('setting_value')
          .eq('setting_key', 'grace_period_minutes').maybeSingle()
        if (gs?.setting_value) gracePeriod = parseInt(gs.setting_value) || 10
      } catch {}

      // Get ALL class configs (including inactive) so historical reports work correctly
      const { data: classesData } = await supabase
        .from('classes').select('*')

      if (reportMode === 'individual') {
        // ── Individual Report ──────────────────────────────────────────
        if (!reportUserId) return

        const { data: userData } = await supabase
          .from('profiles')
          .select('user_id, first_name, last_name, email, classes, role, id')
          .eq('user_id', reportUserId).maybeSingle()

        if (!userData) throw new Error('User not found')

        const result = await generateUserReport(userData, reportStart, reportEnd, gracePeriod, classesData)
        onGenerate({
          ...result,
          isBatch: false,
          generatedAt: new Date().toISOString(),
        })

      } else {
        // ── Batch Class Report ─────────────────────────────────────────
        if (!reportClassId) return

        // Find the class config (works for both active and inactive classes)
        const selectedClassConfig = (classesData || []).find(c => c.course_id === reportClassId)
        const selectedClassId = selectedClassConfig?.class_id || reportClassId

        // Get all active students enrolled in this class.
        // For inactive (historical) classes, students may have been moved to new classes
        // in their profile, so we also search time_clock records directly.
        const { data: profilesData } = await supabase
          .from('profiles')
          .select('user_id, first_name, last_name, email, classes, role, id, time_clock_only')
          .eq('status', 'Active')

        // Check profile enrollment
        const enrolledByProfile = new Set(
          (profilesData || [])
            .filter(p => {
              if (p.role === 'Instructor') return false
              if (p.time_clock_only === 'Yes') return false
              const cls = (p.classes || '').split(',').map(c => c.trim())
              return cls.includes(reportClassId) || cls.includes(selectedClassId)
            })
            .map(p => p.user_id)
        )

        // For inactive classes: also find anyone who has time_clock records for this course
        // in the selected date range (catches students who were removed from the class)
        let enrolledByTimeClock = new Set()
        if (selectedClassConfig?.status !== 'Active') {
          const { data: tcCheck } = await supabase
            .from('time_clock')
            .select('user_id')
            .or(`course_id.eq.${reportClassId},class_id.eq.${selectedClassId}`)
            .gte('punch_in', reportStart)
            .lte('punch_in', reportEnd + 'T23:59:59')
          ;(tcCheck || []).forEach(r => { if (r.user_id) enrolledByTimeClock.add(r.user_id) })
        }

        const allEnrolledIds = new Set([...enrolledByProfile, ...enrolledByTimeClock])

        const enrolledStudents = (profilesData || [])
          .filter(p => allEnrolledIds.has(p.user_id))
          .sort((a, b) => {
            const nameA = `${a.last_name} ${a.first_name}`.toLowerCase()
            const nameB = `${b.last_name} ${b.first_name}`.toLowerCase()
            return nameA.localeCompare(nameB)
          })

        if (enrolledStudents.length === 0) throw new Error('No students enrolled in this class')

        setProgress({ current: 0, total: enrolledStudents.length })

        const studentReports = []
        for (let i = 0; i < enrolledStudents.length; i++) {
          setProgress({ current: i + 1, total: enrolledStudents.length })
          const student = enrolledStudents[i]
          try {
            const result = await generateUserReport(student, reportStart, reportEnd, gracePeriod, classesData)
            // Filter class reports to only the selected class
            const filteredClassReports = result.classReports.filter(cr => cr.courseId === reportClassId)
            studentReports.push({
              ...result,
              classReports: filteredClassReports,
              grandTotalHours: filteredClassReports.reduce((sum, cr) => sum + cr.totalHours, 0),
            })
          } catch (err) {
            console.warn(`Report failed for ${student.first_name} ${student.last_name}:`, err)
          }
        }

        onGenerate({
          isBatch: true,
          batchClassName: reportClassId,
          batchCourseName: selectedClassConfig?.course_name || '',
          studentReports,
          startDate: reportStart,
          endDate: reportEnd,
          gracePeriod,
          generatedAt: new Date().toISOString(),
          totalStudents: enrolledStudents.length,
        })
      }
    } catch (err) {
      console.error('Report generation error:', err)
    } finally {
      setLoading(false)
      setProgress({ current: 0, total: 0 })
    }
  }

  const isValid = reportMode === 'individual'
    ? (reportUserId && reportStart && reportEnd)
    : (reportClassId && reportStart && reportEnd)

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-teal-100 flex items-center justify-center">
              <FileText size={16} className="text-teal-600" />
            </div>
            <div>
              <h3 className="font-semibold text-surface-900">Generate Attendance Report</h3>
              <p className="text-xs text-surface-400">Week-by-week breakdown with lab completion</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400"><X size={18} /></button>
        </div>
        <div className="px-5 py-5 space-y-4">

          {/* Mode Toggle — Instructor only */}
          {isInstructor && (
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1.5">Report Type</label>
              <div className="flex gap-2">
                <button onClick={() => setReportMode('individual')}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    reportMode === 'individual'
                      ? 'bg-teal-50 border-teal-300 text-teal-700'
                      : 'bg-white border-surface-200 text-surface-500 hover:bg-surface-50'
                  }`}>
                  <User size={15} /> Individual Student
                </button>
                <button onClick={() => setReportMode('class')}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    reportMode === 'class'
                      ? 'bg-teal-50 border-teal-300 text-teal-700'
                      : 'bg-white border-surface-200 text-surface-500 hover:bg-surface-50'
                  }`}>
                  <Users size={15} /> Entire Class
                </button>
              </div>
            </div>
          )}

          {/* Individual: Student selector */}
          {reportMode === 'individual' && isInstructor && (
            <Field label="Student">
              <select value={reportUserId} onChange={e => setReportUserId(e.target.value)}
                className="input text-sm">
                <option value="">Select a student…</option>
                {users.filter(u => u.role !== 'Instructor').map((u, idx) => (
                  <option key={u.user_id || `user-${idx}`} value={u.user_id}>
                    {u.last_name}, {u.first_name} ({u.role})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {/* Batch: Class selector */}
          {reportMode === 'class' && (
            <Field label="Class">
              <div className="flex items-center gap-3">
                <select value={reportClassId} onChange={e => setReportClassId(e.target.value)}
                  className="input text-sm flex-1">
                  <option value="">Select a class…</option>
                  {classes
                    .filter(c => showInactiveClasses || c.status === 'Active')
                    .map(c => (
                      <option key={c.class_id} value={c.course_id}>
                        {c.course_id}{c.course_name ? ` — ${c.course_name}` : ''}
                        {c.status !== 'Active' ? ` (${c.semester || 'Inactive'})` : ''}
                      </option>
                    ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-surface-500 cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={showInactiveClasses}
                    onChange={e => { setShowInactiveClasses(e.target.checked); setReportClassId('') }}
                    className="rounded border-surface-300 text-brand-600"
                  />
                  Show inactive
                </label>
              </div>
            </Field>
          )}

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start Date">
              <input type="date" value={reportStart} onChange={e => setReportStart(e.target.value)} className="input text-sm" />
            </Field>
            <Field label="End Date">
              <input type="date" value={reportEnd} onChange={e => setReportEnd(e.target.value)} className="input text-sm" />
            </Field>
          </div>

          {/* Info box */}
          <div className="bg-surface-50 rounded-lg px-3 py-2.5 text-xs text-surface-500 flex items-start gap-2">
            <Calendar size={14} className="text-surface-400 mt-0.5 shrink-0" />
            <span>
              {reportMode === 'individual'
                ? 'The report will show a week-by-week breakdown of hours, attendance accountability, and lab completion status for each class.'
                : 'Generates a full report for every student enrolled in the selected class. Each student gets their own section with page breaks for printing.'
              }
            </span>
          </div>

          {/* Progress bar for batch */}
          {loading && progress.total > 0 && (
            <div>
              <div className="flex items-center justify-between text-xs text-surface-500 mb-1">
                <span>Generating reports…</span>
                <span>{progress.current} / {progress.total} students</span>
              </div>
              <div className="h-2 bg-surface-200 rounded-full overflow-hidden">
                <div className="h-full bg-teal-500 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }} />
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">
            Cancel
          </button>
          <button onClick={handleGenerate}
            disabled={loading || !isValid}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40 flex items-center gap-1.5">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {loading && progress.total > 0
              ? `Generating ${progress.current}/${progress.total}…`
              : reportMode === 'class' ? 'Generate Class Report' : 'Generate Report'
            }
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT VIEW — dispatches individual vs batch
// ═══════════════════════════════════════════════════════════════════════════════

function ReportView({ reportData, onClose }) {
  if (reportData.isBatch) return <BatchReportView reportData={reportData} onClose={onClose} />
  return <SingleReportView reportData={reportData} onClose={onClose} />
}

// ─── Single Student Report ───────────────────────────────────────────────────

function SingleReportView({ reportData, onClose }) {
  const r = reportData
  const [expandedClasses, setExpandedClasses] = useState({})
  const toggleExpand = (key) => setExpandedClasses(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto print:p-0 print:max-w-none">
      <div className="flex items-center justify-between mb-5 print:hidden">
        <button onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-600 hover:bg-surface-100 rounded-lg border border-surface-200">
          <ArrowLeft size={14} /> Back to Time Cards
        </button>
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg">
          <Printer size={14} /> Print Report
        </button>
      </div>

      <div className="bg-white rounded-xl border border-surface-200 shadow-sm print:shadow-none print:border-none print:rounded-none">
        <ReportHeader r={r} />
        <StudentInfoBar r={r} />
        <ReportClassSections classReports={r.classReports} expandedClasses={expandedClasses} toggleExpand={toggleExpand} />

        {r.classReports.length > 0 && (
          <div className="px-8 py-4 border-t-2 border-surface-200 flex justify-end items-center gap-3 print:border-t print:border-black">
            <span className="text-sm font-medium text-surface-600">Grand Total Hours:</span>
            <span className="text-2xl font-bold text-brand-600">{formatHours(r.grandTotalHours)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Batch Class Report ──────────────────────────────────────────────────────

function BatchReportView({ reportData, onClose }) {
  const r = reportData
  const [expandedClasses, setExpandedClasses] = useState({})
  const [collapsedStudents, setCollapsedStudents] = useState({})
  const toggleExpand = (key) => setExpandedClasses(prev => ({ ...prev, [key]: !prev[key] }))
  const toggleStudent = (idx) => setCollapsedStudents(prev => ({ ...prev, [idx]: !prev[idx] }))

  // Class-wide summary
  const classSummary = useMemo(() => {
    const reports = r.studentReports || []
    let totalHours = 0, labsComplete = 0, labsTotal = 0, hoursMet = 0, hoursTotal = 0
    let allLate = 0, allEarly = 0, allWalkIns = 0, allWrongClass = 0, allNoShows = 0

    reports.forEach(sr => {
      totalHours += sr.grandTotalHours
      sr.classReports.forEach(cr => {
        cr.weeklyBreakdown.forEach(wk => {
          labsTotal++
          if (wk.labComplete) labsComplete++
          hoursTotal++
          if (wk.metHours || wk.requiredHoursMet) hoursMet++
        })
        allLate += cr.attendance.lateArrivals
        allEarly += cr.attendance.earlyDepartures
        allWalkIns += cr.attendance.walkIns
        allWrongClass += (cr.attendance.wrongClass || 0)
        allNoShows += cr.attendance.noShows
      })
    })

    return { totalStudents: reports.length, totalHours, labsComplete, labsTotal, hoursMet, hoursTotal, allLate, allEarly, allWalkIns, allWrongClass, allNoShows }
  }, [r.studentReports])

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto print:p-0 print:max-w-none">
      <div className="flex items-center justify-between mb-5 print:hidden">
        <button onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-600 hover:bg-surface-100 rounded-lg border border-surface-200">
          <ArrowLeft size={14} /> Back to Time Cards
        </button>
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg">
          <Printer size={14} /> Print Report
        </button>
      </div>

      <div className="bg-white rounded-xl border border-surface-200 shadow-sm print:shadow-none print:border-none print:rounded-none">

        {/* Batch Header */}
        <div className="px-8 py-6 border-b-2 border-surface-200 print:border-b print:border-black">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-surface-900">Class Attendance Report</h1>
              <p className="text-sm text-surface-500 mt-1">RICT CMMS — Maintenance Program</p>
            </div>
            <div className="text-right text-xs text-surface-400">
              <p>Generated: {new Date(r.generatedAt).toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
              })}</p>
              <p className="mt-0.5">Grace Period: {r.gracePeriod} min</p>
            </div>
          </div>

          {/* Class Info Bar */}
          <div className="mt-4 bg-surface-50 rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-1 print:bg-gray-100">
            <div>
              <span className="text-xs text-surface-400">Class</span>
              <p className="text-sm font-semibold text-surface-900">{r.batchClassName}</p>
            </div>
            {r.batchCourseName && (
              <div>
                <span className="text-xs text-surface-400">Course Name</span>
                <p className="text-sm font-medium text-surface-700">{r.batchCourseName}</p>
              </div>
            )}
            <div>
              <span className="text-xs text-surface-400">Period</span>
              <p className="text-sm font-medium text-surface-700">
                {formatDateLong(r.startDate)} — {formatDateLong(r.endDate)}
              </p>
            </div>
            <div className="ml-auto">
              <span className="text-xs text-surface-400">Students</span>
              <p className="text-lg font-bold text-brand-600">{r.totalStudents}</p>
            </div>
          </div>

          {/* Class-Wide Summary Grid */}
          <div className={`mt-4 grid grid-cols-3 ${classSummary.allWrongClass > 0 ? 'sm:grid-cols-7' : 'sm:grid-cols-6'} gap-2`}>
            <ReportStatBox value={classSummary.totalStudents} label="Students" color="green" />
            <ReportStatBox value={formatHours(classSummary.totalHours)} label="Total Hours" color="green" />
            <ReportStatBox value={`${classSummary.labsComplete}/${classSummary.labsTotal}`} label="Labs Done" color="green" />
            <ReportStatBox value={classSummary.allLate} label="Late" color="red" />
            <ReportStatBox value={classSummary.allEarly} label="Left Early" color="amber" />
            <ReportStatBox value={classSummary.allWalkIns} label="Walk-ins" color="purple" />
            {classSummary.allWrongClass > 0 && (
              <ReportStatBox value={classSummary.allWrongClass} label="Wrong Class" color="orange" />
            )}
          </div>
        </div>

        {/* ─── Per-Student Sections ─────────────────────────────────────── */}
        {(r.studentReports || []).length === 0 ? (
          <div className="px-8 py-12 text-center text-surface-400 text-sm">No students found for this class.</div>
        ) : (
          <div>
            {r.studentReports.map((sr, sIdx) => {
              const isCollapsed = collapsedStudents[sIdx]
              return (
                <div key={sIdx} className={sIdx > 0 ? 'print:break-before-page' : ''}>
                  {/* Student Header (click to collapse on screen) */}
                  <div
                    className={`px-8 py-4 flex items-center justify-between cursor-pointer hover:bg-surface-50 print:cursor-default ${
                      sIdx > 0 ? 'border-t-2 border-surface-200' : ''
                    }`}
                    onClick={() => toggleStudent(sIdx)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-sm font-bold">
                        {sIdx + 1}
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-surface-900">{sr.userName}</h2>
                        <p className="text-xs text-surface-400">{sr.userRole} · {sr.userEmail}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div className="text-lg font-bold text-surface-900">
                          {formatHours(sr.grandTotalHours)}
                          <span className="text-xs font-normal text-surface-400 ml-0.5">hrs</span>
                        </div>
                        {/* Quick status badges */}
                        {sr.classReports.length > 0 && (() => {
                          const cr = sr.classReports[0]
                          const att = cr.attendance
                          return (
                            <div className="flex items-center gap-1 mt-0.5">
                              {att.lateArrivals > 0 && (
                                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700 text-[9px] font-bold" title="Late">{att.lateArrivals}L</span>
                              )}
                              {att.earlyDepartures > 0 && (
                                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-bold" title="Early">{att.earlyDepartures}E</span>
                              )}
                              {att.walkIns > 0 && (
                                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-100 text-purple-700 text-[9px] font-bold" title="Walk-in (neutral)">{att.walkIns}W</span>
                              )}
                              {att.wrongClass > 0 && (
                                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-100 text-orange-700 text-[9px] font-bold" title="Wrong class (neutral)">{att.wrongClass}X</span>
                              )}
                              {att.lateArrivals === 0 && att.earlyDepartures === 0 && att.walkIns === 0 && (att.wrongClass || 0) === 0 && att.totalEntries > 0 && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-green-600"><CheckCircle2 size={10} /></span>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                      <div className="print:hidden text-surface-400">
                        {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                      </div>
                    </div>
                  </div>

                  {/* Student Body (collapsible on screen, always visible in print) */}
                  <div className={isCollapsed ? 'hidden print:block' : ''}>
                    <ReportClassSections
                      classReports={sr.classReports}
                      expandedClasses={expandedClasses}
                      toggleExpand={toggleExpand}
                      studentPrefix={`s${sIdx}-`}
                      compact
                    />
                    {sr.classReports.length === 0 && (
                      <div className="px-8 py-4 text-center text-surface-400 text-xs bg-surface-50">
                        No time entries for this student in the selected date range.
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED REPORT COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function ReportHeader({ r }) {
  return (
    <div className="px-8 py-6 border-b-2 border-surface-200 print:border-b print:border-black">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-900">Attendance Report</h1>
          <p className="text-sm text-surface-500 mt-1">RICT CMMS — Maintenance Program</p>
        </div>
        <div className="text-right text-xs text-surface-400">
          <p>Generated: {new Date(r.generatedAt).toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
          })}</p>
          <p className="mt-0.5">Grace Period: {r.gracePeriod} min</p>
        </div>
      </div>
    </div>
  )
}

function StudentInfoBar({ r }) {
  return (
    <div className="px-8 pt-4">
      <div className="bg-surface-50 rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-1 print:bg-gray-100">
        <div>
          <span className="text-xs text-surface-400">Student</span>
          <p className="text-sm font-semibold text-surface-900">{r.userName}</p>
        </div>
        <div>
          <span className="text-xs text-surface-400">Role</span>
          <p className="text-sm font-medium text-surface-700">{r.userRole}</p>
        </div>
        <div>
          <span className="text-xs text-surface-400">Period</span>
          <p className="text-sm font-medium text-surface-700">
            {formatDateLong(r.startDate)} — {formatDateLong(r.endDate)}
          </p>
        </div>
        <div className="ml-auto">
          <span className="text-xs text-surface-400">Total Hours</span>
          <p className="text-lg font-bold text-brand-600">{formatHours(r.grandTotalHours)}</p>
        </div>
      </div>
    </div>
  )
}

function ReportClassSections({ classReports, expandedClasses, toggleExpand, studentPrefix = '', compact = false }) {
  return (
    <div className={compact ? '' : 'divide-y divide-surface-100'}>
      {classReports.length === 0 ? (
        <div className="px-8 py-12 text-center text-surface-400 text-sm">
          No time entries found for this date range.
        </div>
      ) : (
        classReports.map((cr, idx) => (
          <div key={cr.courseId} className={`px-8 ${compact ? 'py-4' : 'py-6'} ${idx > 0 ? 'print:break-before-auto' : ''}`}>
            {/* Class Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className={`${compact ? 'text-base' : 'text-lg'} font-bold text-surface-900`}>{cr.courseId}</h2>
                {cr.courseName && <p className="text-xs text-surface-500">{cr.courseName}</p>}
              </div>
              <div className="text-right">
                <div className={`${compact ? 'text-lg' : 'text-xl'} font-bold text-surface-900`}>
                  {formatHours(cr.totalHours)}
                  {cr.totalRequiredHours > 0 && (
                    <span className="text-xs font-normal text-surface-400 ml-1">/ {formatHours(cr.totalRequiredHours)} hrs</span>
                  )}
                </div>
                {cr.requiredHoursPerWeek > 0 && (
                  <p className="text-[10px] text-surface-400">
                    {formatHours(cr.requiredHoursPerWeek)} hrs/week × {cr.weeklyBreakdown.length} weeks
                  </p>
                )}
                {cr.totalRequiredHours > 0 && (
                  <div className="mt-1">
                    {cr.totalHours >= cr.totalRequiredHours ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full print:border print:border-green-300">
                        <CheckCircle2 size={11} /> On Track
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full print:border print:border-amber-300">
                        <AlertTriangle size={11} /> {formatHours(cr.totalRequiredHours - cr.totalHours)} hrs behind
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Progress Bar */}
            {cr.totalRequiredHours > 0 && (
              <div className="mb-4">
                <div className="h-2 bg-surface-200 rounded-full overflow-hidden print:border print:border-surface-300">
                  <div className={`h-full rounded-full transition-all ${
                    cr.totalHours >= cr.totalRequiredHours ? 'bg-green-500' : 'bg-amber-400'
                  }`} style={{ width: `${Math.min((cr.totalHours / cr.totalRequiredHours) * 100, 100)}%` }} />
                </div>
                <p className="text-[10px] text-surface-400 mt-1 text-right">
                  {Math.min(Math.round((cr.totalHours / cr.totalRequiredHours) * 100), 100)}% complete
                </p>
              </div>
            )}

            {/* Accountability Grid */}
            {cr.attendance.totalEntries > 0 && (
              <div className="mb-4">
                <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Shield size={12} /> Attendance Accountability
                </h4>
                <div className={`grid grid-cols-3 ${cr.attendance.wrongClass > 0 ? 'sm:grid-cols-7' : 'sm:grid-cols-6'} gap-2`}>
                  <ReportStatBox
                    value={`${cr.attendance.attendanceScore}%`} label="On-Time Score"
                    color={cr.attendance.attendanceScore >= 90 ? 'green' : cr.attendance.attendanceScore >= 70 ? 'amber' : 'red'}
                  />
                  <ReportStatBox value={cr.attendance.onTimeCount} label="On Time" color="green" />
                  <ReportStatBox value={cr.attendance.lateArrivals} label="Late" color="red"
                    sub={cr.attendance.totalLateMinutes > 0 ? formatMinutes(cr.attendance.totalLateMinutes) : null} />
                  <ReportStatBox value={cr.attendance.earlyDepartures} label="Left Early" color="amber"
                    sub={cr.attendance.totalEarlyMinutes > 0 ? formatMinutes(cr.attendance.totalEarlyMinutes) : null} />
                  <ReportStatBox value={cr.attendance.walkIns} label="Walk-ins" color="purple" />
                  {cr.attendance.wrongClass > 0 && (
                    <ReportStatBox value={cr.attendance.wrongClass} label="Wrong Class" color="orange" />
                  )}
                  <ReportStatBox value={cr.attendance.noShows} label="No Shows" color="red" />
                </div>
              </div>
            )}

            {/* Weekly Breakdown Table */}
            {cr.weeklyBreakdown.length > 0 && (
              <div className="mb-4">
                <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <BookOpen size={12} /> Weekly Breakdown
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-surface-50 text-left print:bg-gray-100">
                        <th className="px-2 py-2 font-semibold text-surface-500">Week</th>
                        <th className="px-2 py-2 font-semibold text-surface-500">Dates</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-right">Hours</th>
                        {cr.requiredHoursPerWeek > 0 && (
                          <th className="px-2 py-2 font-semibold text-surface-500 text-center">Req Met</th>
                        )}
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center">Lab</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center">Done</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center">On Time</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center">Late</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center">Early</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center">Walk-in</th>
                        <th className="px-2 py-2 font-semibold text-surface-500 text-center"
                          title="Per-week on-time score: starts at 100% if hours met or All Done given, otherwise scales by hours achieved; deducts 10% per Late/Early and 20% per No Show.">
                          Score
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-100">
                      {cr.weeklyBreakdown.map((wk) => {
                        const hasEntries = wk.entries.length > 0
                        const hoursBehind = wk.requiredHours > 0 && wk.hours < wk.requiredHours
                        const expandKey = `${studentPrefix}${cr.courseId}-${wk.weekNumber}`
                        const isExpanded = expandedClasses[expandKey]

                        return (
                          <React.Fragment key={wk.weekNumber}>
                            <tr className={`${
                              wk.allDone ? 'bg-emerald-50/40' :
                              hoursBehind && hasEntries ? 'bg-amber-50/40' :
                              !hasEntries ? 'bg-surface-50/50' : ''
                            } hover:bg-surface-50 cursor-pointer print:cursor-default`}
                              onClick={() => toggleExpand(expandKey)}
                            >
                              <td className="px-2 py-2 font-semibold text-surface-700">
                                <span className={wk.isFinals ? 'text-red-600' : ''}>
                                  {wk.isFinals ? 'Finals' : `W${wk.weekNumber}`}
                                </span>
                              </td>
                              <td className="px-2 py-2 text-surface-500 whitespace-nowrap">
                                {formatDateShort(wk.startDate)} – {formatDateShort(wk.endDate)}
                              </td>
                              <td className="px-2 py-2 text-right font-semibold">
                                <span className={
                                  wk.hours === 0 ? 'text-surface-300' :
                                  hoursBehind ? 'text-amber-600' : 'text-surface-900'
                                }>
                                  {formatHours(wk.hours)}
                                </span>
                                {wk.requiredHours > 0 && (
                                  <span className="text-surface-400 font-normal ml-0.5">/{formatHours(wk.requiredHours)}</span>
                                )}
                              </td>
                              {cr.requiredHoursPerWeek > 0 && (
                                <td className="px-2 py-2 text-center">
                                  {wk.metHours || wk.requiredHoursMet ? (
                                    <CheckCircle2 size={14} className="text-green-500 mx-auto" />
                                  ) : hasEntries ? (
                                    <AlertTriangle size={14} className="text-amber-500 mx-auto" />
                                  ) : <span className="text-surface-300">—</span>}
                                </td>
                              )}
                              <td className="px-2 py-2 text-center">
                                {wk.labComplete ? (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700">
                                    <CheckCircle2 size={10} /> Yes
                                  </span>
                                ) : <span className="text-surface-300 text-[10px]">—</span>}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {wk.allDone ? (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">
                                    <BadgeCheck size={10} /> Yes
                                  </span>
                                ) : <span className="text-surface-300 text-[10px]">—</span>}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {wk.attendance.onTimeCount > 0 ? (
                                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold">{wk.attendance.onTimeCount}</span>
                                ) : <span className="text-surface-300">—</span>}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {wk.attendance.lateArrivals > 0 ? (
                                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{wk.attendance.lateArrivals}</span>
                                ) : <span className="text-surface-300">—</span>}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {wk.attendance.earlyDepartures > 0 ? (
                                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">{wk.attendance.earlyDepartures}</span>
                                ) : <span className="text-surface-300">—</span>}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {wk.attendance.walkIns > 0 ? (
                                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-100 text-purple-700 text-[10px] font-bold">{wk.attendance.walkIns}</span>
                                ) : <span className="text-surface-300">—</span>}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {(() => {
                                  const sc = wk.attendance.attendanceScore
                                  if (sc === null || sc === undefined) return <span className="text-surface-300">—</span>
                                  const cls = sc >= 90 ? 'bg-green-100 text-green-700'
                                    : sc >= 70 ? 'bg-amber-100 text-amber-700'
                                    : 'bg-red-100 text-red-700'
                                  return (
                                    <span className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-bold ${cls}`}
                                      aria-label={`Week score ${sc} percent`}>
                                      {sc}%
                                    </span>
                                  )
                                })()}
                              </td>
                            </tr>

                            {/* Expanded entries */}
                            {isExpanded && wk.entries.length > 0 && (
                              <tr>
                                <td colSpan={cr.requiredHoursPerWeek > 0 ? 11 : 10} className="p-0">
                                  <div className="bg-surface-50/50 px-4 py-2">
                                    <table className="w-full text-[11px]">
                                      <thead>
                                        <tr className="text-surface-400">
                                          <th className="px-2 py-1 text-left font-medium">Date</th>
                                          <th className="px-2 py-1 text-left font-medium">Scheduled</th>
                                          <th className="px-2 py-1 text-left font-medium">Punch In</th>
                                          <th className="px-2 py-1 text-left font-medium">Punch Out</th>
                                          <th className="px-2 py-1 text-right font-medium">Hours</th>
                                          <th className="px-2 py-1 text-left font-medium">Attendance</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-surface-100">
                                        {wk.entries.map((e, eIdx) => {
                                          const f = e.flags || {}
                                          const isStillIn = e.status === 'Punched In'
                                          const isAllDone = e.entry_type === 'All Done'
                                          const isVolunteer = e.entry_type === 'Volunteer'
                                          return (
                                            <tr key={e.record_id || `we-${eIdx}`} className={
                                              f.isNoShow ? 'bg-red-50' : f.isLate ? 'bg-red-50/40' : f.isWrongClass ? 'bg-orange-50/40' : isAllDone ? 'bg-emerald-50/30' : ''
                                            }>
                                              <td className="px-2 py-1 text-surface-700">
                                                {formatDate(e.punch_in)}
                                                {isVolunteer && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">Vol</span>}
                                                {isAllDone && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">AD</span>}
                                              </td>
                                              <td className="px-2 py-1 text-surface-500">
                                                {f.scheduledStart !== null && f.scheduledStart !== undefined ? (
                                                  <span>{minutesToTimeStr(f.scheduledStart)} – {minutesToTimeStr(f.scheduledEnd)}</span>
                                                ) : f.isWalkIn ? (
                                                  <span className="text-purple-500 italic">No signup</span>
                                                ) : <span className="text-surface-300">—</span>}
                                              </td>
                                              <td className="px-2 py-1 text-surface-700">{formatTime(e.punch_in)}</td>
                                              <td className="px-2 py-1">
                                                {isStillIn ? <span className="text-green-600 font-medium">Still In</span>
                                                : f.isNoShow ? <span className="text-red-500">—</span>
                                                : <span className="text-surface-700">{formatTime(e.punch_out)}</span>}
                                              </td>
                                              <td className="px-2 py-1 text-right font-semibold text-surface-900">
                                                {f.isNoShow ? '0h' : formatHours(e.total_hours)}
                                              </td>
                                              <td className="px-2 py-1">
                                                <div className="flex flex-wrap gap-0.5">
                                                  {isAllDone ? (
                                                    <AttBadge color="emerald" icon={<CheckCircle2 size={9} />} label="All Done" />
                                                  ) : (
                                                    <>
                                                      {f.isOnTime && !f.isEarlyDeparture && <AttBadge color="green" icon={<CheckCircle2 size={9} />} label="On Time" />}
                                                      {f.isLate && <AttBadge color="red" icon={<LogIn size={9} />} label={`Late ${formatMinutes(f.lateMinutes)}`} />}
                                                      {f.isEarlyDeparture && <AttBadge color="amber" icon={<LogOut size={9} />} label={`Early ${formatMinutes(f.earlyMinutes)}`} />}
                                                      {f.isWrongClass && (
                                                        <span title={f.wrongClassExpected ? `Should have been ${f.wrongClassExpected}` : 'Wrong class punch'}
                                                          aria-label={f.wrongClassExpected ? `Wrong class — should have been ${f.wrongClassExpected}` : 'Wrong class punch'}>
                                                          <AttBadge color="orange" icon={<AlertTriangle size={9} />}
                                                            label={f.wrongClassExpected ? `Wrong Class (→ ${f.wrongClassExpected})` : 'Wrong Class'} />
                                                        </span>
                                                      )}
                                                      {f.isWalkIn && <AttBadge color="purple" icon={<Footprints size={9} />} label="Walk-in" />}
                                                      {f.isNoShow && <AttBadge color="red" icon={<X size={9} />} label="No Show" />}
                                                    </>
                                                  )}
                                                </div>
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                            {isExpanded && wk.entries.length === 0 && (
                              <tr>
                                <td colSpan={cr.requiredHoursPerWeek > 0 ? 11 : 10} className="p-0">
                                  <div className="bg-surface-50/50 px-6 py-3 text-center text-[11px] text-surface-400">
                                    No time entries this week
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-surface-50 font-semibold print:bg-gray-100">
                        <td className="px-2 py-2 text-surface-600">Totals</td>
                        <td className="px-2 py-2 text-surface-400 text-[10px]">{cr.weeklyBreakdown.length} weeks</td>
                        <td className="px-2 py-2 text-right text-surface-900">{formatHours(cr.totalHours)}</td>
                        {cr.requiredHoursPerWeek > 0 && (
                          <td className="px-2 py-2 text-center text-[10px] text-surface-500">{cr.weeksWithHours}/{cr.weeklyBreakdown.length}</td>
                        )}
                        <td className="px-2 py-2 text-center text-[10px] text-surface-500">{cr.weeksWithLab}/{cr.weeklyBreakdown.length}</td>
                        <td className="px-2 py-2 text-center text-[10px] text-surface-500">{cr.weeksDone}/{cr.weeklyBreakdown.length}</td>
                        <td colSpan={4}></td>
                        <td className="px-2 py-2 text-center">
                          {(() => {
                            const sc = cr.attendance.attendanceScore
                            if (sc === null || sc === undefined) return <span className="text-surface-300">—</span>
                            const cls = sc >= 90 ? 'bg-green-100 text-green-700'
                              : sc >= 70 ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700'
                            return (
                              <span className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-bold ${cls}`}
                                title="Average of weekly scores in this period"
                                aria-label={`Period average score ${sc} percent`}>
                                {sc}%
                              </span>
                            )
                          })()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* Summary strip */}
            {cr.weeklyBreakdown.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 text-[10px] text-surface-500 bg-surface-50 rounded-lg px-3 py-2 print:bg-gray-50">
                <span className="font-medium text-surface-600">Summary:</span>
                <span>Labs Completed: <strong className="text-blue-600">{cr.weeksWithLab}</strong> / {cr.weeklyBreakdown.length}</span>
                <span className="text-surface-300">|</span>
                <span>Hours Met: <strong className={cr.weeksWithHours === cr.weeklyBreakdown.length ? 'text-green-600' : 'text-amber-600'}>{cr.weeksWithHours}</strong> / {cr.weeklyBreakdown.length}</span>
                <span className="text-surface-300">|</span>
                <span>All Done: <strong className="text-emerald-600">{cr.weeksDone}</strong> / {cr.weeklyBreakdown.length}</span>
              </div>
            )}

            {cr.entries.length === 0 && cr.weeklyBreakdown.length === 0 && (
              <div className="text-center py-4 text-surface-400 text-xs bg-surface-50 rounded-lg">
                No time entries for this class in the selected date range.
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function ReportStatBox({ value, label, color, sub }) {
  const colors = {
    green: 'bg-green-50 border-green-200 print:border-green-300',
    red: 'bg-red-50 border-red-200 print:border-red-300',
    amber: 'bg-amber-50 border-amber-200 print:border-amber-300',
    purple: 'bg-purple-50 border-purple-200 print:border-purple-300',
    orange: 'bg-orange-50 border-orange-200 print:border-orange-300',
  }
  const textColors = {
    green: 'text-green-600', red: 'text-red-600',
    amber: 'text-amber-600', purple: 'text-purple-600',
    orange: 'text-orange-600',
  }
  const isZero = value === 0 || value === '0'
  return (
    <div className={`text-center p-2 rounded-lg border ${isZero && color !== 'green' ? 'bg-surface-50 border-surface-200' : colors[color]}`}>
      <div className={`text-lg font-bold ${isZero && color !== 'green' ? 'text-surface-400' : textColors[color]}`}>{value}</div>
      <div className="text-[9px] font-medium text-surface-500 uppercase tracking-wider">{label}</div>
      {sub && <div className={`text-[9px] ${textColors[color]} mt-0.5`}>{sub}</div>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME CARD CONTENT (with attendance analysis)
// ═══════════════════════════════════════════════════════════════════════════════

function TimeCardContent({ entries, classSummary, totalHours, attendanceSummary, pendingEdits, userName, dateRange, isInstructor, onEdit, onDelete, onRequestEdit, onPunchOut, saving }) {
  const as = attendanceSummary

  return (
    <div>
      <div className="text-center mb-6 pb-4 border-b-2 border-surface-100">
        <h3 className="text-xl font-bold text-surface-900">{userName}</h3>
        <p className="text-sm text-surface-500">{dateRange}</p>
      </div>

      {/* Accountability Summary */}
      {as.totalEntries > 0 && (
        <div className="mb-6">
          <h4 className="text-sm font-semibold text-surface-700 mb-3 flex items-center gap-2">
            <Shield size={15} className="text-brand-600" /> Attendance Accountability
            {as.gracePeriod > 0 && (
              <span className="text-[10px] font-normal text-surface-400 bg-surface-100 px-2 py-0.5 rounded-full">
                {as.gracePeriod}min grace period
              </span>
            )}
          </h4>
          <div className={`grid grid-cols-2 sm:grid-cols-3 ${as.wrongClass > 0 ? 'lg:grid-cols-7' : 'lg:grid-cols-6'} gap-3`}>
            <div className={`text-center p-3 rounded-xl border ${
              as.attendanceScore >= 90 ? 'bg-green-50 border-green-200' :
              as.attendanceScore >= 70 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'
            }`}>
              <div className={`text-2xl font-bold ${
                as.attendanceScore >= 90 ? 'text-green-600' :
                as.attendanceScore >= 70 ? 'text-amber-600' : 'text-red-600'
              }`}>{as.attendanceScore}%</div>
              <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">On-Time Score</div>
            </div>
            <div className="text-center p-3 rounded-xl bg-green-50 border border-green-200">
              <div className="text-2xl font-bold text-green-600">{as.onTimeCount}</div>
              <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">On Time</div>
            </div>
            <div className={`text-center p-3 rounded-xl border ${as.lateArrivals > 0 ? 'bg-red-50 border-red-200' : 'bg-surface-50 border-surface-200'}`}>
              <div className={`text-2xl font-bold ${as.lateArrivals > 0 ? 'text-red-600' : 'text-surface-400'}`}>{as.lateArrivals}</div>
              <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">Late</div>
              {as.totalLateMinutes > 0 && <div className="text-[10px] text-red-500 mt-0.5">{formatMinutes(as.totalLateMinutes)} total</div>}
            </div>
            <div className={`text-center p-3 rounded-xl border ${as.earlyDepartures > 0 ? 'bg-amber-50 border-amber-200' : 'bg-surface-50 border-surface-200'}`}>
              <div className={`text-2xl font-bold ${as.earlyDepartures > 0 ? 'text-amber-600' : 'text-surface-400'}`}>{as.earlyDepartures}</div>
              <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">Left Early</div>
              {as.totalEarlyMinutes > 0 && <div className="text-[10px] text-amber-500 mt-0.5">{formatMinutes(as.totalEarlyMinutes)} total</div>}
            </div>
            <div className={`text-center p-3 rounded-xl border ${as.walkIns > 0 ? 'bg-purple-50 border-purple-200' : 'bg-surface-50 border-surface-200'}`}
              title="Walk-ins (no signup that day) are neutral — they don't affect the on-time score">
              <div className={`text-2xl font-bold ${as.walkIns > 0 ? 'text-purple-600' : 'text-surface-400'}`}>{as.walkIns}</div>
              <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">Walk-ins</div>
              <div className="text-[9px] text-surface-400 mt-0.5">Neutral</div>
            </div>
            {as.wrongClass > 0 && (
              <div className="text-center p-3 rounded-xl border bg-orange-50 border-orange-200"
                title="Punched into a different class than their signup at that time — flagged but not penalized">
                <div className="text-2xl font-bold text-orange-600">{as.wrongClass}</div>
                <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">Wrong Class</div>
                <div className="text-[9px] text-surface-400 mt-0.5">Neutral</div>
              </div>
            )}
            <div className={`text-center p-3 rounded-xl border ${as.noShows > 0 ? 'bg-red-50 border-red-200' : 'bg-surface-50 border-surface-200'}`}>
              <div className={`text-2xl font-bold ${as.noShows > 0 ? 'text-red-600' : 'text-surface-400'}`}>{as.noShows}</div>
              <div className="text-[10px] font-medium text-surface-500 uppercase tracking-wider">No Shows</div>
            </div>
          </div>
        </div>
      )}

      {/* Class Summary */}
      {Object.keys(classSummary).length > 0 && (
        <div className="mb-6">
          <h4 className="text-sm font-semibold text-surface-700 mb-3">Weekly Hours by Class</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(classSummary).map(([name, data]) => {
              const pct = data.requiredHours > 0 ? (data.hours / data.requiredHours) * 100 : 100
              // Week closed by instructor (All Done swipe or required_hours_met flag) overrides
              // the "behind" state — student is signed off for the week regardless of hours.
              const weekClosed = !!(data.allDone || data.requiredHoursMet)
              const isComplete = data.requiredHours > 0 && data.hours >= data.requiredHours
              const isBehind = data.requiredHours > 0 && data.hours < data.requiredHours && !weekClosed
              const isWorkStudyTile = name === 'Work Study'
              const tileGreen = isWorkStudyTile || isComplete || weekClosed
              return (
                <div key={name} className={`p-4 rounded-xl border-l-4 ${
                  tileGreen ? 'bg-green-50 border-green-500' :
                  isBehind ? 'bg-amber-50 border-amber-400' : 'bg-surface-50 border-brand-400'
                }`}>
                  <div className="text-sm font-semibold text-surface-800">{name}</div>
                  {isWorkStudyTile && <div className="text-xs text-green-600">Work Study Hours</div>}
                  {!isWorkStudyTile && data.courseName && <div className="text-xs text-surface-500">{data.courseName}</div>}
                  <div className="text-lg font-bold text-surface-900 mt-1">
                    {formatHours(data.hours)}
                    {data.requiredHours > 0 && <span className="text-xs font-normal text-surface-500 ml-1">/ {formatHours(data.requiredHours)} hrs</span>}
                  </div>
                  {data.requiredHours > 0 && (
                    <div className="mt-2 h-1.5 bg-surface-200 rounded-full overflow-hidden" role="progressbar"
                      aria-valuenow={Math.min(Math.round(pct), 100)} aria-valuemin={0} aria-valuemax={100}
                      aria-label={`${name} progress: ${formatHours(data.hours)} of ${formatHours(data.requiredHours)} hours`}>
                      <div className={`h-full rounded-full transition-all ${
                        tileGreen ? 'bg-green-500' : isBehind ? 'bg-amber-400' : 'bg-brand-500'
                      }`} style={{ width: `${weekClosed ? 100 : Math.min(pct, 100)}%` }} />
                    </div>
                  )}
                  {weekClosed && !isComplete && (
                    <div className="flex items-center gap-1 mt-2 text-green-600 text-xs font-medium" title="Instructor swiped All Done — week closed regardless of hours">
                      <BadgeCheck size={12} /> Week Closed by Instructor
                    </div>
                  )}
                  {isComplete && !weekClosed && <div className="flex items-center gap-1 mt-2 text-green-600 text-xs font-medium"><CheckCircle2 size={12} /> Complete</div>}
                  {isComplete && weekClosed && <div className="flex items-center gap-1 mt-2 text-green-600 text-xs font-medium"><CheckCircle2 size={12} /> Complete</div>}
                  {isBehind && <div className="flex items-center gap-1 mt-2 text-amber-600 text-xs font-medium"><AlertTriangle size={12} /> {formatHours(data.requiredHours - data.hours)} hrs behind</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Total Hours */}
      <div className="flex justify-end items-center py-4 border-t-2 border-b-2 border-surface-100 mb-6">
        <span className="text-sm text-surface-600 font-medium">Total Hours:</span>
        <span className="text-2xl font-bold text-brand-600 ml-3">{formatHours(totalHours)}</span>
      </div>

      {/* Entries Table */}
      <div>
        <h4 className="text-sm font-semibold text-surface-700 mb-3 flex items-center gap-2">
          <Timer size={15} /> Time Entries ({entries.length})
        </h4>
        {entries.length === 0 ? (
          <div className="text-center py-8 text-surface-400 text-sm">No time entries found for this period.</div>
        ) : (
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 text-left">
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Date</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Class</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Scheduled</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Punch In</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Punch Out</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 text-right">Hours</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Status</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Attendance</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 w-20 print:hidden">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {entries.map((e, idx) => {
                  const f = e.flags || {}
                  const isStillIn = e.status === 'Punched In'
                  const isVolunteer = e.entry_type === 'Volunteer'
                  const isWorkStudy = e.entry_type === 'Work Study'
                  const isAllDone = e.entry_type === 'All Done'
                  const rowBg = f.isNoShow ? 'bg-red-50' :
                    f.isLate ? 'bg-red-50/40' :
                    f.isEarlyDeparture ? 'bg-amber-50/40' :
                    f.isWrongClass ? 'bg-orange-50/40' :
                    f.isWalkIn ? 'bg-purple-50/30' :
                    isAllDone ? 'bg-emerald-50/30' :
                    isWorkStudy ? '' : ''

                  return (
                    <tr key={e.record_id || `entry-${idx}`} className={`hover:bg-surface-50 ${rowBg}`}>
                      <td className="px-3 py-2.5 text-surface-700 text-xs whitespace-nowrap">{formatDate(e.punch_in)}</td>
                      <td className="px-3 py-2.5 text-surface-700">
                        <span className="font-medium">{e.course_id || e.class_id}</span>
                        {classSummary[e.course_id || e.class_id]?.courseName && (
                          <span className="block text-[10px] text-surface-400">{classSummary[e.course_id || e.class_id].courseName}</span>
                        )}
                        {isVolunteer && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">Volunteer</span>}
                        {isWorkStudy && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Work Study</span>}
                        {isAllDone && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">All Done</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-surface-500">
                        {f.scheduledStart !== null && f.scheduledStart !== undefined ? (
                          <span className="whitespace-nowrap">{minutesToTimeStr(f.scheduledStart)} – {minutesToTimeStr(f.scheduledEnd)}</span>
                        ) : f.isWalkIn ? (
                          <span className="text-purple-500 italic">No signup</span>
                        ) : <span className="text-surface-300">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-surface-700 text-xs">{formatTime(e.punch_in)}</td>
                      <td className="px-3 py-2.5 text-xs">
                        {isStillIn ? <span className="text-green-600 font-medium">Still In</span>
                        : f.isNoShow ? <span className="text-red-500 font-medium">—</span>
                        : <span className="text-surface-700">{formatTime(e.punch_out)}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-surface-900 font-semibold text-xs text-right">
                        {f.isNoShow ? '0h' : formatHours(e.total_hours)}
                      </td>
                      <td className="px-3 py-2.5"><PunchStatusBadge status={e.status} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {isWorkStudy ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-600 font-medium">Work Hours</span>
                          ) : isAllDone ? (
                            <AttBadge color="emerald" icon={<CheckCircle2 size={10} />} label="All Done" />
                          ) : (
                            <>
                              {f.isOnTime && !f.isEarlyDeparture && <AttBadge color="green" icon={<CheckCircle2 size={10} />} label="On Time" />}
                              {f.isLate && <AttBadge color="red" icon={<LogIn size={10} />} label={`Late ${formatMinutes(f.lateMinutes)}`} />}
                              {f.isEarlyDeparture && <AttBadge color="amber" icon={<LogOut size={10} />} label={`Left Early ${formatMinutes(f.earlyMinutes)}`} />}
                              {f.isWrongClass && (
                                <span title={f.wrongClassExpected ? `Signed up for ${f.wrongClassExpected} at this time — not penalized` : 'Punched into a different class than the signup — not penalized'}
                                  aria-label={f.wrongClassExpected ? `Wrong class — should have been ${f.wrongClassExpected}` : 'Wrong class punch'}>
                                  <AttBadge color="orange" icon={<AlertTriangle size={10} />}
                                    label={f.wrongClassExpected ? `Wrong Class (→ ${f.wrongClassExpected})` : 'Wrong Class'} />
                                </span>
                              )}
                              {f.isWalkIn && <AttBadge color="purple" icon={<Footprints size={10} />} label="Walk-in" />}
                              {f.isNoShow && <AttBadge color="red" icon={<X size={10} />} label="No Show" />}
                            </>
                          )}
                        </div>
                      </td>
                      {isInstructor ? (
                        <td className="px-3 py-2.5 print:hidden">
                          <div className="flex gap-0.5">
                            {e.status === 'Punched In' && (
                              <button onClick={() => onPunchOut(e)} title="Punch Out Now" disabled={saving}
                                className="p-1.5 rounded-lg text-orange-500 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"><LogOut size={13} /></button>
                            )}
                            <button onClick={() => onEdit(e)} title="Edit"
                              className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 hover:text-brand-600"><Edit3 size={13} /></button>
                            <button onClick={() => onDelete(e)} title="Delete"
                              className="p-1.5 rounded-lg text-surface-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={13} /></button>
                          </div>
                        </td>
                      ) : (
                        <td className="px-3 py-2.5 print:hidden">
                          {pendingEdits && pendingEdits[e.record_id] ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700" title={`Pending edit request: ${pendingEdits[e.record_id].reason || ''}`}>
                              <MessageCircle size={10} /> Pending
                            </span>
                          ) : (
                            <button onClick={() => onRequestEdit(e)} title="Request Edit"
                              className="p-1.5 rounded-lg text-purple-400 hover:bg-purple-50 hover:text-purple-600">
                              <FilePenLine size={13} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS WEEKLY REPORT
// ═══════════════════════════════════════════════════════════════════════════════

function ClassWeeklyContent({ students, classInfo, dateRange }) {
  const metCount = students.filter(s => s.metRequirement).length
  const totalStudents = students.length
  const totalLate = students.reduce((s, st) => s + st.lateCount, 0)
  const totalEarly = students.reduce((s, st) => s + st.earlyCount, 0)
  const totalWalkIns = students.reduce((s, st) => s + st.walkInCount, 0)

  return (
    <div>
      <div className="text-center mb-6 pb-4 border-b-2 border-surface-100">
        <h3 className="text-xl font-bold text-surface-900">{classInfo?.course_id || 'Class'} Weekly Report</h3>
        {classInfo?.course_name && <p className="text-sm text-surface-500">{classInfo.course_name}</p>}
        <p className="text-sm text-surface-500 mt-1">{dateRange}</p>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
        <div className="text-center p-3 bg-surface-50 rounded-xl"><div className="text-2xl font-bold text-surface-900">{totalStudents}</div><div className="text-[10px] text-surface-500 uppercase">Enrolled</div></div>
        <div className="text-center p-3 bg-green-50 rounded-xl"><div className="text-2xl font-bold text-green-600">{metCount}</div><div className="text-[10px] text-surface-500 uppercase">Met Hours</div></div>
        <div className="text-center p-3 bg-amber-50 rounded-xl"><div className="text-2xl font-bold text-amber-600">{totalStudents - metCount}</div><div className="text-[10px] text-surface-500 uppercase">Below Hours</div></div>
        <div className="text-center p-3 bg-red-50 rounded-xl"><div className="text-2xl font-bold text-red-600">{totalLate}</div><div className="text-[10px] text-surface-500 uppercase">Late</div></div>
        <div className="text-center p-3 bg-amber-50 rounded-xl"><div className="text-2xl font-bold text-amber-600">{totalEarly}</div><div className="text-[10px] text-surface-500 uppercase">Left Early</div></div>
        <div className="text-center p-3 bg-purple-50 rounded-xl"><div className="text-2xl font-bold text-purple-600">{totalWalkIns}</div><div className="text-[10px] text-surface-500 uppercase">Walk-ins</div></div>
      </div>

      {students.length === 0 ? (
        <div className="text-center py-8 text-surface-400 text-sm">No students enrolled in this class.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-50 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Student</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Role</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 text-right">Hours</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 text-right">Required</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500">Hours</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 text-center">Late</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 text-center">Early</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-surface-500 text-center">Walk-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-100">
              {students.map((s, idx) => (
                <tr key={s.userId || `student-${idx}`} className={`hover:bg-surface-50 ${!s.metRequirement ? 'bg-amber-50/50' : ''}`}>
                  <td className="px-3 py-2.5 font-medium text-surface-800">{s.fullName}</td>
                  <td className="px-3 py-2.5 text-surface-500 text-xs">{s.role}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-surface-900">{formatHours(s.totalHours)}</td>
                  <td className="px-3 py-2.5 text-right text-surface-500">{formatHours(s.requiredHours)}</td>
                  <td className="px-3 py-2.5">
                    {s.metRequirement ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle2 size={11} /> Complete</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full"><AlertTriangle size={11} /> Behind</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {s.lateCount > 0 ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700 text-xs font-bold">{s.lateCount}</span> : <span className="text-surface-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {s.earlyCount > 0 ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">{s.earlyCount}</span> : <span className="text-surface-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {s.walkInCount > 0 ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-xs font-bold">{s.walkInCount}</span> : <span className="text-surface-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD / REQUEST / EDIT / DELETE MODALS
// ═══════════════════════════════════════════════════════════════════════════════

function AddEntryModal({ userId, classes, actions, onClose, onSaved }) {
  const [form, setForm] = useState({ classId: '', courseName: '', date: toDateStr(new Date()), punchIn: '08:00', punchOut: '16:00' })
  const handleClassChange = (e) => { const cn = e.target.value; const cls = classes.find(c => c.course_id === cn); setForm(f => ({ ...f, courseName: cn, classId: cls?.class_id || cn })) }
  // Construct timestamps with Z suffix so they're stored as UTC (local-as-UTC convention)
  const handleSave = async () => { if (!form.courseName) return; const res = await actions.addEntry(userId, form.classId, form.courseName, `${form.date}T${form.punchIn}:00Z`, `${form.date}T${form.punchOut}:00Z`); if (res?.success) onSaved() }
  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <h3 className="font-semibold text-surface-900">Add Time Entry</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <Field label="Class *"><select value={form.courseName} onChange={handleClassChange} className="input text-sm"><option value="">Select class…</option>{classes.map(c => <option key={c.class_id} value={c.course_id}>{c.course_id}{c.course_name ? ` — ${c.course_name}` : ''}</option>)}</select></Field>
          <Field label="Date *"><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input text-sm" /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Punch In *"><input type="time" value={form.punchIn} onChange={e => setForm(f => ({ ...f, punchIn: e.target.value }))} className="input text-sm" /></Field>
            <Field label="Punch Out *"><input type="time" value={form.punchOut} onChange={e => setForm(f => ({ ...f, punchOut: e.target.value }))} className="input text-sm" /></Field>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">Cancel</button>
          <button onClick={handleSave} disabled={actions.saving || !form.courseName} className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 flex items-center gap-1.5">{actions.saving && <Loader2 size={14} className="animate-spin" />} Add Entry</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function RequestEntryModal({ classes, actions, profile, onClose, onSubmitted }) {
  const [form, setForm] = useState({ classId: '', courseName: '', date: toDateStr(new Date()), startTime: '08:00', endTime: '16:00', reason: '' })
  const enrolledClasses = useMemo(() => { if (!profile?.classes) return classes; const enrolled = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean); if (enrolled.length === 0) return classes; return classes.filter(c => enrolled.includes(c.class_id) || enrolled.includes(c.course_id)) }, [classes, profile?.classes])
  const handleClassChange = (e) => { const cn = e.target.value; const cls = classes.find(c => c.course_id === cn); setForm(f => ({ ...f, courseName: cn, classId: cls?.class_id || cn })) }
  const previewHours = useMemo(() => { if (!form.startTime || !form.endTime) return 0; const pi = new Date(`2000-01-01T${form.startTime}:00`); const po = new Date(`2000-01-01T${form.endTime}:00`); const hrs = (po - pi) / 3600000; return hrs > 0 ? Math.round(hrs * 60) / 60 : 0 }, [form.startTime, form.endTime])
  const handleSubmit = async () => { if (!form.courseName || !form.reason.trim()) return; const res = await actions.submitTimeRequest(form.classId, form.courseName, form.date, form.startTime, form.endTime, form.reason); if (res?.success) onSubmitted() }
  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div><h3 className="font-semibold text-surface-900">Request Time Entry</h3><p className="text-xs text-surface-400 mt-0.5">Requires instructor approval</p></div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <Field label="Class *"><select value={form.courseName} onChange={handleClassChange} className="input text-sm"><option value="">Select class…</option>{enrolledClasses.map(c => <option key={c.class_id} value={c.course_id}>{c.course_id}{c.course_name ? ` — ${c.course_name}` : ''}</option>)}</select></Field>
          <Field label="Date *"><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input text-sm" /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start Time *"><input type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} className="input text-sm" /></Field>
            <Field label="End Time *"><input type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} className="input text-sm" /></Field>
          </div>
          {previewHours > 0 && <div className="flex items-center gap-2 text-sm text-surface-600 bg-surface-50 rounded-lg px-3 py-2"><Clock size={14} className="text-brand-500" /> <span className="font-medium">{previewHours} hours</span></div>}
          <Field label="Reason *"><textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Why are you requesting this manual entry?" rows={3} className="input text-sm resize-none" /></Field>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">Cancel</button>
          <button onClick={handleSubmit} disabled={actions.saving || !form.courseName || !form.reason.trim()} className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 flex items-center gap-1.5">{actions.saving && <Loader2 size={14} className="animate-spin" />} <Send size={14} /> Submit Request</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function RequestEditModal({ entry, actions, profile, classes, onClose, onSubmitted }) {
  const piDate = entry.punch_in ? new Date(entry.punch_in) : new Date()
  const poDate = entry.punch_out ? new Date(entry.punch_out) : null
  const isStillIn = !poDate  // student is currently punched in

  // Use UTC components (local-as-UTC convention)
  const currentPunchIn = `${String(piDate.getUTCHours()).padStart(2,'0')}:${String(piDate.getUTCMinutes()).padStart(2,'0')}`
  const currentPunchOut = poDate ? `${String(poDate.getUTCHours()).padStart(2,'0')}:${String(poDate.getUTCMinutes()).padStart(2,'0')}` : ''

  const [form, setForm] = useState({
    startTime: currentPunchIn,
    endTime: currentPunchOut,
    reason: ''
  })

  const previewHours = useMemo(() => {
    if (!form.startTime || !form.endTime) return 0
    const pi = new Date(`2000-01-01T${form.startTime}:00`)
    const po = new Date(`2000-01-01T${form.endTime}:00`)
    const hrs = (po - pi) / 3600000
    return hrs > 0 ? Math.round(hrs * 60) / 60 : 0
  }, [form.startTime, form.endTime])

  const currentHoursRaw = entry.total_hours ? Math.round(Number(entry.total_hours) * 60) / 60 : 0
  const currentHoursDisplay = formatHours(currentHoursRaw)

  // When still punched in, only the punch-in time matters for change detection
  const hasChanges = isStillIn
    ? form.startTime !== currentPunchIn
    : form.startTime !== currentPunchIn || form.endTime !== currentPunchOut

  const handleSubmit = async () => {
    if (!form.reason.trim()) return
    if (!hasChanges) return
    // Pass empty string for endTime when still punched in — hook handles it
    const res = await actions.submitEditRequest(entry, form.startTime, isStillIn ? '' : form.endTime, form.reason)
    if (res?.success) onSubmitted()
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-surface-900 flex items-center gap-2">
              <FilePenLine size={16} className="text-purple-500" /> Request Time Edit
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">An instructor will review your changes</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {/* Current Entry Info */}
          <div className="bg-surface-50 rounded-lg px-3 py-3 space-y-1">
            <div className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider mb-1">Current Entry</div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-surface-600"><strong>Date:</strong> {formatDate(entry.punch_in)}</span>
              <span className="text-surface-600"><strong>Class:</strong> {entry.course_id || entry.class_id}{(() => { const cn = (classes || []).find(c => c.course_id === (entry.course_id || entry.class_id))?.course_name; return cn ? ` (${cn})` : '' })()}</span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-surface-600"><strong>In:</strong> {formatTime(entry.punch_in)}</span>
              <span className="text-surface-600"><strong>Out:</strong> {poDate ? formatTime(entry.punch_out) : 'Still In'}</span>
              <span className="text-surface-600"><strong>Hours:</strong> {currentHoursDisplay}</span>
            </div>
            <div className="text-[10px] text-surface-400 mt-1">Record: {entry.record_id}</div>
          </div>

          {/* Still-punched-in notice */}
          {isStillIn && (
            <div className="flex items-start gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              <LogIn size={13} className="mt-0.5 shrink-0 text-blue-500" />
              <span>You're currently punched in. Only your punch-in time can be corrected right now — punch-out will be recorded when you leave.</span>
            </div>
          )}

          {/* Proposed Changes */}
          <div className="border border-purple-200 rounded-lg px-3 py-3 bg-purple-50/30">
            <div className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-2">Proposed Changes</div>
            {isStillIn ? (
              <Field label="New Punch In *">
                <input type="time" value={form.startTime}
                  onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                  className={`input text-sm ${form.startTime !== currentPunchIn ? 'ring-2 ring-purple-300 border-purple-400' : ''}`} />
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="New Punch In *">
                  <input type="time" value={form.startTime}
                    onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                    className={`input text-sm ${form.startTime !== currentPunchIn ? 'ring-2 ring-purple-300 border-purple-400' : ''}`} />
                </Field>
                <Field label="New Punch Out *">
                  <input type="time" value={form.endTime}
                    onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                    className={`input text-sm ${form.endTime !== currentPunchOut ? 'ring-2 ring-purple-300 border-purple-400' : ''}`} />
                </Field>
              </div>
            )}
            {previewHours > 0 && hasChanges && !isStillIn && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <Clock size={14} className="text-purple-500" />
                <span className="text-surface-500">{currentHoursDisplay}</span>
                <span className="text-purple-500 font-medium">→</span>
                <span className="font-medium text-purple-700">{formatHours(previewHours)}</span>
                {previewHours > currentHoursRaw && (
                  <span className="text-[10px] text-green-600 font-medium bg-green-100 px-1.5 py-0.5 rounded-full">
                    +{formatHours(previewHours - currentHoursRaw)}
                  </span>
                )}
                {previewHours < currentHoursRaw && (
                  <span className="text-[10px] text-red-600 font-medium bg-red-100 px-1.5 py-0.5 rounded-full">
                    -{formatHours(currentHoursRaw - previewHours)}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Reason */}
          <Field label="Reason *">
            <textarea value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. I forgot to punch in when I arrived at 8:00 AM"
              rows={3} className="input text-sm resize-none" />
          </Field>

          {!hasChanges && (
            <div className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertTriangle size={12} /> Change at least one time to submit a request
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">Cancel</button>
          <button onClick={handleSubmit}
            disabled={actions.saving || !form.reason.trim() || !hasChanges}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 flex items-center gap-1.5">
            {actions.saving && <Loader2 size={14} className="animate-spin" />}
            <Send size={14} /> Submit Request
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function EditEntryModal({ entry, classes, actions, onClose, onSaved }) {
  const piDate = entry.punch_in ? new Date(entry.punch_in) : new Date()
  const poDate = entry.punch_out ? new Date(entry.punch_out) : null
  // Use UTC components for local-as-UTC convention
  const piTimeStr = `${String(piDate.getUTCHours()).padStart(2,'0')}:${String(piDate.getUTCMinutes()).padStart(2,'0')}`
  const poTimeStr = poDate ? `${String(poDate.getUTCHours()).padStart(2,'0')}:${String(poDate.getUTCMinutes()).padStart(2,'0')}` : ''
  const piDateStr = `${piDate.getUTCFullYear()}-${String(piDate.getUTCMonth()+1).padStart(2,'0')}-${String(piDate.getUTCDate()).padStart(2,'0')}`
  const [form, setForm] = useState({ date: piDateStr, punchIn: piTimeStr, punchOut: poTimeStr, classId: entry.class_id || '', courseName: entry.course_id || '' })
  // Construct timestamps with Z suffix so they're stored as UTC (matching local-as-UTC convention)
  const handleSave = async () => { const piStr = `${form.date}T${form.punchIn}:00Z`; const poStr = form.punchOut ? `${form.date}T${form.punchOut}:00Z` : null; const res = await actions.updateEntry(entry.record_id, { punch_in: piStr, punch_out: poStr, class_id: form.classId, course_id: form.courseName }); if (res?.success) onSaved() }
  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <h3 className="font-semibold text-surface-900">Edit Time Entry</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-100 text-surface-400"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <Field label="Class"><select value={form.courseName} onChange={e => { const cn = e.target.value; const cls = classes.find(c => c.course_id === cn); setForm(f => ({ ...f, courseName: cn, classId: cls?.class_id || cn })) }} className="input text-sm"><option value="">Select class…</option>{classes.map(c => <option key={c.class_id} value={c.course_id}>{c.course_id}{c.course_name ? ` — ${c.course_name}` : ''}{c.status !== 'Active' ? ' (Inactive)' : ''}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input text-sm" /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Punch In"><input type="time" value={form.punchIn} onChange={e => setForm(f => ({ ...f, punchIn: e.target.value }))} className="input text-sm" /></Field>
            <Field label="Punch Out"><input type="time" value={form.punchOut} onChange={e => setForm(f => ({ ...f, punchOut: e.target.value }))} className="input text-sm" /></Field>
          </div>
          <p className="text-xs text-surface-400">Record ID: {entry.record_id}</p>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">Cancel</button>
          <button onClick={handleSave} disabled={actions.saving} className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 flex items-center gap-1.5">{actions.saving && <Loader2 size={14} className="animate-spin" />} Save Changes</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function ConfirmDeleteModal({ entry, saving, classes, onConfirm, onCancel }) {
  const classId = entry.course_id || entry.class_id
  const classConfig = (classes || []).find(c => c.course_id === classId || c.class_id === classId)
  const className = classConfig?.course_name || ''
  return (
    <ModalOverlay onClose={onCancel} zIndex="z-[60]">
      <div className="bg-white rounded-xl w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100"><h3 className="font-semibold text-surface-900">Delete Time Entry</h3></div>
        <div className="px-5 py-4 text-center">
          <p className="text-sm text-surface-600">Delete entry for <strong>{classId}</strong>{className && <span className="text-xs text-surface-400"> ({className})</span>} on {formatDate(entry.punch_in)}?</p>
          <p className="text-xs text-surface-400 mt-1">This cannot be undone.</p>
        </div>
        <div className="px-5 py-3 border-t border-surface-100 flex justify-center gap-3">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 border border-surface-200">Cancel</button>
          <button onClick={onConfirm} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 flex items-center gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />} Delete</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function ModalOverlay({ children, onClose, zIndex = 'z-50' }) {
  return <div className={`fixed inset-0 bg-black/40 ${zIndex} flex items-center justify-center p-4`} onClick={onClose}>{children}</div>
}

function Field({ label, children }) {
  return <div><label className="block text-xs font-medium text-surface-600 mb-1">{label}</label>{children}</div>
}

function TabBtn({ active, icon, label, onClick }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      active ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-surface-600 border border-surface-200 hover:bg-surface-50'
    }`}>{icon} {label}</button>
  )
}

function PunchStatusBadge({ status }) {
  const styles = { 'Punched In': 'bg-green-100 text-green-700', 'Punched Out': 'bg-blue-100 text-blue-700', 'No Show': 'bg-red-100 text-red-700', 'Complete': 'bg-blue-100 text-blue-700' }
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${styles[status] || 'bg-surface-100 text-surface-600'}`}>{status}</span>
}

function AttBadge({ color, icon, label }) {
  const styles = { green: 'bg-green-100 text-green-700', red: 'bg-red-100 text-red-700', amber: 'bg-amber-100 text-amber-700', purple: 'bg-purple-100 text-purple-700', emerald: 'bg-emerald-100 text-emerald-700', orange: 'bg-orange-100 text-orange-700' }
  return <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${styles[color]}`}>{icon} {label}</span>
}
