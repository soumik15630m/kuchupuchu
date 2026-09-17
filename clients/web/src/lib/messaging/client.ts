import type { Session, WireMessage } from "../api/client";
import { decryptBlob } from "./media";
import { SessionManager, decodeContent, encodeContent, type MessageEnvelope } from "./sessions";
import {
  advanceStatus,
  getMessage,
  putMessage,
  type MediaRef,
  type StoredMessage,
} from "./store";

/** The plaintext inside an envelope. Everything user-visible lives here; the
 * server sees only the sealed form. */
interface Content {
  kind: "text" | "media" | "voice";
  body: string;
  media?: MediaRef;
  sentAtMs: number;
}

export interface TypingEvent {
  fromEmail: string;
  stopped: boolean;
}

export interface MessagingEvents {
  onMessage: (message: StoredMessage) => void;
  onStatus: (message: StoredMessage) => void;
  onTyping: (event: TypingEvent) => void;
  onConnectionChange: (online: boolean) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TYPING_THROTTLE_MS = 2500;

export class MessagingClient {
  private socket: WebSocket | null = null;
  private readonly sessions: SessionManager;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastTypingSentAt = 0;
  private readonly deviceCache = new Map<string, { devices: string[]; fetchedAtMs: number }>();

  constructor(
    private readonly api: Session,
    private readonly deviceId: string,
    private readonly events: MessagingEvents
  ) {
    this.sessions = new SessionManager(api, deviceId);
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.sessions.ensureIdentity();
    this.connect();
    // The socket delivers its own backlog on open, but a send that happened
    // while this client was entirely offline is only in /pending.
    await this.drainPending();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let url: string;
    try {
      url = await this.api.socketUrl();
    } catch {
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.events.onConnectionChange(true);
    };
    socket.onclose = () => {
      this.events.onConnectionChange(false);
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (event) => {
      void this.handleFrame(event.data);
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    // Exponential backoff with jitter: without the jitter, both of a person's
    // devices reconnect in lockstep after a server restart.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        void this.connect();
      },
      delay * (0.7 + Math.random() * 0.6)
    );
  }

  private async handleFrame(raw: unknown): Promise<void> {
    if (typeof raw !== "string") return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    switch (frame.type) {
      case "backlog":
        for (const wire of (frame.messages as WireMessage[]) ?? []) {
          await this.ingest(wire);
        }
        break;
      case "message":
        await this.ingest(frame.message as WireMessage);
        break;
      case "delivered":
      case "read": {
        const updated = await advanceStatus(
          String(frame.client_msg_id),
          frame.type === "read" ? "read" : "delivered"
        );
        if (updated) this.events.onStatus(updated);
        break;
      }
      case "typing":
        this.events.onTyping({
          fromEmail: String(frame.from_email),
          stopped: Boolean(frame.stopped),
        });
        break;
    }
  }

  private async drainPending(): Promise<void> {
    try {
      const { messages } = await this.api.pendingMessages();
      for (const wire of messages) await this.ingest(wire);
    } catch {
      // Offline. The socket's backlog frame covers it once connected.
    }
  }

  private async ingest(wire: WireMessage): Promise<void> {
    if (!wire) return;
    // The same logical message arrives once per device and can also repeat
    // across a backlog replay; the client id is what makes it idempotent.
    if (await getMessage(wire.client_msg_id)) {
      await this.acknowledge(wire.id);
      return;
    }

    let content: Content;
    try {
      const envelope = JSON.parse(wire.envelope) as MessageEnvelope;
      const plaintext = await this.sessions.decrypt(wire.from_email, wire.from_device, envelope);
      content = decodeContent<Content>(plaintext);
    } catch (err) {
      // A message that will never decrypt must still be acknowledged, or the
      // server redelivers it on every reconnect forever.
      console.warn("messaging: could not decrypt a message", err);
      await this.acknowledge(wire.id);
      return;
    }

    const stored: StoredMessage = {
      id: wire.client_msg_id,
      chatId: wire.from_email,
      fromEmail: wire.from_email,
      outgoing: false,
      kind: content.kind,
      body: content.body,
      media: content.media,
      sentAtMs: content.sentAtMs || Date.parse(wire.created_at) || Date.now(),
      status: "delivered",
    };
    await putMessage(stored);
    this.events.onMessage(stored);
    await this.acknowledge(wire.id);
  }

