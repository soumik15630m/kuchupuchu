"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { Session, clearSession, storedEmail, storedRefreshToken, type Tokens } from "../api/client";
import { disablePush } from "../push/register";
import { noteLocalOwner } from "./local-data";

type Status = "loading" | "authenticated" | "anonymous";

interface SessionContextValue {
  status: Status;
  email: string | null;
  session: Session | null;
  signIn: (email: string, tokens: Tokens) => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [, forceRender] = useState(0);

  const signOut = useCallback(() => {
    // Before the tokens go, and not awaited: a device that has been signed
    // out must stop being woken, and leaving the subscription behind would
    // buzz whoever holds this browser next. A failed call self-heals -- the
    // next push to a dead endpoint 410s and wake-service drops the row.
    void disablePush(sessionRef.current);
    clearSession();
    sessionRef.current = null;
    setEmail(null);
    setStatus("anonymous");
    forceRender((n) => n + 1);
    router.replace("/login");
  }, [router]);

  useEffect(() => {
    const stored = storedEmail();
    if (!stored || !storedRefreshToken()) {
      setStatus("anonymous");
      return;
    }
    // Stamps ownership on an install that predates the owner key, so the next
    // sign-in does not read its data as unowned and wipe it.
    noteLocalOwner(stored);
    sessionRef.current = new Session(stored, signOut);
    setEmail(stored);
    setStatus("authenticated");
    forceRender((n) => n + 1);
  }, [signOut]);

  const signIn = useCallback(
    (nextEmail: string, tokens: Tokens) => {
      const session = new Session(nextEmail, signOut);
      session.adopt(tokens);
      sessionRef.current = session;
      setEmail(nextEmail);
      setStatus("authenticated");
      forceRender((n) => n + 1);
    },
    [signOut]
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, email, session: sessionRef.current, signIn, signOut }),
    // sessionRef is mutated rather than reassigned through state; the counter
    // is what makes a consumer re-read it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, email, signIn, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
