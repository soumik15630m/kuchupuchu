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

import { GroupKeyProvider, createE2eeWorker } from "./key-provider.js";
import { GroupE2EE, DATA_TOPIC } from "./group-e2ee.js";
import { loadIdentity, saveIdentity } from "./identity-store.js";

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

// Derived from the LiveKit URL, not the page origin: nginx proxies
// both LiveKit signaling and /auth/ from the same server block, and
// this harness is not always served from that origin.
function apiBaseUrl() {
  const liveKitUrl = document.getElementById("url").value.trim();
  if (!liveKitUrl) return "";
  return liveKitUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/$/, "");
}

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

const safetyNumbersByPeer = new Map();
function updateSafetyNumberUi(peerIdentity, safetyNumber) {
  safetyNumbersByPeer.set(peerIdentity, safetyNumber);
  const list = document.getElementById("safetyNumberList");
  list.innerHTML = "";
  for (const [identity, sn] of safetyNumbersByPeer) {
    const li = document.createElement("li");
    li.textContent = `${identity}: ${sn}`;
    list.appendChild(li);
  }
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
      const res = await fetch(`${apiBaseUrl()}/auth/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(deviceId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`prekey bundle fetch failed for ${deviceId}: ${res.status}`);
      return res.json();
    },
    // Separate endpoint from fetchBundle on purpose: this one does not
    // consume a one-time prekey, so verifying an inbound X3DH initial
    // message can't be used to drain a peer's prekey pool.
    fetchIdentity: async (email, deviceId) => {
      const res = await fetch(
        `${apiBaseUrl()}/auth/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(deviceId)}/identity`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) throw new Error(`identity fetch failed for ${deviceId}: ${res.status}`);
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
    onIdentityChanged: async (identity) => {
      // A one-time prekey was just consumed; re-persist so a reload
      // can't bring it back.
      await saveIdentity(currentDeviceId(), identity);
    },
    onIdentitySafetyNumber: (peerIdentity, safetyNumber) => {
      log(`E2EE identity safety number for ${peerIdentity}: ${safetyNumber}`);
      updateSafetyNumberUi(peerIdentity, safetyNumber);
    },
    onRejoinNeeded: showRejoinPrompt,
    onPartialRotationFailure: (unreachedPeerIdentities) => {
      log(`E2EE: room key delivered, but couldn't reach ${unreachedPeerIdentities.join(", ")} yet (will recover automatically once reachable)`);
    },
  });

  // Only valid after connect() resolves; earlier it would publish under
  // "unknown-device" and every peer's fetch for us would 404.
  const deviceId = currentDeviceId();

  // The identity key is write-once server side: a fresh one for an
  // existing device id 409s and can never be published again.
  const storedIdentity = await loadIdentity(deviceId);
  if (storedIdentity) log(`E2EE: reusing stored crypto identity for ${deviceId}`);

  const publishPayload = await e2ee.initialize(deviceId, storedIdentity);
  const res = await fetch(`${apiBaseUrl()}/auth/prekeys/me`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(publishPayload),
  });
  if (!res.ok) {
    // setE2EEEnabled(true) has already run, so without disabling it
    // below the call continues with encryption active and no key:
    // every frame fails forever. A 409 means the device already
    // published a different identity key.
    if (res.status === 409) {
      log(
        "E2EE: this device id already published a different identity key (409). " +
          "The harness keeps its crypto identity in memory, so a page reload generates a new one -- " +
          "use a fresh device id, or reconnect without reloading."
      );
    } else {
      log(`E2EE: publishing prekey bundle failed (${res.status})`);
    }
    try {
      await room.setE2EEEnabled(false);
      log("E2EE: DISABLED for this call — media is NOT end-to-end encrypted. Reconnect with a fresh device id to restore it.");
    } catch (err) {
      log(`E2EE: could not disable frame encryption after the failure (${err.message}) — disconnect and start over`);
    }
    e2ee = null;
    return false;
  }
  log("E2EE: prekey bundle published");
  // Only after the server accepted it -- saving earlier would strand an
  // identity the server never took.
  if (!storedIdentity) {
    await saveIdentity(deviceId, e2ee.identity);
    log(`E2EE: crypto identity stored for ${deviceId} — survives reload`);
  }
  return true;
}

