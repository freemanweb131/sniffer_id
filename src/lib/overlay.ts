import sharp from "sharp";
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

/**
 * Sample ink color from darkest pixels inside the marked box (original text color).
 */
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

  if (pixels.length === 0) return "#1a1a1a";

  pixels.sort((a, b) => a.lum - b.lum);
  const inkCount = Math.max(5, Math.floor(pixels.length * 0.12));
  const ink = pixels.slice(0, inkCount);
  const avg = ink.reduce(
    (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
    { r: 0, g: 0, b: 0 }
  );

  return rgbToHex(avg.r / ink.length, avg.g / ink.length, avg.b / ink.length);
}

/**
 * Texture-preserving erase: vertically blend pixels from the rows just above/below
 * the marked box so guilloche/security patterns stay intact.
 */
function eraseBoxWithTextureClone(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  box: BoundingBox
): void {
  const topY = Math.max(0, box.y - 1);
  const bottomY = Math.min(height - 1, box.y + box.height);
  const leftX = Math.max(0, box.x - 1);
  const rightX = Math.min(width - 1, box.x + box.width);

  for (let y = box.y; y < box.y + box.height; y++) {
    const ty = (y - box.y) / Math.max(box.height - 1, 1);

    for (let x = box.x; x < box.x + box.width; x++) {
      const tx = (x - box.x) / Math.max(box.width - 1, 1);
      const idx = (y * width + x) * channels;

      const topIdx = (topY * width + x) * channels;
      const bottomIdx = (bottomY * width + x) * channels;
      const leftIdx = (y * width + leftX) * channels;
      const rightIdx = (y * width + rightX) * channels;

      for (let c = 0; c < 3; c++) {
        const vertical = data[topIdx + c] * (1 - ty) + data[bottomIdx + c] * ty;
        const horizontal = data[leftIdx + c] * (1 - tx) + data[rightIdx + c] * tx;
        // Prefer vertical clone for ID text lines; mix a little horizontal for edges.
        data[idx + c] = Math.round(vertical * 0.85 + horizontal * 0.15);
      }
    }
  }
}

function createStyledTextSvg(
  text: string,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  style: FieldStyle
): string {
  const maxByHeight = Math.round(box.height * 0.78);
  const maxByWidth = Math.round(box.width / Math.max(text.length * 0.55, 1));
  const fontSize = Math.max(10, Math.min(style.fontSize || maxByHeight, maxByHeight, maxByWidth));
  const x = box.x + Math.max(2, Math.round(box.width * 0.02));
  const y = box.y + Math.round(box.height * 0.5 + fontSize * 0.35);

  return `
    <svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">
      <text
        x="${x}"
        y="${y}"
        font-family="${escapeXml(style.fontFamily)}, Arial, Helvetica, sans-serif"
        font-size="${fontSize}px"
        font-weight="${style.fontWeight}"
        letter-spacing="${style.letterSpacing}px"
        fill="${escapeXml(style.color)}"
        fill-opacity="${Math.min(1, Math.max(0.88, style.opacity))}"
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
    const ai = aiStyles[key];

    styles[key] = {
      color: ink,
      fontSize: ai?.fontSize && ai.fontSize > 0 ? ai.fontSize : Math.max(10, Math.round(box.height * 0.72)),
      fontWeight: ai?.fontWeight && ai.fontWeight > 0 ? ai.fontWeight : 600,
      fontFamily: ai?.fontFamily || "Arial, Helvetica, sans-serif",
      letterSpacing: ai?.letterSpacing ?? 0,
      opacity: ai?.opacity ?? 0.96,
    };
  }

  return styles;
}

/**
 * Step 2 (local): erase marked text while preserving nearby texture/pattern.
 */
export async function eraseFieldsLocally(
  imageInput: string,
  layout: LayoutMap,
  sourceWidth: number,
  sourceHeight: number
): Promise<string> {
  const originalBuffer = await resolveImageBuffer(imageInput);
  const { data, info } = await sharp(originalBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width ?? sourceWidth;
  const height = info.height ?? sourceHeight;
  const channels = info.channels ?? 4;
  const scaled = scaleLayout(layout, sourceWidth, sourceHeight, width, height);
  const pixels = Buffer.from(data);

  for (const key of FIELD_KEYS) {
    const rawBox = scaled[key];
    if (!rawBox) continue;
    const box = clampBox(rawBox, width, height);
    eraseBoxWithTextureClone(pixels, width, height, channels, box);
  }

  const erased = await sharp(pixels, {
    raw: { width, height, channels: channels as 3 | 4 },
  })
    .png()
    .toBuffer();

  return `data:image/png;base64,${erased.toString("base64")}`;
}

/**
 * Steps 3 + 4: draw exact typed text with sampled styles, then lightly blend.
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
    const value = fields[key];
    const style = styles[key];
    if (!rawBox || !value || !style) continue;

    const box = clampBox(rawBox, imageWidth, imageHeight);
    const svg = createStyledTextSvg(value, box, imageWidth, imageHeight, style);
    // Keep text crisp — no blur that can make letters disappear.
    textLayers.push(Buffer.from(svg));
  }

  if (textLayers.length === 0) {
    throw new Error("No styled text layers could be rendered. Remark field boxes and try again.");
  }

  let composed = await base
    .composite(textLayers.map((input) => ({ input, blend: "over" as const })))
    .png()
    .toBuffer();

  // Very subtle print-like grain (does not erase text).
  const noise = await sharp({
    create: {
      width: imageWidth,
      height: imageHeight,
      channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 0.02 },
    },
  })
    .png()
    .toBuffer();

  composed = await sharp(composed)
    .composite([{ input: noise, blend: "overlay" }])
    .png()
    .toBuffer();

  return `data:image/png;base64,${composed.toString("base64")}`;
}
