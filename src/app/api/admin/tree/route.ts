import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import {
  addNodeToTree,
  deleteNodeFromTree,
  findFolderWithBreadcrumbs,
  formatBatchSummary,
  getEffectiveRootNodes,
  loadSingleRawBatch,
  moveNodeInTree,
  RawBatchNode,
  setEffectiveRootNodes,
  sortNodesByImportanceAndOrder,
  toCleanNodeItem,
  updateNodeInTree,
} from "@/lib/batchEngine";
import {
  getAllVideoEmbeds,
  saveCustomUploadedBatch,
  saveVideoEmbed,
} from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const batchId = req.nextUrl.searchParams.get("batchId");
  const folderId = req.nextUrl.searchParams.get("folderId");
  const wantExport = req.nextUrl.searchParams.get("export") === "1";

  if (!batchId) {
    return NextResponse.json(
      { ok: false, error: "batchId is required" },
      { status: 400 }
    );
  }

  const rawBatch = await loadSingleRawBatch(batchId, { includeHidden: true });
  if (!rawBatch) {
    return NextResponse.json(
      { ok: false, error: "Batch not found" },
      { status: 404 }
    );
  }

  if (wantExport) {
    return NextResponse.json({
      ok: true,
      batchJson: rawBatch,
    });
  }

  const embedsMap = await getAllVideoEmbeds();
  const embedKeys = new Set(Object.keys(embedsMap));
  const summary = formatBatchSummary(rawBatch, embedKeys);
  const rootNodes = getEffectiveRootNodes(rawBatch);

  let activeNodes = rootNodes;
  let currentFolderTitle = summary.name;
  let breadcrumbs: Array<{ id: string; title: string }> = [];

  if (folderId) {
    const found = findFolderWithBreadcrumbs(rootNodes, folderId);
    if (!found) {
      return NextResponse.json(
        { ok: false, error: "Folder not found" },
        { status: 404 }
      );
    }
    activeNodes = found.folder.children || [];
    currentFolderTitle = String(
      found.folder.title || found.folder.name || "Folder"
    );
    breadcrumbs = found.breadcrumbs;
  }

  const sortedNodes = sortNodesByImportanceAndOrder(activeNodes);
  const cleanItems = sortedNodes.map((n) =>
    toCleanNodeItem(n, embedsMap, batchId)
  );

  return NextResponse.json({
    ok: true,
    batch: summary,
    folderId: folderId || null,
    folderTitle: currentFolderTitle,
    breadcrumbs,
    items: cleanItems,
    folders: cleanItems.filter((i) => i.type === "FOLDER"),
    videos: cleanItems.filter((i) => i.type === "VIDEO"),
    pdfs: cleanItems.filter((i) => i.type === "PDF"),
    links: cleanItems.filter((i) => i.type === "LINK"),
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
    const action = String(body?.action || "");
    const batchId = String(body?.batchId || "").trim();

    if (!batchId) {
      return NextResponse.json(
        { ok: false, error: "batchId is required" },
        { status: 400 }
      );
    }

    const rawBatch = await loadSingleRawBatch(batchId, { includeHidden: true });
    if (!rawBatch) {
      return NextResponse.json(
        { ok: false, error: "Batch not found" },
        { status: 404 }
      );
    }

    let roots = getEffectiveRootNodes(rawBatch);

    if (action === "ADD_NODE") {
      const parentFolderId = body?.parentFolderId
        ? String(body.parentFolderId)
        : null;
      const nodeType = String(body?.nodeType || "FOLDER").toUpperCase();
      const title = String(body?.title || "").trim();
      const thumbnail = String(body?.thumbnail || "").trim();
      const uploadedAt = String(body?.uploadedAt || "").trim();
      const linkUrl = String(body?.link || "").trim();
      const youtubeUrl = String(body?.youtubeUrl || "").trim();

      if (!title) {
        return NextResponse.json(
          { ok: false, error: "Title is required." },
          { status: 400 }
        );
      }

      const newId = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const newNode: RawBatchNode = {
        id: newId,
        parent_id: parentFolderId || "-1",
        title,
        type: nodeType,
        thumbnail,
        important: Boolean(body?.important),
        uploaded_at:
          uploadedAt ||
          new Date().toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          }),
        videos_count: 0,
        files_count: 0,
        ...(nodeType === "FOLDER" ? { children: [] } : {}),
        ...(nodeType === "VIDEO" ? { pdf_link_enc: "notes_placeholder" } : {}),
        ...(nodeType === "PDF"
          ? { pdf_link_enc: "pdf_placeholder", pdf_url: linkUrl || undefined }
          : {}),
        ...(nodeType === "LINK" ? { link: linkUrl } : {}),
      };

      roots = addNodeToTree(roots, parentFolderId, newNode);
      const updatedBatch = setEffectiveRootNodes(rawBatch, roots);
      await saveCustomUploadedBatch(
        batchId,
        updatedBatch as Record<string, unknown>
      );

      if (nodeType === "VIDEO" && youtubeUrl) {
        await saveVideoEmbed({
          batchId,
          videoId: newId,
          title,
          rawUrl: youtubeUrl,
        });
      }

      return NextResponse.json({ ok: true, nodeId: newId });
    }

    if (action === "UPDATE_NODE") {
      const nodeId = String(body?.nodeId || "");
      if (!nodeId) {
        return NextResponse.json(
          { ok: false, error: "nodeId is required" },
          { status: 400 }
        );
      }

      const updates: Partial<RawBatchNode> = {};
      if (body.title !== undefined) updates.title = String(body.title).trim();
      if (body.thumbnail !== undefined)
        updates.thumbnail = String(body.thumbnail).trim();
      if (body.uploadedAt !== undefined)
        updates.uploaded_at = String(body.uploadedAt).trim();
      if (body.link !== undefined) {
        updates.link = String(body.link).trim();
        updates.pdf_url = String(body.link).trim();
      }
      if (body.important !== undefined) {
        updates.important = Boolean(body.important);
      }

      roots = updateNodeInTree(roots, nodeId, updates);
      const updatedBatch = setEffectiveRootNodes(rawBatch, roots);
      await saveCustomUploadedBatch(
        batchId,
        updatedBatch as Record<string, unknown>
      );

      return NextResponse.json({ ok: true });
    }

    if (action === "TOGGLE_IMPORTANT") {
      const nodeId = String(body?.nodeId || "");
      if (!nodeId) {
        return NextResponse.json(
          { ok: false, error: "nodeId is required" },
          { status: 400 }
        );
      }
      const nextVal = Boolean(body?.important);
      roots = updateNodeInTree(roots, nodeId, { important: nextVal });
      const updatedBatch = setEffectiveRootNodes(rawBatch, roots);
      await saveCustomUploadedBatch(
        batchId,
        updatedBatch as Record<string, unknown>
      );
      return NextResponse.json({ ok: true, important: nextVal });
    }

    if (action === "DELETE_NODE") {
      const nodeId = String(body?.nodeId || "");
      if (!nodeId) {
        return NextResponse.json(
          { ok: false, error: "nodeId is required" },
          { status: 400 }
        );
      }
      roots = deleteNodeFromTree(roots, nodeId);
      const updatedBatch = setEffectiveRootNodes(rawBatch, roots);
      await saveCustomUploadedBatch(
        batchId,
        updatedBatch as Record<string, unknown>
      );
      return NextResponse.json({ ok: true });
    }

    if (action === "MOVE_NODE") {
      const nodeId = String(body?.nodeId || "");
      const rawDir = String(body?.direction || "UP").toUpperCase();
      const direction: "UP" | "DOWN" | "TOP" | "BOTTOM" =
        rawDir === "DOWN" || rawDir === "TOP" || rawDir === "BOTTOM"
          ? rawDir
          : "UP";
      const exactPosition =
        body?.position !== undefined ? Number(body.position) : undefined;

      roots = moveNodeInTree(roots, nodeId, direction, exactPosition);
      const updatedBatch = setEffectiveRootNodes(rawBatch, roots);
      await saveCustomUploadedBatch(
        batchId,
        updatedBatch as Record<string, unknown>
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { ok: false, error: "Unknown tree action." },
      { status: 400 }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to update batch tree." },
      { status: 500 }
    );
  }
}
