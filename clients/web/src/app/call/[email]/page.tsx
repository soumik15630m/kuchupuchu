"use client";

import { ConnectionQuality } from "livekit-client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { VideoTile } from "@/components/call/VideoTile";
import styles from "@/components/call/call.module.css";
import { deviceId } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { CallEngine, type CallState } from "@/lib/call/engine";
import { useDirectory } from "@/lib/directory/DirectoryProvider";
import { getGroup, isGroupId } from "@/lib/groups";
import { finishCall, recordCallStarted } from "@/lib/call/call-log";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { targetFor } from "@/lib/messaging/useChatTarget";
import { pickPipParticipant, pipSupported } from "@/lib/call/pip.mjs";

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
  const { nameFor } = useDirectory();

  const peerEmail = decodeURIComponent(params.email);
  const withVideo = search.get("video") === "1";
  // Set when arriving by answering the ringing banner, rather than by
  // starting a call. It decides both how the call is logged and whether this
  // side rings the other.
  const isAnswering = search.get("incoming") === "1";

  const engineRef = useRef<CallEngine | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CallState | null>(null);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [devices, setDevices] = useState<{
    audioinput: MediaDeviceInfo[];
    videoinput: MediaDeviceInfo[];
    audiooutput: MediaDeviceInfo[];
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [peerName, setPeerName] = useState(peerEmail);
  const logIdRef = useRef<string | null>(null);
  // In a ref so the teardown above can still reach it after unmount.
  const { client } = useMessaging();
  const clientRef = useRef(client);
  clientRef.current = client;
  const connectedAtRef = useRef<number | null>(null);

  const [callees, setCallees] = useState<string[] | null>(null);

  // Picture-in-picture. The browser owns the window, so all this holds is
  // which <video> is eligible; requesting it must happen inside the click,
  // because Chrome requires a user gesture.
  const pipTargets = useRef(new Map<string, HTMLVideoElement>());
  const [pipActive, setPipActive] = useState(false);
  const pipAvailable = pipSupported() && Boolean(pickPipParticipant(state?.participants ?? []));

  const registerPipTarget = useCallback(
    (identity: string) => (el: HTMLVideoElement | null) => {
      if (el) pipTargets.current.set(identity, el);
      else pipTargets.current.delete(identity);
    },
    []
  );

  const togglePip = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      const target = pickPipParticipant(state?.participants ?? []);
      const el = target ? pipTargets.current.get(target.identity) : null;
      if (el) await el.requestPictureInPicture();
    } catch {
      // Denied by the browser or the element was not ready; the call itself
      // is unaffected, so there is nothing to tell the user.
    }
  }, [state?.participants]);

  // The window also closes from its own chrome, so the button tracks the
  // document rather than assuming its own click is the only way out.
  useEffect(() => {
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    document.addEventListener("enterpictureinpicture", onEnter, true);
    document.addEventListener("leavepictureinpicture", onLeave, true);
    return () => {
      document.removeEventListener("enterpictureinpicture", onEnter, true);
      document.removeEventListener("leavepictureinpicture", onLeave, true);
    };
  }, []);

  useEffect(() => {
    if (!isGroupId(peerEmail)) {
      setPeerName(nameFor(peerEmail));
      setCallees([peerEmail]);
      return;
    }
    const group = getGroup(peerEmail);
    setPeerName(group?.name ?? "Group");
    // §4 caps a room at 5. The caller is added server-side, so only the other
    // members are named here; a larger group cannot all join one call.
    setCallees(group ? group.members.filter((m) => m !== session?.email) : []);
  }, [peerEmail, session?.email, nameFor]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || !session || engineRef.current) return;
    if (callees === null) return;
    const engine = new CallEngine(session, deviceId(), setState);
    engineRef.current = engine;
    const logId = recordCallStarted(peerEmail, !isAnswering, withVideo);
    logIdRef.current = logId;
    engine.start(callees, withVideo);

    // Ring the other side. Answering is what makes them join this room, so
    // without it the caller sat at "Ringing…" while the callee never learned
    // a call was happening at all.
    const target = targetFor(peerEmail);
    if (target && clientRef.current && !isAnswering) {
      void clientRef.current.signalCall(target, "call-invite", withVideo).catch(() => {});
    }

    return () => {
      // Closing the record here rather than on hang-up covers navigating away
      // and closing the tab too.
      finishCall(
        logId,
        connectedAtRef.current ? "completed" : "failed",
        connectedAtRef.current
      );
      // Best effort. An in-app hang-up or route change gets this out, but a
      // hard unload -- closing the tab, a full page navigation -- kills the
      // request with it. The callee's ring timeout is the actual guarantee
      // that a phone stops ringing; this just makes it immediate when it can.
      if (target && clientRef.current && !isAnswering && !connectedAtRef.current) {
        void clientRef.current.signalCall(target, "call-cancel", withVideo).catch(() => {});
      }
      engine.dispose();
      engineRef.current = null;
    };
  }, [status, session, peerEmail, withVideo, callees, isAnswering]);

  // The first time it actually connects is what the log's duration measures.
  useEffect(() => {
    if (state?.stage === "connected" && connectedAtRef.current === null) {
      connectedAtRef.current = Date.now();
    }
  }, [state?.stage]);

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
            <Avatar email={peerEmail} label={peerName} size={96} className={styles.centreAvatar} />
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
            <Avatar email={peerEmail} label={peerName} size={96} className={styles.centreAvatar} />
            <div className={styles.centreName}>{peerName}</div>
            <p className={styles.centreNote}>{isAnswering ? "Connecting…" : "Ringing…"}</p>
          </div>
        </div>
      ) : (
        <div className={styles.grid} data-count={Math.min(ordered.length, 5)}>
          {ordered.map((p) => (
            <VideoTile
              key={p.identity}
              participant={p}
              mirrored={p.isLocal && !p.sharingScreen}
              onVideoEl={registerPipTarget(p.identity)}
            />
          ))}
        </div>
      )}

      {state?.audioBlocked && (
        <button
          type="button"
          className={styles.audioBlocked}
          onClick={() => void engineRef.current?.startAudio()}
        >
          Your browser blocked the call audio. Tap to hear this call.
        </button>
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
            <Icon name="dataSaver" size={20} />
          </button>

          {state?.canSwitchCamera && state?.cameraEnabled && (
            <button
              className={styles.control}
              type="button"
              aria-label="Switch camera"
              onClick={() => engineRef.current?.switchCamera()}
            >
              <Icon name="video" size={20} />
            </button>
          )}

          <button
            className={styles.control}
            type="button"
            data-active={state?.screenSharing}
            aria-label={state?.screenSharing ? "Stop sharing your screen" : "Share your screen"}
            onClick={() => engineRef.current?.toggleScreenShare()}
          >
            <Icon name="screenShare" size={20} />
          </button>

          <button
            className={styles.control}
            type="button"
            data-active={showDevices}
            aria-label="Audio and video devices"
            onClick={async () => {
              // Labels are empty until permission has been granted, so this
              // is read when the sheet opens rather than once at mount.
              if (!showDevices) setDevices(await engineRef.current!.devices());
              setShowDevices((v) => !v);
            }}
          >
            <Icon name="settings" size={20} />
          </button>

          {pipAvailable && (
            <button
              className={styles.control}
              type="button"
              data-active={pipActive}
              aria-label={pipActive ? "Close the floating window" : "Open in a floating window"}
              onClick={togglePip}
            >
              <Icon name="pip" size={20} />
            </button>
          )}

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

      {showDevices && devices && (
        <div className={styles.sheet} role="dialog" aria-label="Devices">
          <h2 className={styles.sheetTitle}>Devices</h2>
          {(
            [
              ["audioinput", "Microphone"],
              ["videoinput", "Camera"],
              ["audiooutput", "Speaker"],
            ] as const
          ).map(([kind, label]) => {
            const list = devices[kind];
            if (list.length === 0) return null;
            const active = engineRef.current?.activeDevices()[kind];
            return (
              <div key={kind} className={styles.deviceGroup}>
                <span className={styles.deviceLabel}>{label}</span>
                {list.map((device, index) => (
                  <button
                    key={device.deviceId || index}
                    type="button"
                    className={styles.deviceOption}
                    data-active={device.deviceId === active}
                    onClick={() => void engineRef.current?.selectDevice(kind, device.deviceId)}
                  >
                    {device.label || `${label} ${index + 1}`}
                  </button>
                ))}
              </div>
            );
          })}
          <button className={styles.sheetClose} type="button" onClick={() => setShowDevices(false)}>
            Done
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
