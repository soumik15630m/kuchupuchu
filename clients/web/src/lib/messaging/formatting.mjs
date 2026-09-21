// WhatsApp-style inline formatting, mentions and link detection.
//
// A real tokeniser rather than chained regex replacement into HTML: the
// message body is attacker-controlled text, and anything that builds markup
// by string substitution is one missed escape away from injecting it. This
// returns a segment list the renderer turns into React elements, so the text
// never becomes markup at all.
//
// Syntax follows WhatsApp's: *bold*, _italic_, ~strike~, ```mono```.

/** @typedef {{type: "text"|"bold"|"italic"|"strike"|"mono"|"link"|"mention", value: string, href?: string, email?: string, children?: any[]}} Segment */

const MARKERS = [
  { char: "```", type: "mono" },
  { char: "*", type: "bold" },
  { char: "_", type: "italic" },
  { char: "~", type: "strike" },
];

// Deliberately conservative: a scheme we trust, or a bare www./domain form.
// `javascript:` and `data:` must never become an href.
const URL_PATTERN =
  /\b((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:'"]|[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>()]*[^\s<>().,!?;:'"])/gi;

const MENTION_PATTERN = /(^|\s)@([a-z0-9._]{3,30})\b/gi;

export function isSafeHref(raw) {
  try {
    const url = new URL(raw.startsWith("www.") || !/^[a-z]+:/i.test(raw) ? `https://${raw}` : raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeHref(raw) {
  return /^[a-z]+:/i.test(raw) ? raw : `https://${raw}`;
}

/** Splits plain text into text/link/mention segments. */
function linkifyAndMention(text, mentionables) {
  /** @type {Segment[]} */
  const out = [];
  let cursor = 0;

  const matches = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    matches.push({ start: m.index, end: m.index + m[0].length, kind: "link", raw: m[0] });
  }
  for (const m of text.matchAll(MENTION_PATTERN)) {
    const lead = m[1] ?? "";
    const handle = m[2];
    const start = m.index + lead.length;
    // Only a handle that resolves to someone becomes a mention; otherwise it
    // is ordinary text, so a stray "@" never renders as a live reference.
    const email = mentionables?.get(handle.toLowerCase());
    if (!email) continue;
    matches.push({ start, end: start + handle.length + 1, kind: "mention", raw: handle, email });
  }
  matches.sort((a, b) => a.start - b.start);

  for (const match of matches) {
    if (match.start < cursor) continue; // overlapping; first wins
    if (match.start > cursor) out.push({ type: "text", value: text.slice(cursor, match.start) });

    if (match.kind === "link") {
      if (isSafeHref(match.raw)) {
        out.push({ type: "link", value: match.raw, href: normalizeHref(match.raw) });
      } else {
        out.push({ type: "text", value: match.raw });
      }
    } else {
      out.push({ type: "mention", value: `@${match.raw}`, email: match.email });
    }
    cursor = match.end;
  }

  if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
  return out;
}

/**
 * Parses a message body into renderable segments.
 *
 * @param {string} body
 * @param {Map<string,string>} [mentionables] username (lowercase) -> email
 * @returns {Segment[]}
 */
export function parseMessage(body, mentionables) {
  if (!body) return [];

  for (const { char, type } of MARKERS) {
    const open = body.indexOf(char);
    if (open === -1) continue;
    const close = body.indexOf(char, open + char.length);
    // An unmatched marker is literal text, which is why "2 * 3" survives.
    if (close === -1) continue;

    const inner = body.slice(open + char.length, close);
    if (inner.length === 0) continue;

    const before = body.slice(0, open);
    const after = body.slice(close + char.length);
    return [
      ...parseMessage(before, mentionables),
      {
        type,
        value: inner,
        // Monospace is literal by definition: formatting inside it would make
        // it useless for showing the markers themselves.
        children: type === "mono" ? [{ type: "text", value: inner }] : parseMessage(inner, mentionables),
      },
      ...parseMessage(after, mentionables),
    ];
  }

  return linkifyAndMention(body, mentionables);
}

/** Emails mentioned in `body`, for notifying them. */
export function mentionedEmails(body, mentionables) {
  const found = new Set();
  for (const segment of parseMessage(body, mentionables)) {
    collectMentions(segment, found);
  }
  return [...found];
}

function collectMentions(segment, found) {
  if (segment.type === "mention" && segment.email) found.add(segment.email);
  for (const child of segment.children ?? []) collectMentions(child, found);
}

/** Plain text with formatting markers removed, for previews and search. */
export function plainText(body) {
  return body.replace(/```|[*_~]/g, "");
}
