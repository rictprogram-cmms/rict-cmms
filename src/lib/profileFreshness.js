/**
 * RICT CMMS — profile freshness
 *
 * Pure decisions for AuthContext: given the profile the app currently holds
 * and a fresher copy of the row (from a realtime UPDATE or a re-read), what
 * should happen?
 *
 *   'ignore'       no usable row, or it belongs to someone else → do nothing
 *   'deactivated'  the row's status is no longer 'Active' → end the session view
 *                  (same outcome loadProfile() gives on the next page load)
 *   'unchanged'    nothing but bookkeeping columns moved → keep the SAME
 *                  profile object in React state
 *   'changed'      something real changed (role, classes, name, …) → apply it
 *
 * WHY 'unchanged' EXISTS
 *   AuthContext stamps profiles.last_seen every 5 minutes. That UPDATE comes
 *   straight back as the user's own realtime event, and the handler used to
 *   setRealProfile(payload.new) — a NEW object every five minutes. 43
 *   dependency arrays across the app depend on the bare `profile` object, so
 *   the Lab Signup grid, Equipment, Work Orders, the Network Map and others
 *   all refetched (several behind a loading state) every five minutes for
 *   every signed-in user. Nothing reads last_seen / last_login from context.
 *
 * REALTIME PAYLOADS CAN BE PARTIAL
 *   Postgres omits unchanged TOASTed (large) column values from the
 *   replication stream, so `payload.new` may lack keys the held profile has.
 *   A key missing from `next` is therefore "not reported", never "changed to
 *   nothing": comparison only looks at keys present in `next`, and
 *   mergeProfile() lays `next` over `prev` instead of replacing it.
 *
 * File: src/lib/profileFreshness.js
 */

/** Columns that move without anything about the person changing. */
export const VOLATILE_PROFILE_FIELDS = ['last_seen', 'last_login', 'updated_at']

const lower = (s) => String(s ?? '').toLowerCase().trim()
const same = (a, b) => (a === b) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** True when any NON-volatile key present in `next` differs from `prev`. */
export function meaningfulProfileChange(prev, next) {
  if (!prev || !next) return !!next !== !!prev
  for (const key of Object.keys(next)) {
    if (VOLATILE_PROFILE_FIELDS.includes(key)) continue
    if (!same(prev[key], next[key])) return true
  }
  return false
}

/** `next` laid over `prev` — never loses a column a partial payload left out. */
export function mergeProfile(prev, next) {
  return { ...(prev || {}), ...(next || {}) }
}

/**
 * @param {Object|null} prev  profile currently held
 * @param {Object|null} next  fresher row (may be partial)
 * @returns {'ignore'|'deactivated'|'unchanged'|'changed'}
 */
export function classifyFreshProfile(prev, next) {
  if (!prev || !next || typeof next !== 'object') return 'ignore'
  // Must be the same person. A payload with no email at all (partial) is
  // accepted — the channel is already filtered to this email server-side.
  if (next.email != null && lower(next.email) !== lower(prev.email)) return 'ignore'
  // Only an explicit non-Active status deactivates; a payload that simply
  // doesn't carry `status` says nothing about it.
  if ('status' in next && next.status !== 'Active') return 'deactivated'
  return meaningfulProfileChange(prev, next) ? 'changed' : 'unchanged'
}
