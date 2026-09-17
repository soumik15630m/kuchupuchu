"use client";

import { ConnectionQuality } from "livekit-client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { VideoTile } from "@/components/call/VideoTile";
import styles from "@/components/call/call.module.css";
import { deviceId } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { CallEngine, type CallState } from "@/lib/call/engine";
import { displayName, initials, loadContacts } from "@/lib/contacts";
import { getGroup, isGroupId } from "@/lib/groups";

function qualityName(q: ConnectionQuality): string {
  if (q === ConnectionQuality.Excellent) return "excellent";
  if (q === ConnectionQuality.Good) return "good";
  if (q === ConnectionQuality.Poor) return "poor";
  return "unknown";
}

function duration(startedAtMs: number | null, nowMs: number): string {
  if (!startedAtMs) return "";
  const total = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function CallPage() {
  const params = useParams<{ email: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { status, session } = useSession();

  const peerEmail = decodeURIComponent(params.email);
  const withVideo = search.get("video") === "1";

  const engineRef = useRef<CallEngine | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CallState | null>(null);
  const [showSecurity, setShowSecurity] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [peerName, setPeerName] = useState(peerEmail);

  const [callees, setCallees] = useState<string[] | null>(null);

  useEffect(() => {
    if (!isGroupId(peerEmail)) {
      setPeerName(displayName(peerEmail, loadContacts()));
      setCallees([peerEmail]);
      return;
    }
    const group = getGroup(peerEmail);
    setPeerName(group?.name ?? "Group");
    // §4 caps a room at 5. The caller is added server-side, so only the other
    // members are named here; a larger group cannot all join one call.
    setCallees(group ? group.members.filter((m) => m !== session?.email) : []);
  }, [peerEmail, session?.email]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || !session || engineRef.current) return;
    if (callees === null) return;
    const engine = new CallEngine(session, deviceId(), setState);
    engineRef.current = engine;
    engine.start(callees, withVideo);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [status, session, peerEmail, withVideo, callees]);

  useEffect(() => {
    const engine = engineRef.current;
    const container = audioRef.current;
    if (!engine || !container || state?.stage !== "connected") return;
    return engine.attachRemoteAudio(container);
  }, [state?.stage]);

  const leave = useCallback(async () => {
    await engineRef.current?.hangUp();
    router.replace(`/chats/${encodeURIComponent(peerEmail)}`);
  }, [router, peerEmail]);

  if (status !== "authenticated") return null;

  const stage = state?.stage ?? "connecting";
  const participants = state?.participants ?? [];
  const remote = participants.filter((p) => !p.isLocal);
  const local = participants.find((p) => p.isLocal);
  const ordered = local ? [...remote, local] : remote;

  return (
    <div className={styles.screen}>
      <div ref={audioRef} />

      <header className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.peer}>{remote.length > 1 ? `${remote.length} people` : peerName}</div>
          <div className={styles.status}>
            <span className={styles.dot} data-quality={qualityName(state?.quality ?? ConnectionQuality.Unknown)} />
            {stage === "connecting" && "Connecting…"}
            {stage === "reconnecting" && "Reconnecting…"}
            {stage === "connected" && (state?.startedAtMs ? duration(state.startedAtMs, now) : "Connected")}
            {stage === "ended" && "Call ended"}
            {stage === "failed" && "Couldn't connect"}
            {state?.encrypted && stage === "connected" && " · encrypted"}
          </div>
        </div>
        {stage === "connected" && (
          <button
            className={styles.headerButton}
            type="button"
            aria-label="Encryption details"
            onClick={() => setShowSecurity(true)}
          >
            <Icon name="shield" size={19} />
          </button>
        )}
      </header>

      {state?.rejoinNeeded && (
        <div className={styles.banner} role="alert">
          Encryption keys are out of sync. Hang up and call again to recover.
        </div>
      )}
      {state?.error && stage !== "failed" && (
        <div className={styles.banner} role="alert">
          {state.error}
        </div>
      )}

      {stage === "failed" || stage === "ended" ? (
        <div className={styles.centre}>
          <div>
            <div className={styles.centreAvatar}>{initials(peerName)}</div>
            <div className={styles.centreName}>{peerName}</div>
            <p className={styles.centreNote}>
              {stage === "failed" ? (state?.error ?? "The call couldn't be connected.") : "Call ended."}
            </p>
            <button className={styles.retry} type="button" onClick={() => router.replace("/chats")}>
              Back to chats
            </button>
          </div>
        </div>
      ) : ordered.length === 0 ? (
        <div className={styles.centre}>
          <div>
            <div className={styles.centreAvatar}>{initials(peerName)}</div>
            <div className={styles.centreName}>{peerName}</div>
            <p className={styles.centreNote}>Ringing…</p>
          </div>
        </div>
      ) : (
        <div className={styles.grid} data-count={Math.min(ordered.length, 5)}>
          {ordered.map((p) => (
            <VideoTile key={p.identity} participant={p} mirrored={p.isLocal} />
          ))}
        </div>
      )}

      {stage !== "ended" && stage !== "failed" && (
        <div className={styles.controls}>
          <button
            className={styles.control}
            type="button"
            data-active={!state?.micEnabled}
            aria-label={state?.micEnabled ? "Mute microphone" : "Unmute microphone"}
            onClick={() => engineRef.current?.toggleMic()}
          >
            <Icon name={state?.micEnabled ? "mic" : "micOff"} size={21} />
          </button>

          <button
            className={styles.control}
            type="button"
            data-active={!state?.cameraEnabled}
            aria-label={state?.cameraEnabled ? "Turn camera off" : "Turn camera on"}
            disabled={state?.audioOnly}
            onClick={() => engineRef.current?.toggleCamera()}
          >
            <Icon name={state?.cameraEnabled ? "video" : "camOff"} size={21} />
          </button>

          <button
            className={styles.control}
            type="button"
            data-active={state?.dataSaver}
            aria-label={state?.dataSaver ? "Turn data saver off" : "Turn data saver on"}
            onClick={() => engineRef.current?.setDataSaver(!state?.dataSaver)}
          >
            <Icon name="image" size={20} />
          </button>

          <button
            className={`${styles.control} ${styles.hangup}`}
            type="button"
            aria-label="End call"
            onClick={leave}
          >
            <Icon name="hangup" size={24} />
          </button>
        </div>
      )}

      {showSecurity && (
        <div className={styles.sheet} role="dialog" aria-label="Encryption details">
          <h2 className={styles.sheetTitle}>End-to-end encrypted</h2>
          <p className={styles.sheetLede}>
            Compare the safety number with the other person over a channel this app doesn&apos;t
            control — a phone call, or in person. It stays the same for as long as their device does.
          </p>

          {Object.entries(state?.safetyNumbers ?? {}).map(([identity, number]) => (
            <div key={identity} className={styles.fpRow}>
              <span>{state?.participants.find((p) => p.identity === identity)?.email ?? identity}</span>
              <span className={styles.fpValue}>{number}</span>
            </div>
          ))}
          {Object.keys(state?.safetyNumbers ?? {}).length === 0 && (
            <p className={styles.sheetLede}>No peer sessions established yet.</p>
          )}

          <div className={styles.fpRow}>
            <span>Room key · generation {state?.generation ?? "—"}</span>
            <span className={styles.fpValue}>{state?.fingerprint ?? "—"}</span>
          </div>

          <button className={styles.sheetClose} type="button" onClick={() => setShowSecurity(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
