"use client";

import { useEffect, useState } from "react";

import { getAvatar, putAvatar } from "@/lib/directory/avatar-store";
import { initialsFor } from "@/lib/directory/DirectoryProvider";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

/** A member's photo, falling back to initials.
 *
 * The blob is fetched and decrypted once, then cached on the record, so a chat
 * list of ten people does not re-download ten avatars on every render. */
export function Avatar({
  email,
  label,
  size = 48,
  className,
}: {
  email: string;
  label: string;
  size?: number;
  className?: string;
}) {
  const { client, profileRevision } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      const record = await getAvatar(email);
      if (!record || cancelled) {
        setUrl(null);
        return;
      }
      try {
        let blob = record.blob ?? null;
        if (!blob && client) {
          blob = await client.fetchMedia(record.media);
          await putAvatar({ ...record, blob });
        }
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // The blob may have aged out of the media store; initials still work.
        if (!cancelled) setUrl(null);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [email, client, profileRevision]);

  const style = { width: size, height: size, fontSize: Math.round(size / 2.8) };

  if (!url) {
    return (
      <span className={className} style={style} aria-hidden>
        {initialsFor(label)}
      </span>
    );
  }

  return (
    <span className={className} style={{ ...style, padding: 0, overflow: "hidden" }}>
      <img
        src={url}
        alt=""
        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }}
      />
    </span>
  );
}
