import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract local date string (YYYY-MM-DD) from a fake-UTC timestamp */
function extractDateFromTimestamp(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const yr = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dy = String(d.getUTCDate()).padStart(2, '0')
  return `${yr}-${mo}-${dy}`
}

/** Safe date parser: avoids timezone-shift issues with date-only strings */
function parseSafe(d) {
  if (!d) return null
  const s = (typeof d === 'string' ? d : d.toISOString()).substring(0, 10).split('-')
  return new Date(+s[0], +s[1] - 1, +s[2])
}

/** Format date to YYYY-MM-DD string from a JS Date */
function toSafeDateStr(d) {
  if (!d) return ''
  const yr = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dy = String(d.getDate()).padStart(2, '0')
  return `${yr}-${mo}-${dy}`
}

/**
 * Build weeks array from class data (matching the pattern in useWeeklyLabs.buildClassWeeks).
 * Weeks run Mon–Thu; skips spring break; flags finals.
 */
function buildWeeksFromClass(cls) {
  const startDate = cls.start_date || cls.startDate
  const endDate = cls.end_date || cls.endDate
  if (!startDate || !endDate) return []

  const start = parseSafe(startDate)
  const end = parseSafe(endDate)
  const sbStart = (cls.spring_break_start || cls.springBreakStart) ? parseSafe(cls.spring_break_start || cls.springBreakStart) : null
  const sbEnd = (cls.spring_break_end || cls.springBreakEnd) ? parseSafe(cls.spring_break_end || cls.springBreakEnd) : null
  const finalsStart = (cls.finals_start || cls.finalsStart) ? parseSafe(cls.finals_start || cls.finalsStart) : null
  const finalsEnd = (cls.finals_end || cls.finalsEnd) ? parseSafe(cls.finals_end || cls.finalsEnd) : null

  // Start from the Monday of the start week
  const weekStart = new Date(start)
  const day = weekStart.getDay()
  if (day !== 1) weekStart.setDate(weekStart.getDate() - ((day + 6) % 7))

  const weeks = []
  let weekNum = 1
  let current = new Date(weekStart)

  while (current <= end) {
    const wkStart = new Date(current)
    const wkEnd = new Date(current)
    wkEnd.setDate(wkEnd.getDate() + 6) // Sunday (full week for matching)

    const wkEndThu = new Date(current)
    wkEndThu.setDate(wkEndThu.getDate() + 3) // Mon-Thu for spring break check

    // Check if this week overlaps with spring break
    const isSpringBreak = sbStart && sbEnd &&
      wkStart <= sbEnd && wkEndThu >= sbStart

    // Check if this is finals week
    const isFinals = finalsStart && finalsEnd &&
      wkStart >= finalsStart && wkStart <= finalsEnd

    if (!isSpringBreak) {
      weeks.push({
        weekNumber: weekNum,
        startDate: toSafeDateStr(wkStart),
        endDate: toSafeDateStr(wkEnd),
        isFinals: !!isFinals,
      })
      weekNum++
    }

    current.setDate(current.getDate() + 7)
  }

  return weeks
}

/**
 * Determine which week a date falls into.
 * Returns weekNumber or null if date doesn't fit any week.
 */
function getWeekForDate(dateStr, weeks) {
  if (!dateStr || !weeks.length) return null
  for (const w of weeks) {
    if (dateStr >= w.startDate && dateStr <= w.endDate) {
      return w.weekNumber
    }
  }
  return null
}

/**
 * Get the Monday-based week_start string for a given date.
 * This matches the time_clock.week_start convention.
 */
function getMonday(dateStr) {
  const d = parseSafe(dateStr)
  if (!d) return null
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day // Monday
  d.setDate(d.getDate() + diff)
  return toSafeDateStr(d)
}

// ─── Classes List (all, including archived) ──────────────────────────────────

