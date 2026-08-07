import sharp, { type Sharp } from "sharp";
import type { CardFormData, LayoutMap, BoundingBox } from "./types";

const FIELD_KEYS: (keyof CardFormData)[] = ["name", "dob", "iss", "exp", "address"];

async function resolveImageBuffer(image: string): Promise<Buffer> {
  if (image.startsWith("data:image")) {
    const base64 = image.split(",")[1];
    if (!base64) throw new Error("Invalid image data URI.");
    return Buffer.from(base64, "base64");
  }

  if (image.startsWith("http://") || image.startsWith("https://")) {
    const response = await fetch(image);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Image must be a data URI or HTTP URL.");
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clampBox(box: BoundingBox, imageWidth: number, imageHeight: number): BoundingBox {
  const x = Math.max(0, Math.min(Math.round(box.x), imageWidth - 1));
  const y = Math.max(0, Math.min(Math.round(box.y), imageHeight - 1));
  const width = Math.max(1, Math.min(Math.round(box.width), imageWidth - x));
  const height = Math.max(1, Math.min(Math.round(box.height), imageHeight - y));
  return { x, y, width, height };
}

function scaleLayout(
  layout: LayoutMap,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): LayoutMap {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return layout;
  }

  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const scaled: LayoutMap = {};

  for (const key of FIELD_KEYS) {
    const box = layout[key];
    if (!box) continue;
    scaled[key] = {
      x: Math.round(box.x * scaleX),
      y: Math.round(box.y * scaleY),
      width: Math.round(box.width * scaleX),
      height: Math.round(box.height * scaleY),
    };
  }

  return scaled;
}

async function sampleBackgroundColor(
  image: Sharp,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number
): Promise<{ r: number; g: number; b: number }> {
  const samples: { r: number; g: number; b: number }[] = [];
  const pad = 2;

  const samplePoints = [
    { x: Math.max(0, box.x - pad), y: box.y + Math.floor(box.height / 2) },
    { x: Math.min(imageWidth - 1, box.x + box.width + pad), y: box.y + Math.floor(box.height / 2) },
    { x: box.x + Math.floor(box.width / 2), y: Math.max(0, box.y - pad) },
    { x: box.x + Math.floor(box.width / 2), y: Math.min(imageHeight - 1, box.y + box.height + pad) },
    { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad) },
    { x: Math.min(imageWidth - 1, box.x + box.width + pad), y: Math.max(0, box.y - pad) },
  ];

  for (const point of samplePoints) {
    try {
      const { data } = await image
        .clone()
        .extract({ left: point.x, top: point.y, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      samples.push({ r: data[0], g: data[1], b: data[2] });
    } catch {
      // Ignore failed sample points near edges.
    }
  }

  if (samples.length === 0) {
    return { r: 240, g: 240, b: 240 };
  }

  const avg = samples.reduce(
    (acc, sample) => ({
      r: acc.r + sample.r,
      g: acc.g + sample.g,
      b: acc.b + sample.b,
    }),
    { r: 0, g: 0, b: 0 }
  );

  return {
    r: Math.round(avg.r / samples.length),
    g: Math.round(avg.g / samples.length),
    b: Math.round(avg.b / samples.length),
  };
}

function createTextSvg(
  text: string,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  textColor: string
): string {
  const fontSize = Math.max(10, Math.min(Math.round(box.height * 0.72), Math.round(box.width / Math.max(text.length * 0.55, 1))));
  const x = box.x + Math.max(2, Math.round(box.width * 0.03));
  const y = box.y + Math.round(box.height * 0.72);

  return `
    <svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">
      <text
        x="${x}"
        y="${y}"
        font-family="Arial, Helvetica, DejaVu Sans, sans-serif"
        font-size="${fontSize}px"
        font-weight="600"
        fill="${textColor}"
        text-anchor="start"
      >${escapeXml(text)}</text>
    </svg>
  `;
}

function contrastTextColor(bg: { r: number; g: number; b: number }): string {
  const luminance = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
  return luminance > 0.55 ? "#111111" : "#FFFFFF";
}

/**
 * Deterministic correction for selected fields:
 * erase marked regions with sampled background, then draw exact typed text.
 */
export async function applyHybridEdit(
  imageInput: string,
  fields: CardFormData,
  layout: LayoutMap,
  sourceWidth: number,
  sourceHeight: number,
  keysToFix: (keyof CardFormData)[] = FIELD_KEYS
): Promise<string> {
  const originalBuffer = await resolveImageBuffer(imageInput);
  const base = sharp(originalBuffer).ensureAlpha();
  const metadata = await base.metadata();
  const imageWidth = metadata.width ?? sourceWidth;
  const imageHeight = metadata.height ?? sourceHeight;

  const scaledLayout = scaleLayout(layout, sourceWidth, sourceHeight, imageWidth, imageHeight);

  const fillLayers: { input: Buffer; left: number; top: number }[] = [];
  const textSvgs: Buffer[] = [];

  for (const key of keysToFix) {
    const rawBox = scaledLayout[key];
    const value = fields[key];
    if (!rawBox || !value) continue;

    const box = clampBox(rawBox, imageWidth, imageHeight);
    const bg = await sampleBackgroundColor(base, box, imageWidth, imageHeight);

    const fill = await sharp({
      create: {
        width: box.width,
        height: box.height,
        channels: 3,
        background: bg,
      },
    })
      .png()
      .toBuffer();

    fillLayers.push({ input: fill, left: box.x, top: box.y });

    const textColor = contrastTextColor(bg);
    textSvgs.push(Buffer.from(createTextSvg(value, box, imageWidth, imageHeight, textColor)));
  }

  if (fillLayers.length === 0) {
    // Nothing to correct — return original as data URI.
    const png = await base.png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  const erased = await base.composite(fillLayers).png().toBuffer();

  const resultBuffer = await sharp(erased)
    .composite(textSvgs.map((input) => ({ input, blend: "over" as const })))
    .png()
    .toBuffer();

  return `data:image/png;base64,${resultBuffer.toString("base64")}`;
}
