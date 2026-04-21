import { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'

const AuthContext = createContext(null)

const PROFILE_CACHE_KEY = 'rict_cmms_profile'
const EMULATION_CACHE_KEY = 'rict_cmms_emulation'
const SESSION_LOGIN_KEY = 'rict_cmms_login_at'   // epoch ms of last real sign-in
const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

// Roles that are subject to lab access mode lockout.
// Instructors and Super Admin are never locked out.
const LOCKABLE_ROLES = ['Student', 'Work Study']

function getCachedProfile() {
  try {
    const cached = localStorage.getItem(PROFILE_CACHE_KEY)
    if (cached) return JSON.parse(cached)
  } catch {}
  return null
}

function setCachedProfile(profile) {
  try {
    if (profile) {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile))
    } else {
      localStorage.removeItem(PROFILE_CACHE_KEY)
    }
  } catch {}
}

function getCachedEmulation() {
  try {
    const cached = localStorage.getItem(EMULATION_CACHE_KEY)
    if (cached) return JSON.parse(cached)
  } catch {}
  return null
}

function setCachedEmulation(emulation) {
  try {
    if (emulation) {
      localStorage.setItem(EMULATION_CACHE_KEY, JSON.stringify(emulation))
    } else {
      localStorage.removeItem(EMULATION_CACHE_KEY)
    }
  } catch {}
}

