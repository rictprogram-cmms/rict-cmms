import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ═══════════════════════════════════════════════════════════════════════════════
// SCHOOL DAY CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** Get Nth weekday occurrence in a month (e.g., 3rd Monday of January) */
function getNthWeekday(year, month, weekday, n) {
  const date = new Date(year, month, 1)
  let count = 0
  while (date.getMonth() === month) {
    if (date.getDay() === weekday) {
      count++
      if (count === n) return new Date(date)
    }
    date.setDate(date.getDate() + 1)
  }
  return null
}

/** Get last weekday occurrence in a month */
function getLastWeekday(year, month, weekday) {
  const date = new Date(year, month + 1, 0) // last day of month
  while (date.getDay() !== weekday) date.setDate(date.getDate() - 1)
  return date
}

/** Get US federal holidays for a given year */
function getUSHolidays(year) {
  const thanksgiving = getNthWeekday(year, 10, 4, 4) // 4th Thursday of Nov
  const dayAfter = new Date(thanksgiving)
  dayAfter.setDate(dayAfter.getDate() + 1)

  return [
    new Date(year, 0, 1),                    // New Year's Day
    getNthWeekday(year, 0, 1, 3),            // MLK Jr. Day
    getNthWeekday(year, 1, 1, 3),            // Presidents' Day
    getLastWeekday(year, 4, 1),              // Memorial Day
    new Date(year, 6, 4),                    // Independence Day
    getNthWeekday(year, 8, 1, 1),            // Labor Day
    getNthWeekday(year, 9, 1, 2),            // Columbus Day
    new Date(year, 10, 11),                  // Veterans Day
    thanksgiving,                             // Thanksgiving
    dayAfter,                                 // Day after Thanksgiving
    new Date(year, 11, 24),                  // Christmas Eve
    new Date(year, 11, 25),                  // Christmas Day
    new Date(year, 11, 31),                  // New Year's Eve
  ]
}

