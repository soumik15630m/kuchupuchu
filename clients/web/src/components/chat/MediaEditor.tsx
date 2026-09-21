"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import {
  clampCrop,
  cropForAspect,
  cropPixels,
  FULL_CROP,
  intoCrop,
  normaliseRotation,
  pointIn,
  rotatedSize,
  type Point,
  type Rect,
} from "@/lib/messaging/media-edit.mjs";

import styles from "./chat.module.css";

const PEN_COLOURS = ["#ffffff", "#000000", "#ff3b30", "#ffcc00", "#34c759", "#0a84ff"];
const ASPECTS: { label: string; value: number | null }[] = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "4:5", value: 4 / 5 },
  { label: "16:9", value: 16 / 9 },
];

interface Stroke {
  colour: string;
  /** Normalised to the *uncropped* image, so cropping later does not drag
   * the drawing around. */
  points: Point[];
}

interface TextItem {
  at: Point;
  text: string;
  colour: string;
}

export function MediaEditor({
  file,
  onCancel,
  onDone,
}: {
  file: File;
  onCancel: () => void;
  /** Hands back a flattened JPEG; the caller sends it through the ordinary
   * encrypted media pipeline, editor or no editor. */
  onDone: (blob: Blob, caption: string) => void;
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState<Rect>({ ...FULL_CROP });
  const [aspect, setAspect] = useState<number | null>(null);
  const [tool, setTool] = useState<"crop" | "draw" | "text">("crop");
  const [colour, setColour] = useState(PEN_COLOURS[2]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [pendingText, setPendingText] = useState<{ at: Point; value: string } | null>(null);
  const [history, setHistory] = useState<("stroke" | "text")[]>([]);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ mode: "crop" | "stroke"; origin: Point } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    createImageBitmap(file)
      .then((bm) => {
        if (cancelled) {
          bm.close();
          return;
        }
        setBitmap(bm);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => () => bitmap?.close(), [bitmap]);

  const size = bitmap ? rotatedSize(bitmap.width, bitmap.height, rotation) : null;
  const imageAspect = size ? size.width / size.height : 1;

  // Changing the rotation changes what every aspect means, so a locked crop
  // has to be recomputed rather than carried over sideways.
  useEffect(() => {
    if (aspect === null) return;
    setCrop(cropForAspect(aspect, imageAspect));
  }, [aspect, imageAspect]);

  const redraw = useCallback(() => {
    const canvas = overlayRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const rect = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const stroke of strokes) {
      ctx.strokeStyle = stroke.colour;
      ctx.lineWidth = Math.max(2, canvas.width * 0.008);
      ctx.beginPath();
      stroke.points.forEach((p, i) => {
        const x = p.x * canvas.width;
        const y = p.y * canvas.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const fontPx = Math.max(14, canvas.width * 0.055);
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (const item of texts) {
      ctx.fillStyle = item.colour;
      ctx.fillText(item.text, item.at.x * canvas.width, item.at.y * canvas.height);
    }
  }, [strokes, texts]);

  useEffect(() => {
    redraw();
  }, [redraw, bitmap, rotation]);

  useEffect(() => {
    const onResize = () => redraw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [redraw]);

  function stageBox() {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, width: 1, height: 1 };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!bitmap) return;
    const at = pointIn(stageBox(), e.clientX, e.clientY);
    if (tool === "text") {
      setPendingText({ at, value: "" });
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "draw") {
      dragRef.current = { mode: "stroke", origin: at };
      setStrokes((prev) => [...prev, { colour, points: [at] }]);
      setHistory((prev) => [...prev, "stroke"]);
      return;
    }
    dragRef.current = { mode: "crop", origin: at };
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const at = pointIn(stageBox(), e.clientX, e.clientY);
    if (drag.mode === "stroke") {
      setStrokes((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        return [...prev.slice(0, -1), { ...last, points: [...last.points, at] }];
      });
      return;
    }
    let next: Rect = {
      x: Math.min(drag.origin.x, at.x),
      y: Math.min(drag.origin.y, at.y),
      w: Math.abs(at.x - drag.origin.x),
      h: Math.abs(at.y - drag.origin.y),
    };
    if (aspect !== null) {
      // Keep the locked ratio while following whichever axis the pointer has
      // moved furthest along, so the drag never feels stuck.
      const ratio = aspect / imageAspect;
      if (next.w / Math.max(next.h, 1e-6) > ratio) next.h = next.w / ratio;
      else next.w = next.h * ratio;
      next = { ...next, x: Math.min(drag.origin.x, at.x), y: Math.min(drag.origin.y, at.y) };
    }
    setCrop(clampCrop(next));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function commitText() {
    if (!pendingText) return;
    const text = pendingText.value.trim();
    if (text) {
      setTexts((prev) => [...prev, { at: pendingText.at, text, colour }]);
      setHistory((prev) => [...prev, "text"]);
    }
    setPendingText(null);
  }

  /** Undo has to remove the most recent annotation of *either* kind, so the
   * order they were added in is tracked separately from the two lists. */
  function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((prev) => prev.slice(0, -1));
    if (last === "stroke") setStrokes((prev) => prev.slice(0, -1));
    else setTexts((prev) => prev.slice(0, -1));
  }

  async function exportImage() {
    if (!bitmap) return;
    setBusy(true);
    try {
      const turns = normaliseRotation(rotation);
      const rotated = rotatedSize(bitmap.width, bitmap.height, turns);

      // Rotate first into a full-size buffer, then crop out of it: doing both
      // in one transform means reasoning about the crop in pre-rotation
      // coordinates, which is where off-by-a-quarter-turn bugs live.
      const stage = document.createElement("canvas");
      stage.width = rotated.width;
      stage.height = rotated.height;
      const sctx = stage.getContext("2d");
      if (!sctx) return;
      sctx.translate(rotated.width / 2, rotated.height / 2);
      sctx.rotate((turns * Math.PI) / 180);
      sctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

      const box = cropPixels(crop, bitmap.width, bitmap.height, turns);
      const out = document.createElement("canvas");
      out.width = box.w;
      out.height = box.h;
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(stage, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const stroke of strokes) {
        ctx.strokeStyle = stroke.colour;
        ctx.lineWidth = Math.max(2, out.width * 0.008);
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          const mapped = intoCrop(p, crop);
          const x = mapped.x * out.width;
          const y = mapped.y * out.height;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      const fontPx = Math.max(14, out.width * 0.055);
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      for (const item of texts) {
        const mapped = intoCrop(item.at, crop);
        ctx.fillStyle = item.colour;
        ctx.fillText(item.text, mapped.x * out.width, mapped.y * out.height);
      }

      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, "image/jpeg", 0.85)
      );
      if (blob) onDone(blob, caption.trim());
    } finally {
      setBusy(false);
    }
  }

  const cropStyle: React.CSSProperties = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  };

  return (
    <div className={styles.editorBackdrop} role="dialog" aria-label="Edit photo">
      <div className={styles.editorBar}>
        <button type="button" onClick={onCancel} aria-label="Cancel">
          <Icon name="back" size={20} />
        </button>
        <div className={styles.editorTools}>
          {(["crop", "draw", "text"] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-active={tool === t}
              onClick={() => setTool(t)}
              aria-pressed={tool === t}
            >
              {t === "crop" ? "Crop" : t === "draw" ? "Draw" : "Text"}
            </button>
          ))}
          <button type="button" onClick={() => setRotation((r) => normaliseRotation(r + 90))}>
            Rotate
          </button>
          <button type="button" onClick={undo} disabled={history.length === 0}>
            Undo
          </button>
        </div>
      </div>

      <div className={styles.editorStageWrap}>
        <div
          ref={stageRef}
          className={styles.editorStage}
          style={{ aspectRatio: size ? `${size.width} / ${size.height}` : undefined }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={url}
              alt=""
              className={styles.editorImage}
              style={{ transform: `rotate(${normaliseRotation(rotation)}deg)` }}
            />
          )}
          <canvas ref={overlayRef} className={styles.editorOverlay} />
          {tool === "crop" && <div className={styles.editorCrop} style={cropStyle} />}
        </div>
      </div>

      {tool === "crop" && (
        <div className={styles.editorRow}>
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              type="button"
              data-active={aspect === a.value}
              onClick={() => {
                setAspect(a.value);
                if (a.value === null) setCrop({ ...FULL_CROP });
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {tool !== "crop" && (
        <div className={styles.editorRow}>
          {PEN_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              className={styles.editorSwatch}
              style={{ background: c }}
              data-active={colour === c}
              aria-label={`Colour ${c}`}
              onClick={() => setColour(c)}
            />
          ))}
        </div>
      )}

      {pendingText && (
        <div className={styles.editorRow}>
          <input
            autoFocus
            value={pendingText.value}
            placeholder="Type something"
            onChange={(e) => setPendingText({ ...pendingText, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") setPendingText(null);
            }}
            onBlur={commitText}
          />
        </div>
      )}

      <div className={styles.editorSend}>
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Add a caption"
          aria-label="Caption"
        />
        <button type="button" onClick={exportImage} disabled={!bitmap || busy} aria-label="Send">
          <Icon name="send" size={20} />
        </button>
      </div>
    </div>
  );
}
