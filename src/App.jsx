import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState, lazy, Suspense } from 'react'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import AppLayout from '@/components/layout/AppLayout'
import EmulationBar from '@/components/EmulationBar'
import PageErrorBoundary from '@/components/PageErrorBoundary'
import { PageLoading } from '@/components/ui'

// ── Eager pages ─────────────────────────────────────────────────────────────
// These are bundled into the main chunk on purpose:
//   • Login + Dashboard are the first thing every user sees.
//   • TV display, Time Clock and Lab Status run unattended on Raspberry Pi
//     kiosks and must never show a "loading" spinner mid-shift after a deploy.
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import TVDisplayPage from '@/pages/TVDisplayPage'
import TimeClockPage from '@/pages/TimeClockPage'
import LabStatusPage from '@/pages/LabStatusPage'

// ── Lazy pages (route-level code splitting) ─────────────────────────────────
// Each page below is downloaded the first time a user visits it, instead of
// every page being downloaded on first load. Cuts the initial bundle from
// ~3.8 MB to a fraction of that.
//
// lazyPage() adds one safety net: after a Vercel deploy, chunk filenames
// change. A user who already had the app open and then visits a page for
// the first time would request a chunk that no longer exists. When that
// happens we reload the page once (guarded so it can't loop) so they pick
// up the new build. useVersionCheck still handles the normal "new version
// available" prompt; this only covers the gap between deploy and refresh.
const CHUNK_RELOAD_KEY = 'rict-chunk-reload-at'
const CHUNK_RELOAD_WINDOW_MS = 60_000

function isChunkLoadError(err) {
  const msg = String(err?.message || err || '')
  return (
    err?.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  )
}

function lazyPage(importer) {
  return lazy(() =>
    importer()
      .then(mod => {
        // Successful load — clear the guard so a *future* deploy can reload again.
        try { sessionStorage.removeItem(CHUNK_RELOAD_KEY) } catch { /* ignore */ }
        return mod
      })
      .catch(err => {
        if (isChunkLoadError(err)) {
          let last = 0
          try { last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0) } catch { /* ignore */ }
          if (Date.now() - last > CHUNK_RELOAD_WINDOW_MS) {
            try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())) } catch { /* ignore */ }
            window.location.reload()
            // Never resolves — the page is reloading. Keeps Suspense showing the spinner.
            return new Promise(() => {})
          }
        }
        // Not a stale-chunk problem (or we already tried once) → let the
        // PageErrorBoundary show it.
        throw err
      })
  )
}

const WorkOrdersPage = lazyPage(() => import('@/pages/WorkOrdersPage'))
const AssetsPage = lazyPage(() => import('@/pages/AssetsPage'))
const AssetCheckoutsPage = lazyPage(() => import('@/pages/AssetCheckoutsPage'))
const InventoryPage = lazyPage(() => import('@/pages/InventoryPage'))
const LabSignupPage = lazyPage(() => import('@/pages/LabSignupPage'))
const EquipmentSchedulingPage = lazyPage(() => import('@/pages/EquipmentSchedulingPage'))
const AbsenceRequestPage = lazyPage(() => import('@/pages/AbsenceRequestPage'))
const WeeklyLabsTrackerPage = lazyPage(() => import('@/pages/WeeklyLabsTrackerPage'))
const PurchaseOrdersPage = lazyPage(() => import('@/pages/PurchaseOrdersPage'))
const PMPage = lazyPage(() => import('@/pages/PMPage'))
const UsersPage = lazyPage(() => import('@/pages/UsersPage'))
const SettingsPage = lazyPage(() => import('@/pages/SettingsPage'))
const AnnouncementsPage = lazyPage(() => import('@/pages/AnnouncementsPage'))
const ProgramBudgetPage = lazyPage(() => import('@/pages/ProgramBudgetPage'))
const BugTrackerPage = lazyPage(() => import('@/pages/BugTrackerPage'))
const TimeCardsPage = lazyPage(() => import('@/pages/TimeCardsPage'))
const AccessPage = lazyPage(() => import('@/pages/AccessPage'))
const AuditLogPage = lazyPage(() => import('@/pages/AuditLogPage'))
const WOCRatioPage = lazyPage(() => import('@/pages/WOCRatioPage'))
const VolunteerHoursPage = lazyPage(() => import('@/pages/VolunteerHoursPage'))
const SOPsPage = lazyPage(() => import('@/pages/SOPsPage'))
const InstructorToolsPage = lazyPage(() => import('@/pages/InstructorToolsPage'))
const ProgramPlannerPage = lazyPage(() => import('@/pages/ProgramPlannerPage'))
const ProgramCostPage = lazyPage(() => import('@/pages/ProgramCostPage'))
const CourseOutlineExportPage = lazyPage(() => import('@/pages/CourseOutlineExportPage'))
const AttendanceReportsPage = lazyPage(() => import('@/pages/AttendanceReportsPage'))
const RequestHistoryPage = lazyPage(() => import('@/pages/RequestHistoryPage'))
const NetworkMapPage = lazyPage(() => import('@/pages/NetworkMapPage'))
const NetworkPrintPage = lazyPage(() => import('@/pages/NetworkPrintPage'))

