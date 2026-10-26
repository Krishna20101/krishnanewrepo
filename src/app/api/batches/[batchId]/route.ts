import { NextRequest, NextResponse } from "next/server";
import {
  findFolderWithBreadcrumbs,
  getEffectiveRootNodes,
  loadSingleRawBatch,
  sortNodesByImportanceAndOrder,
  toCleanNodeItem,
} from "@/lib/batchEngine";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { batchId: string } }
) {
  try {
    const batchId = decodeURIComponent(params.batchId);
    const folderId = req.nextUrl.searchParams.get("folderId");
    const page = Math.max(
      1,
      parseInt(req.nextUrl.searchParams.get("page") || "1", 10) || 1
    );
    const limit = Math.min(
      60,
      Math.max(
        12,
        parseInt(req.nextUrl.searchParams.get("limit") || "24", 10) || 24
      )
    );

    // FAST: Only load this single batch instead of all batches!
    const rawBatch = await loadSingleRawBatch(batchId, {
      includeHidden: false,
    });

    if (!rawBatch) {
      return NextResponse.json(
        { ok: false, error: "Batch not found." },
        { status: 404 }
      );
    }

    const rootNodes = getEffectiveRootNodes(rawBatch);

    let activeNodes = rootNodes;
    let currentFolderTitle = String(
      rawBatch.name || rawBatch.title || `Batch ${batchId}`
    );
    let breadcrumbs: Array<{ id: string; title: string }> = [];

    if (folderId) {
      const found = findFolderWithBreadcrumbs(rootNodes, folderId);
      if (!found) {
        return NextResponse.json(
          { ok: false, error: "Folder not found in this batch." },
          { status: 404 }
        );
      }
      activeNodes = found.folder.children || [];
      currentFolderTitle = String(
        found.folder.title || found.folder.name || "Folder"
      );
      breadcrumbs = found.breadcrumbs;
    }

    // Sort so ⭐ Important items always stay at top + respect Admin sortOrder!
    const sortedRaw = sortNodesByImportanceAndOrder(activeNodes);

    const rawFolders = sortedRaw.filter(
      (n) => String(n.type || "FOLDER").toUpperCase() === "FOLDER"
    );
    const rawVideos = sortedRaw.filter(
      (n) => String(n.type || "").toUpperCase() === "VIDEO"
    );
    const rawStandalonePdfs = sortedRaw.filter(
      (n) => String(n.type || "").toUpperCase() === "PDF"
    );
    const rawLinks = sortedRaw.filter(
      (n) => String(n.type || "").toUpperCase() === "LINK"
    );

    const endOffset = page * limit;

    // Slice BEFORE mapping subtrees so low-storage phones only receive what is visible on screen!
    const pagedFolders = rawFolders
      .slice(0, endOffset)
      .map((n) => toCleanNodeItem(n, undefined, batchId));

    const pagedVideos = rawVideos
      .slice(0, endOffset)
      .map((n) => toCleanNodeItem(n, undefined, batchId));

    const allMappedStandalonePdfs = rawStandalonePdfs.map((n) =>
      toCleanNodeItem(n, undefined, batchId)
    );

    const derivedVideoPdfs =
      allMappedStandalonePdfs.length > 0
        ? []
        : rawVideos
            .filter(
              (v) => v.tg_pdf_token || v.pdf_url || v.pdf_link_enc
            )
            .slice(0, endOffset)
            .map((v) => ({
              ...toCleanNodeItem(v, undefined, batchId),
              type: "PDF" as const,
            }));

    const pagedPdfs =
      allMappedStandalonePdfs.length > 0
        ? allMappedStandalonePdfs.slice(0, endOffset)
        : derivedVideoPdfs;

    const totalPdfsCount =
      rawStandalonePdfs.length > 0
        ? rawStandalonePdfs.length
        : rawVideos.filter((v) => v.tg_pdf_token || v.pdf_url || v.pdf_link_enc)
            .length;

    const links = rawLinks.map((n) => toCleanNodeItem(n, undefined, batchId));

    const numericPrice = Number(String(rawBatch.price ?? "").trim());
    const displayPrice =
      !Number.isNaN(numericPrice) && numericPrice > 0
        ? `₹${numericPrice}`
        : "FREE";

    return NextResponse.json({
      ok: true,
      batch: {
        id: String(rawBatch.id || batchId),
        name: String(rawBatch.name || rawBatch.title || `Batch ${batchId}`),
        thumbnail: String(rawBatch.thumbnail || "").trim(),
        displayPrice,
        important: Boolean(rawBatch.important),
      },
      folderId: folderId || null,
      folderTitle: currentFolderTitle,
      breadcrumbs,
      folders: pagedFolders,
      videos: pagedVideos,
      pdfs: pagedPdfs,
      links,
      pagination: {
        page,
        limit,
        totalFolders: rawFolders.length,
        totalVideos: rawVideos.length,
        totalPdfs: totalPdfsCount,
        hasMore:
          rawFolders.length > endOffset ||
          rawVideos.length > endOffset ||
          totalPdfsCount > endOffset,
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to load batch contents." },
      { status: 500 }
    );
  }
}
