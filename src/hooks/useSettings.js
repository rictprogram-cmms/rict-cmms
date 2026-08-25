import { useState, useEffect, useCallback, useRef } from 'react'
import { assertWrite } from '@/lib/supabaseData'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { isSuperAdminEmail } from '@/lib/superAdmin'

// ─── Helper: unique realtime channel suffix ──────────────────────────────────
// Per project rule: channel names must be unique per mounted component to
// prevent conflicts when multiple instances of a hook are alive at once.
function makeChannelSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── General Settings ────────────────────────────────────────────────────────

export function useSettings() {
  const [settings, setSettings] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)
  const channelIdRef = useRef(`settings-changes-${makeChannelSuffix()}`)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .order('category')
        .order('setting_key')
      if (error) throw error
      setSettings(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Settings fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when settings change (unique channel per mount)
  useEffect(() => {
    const channel = supabase
      .channel(channelIdRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { settings, loading, refresh: fetch }
}

export function useSettingsActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  /**
   * Update (or insert) a setting.
   *
   * Options:
   *   - category, description: included on INSERT for brand-new settings so they
   *     show up in the right group in the UI. Backward compatible.
   *   - silent: when true, suppress the success toast. Errors still toast.
   *     Used by auto-save flows so we don't toast on every keystroke.
   */
  const updateSetting = async (key, value, meta = {}) => {
    const { silent = false, category, description } = meta
    setSaving(true)
    try {
      const { data: existing } = await supabase
        .from('settings')
        .select('setting_key')
        .eq('setting_key', key)
        .maybeSingle()

      if (existing) {
        const { data: rows, error } = await supabase.from('settings').update({
          setting_value: value,
          updated_at: new Date().toISOString(),
          updated_by: userName
        }).eq('setting_key', key).select()
        if (error) throw error
        if (!rows || rows.length === 0) {
          toast.error('Setting update failed — you may not have permission.')
          return false
        }
      } else {
        // Brand-new setting: tag with category/description if provided.
        const insertPayload = {
          setting_key: key,
          setting_value: value,
          updated_at: new Date().toISOString(),
          updated_by: userName
        }
        if (category)    insertPayload.category    = category
        if (description) insertPayload.description = description

        const { data: rows, error } = await supabase.from('settings')
          .insert(insertPayload).select()
        if (error) throw error
        if (!rows || rows.length === 0) {
          toast.error('Setting create failed — you may not have permission.')
          return false
        }
      }
      if (!silent) toast.success('Setting updated')
      return true
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, updateSetting }
}

// ─── Generic CRUD for lookup tables ──────────────────────────────────────────

export function useLookupTable(tableName, idColumn, nameColumn, orderColumn) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const channelIdRef = useRef(`lookup-${tableName}-${makeChannelSuffix()}`)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .order(orderColumn || nameColumn || idColumn)
      if (error) throw error
      setItems(data || [])
    } catch (err) {
      console.error(`${tableName} fetch error:`, err)
    } finally {
      setLoading(false)
    }
  }, [tableName])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when the lookup table changes (unique channel per mount)
  useEffect(() => {
    const channel = supabase
      .channel(channelIdRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: tableName }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [tableName, fetch])

  return { items, loading, refresh: fetch }
}

/**
 * Lookup-table ID generator with two-tier strategy.
 *
 * Tier 1 (default): atomic `get_next_id` RPC. Race-safe at DB level. This is
 *   the preferred path used by the rest of the app (work_order, asset, etc.).
 *
 * Tier 2 (fallback / drift recovery): drift-resistant client-side max scan.
 *   Reads `counters` AND the actual MAX numeric ID from the target table,
 *   uses `MAX(counter, table_max) + 1`, and writes the corrected value back
 *   to `counters`. Used when:
 *     - the RPC fails or returns null, or
 *     - caller passes `forceClient: true` (used for retry-after-23505)
 *
 * Returns a fully prefixed ID string (e.g. "INV2006") or `null` if no counter
 * is configured for this table.
 */
