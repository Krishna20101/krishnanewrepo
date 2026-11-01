import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import { loadAllRawBatches } from "@/lib/batchEngine";
import {
  BatchOrderMeta,
  deleteBatchCompletely,
  getAllBatchOrderMeta,
  saveAllBatchOrderMeta,
  saveCustomUploadedBatch,
} from "@/lib/db";

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

    // Case 1: Create a brand new empty batch
    if (body?.action === "CREATE_BATCH") {
      const name = String(body.name || "").trim();
      if (!name) {
        return NextResponse.json(
          { ok: false, error: "Course name is required." },
          { status: 400 }
        );
      }
      const id = String(body.id || `batch_${Date.now()}`).trim();
      const newBatch = {
        source: "shd_admin_created",
        id,
        name,
        price: String(body.price ?? "999").trim(),
        thumbnail: String(body.thumbnail || "").trim(),
        hidden: Boolean(body.hidden),
        important: Boolean(body.important),
        created_at: new Date().toISOString(),
        tree: [],
        videos: [],
      };
      await saveCustomUploadedBatch(id, newBatch);
      return NextResponse.json({ ok: true, batchId: id, name });
    }

    // Case 2: Toggle ⭐ Important Star on a Course (Always pins to top!)
    if (body?.action === "TOGGLE_IMPORTANT_BATCH") {
      const id = String(body.id || "").trim();
      if (!id) {
        return NextResponse.json(
          { ok: false, error: "Batch ID is required." },
          { status: 400 }
        );
      }
      const batchesMap = await loadAllRawBatches({ includeHidden: true });
      const existing = batchesMap.get(id);
      if (!existing) {
        return NextResponse.json(
          { ok: false, error: "Batch not found." },
          { status: 404 }
        );
      }

      const nextImportant =
        body.important !== undefined
          ? Boolean(body.important)
          : !existing.important;

      const metaMap = await getAllBatchOrderMeta();
      const safeId = id.replace(/[.#$[\]/]/g, "_");
      metaMap[safeId] = {
        ...(metaMap[safeId] || metaMap[id] || {}),
        important: nextImportant,
        sortOrder:
          typeof existing.sort_order === "number" ? existing.sort_order : 1,
      };
      await saveAllBatchOrderMeta(metaMap);

      return NextResponse.json({
        ok: true,
        batchId: id,
        important: nextImportant,
      });
    }

    // Case 3: Move Course UP / DOWN / TOP / BOTTOM / Exact #Position (1, 2, 3...)
    if (body?.action === "REORDER_BATCH") {
      const id = String(body.id || "").trim();
      const direction = String(body.direction || "UP").toUpperCase();
      const exactPosition =
        body.position !== undefined ? Number(body.position) : undefined;

      const batchesMap = await loadAllRawBatches({ includeHidden: true });
      const orderedIds = Array.from(batchesMap.keys());
      const idx = orderedIds.indexOf(id);
      if (idx === -1) {
        return NextResponse.json(
          { ok: false, error: "Batch not found." },
          { status: 404 }
        );
      }

      let targetIdx = idx;
      if (exactPosition !== undefined && !Number.isNaN(exactPosition)) {
        targetIdx = Math.max(
          0,
          Math.min(orderedIds.length - 1, exactPosition - 1)
        );
      } else if (direction === "UP") {
        targetIdx = Math.max(0, idx - 1);
      } else if (direction === "DOWN") {
        targetIdx = Math.min(orderedIds.length - 1, idx + 1);
      } else if (direction === "TOP") {
        targetIdx = 0;
      } else if (direction === "BOTTOM") {
        targetIdx = orderedIds.length - 1;
      }

      const copy = [...orderedIds];
      const [moved] = copy.splice(idx, 1);
      copy.splice(targetIdx, 0, moved);

      const currentMeta = await getAllBatchOrderMeta();
      const nextMeta: Record<string, BatchOrderMeta> = { ...currentMeta };

      copy.forEach((bid, i) => {
        const safeKey = bid.replace(/[.#$[\]/]/g, "_");
        const b = batchesMap.get(bid);
        nextMeta[safeKey] = {
          important: Boolean(
            currentMeta[safeKey]?.important ??
              currentMeta[bid]?.important ??
              b?.important
          ),
          sortOrder: i + 1,
        };
      });

      await saveAllBatchOrderMeta(nextMeta);
      return NextResponse.json({ ok: true, batchId: id });
    }

    // Case 4: Update metadata (name, price, thumbnail, hidden, important)
    if (body?.action === "UPDATE_BATCH_META") {
      const id = String(body.id || "").trim();
      if (!id) {
        return NextResponse.json(
          { ok: false, error: "Batch ID is required." },
          { status: 400 }
        );
      }
      const batchesMap = await loadAllRawBatches({ includeHidden: true });
      const existing = batchesMap.get(id);
      if (!existing) {
        return NextResponse.json(
          { ok: false, error: "Batch not found." },
          { status: 404 }
        );
      }
      const updated = {
        ...existing,
        ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
        ...(body.price !== undefined
          ? { price: String(body.price).trim() }
          : {}),
        ...(body.thumbnail !== undefined
          ? { thumbnail: String(body.thumbnail).trim() }
          : {}),
        ...(body.hidden !== undefined ? { hidden: Boolean(body.hidden) } : {}),
        ...(body.important !== undefined
          ? { important: Boolean(body.important) }
          : {}),
      };
      await saveCustomUploadedBatch(id, updated as Record<string, unknown>);
      return NextResponse.json({ ok: true, batchId: id });
    }

    // Case 5: Upload full JSON batch object
    const batchData = body?.batchJson;
    if (!batchData || typeof batchData !== "object") {
      return NextResponse.json(
        { ok: false, error: "Valid JSON batch object is required." },
        { status: 400 }
      );
    }

    const id = String(batchData.id || `custom_${Date.now()}`).trim();
    const normalized = {
      ...batchData,
      id,
      name: batchData.name || batchData.title || `Batch ${id}`,
    };

    await saveCustomUploadedBatch(id, normalized);

    return NextResponse.json({
      ok: true,
      batchId: id,
      name: normalized.name,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to save batch." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Missing id" },
      { status: 400 }
    );
  }

  await deleteBatchCompletely(id);
  return NextResponse.json({ ok: true });
}
