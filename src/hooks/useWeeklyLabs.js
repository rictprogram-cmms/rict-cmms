import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

// ─── Timestamp Helper ────────────────────────────────────────────────────────
// The app stores timestamps as local time labeled with +00 offset ("fake UTC").
// NEVER use new Date().toISOString() for punch_in/punch_out — that produces
// real UTC and will display 5–6 hours late in CDT/CST. Always use this helper.
function localToUtcIso(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}+00`
}

// ─── Get Classes for Instructor Dropdown ────────────────────────────────────

export function useLabClasses() {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    const { data, error } = await supabase
      .from('classes')
      .select('*')
      .eq('status', 'Active')
      .order('course_id')

    if (error) {
      console.error('Error loading classes:', error)
    } else {
      setClasses((data || []).map(c => ({
        classId: c.class_id,
        className: c.course_id,
        description: c.course_name || '',
        requiredHours: c.required_hours || 0,
        instructor: c.instructor || '',
        semester: c.semester || '',
        trackingType: c.tracking_type || 'Weekly',
        startDate: c.start_date,
        endDate: c.end_date,
        springBreakStart: c.spring_break_start,
        springBreakEnd: c.spring_break_end,
        finalsStart: c.finals_start,
        finalsEnd: c.finals_end,
      })))
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when classes change
  useEffect(() => {
    const channel = supabase
      .channel('lab-classes-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { classes, loading }
}

// ─── Build weeks array from class date range ────────────────────────────────

export function buildClassWeeks(cls) {
  if (!cls.startDate || !cls.endDate) return []
  // Parse dates without timezone shift
  const parseSafe = (d) => {
    const s = (typeof d === 'string' ? d : d.toISOString()).substring(0, 10).split('-')
    return new Date(+s[0], +s[1] - 1, +s[2])
  }
  const start = parseSafe(cls.startDate)
  const end = parseSafe(cls.endDate)
  const sbStart = cls.springBreakStart ? parseSafe(cls.springBreakStart) : null
  const sbEnd = cls.springBreakEnd ? parseSafe(cls.springBreakEnd) : null
  const finalsStart = cls.finalsStart ? parseSafe(cls.finalsStart) : null
  const finalsEnd = cls.finalsEnd ? parseSafe(cls.finalsEnd) : null

  // Start from the Monday of the start week
  const weekStart = new Date(start)
  const day = weekStart.getDay()
  if (day !== 1) weekStart.setDate(weekStart.getDate() - ((day + 6) % 7)) // Adjust to Monday

  const weeks = []
  let weekNum = 1
  let current = new Date(weekStart)

  while (current <= end) {
    const wkStart = new Date(current)
    const wkEnd = new Date(current)
    wkEnd.setDate(wkEnd.getDate() + 3) // Mon-Thu

    // Check if this week overlaps with spring break
    const isSpringBreak = sbStart && sbEnd &&
      wkStart <= sbEnd && wkEnd >= sbStart

    // Check if this is finals week
    const isFinals = finalsStart && finalsEnd &&
      wkStart >= finalsStart && wkStart <= finalsEnd

    if (!isSpringBreak) {
      weeks.push({
        weekNumber: weekNum,
        startDate: wkStart.toISOString(),
        endDate: wkEnd.toISOString(),
        isFinals: !!isFinals,
      })
      weekNum++
    }

    current.setDate(current.getDate() + 7)
  }

  return weeks
}

// ─── Lab Report for Instructor (single class, all students) ─────────────────

export function useLabReport(className) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!className) return
    if (!hasLoadedRef.current) setLoading(true)

    try {
      // Get class info
      const { data: classData } = await supabase
        .from('classes')
        .select('*')
        .eq('course_id', className)
        .eq('status', 'Active')
        .maybeSingle()

      if (!classData) {
        setReport(null)
        setLoading(false)
        return
      }

      const classWeeks = buildClassWeeks({
        startDate: classData.start_date,
        endDate: classData.end_date,
        springBreakStart: classData.spring_break_start,
        springBreakEnd: classData.spring_break_end,
        finalsStart: classData.finals_start,
        finalsEnd: classData.finals_end,
      })
      const totalWeeks = classWeeks.length || 8

      // Get students enrolled in this class
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, email, classes, role, time_clock_only')
        .eq('status', 'Active')

      const enrolledStudents = (profilesData || []).filter(p => {
        if (p.role === 'Instructor') return false
        if (p.time_clock_only === 'Yes') return false // TCO users excluded from rotations
        const classes = (p.classes || '').split(',').map(c => c.trim())
        return classes.includes(className)
      })

      // Get tracker data for this class
      const { data: trackerData } = await supabase
        .from('weekly_lab_tracker')
        .select('*')
        .eq('course_id', className)

      // Build student rows
      const students = enrolledStudents.map(student => {
        const weeks = {}
        ;(trackerData || []).forEach(row => {
          if ((row.user_id === student.id || row.user_email === student.email)) {
            const wn = parseInt(row.week_number)
            if (!isNaN(wn)) {
              weeks[wn] = {
                labComplete: row.lab_complete === 'Yes' || row.lab_complete === true,
                allDone: row.all_done === 'Yes' || row.all_done === true,
              }
            }
          }
        })

        return {
          userId: student.id,
          fullName: `${student.first_name || ''} ${student.last_name || ''}`.trim(),
          email: student.email,
          weeks,
        }
      }).sort((a, b) => a.fullName.localeCompare(b.fullName))

      setReport({
        className,
        classId: classData.class_id || '',
        description: classData.course_name || '',
        totalWeeks,
        classWeeks,
        startDate: classData.start_date,
        students,
        generatedAt: new Date().toLocaleString(),
      })
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error loading lab report:', err)
      if (!hasLoadedRef.current) toast.error('Failed to load report')
    } finally {
      setLoading(false)
    }
  }, [className])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when weekly_lab_tracker or profiles change
  useEffect(() => {
    if (!className) return
    const channel = supabase
      .channel(`lab-report-${className}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_lab_tracker' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [className, fetch])

  return { report, loading, refresh: fetch }
}

