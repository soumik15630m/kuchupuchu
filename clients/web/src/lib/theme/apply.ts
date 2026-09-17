import { readableInk, withAlpha } from "./color";
import { BUBBLE_PRESETS, FONT_SCALES, WALLPAPER_PRESETS, type ThemeSettings, type Wallpaper } from "./types";

export function resolveMode(mode: ThemeSettings["mode"]): "light" | "dark" {
  if (mode !== "system") return mode;
  if (typeof matchMedia === "undefined") return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveBubbleOut(bubbleOut: string, resolved: "light" | "dark"): string {
  const preset = BUBBLE_PRESETS.find((p) => p.id === bubbleOut);
  if (preset) return resolved === "dark" ? preset.dark : preset.light;
  return bubbleOut;
}

export function applyTheme(theme: ThemeSettings, root: HTMLElement = document.documentElement): void {
  const resolved = resolveMode(theme.mode);
  root.dataset.theme = resolved;
  root.style.setProperty("--font-scale", String(FONT_SCALES[theme.fontScale]));
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-ink", readableInk(theme.accent));
  root.style.setProperty("--accent-soft", withAlpha(theme.accent, 0.14));
  root.style.setProperty("--bubble-out", resolveBubbleOut(theme.bubbleOut, resolved));

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute("content", resolved === "dark" ? "#202c33" : "#f0f2f5");
  }
}

export interface WallpaperStyle {
  backgroundColor: string;
  backgroundImage?: string;
  backgroundSize?: string;
  dim: number;
}

/** `imageUrl` is resolved by the caller (an object URL for a stored blob) —
 * this module stays free of storage concerns so it can run on the server too. */
export function wallpaperStyle(wp: Wallpaper | undefined, imageUrl?: string): WallpaperStyle {
  const base: WallpaperStyle = { backgroundColor: "var(--chat-bg)", dim: wp?.dim ?? 0 };
  if (!wp || wp.kind === "none") return base;

  if (wp.kind === "solid") return { ...base, backgroundColor: wp.value };

  if (wp.kind === "image") {
    if (!imageUrl) return base;
    return { ...base, backgroundImage: `url(${imageUrl})`, backgroundSize: "cover" };
  }

  const preset = WALLPAPER_PRESETS.find((p) => p.id === wp.value);
  if (!preset || preset.css === "none") return base;
  return { ...base, backgroundImage: preset.css, backgroundSize: preset.size };
}

/** Runs before first paint, inlined into <head>. Kept deliberately small and
 * dependency-free: it only needs to prevent a light-mode flash, not reproduce
 * applyTheme. Anything it misses is corrected on hydration. */
export const NO_FLASH_SCRIPT = `
(function(){
  try {
    var raw = localStorage.getItem("kuchupuchu:theme");
    var t = raw ? JSON.parse(raw) : {};
    var mode = t.mode === "light" || t.mode === "dark" ? t.mode
      : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var r = document.documentElement;
    r.dataset.theme = mode;
    var scales = { small: 0.9, medium: 1, large: 1.15 };
    if (t.fontScale && scales[t.fontScale]) r.style.setProperty("--font-scale", scales[t.fontScale]);
    if (typeof t.accent === "string") r.style.setProperty("--accent", t.accent);
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
`.trim();
