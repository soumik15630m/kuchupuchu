import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalVideoTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  VideoQuality,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

import type { Session, TurnCredentials } from "../api/client";
import { GroupE2EE, DATA_TOPIC } from "../crypto/group-e2ee";
import { loadIdentity, saveIdentity } from "../crypto/identity-store";
import { GroupKeyProvider, createE2eeWorker } from "../crypto/key-provider";
import type { DeviceIdentity } from "../crypto/signal-crypto";

export type CallStage = "idle" | "connecting" | "connected" | "reconnecting" | "ended" | "failed";

export interface ParticipantView {
  identity: string;
  email: string;
  isLocal: boolean;
  speaking: boolean;
  audioMuted: boolean;
  videoTrack: Track | null;
  sharingScreen: boolean;
  connectionQuality: ConnectionQuality;
}

export interface CallState {
  stage: CallStage;
  error: string | null;
  roomName: string | null;
  participants: ParticipantView[];
  micEnabled: boolean;
  cameraEnabled: boolean;
  audioOnly: boolean;
  dataSaver: boolean;
  /** Room-key fingerprint; changes on every rotation. */
  fingerprint: string | null;
  generation: number;
  /** Identity safety numbers, stable across rotations — the value worth
   * comparing out of band. */
  safetyNumbers: Record<string, string>;
  quality: ConnectionQuality;
  screenSharing: boolean;
  /** Whether a second camera exists to switch to. */
  canSwitchCamera: boolean;
  rejoinNeeded: boolean;
  encrypted: boolean;
  startedAtMs: number | null;
}

const QUALITY_REPORT_INTERVAL_MS = 5000;
const POOR_STREAK_AUTO_FALLBACK = 3;
const CONNECT_TIMEOUT_MS = 20000;

function disconnectReasonName(reason: DisconnectReason | undefined): string {
  if (reason == null) return "(none)";
  const match = Object.entries(DisconnectReason).find(([, value]) => value === reason);
  return match ? match[0] : `UNKNOWN (${reason})`;
}

function iceServersFrom(turn: TurnCredentials): RTCIceServer[] {
  return [{ urls: turn.uris, username: turn.username, credential: turn.password }];
}

/** The default microphone and a microphone that opens are not the same thing:
 * a Bluetooth headset in A2DP mode advertises an audioinput the browser selects
 * and then fails to open with NotReadableError, which looks like a permissions
 * fault and isn't. */
async function pickUsableAudioInput(): Promise<string | null> {
  let devices: MediaDeviceInfo[];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    return null;
  }
  const real = devices.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
  for (const d of real.length ? real : devices) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: d.deviceId } },
      });
      stream.getTracks().forEach((t) => t.stop());
      return d.deviceId;
    } catch {
      // A device that won't open is what this exists to skip.
    }
  }
  return null;
}

interface CandidateInfo {
  candidateType: string | null;
  relayProtocol: string | null;
  rttMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
}

/** Reads the winning ICE candidate pair off a published local track via the
 * SDK's public getRTCStatsReport(). The candidate type is the specific signal
 * the quality dashboard exists to show: host/srflx/relay-UDP/relay-TCP. */
async function sampleStats(room: Room): Promise<CandidateInfo | null> {
  const pub = [...room.localParticipant.trackPublications.values()][0];
  const track = pub?.track;
  if (!track) return null;

  let report: RTCStatsReport | undefined;
  try {
    report = await track.getRTCStatsReport();
  } catch {
    return null;
  }
  if (!report) return null;

  let selectedPairId: string | null = null;
  report.forEach((stat) => {
    if (!selectedPairId && stat.type === "transport" && stat.selectedCandidatePairId) {
      selectedPairId = stat.selectedCandidatePairId as string;
    }
  });
  if (!selectedPairId) {
    // Firefox marks the winning pair on candidate-pair itself rather than
    // emitting transport.selectedCandidatePairId.
    report.forEach((stat) => {
      if (
        !selectedPairId &&
        stat.type === "candidate-pair" &&
        (stat.selected === true || (stat.nominated && stat.state === "succeeded"))
      ) {
        selectedPairId = stat.id as string;
      }
    });
  }
  if (!selectedPairId) return null;

  const pair = report.get(selectedPairId) as
    | { localCandidateId?: string; currentRoundTripTime?: number }
    | undefined;
  if (!pair) return null;

  const local = pair.localCandidateId
    ? (report.get(pair.localCandidateId) as { candidateType?: string; relayProtocol?: string } | undefined)
    : undefined;

  let jitterMs: number | null = null;
  let packetLossPct: number | null = null;
  report.forEach((stat) => {
    if (stat.type === "inbound-rtp" && stat.kind === "audio") {
      if (stat.jitter != null) jitterMs = stat.jitter * 1000;
      if (stat.packetsLost != null && stat.packetsReceived != null) {
        const total = stat.packetsLost + stat.packetsReceived;
        packetLossPct = total > 0 ? (stat.packetsLost / total) * 100 : 0;
      }
    }
  });

  return {
    candidateType: local?.candidateType ?? null,
    relayProtocol: local?.relayProtocol ?? null,
    rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    jitterMs,
    packetLossPct,
  };
}