/** Normalize a date to midnight for comparison */
function toDateOnly(d) {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

/**
 * Safely parse a due_date value (string or Date) as local midnight.
 * new Date('YYYY-MM-DD') parses as UTC midnight which shifts the date
 * backward in CST/CDT — always append T00:00:00 for date-only strings.
 */
function parseDueDateLocal(d) {
  if (!d) return null
  if (typeof d === 'string') {
    const part = d.substring(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(part)) return new Date(part + 'T00:00:00')
  }
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

/** Format date as YYYY-MM-DD */
function toDateStr(d) {
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/**
 * Check if a date is a school day (Mon-Thu, not a holiday, not a custom closed day)
 */
function isSchoolDay(date, holidays, closedDays) {
  const dow = date.getDay()
  // Only Mon(1)-Thu(4) are school days
  if (dow === 0 || dow === 5 || dow === 6) return false

  const dateMs = toDateOnly(date).getTime()

  // Check US holidays
  for (const h of holidays) {
    if (toDateOnly(h).getTime() === dateMs) return false
  }

  // Check custom closed days
  for (const c of closedDays) {
    if (toDateOnly(c).getTime() === dateMs) return false
  }

  return true
}

/**
 * Count school days between two dates.
 * startDate is exclusive (counting starts day after), endDate is inclusive.
 */
function countSchoolDays(startDate, endDate, holidays, closedDays) {
  if (!startDate || !endDate) return 0

  const start = toDateOnly(startDate)
  const end = toDateOnly(endDate)
  if (end <= start) return 0

  let count = 0
  const current = new Date(start)
  current.setDate(current.getDate() + 1) // start counting from day after

  while (current <= end) {
    if (isSchoolDay(current, holidays, closedDays)) count++
    current.setDate(current.getDate() + 1)
  }

  return count
}

/**
 * Build holiday list covering the years in the data range
 */
function buildHolidayList(dates) {
  const years = new Set()
  const now = new Date()
  years.add(now.getFullYear())

  for (const d of dates) {
    if (d instanceof Date && !isNaN(d)) years.add(d.getFullYear())
    else if (typeof d === 'string') {
      const dt = new Date(d)
      if (!isNaN(dt)) years.add(dt.getFullYear())
    }
  }

  let holidays = []
  for (const y of years) holidays = holidays.concat(getUSHolidays(y))
  return holidays
}

/**
 * Parse custom closed days from settings value (comma-separated YYYY-MM-DD)
 */
function parseClosedDays(settingValue) {
  if (!settingValue) return []
  return settingValue
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => new Date(s + 'T00:00:00'))
    .filter(d => !isNaN(d.getTime()))
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate a single user's WOC score.
 *
 * Multi-assignment support: assignmentsMap is a Map<wo_id, Set<email>> built
 * from the work_order_assignments junction table. A user is considered
 * "assigned" to a WO if their email appears in this set OR in assigned_email
 * (backward compat for WOs created before multi-assignment was added).
 *
 * @param {string} userEmail - The user's email
 * @param {Array} openWOs - All open work orders
 * @param {Array} closedWOs - Closed work orders
 * @param {Array} holidays - Pre-built holiday list
 * @param {Array} closedDays - Custom closed days
 * @param {Map} assignmentsMap - Map<wo_id, Set<email>> from work_order_assignments
 * @param {Date|null} rangeStart - Optional start of evaluation period
 * @param {Date|null} rangeEnd - Optional end of evaluation period
 * @returns {object} Score breakdown
 */
function calculateScore(userEmail, openWOs, closedWOs, holidays, closedDays, assignmentsMap, rangeStart = null, rangeEnd = null) {
  const today = toDateOnly(new Date())
  // The effective "end" for counting late days: either end of date range or today
  const effectiveEnd = rangeEnd ? (rangeEnd < today ? rangeEnd : today) : today
  const emailLower = (userEmail || '').toLowerCase().trim()
  const details = []

  let assignedLateDays = 0
  let teamLateDays = 0
  let staleDays = 0
  let earlyDays = 0

  /**
   * Determine if this user is assigned to a WO.
   * Checks the multi-assignment junction table first (assignmentsMap),
   * then falls back to the legacy single assigned_email / assigned_to fields.
   * Option A: all assignees get the full personal penalty/bonus — no splitting.
   */
  const isAssignedToUser = (woId, assignedEmail, assignedTo) => {
    // Check junction table
    const emailSet = assignmentsMap.get(woId)
    if (emailSet && emailSet.size > 0) {
      return emailSet.has(emailLower)
    }
    // Fallback: legacy single-user fields
    const ae = (assignedEmail || '').toLowerCase().trim()
    const at = (assignedTo || '').toLowerCase().trim()
    return ae === emailLower || at.includes(emailLower.split('@')[0])
  }

  // ── 1. Open WO penalties ──────────────────────────────────────────────────
  for (const wo of openWOs) {
    const woId = wo.wo_id || ''
    const desc = (wo.description || '').substring(0, 40)
    const dueDate = parseDueDateLocal(wo.due_date)
    const createdDate = wo.created_at ? toDateOnly(new Date(wo.created_at)) : null
    const updatedDate = wo.updated_at ? toDateOnly(new Date(wo.updated_at)) : null
    const assignedToUser = isAssignedToUser(woId, wo.assigned_email, wo.assigned_to)

    // Skip open WOs created after the range end (not relevant to this period)
    if (rangeStart && createdDate && createdDate > effectiveEnd) continue

    // Late WO penalty (past due date) — only after the due date has passed, not on the day itself
    if (dueDate && dueDate < effectiveEnd) {
      // Count late days only within the evaluation range
      const lateCountStart = rangeStart && rangeStart > dueDate ? rangeStart : dueDate
      const lateDayCount = countSchoolDays(lateCountStart, effectiveEnd, holidays, closedDays)
      if (lateDayCount > 0) {
        // Team penalty: everyone gets -1% per school day
        teamLateDays += lateDayCount
        details.push({
          type: 'team_late',
          woId, description: desc, days: lateDayCount,
          deduction: lateDayCount,
          source: 'open'
        })

        // Personal penalty: assigned user(s) get additional -2% per school day
        if (assignedToUser) {
          assignedLateDays += lateDayCount
          details.push({
            type: 'personal_late',
            woId, description: desc, days: lateDayCount,
            deduction: lateDayCount * 2,
            source: 'open'
          })
        }
      }
    }

    // Stale WO penalty (no update in >4 school days) — only applies to open WOs
    const referenceDate = updatedDate && updatedDate > createdDate ? updatedDate : createdDate
    if (referenceDate && assignedToUser) {
      const staleEnd = effectiveEnd
      const totalSchoolDaysSinceUpdate = countSchoolDays(referenceDate, staleEnd, holidays, closedDays)
      if (totalSchoolDaysSinceUpdate > 4) {
        const daysOverThreshold = totalSchoolDaysSinceUpdate - 4
        staleDays += daysOverThreshold
        details.push({
          type: 'stale',
          woId, description: desc, days: daysOverThreshold,
          deduction: daysOverThreshold,
          daysSinceUpdate: totalSchoolDaysSinceUpdate,
          source: 'open'
        })
      }
    }
  }

  // ── 2. Closed WO penalties AND rewards ────────────────────────────────────
  for (const wo of closedWOs) {
    const woId = wo.wo_id || ''
    const desc = (wo.description || '').substring(0, 40)
    const assignedToUser = isAssignedToUser(woId, wo.assigned_email, wo.assigned_to)
    const dueDate = parseDueDateLocal(wo.due_date)
    const closedDate = wo.closed_date
      ? toDateOnly(new Date(wo.closed_date))
      : wo.updated_at
        ? toDateOnly(new Date(wo.updated_at))
        : null
    const createdDate = wo.created_at ? toDateOnly(new Date(wo.created_at)) : null

    // Skip closed WOs outside the evaluation range
    if (rangeStart && closedDate && closedDate < rangeStart) continue
    if (rangeEnd && createdDate && createdDate > rangeEnd) continue

    // ── 2a. LATE CLOSE PENALTY — WO was closed AFTER its due date ─────────
    // Closing a late WO does not erase the penalty.
    // The late days are counted from due_date to closed_date (capped by range).
    if (dueDate && closedDate && closedDate > dueDate) {
      const lateStart = rangeStart && rangeStart > dueDate ? rangeStart : dueDate
      const lateEnd = rangeEnd && rangeEnd < closedDate ? rangeEnd : closedDate
      const lateDayCount = countSchoolDays(lateStart, lateEnd, holidays, closedDays)

      if (lateDayCount > 0) {
        // Team penalty: everyone gets -1% per school day for WOs that were late
        teamLateDays += lateDayCount
        details.push({
          type: 'team_late',
          woId, description: desc + ' (closed late)', days: lateDayCount,
          deduction: lateDayCount,
          source: 'closed'
        })

        // Personal penalty: assigned user(s) get additional -2% per school day
        if (assignedToUser) {
          assignedLateDays += lateDayCount
          details.push({
            type: 'personal_late',
            woId, description: desc + ' (closed late)', days: lateDayCount,
            deduction: lateDayCount * 2,
            source: 'closed'
          })
        }
      }
    }

    // ── 2b. EARLY COMPLETION BONUS — WO was closed BEFORE its due date ────
    if (!assignedToUser) continue

    if (dueDate && closedDate && closedDate < dueDate) {
      const daysEarly = countSchoolDays(closedDate, dueDate, holidays, closedDays)
      if (daysEarly > 0) {
        earlyDays += daysEarly
        details.push({
          type: 'early_completion',
          woId,
          description: desc,
          days: daysEarly,
          reward: daysEarly,
          source: 'closed'
        })
      }
    }
  }

  // ── 3. Calculate final score ──────────────────────────────────────────────
  const personalDeduction = (assignedLateDays * 2) + staleDays
  const teamDeduction = teamLateDays
  const totalDeduction = personalDeduction + teamDeduction
  const totalReward = earlyDays // +1% per school day early
  const rawScore = 100 - totalDeduction + totalReward
  const score = Math.min(100, Math.max(0, rawScore))

  return {
    score,
    assignedLateDays,
    teamLateDays,
    staleDays,
    earlyDays,
    personalDeduction,
    teamDeduction,
    totalDeduction,
    totalReward,
    details
  }
}

/**
 * Calculate average completion time for a user's closed WOs.
 * Updated to use assignmentsMap for multi-assignment support.
 */
function calcCompletionTime(email, closedWOs, holidays, closedDays, assignmentsMap, rangeStart = null, rangeEnd = null) {
  const emailLower = (email || '').toLowerCase().trim()
  let totalDays = 0
  let count = 0

  for (const wo of closedWOs) {
    // Check junction table first, then fallback
    const emailSet = assignmentsMap.get(wo.wo_id)
    let isUser
    if (emailSet && emailSet.size > 0) {
      isUser = emailSet.has(emailLower)
    } else {
      const ae = (wo.assigned_email || '').toLowerCase().trim()
      const at = (wo.assigned_to || '').toLowerCase().trim()
      isUser = ae === emailLower || at.includes(emailLower.split('@')[0])
    }
    if (!isUser) continue

    const created = wo.created_at ? new Date(wo.created_at) : null
    const closed = wo.closed_date ? new Date(wo.closed_date) : wo.updated_at ? new Date(wo.updated_at) : null
    if (!created || !closed) continue

    // Filter by date range if provided
    const closedOnly = toDateOnly(closed)
    if (rangeStart && closedOnly < rangeStart) continue
    if (rangeEnd && closedOnly > rangeEnd) continue

    const days = countSchoolDays(created, closed, holidays, closedDays)
    totalDays += days
    count++
  }

  return {
    avgDays: count > 0 ? Math.round((totalDays / count) * 10) / 10 : 0,
    totalCompleted: count
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main hook — fetches WO data + settings + assignments, calculates all scores.
 * @param {Object} options
 * @param {boolean} options.canViewAll — if true, populates allScores for the team view
 * @param {string|null} options.startDate — YYYY-MM-DD start of evaluation range
 * @param {string|null} options.endDate — YYYY-MM-DD end of evaluation range
 */
export function useWOCRatio({ canViewAll = false, startDate = null, endDate = null } = {}) {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(true)
  const [myScore, setMyScore] = useState(null)
  const [allScores, setAllScores] = useState([])
  const [teamStats, setTeamStats] = useState({ openCount: 0, lateCount: 0, totalLateDays: 0 })
  const [teamCompletion, setTeamCompletion] = useState({ avgDays: 0, totalCompleted: 0 })
  const [closedDaysList, setClosedDaysList] = useState([])
  const [holidaysList, setHolidaysList] = useState([])
  const hasLoadedRef = useRef(false)

  const fetchData = useCallback(async () => {
    if (!profile) return
    if (!hasLoadedRef.current) setLoading(true)

    try {
      // Parse date range
      const rangeStart = startDate ? toDateOnly(new Date(startDate + 'T00:00:00')) : null
      const rangeEnd = endDate ? toDateOnly(new Date(endDate + 'T00:00:00')) : null

      // Parallel fetches — always fetch profiles so we can compute rank for everyone.
      // Also fetch work_order_assignments for multi-user assignment support.
      const [openRes, closedRes, closedArchiveRes, settingsRes, profilesRes, assignmentsRes] = await Promise.all([
        supabase.from('work_orders').select('*').neq('status', 'Closed'),
        supabase.from('work_orders').select('*').eq('status', 'Closed'),
        supabase.from('work_orders_closed').select('*'),
        supabase.from('settings').select('setting_key, setting_value')
          .eq('setting_key', 'custom_closed_days').maybeSingle(),
        // Always fetch profiles to compute rank for the current user
        supabase.from('profiles').select('*').in('status', ['Active', 'active'])
          .not('time_clock_only', 'eq', 'Yes'),
        // Multi-assignment junction table
        supabase.from('work_order_assignments').select('wo_id, user_email')
      ])

      const openWOs = openRes.data || []
      // Merge closed WOs from both tables, dedup by wo_id
      const closedFromMain = closedRes.data || []
      const closedFromArchive = closedArchiveRes.data || []
      const closedMap = new Map()
      for (const wo of closedFromMain) closedMap.set(wo.wo_id, wo)
      for (const wo of closedFromArchive) {
        if (!closedMap.has(wo.wo_id)) closedMap.set(wo.wo_id, wo)
      }
      const closedWOs = Array.from(closedMap.values())
      const closedDays = parseClosedDays(settingsRes.data?.setting_value)
      setClosedDaysList(closedDays)

      // Build assignmentsMap: Map<wo_id, Set<lowercase_email>>
      // This is the source of truth for who is assigned to each WO.
      // For WOs with no entries in this table, calculateScore falls back to assigned_email.
      const assignmentsMap = new Map()
      for (const a of (assignmentsRes.data || [])) {
        const woId = a.wo_id
        const emailLower = (a.user_email || '').toLowerCase().trim()
        if (!assignmentsMap.has(woId)) assignmentsMap.set(woId, new Set())
        assignmentsMap.get(woId).add(emailLower)
      }

      // Build holiday list from all WO dates
      const allDates = [
        ...openWOs.map(w => w.created_at),
        ...openWOs.map(w => w.due_date),
        ...closedWOs.map(w => w.created_at),
        ...closedWOs.map(w => w.closed_date),
        startDate, endDate
      ].filter(Boolean)
      const holidays = buildHolidayList(allDates)
      setHolidaysList(holidays)

      // ── My score ──
      const myResult = calculateScore(profile.email, openWOs, closedWOs, holidays, closedDays, assignmentsMap, rangeStart, rangeEnd)
      const myCompletion = calcCompletionTime(profile.email, closedWOs, holidays, closedDays, assignmentsMap, rangeStart, rangeEnd)

      // Count user's open WOs
      const emailLower = profile.email.toLowerCase().trim()
      const today = toDateOnly(new Date())
      const effectiveEnd = rangeEnd ? (rangeEnd < today ? rangeEnd : today) : today
      let myOpenCount = 0
      let myTotalDaysOpen = 0

      for (const wo of openWOs) {
        // Use assignmentsMap first, fallback to assigned_email
        const emailSet = assignmentsMap.get(wo.wo_id)
        let isMe
        if (emailSet && emailSet.size > 0) {
          isMe = emailSet.has(emailLower)
        } else {
          const ae = (wo.assigned_email || '').toLowerCase().trim()
          const at = (wo.assigned_to || '').toLowerCase().trim()
          isMe = ae === emailLower || at.includes(emailLower.split('@')[0])
        }
        if (!isMe) continue

        const createdDate = wo.created_at ? toDateOnly(new Date(wo.created_at)) : null
        if (rangeEnd && createdDate && createdDate > rangeEnd) continue
        myOpenCount++
        if (wo.created_at) {
          myTotalDaysOpen += countSchoolDays(new Date(wo.created_at), effectiveEnd, holidays, closedDays)
        }
      }

      // ── Always compute all user scores for ranking ──
      const rankedUsers = []
      if (profilesRes.data) {
        const users = profilesRes.data.filter(u =>
          u.role === 'Student' || u.role === 'Work Study'
        )

        for (const u of users) {
          const result = calculateScore(u.email, openWOs, closedWOs, holidays, closedDays, assignmentsMap, rangeStart, rangeEnd)
          const completion = calcCompletionTime(u.email, closedWOs, holidays, closedDays, assignmentsMap, rangeStart, rangeEnd)

          // Count open WOs for this user
          const ue = (u.email || '').toLowerCase().trim()
          let userOpenCount = 0
          let userTotalDaysOpen = 0
          for (const wo of openWOs) {
            const emailSet = assignmentsMap.get(wo.wo_id)
            let isUser
            if (emailSet && emailSet.size > 0) {
              isUser = emailSet.has(ue)
            } else {
              const ae = (wo.assigned_email || '').toLowerCase().trim()
              const at = (wo.assigned_to || '').toLowerCase().trim()
              isUser = ae === ue || at.includes(ue.split('@')[0])
            }
            if (!isUser) continue
            const createdDate = wo.created_at ? toDateOnly(new Date(wo.created_at)) : null
            if (rangeEnd && createdDate && createdDate > rangeEnd) continue
            userOpenCount++
            if (wo.created_at) {
              userTotalDaysOpen += countSchoolDays(new Date(wo.created_at), effectiveEnd, holidays, closedDays)
            }
          }

          rankedUsers.push({
            userId: u.id,
            name: `${u.first_name || ''} ${(u.last_name || '').charAt(0)}.`.trim(),
            fullName: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
            email: u.email,
            role: u.role,
            ...result,
            avgCompletionDays: completion.avgDays,
            totalCompleted: completion.totalCompleted,
            openWOs: userOpenCount,
            avgDaysOpen: userOpenCount > 0 ? Math.round((userTotalDaysOpen / userOpenCount) * 10) / 10 : 0
          })
        }

        rankedUsers.sort((a, b) => b.score - a.score)
      }

      // Find the current user's rank
      const myRankIndex = rankedUsers.findIndex(u => u.email.toLowerCase() === emailLower)
      const myRank = myRankIndex >= 0 ? myRankIndex + 1 : null
      const totalRanked = rankedUsers.length

      setMyScore({
        ...myResult,
        user: {
          name: `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim(),
          role: profile.role,
          email: profile.email
        },
        completion: {
          ...myCompletion,
          openWOs: myOpenCount,
          avgDaysOpen: myOpenCount > 0 ? Math.round((myTotalDaysOpen / myOpenCount) * 10) / 10 : 0
        },
        rank: myRank,
        totalRanked
      })

      // ── Team stats ──
      let lateCount = 0
      let totalLateDays = 0
      // Count open WOs that are late
      for (const wo of openWOs) {
        const dueDate = parseDueDateLocal(wo.due_date)
        const createdDate = wo.created_at ? toDateOnly(new Date(wo.created_at)) : null
        if (rangeEnd && createdDate && createdDate > rangeEnd) continue
        if (dueDate && dueDate < effectiveEnd) {
          lateCount++
          const lateStart = rangeStart && rangeStart > dueDate ? rangeStart : dueDate
          totalLateDays += countSchoolDays(lateStart, effectiveEnd, holidays, closedDays)
        }
      }
      // Also count closed WOs that were closed late
      let closedLateCount = 0
      for (const wo of closedWOs) {
        const dueDate = parseDueDateLocal(wo.due_date)
        const closedDate = wo.closed_date ? toDateOnly(new Date(wo.closed_date))
          : wo.updated_at ? toDateOnly(new Date(wo.updated_at)) : null
        if (!dueDate || !closedDate) continue
        if (rangeStart && closedDate < rangeStart) continue
        if (rangeEnd && dueDate > rangeEnd) continue
        if (closedDate > dueDate) {
          closedLateCount++
          const lateStart = rangeStart && rangeStart > dueDate ? rangeStart : dueDate
          const lateEnd = rangeEnd && rangeEnd < closedDate ? rangeEnd : closedDate
          totalLateDays += countSchoolDays(lateStart, lateEnd, holidays, closedDays)
        }
      }
      setTeamStats({
        openCount: openWOs.length,
        lateCount,
        closedLateCount,
        totalLateDays
      })

      // ── Team completion time ──
      let teamTotalDays = 0
      let teamCount = 0
      for (const wo of closedWOs) {
        const created = wo.created_at ? new Date(wo.created_at) : null
        const closed = wo.closed_date ? new Date(wo.closed_date) : wo.updated_at ? new Date(wo.updated_at) : null
        if (!created || !closed) continue
        const closedOnly = toDateOnly(closed)
        if (rangeStart && closedOnly < rangeStart) continue
        if (rangeEnd && closedOnly > rangeEnd) continue
        teamTotalDays += countSchoolDays(created, closed, holidays, closedDays)
        teamCount++
      }
      setTeamCompletion({
        avgDays: teamCount > 0 ? Math.round((teamTotalDays / teamCount) * 10) / 10 : 0,
        totalCompleted: teamCount
      })

      // ── All user scores (team view — permission-gated) ──
      if (canViewAll) {
        setAllScores(rankedUsers)
      }
      hasLoadedRef.current = true
    } catch (err) {
      console.error('WOC Ratio fetch error:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load evaluation data')
    } finally {
      setLoading(false)
    }
  }, [profile, canViewAll, startDate, endDate])

  useEffect(() => { fetchData() }, [fetchData])

  // Real-time: refresh when work_orders, work_orders_closed, or assignments change
  useEffect(() => {
    if (!profile) return
    const channel = supabase
      .channel('woc-ratio-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders_closed' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_assignments' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload) => {
        if (payload.new?.setting_key === 'custom_closed_days' || payload.old?.setting_key === 'custom_closed_days') {
          fetchData()
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile, fetchData])

  return {
    loading,
    myScore,
    allScores,
    teamStats,
    teamCompletion,
    closedDaysList,
    holidaysList,
    refresh: fetchData
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSED DAYS MANAGEMENT (Instructor only)
// ═══════════════════════════════════════════════════════════════════════════════

export function useClosedDaysActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  /** Get formatted holidays for the current year */
  const getHolidaysForYear = useCallback((year) => {
    const names = [
      "New Year's Day", "MLK Jr. Day", "Presidents' Day", "Memorial Day",
      "Independence Day", "Labor Day", "Columbus Day", "Veterans Day",
      "Thanksgiving", "Day After Thanksgiving", "Christmas Eve",
      "Christmas Day", "New Year's Eve"
    ]
    const dates = getUSHolidays(year)
    return dates.map((d, i) => ({
      name: names[i],
      date: toDateStr(d),
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    }))
  }, [])

  /** Add a custom closed day */
  const addClosedDay = async (dateStr) => {
    setSaving(true)
    try {
      // Get current value
      const { data: existing } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'custom_closed_days')
        .maybeSingle()

      const current = existing?.setting_value || ''
      const dates = current.split(',').map(s => s.trim()).filter(Boolean)

      // Check for duplicate
      if (dates.includes(dateStr)) {
        toast.error('This date is already added')
        return
      }

      dates.push(dateStr)
      dates.sort()
      const newValue = dates.join(',')

      if (existing) {
        const { error } = await supabase.from('settings')
          .update({ setting_value: newValue, updated_at: new Date().toISOString(), updated_by: userName })
          .eq('setting_key', 'custom_closed_days')
        if (error) throw error
      } else {
        const { error } = await supabase.from('settings')
          .insert({ setting_key: 'custom_closed_days', setting_value: newValue, category: 'Evaluation', updated_at: new Date().toISOString(), updated_by: userName })
        if (error) throw error
      }

      toast.success('Closed day added')
    } catch (err) {
      toast.error(err.message || 'Failed to add closed day')
      throw err
    } finally {
      setSaving(false)
    }
  }

  /** Remove a custom closed day */
  const removeClosedDay = async (dateStr) => {
    setSaving(true)
    try {
      const { data: existing } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'custom_closed_days')
        .maybeSingle()

      if (!existing) return

      const dates = existing.setting_value
        .split(',').map(s => s.trim()).filter(Boolean)
        .filter(d => d !== dateStr)

      const { error } = await supabase.from('settings')
        .update({ setting_value: dates.join(','), updated_at: new Date().toISOString(), updated_by: userName })
        .eq('setting_key', 'custom_closed_days')

      if (error) throw error
      toast.success('Closed day removed')
    } catch (err) {
      toast.error(err.message || 'Failed to remove closed day')
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, addClosedDay, removeClosedDay, getHolidaysForYear }
}

/** Export school-day helpers for use in other components */
export { countSchoolDays, isSchoolDay, getUSHolidays, toDateStr, toDateOnly }
