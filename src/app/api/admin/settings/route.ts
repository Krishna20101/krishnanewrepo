import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import { saveBotConfig } from "@/lib/botDelivery";
import { saveSiteSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();

    const updated = await saveSiteSettings({
      telegramJoinUrl: body?.telegramJoinUrl,
      telegramPopupEnabled:
        body?.telegramPopupEnabled !== undefined
          ? Boolean(body.telegramPopupEnabled)
          : undefined,
      telegramAutoCloseSeconds:
        body?.telegramAutoCloseSeconds !== undefined
          ? Math.max(
              2,
              Math.min(60, Number(body.telegramAutoCloseSeconds) || 5)
            )
          : undefined,
      telegramPopupTitle: body?.telegramPopupTitle,
      telegramPopupSubtitle: body?.telegramPopupSubtitle,
      defaultImageUrl: body?.defaultImageUrl,
      appLogoUrl: body?.appLogoUrl,
      defaultYoutubeUrl: body?.defaultYoutubeUrl,
      announcementText: body?.announcementText,
      announcementEnabled:
        body?.announcementEnabled !== undefined
          ? Boolean(body.announcementEnabled)
          : undefined,
      cloudflareStreamWorkerUrl: body?.cloudflareStreamWorkerUrl,
      allowVideoDownload:
        body?.allowVideoDownload !== undefined
          ? Boolean(body.allowVideoDownload)
          : undefined,

      // 🤖 Telegram Bot Delivery (v5)
      videoDeliveryMode:
        body?.videoDeliveryMode === "in-app-player"
          ? "in-app-player"
          : body?.videoDeliveryMode === "telegram-bot"
            ? "telegram-bot"
            : undefined,
      telegramBotUsername:
        body?.telegramBotUsername !== undefined
          ? String(body.telegramBotUsername || "")
              .replace(/^@+/, "")
              .replace(/[^A-Za-z0-9_]/g, "")
              .slice(0, 32)
          : undefined,
      dailyVideoLimit:
        body?.dailyVideoLimit !== undefined
          ? Math.max(0, Math.min(100000, Number(body.dailyVideoLimit) || 0))
          : undefined,
      autoDeleteHours:
        body?.autoDeleteHours !== undefined
          ? Math.max(0, Math.min(720, Number(body.autoDeleteHours) || 0))
          : undefined,
      creditUsername:
        body?.creditUsername !== undefined
          ? String(body.creditUsername || "krishna84").replace(/^@+/, "").slice(0, 32)
          : undefined,
      contactUsername:
        body?.contactUsername !== undefined
          ? String(body.contactUsername || "krishna84").replace(/^@+/, "").slice(0, 32)
          : undefined,
      requireWorkerSecret:
        body?.requireWorkerSecret !== undefined
          ? Boolean(body.requireWorkerSecret)
          : undefined,
    });

    // Bot ka apna config node bhi sync karo (python bot yahi padhta hai)
    try {
      await saveBotConfig({
        ...(updated.telegramBotUsername
          ? { botUsername: updated.telegramBotUsername }
          : {}),
        dailyLimit: Number(updated.dailyVideoLimit || 12),
        autoDeleteHours: Number(updated.autoDeleteHours || 2),
        creditUsername: String(updated.creditUsername || "krishna84"),
        contactUsername: String(updated.contactUsername || "krishna84"),
      });
    } catch {
      // bot config sync fail ho to settings save ko block nahi karna
    }

    return NextResponse.json({ ok: true, settings: updated });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to save settings." },
      { status: 500 }
    );
  }
}
