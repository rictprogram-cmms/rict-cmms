/**
 * RICT CMMS — StatusSelect
 *
 * Accessible status dropdown with color swatches.
 *
 * Implements the W3C ARIA Authoring Practices "combobox-with-listbox" pattern:
 *   - Button has role="combobox", aria-expanded, aria-controls, aria-activedescendant
 *   - Listbox has role="listbox" with role="option" children carrying aria-selected
 *   - Focus stays on the button; the highlighted option is conveyed via aria-activedescendant
 *
 * Keyboard support:
 *   - Arrow Up/Down to navigate (or open if closed)
 *   - Home/End to jump to first/last option
 *   - Enter or Space to select
 *   - Escape to close
 *   - Tab to close (focus advances naturally)
 *   - Letter keys for type-ahead
 *
 * File: src/components/StatusSelect.jsx
 */

import React from 'react';

export default function StatusSelect({
  statuses: statusList,
  value,
  onChange,
  id,
  className,
  style,
  placeholder,
  allOption,
  colorMap,
}) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const wrapperRef = React.useRef(null);
  const buttonRef = React.useRef(null);
  // Stable id for ARIA wiring; survives re-renders without growing.
  const idRef = React.useRef(null);
  if (idRef.current === null) {
    idRef.current = `status-listbox-${Math.random().toString(36).slice(2, 9)}`;
  }
  const listboxId = idRef.current;

  // Build an options array; "all" option (when applicable) is the first entry.
  const options = React.useMemo(() => {
    const arr = [];
    if (allOption) arr.push({ key: '__all', label: allOption, value: '', isAll: true });
    (statusList || []).forEach(s => arr.push({ key: s.status_name, label: s.status_name, value: s.status_name }));
    return arr;
  }, [statusList, allOption]);

  const selectedColor = value ? (colorMap[value] || '#adb5bd') : null;
  const displayLabel = value || allOption || placeholder || 'Select status...';

  // When opening, point activeIndex at the current value (so keyboard nav starts there).
  React.useEffect(() => {
    if (open) {
      const cur = options.findIndex(o => o.value === value);
      setActiveIndex(cur >= 0 ? cur : 0);
    } else {
      setActiveIndex(-1);
    }
    // We deliberately do not depend on `options` or `value` here — opening should
    // snapshot the active index once. Mouse hover and arrow keys move it from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click
  React.useEffect(() => {
    const handler = (e) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false); };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectAt = (idx) => {
    if (idx < 0 || idx >= options.length) return;
    onChange(options[idx].value);
    setOpen(false);
    // Return focus to the button — combobox pattern keeps focus on the trigger.
    buttonRef.current?.focus();
  };

  const onKeyDown = (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { setOpen(true); break; }
        setActiveIndex(i => (i < 0 ? 0 : Math.min(options.length - 1, i + 1)));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { setOpen(true); break; }
        setActiveIndex(i => (i < 0 ? options.length - 1 : Math.max(0, i - 1)));
        break;
      case 'Home':
        if (open) { e.preventDefault(); setActiveIndex(0); }
        break;
      case 'End':
        if (open) { e.preventDefault(); setActiveIndex(options.length - 1); }
        break;
      case 'Enter':
        e.preventDefault();
        if (!open) { setOpen(true); break; }
        if (activeIndex >= 0) selectAt(activeIndex);
        break;
      case ' ':
        // Space: open if closed, otherwise select (matches native <select>)
        e.preventDefault();
        if (!open) { setOpen(true); break; }
        if (activeIndex >= 0) selectAt(activeIndex);
        break;
      case 'Escape':
        if (open) { e.preventDefault(); setOpen(false); }
        break;
      case 'Tab':
        // Allow natural focus advance; just close the listbox.
        if (open) setOpen(false);
        break;
      default:
        // Type-ahead: jump to the next option whose label starts with the typed character.
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const letter = e.key.toLowerCase();
          if (!open) setOpen(true);
          const startFrom = activeIndex >= 0 ? activeIndex + 1 : 0;
          const reordered = [...options.slice(startFrom), ...options.slice(0, startFrom)];
          const hitWithin = reordered.findIndex(o => (o.label || '').toLowerCase().startsWith(letter));
          if (hitWithin >= 0) {
            setActiveIndex((startFrom + hitWithin) % options.length);
          }
        }
        break;
    }
  };

  const optionId = (idx) => `${listboxId}-opt-${idx}`;

  return (
    <div ref={wrapperRef} className="status-select-wrapper" style={{ position: 'relative', ...style }}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        className={className || 'form-input form-input-sm'}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={!id && placeholder ? placeholder : undefined}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left', width: '100%', background: '#fff' }}
      >
        {selectedColor && (
          <span
            className="status-dot"
            aria-hidden="true"
            style={{ width: 10, height: 10, borderRadius: '50%', background: selectedColor, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }}
          />
        )}
        <span style={{ flex: 1, color: value ? '#1a1a2e' : '#868e96' }}>{displayLabel}</span>
        <span className="material-icons" aria-hidden="true" style={{ fontSize: 16, color: '#868e96' }}>{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={placeholder || allOption || 'Status options'}
          className="status-dropdown"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
            background: '#fff', border: '1px solid #dee2e6', borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)', zIndex: 100, overflow: 'hidden',
            minWidth: 180,
            listStyle: 'none', padding: 0,
          }}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isActive = idx === activeIndex;
            const swatch = opt.isAll
              ? 'linear-gradient(135deg, #228be6, #40c057, #fab005)'
              : (colorMap[opt.value] || '#adb5bd');
            return (
              <li
                key={opt.key}
                id={optionId(idx)}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => selectAt(idx)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  cursor: 'pointer', fontSize: '0.85rem',
                  background: isActive ? '#f0f4ff' : 'transparent',
                  fontWeight: isSelected ? 600 : 400,
                  borderBottom: opt.isAll ? '1px solid #f1f3f5' : 'none',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 12, height: 12, borderRadius: '50%', background: swatch, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }}
                />
                <span style={{ flex: 1, color: opt.isAll ? '#495057' : '#1a1a2e' }}>{opt.label}</span>
                {isSelected && <span className="material-icons" aria-hidden="true" style={{ fontSize: 16, color: '#228be6' }}>check</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
