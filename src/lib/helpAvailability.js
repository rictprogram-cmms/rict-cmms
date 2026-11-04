/**
 * RICT CMMS — helpAvailability
 *
 * One place that decides whether a student can send a NEW help request right
 * now, and — when they can't — what to tell them. Pure functions only (no
 * Supabase, no React) so every screen agrees and the rules can be tested.
 *
 * RULES, in the order they are checked (the first that fails explains the lock)
 *   1. Lab is scheduled open today   — a lab_calendar row exists with status 'Open'
 *   2. Inside today's open hours     — start_time ≤ now < end_time
 *   3. Not inside a closure block    — closed_blocks, e.g. 2–3 PM Faculty Meeting
 *   4. Not the lunch hour            — lab_calendar.lunch_hour (existing behaviour)
 *   5. Help not paused               — Instructor Away Mode set to "pause help"
 * The clock-in rule stays in the help button itself (it needs the student's
 * own time_clock row) and is checked before these.
 *
 * Decisions (Aaron, 2026-11-03): no calendar row = lab not open (block);
 * closure blocks always pause help; no grace period after closing time.
 *
 * INSTRUCTOR AWAY MODE — settings keys
 *   instructor_away_mode        'true' | 'false'   (existing)
 *   instructor_return_time      free text, e.g. '2:30 PM' (existing)
 *   instructor_away_blocks_help 'true' | 'false'   (new — Away + pause help)
 *   instructor_away_until       fake-UTC timestamp | ''  (new — auto-off)
 * Away Mode counts as ON only while instructor_away_mode is 'true' AND
 * instructor_away_until is empty or still in the future. Every reader goes
 * through isAwayActive(), so a forgotten toggle stops showing — and stops
 * blocking — on its own when the time passes, even before anyone clears it.
 *
 * TIMES — fake-UTC convention: local wall-clock time stored with a +00
 * offset, read back with getUTC*(). lab_calendar times are 'HH:MM[:SS]'
 * local wall-clock strings.
 *
 * File: src/lib/helpAvailability.js
 */

export const AWAY_SETTING_KEYS = [
  'instructor_away_mode',
  'instructor_return_time',
  'instructor_away_blocks_help',
  'instructor_away_until',
]

// ── Time helpers ────────────────────────────────────────────────────────────

/** 'HH:MM' or 'HH:MM:SS' → minutes since midnight, or null. */
export function clockToMinutes(t) {
  if (typeof t !== 'string') return null
  const m = t.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (Number.isNaN(h) || Number.isNaN(mm)) return null
  return h * 60 + mm
}

/** Minutes since midnight of a Date in local time. */
export function localMinutes(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes()
}

