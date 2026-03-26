/**
 * RICT CMMS — Attendance Reports Page
 *
 * Instructor-only page with two report tabs:
 *
 * 1. **Class Report** — Select a class to see every enrolled student's
 *    hours week-by-week, with class averages, heat-map colouring,
 *    sparkline trend bars, and % of required hours met.
 *
 * 2. **Student Report** — Select a student to see their hours across
 *    ALL classes (including archived) week-by-week.
 *
 * Features:
 *   - Date range filter (defaults to full semester)
 *   - Zero-hour weeks highlighted in red/warning
 *   - Heat-map colour intensity on hour cells
 *   - Mini sparkline bar chart per student
 *   - CSV, XLSX (via SheetJS), and PDF (print) export
 *   - Fully accessible: semantic tables, ARIA roles, keyboard navigation
 *   - Print-friendly layout with page breaks
 *
 * Accessibility (WCAG 2.1 AA):
 *   - role="tablist" / role="tab" / role="tabpanel" on tab interface
 *   - aria-selected, aria-controls, aria-labelledby on tabs
 *   - <caption> on all data tables
 *   - <th scope="col|row"> on header cells
 *   - Colour is never the sole indicator (icons + patterns accompany colour)
 *   - Focus-visible outlines on interactive elements
 *   - aria-live regions for loading states
 *   - All form controls have visible <label> elements
 */

import React, { useState, useMemo, useCallback, useRef, useId, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useAttendanceClasses,
  useAttendanceStudents,
  useClassAttendanceReport,
  useStudentAttendanceReport,
  arrayToCSV,
  downloadBlob,
  buildClassReportExportData,
  buildStudentReportExportData,
} from '@/hooks/useAttendanceReports'
import {
  Loader2, Users, User, BarChart3, Download, Printer,
  FileSpreadsheet, AlertTriangle, TrendingUp,
  ChevronDown, Search, Info,
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatHours(h) {
  const totalMins = Math.round((Number(h) || 0) * 60)
  if (totalMins <= 0) return '0h'
  const hrs = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hrs === 0) return `${mins}m`
  if (mins === 0) return `${hrs}h`
  return `${hrs}h ${mins}m`
}

function formatDateShort(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Heat-map background colour based on percentage of required hours met.
 * Returns an object { bg, text, pattern } for the cell.
 * Uses both colour AND a pattern marker so colour is never the sole indicator.
 */
function heatMapStyle(hours, required) {
  if (required <= 0) {
    // No required hours defined — just show neutral
    return { bg: 'transparent', text: 'inherit', marker: '' }
  }
  const pct = (hours / required) * 100
  if (hours === 0) {
    return { bg: 'rgba(239,68,68,0.15)', text: '#dc2626', marker: '✗' }
  }
  if (pct < 50) {
    return { bg: 'rgba(239,68,68,0.10)', text: '#dc2626', marker: '▽' }
  }
  if (pct < 75) {
    return { bg: 'rgba(245,158,11,0.12)', text: '#b45309', marker: '◇' }
  }
  if (pct < 100) {
    return { bg: 'rgba(59,130,246,0.10)', text: '#2563eb', marker: '' }
  }
  // >= 100%
  return { bg: 'rgba(34,197,94,0.12)', text: '#16a34a', marker: '✓' }
}

/**
 * Inline sparkline SVG — mini bar chart showing hours per week.
 * Each bar is proportional to the max hour value across weeks.
 */
function Sparkline({ weekHours, weeks, required }) {
  if (!weeks || weeks.length === 0) return null
  const values = weeks.map(w => weekHours[w.weekNumber] || 0)
  const max = Math.max(...values, required || 1, 0.1)
  const barW = Math.min(6, Math.max(2, Math.floor(60 / weeks.length)))
  const gap = 1
  const svgW = weeks.length * (barW + gap)
  const svgH = 20

  return (
    <svg
      width={svgW}
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      role="img"
      aria-label={`Trend: ${values.map(v => formatHours(v)).join(', ')}`}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      {/* Required-hours baseline */}
      {required > 0 && (
        <line
          x1={0} y1={svgH - (required / max) * svgH}
          x2={svgW} y2={svgH - (required / max) * svgH}
          stroke="#94a3b8" strokeWidth={0.5} strokeDasharray="2,1"
        />
      )}
      {values.map((v, i) => {
        const h = Math.max((v / max) * svgH, v > 0 ? 1 : 0)
        const pct = required > 0 ? v / required : 1
        let fill = '#3b82f6'
        if (v === 0) fill = '#ef4444'
        else if (pct < 0.5) fill = '#ef4444'
        else if (pct < 0.75) fill = '#f59e0b'
        else if (pct >= 1) fill = '#22c55e'
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={svgH - h}
            width={barW}
            height={h}
            rx={1}
            fill={fill}
          />
        )
      })}
    </svg>
  )
}

