import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { writeFieldsWithAI, verifyEditedFields } from "@/lib/openrouter";
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
    if (!meta.width || !meta.height) {
      throw new Error("Could not read uploaded image dimensions.");
    }

    // In-place AI rewrite on the ORIGINAL image (no solid-fill clean).
    // That keeps guilloche intact and matches Sex/Wgt/Hgt/Eyes print style.
    let resultImage = await writeFieldsWithAI(sanitizedImage, fields, layout);

    // If spelling is off, retry AI once with the same style-focused prompt.
    // Do NOT fall back to solid gray boxes + synthetic fonts — that looks fake.
    const mismatches = await verifyEditedFields(resultImage, fields);
    if (mismatches.length > 0) {
      resultImage = await writeFieldsWithAI(sanitizedImage, fields, layout);
    }

    incrementRateLimit(ip);

    return NextResponse.json({ success: true, image: resultImage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
