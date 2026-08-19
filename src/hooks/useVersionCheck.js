import { useEffect, useRef, useState } from 'react'

// ═══════════════════════════════════════════════════════════════════════════════
// useVersionCheck — periodic build-version polling with optional auto-reload.
//
// WHY THIS EXISTS ALONGSIDE THE AuthContext CHECK
//   AuthContext performs a once-per-login cache-bust check. Kiosk screens
//   (TV Display, Time Clock) stay open for weeks without a fresh login, so
//   that check fires once and never again — deployed updates then wait for
//   the midnight refresh. This hook adds an interval check so kiosks pick
//   up new builds within minutes. The midnight refresh remains as a backstop.
//
// HOW IT WORKS
//   vite.config.js bakes a __BUILD_VERSION__ constant into every bundle and
//   writes the same value to /version.json in the deploy. Every intervalMs
//   (default 10 min, ±60s jitter so multiple Pis don't hit the CDN in the
//   same second) the hook fetches /version.json (cache-busted, no-store)
//   and compares. On mismatch:
//     - autoReload: true  → reload the page (optionally waiting for idle)
//     - autoReload: false → only expose { updateAvailable } for UI (toast)
//
// RELOAD-LOOP GUARD
//   sessionStorage remembers the server version we last reloaded for
//   (sessionStorage survives same-tab reloads). If we already reloaded for
//   that exact version and still mismatch — e.g. a CDN edge briefly serving
//   a stale bundle — we do NOT reload again for it. The next real deploy
//   (new version value) re-arms the guard. Complements, and uses a different
//   key from, AuthContext's own attempt counter.
//
// IDLE GUARD (idleMs > 0)
//   For kiosks people actually touch (Time Clock), the reload waits until
//   there has been no pointer/key/touch input for idleMs, so it never yanks
//   the screen away mid-punch. Once an update is pending, idleness is
//   re-checked every 15s until satisfied. The TV has no input — pass 0.
//
// USAGE
//   useVersionCheck({ label: 'TVDisplay' })                       // reload ASAP
//   useVersionCheck({ label: 'TimeClock', idleMs: 60_000 })       // reload when idle
//   const { updateAvailable } = useVersionCheck({ autoReload: false }) // toast use
// ═══════════════════════════════════════════════════════════════════════════════

const RELOADED_FOR_KEY = '__rict_version_reloaded_for'
const IDLE_RECHECK_MS = 15_000

export function useVersionCheck({
  label = 'VersionCheck',
  intervalMs = 600_000,   // 10 minutes
  idleMs = 0,             // 0 = reload immediately on mismatch
  autoReload = true,
  enabled = true,
} = {}) {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const lastActivityRef = useRef(Date.now())
  const pendingVersionRef = useRef(null)

  useEffect(() => {
    if (!enabled) return
    // Dev server has no build stamp or version.json — skip silently.
    if (typeof __BUILD_VERSION__ === 'undefined') return

    let cancelled = false
    let idleTimer = null

    // ── Idle tracking (only wired when an idle guard is requested) ──
    const markActivity = () => { lastActivityRef.current = Date.now() }
    const activityEvents = ['pointerdown', 'mousedown', 'touchstart', 'keydown']
    if (idleMs > 0) {
      activityEvents.forEach(ev =>
        window.addEventListener(ev, markActivity, { passive: true })
      )
    }

    function attemptReload(serverVersion) {
      let reloadedFor = null
      try { reloadedFor = sessionStorage.getItem(RELOADED_FOR_KEY) } catch { /* storage unavailable */ }
      if (reloadedFor === serverVersion) {
        // Already reloaded for this exact version and we're still stale —
        // don't loop. The midnight refresh / next deploy will resolve it.
        console.warn(`[${label}] Already reloaded for ${serverVersion}; skipping to avoid a loop`)
        return
      }
      if (idleMs > 0 && Date.now() - lastActivityRef.current < idleMs) {
        // Someone is using the screen — try again shortly.
        console.log(`[${label}] Update pending; waiting for ${Math.round(idleMs / 1000)}s of idle`)
        idleTimer = setTimeout(() => {
          if (!cancelled) attemptReload(serverVersion)
        }, IDLE_RECHECK_MS)
        return
      }
      try { sessionStorage.setItem(RELOADED_FOR_KEY, serverVersion) } catch { /* storage unavailable */ }
      console.log(`[${label}] New build detected — client=${__BUILD_VERSION__} server=${serverVersion}. Reloading…`)
      window.location.reload()
    }

    async function check() {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const serverVersion = data?.version
        if (!serverVersion || cancelled) return
        if (serverVersion === __BUILD_VERSION__) return
        pendingVersionRef.current = serverVersion
        setUpdateAvailable(true)
        if (autoReload) attemptReload(serverVersion)
      } catch {
        // Offline, dev server, transient network error — silently skip;
        // the next interval (or the midnight refresh) will catch up.
      }
    }

    // First check shortly after mount (grace period so a freshly booted
    // kiosk finishes loading), then on a jittered interval.
    const jitter = Math.floor(Math.random() * 120_000) - 60_000 // ±60s
    const firstDelay = 30_000
    const startTimer = setTimeout(check, firstDelay)
    const interval = setInterval(check, Math.max(60_000, intervalMs + jitter))

    return () => {
      cancelled = true
      clearTimeout(startTimer)
      clearTimeout(idleTimer)
      clearInterval(interval)
      if (idleMs > 0) {
        activityEvents.forEach(ev => window.removeEventListener(ev, markActivity))
      }
    }
  }, [enabled, intervalMs, idleMs, autoReload, label])

  return { updateAvailable, pendingVersion: pendingVersionRef.current }
}

export default useVersionCheck
