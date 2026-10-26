import { NextRequest, NextResponse } from "next/server";
import {
  findVideoInBatch,
  getEffectiveRootNodes,
  loadSingleRawBatch,
  toCleanNodeItem,
} from "@/lib/batchEngine";
import { getEffectiveSiteSettings, getVideoEmbed } from "@/lib/db";
import { buildYoutubeEmbedUrl } from "@/lib/youtube";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { batchId: string; videoId: string } }
) {
  try {
    const batchId = decodeURIComponent(params.batchId);
    const videoId = decodeURIComponent(params.videoId);

    const [rawBatch, savedEmbed, settings] = await Promise.all([
      loadSingleRawBatch(batchId, { includeHidden: false }),
      getVideoEmbed(batchId, videoId),
      getEffectiveSiteSettings(),
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

    let embedUrl = "";
    let watchUrl = "";
    let youtubeId: string | null = null;

    if (savedEmbed?.embedUrl) {
      embedUrl = savedEmbed.embedUrl;
      youtubeId = savedEmbed.youtubeId;
      watchUrl = youtubeId
        ? `https://www.youtube.com/watch?v=${youtubeId}`
        : savedEmbed.rawUrl;
    } else if (located.video.youtube_url) {
      const parsed = buildYoutubeEmbedUrl(located.video.youtube_url);
      embedUrl = parsed.embedUrl;
      watchUrl = parsed.watchUrl;
      youtubeId = parsed.youtubeId;
    } else if (
      settings.defaultYoutubeUrl &&
      !located.video.tg_video_token
    ) {
      const parsed = buildYoutubeEmbedUrl(settings.defaultYoutubeUrl);
      embedUrl = parsed.embedUrl;
      watchUrl = parsed.watchUrl;
      youtubeId = parsed.youtubeId;
    }

    // Build encrypted Telegram Stream URL (via Cloudflare Edge Worker if configured, else Vercel 2MB Chunked Route!)
    const tgToken = located.video.tg_video_token || "";
    const workerBase = (settings.cloudflareStreamWorkerUrl || "")
      .trim()
      .replace(/\/$/, "");

    const directStreamUrl = tgToken
      ? `/api/tg/stream/${encodeURIComponent(tgToken)}`
      : "";

    const telegramStreamUrl = tgToken
      ? workerBase
        ? `${workerBase}/stream/${encodeURIComponent(tgToken)}`
        : directStreamUrl
      : "";

    const cleanVideo = toCleanNodeItem(located.video, undefined, batchId);

    // Limit sibling list to max 30 nearby items so watch page stays lightning fast on mobile!
    const currentIdx = located.siblings.findIndex(
      (s) => String(s.id) === videoId
    );
    const sliceStart = Math.max(0, currentIdx - 10);
    const nearbySiblings = located.siblings
      .slice(sliceStart, sliceStart + 30)
      .map((s) => toCleanNodeItem(s, undefined, batchId));

    return NextResponse.json({
      ok: true,
      batch: {
        id: String(rawBatch.id || batchId),
        name: String(rawBatch.name || rawBatch.title || "Course"),
        thumbnail: String(rawBatch.thumbnail || "").trim(),
      },
      video: cleanVideo,
      folderTitle: located.folderTitle,
      folderId: located.folderId,
      folderPath: located.folderPath,
      embedUrl,
      watchUrl,
      youtubeId,
      telegramStreamUrl,
      directStreamUrl,
      isYoutubeOnly: Boolean(!tgToken && embedUrl),
      fileSize: located.video.file_size || 0,
      allowVideoDownload: settings.allowVideoDownload !== false,
      siblings: nearbySiblings,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to load video." },
      { status: 500 }
    );
  }
}
