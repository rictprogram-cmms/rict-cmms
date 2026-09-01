/**
 * RICT CMMS — Supabase Edge Function: send-push
 *
 * Sends Web Push notifications to all subscribed instructor devices.
 *
 * Triggered by:
 *   - Supabase Database Webhooks (configured in Supabase Dashboard)
 *     Set up webhooks on INSERT for these tables:
 *       • access_requests       → type: "access"
 *       • work_order_requests   → type: "wo"
 *       • orders (status=Pending) → type: "parts"
 *       • time_entry_requests   → type: "time"
 *       • lab_signup_requests   → type: "lab"
 *       • temp_access_requests  → type: "temp"
 *       • help_requests         → type: "help"
 *       • announcements         → type: "announcement" (recipient-specific)
 *       • network_change_requests → type: "netchg"
 *       • absence_requests      → type: "absence"
 *       • asset_checkouts (status=pending_acknowledgment)
 *                               → type: "checkout" (recipient-specific)
 *     The triggers are version-controlled in
 *       supabase/migrations/20260901_push_webhook_triggers.sql
 *
 *   - Can also be called directly from your app:
 *       supabase.functions.invoke('send-push', { body: { type, title, body, url } })
 *     Optional on direct calls:
 *       recipient_email — send only to that user's devices (default: all
 *                         Instructor + Super Admin subscribers)
 *     The Notification Bell's "Send test push" (super admin only) uses this
 *     path with type: 'test' and reports the sent/expired/failed counts.
 *
 * Required Supabase Secrets (set in Supabase Dashboard → Edge Functions → Secrets):
 *   VAPID_PUBLIC_KEY   — your VAPID public key (base64url)
 *   VAPID_PRIVATE_KEY  — your VAPID private key (base64url)
 *   VAPID_SUBJECT      — mailto: or https: contact (e.g. mailto:rictprogram@gmail.com)
 *   WEBHOOK_SECRET     — random string; the DB webhook triggers send it in the
 *                        x-webhook-secret header. Only lets a caller *send a
 *                        push* — it grants no database access, unlike the
 *                        service-role key.
 *
 * ── Authentication ──────────────────────────────────────────────────────────
 * Dashboard setting "Verify JWT with legacy secret" must be OFF for this
 * function (same as set-temp-password). That gateway check only accepts
 * HS256 tokens signed with the legacy JWT secret, so browser sessions are
 * rejected with 401 before the function runs. We verify callers here instead:
 *
 *   • Webhook calls (body.table present): the x-webhook-secret header must
 *     match WEBHOOK_SECRET. As a fallback, the Authorization bearer (or apikey
 *     header) may be this project's legacy service-role or anon key.
 *     (2026-09-01: production triggers were sending a key that no longer
 *     matched either env value → every webhook got 401 and no push went out
 *     except the manual test. The dedicated secret is immune to key rotation.)
 *   • Direct calls (test push, in-app sends): the bearer must be a valid user
 *     session (auth.getUser), and that user's profiles.role must be
 *     Instructor or Super Admin. A service-role bearer is also accepted for
 *     server-to-server use.
 *
 * File: supabase/functions/send-push/index.ts
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── PROJECT KEYS (auto-provided to every Edge Function) ───────────────────────
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';

const ALLOWED_DIRECT_ROLES = ['Instructor', 'Super Admin'];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Bearer token from the Authorization header, or '' if absent. */
function bearerToken(req: Request): string {
  const h = req.headers.get('Authorization') ?? '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

/** True when the request carries one of this project's own API keys. */
function hasProjectKey(req: Request): boolean {
  const candidates = [bearerToken(req), (req.headers.get('apikey') ?? '').trim()];
  return candidates.some(
    (k) => k.length > 0 && (k === SUPABASE_SERVICE_ROLE_KEY || k === SUPABASE_ANON_KEY)
  );
}

/** Constant-time string compare so a secret can't be guessed byte-by-byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries the dedicated webhook secret. */
function hasWebhookSecret(req: Request): boolean {
  const provided = (req.headers.get('x-webhook-secret') ?? '').trim();
  return WEBHOOK_SECRET.length > 0 && provided.length > 0 && safeEqual(provided, WEBHOOK_SECRET);
}

// ── VAPID CONFIG ──────────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:rictprogram@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ── NOTIFICATION TEMPLATES ────────────────────────────────────────────────────
interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  type: string;
  icon?: string;
  badge?: string;
}

