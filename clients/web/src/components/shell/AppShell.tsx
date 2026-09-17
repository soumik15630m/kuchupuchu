"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Icon, type IconName } from "@/components/Icon";
import { useSession } from "@/lib/auth/SessionProvider";

import styles from "./AppShell.module.css";

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: "/chats", label: "Chats", icon: "chats" },
  { href: "/status", label: "Status", icon: "status" },
  { href: "/calls", label: "Calls", icon: "calls" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

/** `pane="detail"` collapses the list pane — a chat, call or settings sub-screen
 * owns the whole viewport. In that mode `children` is promoted into the detail
 * slot, so a single-pane screen does not have to know which slot it landed in. */
export function AppShell({
  children,
  detail,
  pane = "list",
}: {
  children: React.ReactNode;
  detail?: React.ReactNode;
  pane?: "list" | "detail";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { status } = useSession();

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated") return null;

  const isDetail = pane === "detail";

  return (
    <div className={styles.shell} data-pane={pane}>
      <div className={styles.body}>
        <div className={styles.sidebar}>{isDetail ? null : children}</div>
        <div className={styles.detail}>{isDetail ? (detail ?? children) : detail}</div>
      </div>

      <nav className={styles.tabs} aria-label="Sections">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={styles.tab}
              aria-current={active ? "page" : undefined}
            >
              <span className={styles.tabIcon}>
                <Icon name={tab.icon} size={22} filled={active} />
              </span>
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
