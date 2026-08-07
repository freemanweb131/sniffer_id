import type { CardFormData } from "./types";
import { buildEditPrompt, buildEnhancePrompt } from "./validation";

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
  data?: { url?: string; b64_json?: string; revised_prompt?: string }[];
  error?: { message?: string };
};

type LayoutMap = Partial<Record<keyof CardFormData, string>>;

const LAYOUT_PROMPT = `Analyze this sample card mockup image carefully.
Locate the visible text labels or fields for: NAME, DOB (date of birth), ISS (issue date), EXP (expiration date), and ADDRESS.
For each label that you can find, describe its exact location in simple relative terms (e.g. "top-left below the photo", "middle-right area", "bottom section", "upper-right corner").
Return ONLY a valid JSON object with this exact shape and no extra text:
{
  "name": "location description",
  "dob": "location description",
  "iss": "location description",
  "exp": "location description",
  "address": "location description"
}
If a field is not visible or cannot be located, set its value to null.`;

async function analyzeCardLayout(imageDataUri: string): Promise<LayoutMap> {
  const model = getVisionModel();

  const response = await fetch(OPENROUTER_CHAT_API_URL, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: LAYOUT_PROMPT },
            { type: "image_url", image_url: { url: imageDataUri } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter layout analysis failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`OpenRouter layout analysis error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {};
  }

  try {
    return JSON.parse(jsonMatch[0]) as LayoutMap;
  } catch {
    return {};
  }
}

async function callImageGenerationApi(
  imageDataUri: string,
  prompt: string,
  model: string
): Promise<string> {
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
          image_url: {
            url: imageDataUri,
          },
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
  if (!result) {
    throw new Error("No image data returned by OpenRouter.");
  }

  if (result.b64_json) {
    return `data:image/png;base64,${result.b64_json}`;
  }

  if (result.url) {
    return result.url;
  }

  throw new Error("OpenRouter returned an empty image result.");
}

export async function editImageWithOpenRouter(
  imageDataUri: string,
  fields: CardFormData
): Promise<string> {
  const model = getModel();
  const layout = await analyzeCardLayout(imageDataUri);
  const prompt = buildEditPrompt(fields, layout);
  return callImageGenerationApi(imageDataUri, prompt, model);
}

export async function enhanceImageWithOpenRouter(imageDataUri: string): Promise<string> {
  const model = getUpscaleModel();
  const prompt = buildEnhancePrompt();
  return callImageGenerationApi(imageDataUri, prompt, model);
}
