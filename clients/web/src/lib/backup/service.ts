"use client";

import type { Session } from "../api/client";
import { loadGroups, toRef, upsertFromRef, type Group } from "../groups";
import type { MessagingClient } from "../messaging/client";
import { loadChatSettings, updateChatSettings, type ChatSettings } from "../messaging/chat-settings";
import { getCachedMedia, putCachedMedia } from "../messaging/media-cache";
import { allMessages, getMessage, putMessage, type StoredMessage } from "../messaging/store";

import { packArchive, unpackArchive } from "./archive.mjs";
import { openBackup, sealBackup } from "./envelope.mjs";

export interface BackupProgress {
  stage: "collecting" | "media" | "encrypting" | "uploading" | "downloading" | "decrypting" | "writing";
  done?: number;
  total?: number;
}

export interface BackupManifest {
  email: string;
  createdAtMs: number;
  messages: StoredMessage[];
  groups: Group[];
  chatSettings: Record<string, ChatSettings>;
}

/** Collects this device's history, packs it with its media, encrypts it under
 * the passphrase and uploads the ciphertext.
 *
 * Media is fetched through the messaging client rather than read straight out
 * of the cache, so a blob that is still on the server but not yet cached here
 * is pulled in instead of silently going missing from the backup. */
export async function createBackup(
  session: Session,
  client: MessagingClient | null,
  email: string,
  passphrase: string,
  onProgress?: (p: BackupProgress) => void
): Promise<{ byteSize: number }> {
  onProgress?.({ stage: "collecting" });
  const messages = await allMessages();
  const manifest: BackupManifest = {
    email,
    createdAtMs: Date.now(),
    messages,
    groups: loadGroups(),
    chatSettings: loadChatSettings(),
  };

  // One entry per distinct media id: the same blob can be referenced by a
  // forwarded copy in another chat, and packing it twice would double its
  // weight in the archive for nothing.
  const refs = new Map<string, StoredMessage["media"]>();
  for (const message of messages) {
    if (message.media?.mediaId && !refs.has(message.media.mediaId)) {
      refs.set(message.media.mediaId, message.media);
    }
  }

  const blobs: { id: string; mime: string; bytes: Uint8Array }[] = [];
  let done = 0;
  for (const [mediaId, ref] of refs) {
    onProgress?.({ stage: "media", done, total: refs.size });
    done += 1;
    try {
      const blob = (await getCachedMedia(mediaId)) ?? (client ? await client.fetchMedia(ref!) : null);
      if (!blob) continue;
      blobs.push({
        id: mediaId,
        mime: ref?.mime ?? blob.type ?? "application/octet-stream",
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
    } catch {
      // Expired on the server and never cached here. One unreachable photo
      // must not cost the member their entire text history.
    }
  }

  onProgress?.({ stage: "encrypting" });
  const sealed = await sealBackup(packArchive(manifest, blobs), passphrase);

  onProgress?.({ stage: "uploading" });
  const meta = await session.uploadBackup(sealed);
  return { byteSize: meta.byteSize };
}

export interface RestoreResult {
  messages: number;
  media: number;
  groups: number;
  skipped: number;
}

/** Downloads, decrypts and writes a backup into this device's stores.
 *
 * Merges rather than replaces. A message already here is kept as-is: its read
 * state and stars reflect what this device has actually seen, which is newer
 * than whatever the backup froze. */
export async function restoreBackup(
  session: Session,
  passphrase: string,
  onProgress?: (p: BackupProgress) => void
): Promise<RestoreResult> {
  onProgress?.({ stage: "downloading" });
  const sealed = await session.downloadBackup();

  onProgress?.({ stage: "decrypting" });
  const { manifest, blobs } = unpackArchive(await openBackup(sealed, passphrase));
  const data = manifest as unknown as BackupManifest;

  onProgress?.({ stage: "writing", done: 0, total: data.messages?.length ?? 0 });
  let restored = 0;
  let skipped = 0;
  let index = 0;
  for (const message of data.messages ?? []) {
    index += 1;
    if (index % 50 === 0) {
      onProgress?.({ stage: "writing", done: index, total: data.messages.length });
    }
    if (await getMessage(message.id)) {
      skipped += 1;
      continue;
    }
    await putMessage(message);
    restored += 1;
  }

  for (const [mediaId, blob] of blobs) {
    await putCachedMedia(mediaId, new Blob([blob.bytes], { type: blob.mime }));
  }

  for (const group of data.groups ?? []) {
    upsertFromRef(toRef(group), data.email);
  }
  for (const [chatId, settings] of Object.entries(data.chatSettings ?? {})) {
    updateChatSettings(chatId, settings);
  }

  return {
    messages: restored,
    media: blobs.size,
    groups: data.groups?.length ?? 0,
    skipped,
  };
}