// ─── Student Report (all their classes) ─────────────────────────────────────

export function useStudentLabReport() {
  const { profile } = useAuth()
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!profile) return
    if (!hasLoadedRef.current) setLoading(true)

    try {
      const userClasses = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean)
      if (userClasses.length === 0) {
        setReport({ classes: [] })
        setLoading(false)
        return
      }

      // Get class configs
      const { data: classesData } = await supabase
        .from('classes')
        .select('*')
        .in('course_id', userClasses)
        .eq('status', 'Active')

      // Get tracker data for this user
      const { data: trackerData } = await supabase
        .from('weekly_lab_tracker')
        .select('*')
        .or(`user_id.eq.${profile.id},user_email.eq.${profile.email}`)

      // Skip classes that don't use the weekly lab tracker
      const classes = (classesData || []).filter(cls => (cls.tracking_type || 'Weekly') !== 'None').map(cls => {
        const classWeeks = buildClassWeeks({
          startDate: cls.start_date,
          endDate: cls.end_date,
          springBreakStart: cls.spring_break_start,
          springBreakEnd: cls.spring_break_end,
          finalsStart: cls.finals_start,
          finalsEnd: cls.finals_end,
        })
        const totalWeeks = classWeeks.length || 8

        const weeks = {}
        ;(trackerData || []).forEach(row => {
          if (row.course_id === cls.course_id) {
            const wn = parseInt(row.week_number)
            if (!isNaN(wn)) {
              weeks[wn] = {
                labComplete: row.lab_complete === 'Yes' || row.lab_complete === true,
                allDone: row.all_done === 'Yes' || row.all_done === true,
              }
            }
          }
        })

        return {
          className: cls.course_id,
          classId: cls.class_id,
          description: cls.course_name || '',
          requiredHours: cls.required_hours || 0,
          totalWeeks,
          classWeeks,
          weeks,
        }
      })

      setReport({ classes })
      hasLoadedRef.current = true
    } catch (err) {
      console.error('Error loading student report:', err)
    } finally {
      setLoading(false)
    }
  }, [profile])

  useEffect(() => { fetch() }, [fetch])

  // Real-time: refresh when weekly_lab_tracker changes
  useEffect(() => {
    if (!profile) return
    const channel = supabase
      .channel('student-lab-report-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_lab_tracker' }, () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile, fetch])

  return { report, loading, refresh: fetch }
}

