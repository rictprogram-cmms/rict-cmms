/**
 * RICT CMMS — GlossaryModal
 *
 * Searchable program glossary, opened from the BookOpen icon in the app
 * header. Available to ALL logged-in users (view). Users with the
 * 'manage_glossary' permission (P176 — instructors by default, grantable to
 * Work Study) can add/edit/delete terms and manage the category list.
 *
 * Accessibility (WCAG 2.1 AA):
 *   - useDialogA11y: focus trap, Escape-to-close, focus restore,
 *     stacked-dialog aware (ConfirmDialog opens safely on top)
 *   - role="dialog", aria-modal, aria-labelledby, aria-describedby
 *   - Labeled search + filter controls (htmlFor/id pairing)
 *   - aria-live="polite" result count announced to screen readers
 *   - 44px minimum touch targets, focus-visible rings
 *   - Decorative icons aria-hidden; icon-only buttons have aria-label
 *
 * z-index: panel at z-[9000]; ConfirmDialog renders at z-[9100] above it.
 *
 * File: src/components/GlossaryModal.jsx
 */

import { useState, useEffect, useMemo, useId } from 'react'
import {
  BookOpen, Search, X, Plus, Pencil, Trash2, Tags, ArrowLeft,
  Loader2, EyeOff, Eye, AlertTriangle, Upload, Download, CheckCircle2,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { useDialogA11y } from '@/hooks/useDialogA11y'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import useGlossary from '@/hooks/useGlossary'

const inputCls =
  'w-full px-3 py-2.5 rounded-lg border border-surface-300 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus:border-brand-500'

const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg bg-brand-600 text-white text-sm font-medium ' +
  'hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'

const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg bg-surface-100 text-surface-700 text-sm font-medium ' +
  'hover:bg-surface-200 disabled:opacity-50 transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'

const iconBtn =
  'inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-surface-400 ' +
  'hover:bg-surface-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500'

export default function GlossaryModal({ open, onClose }) {
  const { profile } = useAuth()
  const { hasPerm } = usePermissions('Glossary')
  const canManage = hasPerm('manage_glossary')

  const {
    terms, categories, loading, error, fetchGlossary,
    addTerm, updateTerm, deleteTerm,
    addCategory, updateCategory, toggleCategoryStatus, deleteCategory,
    importTerms,
  } = useGlossary()

  const dialogRef = useDialogA11y(open, onClose)
  const titleId = useId()
  const descId = useId()
  const searchId = useId()
  const filterId = useId()

  // view: 'browse' | 'term-form' | 'categories' | 'import'
  const [view, setView] = useState('browse')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // Term form state (null = adding, object = editing)
  const [editingTerm, setEditingTerm] = useState(null)
  const [termText, setTermText] = useState('')
  const [defText, setDefText] = useState('')
  const [termCategory, setTermCategory] = useState('')

  // Category form state
  const [editingCat, setEditingCat] = useState(null)
  const [catName, setCatName] = useState('')
  const [catDesc, setCatDesc] = useState('')

  // Delete confirmations
  const [deleteTermTarget, setDeleteTermTarget] = useState(null)
  const [deleteCatTarget, setDeleteCatTarget] = useState(null)

  // Import state
  const [importPreview, setImportPreview] = useState(null) // { valid, invalid, dupInFile, existing, newCategories }
  const [importFileName, setImportFileName] = useState('')
  const [importParsing, setImportParsing] = useState(false)
  const [updateExisting, setUpdateExisting] = useState(false)
  const [importResult, setImportResult] = useState(null)   // { added, updated, skipped, categoriesCreated }

  // Fetch on open; reset transient state on close
  useEffect(() => {
    if (open) {
      fetchGlossary()
    } else {
      setView('browse')
      setSearch('')
      setCategoryFilter('all')
      setFormError('')
      setEditingTerm(null)
      setEditingCat(null)
      setImportPreview(null)
      setImportFileName('')
      setImportResult(null)
      setUpdateExisting(false)
    }
  }, [open, fetchGlossary])

  const activeCategories = useMemo(
    () => categories.filter(c => c.status === 'Active'),
    [categories]
  )

  const categoryNameById = useMemo(() => {
    const map = {}
    categories.forEach(c => { map[c.category_id] = c.category_name })
    return map
  }, [categories])

  // Filtered + alphabetically grouped terms
  const filteredTerms = useMemo(() => {
    const q = search.trim().toLowerCase()
    return terms
      .filter(t => t.status !== 'Inactive')
      .filter(t => categoryFilter === 'all' || t.category_id === categoryFilter)
      .filter(t =>
        !q ||
        t.term.toLowerCase().includes(q) ||
        (t.definition || '').toLowerCase().includes(q)
      )
  }, [terms, search, categoryFilter])

  const groupedTerms = useMemo(() => {
    const groups = {}
    filteredTerms.forEach(t => {
      const letter = (t.term[0] || '#').toUpperCase()
      const key = /[A-Z]/.test(letter) ? letter : '#'
      if (!groups[key]) groups[key] = []
      groups[key].push(t)
    })
    return Object.keys(groups).sort().map(letter => ({ letter, items: groups[letter] }))
  }, [filteredTerms])

  // Live duplicate detection (case-insensitive) for the term form.
  // Excludes the term being edited so renaming "PLC" → "PLC " style tweaks
  // don't flag against itself. The DB unique index is the hard backstop;
  // this just catches it before save.
  const duplicateTerm = useMemo(() => {
    const t = termText.trim().toLowerCase()
    if (!t) return null
    return terms.find(x =>
      x.term.toLowerCase() === t &&
      (!editingTerm || x.term_id !== editingTerm.term_id)
    ) || null
  }, [termText, terms, editingTerm])

  // Same for the category form.
  const duplicateCat = useMemo(() => {
    const n = catName.trim().toLowerCase()
    if (!n) return null
    return categories.find(x =>
      x.category_name.toLowerCase() === n &&
      (!editingCat || x.category_id !== editingCat.category_id)
    ) || null
  }, [catName, categories, editingCat])

  if (!open) return null

  // ── Handlers ─────────────────────────────────────────────────────────────
  const openAddTerm = () => {
    setEditingTerm(null)
    setTermText('')
    setDefText('')
    setTermCategory('')
    setFormError('')
    setView('term-form')
  }

  const openEditTerm = (t) => {
    setEditingTerm(t)
    setTermText(t.term)
    setDefText(t.definition || '')
    setTermCategory(t.category_id || '')
    setFormError('')
    setView('term-form')
  }

  const saveTerm = async () => {
    if (!termText.trim()) { setFormError('Term is required.'); return }
    if (!defText.trim()) { setFormError('Definition is required.'); return }
    if (duplicateTerm) { setFormError(`"${duplicateTerm.term}" is already in the glossary. Edit the existing term instead.`); return }
    setSaving(true)
    setFormError('')
    try {
      if (editingTerm) {
        await updateTerm(editingTerm.term_id, { term: termText, definition: defText, categoryId: termCategory || null }, profile?.email)
      } else {
        await addTerm({ term: termText, definition: defText, categoryId: termCategory || null }, profile?.email)
      }
      setView('browse')
    } catch (e) {
      console.error('Save term failed:', e)
      setFormError(e.message || 'Save failed. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const confirmDeleteTerm = async () => {
    if (!deleteTermTarget) return
    setSaving(true)
    try {
      await deleteTerm(deleteTermTarget.term_id)
      setDeleteTermTarget(null)
    } catch (e) {
      console.error('Delete term failed:', e)
      setFormError(e.message || 'Delete failed.')
      setDeleteTermTarget(null)
    } finally {
      setSaving(false)
    }
  }

  const openAddCat = () => {
    setEditingCat(null)
    setCatName('')
    setCatDesc('')
    setFormError('')
  }

  const openEditCat = (c) => {
    setEditingCat(c)
    setCatName(c.category_name)
    setCatDesc(c.description || '')
    setFormError('')
  }

  const saveCategory = async () => {
    if (!catName.trim()) { setFormError('Category name is required.'); return }
    if (duplicateCat) { setFormError(`A category named "${duplicateCat.category_name}" already exists.`); return }
    setSaving(true)
    setFormError('')
    try {
      if (editingCat) {
        await updateCategory(editingCat.category_id, { name: catName, description: catDesc }, profile?.email)
      } else {
        await addCategory({ name: catName, description: catDesc }, profile?.email)
      }
      setEditingCat(null)
      setCatName('')
      setCatDesc('')
    } catch (e) {
      console.error('Save category failed:', e)
      setFormError(e.message || 'Save failed. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const confirmDeleteCat = async () => {
    if (!deleteCatTarget) return
    setSaving(true)
    try {
      await deleteCategory(deleteCatTarget.category_id)
      setDeleteCatTarget(null)
    } catch (e) {
      console.error('Delete category failed:', e)
      setFormError(e.message || 'Delete failed.')
      setDeleteCatTarget(null)
    } finally {
      setSaving(false)
    }
  }

  // ── Import helpers ───────────────────────────────────────────────────────

  /** Quote-aware CSV parser (same approach as useProgramBudget). */
  const parseCSVText = (text) => {
    const lines = text.split(/\r?\n/)
    return lines.map(line => {
      const cells = []
      let inQuote = false
      let cell = ''
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue }
        if (ch === ',' && !inQuote) { cells.push(cell.trim()); cell = ''; continue }
        cell += ch
      }
      cells.push(cell.trim())
      return cells
    })
  }

  const downloadTemplate = () => {
    const csv = [
      'term,definition,category',
      '"PLC","Programmable Logic Controller — an industrial computer used to control machinery and processes.","PLC"',
      '"E-Stop","Emergency stop — a fail-safe button that immediately halts a machine.","Safety"',
    ].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'glossary_template.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return

    setImportParsing(true)
    setImportPreview(null)
    setImportResult(null)
    setFormError('')
    setImportFileName(file.name)

    try {
      const ext = file.name.split('.').pop().toLowerCase()
      let rawData

      if (ext === 'csv') {
        const text = await file.text()
        rawData = parseCSVText(text)
      } else if (['xls', 'xlsx'].includes(ext)) {
        // Dynamic import for SheetJS (same source as Program Budget import)
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')
        const buffer = await file.arrayBuffer()
        const wb = XLSX.read(buffer, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false })
      } else {
        throw new Error('Unsupported file type. Please use .csv, .xls, or .xlsx')
      }

      // Locate columns from the header row (any order; category optional)
      const headerRow = (rawData[0] || []).map(c => String(c || '').trim().toLowerCase())
      const termCol = headerRow.indexOf('term')
      const defCol = headerRow.findIndex(h => h === 'definition' || h === 'description')
      const catCol = headerRow.indexOf('category')
      if (termCol === -1 || defCol === -1) {
        throw new Error('Header row must include "term" and "definition" columns. Download the template for the expected format.')
      }

      const valid = []
      const invalid = []
      const dupInFile = []
      const seen = new Set()
      const existingLower = new Set(terms.map(t => t.term.toLowerCase()))

      rawData.slice(1).forEach((row, i) => {
        const lineNo = i + 2 // 1-based, after header
        if (!row || row.every(c => !String(c || '').trim())) return // blank line
        const term = String(row[termCol] || '').trim()
        const definition = String(row[defCol] || '').trim()
        const categoryName = catCol !== -1 ? String(row[catCol] || '').trim() : ''

        if (!term || !definition) {
          invalid.push({ lineNo, term: term || '(empty)', reason: !term ? 'Missing term' : 'Missing definition' })
          return
        }
        const lower = term.toLowerCase()
        if (seen.has(lower)) {
          dupInFile.push({ lineNo, term })
          return
        }
        seen.add(lower)
        valid.push({ term, definition, categoryName, existsInDb: existingLower.has(lower) })
      })

      if (valid.length === 0 && invalid.length === 0 && dupInFile.length === 0) {
        throw new Error('No data rows found below the header.')
      }

      const catLower = new Set(categories.map(c => c.category_name.toLowerCase()))
      const newCategories = [...new Set(
        valid.map(r => r.categoryName).filter(Boolean)
          .filter(name => !catLower.has(name.toLowerCase()))
      )]

      setImportPreview({
        valid,
        invalid,
        dupInFile,
        existingCount: valid.filter(r => r.existsInDb).length,
        newCategories,
      })
    } catch (err) {
      console.error('Import parse failed:', err)
      setFormError(err.message || 'Could not read the file.')
      setImportFileName('')
    } finally {
      setImportParsing(false)
    }
  }

  const runImport = async () => {
    if (!importPreview || importPreview.valid.length === 0) return
    setSaving(true)
    setFormError('')
    try {
      const result = await importTerms(importPreview.valid, { updateExisting }, profile?.email)
      setImportResult(result)
      setImportPreview(null)
      setImportFileName('')
    } catch (err) {
      console.error('Import failed:', err)
      setFormError(err.message || 'Import failed. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-surface-200">
          {view !== 'browse' && (
            <button
              onClick={() => { setView('browse'); setFormError('') }}
              className={iconBtn}
              aria-label="Back to glossary"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
          )}
          <BookOpen size={20} className="text-brand-600 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-surface-900 m-0 truncate">
              {view === 'term-form'
                ? (editingTerm ? 'Edit Term' : 'Add Term')
                : view === 'categories'
                  ? 'Manage Categories'
                  : view === 'import'
                    ? 'Import Terms'
                    : 'Program Glossary'}
            </h2>
            <p id={descId} className="text-xs text-surface-500 m-0">
              {view === 'browse'
                ? 'Search terms used in the RICT program.'
                : view === 'categories'
                  ? 'Add, rename, deactivate, or delete categories.'
                  : view === 'import'
                    ? 'Bulk-add terms from a CSV or Excel file.'
                    : 'Term and definition are required.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`${iconBtn} ml-auto`}
            aria-label="Close glossary"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Error banner (shared) */}
        {(error || formError) && (
          <div role="alert" className="flex items-start gap-2 mx-5 mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{formError || error}</span>
          </div>
        )}

        {/* ── BROWSE VIEW ─────────────────────────────────────────────────── */}
        {view === 'browse' && (
          <>
            {/* Search + filter */}
            <div className="px-5 pt-4 pb-3 flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <label htmlFor={searchId} className="sr-only">Search glossary terms</label>
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
                <input
                  id={searchId}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search terms or definitions…"
                  className={`${inputCls} pl-9`}
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor={filterId} className="sr-only">Filter by category</label>
                <select
                  id={filterId}
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className={`${inputCls} sm:w-48 min-h-[44px]`}
                >
                  <option value="all">All categories</option>
                  {activeCategories.map(c => (
                    <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Result count — announced to screen readers */}
            <div aria-live="polite" className="px-5 pb-2 text-xs text-surface-500">
              {loading
                ? 'Loading glossary…'
                : `${filteredTerms.length} term${filteredTerms.length === 1 ? '' : 's'} found`}
            </div>

            {/* Term list */}
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-surface-400">
                  <Loader2 size={22} className="animate-spin" aria-hidden="true" />
                  <span className="sr-only">Loading</span>
                </div>
              ) : filteredTerms.length === 0 ? (
                <div className="text-center py-12 text-sm text-surface-500">
                  {terms.length === 0
                    ? 'No glossary terms yet.'
                    : 'No terms match your search.'}
                  {canManage && terms.length === 0 && (
                    <div className="mt-1">Use “Add Term” below to create the first one.</div>
                  )}
                </div>
              ) : (
                groupedTerms.map(group => (
                  <div key={group.letter} className="mb-4">
                    <div className="text-xs font-bold text-brand-600 uppercase tracking-wide border-b border-surface-200 pb-1 mb-2">
                      {group.letter}
                    </div>
                    <ul className="m-0 p-0 list-none space-y-3">
                      {group.items.map(t => (
                        <li key={t.term_id} className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-surface-900">{t.term}</span>
                              {t.category_id && categoryNameById[t.category_id] && (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 font-medium">
                                  {categoryNameById[t.category_id]}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-surface-600 m-0 mt-0.5 whitespace-pre-wrap">{t.definition}</p>
                          </div>
                          {canManage && (
                            <div className="flex shrink-0">
                              <button
                                onClick={() => openEditTerm(t)}
                                className={iconBtn}
                                aria-label={`Edit term ${t.term}`}
                              >
                                <Pencil size={15} aria-hidden="true" />
                              </button>
                              <button
                                onClick={() => setDeleteTermTarget(t)}
                                className={`${iconBtn} hover:text-red-600 hover:bg-red-50`}
                                aria-label={`Delete term ${t.term}`}
                              >
                                <Trash2 size={15} aria-hidden="true" />
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>

            {/* Manage footer */}
            {canManage && (
              <div className="flex items-center gap-2 px-5 py-3 border-t border-surface-200 bg-surface-50">
                <button onClick={openAddTerm} className={btnPrimary}>
                  <Plus size={16} aria-hidden="true" /> Add Term
                </button>
                <button onClick={() => { setView('categories'); setFormError(''); openAddCat() }} className={btnSecondary}>
                  <Tags size={16} aria-hidden="true" /> Manage Categories
                </button>
                <button onClick={() => { setView('import'); setFormError(''); setImportResult(null) }} className={btnSecondary}>
                  <Upload size={16} aria-hidden="true" /> Import
                </button>
              </div>
            )}
          </>
        )}

        {/* ── TERM FORM VIEW ──────────────────────────────────────────────── */}
        {view === 'term-form' && (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <label htmlFor="gl-term" className="block text-sm font-medium text-surface-700 mb-1">
                Term <span className="text-red-600" aria-hidden="true">*</span>
              </label>
              <input
                id="gl-term"
                type="text"
                value={termText}
                onChange={(e) => setTermText(e.target.value)}
                className={inputCls}
                required
                autoFocus
                aria-invalid={duplicateTerm ? 'true' : undefined}
                aria-describedby={duplicateTerm ? 'gl-term-dup' : undefined}
              />
              {duplicateTerm && (
                <p id="gl-term-dup" role="alert" className="flex items-center gap-1.5 text-xs text-amber-700 mt-1 m-0">
                  <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
                  "{duplicateTerm.term}" is already in the glossary
                  {duplicateTerm.category_id && categoryNameById[duplicateTerm.category_id]
                    ? ` (${categoryNameById[duplicateTerm.category_id]})`
                    : ''}. Edit the existing term instead.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="gl-definition" className="block text-sm font-medium text-surface-700 mb-1">
                Definition <span className="text-red-600" aria-hidden="true">*</span>
              </label>
              <textarea
                id="gl-definition"
                value={defText}
                onChange={(e) => setDefText(e.target.value)}
                rows={4}
                className={inputCls}
                required
              />
            </div>
            <div>
              <label htmlFor="gl-category" className="block text-sm font-medium text-surface-700 mb-1">
                Category <span className="text-surface-400 font-normal">(optional)</span>
              </label>
              <select
                id="gl-category"
                value={termCategory}
                onChange={(e) => setTermCategory(e.target.value)}
                className={`${inputCls} min-h-[44px]`}
              >
                <option value="">— No category —</option>
                {activeCategories.map(c => (
                  <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
                ))}
              </select>
              {activeCategories.length === 0 && (
                <p className="text-xs text-surface-500 mt-1 m-0">
                  No categories yet — you can add some under “Manage Categories”.
                </p>
              )}
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={saveTerm} disabled={saving || !!duplicateTerm} className={btnPrimary}>
                {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {editingTerm ? 'Save Changes' : 'Add Term'}
              </button>
              <button onClick={() => { setView('browse'); setFormError('') }} disabled={saving} className={btnSecondary}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── CATEGORIES VIEW ─────────────────────────────────────────────── */}
        {view === 'categories' && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* Add / edit category form */}
            <div className="rounded-lg border border-surface-200 bg-surface-50 p-4 mb-4">
              <h3 className="text-sm font-semibold text-surface-900 m-0 mb-3">
                {editingCat ? `Edit “${editingCat.category_name}”` : 'Add Category'}
              </h3>
              <div className="space-y-3">
                <div>
                  <label htmlFor="gl-cat-name" className="block text-sm font-medium text-surface-700 mb-1">
                    Name <span className="text-red-600" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="gl-cat-name"
                    type="text"
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                    className={inputCls}
                    required
                    aria-invalid={duplicateCat ? 'true' : undefined}
                    aria-describedby={duplicateCat ? 'gl-cat-dup' : undefined}
                  />
                  {duplicateCat && (
                    <p id="gl-cat-dup" role="alert" className="flex items-center gap-1.5 text-xs text-amber-700 mt-1 m-0">
                      <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
                      A category named "{duplicateCat.category_name}" already exists
                      {duplicateCat.status !== 'Active' ? ' (currently Inactive — you can reactivate it below)' : ''}.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="gl-cat-desc" className="block text-sm font-medium text-surface-700 mb-1">
                    Description <span className="text-surface-400 font-normal">(optional)</span>
                  </label>
                  <input
                    id="gl-cat-desc"
                    type="text"
                    value={catDesc}
                    onChange={(e) => setCatDesc(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div className="flex gap-2">
                  <button onClick={saveCategory} disabled={saving || !!duplicateCat} className={btnPrimary}>
                    {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {editingCat ? 'Save Changes' : 'Add Category'}
                  </button>
                  {editingCat && (
                    <button onClick={openAddCat} disabled={saving} className={btnSecondary}>
                      Cancel Edit
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Category list */}
            {categories.length === 0 ? (
              <p className="text-sm text-surface-500 text-center py-6 m-0">No categories yet.</p>
            ) : (
              <ul className="m-0 p-0 list-none space-y-2">
                {categories.map(c => {
                  const inUse = terms.filter(t => t.category_id === c.category_id).length
                  return (
                    <li
                      key={c.category_id}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                        c.status === 'Active' ? 'border-surface-200 bg-white' : 'border-surface-200 bg-surface-100 opacity-70'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-surface-900">{c.category_name}</span>
                          {c.status !== 'Active' && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-200 text-surface-600 font-medium">Inactive</span>
                          )}
                        </div>
                        <div className="text-xs text-surface-500">
                          {inUse} term{inUse === 1 ? '' : 's'}
                          {c.description ? ` · ${c.description}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => openEditCat(c)}
                        className={iconBtn}
                        aria-label={`Edit category ${c.category_name}`}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        onClick={async () => {
                          setFormError('')
                          try {
                            await toggleCategoryStatus(c.category_id, c.status, profile?.email)
                          } catch (e) {
                            setFormError(e.message || 'Status change failed.')
                          }
                        }}
                        className={iconBtn}
                        aria-label={c.status === 'Active'
                          ? `Deactivate category ${c.category_name}`
                          : `Reactivate category ${c.category_name}`}
                      >
                        {c.status === 'Active'
                          ? <EyeOff size={15} aria-hidden="true" />
                          : <Eye size={15} aria-hidden="true" />}
                      </button>
                      <button
                        onClick={() => setDeleteCatTarget(c)}
                        className={`${iconBtn} hover:text-red-600 hover:bg-red-50`}
                        aria-label={`Delete category ${c.category_name}`}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {/* ── IMPORT VIEW ─────────────────────────────────────────────────── */}
        {view === 'import' && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* Success summary */}
            {importResult && (
              <div role="status" aria-live="polite" className="flex items-start gap-2 mb-4 px-3 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800">
                <CheckCircle2 size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <strong>Import complete.</strong>{' '}
                  {importResult.added} added
                  {importResult.updated > 0 && <>, {importResult.updated} updated</>}
                  {importResult.skipped > 0 && <>, {importResult.skipped} skipped (already exist)</>}
                  {importResult.categoriesCreated > 0 && <>, {importResult.categoriesCreated} new categor{importResult.categoriesCreated === 1 ? 'y' : 'ies'} created</>}.
                </div>
              </div>
            )}

            {/* Step 1: template + file picker */}
            <div className="rounded-lg border border-surface-200 bg-surface-50 p-4 mb-4">
              <h3 className="text-sm font-semibold text-surface-900 m-0 mb-1">1. Prepare your file</h3>
              <p className="text-xs text-surface-500 m-0 mb-3">
                Columns: <code className="bg-surface-200 px-1 rounded">term</code>,{' '}
                <code className="bg-surface-200 px-1 rounded">definition</code>, and optional{' '}
                <code className="bg-surface-200 px-1 rounded">category</code>. Header row required; column order doesn't matter.
              </p>
              <button onClick={downloadTemplate} className={btnSecondary}>
                <Download size={16} aria-hidden="true" /> Download Template (.csv)
              </button>
            </div>

            <div className="rounded-lg border border-surface-200 bg-surface-50 p-4 mb-4">
              <h3 className="text-sm font-semibold text-surface-900 m-0 mb-3">2. Choose your file</h3>
              <label
                htmlFor="gl-import-file"
                className={`${btnPrimary} cursor-pointer`}
              >
                <Upload size={16} aria-hidden="true" />
                {importFileName ? 'Choose a Different File' : 'Choose File'}
              </label>
              <input
                id="gl-import-file"
                type="file"
                accept=".csv,.xls,.xlsx"
                onChange={handleImportFile}
                className="sr-only"
                aria-describedby="gl-import-file-hint"
              />
              <p id="gl-import-file-hint" className="text-xs text-surface-500 m-0 mt-2">
                Accepts .csv, .xls, or .xlsx
                {importFileName && <> — selected: <strong>{importFileName}</strong></>}
              </p>
              {importParsing && (
                <div className="flex items-center gap-2 mt-2 text-sm text-surface-500" role="status" aria-live="polite">
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Reading file…
                </div>
              )}
            </div>

            {/* Step 3: preview */}
            {importPreview && (
              <div className="rounded-lg border border-surface-200 p-4">
                <h3 className="text-sm font-semibold text-surface-900 m-0 mb-2">3. Review and import</h3>

                <ul className="m-0 mb-3 p-0 list-none space-y-1 text-sm text-surface-700">
                  <li><strong>{importPreview.valid.length}</strong> valid row{importPreview.valid.length === 1 ? '' : 's'} ready to import</li>
                  {importPreview.existingCount > 0 && (
                    <li className="text-amber-700">
                      <strong>{importPreview.existingCount}</strong> already exist in the glossary — {updateExisting ? 'their definitions will be updated' : 'they will be skipped'}
                    </li>
                  )}
                  {importPreview.newCategories.length > 0 && (
                    <li>New categories to be created: <strong>{importPreview.newCategories.join(', ')}</strong></li>
                  )}
                  {importPreview.dupInFile.length > 0 && (
                    <li className="text-amber-700">
                      {importPreview.dupInFile.length} duplicate{importPreview.dupInFile.length === 1 ? '' : 's'} inside the file (first occurrence kept): {importPreview.dupInFile.slice(0, 5).map(d => d.term).join(', ')}{importPreview.dupInFile.length > 5 ? '…' : ''}
                    </li>
                  )}
                  {importPreview.invalid.length > 0 && (
                    <li className="text-red-700">
                      {importPreview.invalid.length} row{importPreview.invalid.length === 1 ? '' : 's'} skipped: {importPreview.invalid.slice(0, 5).map(r => `line ${r.lineNo} (${r.reason})`).join(', ')}{importPreview.invalid.length > 5 ? '…' : ''}
                    </li>
                  )}
                </ul>

                {importPreview.existingCount > 0 && (
                  <label htmlFor="gl-update-existing" className="flex items-center gap-2 mb-3 text-sm text-surface-700 cursor-pointer min-h-[44px]">
                    <input
                      id="gl-update-existing"
                      type="checkbox"
                      checked={updateExisting}
                      onChange={(e) => setUpdateExisting(e.target.checked)}
                      className="w-4 h-4 rounded border-surface-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    Update existing terms with definitions from this file (instead of skipping)
                  </label>
                )}

                {/* Preview table — first rows */}
                {importPreview.valid.length > 0 && (
                  <div className="border border-surface-200 rounded-lg overflow-hidden mb-3">
                    <table className="w-full text-sm border-collapse">
                      <caption className="sr-only">Preview of terms to be imported</caption>
                      <thead>
                        <tr className="bg-surface-50 text-left">
                          <th scope="col" className="px-3 py-2 font-semibold text-surface-700">Term</th>
                          <th scope="col" className="px-3 py-2 font-semibold text-surface-700">Definition</th>
                          <th scope="col" className="px-3 py-2 font-semibold text-surface-700">Category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.valid.slice(0, 8).map((r, i) => (
                          <tr key={i} className="border-t border-surface-100">
                            <td className="px-3 py-2 text-surface-900 font-medium whitespace-nowrap">
                              {r.term}
                              {r.existsInDb && <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">exists</span>}
                            </td>
                            <td className="px-3 py-2 text-surface-600">{r.definition.length > 90 ? r.definition.slice(0, 90) + '…' : r.definition}</td>
                            <td className="px-3 py-2 text-surface-600 whitespace-nowrap">{r.categoryName || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {importPreview.valid.length > 8 && (
                      <div className="px-3 py-2 text-xs text-surface-500 bg-surface-50 border-t border-surface-100">
                        …and {importPreview.valid.length - 8} more row{importPreview.valid.length - 8 === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2">
                  <button onClick={runImport} disabled={saving || importPreview.valid.length === 0} className={btnPrimary}>
                    {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    Import {importPreview.valid.length} Term{importPreview.valid.length === 1 ? '' : 's'}
                  </button>
                  <button onClick={() => { setImportPreview(null); setImportFileName('') }} disabled={saving} className={btnSecondary}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Delete confirmations (stack above the panel) ─────────────────── */}
      {deleteTermTarget && (
        <ConfirmDialog
          open
          variant="danger"
          title="Delete term?"
          message={<>Delete <strong>{deleteTermTarget.term}</strong> from the glossary? This cannot be undone.</>}
          confirmLabel="Delete term"
          cancelLabel="Keep term"
          busy={saving}
          onConfirm={confirmDeleteTerm}
          onClose={() => setDeleteTermTarget(null)}
        />
      )}
      {deleteCatTarget && (
        <ConfirmDialog
          open
          variant="danger"
          title="Delete category?"
          message={<>Delete the category <strong>{deleteCatTarget.category_name}</strong>? Terms are never deleted with it — if any still use this category, the delete is blocked.</>}
          confirmLabel="Delete category"
          cancelLabel="Keep category"
          busy={saving}
          onConfirm={confirmDeleteCat}
          onClose={() => setDeleteCatTarget(null)}
        />
      )}
    </div>
  )
}
