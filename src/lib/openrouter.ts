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

type MessageContent =
  | string
  | { type: "text"; text?: string }
  | { type: "image_url"; image_url?: { url?: string } }
  | { type: "image"; source?: { data?: string }; data?: string }
  | Record<string, unknown>;

function extractImageUrl(content: MessageContent | MessageContent[] | null | undefined): string | null {
  if (!content) return null;

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "object" && item !== null) {
        if ("image_url" in item && item.image_url && typeof item.image_url === "object") {
          const url = (item.image_url as { url?: string }).url;
          if (url) return url;
        }
        if ("image" in item && item.image && typeof item.image === "object") {
          const imageData = (item.image as { url?: string; data?: string }).url ?? (item.image as { data?: string }).data;
          if (imageData) return imageData;
        }
        if ("source" in item && item.source && typeof item.source === "object") {
          const data = (item.source as { data?: string }).data;
          if (data) return data;
        }
      }
      const nested = extractImageUrl(item);
      if (nested) return nested;
    }
    return null;
  }

  if (typeof content !== "string") return null;

  const dataUriMatch = content.match(/data:image\/(?:jpeg|png|webp|jpg);base64,[A-Za-z0-9+/=]+/);
  if (dataUriMatch) return dataUriMatch[0];

  const markdownMatch = content.match(/!\[.*?\]\((.*?)\)/);
  if (markdownMatch) return markdownMatch[1];

  const imageUrlMatch = content.match(/(https?:\/\/[^\s\"<>{}|\^`\[\]]+\.(?:png|jpe?g|webp))/i);
  if (imageUrlMatch) return imageUrlMatch[1];

  const genericUrlMatch = content.match(/(https?:\/\/[^\s\"<>{}|\^`\[\]]+)/);
  if (genericUrlMatch) return genericUrlMatch[1];

  return null;
}

async function callImageModel(
  imageDataUri: string,
  prompt: string,
  model: string
): Promise<string> {
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
    choices?: { message?: { content?: MessageContent | MessageContent[] } }[];
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  const imageUrl = extractImageUrl(content);

  if (!imageUrl) {
    const preview = typeof content === "string" ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300);
    throw new Error(
      `No image was returned by the model. Response preview: "${preview}"`
    );
  }

  return imageUrl;
}

export async function editImageWithOpenRouter(
  imageDataUri: string,
  fields: CardFormData
): Promise<string> {
  const model = getModel();
  const prompt = buildEditPrompt(fields);
  return callImageModel(imageDataUri, prompt, model);
}

export async function enhanceImageWithOpenRouter(imageDataUri: string): Promise<string> {
  const model = getUpscaleModel();
  const prompt = buildEnhancePrompt();
  return callImageModel(imageDataUri, prompt, model);
}
