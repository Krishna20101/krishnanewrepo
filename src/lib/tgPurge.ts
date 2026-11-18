import "server-only";
import fs from "fs";
import path from "path";
import { loadAllRawBatches } from "./batchEngine";
import {
  deleteBatchCompletely,
  deleteSyncedTelegramGroup,
  getAllVideoEmbeds,
  getSyncedTelegramGroups,
  invalidateServerCaches,
  isFileBackedBatch,
  saveCustomBatchDbOnly,
  saveVideoEmbed,
} from "./db";
import { rtChildren, rtRemove, rtSet } from "./rtStore";
import { BOT_STATE_PREFIX, TG_REQUEST_PREFIX } from "./botDelivery";

// ============================================================================
// 🧹 TELEGRAM PURGE (v6)
// ----------------------------------------------------------------------------
// Admin ka ek hi button: "Telegram se jo bhi aaya, wo sab hata do."
//
// SIRF Telegram-sourced cheezein hat-ti hain:
//   • node.tg_video_token / node.tg_pdf_token / pdf_link_enc === "tg_attached"
//   • sync se bane nodes (id: tgv_* / tgp_*)         [optional]
//   • sync se bane poore courses (source: telegram_auto_sync)  [optional]
//   • telegram_groups registry (synced group records)
//   • tg_requests/* (bot delivery deep-link records)
//   • Telegram-derived video_embeds entries
//   • bot_state/* (users/quota/stats) — config KABHI nahi hata
//
// KABHI NAHI chhota jata:
//   • data/batches/*.json (original scraped/real courses) — file-backed batch
//     poora delete hi nahi hota, sirf uske Telegram links strip hote hain
//   • manually uploaded courses / YouTube links / student accounts / settings
//   • bot config (username, limits) — wo settings hain, content nahi
//
// Do step me chalta hai: previewTelegramPurge() (read-only) → executeTelegramPurge()
// ============================================================================

export interface TelegramPurgeOptions {
  /** node.tg_video_token / tg_pdf_token / "tg_attached" hatao (structure rehti hai) */
  stripLinks: boolean;
  /** sync se bane nodes (tgv_* / tgp_*) poore hatao */
  deleteTelegramNodes: boolean;
  /** source:"telegram_auto_sync" wale poore courses delete karo (file-backed KABHI nahi) */
  deleteTelegramCourses: boolean;
  /** Admin Panel ki "Synced Telegram Groups" registry saaf karo */
  clearGroupRegistry: boolean;
  /** tg_requests/* (bot deep-link records) saaf karo */
  clearRequests: boolean;
  /** Telegram-derived video_embeds entries saaf karo */
  clearEmbeds: boolean;
  /** bot_state users/quota/stats/deletions/tasks/events saaf karo (config safe) */
  clearBotState: boolean;
}

export const DEFAULT_PURGE_OPTIONS: TelegramPurgeOptions = {
  stripLinks: true,
  deleteTelegramNodes: false,
  deleteTelegramCourses: false,
  clearGroupRegistry: true,
  clearRequests: true,
  clearEmbeds: true,
  clearBotState: false,
};

export interface TelegramCourseInfo {
  id: string;
  name: string;
  source: string;
  fileBacked: boolean;
  telegramVideos: number;
  telegramPdfs: number;
  syncNodes: number;
  totalNodes: number;
}

export interface TelegramPurgePreview {
  backendSafe: boolean;
  scannedCourses: number;
  /** courses jinka source telegram_auto_sync hai (poore delete ho sakte hain) */
  telegramCourses: TelegramCourseInfo[];
  /** courses jisme Telegram links hain (strip honge) */
  affectedCourses: TelegramCourseInfo[];
  nodesWithTelegramVideo: number;
  nodesWithTelegramPdf: number;
  nodesCreatedBySync: number;
  groupRegistryRecords: number;
  groupRegistrySample: string[];
  pendingRequests: number;
  telegramEmbedEntries: number;
  botUsers: number;
  botDeletionQueue: number;
  /** ye sab KABHI delete nahi hoga */
  protectedSummary: {
    fileBackedCourses: number;
    manualCourses: number;
    youtubeLinks: number;
    botConfigKept: boolean;
    studentAccountsKept: boolean;
    siteSettingsKept: boolean;
  };
  ranAt: string;
}

export interface TelegramPurgeResult extends TelegramPurgePreview {
  ok: boolean;
  applied: {
    coursesStripped: number;
    coursesDeleted: number;
    nodesStripped: number;
    nodesDeleted: number;
    groupRecordsDeleted: number;
    requestsDeleted: number;
    embedsDeleted: number;
    botUsersDeleted: number;
    botDeletionsDeleted: number;
  };
  errors: string[];
}

