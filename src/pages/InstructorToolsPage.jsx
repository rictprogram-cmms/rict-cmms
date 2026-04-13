import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { GraduationCap, BookOpen, DollarSign, Wrench, ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Settings, X, Save, Upload, Check, ImageIcon, Trash2, Plus, Pencil, Search, Loader2, AlertCircle, FilePlus, FileEdit, LayoutTemplate, Send, CheckCircle2, Clock, FileDown, Archive } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import SyllabusWizard, { DEFAULT_COMMON_SECTIONS } from './SyllabusWizard'
import CourseProposalWizard, { DEFAULT_COLLEGE_OUTCOMES } from './CourseProposalWizard'
import { useCourseProposals } from '@/hooks/useCourseProposals'
import ProgramRevisionWizard, { DEFAULT_REVISION_SETTINGS, useRevisionSettings } from './ProgramRevisionWizard'
import CourseOutlineRevisionWizard from './CourseOutlineRevisionWizard'
import { useProgramRevisions } from '@/hooks/useProgramRevisions'
import CourseEndDateWizard from './CourseEndDateWizard'
import { useCourseEndDates } from '@/hooks/useCourseEndDates'

// ─── Common Sections Modal (Settings Gear) ────────────────────────────────────
function CommonSectionsModal({ onClose }) {
  const { user } = useAuth()
  const [sections, setSections] = useState({})
  const [sharedLogo, setSharedLogo] = useState('')   // stored separately — it's an image, not text
  const [activeKey, setActiveKey] = useState('shared_logo')
  const [saving, setSaving] = useState(false)

  // Load from Supabase on mount; fall back to defaults
  useEffect(() => {
    const merged = {}
    Object.keys(DEFAULT_COMMON_SECTIONS).forEach(k => {
      merged[k] = DEFAULT_COMMON_SECTIONS[k].content
    })
    supabase
      .from('syllabus_common_sections')
      .select('*')
      .then(({ data: rows }) => {
        if (rows) {
          rows.forEach(r => {
            if (r.section_key === 'shared_logo') {
              setSharedLogo(r.content || '')
            } else {
              merged[r.section_key] = r.content
            }
          })
        }
        setSections(merged)
      })
  }, [])

  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 600_000) { toast.error('Image too large — please use an image under 600 KB.'); return }
    const reader = new FileReader()
    reader.onload = () => setSharedLogo(reader.result)
    reader.readAsDataURL(file)
  }

  const handleSave = async () => {
    setSaving(true)

    // Build text section rows
    const textRows = Object.keys(sections).map(key => ({
      section_key:   key,
      section_title: DEFAULT_COMMON_SECTIONS[key]?.title || key,
      content:       sections[key],
      display_order: DEFAULT_COMMON_SECTIONS[key]?.order || 99,
      updated_at:    new Date().toISOString(),
      updated_by:    user?.email || '',
    }))

    // Add the logo row
    textRows.push({
      section_key:   'shared_logo',
      section_title: 'College Logo',
      content:       sharedLogo,
      display_order: 0,
      updated_at:    new Date().toISOString(),
      updated_by:    user?.email || '',
    })

    const { error } = await supabase
      .from('syllabus_common_sections')
      .upsert(textRows, { onConflict: 'section_key' })

    if (error) {
      toast.error('Save failed: ' + error.message)
    } else {
      toast.success('Settings saved!')
      onClose()
    }
    setSaving(false)
  }

  const textKeys = Object.keys(DEFAULT_COMMON_SECTIONS)

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-surface-100 rounded-lg flex items-center justify-center">
              <Settings size={16} className="text-surface-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">Syllabus Common Sections</h2>
              <p className="text-xs text-surface-400">Shared settings and boilerplate that appear in all syllabi</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left nav */}
          <div className="w-52 border-r border-surface-100 flex flex-col py-3 px-2 gap-0.5 shrink-0">

            {/* Logo — pinned at top with a special style */}
            <button
              onClick={() => setActiveKey('shared_logo')}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                activeKey === 'shared_logo'
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-surface-600 hover:bg-surface-50'
              }`}
            >
              <ImageIcon size={13} className={activeKey === 'shared_logo' ? 'text-brand-500' : 'text-surface-400'} />
              <span>College Logo</span>
              {sharedLogo && (
                <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400 shrink-0" title="Logo uploaded" />
              )}
            </button>

            {/* Divider */}
            <div className="my-1.5 border-t border-surface-100" />

            {/* Text sections */}
            {textKeys.map(k => (
              <button
                key={k}
                onClick={() => setActiveKey(k)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeKey === k
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-surface-600 hover:bg-surface-50'
                }`}
              >
                {DEFAULT_COMMON_SECTIONS[k]?.title || k}
              </button>
            ))}

            <div className="flex-1" />
            <div className="px-2 pt-2 border-t border-surface-100 mt-1">
              <p className="text-[10px] text-surface-400 leading-tight">
                Changes apply to all future generated syllabi. Existing PDFs are not affected.
              </p>
            </div>
          </div>

          {/* Editor area */}
          <div className="flex-1 flex flex-col p-5 overflow-hidden">

            {/* ── Logo panel ── */}
            {activeKey === 'shared_logo' ? (
              <div className="flex flex-col gap-5">
                <div>
                  <h3 className="text-sm font-semibold text-surface-700 mb-1">College Logo</h3>
                  <p className="text-xs text-surface-400">
                    Upload the SCTCC logo once here and it will automatically appear in the sidebar of
                    every generated syllabus. No need to upload it individually for each course.
                    Instructors can still override it per-course inside the wizard if needed.
                  </p>
                </div>

                {sharedLogo ? (
                  /* Logo preview */
                  <div className="flex items-start gap-5">
                    <div className="border-2 border-emerald-200 rounded-xl bg-emerald-50 p-4 flex items-center justify-center" style={{ minWidth: 140 }}>
                      <img src={sharedLogo} alt="Shared logo preview" className="max-h-24 max-w-[120px] object-contain" />
                    </div>
                    <div className="flex flex-col gap-3 pt-1">
                      <div className="flex items-center gap-2 text-sm text-emerald-700 font-medium">
                        <Check size={15} className="text-emerald-500" />
                        Logo uploaded — auto-applied to all syllabi
                      </div>
                      <p className="text-xs text-surface-400 leading-relaxed">
                        This image will appear in the gray sidebar box on the left side of
                        every syllabus PDF, above the college name.
                      </p>
                      <div className="flex gap-2 mt-1">
                        <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-surface-200 rounded-lg cursor-pointer hover:bg-surface-50 transition-colors text-surface-600">
                          <Upload size={12} /> Replace
                          <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
                        </label>
                        <button
                          onClick={() => setSharedLogo('')}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-red-100 text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                        >
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                      <div className="mt-1">
                        <p className="text-xs text-surface-400 mb-1">Or replace with a URL:</p>
                        <input
                          type="url"
                          value={sharedLogo && !sharedLogo.startsWith('data:') ? sharedLogo : ''}
                          onChange={e => setSharedLogo(e.target.value)}
                          placeholder="https://..."
                          className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Upload prompt */
                  <label className="flex flex-col items-center justify-center gap-3 border-2 border-dashed border-surface-200 rounded-2xl p-10 cursor-pointer hover:border-brand-300 hover:bg-brand-50/30 transition-colors group">
                    <div className="w-14 h-14 rounded-2xl bg-surface-100 group-hover:bg-brand-100 flex items-center justify-center transition-colors">
                      <Upload size={24} className="text-surface-400 group-hover:text-brand-500 transition-colors" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-surface-700 group-hover:text-brand-700 transition-colors">
                        Click to upload SCTCC logo
                      </p>
                      <p className="text-xs text-surface-400 mt-1">PNG, JPG, or SVG — under 600 KB recommended</p>
                    </div>
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
                  </label>
                )}

                {/* URL fallback */}
                {!sharedLogo && (
                  <div>
                    <p className="text-xs text-surface-400 mb-1.5">Or enter a direct image URL:</p>
                    <input
                      type="url"
                      value=""
                      onChange={e => setSharedLogo(e.target.value)}
                      placeholder="https://www.sctcc.edu/path/to/logo.png"
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                  </div>
                )}
              </div>
            ) : (
              /* ── Text section editor ── */
              <>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-surface-700">
                    {DEFAULT_COMMON_SECTIONS[activeKey]?.title}
                  </h3>
                  <span className="text-xs text-surface-400">
                    Use • for bullet points, 1. 2. 3. for numbered lists
                  </span>
                </div>
                <textarea
                  value={sections[activeKey] || ''}
                  onChange={e => setSections(prev => ({ ...prev, [activeKey]: e.target.value }))}
                  className="flex-1 w-full px-3 py-3 border border-surface-200 rounded-xl text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-400 resize-none"
                  spellCheck={false}
                />
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-100 px-6 py-3.5 flex justify-between items-center">
          <p className="text-xs text-surface-400">
            These settings are shared across all courses. The wizard only touches course-specific data.
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-surface-600 hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
            >
              <Save size={14} />
              {saving ? 'Saving…' : 'Save All Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Tile Definitions ─────────────────────────────────────────────────────────
const tiles = [
  {
    key: 'syllabus',
    title: 'Syllabus Generator',
    description: 'Build, update, and generate course syllabi semester over semester with a guided wizard.',
    icon: BookOpen,
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
    accentFrom: 'from-blue-400',
    accentTo: 'to-blue-600',
    badgeColor: 'bg-blue-50 text-blue-600',
    badge: 'Active',
    clickable: true,
    hasSettings: true,
  },
  {
    key: 'program-cost',
    title: 'Program Cost',
    description: 'Full cost breakdown by semester, course, and category — tuition, tools, materials, software, and more.',
    icon: DollarSign,
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-600',
    accentFrom: 'from-emerald-400',
    accentTo: 'to-emerald-600',
    badgeColor: 'bg-emerald-50 text-emerald-600',
    badge: 'Active',
    clickable: true,
  },
  {
    key: 'required-tools',
    title: 'Required Tools & Materials',
    description: 'Master catalog of tools and materials used across program courses.',
    icon: Wrench,
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    accentFrom: 'from-amber-400',
    accentTo: 'to-amber-600',
    badgeColor: 'bg-amber-50 text-amber-700',
    badge: 'Active',
    clickable: true,
  },
  {
    key: 'new-course-proposal',
    title: 'New Course Proposal',
    description: 'Create and submit proposals for new courses to be added to the program curriculum.',
    icon: FilePlus,
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-600',
    accentFrom: 'from-violet-400',
    accentTo: 'to-violet-600',
    badgeColor: 'bg-violet-50 text-violet-600',
    badge: 'Active',
    clickable: true,
  },
  {
    key: 'course-revision',
    title: 'Course Revision',
    description: 'Submit revisions and updates to existing courses in the program curriculum.',
    icon: FileEdit,
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    accentFrom: 'from-rose-400',
    accentTo: 'to-rose-600',
    badgeColor: 'bg-rose-50 text-rose-600',
    badge: 'Active',
    clickable: true,
  },
  {
    key: 'program-planner',
    title: 'Program Planner',
    description: 'Create and manage student academic plans, track completed courses, and build custom sequences.',
    icon: LayoutTemplate,
    iconBg: 'bg-cyan-50',
    iconColor: 'text-cyan-600',
    accentFrom: 'from-cyan-400',
    accentTo: 'to-cyan-600',
    badgeColor: 'bg-cyan-50 text-cyan-600',
    badge: 'Active',
    clickable: true,
  },
  {
    key: 'course-outline-export',
    title: 'Course Outline Export',
    description: 'Download any course outline from the catalog as a Word document or PDF — individually or as a ZIP.',
    icon: FileDown,
    iconBg: 'bg-indigo-50',
    iconColor: 'text-indigo-600',
    accentFrom: 'from-indigo-400',
    accentTo: 'to-indigo-600',
    badgeColor: 'bg-indigo-50 text-indigo-600',
    badge: 'Active',
    clickable: true,
  },
  {
    key: 'course-end-date',
    title: 'Course End Date',
    description: 'Formally retire courses from the catalog. Fills out the SCTCC end-date form, tracks approvals, and archives courses on the effective date.',
    icon: Archive,
    iconBg: 'bg-orange-50',
    iconColor: 'text-orange-600',
    accentFrom: 'from-orange-400',
    accentTo: 'to-orange-600',
    badgeColor: 'bg-orange-50 text-orange-600',
    badge: 'Active',
    clickable: true,
  },
]

// ─── Tile Component ───────────────────────────────────────────────────────────
function Tile({ tile, onOpen, onSettings }) {
  const Icon = tile.icon
  return (
    <div
      className={`bg-white border border-surface-200 rounded-2xl overflow-hidden shadow-sm flex flex-col transition-all duration-150 ${
        tile.clickable ? 'hover:shadow-md hover:border-brand-200 cursor-pointer' : ''
      }`}
      onClick={tile.clickable ? onOpen : undefined}
    >
      {/* Top accent bar */}
      <div className={`h-1.5 bg-gradient-to-r ${tile.accentFrom} ${tile.accentTo}`} />

      <div className="flex flex-col flex-1 p-6">
        {/* Icon + badge + settings row */}
        <div className="flex items-start justify-between mb-4">
          <div className={`w-11 h-11 rounded-xl ${tile.iconBg} flex items-center justify-center`}>
            <Icon size={22} className={tile.iconColor} />
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${tile.badgeColor}`}>
              {tile.badge}
            </span>
            {tile.hasSettings && (
              <button
                onClick={e => { e.stopPropagation(); onSettings() }}
                title="Edit common sections"
                className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
              >
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Title & description */}
        <h2 className="text-lg font-bold text-surface-900 mb-1.5">{tile.title}</h2>
        <p className="text-sm text-surface-500 leading-relaxed">{tile.description}</p>

        {/* Gear hint — only on tiles with a settings gear */}
        {tile.hasSettings ? (
          <p className="mt-2 text-xs text-surface-400 leading-relaxed flex-1">
            Use the ⚙ gear icon to edit shared boilerplate (policies, logo, etc.) — changes apply to <strong className="text-surface-500">all syllabi</strong>.
          </p>
        ) : (
          <div className="flex-1" />
        )}

        {/* Bottom action row */}
        <div className="border-t border-surface-100 mt-5 pt-4">
          {tile.clickable ? (
            <div className={`flex items-center gap-1.5 text-xs font-medium ${tile.key === 'required-tools' ? 'text-amber-600' : 'text-brand-600'}`}>
              <ChevronRight size={13} />
              <span>{tile.key === 'required-tools' ? 'Open catalog' : tile.key === 'new-course-proposal' ? 'Open Course Proposal Wizard' : tile.key === 'course-revision' ? 'Open Revision Wizards' : tile.key === 'program-planner' ? 'Open Program Planner' : tile.key === 'program-cost' ? 'Open Program Cost' : tile.key === 'course-outline-export' ? 'Open Course Outline Export' : tile.key === 'course-end-date' ? 'Open Course End Date' : 'Open Syllabus Generator'}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-surface-400">
              <ChevronRight size={13} className="text-surface-300" />
              <span>Under construction — check back soon</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Type badge styles ─────────────────────────────────────────────────────────
const TYPE_STYLES = {
  Tool:     { bg: 'bg-blue-50',   text: 'text-blue-700',   dot: 'bg-blue-400' },
  Material: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-400' },
  Supply:   { bg: 'bg-teal-50',   text: 'text-teal-700',   dot: 'bg-teal-400' },
  Software: { bg: 'bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-400' },
  Textbook: { bg: 'bg-orange-50', text: 'text-orange-700', dot: 'bg-orange-400' },
}

const BLANK_FORM = { item_name: '', item_type: 'Tool', part_number: '', cost: '', notes: '' }

// ─── Add / Edit modal ──────────────────────────────────────────────────────────
function ToolModal({ tool, onSave, onClose, saving }) {
  const isEdit = Boolean(tool?.tool_id)
  const [form, setForm] = useState(() =>
    isEdit
      ? { item_name: tool.item_name || '', item_type: tool.item_type || 'Tool', part_number: tool.part_number || '', cost: tool.cost != null ? String(tool.cost) : '', notes: tool.notes || '' }
      : { ...BLANK_FORM }
  )
  const [errors, setErrors] = useState({})

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function validate() {
    const e = {}
    if (!form.item_name.trim()) e.item_name = 'Item name is required'
    if (form.cost !== '' && isNaN(parseFloat(form.cost))) e.cost = 'Must be a valid number'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
              <Wrench size={15} className="text-amber-600" />
            </div>
            <h2 className="text-base font-bold text-surface-900">{isEdit ? 'Edit Item' : 'Add Item'}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-surface-100 flex items-center justify-center transition-colors">
            <X size={15} className="text-surface-500" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-surface-700 uppercase tracking-wide mb-1.5">
              Item Name <span className="text-red-500">*</span>
            </label>
            <input type="text" value={form.item_name} onChange={e => set('item_name', e.target.value)}
              placeholder="e.g. Wire Stripper — Needle Nose"
              className={`w-full px-3 py-2 text-sm border rounded-lg outline-none transition-colors ${errors.item_name ? 'border-red-300 bg-red-50' : 'border-surface-200 focus:border-brand-400'}`} />
            {errors.item_name && <p className="mt-1 text-xs text-red-500 flex items-center gap-1"><AlertCircle size={11} />{errors.item_name}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-surface-700 uppercase tracking-wide mb-1.5">Type</label>
              <select value={form.item_type} onChange={e => set('item_type', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white">
                <option>Tool</option><option>Material</option><option>Supply</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-surface-700 uppercase tracking-wide mb-1.5">ISBN Number</label>
              <input type="text" value={form.part_number} onChange={e => set('part_number', e.target.value)}
                placeholder="e.g. 12120-N"
                className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-surface-700 uppercase tracking-wide mb-1.5">
              Cost <span className="font-normal text-surface-400">(optional)</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-surface-400 select-none">$</span>
              <input type="number" step="0.01" min="0" value={form.cost} onChange={e => set('cost', e.target.value)}
                placeholder="0.00"
                className={`w-full pl-7 pr-3 py-2 text-sm border rounded-lg outline-none transition-colors ${errors.cost ? 'border-red-300 bg-red-50' : 'border-surface-200 focus:border-brand-400'}`} />
            </div>
            {errors.cost && <p className="mt-1 text-xs text-red-500 flex items-center gap-1"><AlertCircle size={11} />{errors.cost}</p>}
          </div>
          <div>
            <label className="block text-xs font-semibold text-surface-700 uppercase tracking-wide mb-1.5">
              Notes <span className="font-normal text-surface-400">(optional)</span>
            </label>
            <textarea rows={2} value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder="Where to purchase, specifications, etc."
              className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-surface-200 bg-surface-50">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm font-medium text-surface-700 bg-white border border-surface-200 rounded-lg hover:bg-surface-50 transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => { if (validate()) onSave(form) }} disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-500 rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 shadow-sm">
            {saving ? <><Loader2 size={14} className="animate-spin" />Saving…</> : <><Check size={14} />{isEdit ? 'Save Changes' : 'Add Item'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Delete confirm modal ──────────────────────────────────────────────────────
function DeleteModal({ tool, onConfirm, onClose, saving }) {
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
            <Trash2 size={17} className="text-red-500" />
          </div>
          <div>
            <h3 className="font-bold text-surface-900 text-sm">Delete Item?</h3>
            <p className="text-sm text-surface-500 mt-0.5">
              Are you sure you want to delete <span className="font-semibold text-surface-700">"{tool.item_name}"</span>? This cannot be undone.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm font-medium text-surface-700 bg-white border border-surface-200 rounded-lg hover:bg-surface-50 transition-colors">Cancel</button>
          <button onClick={() => onConfirm(tool.tool_id, tool.item_name)} disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-500 rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Required Tools & Materials panel ─────────────────────────────────────────
function RequiredToolsPanel({ onBack }) {
  const { profile } = useAuth()
  const [tools, setTools]       = useState([])
  const [classes, setClasses]   = useState([])       // all classes for name lookup
  const [usageMap, setUsageMap] = useState({})       // tool_id → Set of course_ids
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [search, setSearch]     = useState('')
  const [typeFilter, setTypeFilter] = useState('All')
  const [showAdd, setShowAdd]       = useState(false)
  const [editTool, setEditTool]     = useState(null)
  const [deletingTool, setDeletingTool] = useState(null)

  const loadTools = useCallback(async () => {
    const { data } = await supabase.from('program_tools').select('*').order('item_type').order('item_name')
    setTools(data || [])
  }, [])

  // Load classes + syllabi to compute which courses use each tool
  const loadUsage = useCallback(async () => {
    const [{ data: cls }, { data: syllabi }] = await Promise.all([
      supabase.from('classes').select('class_id, course_id, course_name, semester'),
      supabase.from('syllabus_templates').select('course_id, required_materials'),
    ])
    setClasses(cls || [])

    // Build map: item_name (lowercase) → Set<course_id>
    const nameMap = {}
    ;(syllabi || []).forEach(s => {
      if (!Array.isArray(s.required_materials)) return
      s.required_materials.forEach(m => {
        // Strip part number suffix to get clean name for matching
        const clean = m.replace(/ \(Part #:.*?\)$/i, '').trim().toLowerCase()
        if (!nameMap[clean]) nameMap[clean] = new Set()
        nameMap[clean].add(s.course_id)
      })
    })
    setUsageMap(nameMap)
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadTools(), loadUsage()]).finally(() => setLoading(false))
    const ch = supabase.channel('program_tools_rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_tools' }, loadTools)
      .subscribe()
    const onReconnect = () => { loadTools(); loadUsage() }
    window.addEventListener('supabase-reconnected', onReconnect)
    return () => { ch.unsubscribe(); window.removeEventListener('supabase-reconnected', onReconnect) }
  }, [loadTools, loadUsage])

  const filtered = useMemo(() => {
    let list = [...tools]
    if (typeFilter !== 'All') list = list.filter(t => t.item_type === typeFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(t => t.item_name?.toLowerCase().includes(q) || t.part_number?.toLowerCase().includes(q) || t.notes?.toLowerCase().includes(q))
    }
    return list
  }, [tools, typeFilter, search])

  const stats = useMemo(() => {
    const a = tools.filter(t => t.status === 'Active')
    return { total: a.length, tools: a.filter(t => t.item_type === 'Tool').length, materials: a.filter(t => t.item_type === 'Material').length, supplies: a.filter(t => t.item_type === 'Supply').length }
  }, [tools])

  async function handleSave(form) {
    setSaving(true)
    let nameChanged = false
    try {
      if (editTool?.tool_id) {
        const oldName       = editTool.item_name?.trim() || ''
        const oldPartNumber = editTool.part_number?.trim() || ''
        const newName       = form.item_name.trim()
        const newPartNumber = form.part_number?.trim() || ''

        const { error } = await supabase.from('program_tools').update({
          item_name: newName, item_type: form.item_type,
          part_number: newPartNumber || null,
          cost: form.cost !== '' ? parseFloat(form.cost) : null,
          notes: form.notes?.trim() || null, updated_by: profile?.email,
        }).eq('tool_id', editTool.tool_id).select()
        if (error) throw error

        // If the name or part number changed, update all syllabus_templates that
        // reference the old string so usage display and Program Cost stay accurate
        nameChanged = newName !== oldName || newPartNumber !== oldPartNumber
        if (nameChanged) {
          const oldStr = oldPartNumber ? `${oldName} (Part #: ${oldPartNumber})` : oldName
          const newStr = newPartNumber ? `${newName} (Part #: ${newPartNumber})` : newName

          // Fetch templates whose required_materials array contains the old string
          const { data: templates } = await supabase
            .from('syllabus_templates')
            .select('course_id, semester, required_materials')
            .contains('required_materials', JSON.stringify([oldStr]))

          if (templates?.length) {
            // Replace old string with new string in each affected template
            await Promise.all(templates.map(t => {
              const updated = (t.required_materials || []).map(m => m === oldStr ? newStr : m)
              return supabase.from('syllabus_templates')
                .update({ required_materials: updated, updated_at: new Date().toISOString() })
                .eq('course_id', t.course_id).eq('semester', t.semester).select()
            }))
            toast.success(`"${newName}" updated — ${templates.length} syllabus template${templates.length !== 1 ? 's' : ''} refreshed`)
          } else {
            toast.success(`"${newName}" updated`)
          }
        } else {
          toast.success(`"${newName}" updated`)
        }

        setEditTool(null)
      } else {
        // Generate ID client-side — avoids get_next_id table-name dependency
        const idData = 'PT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()
        const { error } = await supabase.from('program_tools').insert({
          tool_id: idData, item_name: form.item_name.trim(), item_type: form.item_type,
          part_number: form.part_number?.trim() || null,
          cost: form.cost !== '' ? parseFloat(form.cost) : null,
          notes: form.notes?.trim() || null, status: 'Active',
          created_by: profile?.email, updated_by: profile?.email,
        }).select()
        if (error) throw error
        toast.success(`"${form.item_name}" added`)
        setShowAdd(false)
      }
      await loadTools()
      if (nameChanged) await loadUsage()
    } catch (err) {
      toast.error('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(tool_id, item_name) {
    setSaving(true)
    const { error } = await supabase.from('program_tools').delete().eq('tool_id', tool_id)
    setSaving(false)
    if (error) { toast.error('Failed to delete'); return }
    toast.success(`"${item_name}" deleted`)
    setDeletingTool(null)
    await loadTools()
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-surface-500 hover:text-surface-800 transition-colors group">
            <ChevronLeft size={16} className="group-hover:-translate-x-0.5 transition-transform" /> Back
          </button>
          <span className="text-surface-300">/</span>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center">
              <Wrench size={14} className="text-amber-600" />
            </div>
            <h2 className="text-lg font-bold text-surface-900">Required Tools & Materials</h2>
          </div>
        </div>
        <button onClick={() => { setEditTool(null); setShowAdd(true) }}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-500 rounded-xl hover:bg-amber-600 transition-colors shadow-sm">
          <Plus size={15} /> Add Item
        </button>
      </div>

      {/* Context note */}
      <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-5 text-sm text-amber-800">
        <Wrench size={15} className="text-amber-500 mt-0.5 flex-shrink-0" />
        <p>Master catalog for the program. When building a syllabus, you'll pick items from this list for each course. New items added in the Syllabus Wizard are saved here automatically.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[['Total Items', stats.total, 'text-surface-800'], ['Tools', stats.tools, 'text-blue-700'], ['Materials', stats.materials, 'text-violet-700'], ['Supplies', stats.supplies, 'text-teal-700']].map(([label, value, color]) => (
          <div key={label} className="bg-white border border-surface-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-surface-500 mb-0.5">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Search + filter */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items…"
            className="w-full pl-8 pr-3 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white" />
          {search && <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600"><X size={13} /></button>}
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-surface-200 rounded-lg outline-none focus:border-brand-400 bg-white">
          <option value="All">All Types</option><option>Tool</option><option>Material</option><option>Supply</option><option>Software</option><option>Textbook</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white border border-surface-200 rounded-2xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-surface-400">
            <Loader2 size={20} className="animate-spin" /><span className="text-sm">Loading…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center"><Wrench size={22} className="text-amber-300" /></div>
            <div className="text-center">
              <p className="text-sm font-medium text-surface-600">{tools.length === 0 ? 'No items yet' : 'No results found'}</p>
              <p className="text-xs text-surface-400 mt-1">{tools.length === 0 ? 'Click "Add Item" to build your catalog' : 'Try adjusting your search or filter'}</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-200 bg-surface-50">
                  {['#', 'Item Name', 'Type', 'ISBN Number', 'Cost', 'Used In', 'Actions'].map((h, i) => (
                    <th key={h} className={`px-4 py-3 text-xs font-bold uppercase tracking-wide text-surface-500 ${i === 0 ? 'w-8' : ''} ${h === 'Cost' ? 'text-right' : h === 'Actions' ? 'text-center w-20' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {filtered.map((tool, idx) => {
                  const ts = TYPE_STYLES[tool.item_type] || TYPE_STYLES.Tool
                  return (
                    <tr key={tool.tool_id} className="hover:bg-surface-50 transition-colors group">
                      <td className="px-4 py-3 text-xs text-surface-400 tabular-nums">{idx + 1}</td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-surface-800" title={tool.notes || undefined}>{tool.item_name}</span>
                        {tool.notes && <span className="ml-1 text-[10px] text-surface-400" title={tool.notes}>ⓘ</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${ts.bg} ${ts.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${ts.dot}`} />{tool.item_type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {tool.part_number ? <span className="font-mono text-xs text-surface-600 bg-surface-100 px-1.5 py-0.5 rounded">{tool.part_number}</span> : <span className="text-xs text-surface-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {tool.cost != null ? <span className="text-sm font-semibold text-surface-800">${Number(tool.cost).toFixed(2)}</span> : <span className="text-xs text-surface-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {(() => {
                          const key = tool.item_name?.toLowerCase()
                          const courseIds = usageMap[key] ? [...usageMap[key]] : []
                          if (courseIds.length === 0) return <span className="text-xs text-surface-300 italic">Not used</span>
                          const MAX = 3
                          const shown = courseIds.slice(0, MAX)
                          const extra = courseIds.length - MAX
                          return (
                            <div className="flex flex-wrap gap-1">
                              {shown.map(cid => {
                                const cls = classes.find(c => c.course_id === cid)
                                return (
                                  <span key={cid} title={cls ? `${cls.course_name} · ${cls.semester}` : cid}
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-brand-50 text-brand-700 border border-brand-100 cursor-default">
                                    {cid}
                                  </span>
                                )
                              })}
                              {extra > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-100 text-surface-500">
                                  +{extra}
                                </span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => { setShowAdd(false); setEditTool(tool) }} className="w-7 h-7 rounded-lg hover:bg-amber-50 flex items-center justify-center transition-colors" title="Edit">
                            <Pencil size={14} className="text-amber-600" />
                          </button>
                          <button onClick={() => setDeletingTool(tool)} className="w-7 h-7 rounded-lg hover:bg-red-50 flex items-center justify-center transition-colors" title="Delete">
                            <Trash2 size={14} className="text-red-500" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {filtered.some(t => t.cost != null) && (
                <tfoot>
                  <tr className="border-t-2 border-surface-200 bg-surface-50">
                    <td colSpan={4} className="px-4 py-2.5 text-xs font-semibold text-surface-600 text-right">
                      {typeFilter !== 'All' ? `${typeFilter} subtotal:` : 'Catalog total:'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="text-sm font-bold text-surface-800">${filtered.reduce((s, t) => s + (t.cost || 0), 0).toFixed(2)}</span>
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {!loading && filtered.length > 0 && (
        <p className="mt-2 text-xs text-surface-400 text-right">
          {filtered.length} item{filtered.length !== 1 ? 's' : ''} shown{tools.length !== filtered.length && ` of ${tools.length} total`}
        </p>
      )}

      {(showAdd || Boolean(editTool)) && (
        <ToolModal tool={editTool} onSave={handleSave} onClose={() => { setShowAdd(false); setEditTool(null) }} saving={saving} />
      )}
      {deletingTool && (
        <DeleteModal tool={deletingTool} onConfirm={handleDelete} onClose={() => setDeletingTool(null)} saving={saving} />
      )}
    </div>
  )
}


// ─── Status config for proposal mini-list ─────────────────────────────────────
const PROPOSAL_STATUS = {
  draft:     { label: 'Draft',     color: 'text-surface-500',  bg: 'bg-surface-100',  Icon: Clock        },
  submitted: { label: 'Submitted', color: 'text-blue-600',     bg: 'bg-blue-50',      Icon: Send         },
  approved:  { label: 'Approved',  color: 'text-emerald-600',  bg: 'bg-emerald-50',   Icon: CheckCircle2 },
  rejected:  { label: 'Rejected',  color: 'text-red-500',      bg: 'bg-red-50',       Icon: X            },
}

// ─── Course Proposal tile — special tile that lists existing proposals ─────────
function CourseProposalTile({ tile, proposals, loading, onOpen, onNew, onSettings }) {
  const Icon = tile.icon
  const [expanded, setExpanded] = useState(false)
  const allNonApproved = proposals.filter(p => p.status !== 'approved')
  const COLLAPSED_LIMIT = 4
  const hasOverflow = allNonApproved.length > COLLAPSED_LIMIT
  const visible = expanded ? allNonApproved : allNonApproved.slice(0, COLLAPSED_LIMIT)
  return (
    <div
      className="bg-white border border-surface-200 rounded-2xl overflow-hidden shadow-sm flex flex-col hover:shadow-md hover:border-violet-200 transition-all duration-150"
    >
      <div className={`h-1.5 bg-gradient-to-r ${tile.accentFrom} ${tile.accentTo}`} />
      <div className="flex flex-col flex-1 p-6">
        {/* Icon + badge */}
        <div className="flex items-start justify-between mb-4">
          <div className={`w-11 h-11 rounded-xl ${tile.iconBg} flex items-center justify-center`}>
            <Icon size={22} className={tile.iconColor} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${tile.badgeColor}`}>
              {tile.badge}
            </span>
            {onSettings && (
              <button
                onClick={e => { e.stopPropagation(); onSettings() }}
                title="Edit college outcomes"
                className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
              >
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Title & description */}
        <h2 className="text-lg font-bold text-surface-900 mb-1.5">{tile.title}</h2>
        <p className="text-sm text-surface-500 leading-relaxed mb-3">{tile.description}</p>

        {/* Existing proposals list */}
        {loading && (
          <div className="space-y-1.5 mb-3">
            <div className="h-7 bg-surface-100 rounded-lg animate-pulse" />
            <div className="h-7 bg-surface-100 rounded-lg animate-pulse w-4/5" />
          </div>
        )}
        {!loading && visible.length > 0 && (
          <div className="space-y-1 mb-3">
            {visible.map(prop => {
              const cfg = PROPOSAL_STATUS[prop.status] || PROPOSAL_STATUS.draft
              const StatusIcon = cfg.Icon
              const label = [prop.course_subject, prop.course_number, prop.course_title]
                .filter(Boolean).join(' ') || 'Untitled Proposal'
              return (
                <button
                  key={prop.proposal_id}
                  onClick={() => onOpen(prop)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-50 hover:bg-violet-50 border border-transparent hover:border-violet-100 rounded-lg text-left transition-colors group"
                >
                  <StatusIcon size={11} className={cfg.color} />
                  <span className="text-xs font-medium text-surface-700 flex-1 truncate group-hover:text-violet-700">{label}</span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.color} shrink-0`}>{cfg.label}</span>
                </button>
              )
            })}
            {hasOverflow && (
              <button
                onClick={() => setExpanded(prev => !prev)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-center gap-1 pt-1 text-[11px] font-medium text-violet-600 hover:text-violet-800 transition-colors"
              >
                {expanded ? (
                  <><ChevronUp size={12} /> Show less</>
                ) : (
                  <><ChevronDown size={12} /> +{allNonApproved.length - COLLAPSED_LIMIT} more draft{allNonApproved.length - COLLAPSED_LIMIT !== 1 ? 's' : ''}</>
                )}
              </button>
            )}
          </div>
        )}
        {!loading && proposals.length === 0 && (
          <p className="text-xs text-surface-400 italic mb-3">{proposals.some(p=>p.status==='approved')?'All proposals are approved and active.':'No proposals yet — create your first one.'}</p>
        )}

        {/* Bottom action */}
        <div className="border-t border-surface-100 mt-auto pt-4">
          <button
            onClick={() => onNew()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl transition-colors"
          >
            <FilePlus size={13} /> New Course Proposal
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── College Outcomes Settings Modal ─────────────────────────────────────────
function CollegeOutcomesModal({ onClose }) {
  const { user } = useAuth()
  const [groups, setGroups] = useState([])
  const [saving, setSaving]   = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('settings')
      .select('setting_value')
      .eq('setting_key', 'college_outcomes_list')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.setting_value) {
          try { setGroups(JSON.parse(data.setting_value)); return } catch {}
        }
        setGroups(JSON.parse(JSON.stringify(DEFAULT_COLLEGE_OUTCOMES)))
      })
      .finally(() => setLoading(false))
  }, [])

  const updOutcome  = (gi, v) => setGroups(gs => gs.map((g,i) => i===gi ? {...g, outcome:v} : g))
  const updComp     = (gi, ci, v) => setGroups(gs => gs.map((g,i) => i!==gi ? g : {...g, competencies: g.competencies.map((c,j) => j===ci ? v : c)}))
  const addComp     = (gi) => setGroups(gs => gs.map((g,i) => i===gi ? {...g, competencies:[...g.competencies,'']} : g))
  const removeComp  = (gi, ci) => setGroups(gs => gs.map((g,i) => i!==gi ? g : {...g, competencies: g.competencies.filter((_,j)=>j!==ci)}))
  const addGroup    = () => setGroups(gs => [...gs, { outcome:'', competencies:[''] }])
  const removeGroup = (gi) => setGroups(gs => gs.filter((_,i)=>i!==gi))

  const handleSave = async () => {
    setSaving(true)
    const { error } = await supabase.from('settings').upsert({
      setting_key:   'college_outcomes_list',
      setting_value: JSON.stringify(groups),
      description:   'SCTCC College Outcomes and Competencies for Course Proposal wizard',
      category:      'course_proposals',
      updated_at:    new Date().toISOString(),
      updated_by:    user?.email || '',
    }, { onConflict: 'setting_key' })
    setSaving(false)
    if (error) { toast.error('Save failed: ' + error.message); return }
    toast.success('College outcomes saved!')
    onClose()
  }

  const handleReset = () => setGroups(JSON.parse(JSON.stringify(DEFAULT_COLLEGE_OUTCOMES)))

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-violet-50 rounded-lg flex items-center justify-center">
              <Settings size={15} className="text-violet-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">College Outcomes & Competencies</h2>
              <p className="text-xs text-surface-400">Used as dropdown options in the Course Proposal wizard</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-surface-400 text-sm gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : groups.map((group, gi) => (
            <div key={gi} className="border border-surface-200 rounded-xl overflow-hidden">
              {/* Outcome header */}
              <div className="flex items-center gap-2 px-3 py-2 bg-violet-50 border-b border-surface-200">
                <input
                  value={group.outcome}
                  onChange={e => updOutcome(gi, e.target.value)}
                  placeholder="College Outcome name…"
                  className="flex-1 bg-transparent text-sm font-semibold text-violet-800 placeholder-violet-300 outline-none"
                />
                <button onClick={() => removeGroup(gi)} className="p-1 hover:bg-red-50 rounded text-surface-300 hover:text-red-500 transition-colors flex-shrink-0">
                  <Trash2 size={13} />
                </button>
              </div>
              {/* Competencies */}
              <div className="px-3 py-2 space-y-1.5">
                {group.competencies.map((comp, ci) => (
                  <div key={ci} className="flex items-center gap-2">
                    <span className="text-surface-300 text-xs shrink-0">↳</span>
                    <input
                      value={comp}
                      onChange={e => updComp(gi, ci, e.target.value)}
                      placeholder="Competency…"
                      className="flex-1 px-2 py-1 text-xs border border-surface-200 rounded-md focus:outline-none focus:ring-1 focus:ring-violet-400"
                    />
                    <button onClick={() => removeComp(gi, ci)} className="p-1 hover:bg-red-50 rounded text-surface-200 hover:text-red-400 transition-colors flex-shrink-0">
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <button onClick={() => addComp(gi)} className="flex items-center gap-1 text-[11px] text-brand-500 hover:text-brand-700 font-medium mt-1">
                  <Plus size={11} /> Add competency
                </button>
              </div>
            </div>
          ))}
          {!loading && (
            <button onClick={addGroup} className="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-800 font-medium">
              <Plus size={13} /> Add outcome group
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-surface-100 px-6 py-3.5 flex items-center justify-between shrink-0">
          <button onClick={handleReset} className="text-xs text-surface-400 hover:text-surface-600 underline transition-colors">
            Reset to SCTCC defaults
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-surface-600 hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50">
              <Save size={14} />{saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── Program Revision Settings Modal ─────────────────────────────────────────
function ProgramRevisionSettingsModal({ onClose }) {
  const { user } = useAuth()
  const [settings, setSettings] = useState({...DEFAULT_REVISION_SETTINGS})
  const [saving, setSaving]   = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(()=>{
    supabase.from('settings')
      .select('setting_value')
      .eq('setting_key','revision_program_settings')
      .maybeSingle()
      .then(({data})=>{
        if(data?.setting_value){
          try{ setSettings({...DEFAULT_REVISION_SETTINGS,...JSON.parse(data.setting_value)}) }catch{}
        }
        setLoading(false)
      })
  },[])

  const upd = (k,v)=>setSettings(s=>({...s,[k]:v}))

  const handleSave = async ()=>{
    setSaving(true)
    const { error } = await supabase.from('settings').upsert({
      setting_key:   'revision_program_settings',
      setting_value: JSON.stringify(settings),
      description:   'Default program-level settings for Course Revision wizard',
      category:      'course_revisions',
      updated_at:    new Date().toISOString(),
      updated_by:    user?.email||'',
    },{ onConflict:'setting_key' })
    setSaving(false)
    if(error){ toast.error('Save failed: '+error.message); return }
    toast.success('Settings saved!')
    onClose()
  }

  const FIELDS = [
    { key:'default_program_name',  label:'Default Current Program Name',  placeholder:'e.g. Robotics & Industrial Controls AAS' },
    { key:'default_planner_name',  label:'Default Planner Name',          placeholder:'e.g. Robotics & Industrial Controls' },
    { key:'default_major',         label:'Default Major',                  placeholder:'e.g. Robotics & Industrial Controls AAS' },
    { key:'default_faculty_name',  label:'Default Faculty Name',           placeholder:'e.g. Aaron Wacker' },
  ]

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-rose-50 rounded-lg flex items-center justify-center">
              <Settings size={15} className="text-rose-600"/>
            </div>
            <div>
              <h2 className="text-base font-bold text-surface-900">Revision Program Settings</h2>
              <p className="text-xs text-surface-400">Default values pre-filled in every new revision</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-100 rounded-lg transition-colors">
            <X size={18} className="text-surface-400"/>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {loading
            ? <div className="flex items-center justify-center py-8 text-surface-400 text-sm gap-2"><Loader2 size={16} className="animate-spin"/>Loading…</div>
            : FIELDS.map(({key,label,placeholder})=>(
              <div key={key}>
                <label className="block text-xs font-semibold text-surface-700 mb-1.5">{label}</label>
                <input value={settings[key]||''} onChange={e=>upd(key,e.target.value)}
                  placeholder={placeholder}
                  className="w-full px-3 py-2 text-sm border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500"/>
              </div>
            ))
          }
        </div>
        <div className="border-t border-surface-100 px-6 py-3.5 flex items-center justify-between">
          <button onClick={()=>setSettings({...DEFAULT_REVISION_SETTINGS})}
            className="text-xs text-surface-400 hover:text-surface-600 underline transition-colors">
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-surface-600 hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors disabled:opacity-50">
              <Save size={14}/>{saving?'Saving…':'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── Course End Date tile ─────────────────────────────────────────────────────
function CourseEndDateTile({ tile, endDates, loading, onOpen, onNew }) {
  const Icon = tile.icon
  const [expanded, setExpanded] = useState(false)
  const allNonApproved = (endDates || []).filter(r => r.status !== 'approved')
  const COLLAPSED_LIMIT = 4
  const hasOverflow = allNonApproved.length > COLLAPSED_LIMIT
  const visible = expanded ? allNonApproved : allNonApproved.slice(0, COLLAPSED_LIMIT)
  const hasDrafts = allNonApproved.length > 0

  return (
    <div className="bg-white border border-surface-200 rounded-2xl overflow-hidden shadow-sm flex flex-col hover:shadow-md hover:border-orange-200 transition-all duration-150">
      <div className={`h-1.5 bg-gradient-to-r ${tile.accentFrom} ${tile.accentTo}`} />
      <div className="flex flex-col flex-1 p-6">
        {/* Icon + badge */}
        <div className="flex items-start justify-between mb-4">
          <div className={`w-11 h-11 rounded-xl ${tile.iconBg} flex items-center justify-center`}>
            <Icon size={22} className={tile.iconColor} />
          </div>
          <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${tile.badgeColor}`}>
            {tile.badge}
          </span>
        </div>

        <h2 className="text-lg font-bold text-surface-900 mb-1.5">{tile.title}</h2>
        <p className="text-sm text-surface-500 leading-relaxed mb-3">{tile.description}</p>

        {/* Draft list */}
        {loading && (
          <div className="space-y-1.5 mb-3">
            <div className="h-7 bg-surface-100 rounded-lg animate-pulse" />
            <div className="h-7 bg-surface-100 rounded-lg animate-pulse w-4/5" />
          </div>
        )}
        {!loading && hasDrafts && (
          <div className="space-y-1 mb-3">
            {visible.map(rec => {
              const isDraft = rec.status === 'draft'
              const courses = rec.courses || []
              const label = courses.length > 0
                ? courses.map(c => c.course_id).join(', ')
                : rec.record_id || 'Untitled'
              return (
                <button
                  key={rec.record_id}
                  onClick={() => onOpen(rec)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-50 hover:bg-orange-50 border border-transparent hover:border-orange-100 rounded-lg text-left transition-colors group"
                >
                  <Archive size={11} className={isDraft ? 'text-surface-400' : 'text-emerald-500'} />
                  <span className="text-xs font-medium text-surface-700 flex-1 truncate group-hover:text-orange-700">
                    {label}
                  </span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                    isDraft ? 'bg-surface-100 text-surface-500' : 'bg-emerald-50 text-emerald-600'
                  }`}>
                    {rec.status}
                  </span>
                </button>
              )
            })}
            {hasOverflow && (
              <button
                onClick={() => setExpanded(prev => !prev)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-center gap-1 pt-1 text-[11px] font-medium text-orange-600 hover:text-orange-800 transition-colors"
              >
                {expanded ? (
                  <><ChevronUp size={12} /> Show less</>
                ) : (
                  <><ChevronDown size={12} /> +{allNonApproved.length - COLLAPSED_LIMIT} more draft{allNonApproved.length - COLLAPSED_LIMIT !== 1 ? 's' : ''}</>
                )}
              </button>
            )}
          </div>
        )}
        {!loading && !hasDrafts && (
          <p className="text-xs text-surface-400 italic mb-3">
            {(endDates || []).some(r => r.status === 'approved')
              ? 'All end-date requests are approved.'
              : 'No end-date requests in progress — start one below.'}
          </p>
        )}

        {/* CTA */}
        <div className="border-t border-surface-100 mt-auto pt-4">
          <button
            onClick={() => onNew()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-xl transition-colors"
          >
            <Archive size={13} /> New Course End Date
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Course Revision tile — lists drafts like CourseProposalTile ──────────────
function CourseRevisionTile({ tile, revisions, loading, onOpen, onNew, onNewCourseOutline, onSettings }) {
  const Icon = tile.icon
  const [expanded, setExpanded] = useState(false)
  const allNonApproved = (revisions || []).filter(r => r.status !== 'approved')
  const COLLAPSED_LIMIT = 4
  const hasOverflow = allNonApproved.length > COLLAPSED_LIMIT
  const visible = expanded ? allNonApproved : allNonApproved.slice(0, COLLAPSED_LIMIT)
  const hasDrafts = allNonApproved.length > 0

  return (
    <div className="bg-white border border-surface-200 rounded-2xl overflow-hidden shadow-sm flex flex-col hover:shadow-md hover:border-rose-200 transition-all duration-150">
      <div className={`h-1.5 bg-gradient-to-r ${tile.accentFrom} ${tile.accentTo}`} />
      <div className="flex flex-col flex-1 p-6">
        {/* Icon + badge + gear */}
        <div className="flex items-start justify-between mb-4">
          <div className={`w-11 h-11 rounded-xl ${tile.iconBg} flex items-center justify-center`}>
            <Icon size={22} className={tile.iconColor} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${tile.badgeColor}`}>
              {tile.badge}
            </span>
            {onSettings && (
              <button
                onClick={e => { e.stopPropagation(); onSettings() }}
                title="Program revision settings"
                className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
              >
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>

        <h2 className="text-lg font-bold text-surface-900 mb-1.5">{tile.title}</h2>
        <p className="text-sm text-surface-500 leading-relaxed mb-3">{tile.description}</p>

        {/* Draft list */}
        {loading && (
          <div className="space-y-1.5 mb-3">
            <div className="h-7 bg-surface-100 rounded-lg animate-pulse" />
            <div className="h-7 bg-surface-100 rounded-lg animate-pulse w-4/5" />
          </div>
        )}
        {!loading && hasDrafts && (
          <div className="space-y-1 mb-3">
            {visible.map(rev => {
              const isDraft = rev.status === 'draft'
              const isCourse = rev._type === 'course'
              return (
                <button
                  key={rev.revision_id}
                  onClick={() => onOpen(rev)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-50 hover:bg-rose-50 border border-transparent hover:border-rose-100 rounded-lg text-left transition-colors group"
                >
                  <FileEdit size={11} className={isDraft ? 'text-surface-400' : 'text-emerald-500'} />
                  <span className="text-xs font-medium text-surface-700 flex-1 truncate group-hover:text-rose-700">
                    {rev.course_id || 'Untitled'}{rev.current_program_name ? ` — ${rev.current_program_name}` : ''}
                  </span>
                  {/* Type badge */}
                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                    isCourse ? 'bg-blue-50 text-blue-600' : 'bg-violet-50 text-violet-600'
                  }`}>
                    {isCourse ? 'course' : 'program'}
                  </span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                    isDraft ? 'bg-surface-100 text-surface-500' : 'bg-emerald-50 text-emerald-600'
                  }`}>
                    {rev.status}
                  </span>
                </button>
              )
            })}
            {hasOverflow && (
              <button
                onClick={() => setExpanded(prev => !prev)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-center gap-1 pt-1 text-[11px] font-medium text-rose-600 hover:text-rose-800 transition-colors"
              >
                {expanded ? (
                  <><ChevronUp size={12} /> Show less</>
                ) : (
                  <><ChevronDown size={12} /> +{allNonApproved.length - COLLAPSED_LIMIT} more draft{allNonApproved.length - COLLAPSED_LIMIT !== 1 ? 's' : ''}</>
                )}
              </button>
            )}
          </div>
        )}
        {!loading && !hasDrafts && (
          <p className="text-xs text-surface-400 italic mb-3">
            {(revisions||[]).some(r=>r.status==='approved')
              ? 'All revisions are approved.'
              : 'No revisions in progress — start one below.'}
          </p>
        )}

        {/* CTA — two buttons */}
        <div className="border-t border-surface-100 mt-auto pt-4 space-y-2">
          <button
            onClick={() => onNewCourseOutline()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-xl transition-colors"
          >
            <FileEdit size={13} /> New Course Revision
          </button>
          <button
            onClick={() => onNew()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold rounded-xl transition-colors"
          >
            <FileEdit size={13} /> New Program Revision
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function InstructorToolsPage() {
  const navigate = useNavigate()
  const [showWizard, setShowWizard]             = useState(false)
  const [showCommonSections, setShowCommonSections] = useState(false)
  const [showCollegeOutcomes, setShowCollegeOutcomes] = useState(false)
  const [activePanel, setActivePanel]           = useState(null)
  const [showProposal, setShowProposal]         = useState(false)
  const [editProposal, setEditProposal]         = useState(null)
  const { proposals, loading: proposalsLoading, refresh: refreshProposals } = useCourseProposals()
  const [showRevision, setShowRevision]         = useState(false)
  const [editRevision, setEditRevision]         = useState(null)
  const [showCourseOutlineRevision, setShowCourseOutlineRevision] = useState(false)
  const [editCourseOutlineRevision, setEditCourseOutlineRevision] = useState(null)
  const [showRevisionSettings, setShowRevisionSettings] = useState(false)
  const [fetchingRevision, setFetchingRevision] = useState(false)
  const { revisions, loading: revisionsLoading, refresh: refreshRevisions } = useProgramRevisions()
  const programSettings = useRevisionSettings()
  const [showEndDate, setShowEndDate]     = useState(false)
  const [editEndDate, setEditEndDate]     = useState(null)
  const { endDates, loading: endDatesLoading, refresh: refreshEndDates } = useCourseEndDates()

  // Opens the correct wizard with FULL data (fixes partial-data bug from list-only hook)
  async function handleOpenRevision(rev) {
    if (!rev?.revision_id) {
      setEditRevision(null); setShowRevision(true); return
    }
    setFetchingRevision(true)
    try {
      if (rev._type === 'course') {
        const { data } = await supabase
          .from('course_outline_revisions')
          .select('*')
          .eq('revision_id', rev.revision_id)
          .maybeSingle()
        setEditCourseOutlineRevision(data || rev)
        setShowCourseOutlineRevision(true)
      } else {
        const { data } = await supabase
          .from('program_revisions')
          .select('*')
          .eq('revision_id', rev.revision_id)
          .maybeSingle()
        setEditRevision(data || rev)
        setShowRevision(true)
      }
    } catch {
      // Fallback — open with whatever we have
      if (rev._type === 'course') { setEditCourseOutlineRevision(rev); setShowCourseOutlineRevision(true) }
      else                        { setEditRevision(rev);               setShowRevision(true) }
    } finally {
      setFetchingRevision(false)
    }
  }

  function handleOpen(key) {
    if (key === 'syllabus')               setShowWizard(true)
    else if (key === 'required-tools')    setActivePanel('required-tools')
    else if (key === 'new-course-proposal') { setEditProposal(null); setShowProposal(true) }
    else if (key === 'course-revision')      { setEditRevision(null); setShowRevision(true) }
    else if (key === 'program-planner')      { navigate('/program-planner') }
    else if (key === 'program-cost')         { navigate('/program-cost') }
    else if (key === 'course-outline-export'){ navigate('/course-outline-export') }
    else if (key === 'course-end-date')      { setEditEndDate(null); setShowEndDate(true) }
  }

  if (activePanel === 'required-tools') {
    return (
      <div className="max-w-5xl mx-auto">
        <RequiredToolsPanel onBack={() => setActivePanel(null)} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
            <GraduationCap size={22} className="text-brand-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-surface-900">Instructor Tools</h1>
            <p className="text-sm text-surface-500">Instructor-only utilities and resources</p>
          </div>
        </div>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {tiles.map(tile => (
          tile.key === 'new-course-proposal'
            ? <CourseProposalTile
                key={tile.key}
                tile={tile}
                proposals={proposals}
                loading={proposalsLoading}
                onOpen={(existing) => { setEditProposal(existing); setShowProposal(true) }}
                onNew={() => { setEditProposal(null); setShowProposal(true) }}
                onSettings={() => setShowCollegeOutcomes(true)}
              />
            : tile.key === 'course-revision'
            ? <CourseRevisionTile
                key={tile.key}
                tile={tile}
                revisions={revisions}
                loading={revisionsLoading || fetchingRevision}
                onOpen={(existing) => handleOpenRevision(existing)}
                onNew={() => { setEditRevision(null); setShowRevision(true) }}
                onNewCourseOutline={() => { setEditCourseOutlineRevision(null); setShowCourseOutlineRevision(true) }}
                onSettings={() => setShowRevisionSettings(true)}
              />
            : tile.key === 'course-end-date'
            ? <CourseEndDateTile
                key={tile.key}
                tile={tile}
                endDates={endDates}
                loading={endDatesLoading}
                onOpen={(existing) => { setEditEndDate(existing); setShowEndDate(true) }}
                onNew={() => { setEditEndDate(null); setShowEndDate(true) }}
              />
            : <Tile
                key={tile.key}
                tile={tile}
                onOpen={() => handleOpen(tile.key)}
                onSettings={() => {
                  if (tile.key === 'syllabus') setShowCommonSections(true)
                }}
              />
        ))}
      </div>

      {/* Footer note */}
      <div className="mt-8 space-y-2 text-center">
        <p className="text-xs text-surface-400 italic">This page is only visible to instructors.</p>
        <p className="text-xs text-surface-400 max-w-2xl mx-auto leading-relaxed">
          💡 All tools are connected — changes in one automatically update the others.
          For example, editing a material's price in the Syllabus Wizard instantly updates the
          Required Tools &amp; Materials catalog, and vice versa.
        </p>
      </div>

      {/* Modals */}
      {showWizard && <SyllabusWizard onClose={() => setShowWizard(false)} />}
      {showCommonSections && <CommonSectionsModal onClose={() => setShowCommonSections(false)} />}
      {showProposal && (
        <CourseProposalWizard
          initialData={editProposal}
          onClose={() => { setShowProposal(false); setEditProposal(null); refreshProposals() }}
        />
      )}
      {showCollegeOutcomes && <CollegeOutcomesModal onClose={() => setShowCollegeOutcomes(false)} />}
      {showRevision && (
        <ProgramRevisionWizard
          initialData={editRevision}
          programSettings={programSettings}
          onClose={() => { setShowRevision(false); setEditRevision(null); refreshRevisions() }}
        />
      )}
      {showCourseOutlineRevision && (
        <CourseOutlineRevisionWizard
          initialData={editCourseOutlineRevision}
          onClose={() => { setShowCourseOutlineRevision(false); setEditCourseOutlineRevision(null); refreshRevisions() }}
        />
      )}
      {showRevisionSettings && <ProgramRevisionSettingsModal onClose={() => setShowRevisionSettings(false)} />}
      {showEndDate && (
        <CourseEndDateWizard
          initialData={editEndDate}
          onClose={() => { setShowEndDate(false); setEditEndDate(null); refreshEndDates() }}
        />
      )}
    </div>
  )
}
