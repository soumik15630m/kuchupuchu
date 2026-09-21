export interface GuardState {
  revealed: boolean;
  focused: boolean;
  visible: boolean;
  capturedAtMs: number | null;
}

export type GuardEvent =
  | { type: "blur" }
  | { type: "focus" }
  | { type: "visibility"; visible: boolean }
  | { type: "capture" }
  | { type: "reveal" };

export const CONCEAL_GRACE_MS: number;

export function isCaptureShortcut(event: KeyboardEvent | null): boolean;
export function initialGuardState(): GuardState;
export function applyGuardEvent(state: GuardState, event: GuardEvent, nowMs: number): GuardState;
export function shouldConceal(state: GuardState, nowMs: number): boolean;
export function concealReason(state: GuardState): "capture" | "away" | "held" | null;
