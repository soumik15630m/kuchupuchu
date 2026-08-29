// §13 Phase 3 test harness logic. Not a Phase 5 client — see README.
//
// Loaded as an ES module; pulls the LiveKit client SDK from a CDN so this
// harness needs no build step.
import {
  Room,
  RoomEvent,
  VideoPresets,
  ConnectionQuality,
  Track,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";

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

async function connect() {
  const url = document.getElementById("url").value.trim();
  const token = document.getElementById("token").value.trim();
  let iceServers = [];
  try {
    iceServers = JSON.parse(document.getElementById("ice").value.trim() || "[]");
  } catch {
    log("ICE server list is not valid JSON, connecting without it");
  }

  room = new Room({
    // §13 Phase 3: simulcast + Dynacast + adaptive stream.
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      dynacast: true,
    },
    adaptiveStream: true,
    rtcConfig: iceServers.length ? { iceServers } : undefined,
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
  room.on(RoomEvent.Disconnected, (reason) => log("disconnected:", reason ?? ""));

  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === Track.Kind.Video) {
      const el = track.attach();
      el.style.width = "320px";
      document.getElementById("remoteVideos").appendChild(el);
      log("subscribed to video from", participant.identity);
    }
  });

  await room.connect(url, token);
  await room.localParticipant.enableCameraAndMicrophone();
  const localTrack = [...room.localParticipant.trackPublications.values()].find(
    (p) => p.kind === Track.Kind.Video
  )?.track;
  if (localTrack) localTrack.attach(document.getElementById("localVideo"));

  log("connected as", room.localParticipant.identity);

  setInterval(async () => {
    if (!room || room.state !== "connected") return;
    const stats = await sampleStats();
    await reportQuality(stats);
  }, QUALITY_REPORT_INTERVAL_MS);
}

async function disconnect() {
  await room?.disconnect();
  room = null;
  document.getElementById("remoteVideos").innerHTML = "";
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
        pub.setVideoQuality(on ? 0 /* LOW */ : 2 /* HIGH */);
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
