import { supabase } from '@/lib/supabase'

/**
 * Collision-safe ID generators for the Equipment Scheduling module.
 *
 * Mirrors the pattern used in `generateSafeWoId.js`:
 *   1. Try the database counter via get_next_id RPC (atomic, authoritative).
 *   2. Fallback: derive from MAX(existing id) if RPC is unavailable.
 *   3. Verify the candidate ID doesn't already exist; retry with increment.
 *   4. Sync the counter back if we had to skip past its value (prevents drift).
 */

const EQ_PREFIX = 'EQ'
const EB_PREFIX = 'EB'
const EQ_PAD    = 4   // EQ0001
const EB_PAD    = 6   // EB000001

function pad(n, width) {
  return String(n).padStart(width, '0')
}

// ─── Equipment (EQ####) ───────────────────────────────────────────────────────

export async function generateSafeEquipmentId() {
  let id = null
  let numericId = null
  let counterReturnedId = null

  // Step 1: counter RPC
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'equipment' })
    if (counter) {
      id = counter
      numericId = parseInt(counter.replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch (e) {
    // Fall through to manual MAX lookup
  }

  // Step 2: fallback — derive from existing rows
  if (!id) {
    try {
      const { data: maxRow } = await supabase
        .from('lab_equipment')
        .select('equipment_id')
        .order('equipment_id', { ascending: false })
        .limit(1)
        .maybeSingle()
      const maxNum = maxRow?.equipment_id ? parseInt(maxRow.equipment_id.replace(/\D/g, ''), 10) : 0
      numericId = Math.max(maxNum, 1000) + 1
      id = EQ_PREFIX + pad(numericId, EQ_PAD)
    } catch (e) {
      numericId = parseInt(Date.now().toString().slice(-6), 10)
      id = EQ_PREFIX + pad(numericId, EQ_PAD)
    }
  }

  // Step 3: collision check loop
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await supabase
      .from('lab_equipment')
      .select('equipment_id')
      .eq('equipment_id', id)
      .maybeSingle()

    if (!exists) {
      // Step 4: sync counter if we bumped past it
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'equipment')
        } catch (e) {
          // Non-critical
        }
      }
      return id
    }

    numericId += 1
    id = EQ_PREFIX + pad(numericId, EQ_PAD)
  }

  // Last resort — timestamp suffix guarantees uniqueness
  return `${EQ_PREFIX}${pad(numericId, EQ_PAD)}-${Date.now().toString().slice(-4)}`
}

// ─── Equipment Bookings (EB######) ────────────────────────────────────────────

export async function generateSafeEquipmentBookingId() {
  let id = null
  let numericId = null
  let counterReturnedId = null

  // Step 1: counter RPC
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'equipment_booking' })
    if (counter) {
      id = counter
      numericId = parseInt(counter.replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch (e) {
    // Fall through
  }

  // Step 2: fallback
  if (!id) {
    try {
      const { data: maxRow } = await supabase
        .from('equipment_bookings')
        .select('booking_id')
        .order('booking_id', { ascending: false })
        .limit(1)
        .maybeSingle()
      const maxNum = maxRow?.booking_id ? parseInt(maxRow.booking_id.replace(/\D/g, ''), 10) : 0
      numericId = Math.max(maxNum, 100000) + 1
      id = EB_PREFIX + pad(numericId, EB_PAD)
    } catch (e) {
      numericId = parseInt(Date.now().toString().slice(-8), 10)
      id = EB_PREFIX + pad(numericId, EB_PAD)
    }
  }

  // Step 3: collision loop
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await supabase
      .from('equipment_bookings')
      .select('booking_id')
      .eq('booking_id', id)
      .maybeSingle()

    if (!exists) {
      // Step 4: counter sync
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'equipment_booking')
        } catch (e) {
          // Non-critical
        }
      }
      return id
    }

    numericId += 1
    id = EB_PREFIX + pad(numericId, EB_PAD)
  }

  return `${EB_PREFIX}${pad(numericId, EB_PAD)}-${Date.now().toString().slice(-4)}`
}
