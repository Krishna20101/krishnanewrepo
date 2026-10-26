import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import {
  flattenBatchVideos,
  getEffectiveRootNodes,
  loadAllRawBatches,
} from "@/lib/batchEngine";
import { getAllVideoEmbeds, saveVideoEmbed } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const batchId = req.nextUrl.searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json(
      { ok: false, error: "batchId is required" },
      { status: 400 }
    );
  }

  const batchesMap = await loadAllRawBatches({ includeHidden: true });
  const rawBatch = batchesMap.get(batchId);
  if (!rawBatch) {
    return NextResponse.json(
      { ok: false, error: "Batch not found" },
      { status: 404 }
    );
  }

  const embeds = await getAllVideoEmbeds();
  const flatVideos = flattenBatchVideos(getEffectiveRootNodes(rawBatch));

  const videosWithLinks = flatVideos.map((v) => {
    const key = `${batchId}_${v.id}`;
    const saved = embeds[key] || embeds[v.id];
    return {
      ...v,
      rawUrl: saved?.rawUrl || "",
      embedUrl: saved?.embedUrl || "",
      youtubeId: saved?.youtubeId || null,
      updatedAt: saved?.updatedAt || null,
    };
  });

  return NextResponse.json({
    ok: true,
    batchId,
    batchName: rawBatch.name || rawBatch.title || `Batch ${batchId}`,
    videos: videosWithLinks,
  });
}

export async function POST(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();

    if (Array.isArray(body?.items)) {
      const results = [];
      for (const item of body.items) {
        const saved = await saveVideoEmbed({
          batchId: String(item.batchId),
          videoId: String(item.videoId),
          title: item.title || "",
          rawUrl: String(item.rawUrl || ""),
        });
        results.push(saved);
      }
      return NextResponse.json({ ok: true, count: results.length });
    }

    const batchId = String(body?.batchId || "").trim();
    const videoId = String(body?.videoId || "").trim();
    const rawUrl = String(body?.rawUrl ?? "").trim();
    const title = String(body?.title || "").trim();

    if (!batchId || !videoId) {
      return NextResponse.json(
        { ok: false, error: "batchId and videoId are required." },
        { status: 400 }
      );
    }

    const saved = await saveVideoEmbed({ batchId, videoId, title, rawUrl });
    return NextResponse.json({ ok: true, embed: saved });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to save YouTube link." },
      { status: 500 }
    );
  }
}
