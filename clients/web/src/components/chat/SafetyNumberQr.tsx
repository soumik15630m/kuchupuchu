"use client";

import { useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useDialog } from "@/lib/a11y/useDialog";
import { QUIET_ZONE, encodeQr, qrPath } from "@/lib/crypto/qr.mjs";

import styles from "./chat.module.css";

/** A safety number as something scannable.
 *
 * Reading sixty digits aloud is where verification stops happening, and a
 * step people skip protects nobody. Holding two phones up to each other takes
 * a second.
 *
 * The QR carries the safety number and nothing else -- no address, no device
 * id, no key material. It is the same string already printed underneath, so a
 * photograph of the screen reveals exactly what saying it out loud would.
 */
export function SafetyNumberQr({
  safetyNumber,
  peerName,
  onClose,
}: {
  safetyNumber: string;
  peerName: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, onClose);
  const [failed, setFailed] = useState(false);

  const code = useMemo(() => {
    try {
      return encodeQr(safetyNumber);
    } catch {
      // A safety number should never exceed the encoder's range, but a
      // dialog that throws takes the chat down with it.
      setFailed(true);
      return null;
    }
  }, [safetyNumber]);

  const span = code ? code.size + QUIET_ZONE * 2 : 0;

  return (
    <div className={styles.menuBackdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.forwardSheet}
        role="dialog"
        aria-modal="true"
        aria-label={`Security code for ${peerName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.forwardHeader}>
          <h2 className={styles.infoTitle}>Verify {peerName}</h2>
          <button type="button" className={styles.emojiClose} aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        {code && !failed ? (
          <svg
            className={styles.qr}
            viewBox={`0 0 ${span} ${span}`}
            role="img"
            aria-label="Security code as a scannable code"
            shapeRendering="crispEdges"
          >
            {/* The quiet zone is four modules of white and is part of the
                spec — a symbol flush against a coloured panel often will not
                scan, so the background is drawn here rather than inherited. */}
            <rect width={span} height={span} fill="#fff" />
            <g transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`}>
              <path d={qrPath(code.matrix)} fill="#000" />
            </g>
          </svg>
        ) : (
          <p className={styles.infoEmpty}>Couldn&apos;t draw the code. The digits below still work.</p>
        )}

        <p className={styles.qrDigits}>{safetyNumber}</p>

        <p className={styles.infoNote}>
          Compare this with {peerName} over something this app doesn&apos;t carry — hold the two
          screens together, or read the digits over a phone call. If it matches, nobody is sitting
          between you. If it ever changes without one of you reinstalling, stop and ask why.
        </p>
      </div>
    </div>
  );
}
