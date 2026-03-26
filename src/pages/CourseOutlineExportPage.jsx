import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft, FileDown, FileText, Search,
  CheckSquare, Square, AlertCircle, BookOpen, Archive,
  FilePlus, FileEdit, Clock, Layers, ChevronDown, ChevronUp,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useCourseOutlineExport } from '@/hooks/useCourseOutlineExport'
import { downloadOutlineDocx, downloadOutlineZip, openOutlinePrintWindow } from '@/pages/courseOutlineDocx'

// ─── Program filter pills ─────────────────────────────────────────────────────
const PROGRAM_FILTERS = [
  { id: 'all',       label: 'All Programs' },
  { id: 'IPC',       label: 'IPC AAS',          match: 'Instrumentation' },
  { id: 'MECH-AAS',  label: 'Mechatronics AAS',  match: 'Automation AAS' },
  { id: 'MECH-CERT', label: 'Mechatronics Cert', match: 'Certificate' },
]

// ─── View mode tabs ───────────────────────────────────────────────────────────
const VIEW_MODES = [
  { id: 'catalog', label: 'Approved Catalog' },
  { id: 'drafts',  label: 'Drafts in Progress' },
]

// ─── Document fields searched by smart search ─────────────────────────────────
const DOC_FIELDS = [
  { key: 'outline_description',      label: 'description' },
  { key: 'outline_slos',             label: 'outcomes' },
  { key: 'outline_topics',           label: 'topics' },
  { key: 'outline_suggested_skills', label: 'skills' },
  { key: 'outline_prereqs',          label: 'prerequisites' },
  { key: 'outline_materials',        label: 'materials' },
  { key: 'outline_prepared_by',      label: 'prepared by' },
  { key: 'outline_cip_code',         label: 'CIP code' },
]

// Surface fields — matched on but not shown as doc snippets
const SURFACE_FIELDS = new Set(['course_id', 'course_name', 'programs', 'credits'])

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safe(str) {
  return String(str || '').replace(/[^a-z0-9_\-]/gi, '_').replace(/_+/g, '_').trim()
}
function safeFilename(item) {
  return `${safe(item.course_id)}_${safe(item.course_name)}_Course_Outline`
}
function getItemKey(item) { return item._id || item.course_id }

// ─── useDebounce ──────────────────────────────────────────────────────────────
function useDebounce(value, delay = 150) {
  const [debounced, setDebounced] = useState(value)
  const timer = useRef(null)
  useEffect(() => {
    timer.current = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer.current)
  }, [value, delay])
  return debounced
}

// ─── Get ALL doc field matches (including every hit in array fields) ───────────
function getDocMatches(outlineData, query) {
  if (!query || !outlineData) return []
  const q       = query.toLowerCase()
  const results = []
  for (const { key, label } of DOC_FIELDS) {
    const val = outlineData[key]
    if (Array.isArray(val)) {
      // Each matching array item becomes its own snippet
      val.forEach(v => {
        const s = String(v || '')
        if (s.toLowerCase().includes(q)) results.push({ label, text: s })
      })
    } else {
      const s = String(val || '')
      if (s.toLowerCase().includes(q)) results.push({ label, text: s })
    }
  }
  return results
}

// ─── Highlight ALL occurrences in a string ────────────────────────────────────
function Highlight({ text, query }) {
  if (!query || !text) return <>{text}</>
  const lowerQ = query.toLowerCase()
  const parts  = []
  let remaining      = text
  let lowerRemaining = remaining.toLowerCase()
  let keyOffset      = 0

  while (remaining.length > 0) {
    const idx = lowerRemaining.indexOf(lowerQ)
    if (idx === -1) {
      parts.push(remaining)
      break
    }
    if (idx > 0) parts.push(remaining.slice(0, idx))
    parts.push(
      <mark key={keyOffset + idx} className="bg-yellow-200 text-yellow-900 rounded-sm not-italic">
        {remaining.slice(idx, idx + query.length)}
      </mark>
    )
    keyOffset      += idx + query.length
    remaining       = remaining.slice(idx + query.length)
    lowerRemaining  = remaining.toLowerCase()
  }

  return <>{parts}</>
}

