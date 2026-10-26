import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import { formatBatchSummary, loadAllRawBatches } from "@/lib/batchEngine";
import {
  getAdminSavedUserLogins,
  getAllVideoEmbeds,
  getEffectiveSiteSettings,
  getLastDbError,
  getTelegramVaultCredentials,
} from "@/lib/db";
import {
  getFirebaseMode,
  getParsedFirebaseAdminConfig,
} from "@/config/firebaseConfig";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const [batchesMap, embeds, logins, settings, tgCreds] = await Promise.all([
    loadAllRawBatches({ includeHidden: true }),
    getAllVideoEmbeds(),
    getAdminSavedUserLogins(),
    getEffectiveSiteSettings(),
    getTelegramVaultCredentials(),
  ]);

  const embedKeys = new Set(Object.keys(embeds));
  const batches = Array.from(batchesMap.values()).map((b) =>
    formatBatchSummary(b, embedKeys)
  );

  const totalFolders = batches.reduce((acc, b) => acc + b.totalFolders, 0);
  const totalVideos = batches.reduce((acc, b) => acc + b.totalVideos, 0);
  const totalLinkedVideos = batches.reduce((acc, b) => acc + b.linkedVideos, 0);
  const totalPdfs = batches.reduce((acc, b) => acc + b.totalPdfs, 0);
  const hiddenBatches = batches.filter((b) => b.hidden).length;

  const parsedCfg = getParsedFirebaseAdminConfig();

  return NextResponse.json({
    ok: true,
    firebaseMode: getFirebaseMode(),
    databaseURL: parsedCfg.databaseURL || "",
    lastDbError: getLastDbError(),
    telegramConfigured: Boolean(
      tgCreds?.apiId && tgCreds?.apiHash && tgCreds?.sessionString
    ),
    envAdminConfigured: Boolean(
      process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ),
    stats: {
      totalBatches: batches.length,
      hiddenBatches,
      totalFolders,
      totalVideos,
      linkedVideos: totalLinkedVideos,
      totalPdfs,
      savedLogins: logins.length,
    },
    batches,
    settings,
  });
}
