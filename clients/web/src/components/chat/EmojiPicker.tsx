"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import styles from "./chat.module.css";

/** Unicode emoji via the system font (§10.5) rather than an image sprite
 * sheet — no assets to ship, and they render in whatever style the user's own
 * platform uses. */
const GROUPS: { label: string; emoji: string[] }[] = [
  {
    label: "Smileys",
    emoji: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤗 🤭 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🥳 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 🤗".split(" "),
  },
  {
    label: "Gestures",
    emoji: "👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 💪 🦾 ✍️ 👏 🙌 👐 🤲".split(" "),
  },
  {
    label: "Hearts",
    emoji: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟".split(" "),
  },
  {
    label: "Things",
    emoji: "🔥 ✨ 🎉 🎊 🎁 🏆 ⭐ 🌟 💫 ⚡ ☀️ 🌙 ☁️ 🌈 ❄️ 🍕 🍔 🍟 🍜 🍣 ☕ 🍵 🍺 🍷 🎂 🍰 🍎 🍌 🚗 ✈️ 🏠 📱 💻 🎵 🎧 📷 ⏰ 💡".split(" "),
  },
  {
    label: "Animals",
    emoji: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🦋 🐝 🐢 🐍 🐙 🦀 🐬 🐳 🦈 🐊".split(" "),
  },
];

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => GROUPS[group].emoji, [group]);

  return (
    <div className={styles.emojiPanel} ref={ref} role="dialog" aria-label="Emoji">
      <div className={styles.emojiTabs}>
        {GROUPS.map((g, i) => (
          <button
            key={g.label}
            type="button"
            className={styles.emojiTab}
            aria-current={i === group ? "true" : undefined}
            onClick={() => setGroup(i)}
          >
            {g.emoji[0]}
          </button>
        ))}
        <button type="button" className={styles.emojiClose} onClick={onClose} aria-label="Close emoji">
          ✕
        </button>
      </div>
      <div className={styles.emojiGrid}>
        {shown.map((emoji) => (
          <button key={emoji} type="button" className={styles.emoji} onClick={() => onPick(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
