export interface SwipeState {
  startX: number;
  startY: number;
  offset: number;
  claimed: boolean;
  rejected: boolean;
}

export const TRIGGER_PX: number;
export const MAX_PX: number;

export function beginSwipe(x: number, y: number): SwipeState;
export function moveSwipe(state: SwipeState, x: number, y: number): SwipeState;
export function shouldReply(state: SwipeState): boolean;
