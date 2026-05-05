import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import {
  formatDateKey,
  getHourFromTime,
  getWeekStart,
  normalizeClosedBlocks,
  findOverlappingClosure,
} from '@/hooks/useLabSignup'
import {
  generateSafeEquipmentId,
  generateSafeEquipmentBookingId,
} from '@/utils/generateSafeEquipmentIds'

// ─── Time helpers (30-min granularity) ───────────────────────────────────────

/**
 * Parse 'HH:MM' or 'HH:MM:SS' into minute-of-day. Also accepts '8:30 AM' etc.
 * Returns null if unparseable.
 */
export function timeStrToMinutes(timeStr) {
  if (!timeStr) return null
  if (typeof timeStr !== 'string') return null

  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})/)
  if (match24) return parseInt(match24[1], 10) * 60 + parseInt(match24[2], 10)

  const matchAmPm = timeStr.toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/)
  if (matchAmPm) {
    let h = parseInt(matchAmPm[1], 10)
    const m = parseInt(matchAmPm[2], 10)
    const ap = matchAmPm[3]
    if (ap === 'PM' && h !== 12) h += 12
    if (ap === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  return null
}

export function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

export function formatMinutes(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const dispH = h % 12 || 12
  return `${dispH}:${String(m).padStart(2, '0')} ${ampm}`
}

/** Build slotKey for the grid: `${dateStr}_${startMin}` */
export function slotKey(dateStr, startMin) {
  return `${dateStr}_${startMin}`
}

/** Internal: map a raw lab_equipment row + joined assets into our flat shape. */
function mapEquipmentRow(row) {
  const a = row.assets || {}
  return {
    equipmentId: row.equipment_id,
    assetId: row.asset_id,
    status: row.status,                  // scheduling status (Active/Maintenance/Retired)
    notes: row.notes || '',
    // Flattened from assets
    name: a.name || '(asset missing)',
    description: a.description || '',
    category: a.category || '',
    location: a.location || '',
    imageUrl: a.image_url || '',
    assetStatus: a.status || 'Unknown',  // asset-side lifecycle status
    // Metadata
    createdAt: row.created_at,
    createdBy: row.created_by || '',
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || '',
  }
}

// ─── Equipment List (Schedule-grid visible set) ──────────────────────────────

/**
 * Returns equipment for the student-facing schedule: Active scheduling status
 * AND the linked asset is not Retired. Realtime-subscribed.
 */
export function useEquipmentList() {
  const [equipment, setEquipment] = useState([])
  const [loading, setLoading] = useState(true)
  const hasLoadedRef = useRef(false)

  const fetch = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
    const { data, error } = await supabase
      .from('lab_equipment')
      .select('*, assets:asset_id (name, description, category, location, status, image_url)')
      .neq('status', 'Retired')

    if (error) {
      console.error('Error loading equipment:', error)
      setLoading(false)
      return
    }

    const mapped = (data || [])
      .filter(r => r.assets && r.assets.status !== 'Retired')
      .map(mapEquipmentRow)
      .sort((a, b) => a.name.localeCompare(b.name))

    setEquipment(mapped)
    hasLoadedRef.current = true
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    const channel = supabase
      .channel('equipment-list-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_equipment' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assets' },        () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { equipment, loading, refresh: fetch }
}

/**
 * Returns ALL equipment rows (including Retired; including rows whose asset is
 * also Retired). Used in the Manage Equipment tab so admins can see and fix.
 */
export function useAllEquipmentList() {
  const [equipment, setEquipment] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('lab_equipment')
      .select('*, assets:asset_id (name, description, category, location, status, image_url)')

    if (error) {
      console.error('Error loading all equipment:', error)
      setLoading(false)
      return
    }

    setEquipment(
      (data || [])
        .map(mapEquipmentRow)
        .sort((a, b) => a.name.localeCompare(b.name))
    )
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    const channel = supabase
      .channel('all-equipment-list-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_equipment' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assets' },        () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { equipment, loading, refresh: fetch }
}

// ─── Asset Picker data ───────────────────────────────────────────────────────

/**
 * Returns the list of all Active assets (not Retired in the assets table) plus
 * a Set of asset_ids already used by any equipment row (so the picker can mark
 * "already added" and prevent duplicate adds). Excludes retired assets.
 */
export function useAssetPickerData() {
  const [assets, setAssets] = useState([])
  const [usedAssetIds, setUsedAssetIds] = useState(new Set())
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    const [{ data: assetsData, error: assetsErr }, { data: eqData, error: eqErr }] = await Promise.all([
      supabase
        .from('assets')
        .select('asset_id, name, description, category, location, status, image_url')
        .neq('status', 'Retired')
        .order('name', { ascending: true }),
      supabase
        .from('lab_equipment')
        .select('asset_id'),
    ])

    if (assetsErr) console.error('Error loading assets:', assetsErr)
    if (eqErr)     console.error('Error loading equipment:', eqErr)

    setAssets(assetsData || [])
    setUsedAssetIds(new Set((eqData || []).map(r => r.asset_id)))
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    const channel = supabase
      .channel('asset-picker-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_equipment' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assets' },        () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetch])

  return { assets, usedAssetIds, loading, refresh: fetch }
}

// ─── Equipment Management (Instructor) ───────────────────────────────────────

export function useEquipmentManagement() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  /** Link a new asset as bookable equipment. */
  const addEquipment = async ({ assetId, status = 'Active', notes = '' }) => {
    if (!assetId) {
      toast.error('Select an asset')
      return { success: false }
    }
    setSaving(true)
    try {
      const id = await generateSafeEquipmentId()
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''
      const { error } = await supabase.from('lab_equipment').insert({
        equipment_id: id,
        asset_id: assetId,
        status,
        notes: (notes || '').trim() || null,
        created_at: new Date().toISOString(),
        created_by: userName,
      })
      if (error) {
        if (/duplicate|unique/i.test(error.message)) {
          toast.error('That asset is already added as equipment.')
        } else {
          toast.error('Error adding equipment: ' + error.message)
        }
        return { success: false }
      }
      toast.success('Equipment added')
      return { success: true, equipmentId: id }
    } catch (err) {
      toast.error('Error adding equipment: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Update scheduling status + notes only. Asset details are edited on the Assets page. */
  const updateEquipment = async (equipmentId, { status, notes }) => {
    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''
      const { error } = await supabase
        .from('lab_equipment')
        .update({
          status,
          notes: (notes || '').trim() || null,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('equipment_id', equipmentId)
      if (error) throw error
      toast.success('Equipment updated')
      return { success: true }
    } catch (err) {
      toast.error('Error updating equipment: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Soft-retire: sets scheduling status='Retired' — hides from scheduling but preserves history. */
  const retireEquipment = async (equipmentId) => {
    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''
      const { error } = await supabase
        .from('lab_equipment')
        .update({
          status: 'Retired',
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('equipment_id', equipmentId)
      if (error) throw error
      toast.success('Equipment retired')
      return { success: true }
    } catch (err) {
      toast.error('Error retiring equipment: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return { addEquipment, updateEquipment, retireEquipment, saving }
}

// ─── Booking Grid Data ───────────────────────────────────────────────────────

/**
 * Builds the full grid model for the Schedule tab.
 *
 * Filters applied for the student-facing grid:
 *   - Equipment with scheduling status='Retired' is excluded
 *   - Equipment whose linked asset has status='Retired' is excluded
 *
 * Returns:
 *   {
 *     weeks:    [{ weekIndex, weekStart, weekTitle, days: [...] }],
 *     equipment: [{ equipmentId, assetId, name, category, location, status, ... }, ...],
 *     slots:    { [`${dateStr}_${startMin}_${equipmentId}`]: { state, ... } },
 *     days:     { [dateStr]: { isOpen, startHour, endHour, lunchHour, notes } },
 *     mySlotsByTime: { [`${dateStr}_${startMin}`]: { equipmentId, bookingId } },
 *     loading
 *   }
 *
 * Slot states:
 *   'available'       — open, can be clicked to select
 *   'selected'        — currently selected (UI-only, not returned from hook)
 *   'mine'            — my own booking on this equipment at this time
 *   'other'           — someone else's booking
 *   'conflict'        — I have a booking on another equipment at this time
 *   'maintenance'     — equipment scheduling status is Maintenance
 *   'closed'          — lab is closed for the day / outside lab hours
 *   'past'            — slot is in the past
 *
 * Note: lunch hour is NOT a blocking state — students may book across lunch.
 * Each slot still carries an `isLunch` flag if you want to decorate visually.
 */
export function useEquipmentBookingsData(weekStart, weeksToDisplay = 4, visibleDays = [1, 2, 3, 4]) {
  const { profile } = useAuth()
  const [data, setData] = useState({
    weeks: [],
    equipment: [],
    slots: {},
    days: {},
    mySlotsByTime: {},
  })
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

      // 1. Equipment (active scheduling status + non-retired asset)
      const { data: eqData } = await supabase
        .from('lab_equipment')
        .select('*, assets:asset_id (name, description, category, location, status, image_url)')
        .neq('status', 'Retired')

      const equipment = (eqData || [])
        .filter(r => r.assets && r.assets.status !== 'Retired')
        .map(mapEquipmentRow)
        .sort((a, b) => a.name.localeCompare(b.name))

      // 2. Lab calendar entries for the range
      const { data: calData } = await supabase
        .from('lab_calendar')
        .select('*')
        .gte('date', firstWeek.toISOString())
        .lte('date', overallEnd.toISOString())

      const calByDate = {}
      ;(calData || []).forEach(row => {
        const key = typeof row.date === 'string' && row.date.length >= 10
          ? row.date.substring(0, 10)
          : formatDateKey(new Date(row.date))
        const startH = getHourFromTime(row.start_time) ?? 8
        const endH = getHourFromTime(row.end_time) ?? 16
        const lunchH = row.lunch_hour != null ? parseInt(row.lunch_hour, 10) : null
        calByDate[key] = {
          startHour: startH,
          endHour: endH,
          maxStudents: row.max_students || 24,
          status: row.status || 'Open',
          notes: row.notes || '',
          lunchHour: isNaN(lunchH) ? null : lunchH,
          isOpen: row.status === 'Open',
          closedBlocks: normalizeClosedBlocks(row.closed_blocks),
        }
      })

      // 3. Bookings for the range
      const { data: bookingData } = await supabase
        .from('equipment_bookings')
        .select('booking_id, equipment_id, user_email, user_name, date, start_time, end_time, status, purpose')
        .neq('status', 'Cancelled')
        .gte('date', firstWeek.toISOString())
        .lte('date', overallEnd.toISOString())

      const bookingsByKey = {}              // keyed by `${dateStr}_${startMin}_${equipmentId}`
      const mySlotsByTime = {}              // keyed by `${dateStr}_${startMin}`
      ;(bookingData || []).forEach(row => {
        const dk = typeof row.date === 'string' && row.date.length >= 10
          ? row.date.substring(0, 10)
          : formatDateKey(new Date(row.date))
        const startMin = timeStrToMinutes(row.start_time)
        if (startMin === null) return
        const key = `${dk}_${startMin}_${row.equipment_id}`
        bookingsByKey[key] = {
          bookingId: row.booking_id,
          userEmail: row.user_email,
          userName: row.user_name,
          equipmentId: row.equipment_id,
          purpose: row.purpose || '',
        }
        if (row.user_email === profile.email) {
          mySlotsByTime[`${dk}_${startMin}`] = {
            equipmentId: row.equipment_id,
            bookingId: row.booking_id,
          }
        }
      })

      // 4. Build weeks, days, slots
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

      const now = new Date()
      const nowMs = now.getTime()

      const weeks = []
      const slots = {}
      const days = {}

      for (let w = 0; w < weeksToDisplay; w++) {
        const ws = new Date(firstWeek)
        ws.setDate(ws.getDate() + (w * 7))
        const we = new Date(ws)
        we.setDate(we.getDate() + 6)
        const weekTitle = `${monthNames[ws.getMonth()]} ${ws.getDate()} — ${monthNames[we.getMonth()]} ${we.getDate()}`

        const weekDays = []
        for (let d = 0; d < 7; d++) {
          if (!visibleDays.includes(d)) continue
          const dt = new Date(ws)
          dt.setDate(dt.getDate() + d)
          const dateKey = formatDateKey(dt)
          const config = calByDate[dateKey]
          const dayInfo = {
            date: dateKey,
            dayName: dayNames[dt.getDay()],
            dayShort: dayNames[dt.getDay()].substring(0, 3),
            dayNum: dt.getDate(),
            month: dt.getMonth() + 1,
            dayOfWeek: dt.getDay(),
            isOpen: !!config?.isOpen,
            startHour: config?.startHour ?? 8,
            endHour: config?.endHour ?? 16,
            lunchHour: config?.lunchHour ?? null,
            notes: config?.notes ?? '',
            hasEntry: !!config,
            startMin: (config?.startHour ?? 8) * 60,
            endMin: (config?.endHour ?? 16) * 60,
            lunchStartMin: config?.lunchHour != null ? config.lunchHour * 60 : null,
            closedBlocks: config?.closedBlocks || [],
          }
          days[dateKey] = dayInfo
          weekDays.push(dayInfo)

          // Build per-equipment, per-slot state for this day
          if (dayInfo.isOpen) {
            for (let min = dayInfo.startMin; min < dayInfo.endMin; min += 30) {
              const slotDateLocal = new Date(dt)
              slotDateLocal.setHours(Math.floor(min / 60), min % 60, 0, 0)
              const isPast = slotDateLocal.getTime() < nowMs

              const isLunch = dayInfo.lunchStartMin != null
                && min >= dayInfo.lunchStartMin
                && min < dayInfo.lunchStartMin + 60

              // Hour-level lab closure (e.g. faculty meeting 2-3pm)
              const closureReason = findOverlappingClosure(
                min,
                min + 30,
                dayInfo.closedBlocks
              )

              const conflictEntry = mySlotsByTime[`${dateKey}_${min}`]

              equipment.forEach(e => {
                const k = `${dateKey}_${min}_${e.equipmentId}`
                const booking = bookingsByKey[k]
                let state

                // Bookings always take precedence so users can see their
                // completed bookings for historical reference. The `isPast`
                // flag (returned separately) gates whether actions are allowed.
                //
                // Lunch hour is NOT a blocking state — students may schedule
                // across lunch. The `isLunch` boolean is attached to each slot
                // for any future decoration but does not affect interactivity.
                //
                // Closures (closed_blocks on lab_calendar) DO block bookings.
                // We mark these as state='closed'; the GridCell falls through
                // to the default ('Unavailable') case if it doesn't recognize
                // 'closed', which is fine — the slot is non-interactive.
                if (booking) {
                  state = booking.userEmail === profile.email ? 'mine' : 'other'
                } else if (isPast) {
                  state = 'past'
                } else if (closureReason) {
                  state = 'closed'
                } else if (e.status === 'Maintenance') {
                  state = 'maintenance'
                } else if (conflictEntry && conflictEntry.equipmentId !== e.equipmentId) {
                  state = 'conflict'
                } else {
                  state = 'available'
                }

                slots[k] = {
                  equipmentId: e.equipmentId,
                  date: dateKey,
                  startMin: min,
                  endMin: min + 30,
                  state,
                  isPast,
                  isLunch,
                  closureReason: closureReason || '',
                  booking: booking || null,
                  conflictEquipmentId: conflictEntry?.equipmentId || null,
                }
              })
            }
          }
        }

        weeks.push({
          weekIndex: w,
          weekStart: formatDateKey(ws),
          weekTitle,
          days: weekDays,
        })
      }

      setData({ weeks, equipment, slots, days, mySlotsByTime })
    } catch (err) {
      console.error('Error loading equipment booking data:', err)
      toast.error('Failed to load equipment schedule')
    } finally {
      setLoading(false)
    }
  }, [weekStart, weeksToDisplay, visibleDays, profile])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    if (!weekStart || !profile) return
    const channel = supabase
      .channel('equipment-bookings-data-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'equipment_bookings' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_equipment' },      () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assets' },             () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_calendar' },       () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [weekStart, profile, fetch])

  return { ...data, loading, refresh: fetch }
}

// ─── Booking Actions ─────────────────────────────────────────────────────────

export function useEquipmentBookingActions() {
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)

  /**
   * Book one or more consecutive (or non-consecutive) 30-min slots on a single
   * equipment row.
   *
   * @param {string}   equipmentId
   * @param {string}   dateStr      'YYYY-MM-DD'
   * @param {number[]} startMinutes array of 30-min-aligned minute-of-day values
   * @param {string}   purpose      optional free-text description
   */
  const bookSlots = async (equipmentId, dateStr, startMinutes, purpose = '') => {
    if (!equipmentId || !dateStr || !startMinutes?.length) {
      toast.error('Invalid booking details')
      return { success: false }
    }
    setSaving(true)
    try {
      const targetDate = new Date(dateStr + 'T12:00:00')
      const userName = `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()

      // Double-check each requested slot isn't taken. DB unique indexes are the
      // real guard, but pre-checking gives a cleaner error message.
      for (const min of startMinutes) {
        const startTime = minutesToTimeStr(min)
        const { data: existsEq } = await supabase
          .from('equipment_bookings')
          .select('booking_id')
          .eq('equipment_id', equipmentId)
          .eq('date', targetDate.toISOString())
          .eq('start_time', startTime)
          .neq('status', 'Cancelled')
          .maybeSingle()
        if (existsEq) {
          toast.error(`That equipment is already booked at ${formatMinutes(min)}`)
          return { success: false }
        }

        const { data: existsUser } = await supabase
          .from('equipment_bookings')
          .select('booking_id, equipment_id')
          .eq('user_email', profile.email)
          .eq('date', targetDate.toISOString())
          .eq('start_time', startTime)
          .neq('status', 'Cancelled')
          .maybeSingle()
        if (existsUser) {
          toast.error(`You are already booked on other equipment at ${formatMinutes(min)}`)
          return { success: false }
        }
      }

      // Build rows
      const rows = []
      for (const min of startMinutes) {
        const id = await generateSafeEquipmentBookingId()
        rows.push({
          booking_id: id,
          equipment_id: equipmentId,
          user_email: profile.email,
          user_name: userName,
          class_id: null,
          course_id: null,
          date: targetDate.toISOString(),
          start_time: minutesToTimeStr(min),
          end_time: minutesToTimeStr(min + 30),
          duration_minutes: 30,
          purpose: (purpose || '').trim() || null,
          status: 'Confirmed',
          reminder_sent: false,
          created_at: new Date().toISOString(),
          created_by: profile.email,
        })
      }

      const { error } = await supabase.from('equipment_bookings').insert(rows)
      if (error) throw error

      toast.success(`Booked ${rows.length} slot${rows.length > 1 ? 's' : ''}`)
      return { success: true, count: rows.length }
    } catch (err) {
      const msg = /duplicate|unique/i.test(err.message)
        ? 'That slot was just booked by someone else. Please try again.'
        : 'Error: ' + err.message
      toast.error(msg)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Cancel a single booking (sets status='Cancelled'; preserves row for history). */
  const cancelBooking = async (bookingId) => {
    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''
      const { error } = await supabase
        .from('equipment_bookings')
        .update({
          status: 'Cancelled',
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('booking_id', bookingId)
      if (error) throw error
      toast.success('Booking cancelled')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Update the purpose text on an existing booking. */
  const updateBookingPurpose = async (bookingId, purpose) => {
    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''
      const { error } = await supabase
        .from('equipment_bookings')
        .update({
          purpose: (purpose || '').trim() || null,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('booking_id', bookingId)
      if (error) throw error
      toast.success('Updated')
      return { success: true }
    } catch (err) {
      toast.error('Error: ' + err.message)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  /** Instructor-only: reassign a booking to a different user. */
  const reassignBooking = async (bookingId, newUser) => {
    if (!newUser?.email || !newUser?.firstName) {
      toast.error('Invalid user')
      return { success: false }
    }
    setSaving(true)
    try {
      const userName = profile ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim() : ''
      const newName = `${newUser.firstName} ${(newUser.lastName || '').charAt(0)}.`.trim()
      const { error } = await supabase
        .from('equipment_bookings')
        .update({
          user_email: newUser.email,
          user_name: newName,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        })
        .eq('booking_id', bookingId)
      if (error) throw error
      toast.success(`Reassigned to ${newName}`)
      return { success: true }
    } catch (err) {
      const msg = /duplicate|unique/i.test(err.message)
        ? 'That user already has a booking at this time on other equipment.'
        : 'Error: ' + err.message
      toast.error(msg)
      return { success: false }
    } finally {
      setSaving(false)
    }
  }

  return { bookSlots, cancelBooking, updateBookingPurpose, reassignBooking, saving }
}

// ─── My Bookings (future only) ───────────────────────────────────────────────

export function useMyEquipmentBookings() {
  const { profile } = useAuth()
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Nested join: equipment → assets for display info
    const { data, error } = await supabase
      .from('equipment_bookings')
      .select(`
        booking_id, equipment_id, user_email, user_name, date, start_time, end_time,
        duration_minutes, purpose, status,
        lab_equipment:equipment_id (
          equipment_id,
          assets:asset_id ( name, category, location )
        )
      `)
      .eq('user_email', profile.email)
      .gte('date', today.toISOString())
      .neq('status', 'Cancelled')
      .order('date', { ascending: true })
      .order('start_time', { ascending: true })

    if (error) {
      console.error('Error loading my bookings:', error)
      setLoading(false)
      return
    }

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    setBookings((data || []).map(b => {
      const parts = (b.date || '').substring(0, 10).split('-')
      const dt = parts.length === 3
        ? new Date(+parts[0], +parts[1] - 1, +parts[2])
        : new Date(b.date)
      const startMin = timeStrToMinutes(b.start_time) ?? 0
      const endMin = timeStrToMinutes(b.end_time) ?? 30
      const eq = b.lab_equipment || {}
      const a = eq.assets || {}
      return {
        bookingId: b.booking_id,
        equipmentId: b.equipment_id,
        equipmentName: a.name || b.equipment_id,
        equipmentCategory: a.category || '',
        equipmentLocation: a.location || '',
        dateDisplay: `${dayNames[dt.getDay()]}, ${monthNames[dt.getMonth()]} ${dt.getDate()}`,
        dateRaw: (b.date || '').substring(0, 10),
        startMin,
        endMin,
        startTimeDisplay: formatMinutes(startMin),
        endTimeDisplay: formatMinutes(endMin),
        durationMinutes: b.duration_minutes || (endMin - startMin),
        purpose: b.purpose || '',
        status: b.status,
      }
    }))
    setLoading(false)
  }, [profile])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    if (!profile) return
    const channel = supabase
      .channel('my-equipment-bookings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'equipment_bookings' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assets' },             () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile, fetch])

  return { bookings, loading, refresh: fetch }
}

// ─── Daily Roster (Instructor — All Bookings tab) ────────────────────────────

export function useAllEquipmentBookings(dateStr) {
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(false)

  const fetch = useCallback(async () => {
    if (!dateStr) return
    setLoading(true)
    const targetDate = new Date(dateStr + 'T12:00:00')

    const { data, error } = await supabase
      .from('equipment_bookings')
      .select(`
        booking_id, equipment_id, user_email, user_name, date, start_time, end_time,
        duration_minutes, purpose, status,
        lab_equipment:equipment_id (
          equipment_id,
          assets:asset_id ( name, category, location )
        )
      `)
      .eq('date', targetDate.toISOString())
      .neq('status', 'Cancelled')
      .order('start_time', { ascending: true })

    if (error) {
      console.error('Error loading daily roster:', error)
      setLoading(false)
      return
    }

    setBookings((data || []).map(b => {
      const startMin = timeStrToMinutes(b.start_time) ?? 0
      const endMin = timeStrToMinutes(b.end_time) ?? 30
      const eq = b.lab_equipment || {}
      const a = eq.assets || {}
      return {
        bookingId: b.booking_id,
        equipmentId: b.equipment_id,
        equipmentName: a.name || b.equipment_id,
        equipmentCategory: a.category || '',
        userEmail: b.user_email,
        userName: b.user_name,
        startMin,
        endMin,
        startTimeDisplay: formatMinutes(startMin),
        endTimeDisplay: formatMinutes(endMin),
        durationMinutes: b.duration_minutes || (endMin - startMin),
        purpose: b.purpose || '',
        status: b.status,
      }
    }))
    setLoading(false)
  }, [dateStr])

  useEffect(() => { fetch() }, [fetch])

  useEffect(() => {
    if (!dateStr) return
    const channel = supabase
      .channel(`all-equipment-bookings-${dateStr}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'equipment_bookings' }, () => { fetch() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assets' },             () => { fetch() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [dateStr, fetch])

  return { bookings, loading, refresh: fetch }
}

// ─── Students List (for Instructor reassignment) ─────────────────────────────

export function useEquipmentStudentsList() {
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
    setStudents(
      (data || [])
        .filter(s => s.time_clock_only !== 'Yes')
        .map(s => ({
          userId: s.id,
          firstName: s.first_name || '',
          lastName: s.last_name || '',
          email: s.email,
          displayName: `${s.first_name || ''} ${s.last_name || ''} (${s.email})`.trim(),
          classes: s.classes || '',
        }))
    )
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  return { students, loading, refresh: fetch }
}

// Re-export shared helpers for convenience
export { formatDateKey, getHourFromTime, getWeekStart }
