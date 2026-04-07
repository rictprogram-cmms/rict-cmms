import { useState, useMemo, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import {
  useSettings, useSettingsActions, useCategories, useCategoryActions,
  useAssetLocations, useAssetLocationActions, useInventoryLocations, useInventoryLocationActions,
  useVendorsList, useVendorActions, useWOStatuses, useWOStatusActions,
  useClasses, useClassActions
} from '@/hooks/useSettings'
import {
  Settings, Save, Plus, Trash2, Edit3, X, Loader2, CheckCircle2,
  Tag, MapPin, Box, Truck, ClipboardList, GraduationCap, Sliders,
  Users, Calendar, Clock, BookOpen, ChevronDown, ChevronUp, Search,
  AlertCircle, RotateCcw, Copy, EyeOff, Eye, MoonStar, Sun, AlertTriangle,
  LayoutDashboard, FlaskConical, MessageSquare
} from 'lucide-react'
import toast from 'react-hot-toast'

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function SettingsPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Settings')
  const [tab, setTab] = useState('general')

  const tabs = [
    { id: 'general', label: 'General', icon: Sliders },
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'weekly_labs', label: 'Weekly Labs', icon: FlaskConical },
    { id: 'categories', label: 'Categories', icon: Tag },
    { id: 'asset_locations', label: 'Asset Locations', icon: MapPin },
    { id: 'inv_locations', label: 'Inventory Locations', icon: Box },
    { id: 'vendors', label: 'Vendors', icon: Truck },
    { id: 'wo_statuses', label: 'WO Statuses', icon: ClipboardList },
    { id: 'classes', label: 'Classes', icon: GraduationCap },
  ]

  if (permsLoading) {
    return (
      <div className="p-4 lg:p-6 max-w-7xl mx-auto text-center py-20">
        <Loader2 size={24} className="mx-auto mb-3 text-surface-400 animate-spin" />
        <p className="text-surface-500 text-sm">Loading...</p>
      </div>
    )
  }

  if (!hasPerm('view_page')) {
    return (
      <div className="p-4 lg:p-6 max-w-7xl mx-auto text-center py-20">
        <Settings size={40} className="mx-auto mb-3 text-surface-300" />
        <p className="text-surface-500 text-sm">You do not have permission to access Settings.</p>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">
      <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
        <Settings size={20} className="text-brand-600" /> Settings
      </h1>

      {/* Tab Nav */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
              }`}>
              <Icon size={14} /> {t.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      {tab === 'general' && <GeneralSettings />}
      {tab === 'dashboard' && <DashboardSettings />}
      {tab === 'weekly_labs' && <WeeklyLabsSettings />}
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
// GENERAL SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

const SETTING_META = {
  // Work Orders
  priority_low_days: { label: 'Low Priority Due Days', type: 'number', desc: 'Default days until due for Low priority work orders' },
  priority_medium_days: { label: 'Medium Priority Due Days', type: 'number', desc: 'Default days until due for Medium priority work orders' },
  priority_high_days: { label: 'High Priority Due Days', type: 'number', desc: 'Default days until due for High priority work orders' },
  time_increment: { label: 'Time Increment (minutes)', type: 'number', desc: 'Step size for the minutes selector in work log entries' },
  default_work_time: { label: 'Default Work Time (min)', type: 'number', desc: 'Default time pre-filled when adding a work log entry' },
  // Notifications
  notification_email: { label: 'Notification Email', type: 'text', desc: 'Email address for system notifications' },
  notif_poll_interval: { label: 'Poll Interval (seconds)', type: 'number', desc: 'Notification bell polling interval (15/30/60, 0=off)' },
  // Printing
  label_width_inches: { label: 'Label Width (inches)', type: 'number', desc: 'Label width for Zebra ZT230 printer' },
  label_height_inches: { label: 'Label Height (inches)', type: 'number', desc: 'Label height for Zebra ZT230 printer' },
  // Metrics
  metrics_start_hour: { label: 'Metrics Start Hour', type: 'number', desc: 'Start hour for metrics display (0-23)' },
  metrics_end_hour: { label: 'Metrics End Hour', type: 'number', desc: 'End hour for metrics display (0-23)' },
  metrics_refresh_interval: { label: 'TV Refresh Interval (min)', type: 'number', desc: 'Minutes between auto-refreshes on the TV Display page' },
  // Lab Signup
  lab_visible_days: { label: 'Lab Open Days', type: 'custom', desc: 'Select which days the lab is open for signups' },
  lab_weeks_to_display: { label: 'Weeks to Display', type: 'number', desc: 'Number of weeks to display on Lab Signup page' },
  // Volunteer
  volunteer_semester_total_hours: { label: 'Semester Total Hours', type: 'number', desc: 'Total volunteer hours required per semester' },
  volunteer_midpoint_hours: { label: 'Midpoint Hours', type: 'number', desc: 'Hours required by midpoint week' },
  volunteer_midpoint_week: { label: 'Midpoint Week', type: 'number', desc: 'Week number for midpoint check' },
  volunteer_current_semester: { label: 'Current Semester', type: 'text', desc: 'Current semester for volunteer tracking' },
  volunteer_semester_start: { label: 'Semester Start Date', type: 'date', desc: 'Start date of the current volunteer tracking semester' },
  volunteer_semester_end: { label: 'Semester End Date', type: 'date', desc: 'End date of the current volunteer tracking semester' },
  // Time Clock
  grace_period_minutes: { label: 'Grace Period (minutes)', type: 'number', desc: 'Minutes of grace before marking a student as late or leaving early' },
  // System
  app_version: { label: 'App Version', type: 'text', desc: 'Current application version' },
  session_timeout_hours: { label: 'Session Timeout (hours)', type: 'number', desc: 'Hours until users are automatically logged out. Set to 0 to disable (sessions never expire).' },
}

const CATEGORY_ICONS = {
  'Work Orders': ClipboardList,
  'Notifications': AlertCircle,
  'Printing': Tag,
  'Metrics': Clock,
  'Lab Signup': BookOpen,
  'Volunteer': Users,
  'System': Settings,
  'Storage': Box,
  'General': Sliders,
  'Time Clock': Clock,
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAB ACCESS MODE CARD
// ═══════════════════════════════════════════════════════════════════════════════

function LabAccessModeCard() {
  const { profile } = useAuth()
  const [mode, setMode] = useState(null)       // 'in_session' | 'summer_break' | null (loading)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null) // 'summer_break' | 'in_session' — pending confirm
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  // Fetch current value
  const fetchMode = async () => {
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
  }

  useEffect(() => { fetchMode() }, [])

  // Realtime: stay in sync if another instructor changes it
  useEffect(() => {
    const channel = supabase
      .channel('lab-access-mode-settings')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'settings',
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
      // Update the setting
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
        // Row doesn't exist yet — insert it
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

      // ── Also pause/unpause PM generation to match ─────────────────────
      // Summer Break → pause PMs. In Session → unpause PMs.
      // Note: if PMs were manually paused before summer break was enabled,
      // restoring In Session will unpause them. Re-pause from the PM page if needed.
      try {
        const pmPausedValue = newMode === 'summer_break' ? 'true' : 'false'
        const { data: pmRows } = await supabase
          .from('settings')
          .update({
            setting_value: pmPausedValue,
            updated_at: new Date().toISOString(),
            updated_by: userName,
          })
          .eq('setting_key', 'pm_generation_paused')
          .select()

        // Insert if not found
        if (!pmRows || pmRows.length === 0) {
          await supabase.from('settings').insert({
            setting_key: 'pm_generation_paused',
            setting_value: pmPausedValue,
            description: 'When true, all PM work order auto-generation is paused (summer/winter break)',
            category: 'PM',
            updated_at: new Date().toISOString(),
            updated_by: userName,
          })
        }
      } catch (pmErr) {
        console.warn('[LabAccessMode] PM pause sync failed (non-fatal):', pmErr.message)
      }

      // ── Audit log — this is a high-impact change ──────────────────────
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
            ? 'Lab Access Mode set to Summer Break — students locked out, PM generation paused.'
            : 'Lab Access Mode restored to In Session — students have access, PM generation resumed.',
        })
      } catch (auditErr) {
        console.warn('[LabAccessMode] Audit log failed (non-fatal):', auditErr.message)
      }

      toast.success(newMode === 'summer_break'
        ? 'Summer Break Mode enabled — students locked out & PMs paused'
        : 'In-Session Mode restored — students have access & PMs resumed')
    } catch (err) {
      toast.error('Failed to update Lab Access Mode: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const isSummerBreak = mode === 'summer_break'

  return (
    <>
      {/* ── Confirmation Modal ── */}
      {confirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 3000, padding: 20,
        }}
          onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
        >
          <div style={{
            background: 'white', borderRadius: 14, width: '100%', maxWidth: 440,
            overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            {/* Header */}
            <div style={{
              padding: '18px 20px',
              borderBottom: '1px solid #e9ecef',
              display: 'flex', alignItems: 'center', gap: 12,
              background: confirm === 'summer_break' ? '#fff8f0' : '#f0faf4',
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%',
                background: confirm === 'summer_break' ? '#ffd8a8' : '#b2f2bb',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {confirm === 'summer_break'
                  ? <MoonStar size={20} style={{ color: '#e8590c' }} />
                  : <Sun size={20} style={{ color: '#2f9e44' }} />}
              </div>
              <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                {confirm === 'summer_break' ? 'Enable Summer Break Mode?' : 'Restore In-Session Access?'}
              </h4>
            </div>

            {/* Body */}
            <div style={{ padding: '20px' }}>
              {confirm === 'summer_break' ? (
                <>
                  <div style={{
                    background: '#fff3bf', border: '1px solid #fcc419',
                    borderRadius: 10, padding: '12px 14px', marginBottom: 16,
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                  }}>
                    <AlertTriangle size={18} style={{ color: '#e67700', flexShrink: 0, marginTop: 1 }} />
                    <p style={{ margin: 0, fontSize: '0.88rem', color: '#5c3d00', lineHeight: 1.5 }}>
                      This will <strong>immediately</strong> lock out all Students and Work Study users.
                      They will see a "Lab Closed" screen and cannot access any part of the system.
                      The Time Clock kiosk will also be disabled.
                    </p>
                  </div>
                  <p style={{ fontSize: '0.88rem', color: '#495057', margin: 0 }}>
                    <strong>Instructors are not affected.</strong> You can restore access at any time
                    by switching back to In Session.
                  </p>
                </>
              ) : (
                <p style={{ fontSize: '0.88rem', color: '#495057', margin: 0, lineHeight: 1.6 }}>
                  This will restore full access to all Students and Work Study users immediately.
                  The Time Clock kiosk will also be re-enabled.
                </p>
              )}
            </div>

            {/* Footer */}
            <div style={{
              padding: '14px 20px', borderTop: '1px solid #e9ecef',
              display: 'flex', justifyContent: 'flex-end', gap: 10,
            }}>
              <button
                onClick={() => setConfirm(null)}
                style={{
                  background: '#f1f3f5', color: '#495057', border: 'none',
                  borderRadius: 8, padding: '9px 18px', fontSize: '0.88rem', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => applyMode(confirm)}
                style={{
                  background: confirm === 'summer_break' ? '#e8590c' : '#2f9e44',
                  color: 'white', border: 'none',
                  borderRadius: 8, padding: '9px 22px', fontSize: '0.88rem',
                  fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                {confirm === 'summer_break' ? <MoonStar size={14} /> : <Sun size={14} />}
                {confirm === 'summer_break' ? 'Enable Summer Break' : 'Restore Access'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Card ── */}
      <div style={{
        borderRadius: 14,
        border: isSummerBreak ? '2px solid #f76707' : '2px solid #40c057',
        overflow: 'hidden',
        background: isSummerBreak
          ? 'linear-gradient(135deg, #fff8f2 0%, #fff3e8 100%)'
          : 'linear-gradient(135deg, #f4fef6 0%, #ebfbee 100%)',
        transition: 'border-color 0.3s, background 0.3s',
      }}>
        {/* Status banner */}
        <div style={{
          padding: '10px 20px',
          background: isSummerBreak
            ? 'linear-gradient(90deg, #f76707, #e8590c)'
            : 'linear-gradient(90deg, #2f9e44, #40c057)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isSummerBreak
              ? <MoonStar size={16} style={{ color: 'white' }} />
              : <Sun size={16} style={{ color: 'white' }} />}
            <span style={{ color: 'white', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.03em' }}>
              {isSummerBreak ? 'SUMMER BREAK MODE — STUDENTS LOCKED OUT' : 'IN SESSION — STUDENTS HAVE FULL ACCESS'}
            </span>
          </div>
          {mode === null && <Loader2 size={14} style={{ color: 'rgba(255,255,255,0.7)', animation: 'spin 1s linear infinite' }} />}
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            {/* Description */}
            <div style={{ flex: 1 }}>
              <h3 style={{
                margin: '0 0 6px',
                fontSize: '0.95rem', fontWeight: 700,
                color: isSummerBreak ? '#7c2d12' : '#1a4731',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                Lab Access Mode
              </h3>
              <p style={{
                margin: 0, fontSize: '0.83rem',
                color: isSummerBreak ? '#9a3412' : '#2d6a4f',
                lineHeight: 1.55,
              }}>
                {isSummerBreak
                  ? 'Students and Work Study users are blocked from logging in. The Time Clock kiosk is also disabled. Instructors retain full access.'
                  : 'All users can access the system normally. Switch to Summer Break to lock out students during semester breaks.'}
              </p>
            </div>

            {/* Toggle buttons */}
            <div style={{ flexShrink: 0 }}>
              <div style={{
                display: 'inline-flex',
                borderRadius: 10,
                overflow: 'hidden',
                border: '1px solid rgba(0,0,0,0.12)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
              }}>
                <button
                  onClick={() => !isSummerBreak ? null : setConfirm('in_session')}
                  disabled={saving || mode === null}
                  style={{
                    padding: '9px 18px',
                    fontSize: '0.83rem', fontWeight: 600,
                    border: 'none', cursor: (!isSummerBreak || saving) ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 7,
                    background: !isSummerBreak ? '#2f9e44' : '#f1f3f5',
                    color: !isSummerBreak ? 'white' : '#868e96',
                    transition: 'all 0.2s',
                  }}
                >
                  <Sun size={14} /> In Session
                </button>
                <button
                  onClick={() => isSummerBreak ? null : setConfirm('summer_break')}
                  disabled={saving || mode === null}
                  style={{
                    padding: '9px 18px',
                    fontSize: '0.83rem', fontWeight: 600,
                    border: 'none', cursor: (isSummerBreak || saving) ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 7,
                    background: isSummerBreak ? '#e8590c' : '#f1f3f5',
                    color: isSummerBreak ? 'white' : '#868e96',
                    transition: 'all 0.2s',
                  }}
                >
                  {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <MoonStar size={14} />}
                  Summer Break
                </button>
              </div>
            </div>
          </div>

          {/* Future-mode hint */}
          <p style={{
            margin: '12px 0 0',
            fontSize: '0.77rem',
            color: isSummerBreak ? 'rgba(120,53,15,0.6)' : 'rgba(30,80,50,0.5)',
            borderTop: `1px solid ${isSummerBreak ? 'rgba(234,88,12,0.15)' : 'rgba(64,192,87,0.2)'}`,
            paddingTop: 10,
          }}>
            Changes take effect immediately for all logged-in users and the Time Clock kiosk.
            This toggle can also be used for spring break, maintenance windows, or any other period when student access should be suspended.
          </p>
        </div>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTRUCTOR AWAY (MEETING) MODE CARD
// ═══════════════════════════════════════════════════════════════════════════════

function InstructorAwayCard() {
  const { profile } = useAuth()
  const [awayMode, setAwayMode] = useState(null)       // null = loading, true/false
  const [returnTime, setReturnTime] = useState('')      // e.g. '2:30 PM'
  const [savedReturnTime, setSavedReturnTime] = useState('')
  const [saving, setSaving] = useState(false)
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  // ── Fetch current values ──
  const fetchAway = async () => {
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
  }

  useEffect(() => { fetchAway() }, [])

  // ── Realtime sync ──
  useEffect(() => {
    const channel = supabase
      .channel('instructor-away-settings')
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

  // ── Upsert a setting ──
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

  // ── Toggle away mode ──
  const toggleAway = async (newVal) => {
    setSaving(true)
    try {
      await upsertSetting(
        'instructor_away_mode',
        String(newVal),
        'When true, students are told instructor is in a meeting when requesting help'
      )
      // If turning on AND there's a return time entered, save it too
      if (newVal && returnTime.trim()) {
        await upsertSetting(
          'instructor_return_time',
          returnTime.trim(),
          'Return time shown to students when instructor is away in a meeting'
        )
        setSavedReturnTime(returnTime.trim())
      }
      // If turning off, clear the return time
      if (!newVal) {
        await upsertSetting(
          'instructor_return_time',
          '',
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

  // ── Save return time only (while already in away mode) ──
  const saveReturnTime = async () => {
    if (!returnTime.trim()) return
    setSaving(true)
    try {
      await upsertSetting(
        'instructor_return_time',
        returnTime.trim(),
        'Return time shown to students when instructor is away in a meeting'
      )
      setSavedReturnTime(returnTime.trim())
      toast.success('Return time updated to ' + returnTime.trim())
    } catch (err) {
      toast.error('Failed to save return time: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const isAway = awayMode === true
  const isLoading = awayMode === null
  const timeIsDirty = awayMode && returnTime.trim() !== savedReturnTime

  return (
    <div style={{
      borderRadius: 14,
      border: isAway ? '2px solid #dc2626' : '2px solid #d1d5db',
      overflow: 'hidden',
      background: isAway
        ? 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)'
        : 'linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%)',
      transition: 'border-color 0.3s, background 0.3s',
    }}>
      {/* Status banner */}
      <div style={{
        padding: '10px 20px',
        background: isAway
          ? 'linear-gradient(90deg, #dc2626, #b91c1c)'
          : 'linear-gradient(90deg, #6b7280, #4b5563)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Clock size={16} style={{ color: 'white' }} />
          <span style={{ color: 'white', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.03em' }}>
            {isAway
              ? `AWAY — IN A MEETING${savedReturnTime ? ` · RETURNING AT ${savedReturnTime.toUpperCase()}` : ''}`
              : 'AVAILABLE — IN LAB'}
          </span>
        </div>
        {isLoading && <Loader2 size={14} style={{ color: 'rgba(255,255,255,0.7)', animation: 'spin 1s linear infinite' }} />}
      </div>

      {/* Body */}
      <div style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          {/* Description */}
          <div style={{ flex: 1 }}>
            <h3 style={{
              margin: '0 0 6px',
              fontSize: '0.95rem', fontWeight: 700,
              color: isAway ? '#991b1b' : '#374151',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              Instructor Away Mode
            </h3>
            <p style={{
              margin: 0, fontSize: '0.83rem',
              color: isAway ? '#b91c1c' : '#6b7280',
              lineHeight: 1.55,
            }}>
              {isAway
                ? 'Students requesting help will be notified that you are in a meeting. The Lab Status kiosk shows a red AWAY indicator. Toggle off when you return.'
                : 'Enable this when you step into a meeting. Students will be informed via the help button and Lab Status page. Remember to toggle off when you return — it will not auto-disable.'}
            </p>
          </div>

          {/* Toggle button */}
          <div style={{ flexShrink: 0 }}>
            <div style={{
              display: 'inline-flex',
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid rgba(0,0,0,0.12)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            }}>
              <button
                onClick={() => isAway && toggleAway(false)}
                disabled={saving || isLoading}
                style={{
                  padding: '9px 18px',
                  fontSize: '0.83rem', fontWeight: 600,
                  border: 'none', cursor: (!isAway || saving) ? 'default' : 'pointer',
                  background: !isAway ? '#16a34a' : '#f1f3f5',
                  color: !isAway ? 'white' : '#868e96',
                  transition: 'all 0.2s',
                  display: 'flex', alignItems: 'center', gap: 7,
                }}
              >
                <CheckCircle2 size={14} /> Available
              </button>
              <button
                onClick={() => !isAway && toggleAway(true)}
                disabled={saving || isLoading}
                style={{
                  padding: '9px 18px',
                  fontSize: '0.83rem', fontWeight: 600,
                  border: 'none', cursor: (isAway || saving) ? 'default' : 'pointer',
                  background: isAway ? '#dc2626' : '#f1f3f5',
                  color: isAway ? 'white' : '#868e96',
                  transition: 'all 0.2s',
                  display: 'flex', alignItems: 'center', gap: 7,
                }}
              >
                {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Clock size={14} />}
                Away
              </button>
            </div>
          </div>
        </div>

        {/* Return time input — always visible for convenience, but highlighted when Away */}
        <div style={{
          marginTop: 14,
          padding: '12px 16px',
          background: isAway ? 'rgba(220,38,38,0.06)' : '#f9fafb',
          border: `1px solid ${isAway ? 'rgba(220,38,38,0.2)' : '#e5e7eb'}`,
          borderRadius: 10,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: isAway ? '#991b1b' : '#6b7280', display: 'block', marginBottom: 4 }}>
              Expected Return Time
            </label>
            <input
              type="text"
              value={returnTime}
              onChange={e => setReturnTime(e.target.value)}
              placeholder="e.g. 2:30 PM"
              maxLength={20}
              style={{
                width: '100%', maxWidth: 180, padding: '7px 12px',
                border: `1px solid ${isAway ? '#fca5a5' : '#d1d5db'}`,
                borderRadius: 8, fontSize: '0.88rem',
                background: 'white', color: '#1f2937',
                outline: 'none',
              }}
            />
          </div>
          {isAway && timeIsDirty && (
            <button
              onClick={saveReturnTime}
              disabled={saving}
              style={{
                padding: '8px 16px', borderRadius: 8,
                background: '#dc2626', color: 'white',
                border: 'none', fontSize: '0.82rem', fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {saving ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={12} />}
              Update Time
            </button>
          )}
        </div>

        {/* Hint */}
        <p style={{
          margin: '12px 0 0',
          fontSize: '0.77rem',
          color: isAway ? 'rgba(153,27,27,0.6)' : 'rgba(107,114,128,0.6)',
          borderTop: `1px solid ${isAway ? 'rgba(220,38,38,0.12)' : '#e5e7eb'}`,
          paddingTop: 10,
        }}>
          {isAway
            ? 'This will NOT auto-disable. Remember to toggle back to Available when you return from your meeting.'
            : 'Changes take effect immediately for all student help requests and the Lab Status kiosk.'}
        </p>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

function DashboardSettings() {
  const { profile } = useAuth()
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  // null = loading, true/false = loaded value
  const [dayViewDefault, setDayViewDefault] = useState(null)
  const [tempAccessDefault, setTempAccessDefault] = useState(null)
  const [saving, setSaving] = useState('')   // '' | 'day_view' | 'temp_access'

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
      setDayViewDefault(get('dashboard_day_view_expanded', true))
      setTempAccessDefault(get('dashboard_temp_access_expanded', false))
    } catch {
      setDayViewDefault(true)
      setTempAccessDefault(false)
    }
  }, [])

  useEffect(() => { fetchDefaults() }, [fetchDefaults])

  // Realtime sync if another session changes it
  useEffect(() => {
    const ch = supabase.channel('dash-settings-sync')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.dashboard_day_view_expanded',
      }, (p) => { if (p.new?.setting_value !== undefined) setDayViewDefault(p.new.setting_value === 'true') })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.dashboard_temp_access_expanded',
      }, (p) => { if (p.new?.setting_value !== undefined) setTempAccessDefault(p.new.setting_value === 'true') })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])

  const applyToggle = async (key, newVal, savingKey, setter) => {
    setSaving(savingKey)
    try {
      const { data: rows, error } = await supabase
        .from('settings')
        .update({ setting_value: String(newVal), updated_at: new Date().toISOString(), updated_by: userName })
        .eq('setting_key', key)
        .select()
      if (error) throw error
      if (!rows || rows.length === 0) {
        // Row doesn't exist yet — insert it
        const descs = {
          dashboard_day_view_expanded:   'Whether the Day View card is expanded by default on the instructor dashboard',
          dashboard_temp_access_expanded:'Whether the Active Temp Access card is expanded by default on the instructor dashboard',
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
      setter(newVal)
      toast.success('Dashboard default updated')
    } catch (err) {
      toast.error('Failed to save: ' + err.message)
    } finally {
      setSaving('')
    }
  }

  const isLoading = dayViewDefault === null || tempAccessDefault === null

  // A reusable toggle row
  const ToggleRow = ({ label, desc, value, onToggle, savingKey }) => {
    const isSavingThis = saving === savingKey
    return (
      <div className="px-5 py-4 flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-surface-800">{label}</div>
          <div className="text-xs text-surface-400 mt-0.5">{desc}</div>
        </div>
        <div style={{ display: 'inline-flex', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(0,0,0,0.12)', boxShadow: '0 1px 3px rgba(0,0,0,0.07)', flexShrink: 0 }}>
          <button
            onClick={() => !value && onToggle(true)}
            disabled={isSavingThis || value === null}
            style={{
              padding: '7px 16px', fontSize: '0.8rem', fontWeight: 600,
              border: 'none', cursor: value ? 'default' : 'pointer',
              background: value ? '#228be6' : '#f1f3f5',
              color: value ? 'white' : '#868e96',
              transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {isSavingThis && value ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            Expanded
          </button>
          <button
            onClick={() => value && onToggle(false)}
            disabled={isSavingThis || value === null}
            style={{
              padding: '7px 16px', fontSize: '0.8rem', fontWeight: 600,
              border: 'none', cursor: !value ? 'default' : 'pointer',
              background: !value ? '#495057' : '#f1f3f5',
              color: !value ? 'white' : '#868e96',
              transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {isSavingThis && !value ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            Collapsed
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Instructor Dashboard Defaults ── */}
      <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-surface-100 flex items-center gap-2">
          <LayoutDashboard size={15} className="text-brand-500" />
          <h3 className="text-sm font-semibold text-surface-900">Instructor Dashboard — Default Layout</h3>
        </div>

        {isLoading ? (
          <div className="py-10 text-center text-surface-400">
            <Loader2 size={20} className="mx-auto mb-2 animate-spin" />
            <p className="text-xs">Loading dashboard settings…</p>
          </div>
        ) : (
          <div className="divide-y divide-surface-100">
            <ToggleRow
              label="Day View — Default State"
              desc="Whether the Day View card starts expanded or collapsed when the instructor opens the dashboard."
              value={dayViewDefault}
              savingKey="day_view"
              onToggle={(v) => applyToggle('dashboard_day_view_expanded', v, 'day_view', setDayViewDefault)}
            />
            <ToggleRow
              label="Active Temp Access — Default State"
              desc="Whether the Active Temp Access card starts expanded or collapsed when the instructor opens the dashboard."
              value={tempAccessDefault}
              savingKey="temp_access"
              onToggle={(v) => applyToggle('dashboard_temp_access_expanded', v, 'temp_access', setTempAccessDefault)}
            />
          </div>
        )}
      </div>

      {/* ── Note about localStorage ── */}
      <div className="bg-surface-50 border border-surface-200 rounded-xl px-5 py-4 flex gap-3">
        <AlertCircle size={16} className="text-surface-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-surface-700">How these defaults work</p>
          <p className="text-xs text-surface-500 mt-1 leading-relaxed">
            These settings control the <strong>initial</strong> state on first load. Once an instructor manually
            expands or collapses a card, their preference is saved in their browser and takes priority over this
            setting for that device. Clearing browser data or using a new device will reset back to these defaults.
          </p>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY LABS SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

function WeeklyLabsSettings() {
  const { profile } = useAuth()
  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''
  const [message, setMessage] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Fetch current reminder message
  useEffect(() => {
    async function load() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('setting_value')
          .eq('setting_key', 'alldone_weekly_reminder')
          .maybeSingle()
        const val = data?.setting_value || ''
        setMessage(val)
        setSavedMessage(val)
      } catch {
        setMessage('')
        setSavedMessage('')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const isDirty = message !== savedMessage

  const handleSave = async () => {
    setSaving(true)
    try {
      const { data: rows, error } = await supabase
        .from('settings')
        .update({
          setting_value: message.trim(),
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('setting_key', 'alldone_weekly_reminder')
        .select()

      if (error) throw error

      if (!rows || rows.length === 0) {
        // Row doesn't exist yet — insert it
        await supabase.from('settings').insert({
          setting_key: 'alldone_weekly_reminder',
          setting_value: message.trim(),
          description: 'Optional instructor reminder message shown in the Mark All Done popup on the Weekly Labs Tracker',
          category: 'Weekly Labs',
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
      }

      setSavedMessage(message.trim())
      setMessage(message.trim())
      toast.success(message.trim() ? 'Reminder message saved' : 'Reminder message cleared')
    } catch (err) {
      toast.error('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleClear = () => {
    setMessage('')
  }

  return (
    <div className="space-y-4">
      {/* All Done Reminder Card */}
      <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-surface-100 flex items-center gap-2">
          <MessageSquare size={15} className="text-brand-500" />
          <h3 className="text-sm font-semibold text-surface-900">Mark All Done — Weekly Reminder</h3>
        </div>

        {loading ? (
          <div className="py-10 text-center text-surface-400">
            <Loader2 size={20} className="mx-auto mb-2 animate-spin" />
            <p className="text-xs">Loading…</p>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            <p className="text-xs text-surface-500 leading-relaxed">
              This message will appear as an amber reminder banner inside the <strong>Mark All Done</strong> popup
              on the Weekly Labs Tracker page. Use it to remind yourself to ask students about pending tasks
              before swiping your badge. Leave it blank to show no banner.
            </p>

            {/* Preview — only shown when there is a message */}
            {message.trim() && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                <AlertTriangle size={15} className="flex-shrink-0 mt-0.5 text-amber-500" />
                <span className="leading-snug">{message}</span>
              </div>
            )}

            <div>
              <label className="text-xs font-semibold text-surface-500 mb-1.5 block">
                Reminder Message
              </label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="e.g. Ask students if they have registered for next semester's classes."
                rows={3}
                className="input text-sm resize-y w-full"
                maxLength={500}
              />
              <div className="flex justify-between mt-1">
                <span className="text-[10px] text-surface-400">
                  {message.length}/500 characters
                </span>
                {message.trim() && (
                  <button
                    onClick={handleClear}
                    className="text-[10px] text-surface-400 hover:text-red-500 transition-colors"
                  >
                    Clear message
                  </button>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !isDirty}
                className="px-4 py-2 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {saving ? 'Saving…' : 'Save Message'}
              </button>
              {isDirty && (
                <button
                  onClick={() => setMessage(savedMessage)}
                  className="px-4 py-2 rounded-lg bg-surface-100 text-xs font-medium text-surface-600 hover:bg-surface-200 transition-colors flex items-center gap-1.5"
                >
                  <RotateCcw size={12} /> Discard
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Info note */}
      <div className="bg-surface-50 border border-surface-200 rounded-xl px-5 py-4 flex gap-3">
        <AlertCircle size={16} className="text-surface-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-surface-700">How this works</p>
          <p className="text-xs text-surface-500 mt-1 leading-relaxed">
            The message is shared across all instructors and persists until you change or clear it.
            It appears in the Mark All Done popup for <strong>every student</strong> during the current week.
            Update it each week as needed, or clear it when there is nothing to remind.
          </p>
        </div>
      </div>
    </div>
  )
}

function GeneralSettings() {
  const { settings, loading, refresh } = useSettings()
  const actions = useSettingsActions()
  const [edits, setEdits] = useState({})
  const [dirty, setDirty] = useState({})

  useEffect(() => {
    const map = {}
    settings.forEach(s => {
      let val = s.setting_value ?? ''
      // Format dates for date inputs
      if (SETTING_META[s.setting_key]?.type === 'date' && val) {
        val = String(val).substring(0, 10)
      }
      map[s.setting_key] = String(val)
    })
    setEdits(map)
    setDirty({})
  }, [settings])

  const handleChange = (key, value) => {
    setEdits(prev => ({ ...prev, [key]: value }))
    const original = settings.find(s => s.setting_key === key)
    setDirty(prev => ({ ...prev, [key]: String(value) !== String(original?.setting_value ?? '') }))
  }

  const saveSetting = async (key) => {
    await actions.updateSetting(key, edits[key] || '')
    setDirty(prev => ({ ...prev, [key]: false }))
    refresh()
  }

  const saveAll = async () => {
    const dirtyKeys = Object.keys(dirty).filter(k => dirty[k])
    for (const key of dirtyKeys) {
      await actions.updateSetting(key, edits[key] || '')
    }
    setDirty({})
    refresh()
  }

  // Group settings by category
  const groups = {}
  settings.forEach(s => {
    const cat = s.category || 'General'
    // Skip settings managed elsewhere or no longer relevant
    if (cat === 'Storage') return    // Google Drive folder IDs - not relevant in Supabase
    if (cat === 'Evaluation') return // Managed on the WOC Ratio page
    if (cat === 'PM') return         // Managed on the Preventive Maintenance page
    if (cat === 'Weekly Labs') return // Weeks derived from class start/end dates
    if (cat === 'program_cost') return      // Managed via Program Cost page (tuition rates, delivery modes)
    if (cat === 'program_revisions') return // Managed via Course Revision tile gear icon
    if (cat === 'course_proposals') return  // Managed via New Course Proposal tile gear icon
    if (cat === 'course_revisions') return  // Managed via Course Revision tile gear icon
    if (cat === 'Dashboard') return  // Managed on the Dashboard Settings tab
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(s)
  })

  const hasDirty = Object.values(dirty).some(Boolean)

  if (loading) return <div className="text-center py-12 text-surface-400">Loading settings...</div>

  return (
    <div className="space-y-4">
      {/* ── Lab Access Mode — always first ── */}
      <LabAccessModeCard />

      {/* ── Instructor Away (Meeting) Mode ── */}
      <InstructorAwayCard />

      {/* Save All bar */}
      {hasDirty && (
        <div className="bg-brand-50 border border-brand-200 rounded-xl px-4 py-2.5 flex items-center justify-between">
          <span className="text-sm text-brand-700 font-medium">
            You have unsaved changes ({Object.values(dirty).filter(Boolean).length} settings modified)
          </span>
          <button onClick={saveAll} disabled={actions.saving}
            className="px-4 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1.5 hover:bg-brand-700">
            {actions.saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save All
          </button>
        </div>
      )}

      {Object.entries(groups).map(([category, items]) => {
        const CatIcon = CATEGORY_ICONS[category] || Sliders
        return (
          <div key={category} className="bg-white rounded-xl border border-surface-200">
            <div className="px-4 py-3 border-b border-surface-100 flex items-center gap-2">
              <CatIcon size={15} className="text-brand-500" />
              <h3 className="text-sm font-semibold text-surface-900">{category}</h3>
            </div>
            <div className="divide-y divide-surface-100">
              {items.map(s => {
                const meta = SETTING_META[s.setting_key]
                const inputType = meta?.type || 'text'
                const label = meta?.label || s.setting_key
                const desc = meta?.desc || s.description || ''
                const isDirty = dirty[s.setting_key]

                // Custom day-of-week checkbox control for lab_visible_days
                if (s.setting_key === 'lab_visible_days') {
                  const DAY_LABELS = ['S', 'M', 'T', 'W', 'Th', 'F', 'S']
                  const currentDays = (edits[s.setting_key] || '').split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d))

                  const toggleDay = (dayNum) => {
                    const next = currentDays.includes(dayNum)
                      ? currentDays.filter(d => d !== dayNum)
                      : [...currentDays, dayNum].sort((a, b) => a - b)
                    handleChange(s.setting_key, next.join(','))
                  }

                  return (
                    <div key={s.setting_key} className={`px-4 py-3 flex items-center gap-3 ${isDirty ? 'bg-yellow-50' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-surface-700">{label}</div>
                        {desc && <div className="text-xs text-surface-400 mt-0.5">Select days the lab is open</div>}
                      </div>
                      <div className="flex gap-1">
                        {DAY_LABELS.map((dayLabel, idx) => {
                          const isActive = currentDays.includes(idx)
                          return (
                            <button
                              key={idx}
                              onClick={() => toggleDay(idx)}
                              className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${
                                isActive
                                  ? 'bg-brand-600 text-white shadow-sm'
                                  : 'bg-surface-100 text-surface-400 hover:bg-surface-200'
                              }`}
                            >
                              {dayLabel}
                            </button>
                          )
                        })}
                      </div>
                      <button onClick={() => saveSetting(s.setting_key)}
                        disabled={actions.saving || !isDirty}
                        className={`p-2 rounded-lg transition-colors ${isDirty ? 'hover:bg-brand-50 text-brand-600' : 'text-surface-300'}`}
                        title="Save this setting">
                        <Save size={14} />
                      </button>
                    </div>
                  )
                }

                return (
                  <div key={s.setting_key} className={`px-4 py-3 flex items-center gap-3 ${isDirty ? 'bg-yellow-50' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-surface-700">{label}</div>
                      {desc && <div className="text-xs text-surface-400 mt-0.5">{desc}</div>}
                    </div>
                    <input
                      type={inputType}
                      value={edits[s.setting_key] ?? ''}
                      onChange={e => handleChange(s.setting_key, e.target.value)}
                      className={`input text-sm ${inputType === 'number' ? 'w-24' : inputType === 'date' ? 'w-40' : 'w-48'}`}
                    />
                    <button onClick={() => saveSetting(s.setting_key)}
                      disabled={actions.saving || !isDirty}
                      className={`p-2 rounded-lg transition-colors ${isDirty ? 'hover:bg-brand-50 text-brand-600' : 'text-surface-300'}`}
                      title="Save this setting">
                      <Save size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {settings.length === 0 && (
        <div className="text-center py-12 text-surface-400">
          <AlertCircle size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">No settings configured yet. Run the migration SQL to seed default settings.</p>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC CRUD TABLE SECTION
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

  const startAdd = () => {
    setForm({ ...defaultItem })
    setEditing('new')
  }
  const startEdit = (item) => {
    setForm({ ...item })
    setEditing(item)
  }
  const cancel = () => {
    setEditing(null)
    setForm({})
  }

  const handleSave = async () => {
    try {
      // Ensure color fields always have a value (prevent empty colors)
      const validated = { ...form }
      columns.forEach(col => {
        if (col.type === 'color' && !validated[col.key]) {
          validated[col.key] = '#228be6'
        }
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

  if (loading) return <div className="text-center py-12 text-surface-400">Loading...</div>

  return (
    <div className="bg-white rounded-xl border border-surface-200">
      <div className="px-4 py-3 border-b border-surface-100 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-surface-900 flex items-center gap-2">
          {Icon && <Icon size={15} className="text-brand-500" />}
          {title} ({items.length})
        </h3>
        <div className="flex items-center gap-2">
          {searchable && items.length > 8 && (
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search..." className="input text-xs pl-7 w-32" />
            </div>
          )}
          <button onClick={startAdd} className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1">
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {/* Add/Edit Form */}
      {editing && (
        <div className="px-4 py-3 bg-brand-50 border-b border-brand-100 space-y-2">
          <div className="text-xs font-semibold text-brand-700 mb-1">
            {editing === 'new' ? 'Add New' : 'Edit'}
          </div>
          <div className="flex flex-wrap gap-2">
            {columns.filter(col => col.key !== idColumn || editing === 'new').map(col => (
              <div key={col.key} className={`${col.wide ? 'flex-[2]' : 'flex-1'} min-w-[120px]`}>
                <label className="text-[10px] text-surface-500 font-medium">{col.label}</label>
                {col.type === 'select' ? (
                  <select value={form[col.key] || ''} onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))} className="input text-sm">
                    {col.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : col.type === 'color' ? (
                  <div className="flex gap-1 items-center">
                    <input type="color" value={form[col.key] || '#228be6'}
                      onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                      className="w-8 h-8 rounded cursor-pointer border-0" />
                    <input type="text" value={form[col.key] || ''} onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                      className="input text-sm flex-1" placeholder="#228be6" />
                  </div>
                ) : (
                  <input type={col.type || 'text'} value={form[col.key] || ''}
                    onChange={e => setForm(f => ({ ...f, [col.key]: e.target.value }))}
                    className="input text-sm" placeholder={col.placeholder || ''} readOnly={col.key === idColumn} />
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={actions.saving} className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1">
              {actions.saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Save
            </button>
            <button onClick={cancel} className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs">Cancel</button>
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
                          <span className="w-4 h-4 rounded" style={{ backgroundColor: item[col.key] || '#ccc' }} />
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
                      <button onClick={() => startEdit(item)} className="p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-brand-600"><Edit3 size={13} /></button>
                      <button onClick={() => handleDelete(item[idColumn])} className="p-1 rounded hover:bg-red-50 text-surface-400 hover:text-red-500"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════════

function CategoriesSection() {
  return <CrudSection title="Categories" icon={Tag} useItemsHook={useCategories} useActionsHook={useCategoryActions}
    idColumn="category_id" columns={[
      { key: 'category_id', label: 'ID' },
      { key: 'category_name', label: 'Name', wide: true },
      { key: 'description', label: 'Description', wide: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]} defaultItem={{ category_name: '', description: '', status: 'Active' }} />
}

function AssetLocationsSection() {
  return <CrudSection title="Asset Locations" icon={MapPin} useItemsHook={useAssetLocations} useActionsHook={useAssetLocationActions}
    idColumn="location_id" columns={[
      { key: 'location_id', label: 'ID' },
      { key: 'location_name', label: 'Name', wide: true },
      { key: 'description', label: 'Description', wide: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]} defaultItem={{ location_name: '', description: '', status: 'Active' }} />
}

function InventoryLocationsSection() {
  return <CrudSection title="Inventory Locations" icon={Box} useItemsHook={useInventoryLocations} useActionsHook={useInventoryLocationActions}
    idColumn="location_id" searchable columns={[
      { key: 'location_id', label: 'ID' },
      { key: 'location_name', label: 'Name', wide: true },
      { key: 'description', label: 'Description', wide: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]} defaultItem={{ location_name: '', description: '', status: 'Active' }} />
}

function VendorsSection() {
  return <CrudSection title="Vendors" icon={Truck} useItemsHook={useVendorsList} useActionsHook={useVendorActions}
    idColumn="vendor_id" searchable columns={[
      { key: 'vendor_id', label: 'ID' },
      { key: 'vendor_name', label: 'Name', wide: true },
      { key: 'contact_name', label: 'Contact' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'website', label: 'Website' },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]} defaultItem={{ vendor_name: '', contact_name: '', phone: '', email: '', website: '', status: 'Active' }} />
}

function WOStatusesSection() {
  return <CrudSection title="Work Order Statuses" icon={ClipboardList} useItemsHook={useWOStatuses} useActionsHook={useWOStatusActions}
    idColumn="status_id" columns={[
      { key: 'status_id', label: 'ID' },
      { key: 'status_name', label: 'Name' },
      { key: 'description', label: 'Description', wide: true },
      { key: 'color', label: 'Color', type: 'color' },
      { key: 'display_order', label: 'Order', type: 'number' },
      { key: 'is_closed_status', label: 'Is Closed', type: 'select', options: ['Yes', 'No'] },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }
    ]} defaultItem={{ status_name: '', description: '', color: '#228be6', display_order: 0, is_closed_status: 'No', status: 'Active' }} />
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEK CALCULATION HELPER
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
    wkThu.setDate(wkThu.getDate() + 3) // Thursday

    // Determine type
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
// CLASSES SECTION (Custom - has dates, enrollment, required hours, week preview)
// ═══════════════════════════════════════════════════════════════════════════════

function ClassesSection() {
  const { items: classes, loading, refresh } = useClasses()
  const actions = useClassActions()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({})
  const [enrollmentClass, setEnrollmentClass] = useState(null)
  const [duplicateClass, setDuplicateClass] = useState(null)
  const [showInactive, setShowInactive] = useState(false)
  const [search, setSearch] = useState('')
  const [enrollmentMap, setEnrollmentMap] = useState({})

  // Load enrollment data so we can search by student name/email
  useEffect(() => {
    async function loadEnrollment() {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('first_name, last_name, email, classes')
          .in('role', ['Student', 'Work Study'])
          .eq('status', 'Active')
        const map = {}
        ;(data || []).forEach(s => {
          const courses = (s.classes || '').split(',').map(c => c.trim()).filter(Boolean)
          courses.forEach(courseId => {
            if (!map[courseId]) map[courseId] = []
            map[courseId].push({
              name: `${s.first_name} ${s.last_name}`,
              email: s.email || '',
            })
          })
        })
        setEnrollmentMap(map)
      } catch (err) {
        console.error('Enrollment map load error:', err)
      }
    }
    loadEnrollment()
  }, [])

  // Convert empty date strings to null for Supabase
  const cleanDates = (data) => {
    const dateFields = ['start_date', 'end_date', 'spring_break_start', 'spring_break_end', 'finals_start', 'finals_end']
    dateFields.forEach(f => {
      if (!data[f] || data[f] === '') data[f] = null
    })
    return data
  }

  const startAdd = () => {
    setForm({
      course_id: '', course_name: '', required_hours: 0, instructor: '',
      semester: '', status: 'Active', tracking_type: 'Weekly', requires_approval: 'false',
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
      requires_approval: cls.requires_approval || 'false',
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

  // Calculate week preview for the form
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
  const activeCount = classes.filter(c => c.status === 'Active').length

  if (loading) return <div className="text-center py-12 text-surface-400">Loading classes...</div>

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-surface-200">
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface-100 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-surface-900 flex items-center gap-2 mr-auto">
            <GraduationCap size={15} className="text-brand-500" />
            Classes
            <span className="text-surface-400 font-normal">
              ({displayedClasses.length}{!showInactive && inactiveCount > 0 ? ` of ${classes.length}` : ''})
            </span>
          </h3>

          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search classes or students…"
              className="input text-xs pl-7 w-48"
            />
          </div>

          {/* Inactive toggle */}
          {inactiveCount > 0 && (
            <button
              onClick={() => setShowInactive(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                showInactive
                  ? 'bg-surface-100 text-surface-700 border-surface-200'
                  : 'bg-white text-surface-400 border-surface-200 hover:text-surface-600'
              }`}
              title={showInactive ? 'Hide inactive classes' : `Show ${inactiveCount} inactive class${inactiveCount !== 1 ? 'es' : ''}`}
            >
              {showInactive ? <EyeOff size={12} /> : <Eye size={12} />}
              {showInactive ? 'Hide Inactive' : `+${inactiveCount} Inactive`}
            </button>
          )}

          <button onClick={startAdd} className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1">
            <Plus size={12} /> Add Class
          </button>
        </div>

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
                <input type="number" value={form.required_hours} onChange={e => setForm(f => ({ ...f, required_hours: parseFloat(e.target.value) || 0 }))}
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
              <div>
                <label className="text-[10px] text-surface-500 font-medium">Requires Approval</label>
                <select value={form.requires_approval} onChange={e => setForm(f => ({ ...f, requires_approval: e.target.value }))} className="input text-sm">
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
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

            {/* Date hint */}
            {form.start_date && form.end_date && form.tracking_type !== 'None' && (
              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                <Calendar size={13} />
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

            {/* Week Preview */}
            {weekPreview.length > 0 && (
              <div className="bg-white border border-surface-200 rounded-lg p-3">
                <div className="text-xs font-semibold text-surface-700 flex items-center gap-1.5 mb-2">
                  <Calendar size={13} className="text-brand-500" />
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
                      <div className="opacity-75">{w.start}-{w.end}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3 mt-2 text-[10px] text-surface-500">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-200" /> Class Week</span>
                  {weekPreview.some(w => w.type === 'spring_break') && (
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-blue-200" /> Spring Break</span>
                  )}
                  {weekPreview.some(w => w.type === 'finals') && (
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-200" /> Finals</span>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={handleSave} disabled={actions.saving} className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1">
                {actions.saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Save
              </button>
              <button onClick={() => { setEditing(null); setForm({}) }} className="px-3 py-1.5 rounded-lg bg-surface-100 text-surface-600 text-xs">Cancel</button>
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
                  const enrolledCount = enrolledStudents.length
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
                        {enrolledCount > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 cursor-default"
                            title={enrolledStudents.map(s => s.name).join('\n')}
                          >
                            <Users size={10} /> {enrolledCount}
                          </span>
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
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <button onClick={() => setEnrollmentClass(cls)} title="Manage Enrollment"
                            className="p-1 rounded hover:bg-blue-50 text-surface-400 hover:text-blue-600">
                            <Users size={13} />
                          </button>
                          <button onClick={() => setDuplicateClass(cls)} title="Duplicate Class (new semester)"
                            className="p-1 rounded hover:bg-violet-50 text-surface-400 hover:text-violet-600">
                            <Copy size={13} />
                          </button>
                          <button onClick={() => startEdit(cls)} title="Edit Class"
                            className="p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-brand-600">
                            <Edit3 size={13} />
                          </button>
                          <button onClick={() => handleDelete(cls.class_id)} title="Delete Class"
                            className="p-1 rounded hover:bg-red-50 text-surface-400 hover:text-red-500">
                            <Trash2 size={13} />
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
      </div>

      {/* Enrollment Modal */}
      {enrollmentClass && (
        <EnrollmentModal cls={enrollmentClass} onClose={() => setEnrollmentClass(null)} />
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
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE CLASS MODAL
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

  const weekPreview = useMemo(() => {
    if (!form.start_date || !form.end_date) return []
    return calculateWeeks(
      form.start_date, form.end_date,
      form.spring_break_start, form.spring_break_end,
      form.finals_start, form.finals_end
    )
  }, [form.start_date, form.end_date, form.spring_break_start, form.spring_break_end, form.finals_start, form.finals_end])

  const normalWeekCount = weekPreview.filter(w => w.type === 'normal').length

  const cleanDates = (data) => {
    const dateFields = ['start_date', 'end_date', 'spring_break_start', 'spring_break_end', 'finals_start', 'finals_end']
    dateFields.forEach(f => { if (!data[f] || data[f] === '') data[f] = null })
    return data
  }

  const handleSave = async () => {
    if (!form.semester.trim()) { toast.error('Please enter a semester.'); return }
    if (!form.start_date || !form.end_date) { toast.error('Start and End dates are required.'); return }
    setSaving(true)
    try {
      const newClass = cleanDates({
        course_id: cls.course_id,
        course_name: cls.course_name,
        required_hours: cls.required_hours,
        instructor: cls.instructor,
        tracking_type: cls.tracking_type || 'Weekly',
        requires_approval: cls.requires_approval || 'false',
        status: 'Active',
        semester: form.semester,
        start_date: form.start_date,
        end_date: form.end_date,
        spring_break_start: form.spring_break_start,
        spring_break_end: form.spring_break_end,
        finals_start: form.finals_start,
        finals_end: form.finals_end,
      })
      await actions.addItem(newClass)
      onSaved()
    } catch {
      // error already toasted by addItem
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-surface-900 flex items-center gap-2">
              <Copy size={14} className="text-violet-500" /> Duplicate Class
            </h3>
            <p className="text-xs text-surface-500 mt-0.5">
              Copying <span className="font-medium">{cls.course_id}</span> — {cls.course_name}
            </p>
          </div>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Info banner */}
          <div className="flex items-start gap-2 text-xs bg-violet-50 text-violet-700 border border-violet-200 rounded-lg px-3 py-2.5">
            <Users size={13} className="mt-0.5 shrink-0" />
            <span>A new class will be created with the same course details, hours, and instructor. <strong>Enrolled students will not be copied</strong> — you can enroll them separately.</span>
          </div>

          {/* Carried-over fields preview */}
          <div className="bg-surface-50 rounded-lg px-3 py-2.5 space-y-1">
            <div className="text-[10px] font-semibold text-surface-500 uppercase tracking-wide mb-1.5">Carried Over From Original</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-surface-600">
              <span><span className="text-surface-400">Course ID:</span> {cls.course_id || '—'}</span>
              <span><span className="text-surface-400">Name:</span> {cls.course_name || '—'}</span>
              <span><span className="text-surface-400">Hours/wk:</span> {cls.required_hours || 0}</span>
              <span><span className="text-surface-400">Instructor:</span> {cls.instructor || '—'}</span>
            </div>
          </div>

          {/* New fields */}
          <div>
            <label className="text-[10px] text-surface-500 font-medium">Semester *</label>
            <input
              value={form.semester}
              onChange={e => setForm(f => ({ ...f, semester: e.target.value }))}
              className="input text-sm"
              placeholder="Fall 2026"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-surface-500 font-medium">Start Date *</label>
              <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} className="input text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-surface-500 font-medium">End Date *</label>
              <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} className="input text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
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

          {/* Week preview */}
          {weekPreview.length > 0 && (
            <div className="bg-white border border-surface-200 rounded-lg p-3">
              <div className="text-xs font-semibold text-surface-700 flex items-center gap-1.5 mb-2">
                <Calendar size={13} className="text-brand-500" />
                Week Preview ({normalWeekCount} class weeks)
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
          <button onClick={handleSave} disabled={saving} className="btn-primary text-sm gap-1.5 flex-1">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            {saving ? 'Creating…' : 'Create Duplicate'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENROLLMENT MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function EnrollmentModal({ cls, onClose }) {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [enrolled, setEnrolled] = useState({})

  // Load students and determine enrollment
  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, email, role, classes, time_clock_only')
          .eq('status', 'Active')
          .in('role', ['Student', 'Work Study'])
          .order('last_name')

        const courseId = cls.course_id || ''
        const studentList = (data || []).filter(s => s.time_clock_only !== 'Yes')
        setStudents(studentList)

        // Determine who is currently enrolled
        const enrolledMap = {}
        studentList.forEach(s => {
          const classes = (s.classes || '').split(',').map(c => c.trim())
          if (classes.includes(courseId)) {
            enrolledMap[s.id] = true
          }
        })
        setEnrolled(enrolledMap)
      } catch (err) {
        console.error('Error loading students:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
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
      // For each student, update their classes field
      for (const student of students) {
        const currentClasses = (student.classes || '').split(',').map(c => c.trim()).filter(Boolean)
        const isEnrolled = !!enrolled[student.id]
        const wasEnrolled = currentClasses.includes(courseId)

        if (isEnrolled && !wasEnrolled) {
          // Add class
          const updated = [...currentClasses, courseId].join(', ')
          const { data: eRows, error: eErr } = await supabase.from('profiles').update({ classes: updated }).eq('id', student.id).select()
          if (eErr) throw eErr
          if (!eRows || eRows.length === 0) {
            toast.error(`Failed to enroll ${student.first_name} — check permissions.`)
          }
        } else if (!isEnrolled && wasEnrolled) {
          // Remove class
          const updated = currentClasses.filter(c => c !== courseId).join(', ')
          const { data: eRows, error: eErr } = await supabase.from('profiles').update({ classes: updated }).eq('id', student.id).select()
          if (eErr) throw eErr
          if (!eRows || eRows.length === 0) {
            toast.error(`Failed to unenroll ${student.first_name} — check permissions.`)
          }
        }
      }
      toast.success('Enrollment updated!')
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
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600"><X size={16} /></button>
        </div>

        <div className="px-5 py-3 space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search students..." className="input pl-9 text-sm" />
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
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-100 flex gap-2">
          <button onClick={handleSave} disabled={saving} className="btn-primary text-sm gap-1.5 flex-1">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving...' : 'Save Enrollment'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}
