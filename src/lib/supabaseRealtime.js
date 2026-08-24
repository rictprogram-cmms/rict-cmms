/**
 * RICT CMMS — supabaseRealtime
 *
 * subscribeWithReconnect(name, bind, options?)
 *
 * WHY THIS EXISTS
 * ───────────────
 * Supabase Realtime does not always re-establish a channel after the
 * underlying WebSocket drops. On the Raspberry Pi kiosks (Lab Status, TV
 * Display, Time Clock) a Wi-Fi blip could leave a channel permanently dead:
 * the polling fallback still refreshed the data, but the "instant" updates
 * silently stopped until the next midnight reload.
 *
 * This wraps channel creation so that when the subscription reports
 * CHANNEL_ERROR or TIMED_OUT the channel is removed and rebuilt
 * with exponential backoff (2 s → 4 s → 8 s … capped at 60 s). A successful
 * SUBSCRIBED resets the backoff. CLOSED is ignored — it also fires when the
 * helper itself removes a channel, and reacting to it looped.
 *
 * USAGE
 * ─────
 *   useEffect(() => subscribeWithReconnect('lab-status-rt', ch => ch
 *     .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, fetchData)
 *     .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, fetchData)
 *   ), [fetchData])
 *
 *   `bind(channel)` attaches the .on(...) listeners and MUST return the channel.
 *   The returned function is the cleanup — return it straight from useEffect.
 *
 * A unique suffix is appended to `name` on every (re)connect so two tabs, or
 * a rebuilt channel racing its own teardown, never collide on a channel name.
 *
 * OPTIONS
 *   client   — a specific supabase client (defaults to the shared app client;
 *              TVDisplayPage creates its own anon client and passes it in)
 *   tag      — console prefix for reconnect warnings (defaults to name)
 *   maxDelay — backoff ceiling in ms (default 60000)
 *
 * File: src/lib/supabaseRealtime.js
 */

import { supabase as defaultClient } from '@/lib/supabase'

// Only these indicate a channel that will NOT come back on its own.
// CLOSED is deliberately NOT here: it is also what fires when we ourselves
// remove a channel (cleanup or rebuild), and reacting to it created a
// reconnect loop where every rebuild spawned two channels.
const RETRY_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT'])

export function subscribeWithReconnect(name, bind, options = {}) {
  const client = options.client || defaultClient
  const tag = options.tag || name
  const maxDelay = options.maxDelay || 60000

  let channel = null
  let timer = null
  let attempt = 0
  let stopped = false

  const teardown = () => {
    const old = channel
    channel = null           // set BEFORE removing so old callbacks are ignored
    if (old) client.removeChannel(old)
  }

  const connect = () => {
    if (stopped) return
    const ch = bind(client.channel(`${name}-${Date.now()}`))
    channel = ch
    ch.subscribe((status) => {
      // Ignore anything from a channel we have already replaced or torn down.
      if (stopped || ch !== channel) return
      if (status === 'SUBSCRIBED') { attempt = 0; return }
      if (RETRY_STATUSES.has(status)) {
        const delay = Math.min(maxDelay, 2000 * 2 ** attempt++)
        console.warn(`[${tag}] Realtime ${status} — reconnecting in ${delay / 1000}s`)
        teardown()
        clearTimeout(timer)
        timer = setTimeout(connect, delay)
      }
    })
  }

  connect()

  return () => {
    stopped = true
    clearTimeout(timer)
    teardown()
  }
}
