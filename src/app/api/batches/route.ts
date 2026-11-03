import { NextRequest, NextResponse } from "next/server";
import { formatBatchSummary, loadAllRawBatches } from "@/lib/batchEngine";
import { isContentRequestAuthorized } from "@/lib/studentAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 🔐 Login ke bina content nahi (student session ya admin session)
  if (!isContentRequestAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Please login to continue." },
      { status: 401 }
    );
  }

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
