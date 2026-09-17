import type { StoredMessage } from "./messaging/store";

const ENABLED_KEY = "kuchupuchu:notifications";

/** Web notifications only, deliberately not Web Push. Push would need the
 * wake service (§10.2) and a VAPID key pair that do not exist yet, and would
 * route message metadata through a third-party push endpoint. This fires only
 * while the page is open, which is the honest limit of what the web client can
 * do today. */
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
  if (message.kind === "voice") return "🎤 Voice note";
  if (message.kind === "media") return "📎 Attachment";
  return message.body;
}

/** Suppressed while the tab is visible — a notification for a message the
 * person is already looking at is just noise. */
export function notifyMessage(message: StoredMessage, displayName: string): void {
  if (message.outgoing) return;
  if (document.visibilityState === "visible") return;
  if (!notificationsAllowed()) return;

  try {
    const notification = new Notification(displayName, {
      body: preview(message),
      icon: "/icon.svg",
      // Collapses repeat notifications from one chat into a single entry
      // rather than stacking one per message.
      tag: `chat:${message.chatId}`,
      renotify: true,
    } as NotificationOptions);

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
