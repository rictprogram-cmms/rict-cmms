/**
 * RICT CMMS — useChangelog
 *
 * Hook that drives the "What's New" modal in AppLayout.
 *
 * Behavior:
 *   1. On real-profile load, fetch the most recent changelog release_date.
 *   2. If profile.last_seen_changelog_date IS NULL  → silently UPDATE the
 *      profile to the latest date and DO NOT open the modal.
 *      ↳ This makes new users (and all existing users on first deploy)
 *        skip the backlog of historical changelog entries cleanly.
 *   3. Otherwise, fetch all changelog rows newer than last_seen_changelog_date.
 *      If any exist, open the modal with them.
 *   4. On dismiss(), UPDATE last_seen_changelog_date to the most recent
 *      release_date shown, so the modal won't reopen for those entries.
 *
 * Bail conditions (modal will not appear):
 *   - No realProfile (kiosk / unauthenticated / pending approval)
 *   - isEmulating === true (super admin emulating someone else — the popup
 *     is for the real user's session, not the emulated identity)
 *   - mustChangePassword === true (forced password reset in progress)
 *
 * Concurrency note:
 *   Runs once per realProfile.email per mount (tracked via checkedRef) to
 *   avoid loops if last_seen_changelog_date changes locally while the
 *   component is still mounted.
 *
 * Accessibility:
 *   The modal itself uses useDialogA11y. The 800 ms open delay below is
 *   purely visual (lets HoldLockoutModal / HoldReminderModal mount first
 *   so this modal doesn't briefly steal focus before they take over).
 *
 * File: src/hooks/useChangelog.js
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

const OPEN_DELAY_MS = 800

export function useChangelog(realProfile, isEmulating, mustChangePassword) {
  const [entries, setEntries] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  // Tracks which email we've already run the check for, so a profile update
  // (e.g. dismissing the modal updates last_seen_changelog_date) doesn't
  // retrigger the effect into a loop.
  const checkedRef = useRef(null)

  useEffect(() => {
    if (!realProfile?.email) return
    if (isEmulating) return
    if (mustChangePassword) return
    if (checkedRef.current === realProfile.email) return
    checkedRef.current = realProfile.email

    let cancelled = false
    let openTimer = null

    async function checkChangelog() {
      try {
        // 1. Find the latest changelog release date.
        const { data: latest, error: latestErr } = await supabase
          .from('changelog')
          .select('release_date')
          .order('release_date', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (cancelled) return
        if (latestErr || !latest?.release_date) return

        const latestDate = latest.release_date
        const userLastSeen = realProfile.last_seen_changelog_date

        // 2. First-load catch-up: silently mark them as up-to-date.
        //    No modal — they don't see the backlog.
        if (!userLastSeen) {
          await supabase
            .from('profiles')
            .update({ last_seen_changelog_date: latestDate })
            .eq('email', realProfile.email)
          return
        }

        // 3. Already up-to-date.
        if (userLastSeen >= latestDate) return

        // 4. Fetch all entries newer than what they've seen.
        const { data: newEntries, error: entriesErr } = await supabase
          .from('changelog')
          .select('version, release_date, type, title, request_id')
          .gt('release_date', userLastSeen)
          .order('release_date', { ascending: false })

        if (cancelled) return
        if (entriesErr || !newEntries?.length) return

        // 5. Small delay so we don't fight other modals (HoldLockout etc.)
        //    for focus during initial mount.
        openTimer = setTimeout(() => {
          if (cancelled) return
          setEntries(newEntries)
          setIsOpen(true)
        }, OPEN_DELAY_MS)
      } catch (err) {
        // Non-fatal — the worst case is the modal doesn't show this session,
        // which is fine. The user can still see all changes on the Bug Tracker.
        console.error('[useChangelog] Failed to check changelog:', err)
      }
    }

    checkChangelog()
    return () => {
      cancelled = true
      if (openTimer) clearTimeout(openTimer)
    }
    // realProfile.last_seen_changelog_date intentionally NOT in deps — we use
    // checkedRef + email to gate single-run-per-session, and reading the
    // latest value off realProfile at effect time is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realProfile?.email, isEmulating, mustChangePassword])

  const dismiss = useCallback(async () => {
    setIsOpen(false)

    if (!realProfile?.email || entries.length === 0) return

    // Find the most recent release_date among shown entries.
    let mostRecent = entries[0].release_date
    for (const e of entries) {
      if (e.release_date > mostRecent) mostRecent = e.release_date
    }

    try {
      await supabase
        .from('profiles')
        .update({ last_seen_changelog_date: mostRecent })
        .eq('email', realProfile.email)
    } catch (err) {
      // Non-fatal — they'll see the same modal again next login.
      console.error('[useChangelog] Failed to update last_seen_changelog_date:', err)
    }
  }, [entries, realProfile?.email])

  return { entries, isOpen, dismiss }
}

export default useChangelog
