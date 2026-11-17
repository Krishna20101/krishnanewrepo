import { NextRequest, NextResponse } from "next/server";
import {
  createTelegramRequest,
  getBotConfig,
  getTelegramRequest,
} from "@/lib/botDelivery";
import {
  findVideoInBatch,
  getEffectiveRootNodes,
  loadSingleRawBatch,
} from "@/lib/batchEngine";
import { getEffectiveSiteSettings } from "@/lib/db";
import { rateLimitHit } from "@/lib/rtStore";
import {
  getStudentSessionFromRequest,
  isContentRequestAuthorized,
} from "@/lib/studentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ============================================================================
// 🤖 POST /api/tg/request  →  Telegram Bot deep-link banata hai
// ----------------------------------------------------------------------------
// Watch page par ▶ OPEN IN TELEGRAM dabane par client ye call karta hai:
//   body: { batchId, videoId }
//   resp: { ok, deepLink: "https://t.me/<bot>?start=<id>", requestId, quota }
//
// Server-side:
//   • student/admin session zaroori (401 warna)
//   • DB-backed rate limit (Vercel ke saare containers share karte hain)
//   • batch JSON se real title/topic/course/chat/message nikalta hai
//   • `tg_requests/<id>` me record save → python bot wahi padhta hai
// ============================================================================

export async function POST(req: NextRequest) {
  if (!isContentRequestAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Please login to continue." },
      { status: 401 }
    );
  }

  const session = getStudentSessionFromRequest(req);
  const uid = session?.uid || "admin";

  try {
    const body = await req.json().catch(() => ({}));
    const batchId = String(body?.batchId || "").trim();
    const videoId = String(body?.videoId || "").trim();

    if (!batchId || !videoId) {
      return NextResponse.json(
        { ok: false, error: "Missing batchId or videoId." },
        { status: 400 }
      );
    }

    // ── Abuse control: ek student 10 minute me max 40 deep-link banaye ──────
    const limit = await rateLimitHit(`tg_request:${uid}`, uid, {
      windowMs: 10 * 60 * 1000,
      max: 40,
      lockMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `Too many requests. Please try again in ${Math.ceil(
            limit.retryAfterSec / 60
          )} minute(s).`,
        },
        { status: 429 }
      );
    }

    const [rawBatch, settings, botConfig] = await Promise.all([
      loadSingleRawBatch(batchId, { includeHidden: false }),
      getEffectiveSiteSettings(),
      getBotConfig(),
    ]);

    if (!rawBatch) {
      return NextResponse.json(
        { ok: false, error: "Batch not found." },
        { status: 404 }
      );
    }

    const roots = getEffectiveRootNodes(rawBatch);
    const located = findVideoInBatch(roots, videoId);
    if (!located) {
      return NextResponse.json(
        { ok: false, error: "Lecture not found." },
        { status: 404 }
      );
    }

    const batchName = String(rawBatch.name || rawBatch.title || "Course");
    const title = String(located.video.title || located.video.name || "Lecture");
    const tgToken = String(located.video.tg_video_token || "");
    const youtubeUrl = String(located.video.youtube_url || "");

    // 🚫 YouTube-only lecture par bhi request nahi banti — bot sirf Telegram
    //    file deliver kar sakta hai, aur website me YouTube embed playback ab
    //    hai hi nahi. Dono case me user ko same English message milta hai.
    if (!tgToken) {
      return NextResponse.json(
        {
          ok: false,
          /**
           * 🚫 YouTube embed playback hata diya gaya hai — jis lecture me
           * Telegram video file nahi hai, user ko yahi English message dikhta
           * hai (watch page par bhi same "content unavailable" card hai).
           */
          error:
            "This content is unavailable right now. It will be uploaded soon — please check back later.",
          code: "NO_SOURCE",
        },
        { status: 409 }
      );
    }

    const result = await createTelegramRequest({
      uid,
      batchId,
      batchName,
      videoId,
      title,
      courseName: batchName,
      topic: String(located.folderTitle || ""),
      folderPath: Array.isArray(located.folderPath) ? located.folderPath : [],
      tgVideoToken: tgToken,
      youtubeUrl,
      fileSize: Number(located.video.file_size || 0),
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error || "Could not create the Telegram link." },
        { status: 503 }
      );
    }

    return NextResponse.json({
      ok: true,
      requestId: result.requestId,
      deepLink: result.deepLink,
      botUsername: result.botUsername,
      title,
      batchName,
      topic: result.record?.topic || "",
      courseName: result.record?.courseName || batchName,
      fileSize: result.record?.fileSize || 0,
      hasTelegramFile: Boolean(tgToken),
      isYoutubeOnly: Boolean(!tgToken && youtubeUrl),
      delivery: {
        dailyLimit: Number(botConfig.dailyLimit || settings.dailyVideoLimit || 12),
        autoDeleteHours: Number(botConfig.autoDeleteHours || settings.autoDeleteHours || 2),
        creditUsername: String(botConfig.creditUsername || settings.creditUsername || "krishna84"),
        contactUsername: String(
          botConfig.contactUsername || settings.contactUsername || "krishna84"
        ),
        deliveryMode: String(botConfig.deliveryMode || "clean"),
        paused: Boolean(botConfig.paused),
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to create the Telegram link." },
      { status: 500 }
    );
  }
}

/**
 * GET /api/tg/request?id=xxxx → record ka status (delivered ya nahi).
 * Sirf logged-in student/admin ke liye.
 */
export async function GET(req: NextRequest) {
  if (!isContentRequestAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Please login to continue." },
      { status: 401 }
    );
  }

  const id = String(req.nextUrl.searchParams.get("id") || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
    return NextResponse.json({ ok: false, error: "Invalid request id." }, { status: 400 });
  }

  const record = await getTelegramRequest(id);
  if (!record) {
    return NextResponse.json(
      { ok: false, error: "This link has expired. Please open the video again." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    request: {
      title: record.title,
      topic: record.topic,
      courseName: record.courseName,
      createdAt: record.createdAt,
      deliveredTo: record.deliveredTo || 0,
      deliveredAt: record.deliveredAt || 0,
      deleteAt: record.deleteAt || 0,
      deliveryMode: record.deliveryMode || "",
    },
  });
}
