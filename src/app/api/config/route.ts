import { NextResponse } from "next/server";
import { SITE_CONFIG } from "@/config/siteConfig";
import { getEffectiveSiteSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const dynamicSettings = await getEffectiveSiteSettings();
  return NextResponse.json({
    ok: true,
    config: {
      appName: SITE_CONFIG.appName,
      appTagline: SITE_CONFIG.appTagline,
      appDomain: SITE_CONFIG.appDomain,
      telegramJoinUrl: dynamicSettings.telegramJoinUrl,
      telegramPopupEnabled: dynamicSettings.telegramPopupEnabled,
      telegramPopupTitle: dynamicSettings.telegramPopupTitle,
      telegramPopupSubtitle: dynamicSettings.telegramPopupSubtitle,
      telegramAutoCloseSeconds: dynamicSettings.telegramAutoCloseSeconds,
      defaultImageUrl: dynamicSettings.defaultImageUrl,
      appLogoUrl: dynamicSettings.appLogoUrl,
      announcementText: dynamicSettings.announcementText,
      announcementEnabled: dynamicSettings.announcementEnabled,
      allowVideoDownload: dynamicSettings.allowVideoDownload !== false,
    },
  });
}
