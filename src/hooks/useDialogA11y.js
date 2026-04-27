/**
 * RICT CMMS — useDialogA11y
 *
 * Accessibility helper for modal dialogs (WCAG 2.1 AA — SC 2.1.1, 2.4.3, 4.1.2).
 *   • Escape key closes the dialog
 *   • Focus moves into the dialog when it opens (first focusable child)
 *   • Focus returns to the previously focused element when the dialog closes
 *   • When trapFocus=true (default), Tab is constrained to within the dialog
 *
 * Usage:
 *   const dialogRef = useDialogA11y(isOpen, onClose);
 *   return isOpen && (
 *     <div className="overlay">
 *       <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="x">…</div>
 *     </div>
 *   );
 *
 * For non-modal popovers (e.g. notification bell panel) pass { trapFocus: false }.
 *
 * File: src/hooks/useDialogA11y.js
 */

import { useEffect, useRef } from 'react';

export function useDialogA11y(isOpen, onClose, { trapFocus = true } = {}) {
  const dialogRef = useRef(null);
  const priorFocusRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    // Save the element that had focus before the dialog opened, so we can restore it on close.
    priorFocusRef.current = document.activeElement;

    // After the dialog has rendered, move focus to the first focusable child.
    // setTimeout(0) lets React commit the DOM before we query for focusables.
    const focusTimer = setTimeout(() => {
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) focusables[0].focus();
      else if (typeof root.focus === 'function') root.focus();
    }, 0);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (!trapFocus || e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      // Restore focus to whatever had it before the dialog opened — but only
      // if that element is still in the DOM and focusable.
      const prior = priorFocusRef.current;
      if (prior && typeof prior.focus === 'function' && document.contains(prior)) {
        prior.focus();
      }
    };
  }, [isOpen, onClose, trapFocus]);

  return dialogRef;
}

export default useDialogA11y;
