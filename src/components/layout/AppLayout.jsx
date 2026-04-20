import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import NotificationBell from '@/components/NotificationBell'
import HoldLockoutModal from '@/components/holds/HoldLockoutModal'
import HoldReminderModal from '@/components/holds/HoldReminderModal'
import HoldNudgeBanner from '@/components/holds/HoldNudgeBanner'
import {
  Wrench,
  Package,
  Clock,
  BarChart3,
  Settings,
  Users,
  LogOut,
  Menu,
  X,
  ChevronRight,
  BoxIcon,
  Bug,
  ShoppingCart,
  Calendar,
  FlaskConical,
  LayoutDashboard,
  ClipboardList,
  FileSpreadsheet,
  PieChart,
  Landmark,
  Megaphone,
  ShieldCheck,
  KeyRound,
  Heart,
  Eye,
  EyeOff,
  Lock,
  Loader2,
  CheckCircle,
  Search,
  ChevronDown,
  ChevronUp,
  FileText,
  HelpCircle,
  XCircle,
  MoonStar,
  GraduationCap,
  FileSearch,
} from 'lucide-react'

const SUPER_ADMIN_EMAIL = 'rictprogram@gmail.com'

// Sidebar navigation grouped by section
// permPage maps to the `page` column in the permissions table for view_page check
// If permPage is null, item is always visible (or uses special logic like superAdminOnly)
const navSections = [
  {
    // No section title for the main group
    items: [
      { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permPage: 'Dashboard', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Work Orders', href: '/work-orders', icon: ClipboardList, permPage: 'Work Orders', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Inventory', href: '/inventory', icon: Package, permPage: 'Inventory', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Assets', href: '/assets', icon: BoxIcon, permPage: 'Assets', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'SOPs', href: '/sops', icon: FileText, permPage: 'SOPs', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Purchase Orders', href: '/purchase-orders', icon: ShoppingCart, permPage: 'Purchase Orders', roles: ['Student', 'Work Study', 'Instructor'] },
    ],
  },
  {
    title: 'SCHEDULING',
    items: [
      { name: 'Preventive Maintenance', href: '/pm-schedules', icon: Calendar, permPage: 'PM', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Lab Signup', href: '/lab-signup', icon: FlaskConical, permPage: 'Lab Signup', roles: ['Student', 'Work Study', 'Instructor'] },
    ],
  },
  {
    title: 'REPORTS',
    items: [
      { name: 'Time Cards', href: '/time-cards', icon: Clock, permPage: 'Reports', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Weekly Labs Tracker', href: '/weekly-labs', icon: FileSpreadsheet, permPage: 'Weekly Labs', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Volunteer Hours', href: '/volunteer-hours', icon: Heart, permPage: 'Volunteer Hours', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Attendance Reports', href: '/attendance-reports', icon: BarChart3, permPage: null, roles: ['Instructor'] },
      { name: 'WOC Ratio', href: '/woc-ratio', icon: PieChart, permPage: 'WOC Ratio', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Program Budget', href: '/program-budget', icon: Landmark, permPage: 'Program Budget', roles: ['Instructor'] },
      { name: 'Bug Tracker', href: '/bug-tracker', icon: Bug, permPage: 'Bug Tracker', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Request History', href: '/request-history', icon: FileSearch, permPage: 'Request History', roles: ['Student', 'Work Study', 'Instructor'] },
    ],
  },
  {
    title: 'ADMINISTRATION',
    items: [
      { name: 'Users', href: '/users', icon: Users, permPage: 'Users', roles: ['Instructor'] },
      { name: 'Announcements', href: '/announcements', icon: Megaphone, permPage: 'Announcements', roles: ['Student', 'Work Study', 'Instructor'] },
      { name: 'Settings', href: '/settings', icon: Settings, permPage: 'Settings', roles: ['Instructor'] },
      { name: 'Access Control', href: '/access', icon: ShieldCheck, superAdminOnly: true, roles: ['Instructor'] },
      { name: 'Instructor Tools', href: '/instructor-tools', icon: GraduationCap, permPage: null, roles: ['Instructor'] },
      // Not shown in sidebar but registered so breadcrumb resolves correctly
      { name: 'Program Planner', href: '/program-planner', icon: GraduationCap, permPage: null, roles: ['Instructor'], hiddenFromNav: true },
      { name: 'Program Cost',    href: '/program-cost',    icon: GraduationCap, permPage: null, roles: ['Instructor'], hiddenFromNav: true },
    ],
  },
]

function NavItem({ item, onClick, hasTempPerms }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.href}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150',
          isActive
            ? 'bg-brand-600 text-white shadow-sm'
            : 'text-surface-600 hover:bg-surface-100 hover:text-surface-900'
        )
      }
    >
      <div className="relative flex-shrink-0">
        <Icon size={18} />
        {hasTempPerms && (
          <span
            className="absolute -top-1 -right-1 w-2 h-2 rounded-full border border-white"
            style={{ background: '#7c3aed', animation: 'tempPermPulse 2s ease-in-out infinite' }}
            title="You have temporary permissions on this page"
          />
        )}
      </div>
      <span className="truncate">{item.name}</span>
    </NavLink>
  )
}

