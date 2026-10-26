import { NextResponse } from "next/server";
import { formatBatchSummary, loadAllRawBatches } from "@/lib/batchEngine";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const batchesMap = await loadAllRawBatches({ includeHidden: false });
    const batches = Array.from(batchesMap.values()).map((b) =>
      formatBatchSummary(b)
    );

    return NextResponse.json({
      ok: true,
      total: batches.length,
      batches,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to load batches." },
      { status: 500 }
    );
  }
}
