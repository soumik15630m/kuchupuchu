"use client";

import { Fragment } from "react";

import { parseMessage } from "@/lib/messaging/formatting.mjs";
import { highlightParts } from "@/lib/messaging/find-in-chat.mjs";

import styles from "./chat.module.css";

interface Segment {
  type: "text" | "bold" | "italic" | "strike" | "mono" | "link" | "mention";
  value: string;
  href?: string;
  email?: string;
  children?: Segment[];
}

/** Wraps the runs of `text` that match the find-in-chat query.
 *
 * Applied to leaf text rather than the whole body so it survives formatting:
 * a match spanning a bold marker still highlights the visible characters.
 * Split with indexOf rather than a RegExp -- a typed "(" would otherwise be a
 * syntax error rather than a search. */
function mark(text: string, highlight: string | undefined, key: string): React.ReactNode {
  if (!highlight?.trim()) return text;
  const parts = highlightParts(text, highlight);
  if (parts.length === 1 && !parts[0].match) return text;
  return parts.map((part, i) =>
    part.match ? (
      <mark key={`${key}h${i}`} className={styles.searchHit}>
        {part.text}
      </mark>
    ) : (
      <Fragment key={`${key}h${i}`}>{part.text}</Fragment>
    )
  );
}

function render(
  segments: Segment[],
  selfEmail: string | null,
  highlight: string | undefined,
  keyPrefix = ""
): React.ReactNode {
  return segments.map((segment, i) => {
    const key = `${keyPrefix}${i}`;
    const inner = segment.children?.length
      ? render(segment.children, selfEmail, highlight, `${key}.`)
      : mark(segment.value, highlight, key);

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
            {mark(segment.value, highlight, key)}
          </a>
        );
      case "mention":
        return (
          <span
            key={key}
            className={styles.mention}
            data-self={segment.email === selfEmail ? "true" : undefined}
          >
            {mark(segment.value, highlight, key)}
          </span>
        );
      default:
        return <Fragment key={key}>{mark(segment.value, highlight, key)}</Fragment>;
    }
  });
}

/** Renders a message body. The parser returns segments rather than markup, so
 * attacker-controlled text is never interpreted as HTML. */
export function FormattedText({
  body,
  mentionables,
  selfEmail,
  highlight,
}: {
  body: string;
  mentionables?: Map<string, string>;
  selfEmail?: string | null;
  /** The find-in-chat query, when one is running. */
  highlight?: string;
}) {
  return (
    <>{render(parseMessage(body, mentionables) as Segment[], selfEmail ?? null, highlight)}</>
  );
}
