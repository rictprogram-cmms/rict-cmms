import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './styles/settings.css'

// ── Service Worker Registration ──────────────────────────────────────────────
//
// The build version is baked in at compile time (vite.config.js → __BUILD_VERSION__).
// We append it as a query string so:
//   • Each deploy → different SW URL → browser fetches the new file.
//   • The SW itself reads ?v= off its own URL to name its cache (see public/sw.js).
//
// Combined with `updateViaCache: 'none'` here and `Cache-Control: no-cache`
// on /sw.js (vercel.json), this makes "stuck cache" effectively impossible.
//
// CRITICAL: usePushNotifications.js registers with this same SW_URL. If they
// diverge, the two registrations would ping-pong replace each other on every
// page load. Keep them in sync.
const SW_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev'
const SW_URL = `/sw.js?v=${SW_VERSION}`

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(SW_URL, { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        console.log('[SW] Registered:', SW_URL)

        // When a new SW finishes installing, tell it to activate now.
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing
          if (!newWorker) return
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              console.log('[SW] New worker installed — sending SKIP_WAITING')
              newWorker.postMessage({ type: 'SKIP_WAITING' })
            }
          })
        })

        // Poll for SW updates on focus and every 15 minutes.
        // Cheap — just an HTTP check for a changed SW script.
        const checkForUpdates = () => {
          reg.update().catch(() => {})
        }
        window.addEventListener('focus', checkForUpdates)
        setInterval(checkForUpdates, 15 * 60 * 1000)
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err)
      })

    // Log controller changes (we don't auto-reload here — AuthContext handles
    // user-facing reload on login to avoid interrupting active work mid-form).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[SW] Controller changed (new worker took over)')
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
