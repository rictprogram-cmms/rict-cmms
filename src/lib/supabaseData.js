/**
 * RICT CMMS — supabaseData
 *
 * mustData(result, label)
 *
 * WHY THIS EXISTS
 * ───────────────
 * A Supabase query never throws on failure. It resolves to
 * { data: null, error }. Code written as
 *
 *     const { data } = await supabase.from('lab_signup').select(...)
 *     setSignups(data || [])
 *
 * therefore treats a network blip, an expired token, or an RLS denial as
 * "the table is empty" — which is how the Lab Status kiosk blanked its
 * roster, how the Time Clock could offer Punch In to someone already
 * punched in, and how a student's attendance score could briefly read 0%.
 *
 * mustData() turns that silent null into a thrown Error so the caller's
 * catch block can keep the last-known-good state and report the failure.
 *
 * USAGE
 * ─────
 *   const rows = mustData(await supabase.from('lab_signup').select('*'), 'lab_signup')
 *
 *   const [a, b] = await Promise.all([q1, q2])
 *   const aRows = mustData(a, 'time_clock')
 *   const bRows = mustData(b, 'profiles')
 *
 * `label` is included in the error message so the console shows which
 * table failed. The thrown Error carries the original Supabase error as
 * `.cause`. `isRlsBlock(err)` is a small helper for callers that want to
 * word a permissions failure differently from a connection failure.
 *
 * File: src/lib/supabaseData.js
 */

export function mustData(result, label = 'query') {
  if (!result) throw new Error(`${label}: no response`)
  if (result.error) {
    const err = new Error(`${label}: ${result.error.message || 'query failed'}`)
    err.cause = result.error
    err.code = result.error.code
    throw err
  }
  return result.data
}

/** True when the error looks like an RLS / permission denial rather than a network problem. */
export function isRlsBlock(err) {
  const code = err?.code || err?.cause?.code
  const msg = String(err?.message || '').toLowerCase()
  return code === '42501' || code === 'PGRST301' || msg.includes('row-level security') || msg.includes('permission denied')
}

/**
 * assertWrite(result, label)
 *
 * For INSERT / UPDATE / UPSERT / DELETE chains. Append `.select()` to the
 * write so Supabase returns the affected rows, then pass the result through
 * this helper. It preserves the { data, error } shape so existing
 * `if (error) …` handling keeps working, but converts a "success" that
 * touched ZERO rows into an error — that is what an RLS denial looks like
 * (Supabase does not raise; it silently affects nothing).
 *
 *   const { error } = assertWrite(
 *     await supabase.from('orders').update({ status }).eq('order_id', id).select(),
 *     'orders.update'
 *   )
 *   if (error) throw error
 */
export function assertWrite(result, label = 'write') {
  if (!result) return { data: null, error: { message: `${label}: no response`, code: 'NO_RESPONSE' } }
  if (result.error) return result
  const rows = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : [])
  if (rows.length === 0) {
    return { ...result, data: [], error: { message: `${label}: no rows were affected — you may not have permission for this change`, code: 'NO_ROWS' } }
  }
  return result
}
