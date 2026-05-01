/**
 * RICT CMMS - Access Control Page (Super Admin Only)
 * Faithfully reproduces the old Google Apps Script Access Control page.
 *
 * Features:
 *  - Super Admin only access (rictprogram@gmail.com)
 *  - Stats cards: Student / Work Study / Instructor permission counts
 *  - Collapsible page sections with permission tables
 *  - Toggle switches per role (color-coded: gold=Student, blue=Work Study, green=Instructor)
 *  - Pending changes tracking with sticky save bar
 *  - Bulk save, discard, refresh
 *  - Sync missing permissions (adds any new defaults)
 *  - Remove duplicates cleanup
 *  - Initialize permissions table if empty
 *  - Verify Integrity (NEW): compares DEFAULT_PERMISSIONS to DB and reports drift
 *  - Export Seed SQL (NEW): exports current DB state as recovery SQL
 *  - Validation banner (NEW): warns if DEFAULT_PERMISSIONS array has internal duplicates
 *  - ID collision protection (NEW): syncMissing auto-renames colliding IDs instead
 *    of silently overwriting another page's permission row
 *
 * Supabase table: permissions
 *   Columns: permission_id, page, feature, student, work_study, instructor,
 *            description, updated_at, updated_by
 *
 * Recommended companion DB constraint:
 *   ALTER TABLE permissions
 *     ADD CONSTRAINT permissions_page_feature_unique UNIQUE (page, feature);
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

const PAGE_ICONS = {
  'Dashboard': 'dashboard',
  'Work Orders': 'assignment',
  'Inventory': 'inventory_2',
  'Assets': 'precision_manufacturing',
  'Asset Checkouts': 'history',
  'Purchase Orders': 'local_shipping',
  'PM': 'event_repeat',
  'Lab Signup': 'event_available',
  'Equipment Scheduling': 'build',
  'SOPs': 'description',
  'Network Map': 'lan',
  'Reports': 'assessment',
  'WOC Ratio': 'score',
  'Bug Tracker': 'bug_report',
  'Announcements': 'campaign',
  'Program Budget': 'account_balance',
  'Weekly Labs': 'grading',
  'Volunteer Hours': 'volunteer_activism',
  'Request History': 'manage_search',
  'Users': 'people',
  'Settings': 'settings',
}

// All default permissions — synced to match actual database state
// NOTE: When adding new features, add the permission here AND in the DB
//
// CRITICAL: permission_id must be globally unique. (page, feature) must be globally unique.
//           Any violation will be flagged at page load and risky bulk operations will be
//           disabled until the duplicates are resolved.
const DEFAULT_PERMISSIONS = [
  // Dashboard
  ['P001', 'Dashboard', 'view_page', true, true, true, 'Can access Dashboard page'],

  // Work Orders
  ['P010', 'Work Orders', 'view_page', true, true, true, 'Can access Work Orders page'],
  ['P011', 'Work Orders', 'create_wo', true, true, true, 'Can create new work orders'],
  ['P012', 'Work Orders', 'edit_wo', false, true, true, 'Can edit work orders'],
  ['P013', 'Work Orders', 'delete_wo', false, false, true, 'Can delete work orders'],
  ['P014', 'Work Orders', 'assign_wo', true, true, true, 'Can assign work orders'],
  ['P015', 'Work Orders', 'close_wo', true, true, true, 'Can close work orders'],
  ['P016', 'Work Orders', 'add_work_log', true, true, true, 'Can add work log entries'],
  ['P017', 'Work Orders', 'add_parts', true, true, true, 'Can add parts to work orders'],
  ['P018', 'Work Orders', 'view_all_wo', true, true, true, 'Can view all work orders'],
  ['P01A', 'Work Orders', 'upload_wo_doc', true, true, true, 'Can upload documents to work orders'],
  ['P110', 'Work Orders', 'edit_assets', false, false, true, 'Can change asset on work orders'],
  ['P111', 'Work Orders', 'edit_due_date', false, false, true, 'Can change due date on work orders'],
  ['P112', 'Work Orders', 'edit_priority', false, false, true, 'Can change priority on work orders'],
  ['P113', 'Work Orders', 'edit_status', true, true, true, 'Can change status on work orders'],
  ['P114', 'Work Orders', 'delete_work_log', false, false, true, 'Can delete work log entries'],
  ['P115', 'Work Orders', 'delete_parts', false, true, true, 'Can delete parts from work orders'],
  ['P116', 'Work Orders', 'delete_documents', false, true, true, 'Can delete documents from work orders'],

  // Inventory
  ['P020', 'Inventory', 'view_page', true, true, true, 'Can access Inventory page'],
  ['P021', 'Inventory', 'add_items', false, true, true, 'Can add inventory items'],
  ['P022', 'Inventory', 'edit_items', false, true, true, 'Can edit inventory items'],
  ['P023', 'Inventory', 'delete_items', false, false, true, 'Can delete inventory items'],
  ['P024', 'Inventory', 'adjust_quantity', false, true, true, 'Can adjust inventory quantities'],
  ['P025', 'Inventory', 'manage_suppliers', false, true, true, 'Can manage suppliers'],
  ['P026', 'Inventory', 'print_labels', false, true, true, 'Can print inventory labels'],
  ['P027', 'Inventory', 'upload_images', false, true, true, 'Can upload inventory images'],
  ['P028', 'Inventory', 'manage_orders', false, true, true, 'Can view order sheet and mark items ordered'],
  ['P029', 'Inventory', 'create_order', true, true, true, 'Can create new parts orders'],
  ['P02A', 'Inventory', 'view_orders', false, true, true, 'Can view pending and past orders'],
  ['P02B', 'Inventory', 'receive_orders', false, false, true, 'Can mark orders as received (partial or full)'],
  ['P0AB', 'Inventory', 'view_low_stock', false, true,  true, 'Can view low stock filter and column on Inventory page'],

  // Assets
  ['P030', 'Assets', 'view_page', true, true, true, 'Can access Assets page'],
  ['P031', 'Assets', 'add_assets', false, true, true, 'Can add assets'],
  ['P032', 'Assets', 'edit_assets', false, true, true, 'Can edit assets'],
  ['P033', 'Assets', 'delete_assets', false, false, true, 'Can delete assets'],
  ['P034', 'Assets', 'upload_docs', true, true, true, 'Can upload asset documents'],
  ['P035', 'Assets', 'view_history', true, true, true, 'Can view asset history'],
  ['P036', 'Assets', 'print_labels', false, true, true, 'Can print asset labels'],
  ['P128', 'Assets', 'duplicate_assets', false, true, true, 'Can duplicate an existing asset'],

  // Asset Checkouts
  ['P160', 'Asset Checkouts', 'view_page',           true,  true,  true,  'Can access Asset Checkouts page'],
  ['P161', 'Asset Checkouts', 'view_own',            true,  true,  true,  'Can view own checkouts'],
  ['P162', 'Asset Checkouts', 'view_all',            false, true,  true,  'Can view all checkouts'],
  ['P163', 'Asset Checkouts', 'checkout_self',       true,  true,  true,  'Can check out an asset to self'],
  ['P164', 'Asset Checkouts', 'checkout_others',     false, false, true,  'Can check out an asset on behalf of another user'],
  ['P165', 'Asset Checkouts', 'checkin_assets',      false, true,  true,  'Can check assets back in'],
  ['P166', 'Asset Checkouts', 'extend_due_date',     false, false, true,  'Can extend due date on an open checkout'],
  ['P167', 'Asset Checkouts', 'force_return',        false, false, true,  'Can force-return without typed acknowledgment'],
  ['P168', 'Asset Checkouts', 'export_data',         false, false, true,  'Can export checkout data and run reports'],
  ['P169', 'Asset Checkouts', 'manage_checkoutable', false, false, true,  'Can flag assets as checkoutable'],

  // Purchase Orders
  ['P0A0', 'Purchase Orders', 'view_page', true, true, true, 'Can access Purchase Orders page'],
  ['P0A1', 'Purchase Orders', 'view_orders', true, true, true, 'Can view purchase orders'],
  ['P0A2', 'Purchase Orders', 'view_all_po', true, true, true, 'Can view all POs (not just own)'],
  ['P0A3', 'Purchase Orders', 'create_po', true, true, true, 'Can create new purchase orders'],
  ['P0A4', 'Purchase Orders', 'edit_po', false, true, true, 'Can edit purchase orders'],
  ['P0A5', 'Purchase Orders', 'approve_po', false, false, true, 'Can approve or reject purchase orders'],
  ['P0A6', 'Purchase Orders', 'send_po', false, true, true, 'Can mark PO as ordered/sent to vendor'],
  ['P0A7', 'Purchase Orders', 'receive_po', false, false, true, 'Can receive items against purchase orders'],
  ['P0A8', 'Purchase Orders', 'cancel_po', false, false, true, 'Can cancel purchase orders'],
  ['P0A9', 'Purchase Orders', 'view_dashboard_spend', false, false, true, 'Can view spend dashboard / totals on Purchase Orders page'],
  ['P0AA', 'Purchase Orders', 'print_po',             false, true,  true, 'Can print purchase orders'],
  ['P0AC', 'Purchase Orders', 'view_low_stock',       false, true,  true, 'Can view the Low Stock tab on Purchase Orders page'],

  // PM
  ['P040', 'PM', 'view_page', true, true, true, 'Can access PM page'],
  ['P041', 'PM', 'create_pm', false, true, true, 'Can create PM schedules'],
  ['P042', 'PM', 'edit_pm', false, true, true, 'Can edit PM schedules'],
  ['P043', 'PM', 'delete_pm', false, false, true, 'Can delete PM schedules'],
  ['P044', 'PM', 'complete_pm', false, true, true, 'Can mark PM tasks complete'],
  ['P045', 'PM', 'generate_wo', false, true, true, 'Can generate WO from PM'],
  ['P046', 'PM', 'pause_generation', false, false, true, 'Can pause/resume PM generation'],

  // Lab Signup
  ['P050', 'Lab Signup', 'view_page', true, true, true, 'Can access Lab Signup'],
  ['P051', 'Lab Signup', 'signup_self', true, true, true, 'Can sign up for lab time'],
  ['P052', 'Lab Signup', 'cancel_own', true, true, true, 'Can cancel own signups'],
  ['P053', 'Lab Signup', 'manage_others', false, false, true, 'Can manage others signups'],
  ['P054', 'Lab Signup', 'view_calendar', true, true, true, 'Can view lab calendar'],
  ['P055', 'Lab Signup', 'manage_calendar', false, false, true, 'Can manage calendar settings'],

  // Equipment Scheduling
  ['P120', 'Equipment Scheduling', 'view_page',           true,  true,  true,  'Can access Equipment Scheduling page'],
  ['P121', 'Equipment Scheduling', 'book_equipment',      true,  true,  true,  'Can book equipment time slots'],
  ['P122', 'Equipment Scheduling', 'edit_own_booking',    true,  true,  true,  'Can edit own equipment bookings'],
  ['P123', 'Equipment Scheduling', 'cancel_own_booking',  true,  true,  true,  'Can cancel own equipment bookings'],
  ['P124', 'Equipment Scheduling', 'manage_all_bookings', false, false, true,  "Can manage any user's equipment bookings"],
  ['P125', 'Equipment Scheduling', 'manage_equipment',    false, false, true,  'Can add, edit, and retire equipment entries'],

  // SOPs (Standard Operating Procedures)
  // NOTE: IDs P149-P154 were assigned after a recovery — original P120-P125 were
  // accidentally reassigned to Equipment Scheduling. P126/P127/P130/P131 are the
  // pre-recovery survivors. Do NOT renumber these without a coordinated DB migration.
  ['P149', 'SOPs', 'view_page',         true,  true,  true,  'Can access SOPs page'],
  ['P150', 'SOPs', 'create_sop',        false, true,  true,  'Can create new SOPs'],
  ['P151', 'SOPs', 'edit_sop',          false, true,  true,  'Can edit SOP name/description'],
  ['P152', 'SOPs', 'delete_sop',        false, false, true,  'Can delete SOPs'],
  ['P153', 'SOPs', 'upload_document',   false, true,  true,  'Can upload PDF document to SOP'],
  ['P154', 'SOPs', 'replace_document',  false, true,  true,  'Can replace existing PDF document'],
  ['P126', 'SOPs', 'delete_document',   false, false, true,  'Can delete PDF document from SOP'],
  ['P127', 'SOPs', 'link_items',        false, true,  true,  'Can link/unlink assets, PMs, and WOs'],
  ['P130', 'SOPs', 'download_template', true,  true,  true,  'Can download the blank SOP template file'],
  ['P131', 'SOPs', 'manage_template',   false, false, true,  'Can upload or replace the blank SOP template'],

  // Network Map
  ['P140', 'Network Map', 'view_page',       true,  true,  true,  'Can access Network Map page'],
  ['P141', 'Network Map', 'edit_devices',    false, true,  true,  'Can edit device entries on the Network Map'],
  ['P142', 'Network Map', 'suggest_changes', true,  true,  true,  'Can submit suggested changes to the Network Map'],
  ['P143', 'Network Map', 'approve_changes', false, false, true,  'Can approve or reject suggested Network Map changes'],
  ['P144', 'Network Map', 'delete_devices',  false, false, true,  'Can delete device entries from the Network Map'],
  ['P145', 'Network Map', 'add_devices',     false, true,  true,  'Can add new device entries to the Network Map'],
  ['P146', 'Network Map', 'print_map',       false, true,  true,  'Can print the Network Map'],
  ['P147', 'Network Map', 'export_data',     false, true,  true,  'Can export Network Map data'],
  ['P148', 'Network Map', 'manage_subnets',  false, false, true,  'Can manage subnet definitions (planned feature)'],

  // Reports (Time Cards)
  ['P060', 'Reports', 'view_page', true, true, true, 'Can access Reports/Time Cards'],
  ['P061', 'Reports', 'view_own', true, true, true, 'Can view own time cards'],
  ['P062', 'Reports', 'view_all', false, false, true, 'Can view all time cards'],
  ['P063', 'Reports', 'export_reports', false, false, true, 'Can export reports'],
  ['P064', 'Reports', 'edit_time', false, false, true, 'Can edit time entries'],

  // WOC Ratio
  ['P070', 'WOC Ratio', 'view_page', true, true, true, 'Can access WOC Ratio page'],
  ['P071', 'WOC Ratio', 'view_own_score', true, true, true, 'Can view own WOC score'],
  ['P072', 'WOC Ratio', 'view_all_scores', false, false, true, 'Can view all WOC scores'],
  ['P073', 'WOC Ratio', 'edit_scores', false, false, true, 'Can edit evaluation scores'],

  // Bug Tracker
  ['P080', 'Bug Tracker', 'view_page', true, true, true, 'Can access Bug Tracker'],
  ['P081', 'Bug Tracker', 'submit_bugs', true, true, true, 'Can submit bug reports'],
  ['P082', 'Bug Tracker', 'view_all_bugs', true, true, true, 'Can view all bug reports'],
  ['P083', 'Bug Tracker', 'update_status', false, false, false, 'Can update bug status'],
  ['P084', 'Bug Tracker', 'mark_complete', false, false, false, 'Can mark bugs complete'],
  ['P085', 'Bug Tracker', 'delete_bugs', false, false, false, 'Can delete bug reports'],

  // Announcements
  ['P0B0', 'Announcements', 'view_page', true, true, true, 'Can access Announcements page'],
  ['P0B1', 'Announcements', 'compose_message', false, false, true, 'Can compose and send announcements'],
  ['P0B2', 'Announcements', 'view_sent', false, false, true, 'Can view sent message history'],
  ['P0B3', 'Announcements', 'manage_templates', false, false, true, 'Can create and edit message templates'],
  ['P0B4', 'Announcements', 'manage_holds',     false, false, true, 'Can manage student holds from the Announcements page'],

  // Program Budget
  // NOTE: Some Program Budget IDs use the "PB##" naming pattern instead of "P0C#".
  // Both formats coexist in the DB; both are kept here to match.
  ['P0C0', 'Program Budget', 'view_page', false, false, true, 'Can access Program Budget page'],
  ['P0C1', 'Program Budget', 'add_entries', false, false, true, 'Can add budget entries'],
  ['P0C2', 'Program Budget', 'edit_entries', false, false, true, 'Can edit and delete budget entries'],
  ['P0C3', 'Program Budget', 'manage_years', false, false, true, 'Can manage school year settings'],
  ['PB02', 'Program Budget', 'view_transactions', false, false, true, 'Can view the Transactions tab'],
  ['PB05', 'Program Budget', 'delete_entries',    false, false, true, 'Can delete budget entries'],
  ['PB06', 'Program Budget', 'import_data',       false, false, true, 'Can import data into Program Budget'],

  // Weekly Labs Tracker
  ['P0D0', 'Weekly Labs', 'view_page', true, true, true, 'Can access Weekly Labs Tracker'],
  ['P0D1', 'Weekly Labs', 'view_all_students', false, false, true, 'Can view all students lab progress'],
  ['P0D2', 'Weekly Labs', 'manage_signoffs', false, false, true, 'Can sign off labs and mark all-done'],

  // Volunteer Hours
  ['P0E0', 'Volunteer Hours', 'view_page', true, true, true, 'Can access Volunteer Hours page'],
  ['P0E1', 'Volunteer Hours', 'view_all_students', false, false, true, 'Can view all students volunteer progress'],
  ['P0E2', 'Volunteer Hours', 'approve_entries', false, false, true, 'Can approve or reject volunteer submissions'],

  // Request History
  ['P0F0', 'Request History', 'view_page', true, true, true, 'Can access Request History page'],
  ['P0F1', 'Request History', 'view_all_students', false, false, true, 'Can view all students request history'],
  ['P0F2', 'Request History', 'export_data', false, false, true, 'Can export request history to Excel'],

  // Users
  ['P090', 'Users', 'view_page', false, false, true, 'Can access Users page'],
  ['P091', 'Users', 'add_users', false, false, true, 'Can add users'],
  ['P092', 'Users', 'edit_users', false, false, true, 'Can edit users'],
  ['P093', 'Users', 'deactivate_users', false, false, true, 'Can deactivate users'],
  ['P094', 'Users', 'delete_users', false, false, true, 'Can delete users'],
  ['P095', 'Users', 'approve_requests', false, false, true, 'Can approve access requests'],
  ['P096', 'Users', 'change_roles', false, false, true, 'Can change user roles'],
  ['P097', 'Users', 'assign_card_id', false, false, true, 'Can assign card IDs/badges to users for time clock'],
  ['P098', 'Users', 'send_messages', false, false, true, 'Can send announcements/messages'],

  // Settings
  ['P100', 'Settings', 'view_page', false, false, true, 'Can access Settings page'],
  ['P101', 'Settings', 'edit_settings', false, false, true, 'Can edit system settings'],
  ['P102', 'Settings', 'manage_categories', false, false, true, 'Can manage categories'],
  ['P103', 'Settings', 'manage_locations', false, false, true, 'Can manage locations'],
  ['P104', 'Settings', 'manage_vendors', false, false, true, 'Can manage vendors'],
  ['P105', 'Settings', 'manage_statuses', false, false, true, 'Can manage WO statuses'],
  ['P106', 'Settings', 'manage_classes', false, false, true, 'Can manage classes'],
  ['P107', 'Settings', 'manage_asset_locations', false, false, false, 'Can manage asset locations'],
  ['P108', 'Settings', 'manage_inventory_locations', false, false, false, 'Can manage inventory locations'],
  ['P109', 'Settings', 'edit_storage_settings', false, false, false, 'Can edit Google Drive folder IDs (Super Admin)'],
  ['P10A', 'Settings', 'edit_notification_settings', false, false, false, 'Can edit notification email (Super Admin)'],
  ['P10B', 'Settings', 'edit_printing_settings', false, false, false, 'Can edit label printer settings (Super Admin)'],
  ['P10C', 'Settings', 'edit_lab_settings', false, false, true, 'Can edit weekly lab tracker settings']
]

function formatFeature(f) {
  return f.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

/**
 * Detect duplicate permission_ids and duplicate (page, feature) pairs in
 * the DEFAULT_PERMISSIONS source array. Runs once at module load.
 *
 * Why this matters: when adding a new page, it's easy to manually pick a
 * permission_id that already belongs to another page. Before this check,
 * doing so caused syncMissing() to silently overwrite the original page's
 * permission row in the DB. Now the page renders a blocking warning banner
 * if duplicates are present, and bulk operations are disabled until fixed.
 */
