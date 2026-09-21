import { RANK, applyReceipt } from "./receipts.mjs";

export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

export interface MediaRef {
  mediaId: string;
  /** Base64 AES-GCM key for the blob. Travels inside the encrypted envelope
   * and is stored locally only so the blob can be re-fetched or re-decrypted. */
  key: string;
  iv: string;
  mime: string;
  name?: string;
  byteSize: number;
  durationMs?: number;
  width?: number;
  height?: number;
  /** Data URL of a small thumbnail, inlined in the envelope so a preview can
   * render before the full blob is fetched. */
  thumb?: string;
}

/** No `outgoing` flag: the same ref is stored locally and sent on the wire, so
 * a boolean would be right for exactly one of the two sides. Each side derives
 * it by comparing `fromEmail` against its own address. */
export interface ReplyRef {
  id: string;
  body: string;
  fromEmail: string;
}

/** A link preview, resolved by the *sender* and carried inside the encrypted
 * envelope. The recipient renders it without contacting the site, so opening a
 * chat never tells a third party anything. `image` is a small inline data URL
 * for the same reason — a remote <img src> would be a beacon. */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  fromEmail: string;
  outgoing: boolean;
  kind: "text" | "media" | "voice" | "sticker" | "file" | "location" | "contact" | "system";
  body: string;
  media?: MediaRef;
  replyTo?: ReplyRef;
  location?: { lat: number; lon: number; accuracyM?: number };
  contact?: { email: string; username: string | null; displayName: string | null };
  link?: LinkPreview;
  sentAtMs: number;
  status: MessageStatus;
  /** Who this was addressed to, excluding the sender's own devices, captured
   * at send time. The aggregate status is derived against this set: a group
   * message is only "read" once every recipient has read it, which is what
   * the second tick turning blue has to mean. */
  recipients?: string[];
  deliveredTo?: string[];
  readBy?: string[];
  /** Emoji keyed by the member who reacted, so one person cannot stack
   * several reactions on the same message. */
  reactions?: Record<string, string>;
  deletedForEveryone?: boolean;
  /** Set when the author edited the body after sending. */
  editedAtMs?: number;
  /** Local-only bookmark; never sent. */
  starred?: boolean;
  /** Set on `system` notices, which are generated on this device and never
   * sent anywhere. */
  systemKind?: "security-code-changed" | "group-updated";
}

/** Records a local-only notice in a chat. Used for things this device
 * observed rather than received — a peer's security code changing, for
 * instance, which no message ever announces. */
export async function addSystemNotice(
  chatId: string,
  body: string,
  systemKind: NonNullable<StoredMessage["systemKind"]>
): Promise<StoredMessage> {
  const notice: StoredMessage = {
    id: crypto.randomUUID(),
    chatId,
    fromEmail: "",
    outgoing: false,
    kind: "system",
    body,
    sentAtMs: Date.now(),
    // Never unread: a notice is not a message someone is waiting on a reply to.
    status: "read",
    systemKind,
  };
  await putMessage(notice);
  return notice;
}

export interface ChatSummary {
  chatId: string;
  lastMessage: StoredMessage | null;
  unread: number;
}

const DB_NAME = "kuchupuchu-messages";
const DB_VERSION = 1;
const STORE = "messages";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("chat", ["chatId", "sentAtMs"]);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve((req ? (req as IDBRequest).result : undefined) as T);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      })
  );
}

export async function putMessage(message: StoredMessage): Promise<void> {
  await run("readwrite", (s) => s.put(message));
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  return (await run<StoredMessage | undefined>("readonly", (s) => s.get(id))) ?? null;
}

export async function messagesFor(chatId: string): Promise<StoredMessage[]> {
  const all = await run<StoredMessage[]>("readonly", (s) =>
    s.index("chat").getAll(IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]))
  );
  return all ?? [];
}

export async function allMessages(): Promise<StoredMessage[]> {
  return (await run<StoredMessage[]>("readonly", (s) => s.getAll())) ?? [];
}

