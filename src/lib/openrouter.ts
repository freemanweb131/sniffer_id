import type { CardFormData } from "./types";

const OPENROUTER_IMAGE_API_URL = "https://openrouter.ai/api/v1/images/generations";

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === "your_openrouter_api_key_here") {
    throw new Error("OpenRouter API key is not configured.");
  }
  return key;
}

function getUpscaleModel(): string {
  return process.env.OPENROUTER_UPSCALE_MODEL || process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-image";
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

export async function enhanceImageWithOpenRouter(imageDataUri: string): Promise<string> {
  const model = getUpscaleModel();
  const prompt = [
    "Enhance the clarity and sharpness of this sample card mockup.",
    "Preserve all text, layout, colors, fonts, and design details exactly as they are.",
    "Do not change any text content.",
    "This is for a design prototype, not a real document.",
  ].join(" ");

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

// Keep type export compatibility if needed elsewhere.
export type { CardFormData };