async function generateLookupId(counterName, tableName, idColumn, options = {}) {
  const { forceClient = false } = options

  // ── Tier 1: atomic RPC ─────────────────────────────────────────────────────
  if (!forceClient) {
    try {
      const { data: rpcId, error: rpcErr } = await supabase.rpc('get_next_id', { p_type: counterName })
      if (!rpcErr && rpcId) return rpcId
      if (rpcErr) console.warn(`generateLookupId: RPC error for ${counterName}, falling through:`, rpcErr.message)
    } catch (e) {
      console.warn(`generateLookupId: RPC threw for ${counterName}, falling through:`, e.message)
    }
  }

  // ── Tier 2: drift-resistant client-side ────────────────────────────────────
  // 1. Read counter row (for current_value + prefix)
  const { data: counter, error: counterErr } = await supabase
    .from('counters')
    .select('current_value, prefix')
    .eq('counter_name', counterName)
    .maybeSingle()

  if (counterErr || !counter) return null

  const counterVal = counter.current_value || 1000
  const prefix = counter.prefix || ''

  // 2. Read actual max numeric ID from the target table (drift detection).
  //    Note: lex-sort is unsafe (e.g. "INV9999" > "INV10000" lexically), so
  //    we pull the column and compute max numerically in JS.
  //    Lookup tables are small (<2000 rows in normal use) so this is cheap.
  let tableMax = 0
  try {
    const { data: rows } = await supabase.from(tableName).select(idColumn)
    if (rows && rows.length > 0) {
      for (const r of rows) {
        const raw = (r[idColumn] || '').toString()
        const digits = raw.replace(/\D/g, '')
        const n = digits ? parseInt(digits, 10) : 0
        if (Number.isFinite(n) && n > tableMax) tableMax = n
      }
    }
  } catch (e) {
    console.warn(`generateLookupId: max scan failed for ${tableName}, using counter only:`, e.message)
  }

  // 3. Use whichever is higher, then +1
  const nextVal = Math.max(counterVal, tableMax) + 1

  // 4. Heal the counter row so future RPC calls return correct values
  try {
    await supabase.from('counters').update({
      current_value: nextVal,
      updated_at: new Date().toISOString()
    }).eq('counter_name', counterName)
  } catch (e) {
    // Non-fatal — we still have a valid ID to attempt the insert with
    console.warn(`generateLookupId: counter update failed for ${counterName}:`, e.message)
  }

  return `${prefix}${nextVal}`
}

