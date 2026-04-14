import { supabase } from '@/lib/supabase'

/**
 * Generate a collision-safe work order ID.
 *
 * Shared by useWorkOrders (manual WO creation) and usePMSchedules (PM WO
 * generation) so every code path gets the same collision protection.
 *
 * Algorithm:
 *  1. Try the database counter via get_next_id RPC (p_type = 'work_order').
 *  2. Fallback: derive from the true max across work_orders + work_orders_closed.
 *  3. Verify the candidate ID doesn't already exist in either table.
 *     If a collision is found, increment and retry (up to 10 attempts).
 *  4. After finding a safe ID, sync the counter so subsequent calls start from
 *     the right number (prevents the counter from staying permanently stale).
 */
export async function generateSafeWoId() {
  let woId = null
  let numericId = null
  let counterReturnedId = null // Track what the counter gave us

  // ── Step 1: Primary — database counter ─────────────────────────────────────
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'work_order' })
    if (counter) {
      woId = counter
      numericId = parseInt(counter.replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch (e) {
    console.log('get_next_id not available, using fallback ID generation')
  }

  // ── Step 2: Fallback — derive from max across both tables ──────────────────
  if (!woId) {
    try {
      const [{ data: openMax }, { data: closedMax }] = await Promise.all([
        supabase.from('work_orders').select('wo_id').order('wo_id', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('work_orders_closed').select('wo_id').order('wo_id', { ascending: false }).limit(1).maybeSingle(),
      ])
      const openNum   = openMax?.wo_id  ? parseInt(openMax.wo_id.replace(/\D/g, ''), 10)  : 0
      const closedNum = closedMax?.wo_id ? parseInt(closedMax.wo_id.replace(/\D/g, ''), 10) : 0
      numericId = Math.max(openNum, closedNum, 1100) + 1
      woId = `WO${numericId}`
    } catch (e) {
      // Last resort — timestamp-based (no dash, matches WO#### format)
      numericId = parseInt(Date.now().toString().slice(-6), 10)
      woId = `WO${numericId}`
    }
  }

  // ── Step 3: Collision check — verify ID doesn't exist in either table ──────
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const [{ data: existsOpen }, { data: existsClosed }] = await Promise.all([
      supabase.from('work_orders').select('wo_id').eq('wo_id', woId).maybeSingle(),
      supabase.from('work_orders_closed').select('wo_id').eq('wo_id', woId).maybeSingle(),
    ])

    if (!existsOpen && !existsClosed) {
      // ── Step 4: Sync the counter if we had to bump past the counter value ──
      // This prevents the counter from staying permanently stale so future calls
      // get a correct starting point without needing the collision loop every time.
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'work_order')
          console.log(`WO counter synced: ${counterReturnedId} → ${numericId}`)
        } catch (e) {
          // Non-critical — the collision check will still protect us next time
          console.warn('Counter sync failed (non-critical):', e)
        }
      }

      return woId // Safe — no collision
    }

    // Collision detected — increment and retry
    console.warn(`WO ID collision detected for ${woId}, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`)
    numericId += 1
    woId = `WO${numericId}`
  }

  // If all retries fail, add timestamp suffix to guarantee uniqueness
  console.error('WO ID collision persisted after retries, using timestamp suffix')
  return `WO${numericId}-${Date.now().toString().slice(-4)}`
}

/**
 * Generate a collision-safe work log ID.
 * Uses p_type: 'work_log' for the database counter.
 */
export async function generateSafeLogId() {
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'work_log' })
    if (counter) return counter
  } catch (e) {
    // Fallback below
  }
  return `LOG${Date.now().toString().slice(-8)}`
}
