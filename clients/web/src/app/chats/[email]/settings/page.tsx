"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { WallpaperPicker } from "@/components/theme/WallpaperPicker";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { deleteGroup, getGroup, isGroupId, saveGroup, type Group } from "@/lib/groups";
import { useSession } from "@/lib/auth/SessionProvider";
import { clearChat } from "@/lib/messaging/store";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { useTheme } from "@/lib/theme/ThemeProvider";

import settingsStyles from "@/app/settings/settings.module.css";
import themeStyles from "@/app/settings/theme/theme.module.css";

export default function ChatSettingsPage() {
  const params = useParams<{ email: string }>();
  const router = useRouter();
  const email = decodeURIComponent(params.email);
  const { theme, setWallpaper } = useTheme();
  const { refreshChats } = useMessaging();
  const { email: myEmail } = useSession();
  const { nameFor } = useDirectory();
  const [name, setName] = useState(email);
  const [group, setGroup] = useState<Group | null>(null);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    if (isGroupId(email)) {
      const found = getGroup(email);
      setGroup(found);
      setName(found?.name ?? "Group");
      return;
    }
    setName(nameFor(email));
  }, [email, nameFor]);

  function renameGroup() {
    if (!group) return;
    const next = prompt("Group name", group.name)?.trim();
    if (!next) return;
    // The revision has to move, or every other member's copy wins on merge and
    // the rename silently reverts on their next message.
    const updated = { ...group, name: next, revision: group.revision + 1 };
    saveGroup(updated);
    setGroup(updated);
    setName(next);
    refreshChats();
  }

  const hasOwnWallpaper = Object.prototype.hasOwnProperty.call(theme.wallpapers, email);

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title={name} subtitle="Chat settings" backHref={`/chats/${encodeURIComponent(email)}`} />
        <PaneScroll>
          <div className={settingsStyles.profile}>
            <div className={settingsStyles.avatar}>{initialsFor(name)}</div>
            <div className={settingsStyles.who}>
              <div className={settingsStyles.name}>{name}</div>
              <div className={settingsStyles.email}>{email}</div>
            </div>
          </div>

          {group && (
            <>
              <div className={settingsStyles.divider} />
              <div className={themeStyles.section}>
                <h2 className={themeStyles.sectionTitle}>{group.members.length} members</h2>
                {group.members.map((member) => (
                  <div key={member} className={themeStyles.radio} style={{ cursor: "default" }}>
                    <span className={settingsStyles.avatar} style={{ width: 34, height: 34, fontSize: 14 }}>
                      {initialsFor(nameFor(member))}
                    </span>
                    <span className={themeStyles.radioLabel}>
                      {member === myEmail ? "You" : nameFor(member)}
                      <span className={themeStyles.radioNote}>{member}</span>
                    </span>
                  </div>
                ))}
                <button className={themeStyles.reset} type="button" onClick={renameGroup}>
                  Rename group
                </button>
                <p className={themeStyles.hint}>
                  Every member gets their own encrypted copy of each message. The server never
                  learns this group exists.
                </p>
              </div>
            </>
          )}

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
            {group && (
              <button
                className={themeStyles.reset}
                type="button"
                onClick={async () => {
                  if (!confirm(`Leave ${group.name}? Its messages stay on this device.`)) return;
                  deleteGroup(group.id);
                  refreshChats();
                  router.replace("/chats");
                }}
              >
                Leave group
              </button>
            )}
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
