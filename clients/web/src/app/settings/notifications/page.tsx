"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { useSession } from "@/lib/auth/SessionProvider";
import {
  notificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "@/lib/notifications";
import { disablePush, enablePush, pushSupported, pushWanted } from "@/lib/push/register";

import themeStyles from "@/app/settings/theme/theme.module.css";

type BackgroundState = "on" | "off" | "unsupported" | "working" | "failed";

export default function NotificationsPage() {
  const { session } = useSession();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [enabled, setEnabled] = useState(true);
  const [background, setBackground] = useState<BackgroundState>("off");

  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    setEnabled(notificationsEnabled());
    if (!pushSupported()) setBackground("unsupported");
    else setBackground(pushWanted() ? "on" : "off");
  }, []);

  useEffect(() => {
    if (!session || background !== "on") return;
    // The browser can retire a subscription without telling the page. Asking
    // the server what it actually holds is the only way the row can say
    // something true rather than echoing a local flag.
    let cancelled = false;
    session
      .pushStatus()
      .then((status) => {
        if (!cancelled && !status.subscribed) setBackground("off");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, background]);

  async function enable() {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      setNotificationsEnabled(true);
      setEnabled(true);
    }
  }

  const toggleBackground = useCallback(
    async (on: boolean) => {
      if (!session) return;
      setBackground("working");
      if (!on) {
        await disablePush(session);
        setBackground("off");
        return;
      }
      const result = await enablePush(session);
      if (result === "on") {
        // Background notifications are useless with the in-page ones off --
        // the setting they share is "tell me when a message arrives".
        setNotificationsEnabled(true);
        setEnabled(true);
        setPermission("granted");
      }
      setBackground(result === "on" ? "on" : result === "unsupported" ? "unsupported" : "failed");
      if (result === "denied") setPermission("denied");
    },
    [session]
  );

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="Notifications" backHref="/settings" />
        <PaneScroll>
          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Message notifications</h2>

            {permission === "unsupported" && (
              <p className={themeStyles.hint}>This browser doesn&apos;t support notifications.</p>
            )}

            {permission === "denied" && (
              <p className={themeStyles.hint}>
                Notifications are blocked for this site. Allow them in your browser&apos;s site
                settings, then come back.
              </p>
            )}

            {permission === "default" && (
              <>
                <p className={themeStyles.hint}>
                  Get notified when a message arrives while you&apos;re looking at another tab.
                </p>
                <button className={themeStyles.reset} type="button" onClick={enable}>
                  Turn on notifications
                </button>
              </>
            )}

            {permission === "granted" && (
              <div className={themeStyles.options} role="radiogroup" aria-label="Message notifications">
                {[
                  { on: true, label: "On" },
                  { on: false, label: "Off" },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={enabled === option.on}
                    className={themeStyles.radio}
                    onClick={() => {
                      setNotificationsEnabled(option.on);
                      setEnabled(option.on);
                    }}
                  >
                    <span className={themeStyles.radioMark} />
                    <span className={themeStyles.radioLabel}>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>When the app is closed</h2>

            {background === "unsupported" ? (
              <p className={themeStyles.hint}>
                This browser can&apos;t deliver notifications to a closed app.
              </p>
            ) : (
              <>
                <div
                  className={themeStyles.options}
                  role="radiogroup"
                  aria-label="Background notifications"
                  aria-busy={background === "working"}
                >
                  {[
                    { on: true, label: "On" },
                    { on: false, label: "Off" },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      // A failed attempt leaves no subscription, so the state
                      // really is off. Leaving the group with nothing selected
                      // would be the one reading that is not true.
                      aria-checked={
                        background === "working"
                          ? false
                          : option.on
                            ? background === "on"
                            : background !== "on"
                      }
                      disabled={background === "working"}
                      className={themeStyles.radio}
                      onClick={() => void toggleBackground(option.on)}
                    >
                      <span className={themeStyles.radioMark} />
                      <span className={themeStyles.radioLabel}>{option.label}</span>
                    </button>
                  ))}
                </div>

                {background === "failed" && (
                  <p className={themeStyles.hint} role="alert">
                    Couldn&apos;t set that up. Check that notifications are allowed for this site,
                    then try again.
                  </p>
                )}

                <p className={themeStyles.hint} style={{ marginTop: 18 }}>
                  Kuchupuchu is told that something arrived, never what or who from — the
                  notification says &ldquo;New message&rdquo; until you open it, and the message
                  itself is only decrypted on this device.
                </p>
              </>
            )}
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
