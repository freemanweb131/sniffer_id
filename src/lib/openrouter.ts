import type { BoundingBox, CardFormData, LayoutMap } from "./types";

const OPENROUTER_IMAGE_API_URL = "https://openrouter.ai/api/v1/images/generations";
const OPENROUTER_CHAT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

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

function buildPreciseEditPrompt(fields: CardFormData, layout: LayoutMap): string {
  const instructions = (Object.keys(fields) as (keyof CardFormData)[])
    .map((key) => {
      const box = layout[key];
      if (!box) return null;
      const label = key.toUpperCase();
      return `- Inside the exact rectangle (${boxLabel(box)}) for the ${label} field: erase the old text and write EXACTLY this text with no spelling changes, no extra letters, no missing letters: "${fields[key]}". Match the original font style, size, weight, color, and alignment as closely as possible.`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    "This is a design mockup sample card for prototyping. It is not a real document.",
    "Edit ONLY the marked field rectangles described below. Do not change any other part of the card.",
    "Spelling accuracy is critical: write each new value character-for-character exactly as provided.",
    instructions,
    "Preserve background texture, seals, holograms, borders, and all unmarked text.",
    "Do not invent extra text, watermarks, or labels.",
    "This is for a design prototype, not a real document.",
  ].join("\n");
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

export async function editImageWithLayout(
  imageDataUri: string,
  fields: CardFormData,
  layout: LayoutMap
): Promise<string> {
  return callImageGenerationApi(imageDataUri, buildPreciseEditPrompt(fields, layout), getModel());
}

/**
 * OCR-style verification: returns field keys whose visible text does NOT match expected values.
 */
export async function verifyEditedFields(
  imageDataUri: string,
  fields: CardFormData
): Promise<(keyof CardFormData)[]> {
  const expected = (Object.keys(fields) as (keyof CardFormData)[])
    .map((key) => `- ${key}: "${fields[key]}"`)
    .join("\n");

  const prompt = [
    "This is a sample card mockup. Read the visible values for NAME, DOB, ISS, EXP, and ADDRESS.",
    "Compare each against the expected values below.",
    "Return ONLY JSON with this shape:",
    '{ "mismatches": ["name", "dob"] }',
    "Include a field key in mismatches only if the visible text is missing, incomplete, mistyped, or different from the expected value.",
    "Ignore case differences only if the expected text is clearly present; otherwise mark as mismatch.",
    "If everything matches, return { \"mismatches\": [] }.",
    "Expected values:",
    expected,
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

  if (!response.ok) {
    // If verification fails, treat all fields as needing deterministic correction.
    return Object.keys(fields) as (keyof CardFormData)[];
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return Object.keys(fields) as (keyof CardFormData)[];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { mismatches?: string[] };
    const validKeys = new Set(Object.keys(fields));
    return (parsed.mismatches ?? []).filter((key): key is keyof CardFormData =>
      validKeys.has(key)
    );
  } catch {
    return Object.keys(fields) as (keyof CardFormData)[];
  }
}

export async function enhanceImageWithOpenRouter(imageDataUri: string): Promise<string> {
  const prompt = [
    "Enhance the clarity and sharpness of this sample card mockup.",
    "Preserve all text, layout, colors, fonts, and design details exactly as they are.",
    "Do not change any text content or spelling.",
    "This is for a design prototype, not a real document.",
  ].join(" ");

  return callImageGenerationApi(imageDataUri, prompt, getUpscaleModel());
}
