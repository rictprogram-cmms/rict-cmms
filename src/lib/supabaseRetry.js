/**
 * RICT CMMS — supabaseRetry
 *
 * Shared handling for transient network failures on Supabase calls.
 *
 * WHY THIS EXISTS
 * ───────────────
 * iOS Safari (and to a lesser degree Android Chrome) kills idle network
 * connections while a tab is backgrounded or the phone is locked. The very
 * first fetch after the page resumes often fails with:
 *
 *     Safari:  "TypeError: Load failed"
 *     Chrome:  "TypeError: Failed to fetch"
 *
 * postgrest-js surfaces these as { error: { message: 'TypeError: Load
 * failed' } }, which our hooks then throw — so students saw a raw
 * "TypeError: Load failed" when e-signing an asset checkout from a phone
 * that had been sitting in their pocket. A second tap almost always works,
 * because the retry rides a fresh connection.
 *
 * This module automates that second tap:
 *
 *   withNetworkRetry(fn, opts)
 *     1. Fails fast with a friendly message if the browser reports offline.
 *     2. Runs fn(). Non-network errors (RLS, validation, RPC business
 *        rules) are re-thrown IMMEDIATELY and are never retried.
 *     3. On a transient network error: warms the auth session (the token
 *        refresh is frequently the request that died), waits with a short
 *        backoff, and retries — up to `retries` times.
 *     4. If every attempt fails, throws a human-readable Error (with the
 *        original error attached as `.cause`) instead of the raw TypeError.
 *
 *   warmSession()
 *     Fire-and-forget supabase.auth.getSession(). Call on
 *     visibilitychange → 'visible' so the token refresh happens BEFORE the
 *     user taps a button, preventing most of these failures outright.
 *
 * RETRY SAFETY
 * ────────────
 * Only wrap calls where a duplicate attempt is harmless:
 *   • UPDATE-style writes and status-flip RPCs — idempotent.
 *   • INSERTs whose ID was generated BEFORE the wrapped call — a retry of a
 *     write that secretly succeeded hits the PK/unique index and errors
 *     loudly instead of double-inserting.
 * Never wrap a block that generates a fresh ID inside fn() on each attempt.
 *
 * File: src/lib/supabaseRetry.js
 */

import { supabase } from '@/lib/supabase'

/* ── Messages ─────────────────────────────────────────────────────── */

export const OFFLINE_MESSAGE =
  'You appear to be offline. Please check your Wi-Fi or cellular signal and try again.'

export const DEFAULT_FAILURE_MESSAGE =
  'Connection problem — the request did not go through. Please check your signal and try again.'

/* ── Detection ────────────────────────────────────────────────────── */

// Message fragments that indicate the request died at the NETWORK level
// (as opposed to being rejected by the server). Matched case-insensitively.
const TRANSIENT_PATTERNS = [
  'load failed',            // Safari fetch failure
  'failed to fetch',        // Chrome/Edge fetch failure
  'networkerror',           // Firefox fetch failure
  'network request failed',
  'network connection was lost',
  'the internet connection appears to be offline',
  'timeout',
  'timed out',
  'socket',
  'fetch failed',
  'err_network',
  'err_internet_disconnected',
]

/**
 * True when the browser affirmatively reports no connectivity.
 * (navigator.onLine === true is NOT a guarantee of connectivity, so we only
 * trust the negative signal.)
 */
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * Heuristic: does this error look like a transient network failure?
 * Works on real Error instances AND on postgrest-js plain error objects.
 */
export function isTransientNetworkError(err) {
  if (!err) return false
  const msg = String(err.message || err).toLowerCase()
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p))
}

/* ── Session warm-up ──────────────────────────────────────────────── */

/**
 * Nudge supabase-js to validate/refresh the auth token NOW, so the refresh
 * doesn't happen lazily on the user's next tap (where its failure surfaces
 * as "Load failed"). Safe to call often; errors are swallowed.
 */
export function warmSession() {
  try {
    supabase.auth.getSession().catch(() => {})
  } catch {
    /* ignore — best effort only */
  }
}

/* ── Retry wrapper ────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

/**
 * Run an async Supabase operation with offline guard + transient-error retry.
 *
 * @param {Function} fn                 async (attempt) => result. Must THROW
 *                                      on failure (i.e. do your own
 *                                      `if (error) throw error` inside).
 * @param {Object}   [opts]
 * @param {number}   [opts.retries=2]        extra attempts after the first
 * @param {number}   [opts.baseDelayMs=800]  backoff base (800ms, 1600ms, …)
 * @param {string}   [opts.offlineMessage]   shown when navigator says offline
 * @param {string}   [opts.failureMessage]   shown when all attempts fail
 *
 * @returns fn's resolved value
 * @throws  friendly Error (original attached as .cause) for network
 *          failures; the ORIGINAL error untouched for everything else.
 */
export async function withNetworkRetry(fn, {
  retries = 2,
  baseDelayMs = 800,
  offlineMessage = OFFLINE_MESSAGE,
  failureMessage = DEFAULT_FAILURE_MESSAGE,
} = {}) {
  // Fail fast — cheaper and clearer than a doomed round trip.
  if (isOffline()) {
    throw new Error(offlineMessage)
  }

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      // Server-side rejections (RLS, validation, RPC business rules) are
      // real answers — never retry, never rewrite the message.
      if (!isTransientNetworkError(err)) throw err

      lastErr = err
      if (attempt === retries) break

      // The token refresh is often the request that died — warm it before
      // the retry so the retry rides a valid session on a fresh connection.
      try { await supabase.auth.getSession() } catch { /* ignore */ }

      await sleep(baseDelayMs * (attempt + 1))

      if (isOffline()) {
        throw new Error(offlineMessage)
      }
    }
  }

  const friendly = new Error(failureMessage)
  friendly.cause = lastErr
  friendly.isNetworkFailure = true
  throw friendly
}
