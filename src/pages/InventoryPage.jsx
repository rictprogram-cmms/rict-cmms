/**
 * RICT CMMS - Inventory Page (React)
 * Faithfully reproduces the old Google Apps Script Inventory page.
 *
 * Features:
 * - Data table with checkbox selection, image thumbnails, qty color-coding
 * - Search + location/stock-level filters + show-inactive toggle
 * - Low stock warning banner with Purchase Orders link
 * - Cycle Count button (navigates to /inventory/scan for QR-based qty adjustments)
 * - Add/Edit Part modal (name, status, description, supplier, part#, qty/min/max, location, image upload)
 * - View Part Detail modal (image, detail grid, edit/delete buttons)
 * - Adjust Quantity modal (new qty, clear order date checkbox)
 * - Print Labels modal (QR codes for Zebra ZT230 2"x1")
 * - Full permission gating via hasPerm()
 *
 * Supabase tables: inventory, inventory_locations, vendors, inventory_suppliers
 * Storage buckets: inventory-images
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';

export default function InventoryPage() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  // ---------- STATE ----------
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sortColumn, setSortColumn] = useState('');
  const [sortDirection, setSortDirection] = useState('asc');
  const [selectedIds, setSelectedIds] = useState([]);

  // Dropdowns
  const [locations, setLocations] = useState([]);
  const [vendors, setVendors] = useState([]);

  // Modals
  const [showPartModal, setShowPartModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showLabelsModal, setShowLabelsModal] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  // Current editing
  const [currentItem, setCurrentItem] = useState(null);
  const [formData, setFormData] = useState({});
  const [adjustData, setAdjustData] = useState({ partId: '', partName: '', currentQty: 0, newQty: 0, clearOrder: false });
  const [selectedImage, setSelectedImage] = useState(null); // { file, preview } or { existingUrl }
  const [labelsData, setLabelsData] = useState([]);

  // Toast
  const [toast, setToast] = useState(null);

  // Track whether initial data load has completed — prevents loading spinner on tab switch
  const hasLoadedRef = useRef(false);

  // ---------- HELPERS ----------
  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Inventory permissions (add_items, edit_items, delete_items, adjust_quantity, print_labels, etc.)
  const { hasPerm } = usePermissions('Inventory');
  // view_low_stock permission now lives on the Inventory page (moved via SQL)

  const getImageUrl = (fileId) => {
    if (!fileId) return '';
    if (fileId.startsWith('http')) return fileId;
    if (fileId.includes('/')) {
      const { data } = supabase.storage.from('inventory-images').getPublicUrl(fileId);
      return data?.publicUrl || '';
    }
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w200`;
  };

  const userName = () => profile ? `${profile.first_name} ${profile.last_name?.charAt(0)}.` : '';

  const highlightMatch = (text) => {
    if (!search || !text) return text || '';
    const str = String(text);
    const idx = str.toLowerCase().indexOf(search.toLowerCase());
    if (idx === -1) return str;
    return (
      <>{str.substring(0, idx)}<mark style={{ background: '#fff3bf', padding: '0 1px', borderRadius: 2 }}>{str.substring(idx, idx + search.length)}</mark>{str.substring(idx + search.length)}</>
    );
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

  // ---------- LOAD DATA ----------
  useEffect(() => {
    if (!user) return;
    loadDropdowns();
    loadInventory();
  }, [user?.id, profile?.role]);

  // Silent refresh when browser tab regains focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        loadInventory(); // silent — hasLoadedRef is true so no spinner
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Realtime subscription — updates from Cycle Count page, other users, etc.
  useEffect(() => {
    const channel = supabase
      .channel('inventory-page-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => {
        if (hasLoadedRef.current) {
          loadInventory(); // silent refresh — no spinner
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const loadDropdowns = async () => {
    try {
      const { data } = await supabase.from('inventory_locations').select('*').eq('status', 'Active').order('location_name');
      if (data) setLocations(data);
    } catch (e) { console.error(e); }

    try {
      const { data } = await supabase.from('vendors').select('vendor_id, vendor_name, status').eq('status', 'Active').order('vendor_name');
      if (data) setVendors(data);
    } catch (e) { console.error(e); }
  };

  const loadInventory = async () => {
    // Only show loading spinner on initial load — background refreshes update silently
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const { data, error } = await supabase.from('inventory').select('*').order('part_name');
      if (error) throw error;
      const mapped = (data || []).map(item => ({
        ...item,
        isLowStock: (item.qty_in_stock || 0) <= (item.min_qty || 0),
        qtyNeeded: Math.max(0, (item.max_qty || 0) - (item.qty_in_stock || 0))
      }));
      setItems(mapped);
      hasLoadedRef.current = true;
    } catch (e) {
      if (!hasLoadedRef.current) showToast('Error loading inventory: ' + e.message, 'error');
    }
    setLoading(false);
  };

  // ---------- FILTER ----------
  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const matchSearch = !search ||
        item.part_name?.toLowerCase().includes(search.toLowerCase()) ||
        item.part_id?.toLowerCase().includes(search.toLowerCase()) ||
        item.description?.toLowerCase().includes(search.toLowerCase()) ||
        item.primary_supplier?.toLowerCase().includes(search.toLowerCase()) ||
        item.supplier_part_number?.toLowerCase().includes(search.toLowerCase()) ||
        item.location?.toLowerCase().includes(search.toLowerCase());
      const matchLoc = !locationFilter || item.location === locationFilter;
      const matchStock = !stockFilter ||
        (stockFilter === 'low' && item.isLowStock) ||
        (stockFilter === 'ok' && !item.isLowStock);
      const matchStatus = showInactive || item.status === 'Active';
      return matchSearch && matchLoc && matchStock && matchStatus;
    });
  }, [items, search, locationFilter, stockFilter, showInactive]);

  const lowStockCount = useMemo(() => {
    return items.filter(i => i.isLowStock && i.status === 'Active' && !i.order_date).length;
  }, [items]);

  const sortedItems = useMemo(() => {
    if (!sortColumn) return filteredItems;
    return [...filteredItems].sort((a, b) => {
      const valA = (a[sortColumn] || '').toString().toLowerCase();
      const valB = (b[sortColumn] || '').toString().toLowerCase();
      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredItems, sortColumn, sortDirection]);

  const handleSort = (col) => {
    if (sortColumn === col) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  };

  // ---------- SELECTION ----------
  const toggleSelect = (partId, checked) => {
    setSelectedIds(prev => checked ? [...prev, partId] : prev.filter(id => id !== partId));
  };

  const toggleSelectAll = (checked) => {
    setSelectedIds(checked ? filteredItems.map(i => i.part_id) : []);
  };

  const isAllSelected = filteredItems.length > 0 && selectedIds.length === filteredItems.length;

  // ---------- ACTIONS ----------
  const openAddModal = () => {
    setFormData({ part_name: '', status: 'Active', description: '', primary_supplier: '', supplier_part_number: '', qty_in_stock: 0, min_qty: 0, max_qty: 0, location: '' });
    setSelectedImage(null);
    setShowPartModal(true);
  };

  const openEditModal = (item) => {
    setFormData({ ...item });
    if (item.image_url) {
      setSelectedImage({ existingUrl: getImageUrl(item.image_url), fileId: item.image_url });
    } else {
      setSelectedImage(null);
    }
    setShowPartModal(true);
  };

  const openViewModal = (item) => {
    setCurrentItem(item);
    setShowViewModal(true);
  };

  const openAdjustModal = (item) => {
    setAdjustData({ partId: item.part_id, partName: item.part_name, currentQty: item.qty_in_stock || 0, newQty: item.qty_in_stock || 0, clearOrder: false });
    setShowAdjustModal(true);
  };

  const savePart = async () => {
    if (!formData.part_name?.trim()) { showToast('Part name is required', 'error'); return; }
    setLoading(true);
    try {
      let imageFileId = formData.image_url || '';

      // Upload image if new file selected
      if (selectedImage?.file) {
        const path = `parts/${Date.now()}_${selectedImage.file.name}`;
        const { error: upErr } = await supabase.storage.from('inventory-images').upload(path, selectedImage.file);
        if (upErr) throw upErr;
        imageFileId = path;
      } else if (selectedImage?.fileId) {
        imageFileId = selectedImage.fileId;
      } else if (!selectedImage) {
        imageFileId = '';
      }

      const record = {
        part_name: formData.part_name,
        description: formData.description || '',
        primary_supplier: formData.primary_supplier || '',
        supplier_part_number: formData.supplier_part_number || '',
        qty_in_stock: parseFloat(formData.qty_in_stock) || 0,
        min_qty: parseFloat(formData.min_qty) || 0,
        max_qty: parseFloat(formData.max_qty) || 0,
        location: formData.location || '',
        image_url: imageFileId,
        status: formData.status || 'Active',
        updated_at: new Date().toISOString(),
        updated_by: userName()
      };

      if (formData.part_id) {
        // Update
        const { data: rows, error } = await supabase.from('inventory').update(record).eq('part_id', formData.part_id).select();
        if (error) throw error;
        if (!rows || rows.length === 0) {
          showToast('Save failed — you may not have permission to edit inventory items.', 'error');
          setLoading(false);
          return;
        }
        showToast('Part updated!', 'success');
      } else {
        // Create
        const { data: idData } = await supabase.rpc('get_next_id', { p_type: 'inventory' });
        const partId = idData || `INV${Date.now()}`;
        record.part_id = partId;
        const { data: rows, error } = await supabase.from('inventory').insert([record]).select();
        if (error) throw error;
        if (!rows || rows.length === 0) {
          showToast('Create failed — you may not have permission to add inventory items.', 'error');
          setLoading(false);
          return;
        }
        showToast('Part created!', 'success');
      }
      setShowPartModal(false);
      loadInventory();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setLoading(false);
  };

  const deletePart = (partId) => {
    const part = items.find(i => i.part_id === partId);
    if (!part) return;
    setConfirmModal({
      title: 'Delete Part',
      message: `Delete "${part.part_name}"? This cannot be undone.`,
      onConfirm: async () => {
        try {
          setLoading(true);
          const { data: delRows, error: delErr } = await supabase.from('inventory').delete().eq('part_id', partId).select();
          if (delErr) throw delErr;
          if (!delRows || delRows.length === 0) {
            showToast('Delete failed — you may not have permission to delete inventory items.', 'error');
            setLoading(false);
            return;
          }
          showToast('Part deleted', 'info');
          setShowViewModal(false);
          loadInventory();
        } catch (e) { showToast('Error: ' + e.message, 'error'); }
        setLoading(false);
      }
    });
  };

  const saveQtyAdjust = async () => {
    try {
      setLoading(true);
      const updates = {
        qty_in_stock: parseFloat(adjustData.newQty) || 0,
        updated_at: new Date().toISOString(),
        updated_by: userName()
      };
      if (adjustData.clearOrder) {
        updates.order_date = null;
      }
      const { data: rows, error } = await supabase.from('inventory').update(updates).eq('part_id', adjustData.partId).select();
      if (error) throw error;
      if (!rows || rows.length === 0) {
        showToast('Adjust failed — you may not have permission to adjust inventory quantities.', 'error');
        setLoading(false);
        return;
      }
      showToast('Quantity updated!', 'success');
      setShowAdjustModal(false);
      loadInventory();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setLoading(false);
  };

  // ---------- IMAGE HANDLING ----------
  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please select an image', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => setSelectedImage({ file, preview: ev.target.result });
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setSelectedImage(null);
  };

  // ---------- LABELS ----------
  const openLabelsPreview = () => {
    if (selectedIds.length === 0) { showToast('No parts selected', 'error'); return; }
    const selected = items.filter(i => selectedIds.includes(i.part_id));
    setLabelsData(selected);
    setShowLabelsModal(true);
  };

  const doPrintLabels = () => {
    const origin = window.location.origin;
    let labelsHtml = '';
    labelsData.forEach(part => {
      const imgUrl = part.image_url ? getImageUrl(part.image_url) : '';
      const scanUrl = `${origin}/inventory/scan?partId=${encodeURIComponent(part.part_id)}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(scanUrl)}`;
      labelsHtml += `<div class="label-preview">` +
        `<div class="label-img">${imgUrl ? `<img src="${imgUrl}" referrerpolicy="no-referrer">` : '<span class="material-icons">inventory_2</span>'}</div>` +
        `<div class="label-info"><div class="name">${part.part_name}</div><div>${part.location || '-'}</div><div>${part.supplier_part_number || '-'}</div></div>` +
        `<div class="label-qr"><img src="${qrUrl}" alt="QR"></div></div>`;
    });

    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Labels</title><link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
      <style>@page{size:2in 1in;margin:0}body{font-family:Arial;margin:0;padding:0}
      .label-preview{width:2in;height:1in;border:1px solid #ccc;padding:10px 10px 2px 4px;display:flex;gap:4px;font-size:8px;page-break-after:always;box-sizing:border-box}
      .label-img{width:0.45in;height:0.45in;background:#f0f0f0;overflow:hidden}.label-img img{width:100%;height:100%;object-fit:cover}
      .label-info{flex:1;overflow:hidden}.label-info .name{font-weight:bold}
      .label-qr{width:0.75in;height:0.75in;overflow:hidden}.label-qr img{width:100%;height:100%;object-fit:contain}
      </style></head><body>${labelsHtml}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
    setShowLabelsModal(false);
  };

  /* ── Print Inventory List ──────────────────────────────────────── */
  const printInventoryList = () => {
    const listData = sortedItems;
    if (listData.length === 0) { showToast('No items to print — adjust your filters.', 'error'); return; }

    const rows = listData.map(item => {
      const qtyClass = item.isLowStock ? 'color:#c92a2a;font-weight:bold' : '';
      return `<tr>
        <td>${item.part_id}</td>
        <td>${item.part_name}</td>
        <td>${item.supplier_part_number || '—'}</td>
        <td style="${qtyClass}">${item.qty_in_stock ?? 0}</td>
        <td>${item.min_qty ?? 0} / ${item.max_qty ?? 0}</td>
        <td>${item.location || '—'}</td>
        <td>${item.primary_supplier || '—'}</td>
        <td>${item.status}</td>
      </tr>`;
    }).join('');

    const filterNotes = [];
    if (search) filterNotes.push(`Search: "${search}"`);
    if (locationFilter) filterNotes.push(`Location: ${locationFilter}`);
    if (stockFilter) filterNotes.push(`Stock: ${stockFilter}`);
    if (showInactive) filterNotes.push('Including inactive');
    const filterLine = filterNotes.length > 0
      ? `<div style="font-size:11px;color:#666;margin-bottom:8px">Filters: ${filterNotes.join(' · ')}</div>`
      : '';

    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Inventory List</title><style>
      @page { size: landscape; margin: 0.5in; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin: 0; padding: 0; }
      h2 { margin: 0 0 4px; font-size: 16px; }
      .meta { font-size: 11px; color: #666; margin-bottom: 12px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
      th { background: #f0f0f0; font-size: 11px; text-transform: uppercase; }
      tr:nth-child(even) { background: #fafafa; }
    </style></head><body>
      <h2>RICT CMMS — Inventory List</h2>
      <div class="meta">Printed ${new Date().toLocaleDateString()} · ${listData.length} item${listData.length !== 1 ? 's' : ''}</div>
      ${filterLine}
      <table>
        <thead><tr><th>Part ID</th><th>Part Name</th><th>Supplier Part #</th><th>Qty</th><th>Min/Max</th><th>Location</th><th>Supplier</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
  };

  // ---------- RENDER ----------
  return (
    <div className="inv-page">
      {/* Toast */}
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      {/* Toolbar */}
      <div className="page-toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <span className="material-icons">search</span>
            <input type="text" placeholder="Search parts..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="filter-select" value={locationFilter} onChange={e => setLocationFilter(e.target.value)}>
            <option value="">All Locations</option>
            {locations.map(l => <option key={l.location_id} value={l.location_name}>{l.location_name}</option>)}
          </select>
          <select className="filter-select" value={stockFilter} onChange={e => setStockFilter(e.target.value)}>
            <option value="">All Stock Levels</option>
            {hasPerm('view_low_stock') && <option value="low">Low Stock</option>}
            <option value="ok">In Stock</option>
          </select>
          <label className="checkbox-filter">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            <span>Show Inactive</span>
          </label>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-sm btn-secondary" onClick={printInventoryList} title="Print a clean one-line-per-item list">
            <span className="material-icons">list_alt</span>Print List
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => navigate('/inventory/scan')}>
            <span className="material-icons">qr_code_scanner</span>Cycle Count
          </button>
          {hasPerm('view_low_stock') && (
            <button className="btn btn-sm btn-secondary" onClick={() => navigate('/purchase-orders', { state: { tab: 'lowstock' } })}>
              <span className="material-icons">shopping_cart</span>Purchase Orders
            </button>
          )}
          {hasPerm('add_items') && (
            <button className="btn btn-sm btn-primary" onClick={openAddModal}>
              <span className="material-icons">add</span>Add Part
            </button>
          )}
        </div>
      </div>

      {/* Low Stock Banner — only visible to users with view_low_stock permission */}
      {lowStockCount > 0 && hasPerm('view_low_stock') && (
        <div className="alert-banner">
          <span className="material-icons">warning</span>
          <strong>{lowStockCount}</strong> items low on stock
          <button className="btn btn-sm btn-primary" onClick={() => navigate('/purchase-orders', { state: { tab: 'lowstock' } })}>
            <span className="material-icons">shopping_cart</span>Purchase Orders
          </button>
        </div>
      )}

      {/* Inventory Table */}
      <div className="card">
        <div className="card-header">
          <div className="header-left">
            {hasPerm('print_labels') && (
              <label className="select-all-check">
                <input type="checkbox" checked={isAllSelected} onChange={e => toggleSelectAll(e.target.checked)} />
                <span>Select All</span>
              </label>
            )}
          </div>
          <div className="header-right">
            <span className="badge">{filteredItems.length}</span>
            {selectedIds.length > 0 && hasPerm('print_labels') && (
              <button className="btn btn-sm btn-secondary" onClick={openLabelsPreview}>
                <span className="material-icons">print</span>Print Labels ({selectedIds.length})
              </button>
            )}
          </div>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                {hasPerm('print_labels') && <th className="col-check"></th>}
                <th className="col-img">Image</th>
                <th className="sortable-th" onClick={() => handleSort('part_name')}>Part Name {sortColumn === 'part_name' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th className="sortable-th" onClick={() => handleSort('supplier_part_number')}>Supplier Part # {sortColumn === 'supplier_part_number' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th>Qty</th>
                <th>Min/Max</th>
                <th className="sortable-th" onClick={() => handleSort('location')}>Location {sortColumn === 'location' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th className="sortable-th" onClick={() => handleSort('primary_supplier')}>Supplier {sortColumn === 'primary_supplier' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={hasPerm('print_labels') ? 9 : 8} className="loading-cell">Loading inventory...</td></tr>
              ) : sortedItems.length === 0 ? (
                <tr><td colSpan={hasPerm('print_labels') ? 9 : 8} className="loading-cell">No inventory items found</td></tr>
              ) : sortedItems.map(item => {
                const imgUrl = item.image_url ? getImageUrl(item.image_url) : '';
                const qtyClass = item.isLowStock ? 'low' : 'ok';
                const rowClass = `${item.isLowStock ? 'low-stock ' : ''}${item.status === 'Inactive' ? 'inactive' : ''}`;
                return (
                  <tr key={item.part_id} className={rowClass}>
                    {hasPerm('print_labels') && (
                      <td className="col-check">
                        <input type="checkbox" checked={selectedIds.includes(item.part_id)} onChange={e => toggleSelect(item.part_id, e.target.checked)} />
                      </td>
                    )}
                    <td className="col-img">
                      <div className="part-thumb">
                        {imgUrl ? <img src={imgUrl} alt="" referrerPolicy="no-referrer" /> : <span className="material-icons">inventory_2</span>}
                      </div>
                    </td>
                    <td onClick={() => openViewModal(item)} style={{ cursor: 'pointer' }}>
                      <strong>{highlightMatch(item.part_name)}</strong><br /><small style={{ color: '#868e96' }}>{highlightMatch(item.part_id)}</small>
                    </td>
                    <td>{highlightMatch(item.supplier_part_number || '-')}</td>
                    <td><span className={`qty-badge ${qtyClass}`}>{item.qty_in_stock ?? 0}</span></td>
                    <td className="min-max">{item.min_qty ?? 0} / {item.max_qty ?? 0}</td>
                    <td>{highlightMatch(item.location || '-')}</td>
                    <td>{highlightMatch(item.primary_supplier || '-')}</td>
                    <td>
                      <button className="action-btn" onClick={() => openViewModal(item)} title="View"><span className="material-icons">visibility</span></button>
                      {hasPerm('adjust_quantity') && (
                        <button className="action-btn" onClick={() => openAdjustModal(item)} title="Adjust Qty"><span className="material-icons">tune</span></button>
                      )}
                      {hasPerm('edit_items') && (
                        <button className="action-btn" onClick={() => openEditModal(item)} title="Edit"><span className="material-icons">edit</span></button>
                      )}
                      {hasPerm('delete_items') && (
                        <button className="action-btn danger" onClick={() => deletePart(item.part_id)} title="Delete"><span className="material-icons">delete</span></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ========== MODALS ========== */}

      {/* Add/Edit Part Modal */}
      {showPartModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowPartModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3>{formData.part_id ? 'Edit Part' : 'Add New Part'}</h3>
              <button className="modal-close" onClick={() => setShowPartModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-row two-col">
                <div className="form-group">
                  <label className="form-label">Part Name *</label>
                  <input type="text" className="form-input" value={formData.part_name || ''} onChange={e => setFormData({ ...formData, part_name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Status</label>
                  <select className="form-input" value={formData.status || 'Active'} onChange={e => setFormData({ ...formData, status: e.target.value })}>
                    <option value="Active">Active</option><option value="Inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-input" rows="2" value={formData.description || ''} onChange={e => setFormData({ ...formData, description: e.target.value })} />
              </div>
              <div className="form-row two-col">
                <div className="form-group">
                  <label className="form-label">Primary Supplier</label>
                  <select className="form-input" value={formData.primary_supplier || ''} onChange={e => setFormData({ ...formData, primary_supplier: e.target.value })}>
                    <option value="">Select supplier</option>
                    {vendors.map(v => <option key={v.vendor_id} value={v.vendor_name}>{v.vendor_name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Supplier Part #</label>
                  <input type="text" className="form-input" value={formData.supplier_part_number || ''} onChange={e => setFormData({ ...formData, supplier_part_number: e.target.value })} />
                </div>
              </div>
              <div className="form-row three-col">
                <div className="form-group">
                  <label className="form-label">Qty In Stock</label>
                  <input type="number" className="form-input" min="0" value={formData.qty_in_stock ?? 0} onChange={e => setFormData({ ...formData, qty_in_stock: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Min Qty</label>
                  <input type="number" className="form-input" min="0" value={formData.min_qty ?? 0} onChange={e => setFormData({ ...formData, min_qty: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Max Qty</label>
                  <input type="number" className="form-input" min="0" value={formData.max_qty ?? 0} onChange={e => setFormData({ ...formData, max_qty: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Location</label>
                <select className="form-input" value={formData.location || ''} onChange={e => setFormData({ ...formData, location: e.target.value })}>
                  <option value="">Select location</option>
                  {locations.map(l => <option key={l.location_id} value={l.location_name}>{l.location_name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Image</label>
                <div className="image-upload-area" onClick={() => document.getElementById('inv-image-input').click()}>
                  <input type="file" id="inv-image-input" accept="image/*" style={{ display: 'none' }} onChange={handleImageSelect} />
                  {selectedImage ? (
                    <div className="image-preview">
                      <img src={selectedImage.preview || selectedImage.existingUrl} alt="Preview" referrerPolicy="no-referrer" />
                      <button type="button" className="remove-image-btn" onClick={(e) => { e.stopPropagation(); removeImage(); }}>
                        <span className="material-icons">close</span>
                      </button>
                    </div>
                  ) : (
                    <div className="upload-placeholder">
                      <span className="material-icons">cloud_upload</span>
                      <p>Click or drag image</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPartModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={savePart}>Save Part</button>
            </div>
          </div>
        </div>
      )}

      {/* View Part Detail Modal */}
      {showViewModal && currentItem && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowViewModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>Part Details</h3>
              <button className="modal-close" onClick={() => setShowViewModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="part-detail-header">
                <div className="part-detail-image">
                  {currentItem.image_url ? (
                    <img src={getImageUrl(currentItem.image_url)} alt={currentItem.part_name} referrerPolicy="no-referrer" />
                  ) : (
                    <span className="material-icons">inventory_2</span>
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: '0 0 4px' }}>{currentItem.part_name}</h2>
                  <div style={{ color: '#868e96' }}>{currentItem.part_id}</div>
                  <p style={{ color: '#868e96', margin: '8px 0 0' }}>{currentItem.description || 'No description'}</p>
                </div>
              </div>
              <div className="detail-grid">
                <div className="detail-item">
                  <label>Qty In Stock</label>
                  <span className={`qty-badge ${currentItem.isLowStock ? 'low' : 'ok'}`}>{currentItem.qty_in_stock ?? 0}</span>
                </div>
                <div className="detail-item">
                  <label>Min / Max</label>
                  <span>{currentItem.min_qty ?? 0} / {currentItem.max_qty ?? 0}</span>
                </div>
                <div className="detail-item">
                  <label>Location</label>
                  <span>{currentItem.location || '-'}</span>
                </div>
                <div className="detail-item">
                  <label>Supplier</label>
                  <span>{currentItem.primary_supplier || '-'}</span>
                </div>
                <div className="detail-item">
                  <label>Supplier Part #</label>
                  <span>{currentItem.supplier_part_number || '-'}</span>
                </div>
                <div className="detail-item">
                  <label>Status</label>
                  <span>{currentItem.status}</span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowViewModal(false)}>Close</button>
              {hasPerm('edit_items') && (
                <button className="btn btn-primary" onClick={() => { setShowViewModal(false); openEditModal(currentItem); }}>Edit</button>
              )}
              {hasPerm('delete_items') && (
                <button className="btn btn-danger" onClick={() => deletePart(currentItem.part_id)}>Delete</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Adjust Qty Modal */}
      {showAdjustModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowAdjustModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>Adjust Quantity</h3>
              <button className="modal-close" onClick={() => setShowAdjustModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p><strong>{adjustData.partName}</strong></p>
              <div className="form-group">
                <label className="form-label">Current Qty: <strong>{adjustData.currentQty}</strong></label>
              </div>
              <div className="form-group">
                <label className="form-label">New Qty</label>
                <input type="number" className="form-input" min="0" value={adjustData.newQty} onChange={e => setAdjustData({ ...adjustData, newQty: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="checkbox-filter">
                  <input type="checkbox" checked={adjustData.clearOrder} onChange={e => setAdjustData({ ...adjustData, clearOrder: e.target.checked })} />
                  <span>Clear order date</span>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowAdjustModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveQtyAdjust}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Labels Preview Modal */}
      {showLabelsModal && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowLabelsModal(false)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h3>Print Labels</h3>
              <button className="modal-close" onClick={() => setShowLabelsModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="labels-grid">
                {labelsData.map(part => {
                  const imgUrl = part.image_url ? getImageUrl(part.image_url) : '';
                  const scanUrl = `${window.location.origin}/inventory/scan?partId=${encodeURIComponent(part.part_id)}`;
                  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(scanUrl)}`;
                  return (
                    <div key={part.part_id} className="label-preview">
                      <div className="label-img">
                        {imgUrl ? <img src={imgUrl} alt="" referrerPolicy="no-referrer" /> : <span className="material-icons">inventory_2</span>}
                      </div>
                      <div className="label-info">
                        <div className="name">{part.part_name}</div>
                        <div>{part.location || '-'}</div>
                        <div>{part.supplier_part_number || '-'}</div>
                      </div>
                      <div className="label-qr">
                        <img src={qrUrl} alt="QR" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowLabelsModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={doPrintLabels}><span className="material-icons">print</span>Print</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <div className="modal-overlay visible" style={{ zIndex: 3000 }} onClick={e => e.target === e.currentTarget && setConfirmModal(null)}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h3>{confirmModal.title || 'Confirm'}</h3>
              <button className="modal-close" onClick={() => setConfirmModal(null)}>&times;</button>
            </div>
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

      {/* Styles */}
      <style>{`
        .inv-page { position: relative; }
        .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; z-index: 5000; font-size: 0.9rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .toast-success { background: #40c057; }
        .toast-error { background: #fa5252; }
        .toast-info { background: #228be6; }

        .page-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
        .toolbar-left { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .toolbar-right { display: flex; gap: 8px; }
        .search-box { display: flex; align-items: center; gap: 8px; background: white; border: 1px solid #dee2e6; border-radius: 8px; padding: 8px 12px; }
        .search-box input { border: none; outline: none; font-size: 0.9rem; min-width: 200px; }
        .filter-select { padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; background: white; }
        .checkbox-filter { display: flex; align-items: center; gap: 6px; font-size: 0.9rem; cursor: pointer; }

        .alert-banner { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #fff3cd; border-radius: 8px; margin-bottom: 20px; color: #856404; }

        .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; }
        .card-header { padding: 16px 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .header-left, .header-right { display: flex; align-items: center; gap: 12px; }
        .select-all-check { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer; }
        .badge { background: #228be6; color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; }

        .table-container { overflow-x: auto; }
        .data-table { width: 100%; border-collapse: collapse; }
        .data-table th, .data-table td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e9ecef; }
        .data-table th { background: #f8f9fa; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
        .sortable-th { cursor: pointer; user-select: none; white-space: nowrap; }
        .sortable-th:hover { background: #e9ecef; }
        .data-table tr:hover { background: #f8f9fa; }
        .data-table tr.low-stock { background: #fff5f5; }
        .data-table tr.inactive { opacity: 0.5; }
        .col-check { width: 40px; }
        .col-img { width: 60px; }
        .loading-cell { text-align: center; color: #868e96; padding: 40px !important; }

        .part-thumb { width: 48px; height: 48px; background: #f8f9fa; border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .part-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .part-thumb .material-icons { font-size: 1.5rem; color: #dee2e6; }

        .qty-badge { padding: 4px 10px; border-radius: 4px; font-weight: 600; font-size: 0.85rem; }
        .qty-badge.low { background: #ffe3e3; color: #c92a2a; }
        .qty-badge.ok { background: #d3f9d8; color: #2b8a3e; }
        .min-max { font-size: 0.85rem; color: #868e96; }

        .action-btn { background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px; color: #495057; }
        .action-btn:hover { background: #e9ecef; }
        .action-btn.danger:hover { background: #ffe3e3; color: #c92a2a; }
        .action-btn .material-icons { font-size: 1.1rem; }

        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
        .modal-overlay.visible { display: flex; }
        .modal { background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; }
        .modal-lg { max-width: 700px; }
        .modal-header { padding: 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h3 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px; }
        .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; }
        .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
        .modal-footer { padding: 16px 20px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; }

        .form-row.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .form-row.three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 6px; }
        .form-input { width: 100%; padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; font-family: inherit; box-sizing: border-box; }
        .form-input:focus { outline: none; border-color: #228be6; }

        .image-upload-area { border: 2px dashed #dee2e6; border-radius: 8px; padding: 20px; text-align: center; cursor: pointer; transition: border-color 0.2s; }
        .image-upload-area:hover { border-color: #228be6; }
        .upload-placeholder .material-icons { font-size: 2rem; color: #dee2e6; }
        .upload-placeholder p { margin: 8px 0 0; color: #868e96; font-size: 0.9rem; }
        .image-preview { position: relative; display: inline-block; }
        .image-preview img { max-width: 100%; max-height: 150px; border-radius: 8px; }
        .remove-image-btn { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.5); color: white; border: none; border-radius: 50%; width: 28px; height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .remove-image-btn .material-icons { font-size: 1rem; }

        .part-detail-header { display: flex; gap: 20px; margin-bottom: 20px; }
        .part-detail-image { width: 150px; height: 150px; background: #f8f9fa; border-radius: 12px; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
        .part-detail-image img { width: 100%; height: 100%; object-fit: cover; }
        .part-detail-image .material-icons { font-size: 3rem; color: #dee2e6; }

        .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .detail-item { padding: 12px; background: #f8f9fa; border-radius: 8px; }
        .detail-item label { font-size: 0.75rem; color: #868e96; display: block; margin-bottom: 4px; }
        .detail-item span { font-weight: 500; }

        .labels-grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .label-preview { width: 220px; height: 100px; border: 1px solid #dee2e6; padding: 8px; display: flex; gap: 8px; font-size: 10px; }
        .label-img { width: 50px; height: 50px; background: #f8f9fa; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .label-img img { width: 100%; height: 100%; object-fit: cover; }
        .label-img .material-icons { font-size: 1.5rem; color: #dee2e6; }
        .label-info { flex: 1; overflow: hidden; }
        .label-info .name { font-weight: bold; margin-bottom: 4px; }
        .label-qr { width: 70px; height: 70px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .label-qr img { width: 100%; height: 100%; object-fit: contain; }

        .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 6px; }
        .btn-primary { background: #228be6; color: white; }
        .btn-secondary { background: #f8f9fa; color: #495057; }
        .btn-danger { background: #fa5252; color: white; }
        .btn-sm { padding: 6px 12px; font-size: 0.8rem; }
      `}</style>
    </div>
  );
}