export function useAttendanceClasses() {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('classes')
        .select('*')
        .order('semester', { ascending: false })
        .order('course_id')
      if (error) throw error
      setClasses(data || [])
    } catch (err) {
      console.error('Attendance classes fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])
  return { classes, loading }
}

// ─── Students List (all with user_id, including inactive for historical) ─────

export function useAttendanceStudents() {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role, email, status, classes')
        .in('role', ['Student', 'Work Study'])
        .order('last_name')
      if (error) throw error
      // Filter to users that have a valid user_id
      setStudents((data || []).filter(u => u.user_id && u.user_id.trim() !== ''))
    } catch (err) {
      console.error('Attendance students fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])
  return { students, loading }
}

// ─── Class Attendance Report ─────────────────────────────────────────────────
//
// Given a class_id (or course_id), fetches all enrolled students' time_clock
// entries and builds a week-by-week grid:
//   { students: [ { name, email, userId, weeks: { [weekNum]: hours }, total } ],
//     weeks: [ { weekNumber, startDate, endDate, isFinals } ],
//     averages: { [weekNum]: avgHours },
//     classInfo: { ... },
//     requiredHoursPerWeek }
//

export function useClassAttendanceReport() {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const lastParamsRef = useRef(null)

  const fetchReport = useCallback(async (classId, dateStart, dateEnd) => {
    if (!classId) return
    lastParamsRef.current = { classId, dateStart, dateEnd }
    setLoading(true)

    try {
      // 1. Get class data (could be active or archived)
      // Try matching by class_id first, then course_id
      let classData = null
      const { data: byClassId } = await supabase
        .from('classes')
        .select('*')
        .eq('class_id', classId)
        .maybeSingle()

      if (byClassId) {
        classData = byClassId
      } else {
        const { data: byCourseId } = await supabase
          .from('classes')
          .select('*')
          .eq('course_id', classId)
          .maybeSingle()
        classData = byCourseId
      }

      if (!classData) {
        toast.error('Class not found')
        setReport(null)
        setLoading(false)
        return
      }

      const courseId = classData.course_id
      const clsId = classData.class_id
      const requiredHoursPerWeek = parseFloat(classData.required_hours) || 0

      // 2. Build weeks from class date range
      const weeks = buildWeeksFromClass(classData)

      // 3. Determine effective date range
      // If user specified a range, use it; otherwise use class dates
      const effectiveStart = dateStart || classData.start_date?.split('T')[0] || ''
      const effectiveEnd = dateEnd || classData.end_date?.split('T')[0] || ''

      // Filter weeks to effective date range
      const filteredWeeks = weeks.filter(w =>
        w.endDate >= effectiveStart && w.startDate <= effectiveEnd
      )

      // 4. Find enrolled students
      const { data: allUsers } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role, classes, email, status')
        .in('role', ['Student', 'Work Study'])

      const enrolled = (allUsers || []).filter(u => {
        if (!u.user_id || u.user_id.trim() === '') return false
        const cls = (u.classes || '').split(',').map(c => c.trim())
        return cls.includes(clsId) || cls.includes(courseId)
      })

      // 5. Fetch time_clock entries for all enrolled students in this class
      const userIds = enrolled.map(u => u.user_id)
      let tcRecords = []
      if (userIds.length > 0 && effectiveStart && effectiveEnd) {
        const { data } = await supabase
          .from('time_clock')
          .select('*')
          .in('user_id', userIds)
          .or(`course_id.eq.${courseId},class_id.eq.${clsId}`)
          .gte('punch_in', effectiveStart)
          .lte('punch_in', effectiveEnd + 'T23:59:59')
          .eq('status', 'Punched Out')
        tcRecords = data || []
      }

      // 6. Build student × week grid
      const studentData = enrolled.map(u => {
        const userRecords = tcRecords.filter(r => r.user_id === u.user_id)
        const weekHours = {}
        let total = 0

        userRecords.forEach(r => {
          const hrs = parseFloat(r.total_hours) || 0
          const dateStr = extractDateFromTimestamp(r.punch_in)
          const weekNum = getWeekForDate(dateStr, filteredWeeks)
          if (weekNum !== null) {
            weekHours[weekNum] = (weekHours[weekNum] || 0) + hrs
            total += hrs
          }
        })

        // Round values
        Object.keys(weekHours).forEach(k => {
          weekHours[k] = Math.round(weekHours[k] * 100) / 100
        })

        return {
          userId: u.user_id,
          name: `${u.first_name} ${u.last_name}`,
          email: u.email,
          status: u.status,
          weeks: weekHours,
          total: Math.round(total * 100) / 100,
        }
      }).sort((a, b) => a.name.localeCompare(b.name))

      // 7. Calculate averages per week
      const averages = {}
      const studentCount = studentData.length || 1
      filteredWeeks.forEach(w => {
        const sum = studentData.reduce((s, st) => s + (st.weeks[w.weekNumber] || 0), 0)
        averages[w.weekNumber] = Math.round((sum / studentCount) * 100) / 100
      })

      // Grand average total
      const grandAvgTotal = studentData.length > 0
        ? Math.round((studentData.reduce((s, st) => s + st.total, 0) / studentCount) * 100) / 100
        : 0

      setReport({
        classInfo: classData,
        courseId,
        requiredHoursPerWeek,
        weeks: filteredWeeks,
        students: studentData,
        averages,
        grandAvgTotal,
        effectiveStart,
        effectiveEnd,
      })
    } catch (err) {
      console.error('Class attendance report error:', err)
      toast.error('Failed to load class report')
    } finally {
      setLoading(false)
    }
  }, [])

  return { report, loading, fetchReport }
}

// ─── Student Attendance Report ───────────────────────────────────────────────
//
// Given a user_id, fetches ALL their time_clock entries across ALL classes
// (including archived) and builds a per-class, week-by-week grid.
//
// Returns:
//   { student: { name, email, ... },
//     classReports: [ { classInfo, courseId, weeks, weekHours, total, requiredPerWeek } ],
//     grandTotal }

export function useStudentAttendanceReport() {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const lastParamsRef = useRef(null)

  const fetchReport = useCallback(async (userId) => {
    if (!userId) return
    lastParamsRef.current = { userId }
    setLoading(true)

    try {
      // 1. Get student profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role, email, status, classes')
        .eq('user_id', userId)
        .maybeSingle()

      if (!profile) {
        toast.error('Student not found')
        setReport(null)
        setLoading(false)
        return
      }

      // 2. Get ALL time_clock entries for this student (no date filter — full history)
      const { data: allEntries } = await supabase
        .from('time_clock')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'Punched Out')
        .order('punch_in', { ascending: true })

      const tcRecords = allEntries || []

      // 3. Determine all unique course_ids from entries + enrolled classes
      const enrolledCourses = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean)
      const entryCoursesSet = new Set()
      tcRecords.forEach(r => {
        if (r.course_id) entryCoursesSet.add(r.course_id)
      })
      const allCourseIds = [...new Set([...enrolledCourses, ...entryCoursesSet])]

      // 4. Fetch class metadata for all relevant courses (active + archived)
      let classesData = []
      if (allCourseIds.length > 0) {
        const { data } = await supabase
          .from('classes')
          .select('*')
          .in('course_id', allCourseIds)
        classesData = data || []
      }

      // 5. Build per-class reports
      const classReports = classesData.map(cls => {
        const courseId = cls.course_id
        const clsId = cls.class_id
        const requiredPerWeek = parseFloat(cls.required_hours) || 0
        const weeks = buildWeeksFromClass(cls)

        // Filter entries for this class
        const classEntries = tcRecords.filter(r =>
          r.course_id === courseId || r.class_id === clsId
        )

        const weekHours = {}
        let total = 0

        classEntries.forEach(r => {
          const hrs = parseFloat(r.total_hours) || 0
          const dateStr = extractDateFromTimestamp(r.punch_in)
          const weekNum = getWeekForDate(dateStr, weeks)
          if (weekNum !== null) {
            weekHours[weekNum] = (weekHours[weekNum] || 0) + hrs
            total += hrs
          }
        })

        // Round values
        Object.keys(weekHours).forEach(k => {
          weekHours[k] = Math.round(weekHours[k] * 100) / 100
        })

        return {
          classInfo: cls,
          courseId,
          courseName: cls.course_name || courseId,
          semester: cls.semester || '',
          status: cls.status,
          requiredPerWeek,
          weeks,
          weekHours,
          total: Math.round(total * 100) / 100,
        }
      }).sort((a, b) => {
        // Sort by semester descending, then courseId
        if (a.semester !== b.semester) return b.semester.localeCompare(a.semester)
        return a.courseId.localeCompare(b.courseId)
      })

      const grandTotal = Math.round(
        classReports.reduce((s, cr) => s + cr.total, 0) * 100
      ) / 100

      setReport({
        student: {
          userId: profile.user_id,
          name: `${profile.first_name} ${profile.last_name}`,
          email: profile.email,
          role: profile.role,
          status: profile.status,
        },
        classReports,
        grandTotal,
      })
    } catch (err) {
      console.error('Student attendance report error:', err)
      toast.error('Failed to load student report')
    } finally {
      setLoading(false)
    }
  }, [])

  return { report, loading, fetchReport }
}