export class CallEngine {
  private room: Room | null = null;
  private e2ee: GroupE2EE | null = null;
  private keyProvider: GroupKeyProvider | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private poorStreak = 0;
  private emailByIdentity = new Map<string, string>();
  private disposed = false;

  state: CallState = {
    stage: "idle",
    error: null,
    roomName: null,
    participants: [],
    micEnabled: true,
    cameraEnabled: false,
    audioOnly: false,
    dataSaver: false,
    fingerprint: null,
    generation: -1,
    safetyNumbers: {},
    quality: ConnectionQuality.Unknown,
    screenSharing: false,
    canSwitchCamera: false,
    rejoinNeeded: false,
    encrypted: false,
    startedAtMs: null,
  };

  constructor(
    private readonly session: Session,
    private readonly deviceId: string,
    private readonly onChange: (state: CallState) => void
  ) {}

  private patch(patch: Partial<CallState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private membership() {
    const room = this.room;
    if (!room) return [];
    const all = [room.localParticipant, ...room.remoteParticipants.values()];
    return all.map((p) => ({
      identity: p.identity,
      joinedAtMs: p.joinedAt ? p.joinedAt.getTime() : null,
    }));
  }

  private syncParticipants() {
    const room = this.room;
    if (!room) return;
    const build = (p: RemoteParticipant | Room["localParticipant"], isLocal: boolean): ParticipantView => {
      // A screen share takes precedence over the camera: it is the thing the
      // person is actively trying to show.
      const publications = [...p.trackPublications.values()];
      const videoPub =
        publications.find(
          (pub) => pub.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare
        ) ??
        publications.find(
          (pub) => pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera
        );
      const audioPub = [...p.trackPublications.values()].find((pub) => pub.kind === Track.Kind.Audio);
      return {
        identity: p.identity,
        email: p.name || this.emailByIdentity.get(p.identity) || p.identity,
        isLocal,
        speaking: p.isSpeaking,
        audioMuted: audioPub ? audioPub.isMuted : true,
        videoTrack: videoPub?.track ?? null,
        sharingScreen: videoPub?.source === Track.Source.ScreenShare,
        connectionQuality: p.connectionQuality,
      };
    };
    this.patch({
      participants: [
        build(room.localParticipant, true),
        ...[...room.remoteParticipants.values()].map((p) => build(p, false)),
      ],
    });
  }

  /** The LiveKit participant name is the member's email (see the auth service's
   * mint_room_token), so peer identity resolution needs no local roster. */
  private emailForIdentity = (identity: string): string => {
    const known = this.emailByIdentity.get(identity);
    if (known) return known;
    const p = this.room?.remoteParticipants.get(identity);
    if (p?.name) {
      this.emailByIdentity.set(identity, p.name);
      return p.name;
    }
    throw new Error(`no email known for participant ${identity}`);
  };

  private rememberEmails() {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      if (p.name) this.emailByIdentity.set(p.identity, p.name);
    }
  }

