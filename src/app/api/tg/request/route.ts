import { NextRequest, NextResponse } from "next/server";
import {
  cleanupExpiredRequests,
  consumeWebRequestQuota,
  countPendingRequests,
  createTelegramRequest,
  findReusableRequest,
  getBotConfig,
  getGlobalDeliveryQuota,
  getTelegramRequest,
  getWebRequestQuota,
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
//   resp: { ok, deepLink, requestId, quota, delivery }
//
// 🛡️ ANTI-THEFT LAYERS (v6) — koi scraper poora course na utha le:
//   1. login zaroori (401)
//   2. per-user deep-link rate limit  (15 / 10 min)
//   3. per-IP rate limit              (30 / 10 min) — bulk account farming rokta hai
//   4. GLOBAL circuit breaker         (poori site: N videos / 24h)
//   5. per-user daily quota           (wahi 12 / 24h jo bot lagata hai)
//   6. pending-request flood control  (max 3 undelivered links per user)
//   7. same video cooldown → purana link REUSE (naya record/quota spend nahi)
//   8. deep-link SINGLE-USE + ek Telegram account par BIND (bot side enforce)
// ============================================================================

/** Ek login 10 minute me kitne deep-link bana sakta hai. */
const USER_LINK_LIMIT = 15;
/** Ek IP 10 minute me kitne deep-link bana sakta hai. */
const IP_LINK_LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  if (!isContentRequestAuthorized(req)) {
    return json({ ok: false, error: "Please login to continue." }, 401);
  }

  const session = getStudentSessionFromRequest(req);
  const uid = session?.uid || "admin";
  const ip = clientIp(req);

  try {
    const body = await req.json().catch(() => ({}));
    const batchId = String(body?.batchId || "").trim();
    const videoId = String(body?.videoId || "").trim();

    if (!batchId || !videoId) {
      return json({ ok: false, error: "Missing batchId or videoId." }, 400);
    }

    // ── 2. per-user deep-link rate limit ────────────────────────────────────
    const perUser = await rateLimitHit(`tg_request:${uid}`, uid, {
      windowMs: WINDOW_MS,
      max: USER_LINK_LIMIT,
      lockMs: LOCK_MS,
    });
    if (!perUser.allowed) {
      return json(
        {
          ok: false,
          code: "RATE_LIMITED",
          error: `You are requesting too many links. Please try again in ${Math.ceil(
            perUser.retryAfterSec / 60
          )} minute(s).`,
          retryAfterSec: perUser.retryAfterSec,
        },
        429
      );
    }

    // ── 3. per-IP rate limit (multiple accounts se farming rokta hai) ───────
    const perIp = await rateLimitHit("tg_request_ip", ip, {
      windowMs: WINDOW_MS,
      max: IP_LINK_LIMIT,
      lockMs: LOCK_MS,
    });
    if (!perIp.allowed) {
      return json(
        {
          ok: false,
          code: "IP_RATE_LIMITED",
          error: `Too many requests from this network. Please try again in ${Math.ceil(
            perIp.retryAfterSec / 60
          )} minute(s).`,
          retryAfterSec: perIp.retryAfterSec,
        },
        429
      );
    }

    const [rawBatch, settings, botConfig, globalQuota] = await Promise.all([
      loadSingleRawBatch(batchId, { includeHidden: false }),
      getEffectiveSiteSettings(),
      getBotConfig(),
      getGlobalDeliveryQuota(),
    ]);

    // ── 4. global circuit breaker ───────────────────────────────────────────
    if (globalQuota.tripped) {
      return json(
        {
          ok: false,
          code: "GLOBAL_LIMIT",
          error:
            "Delivery is temporarily full for today because of heavy traffic. Please try again after some time.",
          global: globalQuota,
        },
        503
      );
    }

    // ── 5. per-user daily quota (bot wala hi limit, website par bhi) ────────
    const quota = await getWebRequestQuota(uid);
    if (quota.remaining <= 0) {
      const hours = Math.max(1, Math.ceil(quota.resetInSec / 3600));
      return json(
        {
          ok: false,
          code: "DAILY_LIMIT",
          error: `Your daily limit of ${quota.limit} videos is finished. It resets in about ${hours} hour(s). To increase your limit, contact @${String(
            botConfig.contactUsername || settings.contactUsername || "krishna84"
          ).replace(/^@+/, "")}`,
          quota,
        },
        429
      );
    }

    // ── 6. pending flood control ────────────────────────────────────────────
    const maxPending = Math.max(1, Number(botConfig.maxPendingPerUser || 3));
    const pendingCount = await countPendingRequests(uid);
    if (pendingCount >= maxPending) {
      return json(
        {
          ok: false,
          code: "TOO_MANY_PENDING",
          error: `You already have ${pendingCount} video link(s) waiting. Open them in Telegram first, then request another one.`,
          pending: pendingCount,
          quota,
        },
        429
      );
    }

    // ── 7. same video ka link pehle se bana hua hai? → REUSE ────────────────
    const reusable = await findReusableRequest(uid, videoId);
    if (reusable) {
      return json({
        ok: true,
        reused: true,
        requestId: reusable.requestId,
        deepLink: `https://t.me/${String(botConfig.botUsername).replace(/^@+/, "")}?start=${reusable.requestId}`,
        botUsername: String(botConfig.botUsername || "").replace(/^@+/, ""),
        title: reusable.record.title,
        batchName: reusable.record.batchName,
        topic: reusable.record.topic,
        courseName: reusable.record.courseName,
        fileSize: reusable.record.fileSize,
        quota,
        delivery: buildDeliveryBlock(botConfig, settings),
      });
    }

    if (!rawBatch) {
      return json({ ok: false, error: "Batch not found." }, 404);
    }

    const roots = getEffectiveRootNodes(rawBatch);
    const located = findVideoInBatch(roots, videoId);
    if (!located) {
      return json({ ok: false, error: "Lecture not found." }, 404);
    }

    const batchName = String(rawBatch.name || rawBatch.title || "Course");
    const title = String(located.video.title || located.video.name || "Lecture");
    const tgToken = String(located.video.tg_video_token || "");

    // 🚫 YouTube embed playback hata diya gaya hai — bot sirf Telegram file
    //    deliver kar sakta hai, isliye bina Telegram file ke request banti hi nahi.
    if (!tgToken) {
      return json(
        {
          ok: false,
          code: "NO_SOURCE",
          error:
            "This content is unavailable right now. It will be uploaded soon — please check back later.",
        },
        409
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
      fileSize: Number(located.video.file_size || 0),
      ip,
    });

    if (!result.ok) {
      return json(
        { ok: false, error: result.error || "Could not create the Telegram link." },
        503
      );
    }

    // ── 8. quota consume (link banne par hi, delivery par bot bhi lagata hai) ─
    const quotaAfter = await consumeWebRequestQuota(uid, videoId, String(result.requestId));

    // background hygiene: TTL-expired records saaf (await zaroori nahi)
    void cleanupExpiredRequests().catch(() => {});

    return json({
      ok: true,
      requestId: result.requestId,
      deepLink: result.deepLink,
      botUsername: result.botUsername,
      title,
      batchName,
      topic: result.record?.topic || "",
      courseName: result.record?.courseName || batchName,
      fileSize: result.record?.fileSize || 0,
      quota: quotaAfter,
      delivery: buildDeliveryBlock(botConfig, settings),
    });
  } catch {
    return json({ ok: false, error: "Failed to create the Telegram link." }, 500);
  }
}

