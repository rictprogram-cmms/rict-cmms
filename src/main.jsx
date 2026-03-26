import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// ── Register Service Worker for Push Notifications ──
// sw.js lives in public/ and handles background push events.
// Registration is also done inside usePushNotifications hook for instructors,
// but registering here ensures the SW is active even before the hook mounts.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[SW] Service worker registered:', reg.scope)
      })
      .catch((err) => {
        console.warn('[SW] Service worker registration failed:', err)
      })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
