/**
 * RICT CMMS — cancel the sign-ups an All Done makes unnecessary
 *
 * Rule (2026-11-10): cancel only the student's Confirmed sign-ups that have
 * NOT STARTED yet — later today and the rest of the week. The hour they're in
 * and everything earlier today stay Confirmed (they were worked), and past
 * days are never touched. Matches the server functions mark_all_done and
 * mark_all_done_manual (supabase/migrations/20261110_all_done_keep_started_hours.sql).
 *
 * Before this, every All Done path cancelled ALL of today's sign-ups, so a
 * 3:48 PM swipe wiped the student's 8 AM–3 PM hours and their week showed 0
 * signed hours. The old swipe fallback also computed "today" in UTC, which
 * after 6 PM Central was already tomorrow.
 *
 * Only the browser fallbacks use this; the live paths run on the server.
 *
 * File: src/lib/allDoneSignups.js
 */

import { supabase } from '@/lib/supabase'
import { mustData, assertWrite } from '@/lib/supabaseData'

/** Local 'YYYY-MM-DD' for a Date. */
function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 'HH:MM[:SS]' → minutes after midnight, or null. */
function toMinutes(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/)
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null
}

/**
 * Cancel the not-yet-started Confirmed sign-ups for `email` from today through
 * `weekEndKey` ('YYYY-MM-DD', inclusive). Returns the number cancelled.
 * Throws on a read or write error so the caller can report it.
 *
 * @param {object} p
 * @param {string} p.email        student's email
 * @param {string} p.weekEndKey   last day of the week, local 'YYYY-MM-DD'
 * @param {Date}   [p.now]        for testing
 */
export async function cancelUnstartedSignups({ email, weekEndKey, now = new Date() }) {
  if (!email || !weekEndKey) return 0
  const todayKey = localKey(now)
  if (weekEndKey < todayKey) return 0
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const from = new Date(todayKey + 'T00:00:00')
  const to = new Date(weekEndKey + 'T00:00:00')
  to.setDate(to.getDate() + 1)

  const rows = mustData(await supabase
    .from('lab_signup')
    .select('signup_id, date, start_time')
    .eq('user_email', email)
    .eq('status', 'Confirmed')
    .gte('date', from.toISOString())
    .lt('date', to.toISOString()), 'lab_signup.all-done-select') || []

  const ids = rows
    .filter(r => {
      const dayKey = localKey(new Date(r.date))
      if (dayKey > todayKey) return true
      if (dayKey < todayKey) return false
      const start = toMinutes(r.start_time)
      return start != null && start > nowMin          // not started yet
    })
    .map(r => r.signup_id)

  if (ids.length === 0) return 0
  const { data, error } = assertWrite(
    await supabase
      .from('lab_signup')
      .update({ status: 'Cancelled' })
      .in('signup_id', ids)
      .eq('status', 'Confirmed')
      .select('signup_id'),
    'lab_signup.all-done-cancel'
  )
  if (error) throw error
  return (data || []).length
}