// ─── Snippet with all-occurrence highlight ────────────────────────────────────
function SnippetHighlight({ text, query, radius = 55 }) {
  if (!text || !query) return null
  const lower = text.toLowerCase()
  const idx   = lower.indexOf(query.toLowerCase())
  if (idx === -1) return null
  const start   = Math.max(0, idx - radius)
  const end     = Math.min(text.length, idx + query.length + radius)
  const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
  return <Highlight text={snippet} query={query} />
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function CourseOutlineExportPage() {
  const navigate = useNavigate()
  const { courses, drafts, proposals, loading, error, refresh } = useCourseOutlineExport()

  const [viewMode,      setViewMode]      = useState('catalog')
  const [search,        setSearch]        = useState('')
  const [programFilter, setProgramFilter] = useState('all')
  const [selected,      setSelected]      = useState(new Set())
  const [generating,    setGenerating]    = useState(null)

  // ── Debounce the raw input 150ms before filtering ─────────────────────────
  const debouncedSearch = useDebounce(search, 150)

  // ─── All drafts combined ───────────────────────────────────────────────────
  const allDrafts = useMemo(() => [...drafts, ...proposals], [drafts, proposals])

  // ─── Active list depending on view mode ───────────────────────────────────
  const activeList = viewMode === 'catalog' ? courses : allDrafts

  // ─── Smart-filtered list with per-item match info ─────────────────────────
  const visibleWithMatch = useMemo(() => {
    const q = debouncedSearch.toLowerCase().trim()
    return activeList
      .map(c => {
        // Program filter first
        if (programFilter !== 'all') {
          const pf = PROGRAM_FILTERS.find(p => p.id === programFilter)
          if (pf?.match && !c.programs.some(p => p.includes(pf.match))) return null
        }
        // No query — include everything
        if (!q) return { item: c, matchFields: [], docMatches: [] }

        const matchFields = []

        // ── Surface fields ─────────────────────────────────────────────────
        if (c.course_id.toLowerCase().includes(q))             matchFields.push('course_id')
        if (c.course_name.toLowerCase().includes(q))           matchFields.push('course_name')
        if (c.programs.some(p => p.toLowerCase().includes(q))) matchFields.push('programs')
        if (c.creditsStr.toLowerCase().includes(q))            matchFields.push('credits')

        // ── Deep document fields ───────────────────────────────────────────
        const docMatches = getDocMatches(c.outlineData, q)
        docMatches.forEach(m => {
          if (!matchFields.includes(m.label)) matchFields.push(m.label)
        })

        if (matchFields.length === 0) return null
        return { item: c, matchFields, docMatches }
      })
      .filter(Boolean)
  }, [activeList, debouncedSearch, programFilter])

  // Flat visible list (selection / empty states / footer)
  const visible = useMemo(() => visibleWithMatch.map(x => x.item), [visibleWithMatch])

  // Key → { matchFields, docMatches } for the row renderer
  const matchInfoMap = useMemo(() => {
    const m = {}
    for (const { item, matchFields, docMatches } of visibleWithMatch) {
      m[getItemKey(item)] = { matchFields, docMatches }
    }
    return m
  }, [visibleWithMatch])

  // Count of results that had at least one doc-level match
  const docOnlyMatchCount = debouncedSearch.trim()
    ? visibleWithMatch.filter(({ matchFields }) =>
        matchFields.some(f => !SURFACE_FIELDS.has(f))
      ).length
    : 0

  const allVisibleSelected = visible.length > 0 && visible.every(c => selected.has(getItemKey(c)))
  const anySelected        = selected.size > 0

  // ─── Selection ─────────────────────────────────────────────────────────────
  function toggleOne(item) {
    const k = getItemKey(item)
    setSelected(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
  }

  function toggleAll() {
    if (allVisibleSelected) {
      setSelected(prev => { const n = new Set(prev); visible.forEach(c => n.delete(getItemKey(c))); return n })
    } else {
      setSelected(prev => { const n = new Set(prev); visible.forEach(c => n.add(getItemKey(c))); return n })
    }
  }

  // ─── Downloads ─────────────────────────────────────────────────────────────
  async function handleDocx(item) {
    setGenerating(getItemKey(item))
    try {
      await downloadOutlineDocx(item.outlineData, safeFilename(item) + '.docx')
      toast.success(`Downloaded ${item.course_id} outline`)
    } catch (e) {
      console.error(e)
      toast.error('DOCX generation failed — see console')
    } finally {
      setGenerating(null)
    }
  }

  function handlePdf(item) {
    openOutlinePrintWindow(item.outlineData)
  }

  async function handleZip(items, label) {
    if (!items.length) return
    setGenerating('zip')
    try {
      await downloadOutlineZip(items, `RICT_Course_Outlines_${safe(label)}.zip`)
      toast.success(`ZIP ready — ${items.length} outline${items.length !== 1 ? 's' : ''}`)
    } catch (e) {
      console.error(e)
      toast.error('ZIP generation failed — see console')
    } finally {
      setGenerating(null)
    }
  }

  const selectedItems = activeList.filter(c => selected.has(getItemKey(c)))
  const draftCount    = allDrafts.length

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/instructor-tools')}
            className="flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600 hover:bg-surface-100 px-2 py-1.5 rounded-lg transition-colors"
          >
            <ChevronLeft size={15} /> Back
          </button>
          <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
            <FileDown size={22} className="text-indigo-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900">Course Outline Export</h1>
            <p className="text-sm text-surface-500">Download course outlines as Word documents or PDF files.</p>
          </div>
        </div>

        {/* Download All — only in catalog view */}
        {viewMode === 'catalog' && (
          <button
            onClick={() => handleZip(courses, 'All')}
            disabled={!!generating || loading || !courses.length}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating === 'zip'
              ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Archive size={15} />
            }
            Download All ({courses.length})
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          <AlertCircle size={16} />
          <span>Failed to load data: {error}</span>
          <button onClick={refresh} className="ml-auto underline text-xs">Retry</button>
        </div>
      )}

      {/* View mode tabs */}
      <div className="flex gap-1 bg-surface-100 p-1 rounded-xl w-fit">
        {VIEW_MODES.map(vm => (
          <button
            key={vm.id}
            onClick={() => { setViewMode(vm.id); setSelected(new Set()); setSearch('') }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              viewMode === vm.id
                ? 'bg-white text-surface-900 shadow-sm'
                : 'text-surface-500 hover:text-surface-700'
            }`}
          >
            {vm.id === 'catalog' ? <BookOpen size={14} /> : <Clock size={14} />}
            {vm.label}
            {vm.id === 'drafts' && draftCount > 0 && (
              <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {draftCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Drafts info banner */}
      {viewMode === 'drafts' && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <Clock size={15} className="mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-semibold">Drafts in progress</span> — these are not yet approved.
            DOCX and PDF downloads show a preview of the outline as currently drafted.
            Open the wizards from Instructor Tools to edit or approve them.
          </div>
        </div>
      )}

      {/* Search + program filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Smart search: course number, name, credits, descriptions, outcomes, topics…"
            className="w-full pl-9 pr-8 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 text-xs leading-none"
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {PROGRAM_FILTERS.map(pf => (
            <button
              key={pf.id}
              onClick={() => setProgramFilter(pf.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                programFilter === pf.id
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-surface-600 border-surface-200 hover:bg-surface-50'
              }`}
            >
              {pf.label}
            </button>
          ))}
        </div>
      </div>

      {/* Smart search doc-match callout */}
      {debouncedSearch.trim() && docOnlyMatchCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
          <Layers size={13} className="flex-shrink-0" />
          <span>
            <span className="font-semibold">{docOnlyMatchCount}</span> result{docOnlyMatchCount !== 1 ? 's' : ''} matched
            inside document content (descriptions, outcomes, topics, and more)
          </span>
        </div>
      )}

      {/* Multi-select action bar */}
      {anySelected && (
        <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-2.5">
          <span className="text-sm font-medium text-indigo-800">
            {selected.size} selected
          </span>
          <button
            onClick={() => handleZip(selectedItems, `Selected_${selected.size}`)}
            disabled={!!generating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {generating === 'zip'
              ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Archive size={13} />
            }
            Download Selected as ZIP
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-indigo-600 hover:underline"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-surface-200 rounded-xl overflow-hidden shadow-sm">

        {/* Column headers */}
        <div className="grid grid-cols-[36px_1fr_120px_150px_160px] border-b border-surface-200 bg-surface-50 px-4 py-2.5">
          <button
            onClick={toggleAll}
            className="flex items-center text-surface-400 hover:text-surface-700 transition-colors"
            title={allVisibleSelected ? 'Deselect all' : 'Select all visible'}
          >
            {allVisibleSelected
              ? <CheckSquare size={15} className="text-indigo-600" />
              : <Square size={15} />
            }
          </button>
          <span className="text-xs font-semibold text-surface-500 uppercase tracking-wide">Course</span>
          <span className="text-xs font-semibold text-surface-500 uppercase tracking-wide">Credits</span>
          <span className="text-xs font-semibold text-surface-500 uppercase tracking-wide">Status</span>
          <span className="text-xs font-semibold text-surface-500 uppercase tracking-wide text-right">Download</span>
        </div>

        {/* Rows */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-surface-400 text-sm gap-2">
            <span className="w-5 h-5 border-2 border-surface-300 border-t-indigo-500 rounded-full animate-spin" />
            Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-surface-400 text-sm gap-2">
            {viewMode === 'drafts'
              ? <><Clock size={28} className="text-surface-300" />No drafts in progress.</>
              : <><BookOpen size={28} className="text-surface-300" />{courses.length === 0 ? 'No active courses found.' : 'No courses match your search or filter.'}</>
            }
          </div>
        ) : (
          visible.map((item, idx) => {
            const matchInfo = matchInfoMap[getItemKey(item)] || { matchFields: [], docMatches: [] }
            return (
              <CourseRow
                key={getItemKey(item)}
                item={item}
                isSelected={selected.has(getItemKey(item))}
                onToggle={() => toggleOne(item)}
                onDocx={() => handleDocx(item)}
                onPdf={() => handlePdf(item)}
                generating={generating === getItemKey(item)}
                isLast={idx === visible.length - 1}
                highlight={debouncedSearch.trim()}
                matchFields={matchInfo.matchFields}
                docMatches={matchInfo.docMatches}
              />
            )
          })
        )}

        {/* Footer count */}
        {!loading && visible.length > 0 && viewMode === 'catalog' && (
          <div className="px-4 py-2.5 border-t border-surface-100 bg-surface-50 text-xs text-surface-400 flex items-center gap-4">
            <span>{visible.length} of {courses.length} course{courses.length !== 1 ? 's' : ''}</span>
            {courses.filter(c => c.hasApprovedRevision).length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                {courses.filter(c => c.hasApprovedRevision).length} with approved revision
              </span>
            )}
          </div>
        )}
        {!loading && visible.length > 0 && viewMode === 'drafts' && (
          <div className="px-4 py-2.5 border-t border-surface-100 bg-surface-50 text-xs text-surface-400 flex items-center gap-4">
            <span>{drafts.length} revision draft{drafts.length !== 1 ? 's' : ''}</span>
            <span>{proposals.length} new course proposal{proposals.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Legend */}
      {viewMode === 'catalog' && (
        <div className="flex flex-wrap items-center gap-5 text-xs text-surface-500">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
            Approved revision — downloads latest approved outline data
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
            Catalog data only — no approved outline revision on file yet
          </div>
        </div>
      )}
      {viewMode === 'drafts' && (
        <div className="flex flex-wrap items-center gap-5 text-xs text-surface-500">
          <div className="flex items-center gap-1.5">
            <FileEdit size={12} className="text-violet-500" />
            Course Outline Revision — existing course being revised
          </div>
          <div className="flex items-center gap-1.5">
            <FilePlus size={12} className="text-blue-500" />
            New Course Proposal — not yet in the catalog
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Single row ───────────────────────────────────────────────────────────────
function CourseRow({ item, isSelected, onToggle, onDocx, onPdf, generating, isLast, highlight, matchFields, docMatches }) {
  const [snippetsExpanded, setSnippetsExpanded] = useState(false)

  const isCatalog  = item._type === 'catalog'
  const isDraftRev = item._type === 'draft-revision'
  const isProposal = item._type === 'proposal'

  // Labels from doc fields only (not surface fields)
  const docMatchLabels = highlight
    ? matchFields.filter(f => !SURFACE_FIELDS.has(f))
    : []

  const hasDocMatches = docMatchLabels.length > 0
  const firstSnippet  = docMatches.length > 0 ? docMatches[0] : null
  const extraSnippets = docMatches.length > 1  ? docMatches.slice(1) : []
  const hasExtras     = extraSnippets.length > 0

  // Auto-collapse when the query changes
  useEffect(() => { setSnippetsExpanded(false) }, [highlight])

  return (
    <div className={`grid grid-cols-[36px_1fr_120px_150px_160px] items-start px-4 py-3 transition-colors
      ${isSelected ? 'bg-indigo-50' : 'hover:bg-surface-50'}
      ${!isLast ? 'border-b border-surface-100' : ''}`}
    >
      {/* Checkbox */}
      <button onClick={onToggle} className="flex items-center pt-0.5 text-surface-400 hover:text-surface-700">
        {isSelected
          ? <CheckSquare size={15} className="text-indigo-600" />
          : <Square size={15} />
        }
      </button>

      {/* Course info */}
      <div className="min-w-0 pr-3">
        <div className="flex items-center gap-2 flex-wrap">
          {isDraftRev && <FileEdit size={13} className="text-violet-500 flex-shrink-0" />}
          {isProposal && <FilePlus size={13} className="text-blue-500 flex-shrink-0" />}
          <span className="font-mono text-xs font-bold text-surface-700 bg-surface-100 px-1.5 py-0.5 rounded">
            <Highlight text={item.course_id} query={highlight} />
          </span>
          <span className="text-sm font-medium text-surface-900 truncate">
            <Highlight text={item.course_name} query={highlight} />
          </span>
        </div>

        {item.programs.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {item.programs.map(p => (
              <span key={p} className="text-[10px] text-surface-500 bg-surface-100 px-1.5 py-0.5 rounded-full">
                <Highlight text={p} query={highlight} />
              </span>
            ))}
          </div>
        )}

        {/* Document match section ─────────────────────────────────────────── */}
        {hasDocMatches && (
          <div className="mt-1.5">

            {/* Field label strip + total match count */}
            <div className="flex items-center gap-1 flex-wrap">
              <Layers size={10} className="text-indigo-400 flex-shrink-0" />
              <span className="text-[10px] font-medium text-indigo-500">
                in: {docMatchLabels.join(' · ')}
              </span>
              {docMatches.length > 1 && (
                <span className="text-[10px] text-surface-400 ml-0.5">
                  ({docMatches.length} match{docMatches.length !== 1 ? 'es' : ''})
                </span>
              )}
            </div>

            {/* First snippet — always visible */}
            {firstSnippet && (
              <p className="text-[10px] text-surface-500 leading-snug mt-0.5 pl-3.5">
                <span className="font-medium text-surface-400 mr-1">{firstSnippet.label}:</span>
                <SnippetHighlight text={firstSnippet.text} query={highlight} />
              </p>
            )}

            {/* Extra snippets — collapsed by default */}
            {hasExtras && snippetsExpanded && (
              <div className="mt-1 pl-3.5 space-y-1 border-l-2 border-indigo-100 ml-1">
                {extraSnippets.map((m, i) => (
                  <p key={i} className="text-[10px] text-surface-500 leading-snug">
                    <span className="font-medium text-surface-400 mr-1">{m.label}:</span>
                    <SnippetHighlight text={m.text} query={highlight} />
                  </p>
                ))}
              </div>
            )}

            {/* Expand / collapse toggle */}
            {hasExtras && (
              <button
                onClick={() => setSnippetsExpanded(v => !v)}
                className="flex items-center gap-0.5 mt-1 pl-3.5 text-[10px] font-medium text-indigo-500 hover:text-indigo-700 transition-colors"
              >
                {snippetsExpanded
                  ? <><ChevronUp size={10} /> Show less</>
                  : <><ChevronDown size={10} /> {extraSnippets.length} more match{extraSnippets.length !== 1 ? 'es' : ''}</>
                }
              </button>
            )}
          </div>
        )}
      </div>

      {/* Credits — highlighted if matched */}
      <div className="text-xs text-surface-600 font-mono pt-0.5">
        <Highlight text={item.creditsStr} query={highlight} />
      </div>

      {/* Status badge */}
      <div className="pt-0.5">
        {isCatalog && item.hasApprovedRevision && (
          <>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
              Approved
            </span>
            {item.lastRevised && <p className="text-[10px] text-surface-400 mt-0.5">{item.lastRevised}</p>}
          </>
        )}
        {isCatalog && !item.hasApprovedRevision && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
            Catalog data
          </span>
        )}
        {isDraftRev && (
          <>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
              Revision Draft
            </span>
            {item.lastUpdated && <p className="text-[10px] text-surface-400 mt-0.5">Updated {item.lastUpdated}</p>}
          </>
        )}
        {isProposal && (
          <>
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
              item.draftStatus === 'submitted'
                ? 'text-blue-700 bg-blue-50 border-blue-200'
                : 'text-surface-600 bg-surface-50 border-surface-200'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.draftStatus === 'submitted' ? 'bg-blue-500' : 'bg-surface-400'}`} />
              {item.draftStatus === 'submitted' ? 'Submitted' : 'Draft'} Proposal
            </span>
            {item.lastUpdated && <p className="text-[10px] text-surface-400 mt-0.5">Updated {item.lastUpdated}</p>}
          </>
        )}
      </div>

      {/* Download buttons */}
      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          onClick={onDocx}
          disabled={generating}
          title={`Download ${item.course_id} as Word document`}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {generating
            ? <span className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            : <FileDown size={12} />
          }
          DOCX
        </button>
        <button
          onClick={onPdf}
          title={`Open ${item.course_id} print / save as PDF`}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors"
        >
          <FileText size={12} />
          PDF
        </button>
      </div>
    </div>
  )
}