// ─── XLSX Export (SheetJS) ────────────────────────────────────────────────────

async function exportXLSX(rows, filename) {
  try {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Report')
    XLSX.writeFile(wb, filename)
  } catch (err) {
    console.error('XLSX export error:', err)
    toast_error('Excel export failed. The xlsx package may not be installed. Run: npm install xlsx')
  }
}

/** Safely show toast error (imported dynamically to avoid circular deps) */
function toast_error(msg) {
  try {
    import('react-hot-toast').then(m => m.default.error(msg))
  } catch { alert(msg) }
}

function toast_success(msg) {
  try {
    import('react-hot-toast').then(m => m.default.success(msg))
  } catch {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function AttendanceReportsPage() {
  const { profile } = useAuth()
  const isInstructor = profile?.role === 'Instructor'

  const [activeTab, setActiveTab] = useState('class')
  const tabListId = useId()
  const classTabId = `tab-class-${tabListId}`
  const studentTabId = `tab-student-${tabListId}`
  const classPanelId = `panel-class-${tabListId}`
  const studentPanelId = `panel-student-${tabListId}`

  // Keyboard navigation for tabs
  const handleTabKeyDown = useCallback((e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      setActiveTab(prev => prev === 'class' ? 'student' : 'class')
    }
  }, [])

  // Focus the newly active tab on change
  const classTabRef = useRef(null)
  const studentTabRef = useRef(null)
  useEffect(() => {
    if (activeTab === 'class') classTabRef.current?.focus()
    else studentTabRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // Gate: instructor only
  if (!isInstructor) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="card p-8 text-center">
          <AlertTriangle className="mx-auto mb-3 text-amber-500" size={40} aria-hidden="true" />
          <h1 className="text-lg font-semibold text-surface-900 mb-2">Access Restricted</h1>
          <p className="text-surface-500 text-sm">Attendance Reports are only available to instructors.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto attendance-reports-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-surface-900 flex items-center gap-2">
          <BarChart3 size={24} className="text-brand-600" aria-hidden="true" />
          Attendance Reports
        </h1>
        <p className="text-sm text-surface-500 mt-1">
          Week-by-week attendance analysis for classes and individual students.
        </p>
      </div>

      {/* Tab Bar */}
      <div
        role="tablist"
        aria-label="Report type"
        className="flex gap-1 bg-surface-100 rounded-xl p-1 mb-6 w-fit"
        onKeyDown={handleTabKeyDown}
      >
        <button
          ref={classTabRef}
          role="tab"
          id={classTabId}
          aria-selected={activeTab === 'class'}
          aria-controls={classPanelId}
          tabIndex={activeTab === 'class' ? 0 : -1}
          onClick={() => setActiveTab('class')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            activeTab === 'class'
              ? 'bg-white text-brand-700 shadow-sm'
              : 'text-surface-500 hover:text-surface-700'
          }`}
        >
          <Users size={16} aria-hidden="true" />
          Class Report
        </button>
        <button
          ref={studentTabRef}
          role="tab"
          id={studentTabId}
          aria-selected={activeTab === 'student'}
          aria-controls={studentPanelId}
          tabIndex={activeTab === 'student' ? 0 : -1}
          onClick={() => setActiveTab('student')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            activeTab === 'student'
              ? 'bg-white text-brand-700 shadow-sm'
              : 'text-surface-500 hover:text-surface-700'
          }`}
        >
          <User size={16} aria-hidden="true" />
          Student Report
        </button>
      </div>

      {/* Tab Panels */}
      <div
        role="tabpanel"
        id={classPanelId}
        aria-labelledby={classTabId}
        hidden={activeTab !== 'class'}
        tabIndex={0}
      >
        {activeTab === 'class' && <ClassReportPanel />}
      </div>
      <div
        role="tabpanel"
        id={studentPanelId}
        aria-labelledby={studentTabId}
        hidden={activeTab !== 'student'}
        tabIndex={0}
      >
        {activeTab === 'student' && <StudentReportPanel />}
      </div>

      {/* Print Styles (injected inline so they always apply) */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .attendance-reports-page,
          .attendance-reports-page * { visibility: visible; }
          .attendance-reports-page { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          .print-break { page-break-before: always; }
          table { font-size: 9px; }
          th, td { padding: 2px 4px; }
        }
      `}</style>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLASS REPORT PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function ClassReportPanel() {
  const { classes, loading: classesLoading } = useAttendanceClasses()
  const { report, loading, fetchReport } = useClassAttendanceReport()
  const [selectedClass, setSelectedClass] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const tableRef = useRef(null)
  const classSelectId = useId()
  const dateStartId = useId()
  const dateEndId = useId()
  const searchId = useId()

  // When a class is selected, auto-fill date range to class start/end
  const handleClassChange = useCallback((e) => {
    const classId = e.target.value
    setSelectedClass(classId)
    if (classId) {
      const cls = classes.find(c => c.class_id === classId || c.course_id === classId)
      if (cls) {
        setDateStart(cls.start_date ? cls.start_date.split('T')[0] : '')
        setDateEnd(cls.end_date ? cls.end_date.split('T')[0] : '')
      }
    }
  }, [classes])

  const handleGenerate = useCallback(() => {
    if (selectedClass) {
      fetchReport(selectedClass, dateStart, dateEnd)
    }
  }, [selectedClass, dateStart, dateEnd, fetchReport])

  // Filter students by search term
  const filteredStudents = useMemo(() => {
    if (!report) return []
    if (!searchTerm.trim()) return report.students
    const term = searchTerm.toLowerCase()
    return report.students.filter(s =>
      s.name.toLowerCase().includes(term) || s.email.toLowerCase().includes(term)
    )
  }, [report, searchTerm])

  // Filtered averages
  const filteredAverages = useMemo(() => {
    if (!report || filteredStudents.length === 0) return {}
    const avgs = {}
    const count = filteredStudents.length
    report.weeks.forEach(w => {
      const sum = filteredStudents.reduce((s, st) => s + (st.weeks[w.weekNumber] || 0), 0)
      avgs[w.weekNumber] = Math.round((sum / count) * 100) / 100
    })
    return avgs
  }, [report, filteredStudents])

  const filteredGrandAvg = useMemo(() => {
    if (filteredStudents.length === 0) return 0
    return Math.round(
      (filteredStudents.reduce((s, st) => s + st.total, 0) / filteredStudents.length) * 100
    ) / 100
  }, [filteredStudents])

  // Export handlers
  const handleCSVExport = useCallback(() => {
    if (!report) return
    const rows = buildClassReportExportData(report)
    const csv = arrayToCSV(rows)
    downloadBlob(csv, `class-report-${report.courseId}-${new Date().toISOString().split('T')[0]}.csv`, 'text/csv')
    toast_success('CSV exported')
  }, [report])

  const handleXLSXExport = useCallback(() => {
    if (!report) return
    const rows = buildClassReportExportData(report)
    exportXLSX(rows, `class-report-${report.courseId}-${new Date().toISOString().split('T')[0]}.xlsx`)
  }, [report])

  const handlePrint = useCallback(() => { window.print() }, [])

  // Group classes by semester for the dropdown
  const groupedClasses = useMemo(() => {
    const groups = {}
    classes.forEach(c => {
      const key = c.semester || 'Unknown'
      if (!groups[key]) groups[key] = []
      groups[key].push(c)
    })
    // Sort semesters descending
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]))
  }, [classes])

  return (
    <div>
      {/* Controls */}
      <div className="card p-4 mb-4 no-print">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Class selector */}
          <div className="flex-1 min-w-[200px]">
            <label htmlFor={classSelectId} className="label">
              Class
            </label>
            <select
              id={classSelectId}
              value={selectedClass}
              onChange={handleClassChange}
              className="input"
              aria-describedby="class-select-help"
            >
              <option value="">— Select a class —</option>
              {groupedClasses.map(([semester, clsList]) => (
                <optgroup key={semester} label={semester}>
                  {clsList.map(c => (
                    <option key={c.class_id} value={c.class_id}>
                      {c.course_id} – {c.course_name || ''} {c.status !== 'Active' ? `(${c.status})` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span id="class-select-help" className="sr-only">
              Choose a class to generate the attendance report. Archived classes are also available.
            </span>
          </div>

          {/* Date range */}
          <div className="min-w-[140px]">
            <label htmlFor={dateStartId} className="label">
              Start Date
            </label>
            <input
              id={dateStartId}
              type="date"
              value={dateStart}
              onChange={e => setDateStart(e.target.value)}
              className="input"
            />
          </div>
          <div className="min-w-[140px]">
            <label htmlFor={dateEndId} className="label">
              End Date
            </label>
            <input
              id={dateEndId}
              type="date"
              value={dateEnd}
              onChange={e => setDateEnd(e.target.value)}
              className="input"
            />
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!selectedClass || loading}
            className="btn-primary"
            aria-busy={loading}
          >
            {loading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <BarChart3 size={16} aria-hidden="true" />}
            {loading ? 'Loading…' : 'Generate'}
          </button>
        </div>
      </div>

      {/* Loading indicator */}
      {loading && (
        <div className="text-center py-12" role="status" aria-live="polite">
          <Loader2 className="mx-auto animate-spin text-brand-600" size={32} aria-hidden="true" />
          <p className="text-surface-500 text-sm mt-3">Building report…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !report && selectedClass && (
        <div className="card p-8 text-center">
          <Info className="mx-auto mb-3 text-surface-400" size={32} aria-hidden="true" />
          <p className="text-surface-500 text-sm">Click <strong>Generate</strong> to build the report.</p>
        </div>
      )}

      {/* Report */}
      {!loading && report && (
        <div>
          {/* Summary bar */}
          <div className="card p-4 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-surface-900">
                  {report.classInfo.course_id} — {report.classInfo.course_name || ''}
                </h2>
                <p className="text-sm text-surface-500">
                  {report.classInfo.semester || ''} · {report.students.length} student{report.students.length !== 1 ? 's' : ''} · {report.weeks.length} week{report.weeks.length !== 1 ? 's' : ''} · Required: {report.requiredHoursPerWeek}h/wk
                </p>
              </div>
              <div className="flex gap-2 no-print">
                {/* Search */}
                <div className="relative">
                  <label htmlFor={searchId} className="sr-only">Search students</label>
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
                  <input
                    id={searchId}
                    type="text"
                    placeholder="Filter students…"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="input pl-8 py-1.5 text-xs w-44"
                  />
                </div>
                <button onClick={handleCSVExport} className="btn-secondary btn-sm" title="Export CSV">
                  <Download size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">CSV</span>
                </button>
                <button onClick={handleXLSXExport} className="btn-secondary btn-sm" title="Export Excel">
                  <FileSpreadsheet size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">Excel</span>
                </button>
                <button onClick={handlePrint} className="btn-secondary btn-sm" title="Print / PDF">
                  <Printer size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">Print</span>
                </button>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 mb-3 text-xs text-surface-600 no-print" role="note" aria-label="Colour legend">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(239,68,68,0.15)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#dc2626' }}>✗</span> 0 hours
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(239,68,68,0.10)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#dc2626' }}>▽</span> &lt;50%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(245,158,11,0.12)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#b45309' }}>◇</span> 50–74%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(59,130,246,0.10)' }} aria-hidden="true" />
              75–99%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(34,197,94,0.12)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#16a34a' }}>✓</span> ≥100%
            </span>
          </div>

          {/* Data Table */}
          <div className="card overflow-x-auto" ref={tableRef}>
            <table className="w-full text-sm border-collapse">
              <caption className="sr-only">
                {report.classInfo.course_id} attendance data — {report.students.length} students over {report.weeks.length} weeks
              </caption>
              <thead className="bg-surface-50 sticky top-0 z-10">
                <tr>
                  <th scope="col" className="text-left px-3 py-2.5 font-semibold text-surface-700 border-b border-surface-200 whitespace-nowrap">
                    Student
                  </th>
                  <th scope="col" className="text-center px-1 py-2.5 font-medium text-surface-500 border-b border-surface-200 whitespace-nowrap text-xs" title="Trend sparkline">
                    Trend
                  </th>
                  {report.weeks.map(w => (
                    <th
                      key={w.weekNumber}
                      scope="col"
                      className="text-center px-2 py-2.5 font-medium text-surface-600 border-b border-surface-200 whitespace-nowrap text-xs"
                      title={`Week ${w.weekNumber}: ${w.startDate} – ${w.endDate}${w.isFinals ? ' (Finals)' : ''}`}
                    >
                      <div>Wk {w.weekNumber}</div>
                      <div className="text-[10px] text-surface-400 font-normal">{formatDateShort(w.startDate)}</div>
                      {w.isFinals && <div className="text-[9px] text-amber-600 font-normal">Finals</div>}
                    </th>
                  ))}
                  <th scope="col" className="text-center px-3 py-2.5 font-semibold text-surface-700 border-b border-surface-200 whitespace-nowrap">
                    Total
                  </th>
                  <th scope="col" className="text-center px-2 py-2.5 font-semibold text-surface-700 border-b border-surface-200 whitespace-nowrap text-xs" title="Percentage of total required hours met">
                    % Met
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.length === 0 && (
                  <tr>
                    <td colSpan={report.weeks.length + 4} className="text-center py-8 text-surface-400 text-sm">
                      {searchTerm ? 'No students match your filter.' : 'No enrolled students found for this class.'}
                    </td>
                  </tr>
                )}
                {filteredStudents.map((st, idx) => {
                  const totalRequired = report.requiredHoursPerWeek * report.weeks.length
                  const pctMet = totalRequired > 0 ? Math.round((st.total / totalRequired) * 100) : null

                  return (
                    <tr key={st.userId} className={idx % 2 === 0 ? 'bg-white' : 'bg-surface-50/50'}>
                      <th scope="row" className="text-left px-3 py-2 font-medium text-surface-800 whitespace-nowrap border-b border-surface-100">
                        <div>{st.name}</div>
                      </th>
                      <td className="text-center px-1 py-2 border-b border-surface-100">
                        <Sparkline
                          weekHours={st.weeks}
                          weeks={report.weeks}
                          required={report.requiredHoursPerWeek}
                        />
                      </td>
                      {report.weeks.map(w => {
                        const hrs = st.weeks[w.weekNumber] || 0
                        const style = heatMapStyle(hrs, report.requiredHoursPerWeek)
                        return (
                          <td
                            key={w.weekNumber}
                            className="text-center px-2 py-2 border-b border-surface-100 tabular-nums text-xs font-medium"
                            style={{ background: style.bg, color: style.text }}
                            title={`${st.name} — Week ${w.weekNumber}: ${formatHours(hrs)}${report.requiredHoursPerWeek ? ` / ${report.requiredHoursPerWeek}h required` : ''}`}
                          >
                            {style.marker && (
                              <span className="sr-only">{style.marker === '✗' ? 'Zero hours' : style.marker === '✓' ? 'Met requirement' : 'Below target'} </span>
                            )}
                            {formatHours(hrs)}
                            {style.marker && <span className="ml-0.5 text-[10px]" aria-hidden="true">{style.marker}</span>}
                          </td>
                        )
                      })}
                      <td className="text-center px-3 py-2 border-b border-surface-100 font-semibold text-surface-900 tabular-nums">
                        {formatHours(st.total)}
                      </td>
                      <td className="text-center px-2 py-2 border-b border-surface-100 tabular-nums text-xs font-semibold">
                        {pctMet !== null ? (
                          <span className={pctMet >= 100 ? 'text-green-600' : pctMet >= 75 ? 'text-blue-600' : pctMet >= 50 ? 'text-amber-600' : 'text-red-600'}>
                            {pctMet}%
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {filteredStudents.length > 0 && (
                <tfoot className="bg-surface-100/80">
                  <tr className="font-semibold">
                    <th scope="row" className="text-left px-3 py-2.5 text-surface-700 border-t-2 border-surface-300">
                      Class Average
                    </th>
                    <td className="border-t-2 border-surface-300" />
                    {report.weeks.map(w => {
                      const avg = filteredAverages[w.weekNumber] || 0
                      const style = heatMapStyle(avg, report.requiredHoursPerWeek)
                      return (
                        <td
                          key={w.weekNumber}
                          className="text-center px-2 py-2.5 border-t-2 border-surface-300 tabular-nums text-xs"
                          style={{ background: style.bg, color: style.text }}
                        >
                          {formatHours(avg)}
                        </td>
                      )
                    })}
                    <td className="text-center px-3 py-2.5 border-t-2 border-surface-300 text-surface-900 tabular-nums">
                      {formatHours(filteredGrandAvg)}
                    </td>
                    <td className="border-t-2 border-surface-300" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT REPORT PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function StudentReportPanel() {
  const { students, loading: studentsLoading } = useAttendanceStudents()
  const { report, loading, fetchReport } = useStudentAttendanceReport()
  const [selectedStudent, setSelectedStudent] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [expandedClasses, setExpandedClasses] = useState({})
  const studentSelectId = useId()
  const studentSearchId = useId()

  const handleGenerate = useCallback(() => {
    if (selectedStudent) {
      fetchReport(selectedStudent)
      setExpandedClasses({}) // reset expansions on new report
    }
  }, [selectedStudent, fetchReport])

  const toggleClass = useCallback((courseId) => {
    setExpandedClasses(prev => ({ ...prev, [courseId]: !prev[courseId] }))
  }, [])

  const expandAll = useCallback(() => {
    if (!report) return
    const all = {}
    report.classReports.forEach(cr => { all[cr.courseId] = true })
    setExpandedClasses(all)
  }, [report])

  const collapseAll = useCallback(() => { setExpandedClasses({}) }, [])

  // Filter student dropdown by search
  const filteredStudentOptions = useMemo(() => {
    if (!searchTerm.trim()) return students
    const term = searchTerm.toLowerCase()
    return students.filter(s =>
      `${s.first_name} ${s.last_name}`.toLowerCase().includes(term) ||
      s.email.toLowerCase().includes(term)
    )
  }, [students, searchTerm])

  // Export handlers
  const handleCSVExport = useCallback(() => {
    if (!report) return
    const rows = buildStudentReportExportData(report)
    const csv = arrayToCSV(rows)
    const safeName = report.student.name.replace(/\s+/g, '_')
    downloadBlob(csv, `student-report-${safeName}-${new Date().toISOString().split('T')[0]}.csv`, 'text/csv')
    toast_success('CSV exported')
  }, [report])

  const handleXLSXExport = useCallback(() => {
    if (!report) return
    const rows = buildStudentReportExportData(report)
    const safeName = report.student.name.replace(/\s+/g, '_')
    exportXLSX(rows, `student-report-${safeName}-${new Date().toISOString().split('T')[0]}.xlsx`)
  }, [report])

  const handlePrint = useCallback(() => { window.print() }, [])

  return (
    <div>
      {/* Controls */}
      <div className="card p-4 mb-4 no-print">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Student selector with search */}
          <div className="flex-1 min-w-[250px]">
            <label htmlFor={studentSelectId} className="label">Student</label>
            <div className="relative">
              <label htmlFor={studentSearchId} className="sr-only">Search students by name or email</label>
              <Search size={14} className="absolute left-2.5 top-[11px] text-surface-400 pointer-events-none" aria-hidden="true" />
              <input
                id={studentSearchId}
                type="text"
                placeholder="Type to filter students…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="input pl-8 py-1.5 text-xs mb-2"
              />
            </div>
            <select
              id={studentSelectId}
              value={selectedStudent}
              onChange={e => setSelectedStudent(e.target.value)}
              className="input"
              size={Math.min(8, filteredStudentOptions.length + 1)}
              aria-describedby="student-select-help"
            >
              <option value="">— Select a student —</option>
              {filteredStudentOptions.map(s => (
                <option key={s.user_id} value={s.user_id}>
                  {s.last_name}, {s.first_name} — {s.email} {s.status !== 'Active' ? `(${s.status})` : ''}
                </option>
              ))}
            </select>
            <span id="student-select-help" className="sr-only">
              Choose a student to see their attendance across all classes, including archived ones.
            </span>
          </div>

          {/* Generate button */}
          <div className="flex items-end">
            <button
              onClick={handleGenerate}
              disabled={!selectedStudent || loading}
              className="btn-primary"
              aria-busy={loading}
            >
              {loading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <BarChart3 size={16} aria-hidden="true" />}
              {loading ? 'Loading…' : 'Generate'}
            </button>
          </div>
        </div>
      </div>

      {/* Loading indicator */}
      {loading && (
        <div className="text-center py-12" role="status" aria-live="polite">
          <Loader2 className="mx-auto animate-spin text-brand-600" size={32} aria-hidden="true" />
          <p className="text-surface-500 text-sm mt-3">Building student report…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !report && selectedStudent && (
        <div className="card p-8 text-center">
          <Info className="mx-auto mb-3 text-surface-400" size={32} aria-hidden="true" />
          <p className="text-surface-500 text-sm">Click <strong>Generate</strong> to build the report.</p>
        </div>
      )}

      {/* Report */}
      {!loading && report && (
        <div>
          {/* Student header */}
          <div className="card p-4 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-surface-900 flex items-center gap-2">
                  <User size={20} className="text-brand-600" aria-hidden="true" />
                  {report.student.name}
                </h2>
                <p className="text-sm text-surface-500">
                  {report.student.email} · {report.student.role}
                  {report.student.status !== 'Active' && (
                    <span className="ml-2 text-amber-600 font-medium">({report.student.status})</span>
                  )}
                  {' · '}{report.classReports.length} class{report.classReports.length !== 1 ? 'es' : ''}
                  {' · '}Grand Total: <strong>{formatHours(report.grandTotal)}</strong>
                </p>
              </div>
              <div className="flex gap-2 no-print">
                <button onClick={expandAll} className="btn-ghost btn-sm text-xs">Expand All</button>
                <button onClick={collapseAll} className="btn-ghost btn-sm text-xs">Collapse All</button>
                <button onClick={handleCSVExport} className="btn-secondary btn-sm" title="Export CSV">
                  <Download size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">CSV</span>
                </button>
                <button onClick={handleXLSXExport} className="btn-secondary btn-sm" title="Export Excel">
                  <FileSpreadsheet size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">Excel</span>
                </button>
                <button onClick={handlePrint} className="btn-secondary btn-sm" title="Print / PDF">
                  <Printer size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">Print</span>
                </button>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 mb-3 text-xs text-surface-600 no-print" role="note" aria-label="Colour legend">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(239,68,68,0.15)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#dc2626' }}>✗</span> 0 hours
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(239,68,68,0.10)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#dc2626' }}>▽</span> &lt;50%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(245,158,11,0.12)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#b45309' }}>◇</span> 50–74%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(59,130,246,0.10)' }} aria-hidden="true" />
              75–99%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(34,197,94,0.12)' }} aria-hidden="true" />
              <span className="font-medium" style={{ color: '#16a34a' }}>✓</span> ≥100%
            </span>
          </div>

          {/* Per-class accordion sections */}
          {report.classReports.length === 0 && (
            <div className="card p-8 text-center">
              <p className="text-surface-400 text-sm">No class data found for this student.</p>
            </div>
          )}

          {report.classReports.map((cr, idx) => {
            const isExpanded = expandedClasses[cr.courseId] ?? true // default expanded
            const totalRequired = cr.requiredPerWeek * cr.weeks.length
            const totalPct = totalRequired > 0 ? Math.round((cr.total / totalRequired) * 100) : null
            const pctColor = totalPct === null ? 'text-surface-500'
              : totalPct >= 100 ? 'text-green-600'
              : totalPct >= 75 ? 'text-blue-600'
              : totalPct >= 50 ? 'text-amber-600'
              : 'text-red-600'

            return (
              <div key={cr.courseId} className={`card mb-3 overflow-hidden ${idx > 0 ? 'print-break' : ''}`}>
                {/* Class header — clickable accordion */}
                <button
                  onClick={() => toggleClass(cr.courseId)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-surface-50 hover:bg-surface-100 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset"
                  aria-expanded={isExpanded}
                  aria-controls={`student-class-${cr.courseId}`}
                >
                  <div className="flex items-center gap-3">
                    <ChevronDown
                      size={16}
                      className={`text-surface-400 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                      aria-hidden="true"
                    />
                    <div>
                      <span className="font-semibold text-surface-800">{cr.courseId}</span>
                      <span className="text-surface-500 ml-2">{cr.courseName}</span>
                      {cr.status !== 'Active' && (
                        <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                          {cr.status}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <Sparkline weekHours={cr.weekHours} weeks={cr.weeks} required={cr.requiredPerWeek} />
                    <span className="font-semibold text-surface-800">{formatHours(cr.total)}</span>
                    {totalPct !== null && (
                      <span className={`font-semibold ${pctColor}`}>{totalPct}%</span>
                    )}
                  </div>
                </button>

                {/* Collapsible body */}
                {isExpanded && (
                  <div id={`student-class-${cr.courseId}`} className="px-4 pb-3">
                    <p className="text-xs text-surface-500 mb-2 mt-2">
                      {cr.semester} · Required: {cr.requiredPerWeek}h/wk · {cr.weeks.length} week{cr.weeks.length !== 1 ? 's' : ''}
                      {totalRequired > 0 && ` · Total required: ${formatHours(totalRequired)}`}
                    </p>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-collapse">
                        <caption className="sr-only">
                          {cr.courseId} weekly hours for {report.student.name}
                        </caption>
                        <thead>
                          <tr className="bg-surface-50">
                            <th scope="col" className="text-left px-3 py-2 font-medium text-surface-600 border-b border-surface-200 text-xs">Week</th>
                            <th scope="col" className="text-left px-3 py-2 font-medium text-surface-600 border-b border-surface-200 text-xs">Date Range</th>
                            <th scope="col" className="text-center px-3 py-2 font-medium text-surface-600 border-b border-surface-200 text-xs">Hours</th>
                            <th scope="col" className="text-center px-3 py-2 font-medium text-surface-600 border-b border-surface-200 text-xs">Required</th>
                            <th scope="col" className="text-center px-3 py-2 font-medium text-surface-600 border-b border-surface-200 text-xs">% Met</th>
                            <th scope="col" className="text-center px-3 py-2 font-medium text-surface-600 border-b border-surface-200 text-xs">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cr.weeks.map((w, wIdx) => {
                            const hrs = cr.weekHours[w.weekNumber] || 0
                            const pct = cr.requiredPerWeek > 0 ? Math.round((hrs / cr.requiredPerWeek) * 100) : null
                            const style = heatMapStyle(hrs, cr.requiredPerWeek)
                            const pctCellColor = pct === null ? 'text-surface-500'
                              : pct >= 100 ? 'text-green-600'
                              : pct >= 75 ? 'text-blue-600'
                              : pct >= 50 ? 'text-amber-600'
                              : 'text-red-600'

                            return (
                              <tr
                                key={w.weekNumber}
                                className={wIdx % 2 === 0 ? 'bg-white' : 'bg-surface-50/50'}
                                style={{ background: style.bg }}
                              >
                                <th scope="row" className="text-left px-3 py-1.5 font-medium text-surface-700 border-b border-surface-100 text-xs whitespace-nowrap">
                                  Week {w.weekNumber}
                                  {w.isFinals && <span className="ml-1 text-amber-600">(Finals)</span>}
                                </th>
                                <td className="text-left px-3 py-1.5 border-b border-surface-100 text-xs text-surface-500 whitespace-nowrap">
                                  {formatDateShort(w.startDate)} – {formatDateShort(w.endDate)}
                                </td>
                                <td
                                  className="text-center px-3 py-1.5 border-b border-surface-100 font-semibold tabular-nums text-xs"
                                  style={{ color: style.text }}
                                >
                                  {formatHours(hrs)}
                                  {style.marker && <span className="ml-0.5 text-[10px]" aria-hidden="true">{style.marker}</span>}
                                  {style.marker && <span className="sr-only">{style.marker === '✗' ? ' Zero hours' : style.marker === '✓' ? ' Met requirement' : ' Below target'}</span>}
                                </td>
                                <td className="text-center px-3 py-1.5 border-b border-surface-100 text-xs text-surface-400 tabular-nums">
                                  {cr.requiredPerWeek > 0 ? `${cr.requiredPerWeek}h` : '—'}
                                </td>
                                <td className={`text-center px-3 py-1.5 border-b border-surface-100 font-semibold text-xs tabular-nums ${pctCellColor}`}>
                                  {pct !== null ? `${pct}%` : '—'}
                                </td>
                                <td className="text-center px-3 py-1.5 border-b border-surface-100 text-xs">
                                  {hrs === 0 && cr.requiredPerWeek > 0 ? (
                                    <span className="inline-flex items-center gap-1 text-red-600">
                                      <AlertTriangle size={12} aria-hidden="true" />
                                      <span>Missing</span>
                                    </span>
                                  ) : pct !== null && pct >= 100 ? (
                                    <span className="text-green-600 font-medium">Met</span>
                                  ) : pct !== null && pct > 0 ? (
                                    <span className="text-amber-600 font-medium">Partial</span>
                                  ) : (
                                    <span className="text-surface-400">—</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot className="bg-surface-100/80">
                          <tr className="font-semibold">
                            <th scope="row" className="text-left px-3 py-2 text-surface-700 border-t-2 border-surface-300 text-xs">
                              Total
                            </th>
                            <td className="border-t-2 border-surface-300" />
                            <td className="text-center px-3 py-2 border-t-2 border-surface-300 font-bold text-surface-900 tabular-nums text-xs">
                              {formatHours(cr.total)}
                            </td>
                            <td className="text-center px-3 py-2 border-t-2 border-surface-300 text-xs text-surface-400 tabular-nums">
                              {totalRequired > 0 ? formatHours(totalRequired) : '—'}
                            </td>
                            <td className={`text-center px-3 py-2 border-t-2 border-surface-300 font-bold text-xs tabular-nums ${pctColor}`}>
                              {totalPct !== null ? `${totalPct}%` : '—'}
                            </td>
                            <td className="border-t-2 border-surface-300" />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Grand total card */}
          {report.classReports.length > 1 && (
            <div className="card p-4 mt-4 bg-surface-50">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-surface-700">
                  <TrendingUp size={16} className="inline mr-2 text-brand-600" aria-hidden="true" />
                  Grand Total Across All Classes
                </span>
                <span className="text-lg font-bold text-surface-900">{formatHours(report.grandTotal)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