// ─── Export Helpers ───────────────────────────────────────────────────────────

/**
 * Generate CSV content string from a 2D array of rows.
 * Handles escaping commas and quotes.
 */
export function arrayToCSV(rows) {
  return rows.map(row =>
    row.map(cell => {
      const str = String(cell ?? '')
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }).join(',')
  ).join('\n')
}

/**
 * Trigger a file download in the browser.
 */
export function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Build Class Report rows for export (CSV / XLSX).
 * Returns a 2D array of rows including headers.
 */
export function buildClassReportExportData(report) {
  if (!report) return []

  const { classInfo, weeks, students, averages, grandAvgTotal, requiredHoursPerWeek } = report
  const rows = []

  // Title row
  rows.push([`Class Attendance Report: ${classInfo.course_id} – ${classInfo.course_name || ''}`])
  rows.push([`Semester: ${classInfo.semester || 'N/A'}`, `Required Hours/Week: ${requiredHoursPerWeek}`])
  rows.push([]) // blank row

  // Header row
  const header = ['Student', ...weeks.map(w => `Wk ${w.weekNumber} (${w.startDate})`), 'Total', '% of Required']
  rows.push(header)

  // Student rows
  students.forEach(st => {
    const totalRequired = requiredHoursPerWeek * weeks.length
    const pctMet = totalRequired > 0 ? Math.round((st.total / totalRequired) * 100) : 0
    const row = [
      st.name,
      ...weeks.map(w => st.weeks[w.weekNumber] || 0),
      st.total,
      `${pctMet}%`,
    ]
    rows.push(row)
  })

  // Average row
  rows.push([
    'Class Average',
    ...weeks.map(w => averages[w.weekNumber] || 0),
    grandAvgTotal,
    '',
  ])

  return rows
}

