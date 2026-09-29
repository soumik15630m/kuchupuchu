/** A conversation as readable text.
 *
 * The backup is an encrypted blob for restoring onto a device. This is the
 * other thing people mean by "get this out": something you can read, search
 * in a text editor, or hand to someone.
 *
 * Deliberately plain. A format with structure would invite a reader to treat
 * it as authoritative, and a text file that says who said what and when is
 * exactly as much as this can honestly claim -- nothing here is signed, and
 * anyone can edit it afterwards.
 */

const pad = (n) => String(n).padStart(2, "0");

export function formatStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The filename a media entry gets inside the zip. Prefixed with the message
 * id so two photos with the same original name stay distinct, and so a line
 * in the transcript can point at exactly one file. */
export function mediaFilename(message) {
  const ref = message.media;
  const original = ref?.name?.trim();
  if (original) return `media/${message.id}-${original}`;
  const ext = (ref?.mime ?? "").split("/")[1]?.split(";")[0] ?? "bin";
  return `media/${message.id}.${ext}`;
}

function describeFor(message, describe) {
  if (message.deletedForEveryone) return "<message deleted>";
  if (message.kind === "system") return `<${message.body}>`;
  return describe(message);
}

/**
 * @param {object[]} messages   in chat order
 * @param {{chatName: string, nameFor: (email: string) => string,
 *          describe: (message: object) => string, includeMedia?: boolean,
 *          selfLabel?: string, exportedAtMs?: number}} options
 */
export function formatTranscript(messages, options) {
  const {
    chatName,
    nameFor,
    describe,
    includeMedia = false,
    selfLabel = "You",
    exportedAtMs = Date.now(),
  } = options;

  const lines = [
    `Kuchupuchu conversation: ${chatName}`,
    `Exported ${formatStamp(exportedAtMs)} — ${messages.length} message${messages.length === 1 ? "" : "s"}`,
    // Said up front rather than discovered later: a transcript that silently
    // omits what disappeared would read as the whole conversation.
    "Messages that have already disappeared are not here, and neither is anything deleted.",
    "",
  ];

  for (const message of messages) {
    const who = message.kind === "system" ? "—" : message.outgoing ? selfLabel : nameFor(message.fromEmail);
    let text = describeFor(message, describe);

    if (message.replyTo) {
      const quotedWho = message.replyTo.fromEmail
        ? nameFor(message.replyTo.fromEmail)
        : "someone";
      text = `[replying to ${quotedWho}: ${truncate(message.replyTo.body, 60)}] ${text}`;
    }
    if (message.editedAtMs) text += " (edited)";
    if (includeMedia && message.media) text += ` -> ${mediaFilename(message)}`;
    else if (message.media) text += " <media not included in this export>";

    const reactions = Object.entries(message.reactions ?? {});
    if (reactions.length > 0) {
      text += ` [${reactions.map(([email, emoji]) => `${emoji} ${nameFor(email)}`).join(", ")}]`;
    }

    lines.push(`[${formatStamp(message.sentAtMs)}] ${who}: ${text}`);
  }

  // Trailing newline: a text file without one is the kind of thing that
  // makes diff and cat behave oddly.
  return lines.join("\n") + "\n";
}

function truncate(text, max) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A filesystem-friendly name for the download. */
export function transcriptFilename(chatName, exportedAtMs = Date.now()) {
  const d = new Date(exportedAtMs);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const safe = chatName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "chat";
  return `kuchupuchu-${safe}-${stamp}`;
}
