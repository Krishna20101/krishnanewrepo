import "server-only";
import crypto from "crypto";
import { cleanEnv } from "@/config/firebaseConfig";
import { getEffectiveSiteSettings, SiteDynamicSettings } from "@/lib/db";
import { rtChildren, rtGet, rtRemove, rtSet, getRtBackend } from "@/lib/rtStore";
import { verifyTelegramMediaToken } from "@/lib/tgCrypto";
import { buildTopicPath } from "@/lib/tgMatch";

// ============================================================================
// 🤖 TELEGRAM BOT DELIVERY BRIDGE  (website ⇄ python bot)
// ----------------------------------------------------------------------------
// Watch page par video player ki jagah ab ▶ OPEN IN TELEGRAM button hai.
// Ye module:
//   1) `tg_requests/<shortId>` record banata hai (kis video ko bhejna hai)
//   2) deep-link deta hai → https://t.me/<botUsername>?start=<shortId>
//   3) bot ke state (config/users/stats/tasks/heartbeat) ko admin panel ke liye
//      padhta-likhta hai
//
// Python bot (telegram-bot/bot.py) SAME paths padhta hai → dono ek state share
// karte hain. Firebase RTDB na ho to local fallback (sirf dev ke liye).
// ============================================================================

export const BOT_STATE_PREFIX = "bot_state";
export const TG_REQUEST_PREFIX = "tg_requests";

export interface BotConfig {
  dailyLimit: number;
  quotaWindowHours: number;
  autoDeleteHours: number;
  creditUsername: string;
  contactUsername: string;
  deliveryMode: "clean" | "forward";
  botUsername: string;
  adminTgIds: string;
  requestTtlHours: number;
  maxDialogs: number;
  maxMessagesPerChat: number;
  deepScan: boolean;
  paused: boolean;
  pauseMessage: string;
  maxUploadMb: number;

  // ── 🛡️ ANTI-THEFT (v6) ─────────────────────────────────────────────────
  /** Poori site ka 24h circuit breaker: itne video deliver hone ke baad
   *  naye deep-link banna band (0 = bandh/off). Scraping rokne ke liye. */
  globalDailyLimit: number;
  /** Ek deep-link kitni baar use ho sakta hai (1 = single-use). */
  requestReuseLimit: number;
  /** Same user + same video ke liye cooldown (minutes) — repeat flooding rokta hai. */
  requestCooldownMin: number;
  /** Ek user ek time me kitne PENDING (undelivered) request rakh sakta hai. */
  maxPendingPerUser: number;

  // ── 🔒 CHANNEL JOIN-GATE (v7) ───────────────────────────────────────────
  /** True = video lene se pehle student ko channel join karna zaroori hai. */
  joinGateEnabled: boolean;
  /** Kaunsa channel check karna hai — "@username" ya "-100xxxxxxxxxx".
   *  ⚠️ Bot us channel me ADMIN hona chahiye warna check fail-open hota hai. */
  joinGateChannel: string;
  /** "Join our channel" button ka link (khaali = https://t.me/<username>). */
  joinGateInviteUrl: string;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  dailyLimit: 12,
  quotaWindowHours: 24,
  autoDeleteHours: 2,
  creditUsername: "krishna84",
  contactUsername: "krishna84",
  deliveryMode: "clean",
  botUsername: "",
  adminTgIds: "",
  requestTtlHours: 168,
  maxDialogs: 60,
  maxMessagesPerChat: 40,
  deepScan: true,
  paused: false,
  pauseMessage: "Service is paused for maintenance. Please try again later.",
  maxUploadMb: 2000,

  // 🛡️ defaults: 500 video/site/24h, single-use link, 5 min cooldown, 3 pending
  globalDailyLimit: 500,
  requestReuseLimit: 1,
  requestCooldownMin: 5,
  maxPendingPerUser: 3,

  // 🔒 join-gate default OFF — admin explicitly on kare (channel set karke)
  joinGateEnabled: false,
  joinGateChannel: "",
  joinGateInviteUrl: "",
};

