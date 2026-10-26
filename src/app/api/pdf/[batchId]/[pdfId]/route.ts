import { NextRequest, NextResponse } from "next/server";
import {
  findPdfNodeInBatch,
  getEffectiveRootNodes,
  loadSingleRawBatch,
} from "@/lib/batchEngine";
import { getEffectiveSiteSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { batchId: string; pdfId: string } }
) {
  try {
    const batchId = decodeURIComponent(params.batchId || "");
    const pdfId = decodeURIComponent(params.pdfId || "");

    const [rawBatch, settings] = await Promise.all([
      loadSingleRawBatch(batchId, { includeHidden: false }),
      getEffectiveSiteSettings(),
    ]);

    if (!rawBatch) {
      return NextResponse.json(
        { ok: false, error: "Course not found." },
        { status: 404 }
      );
    }

    const roots = getEffectiveRootNodes(rawBatch);
    const found = findPdfNodeInBatch(roots, pdfId);
    if (!found) {
      return NextResponse.json(
        { ok: false, error: "PDF item not found." },
        { status: 404 }
      );
    }

    const node = found.node;
    const title = String(node.title || node.name || "Class Notes PDF");
    const tgPdfToken = node.tg_pdf_token || "";
    const directPdfUrl =
      (node.pdf_url && node.pdf_url.startsWith("http") ? node.pdf_url : "") ||
      (String(node.type || "").toUpperCase() === "PDF" &&
      node.link &&
      node.link.startsWith("http")
        ? node.link
        : "");

    const workerBase = (settings.cloudflareStreamWorkerUrl || "")
      .trim()
      .replace(/\/$/, "");

    const directStreamUrl = tgPdfToken
      ? `/api/tg/stream/${encodeURIComponent(tgPdfToken)}`
      : directPdfUrl;

    let streamUrl = "";
    if (tgPdfToken) {
      streamUrl = workerBase
        ? `${workerBase}/stream/${encodeURIComponent(tgPdfToken)}`
        : directStreamUrl;
    } else if (directPdfUrl) {
      streamUrl = directPdfUrl;
    }

    return NextResponse.json({
      ok: true,
      batch: {
        id: String(rawBatch.id || batchId),
        name: String(rawBatch.name || rawBatch.title || "Course"),
      },
      pdf: {
        id: String(node.id),
        title,
        uploadedAt: String(node.uploaded_at || node.date || ""),
        fileSize: node.file_size || 0,
        hasRealPdf: Boolean(streamUrl),
        isTelegramChunked: Boolean(tgPdfToken),
        streamUrl,
        directStreamUrl,
      },
      folderTitle: found.folderTitle,
      folderId: found.folderId,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to load PDF metadata." },
      { status: 500 }
    );
  }
}
