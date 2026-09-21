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
 *   client      — a specific supabase client (defaults to the shared app client;
 *                 TVDisplayPage creates its own anon client and passes it in)
 *   tag         — console prefix for reconnect warnings (defaults to name)
 *   maxDelay    — backoff ceiling in ms (default 60000)
 *   onReconnect — function to call ONCE after the connection comes back, so the
 *                 page can refetch. See below. Optional; omit it and nothing
 *                 about this helper changes.
 *
 * WHY onReconnect
 * ───────────────
 * Rebuilding a dead channel only restores FUTURE events. Supabase Realtime
 * does not replay what happened while the channel was down, so a sign-up made
 * during a 90-second Wi-Fi drop stays invisible until some later event on the
 * same table happens to trigger a refetch — on a quiet table, hours.
 *
 * Pass the page's own fetch function and it is called when either happens:
 *   1. this channel reaches SUBSCRIBED after a CHANNEL_ERROR / TIMED_OUT
 *      (covers kiosks and TVs, which lose the network but never leave the
 *      foreground). Never on the very first connect — the page has just
 *      loaded its data.
 *   2. AuthContext dispatches `supabase-reconnected` (a tab that was hidden
 *      for 30 s+ came back — laptop sleep, switching tabs).
 * Both can fire within a moment of each other, so calls are coalesced: one
 * refetch per second at most. It is never called after cleanup, and an error
 * thrown (or a promise rejected) by it is logged, never propagated.
 *
 *   useEffect(() => subscribeWithReconnect('lab-status-rt', ch => ch
 *     .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, fetchData)
 *   , { tag: 'LabStatus', onReconnect: fetchData }), [fetchData])
 *
 * Only pass a function that is safe to call with no arguments and that
 * reloads everything the handlers keep current. Handlers that apply the
 * event payload directly (setX(payload.new…)) need their initial loader here,
 * not the handler.
 *
 * File: src/lib/supabaseRealtime.js
 */

import { supabase as defaultClient } from '@/lib/supabase'

// Only these indicate a channel that will NOT come back on its own.
// CLOSED is deliberately NOT here: it is also what fires when we ourselves
// remove a channel (cleanup or rebuild), and reacting to it created a
// reconnect loop where every rebuild spawned two channels.
const RETRY_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT'])

let channelSeq = 0

export function subscribeWithReconnect(name, bind, options = {}) {
  const client = options.client || defaultClient
  const tag = options.tag || name
  const maxDelay = options.maxDelay || 60000
  const onReconnect = typeof options.onReconnect === 'function' ? options.onReconnect : null

  let channel = null
  let timer = null
  let attempt = 0
  let stopped = false
  let hadFailure = false     // a retry status was seen since the last SUBSCRIBED
  let refetchTimer = null

  // Coalesce: a channel rebuild and a tab-return often land together.
  const scheduleRefetch = (why) => {
    if (!onReconnect || stopped) return
    clearTimeout(refetchTimer)
    refetchTimer = setTimeout(() => {
      refetchTimer = null
      if (stopped) return
      try {
        const result = onReconnect()
        if (result && typeof result.catch === 'function') {
          result.catch(err => console.warn(`[${tag}] onReconnect (${why}) failed:`, err?.message || err))
        }
      } catch (err) {
        console.warn(`[${tag}] onReconnect (${why}) failed:`, err?.message || err)
      }
    }, 1000)
  }

  const onTabReturn = () => scheduleRefetch('tab return')
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (onReconnect && hasWindow) window.addEventListener('supabase-reconnected', onTabReturn)

  const teardown = () => {
    const old = channel
    channel = null           // set BEFORE removing so old callbacks are ignored
    if (old) client.removeChannel(old)
  }

  const connect = () => {
    if (stopped) return
    // Unique per-connection name: Supabase returns the SAME channel object for a
    // repeated name, and adding callbacks to an already-subscribed channel throws
    // ("cannot add postgres_changes callbacks … after subscribe()"). A counter
    // covers two hooks mounting in the same millisecond.
    const ch = bind(client.channel(`${name}-${Date.now()}-${++channelSeq}`))
    channel = ch
    ch.subscribe((status) => {
      // Ignore anything from a channel we have already replaced or torn down.
      if (stopped || ch !== channel) return
      if (status === 'SUBSCRIBED') {
        attempt = 0
        // Back after a failure → whatever happened in between was missed.
        if (hadFailure) { hadFailure = false; scheduleRefetch('channel rebuilt') }
        return
      }
      if (RETRY_STATUSES.has(status)) {
        hadFailure = true
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
    clearTimeout(refetchTimer)
    if (onReconnect && hasWindow) window.removeEventListener('supabase-reconnected', onTabReturn)
    teardown()
  }
}