// ──────────────────────────────────────────────────────────── node walking
interface WalkStats {
  telegramVideos: number;
  telegramPdfs: number;
  syncNodes: number;
  totalNodes: number;
  youtubeLinks: number;
}

const TELEGRAM_NODE_ID = /^(tgv_|tgp_|tg_)/i;

/** cleanValue() is sentinel ko wapas karta hai jab node poora drop karna ho. */
const PURGE_DROP = Symbol("purge-drop");

function emptyStats(): WalkStats {
  return {
    telegramVideos: 0,
    telegramPdfs: 0,
    syncNodes: 0,
    totalNodes: 0,
    youtubeLinks: 0,
  };
}

function nodeHasTelegramMedia(node: Record<string, unknown>): boolean {
  return Boolean(
    node.tg_video_token ||
      node.tg_pdf_token ||
      String(node.pdf_link_enc || "") === "tg_attached"
  );
}

function nodeCreatedBySync(node: Record<string, unknown>): boolean {
  return TELEGRAM_NODE_ID.test(String(node.id || ""));
}

/** Read-only scan: kitne Telegram nodes/links hain. */
function walkStats(value: unknown, stats: WalkStats): void {
  if (Array.isArray(value)) {
    for (const item of value) walkStats(item, stats);
    return;
  }
  if (!value || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  const type = String(node.type || "").toUpperCase();
  if (type === "VIDEO" || type === "PDF" || type === "FOLDER" || type === "LINK") {
    stats.totalNodes += 1;
  }
  if (node.tg_video_token) stats.telegramVideos += 1;
  if (node.tg_pdf_token || String(node.pdf_link_enc || "") === "tg_attached") {
    stats.telegramPdfs += 1;
  }
  if (nodeCreatedBySync(node)) stats.syncNodes += 1;
  if (node.youtube_url || type === "LINK") stats.youtubeLinks += 1;

  for (const child of Object.values(node)) walkStats(child, stats);
}

/**
 * In-place clean: Telegram links strip (aur optional me sync-created nodes
 * poore hatao). Returns counts of what changed.
 */
function cleanValue(
  value: unknown,
  opts: { stripLinks: boolean; deleteNodes: boolean },
  out: { linksStripped: number; nodesDeleted: number }
): unknown {
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const cleaned = cleanValue(item, opts, out);
      if (cleaned === PURGE_DROP) continue;
      kept.push(cleaned);
    }
    return kept;
  }

  if (!value || typeof value !== "object") return value;

  const node = value as Record<string, unknown>;
  const looksLikeNode =
    typeof node.id !== "undefined" ||
    typeof node.type !== "undefined" ||
    typeof node.title !== "undefined";

  // sync se bana node → poora drop (sirf jab option on ho)
  if (
    opts.deleteNodes &&
    looksLikeNode &&
    nodeCreatedBySync(node) &&
    nodeHasTelegramMedia(node)
  ) {
    out.nodesDeleted += 1;
    return PURGE_DROP;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (opts.stripLinks) {
      if (key === "tg_video_token" || key === "tg_pdf_token") {
        if (val) out.linksStripped += 1;
        continue; // field hi hata do
      }
      if (key === "pdf_link_enc" && String(val || "") === "tg_attached") {
        out.linksStripped += 1;
        continue;
      }
      // media meta (chat/message ref) bhi Telegram ka hi hissa hai
      if (key === "tg_meta" || key === "tgMeta") continue;
    }
    const cleaned = cleanValue(val, opts, out);
    if (cleaned === PURGE_DROP) continue;
    copy[key] = cleaned;
  }
  return copy;
}

