import type { Session, WireMessage } from "../api/client";
import { getGroup, isGroupId, loadGroups, toRef, upsertFromRef, type Group, type GroupRef } from "../groups";
import { decryptBlob } from "./media";
import { deleteCachedMedia, getCachedMedia, putCachedMedia } from "./media-cache";
import { SessionManager, decodeContent, encodeContent, type MessageEnvelope } from "./sessions";
import {
  addSystemNotice,
  advanceStatus,
  allMessages,
  deleteMessage,
  getMessage,
  pendingOutbox,
  putMessage,
  recordReceipt,
  type LinkPreview,
  type MediaRef,
  type ReplyRef,
  type StoredMessage,
} from "./store";
import { markViewed, putStatus, recordViewer, type StatusPost } from "./status-store";
import { deleteAvatar, putAvatar } from "../directory/avatar-store";

/** A newly linked device asks its siblings for the archive exactly once;
 * the device id is stored with the flag so a re-minted id asks again. */
const HISTORY_ASKED_KEY = "kuchupuchu:history-asked";
const HISTORY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_MESSAGES = 2000;
const HISTORY_BATCH = 40;

const MAX_HANDLED_CONTROLS = 500;

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
    | "file"
    | "location"
    | "contact"
    | "status"
    | "reaction"
    | "deletion"
    | "status-view"
    | "edit"
    | "group-update"
    | "profile"
    | "history-request"
    | "history"
    | "view-once-opened";
  body: string;
  media?: MediaRef;
  replyTo?: ReplyRef;
  /** Set on the control kinds: the client id of the message acted on. */
  target?: string;
  /** Present on every group message. A recipient learns the group from this
   * rather than from a separate invite exchange. */
  group?: GroupRef;
  /** Set on `location`. Coordinates only — no map tile is fetched, which
   * would tell a tile server where both people are. */
  location?: { lat: number; lon: number; accuracyM?: number };
  /** Set on `contact`: a member card, so sharing someone does not require
   * the recipient to already know their handle. */
  contact?: { email: string; username: string | null; displayName: string | null };
  /** Set on `profile`: the sender's avatar. Carried here rather than in the
   * server-side profile because the ref includes the blob's decryption key. */
  avatar?: MediaRef | null;
  /** Set on `text`: a preview the sender resolved, so the recipient never
   * fetches the link themselves. */
  link?: LinkPreview;
  /** Who a direct message was addressed to. Only the sender's *own* other
   * devices need it -- the peer already knows -- and it rides inside the
   * ciphertext, so the server learns nothing it did not already route by. */
  to?: string;
  /** Set on `media`: the attachment may be opened once, then it is gone. */
  viewOnce?: boolean;
  /** Set on `history`: a batch of this account's own past messages, sent
   * device-to-device when a new device is linked. The server stores these as
   * ordinary ciphertext and learns nothing it did not already hold. */
  history?: StoredMessage[];
  /** Set on `history`: the groups those messages belong to, so a restored
   * chat list has names rather than bare ids. */
  historyGroups?: GroupRef[];
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
  /** A peer broadcast a new avatar. */
  onProfileChanged: (email: string) => void;
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
    await this.requestHistoryIfNew();
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
    // Control messages never reach the message store, so the check above
    // cannot see them. start() runs connect() -- whose onopen triggers a
    // server backlog -- and drainPending() concurrently, so the same pending
    // reaction really can arrive twice during an ordinary startup.
    if (this.handledControls.has(wire.client_msg_id)) {
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
      content.kind === "edit" ||
      content.kind === "group-update" ||
      content.kind === "profile" ||
      content.kind === "history-request" ||
      content.kind === "history" ||
      content.kind === "view-once-opened"
    ) {
      this.rememberControl(wire.client_msg_id);
      await this.applyControl(content, wire.from_email, wire.from_device);
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

    // fanoutTargets deliberately copies every message to this account's other
    // devices, so some of what arrives here was sent by us. Without this it
    // renders as an incoming, unread bubble -- and for a 1:1 it opens a
    // phantom thread keyed by the member's own address.
    const fromSelf = wire.from_email.toLowerCase() === this.api.email.toLowerCase();
    const peerChatId = content.group
      ? content.group.id
      : fromSelf
        ? (content.to ?? wire.from_email)
        : wire.from_email;

    const stored: StoredMessage = {
      id: wire.client_msg_id,
      chatId: peerChatId,
      fromEmail: wire.from_email,
      outgoing: fromSelf,
      kind: content.kind as StoredMessage["kind"],
      body: content.body,
      media: content.media,
      replyTo: content.replyTo,
      location: content.location,
      contact: content.contact,
      link: content.link,
      viewOnce: content.viewOnce,
      sentAtMs,
      status: fromSelf ? "sent" : "delivered",
    };
    await putMessage(stored);
    this.events.onMessage(stored);
    await this.acknowledge(wire.id);
  }

  private async applyControl(
    content: Content,
    fromEmail: string,
    fromDevice: string
  ): Promise<void> {
    // History only ever moves between this account's own devices. A request
    // from anyone else is dropped rather than answered -- it would be a
    // request to hand a member's whole archive to someone who asked nicely.
    if (content.kind === "history-request") {
      if (fromEmail.toLowerCase() !== this.api.email.toLowerCase()) return;
      await this.sendHistoryTo(fromDevice);
      return;
    }

    if (content.kind === "history") {
      if (fromEmail.toLowerCase() !== this.api.email.toLowerCase()) return;
      for (const ref of content.historyGroups ?? []) {
        upsertFromRef(ref, this.api.email, { trusted: true });
      }
      let added = 0;
      for (const message of content.history ?? []) {
        // A message this device already has wins: its read state and local
        // stars are newer than whatever the sending device remembers.
        if (await getMessage(message.id)) continue;
        await putMessage(message);
        added += 1;
      }
      if (added > 0) this.events.onOutboxDrained(added);
      return;
    }

    if (content.kind === "view-once-opened") {
      if (!content.target) return;
      const message = await getMessage(content.target);
      // Only the author's copy is annotated, and only by the person it was
      // sent to -- otherwise anyone could mark anyone's photo as opened.
      if (!message || !message.outgoing || !message.recipients?.includes(fromEmail)) return;
      const updated = { ...message, viewedOnceAtMs: content.sentAtMs, media: undefined };
      await putMessage(updated);
      this.events.onStatus(updated);
      return;
    }

    if (content.kind === "profile") {
      if (content.avatar) {
        await putAvatar({ email: fromEmail, media: content.avatar, updatedAtMs: content.sentAtMs });
      } else {
        await deleteAvatar(fromEmail);
      }
      this.events.onProfileChanged(fromEmail);
      return;
    }

    if (content.kind === "group-update") {
      // The group metadata already merged in ingest(); this only records what
      // changed, so members see "X added Y" rather than silent edits.
      if (!content.group) return;
      const notice = await addSystemNotice(content.group.id, content.body, "group-updated");
      this.events.onMessage(notice);
      return;
    }

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

/** Newly linked devices start empty. Rather than leaving someone with a
   * blank app, this asks the account's *other* devices for the archive; they
   * answer over the same pairwise encrypted channel every message uses, so
   * the server carries it without being able to read it. */
  private async requestHistoryIfNew(): Promise<void> {
    if (localStorage.getItem(HISTORY_ASKED_KEY) === this.deviceId) return;
    const existing = await allMessages();
    // Only a genuinely empty device asks. Re-asking after a chat is cleared
    // would quietly undo the clearing.
    if (existing.length > 0) {
      localStorage.setItem(HISTORY_ASKED_KEY, this.deviceId);
      return;
    }
    try {
      const targets = await this.fanoutTargets(
        [],
        encodeContent({ kind: "history-request", body: "", sentAtMs: Date.now() })
      );
      if (targets.length === 0) return;
      await this.api.sendMessage({
        client_msg_id: crypto.randomUUID(),
        kind: "text",
        recipients: targets,
      });
      localStorage.setItem(HISTORY_ASKED_KEY, this.deviceId);
    } catch {
      // Retried on the next start; there is nothing useful to show for it.
    }
  }

  /** Answers a history request from one of this account's own devices.
   *
   * Sent in batches because a single envelope carrying thousands of messages
   * would exceed what the transport will take, and a partial transfer is far
   * better than one that fails whole. */
  private async sendHistoryTo(deviceId: string): Promise<void> {
    if (deviceId === this.deviceId) return;
    const all = await allMessages();
    const recent = all
      .filter((m) => m.sentAtMs >= Date.now() - HISTORY_WINDOW_MS)
      .sort((a, b) => a.sentAtMs - b.sentAtMs)
      .slice(-HISTORY_MAX_MESSAGES);
    if (recent.length === 0) return;

    const groups = loadGroups().map(toRef);

    for (let i = 0; i < recent.length; i += HISTORY_BATCH) {
      const batch = recent.slice(i, i + HISTORY_BATCH);
      const content: Content = {
        kind: "history",
        body: "",
        history: batch,
        // The group list rides with the first batch only; repeating it in
        // every one would multiply it by the batch count for no gain.
        historyGroups: i === 0 ? groups : undefined,
        sentAtMs: Date.now(),
      };
      try {
        const envelope = await this.sessions.encrypt(
          this.api.email,
          deviceId,
          encodeContent(content)
        );
        await this.api.sendMessage({
          client_msg_id: crypto.randomUUID(),
          kind: "text",
          recipients: [
            { email: this.api.email, device_id: deviceId, envelope: JSON.stringify(envelope) },
          ],
        });
      } catch {
        // Stop at the first failure: the ratchet is ordered, so pushing on
        // would leave the receiver unable to decrypt what follows anyway.
        return;
      }
    }
  }

  /** Client ids of control messages already applied this session.
   *
   * Bounded because it grows for the life of the connection and the window it
   * guards is a startup race, not a long-lived one. */
  private readonly handledControls = new Set<string>();

  private rememberControl(clientMsgId: string): void {
    this.handledControls.add(clientMsgId);
    if (this.handledControls.size > MAX_HANDLED_CONTROLS) {
      const oldest = this.handledControls.values().next().value;
      if (oldest !== undefined) this.handledControls.delete(oldest);
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
        try {
          const envelope = await this.sessions.encrypt(email, device, plaintext);
          targets.push({ email, device_id: device, envelope: JSON.stringify(envelope) });
        } catch (err) {
          // A device that is registered but has never published a prekey
          // bundle cannot be encrypted to. Skipping it keeps the message
          // going to the peer's other devices; failing the whole send would
          // mean one half-set-up device silences the conversation entirely.
          // send() still throws if this leaves nobody at all.
          console.warn(`messaging: skipping ${email}/${device}`, err);
        }
      }
    }
    return targets;
  }

  async send(
    target: ChatTarget,
    content: Omit<Content, "sentAtMs"> & { sentAtMs?: number },
    options: { clientMsgId?: string } = {}
  ): Promise<StoredMessage> {
    // A retry reuses the original id. Minting a fresh one made a message that
    // was genuinely still in flight arrive twice, as two separate messages
    // the recipient could not tell apart.
    const clientMsgId = options.clientMsgId ?? crypto.randomUUID();
    const sentAtMs = content.sentAtMs ?? Date.now();
    const isControl =
      content.kind === "reaction" ||
      content.kind === "deletion" ||
      content.kind === "status-view" ||
      content.kind === "edit" ||
      content.kind === "view-once-opened";
    const chatId = targetChatId(target);

    const body: Content = {
      ...content,
      sentAtMs,
      ...(target.kind === "group"
        ? { group: toRef(target.group) }
        : { to: target.email }),
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
      location: content.location,
      contact: content.contact,
      link: content.link,
      viewOnce: content.viewOnce,
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
        kind:
          content.kind === "media" || content.kind === "voice" || content.kind === "file"
            ? content.kind === "file"
              ? "media"
              : content.kind
            : "text",
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

  /** Throws away the encrypted session with a peer device so the next message
   * rebuilds it from a fresh X3DH.
   *
   * The recovery path for a chain that can no longer decrypt anything the
   * peer sends -- they re-provisioned a device, or a bug desynced it. Until
   * this was wired up, `SessionManager.reset` existed for exactly this case
   * and nothing called it, so there was no way out from inside the app.
   */
  async resetSessionsWith(peerEmail: string): Promise<number> {
    const devices = await this.devicesFor(peerEmail).catch(() => [] as string[]);
    for (const device of devices) await this.sessions.reset(peerEmail, device);
    // Forces a fresh device list on the next send rather than reusing the
    // cached one this just invalidated sessions for.
    this.deviceCache.delete(peerEmail.toLowerCase());
    return devices.length;
  }

  /** Burns a view-once attachment after it has been seen.
   *
   * The blob is dropped from this device first and the sender told second: if
   * the notice fails to send, the photo is still gone here, which is the
   * promise that actually matters. */
  async markViewOnceOpened(chat: ChatTarget, message: StoredMessage): Promise<void> {
    if (!message.viewOnce || message.viewedOnceAtMs) return;
    const viewedOnceAtMs = Date.now();
    const burned: StoredMessage = { ...message, viewedOnceAtMs, media: undefined };
    await putMessage(burned);
    // The ref carries the decryption key and is gone now, but the decrypted
    // blob is in the local cache -- and without this it survives there and
    // rides into the next backup.
    if (message.media?.mediaId) await deleteCachedMedia(message.media.mediaId);
    this.events.onStatus(burned);
    try {
      await this.send(chat, { kind: "view-once-opened", body: "", target: message.id, sentAtMs: viewedOnceAtMs });
    } catch {
      // The sender simply will not see "opened"; nothing to retry usefully.
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
      // `file` has to survive the round trip: mapping it to "media" rendered a
      // forwarded document as a broken image on the other side.
      kind:
        message.kind === "voice"
          ? "voice"
          : message.kind === "sticker"
            ? "sticker"
            : message.kind === "file"
              ? "file"
              : "media",
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
        // Everything the bubble already shows has to be replayed, not just
        // the body: a retried message that silently lost its reply or its
        // link preview looks like a different message to the recipient.
        await this.send(
          chat,
          {
            kind: "text",
            body: message.body,
            replyTo: message.replyTo,
            link: message.link,
            sentAtMs: message.sentAtMs,
          },
          { clientMsgId: message.id }
        );
        await deleteMessage(message.id);
        sent += 1;
      } catch {
        // Still unreachable; it stays in the outbox for the next attempt.
        break;
      }
    }
    return sent;
  }

  /** Broadcasts a group edit. The new roster rides in the ordinary group ref,
   * so anyone still receiving it converges; `body` is the human summary. */
  async announceGroupUpdate(group: Group, summary: string): Promise<void> {
    await this.send({ kind: "group", group }, { kind: "group-update", body: summary });
    const notice = await addSystemNotice(group.id, summary, "group-updated");
    this.events.onMessage(notice);
  }

  /** Tells someone being removed, before they drop off the roster — after the
   * edit they are no longer in the audience and would never hear about it. */
  async announceRemoval(removedEmail: string, group: Group, summary: string): Promise<void> {
    try {
      await this.send(
        { kind: "direct", email: removedEmail },
        { kind: "group-update", body: summary, group: toRef({ ...group, members: [] }) }
      );
    } catch {
      // Best effort: they find out when messages stop arriving.
    }
  }

  /** Publishes an avatar to everyone. The blob goes through the ordinary
   * encrypted media path; only members in the audience can fetch it, and only
   * this broadcast carries the key. */
  async setAvatar(audience: string[], blob: Blob | null): Promise<MediaRef | null> {
    let media: MediaRef | null = null;
    if (blob) {
      const { mediaId, key, iv } = await this.uploadMedia(audience, blob);
      media = { mediaId, key, iv, mime: blob.type || "image/jpeg", byteSize: blob.size };
      await putAvatar({ email: this.api.email, media, updatedAtMs: Date.now() });
    } else {
      await deleteAvatar(this.api.email);
    }

    const plaintext = encodeContent({
      kind: "profile",
      body: "",
      avatar: media,
      sentAtMs: Date.now(),
    } satisfies Content);

    const targets = await this.fanoutTargets(audience, plaintext);
    if (targets.length > 0) {
      await this.api.sendMessage({
        client_msg_id: crypto.randomUUID(),
        kind: "text",
        recipients: targets,
      });
    }
    this.events.onProfileChanged(this.api.email);
    return media;
  }

  async sendLocation(
    chat: ChatTarget,
    position: { lat: number; lon: number; accuracyM?: number }
  ): Promise<void> {
    await this.send(chat, { kind: "location", body: "", location: position });
  }

  async sendContact(
    chat: ChatTarget,
    contact: { email: string; username: string | null; displayName: string | null }
  ): Promise<void> {
    await this.send(chat, { kind: "contact", body: "", contact });
  }

  /** Cache first, because the server deletes blobs after seven days: for a
   * restored history the cache is not an optimisation, it is the only copy. */
  async fetchMedia(media: MediaRef): Promise<Blob> {
    const cached = await getCachedMedia(media.mediaId);
    if (cached) return cached;
    const ciphertext = await this.api.downloadMedia(media.mediaId);
    const blob = await decryptBlob(ciphertext, media.key, media.iv, media.mime);
    await putCachedMedia(media.mediaId, blob);
    return blob;
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
