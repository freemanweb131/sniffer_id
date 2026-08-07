import sharp, { type Sharp } from "sharp";
import type { BoundingBox, CardFormData, FieldStyle, LayoutMap, StyleMap } from "./types";

const FIELD_KEYS: (keyof CardFormData)[] = ["name", "dob", "iss", "exp", "address"];

export async function resolveImageBuffer(image: string): Promise<Buffer> {
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

export function scaleLayout(
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

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function sampleInkColor(
  data: Buffer,
  width: number,
  channels: number,
  box: BoundingBox
): string {
  const pixels: { r: number; g: number; b: number; lum: number }[] = [];

  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      pixels.push({ r, g, b, lum: luminance(r, g, b) });
    }
  }

  if (pixels.length === 0) return "#111111";

  pixels.sort((a, b) => a.lum - b.lum);
  const inkCount = Math.max(8, Math.floor(pixels.length * 0.1));
  const ink = pixels.slice(0, inkCount);
  const avg = ink.reduce(
    (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
    { r: 0, g: 0, b: 0 }
  );

  const r = avg.r / ink.length;
  const g = avg.g / ink.length;
  const b = avg.b / ink.length;

  // If "ink" is still bright (bad sample), force dark text for readability.
  if (luminance(r, g, b) > 140) {
    return "#111111";
  }

  return rgbToHex(r, g, b);
}

function sampleBorderAverage(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  box: BoundingBox
): { r: number; g: number; b: number } {
  const samples: number[][] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = (y * width + x) * channels;
    samples.push([data[idx], data[idx + 1], data[idx + 2]]);
  };

  for (let x = box.x; x < box.x + box.width; x++) {
    push(x, Math.max(0, box.y - 1));
    push(x, Math.min(height - 1, box.y + box.height));
  }
  for (let y = box.y; y < box.y + box.height; y++) {
    push(Math.max(0, box.x - 1), y);
    push(Math.min(width - 1, box.x + box.width), y);
  }

  if (samples.length === 0) return { r: 220, g: 220, b: 210 };

  const sum = samples.reduce(
    (acc, s) => [acc[0] + s[0], acc[1] + s[1], acc[2] + s[2]],
    [0, 0, 0]
  );
  return {
    r: Math.round(sum[0] / samples.length),
    g: Math.round(sum[1] / samples.length),
    b: Math.round(sum[2] / samples.length),
  };
}

/**
 * Erase by stretching a clean horizontal strip from just above (or below) the box.
 * Avoids the vertical smear artifacts from blending top+bottom rows.
 */
async function buildStripFill(
  image: Sharp,
  box: BoundingBox,
  _imageWidth: number,
  imageHeight: number
): Promise<Buffer> {
  const stripHeight = Math.max(2, Math.min(4, Math.floor(box.height / 3)));
  const aboveTop = Math.max(0, box.y - stripHeight);
  const belowTop = Math.min(imageHeight - stripHeight, box.y + box.height);

  // Prefer the strip above the text line when available.
  const useAbove = box.y >= stripHeight;
  const stripTop = useAbove ? aboveTop : belowTop;

  try {
    const strip = await image
      .clone()
      .extract({
        left: box.x,
        top: stripTop,
        width: box.width,
        height: stripHeight,
      })
      .resize(box.width, box.height, { kernel: "nearest", fit: "fill" })
      .png()
      .toBuffer();
    return strip;
  } catch {
    const bg = { r: 220, g: 220, b: 210 };
    return sharp({
      create: {
        width: box.width,
        height: box.height,
        channels: 3,
        background: bg,
      },
    })
      .png()
      .toBuffer();
  }
}

function createStyledTextSvg(
  text: string,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  style: FieldStyle
): string {
  const maxByHeight = Math.round(box.height * 0.82);
  const maxByWidth = Math.round(box.width / Math.max(text.length * 0.58, 1));
  const fontSize = Math.max(11, Math.min(style.fontSize || maxByHeight, maxByHeight, maxByWidth));
  const x = box.x + Math.max(2, Math.round(box.width * 0.02));
  const y = box.y + Math.round(box.height * 0.5 + fontSize * 0.35);

  return `
    <svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">
      <text
        x="${x}"
        y="${y}"
        font-family="Arial, Helvetica, DejaVu Sans, sans-serif"
        font-size="${fontSize}px"
        font-weight="${style.fontWeight || 700}"
        letter-spacing="${style.letterSpacing || 0}px"
        fill="${escapeXml(style.color)}"
        fill-opacity="1"
        text-anchor="start"
      >${escapeXml(text)}</text>
    </svg>
  `;
}

