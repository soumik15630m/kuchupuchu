import { DEFAULT_THEME, FONT_SCALES, type ThemeSettings } from "./types";

export const THEME_STORAGE_KEY = "kuchupuchu:theme";

/** Never throws and never returns a partially-shaped object — a corrupt or
 * half-written value must degrade to defaults, not crash the shell before it
 * can render the settings screen that would let the user fix it. */
export function coerceTheme(raw: unknown): ThemeSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_THEME };
  const v = raw as Partial<ThemeSettings>;

  const mode =
    v.mode === "light" || v.mode === "dark" || v.mode === "system" ? v.mode : DEFAULT_THEME.mode;
  const fontScale =
    typeof v.fontScale === "string" && v.fontScale in FONT_SCALES
      ? (v.fontScale as ThemeSettings["fontScale"])
      : DEFAULT_THEME.fontScale;

  const wallpapers: ThemeSettings["wallpapers"] = {};
  if (v.wallpapers && typeof v.wallpapers === "object") {
    for (const [chatId, wp] of Object.entries(v.wallpapers)) {
      if (!wp || typeof wp !== "object") continue;
      const kind = (wp as { kind?: unknown }).kind;
      if (kind !== "preset" && kind !== "solid" && kind !== "image" && kind !== "none") continue;
      const value = (wp as { value?: unknown }).value;
      const dim = (wp as { dim?: unknown }).dim;
      wallpapers[chatId] = {
        kind,
        value: typeof value === "string" ? value : "",
        dim: typeof dim === "number" && dim >= 0 && dim <= 1 ? dim : 0,
      };
    }
  }
  if (!wallpapers.default) wallpapers.default = { ...DEFAULT_THEME.wallpapers.default };

  return {
    mode,
    accent: typeof v.accent === "string" ? v.accent : DEFAULT_THEME.accent,
    bubbleOut: typeof v.bubbleOut === "string" ? v.bubbleOut : DEFAULT_THEME.bubbleOut,
    fontScale,
    wallpapers,
  };
}

export function readStoredTheme(): ThemeSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_THEME };
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return coerceTheme(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export function writeStoredTheme(theme: ThemeSettings): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Private browsing or a full quota. The in-memory theme still applies for
    // this session; losing persistence is not worth breaking the UI over.
  }
}
