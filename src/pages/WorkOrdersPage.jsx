/**
 * RICT CMMS - Work Orders Page (React)
 * Faithfully reproduces the old Google Apps Script Work Orders page.
 * 
 * Features:
 * - Open/Closed/Requests tab toggle with badge counts
 * - Search + priority/status filters
 * - Data table with late WO highlighting (overdue=red, soon=orange)
 * - View WO detail modal with inline-editable fields (permission gated)
 * - Work Log section (add/delete entries with hours+mins)
 * - Parts Used section (search inventory, add custom parts)
 * - Documents section (upload to Supabase storage)
 * - PM Procedure display (auto-linked from PM schedule)
 * - Create/Edit WO modal
 * - Close WO modal with final notes
 * - Reopen WO (instructor only)
 * - Delete WO (double confirm, cascading deletes)
 * - Approve/Reject requests
 * - Full permission gating via hasPerm()
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import RejectionModal from '@/components/RejectionModal';
import { useRejectionNotification } from '@/hooks/useRejectionNotification';

// Custom status select dropdown with color swatches
function StatusSelectComponent({ statuses: statusList, value, onChange, id, className, style, placeholder, allOption, colorMap }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  // Close on outside click
  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedColor = value ? (colorMap[value] || '#adb5bd') : null;
  const displayLabel = value || allOption || placeholder || 'Select status...';

  return (
    <div ref={ref} className="status-select-wrapper" style={{ position: 'relative', ...style }}>
      <button
        type="button"
        id={id}
        className={className || 'form-input form-input-sm'}
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left', width: '100%', background: '#fff' }}
      >
        {selectedColor && (
          <span className="status-dot" style={{ width: 10, height: 10, borderRadius: '50%', background: selectedColor, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
        )}
        <span style={{ flex: 1, color: value ? '#1a1a2e' : '#868e96' }}>{displayLabel}</span>
        <span className="material-icons" style={{ fontSize: 16, color: '#868e96' }}>{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div className="status-dropdown" style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
          background: '#fff', border: '1px solid #dee2e6', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)', zIndex: 100, overflow: 'hidden',
          minWidth: 180
        }}>
          {allOption && (
            <div
              onClick={() => { onChange(''); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                cursor: 'pointer', fontSize: '0.85rem',
                background: !value ? '#f0f4ff' : 'transparent',
                fontWeight: !value ? 600 : 400,
                borderBottom: '1px solid #f1f3f5'
              }}
              onMouseEnter={e => { if (value) e.currentTarget.style.background = '#f8f9fa'; }}
              onMouseLeave={e => { if (value) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'linear-gradient(135deg, #228be6, #40c057, #fab005)', flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
              <span style={{ flex: 1, color: '#495057' }}>{allOption}</span>
              {!value && <span className="material-icons" style={{ fontSize: 16, color: '#228be6' }}>check</span>}
            </div>
          )}
          {statusList.map(s => {
            const hex = colorMap[s.status_name] || '#adb5bd';
            const isActive = s.status_name === value;
            return (
              <div
                key={s.status_name}
                onClick={() => { onChange(s.status_name); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  cursor: 'pointer', fontSize: '0.85rem',
                  background: isActive ? '#f0f4ff' : 'transparent',
                  fontWeight: isActive ? 600 : 400,
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f8f9fa'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: hex, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                <span style={{ flex: 1, color: '#1a1a2e' }}>{s.status_name}</span>
                {isActive && <span className="material-icons" style={{ fontSize: 16, color: '#228be6' }}>check</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Smart tooltip — flips below the badge if there isn't enough room above
// Simple badge — hover handlers are passed in from the page level so the tooltip
// can be rendered outside the card/table entirely (no portal needed).
function AssigneeBadge({ names, onEnter, onLeave }) {
  const ref = React.useRef(null);
  return (
    <span
      ref={ref}
      onMouseEnter={() => { if (ref.current) onEnter(ref.current.getBoundingClientRect(), names); }}
      onMouseLeave={onLeave}
      style={{
        fontSize: '0.68rem', fontWeight: 600, padding: '1px 6px',
        borderRadius: 10, background: '#e7f5ff', color: '#1864ab',
        border: '1px solid #a5d8ff', whiteSpace: 'nowrap', cursor: 'default',
      }}
    >
      +{names.length}
    </span>
  );
}

export default function WorkOrdersPage() {
  const { user, profile } = useAuth();

  // ---------- STATE ----------
  const [currentView, setCurrentView] = useState('open'); // open | closed | requests
  const [woData, setWoData] = useState([]);
  const [requestsData, setRequestsData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [assignedToMeFilter, setAssignedToMeFilter] = useState(false);

  // Dropdowns
  const [statuses, setStatuses] = useState([]);
  const [assets, setAssets] = useState([]);
  const [users, setUsers] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [defaultWorkMinutes, setDefaultWorkMinutes] = useState(15);
  const [timeIncrement, setTimeIncrement] = useState(5);
  const [priorityDays, setPriorityDays] = useState({ High: 7, Medium: 21, Low: 45 });

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [showWorkLogModal, setShowWorkLogModal] = useState(false);
  const [showPartsModal, setShowPartsModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  // Current editing data
  const [currentWO, setCurrentWO] = useState(null);
  const [viewStatus, setViewStatus] = useState(''); // tracks status in detail modal for custom dropdown
  const [viewDescription, setViewDescription] = useState('');
  const [viewPriority, setViewPriority] = useState('');
  const [viewAssetId, setViewAssetId] = useState('');
  // viewAssignEmail removed — assignment is now managed via work_order_assignments table
  const [viewDueDate, setViewDueDate] = useState('');
  // Multi-assignment state
  const [woAssignments, setWoAssignments] = useState({}); // { [wo_id]: [{email, name}] } for list display
  const [woHasDocs, setWoHasDocs] = useState({}); // { [wo_id]: count } — true count of documents attached, used to show paperclip icon in list
  const [viewAssignees, setViewAssignees] = useState([]);  // assignees for the currently open detail modal
  const [assigneeSaving, setAssigneeSaving] = useState(false);
  const [addAssigneeEmail, setAddAssigneeEmail] = useState(''); // instructor dropdown selection
  const [formData, setFormData] = useState({});
  const [workLogForm, setWorkLogForm] = useState({ hours: 0, mins: 15, notes: '' });
  const [closeNotes, setCloseNotes] = useState('');
  const [approveForm, setApproveForm] = useState({ priority: 'Medium', assignEmail: '', notes: '' });
  const [currentRequest, setCurrentRequest] = useState(null);

  // Parts modal
  const [partsSearch, setPartsSearch] = useState('');
  const [selectedParts, setSelectedParts] = useState([]);
  const [customPartName, setCustomPartName] = useState('');
  const [customPartQty, setCustomPartQty] = useState(1);

  // Work logs & parts for current WO
  const [workLogs, setWorkLogs] = useState([]);
  const [partsUsed, setPartsUsed] = useState([]);
  const [woDocs, setWoDocs] = useState([]);
  const [linkedPOs, setLinkedPOs] = useState([]);

  // PM Procedure URL (fetched when viewing a PM work order)
  const [pmProcedureUrl, setPmProcedureUrl] = useState(null);
  const [pmProcedureName, setPmProcedureName] = useState('');

  // Generate PO modal
  const [showGeneratePO, setShowGeneratePO] = useState(false);
  const [poForm, setPoForm] = useState({ vendorId: '', vendorName: '', otherVendor: '', notes: '' });
  const [poLines, setPoLines] = useState([{ partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' }]);
  const [poSaving, setPoSaving] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [existingPO, setExistingPO] = useState(null); // detected existing PO for same vendor
  const [addToExisting, setAddToExisting] = useState(false); // user chose to add to existing

  // Toast
  const [toast, setToast] = useState(null);

  // Rejection modal
  const [rejectTarget, setRejectTarget] = useState(null);
  const { sendRejectionNotification } = useRejectionNotification();

  // Page-level assignee tooltip state — rendered outside .card so overflow:hidden can't clip it
  const [assigneeTooltip, setAssigneeTooltip] = useState(null); // { x, y, goDown, names }
  const showAssigneeTooltip = React.useCallback((rect, names) => {
    const estH = names.length * 22 + 16;
    const goDown = rect.top < estH + 12;
    setAssigneeTooltip({
      x: Math.round(rect.left + rect.width / 2),
      y: goDown ? Math.round(rect.bottom + 8) : Math.round(rect.top - estH - 8),
      goDown,
      names,
    });
  }, []);
  const hideAssigneeTooltip = React.useCallback(() => setAssigneeTooltip(null), []);

  // Track whether initial data load has completed — prevents loading spinner on tab switch
  const hasLoadedRef = useRef(false);

  // ---------- HELPERS ----------
  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const { hasPerm } = usePermissions('Work Orders');

  /**
   * Send a notification to the notification bell when a user is assigned to a work order.
   * Inserts into the announcements table (recipient_email-scoped, read=false).
   * Skips silently if the assignee is the same person doing the assigning (self-assign).
   */
  const sendWOAssignmentNotification = useCallback(async (assigneeEmail, woId, woDescription) => {
    if (!profile?.email || !assigneeEmail) return;
    // Don't notify if you're assigning yourself
    if (assigneeEmail.toLowerCase() === profile.email.toLowerCase()) return;
    try {
      const senderName = profile
        ? `${profile.first_name || ''} ${(profile.last_name || '').charAt(0)}.`.trim()
        : 'Instructor';
      await supabase.from('announcements').insert({
        recipient_email: assigneeEmail.toLowerCase(),
        sender_email: profile.email,
        sender_name: senderName,
        subject: `Work Order Assigned: ${woId}`,
        body: woDescription
          ? `You have been assigned to work order ${woId}: "${woDescription}". Please log in to view the details.`
          : `You have been assigned to work order ${woId}. Please log in to view the details.`,
        read: false,
        notification_type: 'wo_assignment',
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      // Non-critical — don't surface notification errors to the user
      console.warn('sendWOAssignmentNotification failed:', e.message);
    }
  }, [profile]);

  // ---------- ASSIGNMENT MANAGEMENT ----------

  /**
   * Add a user to the work_order_assignments junction table.
   * Instructors can add anyone; students/work study can only add themselves.
   * If this is the first assignee, also syncs assigned_to/assigned_email on the WO.
   */
  const addAssignee = async (email, name) => {
    if (!currentWO || currentWO.isClosed) return;
    if (viewAssignees.find(a => a.email === email)) {
      showToast('Already assigned to this user', 'error'); return;
    }
    setAssigneeSaving(true);
    const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
    try {
      // If no primary assignee yet, update work_orders FIRST so that when the
      // realtime listener fires (triggered by the junction insert below) and calls
      // loadWODetailSilent, it fetches a row that already has the correct primary.
      if (!currentWO.assigned_email) {
        const { error: woErr } = await supabase.from('work_orders').update({
          assigned_email: email,
          assigned_to: name,
          updated_at: new Date().toISOString(),
          updated_by: userName
        }).eq('wo_id', currentWO.wo_id).select();
        if (woErr) {
          showToast('Could not set primary assignee: ' + woErr.message, 'error');
          setAssigneeSaving(false);
          return;
        }
        setCurrentWO(prev => prev ? { ...prev, assigned_email: email, assigned_to: name } : prev);
      }

      // Insert into junction table (this fires realtime → loadWODetailSilent).
      // By this point work_orders already has the correct primary, so the silent
      // reload will display the right name.
      // Use .select() so RLS silent failures (0 rows, no error) are detectable.
      const { data: insRows, error } = await supabase.from('work_order_assignments').insert({
        wo_id: currentWO.wo_id,
        user_email: email,
        user_name: name,
        assigned_by: userName
      }).select();
      if (error) throw error;
      if (!insRows || insRows.length === 0) {
        showToast('Add failed — permission denied. Check RLS policy.', 'error');
        setAssigneeSaving(false);
        return;
      }

      const newAssignees = [...viewAssignees, { email, name }];
      setViewAssignees(newAssignees);

      // Reset dropdown so instructor can pick the next person immediately
      setAddAssigneeEmail('');

      // Update local assignments map for list display
      setWoAssignments(prev => ({ ...prev, [currentWO.wo_id]: newAssignees }));

      // Notify the assignee via the notification bell
      await sendWOAssignmentNotification(email, currentWO.wo_id, currentWO.description);

      showToast(`${name} added to work order`, 'success');
      loadWorkOrders(currentViewRef.current, true);
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setAssigneeSaving(false);
  };

  /**
   * Remove a user from the work_order_assignments junction table.
   * Anyone can remove themselves; instructors can remove anyone.
   * If the removed user was the primary assignee, promotes the next in line.
   */
  const removeAssignee = async (email) => {
    if (!currentWO || currentWO.isClosed) return;
    setAssigneeSaving(true);
    const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
    try {
      // Use .select() so RLS silent failures (0 rows, no error) are detectable
      const { data: delRows, error } = await supabase.from('work_order_assignments')
        .delete().eq('wo_id', currentWO.wo_id).eq('user_email', email).select();
      if (error) throw error;
      if (!delRows || delRows.length === 0) {
        showToast('Remove failed — permission denied. Check RLS policy.', 'error');
        setAssigneeSaving(false);
        return;
      }

      const newAssignees = viewAssignees.filter(a => a.email !== email);
      setViewAssignees(newAssignees);

      // The removed person was primary if they were viewAssignees[0] (first by assigned_at).
      // Use viewAssignees[0] rather than currentWO.assigned_email which can be stale.
      const wasPrimary = viewAssignees[0]?.email === email;
      if (wasPrimary) {
        const newPrimary = newAssignees[0] || null;
        await supabase.from('work_orders').update({
          assigned_email: newPrimary?.email || '',
          assigned_to: newPrimary?.name || '',
          updated_at: new Date().toISOString(),
          updated_by: userName
        }).eq('wo_id', currentWO.wo_id).select();
        setCurrentWO(prev => prev ? {
          ...prev,
          assigned_email: newPrimary?.email || '',
          assigned_to: newPrimary?.name || ''
        } : prev);
      }

      // Update local assignments map for list display
      setWoAssignments(prev => ({ ...prev, [currentWO.wo_id]: newAssignees }));

      showToast('Assignee removed', 'success');
      loadWorkOrders(currentViewRef.current, true);
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setAssigneeSaving(false);
  };

  /**
   * Promote a non-primary assignee to be the lead (primary assignee).
   * Updates work_orders.assigned_to / assigned_email and reorders viewAssignees
   * so the chosen person appears first (index 0) in the chip list.
   */
  const promoteToLead = async (email) => {
    if (!currentWO || currentWO.isClosed) return;
    const target = viewAssignees.find(a => a.email === email);
    if (!target || viewAssignees[0]?.email === email) return; // already lead
    setAssigneeSaving(true);
    const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
    try {
      const { error } = await supabase.from('work_orders').update({
        assigned_email: target.email,
        assigned_to: target.name,
        updated_at: new Date().toISOString(),
        updated_by: userName
      }).eq('wo_id', currentWO.wo_id).select();
      if (error) throw error;

      // Reorder locally: put target first, preserve rest
      const reordered = [target, ...viewAssignees.filter(a => a.email !== email)];
      setViewAssignees(reordered);
      setCurrentWO(prev => prev ? { ...prev, assigned_email: target.email, assigned_to: target.name } : prev);
      setWoAssignments(prev => ({ ...prev, [currentWO.wo_id]: reordered }));
      showToast(`${target.name} is now the lead`, 'success');
      loadWorkOrders(currentViewRef.current, true);
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setAssigneeSaving(false);
  };

  const formatDate = (d) => {
    if (!d) return '-';
    // Always extract the YYYY-MM-DD portion and re-parse as LOCAL midnight.
    // Supabase may return a bare date string ("2026-03-17"), a UTC timestamp
    // ("2026-03-17T00:00:00+00:00"), or a Z-suffixed ISO string ("2026-03-17T00:00:00.000Z").
    // Passing any of these directly to new Date() interprets them as UTC, which shifts
    // the displayed date back one day in Central time (UTC-6).
    // Extracting the date portion and appending T00:00:00 (no offset) forces local-time parsing.
    if (typeof d === 'string') {
      const datePart = d.substring(0, 10); // grab "YYYY-MM-DD" from any format
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        const dt = new Date(datePart + 'T00:00:00');
        if (!isNaN(dt)) return dt.toLocaleDateString();
      }
    }
    const dt = new Date(d);
    if (isNaN(dt)) return '-';
    return dt.toLocaleDateString();
  };

  const formatDateTime = (d) => {
    if (!d) return '-';
    // For datetime display we want the real timestamp, but if a bare date string arrives
    // (e.g. from a Supabase date column) we still need to parse it as local midnight
    // to avoid the UTC→CST shift. Full ISO strings with time are fine as-is.
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.substring(0, 10)) && d.length === 10) {
      const dt = new Date(d + 'T00:00:00');
      if (!isNaN(dt)) return dt.toLocaleString();
    }
    const dt = new Date(d);
    if (isNaN(dt)) return '-';
    return dt.toLocaleString();
  };

  const formatHoursToTime = (h) => {
    if (!h || h === 0) return '0:00';
    const hrs = Math.floor(h);
    const mins = Math.round((h - hrs) * 60);
    return hrs + ':' + (mins < 10 ? '0' : '') + mins;
  };

  const formatNameShort = (name) => {
    if (!name) return 'Unassigned';
    const parts = name.trim().split(' ');
    if (parts.length === 1) return parts[0];
    return parts[0] + ' ' + parts[parts.length - 1].charAt(0) + '.';
  };

  const dueDateClass = (dueDate, isClosed) => {
    if (!dueDate || isClosed) return '';
    // Extract YYYY-MM-DD and parse as local midnight — same reasoning as formatDate.
    // Works whether Supabase returns "2026-03-17", "2026-03-17T00:00:00+00:00", etc.
    let due;
    if (typeof dueDate === 'string') {
      const datePart = dueDate.substring(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        due = new Date(datePart + 'T00:00:00');
      }
    }
    if (!due) due = new Date(dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.floor((due - today) / (1000 * 60 * 60 * 24));
    if (diff < 0) return 'overdue';
    if (diff <= 3) return 'soon';
    return '';
  };

  // Build a status→color map from loaded wo_status rows
  const statusColorMap = useMemo(() => {
    const map = {};
    statuses.forEach(s => {
      if (s.color) map[s.status_name] = s.color;
    });
    return map;
  }, [statuses]);

  // Returns inline style object for a status badge using the db color
  const getStatusStyle = (statusName, isClosed) => {
    const hex = statusColorMap[statusName];
    if (!hex) {
      // Fallback: closed = green, open = blue
      return isClosed
        ? { background: '#d3f9d8', color: '#2b8a3e' }
        : { background: '#e7f5ff', color: '#1971c2' };
    }
    // Convert hex to RGB to create a light tinted background
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Light background: mix with white at ~15% opacity
    const bg = `rgba(${r}, ${g}, ${b}, 0.15)`;
    // Darken the hex color for text
    const darken = (v) => Math.max(0, Math.floor(v * 0.6));
    const textColor = `rgb(${darken(r)}, ${darken(g)}, ${darken(b)})`;
    return { background: bg, color: textColor };
  };


  const highlightMatch = (text) => {
    if (!search || !text) return text || '';
    const str = String(text);
    const idx = str.toLowerCase().indexOf(search.toLowerCase());
    if (idx === -1) return str;
    return (
      <>{str.substring(0, idx)}<mark style={{ background: '#fff3bf', padding: '0 1px', borderRadius: 2 }}>{str.substring(idx, idx + search.length)}</mark>{str.substring(idx + search.length)}</>
    );
  };

  const getImageUrl = (fileId) => {
    if (!fileId) return '';
    if (fileId.startsWith('http')) return fileId;
    // Supabase storage path
    if (fileId.includes('/')) {
      const { data } = supabase.storage.from('inventory-images').getPublicUrl(fileId);
      return data?.publicUrl || '';
    }
    // Legacy Google Drive ID
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w100`;
  };

  // Helper to fetch PM procedure URL for a PM work order
  const fetchPmProcedure = async (wo) => {
    setPmProcedureUrl(null);
    setPmProcedureName('');
    if (wo?.is_pm === 'Yes' && wo?.pm_id) {
      try {
        const { data: pm } = await supabase
          .from('pm_schedules')
          .select('procedure_file_id, pm_name')
          .eq('pm_id', wo.pm_id)
          .maybeSingle();
        if (pm?.procedure_file_id) {
          const { data } = supabase.storage.from('pm-procedure').getPublicUrl(pm.procedure_file_id);
          setPmProcedureUrl(data?.publicUrl || null);
          setPmProcedureName(pm.procedure_file_id.split('/').pop() || 'PM Procedure');
        }
      } catch (err) {
        console.warn('Failed to fetch PM procedure:', err);
      }
    }
  };

  // ---------- LOAD MATERIAL ICONS FONT ----------
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
  }, []);

  // Sync view-modal controlled state when a WO is opened or realtime-updated
  useEffect(() => {
    if (currentWO) {
      setViewStatus(currentWO.status || '');
      setViewDescription(currentWO.description || '');
      setViewPriority(currentWO.priority || '');
      setViewAssetId(currentWO.asset_id || '');
      setViewDueDate(currentWO.due_date ? currentWO.due_date.split('T')[0] : '');
    }
  }, [currentWO?.wo_id, currentWO?.status]);

  // ---------- LOAD DATA ----------
  useEffect(() => {
    if (!user) return;
    loadDropdowns();
    loadWorkOrders('open');
    loadRequests();
  }, [user?.id, profile?.role]);

  // Silent refresh when browser tab regains focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        loadWorkOrders(currentViewRef.current, true); // silent refresh
        loadRequests();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // ---------- REALTIME SUBSCRIPTIONS ----------
  const currentWORef = React.useRef(null);
  const currentViewRef = React.useRef('open');
  const showViewModalRef = React.useRef(false); // tracks whether the view modal is actually open
  // NOTE: currentWORef is updated synchronously inside loadWODetail (not via useEffect)
  // to prevent the realtime handler from firing against a stale WO while a new one is loading.
  useEffect(() => { currentViewRef.current = currentView; }, [currentView]);
  useEffect(() => { showViewModalRef.current = showViewModal; }, [showViewModal]);

  useEffect(() => {
    if (!user) return;

    const channel = supabase.channel('wo-realtime')
      // Work orders list changes (INSERT, UPDATE, DELETE)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, () => {
        const view = currentViewRef.current;
        if (view !== 'closed') loadWorkOrders(view, true);
        // Only refresh WO detail if the view modal is actually open
        const wo = currentWORef.current;
        if (wo && !wo.isClosed && showViewModalRef.current) {
          loadWODetailSilent(wo.wo_id);
        }
      })
      // Closed work orders
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders_closed' }, () => {
        if (currentViewRef.current === 'closed') loadWorkOrders('closed', true);
      })
      // Requests
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_requests' }, () => {
        loadRequests();
      })
      // Work logs
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_log' }, (payload) => {
        const wo = currentWORef.current;
        if (wo && showViewModalRef.current && (payload.new?.wo_id === wo.wo_id || payload.old?.wo_id === wo.wo_id)) {
          loadWODetailSilent(wo.wo_id);
        }
      })
      // Parts used
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_parts' }, (payload) => {
        const wo = currentWORef.current;
        if (wo && showViewModalRef.current && (payload.new?.wo_id === wo.wo_id || payload.old?.wo_id === wo.wo_id)) {
          loadWODetailSilent(wo.wo_id);
        }
      })
      // Documents
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_documents' }, (payload) => {
        const wo = currentWORef.current;
        if (wo && showViewModalRef.current && (payload.new?.wo_id === wo.wo_id || payload.old?.wo_id === wo.wo_id)) {
          loadWODetailSilent(wo.wo_id);
        }
        // Keep the list-level paperclip icon in sync. Use surgical updates when payload
        // carries the wo_id; otherwise fall back to a silent list reload.
        const changedWoId = payload.new?.wo_id || payload.old?.wo_id;
        if (changedWoId) {
          if (payload.eventType === 'INSERT') {
            setWoHasDocs(prev => ({ ...prev, [changedWoId]: (prev[changedWoId] || 0) + 1 }));
          } else if (payload.eventType === 'DELETE') {
            setWoHasDocs(prev => {
              const next = { ...prev };
              const cur = (next[changedWoId] || 0) - 1;
              if (cur <= 0) delete next[changedWoId]; else next[changedWoId] = cur;
              return next;
            });
          }
          // UPDATE events on documents don't change which WO they're attached to in normal flows;
          // ignore them for count purposes.
        } else {
          // Payload missing wo_id (REPLICA IDENTITY may not be FULL on this table) — reconcile.
          loadWorkOrders(currentViewRef.current, true);
        }
      })
      // Linked Purchase Orders (refresh when PO status changes e.g. received)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        const wo = currentWORef.current;
        if (wo && showViewModalRef.current && (payload.new?.work_order_id === wo.wo_id || payload.old?.work_order_id === wo.wo_id)) {
          loadWODetailSilent(wo.wo_id);
        }
      })
      // Assignments (multi-user) — refresh detail if open, refresh list display
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_assignments' }, (payload) => {
        const wo = currentWORef.current;
        const changedWoId = payload.new?.wo_id || payload.old?.wo_id;
        if (wo && showViewModalRef.current && changedWoId === wo.wo_id) {
          loadWODetailSilent(wo.wo_id);
        }
        // Refresh the list assignments map silently
        const view = currentViewRef.current;
        if (view !== 'closed') loadWorkOrders(view, true);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.id]);

  const loadDropdowns = async () => {
    // Statuses
    try {
      const { data, error } = await supabase.from('wo_status').select('*').order('display_order');
      if (error) console.error('wo_status load error:', error);
      console.log('wo_status loaded:', data);
      if (data) setStatuses(data);
    } catch (e) { console.error(e); }

    // Assets
    try {
      const { data } = await supabase.from('assets').select('asset_id, name, status').eq('status', 'Active').order('name');
      if (data) setAssets(data);
    } catch (e) { console.error(e); }

    // Users
    try {
      const { data } = await supabase.from('profiles').select('id, email, first_name, last_name, role, status, time_clock_only').eq('status', 'Active').order('first_name');
      // Filter out TCO users from assignment - they only punch in/out
      const assignableUsers = (data || []).filter(u => u.time_clock_only !== 'Yes');
      if (assignableUsers) setUsers(assignableUsers);
    } catch (e) { console.error(e); }

    // Inventory (for parts modal)
    try {
      const { data } = await supabase.from('inventory').select('part_id, part_name, qty_in_stock, supplier_part_number').eq('status', 'Active');
      if (data) setInventoryItems(data);
    } catch (e) { console.error(e); }

    // Settings: default work time, time increment, priority days
    try {
      const { data } = await supabase.from('settings').select('setting_key, setting_value')
        .in('setting_key', ['default_work_time', 'time_increment', 'priority_high_days', 'priority_medium_days', 'priority_low_days']);
      if (data?.length) {
        const map = {};
        data.forEach(s => { map[s.setting_key] = s.setting_value });
        if (map.default_work_time) setDefaultWorkMinutes(parseInt(map.default_work_time) || 15);
        if (map.time_increment) setTimeIncrement(parseInt(map.time_increment) || 5);
        const pd = { High: 7, Medium: 21, Low: 45 };
        if (map.priority_high_days) pd.High = parseInt(map.priority_high_days) || 7;
        if (map.priority_medium_days) pd.Medium = parseInt(map.priority_medium_days) || 21;
        if (map.priority_low_days) pd.Low = parseInt(map.priority_low_days) || 45;
        setPriorityDays(pd);
      }
    } catch (e) { /* ignore */ }

    // Vendors (for PO generation)
    try {
      const { data } = await supabase.from('vendors').select('*').eq('status', 'Active').order('vendor_name');
      if (data) setVendors(data);
    } catch (e) { console.error(e); }
  };

  const loadWorkOrders = async (view, silent = false) => {
    // Only show loading spinner on initial load — not on silent refreshes or tab returns
    if (!silent && !hasLoadedRef.current) setLoading(true);
    try {
      const table = view === 'closed' ? 'work_orders_closed' : 'work_orders';
      const { data, error } = await supabase.from(table).select('*').order('created_at', { ascending: false });
      if (error) throw error;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      // Helper: extract date portion and parse as local midnight regardless of timestamp format
      const parseDueDate = (d) => {
        if (!d) return 0;
        if (typeof d === 'string') {
          const datePart = d.substring(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return new Date(datePart + 'T00:00:00').getTime();
        }
        return new Date(d).getTime();
      };
      const mapped = (data || []).map(wo => {
        return {
          ...wo,
          isClosed: view === 'closed',
          isLate: wo.due_date && parseDueDate(wo.due_date) < today.getTime() && view !== 'closed'
        };
      });
      setWoData(mapped);
      hasLoadedRef.current = true;

      // Batch-load assignments for list display (shows "+N more" badge)
      if (mapped.length > 0) {
        try {
          const woIds = mapped.map(w => w.wo_id);
          const { data: aData } = await supabase
            .from('work_order_assignments')
            .select('wo_id, user_email, user_name')
            .in('wo_id', woIds);
          const aMap = {};
          (aData || []).forEach(a => {
            if (!aMap[a.wo_id]) aMap[a.wo_id] = [];
            aMap[a.wo_id].push({ email: a.user_email, name: a.user_name });
          });
          // Ensure the primary assignee (work_orders.assigned_email) is always first
          // so the list column shows the correct lead, even after a lead change.
          mapped.forEach(wo => {
            if (wo.assigned_email && aMap[wo.wo_id] && aMap[wo.wo_id].length > 1) {
              const primaryEmail = wo.assigned_email.toLowerCase();
              const arr = aMap[wo.wo_id];
              const primaryIdx = arr.findIndex(a => a.email.toLowerCase() === primaryEmail);
              if (primaryIdx > 0) {
                const [primary] = arr.splice(primaryIdx, 1);
                arr.unshift(primary);
              }
            }
          });
          setWoAssignments(aMap);
        } catch (e) { console.warn('Assignments batch load error:', e); }

        // Batch-load document counts for list display (shows paperclip icon when count > 0)
        try {
          const woIds = mapped.map(w => w.wo_id);
          const { data: dData } = await supabase
            .from('work_order_documents')
            .select('wo_id')
            .in('wo_id', woIds);
          const dMap = {};
          (dData || []).forEach(d => {
            dMap[d.wo_id] = (dMap[d.wo_id] || 0) + 1;
          });
          setWoHasDocs(dMap);
        } catch (e) { console.warn('Documents batch load error:', e); }
      } else {
        // Empty list: clear the docs map so stale data doesn't linger
        setWoHasDocs({});
      }
    } catch (e) {
      if (!hasLoadedRef.current) showToast('Error loading work orders: ' + e.message, 'error');
    }
    setLoading(false);
  };

  const loadRequests = async () => {
    try {
      const { data } = await supabase.from('work_order_requests').select('*').eq('status', 'Pending').order('request_date', { ascending: false });
      if (data) setRequestsData(data);
    } catch (e) { console.error(e); }
  };

  const loadWODetail = async (woId) => {
    // Find in current data
    const wo = woData.find(w => w.wo_id === woId);
    if (!wo) { showToast('Work order not found', 'error'); return; }

    // Clear stale data from any previously-viewed WO BEFORE opening the modal.
    // This prevents old work logs / parts from flashing in while the new WO's data loads.
    setWorkLogs([]);
    setPartsUsed([]);
    setWoDocs([]);
    setLinkedPOs([]);
    setViewAssignees([]);
    setAddAssigneeEmail('');
    setPmProcedureUrl(null);
    setPmProcedureName('');

    // Update the ref synchronously so the realtime handler immediately knows which WO
    // is active. Relying solely on the useEffect means the ref can lag one render behind,
    // causing the handler to call loadWODetailSilent for the *old* WO while the new one loads.
    currentWORef.current = wo;
    setCurrentWO(wo);

    // Load work logs
    try {
      const { data } = await supabase.from('work_log').select('*').eq('wo_id', woId).order('timestamp', { ascending: false });
      setWorkLogs(data || []);
    } catch (e) { console.error(e); }

    // Load assignees from junction table
    try {
      const { data: aData } = await supabase
        .from('work_order_assignments')
        .select('user_email, user_name, assigned_at')
        .eq('wo_id', woId)
        .order('assigned_at', { ascending: true });
      const assignees = (aData || []).map(a => ({ email: a.user_email, name: a.user_name }));
      // Reorder so the current primary assignee (wo.assigned_email) is always index 0
      if (wo.assigned_email && assignees.length > 1) {
        const primaryEmail = wo.assigned_email.toLowerCase();
        const primaryIdx = assignees.findIndex(a => a.email.toLowerCase() === primaryEmail);
        if (primaryIdx > 0) {
          const [primary] = assignees.splice(primaryIdx, 1);
          assignees.unshift(primary);
        }
      }
      setViewAssignees(assignees);
    } catch (e) { setViewAssignees([]); }

    // Load parts used
    try {
      const { data } = await supabase.from('work_order_parts').select('*').eq('wo_id', woId).order('added_date', { ascending: false });
      setPartsUsed(data || []);
    } catch (e) { console.error(e); }

    // Load documents
    try {
      const { data } = await supabase.from('work_order_documents').select('*').eq('wo_id', woId).order('uploaded_at', { ascending: false });
      setWoDocs(data || []);
    } catch (e) { setWoDocs([]); }

    // Load linked Purchase Orders (check both orders.work_order_id AND line items wo_id)
    try {
      const { data: directPOs } = await supabase.from('orders').select('*').eq('work_order_id', woId).order('order_date', { ascending: false });
      // Also find POs that have line items tagged with this WO
      const { data: lineLinks } = await supabase.from('order_line_items').select('order_id').eq('wo_id', woId);
      const lineOrderIds = [...new Set((lineLinks || []).map(l => l.order_id))];
      let extraPOs = [];
      if (lineOrderIds.length > 0) {
        const { data } = await supabase.from('orders').select('*').in('order_id', lineOrderIds);
        extraPOs = data || [];
      }
      // Merge and deduplicate
      const allPOs = [...(directPOs || [])];
      extraPOs.forEach(po => { if (!allPOs.find(p => p.order_id === po.order_id)) allPOs.push(po); });
      allPOs.sort((a, b) => new Date(b.order_date) - new Date(a.order_date));
      setLinkedPOs(allPOs);
    } catch (e) { setLinkedPOs([]); }

    // Fetch PM procedure if this is a PM work order
    await fetchPmProcedure(wo);

    showViewModalRef.current = true;
    setShowViewModal(true);
  };

  // Silent reload for realtime updates (no loading spinner, no modal reset)
  const loadWODetailSilent = async (woId) => {
    try {
      // Refresh WO data from DB
      const { data: woRow } = await supabase.from('work_orders').select('*').eq('wo_id', woId).single();
      if (woRow) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const parseDueDate = (d) => {
          if (!d) return 0;
          if (typeof d === 'string') {
            const datePart = d.substring(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return new Date(datePart + 'T00:00:00').getTime();
          }
          return new Date(d).getTime();
        };
        const updatedWO = {
          ...woRow,
          isClosed: false,
          isLate: woRow.due_date && parseDueDate(woRow.due_date) < today.getTime()
        };
        setCurrentWO(updatedWO);

        // Refresh PM procedure if needed
        await fetchPmProcedure(updatedWO);
      }

      const { data: logs } = await supabase.from('work_log').select('*').eq('wo_id', woId).order('timestamp', { ascending: false });
      setWorkLogs(logs || []);

      // Reload assignees
      try {
        const { data: aData } = await supabase
          .from('work_order_assignments')
          .select('user_email, user_name, assigned_at')
          .eq('wo_id', woId)
          .order('assigned_at', { ascending: true });
        const assignees = (aData || []).map(a => ({ email: a.user_email, name: a.user_name }));
        // Reorder so the current primary assignee is always first
        const primaryEmail = (woRow?.assigned_email || currentWORef.current?.assigned_email || '').toLowerCase();
        if (primaryEmail && assignees.length > 1) {
          const primaryIdx = assignees.findIndex(a => a.email.toLowerCase() === primaryEmail);
          if (primaryIdx > 0) {
            const [primary] = assignees.splice(primaryIdx, 1);
            assignees.unshift(primary);
          }
        }
        setViewAssignees(assignees);
      } catch (e) { /* keep existing */ }

      const { data: parts } = await supabase.from('work_order_parts').select('*').eq('wo_id', woId).order('added_date', { ascending: false });
      setPartsUsed(parts || []);

      const { data: docs } = await supabase.from('work_order_documents').select('*').eq('wo_id', woId).order('uploaded_at', { ascending: false });
      setWoDocs(docs || []);

      // Load linked POs (check both orders.work_order_id AND line items wo_id)
      const { data: directPOs } = await supabase.from('orders').select('*').eq('work_order_id', woId).order('order_date', { ascending: false });
      const { data: lineLinks } = await supabase.from('order_line_items').select('order_id').eq('wo_id', woId);
      const lineOrderIds = [...new Set((lineLinks || []).map(l => l.order_id))];
      let extraPOs = [];
      if (lineOrderIds.length > 0) {
        const { data: ep } = await supabase.from('orders').select('*').in('order_id', lineOrderIds);
        extraPOs = ep || [];
      }
      const allPOs = [...(directPOs || [])];
      extraPOs.forEach(po => { if (!allPOs.find(p => p.order_id === po.order_id)) allPOs.push(po); });
      allPOs.sort((a, b) => new Date(b.order_date) - new Date(a.order_date));
      setLinkedPOs(allPOs);
    } catch (e) { console.warn('Silent WO refresh error:', e); }
  };

  // ---------- ACTIONS ----------

  // Generate PO from within a Work Order
  const openGeneratePO = () => {
    setPoForm({ vendorId: '', vendorName: '', otherVendor: '', notes: '' });
    setPoLines([{ partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' }]);
    setExistingPO(null);
    setAddToExisting(false);
    setShowGeneratePO(true);
  };

  // Check for existing un-ordered POs when vendor changes
  const checkExistingPOs = async (vendorName) => {
    if (!vendorName) { setExistingPO(null); setAddToExisting(false); return; }
    try {
      const { data } = await supabase.from('orders')
        .select('order_id, vendor_name, other_vendor, status, total, ordered_by, work_order_id')
        .or(`vendor_name.eq.${vendorName},other_vendor.eq.${vendorName}`)
        .in('status', ['Pending', 'Approved', 'Ready', 'Submitted'])
        .order('order_date', { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        // Also load existing line items for display
        const po = data[0];
        const { data: lines } = await supabase.from('order_line_items')
          .select('line_id, description, quantity, unit_price, subtotal, wo_id')
          .eq('order_id', po.order_id);
        po.existingLines = lines || [];
        setExistingPO(po);
        setAddToExisting(false);
      } else {
        setExistingPO(null);
        setAddToExisting(false);
      }
    } catch (e) {
      console.warn('Check existing PO error:', e);
      setExistingPO(null);
    }
  };

  const handlePOVendorChange = (vendorId) => {
    if (vendorId === 'OTHER') {
      setPoForm(f => ({ ...f, vendorId: '', vendorName: '', otherVendor: '' }));
      setExistingPO(null);
      setAddToExisting(false);
    } else {
      const v = vendors.find(v => v.vendor_id === vendorId);
      const vName = v?.vendor_name || '';
      setPoForm(f => ({ ...f, vendorId, vendorName: vName, otherVendor: '' }));
      checkExistingPOs(vName);
    }
  };

  const submitGeneratePO = async () => {
    if (!currentWO) return;
    if (!addToExisting && !poForm.vendorName && !poForm.otherVendor) { showToast('Select a vendor', 'error'); return; }
    if (poLines.length === 0 || !poLines[0].description) { showToast('Add at least one line item', 'error'); return; }

    setPoSaving(true);
    try {
      const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
      const now = new Date().toISOString();
      let newLineTotal = 0;
      poLines.forEach(li => { newLineTotal += (parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0); });

      let orderId;

      if (addToExisting && existingPO) {
        // ── ADD TO EXISTING PO ──
        orderId = existingPO.order_id;

        // Add new line items with wo_id
        for (const li of poLines) {
          let lineId;
          try {
            const { data: lid } = await supabase.rpc('get_next_id', { p_type: 'OrderLine' });
            lineId = lid;
          } catch {}
          if (!lineId) lineId = `OLI${Date.now()}${Math.floor(Math.random() * 1000)}`;

          const unitPrice = parseFloat(li.unitPrice) || 0;
          const qty = parseInt(li.quantity) || 0;
          const { error: lineErr } = await supabase.from('order_line_items').insert({
            line_id: lineId, order_id: orderId, part_number: li.partNumber || '',
            description: li.description || '', link: li.link || '',
            unit_price: unitPrice.toFixed(2), quantity: qty,
            subtotal: (unitPrice * qty).toFixed(2), received_qty: 0,
            status: 'Pending', inventory_part_id: li.inventoryPartId || '',
            wo_id: currentWO.wo_id
          });
          if (lineErr) {
            console.error(`Failed to insert line item for PO ${orderId}:`, lineErr);
            throw new Error(`Failed to save line item: ${lineErr.message}`);
          }
        }

        // Update PO total and reset to Pending for re-approval
        const existingTotal = parseFloat(existingPO.total) || 0;
        const combinedTotal = existingTotal + newLineTotal;
        await supabase.from('orders').update({
          total: combinedTotal.toFixed(2),
          status: 'Pending',
          approved_by: '',
          approved_date: null,
          notes: (existingPO.notes || '') + (existingPO.notes ? ' | ' : '') + `Items added from ${currentWO.wo_id} by ${userName}`
        }).eq('order_id', orderId);

      } else {
        // ── CREATE NEW PO ──
        try {
          const { data: oid } = await supabase.rpc('get_next_id', { p_type: 'Order' });
          if (oid) orderId = oid;
        } catch {}
        if (!orderId) {
          const { data: maxRow } = await supabase.from('orders').select('order_id').order('order_id', { ascending: false }).limit(1).maybeSingle();
          let next = 1;
          if (maxRow?.order_id) { const num = parseInt(maxRow.order_id.replace(/\D/g, '')); if (!isNaN(num)) next = num + 1; }
          orderId = `ORD${String(next).padStart(4, '0')}`;
        }

        const { error } = await supabase.from('orders').insert({
          order_id: orderId, vendor_id: poForm.vendorId || null, vendor_name: poForm.vendorName || '',
          other_vendor: poForm.otherVendor || '', work_order_id: currentWO.wo_id,
          order_date: now, ordered_by: userName, status: 'Pending',
          total: newLineTotal.toFixed(2), notes: poForm.notes || '',
          approved_by: '', approved_date: null,
        });
        if (error) throw error;

        // Add line items with wo_id
        for (const li of poLines) {
          let lineId;
          try {
            const { data: lid } = await supabase.rpc('get_next_id', { p_type: 'OrderLine' });
            lineId = lid;
          } catch {}
          if (!lineId) lineId = `OLI${Date.now()}${Math.floor(Math.random() * 1000)}`;

          const unitPrice = parseFloat(li.unitPrice) || 0;
          const qty = parseInt(li.quantity) || 0;
          const { error: lineErr2 } = await supabase.from('order_line_items').insert({
            line_id: lineId, order_id: orderId, part_number: li.partNumber || '',
            description: li.description || '', link: li.link || '',
            unit_price: unitPrice.toFixed(2), quantity: qty,
            subtotal: (unitPrice * qty).toFixed(2), received_qty: 0,
            status: 'Pending', inventory_part_id: li.inventoryPartId || '',
            wo_id: currentWO.wo_id
          });
          if (lineErr2) {
            console.error(`Failed to insert line item for PO ${orderId}:`, lineErr2);
            throw new Error(`Failed to save line item: ${lineErr2.message}`);
          }
        }
      }

      // Update WO status to Awaiting Parts
      const { error: woErr } = await supabase.from('work_orders').update({
        status: 'Awaiting Parts', updated_at: now, updated_by: userName
      }).eq('wo_id', currentWO.wo_id);
      if (woErr) console.error('Failed to update WO status:', woErr);

      // Auto-generate work log entry
      try {
        let logId;
        try { const { data: lid } = await supabase.rpc('get_next_id', { p_type: 'work_log' }); logId = lid; } catch {}
        await supabase.from('work_log').insert([{
          log_id: logId || `LOG${Date.now()}`, wo_id: currentWO.wo_id, timestamp: now,
          user_name: userName, user_email: profile.email, hours: 0,
          work_description: addToExisting
            ? `Parts added to existing PO ${orderId} (${existingPO?.vendor_name || poForm.vendorName || poForm.otherVendor})`
            : `Parts ordered — PO ${orderId} (${poForm.vendorName || poForm.otherVendor})`,
          entry_type: 'Work'
        }]);
      } catch (logErr) { console.warn('Auto work log failed:', logErr); }

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email, user_name: userName,
          action: addToExisting ? 'Add items to PO' : 'Generate PO from WO',
          entity_type: 'Purchase Order', entity_id: orderId,
          details: addToExisting
            ? `Added items from ${currentWO.wo_id} to ${orderId} — $${newLineTotal.toFixed(2)} (needs re-approval)`
            : `Created PO ${orderId} from WO ${currentWO.wo_id} for ${poForm.vendorName || poForm.otherVendor} — $${newLineTotal.toFixed(2)}`
        });
      } catch {}

      setShowGeneratePO(false);
      showToast(addToExisting
        ? `Items added to ${orderId}! Sent to instructor for re-approval.`
        : `PO ${orderId} submitted for instructor approval! WO set to Awaiting Parts.`, 'success');
      loadWODetailSilent(currentWO.wo_id);
      loadWorkOrders('open', true);
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
    setPoSaving(false);
  };

  const switchView = (view) => {
    setCurrentView(view);
    // Reset sort when switching tabs so stale column keys (e.g. due_date on Closed) don't persist
    setWoSortColumn('');
    setWoSortDirection('asc');
    if (view === 'requests') return;
    loadWorkOrders(view);
  };

  const saveWorkOrder = async () => {
    if (!formData.description?.trim()) { showToast('Description is required', 'error'); return; }
    setLoading(true);
    try {
      const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
      if (formData.wo_id) {
        // Update
        const updates = { ...formData, updated_at: new Date().toISOString(), updated_by: userName };
        delete updates.wo_id;
        delete updates.isClosed;
        delete updates.isLate;
        const { data: rows, error } = await supabase.from('work_orders').update(updates).eq('wo_id', formData.wo_id).select();
        if (error) throw error;
        if (!rows || rows.length === 0) {
          showToast('Save failed — you may not have permission to update this work order.', 'error');
          setLoading(false);
          return;
        }
        showToast('Work order updated!', 'success');
      } else {
        // Create
        const { data: idData } = await supabase.rpc('get_next_id', { p_type: 'work_order' });
        const woId = idData || `WO${Date.now()}`;

        // Calculate due date based on priority if not set
        let dueDate = formData.due_date;
        if (!dueDate) {
          const d = new Date();
          d.setDate(d.getDate() + (priorityDays[formData.priority] || 7));
          dueDate = d.toISOString().split('T')[0];
        }

        const newWO = {
          wo_id: woId,
          description: formData.description,
          priority: formData.priority || 'Medium',
          status: formData.status || 'Open',
          asset_id: formData.asset_id || null,
          asset_name: formData.asset_name || '',
          assigned_to: formData.assigned_to || '',
          assigned_email: formData.assigned_email || '',
          created_at: new Date().toISOString(),
          due_date: dueDate,
          created_by: userName,
          total_hours: 0,
          updated_at: new Date().toISOString(),
          updated_by: userName,
        };
        const { data: rows, error } = await supabase.from('work_orders').insert([newWO]).select();
        if (error) throw error;
        if (!rows || rows.length === 0) {
          showToast('Create failed — you may not have permission to create work orders.', 'error');
          setLoading(false);
          return;
        }
        // Seed work_order_assignments if a primary assignee was set
        if (formData.assigned_email) {
          const assignedUser = users.find(u => u.email === formData.assigned_email);
          const assignedName = assignedUser
            ? `${assignedUser.first_name} ${assignedUser.last_name}`
            : formData.assigned_email;
          await supabase.from('work_order_assignments').insert({
            wo_id: woId,
            user_email: formData.assigned_email,
            user_name: assignedName,
            assigned_by: userName
          }).select();
          // Notify the assignee via the notification bell
          await sendWOAssignmentNotification(formData.assigned_email, woId, formData.description);
        }
        showToast('Work order created!', 'success');
      }
      setShowCreateModal(false);
      loadWorkOrders(currentView === 'closed' ? 'closed' : 'open');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
    setLoading(false);
  };

  const saveWOInline = async () => {
    if (!currentWO) return;
    const updates = {};
    const changedFields = [];
    const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';

    // Description
    if (hasPerm('edit_wo') && viewDescription !== (currentWO.description || '')) {
      updates.description = viewDescription || currentWO.description;
      changedFields.push('description');
    }

    // Priority
    if (hasPerm('edit_priority') && viewPriority !== (currentWO.priority || '')) {
      updates.priority = viewPriority;
      changedFields.push(`priority → ${viewPriority}`);
    }

    // Asset
    if (hasPerm('edit_wo') && profile?.role !== 'Student') {
      const newAssetId = viewAssetId || null;
      if ((newAssetId || '') !== (currentWO.asset_id || '')) {
        updates.asset_id = newAssetId;
        const selectedAsset = assets.find(a => a.asset_id === newAssetId);
        updates.asset_name = selectedAsset?.name || '';
        changedFields.push(`asset → ${selectedAsset?.name || 'None'}`);
      }
    }

    // Due Date
    if (hasPerm('edit_due_date') && viewDueDate !== (currentWO.due_date ? currentWO.due_date.split('T')[0] : '')) {
      updates.due_date = viewDueDate || null;
      changedFields.push(`due date → ${viewDueDate || 'removed'}`);
    }

    // Status (tracked via viewStatus state — custom dropdown)
    if (hasPerm('edit_status') && viewStatus && viewStatus !== currentWO.status) {
      updates.status = viewStatus;
      changedFields.push(`status → ${viewStatus}`);
    }

    updates.updated_at = new Date().toISOString();
    updates.updated_by = userName;

    try {
      setLoading(true);
      const { data: rows, error } = await supabase.from('work_orders').update(updates).eq('wo_id', currentWO.wo_id).select();
      if (error) throw error;
      if (!rows || rows.length === 0) {
        showToast('Save failed — you may not have permission to update this work order.', 'error');
        setLoading(false);
        return;
      }

      // Audit log
      try {
        await supabase.from('audit_log').insert({
          user_email: profile.email,
          user_name: userName,
          action: 'Update',
          entity_type: 'Work Order',
          entity_id: currentWO.wo_id,
          details: changedFields.length > 0 ? `Updated: ${changedFields.join(', ')}` : 'Saved work order (no field changes)'
        });
      } catch {}

      showToast('Saved!', 'success');
      closeViewModal();
      loadWorkOrders('open');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
    setLoading(false);
  };

  const saveWorkLog = async () => {
    const totalMins = (workLogForm.hours * 60) + workLogForm.mins;
    if (totalMins <= 0) { showToast('Time must be greater than 0', 'error'); return; }
    if (!workLogForm.notes.trim()) { showToast('Work notes required', 'error'); return; }

    const hours = totalMins / 60;
    const roundedHours = Math.round(hours * 4) / 4;
    const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';

    try {
      setLoading(true);
      const { data: logId } = await supabase.rpc('get_next_id', { p_type: 'work_log' });

      const { data: logRows, error: logErr } = await supabase.from('work_log').insert([{
        log_id: logId || `LOG${Date.now()}`,
        wo_id: currentWO.wo_id,
        timestamp: new Date().toISOString(),
        user_name: userName,
        user_email: user.email,
        hours: roundedHours,
        work_description: workLogForm.notes,
        entry_type: 'Work'
      }]).select();
      if (logErr) throw logErr;
      if (!logRows || logRows.length === 0) {
        showToast('Save failed — you may not have permission to add work logs.', 'error');
        setLoading(false);
        return;
      }

      // Update total hours
      const newTotal = (currentWO.total_hours || 0) + roundedHours;
      const { data: woRows, error: woErr } = await supabase.from('work_orders').update({
        total_hours: newTotal,
        status: currentWO.status === 'Open' || currentWO.status === 'Pending' ? 'In Progress' : currentWO.status,
        updated_at: new Date().toISOString(),
        updated_by: userName
      }).eq('wo_id', currentWO.wo_id).select();
      if (woErr) throw woErr;
      if (!woRows || woRows.length === 0) {
        showToast('Work log saved but could not update work order — check permissions.', 'error');
      }

      showToast('Work log added!', 'success');
      setShowWorkLogModal(false);
      loadWODetail(currentWO.wo_id);
      loadWorkOrders('open');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
    setLoading(false);
  };

  const deleteWorkLog = async (logId) => {
    setConfirmModal({
      title: 'Delete Work Log',
      message: 'Are you sure you want to delete this work log entry?',
      onConfirm: async () => {
        try {
          setLoading(true);
          const entry = workLogs.find(l => l.log_id === logId);
          const { data: delRows, error: delErr } = await supabase.from('work_log').delete().eq('log_id', logId).select();
          if (delErr) throw delErr;
          if (!delRows || delRows.length === 0) {
            showToast('Delete failed — you may not have permission to delete work logs.', 'error');
            setLoading(false);
            return;
          }
          if (entry) {
            const newTotal = Math.max(0, (currentWO.total_hours || 0) - (entry.hours || 0));
            await supabase.from('work_orders').update({ total_hours: newTotal }).eq('wo_id', currentWO.wo_id).select();
          }
          showToast('Work log deleted!', 'success');
          loadWODetail(currentWO.wo_id);
          loadWorkOrders('open');
        } catch (e) { showToast('Error: ' + e.message, 'error'); }
        setLoading(false);
      }
    });
  };

  const savePartUsage = async () => {
    if (selectedParts.length === 0) { showToast('No parts selected', 'error'); return; }
    try {
      setLoading(true);
      const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
      for (const p of selectedParts) {
        const record = {
          wo_id: currentWO.wo_id,
          part_id: p.fromInventory ? p.partId : null,
          part_name: p.partName,
          quantity_used: p.qty,
          from_inventory: p.fromInventory ? 'Yes' : 'No',
          added_by: userName,
          added_date: new Date().toISOString()
        };
        const { data: partRows, error: partErr } = await supabase.from('work_order_parts').insert([record]).select();
        if (partErr) throw partErr;
        if (!partRows || partRows.length === 0) {
          showToast('Failed to add part — you may not have permission.', 'error');
          setLoading(false);
          return;
        }

        // Reduce inventory qty if from inventory
        if (p.fromInventory && p.partId) {
          const item = inventoryItems.find(i => i.part_id === p.partId);
          if (item) {
            const newQty = Math.max(0, (item.qty_in_stock || 0) - p.qty);
            await supabase.from('inventory').update({ qty_in_stock: newQty }).eq('part_id', p.partId).select();
          }
        }
      }
      showToast('Parts added!', 'success');
      setShowPartsModal(false);
      loadWODetail(currentWO.wo_id);
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setLoading(false);
  };

  const uploadWODoc = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.pdf,.doc,.docx';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { showToast('File too large (max 10MB)', 'error'); return; }
      try {
        setLoading(true);
        const path = `wo-docs/${currentWO.wo_id}/${Date.now()}_${file.name}`;
        const { error: uploadError } = await supabase.storage.from('work-order-documents').upload(path, file);
        if (uploadError) throw uploadError;

        const { data: docRows, error: docInsErr } = await supabase.from('work_order_documents').insert([{
          wo_id: currentWO.wo_id,
          file_name: file.name,
          file_path: path,
          file_type: file.type,
          uploaded_by: profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '',
          uploaded_at: new Date().toISOString()
        }]).select();
        if (docInsErr) throw docInsErr;
        if (!docRows || docRows.length === 0) {
          showToast('Upload failed — document saved to storage but database insert was blocked. Check permissions.', 'error');
          setLoading(false);
          return;
        }

        showToast('Document uploaded!', 'success');
        loadWODetail(currentWO.wo_id);
      } catch (e) { showToast('Upload failed: ' + e.message, 'error'); }
      setLoading(false);
    };
    input.click();
  };

  const deleteWODoc = async (doc) => {
    setConfirmModal({
      title: 'Delete Document',
      message: `Are you sure you want to delete "${doc.file_name || 'this document'}"?`,
      onConfirm: async () => {
        try {
          setLoading(true);
          // Delete from storage
          if (doc.file_path) {
            await supabase.storage.from('work-order-documents').remove([doc.file_path]);
          }
          // Delete from database
          const { data: docDelRows, error: docDelErr } = await supabase.from('work_order_documents').delete().eq('id', doc.id).select();
          if (docDelErr) throw docDelErr;
          if (!docDelRows || docDelRows.length === 0) {
            showToast('Delete failed — you may not have permission to delete documents.', 'error');
            setLoading(false);
            return;
          }
          showToast('Document deleted!', 'success');
          loadWODetail(currentWO.wo_id);
        } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
        setLoading(false);
        setConfirmModal(null);
      }
    });
  };

  const closeWorkOrder = async () => {
    try {
      setLoading(true);
      const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
      const now = new Date();
      const createdDate = currentWO.created_at ? new Date(currentWO.created_at) : now;
      const daysOpen = Math.ceil((now - createdDate) / (1000 * 60 * 60 * 24));
      const wasLate = (() => {
        if (!currentWO.due_date) return 'No';
        // Parse due date as local midnight — late only if today's date is strictly after due date
        const duePart = currentWO.due_date.substring(0, 10);
        const dueMs = new Date(duePart + 'T00:00:00').getTime();
        const todMs = (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); })();
        return todMs > dueMs ? 'Yes' : 'No';
      })();

      // Insert into closed table
      const closedRow = {
        wo_id: currentWO.wo_id,
        description: currentWO.description,
        priority: currentWO.priority,
        status: 'Closed',
        asset_id: currentWO.asset_id,
        asset_name: currentWO.asset_name,
        assigned_to: currentWO.assigned_to,
        assigned_email: currentWO.assigned_email,
        created_at: currentWO.created_at,
        due_date: currentWO.due_date,
        closed_date: now.toISOString(),
        closed_by: userName,
        created_by: currentWO.created_by,
        request_id: currentWO.request_id,
        is_pm: currentWO.is_pm,
        pm_id: currentWO.pm_id,
        total_hours: currentWO.total_hours,
        documents: currentWO.documents || null,
        days_open: daysOpen,
        was_late: wasLate
      };

      // Add closing notes as work log if provided
      if (closeNotes.trim()) {
        await supabase.from('work_log').insert([{
          log_id: `LOG${Date.now()}`,
          wo_id: currentWO.wo_id,
          timestamp: now.toISOString(),
          user_name: userName,
          user_email: user.email,
          hours: 0,
          work_description: `CLOSING NOTES: ${closeNotes}`,
          entry_type: 'Close'
        }]);
      }

      const { data: closedRows, error: closeErr } = await supabase.from('work_orders_closed').upsert([closedRow], { onConflict: 'wo_id' }).select();
      if (closeErr) throw closeErr;
      if (!closedRows || closedRows.length === 0) {
        showToast('Close failed — you may not have permission to close work orders.', 'error');
        setLoading(false);
        return;
      }
      const { data: delRows, error: delErr } = await supabase.from('work_orders').delete().eq('wo_id', currentWO.wo_id).select();
      if (delErr) throw delErr;
      if (!delRows || delRows.length === 0) {
        showToast('Close partially failed — could not remove from open table. Check permissions.', 'error');
      }

      showToast('Work order closed!', 'success');
      setShowCloseModal(false);
      closeViewModal();
      loadWorkOrders('open');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setLoading(false);
  };

  const reopenWorkOrder = async () => {
    setConfirmModal({
      title: 'Reopen Work Order',
      message: 'Are you sure you want to reopen this work order?',
      onConfirm: async () => {
        try {
          setLoading(true);
          const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
          const openRow = {
            wo_id: currentWO.wo_id,
            description: currentWO.description,
            priority: currentWO.priority,
            status: 'Reopened',
            asset_id: currentWO.asset_id,
            asset_name: currentWO.asset_name,
            assigned_to: currentWO.assigned_to,
            assigned_email: currentWO.assigned_email,
            created_at: currentWO.created_at,
            due_date: new Date().toISOString().split('T')[0],
            created_by: currentWO.created_by,
            total_hours: currentWO.total_hours,
            updated_at: new Date().toISOString(),
            updated_by: userName
          };
          const { data: openRows, error: openErr } = await supabase.from('work_orders').insert([openRow]).select();
          if (openErr) throw openErr;
          if (!openRows || openRows.length === 0) {
            showToast('Reopen failed — you may not have permission.', 'error');
            setLoading(false);
            return;
          }
          const { data: delRows2, error: delErr2 } = await supabase.from('work_orders_closed').delete().eq('wo_id', currentWO.wo_id).select();
          if (delErr2) throw delErr2;
          if (!delRows2 || delRows2.length === 0) {
            showToast('Reopen partially failed — could not remove from closed table.', 'error');
          }
          showToast('Work order reopened!', 'success');
          closeViewModal();
          loadWorkOrders('open');
        } catch (e) { showToast('Error: ' + e.message, 'error'); }
        setLoading(false);
      }
    });
  };

  const deleteWorkOrder = (woId) => {
    setConfirmModal({
      title: 'Delete Work Order',
      message: 'Are you sure you want to PERMANENTLY DELETE this work order? This cannot be undone!',
      onConfirm: () => {
        setConfirmModal({
          title: 'Final Confirmation',
          message: 'This will delete all work logs, parts used, and documents. Are you absolutely sure?',
          onConfirm: async () => {
            try {
              setLoading(true);
              await supabase.from('work_log').delete().eq('wo_id', woId).select();
              await supabase.from('work_order_parts').delete().eq('wo_id', woId).select();
              await supabase.from('work_order_documents').delete().eq('wo_id', woId).select();
              await supabase.from('work_order_assignments').delete().eq('wo_id', woId).select();
              const { data: woDelRows, error: woDelErr } = await supabase.from('work_orders').delete().eq('wo_id', woId).select();
              if (woDelErr) throw woDelErr;
              if (!woDelRows || woDelRows.length === 0) {
                showToast('Delete failed — you may not have permission to delete work orders.', 'error');
                setLoading(false);
                return;
              }
              showToast('Work order deleted!', 'success');
              closeViewModal();
              loadWorkOrders('open');
            } catch (e) { showToast('Error: ' + e.message, 'error'); }
            setLoading(false);
          }
        });
      }
    });
  };

  const approveRequest = async () => {
    if (!currentRequest) return;
    try {
      setLoading(true);
      const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
      const { data: woId } = await supabase.rpc('get_next_id', { p_type: 'work_order' });

      const days = { High: 3, Medium: 7, Low: 14 };
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (days[approveForm.priority] || 7));

      // Find assigned user info
      let assignedTo = '';
      if (approveForm.assignEmail) {
        const u = users.find(usr => usr.email === approveForm.assignEmail);
        if (u) assignedTo = `${u.first_name} ${u.last_name}`;
      }

      const { data: woRows2, error: woErr2 } = await supabase.from('work_orders').insert([{
        wo_id: woId,
        description: currentRequest.description,
        priority: approveForm.priority,
        status: 'Open',
        asset_id: currentRequest.asset_id || null,
        asset_name: currentRequest.asset_name || '',
        assigned_to: assignedTo,
        assigned_email: approveForm.assignEmail || '',
        created_at: new Date().toISOString(),
        due_date: dueDate.toISOString().split('T')[0],
        created_by: userName,
        request_id: currentRequest.request_id,
        total_hours: 0,
        updated_at: new Date().toISOString(),
        updated_by: userName
      }]).select();
      if (woErr2) throw woErr2;
      if (!woRows2 || woRows2.length === 0) {
        showToast('Approve failed — could not create work order. Check permissions.', 'error');
        setLoading(false);
        return;
      }
      // Seed work_order_assignments if an assignee was chosen
      if (approveForm.assignEmail && assignedTo) {
        await supabase.from('work_order_assignments').insert({
          wo_id: woId,
          user_email: approveForm.assignEmail,
          user_name: assignedTo,
          assigned_by: userName
        }).select();
        // Notify the assignee via the notification bell
        await sendWOAssignmentNotification(approveForm.assignEmail, woId, currentRequest.description);
      }

      const { data: reqRows, error: reqErr } = await supabase.from('work_order_requests').update({
        status: 'Approved',
        processed_by: userName,
        processed_date: new Date().toISOString()
      }).eq('request_id', currentRequest.request_id).select();
      if (reqErr) throw reqErr;
      if (!reqRows || reqRows.length === 0) {
        showToast('WO created but request status update failed — check permissions.', 'error');
      }

      showToast('Request approved! WO created.', 'success');
      setShowApproveModal(false);
      loadRequests();
      loadWorkOrders('open');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setLoading(false);
  };

  const rejectRequest = (req) => {
    setRejectTarget(req);
  };

  const handleRejectConfirm = async (reason) => {
    if (!rejectTarget) return;
    try {
      const userName = profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';
      const { data: rejRows, error: rejErr } = await supabase.from('work_order_requests').update({
        status: 'Rejected',
        rejection_reason: reason,
        processed_by: userName,
        processed_date: new Date().toISOString()
      }).eq('request_id', rejectTarget.request_id).select();
      if (rejErr) throw rejErr;
      if (!rejRows || rejRows.length === 0) {
        throw new Error('Reject failed — you may not have permission.');
      }

      // Notify the student
      await sendRejectionNotification({
        recipientEmail: rejectTarget.email,
        recipientName: rejectTarget.name || rejectTarget.email || '',
        requestType: 'Work Order Request',
        requestId: rejectTarget.request_id,
        reason,
        extraDetails: rejectTarget.asset_name
          ? `Asset: ${rejectTarget.asset_name}\nDescription: ${rejectTarget.description || ''}`
          : rejectTarget.description || '',
      });

      showToast('Request rejected & student notified', 'info');
      setRejectTarget(null);
      loadRequests();
    } catch (e) {
      throw new Error(e.message || 'Failed to reject request');
    }
  };

  // ---------- FILTER ----------
  const filteredWOs = useMemo(() => {
    const userEmail = (profile?.email || user?.email || '').toLowerCase();
    return woData.filter(wo => {
      // Smart search — also checks ALL assignees (primary + additional) by name and email
      const extraAssignees = woAssignments[wo.wo_id] || [];
      const assigneeText = extraAssignees.map(a => `${a.name || ''} ${a.email || ''}`).join(' ');
      const matchSearch = !search ||
        wo.wo_id?.toLowerCase().includes(search.toLowerCase()) ||
        wo.description?.toLowerCase().includes(search.toLowerCase()) ||
        wo.asset_name?.toLowerCase().includes(search.toLowerCase()) ||
        wo.assigned_to?.toLowerCase().includes(search.toLowerCase()) ||
        wo.status?.toLowerCase().includes(search.toLowerCase()) ||
        wo.created_by?.toLowerCase().includes(search.toLowerCase()) ||
        assigneeText.toLowerCase().includes(search.toLowerCase());
      const matchPriority = !priorityFilter || wo.priority === priorityFilter;
      const matchStatus = !statusFilter || wo.status === statusFilter;
      // "Assigned to Me" — matches if the logged-in user is ANY assignee (primary or additional)
      const matchAssignedToMe = !assignedToMeFilter ||
        extraAssignees.some(a => a.email.toLowerCase() === userEmail);
      return matchSearch && matchPriority && matchStatus && matchAssignedToMe;
    });
  }, [woData, search, priorityFilter, statusFilter, assignedToMeFilter, woAssignments, profile, user]);

  const [woSortColumn, setWoSortColumn] = useState('');
  const [woSortDirection, setWoSortDirection] = useState('asc');

  const sortedWOs = useMemo(() => {
    if (!woSortColumn) return filteredWOs;
    const dateColumns = ['due_date', 'closed_date'];
    return [...filteredWOs].sort((a, b) => {
      let valA, valB;
      if (dateColumns.includes(woSortColumn)) {
        const parseDue = (d) => {
          if (!d) return 0;
          if (typeof d === 'string') {
            const datePart = d.substring(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return new Date(datePart + 'T00:00:00').getTime();
          }
          return new Date(d).getTime();
        };
        valA = parseDue(a[woSortColumn]);
        valB = parseDue(b[woSortColumn]);
      } else {
        valA = (a[woSortColumn] || '').toString().toLowerCase();
        valB = (b[woSortColumn] || '').toString().toLowerCase();
      }
      if (valA < valB) return woSortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return woSortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredWOs, woSortColumn, woSortDirection]);

  const handleWoSort = (col) => {
    if (woSortColumn === col) {
      setWoSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setWoSortColumn(col);
      setWoSortDirection('asc');
    }
  };

  // Accessible sort indicator — returns visible icon + screen-reader label
  const woSortIcon = (col) => woSortColumn === col ? (woSortDirection === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
  const ariaSort = (col) => woSortColumn === col ? (woSortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const openStatuses = statuses.filter(s => s.is_closed_status !== 'Yes' && s.is_closed_status !== true);
  const pendingRequestCount = requestsData.length;

  // ---------- OPEN MODALS ----------
  const openCreateWOModal = () => {
    setFormData({ description: '', priority: 'Medium', asset_id: '', assigned_email: '', status: 'Open', due_date: '' });
    setShowCreateModal(true);
  };

  const openEditWOModal = (wo) => {
    setFormData({ ...wo });
    setShowCreateModal(true);
  };

  const openWorkLogModalFn = () => {
    setWorkLogForm({
      hours: Math.floor(defaultWorkMinutes / 60),
      mins: defaultWorkMinutes % 60,
      notes: ''
    });
    setShowWorkLogModal(true);
  };

  const openPartsModalFn = () => {
    setPartsSearch('');
    setSelectedParts([]);
    setCustomPartName('');
    setCustomPartQty(1);
    setShowPartsModal(true);
  };

  const openCloseWOModalFn = () => {
    setCloseNotes('');
    setShowCloseModal(true);
  };

  // Closes the WO detail modal and clears the ref so the realtime handler stops
  // firing loadWODetailSilent for a WO that's no longer being viewed.
  const closeViewModal = () => {
    showViewModalRef.current = false; // clear synchronously before state update
    currentWORef.current = null;
    setShowViewModal(false);
    setAddAssigneeEmail('');
  };

  const openApproveModalFn = (req) => {
    setCurrentRequest(req);
    setApproveForm({ priority: req.priority || 'Medium', assignEmail: '', notes: '' });
    setShowApproveModal(true);
  };

  // Parts search results
  const partsResults = useMemo(() => {
    if (!partsSearch) return [];
    const s = partsSearch.toLowerCase();
    return inventoryItems.filter(i =>
      i.part_name?.toLowerCase().includes(s) || i.part_id?.toLowerCase().includes(s)
    ).slice(0, 10);
  }, [partsSearch, inventoryItems]);

  const addPartToSelection = (item) => {
    if (selectedParts.find(p => p.partId === item.part_id)) return;
    setSelectedParts([...selectedParts, { partId: item.part_id, partName: item.part_name, qty: 1, fromInventory: true }]);
  };

  const addCustomPart = () => {
    if (!customPartName.trim()) { showToast('Enter a part name', 'error'); return; }
    if (selectedParts.find(p => p.partName.toLowerCase() === customPartName.toLowerCase())) { showToast('Part already added', 'error'); return; }
    setSelectedParts([...selectedParts, { partId: 'CUSTOM', partName: customPartName, qty: customPartQty, fromInventory: false }]);
    setCustomPartName('');
    setCustomPartQty(1);
  };

  // User dropdown options for the create WO / approve request modal (single primary assignee).
  // Students and Work Study can only select themselves.
  // Instructors can select anyone.
  const assignOptions = useMemo(() => {
    if (!profile) return [];
    if (profile.role === 'Student' || profile.role === 'Work Study') {
      return [{ email: user.email, name: `${profile.first_name} ${profile.last_name} (Me)` }];
    }
    return users.map(u => ({
      email: u.email,
      name: u.email === user.email
        ? `${u.first_name} ${u.last_name} (Me)`
        : `${u.first_name} ${u.last_name}`
    }));
  }, [users, profile, user]);

  // ---------- RENDER ----------
  return (
    <div className="wo-page">
      {/* Toast */}
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      {/* Page-level assignee tooltip — rendered here so it's above all cards/overflow */}
      {assigneeTooltip && (
        <div style={{
          position: 'fixed',
          left: assigneeTooltip.x,
          top: assigneeTooltip.y,
          transform: 'translateX(-50%)',
          background: '#1a1a2e', color: '#fff',
          borderRadius: 6, padding: '6px 10px',
          fontSize: '0.75rem', fontWeight: 500,
          whiteSpace: 'nowrap', lineHeight: '1.6',
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          display: 'flex', flexDirection: 'column',
          zIndex: 9999, pointerEvents: 'none',
        }}>
          {assigneeTooltip.names.map((n, i) => <span key={i}>{n}</span>)}
          <span style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            border: '5px solid transparent',
            ...(assigneeTooltip.goDown
              ? { bottom: '100%', borderBottomColor: '#1a1a2e' }
              : { top: '100%',    borderTopColor:    '#1a1a2e' }),
          }} />
        </div>
      )}

      {/* Toolbar */}
      <div className="page-toolbar">
        <div className="toolbar-left">
          <div className="view-toggle">
            <button className={`toggle-btn ${currentView === 'open' ? 'active' : ''}`} onClick={() => switchView('open')}>
              <span className="material-icons">folder_open</span>Open
            </button>
            <button className={`toggle-btn ${currentView === 'closed' ? 'active' : ''}`} onClick={() => switchView('closed')}>
              <span className="material-icons">check_circle</span>Closed
            </button>
            <button className={`toggle-btn ${currentView === 'requests' ? 'active' : ''}`} onClick={() => switchView('requests')}>
              <span className="material-icons">inbox</span>Requests
              {pendingRequestCount > 0 && <span className="request-badge">{pendingRequestCount}</span>}
            </button>
          </div>
          <div className="search-box" style={{ position: 'relative' }}>
            <span className="material-icons">search</span>
            <input type="text" placeholder="Search work orders..." value={search} onChange={e => setSearch(e.target.value)} style={{ paddingRight: search ? 22 : 0 }} aria-label="Search work orders" />
            {search && (
              <button
                onClick={() => setSearch('')}
                title="Clear search"
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
                  color: '#868e96', fontSize: '1rem', lineHeight: 1, display: 'flex', alignItems: 'center',
                }}
              >✕</button>
            )}
          </div>
          <select className="filter-select" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
            <option value="">All Priorities</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
          {currentView !== 'requests' && (
            <StatusSelectComponent
              statuses={currentView === 'closed' ? statuses : openStatuses}
              value={statusFilter}
              onChange={setStatusFilter}
              className="filter-select"
              allOption="All Statuses"
              style={{ minWidth: 170 }}
              colorMap={statusColorMap}
            />
          )}
          <button
            className={`toggle-btn${assignedToMeFilter ? ' active' : ''}`}
            style={{
              border: '1px solid #dee2e6',
              borderRadius: 8,
              background: assignedToMeFilter ? '#e7f5ff' : 'white',
              color: assignedToMeFilter ? '#1864ab' : '#495057',
              fontWeight: assignedToMeFilter ? 600 : 400,
            }}
            onClick={() => setAssignedToMeFilter(v => !v)}
            title="Show only work orders assigned to me (including as additional assignee)"
          >
            <span className="material-icons">person</span>Assigned to Me
          </button>
        </div>
        <div className="toolbar-right">
          {hasPerm('create_wo') && currentView !== 'requests' && (
            <button className="btn btn-primary" onClick={openCreateWOModal}>
              <span className="material-icons">add</span>Create Work Order
            </button>
          )}
        </div>
      </div>

      {/* WO Table */}
      {currentView !== 'requests' && (
        <div className="card">
          <div className="card-header">
            <span className="badge">{sortedWOs.length}</span> work orders
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('wo_id')} onClick={() => handleWoSort('wo_id')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('wo_id'); } }}>WO ID{woSortIcon('wo_id')}</th>
                  <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('description')} onClick={() => handleWoSort('description')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('description'); } }}>Description{woSortIcon('description')}</th>
                  <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('asset_name')} onClick={() => handleWoSort('asset_name')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('asset_name'); } }}>Asset{woSortIcon('asset_name')}</th>
                  <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('priority')} onClick={() => handleWoSort('priority')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('priority'); } }}>Priority{woSortIcon('priority')}</th>
                  {currentView === 'closed' ? (
                    <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('closed_date')} onClick={() => handleWoSort('closed_date')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('closed_date'); } }}>Closed Date{woSortIcon('closed_date')}</th>
                  ) : (
                    <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('due_date')} onClick={() => handleWoSort('due_date')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('due_date'); } }}>Due Date{woSortIcon('due_date')}</th>
                  )}
                  <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('status')} onClick={() => handleWoSort('status')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('status'); } }}>Status{woSortIcon('status')}</th>
                  <th scope="col" className="sortable-th" role="columnheader" aria-sort={ariaSort('assigned_to')} onClick={() => handleWoSort('assigned_to')} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleWoSort('assigned_to'); } }}>Assigned To{woSortIcon('assigned_to')}</th>
                  <th scope="col">Hours</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan="8" className="loading-cell">Loading...</td></tr>
                ) : sortedWOs.length === 0 ? (
                  <tr><td colSpan="8" className="loading-cell">No work orders found</td></tr>
                ) : sortedWOs.map(wo => (
                  <tr key={wo.wo_id} onClick={() => loadWODetail(wo.wo_id)}>
                    <td>
                      <span className="wo-id">{highlightMatch(wo.wo_id)}</span>
                      {woHasDocs[wo.wo_id] > 0 && (
                        <>
                          <span
                            className="material-icons"
                            aria-hidden="true"
                            title={`${woHasDocs[wo.wo_id]} attached document${woHasDocs[wo.wo_id] === 1 ? '' : 's'}`}
                            style={{
                              fontSize: 14,
                              color: '#868e96',
                              marginLeft: 6,
                              verticalAlign: 'middle',
                            }}
                          >
                            attach_file
                          </span>
                          <span className="sr-only">
                            {`(${woHasDocs[wo.wo_id]} attached document${woHasDocs[wo.wo_id] === 1 ? '' : 's'})`}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="wo-desc">{highlightMatch(wo.description)}</td>
                    <td>{highlightMatch(wo.asset_name || 'None')}</td>
                    <td><span className={`priority-badge ${wo.priority?.toLowerCase()}`}>{wo.priority}</span></td>
                    <td>{currentView === 'closed'
                      ? <span className="due-date">{formatDate(wo.closed_date)}</span>
                      : <span className={`due-date ${dueDateClass(wo.due_date, wo.isClosed)}`}>{formatDate(wo.due_date)}</span>
                    }</td>
                    <td><span className="status-badge" style={getStatusStyle(wo.status, wo.isClosed)}>{highlightMatch(wo.status)}</span></td>
                    <td>
                      {(() => {
                        const extra = woAssignments[wo.wo_id];
                        if (extra && extra.length > 0) {
                          const first = formatNameShort(extra[0].name || extra[0].email);
                          const moreNames = extra.slice(1).map(a => formatNameShort(a.name || a.email));
                          // Split extra assignees into highlighted and collapsed
                          const q = search.trim().toLowerCase();
                          const myEmail = (profile?.email || user?.email || '').toLowerCase();
                          const isMatch = (name, email) => {
                            if (q && name.toLowerCase().includes(q)) return true;
                            if (assignedToMeFilter && email && email.toLowerCase() === myEmail) return true;
                            return false;
                          };
                          const matchedExtras   = extra.slice(1).filter(a => isMatch(formatNameShort(a.name || a.email), a.email));
                          const unmatchedExtras = extra.slice(1).filter(a => !isMatch(formatNameShort(a.name || a.email), a.email)).map(a => formatNameShort(a.name || a.email));
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                              {highlightMatch(first)}
                              {/* Matched extra assignees: visible as highlighted chips */}
                              {matchedExtras.map((a, i) => {
                                const shortName = formatNameShort(a.name || a.email);
                                return (
                                  <span key={`match-${i}`} style={{
                                    fontSize: '0.75rem', fontWeight: 600,
                                    padding: '1px 6px', borderRadius: 10,
                                    background: '#fff3bf', color: '#664d03',
                                    border: '1px solid #ffe066', whiteSpace: 'nowrap',
                                  }}>
                                    {highlightMatch(shortName)}
                                  </span>
                                );
                              })}
                              {/* Remaining extras: collapsed behind the +N badge */}
                              {unmatchedExtras.length > 0 && (
                                <AssigneeBadge names={unmatchedExtras} onEnter={showAssigneeTooltip} onLeave={hideAssigneeTooltip} />
                              )}
                            </span>
                          );
                        }
                        return highlightMatch(formatNameShort(wo.assigned_to));
                      })()}
                    </td>
                    <td className="hours-cell">{formatHoursToTime(wo.total_hours || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Requests Table */}
      {currentView === 'requests' && (
        <div className="card">
          <div className="card-header">
            <span className="badge">{requestsData.length}</span> pending requests
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th scope="col">Request ID</th><th scope="col">From</th><th scope="col">Asset</th><th scope="col">Priority</th><th scope="col">Description</th><th scope="col">Date</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {requestsData.length === 0 ? (
                  <tr><td colSpan="7" className="loading-cell">No pending requests</td></tr>
                ) : requestsData.map(req => (
                  <tr key={req.request_id}>
                    <td className="wo-id">{req.request_id}</td>
                    <td>{req.name || req.email || '-'}</td>
                    <td>{req.asset_name || '-'}</td>
                    <td><span className={`priority-badge ${(req.priority || 'medium').toLowerCase()}`}>{req.priority || 'Medium'}</span></td>
                    <td className="wo-desc">{req.description}</td>
                    <td>{formatDate(req.created_at)}</td>
                    <td>
                      {hasPerm('create_wo') && (
                        <>
                          <button className="action-btn approve" onClick={() => openApproveModalFn(req)} title="Approve"><span className="material-icons">check_circle</span></button>
                          <button className="action-btn reject" onClick={() => rejectRequest(req)} title="Reject"><span className="material-icons">cancel</span></button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- MODALS ---------- */}

      {/* Create/Edit WO Modal */}
      {showCreateModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowCreateModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3>{formData.wo_id ? 'Edit Work Order' : 'Create Work Order'}</h3>
              <button className="modal-close" onClick={() => setShowCreateModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Description *</label>
                <textarea className="form-input" rows="3" placeholder="Describe the work..." value={formData.description || ''} onChange={e => setFormData({ ...formData, description: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Asset</label>
                  <select className="form-input" value={formData.asset_id || ''} onChange={e => {
                    const a = assets.find(a => a.asset_id === e.target.value);
                    setFormData({ ...formData, asset_id: e.target.value, asset_name: a?.name || '' });
                  }}>
                    <option value="">Select Asset (optional)</option>
                    {assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.name} ({a.asset_id})</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Priority *</label>
                  <select className="form-input" value={formData.priority || 'Medium'} onChange={e => setFormData({ ...formData, priority: e.target.value })}>
                    <option value="Low">Low</option><option value="Medium">Medium</option><option value="High">High</option>
                  </select>
                </div>
              </div>
              {formData.wo_id && (
                <>
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Assign To</label>
                      <select className="form-input" value={formData.assigned_email || ''} onChange={e => setFormData({ ...formData, assigned_email: e.target.value })}>
                        <option value="">Unassigned</option>
                        {assignOptions.map(u => <option key={u.email} value={u.email}>{u.name}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Status</label>
                      <StatusSelectComponent
                        statuses={openStatuses}
                        value={formData.status || ''}
                        onChange={(val) => setFormData({ ...formData, status: val })}
                        colorMap={statusColorMap}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Due Date</label>
                      <input type="date" className="form-input" value={formData.due_date ? formData.due_date.split('T')[0] : ''} onChange={e => setFormData({ ...formData, due_date: e.target.value })} />
                    </div>
                    <div className="form-group" />
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveWorkOrder}>Save Work Order</button>
            </div>
          </div>
        </div>
      )}

      {/* View WO Detail Modal */}
      {showViewModal && currentWO && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && closeViewModal()}>
          <div className="modal modal-xl">
            <div className="modal-header">
              <h3>
                {!currentWO.isClosed && hasPerm('close_wo') && (
                  <button className="btn btn-danger btn-sm" style={{ marginRight: 12 }} onClick={openCloseWOModalFn}>
                    <span className="material-icons" style={{ fontSize: '1rem' }}>check_circle</span>Close WO
                  </button>
                )}
                Work Order: {currentWO.wo_id}
                {currentWO.is_pm === 'Yes' && (
                  <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 12, fontSize: '0.7rem', fontWeight: 600, background: '#e7f5ff', color: '#1864ab', verticalAlign: 'middle' }}>PM</span>
                )}
              </h3>
              <button className="modal-close" onClick={closeViewModal}>&times;</button>
            </div>
            <div className="modal-body">
              {/* Header */}
              <div className="wo-detail-header">
                <div className="wo-detail-title">
                  {!currentWO.isClosed && hasPerm('edit_wo') ? (
                    <textarea className="form-input" value={viewDescription} onChange={e => setViewDescription(e.target.value)} rows={2} style={{ fontSize: '1.2rem', fontWeight: 600, resize: 'vertical' }} />
                  ) : (
                    <h2>{currentWO.description}</h2>
                  )}
                  <div className="wo-detail-badges">
                    {!currentWO.isClosed && hasPerm('edit_priority') ? (
                      <select className="form-input form-input-sm" value={viewPriority} onChange={e => setViewPriority(e.target.value)} style={{ maxWidth: 120, fontWeight: 600 }}>
                        <option value="Low">Low</option>
                        <option value="Medium">Medium</option>
                        <option value="High">High</option>
                        <option value="Critical">Critical</option>
                      </select>
                    ) : (
                      <span className={`priority-badge ${currentWO.priority?.toLowerCase()}`}>{currentWO.priority}</span>
                    )}
                    <span className="status-badge" style={getStatusStyle(currentWO.status, currentWO.isClosed)}>{currentWO.status}</span>
                  </div>
                </div>
              </div>

              {/* Detail Grid */}
              <div className="detail-grid">
                {/* Asset */}
                <div className="detail-item">
                  <label>Asset</label>
                  {!currentWO.isClosed && hasPerm('edit_wo') && profile?.role !== 'Student' ? (
                    <select className="form-input form-input-sm" value={viewAssetId} onChange={e => setViewAssetId(e.target.value)} style={{ maxWidth: 200 }}>
                      <option value="">None</option>
                      {assets.map(a => <option key={a.asset_id} value={a.asset_id} data-name={a.name}>{a.name} ({a.asset_id})</option>)}
                    </select>
                  ) : <span>{currentWO.asset_name || 'None'}</span>}
                </div>

                {/* Assigned To — derived from viewAssignees[0] to stay in sync without DB race */}
                <div className="detail-item">
                  <label>Primary Assignee</label>
                  <span>{viewAssignees[0]?.name || 'Unassigned'}</span>
                </div>

                {/* Due Date */}
                <div className="detail-item">
                  <label id="detail-due-date-label">Due Date</label>
                  {!currentWO.isClosed && hasPerm('edit_due_date') ? (
                    <input type="date" className="form-input form-input-sm" value={viewDueDate} onChange={e => setViewDueDate(e.target.value)} style={{ maxWidth: 150 }} aria-labelledby="detail-due-date-label" />
                  ) : <span>{formatDate(currentWO.due_date)}</span>}
                </div>

                {/* Closed Date — only shown for closed work orders */}
                {currentWO.isClosed && currentWO.closed_date && (
                  <div className="detail-item">
                    <label>Closed Date</label>
                    <span>{formatDate(currentWO.closed_date)}</span>
                  </div>
                )}

                {/* Total Time */}
                <div className="detail-item">
                  <label>Total Time</label>
                  <span>{formatHoursToTime(currentWO.total_hours || 0)}</span>
                </div>

                {/* Created */}
                <div className="detail-item">
                  <label>Created</label>
                  <span>{formatDate(currentWO.created_at)} by {currentWO.created_by || '-'}</span>
                </div>

                {/* Status */}
                <div className="detail-item">
                  <label>Status</label>
                  {!currentWO.isClosed && hasPerm('edit_status') ? (
                    <StatusSelectComponent
                      statuses={openStatuses}
                      value={viewStatus}
                      onChange={setViewStatus}
                      id="view-wo-status"
                      style={{ maxWidth: 200 }}
                      colorMap={statusColorMap}
                    />
                  ) : <span>{currentWO.status || '-'}</span>}
                </div>
              </div>

              {/* Assignees Section */}
              {(() => {
                const isInstructor = profile?.role === 'Instructor' || profile?.role === 'Super Admin';
                const myEmail = user?.email?.toLowerCase() || '';
                const alreadyAssigned = viewAssignees.some(a => a.email.toLowerCase() === myEmail);

                // What options can this user add?
                // Instructor: anyone not already assigned
                // Student/Work Study: only themselves (if not already on)
                const addableOptions = isInstructor
                  ? users.filter(u => !viewAssignees.find(a => a.email === u.email))
                  : (!alreadyAssigned ? [{ email: myEmail, name: `${profile?.first_name} ${profile?.last_name}` }] : []);

                const canManage = !currentWO.isClosed && (isInstructor || hasPerm('assign_wo') || !alreadyAssigned);

                return (
                  <div className="detail-section">
                    <h4>
                      <span className="material-icons">group</span>
                      Assignees
                      {viewAssignees.length > 0 && (
                        <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 400, color: '#868e96' }}>
                          {viewAssignees.length} assigned
                        </span>
                      )}
                    </h4>

                    {/* Assignee chips */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: viewAssignees.length > 0 ? 12 : 0 }}>
                      {viewAssignees.length === 0 && (
                        <span style={{ fontSize: '0.85rem', color: '#868e96' }}>No one assigned yet</span>
                      )}
                      {viewAssignees.map((a, idx) => {
                        const isPrimary = idx === 0; // first in assigned_at order = primary
                        const canRemove = !currentWO.isClosed && (
                          isInstructor || a.email.toLowerCase() === myEmail
                        );
                        return (
                          <span key={a.email} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            padding: '4px 10px', borderRadius: 20,
                            background: isPrimary ? '#e7f5ff' : '#f1f3f5',
                            color: isPrimary ? '#1864ab' : '#495057',
                            border: `1px solid ${isPrimary ? '#a5d8ff' : '#dee2e6'}`,
                            fontSize: '0.82rem', fontWeight: isPrimary ? 600 : 400
                          }}>
                            <span className="material-icons" style={{ fontSize: '0.95rem' }}>person</span>
                            {a.name || a.email}
                            {isPrimary && (
                              <span style={{ fontSize: '0.68rem', color: '#1971c2', marginLeft: 2 }} title="Lead assignee">★</span>
                            )}
                            {!isPrimary && !currentWO.isClosed && isInstructor && !assigneeSaving && (
                              <button
                                onClick={() => promoteToLead(a.email)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', color: '#adb5bd', display: 'flex', alignItems: 'center', lineHeight: 1, fontSize: '0.68rem' }}
                                title={`Make ${a.name || a.email} the lead`}
                              >★</button>
                            )}
                            {canRemove && !assigneeSaving && (
                              <button
                                onClick={() => removeAssignee(a.email)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', color: '#868e96', display: 'flex', alignItems: 'center', lineHeight: 1 }}
                                title={`Remove ${a.name}`}
                              >
                                <span className="material-icons" style={{ fontSize: '0.9rem' }}>close</span>
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>

                    {/* Add assignee controls — only shown on open WOs */}
                    {canManage && addableOptions.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {isInstructor ? (
                          <>
                            <select
                              className="form-input form-input-sm"
                              value={addAssigneeEmail}
                              onChange={e => {
                                const email = e.target.value;
                                if (!email) return;
                                setAddAssigneeEmail(email);
                                const u = users.find(u => u.email === email);
                                if (u) addAssignee(u.email, `${u.first_name} ${u.last_name}`);
                              }}
                              style={{ maxWidth: 220 }}
                              disabled={assigneeSaving}
                            >
                              <option value="">{assigneeSaving ? 'Adding…' : 'Select person to add…'}</option>
                              {addableOptions.map(u => (
                                <option key={u.email} value={u.email}>
                                  {u.email === myEmail ? `${u.first_name} ${u.last_name} (Me)` : `${u.first_name} ${u.last_name}`}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          /* Student/Work Study — can only add themselves */
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={assigneeSaving}
                            onClick={() => addAssignee(myEmail, `${profile?.first_name} ${profile?.last_name}`)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            <span className="material-icons" style={{ fontSize: '0.9rem' }}>person_add</span>
                            {assigneeSaving ? 'Adding…' : 'Add Myself'}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Hint for students who are already on this WO */}
                    {!currentWO.isClosed && !isInstructor && alreadyAssigned && (
                      <p style={{ fontSize: '0.78rem', color: '#868e96', margin: '4px 0 0' }}>
                        You're assigned to this work order. Remove yourself using the ✕ on your name above.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* PM Procedure Section (only for PM work orders with a procedure) */}
              {currentWO.is_pm === 'Yes' && currentWO.pm_id && pmProcedureUrl && (
                <div className="detail-section">
                  <h4><span className="material-icons">assignment</span>PM Procedure</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: '#ebfaff', border: '1px solid #a5d8ff', borderRadius: 8 }}>
                    <span className="material-icons" style={{ color: '#228be6', fontSize: '1.3rem' }}>description</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1864ab' }}>Procedure Document</div>
                      <div style={{ fontSize: '0.75rem', color: '#495057' }}>{pmProcedureName}</div>
                    </div>
                    <a href={pmProcedureUrl} target="_blank" rel="noopener noreferrer"
                      className="doc-link" style={{ background: '#228be6', color: '#fff', fontWeight: 600 }}>
                      <span className="material-icons">open_in_new</span>View Procedure
                    </a>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#868e96', marginTop: 6 }}>
                    Linked from PM schedule: {currentWO.pm_id}
                  </div>
                </div>
              )}

              {/* PM badge info for PM WOs without a procedure */}
              {currentWO.is_pm === 'Yes' && currentWO.pm_id && !pmProcedureUrl && (
                <div className="detail-section">
                  <h4><span className="material-icons">assignment</span>PM Information</h4>
                  <div style={{ padding: '10px 14px', background: '#f8f9fa', borderRadius: 8, border: '1px solid #e9ecef', fontSize: '0.85rem', color: '#495057' }}>
                    This work order was generated from PM schedule <strong>{currentWO.pm_id}</strong>. No procedure document is attached.
                  </div>
                </div>
              )}

              {/* Work Logs */}
              <div className="detail-section">
                <h4><span className="material-icons">schedule</span>Work Logs</h4>
                {workLogs.length > 0 ? (
                  <div className="worklogs-list">
                    {workLogs.map(log => (
                      <div key={log.log_id} className="worklog-item">
                        <div className="worklog-info">
                          <h5>{log.user_name || log.user_email || 'Unknown'}</h5>
                          <p>{formatDateTime(log.timestamp)}</p>
                          <p>{log.work_description || ''}</p>
                        </div>
                        <div className="worklog-actions">
                          <span className="worklog-hours">{formatHoursToTime(log.hours)}</span>
                          {hasPerm('delete_wo') && (
                            <button className="btn-delete-log" onClick={() => deleteWorkLog(log.log_id)}>
                              <span className="material-icons">delete</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state"><span className="material-icons">schedule</span><p>No work logs yet</p></div>
                )}
              </div>

              {/* Parts Used */}
              <div className="detail-section">
                <h4><span className="material-icons">inventory_2</span>Parts Used</h4>
                {partsUsed.length > 0 ? (
                  <div className="parts-list">
                    {partsUsed.map(p => (
                      <div key={p.record_id || p.id} className="part-item">
                        <div className="part-info"><h5>{p.part_name}</h5></div>
                        <span className="part-qty">x{p.quantity_used}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state"><span className="material-icons">inventory_2</span><p>No parts used</p></div>
                )}
              </div>

              {/* Documents */}
              <div className="detail-section">
                <h4><span className="material-icons">attach_file</span>Documents</h4>
                {woDocs.length > 0 ? (
                  <div className="docs-list">
                    {woDocs.map(doc => {
                      const url = doc.file_path ? supabase.storage.from('work-order-documents').getPublicUrl(doc.file_path).data?.publicUrl : '';
                      return (
                        <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <a href={url} target="_blank" rel="noopener noreferrer" className="doc-link" style={{ flex: 1 }}>
                            <span className="material-icons">description</span>{doc.file_name || 'Document'}
                          </a>
                          {hasPerm('delete_documents') && (
                            <button className="btn-delete-log" onClick={() => deleteWODoc(doc)} title="Delete document">
                              <span className="material-icons">delete</span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state"><span className="material-icons">attach_file</span><p>No documents attached</p></div>
                )}
              </div>

              {/* Linked Purchase Orders */}
              <div className="detail-section">
                <h4><span className="material-icons">local_shipping</span>Purchase Orders</h4>
                {linkedPOs.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {linkedPOs.map(po => (
                      <div key={po.order_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#f8f9fa', borderRadius: 8, border: '1px solid #e9ecef' }}>
                        <span className="material-icons" style={{ color: po.status === 'Received' ? '#40c057' : po.status === 'Ordered' ? '#228be6' : po.status === 'Rejected' ? '#fa5252' : '#fab005', fontSize: '1.2rem' }}>
                          {po.status === 'Received' ? 'check_circle' : po.status === 'Ordered' ? 'local_shipping' : po.status === 'Rejected' ? 'cancel' : 'hourglass_empty'}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1a1a2e' }}>{po.order_id}</div>
                          <div style={{ fontSize: '0.78rem', color: '#868e96' }}>{po.vendor_name || po.other_vendor || 'Unknown'} — ${parseFloat(po.total || 0).toFixed(2)}</div>
                        </div>
                        <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600,
                          background: po.status === 'Received' ? '#d3f9d8' : po.status === 'Ordered' ? '#d0ebff' : po.status === 'Approved' ? '#d0ebff' : po.status === 'Rejected' ? '#ffe3e3' : po.status === 'Cancelled' ? '#f1f3f5' : '#fff3bf',
                          color: po.status === 'Received' ? '#2b8a3e' : po.status === 'Ordered' ? '#1864ab' : po.status === 'Approved' ? '#1864ab' : po.status === 'Rejected' ? '#c92a2a' : po.status === 'Cancelled' ? '#868e96' : '#e67700'
                        }}>
                          {po.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state"><span className="material-icons">local_shipping</span><p>No purchase orders linked</p></div>
                )}
              </div>
            </div>

            {/* Footer Actions */}
            <div className="modal-footer" style={{ flexDirection: 'column', gap: 0, padding: 0 }}>
              {!currentWO.isClosed && (
                <>
                  {/* Action Toolbar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 20px', borderTop: '1px solid #e9ecef', background: '#f8f9fa', flexWrap: 'wrap' }}>
                    {hasPerm('add_work_log') && (
                      <button onClick={openWorkLogModalFn} className="wo-action-btn">
                        <span className="material-icons">schedule</span>Work Log
                      </button>
                    )}
                    {hasPerm('add_parts') && (
                      <button onClick={openPartsModalFn} className="wo-action-btn">
                        <span className="material-icons">inventory_2</span>Parts
                      </button>
                    )}
                    {hasPerm('upload_wo_doc') && (
                      <button onClick={uploadWODoc} className="wo-action-btn">
                        <span className="material-icons">upload_file</span>Upload
                      </button>
                    )}
                    {hasPerm('add_parts') && (
                      <button onClick={openGeneratePO} className="wo-action-btn">
                        <span className="material-icons">local_shipping</span>Generate PO
                      </button>
                    )}
                    <div style={{ flex: 1 }} />
                    {hasPerm('delete_wo') && (
                      <button className="wo-action-btn wo-action-btn-delete" onClick={() => deleteWorkOrder(currentWO.wo_id)}>
                        <span className="material-icons">delete_forever</span>
                      </button>
                    )}
                  </div>
                  {/* Save Bar */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 20px', borderTop: '1px solid #e9ecef' }}>
                    <button className="btn btn-primary" onClick={saveWOInline} style={{ minWidth: 160 }}>
                      <span className="material-icons" style={{ fontSize: '1rem' }}>save</span>Save Changes
                    </button>
                  </div>
                </>
              )}
              {currentWO.isClosed && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '16px 20px', borderTop: '1px solid #e9ecef' }}>
                  <button className="btn btn-secondary" onClick={closeViewModal}>Close</button>
                  {hasPerm('edit_wo') && (
                    <button className="btn btn-primary" onClick={reopenWorkOrder}><span className="material-icons">refresh</span>Reopen WO</button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Work Log Modal */}
      {showWorkLogModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowWorkLogModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Add Work Log</h3><button className="modal-close" onClick={() => setShowWorkLogModal(false)}>&times;</button></div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Time Worked *</label>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="number" className="form-input" min="0" max="23" value={workLogForm.hours} onChange={e => setWorkLogForm({ ...workLogForm, hours: parseInt(e.target.value) || 0 })} style={{ width: 70, textAlign: 'center' }} />
                    <span>hrs</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="number" className="form-input" min="0" max="59" step={timeIncrement} value={workLogForm.mins} onChange={e => setWorkLogForm({ ...workLogForm, mins: parseInt(e.target.value) || 0 })} style={{ width: 70, textAlign: 'center' }} />
                    <span>mins</span>
                  </div>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Work Performed *</label>
                <textarea className="form-input" rows="3" placeholder="Describe work done..." value={workLogForm.notes} onChange={e => setWorkLogForm({ ...workLogForm, notes: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowWorkLogModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveWorkLog}>Save Log</button>
            </div>
          </div>
        </div>
      )}

      {/* Parts Modal */}
      {showPartsModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowPartsModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header"><h3>Add Parts</h3><button className="modal-close" onClick={() => setShowPartsModal(false)}>&times;</button></div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Search Inventory</label>
                <input type="text" className="form-input" placeholder="Type to search inventory..." value={partsSearch} onChange={e => setPartsSearch(e.target.value)} />
              </div>
              <div className="parts-results">
                {partsResults.length > 0 ? partsResults.map(p => (
                  <div key={p.part_id} className="part-result" onClick={() => addPartToSelection(p)}>
                    <div><strong>{p.part_name}</strong><br /><small>{p.part_id}</small></div>
                    <span>Qty: {p.qty_in_stock}</span>
                  </div>
                )) : partsSearch && <p style={{ padding: 16, color: '#868e96' }}>No parts found. Use custom part below.</p>}
              </div>
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #e9ecef' }}>
                <h4 style={{ fontSize: '0.9rem', marginBottom: 12, color: '#495057' }}>Or Add Custom Part (not in inventory)</h4>
                <div className="form-row" style={{ gridTemplateColumns: '2fr 1fr auto' }}>
                  <div className="form-group">
                    <label className="form-label">Part Name</label>
                    <input type="text" className="form-input" placeholder="Enter part name..." value={customPartName} onChange={e => setCustomPartName(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Qty</label>
                    <input type="number" className="form-input" value={customPartQty} min="1" onChange={e => setCustomPartQty(parseInt(e.target.value) || 1)} />
                  </div>
                  <div className="form-group" style={{ alignSelf: 'flex-end', marginBottom: 16 }}>
                    <button className="btn btn-secondary" onClick={addCustomPart}>Add</button>
                  </div>
                </div>
              </div>
              <div className="selected-parts">
                <h4>Selected Parts:</h4>
                {selectedParts.length === 0 ? <div>None</div> : selectedParts.map((p, i) => (
                  <div key={i} className="selected-part-item">
                    <span>{p.partName}{!p.fromInventory ? ' (custom)' : ''}</span>
                    <input type="number" value={p.qty} min="1" onChange={e => {
                      const u = [...selectedParts];
                      u[i].qty = parseInt(e.target.value) || 1;
                      setSelectedParts(u);
                    }} />
                    <span className="remove-part material-icons" onClick={() => setSelectedParts(selectedParts.filter((_, idx) => idx !== i))}>close</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPartsModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={savePartUsage}>Add Parts</button>
            </div>
          </div>
        </div>
      )}

      {/* Close WO Modal */}
      {showCloseModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowCloseModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Close Work Order</h3><button className="modal-close" onClick={() => setShowCloseModal(false)}>&times;</button></div>
            <div className="modal-body">
              <p style={{ marginBottom: 16 }}>Are you sure you want to close this work order?</p>
              <div className="form-group">
                <label className="form-label">Final Notes</label>
                <textarea className="form-input" rows="2" placeholder="Optional closing notes..." value={closeNotes} onChange={e => setCloseNotes(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCloseModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={closeWorkOrder} disabled={loading}>{loading ? 'Closing...' : 'Close Work Order'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Approve Request Modal */}
      {showApproveModal && currentRequest && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowApproveModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Approve Request</h3><button className="modal-close" onClick={() => setShowApproveModal(false)}>&times;</button></div>
            <div className="modal-body">
              <p><strong>From:</strong> {currentRequest.name || currentRequest.email}</p>
              <p><strong>Description:</strong> {currentRequest.description}</p>
              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label">Priority</label>
                <select className="form-input" value={approveForm.priority} onChange={e => setApproveForm({ ...approveForm, priority: e.target.value })}>
                  <option value="Low">Low</option><option value="Medium">Medium</option><option value="High">High</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Assign To</label>
                <select className="form-input" value={approveForm.assignEmail} onChange={e => setApproveForm({ ...approveForm, assignEmail: e.target.value })}>
                  <option value="">Unassigned</option>
                  {assignOptions.map(u => <option key={u.email} value={u.email}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowApproveModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={approveRequest}>Approve &amp; Create WO</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <div className="modal-overlay visible" style={{ zIndex: 3000 }} onClick={e => e.target === e.currentTarget && setConfirmModal(null)}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div className="modal-header"><h3>{confirmModal.title || 'Confirm'}</h3><button className="modal-close" onClick={() => setConfirmModal(null)}>&times;</button></div>
            <div className="modal-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span className="material-icons" style={{ fontSize: 48, color: '#fab005' }}>help_outline</span>
                <p style={{ margin: 0, fontSize: '1rem', color: '#495057' }}>{confirmModal.message}</p>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setConfirmModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { setConfirmModal(null); confirmModal.onConfirm?.(); }}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Generate PO Modal */}
      {showGeneratePO && currentWO && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowGeneratePO(false)}>
          <div className="modal modal-xl" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h3><span className="material-icons" style={{ color: '#40c057', marginRight: 8 }}>local_shipping</span>
                {addToExisting ? `Add Items to ${existingPO?.order_id}` : `Generate Purchase Order for ${currentWO.wo_id}`}
              </h3>
              <button className="modal-close" onClick={() => setShowGeneratePO(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>

              {/* Vendor Selection — hidden when adding to existing */}
              {!addToExisting && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <label className="form-label">Vendor *</label>
                    <select value={poForm.vendorId || (poForm.otherVendor ? 'OTHER' : '')}
                      onChange={e => handlePOVendorChange(e.target.value)}
                      className="form-input" style={{ width: '100%' }}>
                      <option value="">Select vendor...</option>
                      {vendors.map(v => <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name}</option>)}
                      <option value="OTHER">Other (type name)</option>
                    </select>
                  </div>
                  {poForm.vendorId === '' && !poForm.vendorName && (
                    <div style={{ marginBottom: 16 }}>
                      <label className="form-label">Other Vendor Name</label>
                      <input value={poForm.otherVendor || ''} onChange={e => {
                        setPoForm(f => ({ ...f, otherVendor: e.target.value }));
                        // Debounced check for "Other" vendors
                        clearTimeout(window._otherVendorTimer);
                        window._otherVendorTimer = setTimeout(() => checkExistingPOs(e.target.value), 500);
                      }}
                        className="form-input" style={{ width: '100%' }} placeholder="Vendor name" />
                    </div>
                  )}
                </>
              )}

              {/* Existing PO Detection Banner */}
              {existingPO && !addToExisting && (
                <div style={{ background: '#e7f5ff', border: '1px solid #a5d8ff', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span className="material-icons" style={{ color: '#228be6', fontSize: '1.2rem' }}>merge_type</span>
                    <span style={{ fontWeight: 600, color: '#1864ab', fontSize: '0.88rem' }}>Existing PO found for this vendor</span>
                  </div>
                  <div style={{ background: '#fff', borderRadius: 6, padding: 10, marginBottom: 10, fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{existingPO.order_id}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600,
                        background: existingPO.status === 'Approved' ? '#d3f9d8' : '#fff3bf',
                        color: existingPO.status === 'Approved' ? '#2b8a3e' : '#e67700' }}>{existingPO.status}</span>
                    </div>
                    <div style={{ color: '#495057', fontSize: '0.78rem' }}>
                      Current total: <strong>${parseFloat(existingPO.total || 0).toFixed(2)}</strong>
                      {existingPO.work_order_id && <span> · Linked to {existingPO.work_order_id}</span>}
                      {existingPO.existingLines?.length > 0 && <span> · {existingPO.existingLines.length} item{existingPO.existingLines.length > 1 ? 's' : ''}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setAddToExisting(true)}
                      style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #228be6', background: '#228be6', color: '#fff', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }}>
                      <span className="material-icons" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>add_circle</span>
                      Add my items to {existingPO.order_id}
                    </button>
                    <button onClick={() => { setExistingPO(null); }}
                      style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #dee2e6', background: '#fff', color: '#495057', fontWeight: 500, fontSize: '0.82rem', cursor: 'pointer' }}>
                      Create New PO
                    </button>
                  </div>
                </div>
              )}

              {/* Add-to-existing info banner */}
              {addToExisting && existingPO && (
                <div style={{ background: '#e7f5ff', border: '1px solid #a5d8ff', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span className="material-icons" style={{ color: '#228be6', fontSize: '1.1rem' }}>info</span>
                    <span style={{ fontWeight: 600, color: '#1864ab', fontSize: '0.85rem' }}>Adding items to {existingPO.order_id}</span>
                  </div>
                  <p style={{ fontSize: '0.78rem', color: '#495057', margin: 0 }}>
                    Your items for <strong>{currentWO.wo_id}</strong> will be added to the existing {existingPO.vendor_name || existingPO.other_vendor} order.
                    The PO will be sent back to instructors for re-approval with the combined items.
                  </p>
                  {existingPO.existingLines?.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: '0.75rem', color: '#868e96' }}>
                      Existing items: {existingPO.existingLines.map(l => l.description).join(', ')}
                    </div>
                  )}
                  <button onClick={() => { setAddToExisting(false); }}
                    style={{ marginTop: 8, padding: '4px 10px', borderRadius: 4, border: '1px solid #dee2e6', background: '#fff', color: '#495057', fontSize: '0.75rem', cursor: 'pointer' }}>
                    ← Back to new PO
                  </button>
                </div>
              )}

              {/* Notes - only for new PO */}
              {!addToExisting && (
                <div style={{ marginBottom: 16 }}>
                  <label className="form-label">Notes</label>
                  <input value={poForm.notes} onChange={e => setPoForm(f => ({ ...f, notes: e.target.value }))}
                    className="form-input" style={{ width: '100%' }} placeholder="Notes..." />
                </div>
              )}

              {/* Line Items */}
              <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className="form-label" style={{ margin: 0, fontWeight: 600 }}>
                  {addToExisting ? `New Items for ${currentWO.wo_id}` : 'Line Items'}
                </label>
                <button className="btn btn-secondary btn-sm" onClick={() => setPoLines(l => [...l, { partNumber: '', description: '', link: '', unitPrice: '', quantity: 1, inventoryPartId: '' }])}>
                  <span className="material-icons" style={{ fontSize: '0.9rem' }}>add</span>Add Line
                </button>
              </div>

              {poLines.map((li, i) => (
                <div key={i} style={{ border: '1px solid #dee2e6', borderRadius: 8, padding: 12, marginBottom: 10, background: '#f8f9fa' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#868e96' }}>Item {i + 1}</span>
                    {poLines.length > 1 && (
                      <button onClick={() => setPoLines(l => l.filter((_, idx) => idx !== i))}
                        style={{ background: 'none', border: 'none', color: '#fa5252', cursor: 'pointer', padding: 2 }}>
                        <span className="material-icons" style={{ fontSize: '1rem' }}>delete</span>
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.72rem', color: '#868e96' }}>Part Number</label>
                      <input value={li.partNumber} onChange={e => { const updated = [...poLines]; updated[i].partNumber = e.target.value; setPoLines(updated); }}
                        className="form-input form-input-sm" style={{ width: '100%' }} placeholder="Part #" />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.72rem', color: '#868e96' }}>Description *</label>
                      <input value={li.description} onChange={e => { const updated = [...poLines]; updated[i].description = e.target.value; setPoLines(updated); }}
                        className="form-input form-input-sm" style={{ width: '100%' }} placeholder="Description" />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.72rem', color: '#868e96' }}>Unit Price</label>
                      <input type="number" step="0.01" value={li.unitPrice} onChange={e => { const updated = [...poLines]; updated[i].unitPrice = e.target.value; setPoLines(updated); }}
                        className="form-input form-input-sm" style={{ width: '100%' }} placeholder="0.00" />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.72rem', color: '#868e96' }}>Quantity</label>
                      <input type="number" min={1} value={li.quantity} onChange={e => { const updated = [...poLines]; updated[i].quantity = e.target.value; setPoLines(updated); }}
                        className="form-input form-input-sm" style={{ width: '100%' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.72rem', color: '#868e96' }}>Subtotal</label>
                      <div className="form-input form-input-sm" style={{ background: '#e9ecef', fontWeight: 600 }}>
                        ${((parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0)).toFixed(2)}
                      </div>
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: '0.72rem', color: '#868e96' }}>Link (optional)</label>
                    <input value={li.link} onChange={e => { const updated = [...poLines]; updated[i].link = e.target.value; setPoLines(updated); }}
                      className="form-input form-input-sm" style={{ width: '100%' }} placeholder="https://..." />
                  </div>
                </div>
              ))}

              {/* Total */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '2px solid #e9ecef', marginTop: 8 }}>
                <span style={{ fontWeight: 600, color: '#495057' }}>
                  {addToExisting ? 'New Items Total' : 'Total'}
                </span>
                <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1a1a2e' }}>
                  ${poLines.reduce((sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0), 0).toFixed(2)}
                </span>
              </div>
              {addToExisting && existingPO && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: '0.85rem', color: '#495057' }}>
                  <span>Combined Total</span>
                  <span style={{ fontWeight: 700 }}>
                    ${(parseFloat(existingPO.total || 0) + poLines.reduce((sum, li) => sum + (parseFloat(li.unitPrice) || 0) * (parseInt(li.quantity) || 0), 0)).toFixed(2)}
                  </span>
                </div>
              )}

              <div style={{ background: '#fff3bf', borderRadius: 8, padding: 12, marginTop: 12, fontSize: '0.82rem', color: '#e67700', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-icons" style={{ fontSize: '1.1rem' }}>info</span>
                {addToExisting
                  ? `Items will be added to ${existingPO?.order_id} and the PO will require instructor re-approval.`
                  : 'This PO will be sent to instructors for approval. The work order will change to "Awaiting Parts".'}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowGeneratePO(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitGeneratePO} disabled={poSaving}
                style={{ background: addToExisting ? '#228be6' : '#40c057', borderColor: addToExisting ? '#228be6' : '#40c057' }}>
                <span className="material-icons" style={{ fontSize: '1rem' }}>{poSaving ? 'hourglass_empty' : (addToExisting ? 'add_circle' : 'local_shipping')}</span>
                {poSaving ? 'Submitting...' : (addToExisting ? `Add to ${existingPO?.order_id}` : 'Submit Purchase Order')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rejection Modal for WO Requests ── */}
      <RejectionModal
        open={!!rejectTarget}
        title="Reject Work Order Request"
        subtitle={rejectTarget
          ? `${rejectTarget.name || rejectTarget.email || 'Unknown'} — ${rejectTarget.asset_name || 'No asset'}`
          : ''
        }
        requestType="Work Order Request"
        requestId={rejectTarget?.request_id || ''}
        recipientEmail={rejectTarget?.email || ''}
        recipientName={rejectTarget?.name || ''}
        onConfirm={handleRejectConfirm}
        onClose={() => setRejectTarget(null)}
      />

      {/* Styles */}
      <style>{`
        .wo-page { position: relative; }
        .wo-action-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 6px; font-size: 0.78rem; font-weight: 500; cursor: pointer; border: 1px solid #dee2e6; background: #fff; color: #495057; transition: all 0.15s; }
        .wo-action-btn:hover { background: #e9ecef; border-color: #ced4da; }
        .wo-action-btn .material-icons { font-size: 0.95rem; }
        .wo-action-btn-po { background: #ebfbee; color: #2b8a3e; border-color: #b2f2bb; }
        .wo-action-btn-po:hover { background: #d3f9d8; border-color: #8ce99a; }
        .wo-action-btn-delete { background: #fff5f5; color: #c92a2a; border-color: #ffc9c9; padding: 6px 8px; }
        .wo-action-btn-delete:hover { background: #ffe3e3; border-color: #ffa8a8; }
        .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; z-index: 5000; font-size: 0.9rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .toast-success { background: #40c057; }
        .toast-error { background: #fa5252; }
        .toast-info { background: #228be6; }
        .page-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
        .toolbar-left { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .toolbar-right { display: flex; gap: 8px; }
        .view-toggle { display: flex; background: #f1f3f5; border-radius: 8px; padding: 4px; }
        .toggle-btn { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border: none; background: transparent; cursor: pointer; border-radius: 6px; font-size: 0.85rem; color: #495057; position: relative; }
        .toggle-btn.active { background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); color: #228be6; }
        .toggle-btn .material-icons { font-size: 1rem; }
        .request-badge { position: absolute; top: -4px; right: -4px; background: #fa5252; color: white; font-size: 0.65rem; padding: 2px 6px; border-radius: 10px; }
        .search-box { display: flex; align-items: center; gap: 8px; background: white; border: 1px solid #dee2e6; border-radius: 8px; padding: 8px 12px; }
        .search-box input { border: none; outline: none; font-size: 0.9rem; min-width: 200px; }
        .filter-select { padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; background: white; }
        .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; }
        .card-header { padding: 16px 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .badge { background: #228be6; color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; }
        .table-container { overflow-x: auto; }
        .data-table { width: 100%; border-collapse: collapse; }
        .data-table th, .data-table td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e9ecef; }
        .data-table th { background: #f8f9fa; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
        .sortable-th { cursor: pointer; user-select: none; white-space: nowrap; }
        .sortable-th:hover { background: #e9ecef; }
        .sortable-th:focus-visible { outline: 2px solid #228be6; outline-offset: -2px; background: #e9ecef; }
        .data-table tr { cursor: pointer; }
        .data-table tr:hover { background: #f8f9fa; }
        .loading-cell { text-align: center; color: #868e96; padding: 40px !important; cursor: default; }
        .wo-id { font-weight: 600; color: #228be6; }
        .wo-desc { max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .priority-badge { padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
        .priority-badge.high { background: #ffe3e3; color: #c92a2a; }
        .priority-badge.medium { background: #fff3bf; color: #e67700; }
        .priority-badge.low { background: #d3f9d8; color: #2b8a3e; }
        .status-badge { padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: 500; display: inline-block; }
        .due-date { font-size: 0.85rem; }
        .due-date.overdue { color: #c92a2a; font-weight: 600; }
        .due-date.soon { color: #e67700; }
        .hours-cell { font-weight: 500; }
        .wo-assignee-more { position: relative; }
        .action-btn { background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px; color: #495057; }
        .action-btn:hover { background: #e9ecef; }
        .action-btn.approve { color: #40c057; }
        .action-btn.reject { color: #fa5252; }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
        .modal-overlay.visible { display: flex; }
        .modal { background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; }
        .modal-lg { max-width: 700px; }
        .modal-xl { max-width: 900px; }
        .modal-header { padding: 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h3 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; }
        .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; }
        .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
        .modal-footer { padding: 16px 20px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 6px; }
        .form-input { width: 100%; padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; font-family: inherit; box-sizing: border-box; }
        .form-input-sm { padding: 6px 10px; font-size: 0.85rem; }
        .form-input:focus { outline: none; border-color: #228be6; }
        .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 6px; }
        .btn-primary { background: #228be6; color: white; }
        .btn-secondary { background: #f8f9fa; color: #495057; }
        .btn-danger { background: #fa5252; color: white; }
        .btn-sm { padding: 6px 12px; font-size: 0.8rem; }
        .wo-detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e9ecef; }
        .wo-detail-title { flex: 1; }
        .wo-detail-title h2 { margin: 0 0 8px; font-size: 1.25rem; }
        .wo-detail-badges { display: flex; gap: 8px; }
        .detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
        .detail-item { background: #f8f9fa; padding: 12px; border-radius: 8px; }
        .detail-item label { display: block; font-size: 0.75rem; color: #868e96; margin-bottom: 4px; }
        .detail-item span { font-weight: 500; }
        .detail-section { margin-bottom: 24px; }
        .detail-section h4 { display: flex; align-items: center; gap: 8px; font-size: 0.95rem; margin-bottom: 12px; color: #495057; }
        .detail-section h4 .material-icons { font-size: 1.1rem; color: #228be6; }
        .worklogs-list, .parts-list { display: flex; flex-direction: column; gap: 12px; }
        .worklog-item, .part-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f8f9fa; border-radius: 8px; }
        .worklog-info h5, .part-info h5 { margin: 0 0 4px; font-size: 0.9rem; }
        .worklog-info p, .part-info p { margin: 0; font-size: 0.8rem; color: #868e96; }
        .worklog-hours { font-weight: 600; color: #228be6; }
        .worklog-actions { display: flex; align-items: center; gap: 12px; }
        .btn-delete-log { background: none; border: none; cursor: pointer; color: #868e96; padding: 4px; border-radius: 4px; display: flex; align-items: center; }
        .btn-delete-log:hover { background: #ffe3e3; color: #c92a2a; }
        .btn-delete-log .material-icons { font-size: 1.1rem; }
        .part-qty { font-weight: 600; }
        .parts-results { max-height: 200px; overflow-y: auto; margin-bottom: 16px; }
        .part-result { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #e9ecef; cursor: pointer; }
        .part-result:hover { background: #f8f9fa; }
        .selected-parts h4 { font-size: 0.9rem; margin-bottom: 8px; }
        .selected-part-item { display: flex; align-items: center; gap: 12px; padding: 8px; background: #e7f5ff; border-radius: 6px; margin-bottom: 8px; }
        .selected-part-item input { width: 60px; padding: 4px 8px; border: 1px solid #dee2e6; border-radius: 4px; }
        .remove-part { cursor: pointer; color: #fa5252; }
        .empty-state { text-align: center; padding: 30px; color: #868e96; }
        .empty-state .material-icons { font-size: 2.5rem; margin-bottom: 8px; }
        .docs-list { display: flex; flex-wrap: wrap; gap: 12px; }
        .doc-link { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; background: #e7f5ff; color: #1971c2; text-decoration: none; border-radius: 8px; font-size: 0.85rem; transition: background 0.2s; }
        .doc-link:hover { background: #d0ebff; }
        .doc-link .material-icons { font-size: 1.1rem; }
      `}</style>
    </div>
  );
}
