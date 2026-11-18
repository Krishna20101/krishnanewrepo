import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import {
  DEFAULT_PURGE_OPTIONS,
  executeTelegramPurge,
  previewTelegramPurge,
  type TelegramPurgeOptions,
} from "@/lib/tgPurge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// ============================================================================
// 🧹 /api/admin/telegram/purge — "Telegram se aaya sab hata do"
// ----------------------------------------------------------------------------
// GET  → read-only preview (kitne courses/links/requests hatenge, kya safe hai)
// POST → execute. Body:
//   {
//     confirmText: "DELETE",          // ⚠️ zaroori — bina iske 400
//     options: { stripLinks, deleteTelegramNodes, deleteTelegramCourses,
//                clearGroupRegistry, clearRequests, clearEmbeds, clearBotState }
//   }
//
// SIRF Telegram-sourced data hat-ta hai. data/batches/*.json (real/original
// courses), manually uploaded courses, YouTube links, student accounts aur site
// settings KABHI touch nahi hote. File-backed course poora delete hi nahi hota.
// ============================================================================

const CONFIRM_WORD = "DELETE";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) return unauthorized();

  try {
    const preview = await previewTelegramPurge();
    return NextResponse.json({ ok: true, preview, defaults: DEFAULT_PURGE_OPTIONS });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to scan Telegram data.",
      },
      { status: 500 }
    );
  }
}

interface PostBody {
  confirmText?: string;
  options?: Partial<TelegramPurgeOptions>;
}

export async function POST(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as PostBody;
  const confirmText = String(body?.confirmText || "").trim();

  if (confirmText !== CONFIRM_WORD) {
    return NextResponse.json(
      {
        ok: false,
        error: `Type ${CONFIRM_WORD} in the confirmation box to run this destructive action.`,
      },
      { status: 400 }
    );
  }

  const requested = body?.options || {};
  const options: TelegramPurgeOptions = {
    stripLinks: Boolean(requested.stripLinks),
    deleteTelegramNodes: Boolean(requested.deleteTelegramNodes),
    deleteTelegramCourses: Boolean(requested.deleteTelegramCourses),
    clearGroupRegistry: Boolean(requested.clearGroupRegistry),
    clearRequests: Boolean(requested.clearRequests),
    clearEmbeds: Boolean(requested.clearEmbeds),
    clearBotState: Boolean(requested.clearBotState),
  };

  const nothingSelected = !Object.values(options).some(Boolean);
  if (nothingSelected) {
    return NextResponse.json(
      { ok: false, error: "Select at least one thing to delete." },
      { status: 400 }
    );
  }

  try {
    const result = await executeTelegramPurge(options);
    return NextResponse.json({ ok: result.ok, result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Telegram purge failed.",
      },
      { status: 500 }
    );
  }
}
