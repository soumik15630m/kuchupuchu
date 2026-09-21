import type { Session, WireMessage } from "../api/client";
import { getGroup, isGroupId, loadGroups, toRef, upsertFromRef, type Group, type GroupRef } from "../groups";
import { decryptBlob } from "./media";
import { SessionManager, decodeContent, encodeContent, type MessageEnvelope } from "./sessions";
import {
  addSystemNotice,
  advanceStatus,
  deleteMessage,
  getMessage,
  pendingOutbox,
  putMessage,
  recordReceipt,
  type MediaRef,
  type ReplyRef,
  type StoredMessage,
} from "./store";
import { markViewed, putStatus, recordViewer, type StatusPost } from "./status-store";

/** The plaintext inside an envelope. Everything user-visible lives here; the
 * server sees only the sealed form.
 *
 * `reaction`, `deletion` and `status-view` are control messages rather than
 * bubbles: they mutate something that already exists instead of adding a
 * message. They travel the same encrypted path as everything else, so the
 * server cannot tell them apart from an ordinary message. */
interface Content {
  kind:
    | "text"
    | "media"
    | "voice"
    | "sticker"
    | "status"
    | "reaction"
    | "deletion"
    | "status-view"
    | "edit";
  body: string;
  media?: MediaRef;
  replyTo?: ReplyRef;
  /** Set on the control kinds: the client id of the message acted on. */
  target?: string;
  /** Present on every group message. A recipient learns the group from this
   * rather than from a separate invite exchange. */
  group?: GroupRef;
  sentAtMs: number;
}

/** Who a message is for. A group is fanned out pairwise to every member device
 * rather than using sender keys: at this scale (§1, <=10 members) it reuses the
 * per-device path that already exists and needs nothing from the server. */
export type ChatTarget =
  | { kind: "direct"; email: string }
  | { kind: "group"; group: Group };

/** Resolves a stored group id back into a send target, or null if this device
 * no longer knows the group. */
function groupTarget(chatId: string): ChatTarget | null {
  const group = getGroup(chatId);
  return group ? { kind: "group", group } : null;
}

export function targetChatId(target: ChatTarget): string {
  return target.kind === "direct" ? target.email : target.group.id;
}

export interface TypingEvent {
  /** Which conversation, so a group and a 1:1 cannot be confused. For a 1:1
   * this is the sender's own address, which is the chat id on this end. */
  chatId: string;
  fromEmail: string;
  stopped: boolean;
}

