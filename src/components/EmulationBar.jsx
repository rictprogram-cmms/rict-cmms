/**
 * RICT CMMS - User Emulation Bar (Super Admin Only)
 * 
 * Provides two UI elements:
 * 1. A draggable floating "Emulate User" button (default: bottom-right) when NOT emulating
 * 2. A persistent top banner when actively emulating a user
 * 
 * The floating button can be click-dragged to any screen edge and remembers
 * its position across page refreshes via localStorage.
 *
 * Only renders for the super admin (rictprogram@gmail.com).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  UserCog,
  X,
  Search,
  Eye,
  EyeOff,
  Shield,
  Users,
  GripVertical,
} from 'lucide-react'

const POSITION_CACHE_KEY = 'rict_cmms_emulation_btn_pos'

// ─── Role badge colors ───────────────────────────────────────────────
const ROLE_COLORS = {
  Instructor: { bg: 'bg-purple-500/20', text: 'text-purple-300', border: 'border-purple-500/40' },
  'Work Study': { bg: 'bg-blue-500/20', text: 'text-blue-300', border: 'border-blue-500/40' },
  Student: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/40' },
}

function getRoleStyle(role) {
  return ROLE_COLORS[role] || { bg: 'bg-slate-500/20', text: 'text-slate-300', border: 'border-slate-500/40' }
}

// ─── Banner Colors by Emulated Role ──────────────────────────────────
const BANNER_COLORS = {
  Instructor: 'from-purple-900/95 to-purple-800/95 border-purple-500/50',
  'Work Study': 'from-blue-900/95 to-blue-800/95 border-blue-500/50',
  Student: 'from-emerald-900/95 to-emerald-800/95 border-emerald-500/50',
}

function getBannerStyle(role) {
  return BANNER_COLORS[role] || 'from-slate-900/95 to-slate-800/95 border-slate-500/50'
}

// ─── Draggable Button Hook ───────────────────────────────────────────
function useDraggable(initialPos) {
  const [position, setPosition] = useState(() => {
    try {
      const cached = localStorage.getItem(POSITION_CACHE_KEY)
      if (cached) return JSON.parse(cached)
    } catch {}
    return initialPos
  })

  const dragState = useRef({
    isDragging: false,
    wasDragged: false,
    startX: 0,
    startY: 0,
    startPosX: 0,
    startPosY: 0,
  })

  const btnRef = useRef(null)

  const handlePointerDown = useCallback((e) => {
    // Only primary button
    if (e.button !== 0) return
    e.preventDefault()

    const ds = dragState.current
    ds.isDragging = true
    ds.wasDragged = false
    ds.startX = e.clientX
    ds.startY = e.clientY
    ds.startPosX = position.x
    ds.startPosY = position.y

    // Capture pointer for smooth dragging even outside the button
    btnRef.current?.setPointerCapture(e.pointerId)
  }, [position])

  const handlePointerMove = useCallback((e) => {
    const ds = dragState.current
    if (!ds.isDragging) return

    const dx = e.clientX - ds.startX
    const dy = e.clientY - ds.startY

    // Require 5px movement to consider it a drag (prevents accidental drag on click)
    if (!ds.wasDragged && Math.abs(dx) < 5 && Math.abs(dy) < 5) return
    ds.wasDragged = true

    const btnEl = btnRef.current
    if (!btnEl) return

    const rect = btnEl.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width
    const maxY = window.innerHeight - rect.height

    const newX = Math.max(0, Math.min(maxX, ds.startPosX + dx))
    const newY = Math.max(0, Math.min(maxY, ds.startPosY + dy))

    setPosition({ x: newX, y: newY })
  }, [])

  const handlePointerUp = useCallback((e) => {
    const ds = dragState.current
    if (!ds.isDragging) return
    ds.isDragging = false

    btnRef.current?.releasePointerCapture(e.pointerId)

    // Save position if it was actually dragged
    if (ds.wasDragged) {
      const btnEl = btnRef.current
      if (btnEl) {
        const rect = btnEl.getBoundingClientRect()
        const maxX = window.innerWidth - rect.width
        const maxY = window.innerHeight - rect.height
        const finalX = Math.max(0, Math.min(maxX, position.x))
        const finalY = Math.max(0, Math.min(maxY, position.y))
        const finalPos = { x: finalX, y: finalY }
        setPosition(finalPos)
        try { localStorage.setItem(POSITION_CACHE_KEY, JSON.stringify(finalPos)) } catch {}
      }
    }
  }, [position])

  // Keep button in bounds on window resize
  useEffect(() => {
    const handleResize = () => {
      setPosition(prev => {
        const btnEl = btnRef.current
        if (!btnEl) return prev
        const rect = btnEl.getBoundingClientRect()
        const maxX = window.innerWidth - rect.width
        const maxY = window.innerHeight - rect.height
        return {
          x: Math.max(0, Math.min(maxX, prev.x)),
          y: Math.max(0, Math.min(maxY, prev.y)),
        }
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return {
    btnRef,
    position,
    wasDragged: () => dragState.current.wasDragged,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    },
  }
}

// ─── Main Component ──────────────────────────────────────────────────

export default function EmulationBar() {
  const {
    isSuperAdmin,
    isEmulating,
    emulatedProfile,
    startEmulation,
    stopEmulation,
    realProfile,
  } = useAuth()

  const [showPicker, setShowPicker] = useState(false)
  const [users, setUsers] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [emulationLoading, setEmulationLoading] = useState(false)
  const pickerRef = useRef(null)
  const searchRef = useRef(null)

  // Default position: bottom-right with some padding
  const { btnRef, position, wasDragged, handlers } = useDraggable({
    x: typeof window !== 'undefined' ? window.innerWidth - 220 : 800,
    y: typeof window !== 'undefined' ? window.innerHeight - 80 : 600,
  })

  const shouldRender = isSuperAdmin || isEmulating

  // ─── ALL HOOKS ABOVE EARLY RETURN ──────────────────────────────────

  useEffect(() => {
    if (!showPicker || !shouldRender) return

    let cancelled = false

    async function loadUsers() {
      setLoadingUsers(true)
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, email, first_name, last_name, role, status, classes, user_id')
          .eq('status', 'Active')
          .order('role', { ascending: true })
          .order('last_name', { ascending: true })

        if (!cancelled && !error && data) {
          setUsers(data.filter(u => u.email?.toLowerCase() !== 'rictprogram@gmail.com'))
        }
      } catch (err) {
        console.error('Failed to load users for emulation:', err)
      } finally {
        if (!cancelled) setLoadingUsers(false)
      }
    }

    loadUsers()
    setTimeout(() => searchRef.current?.focus(), 100)

    return () => { cancelled = true }
  }, [showPicker, shouldRender])

  useEffect(() => {
    if (!showPicker) return

    function handleClickOutside(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setShowPicker(false)
        setSearchQuery('')
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showPicker])

  useEffect(() => {
    if (!showPicker) return

    function handleEscape(e) {
      if (e.key === 'Escape') {
        setShowPicker(false)
        setSearchQuery('')
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [showPicker])

  // ─── EARLY RETURN — safe, all hooks above ──────────────────────────
  if (!shouldRender) return null

  // ─── Handlers ──────────────────────────────────────────────────────

  async function handleEmulate(userEmail) {
    setEmulationLoading(true)
    try {
      const result = await startEmulation(userEmail)
      if (result) {
        setShowPicker(false)
        setSearchQuery('')
      }
    } finally {
      setEmulationLoading(false)
    }
  }

  function handleButtonClick() {
    // Only open picker if we didn't just finish a drag
    if (!wasDragged()) {
      setShowPicker(true)
    }
  }

  // Filter & group users
  const filteredUsers = users.filter(u => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      u.first_name?.toLowerCase().includes(q) ||
      u.last_name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.role?.toLowerCase().includes(q) ||
      u.user_id?.toLowerCase().includes(q) ||
      u.classes?.toLowerCase().includes(q)
    )
  })

  const groupedUsers = {}
  filteredUsers.forEach(u => {
    const role = u.role || 'Unknown'
    if (!groupedUsers[role]) groupedUsers[role] = []
    groupedUsers[role].push(u)
  })

  const roleOrder = ['Instructor', 'Work Study', 'Student']

  return (
    <>
      {/* ─── Active Emulation Banner (top of page) ──────────────────── */}
      {isEmulating && emulatedProfile && (
        <div
          className={`fixed top-0 left-0 right-0 z-[9999] bg-gradient-to-r ${getBannerStyle(emulatedProfile.role)} border-b-2 backdrop-blur-sm`}
          style={{ height: '44px' }}
        >
          <div className="h-full max-w-screen-2xl mx-auto px-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-amber-400 animate-pulse" />
                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Emulating
                </span>
              </div>

              <div className="h-4 w-px bg-white/20" />

              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  {emulatedProfile.first_name} {emulatedProfile.last_name}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${getRoleStyle(emulatedProfile.role).bg} ${getRoleStyle(emulatedProfile.role).text} ${getRoleStyle(emulatedProfile.role).border}`}>
                  {emulatedProfile.role}
                </span>
                <span className="text-xs text-white/50 hidden sm:inline">
                  {emulatedProfile.email}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowPicker(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white/80 hover:text-white bg-white/10 hover:bg-white/20 transition-all"
                title="Switch to another user"
              >
                <Users className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Switch</span>
              </button>

              <button
                onClick={stopEmulation}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500/80 hover:bg-red-500 transition-all shadow-lg"
                title="Stop emulation and return to super admin"
              >
                <EyeOff className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Draggable Floating Trigger Button ────────────────────────── */}
      {!isEmulating && isSuperAdmin && (
        <div
          ref={btnRef}
          {...handlers}
          onClick={handleButtonClick}
          className="fixed z-[9998] flex items-center gap-2 px-4 py-3 rounded-2xl bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-semibold shadow-2xl shadow-amber-900/40 transition-colors group select-none"
          style={{
            left: `${position.x}px`,
            top: `${position.y}px`,
            cursor: 'grab',
            touchAction: 'none', // prevent scroll on touch drag
          }}
          title="Emulate a user — drag to reposition"
        >
          <GripVertical className="w-4 h-4 text-amber-200/40 group-hover:text-amber-200/70 flex-shrink-0" />
          <UserCog className="w-5 h-5" />
          <span className="text-sm">Emulate User</span>
          <Shield className="w-3.5 h-3.5 text-amber-200/60 group-hover:text-amber-200" />
        </div>
      )}

      {/* ─── User Picker Modal ──────────────────────────────────────── */}
      {showPicker && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div
            ref={pickerRef}
            className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/20">
                  <UserCog className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">Emulate User</h2>
                  <p className="text-xs text-slate-400">
                    View the app as any user would see it
                  </p>
                </div>
              </div>
              <button
                onClick={() => { setShowPicker(false); setSearchQuery('') }}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search */}
            <div className="px-5 py-3 border-b border-slate-700/30">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by name, email, role, class, or ID..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-all"
                />
              </div>
            </div>

            {/* User List */}
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {loadingUsers ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full" />
                  <span className="ml-3 text-sm text-slate-400">Loading users...</span>
                </div>
              ) : filteredUsers.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  {searchQuery ? 'No users match your search' : 'No active users found'}
                </div>
              ) : (
                roleOrder.map(role => {
                  const roleUsers = groupedUsers[role]
                  if (!roleUsers || roleUsers.length === 0) return null

                  const style = getRoleStyle(role)

                  return (
                    <div key={role} className="mb-3">
                      <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
                        <span className={`text-xs font-bold uppercase tracking-wider ${style.text}`}>
                          {role}
                        </span>
                        <span className="text-xs text-slate-600">
                          ({roleUsers.length})
                        </span>
                        <div className="flex-1 h-px bg-slate-800" />
                      </div>

                      <div className="space-y-0.5">
                        {roleUsers.map(user => {
                          const isCurrentlyEmulated = isEmulating && emulatedProfile?.email === user.email

                          return (
                            <button
                              key={user.id}
                              onClick={() => handleEmulate(user.email)}
                              disabled={emulationLoading || isCurrentlyEmulated}
                              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                                isCurrentlyEmulated
                                  ? 'bg-amber-500/10 border border-amber-500/30 cursor-default'
                                  : 'hover:bg-slate-800 active:bg-slate-700/50'
                              }`}
                            >
                              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${style.bg} ${style.text} flex-shrink-0`}>
                                {(user.first_name?.[0] || '?')}{(user.last_name?.[0] || '?')}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-white truncate">
                                    {user.first_name} {user.last_name}
                                  </span>
                                  {user.user_id && (
                                    <span className="text-xs text-slate-600 flex-shrink-0">
                                      {user.user_id}
                                    </span>
                                  )}
                                  {isCurrentlyEmulated && (
                                    <span className="text-xs text-amber-400 font-bold flex-shrink-0">
                                      ACTIVE
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-500 truncate">
                                  {user.email}
                                  {user.classes && (
                                    <span className="text-slate-600 ml-2">
                                      • {user.classes}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {!isCurrentlyEmulated && (
                                <Eye className="w-4 h-4 text-slate-600 flex-shrink-0" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-700/30 bg-slate-900/80">
              <div className="flex items-start gap-2">
                <Shield className="w-4 h-4 text-amber-500/60 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  <span className="text-amber-400/80 font-semibold">Super Admin Testing Mode.</span>{' '}
                  You will see the app exactly as the selected user would — same permissions, same role, same UI.
                  Database writes still happen under your real account for safety.
                  Emulation persists across page refreshes until you stop it.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
