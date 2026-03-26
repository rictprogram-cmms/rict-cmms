import { useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { Wrench, Eye, EyeOff, Loader2, CheckCircle, ArrowLeft, Clock, Mail, Lock } from 'lucide-react'

// ── LoginPage ───────────────────────────────────────────────────────────────
//
// NOTE: The kiosk gate (KioskWall / isKioskAuthorised) has been intentionally
// removed from this file. The /time-clock route is already protected by
// <KioskRoute> in App.jsx, which redirects non-kiosk browsers away from that
// page. Blocking the login page itself prevented students on personal devices
// from ever logging in to access Lab Signup and other features.

export default function LoginPage() {
  const { signIn, resetPassword, isPendingApproval, signOut, setIsRegistering } = useAuth()
  const [mode, setMode] = useState('login') // login | register | forgot
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Registration fields
  const [regStep, setRegStep] = useState(1) // 1=email, 2=profile, 3=complete
  const [regEmail, setRegEmail] = useState('')
  const [regFirstName, setRegFirstName] = useState('')
  const [regLastName, setRegLastName] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regPasswordConfirm, setRegPasswordConfirm] = useState('')
  const [showRegPassword, setShowRegPassword] = useState(false)

  // Forgot password
  const [resetSent, setResetSent] = useState(false)

  // If user has auth session but no profile, show pending approval screen
  const showPendingScreen = isPendingApproval && mode !== 'register'

  // ── Login ──────────────────────────────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(email, password)
      // If signIn succeeds but user has no profile, AuthContext sets
      // isPendingApproval=true → this component re-renders to show
      // the "Awaiting Approval" screen automatically.
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

  // ── Register Step 1: Check email ───────────────────────────────────
  async function handleRegStep1(e) {
    e.preventDefault()
    setError('')
    if (!regEmail.trim()) return

    setLoading(true)
    try {
      // Check if the email already has an approved profile
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('email')
        .eq('email', regEmail.toLowerCase().trim())
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
        .eq('email', regEmail.toLowerCase().trim())
        .eq('status', 'Pending')
        .maybeSingle()

      if (existingRequest) {
        setError('An access request for this email is already pending. Please wait for instructor approval.')
        setLoading(false)
        return
      }

      // Proceed to profile step
      setRegStep(2)
    } catch (err) {
      setError('Error checking email: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Register Step 2: Create auth user + submit access request immediately ──
  //
  // Flow (email verification DISABLED):
  //   1. signUp() → creates Supabase Auth user (no confirmation email)
  //   2. Immediately submit access request for instructor approval
  //   3. Sign out — user cannot log in until instructor approves
  //   4. Show "Awaiting Approval" screen
  //
  async function handleRegStep2(e) {
    e.preventDefault()
    setError('')

    if (!regFirstName.trim() || !regLastName.trim()) {
      setError('First and last name are required.')
      return
    }
    if (regPassword.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (regPassword !== regPasswordConfirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      // Tell AuthContext not to auto-submit access request during this flow
      setIsRegistering(true)

      const cleanEmail = regEmail.toLowerCase().trim()
      const cleanFirst = regFirstName.trim()
      const cleanLast = regLastName.trim()

      // Create Supabase Auth user (email verification is disabled)
      const { data: signUpData, error: authError } = await supabase.auth.signUp({
        email: cleanEmail,
        password: regPassword,
        options: {
          data: {
            first_name: cleanFirst,
            last_name: cleanLast,
          },
        }
      })

      if (authError) {
        if (authError.message?.includes('rate limit')) {
          throw new Error('Too many signup attempts. Please wait a few minutes and try again.')
        }
        const alreadyRegistered = authError.status === 422 ||
          authError.message?.toLowerCase().includes('already registered') ||
          authError.message?.toLowerCase().includes('already been registered')

        if (!alreadyRegistered) throw authError
      }

      // Immediately submit the access request (no email verification needed)
      try {
        const { error: rpcError } = await supabase.rpc('submit_access_request', {
          p_email: cleanEmail,
          p_first_name: cleanFirst,
          p_last_name: cleanLast,
        })
        if (rpcError) {
          console.error('Access request RPC failed, trying direct insert:', rpcError)
          // Fallback: insert directly into access_requests table
          let requestId
          try {
            const { data: idData } = await supabase.rpc('get_next_id', { p_type: 'access_request' })
            requestId = idData
          } catch {}
          if (!requestId) requestId = `AR${Date.now()}`

          await supabase.from('access_requests').insert([{
            request_id: requestId,
            email: cleanEmail,
            first_name: cleanFirst,
            last_name: cleanLast,
            request_date: new Date().toISOString(),
            status: 'Pending',
            requested_role: 'Student',
          }])
        }
      } catch (accessErr) {
        console.error('Access request submission error:', accessErr)
        // Don't fail the whole registration — the user is created in auth
        // An instructor can still manually approve them
      }

      // Sign out — user must wait for instructor approval
      try { await supabase.auth.signOut() } catch {}

      // Clear registering flag
      setIsRegistering(false)

      // Show success screen (awaiting approval)
      setRegStep(3)
    } catch (err) {
      setError(err.message)
      try { await supabase.auth.signOut() } catch {}
      setIsRegistering(false)
    } finally {
      setLoading(false)
    }
  }

  // ── Forgot password ────────────────────────────────────────────────
  async function handleForgotPassword(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await resetPassword(email)
      setResetSent(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function switchToMode(newMode) {
    setMode(newMode)
    setError('')
    setRegStep(1)
    setResetSent(false)
  }

  function resetRegistration() {
    setRegStep(1)
    setRegEmail('')
    setRegFirstName('')
    setRegLastName('')
    setRegPassword('')
    setRegPasswordConfirm('')
    setError('')
  }

  // ── RENDER ─────────────────────────────────────────────────────────
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
            <div className="p-6 text-center py-10">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 mb-4">
                <Clock size={32} className="text-amber-600" />
              </div>
              <h3 className="text-lg font-semibold text-surface-900 mb-2">Awaiting Approval</h3>
              <p className="text-sm text-surface-500 mb-2">
                Your access request has been submitted and is waiting for instructor approval.
              </p>
              <p className="text-sm text-surface-500 mb-6">
                Once approved, you'll be able to log in. Please check back later.
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

          {/* Tabs (Login / Register) */}
          {mode !== 'forgot' && (
            <div className="flex border-b border-surface-200">
              <button
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
            {/* ════════ LOGIN ════════ */}
            {mode === 'login' && (
              <>
                <h2 className="text-lg font-semibold text-surface-900 mb-1">Sign in to your account</h2>
                <form onSubmit={handleLogin} className="space-y-4 mt-4">
                  <div>
                    <label className="label">Email</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="input"
                      placeholder="you@sctcc.edu"
                      required
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="label">Password</label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="input pr-10"
                        placeholder="Enter your password"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-surface-400 hover:text-surface-600"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                      {error}
                    </div>
                  )}

                  <button type="submit" disabled={loading} className="btn-primary w-full">
                    {loading ? (
                      <><Loader2 size={16} className="animate-spin" /> Signing in...</>
                    ) : 'Sign In'}
                  </button>
                </form>

                <div className="mt-4 text-center">
                  <button
                    onClick={() => switchToMode('forgot')}
                    className="text-xs text-brand-600 hover:text-brand-700"
                  >
                    Forgot your password?
                  </button>
                </div>
              </>
            )}

            {/* ════════ REGISTER ════════ */}
            {mode === 'register' && (
              <>
                {/* Step 1: Email */}
                {regStep === 1 && (
                  <>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-surface-900">Request Access</h2>
                      <p className="text-sm text-surface-500 mt-1">Enter your email to get started</p>
                    </div>
                    <form onSubmit={handleRegStep1} className="space-y-4">
                      <div>
                        <label className="label">Email</label>
                        <input
                          type="email"
                          value={regEmail}
                          onChange={(e) => setRegEmail(e.target.value)}
                          className="input"
                          placeholder="you@sctcc.edu"
                          required
                          autoFocus
                        />
                      </div>

                      {error && (
                        <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                          {error}
                        </div>
                      )}

                      <button type="submit" disabled={loading} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Checking...</>
                        ) : 'Continue'}
                      </button>
                    </form>
                  </>
                )}

                {/* Step 2: Complete profile */}
                {regStep === 2 && (
                  <>
                    <div className="mb-6">
                      <button
                        onClick={resetRegistration}
                        className="flex items-center gap-1 text-sm text-surface-400 hover:text-surface-600 mb-3"
                      >
                        <ArrowLeft size={14} /> Back
                      </button>
                      <h2 className="text-lg font-semibold text-surface-900">Complete Profile</h2>
                      <p className="text-sm text-surface-500 mt-1">Set up your account for <strong>{regEmail}</strong></p>
                    </div>
                    <form onSubmit={handleRegStep2} className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">First Name</label>
                          <input
                            type="text"
                            value={regFirstName}
                            onChange={(e) => setRegFirstName(e.target.value)}
                            className="input"
                            placeholder="First"
                            required
                            autoFocus
                          />
                        </div>
                        <div>
                          <label className="label">Last Name</label>
                          <input
                            type="text"
                            value={regLastName}
                            onChange={(e) => setRegLastName(e.target.value)}
                            className="input"
                            placeholder="Last"
                            required
                          />
                        </div>
                      </div>
                      <div>
                        <label className="label">Password</label>
                        <div className="relative">
                          <input
                            type={showRegPassword ? 'text' : 'password'}
                            value={regPassword}
                            onChange={(e) => setRegPassword(e.target.value)}
                            className="input pr-10"
                            placeholder="Min 6 characters"
                            required
                            minLength={6}
                          />
                          <button
                            type="button"
                            onClick={() => setShowRegPassword(!showRegPassword)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-surface-400 hover:text-surface-600"
                          >
                            {showRegPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="label">Confirm Password</label>
                        <input
                          type="password"
                          value={regPasswordConfirm}
                          onChange={(e) => setRegPasswordConfirm(e.target.value)}
                          className="input"
                          placeholder="Confirm password"
                          required
                        />
                      </div>

                      {error && (
                        <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                          {error}
                        </div>
                      )}

                      <button type="submit" disabled={loading} className="btn-primary w-full">
                        {loading ? (
                          <><Loader2 size={16} className="animate-spin" /> Submitting request...</>
                        ) : 'Submit Request'}
                      </button>
                    </form>
                  </>
                )}

                {/* Step 3: Success — Awaiting Approval */}
                {regStep === 3 && (
                  <div className="text-center py-6">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-4">
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
                  </div>
                )}
              </>
            )}

            {/* ════════ FORGOT PASSWORD ════════ */}
            {mode === 'forgot' && (
              <>
                <button
                  onClick={() => switchToMode('login')}
                  className="flex items-center gap-1 text-sm text-surface-400 hover:text-surface-600 mb-4"
                >
                  <ArrowLeft size={14} /> Back to Login
                </button>
                <h2 className="text-lg font-semibold text-surface-900 mb-2">Reset Password</h2>
                <p className="text-sm text-surface-500 mb-6">
                  Enter your email and we'll send you a reset link.
                </p>

                {resetSent ? (
                  <div className="text-center py-4">
                    <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3">
                      <span className="text-xl">✉️</span>
                    </div>
                    <p className="text-sm text-surface-700 mb-4">
                      Check your email for a password reset link.
                    </p>
                    <button
                      onClick={() => switchToMode('login')}
                      className="btn-secondary"
                    >
                      Back to sign in
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <div>
                      <label className="label">Email</label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="input"
                        placeholder="you@sctcc.edu"
                        required
                        autoFocus
                      />
                    </div>

                    {error && (
                      <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                        {error}
                      </div>
                    )}

                    <button type="submit" disabled={loading} className="btn-primary w-full">
                      {loading ? <Loader2 size={16} className="animate-spin" /> : 'Send reset link'}
                    </button>
                  </form>
                )}
              </>
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