export interface TelegramRequestRecord {
  /** Student login id jisne request banayi (audit ke liye) */
  uid: string;
  batchId: string;
  batchName: string;
  videoId: string;
  title: string;
  topic: string;
  courseName: string;
  folderPath: string[];
  chatId: string;
  messageId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  youtubeUrl: string;
  part: number | null;
  createdAt: number;
  /** Bot delivery ke baad fill hota hai */
  deliveredTo?: number;
  deliveredAt?: number;
  deleteAt?: number;
  deliveryMode?: string;

  // ── 🛡️ ANTI-THEFT (v6) ─────────────────────────────────────────────────
  /** Jo pehla Telegram user ye link kholta hai, link usi ka ho jata hai.
   *  Dusre user ko bot mana kar deta hai ("belongs to another account"). */
  boundTgUid?: number;
  /** Kitni baar deliver ho chuka (requestReuseLimit se compare hota hai). */
  usedCount?: number;
  usedAt?: number;
  /** Request banane wala IP (audit / abuse trace). */
  ip?: string;
  /** Website-side daily quota consume hua ya nahi. */
  quotaConsumed?: boolean;
}

export interface BotUserRow {
  id?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  limit?: number;
  banned?: boolean;
  totalVideos?: number;
  firstSeen?: number;
  lastSeen?: number;
  recent?: number[];
}

export interface BotStats {
  backend: string;
  totalUsers: number;
  totalVideosSent: number;
  videosLast24h: number;
  pendingDeletions: number;
  botUsername: string;
  botAlive: boolean;
  lastHeartbeatAt: number;
  heartbeatAgoSec: number;
  deliveryMode: string;
  dailyLimit: number;
  autoDeleteHours: number;
  paused: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────────────────────
export async function getBotConfig(): Promise<BotConfig> {
  const stored = (await rtGet<Partial<BotConfig>>(`${BOT_STATE_PREFIX}/config`, 5000)) || {};
  const settings = await getEffectiveSiteSettings();

  const merged: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    ...(typeof stored === "object" && stored ? stored : {}),
  };

  // Website settings (admin panel → Website Settings) bot config ko override karti hain
  if (settings.dailyVideoLimit) merged.dailyLimit = Number(settings.dailyVideoLimit);
  if (settings.autoDeleteHours) merged.autoDeleteHours = Number(settings.autoDeleteHours);
  if (settings.creditUsername) merged.creditUsername = String(settings.creditUsername);
  if (settings.contactUsername) merged.contactUsername = String(settings.contactUsername);
  if (settings.telegramBotUsername && !merged.botUsername) {
    merged.botUsername = String(settings.telegramBotUsername);
  }
  if (!merged.botUsername) {
    merged.botUsername = cleanEnv(process.env.TELEGRAM_BOT_USERNAME);
  }

  return merged;
}

export async function saveBotConfig(partial: Partial<BotConfig>): Promise<BotConfig> {
  const current = await getBotConfig();
  const next: BotConfig = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined && value !== null) {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  await rtSet(`${BOT_STATE_PREFIX}/config`, { ...next, updatedAt: Date.now() }, 6000);
  return next;
}

export async function getBotUsername(): Promise<string> {
  const cfg = await getBotConfig();
  return String(cfg.botUsername || "").replace(/^@+/, "").trim();
}

