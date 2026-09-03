// §13 Phase 3 test harness logic. Not a Phase 5 client — see README.
//
// LiveKit's client SDK loads from a pinned CDN <script> in index.html
// (UMD build, global `LivekitClient`) with an SRI hash, so this harness
// still needs no build step and no vendored copy to keep updated.
const {
  Room,
  RoomEvent,
  VideoPresets,
  VideoQuality,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  Track,
} = LivekitClient;

import { GroupKeyProvider, E2EE_WORKER_URL } from "./key-provider.js";
import { GroupE2EE, DATA_TOPIC } from "./group-e2ee.js";

const logEl = document.getElementById("log");
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}`;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
}

let room = null;
let dataSaverOn = false;
let audioOnly = false;
let poorQualityStreak = 0;
let e2ee = null;

function parseRoster() {
  try {
    return JSON.parse(document.getElementById("roster").value.trim() || "{}");
  } catch {
    log("device→email roster is not valid JSON, E2EE session establishment will fail for anyone not already known");
    return {};
  }
}

function updateFingerprintUi(fp, generation) {
  document.getElementById("e2eeFingerprint").textContent = `${fp} (generation ${generation})`;
}

function showRejoinPrompt() {
  log("E2EE: room key fingerprints disagree after a retry — prompting rejoin (§6.1)");
  document.getElementById("rejoinPrompt").style.display = "block";
}

function makeKeyProvider() {
  return new GroupKeyProvider();
}

async function publishPrekeysAndStartE2ee(keyProvider) {
  const accessToken = document.getElementById("accessToken").value.trim();
  const roster = parseRoster();

  e2ee = new GroupE2EE({
    keyProvider,
    sendData: (payloadBytes, targetIdentities) => {
      room.localParticipant.publishData(payloadBytes, {
        reliable: true,
        topic: DATA_TOPIC,
        destinationIdentities: targetIdentities,
      });
    },
    fetchBundle: async (email, deviceId) => {
      const res = await fetch(`/auth/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(deviceId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`prekey bundle fetch failed for ${deviceId}: ${res.status}`);
      return res.json();
    },
    emailForIdentity: (identity) => {
      const email = roster[identity];
      if (!email) throw new Error(`no email in the device→email roster for identity "${identity}"`);
      return email;
    },
    onFingerprintChanged: (fp, generation) => {
      log(`E2EE fingerprint: ${fp} (generation ${generation})`);
      updateFingerprintUi(fp, generation);
    },
    onRejoinNeeded: showRejoinPrompt,
  });

  // currentDeviceId() only returns the real identity once room.connect()
  // has resolved -- calling this any earlier would publish a bundle
  // under "unknown-device" and every peer's bundle fetch for us would
  // 404 forever. This function is only ever called after connect().
  const publishPayload = await e2ee.initialize(currentDeviceId());
  const res = await fetch("/auth/prekeys/me", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(publishPayload),
  });
  if (!res.ok) {
    log(`E2EE: publishing prekey bundle failed (${res.status}) — calls in this session will be unencrypted`);
    e2ee = null;
    return false;
  }
  log("E2EE: prekey bundle published");
  return true;
}

function currentRoomMembership() {
  const local = { identity: room.localParticipant.identity, joinedAtMs: room.localParticipant.joinedAt?.getTime() ?? 0 };
  const remotes = [...room.remoteParticipants.values()].map((p) => ({
    identity: p.identity,
    joinedAtMs: p.joinedAt?.getTime() ?? 0,
  }));
  return [local, ...remotes];
}

// §13 Phase 3: sustained poor quality auto-triggers audio-only fallback
// rather than waiting for the person to notice and toggle it themselves.
const POOR_STREAK_AUTO_FALLBACK = 4; // consecutive poor readings (~ this many * quality-report interval)
const QUALITY_REPORT_INTERVAL_MS = 5000;

