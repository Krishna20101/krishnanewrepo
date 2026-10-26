import { NextRequest, NextResponse } from "next/server";
import { verifyTelegramMediaToken } from "@/lib/tgCrypto";
import { fetchTelegramThumbnailJpeg } from "@/lib/tgClient";
import { SITE_CONFIG } from "@/config/siteConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const rawToken = decodeURIComponent(params.token || "");
    const decoded = verifyTelegramMediaToken(rawToken);
    if (!decoded || decoded.k !== "t") {
      return NextResponse.redirect(SITE_CONFIG.defaultImageUrl);
    }

    const buf = await fetchTelegramThumbnailJpeg({
      chatId: decoded.c,
      messageId: decoded.m,
    });

    if (!buf || buf.length === 0) {
      return new NextResponse(null, { status: 404 });
    }

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
