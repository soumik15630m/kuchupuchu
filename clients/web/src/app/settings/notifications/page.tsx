"use client";

import { useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import {
  notificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "@/lib/notifications";

import themeStyles from "@/app/settings/theme/theme.module.css";

export default function NotificationsPage() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    setEnabled(notificationsEnabled());
  }, []);

  async function enable() {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      setNotificationsEnabled(true);
      setEnabled(true);
    }
  }

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

            <p className={themeStyles.hint} style={{ marginTop: 18 }}>
              These only arrive while Kuchupuchu is open in a tab. Notifications that wake a closed
              app need the wake service, which isn&apos;t built yet.
            </p>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
