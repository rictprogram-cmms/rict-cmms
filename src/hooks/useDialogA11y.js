/**
 * RICT CMMS — useDialogA11y
 *
 * Accessibility helper for modal dialogs (WCAG 2.1 AA — SC 2.1.1, 2.4.3, 4.1.2).
 *   • Escape key closes the dialog
 *   • Focus moves into the dialog when it opens (first focusable child)
 *   • Focus returns to the previously focused element when the dialog closes
 *   • When trapFocus=true (default), Tab is constrained to within the dialog
 *
 * Stacked / nested dialogs:
 *   The hook maintains a module-level stack of open dialogs. Escape and the Tab
 *   focus trap only fire for the dialog at the top of the stack — so opening a
 *   confirmation dialog inside a parent dialog and pressing Escape will close
 *   ONLY the confirmation, not both.
 *
 * Stable onClose NOT required:
 *   The latest onClose is held in a ref, so the main effect does NOT re-run
 *   when the parent passes a new function reference each render. This prevents
 *   focus from being yanked out of inputs (e.g. typing in a Work Log textarea
 *   while a parent detail dialog is also mounted) when the parent re-renders.
 *   Escape will still call the freshest onClose at the moment it is pressed.
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

// Module-level stack of currently-open dialogs. The element at the end of the
// array is "on top" — only it should respond to Escape and trap Tab focus.
// Each entry is a unique token object pushed by an open dialog and popped on close.
const dialogStack = [];

export function useDialogA11y(isOpen, onClose, { trapFocus = true } = {}) {
  const dialogRef = useRef(null);
  const priorFocusRef = useRef(null);

  // Latest-ref pattern for onClose. Keeps the Escape handler calling the
  // freshest function without making the main effect depend on onClose's
  // identity — see the "Stable onClose NOT required" note in the JSDoc above.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    // Save the element that had focus before the dialog opened, so we can restore it on close.
    priorFocusRef.current = document.activeElement;

    // Push a stack token so this dialog can identify itself as "top of stack".
    const token = {};
    dialogStack.push(token);

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

    const isTopOfStack = () => dialogStack[dialogStack.length - 1] === token;

    const onKey = (e) => {
      // Only the top-most dialog handles keyboard events. This lets nested
      // dialogs (e.g. a confirm dialog inside a detail dialog) behave correctly.
      if (!isTopOfStack()) return;

      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
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
      // Pop this dialog off the stack. Use indexOf rather than pop() in case the
      // close order isn't strictly LIFO (rare, but possible if state changes
      // close a parent dialog before a child).
      const idx = dialogStack.indexOf(token);
      if (idx >= 0) dialogStack.splice(idx, 1);
      // Restore focus to whatever had it before the dialog opened — but only
      // if that element is still in the DOM and focusable.
      const prior = priorFocusRef.current;
      if (prior && typeof prior.focus === 'function' && document.contains(prior)) {
        prior.focus();
      }
    };
  }, [isOpen, trapFocus]);

  return dialogRef;
}

export default useDialogA11y;
