/**
 * RICT CMMS - Shared Permissions Hook
 * 
 * Provides a consistent, database-driven permission checking system
 * for all pages. Replaces the scattered hasPerm() implementations
 * and eliminates the Instructor auto-bypass that made Access Control
 * toggles non-functional.
 *
 * v3 — Emulation-aware: When the super admin is emulating another user,
 *       the super admin bypass is disabled so permissions reflect exactly
 *       what the emulated user would see.
 *
 * Usage:
 *   const { hasPerm, permsLoading } = usePermissions('Work Orders')
 *   
 *   // In JSX:
 *   {hasPerm('create_wo') && <button>Create</button>}
 *
 * Behavior:
 *   - Super Admin (rictprogram@gmail.com) always has all permissions (when NOT emulating)
 *   - During emulation: super admin bypass is disabled, emulated user's role is used
 *   - All other roles (including Instructor) respect the database toggles
 *   - Active temp permission grants (request_type='permissions') add extra features
 *   - Returns false while loading (prevents UI flash of unauthorized content)
 *   - Supports checking multiple pages if needed via useMultiPagePermissions
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

/**
 * Primary hook — loads permissions for a single page.
 * @param {string} pageName - Must match the `page` column in the permissions table
 *                            e.g. 'Work Orders', 'Inventory', 'Assets', 'Purchase Orders',
 *                            'PM', 'Lab Signup', 'Reports', 'WOC Ratio', 'Bug Tracker',
 *                            'Users', 'Settings', 'Dashboard'
 * @returns {{ hasPerm: (feature: string) => boolean, permsLoading: boolean, perms: object }}
 */
