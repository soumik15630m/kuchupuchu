const PATHS = {
  chats: "M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z",
  calls:
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z",
  status: "M12 3a9 9 0 1 0 9 9",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  back: "M19 12H5m0 0 7 7m-7-7 7-7",
  video: "M23 7l-7 5 7 5V7ZM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z",
  phone:
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z",
  send: "m22 2-7 20-4-9-9-4 20-7Z",
  mic: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Zm7 11a7 7 0 0 1-14 0m7 7v4",
  micOff: "M1 1l22 22M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V4a3 3 0 0 0-5.9-.8M19 12a7 7 0 0 1-1 3.6M5 12a7 7 0 0 0 10.6 6M12 19v4",
  camOff: "M1 1l22 22M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1m5 0h5a2 2 0 0 1 2 2v3l7-5v11",
  hangup: "M2 9a20 20 0 0 1 20 0v3.5a2 2 0 0 1-2.2 2l-2.6-.3a2 2 0 0 1-1.7-1.6l-.3-1.8a14 14 0 0 0-6.4 0l-.3 1.8a2 2 0 0 1-1.7 1.6l-2.6.3A2 2 0 0 1 2 12.5V9Z",
  attach: "M21.4 11.1 12.3 20a5.5 5.5 0 0 1-7.8-7.8l9.2-9.1a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.1a1.8 1.8 0 0 1-2.6-2.6l8.5-8.4",
  emoji: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3",
  check: "m4 12 5 5L20 6",
  plus: "M12 5v14M5 12h14",
  image: "M3 5h18v14H3V5Zm0 10 5-5 4 4 3-3 6 6",
  chevron: "m9 6 6 6-6 6",
  // Their own paths rather than a rotated `chevron`: a transform on an
  // inline SVG rotates about the viewBox, not the glyph, so the arrows
  // ended up off-centre in a 18px button.
  chevronUp: "m6 15 6-6 6 6",
  chevronDown: "m6 9 6 6 6-6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5v-5m0-3h.01",
  shield: "M12 2 4 5v6c0 5 3.4 9.2 8 11 4.6-1.8 8-6 8-11V5l-8-3Z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
  // The call bar previously drew data saver, screen share and PiP all with
  // `image` -- three adjacent buttons with byte-identical paths. Star and pin
  // both used `check`, and "cancel reply" used `plus`.
  screenShare: "M3 4h18v12H3V4Zm6 16h6m-3-4v4",
  pip: "M3 5h18v14H3V5Zm10 6h6v5h-6v-5Z",
  dataSaver: "M12 3v18m0-18a9 9 0 0 1 0 18M7 8.5h3m-3 7h3",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z",
  pin: "M12 17v5m-5-9.5 1.5-6.2A2 2 0 0 1 10.4 5h3.2a2 2 0 0 1 2 1.3L17 12.5M6 12.5h12",
  close: "M18 6 6 18M6 6l12 12",
  forward: "m14 5 7 7-7 7M3 12h18",
  pause: "M9 5v14M15 5v14",
  play: "m7 4 12 8-12 8V4Z",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0",
  cloud: "M18 17a4 4 0 0 0-1.3-7.8A6 6 0 0 0 5 10.5 3.5 3.5 0 0 0 6 17h12ZM12 12v8m0 0 3-3m-3 3-3-3",
  key: "M15 7a4 4 0 1 1-3.5 5.9L9 15.4l-2 .2.2 2-2.2.2.2 2-3.2.2.3-3.3 7.2-7.2A4 4 0 0 1 15 7Zm1.5 2.5h.01",
  palette:
    "M12 21a9 9 0 1 1 0-18c4.9 0 9 3.6 9 8 0 2.5-2 4-4.5 4H14a2 2 0 0 0-1.4 3.4A1.8 1.8 0 0 1 12 21Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 22,
  filled = false,
  className,
}: {
  name: IconName;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
