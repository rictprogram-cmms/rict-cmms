/**
 * RICT CMMS — Accountability alert rules (pure)
 *
 * Turns one student's Accountability Report into a short list of PATTERNS
 * worth a tap on the shoulder. A single late arrival is noise; "late 3 of the
 * last 4 lab days" is a pattern. Every threshold comes from Settings
 * (defaults below, agreed 2026-09-23) so tuning never needs a code change.
 *
 * Two tiers
 *   drastic  → also worth hearing about before Monday (bell / push later)
 *   watch    → Dashboard card and the Monday digest only
 *
 * Rules (id → what fires it)
 *   noshow_week       ≥ alert_noshow_week no-shows inside one week           drastic
 *   no_punches_week   a completed week that owed hours, no All Done, no
 *                     approved absence, and not a single punch               drastic
 *   noshow_with_hold  a no-show in the last 7 days while a hold is open      drastic
 *   no_signups_week   the CURRENT locked week owes hours and has ZERO hours
 *                     booked (no All Done, no approved absence, no change
 *                     request pending) — fires on Monday, not a pattern      watch
 *   noshow_4wk        ≥ alert_noshow_4wk no-shows in the last 4 weeks         watch
 *   late_of4          ≥ alert_late_of4 of the last 4 attended days late      watch
 *   early_of4         ≥ alert_early_of4 of the last 4 attended days early    watch
 *   short_weeks       short on sign-ups the last alert_short_weeks weeks     watch
 *   deadline_of4      ≥ alert_deadline_of4 of the last 4 weeks missed the
 *                     Sunday deadline                                        watch
 *   work_past_due     any approved late work past its extended due date      watch
 *   wo_late           an own work order ≥ alert_wo_late_days days past due   watch
 *   gear_overdue      equipment still out ≥ alert_gear_days days overdue     watch
 *   volunteer_behind  volunteer standing is Behind                           watch
 *
 * Deliberately NOT a rule: the trend badge (it compares the student with
 * their own history, so a chronically late student never trips it).
 *
 * Exports
 *   ALERT_DEFAULTS, ALERT_RULES, readThresholds(settingsMap)
 *   evaluateAlerts(report, thresholds) → [{ rule, tier, detail, classIds }]
 *   describeRule(rule) → { label, help }
 *
 * File: src/lib/accountabilityAlerts.js
 */

import { mondayKeyOf } from '@/lib/closureProration'
import { fmtDay, fmtDate, toDateKey } from '@/lib/accountabilityRules'

export const ALERT_DEFAULTS = {
  alert_noshow_week: 2,
  alert_noshow_4wk: 3,
  alert_late_of4: 3,
  alert_early_of4: 3,
  alert_short_weeks: 2,
  alert_deadline_of4: 3,
  alert_wo_late_days: 3,
  alert_gear_days: 3,
  accountability_sweep_hours: 6,
}

export const ALERT_RULES = {
  noshow_week:      { tier: 'drastic', label: 'No-shows in one week',            help: 'Signed up and did not come, more than once in the same week.' },
  no_punches_week:  { tier: 'drastic', label: 'A whole week with no punches',    help: 'Owed lab hours, no All Done, no approved absence, and never punched in.' },
  noshow_with_hold: { tier: 'drastic', label: 'No-show while a hold is open',    help: 'A no-show in the last 7 days while the student has an open hold.' },
  no_signups_week:  { tier: 'watch',   label: 'No sign-ups this week',           help: 'The week is locked, hours are owed, and nothing at all is booked.' },
  noshow_4wk:       { tier: 'watch',   label: 'Repeated no-shows',               help: 'No-shows across the last 4 weeks.' },
  late_of4:         { tier: 'watch',   label: 'Arriving late',                   help: 'Late on most of the last 4 lab days attended.' },
  early_of4:        { tier: 'watch',   label: 'Leaving early',                   help: 'Unexcused early departures on most of the last 4 lab days attended.' },
  short_weeks:      { tier: 'watch',   label: 'Short on sign-ups',               help: 'Booked fewer hours than required for consecutive weeks.' },
  deadline_of4:     { tier: 'watch',   label: 'Missing the sign-up deadline',    help: 'Hours were short at the Sunday deadline on most of the last 4 weeks.' },
  work_past_due:    { tier: 'watch',   label: 'Late work still not received',   help: 'An approved late submission is past its extended due date.' },
  wo_late:          { tier: 'watch',   label: 'Work order past due',            help: 'An assigned work order is well past its due date.' },
  gear_overdue:     { tier: 'watch',   label: 'Equipment overdue',              help: 'Checked-out equipment has not come back.' },
  volunteer_behind: { tier: 'watch',   label: 'Volunteer hours behind',         help: 'Volunteer standing is Behind on the Volunteer Hours page.' },
}

