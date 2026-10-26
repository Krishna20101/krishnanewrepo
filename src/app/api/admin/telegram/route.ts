import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import {
  deleteBatchCompletely,
  deleteSyncedTelegramGroup,
  getSyncedTelegramGroups,
  getTelegramVaultCredentials,
  saveCustomUploadedBatch,
  saveSyncedTelegramGroup,
  saveTelegramVaultCredentials,
} from "@/lib/db";
import {
  formatTelegramError,
  invalidateCachedTelegramCreds,
  normalizeChatInput,
  scanTelegramGroupMedia,
  verifyTelegramCredentialsEphemeral,
} from "@/lib/tgClient";
import {
  buildStructuredCourseFromTelegram,
  mergeTelegramItemsIntoExistingBatch,
  parseScannedTelegramItem,
} from "@/lib/tgParser";
import { loadAllRawBatches } from "@/lib/batchEngine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const [creds, syncedGroups] = await Promise.all([
    getTelegramVaultCredentials(),
    getSyncedTelegramGroups(),
  ]);

  return NextResponse.json({
    ok: true,
    credentialsConfigured: Boolean(
      creds?.apiId && creds?.apiHash && creds?.sessionString
    ),
    botConfigured: Boolean(creds?.botToken && creds.botToken.trim()),
    maskedApiId: creds?.apiId ? `${String(creds.apiId).slice(0, 3)}•••••` : "",
    syncedGroups,
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

    // 1. Save & Verify Telegram Credentials (Ephemeral connect -> immediate disconnect!)
    if (action === "SAVE_CREDENTIALS") {
      const existing = await getTelegramVaultCredentials();

      const rawApiId = String(body?.apiId || "").trim();
      const apiId = rawApiId ? parseInt(rawApiId, 10) : existing?.apiId || 0;
      const apiHash =
        String(body?.apiHash || "").trim() || existing?.apiHash || "";
      const sessionString =
        String(body?.sessionString || "").trim() ||
        existing?.sessionString ||
        "";
      const rawBot = String(body?.botToken || "").trim();
      const botToken =
        rawBot === "CLEAR" ? "" : rawBot || existing?.botToken || "";

      if (Number.isNaN(apiId) || apiId <= 0 || !apiHash || !sessionString) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Valid API ID, API Hash, and Session String are required.",
          },
          { status: 400 }
        );
      }

      const verified = await verifyTelegramCredentialsEphemeral({
        apiId,
        apiHash,
        sessionString,
        botToken,
      });

      await saveTelegramVaultCredentials({
        apiId,
        apiHash,
        sessionString,
        botToken,
      });
      invalidateCachedTelegramCreds();

      return NextResponse.json({
        ok: true,
        message: `Connected & AES-256 Encrypted! User: ${
          verified.accountLabel
        }${
          verified.botUsername
            ? ` • Stream Bot Active (${verified.botUsername} — Zero IP Collision!)`
            : " (Disconnected cleanly after check)"
        }`,
      });
    }

    // 2. Scan Telegram Group & Execute ADD_NEW / MERGE_JSON / BOTH!
    if (action === "SYNC_GROUP") {
      const existing = await getTelegramVaultCredentials();
      const inlineApiId = parseInt(String(body?.apiId || "").trim(), 10);
      const inlineApiHash = String(body?.apiHash || "").trim();
      const inlineSession = String(body?.sessionString || "").trim();
      const inlineBot = String(body?.botToken || "").trim();

      if (
        (!Number.isNaN(inlineApiId) && inlineApiId > 0) ||
        inlineApiHash ||
        inlineSession ||
        inlineBot
      ) {
        const mergedCreds = {
          apiId:
            !Number.isNaN(inlineApiId) && inlineApiId > 0
              ? inlineApiId
              : existing?.apiId || 0,
          apiHash: inlineApiHash || existing?.apiHash || "",
          sessionString: inlineSession || existing?.sessionString || "",
          botToken: inlineBot || existing?.botToken || "",
        };
        if (
          mergedCreds.apiId > 0 &&
          mergedCreds.apiHash &&
          mergedCreds.sessionString
        ) {
          await saveTelegramVaultCredentials(mergedCreds);
          invalidateCachedTelegramCreds();
        }
      }

      const chatInput = String(body?.chatInput || "").trim();
      if (!chatInput) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Please enter Telegram Group Username or Group ID (-100...).",
          },
          { status: 400 }
        );
      }

      const rawMode = String(body?.syncMode || "ADD_NEW").toUpperCase();
      const syncMode: "ADD_NEW" | "MERGE_JSON" | "BOTH" =
        rawMode === "MERGE_JSON" || rawMode === "BOTH" ? rawMode : "ADD_NEW";

      const targetBatchId = String(body?.targetBatchId || "").trim();
      const customCourseTitle = String(body?.customCourseTitle || "").trim();
      const customCoursePrice = String(body?.customCoursePrice ?? "0").trim();
      const customThumbnail = String(body?.customThumbnail || "").trim();
      const messageLimit = Math.min(
        5000,
        Math.max(50, Number(body?.messageLimit) || 1500)
      );

      // Scans group & immediately disconnects user session in `finally`!
      const scanned = await scanTelegramGroupMedia({
        chatInput,
        limit: messageLimit,
      });

      if (scanned.items.length === 0) {
        // Record phir bhi save karo taaki group list me dikhe (status: error)
        try {
          await saveSyncedTelegramGroup({
            id: `grp_${normalizeChatInput(chatInput).replace(
              /[^a-zA-Z0-9_-]/g,
              "_"
            )}`,
            chatInput: scanned.canonicalChatId,
            title: scanned.groupTitle,
            syncMode,
            targetBatchId: targetBatchId || undefined,
            videosSynced: 0,
            pdfsSynced: 0,
            lastSyncedAt: new Date().toISOString(),
            syncStatus: "error",
            lastSyncMessage:
              "Is group me koi Video/PDF nahi mila. Check karein: (1) account group ka member hai? (2) Max Messages limit badhayein? (3) group username sahi hai?",
          });
        } catch {
          // ignore
        }

        return NextResponse.json(
          {
            ok: false,
            error:
              "No Videos or PDFs found in this group! Check that your Telegram account is a member of this group. (Max Messages limit badha kar dubara try karein.)",
          },
          { status: 400 }
        );
      }

      const parsedItems = scanned.items.map((it) =>
        parseScannedTelegramItem(
          it,
          customCourseTitle || scanned.groupTitle
        )
      );

      const totalVideosFound = parsedItems.filter(
        (x) => x.kind === "VIDEO" && x.hasMediaFile !== false
      ).length;
      const totalPdfsFound = parsedItems.filter((x) => x.kind === "PDF").length;
      const youtubeOnlyCount = parsedItems.filter(
        (x) => x.kind === "VIDEO" && x.hasMediaFile === false
      ).length;

      let createdBatchId = "";
      let createdCourseName = "";
      let mergedVideosCount = 0;
      let mergedPdfsCount = 0;
      const mergedBatchNames: string[] = [];
      const problems: string[] = [];

      // ⚠️ Record ID ab group ke naam par stable hai (mode se change nahi hota),
      //    isliye ADD_NEW / MERGE_JSON / BOTH — koi bhi mode ho, ye group
      //    neeche "Synced Telegram Groups" list me HAMESHA dikhega.
      const groupRecordId =
        String(body?.syncRecordId || "").trim() ||
        `grp_${normalizeChatInput(scanned.canonicalChatId).replace(
          /[^a-zA-Z0-9_-]/g,
          "_"
        )}`;

      /** Har haal me record save hoga (success ho ya partial fail) */
      const persistRecord = async (
        status: "ok" | "partial" | "error",
        message: string
      ) => {
        try {
          await saveSyncedTelegramGroup({
            id: groupRecordId,
            chatInput: scanned.canonicalChatId,
            title: createdCourseName || scanned.groupTitle,
            syncMode,
            targetBatchId: targetBatchId || undefined,
            createdBatchId: createdBatchId || undefined,
            videosSynced: totalVideosFound,
            pdfsSynced: totalPdfsFound,
            lastSyncedAt: new Date().toISOString(),
            syncStatus: status,
            lastSyncMessage: message,
            mergedVideosCount,
            mergedPdfsCount,
            youtubeOnlyCount,
          });
        } catch {
          // record save fail ho jaye to bhi response bhejna zaroori hai
        }
      };

      // ---------------------------------------------------------------- MODE 1
      if (syncMode === "ADD_NEW" || syncMode === "BOTH") {
        try {
          const cleanSlug = normalizeChatInput(scanned.canonicalChatId).replace(
            /[^a-zA-Z0-9_-]/g,
            ""
          );
          createdBatchId =
            String(body?.existingCreatedBatchId || "").trim() ||
            `tg_${cleanSlug || Date.now()}`;

          const structuredBatch = buildStructuredCourseFromTelegram({
            batchId: createdBatchId,
            courseTitle: customCourseTitle || scanned.groupTitle || undefined,
            price: customCoursePrice || "0",
            thumbnail: customThumbnail || undefined,
            items: parsedItems,
          });

          createdCourseName =
            structuredBatch.name || structuredBatch.title || scanned.groupTitle;
          await saveCustomUploadedBatch(
            createdBatchId,
            structuredBatch as unknown as Record<string, unknown>
          );
        } catch (err) {
          problems.push(
            `Course save error: ${
              err instanceof Error ? err.message.slice(0, 120) : "unknown"
            }`
          );
        }
      }

      // ---------------------------------------------------------------- MODE 2
      if (syncMode === "MERGE_JSON" || syncMode === "BOTH") {
        try {
          const allBatchesMap = await loadAllRawBatches({ includeHidden: true });
          const candidateBatches = Array.from(allBatchesMap.values())
            .filter((b) => {
              const bid = String(b.id || "");
              if (bid === createdBatchId) return false;
              if (targetBatchId && targetBatchId !== "AUTO") {
                return bid === targetBatchId;
              }
              return !bid.startsWith("tg_");
            })
            // Sirf 60 batches par merge chalao (Vercel time-limit safe)
            .slice(0, 60);

          if (candidateBatches.length === 0) {
            problems.push(
              "Merge ke liye koi JSON course nahi mila — pehle Courses Studio me JSON import karein ya target course chunein."
            );
          }

          for (const candidate of candidateBatches) {
            const cid = String(candidate.id);
            try {
              const mergeRes = mergeTelegramItemsIntoExistingBatch(
                candidate,
                parsedItems
              );
              if (mergeRes.matchedVideos > 0 || mergeRes.matchedPdfs > 0) {
                await saveCustomUploadedBatch(
                  cid,
                  mergeRes.updatedBatch as unknown as Record<string, unknown>
                );
                mergedVideosCount += mergeRes.matchedVideos;
                mergedPdfsCount += mergeRes.matchedPdfs;
                mergedBatchNames.push(
                  candidate.name || candidate.title || `Batch ${cid}`
                );
              }
            } catch (err) {
              problems.push(
                `${candidate.name || cid}: ${
                  err instanceof Error ? err.message.slice(0, 80) : "merge fail"
                }`
              );
            }
          }

          if (
            candidateBatches.length > 0 &&
            mergedVideosCount === 0 &&
            mergedPdfsCount === 0
          ) {
            problems.push(
              "Kisi bhi JSON course me matching lecture nahi mila (title/batch naam alag ho sakta hai). Target Course dropdown se exact course chun kar dubara Merge chalayein."
            );
          }
        } catch (err) {
          problems.push(
            `Merge scan error: ${
              err instanceof Error ? err.message.slice(0, 120) : "unknown"
            }`
          );
        }
      }

      // ------------------------------------------------- ALWAYS save the record
      const summaryParts: string[] = [];
      if (createdBatchId) summaryParts.push(`Course ready: ${createdCourseName}`);
      if (mergedVideosCount || mergedPdfsCount) {
        summaryParts.push(
          `Merged ${mergedVideosCount} videos + ${mergedPdfsCount} PDFs into ${mergedBatchNames.length} course(s)`
        );
      }
      if (youtubeOnlyCount) {
        summaryParts.push(
          `${youtubeOnlyCount} YouTube-link lectures auto-embedded`
        );
      }
      const status: "ok" | "partial" | "error" =
        problems.length === 0
          ? "ok"
          : summaryParts.length > 0
          ? "partial"
          : "error";

      await persistRecord(
        status,
        [...summaryParts, ...problems].join(" | ") || "Sync completed."
      );

      return NextResponse.json({
        ok: status !== "error",
        partial: status === "partial",
        groupTitle: scanned.groupTitle,
        videosFound: totalVideosFound,
        pdfsFound: totalPdfsFound,
        youtubeOnlyCount,
        createdBatchId,
        createdCourseName,
        mergedVideosCount,
        mergedPdfsCount,
        mergedBatchNames,
        problems,
        syncRecordId: groupRecordId,
        message: [...summaryParts, ...problems].join(" | "),
      });
    }

    // Course (JSON) hatao — "jo add kiya tha wapas hatana hai"
    if (action === "DELETE_COURSE") {
      const batchId = String(body?.batchId || "").trim();
      const recordId = String(body?.syncRecordId || "").trim();
      if (batchId) {
        await deleteBatchCompletely(batchId);
      }
      if (recordId) {
        const groups = await getSyncedTelegramGroups();
        const rec = groups.find((g) => g.id === recordId);
        if (rec) {
          await saveSyncedTelegramGroup({
            ...rec,
            createdBatchId: undefined,
            syncStatus: "partial",
            lastSyncMessage: `Course ${batchId} delete kar diya gaya.`,
            lastSyncedAt: new Date().toISOString(),
          });
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_SYNC_RECORD") {
      const id = String(body?.id || "");
      if (id) await deleteSyncedTelegramGroup(id);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { ok: false, error: "Unknown Telegram action." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatTelegramError(err) },
      { status: 500 }
    );
  }
}
