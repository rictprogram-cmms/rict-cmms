/**
 * RICT CMMS — Super admin identity (single source of truth)
 *
 * The utility super admin account (see SUPER_ADMIN_EMAIL) exists for
 * administration, emulation and automated jobs. It must never appear in
 * user-facing UI: people pickers, messaging recipients, instructor lists,
 * leaderboards, etc.
 *
 * Every check for "is this the super admin?" and every "hide the super admin
 * from this list" must go through this module so the address is written in
 * exactly one place. Do not hard-code the email anywhere else.
 *
 * Usage
 *   import { SUPER_ADMIN_EMAIL, isSuperAdminEmail, isSuperAdmin, excludeSuperAdmin } from '@/lib/superAdmin'
 *
 *   isSuperAdmin(profile)                      // true for the utility account
 *   isSuperAdminEmail(someEmail)               // same, from a bare email string
 *   excludeSuperAdmin(profiles)                // filter it out of a picker list
 *   .neq('email', SUPER_ADMIN_EMAIL)           // server-side filter in a query
 *
 * File: src/lib/superAdmin.js
 */

export const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

/** Case-insensitive test on a bare email string. */
export function isSuperAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL
}

/** Test on a profile-like object ({ email }). */
export function isSuperAdmin(profile) {
  return isSuperAdminEmail(profile?.email)
}

/**
 * Remove the super admin from a list of profile-like objects.
 * `emailKey` lets callers filter rows whose email lives under another
 * field name (e.g. messages with `sender_email`).
 */
export function excludeSuperAdmin(rows, emailKey = 'email') {
  return (rows || []).filter(r => !isSuperAdminEmail(r?.[emailKey]))
}
