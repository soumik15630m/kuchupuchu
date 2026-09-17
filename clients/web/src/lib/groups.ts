const KEY = "kuchupuchu:groups";

export interface Group {
  id: string;
  name: string;
  /** Every member's email, including the local user. */
  members: string[];
  createdBy: string;
  createdAtMs: number;
  /** Bumped by whoever edits the group; a lower revision loses, so two edits
   * cannot flip the roster back and forth forever. */
  revision: number;
}

/** Metadata carried inside every group message, so a recipient learns the group
 * from the first message rather than needing a separate invite protocol. The
 * server never sees it — it is inside the ciphertext. */
export interface GroupRef {
  id: string;
  name: string;
  members: string[];
  revision: number;
}

function readAll(): Group[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Group[]) : [];
  } catch {
    return [];
  }
}

function writeAll(groups: Group[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(groups));
  } catch {
    // Quota or private browsing; the group still works for this session.
  }
}

export function loadGroups(): Group[] {
  return readAll();
}

export function getGroup(id: string): Group | null {
  return readAll().find((g) => g.id === id) ?? null;
}

export function createGroup(name: string, members: string[], createdBy: string): Group {
  const group: Group = {
    id: `group-${crypto.randomUUID()}`,
    name: name.trim() || "Group",
    members: [...new Set([...members.map((m) => m.toLowerCase()), createdBy.toLowerCase()])].sort(),
    createdBy: createdBy.toLowerCase(),
    createdAtMs: Date.now(),
    revision: 1,
  };
  writeAll([...readAll(), group]);
  return group;
}

export function saveGroup(group: Group): void {
  const rest = readAll().filter((g) => g.id !== group.id);
  writeAll([...rest, group]);
}

export function deleteGroup(id: string): void {
  writeAll(readAll().filter((g) => g.id !== id));
}

/** Merges the metadata on an inbound message. A stale copy must not undo a
 * newer edit, so a lower revision is ignored rather than applied. */
export function upsertFromRef(ref: GroupRef, fallbackCreator: string): Group {
  const existing = getGroup(ref.id);
  if (existing && existing.revision >= ref.revision) return existing;

  const merged: Group = {
    id: ref.id,
    name: ref.name,
    members: [...new Set(ref.members.map((m) => m.toLowerCase()))].sort(),
    createdBy: existing?.createdBy ?? fallbackCreator.toLowerCase(),
    createdAtMs: existing?.createdAtMs ?? Date.now(),
    revision: ref.revision,
  };
  saveGroup(merged);
  return merged;
}

export function toRef(group: Group): GroupRef {
  return { id: group.id, name: group.name, members: group.members, revision: group.revision };
}

export function isGroupId(chatId: string): boolean {
  return chatId.startsWith("group-");
}
