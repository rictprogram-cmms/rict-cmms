/**
 * RICT CMMS — PageErrorBoundary
 *
 * Catches render/runtime errors thrown by the current page so the app shows
 * a readable, accessible "Something went wrong" panel instead of a blank
 * white screen. The sidebar and header stay usable because the boundary
 * wraps only the routed page (<Outlet />) in AppLayout.
 *
 * What it does
 *   - Shows the error message + a collapsible stack (for screenshots)
 *   - Reload page / Go to Dashboard / Copy details / Report this bug
 *   - "Report this bug" copies the details AND navigates to /bug-tracker
 *     with router state { prefill: { type, title, description } } — the
 *     Bug Tracker page opens its New Request modal pre-filled when it
 *     supports that state (4.3.0); older builds just land on the page with
 *     the details on the clipboard.
 *   - Best-effort audit_log row (action 'Client Error') so instructors can
 *     see crashes students never report
 *   - Resets automatically when the route changes (resetKey)
 *   - kiosk mode (kiosk prop): used on unattended screens (/tv-display,
 *     /time-clock, /lab-status). Hides "Go to Dashboard", "Copy details" and
 *     "Report this bug" (nobody is logged in, and a Pi in the lab shouldn't
 *     offer them), keeps "Reload", and auto-reloads after 30 s so a display
 *     recovers on its own overnight.
 *
 * Accessibility (WCAG 2.1 AA)
 *   - Panel is role="alert" so it's announced immediately
 *   - Heading + focus moved to the panel on mount
 *   - All actions are real <button>s with visible focus rings
 *   - Stack trace is behind a native <details> so it's keyboard-operable
 *
 * Error boundaries must be class components (React has no hook equivalent).
 *
 * File: src/components/PageErrorBoundary.jsx
 */

