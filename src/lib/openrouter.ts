import type { BoundingBox, CardFormData, FieldStyle, LayoutMap, StyleMap } from "./types";

const OPENROUTER_IMAGE_API_URL = "https://openrouter.ai/api/v1/images/generations";
const OPENROUTER_CHAT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const FIELD_KEYS: (keyof CardFormData)[] = ["name", "dob", "iss", "exp", "address"];

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === "your_openrouter_api_key_here") {
    throw new Error("OpenRouter API key is not configured.");
  }
  return key;
}

function getModel(): string {
  return process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-image";
}

function getVisionModel(): string {
  return process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.5-flash";
}

function getUpscaleModel(): string {
  return process.env.OPENROUTER_UPSCALE_MODEL || getModel();
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };

  if (process.env.OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  }

  if (process.env.OPENROUTER_SITE_NAME) {
    headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;
  }

  return headers;
}

type ImageApiResponse = {
  data?: { url?: string; b64_json?: string }[];
  error?: { message?: string };
};

function boxLabel(box: BoundingBox): string {
  return `x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height}`;
}

const DEFAULT_STYLE: FieldStyle = {
  color: "#1a1a1a",
  fontSize: 16,
  fontWeight: 500,
  fontFamily: "Arial, Helvetica, sans-serif",
  letterSpacing: 0,
  opacity: 0.95,
};

function normalizeStyle(raw: Partial<FieldStyle> | null | undefined, box?: BoundingBox): FieldStyle {
  const fallbackSize = box ? Math.max(10, Math.round(box.height * 0.7)) : DEFAULT_STYLE.fontSize;
  const color = typeof raw?.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.color)
    ? raw.color
    : DEFAULT_STYLE.color;

  return {
    color,
    fontSize: typeof raw?.fontSize === "number" && raw.fontSize > 0 ? Math.round(raw.fontSize) : fallbackSize,
    fontWeight: typeof raw?.fontWeight === "number" && raw.fontWeight > 0 ? raw.fontWeight : DEFAULT_STYLE.fontWeight,
    fontFamily: typeof raw?.fontFamily === "string" && raw.fontFamily.trim()
      ? raw.fontFamily
      : DEFAULT_STYLE.fontFamily,
    letterSpacing: typeof raw?.letterSpacing === "number" ? raw.letterSpacing : DEFAULT_STYLE.letterSpacing,
    opacity: typeof raw?.opacity === "number" ? Math.min(1, Math.max(0.7, raw.opacity)) : DEFAULT_STYLE.opacity,
  };
}

async function callImageGenerationApi(imageDataUri: string, prompt: string, model: string): Promise<string> {
  const response = await fetch(OPENROUTER_IMAGE_API_URL, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      input_references: [
        {
          type: "image_url",
          image_url: { url: imageDataUri },
        },
      ],
      output_format: "png",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter image request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as ImageApiResponse;
  if (data.error?.message) {
    throw new Error(`OpenRouter image error: ${data.error.message}`);
  }

  const result = data.data?.[0];
  if (!result) throw new Error("No image data returned by OpenRouter.");
  if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
  if (result.url) return result.url;
  throw new Error("OpenRouter returned an empty image result.");
}

/**
 * Step 1: Extract text style (color, size, weight, family) from each marked field.
 */
export async function extractFieldStyles(
  imageDataUri: string,
  layout: LayoutMap
): Promise<StyleMap> {
  const regions = FIELD_KEYS
    .map((key) => {
      const box = layout[key];
      if (!box) return null;
      return `- ${key}: rectangle (${boxLabel(box)})`;
    })
    .filter(Boolean)
    .join("\n");

  const prompt = [
    "This is a design mockup sample card. Analyze ONLY the marked text regions below.",
    "For each region, extract the visual text style of the existing printed text.",
    "Return ONLY valid JSON with this exact shape:",
    `{
  "name": {"color":"#1a1a1a","fontSize":18,"fontWeight":600,"fontFamily":"Arial","letterSpacing":0,"opacity":0.95},
  "dob": {"color":"#1a1a1a","fontSize":14,"fontWeight":500,"fontFamily":"Arial","letterSpacing":0,"opacity":0.95}
}`,
    "Rules:",
    "- color must be a hex string like #RRGGBB",
    "- fontSize must be pixels estimated from the text height in that region",
    "- fontWeight must be a number like 400, 500, 600, or 700",
    "- fontFamily should be the closest common web-safe family (Arial, Helvetica, Times New Roman, Courier New, Verdana)",
    "- opacity should be between 0.85 and 1",
    "Regions:",
    regions,
  ].join("\n");

  const response = await fetch(OPENROUTER_CHAT_API_URL, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      model: getVisionModel(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUri } },
          ],
        },
      ],
    }),
  });

  const styles: StyleMap = {};

  if (!response.ok) {
    for (const key of FIELD_KEYS) {
      if (layout[key]) styles[key] = normalizeStyle(undefined, layout[key]);
    }
    return styles;
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);

  let parsed: Partial<Record<keyof CardFormData, Partial<FieldStyle>>> = {};
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]) as Partial<Record<keyof CardFormData, Partial<FieldStyle>>>;
    } catch {
      parsed = {};
    }
  }

  for (const key of FIELD_KEYS) {
    if (!layout[key]) continue;
    styles[key] = normalizeStyle(parsed[key], layout[key]);
  }

  return styles;
}

/**
 * Step 2: AI inpaint — erase old text only. Do not write any new characters.
 */
export async function eraseFieldsWithOpenRouter(
  imageDataUri: string,
  layout: LayoutMap
): Promise<string> {
  const eraseInstructions = FIELD_KEYS
    .map((key) => {
      const box = layout[key];
      if (!box) return null;
      return `- Erase ALL text inside the ${key.toUpperCase()} rectangle (${boxLabel(box)}). Fill that area with the original seamless background color/texture. Do NOT write any new letters, digits, or symbols.`;
    })
    .filter(Boolean)
    .join("\n");

  const prompt = [
    "This is a design mockup sample card for prototyping. It is not a real document.",
    "Your ONLY job is background inpainting: remove text from the marked rectangles and restore blank background.",
    eraseInstructions,
    "Do not change anything outside those rectangles.",
    "Do not add watermarks, labels, annotations, or new text of any kind.",
    "This is for a design prototype, not a real document.",
  ].join("\n");

  return callImageGenerationApi(imageDataUri, prompt, getModel());
}

export async function enhanceImageWithOpenRouter(imageDataUri: string): Promise<string> {
  const prompt = [
    "Enhance the clarity and sharpness of this sample card mockup slightly.",
    "Preserve all text, layout, colors, fonts, and design details exactly as they are.",
    "Do not change any text content or spelling.",
    "This is for a design prototype, not a real document.",
  ].join(" ");

  return callImageGenerationApi(imageDataUri, prompt, getUpscaleModel());
}
