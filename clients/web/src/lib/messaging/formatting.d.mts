export interface Segment {
  type: "text" | "bold" | "italic" | "strike" | "mono" | "link" | "mention";
  value: string;
  href?: string;
  email?: string;
  children?: Segment[];
}

export function isSafeHref(raw: string): boolean;
export function normalizeHref(raw: string): string;

/** `mentionables` maps a lowercase username to the member's email. */
export function parseMessage(body: string, mentionables?: Map<string, string>): Segment[];
export function mentionedEmails(body: string, mentionables?: Map<string, string>): string[];
export function plainText(body: string): string;

export function firstLink(body: string): string | null;
