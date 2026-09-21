const KEY = "kuchupuchu:groups";

export interface Group {
  id: string;
  name: string;
  /** Every member's email, including the local user. */
  members: string[];
  /** Who may edit the group. The creator is always one; without this any
   * member could remove anyone else. */
  admins: string[];
  description?: string;
  /** Encrypted blob reference for the group photo, shared with the members. */
  avatar?: {
    mediaId: string;
    key: string;
    iv: string;
    mime: string;
    byteSize: number;
    thumb?: string;
  };
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
  admins?: string[];
  description?: string;
  avatar?: Group["avatar"];
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
    admins: [createdBy.toLowerCase()],
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
    // An older peer that does not send admins would otherwise wipe them, so
    // the existing set is kept when the ref omits it.
    admins: ref.admins
      ? [...new Set(ref.admins.map((a) => a.toLowerCase()))].sort()
      : existing?.admins ?? [fallbackCreator.toLowerCase()],
    description: ref.description ?? existing?.description,
    avatar: ref.avatar ?? existing?.avatar,
    createdBy: existing?.createdBy ?? fallbackCreator.toLowerCase(),
    createdAtMs: existing?.createdAtMs ?? Date.now(),
    revision: ref.revision,
  };
  saveGroup(merged);
  return merged;
}

export function toRef(group: Group): GroupRef {
  return {
    id: group.id,
    name: group.name,
    members: group.members,
    admins: group.admins,
    description: group.description,
    avatar: group.avatar,
    revision: group.revision,
  };
}

export function isAdmin(group: Group, email: string): boolean {
  // An older group with no admin list falls back to its creator, so a group
  // created before admins existed is still editable by someone.
  const admins = group.admins?.length ? group.admins : [group.createdBy];
  return admins.includes(email.toLowerCase());
}

/** Applies an edit locally and bumps the revision so peers accept it. */
export function editGroup(group: Group, changes: Partial<Group>): Group {
  const next: Group = {
    ...group,
    ...changes,
    members: changes.members
      ? [...new Set(changes.members.map((m) => m.toLowerCase()))].sort()
      : group.members,
    admins: changes.admins
      ? [...new Set(changes.admins.map((a) => a.toLowerCase()))].sort()
      : group.admins,
    revision: group.revision + 1,
  };
  saveGroup(next);
  return next;
}

export function isGroupId(chatId: string): boolean {
  return chatId.startsWith("group-");
}
