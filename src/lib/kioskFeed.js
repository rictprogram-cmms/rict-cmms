/**
 * RICT CMMS — kioskFeed
 *
 * Data for the logged-out screens (TV Display, Lab Status) after security
 * phase 2 (2026-09-28). Those screens can no longer read time_clock,
 * lab_signup, help_requests, work_orders or profiles directly. Instead one
 * database function, kiosk_feed(date), returns exactly what they show.
 *
 * NO EMAILS: every `user_email` / `email` value in the feed is an anonymous,
 * stable per-person key (e.g. "k3f9a…"). The same person gets the same key in
 * every list, so the screens' existing "match people across tables by email"
 * logic keeps working unchanged — but a real address never reaches a kiosk.
 * Never display these values.
 *
 * fetchKioskFeed(client, 'YYYY-MM-DD') resolves to Supabase-style
 * { data, error } results, one per list, so pages can keep their
 * mustData(res, label) handling:
 *   punchedIn      time_clock rows, status 'Punched In', today, by punch_in
 *   punchedOut     time_clock rows, status 'Punched Out', today, by punch_in
 *   signups        lab_signup rows, status 'Confirmed', today
 *   help           help_requests 'pending' / 'acknowledged', by requested_at
 *   timeClockOnly  [{ email: key, time_clock_only: 'Yes' }]
 *   instructors    Active instructors [{ email: key, first_name, last_name, role }]
 *   workOrders     work orders not Closed, by due_date (nulls last)
 * If the call fails, every list carries the same error.
 *
 * subscribeKioskFeed(name, onChange, options) — live updates. The database
 * bumps public.kiosk_feed_version (no personal data) whenever the underlying
 * tables change; this subscribes to it with subscribeWithReconnect and calls
 * onChange(topic) where topic is 'time_clock' | 'help_requests' |
 * 'lab_signup' | 'work_orders' | 'profiles'. `options` is passed straight to
 * subscribeWithReconnect (client, tag, onReconnect, filter).
 *
 * File: src/lib/kioskFeed.js
 */

import { subscribeWithReconnect } from '@/lib/supabaseRealtime'

const LISTS = {
  punchedIn: 'punched_in',
  punchedOut: 'punched_out',
  signups: 'signups',
  help: 'help',
  timeClockOnly: 'time_clock_only',
  instructors: 'instructors',
  workOrders: 'work_orders',
}

export async function fetchKioskFeed(client, dateStr) {
  let data = null
  let error = null
  try {
    const res = await client.rpc('kiosk_feed', { p_date: dateStr })
    data = res.data
    error = res.error || (res.data ? null : new Error('kiosk_feed: no data'))
  } catch (e) {
    error = e
  }
  const out = {}
  for (const [name, key] of Object.entries(LISTS)) {
    out[name] = error ? { data: null, error } : { data: Array.isArray(data?.[key]) ? data[key] : [], error: null }
  }
  return out
}

export function subscribeKioskFeed(name, onChange, options = {}) {
  const { filter, ...rest } = options
  const spec = { event: '*', schema: 'public', table: 'kiosk_feed_version' }
  if (filter) spec.filter = filter
  return subscribeWithReconnect(name, ch => ch
    .on('postgres_changes', spec, (payload) => onChange(payload?.new?.topic || payload?.old?.topic || ''))
  , rest)
}
