/**
 * RICT CMMS — Accountability Report
 *
 * One place to see everything a student is held to for a term: lab sign-ups,
 * time-clock behaviour, absences and late work, work orders, equipment,
 * volunteer hours, holds and reminders — 37 checks in six sections, each
 * count expandable to the actual events behind it (date, class, what
 * happened), so nothing on the page is a bare number.
 *
 * Views
 *   Instructor (view_all)
 *     • Class tab   — term + class pickers, one row per enrolled student with
 *                     per-section counts, total, severity split, help-request
 *                     count / average wait, and a trend arrow; sortable; click
 *                     a name for the full report. A class-wide help-request
 *                     average sits under the table.
 *     • Student tab — pick any student (Active by default, archived optional).
 *   Student / Work Study (view_own)
 *     • Their own report only, with first-person wording ("Days I arrived
 *       late"). Instructor-only rows (team WO lateness, absence notes) are
 *       never included — the rules lib strips them before totals are made.
 *
 * Purpose (decision 2026-09-21): a reference for a sit-down conversation, NOT
 * a grade input. The total is a plain count of events; severity is shown
 * beside each count as text + icon, never as colour alone.
 *
 * Links in: ?student=<email>&term=<term_id> opens straight to one student
 * (Users page, Time Cards report modal, Dashboard grade cards).
 *
 * Exports: CSV / Excel (SheetJS, dynamic import) of the class table or the
 * student's event list; Print (browser print CSS).
 *
 * Accessibility (WCAG 2.1 AA / Section 508)
 *   - role="tablist"/"tab"/"tabpanel" with arrow-key navigation
 *   - every control has a visible <label>; icon-only buttons carry aria-label
 *   - 44px minimum targets (min-h-[44px]) and focus-visible rings throughout
 *   - <caption>, scope="col"/"row", aria-sort on sortable headers
 *   - disclosure buttons use aria-expanded + aria-controls
 *   - aria-live="polite" status for loading / progress / errors
 *   - colour never carries meaning alone (icon + text on every severity)
 *
 * File: src/pages/AccountabilityReportPage.jsx
 */

