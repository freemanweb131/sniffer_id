import { z } from "zod";
import type { CardFormData } from "./types";

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

export function buildEditPrompt(fields: CardFormData): string {
  return [
    "Edit this identification card image precisely:",
    `- Replace the name field with: ${fields.name}`,
    `- Replace the date of birth (DOB) field with: ${fields.dob}`,
    `- Replace the issue date (ISS) field with: ${fields.iss}`,
    `- Replace the expiration date (EXP) field with: ${fields.exp}`,
    `- Replace the address field with: ${fields.address}`,
    "Preserve the original card layout, fonts, colors, background, and all other text or design elements not listed above.",
    "Match the original typography style, size, and alignment as closely as possible.",
    "Do not add watermarks, logos, or extra graphics.",
  ].join("\n");
}

export function buildEnhancePrompt(): string {
  return [
    "Enhance the clarity and sharpness of this identification card image.",
    "Preserve all text, layout, colors, and details exactly as they are.",
    "Make the image clearer, slightly sharper, and easier to read while keeping it photorealistic.",
    "Do not change any text, dates, names, addresses, or card design elements.",
  ].join("\n");
}
