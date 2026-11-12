/**
 * RICT CMMS — AllDoneSection
 *
 * The "All Done" card shown at the top of a student's Individual Time Card.
 * Replaces the retired Weekly Labs Tracker page as the home of the
 * instructor-swipe All Done flow (labs are tracked in D2L now).
 *
 *   • Not yet done today → "All Done — Instructor Swipe" button → AllDoneModal
 *   • Done today          → green confirmation (who / when) + punch-out reminder
 *     while the student is still punched in
 *
 * Leaving choice (2026-11-12): a punched-in student picks "Punch me out now"
 * or "Keep me punched in" in AllDoneModal before the swipe. On "Punch me out
 * now", after mark_all_done succeeds this card re-reads the student's open
 * punch and calls kiosk_punch_out with the same instructor badge (an
 * instructor's card may act for any student; never marked Left Early). If
 * the punch was already closed elsewhere it is skipped quietly; if the
 * punch-out fails, All Done still stands and the student is told to punch
 * out on the Time Clock.
 *   • No class week in session (break) → muted note, no button
 *
 * "Done today" is read from time_clock: a row with entry_type = 'All Done'
 * whose punch_in falls on today's date. That marker is the single signal the
 * rest of the app uses (useTimeCards left-early suppression, Dashboard
 * on-time credit, week-closed tiles), so this card and those screens always
 * agree. markAllDone (useWeeklyLabs) now writes the marker whether or not the
 * student is punched in.
 *
 * Week/class context comes from useStudentLabReport (enrolled Active classes
 * + buildClassWeeks). Every class is treated as tracking_type 'None': no
 * weekly_lab_tracker rows are written any more.
 *
 * Dates: time_clock uses the fake-UTC convention (local wall-clock stored
 * with +00), so today's window is `${today}T00:00:00+00` … `T23:59:59+00`
 * and display reads getUTCHours()/getUTCMinutes().
 *
 * Accessibility: status is a role="status" live region; the button is 44px
 * with a focus-visible ring and a descriptive aria-label.
 *
 * File: src/components/AllDoneSection.jsx
 */

import { useState, useEffect, useCallback, useId } from 'react'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { subscribeWithReconnect } from '@/lib/supabaseRealtime'
import { useAuth } from '@/contexts/AuthContext'
import { useStudentLabReport, useLabTrackerActions } from '@/hooks/useWeeklyLabs'
import AllDoneModal from '@/components/AllDoneModal'
import { Star, CheckCircle2, Clock, Loader2, LogOut } from 'lucide-react'
import toast from 'react-hot-toast'

/** 1.5 → "1h 30m", 0.25 → "15m" */
function formatHoursShort(h) {
  const mins = Math.round((Number(h) || 0) * 60)
  const hh = Math.floor(mins / 60)
  const mm = mins % 60
  if (hh && mm) return `${hh}h ${mm}m`
  if (hh) return `${hh}h`
  return `${mm}m`
}

/**
 * Punch the student out with the instructor badge just swiped for All Done.
 * Resolves to { status: 'out', totalHours } | { status: 'already_out' } |
 * { status: 'failed', message }. Never throws.
 */
export async function punchOutAfterAllDone({ badge, email }) {
  try {
    // Re-read the open punch now — it may have closed while the dialog was open
    const open = mustData(await supabase
      .from('time_clock')
      .select('record_id')
      .eq('user_email', email)
      .eq('status', 'Punched In')
      .order('punch_in', { ascending: false })
      .limit(1), 'time_clock.select')
    const recordId = open?.[0]?.record_id
    if (!recordId) return { status: 'already_out' }

    const { data: res, error } = await supabase.rpc('kiosk_punch_out', {
      p_card: badge,
      p_email: email,
      p_record_id: recordId,
      p_early: false,
      p_early_minutes: 0,
      p_approver_card: null,
      p_is_break: false,
    })
    if (error) throw error
    if (res?.ok) return { status: 'out', totalHours: parseFloat(res.total_hours) || 0 }
    if (res?.error === 'not_open') return { status: 'already_out' }
    return { status: 'failed', message: res?.error || 'punch_out_failed' }
  } catch (err) {
    console.error('AllDoneSection: punch out after All Done failed:', err?.message || err)
    return { status: 'failed', message: err?.message || 'punch_out_failed' }
  }
}

