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
 *
 *   - Can also be called directly from your app:
 *       supabase.functions.invoke('send-push', { body: { type, title, body, url } })
 *
 * Required Supabase Secrets (set in Supabase Dashboard → Edge Functions → Secrets):
 *   VAPID_PUBLIC_KEY   — your VAPID public key (base64url)
 *   VAPID_PRIVATE_KEY  — your VAPID private key (base64url)
 *   VAPID_SUBJECT      — mailto: or https: contact (e.g. mailto:rictprogram@gmail.com)
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    // Use service role — bypass RLS to read push_subscriptions
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

    let notifType: string;
    let record: Record<string, unknown>;
    let overridePayload: NotificationPayload | null = null;

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
    } else if (body.type && body.title) {
      // ── Direct invocation with explicit payload ───────────────────────────
      notifType = String(body.type);
      record = {};
      overridePayload = {
        title: String(body.title),
        body: String(body.body ?? ''),
        url: String(body.url ?? '/dashboard'),
        tag: String(body.tag ?? 'rict-direct'),
        type: notifType,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
      };
    } else {
      return new Response(JSON.stringify({ error: 'Missing required fields: table or type+title' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const notification = overridePayload ?? buildNotificationPayload(notifType, record);

    // ── Fetch target subscriptions ────────────────────────────────────────────
    // For announcements: only push to the specific recipient
    // For everything else: push to all instructor + super admin subscribers
    let subsQuery = supabase.from('push_subscriptions').select('*');

    if (notifType === 'announcement' && record.recipient_email) {
      // Lowercase both sides defensively. The frontend (usePushNotifications.js
      // saveSubscriptionToSupabase) and AnnouncementsPage already normalize, but if
      // any row was inserted before the normalization fix, this prevents a silent miss.
      subsQuery = subsQuery.eq('user_email', String(record.recipient_email).toLowerCase());
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
            { TTL: 86400 } // Cache push for 24 hours if device is offline
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
