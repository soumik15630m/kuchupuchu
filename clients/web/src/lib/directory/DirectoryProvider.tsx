"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { Member } from "../api/client";
import { useSession } from "../auth/SessionProvider";

const CACHE_KEY = "kuchupuchu:directory";

interface DirectoryContextValue {
  members: Member[];
  me: Member | null;
  /** Everyone except the signed-in user. */
  others: Member[];
  loading: boolean;
  memberFor: (email: string) => Member | null;
  nameFor: (email: string) => string;
  refresh: () => Promise<void>;
}

const DirectoryContext = createContext<DirectoryContextValue | null>(null);

function readCache(): Member[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as Member[]) : [];
  } catch {
    return [];
  }
}

function writeCache(members: Member[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(members));
  } catch {
    // Quota; the directory is re-fetched on next start anyway.
  }
}

/** The member list, fetched once per session and cached.
 *
 * This replaces a locally-typed contact list: the allowlist is fixed and small
 * (§1), so the server already knows every member and there is nothing to
 * discover. The cache exists so names still render while offline, not as the
 * source of truth. */
export function DirectoryProvider({ children }: { children: React.ReactNode }) {
  const { status, session, email } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setMembers(readCache());
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const { members: fetched } = await session.directory();
      setMembers(fetched);
      writeCache(fetched);
    } catch {
      // Offline or the token lapsed; the cached list stays usable.
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (status !== "authenticated") {
      setLoading(false);
      return;
    }
    void refresh();
  }, [status, refresh]);

  const memberFor = useCallback(
    (target: string) => members.find((m) => m.email === target) ?? null,
    [members]
  );

  /** Display name, then username, then the email — never an empty label. */
  const nameFor = useCallback(
    (target: string) => {
      const member = memberFor(target);
      return member?.displayName || member?.username || target;
    },
    [memberFor]
  );

  const me = useMemo(() => members.find((m) => m.email === email) ?? null, [members, email]);
  const others = useMemo(() => members.filter((m) => m.email !== email), [members, email]);

  const value = useMemo<DirectoryContextValue>(
    () => ({ members, me, others, loading, memberFor, nameFor, refresh }),
    [members, me, others, loading, memberFor, nameFor, refresh]
  );

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>;
}

export function useDirectory(): DirectoryContextValue {
  const ctx = useContext(DirectoryContext);
  if (!ctx) throw new Error("useDirectory must be used inside DirectoryProvider");
  return ctx;
}

/** Initials for an avatar, from whatever label is available. */
export function initialsFor(label: string): string {
  const parts = label.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
