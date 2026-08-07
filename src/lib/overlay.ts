import fs from "fs";
import path from "path";
import sharp from "sharp";
import { parse as parseFont, type Font } from "opentype.js";
import type { BoundingBox, CardFormData, LayoutMap } from "./types";

const FIELD_KEYS: (keyof CardFormData)[] = ["name", "dob", "iss", "exp", "address"];

let cachedFont: Font | null = null;

function getFont(): Font {
  if (cachedFont) return cachedFont;

  const boldPath = path.join(process.cwd(), "assets", "fonts", "Arial-Bold.ttf");
  const regularPath = path.join(process.cwd(), "assets", "fonts", "Arial.ttf");
  const fontFile = fs.existsSync(boldPath) ? boldPath : regularPath;

  if (!fs.existsSync(fontFile)) {
    throw new Error("Bundled font missing. Expected assets/fonts/Arial-Bold.ttf");
  }

  const buffer = fs.readFileSync(fontFile);
  cachedFont = parseFont(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  return cachedFont;
}

async function resolveImageBuffer(image: string): Promise<Buffer> {
  if (image.startsWith("data:image")) {
    const base64 = image.split(",")[1];
    if (!base64) throw new Error("Invalid image data URI.");
    return Buffer.from(base64, "base64");
  }

  if (image.startsWith("http://") || image.startsWith("https://")) {
    const response = await fetch(image);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Image must be a data URI or HTTP URL.");
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
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) return layout;

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

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Paper color = median of the lighter pixels in the box (ignores dark ink).
 * Ink color = median of the darker pixels (or forced dark for contrast).
 */
function samplePaperAndInk(
  data: Buffer,
  width: number,
  channels: number,
  box: BoundingBox
): { paper: { r: number; g: number; b: number }; ink: string } {
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

  if (pixels.length === 0) {
    return { paper: { r: 230, g: 235, b: 220 }, ink: "#111111" };
  }

  pixels.sort((a, b) => a.lum - b.lum);

  const darkCount = Math.max(1, Math.floor(pixels.length * 0.15));
  const lightStart = Math.floor(pixels.length * 0.45);
  const lightPixels = pixels.slice(lightStart);
  const darkPixels = pixels.slice(0, darkCount);

  const avg = (list: typeof pixels) => {
    const sum = list.reduce(
      (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
      { r: 0, g: 0, b: 0 }
    );
    return {
      r: Math.round(sum.r / list.length),
      g: Math.round(sum.g / list.length),
      b: Math.round(sum.b / list.length),
    };
  };

  const paper = avg(lightPixels.length ? lightPixels : pixels);
  let inkRgb = avg(darkPixels);
  if (Math.abs(luminance(paper.r, paper.g, paper.b) - luminance(inkRgb.r, inkRgb.g, inkRgb.b)) < 45) {
    inkRgb = luminance(paper.r, paper.g, paper.b) > 140
      ? { r: 17, g: 17, b: 17 }
      : { r: 245, g: 245, b: 245 };
  }

  return { paper, ink: rgbToHex(inkRgb.r, inkRgb.g, inkRgb.b) };
}

function fitFontSize(font: Font, text: string, maxWidth: number, maxHeight: number): number {
  let size = Math.max(10, Math.floor(maxHeight * 0.78));
  while (size > 9) {
    const width = font.getAdvanceWidth(text, size);
    if (width <= maxWidth * 0.96) return size;
    size -= 1;
  }
  return 9;
}

function textPathSvg(
  font: Font,
  text: string,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  ink: string
): string {
  const padX = Math.max(2, Math.round(box.width * 0.02));
  const fontSize = fitFontSize(font, text, box.width - padX * 2, box.height);
  const textWidth = font.getAdvanceWidth(text, fontSize);
  const x = box.x + padX;
  // Baseline roughly centered in the box.
  const y = box.y + Math.round(box.height * 0.5 + fontSize * 0.35);

  // If somehow still too wide, keep left-aligned; opentype path won't stretch oddly.
  void textWidth;

  const glyphPath = font.getPath(text, x, y, fontSize);
  const d = glyphPath.toPathData(2);

  return `<svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="${ink}"/></svg>`;
}

/**
 * Step A: Clean marked fields only (solid paper fill). Returns a blanked card ready for AI rewrite.
 */
export async function cleanMarkedFields(
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

  const fillLayers: { input: Buffer; left: number; top: number }[] = [];

  for (const key of FIELD_KEYS) {
    const rawBox = scaled[key];
    if (!rawBox) continue;

    const box = clampBox(rawBox, width, height);
    const { paper } = samplePaperAndInk(data, width, channels, box);

    const fill = await sharp({
      create: {
        width: box.width,
        height: box.height,
        channels: 3,
        background: paper,
      },
    })
      .png()
      .toBuffer();

    fillLayers.push({ input: fill, left: box.x, top: box.y });
  }

  if (fillLayers.length === 0) {
    throw new Error("No valid marked fields to clean.");
  }

  const cleaned = await sharp(originalBuffer).ensureAlpha().composite(fillLayers).png().toBuffer();
  return `data:image/png;base64,${cleaned.toString("base64")}`;
}

/**
 * Deterministic fallback:
 * clean + draw exact typed text as vector glyph paths.
 */
export async function applyDirectEdit(
  imageInput: string,
  fields: CardFormData,
  layout: LayoutMap,
  sourceWidth: number,
  sourceHeight: number
): Promise<string> {
  const font = getFont();
  const originalBuffer = await resolveImageBuffer(imageInput);

  const { data, info } = await sharp(originalBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width ?? sourceWidth;
  const height = info.height ?? sourceHeight;
  const channels = info.channels ?? 4;
  const scaled = scaleLayout(layout, sourceWidth, sourceHeight, width, height);

  const fillLayers: { input: Buffer; left: number; top: number }[] = [];
  const textSvgs: string[] = [];

  for (const key of FIELD_KEYS) {
    const rawBox = scaled[key];
    const value = fields[key]?.trim();
    if (!rawBox || !value) continue;

    const box = clampBox(rawBox, width, height);
    const { paper, ink } = samplePaperAndInk(data, width, channels, box);

    const fill = await sharp({
      create: {
        width: box.width,
        height: box.height,
        channels: 3,
        background: paper,
      },
    })
      .png()
      .toBuffer();

    fillLayers.push({ input: fill, left: box.x, top: box.y });
    textSvgs.push(textPathSvg(font, value, box, width, height, ink));
  }

  if (fillLayers.length === 0 || textSvgs.length === 0) {
    throw new Error("No valid marked fields to edit.");
  }

  const erased = await sharp(originalBuffer).ensureAlpha().composite(fillLayers).png().toBuffer();

  const result = await sharp(erased)
    .composite(textSvgs.map((svg) => ({ input: Buffer.from(svg), blend: "over" as const })))
    .png()
    .toBuffer();

  return `data:image/png;base64,${result.toString("base64")}`;
}
