"use client";

import { useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useDialog } from "@/lib/a11y/useDialog";
import { presets, validate } from "@/lib/messaging/scheduled.mjs";

import styles from "./chat.module.css";

/** Picking when a message should go.
 *
 * The presets are the point. "Tomorrow, 9am" is what someone actually wants
 * across an eight-and-a-half-hour gap, and a datetime field alone would make
 * the common case the fiddly one.
 */
export function ScheduleSheet({
  onPick,
  onClose,
}: {
  onPick: (atMs: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, onClose);
  const now = useMemo(() => Date.now(), []);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  const choose = (atMs: number) => {
    const problem = validate(atMs, Date.now());
    if (problem) {
      setError(problem);
      return;
    }
    onPick(atMs);
  };

  return (
    <div className={styles.menuBackdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.forwardSheet}
        role="dialog"
        aria-modal="true"
        aria-label="Send later"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.forwardHeader}>
          <h2 className={styles.infoTitle}>Send later</h2>
          <button type="button" className={styles.emojiClose} aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className={styles.attachMenu}>
          {presets(now).map((option) => (
            <button
              key={option.label}
              type="button"
              className={styles.attachOption}
              onClick={() => choose(option.atMs)}
            >
              <Icon name="clock" size={18} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>

        <label className={styles.scheduleLabel} htmlFor="schedule-at">
          Or pick a time
        </label>
        <input
          id="schedule-at"
          className={styles.findInput}
          type="datetime-local"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setError(null);
          }}
        />
        <button
          type="button"
          className={styles.editorSend}
          disabled={!custom}
          // `datetime-local` has no timezone, so this parses in the member's
          // own — which is what they meant when they typed it.
          onClick={() => choose(new Date(custom).getTime())}
        >
          Schedule
        </button>

        {error && (
          <p className={styles.infoEmpty} role="alert">
            {error}
          </p>
        )}

        <p className={styles.infoNote}>
          Kuchupuchu has to be open for this to send. If it is closed at the time, the message goes
          out the next time you open it and says how late it was — no browser lets an app send
          something on its own with every tab shut.
        </p>
      </div>
    </div>
  );
}