export function AuthProvider({ children }) {
  // Real authenticated profile (never changes during emulation)
  const [session, setSession] = useState(null)
  const [realProfile, setRealProfile] = useState(() => getCachedProfile())
  const [loading, setLoading] = useState(() => !getCachedProfile())
  const [isRegistering, setIsRegistering] = useState(false)
  // True when user_metadata.must_reset_password === true.
  // Set after every SIGNED_IN; cleared on USER_UPDATED (password change).
  // ProtectedRoute reads this to redirect to /change-password.
  const [mustChangePassword, setMustChangePassword] = useState(false)

  // ── Emulation State ────────────────────────────────────────────────
  const [emulatedProfile, setEmulatedProfile] = useState(() => getCachedEmulation())

  const isSuperAdmin = realProfile?.email?.toLowerCase() === SUPER_ADMIN_EMAIL
  const isEmulating = isSuperAdmin && !!emulatedProfile

  // The "effective" profile — what the rest of the app sees
  const profile = isEmulating ? emulatedProfile : realProfile

  // ── Lab Access Mode ────────────────────────────────────────────────
  // We track two pieces of independent source-of-truth state:
  //   1. labAccessMode — the current value of the `lab_access_mode`
  //      setting in the DB (updated via initial fetch + realtime)
  //   2. profile?.role — the EFFECTIVE role (the emulated profile when
  //      Super Admin is emulating someone, real profile otherwise)
  //
  // `labLocked` is then DERIVED from those via useMemo, so it
  // automatically re-evaluates whenever emulation starts/stops or the
  // setting changes. No imperative setLabLocked calls scattered around.
  //
  // True-emulation convention: Super Admin emulating a Student during
  // summer break WILL be locked out — matching exactly what the student
  // sees. Escape hatch is the EmulationBar "Stop" button (z-index 9999,
  // above the LabLockedScreen).
  const [labAccessMode, setLabAccessMode] = useState(null)
  // Set of lowercase emails currently online (via Supabase Presence)
  const [onlineUsers, setOnlineUsers] = useState(new Set())
  // Map of email → { joined_at: ISO string } for presence tooltip durations
  const [presenceMeta, setPresenceMeta] = useState({})

  // ── Refs for stable identity tracking ──────────────────────────────
  const currentUserIdRef = useRef(null)
  const initDoneRef = useRef(false)
  const tabHiddenAtRef = useRef(null)
  const visibilityRefreshingRef = useRef(false)
  // Stable ref so the 60-s timeout interval always reads the latest value
  const sessionTimeoutHoursRef = useRef(0)

  // ── Lab Mode Fetch ─────────────────────────────────────────────────
  // Fetches the current lab_access_mode setting from the DB once. Called
  // on mount (if authenticated) and on SIGNED_IN. The realtime watcher
  // below keeps the value live after that.
  const fetchLabMode = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'lab_access_mode')
        .maybeSingle()
      if (!error && data) {
        setLabAccessMode(data.setting_value || null)
      } else {
        setLabAccessMode(null)
      }
    } catch {
      setLabAccessMode(null)
    }
  }, [])

  // ── Lab Locked (derived) ───────────────────────────────────────────
  // Re-evaluates automatically when emulation starts/stops (profile
  // identity changes) or when the setting is updated via realtime.
  const labLocked = useMemo(() => {
    if (labAccessMode !== 'summer_break') return false
    const role = profile?.role
    return LOCKABLE_ROLES.includes(role)
  }, [labAccessMode, profile?.role])

  // ── Session Timeout Fetch ──────────────────────────────────────────
  // Reads session_timeout_hours from DB. 0 = disabled (never auto-logout).
  const fetchTimeoutSetting = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'session_timeout_hours')
        .maybeSingle()
      const hours = parseFloat(data?.setting_value) || 0
      sessionTimeoutHoursRef.current = hours
    } catch {
      sessionTimeoutHoursRef.current = 0
    }
  }, [])

  const startEmulation = useCallback(async (userEmail) => {
    if (!isSuperAdmin) {
      console.warn('Emulation denied: not super admin')
      return null
    }
    if (userEmail.toLowerCase() === SUPER_ADMIN_EMAIL) {
      console.warn('Cannot emulate yourself')
      return null
    }
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('email', userEmail)
        .maybeSingle()

      if (error || !data) {
        console.error('Failed to load emulation target:', error?.message || 'No profile found')
        return null
      }

      console.log(`🔄 Emulating user: ${data.first_name} ${data.last_name} (${data.email}) — Role: ${data.role}`)
      setEmulatedProfile(data)
      setCachedEmulation(data)
      return data
    } catch (err) {
      console.error('Emulation error:', err)
      return null
    }
  }, [isSuperAdmin])

  const stopEmulation = useCallback(() => {
    console.log('🔄 Emulation ended — returning to super admin')
    setEmulatedProfile(null)
    setCachedEmulation(null)
  }, [])

  // ── Profile Loading ────────────────────────────────────────────────
  //
  // SECURITY: A profile is only considered valid if status === 'Active'.
  // This prevents a DB trigger (handle_new_user) or any other mechanism
  // from auto-creating a profile row that grants access before instructor
  // approval. Unapproved / trigger-created profiles are treated as if
  // they don't exist — the user sees "Awaiting Approval" instead.

  function isApprovedProfile(p) {
    return p && p.status === 'Active'
  }

  async function loadProfile(userId, userEmail) {
    try {
      if (userEmail) {
        const { data: profileByEmail, error: emailError } = await supabase
          .from('profiles')
          .select('*')
          .eq('email', userEmail)
          .maybeSingle()

        if (profileByEmail && !emailError) {
          if (!isApprovedProfile(profileByEmail)) {
            console.warn('Profile found for', userEmail, 'but status is not Active (status:', profileByEmail.status, ') — treating as pending approval')
            setRealProfile(null)
            setCachedProfile(null)
            return null
          }
          console.log('Profile loaded by email:', profileByEmail.email, profileByEmail.role)
          setRealProfile(profileByEmail)
          setCachedProfile(profileByEmail)
          fetchLabMode()
          return profileByEmail
        }

        if (!emailError) {
          const { data: profileById, error: idError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle()

          if (profileById && !idError) {
            if (!isApprovedProfile(profileById)) {
              console.warn('Profile found by ID for', userEmail, 'but status is not Active (status:', profileById.status, ') — treating as pending approval')
              setRealProfile(null)
              setCachedProfile(null)
              return null
            }
            console.log('Profile loaded by ID:', profileById.email, profileById.role)
            setRealProfile(profileById)
            setCachedProfile(profileById)
            fetchLabMode()
            return profileById
          }

          console.warn('No profile found for:', userId, userEmail, '— clearing cache')
          setRealProfile(null)
          setCachedProfile(null)
          return null
        }
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle()

      if (data && !error) {
        if (!isApprovedProfile(data)) {
          console.warn('Profile found by ID but status is not Active (status:', data.status, ') — treating as pending approval')
          setRealProfile(null)
          setCachedProfile(null)
          return null
        }
        console.log('Profile loaded by ID:', data.email, data.role)
        setRealProfile(data)
        setCachedProfile(data)
        fetchLabMode()
        return data
      }

      if (!error) {
        console.warn('No profile found for:', userId, userEmail, '— clearing cache')
        setRealProfile(null)
        setCachedProfile(null)
      }
      return null
    } catch (err) {
      console.error('Profile load error:', err)
      return null
    }
  }

  // ── Auth Initialization ────────────────────────────────────────────

  useEffect(() => {
    let mounted = true

    const hasCache = !!getCachedProfile()

    // Fetch lab mode immediately on mount so the derived labLocked
    // memo has a value right away. The memo gates by effective role,
    // so we don't need to pre-check role here.
    fetchLabMode()

    const timeout = setTimeout(() => {
      if (mounted && loading) {
        console.warn('Auth loading timeout — forcing completion')
        setLoading(false)
      }
    }, hasCache ? 3000 : 8000)

    async function initAuth(attempt = 1) {
      try {
        const { data: { user }, error } = await supabase.auth.getUser()

        if (!mounted) return

        if (user && !error) {
          console.log('User authenticated:', user.email)
          currentUserIdRef.current = user.id
          setSession({ user })

          // Check must_reset_password on every app load/page refresh, not
          // just on SIGNED_IN. Without this a page refresh while on
          // /change-password clears the flag and lets the student bypass it.
          setMustChangePassword(user.user_metadata?.must_reset_password === true)

          // If cached profile is from a different user, clear it
          const cachedEmail = getCachedProfile()?.email
          if (cachedEmail && cachedEmail !== user.email) {
            console.log('Cached profile email mismatch — refreshing')
            setRealProfile(null)
            setCachedProfile(null)
          }

          const loaded = await loadProfile(user.id, user.email)
          if (loaded) {
            // Background: stamp last_login + last_seen without blocking render
            const now = new Date().toISOString()
            supabase.from('profiles')
              .update({ last_login: now, last_seen: now })
              .eq('email', user.email)
              .then(() => {}).catch(() => {})

            // If no login timestamp exists (e.g. existing session before this
            // feature was deployed), seed it now so timeout tracking starts.
            if (!localStorage.getItem(SESSION_LOGIN_KEY)) {
              localStorage.setItem(SESSION_LOGIN_KEY, String(Date.now()))
            }

            // Fetch the timeout setting so the interval check has a value
            fetchTimeoutSetting()
          }
        } else if (error && attempt < 3) {
          console.warn(`Auth attempt ${attempt} failed, retrying in ${attempt * 1000}ms...`, error.message)
          await new Promise(r => setTimeout(r, attempt * 1000))
          if (mounted) return initAuth(attempt + 1)
        } else {
          console.log('No authenticated user')
          currentUserIdRef.current = null
          setSession(null)
          setRealProfile(null)
          setCachedProfile(null)
          setEmulatedProfile(null)
          setCachedEmulation(null)
        }
      } catch (err) {
        console.error('Auth init error:', err)
        if (!mounted) return
        if (attempt < 3) {
          console.warn(`Auth attempt ${attempt} threw, retrying in ${attempt * 1000}ms...`)
          await new Promise(r => setTimeout(r, attempt * 1000))
          if (mounted) return initAuth(attempt + 1)
        }
        if (!getCachedProfile()) {
          setSession(null)
          setRealProfile(null)
        }
      } finally {
        if (mounted) {
          initDoneRef.current = true
          setLoading(false)
        }
      }
    }

    initAuth()

    // ── Auth State Change Listener ───────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, s) => {
        console.log('Auth event:', event)
        if (!mounted) return

        if (event === 'SIGNED_IN' && s?.user) {
          const newUserId = s.user.id
          const oldUserId = currentUserIdRef.current

          // ── Check must_reset_password flag ──────────────────────────────
          // Stamped by the set-temp-password Edge Function.
          // Forces a /change-password redirect until the user saves a new password.
          const mustReset = s.user.user_metadata?.must_reset_password === true
          setMustChangePassword(mustReset)

          if (newUserId !== oldUserId) {
            // ── Stamp the real sign-in time for session-timeout tracking ──
            localStorage.setItem(SESSION_LOGIN_KEY, String(Date.now()))
            currentUserIdRef.current = newUserId
            setSession(s)
            if (initDoneRef.current) {
              const loaded = await loadProfile(s.user.id, s.user.email)
              if (loaded) {
                const now = new Date().toISOString()
                supabase.from('profiles')
                  .update({ last_login: now, last_seen: now })
                  .eq('email', s.user.email)
                  .then(() => {}).catch(() => {})
                fetchTimeoutSetting()
              }
            }
          }
          setLoading(false)
        } else if (event === 'SIGNED_OUT') {
          currentUserIdRef.current = null
          setSession(null)
          setRealProfile(null)
          setCachedProfile(null)
          setEmulatedProfile(null)
          setCachedEmulation(null)
          setMustChangePassword(false)
          setLoading(false)
          localStorage.removeItem(SESSION_LOGIN_KEY)
        } else if (event === 'USER_UPDATED' && s?.user) {
          // Fires when the student successfully saves their new password via
          // supabase.auth.updateUser(). The flag is already cleared server-side
          // by the ChangePasswordPage; update local state so the redirect lifts
          // immediately without requiring a fresh sign-in.
          const mustReset = s.user.user_metadata?.must_reset_password === true
          setMustChangePassword(mustReset)
          if (s.user.id === currentUserIdRef.current) {
            setSession(s)
          }
        } else if (event === 'TOKEN_REFRESHED' && s?.user) {
          const newUserId = s.user.id
          if (newUserId !== currentUserIdRef.current) {
            currentUserIdRef.current = newUserId
            setSession(s)
          }
        }
      }
    )

    return () => {
      mounted = false
      clearTimeout(timeout)
      subscription.unsubscribe()
    }
  }, [])

  // ── Tab Visibility Handler ─────────────────────────────────────────
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        tabHiddenAtRef.current = Date.now()
        return
      }

      if (!tabHiddenAtRef.current) return

      const hiddenDuration = Date.now() - tabHiddenAtRef.current
      tabHiddenAtRef.current = null

      if (hiddenDuration < 30_000) return
      if (visibilityRefreshingRef.current) return
      visibilityRefreshingRef.current = true

      console.log(`[TabReturn] Tab was hidden for ${Math.round(hiddenDuration / 1000)}s — refreshing session & reconnecting`)

      try {
        const { data, error } = await supabase.auth.refreshSession()

        if (error) {
          console.warn('[TabReturn] Session refresh failed:', error.message)
          return
        }

        if (data?.session?.user) {
          console.log('[TabReturn] Session refreshed successfully for:', data.session.user.email)
          currentUserIdRef.current = data.session.user.id
        }

        // ── Check session timeout on tab return ───────────────────────
        const timeoutHours = sessionTimeoutHoursRef.current
        if (timeoutHours > 0) {
          const loginAt = parseInt(localStorage.getItem(SESSION_LOGIN_KEY) || '0', 10)
          if (loginAt && (Date.now() - loginAt) >= timeoutHours * 3_600_000) {
            console.log('[TabReturn] Session expired during tab away — signing out')
            visibilityRefreshingRef.current = false
            signOut()
            return
          }
        }

        window.dispatchEvent(new CustomEvent('supabase-reconnected', {
          detail: { hiddenDuration }
        }))

      } catch (err) {
        console.error('[TabReturn] Recovery error:', err)
      } finally {
        visibilityRefreshingRef.current = false
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  // ── Realtime: auto-refresh real profile when it changes ────────────
  useEffect(() => {
    if (!realProfile?.email) return
    const channel = supabase
      .channel('profile-realtime')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `email=eq.${realProfile.email}` },
        (payload) => {
          console.log('Real profile updated via realtime:', payload.new?.role)
          setRealProfile(payload.new)
          setCachedProfile(payload.new)
          // Re-evaluate lock if role changed — memo will pick up the new role
          // automatically; we only need to re-fetch the setting in case it
          // changed while we were disconnected.
          fetchLabMode()
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [realProfile?.email, fetchLabMode])

  // ── Realtime: auto-refresh emulated profile when it changes ────────
  useEffect(() => {
    if (!emulatedProfile?.email) return
    const channel = supabase
      .channel('emulated-profile-realtime')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `email=eq.${emulatedProfile.email}` },
        (payload) => {
          console.log('Emulated profile updated via realtime:', payload.new?.role)
          setEmulatedProfile(payload.new)
          setCachedEmulation(payload.new)
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [emulatedProfile?.email])

  // ── Realtime: watch lab_access_mode setting changes ─────────────────
  // When an instructor flips the toggle, all affected users (Students /
  // Work Study, including any Super Admin emulating one) are immediately
  // locked out or unlocked — the `labLocked` memo re-evaluates when
  // labAccessMode changes.
  useEffect(() => {
    const channel = supabase
      .channel('lab-access-mode-watch')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'settings',
          filter: 'setting_key=eq.lab_access_mode',
        },
        (payload) => {
          const newMode = payload.new?.setting_value
          console.log('[LabAccessMode] Setting changed to:', newMode)
          setLabAccessMode(newMode || null)
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── Realtime: Presence – track self & watch all online users ────────
  // Each authenticated user joins 'online-users-presence' and tracks
  // their email + joined_at. The resulting Set of emails and meta map
  // are exposed via context so any page can show real-time online dots
  // and "active for Xm" tooltips.
  useEffect(() => {
    if (!realProfile?.email) return

    const email = realProfile.email.toLowerCase()
    const joinedAt = new Date().toISOString()

    const channel = supabase.channel('online-users-presence', {
      config: { presence: { key: email } }
    })

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const emails = new Set()
        const meta = {}
        Object.values(state).forEach(presences => {
          presences.forEach(p => {
            if (p.email) {
              const e = p.email.toLowerCase()
              emails.add(e)
              // Keep the earliest joined_at if multiple tabs are open
              if (p.joined_at && (!meta[e] || p.joined_at < meta[e].joined_at)) {
                meta[e] = { joined_at: p.joined_at }
              }
            }
          })
        })
        setOnlineUsers(emails)
        setPresenceMeta(meta)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ email, joined_at: joinedAt })
        }
      })

    return () => { supabase.removeChannel(channel) }
  }, [realProfile?.email])

  // ── Session Timeout: 60-second interval check ─────────────────────
  // Compares now() against the stored login timestamp. Signs out
  // automatically once the configured hours have elapsed.
  // sessionTimeoutHoursRef.current === 0 means disabled (never expire).
  useEffect(() => {
    if (!realProfile?.email) return

    const checkTimeout = () => {
      const hours = sessionTimeoutHoursRef.current
      if (!hours || hours <= 0) return           // 0 = disabled

      const loginAt = parseInt(localStorage.getItem(SESSION_LOGIN_KEY) || '0', 10)
      if (!loginAt) return

      if (Date.now() - loginAt >= hours * 3_600_000) {
        console.log('[SessionTimeout] Session expired — signing out')
        signOut()
      }
    }

    checkTimeout()                               // check immediately on mount / user change
    const id = setInterval(checkTimeout, 60_000) // re-check every minute
    return () => clearInterval(id)
  }, [realProfile?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session Timeout: realtime watch for setting changes ────────────
  // Picks up changes made on the Settings page instantly, so already-logged-in
  // users get the new timeout without a page refresh.
  useEffect(() => {
    const channel = supabase
      .channel('session-timeout-watch')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'settings',
          filter: 'setting_key=eq.session_timeout_hours',
        },
        (payload) => {
          const hours = parseFloat(payload.new?.setting_value) || 0
          console.log('[SessionTimeout] Setting updated to:', hours, 'hours')
          sessionTimeoutHoursRef.current = hours
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── last_seen heartbeat – writes every 5 min while user is active ───
  // Keeps last_seen current so "Last Active" stays accurate even without
  // a new login. last_login only updates on actual sign-in.
  useEffect(() => {
    if (!realProfile?.email) return
    const INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
    const stamp = () => {
      supabase.from('profiles')
        .update({ last_seen: new Date().toISOString() })
        .eq('email', realProfile.email)
        .then(() => {}).catch(() => {})
    }
    stamp() // immediate stamp on mount / profile load
    const id = setInterval(stamp, INTERVAL_MS)
    return () => clearInterval(id)
  }, [realProfile?.email])

  // ── Auth Actions ───────────────────────────────────────────────────

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    return data
  }

  async function signOut() {
    setEmulatedProfile(null)
    setCachedEmulation(null)
    try {
      await supabase.auth.signOut()
    } catch (err) {
      console.error('Sign out error:', err)
    }
    setRealProfile(null)
    setSession(null)
    currentUserIdRef.current = null
    setCachedProfile(null)
  }

  async function resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) throw error
  }

  // ── Auto Access Request on Email Confirmation ──────────────────────

  const isFullyAuthenticated = !!session && !!realProfile
  const userEmailConfirmed = session?.user?.email_confirmed_at != null
  const isPendingEmailVerification = !!session && !userEmailConfirmed && !realProfile && !loading
  const isPendingApproval = !!session && userEmailConfirmed && !realProfile && !loading

  useEffect(() => {
    if (!isPendingApproval) return
    if (!session?.user) return
    if (isRegistering) {
      console.log('Skipping auto-submit: registration in progress')
      return
    }

    const user = session.user
    const email = user.email
    const firstName = user.user_metadata?.first_name || ''
    const lastName = user.user_metadata?.last_name || ''

    if (!email) return

    async function submitAccessRequest() {
      try {
        const { data: { user: freshUser }, error: userErr } = await supabase.auth.getUser()
        if (userErr || !freshUser) {
          console.log('Could not verify user, skipping auto-submit')
          return
        }
        if (!freshUser.email_confirmed_at) {
          console.log('Email NOT actually confirmed (server check), skipping auto-submit')
          return
        }

        console.log('Email confirmed (server-verified), submitting access request for:', email)
        const { data, error } = await supabase.rpc('submit_access_request', {
          p_email: email.toLowerCase().trim(),
          p_first_name: firstName.trim(),
          p_last_name: lastName.trim(),
        })
        if (error) {
          console.error('Auto access request failed:', error)
        } else {
          console.log('Access request auto-submitted:', data)
        }
      } catch (err) {
        console.error('Error auto-submitting access request:', err)
      }
    }

    submitAccessRequest()
  }, [isPendingApproval, session?.user?.id, isRegistering])

  // ── Context Value ──────────────────────────────────────────────────

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    realProfile,
    loading,
    signIn,
    signOut,
    resetPassword,
    setIsRegistering,
    isAuthenticated: isFullyAuthenticated,
    isPendingApproval,
    isPendingEmailVerification,
    isInstructor: profile?.role === 'Instructor',
    isWorkStudy: profile?.role === 'Work Study',
    isStudent: profile?.role === 'Student',
    isEmulating,
    isSuperAdmin,
    startEmulation,
    stopEmulation,
    emulatedProfile,
    // ── Lab Access Mode ──
    labLocked,
    // ── Real-time Presence ──
    onlineUsers,
    presenceMeta,
    // ── Forced Password Change ──
    // True when an instructor reset this user's password via the Edge Function.
    // ProtectedRoute redirects to /change-password until this clears.
    mustChangePassword,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