function currentRoomMembership() {
  // null, not 0: 0 would look like the earliest joiner and win the
  // rotator election. See electRotator.
  const joinedAtMs = (p) => p.joinedAt?.getTime() ?? null;
  const local = { identity: room.localParticipant.identity, joinedAtMs: joinedAtMs(room.localParticipant) };
  const remotes = [...room.remoteParticipants.values()].map((p) => ({
    identity: p.identity,
    joinedAtMs: joinedAtMs(p),
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
    await fetch(`${apiBaseUrl()}/auth/quality/report`, {
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

/** The default microphone and a microphone that opens are not the same
 * thing: a Bluetooth headset in A2DP mode advertises an audioinput the
 * browser selects and then fails to open with NotReadableError, which
 * looks like a permissions fault and isn't. Returns null to let the
 * browser choose if nothing opens. */
async function pickUsableAudioInput() {
  let devices;
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    return null;
  }
  // "default"/"communications" point at whichever device Windows
  // favours, which is the thing being worked around.
  const real = devices.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
  for (const d of real.length ? real : devices) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } });
      stream.getTracks().forEach((t) => t.stop());
      return { deviceId: d.deviceId, label: d.label };
    } catch {
      // A device that won't open is what we're here to skip.
    }
  }
  return null;
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

  const relayOnly = new URLSearchParams(location.search).get("relay") === "1";
  if (relayOnly) {
    log("relay-only mode: forcing all media through TURN (?relay=1)");
    if (!iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)))) {
      log("  WARNING: no TURN server in the ICE list -- relay-only will find no candidates at all");
    }
  }

  await probeIceConnectivity(iceServers);

  // Pick a microphone that actually opens, before LiveKit picks one that
  // doesn't. See pickUsableAudioInput.
  const audioInput = await pickUsableAudioInput();
  if (audioInput) {
    log(`microphone: using "${audioInput.label || audioInput.deviceId}"`);
  } else {
    log("microphone: no audio input could be opened -- the call will be video-only if publishing fails");
  }

  const e2eeUserWantsIt = document.getElementById("e2eeEnabled").checked;
  const keyProvider = makeKeyProvider();
  let e2eeWorker = null;
  if (e2eeUserWantsIt) {
    try {
      e2eeWorker = await createE2eeWorker();
    } catch (err) {
      log(`E2EE: could not load the frame-cryptor worker (${err.message}) — this call will be unencrypted`);
    }
  } else {
    log("E2EE: disabled via checkbox for this connection");
  }

  room = new Room({
    // §13 Phase 3: simulcast + Dynacast + adaptive stream.
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      dynacast: true,
    },
    adaptiveStream: true,
    audioCaptureDefaults: audioInput ? { deviceId: audioInput.deviceId } : undefined,
    // rtcConfig is a connect option, not a room option -- see connect().
    // §6/§13 Phase 4: the key provider has to exist before connect() per
    // LiveKit's own setup order, but it starts out empty -- no key is
    // applied until publishPrekeysAndStartE2ee() runs after connect(),
    // once our real identity is known. Until then media just won't
    // decrypt for anyone, which is the correct fail-closed behavior.
    e2ee: e2eeWorker ? { keyProvider, worker: e2eeWorker } : undefined,
  });

  if (e2eeWorker) {
    await room.setE2EEEnabled(true);
    room.on(RoomEvent.ParticipantConnected, () => {
      e2ee?.onMembershipChanged(currentRoomMembership()).catch((err) => log(`E2EE: membership-change handling failed: ${err.message}`));
    });
    room.on(RoomEvent.ParticipantDisconnected, () => {
      e2ee?.onMembershipChanged(currentRoomMembership()).catch((err) => log(`E2EE: membership-change handling failed: ${err.message}`));
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic === DATA_TOPIC && participant) {
        e2ee?.handleDataMessage(payload, participant.identity).catch((err) => log(`E2EE: data-message handling failed: ${err.message}`));
      }
    });
    room.on(RoomEvent.EncryptionError, (error) => {
      // The worker re-wraps failures as a plain Error before postMessage,
      // so only name/message/stack survive the structured clone. The
      // message is prefixed with the CryptorError reason name.
      log(`E2EE: EncryptionError -- ${error.name ?? "Error"}: ${error.message ?? String(error)}`);
    });
  }

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
    } else if (track.kind === Track.Kind.Audio) {
      // Needs to actually be in the DOM to play in most browsers --
      // a detached element from track.attach() won't reliably produce
      // sound even though the track itself is flowing correctly.
      const el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);
      log("subscribed to audio from", participant.identity);
    }
  });

  const CONNECT_TIMEOUT_MS = 20000;
  const startedAt = performance.now();
  try {
    // livekit reads this as `engine.rtcConfig = connOptions.rtcConfig`.
    // Passed to `new Room({...})` instead it is silently discarded and
    // the TURN list never reaches the SFU -- every call then gathers
    // only host/srflx and the relay is never a candidate.
    const connectOptions = iceServers.length
      ? { rtcConfig: { iceServers, ...(relayOnly ? { iceTransportPolicy: "relay" } : {}) } }
      : undefined;

    await Promise.race([
      room.connect(url, token, connectOptions),
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
  log("connected as", room.localParticipant.identity);

  if (e2eeWorker) {
    // This has to happen BEFORE enableCameraAndMicrophone() below, not
    // after. An earlier version did E2EE setup second, which produced a
    // real, reproducible bug: the local track's frame-cryptor gets
    // created at publish time, and if no key exists yet at that moment,
    // frames start encoding with MissingKey errors that persist even
    // after applyRoomKey() later succeeds -- the already-created cryptor
    // doesn't retroactively pick up a key that didn't exist when it was
    // set up. Establishing the key first means the cryptor is created
    // with a real key already in place from the start.
    const e2eeReady = await publishPrekeysAndStartE2ee(keyProvider);
    if (e2eeReady) {
      try {
        await e2ee.onMembershipChanged(currentRoomMembership());
      } catch (err) {
        // The call itself is already connected and working at this
        // point (media negotiated, quality reporting underway) -- an
        // E2EE setup hiccup here is a separate, narrower problem than
        // "the connection failed", and letting it propagate up to the
        // outer try/catch would misleadingly log it as exactly that.
        // _rotate()'s own per-peer retry/resilience (see group-e2ee.js)
        // handles the common transient case (a peer's bundle not
        // published yet); this catch is the backstop for whatever gets
        // past that.
        log(`E2EE: initial setup failed (${err.message}) — call continues, E2EE may not be established yet`);
      }
    }
  }

  try {
    await room.localParticipant.enableCameraAndMicrophone();
    const localTrack = [...room.localParticipant.trackPublications.values()].find(
      (p) => p.kind === Track.Kind.Video
    )?.track;
    if (localTrack) localTrack.attach(document.getElementById("localVideo"));
  } catch (err) {
    // NOT a camera/mic access problem -- confirmed via chrome://webrtc-internals
    // that getUserMedia() itself succeeds in under a second, every time, with
    // real hardware. This NegotiationError comes from the step after that:
    // LiveKit renegotiating the peer connection to actually publish the
    // already-acquired track to the SFU. That renegotiation stalling is
    // suspiciously well-correlated with the ICE-restart cycling seen
    // elsewhere in this file's logs -- worth treating as one bug, not two,
    // until proven otherwise. The e2eeEnabled checkbox exists specifically
    // to test whether this is an E2EE/frame-cryptor interaction.
    log(`track-publish negotiation failed (${err.name ?? "Error"}: ${err.message}) — falling back to audio-only`);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (micErr) {
      log(`microphone track-publish also failed (${micErr.name ?? "Error"}: ${micErr.message}) — continuing with no local media`);
    }
  }

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
  safetyNumbersByPeer.clear();
  document.getElementById("safetyNumberList").innerHTML = "";
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

// `?device=<id>` pre-fills the form from a staged config file, so the
// second device doesn't hand-type a room token on a phone. That file
// holds real tokens -- local testing only, delete after use.
async function prefillFromQuery() {
  const deviceId = new URLSearchParams(location.search).get("device");
  if (!deviceId) return;
  try {
    const res = await fetch(`./e2e-config.json?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    const cfg = (await res.json())[deviceId];
    if (!cfg) throw new Error(`no entry for "${deviceId}" in e2e-config.json`);
    document.getElementById("url").value = cfg.url;
    document.getElementById("token").value = cfg.token;
    document.getElementById("accessToken").value = cfg.accessToken;
    document.getElementById("ice").value = JSON.stringify(cfg.ice);
    document.getElementById("roster").value = JSON.stringify(cfg.roster);
    log(`pre-filled for ${deviceId} — press Connect`);
  } catch (err) {
    log(`could not pre-fill from ?device=${deviceId}: ${err.message}`);
  }
}
prefillFromQuery();

document.getElementById("connectBtn").addEventListener("click", () => connect().catch((e) => log("connect failed:", e.message)));
document.getElementById("disconnectBtn").addEventListener("click", disconnect);
document.getElementById("dataSaverBtn").addEventListener("click", () => setDataSaver(!dataSaverOn));
document.getElementById("audioOnlyBtn").addEventListener("click", () => setAudioOnly(!audioOnly));
