import { supabase as defaultSupabase } from '@/lib/supabase'

/**
 * Generate a collision-safe time_clock record ID (TC######).
 *
 * Shared by every code path that inserts into time_clock so we get one
 * authoritative implementation with drift protection and collision retry.
 * Replaces the per-file MAX(record_id) lookup pattern that was duplicated
 * across TimeClockPage, useTimeCards, useWeeklyLabs, NotificationBell, and
 * useVolunteerHours.
 *
 * Algorithm (mirrors generateSafeWoId / generateSafeEquipmentIds):
 *   1. Try the database counter via get_next_id RPC (p_type = 'time_clock').
 *   2. Fallback: derive from the true MAX(record_id) in time_clock.
 *   3. Verify the candidate ID doesn't already exist; retry with increment
 *      up to 10 times if collisions occur (handles concurrent inserts).
 *   4. Sync the counter back if we bumped past its value (prevents drift
 *      from accumulating again the way it did before this helper landed).
 *
 * Client parameter:
 *   The TimeClockPage kiosk runs unauthenticated and creates its own
 *   standalone Supabase client (autoRefreshToken / persistSession both off)
 *   so it can write to time_clock without any session. Pass that client in
 *   when calling from the kiosk; everywhere else the shared singleton works.
 *
 * @param {object} [supabaseClient] Optional Supabase client. Defaults to the
 *   shared singleton from '@/lib/supabase'. Pass the kiosk's standalone
 *   client when calling from TimeClockPage.
 * @returns {Promise<string>} A unique TC###### record_id (or, in the worst
 *   case after 10 collision retries, a TC######-#### timestamp-suffixed id).
 *
 * File: src/utils/generateSafeTcId.js
 */

const TC_PREFIX = 'TC'
const TC_PAD = 6 // TC######

function pad(n, width) {
  return String(n).padStart(width, '0')
}

export async function generateSafeTcId(supabaseClient) {
  const sb = supabaseClient || defaultSupabase

  let tcId = null
  let numericId = null
  let counterReturnedId = null // Track what the counter gave us so we can sync if we bumped past it

  // ── Step 1: Primary — database counter via RPC ─────────────────────────────
  try {
    const { data: counter } = await sb.rpc('get_next_id', { p_type: 'time_clock' })
    if (counter) {
      tcId = counter
      numericId = parseInt(String(counter).replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch (e) {
    // RPC not available or failed — fall through to MAX lookup
    console.log('get_next_id not available for time_clock, using fallback ID generation')
  }

  // ── Step 2: Fallback — derive from MAX(record_id) ─────────────────────────
  if (!tcId || !Number.isFinite(numericId)) {
    try {
      const { data: maxRow } = await sb
        .from('time_clock')
        .select('record_id')
        .like('record_id', 'TC%')
        .order('record_id', { ascending: false })
        .limit(1)
        .maybeSingle()
      const maxNum = maxRow?.record_id
        ? parseInt(String(maxRow.record_id).replace(/\D/g, ''), 10)
        : 0
      // Floor of 1000 keeps IDs at 4+ significant digits; +1 to advance past the max
      numericId = Math.max(maxNum, 1000) + 1
      tcId = TC_PREFIX + pad(numericId, TC_PAD)
    } catch (e) {
      // Last resort — timestamp-derived to guarantee uniqueness
      numericId = parseInt(Date.now().toString().slice(-6), 10) || 100000
      tcId = TC_PREFIX + pad(numericId, TC_PAD)
    }
  }

  // ── Step 3: Collision check loop ───────────────────────────────────────────
  // The RPC may return a stale value if the counter has drifted, or two
  // concurrent inserts can race on the same number. Verify before we use it.
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await sb
      .from('time_clock')
      .select('record_id')
      .eq('record_id', tcId)
      .maybeSingle()

    if (!exists) {
      // ── Step 4: Counter sync — if we had to bump past the counter value,
      // write the corrected value back so future calls start from the right
      // number without needing the collision loop every time.
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await sb
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'time_clock')
          console.log(`TC counter synced: ${counterReturnedId} → ${numericId}`)
        } catch (e) {
          // Non-critical — collision check protects subsequent calls
          console.warn('TC counter sync failed (non-critical):', e?.message || e)
        }
      }
      return tcId
    }

    // Collision — increment and retry
    console.warn(`TC ID collision detected for ${tcId}, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`)
    numericId += 1
    tcId = TC_PREFIX + pad(numericId, TC_PAD)
  }

  // If 10 retries can't find a free slot, append a timestamp suffix to guarantee uniqueness.
  // The "-####" suffix is the same escape hatch used by generateSafeWoId.
  console.error('TC ID collision persisted after retries, using timestamp suffix')
  return `${TC_PREFIX}${pad(numericId, TC_PAD)}-${Date.now().toString().slice(-4)}`
}

export default generateSafeTcId
