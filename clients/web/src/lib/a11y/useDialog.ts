"use client";

import { useEffect, useRef } from "react";

import { FOCUSABLE_SELECTOR, nextTrapIndex } from "./focus.mjs";

/** Makes a `role="dialog"` behave like one.
 *
 * Three things, all of which were missing across the app's nine dialogs and
 * only two of which are obvious:
 *
 *   * Escape closes it. Most of them could only be dismissed by clicking a
 *     backdrop, which a keyboard cannot do.
 *   * Tab stays inside. Without this, Tab walks straight out of an open sheet
 *     into the chat behind it, where the focus ring is invisible because the
 *     backdrop covers it -- so the member is typing into something they
 *     cannot see.
 *   * Focus returns where it came from on close. Otherwise it falls back to
 *     the document body and the next Tab restarts from the top of the page.
 */
export function useDialog(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  { autoFocus = true }: { autoFocus?: boolean } = {}
): void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const node = ref.current;

    if (autoFocus && node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      // The panel itself when it holds nothing focusable, so a screen reader
      // reads the dialog rather than staying on whatever is behind it.
      (first ?? node).focus?.();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const current = ref.current;
      if (!current) return;
      const focusable = [...current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        // Queried fresh on every Tab: a dialog whose contents change -- a
        // search result list, a picker tab -- would otherwise trap against a
        // stale set.
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusable.length === 0) return;

      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const next = nextTrapIndex(at, focusable.length, { shift: event.shiftKey });
      event.preventDefault();
      focusable[next]?.focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Only if focus is still inside what is closing; if something else
      // took it in the meantime, yanking it back is the wrong move.
      const inside = ref.current?.contains(document.activeElement);
      if (inside !== false) restoreTo.current?.focus?.();
    };
  }, [ref, onClose, autoFocus]);
}
