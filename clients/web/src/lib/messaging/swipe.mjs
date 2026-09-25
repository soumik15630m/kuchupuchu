/** Swipe-to-reply gesture arithmetic.
 *
 * Pure because a gesture is easy to get subtly wrong and impossible to test
 * by hand: the rules about when a horizontal drag stops being a vertical
 * scroll, and how far it may travel, are the whole feature.
 */

/** Past this the gesture is a reply, not a nudge. */
export const TRIGGER_PX = 56;

/** The bubble stops moving here, so a long drag does not fling it away. */
export const MAX_PX = 78;

/** Below this, a touch is a tap or the start of a scroll -- claiming it as a
 * swipe would make the message list feel stuck. */
const SLOP_PX = 10;

/** Horizontal movement must beat vertical by this factor before the gesture
 * is treated as a swipe at all. */
const DIRECTION_RATIO = 1.6;

export function beginSwipe(x, y) {
  return { startX: x, startY: y, offset: 0, claimed: false, rejected: false };
}

/**
 * @returns the next state; `claimed` means the caller should preventDefault.
 */
export function moveSwipe(state, x, y) {
  if (state.rejected) return state;

  const dx = x - state.startX;
  const dy = y - state.startY;

  if (!state.claimed) {
    if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return state;
    // Vertical wins ties: scrolling is the common intent, and stealing it
    // would be far more annoying than missing a swipe.
    if (Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) {
      return { ...state, rejected: true, offset: 0 };
    }
    // Reply swipes are right-to-left only, matching the bubble's reply arrow.
    if (dx >= 0) return { ...state, rejected: true, offset: 0 };
    return { ...state, claimed: true, offset: clamp(dx) };
  }

  return { ...state, offset: clamp(dx) };
}

export function shouldReply(state) {
  return state.claimed && Math.abs(state.offset) >= TRIGGER_PX;
}

function clamp(dx) {
  if (dx > 0) return 0;
  return Math.max(dx, -MAX_PX);
}
