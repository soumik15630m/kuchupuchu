export type ThemeMode = "light" | "dark" | "system";

export type FontScale = "small" | "medium" | "large";

export const FONT_SCALES: Record<FontScale, number> = {
  small: 0.9,
  medium: 1,
  large: 1.15,
};

export type WallpaperKind = "preset" | "solid" | "image" | "none";

export interface Wallpaper {
  kind: WallpaperKind;
  /** Preset id for `preset`, a CSS colour for `solid`, an object-store key for `image`. */
  value: string;
  /** 0..1, applied as a dimming scrim over the wallpaper. */
  dim: number;
}

export interface ThemeSettings {
  mode: ThemeMode;
  accent: string;
  bubbleOut: string;
  fontScale: FontScale;
  /** Per-chat overrides keyed by chat id; `default` is the global wallpaper. */
  wallpapers: Record<string, Wallpaper>;
}

export const ACCENT_PRESETS = [
  { id: "teal", label: "Teal", value: "#00a884" },
  { id: "indigo", label: "Indigo", value: "#5b6ef5" },
  { id: "violet", label: "Violet", value: "#8b5cf6" },
  { id: "rose", label: "Rose", value: "#f43f5e" },
  { id: "amber", label: "Amber", value: "#f59e0b" },
  { id: "sky", label: "Sky", value: "#0ea5e9" },
  { id: "emerald", label: "Emerald", value: "#10b981" },
  { id: "slate", label: "Slate", value: "#64748b" },
] as const;

export const BUBBLE_PRESETS = [
  { id: "default", label: "Default", light: "#d9fdd3", dark: "#005c4b" },
  { id: "sky", label: "Sky", light: "#d4ecff", dark: "#0b4a6f" },
  { id: "lilac", label: "Lilac", light: "#e6ddff", dark: "#4c3a75" },
  { id: "sand", label: "Sand", light: "#ffeccc", dark: "#6b4f1d" },
  { id: "rose", label: "Rose", light: "#ffdde3", dark: "#6d2438" },
  { id: "mint", label: "Mint", light: "#d3f7ee", dark: "#16544a" },
] as const;

/** CSS backgrounds rather than image files — no binary assets to ship, and they
 * re-theme with the palette instead of fighting it in dark mode. */
export const WALLPAPER_PRESETS = [
  {
    id: "doodle",
    label: "Doodles",
    css: `radial-gradient(circle at 20% 30%, var(--wp-tint) 0 2px, transparent 3px),
          radial-gradient(circle at 70% 60%, var(--wp-tint) 0 2px, transparent 3px),
          radial-gradient(circle at 45% 85%, var(--wp-tint) 0 2px, transparent 3px)`,
    size: "120px 120px",
  },
  {
    id: "weave",
    label: "Weave",
    css: `repeating-linear-gradient(45deg, var(--wp-tint) 0 1px, transparent 1px 12px),
          repeating-linear-gradient(-45deg, var(--wp-tint) 0 1px, transparent 1px 12px)`,
    size: "auto",
  },
  {
    id: "dots",
    label: "Dots",
    css: `radial-gradient(circle, var(--wp-tint) 1px, transparent 1.5px)`,
    size: "18px 18px",
  },
  {
    id: "waves",
    label: "Waves",
    css: `repeating-radial-gradient(circle at 0 0, transparent 0 18px, var(--wp-tint) 18px 19px)`,
    size: "auto",
  },
  {
    id: "grid",
    label: "Grid",
    css: `linear-gradient(var(--wp-tint) 1px, transparent 1px),
          linear-gradient(90deg, var(--wp-tint) 1px, transparent 1px)`,
    size: "28px 28px",
  },
  {
    id: "plain",
    label: "Plain",
    css: "none",
    size: "auto",
  },
] as const;

export const DEFAULT_THEME: ThemeSettings = {
  mode: "system",
  accent: "#00a884",
  bubbleOut: "default",
  fontScale: "medium",
  wallpapers: { default: { kind: "preset", value: "doodle", dim: 0 } },
};
