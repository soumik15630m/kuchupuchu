"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { applyTheme, resolveMode } from "./apply";
import {
  readStoredTheme,
  writeStoredTheme,
  THEME_STORAGE_KEY,
  THEME_SYNC_EVENT,
} from "./storage";
import { DEFAULT_THEME, type ThemeSettings, type Wallpaper } from "./types";

interface ThemeContextValue {
  theme: ThemeSettings;
  resolvedMode: "light" | "dark";
  setTheme: (patch: Partial<ThemeSettings>) => void;
  setWallpaper: (chatId: string, wallpaper: Wallpaper | null) => void;
  wallpaperFor: (chatId: string) => Wallpaper;
  reset: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeSettings>(DEFAULT_THEME);
  const [resolvedMode, setResolvedMode] = useState<"light" | "dark">("light");

  // Reading localStorage during render would desync from the server-rendered
  // markup; the inline no-flash script has already painted the right palette.
  useEffect(() => {
    const stored = readStoredTheme();
    setThemeState(stored);
    applyTheme(stored);
    setResolvedMode(resolveMode(stored.mode));
  }, []);

  useEffect(() => {
    if (theme.mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme(theme);
      setResolvedMode(resolveMode(theme.mode));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Another tab changing the theme should not leave this one stale. The
  // synced event covers the same ground for another *device*.
  useEffect(() => {
    const adopt = () => {
      const next = readStoredTheme();
      setThemeState(next);
      applyTheme(next);
      setResolvedMode(resolveMode(next.mode));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      adopt();
    };
    addEventListener("storage", onStorage);
    addEventListener(THEME_SYNC_EVENT, adopt);
    return () => {
      removeEventListener("storage", onStorage);
      removeEventListener(THEME_SYNC_EVENT, adopt);
    };
  }, []);

  const commit = useCallback((next: ThemeSettings) => {
    setThemeState(next);
    applyTheme(next);
    setResolvedMode(resolveMode(next.mode));
    writeStoredTheme(next);
  }, []);

  const setTheme = useCallback(
    (patch: Partial<ThemeSettings>) => {
      setThemeState((prev) => {
        const next = { ...prev, ...patch };
        applyTheme(next);
        setResolvedMode(resolveMode(next.mode));
        writeStoredTheme(next);
        return next;
      });
    },
    []
  );

  const setWallpaper = useCallback((chatId: string, wallpaper: Wallpaper | null) => {
    setThemeState((prev) => {
      const wallpapers = { ...prev.wallpapers };
      if (wallpaper === null) delete wallpapers[chatId];
      else wallpapers[chatId] = wallpaper;
      const next = { ...prev, wallpapers };
      writeStoredTheme(next);
      return next;
    });
  }, []);

  const wallpaperFor = useCallback(
    (chatId: string) => theme.wallpapers[chatId] ?? theme.wallpapers.default ?? DEFAULT_THEME.wallpapers.default,
    [theme]
  );

  const reset = useCallback(() => commit({ ...DEFAULT_THEME }), [commit]);

  const value = useMemo(
    () => ({ theme, resolvedMode, setTheme, setWallpaper, wallpaperFor, reset }),
    [theme, resolvedMode, setTheme, setWallpaper, wallpaperFor, reset]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
