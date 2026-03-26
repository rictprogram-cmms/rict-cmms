/**
 * RICT CMMS - WOC Ratio Page (React/Supabase)
 * Faithfully reproduces the GAS Evaluation page with updated scoring.
 *
 * Scoring:
 *   Base: 100%
 *   −2% per school day for late WOs assigned to you (open AND closed-late)
 *   −1% per school day for all team late WOs (open AND closed-late, shared penalty)
 *   −1% per school day for stale WOs (no update in >4 school days)
 *   +1% per school day early for completed WOs (before due date)
 *   Floor: 0%, Cap: 100%
 *
 * School days: Mon–Thu only, excluding US holidays + custom closed days.
 *
 * Features:
 *   - Date range picker with quick presets for scoping evaluations
 *   - Closed-late WOs now factor into penalties (not just open WOs)
 *   - Personal score card with animated gauge + rank medal
 *   - Breakdown grid (personal, team, stale, early)
 *   - Completion time comparison (you vs team)
 *   - Detail list of every deduction/reward
 *   - Instructor view: all-users table ranked by score
 *   - Manage custom closed days (instructor)
 *   - Info box explaining the scoring formula
 */

import React, { useState, useMemo } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useWOCRatio, useClosedDaysActions } from '@/hooks/useWOCRatio'
import {
  Loader2, TrendingUp, TrendingDown, AlertTriangle, Award, Clock,
  Users, ChevronDown, ChevronUp, CalendarOff, Plus, Trash2, Info,
  Target, Zap, Timer, BarChart3, X, RefreshCw, Calendar, CheckCircle2,
  CalendarRange
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function scoreClass(score) {
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 50) return 'warning'
  return 'poor'
}

function scoreColor(score) {
  if (score >= 90) return '#22c55e'
  if (score >= 75) return '#3b82f6'
  if (score >= 50) return '#f59e0b'
  return '#ef4444'
}

function scoreBg(score) {
  if (score >= 90) return 'rgba(34,197,94,0.1)'
  if (score >= 75) return 'rgba(59,130,246,0.1)'
  if (score >= 50) return 'rgba(245,158,11,0.1)'
  return 'rgba(239,68,68,0.1)'
}

function scoreLabel(score) {
  if (score >= 90) return 'Excellent'
  if (score >= 75) return 'Good'
  if (score >= 50) return 'Needs Improvement'
  return 'Critical'
}

function formatDate(val) {
  if (!val) return '—'
  try {
    return new Date(val).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    })
  } catch { return '—' }
}

function formatDateShort(val) {
  if (!val) return '—'
  try {
    return new Date(val + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    })
  } catch { return '—' }
}

/** Get medal palette based on rank */
function getMedalPalette(rank) {
  if (rank === 1) return {
    outer: '#d4a017', mid: '#f5c842', inner: '#ffe066', shine: '#fffbe6',
    ribbon1: '#2563eb', ribbon2: '#1d4ed8', text: '#7c5a00', star: true
  }
  if (rank === 2) return {
    outer: '#8a8a8a', mid: '#b8b8b8', inner: '#d4d4d4', shine: '#f0f0f0',
    ribbon1: '#2563eb', ribbon2: '#1d4ed8', text: '#555', star: true
  }
  if (rank === 3) return {
    outer: '#a0522d', mid: '#cd7f32', inner: '#dea05c', shine: '#f0d0a0',
    ribbon1: '#2563eb', ribbon2: '#1d4ed8', text: '#6b3a12', star: true
  }
  return {
    outer: '#4a6fa5', mid: '#6b8fc2', inner: '#93b4e0', shine: '#d0e2f7',
    ribbon1: '#475569', ribbon2: '#334155', text: '#1e3a5f', star: false
  }
}