function buildNotificationPayload(type: string, record: Record<string, unknown>): NotificationPayload {
  const base = {
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
  };

  switch (type) {
    case 'access': {
      const name = `${record.first_name ?? ''} ${record.last_name ?? ''}`.trim() || String(record.email ?? 'Someone');
      return {
        ...base,
        title: '🧑 New Account Request',
        body: `${name} is requesting access to RICT CMMS`,
        url: '/access',
        tag: `access-${record.request_id}`,
        type,
      };
    }
    case 'wo': {
      const name = String(record.name ?? record.email ?? 'Someone');
      const asset = record.asset_name ? ` — ${record.asset_name}` : '';
      return {
        ...base,
        title: '🔧 New Work Order Request',
        body: `${name}${asset}: ${String(record.description ?? '').slice(0, 80)}`,
        url: '/work-orders',
        tag: `wo-${record.request_id}`,
        type,
      };
    }
    case 'parts': {
      const vendor = String(record.vendor_name ?? record.other_vendor ?? 'Unknown Vendor');
      const total = record.total ? `$${Number(record.total).toFixed(2)}` : '';
      return {
        ...base,
        title: '📦 Parts Order Needs Approval',
        body: `${vendor}${total ? ` — ${total}` : ''} order submitted by ${record.ordered_by ?? 'Unknown'}`,
        url: '/purchase-orders',
        tag: `order-${record.order_id}`,
        type,
      };
    }
    case 'time': {
      const name = String(record.user_name ?? 'Someone');
      const course = record.course_id ? ` (${record.course_id})` : '';
      const entryType = record.entry_type === 'Edit' ? 'Edit' : 'New';
      return {
        ...base,
        title: `⏱ Time ${entryType} Request`,
        body: `${name}${course}: ${record.requested_date ?? ''} — ${record.total_hours ?? '?'}h`,
        url: '/time-cards',
        tag: `time-${record.request_id}`,
        type,
      };
    }
    case 'lab': {
      const name = String(record.user_name ?? 'Someone');
      const course = record.course_id ? ` (${record.course_id})` : '';
      return {
        ...base,
        title: '📅 Lab Schedule Change Request',
        body: `${name}${course} wants to change their lab slots`,
        url: '/lab-signup',
        tag: `lab-${record.request_id}`,
        type,
      };
    }
    case 'temp': {
      const name = String(record.user_name ?? 'Someone');
      const isPermType = record.request_type === 'permissions';
      return {
        ...base,
        title: isPermType ? '🔐 Temp Permission Request' : '🗝 Temp Role Request',
        body: isPermType
          ? `${name} is requesting temporary permission access`
          : `${name} wants ${record.requested_role ?? 'elevated'} access for ${record.days_requested ?? '?'} days`,
        url: '/access',
        tag: `temp-${record.request_id}`,
        type,
      };
    }
    case 'help': {
      const name = String(record.user_name ?? 'A student');
      const room = record.location ? ` in Room ${record.location}` : '';
      return {
        ...base,
        title: '🆘 Student Needs Help!',
        body: `${name}${room} is requesting assistance`,
        url: '/dashboard',
        tag: `help-${record.request_id}`,
        type,
      };
    }
    case 'test': {
      return {
        ...base,
        title: '🔔 RICT CMMS Test Push',
        body: 'Push notifications are working on this device.',
        url: '/dashboard',
        tag: `test-${Date.now()}`,
        type,
      };
    }
    case 'netchg': {
      const who = String(record.submitted_by_name ?? record.submitted_by ?? 'Someone');
      const ct = String(record.change_type ?? '');
      const action = ct === 'add' ? 'Add' : ct === 'delete' ? 'Delete' : ct === 'edit' ? 'Edit' : 'Change';
      return {
        ...base,
        title: '🌐 Network Change Request',
        body: `${who}: ${action} ${record.ip_address ?? 'device'}`,
        url: '/network-map',
        tag: `netchg-${record.request_id}`,
        type,
      };
    }
    case 'absence': {
      const name = String(record.user_name ?? record.user_email ?? 'Someone');
      const cls = record.course_id ?? record.class_id;
      const course = cls ? ` (${cls})` : '';
      const hrs = record.hours_missed ? ` — ${record.hours_missed}h` : '';
      return {
        ...base,
        title: '🗓 Absence Request',
        body: `${name}${course}: ${record.absence_date ?? ''}${hrs}`,
        url: '/absence-requests',
        tag: `absence-${record.request_id}`,
        type,
      };
    }
    case 'checkout': {
      const item = String(record.asset_name ?? record.asset_id ?? 'an item');
      return {
        ...base,
        title: '✍️ Equipment Issued — Signature Needed',
        body: `${item} was issued to you. Open the app to sign for it.`,
        url: '/dashboard',
        tag: `checkout-${record.checkout_id}`,
        type,
      };
    }
    case 'announcement': {
      return {
        ...base,
        title: '📢 New Announcement',
        body: String(record.subject ?? 'You have a new announcement'),
        url: '/announcements',
        tag: `ann-${record.id}`,
        type,
      };
    }
    default: {
      return {
        ...base,
        title: 'RICT CMMS',
        body: 'You have a new notification',
        url: '/dashboard',
        tag: 'rict-general',
        type: 'general',
      };
    }
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Use service role — bypass RLS to read push_subscriptions
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Parse incoming webhook or direct invocation body
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Determine notification type and record ────────────────────────────────
    // When called via Database Webhook:  { type: 'INSERT', table: 'access_requests', record: { ... } }
    // When called directly from app:     { type: 'access', title: '...', body: '...', url: '...' }

    // ── Authenticate the caller ───────────────────────────────────────────────
    const isWebhookCall = !!body.table;
    const bearer = bearerToken(req);

    if (isWebhookCall) {
      // Database Webhook triggers send x-webhook-secret (preferred) or the
      // legacy project key (fallback). Nothing else may use this path.
      if (!hasWebhookSecret(req) && !hasProjectKey(req)) {
        console.warn(
          `[send-push] Webhook rejected for table=${String(body.table)}: ` +
          `secretHeader=${req.headers.has('x-webhook-secret')} ` +
          `authHeader=${req.headers.has('Authorization')} ` +
          `secretConfigured=${WEBHOOK_SECRET.length > 0}`
        );
        return jsonResponse({ error: 'Unauthorized: webhook calls require x-webhook-secret or the project key' }, 401);
      }
    } else if (bearer !== SUPABASE_SERVICE_ROLE_KEY) {
      // Direct call — must be a signed-in Instructor / Super Admin.
      if (!bearer) {
        return jsonResponse({ error: 'Missing Authorization header' }, 401);
      }
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data: { user: callerUser }, error: callerErr } = await callerClient.auth.getUser();
      if (callerErr || !callerUser?.email) {
        return jsonResponse({ error: 'Invalid or expired session' }, 401);
      }
      const { data: callerProfile, error: profileErr } = await supabase
        .from('profiles')
        .select('role')
        .eq('email', callerUser.email)
        .maybeSingle();
      if (profileErr || !callerProfile) {
        return jsonResponse({ error: 'Could not verify caller profile' }, 403);
      }
      if (!ALLOWED_DIRECT_ROLES.includes(String(callerProfile.role))) {
        return jsonResponse({ error: 'Forbidden: only instructors can send push notifications' }, 403);
      }
    }

    let notifType: string;
    let record: Record<string, unknown>;
    let overridePayload: NotificationPayload | null = null;
    // Direct-invocation only: restrict delivery to one user's devices.
    let directRecipient: string | null = null;

    if (body.table) {
      // ── Database Webhook ──────────────────────────────────────────────────
      const tableToType: Record<string, string> = {
        access_requests: 'access',
        work_order_requests: 'wo',
        orders: 'parts',
        time_entry_requests: 'time',
        lab_signup_requests: 'lab',
        temp_access_requests: 'temp',
        help_requests: 'help',
        announcements: 'announcement',
        network_change_requests: 'netchg',
        absence_requests: 'absence',
        asset_checkouts: 'checkout',
      };

      notifType = tableToType[String(body.table)] ?? 'general';
      record = (body.record as Record<string, unknown>) ?? {};

      // For orders, only notify on Pending status (not every update)
      if (notifType === 'parts' && record.status !== 'Pending') {
        return new Response(JSON.stringify({ skipped: 'Not a pending order' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // For announcements, skip if not a new announcement (e.g., read=true updates)
      if (notifType === 'announcement' && body.type !== 'INSERT') {
        return new Response(JSON.stringify({ skipped: 'Not a new announcement' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Network / absence requests: only Pending rows need review
      if ((notifType === 'netchg' || notifType === 'absence') && record.status !== 'Pending') {
        return jsonResponse({ skipped: `Not a pending ${notifType} request` });
      }

      // Asset checkouts: only a pooled issue awaiting the student's signature.
      // Regular checked_out rows are the instructor's own action — no push.
      if (notifType === 'checkout') {
        if (record.status !== 'pending_acknowledgment') {
          return jsonResponse({ skipped: 'Not a pending acknowledgment' });
        }
        if (!record.user_email) {
          return jsonResponse({ skipped: 'Checkout has no recipient' });
        }
      }
    } else if (body.type && (body.title || body.type === 'test')) {
      // ── Direct invocation with explicit payload ───────────────────────────
      notifType = String(body.type);
      record = {};
      if (body.recipient_email) {
        directRecipient = String(body.recipient_email).toLowerCase();
      }
      // 'test' without a title falls through to the built-in test template.
      if (body.title) {
        overridePayload = {
          title: String(body.title),
          body: String(body.body ?? ''),
          url: String(body.url ?? '/dashboard'),
          tag: String(body.tag ?? 'rict-direct'),
          type: notifType,
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
        };
      }
    } else {
      return new Response(JSON.stringify({ error: 'Missing required fields: table or type+title' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const notification = overridePayload ?? buildNotificationPayload(notifType, record);

    // ── Fetch target subscriptions ────────────────────────────────────────────
    // For announcements / checkouts: only push to the specific recipient
    // For everything else: push to all instructor + super admin subscribers
    let subsQuery = supabase.from('push_subscriptions').select('*');

    if (directRecipient) {
      subsQuery = subsQuery.eq('user_email', directRecipient);
    } else if (notifType === 'announcement' && record.recipient_email) {
      // Lowercase both sides defensively. The frontend (usePushNotifications.js
      // saveSubscriptionToSupabase) and AnnouncementsPage already normalize, but if
      // any row was inserted before the normalization fix, this prevents a silent miss.
      subsQuery = subsQuery.eq('user_email', String(record.recipient_email).toLowerCase());
    } else if (notifType === 'checkout') {
      // Recipient-specific: the student who has to sign. Today only
      // instructors can subscribe (usePushNotifications gates on role), so
      // this delivers only once students are allowed to subscribe.
      subsQuery = subsQuery.eq('user_email', String(record.user_email).toLowerCase());
    } else {
      subsQuery = subsQuery.in('role', ['Instructor', 'Super Admin']);
    }

    const { data: subscriptions, error: subsError } = await subsQuery;

    if (subsError) {
      console.error('Failed to fetch push_subscriptions:', subsError);
      return new Response(JSON.stringify({ error: 'DB error fetching subscriptions' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No subscriptions found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Send push to each subscription ───────────────────────────────────────
    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(
            pushSubscription,
            JSON.stringify(notification),
            {
              TTL: 86400,      // Push service holds the message up to 24h if the device is offline
              // 'high' asks FCM/APNs to wake the device immediately. The default
              // ('normal') lets Android Doze / battery optimization defer delivery
              // until the phone wakes or the app is foregrounded — which looks
              // like "notifications only arrive when the app is open".
              urgency: 'high',
            }
          );
          return { email: sub.user_email, status: 'sent' };
        } catch (err: unknown) {
          // Handle expired/invalid subscriptions — clean them up
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 410 || statusCode === 404) {
            // Subscription is no longer valid — remove from DB
            await supabase
              .from('push_subscriptions')
              .delete()
              .eq('endpoint', sub.endpoint);
            console.log(`[send-push] Removed expired subscription for ${sub.user_email}`);
            return { email: sub.user_email, status: 'expired', removed: true };
          }
          console.error(`[send-push] Failed for ${sub.user_email}:`, err);
          return { email: sub.user_email, status: 'failed', error: String(err) };
        }
      })
    );

    const sent = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 'sent'
    ).length;
    const expired = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 'expired'
    ).length;
    const failed = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status === 'failed')
    ).length;

    console.log(`[send-push] Results: ${sent} sent, ${expired} expired/removed, ${failed} failed`);

    return new Response(
      JSON.stringify({
        sent,
        expired,
        failed,
        total: subscriptions.length,
        notification: { title: notification.title, body: notification.body },
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    console.error('[send-push] Unhandled error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
