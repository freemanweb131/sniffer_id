import { z } from "zod";
import type { CardFormData } from "./types";
import type { LayoutMap, BoundingBox } from "./openrouter";

const MAX_FILE_SIZE_MB = 10;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const cardFormSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100, "Name must be under 100 characters")
    .regex(/^[\p{L}\p{M}\s.'-]+$/u, "Name contains invalid characters"),
  dob: z
    .string()
    .min(1, "Date of birth is required")
    .max(50, "DOB must be under 50 characters")
    .regex(/^[\w\/\.\s-]+$/, "DOB format contains invalid characters"),
  iss: z
    .string()
    .min(1, "Issue date is required")
    .max(50, "Issue date must be under 50 characters")
    .regex(/^[\w\/\.\s-]+$/, "Issue date format contains invalid characters"),
  exp: z
    .string()
    .min(1, "Expiration date is required")
    .max(50, "Expiration date must be under 50 characters")
    .regex(/^[\w\/\.\s-]+$/, "Expiration date format contains invalid characters"),
  address: z
    .string()
    .min(1, "Address is required")
    .max(200, "Address must be under 200 characters")
    .regex(/^[\p{L}\p{M}\d\s.,#'/-]+$/u, "Address contains invalid characters"),
});

export const generateRequestSchema = z.object({
  image: z.string().min(1, "Image is required"),
  fields: cardFormSchema,
  enhanceClarity: z.boolean(),
});

export function sanitizeImageDataUri(image: string): string {
  const match = image.match(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);
  if (!match) {
    throw new Error("Invalid image format. Only JPEG, PNG, or WEBP data URIs are accepted.");
  }

  const base64 = image.split(",")[1];
  const sizeInBytes = Buffer.from(base64, "base64").length;
  const sizeInMB = sizeInBytes / (1024 * 1024);

  if (sizeInMB > MAX_FILE_SIZE_MB) {
    throw new Error(`Image size must be under ${MAX_FILE_SIZE_MB}MB.`);
  }

  const mimeType = `image/${match[1]}`;
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error("Only JPEG, PNG, and WEBP images are allowed.");
  }

  return image;
}

function boxToString(box: BoundingBox): string {
  const x2 = box.x + box.width;
  const y2 = box.y + box.height;
  return `from pixel (${box.x}, ${box.y}) to (${x2}, ${y2})`;
}

export function buildErasePrompt(layout: LayoutMap): string {
  const fieldLabels: Record<keyof CardFormData, string> = {
    name: "NAME",
    dob: "DOB",
    iss: "ISS",
    exp: "EXP",
    address: "ADDRESS",
  };

  const eraseInstructions = Object.entries(fieldLabels)
    .map(([key, label]) => {
      const box = layout[key as keyof CardFormData];
      if (box) {
        return `- Erase all text inside the '${label}' field, which is the rectangular area ${boxToString(box)}. Replace it with the original blank background color and texture. Do not write any new text.`;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n");

  return [
    "This is a design mockup sample card for prototyping. It is not a real document.",
    "Your task is to ONLY erase text from specific labeled fields. Do not add, write, or draw any new text.",
    eraseInstructions,
    "Preserve all other text, layout, colors, fonts, seals, patterns, and design elements exactly as they are.",
    "Make the erased areas blend seamlessly with the surrounding blank background.",
    "Do not add watermarks, logos, annotations, or extra graphics.",
    "This is for a design prototype, not a real document.",
  ].join("\n");
}

export function buildEnhancePrompt(): string {
  return [
    "Enhance the clarity and sharpness of this sample card mockup.",
    "Preserve all text, layout, colors, fonts, and design details exactly as they are.",
    "Make the mockup clearer, slightly sharper, and easier to read while keeping it photorealistic.",
    "Do not change any text, dates, names, addresses, or card design elements.",
    "This is for a design prototype, not a real document.",
  ].join("\n");
}
