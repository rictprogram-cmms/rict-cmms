/**
 * RICT CMMS — useInstructorAway
 *
 * Reads Instructor Away Mode (the four settings keys in AWAY_SETTING_KEYS),
 * keeps it live over realtime, and re-renders on its own when an Away end
 * time passes — so the meeting banner, the help-button pause and the kiosk
 * AWAY badge all clear themselves without anyone touching Settings.
 *
 *   const { loaded, settings, active, state, paused, returnLabel } =
 *     useInstructorAway({ name: 'help-btn-away', enabled: !isInstructor })
 *
 *   settings     raw values from readAwaySettings() (away, returnTime, blocksHelp, until)
 *   active       Away Mode is in effect right now (toggle on and not past its end time)
 *   state        'available' | 'notify' | 'pause'
 *   paused       state === 'pause'
 *   returnLabel  text for "back around …" (typed return time, else the end time)
 *
 * Any change to one of the keys triggers a re-read of all four (one small
 * query) rather than applying the payload — new keys can arrive as INSERTs
 * the first time they are saved, and a re-read is always consistent.
 *
 * options
 *   client   supabase client (TV Display passes its own anon client)
 *   name     realtime channel base name (the helper adds a unique suffix)
 *   tag      console tag for reconnect warnings
 *   enabled  false → no reads, no channel (e.g. instructors on AppLayout)
 *
 * File: src/hooks/useInstructorAway.js
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase as appClient } from '@/lib/supabase'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { mustData } from '@/lib/supabaseData'
import {
  AWAY_SETTING_KEYS, readAwaySettings, isAwayActive, awayState,
  awayReturnLabel, msUntilFakeUtc,
} from '@/lib/helpAvailability'

const EMPTY = { away: false, returnTime: '', blocksHelp: false, until: '' }

export function useInstructorAway({ client = appClient, name = 'away-mode', tag = 'AwayMode', enabled = true } = {}) {
  const [settings, setSettings] = useState(EMPTY)
  const [loaded, setLoaded] = useState(false)
  // Bumped when an end time passes so `active` is recomputed.
  const [, setTick] = useState(0)
  const cancelledRef = useRef(false)

  const reload = useCallback(async () => {
    try {
      const rows = mustData(await client
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', AWAY_SETTING_KEYS), 'settings.select')
      if (cancelledRef.current) return
      setSettings(readAwaySettings(rows))
      setLoaded(true)
    } catch {
      // Non-fatal — keep the last known value (or "available" on first load)
      if (!cancelledRef.current) setLoaded(true)
    }
  }, [client])

  useEffect(() => {
    if (!enabled) return
    cancelledRef.current = false
    reload()
    const on = (ch, key) => ch.on('postgres_changes', {
      event: '*', schema: 'public', table: 'settings', filter: `setting_key=eq.${key}`,
    }, () => { reload() })
    const stop = subscribeWithReconnect(name, ch => {
      let c = ch
      for (const key of AWAY_SETTING_KEYS) c = on(c, key)
      return c
    }, { client, tag, onReconnect: reload })
    return () => { cancelledRef.current = true; stop() }
  }, [enabled, reload, name, tag, client])

  // Wake up exactly when the end time passes (plus a 30 s safety tick, which
  // also covers a laptop that slept through the timeout).
  useEffect(() => {
    if (!enabled || !settings.away || !settings.until) return
    const left = msUntilFakeUtc(settings.until)
    if (left == null || left <= 0) return
    const t = setTimeout(() => setTick(n => n + 1), Math.min(left + 500, 2_147_000_000))
    const i = setInterval(() => setTick(n => n + 1), 30_000)
    return () => { clearTimeout(t); clearInterval(i) }
  }, [enabled, settings.away, settings.until])

  const now = new Date()
  const state = enabled ? awayState(settings, now) : 'available'
  return {
    loaded,
    settings,
    active: enabled && isAwayActive(settings, now),
    state,
    paused: state === 'pause',
    returnLabel: awayReturnLabel(settings),
    reload,
  }
}

export default useInstructorAway
