import { NextResponse, type NextRequest } from "next/server";
import { applyHybridEdit } from "@/lib/overlay";
import { enhanceImageWithOpenRouter } from "@/lib/openrouter";
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

    // Infer source size from the uploaded image metadata via sharp inside applyHybridEdit.
    // Pass layout pixel coordinates as provided by the client (relative to original image).
    const meta = await import("sharp").then(async ({ default: sharp }) => {
      const base64 = sanitizedImage.split(",")[1];
      const buffer = Buffer.from(base64, "base64");
      return sharp(buffer).metadata();
    });

    const sourceWidth = meta.width ?? 0;
    const sourceHeight = meta.height ?? 0;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("Could not read uploaded image dimensions.");
    }

    // Deterministic pipeline: erase marked regions + draw exact typed text.
    let resultImage = await applyHybridEdit(
      sanitizedImage,
      fields,
      layout,
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
