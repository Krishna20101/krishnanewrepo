import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
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
    });

    return NextResponse.json({ ok: true, settings: updated });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to save settings." },
      { status: 500 }
    );
  }
}