export function useLookupActions(tableName, idColumn) {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  const addItem = async (data) => {
    setSaving(true)
    try {
      const wasAutoGen = !data[idColumn]
      const counterName = getCounterName(tableName)

      // Auto-generate ID if not provided (Tier 1: RPC)
      if (wasAutoGen) {
        const newId = await generateLookupId(counterName, tableName, idColumn)
        if (newId) data[idColumn] = newId
        // If null (no counter configured), let the insert fail naturally below.
      }

      // Insert with retry-on-duplicate-key. On collision, switch to the
      // drift-resistant client path (which heals the counter + computes a
      // post-drift safe ID) and retry up to 3 times total.
      const maxAttempts = wasAutoGen ? 3 : 1
      let inserted = null
      let lastError = null

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { data: rows, error } = await supabase.from(tableName).insert(data).select()

        if (!error) {
          if (!rows || rows.length === 0) {
            // RLS blocked the insert — preserve original message
            toast.error('Add failed — you may not have permission.')
            return
          }
          inserted = rows
          break
        }

        lastError = error

        // 23505 = unique_violation. If we auto-gen'd and have retries left,
        // force the drift-resistant client path and retry.
        if (error.code === '23505' && wasAutoGen && attempt < maxAttempts - 1) {
          const retryId = await generateLookupId(counterName, tableName, idColumn, { forceClient: true })
          if (retryId) {
            data[idColumn] = retryId
            continue
          }
        }

        // Non-retryable, or retries exhausted — throw to outer catch
        throw error
      }

      if (!inserted) return

      // Audit
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action: 'Create',
          entity_type: tableName,
          entity_id: data[idColumn] || '',
          details: `Created ${tableName}: ${JSON.stringify(data)}`
        })
      } catch {}

      toast.success('Added successfully')
    } catch (err) {
      // Friendlier message for unique-violation; otherwise show raw message
      if (err && err.code === '23505') {
        toast.error('Could not generate a unique ID — please refresh and try again.')
      } else {
        toast.error(err.message || 'Add failed')
      }
      throw err
    } finally {
      setSaving(false)
    }
  }

  const updateItem = async (id, updates) => {
    setSaving(true)
    try {
      const { data: rows, error } = await supabase.from(tableName).update(updates).eq(idColumn, id).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Update failed — you may not have permission.')
        return
      }

      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action: 'Update',
          entity_type: tableName,
          entity_id: id,
          details: `Updated ${tableName}`
        })
      } catch {}

      toast.success('Updated successfully')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const deleteItem = async (id) => {
    setSaving(true)
    try {
      const { data: rows, error } = await supabase.from(tableName).delete().eq(idColumn, id).select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        toast.error('Delete failed — you may not have permission.')
        return
      }

      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action: 'Delete',
          entity_type: tableName,
          entity_id: id,
          details: `Deleted from ${tableName}`
        })
      } catch {}

      toast.success('Deleted')
    } catch (err) {
      toast.error(err.message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  return { saving, addItem, updateItem, deleteItem }
}

// Map table names to counter names
function getCounterName(tableName) {
  const map = {
    categories: 'category',
    asset_locations: 'asset_location',
    inventory_locations: 'inventory_location',
    vendors: 'vendor',
    wo_status: 'wo_status',
    classes: 'class',
  }
  return map[tableName] || tableName
}

// ─── Specific table hooks ────────────────────────────────────────────────────

export function useCategories() { return useLookupTable('categories', 'category_id', 'category_name') }
export function useCategoryActions() { return useLookupActions('categories', 'category_id') }

export function useAssetLocations() { return useLookupTable('asset_locations', 'location_id', 'location_name') }
export function useAssetLocationActions() { return useLookupActions('asset_locations', 'location_id') }

export function useInventoryLocations() { return useLookupTable('inventory_locations', 'location_id', 'location_name') }
export function useInventoryLocationActions() { return useLookupActions('inventory_locations', 'location_id') }

export function useVendorsList() { return useLookupTable('vendors', 'vendor_id', 'vendor_name') }
export function useVendorActions() { return useLookupActions('vendors', 'vendor_id') }

export function useWOStatuses() { return useLookupTable('wo_status', 'status_id', 'status_name', 'display_order') }
export function useWOStatusActions() { return useLookupActions('wo_status', 'status_id') }

export function useClasses() { return useLookupTable('classes', 'class_id', 'course_id') }
export function useClassActions() { return useLookupActions('classes', 'class_id') }

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY REMINDERS — per-class messages + append-only history
//
// Replaces the legacy `alldone_weekly_reminder` setting. Two tables are involved:
//   • weekly_reminders   — current state, one global row + one per active class
//   • reminder_history   — append-only audit (DB trigger prunes to last 100/scope)
//
// Patterns used:
//   • Unique realtime channel names (per-mount suffix)
//   • IDs via get_next_id RPC with classId-aware delete/upsert (no client-side
//     fallback needed — these tables are tiny, racey only across instructors)
//   • Audit log row per save (entity_type='weekly_reminders')
//   • Email-based RLS: writes gated to Instructor / Super Admin in the policy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * useWeeklyReminders — subscribes to the entire weekly_reminders table.
 * Returns an array of rows: at most one with class_id IS NULL (global) and
 * zero-to-many with a specific class_id. Used by the Settings tabbed UI and by
 * the Mark All Done modal (which client-side filters to the student's classes).
 */
export function useWeeklyReminders() {
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)
  const channelIdRef = useRef(`weekly-reminders-${makeChannelSuffix()}`)

  const fetch = useCallback(async () => {
    // Only show loading on initial mount — silent refresh on realtime updates
    // so the editor doesn't unmount mid-keystroke (was causing flicker on save).
    if (!hasLoadedRef.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('weekly_reminders')
        .select('*')
      if (error) throw error
      setReminders(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('weekly_reminders fetch error:', err)
      setReminders([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    const channel = supabase
      .channel(channelIdRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_reminders' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { reminders, loading, refresh: fetch }
}

/**
 * useWeeklyReminderActions — single `setReminder(classId, message, classLabel)` call:
 *   • classId === null    → global reminder
 *   • classId === '<id>'  → reminder for that class
 *   • empty/whitespace message → DELETES the row (clear the reminder)
 *   • non-empty message → UPSERT (insert if missing, update if present)
 *
 * Always appends a row to reminder_history with old + new messages. Skips
 * silently if the message is unchanged.
 */
export function useWeeklyReminderActions() {
  const { profile } = useAuth()
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''
  const [saving, setSaving] = useState(false)

  /**
   * setReminder — upsert a reminder row in any of the three scopes.
   *
   * @param {string|null} classId    Class ID (null for global)
   * @param {string}      newMessage Message text (empty/whitespace = delete row)
   * @param {string}      classLabel Human-readable label for history/audit
   * @param {string|null} userEmail  Student email (null for global or per-class)
   *
   * Scope rules:
   *   classId NULL,   userEmail NULL   → Global
   *   classId set,    userEmail NULL   → Per-class
   *   classId set,    userEmail set    → Per-student (NEW)
   *   classId NULL,   userEmail set    → DISALLOWED (no use case)
   *
   * Behavior:
   *   • Reads existing row in the same scope (4-way NULL match)
   *   • Empty message → DELETE; non-empty → UPDATE or INSERT
   *   • Writes audit_log entry (entity_id includes user_email when present)
   *   • Writes reminder_history entry ONLY for global + per-class scopes
   *     (the existing reminder_history table has no user_email column;
   *     audit_log captures per-student changes fully)
   *
   * Backward compatible: callers that omit userEmail still hit the
   * existing global / per-class behavior with no change.
   */
  const setReminder = useCallback(async (classId, newMessage, classLabel, userEmail = null) => {
    setSaving(true)
    const trimmed = (newMessage || '').trim()
    const cid = classId || null
    const uem = userEmail || null

    // Guard: per-student rows MUST have a class_id
    if (uem && !cid) {
      setSaving(false)
      throw new Error('A per-student reminder must be scoped to a class.')
    }

    const label = classLabel || (cid || 'All Classes')
    const scopeLabel = uem ? `${label} → ${uem}` : label

    // Helper: apply the scope filters (class_id + user_email) to a query.
    // Uses .eq() when the value is set, .is(null) when null.
    const applyScope = (q) => {
      const q1 = cid ? q.eq('class_id', cid) : q.is('class_id', null)
      return uem ? q1.eq('user_email', uem) : q1.is('user_email', null)
    }

    try {
      // 1. Read existing row in this scope
      const { data: existing, error: selErr } = await applyScope(
        supabase.from('weekly_reminders').select('*')
      ).maybeSingle()
      if (selErr) throw selErr
      const oldMessage = existing?.message || ''

      // 2. Short-circuit if no change
      if (oldMessage === trimmed) { setSaving(false); return true }

      // 3. Delete vs upsert based on trimmed length
      let action = 'Update'
      if (trimmed === '') {
        if (!existing) { setSaving(false); return true }
        action = 'Clear'
        const { error: delErr } = await applyScope(
          supabase.from('weekly_reminders').delete()
        )
        if (delErr) throw delErr
      } else if (existing) {
        const { error: updErr } = await applyScope(
          supabase.from('weekly_reminders')
            .update({
              message: trimmed,
              updated_at: new Date().toISOString(),
              updated_by: userName,
            })
        )
        if (updErr) throw updErr
      } else {
        action = 'Create'
        const { data: newId, error: idErr } = await supabase
          .rpc('get_next_id', { p_type: 'weekly_reminder' })
        if (idErr || !newId) throw idErr || new Error('Failed to generate reminder ID')
        const { error: insErr } = assertWrite(
      await supabase
          .from('weekly_reminders')
          .insert({
            id: newId,
            class_id: cid,
            user_email: uem,
            message: trimmed,
            updated_at: new Date().toISOString(),
            updated_by: userName,
          }).select(),
      'weekly_reminders.insert'
    )
        if (insErr) throw insErr
      }

      // 4. Append history row — global + per-class only.
      // reminder_history has no user_email column; per-student changes are
      // fully captured by audit_log below.
      if (!uem) {
        try {
          const { data: histId } = await supabase
            .rpc('get_next_id', { p_type: 'reminder_history' })
          if (histId) {
            await supabase.from('reminder_history').insert({
              id: histId,
              class_id: cid,
              class_label: label,
              old_message: oldMessage,
              new_message: trimmed,
              changed_at: new Date().toISOString(),
              changed_by: userName,
            })
          }
        } catch (e) {
          console.warn('reminder_history insert failed:', e.message)
        }
      }

      // 5. Audit (best-effort)
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name: userName,
          action,
          entity_type: 'weekly_reminders',
          entity_id: uem ? `${cid}::${uem}` : (cid || 'GLOBAL'),
          field_changed: 'message',
          old_value: oldMessage,
          new_value: trimmed,
          details: `Weekly reminder for ${scopeLabel}`,
        })
      } catch {}

      return true
    } catch (err) {
      const msg = err?.message || 'Save failed'
      toast.error('Failed to save reminder: ' + msg)
      throw err
    } finally {
      setSaving(false)
    }
  }, [userName, profile?.email])

  return { saving, setReminder }
}

/**
 * useReminderHistory(scopeFilter)
 *   scopeFilter:
 *     'all'        → all scopes (default)
 *     null         → global only (class_id IS NULL)
 *     '<class_id>' → that class only
 *
 * Limited to 100 rows server-side (DB also auto-prunes to 100/scope).
 * Sorted newest first.
 */
export function useReminderHistory(scopeFilter = 'all') {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)
  const channelIdRef = useRef(`reminder-history-${makeChannelSuffix()}`)

  const fetch = useCallback(async () => {
    // Silent refresh after initial load — see same pattern in useWeeklyReminders.
    if (!hasLoadedRef.current) setLoading(true)
    try {
      let q = supabase
        .from('reminder_history')
        .select('*')
        .order('changed_at', { ascending: false })
        .limit(100)
      if (scopeFilter === null) {
        q = q.is('class_id', null)
      } else if (scopeFilter && scopeFilter !== 'all') {
        q = q.eq('class_id', scopeFilter)
      }
      const { data, error } = await q
      if (error) throw error
      setHistory(data || [])
      hasLoadedRef.current = true
    } catch (err) {
      console.error('reminder_history fetch error:', err)
      setHistory([])
    } finally {
      setLoading(false)
    }
  }, [scopeFilter])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    const channel = supabase
      .channel(channelIdRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reminder_history' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { history, loading, refresh: fetch }
}

// ─── Students enrolled in a specific class ───────────────────────────────────
/**
 * useStudentsInClass — list students (and work-study) enrolled in a given class.
 *
 * IMPORTANT: profiles.classes stores course_id values (e.g. "RICT1610"), not
 * class_id values (e.g. "CLS1020"). However, some legacy data may use class_id.
 * To match the defensive pattern used by TimeCardsPage and others, this hook
 * looks up BOTH identifiers from the classes table and matches either form in
 * profile.classes. This makes enrollment-matching robust to either storage
 * convention.
 *
 * Excludes the super admin utility account. Sorted by last name then first
 * name for stable picker rendering.
 *
 * Returns { students: [{email, first_name, last_name, role}], loading, refresh }.
 *
 * Used by the Per-Student Reminders section on the Settings page to populate
 * the "Add per-student message" dropdown.
 */
export function useStudentsInClass(classId) {
  const [students, setStudents] = useState([])
  const [loading, setLoading]   = useState(true)

  const fetch = useCallback(async () => {
    if (!classId) {
      setStudents([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      // 1. Look up the class to get BOTH class_id and course_id, since
      //    profile.classes may contain either form.
      const { data: cls } = await supabase
        .from('classes')
        .select('class_id, course_id')
        .eq('class_id', classId)
        .maybeSingle()

      const cid = String(classId).trim()
      const courseId = cls?.course_id ? String(cls.course_id).trim() : null

      // 2. Fetch all candidate profiles (Student + Work Study).
      const { data, error } = await supabase
        .from('profiles')
        .select('email, first_name, last_name, role, classes, status')
        .in('role', ['Student', 'Work Study'])

      if (error) throw error

      const list = (data || [])
        // Exclude super admin from user-facing picker (defense-in-depth)
        .filter(p => !isSuperAdminEmail(p.email))
        // Exclude inactive accounts; permissive on unknown statuses
        .filter(p => (p.status || 'Active').toLowerCase() !== 'inactive')
        // Match enrollment via standard comma-separated parse, accepting EITHER
        // class_id (CLS####) or course_id (RICT####) in profile.classes —
        // mirrors the pattern used by TimeCardsPage and others.
        .filter(p => {
          const userClasses = (p.classes || '')
            .split(',')
            .map(c => c.trim())
            .filter(Boolean)
          return userClasses.includes(cid)
            || (courseId && userClasses.includes(courseId))
        })
        .sort((a, b) => {
          const aLast = (a.last_name || '').toLowerCase()
          const bLast = (b.last_name || '').toLowerCase()
          if (aLast !== bLast) return aLast.localeCompare(bLast)
          return (a.first_name || '').toLowerCase()
            .localeCompare((b.first_name || '').toLowerCase())
        })

      setStudents(list)
    } catch (err) {
      console.error('useStudentsInClass error:', err)
      setStudents([])
    } finally {
      setLoading(false)
    }
  }, [classId])

  useEffect(() => { fetch() }, [fetch])

  return { students, loading, refresh: fetch }
}