  private async acknowledge(serverId: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "delivered", message_ids: [serverId] }));
      return;
    }
    try {
      await this.api.ackDelivered([serverId]);
    } catch {
      // Redelivered on the next connect, which is the point of the queue.
    }
  }

  private async devicesFor(email: string): Promise<string[]> {
    const cached = this.deviceCache.get(email);
    // A peer adding a device mid-conversation must start receiving without a
    // reload, but re-fetching on every keystroke-sized message is wasteful.
    if (cached && Date.now() - cached.fetchedAtMs < 60_000) return cached.devices;
    const { devices } = await this.api.peerDevices(email);
    this.deviceCache.set(email, { devices, fetchedAtMs: Date.now() });
    return devices;
  }

  async send(
    peerEmail: string,
    content: Omit<Content, "sentAtMs"> & { sentAtMs?: number }
  ): Promise<StoredMessage> {
    const clientMsgId = crypto.randomUUID();
    const sentAtMs = content.sentAtMs ?? Date.now();

    const stored: StoredMessage = {
      id: clientMsgId,
      chatId: peerEmail,
      fromEmail: "",
      outgoing: true,
      kind: content.kind,
      body: content.body,
      media: content.media,
      sentAtMs,
      status: "sending",
    };
    await putMessage(stored);
    this.events.onMessage(stored);

    try {
      const plaintext = encodeContent({ ...content, sentAtMs });
      const targets: { email: string; device_id: string; envelope: string }[] = [];

      // A copy for every device of the recipient AND for this account's other
      // devices, so the conversation shows up there too. This device is
      // excluded -- it already has the plaintext.
      const fanout: [string, string[]][] = [
        [peerEmail, await this.devicesFor(peerEmail)],
        [this.api.email, (await this.devicesFor(this.api.email)).filter((d) => d !== this.deviceId)],
      ];

      for (const [email, devices] of fanout) {
        for (const device of devices) {
          const envelope = await this.sessions.encrypt(email, device, plaintext);
          targets.push({ email, device_id: device, envelope: JSON.stringify(envelope) });
        }
      }

      if (targets.length === 0) {
        throw new Error(`${peerEmail} has no active devices to deliver to`);
      }

      await this.api.sendMessage({
        client_msg_id: clientMsgId,
        kind: content.kind,
        recipients: targets,
      });

      const sent = await advanceStatus(clientMsgId, "sent");
      if (sent) this.events.onStatus(sent);
      return sent ?? stored;
    } catch (err) {
      const failed = await advanceStatus(clientMsgId, "failed");
      if (failed) this.events.onStatus(failed);
      throw err;
    }
  }

  async markRead(chatId: string, clientMsgIds: string[]): Promise<void> {
    if (clientMsgIds.length === 0) return;
    for (const id of clientMsgIds) {
      const updated = await advanceStatus(id, "read");
      if (updated) this.events.onStatus(updated);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "read", client_msg_ids: clientMsgIds }));
      return;
    }
    try {
      await this.api.ackRead(clientMsgIds);
    } catch {
      // Receipts are not worth a retry queue; the next read sweep resends.
    }
  }

  async sendTyping(peerEmail: string, stopped = false): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (!stopped && now - this.lastTypingSentAt < TYPING_THROTTLE_MS) return;
    this.lastTypingSentAt = now;

    for (const device of await this.devicesFor(peerEmail)) {
      this.socket.send(JSON.stringify({ type: "typing", to_device: device, stopped }));
    }
  }

  async fetchMedia(media: MediaRef): Promise<Blob> {
    const ciphertext = await this.api.downloadMedia(media.mediaId);
    return decryptBlob(ciphertext, media.key, media.iv, media.mime);
  }

  async uploadMedia(peerEmail: string, blob: Blob): Promise<{ mediaId: string; key: string; iv: string }> {
    const { encryptBlob } = await import("./media");
    const { data, key, iv } = await encryptBlob(blob);
    const { id } = await this.api.uploadMedia(data, [peerEmail, this.api.email]);
    return { mediaId: id, key, iv };
  }

  safetyNumberFor(peerEmail: string, peerDeviceId: string): string | null {
    return this.sessions.safetyNumberFor(peerEmail, peerDeviceId);
  }
}
