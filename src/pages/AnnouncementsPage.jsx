import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { assertWrite } from '@/lib/supabaseData'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import {
  Megaphone, Search, Send, Trash2, RotateCcw, X, Loader2,
  CheckCircle2, Mail, MailOpen, Clock, Users, ChevronDown, ChevronUp,
  Bell, RefreshCw, Plus, FileText, Save, Edit3, Eye, EyeOff, Archive, Undo2, Pin, Inbox,
  ShieldAlert, Info,
  MonitorPlay, ImagePlus, ArrowUp, ArrowDown, ImageIcon, CalendarDays,
} from 'lucide-react'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import StudentHoldsTab from '@/components/holds/StudentHoldsTab'
import { SUPER_ADMIN_EMAIL } from '@/lib/superAdmin'

// ─────────────────────────────────────────────────────────────────────────────
// Utility / service accounts that must NEVER appear in the messaging picker —
// even for instructors and even though they may have a valid Active profile.
// Compared case-insensitively. Add more entries here if additional service
// accounts are introduced. Today: the super-admin utility account, per the
// "never shown in instructor-facing UI" convention.
// ─────────────────────────────────────────────────────────────────────────────
const HIDDEN_PICKER_EMAILS = new Set([
  SUPER_ADMIN_EMAIL,
])
function isHiddenPickerEmail(email) {
  if (!email) return false
  return HIDDEN_PICKER_EMAILS.has(String(email).toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// notification_type values that represent SYSTEM-GENERATED audit rows (not
// human-composed messages). When the instructor toggles "hide audit rows" on
// the Sent Messages tab, rows with these types are filtered out.
//
// These rows have sender_email = whoever triggered the action (e.g. a student
// self-assigning to a WO), but semantically they aren't "messages" — they're
// audit notifications the system writes for the recipient. Listing them here
// (rather than allow-listing message types) means new BROADCAST types added
// in the future show up automatically; new SYSTEM types must be opted-in.
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_NOTIFICATION_TYPES = new Set([
  'wo_assignment',
  'wo_unassignment',
])
function isSystemNotificationType(t) {
  return !!t && SYSTEM_NOTIFICATION_TYPES.has(t)
}

// localStorage key for the "show audit rows" toggle on the instructor's
// Sent Messages tab. Per-browser preference; doesn't sync across devices.
const SENT_SHOW_SYSTEM_KEY = 'rict-cmms.sent.show-system-rows'

// ─────────────────────────────────────────────────────────────────────────────
// Policy disclaimer shown to students/work study at compose time. Lives here
// (rather than inline in JSX) so wording can be tweaked in one spot. Update
// this string and the modal will pick it up automatically — no other changes
// required.
// ─────────────────────────────────────────────────────────────────────────────
const STUDENT_USAGE_NOTE = {
  heading: 'For CMMS communication only.',
  body: 'Use this for work orders, lab questions, parts, and shop-floor topics. For grades, attendance, accommodations, or other academic matters, please contact your instructor through your official email or D2L message.',
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM MODAL (replaces native confirm())
// ═══════════════════════════════════════════════════════════════════════════════

function ConfirmModal({ open, title, message, confirmLabel = 'Delete', confirmColor = 'red', onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              confirmColor === 'red' ? 'bg-red-100' : 'bg-brand-100'
            }`}>
              <Trash2 size={18} className={confirmColor === 'red' ? 'text-red-600' : 'text-brand-600'} />
            </div>
            <h3 className="text-base font-semibold text-surface-900">{title}</h3>
          </div>
          <p className="text-sm text-surface-600 leading-relaxed ml-[52px]">{message}</p>
        </div>
        <div className="px-6 pb-5 flex justify-end gap-3">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-surface-600 bg-surface-100 hover:bg-surface-200 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
              confirmColor === 'red'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-brand-600 hover:bg-brand-700'
            }`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function AnnouncementsPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Announcements')
  const canCompose = hasPerm('compose_message')
  const canViewSent = hasPerm('view_sent')
  const canManageTemplates = hasPerm('manage_templates')
  const canManageHolds = hasPerm('manage_holds')
  const canManageTVSlides = hasPerm('manage_tv_slides')
  const isInstructor = profile?.role === 'Instructor' || profile?.role === 'Super Admin'
  // Non-instructors with compose permission still get a Sent tab — but it's
  // filtered to only their own sent messages (handled inside SentHistoryTab).
  // Instructors with view_sent see ALL sent messages (existing behavior).
  const canViewOwnSent = canCompose && !canViewSent
  const showSentTab = canViewSent || canViewOwnSent
  const [tab, setTab] = useState('inbox')
  const [showCompose, setShowCompose] = useState(false)
  const [replyTo, setReplyTo] = useState(null) // { sender_email, sender_name, subject } when replying
  const [refreshKey, setRefreshKey] = useState(0)
  const [tabInitDone, setTabInitDone] = useState(false)
  const triggerRefresh = () => setRefreshKey(k => k + 1)

  // Default tab logic:
  //   Instructors → 'sent' (so they land on the broadcast history they manage)
  //   Students/Work Study → stay on 'inbox' (their primary use-case is reading messages)
  useEffect(() => {
    if (!tabInitDone && canViewSent) {
      setTab('sent')
      setTabInitDone(true)
    }
  }, [canViewSent, tabInitDone])

  // Open compose modal with reply context pre-filled. Called from InboxTab.
  const openReply = (msg) => {
    setReplyTo({
      sender_email: msg.sender_email,
      sender_name: msg.sender_name,
      subject: msg.subject,
    })
    setShowCompose(true)
  }

  const closeCompose = () => {
    setShowCompose(false)
    setReplyTo(null)
  }

  const tabs = [
    { id: 'inbox', label: 'My Inbox', icon: Bell },
    ...(showSentTab ? [
      { id: 'sent', label: canViewOwnSent ? 'My Sent' : 'Sent Messages', icon: Send },
    ] : []),
    ...(canManageTemplates ? [
      { id: 'templates', label: 'Templates', icon: FileText },
    ] : []),
    ...(canManageHolds ? [
      { id: 'holds', label: 'Student Holds', icon: ShieldAlert },
    ] : []),
    ...(canManageTVSlides ? [
      { id: 'tvslides', label: 'TV Slides', icon: MonitorPlay },
    ] : []),
  ]

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
          <Megaphone size={20} className="text-brand-600" /> Announcements
        </h1>
        {canCompose && (
          <button onClick={() => { setReplyTo(null); setShowCompose(true) }}
            className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 flex items-center gap-1.5 shadow-sm"
            aria-label={isInstructor ? 'Compose new announcement' : 'Send a message to your instructor(s)'}>
            <Plus size={14} /> {isInstructor ? 'New Message' : 'Message Instructor'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1" role="tablist" aria-label="Announcement views">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            role="tab"
            aria-selected={tab === t.id}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
              tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
            }`}>
            <t.icon size={14} aria-hidden="true" /> {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'inbox' && (
        <InboxTab
          refreshKey={refreshKey}
          canReply={canCompose}
          onReply={openReply}
        />
      )}
      {tab === 'sent' && showSentTab && (
        <SentHistoryTab
          refreshKey={refreshKey}
          viewMode={canViewOwnSent ? 'own' : 'all'}
        />
      )}
      {tab === 'templates' && canManageTemplates && <TemplatesTab />}
      {tab === 'holds' && canManageHolds && <StudentHoldsTab />}
      {tab === 'tvslides' && canManageTVSlides && <TVSlidesTab />}

      {/* Compose Modal */}
      {showCompose && (
        <ComposeModal
          isInstructor={isInstructor}
          canManageTemplates={canManageTemplates}
          replyTo={replyTo}
          onClose={closeCompose}
          onSent={() => { closeCompose(); triggerRefresh() }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOX TAB  (All users)
// ═══════════════════════════════════════════════════════════════════════════════

function InboxTab({ refreshKey, canReply = false, onReply }) {
  const { profile } = useAuth()
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [subTab, setSubTab] = useState('inbox') // 'inbox' | 'archived'
  const [search, setSearch] = useState('')

  const loadMessages = useCallback(async (silent = false) => {
    if (!profile?.email) return
    if (!silent) setLoading(true)
    try {
      const now = new Date().toISOString()
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .eq('recipient_email', profile.email.toLowerCase())
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })

      if (error) throw error
      setMessages(data || [])
    } catch (err) {
      console.error('Error loading inbox:', err)
      if (!silent) toast.error('Failed to load messages')
    } finally {
      setLoading(false)
    }
  }, [profile?.email])

  useEffect(() => { loadMessages() }, [loadMessages, refreshKey])

  // Realtime: auto-refresh when announcements change (new message, read status, etc.)
  useEffect(() => {
    if (!profile?.email) return
    const channel = supabase
      .channel('inbox-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'announcements', filter: `recipient_email=eq.${profile.email.toLowerCase()}` },
        () => { loadMessages(true) }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.email, loadMessages])

  const markRead = async (msg) => {
    if (msg.read) return
    try {
      await supabase.from('announcements').update({
        read: true,
        read_date: new Date().toISOString()
      }).eq('id', msg.id)
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, read: true } : m))
    } catch {}
  }

  const markAllRead = async () => {
    const unreadIds = inboxMessages.filter(m => !m.read).map(m => m.id)
    if (unreadIds.length === 0) return
    try {
      await supabase.from('announcements').update({
        read: true,
        read_date: new Date().toISOString()
      }).in('id', unreadIds)
      setMessages(prev => prev.map(m => unreadIds.includes(m.id) ? { ...m, read: true } : m))
      toast.success('All messages marked as read')
    } catch {
      toast.error('Failed to mark all read')
    }
  }

  const archiveMessage = async (msg) => {
    try {
      await supabase.from('announcements').update({
        archived: true,
        archived_at: new Date().toISOString()
      }).eq('id', msg.id)
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, archived: true } : m))
      toast.success('Message archived')
    } catch {
      toast.error('Failed to archive')
    }
  }

  const restoreMessage = async (msg) => {
    try {
      await supabase.from('announcements').update({
        archived: false,
        archived_at: null
      }).eq('id', msg.id)
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, archived: false } : m))
      toast.success('Message restored')
    } catch {
      toast.error('Failed to restore')
    }
  }

  // Split messages into inbox vs archived, with pinned on top
  const inboxMessages = useMemo(() => {
    let msgs = messages.filter(m => !m.archived)
    if (search) {
      const s = search.toLowerCase()
      msgs = msgs.filter(m =>
        m.subject?.toLowerCase().includes(s) ||
        m.body?.toLowerCase().includes(s) ||
        m.sender_name?.toLowerCase().includes(s)
      )
    }
    // Pinned first, then by date
    return msgs.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return new Date(b.created_at) - new Date(a.created_at)
    })
  }, [messages, search])

  const archivedMessages = useMemo(() => {
    let msgs = messages.filter(m => m.archived)
    if (search) {
      const s = search.toLowerCase()
      msgs = msgs.filter(m =>
        m.subject?.toLowerCase().includes(s) ||
        m.body?.toLowerCase().includes(s) ||
        m.sender_name?.toLowerCase().includes(s)
      )
    }
    return msgs
  }, [messages, search])

  const unreadCount = inboxMessages.filter(m => !m.read).length
  const currentMessages = subTab === 'inbox' ? inboxMessages : archivedMessages

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading messages…</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Sub-tabs: Inbox / Archived */}
      <div className="flex rounded-lg border border-surface-200 overflow-hidden">
        <button onClick={() => setSubTab('inbox')}
          className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
            subTab === 'inbox'
              ? 'bg-brand-50 text-brand-700 border-b-2 border-brand-600'
              : 'text-surface-500 hover:bg-surface-50'
          }`}>
          <Inbox size={13} /> Inbox
          {unreadCount > 0 && (
            <span className="bg-brand-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </button>
        <button onClick={() => setSubTab('archived')}
          className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
            subTab === 'archived'
              ? 'bg-brand-50 text-brand-700 border-b-2 border-brand-600'
              : 'text-surface-500 hover:bg-surface-50'
          }`}>
          <Archive size={13} /> Archived
          {archivedMessages.length > 0 && (
            <span className="bg-surface-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {archivedMessages.length}
            </span>
          )}
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search messages…" className="input pl-9 text-sm w-full" />
      </div>

      {/* Toolbar */}
      {subTab === 'inbox' && unreadCount > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-surface-500">
            {unreadCount} unread message{unreadCount !== 1 ? 's' : ''}
          </span>
          <button onClick={markAllRead}
            className="text-xs text-brand-600 font-medium hover:underline flex items-center gap-1">
            <CheckCircle2 size={12} /> Mark all read
          </button>
        </div>
      )}

      {/* Empty state */}
      {currentMessages.length === 0 && (
        <div className="text-center py-16">
          {subTab === 'inbox' ? (
            <><Mail size={40} className="mx-auto mb-3 text-surface-300" />
            <p className="text-sm text-surface-500">No messages in your inbox</p></>
          ) : (
            <><Archive size={40} className="mx-auto mb-3 text-surface-300" />
            <p className="text-sm text-surface-500">No archived messages</p></>
          )}
        </div>
      )}

      {/* Message list */}
      {currentMessages.map(msg => {
        const isExpanded = expandedId === msg.id
        const isPinned = msg.pinned === true
        return (
          <div key={msg.id}
            className={`bg-white rounded-xl border transition-colors ${
              isPinned ? 'border-amber-300 bg-amber-50/30' :
              msg.read ? 'border-surface-200' : 'border-brand-200 bg-brand-50/30'
            }`}>
            {/* Header */}
            <button onClick={() => {
              setExpandedId(isExpanded ? null : msg.id)
              if (!msg.read) markRead(msg)
            }}
              className="w-full px-4 py-3 flex items-center gap-3 text-left">
              {/* Unread dot or pin */}
              {isPinned ? (
                <Pin size={14} className="text-amber-500 flex-shrink-0" />
              ) : (
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-colors ${
                  msg.read ? 'bg-transparent' : 'bg-brand-500'
                }`} />
              )}

              <div className="flex-1 min-w-0">
                <span className={`text-sm block truncate ${
                  msg.read ? 'text-surface-700' : 'text-surface-900 font-semibold'
                }`}>
                  {msg.subject || '(No subject)'}
                </span>
                <span className="text-xs text-surface-400 mt-0.5 block">
                  From {msg.sender_name || msg.sender_email} · {formatDate(msg.created_at)}
                </span>
              </div>

              {isExpanded
                ? <ChevronUp size={14} className="text-surface-400 flex-shrink-0" />
                : <ChevronDown size={14} className="text-surface-400 flex-shrink-0" />}
            </button>

            {/* Body */}
            {isExpanded && (
              <div className="px-4 pb-4 pt-0 border-t border-surface-100">
                <div className="text-sm text-surface-700 whitespace-pre-wrap mt-3 leading-relaxed">
                  {msg.body}
                </div>
                <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
                  {msg.expires_at ? (
                    <div className="text-[10px] text-surface-400 flex items-center gap-1">
                      <Clock size={10} aria-hidden="true" /> Expires {new Date(msg.expires_at).toLocaleDateString()}
                    </div>
                  ) : <div />}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Reply button — only when user can compose AND there's a real
                        sender to reply to (skips system-generated rows like wo_assignment
                        which often have a generic sender_email or no reply context, and
                        skips hidden utility accounts that aren't valid recipients). */}
                    {canReply
                      && msg.sender_email
                      && msg.sender_email.toLowerCase() !== profile?.email?.toLowerCase()
                      && !isHiddenPickerEmail(msg.sender_email) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onReply && onReply(msg) }}
                        className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-brand-50 transition-colors font-medium"
                        aria-label={`Reply to ${msg.sender_name || msg.sender_email}`}>
                        <Send size={12} aria-hidden="true" /> Reply
                      </button>
                    )}
                    {/* Archive / Restore button (pinned messages cannot be archived) */}
                    {subTab === 'inbox' && !isPinned && (
                      <button onClick={(e) => { e.stopPropagation(); archiveMessage(msg) }}
                        className="text-xs text-surface-500 hover:text-surface-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-100 transition-colors">
                        <Archive size={12} aria-hidden="true" /> Archive
                      </button>
                    )}
                    {subTab === 'archived' && (
                      <button onClick={(e) => { e.stopPropagation(); restoreMessage(msg) }}
                        className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-brand-50 transition-colors">
                        <Undo2 size={12} aria-hidden="true" /> Restore
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSE MODAL  (Instructors)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSE MODAL  (All roles — but UX adapts to sender's role)
//
// Behavior:
//   • Instructors: full picker (any role), templates, save-as-template
//   • Students/Work Study: picker filtered to Active Instructors only,
//     no role bulk-selectors except "All Instructors", templates hidden,
//     save-as-template hidden, info banner shown
//   • Reply mode (replyTo set): pre-fills "Re: …" subject and pre-selects the
//     original sender as the only recipient. The sender is added to the picker
//     even if they would normally be filtered out (e.g., a student reply to an
//     instructor — the instructor is in the visible list anyway; an instructor
//     reply to a student — the student is added on the fly).
// ═══════════════════════════════════════════════════════════════════════════════

// Safely build a "Re: ..." subject without doubling the prefix on multi-hop replies
function buildReplySubject(originalSubject) {
  const s = (originalSubject || '').trim()
  if (!s) return 'Re: '
  if (/^re\s*:/i.test(s)) return s // already prefixed
  return `Re: ${s}`
}

function ComposeModal({ onClose, onSent, initialSubject, initialBody, isInstructor = true, canManageTemplates = true, replyTo = null }) {
  const { profile } = useAuth()
  const [users, setUsers] = useState([])
  const [templates, setTemplates] = useState([])
  const [subject, setSubject] = useState(
    replyTo ? buildReplySubject(replyTo.subject) : (initialSubject || '')
  )
  const [body, setBody] = useState(initialBody || '')
  const [expiresDate, setExpiresDate] = useState('')
  const [selectedEmails, setSelectedEmails] = useState(() => {
    // When replying, pre-select the original sender so the student/instructor
    // doesn't have to find them in the list — UNLESS the sender is a hidden
    // utility account, in which case we drop the pre-selection (and the user
    // loader below will also exclude them from the picker entirely).
    if (replyTo?.sender_email && !isHiddenPickerEmail(replyTo.sender_email)) {
      return { [replyTo.sender_email.toLowerCase()]: true }
    }
    return {}
  })
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')

  // Load users and templates
  useEffect(() => {
    const load = async () => {
      // Non-instructors don't load templates (they can't use them in this modal),
      // saves a round-trip and respects manage_templates permissions.
      const queries = [
        supabase.from('profiles').select('email, first_name, last_name, role, status, time_clock_only').order('first_name'),
      ]
      if (isInstructor) {
        queries.push(supabase.from('message_templates').select('*').order('template_name'))
      }
      const results = await Promise.all(queries)
      const uRes = results[0]
      const tRes = isInstructor ? results[1] : { data: [] }

      // Filter out archived/inactive, TCO users, and any utility/service
      // accounts (e.g. the super-admin account). The hidden-email check is
      // applied universally — instructors should never see the service account
      // in the picker either, per the "never shown in instructor-facing UI"
      // convention.
      let active = (uRes.data || []).filter(u =>
        u.status === 'Active' &&
        u.time_clock_only !== 'Yes' &&
        !isHiddenPickerEmail(u.email)
      )

      // Non-instructors can ONLY message instructors — privacy + scope.
      // We also include Super Admin profiles whose role is "Instructor" — the
      // utility super-admin account is never shown here per app convention
      // (filtered by status/time_clock_only at the profile level).
      if (!isInstructor) {
        active = active.filter(u => u.role === 'Instructor' || u.role === 'Super Admin')
      }

      // Reply mode: ensure the reply target is in the visible list even if it
      // would normally be filtered out (e.g., instructor replying to a student
      // when the modal happens to be a "to instructors only" mode — defensive).
      // Skip injection entirely if the original sender is a hidden utility
      // account — those must stay invisible regardless of context.
      if (replyTo?.sender_email && !isHiddenPickerEmail(replyTo.sender_email)) {
        const target = replyTo.sender_email.toLowerCase()
        const present = active.some(u => u.email?.toLowerCase() === target)
        if (!present) {
          // Synthesize a minimal entry so the checkbox renders. Pull display
          // info from the original message so the user sees a name, not just
          // an email. Role tag falls back to 'Recipient' if unknown.
          active = [{
            email: replyTo.sender_email,
            first_name: (replyTo.sender_name || '').split(' ')[0] || '',
            last_name: (replyTo.sender_name || '').split(' ').slice(1).join(' '),
            role: 'Recipient',
          }, ...active]
        }
      }

      setUsers(active)
      setTemplates(tRes.data || [])
    }
    load()
  }, [isInstructor, replyTo?.sender_email, replyTo?.sender_name])

  const filteredUsers = useMemo(() => {
    if (!search) return users
    const s = search.toLowerCase()
    return users.filter(u =>
      `${u.first_name} ${u.last_name}`.toLowerCase().includes(s) ||
      u.email?.toLowerCase().includes(s)
    )
  }, [users, search])

  const selectedCount = Object.keys(selectedEmails).length

  const toggleEmail = (email) => {
    setSelectedEmails(prev => {
      const next = { ...prev }
      if (next[email]) delete next[email]
      else next[email] = true
      return next
    })
  }

  const selectAll = () => {
    const all = {}
    filteredUsers.forEach(u => { all[u.email] = true })
    setSelectedEmails(all)
  }

  const selectByRole = (role) => {
    const emails = {}
    users.filter(u => u.role === role).forEach(u => { emails[u.email] = true })
    setSelectedEmails(prev => ({ ...prev, ...emails }))
  }

  const clearAll = () => setSelectedEmails({})

  const applyTemplate = (tpl) => {
    setSubject(tpl.subject || '')
    setBody(tpl.body || '')
  }

  const handleSaveTemplate = async () => {
    if (!templateName.trim() || !subject.trim()) {
      toast.error('Template name and subject are required')
      return
    }
    try {
      await supabase.from('message_templates').insert({
        template_name: templateName.trim(),
        subject: subject.trim(),
        body: body.trim(),
        created_by: `${profile.first_name} ${profile.last_name}`,
      })
      toast.success('Template saved!')
      setShowSaveTemplate(false)
      setTemplateName('')
    } catch {
      toast.error('Failed to save template')
    }
  }

  const handleSend = async () => {
    const emails = Object.keys(selectedEmails)
    if (emails.length === 0) return toast.error('Select at least one recipient')
    if (!subject.trim()) return toast.error('Subject is required')
    if (!body.trim()) return toast.error('Message body is required')

    setSending(true)
    try {
      const senderName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
      const now = new Date().toISOString()

      // Tag student/work-study sends so the instructor's NotificationBell can
      // render them with a distinct "STUDENT MESSAGE" label and color, and so
      // they're filterable later if we ever want analytics.
      // NOTE: leaving this null for instructor sends preserves existing push
      // routing in the send-push Edge Function (it routes 'announcement'/null
      // to the specific recipient; other types blast all instructors).
      const notification_type = isInstructor ? null : 'student_message'

      const rows = emails.map(email => ({
        recipient_email: email.toLowerCase(),
        sender_email: profile.email,
        sender_name: senderName,
        subject: subject.trim(),
        body: body.trim(),
        created_at: now,
        read: false,
        expires_at: expiresDate ? new Date(expiresDate).toISOString() : null,
        notification_type,
      }))

      const { data: insRows, error } = await supabase.from('announcements').insert(rows).select()
      if (error) throw error
      if (!insRows || insRows.length === 0) {
        toast.error('Send failed — you may not have permission to send announcements.')
        setSending(false)
        return
      }

      // Audit log
      try {
        const auditAction = replyTo ? 'Reply' : 'Create'
        const auditDetails = isInstructor
          ? `Sent to ${emails.length} recipient(s): ${subject.trim()}`
          : `Student message sent to ${emails.length} instructor(s): ${subject.trim()}`
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: senderName,
          action: auditAction,
          entity_type: 'Announcement',
          entity_id: subject.trim().slice(0, 50),
          details: auditDetails,
        })
      } catch {}

      toast.success(`Message sent to ${emails.length} recipient(s)!`)
      onSent()
    } catch (err) {
      console.error('Send error:', err)
      toast.error('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="compose-modal-title">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200">
          <h2 id="compose-modal-title" className="text-base font-bold text-surface-900 flex items-center gap-2">
            <Send size={18} className="text-brand-600" aria-hidden="true" />
            {replyTo
              ? `Reply to ${replyTo.sender_name || replyTo.sender_email}`
              : (isInstructor ? 'Compose Message' : 'Message Your Instructor')}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400"
            aria-label="Close compose dialog">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Policy disclaimer — non-instructors only.
              Amber tone differentiates it from the green "messaging instructors" banner:
              amber = "scope/policy reminder", green = "informational confirmation". */}
          {!isInstructor && (
            <div role="note"
              className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-900 flex items-start gap-2">
              <Info size={14} className="text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">{STUDENT_USAGE_NOTE.heading}</p>
                <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                  {STUDENT_USAGE_NOTE.body}
                </p>
              </div>
            </div>
          )}

          {/* Info banner for non-instructors */}
          {!isInstructor && (
            <div role="note"
              className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-xs text-emerald-800 flex items-start gap-2">
              <Mail size={14} className="text-emerald-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">Your message goes to your instructor(s) only.</p>
                <p className="text-[11px] text-emerald-700 mt-0.5">
                  They'll be notified by bell {replyTo ? '' : 'and push notification '}as soon as you send. Pick one or
                  use "All Instructors" to message everyone.
                </p>
              </div>
            </div>
          )}

          {/* Template selector — instructors only */}
          {isInstructor && templates.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
                Load Template
              </label>
              <div className="flex flex-wrap gap-1.5">
                {templates.map(t => (
                  <button key={t.id} onClick={() => applyTemplate(t)}
                    className="px-2.5 py-1 rounded-lg bg-surface-100 text-xs text-surface-700 hover:bg-brand-50 hover:text-brand-700 transition-colors">
                    <FileText size={11} className="inline mr-1" aria-hidden="true" />{t.template_name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Subject */}
          <div>
            <label htmlFor="compose-subject" className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">Subject *</label>
            <input id="compose-subject" type="text" value={subject} onChange={e => setSubject(e.target.value)}
              placeholder="Message subject…" className="input text-sm" />
          </div>

          {/* Body */}
          <div>
            <label htmlFor="compose-body" className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">Message *</label>
            <textarea id="compose-body" value={body} onChange={e => setBody(e.target.value)}
              placeholder="Type your message…" rows={5}
              className="input text-sm resize-y min-h-[100px]" />
          </div>

          {/* Expires — instructors only (broadcast lifecycle); not relevant for student→instructor messages */}
          {isInstructor && (
            <div>
              <label htmlFor="compose-expires" className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
                Expires (optional)
              </label>
              <input id="compose-expires" type="date" value={expiresDate} onChange={e => setExpiresDate(e.target.value)}
                className="input text-sm w-48" />
            </div>
          )}

          {/* Recipients */}
          <div>
            <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
              {isInstructor ? 'Recipients' : 'Send to (Instructors)'} * <span className="text-surface-400 normal-case">({selectedCount} selected)</span>
            </label>

            {/* Quick select buttons — role-aware. Non-instructors only see
                "All Instructors" / "Clear All" since their picker is already
                limited to instructors. */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {isInstructor ? (
                <>
                  <button onClick={selectAll}
                    className="px-2 py-0.5 rounded bg-surface-100 text-[10px] font-medium text-surface-600 hover:bg-surface-200">
                    Select All
                  </button>
                  <button onClick={() => selectByRole('Student')}
                    className="px-2 py-0.5 rounded bg-blue-50 text-[10px] font-medium text-blue-700 hover:bg-blue-100">
                    All Students
                  </button>
                  <button onClick={() => selectByRole('Work Study')}
                    className="px-2 py-0.5 rounded bg-emerald-50 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100">
                    All Work Study
                  </button>
                  <button onClick={() => selectByRole('Instructor')}
                    className="px-2 py-0.5 rounded bg-purple-50 text-[10px] font-medium text-purple-700 hover:bg-purple-100">
                    All Instructors
                  </button>
                </>
              ) : (
                <button onClick={selectAll}
                  className="px-2 py-0.5 rounded bg-purple-50 text-[10px] font-medium text-purple-700 hover:bg-purple-100">
                  All Instructors
                </button>
              )}
              {selectedCount > 0 && (
                <button onClick={clearAll}
                  className="px-2 py-0.5 rounded bg-red-50 text-[10px] font-medium text-red-600 hover:bg-red-100">
                  Clear All
                </button>
              )}
            </div>

            {/* Search */}
            <div className="relative mb-2">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search users…" className="input pl-8 text-xs py-1.5" />
            </div>

            {/* User checklist */}
            <div className="border border-surface-200 rounded-xl max-h-48 overflow-y-auto divide-y divide-surface-100"
              role="group" aria-label={isInstructor ? 'Recipient list' : 'Instructor list'}>
              {filteredUsers.map(u => {
                const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email
                const isChecked = !!selectedEmails[u.email]
                // Treat Super Admin as Instructor visually so the utility super-admin
                // (if it ever shows up) doesn't get a generic blue tag.
                const displayRole = u.role === 'Super Admin' ? 'Instructor' : u.role
                const tagClass =
                  displayRole === 'Instructor' ? 'bg-purple-100 text-purple-700' :
                  displayRole === 'Work Study' ? 'bg-emerald-100 text-emerald-700' :
                  displayRole === 'Recipient'  ? 'bg-surface-100 text-surface-700' :
                  'bg-blue-100 text-blue-700'
                return (
                  <label key={u.email}
                    className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-surface-50 transition-colors ${
                      isChecked ? 'bg-brand-50/40' : ''
                    }`}>
                    <input type="checkbox" checked={isChecked}
                      onChange={() => toggleEmail(u.email)}
                      aria-label={`Send to ${name}`}
                      className="rounded border-surface-300 text-brand-600 focus:ring-brand-500" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-surface-800">{name}</span>
                      <span className="text-[10px] text-surface-400 ml-2">{u.email}</span>
                    </div>
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${tagClass}`}>{displayRole}</span>
                  </label>
                )
              })}
              {filteredUsers.length === 0 && (
                <div className="text-center py-6 text-xs text-surface-400">
                  {isInstructor ? 'No users found' : 'No instructors available'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-200 flex items-center gap-2 flex-wrap">
          {/* Save as template — only for instructors who can manage templates */}
          {isInstructor && canManageTemplates && showSaveTemplate ? (
            <div className="flex items-center gap-2 flex-1">
              <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)}
                placeholder="Template name…" className="input text-xs py-1.5 flex-1" autoFocus
                aria-label="Template name" />
              <button onClick={handleSaveTemplate}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700">
                <Save size={11} className="inline mr-1" aria-hidden="true" /> Save
              </button>
              <button onClick={() => setShowSaveTemplate(false)}
                className="px-2 py-1.5 rounded-lg bg-surface-100 text-xs text-surface-600">
                Cancel
              </button>
            </div>
          ) : (
            <>
              {isInstructor && canManageTemplates && (
                <button onClick={() => setShowSaveTemplate(true)}
                  className="px-3 py-1.5 rounded-lg bg-surface-100 text-xs text-surface-600 hover:bg-surface-200 flex items-center gap-1">
                  <FileText size={12} aria-hidden="true" /> Save as Template
                </button>
              )}
              <div className="flex-1" />
            </>
          )}

          <button onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-surface-100 text-xs font-medium text-surface-600 hover:bg-surface-200">
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending || selectedCount === 0}
            className="px-4 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5 shadow-sm">
            {sending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
            Send to {selectedCount} Recipient{selectedCount !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENT HISTORY TAB
//   viewMode='all' → instructor's full broadcast history (existing behavior)
//   viewMode='own' → student/work-study sees only messages they sent
// ═══════════════════════════════════════════════════════════════════════════════

function SentHistoryTab({ refreshKey, viewMode = 'all' }) {
  const { profile } = useAuth()
  const [announcements, setAnnouncements] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [processing, setProcessing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const ownOnly = viewMode === 'own'
  const myEmail = profile?.email?.toLowerCase()

  // Instructor toggle: include system audit rows (WO assignments, etc.) in
  // the Sent Messages list? Default: hide. Persists per-browser via
  // localStorage. Students/work-study never see this toggle — their view is
  // already strictly filtered to their own composed messages.
  const [showSystemRows, setShowSystemRows] = useState(() => {
    try {
      return localStorage.getItem(SENT_SHOW_SYSTEM_KEY) === 'true'
    } catch {
      return false
    }
  })
  // Track how many rows were hidden so we can reflect that in the toggle
  // label — instructors see "Show 3 audit rows" instead of an unqualified
  // "Show audit rows" when there's actually something to surface.
  const [hiddenCount, setHiddenCount] = useState(0)

  useEffect(() => {
    try {
      localStorage.setItem(SENT_SHOW_SYSTEM_KEY, showSystemRows ? 'true' : 'false')
    } catch {}
  }, [showSystemRows])

  const loadHistory = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      let query = supabase
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false })

      // Non-instructor view ('My Sent'): show only messages the user
      // deliberately composed via the new messaging feature, not system-
      // generated audit rows like WO assignments — those get sender_email =
      // the actor's email (e.g. a student who self-assigns to a WO), but
      // semantically the student didn't "send a message," they clicked a
      // button. Allow-list filter (notification_type='student_message') keeps
      // future system types out automatically without maintenance.
      if (ownOnly && myEmail) {
        query = query
          .eq('sender_email', myEmail)
          .eq('notification_type', 'student_message')
      }

      const { data, error } = await query

      if (error) throw error

      // Name lookup
      const { data: profiles } = await supabase
        .from('profiles')
        .select('email, first_name, last_name')
      const nameMap = {}
      ;(profiles || []).forEach(p => {
        nameMap[p.email?.toLowerCase()] = `${p.first_name || ''} ${p.last_name || ''}`.trim()
      })

      // Group by message batch: same subject + sender + created within same minute
      const grouped = {}
      const order = []
      let hidden = 0  // count rows skipped by the "hide audit" toggle

      ;(data || []).forEach(row => {
        // Instructor toggle: drop system audit rows when "Show audit rows" is
        // off. Students never reach this branch — their query layer already
        // restricted to notification_type='student_message'.
        // The toggle is irrelevant in 'own' mode, but checking ownOnly here
        // keeps the code explicit and self-documenting.
        if (!ownOnly && !showSystemRows && isSystemNotificationType(row.notification_type)) {
          hidden++
          return
        }

        const ts = new Date(row.created_at)
        const groupKey = [
          row.subject, row.sender_email,
          ts.getFullYear(), ts.getMonth(), ts.getDate(), ts.getHours(), ts.getMinutes()
        ].join('|')

        if (!grouped[groupKey]) {
          grouped[groupKey] = {
            id: groupKey,
            subject: row.subject,
            body: row.body,
            sender_name: row.sender_name || row.sender_email,
            sender_email: row.sender_email,
            created_at: row.created_at,
            expires_at: row.expires_at,
            recipients: [],
            totalRecipients: 0,
            readCount: 0,
            rowIds: [],
          }
          order.push(groupKey)
        }

        const g = grouped[groupKey]
        g.recipients.push({
          email: row.recipient_email,
          name: nameMap[row.recipient_email?.toLowerCase()] || row.recipient_email,
          read: row.read === true,
          id: row.id,
        })
        g.totalRecipients++
        if (row.read) g.readCount++
        g.rowIds.push(row.id)
      })

      setAnnouncements(order.map(k => grouped[k]))
      setHiddenCount(hidden)
    } catch (err) {
      console.error('Error loading history:', err)
      if (!silent) toast.error('Failed to load sent messages')
    } finally {
      setLoading(false)
    }
  }, [ownOnly, myEmail, showSystemRows])

  useEffect(() => { loadHistory() }, [loadHistory, refreshKey])

  // Realtime: auto-refresh when any announcement changes (read status, new, deleted).
  // Channel name carries a random suffix to prevent conflicts when multiple components
  // mount simultaneously (per project convention, e.g. inbox-realtime is also unique-per-mount).
  useEffect(() => {
    const channelName = `sent-realtime-${ownOnly ? 'own' : 'all'}-${Math.random().toString(36).slice(2, 9)}`
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'announcements' },
        () => { loadHistory(true) }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadHistory, ownOnly])

  const filtered = useMemo(() => {
    if (!search) return announcements
    const s = search.toLowerCase()
    return announcements.filter(a =>
      a.subject?.toLowerCase().includes(s) ||
      a.sender_name?.toLowerCase().includes(s) ||
      a.recipients.some(r => r.name?.toLowerCase().includes(s) || r.email?.toLowerCase().includes(s))
    )
  }, [announcements, search])

  const handleDelete = (ann) => {
    setConfirmDelete(ann)
  }

  const confirmDeleteAction = async () => {
    const ann = confirmDelete
    if (!ann) return
    setConfirmDelete(null)
    setProcessing(ann.id)
    try {
      const { data: delRows, error } = await supabase.from('announcements').delete().in('id', ann.rowIds).select()
      if (error) throw error
      if (!delRows || delRows.length === 0) {
        toast.error('Delete failed — you may not have permission to delete announcements.')
        setProcessing(null)
        return
      }
      toast.success(`Deleted (${ann.totalRecipients} recipients removed)`)

      // Audit
      try {
        const senderName = `${profile.first_name} ${(profile.last_name || '').charAt(0)}.`
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: senderName,
          action: 'Delete',
          entity_type: 'Announcement',
          entity_id: ann.subject?.slice(0, 50) || '',
          details: `Deleted (${ann.totalRecipients} rows)`,
        })
      } catch {}

      loadHistory()
    } catch {
      toast.error('Failed to delete')
    } finally {
      setProcessing(null)
    }
  }

  const handleResend = async (ann, mode) => {
    const emails = mode === 'unread'
      ? ann.recipients.filter(r => !r.read).map(r => r.email)
      : ann.recipients.map(r => r.email)

    if (emails.length === 0) {
      toast.error(mode === 'unread' ? 'All recipients have already read this message' : 'No recipients found')
      return
    }

    setProcessing(ann.id)
    try {
      const senderName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
      const now = new Date().toISOString()
      const rows = emails.map(email => ({
        recipient_email: email,
        sender_email: ann.sender_email,
        sender_name: senderName,
        subject: ann.subject,
        body: ann.body,
        created_at: now,
        read: false,
      }))

      const { error } = assertWrite(
      await supabase.from('announcements').insert(rows).select(),
      'announcements.insert'
    )
      if (error) throw error
      toast.success(`Resent to ${emails.length} recipient(s)`)
      loadHistory()
    } catch {
      toast.error('Failed to resend')
    } finally {
      setProcessing(null)
    }
  }

  // Stats
  const totalSent = announcements.length
  const totalRead = announcements.reduce((s, a) => s + a.readCount, 0)
  const totalUnread = announcements.reduce((s, a) => s + (a.totalRecipients - a.readCount), 0)

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading sent messages…</p>
      </div>
    )
  }

  return (
    <>
    <div className="space-y-3">
      {/* Search + Toggle + Refresh */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search messages…" className="input pl-9 text-sm"
            aria-label="Search sent messages" />
        </div>

        {/* Audit-row toggle — instructor view only.
            ON  = show all rows including system audit notifications (WO assignments, etc.)
            OFF = hide audit rows, show only human-composed messages (default).
            Choice persists per-browser via localStorage. */}
        {!ownOnly && (
          <button
            onClick={() => setShowSystemRows(v => !v)}
            title={showSystemRows
              ? 'Hide system-generated rows (WO assignments, etc.)'
              : 'Show system-generated rows (WO assignments, etc.)'}
            aria-pressed={showSystemRows}
            aria-label={showSystemRows
              ? 'Hide system audit rows'
              : `Show system audit rows${hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}`}
            className={`px-2.5 py-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
              showSystemRows
                ? 'bg-brand-100 text-brand-700 hover:bg-brand-200'
                : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
            }`}>
            {showSystemRows
              ? <EyeOff size={13} aria-hidden="true" />
              : <Eye size={13} aria-hidden="true" />}
            <span className="hidden sm:inline">
              {showSystemRows ? 'Hide audit' : 'Show audit'}
            </span>
            {!showSystemRows && hiddenCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] px-1 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold leading-none"
                aria-hidden="true">
                {hiddenCount}
              </span>
            )}
          </button>
        )}

        <button onClick={loadHistory} title="Refresh"
          aria-label="Refresh sent messages"
          className="p-2.5 rounded-lg bg-surface-100 hover:bg-surface-200 text-surface-500">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Messages Sent" value={totalSent} color="text-surface-900" />
        <StatCard label="Read" value={totalRead} color="text-emerald-600" />
        <StatCard label="Unread" value={totalUnread} color="text-amber-600" />
      </div>

      {/* Messages list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <Send size={32} className="mx-auto mb-2 text-surface-300" aria-hidden="true" />
          <p className="text-sm text-surface-500">
            {search ? 'No matching messages' : (ownOnly ? "You haven't sent any messages yet" : 'No messages sent yet')}
          </p>
          <p className="text-xs text-surface-400 mt-1">
            {ownOnly ? 'Click "Message Instructor" to send your first message' : 'Click "New Message" to compose and send'}
          </p>
        </div>
      ) : (
        filtered.map(ann => {
          const isExpanded = expandedId === ann.id
          const readPct = ann.totalRecipients > 0 ? Math.round((ann.readCount / ann.totalRecipients) * 100) : 0
          const isProcessing = processing === ann.id

          return (
            <div key={ann.id} className="bg-white rounded-xl border border-surface-200 overflow-hidden">
              {/* Header row */}
              <button onClick={() => setExpandedId(isExpanded ? null : ann.id)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-50 transition-colors">
                <div className="w-9 h-9 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0">
                  <Send size={16} className="text-brand-600" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-surface-900 truncate">
                    {ann.subject || '(No subject)'}
                  </div>
                  <div className="text-xs text-surface-400 mt-0.5">
                    {ann.sender_name} · {formatDate(ann.created_at)}
                  </div>
                </div>

                {/* Read progress */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="text-right">
                    <div className="text-xs font-medium text-surface-700">
                      {ann.readCount}/{ann.totalRecipients}
                    </div>
                    <div className="w-16 h-1.5 rounded-full bg-surface-200 mt-0.5">
                      <div className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{ width: `${readPct}%` }} />
                    </div>
                  </div>
                  {isExpanded
                    ? <ChevronUp size={14} className="text-surface-400" />
                    : <ChevronDown size={14} className="text-surface-400" />}
                </div>
              </button>

              {/* Expanded details */}
              {isExpanded && (
                <div className="border-t border-surface-100">
                  {/* Message body */}
                  <div className="px-4 py-3 bg-surface-50">
                    <div className="text-sm text-surface-700 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                      {ann.body}
                    </div>
                    {ann.expires_at && (
                      <div className="text-[10px] text-surface-400 mt-2 flex items-center gap-1">
                        <Clock size={10} /> Expires {new Date(ann.expires_at).toLocaleDateString()}
                      </div>
                    )}
                  </div>

                  {/* Recipients */}
                  <div className="px-4 py-3">
                    <div className="text-xs font-semibold text-surface-600 mb-2 flex items-center gap-1">
                      <Users size={12} /> Recipients ({ann.totalRecipients})
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {ann.recipients.map((r, idx) => (
                        <span key={idx}
                          className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            r.read ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                          }`}>
                          {r.read ? <MailOpen size={9} /> : <Mail size={9} />}
                          {r.name || r.email}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Actions — instructors get Resend; students only get Delete on
                      their own messages (so they can retract a typo, but can't
                      blast an instructor with repeated copies) */}
                  <div className="px-4 py-2.5 bg-surface-50 border-t border-surface-100 flex flex-wrap gap-2">
                    {!ownOnly && (
                      <>
                        <button onClick={() => handleResend(ann, 'all')} disabled={isProcessing}
                          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1">
                          {isProcessing ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={11} aria-hidden="true" />}
                          Resend to All
                        </button>
                        {ann.readCount < ann.totalRecipients && (
                          <button onClick={() => handleResend(ann, 'unread')} disabled={isProcessing}
                            className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 disabled:opacity-50 flex items-center gap-1">
                            <RotateCcw size={11} aria-hidden="true" /> Resend to Unread ({ann.totalRecipients - ann.readCount})
                          </button>
                        )}
                      </>
                    )}
                    <div className="flex-1" />
                    <button onClick={() => handleDelete(ann)} disabled={isProcessing}
                      className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 disabled:opacity-50 flex items-center gap-1"
                      aria-label={`Delete message: ${ann.subject || 'no subject'}`}>
                      <Trash2 size={11} aria-hidden="true" /> Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
    {confirmDelete && (
      <ConfirmModal
        open={true}
        title={`Delete "${confirmDelete.subject}"?`}
        message={`This removes it from all ${confirmDelete.totalRecipients} recipient(s). This action cannot be undone.`}
        confirmLabel="Delete"
        confirmColor="red"
        onConfirm={confirmDeleteAction}
        onCancel={() => setConfirmDelete(null)}
      />
    )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATES TAB  (Instructors)
// ═══════════════════════════════════════════════════════════════════════════════

function TemplatesTab() {
  const { profile } = useAuth()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ template_name: '', subject: '', body: '' })
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const loadTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('message_templates')
        .select('*')
        .order('template_name')
      if (error) throw error
      setTemplates(data || [])
    } catch {
      toast.error('Failed to load templates')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadTemplates() }, [loadTemplates])

  const startNew = () => {
    setEditingId('new')
    setForm({ template_name: '', subject: '', body: '' })
  }

  const startEdit = (tpl) => {
    setEditingId(tpl.id)
    setForm({
      template_name: tpl.template_name || '',
      subject: tpl.subject || '',
      body: tpl.body || '',
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setForm({ template_name: '', subject: '', body: '' })
  }

  const handleSave = async () => {
    if (!form.template_name.trim()) return toast.error('Template name is required')
    if (!form.subject.trim()) return toast.error('Subject is required')

    setSaving(true)
    try {
      if (editingId === 'new') {
        const { data: tplRows, error } = await supabase.from('message_templates').insert({
          template_name: form.template_name.trim(),
          subject: form.subject.trim(),
          body: (form.body || '').trim(),
          created_by: `${profile.first_name} ${profile.last_name}`,
        }).select()
        if (error) throw error
        if (!tplRows || tplRows.length === 0) {
          toast.error('Create failed — you may not have permission.')
          setSaving(false)
          return
        }
        toast.success('Template created!')
      } else {
        const { data: tplRows, error } = await supabase.from('message_templates').update({
          template_name: form.template_name.trim(),
          subject: form.subject.trim(),
          body: (form.body || '').trim(),
        }).eq('id', editingId).select()
        if (error) throw error
        if (!tplRows || tplRows.length === 0) {
          toast.error('Update failed — you may not have permission.')
          setSaving(false)
          return
        }
        toast.success('Template updated!')
      }
      cancelEdit()
      loadTemplates()
    } catch {
      toast.error('Failed to save template')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (tpl) => {
    setConfirmDelete(tpl)
  }

  const confirmDeleteAction = async () => {
    const tpl = confirmDelete
    if (!tpl) return
    setConfirmDelete(null)
    try {
      await supabase.from('message_templates').delete().eq('id', tpl.id)
      toast.success('Template deleted')
      loadTemplates()
    } catch {
      toast.error('Failed to delete')
    }
  }

  if (loading) {
    return (
      <div className="text-center py-16">
        <Loader2 size={24} className="mx-auto mb-2 text-brand-400 animate-spin" />
        <p className="text-sm text-surface-400">Loading templates…</p>
      </div>
    )
  }

  return (
    <>
    <div className="space-y-3">
      {/* Add button */}
      {editingId !== 'new' && (
        <button onClick={startNew}
          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 flex items-center gap-1.5 shadow-sm">
          <Plus size={14} /> New Template
        </button>
      )}

      {/* Edit / Create form */}
      {editingId && (
        <div className="bg-white rounded-xl border border-brand-200 p-4 space-y-3">
          <h3 className="text-sm font-bold text-surface-900">
            {editingId === 'new' ? 'New Template' : 'Edit Template'}
          </h3>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Name *</label>
            <input type="text" value={form.template_name}
              onChange={e => setForm(f => ({ ...f, template_name: e.target.value }))}
              placeholder="e.g. Lab Reminder" className="input text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Subject *</label>
            <input type="text" value={form.subject}
              onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              placeholder="Email subject…" className="input text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-surface-500 mb-1 block">Body</label>
            <textarea value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              placeholder="Message body…" rows={4}
              className="input text-sm resize-y" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {editingId === 'new' ? 'Create' : 'Save Changes'}
            </button>
            <button onClick={cancelEdit}
              className="px-3 py-1.5 rounded-lg bg-surface-100 text-xs font-medium text-surface-600 hover:bg-surface-200">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && !editingId ? (
        <div className="text-center py-12">
          <FileText size={32} className="mx-auto mb-2 text-surface-300" />
          <p className="text-sm text-surface-500">No templates yet</p>
          <p className="text-xs text-surface-400 mt-1">Create templates for frequently sent messages</p>
        </div>
      ) : (
        templates.map(tpl => (
          <div key={tpl.id}
            className={`bg-white rounded-xl border border-surface-200 p-4 ${
              editingId === tpl.id ? 'hidden' : ''
            }`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-surface-900">{tpl.template_name}</div>
                <div className="text-xs text-surface-500 mt-0.5">
                  Subject: <span className="text-surface-700">{tpl.subject}</span>
                </div>
                {tpl.body && (
                  <div className="text-xs text-surface-400 mt-1 line-clamp-2">{tpl.body}</div>
                )}
                <div className="text-[10px] text-surface-400 mt-2">
                  Created by {tpl.created_by || 'Unknown'} · {tpl.created_at ? formatDate(tpl.created_at) : ''}
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => startEdit(tpl)} title="Edit"
                  className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-brand-600">
                  <Edit3 size={13} />
                </button>
                <button onClick={() => handleDelete(tpl)} title="Delete"
                  className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-600">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
    {confirmDelete && (
      <ConfirmModal
        open={true}
        title={`Delete "${confirmDelete.template_name}"?`}
        message="This template will be permanently removed."
        confirmLabel="Delete"
        confirmColor="red"
        onConfirm={confirmDeleteAction}
        onCancel={() => setConfirmDelete(null)}
      />
    )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-xl border border-surface-200 p-3 text-center">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-surface-500 uppercase tracking-wide">{label}</div>
    </div>
  )
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// TV SLIDES TAB  (Instructors — permission: manage_tv_slides)
// Manages the tv_slides table shown in the TV Display left-panel rotation.
// Panel 1 on the TV is always Open Work Orders; these slides follow in order.
// ═══════════════════════════════════════════════════════════════════════════════

const SLIDE_PREFIX = 'SLD'
const SLIDE_PAD = 4

// Collision-safe slide ID: get_next_id RPC first, MAX+1 fallback with
// counter write-back (standard CMMS ID pattern).
async function generateSlideId() {
  let id = null
  let numericId = NaN
  try {
    const { data: counter } = await supabase.rpc('get_next_id', { p_type: 'tv_slide' })
    if (counter) { id = counter; numericId = parseInt(String(counter).replace(/\D/g, ''), 10) }
  } catch { /* fall through to fallback */ }

  if (!id || !Number.isFinite(numericId)) {
    const { data: rows } = await supabase.from('tv_slides').select('slide_id').like('slide_id', `${SLIDE_PREFIX}%`)
    let maxNum = 0
    for (const r of rows || []) {
      const n = parseInt(String(r.slide_id || '').replace(/\D/g, ''), 10)
      if (Number.isFinite(n) && n > maxNum) maxNum = n
    }
    numericId = Math.max(maxNum, 1000) + 1
    id = SLIDE_PREFIX + String(numericId).padStart(SLIDE_PAD, '0')
    // Write the corrected value back so the counter recovers from drift
    try {
      await supabase.from('counters')
        .update({ current_value: numericId, updated_at: new Date().toISOString() })
        .eq('counter_name', 'tv_slide')
    } catch { /* non-fatal */ }
  }
  return id
}

function TVSlidesTab() {
  const { profile } = useAuth()
  const [slides, setSlides] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)      // null | {} (new) | slide row
  const [deleting, setDeleting] = useState(null)    // slide row pending delete confirm
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('tv_slides')
      .select('*')
      .order('display_order', { ascending: true })
      .order('slide_id', { ascending: true })
    if (!error) setSlides(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime — unique channel per mount
  useEffect(() => {
    const channel = supabase
      .channel(`tv-slides-tab-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tv_slides' }, () => { load() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const audit = async (action, slideId, details) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: profile?.email || '',
        user_name: profile ? `${profile.first_name} ${profile.last_name}` : '',
        action,
        entity_type: 'TV Slide',
        entity_id: slideId,
        details,
      })
    } catch { /* non-fatal */ }
  }

  const toggleStatus = async (sl) => {
    const next = sl.status === 'active' ? 'inactive' : 'active'
    const { data: rows, error } = await supabase.from('tv_slides')
      .update({ status: next, updated_at: new Date().toISOString(), updated_by: profile?.email || '' })
      .eq('slide_id', sl.slide_id)
      .select()
    if (error || !rows || rows.length === 0) {
      toast.error('Update failed — you may not have permission.')
      return
    }
    audit(next === 'active' ? 'Activated TV slide' : 'Deactivated TV slide', sl.slide_id, sl.title)
    load()
  }

  // Swap display_order with the neighbor above/below
  const move = async (idx, dir) => {
    const a = slides[idx]
    const b = slides[idx + dir]
    if (!a || !b) return
    // Ensure distinct order values even if both defaulted to 0
    const aOrder = b.display_order === a.display_order ? a.display_order + dir : b.display_order
    const bOrder = a.display_order
    const now = new Date().toISOString()
    const [r1, r2] = await Promise.all([
      supabase.from('tv_slides').update({ display_order: aOrder, updated_at: now, updated_by: profile?.email || '' }).eq('slide_id', a.slide_id).select(),
      supabase.from('tv_slides').update({ display_order: bOrder, updated_at: now, updated_by: profile?.email || '' }).eq('slide_id', b.slide_id).select(),
    ])
    if (r1.error || r2.error || !r1.data?.length || !r2.data?.length) {
      toast.error('Reorder failed — you may not have permission.')
    }
    load()
  }

  const confirmDelete = async () => {
    const sl = deleting
    if (!sl) return
    setBusy(true)
    const { data: rows, error } = await supabase.from('tv_slides')
      .delete().eq('slide_id', sl.slide_id).select()
    if (error || !rows || rows.length === 0) {
      toast.error('Delete failed — you may not have permission.')
      setBusy(false)
      return
    }
    // Best-effort cleanup of the stored image
    if (sl.image_url && sl.image_url.includes('/tv-slides/')) {
      try {
        const path = sl.image_url.split('/tv-slides/')[1]
        if (path) await supabase.storage.from('tv-slides').remove([decodeURIComponent(path)])
      } catch { /* non-fatal */ }
    }
    audit('Deleted TV slide', sl.slide_id, sl.title)
    toast.success('Slide deleted')
    setDeleting(null)
    setBusy(false)
    load()
  }

  const fmtDateRange = (sl) => {
    if (!sl.start_date && !sl.end_date) return null
    const f = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\u2026'
    return `${f(sl.start_date)} \u2013 ${f(sl.end_date)}`
  }

  const todayStr = (() => {
    const t = new Date()
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
  })()
  const isLive = (sl) => sl.status === 'active' &&
    (!sl.start_date || sl.start_date <= todayStr) &&
    (!sl.end_date || sl.end_date >= todayStr)

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-surface-500">
          Slides rotate on the TV display after the Open Work Orders panel, in the order below.
          Scheduled slides only show within their date window.
        </p>
        <button onClick={() => setEditing({})}
          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 flex items-center gap-1.5 shadow-sm shrink-0"
          aria-label="Add new TV slide">
          <Plus size={14} aria-hidden="true" /> New Slide
        </button>
      </div>

      {/* Slide list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-surface-400 text-sm gap-2">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading…
        </div>
      ) : slides.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-surface-200">
          <MonitorPlay size={32} className="mx-auto text-surface-300 mb-2" aria-hidden="true" />
          <p className="text-sm text-surface-500">No slides yet — the TV shows only Open Work Orders.</p>
          <p className="text-xs text-surface-400 mt-1">Add a slide for lunch menus, job postings, or announcements.</p>
        </div>
      ) : (
        <ul className="space-y-2" aria-label="TV slides in rotation order">
          {slides.map((sl, idx) => (
            <li key={sl.slide_id}
              className={`bg-white rounded-xl border p-3 flex items-center gap-3 ${isLive(sl) ? 'border-surface-200' : 'border-surface-200 opacity-60'}`}>
              {/* Reorder */}
              <div className="flex flex-col gap-0.5 shrink-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0}
                  aria-label={`Move slide "${sl.title || sl.slide_id}" up`}
                  className="p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-surface-600 disabled:opacity-30 disabled:cursor-not-allowed">
                  <ArrowUp size={13} aria-hidden="true" />
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === slides.length - 1}
                  aria-label={`Move slide "${sl.title || sl.slide_id}" down`}
                  className="p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-surface-600 disabled:opacity-30 disabled:cursor-not-allowed">
                  <ArrowDown size={13} aria-hidden="true" />
                </button>
              </div>

              {/* Thumb */}
              <div className="w-16 h-10 rounded-lg bg-surface-900 flex items-center justify-center overflow-hidden shrink-0">
                {sl.image_url
                  ? <img src={sl.image_url} alt="" className="w-full h-full object-cover" />
                  : <ImageIcon size={16} className="text-surface-600" aria-hidden="true" />}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-surface-900 truncate">{sl.title || '(untitled image slide)'}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500 shrink-0">
                    {sl.layout === 'image_full' ? 'Full image' : 'Standard'}
                  </span>
                  {sl.duration_seconds && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 shrink-0">{sl.duration_seconds}s</span>
                  )}
                  {sl.text_size && sl.text_size !== 'auto' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 shrink-0 capitalize">Aa {sl.text_size}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-surface-400">
                  <span>{sl.slide_id}</span>
                  {fmtDateRange(sl) && (
                    <span className="flex items-center gap-1"><CalendarDays size={11} aria-hidden="true" />{fmtDateRange(sl)}</span>
                  )}
                  {sl.status === 'active' && !isLive(sl) && (
                    <span className="text-amber-500">outside date window</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => toggleStatus(sl)}
                  role="switch" aria-checked={sl.status === 'active'}
                  aria-label={`Slide "${sl.title || sl.slide_id}" active`}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                    sl.status === 'active' ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-surface-100 text-surface-400 hover:bg-surface-200'
                  }`}>
                  {sl.status === 'active' ? 'Active' : 'Inactive'}
                </button>
                <button onClick={() => setEditing(sl)}
                  aria-label={`Edit slide "${sl.title || sl.slide_id}"`}
                  className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 hover:text-surface-600 transition-colors">
                  <Edit3 size={14} aria-hidden="true" />
                </button>
                <button onClick={() => setDeleting(sl)}
                  aria-label={`Delete slide "${sl.title || sl.slide_id}"`}
                  className="p-1.5 rounded-lg hover:bg-red-50 text-surface-400 hover:text-red-500 transition-colors">
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Edit / New modal */}
      {editing !== null && (
        <SlideEditModal
          slide={editing.slide_id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
          audit={audit}
        />
      )}

      {/* Delete confirm */}
      {deleting && (
        <SlideDeleteConfirm
          slide={deleting}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  )
}

// ─── Slide preview body ───────────────────────────────────────────────────────
// Mirrors the TV's auto-fit algorithm at preview scale so the preview is a
// faithful (proportional) picture of what the TV will render. Presets are the
// TV pixel sizes scaled by previewWidth / TV text-area width.
const PREVIEW_TEXT_PRESETS = { small: 24, medium: 34, large: 46 }
const PREVIEW_TV_BODY_W = 694   // approx TV slide text-area width in px (1280x720 layout)

function SlidePreviewBody({ body, textSize }) {
  const ref = useRef(null)
  const [fontPx, setFontPx] = useState(10)

  useEffect(() => {
    function fit() {
      const el = ref.current
      if (!el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w <= 0 || h <= 0) return
      const scale = w / PREVIEW_TV_BODY_W
      const preset = PREVIEW_TEXT_PRESETS[textSize]
      if (preset) { setFontPx(Math.max(6, Math.round(preset * scale))); return }
      // Auto: same search the TV runs (22–64px), at preview scale
      const lines = (body || '').split('\n').map(l => l.trim())
      if (lines.filter(Boolean).length === 0) { setFontPx(Math.max(8, Math.round(28 * scale))); return }
      const minPx = Math.max(6, Math.round(22 * scale))
      const maxPx = Math.max(minPx + 1, Math.round(64 * scale))
      let chosen = minPx
      for (let f = maxPx; f > minPx; f -= 1) {
        let total = 0
        for (const line of lines) {
          if (!line) { total += f * 0.5; continue }
          const wrapped = Math.max(1, Math.ceil((line.length * 0.54 * f) / w))
          total += wrapped * f * 1.4 + f * 0.35
        }
        if (total <= h) { chosen = f; break }
      }
      setFontPx(chosen)
    }
    fit()
    let ro = null
    if (typeof ResizeObserver !== 'undefined' && ref.current) {
      ro = new ResizeObserver(fit)
      ro.observe(ref.current)
    } else {
      window.addEventListener('resize', fit)
    }
    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', fit)
    }
  }, [body, textSize])

  const lines = (body || 'Body text appears here\u2026').split('\n')
  return (
    <div ref={ref} className="flex-1 min-w-0 overflow-hidden flex flex-col justify-center">
      {lines.map((line, li) =>
        line.trim()
          ? <p key={li} className="text-slate-200" style={{ fontSize: fontPx, lineHeight: 1.4, margin: `0 0 ${Math.round(fontPx * 0.35)}px 0` }}>{line}</p>
          : <div key={li} style={{ height: Math.round(fontPx * 0.5) }} />
      )}
    </div>
  )
}

// ─── Slide Edit / New Modal ───────────────────────────────────────────────────
function SlideEditModal({ slide, onClose, onSaved, audit }) {
  const { profile } = useAuth()
  const dialogRef = useDialogA11y(true, onClose)
  const isEdit = Boolean(slide)
  const [form, setForm] = useState(() => ({
    title: slide?.title || '',
    body: slide?.body || '',
    layout: slide?.layout || 'standard',
    text_size: slide?.text_size || 'auto',
    duration_seconds: slide?.duration_seconds ? String(slide.duration_seconds) : '',
    start_date: slide?.start_date || '',
    end_date: slide?.end_date || '',
    status: slide?.status || 'active',
    image_url: slide?.image_url || '',
  }))
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleImage = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image file.'); return }
    if (file.size > 2_000_000) { toast.error('Image too large — please use an image under 2 MB.'); return }
    setUploading(true)
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase()
      const path = `slide-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('tv-slides')
        .upload(path, file, { contentType: file.type, upsert: false })
      if (upErr) throw upErr
      const { data: urlData } = supabase.storage.from('tv-slides').getPublicUrl(path)
      set('image_url', urlData?.publicUrl || '')
      toast.success('Image uploaded')
    } catch (err) {
      console.error('Slide image upload error:', err)
      toast.error('Image upload failed')
    }
    setUploading(false)
    e.target.value = ''
  }

  const handleSave = async () => {
    if (form.layout === 'image_full' && !form.image_url) {
      toast.error('Full-image layout needs an image.')
      return
    }
    if (form.layout === 'standard' && !form.title.trim() && !form.body.trim()) {
      toast.error('Add a title or some body text.')
      return
    }
    if (form.start_date && form.end_date && form.end_date < form.start_date) {
      toast.error('End date is before start date.')
      return
    }
    const dur = form.duration_seconds === '' ? null : parseInt(form.duration_seconds, 10)
    if (dur !== null && (isNaN(dur) || dur < 5 || dur > 600)) {
      toast.error('Duration must be between 5 and 600 seconds (or blank for default).')
      return
    }
    setSaving(true)
    const now = new Date().toISOString()
    const payload = {
      title: form.title.trim(),
      body: form.body,
      layout: form.layout,
      text_size: form.text_size || 'auto',
      duration_seconds: dur,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      status: form.status,
      image_url: form.image_url || null,
      updated_at: now,
      updated_by: profile?.email || '',
    }
    if (isEdit) {
      const { data: rows, error } = await supabase.from('tv_slides')
        .update(payload).eq('slide_id', slide.slide_id).select()
      if (error || !rows || rows.length === 0) {
        toast.error('Save failed — you may not have permission.')
        setSaving(false)
        return
      }
      audit('Updated TV slide', slide.slide_id, form.title)
      toast.success('Slide updated')
    } else {
      const slideId = await generateSlideId()
      const { data: ordRows } = await supabase.from('tv_slides').select('display_order')
      const nextOrder = ((ordRows || []).reduce((m, r) => Math.max(m, r.display_order || 0), 0)) + 1
      const { data: rows, error } = await supabase.from('tv_slides')
        .insert({ slide_id: slideId, display_order: nextOrder, created_at: now, created_by: profile?.email || '', ...payload })
        .select()
      if (error || !rows || rows.length === 0) {
        toast.error('Save failed — you may not have permission.')
        setSaving(false)
        return
      }
      audit('Created TV slide', slideId, form.title)
      toast.success('Slide created')
    }
    setSaving(false)
    onSaved()
  }

  const inputCls = 'w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-400'

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="slide-edit-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
              <MonitorPlay size={15} className="text-blue-600" aria-hidden="true" />
            </div>
            <h2 id="slide-edit-title" className="text-base font-bold text-surface-900">
              {isEdit ? 'Edit TV Slide' : 'New TV Slide'}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close dialog" className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400" aria-hidden="true" />
          </button>
        </div>

        {/* Body: form + live preview */}
        <div className="flex-1 overflow-y-auto px-6 py-5 grid md:grid-cols-2 gap-6">
          {/* Form column */}
          <div className="space-y-4">
            <div>
              <label htmlFor="slide-layout" className="block text-xs font-semibold text-surface-700 mb-1.5">Layout</label>
              <select id="slide-layout" value={form.layout} onChange={e => set('layout', e.target.value)} className={`${inputCls} bg-white`}>
                <option value="standard">Standard — title + text (+ optional image)</option>
                <option value="image_full">Full image — image fills the panel</option>
              </select>
            </div>

            <div>
              <label htmlFor="slide-title" className="block text-xs font-semibold text-surface-700 mb-1.5">
                Title {form.layout === 'image_full' && <span className="font-normal text-surface-400">(optional — used for the list here)</span>}
              </label>
              <input id="slide-title" value={form.title} onChange={e => set('title', e.target.value)}
                placeholder="e.g. This Week’s Lunch Menu" className={inputCls} />
            </div>

            {form.layout === 'standard' && (
              <>
              <div>
                <label htmlFor="slide-body" className="block text-xs font-semibold text-surface-700 mb-1.5">Body Text</label>
                <textarea id="slide-body" rows={6} value={form.body} onChange={e => set('body', e.target.value)}
                  placeholder={'Monday \u2014 Walking Tacos\nTuesday \u2014 Chicken Alfredo\n\u2026'}
                  className={`${inputCls} resize-none font-mono leading-relaxed`} />
                <p className="text-[11px] text-surface-400 mt-1">Line breaks are kept. Keep it large-screen friendly — a few short lines beats a paragraph.</p>
              </div>

              <div>
                <label htmlFor="slide-text-size" className="block text-xs font-semibold text-surface-700 mb-1.5">Text Size</label>
                <select id="slide-text-size" value={form.text_size} onChange={e => set('text_size', e.target.value)} className={`${inputCls} bg-white`}>
                  <option value="auto">Auto — fills the panel (recommended)</option>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
                <p className="text-[11px] text-surface-400 mt-1">Auto scales the text to use the whole slide. Fixed sizes may clip very long content.</p>
              </div>
              </>
            )}

            <div>
              <span className="block text-xs font-semibold text-surface-700 mb-1.5">
                Image {form.layout === 'image_full' ? <span className="text-red-500">*</span> : <span className="font-normal text-surface-400">(optional, shown beside the text)</span>}
              </span>
              <div className="flex items-center gap-2">
                <label className="px-3 py-2 text-xs font-medium border border-surface-200 rounded-lg hover:bg-surface-50 cursor-pointer flex items-center gap-1.5 text-surface-600">
                  <ImagePlus size={14} aria-hidden="true" /> {uploading ? 'Uploading\u2026' : (form.image_url ? 'Replace Image' : 'Upload Image')}
                  <input type="file" accept="image/*" onChange={handleImage} className="sr-only" aria-label="Upload slide image" disabled={uploading} />
                </label>
                {form.image_url && (
                  <button onClick={() => set('image_url', '')}
                    className="text-xs text-surface-400 hover:text-red-500 underline" type="button">
                    Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-surface-400 mt-1">PNG or JPG under 2 MB. TVs are 1280×720 — landscape images look best.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="slide-start" className="block text-xs font-semibold text-surface-700 mb-1.5">
                  Show From <span className="font-normal text-surface-400">(optional)</span>
                </label>
                <input id="slide-start" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor="slide-end" className="block text-xs font-semibold text-surface-700 mb-1.5">
                  Show Until <span className="font-normal text-surface-400">(optional)</span>
                </label>
                <input id="slide-end" type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} className={inputCls} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="slide-duration" className="block text-xs font-semibold text-surface-700 mb-1.5">
                  Seconds On Screen <span className="font-normal text-surface-400">(blank = default)</span>
                </label>
                <input id="slide-duration" type="number" min="5" max="600" value={form.duration_seconds}
                  onChange={e => set('duration_seconds', e.target.value)} placeholder="Default" className={inputCls} />
              </div>
              <div>
                <label htmlFor="slide-status" className="block text-xs font-semibold text-surface-700 mb-1.5">Status</label>
                <select id="slide-status" value={form.status} onChange={e => set('status', e.target.value)} className={`${inputCls} bg-white`}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
          </div>

          {/* Preview column */}
          <div>
            <p className="text-xs font-semibold text-surface-700 mb-1.5">TV Preview <span className="font-normal text-surface-400">(approximate)</span></p>
            <div className="rounded-xl overflow-hidden border border-surface-200 bg-[#1e293b] aspect-video flex flex-col" aria-hidden="true">
              {form.layout === 'image_full' ? (
                form.image_url
                  ? <div className="flex-1 flex items-center justify-center bg-[#0f172a]"><img src={form.image_url} alt="" className="max-w-full max-h-full object-contain" /></div>
                  : <div className="flex-1 flex items-center justify-center text-surface-500 text-xs">Upload an image to preview</div>
              ) : (
                <>
                  <div className="px-3 py-2 bg-[#334155] border-b-2 border-purple-500 flex items-center gap-2">
                    <span className="text-sm">📣</span>
                    <span className="text-white text-xs font-semibold truncate">{form.title || 'Announcement'}</span>
                  </div>
                  <div className="flex-1 p-3 flex gap-2 overflow-hidden">
                    <SlidePreviewBody body={form.body} textSize={form.text_size} />
                    {form.image_url && (
                      <img src={form.image_url} alt="" className="max-w-[45%] object-contain rounded self-center" />
                    )}
                  </div>
                </>
              )}
            </div>
            <p className="text-[11px] text-surface-400 mt-2">
              The TV shows this in the left panel, rotating with Open Work Orders. Text size here mirrors the TV proportionally.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-100 px-6 py-3.5 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm text-surface-600 hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || uploading}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
            {saving ? 'Saving\u2026' : (isEdit ? 'Save Changes' : 'Create Slide')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Delete confirm ───────────────────────────────────────────────────────────
function SlideDeleteConfirm({ slide, busy, onCancel, onConfirm }) {
  const dialogRef = useDialogA11y(true, onCancel)
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="slide-delete-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
            <Trash2 size={17} className="text-red-500" aria-hidden="true" />
          </div>
          <div>
            <h3 id="slide-delete-title" className="font-bold text-surface-900 text-sm">Delete Slide?</h3>
            <p className="text-sm text-surface-500 mt-0.5">
              Delete <span className="font-semibold text-surface-700">"{slide.title || slide.slide_id}"</span>?
              It will disappear from the TV rotation immediately. This cannot be undone.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-4 py-2 text-sm font-medium text-surface-700 bg-white border border-surface-200 rounded-lg hover:bg-surface-50 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-500 rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />} Delete
          </button>
        </div>
      </div>
    </div>
  )
}