export interface MessagingEvents {
  onMessage: (message: StoredMessage) => void;
  onStatus: (message: StoredMessage) => void;
  onTyping: (event: TypingEvent) => void;
  onConnectionChange: (online: boolean) => void;
  /** A status post arrived, was published, or gained a viewer. */
  onStatusPost: () => void;
  /** Queued messages went out after a reconnect. */
  onOutboxDrained: (count: number) => void;
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
    this.sessions = new SessionManager(api, deviceId, (peerEmail) => {
      void this.noteSecurityCodeChanged(peerEmail);
    });
  }

  /** Leaves a notice in every chat the peer is part of. A code change in a
   * group matters there too, not only in the 1:1 thread. */
  private async noteSecurityCodeChanged(peerEmail: string): Promise<void> {
    const chatIds = new Set<string>([peerEmail]);
    for (const group of loadGroups()) {
      if (group.members.includes(peerEmail)) chatIds.add(group.id);
    }
    for (const chatId of chatIds) {
      const notice = await addSystemNotice(
        chatId,
        `${peerEmail}'s security code changed. If you verified it before, check it again.`,
        "security-code-changed"
      );
      this.events.onMessage(notice);
    }
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
      // Anything typed while offline is owed to the server; without this it
      // sits behind a red exclamation mark until the user notices it.
      void this.retryOutbox().then((sent) => {
        if (sent > 0) this.events.onOutboxDrained(sent);
      });
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
        const updated = await recordReceipt(
          String(frame.client_msg_id),
          frame.type === "read" ? "read" : "delivered",
          typeof frame.by === "string" ? frame.by : null
        );
        if (updated) this.events.onStatus(updated);
        break;
      }
      case "typing": {
        const from = String(frame.from_email);
        this.events.onTyping({
          // A group message names its conversation explicitly; a 1:1 does not
          // need to, because the sender *is* the conversation on this end.
          chatId: typeof frame.chat_id === "string" && frame.chat_id ? frame.chat_id : from,
          fromEmail: from,
          stopped: Boolean(frame.stopped),
        });
        break;
      }
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

    if (
      content.kind === "reaction" ||
      content.kind === "deletion" ||
      content.kind === "status-view" ||
      content.kind === "edit"
    ) {
      await this.applyControl(content, wire.from_email);
      await this.acknowledge(wire.id);
      return;
    }

    const sentAtMs = content.sentAtMs || Date.parse(wire.created_at) || Date.now();

    if (content.kind === "status") {
      await putStatus({
        id: wire.client_msg_id,
        authorEmail: wire.from_email,
        outgoing: false,
        body: content.body,
        media: content.media,
        background: content.replyTo?.body,
        postedAtMs: sentAtMs,
        viewed: false,
        viewedBy: [],
      });
      this.events.onStatusPost();
      await this.acknowledge(wire.id);
      return;
    }

    // A group message names its group inside the ciphertext, so the chat it
    // belongs to is known without the server ever learning the group exists.
    if (content.group) upsertFromRef(content.group, wire.from_email);

    const stored: StoredMessage = {
      id: wire.client_msg_id,
      chatId: content.group ? content.group.id : wire.from_email,
      fromEmail: wire.from_email,
      outgoing: false,
      kind: content.kind,
      body: content.body,
      media: content.media,
      replyTo: content.replyTo,
      sentAtMs,
      status: "delivered",
    };
    await putMessage(stored);
    this.events.onMessage(stored);
    await this.acknowledge(wire.id);
  }

  private async applyControl(content: Content, fromEmail: string): Promise<void> {
    if (!content.target) return;

    if (content.kind === "status-view") {
      const updated = await recordViewer(content.target, fromEmail);
      if (updated) this.events.onStatusPost();
      return;
    }

    const target = await getMessage(content.target);
    // The control can outrun its target across a reconnect, or refer to a
    // message this device cleared. Dropping it is correct either way.
    if (!target) return;

    if (content.kind === "edit") {
      // Only the author may rewrite their own message.
      if (target.fromEmail !== fromEmail) return;
      const edited: StoredMessage = {
        ...target,
        body: content.body,
        editedAtMs: content.sentAtMs,
      };
      await putMessage(edited);
      this.events.onStatus(edited);
      return;
    }

    if (content.kind === "deletion") {
      // Only the author may retract. Without this check a peer could blank
      // out messages they did not send.
      if (target.fromEmail !== fromEmail && !(target.outgoing && fromEmail === this.api.email)) return;
      const updated: StoredMessage = {
        ...target,
        body: "",
        media: undefined,
        kind: "text",
        deletedForEveryone: true,
      };
      await putMessage(updated);
      this.events.onStatus(updated);
      return;
    }

    const reactions = { ...(target.reactions ?? {}) };
    // An empty body is how a reaction is taken back.
    if (content.body) reactions[fromEmail] = content.body;
    else delete reactions[fromEmail];

    const updated: StoredMessage = { ...target, reactions };
    await putMessage(updated);
    this.events.onStatus(updated);
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

  /** Everyone who should get a copy: the audience, plus this account's other
   * devices so the conversation appears there too. This device is excluded —
   * it already has the plaintext. */
  private async fanoutTargets(
    audience: string[],
    plaintext: Uint8Array
  ): Promise<{ email: string; device_id: string; envelope: string }[]> {
    const recipients = new Set(audience.map((e) => e.toLowerCase()));
    recipients.add(this.api.email.toLowerCase());

    const targets: { email: string; device_id: string; envelope: string }[] = [];
    for (const email of recipients) {
      let devices: string[];
      try {
        devices = await this.devicesFor(email);
      } catch {
        // One unreachable member must not stop delivery to the rest of a
        // group; they pick the message up from /pending once reachable.
        continue;
      }
      for (const device of devices) {
        if (email === this.api.email.toLowerCase() && device === this.deviceId) continue;
        const envelope = await this.sessions.encrypt(email, device, plaintext);
        targets.push({ email, device_id: device, envelope: JSON.stringify(envelope) });
      }
    }
    return targets;
  }

  async send(
    target: ChatTarget,
    content: Omit<Content, "sentAtMs"> & { sentAtMs?: number }
  ): Promise<StoredMessage> {
    const clientMsgId = crypto.randomUUID();
    const sentAtMs = content.sentAtMs ?? Date.now();
    const isControl =
      content.kind === "reaction" ||
      content.kind === "deletion" ||
      content.kind === "status-view" ||
      content.kind === "edit";
    const chatId = targetChatId(target);

    const body: Content = {
      ...content,
      sentAtMs,
      ...(target.kind === "group" ? { group: toRef(target.group) } : {}),
    };

    const stored: StoredMessage = {
      id: clientMsgId,
      chatId,
      fromEmail: this.api.email,
      outgoing: true,
      kind: isControl || content.kind === "status" ? "text" : (content.kind as StoredMessage["kind"]),
      body: content.body,
      media: content.media,
      replyTo: content.replyTo,
      sentAtMs,
      status: "sending",
      recipients:
        target.kind === "group"
          ? target.group.members.filter((m) => m !== this.api.email)
          : [target.email],
    };
    // Control messages and status posts have no chat bubble; their local effect
    // was already applied by the caller.
    const makesBubble = !isControl && content.kind !== "status";
    if (makesBubble) {
      await putMessage(stored);
      this.events.onMessage(stored);
    }

    try {
      const audience =
        target.kind === "group" ? target.group.members : [target.email];
      const targets = await this.fanoutTargets(audience, encodeContent(body));

      if (targets.length === 0) {
        throw new Error(
          target.kind === "group"
            ? `no active devices in ${target.group.name} to deliver to`
            : `${target.email} has no active devices to deliver to`
        );
      }

      await this.api.sendMessage({
        client_msg_id: clientMsgId,
        // The server understands only text/media/voice; anything else rides as
        // text because its real kind is inside the ciphertext.
        kind: content.kind === "media" || content.kind === "voice" ? content.kind : "text",
        recipients: targets,
      });

      if (!makesBubble) return stored;
      const sent = await advanceStatus(clientMsgId, "sent");
      if (sent) this.events.onStatus(sent);
      return sent ?? stored;
    } catch (err) {
      if (!makesBubble) throw err;
      const failed = await advanceStatus(clientMsgId, "failed");
      if (failed) this.events.onStatus(failed);
      throw err;
    }
  }

  /** Posts a status to every allowlisted member passed in. It is an ordinary
   * encrypted fan-out; nothing about it is visible to the server. */
  async postStatus(
    audience: string[],
    content: { body: string; media?: MediaRef; background?: string }
  ): Promise<void> {
    const id = crypto.randomUUID();
    const postedAtMs = Date.now();

    await putStatus({
      id,
      authorEmail: this.api.email,
      outgoing: true,
      body: content.body,
      media: content.media,
      background: content.background,
      postedAtMs,
      viewed: true,
      viewedBy: [],
    });
    this.events.onStatusPost();

    const plaintext = encodeContent({
      kind: "status",
      body: content.body,
      media: content.media,
      // Reuses replyTo's slot for the card background rather than widening the
      // envelope for one optional string.
      replyTo: content.background
        ? { id: "", body: content.background, fromEmail: "" }
        : undefined,
      sentAtMs: postedAtMs,
    } satisfies Content);

    const targets = await this.fanoutTargets(audience, plaintext);
    if (targets.length === 0) return;
    await this.api.sendMessage({ client_msg_id: id, kind: "text", recipients: targets });
  }

  /** Tells the author their status was seen. */
  async markStatusViewed(post: StatusPost): Promise<void> {
    const updated = await markViewed(post.id);
    if (!updated) return;
    this.events.onStatusPost();
    if (post.outgoing) return;
    try {
      await this.send(
        { kind: "direct", email: post.authorEmail },
        { kind: "status-view", body: "", target: post.id }
      );
    } catch {
      // A view receipt is not worth surfacing or retrying.
    }
  }

  /** Applies the reaction locally first so the tap feels immediate, then
   * mirrors it to the peer. */
  async react(chat: ChatTarget, targetId: string, emoji: string): Promise<void> {
    const message = await getMessage(targetId);
    if (!message) return;

    const reactions = { ...(message.reactions ?? {}) };
    const mine = reactions[this.api.email];
    const next = mine === emoji ? "" : emoji;
    if (next) reactions[this.api.email] = next;
    else delete reactions[this.api.email];

    const updated = { ...message, reactions };
    await putMessage(updated);
    this.events.onStatus(updated);

    await this.send(chat, { kind: "reaction", body: next, target: targetId });
  }

  async deleteForEveryone(chat: ChatTarget, targetId: string): Promise<void> {
    const message = await getMessage(targetId);
    if (!message || !message.outgoing) return;

    const updated: StoredMessage = {
      ...message,
      body: "",
      media: undefined,
      kind: "text",
      deletedForEveryone: true,
    };
    await putMessage(updated);
    this.events.onStatus(updated);

    await this.send(chat, { kind: "deletion", body: "", target: targetId });
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

  async sendTyping(target: ChatTarget, stopped = false): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();

    // Only a "typing" frame is throttled -- resending it on every keystroke is
    // pointless, but a stop has to go out immediately. Crucially the stop must
    // NOT arm the throttle: doing so swallowed the next real typing signal for
    // the whole window, which is why group typing never appeared after the box
    // had been cleared once.
    if (stopped) {
      this.lastTypingSentAt = 0;
    } else {
      if (now - this.lastTypingSentAt < TYPING_THROTTLE_MS) return;
      this.lastTypingSentAt = now;
    }

    const audience = target.kind === "group" ? target.group.members : [target.email];
    const chatId = target.kind === "group" ? target.group.id : null;
    for (const email of audience) {
      if (email === this.api.email) continue;
      let devices: string[];
      try {
        devices = await this.devicesFor(email);
      } catch {
        continue;
      }
      for (const device of devices) {
        this.socket.send(
          JSON.stringify({ type: "typing", to_device: device, stopped, chat_id: chatId })
        );
      }
    }
  }

  /** Rewrites a message the local user sent, on both ends. */
  async edit(chat: ChatTarget, targetId: string, body: string): Promise<void> {
    const message = await getMessage(targetId);
    if (!message || !message.outgoing || message.deletedForEveryone) return;

    const editedAtMs = Date.now();
    const updated: StoredMessage = { ...message, body, editedAtMs };
    await putMessage(updated);
    this.events.onStatus(updated);

    await this.send(chat, { kind: "edit", body, target: targetId, sentAtMs: editedAtMs });
  }

  /** Sends an existing message on to another chat.
   *
   * Media is re-referenced rather than re-uploaded, but the blob's audience is
   * fixed at upload time, so the new recipients would get a 404. Re-uploading
   * under the new audience is what makes a forwarded attachment actually
   * openable. */
  async forward(chat: ChatTarget, message: StoredMessage, audience: string[]): Promise<void> {
    if (message.deletedForEveryone) return;

    if (!message.media) {
      await this.send(chat, { kind: "text", body: message.body });
      return;
    }

    const blob = await this.fetchMedia(message.media);
    const { mediaId, key, iv } = await this.uploadMedia(audience, blob);
    await this.send(chat, {
      kind: message.kind === "voice" ? "voice" : message.kind === "sticker" ? "sticker" : "media",
      body: message.body,
      media: { ...message.media, mediaId, key, iv },
    });
  }

  /** Re-sends anything that failed. Called on reconnect, so a message typed
   * offline is not silently lost behind a red exclamation mark. */
  async retryOutbox(): Promise<number> {
    const stuck = await pendingOutbox();
    let sent = 0;
    for (const message of stuck) {
      // Media would need its blob re-uploaded, which the original File is gone
      // for; only text can be replayed safely from stored state.
      if (message.kind !== "text" || !message.body) continue;

      const chat: ChatTarget | null = message.recipients?.length
        ? isGroupId(message.chatId)
          ? groupTarget(message.chatId)
          : { kind: "direct", email: message.chatId }
        : null;
      if (!chat) continue;

      try {
        await this.send(chat, { kind: "text", body: message.body, sentAtMs: message.sentAtMs });
        await deleteMessage(message.id);
        sent += 1;
      } catch {
        // Still unreachable; it stays in the outbox for the next attempt.
        break;
      }
    }
    return sent;
  }

  async fetchMedia(media: MediaRef): Promise<Blob> {
    const ciphertext = await this.api.downloadMedia(media.mediaId);
    return decryptBlob(ciphertext, media.key, media.iv, media.mime);
  }

  /** `audience` must list every member allowed to download the blob; the
   * server enforces it, so a group upload that named only one member would 404
   * for everyone else. */
  async uploadMedia(audience: string[], blob: Blob): Promise<{ mediaId: string; key: string; iv: string }> {
    const { encryptBlob } = await import("./media");
    const { data, key, iv } = await encryptBlob(blob);
    const { id } = await this.api.uploadMedia(data, [...audience, this.api.email]);
    return { mediaId: id, key, iv };
  }

  safetyNumberFor(peerEmail: string, peerDeviceId: string): string | null {
    return this.sessions.safetyNumberFor(peerEmail, peerDeviceId);
  }
}
