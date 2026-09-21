"use client";

import { Fragment } from "react";

import { parseMessage } from "@/lib/messaging/formatting.mjs";

import styles from "./chat.module.css";

interface Segment {
  type: "text" | "bold" | "italic" | "strike" | "mono" | "link" | "mention";
  value: string;
  href?: string;
  email?: string;
  children?: Segment[];
}

function render(segments: Segment[], selfEmail: string | null, keyPrefix = ""): React.ReactNode {
  return segments.map((segment, i) => {
    const key = `${keyPrefix}${i}`;
    const inner = segment.children?.length
      ? render(segment.children, selfEmail, `${key}.`)
      : segment.value;

    switch (segment.type) {
      case "bold":
        return <strong key={key}>{inner}</strong>;
      case "italic":
        return <em key={key}>{inner}</em>;
      case "strike":
        return <s key={key}>{inner}</s>;
      case "mono":
        return (
          <code key={key} className={styles.mono}>
            {inner}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            className={styles.link}
            href={segment.href}
            target="_blank"
            // noreferrer as well as noopener: without it the destination
            // learns which conversation the link was opened from.
            rel="noopener noreferrer"
          >
            {segment.value}
          </a>
        );
      case "mention":
        return (
          <span
            key={key}
            className={styles.mention}
            data-self={segment.email === selfEmail ? "true" : undefined}
          >
            {segment.value}
          </span>
        );
      default:
        return <Fragment key={key}>{segment.value}</Fragment>;
    }
  });
}

/** Renders a message body. The parser returns segments rather than markup, so
 * attacker-controlled text is never interpreted as HTML. */
export function FormattedText({
  body,
  mentionables,
  selfEmail,
}: {
  body: string;
  mentionables?: Map<string, string>;
  selfEmail?: string | null;
}) {
  return <>{render(parseMessage(body, mentionables) as Segment[], selfEmail ?? null)}</>;
}
