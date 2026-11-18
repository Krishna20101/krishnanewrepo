import { NextRequest, NextResponse } from "next/server";
import { verifyTelegramMediaToken } from "@/lib/tgCrypto";
import { fetchTelegramThumbnailJpeg } from "@/lib/tgClient";
import { SITE_CONFIG } from "@/config/siteConfig";
import { resolveAllowedOrigin } from "@/lib/httpGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
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

    // 🔒 wildcard CORS ki jagah sirf allowlisted origin reflect hota hai
    const headers: Record<string, string> = {
      "Content-Type": "image/jpeg",
      "Content-Length": String(buf.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    const allowedOrigin = resolveAllowedOrigin(req, [SITE_CONFIG.appDomain]);
    if (allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers.Vary = "Origin";
    }

    return new NextResponse(new Uint8Array(buf), { status: 200, headers });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
