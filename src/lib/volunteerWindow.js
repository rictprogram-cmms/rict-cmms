// ═══════════════════════════════════════════════════════════════════════════════
// resolveVolunteerWindow — single source of truth for "which volunteer hours
// count toward the current semester".
//
// Used by useVolunteerHours.js (student page + instructor overview/detail),
// DashboardPage.jsx (grade card), and TimeCardsPage.jsx (GB Items report) so
// all three show the same number.
//
// Two windows come back:
//   semesterStart / semesterEnd — the real class window. Drives week numbers,
//                                 midpoint checks, and first/second-half logic.
//   countStart / countEnd       — the HOURS-COUNTING window. Starts the day
//                                 after the previous term's last class ended,
//                                 so hours earned over summer roll into Fall
//                                 and winter-break hours roll into Spring.
//
// Resolution order for the class window:
//   1. Explicit settings volunteer_semester_start/_end (if present and not stale)
//   2. Active classes: earliest start_date → latest end_date
//   3. Upcoming classes (start_date > today): so hours logged during a break
//      count toward the next term before its classes are set Active
//   4. Current calendar year
//
// Date strings are YYYY-MM-DD. Use `+ 'T00:00:00'` before new Date() to force
// local parsing (bare dates parse as UTC and shift a day in US timezones).
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'

function localDateStr(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return localDateStr(d)
}

function windowFromClasses(rows) {
  const starts = rows.map(c => c.start_date).filter(Boolean).sort()
  const ends = rows.map(c => c.end_date).filter(Boolean).sort()
  return {
    start: starts[0] || '',
    end: ends[ends.length - 1] || '',
    semester: rows.find(c => c.semester)?.semester || '',
  }
}

/**
 * @returns {Promise<{
 *   semesterStart: string, semesterEnd: string,
 *   countStart: string, countEnd: string,
 *   currentSemester: string,
 *   priorTermEnd: string|null,   // last end_date before semesterStart (null if none)
 *   includesBreak: boolean,      // countStart < semesterStart
 *   source: 'settings'|'active'|'upcoming'|'year',
 * }>}
 */
export async function resolveVolunteerWindow() {
  const today = new Date()
  const todayStr = localDateStr(today)
  let semesterStart = ''
  let semesterEnd = ''
  let currentSemester = ''
  let source = 'year'

  // 1. Explicit settings (legacy, mostly retired) ─────────────────────────
  try {
    const rows = mustData(await supabase
      .from('settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['volunteer_semester_start', 'volunteer_semester_end', 'volunteer_current_semester']), 'settings.select')
    const map = {}
    ;(rows || []).forEach(r => { map[r.setting_key] = r.setting_value })
    const s = map.volunteer_semester_start || ''
    const e = map.volunteer_semester_end || ''
    const stale = e && new Date(e + 'T23:59:59') < today
    if (s && e && !stale) {
      semesterStart = s
      semesterEnd = e
      currentSemester = map.volunteer_current_semester || ''
      source = 'settings'
    }
  } catch (err) {
    console.warn('[volunteerWindow] settings fetch failed:', err?.message || err)
  }

  // 2. Active classes ──────────────────────────────────────────────────────
  if (!semesterStart || !semesterEnd) {
    try {
      const rows = mustData(await supabase
        .from('classes')
        .select('start_date, end_date, semester')
        .eq('status', 'Active')
        .order('start_date', { ascending: true })
        .limit(20), 'classes.select')
      if (rows && rows.length > 0) {
        const w = windowFromClasses(rows)
        if (w.start && w.end) {
          semesterStart = w.start; semesterEnd = w.end
          currentSemester = currentSemester || w.semester
          source = 'active'
        }
      }
    } catch (err) {
      console.warn('[volunteerWindow] active classes fetch failed:', err?.message || err)
    }
  }

  // 3. Upcoming classes (between semesters) ───────────────────────────────
  //    Take the earliest future start, then every class starting within 45
  //    days of it (one term), so a Fall + Spring pair isn't merged.
  if (!semesterStart || !semesterEnd) {
    try {
      const rows = mustData(await supabase
        .from('classes')
        .select('start_date, end_date, semester')
        .gt('start_date', todayStr)
        .order('start_date', { ascending: true })
        .limit(20), 'classes.select')
      if (rows && rows.length > 0) {
        const first = rows[0].start_date
        const cutoff = addDays(first, 45)
        const term = rows.filter(c => c.start_date && c.start_date <= cutoff)
        const w = windowFromClasses(term)
        if (w.start && w.end) {
          semesterStart = w.start; semesterEnd = w.end
          currentSemester = currentSemester || w.semester
          source = 'upcoming'
        }
      }
    } catch (err) {
      console.warn('[volunteerWindow] upcoming classes fetch failed:', err?.message || err)
    }
  }

  // 4. Calendar-year fallback ──────────────────────────────────────────────
  if (!semesterStart) semesterStart = `${today.getFullYear()}-01-01`
  if (!semesterEnd) semesterEnd = `${today.getFullYear()}-12-31`

  // 5. Prior term end → counting window start ─────────────────────────────
  //    Any class record (any status) that ended before this semester began.
  let priorTermEnd = null
  try {
    const rows = mustData(await supabase
      .from('classes')
      .select('end_date')
      .lt('end_date', semesterStart)
      .order('end_date', { ascending: false })
      .limit(1), 'classes.select')
    if (rows && rows.length > 0 && rows[0].end_date) priorTermEnd = rows[0].end_date
  } catch (err) {
    console.warn('[volunteerWindow] prior term fetch failed:', err?.message || err)
  }

  const countStart = priorTermEnd ? addDays(priorTermEnd, 1) : semesterStart
  const countEnd = semesterEnd

  return {
    semesterStart, semesterEnd,
    countStart, countEnd,
    currentSemester,
    priorTermEnd,
    includesBreak: countStart < semesterStart,
    source,
  }
}

/** "Jun 15, 2026" from YYYY-MM-DD, local-safe. */
export function formatWindowDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
