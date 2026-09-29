import type { MessagingClient } from "../messaging/client";
import { getCachedMedia } from "../messaging/media-cache";
import { describeMessage, messagesFor, type StoredMessage } from "../messaging/store";
import { formatTranscript, mediaFilename, transcriptFilename } from "./transcript.mjs";
import { buildZip } from "./zip.mjs";

/** Exporting one conversation as something a person can open.
 *
 * Distinct from the backup: that is ciphertext for restoring onto a device,
 * and this is a readable file that leaves the app's custody entirely. Worth
 * being blunt about in the UI for that reason -- an export is a decrypted
 * copy of the conversation sitting in a downloads folder.
 */

export interface ExportResult {
  filename: string;
  blob: Blob;
  messageCount: number;
  /** Attachments that could not be included, because the blob is neither
   * cached here nor still on the server. Reported rather than silently
   * dropped: the transcript line for one of these points at a file the zip
   * does not contain. */
  missingMedia: number;
}

export async function exportChat(
  chatId: string,
  options: {
    chatName: string;
    nameFor: (email: string) => string;
    includeMedia: boolean;
    client?: MessagingClient | null;
  }
): Promise<ExportResult> {
  const all = await messagesFor(chatId);
  // Control messages never had a bubble; they should not have a line either.
  const messages = all.filter((m) => !(m.kind === "system" && m.systemKind === undefined));

  const stem = transcriptFilename(options.chatName);

  if (!options.includeMedia) {
    const text = formatTranscript(messages, {
      chatName: options.chatName,
      nameFor: options.nameFor,
      describe: describeMessage,
      includeMedia: false,
    });
    return {
      filename: `${stem}.txt`,
      blob: new Blob([text], { type: "text/plain;charset=utf-8" }),
      messageCount: messages.length,
      missingMedia: 0,
    };
  }

  const entries: { name: string; bytes: Uint8Array; date: Date }[] = [];
  const included = new Set<string>();
  let missingMedia = 0;

  for (const message of messages) {
    if (!message.media) continue;
    const bytes = await mediaBytes(message, options.client ?? null);
    if (!bytes) {
      missingMedia += 1;
      continue;
    }
    entries.push({ name: mediaFilename(message), bytes, date: new Date(message.sentAtMs) });
    included.add(message.id);
  }

  // The transcript is written after the media pass, so a line only points at
  // a file that is actually in the archive.
  const text = formatTranscript(messages, {
    chatName: options.chatName,
    nameFor: options.nameFor,
    describe: describeMessage,
    includeMedia: true,
  });
  entries.unshift({
    name: "transcript.txt",
    bytes: new TextEncoder().encode(
      missingMedia > 0
        ? text.replace(
            "\n\n",
            `\n${missingMedia} attachment${missingMedia === 1 ? "" : "s"} could not be included — the file is no longer on this device or the server.\n\n`
          )
        : text
    ),
    date: new Date(),
  });

  return {
    filename: `${stem}.zip`,
    blob: new Blob([buildZip(entries)], { type: "application/zip" }),
    messageCount: messages.length,
    missingMedia,
  };
}

async function mediaBytes(
  message: StoredMessage,
  client: MessagingClient | null
): Promise<Uint8Array | null> {
  try {
    // Cache first: the blob may have expired from the server's retention
    // window while still being here, which is the common case for old chats.
    const cached = await getCachedMedia(message.media!.mediaId);
    const blob = cached ?? (client ? await client.fetchMedia(message.media!) : null);
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Hands the file to the browser. Revoked on the next tick rather than
 * immediately: Safari cancels an in-flight download when the URL goes. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
