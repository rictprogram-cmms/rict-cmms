/**
 * RICT CMMS — Change Password Page
 *
 * Shown automatically (via ProtectedRoute redirect) when an instructor has
 * reset a student's password and user_metadata.must_reset_password === true.
 *
 * The user CANNOT navigate away — every protected route redirects here until
 * they successfully save a new password.
 *
 * On successful save:
 *   1. Calls supabase.auth.updateUser({ password }) — triggers USER_UPDATED
 *      event in AuthContext which clears mustChangePassword via the updated
 *      session's user_metadata.
 *   2. Also calls updateUser again to explicitly clear must_reset_password
 *      from user_metadata so it is definitely false in the next session too.
 *   3. Redirects to /dashboard.
 *
 * Route: /change-password  (registered in App.jsx, outside ProtectedRoute)
 * Auth:  Requires active session — redirects to /login if none.
 */

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useNavigate } from 'react-router-dom'
import { Wrench, Eye, EyeOff, Loader2, CheckCircle, Lock, AlertTriangle, LogOut } from 'lucide-react'

export default function ChangePasswordPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [userName, setUserName] = useState('')

  // ── Verify there is an active session on mount ─────────────────────────────
  // If no session (e.g. user lands here directly via URL), redirect to login.
  useEffect(() => {
    async function check() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user) {
          navigate('/login', { replace: true })
          return
        }
        // Pull their name for the greeting
        const { data: profile } = await supabase
          .from('profiles')
          .select('first_name')
          .eq('email', session.user.email)
          .maybeSingle()
        if (profile?.first_name) setUserName(profile.first_name)
      } catch {
        // On any error just let them proceed — updateUser will fail naturally
      } finally {
        setVerifying(false)
      }
    }
    check()
  }, [navigate])

  // ── Password requirements ──────────────────────────────────────────────────
  const tooShort    = password.length > 0 && password.length < 8
  const mismatch    = confirmPassword.length > 0 && password !== confirmPassword
  const canSubmit   = password.length >= 8 && password === confirmPassword

  // Strength indicator
  const strength = (() => {
    if (password.length === 0) return null
    let score = 0
    if (password.length >= 8)  score++
    if (password.length >= 12) score++
    if (/[A-Z]/.test(password)) score++
    if (/[0-9]/.test(password)) score++
    if (/[^A-Za-z0-9]/.test(password)) score++
    if (score <= 1) return { label: 'Weak',   color: 'bg-red-400',    width: 'w-1/4' }
    if (score === 2) return { label: 'Fair',   color: 'bg-amber-400',  width: 'w-2/4' }
    if (score === 3) return { label: 'Good',   color: 'bg-yellow-400', width: 'w-3/4' }
    return              { label: 'Strong', color: 'bg-emerald-500', width: 'w-full' }
  })()

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setLoading(true)

    try {
      // 1. Update the password
      const { error: pwErr } = await supabase.auth.updateUser({ password })
      if (pwErr) throw pwErr

      // 2. Clear the must_reset_password flag from user_metadata so it does
      //    not trigger the redirect again on any future login.
      //    This is a best-effort call — AuthContext also clears local state via
      //    the USER_UPDATED event so the redirect lifts immediately either way.
      await supabase.auth.updateUser({
        data: { must_reset_password: false }
      })

      setSuccess(true)
      setTimeout(() => navigate('/dashboard', { replace: true }), 2500)
    } catch (err) {
      setError(err.message || 'Failed to update password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Sign out escape hatch ──────────────────────────────────────────────────
  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-surface-900 via-brand-950 to-surface-900 px-4">
      {/* Subtle pattern overlay — matches LoginPage / ResetPasswordPage */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C%2Fg%3E%3C%2Fsvg%3E")`,
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
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="p-6">
            {verifying ? (
              /* Verifying session */
              <div className="text-center py-6">
                <Loader2 size={32} className="animate-spin text-brand-600 mx-auto mb-4" />
                <p className="text-sm text-surface-500">Verifying your session…</p>
              </div>

            ) : success ? (
              /* Success state */
              <div className="text-center py-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-4">
                  <CheckCircle size={32} className="text-emerald-600" />
                </div>
                <h3 className="text-lg font-semibold text-surface-900 mb-2">Password Updated!</h3>
                <p className="text-sm text-surface-500">
                  Your new password has been saved. Taking you to the dashboard…
                </p>
              </div>

            ) : (
              /* Password form */
              <>
                <div className="text-center mb-5">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-100 mb-3">
                    <Lock size={22} className="text-amber-600" />
                  </div>
                  <h2 className="text-lg font-semibold text-surface-900">
                    {userName ? `Hi ${userName} — ` : ''}Set a New Password
                  </h2>
                  <p className="text-sm text-surface-500 mt-1 leading-snug">
                    Your instructor reset your password. Please choose a new one before continuing.
                  </p>
                </div>

                {/* Notice banner */}
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 mb-4">
                  <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 leading-snug">
                    You cannot access the app until you set a new password. Do not reuse the temporary password given to you.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* New password */}
                  <div>
                    <label className="label">New Password</label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        className={`input pr-10 ${tooShort ? 'border-red-300 focus:ring-red-400' : ''}`}
                        placeholder="At least 8 characters"
                        autoFocus
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(v => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-surface-400 hover:text-surface-600"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>

                    {/* Strength bar */}
                    {strength && (
                      <div className="mt-1.5">
                        <div className="h-1 w-full bg-surface-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${strength.color} ${strength.width}`} />
                        </div>
                        <p className={`text-[10px] mt-0.5 font-medium ${
                          strength.label === 'Strong' ? 'text-emerald-600' :
                          strength.label === 'Good'   ? 'text-yellow-600' :
                          strength.label === 'Fair'   ? 'text-amber-600'  : 'text-red-500'
                        }`}>{strength.label}</p>
                      </div>
                    )}

                    {tooShort && (
                      <p className="text-xs text-red-500 mt-1">Must be at least 8 characters</p>
                    )}
                  </div>

                  {/* Confirm password */}
                  <div>
                    <label className="label">Confirm Password</label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      className={`input ${mismatch ? 'border-red-300 focus:ring-red-400' : ''}`}
                      placeholder="Repeat your new password"
                      required
                    />
                    {mismatch && (
                      <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
                    )}
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading || !canSubmit}
                    className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {loading
                      ? <><Loader2 size={16} className="animate-spin" /> Saving…</>
                      : 'Save New Password'}
                  </button>
                </form>

                {/* Sign out escape hatch */}
                <div className="mt-4 pt-4 border-t border-surface-100 text-center">
                  <button
                    onClick={handleSignOut}
                    className="inline-flex items-center gap-1.5 text-xs text-surface-400 hover:text-surface-600 transition-colors"
                  >
                    <LogOut size={12} /> Sign out instead
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-surface-500 mt-6">
          SCTCC Robotics &amp; Industrial Controls Technician Program
        </p>
      </div>
    </div>
  )
}