/** A receipt must never downgrade a message that is already further along —
 * `delivered` can arrive after `read` when one of a person's two devices is
 * slower than the other. */
export async function advanceStatus(id: string, status: MessageStatus): Promise<StoredMessage | null> {
  const existing = await getMessage(id);
  if (!existing) return null;
  if (RANK[status] <= RANK[existing.status] && status !== "failed") return existing;
  const updated = { ...existing, status };
  await putMessage(updated);
  return updated;
}

/** Records one recipient's receipt and recomputes the aggregate. The decision
 * itself lives in receipts.mjs, which is unit tested; this is the storage half. */
export async function recordReceipt(
  id: string,
  kind: "delivered" | "read",
  byEmail: string | null
): Promise<StoredMessage | null> {
  const existing = await getMessage(id);
  if (!existing) return null;

  const updated = applyReceipt(existing, kind, byEmail);
  const unchanged =
    updated.status === existing.status &&
    updated.deliveredTo.length === (existing.deliveredTo ?? []).length &&
    updated.readBy.length === (existing.readBy ?? []).length;
  if (unchanged) return existing;

  await putMessage(updated);
  return updated;
}

export async function deleteMessage(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** Text used for search and previews: formatting markers stripped, and
 * attachments described rather than left blank. */
export function searchableText(message: StoredMessage): string {
  if (message.deletedForEveryone) return "";
  // System notices are this device's own commentary, not conversation.
  if (message.kind === "system") return "";
  const body = message.body.replace(/```|[*_~]/g, "");
  if (body) return body;
  if (message.kind === "voice") return "voice note";
  if (message.kind === "sticker") return "sticker";
  if (message.kind === "file") return message.media?.name ?? "document";
  if (message.kind === "location") return "location";
  if (message.kind === "contact") return message.contact?.username ?? "contact";
  if (message.kind === "media") return message.media?.name ?? "attachment";
  return "";
}

export interface SearchHit {
  message: StoredMessage;
  chatId: string;
}

/** Full-text search across every stored message.
 *
 * A linear scan over IndexedDB rather than an inverted index: this app's
 * history is one small group's, and an index would have to be maintained on
 * every write and rebuilt on every schema change for no measurable gain here. */
export async function searchMessages(query: string, limit = 100): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const all = await allMessages();
  const hits: SearchHit[] = [];
  for (const message of all.sort((a, b) => b.sentAtMs - a.sentAtMs)) {
    if (searchableText(message).toLowerCase().includes(needle)) {
      hits.push({ message, chatId: message.chatId });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export async function starredMessages(): Promise<StoredMessage[]> {
  const all = await allMessages();
  return all.filter((m) => m.starred).sort((a, b) => b.sentAtMs - a.sentAtMs);
}

export async function setStarred(id: string, starred: boolean): Promise<StoredMessage | null> {
  const existing = await getMessage(id);
  if (!existing) return null;
  const updated = { ...existing, starred };
  await putMessage(updated);
  return updated;
}

/** Messages this device still owes the server, oldest first. */
export async function pendingOutbox(): Promise<StoredMessage[]> {
  const all = await allMessages();
  return all
    .filter((m) => m.outgoing && (m.status === "failed" || m.status === "sending"))
    .sort((a, b) => a.sentAtMs - b.sentAtMs);
}

export async function clearChat(chatId: string): Promise<void> {
  const messages = await messagesFor(chatId);
  await Promise.all(messages.map((m) => deleteMessage(m.id)));
}

export async function summaries(): Promise<Map<string, ChatSummary>> {
  const all = await allMessages();
  const byChat = new Map<string, ChatSummary>();
  for (const message of all.sort((a, b) => a.sentAtMs - b.sentAtMs)) {
    const existing = byChat.get(message.chatId) ?? { chatId: message.chatId, lastMessage: null, unread: 0 };
    existing.lastMessage = message;
    if (!message.outgoing && message.status !== "read") existing.unread += 1;
    byChat.set(message.chatId, existing);
  }
  return byChat;
}
