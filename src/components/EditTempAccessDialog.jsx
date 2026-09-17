/**
 * RICT CMMS — EditTempAccessDialog
 *
 * Instructor dialog for changing an ACTIVE temporary access grant without
 * revoking and re-granting it. Opened from the Dashboard "Active Temp Access"
 * card (Edit button beside Revoke).
 *
 *   • Permission-type grants: add or remove permissions from the granted set.
 *     The checklist shows every permission the user's base role does NOT
 *     already hold (same rule as the student request modal in AppLayout),
 *     plus anything currently granted, pre-checked. At least one must remain.
 *   • Role-type grants: switch the temp role between Work Study and Instructor.
 *   • Both: change the expiry — keep the current date, a fixed number of days
 *     from today, Rest of Semester, or a custom end date (same options as
 *     approval in NotificationBell, via src/lib/semesterEnd.js).
 *
 * The write is one call to the `edit_temp_access_request` RPC
 * (supabase/migrations/20260916_edit_revoke_temp_access_rpc.sql): it requires
 * an instructor caller, refuses non-Active grants, updates profiles.role in
 * the same transaction for role-type grants, records edited_by / edited_date,
 * and writes an audit_log row. Either everything lands or nothing does.
 *
 * Realtime: usePermissions, AppLayout (banner + auto-expiry) and the
 * Dashboard card already subscribe to temp_access_requests, so the change
 * takes effect for the user immediately — nothing else needs to refetch.
 *
 * Accessibility (WCAG 2.1 AA / Section 508)
 *   useDialogA11y (focus in, Tab trap, Esc closes, focus restored),
 *   role="dialog" + aria-modal + aria-labelledby, visible labels on every
 *   control, inline errors tied via aria-describedby / aria-invalid, a
 *   role="status" change summary, 44px targets, focus-visible rings.
 *
 * Props
 *   grant    — the temp_access_requests row being edited (status 'Active')
 *   onClose  — called to dismiss (Cancel, ×, Esc, overlay click)
 *   onSaved  — (updatedRow, summaryText) after a successful save
 *
 * File: src/components/EditTempAccessDialog.jsx
 */

import React, { useState, useEffect, useMemo, useCallback, useId } from 'react';
import { supabase } from '@/lib/supabase';
import { mustData } from '@/lib/supabaseData';
import { useDialogA11y } from '@/hooks/useDialogA11y';
import { fetchSemesterEnd, semesterEndExpiry, semesterInfoFromEndStr, localTodayStr } from '@/lib/semesterEnd';
import '@/styles/dashboard.css';

const FIXED_DAYS = [1, 2, 3, 5, 7];
const KEEP = 'keep';
const SEMESTER = 'semester';
const CUSTOM = 'custom';

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const roleKeyOf = (role) => String(role || 'student').toLowerCase().replace(' ', '_');
const roleHas = (perm, roleKey) => perm[roleKey] === true || perm[roleKey] === 'true' || perm[roleKey] === 'Yes';