  async start(participants: string[], withVideo: boolean): Promise<void> {
    this.patch({ stage: "connecting", error: null });

    let grant;
    try {
      grant = await this.session.roomToken(participants);
    } catch (err) {
      this.patch({ stage: "failed", error: err instanceof Error ? err.message : "Couldn't get a room." });
      return;
    }
    this.patch({ roomName: grant.roomName });

    const audioDeviceId = await pickUsableAudioInput();

    this.keyProvider = new GroupKeyProvider();
    let worker: Worker | null = null;
    try {
      worker = createE2eeWorker();
    } catch {
      // Without the frame cryptor there is no media encryption. The call is
      // still allowed, but the UI must not claim it is encrypted.
      worker = null;
    }

    const room = new Room({
      publishDefaults: {
        simulcast: true,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      },
      // dynacast is a Room option, not a publishDefaults one. Nested under
      // publishDefaults it is silently dropped and never takes effect —
      // testing/webrtc-harness/app.js has it in the wrong place.
      dynacast: true,
      adaptiveStream: true,
      audioCaptureDefaults: audioDeviceId ? { deviceId: audioDeviceId } : undefined,
      // The key provider must exist before connect(), but starts empty — no key
      // is applied until startE2ee() runs, after connect(), once this client's
      // own identity is known. Until then media does not decrypt, which is the
      // correct fail-closed behaviour.
      e2ee: worker ? { keyProvider: this.keyProvider, worker } : undefined,
    });
    this.room = room;

    if (worker) await room.setE2EEEnabled(true);
    this.wire(room, Boolean(worker));

    try {
      // rtcConfig is a connect option, not a Room option. Passed to
      // `new Room({...})` it is silently discarded and the TURN list never
      // reaches ICE, so every call gathers only host/srflx.
      const connectOptions = {
        rtcConfig: { iceServers: iceServersFrom(grant.turnCredentials) },
      };
      // The losing side of a race still settles. Without this catch, a
      // connect() that eventually rejects after the timeout has already
      // fired surfaces as an unhandled rejection.
      const connecting = room
        .connect(grant.livekitUrl, grant.roomToken, connectOptions)
        .catch((err) => {
          if (this.state.stage === "failed") return;
          throw err;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connecting,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("connect() did not resolve in 20s — likely stuck in ICE gathering")),
              CONNECT_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.patch({ stage: "failed", error: err instanceof Error ? err.message : "Connection failed." });
      return;
    }

    this.patch({ stage: "connected", startedAtMs: Date.now() });
    this.rememberEmails();

    if (worker) {
      // Must happen BEFORE enabling camera/mic. A local track's frame cryptor
      // is created at publish time; if no key exists at that moment, frames
      // encode with MissingKey errors that persist even after a key is applied
      // later, because the existing cryptor does not retroactively pick one up.
      const ready = await this.startE2ee();
      if (ready) {
        try {
          await this.e2ee!.onMembershipChanged(this.membership());
        } catch {
          // The call is already connected and working; per-peer retry inside
          // the rotation path covers the common transient case.
        }
      }
    }

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      if (withVideo) await room.localParticipant.setCameraEnabled(true);
      this.patch({ micEnabled: true, cameraEnabled: withVideo });
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : "Couldn't open the camera or microphone." });
    }

    this.syncParticipants();
    this.startQualityReporting();
    void this.refreshCameraCount();
  }

  /** Device labels are empty until a camera permission has been granted, but
   * the count is available either way, which is all the toggle needs. */
  private async refreshCameraCount(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((d) => d.kind === "videoinput");
      this.patch({ canSwitchCamera: cameras.length > 1 });
    } catch {
      this.patch({ canSwitchCamera: false });
    }
  }

  /** Screen share is published as a separate track source, so it appears
   * alongside the camera rather than replacing it. */
  async toggleScreenShare(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const next = !this.state.screenSharing;
    try {
      await room.localParticipant.setScreenShareEnabled(next, { audio: true });
      this.patch({ screenSharing: next, error: null });
    } catch (err) {
      // The browser picker being dismissed throws; that is a cancel, not a
      // failure worth showing.
      if (err instanceof Error && /Permission denied|NotAllowedError|AbortError/i.test(err.name + err.message)) {
        this.patch({ screenSharing: false });
        return;
      }
      this.patch({ error: err instanceof Error ? err.message : "Couldn't share the screen." });
    }
    this.syncParticipants();
  }

  private async startE2ee(): Promise<boolean> {
    const room = this.room;
    if (!room || !this.keyProvider) return false;

    let identity: DeviceIdentity | null = null;
    try {
      identity = await loadIdentity(this.deviceId);
    } catch {
      identity = null;
    }

    this.e2ee = new GroupE2EE({
      keyProvider: this.keyProvider,
      sendData: (bytes, targets) => {
        room.localParticipant
          .publishData(bytes, { reliable: true, topic: DATA_TOPIC, destinationIdentities: targets })
          .catch(() => {});
      },
      fetchBundle: (email, peerDeviceId) => this.session.fetchBundle(email, peerDeviceId),
      fetchIdentity: (email, peerDeviceId) => this.session.fetchIdentity(email, peerDeviceId),
      emailForIdentity: this.emailForIdentity,
      onFingerprintChanged: (fp, generation) =>
        this.patch({ fingerprint: fp, generation, encrypted: true, rejoinNeeded: false }),
      onIdentitySafetyNumber: (peerIdentity, safetyNumber) =>
        this.patch({ safetyNumbers: { ...this.state.safetyNumbers, [peerIdentity]: safetyNumber } }),
      onIdentityChanged: async (updated) => {
        await saveIdentity(this.deviceId, updated);
      },
      onRejoinNeeded: () => this.patch({ rejoinNeeded: true }),
      onPartialRotationFailure: () => {},
    });

    try {
      const payload = await this.e2ee.initialize(room.localParticipant.identity, identity);
      const result = await this.session.publishPrekeys(payload);
      if (!identity) await saveIdentity(this.deviceId, this.e2ee.identity!);

      const unused = result.unused_one_time_prekeys;
      if (typeof unused === "number") {
        const topUp = await this.e2ee.topUpOneTimePrekeysIfLow(unused);
        if (topUp) {
          await this.session.publishPrekeys(topUp);
          await saveIdentity(this.deviceId, this.e2ee.identity!);
        }
      }
      return true;
    } catch (err) {
      this.patch({
        error: err instanceof Error ? `Encryption setup failed: ${err.message}` : "Encryption setup failed.",
      });
      return false;
    }
  }

  private wire(room: Room, encrypted: boolean) {
    const onMembership = () => {
      this.rememberEmails();
      this.syncParticipants();
      if (!encrypted) return;
      this.e2ee?.onMembershipChanged(this.membership()).catch(() => {});
    };

    room.on(RoomEvent.ParticipantConnected, onMembership);
    room.on(RoomEvent.ParticipantDisconnected, onMembership);
    room.on(RoomEvent.TrackSubscribed, () => this.syncParticipants());
    room.on(RoomEvent.TrackUnsubscribed, () => this.syncParticipants());
    room.on(RoomEvent.TrackMuted, () => this.syncParticipants());
    room.on(RoomEvent.TrackUnmuted, () => this.syncParticipants());
    room.on(RoomEvent.LocalTrackPublished, () => this.syncParticipants());
    room.on(RoomEvent.LocalTrackUnpublished, () => this.syncParticipants());
    room.on(RoomEvent.ActiveSpeakersChanged, () => this.syncParticipants());

    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== DATA_TOPIC || !participant) return;
      this.e2ee?.handleDataMessage(payload, participant.identity).catch(() => {});
    });

    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant !== room.localParticipant) {
        this.syncParticipants();
        return;
      }
      this.patch({ quality });
      if (quality === ConnectionQuality.Poor) {
        this.poorStreak += 1;
        if (this.poorStreak >= POOR_STREAK_AUTO_FALLBACK && !this.state.audioOnly) {
          this.setAudioOnly(true);
        }
      } else {
        this.poorStreak = 0;
      }
    });

    room.on(RoomEvent.Reconnecting, () => this.patch({ stage: "reconnecting" }));
    room.on(RoomEvent.Reconnected, () => this.patch({ stage: "connected" }));
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Connected && this.state.stage === "reconnecting") {
        this.patch({ stage: "connected" });
      }
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      this.patch({
        stage: "ended",
        error:
          reason === DisconnectReason.PARTICIPANT_REMOVED
            ? "This device was revoked."
            : this.state.error,
      });
      this.stopQualityReporting();
    });
  }

  private startQualityReporting() {
    this.stopQualityReporting();
    this.qualityTimer = setInterval(async () => {
      const room = this.room;
      if (!room || this.state.stage !== "connected") return;
      const stats = await sampleStats(room);
      const qualityName =
        this.state.quality === ConnectionQuality.Excellent
          ? "excellent"
          : this.state.quality === ConnectionQuality.Good
            ? "good"
            : this.state.quality === ConnectionQuality.Poor
              ? "poor"
              : null;
      try {
        await this.session.reportQuality({
          room_name: this.state.roomName,
          device_id: this.deviceId,
          connection_quality: qualityName,
          candidate_type: stats?.candidateType ?? null,
          relay_protocol: stats?.relayProtocol ?? null,
          rtt_ms: stats?.rttMs ?? null,
          jitter_ms: stats?.jitterMs ?? null,
          packet_loss_pct: stats?.packetLossPct ?? null,
          data_saver_on: this.state.dataSaver,
          audio_only: this.state.audioOnly,
        });
      } catch {
        // Losing a quality sample must never disturb the call.
      }
    }, QUALITY_REPORT_INTERVAL_MS);
  }

  private stopQualityReporting() {
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.qualityTimer = null;
  }

  async toggleMic(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const next = !this.state.micEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      this.patch({ micEnabled: next, error: null });
    } catch (err) {
      // A device unplugged mid-call, or permission revoked. Unhandled, this
      // left the button showing a state the track was not actually in.
      this.patch({ error: err instanceof Error ? err.message : "Couldn't switch the microphone." });
    }
    this.syncParticipants();
  }

  async toggleCamera(): Promise<void> {
    const room = this.room;
    if (!room || this.state.audioOnly) return;
    const next = !this.state.cameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(next);
      this.patch({ cameraEnabled: next, error: null });
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : "Couldn't switch the camera." });
    }
    this.syncParticipants();
  }

  async setAudioOnly(on: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!on && this.state.cameraEnabled);
    this.patch({ audioOnly: on, cameraEnabled: on ? false : this.state.cameraEnabled });
    this.syncParticipants();
  }

  /** Forces remote subscriptions to the lowest simulcast layer and caps the
   * local publish resolution — a label alone would not reduce any traffic. */
  async setDataSaver(on: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.kind !== Track.Kind.Video) continue;
        (pub as RemoteTrackPublication).setVideoQuality(on ? VideoQuality.LOW : VideoQuality.HIGH);
      }
    }
    const cameraPub = [...room.localParticipant.trackPublications.values()].find(
      (pub) => pub.source === Track.Source.Camera
    );
    const track = cameraPub?.track;
    if (track instanceof LocalVideoTrack) {
      await track.restartTrack(on ? VideoPresets.h180.resolution : VideoPresets.h720.resolution);
    }
    this.patch({ dataSaver: on });
  }

  async switchCamera(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput"
    );
    if (devices.length < 2) return;
    const current = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track
      ?.mediaStreamTrack.getSettings().deviceId;
    const next = devices.find((d) => d.deviceId !== current) ?? devices[0];
    await room.switchActiveDevice("videoinput", next.deviceId);
  }

  async hangUp(): Promise<void> {
    this.stopQualityReporting();
    try {
      await this.room?.disconnect();
    } catch {
      // Already gone.
    }
    this.patch({ stage: "ended" });
  }

  dispose(): void {
    this.stopQualityReporting();
    this.room?.disconnect().catch(() => {});
    this.room = null;
    this.disposed = true;
  }

  attachRemoteAudio(container: HTMLElement): () => void {
    const room = this.room;
    if (!room) return () => {};
    const onSubscribed = (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      // An audio element must be in the document to reliably produce sound,
      // even though the track itself is already flowing.
      const el = track.attach();
      el.style.display = "none";
      container.appendChild(el);
    };

    // LiveKit auto-subscribes during connect(), so by the time the UI mounts
    // this, the other party's audio is usually ALREADY subscribed and would
    // never fire the event below -- whoever joined second would hear nothing.
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === Track.Kind.Audio && publication.track) {
          onSubscribed(publication.track as RemoteTrack);
        }
      }
    }
    const onUnsubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
    };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
      container.replaceChildren();
    };
  }
}

export { ConnectionQuality, disconnectReasonName };
