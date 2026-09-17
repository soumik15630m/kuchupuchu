"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { deviceId, type DeviceRow } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";

import styles from "./devices.module.css";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export default function DevicesPage() {
  const { session } = useSession();
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);

  useEffect(() => setThisDevice(deviceId()), []);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setRows((await session.devices()).devices);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your devices.");
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id: string) {
    if (!session) return;
    setPending(id);
    try {
      await session.revokeDevice(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke that device.");
    } finally {
      setPending(null);
    }
  }

  return (
    <AppShell pane="detail" detail={null}>
      <Pane>
        <PaneHeader title="Linked devices" backHref="/settings" />
        <PaneScroll>
          {error && <p className={styles.error}>{error}</p>}
          {rows === null && !error && <PaneEmpty>Loading…</PaneEmpty>}

          {rows?.map((row) => {
            const isThis = row.id === thisDevice;
            return (
              <div key={row.id} className={styles.device}>
                <div className={styles.info}>
                  <div className={styles.label}>
                    {row.platform === "web" ? "Web" : "Android"}
                    {isThis && <span className={styles.thisTag}>This device</span>}
                  </div>
                  <div className={styles.meta}>
                    <span data-status={row.status}>{row.status}</span> · last seen {relative(row.lastSeenAt)}
                  </div>
                  <div className={styles.id}>{row.id}</div>
                </div>
                {row.status === "active" && !isThis && (
                  <button
                    type="button"
                    className={styles.revoke}
                    disabled={pending === row.id}
                    onClick={() => revoke(row.id)}
                  >
                    {pending === row.id ? "…" : "Revoke"}
                  </button>
                )}
              </div>
            );
          })}

          <p className={styles.note}>
            Revoking a device disconnects it from any call it is in, within a couple of seconds. Its
            identity key stays on record, so that device id cannot be reused.
          </p>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
