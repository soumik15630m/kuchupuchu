"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { WALLPAPER_PRESETS } from "@/lib/theme/types";
import { deleteWallpaper, getWallpaper, normalizeWallpaper, putWallpaper } from "@/lib/theme/wallpaper-store";

import styles from "@/app/settings/theme/theme.module.css";

export function WallpaperPicker({ chatId = "default" }: { chatId?: string }) {
  const { wallpaperFor, setWallpaper } = useTheme();
  const current = wallpaperFor(chatId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (current.kind !== "image") {
      setCustomUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    getWallpaper(current.value).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setCustomUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [current.kind, current.value]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const key = `${chatId}:${Date.now()}`;
      await putWallpaper(key, await normalizeWallpaper(file));
      if (current.kind === "image") await deleteWallpaper(current.value);
      setWallpaper(chatId, { kind: "image", value: key, dim: current.dim });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.wallpapers}>
        {WALLPAPER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={current.kind === "preset" && current.value === preset.id}
            className={styles.wallpaper}
            style={{
              backgroundColor: "var(--chat-bg)",
              backgroundImage: preset.css === "none" ? undefined : preset.css,
              backgroundSize: preset.size,
            }}
            onClick={() => setWallpaper(chatId, { kind: "preset", value: preset.id, dim: current.dim })}
          >
            <span className={styles.wallpaperName}>{preset.label}</span>
          </button>
        ))}

        <button
          type="button"
          role="radio"
          aria-checked={current.kind === "image"}
          className={`${styles.wallpaper} ${styles.uploadTile}`}
          style={customUrl ? { backgroundImage: `url(${customUrl})`, backgroundSize: "cover" } : undefined}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {!customUrl && <Icon name="image" size={20} />}
          <span className={styles.wallpaperName}>{busy ? "Loading…" : "Photo"}</span>
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="visually-hidden"
        onChange={onUpload}
      />

      <div className={styles.sliderRow} style={{ marginTop: 16 }}>
        <label htmlFor="wp-dim">Dim</label>
        <span>{Math.round(current.dim * 100)}%</span>
      </div>
      <input
        id="wp-dim"
        className={styles.slider}
        type="range"
        min={0}
        max={0.8}
        step={0.05}
        value={current.dim}
        onChange={(e) => setWallpaper(chatId, { ...current, dim: Number(e.target.value) })}
      />
    </>
  );
}
