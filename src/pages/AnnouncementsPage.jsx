import { useState, useMemo, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import {
  Megaphone, Search, Send, Trash2, RotateCcw, X, Loader2,
  CheckCircle2, Mail, MailOpen, Clock, Users, ChevronDown, ChevronUp,
  Bell, RefreshCw, Plus, FileText, Save, Edit3, Eye, Archive, Undo2, Pin, Inbox
} from 'lucide-react'

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
  const showAdminTabs = canViewSent || canManageTemplates
  const [tab, setTab] = useState('inbox')
  const [showCompose, setShowCompose] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [tabInitDone, setTabInitDone] = useState(false)
  const triggerRefresh = () => setRefreshKey(k => k + 1)

  // Set default tab to 'sent' once permissions confirm admin-level access
  useEffect(() => {
    if (!tabInitDone && canViewSent) {
      setTab('sent')
      setTabInitDone(true)
    }
  }, [canViewSent, tabInitDone])

  const tabs = [
    { id: 'inbox', label: 'My Inbox', icon: Bell },
    ...(canViewSent ? [
      { id: 'sent', label: 'Sent Messages', icon: Send },
    ] : []),
    ...(canManageTemplates ? [
      { id: 'templates', label: 'Templates', icon: FileText },
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
          <button onClick={() => setShowCompose(true)}
            className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 flex items-center gap-1.5 shadow-sm">
            <Plus size={14} /> New Message
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-100 rounded-xl p-1">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
              tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
            }`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'inbox' && <InboxTab refreshKey={refreshKey} />}
      {tab === 'sent' && canViewSent && <SentHistoryTab refreshKey={refreshKey} />}
      {tab === 'templates' && canManageTemplates && <TemplatesTab />}

      {/* Compose Modal */}
      {showCompose && (
        <ComposeModal
          onClose={() => setShowCompose(false)}
          onSent={() => { setShowCompose(false); triggerRefresh() }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOX TAB  (All users)
// ═══════════════════════════════════════════════════════════════════════════════

function InboxTab({ refreshKey }) {
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
                <div className="flex items-center justify-between mt-3">
                  {msg.expires_at && (
                    <div className="text-[10px] text-surface-400 flex items-center gap-1">
                      <Clock size={10} /> Expires {new Date(msg.expires_at).toLocaleDateString()}
                    </div>
                  )}
                  {!msg.expires_at && <div />}
                  {/* Archive / Restore button (pinned messages cannot be archived) */}
                  {subTab === 'inbox' && !isPinned && (
                    <button onClick={(e) => { e.stopPropagation(); archiveMessage(msg) }}
                      className="text-xs text-surface-500 hover:text-surface-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-100 transition-colors">
                      <Archive size={12} /> Archive
                    </button>
                  )}
                  {subTab === 'archived' && (
                    <button onClick={(e) => { e.stopPropagation(); restoreMessage(msg) }}
                      className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-brand-50 transition-colors">
                      <Undo2 size={12} /> Restore
                    </button>
                  )}
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

function ComposeModal({ onClose, onSent, initialSubject, initialBody }) {
  const { profile } = useAuth()
  const [users, setUsers] = useState([])
  const [templates, setTemplates] = useState([])
  const [subject, setSubject] = useState(initialSubject || '')
  const [body, setBody] = useState(initialBody || '')
  const [expiresDate, setExpiresDate] = useState('')
  const [selectedEmails, setSelectedEmails] = useState({})
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')

  // Load users and templates
  useEffect(() => {
    const load = async () => {
      const [uRes, tRes] = await Promise.all([
        supabase.from('profiles').select('email, first_name, last_name, role, status, time_clock_only').order('first_name'),
        supabase.from('message_templates').select('*').order('template_name'),
      ])
      // Filter out archived/inactive and TCO users
      const active = (uRes.data || []).filter(u =>
        u.status === 'Active' && u.time_clock_only !== 'Yes'
      )
      setUsers(active)
      setTemplates(tRes.data || [])
    }
    load()
  }, [])

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
      const rows = emails.map(email => ({
        recipient_email: email.toLowerCase(),
        sender_email: profile.email,
        sender_name: senderName,
        subject: subject.trim(),
        body: body.trim(),
        created_at: now,
        read: false,
        expires_at: expiresDate ? new Date(expiresDate).toISOString() : null,
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
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: senderName,
          action: 'Create',
          entity_type: 'Announcement',
          entity_id: subject.trim().slice(0, 50),
          details: `Sent to ${emails.length} recipient(s): ${subject.trim()}`,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200">
          <h2 className="text-base font-bold text-surface-900 flex items-center gap-2">
            <Send size={18} className="text-brand-600" /> Compose Message
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Template selector */}
          {templates.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
                Load Template
              </label>
              <div className="flex flex-wrap gap-1.5">
                {templates.map(t => (
                  <button key={t.id} onClick={() => applyTemplate(t)}
                    className="px-2.5 py-1 rounded-lg bg-surface-100 text-xs text-surface-700 hover:bg-brand-50 hover:text-brand-700 transition-colors">
                    <FileText size={11} className="inline mr-1" />{t.template_name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Subject */}
          <div>
            <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">Subject *</label>
            <input type="text" value={subject} onChange={e => setSubject(e.target.value)}
              placeholder="Message subject…" className="input text-sm" />
          </div>

          {/* Body */}
          <div>
            <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">Message *</label>
            <textarea value={body} onChange={e => setBody(e.target.value)}
              placeholder="Type your message…" rows={5}
              className="input text-sm resize-y min-h-[100px]" />
          </div>

          {/* Expires */}
          <div>
            <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
              Expires (optional)
            </label>
            <input type="date" value={expiresDate} onChange={e => setExpiresDate(e.target.value)}
              className="input text-sm w-48" />
          </div>

          {/* Recipients */}
          <div>
            <label className="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1 block">
              Recipients * <span className="text-surface-400 normal-case">({selectedCount} selected)</span>
            </label>

            {/* Quick select buttons */}
            <div className="flex flex-wrap gap-1.5 mb-2">
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
            <div className="border border-surface-200 rounded-xl max-h-48 overflow-y-auto divide-y divide-surface-100">
              {filteredUsers.map(u => {
                const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email
                const isChecked = !!selectedEmails[u.email]
                return (
                  <label key={u.email}
                    className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-surface-50 transition-colors ${
                      isChecked ? 'bg-brand-50/40' : ''
                    }`}>
                    <input type="checkbox" checked={isChecked}
                      onChange={() => toggleEmail(u.email)}
                      className="rounded border-surface-300 text-brand-600 focus:ring-brand-500" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-surface-800">{name}</span>
                      <span className="text-[10px] text-surface-400 ml-2">{u.email}</span>
                    </div>
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                      u.role === 'Instructor' ? 'bg-purple-100 text-purple-700' :
                      u.role === 'Work Study' ? 'bg-emerald-100 text-emerald-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>{u.role}</span>
                  </label>
                )
              })}
              {filteredUsers.length === 0 && (
                <div className="text-center py-6 text-xs text-surface-400">No users found</div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-200 flex items-center gap-2">
          {/* Save as template */}
          {showSaveTemplate ? (
            <div className="flex items-center gap-2 flex-1">
              <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)}
                placeholder="Template name…" className="input text-xs py-1.5 flex-1" autoFocus />
              <button onClick={handleSaveTemplate}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700">
                <Save size={11} className="inline mr-1" /> Save
              </button>
              <button onClick={() => setShowSaveTemplate(false)}
                className="px-2 py-1.5 rounded-lg bg-surface-100 text-xs text-surface-600">
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button onClick={() => setShowSaveTemplate(true)}
                className="px-3 py-1.5 rounded-lg bg-surface-100 text-xs text-surface-600 hover:bg-surface-200 flex items-center gap-1">
                <FileText size={12} /> Save as Template
              </button>
              <div className="flex-1" />
            </>
          )}

          <button onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-surface-100 text-xs font-medium text-surface-600 hover:bg-surface-200">
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending || selectedCount === 0}
            className="px-4 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5 shadow-sm">
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Send to {selectedCount} Recipient{selectedCount !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENT HISTORY TAB  (Instructors)
// ═══════════════════════════════════════════════════════════════════════════════

function SentHistoryTab({ refreshKey }) {
  const { profile } = useAuth()
  const [announcements, setAnnouncements] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [processing, setProcessing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const loadHistory = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false })

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

      ;(data || []).forEach(row => {
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
    } catch (err) {
      console.error('Error loading history:', err)
      if (!silent) toast.error('Failed to load sent messages')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory, refreshKey])

  // Realtime: auto-refresh when any announcement changes (read status, new, deleted)
  useEffect(() => {
    const channel = supabase
      .channel('sent-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'announcements' },
        () => { loadHistory(true) }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadHistory])

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

      const { error } = await supabase.from('announcements').insert(rows)
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
      {/* Search + Refresh */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search messages…" className="input pl-9 text-sm" />
        </div>
        <button onClick={loadHistory} title="Refresh"
          className="p-2.5 rounded-lg bg-surface-100 hover:bg-surface-200 text-surface-500">
          <RefreshCw size={14} />
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
          <Send size={32} className="mx-auto mb-2 text-surface-300" />
          <p className="text-sm text-surface-500">{search ? 'No matching messages' : 'No messages sent yet'}</p>
          <p className="text-xs text-surface-400 mt-1">Click "New Message" to compose and send</p>
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

                  {/* Actions */}
                  <div className="px-4 py-2.5 bg-surface-50 border-t border-surface-100 flex flex-wrap gap-2">
                    <button onClick={() => handleResend(ann, 'all')} disabled={isProcessing}
                      className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1">
                      {isProcessing ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Resend to All
                    </button>
                    {ann.readCount < ann.totalRecipients && (
                      <button onClick={() => handleResend(ann, 'unread')} disabled={isProcessing}
                        className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 disabled:opacity-50 flex items-center gap-1">
                        <RotateCcw size={11} /> Resend to Unread ({ann.totalRecipients - ann.readCount})
                      </button>
                    )}
                    <div className="flex-1" />
                    <button onClick={() => handleDelete(ann)} disabled={isProcessing}
                      className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 disabled:opacity-50 flex items-center gap-1">
                      <Trash2 size={11} /> Delete
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
