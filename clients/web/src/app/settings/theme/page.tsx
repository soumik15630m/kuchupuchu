"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { WallpaperPicker } from "@/components/theme/WallpaperPicker";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { wallpaperStyle } from "@/lib/theme/apply";
import { isValidHex, readableInk } from "@/lib/theme/color";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { ACCENT_PRESETS, BUBBLE_PRESETS, type FontScale, type ThemeMode } from "@/lib/theme/types";
import { getWallpaper } from "@/lib/theme/wallpaper-store";

import styles from "./theme.module.css";

const MODES: { id: ThemeMode; label: string; note: string }[] = [
  { id: "light", label: "Light", note: "Always light" },
  { id: "dark", label: "Dark", note: "Always dark" },
  { id: "system", label: "System default", note: "Follows your device setting" },
];

const FONT_SIZES: { id: FontScale; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

function Radio({
  checked,
  label,
  note,
  onSelect,
}: {
  checked: boolean;
  label: string;
  note?: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={styles.radio} onClick={onSelect}>
      <span className={styles.radioMark} />
      <span className={styles.radioLabel}>
        {label}
        {note && <span className={styles.radioNote}>{note}</span>}
      </span>
    </button>
  );
}

function Preview() {
  const { theme, wallpaperFor, resolvedMode } = useTheme();
  const wp = wallpaperFor("default");
  const [imageUrl, setImageUrl] = useState<string | undefined>();

  useEffect(() => {
    if (wp.kind !== "image") {
      setImageUrl(undefined);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    getWallpaper(wp.value).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setImageUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [wp.kind, wp.value]);

  const style = wallpaperStyle(wp, imageUrl);

  return (
    <div className={styles.preview}>
      <div
        className={styles.previewChat}
        style={{
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backgroundSize: style.backgroundSize,
        }}
      >
        {style.dim > 0 && <span className={styles.previewScrim} style={{ opacity: style.dim }} />}
        <div className={`${styles.bubble} ${styles.bubbleIn}`}>
          How&apos;s the connection today?
          <span className={styles.bubbleMeta}>09:41</span>
        </div>
        <div className={`${styles.bubble} ${styles.bubbleOut}`}>
          Much better since the switch.
          <span className={styles.bubbleMeta}>09:42</span>
        </div>
      </div>
    </div>
  );
}

export default function ThemePage() {
  const { theme, setTheme, resolvedMode, reset } = useTheme();
  const [hex, setHex] = useState(theme.accent);

  useEffect(() => setHex(theme.accent), [theme.accent]);

  function commitHex(value: string) {
    setHex(value);
    if (isValidHex(value)) setTheme({ accent: value.startsWith("#") ? value : `#${value}` });
  }

  return (
    <AppShell pane="detail" detail={null}>
      <Pane>
        <PaneHeader title="Theme" backHref="/settings" />
        <PaneScroll>
          <Preview />

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Appearance</h2>
            <div className={styles.options} role="radiogroup" aria-label="Appearance">
              {MODES.map((m) => (
                <Radio
                  key={m.id}
                  checked={theme.mode === m.id}
                  label={m.label}
                  note={m.note}
                  onSelect={() => setTheme({ mode: m.id })}
                />
              ))}
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Accent colour</h2>
            <div className={styles.swatches} role="radiogroup" aria-label="Accent colour">
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={theme.accent.toLowerCase() === preset.value}
                  aria-label={preset.label}
                  className={styles.swatch}
                  style={{ background: preset.value, color: readableInk(preset.value) }}
                  onClick={() => setTheme({ accent: preset.value })}
                >
                  {theme.accent.toLowerCase() === preset.value && <Icon name="check" size={18} />}
                </button>
              ))}
            </div>

            <div className={styles.customRow}>
              <input
                className={styles.colorInput}
                type="color"
                aria-label="Custom accent colour"
                value={isValidHex(hex) ? (hex.startsWith("#") ? hex : `#${hex}`) : "#00a884"}
                onChange={(e) => commitHex(e.target.value)}
              />
              <input
                className={styles.hexInput}
                value={hex}
                aria-label="Accent colour hex value"
                aria-invalid={!isValidHex(hex)}
                spellCheck={false}
                onChange={(e) => commitHex(e.target.value)}
              />
            </div>
            <p className={styles.hint}>Text on accent-coloured buttons flips to stay readable.</p>
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Bubble colour</h2>
            <div className={styles.swatches} role="radiogroup" aria-label="Bubble colour">
              {BUBBLE_PRESETS.map((preset) => {
                const shown = resolvedMode === "dark" ? preset.dark : preset.light;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={theme.bubbleOut === preset.id}
                    aria-label={preset.label}
                    className={styles.swatch}
                    style={{ background: shown, color: readableInk(shown) }}
                    onClick={() => setTheme({ bubbleOut: preset.id })}
                  >
                    {theme.bubbleOut === preset.id && <Icon name="check" size={18} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Chat wallpaper</h2>
            <WallpaperPicker chatId="default" />
            <p className={styles.hint}>
              This is the default for every chat. Open a chat&apos;s own settings to override it there.
            </p>
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Font size</h2>
            <div className={styles.fontRow}>
              <small>A</small>
              <div className={styles.options} style={{ flex: 1 }} role="radiogroup" aria-label="Font size">
                {FONT_SIZES.map((f) => (
                  <Radio
                    key={f.id}
                    checked={theme.fontScale === f.id}
                    label={f.label}
                    onSelect={() => setTheme({ fontScale: f.id })}
                  />
                ))}
              </div>
              <big>A</big>
            </div>
          </div>

          <div className={styles.resetRow}>
            <button className={styles.reset} type="button" onClick={reset}>
              Reset to defaults
            </button>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
