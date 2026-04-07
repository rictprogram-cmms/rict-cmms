import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import { useAllUsers, useUserActions, useAccessRequests, useMessageTemplates } from '@/hooks/useUsers'
import {
  Users, Search, Filter, Edit3, CreditCard, Mail, CheckCircle2,
  XCircle, Shield, ChevronDown, UserPlus, Send, X, Loader2,
  AlertCircle, Clock, UserCheck, UserX, Eye, EyeOff, Save, Archive,
  Trash2, AlertTriangle, UserMinus, Wifi, KeyRound, Copy, Check,
  RefreshCcw
} from 'lucide-react'
import toast from 'react-hot-toast'
import RejectionModal from '@/components/RejectionModal'
import { useRejectionNotification } from '@/hooks/useRejectionNotification'

const ROLES = ['Instructor', 'Work Study', 'Student']
const STATUSES = ['Active', 'Inactive', 'Archived']

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Format a timestamp as relative "last active" text
// ═══════════════════════════════════════════════════════════════════════════════

function formatLastActive(timestamp) {
  if (!timestamp) return null
  try {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return null
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffDays === 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays}d ago`
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' })
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Format presence duration "active for Xm" from a joined_at ISO string
// ═══════════════════════════════════════════════════════════════════════════════

function formatActiveDuration(joinedAt) {
  if (!joinedAt) return ''
  try {
    const diffMs = Date.now() - new Date(joinedAt).getTime()
    const mins = Math.floor(diffMs / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    const rem = mins % 60
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
  } catch { return '' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function UsersPage() {
  const { profile, onlineUsers, presenceMeta, isSuperAdmin } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Users')
  const { users, loading, refresh } = useAllUsers()
  const actions = useUserActions()
  const { requests, loading: reqLoading, refresh: refreshReqs } = useAccessRequests()
  const { templates, refresh: refreshTemplates } = useMessageTemplates()

  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('Active')
  const [badgeFilter, setBadgeFilter] = useState('')
  const [onlineFilter, setOnlineFilter] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState({})
  const [editingUser, setEditingUser] = useState(null)
  const [showCompose, setShowCompose] = useState(false)
  const [tab, setTab] = useState('users')
  const [archiveConfirm, setArchiveConfirm] = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [resetConfirm, setResetConfirm] = useState(null)
  const [showAddUser, setShowAddUser] = useState(false)

  // Auto-refresh when users are updated (e.g. approved via NotificationBell)
  useEffect(() => {
    const handler = () => { refresh(); refreshReqs(); }
    window.addEventListener('users-updated', handler)
    return () => window.removeEventListener('users-updated', handler)
  }, [refresh, refreshReqs])

  const filtered = useMemo(() => {
    return users.filter(u => {
      const s = search.toLowerCase()
      const matchSearch = !s || (u.first_name || '').toLowerCase().includes(s) || (u.last_name || '').toLowerCase().includes(s) || (u.email || '').toLowerCase().includes(s)
      const matchRole = !roleFilter || u.role === roleFilter
      const matchStatus = !statusFilter || u.status === statusFilter
      const hasBadge = !!(u.card_id && String(u.card_id).trim())
      const matchBadge = !badgeFilter || (badgeFilter === 'missing' && !hasBadge) || (badgeFilter === 'assigned' && hasBadge)
      const matchOnline = !onlineFilter || onlineUsers.has(u.email?.toLowerCase())
      return matchSearch && matchRole && matchStatus && matchBadge && matchOnline
    })
  }, [users, search, roleFilter, statusFilter, badgeFilter, onlineFilter, onlineUsers])

  const selectedCount = Object.keys(selectedUsers).length

  const toggleSelect = (id) => setSelectedUsers(prev => {
    const next = { ...prev }
    if (next[id]) delete next[id]; else next[id] = true
    return next
  })
  const toggleAll = (checked) => {
    if (checked) {
      const map = {}
      filtered.forEach(u => { map[u.id] = true })
      setSelectedUsers(map)
    } else {
      setSelectedUsers({})
    }
  }
  const selectByRole = (role) => {
    const map = { ...selectedUsers }
    users.forEach(u => { if (u.role === role && u.status === 'Active') map[u.id] = true })
    setSelectedUsers(map)
  }

  // Extract unique classes
  const allClasses = useMemo(() => {
    const set = new Set()
    users.forEach(u => {
      if (u.classes) u.classes.split(',').forEach(c => { if (c.trim()) set.add(c.trim()) })
    })
    return [...set].sort()
  }, [users])

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
        <Users size={40} className="mx-auto mb-3 text-surface-300" />
        <p className="text-surface-500 text-sm">You do not have permission to access User Management.</p>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
          <Users size={20} className="text-brand-600" /> User Management
        </h1>
        <div className="flex items-center gap-2">
          {/* Add User button — visible on Users tab for instructors with edit_users */}
          {hasPerm('edit_users') && tab === 'users' && (
            <button
              onClick={() => setShowAddUser(true)}
              className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 flex items-center gap-1.5 transition-colors"
            >
              <UserPlus size={14} /> Add User
            </button>
          )}
          {requests.length > 0 && (
            <button onClick={() => setTab(tab === 'requests' ? 'users' : 'requests')}
              className="px-3 py-1.5 rounded-lg bg-yellow-100 text-yellow-800 text-xs font-medium flex items-center gap-1.5">
              <AlertCircle size={14} /> {requests.length} Pending Request{requests.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>

      {/* Tab Toggle */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1" role="tablist" aria-label="User management sections">
        <button onClick={() => setTab('users')} role="tab" aria-selected={tab === 'users'} aria-controls="panel-users" id="tab-users"
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'users' ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500'}`}>
          <Users size={14} className="inline mr-1" /> Users ({users.length})
        </button>
        <button onClick={() => setTab('requests')} role="tab" aria-selected={tab === 'requests'} aria-controls="panel-requests" id="tab-requests"
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'requests' ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500'}`}>
          <UserPlus size={14} className="inline mr-1" /> Requests ({requests.length})
        </button>
      </div>

      {tab === 'requests' ? (
        <div role="tabpanel" id="panel-requests" aria-labelledby="tab-requests">
          <AccessRequestsPanel requests={requests} loading={reqLoading} onRefresh={() => { refreshReqs(); refresh() }} />
        </div>
      ) : (
        <div role="tabpanel" id="panel-users" aria-labelledby="tab-users">
          {/* Filters */}
          <div className="flex flex-wrap gap-2 mb-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search users..." className="input pl-9 text-sm" aria-label="Search users" />
            </div>
            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="input text-sm w-auto" aria-label="Filter by role">
              <option value="">All Roles</option>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input text-sm w-auto" aria-label="Filter by status">
              <option value="">All Status</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={badgeFilter} onChange={e => setBadgeFilter(e.target.value)} className="input text-sm w-auto" aria-label="Filter by badge">
              <option value="">All Badges</option>
              <option value="assigned">Has Badge</option>
              <option value="missing">No Badge</option>
            </select>
            {/* Online Only toggle chip */}
            <button
              onClick={() => setOnlineFilter(f => !f)}
              title="Show only currently online users"
              aria-pressed={onlineFilter}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                onlineFilter
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                  : 'bg-white border-surface-200 text-surface-500 hover:border-emerald-300 hover:text-emerald-600'
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${onlineFilter ? 'bg-emerald-500' : 'bg-surface-300'}`} aria-hidden="true" />
              Online Only
              {onlineFilter && (
                <span className="ml-0.5 bg-emerald-100 text-emerald-700 rounded-full px-1.5 py-0 text-[10px] font-semibold">
                  {onlineUsers.size}
                </span>
              )}
            </button>
          </div>

          {/* Selection Toolbar */}
          {selectedCount > 0 && (
            <div className="bg-brand-50 border border-brand-200 rounded-xl px-4 py-2 flex items-center gap-3 text-sm mb-4">
              <span className="text-brand-700 font-medium">{selectedCount} selected</span>
              <button onClick={() => setShowCompose(true)} className="px-3 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1">
                <Mail size={12} /> Send Message
              </button>
              <button onClick={() => setSelectedUsers({})} className="text-xs text-surface-500 hover:text-surface-700">Deselect All</button>
              <div className="ml-auto flex gap-1">
                {ROLES.map(r => (
                  <button key={r} onClick={() => selectByRole(r)}
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-surface-100 text-surface-600 hover:bg-surface-200">
                    + {r}s
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Users Table */}
          {loading ? (
            <div className="text-center py-12 text-surface-400">Loading users...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-surface-400">
              <Users size={32} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">No users found</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" role="table">
                  <thead>
                    <tr className="bg-surface-50 text-left">
                      <th scope="col" className="px-3 py-2.5 w-8">
                        <input type="checkbox" onChange={e => toggleAll(e.target.checked)}
                          checked={selectedCount > 0 && selectedCount === filtered.length} className="rounded"
                          aria-label="Select all users" />
                      </th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Name</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Email</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Role</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Status</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Badge</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Classes</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600">Last Active</th>
                      <th scope="col" className="px-3 py-2.5 text-xs font-semibold text-surface-600 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-100">
                    {filtered.map(u => {
                      const hasBadge = !!(u.card_id && String(u.card_id).trim())
                      // last_seen is more current (5-min heartbeat); fall back to last_login
                      const lastActiveTs = u.last_seen || u.last_login
                      const lastActiveFormatted = formatLastActive(lastActiveTs)
                      const lastLoginFormatted = u.last_login
                        ? new Date(u.last_login).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
                        : null
                      const emailLower = u.email?.toLowerCase()
                      const isOnline = onlineUsers.has(emailLower)
                      const activeDuration = isOnline ? formatActiveDuration(presenceMeta[emailLower]?.joined_at) : ''
                      const dotTitle = isOnline
                        ? `Online${activeDuration ? ` — active for ${activeDuration}` : ''}`
                        : lastActiveTs
                          ? `Last active: ${new Date(lastActiveTs).toLocaleString()}`
                          : 'Never active'
                      return (
                        <tr key={u.id} className={`hover:bg-surface-50 transition-colors ${u.status === 'Archived' ? 'opacity-60' : ''}`}>
                          <td className="px-3 py-2">
                            <input type="checkbox" checked={!!selectedUsers[u.id]}
                              onChange={() => toggleSelect(u.id)} className="rounded"
                              aria-label={`Select ${u.first_name} ${u.last_name}`} />
                          </td>
                          <td className="px-3 py-2 font-medium text-surface-900">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ring-1 transition-colors ${
                                  isOnline
                                    ? 'bg-emerald-400 ring-emerald-300'
                                    : 'bg-surface-200 ring-surface-200'
                                }`}
                                title={dotTitle}
                                aria-hidden="true"
                              />
                              {u.first_name} {u.last_name}
                              {u.time_clock_only === 'Yes' && (
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 font-semibold border border-sky-200" title="Time Clock Only – excluded from rotations and TV displays">
                                  <Clock size={12} aria-hidden="true" /> TCO
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-surface-500 text-xs">{u.email}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                              u.role === 'Instructor' ? 'bg-purple-100 text-purple-800' :
                              u.role === 'Work Study' ? 'bg-blue-100 text-blue-800' :
                              'bg-surface-100 text-surface-600'
                            }`}>{u.role}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                              u.status === 'Active' ? 'bg-emerald-100 text-emerald-800' :
                              u.status === 'Archived' ? 'bg-amber-100 text-amber-700' :
                              'bg-surface-100 text-surface-500'
                            }`}>{u.status}</span>
                          </td>
                          {/* Badge column - indicator only, not full number */}
                          <td className="px-3 py-2">
                            {hasBadge ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                                <CheckCircle2 size={12} aria-hidden="true" /> Assigned
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600">
                                <AlertTriangle size={12} aria-hidden="true" /> Missing
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-surface-500 max-w-[120px] truncate">{u.classes || '—'}</td>
                          {/* Last Active column — shows last_seen (5-min heartbeat) with last_login in tooltip */}
                          <td className="px-3 py-2 text-xs whitespace-nowrap"
                            title={[
                              lastActiveTs ? `Last active: ${new Date(lastActiveTs).toLocaleString()}` : null,
                              lastLoginFormatted ? `Login: ${lastLoginFormatted}` : null
                            ].filter(Boolean).join('\n') || 'Never active'}>
                            {isOnline ? (
                              <span className="text-emerald-600 font-semibold flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
                                Online{activeDuration ? ` · ${activeDuration}` : ''}
                              </span>
                            ) : lastActiveFormatted ? (
                              <span className="text-surface-500">{lastActiveFormatted}</span>
                            ) : (
                              <span className="text-surface-300">Never</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {hasPerm('edit_users') && (
                              <div className="flex items-center justify-center gap-0.5">
                                {/* Edit */}
                                <button onClick={() => setEditingUser(u)}
                                  title="Edit User"
                                  aria-label={`Edit ${u.first_name} ${u.last_name}`}
                                  className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-brand-600">
                                  <Edit3 size={14} />
                                </button>
                                {/* Reset Password — only for non-Instructor accounts */}
                                {u.role !== 'Instructor' && (
                                  <button onClick={() => setResetConfirm(u)}
                                    title="Reset Password"
                                    aria-label={`Reset password for ${u.first_name} ${u.last_name}`}
                                    className="p-1.5 rounded-lg hover:bg-amber-50 text-surface-400 hover:text-amber-600">
                                    <KeyRound size={14} />
                                  </button>
                                )}
                                {/* Archive / Unarchive */}
                                {u.status !== 'Archived' ? (
                                  <button onClick={() => setArchiveConfirm(u)}
                                    title="Archive User"
                                    aria-label={`Archive ${u.first_name} ${u.last_name}`}
                                    className="p-1.5 rounded-lg hover:bg-amber-50 text-surface-400 hover:text-amber-600">
                                    <UserMinus size={14} />
                                  </button>
                                ) : (
                                  <button onClick={async () => {
                                    await actions.updateUser(u.id, { status: 'Active' })
                                    refresh()
                                  }}
                                    title="Reactivate User"
                                    aria-label={`Reactivate ${u.first_name} ${u.last_name}`}
                                    className="p-1.5 rounded-lg hover:bg-emerald-50 text-surface-400 hover:text-emerald-600">
                                    <UserCheck size={14} />
                                  </button>
                                )}
                                {/* Permanently Delete — super admin only */}
                                {isSuperAdmin && (
                                  <button onClick={() => setDeleteConfirm(u)}
                                    title="Permanently Delete"
                                    aria-label={`Permanently delete ${u.first_name} ${u.last_name}`}
                                    className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-600">
                                    <X size={14} />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Add User Modal */}
          {showAddUser && (
            <AddUserModal
              onClose={() => setShowAddUser(false)}
              onAdded={() => { setShowAddUser(false); refresh() }}
            />
          )}

          {/* Edit User Modal */}
          {editingUser && (
            <EditUserModal user={editingUser} actions={actions} allClasses={allClasses}
              onClose={() => setEditingUser(null)}
              onSaved={() => { setEditingUser(null); refresh() }} />
          )}

          {/* Reset Password Modal */}
          {resetConfirm && (
            <ResetPasswordModal user={resetConfirm} actions={actions}
              onClose={() => setResetConfirm(null)}
              onDone={() => setResetConfirm(null)} />
          )}

          {/* Archive Confirmation Modal */}
          {archiveConfirm && (
            <ArchiveConfirmModal user={archiveConfirm} actions={actions}
              onClose={() => setArchiveConfirm(null)}
              onDone={() => { setArchiveConfirm(null); refresh() }} />
          )}

          {/* Permanent Delete Confirmation Modal */}
          {deleteConfirm && (
            <DeleteConfirmModal user={deleteConfirm} actions={actions}
              onClose={() => setDeleteConfirm(null)}
              onDone={() => { setDeleteConfirm(null); refresh() }} />
          )}

          {/* Compose Message Modal */}
          {showCompose && (
            <ComposeModal users={users} selectedIds={Object.keys(selectedUsers)} templates={templates}
              onClose={() => setShowCompose(false)}
              onSent={() => { setShowCompose(false); setSelectedUsers({}) }} />
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD USER MODAL
// ═══════════════════════════════════════════════════════════════════════════════
//
// Quick-add a user as a Student (default). After creation the instructor can
// use the Edit modal to change role, set TCO, assign classes, etc.

function AddUserModal({ onClose, onAdded }) {
  const { profile } = useAuth()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)

  const userName = profile
    ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
    : 'Unknown'

  const canSubmit = firstName.trim() && lastName.trim() && email.trim()

  const handleSubmit = async () => {
    if (!canSubmit) return

    const trimmedEmail = email.toLowerCase().trim()
    const trimmedFirst = firstName.trim()
    const trimmedLast = lastName.trim()

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error('Please enter a valid email address.')
      return
    }

    setSaving(true)
    try {
      // Check if a profile with this email already exists
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', trimmedEmail)
        .maybeSingle()

      if (existing) {
        toast.error('A user with this email already exists.')
        setSaving(false)
        return
      }

      // Create profile — always defaults to Student / Active
      const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const { error } = await supabase.from('profiles').insert({
        id: uuid,
        email: trimmedEmail,
        first_name: trimmedFirst,
        last_name: trimmedLast,
        role: 'Student',
        status: 'Active'
      })

      if (error) throw error

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Add User',
          entity_type: 'User',
          entity_id: uuid,
          details: `Manually added user: ${trimmedFirst} ${trimmedLast} (${trimmedEmail}) as Student`
        })
      } catch {}

      toast.success(`${trimmedFirst} ${trimmedLast} added as Student!`)
      onAdded()
    } catch (err) {
      toast.error(err.message || 'Failed to add user')
    } finally {
      setSaving(false)
    }
  }

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="add-user-title">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center">
              <UserPlus size={16} className="text-brand-600" />
            </div>
            <h3 id="add-user-title" className="text-sm font-bold text-surface-900">Add User</h3>
          </div>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Info note */}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-blue-50 border border-blue-200">
          <AlertCircle size={14} className="text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700 leading-snug">
            New users are added as <strong>Student</strong> by default. Use the Edit button after
            creation to change role, assign classes, or set Time Clock Only (TCO).
          </p>
        </div>

        {/* Name fields */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="add-first-name" className="label">First Name</label>
            <input
              id="add-first-name"
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              className="input text-sm"
              placeholder="First Name"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="add-last-name" className="label">Last Name</label>
            <input
              id="add-last-name"
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              className="input text-sm"
              placeholder="Last Name"
            />
          </div>
        </div>

        {/* Email */}
        <div>
          <label htmlFor="add-email" className="label">Email Address</label>
          <input
            id="add-email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="input text-sm"
            placeholder="student@example.edu"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleSubmit}
            disabled={saving || !canSubmit}
            className="flex-1 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {saving ? 'Adding...' : 'Add User'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm hover:bg-surface-200 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESET PASSWORD MODAL
// ═══════════════════════════════════════════════════════════════════════════════
//
// Allows an instructor to set a temporary password for a Student or Work Study.
// Auto-generates a RICT#### password on open. The Edge Function also stamps
// user_metadata.must_reset_password = true so the student is forced to change
// their password on next login before accessing any page.

function generateTempPassword() {
  const digits = String(Math.floor(1000 + Math.random() * 9000))
  return `RICT${digits}`
}

function ResetPasswordModal({ user, actions, onClose, onDone }) {
  const [tempPassword, setTempPassword] = useState(() => generateTempPassword())
  const [showPassword, setShowPassword] = useState(true)
  const [copied, setCopied] = useState(false)
  const [processing, setProcessing] = useState(false)

  const fullName = `${user.first_name} ${user.last_name}`

  const handleRegenerate = () => {
    setTempPassword(generateTempPassword())
    setCopied(false)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  const handleSubmit = async () => {
    if (tempPassword.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }
    setProcessing(true)
    try {
      const ok = await actions.resetStudentPassword(user.id, fullName, tempPassword)
      if (ok) onDone()
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="reset-pw-title">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
              <KeyRound size={16} className="text-amber-600" />
            </div>
            <h3 id="reset-pw-title" className="text-sm font-bold text-surface-900">Reset Password</h3>
          </div>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600" aria-label="Close"><X size={16} /></button>
        </div>

        {/* Who */}
        <div className="bg-surface-50 border border-surface-100 rounded-lg p-3">
          <p className="text-sm font-medium text-surface-900">{fullName}</p>
          <p className="text-xs text-surface-500">{user.email}</p>
          <p className="text-xs text-surface-400 mt-0.5">Role: {user.role}</p>
        </div>

        {/* Warning */}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
          <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 leading-snug">
            This immediately changes the student's password and requires them to set a
            new one on their next login. Share this temporary password with them in person.
          </p>
        </div>

        {/* Password field */}
        <div className="space-y-1.5">
          <label htmlFor="temp-password" className="label">Temporary Password</label>
          <div className="flex gap-2">
            {/* Input */}
            <div className="relative flex-1">
              <input
                id="temp-password"
                type={showPassword ? 'text' : 'password'}
                value={tempPassword}
                onChange={e => setTempPassword(e.target.value)}
                className="input pr-9 font-mono tracking-wider text-sm"
                placeholder="Min. 6 characters"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-surface-400 hover:text-surface-600"
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {/* Regenerate */}
            <button
              type="button"
              onClick={handleRegenerate}
              title="Generate new password"
              aria-label="Generate new password"
              className="p-2 rounded-lg border border-surface-200 bg-white text-surface-500 hover:text-brand-600 hover:border-brand-300 transition-colors"
            >
              <RefreshCcw size={14} />
            </button>
            {/* Copy */}
            <button
              type="button"
              onClick={handleCopy}
              title="Copy to clipboard"
              aria-label="Copy to clipboard"
              className={`p-2 rounded-lg border transition-colors ${
                copied
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                  : 'border-surface-200 bg-white text-surface-500 hover:text-brand-600 hover:border-brand-300'
              }`}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-[10px] text-surface-400">
            Auto-generated (RICT + 4 digits). You can type your own or regenerate.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleSubmit}
            disabled={processing || tempPassword.length < 6}
            className="flex-1 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            {processing ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {processing ? 'Setting Password…' : 'Set Password'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm hover:bg-surface-200">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHIVE CONFIRMATION MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function ArchiveConfirmModal({ user, actions, onClose, onDone }) {
  const [processing, setProcessing] = useState(false)
  const fullName = `${user.first_name} ${user.last_name}`

  const handleArchive = async () => {
    setProcessing(true)
    try {
      await actions.archiveUser(user.id, fullName, user.email)
      onDone()
    } catch {
      setProcessing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="archive-user-title">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
            <Archive size={20} className="text-amber-600" />
          </div>
          <div>
            <h3 id="archive-user-title" className="text-sm font-bold text-surface-900">Archive User</h3>
            <p className="text-xs text-surface-500">Remove from active rotations</p>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-sm font-medium text-surface-900">{fullName}</p>
          <p className="text-xs text-surface-500">{user.email}</p>
        </div>

        <p className="text-xs text-surface-500">
          Archiving will remove this user from class rotations, lab signups, and work order assignments. 
          Their historical data (time clock, work orders) will be preserved. You can reactivate them later.
        </p>

        <div className="flex gap-2 pt-1">
          <button onClick={handleArchive} disabled={processing}
            className="flex-1 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 flex items-center justify-center gap-1.5">
            {processing ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
            {processing ? 'Archiving...' : 'Archive User'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERMANENT DELETE CONFIRMATION MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function DeleteConfirmModal({ user, actions, onClose, onDone }) {
  const [step, setStep] = useState(1)
  const [typedName, setTypedName] = useState('')
  const [processing, setProcessing] = useState(false)
  const fullName = `${user.first_name} ${user.last_name}`
  const nameMatches = typedName.trim().toLowerCase() === fullName.trim().toLowerCase()

  const handleDelete = async () => {
    if (!nameMatches) return
    setProcessing(true)
    try {
      await actions.permanentlyDeleteUser(user.id, fullName, user.email)
      onDone()
    } catch {
      setProcessing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
            <Trash2 size={20} className="text-red-600" />
          </div>
          <div>
            <h3 id="delete-user-title" className="text-sm font-bold text-red-700">Permanently Delete User</h3>
            <p className="text-xs text-surface-500">This action cannot be undone</p>
          </div>
        </div>

        {step === 1 ? (
          <>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm font-medium text-surface-900">{fullName}</p>
              <p className="text-xs text-surface-500">{user.email}</p>
              <p className="text-xs text-surface-400 mt-1">Role: {user.role}</p>
            </div>

            <div className="text-xs text-surface-500 space-y-1">
              <p>Permanently deleting this user will:</p>
              <ul className="list-disc list-inside space-y-0.5 text-surface-600">
                <li>Remove their profile and account</li>
                <li>Remove their sessions and messages</li>
                <li>Preserve time clock and work order history</li>
              </ul>
              <p className="text-red-600 font-semibold mt-2">This action CANNOT be undone.</p>
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => setStep(2)}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                Continue
              </button>
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <label htmlFor="confirm-delete-name" className="text-xs font-medium text-surface-700">
                Type <span className="font-bold text-red-600">{fullName}</span> to confirm:
              </label>
              <input id="confirm-delete-name" value={typedName} onChange={e => setTypedName(e.target.value)}
                className="input text-sm" placeholder="Type full name here..."
                autoFocus />
              {typedName && !nameMatches && (
                <p className="text-[10px] text-red-500">Name doesn't match. Must be: {fullName}</p>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={handleDelete} disabled={!nameMatches || processing}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 ${
                  nameMatches ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-surface-200 text-surface-400 cursor-not-allowed'
                }`}>
                {processing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {processing ? 'Deleting...' : 'DELETE PERMANENTLY'}
              </button>
              <button onClick={() => { setStep(1); setTypedName('') }}
                className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT USER MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function EditUserModal({ user, actions, allClasses, onClose, onSaved }) {
  const [form, setForm] = useState({
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    role: user.role || 'Student',
    status: user.status || 'Active',
    classes: user.classes || '',
    cardId: user.card_id ? String(user.card_id) : '',
    timeClockOnly: user.time_clock_only === 'Yes'
  })

  const handleSave = async () => {
    try {
      await actions.updateUser(user.id, form)
      onSaved()
    } catch {}
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="edit-user-title">
      <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 id="edit-user-title" className="text-sm font-bold text-surface-900">Edit User</h3>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="edit-first-name" className="label">First Name</label>
            <input id="edit-first-name" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="input text-sm" />
          </div>
          <div>
            <label htmlFor="edit-last-name" className="label">Last Name</label>
            <input id="edit-last-name" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="input text-sm" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="edit-role" className="label">Role</label>
            <select id="edit-role" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className="input text-sm">
              {ROLES.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="edit-status" className="label">Status</label>
            <select id="edit-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="input text-sm">
              {STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="edit-classes" className="label">Classes (comma-separated)</label>
          <input id="edit-classes" value={form.classes} onChange={e => setForm(f => ({ ...f, classes: e.target.value }))}
            className="input text-sm" placeholder="RICT-101, RICT-201" />
        </div>

        <div>
          <label htmlFor="edit-card-id" className="label">Card ID / Badge</label>
          <input id="edit-card-id" value={form.cardId} onChange={e => setForm(f => ({ ...f, cardId: e.target.value }))}
            className="input text-sm" placeholder="Scan or enter card ID" />
          {form.cardId && (
            <p className="text-[10px] text-surface-400 mt-1">Current: {form.cardId}</p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={form.timeClockOnly}
            onChange={e => setForm(f => ({ ...f, timeClockOnly: e.target.checked }))} className="rounded" />
          <span>Time Clock Only (no app login)</span>
        </label>

        <div className="flex gap-2 pt-1">
          <button onClick={handleSave} disabled={actions.saving} className="btn-primary text-sm gap-1.5 flex-1">
            {actions.saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCESS REQUESTS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function AccessRequestsPanel({ requests, loading, onRefresh }) {
  const { profile } = useAuth()
  const [processing, setProcessing] = useState(null)
  const [showManualAdd, setShowManualAdd] = useState(false)
  const [manualEmail, setManualEmail] = useState('')
  const [manualFirst, setManualFirst] = useState('')
  const [manualLast, setManualLast] = useState('')
  const [manualRole, setManualRole] = useState('Student')
  const [manualLoading, setManualLoading] = useState(false)
  const [rejectTarget, setRejectTarget] = useState(null)
  const { sendRejectionNotification } = useRejectionNotification()

  const userName = profile ? `${profile.first_name} ${(profile.last_name || '').charAt(0)}.` : ''

  const approve = async (req) => {
    setProcessing(req.request_id)
    try {
      // Create user profile
      const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const { error: profileErr } = await supabase.from('profiles').insert({
        id: uuid,
        email: req.email,
        first_name: req.first_name,
        last_name: req.last_name,
        role: req.requested_role || 'Student',
        status: 'Active',
      })

      if (profileErr) {
        // Try without id
        const { error: noIdErr } = await supabase.from('profiles').insert({
          email: req.email,
          first_name: req.first_name,
          last_name: req.last_name,
          role: req.requested_role || 'Student',
          status: 'Active',
        })
        if (noIdErr) throw noIdErr
      }

      // Update request status
      const { error: updateErr } = await supabase.from('access_requests').update({
        status: 'Approved',
        processed_by: userName,
        processed_date: new Date().toISOString()
      }).eq('request_id', req.request_id)

      // If the full update fails, try status only
      if (updateErr) {
        await supabase.from('access_requests')
          .update({ status: 'Approved' })
          .eq('request_id', req.request_id)
      }

      onRefresh()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setProcessing(null)
    }
  }

  const reject = async (req) => {
    setRejectTarget(req)
  }

  const handleRejectConfirm = async (reason) => {
    if (!rejectTarget) return
    setProcessing(rejectTarget.request_id)
    try {
      const { error } = await supabase.from('access_requests').update({
        status: 'Rejected',
        processed_by: userName,
        processed_date: new Date().toISOString(),
        notes: reason,
      }).eq('request_id', rejectTarget.request_id)

      if (error) {
        await supabase.from('access_requests')
          .update({ status: 'Rejected', notes: reason })
          .eq('request_id', rejectTarget.request_id)
      }

      // Notify the student (they have an email even though they don't have a profile yet)
      await sendRejectionNotification({
        recipientEmail: rejectTarget.email,
        recipientName: `${rejectTarget.first_name || ''} ${rejectTarget.last_name || ''}`.trim(),
        requestType: 'Access Request',
        requestId: rejectTarget.request_id,
        reason,
      })

      setRejectTarget(null)
      onRefresh()
    } catch (err) {
      throw new Error(err.message || 'Failed to reject request')
    } finally {
      setProcessing(null)
    }
  }

  // Manual add: create profile directly (bypasses email verification)
  const handleManualAdd = async () => {
    if (!manualEmail.trim() || !manualFirst.trim() || !manualLast.trim()) {
      alert('All fields are required')
      return
    }
    setManualLoading(true)
    try {
      // Check if profile already exists
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', manualEmail.toLowerCase().trim())
        .maybeSingle()

      if (existing) {
        alert('A user with this email already exists')
        setManualLoading(false)
        return
      }

      // Create profile directly
      const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const { error } = await supabase.from('profiles').insert({
        id: uuid,
        email: manualEmail.toLowerCase().trim(),
        first_name: manualFirst.trim(),
        last_name: manualLast.trim(),
        role: manualRole,
        status: 'Active'
      })

      if (error) throw error

      // Also create/update access request record
      try {
        await supabase.rpc('submit_access_request', {
          p_email: manualEmail.toLowerCase().trim(),
          p_first_name: manualFirst.trim(),
          p_last_name: manualLast.trim(),
        })
        // Mark it as approved
        await supabase.from('access_requests')
          .update({ status: 'Approved', processed_by: userName })
          .eq('email', manualEmail.toLowerCase().trim())
          .eq('status', 'Pending')
      } catch {}

      setManualEmail('')
      setManualFirst('')
      setManualLast('')
      setShowManualAdd(false)
      alert(`${manualFirst} ${manualLast} added as ${manualRole}!`)
      onRefresh()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setManualLoading(false)
    }
  }

  if (loading) return <div className="text-center py-12 text-surface-400">Loading requests...</div>

  return (
    <>
    <div className="space-y-4">
      {/* Manual Add User button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowManualAdd(!showManualAdd)}
          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 flex items-center gap-1"
        >
          <UserPlus size={14} /> Add User Manually
        </button>
      </div>

      {/* Manual Add Form */}
      {showManualAdd && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-blue-800">Add User Manually</p>
          <p className="text-xs text-blue-600">
            Use this to add a student whose email verification isn't working. This bypasses the email verification step.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="First Name"
              value={manualFirst}
              onChange={e => setManualFirst(e.target.value)}
              className="input text-sm"
              aria-label="First Name"
            />
            <input
              type="text"
              placeholder="Last Name"
              value={manualLast}
              onChange={e => setManualLast(e.target.value)}
              className="input text-sm"
              aria-label="Last Name"
            />
          </div>
          <input
            type="email"
            placeholder="Email Address"
            value={manualEmail}
            onChange={e => setManualEmail(e.target.value)}
            className="input text-sm w-full"
            aria-label="Email Address"
          />
          <div className="flex items-center gap-2">
            <select
              value={manualRole}
              onChange={e => setManualRole(e.target.value)}
              className="input text-sm"
              aria-label="Role"
            >
              <option value="Student">Student</option>
              <option value="Work Study">Work Study</option>
              <option value="Instructor">Instructor</option>
            </select>
            <button
              onClick={handleManualAdd}
              disabled={manualLoading}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 flex items-center gap-1"
            >
              {manualLoading ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
              Add User
            </button>
            <button
              onClick={() => setShowManualAdd(false)}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm hover:bg-surface-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pending requests */}
      {requests.length === 0 && !showManualAdd ? (
        <div className="text-center py-12">
          <CheckCircle2 size={36} className="mx-auto mb-3 text-emerald-400" />
          <p className="text-sm text-surface-500">No pending access requests</p>
        </div>
      ) : (
        requests.map(req => (
          <div key={req.request_id} className="bg-white rounded-xl border border-yellow-200 p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center">
              <UserPlus size={18} className="text-yellow-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-surface-900">{req.first_name} {req.last_name}</div>
              <div className="text-xs text-surface-500">{req.email}</div>
              <div className="text-xs text-surface-400 mt-0.5">
                Role: {req.requested_role || '—'} | Classes: {req.classes || '—'} | {new Date(req.request_date).toLocaleDateString()}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => approve(req)} disabled={processing === req.request_id}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 flex items-center gap-1">
                {processing === req.request_id ? <Loader2 size={12} className="animate-spin" /> : <UserCheck size={12} />} Approve
              </button>
              <button onClick={() => reject(req)} disabled={processing === req.request_id}
                className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 flex items-center gap-1">
                <UserX size={12} /> Reject
              </button>
            </div>
          </div>
        ))
      )}
    </div>

    {/* ── Rejection Modal ── */}
    <RejectionModal
      open={!!rejectTarget}
      title="Reject Registration Request"
      subtitle={rejectTarget
        ? `${rejectTarget.first_name || ''} ${rejectTarget.last_name || ''} (${rejectTarget.email})`
        : ''
      }
      requestType="Access Request"
      requestId={rejectTarget?.request_id || ''}
      recipientEmail={rejectTarget?.email || ''}
      recipientName={rejectTarget ? `${rejectTarget.first_name || ''} ${rejectTarget.last_name || ''}`.trim() : ''}
      onConfirm={handleRejectConfirm}
      onClose={() => { setRejectTarget(null); setProcessing(null) }}
    />
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSE MESSAGE MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function ComposeModal({ users, selectedIds, templates, onClose, onSent }) {
  const { profile } = useAuth()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [expires, setExpires] = useState('')
  const [sending, setSending] = useState(false)

  const recipients = users.filter(u => selectedIds.includes(u.id))

  const handleSend = async () => {
    if (!subject.trim()) return alert('Subject is required')
    if (!body.trim()) return alert('Message is required')
    setSending(true)
    try {
      const emails = recipients.map(u => u.email).filter(Boolean)
      // Create announcement records
      for (const email of emails) {
        await supabase.from('announcements').insert({
          recipient_email: email,
          sender_email: profile.email,
          sender_name: `${profile.first_name} ${(profile.last_name || '').charAt(0)}.`,
          subject,
          body,
          expires_at: expires || null,
          created_at: new Date().toISOString(),
          read: false
        })
      }
      toast.success(`Message sent to ${emails.length} recipient${emails.length !== 1 ? 's' : ''}!`)
      onSent()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="compose-title">
      <div className="bg-white rounded-2xl w-full max-w-lg p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 id="compose-title" className="text-sm font-bold text-surface-900">Compose Message</h3>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600" aria-label="Close"><X size={16} /></button>
        </div>

        {/* Recipients */}
        <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
          {recipients.map(u => (
            <span key={u.id} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
              u.role === 'Student' ? 'bg-surface-100 text-surface-600' : 'bg-blue-100 text-blue-700'
            }`}>{u.first_name} {u.last_name}</span>
          ))}
        </div>

        {/* Template */}
        {templates.length > 0 && (
          <select onChange={e => {
            const t = templates[parseInt(e.target.value)]
            if (t) { setSubject(t.subject); setBody(t.body) }
          }} className="input text-sm" aria-label="Use a message template">
            <option value="">Use template...</option>
            {templates.map((t, i) => <option key={i} value={i}>{t.template_name}</option>)}
          </select>
        )}

        <div>
          <label htmlFor="compose-subject" className="label">Subject</label>
          <input id="compose-subject" value={subject} onChange={e => setSubject(e.target.value)} className="input text-sm" placeholder="Subject..." />
        </div>
        <div>
          <label htmlFor="compose-body" className="label">Message</label>
          <textarea id="compose-body" value={body} onChange={e => setBody(e.target.value)} rows={5} className="input text-sm" placeholder="Write your message..." />
        </div>
        <div>
          <label htmlFor="compose-expires" className="label">Expires (optional)</label>
          <input id="compose-expires" type="date" value={expires} onChange={e => setExpires(e.target.value)} className="input text-sm" />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={handleSend} disabled={sending} className="btn-primary text-sm gap-1.5 flex-1">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {sending ? 'Sending...' : `Send to ${recipients.length}`}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-surface-100 text-surface-600 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}
