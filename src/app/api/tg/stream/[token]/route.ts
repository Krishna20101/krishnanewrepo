import { NextRequest, NextResponse } from "next/server";
import { SITE_CONFIG } from "@/config/siteConfig";
import { isContentRequestAuthorized } from "@/lib/studentAuth";
import { getEffectiveSiteSettings } from "@/lib/db";
import { isAllowedStreamRequest, streamCorsHeaders } from "@/lib/httpGuards";
import { verifyTelegramMediaToken } from "@/lib/tgCrypto";
import {
  createTelegramByteRangeStream,
  MAX_STREAM_RESPONSE_BYTES,
  resolveTelegramMediaMeta,
} from "@/lib/tgClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // Vercel Hobby max streaming duration (300s per stream connection)

// ============================================================================
// 🎬 TELEGRAM MEDIA STREAM  (video + PDF) — HTTP 206 byte-range
// ----------------------------------------------------------------------------
// 🔒 v5 hardening:
//   • hotlink guard ab DEFAULT-DENY hai (pehle sirf `Range:` header bhej kar
//     koi bhi direct stream nikal sakta tha)
//   • Cloudflare Worker proxy shared secret (`X-Worker-Secret`) se verify hota
//     hai — admin panel → Website Settings se secret copy karke worker.js me
//     paste karein aur "Require worker secret" ON kar dein
//   • wildcard CORS hata diya — sirf allowlisted origin reflect hota hai
//
// 🤖 NOTE: v5 se VIDEO delivery default roop se Telegram bot se hoti hai
//   (watch page par ▶ OPEN IN TELEGRAM). Ye route ab mainly PDF + thumbnails +
//   optional in-app player fallback ke liye hai.
// ============================================================================

async function guard(req: NextRequest): Promise<{
  allowed: boolean;
  cors: Record<string, string>;
}> {
  const settings = await getEffectiveSiteSettings().catch(() => null);
  const allowedOrigins = [
    settings?.cloudflareStreamWorkerUrl || "",
    SITE_CONFIG.appDomain || "",
    process.env.NEXT_PUBLIC_SITE_URL || "",
  ].filter(Boolean);

  const cors = streamCorsHeaders(req, allowedOrigins);
  const allowed = isAllowedStreamRequest(req, {
    hasSession: isContentRequestAuthorized(req),
    options: {
      requireWorkerSecret: Boolean(settings?.requireWorkerSecret),
      allowedOrigins,
    },
  });

  return { allowed, cors };
}

function deniedResponse(cors: Record<string, string>): Response {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Direct external link access is disabled. Please open the lecture inside the website.",
    },
    { status: 403, headers: cors }
  );
}

export async function OPTIONS(req: NextRequest) {
  const { cors } = await guard(req);
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function HEAD(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { allowed, cors } = await guard(req);
  try {
    if (!allowed) return new NextResponse(null, { status: 403, headers: cors });

    const rawToken = decodeURIComponent(params.token || "");
    const decoded = verifyTelegramMediaToken(rawToken);
    if (!decoded) {
      return new NextResponse(null, { status: 403, headers: cors });
    }

    const meta = await resolveTelegramMediaMeta({
      chatId: decoded.c,
      messageId: decoded.m,
      knownTotalSize: decoded.s,
      knownMimeType: decoded.mt,
      knownFileName: decoded.n,
    });

    const contentType =
      decoded.k === "p"
        ? "application/pdf"
        : decoded.mt || meta.mimeType || "video/mp4";

    return new NextResponse(null, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(meta.totalSize),
        "X-SHD-Total-Size": String(meta.totalSize),
        "X-SHD-File-Name": encodeURIComponent(
          decoded.n || meta.fileName || "lecture.mp4"
        ),
        "X-SHD-Mime-Type": contentType,
      },
    });
  } catch {
    return new NextResponse(null, { status: 500, headers: cors });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { allowed, cors } = await guard(req);

  try {
    if (!allowed) return deniedResponse(cors);

    const rawToken = decodeURIComponent(params.token || "");
    const decoded = verifyTelegramMediaToken(rawToken);
    if (!decoded) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired media stream token." },
        { status: 403, headers: cors }
      );
    }

    const meta = await resolveTelegramMediaMeta({
      chatId: decoded.c,
      messageId: decoded.m,
      knownTotalSize: decoded.s,
      knownMimeType: decoded.mt,
      knownFileName: decoded.n,
    });

    const totalSize = meta.totalSize;
    const rangeHeader = req.headers.get("range");

    let startByte = 0;
    let endByte = totalSize - 1;
    let hasRange = false;

    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      hasRange = true;
      const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
      const parsedStart = parseInt(startStr, 10);

      if (!Number.isNaN(parsedStart) && parsedStart >= 0) {
        startByte = parsedStart;
      }

      if (startByte >= totalSize) {
        return new Response(null, {
          status: 416,
          headers: {
            ...cors,
            "Content-Range": `bytes */${totalSize}`,
          },
        });
      }

      if (endStr && endStr.trim() !== "") {
        const parsedEnd = parseInt(endStr, 10);
        if (!Number.isNaN(parsedEnd) && parsedEnd >= startByte) {
          endByte = Math.min(parsedEnd, totalSize - 1);
        }
      }
      // IMPORTANT: When `<video>` sends open-ended `Range: bytes=0-` (empty endStr),
      // `endByte` stays `totalSize - 1` and streams continuously via ReadableStream!
    }

    // 32 MB per-response cap: keeps every Vercel invocation short & memory-safe.
    // Chrome automatically asks for the next 32 MB slice, so playback stays
    // continuous (aur in-app player fallback bhi smooth rehta hai).
    const cappedEnd = startByte + MAX_STREAM_RESPONSE_BYTES - 1;
    if (endByte > cappedEnd) {
      endByte = Math.min(cappedEnd, totalSize - 1);
    }

    const contentLength = endByte - startByte + 1;
    const contentType =
      decoded.k === "p"
        ? "application/pdf"
        : decoded.mt || meta.mimeType || "video/mp4";

    const safeDisplayName = encodeURIComponent(
      decoded.n || meta.fileName || "lecture.mp4"
    );

    const stream = createTelegramByteRangeStream({
      initialMeta: meta,
      startByte,
      endByte,
      abortSignal: req.signal,
    });

    const headers: Record<string, string> = {
      ...cors,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(contentLength),
      "X-SHD-Total-Size": String(totalSize),
      "X-SHD-File-Name": safeDisplayName,
      "X-SHD-Mime-Type": contentType,
      "X-SHD-Engine": meta.viaBot ? "telegram-bot" : "telegram-user",
      "Cache-Control": isTrustedWorkerRequest(req)
        ? "public, max-age=604800"
        : "no-transform",
    };

    if (hasRange) {
      headers["Content-Range"] = `bytes ${startByte}-${endByte}/${totalSize}`;
    }

    return new Response(stream, {
      status: hasRange ? 206 : 200,
      headers,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stream failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: cors });
  }
}

function isTrustedWorkerRequest(req: NextRequest): boolean {
  return req.headers.get("x-shd-worker-proxy") === "1";
}