export default function EditTempAccessDialog({ grant, onClose, onSaved }) {
  const uid = useId();
  const isPermType = grant?.request_type === 'permissions';
  const dialogRef = useDialogA11y(true, onClose);

  // ── Role (role-type grants) ──
  const [role, setRole] = useState(grant?.approved_role || 'Work Study');

  // ── Permissions (permission-type grants) ──
  const [allPerms, setAllPerms] = useState([]);
  const [permsLoading, setPermsLoading] = useState(isPermType);
  const [permsError, setPermsError] = useState('');
  const [selected, setSelected] = useState(() => {
    const init = {};
    (grant?.approved_permissions || []).forEach(p => { if (p?.permission_id) init[p.permission_id] = p; });
    return init;
  });
  const [search, setSearch] = useState('');
  const [expandedPages, setExpandedPages] = useState(() => {
    const init = {};
    (grant?.approved_permissions || []).forEach(p => { if (p?.page) init[p.page] = true; });
    return init;
  });

  // ── Expiry ──
  const [durationMode, setDurationMode] = useState(KEEP);
  const [days, setDays] = useState(3);
  const [customDate, setCustomDate] = useState('');
  const [semester, setSemester] = useState(null);

  // ── Save state ──
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const originalIds = useMemo(
    () => (grant?.approved_permissions || []).map(p => p?.permission_id).filter(Boolean).sort(),
    [grant],
  );

  // Semester end for the "Rest of Semester" option.
  useEffect(() => {
    let cancelled = false;
    fetchSemesterEnd()
      .then(sem => { if (!cancelled) setSemester(sem); })
      .catch(e => console.warn('EditTempAccess: semester end lookup failed:', e.message));
    return () => { cancelled = true; };
  }, []);

  // Load the grantable permission list for permission-type grants.
  useEffect(() => {
    if (!isPermType) return undefined;
    let cancelled = false;
    (async () => {
      setPermsLoading(true);
      setPermsError('');
      try {
        // The user's base role — read live so a role change since the
        // request was filed doesn't leave stale rows in the list.
        let baseRole = grant?.user_current_role || 'Student';
        if (grant?.user_email) {
          const { data: prof } = await supabase.from('profiles').select('role').eq('email', grant.user_email).maybeSingle();
          if (prof?.role) baseRole = prof.role;
        }
        const roleKey = roleKeyOf(baseRole);

        const rows = mustData(await supabase.from('permissions').select('*').order('page').order('feature'), 'permissions.select') || [];
        if (cancelled) return;

        const granted = new Set(originalIds);
        // Show what the role lacks, plus anything currently granted (even if
        // the role has since gained it) so it can still be unchecked.
        const list = rows
          .filter(p => !roleHas(p, roleKey) || granted.has(p.permission_id))
          .map(p => ({ permission_id: p.permission_id, page: p.page, feature: p.feature, description: p.description || '' }));

        // Keep granted permissions that no longer exist in the table so the
        // instructor can see and remove them.
        const known = new Set(list.map(p => p.permission_id));
        (grant?.approved_permissions || []).forEach(p => {
          if (p?.permission_id && !known.has(p.permission_id)) {
            list.push({ permission_id: p.permission_id, page: p.page || 'Other', feature: p.feature || p.permission_id, description: (p.description ? p.description + ' ' : '') + '(no longer defined)' });
          }
        });
        setAllPerms(list);
      } catch (e) {
        if (!cancelled) setPermsError('Could not load the permission list: ' + e.message);
      }
      if (!cancelled) setPermsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isPermType, grant, originalIds]);

  // ── Derived: grouped + filtered permission list ──
  const grouped = useMemo(() => {
    const acc = {};
    allPerms.forEach(p => { (acc[p.page] ||= []).push(p); });
    return acc;
  }, [allPerms]);

  const q = search.trim().toLowerCase();
  const visiblePages = useMemo(() => Object.entries(grouped).filter(([page, perms]) => {
    if (!q) return true;
    return page.toLowerCase().includes(q) || perms.some(p => p.feature.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  }), [grouped, q]);

  const selectedCount = Object.keys(selected).length;
  const selectedIds = useMemo(() => Object.keys(selected).sort(), [selected]);
  const permsChanged = isPermType && (selectedIds.length !== originalIds.length || selectedIds.some((id, i) => id !== originalIds[i]));
  const addedCount   = selectedIds.filter(id => !originalIds.includes(id)).length;
  const removedCount = originalIds.filter(id => !selectedIds.includes(id)).length;
  const roleChanged  = !isPermType && role !== (grant?.approved_role || '');

  const togglePerm = (p) => setSelected(prev => {
    const next = { ...prev };
    if (next[p.permission_id]) delete next[p.permission_id]; else next[p.permission_id] = p;
    return next;
  });
  const setPage = (page, on) => setSelected(prev => {
    const next = { ...prev };
    (grouped[page] || []).forEach(p => { if (on) next[p.permission_id] = p; else delete next[p.permission_id]; });
    return next;
  });
  const togglePage = (page) => setExpandedPages(prev => ({ ...prev, [page]: !prev[page] }));

  // ── Derived: expiry ──
  const currentExpiry = grant?.expiry_date ? new Date(grant.expiry_date) : null;
  const currentExpiryPast = !currentExpiry || Number.isNaN(currentExpiry.getTime()) || currentExpiry <= new Date();

  const customMin = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return localTodayStr(d); })();
  const customMax = semester
    ? localTodayStr(semester.endDate)
    : (() => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return localTodayStr(d); })();
  const customInfo = durationMode === CUSTOM ? semesterInfoFromEndStr(customDate) : null;
  const customError = durationMode !== CUSTOM ? ''
    : !customDate ? 'Choose an end date.'
    : !customInfo ? 'End date must be after today.'
    : customDate > customMax ? `End date cannot be after ${semester ? `the semester end (${semester.label})` : 'one year from today'}.`
    : '';
  const keepError = durationMode === KEEP && currentExpiryPast ? 'The current expiry has already passed — choose a new end date.' : '';
  const expiryError = customError || keepError;

  const newExpiry = (() => {
    if (durationMode === KEEP) return currentExpiryPast ? null : currentExpiry;
    if (durationMode === SEMESTER && semester?.endDate) return semesterEndExpiry(semester.endDate);
    if (durationMode === CUSTOM && customInfo?.endDate) return semesterEndExpiry(customInfo.endDate);
    if (durationMode === 'days') { const d = new Date(); d.setDate(d.getDate() + days); return d; }
    return null;
  })();

  const expiryChanged = durationMode !== KEEP;

  const durationValue = durationMode === KEEP ? KEEP
    : durationMode === SEMESTER ? SEMESTER
    : durationMode === CUSTOM ? CUSTOM
    : String(days);

  const handleDurationChange = (value) => {
    if (value === KEEP) { setDurationMode(KEEP); return; }
    if (value === SEMESTER && semester) { setDurationMode(SEMESTER); setDays(semester.daysLeft); return; }
    if (value === CUSTOM) {
      setDurationMode(CUSTOM);
      // Prefill with the current expiry date when it is still usable.
      if (!customDate && currentExpiry && !currentExpiryPast) {
        const s = localTodayStr(currentExpiry);
        if (s >= customMin && s <= customMax) setCustomDate(s);
      }
      return;
    }
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n > 0) { setDurationMode('days'); setDays(n); }
  };

  // ── Validation + change summary ──
  const hasChanges = permsChanged || roleChanged || expiryChanged;
  const permCountError = isPermType && !permsLoading && selectedCount === 0 ? 'At least one permission must remain granted. Use Revoke to remove all access.' : '';
  const canSave = hasChanges && !expiryError && !permCountError && !saving && !permsLoading && !!newExpiry;

  const summaryParts = [];
  if (permsChanged) {
    if (addedCount)   summaryParts.push(`${addedCount} permission${addedCount !== 1 ? 's' : ''} added`);
    if (removedCount) summaryParts.push(`${removedCount} permission${removedCount !== 1 ? 's' : ''} removed`);
  }
  if (roleChanged) summaryParts.push(`role ${grant?.approved_role || '—'} → ${role}`);
  if (expiryChanged && newExpiry) summaryParts.push(`expires ${fmtDate(currentExpiry)} → ${fmtDate(newExpiry)}`);
  const summaryText = summaryParts.length ? `Changes: ${summaryParts.join(', ')}.` : 'No changes yet.';

  // ── Save ──
  const save = useCallback(async () => {
    if (!canSave || !grant) return;
    setSaving(true);
    setError('');
    try {
      const approvedPerms = isPermType
        ? allPerms.filter(p => selected[p.permission_id]).map(p => ({ permission_id: p.permission_id, page: p.page, feature: p.feature, description: p.description || '' }))
        : null;
      // expiry_date is true UTC (compared against new Date() everywhere), so
      // toISOString() is correct here — same as approval.
      const row = mustData(await supabase.rpc('edit_temp_access_request', {
        p_request_id: grant.request_id,
        p_expiry_date: newExpiry.toISOString(),
        p_approved_role: isPermType ? null : role,
        p_approved_permissions: approvedPerms,
      }), 'edit_temp_access_request');
      if (!row || row.status !== 'Active') throw new Error('The grant was not updated — it may no longer be active.');
      onSaved?.(row, summaryText);
    } catch (e) {
      setError(e.message || 'Save failed.');
      setSaving(false);
    }
  }, [canSave, grant, isPermType, allPerms, selected, newExpiry, role, onSaved, summaryText]);

  if (!grant) return null;

  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  const roleId = `${uid}-role`;
  const durId = `${uid}-duration`;
  const durHintId = `${uid}-duration-hint`;
  const dateId = `${uid}-date`;
  const dateHintId = `${uid}-date-hint`;
  const dateErrId = `${uid}-date-err`;
  const searchId = `${uid}-search`;
  const searchHintId = `${uid}-search-hint`;
  const permErrId = `${uid}-perm-err`;
  const summaryId = `${uid}-summary`;
  const errId = `${uid}-error`;
  const accent = isPermType ? '#7c3aed' : '#f59f00';

  return (
    <div className="dash-modal-overlay" onClick={e => e.target === e.currentTarget && !saving && onClose()}>
      <div
        ref={dialogRef}
        className="dash-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={{ maxWidth: isPermType ? 560 : 440, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 40px)' }}
      >
        <div className="dash-modal-header">
          <h4 id={titleId}>
            <span className="material-icons" aria-hidden="true" style={{ color: accent }}>edit</span>
            Edit Temp Access
          </h4>
          <button type="button" className="dash-modal-close" aria-label="Close" onClick={onClose} disabled={saving}>&times;</button>
        </div>

        <div className="dash-modal-body" style={{ overflowY: 'auto', flex: 1 }}>
          <p id={descId} style={{ margin: 0, fontSize: '0.9rem', color: '#495057' }}>
            <strong>{grant.user_name || grant.user_email}</strong>
            {isPermType
              ? <> — {originalIds.length} temporary permission{originalIds.length !== 1 ? 's' : ''} (role unchanged: {grant.user_current_role || '—'})</>
              : <> — temporary <strong>{grant.approved_role}</strong> role (was {grant.user_original_role || grant.user_current_role || '—'})</>}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#868e96' }}>
            Currently expires {fmtDate(grant.expiry_date)}
            {grant.reviewed_by ? ` · granted by ${grant.reviewed_by}` : ''}
            {grant.edited_by ? ` · last edited by ${grant.edited_by} on ${fmtDate(grant.edited_date)}` : ''}
          </p>

          {/* ── Role (role-type only) ── */}
          {!isPermType && (
            <>
              <label htmlFor={roleId} className="dash-label">Temporary role</label>
              <select id={roleId} className="dash-input" value={role} onChange={e => setRole(e.target.value)} disabled={saving} style={{ minHeight: 44 }}>
                <option value="Work Study">Work Study</option>
                <option value="Instructor">Instructor</option>
              </select>
            </>
          )}

          {/* ── Expiry ── */}
          <label htmlFor={durId} className="dash-label">Access ends</label>
          <select
            id={durId}
            className="dash-input"
            value={durationValue}
            onChange={e => handleDurationChange(e.target.value)}
            aria-describedby={durHintId}
            disabled={saving}
            style={{ minHeight: 44 }}
          >
            <option value={KEEP}>Keep current ({fmtDate(grant.expiry_date)})</option>
            {FIXED_DAYS.map(d => (
              <option key={d} value={String(d)}>{d === 7 ? '1 week from today' : `${d} day${d !== 1 ? 's' : ''} from today`}</option>
            ))}
            {semester && <option value={SEMESTER}>Rest of Semester ({semester.label})</option>}
            <option value={CUSTOM}>Custom end date…</option>
          </select>
          <p id={durHintId} style={{ fontSize: '0.75rem', color: '#868e96', margin: '4px 0 0' }}>
            Fixed durations count from today, not from the original approval.
            {keepError ? <span style={{ color: '#c92a2a', display: 'block' }}>{keepError}</span> : null}
          </p>

          {durationMode === CUSTOM && (
            <div style={{ marginTop: 8 }}>
              <label htmlFor={dateId} className="dash-label" style={{ marginTop: 0 }}>Access ends on</label>
              <input
                id={dateId}
                type="date"
                className="dash-input"
                value={customDate}
                min={customMin}
                max={customMax}
                required
                aria-required="true"
                aria-invalid={customError ? 'true' : 'false'}
                aria-describedby={customError ? `${dateHintId} ${dateErrId}` : dateHintId}
                onChange={e => setCustomDate(e.target.value)}
                disabled={saving}
                style={{ minHeight: 44 }}
              />
              <p id={dateHintId} style={{ fontSize: '0.75rem', color: '#868e96', margin: '4px 0 0' }}>
                Access expires at 11:59 PM on this date{semester ? ` (no later than ${semester.label})` : ''}.
                {customInfo && !customError ? ` That is ${customInfo.daysLeft} day${customInfo.daysLeft !== 1 ? 's' : ''} from today.` : ''}
              </p>
              <p id={dateErrId} role="alert" aria-live="polite" style={{ fontSize: '0.78rem', color: '#c92a2a', margin: '4px 0 0', minHeight: customError ? undefined : 0 }}>
                {customError}
              </p>
            </div>
          )}

          {/* ── Permissions (permission-type only) ── */}
          {isPermType && (
            <>
              <label htmlFor={searchId} className="dash-label">Granted permissions</label>
              <input
                id={searchId}
                type="search"
                className="dash-input"
                placeholder="Filter by page or feature…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                aria-describedby={searchHintId}
                disabled={saving || permsLoading}
                style={{ minHeight: 44 }}
              />
              <p id={searchHintId} style={{ fontSize: '0.75rem', color: '#868e96', margin: '4px 0 8px' }}>
                Check to grant, uncheck to remove. Shows permissions the user's role does not already have, plus what is currently granted.
              </p>

              {permsLoading ? (
                <p role="status" style={{ color: '#868e96', textAlign: 'center', padding: 16, margin: 0 }}>Loading permissions…</p>
              ) : permsError ? (
                <p role="alert" style={{ color: '#c92a2a', fontSize: '0.85rem', margin: 0 }}>{permsError}</p>
              ) : visiblePages.length === 0 ? (
                <p role="status" style={{ color: '#868e96', textAlign: 'center', padding: 16, margin: 0 }}>
                  {q ? 'No permissions match that filter.' : 'No grantable permissions found.'}
                </p>
              ) : (
                <div style={{ border: '1px solid #e9ecef', borderRadius: 8, overflow: 'hidden' }}>
                  {visiblePages.map(([page, perms]) => {
                    const pagePerms = q
                      ? perms.filter(p => page.toLowerCase().includes(q) || p.feature.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
                      : perms;
                    const onCount = perms.filter(p => selected[p.permission_id]).length;
                    const allOn = onCount === perms.length;
                    const open = q ? true : !!expandedPages[page];
                    const listId = `${uid}-page-${page.replace(/\W+/g, '-')}`;
                    return (
                      <div key={page} style={{ borderBottom: '1px solid #f1f3f5' }}>
                        <div style={{ display: 'flex', alignItems: 'center', background: '#f8f9fa' }}>
                          <button
                            type="button"
                            onClick={() => togglePage(page)}
                            aria-expanded={open}
                            aria-controls={listId}
                            disabled={saving}
                            style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: '#1a1a2e' }}
                          >
                            <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.1rem', color: '#868e96', transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none' }}>chevron_right</span>
                            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{page}</span>
                            <span style={{ fontSize: '0.75rem', color: onCount ? '#7c3aed' : '#868e96', fontWeight: onCount ? 600 : 400 }}>
                              {onCount} of {perms.length} granted
                            </span>
                          </button>
                          <button
                            type="button"
                            className="dash-btn-sm"
                            onClick={() => setPage(page, !allOn)}
                            aria-label={allOn ? `Remove all ${page} permissions` : `Grant all ${page} permissions`}
                            disabled={saving}
                            style={{ margin: '0 8px', minWidth: 44 }}
                          >
                            {allOn ? 'None' : 'All'}
                          </button>
                        </div>
                        {open && (
                          <div id={listId}>
                            {pagePerms.map(p => {
                              const checked = !!selected[p.permission_id];
                              const wasGranted = originalIds.includes(p.permission_id);
                              const cbId = `${uid}-perm-${p.permission_id}`;
                              return (
                                <label
                                  key={p.permission_id}
                                  htmlFor={cbId}
                                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px 6px 20px', minHeight: 44, cursor: saving ? 'default' : 'pointer', background: checked ? '#f3e8ff' : 'white', borderTop: '1px solid #f1f3f5', transition: 'background 0.15s' }}
                                >
                                  <input
                                    id={cbId}
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => togglePerm(p)}
                                    disabled={saving}
                                    style={{ width: 20, height: 20, accentColor: '#7c3aed', cursor: saving ? 'default' : 'pointer', flexShrink: 0 }}
                                  />
                                  <span style={{ flex: 1 }}>
                                    <span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 500, color: '#1a1a2e' }}>
                                      {titleCase(p.feature)}
                                      {wasGranted !== checked && (
                                        <span style={{ marginLeft: 8, fontSize: '0.68rem', fontWeight: 700, color: checked ? '#2b8a3e' : '#c92a2a' }}>
                                          {checked ? 'ADDING' : 'REMOVING'}
                                        </span>
                                      )}
                                    </span>
                                    {p.description && <span style={{ display: 'block', fontSize: '0.7rem', color: '#868e96' }}>{p.description}</span>}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <p id={permErrId} role="alert" aria-live="polite" style={{ fontSize: '0.78rem', color: '#c92a2a', margin: '6px 0 0', minHeight: permCountError ? undefined : 0 }}>
                {permCountError}
              </p>
              <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#495057' }}>
                <strong>{selectedCount}</strong> permission{selectedCount !== 1 ? 's' : ''} will be granted
              </p>
            </>
          )}

          {/* ── Change summary + error ── */}
          <p id={summaryId} role="status" aria-live="polite" style={{ margin: '14px 0 0', padding: '8px 12px', borderRadius: 8, background: hasChanges ? '#e7f5ff' : '#f8f9fa', color: hasChanges ? '#1971c2' : '#868e96', fontSize: '0.8rem' }}>
            {summaryText}
          </p>
          {error && (
            <p id={errId} role="alert" style={{ margin: '10px 0 0', fontSize: '0.85rem', color: '#c92a2a' }}>{error}</p>
          )}
        </div>

        <div className="dash-modal-footer">
          <button type="button" className="dash-btn-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="button"
            className="dash-btn-primary"
            onClick={save}
            disabled={!canSave}
            aria-describedby={summaryId}
            style={{ background: canSave ? accent : undefined }}
          >
            <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.95rem', verticalAlign: 'middle', marginRight: 4 }}>{saving ? 'hourglass_top' : 'save'}</span>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
