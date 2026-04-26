import { supabase } from '@/lib/supabase'

/**
 * Generate a collision-safe asset ID.
 *
 * Mirrors the generateSafeWoId pattern so every code path (Add Asset,
 * Duplicate Asset, any future bulk import) gets the same protection and
 * the counter never drifts.
 *
 * Algorithm:
 *  1. Try the database counter via get_next_id RPC (p_type = 'asset').
 *  2. Fallback: derive from MAX of existing counter-format AST#### IDs.
 *     Legacy timestamp-format IDs like AST-1773769749222 are deliberately
 *     IGNORED so they don't blow up the counter to a 13-digit number.
 *  3. Verify the candidate ID doesn't already exist; bump and retry on collision.
 *  4. After finding a safe ID, sync the counters table so the next call starts
 *     from the right number — prevents permanent counter drift.
 *
 * Returns the asset_id string (e.g. "AST1022"). Always succeeds — the final
 * timestamp-suffix branch guarantees a unique value even in pathological cases.
 */
export async function generateSafeAssetId() {
  let assetId = null
  let numericId = null
  let counterReturnedId = null  // Track what the counter gave us, for sync logic

  // ── Step 1: Primary — database counter ─────────────────────────────────────
  try {
    const { data: counter, error } = await supabase.rpc('get_next_id', { p_type: 'asset' })
    if (error) {
      console.warn('get_next_id(asset) RPC error, falling back:', error.message)
    } else if (counter) {
      assetId = counter
      numericId = parseInt(String(counter).replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch (e) {
    console.warn('get_next_id(asset) threw, falling back:', e.message)
  }

  // ── Step 2: Fallback — derive from MAX of clean AST#### IDs ────────────────
  if (!assetId) {
    try {
      // Pull recent assets and parse client-side. We deliberately filter out
      // legacy AST-<timestamp> rows because parsing them as numbers would
      // produce 13-digit IDs and corrupt the counter forever.
      const { data: rows } = await supabase
        .from('assets')
        .select('asset_id')
        .like('asset_id', 'AST%')
        .order('asset_id', { ascending: false })
        .limit(500)

      let maxNum = 1020  // Floor — safe minimum if the table is empty/all-legacy
      ;(rows || []).forEach(r => {
        // Only count clean format: "AST" + 3-6 digits, nothing else (no hyphen)
        const match = /^AST(\d{3,6})$/.exec(r.asset_id || '')
        if (match) {
          const n = parseInt(match[1], 10)
          if (n > maxNum) maxNum = n
        }
      })
      numericId = maxNum + 1
      assetId = `AST${numericId}`
    } catch (e) {
      // Last resort — a 6-digit timestamp slice keeps the AST#### shape.
      // Far less ugly than the full Date.now() and still effectively unique.
      console.error('Asset MAX-id fallback failed, using timestamp slice:', e.message)
      numericId = parseInt(Date.now().toString().slice(-6), 10)
      assetId = `AST${numericId}`
    }
  }

  // ── Step 3: Collision check — verify ID doesn't already exist ──────────────
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await supabase
      .from('assets')
      .select('asset_id')
      .eq('asset_id', assetId)
      .maybeSingle()

    if (!exists) {
      // ── Step 4: Sync the counter if we had to bump past its value ──
      // Without this, repeated counter-RPC failures would keep producing
      // duplicate fallback IDs forever. Aligning the counter to numericId
      // means the NEXT call gets a fresh number even if the RPC stays broken.
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'asset')
          console.log(`Asset counter synced: ${counterReturnedId} → ${numericId}`)
        } catch (e) {
          console.warn('Asset counter sync failed (non-critical):', e.message)
        }
      } else if (counterReturnedId === null && numericId > 1020) {
        // RPC failed entirely — push the counter up to match reality
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', 'asset')
          console.log(`Asset counter realigned (RPC was unavailable): now ${numericId}`)
        } catch (e) {
          console.warn('Asset counter realignment failed (non-critical):', e.message)
        }
      }

      return assetId  // Safe — no collision
    }

    // Collision detected — bump and retry
    console.warn(`Asset ID collision detected for ${assetId}, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`)
    numericId += 1
    assetId = `AST${numericId}`
  }

  // Pathological fallback — guaranteed unique even if everything else broke
  console.error('Asset ID collision persisted after retries, using timestamp suffix')
  return `AST${numericId}-${Date.now().toString().slice(-4)}`
}
