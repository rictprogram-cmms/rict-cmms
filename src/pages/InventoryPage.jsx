/**
 * RICT CMMS - Inventory Page (React)
 * Faithfully reproduces the old Google Apps Script Inventory page.
 *
 * Features:
 * - Data table with checkbox selection, image thumbnails, qty color-coding
 * - Search + location/stock-level filters + show-inactive toggle
 * - "Missing info" filter with counts (no image / vendor / vendor part # /
 *   location / description / min-max, plus vendor or location not in the
 *   Settings list) for data clean-up
 * - Low stock warning banner with Purchase Orders link
 * - Cycle Count button (navigates to /inventory/scan for QR-based qty adjustments)
 * - Add/Edit Part modal (name, status, description, supplier, part#, qty/min/max, location, image upload)
 * - View Part Detail modal (image, detail grid, edit/delete buttons)
 * - Adjust Quantity modal (new qty, clear order date checkbox)
 * - Print Labels modal (QR codes for Zebra ZT230 2"x1")
 * - Full permission gating via hasPerm()
 * - Tools (inventory.item_type = 'Tool'): program-owned tools counted by
 *   quantity. Same table, own TL- IDs (get_next_tool_id RPC), no min/max,
 *   never low stock, kept out of purchasing and work order parts. A
 *   Parts / Tools / All switch chooses what the page lists.
 * - Tool condition: each tool row also holds how many of its total are worn,
 *   broken or missing (qty_worn / qty_broken / qty_missing). Good is whatever
 *   is left. A missing tool still counts toward the total owned. Shown in the
 *   table, detail view and print list; edited in the tool form and Adjust.
 * - Tool Audit button (Tools and All views, run_tool_audit permission) opens
 *   /inventory/tool-audit — the end-of-term tool count.
 * - Tool Kits button (manage_tool_kits, run_tool_audit, or the read-only
 *   view_tool_kits that students have) opens
 *   /inventory/tool-kits — benches and toolboxes. A tool's detail view shows
 *   how many of its total are assigned to kits (kit tools are part of the
 *   total, not extra).
 *
 * Supabase tables: inventory, inventory_locations, vendors, inventory_suppliers
 * Storage buckets: inventory-images
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { subscribeWithReconnect } from '@/lib/supabaseRealtime';
import { mustData } from '@/lib/supabaseData';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useDialogA11y } from '@/hooks/useDialogA11y';

// ---------- MISSING-INFO FILTER ----------
// Data clean-up filter: which parts are missing a piece of information.
// `stale` options compare against the ACTIVE vendors / locations in Settings,
// so they catch a value that was typed, renamed or deactivated.
const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const norm = (v) => String(v || '').trim().toLowerCase();

// ---------- PARTS vs TOOLS ----------
// A tool is program-owned equipment counted by quantity: no min/max, never
// low stock, not ordered through Purchase Orders. Anything not marked Tool is
// a Part, so rows from before the item_type column behave exactly as before.
const isTool = (i) => i?.item_type === 'Tool';
const TYPE_VIEWS = [
  { value: 'Part', label: 'Parts' },
  { value: 'Tool', label: 'Tools' },
  { value: '',     label: 'All' },
];
const TYPE_VIEW_KEY = 'rict-inventory-type-view';

// ---------- TOOL CONDITION ----------
// Whole, non-negative count from a form field or a database value
const toCount = (v) => Math.max(0, Math.floor(Number(v) || 0));
// { owned, worn, broken, missing, flagged, good } — good is what is left over
const conditionOf = (i) => {
  const owned = Number(i?.qty_in_stock) || 0;
  const worn = toCount(i?.qty_worn);
  const broken = toCount(i?.qty_broken);
  const missing = toCount(i?.qty_missing);
  const flagged = worn + broken + missing;
  return { owned, worn, broken, missing, flagged, good: Math.max(0, owned - flagged) };
};
const conditionText = (i) => {
  const c = conditionOf(i);
  return [`${c.good} good`, c.worn && `${c.worn} worn`, c.broken && `${c.broken} broken`, c.missing && `${c.missing} missing`]
    .filter(Boolean).join(', ');
};
const CONDITION_FILTERS = [
  { value: 'worn',    label: 'Has worn',    test: (c) => c.worn > 0 },
  { value: 'broken',  label: 'Has broken',  test: (c) => c.broken > 0 },
  { value: 'missing', label: 'Has missing', test: (c) => c.missing > 0 },
  { value: 'good',    label: 'All good',    test: (c) => c.flagged === 0 },
];
// Chips for the table and detail view. Every chip carries its word, so the
// meaning never depends on color.
const ConditionChips = ({ item }) => {
  const c = conditionOf(item);
  return (
    <span className="cond-chips">
      <span className="cond-chip good">{c.good} good</span>
      {c.worn > 0 && <span className="cond-chip worn">{c.worn} worn</span>}
      {c.broken > 0 && <span className="cond-chip broken">{c.broken} broken</span>}
      {c.missing > 0 && <span className="cond-chip missing">{c.missing} missing</span>}
    </span>
  );
};
const readTypeView = () => {
  try {
    const v = window.localStorage.getItem(TYPE_VIEW_KEY);
    return v === 'Tool' || v === '' ? v : 'Part';
  } catch { return 'Part'; }
};
const MISSING_OPTIONS = [
  { value: 'image',       label: 'No image',              test: (i) => blank(i.image_url) },
  // Vendor and vendor part number are optional on a tool, so a blank one is not a gap
  { value: 'vendor',      label: 'No vendor',             test: (i) => !isTool(i) && blank(i.primary_supplier) },
  { value: 'vendor_part', label: 'No vendor part number', test: (i) => !isTool(i) && blank(i.supplier_part_number) },
  { value: 'location',    label: 'No location',           test: (i) => blank(i.location) },
  { value: 'description', label: 'No description',        test: (i) => blank(i.description) },
  // Minimum 0 = the part is never flagged as low stock
  // (tools have no min/max at all, so they are never listed here)
  { value: 'minmax',      label: 'No min/max set',        test: (i) => !isTool(i) && !((Number(i.min_qty) || 0) > 0) },
  { value: 'vendor_stale',   label: 'Vendor not in list',   needs: 'vendors',
    test: (i, ctx) => !blank(i.primary_supplier) && !ctx.vendorNames.has(norm(i.primary_supplier)) },
  { value: 'location_stale', label: 'Location not in list', needs: 'locations',
    test: (i, ctx) => !blank(i.location) && !ctx.locationNames.has(norm(i.location)) },
];

export default function InventoryPage() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  // ---------- STATE ----------
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  // 'Part' | 'Tool' | '' (All). Remembered per browser; a first visit shows Parts,
  // which is the page exactly as it was before tools existed.
  const [typeFilter, setTypeFilter] = useState(readTypeView);
  const [conditionFilter, setConditionFilter] = useState('');   // '', or a CONDITION_FILTERS value (tools only)
  const [missingFilter, setMissingFilter] = useState('');   // '', 'any', or a MISSING_OPTIONS value
  const [showInactive, setShowInactive] = useState(false);
  const [sortColumn, setSortColumn] = useState('');
  const [sortDirection, setSortDirection] = useState('asc');
  const [selectedIds, setSelectedIds] = useState([]);

  // Dropdowns
  const [locations, setLocations] = useState([]);
  const [vendors, setVendors] = useState([]);
  // True only after each list actually loaded — the "not in list" checks are
  // skipped until then, so a failed load can never flag every part.
  const [locationsLoaded, setLocationsLoaded] = useState(false);
  const [vendorsLoaded, setVendorsLoaded] = useState(false);

  // Modals
  const [showPartModal, setShowPartModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showLabelsModal, setShowLabelsModal] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  // a11y: dialog refs (focus trap / Escape / focus restore) for the five modals
  const partDialogRef = useDialogA11y(showPartModal, () => setShowPartModal(false));
  const viewDialogRef = useDialogA11y(showViewModal, () => setShowViewModal(false));
  const adjustDialogRef = useDialogA11y(showAdjustModal, () => setShowAdjustModal(false));
  const labelsDialogRef = useDialogA11y(showLabelsModal, () => setShowLabelsModal(false));
  const confirmDialogRef = useDialogA11y(!!confirmModal, () => setConfirmModal(null));

  // Current editing
  const [currentItem, setCurrentItem] = useState(null);
  const [formData, setFormData] = useState({});
  const [adjustData, setAdjustData] = useState({ partId: '', partName: '', currentQty: 0, newQty: 0, clearOrder: false, isTool: false, worn: 0, broken: 0, missing: 0 });
  const [selectedImage, setSelectedImage] = useState(null); // { file, preview } or { existingUrl }
  const [isDragging, setIsDragging] = useState(false); // visual feedback for image drop zone
  const [labelsData, setLabelsData] = useState([]);

  // Toast
  const [toast, setToast] = useState(null);

  // On-order quantities keyed by inventory part_id
  const [onOrderMap, setOnOrderMap] = useState({});

  // Tools assigned to kits, keyed by part_id: how many in total across ACTIVE
  // kits of ACTIVE kit types. Empty for users who can't see kits.
  const [inKitsMap, setInKitsMap] = useState({});

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
    return subscribeWithReconnect('inventory-page-changes', ch => ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => {
        if (hasLoadedRef.current) {
          loadInventory(); // silent refresh — no spinner
        }
      })
      // Also refresh when POs or line items change (on-order badge updates)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        if (hasLoadedRef.current) loadInventory();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_line_items' }, () => {
        if (hasLoadedRef.current) loadInventory();
      })
    , { tag: 'Inventory', onReconnect: () => { if (hasLoadedRef.current) loadInventory() } });
  }, []);

  const loadDropdowns = async () => {
    try {
      const data = mustData(await supabase.from('inventory_locations').select('*').eq('status', 'Active').order('location_name'), 'inventory_locations.select');
      if (data) { setLocations(data); setLocationsLoaded(true); }
    } catch (e) { console.error(e); }

    try {
      const data = mustData(await supabase.from('vendors').select('vendor_id, vendor_name, status').eq('status', 'Active').order('vendor_name'), 'vendors.select');
      if (data) { setVendors(data); setVendorsLoaded(true); }
    } catch (e) { console.error(e); }
  };

  const loadInventory = async () => {
    // Only show loading spinner on initial load — background refreshes update silently
    if (!hasLoadedRef.current) setLoading(true);
    try {
      // Fetch inventory items
      const { data, error } = await supabase.from('inventory').select('*').order('part_name');
      if (error) throw error;

      // Fetch on-order quantities: line items from active POs (Pending, Approved, Ordered)
      // where inventory_part_id is populated
      let orderMap = {};
      try {
        const lineItems = mustData(await supabase
          .from('order_line_items')
          .select('inventory_part_id, quantity, received_qty, order_id, orders!inner(status)')
          .neq('inventory_part_id', '')
          .in('orders.status', ['Pending', 'Approved', 'Ordered']), 'order_line_items.select');

        if (lineItems) {
          for (const li of lineItems) {
            const partId = li.inventory_part_id;
            const pending = (li.quantity || 0) - (li.received_qty || 0);
            if (pending > 0 && partId) {
              orderMap[partId] = (orderMap[partId] || 0) + pending;
            }
          }
        }
      } catch (e) {
        // Non-critical — badge just won't show
        console.warn('Could not fetch on-order data:', e);
      }
      setOnOrderMap(orderMap);

      // Kit assignments (tool kits). Non-critical: without it the detail view
      // simply leaves out the "In kits" line. Users without a kit permission
      // get empty lists back, not an error.
      try {
        const [kt, kk, ki] = await Promise.all([
          supabase.from('tool_kit_types').select('type_id, status'),
          supabase.from('tool_kits').select('type_id, status'),
          supabase.from('tool_kit_type_items').select('type_id, part_id, qty'),
        ]);
        const activeTypes = new Set((mustData(kt, 'tool_kit_types.select') || []).filter(t => t.status === 'Active').map(t => t.type_id));
        const kitsPerType = {};
        (mustData(kk, 'tool_kits.select') || []).forEach(k => {
          if (k.status === 'Active' && activeTypes.has(k.type_id)) kitsPerType[k.type_id] = (kitsPerType[k.type_id] || 0) + 1;
        });
        const kitMap = {};
        (mustData(ki, 'tool_kit_type_items.select') || []).forEach(it => {
          const n = it.qty * (kitsPerType[it.type_id] || 0);
          if (n > 0) kitMap[it.part_id] = (kitMap[it.part_id] || 0) + n;
        });
        setInKitsMap(kitMap);
      } catch (e) {
        console.warn('Could not fetch tool kit data:', e);
      }

      const mapped = (data || []).map(item => ({
        ...item,
        // Low only when a minimum is set (matches the Purchase Orders Low Stock tab);
        // a part with min 0 and qty 0 is not "low", it's simply untracked.
        // A tool is never low stock, whatever its numbers say.
        isLowStock: !isTool(item) && (item.min_qty || 0) > 0 && (item.qty_in_stock || 0) <= (item.min_qty || 0),
        qtyNeeded: isTool(item) ? 0 : Math.max(0, (item.max_qty || 0) - (item.qty_in_stock || 0))
      }));
      setItems(mapped);
      hasLoadedRef.current = true;
    } catch (e) {
      if (!hasLoadedRef.current) showToast('Error loading inventory: ' + e.message, 'error');
    }
    setLoading(false);
  };

  // ---------- FILTER ----------
  // Options usable right now ("not in list" ones need their Settings list loaded)
  const missingCtx = useMemo(() => ({
    vendorNames: new Set(vendors.map(v => norm(v.vendor_name))),
    locationNames: new Set(locations.map(l => norm(l.location_name))),
  }), [vendors, locations]);
  const missingOptions = useMemo(() => MISSING_OPTIONS.filter(o =>
    !o.needs || (o.needs === 'vendors' ? vendorsLoaded : locationsLoaded)
  ), [vendorsLoaded, locationsLoaded]);
  const matchesMissing = useCallback((item, which) => {
    if (!which) return true;
    if (which === 'any') return missingOptions.some(o => o.test(item, missingCtx));
    const opt = missingOptions.find(o => o.value === which);
    return opt ? opt.test(item, missingCtx) : true;
  }, [missingOptions, missingCtx]);

  // Everything except the missing-info filter — also the base for its counts,
  // so each count is "how many of what I'm looking at have this gap".
  // Search, location, stock and status — everything except Parts/Tools and missing info.
  const preTypeItems = useMemo(() => {
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
      // Condition is a tools idea: picking one lists only the tools that match.
      const condOpt = conditionFilter && CONDITION_FILTERS.find(o => o.value === conditionFilter);
      const matchCondition = !condOpt || (isTool(item) && condOpt.test(conditionOf(item)));
      return matchSearch && matchLoc && matchStock && matchStatus && matchCondition;
    });
  }, [items, search, locationFilter, stockFilter, showInactive, conditionFilter]);

  const matchesType = useCallback((item) =>
    !typeFilter || (typeFilter === 'Tool' ? isTool(item) : !isTool(item)), [typeFilter]);

  const baseFilteredItems = useMemo(() => preTypeItems.filter(matchesType), [preTypeItems, matchesType]);

  // While searching in Parts or Tools, how many matches sit in the other one —
  // so a search for "drill" under Parts doesn't look like the drill is missing.
  const otherTypeMatches = useMemo(() => {
    if (!typeFilter || !search) return 0;
    return preTypeItems.length - baseFilteredItems.length;
  }, [typeFilter, search, preTypeItems, baseFilteredItems]);

  const changeTypeView = (value) => {
    setTypeFilter(value);
    setSelectedIds([]);                         // a selection never carries across views
    if (value === 'Tool') setStockFilter('');   // stock level does not apply to tools
    if (value === 'Part') setConditionFilter(''); // condition does not apply to parts
    try { window.localStorage.setItem(TYPE_VIEW_KEY, value); } catch { /* remembering the view is optional */ }
  };

  // Wording for whatever the page is listing
  const viewNoun = typeFilter === 'Tool' ? 'tool' : typeFilter === 'Part' ? 'part' : 'item';
  const conditionLabel = CONDITION_FILTERS.find(o => o.value === conditionFilter)?.label || '';
  const minMaxHead = typeFilter === 'Tool' ? 'Condition' : typeFilter === 'Part' ? 'Min/Max' : 'Min/Max or Condition';

  // Worn + broken + missing can never be more than the tool's total.
  // Returns the message to show, or '' when the numbers add up.
  const conditionProblem = (owned, worn, broken, missing) => {
    const total = Number(owned) || 0;
    const flagged = toCount(worn) + toCount(broken) + toCount(missing);
    return flagged > total
      ? `Worn + broken + missing is ${flagged}, but only ${total} ${total === 1 ? 'is' : 'are'} owned. Raise Qty Owned or lower a count.`
      : '';
  };

  const filteredItems = useMemo(() => {
    if (!missingFilter) return baseFilteredItems;
    return baseFilteredItems.filter(item => matchesMissing(item, missingFilter));
  }, [baseFilteredItems, missingFilter, matchesMissing]);

  const missingCounts = useMemo(() => {
    const counts = { any: 0 };
    missingOptions.forEach(o => { counts[o.value] = 0; });
    baseFilteredItems.forEach(item => {
      let any = false;
      missingOptions.forEach(o => { if (o.test(item, missingCtx)) { counts[o.value]++; any = true; } });
      if (any) counts.any++;
    });
    return counts;
  }, [baseFilteredItems, missingOptions, missingCtx]);

  const missingLabel = missingFilter === 'any'
    ? 'Anything missing'
    : (MISSING_OPTIONS.find(o => o.value === missingFilter)?.label || '');

  // Items that are low AND not already on an active purchase order.
  // "On order" is taken from real PO line items (onOrderMap), not the
  // inventory.order_date flag, which is only set by some order flows and
  // can be stale — that caused parts on order to still be counted as low.
  const lowStockCount = useMemo(() => {
    return items.filter(i =>
      i.isLowStock &&
      i.status === 'Active' &&
      !i.order_date &&
      !(onOrderMap[i.part_id] > 0)
    ).length;
  }, [items, onOrderMap]);

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
    // Adding from the Tools view starts a tool; Parts and All start a part.
    setFormData({ item_type: typeFilter === 'Tool' ? 'Tool' : 'Part', part_name: '', status: 'Active', description: '', primary_supplier: '', supplier_part_number: '', qty_in_stock: 0, min_qty: 0, max_qty: 0, qty_worn: 0, qty_broken: 0, qty_missing: 0, location: '' });
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
    setAdjustData({ partId: item.part_id, partName: item.part_name, currentQty: item.qty_in_stock || 0, newQty: item.qty_in_stock || 0, clearOrder: false, isTool: isTool(item), worn: toCount(item.qty_worn), broken: toCount(item.qty_broken), missing: toCount(item.qty_missing) });
    setShowAdjustModal(true);
  };

  const savePart = async () => {
    const tool = isTool(formData);
    const Noun = tool ? 'Tool' : 'Part';
    if (!formData.part_name?.trim()) { showToast(`${Noun} name is required`, 'error'); return; }
    if (tool) {
      const problem = conditionProblem(parseFloat(formData.qty_in_stock), formData.qty_worn, formData.qty_broken, formData.qty_missing);
      if (problem) { showToast(problem, 'error'); return; }
    }
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
        // Tools carry no min/max — 0 keeps them out of every low-stock check.
        min_qty: tool ? 0 : (parseFloat(formData.min_qty) || 0),
        max_qty: tool ? 0 : (parseFloat(formData.max_qty) || 0),
        location: formData.location || '',
        image_url: imageFileId,
        status: formData.status || 'Active',
        updated_at: new Date().toISOString(),
        updated_by: userName()
      };
      // Condition counts belong to tools only — a part's save never touches them.
      if (tool) {
        record.qty_worn = toCount(formData.qty_worn);
        record.qty_broken = toCount(formData.qty_broken);
        record.qty_missing = toCount(formData.qty_missing);
      }

      if (formData.part_id) {
        // Update
        const { data: rows, error } = await supabase.from('inventory').update(record).eq('part_id', formData.part_id).select();
        if (error) throw error;
        if (!rows || rows.length === 0) {
          showToast('Save failed — you may not have permission to edit inventory items.', 'error');
          setLoading(false);
          return;
        }
        showToast(`${Noun} updated!`, 'success');
      } else {
        // Create. The type is set here only: it decides the ID prefix, so it
        // is not changed on a later edit.
        let partId;
        if (tool) {
          // Tools have their own TL- numbers. No made-up fallback: a tool must
          // never be saved under a part-style or timestamp ID.
          const { data: toolId, error: idErr } = await supabase.rpc('get_next_tool_id');
          if (idErr || !toolId) {
            showToast('Could not get a tool ID' + (idErr?.message ? `: ${idErr.message}` : '') + '. Nothing was saved.', 'error');
            setLoading(false);
            return;
          }
          partId = toolId;
          record.item_type = 'Tool';
        } else {
          const { data: idData } = await supabase.rpc('get_next_id', { p_type: 'inventory' });
          partId = idData || `INV${Date.now()}`;
        }
        record.part_id = partId;
        const { data: rows, error } = await supabase.from('inventory').insert([record]).select();
        if (error) throw error;
        if (!rows || rows.length === 0) {
          showToast('Create failed — you may not have permission to add inventory items.', 'error');
          setLoading(false);
          return;
        }
        showToast(`${Noun} created!`, 'success');
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
      title: isTool(part) ? 'Delete Tool' : 'Delete Part',
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
          showToast(isTool(part) ? 'Tool deleted' : 'Part deleted', 'info');
          setShowViewModal(false);
          loadInventory();
        } catch (e) { showToast('Error: ' + e.message, 'error'); }
        setLoading(false);
      }
    });
  };

  const saveQtyAdjust = async () => {
    if (adjustData.isTool) {
      const problem = conditionProblem(parseFloat(adjustData.newQty), adjustData.worn, adjustData.broken, adjustData.missing);
      if (problem) { showToast(problem, 'error'); return; }
    }
    try {
      setLoading(true);
      const updates = {
        qty_in_stock: parseFloat(adjustData.newQty) || 0,
        updated_at: new Date().toISOString(),
        updated_by: userName()
      };
      if (adjustData.isTool) {
        updates.qty_worn = toCount(adjustData.worn);
        updates.qty_broken = toCount(adjustData.broken);
        updates.qty_missing = toCount(adjustData.missing);
      }
      if (adjustData.clearOrder && !adjustData.isTool) {
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
  // Shared validation + preview logic — used by click-upload, drag-and-drop,
  // AND clipboard paste so all three paths can never drift apart.
  const processImageFile = useCallback((file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please select an image', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => setSelectedImage({ file, preview: ev.target.result });
    reader.readAsDataURL(file);
  }, [showToast]);

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    processImageFile(file);
    // Reset the input so selecting the same file twice in a row still fires onChange
    e.target.value = '';
  };

  // Drag-and-drop handlers for the image upload area.
  // preventDefault on dragOver/dragEnter is REQUIRED — without it, the browser
  // opens the dropped file in a new tab instead of firing onDrop.
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear dragging state when leaving the drop zone itself, not its children
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleImageDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    processImageFile(file);
  };

  // Paste-from-clipboard support — while the part modal is open, listen for Ctrl+V
  // pastes containing an image and process them through the same pipeline.
  // Skipped when the user is focused on a text field so we don't hijack regular
  // text pastes into Part Name, Description, etc.
  useEffect(() => {
    if (!showPartModal) return;

    const handlePaste = (e) => {
      const target = e.target;
      const tag = target?.tagName;
      // Don't intercept pastes into text inputs, textareas, selects, or contenteditable elements
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            processImageFile(file);
            showToast('Image pasted from clipboard', 'success');
          }
          return;
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [showPartModal, processImageFile, showToast]);

  const removeImage = () => {
    setSelectedImage(null);
  };

  // ---------- LABELS ----------
  const openLabelsPreview = () => {
    if (selectedIds.length === 0) { showToast('Nothing selected', 'error'); return; }
    const selected = items.filter(i => selectedIds.includes(i.part_id));
    setLabelsData(selected);
    setShowLabelsModal(true);
  };

  const doPrintLabels = async () => {
    // ── Fetch label dimensions from settings (with safe fallbacks) ──
    // label_width_inches / label_height_inches are configurable so users
    // can swap label stock without touching code. If the settings are
    // missing, blank, or non-numeric, we fall back to the Zebra ZT230
    // default of 2" x 1".
    let labelW = 2
    let labelH = 1
    try {
      const dims = mustData(await supabase
        .from('settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['label_width_inches', 'label_height_inches']), 'settings.select');
      (dims || []).forEach(d => {
        const v = parseFloat(d.setting_value)
        if (!isNaN(v) && v > 0) {
          if (d.setting_key === 'label_width_inches')  labelW = v
          if (d.setting_key === 'label_height_inches') labelH = v
        }
      })
    } catch (e) {
      console.warn('[Inventory] Label dim fetch failed, using 2x1 fallback:', e?.message)
    }

    // ── Auto-proportion inner elements to label size ──
    // Inner squares (image, QR) scale with label height — that's the dimension
    // they were originally tuned for. We also cap them at a fraction of label
    // width so unusual narrow/tall stock (e.g. 1"x1.5") doesn't overflow.
    // Reference design (2"x1" stock): image=0.45", QR=0.75", body text=8px.
    const imgSize = Math.min(labelH * 0.45, labelW * 0.25).toFixed(3)
    const qrSize  = Math.min(labelH * 0.75, labelW * 0.40).toFixed(3)
    // Fonts scale by the smaller dimension so wide-but-short labels don't
    // produce comically tall text. minDim==1 reproduces the original sizes.
    const minDim   = Math.min(labelW, labelH)
    const fontPx   = (8 * minDim).toFixed(1)

    const origin = window.location.origin;
    let labelsHtml = '';
    labelsData.forEach(part => {
      const imgUrl = part.image_url ? getImageUrl(part.image_url) : '';
      const scanUrl = `${origin}/inventory/scan?partId=${encodeURIComponent(part.part_id)}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(scanUrl)}`;
      labelsHtml += `<div class="label-preview">` +
        `<div class="label-img">${imgUrl ? `<img src="${imgUrl}" alt="" referrerpolicy="no-referrer">` : '<span class="material-icons">inventory_2</span>'}</div>` +
        `<div class="label-info"><div class="name">${part.part_name}</div><div>${part.location || '-'}</div><div>${part.supplier_part_number || '-'}</div></div>` +
        `<div class="label-qr"><img src="${qrUrl}" alt="QR"></div></div>`;
    });

    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Labels</title><link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
      <style>@page{size:${labelW}in ${labelH}in;margin:0}body{font-family:Arial;margin:0;padding:0}
      .label-preview{width:${labelW}in;height:${labelH}in;border:1px solid #ccc;padding:10px 10px 2px 4px;display:flex;gap:4px;font-size:${fontPx}px;page-break-after:always;box-sizing:border-box}
      .label-img{width:${imgSize}in;height:${imgSize}in;background:#f0f0f0;overflow:hidden;flex-shrink:0}.label-img img{width:100%;height:100%;object-fit:cover}
      .label-info{flex:1;overflow:hidden;min-width:0}.label-info .name{font-weight:bold}
      .label-qr{width:${qrSize}in;height:${qrSize}in;overflow:hidden;flex-shrink:0}.label-qr img{width:100%;height:100%;object-fit:contain}
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
      const onOrder = onOrderMap[item.part_id];
      const onOrderStr = onOrder > 0 ? ` <span style="color:#364fc7;font-size:10px">(${onOrder} on order)</span>` : '';
      return `<tr>
        <td>${item.part_id}</td>
        <td>${item.part_name}</td>
        <td>${item.supplier_part_number || '—'}</td>
        <td style="${qtyClass}">${item.qty_in_stock ?? 0}${onOrderStr}</td>
        <td>${isTool(item) ? conditionText(item) : `${item.min_qty ?? 0} / ${item.max_qty ?? 0}`}</td>
        <td>${item.location || '—'}</td>
        <td>${item.primary_supplier || '—'}</td>
        <td>${item.status}</td>
      </tr>`;
    }).join('');

    const filterNotes = [];
    if (typeFilter) filterNotes.push(typeFilter === 'Tool' ? 'Tools only' : 'Parts only');
    if (search) filterNotes.push(`Search: "${search}"`);
    if (locationFilter) filterNotes.push(`Location: ${locationFilter}`);
    if (stockFilter) filterNotes.push(`Stock: ${stockFilter}`);
    if (conditionFilter && conditionLabel) filterNotes.push(`Condition: ${conditionLabel}`);
    if (missingFilter && missingLabel) filterNotes.push(`Missing info: ${missingLabel}`);
    if (showInactive) filterNotes.push('Including inactive');
    const filterLine = filterNotes.length > 0
      ? `<div style="font-size:11px;color:#666;margin-bottom:8px">Filters: ${filterNotes.join(' · ')}</div>`
      : '';

    const w = window.open('', '_blank');
    const listTitle = typeFilter === 'Tool' ? 'Tool List' : 'Inventory List';
    const idHead = typeFilter === 'Tool' ? 'Tool ID' : typeFilter === 'Part' ? 'Part ID' : 'ID';
    const nameHead = typeFilter === 'Tool' ? 'Tool Name' : typeFilter === 'Part' ? 'Part Name' : 'Name';
    w.document.write(`<html><head><title>${listTitle}</title><style>
      @page { size: landscape; margin: 0.5in; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin: 0; padding: 0; }
      h2 { margin: 0 0 4px; font-size: 16px; }
      .meta { font-size: 11px; color: #666; margin-bottom: 12px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
      th { background: #f0f0f0; font-size: 11px; text-transform: uppercase; }
      tr:nth-child(even) { background: #fafafa; }
    </style></head><body>
      <h2>RICT CMMS — ${listTitle}</h2>
      <div class="meta">Printed ${new Date().toLocaleDateString()} · ${listData.length} item${listData.length !== 1 ? 's' : ''}</div>
      ${filterLine}
      <table>
        <thead><tr><th scope="col">${idHead}</th><th scope="col">${nameHead}</th><th scope="col">Supplier Part #</th><th scope="col">Qty</th><th scope="col">${minMaxHead}</th><th scope="col">Location</th><th scope="col">Supplier</th><th scope="col">Status</th></tr></thead>
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
          {/* Parts / Tools / All — what the page lists */}
          <div className="type-switch" role="group" aria-label="Show parts, tools, or all items">
            {TYPE_VIEWS.map(v => (
              <button key={v.label} type="button"
                className={`type-switch-btn${typeFilter === v.value ? ' active' : ''}`}
                aria-pressed={typeFilter === v.value}
                onClick={() => changeTypeView(v.value)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="search-box">
            <span className="material-icons" aria-hidden="true">search</span>
            <input type="text" placeholder={`Search ${viewNoun}s...`} aria-label={`Search ${viewNoun}s`} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="filter-select" aria-label="Filter by location" value={locationFilter} onChange={e => setLocationFilter(e.target.value)}>
            <option value="">All Locations</option>
            {locations.map(l => <option key={l.location_id} value={l.location_name}>{l.location_name}</option>)}
          </select>
          {/* Stock level is a parts idea — tools have no min/max, so it is hidden on the Tools view */}
          {typeFilter !== 'Tool' && (
            <select className="filter-select" aria-label="Filter by stock level" value={stockFilter} onChange={e => setStockFilter(e.target.value)}>
              <option value="">All Stock Levels</option>
              {hasPerm('view_low_stock') && <option value="low">Low Stock</option>}
              <option value="ok">In Stock</option>
            </select>
          )}
          {/* Condition is a tools idea — offered on the Tools and All views */}
          {typeFilter !== 'Part' && (
            <select className="filter-select" aria-label="Filter tools by condition" value={conditionFilter} onChange={e => setConditionFilter(e.target.value)}>
              <option value="">All Conditions</option>
              {CONDITION_FILTERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {/* Missing info — data clean-up. Counts follow the other filters. */}
          <select className="filter-select" aria-label="Filter by missing information" value={missingFilter} onChange={e => setMissingFilter(e.target.value)}>
            <option value="">Missing Info: Off</option>
            <option value="any">Anything missing ({missingCounts.any})</option>
            {missingOptions.map(o => <option key={o.value} value={o.value}>{o.label} ({missingCounts[o.value] || 0})</option>)}
          </select>
          <label className="checkbox-filter">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            <span>Show Inactive</span>
          </label>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-sm btn-secondary" onClick={printInventoryList} title="Print a clean one-line-per-item list">
            <span className="material-icons" aria-hidden="true">list_alt</span>Print List
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => navigate('/inventory/scan')}>
            <span className="material-icons" aria-hidden="true">qr_code_scanner</span>Cycle Count
          </button>
          {hasPerm('view_low_stock') && (
            <button className="btn btn-sm btn-secondary" onClick={() => navigate('/purchase-orders', { state: { tab: 'lowstock' } })}>
              <span className="material-icons" aria-hidden="true">shopping_cart</span>Purchase Orders
            </button>
          )}
          {/* Tool count audit — instructors (run_tool_audit), wherever tools are listed */}
          {typeFilter !== 'Part' && hasPerm('run_tool_audit') && (
            <button className="btn btn-sm btn-secondary" onClick={() => navigate('/inventory/tool-audit')}>
              <span className="material-icons" aria-hidden="true">fact_check</span>Tool Audit
            </button>
          )}
          {/* Tool kits (benches, toolboxes) — staff, and students read-only (view_tool_kits) */}
          {typeFilter !== 'Part' && (hasPerm('manage_tool_kits') || hasPerm('run_tool_audit') || hasPerm('view_tool_kits')) && (
            <button className="btn btn-sm btn-secondary" onClick={() => navigate('/inventory/tool-kits')}>
              <span className="material-icons" aria-hidden="true">home_repair_service</span>Tool Kits
            </button>
          )}
          {hasPerm('add_items') && (
            <button className="btn btn-sm btn-primary" onClick={openAddModal}>
              <span className="material-icons" aria-hidden="true">add</span>{typeFilter === 'Tool' ? 'Add Tool' : typeFilter === 'Part' ? 'Add Part' : 'Add Item'}
            </button>
          )}
        </div>
      </div>

      {/* Low Stock Banner — only visible to users with view_low_stock permission */}
      {lowStockCount > 0 && hasPerm('view_low_stock') && (
        <div className="alert-banner">
          <span className="material-icons" aria-hidden="true">warning</span>
          <strong>{lowStockCount}</strong> {lowStockCount === 1 ? 'item' : 'items'} low on stock and not yet on order
          <button className="btn btn-sm btn-primary" onClick={() => navigate('/purchase-orders', { state: { tab: 'lowstock' } })}>
            <span className="material-icons" aria-hidden="true">shopping_cart</span>Purchase Orders
          </button>
        </div>
      )}

      {/* Search found matches in the view that is not showing */}
      {otherTypeMatches > 0 && (
        <div className="type-hint" role="status">
          <span className="material-icons" aria-hidden="true">info</span>
          <span>
            {otherTypeMatches} more match{otherTypeMatches === 1 ? '' : 'es'} for &ldquo;{search}&rdquo; in {typeFilter === 'Tool' ? 'Parts' : 'Tools'}.
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => changeTypeView('')}>Show all</button>
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
            {/* Screen-reader announcement when the missing-info filter changes the list */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {missingFilter && missingLabel ? `${filteredItems.length} ${viewNoun}${filteredItems.length === 1 ? '' : 's'} shown: ${missingLabel}` : ''}
            </span>
            {/* ...when the condition filter changes it */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {conditionFilter && conditionLabel ? `${filteredItems.length} tool${filteredItems.length === 1 ? '' : 's'} shown: ${conditionLabel}` : ''}
            </span>
            {/* ...and when the Parts / Tools / All switch changes it */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {typeFilter === 'Tool' ? 'Showing tools' : typeFilter === 'Part' ? 'Showing parts' : 'Showing parts and tools'}
            </span>
            {selectedIds.length > 0 && hasPerm('print_labels') && (
              <button className="btn btn-sm btn-secondary" onClick={openLabelsPreview}>
                <span className="material-icons" aria-hidden="true">print</span>Print Labels ({selectedIds.length})
              </button>
            )}
          </div>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                {hasPerm('print_labels') && <th scope="col" className="col-check"></th>}
                <th scope="col" className="col-img">Image</th>
                <th scope="col" className="sortable-th" onClick={() => handleSort('part_name')}>{typeFilter === 'Tool' ? 'Tool Name' : typeFilter === 'Part' ? 'Part Name' : 'Name'} {sortColumn === 'part_name' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th scope="col" className="sortable-th" onClick={() => handleSort('supplier_part_number')}>Supplier Part # {sortColumn === 'supplier_part_number' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th scope="col">Qty</th>
                <th scope="col">{minMaxHead}</th>
                <th scope="col" className="sortable-th" onClick={() => handleSort('location')}>Location {sortColumn === 'location' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th scope="col" className="sortable-th" onClick={() => handleSort('primary_supplier')}>Supplier {sortColumn === 'primary_supplier' ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={hasPerm('print_labels') ? 9 : 8} className="loading-cell">Loading inventory...</td></tr>
              ) : sortedItems.length === 0 ? (
                <tr><td colSpan={hasPerm('print_labels') ? 9 : 8} className="loading-cell">{typeFilter === 'Tool' && items.every(i => !isTool(i)) ? 'No tools yet. Use Add Tool to start the tool inventory.' : 'No inventory items found'}</td></tr>
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
                        {imgUrl ? <img src={imgUrl} alt="" referrerPolicy="no-referrer" /> : <span className="material-icons" aria-hidden="true">{isTool(item) ? 'build' : 'inventory_2'}</span>}
                      </div>
                    </td>
                    <td onClick={() => openViewModal(item)} style={{ cursor: 'pointer' }}>
                      <button type="button" onClick={ev => { ev.stopPropagation(); openViewModal(item) }}
                        aria-label={`View details for ${item.part_name}`}
                        style={{ background: 'none', border: 'none', padding: '4px 0', minHeight: 44, cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' }}>
                        <strong>{highlightMatch(item.part_name)}</strong><br /><small style={{ color: '#868e96' }}>{highlightMatch(item.part_id)}</small>
                      </button>
                      {/* On the All view, say which rows are tools (text, not color alone) */}
                      {!typeFilter && isTool(item) && <span className="tool-tag">Tool</span>}
                    </td>
                    <td>{highlightMatch(item.supplier_part_number || '-')}</td>
                    <td>
                      <span className={`qty-badge ${qtyClass}`}>{item.qty_in_stock ?? 0}</span>
                      {onOrderMap[item.part_id] > 0 && (
                        <div className="on-order-badge" title={`${onOrderMap[item.part_id]} on order`}>
                          <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.8rem' }}>local_shipping</span>
                          {onOrderMap[item.part_id]} on order
                        </div>
                      )}
                    </td>
                    <td className="min-max">
                      {isTool(item)
                        ? <ConditionChips item={item} />
                        : <>{item.min_qty ?? 0} / {item.max_qty ?? 0}</>}
                    </td>
                    <td>{highlightMatch(item.location || '-')}</td>
                    <td>{highlightMatch(item.primary_supplier || '-')}</td>
                    <td>
                      <button type="button" className="action-btn" onClick={() => openViewModal(item)} title="View" aria-label={`View ${item.part_name}`}><span className="material-icons" aria-hidden="true">visibility</span></button>
                      {hasPerm('adjust_quantity') && (
                        <button type="button" className="action-btn" onClick={() => openAdjustModal(item)} title="Adjust Qty" aria-label={`Adjust quantity for ${item.part_name}`}><span className="material-icons" aria-hidden="true">tune</span></button>
                      )}
                      {hasPerm('edit_items') && (
                        <button type="button" className="action-btn" onClick={() => openEditModal(item)} title="Edit" aria-label={`Edit ${item.part_name}`}><span className="material-icons" aria-hidden="true">edit</span></button>
                      )}
                      {hasPerm('delete_items') && (
                        <button type="button" className="action-btn danger" onClick={() => deletePart(item.part_id)} title="Delete" aria-label={`Delete ${item.part_name}`}><span className="material-icons" aria-hidden="true">delete</span></button>
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
          <div ref={partDialogRef} role="dialog" aria-modal="true" aria-labelledby="inv-part-title" className="modal modal-lg">
            <div className="modal-header">
              <h3 id="inv-part-title">{formData.part_id ? (isTool(formData) ? 'Edit Tool' : 'Edit Part') : (isTool(formData) ? 'Add New Tool' : 'Add New Part')}</h3>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowPartModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              {/* Type: chosen when adding (it sets the ID prefix), shown but fixed afterwards */}
              {formData.part_id ? (
                <p className="type-fixed">
                  Type: <strong>{isTool(formData) ? 'Tool' : 'Part'}</strong> <span>({formData.part_id})</span>
                </p>
              ) : (
                <div className="form-group">
                  <label htmlFor="inv-fld-item-type-0" className="form-label">Type</label>
                  <select id="inv-fld-item-type-0" className="form-input" aria-describedby="inv-fld-item-type-help"
                    value={isTool(formData) ? 'Tool' : 'Part'}
                    onChange={e => setFormData({ ...formData, item_type: e.target.value })}>
                    <option value="Part">Part — stocked, with min/max and ordering</option>
                    <option value="Tool">Tool — program-owned, counted only</option>
                  </select>
                  <small id="inv-fld-item-type-help" className="field-help">
                    {isTool(formData)
                      ? 'Tools get a TL- ID, have no min/max, and are never low stock or ordered through Purchase Orders. The type cannot be changed after saving.'
                      : 'Parts get an INV- ID. The type cannot be changed after saving.'}
                  </small>
                </div>
              )}
              <div className="form-row two-col">
                <div className="form-group">
                  <label htmlFor="inv-fld-part-name-1" className="form-label">{isTool(formData) ? 'Tool Name *' : 'Part Name *'}</label>
                  <input id="inv-fld-part-name-1" type="text" className="form-input" value={formData.part_name || ''} onChange={e => setFormData({ ...formData, part_name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="inv-fld-status-2" className="form-label">Status</label>
                  <select id="inv-fld-status-2" className="form-input" value={formData.status || 'Active'} onChange={e => setFormData({ ...formData, status: e.target.value })}>
                    <option value="Active">Active</option><option value="Inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="inv-fld-description-3" className="form-label">Description</label>
                <textarea id="inv-fld-description-3" className="form-input" rows="2" value={formData.description || ''} onChange={e => setFormData({ ...formData, description: e.target.value })} />
              </div>
              <div className="form-row two-col">
                <div className="form-group">
                  <label htmlFor="inv-fld-primary-supplier-4" className="form-label">{isTool(formData) ? 'Supplier (optional)' : 'Primary Supplier'}</label>
                  <select id="inv-fld-primary-supplier-4" className="form-input" value={formData.primary_supplier || ''} onChange={e => setFormData({ ...formData, primary_supplier: e.target.value })}>
                    <option value="">Select supplier</option>
                    {vendors.map(v => <option key={v.vendor_id} value={v.vendor_name}>{v.vendor_name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="inv-fld-supplier-part-5" className="form-label">{isTool(formData) ? 'Supplier Part # (optional)' : 'Supplier Part #'}</label>
                  <input id="inv-fld-supplier-part-5" type="text" className="form-input" value={formData.supplier_part_number || ''} onChange={e => setFormData({ ...formData, supplier_part_number: e.target.value })} />
                </div>
              </div>
              <div className={`form-row ${isTool(formData) ? 'two-col' : 'three-col'}`}>
                <div className="form-group">
                  <label htmlFor="inv-fld-qty-in-stock-6" className="form-label">{isTool(formData) ? 'Qty Owned' : 'Qty In Stock'}</label>
                  <input id="inv-fld-qty-in-stock-6" type="number" className="form-input" min="0" value={formData.qty_in_stock ?? 0} onChange={e => setFormData({ ...formData, qty_in_stock: e.target.value })} />
                </div>
                {/* Min / Max are a parts idea — not shown, and saved as 0, for a tool */}
                {!isTool(formData) && (<>
                <div className="form-group">
                  <label htmlFor="inv-fld-min-qty-7" className="form-label">Min Qty</label>
                  <input id="inv-fld-min-qty-7" type="number" className="form-input" min="0" value={formData.min_qty ?? 0} onChange={e => setFormData({ ...formData, min_qty: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="inv-fld-max-qty-8" className="form-label">Max Qty</label>
                  <input id="inv-fld-max-qty-8" type="number" className="form-input" min="0" value={formData.max_qty ?? 0} onChange={e => setFormData({ ...formData, max_qty: e.target.value })} />
                </div>
                </>)}
              </div>
              {/* Condition counts — tools only. Good is worked out, never typed. */}
              {isTool(formData) && (
                <fieldset className="cond-fieldset">
                  <legend>Condition <span>(how many of the total)</span></legend>
                  <div className="form-row three-col">
                    <div className="form-group">
                      <label htmlFor="inv-fld-qty-worn-11" className="form-label">Worn</label>
                      <input id="inv-fld-qty-worn-11" type="number" className="form-input" min="0" step="1" aria-describedby="inv-cond-summary" value={formData.qty_worn ?? 0} onChange={e => setFormData({ ...formData, qty_worn: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label htmlFor="inv-fld-qty-broken-12" className="form-label">Broken</label>
                      <input id="inv-fld-qty-broken-12" type="number" className="form-input" min="0" step="1" aria-describedby="inv-cond-summary" value={formData.qty_broken ?? 0} onChange={e => setFormData({ ...formData, qty_broken: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label htmlFor="inv-fld-qty-missing-13" className="form-label">Missing</label>
                      <input id="inv-fld-qty-missing-13" type="number" className="form-input" min="0" step="1" aria-describedby="inv-cond-summary" value={formData.qty_missing ?? 0} onChange={e => setFormData({ ...formData, qty_missing: e.target.value })} />
                    </div>
                  </div>
                  {(() => {
                    const problem = conditionProblem(parseFloat(formData.qty_in_stock), formData.qty_worn, formData.qty_broken, formData.qty_missing);
                    return (
                      <p id="inv-cond-summary" className={`cond-summary${problem ? ' error' : ''}`} role="status">
                        {problem || `Good: ${conditionOf(formData).good} of ${conditionOf(formData).owned}. A missing tool still counts in Qty Owned.`}
                      </p>
                    );
                  })()}
                </fieldset>
              )}
              <div className="form-group">
                <label htmlFor="inv-fld-location-9" className="form-label">Location</label>
                <select id="inv-fld-location-9" className="form-input" value={formData.location || ''} onChange={e => setFormData({ ...formData, location: e.target.value })}>
                  <option value="">Select location</option>
                  {locations.map(l => <option key={l.location_id} value={l.location_name}>{l.location_name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="inv-image-input">Image</label>
                <div
                  className={`image-upload-area${isDragging ? ' dragging' : ''}`}
                  onClick={() => document.getElementById('inv-image-input').click()}
                  onDragEnter={handleDragEnter}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleImageDrop}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      document.getElementById('inv-image-input').click();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={selectedImage ? 'Image selected. Click or press Enter to replace, paste with Ctrl+V, or use the remove button.' : 'Upload image. Click, press Enter, drag and drop, or paste with Ctrl+V. Maximum 5 megabytes.'}
                >
                  <input type="file" id="inv-image-input" accept="image/*" style={{ display: 'none' }} onChange={handleImageSelect} />
                  {selectedImage ? (
                    <div className="image-preview">
                      <img src={selectedImage.preview || selectedImage.existingUrl} alt={isTool(formData) ? 'Selected tool image preview' : 'Selected part image preview'} referrerPolicy="no-referrer" />
                      <button
                        type="button"
                        className="remove-image-btn"
                        onClick={(e) => { e.stopPropagation(); removeImage(); }}
                        aria-label="Remove image"
                      >
                        <span className="material-icons" aria-hidden="true">close</span>
                      </button>
                    </div>
                  ) : (
                    <div className="upload-placeholder" aria-live="polite">
                      <span className="material-icons" aria-hidden="true">cloud_upload</span>
                      <p>{isDragging ? 'Drop image to upload' : 'Click, drag, or paste image'}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPartModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={savePart}>{isTool(formData) ? 'Save Tool' : 'Save Part'}</button>
            </div>
          </div>
        </div>
      )}

      {/* View Part Detail Modal */}
      {showViewModal && currentItem && (
        <div className="modal-overlay visible" onClick={e => e.target === e.currentTarget && setShowViewModal(false)}>
          <div ref={viewDialogRef} role="dialog" aria-modal="true" aria-labelledby="inv-view-title" className="modal">
            <div className="modal-header">
              <h3 id="inv-view-title">{isTool(currentItem) ? 'Tool Details' : 'Part Details'}</h3>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowViewModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="part-detail-header">
                <div className="part-detail-image">
                  {currentItem.image_url ? (
                    <img src={getImageUrl(currentItem.image_url)} alt={currentItem.part_name} referrerPolicy="no-referrer" />
                  ) : (
                    <span className="material-icons" aria-hidden="true">{isTool(currentItem) ? 'build' : 'inventory_2'}</span>
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
                  <label>{isTool(currentItem) ? 'Qty Owned' : 'Qty In Stock'}</label>
                  <span className={`qty-badge ${currentItem.isLowStock ? 'low' : 'ok'}`}>{currentItem.qty_in_stock ?? 0}</span>
                  {onOrderMap[currentItem.part_id] > 0 && (
                    <div className="on-order-badge" style={{ marginTop: 6 }}>
                      <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.8rem' }}>local_shipping</span>
                      {onOrderMap[currentItem.part_id]} on order
                    </div>
                  )}
                </div>
                {isTool(currentItem) ? (
                  <>
                    <div className="detail-item">
                      <label>Type</label>
                      <span>Tool</span>
                    </div>
                    <div className="detail-item">
                      <label>Condition</label>
                      <ConditionChips item={currentItem} />
                    </div>
                    {/* Kit tools are part of the total: say how the total splits */}
                    {inKitsMap[currentItem.part_id] > 0 && (() => {
                      const inKits = inKitsMap[currentItem.part_id];
                      const owned = Number(currentItem.qty_in_stock) || 0;
                      return (
                        <div className="detail-item">
                          <label>In kits</label>
                          <span>{inKits} of {owned} ({Math.max(0, owned - inKits)} in general stock)</span>
                          {inKits > owned && (
                            <span className="kit-short">Kits need {inKits - owned} more than are owned.</span>
                          )}
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <div className="detail-item">
                    <label>Min / Max</label>
                    <span>{currentItem.min_qty ?? 0} / {currentItem.max_qty ?? 0}</span>
                  </div>
                )}
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
          <div ref={adjustDialogRef} role="dialog" aria-modal="true" aria-labelledby="inv-adjust-title" className="modal">
            <div className="modal-header">
              <h3 id="inv-adjust-title">Adjust Quantity</h3>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowAdjustModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p><strong>{adjustData.partName}</strong></p>
              <div className="form-group">
                <label className="form-label">Current Qty: <strong>{adjustData.currentQty}</strong></label>
              </div>
              <div className="form-group">
                <label htmlFor="inv-fld-new-qty-10" className="form-label">New Qty</label>
                <input id="inv-fld-new-qty-10" type="number" className="form-input" min="0" value={adjustData.newQty} onChange={e => setAdjustData({ ...adjustData, newQty: e.target.value })} />
              </div>
              {/* Tools: the same dialog also updates the condition counts */}
              {adjustData.isTool && (
                <fieldset className="cond-fieldset">
                  <legend>Condition <span>(how many of the total)</span></legend>
                  <div className="form-row three-col">
                    <div className="form-group">
                      <label htmlFor="inv-adj-worn-14" className="form-label">Worn</label>
                      <input id="inv-adj-worn-14" type="number" className="form-input" min="0" step="1" aria-describedby="inv-adj-cond-summary" value={adjustData.worn} onChange={e => setAdjustData({ ...adjustData, worn: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label htmlFor="inv-adj-broken-15" className="form-label">Broken</label>
                      <input id="inv-adj-broken-15" type="number" className="form-input" min="0" step="1" aria-describedby="inv-adj-cond-summary" value={adjustData.broken} onChange={e => setAdjustData({ ...adjustData, broken: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label htmlFor="inv-adj-missing-16" className="form-label">Missing</label>
                      <input id="inv-adj-missing-16" type="number" className="form-input" min="0" step="1" aria-describedby="inv-adj-cond-summary" value={adjustData.missing} onChange={e => setAdjustData({ ...adjustData, missing: e.target.value })} />
                    </div>
                  </div>
                  {(() => {
                    const owned = parseFloat(adjustData.newQty) || 0;
                    const problem = conditionProblem(owned, adjustData.worn, adjustData.broken, adjustData.missing);
                    const good = Math.max(0, owned - toCount(adjustData.worn) - toCount(adjustData.broken) - toCount(adjustData.missing));
                    return (
                      <p id="inv-adj-cond-summary" className={`cond-summary${problem ? ' error' : ''}`} role="status">
                        {problem || `Good: ${good} of ${owned}. A missing tool still counts in the quantity.`}
                      </p>
                    );
                  })()}
                </fieldset>
              )}
              {/* Tools are never on order, so there is no order date to clear */}
              {!adjustData.isTool && (
                <div className="form-group">
                  <label className="checkbox-filter">
                    <input type="checkbox" checked={adjustData.clearOrder} onChange={e => setAdjustData({ ...adjustData, clearOrder: e.target.checked })} />
                    <span>Clear order date</span>
                  </label>
                </div>
              )}
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
          <div ref={labelsDialogRef} role="dialog" aria-modal="true" aria-labelledby="inv-labels-title" className="modal modal-lg">
            <div className="modal-header">
              <h3 id="inv-labels-title">Print Labels</h3>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowLabelsModal(false)}>&times;</button>
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
                        {imgUrl ? <img src={imgUrl} alt="" referrerPolicy="no-referrer" /> : <span className="material-icons" aria-hidden="true">inventory_2</span>}
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
              <button className="btn btn-primary" onClick={doPrintLabels}><span className="material-icons" aria-hidden="true">print</span>Print</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <div className="modal-overlay visible" style={{ zIndex: 3000 }} onClick={e => e.target === e.currentTarget && setConfirmModal(null)}>
          <div ref={confirmDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="inv-confirm-title" className="modal">
            <div className="modal-header">
              <h3 id="inv-confirm-title">{confirmModal.title || 'Confirm'}</h3>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setConfirmModal(null)}>&times;</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span className="material-icons" aria-hidden="true" style={{ fontSize: 48, color: '#fab005' }}>help_outline</span>
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
        /* Parts / Tools / All switch */
        .type-switch { display: inline-flex; border: 1px solid #adb5bd; border-radius: 8px; overflow: hidden; background: white; }
        .type-switch-btn { min-height: 44px; min-width: 64px; padding: 0 16px; border: none; border-right: 1px solid #adb5bd; background: white; color: #343a40; font-size: 0.9rem; font-weight: 500; cursor: pointer; }
        .type-switch-btn:last-child { border-right: none; }
        .type-switch-btn:hover { background: #f1f3f5; }
        .type-switch-btn.active { background: #1864ab; color: white; font-weight: 600; }
        .type-switch-btn:focus-visible { outline: 3px solid #1864ab; outline-offset: -3px; box-shadow: inset 0 0 0 5px white; }
        .type-hint { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 14px; margin-bottom: 16px; background: #e7f5ff; border: 1px solid #a5d8ff; border-radius: 8px; color: #1c3d5a; font-size: 0.9rem; }
        .type-hint .material-icons { font-size: 1.1rem; }
        .tool-tag { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 10px; background: #e7f5ff; border: 1px solid #74c0fc; color: #0b4a85; font-size: 0.75rem; font-weight: 600; vertical-align: middle; }
        /* Tool condition */
        .cond-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
        .cond-chip { padding: 2px 8px; border-radius: 10px; font-size: 0.78rem; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
        .cond-chip.good { background: #e6f4ea; color: #1b5e20; border-color: #a5d6a7; }
        .cond-chip.worn { background: #fff3cd; color: #6b4400; border-color: #e0b84d; }
        .cond-chip.broken { background: #ffe3e3; color: #a51111; border-color: #f1a5a5; }
        .cond-chip.missing { background: #e9ecef; color: #343a40; border-color: #adb5bd; }
        .cond-fieldset { border: 1px solid #ced4da; border-radius: 8px; padding: 12px 14px 4px; margin: 0 0 16px; }
        .cond-fieldset legend { padding: 0 6px; font-size: 0.9rem; font-weight: 600; color: #343a40; }
        .cond-fieldset legend span { font-weight: 400; color: #495057; }
        .cond-summary { margin: 0 0 10px; font-size: 0.85rem; color: #495057; }
        .cond-summary.error { color: #a51111; font-weight: 600; }
        .kit-short { display: block; margin-top: 4px; color: #a51111; font-size: 0.8rem; font-weight: 600; }
        .type-fixed { margin: 0 0 16px; color: #495057; font-size: 0.9rem; }
        .type-fixed span { color: #6c757d; }
        .field-help { display: block; margin-top: 6px; color: #495057; font-size: 0.8rem; line-height: 1.4; }
        .toolbar-right { display: flex; gap: 8px; }
        .search-box { display: flex; align-items: center; gap: 8px; background: white; border: 1px solid #dee2e6; border-radius: 8px; padding: 8px 12px; }
        .search-box input { border: none; outline: none; font-size: 0.9rem; min-width: 200px; }
        .search-box:focus-within { box-shadow: 0 0 0 3px rgba(34,139,230,0.35); border-color: #228be6; } /* visible focus ring */
        .filter-select { padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; background: white; min-height: 44px; }
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
        .on-order-badge { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: #dbe4ff; color: #364fc7; white-space: nowrap; }
        .min-max { font-size: 0.85rem; color: #868e96; }

        .action-btn { background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px; color: #495057; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
        .action-btn:hover { background: #e9ecef; }
        .action-btn.danger:hover { background: #ffe3e3; color: #c92a2a; }
        .action-btn .material-icons { font-size: 1.1rem; }

        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
        .modal-overlay.visible { display: flex; }
        .modal { background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; }
        .modal-lg { max-width: 700px; }
        .modal-header { padding: 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h3 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px; }
        .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
        .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
        .modal-footer { padding: 16px 20px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; }

        .form-row.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .form-row.three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 6px; }
        .form-input { width: 100%; padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; font-family: inherit; box-sizing: border-box; }
        .form-input:focus { outline: none; border-color: #228be6; box-shadow: 0 0 0 3px rgba(34,139,230,0.35); } /* visible focus ring (WCAG 2.4.7) */

        .image-upload-area { border: 2px dashed #dee2e6; border-radius: 8px; padding: 20px; text-align: center; cursor: pointer; transition: border-color 0.2s, background-color 0.2s; }
        .image-upload-area:hover { border-color: #228be6; }
        .image-upload-area:focus-visible { outline: none; border-color: #228be6; box-shadow: 0 0 0 3px rgba(34, 139, 230, 0.35); }
        .image-upload-area.dragging { border-color: #228be6; border-style: solid; background-color: #e7f5ff; }
        .image-upload-area.dragging .upload-placeholder p { color: #1971c2; font-weight: 600; }
        .image-upload-area.dragging .upload-placeholder .material-icons { color: #228be6; }
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

        .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 6px; min-height: 44px; }
        .btn-primary { background: #228be6; color: white; }
        .btn-secondary { background: #f8f9fa; color: #495057; }
        .btn-danger { background: #fa5252; color: white; }
        .btn-sm { padding: 6px 12px; font-size: 0.8rem; min-height: 44px; }
      `}</style>
    </div>
  );
}