/** Get ordinal suffix */
function getOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/** Get semester date presets */
function getDatePresets() {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()

  // Current semester guess: Jan-May = Spring, Aug-Dec = Fall
  const isSpring = month >= 0 && month <= 5
  const springStart = `${year}-01-13`
  const springEnd = `${year}-05-16`
  const fallStart = `${year}-08-25`
  const fallEnd = `${year}-12-19`
  const prevFallStart = `${year - 1}-08-25`
  const prevFallEnd = `${year - 1}-12-19`

  // This month
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const nextMonth = month === 11 ? new Date(year + 1, 0, 1) : new Date(year, month + 1, 1)
  const monthEnd = new Date(nextMonth.getTime() - 86400000)
  const monthEndStr = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`

  // Last month
  const prevMonthEnd = new Date(year, month, 0)
  const prevMonthStart = `${prevMonthEnd.getFullYear()}-${String(prevMonthEnd.getMonth() + 1).padStart(2, '0')}-01`
  const prevMonthEndStr = `${prevMonthEnd.getFullYear()}-${String(prevMonthEnd.getMonth() + 1).padStart(2, '0')}-${String(prevMonthEnd.getDate()).padStart(2, '0')}`

  // Last 30 days
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)
  const todayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const thirtyStr = `${thirtyDaysAgo.getFullYear()}-${String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(thirtyDaysAgo.getDate()).padStart(2, '0')}`

  const presets = [
    { label: 'All Time', start: '', end: '' },
    { label: 'Last 30 Days', start: thirtyStr, end: todayStr },
    { label: 'This Month', start: monthStart, end: monthEndStr },
    { label: 'Last Month', start: prevMonthStart, end: prevMonthEndStr },
  ]

  if (isSpring) {
    presets.push({ label: 'Spring Semester', start: springStart, end: springEnd })
    presets.push({ label: 'Fall Semester (Prev)', start: prevFallStart, end: prevFallEnd })
  } else {
    presets.push({ label: 'Fall Semester', start: fallStart, end: fallEnd })
    presets.push({ label: 'Spring Semester', start: springStart, end: springEnd })
  }

  return presets
}

// ═══════════════════════════════════════════════════════════════════════════════
// RANK MEDALLION COMPONENT (SVG-based realistic medal)
// ═══════════════════════════════════════════════════════════════════════════════

function RankMedal({ rank, total }) {
  if (!rank || !total) return null

  const p = getMedalPalette(rank)
  const isTop3 = rank <= 3
  const size = 110

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg width={size} height={size + 22} viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Medal face gradient */}
          <radialGradient id={`medal-face-${rank}`} cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor={p.shine} />
            <stop offset="40%" stopColor={p.inner} />
            <stop offset="80%" stopColor={p.mid} />
            <stop offset="100%" stopColor={p.outer} />
          </radialGradient>
          {/* Medal rim gradient */}
          <radialGradient id={`medal-rim-${rank}`} cx="50%" cy="50%" r="50%">
            <stop offset="85%" stopColor={p.mid} />
            <stop offset="100%" stopColor={p.outer} />
          </radialGradient>
          {/* Drop shadow */}
          <filter id={`medal-shadow-${rank}`} x="-20%" y="-10%" width="140%" height="150%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#00000030" />
          </filter>
          {/* Inner ring pattern */}
          <linearGradient id={`medal-ring-${rank}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={p.outer} />
            <stop offset="50%" stopColor={p.shine} />
            <stop offset="100%" stopColor={p.outer} />
          </linearGradient>
        </defs>

        {/* Ribbon tails (behind medal) */}
        <polygon points="42,12 36,55 48,45" fill={p.ribbon1} />
        <polygon points="42,12 30,50 42,42" fill={p.ribbon2} opacity="0.8" />
        <polygon points="78,12 84,55 72,45" fill={p.ribbon1} />
        <polygon points="78,12 90,50 78,42" fill={p.ribbon2} opacity="0.8" />

        {/* Ribbon connector bar */}
        <rect x="38" y="6" width="44" height="14" rx="3" fill={p.ribbon1} />
        <rect x="38" y="6" width="44" height="7" rx="3" fill={p.ribbon2} opacity="0.3" />
        {/* Ribbon stripes */}
        <line x1="48" y1="7" x2="48" y2="19" stroke="#ffffff30" strokeWidth="1.5" />
        <line x1="60" y1="7" x2="60" y2="19" stroke="#ffffff30" strokeWidth="1.5" />
        <line x1="72" y1="7" x2="72" y2="19" stroke="#ffffff30" strokeWidth="1.5" />

        {/* Medal body */}
        <g filter={`url(#medal-shadow-${rank})`}>
          {/* Outer rim */}
          <circle cx="60" cy="78" r="44" fill={`url(#medal-rim-${rank})`} />
          {/* Notched edge (serrated border) */}
          {Array.from({ length: 32 }).map((_, i) => {
            const angle = (i / 32) * Math.PI * 2
            const x = 60 + Math.cos(angle) * 43
            const y = 78 + Math.sin(angle) * 43
            return <circle key={i} cx={x} cy={y} r="2.5" fill={p.outer} opacity="0.6" />
          })}
          {/* Inner ring */}
          <circle cx="60" cy="78" r="39" fill="none" stroke={`url(#medal-ring-${rank})`} strokeWidth="2" />
          {/* Medal face */}
          <circle cx="60" cy="78" r="36" fill={`url(#medal-face-${rank})`} />
          {/* Inner decorative ring */}
          <circle cx="60" cy="78" r="30" fill="none" stroke={p.outer} strokeWidth="1" opacity="0.4" />
          <circle cx="60" cy="78" r="28" fill="none" stroke={p.outer} strokeWidth="0.5" opacity="0.25" />

          {/* Star decoration for top 3 */}
          {p.star && (
            <g opacity="0.2">
              {/* Small stars around the inner ring */}
              {[0, 72, 144, 216, 288].map((deg, i) => {
                const rad = (deg * Math.PI) / 180
                const sx = 60 + Math.cos(rad) * 29
                const sy = 78 + Math.sin(rad) * 29
                return (
                  <polygon
                    key={i}
                    points={`${sx},${sy - 3} ${sx + 1},${sy - 1} ${sx + 3},${sy - 1} ${sx + 1.5},${sy + 0.5} ${sx + 2},${sy + 3} ${sx},${sy + 1.5} ${sx - 2},${sy + 3} ${sx - 1.5},${sy + 0.5} ${sx - 3},${sy - 1} ${sx - 1},${sy - 1}`}
                    fill={p.text}
                  />
                )
              })}
            </g>
          )}

          {/* Shine highlight */}
          <ellipse cx="50" cy="66" rx="18" ry="10" fill="#ffffff" opacity="0.15" transform="rotate(-20,50,66)" />
        </g>

        {/* Rank text */}
        {isTop3 ? (
          <>
            <text x="60" y="74" textAnchor="middle" fontSize="14" fontWeight="800"
              fill={p.text} fontFamily="system-ui, -apple-system, sans-serif" opacity="0.7">
              {rank === 1 ? '★' : rank === 2 ? '★' : '★'}
            </text>
            <text x="60" y="92" textAnchor="middle" fontSize="18" fontWeight="900"
              fill={p.text} fontFamily="system-ui, -apple-system, sans-serif" letterSpacing="1">
              {getOrdinal(rank).toUpperCase()}
            </text>
          </>
        ) : (
          <>
            <text x="60" y="83" textAnchor="middle" fontSize="20" fontWeight="900"
              fill={p.text} fontFamily="system-ui, -apple-system, sans-serif" letterSpacing="0.5">
              {getOrdinal(rank)}
            </text>
          </>
        )}

        {/* "RANK" label at bottom of medal */}
        <text x="60" y="102" textAnchor="middle" fontSize="7" fontWeight="700"
          fill={p.text} fontFamily="system-ui, -apple-system, sans-serif"
          letterSpacing="2.5" opacity="0.5">
          RANK
        </text>
      </svg>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORE GAUGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function ScoreGauge({ score }) {
  const color = scoreColor(score)
  const circumference = 2 * Math.PI * 54
  const offset = circumference - (score / 100) * circumference

  return (
    <div style={{ position: 'relative', width: 140, height: 140 }}>
      <svg width="140" height="140" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="54" fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx="60" cy="60" r="54" fill="none"
          stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transform: 'rotate(-90deg)', transformOrigin: '60px 60px',
            transition: 'stroke-dashoffset 1s ease-out'
          }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center'
      }}>
        <span style={{ fontSize: 32, fontWeight: 800, color }}>{Math.round(score)}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>/ 100</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// BREAKDOWN CARD
