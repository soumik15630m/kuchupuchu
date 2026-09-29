import { isMuted, settingsFor } from "./messaging/chat-settings";
import { describeMessage, type StoredMessage } from "./messaging/store";

const ENABLED_KEY = "kuchupuchu:notifications";

/** In-page notifications, for a tab that is open but not looked at.
 *
 * These are the rich ones: they name the sender and preview the message,
 * because the page has already decrypted it. A closed or frozen tab is
 * wake-service's job (§10.2, `lib/push/register.ts`), and what it can show is
 * deliberately much less -- the push payload carries no sender and no
 * content, so the worker says only "New message" until the app is open.
 *
 * The two never fire together: the worker pings the page first and stays
 * quiet if anything answers. */
export function notificationsAllowed(): boolean {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  return localStorage.getItem(ENABLED_KEY) !== "off";
}

export function notificationsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== "off";
}

export function setNotificationsEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export function preview(message: StoredMessage): string {
  return describeMessage(message);
}

/** Suppressed while the tab is visible — a notification for a message the
 * person is already looking at is just noise. */
export function notifyMessage(
  message: StoredMessage,
  displayName: string,
  options: { mentionsYou?: boolean } = {}
): void {
  if (message.outgoing) return;
  // Generated locally for things this device observed; nobody sent them, and
  // an OS notification for "the security code changed" is startling noise.
  if (message.kind === "system") return;
  if (document.visibilityState === "visible") return;
  if (!notificationsAllowed()) return;
  // Muting a chat used to hide the unread pill and nothing else -- the
  // notification and the OS badge both ignored it.
  // A mention cuts through mute. Muting a busy group is how people cope with
  // it; being unreachable in it is a different thing they did not ask for.
  if (!options.mentionsYou && isMuted(settingsFor(message.chatId))) return;

  try {
    const notification = new Notification(
      options.mentionsYou ? `${displayName} — mentioned you` : displayName,
      {
        body: preview(message),
        icon: "/icon.svg",
        // Collapses repeat notifications from one chat into a single entry
        // rather than stacking one per message.
        tag: `chat:${message.chatId}`,
        renotify: true,
      } as NotificationOptions
    );

    notification.onclick = () => {
      window.focus();
      location.href = `/chats/${encodeURIComponent(message.chatId)}`;
      notification.close();
    };
  } catch {
    // Some browsers refuse construction outside a service worker on mobile.
  }
}

/** Mirrors the unread count onto the app icon where the platform supports it. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    // Unsupported; the in-app unread pills still show.
  }
}
