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
 * Count school days INCLUSIVE of both endpoints — used for the activity factor
 * since we're sizing an evaluation window, not measuring elapsed days.
 */
function countSchoolDaysInclusive(startDate, endDate, holidays, closedDays) {
  if (!startDate || !endDate) return 0
  const start = toDateOnly(startDate)
  const end = toDateOnly(endDate)
  if (end < start) return 0

  let count = 0
  const current = new Date(start)
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

/** Round to one decimal place for display */
function round1(n) {
  return Math.round(n * 10) / 10
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING CONFIG (defaults — can be overridden via settings rows)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  studentHoursPerWeek: 1.5,    // expected work_log hours per school week (Student)
  workStudyHoursPerWeek: 5.0,  // expected work_log hours per school week (Work Study)
  closerAckPct: 2,             // flat % bonus to whoever clicks Close (if they logged time)
  minCloserHours: 0.25,        // min hours on the WO to qualify for closer ack
  staleThreshold: 4,           // school days without update before stale kicks in
  earlyPctPerDay: 0.5,         // early-completion bonus rate (% per school day early)
  maxBonusPerWo: 10,           // hard cap on the early_share bonus from any single WO
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate a single user's WOC score.
 *
 * SCORING:
 *   Base: 100 × activityFactor   (activityFactor = MIN(1, hours_logged / expected))
 *   −2% per school day for late WOs assigned to you (open AND closed-late)
 *   −1% per school day for all team late WOs (shared)
 *   −1% per school day for stale WOs (no update >4 school days). Refined: only
 *     applies if you've logged hours on the WO OR are the sole assignee.
 *   +(earlyPctPerDay)% per school day early × YOUR_HOURS / TOTAL_HOURS on that WO,
 *     capped at maxBonusPerWo from any single WO (hours-weighted share).
 *   +closerAckPct flat to whoever clicked Close, IF they logged ≥ minCloserHours on the WO.
 *   Floor: 0%, Cap: 100% (also returns rawScore — uncapped, for reference).
 *
 * @param {Object} user - {emailLower, role, displayNameLower}
 * @param {Object} ctx - aggregated context built once in fetchData
 * @returns {object} Score breakdown
 */
function calculateScore(user, ctx) {
  const {
    openWOs, closedWOs, holidays, closedDays, assignmentsMap,
    workLogByWo,           // Map<wo_id, {totalHours, byUser: Map<email_lower, hours>}>
    workLogByUser,         // Map<email_lower, hours_in_range>
    closedByMap,           // Map<wo_id, closer_displayname_lower>
    config,
    schoolDaysInRange,     // total school days in evaluation period (for activity factor)
    rangeStart, rangeEnd,
  } = ctx

  const { emailLower, role, displayNameLower } = user
  const today = toDateOnly(new Date())
  const effectiveEnd = rangeEnd ? (rangeEnd < today ? rangeEnd : today) : today
  const details = []

  let assignedLateDays = 0
  let teamLateDays = 0
  let staleDays = 0
  let earlyShare = 0      // float — sum of (daysEarly × share) across WOs
  let closerAckBonus = 0  // integer — sum of flat ack bonuses

  /**
   * Determine if this user is assigned to a WO.
   * Checks the multi-assignment junction table first (assignmentsMap),
   * then falls back to the legacy single assigned_email / assigned_to fields.
   */
  const isAssignedToUser = (woId, assignedEmail, assignedTo) => {
    const emailSet = assignmentsMap.get(woId)
    if (emailSet && emailSet.size > 0) return emailSet.has(emailLower)
    const ae = (assignedEmail || '').toLowerCase().trim()
    const at = (assignedTo || '').toLowerCase().trim()
    return ae === emailLower || at.includes(emailLower.split('@')[0])
  }

  /** How many assignees does a WO have (for sole-assignee stale rule)? */
  const countAssignees = (woId, assignedEmail) => {
    const emailSet = assignmentsMap.get(woId)
    if (emailSet && emailSet.size > 0) return emailSet.size
    return (assignedEmail || '').trim() ? 1 : 0
  }

  /** Hours this user has logged on a given WO (any time, not just in range) */
  const userHoursOnWo = (woId) => {
    const log = workLogByWo.get(woId)
    if (!log) return 0
    return log.byUser.get(emailLower) || 0
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
    // REFINED: only if user has logged hours on the WO, OR is the sole assignee.
    // This prevents penalizing users who were auto-assigned to a PM they never engaged with.
    if (assignedToUser) {
      const hoursOnWo = userHoursOnWo(woId)
      const assigneeCount = countAssignees(woId, wo.assigned_email)
      const eligibleForStale = hoursOnWo > 0 || assigneeCount <= 1
      if (eligibleForStale) {
        const referenceDate = updatedDate && updatedDate > createdDate ? updatedDate : createdDate
        if (referenceDate) {
          const totalSchoolDaysSinceUpdate = countSchoolDays(referenceDate, effectiveEnd, holidays, closedDays)
          if (totalSchoolDaysSinceUpdate > config.staleThreshold) {
            const daysOverThreshold = totalSchoolDaysSinceUpdate - config.staleThreshold
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

    // ── 2b. EARLY COMPLETION REWARDS (hours-weighted + closer ack) ────────
    if (dueDate && closedDate && closedDate < dueDate) {
      const daysEarly = countSchoolDays(closedDate, dueDate, holidays, closedDays)
      if (daysEarly > 0) {
        const log = workLogByWo.get(woId)
        const totalHours = log?.totalHours || 0

        // RULE: if no hours logged on the WO at all, NO bonus is awarded.
        // This kills phantom credit — if no one logged time, there's nothing to reward.
        if (totalHours > 0) {
          const myHours = log.byUser.get(emailLower) || 0
          if (myHours > 0) {
            const share = myHours / totalHours
            // Apply per-day rate, then cap per-WO so one monster early-close
            // can't dominate the whole period.
            const rawReward = daysEarly * share * config.earlyPctPerDay
            const cappedReward = Math.min(rawReward, config.maxBonusPerWo)
            const wasCapped = cappedReward < rawReward
            earlyShare += cappedReward
            details.push({
              type: 'early_share',
              woId,
              description: desc,
              days: daysEarly,
              myHours: round1(myHours),
              totalHours: round1(totalHours),
              pctOfWork: Math.round(share * 1000) / 10, // one decimal
              reward: round1(cappedReward),
              originalReward: round1(rawReward),
              capped: wasCapped,
              source: 'closed'
            })
          }

          // Closer ack: flat bonus IF this user closed it AND logged >= minCloserHours
          const closer = closedByMap.get(woId)
          if (closer && displayNameLower && closer === displayNameLower) {
            if (myHours >= config.minCloserHours) {
              closerAckBonus += config.closerAckPct
              details.push({
                type: 'closer_ack',
                woId,
                description: desc,
                reward: config.closerAckPct,
                source: 'closed'
              })
            }
          }
        }
      }
    }
  }

  // ── 3. Activity factor ────────────────────────────────────────────────────
  // Scales the BASE 100 down for users who haven't logged enough work_log hours
  // in the evaluation period. Rewards & penalties are added on top of the
  // activity-scaled base, so real contribution still moves the score upward.
  //
  // When the per-role hours/week setting is 0 (or negative), the instructor
  // has explicitly disabled activity-factor scaling — factor locks at 1.0
  // regardless of how many hours were logged. Without this guard, the
  // `Math.max(2, ...)` floor below would silently expect 2 hours/period even
  // for a setting of 0, surprising any student who logged < 2 hours.
  const hoursPerWeek = role === 'Work Study'
    ? config.workStudyHoursPerWeek
    : config.studentHoursPerWeek
  const schoolWeeksInRange = schoolDaysInRange / 4   // 4 school days per typical week
  const activityHours = workLogByUser.get(emailLower) || 0
  let expectedHours, activityFactor
  if (hoursPerWeek <= 0) {
    expectedHours = 0
    activityFactor = 1
  } else {
    expectedHours = Math.max(2, hoursPerWeek * schoolWeeksInRange)
    activityFactor = Math.min(1, activityHours / expectedHours)
  }

  // ── 4. Calculate final score ──────────────────────────────────────────────
  const earlyShareDisplay = round1(earlyShare)
  const personalDeduction = (assignedLateDays * 2) + staleDays
  const teamDeduction = teamLateDays
  const totalDeduction = personalDeduction + teamDeduction
  const totalReward = earlyShareDisplay + closerAckBonus
  const baseScore = 100 * activityFactor
  const rawScore = baseScore - totalDeduction + totalReward
  const score = round1(Math.min(100, Math.max(0, rawScore)))

  return {
    score,
    rawScore: round1(rawScore),                            // uncapped — for "who's truly cooking" view
    baseScore: round1(baseScore),
    activityFactor: round1(activityFactor * 100) / 100,  // 0.00 .. 1.00
    activityHours: round1(activityHours),
    expectedHours: round1(expectedHours),
    assignedLateDays,
    teamLateDays,
    staleDays,
    earlyShare: earlyShareDisplay,
    earlyDays: earlyShareDisplay,           // alias for any legacy consumer
    closerAckBonus,
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
// EXPORTED: Per-window student scoring (used by Dashboard's grade-relevant cards)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute the current student's WOC Ratio score across multiple class windows.
 *
 * One data fetch, N window computations — much cheaper than calling useWOCRatio
 * once per class. The static parts (work_orders, work_log, assignments,
 * profiles, settings, holidays) are fetched once. The window-dependent parts
 * (workLogByUser range filter, schoolDaysInRange) are recomputed per window.
 *
 * Used by DashboardPage's "My Grade-Relevant Scores" cards to show the same
 * WOC score the student would receive in GB Items at end-of-class.
 *
 * @param {object} profile — { user_id, email, role, first_name, last_name }
 * @param {Array<{key, startDate, endDate}>} windows — class windows (YYYY-MM-DD strings)
 * @returns {Promise<Object<string, {score, rawScore, baseScore, activityFactor, ...}>>}
 *          Map keyed by window.key.
 */
export async function computeStudentScoresForWindows(profile, windows) {
  if (!profile || !Array.isArray(windows) || windows.length === 0) return {}

  const emailLower = (profile.email || '').toLowerCase().trim()
  const displayNameLower = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim().toLowerCase()
  const user = { emailLower, role: profile.role, displayNameLower }

  // 1. Fetch all the static data (mirrors what fetchData does in useWOCRatio).
  const [openRes, closedRes, closedArchiveRes, settingsRes, assignmentsRes, workLogRes] = await Promise.all([
    supabase.from('work_orders').select('*').neq('status', 'Closed'),
    supabase.from('work_orders').select('*').eq('status', 'Closed'),
    supabase.from('work_orders_closed').select('*'),
    supabase.from('settings').select('setting_key, setting_value')
      .in('setting_key', [
        'custom_closed_days',
        'woc_activity_hours_per_week_student',
        'woc_activity_hours_per_week_workstudy',
        'woc_closer_ack_bonus_pct',
        'woc_min_closer_hours_for_ack',
        'woc_stale_threshold_days',
        'woc_early_pct_per_day',
        'woc_max_bonus_per_wo'
      ]),
    supabase.from('work_order_assignments').select('wo_id, user_email'),
    supabase.from('work_log').select('wo_id, user_email, hours, timestamp'),
  ])

  const openWOs = openRes.data || []
  // Merge closed WOs from both tables, dedup by wo_id (matches useWOCRatio behavior)
  const closedFromMain = closedRes.data || []
  const closedFromArchive = closedArchiveRes.data || []
  const closedMap = new Map()
  for (const wo of closedFromMain) closedMap.set(wo.wo_id, wo)
  for (const wo of closedFromArchive) {
    if (!closedMap.has(wo.wo_id)) closedMap.set(wo.wo_id, wo)
  }
  const closedWOs = Array.from(closedMap.values())

  const settingsArr = settingsRes.data || []
  const settingsMap = new Map(settingsArr.map(r => [r.setting_key, r.setting_value]))
  const closedDays = parseClosedDays(settingsMap.get('custom_closed_days'))

  const parseNum = (key, fallback) => {
    const v = settingsMap.get(key)
    if (v === undefined || v === null || v === '') return fallback
    const n = parseFloat(v)
    return isNaN(n) ? fallback : n
  }
  const effectiveConfig = {
    studentHoursPerWeek:   parseNum('woc_activity_hours_per_week_student',   DEFAULT_CONFIG.studentHoursPerWeek),
    workStudyHoursPerWeek: parseNum('woc_activity_hours_per_week_workstudy', DEFAULT_CONFIG.workStudyHoursPerWeek),
    closerAckPct:          parseNum('woc_closer_ack_bonus_pct',              DEFAULT_CONFIG.closerAckPct),
    minCloserHours:        parseNum('woc_min_closer_hours_for_ack',          DEFAULT_CONFIG.minCloserHours),
    staleThreshold:        parseNum('woc_stale_threshold_days',              DEFAULT_CONFIG.staleThreshold),
    earlyPctPerDay:        parseNum('woc_early_pct_per_day',                 DEFAULT_CONFIG.earlyPctPerDay),
    maxBonusPerWo:         parseNum('woc_max_bonus_per_wo',                  DEFAULT_CONFIG.maxBonusPerWo),
  }

  // assignmentsMap: Map<wo_id, Set<lowercase_email>>
  const assignmentsMap = new Map()
  for (const a of (assignmentsRes.data || [])) {
    const woId = a.wo_id
    const ae = (a.user_email || '').toLowerCase().trim()
    if (!assignmentsMap.has(woId)) assignmentsMap.set(woId, new Set())
    assignmentsMap.get(woId).add(ae)
  }

  // closedByMap: Map<wo_id, lowercase_displayname>
  const closedByMap = new Map()
  for (const wo of closedWOs) {
    if (wo.closed_by) closedByMap.set(wo.wo_id, String(wo.closed_by).toLowerCase().trim())
  }

  // workLogByWo: Map<wo_id, {totalHours, byUser: Map<email_lower, hours>}>
  // (range-independent — used for hours-weighted credit calculations)
  const workLogByWo = new Map()
  const allLogs = workLogRes.data || []
  for (const entry of allLogs) {
    const woId = entry.wo_id
    const email = (entry.user_email || '').toLowerCase().trim()
    const hours = parseFloat(entry.hours) || 0
    if (!woId || !email) continue
    if (!workLogByWo.has(woId)) {
      workLogByWo.set(woId, { totalHours: 0, byUser: new Map() })
    }
    const woEntry = workLogByWo.get(woId)
    woEntry.totalHours += hours
    woEntry.byUser.set(email, (woEntry.byUser.get(email) || 0) + hours)
  }

  // Pre-compute holiday list across ALL WO dates (range-independent)
  const allDates = [
    ...openWOs.map(w => w.created_at),
    ...openWOs.map(w => w.due_date),
    ...closedWOs.map(w => w.created_at),
    ...closedWOs.map(w => w.closed_date),
    ...windows.flatMap(w => [w.startDate, w.endDate]),
  ].filter(Boolean)
  const holidays = buildHolidayList(allDates)

  // 2. For each window: compute the per-window pieces and call calculateScore
  const today = toDateOnly(new Date())
  const result = {}

  for (const w of windows) {
    const rangeStart = w.startDate ? toDateOnly(new Date(w.startDate + 'T00:00:00')) : null
    const rangeEnd = w.endDate ? toDateOnly(new Date(w.endDate + 'T00:00:00')) : null

    // workLogByUser is range-filtered (drives the activity factor)
    const workLogByUser = new Map()
    for (const entry of allLogs) {
      const email = (entry.user_email || '').toLowerCase().trim()
      const hours = parseFloat(entry.hours) || 0
      if (!email) continue
      const ts = entry.timestamp ? new Date(entry.timestamp) : null
      if (ts && !isNaN(ts)) {
        if (rangeStart && ts < rangeStart) continue
        if (rangeEnd) {
          const dayAfterEnd = new Date(rangeEnd)
          dayAfterEnd.setDate(dayAfterEnd.getDate() + 1)
          if (ts >= dayAfterEnd) continue
        }
        workLogByUser.set(email, (workLogByUser.get(email) || 0) + hours)
      }
    }

    // School days in range — uses factorEnd capped at today (matches useWOCRatio)
    const factorStart = rangeStart
    const factorEnd = rangeEnd ? (rangeEnd < today ? rangeEnd : today) : today
    const effectiveFactorStart = factorStart || (() => {
      // Fallback: 60 days before factorEnd (rarely used since callers always pass a range)
      const f = new Date(factorEnd)
      f.setDate(f.getDate() - 60)
      return f
    })()
    const schoolDaysInRange = countSchoolDaysInclusive(effectiveFactorStart, factorEnd, holidays, closedDays)

    const ctx = {
      openWOs, closedWOs, holidays, closedDays,
      assignmentsMap, workLogByWo, workLogByUser, closedByMap,
      config: effectiveConfig,
      schoolDaysInRange,
      rangeStart, rangeEnd,
    }

    result[w.key] = calculateScore(user, ctx)
  }

  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main hook — fetches WO data + settings + assignments + work_log,
 * calculates all scores using hours-weighted credit + activity floor.
 *
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
  const [scoringConfig, setScoringConfig] = useState(DEFAULT_CONFIG)
  const hasLoadedRef = useRef(false)

  const fetchData = useCallback(async () => {
    if (!profile) return
    if (!hasLoadedRef.current) setLoading(true)

    try {
      // Parse date range
      const rangeStart = startDate ? toDateOnly(new Date(startDate + 'T00:00:00')) : null
      const rangeEnd = endDate ? toDateOnly(new Date(endDate + 'T00:00:00')) : null

      // Parallel fetches — work_log and the new scoring settings are added.
      const [openRes, closedRes, closedArchiveRes, settingsRes, profilesRes, assignmentsRes, workLogRes] = await Promise.all([
        supabase.from('work_orders').select('*').neq('status', 'Closed'),
        supabase.from('work_orders').select('*').eq('status', 'Closed'),
        supabase.from('work_orders_closed').select('*'),
        // Pull the closed-days setting AND any woc_* scoring overrides
        supabase.from('settings').select('setting_key, setting_value')
          .in('setting_key', [
            'custom_closed_days',
            'woc_activity_hours_per_week_student',
            'woc_activity_hours_per_week_workstudy',
            'woc_closer_ack_bonus_pct',
            'woc_min_closer_hours_for_ack',
            'woc_stale_threshold_days',
            'woc_early_pct_per_day',
            'woc_max_bonus_per_wo'
          ]),
        // Always fetch profiles to compute rank for the current user
        supabase.from('profiles').select('*').in('status', ['Active', 'active'])
          .not('time_clock_only', 'eq', 'Yes'),
        // Multi-assignment junction table
        supabase.from('work_order_assignments').select('wo_id, user_email'),
        // Work log — drives both hours-weighted credit and the activity factor
        supabase.from('work_log').select('wo_id, user_email, hours, timestamp')
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

      // Build settings lookup
      const settingsArr = settingsRes.data || []
      const settingsMap = new Map(settingsArr.map(r => [r.setting_key, r.setting_value]))

      const closedDays = parseClosedDays(settingsMap.get('custom_closed_days'))
      setClosedDaysList(closedDays)

      // Build effective scoring config from settings (with defaults)
      const parseNum = (key, fallback) => {
        const v = settingsMap.get(key)
        if (v === undefined || v === null || v === '') return fallback
        const n = parseFloat(v)
        return isNaN(n) ? fallback : n
      }
      const effectiveConfig = {
        studentHoursPerWeek:   parseNum('woc_activity_hours_per_week_student',   DEFAULT_CONFIG.studentHoursPerWeek),
        workStudyHoursPerWeek: parseNum('woc_activity_hours_per_week_workstudy', DEFAULT_CONFIG.workStudyHoursPerWeek),
        closerAckPct:          parseNum('woc_closer_ack_bonus_pct',              DEFAULT_CONFIG.closerAckPct),
        minCloserHours:        parseNum('woc_min_closer_hours_for_ack',          DEFAULT_CONFIG.minCloserHours),
        staleThreshold:        parseNum('woc_stale_threshold_days',              DEFAULT_CONFIG.staleThreshold),
        earlyPctPerDay:        parseNum('woc_early_pct_per_day',                 DEFAULT_CONFIG.earlyPctPerDay),
        maxBonusPerWo:         parseNum('woc_max_bonus_per_wo',                  DEFAULT_CONFIG.maxBonusPerWo),
      }
      setScoringConfig(effectiveConfig)

      // Build assignmentsMap: Map<wo_id, Set<lowercase_email>>
      const assignmentsMap = new Map()
      for (const a of (assignmentsRes.data || [])) {
        const woId = a.wo_id
        const emailLower = (a.user_email || '').toLowerCase().trim()
        if (!assignmentsMap.has(woId)) assignmentsMap.set(woId, new Set())
        assignmentsMap.get(woId).add(emailLower)
      }

      // Build closedByMap: Map<wo_id, lowercase_displayname>  (for closer ack matching)
      const closedByMap = new Map()
      for (const wo of closedWOs) {
        if (wo.closed_by) {
          closedByMap.set(wo.wo_id, String(wo.closed_by).toLowerCase().trim())
        }
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

      // ── Build work_log maps ──────────────────────────────────────────────
      // workLogByWo: Map<wo_id, {totalHours, byUser: Map<email_lower, hours>}>
      //   — uses ALL hours ever logged on each WO (not range-filtered) so that
      //     credit follows the contribution regardless of when the work happened.
      // workLogByUser: Map<email_lower, hoursInRange>
      //   — range-filtered, used only for the activity factor.
      const workLogByWo = new Map()
      const workLogByUser = new Map()
      const allLogs = workLogRes.data || []
      for (const entry of allLogs) {
        const woId = entry.wo_id
        const email = (entry.user_email || '').toLowerCase().trim()
        const hours = parseFloat(entry.hours) || 0
        if (!woId || !email) continue

        // Per-WO map (all-time)
        if (!workLogByWo.has(woId)) {
          workLogByWo.set(woId, { totalHours: 0, byUser: new Map() })
        }
        const woEntry = workLogByWo.get(woId)
        woEntry.totalHours += hours
        woEntry.byUser.set(email, (woEntry.byUser.get(email) || 0) + hours)

        // Per-user map (range-filtered)
        const ts = entry.timestamp ? new Date(entry.timestamp) : null
        if (ts && !isNaN(ts)) {
          if (rangeStart && ts < rangeStart) continue
          if (rangeEnd) {
            const dayAfterEnd = new Date(rangeEnd)
            dayAfterEnd.setDate(dayAfterEnd.getDate() + 1)
            if (ts >= dayAfterEnd) continue
          }
          workLogByUser.set(email, (workLogByUser.get(email) || 0) + hours)
        } else if (!rangeStart && !rangeEnd) {
          // No range — count everything when timestamp is missing
          workLogByUser.set(email, (workLogByUser.get(email) || 0) + hours)
        }
      }

      // ── Compute school days in range (for activity factor sizing) ───────
      // If no explicit range, fall back to [earliest WO created date, today]
      // so that the activity factor still has a meaningful denominator.
      const today = toDateOnly(new Date())
      let factorStart = rangeStart
      let factorEnd = rangeEnd ? (rangeEnd < today ? rangeEnd : today) : today
      if (!factorStart) {
        let earliest = null
        for (const wo of [...openWOs, ...closedWOs]) {
          if (wo.created_at) {
            const d = toDateOnly(new Date(wo.created_at))
            if (!earliest || d < earliest) earliest = d
          }
        }
        // Final fallback: 60 days ago
        if (!earliest) {
          earliest = new Date(today)
          earliest.setDate(earliest.getDate() - 60)
        }
        factorStart = earliest
      }
      const schoolDaysInRange = countSchoolDaysInclusive(factorStart, factorEnd, holidays, closedDays)

      // ── Build a single ctx object passed into calculateScore for every user ──
      const ctx = {
        openWOs, closedWOs, holidays, closedDays,
        assignmentsMap, workLogByWo, workLogByUser, closedByMap,
        config: effectiveConfig,
        schoolDaysInRange,
        rangeStart, rangeEnd,
      }

      const buildUser = (p) => ({
        emailLower: (p.email || '').toLowerCase().trim(),
        role: p.role,
        displayNameLower: `${p.first_name || ''} ${(p.last_name || '').charAt(0)}.`.trim().toLowerCase(),
      })

      // ── My score ──
      const meUser = buildUser(profile)
      const myResult = calculateScore(meUser, ctx)
      const myCompletion = calcCompletionTime(profile.email, closedWOs, holidays, closedDays, assignmentsMap, rangeStart, rangeEnd)

      // Count user's open WOs
      const emailLower = meUser.emailLower
      const effectiveEnd = factorEnd
      let myOpenCount = 0
      let myTotalDaysOpen = 0

      for (const wo of openWOs) {
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
          const userObj = buildUser(u)
          const result = calculateScore(userObj, ctx)
          const completion = calcCompletionTime(u.email, closedWOs, holidays, closedDays, assignmentsMap, rangeStart, rangeEnd)

          // Count open WOs for this user
          const ue = userObj.emailLower
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

        // Primary sort: clamped score (highest first).
        // Tiebreaker: uncapped rawScore so the 100% cluster orders by who's
        // actually cooking the most. Falls back to score for any edge case
        // where rawScore isn't populated.
        rankedUsers.sort((a, b) =>
          (b.score - a.score) || ((b.rawScore ?? b.score) - (a.rawScore ?? a.score))
        )
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

  // Real-time: refresh when work_orders, work_orders_closed, assignments,
  // work_log, or scoring settings change.
  useEffect(() => {
    if (!profile) return
    const channelName = `woc-ratio-changes-${Date.now()}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders_closed' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_assignments' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_log' }, () => { fetchData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload) => {
        const key = payload.new?.setting_key || payload.old?.setting_key
        if (!key) return
        if (key === 'custom_closed_days' || key.startsWith('woc_')) {
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
    scoringConfig,
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
