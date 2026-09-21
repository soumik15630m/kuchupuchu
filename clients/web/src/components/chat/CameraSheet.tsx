"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";

import styles from "./chat.module.css";

/** In-app capture. Deliberately separate from the file picker: on a phone the
 * picker's "camera" option hands back a full-resolution photo via the OS, which
 * is slower and gives no preview. */
export function CameraSheet({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function open() {
      setReady(false);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch {
        setError("Camera permission is needed to take a photo.");
      }
    }

    void open();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing]);

  function capture() {
    const video = videoRef.current;
    if (!video || !ready) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The preview is mirrored for a front camera so it reads like a mirror,
    // but the captured photo must not be — text in shot would be backwards.
    ctx.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
      onClose();
    }, "image/jpeg", 0.9);
  }

  return (
    <div className={styles.cameraSheet} role="dialog" aria-label="Camera">
      <div className={styles.cameraStage}>
        {error ? (
          <p className={styles.pickerNote}>{error}</p>
        ) : (
          <video
            ref={videoRef}
            className={styles.cameraPreview}
            data-mirrored={facing === "user" ? "true" : undefined}
            playsInline
            muted
          />
        )}
      </div>

      <div className={styles.cameraControls}>
        <button type="button" className={styles.cameraSecondary} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.shutter}
          onClick={capture}
          disabled={!ready}
          aria-label="Take photo"
        />
        <button
          type="button"
          className={styles.cameraSecondary}
          onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
          aria-label="Switch camera"
        >
          <Icon name="video" size={20} />
        </button>
      </div>
    </div>
  );
}
