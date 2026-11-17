import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import {
  getBotConfig,
  getBotStats,
  listBotEvents,
  listBotTasks,
  listBotUsers,
  pushBotTask,
  saveBotConfig,
  setBotUserLimit,
  BotConfig,
} from "@/lib/botDelivery";
import { getEffectiveSiteSettings, saveSiteSettings } from "@/lib/db";
import { getWorkerSharedSecret } from "@/lib/serverSecrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ============================================================================
// 🤖 /api/admin/bot — Telegram Delivery Bot control (admin only)
// ----------------------------------------------------------------------------
// GET  → live stats, users, config, tasks, recent events, heartbeat
// POST → config change / broadcast / per-user limit  (bot task queue me jata hai)
// ============================================================================

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) return unauthorized();

  const [stats, config, settings] = await Promise.all([
    getBotStats(),
    getBotConfig(),
    getEffectiveSiteSettings(),
  ]);

  const limitParam = Number(req.nextUrl.searchParams.get("users") || 60);
  const users = await listBotUsers(Math.min(200, Math.max(1, limitParam)));
  const tasks = await listBotTasks(15);
  const events = await listBotEvents(15);

  return NextResponse.json({
    ok: true,
    stats,
    config,
    settings: {
      videoDeliveryMode: settings.videoDeliveryMode,
      telegramBotUsername: settings.telegramBotUsername,
      dailyVideoLimit: settings.dailyVideoLimit,
      autoDeleteHours: settings.autoDeleteHours,
      creditUsername: settings.creditUsername,
      contactUsername: settings.contactUsername,
      allowVideoDownload: settings.allowVideoDownload,
      requireWorkerSecret: Boolean(settings.requireWorkerSecret),
    },
    /**
     * 🔒 Cloudflare Worker ⇄ origin shared secret (sirf admin ko dikhta hai).
     * worker.js me `WORKER_SHARED_SECRET` me paste karein.
     */
    workerSecret: getWorkerSharedSecret(),
    users,
    tasks,
    events,
  });
}

interface PostBody {
  action?: string;
  config?: Partial<BotConfig>;
  message?: string;
  userId?: number | string;
  limit?: number;
  videoDeliveryMode?: "telegram-bot" | "in-app-player";
}

export async function POST(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as PostBody;
  const action = String(body?.action || "save_config");

  try {
    if (action === "save_config") {
      const patch: Partial<BotConfig> = { ...(body.config || {}) };

      // numeric sanitisation
      if (patch.dailyLimit !== undefined) {
        patch.dailyLimit = Math.max(0, Math.min(100000, Number(patch.dailyLimit) || 0));
      }
      if (patch.autoDeleteHours !== undefined) {
        patch.autoDeleteHours = Math.max(0, Math.min(720, Number(patch.autoDeleteHours) || 0));
      }
      if (patch.requestTtlHours !== undefined) {
        patch.requestTtlHours = Math.max(1, Math.min(24 * 90, Number(patch.requestTtlHours) || 168));
      }
      if (patch.maxDialogs !== undefined) {
        patch.maxDialogs = Math.max(5, Math.min(500, Number(patch.maxDialogs) || 60));
      }
      if (patch.maxMessagesPerChat !== undefined) {
        patch.maxMessagesPerChat = Math.max(5, Math.min(500, Number(patch.maxMessagesPerChat) || 40));
      }
      if (patch.deliveryMode !== undefined) {
        patch.deliveryMode = patch.deliveryMode === "forward" ? "forward" : "clean";
      }
      if (patch.creditUsername !== undefined) {
        patch.creditUsername = String(patch.creditUsername || "krishna84").replace(/^@+/, "").slice(0, 32);
      }
      if (patch.contactUsername !== undefined) {
        patch.contactUsername = String(patch.contactUsername || "krishna84").replace(/^@+/, "").slice(0, 32);
      }
      if (patch.botUsername !== undefined) {
        patch.botUsername = String(patch.botUsername || "").replace(/^@+/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 32);
      }

      const config = await saveBotConfig(patch);

      // Website settings bhi sync (deep-link + watch page behaviour)
      await saveSiteSettings({
        telegramBotUsername: config.botUsername,
        dailyVideoLimit: config.dailyLimit,
        autoDeleteHours: config.autoDeleteHours,
        creditUsername: config.creditUsername,
        contactUsername: config.contactUsername,
        ...(body.videoDeliveryMode ? { videoDeliveryMode: body.videoDeliveryMode } : {}),
      });

      // Bot ko turant config refresh karne ke liye task
      await pushBotTask({ type: "set_config", payload: { ...patch } });

      return NextResponse.json({ ok: true, config });
    }

    if (action === "set_delivery_mode") {
      const mode = body.videoDeliveryMode === "in-app-player" ? "in-app-player" : "telegram-bot";
      await saveSiteSettings({ videoDeliveryMode: mode });
      return NextResponse.json({ ok: true, videoDeliveryMode: mode });
    }

    if (action === "broadcast") {
      const message = String(body?.message || "").trim();
      if (!message) {
        return NextResponse.json(
          { ok: false, error: "Broadcast message is empty." },
          { status: 400 }
        );
      }
      if (message.length > 3800) {
        return NextResponse.json(
          { ok: false, error: "Broadcast message is too long (max 3800 characters)." },
          { status: 400 }
        );
      }
      const taskId = await pushBotTask({ type: "broadcast", payload: { message } });
      return NextResponse.json({ ok: true, taskId });
    }

    if (action === "set_user_limit") {
      const userId = Number(body?.userId || 0);
      const limit = Number(body?.limit);
      if (!userId || !Number.isFinite(limit) || limit < 0) {
        return NextResponse.json(
          { ok: false, error: "Valid userId and limit are required." },
          { status: 400 }
        );
      }
      await setBotUserLimit(userId, Math.min(100000, Math.round(limit)));
      const taskId = await pushBotTask({
        type: "set_limit",
        payload: { userId, limit: Math.min(100000, Math.round(limit)) },
      });
      return NextResponse.json({ ok: true, userId, limit, taskId });
    }

    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}` },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