/** 510 → '8:30 AM', 720 → '12:00 PM'. */
export function formatMinutes12(min) {
  if (min == null || Number.isNaN(min)) return ''
  const n = ((Math.round(min) % 1440) + 1440) % 1440
  const h = Math.floor(n / 60)
  const m = n % 60
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** Local Date → fake-UTC ISO string ('2026-11-03T14:30:00+00:00'). */
export function toFakeUtc(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00+00:00`
}

/** Fake-UTC string → epoch ms on the same footing as fakeUtcNowMs(). NaN if bad. */
export function fakeUtcToMs(value) {
  if (!value || typeof value !== 'string') return NaN
  // Accept the Postgres spellings too: a space for 'T', and a bare '+00'
  // offset (JavaScript only parses '+00:00' / 'Z').
  let v = value.trim().replace(' ', 'T')
  if (/[+-]\d{2}$/.test(v)) v += ':00'
  return new Date(v).getTime()
}

/** "Now" expressed on the fake-UTC footing (local wall clock read as UTC). */
export function fakeUtcNowMs(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds())
}

/** Fake-UTC string → '2:30 PM' (wall-clock label), or ''. */
export function fakeUtcLabel(value) {
  const ms = fakeUtcToMs(value)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return formatMinutes12(d.getUTCHours() * 60 + d.getUTCMinutes())
}

/** Milliseconds until a fake-UTC time, or null if empty / unparseable. */
export function msUntilFakeUtc(value, now = new Date()) {
  const ms = fakeUtcToMs(value)
  if (Number.isNaN(ms)) return null
  return ms - fakeUtcNowMs(now)
}

// ── Away Mode ───────────────────────────────────────────────────────────────

/**
 * Normalise the four settings rows into one object.
 * rows: [{ setting_key, setting_value }, …] (missing keys are fine — a
 * logged-out screen without the 2026-11-03 migration simply won't see the
 * two new keys and behaves exactly as before).
 */
export function readAwaySettings(rows) {
  const get = k => (rows || []).find(r => r.setting_key === k)?.setting_value
  return {
    away: get('instructor_away_mode') === 'true',
    returnTime: get('instructor_return_time') || '',
    blocksHelp: get('instructor_away_blocks_help') === 'true',
    until: get('instructor_away_until') || '',
  }
}

/**
 * Is Away Mode in effect right now? Off when the toggle is off, or when an
 * end time was set and has passed.
 */
export function isAwayActive(settings, now = new Date()) {
  if (!settings?.away) return false
  const left = msUntilFakeUtc(settings.until, now)
  if (left == null) return true          // no end time — stays on until toggled off
  return left > 0
}

/** Has an end time been set and passed while the toggle is still on? */
export function isAwayExpired(settings, now = new Date()) {
  if (!settings?.away) return false
  const left = msUntilFakeUtc(settings.until, now)
  return left != null && left <= 0
}

/**
 * What to show next to "back around …": the typed return time, or the end
 * time's clock label when nothing was typed.
 */
export function awayReturnLabel(settings) {
  if (!settings) return ''
  return (settings.returnTime || '').trim() || fakeUtcLabel(settings.until)
}

/** 'available' | 'notify' | 'pause' for the current moment. */
export function awayState(settings, now = new Date()) {
  if (!isAwayActive(settings, now)) return 'available'
  return settings.blocksHelp ? 'pause' : 'notify'
}

// ── Lab calendar ────────────────────────────────────────────────────────────

/** Coerce closed_blocks (JSONB array, JSON string, or null) into [{startMin, endMin, reason}]. */
export function parseClosedBlocks(raw) {
  let arr = raw
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map(b => {
      if (!b || typeof b !== 'object') return null
      const startMin = clockToMinutes(b.start)
      const endMin = clockToMinutes(b.end)
      if (startMin == null || endMin == null || endMin <= startMin) return null
      return { startMin, endMin, reason: typeof b.reason === 'string' ? b.reason.trim() : '' }
    })
    .filter(Boolean)
}

/** Today's open window in minutes, or null when the lab isn't open today. */
export function openWindow(calendarRow) {
  if (!calendarRow || calendarRow.status !== 'Open') return null
  const startMin = clockToMinutes(calendarRow.start_time)
  const endMin = clockToMinutes(calendarRow.end_time)
  // Same fallback the Lab Sign Up page uses for rows saved without hours.
  return {
    startMin: startMin ?? 8 * 60,
    endMin: endMin ?? 16 * 60,
  }
}

function parseLunchHour(raw) {
  if (raw == null || raw === '') return null
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? null : n
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Can a student start a new help request right now?
 *
 * @param {object}  args
 * @param {Date}    args.now
 * @param {object|null|undefined} args.calendarRow
 *        today's lab_calendar row; null = no row for today;
 *        undefined = not loaded / could not be read (schedule rules skipped,
 *        so a network blip never blocks help)
 * @param {object}  args.away   result of readAwaySettings()
 * @returns {{ locked: boolean, code?: string, icon?: string, title?: string,
 *             message?: string, short?: string, tone?: 'amber'|'red'|'gray' }}
 */
export function getHelpAvailability({ now = new Date(), calendarRow, away } = {}) {
  const nowMin = localMinutes(now)

  if (calendarRow !== undefined) {
    // 1. Scheduled open today?
    if (calendarRow === null) {
      return {
        locked: true, code: 'no_calendar', icon: '🔒', tone: 'gray',
        title: 'The lab isn’t open today',
        message: 'Help requests are only available during open lab hours.',
        short: 'Help unavailable — the lab isn’t open today',
      }
    }
    const win = openWindow(calendarRow)
    if (!win) {
      return {
        locked: true, code: 'closed_day', icon: '🔒', tone: 'gray',
        title: 'The lab is closed today',
        message: 'Help requests are only available during open lab hours.',
        short: 'Help unavailable — the lab is closed today',
      }
    }

    // 2. Inside open hours? (no grace period after closing)
    if (nowMin < win.startMin) {
      const at = formatMinutes12(win.startMin)
      return {
        locked: true, code: 'before_open', icon: '🕗', tone: 'gray',
        title: 'The lab isn’t open yet',
        message: `Help requests open at ${at}.`,
        short: `Help unavailable — the lab opens at ${at}`,
      }
    }
    if (nowMin >= win.endMin) {
      const at = formatMinutes12(win.endMin)
      return {
        locked: true, code: 'after_close', icon: '🔒', tone: 'gray',
        title: 'The lab is closed for the day',
        message: `Open lab hours ended at ${at}. You can ask for help during the next open lab.`,
        short: `Help unavailable — the lab closed at ${at}`,
      }
    }

    // 3. Inside a closure block? (always pauses help)
    const block = parseClosedBlocks(calendarRow.closed_blocks)
      .find(b => nowMin >= b.startMin && nowMin < b.endMin)
    if (block) {
      const until = formatMinutes12(block.endMin)
      const why = block.reason || 'a scheduled closure'
      return {
        locked: true, code: 'closure', icon: '🔒', tone: 'red',
        title: `Lab closed for ${why}`,
        message: `Help requests reopen at ${until}. Keep working — you can ask for help then.`,
        short: `Help unavailable — lab closed for ${why} until ${until}`,
      }
    }

    // 4. Lunch hour (existing rule — same wording as before)
    const lunchHour = parseLunchHour(calendarRow.lunch_hour)
    if (lunchHour !== null && now.getHours() === lunchHour) {
      const ends = formatMinutes12((lunchHour + 1) * 60)
      return {
        locked: true, code: 'lunch', icon: '🍽️', tone: 'amber',
        title: 'Instructors are on lunch',
        message: `Help requests reopen at ${ends}. Keep working — you can ask for help after lunch.`,
        short: `Help unavailable — instructors are on lunch until ${ends}`,
      }
    }
  }

  // 5. Instructor paused help
  if (away && awayState(away, now) === 'pause') {
    const back = awayReturnLabel(away)
    return {
      locked: true, code: 'paused', icon: '🏢', tone: 'red',
      title: 'Help requests are paused',
      message: back
        ? `Instructors are in a meeting and will be back around ${back}. Keep working — you can ask for help when they return.`
        : 'Instructors are in a meeting. Keep working — you can ask for help when they return.',
      short: back
        ? `Help paused — instructors are back around ${back}`
        : 'Help paused — instructors are in a meeting',
    }
  }

  return { locked: false }
}

/**
 * The fake-UTC end time for an Away preset, or '' for "no end time".
 * preset: minutes (number) | 'close' (today's lab closing time) | 'none'.
 * Returns null when 'close' is asked for but the lab has no closing time
 * still ahead today.
 */
export function awayUntilForPreset(preset, { now = new Date(), calendarRow } = {}) {
  if (preset === 'none' || preset == null) return ''
  if (preset === 'close') {
    const win = openWindow(calendarRow)
    if (!win || win.endMin <= localMinutes(now)) return null
    const d = new Date(now)
    d.setHours(Math.floor(win.endMin / 60), win.endMin % 60, 0, 0)
    return toFakeUtc(d)
  }
  const mins = Number(preset)
  if (!Number.isFinite(mins) || mins <= 0) return ''
  return toFakeUtc(new Date(now.getTime() + mins * 60000))
}

// ── Database refusals ───────────────────────────────────────────────────────

/**
 * The reason code from a help_requests insert refused by the database
 * trigger (migration 20261103_help_request_rules.sql), or null.
 * The error message looks like 'HELP_LOCKED:closure'.
 */
export function serverLockReason(error) {
  const msg = String(error?.message || error || '')
  const m = msg.match(/HELP_LOCKED:([a-z_]+)/)
  return m ? m[1] : null
}

/**
 * A lock message for a database refusal when the app's own copy of the
 * schedule didn't predict it (e.g. a closure added a moment ago).
 */
export function lockForServerReason(reason) {
  const base = { locked: true, code: reason, icon: '🔒', tone: 'gray' }
  switch (reason) {
    case 'not_clocked_in':
      return { ...base, title: 'You aren’t clocked in', message: 'Clock in at the Time Clock, then ask for help.', short: 'You must be clocked in to request help' }
    case 'no_calendar':
    case 'closed_day':
      return { ...base, title: 'The lab is closed today', message: 'Help requests are only available during open lab hours.', short: 'Help unavailable — the lab is closed today' }
    case 'before_open':
      return { ...base, title: 'The lab isn’t open yet', message: 'Help requests open when the lab opens.', short: 'Help unavailable — the lab isn’t open yet' }
    case 'after_close':
      return { ...base, title: 'The lab is closed for the day', message: 'You can ask for help during the next open lab.', short: 'Help unavailable — the lab is closed for the day' }
    case 'closure':
      return { ...base, tone: 'red', title: 'The lab is closed right now', message: 'There is a scheduled closure. Keep working — you can ask for help when it ends.', short: 'Help unavailable — the lab is closed right now' }
    case 'lunch':
      return { ...base, icon: '🍽️', tone: 'amber', title: 'Instructors are on lunch', message: 'Keep working — you can ask for help after lunch.', short: 'Help unavailable — instructors are on lunch' }
    case 'paused':
      return { ...base, icon: '🏢', tone: 'red', title: 'Help requests are paused', message: 'Instructors are in a meeting. Keep working — you can ask for help when they return.', short: 'Help paused — instructors are in a meeting' }
    default:
      return { ...base, title: 'Help isn’t available right now', message: 'Please try again in a little while.', short: 'Help unavailable right now' }
  }
}