// Protected standalone pages (auth required, no sidebar — fullscreen experiences)
const InventoryScanPage = lazyPage(() => import('@/pages/InventoryScanPage'))
const AssetScanPage = lazyPage(() => import('@/pages/AssetScanPage'))

// Public pages (no auth required — QR / password flows)
const OrderReceivePage = lazyPage(() => import('@/pages/OrderReceivePage'))
const PublicWORequestPage = lazyPage(() => import('@/pages/PublicWORequestPage'))
const ResetPasswordPage = lazyPage(() => import('@/pages/ResetPasswordPage'))
const ChangePasswordPage = lazyPage(() => import('@/pages/ChangePasswordPage'))

/**
 * Lazy — per-route Suspense wrapper. Placing Suspense on each route element
 * (instead of around <Routes>) keeps the sidebar/header in place while a
 * page chunk downloads; only the content area shows the spinner.
 */
function Lazy({ children }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>
}

// ── Kiosk token constant ────────────────────────────────────────────────────
// Set VITE_KIOSK_TOKEN in .env.local AND in Vercel environment variables.
// Example:  VITE_KIOSK_TOKEN=RICT-KIOSK-2025
export const KIOSK_TOKEN = import.meta.env.VITE_KIOSK_TOKEN || ''
const KIOSK_STORAGE_KEY = 'kiosk_token'

/**
 * KioskSetup — silently handles the one-time Pi setup URL.
 *
 * On the Pi, navigate to:
 *   https://rict-cmms.vercel.app/?setup_kiosk=<your token>
 *
 * This component detects that param, writes the token to localStorage,
 * then strips the param from the URL so it doesn't linger.
 * After that, the Pi (and any other authorised device) will always
 * pass the kiosk check on the Login page.
 */
function KioskSetup() {
  const location = useLocation()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const incoming = params.get('setup_kiosk')

    if (incoming) {
      if (KIOSK_TOKEN && incoming === KIOSK_TOKEN) {
        localStorage.setItem(KIOSK_STORAGE_KEY, incoming)
        // Redirect straight to /time-clock so Pi kiosks land on the right page
        // automatically on every boot when startup URL includes ?setup_kiosk=TOKEN
        window.location.replace('/time-clock')
      } else {
        console.warn('[KioskSetup] setup_kiosk param did not match VITE_KIOSK_TOKEN.')
        // Clean the bad param from the URL so it does not linger
        params.delete('setup_kiosk')
        const newSearch = params.toString()
        const cleanUrl = location.pathname + (newSearch ? `?${newSearch}` : '')
        window.history.replaceState({}, '', cleanUrl)
      }
    }
  }, []) // intentionally run once on mount

  return null
}

/**
 * KioskWall — shown to any non-kiosk browser that tries to reach a kiosk-only
 * route (e.g. /time-clock). Rendered directly by KioskRoute so it appears
 * regardless of whether the user is authenticated. Includes the same
 * 5-click instructor escape hatch to enter the kiosk token manually.
 */
