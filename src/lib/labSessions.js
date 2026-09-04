/**
 * RICT CMMS — Lab signup session helpers
 *
 * A student's day on the Lab Signup sheet is a list of hour slots
 * (`lab_signup` rows: start_time / end_time as 'HH:MM[:SS]'). Several
 * pages need the same two derived facts:
 *
 *   1. SESSIONS — contiguous slots merged into one block. 8-9, 9-10, 10-11
 *      becomes a single 8:00–11:00 session; a gap starts a new session.
 *      A student can therefore have more than one session in a day
 *      (e.g. 8–11 AM and 12–2 PM).
 *
 *   2. WHICH SESSION MATTERS RIGHT NOW — the session containing `now`
 *      (current), or the first one still ahead (next), so a page can decide
 *      whether someone who already punched out is "done for the day" or is
 *      expected back for a later block.
 *
 * Previously DashboardPage and LabStatusPage each implemented this on
 * their own and drifted: the Dashboard hid anyone who had punched out,
 * which dropped students with a later block while Lab Status still showed
 * them as Expected. Both pages now use this module.
 *
 * All values are minutes-since-midnight in the LOCAL day. Callers that need
 * Date objects (e.g. for sorting against punch timestamps) can build one
 * from `startMin` / `endMin` with `minutesToDate()`.
 */

/**
 * 'HH:MM' or 'HH:MM:SS' -> minutes since midnight, or null if unparseable.
 */
export function timeToMinutes(t) {
  if (t == null) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Minutes since midnight -> 'HH:MM' (24h, zero padded).
 */
export function minutesToTime(min) {
  if (min == null || !Number.isFinite(min)) return '';
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Minutes since midnight -> '8:00 AM' style label.
 */
export function minutesToTime12(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  let h = Math.floor(min / 60);
  const mm = String(min % 60).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${mm} ${ampm}`;
}

/**
 * Minutes since midnight of a Date in LOCAL time (defaults to now).
 */
export function nowMinutes(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Build a local Date on `day` at `min` minutes past midnight.
 */
export function minutesToDate(day, min) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(min);
  return d;
}

/**
 * Merge a list of signup slots into contiguous sessions.
 *
 * Accepts slots shaped either as `lab_signup` rows ({ start_time, end_time })
 * or as { start, end }. Returns sessions sorted by start:
 *
 *   [{ start: 'HH:MM', end: 'HH:MM', startMin, endMin }]
 *
 * Slots that touch (end === next start) or overlap are merged; a gap starts a
 * new session. Invalid or zero-length slots are ignored.
 */
export function mergeSignupSessions(slots) {
  const blocks = [];
  for (const s of slots || []) {
    if (!s) continue;
    const startMin = timeToMinutes(s.start_time ?? s.start);
    const endMin = timeToMinutes(s.end_time ?? s.end);
    if (startMin == null || endMin == null || endMin <= startMin) continue;
    blocks.push({ startMin, endMin });
  }
  blocks.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const sessions = [];
  let cur = null;
  for (const b of blocks) {
    if (cur && b.startMin <= cur.endMin) {
      if (b.endMin > cur.endMin) cur.endMin = b.endMin;
    } else {
      cur = { startMin: b.startMin, endMin: b.endMin };
      sessions.push(cur);
    }
  }
  return sessions.map(s => ({
    start: minutesToTime(s.startMin),
    end: minutesToTime(s.endMin),
    startMin: s.startMin,
    endMin: s.endMin,
  }));
}

/**
 * Given merged sessions and the current minute of the day, find:
 *
 *   current — the session containing `nowMin` (start <= now < end), or null
 *   next    — the first session that starts after `nowMin`, or null
 *   last    — the final session of the day (or null if none)
 *   span    — { startMin, endMin } covering first start .. last end (or null)
 *
 * `current || next` is "the session that matters right now"; when both are
 * null every session is already over.
 */
export function pickSession(sessions, nowMin) {
  let current = null;
  let next = null;
  for (const s of sessions || []) {
    if (s.startMin <= nowMin && s.endMin > nowMin) current = s;
    else if (s.startMin > nowMin && !next) next = s;
  }
  const list = sessions || [];
  const last = list.length ? list[list.length - 1] : null;
  const span = list.length ? { startMin: list[0].startMin, endMin: last.endMin } : null;
  return { current, next, last, span };
}

/**
 * True if the person still has a session ahead of them that they have not
 * yet attended.
 *
 *   sessions        — from mergeSignupSessions()
 *   nowMin          — current minute of day
 *   lastPunchOutMin — minute of day of their most recent punch-out today, or
 *                     null if they have not punched out
 *
 * A session counts as remaining when it has not ended yet AND it started at
 * or after the last punch-out (i.e. they left before it began). Someone who
 * punched out partway through a block has "left" that block; it only counts
 * if a later block exists.
 */
export function hasRemainingSession(sessions, nowMin, lastPunchOutMin) {
  for (const s of sessions || []) {
    if (s.endMin <= nowMin) continue;
    if (lastPunchOutMin != null && s.startMin < lastPunchOutMin) continue;
    return true;
  }
  return false;
}
