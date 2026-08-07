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
      // Ignore edge sample failures.
    }
  }

  if (samples.length === 0) return { r: 240, g: 240, b: 240 };

  const avg = samples.reduce(
    (acc, sample) => ({ r: acc.r + sample.r, g: acc.g + sample.g, b: acc.b + sample.b }),
    { r: 0, g: 0, b: 0 }
  );

  return {
    r: Math.round(avg.r / samples.length),
    g: Math.round(avg.g / samples.length),
    b: Math.round(avg.b / samples.length),
  };
}

function createStyledTextSvg(
  text: string,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  style: FieldStyle
): string {
  const maxByHeight = Math.round(box.height * 0.78);
  const maxByWidth = Math.round(box.width / Math.max(text.length * 0.52, 1));
  const fontSize = Math.max(9, Math.min(style.fontSize, maxByHeight, maxByWidth));
  const x = box.x + Math.max(2, Math.round(box.width * 0.02));
  const y = box.y + Math.round((box.height + fontSize * 0.72) / 2);

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
        fill-opacity="${style.opacity}"
        text-anchor="start"
      >${escapeXml(text)}</text>
    </svg>
  `;
}

/**
 * Local fallback erase if AI inpaint fails: fill each box with sampled background color.
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
  const scaledLayout = scaleLayout(layout, sourceWidth, sourceHeight, imageWidth, imageHeight);

  const fillLayers: { input: Buffer; left: number; top: number }[] = [];

  for (const key of FIELD_KEYS) {
    const rawBox = scaledLayout[key];
    if (!rawBox) continue;
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
  }

  const erased = await base.composite(fillLayers).png().toBuffer();
  return `data:image/png;base64,${erased.toString("base64")}`;
}

/**
 * Step 3: Render exact typed text with extracted styles.
 * Step 4: Soften the text layer slightly so it looks printed (mild blur + opacity).
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
    const svgBuffer = Buffer.from(svg);

    // Soften text slightly so it blends into printed card texture.
    const softened = await sharp(svgBuffer)
      .blur(0.35)
      .png()
      .toBuffer();

    textLayers.push(softened);
  }

  if (textLayers.length === 0) {
    throw new Error("No styled text layers could be rendered.");
  }

  let composed = await base
    .composite(textLayers.map((input) => ({ input, blend: "over" as const })))
    .png()
    .toBuffer();

  // Very light noise blend to reduce "digital overlay" look.
  const noise = await sharp({
    create: {
      width: imageWidth,
      height: imageHeight,
      channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 0.03 },
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
