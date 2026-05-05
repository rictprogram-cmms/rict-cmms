/**
 * RICT CMMS – TV Display Page
 *
 * Public page (no auth required) for TV/Kiosk display
 * Route: /tv-display
 *
 * Features:
 *  - Left: Scrolling open work orders sorted by due date
 *  - Right Top: Open WO count, Total late days, Avg days open
 *  - Right Bottom: Lab attendance — who's here, expected, walk-ins
 *  - Real-time updates via Supabase subscriptions (work_orders, time_clock, lab_signup, profiles)
 *  - Fallback polling every 5 minutes for resilience
 *  - Weather display for St. Cloud, MN (Open-Meteo API)
 *  - Large text optimised for TV display
 *  - Dark theme
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

// ── Weather code helpers ────────────────────────────────────────────
const WEATHER_EMOJI = {
  0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',
  51:'🌧️',53:'🌧️',55:'🌧️',56:'🌧️',57:'🌧️',
  61:'🌧️',63:'🌧️',65:'🌧️',66:'🌧️',67:'🌧️',
  71:'🌨️',73:'🌨️',75:'🌨️',77:'🌨️',
  80:'🌧️',81:'🌧️',82:'🌧️',85:'🌨️',86:'🌨️',
  95:'⛈️',96:'⛈️',99:'⛈️',
}
const WEATHER_DESC = {
  0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
  45:'Foggy',48:'Rime fog',51:'Light drizzle',53:'Drizzle',55:'Dense drizzle',
  56:'Freezing drizzle',57:'Freezing drizzle',
  61:'Light rain',63:'Rain',65:'Heavy rain',66:'Freezing rain',67:'Freezing rain',
  71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',
  80:'Light showers',81:'Showers',82:'Heavy showers',
  85:'Snow showers',86:'Heavy snow showers',
  95:'Thunderstorm',96:'Thunderstorm + hail',99:'Thunderstorm + hail',
}

// ── Utility ─────────────────────────────────────────────────────────
function formatTimeTv(dateObj) {
  if (!dateObj) return ''
  const h = dateObj.getHours()
  const ampm = h >= 12 ? 'pm' : 'am'
  const disp = h % 12 || 12
  return `${disp}${ampm}`
}

function firstLastInit(fullName) {
  if (!fullName) return ''
  const parts = fullName.trim().split(' ')
  let out = parts[0]
  if (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (last.length > 0) out += ' ' + last.charAt(0) + '.'
  }
  return out
}

// Fallback polling interval (5 minutes) — realtime handles instant updates,
// this is a safety net in case a subscription message is missed
const FALLBACK_POLL_MS = 5 * 60 * 1000

// ════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════
export default function TVDisplayPage() {
  const [clock, setClock] = useState('')
  const [dateStr, setDateStr] = useState('')
  const [weather, setWeather] = useState({ temp: '--', icon: '🌡️', desc: 'Loading…' })
  const [stats, setStats] = useState({ openCount: 0, totalLateDays: 0, avgDaysOpen: 0 })
  const [workOrders, setWorkOrders] = useState([])
  const [people, setPeople] = useState([])
  const [helpQueue, setHelpQueue] = useState([])
  const [lastUpdated, setLastUpdated] = useState('--')
  const [instructorAway, setInstructorAway] = useState(false)
  const [awayReturnTime, setAwayReturnTime] = useState('')
  // Today's hour-level lab closures (e.g. "2-3pm Faculty Meeting")
  // Each entry: { startMin, endMin, startStr, endStr, reason, isCurrent, isUpcoming }
  const [todayClosures, setTodayClosures] = useState([])

  const woScrollRef = useRef(null)
  const pplScrollRef = useRef(null)

  // ── Auto-refresh page at midnight so deployed updates take effect ──
  useEffect(() => {
    function scheduleMidnightRefresh() {
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      const msUntilMidnight = midnight.getTime() - now.getTime()
      console.log('[TVDisplay] Auto-refresh scheduled in', Math.round(msUntilMidnight / 60000), 'minutes')
      return setTimeout(() => {
        console.log('[TVDisplay] Midnight refresh triggered')
        window.location.reload()
      }, msUntilMidnight)
    }
    const timer = scheduleMidnightRefresh()
    return () => clearTimeout(timer)
  }, [])

  // ── Instructor Away Mode ──────────────────────────────────────
  useEffect(() => {
    async function loadAwayMode() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('setting_key, setting_value')
          .in('setting_key', ['instructor_away_mode', 'instructor_return_time'])
        if (data) {
          const modeRow = data.find(r => r.setting_key === 'instructor_away_mode')
          const timeRow = data.find(r => r.setting_key === 'instructor_return_time')
          setInstructorAway(modeRow?.setting_value === 'true')
          setAwayReturnTime(timeRow?.setting_value || '')
        }
      } catch { /* ignore */ }
    }
    loadAwayMode()

    const channel = supabase
      .channel('tv-away-mode')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_away_mode',
      }, (p) => { setInstructorAway(p.new?.setting_value === 'true') })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'settings',
        filter: 'setting_key=eq.instructor_return_time',
      }, (p) => { setAwayReturnTime(p.new?.setting_value || '') })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── Clock tick ──────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setClock(now.toLocaleTimeString('en-US'))
      setDateStr(now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      }))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // ── Weather (Open-Meteo, St Cloud MN) ──────────────────────────
  const loadWeather = useCallback(async () => {
    try {
      const res = await fetch(
        'https://api.open-meteo.com/v1/forecast?latitude=45.5579&longitude=-94.1632&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America/Chicago'
      )
      const data = await res.json()
      if (data?.current) {
        setWeather({
          temp: Math.round(data.current.temperature_2m) + '°F',
          icon: WEATHER_EMOJI[data.current.weather_code] || '🌡️',
          desc: WEATHER_DESC[data.current.weather_code] || '',
        })
      }
    } catch (e) {
      console.error('Weather error:', e)
    }
  }, [])

  useEffect(() => {
    loadWeather()
    const id = setInterval(loadWeather, 600_000) // every 10 min
    return () => clearInterval(id)
  }, [loadWeather])

  // ── Load TV display data ──────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const now = new Date()

      // Plain date string for lab_signup queries (date column stores 'YYYY-MM-DD')
      const todayStr = today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0')

      // ---------- 1. Open Work Orders ----------
      const { data: wos } = await supabase
        .from('work_orders')
        .select('wo_id, description, priority, status, asset_name, assigned_to, due_date, created_at')
        .neq('status', 'Closed')
        .order('due_date', { ascending: true, nullsFirst: false })

      let totalLateDays = 0
      let totalDaysOpen = 0
      const orders = (wos || []).map(wo => {
        // Parse date-only strings as LOCAL midnight (appending T00:00:00 prevents
        // JS from treating them as UTC, which would shift the date back one day in CT)
        const dueDate = wo.due_date
          ? new Date(wo.due_date.substring(0, 10) + 'T00:00:00')
          : null
        const createdDate = wo.created_at ? new Date(wo.created_at) : null
        let isLate = false
        let daysLate = 0

        if (createdDate) {
          const cd = new Date(createdDate); cd.setHours(0,0,0,0)
          totalDaysOpen += Math.max(0, Math.floor((today - cd) / 86400000))
        }
        if (dueDate) {
          // dueDate is already local midnight — compare directly with today (also local midnight)
          if (dueDate < today) {
            isLate = true
            daysLate = Math.floor((today - dueDate) / 86400000)
            totalLateDays += daysLate
          }
        }
        return { ...wo, dueDate, isLate, daysLate }
      })

      const openCount = orders.length
      const avgDaysOpen = openCount > 0 ? Math.round((totalDaysOpen / openCount) * 10) / 10 : 0
      setStats({ openCount, totalLateDays, avgDaysOpen })
      setWorkOrders(orders)

      // ---------- 2. Time-clock-only emails to exclude ----------
      // Use email as the universal key (lab_signup has no user_id populated)
      const { data: allUsers } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name, time_clock_only')

      const tcoEmails = new Set()
      ;(allUsers || []).forEach(u => {
        if (u.time_clock_only === 'Yes' && u.email) {
          tcoEmails.add(u.email.toLowerCase())
        }
      })

      // ---------- 3. Currently punched-in users (today) ----------
      const todayISO = today.toISOString()
      const { data: tcRows } = await supabase
        .from('time_clock')
        .select('user_id, user_name, user_email, punch_in, punch_out, status')
        .gte('punch_in', todayISO)
        .eq('status', 'Punched In')

      // Key by email (lowercased) — matches how lab_signup will be keyed
      const loggedIn = {}
      ;(tcRows || []).forEach(row => {
        const email = (row.user_email || '').toLowerCase()
        if (!email || tcoEmails.has(email)) return
        loggedIn[email] = { userName: row.user_name }
      })

      // ---------- 4. Today's lab signups ----------
      // Use plain date string to match the date column format
      const { data: signups } = await supabase
        .from('lab_signup')
        .select('user_id, user_name, user_email, start_time, end_time, status')
        .eq('date', todayStr)
        .neq('status', 'Cancelled')

      // Key by email (lowercased) — user_id is empty in lab_signup
      const signedUp = {}
      ;(signups || []).forEach(row => {
        const email = (row.user_email || '').toLowerCase()
        if (!email || tcoEmails.has(email)) return
        if (!signedUp[email]) {
          signedUp[email] = { userName: row.user_name, timeBlocks: [] }
        }
        // Parse time strings (HH:mm:ss) into Date objects for today
        const parseTime = t => {
          if (!t) return null
          const [hh, mm] = String(t).split(':')
          const d = new Date(today)
          d.setHours(parseInt(hh, 10), parseInt(mm || 0, 10), 0, 0)
          return d
        }
        const start = parseTime(row.start_time)
        const end = parseTime(row.end_time)
        if (start && end) signedUp[email].timeBlocks.push({ start, end })
      })

      // ---------- 5. Group time-blocks into sessions ----------
      for (const email in signedUp) {
        const s = signedUp[email]
        s.timeBlocks.sort((a, b) => a.start - b.start)
        const sessions = []
        let cur = null
        s.timeBlocks.forEach(b => {
          if (!cur) { cur = { start: b.start, end: b.end } }
          else if (b.start.getTime() === cur.end.getTime()) { cur.end = b.end }
          else { sessions.push(cur); cur = { start: b.start, end: b.end } }
        })
        if (cur) sessions.push(cur)
        s.sessions = sessions
      }

      // ---------- 6. Build people list ----------
      const allPeople = {}
      for (const email in loggedIn) {
        allPeople[email] = {
          userName: loggedIn[email].userName,
          isLoggedIn: true, isSignedUp: false, sessions: [],
        }
      }
      for (const email in signedUp) {
        if (allPeople[email]) {
          allPeople[email].isSignedUp = true
          allPeople[email].sessions = signedUp[email].sessions
        } else {
          allPeople[email] = {
            userName: signedUp[email].userName,
            isLoggedIn: false, isSignedUp: true, sessions: signedUp[email].sessions,
          }
        }
      }

      const pplList = []
      for (const email in allPeople) {
        const p = allPeople[email]
        let status = '', timeRange = ''

        // find current / next session
        let curSession = null, nextSession = null
        for (const sess of p.sessions) {
          if (sess.start <= now && sess.end > now) curSession = sess
          else if (sess.start > now && !nextSession) nextSession = sess
        }

        if (p.isLoggedIn) {
          if (p.isSignedUp && curSession) {
            status = 'good'
            timeRange = 'Until ' + formatTimeTv(curSession.end)
          } else {
            status = p.isSignedUp ? 'good' : 'unexpected'
          }
        } else if (p.isSignedUp) {
          if (curSession) {
            status = 'missing'
            timeRange = formatTimeTv(curSession.start) + ' – ' + formatTimeTv(curSession.end)
          } else if (nextSession) {
            status = 'expected'
            timeRange = formatTimeTv(nextSession.start) + ' – ' + formatTimeTv(nextSession.end)
          }
        }
        if (!status) continue

        pplList.push({
          displayName: firstLastInit(p.userName),
          status,
          timeRange,
          initials: (p.userName || '').split(' ').map(n => n.charAt(0)).join('').toUpperCase(),
          earliestStart: p.sessions.length > 0 ? p.sessions[0].start.getTime() : null,
        })
      }

      // Sort: earliest start time first, then by status as tiebreaker
      const statusOrder = { missing: 0, expected: 1, unexpected: 2, good: 3 }
      pplList.sort((a, b) => {
        const aTime = a.earliestStart ?? Infinity
        const bTime = b.earliestStart ?? Infinity
        if (aTime !== bTime) return aTime - bTime
        return (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
      })
      setPeople(pplList)

      // ---------- 7. Help Queue ----------
      const { data: helpRows } = await supabase
        .from('help_requests')
        .select('*')
        .in('status', ['pending', 'acknowledged'])
        .order('requested_at', { ascending: true })

      const now2 = new Date()
      const helpList = (helpRows || [])
        .filter(h => {
          // Filter out expired acknowledged requests
          if (h.status === 'acknowledged' && h.expires_at) {
            return new Date(h.expires_at) > now2
          }
          return true
        })
        .map(h => ({
          requestId: h.request_id,
          displayName: firstLastInit(h.user_name),
          initials: (h.user_name || '').split(' ').map(n => n.charAt(0)).join('').toUpperCase(),
          status: h.status, // 'pending' or 'acknowledged'
          location: h.location || '',
          requestedAt: h.requested_at,
          acknowledgedBy: h.acknowledged_by,
        }))
      setHelpQueue(helpList)

      // ---------- 8. Today's hour-level closures ----------
      // Query the day's calendar row, parse closed_blocks, and label each
      // block as current / upcoming / past relative to the wall clock.
      try {
        const { data: calToday } = await supabase
          .from('lab_calendar')
          .select('closed_blocks, status')
          .eq('date', todayStr + 'T12:00:00')
          .maybeSingle()

        const raw = calToday?.closed_blocks
        let arr = raw
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr) } catch { arr = [] }
        }
        if (!Array.isArray(arr)) arr = []

        const nowMin = now.getHours() * 60 + now.getMinutes()
        const parseMin = (t) => {
          const m = String(t || '').match(/^(\d{1,2}):(\d{2})/)
          if (!m) return null
          return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
        }
        const fmt12 = (t) => {
          const m = parseMin(t)
          if (m == null) return t || ''
          const h = Math.floor(m / 60)
          const mm = m % 60
          const ap = h >= 12 ? 'PM' : 'AM'
          const dh = h % 12 || 12
          return mm === 0 ? `${dh}:00 ${ap}` : `${dh}:${String(mm).padStart(2, '0')} ${ap}`
        }

        const closures = arr
          .map(b => {
            const sm = parseMin(b?.start)
            const em = parseMin(b?.end)
            if (sm == null || em == null || em <= sm) return null
            return {
              startMin:   sm,
              endMin:     em,
              startStr:   fmt12(b.start),
              endStr:     fmt12(b.end),
              reason:     (b?.reason && String(b.reason).trim()) || 'Lab closed',
              isCurrent:  sm <= nowMin && nowMin < em,
              isUpcoming: sm > nowMin,
              isPast:     em <= nowMin,
            }
          })
          .filter(Boolean)
          // Hide past closures — they no longer matter to anyone walking up
          .filter(c => !c.isPast)
          .sort((a, b) => a.startMin - b.startMin)

        setTodayClosures(closures)
      } catch (closureErr) {
        console.error('TV display closure load error:', closureErr)
        setTodayClosures([])
      }

      setLastUpdated(new Date().toLocaleTimeString('en-US'))
    } catch (e) {
      console.error('TV display load error:', e)
    }
  }, [])

  // ── Real-time subscriptions ─────────────────────────────────────
  // Instant updates when work orders, time clock entries, lab signups,
  // or user profiles change. Replaces the old 90-second polling loop.
  useEffect(() => {
    const channel = supabase
      .channel('tv-display-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, () => { loadData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, () => { loadData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { loadData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' }, () => { loadData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { loadData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'help_requests' }, () => { loadData() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadData])

  // ── Minute-tick refresh so closure "isCurrent / isUpcoming" labels stay accurate ──
  // (The data itself doesn't change, just our derived now-relative flags.)
  useEffect(() => {
    const id = setInterval(loadData, 60_000)
    return () => clearInterval(id)
  }, [loadData])

  // ── Fallback polling (5 min) — safety net if a realtime message is missed ──
  useEffect(() => {
    loadData()
    const id = setInterval(loadData, FALLBACK_POLL_MS)
    return () => clearInterval(id)
  }, [loadData])

  // ── Auto-scroll work orders ────────────────────────────────────
  useEffect(() => {
    const el = woScrollRef.current
    if (!el) return
    const container = el.parentElement
    if (el.scrollHeight > container.clientHeight) {
      const speed = Math.max(30, workOrders.length * 4)
      el.style.animation = `scrollUp ${speed}s linear infinite`
    } else {
      el.style.animation = 'none'
    }
  }, [workOrders])

  // ── Auto-scroll people ─────────────────────────────────────────
  useEffect(() => {
    const el = pplScrollRef.current
    if (!el) return
    const container = el.parentElement
    if (el.scrollHeight > container.clientHeight) {
      const speed = Math.max(20, people.length * 3)
      el.style.animation = `scrollPeople ${speed}s linear infinite`
    } else {
      el.style.animation = 'none'
    }
  }, [people])

  // ── Priority dot colour ────────────────────────────────────────
  const dotColour = p => {
    const lp = (p || '').toLowerCase()
    if (lp === 'high' || lp === 'critical' || lp === 'emergency') return '#ef4444'
    if (lp === 'low') return '#22c55e'
    return '#f59e0b'
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════
  return (
    <div style={S.page}>
      <style>{KEYFRAMES}</style>

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.logo}>RICT <span style={{ color: '#3b82f6' }}>CMMS</span></span>
        </div>
        <div style={S.headerCenter}>
          <div style={S.weatherBox}>
            <span style={S.weatherIcon}>{weather.icon}</span>
            <div>
              <div style={S.weatherTemp}>{weather.temp}</div>
              <div style={S.weatherDesc}>{weather.desc}</div>
            </div>
          </div>
        </div>
        <div style={S.headerRight}>
          <div style={S.clock}>{clock}</div>
          <div style={S.date}>{dateStr}</div>
        </div>
      </header>

      {/* ── INSTRUCTOR AWAY BANNER ────────────────────────────── */}
      {instructorAway && (
        <div style={S.awayBanner} role="alert" aria-live="polite">
          <span style={S.awayIcon}>🏢</span>
          <div>
            <div style={S.awayTitle}>Instructors are in a meeting</div>
            <div style={S.awayText}>
              {awayReturnTime
                ? `They will be back around ${awayReturnTime}. Requests will be seen when they return.`
                : 'Requests will be seen and responded to as soon as they are back.'}
            </div>
          </div>
        </div>
      )}

      {/* ── TODAY'S LAB CLOSURES BANNER ─────────────────────────
          Surfaces hour-level closures (e.g. 2-3pm Faculty Meeting) so
          students walking in can see the lab is unavailable for that
          window without checking the signup page. */}
      {todayClosures.length > 0 && (
        <div
          style={{
            ...S.closureBanner,
            top: 80 + (instructorAway ? 60 : 0),
          }}
          role="status"
          aria-live="polite"
        >
          <span style={S.closureIcon} aria-hidden="true">🚫</span>
          <div style={S.closureBody}>
            <div style={S.closureTitle}>
              {todayClosures.some(c => c.isCurrent)
                ? 'Lab is closed right now'
                : 'Lab closures today'}
            </div>
            <div style={S.closureChips}>
              {todayClosures.map((c, i) => (
                <span
                  key={i}
                  style={{
                    ...S.closureChip,
                    ...(c.isCurrent ? S.closureChipActive : {}),
                  }}
                  title={c.reason}
                >
                  <strong style={{ marginRight: 6 }}>{c.startStr}–{c.endStr}</strong>
                  {c.reason}
                  {c.isCurrent && <span style={S.closureNowDot} aria-label=" — currently in effect" />}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── MAIN ───────────────────────────────────────────────── */}
      <div style={{
        ...S.main,
        ...((instructorAway || todayClosures.length > 0) ? (() => {
          const offset = (instructorAway ? 60 : 0) + (todayClosures.length > 0 ? 76 : 0)
          return { marginTop: 80 + offset, height: `calc(100vh - ${80 + offset}px)` }
        })() : {})
      }}>
        {/* LEFT — Work Orders */}
        <div style={S.woPanel}>
          <div style={S.panelHeader}>
            <span style={S.panelIcon}>📋</span>
            <h2 style={S.panelTitle}>Open Work Orders</h2>
          </div>
          <div style={S.woList}>
            <div ref={woScrollRef} style={S.woScroll}>
              {workOrders.length === 0 ? (
                <div style={S.empty}>No open work orders 🎉</div>
              ) : (
                <>
                  {/* Render twice for seamless loop when scrolling */}
                  {[...workOrders, ...(workOrders.length > 6 ? workOrders : [])].map((wo, i) => (
                    <div key={`${wo.wo_id}-${i}`} style={{
                      ...S.woCard,
                      ...(wo.isLate ? S.woCardLate : {}),
                    }}>
                      <div style={S.woIdRow}>
                        <span style={S.woId}>{wo.wo_id}</span>
                        <span style={{ ...S.priorityDot, background: dotColour(wo.priority) }} />
                      </div>
                      <div style={S.woInfo}>
                        <div style={S.woDesc}>{wo.description}</div>
                        <div style={S.woMeta}>
                          <span>{firstLastInit(wo.assigned_to)}</span>
                          <span style={{ color: '#475569' }}>•</span>
                          <span>{wo.asset_name || ''}</span>
                        </div>
                      </div>
                      <div style={S.woDue}>
                        <div style={{ ...S.woDueDate, ...(wo.isLate ? { color: '#ef4444' } : {}) }}>
                          {wo.dueDate
                            ? wo.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            : 'No date'}
                        </div>
                        {wo.isLate && (
                          <div style={S.woLateBadge}>
                            {wo.daysLate} day{wo.daysLate > 1 ? 's' : ''} late
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — Stats + People */}
        <div style={S.rightPanel}>
          {/* Stats cards */}
          <div style={S.statsGrid}>
            <div style={{ ...S.statCard, borderLeft: '4px solid #3b82f6' }}>
              <div style={{ ...S.statValue, color: '#3b82f6' }}>{stats.openCount}</div>
              <div style={S.statLabel}>Open WOs</div>
            </div>
            <div style={{ ...S.statCard, borderLeft: '4px solid #ef4444' }}>
              <div style={{ ...S.statValue, color: '#ef4444' }}>{stats.totalLateDays}</div>
              <div style={S.statLabel}>Late Days</div>
            </div>
          </div>
          <div style={{ ...S.statCard, borderLeft: '4px solid #f59e0b' }}>
            <div style={{ ...S.statValue, color: '#f59e0b' }}>{stats.avgDaysOpen}</div>
            <div style={S.statLabel}>Avg Days Open</div>
          </div>

          {/* Help Queue */}
          {helpQueue.length > 0 && (() => {
            const hasPending = helpQueue.some(h => h.status === 'pending')
            return (
            <div style={{
              ...S.helpPanel,
              animation: hasPending ? 'helpPanelGlow 1.5s ease-in-out infinite' : 'none',
              border: hasPending ? '2px solid #ef4444' : '2px solid transparent',
            }}>
              <div style={{
                ...S.panelHeader,
                borderBottom: '3px solid #ef4444',
                background: hasPending ? undefined : '#3b1c1c',
                animation: hasPending ? 'helpHeaderFlash 1.5s ease-in-out infinite' : 'none',
              }}>
                <span style={{ ...S.panelIcon, animation: hasPending ? 'helpIconBounce 0.8s ease-in-out infinite' : 'none' }}>🙋</span>
                <h2 style={{
                  ...S.panelTitle,
                  animation: hasPending ? 'helpTextPulse 1.5s ease-in-out infinite' : 'none',
                }}>Need Help</h2>
                <span style={{
                  marginLeft: 'auto', background: '#ef4444', color: 'white',
                  padding: '4px 14px', borderRadius: 20, fontSize: '1.1rem', fontWeight: 700,
                  animation: hasPending ? 'helpBadgePop 1s ease-in-out infinite' : 'none',
                }}>{helpQueue.length}</span>
              </div>
              <div style={S.helpList}>
                {helpQueue.map((h, i) => {
                  const isAcked = h.status === 'acknowledged'
                  return (
                    <div key={h.requestId} style={{
                      ...S.helpCard,
                      background: isAcked ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                      borderLeft: isAcked ? '4px solid #22c55e' : '4px solid #ef4444',
                    }}>
                      <div style={{
                        ...S.helpDot,
                        background: isAcked ? '#22c55e' : '#ef4444',
                        boxShadow: isAcked ? '0 0 8px #22c55e80' : '0 0 12px #ef4444',
                        animation: isAcked ? 'none' : 'helpDotPulse 1s ease-in-out infinite',
                      }} />
                      <div style={S.helpName}>
                        {h.displayName}
                        {h.location && (
                          <span style={{
                            marginLeft: 12, fontSize: '0.95rem', fontWeight: 600,
                            color: '#94a3b8', background: '#334155',
                            padding: '3px 10px', borderRadius: 8,
                          }}>
                            {h.location}
                          </span>
                        )}
                      </div>
                      <div style={{
                        ...S.helpStatus,
                        color: isAcked ? '#22c55e' : '#ef4444',
                        background: isAcked ? '#22c55e15' : '#ef444415',
                        animation: isAcked ? 'none' : 'helpTextPulse 1.5s ease-in-out infinite',
                        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
                        gap: 2, lineHeight: 1.3,
                      }}>
                        <span>{isAcked ? '✓ Responding' : 'Waiting...'}</span>
                        {isAcked && h.acknowledgedBy && (
                          <span style={{
                            fontSize: '0.85rem', fontWeight: 700, color: '#86efac',
                          }}>
                            {h.acknowledgedBy}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            )
          })()}

          {/* People */}
          <div style={S.peoplePanel}>
            <div style={S.panelHeader}>
              <span style={S.panelIcon}>👥</span>
              <h2 style={S.panelTitle}>Lab Attendance</h2>
            </div>
            <div style={S.peopleList}>
              <div ref={pplScrollRef} style={S.pplScroll}>
                {people.length === 0 ? (
                  <div style={S.empty}>No one in lab today</div>
                ) : (
                  <>
                    {[...people, ...(people.length > 6 ? people : [])].map((p, i) => {
                      const bg = p.status === 'good' ? '#22c55e'
                        : p.status === 'missing' ? '#ef4444'
                        : p.status === 'expected' ? '#f59e0b'
                        : '#f97316'
                      const cardBg = p.status === 'missing' ? 'rgba(239,68,68,0.15)'
                        : p.status === 'unexpected' ? 'rgba(249,115,22,0.15)'
                        : p.status === 'expected' ? 'rgba(245,158,11,0.08)'
                        : 'transparent'
                      const statusText = p.status === 'missing' ? 'Missing'
                        : p.status === 'expected' ? 'Expected'
                        : p.status === 'unexpected' ? 'Walk-in' : 'Here'
                      const statusBg = p.status === 'good' ? '#22c55e20'
                        : p.status === 'missing' ? '#ef444420'
                        : p.status === 'expected' ? '#f59e0b20'
                        : '#f9731620'
                      const statusColor = bg

                      return (
                        <div key={`${p.displayName}-${i}`} style={{
                          ...S.personCard,
                          background: cardBg,
                        }}>
                          <div style={{ ...S.personAvatar, background: bg }}>{p.initials}</div>
                          <div style={S.personName}>{p.displayName}</div>
                          <div style={S.personStatus}>
                            <div style={{
                              ...S.personStatusText,
                              background: statusBg,
                              color: statusColor,
                            }}>
                              {statusText}
                            </div>
                            {p.timeRange && (
                              <div style={{ ...S.personTimeRange, color: statusColor }}>
                                {p.timeRange}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            </div>
            <div style={S.lastUpdated}>Updated: {lastUpdated}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// CSS KEYFRAMES
// ════════════════════════════════════════════════════════════════════
const KEYFRAMES = `
@keyframes scrollUp {
  0%   { transform: translateY(0); }
  100% { transform: translateY(-50%); }
}
@keyframes scrollPeople {
  0%   { transform: translateY(0); }
  100% { transform: translateY(-50%); }
}
@keyframes awayPulse {
  0%, 100% { box-shadow: 0 2px 12px rgba(239,68,68,0.3); }
  50% { box-shadow: 0 2px 24px rgba(239,68,68,0.6); }
}
@keyframes helpDotPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.4); }
}
@keyframes helpPanelGlow {
  0%, 100% { box-shadow: 0 0 8px rgba(239,68,68,0.3), inset 0 0 8px rgba(239,68,68,0.05); }
  50% { box-shadow: 0 0 30px rgba(239,68,68,0.7), inset 0 0 15px rgba(239,68,68,0.1); }
}
@keyframes helpHeaderFlash {
  0%, 100% { background: #3b1c1c; }
  50% { background: #7f1d1d; }
}
@keyframes helpIconBounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
@keyframes helpTextPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
@keyframes helpBadgePop {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}
`

// ════════════════════════════════════════════════════════════════════
// INLINE STYLES (TV-optimised – large text, dark theme)
// ════════════════════════════════════════════════════════════════════
const S = {
  page: {
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    background: '#0f172a',
    color: '#fff',
    height: '100vh',
    overflow: 'hidden',
    margin: 0,
    padding: 0,
  },

  // ── Header ──
  header: {
    position: 'fixed', top: 0, left: 0, right: 0, height: 80,
    background: 'linear-gradient(135deg, #1e293b, #334155)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 32px', zIndex: 100,
    borderBottom: '3px solid #3b82f6',
  },
  headerLeft: { flex: 1 },
  headerCenter: { flex: '0 0 auto' },
  headerRight: { flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 20 },
  logo: { fontSize: '2rem', fontWeight: 700 },
  clock: { fontSize: '1.75rem', fontWeight: 600, color: '#94a3b8' },
  date: { fontSize: '1.25rem', color: '#64748b' },
  weatherBox: {
    display: 'flex', alignItems: 'center', gap: 16,
    background: '#1e293b', padding: '12px 24px', borderRadius: 12,
  },
  weatherIcon: { fontSize: '2.5rem' },
  weatherTemp: { fontSize: '2rem', fontWeight: 700 },
  weatherDesc: { fontSize: '1rem', color: '#94a3b8', maxWidth: 120 },

  // ── Main grid ──
  main: {
    marginTop: 80,
    height: 'calc(100vh - 80px)',
    display: 'grid',
    gridTemplateColumns: '1fr 450px',
    gap: 24,
    padding: 24,
  },

  // ── Panels ──
  panelHeader: {
    padding: '20px 24px',
    background: '#334155',
    borderBottom: '3px solid #3b82f6',
    display: 'flex', alignItems: 'center', gap: 16,
  },
  panelIcon: { fontSize: '2rem' },
  panelTitle: { fontSize: '1.5rem', fontWeight: 600, margin: 0 },

  // ── Work Orders (left) ──
  woPanel: {
    background: '#1e293b', borderRadius: 16, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  woList: { flex: 1, overflow: 'hidden', position: 'relative' },
  woScroll: { position: 'absolute', top: 0, left: 0, right: 0 },
  woCard: {
    padding: '20px 24px', borderBottom: '1px solid #334155',
    display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 20, alignItems: 'center',
  },
  woCardLate: {
    background: 'rgba(239,68,68,0.1)', borderLeft: '5px solid #ef4444',
  },
  woIdRow: { display: 'flex', alignItems: 'center', gap: 12 },
  woId: { fontWeight: 700, fontSize: '2.5rem', color: '#3b82f6' },
  priorityDot: { display: 'inline-block', width: 24, height: 24, borderRadius: '50%', flexShrink: 0 },
  woInfo: { minWidth: 0 },
  woDesc: { fontSize: '1.3rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  woMeta: { fontSize: '1.1rem', color: '#64748b', marginTop: 6, display: 'flex', gap: 12 },
  woDue: { textAlign: 'right' },
  woDueDate: { fontSize: '1.2rem', fontWeight: 600, color: '#94a3b8' },
  woLateBadge: { fontSize: '1rem', color: '#fbbf24', marginTop: 4 },

  // ── Right panel ──
  rightPanel: { display: 'flex', flexDirection: 'column', gap: 16 },

  // ── Stats ──
  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  statCard: { background: '#1e293b', borderRadius: 12, padding: 16, textAlign: 'center' },
  statValue: { fontSize: '2.5rem', fontWeight: 800, lineHeight: 1 },
  statLabel: {
    fontSize: '0.85rem', color: '#94a3b8', marginTop: 8,
    textTransform: 'uppercase', letterSpacing: '0.5px',
  },

  // ── People (right bottom) ──
  peoplePanel: {
    flex: 1, background: '#1e293b', borderRadius: 16, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  peopleList: { flex: 1, overflow: 'hidden', position: 'relative' },
  pplScroll: { position: 'absolute', top: 0, left: 0, right: 0 },
  personCard: {
    padding: '18px 24px', borderBottom: '1px solid #334155',
    display: 'flex', alignItems: 'center', gap: 16,
  },
  personAvatar: {
    width: 52, height: 52, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: '1.25rem', color: '#fff', flexShrink: 0,
  },
  personName: { fontSize: '1.4rem', fontWeight: 500 },
  personStatus: { marginLeft: 'auto', textAlign: 'right' },
  personStatusText: {
    fontSize: '1rem', padding: '6px 14px', borderRadius: 12, display: 'inline-block',
  },
  personTimeRange: { fontSize: '0.85rem', marginTop: 4 },
  lastUpdated: { textAlign: 'center', padding: 12, fontSize: '1rem', color: '#475569' },

  // ── Help Queue (right panel) ──
  helpPanel: {
    background: '#1e293b', borderRadius: 16, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  helpList: {
    padding: '8px 0',
    maxHeight: 260,
    overflowY: 'auto',
  },
  helpCard: {
    padding: '14px 20px',
    display: 'flex', alignItems: 'center', gap: 16,
    borderBottom: '1px solid #334155',
  },
  helpDot: {
    width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
  },
  helpName: {
    fontSize: '1.3rem', fontWeight: 600, flex: 1,
  },
  helpStatus: {
    fontSize: '0.95rem', fontWeight: 600, padding: '6px 14px',
    borderRadius: 12, flexShrink: 0,
  },

  // ── Empty state ──
  empty: { padding: 48, textAlign: 'center', color: '#64748b', fontSize: '1.25rem' },

  // ── Instructor Away Banner ──
  awayBanner: {
    position: 'fixed', top: 80, left: 0, right: 0, zIndex: 99,
    display: 'flex', alignItems: 'center', gap: 20,
    padding: '14px 32px',
    background: 'linear-gradient(135deg, #7f1d1d, #991b1b)',
    borderBottom: '3px solid #ef4444',
    animation: 'awayPulse 3s ease-in-out infinite',
  },
  awayIcon: { fontSize: '2rem', flexShrink: 0 },
  awayTitle: { fontSize: '1.4rem', fontWeight: 700, color: '#fecaca' },
  awayText: { fontSize: '1.1rem', color: '#fca5a5', marginTop: 2 },

  // ── Today's Closures Banner ──
  closureBanner: {
    position: 'fixed', left: 0, right: 0, zIndex: 98,
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '10px 32px', minHeight: 76,
    background: 'linear-gradient(135deg, #422006, #78350f)',
    borderBottom: '2px solid #d97706',
  },
  closureIcon: { fontSize: '1.75rem', flexShrink: 0 },
  closureBody: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
  closureTitle: { fontSize: '1.05rem', fontWeight: 700, color: '#fde68a' },
  closureChips: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  closureChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 10px', borderRadius: 8,
    background: 'rgba(252,211,77,0.12)', border: '1px solid #b45309',
    color: '#fde68a', fontSize: '0.9rem',
  },
  closureChipActive: {
    background: 'rgba(239,68,68,0.18)', border: '1px solid #ef4444',
    color: '#fecaca', fontWeight: 600,
  },
  closureNowDot: {
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: '#ef4444', marginLeft: 6, boxShadow: '0 0 6px #ef4444',
  },
}