// ── Change Password Modal Component ──
function ChangePasswordModal({ open, onClose }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  // Reset form state when modal opens/closes
  useEffect(() => {
    if (open) {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setShowCurrent(false)
      setShowNew(false)
      setError('')
      setSuccess(false)
    }
  }, [open])

  const handleSubmit = async () => {
    setError('')

    if (!currentPassword.trim()) {
      setError('Please enter your current password.')
      return
    }
    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.')
      return
    }
    if (currentPassword === newPassword) {
      setError('New password must be different from current password.')
      return
    }

    setLoading(true)
    try {
      // Verify current password by attempting a sign-in with it
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) throw new Error('Unable to verify current user.')

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      })
      if (signInError) {
        setError('Current password is incorrect.')
        setLoading(false)
        return
      }

      // Update to new password
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      })
      if (updateError) throw updateError

      setSuccess(true)
      // Auto-close after showing success
      setTimeout(() => {
        onClose()
      }, 2000)
    } catch (err) {
      setError(err.message || 'Failed to update password.')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 2000, padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: 'white', borderRadius: 12, width: '100%', maxWidth: 420, overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: 20, borderBottom: '1px solid #e9ecef',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <h4 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={18} style={{ color: '#228be6' }} />
            Change Password
          </h4>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#868e96' }}
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20 }}>
          {success ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 56, height: 56, borderRadius: '50%', background: '#d3f9d8', marginBottom: 12,
              }}>
                <CheckCircle size={28} style={{ color: '#2f9e44' }} />
              </div>
              <p style={{ fontWeight: 600, fontSize: '1rem', color: '#212529', margin: '0 0 4px' }}>
                Password Updated!
              </p>
              <p style={{ color: '#868e96', fontSize: '0.85rem', margin: 0 }}>
                Your password has been changed successfully.
              </p>
            </div>
          ) : (
            <>
              <p style={{ color: '#495057', fontSize: '0.88rem', marginBottom: 16, marginTop: 0 }}>
                Enter your current password and choose a new one.
              </p>

              {/* Current Password */}
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, margin: '0 0 6px', color: '#495057' }}>
                Current Password <span style={{ color: '#fa5252' }}>*</span>
              </label>
              <div style={{ position: 'relative', marginBottom: 14 }}>
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  style={{
                    width: '100%', padding: '10px 40px 10px 12px', border: '1px solid #dee2e6',
                    borderRadius: 8, fontSize: '0.9rem', boxSizing: 'border-box',
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent(!showCurrent)}
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: '#868e96', padding: 4,
                  }}
                >
                  {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {/* New Password */}
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, margin: '0 0 6px', color: '#495057' }}>
                New Password <span style={{ color: '#fa5252' }}>*</span>
              </label>
              <div style={{ position: 'relative', marginBottom: 14 }}>
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password (min 6 chars)"
                  style={{
                    width: '100%', padding: '10px 40px 10px 12px', border: '1px solid #dee2e6',
                    borderRadius: 8, fontSize: '0.9rem', boxSizing: 'border-box',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowNew(!showNew)}
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: '#868e96', padding: 4,
                  }}
                >
                  {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {/* Confirm New Password */}
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, margin: '0 0 6px', color: '#495057' }}>
                Confirm New Password <span style={{ color: '#fa5252' }}>*</span>
              </label>
              <input
                type={showNew ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                style={{
                  width: '100%', padding: '10px 12px', border: '1px solid #dee2e6',
                  borderRadius: 8, fontSize: '0.9rem', boxSizing: 'border-box',
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />

              {/* Password strength hint */}
              {newPassword.length > 0 && newPassword.length < 6 && (
                <p style={{ color: '#fa5252', fontSize: '0.8rem', margin: '8px 0 0' }}>
                  Password must be at least 6 characters
                </p>
              )}
              {newPassword.length >= 6 && confirmPassword.length > 0 && newPassword !== confirmPassword && (
                <p style={{ color: '#fa5252', fontSize: '0.8rem', margin: '8px 0 0' }}>
                  Passwords do not match
                </p>
              )}

              {/* Error */}
              {error && (
                <div style={{
                  marginTop: 12, padding: '10px 14px', borderRadius: 8,
                  background: '#fff5f5', border: '1px solid #ffc9c9', color: '#c92a2a', fontSize: '0.85rem',
                }}>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!success && (
          <div style={{
            padding: '16px 20px', borderTop: '1px solid #e9ecef',
            display: 'flex', justifyContent: 'flex-end', gap: 12,
          }}>
            <button
              onClick={onClose}
              style={{
                background: '#f1f3f5', color: '#495057', border: 'none',
                borderRadius: 8, padding: '10px 20px', fontSize: '0.88rem', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading}
              style={{
                background: '#228be6', color: 'white', border: 'none',
                borderRadius: 8, padding: '10px 20px', fontSize: '0.88rem', fontWeight: 500,
                cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
                display: 'flex', alignItems: 'center', gap: 8,
                transition: 'background 0.2s',
              }}
            >
              {loading ? (
                <>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  Updating...
                </>
              ) : (
                'Update Password'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMP ACCESS REQUEST MODAL — Two-mode: Role or Specific Permissions
// ══════════════════════════════════════════════════════════════════════════════

function TempAccessModal({ profile, activeGrant, onClose, onSubmitted }) {
  const [mode, setMode] = useState('permissions') // 'role' or 'permissions'
  const [submitting, setSubmitting] = useState(false)

  // Role mode state
  const [roleForm, setRoleForm] = useState({ requested_role: 'Work Study', days_requested: 3, reason: '' })

  // Permissions mode state
  const [permForm, setPermForm] = useState({ days_requested: 3, reason: '' })
  const [allPermissions, setAllPermissions] = useState([])
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [selectedPerms, setSelectedPerms] = useState({})
  const [expandedPages, setExpandedPages] = useState({})
  const [permSearch, setPermSearch] = useState('')

  // Semester end date — for "Rest of Semester" duration option
  const [semesterEndDate, setSemesterEndDate] = useState(null)
  const [semesterDaysLeft, setSemesterDaysLeft] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function loadSemesterEnd() {
      try {
        const todayStr = new Date().toISOString().substring(0, 10)
        const { data } = await supabase
          .from('classes')
          .select('end_date')
          .eq('status', 'Active')
          .lte('start_date', todayStr)
          .gte('end_date', todayStr)
          .order('end_date', { ascending: false })
          .limit(1)
        if (cancelled || !data?.length || !data[0].end_date) return
        const endStr = data[0].end_date
        // Parse as local date (append T00:00:00 to avoid UTC shift)
        const end = new Date(endStr + 'T00:00:00')
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const diffDays = Math.round((end - today) / (1000 * 60 * 60 * 24))
        if (diffDays > 0) {
          setSemesterEndDate(end)
          setSemesterDaysLeft(diffDays)
        }
      } catch (e) {
        console.error('Failed to load semester end date:', e)
      }
    }
    loadSemesterEnd()
    return () => { cancelled = true }
  }, [])

  const userName = profile ? `${profile.first_name} ${profile.last_name}` : ''

  // Load all permissions and filter to only those the user's role doesn't already have
  useEffect(() => {
    if (mode !== 'permissions') return
    let cancelled = false

    async function loadPerms() {
      setPermissionsLoading(true)
      try {
        const { data, error } = await supabase
          .from('permissions')
          .select('*')
          .order('page')

        if (cancelled || error || !data) {
          setPermissionsLoading(false)
          return
        }

        const roleKey = (profile?.role || 'student').toLowerCase().replace(' ', '_')

        // Build set of permission_ids already covered by active temp grant
        const activePermIds = new Set(
          (activeGrant?.approved_permissions || []).map(p => p.permission_id)
        )

        // Filter to only permissions the user DOESN'T currently have (role or active temp grant)
        const upgradeable = data.filter(p => {
          const hasIt = p[roleKey] === true || p[roleKey] === 'true' || p[roleKey] === 'Yes'
          return !hasIt && !activePermIds.has(p.permission_id)
        })

        setAllPermissions(upgradeable)
      } catch (e) {
        console.error('Failed to load permissions:', e)
      }
      if (!cancelled) setPermissionsLoading(false)
    }

    loadPerms()
    return () => { cancelled = true }
  }, [mode, profile?.role])

  // Group permissions by page
  const groupedPerms = allPermissions.reduce((acc, p) => {
    if (!acc[p.page]) acc[p.page] = []
    acc[p.page].push(p)
    return acc
  }, {})

  // Filter by search
  const filteredPages = Object.entries(groupedPerms).filter(([page, perms]) => {
    if (!permSearch) return true
    const q = permSearch.toLowerCase()
    return page.toLowerCase().includes(q) ||
      perms.some(p => p.feature.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))
  })

  const togglePage = (page) => {
    setExpandedPages(prev => ({ ...prev, [page]: !prev[page] }))
  }

  const togglePerm = (permId) => {
    setSelectedPerms(prev => {
      const next = { ...prev }
      if (next[permId]) delete next[permId]; else next[permId] = true
      return next
    })
  }

  const selectAllInPage = (page) => {
    const perms = groupedPerms[page] || []
    const allSelected = perms.every(p => selectedPerms[p.permission_id])
    const next = { ...selectedPerms }
    perms.forEach(p => {
      if (allSelected) delete next[p.permission_id]
      else next[p.permission_id] = true
    })
    setSelectedPerms(next)
  }

  const selectedCount = Object.keys(selectedPerms).length

  // Submit handler
  const handleSubmit = async () => {
    if (mode === 'role') {
      if (!roleForm.reason.trim()) { alert('Please provide a reason.'); return }
    } else {
      if (selectedCount === 0) { alert('Please select at least one permission.'); return }
      if (!permForm.reason.trim()) { alert('Please provide a reason.'); return }
    }

    setSubmitting(true)
    try {
      // Generate request ID
      let requestId
      try {
        const { data } = await supabase.rpc('get_next_id', { p_type: mode === 'permissions' ? 'temp_permission' : 'temp_access' })
        requestId = data
      } catch {}
      if (!requestId) requestId = `${mode === 'permissions' ? 'TP' : 'TA'}${Date.now()}`

      if (mode === 'role') {
        // Standard role-based request (existing behavior)
        await supabase.from('temp_access_requests').insert([{
          request_id: requestId,
          user_email: profile.email,
          user_name: userName,
          user_current_role: profile.role,
          requested_role: roleForm.requested_role,
          days_requested: roleForm.days_requested,
          reason: roleForm.reason.trim(),
          status: 'Pending',
          submitted_date: new Date().toISOString(),
          request_type: 'role',
        }])
      } else {
        // Permission-based request (new!)
        const requestedPerms = allPermissions
          .filter(p => selectedPerms[p.permission_id])
          .map(p => ({
            permission_id: p.permission_id,
            page: p.page,
            feature: p.feature,
            description: p.description || '',
          }))

        await supabase.from('temp_access_requests').insert([{
          request_id: requestId,
          user_email: profile.email,
          user_name: userName,
          user_current_role: profile.role,
          requested_role: null,
          days_requested: permForm.days_requested,
          reason: permForm.reason.trim(),
          status: 'Pending',
          submitted_date: new Date().toISOString(),
          request_type: 'permissions',
          requested_permissions: requestedPerms,
        }])
      }

      onSubmitted()
    } catch (e) {
      alert('Error: ' + e.message)
    }
    setSubmitting(false)
  }

  const s = {
    overlay: {
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 2000, padding: 20,
    },
    modal: {
      background: 'white', borderRadius: 12, width: '100%',
      maxWidth: mode === 'permissions' ? 560 : 440,
      maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    },
    header: {
      padding: 20, borderBottom: '1px solid #e9ecef',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
    },
    body: { padding: 20, overflowY: 'auto', flex: 1 },
    footer: {
      padding: '16px 20px', borderTop: '1px solid #e9ecef',
      display: 'flex', justifyContent: 'flex-end', gap: 12, flexShrink: 0,
    },
    label: { display: 'block', fontSize: '0.85rem', fontWeight: 500, margin: '12px 0 6px', color: '#495057' },
    input: {
      width: '100%', padding: '10px 12px', border: '1px solid #dee2e6',
      borderRadius: 8, fontSize: '0.9rem', boxSizing: 'border-box',
    },
    tabBar: {
      display: 'flex', gap: 4, background: '#f1f3f5', borderRadius: 8, padding: 3, marginBottom: 16,
    },
    tab: (active) => ({
      flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none', fontSize: '0.82rem', fontWeight: 500,
      cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
      background: active ? 'white' : 'transparent',
      color: active ? '#228be6' : '#868e96',
      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
    }),
    btnCancel: {
      background: '#f1f3f5', color: '#495057', border: 'none',
      borderRadius: 8, padding: '10px 20px', fontSize: '0.88rem', cursor: 'pointer',
    },
    btnSubmit: (disabled) => ({
      background: '#228be6', color: 'white', border: 'none',
      borderRadius: 8, padding: '10px 20px', fontSize: '0.88rem', fontWeight: 500,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      transition: 'background 0.2s',
    }),
    pageHeader: (expanded) => ({
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 12px', background: expanded ? '#e7f5ff' : '#f8f9fa',
      border: expanded ? '1px solid #a5d8ff' : '1px solid #e9ecef',
      borderRadius: expanded ? '8px 8px 0 0' : 8,
      cursor: 'pointer', userSelect: 'none', transition: 'all 0.2s',
    }),
    permItem: (selected) => ({
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
      borderBottom: '1px solid #f1f3f5', cursor: 'pointer', transition: 'background 0.15s',
      background: selected ? '#e7f5ff' : 'white',
    }),
    checkbox: {
      width: 16, height: 16, borderRadius: 4, cursor: 'pointer', accentColor: '#228be6',
    },
  }

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        {/* Header */}
        <div style={s.header}>
          <h4 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <KeyRound size={18} style={{ color: '#fab005' }} />
            Request Temporary Access
          </h4>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#868e96' }}>
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={s.body}>
          <p style={{ color: '#495057', fontSize: '0.85rem', marginBottom: 12, marginTop: 0 }}>
            Request temporary elevated access. An instructor will review your request.
          </p>

          {/* Active grant notice */}
          {activeGrant && (
            <div style={{
              marginBottom: 14, padding: '10px 14px', borderRadius: 8,
              background: '#d3f9d8', border: '1px solid #8ce99a',
              fontSize: '0.8rem', color: '#2b8a3e', display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <span style={{ fontSize: '1rem', flexShrink: 0 }}>✅</span>
              <div>
                <strong>You have an active grant</strong> —{' '}
                {(activeGrant.approved_permissions || []).length} permission{(activeGrant.approved_permissions || []).length !== 1 ? 's' : ''} active
                until {activeGrant.expiry_date ? new Date(activeGrant.expiry_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}.
                {' '}You can request <em>additional</em> permissions below — already-active ones are excluded from the list.
              </div>
            </div>
          )}
          <div style={s.tabBar}>
            <button style={s.tab(mode === 'permissions')} onClick={() => setMode('permissions')}>
              🔑 Specific Permissions
            </button>
            <button style={s.tab(mode === 'role')} onClick={() => setMode('role')}>
              👤 Full Role Access
            </button>
          </div>

          {/* ── Role Mode ── */}
          {mode === 'role' && (
            <>
              <label style={s.label}>Requested Role</label>
              <select value={roleForm.requested_role} onChange={e => setRoleForm(f => ({ ...f, requested_role: e.target.value }))} style={s.input}>
                <option value="Work Study">Work Study</option>
                <option value="Instructor">Instructor</option>
              </select>

              <label style={s.label}>Duration</label>
              <select value={roleForm.days_requested} onChange={e => setRoleForm(f => ({ ...f, days_requested: parseInt(e.target.value) }))} style={s.input}>
                <option value={1}>1 day</option>
                <option value={2}>2 days</option>
                <option value={3}>3 days</option>
                <option value={5}>5 days</option>
                <option value={7}>1 week</option>
                {semesterDaysLeft && (
                  <option value={semesterDaysLeft}>
                    Rest of Semester ({semesterEndDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})
                  </option>
                )}
              </select>

              <label style={s.label}>Reason <span style={{ color: '#fa5252' }}>*</span></label>
              <textarea
                rows={3} placeholder="Why do you need temporary access?"
                value={roleForm.reason} onChange={e => setRoleForm(f => ({ ...f, reason: e.target.value }))}
                style={{ ...s.input, resize: 'vertical', fontFamily: 'inherit' }}
              />

              <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#fff9db', border: '1px solid #ffe066', fontSize: '0.8rem', color: '#664d03' }}>
                <strong>Note:</strong> This will temporarily change your role to the selected one, granting all associated permissions.
              </div>
            </>
          )}

          {/* ── Permissions Mode ── */}
          {mode === 'permissions' && (
            <>
              <label style={s.label}>Duration</label>
              <select value={permForm.days_requested} onChange={e => setPermForm(f => ({ ...f, days_requested: parseInt(e.target.value) }))} style={s.input}>
                <option value={1}>1 day</option>
                <option value={2}>2 days</option>
                <option value={3}>3 days</option>
                <option value={5}>5 days</option>
                <option value={7}>1 week</option>
                {semesterDaysLeft && (
                  <option value={semesterDaysLeft}>
                    Rest of Semester ({semesterEndDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})
                  </option>
                )}
              </select>

              <label style={s.label}>
                Select Permissions
                {selectedCount > 0 && (
                  <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 10, background: '#228be6', color: 'white', fontSize: '0.7rem', fontWeight: 600 }}>
                    {selectedCount} selected
                  </span>
                )}
              </label>

              {/* Search */}
              <div style={{ position: 'relative', marginBottom: 10 }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#adb5bd' }} />
                <input
                  type="text" placeholder="Search permissions..."
                  value={permSearch} onChange={e => setPermSearch(e.target.value)}
                  style={{ ...s.input, paddingLeft: 32, fontSize: '0.82rem' }}
                />
              </div>

              {/* Permission groups */}
              {permissionsLoading ? (
                <div style={{ textAlign: 'center', padding: 20, color: '#868e96' }}>
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginRight: 8 }} />
                  Loading permissions...
                </div>
              ) : filteredPages.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 20, color: '#868e96', fontSize: '0.85rem' }}>
                  {allPermissions.length === 0
                    ? activeGrant
                      ? 'Your active grant already covers all permissions your role doesn\'t have.'
                      : 'Your current role already has all available permissions.'
                    : 'No permissions match your search.'
                  }
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {filteredPages.map(([page, perms]) => {
                    const expanded = expandedPages[page]
                    const selectedInPage = perms.filter(p => selectedPerms[p.permission_id]).length
                    const allInPageSelected = selectedInPage === perms.length

                    return (
                      <div key={page}>
                        <div style={s.pageHeader(expanded)} onClick={() => togglePage(page)}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {expanded ? <ChevronUp size={14} style={{ color: '#228be6' }} /> : <ChevronDown size={14} style={{ color: '#868e96' }} />}
                            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#1a1a2e' }}>{page}</span>
                            <span style={{ fontSize: '0.72rem', color: '#868e96' }}>({perms.length})</span>
                            {selectedInPage > 0 && (
                              <span style={{
                                padding: '1px 6px', borderRadius: 8, fontSize: '0.65rem', fontWeight: 600,
                                background: allInPageSelected ? '#d3f9d8' : '#e7f5ff',
                                color: allInPageSelected ? '#2b8a3e' : '#1971c2',
                              }}>
                                {selectedInPage}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); selectAllInPage(page) }}
                            style={{
                              background: 'none', border: 'none', fontSize: '0.7rem', color: '#228be6',
                              cursor: 'pointer', padding: '2px 6px', fontWeight: 500,
                            }}
                          >
                            {allInPageSelected ? 'Deselect All' : 'Select All'}
                          </button>
                        </div>
                        {expanded && (
                          <div style={{ border: '1px solid #e9ecef', borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
                            {perms.map(p => {
                              const sel = !!selectedPerms[p.permission_id]
                              return (
                                <div key={p.permission_id} style={s.permItem(sel)} onClick={() => togglePerm(p.permission_id)}>
                                  <input type="checkbox" checked={sel} onChange={() => {}} style={s.checkbox} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#1a1a2e' }}>
                                      {p.feature.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    </div>
                                    {p.description && (
                                      <div style={{ fontSize: '0.72rem', color: '#868e96', marginTop: 1 }}>{p.description}</div>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <label style={{ ...s.label, marginTop: 16 }}>Reason <span style={{ color: '#fa5252' }}>*</span></label>
              <textarea
                rows={3} placeholder="Why do you need these permissions?"
                value={permForm.reason} onChange={e => setPermForm(f => ({ ...f, reason: e.target.value }))}
                style={{ ...s.input, resize: 'vertical', fontFamily: 'inherit' }}
              />

              <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#e7f5ff', border: '1px solid #a5d8ff', fontSize: '0.8rem', color: '#1971c2' }}>
                <strong>Tip:</strong> Request only what you need. Your role stays the same — only the selected permissions are temporarily added.
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <button onClick={onClose} style={s.btnCancel}>Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={submitting || (mode === 'permissions' && selectedCount === 0)}
            style={s.btnSubmit(submitting || (mode === 'permissions' && selectedCount === 0))}
          >
            {submitting ? 'Submitting...' : mode === 'permissions' ? `Submit (${selectedCount} permission${selectedCount !== 1 ? 's' : ''})` : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// HELP BUTTON — Student/Work Study "I Need Help" feature
// ══════════════════════════════════════════════════════════════════════════════

const HELP_LOCATIONS = ['1-316B', '1-350', '1-354', '1-356', '1-369']

function HelpButton({ profile }) {
  const [helpStatus, setHelpStatus] = useState('idle') // 'idle', 'picking', 'pending', 'acknowledged'
  const [helpRequest, setHelpRequest] = useState(null)
  const [helpLoading, setHelpLoading] = useState(false)
  const [helpTooltip, setHelpTooltip] = useState(null)
  const [showLocationPicker, setShowLocationPicker] = useState(false)
  // ── New: clock-in gate and lunch detection ──
  const [isClockedIn, setIsClockedIn] = useState(null)   // null=loading, true/false
  const [lunchHour, setLunchHour] = useState(null)        // integer hour (e.g. 12) or null
  // ── Meeting / Away mode ──
  const [instructorAway, setInstructorAway] = useState(false)
  const [awayReturnTime, setAwayReturnTime] = useState('')
  const timerRef = useRef(null)
  const pickerRef = useRef(null)

  const isInstructor = profile?.role === 'Instructor' || profile?.role === 'Super Admin'

  const userName = profile ? `${profile.first_name} ${profile.last_name}` : ''

  // ── Check if user is currently clocked in ──
  useEffect(() => {
    if (!profile?.email || isInstructor) return
    let cancelled = false
    async function checkClockIn() {
      try {
        const { data } = await supabase
          .from('time_clock')
          .select('record_id')
          .eq('user_email', profile.email)
          .is('punch_out', null)
          .limit(1)
        if (!cancelled) setIsClockedIn(!!(data && data.length > 0))
      } catch {
        if (!cancelled) setIsClockedIn(false)
      }
    }
    checkClockIn()
    // Re-check every 60 s so it updates if they clock in/out in another tab
    const interval = setInterval(checkClockIn, 60000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [profile?.email, isInstructor])

  // ── Load today's lab calendar to get lunch_hour ──
  useEffect(() => {
    if (!profile?.email || isInstructor) return
    let cancelled = false
    async function loadLunchHour() {
      try {
        const today = new Date().toISOString().substring(0, 10)
        const { data } = await supabase
          .from('lab_calendar')
          .select('lunch_hour')
          .eq('date', today)
          .limit(1)
        if (!cancelled && data && data.length > 0 && data[0].lunch_hour != null) {
          setLunchHour(parseInt(data[0].lunch_hour))
        }
      } catch {
        // No lunch_hour — that's fine
      }
    }
    loadLunchHour()
    return () => { cancelled = true }
  }, [profile?.email, isInstructor])

  // ── Load instructor away / meeting mode settings ──
  useEffect(() => {
    if (!profile?.email || isInstructor) return
    let cancelled = false
    async function loadAwayMode() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('setting_key, setting_value')
          .in('setting_key', ['instructor_away_mode', 'instructor_return_time'])
        if (cancelled) return
        const modeRow = (data || []).find(r => r.setting_key === 'instructor_away_mode')
        const timeRow = (data || []).find(r => r.setting_key === 'instructor_return_time')
        setInstructorAway(modeRow?.setting_value === 'true')
        setAwayReturnTime(timeRow?.setting_value || '')
      } catch {
        // Non-fatal
      }
    }
    loadAwayMode()
    return () => { cancelled = true }
  }, [profile?.email, isInstructor])

  // ── Realtime: stay in sync with instructor away mode changes ──
  useEffect(() => {
    if (!profile?.email || isInstructor) return
    const channel = supabase
      .channel('help-btn-away-' + profile.email)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_away_mode',
      }, (p) => {
        setInstructorAway(p.new?.setting_value === 'true')
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_return_time',
      }, (p) => {
        setAwayReturnTime(p.new?.setting_value || '')
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, isInstructor])

  // ── Close picker on outside click ──
  useEffect(() => {
    if (isInstructor) return // no-op for instructors, but hook still runs
    const handler = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setShowLocationPicker(false)
      }
    }
    if (showLocationPicker) {
      document.addEventListener('mousedown', handler)
    }
    return () => document.removeEventListener('mousedown', handler)
  }, [showLocationPicker, isInstructor])

  // ── Load current help request status ──
  const loadHelpStatus = useCallback(async () => {
    if (!profile?.email || isInstructor) return
    try {
      const { data } = await supabase
        .from('help_requests')
        .select('*')
        .eq('user_email', profile.email)
        .in('status', ['pending', 'acknowledged'])
        .order('requested_at', { ascending: false })
        .limit(1)

      if (data && data.length > 0) {
        const req = data[0]
        // Check if acknowledged request has expired
        if (req.status === 'acknowledged' && req.expires_at) {
          const expiresAt = new Date(req.expires_at)
          if (expiresAt <= new Date()) {
            // Auto-expire
            await supabase.from('help_requests')
              .update({ status: 'expired' })
              .eq('request_id', req.request_id)
            setHelpStatus('idle')
            setHelpRequest(null)
            return
          }
        }
        setHelpStatus(req.status)
        setHelpRequest(req)
      } else {
        setHelpStatus('idle')
        setHelpRequest(null)
      }
    } catch {
      setHelpStatus('idle')
      setHelpRequest(null)
    }
  }, [profile?.email, isInstructor])

  useEffect(() => {
    loadHelpStatus()
  }, [loadHelpStatus])

  // ── Realtime subscription ──
  useEffect(() => {
    if (!profile?.email || isInstructor) return
    const channel = supabase
      .channel('help-button-' + profile.email)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'help_requests' },
        () => { loadHelpStatus() }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, loadHelpStatus, isInstructor])

  // ── Auto-expire timer for acknowledged status ──
  useEffect(() => {
    if (isInstructor) return // no-op for instructors
    if (timerRef.current) clearTimeout(timerRef.current)
    if (helpStatus === 'acknowledged' && helpRequest?.expires_at) {
      const expiresAt = new Date(helpRequest.expires_at)
      const remaining = expiresAt.getTime() - Date.now()
      if (remaining > 0) {
        timerRef.current = setTimeout(async () => {
          try {
            await supabase.from('help_requests')
              .update({ status: 'expired' })
              .eq('request_id', helpRequest.request_id)
          } catch {}
          setHelpStatus('idle')
          setHelpRequest(null)
        }, remaining)
      }
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [helpStatus, helpRequest?.expires_at, helpRequest?.request_id, isInstructor])

  // ─── EARLY RETURN — safe now because all hooks are above ───────────
  // Don't render for instructors
  if (isInstructor) return null

  // ── Derived: is it currently the lunch hour? ──
  const isLunchTime = lunchHour !== null && new Date().getHours() === lunchHour

  // ── Determine if button should be disabled (not clocked in, still loading treated as disabled) ──
  const notClockedIn = isClockedIn === false

  // ── Request help with location ──
  const requestHelp = async (location) => {
    if (helpLoading) return
    setHelpLoading(true)
    setShowLocationPicker(false)
    try {
      const requestId = `HR${Date.now()}`
      const { error } = await supabase.from('help_requests').insert({
        request_id: requestId,
        user_id: profile?.user_id || profile?.id || null,
        user_name: userName,
        user_email: profile.email,
        location: location,
        status: 'pending',
        requested_at: new Date().toISOString(),
      })
      if (error) throw error
      setHelpStatus('pending')
      setHelpRequest({ request_id: requestId, status: 'pending', location })
      showHelpTooltip(`Help requested — ${location}`, 'success')
    } catch (e) {
      console.error('Help request error:', e)
      showHelpTooltip('Failed to request help', 'error')
    }
    setHelpLoading(false)
  }

  // ── Cancel help ──
  const cancelHelp = async () => {
    if (!helpRequest || helpLoading) return
    setHelpLoading(true)
    try {
      await supabase.from('help_requests')
        .update({ status: 'cancelled' })
        .eq('request_id', helpRequest.request_id)
      setHelpStatus('idle')
      setHelpRequest(null)
      showHelpTooltip('Help request cancelled', 'info')
    } catch (e) {
      console.error('Cancel help error:', e)
      showHelpTooltip('Failed to cancel', 'error')
    }
    setHelpLoading(false)
  }

  const showHelpTooltip = (msg, type) => {
    setHelpTooltip({ msg, type })
    setTimeout(() => setHelpTooltip(null), 2500)
  }

  // ── Click handler ──
  const handleClick = () => {
    // Gate: must be clocked in to request help
    if (notClockedIn) {
      showHelpTooltip('You must be clocked in to request help', 'error')
      return
    }
    if (helpStatus === 'idle') {
      setShowLocationPicker(true)
    } else {
      // Cancel if pending or acknowledged
      cancelHelp()
    }
  }

  // ── Determine icon style ──
  const getStyle = () => {
    if (notClockedIn) {
      return { color: '#9ca3af', bg: 'transparent', border: 'transparent', title: 'You must be clocked in to request help' }
    }
    if (helpStatus === 'acknowledged') {
      return { color: '#22c55e', bg: '#dcfce7', border: '#22c55e', title: 'Instructor acknowledged — click to clear' }
    }
    if (helpStatus === 'pending') {
      const loc = helpRequest?.location ? ` (${helpRequest.location})` : ''
      return { color: '#ef4444', bg: '#fef2f2', border: '#ef4444', title: `Help requested${loc} — click to cancel` }
    }
    return { color: '#6b7280', bg: 'transparent', border: 'transparent', title: 'Need help? Click to notify instructor' }
  }

  const style = getStyle()

  return (
    <div style={{ position: 'relative' }} ref={pickerRef}>
      <button
        onClick={handleClick}
        disabled={helpLoading || isClockedIn === null}
        className="p-2 rounded-lg transition-all duration-200"
        style={{
          background: style.bg,
          border: `2px solid ${style.border}`,
          color: style.color,
          cursor: (helpLoading || notClockedIn || isClockedIn === null) ? 'not-allowed' : 'pointer',
          animation: helpStatus === 'pending' ? 'helpPulse 1.5s ease-in-out infinite' : 'none',
          opacity: (helpLoading || notClockedIn) ? 0.45 : 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
        title={style.title}
      >
        {helpStatus === 'pending' || helpStatus === 'acknowledged' ? (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <HelpCircle size={20} />
            {helpStatus === 'pending' && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                width: 10, height: 10, borderRadius: '50%',
                background: '#ef4444', border: '2px solid white',
              }} />
            )}
            {helpStatus === 'acknowledged' && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                width: 10, height: 10, borderRadius: '50%',
                background: '#22c55e', border: '2px solid white',
              }} />
            )}
          </div>
        ) : (
          <HelpCircle size={20} />
        )}
      </button>

      {/* Location Picker Dropdown */}
      {showLocationPicker && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8,
          background: 'white', borderRadius: 12, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)', zIndex: 5000,
          minWidth: 220, animation: 'helpTooltipIn 0.15s ease',
          border: '1px solid #e5e7eb',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #f3f4f6',
            fontSize: '0.82rem', fontWeight: 600, color: '#374151',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <HelpCircle size={16} style={{ color: '#ef4444' }} />
            Where are you?
          </div>

          {/* Lunch notice banner — shown only during the designated lunch hour */}
          {isLunchTime && (
            <div style={{
              padding: '10px 14px',
              background: '#fffbeb',
              borderBottom: '1px solid #fde68a',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <span style={{ fontSize: '1rem', lineHeight: 1.3 }}>🍽️</span>
              <div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#92400e', marginBottom: 2 }}>
                  Instructors are on lunch break
                </div>
                <div style={{ fontSize: '0.74rem', color: '#b45309', lineHeight: 1.4 }}>
                  Your request will be seen and responded to after lunch.
                </div>
              </div>
            </div>
          )}

          {/* Meeting / Away notice banner — shown when instructor has enabled away mode */}
          {instructorAway && (
            <div style={{
              padding: '10px 14px',
              background: '#fef2f2',
              borderBottom: '1px solid #fecaca',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <span style={{ fontSize: '1rem', lineHeight: 1.3 }}>🏢</span>
              <div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#991b1b', marginBottom: 2 }}>
                  Instructors are in a meeting
                </div>
                <div style={{ fontSize: '0.74rem', color: '#b91c1c', lineHeight: 1.4 }}>
                  {awayReturnTime
                    ? `They will be back around ${awayReturnTime}. Your request will be seen as soon as they return.`
                    : 'Your request will be seen and responded to as soon as they are back.'}
                </div>
              </div>
            </div>
          )}

          {HELP_LOCATIONS.map(loc => (
            <button
              key={loc}
              onClick={() => requestHelp(loc)}
              style={{
                display: 'block', width: '100%', padding: '12px 16px',
                border: 'none', background: 'white', textAlign: 'left',
                fontSize: '0.9rem', color: '#1f2937', cursor: 'pointer',
                borderBottom: '1px solid #f9fafb',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.target.style.background = '#fef2f2'}
              onMouseLeave={e => e.target.style.background = 'white'}
            >
              <span style={{ fontWeight: 600 }}>Room {loc}</span>
            </button>
          ))}
        </div>
      )}

      {/* Tooltip */}
      {helpTooltip && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8,
          padding: '8px 14px', borderRadius: 8, fontSize: '0.8rem',
          color: 'white', whiteSpace: 'nowrap', zIndex: 5000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          background: helpTooltip.type === 'success' ? '#22c55e' :
            helpTooltip.type === 'error' ? '#ef4444' : '#3b82f6',
          animation: 'helpTooltipIn 0.2s ease',
        }}>
          {helpTooltip.msg}
        </div>
      )}

      <style>{`
        @keyframes helpPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
        }
        @keyframes helpTooltipIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}


// ── Lab Locked Screen ─────────────────────────────────────────────────────────
// Shown instead of the full app when lab_access_mode = 'summer_break'
// and the user's role is Student or Work Study.
function LabLockedScreen({ profile, signOut }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1e3a5f 0%, #1a2e4a 50%, #0f1f33 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        textAlign: 'center',
      }}
    >
      {/* Icon */}
      <div style={{
        width: 88, height: 88, borderRadius: '50%',
        background: 'rgba(255,255,255,0.08)',
        border: '2px solid rgba(255,255,255,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 28,
      }}>
        <MoonStar size={40} style={{ color: '#93c5fd' }} />
      </div>

      {/* Heading */}
      <h1 style={{
        color: '#ffffff',
        fontSize: '1.6rem',
        fontWeight: 700,
        margin: '0 0 12px',
        letterSpacing: '-0.02em',
      }}>
        The RICT Lab is Closed
      </h1>

      {/* Subheading */}
      <p style={{
        color: '#93c5fd',
        fontSize: '1.05rem',
        fontWeight: 500,
        margin: '0 0 8px',
      }}>
        Semester Break — Student Access Suspended
      </p>

      {/* Detail */}
      <p style={{
        color: 'rgba(255,255,255,0.55)',
        fontSize: '0.9rem',
        maxWidth: 420,
        lineHeight: 1.6,
        margin: '0 0 40px',
      }}>
        The RICT CMMS is not available to students during the semester break.
        Access will be restored when the new semester begins.
        Please contact your instructor if you have questions.
      </p>

      {/* User badge */}
      {profile && (
        <div style={{
          background: 'rgba(255,255,255,0.07)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 12,
          padding: '14px 24px',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'rgba(147, 197, 253, 0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#93c5fd', fontWeight: 700, fontSize: '0.85rem',
          }}>
            {(profile.first_name || '?').charAt(0)}{(profile.last_name || '').charAt(0)}
          </div>
          <div style={{ textAlign: 'left' }}>
            <p style={{ color: '#ffffff', fontSize: '0.88rem', fontWeight: 600, margin: 0 }}>
              {profile.first_name} {profile.last_name}
            </p>
            <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.78rem', margin: 0 }}>
              {profile.role}
            </p>
          </div>
        </div>
      )}

      {/* Sign out */}
      <button
        onClick={signOut}
        style={{
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.2)',
          color: '#ffffff',
          borderRadius: 10,
          padding: '10px 28px',
          fontSize: '0.88rem',
          fontWeight: 500,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
        onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.17)'}
        onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
      >
        <LogOut size={15} /> Sign Out
      </button>
    </div>
  )
}

export default function AppLayout() {
  const { profile, signOut, labLocked } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  const userRole = profile?.role || 'Student'
  const isSuperAdmin = profile?.email?.toLowerCase() === SUPER_ADMIN_EMAIL
  // Keep isInstructor for backward-compatible sections (temp access, etc.)
  const isInstructor = userRole === 'Instructor' || isSuperAdmin

  // ── Lab Access Mode lockout ──────────────────────────────────────────
  // Render the lockout screen before any other checks.
  // Instructors and Super Admins always bypass this.
  if (labLocked && !isInstructor) {
    return <LabLockedScreen profile={profile} signOut={signOut} />
  }

  // ── Change Password Modal State ──
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)

  // ── Instructor Away Mode (banner for students / work study) ──
  const [instructorAway, setInstructorAway] = useState(false)
  const [awayReturnTime, setAwayReturnTime] = useState('')

  useEffect(() => {
    if (isInstructor) return
    let cancelled = false
    async function loadAwayMode() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('setting_key, setting_value')
          .in('setting_key', ['instructor_away_mode', 'instructor_return_time'])
        if (!cancelled && data) {
          const modeRow = data.find(r => r.setting_key === 'instructor_away_mode')
          const timeRow = data.find(r => r.setting_key === 'instructor_return_time')
          setInstructorAway(modeRow?.setting_value === 'true')
          setAwayReturnTime(timeRow?.setting_value || '')
        }
      } catch { /* ignore */ }
    }
    loadAwayMode()

    const channel = supabase
      .channel('layout-away-mode')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_away_mode',
      }, (p) => { if (!cancelled) setInstructorAway(p.new?.setting_value === 'true') })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_return_time',
      }, (p) => { if (!cancelled) setAwayReturnTime(p.new?.setting_value || '') })
      .subscribe()

    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [isInstructor])

  // ── Load view_page permissions from DB for sidebar filtering ──
  const [viewPerms, setViewPerms] = useState({})

  useEffect(() => {
    if (!profile?.role) return
    let cancelled = false

    async function loadViewPerms() {
      try {
        const { data, error } = await supabase
          .from('permissions')
          .select('page, student, work_study, instructor')
          .eq('feature', 'view_page')
        if (cancelled || error || !data) return
        const roleKey = profile.role.toLowerCase().replace(' ', '_')
        const map = {}
        data.forEach(p => {
          map[p.page] = p[roleKey] === true
        })
        setViewPerms(map)
      } catch (e) {
        console.error('Sidebar permission load error:', e)
      }
    }

    loadViewPerms()
    return () => { cancelled = true }
  }, [profile?.role])

  // ── Temp Permission Pages (sidebar indicators) ──
  // tempPermPages = pages with ANY active temp permission (for purple dot)
  // tempViewPages = pages with temp view_page grant (for sidebar visibility)
  const [tempPermPages, setTempPermPages] = useState(new Set())
  const [tempViewPages, setTempViewPages] = useState(new Set())

  const loadTempPermPages = useCallback(async () => {
    if (isInstructor || isSuperAdmin || !profile?.email) {
      setTempPermPages(new Set())
      setTempViewPages(new Set())
      return
    }
    try {
      const { data } = await supabase
        .from('temp_access_requests')
        .select('approved_permissions, expiry_date')
        .eq('user_email', profile.email)
        .eq('status', 'Active')
        .eq('request_type', 'permissions')

      const now = new Date()
      const pages = new Set()
      const viewPages = new Set()
      ;(data || []).forEach(grant => {
        if (grant.expiry_date && new Date(grant.expiry_date) < now) return
        ;(grant.approved_permissions || []).forEach(p => {
          if (p.page) {
            pages.add(p.page)
            if (p.feature === 'view_page') viewPages.add(p.page)
          }
        })
      })
      setTempPermPages(pages)
      setTempViewPages(viewPages)
    } catch {
      setTempPermPages(new Set())
      setTempViewPages(new Set())
    }
  }, [isInstructor, isSuperAdmin, profile?.email])

  useEffect(() => {
    loadTempPermPages()
  }, [loadTempPermPages])

  /**
   * Check if a nav item should be visible.
   * Priority: superAdminOnly → temp view_page grant → DB view_page perm → fallback to roles array
   */
  const canSeeItem = useCallback((item) => {
    if (isSuperAdmin) return true
    if (item.superAdminOnly) return false
    // If temp permission grants view_page for this page, show it
    if (item.permPage && tempViewPages.has(item.permPage)) return true
    // If DB permission is loaded for this page, use it
    if (item.permPage && viewPerms[item.permPage] !== undefined) {
      return viewPerms[item.permPage] === true
    }
    // Fallback to hardcoded roles array (for pages without DB permissions yet)
    return item.roles.includes(userRole)
  }, [isSuperAdmin, viewPerms, userRole, tempViewPages])

  // ── Auto-Expiry Cleanup (instructors only) ──
  // Checks for expired temp access grants and marks them as Expired,
  // reverting role-type grants back to original role.
  const runExpiryCleanup = useCallback(async () => {
    if (!isInstructor || !profile?.email) return
    try {
      const { data: expired } = await supabase
        .from('temp_access_requests')
        .select('*')
        .eq('status', 'Active')
        .lt('expiry_date', new Date().toISOString())

      if (!expired || expired.length === 0) return

      console.log(`[Auto-Expiry] Found ${expired.length} expired grant(s), cleaning up...`)

      for (const grant of expired) {
        // Mark as Expired
        await supabase.from('temp_access_requests')
          .update({
            status: 'Expired',
            reverted_date: new Date().toISOString(),
            reviewed_by: 'System (auto-expiry)',
          })
          .eq('request_id', grant.request_id)

        // For role-type grants, revert the user's role
        if (grant.request_type !== 'permissions' && grant.user_email) {
          const originalRole = grant.user_original_role || grant.user_current_role
          if (originalRole) {
            await supabase.from('profiles')
              .update({ role: originalRole })
              .eq('email', grant.user_email)
            console.log(`[Auto-Expiry] Reverted ${grant.user_name} from ${grant.approved_role} → ${originalRole}`)
          }
        } else {
          console.log(`[Auto-Expiry] Expired ${(grant.approved_permissions || []).length} permission(s) for ${grant.user_name}`)
        }

        // Audit log
        try {
          await supabase.from('audit_log').insert({
            user_email: 'system@rict.edu',
            user_name: 'System (Auto-Expiry)',
            action: 'Auto-Expire Temp Access',
            entity_type: 'Temp Access',
            entity_id: grant.request_id,
            details: grant.request_type === 'permissions'
              ? `Expired ${(grant.approved_permissions || []).length} temp permission(s) for ${grant.user_name}`
              : `Expired temp role access for ${grant.user_name} — reverted from ${grant.approved_role} to ${grant.user_original_role || grant.user_current_role}`,
          })
        } catch {}
      }
    } catch (e) {
      console.warn('[Auto-Expiry] Cleanup error:', e.message)
    }
  }, [isInstructor, profile?.email])

  // Run expiry cleanup on mount and every 5 minutes
  useEffect(() => {
    if (!isInstructor) return
    runExpiryCleanup()
    const interval = setInterval(runExpiryCleanup, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [runExpiryCleanup, isInstructor])

  // Find current page name from all sections
  const allItems = navSections.flatMap(s => s.items)
  const currentPage = allItems.find(item => location.pathname.startsWith(item.href))?.name || 'Dashboard'

  // ── App Version ──
  const [appVersion, setAppVersion] = useState('')

  const fetchVersion = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'app_version')
        .maybeSingle()
      if (!error && data) {
        setAppVersion(data.setting_value)
      }
    } catch (err) {
      console.error('Failed to fetch app version:', err)
    }
  }, [])

  // Fetch version on mount
  useEffect(() => {
    fetchVersion()
  }, [fetchVersion])

  // Listen for the custom event dispatched by addChangelogEntry in useBugTracker
  useEffect(() => {
    const handleVersionUpdate = (e) => {
      if (e.detail?.version) {
        setAppVersion(e.detail.version)
      }
    }
    window.addEventListener('app-version-updated', handleVersionUpdate)
    return () => window.removeEventListener('app-version-updated', handleVersionUpdate)
  }, [])

  // Also subscribe to realtime settings changes (covers manual edits on Settings page)
  useEffect(() => {
    const channel = supabase
      .channel('app-version-watch')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'settings',
          filter: 'setting_key=eq.app_version'
        },
        (payload) => {
          if (payload.new?.setting_value) {
            setAppVersion(payload.new.setting_value)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── Temp Access Request State (non-instructors) ──
  const [tempRequestOpen, setTempRequestOpen] = useState(false)
  const [tempRequestStatus, setTempRequestStatus] = useState(null) // null, 'pending', 'active'
  const [tempRequestData, setTempRequestData] = useState(null)
  const [tempToast, setTempToast] = useState(null)

  const showTempToast = (msg, type = 'info') => {
    setTempToast({ msg, type })
    setTimeout(() => setTempToast(null), 3500)
  }

  const fmtDate = (d) => {
    if (!d) return '—'
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // ── Load temp access status (non-instructors) ──
  const loadTempAccessStatus = useCallback(async () => {
    if (isInstructor || !profile?.email) return
    try {
      const { data } = await supabase
        .from('temp_access_requests')
        .select('*')
        .eq('user_email', profile.email)
        .in('status', ['Pending', 'Active'])
        .order('submitted_date', { ascending: false })
        .limit(1)
      if (data && data.length > 0) {
        setTempRequestStatus(data[0].status.toLowerCase())
        setTempRequestData(data[0])
      } else {
        setTempRequestStatus(null)
        setTempRequestData(null)
      }
    } catch { setTempRequestStatus(null) }
  }, [isInstructor, profile?.email])

  useEffect(() => {
    loadTempAccessStatus()
  }, [loadTempAccessStatus])

  // Realtime: refresh temp access status when requests change
  useEffect(() => {
    if (isInstructor || !profile?.email) return
    const channel = supabase
      .channel('sidebar-temp-access')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'temp_access_requests' },
        () => { loadTempAccessStatus(); loadTempPermPages() }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          if (payload.new?.email === profile?.email) {
            loadTempAccessStatus()
          }
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadTempAccessStatus, loadTempPermPages, isInstructor, profile?.email])

  // Polling fallback: if realtime doesn't fire (table not in publication), poll every 15s
  // Only polls when user has a pending request or active grant, otherwise stops
  useEffect(() => {
    if (isInstructor || !profile?.email) return
    const poll = setInterval(() => {
      loadTempAccessStatus()
      loadTempPermPages()
    }, 15000)
    return () => clearInterval(poll)
  }, [loadTempAccessStatus, loadTempPermPages, isInstructor, profile?.email])

  // ── Determine key icon appearance based on status ──
  const getKeyIconStyle = () => {
    if (tempRequestStatus === 'active') {
      const isPermType = tempRequestData?.request_type === 'permissions'
      const permCount = (tempRequestData?.approved_permissions || []).length
      const detail = isPermType
        ? `Active: ${permCount} temp permission${permCount !== 1 ? 's' : ''} until ${fmtDate(tempRequestData?.expiry_date)}`
        : `Active: ${tempRequestData?.approved_role} access until ${fmtDate(tempRequestData?.expiry_date)}`
      return { color: '#40c057', title: detail }
    }
    if (tempRequestStatus === 'pending') {
      return { color: '#fab005', title: 'Temp access request pending approval' }
    }
    return { color: '#868e96', title: 'Request temporary access' }
  }

  const keyStyle = getKeyIconStyle()

  return (
    <div className="flex h-screen bg-surface-50">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-surface-900/30 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-surface-200 flex flex-col',
          'transform transition-transform duration-200 ease-out lg:relative lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo area */}
        <div className="flex items-center gap-3 px-5 h-16 border-b border-surface-100">
          <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
            <Wrench size={16} className="text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-surface-900 tracking-tight">RICT CMMS</h1>
              {appVersion && (
                <span className="text-[10px] font-medium text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded-full leading-none">
                  v{appVersion}
                </span>
              )}
            </div>
            <p className="text-[10px] text-surface-400 uppercase tracking-wider">Maintenance System</p>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation with sections */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navSections.map((section, sIdx) => {
            // Filter items by role
            const visibleItems = section.items.filter(item => !item.hiddenFromNav && canSeeItem(item))
            if (visibleItems.length === 0) return null

            return (
              <div key={sIdx} className={sIdx > 0 ? 'mt-6' : ''}>
                {section.title && (
                  <p className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-400">
                    {section.title}
                  </p>
                )}
                <div className="space-y-1">
                  {visibleItems.map(item => (
                    <NavItem
                      key={item.href}
                      item={item}
                      onClick={() => setSidebarOpen(false)}
                      hasTempPerms={item.permPage ? tempPermPages.has(item.permPage) : false}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </nav>

        {/* User section */}
        <div className="border-t border-surface-100 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-xs font-bold">
              {(profile?.first_name || '?').charAt(0)}
              {(profile?.last_name || '').charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-surface-900 truncate">
                {profile?.first_name} {profile?.last_name}
              </p>
              <p className="text-xs text-surface-500 truncate">{profile?.role}</p>
            </div>
            {/* Settings Gear - Change Password */}
            <button
              onClick={() => setChangePasswordOpen(true)}
              className="p-1.5 rounded-lg text-surface-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
              title="Account settings"
            >
              <Settings size={16} />
            </button>
            {/* Temp Access Key Icon (non-instructors only) */}
            {!isInstructor && (
              <button
                onClick={() => {
                  if (tempRequestStatus === 'pending') {
                    // Already has a pending review — just show status toast
                    showTempToast(keyStyle.title, 'info')
                  } else {
                    // Open modal whether active or idle — students can always request additional permissions
                    setTempRequestOpen(true)
                  }
                }}
                className="relative p-1.5 rounded-lg transition-colors hover:bg-surface-100"
                title={keyStyle.title}
                style={{ color: keyStyle.color }}
              >
                <KeyRound size={16} />
                {/* Status dot indicator */}
                {tempRequestStatus === 'pending' && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-white" />
                )}
                {tempRequestStatus === 'active' && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-white" />
                )}
              </button>
            )}
            <button
              onClick={signOut}
              className="p-1.5 rounded-lg text-surface-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-16 bg-white border-b border-surface-200 flex items-center gap-4 px-4 lg:px-6">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg text-surface-500 hover:bg-surface-100 lg:hidden"
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-surface-400 hidden sm:inline">RICT CMMS</span>
            <ChevronRight size={14} className="text-surface-300 hidden sm:inline" />
            <span className="font-semibold text-surface-900">{currentPage}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <HelpButton profile={profile} />
            {/* Program Plan icon — students only */}
            {!isInstructor && (
              <button
                onClick={() => navigate('/program-planner')}
                className="p-1.5 rounded-lg text-surface-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                title="View my program plan"
              >
                <GraduationCap size={18} />
              </button>
            )}
            <NotificationBell />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {/* Instructor Away Banner — visible to students/work study on every page */}
          {!isInstructor && instructorAway && (
            <div
              role="alert"
              aria-live="polite"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                background: '#fef2f2', border: '1px solid #fecaca', borderLeft: '4px solid #dc2626',
                borderRadius: 12, padding: '14px 18px', marginBottom: 16,
              }}
            >
              <span style={{ fontSize: '1.3rem', flexShrink: 0, marginTop: 1 }} aria-hidden="true">🏢</span>
              <div>
                <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#991b1b', marginBottom: 2 }}>
                  Instructors are in a meeting
                </div>
                <div style={{ fontSize: '0.82rem', color: '#b91c1c', lineHeight: 1.45 }}>
                  {awayReturnTime
                    ? `They will be back around ${awayReturnTime}. Your request will be seen as soon as they return.`
                    : 'Your request will be seen and responded to as soon as they are back.'}
                </div>
              </div>
            </div>
          )}
          {/* Student Hold — Nudge-tier banners (non-blocking, dismissible) */}
          <HoldNudgeBanner />
          <Outlet />
        </main>
      </div>

      {/* ── Toast (for temp access feedback) ── */}
      {tempToast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, padding: '12px 20px', borderRadius: 8,
          color: 'white', zIndex: 5000, fontSize: '0.9rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          animation: 'tempToastIn 0.3s ease',
          background: tempToast.type === 'success' ? '#40c057' : tempToast.type === 'error' ? '#fa5252' : '#228be6'
        }}>
          {tempToast.msg}
        </div>
      )}

      {/* ── Change Password Modal ── */}
      <ChangePasswordModal
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
      />

      {/* ── Temp Access Request Modal (non-instructors) — now with two modes ── */}
      {tempRequestOpen && (
        <TempAccessModal
          profile={profile}
          activeGrant={tempRequestStatus === 'active' ? tempRequestData : null}
          onClose={() => setTempRequestOpen(false)}
          onSubmitted={() => {
            showTempToast('Temp access request submitted!', 'success')
            setTempRequestOpen(false)
            loadTempAccessStatus()
          }}
        />
      )}

      {/* ── Student Hold Overlays ─────────────────────────────────────────── */}
      {/* Always mounted. Each self-renders null when no holds of its tier apply. */}
      {/* Reminder defers internally when a lockout is active, so both can safely */}
      {/* live in the tree simultaneously without visual conflict. z-index order: */}
      {/* Lockout 9000 > Reminder 8500 > temp toast 5000 > ChangePassword 2000.  */}
      <HoldReminderModal />
      <HoldLockoutModal />

      <style>{`
        @keyframes tempToastIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes tempPermPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
    </div>
  )
}
