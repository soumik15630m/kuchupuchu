"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { featuredGifs, gifsConfigured, searchGifs, type Gif } from "@/lib/messaging/gifs";
import {
  addSticker,
  listStickers,
  normalizeSticker,
  removeSticker,
  type Sticker,
} from "@/lib/messaging/stickers";

import styles from "./chat.module.css";
import { useDialog } from "@/lib/a11y/useDialog";

function StickerTile({
  sticker,
  onPick,
  onRemove,
}: {
  sticker: Sticker;
  onPick: (s: Sticker) => void;
  onRemove: (id: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(sticker.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [sticker.blob]);

  return (
    <div className={styles.stickerCell}>
      <button type="button" className={styles.stickerButton} onClick={() => onPick(sticker)}>
        {url && <img src={url} alt="Sticker" />}
      </button>
      <button
        type="button"
        className={styles.stickerRemove}
        aria-label="Remove sticker"
        onClick={() => onRemove(sticker.id)}
      >
        ×
      </button>
    </div>
  );
}

export function GifStickerPicker({
  onPickGif,
  onPickSticker,
  onClose,
}: {
  onPickGif: (gif: Gif) => void;
  onPickSticker: (sticker: Sticker) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, onClose);
  const [tab, setTab] = useState<"gif" | "sticker">(gifsConfigured() ? "gif" : "sticker");
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [term, setTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listStickers().then(setStickers);
  }, []);

  useEffect(() => {
    if (tab !== "gif" || !gifsConfigured()) return;
    setLoading(true);
    setError(null);
    const run = term.trim() ? searchGifs(term.trim()) : featuredGifs();
    const handle = setTimeout(() => {
      run
        .then(setGifs)
        .catch((err) => setError(err instanceof Error ? err.message : "Couldn't reach Tenor"))
        .finally(() => setLoading(false));
    }, term.trim() ? 350 : 0);
    return () => clearTimeout(handle);
  }, [tab, term]);

  async function onAddSticker(file: File) {
    const sticker = await addSticker(await normalizeSticker(file));
    setStickers((prev) => [sticker, ...prev]);
  }

  return (
    <div className={styles.emojiPanel} ref={dialogRef} role="dialog" aria-label="GIFs and stickers">
      <div className={styles.emojiTabs}>
        <button
          type="button"
          className={styles.gifTab}
          aria-current={tab === "gif" ? "true" : undefined}
          onClick={() => setTab("gif")}
        >
          GIFs
        </button>
        <button
          type="button"
          className={styles.gifTab}
          aria-current={tab === "sticker" ? "true" : undefined}
          onClick={() => setTab("sticker")}
        >
          Stickers
        </button>
        <button type="button" className={styles.emojiClose} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {tab === "gif" ? (
        !gifsConfigured() ? (
          <p className={styles.pickerNote}>
            GIF search needs a Tenor API key. Set <code>NEXT_PUBLIC_TENOR_KEY</code> and restart.
            Stickers work without it.
          </p>
        ) : (
          <>
            <div className={styles.gifSearch}>
              <Icon name="search" size={16} />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search Tenor"
                aria-label="Search GIFs"
              />
            </div>
            {error && <p className={styles.pickerNote}>{error}</p>}
            {loading && <p className={styles.pickerNote}>Loading…</p>}
            <div className={styles.gifGrid}>
              {gifs.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  className={styles.gifButton}
                  onClick={() => onPickGif(gif)}
                >
                  <img src={gif.previewUrl} alt={gif.description} loading="lazy" />
                </button>
              ))}
            </div>
          </>
        )
      ) : (
        <>
          <div className={styles.gifGrid}>
            {stickers.map((sticker) => (
              <StickerTile
                key={sticker.id}
                sticker={sticker}
                onPick={onPickSticker}
                onRemove={async (id) => {
                  await removeSticker(id);
                  setStickers((prev) => prev.filter((s) => s.id !== id));
                }}
              />
            ))}
            <button
              type="button"
              className={styles.gifButton}
              onClick={() => fileRef.current?.click()}
              aria-label="Add a sticker"
            >
              <span className={styles.addSticker}>
                <Icon name="plus" size={20} />
              </span>
            </button>
          </div>
          {stickers.length === 0 && (
            <p className={styles.pickerNote}>
              Add any image to build your own sticker set. Transparency is kept.
            </p>
          )}
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onAddSticker(file);
        }}
      />
    </div>
  );
}