// ────────────────────────────────────────────────────────────────────────────
// DEEP-LINK REQUEST RECORDS
// ────────────────────────────────────────────────────────────────────────────
const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRequestId(): string {
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function decodeMediaToken(token?: string | null): {
  chatId: string;
  messageId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
} | null {
  if (!token) return null;
  const decoded = verifyTelegramMediaToken(token);
  if (!decoded) return null;
  return {
    chatId: String(decoded.c || ""),
    messageId: Number(decoded.m || 0),
    fileName: String(decoded.n || ""),
    fileSize: Number(decoded.s || 0),
    mimeType: String(decoded.mt || ""),
  };
}

export interface CreateTelegramRequestInput {
  uid: string;
  batchId: string;
  batchName?: string;
  videoId: string;
  title: string;
  courseName?: string;
  topic?: string;
  folderPath?: string[];
  tgVideoToken?: string;
  youtubeUrl?: string;
  fileSize?: number;
  /** 🛡️ abuse trace: kis IP se deep-link bana */
  ip?: string;
}

export interface CreateTelegramRequestResult {
  ok: boolean;
  requestId?: string;
  deepLink?: string;
  botUsername?: string;
  record?: TelegramRequestRecord;
  error?: string;
}

/**
 * Watch page ke ▶ OPEN IN TELEGRAM button ke liye record + deep-link banata hai.
 */
export async function createTelegramRequest(
  input: CreateTelegramRequestInput
): Promise<CreateTelegramRequestResult> {
  const botUsername = await getBotUsername();
  if (!botUsername) {
    return {
      ok: false,
      error:
        "Telegram bot username is not configured yet. Start the delivery bot once, or set it in Admin Panel → Telegram Bot Delivery.",
    };
  }

  const media = decodeMediaToken(input.tgVideoToken);
  const topic = buildTopicPath(input.folderPath || [], input.topic || "");

  const record: TelegramRequestRecord = {
    uid: String(input.uid || ""),
    batchId: String(input.batchId || ""),
    batchName: String(input.batchName || ""),
    videoId: String(input.videoId || ""),
    title: String(input.title || "Lecture"),
    topic,
    courseName: String(input.courseName || input.batchName || ""),
    folderPath: (input.folderPath || []).map((p) => String(p || "")).filter(Boolean),
    chatId: media?.chatId || "",
    messageId: media?.messageId || 0,
    fileName: media?.fileName || "",
    fileSize: Number(input.fileSize || media?.fileSize || 0),
    mimeType: media?.mimeType || "video/mp4",
    youtubeUrl: String(input.youtubeUrl || ""),
    part: null,
    createdAt: Date.now(),
    // 🛡️ anti-theft: single-use + ek hi Telegram account par bind (bot bharta hai)
    ip: String(input.ip || "").slice(0, 64),
    boundTgUid: 0,
    usedCount: 0,
    quotaConsumed: true,
  };

  const requestId = makeRequestId();
  const saved = await rtSet(`${TG_REQUEST_PREFIX}/${requestId}`, record, 6000);
  if (!saved) {
    return {
      ok: false,
      error:
        "Could not save the delivery request. Please check Firebase configuration (bot delivery needs the shared database).",
    };
  }

  return {
    ok: true,
    requestId,
    botUsername,
    deepLink: `https://t.me/${botUsername}?start=${requestId}`,
    record,
  };
}

export async function getTelegramRequest(
  requestId: string
): Promise<TelegramRequestRecord | null> {
  const cfg = await getBotConfig();
  const record = await rtGet<TelegramRequestRecord>(
    `${TG_REQUEST_PREFIX}/${requestId}`,
    5000
  );
  if (!record || typeof record !== "object") return null;

  const ttlHours = Number(cfg.requestTtlHours || 168);
  const createdAt = Number(record.createdAt || 0);
  if (createdAt && ttlHours > 0) {
    const ageHours = (Date.now() - createdAt) / 3600000;
    if (ageHours > ttlHours) return null;
  }
  return record;
}

export async function deleteTelegramRequest(requestId: string): Promise<boolean> {
  return rtRemove(`${TG_REQUEST_PREFIX}/${requestId}`, 5000);
}

// ────────────────────────────────────────────────────────────────────────────
// STATS / USERS / TASKS  (admin panel)
// ────────────────────────────────────────────────────────────────────────────
export async function getBotStats(): Promise<BotStats> {
  const cfg = await getBotConfig();
  const users = await rtChildren<BotUserRow>(`${BOT_STATE_PREFIX}/users`, 6000);
  const deletions = await rtChildren<unknown>(`${BOT_STATE_PREFIX}/deletions`, 6000);
  const stats = (await rtGet<Record<string, unknown>>(`${BOT_STATE_PREFIX}/stats`, 5000)) || {};
  const heartbeat =
    (await rtGet<Record<string, unknown>>(`${BOT_STATE_PREFIX}/heartbeat`, 5000)) || {};

  const now = Date.now();
  const windowMs = Number(cfg.quotaWindowHours || 24) * 3600 * 1000;
  let videosLast24h = 0;
  for (const user of Object.values(users || {})) {
    if (!user || typeof user !== "object") continue;
    for (const stamp of user.recent || []) {
      if (now - Number(stamp || 0) <= windowMs) videosLast24h += 1;
    }
  }

  const lastHeartbeatAt = Number(heartbeat.at || 0);

  return {
    backend: getRtBackend(),
    totalUsers: Object.keys(users || {}).length,
    totalVideosSent: Number(stats.totalVideosSent || 0),
    videosLast24h,
    pendingDeletions: Object.keys(deletions || {}).length,
    botUsername: String(cfg.botUsername || ""),
    botAlive: Boolean(lastHeartbeatAt && now - lastHeartbeatAt < 180000),
    lastHeartbeatAt,
    heartbeatAgoSec: lastHeartbeatAt ? Math.round((now - lastHeartbeatAt) / 1000) : -1,
    deliveryMode: String(cfg.deliveryMode || "clean"),
    dailyLimit: Number(cfg.dailyLimit || 12),
    autoDeleteHours: Number(cfg.autoDeleteHours || 2),
    paused: Boolean(cfg.paused),
  };
}

export async function listBotUsers(limit = 100): Promise<
  Array<BotUserRow & { used: number; remaining: number; limit: number }>
> {
  const cfg = await getBotConfig();
  const users = await rtChildren<BotUserRow>(`${BOT_STATE_PREFIX}/users`, 6000);
  const now = Date.now();
  const windowMs = Number(cfg.quotaWindowHours || 24) * 3600 * 1000;
  const defaultLimit = Number(cfg.dailyLimit || 12);

  const rows = Object.entries(users || {}).map(([key, user]) => {
    const safe = (user || {}) as BotUserRow;
    const recent = (safe.recent || []).filter((s) => now - Number(s || 0) <= windowMs);
    const userLimit = safe.limit !== undefined && safe.limit !== null ? Number(safe.limit) : defaultLimit;
    return {
      ...safe,
      id: Number(key) || Number(safe.id || 0),
      used: recent.length,
      limit: userLimit,
      remaining: Math.max(0, userLimit - recent.length),
      totalVideos: Number(safe.totalVideos || 0),
      lastSeen: Number(safe.lastSeen || 0),
    };
  });

  rows.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
  return rows.slice(0, limit);
}

export async function setBotUserLimit(tgUserId: number, limit: number): Promise<boolean> {
  const path = `${BOT_STATE_PREFIX}/users/${tgUserId}`;
  const user = (await rtGet<BotUserRow>(path, 5000)) || {};
  return rtSet(path, { ...user, limit: Math.max(0, limit), limitUpdatedAt: Date.now() }, 5000);
}

export interface BotTask {
  type: "broadcast" | "set_limit" | "set_config";
  payload: Record<string, unknown>;
  createdAt: number;
  status?: string;
}

/**
 * Admin panel → bot task queue. Bot har 10 second me poll karta hai
 * (telegram-bot/bot.py:_task_poller_loop) aur result wapas likh deta hai.
 */
export async function pushBotTask(task: Omit<BotTask, "createdAt">): Promise<string> {
  const id = `t_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  await rtSet(
    `${BOT_STATE_PREFIX}/tasks/${id}`,
    { ...task, createdAt: Date.now(), status: "pending" },
    6000
  );
  return id;
}

export async function listBotTasks(limit = 25): Promise<Array<BotTask & { id: string }>> {
  const tasks = await rtChildren<BotTask & { id?: string }>(
    `${BOT_STATE_PREFIX}/tasks`,
    6000
  );
  return Object.entries(tasks || {})
    .map(([id, value]) => ({ id, ...(value as BotTask) }))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, limit);
}

export async function listBotEvents(limit = 20): Promise<Array<Record<string, unknown>>> {
  const events = await rtChildren<Record<string, unknown>>(
    `${BOT_STATE_PREFIX}/events`,
    6000
  );
  return Object.values(events || {})
    .filter((e) => e && typeof e === "object")
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, limit);
}

/**
 * Website settings ↔ bot config sync (admin panel se save karne par).
 * Bot config `bot_state/config` me rehta hai, website settings `site_settings/global` me.
 */
export async function syncSettingsToBotConfig(
  settings: SiteDynamicSettings
): Promise<BotConfig> {
  return saveBotConfig({
    dailyLimit: Number(settings.dailyVideoLimit || DEFAULT_BOT_CONFIG.dailyLimit),
    autoDeleteHours: Number(settings.autoDeleteHours || DEFAULT_BOT_CONFIG.autoDeleteHours),
    creditUsername: String(settings.creditUsername || DEFAULT_BOT_CONFIG.creditUsername),
    contactUsername: String(settings.contactUsername || DEFAULT_BOT_CONFIG.contactUsername),
    botUsername: String(settings.telegramBotUsername || "").replace(/^@+/, ""),
  });
}

// ============================================================================
// 🛡️ ANTI-THEFT QUOTA LAYER (v6)
// ----------------------------------------------------------------------------
// Pehle daily limit SIRF bot side (Telegram user id) par lagti thi. Matlab koi
// bhi banda website par 40 deep-link/10min bana kar unhe alag-alag Telegram
// accounts me khol sakta tha → poora course chori ho jata.
//
// Ab website bhi wahi 12/24h limit enforce karti hai (login uid ke hisaab se),
// deep-link SINGLE-USE hota hai, ek Telegram account par BIND ho jata hai, aur
// site-wide 24h circuit breaker bhi hai.
//
// Paths (python bot ke saath shared):
//   web_quota/<safeUid>            → { recent:[ts], pending:{<videoId>:{id,at}} }
//   bot_state/users/<tgUid>        → bot ka apna quota (unchanged)
//   tg_requests/<id>               → record (+ boundTgUid / usedCount)
// ============================================================================

export const WEB_QUOTA_PREFIX = "web_quota";

interface WebQuotaRow {
  recent?: number[];
  pending?: Record<string, { id: string; at: number }>;
}

function safeUid(uid: string): string {
  return String(uid || "anon").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "anon";
}

export interface WebQuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  resetInSec: number;
  windowHours: number;
}

/** Login-uid ka rolling 24h usage (deep-link banane ka, delivery ka nahi). */
export async function getWebRequestQuota(uid: string): Promise<WebQuotaStatus> {
  const cfg = await getBotConfig();
  const settings = await getEffectiveSiteSettings();
  const limit = Number(cfg.dailyLimit || settings.dailyVideoLimit || 12);
  const windowHours = Number(cfg.quotaWindowHours || 24);
  const windowMs = windowHours * 3600 * 1000;
  const now = Date.now();

  const row = (await rtGet<WebQuotaRow>(
    `${WEB_QUOTA_PREFIX}/${safeUid(uid)}`,
    5000
  )) || {};

  const fresh = (row.recent || []).map(Number).filter((t) => t && now - t <= windowMs);
  const used = fresh.length;
  let resetInSec = 0;
  if (fresh.length && used >= limit) {
    resetInSec = Math.max(0, Math.round((windowMs - (now - Math.min(...fresh))) / 1000));
  }

  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetInSec,
    windowHours,
  };
}

/** Deep-link banne par quota consume + pending entry. */
export async function consumeWebRequestQuota(
  uid: string,
  videoId: string,
  requestId: string
): Promise<WebQuotaStatus> {
  const cfg = await getBotConfig();
  const windowMs = Number(cfg.quotaWindowHours || 24) * 3600 * 1000;
  const now = Date.now();
  const key = `${WEB_QUOTA_PREFIX}/${safeUid(uid)}`;
  const row = (await rtGet<WebQuotaRow>(key, 5000)) || {};

  const fresh = (row.recent || []).map(Number).filter((t) => t && now - t <= windowMs);
  fresh.push(now);

  const pending = { ...(row.pending || {}) };
  pending[String(videoId)] = { id: requestId, at: now };
  // purane pending entries (TTL se bade) hata do
  const ttlMs = Number(cfg.requestTtlHours || 168) * 3600 * 1000;
  for (const [k, v] of Object.entries(pending)) {
    if (!v || now - Number(v.at || 0) > ttlMs) delete pending[k];
  }

  await rtSet(key, { recent: fresh.slice(-80), pending }, 6000);
  return getWebRequestQuota(uid);
}

/**
 * Same user ne same video ke liye abhi-abhi link banaya ho to NAYA record
 * banane ke bajaye wahi purana (single-use, unbound) link wapas karo.
 * Isse record flooding aur quota double-spend dono rukte hain.
 */
export async function findReusableRequest(
  uid: string,
  videoId: string
): Promise<{ requestId: string; record: TelegramRequestRecord } | null> {
  const cfg = await getBotConfig();
  const row = (await rtGet<WebQuotaRow>(
    `${WEB_QUOTA_PREFIX}/${safeUid(uid)}`,
    5000
  )) || {};
  const entry = row.pending?.[String(videoId)];
  if (!entry?.id) return null;

  const cooldownMs = Number(cfg.requestCooldownMin || 5) * 60 * 1000;
  if (cooldownMs > 0 && Date.now() - Number(entry.at || 0) < cooldownMs) {
    // cooldown ke andar: purana link hi dobara use hoga (naya nahi banega)
  }

  const record = await getTelegramRequest(entry.id);
  if (!record) return null;

  const reuseLimit = Math.max(1, Number(cfg.requestReuseLimit || 1));
  if (Number(record.usedCount || 0) >= reuseLimit) return null; // already used
  if (record.boundTgUid && Number(record.deliveredTo || 0) > 0) return null;

  return { requestId: entry.id, record };
}

/** Site-wide 24h deliveries (bot ke user rows se) — circuit breaker ke liye. */
export async function getGlobalDeliveries24h(): Promise<number> {
  const cfg = await getBotConfig();
  const windowMs = Number(cfg.quotaWindowHours || 24) * 3600 * 1000;
  const now = Date.now();
  const users = await rtChildren<BotUserRow>(`${BOT_STATE_PREFIX}/users`, 8000);
  let total = 0;
  for (const row of Object.values(users || {})) {
    const stamps = (row?.recent || []).map(Number).filter((t) => t && now - t <= windowMs);
    total += stamps.length;
  }
  return total;
}

export interface GlobalQuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  tripped: boolean;
}

/**
 * 🚨 Global circuit breaker: poori site par 24h me itne video deliver ho chuke
 * ho to naye deep-link banna band. Koi scraper poora course utha na le.
 */
export async function getGlobalDeliveryQuota(): Promise<GlobalQuotaStatus> {
  const cfg = await getBotConfig();
  const limit = Number(cfg.globalDailyLimit || 0);
  const used = await getGlobalDeliveries24h();
  return {
    limit,
    used,
    remaining: limit > 0 ? Math.max(0, limit - used) : -1,
    tripped: limit > 0 && used >= limit,
  };
}

/** Kitne request abhi pending (undelivered) hain is user ke — flooding control. */
export async function countPendingRequests(uid: string): Promise<number> {
  const row = (await rtGet<WebQuotaRow>(
    `${WEB_QUOTA_PREFIX}/${safeUid(uid)}`,
    5000
  )) || {};
  return Object.keys(row.pending || {}).length;
}

/** Delivery ho jane ke baad pending entry hata do (bot ke webhook se nahi,
 *  website next request par khud TTL se saaf karti hai). */
export async function clearPendingRequest(uid: string, videoId: string): Promise<void> {
  const key = `${WEB_QUOTA_PREFIX}/${safeUid(uid)}`;
  const row = (await rtGet<WebQuotaRow>(key, 5000)) || {};
  const pending = { ...(row.pending || {}) };
  delete pending[String(videoId)];
  await rtSet(key, { recent: row.recent || [], pending }, 6000);
}

/** TTL-expired tg_requests saaf karo (DB bharne se rokta hai). */
export async function cleanupExpiredRequests(): Promise<number> {
  const cfg = await getBotConfig();
  const ttlMs = Number(cfg.requestTtlHours || 168) * 3600 * 1000;
  if (ttlMs <= 0) return 0;
  const now = Date.now();
  const rows = await rtChildren<TelegramRequestRecord>(TG_REQUEST_PREFIX, 8000);
  let removed = 0;
  for (const [id, rec] of Object.entries(rows || {})) {
    const created = Number(rec?.createdAt || 0);
    if (!created) continue;
    if (now - created > ttlMs) {
      await rtRemove(`${TG_REQUEST_PREFIX}/${id}`, 5000);
      removed += 1;
    }
  }
  return removed;
}
