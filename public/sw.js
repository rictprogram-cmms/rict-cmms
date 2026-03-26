/**
 * RICT CMMS — Service Worker
 * Handles Web Push notifications and offline caching.
 *
 * File: public/sw.js
 * Deploy: Vercel serves this automatically from /public
 */

const CACHE_NAME = 'rict-cmms-v1';
const APP_SCOPE = self.registration.scope;

// ── INSTALL ──────────────────────────────────────────────────────────────────
// Skip waiting so the new SW activates immediately on deploy.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
// Claim all open clients immediately so push navigation works right away.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      // Clean up old caches on SW update
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      ),
    ])
  );
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
    clients
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
        if (clients.openWindow) {
          return clients.openWindow(fullUrl);
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
// We only cache the app shell. API calls (Supabase) always go to the network.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always bypass Supabase API calls — never cache these
  if (url.hostname.includes('supabase.co')) return;

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
