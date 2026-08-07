import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { writeFieldsWithAI, verifyEditedFields } from "@/lib/openrouter";
import { applyDirectEdit, cleanMarkedFields } from "@/lib/overlay";
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

    const { image, fields, layout } = parseResult.data;
    const sanitizedImage = sanitizeImageDataUri(image);

    const meta = await sharp(Buffer.from(sanitizedImage.split(",")[1], "base64")).metadata();
    const sourceWidth = meta.width ?? 0;
    const sourceHeight = meta.height ?? 0;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("Could not read uploaded image dimensions.");
    }

    // Step 1: Clean marked fields first (remove old text, leave blank patches).
    const cleanedImage = await cleanMarkedFields(
      sanitizedImage,
      layout,
      sourceWidth,
      sourceHeight
    );

    // Step 2: Forward cleaned card + exact inputs to AI to restore pattern and write matching text.
    let resultImage: string;
    try {
      resultImage = await writeFieldsWithAI(cleanedImage, fields, layout);

      // Step 3: If AI misspelled/missed fields, fall back to deterministic glyph overlay.
      const mismatches = await verifyEditedFields(resultImage, fields);
      if (mismatches.length > 0) {
        resultImage = await applyDirectEdit(
          sanitizedImage,
          fields,
          layout,
          sourceWidth,
          sourceHeight
        );
      }
    } catch {
      resultImage = await applyDirectEdit(
        sanitizedImage,
        fields,
        layout,
        sourceWidth,
        sourceHeight
      );
    }

    incrementRateLimit(ip);

    return NextResponse.json({ success: true, image: resultImage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
