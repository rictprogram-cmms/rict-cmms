/**
 * RICT CMMS — Settings Page (rewritten for visual consistency + auto-save)
 *
 * Major changes from previous version:
 *   • Unified card pattern (settings.css) — no more inline style={{}} blocks
 *   • Status pills + left-border accents replace full-width colored banners
 *   • Auto-save with 800ms debounce + per-field "✓ Saved" indicator
 *   • Expanded "Show details" disclosures on every setting
 *   • Find-a-setting search box at top of page (cross-tab jump)
 *   • Tab bar groups: Operations | Lookups | Academic
 *   • WCAG 2.1 AA throughout: <label htmlFor>, aria-pressed, aria-live, focus rings
 *   • Confirmation modals use the shared useDialogA11y hook
 *
 * Functional preservation (verified):
 *   • Lab Access Mode confirm-then-toggle + audit log + PM auto-pause sync
 *   • Instructor Away Mode toggle + return time + audit log
 *   • Dashboard defaults (Day View, Temp Access)
 *   • Weekly Labs reminder textarea
 *   • WOC Ratio 7-knob editor + reset-to-default
 *   • General settings auto-grouping by category (with skip list)
 *   • lab_visible_days custom day picker
 *   • All 5 CRUD lookup-table sections
 *   • Classes section: form + week preview + enrollment modal + duplicate modal
 *   • Realtime sync, audit log, permissions guard
 *
 * File: src/pages/SettingsPage.jsx
 */

import { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef, useId, Fragment } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { supabase } from '@/lib/supabase'
import {
  useSettings, useSettingsActions, useCategories, useCategoryActions,
  useAssetLocations, useAssetLocationActions, useInventoryLocations, useInventoryLocationActions,
  useVendorsList, useVendorActions, useWOStatuses, useWOStatusActions,
  useClasses, useClassActions,
  useWeeklyReminders, useWeeklyReminderActions,
  useStudentsInClass,
} from '@/hooks/useSettings'
import {
  Settings, Save, Plus, Trash2, Edit3, X, Loader2, CheckCircle2,
  Tag, MapPin, Box, Truck, ClipboardList, GraduationCap, Sliders,
  Users, Calendar, Clock, BookOpen, ChevronRight, Search, UserPlus, UserCircle,
  AlertCircle, RotateCcw, Copy, EyeOff, Eye, MoonStar, Sun, AlertTriangle,
  LayoutDashboard, FlaskConical, MessageSquare, Target, Info, Check,
  History, Globe, FileSearch, Archive, ArchiveRestore,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import WeeklyReminderHistoryModal from '@/components/WeeklyReminderHistoryModal'
import toast from 'react-hot-toast'

// ═══════════════════════════════════════════════════════════════════════════════
// SETTING METADATA — every visible setting gets a label, helper text, type, and
// optional richer "details" block surfaced via a <details> disclosure.
// ═══════════════════════════════════════════════════════════════════════════════

const SETTING_META = {
  // ── Work Orders ──
  priority_low_days: {
    label: 'Low Priority — Default Due Days',
    type: 'number', category: 'Work Orders',
    desc: 'How many days a Low priority work order is due in by default.',
    details: {
      what: 'Sets the default due date offset (days from creation) for new Low priority work orders.',
      where: 'Used when creating a new Work Order on the Work Orders page or when a request is approved.',
      effect: 'Larger values give more lead time. Typical values: 7 to 14 days.',
    },
  },
  priority_medium_days: {
    label: 'Medium Priority — Default Due Days',
    type: 'number', category: 'Work Orders',
    desc: 'How many days a Medium priority work order is due in by default.',
    details: {
      what: 'Sets the default due date offset (days from creation) for new Medium priority work orders.',
      where: 'Used when creating a new Work Order on the Work Orders page or when a request is approved.',
      effect: 'Typical values: 3 to 7 days.',
    },
  },
  priority_high_days: {
    label: 'High Priority — Default Due Days',
    type: 'number', category: 'Work Orders',
    desc: 'How many days a High priority work order is due in by default.',
    details: {
      what: 'Sets the default due date offset (days from creation) for new High priority work orders.',
      where: 'Used when creating a new Work Order on the Work Orders page or when a request is approved.',
      effect: 'Typical values: 1 to 3 days. High priority should be tight.',
    },
  },
  time_increment: {
    label: 'Work Log Time Increment (minutes)',
    type: 'number', category: 'Work Orders',
    desc: 'Step size for the minutes selector when adding a work log entry.',
    details: {
      what: 'Controls the granularity of the minutes dropdown when logging time on a Work Order.',
      where: 'Work Order detail modal → "Add Work Log" form.',
      effect: 'Smaller values (5, 10) give finer control. Larger values (15, 30) make logging faster.',
    },
  },
  default_work_time: {
    label: 'Default Work Log Time (minutes)',
    type: 'number', category: 'Work Orders',
    desc: 'Time pre-filled when adding a new work log entry.',
    details: {
      what: 'Pre-populates the minutes field when opening the work log form on a Work Order.',
      where: 'Work Order detail modal → "Add Work Log" form.',
      effect: 'Set to your most common log duration to reduce typing.',
    },
  },

  // ── Notifications ──
  // Note: notification_email was retired in the audit pass — outbound emails
  // are addressed per-user (the Edge Function reads `to` from the request
  // payload, not from a global setting).
  notif_poll_interval: {
    label: 'Notification Poll Interval (seconds)',
    type: 'number', category: 'Notifications',
    desc: 'How often the bell icon checks for new notifications. 0 disables polling.',
    details: {
      what: 'Polling cadence for the in-app notification bell.',
      where: 'NotificationBell component (top-right of every page).',
      effect: 'Realtime is primary; polling is a backup. 30 is a good default. 0 turns it off entirely.',
    },
  },

  // ── Printing ──
  label_width_inches: {
    label: 'Label Width (inches)',
    type: 'number', category: 'Printing',
    desc: 'Physical label width for the Zebra ZT230 printer.',
    details: {
      what: 'Width dimension passed to the asset and inventory label print templates.',
      where: 'Asset/inventory label printing routines (Inventory → Print Labels, Assets → Print Labels).',
      effect: 'Must match the actual labels loaded in the printer or output will be cropped. The QR code, image area, and text sizes inside each label scale proportionally — change the outer dimensions and the inner layout adapts automatically.',
    },
  },
  label_height_inches: {
    label: 'Label Height (inches)',
    type: 'number', category: 'Printing',
    desc: 'Physical label height for the Zebra ZT230 printer.',
    details: {
      what: 'Height dimension passed to the asset and inventory label print templates.',
      where: 'Asset/inventory label printing routines (Inventory → Print Labels, Assets → Print Labels).',
      effect: 'Must match the actual labels loaded in the printer or output will be cropped. The QR code, image area, and text sizes inside each label scale proportionally — change the outer dimensions and the inner layout adapts automatically.',
    },
  },

  // ── Metrics (TV display) ──
  // Note: metrics_start_hour / metrics_end_hour / metrics_refresh_interval
  // were retired in the audit pass. They were a holdover from the pre-Supabase
  // era when the TV Display had to throttle polling. With realtime updates
  // these are no longer needed — TVDisplayPage.jsx uses fixed intervals plus
  // a midnight auto-refresh and reacts to realtime changes directly.

  // ── Lab Signup ──
  lab_visible_days: {
    label: 'Lab Open Days',
    type: 'custom', category: 'Lab Signup',
    desc: 'Days of the week the lab accepts signups.',
    details: {
      what: 'Controls which weekdays show up as bookable on the Lab Signup page.',
      where: 'Lab Signup page (week grid columns).',
      effect: 'Closed days are hidden entirely from the signup grid. Sun=0, Mon=1, …, Sat=6.',
    },
  },
  lab_weeks_to_display: {
    label: 'Lab Signup — Weeks to Show',
    type: 'number', category: 'Lab Signup',
    desc: 'Number of upcoming weeks displayed on the Lab Signup page.',
    details: {
      what: 'How many forward weeks the Lab Signup grid renders.',
      where: 'Lab Signup page.',
      effect: '2 is the default. More weeks = more rows and slower load.',
    },
  },

  // ── Volunteer ──
  volunteer_semester_total_hours: {
    label: 'Volunteer Hours — Semester Total',
    type: 'number', category: 'Volunteer',
    desc: 'Total volunteer hours required per student per semester.',
    details: {
      what: 'Target total used to compute the volunteer-hours progress bar.',
      where: 'Volunteer Hours page (per-student progress tracker).',
      effect: 'Set to the program-wide expectation. Affects display only — does not block submission.',
    },
  },
  volunteer_midpoint_hours: {
    label: 'Volunteer Hours — Midpoint Target',
    type: 'number', category: 'Volunteer',
    desc: 'Hours expected by the midpoint week of the semester.',
    details: {
      what: 'Pace target used to flag "behind schedule" students at midterm.',
      where: 'Volunteer Hours page (midpoint banner).',
      effect: 'Typically 50% of semester total, but can be skewed early/late depending on program flow.',
    },
  },
  volunteer_midpoint_week: {
    label: 'Volunteer Hours — Midpoint Week',
    type: 'number', category: 'Volunteer',
    desc: 'Week number when the midpoint check applies.',
    details: {
      what: 'Week index that triggers the midpoint progress comparison.',
      where: 'Volunteer Hours page (midpoint banner).',
      effect: 'For a 16-week semester, week 8 is typical.',
    },
  },
  // Note: volunteer_semester_start / volunteer_semester_end / volunteer_current_semester
  // were retired in the audit pass. The Volunteer Hours page (and the time-card
  // grade-book report) now auto-derive the volunteer window from active class
  // start/end dates, falling back to the current calendar year. No global
  // semester-window override is exposed here anymore.

  // ── Time Clock ──
  grace_period_minutes: {
    label: 'Time Clock — Grace Period (minutes)',
    type: 'number', category: 'Time Clock',
    desc: 'Buffer before a student is flagged as late or leaving early.',
    details: {
      what: 'Allowed slop on either side of the scheduled punch-in / punch-out time.',
      where: 'Time Clock kiosk + Attendance Reports.',
      effect: '5–10 minutes is typical. Higher values reduce nag without really hiding chronic lateness.',
    },
  },

  // ── System ──
  app_version: {
    label: 'App Version',
    type: 'text', category: 'System',
    desc: 'Current application version string.',
    details: {
      what: 'Display-only version label.',
      where: 'Sidebar header.',
      effect: 'Update on each release; cosmetic only.',
    },
  },
  session_timeout_hours: {
    label: 'Session Timeout (hours)',
    type: 'number', category: 'System',
    desc: 'Hours before users are auto-logged out. 0 disables timeout entirely.',
    details: {
      what: 'Idle session lifetime — when exceeded the user is forced to re-authenticate.',
      where: 'AuthContext (applies to every page).',
      effect: '0 = no timeout (sessions never expire). 8–12 hours is typical for a workstation.',
    },
  },
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD-TAB SETTINGS DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const DASHBOARD_SETTINGS = [
  {
    key: 'dashboard_day_view_expanded',
    label: 'Day View — Default State',
    desc: 'Whether the Day View card starts expanded when the instructor opens the dashboard.',
    details: {
      what: 'Initial open/closed state for the Day View attendance card on the dashboard.',
      where: 'Instructor Dashboard.',
      effect: 'Once an instructor manually expands or collapses, their per-device choice overrides this default.',
    },
  },
  {
    key: 'dashboard_temp_access_expanded',
    label: 'Active Temp Access — Default State',
    desc: 'Whether the Active Temp Access card starts expanded.',
    details: {
      what: 'Initial open/closed state for the Active Temp Access card on the dashboard.',
      where: 'Instructor Dashboard.',
      effect: 'Once an instructor manually expands or collapses, their per-device choice overrides this default.',
    },
  },
]

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATION (WOC RATIO) SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

const EVAL_SETTINGS = [
  {
    key: 'woc_activity_hours_per_week_student',
    label: 'Student — Hours/Week Threshold',
    desc: 'Expected work-log hours per school week to reach a 1.00× activity factor (Student role).',
    default: '1.5',
    min: '0', step: '0.1', suffix: 'hr/week',
    details: {
      what: 'The hours-per-week target that yields a full activity multiplier for students.',
      where: 'WOC Ratio scoring engine — applied to all Student-role users.',
      effect: 'Students with fewer logged hours get a proportionally lower activity factor. Higher = harder.',
    },
  },
  {
    key: 'woc_activity_hours_per_week_workstudy',
    label: 'Work Study — Hours/Week Threshold',
    desc: 'Expected work-log hours per school week to reach a 1.00× activity factor (Work Study role).',
    default: '5.0',
    min: '0', step: '0.5', suffix: 'hr/week',
    details: {
      what: 'The hours-per-week target that yields a full activity multiplier for Work Study users.',
      where: 'WOC Ratio scoring engine — applied to all Work Study-role users.',
      effect: 'Higher than the Student threshold because work-study students owe more lab time.',
    },
  },
  {
    key: 'woc_early_pct_per_day',
    label: 'Early Completion Rate',
    desc: 'Percentage points awarded per school day a WO was closed before its due date.',
    default: '0.5',
    min: '0', step: '0.1', suffix: '% per day',
    details: {
      what: 'Reward rate for closing work orders ahead of schedule, multiplied by the user\u2019s share of the WO\u2019s logged hours.',
      where: 'WOC Ratio scoring engine — applied per closed WO.',
      effect: 'Higher values incentivize aggressive early completion. Reward is capped per WO (see Max Bonus).',
    },
  },
  {
    key: 'woc_max_bonus_per_wo',
    label: 'Max Bonus Per WO',
    desc: 'Hard cap on the early-completion bonus from a single WO.',
    default: '10',
    min: '0', step: '1', suffix: '%',
    details: {
      what: 'Prevents a single early-closed WO from dominating a user\u2019s score.',
      where: 'WOC Ratio scoring engine.',
      effect: 'Lower values flatten outlier rewards. 10% is a balanced default.',
    },
  },
  {
    key: 'woc_closer_ack_bonus_pct',
    label: 'Closer Acknowledgment Bonus',
    desc: 'Flat percentage added when a user clicks Close on an early-completed WO they\u2019ve worked on.',
    default: '2',
    min: '0', step: '0.5', suffix: '%',
    details: {
      what: 'Reward for the user who actually performs the close action on an early-finished WO.',
      where: 'WOC Ratio scoring engine.',
      effect: 'Encourages students to take responsibility for closing out finished work.',
    },
  },
  {
    key: 'woc_min_closer_hours_for_ack',
    label: 'Minimum Hours for Closer Bonus',
    desc: 'Hours threshold to qualify for the closer acknowledgment bonus.',
    default: '0.25',
    min: '0', step: '0.05', suffix: 'hr',
    details: {
      what: 'Ensures someone who only logged a token amount of work cannot claim the closer bonus.',
      where: 'WOC Ratio scoring engine.',
      effect: 'Prevents drive-by closes from scoring. 0.25 hr (15 min) is the default minimum.',
    },
  },
  {
    key: 'woc_stale_threshold_days',
    label: 'Stale WO Threshold',
    desc: 'School days an open WO can sit without an update before the stale penalty starts.',
    default: '4',
    min: '1', step: '1', suffix: 'days',
    details: {
      what: 'Inactivity grace window before \u22121% per day starts accruing on an open WO.',
      where: 'WOC Ratio scoring engine — applied to open WOs the user is assigned to.',
      effect: 'Lower values are stricter. The penalty stops once the WO sees an update or is closed.',
    },
  },
]

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY ICONS (for the General settings auto-grouping)
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORY_ICONS = {
  'Work Orders':   ClipboardList,
  'Notifications': AlertCircle,
  'Printing':      Tag,
  'Metrics':       Clock,
  'Lab Signup':    BookOpen,
  'Volunteer':     Users,
  'System':        Settings,
  'Storage':       Box,
  'General':       Sliders,
  'Time Clock':    Clock,
  'Evaluation':    Target,
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG SETTINGS METADATA
// Numeric audit-log settings managed by AuditLogSettings tab.
// (audit_track_view_entities, audit_failed_count, and purge are handled as
// special cases inside the component since they're not simple number inputs.)
// ═══════════════════════════════════════════════════════════════════════════════

const AUDIT_SETTINGS = [
  {
    key: 'audit_retention_days',
    label: 'Retention Period',
    desc: 'How many days to keep audit log entries before they become eligible for purge.',
    default: '730',
    min: '0', step: '1', suffix: 'days',
    details: {
      what: 'Maximum age of audit log entries the purge button considers. 0 means never purge.',
      where: 'Used by the audit_log_purge() RPC when the Purge Now button is pressed.',
      effect: 'Lower values reclaim storage faster. Default 730 = ~2 years. Purge has a hard minimum of 30 days.',
    },
  },
  {
    key: 'audit_suspicious_deletes_threshold',
    label: 'Delete Burst — Threshold',
    desc: 'How many Delete actions by the same user trigger a suspicious-activity flag.',
    default: '5',
    min: '2', step: '1', suffix: 'deletes',
    details: {
      what: 'Number of Delete actions detected as a burst when they fall inside the time window.',
      where: 'Audit Log page — suspicious activity banner at the top.',
      effect: 'Lower = more sensitive. Default catches 5 deletes in 60 minutes.',
    },
  },
  {
    key: 'audit_suspicious_deletes_minutes',
    label: 'Delete Burst — Window',
    desc: 'Time window in minutes for the Delete burst detector.',
    default: '60',
    min: '1', step: '1', suffix: 'minutes',
    details: {
      what: 'Sliding window over which Delete actions are counted.',
      where: 'Audit Log page — suspicious activity banner.',
      effect: 'Larger window catches slower bursts. Default 60 minutes.',
    },
  },
  {
    key: 'audit_suspicious_updates_threshold',
    label: 'Update Burst — Threshold',
    desc: 'How many Update actions by the same user trigger a suspicious-activity flag.',
    default: '20',
    min: '2', step: '1', suffix: 'updates',
    details: {
      what: 'Number of Update actions detected as a burst when they fall inside the time window.',
      where: 'Audit Log page — suspicious activity banner.',
      effect: 'Lower = more sensitive. Default catches 20 updates in 5 minutes.',
    },
  },
  {
    key: 'audit_suspicious_updates_minutes',
    label: 'Update Burst — Window',
    desc: 'Time window in minutes for the Update burst detector.',
    default: '5',
    min: '1', step: '1', suffix: 'minutes',
    details: {
      what: 'Sliding window over which Update actions are counted.',
      where: 'Audit Log page — suspicious activity banner.',
      effect: 'Larger window catches slower bursts. Default 5 minutes.',
    },
  },
]

// ═══════════════════════════════════════════════════════════════════════════════
// FIND-A-SETTING REGISTRY (search index across all tabs)
// ═══════════════════════════════════════════════════════════════════════════════

const TAB_LABELS = {
  general: 'General',
  dashboard: 'Dashboard',
  weekly_labs: 'Weekly Labs',
  evaluation: 'WOC Ratio',
  audit: 'Audit Log',
  categories: 'Categories',
  asset_locations: 'Asset Locations',
  inv_locations: 'Inventory Locations',
  vendors: 'Vendors',
  wo_statuses: 'WO Statuses',
  classes: 'Classes',
}

function buildRegistry() {
  const reg = []

  // Critical mode toggles (top of General tab)
  reg.push({ key: 'lab_access_mode', tab: 'general', label: 'Lab Access Mode', desc: 'In Session / Summer Break — locks out students during breaks', aliases: 'summer break shutdown students lockout closed' })
  reg.push({ key: 'instructor_away_mode', tab: 'general', label: 'Instructor Away Mode', desc: 'In-meeting toggle — students see "away" notice on help requests', aliases: 'meeting away help return available' })
  reg.push({ key: 'instructor_return_time', tab: 'general', label: 'Expected Return Time', desc: 'Time shown to students when you are away', aliases: 'meeting return time clock' })

  // SETTING_META → registry
  Object.entries(SETTING_META).forEach(([key, m]) => {
    reg.push({ key, tab: 'general', label: m.label, desc: m.desc, aliases: m.category })
  })

  // Dashboard
  DASHBOARD_SETTINGS.forEach(s => {
    reg.push({ key: s.key, tab: 'dashboard', label: s.label, desc: s.desc, aliases: 'dashboard expand collapse default' })
  })

  // Weekly Labs
  reg.push({ key: 'weekly_reminders', tab: 'weekly_labs', label: 'Mark All Done — Weekly Reminders', desc: 'Per-class reminder messages with markdown support and history', aliases: 'reminder message weekly tracker swipe markdown class history' })

  // Evaluation
  EVAL_SETTINGS.forEach(s => {
    reg.push({ key: s.key, tab: 'evaluation', label: s.label, desc: s.desc, aliases: 'woc ratio scoring evaluation' })
  })

  // Audit Log
  AUDIT_SETTINGS.forEach(s => {
    reg.push({ key: s.key, tab: 'audit', label: s.label, desc: s.desc, aliases: 'audit log retention purge suspicious failed write tracking history' })
  })
  reg.push({ key: 'audit_track_view_entities', tab: 'audit', label: 'Tracked Entity Types', desc: 'Comma-separated entity types whose page-views are logged', aliases: 'audit log read tracking view track entities' })
  reg.push({ key: 'audit_failed_count',        tab: 'audit', label: 'Failed Audit Writes',  desc: 'Counter of failed audit log INSERTs',                       aliases: 'audit log failed writes counter reset' })
  reg.push({ key: 'audit_purge_now',           tab: 'audit', label: 'Purge Old Entries',    desc: 'Permanently delete audit log entries older than retention', aliases: 'audit log purge delete clear retention' })

  // Lookup tables — searchable by section name
  reg.push({ key: 'categories', tab: 'categories', label: 'Categories', desc: 'Inventory and asset categorization', aliases: 'lookup table' })
  reg.push({ key: 'asset_locations', tab: 'asset_locations', label: 'Asset Locations', desc: 'Locations where assets live', aliases: 'lookup table location' })
  reg.push({ key: 'inv_locations', tab: 'inv_locations', label: 'Inventory Locations', desc: 'Bin / shelf locations for inventory parts', aliases: 'lookup table bin shelf' })
  reg.push({ key: 'vendors', tab: 'vendors', label: 'Vendors', desc: 'Approved vendor list for purchase orders', aliases: 'lookup table supplier' })
  reg.push({ key: 'wo_statuses', tab: 'wo_statuses', label: 'WO Statuses', desc: 'Work order status workflow definitions', aliases: 'lookup table status workflow' })
  reg.push({ key: 'classes', tab: 'classes', label: 'Classes', desc: 'Course offerings, dates, weekly schedule, enrollment', aliases: 'class course semester student enrollment' })

  return reg
}

const SETTINGS_REGISTRY = buildRegistry()

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HOOKS — auto-save, saved-indicator
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Debounced auto-save with per-key state tracking.
 *
 * Returns:
 *   queueSave(key, value)  — schedule a save (resets the per-key debounce timer)
 *   flushSave(key)         — save immediately, useful on blur
 *   saveState              — { [key]: 'saving' | 'saved' } for UI indicators
 */
function useAutoSave(saveFn, debounceMs = 800) {
  const timersRef = useRef({})
  const pendingValuesRef = useRef({})
  const [saveState, setSaveState] = useState({})

  const doSave = useCallback(async (key, value) => {
    setSaveState(prev => ({ ...prev, [key]: 'saving' }))
    try {
      const ok = await saveFn(key, value)
      delete pendingValuesRef.current[key]
      if (ok !== false) {
        setSaveState(prev => ({ ...prev, [key]: 'saved' }))
        setTimeout(() => {
          setSaveState(prev => {
            if (prev[key] !== 'saved') return prev
            const next = { ...prev }; delete next[key]; return next
          })
        }, 2000)
      } else {
        setSaveState(prev => { const next = { ...prev }; delete next[key]; return next })
      }
    } catch {
      delete pendingValuesRef.current[key]
      setSaveState(prev => { const next = { ...prev }; delete next[key]; return next })
      // saveFn already toasted the error
    }
  }, [saveFn])

  const queueSave = useCallback((key, value) => {
    pendingValuesRef.current[key] = value
    if (timersRef.current[key]) clearTimeout(timersRef.current[key])
    timersRef.current[key] = setTimeout(() => {
      delete timersRef.current[key]
      doSave(key, pendingValuesRef.current[key])
    }, debounceMs)
  }, [doSave, debounceMs])

  const flushSave = useCallback((key) => {
    if (timersRef.current[key]) {
      clearTimeout(timersRef.current[key])
      delete timersRef.current[key]
      const value = pendingValuesRef.current[key]
      if (value !== undefined) doSave(key, value)
    }
  }, [doSave])

  // On unmount: flush all pending so a tab switch mid-edit doesn't lose data.
  useEffect(() => {
    const timers = timersRef.current
    const pending = pendingValuesRef.current
    return () => {
      Object.entries(timers).forEach(([key, timer]) => {
        clearTimeout(timer)
        const value = pending[key]
        if (value !== undefined) {
          // Fire-and-forget — we're unmounting so we can't track UI state
          saveFn(key, value).catch(() => {})
        }
      })
    }
  }, [saveFn])

  // Expose pendingValuesRef so callers can guard real-time refresh from
  // clobbering in-flight edits.
  return { queueSave, flushSave, saveState, pendingValuesRef }
}
// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS — the unified design language
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SettingCard — the unified card container used by EVERY section.
 *
 * Props:
 *   icon             — Lucide icon component
 *   title            — heading text
 *   count            — optional "(12)" count after the title
 *   accent           — 'green' | 'orange' | 'red' | 'gray' for left-border accent
 *   pill             — { tone: 'green'|'orange'|'red'|'gray', text: 'IN SESSION' }
 *   actions          — right-side header actions (buttons, search, etc.)
 *   footer           — optional footer content (rendered in muted gray panel)
 *   bodyPadded       — wrap body in default padding (use for cards without rows)
 *   children         — body content (typically <SettingRow>s or padded content)
 */
function SettingCard({ icon: Icon, title, count, accent, pill, actions, footer, bodyPadded, children }) {
  const cls = [
    'settings-card',
    accent ? `settings-card--accent-${accent}` : '',
  ].filter(Boolean).join(' ')

  return (
    <section className={cls}>
      <header className="settings-card-header">
        {Icon && <Icon size={16} className="settings-card-header-icon" aria-hidden="true" />}
        <h2 className="settings-card-header-title">
          {title}
          {count != null && <span className="settings-card-header-count"> ({count})</span>}
        </h2>
        {pill && (
          <span className={`settings-pill settings-pill--${pill.tone}`} aria-live="polite">
            {pill.text}
          </span>
        )}
        {actions && <div className="settings-card-header-actions">{actions}</div>}
      </header>
      <div className={`settings-card-body ${bodyPadded ? 'settings-card-body--padded' : ''}`}>
        {children}
      </div>
      {footer && <div className="settings-card-footer">{footer}</div>}
    </section>
  )
}

/**
 * SettingRow — a single setting line: label + helper + optional details + control.
 *
 * Props:
 *   id          — DOM id used for find-a-setting jump-to (e.g. `setting-foo`)
 *   label       — visible label text
 *   labelFor    — htmlFor target (id of the control)
 *   helper      — short helper text shown under the label
 *   details     — { what, where, effect } for the disclosure
 *   defaultHint — italic note (e.g. "Using default — no override saved")
 *   children    — the control(s) on the right side
 */
function SettingRow({ id, label, labelFor, helper, details, defaultHint, children }) {
  return (
    <div id={id} className="settings-row">
      <div className="settings-row-label-block">
        {labelFor ? (
          <label htmlFor={labelFor} className="settings-row-label">{label}</label>
        ) : (
          <div className="settings-row-label">{label}</div>
        )}
        {helper && <div className="settings-row-helper">{helper}</div>}
        {details && <DetailsDisclosure details={details} />}
        {defaultHint && <div className="settings-row-helper-default">{defaultHint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/**
 * DetailsDisclosure — collapsible "Show details" block under a SettingRow label.
 * Uses native <details>/<summary> for full keyboard + screen-reader support.
 */
function DetailsDisclosure({ details }) {
  if (!details) return null
  const { what, where, effect } = details
  return (
    <details className="settings-disclosure">
      <summary className="settings-disclosure-summary">
        <ChevronRight size={11} className="settings-disclosure-summary-icon" aria-hidden="true" />
        Show details
      </summary>
      <div className="settings-disclosure-content">
        {what   && <p><strong>What it does:</strong> {what}</p>}
        {where  && <p><strong>Where it shows up:</strong> {where}</p>}
        {effect && <p><strong>Effect:</strong> {effect}</p>}
      </div>
    </details>
  )
}

/**
 * SegmentedToggle — accessible 2- or 3-way segmented switch.
 *
 * Props:
 *   value     — currently-active option value
 *   options   — [{ value, label, icon, tone? }, ...]
 *   onChange  — (newValue) => void
 *   disabled  — bool
 *   variant   — 'green' | 'orange' | 'red' | 'gray' for the pressed state color
 *   ariaLabel — optional label for the role="group"
 */
function SegmentedToggle({ value, options, onChange, disabled, variant, ariaLabel }) {
  const cls = ['settings-segmented', variant ? `settings-segmented--${variant}` : ''].filter(Boolean).join(' ')
  return (
    <div className={cls} role="group" aria-label={ariaLabel || 'Toggle'}>
      {options.map(opt => {
        const Icon = opt.icon
        const pressed = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            className="settings-segmented-btn"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => { if (!pressed) onChange(opt.value) }}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * SavedIndicator — small "✓ Saved" / "Saving…" pulse next to a control.
 * Uses aria-live="polite" so screen readers announce save success.
 */
function SavedIndicator({ state }) {
  const isSaving = state === 'saving'
  const isSaved = state === 'saved'
  const cls = [
    'settings-saved-indicator',
    isSaved ? 'settings-saved-indicator--visible' : '',
    isSaving ? 'settings-saved-indicator--saving' : '',
  ].filter(Boolean).join(' ')
  return (
    <span className={cls} aria-live="polite">
      {isSaving && <><Loader2 size={11} className="animate-spin" aria-hidden="true" /> Saving…</>}
      {isSaved && <><Check size={12} aria-hidden="true" /> Saved</>}
    </span>
  )
}

/**
 * DebouncedInput — text/number/date/email input with built-in auto-save.
 * Saves on debounce timer and on blur.
 */
function DebouncedInput({ id, type = 'text', value, onChange, onBlur, suffix, className, ...rest }) {
  return (
    <>
      <input
        id={id}
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        className={`settings-input ${className || ''}`}
        {...rest}
      />
      {suffix && <span className="settings-input-suffix">{suffix}</span>}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIND-A-SETTING SEARCH BAR
// ═══════════════════════════════════════════════════════════════════════════════

function FindASetting({ onJump }) {
  const [query, setQuery] = useState('')
  const inputId = useId()

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return SETTINGS_REGISTRY.filter(s => {
      const haystack = `${s.label} ${s.desc} ${s.aliases || ''} ${TAB_LABELS[s.tab] || ''}`.toLowerCase()
      return haystack.includes(q)
    }).slice(0, 12)
  }, [query])

  const handleJump = (m) => {
    setQuery('')
    onJump(m.tab, m.key)
  }

  return (
    <div className="settings-search">
      <Search size={16} className="settings-search-icon" aria-hidden="true" />
      <label htmlFor={inputId} className="dash-sr-only">Find a setting</label>
      <input
        id={inputId}
        type="search"
        className="settings-search-input"
        placeholder="Find a setting…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        aria-controls="settings-search-results"
        aria-expanded={query.trim().length > 0}
      />
      {query && (
        <button
          type="button"
          className="settings-search-clear"
          onClick={() => setQuery('')}
          aria-label="Clear search"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}

      {query.trim() && (
        <div id="settings-search-results" className="settings-search-results" role="listbox">
          {matches.length === 0 ? (
            <div className="settings-search-empty">No settings match "{query}"</div>
          ) : (
            matches.map(m => (
              <button
                key={`${m.tab}-${m.key}`}
                type="button"
                className="settings-search-result"
                role="option"
                aria-selected="false"
                onClick={() => handleJump(m)}
              >
                <div className="settings-search-result-row">
                  <span className="settings-search-result-tab">{TAB_LABELS[m.tab] || m.tab}</span>
                  <span className="settings-search-result-label">{m.label}</span>
                </div>
                {m.desc && <div className="settings-search-result-desc">{m.desc}</div>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function SettingsPage() {
  const { hasPerm, permsLoading } = usePermissions('Settings')
  const [tab, setTab] = useState('general')

  // Tab definitions, grouped for visual dividers
  const TAB_GROUPS = [
    {
      label: 'Operations',
      items: [
        { id: 'general', label: 'General', icon: Sliders },
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'weekly_labs', label: 'Weekly Labs', icon: FlaskConical },
        { id: 'evaluation', label: 'WOC Ratio', icon: Target },
        { id: 'audit',      label: 'Audit Log', icon: FileSearch },
      ],
    },
    {
      label: 'Lookups',
      items: [
        { id: 'categories', label: 'Categories', icon: Tag },
        { id: 'asset_locations', label: 'Asset Locations', icon: MapPin },
        { id: 'inv_locations', label: 'Inventory Locations', icon: Box },
        { id: 'vendors', label: 'Vendors', icon: Truck },
        { id: 'wo_statuses', label: 'WO Statuses', icon: ClipboardList },
      ],
    },
    {
      label: 'Academic',
      items: [
        { id: 'classes', label: 'Classes', icon: GraduationCap },
      ],
    },
  ]

  // Find-a-setting jump: switch tab, scroll to row, briefly highlight.
  const jumpToSetting = useCallback((targetTab, key) => {
    setTab(targetTab)
    setTimeout(() => {
      const el = document.getElementById(`setting-${key}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('settings-row--highlight')
        setTimeout(() => el.classList.remove('settings-row--highlight'), 2000)
      }
    }, 150)
  }, [])

  if (permsLoading) {
    return (
      <div className="settings-root p-4 lg:p-6">
        <div className="settings-loading">
          <Loader2 size={24} className="mx-auto mb-3 animate-spin" aria-hidden="true" />
          <p className="text-sm">Loading…</p>
        </div>
      </div>
    )
  }

  if (!hasPerm('view_page')) {
    return (
      <div className="settings-root p-4 lg:p-6">
        <div className="settings-empty">
          <Settings size={40} className="settings-empty-icon mx-auto" aria-hidden="true" />
          <p className="settings-empty-text">You do not have permission to access Settings.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-root p-4 lg:p-6 space-y-4">
      {/* ── Page header + find-a-setting search ── */}
      <div className="space-y-3">
        <h1 className="settings-page-title">
          <Settings size={20} className="settings-page-title-icon" aria-hidden="true" /> Settings
        </h1>
        <FindASetting onJump={jumpToSetting} />
      </div>

      {/* ── Tab bar ── */}
      <nav className="settings-tabs" aria-label="Settings sections">
        {TAB_GROUPS.map((group, gIdx) => (
          <Fragment key={group.label}>
            {gIdx > 0 && <div className="settings-tabs-divider" aria-hidden="true" />}
            {group.items.map(t => {
              const Icon = t.icon
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`settings-tab ${active ? 'settings-tab--active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setTab(t.id)}
                >
                  <Icon size={14} aria-hidden="true" /> {t.label}
                </button>
              )
            })}
          </Fragment>
        ))}
      </nav>

      {/* ── Active tab content ── */}
      {tab === 'general' && <GeneralSettings />}
      {tab === 'dashboard' && <DashboardSettings />}
      {tab === 'weekly_labs' && <WeeklyLabsSettings />}
      {tab === 'evaluation' && <EvaluationSettings />}
      {tab === 'audit' && <AuditLogSettings />}
      {tab === 'categories' && <CategoriesSection />}
      {tab === 'asset_locations' && <AssetLocationsSection />}
      {tab === 'inv_locations' && <InventoryLocationsSection />}
      {tab === 'vendors' && <VendorsSection />}
      {tab === 'wo_statuses' && <WOStatusesSection />}
      {tab === 'classes' && <ClassesSection />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAB ACCESS MODE CARD
// Critical operational toggle — has confirmation modal + audit log + PM auto-pause sync
// ═══════════════════════════════════════════════════════════════════════════════

function LabAccessModeCard() {
  const { profile } = useAuth()
  const [mode, setMode] = useState(null)         // 'in_session' | 'summer_break' | null
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null)   // 'summer_break' | 'in_session' (pending confirm)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  // ── Fetch current value ──
  const fetchMode = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'lab_access_mode')
        .maybeSingle()
      setMode(data?.setting_value || 'in_session')
    } catch {
      setMode('in_session')
    }
  }, [])

  useEffect(() => { fetchMode() }, [fetchMode])

  // ── Realtime sync ──
  useEffect(() => {
    const channelId = `lab-access-mode-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.lab_access_mode',
      }, (payload) => {
        setMode(payload.new?.setting_value || 'in_session')
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const applyMode = async (newMode) => {
    setSaving(true)
    setConfirm(null)
    const oldMode = mode
    try {
      // Update lab_access_mode
      const { data: rows, error } = await supabase
        .from('settings')
        .update({
          setting_value: newMode,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('setting_key', 'lab_access_mode')
        .select()

      if (error) throw error
      if (!rows || rows.length === 0) {
        await supabase.from('settings').insert({
          setting_key: 'lab_access_mode',
          setting_value: newMode,
          description: 'Controls whether students and work study can access the system',
          category: 'System',
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
      }

      setMode(newMode)

      // ── PM generation is intentionally NOT synced here ───────────────────
      // Lab Access Mode only controls student/work-study lockout. PM work
      // order generation is managed manually on the Preventive Maintenance
      // page (see usePMSchedules.js → pm_generation_paused). Decoupled by
      // request so breaks don't force PM state either direction.

      // ── Audit log ────────────────────────────────────────────────────────
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email || 'unknown',
          user_name: profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown',
          action: newMode === 'summer_break' ? 'Enable Summer Break Mode' : 'Restore In-Session Access',
          entity_type: 'Setting',
          entity_id: 'lab_access_mode',
          field_changed: 'lab_access_mode',
          old_value: oldMode,
          new_value: newMode,
          details: newMode === 'summer_break'
            ? 'Lab Access Mode set to Summer Break — students and work study locked out.'
            : 'Lab Access Mode restored to In Session — students and work study have access.',
        })
      } catch (auditErr) {
        console.warn('[LabAccessMode] Audit log failed (non-fatal):', auditErr.message)
      }

      toast.success(newMode === 'summer_break'
        ? 'Summer Break Mode enabled — students & work study locked out'
        : 'In-Session Mode restored — students & work study have access')
    } catch (err) {
      toast.error('Failed to update Lab Access Mode: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const isSummerBreak = mode === 'summer_break'
  const isLoading = mode === null

  // Card visual state
  const accent = isSummerBreak ? 'orange' : 'green'
  const pill = isSummerBreak
    ? { tone: 'orange', text: 'Summer Break' }
    : { tone: 'green', text: 'In Session' }

  return (
    <>
      <SettingCard
        icon={isSummerBreak ? MoonStar : Sun}
        title="Lab Access Mode"
        accent={accent}
        pill={isLoading ? { tone: 'gray', text: 'Loading…' } : pill}
        footer={
          <>
            <Info size={13} className="settings-card-footer-icon" aria-hidden="true" />
            <span>
              Changes take effect immediately for all logged-in users and the Time Clock kiosk.
              Use this for spring break, maintenance windows, or any other period when student access should be suspended.
            </span>
          </>
        }
      >
        <SettingRow
          id="setting-lab_access_mode"
          label="Student & Work Study access"
          helper={
            isSummerBreak
              ? 'Students and Work Study users are locked out. The Time Clock kiosk is also disabled. Instructors retain full access.'
              : 'All users can access the system normally. Switch to Summer Break to lock out students during semester breaks.'
          }
          details={{
            what: 'Single switch that controls whether non-instructor users can log in at all.',
            where: 'Affects every page, the Time Clock kiosk, and the Lab Status display. PM work order generation is managed separately on the Preventive Maintenance page.',
            effect: 'Switching to Summer Break shows a "Lab Closed" screen to students. Switching back to In Session restores all access immediately.',
          }}
        >
          <SegmentedToggle
            value={mode}
            ariaLabel="Lab access mode"
            disabled={saving || isLoading}
            variant={isSummerBreak ? 'orange' : 'green'}
            options={[
              { value: 'in_session', label: 'In Session', icon: Sun },
              { value: 'summer_break', label: 'Summer Break', icon: MoonStar },
            ]}
            onChange={(v) => setConfirm(v)}
          />
          {saving && (
            <span className="settings-saved-indicator settings-saved-indicator--saving">
              <Loader2 size={11} className="animate-spin" aria-hidden="true" /> Saving…
            </span>
          )}
        </SettingRow>
      </SettingCard>

      {/* ── Confirmation modal ── */}
      <LabAccessConfirmModal
        confirm={confirm}
        saving={saving}
        onCancel={() => setConfirm(null)}
        onConfirm={() => applyMode(confirm)}
      />
    </>
  )
}

function LabAccessConfirmModal({ confirm, saving, onCancel, onConfirm }) {
  const isOpen = !!confirm
  const dialogRef = useDialogA11y(isOpen, onCancel)
  const titleId = useId()

  if (!isOpen) return null
  const isWarn = confirm === 'summer_break'

  return (
    <div
      className="settings-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="settings-modal"
      >
        <header className={`settings-modal-header ${isWarn ? 'settings-modal-header--warn' : 'settings-modal-header--ok'}`}>
          <span className="settings-modal-header-icon-wrap">
            {isWarn ? <MoonStar size={20} aria-hidden="true" /> : <Sun size={20} aria-hidden="true" />}
          </span>
          <h3 id={titleId} className="settings-modal-title">
            {isWarn ? 'Enable Summer Break Mode?' : 'Restore In-Session Access?'}
          </h3>
        </header>

        <div className="settings-modal-body">
          {isWarn ? (
            <>
              <div className="settings-modal-warning">
                <AlertTriangle size={18} className="settings-modal-warning-icon" aria-hidden="true" />
                <p className="settings-modal-warning-text">
                  This will <strong>immediately</strong> lock out all Students and Work Study users.
                  They will see a "Lab Closed" screen and cannot access any part of the system.
                  The Time Clock kiosk will also be disabled.
                </p>
              </div>
              <p className="settings-modal-text">
                <strong>Instructors are not affected.</strong> You can restore access at any time
                by switching back to In Session.
              </p>
              <p className="settings-modal-text" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <Info size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  This <strong>no longer</strong> pauses PM work order generation. Pause or resume PMs
                  manually on the Preventive Maintenance page.
                </span>
              </p>
            </>
          ) : (
            <p className="settings-modal-text">
              This will restore full access to all Students and Work Study users immediately.
              The Time Clock kiosk will also be re-enabled.
            </p>
          )}
        </div>

        <footer className="settings-modal-footer">
          <button
            type="button"
            className="settings-modal-btn settings-modal-btn--secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`settings-modal-btn ${isWarn ? 'settings-modal-btn--warn' : 'settings-modal-btn--ok'}`}
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : (isWarn ? <MoonStar size={14} aria-hidden="true" /> : <Sun size={14} aria-hidden="true" />)}
            {isWarn ? 'Enable Summer Break' : 'Restore Access'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTRUCTOR AWAY (MEETING) MODE CARD
// ═══════════════════════════════════════════════════════════════════════════════

function InstructorAwayCard() {
  const { profile } = useAuth()
  const [awayMode, setAwayMode] = useState(null)         // null = loading
  const [returnTime, setReturnTime] = useState('')
  const [savedReturnTime, setSavedReturnTime] = useState('')
  const [saving, setSaving] = useState(false)
  const [returnTimeSaveState, setReturnTimeSaveState] = useState(null)  // 'saving' | 'saved'
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''
  const returnTimeId = useId()
  const returnTimeDebounceRef = useRef(null)

  // ── Fetch current values ──
  const fetchAway = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['instructor_away_mode', 'instructor_return_time'])
      const modeRow = (data || []).find(r => r.setting_key === 'instructor_away_mode')
      const timeRow = (data || []).find(r => r.setting_key === 'instructor_return_time')
      setAwayMode(modeRow?.setting_value === 'true')
      const t = timeRow?.setting_value || ''
      setReturnTime(t)
      setSavedReturnTime(t)
    } catch {
      setAwayMode(false)
    }
  }, [])

  useEffect(() => { fetchAway() }, [fetchAway])

  // ── Realtime sync ──
  useEffect(() => {
    const channelId = `instructor-away-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_away_mode',
      }, (payload) => {
        setAwayMode(payload.new?.setting_value === 'true')
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_return_time',
      }, (payload) => {
        const t = payload.new?.setting_value || ''
        setReturnTime(t)
        setSavedReturnTime(t)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── Upsert helper ──
  const upsertSetting = async (key, value, description) => {
    const { data: rows, error } = await supabase
      .from('settings')
      .update({
        setting_value: value,
        updated_at: new Date().toISOString(),
        updated_by: userName,
      })
      .eq('setting_key', key)
      .select()
    if (error) throw error
    if (!rows || rows.length === 0) {
      await supabase.from('settings').insert({
        setting_key: key,
        setting_value: value,
        description,
        category: 'System',
        updated_at: new Date().toISOString(),
        updated_by: userName,
      })
    }
  }

  // ── Toggle away mode (immediate save) ──
  const toggleAway = async (newVal) => {
    setSaving(true)
    try {
      await upsertSetting(
        'instructor_away_mode',
        String(newVal),
        'When true, students are told instructor is in a meeting when requesting help'
      )
      // Sync return-time field on toggle
      if (newVal && returnTime.trim()) {
        await upsertSetting(
          'instructor_return_time', returnTime.trim(),
          'Return time shown to students when instructor is away in a meeting'
        )
        setSavedReturnTime(returnTime.trim())
      }
      if (!newVal) {
        await upsertSetting(
          'instructor_return_time', '',
          'Return time shown to students when instructor is away in a meeting'
        )
        setReturnTime('')
        setSavedReturnTime('')
      }
      setAwayMode(newVal)

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email || 'unknown',
          user_name: profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown',
          action: newVal ? 'Enable Instructor Away Mode' : 'Disable Instructor Away Mode',
          entity_type: 'Setting',
          entity_id: 'instructor_away_mode',
          field_changed: 'instructor_away_mode',
          old_value: String(!newVal),
          new_value: String(newVal),
          details: newVal
            ? `Instructor away mode enabled. Return time: ${returnTime.trim() || '(not set)'}`
            : 'Instructor away mode disabled — back from meeting.',
        })
      } catch (auditErr) {
        console.warn('[InstructorAway] Audit log failed (non-fatal):', auditErr.message)
      }

      toast.success(newVal
        ? `Away mode enabled${returnTime.trim() ? ' — returning at ' + returnTime.trim() : ''}`
        : 'Away mode disabled — welcome back!')
    } catch (err) {
      toast.error('Failed to update away mode: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Auto-save return-time (debounced) ──
  const saveReturnTime = async (val) => {
    setReturnTimeSaveState('saving')
    try {
      await upsertSetting(
        'instructor_return_time', val,
        'Return time shown to students when instructor is away in a meeting'
      )
      setSavedReturnTime(val)
      setReturnTimeSaveState('saved')
      setTimeout(() => setReturnTimeSaveState(s => s === 'saved' ? null : s), 2000)
    } catch (err) {
      setReturnTimeSaveState(null)
      toast.error('Failed to save return time: ' + err.message)
    }
  }

  const handleReturnTimeChange = (val) => {
    setReturnTime(val)
    if (returnTimeDebounceRef.current) clearTimeout(returnTimeDebounceRef.current)
    returnTimeDebounceRef.current = setTimeout(() => {
      const trimmed = val.trim()
      if (trimmed !== savedReturnTime) saveReturnTime(trimmed)
    }, 800)
  }

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (returnTimeDebounceRef.current) {
        clearTimeout(returnTimeDebounceRef.current)
        const trimmed = returnTime.trim()
        if (trimmed !== savedReturnTime) {
          saveReturnTime(trimmed).catch(() => {})
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isAway = awayMode === true
  const isLoading = awayMode === null

  const accent = isAway ? 'red' : 'gray'
  const pill = isAway
    ? { tone: 'red', text: savedReturnTime ? `Away · back ${savedReturnTime}` : 'Away — In a meeting' }
    : { tone: 'gray', text: 'Available — In Lab' }

  return (
    <SettingCard
      icon={Clock}
      title="Instructor Away Mode"
      accent={accent}
      pill={isLoading ? { tone: 'gray', text: 'Loading…' } : pill}
      footer={
        <>
          <Info size={13} className="settings-card-footer-icon" aria-hidden="true" />
          <span>
            {isAway
              ? 'This will NOT auto-disable. Remember to toggle back to Available when you return from your meeting.'
              : 'Changes take effect immediately for all student help requests and the Lab Status kiosk.'}
          </span>
        </>
      }
    >
      <SettingRow
        id="setting-instructor_away_mode"
        label="Availability for student help"
        helper={
          isAway
            ? 'Students requesting help see a meeting notice. The Lab Status kiosk shows a red AWAY indicator. Toggle off when you return.'
            : 'Enable this when you step into a meeting. Students will be informed via the help button and Lab Status page.'
        }
        details={{
          what: 'Communicates your availability to students. Does not block any feature.',
          where: 'Help button on student-facing pages and the Lab Status kiosk display.',
          effect: 'When Away, students see a soft notice asking them to wait or come back at the return time. Instructors are not affected.',
        }}
      >
        <SegmentedToggle
          value={isAway ? 'away' : 'available'}
          ariaLabel="Instructor availability"
          disabled={saving || isLoading}
          variant={isAway ? 'red' : 'green'}
          options={[
            { value: 'available', label: 'Available', icon: CheckCircle2 },
            { value: 'away', label: 'Away', icon: Clock },
          ]}
          onChange={(v) => toggleAway(v === 'away')}
        />
        {saving && (
          <span className="settings-saved-indicator settings-saved-indicator--saving">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" /> Saving…
          </span>
        )}
      </SettingRow>

      <SettingRow
        id="setting-instructor_return_time"
        label="Expected Return Time"
        labelFor={returnTimeId}
        helper="Optional. Free-form text shown alongside the away notice (e.g. &quot;2:30 PM&quot;). Auto-saves as you type."
      >
        <DebouncedInput
          id={returnTimeId}
          type="text"
          value={returnTime}
          onChange={handleReturnTimeChange}
          placeholder="e.g. 2:30 PM"
          maxLength={20}
          className="settings-input--time"
          aria-label="Expected return time"
        />
        <SavedIndicator state={returnTimeSaveState} />
      </SettingRow>
    </SettingCard>
  )
}
// ═══════════════════════════════════════════════════════════════════════════════
// GENERAL SETTINGS — auto-grouped by category, auto-saved on change
// ═══════════════════════════════════════════════════════════════════════════════

function GeneralSettings() {
  const { settings, loading, refresh } = useSettings()
  const actions = useSettingsActions()
  const [edits, setEdits] = useState({})

  // Wrap updateSetting for the auto-save hook (silent toasts)
  const saveFn = useCallback(async (key, value) => {
    const meta = SETTING_META[key]
    return await actions.updateSetting(key, value, {
      silent: true,
      category: meta?.category,
      description: meta?.desc,
    })
  }, [actions])

  const { queueSave, flushSave, saveState, pendingValuesRef } = useAutoSave(saveFn)

  // Sync edits from server, but DON'T clobber pending in-flight edits.
  useEffect(() => {
    setEdits(prev => {
      const next = {}
      settings.forEach(s => {
        // If this key has a pending save, keep the local value
        if (pendingValuesRef.current[s.setting_key] !== undefined) {
          next[s.setting_key] = prev[s.setting_key] ?? String(s.setting_value ?? '')
          return
        }
        let val = s.setting_value ?? ''
        if (SETTING_META[s.setting_key]?.type === 'date' && val) {
          val = String(val).substring(0, 10)
        }
        next[s.setting_key] = String(val)
      })
      return next
    })
  }, [settings, pendingValuesRef])

  const handleChange = (key, value) => {
    setEdits(prev => ({ ...prev, [key]: value }))
    queueSave(key, value)
  }

  // Group settings by category, applying the existing skip list
  // Some settings live in 'System' category but have their own dedicated UI
  // cards above (LabAccessModeCard, InstructorAwayCard) — skip those keys
  // so they don't render as raw rows in the System group.
  const SETTINGS_HANDLED_BY_DEDICATED_CARDS = new Set([
    'lab_access_mode',         // → LabAccessModeCard (top of tab)
    'instructor_away_mode',    // → InstructorAwayCard (top of tab)
    'instructor_return_time',  // → InstructorAwayCard (top of tab)
  ])
  const groups = useMemo(() => {
    const g = {}
    settings.forEach(s => {
      // Per-key skip — handled by a dedicated card above
      if (SETTINGS_HANDLED_BY_DEDICATED_CARDS.has(s.setting_key)) return
      const cat = s.category || 'General'
      // Skip categories managed elsewhere
      if (cat === 'Storage') return            // Retired Google Drive folder IDs
      if (cat === 'Evaluation') return         // Managed on the WOC Ratio page
      if (cat === 'PM') return                 // Auto-synced by Lab Access Mode
      if (cat === 'Weekly Labs') return        // Managed on the Weekly Labs tab
      if (cat === 'SOPs') return               // Managed on the SOPs page (Manage SOP Template modal)
      if (cat === 'program_cost') return       // Managed on the Program Cost page
      if (cat === 'program_revisions') return  // Managed via the Course Revision gear icon
      if (cat === 'course_proposals') return   // Managed via the New Course Proposal gear icon
      if (cat === 'course_revisions') return   // Managed via the Course Revision gear icon
      if (cat === 'Dashboard') return          // Managed on the Dashboard tab
      if (!g[cat]) g[cat] = []
      g[cat].push(s)
    })
    return g
  }, [settings])

  if (loading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Critical mode toggles always at top */}
      <LabAccessModeCard />
      <InstructorAwayCard />

      {/* Auto-grouped category cards */}
      {Object.entries(groups).map(([category, items]) => {
        const CatIcon = CATEGORY_ICONS[category] || Sliders
        return (
          <SettingCard key={category} icon={CatIcon} title={category}>
            {items.map(s => (
              <GeneralSettingRow
                key={s.setting_key}
                setting={s}
                value={edits[s.setting_key]}
                onChange={(v) => handleChange(s.setting_key, v)}
                onBlur={() => flushSave(s.setting_key)}
                saveState={saveState[s.setting_key]}
              />
            ))}
          </SettingCard>
        )
      })}

      {settings.length === 0 && (
        <div className="settings-empty">
          <AlertCircle size={32} className="settings-empty-icon mx-auto" aria-hidden="true" />
          <p className="settings-empty-text">No settings configured yet. Run the migration SQL to seed default settings.</p>
        </div>
      )}
    </div>
  )
}

// One row inside the General-tab category cards
function GeneralSettingRow({ setting, value, onChange, onBlur, saveState }) {
  const meta = SETTING_META[setting.setting_key] || {}
  const inputType = meta.type || 'text'
  const label = meta.label || setting.setting_key
  const helper = meta.desc || setting.description || ''
  const inputId = `setting-input-${setting.setting_key}`

  // ── Custom day-of-week picker for lab_visible_days ──
  if (setting.setting_key === 'lab_visible_days') {
    const DAY_LABELS = ['S', 'M', 'T', 'W', 'Th', 'F', 'S']
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const currentDays = (value || '').split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d))

    const toggleDay = (dayNum) => {
      const next = currentDays.includes(dayNum)
        ? currentDays.filter(d => d !== dayNum)
        : [...currentDays, dayNum].sort((a, b) => a - b)
      onChange(next.join(','))
    }

    return (
      <SettingRow
        id={`setting-${setting.setting_key}`}
        label={label}
        helper={helper}
        details={meta.details}
      >
        <div className="settings-day-picker" role="group" aria-label="Lab open days">
          {DAY_LABELS.map((dayLabel, idx) => (
            <button
              key={idx}
              type="button"
              className="settings-day-btn"
              aria-pressed={currentDays.includes(idx)}
              aria-label={DAY_NAMES[idx]}
              onClick={() => toggleDay(idx)}
            >
              {dayLabel}
            </button>
          ))}
        </div>
        <SavedIndicator state={saveState} />
      </SettingRow>
    )
  }

  // ── Standard text/number/date/email input ──
  const inputClass =
    inputType === 'number' ? 'settings-input--num' :
    inputType === 'date'   ? 'settings-input--date' :
    inputType === 'email'  ? 'settings-input--email' :
                             'settings-input--text'

  return (
    <SettingRow
      id={`setting-${setting.setting_key}`}
      label={label}
      labelFor={inputId}
      helper={helper}
      details={meta.details}
    >
      <DebouncedInput
        id={inputId}
        type={inputType}
        value={value ?? ''}
        onChange={onChange}
        onBlur={onBlur}
        className={inputClass}
      />
      <SavedIndicator state={saveState} />
    </SettingRow>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD SETTINGS — instructor dashboard defaults
// ═══════════════════════════════════════════════════════════════════════════════

function DashboardSettings() {
  const { profile } = useAuth()
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''
  const [values, setValues] = useState({
    dashboard_day_view_expanded: null,
    dashboard_temp_access_expanded: null,
  })
  const [saveState, setSaveState] = useState({})  // key -> 'saving' | 'saved'

  // ── Fetch current values ──
  const fetchDefaults = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['dashboard_day_view_expanded', 'dashboard_temp_access_expanded'])
      const get = (key, fallback) => {
        const row = (data || []).find(r => r.setting_key === key)
        return row ? row.setting_value === 'true' : fallback
      }
      setValues({
        dashboard_day_view_expanded: get('dashboard_day_view_expanded', true),
        dashboard_temp_access_expanded: get('dashboard_temp_access_expanded', false),
      })
    } catch {
      setValues({
        dashboard_day_view_expanded: true,
        dashboard_temp_access_expanded: false,
      })
    }
  }, [])

  useEffect(() => { fetchDefaults() }, [fetchDefaults])

  // Realtime sync
  useEffect(() => {
    const channelId = `dash-settings-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const ch = supabase.channel(channelId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.dashboard_day_view_expanded',
      }, (p) => { if (p.new?.setting_value !== undefined) setValues(v => ({ ...v, dashboard_day_view_expanded: p.new.setting_value === 'true' })) })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.dashboard_temp_access_expanded',
      }, (p) => { if (p.new?.setting_value !== undefined) setValues(v => ({ ...v, dashboard_temp_access_expanded: p.new.setting_value === 'true' })) })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])

  const applyToggle = async (key, newVal) => {
    setSaveState(prev => ({ ...prev, [key]: 'saving' }))
    try {
      const { data: rows, error } = await supabase
        .from('settings')
        .update({ setting_value: String(newVal), updated_at: new Date().toISOString(), updated_by: userName })
        .eq('setting_key', key)
        .select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        const descs = {
          dashboard_day_view_expanded:    'Whether the Day View card is expanded by default on the instructor dashboard',
          dashboard_temp_access_expanded: 'Whether the Active Temp Access card is expanded by default on the instructor dashboard',
        }
        await supabase.from('settings').insert({
          setting_key: key,
          setting_value: String(newVal),
          description: descs[key] || '',
          category: 'Dashboard',
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
      }
      setValues(v => ({ ...v, [key]: newVal }))
      setSaveState(prev => ({ ...prev, [key]: 'saved' }))
      setTimeout(() => setSaveState(prev => {
        if (prev[key] !== 'saved') return prev
        const next = { ...prev }; delete next[key]; return next
      }), 2000)
    } catch (err) {
      setSaveState(prev => { const next = { ...prev }; delete next[key]; return next })
      toast.error('Failed to save: ' + err.message)
    }
  }

  const isLoading = values.dashboard_day_view_expanded === null || values.dashboard_temp_access_expanded === null

  if (isLoading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading dashboard settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SettingCard
        icon={LayoutDashboard}
        title="Instructor Dashboard — Default Layout"
        footer={
          <>
            <Info size={13} className="settings-card-footer-icon" aria-hidden="true" />
            <span>
              These settings control the <strong>initial</strong> state on first load. Once an instructor manually
              expands or collapses a card, their preference is saved in their browser and takes priority over this
              setting for that device. Clearing browser data or using a new device will reset back to these defaults.
            </span>
          </>
        }
      >
        {DASHBOARD_SETTINGS.map(s => (
          <SettingRow
            key={s.key}
            id={`setting-${s.key}`}
            label={s.label}
            helper={s.desc}
            details={s.details}
          >
            <SegmentedToggle
              value={values[s.key] ? 'expanded' : 'collapsed'}
              ariaLabel={s.label}
              options={[
                { value: 'expanded', label: 'Expanded' },
                { value: 'collapsed', label: 'Collapsed' },
              ]}
              onChange={(v) => applyToggle(s.key, v === 'expanded')}
            />
            <SavedIndicator state={saveState[s.key]} />
          </SettingRow>
        ))}
      </SettingCard>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY LABS SETTINGS — Per-class reminders with markdown + history
//
// Reminders are stored in the `weekly_reminders` table:
//   • One global row (class_id IS NULL) shown to ALL students
//   • Plus one optional row per active class, shown only to students in it
//
// Every save appends to `reminder_history` (auto-pruned to last 100 per scope).
// Markdown rendering uses react-markdown + remark-gfm — see the popup in
// WeeklyLabsTrackerPage.jsx for the matching student-facing renderer.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Auto-grow textarea hook ────────────────────────────────────────────────
// useLayoutEffect (not useEffect) runs synchronously after DOM mutation but
// BEFORE the browser paints — so the textarea is never visibly resized in two
// steps. Without this, fast typing can cause a momentary "collapse to auto"
// flash between paints.
function useAutoGrowTextarea(value, ref, { min = 200, max = 400 } = {}) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const target = Math.min(Math.max(el.scrollHeight + 2, min), max)
    el.style.height = `${target}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, ref, min, max])
}

// ─── Shared markdown preview (matches the modal renderer) ───────────────────
function ReminderMarkdownPreview({ text, className = '' }) {
  if (!text || !text.trim()) return null
  return (
    <div className={`reminder-markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-amber-900 hover:text-amber-950 focus-visible:ring-2 focus-visible:ring-amber-600 rounded"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
          p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-snug">{children}</p>,
          code: ({ children }) => (
            <code className="px-1 py-0.5 rounded bg-amber-100/60 text-[0.85em] font-mono">{children}</code>
          ),
          h1: ({ children }) => <p className="font-bold text-base mb-1.5">{children}</p>,
          h2: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
          h3: ({ children }) => <p className="font-semibold text-sm mb-1">{children}</p>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// ─── Editor pane for a single scope (global or one class) ───────────────────
// Self-contained: owns its message buffer, debounced auto-save, and on-unmount
// flush. Keyed by scope at the parent so switching tabs remounts cleanly.
//
// CURSOR-JUMP FIX (v3.7.5):
//   `savedMessage` was previously useState — which meant the sync effect's dep
//   list `[initialMessage, savedMessage]` would re-fire whenever WE updated
//   savedMessage from persist(). In the gap between our own `setSavedMessage`
//   and the realtime echo arriving with a fresh `initialMessage`, the effect
//   would clobber the textarea value with a STALE initialMessage for one paint,
//   reassigning the DOM value and jumping the cursor to the end.
//
//   Fix: `savedMessage` becomes a ref (no render, no dep tracking). The sync
//   effect now ONLY runs when `initialMessage` truly changes (real external
//   input — another tab or instructor), never as a side-effect of our own save.
//   `messageRef` mirrors `message` so the unmount-flush closure stays current.
function ReminderEditor({ scope, initialMessage, onSave }) {
  const [message, setMessage] = useState(initialMessage || '')
  const [saveState, setSaveState] = useState(null)
  const savedMessageRef = useRef(initialMessage || '')  // last persisted value
  const messageRef = useRef(initialMessage || '')        // mirror of `message`
  const debounceRef = useRef(null)
  const textareaRef = useRef(null)
  const messageId = useId()
  const helpId = useId()
  const previewId = useId()
  const statusLiveId = useId()

  useAutoGrowTextarea(message, textareaRef, { min: 200, max: 400 })

  // Keep messageRef in lock-step with message so unmount cleanup always reads
  // the latest typed value (no stale closure).
  useEffect(() => { messageRef.current = message }, [message])

  // Re-sync when initialMessage actually changes — typically from realtime
  // (another tab/instructor edited the same reminder). Guarded against:
  //   • user is mid-edit (debounceRef.current is set)
  //   • the value is already what we last saved (no-op)
  // Deps intentionally exclude savedMessageRef (ref → not a dep), so our own
  // persist() does NOT re-trigger this and clobber the user's input.
  useEffect(() => {
    const incoming = initialMessage || ''
    if (debounceRef.current) return
    if (incoming === savedMessageRef.current) return
    savedMessageRef.current = incoming
    setMessage(incoming)
  }, [initialMessage])

  const persist = useCallback(async (val) => {
    setSaveState('saving')
    try {
      await onSave(scope.classId, val, scope.label)
      savedMessageRef.current = val.trim()
      setSaveState('saved')
      setTimeout(() => setSaveState(s => s === 'saved' ? null : s), 2000)
    } catch {
      setSaveState(null)
      // toast already shown by hook
    }
  }, [onSave, scope.classId, scope.label])

  const handleChange = (val) => {
    setMessage(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      if (val.trim() !== savedMessageRef.current.trim()) persist(val)
    }, 800)
  }

  // Flush on unmount (tab switch or page leave). Uses refs so we always read
  // the current message + savedMessage without re-running this effect.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
        const finalVal = messageRef.current
        if (finalVal.trim() !== savedMessageRef.current.trim()) {
          persist(finalVal).catch(() => {})
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isGlobal = scope.classId === null

  return (
    <div role="tabpanel" aria-labelledby={`scope-tab-${scope.key}`}>
      <p className="text-xs text-surface-500 leading-relaxed mb-2">
        {isGlobal ? (
          <>
            This message appears in the <strong>Mark All Done</strong> popup for{' '}
            <strong>every student</strong>, regardless of class. Use it for program-wide reminders.
          </>
        ) : (
          <>
            This message appears in the <strong>Mark All Done</strong> popup only for students
            enrolled in <strong>{scope.label}</strong>. Use it for class-specific reminders.
          </>
        )}{' '}
        Supports markdown — <code className="text-[11px] px-1 rounded bg-surface-100">**bold**</code>,
        {' '}<code className="text-[11px] px-1 rounded bg-surface-100">- bullets</code>, links, etc.
        Auto-saves as you type.
      </p>

      {/* Live student-facing preview */}
      {message.trim() && (
        <div
          className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900 mb-3"
          role="region"
          aria-label="Student preview"
          id={previewId}
        >
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wide font-bold text-amber-700 mb-1">
              Student preview
            </div>
            <ReminderMarkdownPreview text={message} className="text-sm" />
          </div>
        </div>
      )}

      <label htmlFor={messageId} className="text-xs font-semibold text-surface-500 mb-1.5 block">
        Reminder Message {isGlobal ? '(global)' : `for ${scope.courseId || scope.label}`}
      </label>
      <textarea
        ref={textareaRef}
        id={messageId}
        value={message}
        onChange={e => handleChange(e.target.value)}
        placeholder={isGlobal
          ? "e.g. **Final week!** Please make sure your tools are returned.\n\n- Sign out of your kiosk\n- Return PPE to bin"
          : `Reminders specific to ${scope.label}…\n\nSupports **bold**, *italic*, [links](https://example.com), and bullet lists.`}
        rows={8}
        className="settings-input"
        maxLength={1500}
        style={{ minHeight: '200px', resize: 'none', lineHeight: '1.5' }}
        aria-describedby={[helpId, message.trim() ? previewId : null, statusLiveId].filter(Boolean).join(' ')}
      />
      <p id={helpId} className="sr-only">
        This message will appear in the Mark All Done popup. Markdown formatting is supported.
        Press Enter twice to create a blank line between messages.
      </p>
      {/* Screen-reader-only live region: announces save progress without
          duplicating the visual SavedIndicator. Avoids reading "Saved" twice. */}
      <div id={statusLiveId} role="status" aria-live="polite" className="sr-only">
        {saveState === 'saving' && 'Saving reminder'}
        {saveState === 'saved' && 'Reminder saved'}
      </div>
      <div className="flex justify-between items-center mt-1">
        <span className="text-[10px] text-surface-400" aria-live="polite">
          {message.length}/1500 characters
        </span>
        <div className="flex items-center gap-3">
          {message.trim() && (
            <button
              type="button"
              onClick={() => handleChange('')}
              className="text-[11px] text-surface-400 hover:text-red-500 transition-colors focus-visible:ring-2 focus-visible:ring-red-400 rounded px-1"
            >
              Clear message
            </button>
          )}
          <SavedIndicator state={saveState} />
        </div>
      </div>
    </div>
  )
}

// ─── Tab strip with proper ARIA for WCAG 2.1 AA ─────────────────────────────
function ScopeTabStrip({ scopes, activeKey, onChange, reminderByScope, perStudentCountByScope = {} }) {
  const listRef = useRef(null)

  // Arrow / Home / End keyboard navigation per WAI-ARIA Authoring Practices
  const handleKeyDown = (e, idx) => {
    let nextIdx = null
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % scopes.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + scopes.length) % scopes.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = scopes.length - 1
    if (nextIdx !== null) {
      e.preventDefault()
      onChange(scopes[nextIdx].key)
      const tabs = listRef.current?.querySelectorAll('[role="tab"]')
      tabs?.[nextIdx]?.focus()
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Reminder scope"
      className="flex gap-1 overflow-x-auto pb-2 -mb-px border-b border-surface-200 settings-tab-strip"
    >
      {scopes.map((s, idx) => {
        const active = s.key === activeKey
        const hasReminder = !!reminderByScope[s.key]
        const perStudentCount = perStudentCountByScope[s.key] || 0
        const isGlobal = s.classId === null
        return (
          <button
            key={s.key}
            id={`scope-tab-${s.key}`}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={`scope-panel-${s.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(s.key)}
            onKeyDown={e => handleKeyDown(e, idx)}
            className={`relative flex items-center gap-1.5 px-3 py-2 rounded-t-md text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
              active
                ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-600 -mb-px'
                : 'text-surface-600 hover:text-surface-900 hover:bg-surface-50'
            }`}
          >
            {isGlobal ? (
              <Globe size={12} aria-hidden="true" />
            ) : (
              <BookOpen size={12} aria-hidden="true" />
            )}
            <span>{s.label}</span>
            {/* Indicators are wrapped in a labelled <span> (not relying on color
                or shape alone) so screen readers announce exactly what's set —
                WCAG 1.4.1. A solid dot = class-level reminder; a person glyph =
                per-student messages exist. Both can show when both are set. */}
            {hasReminder && (
              <span
                role="img"
                aria-label="Class reminder set"
                title="Class reminder set"
                className="inline-flex flex-shrink-0"
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${
                    active ? 'bg-indigo-600' : 'bg-amber-500'
                  }`}
                />
              </span>
            )}
            {perStudentCount > 0 && (
              <span
                role="img"
                aria-label={`${perStudentCount} per-student message${perStudentCount === 1 ? '' : 's'} set`}
                title={`${perStudentCount} per-student message${perStudentCount === 1 ? '' : 's'} set`}
                className="inline-flex flex-shrink-0"
              >
                <UserCircle
                  size={12}
                  aria-hidden="true"
                  className={active ? 'text-indigo-600' : 'text-amber-500'}
                />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Per-Student Reminders ──────────────────────────────────────────────────
/**
 * PerStudentReminders — appears inside each class tab below the class message
 * editor. Lists per-student override messages for THIS class, with auto-save
 * and Add-on-demand creation.
 *
 * Add flow:
 *   1. Click "+ Add per-student message" → dropdown of enrolled students who
 *      don't already have an override
 *   2. Pick a student → an empty card appears immediately AND a placeholder
 *      row is persisted by typing (no row exists in DB until first save)
 *
 * Delete flow:
 *   • Click × on a card → calls onSave(classId, '', label, userEmail), which
 *     setReminder() treats as "blank message → DELETE row"
 *   • Blanking the textarea has the same effect on blur
 *
 * Realtime: parent (WeeklyLabsSettings) already subscribes to weekly_reminders
 * via useWeeklyReminders(), so new/edited/deleted rows flow in via props.
 */
function PerStudentReminders({ classId, classLabel, reminders, onSave }) {
  const { students, loading: studentsLoading } = useStudentsInClass(classId)
  const [adding, setAdding] = useState(false)        // shows the dropdown when true
  const [pickerValue, setPickerValue] = useState('') // controlled select
  // Locally-added emails that don't yet have a DB row (so the empty card renders)
  const [draftEmails, setDraftEmails] = useState([])
  const addButtonRef = useRef(null)
  const pickerRef = useRef(null)

  // Existing per-student rows for this class
  const existing = useMemo(
    () => (reminders || [])
      .filter(r => r.class_id === classId && r.user_email)
      .filter(r => r.message && r.message.trim()),
    [reminders, classId]
  )

  // Clean up draft emails once their row arrives via realtime
  useEffect(() => {
    if (draftEmails.length === 0) return
    const persistedEmails = new Set(existing.map(r => r.user_email))
    const stillDraft = draftEmails.filter(e => !persistedEmails.has(e))
    if (stillDraft.length !== draftEmails.length) {
      setDraftEmails(stillDraft)
    }
  }, [existing, draftEmails])

  // Cards = persisted rows + drafts (deduplicated; drafts get an empty message)
  const cards = useMemo(() => {
    const out = []
    const seen = new Set()
    existing.forEach(r => {
      const stu = students.find(s => s.email === r.user_email)
      out.push({
        userEmail: r.user_email,
        student: stu || null,
        message: r.message,
        isDraft: false,
      })
      seen.add(r.user_email)
    })
    draftEmails.forEach(email => {
      if (seen.has(email)) return
      const stu = students.find(s => s.email === email)
      out.push({
        userEmail: email,
        student: stu || null,
        message: '',
        isDraft: true,
      })
      seen.add(email)
    })
    // Sort by last name then first name to match useStudentsInClass ordering
    return out.sort((a, b) => {
      const aLast = (a.student?.last_name || '').toLowerCase()
      const bLast = (b.student?.last_name || '').toLowerCase()
      if (aLast !== bLast) return aLast.localeCompare(bLast)
      return (a.student?.first_name || '').toLowerCase()
        .localeCompare((b.student?.first_name || '').toLowerCase())
    })
  }, [existing, draftEmails, students])

  // Available students for the picker = enrolled minus those already with a card
  const availableStudents = useMemo(() => {
    const taken = new Set(cards.map(c => c.userEmail))
    return students.filter(s => !taken.has(s.email))
  }, [students, cards])

  const openPicker = () => {
    setPickerValue('')
    setAdding(true)
    // Focus the select after it renders
    setTimeout(() => pickerRef.current?.focus(), 50)
  }

  const cancelPicker = () => {
    setAdding(false)
    setPickerValue('')
    // Return focus to the add button
    setTimeout(() => addButtonRef.current?.focus(), 50)
  }

  const addDraft = (email) => {
    if (!email) return
    setDraftEmails(prev => prev.includes(email) ? prev : [...prev, email])
    setAdding(false)
    setPickerValue('')
  }

  const removeDraft = (email) => {
    setDraftEmails(prev => prev.filter(e => e !== email))
  }

  return (
    <section
      className="mt-6 border-t border-surface-200 pt-5"
      aria-labelledby={`ps-heading-${classId}`}
    >
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3
          id={`ps-heading-${classId}`}
          className="text-sm font-semibold text-surface-900 flex items-center gap-2"
        >
          <UserCircle size={15} className="text-indigo-600" aria-hidden="true" />
          Per-Student Messages
          {cards.length > 0 && (
            <span className="text-xs font-medium text-surface-500">({cards.length})</span>
          )}
        </h3>

        {!adding && (
          <button
            ref={addButtonRef}
            type="button"
            onClick={openPicker}
            disabled={studentsLoading || availableStudents.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-md border border-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 transition-colors"
            aria-describedby={availableStudents.length === 0 ? `ps-no-students-${classId}` : undefined}
          >
            <UserPlus size={13} aria-hidden="true" />
            Add per-student message
          </button>
        )}
      </div>

      <p className="text-xs text-surface-500 leading-relaxed mb-3">
        Personal messages shown to specific students in <strong>{classLabel}</strong>.
        Each appears as its own card in <em>Mark All Done</em> with an independent
        acknowledgment. Blank the message or click <span className="font-mono">×</span> to remove an override.
      </p>

      {/* Add picker */}
      {adding && (
        <div
          className="mb-3 p-3 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center gap-2 flex-wrap"
          role="region"
          aria-label="Choose a student to add a personal message for"
        >
          <label
            htmlFor={`ps-picker-${classId}`}
            className="text-xs font-semibold text-indigo-900"
          >
            Add message for:
          </label>
          <select
            ref={pickerRef}
            id={`ps-picker-${classId}`}
            value={pickerValue}
            onChange={(e) => setPickerValue(e.target.value)}
            className="flex-1 min-w-[180px] px-3 py-1.5 min-h-[32px] text-sm border border-indigo-300 rounded-md bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            <option value="">— pick a student —</option>
            {availableStudents.map(s => (
              <option key={s.email} value={s.email}>
                {s.first_name} {(s.last_name || '').charAt(0)}. ({s.email})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => addDraft(pickerValue)}
            disabled={!pickerValue}
            className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[32px] text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            <Plus size={12} aria-hidden="true" />
            Add
          </button>
          <button
            type="button"
            onClick={cancelPicker}
            className="inline-flex items-center gap-1 px-2 py-1.5 min-h-[32px] text-xs font-medium text-surface-600 hover:text-surface-900 hover:bg-surface-100 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-surface-400"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Empty states */}
      {cards.length === 0 && !adding && (
        studentsLoading ? (
          <div className="text-xs text-surface-500 italic flex items-center gap-2 py-3">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            Loading students…
          </div>
        ) : students.length === 0 ? (
          <div className="text-xs text-surface-500 italic py-3">
            No students are currently enrolled in this class.
          </div>
        ) : (
          <div
            id={`ps-no-students-${classId}`}
            className="text-xs text-surface-500 italic py-3"
          >
            No per-student messages yet. Click <strong>Add per-student message</strong> above to send
            a personal note to a specific student in this class.
          </div>
        )
      )}

      {availableStudents.length === 0 && students.length > 0 && cards.length > 0 && !adding && (
        <div className="text-[11px] text-surface-500 italic mb-3">
          Every enrolled student already has a per-student message in this class.
        </div>
      )}

      {/* Per-student cards */}
      {cards.length > 0 && (
        <div className="space-y-3" aria-live="polite">
          {cards.map(card => (
            <PerStudentCard
              key={card.userEmail}
              classId={classId}
              classLabel={classLabel}
              userEmail={card.userEmail}
              student={card.student}
              initialMessage={card.message}
              isDraft={card.isDraft}
              onSave={onSave}
              onRemoveDraft={() => removeDraft(card.userEmail)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * PerStudentCard — one editable per-student message. Mirrors the auto-save +
 * mid-edit conflict-guard pattern of ReminderEditor, scaled down to a
 * single-card layout. Each card auto-saves 800ms after the user stops typing
 * AND on blur AND on unmount (matching the existing pattern).
 *
 * Blank message on blur/unmount → setReminder() deletes the underlying row.
 * For drafts (no DB row yet), blanking does nothing; the parent removes the
 * draft card via the × button or implicit cancel.
 */
function PerStudentCard({
  classId, classLabel, userEmail, student,
  initialMessage, isDraft, onSave, onRemoveDraft,
}) {
  const [message, setMessage] = useState(initialMessage || '')
  const [saveState, setSaveState] = useState(null)
  const savedMessageRef = useRef(initialMessage || '')
  const messageRef = useRef(initialMessage || '')
  const debounceRef = useRef(null)
  const textareaRef = useRef(null)
  const messageId = useId()
  const helpId = useId()

  useAutoGrowTextarea(message, textareaRef, { min: 100, max: 280 })

  useEffect(() => { messageRef.current = message }, [message])

  // Re-sync from realtime (other instructor edited the same row)
  useEffect(() => {
    const incoming = initialMessage || ''
    if (debounceRef.current) return
    if (incoming === savedMessageRef.current) return
    savedMessageRef.current = incoming
    setMessage(incoming)
  }, [initialMessage])

  // Auto-focus a freshly-added draft card so the instructor starts typing
  useEffect(() => {
    if (isDraft) {
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persist = useCallback(async (val) => {
    setSaveState('saving')
    try {
      await onSave(classId, val, classLabel, userEmail)
      savedMessageRef.current = val.trim()
      setSaveState('saved')
      setTimeout(() => setSaveState(s => s === 'saved' ? null : s), 2000)
    } catch {
      setSaveState(null)
    }
  }, [onSave, classId, classLabel, userEmail])

  const handleChange = (val) => {
    setMessage(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      if (val.trim() !== savedMessageRef.current.trim()) persist(val)
    }, 800)
  }

  const handleBlur = () => {
    // Flush pending save immediately on blur
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
      const val = messageRef.current
      if (val.trim() !== savedMessageRef.current.trim()) persist(val)
    }
  }

  const handleRemove = async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    if (isDraft && !message.trim()) {
      // Draft with no content — just remove the card locally
      onRemoveDraft?.()
      return
    }
    // Real row OR draft with typed content — clear via setReminder (deletes row if exists)
    setMessage('')
    setSaveState('saving')
    try {
      await onSave(classId, '', classLabel, userEmail)
      savedMessageRef.current = ''
      setSaveState(null)
      if (isDraft) onRemoveDraft?.()
    } catch {
      setSaveState(null)
    }
  }

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
        const finalVal = messageRef.current
        if (finalVal.trim() !== savedMessageRef.current.trim()) {
          persist(finalVal).catch(() => {})
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const displayName = student
    ? `${student.first_name} ${(student.last_name || '').charAt(0)}.`
    : userEmail

  return (
    <div className="rounded-lg border border-surface-200 bg-white shadow-sm overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-3 py-2 bg-indigo-50 border-b border-indigo-100">
        <div className="flex items-center gap-2 min-w-0">
          <UserCircle size={14} className="text-indigo-600 flex-shrink-0" aria-hidden="true" />
          <span className="text-xs font-semibold text-indigo-900 truncate">
            {displayName}
          </span>
          <span className="text-[10px] text-indigo-700 truncate hidden sm:inline">
            ({userEmail})
          </span>
          {isDraft && (
            <span className="text-[10px] font-medium text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">
              Draft — type to save
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleRemove}
          className="p-1 min-h-[28px] min-w-[28px] flex items-center justify-center text-surface-500 hover:text-red-600 hover:bg-red-50 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-400 transition-colors"
          aria-label={`Remove per-student message for ${displayName}`}
          title="Remove this per-student message"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="p-3 space-y-1">
        <label htmlFor={messageId} className="sr-only">
          Personal message for {displayName}
        </label>
        <textarea
          ref={textareaRef}
          id={messageId}
          value={message}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          placeholder={`Type a personal message for ${displayName}…`}
          maxLength={1500}
          aria-describedby={helpId}
          className="w-full px-3 py-2 text-sm border border-surface-300 rounded-md resize-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 focus-visible:border-indigo-500"
          style={{ minHeight: 80 }}
        />
        <div className="flex justify-between items-center gap-3">
          <span id={helpId} className="text-[10px] text-surface-400">
            {message.length}/1500 — supports markdown · auto-saves
          </span>
          <SavedIndicator state={saveState} />
        </div>
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY LABS — REMINDER EDITOR
// ═══════════════════════════════════════════════════════════════════════════════

function WeeklyLabsSettings() {
  const { reminders, loading: remindersLoading } = useWeeklyReminders()
  const { items: classList, loading: classesLoading } = useClasses()
  const { setReminder } = useWeeklyReminderActions()

  const [activeKey, setActiveKey] = useState('global')
  const [historyOpen, setHistoryOpen] = useState(false)

  // Build scopes: global first, then active classes
  const scopes = useMemo(() => {
    const list = [{
      key: 'global',
      classId: null,
      label: 'All Classes',
      courseId: 'Global',
    }]
    const active = (classList || [])
      .filter(c => {
        const s = (c.status || '').toLowerCase()
        return s === 'active' || s === ''
      })
      .sort((a, b) => (a.course_id || '').localeCompare(b.course_id || ''))
    active.forEach(c => {
      const lbl = c.semester ? `${c.course_id} (${c.semester})` : (c.course_id || c.class_id)
      list.push({
        key: c.class_id,
        classId: c.class_id,
        label: lbl,
        courseId: c.course_id,
      })
    })
    return list
  }, [classList])

  // Map scope key → CLASS-LEVEL message string (drives the tab dot + the active
  // editor seed). Per-student override rows also live in `weekly_reminders` under
  // the same class_id but carry a user_email — they must NOT count here, or a
  // lingering per-student message would (a) keep the tab dot lit after the class
  // message is cleared and (b) bleed into the class editor on re-seed.
  const reminderByScope = useMemo(() => {
    const m = {}
    for (const r of reminders) {
      if (r.user_email) continue // skip per-student overrides — class-level only
      if (!r.message || !r.message.trim()) continue
      const key = r.class_id === null || r.class_id === undefined ? 'global' : r.class_id
      m[key] = r.message
    }
    return m
  }, [reminders])

  // Map class_id → count of per-student override messages (drives the secondary
  // tab indicator). Global scope ('All Classes') never has per-student rows.
  const perStudentCountByScope = useMemo(() => {
    const m = {}
    for (const r of reminders) {
      if (!r.user_email) continue        // class-level/global handled above
      if (!r.class_id) continue          // per-student rows are always class-scoped
      if (!r.message || !r.message.trim()) continue
      m[r.class_id] = (m[r.class_id] || 0) + 1
    }
    return m
  }, [reminders])

  const activeScope = scopes.find(s => s.key === activeKey) || scopes[0]
  const activeInitialMessage = reminderByScope[activeScope.key] || ''

  if (remindersLoading || classesLoading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading reminders…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SettingCard
        icon={MessageSquare}
        title="Mark All Done — Weekly Reminders"
        actions={
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 px-2.5 py-1.5 rounded-md hover:bg-indigo-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <History size={13} aria-hidden="true" />
            View history
          </button>
        }
        footer={
          <>
            <Info size={13} className="settings-card-footer-icon" aria-hidden="true" />
            <span>
              Reminders are scoped per class — students see the global reminder plus any
              reminders set for the classes they're enrolled in. Each must be acknowledged
              separately in the Mark All Done popup. All changes are recorded in history.
            </span>
          </>
        }
      >
        <div className="settings-card-body--padded space-y-3">
          <ScopeTabStrip
            scopes={scopes}
            activeKey={activeKey}
            onChange={setActiveKey}
            reminderByScope={reminderByScope}
            perStudentCountByScope={perStudentCountByScope}
          />

          <div id={`scope-panel-${activeScope.key}`}>
            <ReminderEditor
              key={activeScope.key}
              scope={activeScope}
              initialMessage={activeInitialMessage}
              onSave={setReminder}
            />
          </div>

          {/* Per-student overrides — class scopes only, not on "All Classes" tab */}
          {activeScope.classId !== null && (
            <PerStudentReminders
              key={`ps-${activeScope.key}`}
              classId={activeScope.classId}
              classLabel={activeScope.label}
              reminders={reminders}
              onSave={setReminder}
            />
          )}
        </div>
      </SettingCard>

      <WeeklyReminderHistoryModal
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        classes={classList || []}
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATION (WOC RATIO) SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

function EvaluationSettings() {
  const { settings, loading } = useSettings()
  const actions = useSettingsActions()
  const [edits, setEdits] = useState({})

  const settingsMap = useMemo(() => {
    const m = {}
    settings.forEach(s => { m[s.setting_key] = s.setting_value })
    return m
  }, [settings])

  const saveFn = useCallback(async (key, value) => {
    const meta = EVAL_SETTINGS.find(e => e.key === key)
    if (!meta) return false
    const valueToSave = (value === '' || value === undefined) ? meta.default : String(value)
    return await actions.updateSetting(key, valueToSave, {
      silent: true,
      category: 'Evaluation',
      description: meta.desc,
    })
  }, [actions])

  const { queueSave, flushSave, saveState, pendingValuesRef } = useAutoSave(saveFn)

  // Sync edits from server, defaulting missing rows to documented defaults
  useEffect(() => {
    setEdits(prev => {
      const next = {}
      EVAL_SETTINGS.forEach(es => {
        if (pendingValuesRef.current[es.key] !== undefined) {
          next[es.key] = prev[es.key] ?? es.default
          return
        }
        const live = settingsMap[es.key]
        next[es.key] = (live !== undefined && live !== null && live !== '')
          ? String(live)
          : es.default
      })
      return next
    })
  }, [settingsMap, pendingValuesRef])

  const handleChange = (key, value) => {
    setEdits(prev => ({ ...prev, [key]: value }))
    queueSave(key, value)
  }

  const handleResetDefault = (key) => {
    const meta = EVAL_SETTINGS.find(e => e.key === key)
    if (!meta) return
    handleChange(key, meta.default)
  }

  if (loading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading evaluation settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Intro context card */}
      <div className="settings-note">
        <Target size={16} className="settings-note-icon" aria-hidden="true" />
        <div className="settings-note-body">
          <p className="settings-note-title">WOC Ratio Scoring</p>
          <p className="settings-note-text">
            These seven knobs tune the student evaluation score. Changes auto-save and take effect immediately
            on the WOC Ratio page. Custom closed days and US holiday handling are managed separately
            on the WOC Ratio page itself.
          </p>
        </div>
      </div>

      {/* Settings list */}
      <SettingCard icon={Sliders} title="Scoring Parameters">
        {EVAL_SETTINGS.map(es => {
          const isUnset = settingsMap[es.key] === undefined || settingsMap[es.key] === null || settingsMap[es.key] === ''
          const inputId = `eval-${es.key}`
          const isAtDefault = String(edits[es.key]) === String(es.default)
          return (
            <SettingRow
              key={es.key}
              id={`setting-${es.key}`}
              label={es.label}
              labelFor={inputId}
              helper={es.desc}
              details={es.details}
              defaultHint={isUnset ? `Using default (${es.default}${es.suffix ? ' ' + es.suffix : ''}) — no override saved.` : null}
            >
              <DebouncedInput
                id={inputId}
                type="number"
                inputMode="decimal"
                min={es.min}
                step={es.step}
                value={edits[es.key] ?? ''}
                onChange={(v) => handleChange(es.key, v)}
                onBlur={() => flushSave(es.key)}
                className="settings-input--num"
                aria-describedby={`${inputId}-suffix`}
                suffix={es.suffix && <span id={`${inputId}-suffix`}>{es.suffix}</span>}
              />
              <button
                type="button"
                onClick={() => handleResetDefault(es.key)}
                disabled={isAtDefault}
                className="settings-icon-btn"
                title={`Reset to default (${es.default})`}
                aria-label={`Reset ${es.label} to default value of ${es.default}`}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
              <SavedIndicator state={saveState[es.key]} />
            </SettingRow>
          )
        })}
      </SettingCard>

      {/* Footer note about closed days */}
      <div className="settings-note">
        <Calendar size={15} className="settings-note-icon" aria-hidden="true" />
        <div className="settings-note-body">
          <p className="settings-note-text">
            Custom school closed days are managed on the <strong>WOC Ratio</strong> page under the{' '}
            <em>Closed Days</em> tab. They affect the school-day count used by every penalty and reward here.
          </p>
        </div>
      </div>
    </div>
  )
}
// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG SETTINGS — retention, purge, suspicious thresholds, read tracking
// ═══════════════════════════════════════════════════════════════════════════════

function AuditLogSettings() {
  const { profile, realProfile, isEmulating } = useAuth()
  const { settings, loading } = useSettings()
  const actions = useSettingsActions()
  const [edits, setEdits] = useState({})

  // Super admin check (matches usePermissions pattern: real super admin AND not emulating)
  const isSuperAdmin = realProfile?.email?.toLowerCase() === 'rictprogram@gmail.com' && !isEmulating

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const settingsMap = useMemo(() => {
    const m = {}
    settings.forEach(s => { m[s.setting_key] = s.setting_value })
    return m
  }, [settings])

  // ── Numeric settings (retention + suspicious thresholds) ──
  const saveFn = useCallback(async (key, value) => {
    const meta = AUDIT_SETTINGS.find(e => e.key === key)
    if (!meta) return false
    const valueToSave = (value === '' || value === undefined) ? meta.default : String(value)
    return await actions.updateSetting(key, valueToSave, {
      silent: true,
      category: 'audit',
      description: meta.desc,
    })
  }, [actions])

  const { queueSave, flushSave, saveState, pendingValuesRef } = useAutoSave(saveFn)

  useEffect(() => {
    setEdits(prev => {
      const next = {}
      AUDIT_SETTINGS.forEach(es => {
        if (pendingValuesRef.current[es.key] !== undefined) {
          next[es.key] = prev[es.key] ?? es.default
          return
        }
        const live = settingsMap[es.key]
        next[es.key] = (live !== undefined && live !== null && live !== '')
          ? String(live)
          : es.default
      })
      return next
    })
  }, [settingsMap, pendingValuesRef])

  const handleChange = (key, value) => {
    setEdits(prev => ({ ...prev, [key]: value }))
    queueSave(key, value)
  }

  const handleResetDefault = (key) => {
    const meta = AUDIT_SETTINGS.find(e => e.key === key)
    if (!meta) return
    handleChange(key, meta.default)
  }

  // ── Tracked entities ──
  const [trackedRaw, setTrackedRaw] = useState('')
  const [trackedSaving, setTrackedSaving] = useState(false)
  const [trackedSavedFlash, setTrackedSavedFlash] = useState(false)
  const trackedLive = settingsMap.audit_track_view_entities ?? ''

  useEffect(() => { setTrackedRaw(String(trackedLive)) }, [trackedLive])

  const trackedDirty = useMemo(() => {
    const norm = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean).join(',')
    return norm(trackedRaw) !== norm(trackedLive)
  }, [trackedRaw, trackedLive])

  const saveTrackedEntities = async () => {
    setTrackedSaving(true)
    try {
      const cleaned = trackedRaw.split(',').map(s => s.trim()).filter(Boolean).join(',')
      await actions.updateSetting('audit_track_view_entities', cleaned, {
        silent: true,
        category: 'audit',
        description: 'Comma-separated entity types whose page-views are tracked',
      })
      setTrackedSavedFlash(true)
      setTimeout(() => setTrackedSavedFlash(false), 2000)
    } finally {
      setTrackedSaving(false)
    }
  }

  // ── Failed-write counter ──
  const failedCount = Number(settingsMap.audit_failed_count) || 0
  const [resettingFailed, setResettingFailed] = useState(false)

  const resetFailedCount = async () => {
    setResettingFailed(true)
    try {
      await actions.updateSetting('audit_failed_count', '0', {
        silent: true,
        category: 'audit',
        description: 'Counter of failed audit_log INSERTs since last reset',
      })
      toast.success('Failed-write counter reset to 0')
      try {
        await supabase.from('audit_log').insert({
          user_email: profile?.email,
          user_name:  userName,
          action:      'Reset',
          entity_type: 'Audit Log',
          entity_id:   'FAILED_COUNT',
          details:     'Reset failed audit write counter to 0 from Settings',
        })
      } catch {}
    } catch (e) {
      toast.error(e.message || 'Could not reset')
    } finally {
      setResettingFailed(false)
    }
  }

  // ── Purge ──
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgePreview, setPurgePreview] = useState(null)
  const [purgeLoading, setPurgeLoading] = useState(false)
  const [purgeExecuting, setPurgeExecuting] = useState(false)
  const purgeDialogRef = useDialogA11y(purgeOpen, () => {
    if (purgeExecuting) return
    setPurgeOpen(false); setPurgePreview(null)
  })

  const openPurge = async () => {
    const days = Number(edits.audit_retention_days) || 730
    if (days < 30) {
      toast.error('Retention must be at least 30 days to purge (safety minimum).')
      return
    }
    setPurgeOpen(true)
    setPurgeLoading(true)
    setPurgePreview(null)
    try {
      const { data, error: err } = await supabase.rpc('audit_log_purge_preview', { p_days_to_keep: days })
      if (err) throw err
      setPurgePreview(data)
    } catch (e) {
      toast.error(e.message || 'Preview failed')
      setPurgeOpen(false)
    } finally {
      setPurgeLoading(false)
    }
  }

  const executePurge = async () => {
    const days = Number(edits.audit_retention_days) || 730
    setPurgeExecuting(true)
    try {
      const { data, error: err } = await supabase.rpc('audit_log_purge', { p_days_to_keep: days })
      if (err) throw err
      toast.success(`Purged ${(data ?? 0).toLocaleString()} audit log entries`)
      setPurgeOpen(false); setPurgePreview(null)
    } catch (e) {
      toast.error(e.message || 'Purge failed')
    } finally {
      setPurgeExecuting(false)
    }
  }

  if (loading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading audit log settings…</p>
      </div>
    )
  }

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* Intro */}
      <div className="settings-note">
        <FileSearch size={16} className="settings-note-icon" aria-hidden="true" />
        <div className="settings-note-body">
          <p className="settings-note-title">Audit Log</p>
          <p className="settings-note-text">
            Control retention, monitoring sensitivity, and which entity views are tracked.
            Numeric settings auto-save. The Audit Log viewer is at{' '}
            <strong>Administration → Audit Log</strong>.
          </p>
        </div>
      </div>

      {/* ── Retention + Failed Writes + Purge ───────────────────────────── */}
      <SettingCard icon={History} title="Retention &amp; Purge">
        {[AUDIT_SETTINGS[0]].map(es => {
          const isUnset    = settingsMap[es.key] === undefined || settingsMap[es.key] === null || settingsMap[es.key] === ''
          const inputId    = `audit-${es.key}`
          const isAtDefault = String(edits[es.key]) === String(es.default)
          return (
            <SettingRow
              key={es.key}
              id={`setting-${es.key}`}
              label={es.label}
              labelFor={inputId}
              helper={es.desc}
              details={es.details}
              defaultHint={isUnset ? `Using default (${es.default} ${es.suffix}) — no override saved.` : null}
            >
              <DebouncedInput
                id={inputId}
                type="number"
                inputMode="decimal"
                min={es.min}
                step={es.step}
                value={edits[es.key] ?? ''}
                onChange={(v) => handleChange(es.key, v)}
                onBlur={() => flushSave(es.key)}
                className="settings-input--num"
                aria-describedby={`${inputId}-suffix`}
                suffix={<span id={`${inputId}-suffix`}>{es.suffix}</span>}
              />
              <button
                type="button"
                onClick={() => handleResetDefault(es.key)}
                disabled={isAtDefault}
                className="settings-icon-btn"
                title={`Reset to default (${es.default})`}
                aria-label={`Reset ${es.label} to default value of ${es.default}`}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
              <SavedIndicator state={saveState[es.key]} />
            </SettingRow>
          )
        })}

        <SettingRow
          id="setting-audit_failed_count"
          label="Failed Audit Writes"
          helper="Counter incremented by Phase 2's writeAudit() helper when an insert fails. A non-zero value indicates audit data may be incomplete."
        >
          <span
            className={
              'inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium border ' +
              (failedCount > 0
                ? 'bg-amber-100 text-amber-800 border-amber-300'
                : 'bg-green-100 text-green-800 border-green-300')
            }
            aria-live="polite"
          >
            {failedCount.toLocaleString()} failed
          </span>
          <button
            type="button"
            onClick={resetFailedCount}
            disabled={failedCount === 0 || resettingFailed}
            className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[32px] text-sm font-medium text-surface-700 bg-white border border-surface-300 rounded-lg hover:bg-surface-50 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Reset failed-write counter to zero"
          >
            {resettingFailed && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Reset to 0
          </button>
        </SettingRow>

        <SettingRow
          id="setting-audit_purge_now"
          label="Purge Old Entries"
          helper={isSuperAdmin
            ? 'Permanently delete entries older than the retention period above. The purge action itself is recorded as a new audit log entry. Cannot be undone.'
            : 'Only Super Admin can purge audit log entries.'}
        >
          <button
            type="button"
            onClick={openPurge}
            disabled={!isSuperAdmin || purgeLoading || purgeExecuting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
            aria-label="Preview audit log purge"
          >
            <Trash2 size={14} aria-hidden="true" />
            Purge Now
          </button>
        </SettingRow>
      </SettingCard>

      {/* ── Suspicious Activity Thresholds ────────────────────────────────── */}
      <SettingCard icon={AlertTriangle} title="Suspicious Activity Thresholds">
        {AUDIT_SETTINGS.slice(1).map(es => {
          const isUnset     = settingsMap[es.key] === undefined || settingsMap[es.key] === null || settingsMap[es.key] === ''
          const inputId     = `audit-${es.key}`
          const isAtDefault = String(edits[es.key]) === String(es.default)
          return (
            <SettingRow
              key={es.key}
              id={`setting-${es.key}`}
              label={es.label}
              labelFor={inputId}
              helper={es.desc}
              details={es.details}
              defaultHint={isUnset ? `Using default (${es.default} ${es.suffix}) — no override saved.` : null}
            >
              <DebouncedInput
                id={inputId}
                type="number"
                inputMode="decimal"
                min={es.min}
                step={es.step}
                value={edits[es.key] ?? ''}
                onChange={(v) => handleChange(es.key, v)}
                onBlur={() => flushSave(es.key)}
                className="settings-input--num"
                aria-describedby={`${inputId}-suffix`}
                suffix={<span id={`${inputId}-suffix`}>{es.suffix}</span>}
              />
              <button
                type="button"
                onClick={() => handleResetDefault(es.key)}
                disabled={isAtDefault}
                className="settings-icon-btn"
                title={`Reset to default (${es.default})`}
                aria-label={`Reset ${es.label} to default value of ${es.default}`}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
              <SavedIndicator state={saveState[es.key]} />
            </SettingRow>
          )
        })}
      </SettingCard>

      {/* ── Read Tracking ────────────────────────────────────────────────── */}
      <SettingCard icon={Eye} title="Read Tracking — Entity Allowlist">
        <SettingRow
          id="setting-audit_track_view_entities"
          label="Tracked Entity Types"
          labelFor="audit-track-input"
          helper='Comma-separated entity types whose page-views are written to audit_log as action="View". Leave empty to disable read tracking.'
          details={{
            what: 'When a page calls trackView(entityType, entityId), the call only writes an audit row if entityType appears in this list.',
            where: 'Wired into the Audit Log page itself; UsersPage and AccessPage can opt-in via a one-line useEffect (see Phase 1 follow-up notes).',
            effect: 'Lets you meta-audit access to sensitive pages without instrumenting every page. Keep the list short — every tracked view creates a row.',
          }}
        >
          <input
            id="audit-track-input"
            type="text"
            value={trackedRaw}
            onChange={e => setTrackedRaw(e.target.value)}
            className="settings-input"
            placeholder="Users, Audit Log, Access Page, Settings"
            aria-label="Tracked entity types, comma-separated"
          />
          <button
            type="button"
            onClick={saveTrackedEntities}
            disabled={trackedSaving || !trackedDirty}
            className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[32px] text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            {trackedSaving
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <Save size={14} aria-hidden="true" />}
            Save
          </button>
          {trackedSavedFlash && (
            <span className="text-xs text-green-700 flex items-center gap-1" aria-live="polite">
              <CheckCircle2 size={12} aria-hidden="true" /> Saved
            </span>
          )}
        </SettingRow>
      </SettingCard>

      {/* Purge confirmation modal */}
      {purgeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="audit-purge-title"
          onClick={e => {
            if (e.target === e.currentTarget && !purgeExecuting) {
              setPurgeOpen(false); setPurgePreview(null)
            }
          }}
        >
          <div
            ref={purgeDialogRef}
            className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col"
          >
            <div className="flex items-center justify-between p-4 border-b border-surface-200">
              <h2 id="audit-purge-title" className="text-base font-semibold text-surface-900 flex items-center gap-2">
                <AlertTriangle size={18} className="text-red-600" aria-hidden="true" />
                Confirm Audit Log Purge
              </h2>
              <button
                type="button"
                onClick={() => { setPurgeOpen(false); setPurgePreview(null) }}
                disabled={purgeExecuting}
                className="p-1 min-h-[32px] min-w-[32px] flex items-center justify-center text-surface-500 hover:text-surface-900 rounded-md hover:bg-surface-100 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                aria-label="Close"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              {purgeLoading ? (
                <div className="text-center py-4">
                  <Loader2 size={20} className="mx-auto mb-2 animate-spin text-brand-500" aria-hidden="true" />
                  Counting entries to purge…
                </div>
              ) : (
                <>
                  <p className="text-surface-800">
                    This will permanently delete{' '}
                    <strong className="text-red-600">{(purgePreview ?? 0).toLocaleString()}</strong>{' '}
                    audit log {purgePreview === 1 ? 'entry' : 'entries'} older than{' '}
                    <strong>{edits.audit_retention_days || 730} days</strong>.
                  </p>
                  <p className="text-xs text-surface-600">
                    The purge itself will be recorded as a new audit log entry. This action cannot be undone.
                  </p>
                  {purgePreview === 0 && (
                    <div className="p-2 bg-green-50 border border-green-200 rounded-md text-xs text-green-800">
                      Nothing to purge — no entries are older than the retention period.
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="px-4 py-3 border-t border-surface-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setPurgeOpen(false); setPurgePreview(null) }}
                disabled={purgeExecuting}
                className="px-3 py-1.5 min-h-[32px] text-sm font-medium text-surface-700 bg-white border border-surface-300 rounded-lg hover:bg-surface-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executePurge}
                disabled={purgeLoading || purgeExecuting || !purgePreview}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
              >
                {purgeExecuting && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {purgeExecuting
                  ? 'Purging…'
                  : `Purge ${(purgePreview ?? 0).toLocaleString()} ${purgePreview === 1 ? 'Entry' : 'Entries'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC CRUD TABLE SECTION
// Used by: Categories, Asset Locations, Inventory Locations, Vendors, WO Statuses
// Functionally preserved from previous version; wrapped in SettingCard for visual consistency.
// ═══════════════════════════════════════════════════════════════════════════════

function CrudSection({ title, icon: Icon, useItemsHook, useActionsHook, idColumn, columns, defaultItem, searchable }) {
  const { items, loading, refresh } = useItemsHook()
  const actions = useActionsHook()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({})
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search || !searchable) return items
    const s = search.toLowerCase()
    return items.filter(item =>
      columns.some(col => String(item[col.key] || '').toLowerCase().includes(s))
    )
  }, [items, search, searchable, columns])

  const startAdd = () => { setForm({ ...defaultItem }); setEditing('new') }
  const startEdit = (item) => { setForm({ ...item }); setEditing(item) }
  const cancel = () => { setEditing(null); setForm({}) }

  const handleSave = async () => {
    try {
      const validated = { ...form }
      columns.forEach(col => {
        if (col.type === 'color' && !validated[col.key]) validated[col.key] = '#228be6'
      })

      if (editing === 'new') {
        await actions.addItem(validated)
      } else {
        const updates = { ...validated }
        delete updates[idColumn]
        await actions.updateItem(validated[idColumn], updates)
      }
      cancel()
      refresh()
    } catch {}
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this item?')) return
    try {
      await actions.deleteItem(id)
      refresh()
    } catch {}
  }

  if (loading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  // Header right-side actions: search + Add
  const headerActions = (
    <>
      {searchable && items.length > 8 && (
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="input text-xs pl-7 w-32"
            aria-label={`Search ${title}`}
          />
        </div>
      )}
      <button
        type="button"
        onClick={startAdd}
        className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1 px-2 py-1 rounded"
      >
        <Plus size={12} aria-hidden="true" /> Add
      </button>
    </>
  )

  return (
    <SettingCard icon={Icon} title={title} count={items.length} actions={headerActions}>
      {/* Add/Edit Form */}
      {editing && (
        <div className="px-4 py-3 bg-brand-50 border-b border-brand-100 space-y-2">
          <div className="text-xs font-semibold text-brand-700 mb-1">
            {editing === 'new' ? 'Add New' : 'Edit'}
          </div>
          <div className="flex flex-wrap gap-2">
            {columns.filter(col => col.key !== idColumn || editing === 'new').map(col => (
              <div key={col.key} className={`${col.wide ? 'flex-[2]' : 'flex-1'} min-w-[120px]`}>
                <label className="text-[10px] text-surface-500 font-medium block mb-0.5">{col.label}</label>
                {col.type === 'select' ? (
                  <select
                    value={form[col.key] || ''}
                    onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                    className="input text-sm"
                  >
                    {col.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : col.type === 'color' ? (
                  <div className="flex gap-1 items-center">
                    <input
                      type="color"
                      value={form[col.key] || '#228be6'}
                      onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                      className="w-8 h-8 rounded cursor-pointer border-0"
                      aria-label={`${col.label} color picker`}
                    />
                    <input
                      type="text"
                      value={form[col.key] || ''}
                      onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                      className="input text-sm flex-1"
                      placeholder="#228be6"
                      aria-label={`${col.label} hex value`}
                    />
                  </div>
                ) : (
                  <input
                    type={col.type || 'text'}
                    value={form[col.key] || ''}
                    onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                    className="input text-sm"
                    placeholder={col.placeholder || ''}
                    readOnly={col.key === idColumn}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={actions.saving}
              className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1 hover:bg-brand-700 disabled:opacity-50"
            >
              {actions.saving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />} Save
            </button>
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs hover:bg-surface-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 text-surface-400 text-sm">
          {search ? 'No matches found' : 'No items yet'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-50 text-left">
                {columns.map(col => (
                  <th key={col.key} className="px-4 py-2 text-xs font-semibold text-surface-600">{col.label}</th>
                ))}
                <th className="px-4 py-2 text-xs font-semibold text-surface-600 w-20">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-100">
              {filtered.map((item, idx) => (
                <tr key={item[idColumn] || idx} className="hover:bg-surface-50">
                  {columns.map(col => (
                    <td key={col.key} className="px-4 py-2 text-surface-700">
                      {col.type === 'color' ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-4 h-4 rounded" style={{ backgroundColor: item[col.key] || '#ccc' }} aria-hidden="true" />
                          {String(item[col.key] ?? '')}
                        </span>
                      ) : col.key === 'status' ? (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                          item[col.key] === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-100 text-surface-500'
                        }`}>{item[col.key] || '—'}</span>
                      ) : col.key === 'is_closed' || col.key === 'is_closed_status' ? (
                        <span className={`text-xs font-medium ${item[col.key] === 'Yes' ? 'text-red-600' : 'text-surface-400'}`}>
                          {item[col.key] || 'No'}
                        </span>
                      ) : (
                        String(item[col.key] ?? '—')
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        className="p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-brand-600"
                        aria-label={`Edit ${item[idColumn] || 'item'}`}
                        title="Edit"
                      >
                        <Edit3 size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(item[idColumn])}
                        className="p-1 rounded hover:bg-red-50 text-surface-400 hover:text-red-500"
                        aria-label={`Delete ${item[idColumn] || 'item'}`}
                        title="Delete"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingCard>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOOKUP-TABLE SECTION WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════════

function CategoriesSection() {
  return <CrudSection
    title="Categories"
    icon={Tag}
    useItemsHook={useCategories}
    useActionsHook={useCategoryActions}
    idColumn="category_id"
    columns={[
      { key: 'category_id', label: 'ID' },
      { key: 'category_name', label: 'Name', wide: true },
      { key: 'description', label: 'Description', wide: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]}
    defaultItem={{ category_name: '', description: '', status: 'Active' }}
  />
}

function AssetLocationsSection() {
  return <CrudSection
    title="Asset Locations"
    icon={MapPin}
    useItemsHook={useAssetLocations}
    useActionsHook={useAssetLocationActions}
    idColumn="location_id"
    columns={[
      { key: 'location_id', label: 'ID' },
      { key: 'location_name', label: 'Name', wide: true },
      { key: 'description', label: 'Description', wide: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]}
    defaultItem={{ location_name: '', description: '', status: 'Active' }}
  />
}

function InventoryLocationsSection() {
  return <CrudSection
    title="Inventory Locations"
    icon={Box}
    useItemsHook={useInventoryLocations}
    useActionsHook={useInventoryLocationActions}
    idColumn="location_id"
    searchable
    columns={[
      { key: 'location_id', label: 'ID' },
      { key: 'location_name', label: 'Name', wide: true },
      { key: 'description', label: 'Description', wide: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]}
    defaultItem={{ location_name: '', description: '', status: 'Active' }}
  />
}

function VendorsSection() {
  return <CrudSection
    title="Vendors"
    icon={Truck}
    useItemsHook={useVendorsList}
    useActionsHook={useVendorActions}
    idColumn="vendor_id"
    searchable
    columns={[
      { key: 'vendor_id', label: 'ID' },
      { key: 'vendor_name', label: 'Name', wide: true },
      { key: 'contact_name', label: 'Contact' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'website', label: 'Website' },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]}
    defaultItem={{ vendor_name: '', contact_name: '', phone: '', email: '', website: '', status: 'Active' }}
  />
}

function WOStatusesSection() {
  return <CrudSection
    title="Work Order Statuses"
    icon={ClipboardList}
    useItemsHook={useWOStatuses}
    useActionsHook={useWOStatusActions}
    idColumn="status_id"
    columns={[
      { key: 'status_id', label: 'ID' },
      { key: 'status_name', label: 'Name' },
      { key: 'description', label: 'Description', wide: true },
      { key: 'color', label: 'Color', type: 'color' },
      { key: 'display_order', label: 'Order', type: 'number' },
      { key: 'is_closed_status', label: 'Is Closed', type: 'select', options: ['Yes', 'No'] },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]}
    defaultItem={{ status_name: '', description: '', color: '#228be6', display_order: 0, is_closed_status: 'No', status: 'Active' }}
  />
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEK CALCULATION HELPERS (for Classes section)
// ═══════════════════════════════════════════════════════════════════════════════

function calculateWeeks(startDate, endDate, sbStart, sbEnd, finalsStart, finalsEnd) {
  if (!startDate || !endDate) return []

  const start = new Date(startDate + 'T12:00:00')
  const end = new Date(endDate + 'T12:00:00')
  if (isNaN(start) || isNaN(end) || end <= start) return []

  const sbS = sbStart ? new Date(sbStart + 'T12:00:00') : null
  const sbE = sbEnd ? new Date(sbEnd + 'T12:00:00') : null
  const fS = finalsStart ? new Date(finalsStart + 'T12:00:00') : null
  const fE = finalsEnd ? new Date(finalsEnd + 'T12:00:00') : null

  // Find first Monday on or before start
  const weekStart = new Date(start)
  while (weekStart.getDay() !== 1) weekStart.setDate(weekStart.getDate() - 1)

  const weeks = []
  let current = new Date(weekStart)
  let weekNum = 1

  while (current <= end) {
    const wkMon = new Date(current)
    const wkThu = new Date(current)
    wkThu.setDate(wkThu.getDate() + 3)

    let type = 'normal'
    if (sbS && sbE && wkMon >= sbS && wkMon <= sbE) {
      type = 'spring_break'
    } else if (fS && fE && wkMon >= fS && wkMon <= fE) {
      type = 'finals'
    }

    const fmtShort = (d) => `${d.getMonth() + 1}/${d.getDate()}`

    weeks.push({
      num: type === 'spring_break' ? 'SB' : type === 'finals' ? 'Finals' : `W${weekNum}`,
      start: fmtShort(wkMon),
      end: fmtShort(wkThu),
      type,
    })

    if (type !== 'spring_break') weekNum++
    current.setDate(current.getDate() + 7)
  }

  return weeks
}

function countClassWeeks(cls) {
  if (!cls.start_date || !cls.end_date) return null
  const weeks = calculateWeeks(
    String(cls.start_date).substring(0, 10),
    String(cls.end_date).substring(0, 10),
    cls.spring_break_start ? String(cls.spring_break_start).substring(0, 10) : '',
    cls.spring_break_end ? String(cls.spring_break_end).substring(0, 10) : '',
    cls.finals_start ? String(cls.finals_start).substring(0, 10) : '',
    cls.finals_end ? String(cls.finals_end).substring(0, 10) : ''
  )
  return weeks.filter(w => w.type === 'normal').length
}
// ═══════════════════════════════════════════════════════════════════════════════
// CLASSES SECTION (custom — has dates, enrollment, required hours, week preview)
// Internal logic preserved from previous version; outer shell updated to SettingCard.
// ═══════════════════════════════════════════════════════════════════════════════

function ClassesSection() {
  const { items: classes, loading, refresh } = useClasses()
  const actions = useClassActions()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({})
  const [enrollmentClass, setEnrollmentClass] = useState(null)
  const [duplicateClass, setDuplicateClass] = useState(null)
  // Holds { cls, enrolledCount } while the themed archive-confirm modal is open.
  const [archiveConfirm, setArchiveConfirm] = useState(null)
  const [showInactive, setShowInactive] = useState(false)
  const [search, setSearch] = useState('')
  const [enrollmentMap, setEnrollmentMap] = useState({})
  // Tracks mount state so async loads (initial fetch + realtime-triggered
  // reloads + post-save refresh) never call setState after unmount.
  const enrollmentMountedRef = useRef(true)

  // Load enrollment data so we can search by student name/email AND drive the
  // live Enrolled count per class. Includes Archived (graduated) students —
  // tagged with `archived: true` — so the historical roster of who was in a
  // class is preserved in the UI even after a student is archived. Archiving
  // never clears profiles.classes, so this is purely a display concern.
  //
  // Exposed as a callable (useCallback) so the EnrollmentModal can trigger an
  // immediate refresh after saving, and so the realtime subscription below can
  // re-pull when profiles change from any session or kiosk.
  const loadEnrollment = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('first_name, last_name, email, classes, status')
        .in('role', ['Student', 'Work Study'])
        .in('status', ['Active', 'Archived'])
      if (!enrollmentMountedRef.current) return
      const map = {}
      ;(data || []).forEach(s => {
        const archived = s.status === 'Archived'
        const courses = (s.classes || '').split(',').map(c => c.trim()).filter(Boolean)
        courses.forEach(courseId => {
          if (!map[courseId]) map[courseId] = []
          map[courseId].push({
            name: `${s.first_name} ${s.last_name}`,
            email: s.email || '',
            archived,
          })
        })
      })
      setEnrollmentMap(map)
    } catch (err) {
      console.error('Enrollment map load error:', err)
    }
  }, [])

  // Initial load on mount.
  useEffect(() => {
    enrollmentMountedRef.current = true
    loadEnrollment()
    return () => { enrollmentMountedRef.current = false }
  }, [loadEnrollment])

  // Realtime: keep the Enrolled column in sync when student enrollment changes
  // (profiles.classes) — from this session, another instructor's session, or a
  // kiosk. Unique channel name per mount avoids collisions with other realtime
  // channels elsewhere in the app. Enrollment changes are infrequent, so we
  // simply re-pull the whole map on any profiles change (cheap and robust).
  useEffect(() => {
    const channel = supabase
      .channel(`classes-enrollment-${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        () => { loadEnrollment() }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadEnrollment])

  // Convert empty date strings to null for Supabase
  const cleanDates = (data) => {
    const dateFields = ['start_date', 'end_date', 'spring_break_start', 'spring_break_end', 'finals_start', 'finals_end']
    dateFields.forEach(f => { if (!data[f] || data[f] === '') data[f] = null })
    return data
  }

  const startAdd = () => {
    setForm({
      course_id: '', course_name: '', required_hours: 0, instructor: '',
      semester: '', status: 'Active', tracking_type: 'Weekly',
      requires_volunteer_hours: false,
      start_date: '', end_date: '',
      spring_break_start: '', spring_break_end: '', finals_start: '', finals_end: ''
    })
    setEditing('new')
  }

  const startEdit = (cls) => {
    setForm({
      class_id: cls.class_id,
      course_id: cls.course_id || '',
      course_name: cls.course_name || '',
      required_hours: cls.required_hours || 0,
      instructor: cls.instructor || '',
      semester: cls.semester || '',
      status: cls.status || 'Active',
      tracking_type: cls.tracking_type || 'Weekly',
      requires_volunteer_hours: cls.requires_volunteer_hours || false,
      start_date: cls.start_date ? String(cls.start_date).substring(0, 10) : '',
      end_date: cls.end_date ? String(cls.end_date).substring(0, 10) : '',
      spring_break_start: cls.spring_break_start ? String(cls.spring_break_start).substring(0, 10) : '',
      spring_break_end: cls.spring_break_end ? String(cls.spring_break_end).substring(0, 10) : '',
      finals_start: cls.finals_start ? String(cls.finals_start).substring(0, 10) : '',
      finals_end: cls.finals_end ? String(cls.finals_end).substring(0, 10) : '',
    })
    setEditing(cls)
  }

  const handleSave = async () => {
    try {
      const data = cleanDates({ ...form })
      if (editing === 'new') {
        delete data.class_id
        await actions.addItem(data)
      } else {
        delete data.class_id
        await actions.updateItem(form.class_id, data)
      }
      setEditing(null)
      setForm({})
      refresh()
    } catch {}
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this class? Students will need to be re-enrolled in any replacement.')) return
    try {
      await actions.deleteItem(id)
      refresh()
    } catch {}
  }

  // Quick Active⇄Inactive toggle from the Actions column (no edit modal).
  // Inactive classes are hidden from students everywhere (Weekly Labs, Lab
  // Signup, Time Clock, Dashboard all filter status='Active') while the row
  // and all linked history are preserved — i.e. this is the "archive" action.
  // Reactivating, or archiving an empty class, is instant. Archiving a class
  // that still has enrolled students opens a themed confirm modal first.
  const performToggle = async (cls) => {
    const newStatus = cls.status === 'Active' ? 'Inactive' : 'Active'
    try {
      await actions.updateItem(cls.class_id, { status: newStatus })
      refresh()
    } catch {}
  }

  const handleToggleStatus = (cls, enrolledCount = 0) => {
    const archiving = cls.status === 'Active'
    if (archiving && enrolledCount > 0) {
      setArchiveConfirm({ cls, enrolledCount })
      return
    }
    performToggle(cls)
  }

  // Week preview for the form
  const weekPreview = useMemo(() => {
    if (!form.start_date || !form.end_date) return []
    return calculateWeeks(
      form.start_date, form.end_date,
      form.spring_break_start, form.spring_break_end,
      form.finals_start, form.finals_end
    )
  }, [form.start_date, form.end_date, form.spring_break_start, form.spring_break_end, form.finals_start, form.finals_end])

  const normalWeekCount = weekPreview.filter(w => w.type === 'normal').length

  // Filtered + search
  const displayedClasses = useMemo(() => {
    let result = classes
    if (!showInactive) result = result.filter(c => c.status !== 'Inactive')
    if (search.trim()) {
      const s = search.toLowerCase()
      result = result.filter(cls => {
        const fieldMatch = [
          cls.class_id, cls.course_id, cls.course_name,
          cls.instructor, cls.semester, cls.status,
          String(cls.required_hours ?? '')
        ].some(v => String(v || '').toLowerCase().includes(s))
        const enrolledTokens = enrollmentMap[cls.course_id] || []
        const enrollMatch = enrolledTokens.some(t =>
          t.name.toLowerCase().includes(s) || t.email.toLowerCase().includes(s)
        )
        return fieldMatch || enrollMatch
      })
    }
    return result
  }, [classes, showInactive, search, enrollmentMap])

  const inactiveCount = classes.filter(c => c.status === 'Inactive').length

  if (loading) {
    return (
      <div className="settings-loading">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading classes…</p>
      </div>
    )
  }

  // Header right-side actions
  const headerActions = (
    <>
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search classes or students…"
          className="input text-xs pl-7 w-48"
          aria-label="Search classes or students"
        />
      </div>
      {inactiveCount > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
            showInactive
              ? 'bg-surface-100 text-surface-700 border-surface-200'
              : 'bg-white text-surface-400 border-surface-200 hover:text-surface-600'
          }`}
          title={showInactive ? 'Hide inactive classes' : `Show ${inactiveCount} inactive class${inactiveCount !== 1 ? 'es' : ''}`}
        >
          {showInactive ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
          {showInactive ? 'Hide Inactive' : `+${inactiveCount} Inactive`}
        </button>
      )}
      <button
        type="button"
        onClick={startAdd}
        className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1 px-2 py-1 rounded"
      >
        <Plus size={12} aria-hidden="true" /> Add Class
      </button>
    </>
  )

  const titleCount = displayedClasses.length === classes.length
    ? classes.length
    : `${displayedClasses.length} of ${classes.length}`

  return (
    <div className="space-y-4">
      <SettingCard
        icon={GraduationCap}
        title="Classes"
        count={titleCount}
        actions={headerActions}
      >
        {/* Add/Edit Form */}
        {editing && (
          <div className="px-4 py-4 bg-brand-50 border-b border-brand-100 space-y-3">
            <div className="text-xs font-semibold text-brand-700">
              {editing === 'new' ? 'Add New Class' : `Edit ${form.course_id}`}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Course ID *</label>
                <input value={form.course_id} onChange={e => setForm(f => ({ ...f, course_id: e.target.value }))}
                  className="input text-sm" placeholder="RICT1630" />
              </div>
              <div className="col-span-2 md:col-span-1">
                <label className="text-[10px] text-surface-500 font-medium">Course Name</label>
                <input value={form.course_name} onChange={e => setForm(f => ({ ...f, course_name: e.target.value }))}
                  className="input text-sm" placeholder="Production Automation" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Required Hours/wk</label>
                <input type="number" value={form.required_hours}
                  onChange={e => setForm(f => ({ ...f, required_hours: parseFloat(e.target.value) || 0 }))}
                  className="input text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Instructor</label>
                <input value={form.instructor} onChange={e => setForm(f => ({ ...f, instructor: e.target.value }))}
                  className="input text-sm" />
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Semester</label>
                <input value={form.semester} onChange={e => setForm(f => ({ ...f, semester: e.target.value }))}
                  className="input text-sm" placeholder="Spring 2026" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="input text-sm">
                  <option>Active</option>
                  <option>Inactive</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Tracking Type</label>
                <select value={form.tracking_type} onChange={e => setForm(f => ({ ...f, tracking_type: e.target.value }))} className="input text-sm">
                  <option value="Weekly">Weekly</option>
                  <option value="Daily">Daily</option>
                  <option value="None">None</option>
                </select>
              </div>
              <div className="flex items-end pb-1.5">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.requires_volunteer_hours || false}
                    onChange={e => setForm(f => ({ ...f, requires_volunteer_hours: e.target.checked }))}
                    className="w-4 h-4 rounded border-surface-300 text-purple-600 focus:ring-purple-500"
                  />
                  <span className="text-xs font-medium text-surface-700">Requires Volunteer Hours</span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Start Date *</label>
                <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} className="input text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">End Date *</label>
                <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} className="input text-sm" />
              </div>
            </div>

            {form.start_date && form.end_date && form.tracking_type !== 'None' && (
              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                <Calendar size={13} aria-hidden="true" />
                Start/End dates determine the weekly lab tracker weeks. Weeks run Monday–Thursday.
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Spring Break Start</label>
                <input type="date" value={form.spring_break_start} onChange={e => setForm(f => ({ ...f, spring_break_start: e.target.value }))} className="input text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Spring Break End</label>
                <input type="date" value={form.spring_break_end} onChange={e => setForm(f => ({ ...f, spring_break_end: e.target.value }))} className="input text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Finals Start</label>
                <input type="date" value={form.finals_start} onChange={e => setForm(f => ({ ...f, finals_start: e.target.value }))} className="input text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Finals End</label>
                <input type="date" value={form.finals_end} onChange={e => setForm(f => ({ ...f, finals_end: e.target.value }))} className="input text-sm" />
              </div>
            </div>

            {weekPreview.length > 0 && (
              <div className="bg-white border border-surface-200 rounded-lg p-3">
                <div className="text-xs font-semibold text-surface-700 flex items-center gap-1.5 mb-2">
                  <Calendar size={13} className="text-brand-500" aria-hidden="true" />
                  Week Preview ({normalWeekCount} weeks)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {weekPreview.map((w, i) => (
                    <div key={i} className={`text-center px-2 py-1.5 rounded-lg text-[10px] font-medium border min-w-[60px] ${
                      w.type === 'spring_break' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                      w.type === 'finals' ? 'bg-red-50 border-red-200 text-red-700' :
                      'bg-emerald-50 border-emerald-200 text-emerald-700'
                    }`}>
                      <div className="font-bold">{w.num}</div>
                      <div className="opacity-75">{w.start}–{w.end}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3 mt-2 text-[10px] text-surface-500">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-200" aria-hidden="true" /> Class Week</span>
                  {weekPreview.some(w => w.type === 'spring_break') && (
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-blue-200" aria-hidden="true" /> Spring Break</span>
                  )}
                  {weekPreview.some(w => w.type === 'finals') && (
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-200" aria-hidden="true" /> Finals</span>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={actions.saving}
                className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1 hover:bg-brand-700 disabled:opacity-50"
              >
                {actions.saving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />} Save
              </button>
              <button
                type="button"
                onClick={() => { setEditing(null); setForm({}) }}
                className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs hover:bg-surface-200"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Classes Table */}
        {displayedClasses.length === 0 ? (
          <div className="text-center py-8 text-surface-400 text-sm">
            {search ? 'No classes match your search' : 'No classes configured yet'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 text-left">
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">ID</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Course ID</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Course Name</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Hrs/wk</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Weeks</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Instructor</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Semester</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Dates</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Enrolled</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600">Status</th>
                  <th className="px-4 py-2 text-xs font-semibold text-surface-600 w-32">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {displayedClasses.map(cls => {
                  const wks = countClassWeeks(cls)
                  const enrolledStudents = enrollmentMap[cls.course_id] || []
                  const activeStudents = enrolledStudents.filter(s => !s.archived)
                  const formerStudents = enrolledStudents.filter(s => s.archived)
                  const enrolledCount = activeStudents.length
                  const formerCount = formerStudents.length
                  const isInactive = cls.status === 'Inactive'
                  return (
                    <tr key={cls.class_id} className={`hover:bg-surface-50 ${isInactive ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-2 text-xs font-mono text-surface-400">{cls.class_id}</td>
                      <td className="px-4 py-2 font-medium">{cls.course_id || '—'}</td>
                      <td className="px-4 py-2 text-surface-600 max-w-[180px] truncate">{cls.course_name || '—'}</td>
                      <td className="px-4 py-2 text-center">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                          {cls.required_hours || 0} hrs/wk
                        </span>
                      </td>
                      <td className="px-4 py-2 text-center">
                        {wks !== null ? (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                            {wks} wks
                          </span>
                        ) : (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-500">
                            No dates
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-surface-600">{cls.instructor || '—'}</td>
                      <td className="px-4 py-2 text-surface-500 text-xs">{cls.semester || '—'}</td>
                      <td className="px-4 py-2 text-xs text-surface-400">
                        {cls.start_date ? `${String(cls.start_date).substring(0, 10)} → ${String(cls.end_date || '').substring(0, 10)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {(enrolledCount > 0 || formerCount > 0) ? (
                          <div className="inline-flex items-center justify-center gap-1 flex-wrap">
                            {enrolledCount > 0 && (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 cursor-default"
                                title={`Currently enrolled:\n${activeStudents.map(s => s.name).join('\n')}`}
                                aria-label={`${enrolledCount} currently enrolled`}
                              >
                                <Users size={10} aria-hidden="true" /> {enrolledCount}
                              </span>
                            )}
                            {formerCount > 0 && (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-100 text-surface-500 border border-surface-200 cursor-default"
                                title={`Former / graduated:\n${formerStudents.map(s => s.name).join('\n')}`}
                                aria-label={`${formerCount} former or graduated student${formerCount !== 1 ? 's' : ''}`}
                              >
                                <GraduationCap size={10} aria-hidden="true" /> {formerCount}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-surface-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            cls.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-100 text-surface-500'
                          }`}>{cls.status}</span>
                          {(cls.tracking_type === 'None') && (
                            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-100 text-surface-500 border border-surface-200">
                              No Tracker
                            </span>
                          )}
                          {cls.requires_volunteer_hours && (
                            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-50 text-purple-700 border border-purple-200">
                              Volunteer
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setEnrollmentClass(cls)}
                            title="Manage Enrollment" aria-label={`Manage enrollment for ${cls.course_id}`}
                            className="p-1 rounded hover:bg-blue-50 text-surface-400 hover:text-blue-600">
                            <Users size={13} aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => setDuplicateClass(cls)}
                            title="Duplicate Class (new semester)" aria-label={`Duplicate ${cls.course_id} for new semester`}
                            className="p-1 rounded hover:bg-violet-50 text-surface-400 hover:text-violet-600">
                            <Copy size={13} aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => handleToggleStatus(cls, enrolledCount)}
                            disabled={actions.saving}
                            title={isInactive ? 'Reactivate Class (show to students)' : 'Archive Class (hide from students)'}
                            aria-label={isInactive
                              ? `Reactivate ${cls.course_id} — currently inactive, show to students`
                              : `Archive ${cls.course_id} — currently active, hide from students`}
                            className={`p-1 rounded text-surface-400 disabled:opacity-40 disabled:cursor-not-allowed ${
                              isInactive
                                ? 'hover:bg-emerald-50 hover:text-emerald-600'
                                : 'hover:bg-amber-50 hover:text-amber-600'
                            }`}>
                            {isInactive
                              ? <ArchiveRestore size={13} aria-hidden="true" />
                              : <Archive size={13} aria-hidden="true" />}
                          </button>
                          <button type="button" onClick={() => startEdit(cls)}
                            title="Edit Class" aria-label={`Edit ${cls.course_id}`}
                            className="p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-brand-600">
                            <Edit3 size={13} aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => handleDelete(cls.class_id)}
                            title="Delete Class" aria-label={`Delete ${cls.course_id}`}
                            className="p-1 rounded hover:bg-red-50 text-surface-400 hover:text-red-500">
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingCard>

      {/* Enrollment Modal */}
      {enrollmentClass && (
        <EnrollmentModal
          cls={enrollmentClass}
          onClose={() => setEnrollmentClass(null)}
          onSaved={loadEnrollment}
        />
      )}

      {/* Duplicate Modal */}
      {duplicateClass && (
        <DuplicateClassModal
          cls={duplicateClass}
          actions={actions}
          onClose={() => setDuplicateClass(null)}
          onSaved={() => { setDuplicateClass(null); refresh() }}
        />
      )}

      {/* Archive (deactivate) confirm — themed, only shown for enrolled classes */}
      <ClassArchiveConfirmModal
        confirm={archiveConfirm}
        saving={actions.saving}
        onCancel={() => setArchiveConfirm(null)}
        onConfirm={async () => {
          const cls = archiveConfirm?.cls
          if (cls) await performToggle(cls)
          setArchiveConfirm(null)
        }}
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHIVE CLASS CONFIRM MODAL
// Themed confirmation (matches the Lab Access dialog) shown when archiving a
// class that still has enrolled students. Reuses the shared settings-modal-*
// styles + useDialogA11y (focus trap, Escape to close, focus return).
// ═══════════════════════════════════════════════════════════════════════════════

function ClassArchiveConfirmModal({ confirm, saving, onCancel, onConfirm }) {
  const isOpen = !!confirm
  const dialogRef = useDialogA11y(isOpen, onCancel)
  const titleId = useId()
  const descId = useId()

  if (!isOpen) return null
  const { cls, enrolledCount } = confirm
  const label = cls.course_id || cls.class_id
  const plural = enrolledCount !== 1

  return (
    <div
      className="settings-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="settings-modal"
      >
        <header className="settings-modal-header settings-modal-header--warn">
          <span className="settings-modal-header-icon-wrap">
            <Archive size={20} aria-hidden="true" />
          </span>
          <h3 id={titleId} className="settings-modal-title">
            Archive {label}?
          </h3>
        </header>

        <div className="settings-modal-body" id={descId}>
          <div className="settings-modal-warning">
            <AlertTriangle size={18} className="settings-modal-warning-icon" aria-hidden="true" />
            <p className="settings-modal-warning-text">
              This class will be <strong>hidden from {enrolledCount} enrolled
              student{plural ? 's' : ''}</strong> across Weekly Labs, Lab Signup,
              the Time Clock kiosk, and the Dashboard.
            </p>
          </div>
          <p className="settings-modal-text">
            <strong>All existing data is preserved</strong> — work history, hours,
            and signups stay intact. You can reactivate this class at any time from
            the same button.
          </p>
        </div>

        <footer className="settings-modal-footer">
          <button
            type="button"
            className="settings-modal-btn settings-modal-btn--secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="settings-modal-btn settings-modal-btn--warn"
            onClick={onConfirm}
            disabled={saving}
          >
            {saving
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <Archive size={14} aria-hidden="true" />}
            Archive Class
          </button>
        </footer>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE CLASS MODAL (preserved as-is)
// ═══════════════════════════════════════════════════════════════════════════════

function DuplicateClassModal({ cls, actions, onClose, onSaved }) {
  const [form, setForm] = useState({
    semester: '',
    start_date: '',
    end_date: '',
    spring_break_start: '',
    spring_break_end: '',
    finals_start: '',
    finals_end: '',
  })
  const [saving, setSaving] = useState(false)

  const cleanDates = (data) => {
    const dateFields = ['start_date', 'end_date', 'spring_break_start', 'spring_break_end', 'finals_start', 'finals_end']
    dateFields.forEach(f => { if (!data[f] || data[f] === '') data[f] = null })
    return data
  }

  const weekPreview = useMemo(() => {
    if (!form.start_date || !form.end_date) return []
    return calculateWeeks(
      form.start_date, form.end_date,
      form.spring_break_start, form.spring_break_end,
      form.finals_start, form.finals_end
    )
  }, [form.start_date, form.end_date, form.spring_break_start, form.spring_break_end, form.finals_start, form.finals_end])

  const normalWeekCount = weekPreview.filter(w => w.type === 'normal').length

  const handleSave = async () => {
    if (!form.semester.trim() || !form.start_date || !form.end_date) {
      toast.error('Semester, start date, and end date are required')
      return
    }
    setSaving(true)
    try {
      const dup = cleanDates({
        course_id: cls.course_id,
        course_name: cls.course_name,
        required_hours: cls.required_hours,
        instructor: cls.instructor,
        status: 'Active',
        tracking_type: cls.tracking_type || 'Weekly',
        requires_volunteer_hours: cls.requires_volunteer_hours || false,
        semester: form.semester.trim(),
        start_date: form.start_date,
        end_date: form.end_date,
        spring_break_start: form.spring_break_start,
        spring_break_end: form.spring_break_end,
        finals_start: form.finals_start,
        finals_end: form.finals_end,
      })
      await actions.addItem(dup)
      toast.success(`Class duplicated for ${form.semester.trim()}!`)
      onSaved()
    } catch (err) {
      toast.error(err.message || 'Failed to duplicate class')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-surface-900 flex items-center gap-2">
              <Copy size={14} className="text-violet-500" aria-hidden="true" /> Duplicate Class
            </h3>
            <p className="text-xs text-surface-500 mt-0.5">{cls.course_id} — {cls.course_name}</p>
          </div>
          <button type="button" onClick={onClose} className="text-surface-400 hover:text-surface-600" aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 text-xs text-violet-700 flex items-start gap-2">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>This will create a copy of <strong>{cls.course_id}</strong> with new dates for the semester below. Enrollment will not be carried over.</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-surface-500 font-medium">New Semester *</label>
              <input value={form.semester} onChange={e => setForm(f => ({ ...f, semester: e.target.value }))}
                className="input text-sm" placeholder="Fall 2026" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 font-medium">Start Date *</label>
              <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 font-medium">End Date *</label>
              <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} className="input text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div>
              <label className="text-[10px] text-surface-500 font-medium">Spring Break Start</label>
              <input type="date" value={form.spring_break_start} onChange={e => setForm(f => ({ ...f, spring_break_start: e.target.value }))} className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 font-medium">Spring Break End</label>
              <input type="date" value={form.spring_break_end} onChange={e => setForm(f => ({ ...f, spring_break_end: e.target.value }))} className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 font-medium">Finals Start</label>
              <input type="date" value={form.finals_start} onChange={e => setForm(f => ({ ...f, finals_start: e.target.value }))} className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 font-medium">Finals End</label>
              <input type="date" value={form.finals_end} onChange={e => setForm(f => ({ ...f, finals_end: e.target.value }))} className="input text-sm" />
            </div>
          </div>

          {weekPreview.length > 0 && (
            <div className="bg-white border border-surface-200 rounded-lg p-3">
              <div className="text-xs font-semibold text-surface-700 flex items-center gap-1.5 mb-2">
                <Calendar size={13} className="text-brand-500" aria-hidden="true" />
                Week Preview ({normalWeekCount} weeks)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {weekPreview.map((w, i) => (
                  <div key={i} className={`text-center px-2 py-1.5 rounded-lg text-[10px] font-medium border min-w-[60px] ${
                    w.type === 'spring_break' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                    w.type === 'finals' ? 'bg-red-50 border-red-200 text-red-700' :
                    'bg-emerald-50 border-emerald-200 text-emerald-700'
                  }`}>
                    <div className="font-bold">{w.num}</div>
                    <div className="opacity-75">{w.start}–{w.end}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex gap-2">
          <button type="button" onClick={handleSave} disabled={saving}
            className="btn-primary text-sm gap-1.5 flex-1">
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {saving ? 'Creating…' : 'Create Duplicate'}
          </button>
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENROLLMENT MODAL (preserved as-is)
// ═══════════════════════════════════════════════════════════════════════════════

function EnrollmentModal({ cls, onClose, onSaved }) {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [enrolled, setEnrolled] = useState({})
  // Read-only history: archived (graduated) students who were enrolled in this course.
  const [formerMembers, setFormerMembers] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, email, role, classes, time_clock_only')
          .eq('status', 'Active')
          .in('role', ['Student', 'Work Study'])
          .order('last_name')
        if (cancelled) return

        const courseId = cls.course_id || ''
        const studentList = (data || []).filter(s => s.time_clock_only !== 'Yes')
        setStudents(studentList)

        const enrolledMap = {}
        studentList.forEach(s => {
          const classes = (s.classes || '').split(',').map(c => c.trim())
          if (classes.includes(courseId)) enrolledMap[s.id] = true
        })
        setEnrolled(enrolledMap)

        // Read-only history — archived (graduated) students who were in this
        // course. Archiving never clears profiles.classes, so this list shows
        // who was previously enrolled even after they've left the program.
        const { data: archivedData } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, email, role, classes')
          .eq('status', 'Archived')
          .in('role', ['Student', 'Work Study'])
          .order('last_name')
        if (cancelled) return
        const former = (archivedData || []).filter(s => {
          const classes = (s.classes || '').split(',').map(c => c.trim())
          return classes.includes(courseId)
        })
        setFormerMembers(former)
      } catch (err) {
        if (!cancelled) console.error('Error loading students:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [cls])

  const toggle = (id) => {
    setEnrolled(prev => {
      const next = { ...prev }
      if (next[id]) delete next[id]; else next[id] = true
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const courseId = cls.course_id || ''
      for (const student of students) {
        const currentClasses = (student.classes || '').split(',').map(c => c.trim()).filter(Boolean)
        const isEnrolled = !!enrolled[student.id]
        const wasEnrolled = currentClasses.includes(courseId)

        if (isEnrolled && !wasEnrolled) {
          const updated = [...currentClasses, courseId].join(', ')
          const { data: eRows, error: eErr } = await supabase.from('profiles').update({ classes: updated }).eq('id', student.id).select()
          if (eErr) throw eErr
          if (!eRows || eRows.length === 0) {
            toast.error(`Failed to enroll ${student.first_name} — check permissions.`)
          }
        } else if (!isEnrolled && wasEnrolled) {
          const updated = currentClasses.filter(c => c !== courseId).join(', ')
          const { data: eRows, error: eErr } = await supabase.from('profiles').update({ classes: updated }).eq('id', student.id).select()
          if (eErr) throw eErr
          if (!eRows || eRows.length === 0) {
            toast.error(`Failed to unenroll ${student.first_name} — check permissions.`)
          }
        }
      }
      toast.success('Enrollment updated!')
      onSaved?.()
      onClose()
    } catch (err) {
      toast.error(err.message || 'Failed to save enrollment')
    } finally {
      setSaving(false)
    }
  }

  const enrolledCount = Object.keys(enrolled).length
  const filtered = search
    ? students.filter(s => `${s.first_name} ${s.last_name} ${s.email}`.toLowerCase().includes(search.toLowerCase()))
    : students

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-surface-900">Manage Enrollment</h3>
            <p className="text-xs text-surface-500">{cls.course_id} — {cls.course_name}</p>
          </div>
          <button type="button" onClick={onClose} className="text-surface-400 hover:text-surface-600" aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-3 space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search students..." className="input pl-9 text-sm"
              aria-label="Search students" />
          </div>
          <div className="text-xs text-brand-600 font-medium bg-brand-50 px-3 py-1.5 rounded-lg">
            {enrolledCount} student{enrolledCount !== 1 ? 's' : ''} enrolled
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-2">
          {loading ? (
            <div className="text-center py-8 text-surface-400">Loading students...</div>
          ) : (
            <div className="space-y-1">
              {filtered.map(s => (
                <label key={s.id}
                  className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-colors ${
                    enrolled[s.id] ? 'bg-brand-50 border border-brand-200' : 'bg-surface-50 border border-transparent hover:bg-surface-100'
                  }`}>
                  <input type="checkbox" checked={!!enrolled[s.id]} onChange={() => toggle(s.id)} className="rounded" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-surface-900">{s.first_name} {s.last_name}</div>
                    <div className="text-xs text-surface-500">{s.email}</div>
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    s.role === 'Work Study' ? 'bg-blue-100 text-blue-700' : 'bg-surface-100 text-surface-500'
                  }`}>{s.role}</span>
                </label>
              ))}

              {/* Read-only history of archived (graduated) members. Not
                  editable — archived users can't be re-enrolled here; restore
                  them from Users first. Preserves "who was in this class". */}
              {formerMembers.length > 0 && (
                <div className="mt-3 pt-3 border-t border-surface-100">
                  <div className="flex items-center gap-1.5 px-1 mb-1.5">
                    <GraduationCap size={12} className="text-surface-400" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-surface-400">
                      Former / graduated ({formerMembers.length})
                    </span>
                  </div>
                  <ul className="space-y-1 list-none m-0 p-0">
                    {formerMembers.map(s => (
                      <li key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-surface-50/60 opacity-70">
                        <GraduationCap size={14} className="text-surface-400 flex-shrink-0" aria-hidden="true" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-surface-700">{s.first_name} {s.last_name}</div>
                          <div className="text-xs text-surface-400">{s.email}</div>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-surface-100 text-surface-400">
                          Archived
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex gap-2">
          <button type="button" onClick={handleSave} disabled={saving}
            className="btn-primary text-sm gap-1.5 flex-1">
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
            {saving ? 'Saving...' : 'Save Enrollment'}
          </button>
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
