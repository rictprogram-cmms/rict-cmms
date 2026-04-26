import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { Wrench, Eye, EyeOff, Loader2, CheckCircle, ArrowLeft, Clock, Mail, Lock, ShieldCheck, RefreshCw } from 'lucide-react'

// ── LoginPage ───────────────────────────────────────────────────────────────
//
// Registration flow (OTP-verified):
//   Step 1 → Enter email (check if already registered / pending)
//   Step 2 → Verify email with 6-digit OTP code sent to inbox
//   Step 3 → Complete profile (first name, last name, password)
//   Step 4 → Success — awaiting instructor approval
//
// Forgot-password flow (OTP-verified, no redirect link needed):
//   Step 1 → Enter email → send OTP
//   Step 2 → Enter OTP code + new password + confirm → verify & update
//   Step 3 → Success — back to login
//
// NOTE: The kiosk gate (KioskWall / isKioskAuthorised) has been intentionally
// removed from this file. The /time-clock route is already protected by
// <KioskRoute> in App.jsx, which redirects non-kiosk browsers away from that
// page. Blocking the login page itself prevented students on personal devices
// from ever logging in to access Lab Signup and other features.

// ── Password Strength Helper ───────────────────────────────────────────────
function getPasswordStrength(pw) {
  if (!pw || pw.length === 0) return null
  let types = 0
  if (/[a-z]/.test(pw)) types++
  if (/[A-Z]/.test(pw)) types++
  if (/[0-9]/.test(pw)) types++
  if (/[^A-Za-z0-9]/.test(pw)) types++

  if (pw.length < 6) return { label: 'Too short', color: 'bg-red-400', width: 'w-1/5', textColor: 'text-red-500' }
  if (pw.length < 8 || types <= 1) return { label: 'Weak', color: 'bg-red-400', width: 'w-1/4', textColor: 'text-red-500' }
  if (types === 2) return { label: 'Fair', color: 'bg-amber-400', width: 'w-2/4', textColor: 'text-amber-600' }
  if (types === 3) return { label: 'Good', color: 'bg-yellow-400', width: 'w-3/4', textColor: 'text-yellow-600' }
  return { label: 'Strong', color: 'bg-emerald-500', width: 'w-full', textColor: 'text-emerald-600' }
}

