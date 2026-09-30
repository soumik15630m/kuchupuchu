import type { MediaRef } from "./store";
import { openStore } from "../idb";
import { deleteCachedMedia } from "./media-cache";

/** §10.5-adjacent: a status post is an ordinary encrypted message fanned out to
 * every member, kept in its own store and expired locally after 24h. It needs
 * no server surface of its own — the media blob rides the existing encrypted
 * upload, and the 24h window is enforced here rather than by retention, which
 * is a longer 7 days. */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

export interface StatusPost {
  id: string;
  authorEmail: string;
  outgoing: boolean;
  /** Caption for media, or the whole post for a text status. */
  body: string;
  media?: MediaRef;
  /** Background for a text-only status, so it reads as a card not a bubble. */
  background?: string;
  postedAtMs: number;
  viewed: boolean;
  /** Emails that told us they viewed it. Only meaningful on our own posts. */
  viewedBy: string[];
}

const DB_NAME = "kuchupuchu-status";
const DB_VERSION = 1;
const STORE = "posts";

function openDb(): Promise<IDBDatabase> {
  return openStore(DB_NAME, DB_VERSION, STORE, (db) => {
    if (db.objectStoreNames.contains(STORE)) return;
    db.createObjectStore(STORE, { keyPath: "id" });
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve((req ? (req as IDBRequest).result : undefined) as T);
        t.onerror = () => reject(t.error);
      })
  );
}

export async function putStatus(post: StatusPost): Promise<void> {
  await run("readwrite", (s) => s.put(post));
}

export async function getStatus(id: string): Promise<StatusPost | null> {
  return (await run<StatusPost | undefined>("readonly", (s) => s.get(id))) ?? null;
}

export async function deleteStatus(id: string): Promise<void> {
  // The blob goes with the record. Deleting only the post left the decrypted
  // photo sitting in the media cache forever, which makes "disappears after
  // 24 hours" false in the one way that matters -- the bytes are still there.
  const post = await getStatus(id);
  if (post?.media) await deleteCachedMedia(post.media.mediaId);
  await run("readwrite", (s) => s.delete(id));
}

/** Expired posts are dropped on read rather than by a timer — there is no
 * moment a background sweep would catch that opening the screen does not. */
export async function liveStatuses(): Promise<StatusPost[]> {
  const all = (await run<StatusPost[]>("readonly", (s) => s.getAll())) ?? [];
  const cutoff = Date.now() - STATUS_TTL_MS;
  const expired = all.filter((p) => p.postedAtMs < cutoff);
  await Promise.all(expired.map((p) => deleteStatus(p.id)));
  return all.filter((p) => p.postedAtMs >= cutoff).sort((a, b) => b.postedAtMs - a.postedAtMs);
}

export interface StatusReel {
  authorEmail: string;
  outgoing: boolean;
  posts: StatusPost[];
  unseen: number;
}

/** Grouped per author, newest author first, which is the order the status list
 * shows them in. */
export async function statusReels(): Promise<StatusReel[]> {
  const posts = await liveStatuses();
  const byAuthor = new Map<string, StatusReel>();
  for (const post of posts) {
    const reel =
      byAuthor.get(post.authorEmail) ??
      { authorEmail: post.authorEmail, outgoing: post.outgoing, posts: [], unseen: 0 };
    reel.posts.push(post);
    if (!post.viewed && !post.outgoing) reel.unseen += 1;
    byAuthor.set(post.authorEmail, reel);
  }
  for (const reel of byAuthor.values()) {
    reel.posts.sort((a, b) => a.postedAtMs - b.postedAtMs);
  }
  return [...byAuthor.values()];
}

export async function markViewed(id: string): Promise<StatusPost | null> {
  const post = await getStatus(id);
  if (!post || post.viewed) return post;
  const updated = { ...post, viewed: true };
  await putStatus(updated);
  return updated;
}

export async function recordViewer(id: string, email: string): Promise<StatusPost | null> {
  const post = await getStatus(id);
  if (!post) return null;
  if (post.viewedBy.includes(email)) return post;
  const updated = { ...post, viewedBy: [...post.viewedBy, email] };
  await putStatus(updated);
  return updated;
}
