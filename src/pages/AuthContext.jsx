import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

const AuthContext = createContext(null)

const PROFILE_CACHE_KEY = 'rict_cmms_profile'

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

export function AuthProvider({ children }) {
  // Initialize profile from cache for instant display on tab reopen
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(() => getCachedProfile())
  const [loading, setLoading] = useState(true)
  // Flag to prevent auto-submit during registration flow
  const [isRegistering, setIsRegistering] = useState(false)

  // Load user profile from the profiles table
  async function loadProfile(userId, userEmail) {
    try {
      // Try email first — more reliable because the migrated profiles table
      // has text IDs (like "Aaron B.") not Supabase Auth UUIDs
      if (userEmail) {
        const { data: profileByEmail, error: emailError } = await supabase
          .from('profiles')
          .select('*')
          .eq('email', userEmail)
          .maybeSingle()

        if (profileByEmail && !emailError) {
          console.log('Profile loaded by email:', profileByEmail.email, profileByEmail.role)
          setProfile(profileByEmail)
          setCachedProfile(profileByEmail)
          return profileByEmail
        }

        // If query succeeded but no data, this user genuinely has no profile
        if (!emailError) {
          // Also try by ID before giving up
          const { data: profileById, error: idError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle()

          if (profileById && !idError) {
            console.log('Profile loaded by ID:', profileById.email, profileById.role)
            setProfile(profileById)
            setCachedProfile(profileById)
            return profileById
          }

          // Definitively no profile — clear stale cache
          console.warn('No profile found for:', userId, userEmail, '— clearing cache')
          setProfile(null)
          setCachedProfile(null)
          return null
        }
      }

      // Fallback: try by ID (works for newly created users whose id matches auth UUID)
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle()

      if (data && !error) {
        console.log('Profile loaded by ID:', data.email, data.role)
        setProfile(data)
        setCachedProfile(data)
        return data
      }

      if (!error) {
        // Query succeeded but no profile — clear cache
        console.warn('No profile found for:', userId, userEmail, '— clearing cache')
        setProfile(null)
        setCachedProfile(null)
      }
      // If there was an error, don't clear cache (could be network issue)
      return null
    } catch (err) {
      console.error('Profile load error:', err)
      // Network error — don't clear cache
      return null
    }
  }

  useEffect(() => {
    let mounted = true
    let initDone = false

    // If we have a cached profile, we can finish loading much faster
    const hasCache = !!getCachedProfile()

    // Failsafe timeout - longer to accommodate slow Supabase cold starts
    const timeout = setTimeout(() => {
      if (mounted && loading) {
        console.warn('Auth loading timeout - forcing completion')
        setLoading(false)
      }
    }, hasCache ? 3000 : 8000)

    async function initAuth(attempt = 1) {
      try {
        const { data: { user }, error } = await supabase.auth.getUser()

        if (!mounted) return

        if (user && !error) {
          console.log('User authenticated:', user.email)
          setSession({ user })
          await loadProfile(user.id, user.email)
        } else if (error && attempt < 3) {
          // Retry on transient errors (network issues, cold starts)
          console.warn(`Auth attempt ${attempt} failed, retrying in ${attempt * 1000}ms...`, error.message)
          await new Promise(r => setTimeout(r, attempt * 1000))
          if (mounted) return initAuth(attempt + 1)
        } else {
          console.log('No authenticated user')
          setSession(null)
          setProfile(null)
          setCachedProfile(null)
        }
      } catch (err) {
        console.error('Auth init error:', err)
        if (!mounted) return
        // Retry on network errors
        if (attempt < 3) {
          console.warn(`Auth attempt ${attempt} threw, retrying in ${attempt * 1000}ms...`)
          await new Promise(r => setTimeout(r, attempt * 1000))
          if (mounted) return initAuth(attempt + 1)
        }
        // If we have a cached profile, don't wipe it on network error
        if (!getCachedProfile()) {
          setSession(null)
          setProfile(null)
        }
      } finally {
        if (mounted) {
          initDone = true
          setLoading(false)
        }
      }
    }

    initAuth()

    // Listen for future auth changes (login/logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, s) => {
        console.log('Auth event:', event)
        if (!mounted) return

        if (event === 'SIGNED_IN' && s?.user) {
          setSession(s)

          // During init - loadProfile is already being called by initAuth
          if (!initDone) return

          // Always load profile from database to ensure it still exists
          // (user may have been deleted since last visit)
          await loadProfile(s.user.id, s.user.email)
          setLoading(false)
        } else if (event === 'SIGNED_OUT') {
          setSession(null)
          setProfile(null)
          setCachedProfile(null)
          setLoading(false)
        } else if (event === 'TOKEN_REFRESHED' && s?.user) {
          // Token refreshed - just update session, keep profile as-is
          setSession(s)
        }
        // Ignore INITIAL_SESSION - we handle init via getUser() above
      }
    )

    return () => {
      mounted = false
      clearTimeout(timeout)
      subscription.unsubscribe()
    }
  }, [])

  // Realtime: auto-refresh profile when it changes (e.g. role updated by instructor)
  useEffect(() => {
    if (!profile?.email) return
    const channel = supabase
      .channel('profile-realtime')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `email=eq.${profile.email}` },
        (payload) => {
          console.log('Profile updated via realtime:', payload.new?.role)
          setProfile(payload.new)
          setCachedProfile(payload.new)
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.email])

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    return data
  }

  async function signOut() {
    try {
      await supabase.auth.signOut()
    } catch (err) {
      console.error('Sign out error:', err)
    }
    setProfile(null)
    setSession(null)
    setCachedProfile(null)
  }

  async function resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) throw error
  }

  // User is only fully authenticated when they have BOTH a session AND an approved profile.
  // This prevents the dashboard flash when a new user signs up (session exists but no profile yet).
  const isFullyAuthenticated = !!session && !!profile

  // Check email confirmation status
  const userEmailConfirmed = session?.user?.email_confirmed_at != null
  // Pending email verification = has session but email NOT confirmed
  const isPendingEmailVerification = !!session && !userEmailConfirmed && !profile && !loading
  // Pending approval = has session, email IS confirmed, but no profile yet
  const isPendingApproval = !!session && userEmailConfirmed && !profile && !loading

  // When user's email is confirmed and they have no profile, auto-submit access request
  useEffect(() => {
    if (!isPendingApproval) return
    if (!session?.user) return
    // Don't auto-submit during registration — the signUp briefly fires SIGNED_IN
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
        // Double-check with server that email is actually confirmed
        // (the session object can be stale or incorrect during signup)
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

  const value = {
    session,
    user: session?.user ?? null,
    profile,
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
