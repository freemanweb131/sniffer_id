import type { CardFormData } from "./types";
import { buildEditPrompt, buildEnhancePrompt } from "./validation";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

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

function extractImageUrl(content: string | null | undefined): string | null {
  if (!content) return null;

  const markdownMatch = content.match(/!\[.*?\]\((.*?)\)/);
  if (markdownMatch) return markdownMatch[1];

  const urlMatch = content.match(/(https?:\/\/[^\s\"<>{}|\^`\[\]]+)/);
  if (urlMatch) return urlMatch[1];

  if (content.startsWith("data:image")) return content;

  return null;
}

export async function editImageWithOpenRouter(
  imageDataUri: string,
  fields: CardFormData
): Promise<string> {
  const model = getModel();
  const prompt = buildEditPrompt(fields);

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      model,
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
    const text = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  const imageUrl = extractImageUrl(content);

  if (!imageUrl) {
    throw new Error("No image was returned by the model. The model may not support image editing.");
  }

  return imageUrl;
}

export async function enhanceImageWithOpenRouter(imageDataUri: string): Promise<string> {
  const model = getUpscaleModel();
  const prompt = buildEnhancePrompt();

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      model,
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
    const text = await response.text();
    throw new Error(`OpenRouter upscale request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`OpenRouter upscale error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  const imageUrl = extractImageUrl(content);

  if (!imageUrl) {
    throw new Error("No enhanced image was returned by the model.");
  }

  return imageUrl;
}
