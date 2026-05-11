/**
 * RICT CMMS — Service Worker
 * Handles Web Push notifications + auto cache-busting on every deploy.
 *
 * File: public/sw.js
 * Deploy: Vercel serves this automatically from /public
 *
 * ── How cache-busting works ────────────────────────────────────────────────
 * This SW is registered as `/sw.js?v=<BUILD_VERSION>` from main.jsx and
 * usePushNotifications.js. We read that query parameter off our own URL to
 * derive a per-build cache name. On every new deploy:
 *
 *   • The registered URL changes (new ?v=) → browser fetches the new SW.
 *   • install/activate run with a new CACHE_NAME → old caches are purged.
 *
 * Combined with `Cache-Control: no-cache, must-revalidate` on /sw.js (set in
 * vercel.json) and `updateViaCache: 'none'` on register() (main.jsx), users
 * will never be stuck on a stale bundle after a deploy.
 */

const SW_URL = new URL(self.location.href);
const SW_VERSION = SW_URL.searchParams.get('v') || 'dev';
const CACHE_NAME = `rict-cmms-${SW_VERSION}`;
const APP_SCOPE = self.registration.scope;

// ── INSTALL ──────────────────────────────────────────────────────────────────
// Skip waiting so the new SW activates immediately on deploy.
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing — version=${SW_VERSION}`);
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
// Claim all open clients immediately AND purge any cache that doesn't match
// this build's CACHE_NAME. Because CACHE_NAME changes per deploy, this
// automatically deletes the previous version's cache on first run.
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating — version=${SW_VERSION}`);
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => {
              console.log(`[SW] Deleting stale cache: ${k}`);
              return caches.delete(k);
            })
        )
      ),
    ])
  );
});

// ── MESSAGE (postMessage from page) ──────────────────────────────────────────
// main.jsx posts { type: 'SKIP_WAITING' } when it detects a new SW is
// installed and waiting. Lets us flip to the new SW without waiting for
// all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received — activating immediately');
    self.skipWaiting();
  }
});

// ── PUSH ─────────────────────────────────────────────────────────────────────
/**
 * Push payload shape (JSON from Edge Function):
 * {
 *   title: "RICT CMMS",
 *   body: "Jordan S. submitted a Work Order Request",
 *   url: "/work-orders",           // page to open on tap
 *   tag: "wo-request",             // collapses duplicate notifications
 *   icon: "/icons/icon-192.png",
 *   badge: "/icons/badge-72.png",
 *   type: "wo" | "access" | "time" | "lab" | "help" | "announcement"
 * }
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: 'RICT CMMS',
      body: event.data.text() || 'You have a new notification',
      url: '/dashboard',
      tag: 'rict-general',
    };
  }

  const {
    title = 'RICT CMMS',
    body = 'You have a new notification',
    url = '/dashboard',
    tag = 'rict-notification',
    icon = '/icons/icon-192.png',
    badge = '/icons/badge-72.png',
    type = 'general',
  } = payload;

  // Build action buttons based on notification type
  const actions = buildActions(type);

  const options = {
    body,
    icon,
    badge,
    tag,                     // Collapses duplicate notifications (e.g., multiple WO requests show as one)
    data: { url, type },
    requireInteraction: true, // Stays on screen until dismissed (not auto-dismissed after a few seconds)
    actions,
    // Vibrate: short-long-short pattern
    vibrate: [100, 50, 200],
    timestamp: Date.now(),
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

function buildActions(type) {
  switch (type) {
    case 'help':
      return [
        { action: 'view', title: '📋 View' },
        { action: 'dismiss', title: '✕ Dismiss' },
      ];
    case 'announcement':
      return [
        { action: 'view', title: '👁 Read' },
        { action: 'dismiss', title: '✕ Dismiss' },
      ];
    default:
      // access, wo, time, lab, temp — all need review
      return [
        { action: 'view', title: '✅ Review' },
        { action: 'dismiss', title: '✕ Dismiss' },
      ];
  }
}

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/dashboard';
  const fullUrl = new URL(url, APP_SCOPE).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // If the app is already open in a tab/window, focus it and navigate
        for (const client of clientList) {
          if (
            client.url.startsWith(APP_SCOPE) &&
            'focus' in client
          ) {
            client.focus();
            // Send a message to the React app to navigate to the right page
            client.postMessage({ type: 'PUSH_NAVIGATE', url });
            return;
          }
        }
        // App is closed — open a new window directly to the target page
        if (self.clients.openWindow) {
          return self.clients.openWindow(fullUrl);
        }
      })
  );
});

// ── NOTIFICATION CLOSE ────────────────────────────────────────────────────────
// Track dismissals if needed in the future (analytics, badge counts, etc.)
self.addEventListener('notificationclose', (event) => {
  // Could POST analytics here if desired
  console.log('[SW] Notification dismissed:', event.notification.tag);
});

// ── FETCH (Minimal — pass-through, no aggressive caching) ────────────────────
// We DON'T cache HTML/JS/CSS — fresh from network every time so users always
// get the latest deploy without needing Ctrl+Shift+R.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always bypass Supabase API calls — never cache these
  if (url.hostname.includes('supabase.co')) return;

  // Never cache version.json — it MUST be fresh for our cache-bust check
  if (url.pathname === '/version.json') {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // For navigation requests, serve index.html (SPA fallback)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html')
      )
    );
    return;
  }

  // Default: network first
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
