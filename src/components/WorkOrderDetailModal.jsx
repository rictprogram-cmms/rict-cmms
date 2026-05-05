/**
 * RICT CMMS — WorkOrderDetailModal
 *
 * The detail/edit modal for a single work order. Extracted from WorkOrdersPage
 * to keep that file manageable. This component is purely presentational —
 * all state, data loading, saving, and realtime subscriptions live in the parent.
 *
 * Accessibility: owns its own useDialogA11y instance (Escape closes, Tab is
 * trapped, focus returns to the trigger on close, role="dialog" + aria-modal).
 *
 * File: src/components/WorkOrderDetailModal.jsx
 */

import React from 'react';
import { supabase } from '@/lib/supabase';
import { useDialogA11y } from '@/hooks/useDialogA11y';
import StatusSelect from '@/components/StatusSelect';

export default function WorkOrderDetailModal({
  // The work order being viewed
  wo,

  // Close
  onClose,

  // Edit field state (lifted to parent so saves use the same source of truth)
  description, setDescription,
  priority, setPriority,
  assetId, setAssetId,
  dueDate, setDueDate,
  status, setStatus,

  // Assignees
  assignees,
  assigneeSaving,
  addAssigneeEmail, setAddAssigneeEmail,
  onAddAssignee,
  onRemoveAssignee,
  onPromoteAssignee,

  // Child data (loaded by the parent when the modal opens)
  workLogs,
  partsUsed,
  woDocs,
  linkedPOs,
  pmProcedureUrl,
  pmProcedureName,
  linkedSops = [],

  // Lookups
  assets,
  users,
  openStatuses,
  statusColorMap,
  profile,
  user,

  // Action callbacks
  onSave,
  onReopen,
  onDelete,
  onCloseWO,
  onOpenWorkLogModal,
  onOpenPartsModal,
  onUploadDoc,
  onOpenGeneratePO,
  onDeleteWorkLog,
  onDeleteDoc,

  // Permissions
  hasPerm,

  // Helpers (passed in rather than re-imported to keep the module pure)
  getStatusStyle,
  formatDate,
  formatDateTime,
  formatHoursToTime,
}) {
  // The parent only mounts this component when the modal should be open,
  // so we always pass `true` for isOpen — the hook tears down on unmount.
  const dialogRef = useDialogA11y(true, onClose);

  if (!wo) return null;

  const isInstructor = profile?.role === 'Instructor' || profile?.role === 'Super Admin';
  const myEmail = user?.email?.toLowerCase() || '';
  const alreadyAssigned = assignees.some(a => a.email.toLowerCase() === myEmail);

  // Late WOs (overdue) are off-limits for student/work-study self-assign — late
  // assignments must go through an instructor. Instructors are unaffected.
  // `wo.isLate` is computed by the parent during loadWorkOrders.
  const blockedByLate = !isInstructor && wo.isLate === true;

  // What options can this user add?
  // Instructor: anyone not already assigned
  // Student/Work Study: only themselves (if not already on AND WO isn't overdue)
  const addableOptions = isInstructor
    ? users.filter(u => !assignees.find(a => a.email === u.email))
    : (!alreadyAssigned && !blockedByLate ? [{ email: myEmail, name: `${profile?.first_name} ${profile?.last_name}` }] : []);

  const canManage = !wo.isClosed && (isInstructor || hasPerm('assign_wo') || (!alreadyAssigned && !blockedByLate));

  return (
    <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="modal modal-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wo-view-modal-title"
      >
        <div className="modal-header">
          <h3>
            {!wo.isClosed && hasPerm('close_wo') && (
              <button className="btn btn-danger btn-sm" style={{ marginRight: 12 }} onClick={onCloseWO}>
                <span className="material-icons" style={{ fontSize: '1rem' }} aria-hidden="true">check_circle</span>Close WO
              </button>
            )}
            {/* aria-labelledby points to this span so the dialog name is just the WO id, not the action button text */}
            <span id="wo-view-modal-title">Work Order: {wo.wo_id}</span>
            {wo.is_pm === 'Yes' && (
              <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 12, fontSize: '0.7rem', fontWeight: 600, background: '#e7f5ff', color: '#1864ab', verticalAlign: 'middle' }}>PM</span>
            )}
          </h3>
          <button className="modal-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {/* Header */}
          <div className="wo-detail-header">
            <div className="wo-detail-title">
              {!wo.isClosed && hasPerm('edit_wo') ? (
                <textarea className="form-input" value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ fontSize: '1.2rem', fontWeight: 600, resize: 'vertical' }} />
              ) : (
                <h2>{wo.description}</h2>
              )}
              <div className="wo-detail-badges">
                {!wo.isClosed && hasPerm('edit_priority') ? (
                  <select className="form-input form-input-sm" value={priority} onChange={e => setPriority(e.target.value)} style={{ maxWidth: 120, fontWeight: 600 }}>
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                  </select>
                ) : (
                  <span className={`priority-badge ${wo.priority?.toLowerCase()}`}>{wo.priority}</span>
                )}
                <span className="status-badge" style={getStatusStyle(wo.status, wo.isClosed)}>{wo.status}</span>
              </div>
            </div>
          </div>

          {/* Detail Grid */}
          <div className="detail-grid">
            {/* Asset */}
            <div className="detail-item">
              <label>Asset</label>
              {!wo.isClosed && hasPerm('edit_wo') && profile?.role !== 'Student' ? (
                <select className="form-input form-input-sm" value={assetId} onChange={e => setAssetId(e.target.value)} style={{ maxWidth: 200 }}>
                  <option value="">None</option>
                  {assets.map(a => <option key={a.asset_id} value={a.asset_id} data-name={a.name}>{a.name} ({a.asset_id})</option>)}
                </select>
              ) : <span>{wo.asset_name || 'None'}</span>}
            </div>

            {/* Assigned To — derived from assignees[0] to stay in sync without DB race */}
            <div className="detail-item">
              <label>Primary Assignee</label>
              <span>{assignees[0]?.name || 'Unassigned'}</span>
            </div>

            {/* Due Date */}
            <div className="detail-item">
              <label id="detail-due-date-label">Due Date</label>
              {!wo.isClosed && hasPerm('edit_due_date') ? (
                <input type="date" className="form-input form-input-sm" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{ maxWidth: 150 }} aria-labelledby="detail-due-date-label" />
              ) : <span>{formatDate(wo.due_date)}</span>}
            </div>

            {/* Closed Date — only shown for closed work orders */}
            {wo.isClosed && wo.closed_date && (
              <div className="detail-item">
                <label>Closed Date</label>
                <span>{formatDate(wo.closed_date)}</span>
              </div>
            )}

            {/* Total Time */}
            <div className="detail-item">
              <label>Total Time</label>
              <span>{formatHoursToTime(wo.total_hours || 0)}</span>
            </div>

            {/* Created */}
            <div className="detail-item">
              <label>Created</label>
              <span>{formatDate(wo.created_at)} by {wo.created_by || '-'}</span>
            </div>

            {/* Status */}
            <div className="detail-item">
              <label>Status</label>
              {!wo.isClosed && hasPerm('edit_status') ? (
                <StatusSelect
                  statuses={openStatuses}
                  value={status}
                  onChange={setStatus}
                  id="view-wo-status"
                  style={{ maxWidth: 200 }}
                  colorMap={statusColorMap}
                />
              ) : <span>{wo.status || '-'}</span>}
            </div>
          </div>

          {/* Assignees Section */}
          <div className="detail-section">
            <h4>
              <span className="material-icons" aria-hidden="true">group</span>
              Assignees
              {assignees.length > 0 && (
                <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 400, color: '#868e96' }}>
                  {assignees.length} assigned
                </span>
              )}
            </h4>

            {/* Assignee chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: assignees.length > 0 ? 12 : 0 }}>
              {assignees.length === 0 && (
                <span style={{ fontSize: '0.85rem', color: '#868e96' }}>No one assigned yet</span>
              )}
              {assignees.map((a, idx) => {
                const isPrimary = idx === 0; // first in assigned_at order = primary
                // Instructor-only removal. Students/Work Study cannot remove themselves
                // or anyone else — this prevents bailing on late or undesirable WOs.
                // The parent's removeAssignee() also enforces this server-side.
                const canRemove = !wo.isClosed && isInstructor;
                return (
                  <span key={a.email} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 20,
                    background: isPrimary ? '#e7f5ff' : '#f1f3f5',
                    color: isPrimary ? '#1864ab' : '#495057',
                    border: `1px solid ${isPrimary ? '#a5d8ff' : '#dee2e6'}`,
                    fontSize: '0.82rem', fontWeight: isPrimary ? 600 : 400
                  }}>
                    <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.95rem' }}>person</span>
                    {a.name || a.email}
                    {isPrimary && (
                      <span style={{ fontSize: '0.68rem', color: '#1971c2', marginLeft: 2 }} title="Lead assignee">★</span>
                    )}
                    {!isPrimary && !wo.isClosed && isInstructor && !assigneeSaving && (
                      <button
                        onClick={() => onPromoteAssignee(a.email)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', color: '#adb5bd', display: 'flex', alignItems: 'center', lineHeight: 1, fontSize: '0.68rem' }}
                        title={`Make ${a.name || a.email} the lead`}
                        aria-label={`Make ${a.name || a.email} the lead assignee`}
                      >★</button>
                    )}
                    {canRemove && !assigneeSaving && (
                      <button
                        onClick={() => onRemoveAssignee(a.email)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', color: '#868e96', display: 'flex', alignItems: 'center', lineHeight: 1 }}
                        title={`Remove ${a.name}`}
                        aria-label={`Remove ${a.name || a.email} from work order`}
                      >
                        <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.9rem' }}>close</span>
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
                        if (u) onAddAssignee(u.email, `${u.first_name} ${u.last_name}`);
                      }}
                      style={{ maxWidth: 220 }}
                      disabled={assigneeSaving}
                      aria-label="Add assignee"
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
                    onClick={() => onAddAssignee(myEmail, `${profile?.first_name} ${profile?.last_name}`)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.9rem' }}>person_add</span>
                    {assigneeSaving ? 'Adding…' : 'Add Myself'}
                  </button>
                )}
              </div>
            )}

            {/* Hints for non-instructors. role="note" gives screen readers context that
                this is supplementary information about the assignment area above. */}
            {!wo.isClosed && !isInstructor && alreadyAssigned && (
              <p
                role="note"
                style={{ fontSize: '0.78rem', color: '#868e96', margin: '4px 0 0' }}
              >
                <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>info</span>
                You're assigned to this work order. Only an instructor can remove you.
              </p>
            )}
            {!wo.isClosed && !isInstructor && !alreadyAssigned && blockedByLate && (
              <p
                role="note"
                style={{ fontSize: '0.78rem', color: '#a52121', margin: '4px 0 0' }}
              >
                <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>warning</span>
                This work order is overdue. Only an instructor can assign people to it.
              </p>
            )}
          </div>

          {/* PM Procedure Section (only for PM work orders with a procedure) */}
          {wo.is_pm === 'Yes' && wo.pm_id && pmProcedureUrl && (
            <div className="detail-section">
              <h4><span className="material-icons" aria-hidden="true">assignment</span>PM Procedure</h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: '#ebfaff', border: '1px solid #a5d8ff', borderRadius: 8 }}>
                <span className="material-icons" aria-hidden="true" style={{ color: '#228be6', fontSize: '1.3rem' }}>description</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1864ab' }}>Procedure Document</div>
                  <div style={{ fontSize: '0.75rem', color: '#495057' }}>{pmProcedureName}</div>
                </div>
                <a href={pmProcedureUrl} target="_blank" rel="noopener noreferrer"
                  className="doc-link" style={{ background: '#228be6', color: '#fff', fontWeight: 600 }}>
                  <span className="material-icons" aria-hidden="true">open_in_new</span>View Procedure
                </a>
              </div>
              <div style={{ fontSize: '0.72rem', color: '#868e96', marginTop: 6 }}>
                Linked from PM schedule: {wo.pm_id}
              </div>
            </div>
          )}

          {/* PM badge info for PM WOs without a procedure */}
          {wo.is_pm === 'Yes' && wo.pm_id && !pmProcedureUrl && (
            <div className="detail-section">
              <h4><span className="material-icons" aria-hidden="true">assignment</span>PM Information</h4>
              <div style={{ padding: '10px 14px', background: '#f8f9fa', borderRadius: 8, border: '1px solid #e9ecef', fontSize: '0.85rem', color: '#495057' }}>
                This work order was generated from PM schedule <strong>{wo.pm_id}</strong>. No procedure document is attached.
              </div>
            </div>
          )}

          {/* Linked SOPs Section — covers SOPs linked directly to this WO and SOPs
              inherited from the PM at WO-generation time. Each SOP card shows
              the SOP id, name, description preview, and a "View Document" link
              that opens the PDF in a new tab. */}
          {linkedSops.length > 0 && (
            <div className="detail-section">
              <h4>
                <span className="material-icons" aria-hidden="true">menu_book</span>
                Standard Operating Procedures
                <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 400, color: '#868e96' }}>
                  {linkedSops.length} linked
                </span>
              </h4>
              <ul
                style={{ display: 'flex', flexDirection: 'column', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}
                aria-label={`${linkedSops.length} linked Standard Operating Procedure${linkedSops.length === 1 ? '' : 's'}`}
              >
                {linkedSops.map(sop => {
                  const hasDoc = !!sop.document_url;
                  const docName = sop.document_name || `${sop.sop_id}.pdf`;
                  // High-contrast palette matching the existing PM Procedure card (WCAG AA verified).
                  return (
                    <li
                      key={sop.sop_id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '12px 16px',
                        background: '#fff8e1',
                        border: '1px solid #ffd166',
                        borderRadius: 8,
                      }}
                    >
                      <span
                        className="material-icons"
                        aria-hidden="true"
                        style={{ color: '#b07c00', fontSize: '1.3rem', marginTop: 2 }}
                      >
                        menu_book
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#7a4f00' }}>
                          {sop.name}
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: '0.7rem',
                              fontWeight: 500,
                              color: '#7a4f00',
                              background: '#ffe9a8',
                              padding: '1px 8px',
                              borderRadius: 10,
                            }}
                          >
                            {sop.sop_id}
                          </span>
                        </div>
                        {sop.description && (
                          <div
                            style={{
                              fontSize: '0.78rem',
                              color: '#5b4500',
                              marginTop: 4,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                            }}
                          >
                            {sop.description}
                          </div>
                        )}
                        {!hasDoc && (
                          <div style={{ fontSize: '0.72rem', color: '#868e96', marginTop: 4, fontStyle: 'italic' }}>
                            No document attached to this SOP yet.
                          </div>
                        )}
                      </div>
                      {hasDoc && (
                        <a
                          href={sop.document_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="doc-link"
                          style={{ background: '#b07c00', color: '#fff', fontWeight: 600, flexShrink: 0 }}
                          aria-label={`View SOP document: ${sop.name} (${docName}), opens in new tab`}
                        >
                          <span className="material-icons" aria-hidden="true">open_in_new</span>
                          View Document
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
              {wo.is_pm === 'Yes' && wo.pm_id && (
                <div style={{ fontSize: '0.72rem', color: '#868e96', marginTop: 8 }}>
                  Some SOPs may have been carried forward from PM schedule <strong>{wo.pm_id}</strong>.
                </div>
              )}
            </div>
          )}

          {/* Work Logs */}
          <div className="detail-section">
            <h4><span className="material-icons" aria-hidden="true">schedule</span>Work Logs</h4>
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
                        <button className="btn-delete-log" onClick={() => onDeleteWorkLog(log.log_id)} aria-label="Delete work log">
                          <span className="material-icons" aria-hidden="true">delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state"><span className="material-icons" aria-hidden="true">schedule</span><p>No work logs yet</p></div>
            )}
          </div>

          {/* Parts Used */}
          <div className="detail-section">
            <h4><span className="material-icons" aria-hidden="true">inventory_2</span>Parts Used</h4>
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
              <div className="empty-state"><span className="material-icons" aria-hidden="true">inventory_2</span><p>No parts used</p></div>
            )}
          </div>

          {/* Documents */}
          <div className="detail-section">
            <h4><span className="material-icons" aria-hidden="true">attach_file</span>Documents</h4>
            {woDocs.length > 0 ? (
              <div className="docs-list">
                {woDocs.map(doc => {
                  const url = doc.file_path ? supabase.storage.from('work-order-documents').getPublicUrl(doc.file_path).data?.publicUrl : '';
                  return (
                    <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <a href={url} target="_blank" rel="noopener noreferrer" className="doc-link" style={{ flex: 1 }}>
                        <span className="material-icons" aria-hidden="true">description</span>{doc.file_name || 'Document'}
                      </a>
                      {hasPerm('delete_documents') && (
                        <button className="btn-delete-log" onClick={() => onDeleteDoc(doc)} title="Delete document" aria-label={`Delete ${doc.file_name || 'document'}`}>
                          <span className="material-icons" aria-hidden="true">delete</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state"><span className="material-icons" aria-hidden="true">attach_file</span><p>No documents attached</p></div>
            )}
          </div>

          {/* Linked Purchase Orders */}
          <div className="detail-section">
            <h4><span className="material-icons" aria-hidden="true">local_shipping</span>Purchase Orders</h4>
            {linkedPOs.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {linkedPOs.map(po => (
                  <div key={po.order_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#f8f9fa', borderRadius: 8, border: '1px solid #e9ecef' }}>
                    <span className="material-icons" aria-hidden="true" style={{ color: po.status === 'Received' ? '#40c057' : po.status === 'Ordered' ? '#228be6' : po.status === 'Rejected' ? '#fa5252' : '#fab005', fontSize: '1.2rem' }}>
                      {po.status === 'Received' ? 'check_circle' : po.status === 'Ordered' ? 'local_shipping' : po.status === 'Rejected' ? 'cancel' : 'hourglass_empty'}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1a1a2e' }}>{po.order_id}</div>
                      <div style={{ fontSize: '0.78rem', color: '#868e96' }}>{po.vendor_name || po.other_vendor || 'Unknown'} — ${parseFloat(po.total || 0).toFixed(2)}</div>
                    </div>
                    <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600,
                      background: po.status === 'Received' ? '#d3f9d8' : po.status === 'Ordered' ? '#d0ebff' : po.status === 'Approved' ? '#d0ebff' : po.status === 'Rejected' ? '#ffe3e3' : po.status === 'Cancelled' ? '#f1f3f5' : '#fff3bf',
                      color: po.status === 'Received' ? '#1f6b30' : po.status === 'Ordered' ? '#1864ab' : po.status === 'Approved' ? '#1864ab' : po.status === 'Rejected' ? '#a52121' : po.status === 'Cancelled' ? '#495057' : '#8a4900'
                    }}>
                      {po.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state"><span className="material-icons" aria-hidden="true">local_shipping</span><p>No purchase orders linked</p></div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="modal-footer" style={{ flexDirection: 'column', gap: 0, padding: 0 }}>
          {!wo.isClosed && (
            <>
              {/* Action Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 20px', borderTop: '1px solid #e9ecef', background: '#f8f9fa', flexWrap: 'wrap' }}>
                {hasPerm('add_work_log') && (
                  <button onClick={onOpenWorkLogModal} className="wo-action-btn">
                    <span className="material-icons" aria-hidden="true">schedule</span>Work Log
                  </button>
                )}
                {hasPerm('add_parts') && (
                  <button onClick={onOpenPartsModal} className="wo-action-btn">
                    <span className="material-icons" aria-hidden="true">inventory_2</span>Parts
                  </button>
                )}
                {hasPerm('upload_wo_doc') && (
                  <button onClick={onUploadDoc} className="wo-action-btn">
                    <span className="material-icons" aria-hidden="true">upload_file</span>Upload
                  </button>
                )}
                {hasPerm('add_parts') && (
                  <button onClick={onOpenGeneratePO} className="wo-action-btn">
                    <span className="material-icons" aria-hidden="true">local_shipping</span>Generate PO
                  </button>
                )}
                <div style={{ flex: 1 }} />
                {hasPerm('delete_wo') && (
                  <button className="wo-action-btn wo-action-btn-delete" onClick={() => onDelete(wo.wo_id)} aria-label="Delete work order">
                    <span className="material-icons" aria-hidden="true">delete_forever</span>
                  </button>
                )}
              </div>
              {/* Save Bar */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 20px', borderTop: '1px solid #e9ecef' }}>
                <button className="btn btn-primary" onClick={onSave} style={{ minWidth: 160 }}>
                  <span className="material-icons" aria-hidden="true" style={{ fontSize: '1rem' }}>save</span>Save Changes
                </button>
              </div>
            </>
          )}
          {wo.isClosed && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '16px 20px', borderTop: '1px solid #e9ecef' }}>
              <button className="btn btn-secondary" onClick={onClose}>Close</button>
              {hasPerm('edit_wo') && (
                <button className="btn btn-primary" onClick={onReopen}><span className="material-icons" aria-hidden="true">refresh</span>Reopen WO</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
