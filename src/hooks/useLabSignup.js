import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function formatHour(hour) {
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h = hour % 12 || 12
  return `${h}:00 ${ampm}`
}

function getHourFromTime(timeStr) {
  if (!timeStr) return null
  if (typeof timeStr === 'string') {
    const match24 = timeStr.match(/^(\d{2}):(\d{2})/)
    if (match24) return parseInt(match24[1])
    const matchAmPm = timeStr.toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/)
    if (matchAmPm) {
      let h = parseInt(matchAmPm[1])
      const ap = matchAmPm[3]
      if (ap === 'PM' && h !== 12) h += 12
      if (ap === 'AM' && h === 12) h = 0
      return h
    }
  }
  return null
}

function getWeekStart(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay()) // Sunday
  d.setHours(0, 0, 0, 0)
  return d
}

function isDeadlinePassed(weekStartDate) {
  // Deadline is Sunday at 11:59 PM Central Time
  const now = new Date()
  const deadline = new Date(weekStartDate)
  deadline.setHours(23, 59, 59, 999)
  return now > deadline
}

export { formatDateKey, formatHour, getHourFromTime, getWeekStart, isDeadlinePassed }

// ─── Lab Calendar (Instructor) ──────────────────────────────────────────────

export function useLabCalendar(year, month) {
  const [entries, setEntries] = useState({})
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    const startDate = new Date(year, month, 1)
    const endDate = new Date(year, month + 1, 0, 23, 59, 59)

    const { data, error } = await supabase
      .from('lab_calendar')
      .select('*')
      .gte('date', startDate.toISOString())
      .lte('date', endDate.toISOString())

    if (error) {
      console.error('Error loading lab calendar:', error)
      setLoading(false)
      return
    }

    const map = {}
    ;(data || []).forEach(row => {
      let key
      if (typeof row.date === 'string' && row.date.length === 10) {
        key = row.date
      } else {
        const dateStr = (row.date || '').substring(0, 10)
        key = dateStr || formatDateKey(new Date(row.date))
      }
      map[key] = {
        calendarId: row.calendar_id,
        date: key,
        startHour: getHourFromTime(row.start_time) ?? 8,
        endHour: getHourFromTime(row.end_time) ?? 16,
        maxStudents: row.max_students || 24,
        status: row.status || 'Open',
        lunchHour: row.lunch_hour != null ? parseInt(row.lunch_hour) : null,
        notes: row.notes || '',
      }
    })
    setEntries(map)
    hasLoadedRef.current = true
    setLoading(false)
  }, [year, month])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_calendar changes
  useEffect(() => {
    const channel = supabase
      .channel('lab-calendar-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { entries, loading, refresh: fetch }
}

// ─── Save/Delete Calendar Day ───────────────────────────────────────────────

export function useLabCalendarActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const saveDay = async (dayData) => {
    setSaving(true)
    try {
      const dateStr = dayData.date
      const { data: existing } = await supabase
        .from('lab_calendar')
        .select('calendar_id')
        .eq('date', dateStr + 'T12:00:00')
        .maybeSingle()

      if (existing) {
        const { error } = await supabase
          .from('lab_calendar')
          .update({
            start_time: dayData.startTime,
            end_time: dayData.endTime,
            max_students: dayData.maxStudents || 24,
            status: dayData.status || 'Open',
            lunch_hour: dayData.lunchHour || null,
            notes: dayData.notes || '',
          })
          .eq('calendar_id', existing.calendar_id)
        if (error) throw error
        toast.success('Day updated')
      } else {
        const { data: maxRow } = await supabase
          .from('lab_calendar')
          .select('calendar_id')
          .order('calendar_id', { ascending: false })
          .limit(1)
          .maybeSingle()

        let nextNum = 1
        if (maxRow?.calendar_id) {
          const num = parseInt(maxRow.calendar_id.replace('CAL', ''))
          if (!isNaN(num)) nextNum = num + 1
        }
        const newId = 'CAL' + String(nextNum).padStart(4, '0')

        const { error } = await supabase.from('lab_calendar').insert({
          calendar_id: newId,
          date: dateStr + 'T12:00:00',
          start_time: dayData.startTime,
          end_time: dayData.endTime,
          max_students: dayData.maxStudents || 24,
          status: dayData.status || 'Open',
          lunch_hour: dayData.lunchHour || null,
          notes: dayData.notes || '',
          created_by: profile?.email,
          created_at: new Date().toISOString(),
        })
        if (error) throw error
        toast.success('Day added')
      }
    } catch (err) {
      toast.error('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteDay = async (dateStr) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('lab_calendar')
        .delete()
        .eq('date', dateStr + 'T12:00:00')
      if (error) throw error
      toast.success('Day removed')
    } catch (err) {
      toast.error('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return { saveDay, deleteDay, saving }
}

// ─── Lab Signup Data (Combined Load) ────────────────────────────────────────

export function useLabSignupData(weekStart, weeksToDisplay = 4, visibleDays = [1, 2, 3, 4]) {
  const { profile } = useAuth()
  const [data, setData] = useState({ weeks: [], hours: [], slots: {}, classes: [] })
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!weekStart || !profile) return
    setLoading(true)

    try {
      const firstWeek = new Date(weekStart)
      firstWeek.setHours(0, 0, 0, 0)
      const overallEnd = new Date(firstWeek)
      overallEnd.setDate(overallEnd.getDate() + (weeksToDisplay * 7) - 1)
      overallEnd.setHours(23, 59, 59, 999)

      // 1. Get user's classes and progress (students/work-study only)
      let classes = []
      const userClasses = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean)

      if (userClasses.length > 0 && profile.role !== 'Instructor') {
        const todayStr = new Date().toISOString().substring(0, 10)
        const { data: classData } = await supabase
          .from('classes')
          .select('class_id, course_id, course_name, required_hours')
          .in('course_id', userClasses)
          .eq('status', 'Active')
          .or(`start_date.is.null,start_date.lte.${todayStr}`)

        classes = (classData || []).map(c => ({
          classId: c.class_id,
          courseId: c.course_id,
          courseName: c.course_name || '',
          requiredHours: c.required_hours || 0,
        }))
      }

      // 2. Get calendar entries
      const { data: calData } = await supabase
        .from('lab_calendar')
        .select('*')
        .gte('date', firstWeek.toISOString())
        .lte('date', overallEnd.toISOString())

      const calByDate = {}
      const allHoursSet = new Set()
      ;(calData || []).forEach(row => {
        const key = typeof row.date === 'string' && row.date.length >= 10 ? row.date.substring(0, 10) : formatDateKey(new Date(row.date))
        const startH = getHourFromTime(row.start_time) ?? 8
        const endH = getHourFromTime(row.end_time) ?? 16
        const lunchH = row.lunch_hour != null ? parseInt(row.lunch_hour) : null
        calByDate[key] = {
          startHour: startH,
          endHour: endH,
          maxStudents: row.max_students || 24,
          status: row.status || 'Open',
          notes: row.notes || '',
          lunchHour: isNaN(lunchH) ? null : lunchH,
          isOpen: row.status === 'Open',
        }
        if (row.status === 'Open') {
          for (let h = startH; h < endH; h++) allHoursSet.add(h)
        }
      })

      let allHours = Array.from(allHoursSet).sort((a, b) => a - b)
      if (allHours.length === 0) allHours = [8, 9, 10, 11, 12, 13, 14, 15]

      // 3. Get signups
      const { data: signupData } = await supabase
        .from('lab_signup')
        .select('signup_id, user_email, class_id, date, start_time')
        .neq('status', 'Cancelled')
        .gte('date', firstWeek.toISOString())
        .lte('date', overallEnd.toISOString())

      const signupsByKey = {}
      ;(signupData || []).forEach(row => {
        const dk = typeof row.date === 'string' && row.date.length >= 10 ? row.date.substring(0, 10) : formatDateKey(new Date(row.date))
        const hr = getHourFromTime(row.start_time)
        if (hr === null) return
        const key = `${dk}_${hr}`
        if (!signupsByKey[key]) signupsByKey[key] = []
        signupsByKey[key].push({
          signupId: row.signup_id,
          userEmail: row.user_email,
          classId: row.class_id || '',
        })
      })

      // 4. Build weeks
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const weeks = []
      const slots = {}

      for (let w = 0; w < weeksToDisplay; w++) {
        const ws = new Date(firstWeek)
        ws.setDate(ws.getDate() + (w * 7))
        const we = new Date(ws)
        we.setDate(we.getDate() + 6)

        const weekDeadlinePassed = profile.role !== 'Instructor' ? isDeadlinePassed(ws) : false
        const weekTitle = `${monthNames[ws.getMonth()]} ${ws.getDate()} - ${monthNames[we.getMonth()]} ${we.getDate()}`

        const days = []
        for (let d = 0; d < 7; d++) {
          if (!visibleDays.includes(d)) continue
          const dt = new Date(ws)
          dt.setDate(dt.getDate() + d)
          const dateKey = formatDateKey(dt)
          const config = calByDate[dateKey]

          days.push({
            date: dateKey,
            dayName: dayNames[dt.getDay()],
            dayShort: dayNames[dt.getDay()].substring(0, 3),
            dayNum: dt.getDate(),
            month: dt.getMonth() + 1,
            dayOfWeek: dt.getDay(),
            isOpen: config ? config.isOpen : false,
            isClosed: config ? !config.isOpen : false,
            startHour: config ? config.startHour : 8,
            endHour: config ? config.endHour : 16,
            maxStudents: config ? config.maxStudents : 24,
            lunchHour: config?.lunchHour ?? null,
            notes: config ? config.notes : '',
            hasEntry: !!config,
          })

          // Build slots
          allHours.forEach(hour => {
            const key = `${dateKey}_${hour}`
            const signups = signupsByKey[key] || []
            const day = days[days.length - 1]
            const isLunch = day.lunchHour !== null && hour === day.lunchHour

            let mySignupId = ''
            let myClassId = ''
            signups.forEach(s => {
              if (s.userEmail === profile.email) {
                mySignupId = s.signupId
                myClassId = s.classId || ''
              }
            })

            slots[key] = {
              date: dateKey,
              hour,
              maxStudents: day.maxStudents,
              currentSignups: signups.length,
              availableSpots: Math.max(0, day.maxStudents - signups.length),
              isFull: signups.length >= day.maxStudents,
              isOpen: day.isOpen && hour >= day.startHour && hour < day.endHour,
              isLunch,
              mySignupId,
              myClassId,
              deadlinePassed: weekDeadlinePassed,
            }
          })
        }

        weeks.push({
          weekIndex: w,
          weekStart: formatDateKey(ws),
          weekTitle,
          days,
          deadlinePassed: weekDeadlinePassed,
        })
      }

      setData({ weeks, hours: allHours, slots, classes })
    } catch (err) {
      console.error('Error loading lab signup data:', err)
      toast.error('Failed to load lab data')
    } finally {
      setLoading(false)
    }
  }, [weekStart, weeksToDisplay, visibleDays, profile])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_signup or lab_calendar changes
  useEffect(() => {
    if (!weekStart || !profile) return
    const channel = supabase
      .channel('lab-signup-data-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [weekStart, profile, fetch])

  return { ...data, loading, refresh: fetch }
}

// ─── Signup Actions (multi-class aware) ─────────────────────────────────────

export function useLabSignupActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  /**
   * signUpBatchMultiClass - takes a map of { classId: [slotKey, ...] }
   * and inserts all signups in one batch
   */
  const signUpBatchMultiClass = async (selectionsByClass) => {
    setSaving(true)
    try {
      // Get next signup ID
      const { data: maxRow } = await supabase
        .from('lab_signup')
        .select('signup_id')
        .order('signup_id', { ascending: false })
        .limit(1)
        .maybeSingle()

      let maxNum = 0
      if (maxRow?.signup_id) {
        const num = parseInt(maxRow.signup_id.replace('SU', ''))
        if (!isNaN(num)) maxNum = num
      }

      const rows = []

      for (const [classId, selections] of Object.entries(selectionsByClass)) {
        for (const sel of selections) {
          const [dateStr, hourStr] = sel.split('_')
          const hour = parseInt(hourStr)
          const targetDate = new Date(dateStr + 'T12:00:00')

          // Check if already exists
          const { data: existing } = await supabase
            .from('lab_signup')
            .select('signup_id')
            .eq('user_id', profile.id || profile.user_id)
            .eq('date', targetDate.toISOString())
            .eq('start_time', `${String(hour).padStart(2, '0')}:00:00`)
            .neq('status', 'Cancelled')
            .maybeSingle()

          if (existing) continue

          maxNum++
          const numStr = String(maxNum).padStart(6, '0')
          const startTime = `${String(hour).padStart(2, '0')}:00:00`
          const endTime = `${String(hour + 1).padStart(2, '0')}:00:00`
          const userName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`

          rows.push({
            signup_id: 'SU' + numStr,
            user_id: null,
            user_name: userName,
            user_email: profile.email,
            class_id: classId || '',
            date: targetDate.toISOString(),
            start_time: startTime,
            end_time: endTime,
            status: 'Confirmed',
            created_at: new Date().toISOString(),
          })
        }
      }

      if (rows.length > 0) {
        const { error } = await supabase.from('lab_signup').insert(rows)
        if (error) throw error
        toast.success(`Signed up for ${rows.length} slot(s)`)
      }
      return { success: true, count: rows.length }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Legacy single-class batch for backward compat */
  const signUpBatch = async (selections, classId) => {
    return signUpBatchMultiClass({ [classId]: selections })
  }

  const cancelSignup = async (signupId) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('lab_signup')
        .update({ status: 'Cancelled' })
        .eq('signup_id', signupId)
      if (error) throw error
      toast.success('Signup cancelled')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /**
   * submitPostDeadlineRequest - creates a lab_signup_requests record
   * for instructor approval when changes are made after Sunday deadline
   *
   * @param {string} courseId - course ID for the class
   * @param {string} weekStart - week start date string (YYYY-MM-DD)
   * @param {string[]} currentSlots - existing confirmed slot keys for this week+class
   * @param {string[]} requestedSlots - newly desired slot keys for this week+class
   * @param {string} reason - student's reason for the change
   */
  const submitPostDeadlineRequest = async (courseId, weekStart, currentSlots, requestedSlots, reason) => {
    setSaving(true)
    try {
      // Use timestamp-based ID to avoid collisions when submitting multiple classes
      const requestId = 'LSR' + Date.now()

      const userName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`

      const { error } = await supabase.from('lab_signup_requests').insert({
        request_id: requestId,
        user_id: null,
        user_name: userName,
        user_email: profile.email,
        class_id: courseId,
        course_id: courseId,
        week_start: weekStart,
        current_slots: JSON.stringify(currentSlots),
        requested_slots: JSON.stringify(requestedSlots),
        status: 'Pending',
        reason: reason || '',
        submitted_date: new Date().toISOString(),
      })

      if (error) throw error
      toast.success('Change request submitted for instructor approval')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return { signUpBatch, signUpBatchMultiClass, cancelSignup, submitPostDeadlineRequest, saving }
}

// ─── My Signups ─────────────────────────────────────────────────────────────

export function useMySignups() {
  const { profile } = useAuth()
  const [signups, setSignups] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const { data, error } = await supabase
      .from('lab_signup')
      .select('*')
      .eq('user_email', profile.email)
      .gte('date', today.toISOString())
      .neq('status', 'Cancelled')
      .order('date', { ascending: true })

    if (error) {
      console.error('Error loading signups:', error)
    } else {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      setSignups((data || []).map(s => {
        const parts = (s.date || '').substring(0, 10).split('-')
        const dt = parts.length === 3 ? new Date(+parts[0], +parts[1] - 1, +parts[2]) : new Date(s.date)
        return {
          signupId: s.signup_id,
          dateDisplay: `${dayNames[dt.getDay()]}, ${monthNames[dt.getMonth()]} ${dt.getDate()}`,
          startTime: formatHour(getHourFromTime(s.start_time) ?? 0),
          endTime: formatHour((getHourFromTime(s.end_time) ?? 1)),
          classId: s.class_id || '',
          status: s.status,
          canCancel: s.status !== 'Cancelled',
        }
      }))
    }
    setLoading(false)
  }, [profile])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_signup changes
  useEffect(() => {
    if (!profile) return
    const channel = supabase
      .channel('my-signups-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile, fetch])

  return { signups, loading, refresh: fetch }
}

// ─── Daily Roster (Instructor) ──────────────────────────────────────────────

export function useDailyRoster(dateStr) {
  const [signups, setSignups] = useState([])
  const [loading, setLoading] = useState(false)

  const fetch = useCallback(async () => {
    if (!dateStr) return
    setLoading(true)
    const targetDate = new Date(dateStr + 'T12:00:00')

    const { data, error } = await supabase
      .from('lab_signup')
      .select('*')
      .eq('date', targetDate.toISOString())
      .neq('status', 'Cancelled')
      .order('start_time', { ascending: true })

    if (error) console.error('Error loading roster:', error)
    setSignups(data || [])
    setLoading(false)
  }, [dateStr])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when lab_signup changes
  useEffect(() => {
    if (!dateStr) return
    const channel = supabase
      .channel(`daily-roster-${dateStr}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [dateStr, fetch])

  return { signups, loading, refresh: fetch }
}

// ─── Students List (for Instructor Override) ────────────────────────────────

export function useStudentsList() {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email, classes, role, time_clock_only')
      .eq('status', 'Active')
      .neq('role', 'Instructor')
      .order('last_name')

    if (error) console.error('Error loading students:', error)
    setStudents((data || []).filter(s => s.time_clock_only !== 'Yes').map(s => ({
      userId: s.id,
      firstName: s.first_name || '',
      lastName: s.last_name || '',
      email: s.email,
      displayName: `${s.first_name} ${s.last_name} (${s.email})`,
      classes: s.classes || '',
    })))
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when profiles change (new students, class assignments)
  useEffect(() => {
    const channel = supabase
      .channel('lab-students-list-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { students, loading }
}

// ─── Instructor Signup Override ──────────────────────────────────────────────

export function useInstructorSignup() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  const signUpStudent = async (student, dateStr, hour, classId) => {
    setSaving(true)
    try {
      const targetDate = new Date(dateStr + 'T12:00:00')
      const hourNum = parseInt(hour)

      const { data: existing } = await supabase
        .from('lab_signup')
        .select('signup_id')
        .eq('user_id', student.userId)
        .eq('date', targetDate.toISOString())
        .eq('start_time', `${String(hourNum).padStart(2, '0')}:00:00`)
        .neq('status', 'Cancelled')
        .maybeSingle()

      if (existing) {
        toast.error('Student already signed up for this slot')
        return { success: false }
      }

      const { data: maxRow } = await supabase
        .from('lab_signup')
        .select('signup_id')
        .order('signup_id', { ascending: false })
        .limit(1)
        .maybeSingle()

      let nextNum = 1
      if (maxRow?.signup_id) {
        const num = parseInt(maxRow.signup_id.replace('SU', ''))
        if (!isNaN(num)) nextNum = num + 1
      }

      const userName = `${student.firstName} ${(student.lastName || '').charAt(0)}.`
      const { error } = await supabase.from('lab_signup').insert({
        signup_id: 'SU' + String(nextNum).padStart(6, '0'),
        user_id: null,
        user_name: userName,
        user_email: student.email,
        class_id: classId || '',
        date: targetDate.toISOString(),
        start_time: `${String(hourNum).padStart(2, '0')}:00:00`,
        end_time: `${String(hourNum + 1).padStart(2, '0')}:00:00`,
        status: 'Confirmed',
        created_at: new Date().toISOString(),
      })

      if (error) throw error
      toast.success(`Signed up ${userName} (Instructor Override)`)
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return { signUpStudent, saving }
}
