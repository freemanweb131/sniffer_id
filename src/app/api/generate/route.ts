import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import {
  editImageWithLayout,
  verifyEditedFields,
  enhanceImageWithOpenRouter,
} from "@/lib/openrouter";
import { applyHybridEdit } from "@/lib/overlay";
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

    // Step 1: AI edits using your exact marked boxes + exact typed text.
    // Fall back to deterministic overlay if the AI call fails.
    let resultImage: string;
    try {
      resultImage = await editImageWithLayout(sanitizedImage, fields, layout);

      // Step 2: Verify spelling/content with vision OCR.
      const mismatches = await verifyEditedFields(resultImage, fields);

      // Step 3: Deterministically correct any mistyped/missing fields.
      if (mismatches.length > 0) {
        resultImage = await applyHybridEdit(
          resultImage,
          fields,
          layout,
          sourceWidth,
          sourceHeight,
          mismatches
        );
      }
    } catch {
      resultImage = await applyHybridEdit(
        sanitizedImage,
        fields,
        layout,
        sourceWidth,
        sourceHeight
      );
    }

    // Step 4: Optional clarity enhancement (preserves text).
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