export async function sampleLocalStyles(
  imageInput: string,
  layout: LayoutMap,
  sourceWidth: number,
  sourceHeight: number,
  aiStyles: StyleMap = {}
): Promise<StyleMap> {
  const buffer = await resolveImageBuffer(imageInput);
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width ?? sourceWidth;
  const height = info.height ?? sourceHeight;
  const channels = info.channels ?? 4;
  const scaled = scaleLayout(layout, sourceWidth, sourceHeight, width, height);
  const styles: StyleMap = {};

  for (const key of FIELD_KEYS) {
    const rawBox = scaled[key];
    if (!rawBox) continue;
    const box = clampBox(rawBox, width, height);
    const ink = sampleInkColor(data, width, channels, box);
    const border = sampleBorderAverage(data, width, height, channels, box);
    const ai = aiStyles[key];

    // Ensure readable contrast against local background.
    let color = ink;
    if (Math.abs(luminance(border.r, border.g, border.b) - luminance(
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16)
    )) < 40) {
      color = luminance(border.r, border.g, border.b) > 140 ? "#111111" : "#F5F5F5";
    }

    styles[key] = {
      color,
      fontSize: Math.max(11, Math.round(box.height * 0.75)),
      fontWeight: ai?.fontWeight && ai.fontWeight >= 500 ? ai.fontWeight : 700,
      fontFamily: "Arial, Helvetica, sans-serif",
      letterSpacing: 0,
      opacity: 1,
    };
  }

  return styles;
}

/**
 * Step 2: erase marked text using strip-fill (no vertical smear).
 */
export async function eraseFieldsLocally(
  imageInput: string,
  layout: LayoutMap,
  sourceWidth: number,
  sourceHeight: number
): Promise<string> {
  const originalBuffer = await resolveImageBuffer(imageInput);
  const base = sharp(originalBuffer).ensureAlpha();
  const metadata = await base.metadata();
  const imageWidth = metadata.width ?? sourceWidth;
  const imageHeight = metadata.height ?? sourceHeight;
  const scaled = scaleLayout(layout, sourceWidth, sourceHeight, imageWidth, imageHeight);

  const layers: { input: Buffer; left: number; top: number }[] = [];

  for (const key of FIELD_KEYS) {
    const rawBox = scaled[key];
    if (!rawBox) continue;
    const box = clampBox(rawBox, imageWidth, imageHeight);
    const fill = await buildStripFill(base, box, imageWidth, imageHeight);
    layers.push({ input: fill, left: box.x, top: box.y });
  }

  const erased = await base.composite(layers).png().toBuffer();
  return `data:image/png;base64,${erased.toString("base64")}`;
}

/**
 * Steps 3 + 4: draw exact typed text crisply (no blur that hides letters).
 */
export async function renderStyledText(
  imageInput: string,
  fields: CardFormData,
  layout: LayoutMap,
  styles: StyleMap,
  sourceWidth: number,
  sourceHeight: number
): Promise<string> {
  const originalBuffer = await resolveImageBuffer(imageInput);
  const base = sharp(originalBuffer).ensureAlpha();
  const metadata = await base.metadata();
  const imageWidth = metadata.width ?? sourceWidth;
  const imageHeight = metadata.height ?? sourceHeight;
  const scaledLayout = scaleLayout(layout, sourceWidth, sourceHeight, imageWidth, imageHeight);

  const textLayers: Buffer[] = [];

  for (const key of FIELD_KEYS) {
    const rawBox = scaledLayout[key];
    const value = fields[key]?.trim();
    const style = styles[key];
    if (!rawBox || !value || !style) continue;

    const box = clampBox(rawBox, imageWidth, imageHeight);
    const svg = createStyledTextSvg(value, box, imageWidth, imageHeight, style);
    textLayers.push(Buffer.from(svg));
  }

  if (textLayers.length === 0) {
    throw new Error("No styled text layers could be rendered. Remark field boxes and try again.");
  }

  const composed = await base
    .composite(textLayers.map((input) => ({ input, blend: "over" as const })))
    .png()
    .toBuffer();

  return `data:image/png;base64,${composed.toString("base64")}`;
}
