import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kuchupuchu",
    short_name: "Kuchupuchu",
    description: "Private calls and messages",
    start_url: "/chats",
    display: "standalone",
    // Deliberately unset: locking orientation on an app whose main job is
    // video calls makes a tablet in landscape unusable.
    background_color: "#111b21",
    // Matches the light themeColor in layout.tsx's viewport. The manifest
    // colour is what the launcher and task switcher use; the two disagreeing
    // meant the installed app and the browser chrome were different colours.
    theme_color: "#f0f2f5",
    icons: [
      // One SVG rather than a PNG ladder: every browser that supports
      // installing a PWA also renders SVG icons, and a vector stays sharp at
      // whatever size the launcher asks for.
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
