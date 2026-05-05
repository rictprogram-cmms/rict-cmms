/**
 * RICT CMMS - Notification Bell Component (v2)
 * Matches old GAS notification panel with inline approve/reject actions.
 * Polls Supabase for all pending notification types every 30 seconds.
 *
 * Types: access requests, WO requests, parts orders,
 *        time entry requests, lab change requests, temp access requests,
 *        volunteer punch approvals
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { useDialogA11y } from '@/hooks/useDialogA11y';
import '@/styles/notification-bell.css';

const REMINDER_INTERVAL = 60000; // Ding every 60 seconds while notifications are pending

export default function NotificationBell() {
  const { user, profile } = useAuth();
  const isInstructor = profile?.role === 'Instructor' || profile?.role === 'Super Admin';
  // Items are kept per-table so realtime events on a single table only re-fetch
  // and update that one slice — instead of re-running 8+ queries on every event.
  // The derived `items` array preserves the original render order.
  const [itemsByTable, setItemsByTable] = useState({
    access: [], wo: [], parts: [], time: [], lab: [], temp: [], help: [], announcement: [], netchg: [],
  });
  const items = useMemo(() => [
    ...(itemsByTable.access || []),
    ...(itemsByTable.wo || []),
    ...(itemsByTable.parts || []),
    ...(itemsByTable.time || []),
    ...(itemsByTable.lab || []),
    ...(itemsByTable.temp || []),
    ...(itemsByTable.help || []),
    ...(itemsByTable.announcement || []),
    ...(itemsByTable.netchg || []),
  ], [itemsByTable]);
  const [open, setOpen] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);
  const panelRef = useRef(null);
  // Track the SET OF IDs from the previous render — not just the count.
  // Using count alone misses the case where one item is approved and a different
  // item arrives in the same poll interval (count stays the same → no sound played).
  // null = first run (don't play sound on initial load).
  const prevIdsRef = useRef(null);
  const navigate = useNavigate();

  // ── Push Notifications ──
  const { pushStatus, subscribeToPush, unsubscribeFromPush } = usePushNotifications();

  // Notification sound using Web Audio API
  // AudioContext must be created/resumed after a user gesture (browser policy)
  const audioCtxRef = useRef(null);

  // Initialize AudioContext on first user interaction with the page
  useEffect(() => {
    const initAudio = () => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
    };
    // Listen for any user gesture to unlock audio
    document.addEventListener('click', initAudio, { once: false });
    document.addEventListener('keydown', initAudio, { once: false });
    return () => {
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
  }, []);

  const playNotificationSound = useCallback(() => {
    try {
      const ctx = audioCtxRef.current;
      if (!ctx || ctx.state === 'closed') {
        // Create fresh if needed
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ac = audioCtxRef.current;
      if (ac.state === 'suspended') ac.resume();

      // Two-tone chime
      [520, 680].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.15, ac.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + i * 0.15 + 0.4);
        osc.start(ac.currentTime + i * 0.15);
        osc.stop(ac.currentTime + i * 0.15 + 0.4);
      });
    } catch (e) { console.warn('Audio playback failed:', e); }
  }, []);

  // Approve access modal
  const [roleModal, setRoleModal] = useState(null);
  const [selectedRole, setSelectedRole] = useState('Student');
  // Approve temp access modal
  const [tempModal, setTempModal] = useState(null);
  const [tempRole, setTempRole] = useState('Work Study');
  const [tempDays, setTempDays] = useState(3);
  // Permission-type temp access approval state
  const [tempApprovePerms, setTempApprovePerms] = useState({});
  // Reject reason modal
  const [rejectModal, setRejectModal] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  // Lab partial-approval modal
  const [labModal, setLabModal] = useState(null);
  const [labApproveAdds, setLabApproveAdds] = useState({});    // slotKey → true/false
  const [labApproveCancels, setLabApproveCancels] = useState({}); // slotKey → true/false

  const uName = () => profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
  const fullName = () => profile ? `${profile.first_name} ${profile.last_name}` : '';

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // Close panel on outside click
  useEffect(() => {
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── A11y: Escape closes the bell panel (non-modal popover, no focus trap) ──
  // Modal dialogs below get their own Escape + focus-trap via useDialogA11y.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // ── A11y: per-modal Escape + focus trap + focus return (WCAG 2.1.1, 2.4.3) ──
  // Each useDialogA11y call returns a ref that gets attached to the modal root.
  // Closing handlers wrap setX(null) so the hook's keydown listener can fire them.
  const closeRoleModal   = useCallback(() => setRoleModal(null),   []);
  const closeTempModal   = useCallback(() => setTempModal(null),   []);
  const closeLabModal    = useCallback(() => setLabModal(null),    []);
  const closeRejectModal = useCallback(() => setRejectModal(null), []);
  const roleDialogRef    = useDialogA11y(!!roleModal,   closeRoleModal);
  const tempDialogRef    = useDialogA11y(!!tempModal,   closeTempModal);
  const labDialogRef     = useDialogA11y(!!labModal,    closeLabModal);
  const rejectDialogRef  = useDialogA11y(!!rejectModal, closeRejectModal);

  // Material Icons
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
  }, []);

  // ── POLL NOTIFICATIONS — per-table fetchers ──
  // Each table has its own fetcher that updates only its slice of `itemsByTable`.
  // This way, a realtime event on one table only re-runs that one query — instead
  // of the original monolithic fetchNotifications which re-ran 8+ queries on every
  // change to any of the 9 watched tables (including time_clock punch in/out events).

  const fetchAccessRequests = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, access: [] }));
      return;
    }
    const _items = [];
    // 1. Access requests
    try {
      const { data, error } = await supabase.from('access_requests').select('*').eq('status', 'Pending').order('request_date', { ascending: false });
      if (error) console.warn('NotifBell: access_requests error:', error.message);
      (data || []).forEach(r => _items.push({ id: `access-${r.request_id}`, type: 'access', icon: 'person_add', color: '#fab005', title: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email, subtitle: r.email, date: r.request_date, raw: r }));
    } catch (e) { console.warn('NotifBell: access_requests exception:', e.message); }
    setItemsByTable(prev => ({ ...prev, access: _items }));
  }, [profile?.email, isInstructor]);

  const fetchWORequests = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, wo: [] }));
      return;
    }
    const _items = [];
    // 2. WO requests
    try {
      const { data, error } = await supabase.from('work_order_requests').select('*').eq('status', 'Pending').order('request_date', { ascending: false });
      if (error) console.warn('NotifBell: work_order_requests error:', error.message);
      (data || []).forEach(r => _items.push({ id: `wo-${r.request_id}`, type: 'wo', icon: 'assignment', color: '#228be6', title: r.description || 'Work Order Request', subtitle: `${r.created_by || 'Unknown'} — ${r.priority || 'Medium'}`, date: r.request_date, raw: r }));
    } catch (e) { console.warn('NotifBell: work_order_requests exception:', e.message); }
    setItemsByTable(prev => ({ ...prev, wo: _items }));
  }, [profile?.email, isInstructor]);

  const fetchOrders = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, parts: [] }));
      return;
    }
    const _items = [];
    // 3. Parts orders
    try {
      const { data, error } = await supabase.from('orders').select('*').eq('status', 'Pending').order('order_date', { ascending: false });
      if (error) console.warn('NotifBell: orders error:', error.message);
      for (const o of (data || [])) {
        // Fetch line items for this order
        let lineItems = [];
        try {
          const { data: li } = await supabase.from('order_line_items').select('description, part_number, quantity, unit_price, subtotal, wo_id').eq('order_id', o.order_id);
          lineItems = li || [];
        } catch {}
        // Fetch WO descriptions for linked work orders
        const woIds = [...new Set([o.work_order_id, ...lineItems.map(l => l.wo_id)].filter(Boolean))];
        let woDescs = {};
        if (woIds.length > 0) {
          try {
            const { data: wos } = await supabase.from('work_orders').select('wo_id, description').in('wo_id', woIds);
            (wos || []).forEach(w => { woDescs[w.wo_id] = w.description; });
          } catch {}
        }
        _items.push({
          id: `order-${o.order_id}`, type: 'parts', icon: 'local_shipping', color: '#40c057',
          title: o.vendor_name || o.other_vendor || 'Parts Order',
          subtitle: `${o.ordered_by || 'Unknown'} — $${parseFloat(o.total || 0).toFixed(2)}${woIds.length > 0 ? ` — ${woIds.join(', ')}` : ''}`,
          date: o.order_date,
          raw: o,
          lineItems,
          woDescs,
          woIds
        });
      }
    } catch (e) { console.warn('NotifBell: orders exception:', e.message); }
    setItemsByTable(prev => ({ ...prev, parts: _items }));
  }, [profile?.email, isInstructor]);

  const fetchTimeRequests = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, time: [] }));
      return;
    }
    const _items = [];
    // 4. Time entry requests
    try {
      const { data, error } = await supabase.from('time_entry_requests').select('*').eq('status', 'Pending');
      if (!error && data) {
        // Format time helper
        const fmtTime = (t) => {
          if (!t) return '';
          const [h, m] = t.split(':');
          const hr = parseInt(h);
          const ampm = hr >= 12 ? 'PM' : 'AM';
          const h12 = hr % 12 || 12;
          return `${h12}:${m || '00'} ${ampm}`;
        };
        // Format time from ISO datetime
        // NOTE: time_clock uses "fake UTC" storage (local hours stored with +00 offset).
        // We must read with getUTCHours/getUTCMinutes to get the correct local display time.
        const fmtTimeFromISO = (iso) => {
          if (!iso) return '';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '';
          const hr = d.getUTCHours();
          const mn = String(d.getUTCMinutes()).padStart(2, '0');
          const ampm = hr >= 12 ? 'PM' : 'AM';
          const h12 = hr % 12 || 12;
          return `${h12}:${mn} ${ampm}`;
        };

        // Collect edit requests that need original time_clock data
        const editRequests = data.filter(r => r.entry_type === 'Edit' && r.time_clock_record_id);
        const newRequests = data.filter(r => r.entry_type !== 'Edit' || !r.time_clock_record_id);

        // Batch-fetch original time_clock records for edit requests
        let originalRecords = {};
        if (editRequests.length > 0) {
          const tcIds = editRequests.map(r => r.time_clock_record_id).filter(Boolean);
          if (tcIds.length > 0) {
            try {
              const { data: tcData } = await supabase
                .from('time_clock')
                .select('record_id, punch_in, punch_out, total_hours, course_id, class_id')
                .in('record_id', tcIds);
              (tcData || []).forEach(tc => { originalRecords[tc.record_id] = tc; });
            } catch {}
          }
        }

        // Process NEW time entry requests
        newRequests.forEach(r => {
          const timeRange = r.start_time && r.end_time ? `${fmtTime(r.start_time)}–${fmtTime(r.end_time)}` : '';
          _items.push({
            id: `time-${r.request_id}`,
            type: 'time',
            icon: 'event_busy',
            color: '#7c3aed',
            title: `${r.user_name || 'Unknown'} — ${r.course_id || r.class_id || ''}`,
            subtitle: `${r.requested_date || ''} ${timeRange} — ${r.total_hours || 0}h`,
            date: r.created_at,
            raw: r,
            timeDetail: {
              reason: r.reason || '',
              date: r.requested_date || '',
              startTime: fmtTime(r.start_time),
              endTime: fmtTime(r.end_time),
              totalHours: r.total_hours || 0,
              courseId: r.course_id || r.class_id || '',
            }
          });
        });

        // Process EDIT time entry requests with before/after comparison
        editRequests.forEach(r => {
          const original = originalRecords[r.time_clock_record_id] || {};
          const origStartTime = fmtTimeFromISO(original.punch_in);
          const origEndTime = fmtTimeFromISO(original.punch_out);
          const origHours = original.total_hours || 0;
          const newStartTime = fmtTime(r.start_time);
          const newEndTime = fmtTime(r.end_time);
          const newHours = r.total_hours || 0;
          const hoursDelta = Math.round((newHours - origHours) * 100) / 100;

          _items.push({
            id: `time-${r.request_id}`,
            type: 'time_edit',
            icon: 'edit_note',
            color: '#e8590c',
            title: `${r.user_name || 'Unknown'} — ${r.course_id || r.class_id || ''}`,
            subtitle: `Edit: ${r.requested_date || ''} — ${origHours}h → ${newHours}h`,
            date: r.created_at,
            raw: r,
            editDetail: {
              reason: r.reason || '',
              date: r.requested_date || '',
              recordId: r.time_clock_record_id || '',
              origStartTime,
              origEndTime,
              origHours,
              newStartTime,
              newEndTime,
              newHours,
              hoursDelta,
              courseId: r.course_id || r.class_id || '',
            }
          });
        });
      }
    } catch {}
    setItemsByTable(prev => ({ ...prev, time: _items }));
  }, [profile?.email, isInstructor]);

  const fetchLabRequests = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, lab: [] }));
      return;
    }
    const _items = [];
    // 5. Lab change requests
    try {
      const { data, error } = await supabase.from('lab_signup_requests').select('*').eq('status', 'Pending').order('submitted_date', { ascending: false });
      if (error) console.warn('NotifBell: lab_signup_requests error:', error.message);
      // for...of so we can await inside (conflict check + week progress)
      for (const r of (data || [])) {
        // ── Parse slot keys into { key, label } objects ──
        const parseSlotObjs = (raw) => {
          try {
            const arr = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
            return arr.map(s => {
              const [dateStr, hourStr] = (s || '').split('_');
              if (!dateStr || !hourStr) return { key: s, label: s };
              const dt = new Date(dateStr + 'T12:00:00');
              const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
              const h = parseInt(hourStr);
              const ampm = h >= 12 ? 'PM' : 'AM';
              const h12 = h % 12 || 12;
              return { key: s, label: `${dayNames[dt.getDay()]} ${dt.getMonth()+1}/${dt.getDate()} ${h12}:00 ${ampm}` };
            });
          } catch { return []; }
        };
        const currentParsed  = parseSlotObjs(r.current_slots);
        const requestedParsed = parseSlotObjs(r.requested_slots);
        const currentKeys  = new Set(currentParsed.map(x => x.key));
        const requestedKeys = new Set(requestedParsed.map(x => x.key));

        // ── Diff ──
        const cancelledObjs = currentParsed.filter(x => !requestedKeys.has(x.key));
        const keptSlots     = currentParsed.filter(x =>  requestedKeys.has(x.key)).map(x => x.label);
        const addedObjs     = requestedParsed.filter(x => !currentKeys.has(x.key));

        // ── Conflict check: are any new slots already full? ──
        const addedWithConflict = [];
        for (const slotObj of addedObjs) {
          const [dateStr, hourStr] = slotObj.key.split('_');
          let conflict = false;
          if (dateStr && hourStr) {
            try {
              const targetDate = new Date(dateStr + 'T12:00:00');
              const hour = parseInt(hourStr);
              const { data: calRow } = await supabase
                .from('lab_calendar').select('max_students')
                .eq('date', targetDate.toISOString()).maybeSingle();
              const maxStudents = calRow?.max_students ?? 24;
              const startTime = `${String(hour).padStart(2, '0')}:00:00`;
              const { count } = await supabase
                .from('lab_signup').select('signup_id', { count: 'exact', head: true })
                .eq('date', targetDate.toISOString())
                .eq('start_time', startTime)
                .neq('status', 'Cancelled');
              conflict = (count || 0) >= maxStudents;
            } catch {}
          }
          addedWithConflict.push({ ...slotObj, conflict });
        }

        // ── Week progress: student's confirmed signups this week for this class ──
        let weekSignupCount = 0;
        let requiredHours = 0;
        try {
          const courseId = r.course_id || r.class_id || '';
          const weekStartStr = (r.week_start || '').substring(0, 10);
          if (weekStartStr && courseId) {
            const wStart = new Date(weekStartStr + 'T00:00:00');
            const wEnd   = new Date(weekStartStr + 'T00:00:00');
            wEnd.setDate(wEnd.getDate() + 6);
            wEnd.setHours(23, 59, 59, 999);
            const { data: signupRows } = await supabase
              .from('lab_signup').select('signup_id')
              .eq('user_email', r.user_email)
              .eq('class_id', courseId)
              .neq('status', 'Cancelled')
              .gte('date', wStart.toISOString())
              .lte('date', wEnd.toISOString());
            weekSignupCount = (signupRows || []).length;
            const { data: classRow } = await supabase
              .from('classes').select('required_hours')
              .eq('course_id', courseId).eq('status', 'Active').maybeSingle();
            requiredHours = classRow?.required_hours || 0;
          }
        } catch {}

        _items.push({
          id: `lab-${r.request_id}`, type: 'lab', icon: 'science', color: '#e64980',
          title: `${r.user_name || 'Unknown'} — ${r.course_id || ''}`,
          subtitle: `Week of ${r.week_start || ''}`,
          date: r.submitted_date, raw: r,
          labDetail: {
            reason: r.reason || '',
            // cancelled
            cancelledSlots: cancelledObjs.map(x => x.label),
            cancelledKeys:  cancelledObjs.map(x => x.key),
            // kept (no change needed, display only)
            keptSlots,
            // added — includes conflict flag per slot
            addedSlots:     addedWithConflict.map(x => x.label),
            addedKeys:      addedWithConflict.map(x => x.key),
            addedConflicts: addedWithConflict.map(x => x.conflict),
            // week progress
            weekSignupCount,
            requiredHours,
          }
        });
      }
    } catch (e) { console.warn('NotifBell: lab_signup_requests exception:', e.message); }
    setItemsByTable(prev => ({ ...prev, lab: _items }));
  }, [profile?.email, isInstructor]);

  const fetchTempRequests = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, temp: [] }));
      return;
    }
    const _items = [];
    // 6. Temp access requests
    try {
      const { data, error } = await supabase.from('temp_access_requests').select('*').eq('status', 'Pending').order('submitted_date', { ascending: false });
      if (error) console.warn('NotifBell: temp_access_requests error:', error.message);
      (data || []).forEach(r => {
        const isPermType = r.request_type === 'permissions';
        const permCount = (r.requested_permissions || []).length;
        _items.push({
          id: `temp-${r.request_id}`,
          type: isPermType ? 'temp_perm' : 'temp',
          icon: isPermType ? 'tune' : 'vpn_key',
          color: isPermType ? '#7c3aed' : '#f59f00',
          title: r.user_name || r.user_email,
          subtitle: isPermType
            ? `${permCount} permission${permCount !== 1 ? 's' : ''} for ${r.days_requested}d`
            : `${r.user_current_role || r.current_role || ''} → ${r.requested_role} (${r.days_requested}d)`,
          date: r.submitted_date,
          raw: r,
        });
      });
    } catch (e) { console.warn('NotifBell: temp_access_requests exception:', e.message); }

    // NOTE: Volunteer time clock punches are auto-approved at punch time (no notification needed).
    // Only manual "Log Volunteer Hours" requests (time_entry_requests) require instructor approval.
    setItemsByTable(prev => ({ ...prev, temp: _items }));
  }, [profile?.email, isInstructor]);

  const fetchHelpRequests = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, help: [] }));
      return;
    }
    const _items = [];
    // 7. Help requests
    try {
      const { data, error } = await supabase
        .from('help_requests')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: true });
      if (!error && data) {
        data.forEach(r => {
          const locLabel = r.location ? ` — Room ${r.location}` : '';
          _items.push({
            id: `help-${r.request_id}`,
            type: 'help',
            icon: 'help_outline',
            color: '#ef4444',
            title: `${r.user_name || 'Unknown'} needs help`,
            subtitle: `Room ${r.location || 'Unknown'}  •  ${new Date(r.requested_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
            date: r.requested_at,
            raw: r,
          });
        });
      }
    } catch (e) { console.warn('NotifBell: help_requests exception:', e.message); }
    setItemsByTable(prev => ({ ...prev, help: _items }));
  }, [profile?.email, isInstructor]);

  const fetchAnnouncements = useCallback(async () => {
    if (!profile?.email) {
      setItemsByTable(prev => ({ ...prev, announcement: [] }));
      return;
    }
    const _items = [];
    // ── ALL USERS: Unread announcements ──
    try {
    const { data } = await supabase
      .from('announcements')
      .select('*')
      .eq('recipient_email', profile.email.toLowerCase())
      .eq('read', false)
      .order('created_at', { ascending: false })
      .limit(20);
    (data || []).forEach(a => {
      const isWOAssign = a.notification_type === 'wo_assignment';
      _items.push({
        id: `ann-${a.id}`,
        type: isWOAssign ? 'wo_assignment' : 'announcement',
        icon: isWOAssign ? 'assignment_ind' : 'campaign',
        color: isWOAssign ? '#f59f00' : '#0ea5e9',
        title: a.subject || (isWOAssign ? 'Work Order Assigned' : 'New Announcement'),
        subtitle: isWOAssign
          ? a.body || `Assigned by ${a.sender_name || 'Instructor'}`
          : `From ${a.sender_name || 'Instructor'}`,
        date: a.created_at,
        raw: a
      });
    });
    } catch {}
    setItemsByTable(prev => ({ ...prev, announcement: _items }));
  }, [profile?.email]);

  // ── INSTRUCTOR ONLY: Pending network change requests ──
  // Surfaces the same "Pending Changes" count shown on /network-map so instructors
  // are alerted via the bell instead of having to visit the page to discover them.
  // One item per pending request → the bell count badge stays accurate, and the
  // Set-based ID comparison fires the ding when a new request arrives even if
  // another was approved in the same poll cycle.
  const fetchNetworkChanges = useCallback(async () => {
    if (!profile?.email || !isInstructor) {
      setItemsByTable(prev => ({ ...prev, netchg: [] }));
      return;
    }
    const _items = [];
    try {
      const { data } = await supabase
        .from('network_change_requests')
        .select('request_id, ip_address, change_type, submitted_by_name, submitted_by, submitted_date, reason')
        .eq('status', 'Pending')
        .order('submitted_date', { ascending: false })
        .limit(50);
      (data || []).forEach(r => {
        const action =
          r.change_type === 'add' ? 'Add' :
          r.change_type === 'delete' ? 'Delete' :
          r.change_type === 'edit' ? 'Edit' :
          'Change';
        _items.push({
          id: `netchg-${r.request_id}`,
          type: 'netchg',
          icon: 'router',
          color: '#7c3aed',
          title: `${action} ${r.ip_address || 'device'}`,
          subtitle: `Submitted by ${r.submitted_by_name || r.submitted_by || 'someone'}`,
          date: r.submitted_date,
          raw: r,
        });
      });
    } catch {}
    setItemsByTable(prev => ({ ...prev, netchg: _items }));
  }, [profile?.email, isInstructor]);

  // Wrapper used by polling, opening the panel, and post-action refreshes.
  // Each call_site that previously called fetchNotifications still does so —
  // this just dispatches to all per-table fetchers.
  const fetchNotifications = useCallback(() => {
    if (!profile?.email) return;
    fetchAccessRequests();
    fetchWORequests();
    fetchOrders();
    fetchTimeRequests();
    fetchLabRequests();
    fetchTempRequests();
    fetchHelpRequests();
    fetchAnnouncements();
    fetchNetworkChanges();
  }, [profile?.email, fetchAccessRequests, fetchWORequests, fetchOrders, fetchTimeRequests, fetchLabRequests, fetchTempRequests, fetchHelpRequests, fetchAnnouncements, fetchNetworkChanges]);

  // ── Play sound on new item arrival ──
  // Compares the SET OF item IDs across renders. This catches the case where one
  // item is approved and a different one arrives in the same poll cycle (count
  // stays the same, but a fresh ID is present, so it should still ring).
  // First render (prevIdsRef.current === null): never ring on initial load.
  useEffect(() => {
    const newIds = new Set(items.map(i => i.id));
    if (prevIdsRef.current !== null) {
      const hasNewItem = [...newIds].some(id => !prevIdsRef.current.has(id));
      if (hasNewItem) {
        setHasNew(true);
        playNotificationSound();
      }
    }
    prevIdsRef.current = newIds;
  }, [items, playNotificationSound]);

  // Poll interval from settings (default 60 seconds, 0 = realtime-only)
  const [pollInterval, setPollInterval] = useState(60000);
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('settings')
          .select('setting_value')
          .eq('setting_key', 'notif_poll_interval')
          .maybeSingle();
        if (data?.setting_value) {
          const val = parseInt(data.setting_value, 10);
          if (val === 0) setPollInterval(0);
          else if (val >= 10) setPollInterval(val * 1000);
        }
      } catch (e) { /* keep default */ }
    })();
  }, []);

  // Initial fetch + polling at the configured interval
  useEffect(() => {
    if (!profile?.email) return;
    fetchNotifications();
    if (pollInterval === 0) return; // realtime-only mode
    const interval = setInterval(fetchNotifications, pollInterval);
    return () => clearInterval(interval);
  }, [profile?.email, fetchNotifications, pollInterval]);

  // ── Realtime: dispatch to ONE fetcher per table change ──
  // Previously, ANY event on any of the 9 watched tables re-ran ALL 8 queries.
  // For example, a student punching the time clock would trigger fetches for
  // access_requests, work_order_requests, orders (with N+1 line-item subqueries),
  // lab_signup_requests (with conflict checks), temp_access_requests, etc. — easily
  // 15+ HTTP requests per punch event. Now only the relevant fetcher fires.
  useEffect(() => {
    if (!profile?.email) return;
    const tableToFetcher = {
      access_requests:      fetchAccessRequests,
      work_order_requests:  fetchWORequests,
      orders:               fetchOrders,
      time_entry_requests:  fetchTimeRequests,
      time_clock:           fetchTimeRequests, // edits reference time_clock rows
      lab_signup_requests:  fetchLabRequests,
      temp_access_requests: fetchTempRequests,
      help_requests:        fetchHelpRequests,
      announcements:        fetchAnnouncements,
      network_change_requests: fetchNetworkChanges,
    };
    const tables = Object.keys(tableToFetcher);
    console.log('[NotificationBell] Setting up per-table realtime subscriptions for:', tables);

    const channel = supabase.channel('notif-realtime-' + Date.now());
    tables.forEach(table => {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => {
          console.log(`[NotificationBell] Realtime event on ${table}:`, payload.eventType);
          tableToFetcher[table]();
        }
      );
    });

    channel.subscribe((status, err) => {
      console.log('[NotificationBell] Realtime subscription status:', status);
      if (err) console.error('[NotificationBell] Realtime subscription error:', err);
      if (status === 'SUBSCRIBED') console.log('[NotificationBell] ✅ Realtime is ACTIVE - listening for changes');
      if (status === 'CHANNEL_ERROR') console.error('[NotificationBell] ❌ Realtime channel error - will retry via polling');
      if (status === 'TIMED_OUT') console.warn('[NotificationBell] ⚠️ Realtime timed out - falling back to polling');
    });

    return () => {
      console.log('[NotificationBell] Cleaning up realtime channel');
      supabase.removeChannel(channel);
    };
  }, [profile?.email, fetchAccessRequests, fetchWORequests, fetchOrders, fetchTimeRequests, fetchLabRequests, fetchTempRequests, fetchHelpRequests, fetchAnnouncements, fetchNetworkChanges]);

  // Persistent ding: play sound every 60 seconds while there are unresolved notifications
  useEffect(() => {
    if (items.length === 0) return;
    const dingInterval = setInterval(() => {
      if (items.length > 0) {
        playNotificationSound();
        setHasNew(true);
      }
    }, 60000);
    return () => clearInterval(dingInterval);
  }, [items.length, playNotificationSound]);

  // ── ACTIONS ──

  // Access Requests
  const approveAccess = (item) => { setRoleModal(item); setSelectedRole('Student'); };
  const confirmApproveAccess = async () => {
    const item = roleModal; if (!item) return; setRoleModal(null); setActionLoading(item.id);
    try {
      const req = item.raw;

      // 1. Mark the access request as approved
      const { error: updateError } = await supabase.from('access_requests').update({
        status: 'Approved',
        processed_by: fullName(),
        processed_date: new Date().toISOString()
      }).eq('request_id', req.request_id);

      if (updateError) {
        console.error('Access request update error:', updateError);
        // Try with just status if other columns don't exist
        const { error: statusOnly } = await supabase.from('access_requests')
          .update({ status: 'Approved' })
          .eq('request_id', req.request_id);
        if (statusOnly) {
          console.error('Status-only update also failed:', statusOnly);
          throw statusOnly;
        }
      }

      // 2. Create the user's profile
      // First check if profile already exists
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', req.email)
        .maybeSingle();

      if (existingProfile) {
        // Profile already exists — just update role/status
        await supabase.from('profiles')
          .update({ role: selectedRole, status: 'Active' })
          .eq('email', req.email);
        showToast(`Approved ${req.first_name} as ${selectedRole}!`, 'success');
        fetchNotifications();
        window.dispatchEvent(new CustomEvent('users-updated'));
        setActionLoading(null);
        return;
      }

      // Generate USR#### user_id via counter RPC — required for time cards & reports
      let generatedUserId = null;
      try {
        const { data: nextId } = await supabase.rpc('get_next_id', { p_type: 'user' });
        if (nextId) generatedUserId = nextId;
      } catch (e) {
        console.warn('get_next_id(user) failed, falling back to timestamp ID:', e.message);
        generatedUserId = `USR${Date.now().toString(36).toUpperCase().slice(-4)}`;
      }

      // Insert new profile — try with UUID first, then without
      const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      const { error: insertError } = await supabase.from('profiles').insert({
        id: uuid,
        email: req.email,
        first_name: req.first_name,
        last_name: req.last_name,
        role: selectedRole,
        status: 'Active',
        user_id: generatedUserId
      });

      if (insertError) {
        console.warn('Profile insert with UUID failed:', insertError.message);
        // Try without id
        const { error: noIdError } = await supabase.from('profiles').insert({
          email: req.email,
          first_name: req.first_name,
          last_name: req.last_name,
          role: selectedRole,
          status: 'Active',
          user_id: generatedUserId
        });
        if (noIdError) throw noIdError;
      }

      // 3. Add to work order assignment rotation
      // Format: "First L." to match existing rotation entries
      try {
        const rotationName = `${req.first_name} ${(req.last_name || '').charAt(0)}.`;
        // Only insert if not already in the rotation (e.g. re-approved user)
        const { data: existingRotation } = await supabase
          .from('assignment_rotation')
          .select('user_email')
          .eq('user_email', req.email)
          .maybeSingle();
        if (!existingRotation) {
          await supabase.from('assignment_rotation').insert({
            user_name: rotationName,
            user_email: req.email,
            role: selectedRole,
            last_assigned_date: null,
            assignment_count: 0,
            status: 'Active'
          });
        } else {
          // Re-approved user — make sure their role and status are current
          await supabase.from('assignment_rotation')
            .update({ role: selectedRole, status: 'Active' })
            .eq('user_email', req.email);
        }
      } catch (rotErr) {
        console.warn('Assignment rotation insert failed (non-fatal):', rotErr.message);
      }

      // 4. Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: fullName(),
          action: 'Approve Access Request',
          entity_type: 'User',
          entity_id: req.email,
          details: `Approved ${req.first_name} ${req.last_name} as ${selectedRole}`
        });
      } catch {}

      showToast(`Approved ${req.first_name} as ${selectedRole}!`, 'success');
      fetchNotifications();
      window.dispatchEvent(new CustomEvent('users-updated'));
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };
  const rejectAccess = async (item) => {
    setActionLoading(item.id);
    try { await supabase.from('access_requests').update({ status: 'Rejected', processed_by: fullName(), processed_date: new Date().toISOString() }).eq('request_id', item.raw.request_id); showToast('Rejected', 'info'); fetchNotifications(); } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };

  // WO Requests
  const approveWO = async (item) => {
    setActionLoading(item.id);
    try {
      const req = item.raw;
      const woId = `WO-${Date.now()}`;
      await supabase.from('work_orders').insert([{ wo_id: woId, description: req.description, priority: req.priority || 'Medium', status: 'Open', asset_id: req.asset_id, asset_name: req.asset_name || '', created_at: new Date().toISOString(), created_by: fullName(), last_updated: new Date().toISOString(), last_updated_by: fullName() }]);
      await supabase.from('work_order_requests').update({ status: 'Approved', processed_by: fullName(), processed_date: new Date().toISOString() }).eq('request_id', req.request_id);
      showToast(`WO ${woId} created!`, 'success'); fetchNotifications();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };
  const rejectWO = async (item) => {
    setActionLoading(item.id);
    try { await supabase.from('work_order_requests').update({ status: 'Rejected', processed_by: fullName(), processed_date: new Date().toISOString() }).eq('request_id', item.raw.request_id); showToast('Rejected', 'info'); fetchNotifications(); } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };

  // Parts Orders
  const approveOrder = async (item) => {
    setActionLoading(item.id);
    try {
      await supabase.from('orders').update({ status: 'Approved', approved_by: fullName(), approved_date: new Date().toISOString() }).eq('order_id', item.raw.order_id);
      // Update linked WOs to "Awaiting Parts" — check both order-level and line-item-level wo_ids
      try {
        const woIds = new Set();
        if (item.raw.work_order_id) woIds.add(item.raw.work_order_id);
        if (item.woIds) item.woIds.forEach(w => woIds.add(w));
        // Also check line items
        if (item.lineItems) item.lineItems.forEach(li => { if (li.wo_id) woIds.add(li.wo_id); });
        for (const woId of woIds) {
          await supabase.from('work_orders').update({
            status: 'Awaiting Parts',
            updated_at: new Date().toISOString(),
            updated_by: fullName()
          }).eq('wo_id', woId);
        }
      } catch (woErr) { console.warn('Failed to update WO statuses:', woErr); }
      showToast('Order approved!', 'success');
      // Notify other components in same tab
      window.dispatchEvent(new CustomEvent('po-updated', { detail: { orderId: item.raw.order_id, action: 'approved' } }));
      fetchNotifications();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };
  const rejectOrder = async (item) => {
    setActionLoading(item.id);
    try { await supabase.from('orders').update({ status: 'Rejected' }).eq('order_id', item.raw.order_id); showToast('Rejected', 'info'); window.dispatchEvent(new CustomEvent('po-updated', { detail: { orderId: item.raw.order_id, action: 'rejected' } })); fetchNotifications(); } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };

  // Time Entry Requests (NEW)
  const approveTime = async (item) => {
    setActionLoading(item.id);
    try {
      const req = item.raw;

      // 1. Look up user profile to get user_id
      let userId = req.user_id || null;
      let userEmail = req.user_email || '';
      let userDisplayName = req.user_name || 'Unknown';
      if (!userId && userEmail) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('email', userEmail)
          .maybeSingle();
        if (profileData?.user_id) userId = profileData.user_id;
      }

      // 2. Generate time clock record ID
      const { data: latest } = await supabase
        .from('time_clock')
        .select('record_id')
        .like('record_id', 'TC%')
        .order('record_id', { ascending: false })
        .limit(1);
      let nextNum = 1;
      if (latest && latest.length > 0) {
        const num = parseInt(latest[0].record_id.replace(/\D/g, ''));
        if (!isNaN(num)) nextNum = num + 1;
      }
      const recordId = `TC${String(nextNum).padStart(6, '0')}`;

      // 3. Build punch_in/punch_out from requested_date + start/end times.
      // Append 'Z' to match the app's local-as-UTC convention (same fix as approveTimeEdit).
      const punchIn = new Date(`${req.requested_date}T${req.start_time || '08:00:00'}Z`);
      const punchOut = req.end_time ? new Date(`${req.requested_date}T${req.end_time}Z`) : null;
      const totalHours = punchOut ? Math.round(((punchOut - punchIn) / 3600000) * 100) / 100 : (parseFloat(req.total_hours) || 0);

      // Week start (Monday)
      const day = punchIn.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const weekStart = new Date(punchIn);
      weekStart.setDate(punchIn.getDate() + mondayOffset);
      weekStart.setHours(0, 0, 0, 0);

      // 4. Insert time_clock record
      const { error: insertError } = await supabase.from('time_clock').insert({
        record_id: recordId,
        user_id: userId,
        user_name: userDisplayName,
        user_email: userEmail,
        class_id: req.class_id || '',
        course_id: req.course_id || '',
        punch_in: punchIn.toISOString(),
        punch_out: punchOut ? punchOut.toISOString() : null,
        total_hours: totalHours,
        status: punchOut ? 'Punched Out' : 'Punched In',
        week_start: weekStart.toISOString(),
        entry_type: req.entry_type || 'Class',
        description: req.reason || '',
        approval_status: 'Approved',
        approved_by: fullName(),
        approved_date: new Date().toISOString()
      });
      if (insertError) throw insertError;

      // 5. Mark the request as approved and link the time clock record
      await supabase.from('time_entry_requests').update({
        status: 'Approved',
        reviewed_by: fullName(),
        review_date: new Date().toISOString(),
        time_clock_record_id: recordId
      }).eq('request_id', req.request_id);

      showToast(`Time entry approved! Created ${recordId} (${totalHours}h)`, 'success');
      fetchNotifications();
    } catch (e) {
      console.error('approveTime error:', e);
      showToast('Error: ' + e.message, 'error');
    }
    setActionLoading(null);
  };

  // Time Entry EDIT Requests — update existing time_clock record
  const approveTimeEdit = async (item) => {
    setActionLoading(item.id);
    try {
      const req = item.raw;
      const tcRecordId = req.time_clock_record_id;
      if (!tcRecordId) throw new Error('No linked time clock record found');

      // Build new punch_in/punch_out from requested_date + start/end times.
      // Append 'Z' to match the app's local-as-UTC convention — times are stored
      // as-if UTC so they display correctly with getUTCHours(). Without 'Z', JS
      // parses as local time and toISOString() shifts by the CDT offset (+5h).
      const punchIn = new Date(`${req.requested_date}T${req.start_time || '08:00:00'}Z`);
      const punchOut = req.end_time ? new Date(`${req.requested_date}T${req.end_time}Z`) : null;
      const totalHours = punchOut ? Math.round(((punchOut - punchIn) / 3600000) * 100) / 100 : (parseFloat(req.total_hours) || 0);

      // Update the existing time_clock record with new times
      const { error: updateError } = await supabase.from('time_clock').update({
        punch_in: punchIn.toISOString(),
        punch_out: punchOut ? punchOut.toISOString() : null,
        total_hours: totalHours,
        status: punchOut ? 'Punched Out' : 'Punched In',
        description: `Edited: ${req.reason || ''}`,
        approval_status: 'Approved',
        approved_by: fullName(),
        approved_date: new Date().toISOString()
      }).eq('record_id', tcRecordId);
      if (updateError) throw updateError;

      // Mark the edit request as approved
      await supabase.from('time_entry_requests').update({
        status: 'Approved',
        reviewed_by: fullName(),
        review_date: new Date().toISOString()
      }).eq('request_id', req.request_id);

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: fullName(),
          action: 'Approve Time Edit',
          entity_type: 'Time Clock',
          entity_id: tcRecordId,
          details: `Approved edit for ${req.user_name}: ${req.start_time}–${req.end_time} (${totalHours}h). Reason: ${req.reason || 'N/A'}`
        });
      } catch {}

      const delta = item.editDetail ? item.editDetail.hoursDelta : 0;
      const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
      showToast(`Time edit approved! ${tcRecordId} updated (${deltaStr}h)`, 'success');
      fetchNotifications();
    } catch (e) {
      console.error('approveTimeEdit error:', e);
      showToast('Error: ' + e.message, 'error');
    }
    setActionLoading(null);
  };
  const openRejectTime = (item) => { setRejectModal({ ...item, rejectType: 'time' }); setRejectReason(''); };

  // Lab Change Requests
  const openLabApproveModal = (item) => {
    // Pre-check all additions and cancellations; instructor can uncheck any before confirming
    const adds = {};
    (item.labDetail?.addedKeys || []).forEach(k => { adds[k] = true; });
    const cancels = {};
    (item.labDetail?.cancelledKeys || []).forEach(k => { cancels[k] = true; });
    setLabApproveAdds(adds);
    setLabApproveCancels(cancels);
    setLabModal(item);
  };

  const confirmApproveLab = async () => {
    if (!labModal) return;
    setActionLoading(labModal.id);
    try {
      const req = labModal.raw;
      const courseId = req.course_id || req.class_id || '';
      const userEmail = req.user_email;
      const userName  = req.user_name || 'Unknown';

      const slotsToCancel = Object.entries(labApproveCancels).filter(([, v]) => v).map(([k]) => k);
      const slotsToAdd    = Object.entries(labApproveAdds).filter(([, v]) => v).map(([k]) => k);

      // 1. Cancel the approved cancellations
      for (const slotKey of slotsToCancel) {
        const [dateStr, hourStr] = (slotKey || '').split('_');
        if (!dateStr || !hourStr) continue;
        const targetDate = new Date(dateStr + 'T12:00:00');
        const hour = parseInt(hourStr);
        await supabase.from('lab_signup')
          .update({ status: 'Cancelled' })
          .eq('user_email', userEmail)
          .eq('date', targetDate.toISOString())
          .eq('start_time', `${String(hour).padStart(2, '0')}:00:00`)
          .eq('class_id', courseId)
          .neq('status', 'Cancelled');
      }

      // 2. Create signups for approved additions
      if (slotsToAdd.length > 0) {
        const { data: maxRow } = await supabase
          .from('lab_signup').select('signup_id')
          .order('signup_id', { ascending: false }).limit(1).maybeSingle();
        let maxNum = 0;
        if (maxRow?.signup_id) {
          const num = parseInt(maxRow.signup_id.replace('SU', ''));
          if (!isNaN(num)) maxNum = num;
        }
        const rows = [];
        for (const slotKey of slotsToAdd) {
          const [dateStr, hourStr] = (slotKey || '').split('_');
          if (!dateStr || !hourStr) continue;
          const targetDate = new Date(dateStr + 'T12:00:00');
          const hour = parseInt(hourStr);
          const { data: existing } = await supabase.from('lab_signup').select('signup_id')
            .eq('user_email', userEmail).eq('date', targetDate.toISOString())
            .eq('start_time', `${String(hour).padStart(2, '0')}:00:00`)
            .neq('status', 'Cancelled').maybeSingle();
          if (existing) continue;
          maxNum++;
          rows.push({
            signup_id: 'SU' + String(maxNum).padStart(6, '0'),
            user_id: null, user_name: userName, user_email: userEmail, class_id: courseId,
            date: targetDate.toISOString(),
            start_time: `${String(hour).padStart(2, '0')}:00:00`,
            end_time:   `${String(hour + 1).padStart(2, '0')}:00:00`,
            status: 'Confirmed', created_at: new Date().toISOString(),
          });
        }
        if (rows.length > 0) {
          const { error: insertErr } = await supabase.from('lab_signup').insert(rows);
          if (insertErr) throw insertErr;
        }
      }

      // 3. Mark request as approved
      await supabase.from('lab_signup_requests')
        .update({ status: 'Approved', reviewed_by: fullName(), reviewed_date: new Date().toISOString() })
        .eq('request_id', req.request_id);

      showToast(
        `Lab change approved — ${slotsToAdd.length} slot(s) added, ${slotsToCancel.length} cancelled`,
        'success'
      );
      setLabModal(null);
      fetchNotifications();
    } catch (e) {
      console.error('confirmApproveLab error:', e);
      showToast('Error: ' + e.message, 'error');
    }
    setActionLoading(null);
  };

  const openRejectLab = (item) => {
    setRejectModal({ ...item, rejectType: 'lab' });
    setRejectReason('');
  };

  // Temp Access Requests
  const openApproveTempAccess = (item) => {
    setTempModal(item);
    setTempRole(item.raw.requested_role || 'Work Study');
    setTempDays(item.raw.days_requested || 3);
    // For permission-type: pre-select all requested permissions
    if (item.raw.request_type === 'permissions') {
      const permMap = {};
      (item.raw.requested_permissions || []).forEach(p => { permMap[p.permission_id] = true; });
      setTempApprovePerms(permMap);
    } else {
      setTempApprovePerms({});
    }
  };
  const confirmApproveTempAccess = async () => {
    const item = tempModal; if (!item) return; setTempModal(null); setActionLoading(item.id);
    try {
      const req = item.raw;
      const expiry = new Date(); expiry.setDate(expiry.getDate() + tempDays);
      const isPermType = req.request_type === 'permissions';

      if (isPermType) {
        // Permission-type: store approved permissions, do NOT change user role
        const approvedPerms = (req.requested_permissions || []).filter(p => tempApprovePerms[p.permission_id]);
        await supabase.from('temp_access_requests').update({
          status: 'Active',
          approved_permissions: approvedPerms,
          approved_days: tempDays,
          reviewed_by: fullName(),
          review_date: new Date().toISOString(),
          expiry_date: expiry.toISOString()
        }).eq('request_id', req.request_id);
        showToast(`Granted ${approvedPerms.length} permission${approvedPerms.length !== 1 ? 's' : ''} to ${req.user_name} for ${tempDays} days!`, 'success');
      } else {
        // Role-type: existing behavior — change user role
        await supabase.from('temp_access_requests').update({
          status: 'Active',
          approved_role: tempRole,
          approved_days: tempDays,
          reviewed_by: fullName(),
          review_date: new Date().toISOString(),
          expiry_date: expiry.toISOString()
        }).eq('request_id', req.request_id);
        // Elevate user role
        if (req.user_email) {
          await supabase.from('profiles').update({ role: tempRole }).eq('email', req.user_email);
        }
        showToast(`Approved ${req.user_name} as ${tempRole} for ${tempDays} days!`, 'success');
      }
      fetchNotifications();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };
  const rejectTempAccess = async (item) => {
    setActionLoading(item.id);
    try { await supabase.from('temp_access_requests').update({ status: 'Rejected', reviewed_by: fullName(), review_date: new Date().toISOString() }).eq('request_id', item.raw.request_id); showToast('Rejected', 'info'); fetchNotifications(); } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };

  // Volunteer Punch Approval
  // Reject with reason (for time entries)
  const confirmRejectWithReason = async () => {
    if (!rejectModal) return;
    if (!rejectReason.trim()) { showToast('Reason is required', 'error'); return; }
    const item = rejectModal; setRejectModal(null); setActionLoading(item.id);
    try {
      if (item.rejectType === 'time') {
        await supabase.from('time_entry_requests').update({
          status: 'Rejected',
          rejection_reason: rejectReason.trim(),
          reviewed_by: fullName(),
          review_date: new Date().toISOString()
        }).eq('request_id', item.raw.request_id);
      } else if (item.rejectType === 'lab') {
        const req = item.raw;
        // 1. Mark the request rejected with the reason
        await supabase.from('lab_signup_requests').update({
          status: 'Rejected',
          reviewed_by: fullName(),
          reviewed_date: new Date().toISOString(),
          review_notes: rejectReason.trim(),
        }).eq('request_id', req.request_id);

        // 2. Send an in-app announcement to the student explaining why
        const weekLabel = req.week_start
          ? new Date(req.week_start + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : req.week_start || 'Unknown week';
        const { data: annRows, error: annErr } = await supabase.from('announcements').insert({
          recipient_email: (req.user_email || '').toLowerCase(),
          sender_email: profile.email,
          sender_name: fullName(),
          subject: `Lab Schedule Change Rejected — Week of ${weekLabel}`,
          body: `Your lab schedule change request for the week of ${weekLabel} (${req.course_id || req.class_id || ''}) was not approved.\n\nReason: ${rejectReason.trim()}\n\nIf you have questions, please speak with your instructor.`,
          read: false,
          created_at: new Date().toISOString(),
        }).select();
        if (annErr) throw new Error('Announcement failed: ' + annErr.message);
        if (!annRows || annRows.length === 0) throw new Error('Announcement insert returned no rows — check RLS policy on announcements table');

        // 3. Audit log
        try {
          await supabase.from('audit_log').insert({
            user_email: profile.email,
            user_name: fullName(),
            action: 'Reject Lab Change',
            entity_type: 'Lab Signup Request',
            entity_id: req.request_id,
            details: `Rejected lab change for ${req.user_name} (week ${req.week_start}). Reason: ${rejectReason.trim()}`
          });
        } catch {}
      }
      showToast('Rejected — student has been notified', 'info');
      fetchNotifications();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setActionLoading(null);
  };

  // Help Request — Acknowledge
  const acknowledgeHelp = async (item) => {
    setActionLoading(item.id);
    try {
      const req = item.raw;
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 30);

      await supabase.from('help_requests').update({
        status: 'acknowledged',
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: fullName(),
        expires_at: expiresAt.toISOString(),
      }).eq('request_id', req.request_id);

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: fullName(),
          action: 'Acknowledge Help Request',
          entity_type: 'Help Request',
          entity_id: req.request_id,
          details: `Acknowledged help request from ${req.user_name}`
        });
      } catch {}

      const locLabel = req.location ? ` in Room ${req.location}` : '';
      showToast(`Acknowledged — ${req.user_name}${locLabel} notified!`, 'success');
      fetchNotifications();
    } catch (e) {
      console.error('acknowledgeHelp error:', e);
      showToast('Error: ' + e.message, 'error');
    }
    setActionLoading(null);
  };

  // Help Request — Dismiss (clear without going to student)
  const dismissHelp = async (item) => {
    setActionLoading(item.id);
    try {
      await supabase.from('help_requests').update({
        status: 'cancelled',
      }).eq('request_id', item.raw.request_id);
      showToast('Help request dismissed', 'info');
      fetchNotifications();
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
    setActionLoading(null);
  };

  // ── RENDER ──
  const count = items.length;

  const formatTime = (d) => { if (!d) return ''; const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); if (m < 1) return 'Just now'; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; };

  const typeLabels = {
    access: 'ACCESS REQUEST', wo: 'WO REQUEST', parts: 'PARTS ORDER',
    time: 'TIME ENTRY REQUEST', time_edit: 'TIME EDIT REQUEST',
    lab: 'LAB CHANGE', temp: 'TEMP ROLE ACCESS', temp_perm: 'TEMP PERMISSIONS',
    // volunteer_punch removed — time clock punches are auto-approved
    announcement: 'ANNOUNCEMENT',
    wo_assignment: 'WORK ORDER ASSIGNED',
    help: 'NEEDS HELP',
    netchg: 'NETWORK CHANGE'
  };

  // Navigate to announcements without marking read — InboxTab marks read on expand
  const viewAnnouncement = () => {
    setOpen(false);
    navigate('/announcements');
  };

  // Mark a WO assignment notification read and navigate to work orders
  const viewWOAssignment = async (item) => {
    setOpen(false);
    try {
      await supabase.from('announcements').update({ read: true }).eq('id', item.raw.id);
    } catch {}
    navigate('/work-orders');
  };

  // Navigate to the Network Map page so the instructor can review pending changes.
  // Approve/Reject lives on the Network Map page (existing UI), so this is view-only.
  const viewNetworkChange = () => {
    setOpen(false);
    navigate('/network-map');
  };

  const renderActions = (item) => {
    const disabled = actionLoading === item.id;
    switch (item.type) {
      case 'access': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => approveAccess(item)}><span className="material-icons" aria-hidden="true">check</span>Approve</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => rejectAccess(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'wo': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => approveWO(item)}><span className="material-icons" aria-hidden="true">check</span>Approve</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => rejectWO(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'parts': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => approveOrder(item)}><span className="material-icons" aria-hidden="true">check</span>Approve</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => rejectOrder(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'time': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => approveTime(item)}><span className="material-icons" aria-hidden="true">check</span>Approve</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => openRejectTime(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'time_edit': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => approveTimeEdit(item)}><span className="material-icons" aria-hidden="true">check</span>Approve Edit</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => openRejectTime(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'lab': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => openLabApproveModal(item)}><span className="material-icons" aria-hidden="true">rule</span>Review</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => openRejectLab(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'temp': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => openApproveTempAccess(item)}><span className="material-icons" aria-hidden="true">check</span>Approve</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => rejectTempAccess(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      case 'temp_perm': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => openApproveTempAccess(item)}><span className="material-icons" aria-hidden="true">check</span>Review</button><button className="nbtn nbtn-reject" disabled={disabled} onClick={() => rejectTempAccess(item)}><span className="material-icons" aria-hidden="true">close</span>Reject</button></>);
      // volunteer_punch removed — time clock punches are auto-approved at punch time
      case 'announcement': return (<button className="nbtn nbtn-view" onClick={() => viewAnnouncement(item)}><span className="material-icons" aria-hidden="true">visibility</span>View</button>);
      case 'wo_assignment': return (<button className="nbtn nbtn-view" style={{ background: '#f59f00' }} onClick={() => viewWOAssignment(item)}><span className="material-icons" aria-hidden="true">assignment_ind</span>View WO</button>);
      case 'help': return (<><button className="nbtn nbtn-approve" disabled={disabled} onClick={() => acknowledgeHelp(item)}><span className="material-icons" aria-hidden="true">check</span>On My Way</button><button className="nbtn nbtn-secondary" disabled={disabled} onClick={() => dismissHelp(item)}><span className="material-icons" aria-hidden="true">close</span>Dismiss</button></>);
      case 'netchg': return (<button className="nbtn nbtn-view" style={{ background: '#7c3aed' }} onClick={() => viewNetworkChange(item)} aria-label={`Review network change request for ${item.raw?.ip_address || 'device'} on the Network Map page`}><span className="material-icons" aria-hidden="true">router</span>Review on Network Map</button>);
      default: return null;
    }
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* role=status + aria-live makes toasts audible to screen readers */}
      {toast && <div className={`nbell-toast nbell-toast-${toast.type}`} role="status" aria-live="polite">{toast.msg}</div>}

      {/* Bell Button */}
      <button
        className={`nbell-btn ${hasNew ? 'has-new' : ''}`}
        onClick={() => { setOpen(!open); setHasNew(false); fetchNotifications(); }}
        aria-label={`Notifications${count > 0 ? `, ${count} pending` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notification-panel"
        title="Notifications"
      >
        <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.3rem' }}>notifications</span>
        {count > 0 && <span className="nbell-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
      </button>

      {/* Panel — non-modal popover (aria-modal=false): user can still interact with rest of page.
          The bell-button's aria-controls points here via id="notification-panel". */}
      {open && (
        <div id="notification-panel" className="nbell-panel" role="dialog" aria-modal="false" aria-labelledby="notification-panel-title">
          <div className="nbell-panel-header">
            <h4 id="notification-panel-title">Notifications</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {count > 0 && <span className="nbell-badge">{count} pending</span>}
              {/* Push notification subscribe/unsubscribe toggle */}
              {isInstructor && pushStatus !== 'unsupported' && (
                <button
                  onClick={pushStatus === 'subscribed' ? unsubscribeFromPush : subscribeToPush}
                  disabled={pushStatus === 'loading' || pushStatus === 'blocked'}
                  aria-label={
                    pushStatus === 'subscribed' ? 'Disable push notifications to your phone'
                    : pushStatus === 'blocked' ? 'Push notifications blocked in browser settings'
                    : pushStatus === 'loading' ? 'Subscribing to push notifications'
                    : 'Enable push notifications to your phone'
                  }
                  aria-pressed={pushStatus === 'subscribed'}
                  title={
                    pushStatus === 'subscribed' ? 'Push notifications ON — tap to disable'
                    : pushStatus === 'blocked' ? 'Notifications blocked in browser settings'
                    : pushStatus === 'loading' ? 'Subscribing...'
                    : 'Enable push notifications to your phone'
                  }
                  style={{
                    background: 'none', border: 'none', cursor: pushStatus === 'blocked' ? 'not-allowed' : 'pointer',
                    padding: '4px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 0.2s',
                  }}
                >
                  <span className="material-icons" aria-hidden="true" style={{
                    fontSize: '1.2rem',
                    color: pushStatus === 'subscribed' ? '#40c057'
                      : pushStatus === 'blocked' ? '#fa5252'
                      : pushStatus === 'loading' ? '#fab005'
                      : '#adb5bd',
                  }}>
                    {pushStatus === 'subscribed' ? 'phone_android' : pushStatus === 'blocked' ? 'phone_disabled' : 'phone_android'}
                  </span>
                </button>
              )}
            </div>
          </div>
          <div className="nbell-panel-body">
            {items.length === 0 ? (
              <div className="nbell-empty"><span className="material-icons" aria-hidden="true">notifications_none</span><p>No pending notifications</p></div>
            ) : items.map(item => (
              <div key={item.id} className="nbell-item">
                <div className="nbell-item-top">
                  <span className="material-icons nbell-item-icon" aria-hidden="true" style={{ color: item.color }}>{item.icon}</span>
                  <div className="nbell-item-content">
                    <div className="nbell-item-type" style={{ color: item.color }}>{typeLabels[item.type]}</div>
                    <div className="nbell-item-title">{item.title}</div>
                    <div className="nbell-item-sub">{item.subtitle}</div>
                  </div>
                  <div className="nbell-item-time">{formatTime(item.date)}</div>
                </div>
                {/* Expanded PO detail */}
                {item.type === 'parts' && item.lineItems && item.lineItems.length > 0 && (
                  <div className="nbell-po-detail">
                    {item.woIds && item.woIds.length > 0 && item.woDescs && (
                      <div className="nbell-po-wos">
                        {item.woIds.map(woId => (
                          <div key={woId} className="nbell-po-wo-line">
                            <span className="nbell-po-wo-id">{woId}</span>
                            <span className="nbell-po-wo-desc">{item.woDescs[woId] || ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="nbell-po-items">
                      {item.lineItems.map((li, idx) => (
                        <div key={idx} className="nbell-po-line">
                          <span className="nbell-po-qty">{li.quantity}x</span>
                          <span className="nbell-po-desc">{li.description}{li.part_number ? ` (${li.part_number})` : ''}</span>
                          <span className="nbell-po-price">${parseFloat(li.subtotal || 0).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Expanded Lab Change detail — diff view */}
                {item.type === 'lab' && item.labDetail && (
                  <div className="nbell-po-detail" style={{ fontSize: '0.72rem' }}>
                    {/* Week progress */}
                    {item.labDetail.requiredHours > 0 && (
                      <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#495057', fontWeight: 600, fontSize: '0.68rem' }}>Week Progress:</span>
                        <div style={{ flex: 1, height: '6px', background: '#e9ecef', borderRadius: '4px', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', borderRadius: '4px', transition: 'width 0.3s',
                            background: item.labDetail.weekSignupCount >= item.labDetail.requiredHours ? '#40c057' : '#e64980',
                            width: `${Math.min(100, (item.labDetail.weekSignupCount / item.labDetail.requiredHours) * 100)}%`,
                          }} />
                        </div>
                        <span style={{
                          fontWeight: 700, fontSize: '0.68rem', whiteSpace: 'nowrap',
                          color: item.labDetail.weekSignupCount >= item.labDetail.requiredHours ? '#2f9e44' : '#c92a2a',
                        }}>
                          {item.labDetail.weekSignupCount}/{item.labDetail.requiredHours} hr{item.labDetail.requiredHours !== 1 ? 's' : ''}
                          {item.labDetail.weekSignupCount >= item.labDetail.requiredHours ? ' ✓' : ` (${item.labDetail.requiredHours - item.labDetail.weekSignupCount} short)`}
                        </span>
                      </div>
                    )}
                    {/* Reason */}
                    {item.labDetail.reason && (
                      <div style={{ marginBottom: '8px', padding: '4px 8px', background: '#fff3cd', borderRadius: '4px', color: '#664d03' }}>
                        <strong>Reason:</strong> {item.labDetail.reason}
                      </div>
                    )}
                    {/* Summary badge row */}
                    <div style={{ display: 'flex', gap: '5px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.62rem', color: '#868e96', textTransform: 'uppercase', fontWeight: 600, marginRight: '2px' }}>Changes:</span>
                      {item.labDetail.cancelledSlots.length > 0 && (
                        <span style={{ padding: '1px 7px', background: '#ffe3e3', color: '#c92a2a', borderRadius: '4px', fontWeight: 700, fontSize: '0.68rem' }}>
                          −{item.labDetail.cancelledSlots.length} cancelled
                        </span>
                      )}
                      {item.labDetail.addedSlots.length > 0 && (
                        <span style={{ padding: '1px 7px', background: '#d3f9d8', color: '#2f9e44', borderRadius: '4px', fontWeight: 700, fontSize: '0.68rem' }}>
                          +{item.labDetail.addedSlots.length} added
                        </span>
                      )}
                      {item.labDetail.addedConflicts?.some(Boolean) && (
                        <span style={{ padding: '1px 7px', background: '#fff3cd', color: '#e67700', borderRadius: '4px', fontWeight: 700, fontSize: '0.68rem' }}>
                          ⚠ {item.labDetail.addedConflicts.filter(Boolean).length} full slot{item.labDetail.addedConflicts.filter(Boolean).length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {item.labDetail.keptSlots.length > 0 && (
                        <span style={{ padding: '1px 7px', background: '#e9ecef', color: '#495057', borderRadius: '4px', fontWeight: 700, fontSize: '0.68rem' }}>
                          {item.labDetail.keptSlots.length} unchanged
                        </span>
                      )}
                      {item.labDetail.cancelledSlots.length === 0 && item.labDetail.addedSlots.length === 0 && (
                        <span style={{ fontSize: '0.68rem', color: '#868e96', fontStyle: 'italic' }}>No net changes detected</span>
                      )}
                    </div>
                    {/* Cancelling */}
                    {item.labDetail.cancelledSlots.length > 0 && (
                      <div style={{ marginBottom: '6px' }}>
                        <div style={{ fontWeight: 600, color: '#c92a2a', fontSize: '0.64rem', textTransform: 'uppercase', marginBottom: '3px', letterSpacing: '0.03em' }}>
                          ✕ Cancelling
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                          {item.labDetail.cancelledSlots.map((s, i) => (
                            <span key={i} style={{ padding: '2px 6px', background: '#ffe3e3', border: '1px solid #ffa8a8', borderRadius: '3px', fontSize: '0.68rem', color: '#c92a2a', textDecoration: 'line-through' }}>{s}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Adding */}
                    {item.labDetail.addedSlots.length > 0 && (
                      <div style={{ marginBottom: '6px' }}>
                        <div style={{ fontWeight: 600, color: '#2f9e44', fontSize: '0.64rem', textTransform: 'uppercase', marginBottom: '3px', letterSpacing: '0.03em' }}>
                          + Adding
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                          {item.labDetail.addedSlots.map((s, i) => (
                            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '2px 6px', background: item.labDetail.addedConflicts?.[i] ? '#fff9db' : '#d3f9d8', border: `1px solid ${item.labDetail.addedConflicts?.[i] ? '#ffd43b' : '#8ce99a'}`, borderRadius: '3px', fontSize: '0.68rem', color: item.labDetail.addedConflicts?.[i] ? '#e67700' : '#2f9e44' }}>
                              {s}
                              {item.labDetail.addedConflicts?.[i] && <span title="Slot is currently full" style={{ fontSize: '0.6rem', fontWeight: 700, background: '#e67700', color: '#fff', padding: '0 3px', borderRadius: '2px', lineHeight: '1.4' }}>FULL</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Keeping */}
                    {item.labDetail.keptSlots.length > 0 && (
                      <div>
                        <div style={{ fontWeight: 600, color: '#868e96', fontSize: '0.64rem', textTransform: 'uppercase', marginBottom: '3px', letterSpacing: '0.03em' }}>
                          ↔ Keeping
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                          {item.labDetail.keptSlots.map((s, i) => (
                            <span key={i} style={{ padding: '2px 6px', background: '#f1f3f5', border: '1px solid #dee2e6', borderRadius: '3px', fontSize: '0.68rem', color: '#868e96' }}>{s}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Expanded Time Entry Request detail */}
                {item.type === 'time' && item.timeDetail && (
                  <div className="nbell-po-detail" style={{ fontSize: '0.72rem' }}>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '4px', flexWrap: 'wrap' }}>
                      <span><strong>Class:</strong> {item.timeDetail.courseId}</span>
                      <span><strong>Date:</strong> {item.timeDetail.date}</span>
                      <span><strong>Hours:</strong> {item.timeDetail.totalHours}h</span>
                    </div>
                    <div style={{ marginBottom: '4px' }}>
                      <span><strong>Time:</strong> {item.timeDetail.startTime} – {item.timeDetail.endTime}</span>
                    </div>
                    {item.timeDetail.reason && (
                      <div style={{ padding: '4px 8px', background: '#f3f0ff', borderRadius: '4px', color: '#5f3dc4' }}>
                        <strong>Reason:</strong> {item.timeDetail.reason}
                      </div>
                    )}
                  </div>
                )}
                {/* Expanded Time EDIT Request detail — before/after comparison */}
                {item.type === 'time_edit' && item.editDetail && (
                  <div className="nbell-po-detail" style={{ fontSize: '0.72rem' }}>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '6px', flexWrap: 'wrap' }}>
                      <span><strong>Class:</strong> {item.editDetail.courseId}</span>
                      <span><strong>Date:</strong> {item.editDetail.date}</span>
                      <span style={{ fontSize: '0.65rem', color: '#868e96' }}>{item.editDetail.recordId}</span>
                    </div>
                    {/* Before / After comparison */}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                      <div style={{ flex: 1, padding: '6px 8px', background: '#f8f9fa', borderRadius: '4px', border: '1px solid #dee2e6' }}>
                        <div style={{ fontWeight: 600, color: '#868e96', fontSize: '0.6rem', textTransform: 'uppercase', marginBottom: '3px' }}>Current</div>
                        <div>{item.editDetail.origStartTime} – {item.editDetail.origEndTime}</div>
                        <div style={{ fontWeight: 600 }}>{item.editDetail.origHours}h</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', color: '#868e96', fontSize: '1rem' }}>→</div>
                      <div style={{ flex: 1, padding: '6px 8px', background: '#fff4e6', borderRadius: '4px', border: '1px solid #e8590c' }}>
                        <div style={{ fontWeight: 600, color: '#e8590c', fontSize: '0.6rem', textTransform: 'uppercase', marginBottom: '3px' }}>Proposed</div>
                        <div>{item.editDetail.newStartTime} – {item.editDetail.newEndTime}</div>
                        <div style={{ fontWeight: 600 }}>{item.editDetail.newHours}h
                          <span style={{
                            marginLeft: '4px',
                            fontSize: '0.65rem',
                            color: item.editDetail.hoursDelta > 0 ? '#2b8a3e' : item.editDetail.hoursDelta < 0 ? '#e03131' : '#868e96'
                          }}>
                            ({item.editDetail.hoursDelta > 0 ? '+' : ''}{item.editDetail.hoursDelta}h)
                          </span>
                        </div>
                      </div>
                    </div>
                    {item.editDetail.reason && (
                      <div style={{ padding: '4px 8px', background: '#fff4e6', borderRadius: '4px', color: '#e8590c' }}>
                        <strong>Reason:</strong> {item.editDetail.reason}
                      </div>
                    )}
                  </div>
                )}
                {/* Temp Permission Request detail */}
                {item.type === 'temp_perm' && item.raw?.requested_permissions && (
                  <div className="nbell-po-detail" style={{ fontSize: '0.72rem' }}>
                    {item.raw.reason && (
                      <div style={{ marginBottom: '6px', padding: '4px 8px', background: '#f3e8ff', borderRadius: '4px', color: '#7c3aed' }}>
                        <strong>Reason:</strong> {item.raw.reason}
                      </div>
                    )}
                    <div style={{ fontWeight: 600, color: '#7c3aed', fontSize: '0.65rem', textTransform: 'uppercase', marginBottom: '4px' }}>
                      Requested Permissions ({item.raw.requested_permissions.length})
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                      {item.raw.requested_permissions.map((p, i) => (
                        <span key={i} style={{ padding: '2px 6px', background: '#f3e8ff', borderRadius: '3px', fontSize: '0.65rem', color: '#5f3dc4' }}>
                          {p.page}: {p.feature.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Temp Role Request reason */}
                {item.type === 'temp' && item.raw?.reason && (
                  <div className="nbell-po-detail" style={{ fontSize: '0.72rem' }}>
                    <div style={{ padding: '4px 8px', background: '#fff9db', borderRadius: '4px', color: '#664d03' }}>
                      <strong>Reason:</strong> {item.raw.reason}
                    </div>
                  </div>
                )}
                <div className="nbell-item-actions">{renderActions(item)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Approve Access Role Modal */}
      {roleModal && (
        <div className="nbell-modal-overlay" onClick={e => e.target === e.currentTarget && setRoleModal(null)}>
          <div className="nbell-modal" ref={roleDialogRef} role="dialog" aria-modal="true" aria-labelledby="role-modal-title">
            <div className="nbell-modal-header"><h4 id="role-modal-title"><span className="material-icons" aria-hidden="true" style={{ color: '#40c057' }}>person_add</span> Approve Access</h4><button className="nbell-modal-close" aria-label="Close" onClick={() => setRoleModal(null)}>&times;</button></div>
            <div className="nbell-modal-body">
              <p>Approve <strong>{roleModal.raw?.first_name} {roleModal.raw?.last_name}</strong> ({roleModal.raw?.email})?</p>
              <label className="nbell-label" htmlFor="role-modal-select">Assign Role</label>
              <select id="role-modal-select" className="nbell-select" value={selectedRole} onChange={e => setSelectedRole(e.target.value)}>
                <option value="Student">Student</option><option value="Work Study">Work Study</option><option value="Instructor">Instructor</option>
              </select>
            </div>
            <div className="nbell-modal-footer">
              <button className="nbtn nbtn-secondary" onClick={() => setRoleModal(null)}>Cancel</button>
              <button className="nbtn nbtn-approve" onClick={confirmApproveAccess}><span className="material-icons" aria-hidden="true">check</span>Approve as {selectedRole}</button>
            </div>
          </div>
        </div>
      )}

      {/* Approve Temp Access Modal */}
      {tempModal && (
        <div className="nbell-modal-overlay" onClick={e => e.target === e.currentTarget && setTempModal(null)}>
          <div className="nbell-modal" ref={tempDialogRef} role="dialog" aria-modal="true" aria-labelledby="temp-modal-title" style={{ maxWidth: tempModal.raw?.request_type === 'permissions' ? 520 : 420 }}>
            <div className="nbell-modal-header">
              <h4 id="temp-modal-title">
                <span className="material-icons" aria-hidden="true" style={{ color: tempModal.raw?.request_type === 'permissions' ? '#7c3aed' : '#f59f00' }}>
                  {tempModal.raw?.request_type === 'permissions' ? 'tune' : 'vpn_key'}
                </span>
                {tempModal.raw?.request_type === 'permissions' ? ' Approve Permissions' : ' Approve Temp Access'}
              </h4>
              <button className="nbell-modal-close" aria-label="Close" onClick={() => setTempModal(null)}>&times;</button>
            </div>
            <div className="nbell-modal-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
              {tempModal.raw?.request_type === 'permissions' ? (
                <>
                  <p><strong>{tempModal.raw?.user_name}</strong> requests {(tempModal.raw?.requested_permissions || []).length} specific permission(s) for {tempModal.raw?.days_requested} days.</p>
                  {tempModal.raw?.reason && <p style={{ fontSize: '0.85rem', color: '#868e96', fontStyle: 'italic' }}>Reason: {tempModal.raw.reason}</p>}
                  <label className="nbell-label">Duration (days)</label>
                  <select className="nbell-select" value={tempDays} onChange={e => setTempDays(parseInt(e.target.value))}>
                    <option value={1}>1 day</option><option value={2}>2 days</option><option value={3}>3 days</option><option value={5}>5 days</option><option value={7}>1 week</option>
                  </select>
                  <label className="nbell-label">Permissions to Grant</label>
                  <p style={{ fontSize: '0.78rem', color: '#868e96', margin: '0 0 8px' }}>Uncheck any you don't want to approve.</p>
                  <div style={{ border: '1px solid #e9ecef', borderRadius: 8, overflow: 'hidden' }}>
                    {(tempModal.raw?.requested_permissions || []).map((p, i) => {
                      const checked = !!tempApprovePerms[p.permission_id];
                      return (
                        <div key={i} onClick={() => setTempApprovePerms(prev => {
                          const next = { ...prev };
                          if (next[p.permission_id]) delete next[p.permission_id]; else next[p.permission_id] = true;
                          return next;
                        })} style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                          borderBottom: i < (tempModal.raw.requested_permissions.length - 1) ? '1px solid #f1f3f5' : 'none',
                          cursor: 'pointer', background: checked ? '#f3e8ff' : 'white',
                          transition: 'background 0.15s',
                        }}>
                          <input type="checkbox" checked={checked} onChange={() => {}} style={{ width: 14, height: 14, accentColor: '#7c3aed', cursor: 'pointer' }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#1a1a2e' }}>
                              <span style={{ color: '#7c3aed', fontSize: '0.72rem', fontWeight: 600 }}>{p.page}</span>
                              {' — '}
                              {p.feature.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                            </div>
                            {p.description && <div style={{ fontSize: '0.7rem', color: '#868e96' }}>{p.description}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 8, fontSize: '0.78rem', color: '#495057' }}>
                    <strong>{Object.keys(tempApprovePerms).length}</strong> of {(tempModal.raw?.requested_permissions || []).length} selected
                  </div>
                </>
              ) : (
                <>
                  <p><strong>{tempModal.raw?.user_name}</strong> requests {tempModal.raw?.requested_role} access for {tempModal.raw?.days_requested} days.</p>
                  {tempModal.raw?.reason && <p style={{ fontSize: '0.85rem', color: '#868e96', fontStyle: 'italic' }}>Reason: {tempModal.raw.reason}</p>}
                  <label className="nbell-label">Approved Role</label>
                  <select className="nbell-select" value={tempRole} onChange={e => setTempRole(e.target.value)}>
                    <option value="Work Study">Work Study</option><option value="Instructor">Instructor</option>
                  </select>
                  <label className="nbell-label">Duration (days)</label>
                  <select className="nbell-select" value={tempDays} onChange={e => setTempDays(parseInt(e.target.value))}>
                    <option value={1}>1 day</option><option value={2}>2 days</option><option value={3}>3 days</option><option value={5}>5 days</option><option value={7}>1 week</option>
                  </select>
                </>
              )}
            </div>
            <div className="nbell-modal-footer">
              <button className="nbtn nbtn-secondary" onClick={() => setTempModal(null)}>Cancel</button>
              <button
                className="nbtn nbtn-approve"
                onClick={confirmApproveTempAccess}
                disabled={tempModal.raw?.request_type === 'permissions' && Object.keys(tempApprovePerms).length === 0}
              >
                <span className="material-icons" aria-hidden="true">check</span>
                {tempModal.raw?.request_type === 'permissions'
                  ? `Approve ${Object.keys(tempApprovePerms).length} Permission${Object.keys(tempApprovePerms).length !== 1 ? 's' : ''}`
                  : 'Approve'
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lab Partial-Approval Modal */}
      {labModal && (() => {
        const detail = labModal.labDetail || {};
        const approvedAddCount    = Object.values(labApproveAdds).filter(Boolean).length;
        const approvedCancelCount = Object.values(labApproveCancels).filter(Boolean).length;
        const totalApproved = approvedAddCount + approvedCancelCount;
        return (
          <div className="nbell-modal-overlay" onClick={e => e.target === e.currentTarget && setLabModal(null)}>
            <div className="nbell-modal" ref={labDialogRef} role="dialog" aria-modal="true" aria-labelledby="lab-modal-title" style={{ maxWidth: 480 }}>
              <div className="nbell-modal-header">
                <h4 id="lab-modal-title"><span className="material-icons" aria-hidden="true" style={{ color: '#e64980' }}>science</span> Review Lab Change</h4>
                <button className="nbell-modal-close" aria-label="Close" onClick={() => setLabModal(null)}>&times;</button>
              </div>

              <div className="nbell-modal-body" style={{ maxHeight: 440, overflowY: 'auto', paddingBottom: 8 }}>
                {/* Student + week context */}
                <p style={{ margin: '0 0 4px', fontSize: '0.9rem' }}>
                  <strong>{labModal.raw?.user_name}</strong> — {labModal.raw?.course_id}
                </p>
                <p style={{ margin: '0 0 10px', fontSize: '0.82rem', color: '#868e96' }}>
                  Week of {labModal.raw?.week_start}
                  {detail.requiredHours > 0 && (
                    <span style={{ marginLeft: 10, fontWeight: 600, color: detail.weekSignupCount >= detail.requiredHours ? '#2f9e44' : '#c92a2a' }}>
                      · {detail.weekSignupCount}/{detail.requiredHours} hr{detail.requiredHours !== 1 ? 's' : ''} this week
                      {detail.weekSignupCount >= detail.requiredHours ? ' ✓' : ` (${detail.requiredHours - detail.weekSignupCount} short)`}
                    </span>
                  )}
                </p>

                {/* Reason */}
                {detail.reason && (
                  <div style={{ marginBottom: 12, padding: '6px 10px', background: '#fff3cd', borderRadius: 6, fontSize: '0.82rem', color: '#664d03' }}>
                    <strong>Reason:</strong> {detail.reason}
                  </div>
                )}

                {/* Cancellations */}
                {(detail.cancelledKeys || []).length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.75rem', color: '#c92a2a', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                      ✕ Cancellations — uncheck to keep
                    </div>
                    <div style={{ border: '1px solid #ffa8a8', borderRadius: 8, overflow: 'hidden' }}>
                      {(detail.cancelledKeys || []).map((key, i) => {
                        const checked = !!labApproveCancels[key];
                        return (
                          <div key={i} onClick={() => setLabApproveCancels(prev => ({ ...prev, [key]: !prev[key] }))}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer',
                              background: checked ? '#fff5f5' : '#fff', borderBottom: i < (detail.cancelledKeys.length - 1) ? '1px solid #ffe3e3' : 'none', transition: 'background 0.15s' }}>
                            <input type="checkbox" checked={checked} onChange={() => {}} style={{ width: 14, height: 14, accentColor: '#fa5252', cursor: 'pointer' }} />
                            <span style={{ fontSize: '0.82rem', color: checked ? '#c92a2a' : '#868e96', textDecoration: checked ? 'line-through' : 'none', flex: 1 }}>
                              {detail.cancelledSlots?.[i] || key}
                            </span>
                            {!checked && <span style={{ fontSize: '0.68rem', color: '#868e96', fontStyle: 'italic' }}>will keep</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Additions */}
                {(detail.addedKeys || []).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.75rem', color: '#2f9e44', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                      + Additions — uncheck to deny
                    </div>
                    <div style={{ border: '1px solid #8ce99a', borderRadius: 8, overflow: 'hidden' }}>
                      {(detail.addedKeys || []).map((key, i) => {
                        const checked = !!labApproveAdds[key];
                        const isConflict = detail.addedConflicts?.[i];
                        return (
                          <div key={i} onClick={() => setLabApproveAdds(prev => ({ ...prev, [key]: !prev[key] }))}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer',
                              background: checked ? (isConflict ? '#fff9db' : '#f4fce3') : '#fff',
                              borderBottom: i < (detail.addedKeys.length - 1) ? '1px solid #d3f9d8' : 'none', transition: 'background 0.15s' }}>
                            <input type="checkbox" checked={checked} onChange={() => {}} style={{ width: 14, height: 14, accentColor: '#40c057', cursor: 'pointer' }} />
                            <span style={{ fontSize: '0.82rem', color: checked ? (isConflict ? '#e67700' : '#2f9e44') : '#868e96', flex: 1 }}>
                              {detail.addedSlots?.[i] || key}
                            </span>
                            {isConflict && (
                              <span style={{ fontSize: '0.65rem', fontWeight: 700, background: '#e67700', color: '#fff', padding: '1px 5px', borderRadius: 3 }}>FULL</span>
                            )}
                            {!checked && <span style={{ fontSize: '0.68rem', color: '#868e96', fontStyle: 'italic' }}>denied</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Kept slots — informational only */}
                {(detail.keptSlots || []).length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.68rem', color: '#868e96', textTransform: 'uppercase', marginBottom: 4 }}>↔ Unchanged slots (no action needed)</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {detail.keptSlots.map((s, i) => (
                        <span key={i} style={{ padding: '2px 6px', background: '#f1f3f5', border: '1px solid #dee2e6', borderRadius: 3, fontSize: '0.68rem', color: '#868e96' }}>{s}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="nbell-modal-footer" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button className="nbtn nbtn-secondary" onClick={() => setLabModal(null)}>Cancel</button>
                <button className="nbtn nbtn-reject" onClick={() => { setLabModal(null); openRejectLab(labModal); }}>
                  <span className="material-icons" aria-hidden="true">close</span>Reject All
                </button>
                <button className="nbtn nbtn-approve" disabled={totalApproved === 0 || actionLoading === labModal.id}
                  onClick={confirmApproveLab}>
                  <span className="material-icons" aria-hidden="true">check</span>
                  Approve {totalApproved > 0 ? `(${approvedCancelCount > 0 ? `−${approvedCancelCount}` : ''}${approvedCancelCount > 0 && approvedAddCount > 0 ? ' ' : ''}${approvedAddCount > 0 ? `+${approvedAddCount}` : ''})` : ''}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Reject with Reason Modal */}
      {rejectModal && (
        <div className="nbell-modal-overlay" onClick={e => e.target === e.currentTarget && setRejectModal(null)}>
          <div className="nbell-modal" ref={rejectDialogRef} role="dialog" aria-modal="true" aria-labelledby="reject-modal-title">
            <div className="nbell-modal-header"><h4 id="reject-modal-title"><span className="material-icons" aria-hidden="true" style={{ color: '#fa5252' }}>close</span> {rejectModal.rejectType === 'lab' ? 'Reject Lab Change' : 'Reject'}</h4><button className="nbell-modal-close" aria-label="Close" onClick={() => setRejectModal(null)}>&times;</button></div>
            <div className="nbell-modal-body">
              {rejectModal.rejectType === 'lab' ? (
                <p>Provide a reason for rejecting <strong>{rejectModal.raw?.user_name}</strong>'s lab schedule change. This reason will be sent to the student as a notification.</p>
              ) : (
                <p>Provide a reason for rejecting this {rejectModal.rejectType === 'time' ? 'time entry' : 'request'}.</p>
              )}
              <label className="nbell-label" htmlFor="reject-modal-reason">Reason <span style={{ color: '#fa5252' }} aria-hidden="true">*</span><span className="sr-only"> required</span></label>
              <textarea id="reject-modal-reason" className="nbell-select" rows={3} required aria-required="true" style={{ resize: 'vertical', fontFamily: 'inherit' }} placeholder={rejectModal.rejectType === 'lab' ? 'e.g., Slots are fully booked, please choose different times...' : 'Enter reason...'} value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            </div>
            <div className="nbell-modal-footer">
              <button className="nbtn nbtn-secondary" onClick={() => setRejectModal(null)}>Cancel</button>
              <button className="nbtn nbtn-reject" onClick={confirmRejectWithReason}><span className="material-icons" aria-hidden="true">close</span>Reject {rejectModal.rejectType === 'lab' ? '& Notify Student' : ''}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