function currentDeviceId() {
  // The harness doesn't do device registration itself (that's Phase 1/2's
  // auth flow, done separately to get the room token) -- reuse the LiveKit
  // participant identity, which *is* the device id (see mint_room_token's
  // docstring in the auth-service).
  return room?.localParticipant?.identity ?? "unknown-device";
}

async function reportQuality(candidateInfo) {
  const accessToken = document.getElementById("accessToken").value.trim();
  if (!accessToken || !room) return;
  try {
    await fetch("/auth/quality/report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        room_name: room.name,
        device_id: currentDeviceId(),
        connection_quality: lastQuality,
        candidate_type: candidateInfo?.candidateType ?? null,
        relay_protocol: candidateInfo?.relayProtocol ?? null,
        rtt_ms: candidateInfo?.rttMs ?? null,
        jitter_ms: candidateInfo?.jitterMs ?? null,
        packet_loss_pct: candidateInfo?.packetLossPct ?? null,
        data_saver_on: dataSaverOn,
        audio_only: audioOnly,
      }),
    });
  } catch (err) {
    log("quality report failed:", err.message);
  }
}

// Extracts the winning ICE candidate pair (type + relay protocol) and basic
// RTT/jitter/loss off whichever local track is publishing, via the SDK's
// public getRTCStatsReport() -- this is what actually tells you whether a
// call went host/srflx/relay-UDP/relay-TCP, which is the specific signal
// §13 Phase 3's done-bar asks the dashboard to show.
async function sampleStats() {
  const pub = room?.localParticipant && [...room.localParticipant.trackPublications.values()][0];
  const track = pub?.track;
  if (!track || typeof track.getRTCStatsReport !== "function") return null;

  let report;
  try {
    report = await track.getRTCStatsReport();
  } catch {
    return null;
  }

  let selectedPairId = null;
  for (const stat of report.values()) {
    if (stat.type === "transport" && stat.selectedCandidatePairId) {
      selectedPairId = stat.selectedCandidatePairId;
      break;
    }
  }
  if (!selectedPairId) {
    // Firefox doesn't emit a 'transport' stat with selectedCandidatePairId
    // -- it marks the winning pair directly via candidate-pair's own
    // 'selected' field (or 'nominated' + a succeeded state on older
    // versions). Chrome's candidate-pair stats also carry these fields,
    // so this fallback is harmless there too.
    for (const stat of report.values()) {
      if (
        stat.type === "candidate-pair" &&
        (stat.selected === true || (stat.nominated && stat.state === "succeeded"))
      ) {
        selectedPairId = stat.id;
        break;
      }
    }
  }
  if (!selectedPairId) return null;

  const pair = report.get(selectedPairId);
  if (!pair) return null;

  const localCandidate = report.get(pair.localCandidateId);
  const rttMs = pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null;

  let jitterMs = null;
  let packetLossPct = null;
  for (const stat of report.values()) {
    if (stat.type === "inbound-rtp" && stat.kind === "audio") {
      if (stat.jitter != null) jitterMs = stat.jitter * 1000;
      if (stat.packetsLost != null && stat.packetsReceived != null) {
        const total = stat.packetsLost + stat.packetsReceived;
        packetLossPct = total > 0 ? (stat.packetsLost / total) * 100 : 0;
      }
    }
  }

  return {
    candidateType: localCandidate?.candidateType ?? null, // host | srflx | relay
    relayProtocol: localCandidate?.relayProtocol ?? null, // udp | tcp | tls
    rttMs,
    jitterMs,
    packetLossPct,
  };
}

let lastQuality = null;

// §13 Phase 3 stricter diagnostics: LiveKit's Disconnected event only
// hands back a numeric DisconnectReason -- "disconnected: 2" told nobody
// anything actionable. Map it to the name so DUPLICATE_IDENTITY vs.
// PARTICIPANT_REMOVED vs. an actual ICE failure are distinguishable at a
// glance instead of requiring a trip to livekit-client's source or the
// server-side logs to decode.
function disconnectReasonName(reason) {
  if (reason == null) return "(none)";
  const match = Object.entries(DisconnectReason).find(([, value]) => value === reason);
  return match ? `${match[0]} (${reason})` : `UNKNOWN (${reason})`;
}

