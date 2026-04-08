import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

// ─── Standalone Supabase client (no auth needed for public page) ─────────────

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Fallback Course Map (used when classes table RLS blocks anon reads) ─────
// Keep this in sync with the classes table. Once anon SELECT policy is added
// to the classes table in Supabase, this fallback won't be needed.
const COURSE_MAP = {
  RICT1600: 'Digital Electronics',
  RICT1620: 'Networking Systems',
  RICT1630: 'Production Automation',
  RICT1640: 'Sensor Applications',
  RICT2600: 'Industrial Motor Applications',
  RICT2610: 'Advanced Mechanical Systems',
  RICT2630: 'Instrumentation Control & Data Analysis',
}

// ─── Live Clock ──────────────────────────────────────────────────────────────

function LiveClock() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const timeStr = time.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  })
  const dateStr = time.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  return (
    <div className="text-right">
      <div className="text-2xl font-bold text-white tracking-wide leading-tight">{timeStr}</div>
      <div className="text-[11px] text-blue-100">{dateStr}</div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}+00`
}

function getWeekStart() {
  const now = new Date()
  const day = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1)
  const monday = new Date(now)
  monday.setDate(diff)
  monday.setHours(0, 0, 0, 0)
  return `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`
}

function formatTime(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`
}

// formatNow() reads the current LOCAL time — used for punch-in success display.
// formatTime() uses UTC hours because stored punch_in values are "fake UTC"
// (local time written with +00 offset via localToUtcIso). Do NOT use
// new Date().toISOString() with formatTime — that string is real UTC and will
// show the wrong hour in non-UTC timezones.
function formatNow() {
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`
}

function formatDuration(hours) {
  if (!hours || hours <= 0) return '0:00'
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return `${h}:${m.toString().padStart(2, '0')}`
}

function timeToMinutes(timeStr) {
  if (!timeStr) return null
  const parts = timeStr.split(':')
  const h = parseInt(parts[0])
  const m = parseInt(parts[1] || '0')
  if (isNaN(h)) return null
  return h * 60 + m
}

function nowMinutes() {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function formatMinutes(mins) {
  if (!mins || mins <= 0) return ''
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}min` : `${h}h`
}

function isInstructorRole(role) {
  return (role || '').toLowerCase() === 'instructor'
}

// ─── Attendance Flag Component (flashing alert) ─────────────────────────────

function AttendanceFlag({ type, minutes }) {
  const config = {
    late: {
      bg: 'bg-red-600',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      ),
      label: 'LATE',
      detail: minutes ? `${formatMinutes(minutes)} past scheduled start` : '',
    },
    early: {
      bg: 'bg-amber-500',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      ),
      label: 'LEAVING EARLY',
      detail: minutes ? `${formatMinutes(minutes)} before scheduled end` : '',
    },
    walkin: {
      bg: 'bg-purple-600',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s-8-4.5-8-11.8A8 8 0 0112 2a8 8 0 018 8.2c0 7.3-8 11.8-8 11.8z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      ),
      label: 'WALK-IN',
      detail: 'Please sign up for lab time',
    },
  }

  const c = config[type]
  if (!c) return null

  return (
    <div className={`${c.bg} text-white rounded-lg px-4 py-2.5 flex items-center gap-3 animate-pulse shadow-lg w-full max-w-sm`}>
      <div className="flex-shrink-0">{c.icon}</div>
      <div>
        <p className="font-black text-sm tracking-wide">{c.label}</p>
        {c.detail && <p className="text-[11px] opacity-90">{c.detail}</p>}
      </div>
    </div>
  )
}

// ─── Screens ─────────────────────────────────────────────────────────────────

// SCREEN 1: Swipe Card
function SwipeScreen({ onLookup, error, loading }) {
  const [input, setInput] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    const timer = setInterval(() => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus()
      }
    }, 500)
    return () => clearInterval(timer)
  }, [])

  function handleKeyDown(e) {
    if (e.key === 'Enter' && input.trim()) {
      onLookup(input.trim())
      setInput('')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4">
      <div className="w-14 h-14 rounded-xl bg-blue-100 flex items-center justify-center mb-3">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="18" rx="2" />
          <path d="M9 10h.01" />
          <path d="M15 10h.01" />
          <path d="M9 14h6" />
        </svg>
      </div>

      <h2 className="text-xl font-bold text-gray-900 mb-1">Swipe Your Badge</h2>
      <p className="text-xs text-gray-400 mb-3">Swipe your student ID badge to punch in or out</p>

      <div className="w-full max-w-sm mb-2">
        <input
          ref={inputRef}
          type="text"
          name="badge-scan"
          data-1p-ignore
          data-lpignore="true"
          aria-label="Student badge swipe input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full text-center text-base py-3 px-4 border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none bg-white badge-mask"
          placeholder="Swipe badge..."
          autoFocus
          autoComplete="off"
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-blue-600 text-sm mt-1">
          <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          Looking up...
        </div>
      )}

      {error && (
        <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm text-center max-w-sm">
          {error}
        </div>
      )}
    </div>
  )
}