// ═══════════════════════════════════════════════════════════════════════════════

function BreakdownCard({ icon: Icon, label, value, isNegative, isPositive }) {
  const color = isPositive ? '#22c55e' : isNegative ? '#ef4444' : '#64748b'
  const bg = isPositive ? 'rgba(34,197,94,0.08)' : isNegative ? 'rgba(239,68,68,0.08)' : 'rgba(100,116,139,0.08)'
  const prefix = isPositive ? '+' : isNegative ? '−' : ''

  return (
    <div style={{
      background: bg, borderRadius: 12, padding: '16px 20px',
      display: 'flex', alignItems: 'center', gap: 14, minWidth: 0
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0
      }}>
        <Icon size={20} color={color} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color }}>
          {prefix}{Math.abs(value)}%
        </div>
        <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>{label}</div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAT CARD
// ═══════════════════════════════════════════════════════════════════════════════

function StatCard({ icon: Icon, label, value, sub, color = '#3b82f6' }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 12, padding: '20px',
      border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 14
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: `${color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0
      }}>
        <Icon size={22} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>{value}</div>
        <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATE RANGE PICKER
// ═══════════════════════════════════════════════════════════════════════════════

function DateRangePicker({ startDate, endDate, onStartChange, onEndChange }) {
  const [showPresets, setShowPresets] = useState(false)
  const presets = useMemo(() => getDatePresets(), [])

  const activePreset = presets.find(p => p.start === startDate && p.end === endDate)
  const hasRange = startDate || endDate

  const handlePreset = (preset) => {
    onStartChange(preset.start)
    onEndChange(preset.end)
    setShowPresets(false)
  }

  const handleClear = () => {
    onStartChange('')
    onEndChange('')
  }

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
      padding: '16px 20px', marginBottom: 20
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          color: '#475569', fontWeight: 600, fontSize: 14, flexShrink: 0
        }}>
          <CalendarRange size={18} color="#3b82f6" />
          Evaluation Period:
        </div>

        {/* Start Date */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>From</label>
          <input
            type="date"
            value={startDate}
            onChange={e => onStartChange(e.target.value)}
            style={{
              padding: '7px 12px', borderRadius: 8, border: '1px solid #e2e8f0',
              fontSize: 13, color: '#1a1a2e', background: '#f8fafc', minWidth: 140
            }}
          />
        </div>

        {/* End Date */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>To</label>
          <input
            type="date"
            value={endDate}
            onChange={e => onEndChange(e.target.value)}
            style={{
              padding: '7px 12px', borderRadius: 8, border: '1px solid #e2e8f0',
              fontSize: 13, color: '#1a1a2e', background: '#f8fafc', minWidth: 140
            }}
          />
        </div>

        {/* Presets toggle */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowPresets(!showPresets)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8,
              border: '1px solid #e2e8f0', background: '#f8fafc',
              cursor: 'pointer', fontSize: 13, fontWeight: 500,
              color: '#3b82f6'
            }}
          >
            <Calendar size={14} />
            {activePreset ? activePreset.label : 'Quick Select'}
            <ChevronDown size={14} />
          </button>

          {showPresets && (
            <>
              {/* Click-away overlay */}
              <div
                onClick={() => setShowPresets(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 99 }}
              />
              <div style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4,
                background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 100,
                minWidth: 200, overflow: 'hidden'
              }}>
                {presets.map(p => (
                  <button
                    key={p.label}
                    onClick={() => handlePreset(p)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '10px 16px', border: 'none',
                      background: activePreset?.label === p.label ? '#eff6ff' : 'transparent',
                      color: activePreset?.label === p.label ? '#2563eb' : '#475569',
                      fontWeight: activePreset?.label === p.label ? 600 : 400,
                      fontSize: 13, cursor: 'pointer',
                      borderBottom: '1px solid #f1f5f9'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc' }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = activePreset?.label === p.label ? '#eff6ff' : 'transparent'
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Clear button */}
        {hasRange && (
          <button
            onClick={handleClear}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '7px 12px', borderRadius: 8,
              border: '1px solid #fecaca', background: '#fef2f2',
              cursor: 'pointer', fontSize: 12, fontWeight: 500,
              color: '#dc2626'
            }}
          >
            <X size={14} />
            Clear
          </button>
        )}
      </div>

      {/* Active range indicator */}
      {hasRange && (
        <div style={{
          marginTop: 10, display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 12, color: '#64748b'
        }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%', background: '#3b82f6'
          }} />
          Showing scores for: <strong style={{ color: '#1a1a2e' }}>
            {startDate ? formatDateShort(startDate) : 'Beginning'}
            {' — '}
            {endDate ? formatDateShort(endDate) : 'Today'}
          </strong>
          {activePreset && activePreset.label !== 'All Time' && (
            <span style={{
              background: '#eff6ff', color: '#2563eb', padding: '2px 8px',
              borderRadius: 4, fontWeight: 600
            }}>
              {activePreset.label}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSED DAYS MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

function ClosedDaysManager({ closedDays, onRefresh }) {
  const { saving, addClosedDay, removeClosedDay, getHolidaysForYear } = useClosedDaysActions()
  const [newDate, setNewDate] = useState('')
  const [showHolidays, setShowHolidays] = useState(false)

  const year = new Date().getFullYear()
  const holidays = useMemo(() => getHolidaysForYear(year), [year, getHolidaysForYear])

  const formattedClosed = useMemo(() => {
    return closedDays
      .map(d => {
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        return { date: ds, label: formatDate(ds) }
      })
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [closedDays])

  const handleAdd = async () => {
    if (!newDate) return
    await addClosedDay(newDate)
    setNewDate('')
    onRefresh()
  }

  const handleRemove = async (dateStr) => {
    await removeClosedDay(dateStr)
    onRefresh()
  }

  return (
    <div style={{
      background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
      overflow: 'hidden', marginTop: 24
    }}>
      <div style={{
        padding: '20px 24px', borderBottom: '1px solid #e2e8f0',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CalendarOff size={20} color="#f59e0b" />
          <span style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>
            Manage School Closed Days
          </span>
        </div>
        <button
          onClick={() => setShowHolidays(!showHolidays)}
          style={{
            background: 'none', border: '1px solid #e2e8f0', borderRadius: 8,
            padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#3b82f6',
            fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6
          }}
        >
          <Calendar size={14} />
          {showHolidays ? 'Hide' : 'Show'} US Holidays
        </button>
      </div>

      <div style={{ padding: '20px 24px' }}>
        {/* Add closed day */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <input
            type="date"
            value={newDate}
            onChange={e => setNewDate(e.target.value)}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 8,
              border: '1px solid #e2e8f0', fontSize: 14, color: '#1a1a2e'
            }}
          />
          <button
            onClick={handleAdd}
            disabled={saving || !newDate}
            style={{
              padding: '10px 20px', borderRadius: 8, border: 'none',
              background: '#3b82f6', color: '#fff', fontWeight: 600,
              fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              opacity: saving || !newDate ? 0.5 : 1
            }}
          >
            <Plus size={16} /> Add Closed Day
          </button>
        </div>

        {/* Custom closed days list */}
        {formattedClosed.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '16px 0', color: '#94a3b8', fontSize: 14 }}>
            No custom closed days set
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {formattedClosed.map(d => (
              <div key={d.date} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#fef3c7', borderRadius: 8, padding: '6px 12px',
                fontSize: 13, fontWeight: 500, color: '#92400e'
              }}>
                <span>{d.label}</span>
                <button
                  onClick={() => handleRemove(d.date)}
                  disabled={saving}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                    color: '#92400e', opacity: saving ? 0.5 : 0.7
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* US Holidays */}
        {showHolidays && (
          <div style={{
            background: '#f8fafc', borderRadius: 10, padding: 16, marginTop: 8,
            border: '1px solid #e2e8f0'
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1a2e', marginBottom: 10 }}>
              US Holidays ({year}) — Automatically Excluded
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {holidays.map(h => (
                <div key={h.date} style={{
                  background: '#e2e8f0', borderRadius: 6, padding: '4px 10px',
                  fontSize: 12, color: '#475569'
                }}>
                  {h.name} — {h.label}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETAIL TABLE (deduction/reward breakdown)
// ═══════════════════════════════════════════════════════════════════════════════

function DetailTable({ details }) {
  const [expanded, setExpanded] = useState(false)

  if (!details || details.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: 24, color: '#22c55e',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8
      }}>
        <CheckCircle2 size={32} />
        <span style={{ fontWeight: 600 }}>No deductions — great work!</span>
      </div>
    )
  }

  const shown = expanded ? details : details.slice(0, 5)

  const typeLabels = {
    personal_late: { label: 'Personal Late', color: '#ef4444', icon: '⚠️' },
    team_late: { label: 'Team Late', color: '#f59e0b', icon: '👥' },
    stale: { label: 'Stale (>4 days)', color: '#8b5cf6', icon: '🕐' },
    early_completion: { label: 'Early Completion', color: '#22c55e', icon: '🏆' }
  }

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: '10px 12px', color: '#64748b', fontWeight: 600 }}>Type</th>
              <th style={{ textAlign: 'left', padding: '10px 12px', color: '#64748b', fontWeight: 600 }}>WO ID</th>
              <th style={{ textAlign: 'left', padding: '10px 12px', color: '#64748b', fontWeight: 600 }}>Description</th>
              <th style={{ textAlign: 'center', padding: '10px 12px', color: '#64748b', fontWeight: 600 }}>Source</th>
              <th style={{ textAlign: 'right', padding: '10px 12px', color: '#64748b', fontWeight: 600 }}>Days</th>
              <th style={{ textAlign: 'right', padding: '10px 12px', color: '#64748b', fontWeight: 600 }}>Impact</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d, i) => {
              const t = typeLabels[d.type] || { label: d.type, color: '#64748b', icon: '•' }
              const impact = d.type === 'early_completion'
                ? `+${d.reward}%`
                : `−${d.deduction}%`
              const impactColor = d.type === 'early_completion' ? '#22c55e' : '#ef4444'
              const sourceLabel = d.source === 'closed' ? 'Closed' : 'Open'
              const sourceBg = d.source === 'closed' ? '#f0fdf4' : '#fefce8'
              const sourceColor = d.source === 'closed' ? '#15803d' : '#a16207'

              return (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: `${t.color}14`, color: t.color,
                      borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600
                    }}>
                      {t.icon} {t.label}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 600, color: '#1a1a2e' }}>{d.woId}</td>
                  <td style={{ padding: '10px 12px', color: '#475569' }}>{d.description}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '2px 8px',
                      borderRadius: 4, background: sourceBg, color: sourceColor
                    }}>
                      {sourceLabel}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: '#1a1a2e' }}>{d.days}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: impactColor }}>{impact}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {details.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, margin: '12px auto 0',
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#3b82f6', fontSize: 13, fontWeight: 600
          }}
        >
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {expanded ? 'Show less' : `Show all ${details.length} items`}
        </button>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALL USERS TABLE (instructor view)
// ═══════════════════════════════════════════════════════════════════════════════

function AllUsersTable({ scores, teamCompletion }) {
  const [expandedUser, setExpandedUser] = useState(null)

  if (!scores || scores.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>
        No student/work study evaluations to display
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e2e8f0', background: '#f8fafc' }}>
            <th style={{ textAlign: 'left', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>#</th>
            <th style={{ textAlign: 'left', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Name</th>
            <th style={{ textAlign: 'left', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Role</th>
            <th style={{ textAlign: 'center', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Score</th>
            <th style={{ textAlign: 'right', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Personal</th>
            <th style={{ textAlign: 'right', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Team</th>
            <th style={{ textAlign: 'right', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Stale</th>
            <th style={{ textAlign: 'right', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Early Bonus</th>
            <th style={{ textAlign: 'right', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Avg Days</th>
            <th style={{ textAlign: 'right', padding: '12px 14px', color: '#64748b', fontWeight: 600 }}>Open WOs</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((u, i) => {
            const sc = scoreColor(u.score)
            const isExpanded = expandedUser === u.email

            return (
              <React.Fragment key={u.email}>
                <tr
                  onClick={() => setExpandedUser(isExpanded ? null : u.email)}
                  style={{
                    borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
                    background: isExpanded ? '#f8fafc' : 'transparent',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = '#fafbfc' }}
                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent' }}
                >
                  <td style={{ padding: '12px 14px', color: '#94a3b8', fontWeight: 600 }}>{i + 1}</td>
                  <td style={{ padding: '12px 14px', fontWeight: 600, color: '#1a1a2e' }}>
                    {u.name}
                    {i === 0 && <span style={{ marginLeft: 8, fontSize: 14 }}>🥇</span>}
                    {i === 1 && <span style={{ marginLeft: 8, fontSize: 14 }}>🥈</span>}
                    {i === 2 && <span style={{ marginLeft: 8, fontSize: 14 }}>🥉</span>}
                  </td>
                  <td style={{ padding: '12px 14px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
                      background: u.role === 'Work Study' ? '#dbeafe' : '#f1f5f9',
                      color: u.role === 'Work Study' ? '#1d4ed8' : '#475569'
                    }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                    <span style={{
                      display: 'inline-block', minWidth: 52, padding: '4px 12px',
                      borderRadius: 8, fontWeight: 800, fontSize: 15,
                      color: sc, background: scoreBg(u.score)
                    }}>
                      {Math.round(u.score)}%
                    </span>
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: u.personalDeduction > 0 ? '#ef4444' : '#94a3b8', fontWeight: 600 }}>
                    {u.personalDeduction > 0 ? `−${u.personalDeduction}%` : '0'}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: u.teamDeduction > 0 ? '#f59e0b' : '#94a3b8', fontWeight: 600 }}>
                    {u.teamDeduction > 0 ? `−${u.teamDeduction}%` : '0'}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: u.staleDays > 0 ? '#8b5cf6' : '#94a3b8', fontWeight: 600 }}>
                    {u.staleDays > 0 ? `−${u.staleDays}%` : '0'}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: u.earlyDays > 0 ? '#22c55e' : '#94a3b8', fontWeight: 600 }}>
                    {u.earlyDays > 0 ? `+${u.earlyDays}%` : '0'}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#1a1a2e' }}>
                    {u.avgCompletionDays > 0 ? `${u.avgCompletionDays}d` : '—'}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600, color: '#1a1a2e' }}>
                    {u.openWOs}
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={10} style={{ padding: '0 14px 16px 14px', background: '#f8fafc' }}>
                      <DetailTable details={u.details} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function WOCRatioPage() {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('WOC Ratio')
  const isInstructor = hasPerm('view_all_scores')

  // Date range state
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const {
    loading, myScore, allScores, teamStats,
    teamCompletion, closedDaysList, refresh
  } = useWOCRatio({ canViewAll: isInstructor, startDate: startDate || null, endDate: endDate || null })

  const [tab, setTab] = useState('my') // my | team | settings

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Loader2 size={32} className="animate-spin" color="#3b82f6" />
      </div>
    )
  }

  if (!myScore) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
        Unable to load evaluation data. Please try again.
      </div>
    )
  }

  const sc = myScore.score
  const comp = myScore.completion
  const compClass = comp.avgDays <= teamCompletion.avgDays ? 'faster' : 'slower'

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 0 40px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 24, flexWrap: 'wrap', gap: 12
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 12,
            background: 'linear-gradient(135deg, #f59e0b, #d97706)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Target size={22} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: '#1a1a2e', margin: 0 }}>
              WOC Ratio
            </h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
              Work Order Completion Evaluation
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={refresh}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e8f0',
              background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#475569'
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Date Range Picker */}
      <DateRangePicker
        startDate={startDate}
        endDate={endDate}
        onStartChange={setStartDate}
        onEndChange={setEndDate}
      />

      {/* Info Banner */}
      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12,
        padding: '14px 20px', marginBottom: 24, display: 'flex', gap: 12, alignItems: 'flex-start'
      }}>
        <Info size={18} color="#3b82f6" style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ fontSize: 13, color: '#1e40af', lineHeight: 1.6 }}>
          <strong>Scoring:</strong> Start at 100%.
          Deductions: <strong>−2%</strong>/school day for your late WOs (open <em>and</em> closed late),{' '}
          <strong>−1%</strong>/day for all team late WOs (open <em>and</em> closed late),{' '}
          <strong>−1%</strong>/day for stale WOs (no update &gt;4 school days).
          Reward: <strong>+1%</strong>/school day early for on-time completions.
          Only Mon–Thu count (holidays &amp; school closed days excluded). Capped at 100%.
          <br />
          <strong style={{ color: '#1e3a5f' }}>Note:</strong> Closing a late work order still counts the late days from due date to close date — the penalty does not disappear.
        </div>
      </div>

      {/* Tabs (instructor only sees team tab) */}
      {isInstructor && (
        <div style={{
          display: 'flex', gap: 4, marginBottom: 24,
          background: '#f1f5f9', borderRadius: 10, padding: 4, width: 'fit-content'
        }}>
          {[
            { key: 'my', label: 'My Score', icon: Target },
            { key: 'team', label: 'All Students', icon: Users },
            { key: 'settings', label: 'Closed Days', icon: CalendarOff }
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 18px', borderRadius: 8, border: 'none',
                background: tab === t.key ? '#fff' : 'transparent',
                boxShadow: tab === t.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                color: tab === t.key ? '#1a1a2e' : '#64748b',
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ═══════ MY SCORE TAB ═══════ */}
      {tab === 'my' && (
        <>
          {/* Score Card */}
          <div style={{
            background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
            overflow: 'hidden', marginBottom: 24
          }}>
            <div style={{
              padding: '28px 32px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: 24
            }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>
                  Your Evaluation Score
                </div>
                <div style={{ fontSize: 14, color: '#64748b' }}>
                  {myScore.user.name} — {myScore.user.role}
                </div>
                <div style={{
                  marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '4px 14px', borderRadius: 8,
                  background: scoreBg(sc), color: scoreColor(sc),
                  fontWeight: 700, fontSize: 14
                }}>
                  {sc >= 75 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                  {scoreLabel(sc)}
                </div>
              </div>

              {/* Rank Medal + Score Gauge side by side */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 24
              }}>
                <RankMedal rank={myScore.rank} total={myScore.totalRanked} />
                <ScoreGauge score={sc} />
              </div>
            </div>

            {/* Breakdown grid */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 12, padding: '0 32px 28px'
            }}>
              <BreakdownCard
                icon={AlertTriangle}
                label="Personal (Your Late WOs)"
                value={myScore.personalDeduction}
                isNegative={myScore.personalDeduction > 0}
              />
              <BreakdownCard
                icon={Users}
                label="Team (All Late WOs)"
                value={myScore.teamDeduction}
                isNegative={myScore.teamDeduction > 0}
              />
              <BreakdownCard
                icon={Clock}
                label="Stale (>4 days no update)"
                value={myScore.staleDays}
                isNegative={myScore.staleDays > 0}
              />
              <BreakdownCard
                icon={Zap}
                label="Early Completion Bonus"
                value={myScore.totalReward}
                isPositive={myScore.totalReward > 0}
              />
            </div>
          </div>

          {/* Completion Time + Team Stats */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16, marginBottom: 24
          }}>
            <StatCard
              icon={Timer}
              label="Your Avg Completion"
              value={comp.totalCompleted > 0 ? `${comp.avgDays} days` : 'N/A'}
              sub={comp.totalCompleted > 0 ? `${comp.totalCompleted} WOs completed` : 'No completed WOs yet'}
              color="#3b82f6"
            />
            <StatCard
              icon={BarChart3}
              label="Team Avg Completion"
              value={teamCompletion.totalCompleted > 0 ? `${teamCompletion.avgDays} days` : 'N/A'}
              sub={`${teamCompletion.totalCompleted} total team completions`}
              color="#8b5cf6"
            />
            <StatCard
              icon={Target}
              label="Your Open WOs"
              value={comp.openWOs}
              sub={comp.openWOs > 0 ? `Avg ${comp.avgDaysOpen} days open` : 'All clear!'}
              color="#f59e0b"
            />
            <StatCard
              icon={AlertTriangle}
              label="Late WOs (Open + Closed)"
              value={`${teamStats.lateCount}${teamStats.closedLateCount > 0 ? ` + ${teamStats.closedLateCount} closed` : ''}`}
              sub={teamStats.totalLateDays > 0 ? `${teamStats.totalLateDays} total late school days` : 'No late WOs'}
              color="#ef4444"
            />
          </div>

          {/* Detail breakdown */}
          <div style={{
            background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
            overflow: 'hidden'
          }}>
            <div style={{
              padding: '18px 24px', borderBottom: '1px solid #e2e8f0',
              display: 'flex', alignItems: 'center', gap: 10
            }}>
              <BarChart3 size={18} color="#3b82f6" />
              <span style={{ fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>
                Score Breakdown Details
              </span>
              <span style={{
                marginLeft: 'auto', fontSize: 12, color: '#94a3b8',
                background: '#f1f5f9', padding: '3px 10px', borderRadius: 6
              }}>
                {myScore.details.length} items
              </span>
            </div>
            <div style={{ padding: '16px 24px' }}>
              <DetailTable details={myScore.details} />
            </div>
          </div>
        </>
      )}

      {/* ═══════ TEAM TAB (Instructor) ═══════ */}
      {tab === 'team' && isInstructor && (
        <div style={{
          background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
          overflow: 'hidden'
        }}>
          <div style={{
            padding: '18px 24px', borderBottom: '1px solid #e2e8f0',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Award size={18} color="#f59e0b" />
              <span style={{ fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>
                All Student &amp; Work Study Evaluations
              </span>
            </div>
            <span style={{
              fontSize: 12, color: '#64748b', background: '#f1f5f9',
              padding: '4px 12px', borderRadius: 6, fontWeight: 500
            }}>
              {allScores.length} users • Team avg: {teamCompletion.avgDays}d completion
            </span>
          </div>
          <AllUsersTable scores={allScores} teamCompletion={teamCompletion} />
        </div>
      )}

      {/* ═══════ SETTINGS TAB (Instructor) ═══════ */}
      {tab === 'settings' && isInstructor && (
        <ClosedDaysManager closedDays={closedDaysList} onRefresh={refresh} />
      )}
    </div>
  )
}