/** Today's local calendar date as YYYY-MM-DD. */
export function localTodayStr(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Fake-UTC timestamp → "3:42 PM" (reads UTC components on purpose). */
export function formatFakeUtcTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  let h = d.getUTCHours()
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m} ${ampm}`
}

/**
 * Has this user been marked All Done today?
 * Resolves to { done: boolean, by: string, at: string|null, punchedIn: boolean }.
 * Shared by AllDoneSection and the Dashboard tile.
 */
export async function fetchAllDoneToday(userEmail) {
  const empty = { done: false, by: '', at: null, punchedIn: false }
  if (!userEmail) return empty
  const today = localTodayStr()
  const [markerRes, activeRes] = await Promise.all([
    supabase
      .from('time_clock')
      .select('record_id, punch_in, description')
      .eq('user_email', userEmail)
      .eq('entry_type', 'All Done')
      .gte('punch_in', `${today}T00:00:00+00`)
      .lte('punch_in', `${today}T23:59:59+00`)
      .order('punch_in', { ascending: false })
      .limit(1),
    supabase
      .from('time_clock')
      .select('record_id')
      .eq('user_email', userEmail)
      .eq('status', 'Punched In')
      .limit(1),
  ])
  const marker = mustData(markerRes, 'time_clock.select')?.[0] || null
  const punchedIn = ((activeRes.data || []).length > 0)
  if (!marker) return { ...empty, punchedIn }
  const by = (marker.description || '').replace(/^All Done — released by /, '').trim()
  return { done: true, by, at: marker.punch_in, punchedIn }
}

export default function AllDoneSection() {
  const { profile } = useAuth()
  const { report, loading: reportLoading } = useStudentLabReport()
  const { markAllDone, saving } = useLabTrackerActions()
  const uid = useId()

  const [status, setStatus] = useState({ done: false, by: '', at: null, punchedIn: false })
  const [statusLoading, setStatusLoading] = useState(true)
  const [modal, setModal] = useState(null) // { weekNumber, weekDate, weekStartDate, weekEndDate, classes }

  const refreshStatus = useCallback(async () => {
    if (!profile?.email) { setStatusLoading(false); return }
    try {
      setStatus(await fetchAllDoneToday(profile.email))
    } catch (e) {
      console.warn('AllDoneSection: status check failed:', e.message)
    }
    setStatusLoading(false)
  }, [profile?.email])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // Live: a punch out / All Done from another device shows up here.
  useEffect(() => {
    if (!profile?.email) return undefined
    return subscribeWithReconnect(`all-done-${uid}`, ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, refreshStatus)
    , { tag: 'AllDoneSection', onReconnect: refreshStatus })
  }, [profile?.email, uid, refreshStatus])

  if (!profile) return null

  const studentName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim()

  // ── Current week per enrolled class (same rule the old tracker used) ──
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const currentWeekInfos = (report?.classes || []).map(cls => {
    const cw = cls.classWeeks || []
    let currentWeek = null
    for (const wk of cw) {
      const wkStart = new Date(wk.startDate); wkStart.setHours(0, 0, 0, 0)
      const wkEnd = new Date(wk.endDate); wkEnd.setHours(23, 59, 59, 999)
      if (today >= wkStart && today <= wkEnd) { currentWeek = wk; break }
    }
    if (!currentWeek) {
      for (let i = 0; i < cw.length; i++) {
        const wkStart = new Date(cw[i].startDate); wkStart.setHours(0, 0, 0, 0)
        const nextStart = i + 1 < cw.length ? new Date(cw[i + 1].startDate) : null
        if (nextStart) nextStart.setHours(0, 0, 0, 0)
        if (today >= wkStart && (!nextStart || today < nextStart)) { currentWeek = cw[i]; break }
      }
    }
    return { cls, currentWeek }
  }).filter(info => info.currentWeek)

  const firstWeekInfo = currentWeekInfos[0]
  const currentWeekNumber = firstWeekInfo?.currentWeek?.weekNumber
  const currentWeekLabel = firstWeekInfo ? (() => {
    const sd = new Date(firstWeekInfo.currentWeek.startDate)
    const ed = new Date(firstWeekInfo.currentWeek.endDate)
    return `${sd.getMonth() + 1}/${sd.getDate()} — ${ed.getMonth() + 1}/${ed.getDate()}`
  })() : ''

  const openModal = () => {
    setModal({
      weekNumber: currentWeekNumber,
      weekDate: currentWeekLabel,
      weekStartDate: firstWeekInfo?.currentWeek?.startDate || '',
      weekEndDate: firstWeekInfo?.currentWeek?.endDate || '',
      classes: currentWeekInfos.map(info => ({ className: info.cls.className, classId: info.cls.classId || null })),
    })
  }

  // AllDoneModal passes { badge, punchOut } — punchOut is true only when the
  // student was punched in and chose "Punch me out now".
  const handleAllDone = async ({ badge, punchOut = false } = {}) => {
    // Every class is 'None' now: markAllDone skips tracker rows and only
    // cancels signups + writes the time_clock marker + audit row.
    const classInfos = currentWeekInfos.map(info => ({
      className: info.cls.className,
      classId: info.cls.classId || '',
      trackingType: 'None',
      weekNumber: info.currentWeek.weekNumber,
      weekStartDate: info.currentWeek.startDate,
      weekEndDate: info.currentWeek.endDate,
    }))
    const result = await markAllDone(profile?.user_id, profile?.email, studentName, classInfos, { badge })
    if (result.success) {
      // The database returns the instructor whose badge was swiped
      const by = result.instructor || {}
      const who = `${by.first_name || ''} ${by.last_name || ''}`.trim() || 'instructor'

      let punch = null
      if (punchOut) punch = await punchOutAfterAllDone({ badge, email: profile?.email })

      if (punch?.status === 'out') {
        toast.success(`All Done — confirmed by ${who}. You're punched out (${formatHoursShort(punch.totalHours)} recorded).`, { duration: 6000 })
      } else {
        toast.success(`All Done — confirmed by ${who}`)
      }

      const fresh = await fetchAllDoneToday(profile.email).catch(() => null)
      if (fresh) setStatus(fresh)
      const stillIn = fresh?.punchedIn ?? (punch?.status === 'out' ? false : status.punchedIn)

      if (punch?.status === 'failed') {
        toast.error("All Done is saved, but the punch-out didn't go through. Punch out on the Time Clock before you leave.", { duration: 10000 })
      } else if (stillIn) {
        toast('Remember: you still need to punch out on the Time Clock before you leave.', { icon: '⏰', duration: 8000 })
      }
    }
    // AllDoneModal shows "Badge not recognized" and stays open on failure
    return result
  }

  const loading = reportLoading || statusLoading
  const noWeek = !loading && currentWeekInfos.length === 0
  const statusId = `${uid}-status`

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className={`rounded-xl border overflow-hidden ${status.done ? 'border-emerald-200 bg-emerald-50' : 'border-surface-200 bg-white'}`}
    >
      <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${status.done ? 'bg-emerald-600 text-white' : 'bg-emerald-100 text-emerald-700'}`} aria-hidden="true">
            {status.done ? <CheckCircle2 size={22} /> : <Star size={22} />}
          </span>
          <div className="min-w-0">
            <h3 id={`${uid}-title`} className="font-semibold text-sm text-surface-900">
              All Done
              {currentWeekNumber && <span className="ml-2 font-normal text-xs text-surface-500">W{currentWeekNumber} · {currentWeekLabel}</span>}
            </h3>
            <p id={statusId} role="status" aria-live="polite" className="text-xs mt-0.5">
              {loading ? (
                <span className="text-surface-400">Checking today's status…</span>
              ) : status.done ? (
                <span className="text-emerald-800 font-medium">
                  Confirmed today{status.by ? ` by ${status.by}` : ''}{status.at ? ` at ${formatFakeUtcTime(status.at)}` : ''}.
                  {status.punchedIn ? ' You are still punched in — punch out before you leave.' : ''}
                </span>
              ) : noWeek ? (
                <span className="text-surface-500">No class week in session today.</span>
              ) : (
                <span className="text-surface-600">Finished for the week? Have an instructor swipe to confirm.</span>
              )}
            </p>
          </div>
        </div>

        {loading ? (
          <Loader2 size={18} className="animate-spin text-surface-400" aria-hidden="true" />
        ) : status.done ? (
          status.punchedIn ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium min-h-[44px]">
              <LogOut size={14} aria-hidden="true" /> Still punched in
            </span>
          ) : null
        ) : !noWeek ? (
          <button
            type="button"
            onClick={openModal}
            disabled={saving}
            aria-label="Mark All Done — requires an instructor badge swipe"
            aria-describedby={statusId}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700 transition min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            <Star size={16} aria-hidden="true" />
            All Done — Instructor Swipe
          </button>
        ) : null}
      </div>

      {!loading && !status.done && !noWeek && (
        <div className="px-4 pb-3 -mt-1 text-[11px] text-surface-500 flex items-center gap-1.5">
          <Clock size={12} aria-hidden="true" />
          If you're punched in, you'll choose to punch out now or stay punched in before the swipe.
        </div>
      )}

      {modal && (
        <AllDoneModal
          isOpen
          onClose={() => setModal(null)}
          studentName={studentName}
          studentEmail={profile?.email}
          weekNumber={modal.weekNumber}
          weekDate={modal.weekDate}
          weekStartDate={modal.weekStartDate}
          weekEndDate={modal.weekEndDate}
          classes={modal.classes}
          onAllDone={handleAllDone}
          punchedIn={status.punchedIn}
        />
      )}
    </section>
  )
}
