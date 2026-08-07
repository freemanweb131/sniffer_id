import sharp from "sharp";
import type { CardFormData } from "./types";
import type { LayoutMap, BoundingBox } from "./openrouter";

const fieldLabels: Record<keyof CardFormData, string> = {
  name: "NAME",
  dob: "DOB",
  iss: "ISS",
  exp: "EXP",
  address: "ADDRESS",
};

function dataUriToBuffer(dataUri: string): Buffer {
  const base64 = dataUri.split(",")[1];
  return Buffer.from(base64, "base64");
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createTextSvg(
  text: string,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  textColor = "#1a1a1a"
): string {
  const fontSize = Math.max(12, Math.round(box.height * 0.65));
  const paddingX = Math.round(box.width * 0.02);
  const paddingY = Math.round((box.height - fontSize) / 2);

  const svg = `
    <svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">
      <text
        x="${box.x + paddingX}"
        y="${box.y + paddingY + fontSize * 0.8}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${fontSize}"
        font-weight="500"
        fill="${textColor}"
        text-anchor="start"
        dominant-baseline="alphabetic"
      >${escapeXml(text)}</text>
    </svg>
  `;

  return svg;
}

export async function overlayTextOnImage(
  imageDataUri: string,
  fields: CardFormData,
  layout: LayoutMap
): Promise<string> {
  const imageBuffer = dataUriToBuffer(imageDataUri);
  const metadata = await sharp(imageBuffer).metadata();
  const imageWidth = metadata.width ?? 800;
  const imageHeight = metadata.height ?? 500;

  const overlays: Buffer[] = [];

  for (const key of Object.keys(fieldLabels) as (keyof CardFormData)[]) {
    const box = layout[key];
    const value = fields[key];
    if (!box || !value) continue;

    const svg = createTextSvg(value, box, imageWidth, imageHeight);
    const svgBuffer = Buffer.from(svg);
    overlays.push(svgBuffer);
  }

  const resultBuffer = await sharp(imageBuffer)
    .composite(overlays.map((input) => ({ input, blend: "over" })))
    .png()
    .toBuffer();

  return `data:image/png;base64,${resultBuffer.toString("base64")}`;
}
