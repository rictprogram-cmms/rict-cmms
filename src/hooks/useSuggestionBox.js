/**
 * RICT CMMS — useSuggestionBox
 *
 * Data layer for the RICT Club Suggestion Box (src/pages/SuggestionBoxPage.jsx).
 *
 * Who sees what (enforced by RLS + SECURITY DEFINER functions in
 * supabase/migrations/20261110_suggestion_box.sql — this hook only mirrors it):
 *   • Anyone with Suggestion Box → submit: send a suggestion, named or
 *     anonymous, and see their own NAMED suggestions with status + reply.
 *   • Viewers (the per-user list instructors manage on the page) and anyone
 *     with Suggestion Box → manage: see every suggestion, set status, reply.
 *   • manage: also delete and close out a school year.
 *   • manage_viewers: add / remove people on the viewer list.
 *
 * Anonymous means anonymous: submit_suggestion() never stores the author or
 * the time of day for an anonymous row, and this hook writes nothing to
 * audit_log for a submit. The tracking code it returns is shown once and only
 * its hash is stored.
 *
 * Timestamps: created_at / replied_at / status_changed_at are REAL UTC
 * (Convention B). created_on is a date-only string (YYYY-MM-DD, Chicago).
 *
 * File: src/hooks/useSuggestionBox.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData, assertWrite } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'

export const SUGGESTION_CATEGORIES = ['Events', 'Lab & Equipment', 'Club Activities', 'Fundraising', 'Other']
export const SUGGESTION_STATUSES = ['New', 'Under review', 'Planned', 'Done', 'Not doing']
export const SUGGESTION_MAX_LEN = 2000
export const SUGGESTION_DAILY_LIMIT = 5

const SUGGESTION_COLS =
  'id, body, category, is_anonymous, author_email, author_name, status, reply, reply_by_name, ' +
  'replied_at, status_changed_at, school_year, archived, archived_at, created_on, created_at'

/** School year label (July–June) for a Date — mirrors suggestion_school_year() in SQL. */
export function schoolYearFor(d = new Date()) {
  const y = d.getFullYear()
  return d.getMonth() >= 6
    ? `${y}-${String(y + 1).slice(-2)}`
    : `${y - 1}-${String(y).slice(-2)}`
}

/** Supabase/Postgres error → a sentence a student can act on. */
export function friendlyError(err, fallback = 'Something went wrong. Please try again.') {
  const msg = String(err?.message || '')
  // Messages raised by our SQL functions are already written for people.
  if (err?.code === 'P0001' || err?.code === '22023' || err?.code === 'P0002') return msg || fallback
  if (err?.code === '42501') return msg && !/row-level security|permission denied/i.test(msg) ? msg : 'You do not have permission to do that.'
  if (/failed to fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection and try again.'
  return fallback
}

export function useSuggestionBox({ canManageViewers = false } = {}) {
  const { profile } = useAuth()
  const email = (profile?.email || '').toLowerCase()

  const [suggestions, setSuggestions] = useState([])
  const [canView, setCanView] = useState(false)
  const [viewers, setViewers] = useState([])          // [{ email, added_by, added_at }]
  const [people, setPeople] = useState([])            // active profiles for the viewer picker
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const fetchAll = useCallback(async () => {
    if (!email) return
    try {
      const [viewRes, sugRes] = await Promise.all([
        supabase.rpc('suggestion_box_can_view'),
        supabase.from('suggestions').select(SUGGESTION_COLS).order('id', { ascending: false }),
      ])
      const viewFlag = mustData(viewRes, 'suggestion_box_can_view') === true
      const rows = mustData(sugRes, 'suggestions.select') || []

      let viewerRows = []
      let peopleRows = []
      if (canManageViewers) {
        const [vRes, pRes] = await Promise.all([
          supabase.from('suggestion_box_viewers').select('email, added_by, added_at').order('email'),
          supabase.from('profiles').select('email, first_name, last_name, role, status').eq('status', 'Active'),
        ])
        viewerRows = mustData(vRes, 'suggestion_box_viewers.select') || []
        peopleRows = mustData(pRes, 'profiles.select') || []
      }

      if (!mounted.current) return
      setCanView(viewFlag)
      setSuggestions(rows)
      setViewers(viewerRows)
      setPeople(peopleRows)
      setLoadError(null)
    } catch (err) {
      console.error('useSuggestionBox fetch failed:', err)
      // Keep the last good data on screen; just report the failure.
      if (mounted.current) setLoadError(friendlyError(err, 'Could not load the Suggestion Box.'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [email, canManageViewers])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Live updates: new suggestions, status changes, viewer list changes.
  useEffect(() => {
    if (!email) return undefined
    return subscribeWithReconnect('suggestion-box-rt', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'suggestions' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'suggestion_box_viewers' }, fetchAll),
      { onReconnect: fetchAll })
  }, [email, fetchAll])

  // ── Actions ────────────────────────────────────────────────────────────────

  /** Returns { id, tracking_code } — tracking_code only for anonymous. Throws on failure. */
  const submit = useCallback(async ({ body, category, anonymous }) => {
    const { data, error } = await supabase.rpc('submit_suggestion', {
      p_body: body,
      p_category: category,
      p_anonymous: !!anonymous,
    })
    if (error) throw error
    if (!data?.id) throw new Error('The suggestion was not saved.')
    fetchAll()
    return data
  }, [fetchAll])

  const update = useCallback(async (id, { status, reply }) => {
    const { data, error } = await supabase.rpc('update_suggestion', {
      p_id: id,
      p_status: status,
      p_reply: reply ?? '',
    })
    if (error) throw error
    if (!data?.id) throw new Error('The suggestion was not updated.')
    setSuggestions(prev => prev.map(s => (s.id === data.id ? { ...s, ...data } : s)))
    return data
  }, [])

  const remove = useCallback(async (id) => {
    const res = assertWrite(await supabase.from('suggestions').delete().eq('id', id).select('id'), 'suggestions.delete')
    if (res.error) throw res.error
    setSuggestions(prev => prev.filter(s => s.id !== id))
  }, [])

  const archiveYear = useCallback(async (schoolYear) => {
    const { data, error } = await supabase.rpc('archive_suggestion_year', { p_school_year: schoolYear })
    if (error) throw error
    await fetchAll()
    return Number(data) || 0
  }, [fetchAll])

  const lookup = useCallback(async (code) => {
    const { data, error } = await supabase.rpc('lookup_suggestion', { p_code: code })
    if (error) throw error
    return (data && data[0]) || null
  }, [])

  const addViewer = useCallback(async (viewerEmail) => {
    const clean = String(viewerEmail || '').trim().toLowerCase()
    if (!clean) return
    const res = assertWrite(
      await supabase.from('suggestion_box_viewers').insert({ email: clean, added_by: email }).select('email'),
      'suggestion_box_viewers.insert')
    if (res.error) throw res.error
    await fetchAll()
  }, [email, fetchAll])

  const removeViewer = useCallback(async (viewerEmail) => {
    const res = assertWrite(
      await supabase.from('suggestion_box_viewers').delete().eq('email', viewerEmail).select('email'),
      'suggestion_box_viewers.delete')
    if (res.error) throw res.error
    await fetchAll()
  }, [fetchAll])

  const mine = suggestions.filter(s => s.author_email && s.author_email.toLowerCase() === email)

  return {
    suggestions, mine, canView, viewers, people, loading, loadError,
    refresh: fetchAll, submit, update, remove, archiveYear, lookup, addViewer, removeViewer,
  }
}

export default useSuggestionBox
