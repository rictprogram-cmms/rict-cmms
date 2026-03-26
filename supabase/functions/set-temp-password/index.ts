/**
 * RICT CMMS — set-temp-password Edge Function
 *
 * Allows instructors to directly set a temporary password for a Student or
 * Work Study account using the Supabase Admin API (service role key).
 *
 * Also stamps user_metadata.must_reset_password = true so the student is
 * intercepted on their next login and forced to set a new password before
 * they can access any other page (enforced in App.jsx ProtectedRoute).
 *
 * Deploy:
 *   supabase functions deploy set-temp-password
 *
 * POST body: { user_id: string, temp_password: string }
 *   user_id       — auth.users UUID (= profiles.id, NOT the legacy USR#### user_id)
 *   temp_password — the new temporary password (min 6 chars)
 *
 * Caller must supply a valid Supabase JWT (Authorization: Bearer <token>).
 * Only Instructor-role users are permitted; all others receive 403.
 *
 * Returns: { success: true } | { error: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Verify caller JWT ────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Use anon key client to verify the caller's token safely
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user: callerUser }, error: callerErr } = await callerClient.auth.getUser()
    if (callerErr || !callerUser) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2. Confirm caller is an Instructor ──────────────────────────────────
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: callerProfile, error: profileErr } = await adminClient
      .from('profiles')
      .select('role, first_name, last_name')
      .eq('email', callerUser.email)
      .maybeSingle()

    if (profileErr || !callerProfile) {
      return new Response(
        JSON.stringify({ error: 'Could not verify caller profile' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (callerProfile.role !== 'Instructor') {
      return new Response(
        JSON.stringify({ error: 'Only instructors may reset student passwords' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Parse + validate request body ───────────────────────────────────
    let body: { user_id?: string; temp_password?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { user_id, temp_password } = body

    if (!user_id || typeof user_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'user_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (!temp_password || typeof temp_password !== 'string' || temp_password.length < 6) {
      return new Response(
        JSON.stringify({ error: 'temp_password must be at least 6 characters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Verify target exists and is not an Instructor ───────────────────
    const { data: targetProfile, error: targetErr } = await adminClient
      .from('profiles')
      .select('role, first_name, last_name, email')
      .eq('id', user_id)
      .maybeSingle()

    if (targetErr || !targetProfile) {
      return new Response(
        JSON.stringify({ error: 'Target user not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (targetProfile.role === 'Instructor') {
      return new Response(
        JSON.stringify({ error: 'Cannot reset password for Instructor accounts' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 5. Set password AND stamp must_reset_password ──────────────────────
    //
    // user_metadata is MERGED (not replaced) by updateUserById, so any other
    // existing metadata keys are preserved. must_reset_password is read by
    // AuthContext on every SIGNED_IN event and forces a /change-password
    // redirect. AuthContext clears this flag once the user saves a new password.
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(user_id, {
      password: temp_password,
      user_metadata: {
        must_reset_password: true,
      },
    })

    if (updateErr) {
      console.error('Password update failed:', updateErr)
      return new Response(
        JSON.stringify({ error: updateErr.message || 'Password update failed' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 6. Audit log ────────────────────────────────────────────────────────
    const callerName = `${callerProfile.first_name || ''} ${(callerProfile.last_name || '').charAt(0)}.`.trim()
    const targetName = `${targetProfile.first_name} ${targetProfile.last_name}`

    try {
      await adminClient.from('audit_log').insert({
        user_email:  callerUser.email,
        user_name:   callerName,
        action:      'Reset Password',
        entity_type: 'User',
        entity_id:   user_id,
        details:     `Set temporary password for ${targetName} (${targetProfile.email}) — must_reset_password flagged`,
      })
    } catch (auditErr) {
      console.warn('Audit log failed (non-fatal):', auditErr)
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Unhandled error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
