import { NextResponse, type NextRequest } from "next/server";
import {
  analyzeCardLayout,
  eraseFieldsWithOpenRouter,
  enhanceImageWithOpenRouter,
} from "@/lib/openrouter";
import { overlayTextOnImage } from "@/lib/overlay";
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

    const { image, fields, enhanceClarity } = parseResult.data;
    const sanitizedImage = sanitizeImageDataUri(image);

    // Step 1: Detect field bounding boxes with a vision model.
    const layout = await analyzeCardLayout(sanitizedImage);

    if (Object.keys(layout).length === 0) {
      throw new Error("Could not detect any card fields. Try uploading a clearer image.");
    }

    // Step 2: Erase the old text inside those bounding boxes.
    const erasedImage = await eraseFieldsWithOpenRouter(sanitizedImage, layout);

    // Step 3: Overlay the new text programmatically with sharp.
    let resultImage = await overlayTextOnImage(erasedImage, fields, layout);

    // Step 4: Optional clarity enhancement.
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