// ──────────────────────────────────────────────────────────── preview
export async function previewTelegramPurge(): Promise<TelegramPurgePreview> {
  const batches = await loadAllRawBatches({ includeHidden: true });

  const telegramCourses: TelegramCourseInfo[] = [];
  const affectedCourses: TelegramCourseInfo[] = [];
  let nodesWithTelegramVideo = 0;
  let nodesWithTelegramPdf = 0;
  let nodesCreatedBySync = 0;
  let fileBackedCourses = 0;
  let manualCourses = 0;
  let youtubeLinks = 0;

  for (const [id, batch] of batches.entries()) {
    const stats = emptyStats();
    walkStats(batch, stats);

    const source = String(batch.source || "json");
    const fileBacked = isFileBackedBatch(id);
    if (fileBacked) fileBackedCourses += 1;
    if (source !== "telegram_auto_sync" && !fileBacked) manualCourses += 1;
    youtubeLinks += stats.youtubeLinks;

    nodesWithTelegramVideo += stats.telegramVideos;
    nodesWithTelegramPdf += stats.telegramPdfs;
    nodesCreatedBySync += stats.syncNodes;

    const info: TelegramCourseInfo = {
      id,
      name: String(batch.name || batch.title || `Course ${id}`),
      source,
      fileBacked,
      telegramVideos: stats.telegramVideos,
      telegramPdfs: stats.telegramPdfs,
      syncNodes: stats.syncNodes,
      totalNodes: stats.totalNodes,
    };

    if (source === "telegram_auto_sync") telegramCourses.push(info);
    if (stats.telegramVideos > 0 || stats.telegramPdfs > 0 || stats.syncNodes > 0) {
      affectedCourses.push(info);
    }
  }

  const [groups, requests, embeds, botUsers, botDeletions] = await Promise.all([
    getSyncedTelegramGroups().catch(() => [] as Awaited<ReturnType<typeof getSyncedTelegramGroups>>),
    rtChildren<unknown>(TG_REQUEST_PREFIX, 8000).catch(() => ({})),
    getAllVideoEmbeds().catch(() => ({})),
    rtChildren<unknown>(`${BOT_STATE_PREFIX}/users`, 8000).catch(() => ({})),
    rtChildren<unknown>(`${BOT_STATE_PREFIX}/deletions`, 8000).catch(() => ({})),
  ]);

  const groupList = Array.isArray(groups) ? groups : Object.values(groups || {});
  const embedEntries = Object.values(embeds || {}).filter((e) => {
    const raw = String((e as { rawUrl?: string })?.rawUrl || "");
    return raw.includes("/api/tg/stream/") || raw.includes("tg_");
  });

  return {
    backendSafe: true,
    scannedCourses: batches.size,
    telegramCourses,
    affectedCourses,
    nodesWithTelegramVideo,
    nodesWithTelegramPdf,
    nodesCreatedBySync,
    groupRegistryRecords: groupList.length,
    groupRegistrySample: groupList
      .slice(0, 6)
      .map((g) => String((g as { title?: string })?.title || (g as { id?: string })?.id || "")),
    pendingRequests: Object.keys(requests || {}).length,
    telegramEmbedEntries: embedEntries.length,
    botUsers: Object.keys(botUsers || {}).length,
    botDeletionQueue: Object.keys(botDeletions || {}).length,
    protectedSummary: {
      fileBackedCourses,
      manualCourses,
      youtubeLinks,
      botConfigKept: true,
      studentAccountsKept: true,
      siteSettingsKept: true,
    },
    ranAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────── execute
export async function executeTelegramPurge(
  options: Partial<TelegramPurgeOptions>
): Promise<TelegramPurgeResult> {
  const opts: TelegramPurgeOptions = { ...DEFAULT_PURGE_OPTIONS, ...options };
  const base = await previewTelegramPurge();
  const errors: string[] = [];
  const applied = {
    coursesStripped: 0,
    coursesDeleted: 0,
    nodesStripped: 0,
    nodesDeleted: 0,
    groupRecordsDeleted: 0,
    requestsDeleted: 0,
    embedsDeleted: 0,
    botUsersDeleted: 0,
    botDeletionsDeleted: 0,
  };

  const batches = await loadAllRawBatches({ includeHidden: true });

  // ── 1. courses ────────────────────────────────────────────────────────────
  for (const [id, batch] of batches.entries()) {
    const source = String(batch.source || "json");
    const fileBacked = isFileBackedBatch(id);
    const stats = emptyStats();
    walkStats(batch, stats);
    const hasTelegramContent =
      stats.telegramVideos > 0 || stats.telegramPdfs > 0 || stats.syncNodes > 0;

    // (a) poora course delete — SIRF telegram_auto_sync + file-backed NAHI ho
    if (opts.deleteTelegramCourses && source === "telegram_auto_sync" && !fileBacked) {
      try {
        await deleteBatchCompletely(id);
        applied.coursesDeleted += 1;
      } catch (err) {
        errors.push(`course ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (fileBacked && source === "telegram_auto_sync") {
      // Safety: original file kabhi delete nahi — sirf links strip
      errors.push(
        `course ${id} is file-backed (real data) — skipped full delete, links stripped instead`
      );
    }

    if (!hasTelegramContent) continue;
    if (!opts.stripLinks && !opts.deleteTelegramNodes) continue;

    // (b) links strip / sync nodes drop → DB-only override (file untouched)
    try {
      const counters = { linksStripped: 0, nodesDeleted: 0 };
      const cleaned = cleanValue(
        batch as unknown as Record<string, unknown>,
        { stripLinks: opts.stripLinks, deleteNodes: opts.deleteTelegramNodes },
        counters
      ) as Record<string, unknown>;

      if (counters.linksStripped === 0 && counters.nodesDeleted === 0) continue;

      cleaned.purgedTelegramAt = new Date().toISOString();
      await saveCustomBatchDbOnly(id, cleaned);
      applied.coursesStripped += 1;
      applied.nodesStripped += counters.linksStripped;
      applied.nodesDeleted += counters.nodesDeleted;
    } catch (err) {
      errors.push(`course ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2. synced group registry ──────────────────────────────────────────────
  if (opts.clearGroupRegistry) {
    try {
      const groups = await getSyncedTelegramGroups();
      const list = Array.isArray(groups) ? groups : Object.values(groups || {});
      for (const g of list) {
        const gid = String((g as { id?: string })?.id || "");
        if (!gid) continue;
        await deleteSyncedTelegramGroup(gid);
        applied.groupRecordsDeleted += 1;
      }
    } catch (err) {
      errors.push(`group registry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 3. bot delivery requests ──────────────────────────────────────────────
  if (opts.clearRequests) {
    try {
      const requests = await rtChildren<unknown>(TG_REQUEST_PREFIX, 8000);
      for (const key of Object.keys(requests || {})) {
        await rtRemove(`${TG_REQUEST_PREFIX}/${key}`, 5000);
        applied.requestsDeleted += 1;
      }
    } catch (err) {
      errors.push(`tg_requests: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 4. telegram-derived video embeds ──────────────────────────────────────
  if (opts.clearEmbeds && base.telegramEmbedEntries > 0) {
    try {
      const embeds = await getAllVideoEmbeds();
      for (const [key, entry] of Object.entries(embeds || {})) {
        const raw = String((entry as { rawUrl?: string })?.rawUrl || "");
        if (!raw.includes("/api/tg/stream/") && !raw.includes("tg_")) continue;
        const batchId = String((entry as { batchId?: string })?.batchId || "");
        const videoId = String((entry as { videoId?: string })?.videoId || "");
        if (batchId && videoId) {
          // saveVideoEmbed({rawUrl:""}) = delete path
          await saveVideoEmbed({ batchId, videoId, rawUrl: "" });
          applied.embedsDeleted += 1;
        } else if (key) {
          await rtRemove(`video_embeds/${key}`, 5000);
          applied.embedsDeleted += 1;
        }
      }
    } catch (err) {
      errors.push(`video_embeds: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 5. bot state (users / quota / stats) — config KABHI nahi ──────────────
  if (opts.clearBotState) {
    for (const sub of ["users", "deletions", "stats", "tasks", "events"]) {
      try {
        const rows = await rtChildren<unknown>(`${BOT_STATE_PREFIX}/${sub}`, 8000);
        for (const key of Object.keys(rows || {})) {
          await rtRemove(`${BOT_STATE_PREFIX}/${sub}/${key}`, 5000);
          if (sub === "users") applied.botUsersDeleted += 1;
          if (sub === "deletions") applied.botDeletionsDeleted += 1;
        }
        if (Object.keys(rows || {}).length === 0) {
          await rtRemove(`${BOT_STATE_PREFIX}/${sub}`, 5000);
        }
      } catch (err) {
        errors.push(`bot_state/${sub}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  invalidateServerCaches();

  // ── 6. audit log ─────────────────────────────────────────────────────────
  try {
    await rtSet(
      `admin_logs/telegram_purge/${Date.now()}`,
      {
        at: new Date().toISOString(),
        options: opts,
        applied,
        errors: errors.slice(0, 20),
      },
      6000
    );
  } catch {
    // audit log fail ho to purge ko fail nahi maanna
  }

  const after = await previewTelegramPurge();

  return {
    ...after,
    ok: errors.length === 0,
    applied,
    errors,
  };
}

/** Chhota helper: repo me kahin aur Telegram-sourced batch pehchanna ho. */
export function listTelegramBatchFiles(): string[] {
  try {
    const dir = path.join(process.cwd(), "data", "batches");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .filter((f) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          return String(parsed.source || "") === "telegram_auto_sync";
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