// §13 Phase 3 stricter diagnostics: opens a throwaway RTCPeerConnection
// with the same ICE server list the real connection will use, and logs
// every candidate type/protocol the browser can actually gather *before*
// attempting room.connect() -- so "no reachable host/srflx candidate" or
// "TURN/TLS unreachable" shows up immediately instead of manifesting 20+
// seconds later as an opaque "could not establish pc connection".
async function probeIceConnectivity(iceServers) {
  if (!iceServers.length) {
    log("ICE probe skipped: no ICE servers configured");
    return;
  }
  log("probing ICE connectivity with configured servers...");
  const pc = new RTCPeerConnection({ iceServers });
  const seen = new Set();

  await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 4000);
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      const c = event.candidate;
      const key = `${c.type}/${c.protocol}${c.relayProtocol ? "/" + c.relayProtocol : ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        log(`  ICE candidate available: ${key}`);
      }
    };
    pc.createDataChannel("probe");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  });

  pc.close();
  if (seen.size === 0) {
    log("  WARNING: no ICE candidates gathered at all -- check network/firewall before connecting");
  } else if (![...seen].some((k) => k.startsWith("relay"))) {
    log("  note: no relay (TURN) candidates gathered -- fine if host/srflx succeed, but TURN/TLS fallback won't be available if they don't");
  }
}

async function connect() {
  const url = document.getElementById("url").value.trim();
  const token = document.getElementById("token").value.trim();
  let iceServers = [];
  try {
    iceServers = JSON.parse(document.getElementById("ice").value.trim() || "[]");
  } catch {
    log("ICE server list is not valid JSON, connecting without it");
  }

  await probeIceConnectivity(iceServers);

  const keyProvider = makeKeyProvider();

  room = new Room({
    // §13 Phase 3: simulcast + Dynacast + adaptive stream.
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      dynacast: true,
    },
    adaptiveStream: true,
    rtcConfig: iceServers.length ? { iceServers } : undefined,
    // §6/§13 Phase 4: the key provider has to exist before connect() per
    // LiveKit's own setup order, but it starts out empty -- no key is
    // applied until publishPrekeysAndStartE2ee() runs after connect(),
    // once our real identity is known. Until then media just won't
    // decrypt for anyone, which is the correct fail-closed behavior.
    e2ee: { keyProvider, worker: new Worker(E2EE_WORKER_URL) },
  });

  await room.setE2EEEnabled(true);
  room.on(RoomEvent.ParticipantConnected, () => e2ee?.onMembershipChanged(currentRoomMembership()));
  room.on(RoomEvent.ParticipantDisconnected, () => e2ee?.onMembershipChanged(currentRoomMembership()));
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === DATA_TOPIC && participant) e2ee?.handleDataMessage(payload, participant.identity);
  });

  room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    if (participant !== room.localParticipant) return;
    lastQuality = quality;
    log("connection quality:", quality);
    if (quality === ConnectionQuality.Poor) {
      poorQualityStreak += 1;
      if (poorQualityStreak >= POOR_STREAK_AUTO_FALLBACK && !audioOnly) {
        log(`sustained poor quality (${poorQualityStreak}x) — auto-falling back to audio-only`);
        setAudioOnly(true);
      }
    } else {
      poorQualityStreak = 0;
    }
  });

  room.on(RoomEvent.ConnectionStateChanged, (state) => {
    log("connection state:", state);
    if (state === ConnectionState.Disconnected) {
      log("  (if this followed a long silent wait, check: ICE probe output above, " +
          "LIVEKIT_USE_EXTERNAL_IP in .env for local testing, and `docker compose logs livekit`)");
    }
  });

  room.on(RoomEvent.Reconnecting, () => log("reconnecting (ICE restart in progress)..."));
  room.on(RoomEvent.Reconnected, async () => {
    log("reconnected");
    const stats = await sampleStats();
    if (stats) {
      log(
        `post-reconnect candidate: ${stats.candidateType ?? "?"}` +
          (stats.relayProtocol ? ` (${stats.relayProtocol})` : "")
      );
    }
  });
  room.on(RoomEvent.Disconnected, (reason) => log("disconnected:", disconnectReasonName(reason)));

  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === Track.Kind.Video) {
      const el = track.attach();
      el.style.width = "320px";
      document.getElementById("remoteVideos").appendChild(el);
      log("subscribed to video from", participant.identity);
    }
  });

  const CONNECT_TIMEOUT_MS = 20000;
  const startedAt = performance.now();
  try {
    await Promise.race([
      room.connect(url, token),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`connect() did not resolve within ${CONNECT_TIMEOUT_MS}ms -- likely stuck in ICE gathering/checking`)),
          CONNECT_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    // ConnectionError (livekit-client's own error type) carries .reason and
    // .status beyond the generic message -- surface them when present
    // instead of just err.message, which for ICE failures is often just
    // "could not establish pc connection" with no further detail.
    log(`connect failed: ${err.name ?? "Error"}: ${err.message}`);
    if (err.reason !== undefined) log(`  reason: ${err.reason}`);
    if (err.status !== undefined) log(`  status: ${err.status}`);
    throw err;
  }
  log(`connect() resolved in ${Math.round(performance.now() - startedAt)}ms`);

  await room.localParticipant.enableCameraAndMicrophone();
  const localTrack = [...room.localParticipant.trackPublications.values()].find(
    (p) => p.kind === Track.Kind.Video
  )?.track;
  if (localTrack) localTrack.attach(document.getElementById("localVideo"));

  log("connected as", room.localParticipant.identity);
  const e2eeReady = await publishPrekeysAndStartE2ee(keyProvider);
  if (e2eeReady) await e2ee.onMembershipChanged(currentRoomMembership());

  setInterval(async () => {
    if (!room || room.state !== "connected") return;
    const stats = await sampleStats();
    await reportQuality(stats);
  }, QUALITY_REPORT_INTERVAL_MS);
}

async function disconnect() {
  await room?.disconnect();
  room = null;
  e2ee = null;
  document.getElementById("remoteVideos").innerHTML = "";
  document.getElementById("e2eeFingerprint").textContent = "not connected";
  document.getElementById("rejoinPrompt").style.display = "none";
}

// §13 Phase 3: data-saver -- forces every remote video subscription to LOW
// and republishes local video at a reduced resolution/bitrate preset,
// rather than just being a UI label with no real effect.
async function setDataSaver(on) {
  dataSaverOn = on;
  document.getElementById("dataSaverBtn").classList.toggle("active", on);
  if (!room) return;

  for (const participant of room.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.kind === Track.Kind.Video && pub.setVideoQuality) {
        pub.setVideoQuality(on ? VideoQuality.LOW : VideoQuality.HIGH);
      }
    }
  }

  const videoPub = [...room.localParticipant.trackPublications.values()].find(
    (p) => p.kind === Track.Kind.Video
  );
  if (videoPub?.track) {
    await videoPub.track.restartTrack({
      resolution: on ? VideoPresets.h180.resolution : VideoPresets.h720.resolution,
    });
  }
  log("data saver:", on ? "on" : "off");
}

async function setAudioOnly(on) {
  audioOnly = on;
  document.getElementById("audioOnlyBtn").classList.toggle("active", on);
  if (!room) return;
  await room.localParticipant.setCameraEnabled(!on);
  log("audio-only:", on ? "on" : "off");
}

document.getElementById("connectBtn").addEventListener("click", () => connect().catch((e) => log("connect failed:", e.message)));
document.getElementById("disconnectBtn").addEventListener("click", disconnect);
document.getElementById("dataSaverBtn").addEventListener("click", () => setDataSaver(!dataSaverOn));
document.getElementById("audioOnlyBtn").addEventListener("click", () => setAudioOnly(!audioOnly));