// SCREEN 2a: Student Picker (Instructor flow)
function StudentPickerScreen({ instructor, students, onSelectStudent, onCancel, loading }) {
  const [search, setSearch] = useState('')
  const searchRef = useRef(null)

  useEffect(() => {
    if (searchRef.current) searchRef.current.focus()
  }, [])

  const filtered = students.filter(s => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    const fullName = `${s.first_name} ${s.last_name}`.toLowerCase()
    return fullName.includes(q) || (s.email || '').toLowerCase().includes(q)
  })

  return (
    <div className="flex flex-col flex-1 px-4 py-3 min-h-0">
      <div className="flex items-center gap-3 mb-2 flex-shrink-0">
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197" />
          </svg>
        </div>
        <div>
          <h2 className="text-base font-bold text-gray-900 leading-tight">Instructor Mode</h2>
          <p className="text-[10px] text-gray-500">
            {instructor.first_name} — Select a student to punch in/out
          </p>
        </div>
      </div>

      <div className="mb-2 flex-shrink-0">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full text-sm py-2 px-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none bg-white"
          placeholder="Search by name..."
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-sm text-gray-400 py-8">
            {search ? 'No matching students' : 'No active students found'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {filtered.map(s => {
              const initials = `${(s.first_name || '')[0] || ''}${(s.last_name || '')[0] || ''}`.toUpperCase()
              return (
                <button
                  key={s.id}
                  onClick={() => onSelectStudent(s)}
                  className="flex items-center gap-2 p-2 bg-white border border-gray-200 rounded-lg hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left group"
                >
                  <div className="w-8 h-8 rounded-full bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-bold text-indigo-700">{initials}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-900 truncate group-hover:text-indigo-700">
                      {s.first_name} {s.last_name}
                    </p>
                    <p className="text-[10px] text-gray-400 truncate">{s.role}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="pt-2 flex-shrink-0 text-center">
        <button onClick={onCancel} className="px-6 py-2 bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold text-sm rounded-xl transition-colors shadow-sm">
          Cancel
        </button>
      </div>
    </div>
  )
}

// SCREEN 2b: Select Class (Punch In)
// Each cls object: classId (CLS###), courseId (RICT code = PRIMARY), courseName (human name = SECONDARY)
function ClassSelectScreen({ user, classes, onPunchIn, onCancel, loading, proxyInstructor }) {
  return (
    <div className="flex flex-col items-center flex-1 px-4 py-4 overflow-y-auto">
      {proxyInstructor && (
        <p className="text-xs text-indigo-500 font-medium mb-1">
          Instructor: {proxyInstructor.first_name} — punching in for:
        </p>
      )}
      <h2 className="text-lg font-bold text-gray-900 mb-0.5">
        {proxyInstructor ? `${user.first_name} ${user.last_name}` : `Welcome, ${user.first_name}!`}
      </h2>
      <p className="text-sm text-gray-500 mb-3">Select a class to punch in</p>

      <div className="w-full max-w-lg grid grid-cols-2 gap-2 mb-3">
        {classes.map(cls => (
          <button
            key={cls.classId}
            onClick={() => onPunchIn(cls)}
            disabled={loading}
            className="w-full text-left p-3 bg-white border-2 border-gray-200 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition-all duration-150 group"
          >
            <div className="flex items-center justify-between">
              <div>
                {/* PRIMARY: Course ID (RICT code) — bold */}
                <p className="font-bold text-base text-gray-900 group-hover:text-blue-700">
                  {cls.courseId || cls.courseName || 'Class'}
                  {cls.isVolunteer && <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">Volunteer</span>}
                  {cls.isWorkStudy && <span className="ml-2 text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Work Study</span>}
                  {cls.isClubActivity && <span className="ml-2 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">Club Activity</span>}
                </p>
                {/* SECONDARY: Course Name — smaller, below (not shown for Volunteer, Work Study, or Club Activity) */}
                {cls.courseName && !cls.isVolunteer && !cls.isWorkStudy && !cls.isClubActivity && (
                  <p className="text-sm text-gray-500 mt-0.5">{cls.courseName}</p>
                )}
              </div>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-300 group-hover:text-blue-500 flex-shrink-0">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-blue-600 text-sm mb-2">
          <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          Punching in...
        </div>
      )}

      <button onClick={onCancel} className="px-6 py-2 bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold text-sm rounded-xl transition-colors shadow-sm">
        Cancel
      </button>
    </div>
  )
}

// SCREEN 3: Punch Out Confirmation
function PunchOutScreen({ user, punchRecord, onPunchOut, onCancel, loading, proxyInstructor }) {
  const [elapsed, setElapsed] = useState('')

  useEffect(() => {
    function update() {
      if (punchRecord?.punch_in) {
        const start = new Date(punchRecord.punch_in)
        const now = new Date()
        const nowFakeUtcMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(),
          now.getHours(), now.getMinutes(), now.getSeconds())
        const diff = (nowFakeUtcMs - start.getTime()) / 1000
        if (diff < 0) { setElapsed('0:00:00'); return }
        const h = Math.floor(diff / 3600)
        const m = Math.floor((diff % 3600) / 60)
        const s = Math.floor(diff % 60)
        setElapsed(`${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`)
      }
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [punchRecord])

  // course_id stores RICT code (PRIMARY), _courseName looked up (SECONDARY)
  const courseCode = punchRecord?.course_id || ''
  const courseName = punchRecord?._courseName || ''

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4">
      {proxyInstructor && (
        <p className="text-xs text-indigo-500 font-medium mb-1">
          Instructor: {proxyInstructor.first_name} — punching out:
        </p>
      )}
      <h2 className="text-lg font-bold text-gray-900 mb-0.5">
        {proxyInstructor
          ? `${user.first_name} ${user.last_name}`
          : `Welcome back, ${user.first_name}!`}
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        {proxyInstructor ? 'This student is currently punched in' : 'You are currently punched in'}
      </p>

      <div className="w-full max-w-xs p-4 bg-blue-50 border-2 border-blue-200 rounded-xl text-center mb-4">
        {/* PRIMARY: Course ID (RICT code) — bold */}
        <p className="text-sm text-blue-700 font-bold mb-0.5">{courseCode || 'Class'}</p>
        {/* SECONDARY: Course Name — smaller */}
        {courseName && <p className="text-xs text-blue-500 mb-1">{courseName}</p>}
        <p className="text-xs text-blue-400 mb-2">Punched in at {formatTime(punchRecord?.punch_in)}</p>
        <p className="text-3xl font-bold text-blue-700 font-mono">{elapsed}</p>
        <p className="text-[10px] text-blue-400 mt-1">Time elapsed</p>
      </div>

      <button
        onClick={onPunchOut}
        disabled={loading}
        className="w-full max-w-xs py-3 bg-red-600 hover:bg-red-700 text-white font-bold text-lg rounded-xl transition-colors disabled:opacity-50"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Punching out...
          </span>
        ) : 'Punch Out'}
      </button>

      <button onClick={onCancel} className="px-6 py-2 mt-3 bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold text-sm rounded-xl transition-colors shadow-sm">
        Cancel
      </button>
    </div>
  )
}

// SCREEN 4: Success Message with Attendance Flags (auto-returns)
function SuccessScreen({ message, detail, type, flags }) {
  const isOut = type === 'out'
  const hasFlags = flags && flags.length > 0

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4 gap-3">
      <div className={`w-14 h-14 rounded-full flex items-center justify-center ${isOut ? 'bg-red-100' : 'bg-green-100'}`}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={isOut ? '#dc2626' : '#16a34a'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>

      <div className="text-center">
        <h2 className="text-xl font-bold text-gray-900">{message}</h2>
        {detail && <p className="text-sm text-gray-500 mt-0.5">{detail}</p>}
      </div>

      {hasFlags && (
        <div className="flex flex-col items-center gap-2 mt-1 w-full">
          {flags.map((flag, i) => (
            <AttendanceFlag key={i} type={flag.type} minutes={flag.minutes} />
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-400 mt-2">Returning to swipe screen...</p>
    </div>
  )
}

// SCREEN 5: Early Departure Warning
function EarlyWarningScreen({ earlyMinutes, onAccept, onGetPermission, loading }) {
  const [countdown, setCountdown] = useState(10)
  const onAcceptRef = useRef(onAccept)
  onAcceptRef.current = onAccept

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          onAcceptRef.current()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4 gap-3">
      <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      <div className="text-center">
        <h2 className="text-xl font-bold text-gray-900">Leaving Early</h2>
        <p className="text-sm text-gray-500 mt-1">
          You are leaving <span className="font-semibold text-amber-600">{formatMinutes(earlyMinutes)}</span> before your scheduled end time
        </p>
      </div>

      <AttendanceFlag type="early" minutes={earlyMinutes} />

      <div className="w-full max-w-xs flex flex-col gap-2 mt-1">
        <button
          onClick={onGetPermission}
          disabled={loading}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="18" rx="2" />
            <path d="M9 10h.01" />
            <path d="M15 10h.01" />
            <path d="M9 14h6" />
          </svg>
          Get Instructor Permission
        </button>

        <button
          onClick={onAccept}
          disabled={loading}
          className="w-full py-2.5 bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium text-sm rounded-xl transition-colors disabled:opacity-50"
        >
          OK — Leave Early
        </button>
      </div>

      <p className="text-[10px] text-gray-400 mt-1">
        Auto-accepting in <span className="font-bold text-amber-600">{countdown}s</span>...
      </p>
    </div>
  )
}

// SCREEN 6: Instructor Badge Approval for Early Departure
function InstructorApproveScreen({ user, onApproved, onCancel, loading: parentLoading }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const timer = setInterval(() => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus()
      }
    }, 500)
    return () => clearInterval(timer)
  }, [])

  async function handleKeyDown(e) {
    if (e.key !== 'Enter' || !input.trim()) return
    const cardId = input.trim()
    setInput('')
    setError('')
    setLoading(true)

    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('card_id', cardId)
        .eq('status', 'Active')
        .maybeSingle()

      if (!profile) {
        setError('Badge not recognized. Please try again.')
        setLoading(false)
        return
      }

      if (!isInstructorRole(profile.role)) {
        setError('Only instructors can approve early departures.')
        setLoading(false)
        return
      }

      const instructorName = `${profile.first_name} ${(profile.last_name || '').charAt(0)}.`
      onApproved(instructorName)
    } catch (err) {
      console.error('[TimeClock] Instructor approval error:', err)
      setError('Lookup failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const studentName = `${user?.first_name || ''} ${(user?.last_name || '').charAt(0) || ''}.`

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4">
      <div className="w-14 h-14 rounded-xl bg-indigo-100 flex items-center justify-center mb-3">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </div>

      <h2 className="text-xl font-bold text-gray-900 mb-0.5">Instructor Approval</h2>
      <p className="text-sm text-gray-500 mb-1">
        Approve early departure for <span className="font-semibold text-gray-700">{studentName}</span>
      </p>
      <p className="text-xs text-gray-400 mb-4">Instructor — swipe your badge to approve</p>

      <div className="w-full max-w-sm mb-2">
        <input
          ref={inputRef}
          type="text"
          name="badge-scan"
          data-1p-ignore
          data-lpignore="true"
          aria-label="Instructor badge swipe input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full text-center text-base py-3 px-4 border-2 border-indigo-200 rounded-xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none bg-white badge-mask"
          placeholder="Swipe instructor badge..."
          autoFocus
          autoComplete="off"
        />
      </div>

      {(loading || parentLoading) && (
        <div className="flex items-center gap-2 text-indigo-600 text-sm mt-1">
          <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          Verifying...
        </div>
      )}

      {error && (
        <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm text-center max-w-sm">
          {error}
        </div>
      )}

      <button onClick={onCancel} className="px-6 py-2 mt-3 bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold text-sm rounded-xl transition-colors shadow-sm">
        Cancel — Leave Early Instead
      </button>
    </div>
  )
}

// ─── Lab Closed Screen ────────────────────────────────────────────────────────
// Shown on the kiosk when lab_access_mode = 'summer_break'

function LabClosedScreen() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const timeStr = time.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  })
  const dateStr = time.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  return (
    <div
      style={{
        width: '800px', height: '480px',
        background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2744 60%, #0a1f38 100%)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', position: 'relative', overflow: 'hidden',
      }}
    >
      {/* Subtle background grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
        pointerEvents: 'none',
      }} />

      {/* Top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        background: 'rgba(255,255,255,0.05)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        padding: '12px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: 'rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </div>
          <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.05em' }}>
            RICT CMMS — TIME CLOCK
          </span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'white', fontSize: '0.95rem', fontWeight: 700 }}>{timeStr}</div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>{dateStr}</div>
        </div>
      </div>

      {/* Moon icon */}
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: 'rgba(147,197,253,0.12)',
        border: '2px solid rgba(147,197,253,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 22,
      }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
        </svg>
      </div>

      {/* Message */}
      <h1 style={{
        color: '#ffffff',
        fontSize: '1.55rem',
        fontWeight: 700,
        margin: '0 0 8px',
        letterSpacing: '-0.02em',
      }}>
        Time Clock Unavailable
      </h1>
      <p style={{
        color: '#93c5fd',
        fontSize: '0.95rem',
        fontWeight: 500,
        margin: '0 0 10px',
      }}>
        The lab is closed for semester break
      </p>
      <p style={{
        color: 'rgba(255,255,255,0.4)',
        fontSize: '0.8rem',
        maxWidth: 340,
        lineHeight: 1.6,
        margin: 0,
      }}>
        Student check-in is disabled during the semester break.
        Please contact your instructor if you have questions.
      </p>
    </div>
  )
}

// ─── Main Time Clock Page ────────────────────────────────────────────────────

export default function TimeClockPage() {
  const [screen, setScreen] = useState('swipe')
  const [user, setUser] = useState(null)
  const [instructor, setInstructor] = useState(null)
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [punchRecord, setPunchRecord] = useState(null)
  const [successMsg, setSuccessMsg] = useState({ message: '', detail: '', type: '', flags: [] })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [todaySignup, setTodaySignup] = useState(null)
  const [gracePeriod, setGracePeriod] = useState(10)
  const [earlyInfo, setEarlyInfo] = useState(null)

  // ── Lab Access Mode ─────────────────────────────────────────────────
  // 'unknown' while loading, 'in_session' or 'summer_break' once fetched.
  // The kiosk polls every 5 minutes so it responds to mode changes
  // without requiring a manual page refresh on the Raspberry Pi.
  const [labMode, setLabMode] = useState('unknown')

  const fetchLabMode = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'lab_access_mode')
        .maybeSingle()
      setLabMode(data?.setting_value || 'in_session')
    } catch {
      setLabMode('in_session') // default to open on error
    }
  }, [])

  // Fetch on mount and poll every 5 minutes as a fallback
  useEffect(() => {
    fetchLabMode()
    const poll = setInterval(fetchLabMode, 5 * 60 * 1000)
    return () => clearInterval(poll)
  }, [fetchLabMode])

  // Realtime: respond instantly when an instructor flips the toggle
  // This means the kiosk updates in seconds rather than waiting for the next poll
  useEffect(() => {
    const channel = supabase
      .channel('timeclock-lab-access-mode')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'settings',
          filter: 'setting_key=eq.lab_access_mode',
        },
        (payload) => {
          const newMode = payload.new?.setting_value || 'in_session'
          console.log('[TimeClock] Lab access mode changed to:', newMode)
          setLabMode(newMode)
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // Cache classes data for course name lookups
  const classesDataRef = useRef(null)

  // ── Auto-refresh page at midnight so deployed updates take effect ──
  useEffect(() => {
    function scheduleMidnightRefresh() {
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      const msUntilMidnight = midnight.getTime() - now.getTime()
      console.log('[TimeClock] Auto-refresh scheduled in', Math.round(msUntilMidnight / 60000), 'minutes')
      return setTimeout(() => {
        console.log('[TimeClock] Midnight refresh triggered')
        window.location.reload()
      }, msUntilMidnight)
    }
    const timer = scheduleMidnightRefresh()
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (screen === 'success') {
      const hasFlags = successMsg.flags && successMsg.flags.length > 0
      const delay = hasFlags ? 8000 : 5000
      const timer = setTimeout(() => resetToSwipe(), delay)
      return () => clearTimeout(timer)
    }
  }, [screen, successMsg.flags])

  function resetToSwipe() {
    setScreen('swipe')
    setUser(null)
    setInstructor(null)
    setStudents([])
    setClasses([])
    setPunchRecord(null)
    setTodaySignup(null)
    setEarlyInfo(null)
    setError('')
  }

  useEffect(() => {
    if (screen !== 'punch-out' || !punchRecord?.record_id) return

    const channel = supabase
      .channel(`timeclock-kiosk-${punchRecord.record_id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'time_clock',
        filter: `record_id=eq.${punchRecord.record_id}`,
      }, (payload) => {
        const updated = payload.new
        if (updated && updated.status === 'Punched Out') {
          const totalHours = parseFloat(updated.total_hours) || 0
          const flags = checkPunchOutFlags()
          setSuccessMsg({
            message: 'Punched Out!',
            detail: `Total time: ${formatDuration(totalHours)}`,
            type: 'out',
            flags,
          })
          setScreen('success')
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [screen, punchRecord?.record_id, todaySignup, gracePeriod])

  function checkPunchInFlags(isVolunteer, isWorkStudy, isFirstPunchToday) {
    const flags = []
    if (isVolunteer || isWorkStudy) return flags  // no attendance flags for volunteer or work study
    // Only flag late/walk-in on the FIRST punch of the day
    // Subsequent punches (e.g. different class after lunch) should not be flagged
    if (!isFirstPunchToday) return flags
    if (!todaySignup) {
      flags.push({ type: 'walkin' })
    } else {
      const now = nowMinutes()
      const lateBy = now - todaySignup.startMin
      if (lateBy > gracePeriod) {
        flags.push({ type: 'late', minutes: lateBy })
      }
    }
    return flags
  }

  function checkPunchOutFlags() {
    const flags = []
    if (todaySignup && todaySignup.endMin > 0) {
      const now = nowMinutes()
      const earlyBy = todaySignup.endMin - now
      if (earlyBy > gracePeriod) {
        flags.push({ type: 'early', minutes: earlyBy })
      }
    }
    return flags
  }

  async function fetchAttendanceContext(userEmail) {
    const today = todayStr()

    try {
      const { data: gs } = await supabase
        .from('settings')
        .select('setting_value')
        .eq('setting_key', 'grace_period_minutes')
        .maybeSingle()
      if (gs?.setting_value) {
        setGracePeriod(parseInt(gs.setting_value) || 10)
      }
    } catch {}

    try {
      const { data: signups } = await supabase
        .from('lab_signup')
        .select('date, start_time, end_time, status')
        .eq('user_email', userEmail)
        .eq('status', 'Confirmed')
        .gte('date', today)
        .lte('date', today + 'T23:59:59')

      if (signups && signups.length > 0) {
        let startMin = Infinity
        let endMin = 0
        signups.forEach(s => {
          const sMin = timeToMinutes(s.start_time)
          const eMin = timeToMinutes(s.end_time)
          if (sMin !== null && sMin < startMin) startMin = sMin
          if (eMin !== null && eMin > endMin) endMin = eMin
        })

        if (startMin !== Infinity) {
          setTodaySignup({ startMin, endMin, slots: signups.length })
          console.log('[TimeClock] Signup found for', userEmail,
            `start=${Math.floor(startMin / 60)}:${String(startMin % 60).padStart(2, '0')}`,
            `end=${Math.floor(endMin / 60)}:${String(endMin % 60).padStart(2, '0')}`)
          return
        }
      }

      setTodaySignup(null)
      console.log('[TimeClock] No signup for', userEmail, 'today')
    } catch {
      setTodaySignup(null)
    }
  }

  async function findOpenPunch(profile) {
    const { data: p1 } = await supabase
      .from('time_clock')
      .select('*')
      .eq('user_id', profile.id)
      .eq('status', 'Punched In')
      .order('punch_in', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (p1) return p1

    if (profile.user_id) {
      const { data: p2 } = await supabase
        .from('time_clock')
        .select('*')
        .eq('user_id', profile.user_id)
        .eq('status', 'Punched In')
        .order('punch_in', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (p2) return p2
    }

    const { data: p3 } = await supabase
      .from('time_clock')
      .select('*')
      .eq('user_email', profile.email)
      .eq('status', 'Punched In')
      .order('punch_in', { ascending: false })
      .limit(1)
      .maybeSingle()
    return p3 || null
  }

  // ── Fetch & cache classes data ──
  async function fetchClassesData() {
    if (classesDataRef.current) return classesDataRef.current
    try {
      const todayStr = new Date().toISOString().substring(0, 10)
      const { data } = await supabase
        .from('classes')
        .select('*')
        .eq('status', 'Active')
        .or(`start_date.is.null,start_date.lte.${todayStr}`)
      classesDataRef.current = data || []
      console.log('[TimeClock] Cached classes data:', (classesDataRef.current).map(c =>
        `${c.course_id} -> "${c.course_name}" (class_id: ${c.class_id})`
      ))
      return classesDataRef.current
    } catch (e) {
      console.error('[TimeClock] Classes fetch error:', e)
      return []
    }
  }

  // ── Look up course name from a course_id code ──
  function lookupCourseName(courseIdCode, classesData) {
    if (!courseIdCode) return ''
    const codeLC = courseIdCode.toLowerCase()
    // Try DB data first
    if (classesData && classesData.length > 0) {
      const match = classesData.find(c =>
        (c.course_id || '').toLowerCase() === codeLC ||
        (c.class_id || '').toLowerCase() === codeLC
      )
      if (match?.course_name) return match.course_name
    }
    // Fallback to hardcoded map
    const codeUC = courseIdCode.toUpperCase()
    if (COURSE_MAP[codeUC]) {
      console.log('[TimeClock] Used COURSE_MAP fallback for', codeUC)
      return COURSE_MAP[codeUC]
    }
    return ''
  }

  // ── Build class list for a user ──
  // classId    = CLS### (DB primary key)
  // courseId   = RICT code e.g. "RICT1630" — PRIMARY display (bold)
  // courseName = human name e.g. "Production Automation" — SECONDARY display (smaller)
  //
  // Work Study users: "Work Study" is injected automatically based on role — no class
  // entry required. Any "Work Study" class in profile.classes is skipped to avoid
  // duplicates (safe to deactivate CLS1007 in Settings).
  async function buildClassList(profile) {
    const isWorkStudy = (profile.role || '').toLowerCase() === 'work study'
    const isTCO = profile.time_clock_only === 'Yes'

    const userClasses = (profile.classes || '').toString()
    // Also detect if "Work Study" is manually listed in the classes field
    // (handles Student-role users who are also work study, e.g. TCO users)
    const hasWorkStudyClass = userClasses.split(',').map(c => c.trim()).some(c => /work.?study/i.test(c))

    const classNames = userClasses
      .split(',')
      .map(c => c.trim())
      .filter(c => c)
      // Skip any manually-entered Work Study class entry — it's auto-injected below
      .filter(c => !/work.?study/i.test(c))

    console.log('[TimeClock] Building class list for', profile.first_name,
      '| role:', profile.role,
      '| profile.classes raw:', JSON.stringify(profile.classes),
      '| parsed (filtered):', classNames)

    let classDetails = []

    // ── Auto-inject Work Study option for work_study role users ──
    // Also inject if "Work Study" is listed in profile.classes (e.g. TCO Student users)
    // Also inject for TCO (Time Clock Only) users — they are hired work study
    if (isWorkStudy || hasWorkStudyClass || isTCO) {
      classDetails.push({
        classId: 'WORK_STUDY',
        courseId: 'Work Study',
        courseName: '',
        requiredHours: 20,
        isWorkStudy: true,
      })
      console.log('[TimeClock] Work Study option injected for role=work study, classes=Work Study, or TCO')
    }

    if (classNames.length > 0) {
      try {
        const classesData = await fetchClassesData()

        console.log('[TimeClock] Available classes in DB:', (classesData || []).map(c =>
          `class_id="${c.class_id}" course_id="${c.course_id}" course_name="${c.course_name}"`
        ))

        for (const name of classNames) {
          const nameLC = name.toLowerCase()
          const detail = (classesData || []).find(c =>
            (c.class_id || '').toLowerCase() === nameLC ||
            (c.course_id || '').toLowerCase() === nameLC ||
            (c.course_name || '').toLowerCase() === nameLC
          )

          if (detail) {
            console.log('[TimeClock] MATCHED "' + name + '" ->',
              'course_id:', detail.course_id,
              'course_name:', detail.course_name)

            classDetails.push({
              classId: detail.class_id,
              courseId: detail.course_id || name,
              courseName: detail.course_name || COURSE_MAP[name.toUpperCase()] || '',
              requiredHours: detail.required_hours || 0,
            })
          } else {
            const fallbackName = COURSE_MAP[name.toUpperCase()] || ''
            console.warn('[TimeClock] NO DB MATCH for "' + name + '" -> fallback:', fallbackName || '(none)')
            classDetails.push({
              classId: `CLASS_${classDetails.length + 1}`,
              courseId: name,
              courseName: fallbackName,
              requiredHours: 0,
            })
          }
        }
      } catch (e) {
        console.error('[TimeClock] Class fetch error:', e)
        classDetails.push(...classNames.map((name, i) => ({
          classId: `CLASS_${i + 1}`,
          courseId: name,
          courseName: COURSE_MAP[name.toUpperCase()] || '',
          requiredHours: 0,
        })))
      }
    }

    // Add Volunteer and Club Activity options (not for TCO users — they only use Work Study)
    if (!isTCO) {
      // Add Volunteer option
      classDetails.push({
        classId: 'VOLUNTEER',
        courseId: 'Volunteer',
        courseName: 'Volunteer hours (requires instructor approval)',
        requiredHours: 10,
        isVolunteer: true,
      })

      // Add Club Activity option — everyone sees this.
      // Treated like volunteer (auto-approved) but only 0.25 hrs credit per actual hour.
      classDetails.push({
        classId: 'CLUB_ACTIVITY',
        courseId: 'Club Activity',
        courseName: '0.25 hrs credit per hour attended',
        requiredHours: 0,
        isClubActivity: true,
      })
    }

    console.log('[TimeClock] Final class list:', classDetails.map(c =>
      `courseId="${c.courseId}" courseName="${c.courseName}" classId="${c.classId}"`
    ))

    return classDetails
  }

  async function loadStudentPunchState(studentProfile) {
    setUser(studentProfile)
    await fetchAttendanceContext(studentProfile.email)
    const openPunch = await findOpenPunch(studentProfile)

    if (openPunch) {
      console.log('[TimeClock] Student has open punch:', openPunch.record_id,
        '| course_id:', openPunch.course_id)

      // Enrich punch record with course name lookup
      const classesData = await fetchClassesData()
      const courseName = lookupCourseName(openPunch.course_id, classesData)
      console.log('[TimeClock] Looked up course name for "' + openPunch.course_id + '" ->',
        courseName ? `"${courseName}"` : '(not found)')
      if (courseName) {
        openPunch._courseName = courseName
      }

      setPunchRecord(openPunch)
      setScreen('punch-out')
    } else {
      const classDetails = await buildClassList(studentProfile)
      setClasses(classDetails)
      setScreen('class-select')
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BADGE SWIPE HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  const handleLookup = useCallback(async (cardId) => {
    setError('')
    setLoading(true)
    classesDataRef.current = null

    try {
      const searchId = cardId.trim().toLowerCase()

      const { data: users, error: userError } = await supabase
        .from('profiles')
        .select('*')
        .eq('status', 'Active')

      if (userError) throw userError

      const foundUser = (users || []).find(u => {
        const userCard = (u.card_id || '').trim().toLowerCase()
        const userEmail = (u.email || '').trim().toLowerCase()
        return (userCard && userCard === searchId) || userEmail === searchId
      })

      if (!foundUser) {
        setError('Card not recognized. Please see an instructor.')
        setLoading(false)
        return
      }

      console.log('[TimeClock] Found user:', foundUser.first_name, foundUser.last_name,
        '| Role:', foundUser.role, '| Classes:', foundUser.classes)

      if (isInstructorRole(foundUser.role)) {
        console.log('[TimeClock] Instructor detected — showing student picker')
        setInstructor(foundUser)

        const studentList = (users || [])
          .filter(u => !isInstructorRole(u.role))
          .sort((a, b) => {
            const nameA = `${a.first_name || ''} ${a.last_name || ''}`.toLowerCase()
            const nameB = `${b.first_name || ''} ${b.last_name || ''}`.toLowerCase()
            return nameA.localeCompare(nameB)
          })

        setStudents(studentList)
        setScreen('student-picker')
        setLoading(false)
        return
      }

      await loadStudentPunchState(foundUser)

    } catch (err) {
      console.error('[TimeClock] Lookup error:', err)
      setError('System error. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSelectStudent = useCallback(async (studentProfile) => {
    setLoading(true)
    setError('')
    try {
      console.log('[TimeClock] Instructor selected student:', studentProfile.first_name,
        studentProfile.last_name, '| Classes:', studentProfile.classes)
      await loadStudentPunchState(studentProfile)
    } catch (err) {
      console.error('[TimeClock] Student load error:', err)
      setError('Failed to load student data.')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Punch In ──
  const handlePunchIn = useCallback(async (cls) => {
    if (!user) return
    setLoading(true)

    try {
      const { data: lastRecord } = await supabase
        .from('time_clock')
        .select('record_id')
        .order('record_id', { ascending: false })
        .limit(1)
        .single()

      let nextNum = 1
      if (lastRecord?.record_id) {
        const num = parseInt(lastRecord.record_id.replace('TC', ''))
        if (!isNaN(num)) nextNum = num + 1
      }
      const recordId = 'TC' + String(nextNum).padStart(6, '0')

      const userName = `${user.first_name || ''} ${(user.last_name || '').charAt(0)}.`.trim()
      const entryType = cls.isVolunteer ? 'Volunteer' : cls.isWorkStudy ? 'Work Study' : cls.isClubActivity ? 'Club Activity' : 'Class'
      // Volunteer time clock punches are auto-approved — instructor is present when they punch in.
      // Only manual "Log Volunteer Hours" requests require approval.
      const approvalStatus = (cls.isVolunteer || cls.isWorkStudy || cls.isClubActivity) ? 'Approved' : 'N/A'

      const description = instructor
        ? `Punched in by instructor: ${instructor.first_name} ${(instructor.last_name || '').charAt(0)}.`
        : ''

      // Store the RICT code in course_id column
      const courseIdForDb = cls.courseId || 'Unknown'

      // IMPORTANT: Use user_id (USR###) not id (UUID) — reports query by user_id
      const userIdForDb = user.user_id || user.id

      const { data: insertedRows, error } = await supabase.from('time_clock').insert({
        record_id: recordId,
        user_id: userIdForDb,
        user_name: userName,
        user_email: user.email,
        class_id: cls.classId,
        course_id: courseIdForDb,
        punch_in: localToUtcIso(new Date()),
        status: 'Punched In',
        total_hours: 0,
        week_start: getWeekStart(),
        entry_type: entryType,
        description,
        approval_status: approvalStatus,
      }).select()

      if (error) throw error

      if (!insertedRows || insertedRows.length === 0) {
        setError('Punch in failed — database permission issue. Please see an instructor.')
        setLoading(false)
        return
      }

      console.log('[TimeClock] Punched in:', recordId, '| for:', userName,
        '| courseId:', cls.courseId, '| courseName:', cls.courseName)

      // Check if this is the first punch today — only flag late/walk-in on first punch
      let isFirstPunchToday = true
      try {
        const today = todayStr()
        const { data: earlierPunches } = await supabase
          .from('time_clock')
          .select('record_id')
          .eq('user_email', user.email)
          .gte('punch_in', today)
          .lte('punch_in', today + 'T23:59:59')
          .neq('record_id', recordId)
          .limit(1)
        if (earlierPunches && earlierPunches.length > 0) {
          isFirstPunchToday = false
          console.log('[TimeClock] Not first punch today — skipping late/walk-in flags')
        }
      } catch (e) {
        console.warn('[TimeClock] Earlier punch check failed:', e)
      }

      const flags = checkPunchInFlags(cls.isVolunteer, !!cls.isWorkStudy, isFirstPunchToday)
      const studentName = instructor ? `${user.first_name} ${(user.last_name || '').charAt(0)}.` : ''

      // Build display: "RICT1630 — Production Automation" or just "Volunteer"
      const classLabel = cls.courseName && !cls.isVolunteer
        ? `${cls.courseId} — ${cls.courseName}`
        : cls.courseId

      setSuccessMsg({
        message: 'Punched In!',
        detail: instructor
          ? `${studentName} — ${classLabel} — ${formatNow()}`
          : `${classLabel} — ${formatNow()}`,
        type: 'in',
        flags,
      })
      setScreen('success')
    } catch (err) {
      console.error('[TimeClock] Punch in error:', err)
      setError('Failed to punch in. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [user, instructor, todaySignup, gracePeriod])

  const handlePunchOut = useCallback(async () => {
    if (!user || !punchRecord) return

    const isVolunteer = punchRecord.entry_type === 'Volunteer'

    if (!isVolunteer && todaySignup && todaySignup.endMin > 0) {
      const now = nowMinutes()
      const earlyBy = todaySignup.endMin - now
      if (earlyBy > gracePeriod) {
        setEarlyInfo({ minutes: earlyBy })
        setScreen('early-warning')
        return
      }
    }

    await executePunchOut(false, false, null)
  }, [user, punchRecord, instructor, todaySignup, gracePeriod])

  const executePunchOut = useCallback(async (earlyDeparture, instructorApproved, approverName) => {
    if (!user || !punchRecord) return
    setLoading(true)

    try {
      const punchOutTime = new Date()
      const punchInTime = new Date(punchRecord.punch_in)
      const nowFakeUtcMs = Date.UTC(punchOutTime.getFullYear(), punchOutTime.getMonth(), punchOutTime.getDate(),
        punchOutTime.getHours(), punchOutTime.getMinutes(), punchOutTime.getSeconds())
      const rawHours = (nowFakeUtcMs - punchInTime.getTime()) / (1000 * 60 * 60)
      // Club Activity earns 0.25 hrs credit per actual hour attended
      const isClubActivityPunch = punchRecord.entry_type === 'Club Activity'
      const totalHours = Math.round((isClubActivityPunch ? rawHours * 0.25 : rawHours) * 100) / 100

      let description = punchRecord.description || ''
      if (instructor) {
        const note = `Punched out by instructor: ${instructor.first_name} ${(instructor.last_name || '').charAt(0)}.`
        description = description ? `${description} | ${note}` : note
      }
      if (instructorApproved && approverName) {
        const note = `Early departure approved by ${approverName}`
        description = description ? `${description} | ${note}` : note
      } else if (earlyDeparture && !instructorApproved) {
        const earlyMins = earlyInfo?.minutes || 0
        const note = earlyMins > 0
          ? `Left early — ${formatMinutes(earlyMins)} before scheduled end`
          : 'Left early'
        description = description ? `${description} | ${note}` : note
      }

      // Determine entry_type:
      //   - Instructor approved early departure → keep original (not penalized)
      //   - Left early without permission → "Left Early" (flagged in reports)
      //   - Normal punch out → keep original entry_type
      let entryType = punchRecord.entry_type
      if (earlyDeparture && !instructorApproved) {
        entryType = 'Left Early'
      }

      const updateData = {
        punch_out: localToUtcIso(punchOutTime),
        total_hours: totalHours,
        status: 'Punched Out',
        description,
        entry_type: entryType,
      }

      // For volunteer/club activity punches, record who approved
      if (punchRecord.entry_type === 'Volunteer' || punchRecord.entry_type === 'Club Activity') {
        updateData.approved_by = instructor
          ? `${instructor.first_name} ${(instructor.last_name || '').charAt(0)}.`
          : 'Time Clock'
        updateData.approved_date = new Date().toISOString()
      }
      // Add note showing actual vs credited hours for Club Activity
      if (isClubActivityPunch) {
        const actualHrsDisplay = Math.round(rawHours * 100) / 100
        const note = `Club Activity: ${actualHrsDisplay}h actual → ${totalHours}h credited (0.25x)`
        updateData.description = updateData.description
          ? `${updateData.description} | ${note}`
          : note
      }

      const { data: updatedRows, error } = await supabase
        .from('time_clock')
        .update(updateData)
        .eq('record_id', punchRecord.record_id)
        .select()

      if (error) throw error

      if (!updatedRows || updatedRows.length === 0) {
        setError('Punch out failed — database permission issue. Please see an instructor.')
        setLoading(false)
        return
      }

      const isVolunteer = punchRecord.entry_type === 'Volunteer'
      let flags = []
      if (!isVolunteer && !instructorApproved) {
        flags = checkPunchOutFlags()
      }

      const studentName = instructor ? `${user.first_name} ${(user.last_name || '').charAt(0)}.` : ''

      // Build class label: "RICT1630 — Production Automation"
      const courseName = punchRecord._courseName || ''
      const courseCode = punchRecord.course_id || ''
      const classLabel = courseName && courseCode
        ? `${courseCode} — ${courseName}`
        : courseCode || ''

      setSuccessMsg({
        message: instructorApproved ? 'Approved & Punched Out!' : 'Punched Out!',
        detail: instructor
          ? `${studentName}${classLabel ? ` — ${classLabel}` : ''} — Total: ${formatDuration(totalHours)}`
          : `${classLabel ? `${classLabel} — ` : ''}Total: ${formatDuration(totalHours)}`,
        type: 'out',
        flags,
      })
      setEarlyInfo(null)
      setScreen('success')
    } catch (err) {
      console.error('[TimeClock] Punch out error:', err)
      setError('Failed to punch out. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [user, punchRecord, instructor, todaySignup, gracePeriod, earlyInfo])

  const handleAcceptEarly = useCallback(() => {
    executePunchOut(true, false, null)
  }, [executePunchOut])

  const handleGetPermission = useCallback(() => {
    setScreen('instructor-approve')
  }, [])

  const handleInstructorApproved = useCallback((approverName) => {
    executePunchOut(true, true, approverName)
  }, [executePunchOut])

  const handleCancelApproval = useCallback(() => {
    setScreen('early-warning')
  }, [])

  function handleCancel() {
    if (instructor && (screen === 'class-select' || screen === 'punch-out')) {
      setUser(null)
      setClasses([])
      setPunchRecord(null)
      setTodaySignup(null)
      setEarlyInfo(null)
      setError('')
      setScreen('student-picker')
    } else {
      resetToSwipe()
    }
  }

  // ── Lab closed: show closed screen instead of punch interface ─────────
  if (labMode === 'summer_break') {
    return <LabClosedScreen />
  }

  // Still determining mode — render nothing briefly to avoid flash
  if (labMode === 'unknown') {
    return (
      <div style={{
        width: '800px', height: '480px',
        background: '#0f2744',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: 32, height: 32, border: '3px solid rgba(147,197,253,0.3)',
          borderTopColor: '#93c5fd', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div className="bg-gray-50 flex flex-col overflow-hidden" style={{ width: '800px', height: '480px' }}>
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-4 py-2.5 flex items-center justify-between shadow-lg flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-white leading-tight">Time Clock</h1>
            <p className="text-[10px] text-blue-100">RICT CMMS</p>
          </div>
        </div>
        <LiveClock />
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {screen === 'swipe' && (
          <SwipeScreen onLookup={handleLookup} error={error} loading={loading} />
        )}
        {screen === 'student-picker' && (
          <StudentPickerScreen
            instructor={instructor}
            students={students}
            onSelectStudent={handleSelectStudent}
            onCancel={resetToSwipe}
            loading={loading}
          />
        )}
        {screen === 'class-select' && (
          <ClassSelectScreen
            user={user} classes={classes}
            onPunchIn={handlePunchIn} onCancel={handleCancel}
            loading={loading} proxyInstructor={instructor}
          />
        )}
        {screen === 'punch-out' && (
          <PunchOutScreen
            user={user} punchRecord={punchRecord}
            onPunchOut={handlePunchOut} onCancel={handleCancel}
            loading={loading} proxyInstructor={instructor}
          />
        )}
        {screen === 'early-warning' && (
          <EarlyWarningScreen
            earlyMinutes={earlyInfo?.minutes || 0}
            onAccept={handleAcceptEarly}
            onGetPermission={handleGetPermission}
            loading={loading}
          />
        )}
        {screen === 'instructor-approve' && (
          <InstructorApproveScreen
            user={user}
            onApproved={handleInstructorApproved}
            onCancel={handleCancelApproval}
            loading={loading}
          />
        )}
        {screen === 'success' && (
          <SuccessScreen {...successMsg} />
        )}
      </div>
    </div>
  )
}