import React from 'react'
import { AlertTriangle, RefreshCw, Home, Copy, Bug, CheckCircle2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'

function buildDetails({ error, info, pathname, appVersion, userEmail }) {
  const lines = [
    `RICT CMMS client error`,
    `Version: ${appVersion || 'unknown'}`,
    `Page: ${pathname || window.location.pathname}`,
    `User: ${userEmail || 'unknown'}`,
    `Time: ${new Date().toLocaleString()}`,
    `Browser: ${navigator.userAgent}`,
    ``,
    `Error: ${error?.message || String(error)}`,
    ``,
    `Stack:`,
    error?.stack || '(none)',
  ]
  if (info?.componentStack) {
    lines.push(``, `Component stack:`, info.componentStack.trim())
  }
  return lines.join('\n')
}

// Unattended kiosk screens reload themselves after this many seconds.
const KIOSK_AUTO_RELOAD_SECONDS = 30

export default class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null, copied: false, secondsLeft: KIOSK_AUTO_RELOAD_SECONDS }
    this.panelRef = React.createRef()
    this.kioskTimer = null
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    console.error('[PageErrorBoundary]', error, info?.componentStack)

    if (this.props.kiosk) this.startKioskCountdown()

    // Best-effort audit row — never let logging throw inside the boundary
    try {
      const { pathname, appVersion, userEmail, userName } = this.props
      supabase.from('audit_log').insert({
        log_id: `AUD${Date.now()}`,
        timestamp: new Date().toISOString(),
        user_email: userEmail || '',
        user_name: userName || '',
        action: 'Client Error',
        entity_type: 'Page',
        entity_id: pathname || window.location.pathname,
        field_changed: null,
        old_value: null,
        new_value: null,
        details: `${appVersion ? `v${appVersion} — ` : ''}${(error?.message || String(error)).slice(0, 500)}`,
      }).then(({ error: e }) => { if (e) console.warn('audit_log client error insert failed:', e.message) })
    } catch { /* ignore */ }
  }

  componentDidUpdate(prevProps) {
    // Route changed → clear the error so the next page renders normally
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.stopKioskCountdown()
      this.setState({ error: null, info: null, copied: false, secondsLeft: KIOSK_AUTO_RELOAD_SECONDS })
    }
    if (this.state.error && !prevProps.error && this.panelRef.current) {
      this.panelRef.current.focus()
    }
  }

  componentWillUnmount() {
    this.stopKioskCountdown()
  }

  startKioskCountdown() {
    this.stopKioskCountdown()
    this.setState({ secondsLeft: KIOSK_AUTO_RELOAD_SECONDS })
    this.kioskTimer = setInterval(() => {
      this.setState(prev => {
        const next = prev.secondsLeft - 1
        if (next <= 0) {
          this.stopKioskCountdown()
          window.location.reload()
          return { secondsLeft: 0 }
        }
        return { secondsLeft: next }
      })
    }, 1000)
  }

  stopKioskCountdown() {
    if (this.kioskTimer) {
      clearInterval(this.kioskTimer)
      this.kioskTimer = null
    }
  }

  details() {
    const { pathname, appVersion, userEmail } = this.props
    return buildDetails({ error: this.state.error, info: this.state.info, pathname, appVersion, userEmail })
  }

  copy = async () => {
    try {
      await navigator.clipboard.writeText(this.details())
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2500)
    } catch {
      // Clipboard blocked — the <details> block below is selectable as a fallback
    }
  }

  report = async () => {
    await this.copy()
    const { onReport, pathname } = this.props
    const title = `Page error on ${pathname || window.location.pathname}: ${(this.state.error?.message || 'Unknown error').slice(0, 80)}`
    if (typeof onReport === 'function') {
      onReport({ type: 'Bug', title, description: this.details() })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const { error, copied, secondsLeft } = this.state
    const { onGoHome, kiosk } = this.props

    return (
      <div
        ref={this.panelRef}
        role="alert"
        tabIndex={-1}
        aria-labelledby="page-error-title"
        aria-describedby="page-error-desc"
        className="max-w-2xl mx-auto mt-10 bg-white border border-red-200 rounded-2xl shadow-sm overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
      >
        <div className="flex items-start gap-3 px-6 py-5 bg-red-50 border-b border-red-100">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} className="text-red-600" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="page-error-title" className="text-lg font-bold text-red-800">Something went wrong on this page</h2>
            <p id="page-error-desc" className="text-sm text-red-700 mt-0.5">
              {kiosk
                ? 'This screen will reload itself shortly. If it keeps happening, let an instructor know.'
                : 'The rest of the app still works. Reloading usually fixes it — if it keeps happening, send us the details below.'}
            </p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="bg-surface-50 border border-surface-200 rounded-lg px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-surface-500 mb-1">Error</div>
            <div className="text-sm font-mono text-surface-900 break-words">{error?.message || String(error)}</div>
          </div>

          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-surface-600 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded px-1">
              Technical details (for the bug report)
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto text-[11px] leading-relaxed bg-surface-900 text-surface-100 rounded-lg p-3 whitespace-pre-wrap break-words select-all">
              {this.details()}
            </pre>
          </details>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              <RefreshCw size={16} aria-hidden="true" /> Reload page
            </button>
            {!kiosk && (
            <button
              type="button"
              onClick={() => (typeof onGoHome === 'function' ? onGoHome() : (window.location.href = '/dashboard'))}
              className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] bg-white border border-surface-200 text-surface-700 text-sm font-medium rounded-lg hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Home size={16} aria-hidden="true" /> Go to Dashboard
            </button>
            )}
            {!kiosk && (
            <button
              type="button"
              onClick={this.copy}
              className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] bg-white border border-surface-200 text-surface-700 text-sm font-medium rounded-lg hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {copied ? <CheckCircle2 size={16} className="text-emerald-600" aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy details'}
            </button>
            )}
            {!kiosk && (
            <button
              type="button"
              onClick={this.report}
              className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              <Bug size={16} aria-hidden="true" /> Report this bug
            </button>
            )}
          </div>
          {/* Kiosk countdown changes every second — keep it out of the live
              region so screen readers aren't re-announced 30 times. The
              role="alert" panel already announced the error on mount. */}
          <p className="text-xs text-surface-400" role={kiosk ? undefined : 'status'} aria-live={kiosk ? 'off' : 'polite'}>
            {kiosk
              ? `Reloading automatically in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}.`
              : copied ? 'Error details copied to your clipboard.' : 'Report this bug copies the details and opens the Bug Tracker.'}
          </p>
        </div>
      </div>
    )
  }
}
