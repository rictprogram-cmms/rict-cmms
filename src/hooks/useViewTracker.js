/**
 * RICT CMMS — useViewTracker Hook
 *
 * Fires a single audit_log "View" entry on mount IF the entity type is in the
 * audit_track_view_entities setting list. No-op otherwise (so leaving the call
 * in code is safe even when the entity is removed from the tracked list).
 *
 * Designed for pages that ONLY need to track page-views and shouldn't pull in
 * the full useAuditLog hook (which loads entries, distincts, suspicious flags,
 * realtime subscriptions, etc.). For the Audit Log page itself, use the
 * trackView() method exposed by useAuditLog.
 *
 * Usage:
 *   import { useViewTracker } from '@/hooks/useViewTracker'
 *
 *   function UsersPage() {
 *     useViewTracker('Users')
 *     // ... rest of component
 *   }
 *
 *   // Optionally include an entity ID for finer-grained tracking:
 *   useViewTracker('User', userId)
 *
 *   // Or a custom details string:
 *   useViewTracker('Users', 'PAGE', 'Viewed Users list with role filter applied')
 *
 * File: src/hooks/useViewTracker.js
 */

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export function useViewTracker(entityType, entityId = 'PAGE', details = '') {
  const { profile } = useAuth()
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    if (!profile?.email) return
    if (!entityType) return
    fired.current = true

    ;(async () => {
      try {
        const { data: cfg } = await supabase
          .from('settings')
          .select('setting_value')
          .eq('setting_key', 'audit_track_view_entities')
          .maybeSingle()

        const trackedList = (cfg?.setting_value || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        if (!trackedList.includes(entityType)) return

        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name:  ((profile.first_name || '') + ' ' + (profile.last_name || '').charAt(0) + '.').trim(),
          action:      'View',
          entity_type: entityType,
          entity_id:   entityId || 'PAGE',
          details:     details || ('Viewed ' + entityType + (entityId && entityId !== 'PAGE' ? ' (' + entityId + ')' : '')),
        })
      } catch (e) {
        console.warn('View tracking failed:', e.message)
      }
    })()
  }, [profile?.email, entityType, entityId, details])
}

export default useViewTracker
