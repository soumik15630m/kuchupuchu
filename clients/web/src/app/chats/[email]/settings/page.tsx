"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { WallpaperPicker } from "@/components/theme/WallpaperPicker";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { displayName, initials, loadContacts } from "@/lib/contacts";
import { clearChat } from "@/lib/messaging/store";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { useTheme } from "@/lib/theme/ThemeProvider";

import settingsStyles from "@/app/settings/settings.module.css";
import themeStyles from "@/app/settings/theme/theme.module.css";

export default function ChatSettingsPage() {
  const params = useParams<{ email: string }>();
  const email = decodeURIComponent(params.email);
  const { theme, setWallpaper } = useTheme();
  const { refreshChats } = useMessaging();
  const [name, setName] = useState(email);
  const [cleared, setCleared] = useState(false);

  useEffect(() => setName(displayName(email, loadContacts())), [email]);

  const hasOwnWallpaper = Object.prototype.hasOwnProperty.call(theme.wallpapers, email);

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title={name} subtitle="Chat settings" backHref={`/chats/${encodeURIComponent(email)}`} />
        <PaneScroll>
          <div className={settingsStyles.profile}>
            <div className={settingsStyles.avatar}>{initials(name)}</div>
            <div className={settingsStyles.who}>
              <div className={settingsStyles.name}>{name}</div>
              <div className={settingsStyles.email}>{email}</div>
            </div>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Wallpaper for this chat</h2>
            <WallpaperPicker chatId={email} />
            {hasOwnWallpaper && (
              <button
                className={themeStyles.reset}
                type="button"
                onClick={() => setWallpaper(email, null)}
              >
                Use the default wallpaper instead
              </button>
            )}
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.resetRow}>
            <button
              className={themeStyles.reset}
              type="button"
              onClick={async () => {
                if (!confirm(`Delete every message in this chat on this device?`)) return;
                await clearChat(email);
                refreshChats();
                setCleared(true);
              }}
            >
              Clear this chat
            </button>
            <p className={themeStyles.hint}>
              {cleared
                ? "Cleared on this device."
                : "Only removes messages from this device. The other person keeps their copy."}
            </p>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
