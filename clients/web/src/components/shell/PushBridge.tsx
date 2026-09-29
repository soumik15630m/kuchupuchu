"use client";

import { useEffect } from "react";

import { useSession } from "@/lib/auth/SessionProvider";
import { answerWorkerPings, registerWorker, syncPush } from "@/lib/push/register";

/** Mount point for the service worker. Renders nothing.
 *
 * Two jobs, both of which have to happen on every load rather than only when
 * the member changes the setting:
 *
 *   * answer the worker's liveness ping, so a running tab notifies with the
 *     real sender and the worker stays quiet;
 *   * re-establish the push subscription, because a browser can retire one on
 *     its own and nothing tells the page — without this the member keeps the
 *     setting switched on and silently stops being reachable.
 */
export function PushBridge() {
  const { session, status } = useSession();

  useEffect(() => answerWorkerPings(), []);

  useEffect(() => {
    if (status !== "authenticated" || !session) return;
    // Registered even with notifications off: the worker is what makes the
    // subscription possible later, and registering it is not itself
    // observable to the member.
    void registerWorker().then(() => syncPush(session));
  }, [session, status]);

  return null;
}