function buildDeliveryBlock(
  botConfig: Awaited<ReturnType<typeof getBotConfig>>,
  settings: Awaited<ReturnType<typeof getEffectiveSiteSettings>>
) {
  return {
    dailyLimit: Number(botConfig.dailyLimit || settings.dailyVideoLimit || 12),
    autoDeleteHours: Number(botConfig.autoDeleteHours || settings.autoDeleteHours || 2),
    creditUsername: String(botConfig.creditUsername || settings.creditUsername || "krishna84"),
    contactUsername: String(botConfig.contactUsername || settings.contactUsername || "krishna84"),
    deliveryMode: String(botConfig.deliveryMode || "clean"),
    paused: Boolean(botConfig.paused),
    reuseLimit: Math.max(1, Number(botConfig.requestReuseLimit || 1)),
    cooldownMin: Number(botConfig.requestCooldownMin || 5),
  };
}

/**
 * GET /api/tg/request?id=xxxx → record ka status (delivered ya nahi).
 * Sirf logged-in student/admin ke liye, aur sirf usi ke liye jisne banaya
 * (ya admin) — dusre ka request status leak nahi hota.
 */
export async function GET(req: NextRequest) {
  if (!isContentRequestAuthorized(req)) {
    return json({ ok: false, error: "Please login to continue." }, 401);
  }

  const session = getStudentSessionFromRequest(req);
  const uid = session?.uid || "admin";

  const id = String(req.nextUrl.searchParams.get("id") || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
    return json({ ok: false, error: "Invalid request id." }, 400);
  }

  const record = await getTelegramRequest(id);
  if (!record) {
    return json(
      { ok: false, error: "This link has expired. Please open the video again." },
      404
    );
  }

  // 🔒 dusre user ka record padhna allowed nahi
  if (String(record.uid || "") !== String(uid)) {
    return json({ ok: false, error: "This link belongs to another account." }, 403);
  }

  return json({
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
      boundTgUid: record.boundTgUid || 0,
      usedCount: record.usedCount || 0,
    },
  });
}
