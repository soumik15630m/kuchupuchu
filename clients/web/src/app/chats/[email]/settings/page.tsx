"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { AppShell } from "@/components/shell/AppShell";
import { WallpaperPicker } from "@/components/theme/WallpaperPicker";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import {
  deleteGroup,
  editGroup,
  getGroup,
  isAdmin,
  isGroupId,
  type Group,
} from "@/lib/groups";
import { useSession } from "@/lib/auth/SessionProvider";
import { clearChat } from "@/lib/messaging/store";
import { download, exportChat } from "@/lib/export/service";
import { EPHEMERAL_DURATIONS } from "@/lib/messaging/ephemeral.mjs";
import { settingsFor } from "@/lib/messaging/chat-settings";
import { acknowledgePin, pinsFor, type IdentityPin } from "@/lib/crypto/identity-pins";
import { isGroupId as isGroup } from "@/lib/groups";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { useTheme } from "@/lib/theme/ThemeProvider";

import settingsStyles from "@/app/settings/settings.module.css";
import themeStyles from "@/app/settings/theme/theme.module.css";

export default function ChatSettingsPage() {
  const params = useParams<{ email: string }>();
  const router = useRouter();
  const email = decodeURIComponent(params.email);
  const { theme, setWallpaper } = useTheme();
  const { refreshChats, client, revision } = useMessaging();
  const { email: myEmail } = useSession();
  const { nameFor, others } = useDirectory();
  const [name, setName] = useState(email);
  const [group, setGroup] = useState<Group | null>(null);
  const [cleared, setCleared] = useState(false);
  const [pins, setPins] = useState<IdentityPin[]>([]);
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [ephemeralMs, setEphemeralMs] = useState(0);
  const [savingTimer, setSavingTimer] = useState(false);
  const [timerNote, setTimerNote] = useState<"unsynced" | null>(null);
  const [exporting, setExporting] = useState<"text" | "media" | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const runExport = useCallback(
    async (includeMedia: boolean) => {
      setExporting(includeMedia ? "media" : "text");
      setExportNote(null);
      try {
        const result = await exportChat(email, {
          chatName: name,
          nameFor,
          includeMedia,
          client,
        });
        download(result.blob, result.filename);
        setExportNote(
          result.missingMedia > 0
            ? `Saved ${result.filename} — ${result.messageCount} messages. ${result.missingMedia} attachment${result.missingMedia === 1 ? "" : "s"} could not be included; the file is no longer on this device or the server.`
            : `Saved ${result.filename} — ${result.messageCount} messages.`
        );
      } catch {
        setExportNote("Couldn't build the export. Try again.");
      } finally {
        setExporting(null);
      }
    },
    [email, name, nameFor, client]
  );

  // Read on mount rather than held in the provider: the peer can change it
  // too, and the control message writes straight to the same store.
  useEffect(() => {
    setEphemeralMs(settingsFor(email).ephemeralMs ?? 0);
  }, [email, revision]);

  const target = useMemo(
    () => (group ? { kind: "group" as const, group } : isGroupId(email) ? null : { kind: "direct" as const, email }),
    [group, email]
  );

  useEffect(() => {
    if (isGroupId(email)) {
      const found = getGroup(email);
      setGroup(found);
      setName(found?.name ?? "Group");
      return;
    }
    setName(nameFor(email));
  }, [email, nameFor]);

  useEffect(() => {
    if (isGroup(email)) return;
    pinsFor(email).then(setPins);
  }, [email]);

  /** Applies an edit locally, then tells everyone. The revision has to move,
   * or every other member's copy wins on merge and the edit silently reverts. */
  async function applyGroupEdit(changes: Partial<Group>, summary: string) {
    if (!group) return;
    const updated = editGroup(group, changes);
    setGroup(updated);
    setName(updated.name);
    refreshChats();
    try {
      await client?.announceGroupUpdate(updated, summary);
    } catch {
      // The local edit stands; peers converge on the next message they get.
    }
  }

  function renameGroup() {
    if (!group) return;
    const next = prompt("Group name", group.name)?.trim();
    if (!next || next === group.name) return;
    void applyGroupEdit({ name: next }, `${myEmail} renamed the group to "${next}"`);
  }

  function editDescription() {
    if (!group) return;
    const next = prompt("Group description", group.description ?? "")?.trim();
    if (next === undefined || next === null) return;
    void applyGroupEdit({ description: next }, `${myEmail} updated the group description`);
  }

  async function addMember(email: string) {
    if (!group || group.members.includes(email)) return;
    await applyGroupEdit(
      { members: [...group.members, email] },
      `${myEmail} added ${email}`
    );
  }

  async function removeMember(email: string) {
    if (!group) return;
    const summary = `${myEmail} removed ${email}`;
    // Told first: after the edit they are off the roster and out of the
    // audience, so the announcement would never reach them.
    await client?.announceRemoval(email, group, summary);
    await applyGroupEdit(
      {
        members: group.members.filter((m) => m !== email),
        admins: group.admins.filter((a) => a !== email),
      },
      summary
    );
  }

  async function toggleAdmin(email: string) {
    if (!group) return;
    const promoting = !group.admins.includes(email);
    await applyGroupEdit(
      {
        admins: promoting
          ? [...group.admins, email]
          : group.admins.filter((a) => a !== email),
      },
      promoting ? `${myEmail} made ${email} an admin` : `${myEmail} removed ${email} as admin`
    );
  }

  const canEdit = Boolean(group && myEmail && isAdmin(group, myEmail));
  const addable = group ? others.filter((m) => !group.members.includes(m.email)) : [];
  const hasOwnWallpaper = Object.prototype.hasOwnProperty.call(theme.wallpapers, email);

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title={name} subtitle="Chat settings" backHref={`/chats/${encodeURIComponent(email)}`} />
        <PaneScroll>
          <div className={settingsStyles.profile}>
            <Avatar email={email} label={name} size={56} className={settingsStyles.avatar} />
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
                {group.members.map((member) => {
                  const memberIsAdmin = group.admins.includes(member);
                  return (
                    <div key={member} className={themeStyles.radio} style={{ cursor: "default" }}>
                      <span
                        className={settingsStyles.avatar}
                        style={{ width: 34, height: 34, fontSize: 14 }}
                      >
                        {initialsFor(nameFor(member))}
                      </span>
                      <span className={themeStyles.radioLabel}>
                        {member === myEmail ? "You" : nameFor(member)}
                        {memberIsAdmin && " · admin"}
                        <span className={themeStyles.radioNote}>{member}</span>
                      </span>
                      {canEdit && member !== myEmail && (
                        <>
                          <button
                            type="button"
                            className={themeStyles.reset}
                            style={{ color: "var(--accent)" }}
                            onClick={() => void toggleAdmin(member)}
                          >
                            {memberIsAdmin ? "Demote" : "Make admin"}
                          </button>
                          <button
                            type="button"
                            className={themeStyles.reset}
                            onClick={() => void removeMember(member)}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}

                {canEdit && addable.length > 0 && (
                  <>
                    <h2 className={themeStyles.sectionTitle} style={{ marginTop: 16 }}>
                      Add someone
                    </h2>
                    {addable.map((member) => (
                      <button
                        key={member.email}
                        type="button"
                        className={themeStyles.radio}
                        onClick={() => void addMember(member.email)}
                      >
                        <span
                          className={settingsStyles.avatar}
                          style={{ width: 34, height: 34, fontSize: 14 }}
                        >
                          {initialsFor(nameFor(member.email))}
                        </span>
                        <span className={themeStyles.radioLabel}>
                          {nameFor(member.email)}
                          <span className={themeStyles.radioNote}>
                            {member.username ? `@${member.username}` : member.email}
                          </span>
                        </span>
                      </button>
                    ))}
                  </>
                )}

                {canEdit && (
                  <>
                    <button className={themeStyles.reset} type="button" onClick={renameGroup}>
                      Rename group
                    </button>
                    <button className={themeStyles.reset} type="button" onClick={editDescription}>
                      {group.description ? "Edit description" : "Add a description"}
                    </button>
                  </>
                )}
                {group.description && <p className={themeStyles.hint}>{group.description}</p>}
                {!canEdit && (
                  <p className={themeStyles.hint}>Only an admin can change this group.</p>
                )}
                <p className={themeStyles.hint}>
                  Every member gets their own encrypted copy of each message. The server never
                  learns this group exists.
                </p>
              </div>
            </>
          )}

          <div className={settingsStyles.divider} />
          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Export this chat</h2>
            <div className={themeStyles.options}>
              <button
                type="button"
                className={themeStyles.radio}
                disabled={exporting !== null}
                onClick={() => void runExport(false)}
              >
                <span className={themeStyles.radioLabel}>
                  {exporting === "text" ? "Preparing…" : "Text only"}
                </span>
              </button>
              <button
                type="button"
                className={themeStyles.radio}
                disabled={exporting !== null}
                onClick={() => void runExport(true)}
              >
                <span className={themeStyles.radioLabel}>
                  {exporting === "media" ? "Preparing…" : "With photos and files"}
                </span>
              </button>
            </div>
            {exportNote && (
              <p className={themeStyles.hint} role="status">
                {exportNote}
              </p>
            )}
            <p className={themeStyles.hint}>
              Writes a readable copy to your downloads. Unlike a backup this is{" "}
              <strong>not encrypted</strong> — anything that reads that folder can read the
              conversation. Messages that have already disappeared are not in it.
            </p>
          </div>

          <div className={settingsStyles.divider} />
          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Disappearing messages</h2>
            <div
              className={themeStyles.options}
              role="radiogroup"
              aria-label="Disappearing messages"
            >
              {EPHEMERAL_DURATIONS.map((option) => (
                <button
                  key={option.ms}
                  type="button"
                  role="radio"
                  aria-checked={ephemeralMs === option.ms}
                  className={themeStyles.radio}
                  disabled={savingTimer}
                  onClick={async () => {
                    if (!target || option.ms === ephemeralMs) return;
                    setSavingTimer(true);
                    setEphemeralMs(option.ms);
                    try {
                      const synced = await client?.setEphemeralTimer(target, option.ms);
                      setTimerNote(synced === false ? "unsynced" : null);
                      refreshChats();
                    } finally {
                      setSavingTimer(false);
                    }
                  }}
                >
                  <span className={themeStyles.radioMark} />
                  <span className={themeStyles.radioLabel}>{option.label}</span>
                </button>
              ))}
            </div>
            {timerNote === "unsynced" && (
              <p className={themeStyles.hint} role="alert">
                Saved here, but the other side hasn&apos;t been told yet — they have no device
                reachable right now. Messages you send will still carry the timer.
              </p>
            )}
            <p className={themeStyles.hint}>
              New messages disappear from everyone&apos;s device after this long. The clock starts
              when a message is sent, not when it&apos;s read, so both sides lose it at the same
              moment. Messages already sent keep whatever timer they were sent with.
            </p>
          </div>

          {pins.length > 0 && (
            <>
              <div className={settingsStyles.divider} />
              <div className={themeStyles.section}>
                <h2 className={themeStyles.sectionTitle}>Security code</h2>
                {pins.map((pin) => (
                  <div key={pin.key} className={themeStyles.radio} style={{ cursor: "default" }}>
                    <span className={themeStyles.radioLabel}>
                      <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
                        {pin.safetyNumber}
                      </span>
                      <span className={themeStyles.radioNote}>
                        {pin.acknowledgedAtMs
                          ? "Verified"
                          : `First seen ${new Date(pin.firstSeenAtMs).toLocaleDateString()}`}
                      </span>
                    </span>
                    {!pin.acknowledgedAtMs && (
                      <button
                        type="button"
                        className={themeStyles.reset}
                        style={{ color: "var(--accent)" }}
                        onClick={async () => {
                          await acknowledgePin(pin.peerEmail, pin.peerDeviceId);
                          setPins(await pinsFor(email));
                        }}
                      >
                        Mark verified
                      </button>
                    )}
                  </div>
                ))}
                <p className={themeStyles.hint}>
                  Read this aloud over a channel this app doesn&apos;t control — a phone call, or in
                  person. If it ever changes, a warning appears in the chat.
                </p>
              </div>
            </>
          )}

          {!isGroup(email) && (
            <>
              <div className={settingsStyles.divider} />
              <div className={themeStyles.section}>
                <h2 className={themeStyles.sectionTitle}>Encrypted session</h2>
                <button
                  className={themeStyles.reset}
                  style={{ color: "var(--danger)" }}
                  type="button"
                  disabled={resetting}
                  onClick={async () => {
                    setResetting(true);
                    try {
                      const count = await client?.resetSessionsWith(email);
                      setResetNote(
                        count
                          ? `Session reset. The next message will set up encryption again.`
                          : "No session to reset."
                      );
                    } finally {
                      setResetting(false);
                    }
                  }}
                >
                  {resetting ? "Resetting…" : "Reset encrypted session"}
                </button>
                {resetNote && <p className={themeStyles.hint}>{resetNote}</p>}
                <p className={themeStyles.hint}>
                  Only if messages from this person stop decrypting — after they reinstall, or set
                  up a new device. Their security code will change, and past messages already on
                  this device are unaffected.
                </p>
              </div>
            </>
          )}

          <div className={settingsStyles.divider} />

          <button
            type="button"
            className={settingsStyles.row}
            onClick={() => router.push(`/chats/${encodeURIComponent(email)}/media`)}
          >
            <span className={settingsStyles.rowBody}>
              <span className={settingsStyles.rowLabel}>Media, links and docs</span>
              <span className={settingsStyles.rowNote}>Everything shared in this chat</span>
            </span>
          </button>

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