export function usePermissions(pageName) {
  const { profile, isEmulating, realProfile } = useAuth()
  const [perms, setPerms] = useState({})
  const [tempPerms, setTempPerms] = useState({})
  const [loading, setLoading] = useState(true)

  // Super admin bypass is ONLY active when NOT emulating
  const isRealSuperAdmin = realProfile?.email?.toLowerCase() === SUPER_ADMIN_EMAIL
  const isSuperAdmin = isRealSuperAdmin && !isEmulating

  useEffect(() => {
    if (!profile?.role || !pageName) {
      setLoading(false)
      return
    }

    let cancelled = false

    async function loadPermissions() {
      try {
        // 1. Load standard role-based permissions
        const { data, error } = await supabase
          .from('permissions')
          .select('*')
          .eq('page', pageName)

        if (cancelled) return

        const roleKey = profile.role.toLowerCase().replace(' ', '_')
        const permObj = {}

        if (!error && data) {
          data.forEach(p => {
            permObj[p.feature] = p[roleKey] === true || p[roleKey] === 'true' || p[roleKey] === 'Yes'
          })
        }
        setPerms(permObj)

        // 2. Load active temp permission grants for the effective user
        const tempPermObj = {}
        try {
          const { data: tempData } = await supabase
            .from('temp_access_requests')
            .select('approved_permissions, expiry_date')
            .eq('user_email', profile.email)
            .eq('status', 'Active')
            .eq('request_type', 'permissions')

          if (!cancelled && tempData) {
            const now = new Date()
            tempData.forEach(grant => {
              // Skip expired grants
              if (grant.expiry_date && new Date(grant.expiry_date) < now) return
              // Parse approved_permissions JSON array
              const permsArr = grant.approved_permissions || []
              permsArr.forEach(p => {
                if (p.page === pageName) {
                  tempPermObj[p.feature] = true
                }
              })
            })
          }
        } catch (e) {
          // Temp permissions are supplemental — don't fail if table doesn't have new columns yet
          console.warn('Temp permission check skipped:', e.message)
        }
        if (!cancelled) setTempPerms(tempPermObj)

      } catch (e) {
        console.error(`Permission load error (${pageName}):`, e)
        if (!cancelled) {
          setPerms({})
          setTempPerms({})
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    setLoading(true)
    loadPermissions()

    return () => { cancelled = true }
  }, [profile?.role, profile?.email, pageName, isEmulating])

  // Listen for temp permission changes (granted/revoked) to refresh
  useEffect(() => {
    if (!profile?.email || isSuperAdmin) return

    const channel = supabase
      .channel(`perm-temp-${pageName}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'temp_access_requests' },
        (payload) => {
          // Only re-check if it involves the effective user
          const email = payload.new?.user_email || payload.old?.user_email
          if (email === profile.email) {
            // Re-load temp permissions
            ;(async () => {
              try {
                const tempPermObj = {}
                const { data: tempData } = await supabase
                  .from('temp_access_requests')
                  .select('approved_permissions, expiry_date')
                  .eq('user_email', profile.email)
                  .eq('status', 'Active')
                  .eq('request_type', 'permissions')

                const now = new Date()
                ;(tempData || []).forEach(grant => {
                  if (grant.expiry_date && new Date(grant.expiry_date) < now) return
                  ;(grant.approved_permissions || []).forEach(p => {
                    if (p.page === pageName) {
                      tempPermObj[p.feature] = true
                    }
                  })
                })
                setTempPerms(tempPermObj)
              } catch {}
            })()
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, pageName, isSuperAdmin])

  /**
   * Check if the current user has a specific permission feature.
   * Priority: Super Admin (when not emulating) → Role-based → Temp permission grant
   */
  const hasPerm = useCallback((feature) => {
    if (isSuperAdmin) return true
    if (perms[feature] === true) return true
    if (tempPerms[feature] === true) return true
    return false
  }, [perms, tempPerms, isSuperAdmin])

  return { hasPerm, permsLoading: loading, perms, tempPerms, isSuperAdmin }
}

/**
 * Multi-page permission hook — loads permissions from multiple pages at once.
 * Useful when a page needs to check permissions from different domains
 * (e.g. WorkOrders page checking 'approve_requests' from the Users page).
 *
 * Usage:
 *   const { hasPerm } = useMultiPagePermissions(['Work Orders', 'Users'])
 *   hasPerm('Work Orders', 'create_wo')   // checks Work Orders permissions
 *   hasPerm('Users', 'approve_requests')   // checks Users permissions
 */
export function useMultiPagePermissions(pageNames = []) {
  const { profile, isEmulating, realProfile } = useAuth()
  const [permsMap, setPermsMap] = useState({})
  const [tempPermsMap, setTempPermsMap] = useState({})
  const [loading, setLoading] = useState(true)

  const isRealSuperAdmin = realProfile?.email?.toLowerCase() === SUPER_ADMIN_EMAIL
  const isSuperAdmin = isRealSuperAdmin && !isEmulating

  useEffect(() => {
    if (!profile?.role || pageNames.length === 0) {
      setLoading(false)
      return
    }

    let cancelled = false

    async function loadPermissions() {
      try {
        // 1. Standard role-based permissions
        const { data, error } = await supabase
          .from('permissions')
          .select('*')
          .in('page', pageNames)

        if (cancelled) return

        const roleKey = profile.role.toLowerCase().replace(' ', '_')
        const map = {}

        if (!error && data) {
          data.forEach(p => {
            if (!map[p.page]) map[p.page] = {}
            map[p.page][p.feature] = p[roleKey] === true || p[roleKey] === 'true' || p[roleKey] === 'Yes'
          })
        }
        setPermsMap(map)

        // 2. Temp permission grants
        const tempMap = {}
        try {
          const { data: tempData } = await supabase
            .from('temp_access_requests')
            .select('approved_permissions, expiry_date')
            .eq('user_email', profile.email)
            .eq('status', 'Active')
            .eq('request_type', 'permissions')

          if (!cancelled && tempData) {
            const now = new Date()
            tempData.forEach(grant => {
              if (grant.expiry_date && new Date(grant.expiry_date) < now) return
              ;(grant.approved_permissions || []).forEach(p => {
                if (pageNames.includes(p.page)) {
                  if (!tempMap[p.page]) tempMap[p.page] = {}
                  tempMap[p.page][p.feature] = true
                }
              })
            })
          }
        } catch {}
        if (!cancelled) setTempPermsMap(tempMap)

      } catch (e) {
        console.error('Multi-page permission load error:', e)
        if (!cancelled) {
          setPermsMap({})
          setTempPermsMap({})
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    setLoading(true)
    loadPermissions()

    return () => { cancelled = true }
  }, [profile?.role, profile?.email, pageNames.join(','), isEmulating])

  // Listen for temp permission changes (granted/revoked) to refresh
  useEffect(() => {
    if (!profile?.email || isSuperAdmin || pageNames.length === 0) return

    const channel = supabase
      .channel(`multi-perm-temp-${pageNames.join('-')}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'temp_access_requests' },
        (payload) => {
          const email = payload.new?.user_email || payload.old?.user_email
          if (email === profile.email) {
            ;(async () => {
              try {
                const tempMap = {}
                const { data: tempData } = await supabase
                  .from('temp_access_requests')
                  .select('approved_permissions, expiry_date')
                  .eq('user_email', profile.email)
                  .eq('status', 'Active')
                  .eq('request_type', 'permissions')

                const now = new Date()
                ;(tempData || []).forEach(grant => {
                  if (grant.expiry_date && new Date(grant.expiry_date) < now) return
                  ;(grant.approved_permissions || []).forEach(p => {
                    if (pageNames.includes(p.page)) {
                      if (!tempMap[p.page]) tempMap[p.page] = {}
                      tempMap[p.page][p.feature] = true
                    }
                  })
                })
                setTempPermsMap(tempMap)
              } catch {}
            })()
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, pageNames.join(','), isSuperAdmin])

  const hasPerm = useCallback((page, feature) => {
    if (isSuperAdmin) return true
    if (permsMap[page]?.[feature] === true) return true
    if (tempPermsMap[page]?.[feature] === true) return true
    return false
  }, [permsMap, tempPermsMap, isSuperAdmin])

  return { hasPerm, permsLoading: loading, permsMap, tempPermsMap, isSuperAdmin }
}
