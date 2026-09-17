export interface Message {
  id: string;
  chatId: string;
  body: string;
  outgoing: boolean;
  sentAtMs: number;
}

/** Local-only until services/messaging-service exists. Deliberately a separate
 * module so swapping the backing store for the real transport does not touch
 * the chat UI. */
function key(chatId: string): string {
  return `kuchupuchu:messages:${chatId}`;
}

export function loadMessages(chatId: string): Message[] {
  try {
    const raw = localStorage.getItem(key(chatId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}

export function appendMessage(chatId: string, body: string, outgoing: boolean): Message {
  const message: Message = {
    id: crypto.randomUUID(),
    chatId,
    body,
    outgoing,
    sentAtMs: Date.now(),
  };
  const next = [...loadMessages(chatId), message];
  try {
    localStorage.setItem(key(chatId), JSON.stringify(next));
  } catch {
    // Quota. The message still shows for this session.
  }
  return message;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
