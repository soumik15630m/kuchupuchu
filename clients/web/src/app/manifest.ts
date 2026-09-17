import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kuchupuchu",
    short_name: "Kuchupuchu",
    description: "Private calls and messages",
    start_url: "/chats",
    display: "standalone",
    orientation: "portrait",
    background_color: "#111b21",
    theme_color: "#00a884",
    icons: [
      // One SVG rather than a PNG ladder: every browser that supports
      // installing a PWA also renders SVG icons, and a vector stays sharp at
      // whatever size the launcher asks for.
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
