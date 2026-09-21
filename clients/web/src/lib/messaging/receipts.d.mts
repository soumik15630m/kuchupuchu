import type { MessageStatus, StoredMessage } from "./store";

export const RANK: Record<MessageStatus, number>;

export function aggregateStatus(
  message: Pick<StoredMessage, "status" | "recipients" | "deliveredTo" | "readBy">
): MessageStatus;

export function applyReceipt<T extends Pick<StoredMessage, "status" | "recipients" | "deliveredTo" | "readBy">>(
  message: T,
  kind: "delivered" | "read",
  byEmail: string | null
): T & { deliveredTo: string[]; readBy: string[]; status: MessageStatus };