function validateDefaultPermissions() {
  const idToRows = new Map()
  const keyToIds = new Map()

  DEFAULT_PERMISSIONS.forEach(([permId, page, feature]) => {
    if (!idToRows.has(permId)) idToRows.set(permId, [])
    idToRows.get(permId).push({ page, feature })

    const key = page + '|' + feature
    if (!keyToIds.has(key)) keyToIds.set(key, [])
    keyToIds.get(key).push(permId)
  })

  const duplicateIds = []
  idToRows.forEach((rows, id) => {
    if (rows.length > 1) duplicateIds.push({ permission_id: id, occurrences: rows })
  })

  const duplicateKeys = []
  keyToIds.forEach((ids, key) => {
    if (ids.length > 1) {
      const [page, feature] = key.split('|')
      duplicateKeys.push({ page, feature, ids })
    }
  })

  return {
    duplicateIds,
    duplicateKeys,
    hasIssues: duplicateIds.length > 0 || duplicateKeys.length > 0,
  }
}

const ARRAY_VALIDATION = validateDefaultPermissions()

export default function AccessPage() {
  const { profile } = useAuth()

  const [permissions, setPermissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [pendingChanges, setPendingChanges] = useState({})
  const [expandedSections, setExpandedSections] = useState({})
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmModal, setConfirmModal] = useState(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [integrityResult, setIntegrityResult] = useState(null)
  const [seedSQL, setSeedSQL] = useState(null)

  const isSuperAdmin = profile?.email?.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()
  const arrayHasIssues = ARRAY_VALIDATION.hasIssues

  // Load permissions
  const loadPermissions = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('permissions')
        .select('*')
        .order('permission_id', { ascending: true })

      if (error) throw error

      if (!data || data.length === 0) {
        setNeedsSetup(true)
        setPermissions([])
      } else {
        setNeedsSetup(false)
        setPermissions(data)
      }
    } catch (e) {
      showToast('Error loading permissions: ' + e.message, 'error')
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadPermissions() }, [loadPermissions])

  // Group permissions by page
  const groupedPermissions = useMemo(() => {
    const groups = {}
    permissions.forEach(p => {
      if (!groups[p.page]) groups[p.page] = []
      groups[p.page].push(p)
    })
    return groups
  }, [permissions])

  // Stats
  const stats = useMemo(() => {
    let student = 0, workStudy = 0, instructor = 0
    const total = permissions.length
    permissions.forEach(p => {
      const sKey = p.permission_id + '_Student'
      const wsKey = p.permission_id + '_Work Study'
      const iKey = p.permission_id + '_Instructor'
      if (pendingChanges[sKey] !== undefined ? pendingChanges[sKey].value : p.student) student++
      if (pendingChanges[wsKey] !== undefined ? pendingChanges[wsKey].value : p.work_study) workStudy++
      if (pendingChanges[iKey] !== undefined ? pendingChanges[iKey].value : p.instructor) instructor++
    })
    return { student, workStudy, instructor, total }
  }, [permissions, pendingChanges])

  const changeCount = Object.keys(pendingChanges).length

  function getPermValue(permId, role, original) {
    const key = permId + '_' + role
    if (pendingChanges[key] !== undefined) return pendingChanges[key].value
    return original
  }

  function handleToggle(permId, role, value) {
    const key = permId + '_' + role
    const perm = permissions.find(p => p.permission_id === permId)
    const colMap = { 'Student': 'student', 'Work Study': 'work_study', 'Instructor': 'instructor' }
    const originalValue = perm[colMap[role]]

    setPendingChanges(prev => {
      const next = { ...prev }
      if (value === originalValue) {
        delete next[key]
      } else {
        next[key] = { permissionId: permId, role, value, column: colMap[role] }
      }
      return next
    })
  }

  function discardChanges() {
    setPendingChanges({})
    showToast('Changes discarded', 'info')
  }

  async function saveAllChanges() {
    const updates = Object.values(pendingChanges)
    if (updates.length === 0) return

    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : 'Admin'

      // Group by permissionId
      const grouped = {}
      updates.forEach(u => {
        if (!grouped[u.permissionId]) grouped[u.permissionId] = {}
        grouped[u.permissionId][u.column] = u.value
      })

      let successCount = 0
      let failCount = 0
      let lastError = ''

      for (const [permId, changes] of Object.entries(grouped)) {
        // Only update the role columns that changed + metadata
        const updatePayload = { ...changes }
        
        // Try adding metadata columns — if they don't exist, Supabase will error,
        // so we'll retry without them
        let { error } = await supabase
          .from('permissions')
          .update({
            ...updatePayload,
            updated_at: new Date().toISOString(),
            updated_by: userName
          })
          .eq('permission_id', permId)

        // If error mentions column not found, retry without metadata
        if (error) {
          console.warn('Retrying without metadata columns:', error.message)
          const retry = await supabase
            .from('permissions')
            .update(updatePayload)
            .eq('permission_id', permId)
          error = retry.error
        }

        if (error) {
          console.error('Permission update error:', permId, error)
          lastError = error.message
          failCount++
        } else {
          successCount++
        }
      }

      if (failCount > 0) {
        showToast(`${successCount} saved, ${failCount} failed: ${lastError}`, 'error')
      } else {
        showToast(`Updated ${updates.length} permissions!`, 'success')
      }

      setPendingChanges({})
      loadPermissions()
    } catch (e) {
      showToast('Error saving: ' + e.message, 'error')
      console.error('Save error:', e)
    }
    setSaving(false)
  }

  // Initialize permissions table with defaults (only runs when DB is empty)
  async function initializePermissions() {
    if (arrayHasIssues) {
      showToast('Cannot initialize: DEFAULT_PERMISSIONS array has duplicates. Resolve them in code first.', 'error')
      return
    }
    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : 'Admin'
      const now = new Date().toISOString()

      const rows = DEFAULT_PERMISSIONS.map(([permId, page, feature, student, workStudy, instructor, description]) => ({
        permission_id: permId,
        page,
        feature,
        student,
        work_study: workStudy,
        instructor,
        description,
        updated_at: now,
        updated_by: userName
      }))

      // Plain insert — initialize is only called when DB is empty (needsSetup=true).
      // Using insert (not upsert) so any unexpected pre-existing row surfaces as an
      // error instead of being silently overwritten.
      const { error } = await supabase.from('permissions').insert(rows)
      if (error) throw error

      showToast(`Created ${rows.length} permissions!`, 'success')
      loadPermissions()
    } catch (e) {
      showToast('Error: ' + e.message, 'error')
    }
    setSaving(false)
  }

  // Add missing permissions — with ID-collision protection.
  //
  // OLD (buggy) behavior: used upsert with onConflict='permission_id'. When a new
  // page was added with a manually-picked ID that already belonged to a different
  // page in the DB (e.g. SOPs P120 vs Equipment Scheduling P120), upsert silently
  // overwrote the existing row, destroying the original page's permission data.
  //
  // NEW behavior: filter to truly missing (page, feature) rows as before, then
  // for each row check if its array-supplied permission_id is already taken in the
  // DB by a different (page, feature). If so, auto-assign the next available
  // P### ID and log the rename. Plain INSERT used so any unexpected error surfaces.
  async function syncMissing() {
    if (arrayHasIssues) {
      showToast('Cannot sync: DEFAULT_PERMISSIONS array has duplicates. Resolve them in code first.', 'error')
      return
    }
    setConfirmModal({
      title: 'Add Missing Permissions',
      message: 'This will add any missing permissions to the database. ID collisions with existing rows will be auto-resolved by assigning a new ID. Continue?',
      onConfirm: async () => {
        setConfirmModal(null)
        setSaving(true)
        try {
          const existingKeys = new Set(permissions.map(p => p.page + '|' + p.feature))
          const existingIds = new Set(permissions.map(p => p.permission_id))
          const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : 'Admin'
          const now = new Date().toISOString()

          // Find the highest existing P<number> so we can mint new IDs above the high-water mark
          let maxNum = 0
          permissions.forEach(p => {
            const m = p.permission_id?.match(/^P(\d+)$/)
            if (m) {
              const n = parseInt(m[1], 10)
              if (n > maxNum) maxNum = n
            }
          })

          const renamed = []
          const missing = []

          DEFAULT_PERMISSIONS
            .filter(([, page, feature]) => !existingKeys.has(page + '|' + feature))
            .forEach(([permId, page, feature, student, workStudy, instructor, description]) => {
              let finalId = permId
              if (existingIds.has(permId)) {
                // Collision: this ID already belongs to a different (page, feature).
                // Mint a fresh ID above the high-water mark.
                maxNum++
                finalId = 'P' + maxNum
                renamed.push({ from: permId, to: finalId, page, feature })
              }
              existingIds.add(finalId) // reserve so subsequent rows in this batch don't pick it
              missing.push({
                permission_id: finalId,
                page,
                feature,
                student,
                work_study: workStudy,
                instructor,
                description,
                updated_at: now,
                updated_by: userName
              })
            })

          if (missing.length === 0) {
            showToast('All permissions already exist!', 'success')
          } else {
            const { error } = await supabase.from('permissions').insert(missing)
            if (error) throw error

            if (renamed.length > 0) {
              console.warn('AccessPage: Auto-renamed permission IDs to avoid collisions:', renamed)
              showToast(`Added ${missing.length} permissions (${renamed.length} ID auto-renamed — see browser console)`, 'success')
            } else {
              showToast(`Added ${missing.length} missing permissions!`, 'success')
            }
            loadPermissions()
          }
        } catch (e) {
          showToast('Error: ' + e.message, 'error')
        }
        setSaving(false)
      }
    })
  }

  // Remove duplicates
  async function cleanupDuplicates() {
    setConfirmModal({
      title: 'Remove Duplicates',
      message: 'This will remove duplicate permissions (keeping the first occurrence). Continue?',
      onConfirm: async () => {
        setConfirmModal(null)
        setSaving(true)
        try {
          const seen = {}
          const toDelete = []
          permissions.forEach(p => {
            const key = p.page + '|' + p.feature
            if (seen[key]) {
              toDelete.push(p.permission_id)
            } else {
              seen[key] = true
            }
          })

          if (toDelete.length === 0) {
            showToast('No duplicates found!', 'success')
          } else {
            for (const id of toDelete) {
              await supabase.from('permissions').delete().eq('permission_id', id)
            }
            showToast(`Removed ${toDelete.length} duplicates!`, 'success')
            loadPermissions()
          }
        } catch (e) {
          showToast('Error: ' + e.message, 'error')
        }
        setSaving(false)
      }
    })
  }

  // Verify Integrity — read-only health check. Compares DEFAULT_PERMISSIONS to
  // current DB state and reports three failure modes:
  //   1. orphans: rows in DB with no matching (page, feature) in the array
  //   2. missing: rows in array with no matching (page, feature) in the DB
  //   3. idConflicts: same permission_id in array and DB but pointing at different (page, feature)
  // Run this any time you suspect drift after a manual SQL change or a bulk import.
  function verifyIntegrity() {
    try {
      const arrayKeyToId = new Map()
      const arrayIdToKey = new Map()
      DEFAULT_PERMISSIONS.forEach(([permId, page, feature]) => {
        arrayKeyToId.set(page + '|' + feature, permId)
        arrayIdToKey.set(permId, { page, feature })
      })

      const dbKeyToId = new Map()
      const dbIdToRow = new Map()
      permissions.forEach(p => {
        dbKeyToId.set(p.page + '|' + p.feature, p.permission_id)
        dbIdToRow.set(p.permission_id, { page: p.page, feature: p.feature })
      })

      const orphans = []
      const missing = []
      const idConflicts = []

      permissions.forEach(p => {
        if (!arrayKeyToId.has(p.page + '|' + p.feature)) {
          orphans.push({ id: p.permission_id, page: p.page, feature: p.feature })
        }
      })

      DEFAULT_PERMISSIONS.forEach(([permId, page, feature]) => {
        if (!dbKeyToId.has(page + '|' + feature)) {
          missing.push({ id: permId, page, feature })
        }
      })

      arrayIdToKey.forEach((arrRow, id) => {
        if (dbIdToRow.has(id)) {
          const dbRow = dbIdToRow.get(id)
          if (dbRow.page !== arrRow.page || dbRow.feature !== arrRow.feature) {
            idConflicts.push({
              id,
              db: `${dbRow.page} / ${dbRow.feature}`,
              array: `${arrRow.page} / ${arrRow.feature}`
            })
          }
        }
      })

      setIntegrityResult({ orphans, missing, idConflicts, checkedAt: new Date() })
    } catch (e) {
      showToast('Integrity check error: ' + e.message, 'error')
    }
  }

  // Export Seed SQL — generates an idempotent SQL script that fully re-creates
  // the current permissions table state. Save this to your repo as a recovery
  // artifact; if anything ever nukes the table again, this script restores it.
  function exportSeedSQL() {
    if (!permissions.length) {
      showToast('No permissions loaded to export.', 'error')
      return
    }
    const escape = (v) => {
      if (v == null) return 'NULL'
      return `'${String(v).replace(/'/g, "''")}'`
    }
    const sortedPerms = [...permissions].sort((a, b) => {
      if (a.page !== b.page) return a.page.localeCompare(b.page)
      return a.feature.localeCompare(b.feature)
    })
    const lines = []
    lines.push(`-- RICT CMMS Permissions Seed`)
    lines.push(`-- Generated: ${new Date().toISOString()}`)
    lines.push(`-- Source: AccessPage.jsx Export Seed SQL`)
    lines.push(`-- Row count: ${sortedPerms.length}`)
    lines.push(``)
    lines.push(`-- Recommended companion constraint (run once):`)
    lines.push(`-- ALTER TABLE permissions ADD CONSTRAINT permissions_page_feature_unique UNIQUE (page, feature);`)
    lines.push(``)
    lines.push(`INSERT INTO permissions (permission_id, page, feature, student, work_study, instructor, description, updated_at, updated_by) VALUES`)
    const valueLines = sortedPerms.map((p, i) => {
      const isLast = i === sortedPerms.length - 1
      return `  (${escape(p.permission_id)}, ${escape(p.page)}, ${escape(p.feature)}, ${p.student}, ${p.work_study}, ${p.instructor}, ${escape(p.description)}, now(), 'Seed')${isLast ? ';' : ','}`
    })
    lines.push(...valueLines)
    setSeedSQL(lines.join('\n'))
  }

  function copySeedToClipboard() {
    if (!seedSQL) return
    navigator.clipboard.writeText(seedSQL).then(
      () => showToast('Copied to clipboard!', 'success'),
      () => showToast('Copy failed — please select and copy manually.', 'error')
    )
  }

  function toggleSection(page) {
    setExpandedSections(prev => ({ ...prev, [page]: !prev[page] }))
  }

  function showToast(msg, type) {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // Access gate
  if (!isSuperAdmin) {
    return (
      <div className="access-page">
        <div className="access-denied" role="alert">
          <span className="material-icons" aria-hidden="true" style={{ fontSize: '5rem', color: '#fa5252', marginBottom: 20 }}>lock</span>
          <h2>Access Denied</h2>
          <p>Only the Super Admin can access the Access Control page.</p>
        </div>
        <style>{styles}</style>
      </div>
    )
  }

  const integrityClean = integrityResult
    && integrityResult.orphans.length === 0
    && integrityResult.missing.length === 0
    && integrityResult.idConflicts.length === 0

  return (
    <div className="access-page">
      {/* Toast (announced to screen readers via role) */}
      {toast && (
        <div
          className={`toast toast-${toast.type}`}
          role={toast.type === 'error' ? 'alert' : 'status'}
          aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="access-header">
        <div className="access-title">
          <span className="material-icons" aria-hidden="true">admin_panel_settings</span>
          Access Control
          <span className="super-badge">SUPER ADMIN</span>
        </div>
        <div className="access-actions">
          <button className="btn btn-secondary" onClick={loadPermissions} aria-label="Refresh permissions list">
            <span className="material-icons" aria-hidden="true">refresh</span>Refresh
          </button>
          <button className="btn btn-primary" onClick={syncMissing} disabled={arrayHasIssues} aria-label="Add any permissions missing from the database">
            <span className="material-icons" aria-hidden="true">sync</span>Add Missing
          </button>
          <button className="btn btn-secondary" onClick={verifyIntegrity} aria-label="Verify integrity of permissions data">
            <span className="material-icons" aria-hidden="true">fact_check</span>Verify
          </button>
          <button className="btn btn-secondary" onClick={exportSeedSQL} aria-label="Export current permissions as SQL seed script">
            <span className="material-icons" aria-hidden="true">file_download</span>Export Seed
          </button>
          <button className="btn btn-secondary" style={{ color: '#fa5252' }} onClick={cleanupDuplicates} aria-label="Remove duplicate permission rows from database">
            <span className="material-icons" aria-hidden="true">delete_sweep</span>Remove Duplicates
          </button>
        </div>
      </div>

      {/* Source-array validation banner — only renders when there's a code-level problem */}
      {arrayHasIssues && (
        <div className="validation-banner" role="alert">
          <span className="material-icons" aria-hidden="true">warning</span>
          <div>
            <div className="validation-title">DEFAULT_PERMISSIONS array has duplicates — bulk operations disabled</div>
            <div className="validation-body">
              {ARRAY_VALIDATION.duplicateIds.length > 0 && (
                <div>
                  <strong>Duplicate IDs:</strong>{' '}
                  {ARRAY_VALIDATION.duplicateIds.map(d =>
                    `${d.permission_id} (${d.occurrences.map(o => `${o.page}/${o.feature}`).join(', ')})`
                  ).join('; ')}
                </div>
              )}
              {ARRAY_VALIDATION.duplicateKeys.length > 0 && (
                <div>
                  <strong>Duplicate (page, feature):</strong>{' '}
                  {ARRAY_VALIDATION.duplicateKeys.map(d =>
                    `${d.page}/${d.feature} → ${d.ids.join(', ')}`
                  ).join('; ')}
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: '0.85em' }}>
                Fix DEFAULT_PERMISSIONS in AccessPage.jsx before running Add Missing or Initialize.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="stats-row" role="group" aria-label="Permission counts by role">
        <div className="stat-card student">
          <div className="stat-label">Student Permissions</div>
          <div className="stat-value" aria-live="polite">{stats.student}/{stats.total}</div>
        </div>
        <div className="stat-card workstudy">
          <div className="stat-label">Work Study Permissions</div>
          <div className="stat-value" aria-live="polite">{stats.workStudy}/{stats.total}</div>
        </div>
        <div className="stat-card instructor">
          <div className="stat-label">Instructor Permissions</div>
          <div className="stat-value" aria-live="polite">{stats.instructor}/{stats.total}</div>
        </div>
      </div>

      {/* Content */}
      <div id="permissions-content">
        {loading ? (
          <div className="loading-state" role="status">Loading permissions...</div>
        ) : needsSetup ? (
          <div className="setup-prompt">
            <span className="material-icons setup-icon" aria-hidden="true">settings_suggest</span>
            <div className="setup-title">Setup Required</div>
            <div className="setup-text">No permissions found. Click below to create the default permissions.</div>
            <button className="btn btn-primary" onClick={initializePermissions} disabled={saving || arrayHasIssues}>
              {saving ? 'Creating...' : 'Create Permissions'}
            </button>
          </div>
        ) : (
          Object.entries(groupedPermissions).map(([pageName, perms]) => {
            const icon = PAGE_ICONS[pageName] || 'folder'
            const isExpanded = !!expandedSections[pageName]
            const sectionId = `perm-section-${pageName.replace(/\s+/g, '-').toLowerCase()}`

            return (
              <div key={pageName} className="page-section">
                {/* Page header — now a real button so keyboard / screen-reader users can expand */}
                <button
                  type="button"
                  className="page-header"
                  onClick={() => toggleSection(pageName)}
                  aria-expanded={isExpanded}
                  aria-controls={sectionId}
                >
                  <div className="page-header-left">
                    <div className="page-icon">
                      <span className="material-icons" aria-hidden="true">{icon}</span>
                    </div>
                    <div>
                      <div className="page-name">{pageName}</div>
                      <div className="page-count">{perms.length} permissions</div>
                    </div>
                  </div>
                  <span
                    className={`material-icons collapse-icon${isExpanded ? '' : ' collapsed'}`}
                    aria-hidden="true"
                  >expand_more</span>
                </button>

                <div
                  id={sectionId}
                  className={`page-content${isExpanded ? ' expanded' : ''}`}
                  role="region"
                  aria-label={`${pageName} permissions`}
                >
                  <table className="permission-table">
                    <thead>
                      <tr>
                        <th>Feature</th>
                        <th className="role-col">Student</th>
                        <th className="role-col">Work Study</th>
                        <th className="role-col">Instructor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perms.map(p => (
                        <tr key={p.permission_id}>
                          <td>
                            <div className="feature-name">{formatFeature(p.feature)}</div>
                            <div className="feature-desc">{p.description}</div>
                          </td>
                          <td className="role-col">
                            <label className="toggle-switch student">
                              <input
                                type="checkbox"
                                checked={getPermValue(p.permission_id, 'Student', p.student)}
                                onChange={e => handleToggle(p.permission_id, 'Student', e.target.checked)}
                                aria-label={`Student access to ${formatFeature(p.feature)} on ${pageName}`}
                              />
                              <span className="toggle-slider" />
                            </label>
                          </td>
                          <td className="role-col">
                            <label className="toggle-switch workstudy">
                              <input
                                type="checkbox"
                                checked={getPermValue(p.permission_id, 'Work Study', p.work_study)}
                                onChange={e => handleToggle(p.permission_id, 'Work Study', e.target.checked)}
                                aria-label={`Work Study access to ${formatFeature(p.feature)} on ${pageName}`}
                              />
                              <span className="toggle-slider" />
                            </label>
                          </td>
                          <td className="role-col">
                            <label className="toggle-switch instructor">
                              <input
                                type="checkbox"
                                checked={getPermValue(p.permission_id, 'Instructor', p.instructor)}
                                onChange={e => handleToggle(p.permission_id, 'Instructor', e.target.checked)}
                                aria-label={`Instructor access to ${formatFeature(p.feature)} on ${pageName}`}
                              />
                              <span className="toggle-slider" />
                            </label>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Changes bar */}
      {changeCount > 0 && (
        <div className="changes-bar" role="region" aria-label="Unsaved changes">
          <div>
            You have unsaved changes
            <span className="changes-count" aria-live="polite">{changeCount}</span>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-secondary" onClick={discardChanges}>Discard</button>
            <button className="btn btn-success" onClick={saveAllChanges} disabled={saving}>
              <span className="material-icons" aria-hidden="true">save</span>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <div
          className="modal-overlay visible"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
          onClick={e => e.target === e.currentTarget && setConfirmModal(null)}
        >
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h3 id="confirm-modal-title">{confirmModal.title}</h3>
              <button className="modal-close" onClick={() => setConfirmModal(null)} aria-label="Close dialog">&times;</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span className="material-icons" aria-hidden="true" style={{ fontSize: 48, color: '#fab005' }}>help_outline</span>
                <p style={{ margin: 0, fontSize: '1rem', color: '#495057' }}>{confirmModal.message}</p>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setConfirmModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmModal.onConfirm} autoFocus>Continue</button>
            </div>
          </div>
        </div>
      )}

      {/* Integrity Result Modal */}
      {integrityResult && (
        <div
          className="modal-overlay visible"
          role="dialog"
          aria-modal="true"
          aria-labelledby="integrity-modal-title"
          onClick={e => e.target === e.currentTarget && setIntegrityResult(null)}
        >
          <div className="modal" style={{ maxWidth: 700, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h3 id="integrity-modal-title">
                {integrityClean ? '✓ Integrity Check: Clean' : 'Integrity Check Results'}
              </h3>
              <button className="modal-close" onClick={() => setIntegrityResult(null)} aria-label="Close dialog">&times;</button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              {integrityClean ? (
                <p style={{ color: '#2b8a3e' }}>
                  All {permissions.length} database rows match DEFAULT_PERMISSIONS. No drift detected.
                </p>
              ) : (
                <>
                  {integrityResult.idConflicts.length > 0 && (
                    <section style={{ marginBottom: 20 }}>
                      <h4 style={{ color: '#c92a2a', marginBottom: 8 }}>
                        ⚠ ID Conflicts ({integrityResult.idConflicts.length})
                      </h4>
                      <p style={{ fontSize: '0.85rem', color: '#868e96', margin: '0 0 8px' }}>
                        Same permission_id maps to different (page, feature) in array vs DB. Most serious — indicates an array entry has been overwritten.
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.85rem' }}>
                        {integrityResult.idConflicts.map(c => (
                          <li key={c.id}><strong>{c.id}</strong>: array says <em>{c.array}</em>, DB has <em>{c.db}</em></li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {integrityResult.missing.length > 0 && (
                    <section style={{ marginBottom: 20 }}>
                      <h4 style={{ color: '#fab005', marginBottom: 8 }}>
                        Missing in DB ({integrityResult.missing.length})
                      </h4>
                      <p style={{ fontSize: '0.85rem', color: '#868e96', margin: '0 0 8px' }}>
                        In DEFAULT_PERMISSIONS but not in DB. Run "Add Missing" to add them.
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.85rem' }}>
                        {integrityResult.missing.map(m => (
                          <li key={`${m.page}-${m.feature}`}><strong>{m.id}</strong> {m.page} / {m.feature}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {integrityResult.orphans.length > 0 && (
                    <section style={{ marginBottom: 20 }}>
                      <h4 style={{ color: '#228be6', marginBottom: 8 }}>
                        Orphans in DB ({integrityResult.orphans.length})
                      </h4>
                      <p style={{ fontSize: '0.85rem', color: '#868e96', margin: '0 0 8px' }}>
                        In DB but not in DEFAULT_PERMISSIONS. Either add to the array or remove from DB. Safe to keep.
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.85rem' }}>
                        {integrityResult.orphans.map(o => (
                          <li key={o.id}><strong>{o.id}</strong> {o.page} / {o.feature}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setIntegrityResult(null)} autoFocus>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Seed SQL Modal */}
      {seedSQL && (
        <div
          className="modal-overlay visible"
          role="dialog"
          aria-modal="true"
          aria-labelledby="seed-modal-title"
          onClick={e => e.target === e.currentTarget && setSeedSQL(null)}
        >
          <div className="modal" style={{ maxWidth: 800, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h3 id="seed-modal-title">Permissions Seed SQL</h3>
              <button className="modal-close" onClick={() => setSeedSQL(null)} aria-label="Close dialog">&times;</button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              <p style={{ fontSize: '0.85rem', color: '#495057', margin: '0 0 12px' }}>
                Save this SQL as a recovery artifact (e.g. <code>supabase/migrations/permissions_seed.sql</code>).
                If the permissions table is ever wiped, run this script in the SQL Editor to restore.
              </p>
              <textarea
                readOnly
                value={seedSQL}
                aria-label="Generated SQL seed script"
                style={{
                  width: '100%',
                  minHeight: 320,
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  border: '1px solid #dee2e6',
                  borderRadius: 8,
                  padding: 12,
                  resize: 'vertical',
                  background: '#f8f9fa',
                }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSeedSQL(null)}>Close</button>
              <button className="btn btn-primary" onClick={copySeedToClipboard} autoFocus>
                <span className="material-icons" aria-hidden="true">content_copy</span>Copy to Clipboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Saving overlay */}
      {saving && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.8)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}
          role="status"
          aria-live="polite"
          aria-label="Processing"
        >
          <div className="spinner" aria-hidden="true" />
          <div style={{ color: '#495057', fontWeight: 500 }}>Processing...</div>
        </div>
      )}

      <style>{styles}</style>
    </div>
  )
}

const styles = `
  .access-page { max-width: 1400px; margin: 0 auto; position: relative; padding-bottom: 80px; }
  .access-denied { text-align: center; padding: 80px 20px; }
  .access-denied h2 { color: #1a1a2e; margin-bottom: 12px; }
  .access-denied p { color: #868e96; }

  .access-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }
  .access-title { font-size: 1.5rem; font-weight: 700; color: #1a1a2e; display: flex; align-items: center; gap: 12px; }
  .access-title .material-icons { color: #fa5252; font-size: 2rem; }
  .super-badge { background: linear-gradient(135deg, #fa5252, #e03131); color: white; padding: 4px 12px; border-radius: 16px; font-size: 0.75rem; font-weight: 600; }
  .access-actions { display: flex; gap: 12px; flex-wrap: wrap; }

  .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 8px; transition: background 0.2s; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn:focus-visible { outline: 2px solid #228be6; outline-offset: 2px; }
  .btn .material-icons { font-size: 1.1rem; }
  .btn-primary { background: #228be6; color: white; }
  .btn-primary:hover:not(:disabled) { background: #1971c2; }
  .btn-success { background: #40c057; color: white; }
  .btn-success:hover:not(:disabled) { background: #2f9e44; }
  .btn-secondary { background: #f1f3f5; color: #495057; border: 1px solid #dee2e6; }
  .btn-secondary:hover:not(:disabled) { background: #e9ecef; }

  .validation-banner { display: flex; gap: 14px; align-items: flex-start; background: #fff5f5; border: 1px solid #ffc9c9; border-left: 4px solid #fa5252; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; color: #862e2e; }
  .validation-banner .material-icons { color: #fa5252; font-size: 1.5rem; flex-shrink: 0; }
  .validation-title { font-weight: 600; margin-bottom: 6px; color: #862e2e; }
  .validation-body { font-size: 0.85rem; line-height: 1.5; }
  .validation-body code { background: #ffe3e3; padding: 1px 4px; border-radius: 3px; font-size: 0.8rem; }

  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .stat-card.student { border-left: 4px solid #fab005; }
  .stat-card.workstudy { border-left: 4px solid #228be6; }
  .stat-card.instructor { border-left: 4px solid #40c057; }
  .stat-label { font-size: 0.8rem; color: #868e96; margin-bottom: 4px; }
  .stat-value { font-size: 1.75rem; font-weight: 700; color: #1a1a2e; }

  .page-section { background: white; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; }
  /* Header is now a <button>; reset native button styling */
  .page-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: #f8f9fa; cursor: pointer; user-select: none; width: 100%; border: none; text-align: left; font: inherit; color: inherit; }
  .page-header:hover { background: #f1f3f5; }
  .page-header:focus-visible { outline: 2px solid #228be6; outline-offset: -2px; }
  .page-header-left { display: flex; align-items: center; gap: 12px; }
  .page-icon { width: 40px; height: 40px; background: #228be6; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; }
  .page-icon .material-icons { font-size: 1.2rem; }
  .page-name { font-weight: 600; font-size: 1rem; color: #1a1a2e; }
  .page-count { font-size: 0.8rem; color: #868e96; }
  .collapse-icon { color: #868e96; transition: transform 0.3s; }
  .collapse-icon.collapsed { transform: rotate(-90deg); }

  .page-content { max-height: 0; overflow: hidden; transition: max-height 0.4s ease-out; }
  .page-content.expanded { max-height: 2000px; }

  .permission-table { width: 100%; border-collapse: collapse; }
  .permission-table th { text-align: left; padding: 12px 20px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: #868e96; background: #f8f9fa; }
  .permission-table th.role-col { text-align: center; width: 110px; }
  .permission-table td { padding: 12px 20px; border-bottom: 1px solid #f1f3f5; }
  .permission-table tr:hover { background: #f8f9fa; }
  .permission-table td.role-col { text-align: center; }
  .feature-name { font-weight: 500; color: #1a1a2e; }
  .feature-desc { font-size: 0.8rem; color: #868e96; margin-top: 2px; }

  .toggle-switch { position: relative; width: 44px; height: 24px; display: inline-block; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-switch input:focus-visible + .toggle-slider { box-shadow: 0 0 0 3px rgba(34,139,230,0.4); }
  .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #dee2e6; border-radius: 24px; transition: 0.3s; }
  .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
  .toggle-switch input:checked + .toggle-slider { background: #40c057; }
  .toggle-switch input:checked + .toggle-slider:before { transform: translateX(20px); }
  .toggle-switch.student input:checked + .toggle-slider { background: #fab005; }
  .toggle-switch.workstudy input:checked + .toggle-slider { background: #228be6; }
  .toggle-switch.instructor input:checked + .toggle-slider { background: #40c057; }

  .loading-state { text-align: center; padding: 60px 20px; color: #868e96; }
  .setup-prompt { text-align: center; padding: 60px 20px; }
  .setup-icon { font-size: 4rem !important; color: #fab005; margin-bottom: 20px; display: block; }
  .setup-title { font-size: 1.5rem; font-weight: 600; margin-bottom: 12px; }
  .setup-text { color: #868e96; margin-bottom: 24px; }

  .changes-bar { position: fixed; bottom: 0; left: 260px; right: 0; background: #1a1a2e; color: white; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; z-index: 100; animation: slideUp 0.3s ease; }
  .changes-count { background: #fab005; color: #1a1a2e; padding: 4px 12px; border-radius: 12px; font-weight: 600; margin-left: 12px; }

  .toast { position: fixed; top: 20px; right: 20px; padding: 12px 24px; border-radius: 8px; color: white; font-weight: 500; z-index: 3000; animation: slideIn 0.3s ease; max-width: 480px; }
  .toast-success { background: #40c057; }
  .toast-error { background: #fa5252; }
  .toast-info { background: #228be6; }

  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2000; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal-overlay.visible { display: flex; }
  .modal { background: white; border-radius: 16px; width: 90%; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-bottom: 1px solid #e9ecef; }
  .modal-header h3 { font-size: 1.1rem; font-weight: 600; margin: 0; }
  .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; padding: 4px 8px; }
  .modal-close:hover { color: #495057; }
  .modal-close:focus-visible { outline: 2px solid #228be6; outline-offset: 2px; border-radius: 4px; }
  .modal-body { padding: 24px; }
  .modal-footer { padding: 16px 24px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; }

  .spinner { width: 40px; height: 40px; border: 4px solid #e9ecef; border-top-color: #228be6; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  @media (max-width: 768px) {
    .access-header { flex-direction: column; align-items: flex-start; }
    .access-actions { width: 100%; }
    .access-actions .btn { flex: 1; justify-content: center; font-size: 0.8rem; padding: 8px 12px; }
    .changes-bar { left: 0; }
    .permission-table th.role-col,
    .permission-table td.role-col { width: 70px; padding: 8px; }
  }
`