import React, { useState, useMemo, useCallback, useEffect, useId, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useAcademicTerms } from '@/hooks/useAcademicTerms'
import { supabase } from '@/lib/supabase'
import { mustData } from '@/lib/supabaseData'
import { SUPER_ADMIN_EMAIL } from '@/lib/superAdmin'
import { arrayToCSV, downloadBlob } from '@/hooks/useAttendanceReports'
import { useAccountabilityStudent, useAccountabilityClass, useTermClasses } from '@/hooks/useAccountabilityReport'
import { SEVERITY_LABEL, studentFacingLabel, fmtDate, lower } from '@/lib/accountabilityRules'
import {
  Loader2, ClipboardCheck, Users, User, Download, Printer, FileSpreadsheet, RefreshCw,
  AlertTriangle, AlertOctagon, AlertCircle, Info, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus,
  CheckCircle2, ArrowUpDown, ArrowUp, ArrowDown, ExternalLink,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const SEVERITY_META = {
  high:   { Icon: AlertOctagon,  cls: 'bg-red-50 text-red-700 border-red-200' },
  medium: { Icon: AlertTriangle, cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  low:    { Icon: AlertCircle,   cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  info:   { Icon: Info,          cls: 'bg-surface-100 text-surface-600 border-surface-200' },
}

function SeverityBadge({ severity, zero }) {
  const m = SEVERITY_META[severity] || SEVERITY_META.info
  const Icon = zero ? CheckCircle2 : m.Icon
  const cls = zero ? 'bg-green-50 text-green-700 border-green-200' : m.cls
  return (
    <span className={`badge border ${cls} gap-1`}>
      <Icon size={12} aria-hidden="true" />
      {zero ? 'None' : SEVERITY_LABEL[severity] || severity}
    </span>
  )
}

function TrendBadge({ trend }) {
  if (!trend) return null
  const map = {
    worse:  { Icon: TrendingUp,   text: 'Getting worse', cls: 'bg-red-50 text-red-700 border-red-200' },
    better: { Icon: TrendingDown, text: 'Improving',     cls: 'bg-green-50 text-green-700 border-green-200' },
    steady: { Icon: Minus,        text: 'Steady',        cls: 'bg-surface-100 text-surface-600 border-surface-200' },
  }
  const m = map[trend.direction] || map.steady
  return (
    <span className={`badge border ${m.cls} gap-1`} title={`Last ${trend.recentWeeks} weeks: ${trend.recentPerWeek}/week vs ${trend.overallPerWeek}/week for the term`}>
      <m.Icon size={12} aria-hidden="true" />
      {m.text}
      <span className="sr-only">. Last {trend.recentWeeks} weeks average {trend.recentPerWeek} per week versus {trend.overallPerWeek} for the term.</span>
    </span>
  )
}

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'

async function exportXLSX(rows, filename, sheet = 'Report') {
  try {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, sheet)
    XLSX.writeFile(wb, filename)
    toast.success('Excel file downloaded')
  } catch (err) {
    console.error('XLSX export error:', err)
    toast.error('Excel export failed.')
  }
}

function safeName(s) { return String(s || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') }

function studentName(p) { return `${p?.first_name || ''} ${p?.last_name || ''}`.trim() || p?.email || '' }

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function AccountabilityReportPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Accountability Report')
  const canViewAll = hasPerm('view_all')
  const canViewOwn = hasPerm('view_own') || hasPerm('view_page')
  const canExport = hasPerm('export')
  const canViewNotes = hasPerm('view_notes')

  const { terms, current: currentTerm, loading: termsLoading } = useAcademicTerms()
  const [searchParams, setSearchParams] = useSearchParams()
  const [termId, setTermId] = useState(searchParams.get('term') || '')
  const term = useMemo(() => terms.find(t => t.term_id === termId) || null, [terms, termId])

  // Default to the current semester once terms arrive (convention: every page does)
  useEffect(() => {
    if (termId || !terms.length) return
    const fromUrl = searchParams.get('term')
    setTermId(fromUrl && terms.some(t => t.term_id === fromUrl) ? fromUrl : (currentTerm?.term_id || terms[0]?.term_id || ''))
  }, [terms, currentTerm, termId, searchParams])

  const [tab, setTab] = useState(searchParams.get('student') ? 'student' : 'class')
  const tabsId = useId()
  const classTabRef = useRef(null)
  const studentTabRef = useRef(null)
  const onTabKey = useCallback(e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      setTab(prev => {
        const next = prev === 'class' ? 'student' : 'class'
        setTimeout(() => (next === 'class' ? classTabRef : studentTabRef).current?.focus(), 0)
        return next
      })
    }
  }, [])

  // A link from another page: ?student=<email>
  const [linkedEmail, setLinkedEmail] = useState(searchParams.get('student') || '')
  const openStudent = useCallback(email => {
    setLinkedEmail(email)
    setTab('student')
    const next = new URLSearchParams(searchParams)
    next.set('student', email)
    if (termId) next.set('term', termId)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams, termId])

  if (permsLoading || termsLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-surface-500" role="status" aria-live="polite">
        <Loader2 className="animate-spin" size={18} aria-hidden="true" /> Loading…
      </div>
    )
  }

  if (!canViewAll && !canViewOwn) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="card p-8 text-center">
          <AlertTriangle className="mx-auto mb-3 text-amber-500" size={40} aria-hidden="true" />
          <h1 className="text-lg font-semibold text-surface-900 mb-2">Access Restricted</h1>
          <p className="text-surface-500 text-sm">You do not have permission to view the Accountability Report.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto accountability-page">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 flex items-center gap-2">
            <ClipboardCheck size={24} className="text-brand-600" aria-hidden="true" />
            Accountability Report
          </h1>
          <p className="text-sm text-surface-500 mt-1">
            {canViewAll
              ? 'Everything a student is held to this term, in one place — a reference for a conversation, not a grade.'
              : 'Everything you are held to this term, in one place. Expand any row to see the details behind it.'}
          </p>
        </div>
        <div className="min-w-[220px]">
          <label htmlFor={`${tabsId}-term`} className="label">Term</label>
          <select id={`${tabsId}-term`} className="input min-h-[44px]" value={termId} onChange={e => setTermId(e.target.value)}>
            {terms.map(t => <option key={t.term_id} value={t.term_id}>{t.name}{t.status === 'Archived' ? ' (archived)' : ''}</option>)}
          </select>
        </div>
      </div>

      {!term && (
        <div className="card p-6 text-sm text-surface-600" role="status">No academic terms are set up yet. Add one under Settings → Terms.</div>
      )}

      {term && !canViewAll && (
        <StudentReportPanel student={profile} term={term} studentView canViewNotes={false} canExport={canExport} />
      )}

      {term && canViewAll && (
        <>
          <div role="tablist" aria-label="Report view" className="flex gap-1 bg-surface-100 rounded-xl p-1 mb-5 w-fit no-print" onKeyDown={onTabKey}>
            <button ref={classTabRef} role="tab" id={`${tabsId}-tab-class`} aria-selected={tab === 'class'} aria-controls={`${tabsId}-panel-class`}
              tabIndex={tab === 'class' ? 0 : -1} onClick={() => setTab('class')}
              className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg text-sm font-medium ${FOCUS} ${tab === 'class' ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'}`}>
              <Users size={16} aria-hidden="true" /> By class
            </button>
            <button ref={studentTabRef} role="tab" id={`${tabsId}-tab-student`} aria-selected={tab === 'student'} aria-controls={`${tabsId}-panel-student`}
              tabIndex={tab === 'student' ? 0 : -1} onClick={() => setTab('student')}
              className={`flex items-center gap-2 px-4 min-h-[44px] rounded-lg text-sm font-medium ${FOCUS} ${tab === 'student' ? 'bg-white text-brand-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'}`}>
              <User size={16} aria-hidden="true" /> One student
            </button>
          </div>

          <div role="tabpanel" id={`${tabsId}-panel-class`} aria-labelledby={`${tabsId}-tab-class`} hidden={tab !== 'class'} tabIndex={0}>
            {tab === 'class' && <ClassPanel term={term} canViewNotes={canViewNotes} canExport={canExport} onOpenStudent={openStudent} />}
          </div>
          <div role="tabpanel" id={`${tabsId}-panel-student`} aria-labelledby={`${tabsId}-tab-student`} hidden={tab !== 'student'} tabIndex={0}>
            {tab === 'student' && <StudentPickerPanel term={term} canViewNotes={canViewNotes} canExport={canExport} initialEmail={linkedEmail} />}
          </div>
        </>
      )}

      <style>{`
        @media print {
          body * { visibility: hidden; }
          .accountability-page, .accountability-page * { visibility: visible; }
          .accountability-page { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          .print-open { display: block !important; }
          table { font-size: 10px; }
          th, td { padding: 2px 4px; }
        }
      `}</style>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS PANEL (instructor)
// ═══════════════════════════════════════════════════════════════════════════════

const CLASS_COLUMNS = [
  { key: 'name',      label: 'Student',            sort: r => studentName(r.student).toLowerCase() },
  { key: 'total',     label: 'Total',              sort: r => r.report?.totals.total ?? -1, num: true },
  { key: 'high',      label: 'High',               sort: r => r.report?.totals.high ?? -1, num: true },
  { key: 'medium',    label: 'Med',                sort: r => r.report?.totals.medium ?? -1, num: true },
  { key: 'low',       label: 'Low',                sort: r => r.report?.totals.low ?? -1, num: true },
  { key: 'weekShort', label: 'Short wks',          check: 'weekShort' },
  { key: 'noShows',   label: 'No-shows',           check: 'noShows' },
  { key: 'late',      label: 'Late',               check: 'late' },
  { key: 'leftEarly', label: 'Left early',         check: 'leftEarly' },
  { key: 'absences',  label: 'Absences',           check: 'absences' },
  { key: 'ownWOsLate', label: 'WOs late',          check: 'ownWOsLate' },
  { key: 'overdueCheckouts', label: 'Gear overdue', check: 'overdueCheckouts' },
  { key: 'holds',     label: 'Holds',              check: 'holds' },
  { key: 'helpReqs',  label: 'Help reqs',          sort: r => helpStats(r)?.requests ?? -1, num: true },
  { key: 'helpWait',  label: 'Help wait (avg)',    sort: r => helpStats(r)?.avgWaitMin ?? -1, num: true },
  { key: 'helpClear', label: 'Help cleared (avg)', sort: r => helpStats(r)?.avgClearMin ?? -1, num: true },
  { key: 'volunteer', label: 'Volunteer',          sort: r => ({ behind: 3, at_risk: 2, on_track: 1, complete: 0 })[r.report?.scores.volunteer?.status] ?? -1, num: true },
  { key: 'trend',     label: 'Trend',              sort: r => ({ worse: 2, steady: 1, better: 0 })[r.report?.trend.direction] ?? -1, num: true },
]

function checkCount(row, id) {
  const c = row.report?.checks.find(x => x.id === id)
  return c ? c.count : null
}

/** The help-request stats object attached to the #38 check (or null). */
function helpStats(row) {
  return row.report?.checks.find(x => x.id === 'helpRequests') || null
}

function fmtMin(m) { return m === null || m === undefined ? '—' : `${m} min` }

function ClassPanel({ term, canViewNotes, canExport, onOpenStudent }) {
  const ids = useId()
  const { classes, loading: classesLoading } = useTermClasses(term)
  const [classId, setClassId] = useState('')
  useEffect(() => { if (!classes.some(c => c.class_id === classId)) setClassId(classes[0]?.class_id || '') }, [classes]) // eslint-disable-line react-hooks/exhaustive-deps
  const cls = classes.find(c => c.class_id === classId) || null
  const { rows, loading, progress, error, refresh } = useAccountabilityClass({ classId, term, canViewNotes, enabled: !!classId })

  const [sortKey, setSortKey] = useState('total')
  const [sortDir, setSortDir] = useState('desc')
  const sorted = useMemo(() => {
    const col = CLASS_COLUMNS.find(c => c.key === sortKey)
    const val = r => col?.check ? (checkCount(r, col.check) ?? -1) : col?.sort ? col.sort(r) : 0
    const out = [...rows]
    out.sort((a, b) => {
      const va = val(a), vb = val(b)
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, sortKey, sortDir])

  // Class-wide help-request averages (every answered request, not an average of averages)
  const classHelp = useMemo(() => {
    let requests = 0, answered = 0, waitSum = 0, cleared = 0, clearSum = 0
    for (const r of rows) {
      const h = helpStats(r)
      if (!h) continue
      requests += h.requests || 0
      for (const it of h.items || []) {
        if (it.waitMin !== null && it.waitMin !== undefined) { answered++; waitSum += it.waitMin }
        if (it.clearMin !== null && it.clearMin !== undefined) { cleared++; clearSum += it.clearMin }
      }
    }
    return {
      requests, answered,
      avgWaitMin: answered ? Math.round((waitSum / answered) * 10) / 10 : null,
      avgClearMin: cleared ? Math.round((clearSum / cleared) * 10) / 10 : null,
    }
  }, [rows])

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc') }
  }

  const exportRows = useCallback(() => {
    const head = CLASS_COLUMNS.map(c => c.label)
    const body = sorted.map(r => CLASS_COLUMNS.map(c => {
      if (c.key === 'name') return studentName(r.student)
      if (c.key === 'volunteer') return r.report?.scores.volunteer?.status?.replace(/_/g, ' ') || ''
      if (c.key === 'trend') return r.report?.trend.direction || ''
      if (c.key === 'helpReqs') return helpStats(r)?.requests ?? ''
      if (c.key === 'helpWait') return helpStats(r)?.avgWaitMin ?? ''
      if (c.key === 'helpClear') return helpStats(r)?.avgClearMin ?? ''
      if (c.check) return checkCount(r, c.check) ?? ''
      return r.report?.totals[c.key] ?? ''
    }))
    return [[`Accountability Report — ${cls?.course_id || ''} ${cls?.course_name || ''} — ${term.name}`], [`Generated ${new Date().toLocaleString()}`],
      [`Help requests: ${classHelp.requests} (${classHelp.answered} answered)`, `Class avg wait (min): ${classHelp.avgWaitMin ?? ''}`, `Class avg to cleared (min): ${classHelp.avgClearMin ?? ''}`],
      [], head, ...body]
  }, [sorted, cls, term, classHelp])

  const fname = `accountability_${safeName(cls?.course_id)}_${safeName(term.name)}`

  return (
    <div>
      <div className="card p-4 mb-4 no-print flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <label htmlFor={`${ids}-class`} className="label">Class</label>
          <select id={`${ids}-class`} className="input min-h-[44px]" value={classId} onChange={e => setClassId(e.target.value)} disabled={classesLoading || !classes.length}>
            {!classes.length && <option value="">{classesLoading ? 'Loading…' : 'No classes in this term'}</option>}
            {classes.map(c => <option key={c.class_id} value={c.class_id}>{c.course_id} — {c.course_name}{c.status && c.status !== 'Active' ? ` (${c.status})` : ''}</option>)}
          </select>
        </div>
        <button type="button" className="btn-secondary min-h-[44px]" onClick={refresh} disabled={loading || !classId}>
          <RefreshCw size={16} aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        {canExport && (
          <>
            <button type="button" className="btn-secondary min-h-[44px]" disabled={!rows.length} onClick={() => { downloadBlob(arrayToCSV(exportRows()), `${fname}.csv`, 'text/csv;charset=utf-8'); toast.success('CSV downloaded') }}>
              <Download size={16} aria-hidden="true" /> CSV
            </button>
            <button type="button" className="btn-secondary min-h-[44px]" disabled={!rows.length} onClick={() => exportXLSX(exportRows(), `${fname}.xlsx`, 'Class')}>
              <FileSpreadsheet size={16} aria-hidden="true" /> Excel
            </button>
            <button type="button" className="btn-secondary min-h-[44px]" disabled={!rows.length} onClick={() => window.print()}>
              <Printer size={16} aria-hidden="true" /> Print
            </button>
          </>
        )}
      </div>

      <div role="status" aria-live="polite" className="text-sm text-surface-500 mb-2 min-h-[1.25rem]">
        {loading && progress.total > 0 && `Building reports… ${progress.done} of ${progress.total} students`}
        {loading && progress.total === 0 && 'Loading class…'}
        {!loading && error && <span className="text-red-700">{error}</span>}
        {!loading && !error && classId && rows.length === 0 && 'No students are enrolled in this class.'}
      </div>

      {rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-left p-3 font-semibold text-surface-800">
              {cls?.course_id} {cls?.course_name} — {term.name}: {rows.length} student{rows.length === 1 ? '' : 's'}. Counts are events this term; click a name for the full report.
            </caption>
            <thead className="bg-surface-50 text-xs uppercase text-surface-500">
              <tr>
                {CLASS_COLUMNS.map(c => {
                  const active = sortKey === c.key
                  const Icon = active ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className="text-left">
                      <button type="button" onClick={() => toggleSort(c.key)} className={`w-full min-h-[44px] px-2 flex items-center gap-1 ${c.key === 'name' ? 'justify-start' : 'justify-center'} hover:text-surface-800 ${FOCUS}`}>
                        {c.label} <Icon size={12} aria-hidden="true" />
                        <span className="sr-only">{active ? `, sorted ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ', sortable'}</span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.student.email} className="border-t border-surface-100 hover:bg-surface-50">
                  <th scope="row" className="text-left font-medium px-2 py-1">
                    <button type="button" onClick={() => onOpenStudent(r.student.email)} className={`min-h-[44px] text-brand-700 hover:underline text-left inline-flex items-center gap-1 ${FOCUS}`}>
                      {studentName(r.student)} <ExternalLink size={12} aria-hidden="true" /><span className="sr-only">, open full report</span>
                    </button>
                    {r.student.status === 'Archived' && <span className="badge bg-surface-100 text-surface-600 ml-1">archived</span>}
                    {!r.report && <span className="badge bg-red-50 text-red-700 ml-1">failed</span>}
                  </th>
                  {CLASS_COLUMNS.slice(1).map(c => {
                    if (!r.report) return <td key={c.key} className="text-center text-surface-400">—</td>
                    if (c.key === 'volunteer') {
                      const s = r.report.scores.volunteer?.status
                      return <td key={c.key} className="text-center">{s ? s.replace(/_/g, ' ') : '—'}</td>
                    }
                    if (c.key === 'trend') return <td key={c.key} className="text-center"><TrendBadge trend={r.report.trend} /></td>
                    if (c.key === 'helpReqs') { const h = helpStats(r); return <td key={c.key} className={`text-center tabular-nums ${h?.requests ? 'text-surface-800' : 'text-surface-400'}`}>{h?.requests ?? '—'}</td> }
                    if (c.key === 'helpWait') { const h = helpStats(r); return <td key={c.key} className="text-center tabular-nums text-surface-800">{fmtMin(h?.avgWaitMin)}</td> }
                    if (c.key === 'helpClear') { const h = helpStats(r); return <td key={c.key} className="text-center tabular-nums text-surface-800" title={h?.clearedCount ? `${h.clearedCount} cleared with a time` : 'No cleared times recorded yet'}>{fmtMin(h?.avgClearMin)}</td> }
                    const n = c.check ? checkCount(r, c.check) : r.report.totals[c.key]
                    const strong = c.key === 'total'
                    return <td key={c.key} className={`text-center tabular-nums ${strong ? 'font-semibold text-surface-900' : n > 0 ? 'text-surface-800' : 'text-surface-400'}`}>{n ?? '—'}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-surface-600 border-t border-surface-100">
            Help requests this term: {classHelp.requests} ({classHelp.answered} answered){classHelp.avgWaitMin !== null ? ` · class average wait for "On My Way" ${classHelp.avgWaitMin} min` : ''}{classHelp.avgClearMin !== null ? ` · average ${classHelp.avgClearMin} min from "On My Way" to cleared` : ' · no cleared times yet (recorded from 2026-09-22 onward)'}. Response time is the instructor's measure, not the student's.
          </p>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT PICKER (instructor)
// ═══════════════════════════════════════════════════════════════════════════════

function StudentPickerPanel({ term, canViewNotes, canExport, initialEmail }) {
  const ids = useId()
  const [people, setPeople] = useState([])
  const [includeArchived, setIncludeArchived] = useState(false)
  const [email, setEmail] = useState(initialEmail || '')
  const [search, setSearch] = useState('')

  useEffect(() => { if (initialEmail) setEmail(initialEmail) }, [initialEmail])

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        let q = supabase.from('profiles').select('user_id, id, email, first_name, last_name, role, status, classes, created_at, time_clock_only')
          .in('role', ['Student', 'Work Study']).neq('email', SUPER_ADMIN_EMAIL).order('last_name')
        if (!includeArchived) q = q.eq('status', 'Active')
        const rows = mustData(await q, 'profiles.select') || []
        if (!cancelled) setPeople(rows)
      } catch (e) {
        console.error('Accountability student list:', e)
        if (!cancelled) toast.error('Could not load the student list')
      }
    }
    run()
    return () => { cancelled = true }
  }, [includeArchived])

  // A linked student who is archived should still open
  useEffect(() => {
    if (!email || includeArchived || !people.length) return
    if (!people.some(p => lower(p.email) === lower(email))) setIncludeArchived(true)
  }, [email, people, includeArchived])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return people
    return people.filter(p => studentName(p).toLowerCase().includes(q) || lower(p.email).includes(q))
  }, [people, search])
  const student = people.find(p => lower(p.email) === lower(email)) || null

  return (
    <div>
      <div className="card p-4 mb-4 no-print grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
        <div>
          <label htmlFor={`${ids}-search`} className="label">Find a student</label>
          <input id={`${ids}-search`} type="search" className="input min-h-[44px]" placeholder="Name or email" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${ids}-student`} className="label">Student</label>
          <select id={`${ids}-student`} className="input min-h-[44px]" value={email} onChange={e => setEmail(e.target.value)}>
            <option value="">Select a student…</option>
            {filtered.map(p => <option key={p.email} value={p.email}>{studentName(p)}{p.status === 'Archived' ? ' (archived)' : ''} — {p.role}</option>)}
          </select>
        </div>
        <label className="inline-flex items-center gap-2 min-h-[44px] text-sm text-surface-700 cursor-pointer">
          <input type="checkbox" className="w-5 h-5 rounded border-surface-300 text-brand-600 focus:ring-brand-500" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} />
          Include archived
        </label>
      </div>
      {student
        ? <StudentReportPanel student={student} term={term} studentView={false} canViewNotes={canViewNotes} canExport={canExport} />
        : <p className="text-sm text-surface-500" role="status">Pick a student to build their report.</p>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT REPORT (shared by the instructor pick and the student's own view)
// ═══════════════════════════════════════════════════════════════════════════════

function StudentReportPanel({ student, term, studentView, canViewNotes, canExport }) {
  const navigate = useNavigate()
  const { result, loading, error, refresh } = useAccountabilityStudent({ student, term, studentView, canViewNotes, enabled: !!student?.email && !!term })
  const report = result?.report || null
  const [openIds, setOpenIds] = useState(() => new Set())
  const toggle = id => setOpenIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allIds = useMemo(() => (report?.checks || []).filter(c => c.items.length).map(c => c.id), [report])
  const label = c => (studentView ? studentFacingLabel(c) : c.label)

  const exportRows = useCallback(() => {
    const head = ['#', 'Section', 'Check', 'Severity', 'Date', 'What happened', 'Details']
    const body = []
    for (const s of report.sections) for (const c of s.checks) {
      if (!c.items.length) { body.push([c.num, s.label, label(c), SEVERITY_LABEL[c.severity], '', c.isScore ? c.summary : '0', '']); continue }
      for (const it of c.items) body.push([c.num, s.label, label(c), SEVERITY_LABEL[c.severity], it.date ? fmtDate(it.date) : '', it.label, it.detail || ''])
    }
    return [
      [`Accountability Report — ${studentName(student)} — ${term.name}`],
      [`Generated ${new Date().toLocaleString()}`, `Total events: ${report.totals.total}`, `High ${report.totals.high}`, `Medium ${report.totals.medium}`, `Low ${report.totals.low}`, `Trend: ${report.trend.direction}`],
      [], head, ...body,
    ]
  }, [report, student, term, studentView]) // eslint-disable-line react-hooks/exhaustive-deps

  const fname = `accountability_${safeName(studentName(student))}_${safeName(term.name)}`

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold text-surface-900">{studentView ? 'My report' : studentName(student)} <span className="text-surface-500 font-normal">— {term.name}</span></h2>
          {!studentView && <p className="text-xs text-surface-500">{student.email}{student.role ? ` · ${student.role}` : ''}</p>}
        </div>
        <div className="flex flex-wrap gap-2 no-print">
          <button type="button" className="btn-secondary min-h-[44px]" onClick={refresh} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {report && (
            <>
              <button type="button" className="btn-secondary min-h-[44px]" onClick={() => setOpenIds(new Set(openIds.size === allIds.length ? [] : allIds))}>
                {openIds.size === allIds.length && allIds.length ? 'Collapse all' : 'Expand all'}
              </button>
              {canExport && (
                <>
                  <button type="button" className="btn-secondary min-h-[44px]" onClick={() => { downloadBlob(arrayToCSV(exportRows()), `${fname}.csv`, 'text/csv;charset=utf-8'); toast.success('CSV downloaded') }}>
                    <Download size={16} aria-hidden="true" /> CSV
                  </button>
                  <button type="button" className="btn-secondary min-h-[44px]" onClick={() => exportXLSX(exportRows(), `${fname}.xlsx`, 'Student')}>
                    <FileSpreadsheet size={16} aria-hidden="true" /> Excel
                  </button>
                  <button type="button" className="btn-secondary min-h-[44px]" onClick={() => { setOpenIds(new Set(allIds)); setTimeout(() => window.print(), 150) }}>
                    <Printer size={16} aria-hidden="true" /> Print
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite" className="text-sm text-surface-500 mb-3 min-h-[1.25rem]">
        {loading && <span className="inline-flex items-center gap-2"><Loader2 className="animate-spin" size={16} aria-hidden="true" /> Building the report — this reads sign-ups, punches, requests, work orders and equipment…</span>}
        {!loading && error && <span className="text-red-700">{error}</span>}
        {!loading && result?.errors?.length > 0 && <span className="text-amber-700">{result.errors.join(' ')}</span>}
      </div>

      {report && !loading && (
        <>
          {/* Summary strip */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
            <div className="card p-4">
              <div className="text-xs uppercase text-surface-500">Total events</div>
              <div className="text-3xl font-bold text-surface-900 tabular-nums">{report.totals.total}</div>
              <div className="text-xs text-surface-600 mt-1">High {report.totals.high} · Medium {report.totals.medium} · Low {report.totals.low}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs uppercase text-surface-500">Trend (last {report.trend.recentWeeks} wk)</div>
              <div className="mt-1"><TrendBadge trend={report.trend} /></div>
              <div className="text-xs text-surface-600 mt-1">{report.trend.recentPerWeek}/week recently vs {report.trend.overallPerWeek}/week this term</div>
            </div>
            <div className="card p-4">
              <div className="text-xs uppercase text-surface-500">Attendance score</div>
              <div className="text-3xl font-bold text-surface-900 tabular-nums">{report.scores.attendanceAvg ?? '—'}{report.scores.attendanceAvg !== null ? '%' : ''}</div>
              <div className="text-xs text-surface-600 mt-1">{report.scores.perClass.map(c => `${c.courseId} ${c.attendanceScore ?? '—'}%`).join(' · ') || 'No classes this term'}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs uppercase text-surface-500">WOC · Volunteer</div>
              <div className="text-3xl font-bold text-surface-900 tabular-nums">{report.scores.woc ?? '—'}{report.scores.woc !== null ? '%' : ''}</div>
              <div className="text-xs text-surface-600 mt-1">
                {report.scores.volunteer ? `Volunteer: ${report.scores.volunteer.status.replace(/_/g, ' ')} (${report.scores.volunteer.approved}/${report.scores.volunteer.required} h)` : 'Volunteer: n/a'}
              </div>
            </div>
          </div>

          {report.sections.map(s => (
            <section key={s.key} className="card mb-4" aria-labelledby={`sec-${s.key}`}>
              <h3 id={`sec-${s.key}`} className="px-4 py-3 border-b border-surface-100 font-semibold text-surface-800 flex items-center justify-between">
                {s.label}
                <span className="text-sm font-normal text-surface-500 tabular-nums">{s.checks.filter(c => c.counts).reduce((n, c) => n + c.count, 0)} events</span>
              </h3>
              <ul className="divide-y divide-surface-100">
                {s.checks.map(c => <CheckRow key={c.id} check={c} label={label(c)} open={openIds.has(c.id)} onToggle={() => toggle(c.id)} />)}
              </ul>
            </section>
          ))}

          {!studentView && (
            <p className="text-xs text-surface-500 no-print">
              Deeper detail lives on <button type="button" className={`underline text-brand-700 ${FOCUS}`} onClick={() => navigate('/time-cards')}>Time Cards</button>,{' '}
              <button type="button" className={`underline text-brand-700 ${FOCUS}`} onClick={() => navigate('/woc-ratio')}>WOC Ratio</button> and{' '}
              <button type="button" className={`underline text-brand-700 ${FOCUS}`} onClick={() => navigate('/volunteer-hours')}>Volunteer Hours</button>.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function CheckRow({ check, label, open, onToggle }) {
  const panelId = `chk-${check.id}`
  const zero = check.counts ? check.count === 0 : check.items.length === 0
  const hasItems = check.items.length > 0
  return (
    <li>
      <button type="button" aria-expanded={hasItems ? open : undefined} aria-controls={hasItems ? panelId : undefined}
        onClick={hasItems ? onToggle : undefined} disabled={!hasItems}
        className={`w-full min-h-[44px] px-4 py-2 flex items-center gap-3 text-left ${hasItems ? 'hover:bg-surface-50 cursor-pointer' : 'cursor-default'} ${FOCUS}`}>
        <span className="w-5 text-surface-400 shrink-0" aria-hidden="true">{hasItems ? (open ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : ''}</span>
        <span className={`w-10 text-right tabular-nums font-semibold shrink-0 ${zero ? 'text-surface-400' : 'text-surface-900'}`}>
          {check.isScore ? `${check.count}%` : check.count}
        </span>
        <span className="flex-1 min-w-0">
          <span className="text-sm text-surface-800">{label}</span>
          {check.summary && <span className="text-xs text-surface-500 ml-2">{check.summary}</span>}
          <span className="block text-xs text-surface-500">{check.help}</span>
        </span>
        <SeverityBadge severity={check.severity} zero={zero && check.counts} />
      </button>
      {hasItems && (
        <div id={panelId} hidden={!open} className={open ? '' : 'print-open'}>
          <table className="w-full text-sm mx-4 mb-3" style={{ width: 'calc(100% - 2rem)' }}>
            <caption className="sr-only">{label}: {check.items.length} item{check.items.length === 1 ? '' : 's'}</caption>
            <thead className="text-xs uppercase text-surface-500">
              <tr><th scope="col" className="text-left px-2 py-1 w-28">Date</th><th scope="col" className="text-left px-2 py-1">What happened</th><th scope="col" className="text-left px-2 py-1">Details</th></tr>
            </thead>
            <tbody>
              {check.items.map((it, i) => (
                <tr key={i} className="border-t border-surface-100 align-top">
                  <td className="px-2 py-1 whitespace-nowrap text-surface-600">{it.date ? fmtDate(it.date) : '—'}</td>
                  <td className="px-2 py-1 text-surface-800">{it.label}</td>
                  <td className="px-2 py-1 text-surface-600">{it.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  )
}
