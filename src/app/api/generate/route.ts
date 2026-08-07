import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import {
  extractFieldStyles,
  eraseFieldsWithOpenRouter,
  enhanceImageWithOpenRouter,
} from "@/lib/openrouter";
import { eraseFieldsLocally, renderStyledText } from "@/lib/overlay";
import { checkRateLimit, incrementRateLimit } from "@/lib/rate-limit";
import { generateRequestSchema, sanitizeImageDataUri } from "@/lib/validation";
import type { GenerateResponse } from "@/lib/types";

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "anonymous";
}

export async function POST(request: NextRequest): Promise<NextResponse<GenerateResponse>> {
  try {
    const ip = getClientIp(request);
    const rateLimit = checkRateLimit(ip);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: `Rate limit exceeded. Try again after ${new Date(rateLimit.resetAt).toLocaleString()}.`,
        },
        { status: 429 }
      );
    }

    const body = (await request.json()) as unknown;
    const parseResult = generateRequestSchema.safeParse(body);

    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      return NextResponse.json(
        { success: false, error: `Invalid input: ${messages.join("; ")}` },
        { status: 400 }
      );
    }

    const { image, fields, layout, enhanceClarity } = parseResult.data;
    const sanitizedImage = sanitizeImageDataUri(image);

    const meta = await sharp(Buffer.from(sanitizedImage.split(",")[1], "base64")).metadata();
    const sourceWidth = meta.width ?? 0;
    const sourceHeight = meta.height ?? 0;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("Could not read uploaded image dimensions.");
    }

    // Step 1: Extract style (font/color/size) from each marked region.
    const styles = await extractFieldStyles(sanitizedImage, layout);

    // Step 2: AI inpaint — erase old text only (local fill fallback).
    let erasedImage: string;
    try {
      erasedImage = await eraseFieldsWithOpenRouter(sanitizedImage, layout);
    } catch {
      erasedImage = await eraseFieldsLocally(sanitizedImage, layout, sourceWidth, sourceHeight);
    }

    // Step 3 + 4: Render exact typed text with extracted styles, then soften/blend.
    // scaleLayout inside renderStyledText maps original mark boxes onto the erased image size.
    let resultImage = await renderStyledText(
      erasedImage,
      fields,
      layout,
      styles,
      sourceWidth,
      sourceHeight
    );

    if (enhanceClarity) {
      resultImage = await enhanceImageWithOpenRouter(resultImage);
    }

    incrementRateLimit(ip);

    return NextResponse.json({ success: true, image: resultImage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
