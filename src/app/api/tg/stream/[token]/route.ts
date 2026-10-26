import { NextRequest, NextResponse } from "next/server";
import { verifyTelegramMediaToken } from "@/lib/tgCrypto";
import {
  createTelegramByteRangeStream,
  MAX_STREAM_RESPONSE_BYTES,
  resolveTelegramMediaMeta,
} from "@/lib/tgClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // Vercel Hobby max streaming duration (300s per stream connection)

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Range, Content-Type, X-SHD-Client, X-SHD-Worker-Proxy",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Type, X-SHD-Total-Size, X-SHD-File-Name, X-SHD-Mime-Type, X-SHD-Engine",
};

function isAllowedStreamRequest(req: NextRequest): boolean {
  if (req.headers.get("x-shd-worker-proxy") === "1") return true;
  if (req.headers.get("x-shd-client") === "web-player") return true;

  const dest = req.headers.get("sec-fetch-dest") || "";
  if (dest === "video" || dest === "audio" || dest === "empty") return true;

  const range = req.headers.get("range");
  if (range && range.startsWith("bytes=")) return true;

  const referer = req.headers.get("referer") || "";
  const host = req.headers.get("host") || "";
  if (dest === "document" && (!referer || !referer.includes(host))) {
    return false;
  }

  return true;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function HEAD(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    if (!isAllowedStreamRequest(req)) {
      return new NextResponse(null, { status: 403, headers: CORS_HEADERS });
    }
    const rawToken = decodeURIComponent(params.token || "");
    const decoded = verifyTelegramMediaToken(rawToken);
    if (!decoded) {
      return new NextResponse(null, { status: 403, headers: CORS_HEADERS });
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
        ...CORS_HEADERS,
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
    return new NextResponse(null, { status: 500, headers: CORS_HEADERS });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    if (!isAllowedStreamRequest(req)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Direct external link access is disabled. Please watch inside Study helper Doc.",
        },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const rawToken = decodeURIComponent(params.token || "");
    const decoded = verifyTelegramMediaToken(rawToken);
    if (!decoded) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired media stream token." },
        { status: 403, headers: CORS_HEADERS }
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
            ...CORS_HEADERS,
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
      // This completely eliminates 2MB EOF cutoffs, H.264 GOP glitches, and repeated frames!
    }

    // 32 MB per-response cap: keeps every Vercel invocation short & memory-safe
    // (Hobby functions hard-stop around 60s). Chrome automatically asks for the
    // next 32 MB slice, so playback stays 100% continuous & smooth.
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
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(contentLength),
      "X-SHD-Total-Size": String(totalSize),
      "X-SHD-File-Name": safeDisplayName,
      "X-SHD-Mime-Type": contentType,
      "X-SHD-Engine": meta.viaBot ? "telegram-bot" : "telegram-user",
      "Cache-Control":
        req.headers.get("x-shd-worker-proxy") === "1"
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
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
