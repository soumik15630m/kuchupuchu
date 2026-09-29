/** The arithmetic behind a focus trap and list navigation.
 *
 * Kept separate from the DOM because the off-by-one cases are where trapping
 * actually goes wrong: a trap that lets Tab escape on the last element is no
 * trap, and one that wraps to the wrong end sends the caret backwards.
 */

/** A selector for what a keyboard can reach.
 *
 * `[tabindex="-1"]` is excluded deliberately: it means "focusable by script,
 * not by Tab", which is exactly what a trap must not hand a Tab press to. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/** Where Tab should land, given where it is now.
 *
 * `current` is -1 when focus is somewhere outside the trap, which happens
 * after the focused element is removed -- a menu item that closed its own
 * menu, for instance. Tab then goes to the first element rather than nowhere.
 */
export function nextTrapIndex(current, total, { shift = false } = {}) {
  if (total <= 0) return -1;
  if (current < 0) return shift ? total - 1 : 0;
  if (shift) return current === 0 ? total - 1 : current - 1;
  return current === total - 1 ? 0 : current + 1;
}

/** Up/down movement through a list, which does NOT wrap.
 *
 * Different from a trap on purpose: wrapping a dialog's Tab is expected,
 * wrapping a list means holding Down jumps from the bottom back to the top,
 * which reads as the list having reset.
 */
export function nextListIndex(current, total, direction) {
  if (total <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : total - 1;
  return Math.min(total - 1, Math.max(0, current + direction));
}

/** Whether a keystroke is the "search" shortcut.
 *
 * Both Ctrl and Cmd, because the app runs on both and a Mac user pressing
 * Ctrl+K expects nothing while a Windows user pressing Cmd+K cannot.
 */
export function isSearchShortcut(event) {
  if (!event) return false;
  // Boolean(): a bare `a && b` here returns `undefined` when the modifier
  // flags are absent, and a predicate that answers undefined is one an
  // `=== false` check gets wrong.
  return Boolean(
    (event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey) && !event.altKey
  );
}

/** True when the keystroke should be left alone because the member is typing
 * into something. A global shortcut that steals a keypress from the composer
 * is worse than not having the shortcut. */
export function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}
