import type { Session } from "../api/client";
import { b64urlToBytes, sameApplicationServerKey, subscriptionKeys } from "./encoding.mjs";

/** Registering the service worker and the push subscription.
 *
 * Two separate things that are easy to conflate: the worker is what lets a
 * notification fire with no page running, and the subscription is where the
 * server sends the wake. A member can have the worker and no subscription
 * (notifications off), but never the reverse.
 */

const ENABLED_KEY = "kuchupuchu:push";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

export function pushWanted(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(ENABLED_KEY) === "on";
}

function rememberWanted(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    // Private browsing. The subscription still exists server-side for this
    // session; it just will not be re-established automatically next load.
  }
}

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // A worker that will not register is not a reason to break the app --
    // in-page notifications carry on working exactly as before.
    return null;
  }
}

/** Answers the worker's liveness ping.
 *
 * The worker asks before showing a generic notification: if this page replies,
 * it has a live delivery socket and will notify with the real sender and
 * preview itself. Without the reply the worker cannot distinguish a running
 * tab from one the browser froze hours ago.
 */
export function answerWorkerPings(): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "kuchupuchu-alive?") return;
    event.ports[0]?.postMessage({ alive: true });
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

async function subscribe(
  registration: ServiceWorkerRegistration,
  api: Session
): Promise<PushSubscription | null> {
  const { publicKey } = await api.vapidPublicKey();
  const existing = await registration.pushManager.getSubscription();

  // A subscription made with a different VAPID key is dead: the push service
  // rejects anything signed by the current one. Replacing it is the only way
  // back, and doing it silently is right -- the member did not change
  // anything, the server did.
  if (existing) {
    if (sameApplicationServerKey(existing.options?.applicationServerKey, publicKey)) return existing;
    await existing.unsubscribe();
  }

  return registration.pushManager.subscribe({
    // Required by every browser: a subscription no application server can use
    // is refused outright rather than created.
    userVisibleOnly: true,
    applicationServerKey: b64urlToBytes(publicKey),
  });
}

export async function enablePush(api: Session): Promise<"on" | "denied" | "unsupported" | "failed"> {
  if (!pushSupported()) return "unsupported";

  const permission =
    Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return "denied";

  const registration = await registerWorker();
  if (!registration) return "failed";

  try {
    // `ready` rather than the registration directly: a worker that is still
    // installing has no pushManager to subscribe with.
    const active = await navigator.serviceWorker.ready;
    const subscription = await subscribe(active, api);
    const keys = subscription && subscriptionKeys(subscription);
    if (!subscription || !keys) return "failed";

    await api.registerPush({ endpoint: subscription.endpoint, ...keys });
    rememberWanted(true);
    return "on";
  } catch {
    return "failed";
  }
}

/** Takes this device off the push list.
 *
 * `api` is nullable because sign-out also runs this, and sign-out happens on
 * an expired session too -- there the server call cannot succeed. The local
 * unsubscribe still must, so this browser stops receiving; a row the server
 * keeps will 410 on its next push and be dropped there.
 */
export async function disablePush(api: Session | null): Promise<void> {
  rememberWanted(false);
  // Server first. If the local unsubscribe succeeded and this did not, the
  // server would hold an endpoint it has been told to forget and the member
  // would have no way left to ask again.
  try {
    await api?.unregisterPush();
  } catch {
    // Already gone, or unreachable; the local unsubscribe below still runs.
  }
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

/** Re-establishes the subscription on load for a member who wants it.
 *
 * Needed because a browser can retire a subscription on its own -- after a
 * permission reset, a profile move, or the push service rotating its URLs --
 * and nothing tells the page. Without this the member keeps the setting
 * switched on and silently stops being reachable.
 */
export async function syncPush(api: Session): Promise<void> {
  if (!pushWanted() || !pushSupported()) return;
  if (Notification.permission !== "granted") return;
  await enablePush(api);
}
