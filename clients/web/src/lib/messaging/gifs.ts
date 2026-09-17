/** §10.5 calls GIFs "the one point in this design that isn't fully
 * self-hosted/private, a reasonable trade-off for convenience". This narrows
 * that as far as it can go:
 *
 *  - The search query goes to Tenor from the SENDER only. The recipient never
 *    talks to Tenor.
 *  - The chosen GIF is downloaded, encrypted client-side and sent through the
 *    same blob pipeline as any other attachment, so the recipient fetches
 *    ciphertext from our own media store rather than a Tenor URL. A bare URL
 *    would leak who is watching what, and when, to a third party.
 *
 * What remains exposed, and cannot be avoided while using a GIF service at
 * all: Tenor sees the sender's IP and search terms.
 */

const TENOR_ENDPOINT = "https://tenor.googleapis.com/v2";

export interface Gif {
  id: string;
  description: string;
  previewUrl: string;
  fullUrl: string;
  width: number;
  height: number;
}

export function gifKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TENOR_KEY;
  return key && key.trim() ? key.trim() : null;
}

export function gifsConfigured(): boolean {
  return gifKey() !== null;
}

interface TenorMediaFormat {
  url: string;
  dims?: [number, number];
}

interface TenorResult {
  id: string;
  content_description?: string;
  media_formats?: Record<string, TenorMediaFormat>;
}

function toGif(result: TenorResult): Gif | null {
  const formats = result.media_formats ?? {};
  // tinygif for the grid, gif for what actually gets sent -- the full-size
  // asset is often several MB, which is not what a picker should preload.
  const preview = formats.tinygif ?? formats.nanogif ?? formats.gif;
  const full = formats.gif ?? formats.mediumgif ?? preview;
  if (!preview || !full) return null;
  return {
    id: result.id,
    description: result.content_description ?? "GIF",
    previewUrl: preview.url,
    fullUrl: full.url,
    width: full.dims?.[0] ?? 0,
    height: full.dims?.[1] ?? 0,
  };
}

async function query(path: string, params: Record<string, string>): Promise<Gif[]> {
  const key = gifKey();
  if (!key) throw new Error("No Tenor API key configured");

  const url = new URL(`${TENOR_ENDPOINT}/${path}`);
  url.searchParams.set("key", key);
  url.searchParams.set("client_key", "kuchupuchu");
  url.searchParams.set("limit", "24");
  url.searchParams.set("media_filter", "tinygif,gif,mediumgif");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  const res = await fetch(url, { referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Tenor returned ${res.status}`);
  const body = (await res.json()) as { results?: TenorResult[] };
  return (body.results ?? []).flatMap((r) => {
    const gif = toGif(r);
    return gif ? [gif] : [];
  });
}

export function featuredGifs(): Promise<Gif[]> {
  return query("featured", {});
}

export function searchGifs(term: string): Promise<Gif[]> {
  return query("search", { q: term });
}

/** Fetched by the sender so the blob can be encrypted before it is stored. */
export async function downloadGif(gif: Gif): Promise<Blob> {
  const res = await fetch(gif.fullUrl, { referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Could not download that GIF (${res.status})`);
  return res.blob();
}
