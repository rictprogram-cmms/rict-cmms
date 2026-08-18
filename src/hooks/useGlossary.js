/**
 * RICT CMMS — useGlossary
 *
 * Data layer for the program glossary (terms + managed categories).
 *
 *  - Read: all authenticated users (students are view-only)
 *  - Write: gated in the UI by the 'manage_glossary' permission (P176);
 *    callers pass the acting user's email for audit columns
 *  - IDs: get_next_id RPC (p_type 'glossary_term' / 'glossary_category',
 *    prefixes GL / GLC) with a collision-checked fallback that syncs the
 *    counter — same pattern as generateSafeWoId
 *  - Timestamps: fake-UTC convention via localToUtcIso()
 *  - Every write uses .select() and validates row count so RLS silent
 *    failures surface as real errors instead of fake successes
 *
 * File: src/hooks/useGlossary.js
 */

import { useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

// Fake-UTC convention: local wall-clock time stored with +00 offset.
function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}+00`
}

/**
 * Collision-safe ID generation for glossary rows.
 * kind: 'term' → counter 'glossary_term', prefix GL, table glossary
 *       'category' → counter 'glossary_category', prefix GLC, table glossary_categories
 */
async function generateSafeGlossaryId(kind) {
  const cfg = kind === 'category'
    ? { counter: 'glossary_category', prefix: 'GLC', table: 'glossary_categories', idCol: 'category_id' }
    : { counter: 'glossary_term', prefix: 'GL', table: 'glossary', idCol: 'term_id' }

  let id = null
  let numericId = null
  let counterReturnedId = null

  // Step 1: database counter
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: cfg.counter })
    if (counter) {
      id = counter
      numericId = parseInt(counter.replace(/\D/g, ''), 10)
      counterReturnedId = numericId
    }
  } catch (e) {
    console.log('get_next_id not available for glossary, using fallback')
  }

  // Step 2: fallback — derive from table max
  if (!id) {
    try {
      const { data: maxRow } = await supabase
        .from(cfg.table)
        .select(cfg.idCol)
        .order(cfg.idCol, { ascending: false })
        .limit(1)
        .maybeSingle()
      const maxNum = maxRow?.[cfg.idCol] ? parseInt(maxRow[cfg.idCol].replace(/\D/g, ''), 10) : 1000
      numericId = maxNum + 1
      id = `${cfg.prefix}${numericId}`
    } catch (e) {
      numericId = parseInt(Date.now().toString().slice(-6), 10)
      id = `${cfg.prefix}${numericId}`
    }
  }

  // Step 3: collision check + retry
  const MAX_RETRIES = 10
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: exists } = await supabase
      .from(cfg.table)
      .select(cfg.idCol)
      .eq(cfg.idCol, id)
      .maybeSingle()

    if (!exists) {
      // Step 4: sync counter if we bumped past it
      if (counterReturnedId !== null && numericId > counterReturnedId) {
        try {
          await supabase
            .from('counters')
            .update({ current_value: numericId, updated_at: new Date().toISOString() })
            .eq('counter_name', cfg.counter)
        } catch (e) {
          console.warn('Glossary counter sync failed (non-critical):', e)
        }
      }
      return id
    }
    numericId += 1
    id = `${cfg.prefix}${numericId}`
  }

  return `${cfg.prefix}${numericId}-${Date.now().toString().slice(-4)}`
}

/**
 * Reserve a batch of collision-safe term IDs (GL####) for bulk import.
 * One counter read + one collision query instead of N round-trips.
 * Syncs the counter to the final max so subsequent single adds continue
 * from the right number.
 */
async function reserveTermIdBatch(count) {
  if (count <= 0) return []

  let startNum = null

  // Prefer the counter value as the starting point
  try {
    const { data: counterRow } = await supabase
      .from('counters')
      .select('current_value')
      .eq('counter_name', 'glossary_term')
      .maybeSingle()
    if (counterRow?.current_value != null) startNum = counterRow.current_value + 1
  } catch (e) {
    // fall through to table max
  }

  // Cross-check against the true table max (whichever is higher wins)
  try {
    const { data: maxRow } = await supabase
      .from('glossary')
      .select('term_id')
      .order('term_id', { ascending: false })
      .limit(1)
      .maybeSingle()
    const maxNum = maxRow?.term_id ? parseInt(maxRow.term_id.replace(/\D/g, ''), 10) : 1000
    if (startNum === null || maxNum + 1 > startNum) startNum = maxNum + 1
  } catch (e) {
    if (startNum === null) startNum = parseInt(Date.now().toString().slice(-6), 10)
  }

  // Build the candidate range, then verify none exist (single IN query).
  // If any collide, shift the whole range past the highest collision and
  // re-check (bounded retries).
  const MAX_RETRIES = 5
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ids = Array.from({ length: count }, (_, i) => `GL${startNum + i}`)
    const { data: existing, error: err } = await supabase
      .from('glossary')
      .select('term_id')
      .in('term_id', ids)
    if (err) throw err
    if (!existing || existing.length === 0) {
      // Sync counter to the end of the reserved range
      try {
        await supabase
          .from('counters')
          .update({ current_value: startNum + count - 1, updated_at: new Date().toISOString() })
          .eq('counter_name', 'glossary_term')
      } catch (e) {
        console.warn('Glossary counter sync failed (non-critical):', e)
      }
      return ids
    }
    const highestCollision = Math.max(
      ...existing.map(r => parseInt(r.term_id.replace(/\D/g, ''), 10))
    )
    startNum = highestCollision + 1
  }
  throw new Error('Could not reserve a safe ID range for import. Please try again.')
}

export default function useGlossary() {
  const [terms, setTerms] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Fetch ────────────────────────────────────────────────────────────────
  const fetchGlossary = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [termsRes, catsRes] = await Promise.all([
        supabase.from('glossary').select('*').order('term', { ascending: true }),
        supabase.from('glossary_categories').select('*').order('category_name', { ascending: true }),
      ])
      if (termsRes.error) throw termsRes.error
      if (catsRes.error) throw catsRes.error
      setTerms(termsRes.data || [])
      setCategories(catsRes.data || [])
    } catch (e) {
      console.error('Glossary fetch failed:', e)
      setError('Could not load the glossary. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Terms ────────────────────────────────────────────────────────────────
  const addTerm = useCallback(async ({ term, definition, categoryId }, userEmail) => {
    const termId = await generateSafeGlossaryId('term')
    const { data, error: err } = await supabase
      .from('glossary')
      .insert({
        term_id: termId,
        term: term.trim(),
        definition: definition.trim(),
        category_id: categoryId || null,
        status: 'Active',
        created_at: localToUtcIso(new Date()),
        created_by: userEmail,
      })
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Insert blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
    return data[0]
  }, [fetchGlossary])

  const updateTerm = useCallback(async (termId, { term, definition, categoryId }, userEmail) => {
    const { data, error: err } = await supabase
      .from('glossary')
      .update({
        term: term.trim(),
        definition: definition.trim(),
        category_id: categoryId || null,
        updated_at: localToUtcIso(new Date()),
        updated_by: userEmail,
      })
      .eq('term_id', termId)
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Update blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
    return data[0]
  }, [fetchGlossary])

  const deleteTerm = useCallback(async (termId) => {
    const { data, error: err } = await supabase
      .from('glossary')
      .delete()
      .eq('term_id', termId)
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Delete blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
  }, [fetchGlossary])

  // ── Categories ───────────────────────────────────────────────────────────
  const addCategory = useCallback(async ({ name, description }, userEmail) => {
    const categoryId = await generateSafeGlossaryId('category')
    const { data, error: err } = await supabase
      .from('glossary_categories')
      .insert({
        category_id: categoryId,
        category_name: name.trim(),
        description: (description || '').trim() || null,
        status: 'Active',
        created_at: localToUtcIso(new Date()),
        created_by: userEmail,
      })
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Insert blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
    return data[0]
  }, [fetchGlossary])

  const updateCategory = useCallback(async (categoryId, { name, description }, userEmail) => {
    const { data, error: err } = await supabase
      .from('glossary_categories')
      .update({
        category_name: name.trim(),
        description: (description || '').trim() || null,
        updated_at: localToUtcIso(new Date()),
        updated_by: userEmail,
      })
      .eq('category_id', categoryId)
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Update blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
    return data[0]
  }, [fetchGlossary])

  const toggleCategoryStatus = useCallback(async (categoryId, currentStatus, userEmail) => {
    const next = currentStatus === 'Active' ? 'Inactive' : 'Active'
    const { data, error: err } = await supabase
      .from('glossary_categories')
      .update({
        status: next,
        updated_at: localToUtcIso(new Date()),
        updated_by: userEmail,
      })
      .eq('category_id', categoryId)
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Update blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
  }, [fetchGlossary])

  /**
   * Hard-delete a category — only when no terms reference it.
   * (The DB FK also blocks this; we check first for a friendly error.)
   */
  const deleteCategory = useCallback(async (categoryId) => {
    const { count, error: countErr } = await supabase
      .from('glossary')
      .select('term_id', { count: 'exact', head: true })
      .eq('category_id', categoryId)
    if (countErr) throw countErr
    if ((count || 0) > 0) {
      throw new Error(`Cannot delete: ${count} term${count === 1 ? '' : 's'} still use this category. Reassign them first, or set the category Inactive.`)
    }
    const { data, error: err } = await supabase
      .from('glossary_categories')
      .delete()
      .eq('category_id', categoryId)
      .select()
    if (err) throw err
    if (!data || data.length === 0) throw new Error('Delete blocked (0 rows returned) — check RLS.')
    await fetchGlossary()
  }, [fetchGlossary])

  /**
   * Bulk import from parsed spreadsheet rows.
   *
   * rows: [{ term, definition, categoryName }] — already validated/deduped
   *       by the caller (GlossaryModal preview step)
   * options.updateExisting: when true, rows matching an existing term
   *       (case-insensitive) update that term's definition/category instead
   *       of being skipped
   *
   * Returns { added, updated, skipped, categoriesCreated } counts.
   * All writes validate returned row counts (RLS silent-failure guard).
   */
  const importTerms = useCallback(async (rows, { updateExisting = false } = {}, userEmail) => {
    if (!rows || rows.length === 0) return { added: 0, updated: 0, skipped: 0, categoriesCreated: 0 }
    const nowIso = localToUtcIso(new Date())

    // ── 1. Resolve categories: reuse existing (case-insensitive), create new ──
    const catByLower = {}
    categories.forEach(c => { catByLower[c.category_name.toLowerCase()] = c.category_id })

    const neededNames = [...new Set(
      rows.map(r => (r.categoryName || '').trim()).filter(Boolean)
        .filter(name => !catByLower[name.toLowerCase()])
    )]

    let categoriesCreated = 0
    for (const name of neededNames) {
      const categoryId = await generateSafeGlossaryId('category')
      const { data, error: err } = await supabase
        .from('glossary_categories')
        .insert({
          category_id: categoryId,
          category_name: name,
          status: 'Active',
          created_at: nowIso,
          created_by: userEmail,
        })
        .select()
      if (err) throw err
      if (!data || data.length === 0) throw new Error('Category insert blocked (0 rows) — check RLS.')
      catByLower[name.toLowerCase()] = categoryId
      categoriesCreated += 1
    }

    // ── 2. Split rows into inserts vs updates vs skips ──
    const existingByLower = {}
    terms.forEach(t => { existingByLower[t.term.toLowerCase()] = t })

    const toInsert = []
    const toUpdate = []
    let skipped = 0

    rows.forEach(r => {
      const catId = r.categoryName ? (catByLower[r.categoryName.trim().toLowerCase()] || null) : null
      const existing = existingByLower[r.term.trim().toLowerCase()]
      if (existing) {
        if (updateExisting) {
          toUpdate.push({ termId: existing.term_id, definition: r.definition.trim(), categoryId: catId })
        } else {
          skipped += 1
        }
      } else {
        toInsert.push({ term: r.term.trim(), definition: r.definition.trim(), categoryId: catId })
      }
    })

    // ── 3. Batch insert new terms with reserved IDs ──
    let added = 0
    if (toInsert.length > 0) {
      const ids = await reserveTermIdBatch(toInsert.length)
      const insertRows = toInsert.map((r, i) => ({
        term_id: ids[i],
        term: r.term,
        definition: r.definition,
        category_id: r.categoryId,
        status: 'Active',
        created_at: nowIso,
        created_by: userEmail,
      }))
      const { data, error: err } = await supabase
        .from('glossary')
        .insert(insertRows)
        .select()
      if (err) throw err
      if (!data || data.length !== insertRows.length) {
        throw new Error(`Import incomplete: expected ${insertRows.length} inserts, got ${data?.length || 0}. Check RLS.`)
      }
      added = data.length
    }

    // ── 4. Updates (per-row — different values per row) ──
    let updated = 0
    for (const u of toUpdate) {
      const { data, error: err } = await supabase
        .from('glossary')
        .update({
          definition: u.definition,
          category_id: u.categoryId,
          updated_at: nowIso,
          updated_by: userEmail,
        })
        .eq('term_id', u.termId)
        .select()
      if (err) throw err
      if (!data || data.length === 0) throw new Error('Update blocked (0 rows) — check RLS.')
      updated += 1
    }

    await fetchGlossary()
    return { added, updated, skipped, categoriesCreated }
  }, [terms, categories, fetchGlossary])

  return {
    terms,
    categories,
    loading,
    error,
    fetchGlossary,
    addTerm,
    updateTerm,
    deleteTerm,
    addCategory,
    updateCategory,
    toggleCategoryStatus,
    deleteCategory,
    importTerms,
  }
}