function KioskWall() {
  const [showCodeEntry, setShowCodeEntry] = useState(false)
  const [codeInput, setCodeInput] = useState('')
  const [codeError, setCodeError] = useState('')
  const [logoClickCount, setLogoClickCount] = useState(0)

  // ── Keyboard escape hatch (WCAG 2.1.1, Phase 2 a11y) ──────────────────────
  // The 5-click logo gesture is mouse/touch only — the logo button has
  // tabIndex={-1} so it's intentionally hidden from tab order. That meant
  // keyboard-only users had no way to reach the instructor access form,
  // failing WCAG 2.1.1 Keyboard. Ctrl+Alt+K (and Cmd+Alt+K on Mac, since
  // the event uses .ctrlKey, .altKey, and .metaKey) reveals the same form.
  // Intentionally undocumented in the visible UI so it functions like the
  // 5-click pattern: present, but not advertised to students.
  useEffect(() => {
    const handler = (e) => {
      const key = e.key?.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && e.altKey && key === 'k') {
        e.preventDefault()
        setShowCodeEntry(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  function handleLogoClick() {
    const next = logoClickCount + 1
    setLogoClickCount(next)
    if (next >= 5) {
      setShowCodeEntry(true)
      setLogoClickCount(0)
    }
  }

  function handleCodeSubmit(e) {
    e.preventDefault()
    if (codeInput.trim() === KIOSK_TOKEN) {
      localStorage.setItem(KIOSK_STORAGE_KEY, codeInput.trim())
      window.location.reload()
    } else {
      setCodeError('Incorrect access code.')
      setCodeInput('')
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)',
      padding: '1rem',
    }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <button
            onClick={handleLogoClick}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 56, height: 56, borderRadius: 14,
              background: '#2563eb', border: 'none', cursor: 'pointer',
              marginBottom: '1rem', boxShadow: '0 4px 20px rgba(37,99,235,0.4)',
            }}
            tabIndex={-1}
            aria-hidden="true"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
          </button>
          <h1 style={{ color: 'white', fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>RICT CMMS</h1>
          <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: '4px 0 0' }}>Computerized Maintenance Management System</p>
        </div>

        {/* Wall card */}
        <div style={{ background: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 64, height: 64, borderRadius: '50%',
              background: '#f1f5f9', marginBottom: '1.25rem',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
              Classroom Access Only
            </h2>
            <p style={{ fontSize: '0.875rem', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
              The Time Clock is only accessible from the classroom kiosk. Please use the kiosk in the RICT lab to clock in and out.
            </p>

            {showCodeEntry && (
              <form onSubmit={handleCodeSubmit} style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="3"/><path d="M22 22L16 16M16 16V8a6 6 0 0 0-12 0v8"/>
                  </svg>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Instructor Access
                  </span>
                </div>
                <input
                  type="password"
                  value={codeInput}
                  onChange={(e) => { setCodeInput(e.target.value); setCodeError('') }}
                  style={{
                    width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0',
                    borderRadius: 8, fontSize: '0.875rem', boxSizing: 'border-box',
                    outline: 'none',
                  }}
                  placeholder="Enter access code"
                  autoFocus
                />
                {codeError && (
                  <p style={{ fontSize: '0.75rem', color: '#dc2626', margin: '4px 0 0' }}>{codeError}</p>
                )}
                <button
                  type="submit"
                  style={{
                    marginTop: 10, width: '100%', padding: '9px 0',
                    background: '#2563eb', color: 'white', border: 'none',
                    borderRadius: 8, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Unlock
                </button>
              </form>
            )}
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: '0.75rem', color: '#475569', marginTop: '1.5rem' }}>
          SCTCC Robotics &amp; Industrial Controls Technician Program
        </p>
      </div>
    </div>
  )
}

/**
 * KioskRoute — wraps routes that should only be accessible from an authorised
 * kiosk device (set up via ?setup_kiosk=TOKEN).
 * Any other device sees the KioskWall directly — authenticated or not.
 * This means students/work study on personal devices can never reach /time-clock,
 * while /login remains open so they can log in and access all other pages normally.
 */
function KioskRoute({ children }) {
  if (KIOSK_TOKEN && localStorage.getItem(KIOSK_STORAGE_KEY) !== KIOSK_TOKEN) {
    return <KioskWall />
  }
  return children
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading, mustChangePassword } = useAuth()
  const location = useLocation()

  if (loading) return <PageLoading />
  if (!isAuthenticated) return <Navigate to="/login" replace />

  // If instructor reset this user's password, intercept ALL routes (except
  // /change-password itself) and redirect until they set a new one.
  if (mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  return children
}

function PublicRoute({ children }) {
  const { isAuthenticated, loading } = useAuth()

  if (loading) return <PageLoading />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return children
}

/**
 * Wrapper that adds top padding when emulation banner is active,
 * so page content doesn't get hidden behind the fixed banner.
 */
function EmulationAwareLayout({ children }) {
  const { isEmulating } = useAuth()
  return (
    <div style={isEmulating ? { paddingTop: '44px' } : undefined}>
      {children}
    </div>
  )
}

/**
 * StandaloneBoundary — error boundary for routes rendered OUTSIDE AppLayout
 * (login, kiosks, QR/password pages, fullscreen scan pages). AppLayout already
 * wraps its <Outlet /> in PageErrorBoundary; these routes had no coverage, so
 * a render error left a blank screen. kiosk={true} trims the panel to a
 * Reload button + 30 s auto-reload for unattended displays.
 */
function StandaloneBoundary({ kiosk = false, children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { profile } = useAuth()
  return (
    <PageErrorBoundary
      resetKey={location.pathname}
      pathname={location.pathname}
      kiosk={kiosk}
      userEmail={profile?.email}
      userName={profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''}
      onGoHome={() => navigate('/dashboard')}
      onReport={(prefill) => navigate('/bug-tracker', { state: { prefill } })}
    >
      {children}
    </PageErrorBoundary>
  )
}

function AppRoutes() {
  return (
    <>
      {/* One-time kiosk setup handler — reads ?setup_kiosk=TOKEN from URL */}
      <KioskSetup />

      {/* Emulation UI — renders the banner + floating button for super admin */}
      <EmulationBar />

      <EmulationAwareLayout>
        <Routes>
          {/* Public routes */}
          <Route
            path="/login"
            element={
              <StandaloneBoundary>
                <PublicRoute>
                  <LoginPage />
                </PublicRoute>
              </StandaloneBoundary>
            }
          />

          {/* Public kiosk pages (no auth required — work even when logged in) */}
          <Route path="/tv-display" element={<StandaloneBoundary kiosk><TVDisplayPage /></StandaloneBoundary>} />
          <Route
            path="/time-clock"
            element={
              <StandaloneBoundary kiosk>
                <KioskRoute>
                  <TimeClockPage />
                </KioskRoute>
              </StandaloneBoundary>
            }
          />
          <Route path="/orders/receive" element={<StandaloneBoundary><Lazy><OrderReceivePage /></Lazy></StandaloneBoundary>} />
          <Route path="/reset-password" element={<StandaloneBoundary><Lazy><ResetPasswordPage /></Lazy></StandaloneBoundary>} />
          <Route path="/change-password" element={<StandaloneBoundary><Lazy><ChangePasswordPage /></Lazy></StandaloneBoundary>} />
          <Route path="/lab-status" element={<StandaloneBoundary kiosk><LabStatusPage /></StandaloneBoundary>} />
          {/* Public intake form for other departments — no auth; all validation lives in the submit_public_wo_request RPC */}
          <Route path="/request-work-order" element={<StandaloneBoundary><Lazy><PublicWORequestPage /></Lazy></StandaloneBoundary>} />

          {/* Protected standalone pages (auth required, no sidebar) */}
          <Route
            path="/inventory/scan"
            element={
              <StandaloneBoundary>
                <ProtectedRoute>
                  <Lazy><InventoryScanPage /></Lazy>
                </ProtectedRoute>
              </StandaloneBoundary>
            }
          />
          <Route
            path="/assets/scan"
            element={
              <StandaloneBoundary>
                <ProtectedRoute>
                  <Lazy><AssetScanPage /></Lazy>
                </ProtectedRoute>
              </StandaloneBoundary>
            }
          />
          {/* Print view lives OUTSIDE AppLayout: the layout's h-screen +
              overflow-y-auto scroll container clips printed output to a
              single page. Standalone = full document flow, all pages print. */}
          <Route
            path="/network-map/print"
            element={
              <StandaloneBoundary>
                <ProtectedRoute>
                  <Lazy><NetworkPrintPage /></Lazy>
                </ProtectedRoute>
              </StandaloneBoundary>
            }
          />

          {/* Protected routes */}
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            {/* Main */}
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/work-orders" element={<Lazy><WorkOrdersPage /></Lazy>} />
            <Route path="/inventory" element={<Lazy><InventoryPage /></Lazy>} />
            <Route path="/assets" element={<Lazy><AssetsPage /></Lazy>} />
            <Route path="/asset-checkouts" element={<Lazy><AssetCheckoutsPage /></Lazy>} />
            <Route path="/sops" element={<Lazy><SOPsPage /></Lazy>} />
            <Route path="/purchase-orders" element={<Lazy><PurchaseOrdersPage /></Lazy>} />
            <Route path="/network-map" element={<Lazy><NetworkMapPage /></Lazy>} />

            {/* Scheduling */}
            <Route path="/pm-schedules" element={<Lazy><PMPage /></Lazy>} />
            <Route path="/lab-signup" element={<Lazy><LabSignupPage /></Lazy>} />
            <Route path="/equipment-scheduling" element={<Lazy><EquipmentSchedulingPage /></Lazy>} />
            <Route path="/absence-requests" element={<Lazy><AbsenceRequestPage /></Lazy>} />

            {/* Reports */}
            <Route path="/time-cards" element={<Lazy><TimeCardsPage /></Lazy>} />
            <Route path="/woc-ratio" element={<Lazy><WOCRatioPage /></Lazy>} />
            <Route path="/program-budget" element={<Lazy><ProgramBudgetPage /></Lazy>} />
            <Route path="/bug-tracker" element={<Lazy><BugTrackerPage /></Lazy>} />
            <Route path="/weekly-labs" element={<Lazy><WeeklyLabsTrackerPage /></Lazy>} />
            <Route path="/volunteer-hours" element={<Lazy><VolunteerHoursPage /></Lazy>} />
            <Route path="/attendance-reports" element={<Lazy><AttendanceReportsPage /></Lazy>} />
            <Route path="/request-history" element={<Lazy><RequestHistoryPage /></Lazy>} />

            {/* Administration */}
            <Route path="/users" element={<Lazy><UsersPage /></Lazy>} />
            <Route path="/announcements" element={<Lazy><AnnouncementsPage /></Lazy>} />
            <Route path="/settings" element={<Lazy><SettingsPage /></Lazy>} />
            <Route path="/access" element={<Lazy><AccessPage /></Lazy>} />
            <Route path="/audit-log" element={<Lazy><AuditLogPage /></Lazy>} />
            <Route path="/instructor-tools" element={<Lazy><InstructorToolsPage /></Lazy>} />
            <Route path="/program-planner" element={<Lazy><ProgramPlannerPage /></Lazy>} />
            <Route path="/program-cost" element={<Lazy><ProgramCostPage /></Lazy>} />
            <Route path="/course-outline-export" element={<Lazy><CourseOutlineExportPage /></Lazy>} />
          </Route>

          {/* Catch-all redirect */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </EmulationAwareLayout>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              background: '#1e293b',
              color: '#f8fafc',
              fontSize: '14px',
              borderRadius: '12px',
              padding: '12px 16px',
            },
            success: {
              iconTheme: { primary: '#22c55e', secondary: '#f8fafc' },
            },
            error: {
              iconTheme: { primary: '#ef4444', secondary: '#f8fafc' },
              duration: 4000,
            },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  )
}