// ── Password Strength Bar Component ────────────────────────────────────────
function PasswordStrengthBar({ password }) {
  const strength = getPasswordStrength(password)
  if (!strength) return null
  return (
    <div className="mt-1.5" aria-live="polite">
      <div className="h-1 w-full bg-surface-100 rounded-full overflow-hidden" role="meter" aria-label="Password strength" aria-valuenow={strength.label === 'Too short' ? 0 : strength.label === 'Weak' ? 25 : strength.label === 'Fair' ? 50 : strength.label === 'Good' ? 75 : 100} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-all duration-300 ${strength.color} ${strength.width}`} />
      </div>
      <p className={`text-[10px] mt-0.5 font-medium ${strength.textColor}`}>{strength.label}</p>
    </div>
  )
}

// ── Step Progress Indicator ────────────────────────────────────────────────
function StepIndicator({ currentStep, totalSteps, labels }) {
  return (
    <div className="flex items-center justify-center gap-1.5 mb-5" role="navigation" aria-label="Registration progress">
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1
        const isActive = step === currentStep
        const isComplete = step < currentStep
        return (
          <div key={step} className="flex items-center gap-1.5">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                isComplete ? 'bg-emerald-500 text-white' :
                isActive ? 'bg-brand-600 text-white' :
                'bg-surface-200 text-surface-400'
              }`}
              aria-label={`Step ${step}: ${labels[i]}${isComplete ? ' (complete)' : isActive ? ' (current)' : ''}`}
              aria-current={isActive ? 'step' : undefined}
            >
              {/* aria-hidden because the parent's aria-label already announces
                  the step number AND its completion state to screen readers.
                  Without this, the visible '✓' or step number is read as
                  redundant noise (e.g. "Step 2: Verify (complete) check mark"). */}
              <span aria-hidden="true">{isComplete ? '✓' : step}</span>
            </div>
            {step < totalSteps && (
              <div className={`w-6 h-0.5 ${isComplete ? 'bg-emerald-400' : 'bg-surface-200'}`} aria-hidden="true" />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function LoginPage() {
  const { signIn, user, isPendingApproval, isDeactivated, signOut, setIsRegistering } = useAuth()

  // ── Shared State ─────────────────────────────────────────────────────────
  const [mode, setMode] = useState('login') // login | register | forgot
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const errorRef = useRef(null)

  // ── Login State ──────────────────────────────────────────────────────────
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // ── Registration State ───────────────────────────────────────────────────
  // Steps: 1=email, 2=verify OTP, 3=profile+password, 4=success
  const [regStep, setRegStep] = useState(1)
  const [regEmail, setRegEmail] = useState('')
  const [regOtp, setRegOtp] = useState('')
  const [regFirstName, setRegFirstName] = useState('')
  const [regLastName, setRegLastName] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regPasswordConfirm, setRegPasswordConfirm] = useState('')
  const [showRegPassword, setShowRegPassword] = useState(false)
  // True if the access_request submission failed during step 3, so step 4
  // can show a softer success-with-warning message. (AuthContext has an
  // auto-submit safety net that re-tries on the user's next sign-in
  // attempt, so this is informational rather than a hard block.)
  const [regSubmitWarning, setRegSubmitWarning] = useState(false)

  // ── Forgot Password State ────────────────────────────────────────────────
  // Steps: 1=email, 2=verify OTP + new password, 3=success
  const [forgotStep, setForgotStep] = useState(1)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotOtp, setForgotOtp] = useState('')
  const [forgotPassword, setForgotPassword] = useState('')
  const [forgotPasswordConfirm, setForgotPasswordConfirm] = useState('')
  const [showForgotPassword, setShowForgotPassword] = useState(false)

  // ── Resend Cooldown Timer ────────────────────────────────────────────────
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(() => setResendCooldown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCooldown])

  // ── Scroll to error when it changes ──────────────────────────────────────
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [error])

  // If user has auth session but no profile, show pending approval screen
  // Exclude register and forgot modes so the user can finish their flow
  const showPendingScreen = isPendingApproval && mode !== 'register' && mode !== 'forgot'
  // Same gating, but for the deactivated case (status !== 'Active' on file)
  const showDeactivatedScreen = isDeactivated && mode !== 'register' && mode !== 'forgot'

  // ── Real-time: auto-detect when instructor approves the user ─────────────
  // When the user is logged in but awaiting approval, subscribe to the
  // profiles table. The moment a row is inserted/updated with status='Active'
  // for their email, reload the page so AuthContext picks up the new profile.
  useEffect(() => {
    if (!showPendingScreen) return
    const userEmail = user?.email
    if (!userEmail) return

    const channel = supabase
      .channel('approval-watch')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'profiles',
          filter: `email=eq.${userEmail}`,
        },
        (payload) => {
          if (payload.new?.status === 'Active') {
            console.log('Profile approved! Reloading...')
            window.location.reload()
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [showPendingScreen, user?.email])

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Login ────────────────────────────────────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(email, password)
    } catch (err) {
      const msg = err.message?.toLowerCase() || ''
      if (msg.includes('invalid login credentials')) {
        setError('Invalid email or password. Please try again.')
      } else if (msg.includes('email not confirmed') || msg.includes('not confirmed')) {
        setError('Account issue. Please contact an instructor for assistance.')
      } else {
        setError(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  // ── Register Step 1: Check email + send OTP ──────────────────────────────
  async function handleRegStep1(e) {
    e.preventDefault()
    setError('')
    if (!regEmail.trim()) return

    setLoading(true)
    try {
      const cleanEmail = regEmail.toLowerCase().trim()

      // Check if the email already has an approved profile
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('email')
        .eq('email', cleanEmail)
        .maybeSingle()

      if (existingUser) {
        setError('This email is already registered. Please log in instead.')
        setLoading(false)
        return
      }

      // Check if there's already a pending access request
      const { data: existingRequest } = await supabase
        .from('access_requests')
        .select('request_id, status')
        .eq('email', cleanEmail)
        .eq('status', 'Pending')
        .maybeSingle()

      if (existingRequest) {
        setError('An access request for this email is already pending. Please wait for instructor approval.')
        setLoading(false)
        return
      }

      // Tell AuthContext not to auto-submit access request during registration
      setIsRegistering(true)

      // Send OTP to the email (creates auth user if doesn't exist)
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: true },
      })

      if (otpError) {
        if (otpError.message?.includes('rate limit')) {
          throw new Error('Too many attempts. Please wait a few minutes and try again.')
        }
        throw otpError
      }

      // Move to OTP verification step
      setResendCooldown(60)
      setRegStep(2)
    } catch (err) {
      setError(err.message || 'Failed to send verification code.')
      setIsRegistering(false)
    } finally {
      setLoading(false)
    }
  }

  // ── Register Step 2: Verify OTP ──────────────────────────────────────────
  async function handleRegVerifyOtp(e) {
    e.preventDefault()
    setError('')
    if (!regOtp.trim()) return

    setLoading(true)
    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        email: regEmail.toLowerCase().trim(),
        token: regOtp.trim(),
        type: 'email',
      })

      if (verifyError) {
        if (verifyError.message?.includes('expired')) {
          throw new Error('Code has expired. Please request a new one.')
        }
        throw new Error('Invalid verification code. Please check and try again.')
      }

      // OTP verified — session is now active
      // Move to profile/password step
      setRegStep(3)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Register Step 3: Complete profile + submit access request ────────────
  async function handleRegComplete(e) {
    e.preventDefault()
    setError('')

    if (!regFirstName.trim() || !regLastName.trim()) {
      setError('First and last name are required.')
      return
    }
    if (regPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (regPassword !== regPasswordConfirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const cleanEmail = regEmail.toLowerCase().trim()
      const cleanFirst = regFirstName.trim()
      const cleanLast = regLastName.trim()

      // Set password and user metadata on the authenticated user
      const { error: updateError } = await supabase.auth.updateUser({
        password: regPassword,
        data: {
          first_name: cleanFirst,
          last_name: cleanLast,
        },
      })

      if (updateError) throw updateError

      // ── Submit the access request for instructor approval ─────────────────
      // Strategy:
      //   1. Try the canonical RPC `submit_access_request` (SECURITY DEFINER
      //      on the server side, so it bypasses any RLS quirks).
      //   2. If that errors, fall back to a direct INSERT with a `.select()`
      //      to surface silent RLS failures (per project convention).
      //   3. If BOTH fail, we don't fail the registration outright — the
      //      AuthContext auto-submit safety net will retry on the user's
      //      next sign-in attempt. We DO flip a flag so step 4 can warn.
      let submitOk = false
      try {
        const { error: rpcError } = await supabase.rpc('submit_access_request', {
          p_email: cleanEmail,
          p_first_name: cleanFirst,
          p_last_name: cleanLast,
        })
        if (!rpcError) {
          submitOk = true
        } else {
          console.error('Access request RPC failed, trying direct insert:', rpcError)

          // Get a request_id from the canonical counter. Note: parameter is
          // `p_type`, not `id_type` (recurring project gotcha).
          let requestId
          try {
            const { data: idData, error: idErr } = await supabase.rpc('get_next_id', { p_type: 'access_request' })
            if (!idErr && idData) requestId = idData
          } catch (idCatch) {
            console.warn('get_next_id RPC threw, will use timestamp fallback:', idCatch)
          }
          if (!requestId) {
            requestId = `AR${Date.now()}`
            console.warn('Using timestamp-based access request ID:', requestId)
          }

          // .select() so silent RLS failures show up as empty `data`
          // rather than a fake-success no-op (per project standard).
          const { data: insertData, error: insertErr } = await supabase
            .from('access_requests')
            .insert([{
              request_id: requestId,
              email: cleanEmail,
              first_name: cleanFirst,
              last_name: cleanLast,
              request_date: new Date().toISOString(),
              status: 'Pending',
              requested_role: 'Student',
            }])
            .select()

          if (insertErr) {
            console.error('Direct insert into access_requests also failed:', insertErr)
          } else if (!insertData || insertData.length === 0) {
            console.error('Direct insert into access_requests returned no rows — likely an RLS denial.')
          } else {
            submitOk = true
          }
        }
      } catch (accessErr) {
        console.error('Access request submission threw:', accessErr)
        // Fall through — submitOk stays false, registration still succeeds,
        // safety net auto-submit will retry on next sign-in.
      }

      // Sign out — user must wait for instructor approval
      try { await supabase.auth.signOut() } catch {}

      // Clear registering flag, set the warning flag for step 4 if needed,
      // then advance to the success screen.
      setIsRegistering(false)
      setRegSubmitWarning(!submitOk)
      setRegStep(4)
    } catch (err) {
      setError(err.message)
      // If something failed badly, sign out to be safe
      try { await supabase.auth.signOut() } catch {}
      setIsRegistering(false)
    } finally {
      setLoading(false)
    }
  }

  // ── Forgot Password Step 1: Check email + send OTP ───────────────────────
  async function handleForgotStep1(e) {
    e.preventDefault()
    setError('')
    if (!forgotEmail.trim()) return

    setLoading(true)
    try {
      const cleanEmail = forgotEmail.toLowerCase().trim()

      // Verify the email exists in our system (profiles or access_requests)
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('email')
        .eq('email', cleanEmail)
        .maybeSingle()

      const { data: existingRequest } = await supabase
        .from('access_requests')
        .select('email')
        .eq('email', cleanEmail)
        .maybeSingle()

      if (!existingProfile && !existingRequest) {
        setError('No account found with this email. Please register instead.')
        setLoading(false)
        return
      }

      // Send OTP code (do NOT create a new user)
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: false },
      })

      if (otpError) {
        if (otpError.message?.includes('rate limit')) {
          throw new Error('Too many attempts. Please wait a few minutes and try again.')
        }
        throw otpError
      }

      setResendCooldown(60)
      setForgotStep(2)
    } catch (err) {
      setError(err.message || 'Failed to send verification code.')
    } finally {
      setLoading(false)
    }
  }

  // ── Forgot Password Step 2: Verify OTP + Set new password ────────────────
  // NOTE: We collect OTP + new password on the same form and process them
  // in one handler to avoid routing issues (verifyOtp creates a session which
  // could cause the router to redirect before the password is set).
  async function handleForgotStep2(e) {
    e.preventDefault()
    setError('')

    if (!forgotOtp.trim()) {
      setError('Please enter the verification code.')
      return
    }
    if (forgotPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (forgotPassword !== forgotPasswordConfirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      // Tell AuthContext not to auto-redirect during this flow
      setIsRegistering(true)

      // 1. Verify the OTP code (creates a session)
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: forgotEmail.toLowerCase().trim(),
        token: forgotOtp.trim(),
        type: 'email',
      })

      if (verifyError) {
        setIsRegistering(false)
        if (verifyError.message?.includes('expired')) {
          throw new Error('Code has expired. Please go back and request a new one.')
        }
        throw new Error('Invalid verification code. Please check and try again.')
      }

      // 2. Immediately update the password (session is now active)
      const { error: pwError } = await supabase.auth.updateUser({
        password: forgotPassword,
      })

      if (pwError) {
        // Sign out on failure to avoid limbo state
        try { await supabase.auth.signOut() } catch {}
        setIsRegistering(false)
        throw pwError
      }

      // 3. Sign out so user can log in fresh with new password
      try { await supabase.auth.signOut() } catch {}
      setIsRegistering(false)

      // 4. Show success
      setForgotStep(3)
    } catch (err) {
      setError(err.message || 'Failed to reset password.')
    } finally {
      setLoading(false)
    }
  }

  // ── Resend OTP (shared for registration and forgot password) ─────────────
  async function handleResendOtp() {
    if (resendCooldown > 0) return
    setError('')
    setLoading(true)
    try {
      const targetEmail = mode === 'register'
        ? regEmail.toLowerCase().trim()
        : forgotEmail.toLowerCase().trim()

      const { error: resendError } = await supabase.auth.signInWithOtp({
        email: targetEmail,
        options: { shouldCreateUser: mode === 'register' },
      })

      if (resendError) throw resendError

      setResendCooldown(60)
    } catch (err) {
      setError('Failed to resend code: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function switchToMode(newMode) {
    setMode(newMode)
    setError('')
    setRegStep(1)
    setForgotStep(1)
    setResendCooldown(0)
    setRegSubmitWarning(false)
  }

  function resetRegistration() {
    setRegStep(1)
    setRegEmail('')
    setRegOtp('')
    setRegFirstName('')
    setRegLastName('')
    setRegPassword('')
    setRegPasswordConfirm('')
    setShowRegPassword(false)
    setRegSubmitWarning(false)
    setError('')
    setIsRegistering(false)
    // Sign out in case OTP already created a session
    supabase.auth.signOut().catch(() => {})
  }

  function resetForgotPassword() {
    setForgotStep(1)
    setForgotOtp('')
    setForgotPassword('')
    setForgotPasswordConfirm('')
    setShowForgotPassword(false)
    setError('')
    setResendCooldown(0)
  }

  // ── Error Display Component ──────────────────────────────────────────────
  function ErrorAlert({ message }) {
    if (!message) return null
    return (
      <div
        ref={errorRef}
        role="alert"
        aria-live="assertive"
        className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
      >
        {message}
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-surface-900 via-brand-950 to-surface-900 px-4">
      {/* Subtle pattern overlay */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/G%3E%3C/svg%3E")`,
      }} />

      <div className="relative w-full max-w-sm">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600 shadow-lg mb-4">
            <Wrench size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">RICT CMMS</h1>
          <p className="text-sm text-surface-400 mt-1">Computerized Maintenance Management System</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">

          {/* ════════ PENDING APPROVAL SCREEN ════════ */}
          {showPendingScreen ? (
            <div className="p-6 text-center py-10" role="status">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 mb-4" aria-hidden="true">
                <Clock size={32} className="text-amber-600" />
              </div>
              <h2 className="text-lg font-semibold text-surface-900 mb-2">Awaiting Approval</h2>
              <p className="text-sm text-surface-500 mb-2">
                Your access request has been submitted and is waiting for instructor approval.
              </p>
              <p className="text-sm text-surface-500 mb-4">
                This page will automatically update once you're approved.
              </p>

              {/* Live listening indicator */}
              <div className="flex items-center justify-center gap-2 text-xs text-surface-400 mb-6" aria-live="polite">
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Listening for approval…
              </div>

              <button
                onClick={async () => { await signOut() }}
                className="btn-secondary text-sm px-4 py-2"
              >
                Sign Out
              </button>
            </div>
          ) : showDeactivatedScreen ? (
            /* ════════ DEACTIVATED ACCOUNT SCREEN ════════
               Phase 2: Distinct from "Awaiting Approval." Triggered when a
               profile row exists for this user but status !== 'Active'. The
               instructor has either archived/suspended the account or it's
               held in a non-active state for some other reason. Differs
               from pending approval in two ways: (1) there's no realtime
               listener for status flips here — if/when an instructor
               re-activates them, they'll need to sign in again, and (2)
               the call to action is "contact your instructor" rather than
               "wait."  No specific reason is shown to the user; that
               conversation belongs offline. */
            <div className="p-6 text-center py-10" role="status">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 mb-4" aria-hidden="true">
                <Lock size={32} className="text-red-600" />
              </div>
              <h2 className="text-lg font-semibold text-surface-900 mb-2">Account Inactive</h2>
              <p className="text-sm text-surface-500 mb-2">
                Your account is currently inactive and cannot access the system.
              </p>
              <p className="text-sm text-surface-500 mb-6">
                Please contact your instructor for assistance.
              </p>
              <button
                onClick={async () => { await signOut() }}
                className="btn-secondary text-sm px-4 py-2"
              >
                Sign Out
              </button>
            </div>
          ) : (
          <>

          {/* Tabs (Login / Register) — hidden in forgot mode */}
          {mode !== 'forgot' && (
            <div className="flex border-b border-surface-200" role="tablist" aria-label="Account options">
              <button
                role="tab"
                aria-selected={mode === 'login'}
                aria-controls="login-panel"
                id="login-tab"
                onClick={() => switchToMode('login')}
                className={`flex-1 py-3 text-sm font-semibold text-center transition-colors ${
                  mode === 'login'
                    ? 'text-brand-600 border-b-2 border-brand-600 bg-white'
                    : 'text-surface-400 hover:text-surface-600 bg-surface-50'
                }`}
              >
                Login
              </button>
              <button
                role="tab"
                aria-selected={mode === 'register'}
                aria-controls="register-panel"
                id="register-tab"
                onClick={() => switchToMode('register')}
                className={`flex-1 py-3 text-sm font-semibold text-center transition-colors ${
                  mode === 'register'
                    ? 'text-brand-600 border-b-2 border-brand-600 bg-white'
                    : 'text-surface-400 hover:text-surface-600 bg-surface-50'
                }`}
              >
                Register
              </button>
            </div>
          )}

          {/* Card body */}
          <div className="p-6">

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* LOGIN                                                          */}
            {/* ════════════════════════════════════════════════════════════════ */}
            {mode === 'login' && (
              <div id="login-panel" role="tabpanel" aria-labelledby="login-tab">
                <h2 className="text-lg font-semibold text-surface-900 mb-1">Sign in to your account</h2>
                <form onSubmit={handleLogin} className="space-y-4 mt-4" noValidate>
                  <div>
                    <label htmlFor="login-email" className="label">Email</label>
                    <input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="input"
                      placeholder="you@sctcc.edu"
                      required
                      autoComplete="email"
                      autoFocus
                      aria-describedby={error ? 'login-error' : undefined}
                    />
                  </div>
                  <div>
                    <label htmlFor="login-password" className="label">Password</label>
                    <div className="relative">
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="input pr-10"
                        placeholder="Enter your password"
                        required
                        autoComplete="current-password"
                        aria-describedby={error ? 'login-error' : undefined}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-surface-400 hover:text-surface-600"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <ErrorAlert message={error} />

                  <button type="submit" disabled={loading} className="btn-primary w-full">
                    {loading ? (
                      <><Loader2 size={16} className="animate-spin" /> Signing in...</>
                    ) : 'Sign In'}
                  </button>
                </form>

                <div className="mt-4 text-center">
                  <button
                    onClick={() => switchToMode('forgot')}
                    className="text-xs text-brand-600 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded"
                  >
                    Forgot your password?
                  </button>
                </div>
              </div>
            )}

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* REGISTER                                                       */}
            {/* ════════════════════════════════════════════════════════════════ */}
            {mode === 'register' && (
              <div id="register-panel" role="tabpanel" aria-labelledby="register-tab">

                {/* ── Step 1: Enter Email ────────────────────────────────── */}
                {regStep === 1 && (
                  <>
                    <StepIndicator currentStep={1} totalSteps={3} labels={['Email', 'Verify', 'Profile']} />
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-surface-900">Request Access</h2>
                      <p className="text-sm text-surface-500 mt-1">Enter your email to get started. We'll send you a verification code.</p>
                    </div>
                    <form onSubmit={handleRegStep1} className="space-y-4" noValidate>
                      <div>
                        <label htmlFor="reg-email" className="label">Email</label>
                        <input
                          id="reg-email"
                          type="email"
                          value={regEmail}
                          onChange={(e) => setRegEmail(e.target.value)}
                          className="input"
                          placeholder="you@sctcc.edu"
                          required
                          autoComplete="email"
                          autoFocus
                          aria-describedby={error ? 'reg-error' : 'reg-email-hint'}
                        />
                        <p id="reg-email-hint" className="text-xs text-surface-400 mt-1">
                          Use your school email address
                        </p>
                      </div>

                      <ErrorAlert message={error} />

                      <button type="submit" disabled={loading} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Sending code...</>
                        ) : 'Send Verification Code'}
                      </button>
                    </form>
                  </>
                )}

                {/* ── Step 2: Enter OTP Code ─────────────────────────────── */}
                {regStep === 2 && (
                  <>
                    <StepIndicator currentStep={2} totalSteps={3} labels={['Email', 'Verify', 'Profile']} />
                    <div className="mb-6">
                      <button
                        onClick={resetRegistration}
                        className="flex items-center gap-1 text-sm text-surface-400 hover:text-surface-600 mb-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
                        aria-label="Go back to email entry"
                      >
                        <ArrowLeft size={14} /> Back
                      </button>
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-brand-100 mb-3">
                        <Mail size={22} className="text-brand-600" />
                      </div>
                      <h2 className="text-lg font-semibold text-surface-900">Check Your Email</h2>
                      <p className="text-sm text-surface-500 mt-1">
                        We sent a 6-digit verification code to:
                      </p>
                      <p className="text-sm font-semibold text-surface-800 mt-1">{regEmail}</p>
                    </div>
                    <form onSubmit={handleRegVerifyOtp} className="space-y-4" noValidate>
                      <div>
                        <label htmlFor="reg-otp" className="label">Verification Code</label>
                        <input
                          id="reg-otp"
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={6}
                          value={regOtp}
                          onChange={(e) => setRegOtp(e.target.value.replace(/\D/g, ''))}
                          /* tracking-[0.15em] (was 0.3em) so the field stays
                             readable at 200% browser zoom — wider tracking
                             pushed digits past the right edge of the input. */
                          className="input text-center text-xl tracking-[0.15em] font-mono"
                          placeholder="000000"
                          required
                          autoFocus
                          autoComplete="one-time-code"
                          aria-describedby="reg-otp-hint"
                        />
                        <p id="reg-otp-hint" className="text-xs text-surface-400 mt-1">
                          Enter the 6-digit code from your email
                        </p>
                      </div>

                      <ErrorAlert message={error} />

                      <button type="submit" disabled={loading || regOtp.length < 6} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Verifying...</>
                        ) : 'Verify Code'}
                      </button>
                    </form>

                    {/* Resend Code */}
                    <div className="mt-4 text-center">
                      {resendCooldown > 0 ? (
                        <p className="text-xs text-surface-400" aria-live="polite">
                          Resend code in {resendCooldown}s
                        </p>
                      ) : (
                        <button
                          onClick={handleResendOtp}
                          disabled={loading}
                          className="text-xs text-brand-600 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded inline-flex items-center gap-1"
                        >
                          <RefreshCw size={12} /> Resend code
                        </button>
                      )}
                    </div>

                    {/* Spam notice */}
                    <p className="text-[10px] text-surface-400 text-center mt-3">
                      Don't see it? Check your spam or junk folder.
                    </p>
                  </>
                )}

                {/* ── Step 3: Complete Profile + Password ────────────────── */}
                {regStep === 3 && (
                  <>
                    <StepIndicator currentStep={3} totalSteps={3} labels={['Email', 'Verify', 'Profile']} />
                    <div className="mb-4">
                      <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-100 mb-2">
                        <ShieldCheck size={20} className="text-emerald-600" />
                      </div>
                      <h2 className="text-lg font-semibold text-surface-900">Complete Your Profile</h2>
                      <p className="text-sm text-surface-500 mt-1">
                        Email verified! Set up your account for <strong className="text-surface-700">{regEmail}</strong>
                      </p>
                    </div>
                    <form onSubmit={handleRegComplete} className="space-y-4" noValidate>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="reg-first" className="label">First Name</label>
                          <input
                            id="reg-first"
                            type="text"
                            value={regFirstName}
                            onChange={(e) => setRegFirstName(e.target.value)}
                            className="input"
                            placeholder="First"
                            required
                            autoComplete="given-name"
                            autoFocus
                          />
                        </div>
                        <div>
                          <label htmlFor="reg-last" className="label">Last Name</label>
                          <input
                            id="reg-last"
                            type="text"
                            value={regLastName}
                            onChange={(e) => setRegLastName(e.target.value)}
                            className="input"
                            placeholder="Last"
                            required
                            autoComplete="family-name"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="reg-password" className="label">Password</label>
                        <div className="relative">
                          <input
                            id="reg-password"
                            type={showRegPassword ? 'text' : 'password'}
                            value={regPassword}
                            onChange={(e) => setRegPassword(e.target.value)}
                            className="input pr-10"
                            placeholder="At least 8 characters"
                            required
                            minLength={8}
                            autoComplete="new-password"
                            /* Two ids: the static requirements hint + the
                               dynamic strength meter. Screen readers
                               concatenate both, so users hear the rule and
                               the current strength. */
                            aria-describedby="reg-pw-requirements reg-pw-strength"
                          />
                          <button
                            type="button"
                            onClick={() => setShowRegPassword(!showRegPassword)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-surface-400 hover:text-surface-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                            aria-label={showRegPassword ? 'Hide password' : 'Show password'}
                          >
                            {showRegPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                          </button>
                        </div>
                        <p id="reg-pw-requirements" className="text-xs text-surface-400 mt-1">
                          Must be at least 8 characters.
                        </p>
                        <div id="reg-pw-strength">
                          <PasswordStrengthBar password={regPassword} />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="reg-confirm" className="label">Confirm Password</label>
                        <input
                          id="reg-confirm"
                          type="password"
                          value={regPasswordConfirm}
                          onChange={(e) => setRegPasswordConfirm(e.target.value)}
                          className={`input ${regPasswordConfirm && regPassword !== regPasswordConfirm ? 'border-red-300 focus:ring-red-400' : ''}`}
                          placeholder="Confirm password"
                          required
                          autoComplete="new-password"
                          aria-describedby="reg-confirm-hint"
                        />
                        {regPasswordConfirm && regPassword !== regPasswordConfirm && (
                          <p id="reg-confirm-hint" className="text-xs text-red-500 mt-1" role="alert">
                            Passwords do not match
                          </p>
                        )}
                      </div>

                      <ErrorAlert message={error} />

                      <button type="submit" disabled={loading} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Submitting request...</>
                        ) : 'Submit Request'}
                      </button>
                    </form>
                  </>
                )}

                {/* ── Step 4: Success — Awaiting Approval ────────────────── */}
                {regStep === 4 && (
                  <div className="text-center py-6" role="status" aria-live="polite">
                    {regSubmitWarning ? (
                      /* Warning variant: account was created in auth, but
                         the access_request submission didn't go through
                         cleanly. AuthContext has an auto-submit safety
                         net that retries on the user's next sign-in
                         attempt, so the recovery path is "try logging
                         in shortly." We don't expose the internal flow
                         to the user. */
                      <>
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 mb-4" aria-hidden="true">
                          <Clock size={32} className="text-amber-600" />
                        </div>
                        <h3 className="text-lg font-semibold text-surface-900 mb-2">Account Created</h3>
                        <p className="text-sm text-surface-500 mb-3">
                          Your account was created for:
                        </p>
                        <p className="text-sm font-semibold text-surface-800 mb-4">{regEmail}</p>
                        <div className="px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 mb-4 text-left" role="alert">
                          <p className="text-sm text-amber-800 font-medium">One more step</p>
                          <p className="text-xs text-amber-700 mt-1">
                            We had trouble notifying your instructor. Please try
                            signing in shortly — the system will retry
                            automatically. If you still can't get in after a
                            day, contact your instructor directly.
                          </p>
                        </div>
                        <button
                          onClick={() => switchToMode('login')}
                          className="btn-primary"
                        >
                          Back to Login
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-4" aria-hidden="true">
                          <CheckCircle size={32} className="text-emerald-600" />
                        </div>
                        <h3 className="text-lg font-semibold text-surface-900 mb-2">Request Submitted!</h3>
                        <p className="text-sm text-surface-500 mb-3">
                          Your access request has been sent for:
                        </p>
                        <p className="text-sm font-semibold text-surface-800 mb-4">{regEmail}</p>

                        <div className="px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 mb-4">
                          <p className="text-sm text-amber-800 font-medium">What happens next:</p>
                          <ol className="text-xs text-amber-700 mt-2 text-left space-y-1 pl-4 list-decimal">
                            <li>An instructor will review your request</li>
                            <li>Once approved, you can log in with your email and password</li>
                          </ol>
                        </div>

                        <p className="text-xs text-surface-400 mb-4">
                          This usually takes less than a day during the school week.
                        </p>
                        <button
                          onClick={() => switchToMode('login')}
                          className="btn-primary"
                        >
                          Back to Login
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* FORGOT PASSWORD                                                */}
            {/* ════════════════════════════════════════════════════════════════ */}
            {mode === 'forgot' && (
              <div>

                {/* ── Step 1: Enter Email ────────────────────────────────── */}
                {forgotStep === 1 && (
                  <>
                    <button
                      onClick={() => switchToMode('login')}
                      className="flex items-center gap-1 text-sm text-surface-400 hover:text-surface-600 mb-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
                      aria-label="Go back to login"
                    >
                      <ArrowLeft size={14} /> Back to Login
                    </button>
                    <h2 className="text-lg font-semibold text-surface-900 mb-2">Reset Password</h2>
                    <p className="text-sm text-surface-500 mb-6">
                      Enter your email and we'll send you a verification code to reset your password.
                    </p>

                    <form onSubmit={handleForgotStep1} className="space-y-4" noValidate>
                      <div>
                        <label htmlFor="forgot-email" className="label">Email</label>
                        <input
                          id="forgot-email"
                          type="email"
                          value={forgotEmail}
                          onChange={(e) => setForgotEmail(e.target.value)}
                          className="input"
                          placeholder="you@sctcc.edu"
                          required
                          autoComplete="email"
                          autoFocus
                          aria-describedby={error ? 'forgot-error' : undefined}
                        />
                      </div>

                      <ErrorAlert message={error} />

                      <button type="submit" disabled={loading} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Sending code...</>
                        ) : 'Send Verification Code'}
                      </button>
                    </form>
                  </>
                )}

                {/* ── Step 2: Verify OTP + Set New Password ──────────────── */}
                {forgotStep === 2 && (
                  <>
                    <button
                      onClick={resetForgotPassword}
                      className="flex items-center gap-1 text-sm text-surface-400 hover:text-surface-600 mb-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
                      aria-label="Go back to email entry"
                    >
                      <ArrowLeft size={14} /> Back
                    </button>

                    <div className="mb-4">
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-brand-100 mb-3">
                        <Lock size={22} className="text-brand-600" />
                      </div>
                      <h2 className="text-lg font-semibold text-surface-900">Reset Your Password</h2>
                      <p className="text-sm text-surface-500 mt-1">
                        Enter the verification code sent to <strong className="text-surface-700">{forgotEmail}</strong> and choose a new password.
                      </p>
                    </div>

                    <form onSubmit={handleForgotStep2} className="space-y-4" noValidate>
                      {/* Verification Code */}
                      <div>
                        <label htmlFor="forgot-otp" className="label">Verification Code</label>
                        <input
                          id="forgot-otp"
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={6}
                          value={forgotOtp}
                          onChange={(e) => setForgotOtp(e.target.value.replace(/\D/g, ''))}
                          /* tracking-[0.15em] (was 0.3em) so the field stays
                             readable at 200% browser zoom — wider tracking
                             pushed digits past the right edge of the input. */
                          className="input text-center text-xl tracking-[0.15em] font-mono"
                          placeholder="000000"
                          required
                          autoFocus
                          autoComplete="one-time-code"
                          aria-describedby="forgot-otp-hint"
                        />
                        <p id="forgot-otp-hint" className="text-xs text-surface-400 mt-1">
                          Enter the 6-digit code from your email
                        </p>
                      </div>

                      {/* New Password */}
                      <div>
                        <label htmlFor="forgot-password" className="label">New Password</label>
                        <div className="relative">
                          <input
                            id="forgot-password"
                            type={showForgotPassword ? 'text' : 'password'}
                            value={forgotPassword}
                            onChange={(e) => setForgotPassword(e.target.value)}
                            className="input pr-10"
                            placeholder="At least 8 characters"
                            required
                            minLength={8}
                            autoComplete="new-password"
                            aria-describedby="forgot-pw-requirements forgot-pw-strength"
                          />
                          <button
                            type="button"
                            onClick={() => setShowForgotPassword(!showForgotPassword)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-surface-400 hover:text-surface-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                            aria-label={showForgotPassword ? 'Hide password' : 'Show password'}
                          >
                            {showForgotPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                          </button>
                        </div>
                        <p id="forgot-pw-requirements" className="text-xs text-surface-400 mt-1">
                          Must be at least 8 characters.
                        </p>
                        <div id="forgot-pw-strength">
                          <PasswordStrengthBar password={forgotPassword} />
                        </div>
                      </div>

                      {/* Confirm Password */}
                      <div>
                        <label htmlFor="forgot-confirm" className="label">Confirm New Password</label>
                        <input
                          id="forgot-confirm"
                          type="password"
                          value={forgotPasswordConfirm}
                          onChange={(e) => setForgotPasswordConfirm(e.target.value)}
                          className={`input ${forgotPasswordConfirm && forgotPassword !== forgotPasswordConfirm ? 'border-red-300 focus:ring-red-400' : ''}`}
                          placeholder="Confirm new password"
                          required
                          autoComplete="new-password"
                          aria-describedby="forgot-confirm-hint"
                        />
                        {forgotPasswordConfirm && forgotPassword !== forgotPasswordConfirm && (
                          <p id="forgot-confirm-hint" className="text-xs text-red-500 mt-1" role="alert">
                            Passwords do not match
                          </p>
                        )}
                      </div>

                      <ErrorAlert message={error} />

                      <button type="submit" disabled={loading} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Resetting password...</>
                        ) : 'Reset Password'}
                      </button>
                    </form>

                    {/* Resend Code */}
                    <div className="mt-4 text-center">
                      {resendCooldown > 0 ? (
                        <p className="text-xs text-surface-400" aria-live="polite">
                          Resend code in {resendCooldown}s
                        </p>
                      ) : (
                        <button
                          onClick={handleResendOtp}
                          disabled={loading}
                          className="text-xs text-brand-600 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded inline-flex items-center gap-1"
                        >
                          <RefreshCw size={12} /> Resend code
                        </button>
                      )}
                    </div>

                    <p className="text-[10px] text-surface-400 text-center mt-3">
                      Don't see it? Check your spam or junk folder.
                    </p>
                  </>
                )}

                {/* ── Step 3: Success ────────────────────────────────────── */}
                {forgotStep === 3 && (
                  <div className="text-center py-6" role="status" aria-live="polite">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-4">
                      <CheckCircle size={32} className="text-emerald-600" />
                    </div>
                    <h3 className="text-lg font-semibold text-surface-900 mb-2">Password Updated!</h3>
                    <p className="text-sm text-surface-500 mb-6">
                      Your password has been reset successfully. You can now sign in with your new password.
                    </p>
                    <button
                      onClick={() => switchToMode('login')}
                      className="btn-primary"
                      autoFocus
                    >
                      Back to Login
                    </button>
                  </div>
                )}
              </div>
            )}

          </div>

          </>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-surface-500 mt-6">
          SCTCC Robotics &amp; Industrial Controls Technician Program
        </p>
      </div>
    </div>
  )
}