// ─── Helper: UUID format check ──────────────────────────────────────────────
// Prevents passing legacy string IDs (e.g. "USR1026") to UUID-typed columns.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isValidUUID(id) { return !!id && UUID_REGEX.test(id) }

// ─── Helper: Find existing tracker record by user+class+week ────────────────
// Checks user_id first (only when it is a valid UUID), then falls back to
// user_email match to handle legacy string IDs like "USR1026".

async function findExistingRecord(userId, userEmail, className, weekNumber) {
  // Only query by user_id if it is a real UUID — legacy IDs cause a Postgres error
  if (isValidUUID(userId)) {
    const { data: byId } = await supabase
      .from('weekly_lab_tracker')
      .select('record_id')
      .eq('user_id', userId)
      .eq('course_id', className)
      .eq('week_number', weekNumber)
      .maybeSingle()

    if (byId) return byId
  }

  // Fallback: match by user_email (handles migrated users with text-based IDs)
  if (userEmail) {
    const { data: byEmail } = await supabase
      .from('weekly_lab_tracker')
      .select('record_id')
      .eq('user_email', userEmail)
      .eq('course_id', className)
      .eq('week_number', weekNumber)
      .maybeSingle()

    return byEmail || null
  }

  return null
}

// ─── Helper: Generate next record_id safely ─────────────────────────────────
// Uses timestamp + random suffix for guaranteed uniqueness.
// This eliminates the race condition from the old MAX(record_id) approach
// where two concurrent queries could get the same MAX and collide on insert.

function generateRecordId() {
  // Base36 timestamp (8 chars) + 4 random chars = collision-proof
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).substring(2, 6)
  return `WLT${ts}${rand}`
}

// ─── Helper: Insert with retry on duplicate key ─────────────────────────────
// If the insert fails due to duplicate key (extremely unlikely with timestamp+random
// IDs, but handled for safety), regenerate ID and retry up to 3 times.

async function insertWithRetry(record, maxRetries = 3) {
  let lastError = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const id = attempt === 0 ? record.record_id : generateRecordId()
    const { error } = await supabase
      .from('weekly_lab_tracker')
      .insert({ ...record, record_id: id })

    if (!error) return id

    // If it's a duplicate key error on the record_id, retry with a new ID
    if (error.code === '23505' || error.message?.includes('duplicate key')) {
      console.warn(`Duplicate key on attempt ${attempt + 1}, retrying with new ID...`)
      lastError = error
      continue
    }

    // Non-duplicate error — throw immediately
    throw error
  }

  // All retries exhausted
  throw lastError
}

// ─── Update Status (Instructor checkboxes), Sign Off Lab, & Mark All Done ────

