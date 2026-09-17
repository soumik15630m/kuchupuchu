"use client";

import { useRouter } from "next/navigation";

import { Icon } from "@/components/Icon";

import styles from "./Pane.module.css";

export function Pane({ children }: { children: React.ReactNode }) {
  return <section className={styles.pane}>{children}</section>;
}

export function PaneHeader({
  title,
  subtitle,
  backHref,
  actions,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <header className={styles.header}>
      {backHref && (
        <button
          className={styles.iconButton}
          onClick={() => router.push(backHref)}
          aria-label="Back"
          type="button"
        >
          <Icon name="back" size={22} />
        </button>
      )}
      <h1 className={styles.title}>
        {title}
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </h1>
      {actions}
    </header>
  );
}

export function PaneScroll({ children }: { children: React.ReactNode }) {
  return <div className={styles.scroll}>{children}</div>;
}

export function PaneEmpty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export { styles as paneStyles };
