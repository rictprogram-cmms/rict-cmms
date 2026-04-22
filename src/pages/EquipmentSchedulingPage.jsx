import { useState, useMemo, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/hooks/usePermissions'
import { supabase } from '@/lib/supabase'
import {
  useAllEquipmentList,
  useAssetPickerData,
  useEquipmentManagement,
  useEquipmentBookingsData,
  useEquipmentBookingActions,
  useMyEquipmentBookings,
  useAllEquipmentBookings,
  useEquipmentStudentsList,
  formatMinutes,
  getWeekStart,
  formatDateKey,
} from '@/hooks/useEquipment'
import {
  Printer,
  CalendarDays,
  ClipboardList,
  Users,
  Settings2,
  Plus,
  X,
  Trash2,
  Edit2,
  Check,
  AlertTriangle,
  Wrench,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Info,
  Shield,
  ArrowLeftRight,
  UserIcon,
  Clock,
  CheckCircle2,
  XCircle,
  Search,
  ExternalLink,
  Package,
  MapPin,
  Tag,
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════

const BASE_TABS = [
  { id: 'schedule',    label: 'Schedule',     icon: CalendarDays },
  { id: 'mybookings',  label: 'My Bookings',  icon: ClipboardList },
]

const INSTRUCTOR_TABS = [
  { id: 'allbookings', label: 'All Bookings',     icon: Users },
  { id: 'manageequipment', label: 'Manage Equipment', icon: Settings2 },
]

export default function EquipmentSchedulingPage() {
  const { profile } = useAuth()
  const { hasPerm, permsLoading } = usePermissions('Equipment Scheduling')
  const canManageAll = hasPerm('manage_all_bookings')
  const canManageEquipment = hasPerm('manage_equipment')
  const isInstructorLike = canManageAll || canManageEquipment

  const [activeTab, setActiveTab] = useState('schedule')
  const tabs = useMemo(() => {
    const extra = []
    if (canManageAll) extra.push(INSTRUCTOR_TABS[0])
    if (canManageEquipment) extra.push(INSTRUCTOR_TABS[1])
    return [...BASE_TABS, ...extra]
  }, [canManageAll, canManageEquipment])

  if (permsLoading) {
    return (
      <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
        <Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" />
        <span className="sr-only">Loading permissions</span>
      </div>
    )
  }

  if (!hasPerm('view_page')) {
    return (
      <div className="p-6 bg-white rounded-xl border border-surface-200 text-center">
        <Shield size={32} className="mx-auto text-surface-400 mb-3" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-surface-900 mb-1">Access Denied</h1>
        <p className="text-sm text-surface-500">You do not have permission to access Equipment Scheduling.</p>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto">
      {/* Page heading — visible to all AT users */}
      <div className="mb-4">
        <h1 className="text-xl font-bold text-surface-900 flex items-center gap-2">
          <Printer size={22} className="text-brand-600" aria-hidden="true" />
          Equipment Scheduling
        </h1>
        <p className="text-sm text-surface-500 mt-1">
          Reserve 30-minute blocks on lab equipment during open lab hours.
        </p>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-1 mb-6 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Equipment Scheduling sections"
      >
        {tabs.map(tab => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              aria-controls={`panel-${tab.id}`}
              id={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${
                active
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-white text-surface-600 hover:bg-surface-50 border border-surface-200'
              }`}
            >
              <Icon size={16} aria-hidden="true" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab Panels */}
      <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'schedule'       && <ScheduleTab hasPerm={hasPerm} />}
        {activeTab === 'mybookings'     && <MyBookingsTab hasPerm={hasPerm} />}
        {activeTab === 'allbookings'    && canManageAll     && <AllBookingsTab />}
        {activeTab === 'manageequipment' && canManageEquipment && <ManageEquipmentTab />}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 1 — SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════

function ScheduleTab({ hasPerm }) {
  const { profile } = useAuth()
  const canBook = hasPerm('book_equipment')
  const canManageAll = hasPerm('manage_all_bookings')

  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => formatDateKey(new Date()))

  // Load visible days setting (same pattern as Lab Signup)
  const [visibleDays, setVisibleDays] = useState([1, 2, 3, 4])
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  useEffect(() => {
    async function loadSettings() {
      const { data } = await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .eq('setting_key', 'lab_visible_days')
        .maybeSingle()
      if (data?.setting_value) {
        try {
          const parsed = JSON.parse(data.setting_value)
          if (Array.isArray(parsed)) setVisibleDays(parsed.map(Number))
        } catch (e) {
          // Leave default
        }
      }
      setSettingsLoaded(true)
    }
    loadSettings()
  }, [])

  const { weeks, equipment, slots, days, loading, refresh } = useEquipmentBookingsData(
    weekStart,
    1,
    visibleDays
  )
  const { bookSlots, cancelBooking, updateBookingPurpose, reassignBooking, saving } = useEquipmentBookingActions()

  // Selection: { equipmentId, dateStr, startMinutes: Set<number> }
  const [selection, setSelection] = useState(null)
  const [purpose, setPurpose] = useState('')

  // Modal for editing an existing booking
  const [editBooking, setEditBooking] = useState(null)

  // When the selected day changes or week changes, clear selection
  useEffect(() => {
    setSelection(null)
    setPurpose('')
  }, [selectedDate, weekStart])

  const currentWeek = weeks[0]
  const currentDay = days[selectedDate]

  // Adjust selected date if it's not in visible days
  useEffect(() => {
    if (!currentWeek) return
    const found = currentWeek.days.find(d => d.date === selectedDate)
    if (!found && currentWeek.days.length > 0) {
      setSelectedDate(currentWeek.days[0].date)
    }
  }, [currentWeek, selectedDate])

  function prevWeek() {
    const ws = new Date(weekStart)
    ws.setDate(ws.getDate() - 7)
    setWeekStart(ws)
  }

  function nextWeek() {
    const ws = new Date(weekStart)
    ws.setDate(ws.getDate() + 7)
    setWeekStart(ws)
  }

  function handleSlotClick(slot) {
    if (!slot) return

    // Click own booking → open edit modal
    if (slot.state === 'mine' && slot.booking) {
      setEditBooking({
        bookingId: slot.booking.bookingId,
        equipmentId: slot.equipmentId,
        equipmentName: equipment.find(p => p.equipmentId === slot.equipmentId)?.name || slot.equipmentId,
        date: slot.date,
        startMin: slot.startMin,
        endMin: slot.endMin,
        purpose: slot.booking.purpose || '',
        userName: slot.booking.userName,
        userEmail: slot.booking.userEmail,
        isPast: slot.isPast,
        canEditPurpose: hasPerm('edit_own_booking'),
        canCancel: hasPerm('cancel_own_booking') && !slot.isPast,
        isInstructor: false,
      })
      return
    }

    // Instructor clicking anyone else's booking → manage modal
    if (slot.state === 'other' && canManageAll && slot.booking) {
      setEditBooking({
        bookingId: slot.booking.bookingId,
        equipmentId: slot.equipmentId,
        equipmentName: equipment.find(p => p.equipmentId === slot.equipmentId)?.name || slot.equipmentId,
        date: slot.date,
        startMin: slot.startMin,
        endMin: slot.endMin,
        purpose: slot.booking.purpose || '',
        userName: slot.booking.userName,
        userEmail: slot.booking.userEmail,
        isPast: slot.isPast,
        canEditPurpose: true,
        canCancel: !slot.isPast,
        canReassign: !slot.isPast,
        isInstructor: true,
      })
      return
    }

    // Available → add/remove from selection
    if (slot.state === 'available' && canBook) {
      setSelection(prev => {
        if (!prev || prev.equipmentId !== slot.equipmentId || prev.dateStr !== slot.date) {
          return { equipmentId: slot.equipmentId, dateStr: slot.date, startMinutes: new Set([slot.startMin]) }
        }
        const next = new Set(prev.startMinutes)
        if (next.has(slot.startMin)) next.delete(slot.startMin)
        else next.add(slot.startMin)
        if (next.size === 0) return null
        return { ...prev, startMinutes: next }
      })
    }
  }

  async function handleConfirmBooking() {
    if (!selection || selection.startMinutes.size === 0) return
    const sorted = Array.from(selection.startMinutes).sort((a, b) => a - b)
    const result = await bookSlots(selection.equipmentId, selection.dateStr, sorted, purpose)
    if (result.success) {
      setSelection(null)
      setPurpose('')
      refresh()
    }
  }

  function clearSelection() {
    setSelection(null)
    setPurpose('')
  }

  async function handleModalCancel(bookingId) {
    const result = await cancelBooking(bookingId)
    if (result.success) {
      setEditBooking(null)
      refresh()
    }
  }

  async function handleModalUpdatePurpose(bookingId, newPurpose) {
    const result = await updateBookingPurpose(bookingId, newPurpose)
    if (result.success) {
      setEditBooking(null)
      refresh()
    }
  }

  async function handleModalReassign(bookingId, newUser) {
    const result = await reassignBooking(bookingId, newUser)
    if (result.success) {
      setEditBooking(null)
      refresh()
    }
  }

  if (!settingsLoaded || loading) {
    return (
      <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
        <Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" />
        <span className="sr-only">Loading schedule</span>
      </div>
    )
  }

  if (equipment.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
        <Printer size={32} className="mx-auto text-surface-400 mb-3" aria-hidden="true" />
        <h2 className="text-base font-semibold text-surface-900 mb-1">No equipment available</h2>
        <p className="text-sm text-surface-500">
          {hasPerm('manage_equipment')
            ? 'Add equipment in the Manage Equipment tab to get started.'
            : 'No equipment has been set up yet. Please check back later or contact your instructor.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Week navigator */}
      <div className="bg-white rounded-xl border border-surface-200 p-4">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={prevWeek}
            className="p-2 rounded-lg text-surface-600 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Previous week"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <div className="text-sm font-semibold text-surface-900" aria-live="polite">
            {currentWeek?.weekTitle || '—'}
          </div>
          <button
            onClick={nextWeek}
            className="p-2 rounded-lg text-surface-600 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Next week"
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Day picker */}
      {currentWeek && currentWeek.days.length > 0 && (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${currentWeek.days.length}, minmax(0, 1fr))` }}
          role="tablist"
          aria-label="Days of the week"
        >
          {currentWeek.days.map(day => {
            const isSelected = day.date === selectedDate
            const isClosed = !day.isOpen
            const hasNotes = !!(day.notes || '').trim()
            return (
              <button
                key={day.date}
                role="tab"
                aria-selected={isSelected}
                aria-label={`${day.dayName} ${day.month}/${day.dayNum}, ${
                  isClosed ? `closed${hasNotes ? ': ' + day.notes : ''}` : `open ${formatHourShort(day.startHour)} to ${formatHourShort(day.endHour)}`
                }`}
                onClick={() => setSelectedDate(day.date)}
                className={`p-2.5 rounded-lg text-left border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                  isSelected
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : isClosed
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-surface-200 bg-white text-surface-900 hover:bg-surface-50'
                }`}
              >
                <div className={`text-[10px] font-semibold uppercase tracking-wide ${
                  isSelected ? 'text-white/85' : isClosed ? 'text-amber-700' : 'text-surface-500'
                }`}>
                  {day.dayShort}
                </div>
                <div className="text-base font-semibold mt-0.5">{day.dayNum}</div>
                <div className={`text-[10px] mt-0.5 ${
                  isSelected ? 'text-white/85' : isClosed ? 'text-amber-700' : 'text-surface-500'
                }`}>
                  {isClosed ? 'Closed' : `${formatHourShort(day.startHour)}–${formatHourShort(day.endHour)}`}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Day closed notice */}
      {currentDay && !currentDay.isOpen && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3" role="alert">
          <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-amber-900">Lab is closed this day</p>
            {currentDay.notes && (
              <p className="text-xs text-amber-700 mt-0.5">{currentDay.notes}</p>
            )}
          </div>
        </div>
      )}

      {/* Legend + Grid (only if day is open) */}
      {currentDay && currentDay.isOpen && (
        <>
          <Legend />
          <EquipmentGrid
            equipment={equipment}
            day={currentDay}
            slots={slots}
            selection={selection}
            onSlotClick={handleSlotClick}
            canBook={canBook}
            canManageAll={canManageAll}
          />

          {/* Selection summary / confirm */}
          {selection && selection.startMinutes.size > 0 && (
            <SelectionBar
              selection={selection}
              equipment={equipment}
              purpose={purpose}
              onPurposeChange={setPurpose}
              onClear={clearSelection}
              onConfirm={handleConfirmBooking}
              saving={saving}
            />
          )}
        </>
      )}

      {/* Edit booking modal */}
      {editBooking && (
        <EditBookingModal
          booking={editBooking}
          onClose={() => setEditBooking(null)}
          onCancelBooking={handleModalCancel}
          onUpdatePurpose={handleModalUpdatePurpose}
          onReassign={handleModalReassign}
          saving={saving}
        />
      )}
    </div>
  )
}

// ─── Legend ──────────────────────────────────────────────────────────────────

function Legend() {
  const items = [
    { label: 'Available',       swatch: { bg: '#ffffff', border: '#e2e8f0' } },
    { label: 'Selected',        swatch: { bg: '#1e4bbd', border: '#042c53' } },
    { label: 'My booking',      swatch: { bg: '#0f6e56', border: '#04342c' } },
    { label: 'Booked',          swatch: { bg: '#d3d1c7', border: '#888780' } },
    { label: 'Maintenance',     swatch: { bg: '#fac775', border: '#854f0b' } },
    { label: 'You are on other equipment', swatch: { bg: '#fbe9e8', border: '#c0392b' } },
    { label: 'Past',            swatch: { bg: '#f1efe8', border: '#b4b2a9', dashed: true } },
  ]
  return (
    <div
      className="flex flex-wrap gap-3 items-center px-3 py-2 bg-surface-50 rounded-lg text-xs text-surface-600"
      aria-label="Legend"
    >
      {items.map(item => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block w-3 h-3 rounded-sm"
            style={{
              background: item.swatch.bg,
              border: `1px ${item.swatch.dashed ? 'dashed' : 'solid'} ${item.swatch.border}`,
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}

// ─── Equipment Grid ────────────────────────────────────────────────────────────

function EquipmentGrid({ equipment, day, slots, selection, onSlotClick, canBook, canManageAll }) {
  // Build the 30-min slot list
  const slotMinutes = []
  for (let m = day.startMin; m < day.endMin; m += 30) slotMinutes.push(m)

  // Grid column count: time label (96px) + one col per equipment
  const gridTemplateColumns = `96px repeat(${equipment.length}, minmax(120px, 1fr))`

  return (
    <div
      className="bg-white rounded-xl border border-surface-200 overflow-hidden"
      role="grid"
      aria-label={`Equipment availability for ${day.dayName} ${day.month}/${day.dayNum}`}
    >
      {/* Header row */}
      <div
        role="row"
        style={{ display: 'grid', gridTemplateColumns }}
        className="bg-surface-50 border-b border-surface-200"
      >
        <div role="columnheader" className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-surface-500">
          Time
        </div>
        {equipment.map(p => (
          <div
            key={p.equipmentId}
            role="columnheader"
            className="px-3 py-2.5 border-l border-surface-200 text-sm"
          >
            <div className="font-semibold text-surface-900 leading-tight flex items-center gap-1.5">
              <span className="truncate">{p.name}</span>
              {p.status === 'Maintenance' && (
                <span title="In maintenance" className="inline-flex items-center flex-shrink-0">
                  <Wrench size={11} className="text-amber-600" aria-label="In maintenance" />
                </span>
              )}
            </div>
            {p.category && (
              <div className="text-[10px] text-surface-500 mt-0.5 leading-tight truncate">{p.category}</div>
            )}
            {p.location && (
              <div className="text-[10px] text-surface-400 leading-tight truncate">{p.location}</div>
            )}
          </div>
        ))}
      </div>

      {/* Data rows */}
      {slotMinutes.map(min => {
        return (
          <div
            key={min}
            role="row"
            style={{ display: 'grid', gridTemplateColumns }}
            className="border-b border-surface-100 last:border-b-0"
          >
            <div role="rowheader" className="px-3 py-1.5 text-xs text-surface-500 flex items-center">
              {formatMinutes(min)}
            </div>
            {equipment.map(p => {
              const key = `${day.date}_${min}_${p.equipmentId}`
              const slot = slots[key]
              const isSelected = !!(
                selection &&
                selection.equipmentId === p.equipmentId &&
                selection.dateStr === day.date &&
                selection.startMinutes.has(min)
              )
              return (
                <GridCell
                  key={key}
                  slot={slot}
                  isSelected={isSelected}
                  equipment={p}
                  onClick={() => onSlotClick(slot)}
                  canBook={canBook}
                  canManageAll={canManageAll}
                />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function GridCell({ slot, isSelected, equipment, onClick, canBook, canManageAll }) {
  if (!slot) {
    return <div role="gridcell" className="border-l border-surface-100 p-1" aria-hidden="true" />
  }

  const state = isSelected ? 'selected' : slot.state
  const timeRange = `${formatMinutes(slot.startMin)} to ${formatMinutes(slot.endMin)}`

  // Determine interactivity
  let interactive = false
  let ariaLabel = ''
  let styles = { bg: '#ffffff', border: '#e2e8f0', color: '#64748b' }
  let content = null

  switch (state) {
    case 'available':
      interactive = canBook
      ariaLabel = `Available, ${equipment.name}, ${timeRange}${interactive ? ', click to select' : ''}`
      styles = { bg: '#ffffff', border: '#e2e8f0', color: '#64748b' }
      content = <span aria-hidden="true" className="text-xs">+</span>
      break
    case 'selected':
      interactive = true
      ariaLabel = `Selected, ${equipment.name}, ${timeRange}, click to deselect`
      styles = { bg: '#1e4bbd', border: '#042c53', color: '#ffffff' }
      content = (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium">
          <Check size={11} aria-hidden="true" /> Selected
        </span>
      )
      break
    case 'mine':
      interactive = !slot.isPast  // in past means view-only; still clickable in future
      ariaLabel = slot.isPast
        ? `Your completed booking, ${equipment.name}, ${timeRange}`
        : `Your booking, ${equipment.name}, ${timeRange}, click to edit or cancel`
      // Future: full interactive green; past: muted green
      if (slot.isPast) {
        styles = { bg: '#d4eee3', border: '#6aa58f', color: '#04342c' }
      } else {
        styles = { bg: '#0f6e56', border: '#04342c', color: '#ffffff' }
        interactive = true
      }
      content = (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium truncate">
          <Check size={11} aria-hidden="true" className="flex-shrink-0" />
          <span className="truncate">My booking</span>
        </span>
      )
      break
    case 'other':
      interactive = canManageAll && !slot.isPast
      ariaLabel = `Booked by ${slot.booking?.userName || 'another user'}, ${equipment.name}, ${timeRange}${interactive ? ', click to manage' : ''}`
      styles = { bg: '#d3d1c7', border: '#888780', color: '#2c2c2a' }
      content = (
        <span className="inline-flex items-center gap-1 text-[11px] truncate">
          <UserIcon size={11} aria-hidden="true" className="flex-shrink-0" />
          <span className="truncate">{slot.booking?.userName || '—'}</span>
        </span>
      )
      break
    case 'conflict':
      interactive = false
      ariaLabel = `Not available — you have another booking at this time, ${equipment.name}, ${timeRange}`
      styles = { bg: '#fbe9e8', border: '#c0392b', color: '#7f2b1d' }
      content = (
        <span className="inline-flex items-center gap-1 text-[11px] truncate">
          <X size={11} aria-hidden="true" className="flex-shrink-0" />
          <span className="truncate">You're on another</span>
        </span>
      )
      break
    case 'maintenance':
      interactive = false
      ariaLabel = `Equipment in maintenance, ${equipment.name}, ${timeRange}`
      styles = { bg: '#fac775', border: '#854f0b', color: '#412402' }
      content = (
        <span className="inline-flex items-center gap-1 text-[11px] truncate">
          <Wrench size={11} aria-hidden="true" className="flex-shrink-0" />
          <span className="truncate">Maintenance</span>
        </span>
      )
      break
    case 'past':
      interactive = false
      ariaLabel = `Past, ${equipment.name}, ${timeRange}`
      styles = { bg: '#f1efe8', border: '#b4b2a9', color: '#888780' }
      content = <span aria-hidden="true" className="text-[10px]">—</span>
      break
    default:
      ariaLabel = `Unavailable, ${equipment.name}, ${timeRange}`
      break
  }

  const commonClasses =
    'm-1 rounded px-2 py-1.5 text-left flex items-center justify-center min-h-[30px] border transition-colors'
  const focusClasses =
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1'
  const inlineStyle = { background: styles.bg, borderColor: styles.border, color: styles.color }
  const borderLeftWrapStyle = { borderLeftStyle: 'solid', borderLeftWidth: '1px', borderLeftColor: '#e2e8f0' }

  if (interactive) {
    return (
      <div role="gridcell" className="border-l border-surface-100" style={borderLeftWrapStyle}>
        <button
          onClick={onClick}
          className={`${commonClasses} ${focusClasses} w-[calc(100%-8px)] cursor-pointer hover:brightness-95`}
          style={inlineStyle}
          aria-label={ariaLabel}
        >
          {content}
        </button>
      </div>
    )
  }

  return (
    <div
      role="gridcell"
      className="border-l border-surface-100"
      style={borderLeftWrapStyle}
      aria-label={ariaLabel}
    >
      <div
        className={`${commonClasses} w-[calc(100%-8px)] opacity-90`}
        style={inlineStyle}
        aria-hidden="true"
      >
        {content}
      </div>
    </div>
  )
}

// ─── Selection Bar ───────────────────────────────────────────────────────────

function SelectionBar({ selection, equipment, purpose, onPurposeChange, onClear, onConfirm, saving }) {
  const eq = equipment.find(p => p.equipmentId === selection.equipmentId)
  const sorted = Array.from(selection.startMinutes).sort((a, b) => a - b)
  const totalMin = sorted.length * 30

  // Friendly summary: group consecutive runs
  const runs = []
  let currentRun = null
  sorted.forEach(m => {
    if (currentRun && m === currentRun.end) {
      currentRun.end = m + 30
    } else {
      if (currentRun) runs.push(currentRun)
      currentRun = { start: m, end: m + 30 }
    }
  })
  if (currentRun) runs.push(currentRun)
  const runLabels = runs
    .map(r => `${formatMinutes(r.start)}–${formatMinutes(r.end)}`)
    .join(', ')

  const [parts] = (selection.dateStr || '').split('-').length === 3
    ? [selection.dateStr.split('-')]
    : [[]]
  const dt = parts.length === 3
    ? new Date(+parts[0], +parts[1] - 1, +parts[2])
    : new Date(selection.dateStr + 'T00:00:00')
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dayLabel = `${dayNames[dt.getDay()]} ${monthNames[dt.getMonth()]} ${dt.getDate()}`

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: '#e6f1fb', border: '1px solid #85b7eb' }}
      role="region"
      aria-label="Current booking selection"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold" style={{ color: '#042c53' }}>
            {sorted.length} slot{sorted.length !== 1 ? 's' : ''} selected on {eq?.name || selection.equipmentId}
          </div>
          <div className="text-xs mt-1" style={{ color: '#0c447c' }}>
            {dayLabel} · {runLabels} · {totalMin >= 60 ? `${Math.floor(totalMin / 60)}h ${totalMin % 60 ? (totalMin % 60) + 'm' : ''}`.trim() : `${totalMin}m`}
          </div>
        </div>
        <button
          onClick={onClear}
          className="text-xs font-medium px-2 py-1 rounded border focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          style={{ borderColor: '#85b7eb', color: '#0c447c', background: 'transparent' }}
          aria-label="Clear selection"
        >
          Clear
        </button>
      </div>

      <label htmlFor="booking-purpose" className="text-xs font-medium block mb-1" style={{ color: '#0c447c' }}>
        What are you printing? (optional)
      </label>
      <input
        id="booking-purpose"
        type="text"
        value={purpose}
        onChange={e => onPurposeChange(e.target.value)}
        placeholder="e.g., robot chassis brackets"
        maxLength={200}
        className="w-full px-3 py-2 text-sm rounded-lg bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        style={{ border: '1px solid #85b7eb' }}
      />

      <div className="flex gap-2 mt-3 justify-end">
        <button
          onClick={onClear}
          className="px-3 py-2 text-sm font-medium rounded-lg border border-surface-300 text-surface-700 hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={saving || sorted.length === 0}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 inline-flex items-center gap-2"
        >
          {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          Confirm booking
        </button>
      </div>
    </div>
  )
}

// ─── Edit Booking Modal ──────────────────────────────────────────────────────

function EditBookingModal({ booking, onClose, onCancelBooking, onUpdatePurpose, onReassign, saving }) {
  const [purpose, setPurpose] = useState(booking.purpose || '')
  const [showConfirmCancel, setShowConfirmCancel] = useState(false)
  const [reassigning, setReassigning] = useState(false)
  const [selectedUser, setSelectedUser] = useState(null)
  const { students, loading: studentsLoading } = useEquipmentStudentsList()
  const modalRef = useRef(null)
  const firstFocusRef = useRef(null)

  // Focus trap: focus first input when modal opens + ESC to close
  useEffect(() => {
    firstFocusRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const parts = (booking.date || '').split('-')
  const dt = parts.length === 3
    ? new Date(+parts[0], +parts[1] - 1, +parts[2])
    : new Date(booking.date + 'T00:00:00')
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const dateLabel = `${dayNames[dt.getDay()]}, ${monthNames[dt.getMonth()]} ${dt.getDate()}`

  const purposeChanged = purpose.trim() !== (booking.purpose || '').trim()

  async function handleSave() {
    if (purposeChanged) {
      await onUpdatePurpose(booking.bookingId, purpose)
    } else {
      onClose()
    }
  }

  async function handleReassignConfirm() {
    if (!selectedUser) return
    await onReassign(booking.bookingId, selectedUser)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-booking-title"
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={modalRef}
        className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-surface-200">
          <div>
            <h2 id="edit-booking-title" className="text-base font-semibold text-surface-900">
              {booking.isInstructor ? 'Manage Booking' : 'Your Booking'}
            </h2>
            <p className="text-xs text-surface-500 mt-0.5">{booking.bookingId}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Details */}
          <div className="bg-surface-50 rounded-lg p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <Printer size={14} className="text-surface-400" aria-hidden="true" />
              <span className="font-medium text-surface-900">{booking.equipmentName}</span>
            </div>
            <div className="flex items-center gap-2 text-surface-700">
              <CalendarDays size={14} className="text-surface-400" aria-hidden="true" />
              {dateLabel}
            </div>
            <div className="flex items-center gap-2 text-surface-700">
              <Clock size={14} className="text-surface-400" aria-hidden="true" />
              {formatMinutes(booking.startMin)} – {formatMinutes(booking.endMin)}
            </div>
            {booking.isInstructor && (
              <div className="flex items-center gap-2 text-surface-700">
                <UserIcon size={14} className="text-surface-400" aria-hidden="true" />
                {booking.userName} ({booking.userEmail})
              </div>
            )}
          </div>

          {booking.isPast && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
              <Info size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
              <span>This slot has already started. Some actions are unavailable.</span>
            </div>
          )}

          {/* Purpose */}
          <div>
            <label htmlFor="edit-purpose" className="text-xs font-medium text-surface-700 block mb-1">
              Purpose
            </label>
            <input
              id="edit-purpose"
              ref={firstFocusRef}
              type="text"
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              disabled={!booking.canEditPurpose}
              placeholder="What are you printing?"
              maxLength={200}
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:bg-surface-50 disabled:text-surface-500"
            />
          </div>

          {/* Reassign (instructor only) */}
          {booking.isInstructor && booking.canReassign && (
            <div>
              {!reassigning ? (
                <button
                  onClick={() => setReassigning(true)}
                  className="inline-flex items-center gap-2 text-xs text-brand-600 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded px-1"
                >
                  <ArrowLeftRight size={12} aria-hidden="true" />
                  Reassign to another user
                </button>
              ) : (
                <div className="bg-surface-50 rounded-lg p-3 border border-surface-200">
                  <label htmlFor="reassign-select" className="text-xs font-medium text-surface-700 block mb-1">
                    Reassign to
                  </label>
                  <select
                    id="reassign-select"
                    value={selectedUser?.email || ''}
                    onChange={e => {
                      const s = students.find(x => x.email === e.target.value)
                      setSelectedUser(s || null)
                    }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    disabled={studentsLoading}
                  >
                    <option value="">{studentsLoading ? 'Loading…' : 'Select a student'}</option>
                    {students.map(s => (
                      <option key={s.email} value={s.email}>{s.displayName}</option>
                    ))}
                  </select>
                  <div className="flex gap-2 mt-2 justify-end">
                    <button
                      onClick={() => { setReassigning(false); setSelectedUser(null) }}
                      className="px-2 py-1 text-xs font-medium rounded border border-surface-300 text-surface-600 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleReassignConfirm}
                      disabled={!selectedUser || saving}
                      className="px-3 py-1 text-xs font-medium rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                    >
                      Reassign
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Cancel booking */}
          {booking.canCancel && (
            <div className="border-t border-surface-200 pt-4">
              {!showConfirmCancel ? (
                <button
                  onClick={() => setShowConfirmCancel(true)}
                  className="inline-flex items-center gap-2 text-sm text-red-600 hover:text-red-700 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 rounded px-1"
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Cancel this booking
                </button>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm font-medium text-red-900 mb-2">Cancel this booking?</p>
                  <p className="text-xs text-red-700 mb-3">
                    This frees up the slot for others. This action can't be undone.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setShowConfirmCancel(false)}
                      className="px-3 py-1.5 text-xs font-medium rounded border border-surface-300 text-surface-700 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Keep booking
                    </button>
                    <button
                      onClick={() => onCancelBooking(booking.bookingId)}
                      disabled={saving}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 inline-flex items-center gap-1.5"
                    >
                      {saving && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                      Yes, cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm font-medium rounded-lg border border-surface-300 text-surface-700 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Close
          </button>
          {booking.canEditPurpose && purposeChanged && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 inline-flex items-center gap-2"
            >
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 2 — MY BOOKINGS
// ═══════════════════════════════════════════════════════════════════════════

function MyBookingsTab({ hasPerm }) {
  const canCancel = hasPerm('cancel_own_booking')
  const canEdit = hasPerm('edit_own_booking')
  const { bookings, loading, refresh } = useMyEquipmentBookings()
  const { cancelBooking, updateBookingPurpose, saving } = useEquipmentBookingActions()
  const [editBooking, setEditBooking] = useState(null)

  async function handleCancel(bookingId) {
    const result = await cancelBooking(bookingId)
    if (result.success) {
      setEditBooking(null)
      refresh()
    }
  }

  async function handleUpdatePurpose(bookingId, purpose) {
    const result = await updateBookingPurpose(bookingId, purpose)
    if (result.success) {
      setEditBooking(null)
      refresh()
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
        <Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" />
        <span className="sr-only">Loading your bookings</span>
      </div>
    )
  }

  if (bookings.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
        <ClipboardList size={32} className="mx-auto text-surface-400 mb-3" aria-hidden="true" />
        <h2 className="text-base font-semibold text-surface-900 mb-1">No upcoming bookings</h2>
        <p className="text-sm text-surface-500">Head over to the Schedule tab to book some equipment time.</p>
      </div>
    )
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
        <table className="w-full text-sm" aria-label="Your upcoming equipment bookings">
          <caption className="sr-only">Your upcoming equipment bookings</caption>
          <thead className="bg-surface-50 border-b border-surface-200">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Date</th>
              <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Time</th>
              <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Equipment</th>
              <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Purpose</th>
              <th scope="col" className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-surface-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map(b => (
              <tr key={b.bookingId} className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50">
                <td className="px-4 py-2.5 text-surface-900">{b.dateDisplay}</td>
                <td className="px-4 py-2.5 text-surface-700">
                  {b.startTimeDisplay} – {b.endTimeDisplay}
                  <span className="text-[10px] text-surface-400 ml-2">
                    ({b.durationMinutes >= 60 ? `${Math.floor(b.durationMinutes / 60)}h${b.durationMinutes % 60 ? ' ' + (b.durationMinutes % 60) + 'm' : ''}` : `${b.durationMinutes}m`})
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="text-surface-900">{b.equipmentName}</div>
                  {(b.equipmentCategory || b.equipmentLocation) && (
                    <div className="text-[10px] text-surface-500">
                      {[b.equipmentCategory, b.equipmentLocation].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-surface-600">{b.purpose || <span className="text-surface-400 italic">—</span>}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex gap-1 justify-end">
                    {canEdit && (
                      <button
                        onClick={() => setEditBooking({
                          bookingId: b.bookingId,
                          equipmentId: b.equipmentId,
                          equipmentName: b.equipmentName,
                          date: b.dateRaw,
                          startMin: b.startMin,
                          endMin: b.endMin,
                          purpose: b.purpose,
                          userName: '',
                          userEmail: '',
                          isPast: false,
                          canEditPurpose: canEdit,
                          canCancel: canCancel,
                          isInstructor: false,
                        })}
                        className="p-1.5 rounded text-surface-500 hover:text-brand-600 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                        aria-label={`Edit booking on ${b.equipmentName}, ${b.dateDisplay}, ${b.startTimeDisplay}`}
                      >
                        <Edit2 size={14} aria-hidden="true" />
                      </button>
                    )}
                    {canCancel && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Cancel ${b.dateDisplay} ${b.startTimeDisplay} on ${b.equipmentName}?`)) {
                            handleCancel(b.bookingId)
                          }
                        }}
                        disabled={saving}
                        className="p-1.5 rounded text-surface-500 hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-60"
                        aria-label={`Cancel booking on ${b.equipmentName}, ${b.dateDisplay}, ${b.startTimeDisplay}`}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editBooking && (
        <EditBookingModal
          booking={editBooking}
          onClose={() => setEditBooking(null)}
          onCancelBooking={handleCancel}
          onUpdatePurpose={handleUpdatePurpose}
          onReassign={() => {}}
          saving={saving}
        />
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 3 — ALL BOOKINGS (Instructor)
// ═══════════════════════════════════════════════════════════════════════════

function AllBookingsTab() {
  const [dateStr, setDateStr] = useState(() => formatDateKey(new Date()))
  const { bookings, loading, refresh } = useAllEquipmentBookings(dateStr)
  const { cancelBooking, updateBookingPurpose, reassignBooking, saving } = useEquipmentBookingActions()
  const [editBooking, setEditBooking] = useState(null)

  async function handleCancel(bookingId) {
    const result = await cancelBooking(bookingId)
    if (result.success) { setEditBooking(null); refresh() }
  }

  async function handleUpdatePurpose(bookingId, purpose) {
    const result = await updateBookingPurpose(bookingId, purpose)
    if (result.success) { setEditBooking(null); refresh() }
  }

  async function handleReassign(bookingId, newUser) {
    const result = await reassignBooking(bookingId, newUser)
    if (result.success) { setEditBooking(null); refresh() }
  }

  const parts = dateStr.split('-')
  const dt = parts.length === 3
    ? new Date(+parts[0], +parts[1] - 1, +parts[2])
    : new Date(dateStr + 'T00:00:00')
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const dateLabel = `${dayNames[dt.getDay()]}, ${monthNames[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`

  return (
    <>
      {/* Date picker */}
      <div className="bg-white rounded-xl border border-surface-200 p-4 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="all-bookings-date" className="text-sm font-medium text-surface-700">
            Date:
          </label>
          <input
            id="all-bookings-date"
            type="date"
            value={dateStr}
            onChange={e => setDateStr(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-surface-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
          <div className="text-sm text-surface-500" aria-live="polite">{dateLabel}</div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" />
          <span className="sr-only">Loading bookings</span>
        </div>
      ) : bookings.length === 0 ? (
        <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
          <Users size={32} className="mx-auto text-surface-400 mb-3" aria-hidden="true" />
          <p className="text-sm text-surface-500">No bookings on {dateLabel}.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
          <table className="w-full text-sm" aria-label={`All equipment bookings for ${dateLabel}`}>
            <caption className="sr-only">All equipment bookings for {dateLabel}</caption>
            <thead className="bg-surface-50 border-b border-surface-200">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Time</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Equipment</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">User</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Purpose</th>
                <th scope="col" className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-surface-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map(b => (
                <tr key={b.bookingId} className="border-b border-surface-100 last:border-b-0 hover:bg-surface-50">
                  <td className="px-4 py-2.5 text-surface-900 whitespace-nowrap">
                    {b.startTimeDisplay} – {b.endTimeDisplay}
                  </td>
                  <td className="px-4 py-2.5 text-surface-700">{b.equipmentName}</td>
                  <td className="px-4 py-2.5">
                    <div className="text-surface-900">{b.userName}</div>
                    <div className="text-[10px] text-surface-500">{b.userEmail}</div>
                  </td>
                  <td className="px-4 py-2.5 text-surface-600">{b.purpose || <span className="text-surface-400 italic">—</span>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => setEditBooking({
                        bookingId: b.bookingId,
                        equipmentId: b.equipmentId,
                        equipmentName: b.equipmentName,
                        date: dateStr,
                        startMin: b.startMin,
                        endMin: b.endMin,
                        purpose: b.purpose,
                        userName: b.userName,
                        userEmail: b.userEmail,
                        isPast: false,
                        canEditPurpose: true,
                        canCancel: true,
                        canReassign: true,
                        isInstructor: true,
                      })}
                      className="p-1.5 rounded text-surface-500 hover:text-brand-600 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                      aria-label={`Manage booking for ${b.userName} on ${b.equipmentName} at ${b.startTimeDisplay}`}
                    >
                      <Edit2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editBooking && (
        <EditBookingModal
          booking={editBooking}
          onClose={() => setEditBooking(null)}
          onCancelBooking={handleCancel}
          onUpdatePurpose={handleUpdatePurpose}
          onReassign={handleReassign}
          saving={saving}
        />
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 4 — MANAGE EQUIPMENT (Instructor)
// ═══════════════════════════════════════════════════════════════════════════

function ManageEquipmentTab() {
  const { equipment, loading, refresh } = useAllEquipmentList()
  const { addEquipment, updateEquipment, retireEquipment, saving } = useEquipmentManagement()
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null) // existing equipment row

  async function handleAdd({ assetId, status, notes }) {
    const result = await addEquipment({ assetId, status, notes })
    if (result.success) { setShowAdd(false); refresh() }
  }

  async function handleUpdate({ status, notes }) {
    const result = await updateEquipment(editing.equipmentId, { status, notes })
    if (result.success) { setEditing(null); refresh() }
  }

  async function handleRetire(equipmentId, name) {
    if (!window.confirm(`Retire ${name}? It will be hidden from scheduling but existing bookings remain.`)) return
    const result = await retireEquipment(equipmentId)
    if (result.success) refresh()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
        <Loader2 size={24} className="animate-spin text-brand-600" aria-hidden="true" />
        <span className="sr-only">Loading equipment</span>
      </div>
    )
  }

  return (
    <>
      {/* Header with Add button */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-surface-900">Equipment ({equipment.length})</h2>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          <Plus size={14} aria-hidden="true" />
          Add equipment
        </button>
      </div>

      {equipment.length === 0 ? (
        <div className="bg-white rounded-xl border border-surface-200 p-8 text-center">
          <Printer size={32} className="mx-auto text-surface-400 mb-3" aria-hidden="true" />
          <p className="text-sm text-surface-500">No equipment yet. Click "Add equipment" and pick an asset from the list.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-surface-200 overflow-hidden">
          <table className="w-full text-sm" aria-label="All bookable equipment">
            <caption className="sr-only">All bookable equipment linked to assets</caption>
            <thead className="bg-surface-50 border-b border-surface-200">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Asset</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Category</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Location</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Scheduling</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-surface-500">Asset Status</th>
                <th scope="col" className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-surface-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {equipment.map(p => {
                const assetRetired = p.assetStatus === 'Retired'
                return (
                  <tr key={p.equipmentId} className={`border-b border-surface-100 last:border-b-0 hover:bg-surface-50 ${p.status === 'Retired' ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2.5">
                      <div className="text-surface-900 font-medium">{p.name}</div>
                      <div className="text-[10px] text-surface-500">
                        {p.equipmentId} · linked to{' '}
                        <Link to="/assets" className="text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded">
                          {p.assetId}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-surface-700">{p.category || <span className="text-surface-400 italic">—</span>}</td>
                    <td className="px-4 py-2.5 text-surface-700">{p.location || <span className="text-surface-400 italic">—</span>}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <AssetStatusBadge status={p.assetStatus} warn={assetRetired} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex gap-1 justify-end">
                        <button
                          onClick={() => setEditing(p)}
                          className="p-1.5 rounded text-surface-500 hover:text-brand-600 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                          aria-label={`Edit ${p.name}`}
                        >
                          <Edit2 size={14} aria-hidden="true" />
                        </button>
                        {p.status !== 'Retired' && (
                          <button
                            onClick={() => handleRetire(p.equipmentId, p.name)}
                            disabled={saving}
                            className="p-1.5 rounded text-surface-500 hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-60"
                            aria-label={`Retire ${p.name}`}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal (asset picker) */}
      {showAdd && (
        <AddEquipmentModal
          onClose={() => setShowAdd(false)}
          onAdd={handleAdd}
          saving={saving}
        />
      )}

      {/* Edit modal (status + notes) */}
      {editing && (
        <EditEquipmentModal
          equipment={editing}
          onClose={() => setEditing(null)}
          onSave={handleUpdate}
          saving={saving}
        />
      )}
    </>
  )
}

function StatusBadge({ status }) {
  const styles = {
    Active:      { bg: '#dcfce7', color: '#166534', border: '#86efac' },
    Maintenance: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
    Retired:     { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' },
  }[status] || { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' }

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ background: styles.bg, color: styles.color, border: `1px solid ${styles.border}` }}
    >
      {status === 'Active' && <CheckCircle2 size={10} aria-hidden="true" />}
      {status === 'Maintenance' && <Wrench size={10} aria-hidden="true" />}
      {status === 'Retired' && <XCircle size={10} aria-hidden="true" />}
      {status}
    </span>
  )
}

function AssetStatusBadge({ status, warn }) {
  const styles = warn
    ? { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' }
    : { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' }

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
      style={{ background: styles.bg, color: styles.color, border: `1px solid ${styles.border}` }}
      title={warn ? 'Asset is retired — equipment will not appear in student schedule' : undefined}
    >
      {warn && <AlertTriangle size={10} aria-hidden="true" />}
      {status || 'Unknown'}
    </span>
  )
}

// ─── Add Equipment Modal (Asset Picker) ──────────────────────────────────────

function AddEquipmentModal({ onClose, onAdd, saving }) {
  const { assets, usedAssetIds, loading: assetsLoading } = useAssetPickerData()
  const [search, setSearch] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState(null)
  const [status, setStatus] = useState('Active')
  const [notes, setNotes] = useState('')
  const searchRef = useRef(null)

  useEffect(() => {
    searchRef.current?.focus()
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return assets
    return assets.filter(a => (
      (a.name || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.category || '').toLowerCase().includes(q) ||
      (a.location || '').toLowerCase().includes(q) ||
      (a.asset_id || '').toLowerCase().includes(q)
    ))
  }, [assets, search])

  const selectedAsset = assets.find(a => a.asset_id === selectedAssetId)

  function handleSubmit() {
    if (!selectedAssetId) return
    onAdd({ assetId: selectedAssetId, status, notes })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-equipment-title"
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-surface-200 flex-shrink-0">
          <div>
            <h2 id="add-equipment-title" className="text-base font-semibold text-surface-900">
              Add Equipment
            </h2>
            <p className="text-xs text-surface-500 mt-0.5">
              Pick an asset to make bookable. Details stay in sync with the Assets page.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-surface-200 flex-shrink-0">
          <label htmlFor="asset-search" className="sr-only">Search assets</label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" aria-hidden="true" />
            <input
              id="asset-search"
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, category, location, description, ID…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-surface-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            />
          </div>
        </div>

        {/* Asset list */}
        <div className="flex-1 overflow-y-auto p-2" role="listbox" aria-label="Available assets">
          {assetsLoading ? (
            <div className="flex items-center justify-center py-10" role="status" aria-live="polite">
              <Loader2 size={20} className="animate-spin text-brand-600" aria-hidden="true" />
              <span className="sr-only">Loading assets</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-sm text-surface-500">
              {search ? `No assets match "${search}"` : 'No assets available'}
            </div>
          ) : (
            filtered.map(a => {
              const alreadyUsed = usedAssetIds.has(a.asset_id)
              const isSelected = selectedAssetId === a.asset_id
              return (
                <button
                  key={a.asset_id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={alreadyUsed}
                  disabled={alreadyUsed}
                  onClick={() => !alreadyUsed && setSelectedAssetId(a.asset_id)}
                  className={`w-full text-left rounded-lg p-3 mb-1.5 border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                    isSelected
                      ? 'border-brand-600 bg-brand-50'
                      : alreadyUsed
                        ? 'border-surface-200 bg-surface-50 opacity-60 cursor-not-allowed'
                        : 'border-surface-200 bg-white hover:border-surface-300 hover:bg-surface-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-surface-900 truncate">{a.name}</span>
                        {alreadyUsed && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-200 text-surface-600 flex-shrink-0">
                            Already added
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-surface-500 flex-wrap">
                        {a.category && (
                          <span className="inline-flex items-center gap-0.5">
                            <Tag size={10} aria-hidden="true" />
                            {a.category}
                          </span>
                        )}
                        {a.location && (
                          <span className="inline-flex items-center gap-0.5">
                            <MapPin size={10} aria-hidden="true" />
                            {a.location}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-0.5 font-mono">
                          <Package size={10} aria-hidden="true" />
                          {a.asset_id}
                        </span>
                      </div>
                      {a.description && (
                        <p className="text-[11px] text-surface-600 mt-1 line-clamp-2">{a.description}</p>
                      )}
                    </div>
                    {isSelected && (
                      <div className="flex-shrink-0">
                        <Check size={18} className="text-brand-600" aria-label="Selected" />
                      </div>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Selection footer */}
        {selectedAsset && (
          <div className="p-4 border-t border-surface-200 bg-surface-50 flex-shrink-0 space-y-3">
            <div className="text-xs font-medium text-surface-700">
              Selected: <span className="font-semibold">{selectedAsset.name}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="add-status" className="text-xs font-medium text-surface-700 block mb-1">
                  Scheduling status
                </label>
                <select
                  id="add-status"
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  <option value="Active">Active — available for booking</option>
                  <option value="Maintenance">Maintenance — visible but not bookable</option>
                </select>
              </div>

              <div>
                <label htmlFor="add-notes" className="text-xs font-medium text-surface-700 block mb-1">
                  Scheduler notes (optional)
                </label>
                <input
                  id="add-notes"
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  maxLength={200}
                  placeholder="e.g., calibration quirks"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                />
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm font-medium rounded-lg border border-surface-300 text-surface-700 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!selectedAssetId || saving}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 inline-flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Add equipment
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Edit Equipment Modal (status + notes only) ──────────────────────────────

function EditEquipmentModal({ equipment, onClose, onSave, saving }) {
  const [status, setStatus] = useState(equipment.status)
  const [notes, setNotes] = useState(equipment.notes || '')
  const firstFocusRef = useRef(null)

  useEffect(() => {
    firstFocusRef.current?.focus()
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit() {
    onSave({ status, notes })
  }

  const assetRetired = equipment.assetStatus === 'Retired'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-equipment-title"
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-surface-200">
          <div>
            <h2 id="edit-equipment-title" className="text-base font-semibold text-surface-900">
              Edit Equipment
            </h2>
            <p className="text-xs text-surface-500 mt-0.5">{equipment.equipmentId}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-surface-400 hover:bg-surface-100 hover:text-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Read-only asset summary */}
          <div className="bg-surface-50 rounded-lg p-3 text-sm space-y-1 border border-surface-200">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-surface-900">{equipment.name}</span>
              <Link
                to="/assets"
                className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded px-1"
              >
                Edit asset <ExternalLink size={10} aria-hidden="true" />
              </Link>
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-surface-500">
              {equipment.category && (
                <span className="inline-flex items-center gap-0.5"><Tag size={10} aria-hidden="true" /> {equipment.category}</span>
              )}
              {equipment.location && (
                <span className="inline-flex items-center gap-0.5"><MapPin size={10} aria-hidden="true" /> {equipment.location}</span>
              )}
              <span className="inline-flex items-center gap-0.5 font-mono"><Package size={10} aria-hidden="true" /> {equipment.assetId}</span>
            </div>
          </div>

          {assetRetired && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2" role="alert">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
              <span>The linked asset is Retired. This equipment won't appear in the student schedule until the asset is re-activated on the Assets page.</span>
            </div>
          )}

          <div>
            <label htmlFor="edit-eq-status" className="text-xs font-medium text-surface-700 block mb-1">
              Scheduling status
            </label>
            <select
              id="edit-eq-status"
              ref={firstFocusRef}
              value={status}
              onChange={e => setStatus(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <option value="Active">Active — available for booking</option>
              <option value="Maintenance">Maintenance — visible but not bookable</option>
              <option value="Retired">Retired — hidden from students</option>
            </select>
            <p className="text-[11px] text-surface-500 mt-1">
              This only affects booking. Asset lifecycle status lives on the Assets page.
            </p>
          </div>

          <div>
            <label htmlFor="edit-eq-notes" className="text-xs font-medium text-surface-700 block mb-1">
              Scheduler notes (optional)
            </label>
            <textarea
              id="edit-eq-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Optional — e.g., filament preferences, booking reminders"
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-surface-200 bg-surface-50">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm font-medium rounded-lg border border-surface-300 text-surface-700 hover:bg-surface-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 inline-flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Save changes
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Small local helper
// ═══════════════════════════════════════════════════════════════════════════

function formatHourShort(hour) {
  const h = hour % 12 || 12
  const ampm = hour >= 12 ? 'p' : 'a'
  return `${h}${ampm}`
}