export function useLabTrackerActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  // Ref-based guard prevents concurrent executions even when state hasn't flushed yet
  const savingRef = useRef(false)

  // ── Single field update (used by instructor checkboxes) ──
  const updateStatus = async (userId, userEmail, userName, className, classId, weekNumber, field, value, weekStartDate, weekEndDate) => {
    if (savingRef.current) return { success: false }
    savingRef.current = true
    setSaving(true)
    try {
      const existing = await findExistingRecord(userId, userEmail, className, weekNumber)

      if (existing) {
        const update = {}
        if (field === 'lab') update.lab_complete = value ? 'Yes' : 'No'
        if (field === 'done') {
          update.all_done = value ? 'Yes' : 'No'
          if (value) update.lab_complete = 'Yes' // Done implies lab complete
        }
        update.created_by = profile?.email

        const { error } = await supabase
          .from('weekly_lab_tracker')
          .update(update)
          .eq('record_id', existing.record_id)
        if (error) throw error
      } else {
        const recordId = generateRecordId()

        // Compute week date range if provided
        const wkStart = weekStartDate
          ? new Date(weekStartDate).toISOString().substring(0, 10)
          : ''
        const wkEnd = weekEndDate
          ? new Date(weekEndDate).toISOString().substring(0, 10)
          : ''

        await insertWithRetry({
          record_id: recordId,
          user_id: isValidUUID(userId) ? userId : null,
          user_name: userName,
          user_email: userEmail,
          class_id: classId,
          course_id: className,
          week_number: weekNumber,
          week_start_date: wkStart,
          week_end_date: wkEnd,
          lab_complete: field === 'lab' ? (value ? 'Yes' : 'No') : 'No',
          all_done: field === 'done' ? (value ? 'Yes' : 'No') : 'No',
          required_hours_met: 'No',
          created_at: new Date().toISOString(),
          created_by: profile?.email,
        })
      }

      toast.success('Updated')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // ── Sign Off Lab (student badge swipe for a single class/week) ──
  const signOffLab = async (userId, userEmail, userName, className, classId, weekNumber, weekStartDate, weekEndDate, instructor) => {
    // Guard against double-fire from rapid badge swipe events
    if (savingRef.current) {
      console.log('signOffLab: already processing, skipping duplicate call')
      return { success: false }
    }
    savingRef.current = true
    setSaving(true)

    try {
      // Check if record exists
      const existing = await findExistingRecord(userId, userEmail, className, weekNumber)

      if (existing) {
        // Record exists — just update it
        const { error } = await supabase
          .from('weekly_lab_tracker')
          .update({
            lab_complete: 'Yes',
            created_by: instructor.email,
          })
          .eq('record_id', existing.record_id)
        if (error) throw error
      } else {
        // No record — insert new one with retry on duplicate key
        const recordId = generateRecordId()

        const wkStart = weekStartDate
          ? new Date(weekStartDate).toISOString().substring(0, 10)
          : ''
        const wkEnd = weekEndDate
          ? new Date(weekEndDate).toISOString().substring(0, 10)
          : ''

        await insertWithRetry({
          record_id: recordId,
          user_id: isValidUUID(userId) ? userId : null,
          user_name: userName,
          user_email: userEmail,
          class_id: classId || '',
          course_id: className,
          week_number: weekNumber,
          week_start_date: wkStart,
          week_end_date: wkEnd,
          lab_complete: 'Yes',
          all_done: 'No',
          required_hours_met: 'No',
          created_at: new Date().toISOString(),
          created_by: instructor.email,
        })
      }

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          log_id: 'LOG' + Date.now(),
          timestamp: new Date().toISOString(),
          user_email: instructor.email,
          user_name: `${instructor.first_name} ${instructor.last_name}`,
          action: 'LAB_SIGN_OFF',
          entity_type: 'weekly_lab_tracker',
          entity_id: userId,
          field_changed: 'lab_complete',
          old_value: 'No',
          new_value: 'Yes',
          details: `Lab signed off for ${userName} — ${className}, Week ${weekNumber}`,
        })
      } catch (auditErr) {
        console.error('Audit log error:', auditErr)
      }

      toast.success(`Lab signed off by ${instructor.first_name} ${instructor.last_name}`)
      return { success: true }
    } catch (err) {
      console.error('Sign off lab error:', err)
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // ── Mark All Done (student badge swipe from student view) ──
  const markAllDone = async (userId, userEmail, userName, classInfos, instructor) => {
    // Guard against double-fire
    if (savingRef.current) {
      console.log('markAllDone: already processing, skipping duplicate call')
      return { success: false }
    }
    savingRef.current = true
    setSaving(true)

    try {
      // For each class, mark as all_done + lab_complete + required_hours_met
      for (const cls of classInfos) {
        const existing = await findExistingRecord(userId, userEmail, cls.className, cls.weekNumber)

        if (existing) {
          const { error } = await supabase
            .from('weekly_lab_tracker')
            .update({
              lab_complete: 'Yes',
              all_done: 'Yes',
              required_hours_met: 'Yes',
              created_by: instructor.email,
            })
            .eq('record_id', existing.record_id)
          if (error) throw error
        } else {
          // Generate unique ID per class — no more racy MAX query
          const recordId = generateRecordId()

          const weekStart = cls.weekStartDate
            ? new Date(cls.weekStartDate).toISOString().substring(0, 10)
            : ''
          const weekEnd = cls.weekEndDate
            ? new Date(cls.weekEndDate).toISOString().substring(0, 10)
            : ''

          await insertWithRetry({
            record_id: recordId,
            user_id: isValidUUID(userId) ? userId : null,
            user_name: userName,
            user_email: userEmail,
            class_id: cls.classId || '',
            course_id: cls.className,
            week_number: cls.weekNumber,
            week_start_date: weekStart,
            week_end_date: weekEnd,
            lab_complete: 'Yes',
            all_done: 'Yes',
            required_hours_met: 'Yes',
            created_at: new Date().toISOString(),
            created_by: instructor.email,
          })
        }
      }

      // 3. Cancel future lab signups for this week (dates after today through week end)
      const todayStr = new Date().toISOString().substring(0, 10)
      let latestWeekEnd = todayStr

      for (const cls of classInfos) {
        if (cls.weekEndDate) {
          const endStr = new Date(cls.weekEndDate).toISOString().substring(0, 10)
          if (endStr > latestWeekEnd) latestWeekEnd = endStr
        }
      }

      // Cancel signups for dates after today within the week
      if (latestWeekEnd > todayStr) {
        const { error: signupError } = await supabase
          .from('lab_signup')
          .update({ status: 'Cancelled' })
          .eq('user_email', userEmail)
          .eq('status', 'Confirmed')
          .gt('date', todayStr)
          .lte('date', latestWeekEnd)

        if (signupError) {
          console.error('Error cancelling future signups:', signupError)
        }
      }

      // 4. Update time clock: if student is currently punched in, mark as 'All Done'
      const { data: activeEntry } = await supabase
        .from('time_clock')
        .select('record_id, punch_in')
        .eq('user_email', userEmail)
        .eq('status', 'Punched In')
        .maybeSingle()

      if (activeEntry) {
        const now = new Date()
        // Compute diff using fake-UTC milliseconds for both sides so the
        // subtraction is apples-to-apples with the stored punch_in value.
        // punchIn is stored as fake-UTC (local time labeled +00), so
        // new Date(activeEntry.punch_in).getTime() gives the correct base ms.
        const nowFakeUtcMs = Date.UTC(
          now.getFullYear(), now.getMonth(), now.getDate(),
          now.getHours(), now.getMinutes(), now.getSeconds()
        )
        const punchIn = new Date(activeEntry.punch_in)
        const diffMs = nowFakeUtcMs - punchIn.getTime()
        const totalHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100

        const { error: tcError } = await supabase
          .from('time_clock')
          .update({
            punch_out: localToUtcIso(now),
            total_hours: totalHours,
            status: 'Punched Out',
            entry_type: 'All Done',
            description: `All Done — released by ${instructor.first_name} ${instructor.last_name}`,
          })
          .eq('record_id', activeEntry.record_id)

        if (tcError) {
          console.error('Error updating time clock:', tcError)
        }
      }

      // 5. Log to audit
      try {
        const classNames = classInfos.map(c => c.className).join(', ')
        await supabase.from('audit_log').insert({
          log_id: 'LOG' + Date.now(),
          timestamp: new Date().toISOString(),
          user_email: instructor.email,
          user_name: `${instructor.first_name} ${instructor.last_name}`,
          action: 'ALL_DONE',
          entity_type: 'weekly_lab_tracker',
          entity_id: userId,
          field_changed: 'all_done',
          old_value: 'No',
          new_value: 'Yes',
          details: `Marked All Done for ${userName} — Classes: ${classNames}, Week ${classInfos[0]?.weekNumber}`,
        })
      } catch (auditErr) {
        console.error('Audit log error:', auditErr)
      }

      return { success: true }
    } catch (err) {
      console.error('Mark All Done error:', err)
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return { updateStatus, signOffLab, markAllDone, saving }
}
