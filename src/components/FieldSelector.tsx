"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoundingBox, CardFormData, LayoutMap } from "@/lib/types";

const FIELD_KEYS: (keyof CardFormData)[] = ["name", "dob", "iss", "exp", "address"];

const FIELD_COLORS: Record<keyof CardFormData, string> = {
  name: "#4f46e5",
  dob: "#059669",
  iss: "#d97706",
  exp: "#dc2626",
  address: "#7c3aed",
};

const FIELD_LABELS: Record<keyof CardFormData, string> = {
  name: "NAME",
  dob: "DOB",
  iss: "ISS",
  exp: "EXP",
  address: "ADDRESS",
};

type Props = {
  image: string;
  layout: LayoutMap;
  onChange: (layout: LayoutMap, naturalSize: { width: number; height: number }) => void;
};

export default function FieldSelector({ image, layout, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [activeField, setActiveField] = useState<keyof CardFormData>("name");
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !displaySize.width || !displaySize.height) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = displaySize.width;
    canvas.height = displaySize.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const scaleX = displaySize.width / naturalSize.width;
    const scaleY = displaySize.height / naturalSize.height;

    for (const key of FIELD_KEYS) {
      const box = layout[key];
      if (!box) continue;
      ctx.strokeStyle = FIELD_COLORS[key];
      ctx.fillStyle = `${FIELD_COLORS[key]}33`;
      ctx.lineWidth = 2;
      const x = box.x * scaleX;
      const y = box.y * scaleY;
      const w = box.width * scaleX;
      const h = box.height * scaleY;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = FIELD_COLORS[key];
      ctx.font = "bold 12px Arial";
      ctx.fillText(FIELD_LABELS[key], x + 4, y + 14);
    }

    if (draft) {
      const x = Math.min(draft.startX, draft.endX);
      const y = Math.min(draft.startY, draft.endY);
      const w = Math.abs(draft.endX - draft.startX);
      const h = Math.abs(draft.endY - draft.startY);
      ctx.strokeStyle = FIELD_COLORS[activeField];
      ctx.fillStyle = `${FIELD_COLORS[activeField]}44`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }, [activeField, displaySize, draft, layout, naturalSize]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      const maxWidth = containerRef.current?.clientWidth || 640;
      const ratio = img.naturalWidth / img.naturalHeight;
      const width = Math.min(maxWidth, img.naturalWidth);
      const height = Math.round(width / ratio);
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      setDisplaySize({ width, height });
      onChange(layout, { width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = image;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const getCanvasPoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const toNaturalBox = (displayBox: BoundingBox): BoundingBox => {
    const scaleX = naturalSize.width / displaySize.width;
    const scaleY = naturalSize.height / displaySize.height;
    return {
      x: Math.round(displayBox.x * scaleX),
      y: Math.round(displayBox.y * scaleY),
      width: Math.round(displayBox.width * scaleX),
      height: Math.round(displayBox.height * scaleY),
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const point = getCanvasPoint(e);
    setDrawing(true);
    setDraft({ startX: point.x, startY: point.y, endX: point.x, endY: point.y });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing || !draft) return;
    const point = getCanvasPoint(e);
    setDraft({ ...draft, endX: point.x, endY: point.y });
  };

  const onMouseUp = () => {
    if (!drawing || !draft || !naturalSize.width) return;
    setDrawing(false);

    const x = Math.min(draft.startX, draft.endX);
    const y = Math.min(draft.startY, draft.endY);
    const width = Math.abs(draft.endX - draft.startX);
    const height = Math.abs(draft.endY - draft.startY);
    setDraft(null);

    if (width < 8 || height < 8) return;

    const naturalBox = toNaturalBox({ x, y, width, height });
    const next = { ...layout, [activeField]: naturalBox };
    onChange(next, naturalSize);

    const nextUnset = FIELD_KEYS.find((key) => key !== activeField && !next[key]);
    if (nextUnset) setActiveField(nextUnset);
  };

  const markedCount = FIELD_KEYS.filter((key) => layout[key]).length;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Mark Fields on Image</h2>
        <p className="mt-1 text-sm text-slate-600">
          Select a field, then drag tightly around ONLY the value text (not labels like ISS/EXP).
          Marked: {markedCount}/5
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FIELD_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveField(key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              activeField === key
                ? "text-white"
                : layout[key]
                  ? "bg-slate-100 text-slate-800"
                  : "bg-slate-50 text-slate-500"
            }`}
            style={activeField === key ? { backgroundColor: FIELD_COLORS[key] } : undefined}
          >
            {FIELD_LABELS[key]}
            {layout[key] ? " ✓" : ""}
          </button>
        ))}
      </div>

      <div ref={containerRef} className="overflow-auto rounded-xl border border-slate-200 bg-slate-50">
        <canvas
          ref={canvasRef}
          className="mx-auto block max-w-full cursor-crosshair"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
      </div>
    </div>
  );
}
