/* Background wake-up for a closed or sleeping tab.
 *
 * This worker exists for one reason: without it, notifications only fire
 * while the page is open, because `new Notification()` from a page needs the
 * page to be running. A push arrives whether or not anything is.
 *
 * What it deliberately does NOT do:
 *
 *   * It does not decrypt. The Double Ratchet state lives in IndexedDB and is
 *     advanced by the page; advancing it here as well would give two writers
 *     to one ratchet, and a ratchet with two writers desynchronises. The
 *     notification says "New message" and the app fills in who and what once
 *     it is open.
 *   * It does not cache. Offline browsing of an encrypted history is a real
 *     feature and a separate one; a half-built cache that serves a stale
 *     shell is worse than no cache.
 *
 * The payload is `{v, r}` and nothing else -- no sender, no chat, no preview.
 * See services/wake-service/README.md for why.
 */

const PING_TIMEOUT_MS = 1500;

self.addEventListener("install", () => {
  // No cache to warm, so there is nothing to wait for. Activating straight
  // away means a member who just enabled notifications gets them now rather
  // than after every tab is closed.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Is a page actually running and able to notify for itself?
 *
 * Asking rather than assuming: `clients.matchAll` still lists a tab the
 * browser has frozen, whose delivery socket is closed and which will not
 * notify anyone. Treating that as "the page has it covered" is exactly the
 * silence this worker exists to fix, so liveness is tested, not inferred.
 */
function pingClient(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      client.postMessage({ type: "kuchupuchu-alive?" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function aPageIsAwake() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.length === 0) return false;
  const replies = await Promise.all(windows.map(pingClient));
  return replies.some(Boolean);
}

function readReason(event) {
  try {
    const data = event.data ? event.data.json() : null;
    return data && typeof data.r === "string" ? data.r : "message";
  } catch {
    // A payload this worker cannot parse is still a wake -- something
    // arrived. Falling back beats showing nothing.
    return "message";
  }
}

const NOTICES = {
  message: {
    title: "New message",
    body: "Open Kuchupuchu to read it.",
    tag: "kuchupuchu-message",
    requireInteraction: false,
  },
  call: {
    title: "Incoming call",
    body: "Open Kuchupuchu to answer.",
    tag: "kuchupuchu-call",
    // A ring that vanishes on its own is a missed call.
    requireInteraction: true,
  },
  "device-list": {
    title: "A device was added or removed",
    body: "Open Kuchupuchu to review your linked devices.",
    tag: "kuchupuchu-devices",
    requireInteraction: false,
  },
};

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      if (await aPageIsAwake()) return;

      const notice = NOTICES[readReason(event)] ?? NOTICES.message;
      await self.registration.showNotification(notice.title, {
        body: notice.body,
        icon: "/icon.svg",
        badge: "/icon.svg",
        // Collapses repeats: thirty missed messages are one thing to come
        // back to, not thirty.
        tag: notice.tag,
        renotify: true,
        requireInteraction: notice.requireInteraction,
        data: { url: "/chats" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/chats";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          // Focus the tab that already exists rather than opening a second
          // one -- two tabs of an app holding a ratchet is worth avoiding.
          await client.focus();
          if ("navigate" in client) await client.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
