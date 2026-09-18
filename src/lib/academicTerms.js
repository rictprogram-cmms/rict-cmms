/**
 * RICT CMMS — Academic terms (pure helpers, no React, no Supabase)
 *
 * A term is one semester's calendar (Settings → Terms). RICT teaches Spring
 * and Fall only. Classes, syllabi, the Class Schedule and semester dropdowns
 * all read from it so semester dates are entered once.
 *
 *   term = { term_id: 'spring-2027', name: 'Spring 2027', season: 'Spring',
 *            year: 2027, begin_date, end_date, spring_break_start,
 *            spring_break_end, finals_start, finals_end, last_drop_date,
 *            last_withdraw_date, first_half_end, second_half_start, status }
 *
 * Dates are plain YYYY-MM-DD strings (date columns), parsed as LOCAL dates.
 *
 * File: src/lib/academicTerms.js
 */

export const SEASONS = ['Spring', 'Fall']
export const RUNS = { full: 'Full term', first: 'First 8 weeks', second: 'Second 8 weeks' }
export const RUNS_SHORT = { full: '16 wk', first: '1st 8 wk', second: '2nd 8 wk' }

const DAY = 86400000

export function parseDate(s) {
  if (!s) return null
  const d = new Date(String(s).substring(0, 10) + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? null : d
}
export function toDateStr(d) {
  if (!d) return ''
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
export function addDays(s, n) { const d = parseDate(s); if (!d) return ''; d.setDate(d.getDate() + n); return toDateStr(d) }
export function weeksBetween(a, b) { const s = parseDate(a), e = parseDate(b); if (!s || !e || e < s) return null; return (e - s) / (7 * DAY) }
export function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—' }
export function fmtShort(s) { const d = parseDate(s); return d ? `${d.getMonth() + 1}/${d.getDate()}` : '—' }

/** "Spring 2027" → { season, year, name, term_id, order } — order sorts chronologically. */
export function parseTermName(name) {
  const s = String(name || '').trim()
  const m = s.match(/(spring|fall|autumn|summer|winter)\D*(\d{4})|(\d{4})\D*(spring|fall|autumn|summer|winter)/i)
  let season = '', year = 0
  if (m) {
    const raw = (m[1] || m[4] || '').toLowerCase()
    season = raw === 'autumn' ? 'Fall' : raw.charAt(0).toUpperCase() + raw.slice(1)
    year = parseInt(m[2] || m[3], 10) || 0
  }
  const seasonOrder = { Spring: 1, Summer: 2, Fall: 3, Winter: 4 }
  return {
    name: season && year ? `${season} ${year}` : s,
    season, year,
    term_id: (season && year ? `${season} ${year}` : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'term',
    order: year + (seasonOrder[season] || 0) / 10,
  }
}
export const termOrder = (t) => (t?.year || 0) + ({ Spring: 1, Summer: 2, Fall: 3, Winter: 4 }[t?.season] || 0) / 10

/** Newest first. */
export function sortTerms(terms) { return [...(terms || [])].sort((a, b) => termOrder(b) - termOrder(a)) }
/** Oldest first. */
export function sortTermsAsc(terms) { return [...(terms || [])].sort((a, b) => termOrder(a) - termOrder(b)) }

/**
 * The term to default to: the one whose dates contain today; otherwise the
 * next one to start; otherwise the most recent. Null when there are none.
 */
export function currentTerm(terms, today = new Date()) {
  const list = sortTermsAsc((terms || []).filter(t => t.status !== 'Archived'))
  if (!list.length) return null
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0)
  for (const t of list) {
    const b = parseDate(t.begin_date), e = parseDate(t.end_date)
    if (b && e && t0 >= b && t0 <= e) return t
  }
  const upcoming = list.filter(t => { const b = parseDate(t.begin_date); return b && b > t0 })
  if (upcoming.length) return upcoming[0]
  return list[list.length - 1]
}

/** The term after `term` in the list, or null. */
export function termAfter(terms, term) {
  if (!term) return null
  const list = sortTermsAsc(terms)
  const i = list.findIndex(t => t.term_id === term.term_id)
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null
}

/** True when more than half the current term has passed and no term follows it. */
export function needsNextTerm(terms, today = new Date()) {
  const cur = currentTerm(terms, today)
  if (!cur) return false
  if (termAfter(terms, cur)) return false
  const b = parseDate(cur.begin_date), e = parseDate(cur.end_date)
  if (!b || !e) return false
  const mid = new Date((b.getTime() + e.getTime()) / 2)
  return today >= mid
}

/** Monday on or before the given date string. */
export function snapToMonday(s) {
  const d = parseDate(s); if (!d) return ''
  const dow = d.getDay()               // 0 Sun … 6 Sat
  const back = dow === 0 ? 6 : dow - 1
  d.setDate(d.getDate() - back)
  return toDateStr(d)
}
/** Friday on or after the given date string. */
export function snapToFriday(s) {
  const d = parseDate(s); if (!d) return ''
  const dow = d.getDay()
  const fwd = dow <= 5 ? 5 - dow : 6
  d.setDate(d.getDate() + fwd)
  return toDateStr(d)
}

/** Default 8-week split from begin/end when a term doesn't have one set: Friday of week 8 / Monday of week 9. */
export function defaultHalfSplit(begin_date) {
  if (!begin_date) return { first_half_end: '', second_half_start: '' }
  const mon = snapToMonday(begin_date)
  return { first_half_end: addDays(mon, 7 * 8 - 3), second_half_start: addDays(mon, 7 * 8) }
}

/** Start / end a class gets from a term for the given `runs`. */
export function datesForRuns(term, runs = 'full') {
  if (!term) return { start_date: '', end_date: '' }
  const split = (term.first_half_end && term.second_half_start)
    ? { first_half_end: term.first_half_end, second_half_start: term.second_half_start }
    : defaultHalfSplit(term.begin_date)
  if (runs === 'first') return { start_date: term.begin_date || '', end_date: split.first_half_end || '' }
  if (runs === 'second') return { start_date: split.second_half_start || '', end_date: term.end_date || '' }
  return { start_date: term.begin_date || '', end_date: term.end_date || '' }
}

/**
 * The break / finals a class inherits from its term.
 *   • First-half classes get no finals — finals week is after they end.
 *   • The break only applies when it falls inside the class's own dates
 *     (pass runs, or start_date/end_date, to scope it; omit for the whole term).
 */
export function calendarFromTerm(term, { runs = 'full', start_date, end_date } = {}) {
  if (!term) return { spring_break_start: '', spring_break_end: '', finals_start: '', finals_end: '' }
  const range = (start_date && end_date) ? { start_date, end_date } : datesForRuns(term, runs)
  const inRange = (s) => {
    if (!s || !range.start_date || !range.end_date) return !!s
    const d = String(s).substring(0, 10)
    return d >= String(range.start_date).substring(0, 10) && d <= String(range.end_date).substring(0, 10)
  }
  const breakApplies = inRange(term.spring_break_start)
  const finalsApply = runs !== 'first'
  return {
    spring_break_start: breakApplies ? (term.spring_break_start || '') : '',
    spring_break_end: breakApplies ? (term.spring_break_end || '') : '',
    finals_start: finalsApply ? (term.finals_start || '') : '',
    finals_end: finalsApply ? (term.finals_end || '') : '',
  }
}

/**
 * Guess `runs` for a class from its dates against its term (used once at
 * seeding and for legacy rows): ≤ 10.5 weeks long → 'first' if it starts
 * within 3 weeks of the term begin, else 'second'; longer → 'full'.
 */
export function inferRuns(cls, term) {
  const w = weeksBetween(cls?.start_date, cls?.end_date)
  if (w == null || w > 10.5) return 'full'
  const b = parseDate(term?.begin_date) || parseDate(cls?.start_date)
  const s = parseDate(cls?.start_date)
  if (!b || !s) return 'first'
  return (s - b) / (7 * DAY) <= 3 ? 'first' : 'second'
}

/** Does this class's calendar match what its term would give it? */
export function classMatchesTerm(cls, term) {
  if (!term) return true
  const d = datesForRuns(term, cls.runs || 'full')
  const c = calendarFromTerm(term, { runs: cls.runs || 'full' })
  const eq = (a, b) => String(a || '').substring(0, 10) === String(b || '').substring(0, 10)
  return eq(cls.start_date, d.start_date) && eq(cls.end_date, d.end_date)
    && eq(cls.spring_break_start, c.spring_break_start) && eq(cls.spring_break_end, c.spring_break_end)
    && eq(cls.finals_start, c.finals_start) && eq(cls.finals_end, c.finals_end)
}

/**
 * Suggest the term that follows `prev` (Fall 2026 → Spring 2027 → Fall 2027):
 * every date shifted to the same week a year on for the same season, or the
 * matching season from last year when that exists. Snapped to Mon/Fri so the
 * instructor only has to fix what the college actually moved.
 */
export function suggestNextTerm(terms) {
  const list = sortTermsAsc(terms)
  const last = list[list.length - 1]
  if (!last) return null
  const nextSeason = last.season === 'Spring' ? 'Fall' : 'Spring'
  const nextYear = last.season === 'Spring' ? last.year : last.year + 1
  const name = `${nextSeason} ${nextYear}`
  // Template: the most recent term of the same season, shifted forward by whole years.
  const template = [...list].reverse().find(t => t.season === nextSeason) || last
  const yearsAhead = nextYear - template.year
  const shift = (s, snap) => {
    if (!s) return ''
    const d = parseDate(s); if (!d) return ''
    d.setFullYear(d.getFullYear() + yearsAhead)
    const str = toDateStr(d)
    return snap === 'mon' ? snapToMonday(str) : snap === 'fri' ? snapToFriday(str) : str
  }
  const t = {
    term_id: parseTermName(name).term_id, name, season: nextSeason, year: nextYear, status: 'Active',
    begin_date: shift(template.begin_date, 'mon'),
    end_date: shift(template.end_date, 'fri'),
    spring_break_start: shift(template.spring_break_start, 'mon'),
    spring_break_end: shift(template.spring_break_end, 'fri'),
    finals_start: shift(template.finals_start, 'mon'),
    finals_end: shift(template.finals_end, 'fri'),
    last_drop_date: shift(template.last_drop_date),
    last_withdraw_date: shift(template.last_withdraw_date),
    first_half_end: shift(template.first_half_end, 'fri'),
    second_half_start: shift(template.second_half_start, 'mon'),
    _template: template.name,
  }
  if (template === last && template.season !== nextSeason) {
    // No same-season template yet (only one term exists): rough it in ~5 months on.
    const roll = (s, snap) => { const d = parseDate(s); if (!d) return ''; d.setMonth(d.getMonth() + (nextSeason === 'Spring' ? 5 : 7)); const str = toDateStr(d); return snap === 'mon' ? snapToMonday(str) : snap === 'fri' ? snapToFriday(str) : str }
    t.begin_date = roll(last.begin_date, 'mon'); t.end_date = roll(last.end_date, 'fri')
    t.spring_break_start = ''; t.spring_break_end = ''
    t.finals_start = roll(last.finals_start, 'mon'); t.finals_end = roll(last.finals_end, 'fri')
    t.last_drop_date = ''; t.last_withdraw_date = ''
    Object.assign(t, defaultHalfSplit(t.begin_date))
    t._template = `${last.name} (rough estimate — no ${nextSeason} term to copy yet)`
  }
  return t
}

/** "Spring 2026" → "Spring 2027". Same season, one year on. '' when unparseable. */
export function nextSameSeasonName(semesterName) {
  const p = parseTermName(semesterName)
  if (!p.season || !p.year) return ''
  return `${p.season} ${p.year + 1}`
}

/**
 * Propose next year's same-season term from this one: every date shifted a year
 * and snapped to Mon/Fri, so only what the college actually moved needs fixing.
 *
 * Differs from suggestNextTerm(), which walks the Spring→Fall→Spring sequence
 * from the newest term. This one answers "what will Spring 2027 look like?"
 * given Spring 2026 — the question the syllabus roll-forward flow asks.
 *
 * Returns a term row shaped for saveTerm(), or null when `term` can't be parsed.
 * `_template` names the term it was derived from, for display.
 */
export function proposeSameSeasonNextYear(term) {
  if (!term) return null
  const p = parseTermName(term.name)
  if (!p.season || !p.year) return null
  const name = `${p.season} ${p.year + 1}`
  const shift = (s, snap) => {
    if (!s) return ''
    const d = parseDate(s); if (!d) return ''
    d.setFullYear(d.getFullYear() + 1)
    const str = toDateStr(d)
    return snap === 'mon' ? snapToMonday(str) : snap === 'fri' ? snapToFriday(str) : str
  }
  return {
    term_id: parseTermName(name).term_id,
    name, season: p.season, year: p.year + 1, status: 'Active',
    begin_date: shift(term.begin_date, 'mon'),
    end_date: shift(term.end_date, 'fri'),
    spring_break_start: shift(term.spring_break_start, 'mon'),
    spring_break_end: shift(term.spring_break_end, 'fri'),
    finals_start: shift(term.finals_start, 'mon'),
    finals_end: shift(term.finals_end, 'fri'),
    last_drop_date: shift(term.last_drop_date),
    last_withdraw_date: shift(term.last_withdraw_date),
    first_half_end: shift(term.first_half_end, 'fri'),
    second_half_start: shift(term.second_half_start, 'mon'),
    _template: term.name,
  }
}

/** Semester names for dropdowns: terms (newest first) plus any legacy names not in terms. */
export function semesterOptions(terms, extraNames = []) {
  const names = sortTerms(terms).map(t => t.name)
  const seen = new Set(names)
  const extras = [...new Set((extraNames || []).map(n => String(n || '').trim()).filter(n => n && !seen.has(n)))]
    .sort((a, b) => parseTermName(b).order - parseTermName(a).order)
  return [...names, ...extras]
}
