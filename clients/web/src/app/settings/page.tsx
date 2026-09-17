"use client";

import { useRouter } from "next/navigation";

import { Icon, type IconName } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { useSession } from "@/lib/auth/SessionProvider";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";

import styles from "./settings.module.css";

function Row({
  icon,
  label,
  note,
  onClick,
  danger,
}: {
  icon: IconName;
  label: string;
  note?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.row} ${danger ? styles.danger : ""}`}
      onClick={onClick}
    >
      <span className={styles.rowIcon}>
        <Icon name={icon} size={22} />
      </span>
      <span className={styles.rowBody}>
        <span className={styles.rowLabel}>{label}</span>
        {note && <span className={styles.rowNote}>{note}</span>}
      </span>
      {!danger && (
        <span className={styles.chevron}>
          <Icon name="chevron" size={18} />
        </span>
      )}
    </button>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { email, signOut } = useSession();
  const { me } = useDirectory();

  return (
    <AppShell detail={<PaneEmpty>Choose a setting.</PaneEmpty>}>
      <Pane>
        <PaneHeader title="Settings" />
        <PaneScroll>
          <button
            type="button"
            className={styles.profile}
            style={{ width: "100%", textAlign: "left", color: "inherit" }}
            onClick={() => router.push("/settings/profile")}
          >
            <div className={styles.avatar}>
              {initialsFor(me?.displayName || me?.username || email || "?")}
            </div>
            <div className={styles.who}>
              <div className={styles.name}>{me?.displayName || me?.username || "You"}</div>
              <div className={styles.email}>
                {me?.username ? `@${me.username}` : email}
                {me?.about ? ` · ${me.about}` : ""}
              </div>
            </div>
          </button>

          <div className={styles.divider} />

          <Row
            icon="palette"
            label="Theme"
            note="Colours, wallpaper, font size"
            onClick={() => router.push("/settings/theme")}
          />
          <Row
            icon="settings"
            label="Profile"
            note="Username, display name and about"
            onClick={() => router.push("/settings/profile")}
          />
          <Row
            icon="chats"
            label="Notifications"
            note="Alerts for new messages"
            onClick={() => router.push("/settings/notifications")}
          />
          <Row
            icon="shield"
            label="Linked devices"
            note="Review and revoke your devices"
            onClick={() => router.push("/settings/devices")}
          />

          <div className={styles.divider} />

          <Row icon="logout" label="Log out" onClick={signOut} danger />

          <p className={styles.version}>Kuchupuchu web · Phase 5</p>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
