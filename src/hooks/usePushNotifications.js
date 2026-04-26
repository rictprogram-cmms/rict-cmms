/**
 * RICT CMMS — usePushNotifications Hook
 *
 * Manages Web Push subscription lifecycle for instructor accounts:
 *   1. Registers the service worker (sw.js)
 *   2. Requests notification permission from the browser
 *   3. Subscribes to Web Push via the PushManager
 *   4. Saves the subscription endpoint + keys to Supabase (push_subscriptions table)
 *   5. Handles unsubscribe + cleanup
 *   6. Listens for PUSH_NAVIGATE messages from the service worker to deep-link into the app
 *
 * Usage:
 *   const { pushStatus, subscribeToPush, unsubscribeFromPush } = usePushNotifications()
 *
 * pushStatus values:
 *   'unsupported'  — browser/device does not support Web Push
 *   'blocked'      — user has permanently blocked notifications
 *   'default'      — not yet asked
 *   'subscribed'   — active subscription saved in Supabase
 *   'loading'      — subscription in progress
 *   'error'        — something went wrong
 *
 * File: src/hooks/usePushNotifications.js
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Replace this with your actual VAPID public key.
// Generate with: npx web-push generate-vapid-keys
// Set the PRIVATE key as a Supabase secret (used in the Edge Function only).
// The PUBLIC key is safe to expose here in the frontend.
// ─────────────────────────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || 'YOUR_VAPID_PUBLIC_KEY_HERE';

/**
 * Converts a base64url VAPID public key to the Uint8Array
 * format required by PushManager.subscribe().
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map((char) => char.charCodeAt(0)));
}

export function usePushNotifications() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [pushStatus, setPushStatus] = useState('default');
  const [swRegistration, setSwRegistration] = useState(null);
  const initRef = useRef(false);

  const isInstructor =
    profile?.role === 'Instructor' || profile?.role === 'Super Admin';

  // ── CHECK SUPPORT ──────────────────────────────────────────────────────────
  const isSupported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  // ── REGISTER SERVICE WORKER ────────────────────────────────────────────────
  useEffect(() => {
    if (!isSupported || !isInstructor || initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        // Register sw.js from the public root
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        });
        setSwRegistration(registration);
        console.log('[Push] Service worker registered:', registration.scope);

        // Determine initial push status
        const currentPerm = Notification.permission;
        if (currentPerm === 'denied') {
          setPushStatus('blocked');
          return;
        }

        // Check if there's already an active subscription
        const existingSub = await registration.pushManager.getSubscription();
        if (existingSub) {
          // Verify it's still saved in Supabase (could have been deleted there).
          // Always lowercase email for lookup — see saveSubscriptionToSupabase below for rationale.
          const { data } = await supabase
            .from('push_subscriptions')
            .select('id')
            .eq('user_email', (profile.email || '').toLowerCase())
            .eq('endpoint', existingSub.endpoint)
            .maybeSingle();

          if (data) {
            setPushStatus('subscribed');
            console.log('[Push] Existing subscription found and verified in DB');
          } else {
            // Subscription exists in browser but not in DB — re-save it
            await saveSubscriptionToSupabase(existingSub, profile);
            setPushStatus('subscribed');
            console.log('[Push] Re-saved existing subscription to Supabase');
          }
        } else {
          // No existing subscription
          setPushStatus(currentPerm === 'granted' ? 'default' : 'default');
        }
      } catch (err) {
        console.error('[Push] Service worker registration failed:', err);
        setPushStatus('error');
      }
    })();
  }, [isSupported, isInstructor, profile?.email]);

  // ── LISTEN FOR SW NAVIGATION MESSAGES ────────────────────────────────────
  // When the instructor taps a push notification while the app is open,
  // the service worker sends a PUSH_NAVIGATE message to route to the right page.
  useEffect(() => {
    if (!isSupported) return;

    const handleMessage = (event) => {
      if (event.data?.type === 'PUSH_NAVIGATE' && event.data?.url) {
        console.log('[Push] Navigating to:', event.data.url);
        navigate(event.data.url);
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [isSupported, navigate]);

  // ── SUBSCRIBE ──────────────────────────────────────────────────────────────
  const subscribeToPush = useCallback(async () => {
    if (!isSupported) {
      console.warn('[Push] Web Push not supported on this browser/device.');
      setPushStatus('unsupported');
      return false;
    }
    if (!isInstructor) return false;

    setPushStatus('loading');

    try {
      // 1. Request notification permission
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setPushStatus('blocked');
        console.warn('[Push] Notification permission denied by user.');
        return false;
      }
      if (permission !== 'granted') {
        setPushStatus('default');
        return false;
      }

      // 2. Get (or re-use) the SW registration
      let reg = swRegistration;
      if (!reg) {
        reg = await navigator.serviceWorker.ready;
        setSwRegistration(reg);
      }

      // 3. Subscribe via PushManager
      const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,       // Required — push must show a visible notification
        applicationServerKey,
      });

      console.log('[Push] Push subscription created:', subscription.endpoint);

      // 4. Save subscription to Supabase
      await saveSubscriptionToSupabase(subscription, profile);

      setPushStatus('subscribed');
      return true;
    } catch (err) {
      console.error('[Push] Subscription failed:', err);
      setPushStatus('error');
      return false;
    }
  }, [isSupported, isInstructor, swRegistration, profile]);

  // ── UNSUBSCRIBE ────────────────────────────────────────────────────────────
  const unsubscribeFromPush = useCallback(async () => {
    try {
      const reg = swRegistration || (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Remove from Supabase first.
        // Lowercase email so this matches the stored row (see saveSubscriptionToSupabase).
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('user_email', (profile.email || '').toLowerCase())
          .eq('endpoint', sub.endpoint);

        // Unsubscribe from the browser push service
        await sub.unsubscribe();
        console.log('[Push] Unsubscribed successfully.');
      }
      setPushStatus('default');
      return true;
    } catch (err) {
      console.error('[Push] Unsubscribe failed:', err);
      return false;
    }
  }, [swRegistration, profile?.email]);

  return {
    pushStatus,
    isSupported,
    subscribeToPush,
    unsubscribeFromPush,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Save/upsert a PushSubscription to the push_subscriptions table
// ─────────────────────────────────────────────────────────────────────────────
async function saveSubscriptionToSupabase(subscription, profile) {
  const subJSON = subscription.toJSON();
  const deviceInfo = getDeviceInfo();

  // CRITICAL: lowercase the email before saving.
  // The announcements table stores recipient_email lowercased (see AnnouncementsPage.jsx),
  // and the send-push edge function compares push_subscriptions.user_email against
  // record.recipient_email. If we save mixed-case here, mixed-case email users will
  // silently miss every push notification because the lookup in the edge function
  // would not find their subscription. Always normalize to lowercase.
  const emailLower = (profile.email || '').toLowerCase();

  const record = {
    user_email: emailLower,
    user_name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
    role: profile.role,
    endpoint: subJSON.endpoint,
    p256dh: subJSON.keys?.p256dh || '',
    auth: subJSON.keys?.auth || '',
    device_info: deviceInfo,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Upsert on (user_email, endpoint) — handles re-subscriptions
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(record, { onConflict: 'user_email,endpoint' });

  if (error) {
    console.error('[Push] Failed to save subscription to Supabase:', error);
    throw error;
  }

  console.log('[Push] Subscription saved to Supabase for:', emailLower);
}

/**
 * Builds a human-readable device info string for the push_subscriptions table.
 * Helps identify "Aaron's iPhone" vs "Aaron's laptop" in the DB.
 */
function getDeviceInfo() {
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  let browser = 'Unknown Browser';

  if (/iPhone/.test(ua)) os = 'iOS (iPhone)';
  else if (/iPad/.test(ua)) os = 'iOS (iPad)';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  if (/CriOS/.test(ua)) browser = 'Chrome (iOS)';
  else if (/Chrome/.test(ua)) browser = 'Chrome';
  else if (/Firefox/.test(ua)) browser = 'Firefox';
  else if (/Safari/.test(ua)) browser = 'Safari';
  else if (/Edge/.test(ua)) browser = 'Edge';

  return `${browser} on ${os}`;
}
