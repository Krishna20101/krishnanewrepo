import { NextResponse } from "next/server";
import { SITE_CONFIG, isTelegramJoinUrlConfigured } from "@/config/siteConfig";
import { getBotConfig } from "@/lib/botDelivery";
import { getEffectiveSiteSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const [dynamicSettings, botConfig] = await Promise.all([
    getEffectiveSiteSettings(),
    getBotConfig().catch(() => null),
  ]);
  return NextResponse.json({
    ok: true,
    config: {
      appName: SITE_CONFIG.appName,
      appTagline: SITE_CONFIG.appTagline,
      appDomain: SITE_CONFIG.appDomain,
      // placeholder/dead link client tak bhejte hi nahi — khali string
      telegramJoinUrl: isTelegramJoinUrlConfigured(dynamicSettings.telegramJoinUrl)
        ? dynamicSettings.telegramJoinUrl
        : "",
      /**
       * 🔧 FIX (v5): link configured hi na ho (ya placeholder ho) to popup
       * force-off — warna user ko dead "JOIN NOW" button dikhta tha.
       */
      telegramJoinUrlConfigured: isTelegramJoinUrlConfigured(
        dynamicSettings.telegramJoinUrl
      ),
      telegramPopupEnabled:
        dynamicSettings.telegramPopupEnabled &&
        isTelegramJoinUrlConfigured(dynamicSettings.telegramJoinUrl),
      telegramPopupTitle: dynamicSettings.telegramPopupTitle,
      telegramPopupSubtitle: dynamicSettings.telegramPopupSubtitle,
      telegramAutoCloseSeconds: dynamicSettings.telegramAutoCloseSeconds,
      defaultImageUrl: dynamicSettings.defaultImageUrl,
      appLogoUrl: dynamicSettings.appLogoUrl,
      announcementText: dynamicSettings.announcementText,
      announcementEnabled: dynamicSettings.announcementEnabled,
      allowVideoDownload: dynamicSettings.allowVideoDownload !== false,

      // 🤖 Telegram Bot Delivery (watch page isi se decide karta hai ki video
      //    in-app player me chalega ya "OPEN IN TELEGRAM" button dikhega)
      videoDeliveryMode:
        dynamicSettings.videoDeliveryMode === "in-app-player"
          ? "in-app-player"
          : "telegram-bot",
      telegramBotUsername: String(
        botConfig?.botUsername || dynamicSettings.telegramBotUsername || ""
      ).replace(/^@+/, ""),
      dailyVideoLimit: Number(botConfig?.dailyLimit || dynamicSettings.dailyVideoLimit || 12),
      autoDeleteHours: Number(botConfig?.autoDeleteHours || dynamicSettings.autoDeleteHours || 2),
      creditUsername: String(botConfig?.creditUsername || dynamicSettings.creditUsername || "krishna84"),
      contactUsername: String(botConfig?.contactUsername || dynamicSettings.contactUsername || "krishna84"),
      botDeliveryPaused: Boolean(botConfig?.paused),
    },
  });
}