export function describeRule(rule) {
  return ALERT_RULES[rule] || { tier: 'watch', label: rule, help: '' }
}

/** Thresholds from a Map/object of settings rows (setting_key → setting_value). */
export function readThresholds(settingsMap) {
  const get = k => (settingsMap instanceof Map ? settingsMap.get(k) : settingsMap?.[k])
  const out = {}
  for (const [k, def] of Object.entries(ALERT_DEFAULTS)) {
    const n = parseFloat(get(k))
    out[k] = isNaN(n) || n < 0 ? def : n
  }
  return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function check(report, id) { return (report?.checks || []).find(c => c.id === id) || { items: [], count: 0 } }
function items(report, id) { return check(report, id).items || [] }
function daysAgo(today, n) { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - n); return toDateKey(d) }
function classesOf(list) { return [...new Set(list.map(i => (i.label.match(/\(([A-Z]+\d+[^)]*)\)/) || [])[1]).filter(Boolean))].join(',') }
function listDays(list, max = 4) {
  const ds = list.map(i => i.date).filter(Boolean).sort().slice(-max)
  return ds.map(d => fmtDay(d).replace(/^\w+, /, '')).join(', ')
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export function evaluateAlerts(report, thresholds = ALERT_DEFAULTS) {
  if (!report) return []
  const T = { ...ALERT_DEFAULTS, ...(thresholds || {}) }
  const meta = report.meta || {}
  const today = meta.today || toDateKey(new Date())
  const out = []
  const fire = (rule, detail, list = []) => out.push({ rule, tier: ALERT_RULES[rule].tier, detail, classIds: classesOf(list) })

  // No-shows
  const noShows = items(report, 'noShows')
  const byWeek = new Map()
  for (const it of noShows) { const w = it.week || mondayKeyOf(it.date); if (w) byWeek.set(w, (byWeek.get(w) || 0) + 1) }
  const worstWeek = [...byWeek.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]
  if (worstWeek && worstWeek[1] >= T.alert_noshow_week && worstWeek[0] >= daysAgo(today, 28)) {
    fire('noshow_week', `${worstWeek[1]} no-shows in the week of ${fmtDate(worstWeek[0])}`, noShows.filter(i => i.week === worstWeek[0]))
  }
  const recentNoShows = noShows.filter(i => i.date >= daysAgo(today, 28))
  if (recentNoShows.length >= T.alert_noshow_4wk && !out.some(a => a.rule === 'noshow_week')) {
    fire('noshow_4wk', `${recentNoShows.length} no-shows in the last 4 weeks (${listDays(recentNoShows)})`, recentNoShows)
  }
  if ((meta.openHolds || 0) > 0) {
    const last7 = noShows.filter(i => i.date >= daysAgo(today, 7))
    if (last7.length) fire('noshow_with_hold', `No-show on ${listDays(last7, 2)} while a hold is open`, last7)
  }

  // Whole week with nothing
  const emptyWeeks = (meta.weeks || []).filter(w => w.required > 0 && !w.allDone && !w.approvedAbsence && !w.hasPunches)
  const lastEmpty = emptyWeeks[emptyWeeks.length - 1]
  if (lastEmpty && lastEmpty.monday >= daysAgo(today, 21)) {
    fire('no_punches_week', `${emptyWeeks.length > 1 ? `${emptyWeeks.length} weeks` : 'Week'} with no punches at all — latest the week of ${fmtDate(lastEmpty.monday)}`)
  }

  // Late / early on the last 4 attended days
  const last4 = (meta.attendedDays || []).slice(-4)
  if (last4.length >= 4) {
    const lateDays = new Set(items(report, 'late').map(i => i.date))
    const earlyDays = new Set(items(report, 'leftEarly').map(i => i.date))
    const lateHits = last4.filter(d => lateDays.has(d))
    const earlyHits = last4.filter(d => earlyDays.has(d))
    if (lateHits.length >= T.alert_late_of4) fire('late_of4', `Late ${lateHits.length} of the last 4 lab days (${listDays(lateHits.map(d => ({ date: d })))})`, items(report, 'late').filter(i => lateHits.includes(i.date)))
    if (earlyHits.length >= T.alert_early_of4) fire('early_of4', `Left early ${earlyHits.length} of the last 4 lab days (${listDays(earlyHits.map(d => ({ date: d })))})`, items(report, 'leftEarly').filter(i => earlyHits.includes(i.date)))
  }

  // This week: locked, owes hours, nothing booked at all (one miss is enough — it's Monday)
  const thisMonday = mondayKeyOf(today)
  const thisWeekMiss = items(report, 'deadlineMissed').find(i => i.week === thisMonday && i.stillNone && !i.requestPending && !i.allDone)
  if (thisWeekMiss) {
    const absentThisWeek = (report.checks || []).find(c => c.id === 'absences')?.items?.some(i => i.status === 'Approved' && i.week === thisMonday)
    if (!absentThisWeek) fire('no_signups_week', `Nothing signed up for the week of ${fmtDate(thisMonday)} — the deadline has passed`, [thisWeekMiss])
  }

  // Sign-ups: consecutive short weeks, deadline misses of the last 4 weeks
  const owed = (meta.weeks || []).filter(w => w.required > 0)
  const shortWeeks = new Set(items(report, 'weekShort').map(i => i.week))
  let run = 0
  for (let i = owed.length - 1; i >= 0; i--) { if (shortWeeks.has(owed[i].monday) && !owed[i].allDone) run++; else break }
  if (run >= T.alert_short_weeks) fire('short_weeks', `Short on sign-ups ${run} weeks in a row`, items(report, 'weekShort').slice(-run))
  const last4Weeks = owed.slice(-4).map(w => w.monday)
  const deadlineMisses = items(report, 'deadlineMissed').filter(i => last4Weeks.includes(i.week))
  if (last4Weeks.length >= 4 && deadlineMisses.length >= T.alert_deadline_of4) fire('deadline_of4', `Missed the Sunday deadline ${deadlineMisses.length} of the last 4 weeks`, deadlineMisses)

  // Late work
  const pastDue = items(report, 'workPastDue')
  if (pastDue.length) fire('work_past_due', `${pastDue.length} late assignment${pastDue.length === 1 ? '' : 's'} past the extended due date`, pastDue)

  // Work orders (calendar days past due, from meta so the sweep can skip the WOC engine)
  const lateWOs = (meta.woLate || []).filter(w => w.days >= T.alert_wo_late_days).sort((a, b) => b.days - a.days)
  if (lateWOs.length) fire('wo_late', `${lateWOs[0].woId} is ${lateWOs[0].days} days past due${lateWOs.length > 1 ? ` (+${lateWOs.length - 1} more)` : ''}`)

  // Equipment still out
  const gear = items(report, 'overdueCheckouts').filter(i => i.stillOut && i.days >= T.alert_gear_days).sort((a, b) => b.days - a.days)
  if (gear.length) fire('gear_overdue', `${gear[0].label}`)

  // Volunteer
  const vol = check(report, 'volunteer')
  if (vol.status === 'behind') fire('volunteer_behind', vol.summary ? `Volunteer hours: ${vol.summary}` : 'Volunteer hours behind')

  // Drastic first, then by rule order
  const order = Object.keys(ALERT_RULES)
  return out.sort((a, b) => (a.tier === b.tier ? order.indexOf(a.rule) - order.indexOf(b.rule) : a.tier === 'drastic' ? -1 : 1))
}