/**
 * Build Student Report rows for export (CSV / XLSX).
 */
export function buildStudentReportExportData(report) {
  if (!report) return []

  const { student, classReports, grandTotal } = report
  const rows = []

  rows.push([`Student Attendance Report: ${student.name}`])
  rows.push([`Email: ${student.email}`, `Role: ${student.role}`])
  rows.push([]) // blank row

  classReports.forEach(cr => {
    rows.push([`${cr.courseId} – ${cr.courseName}`, `Semester: ${cr.semester}`, `Status: ${cr.status}`])
    rows.push([`Required Hours/Week: ${cr.requiredPerWeek}`])

    const header = ['Week', 'Date Range', 'Hours', '% of Required']
    rows.push(header)

    cr.weeks.forEach(w => {
      const hrs = cr.weekHours[w.weekNumber] || 0
      const pct = cr.requiredPerWeek > 0 ? Math.round((hrs / cr.requiredPerWeek) * 100) : 0
      rows.push([
        `Week ${w.weekNumber}`,
        `${w.startDate} – ${w.endDate}`,
        hrs,
        `${pct}%`,
      ])
    })

    const totalRequired = cr.requiredPerWeek * cr.weeks.length
    const totalPct = totalRequired > 0 ? Math.round((cr.total / totalRequired) * 100) : 0
    rows.push(['Total', '', cr.total, `${totalPct}%`])
    rows.push([]) // blank row between classes
  })

  rows.push(['Grand Total Across All Classes', '', grandTotal, ''])

  return rows
}
