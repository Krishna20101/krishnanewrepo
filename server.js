#!/usr/bin/env node
/* =============================================================================
   📚 Study helper Doc — server.js  (single Node server, no framework build step)
   -----------------------------------------------------------------------------
   Kya karta hai:
     • index.html + site/  ko serve karta hai (static)
     • /api/*  — login, courses, tree, Telegram delivery request, admin panel
     • Firebase Realtime Database read/write (firebase-admin)
     • data/batches/*.json  → file-backed courses (READ-ONLY, kabhi modify nahi)

   Video delivery ka rule (v5):
     Website video PLAY ya DOWNLOAD nahi karti. Watch page par sirf thumbnail +
     "▶ Open in Telegram" button hota hai. Button ek request record banata hai
     (tg_requests/<id>) aur bot ko deep-link karta hai. Bot wahi video user ke
     Telegram chat me bhejta hai, 2 ghante baad auto-delete.

   Crypto contract bot/bot.py ke saath BYTE-COMPATIBLE hai:
     secret = ADMIN_SESSION_SECRET || sha256(ADMIN_EMAIL:ADMIN_PASSWORD:PROJECT_ID)
     key    = scrypt(secret, "shd_tg_media_vault_v3_2026", N=16384, r=8, p=1, 32)
     vault  = "v1.<b64url iv>.<b64url tag>.<b64url ct>"   (AES-256-GCM)
     token  = "tg_<b64url iv>_<b64url tag>_<b64url ct>"
   ============================================================================= */
"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;

/* ── .env (optional) ──────────────────────────────────────────────────────── */
for (const file of [".env.local", ".env"]) {
  try {
    require("dotenv").config({ path: path.join(HERE, file) });
  } catch (_) {
    /* dotenv na ho to env vars se hi chalega */
  }
}

/* =============================================================================
   SECTION 1 · env + secrets
   ============================================================================= */

const IS_PROD = String(process.env.NODE_ENV || "development").toLowerCase() === "production";
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0"; // Render/preview ke liye 0.0.0.0 zaroori

function env(key, fallback = "") {
  const value = process.env[key];
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === "" ? fallback : text;
}

function envBool(key, fallback = false) {
  const raw = env(key, "").toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function envNum(key, fallback) {
  const raw = env(key, "");
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** firebase-admin ko PRIVATE_KEY me "\n" literal chahiye hota hai */
function privateKey() {
  const raw = env("FIREBASE_PRIVATE_KEY", "");
  if (!raw) return "";
  if (raw.includes("-----BEGIN")) {
    // already a PEM block
    return raw.replace(/\\n/g, "\n").replace(/\r/g, "").trim() + "\n";
  }
  const body = raw.replace(/\\n/g, "\n").replace(/\s+/g, "").trim();
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join("\n") || body}\n-----END PRIVATE KEY-----\n`;
}

/**
 * 🔐 Master secret — website aur bot DONO me same hona chahiye.
 * Production me kuch bhi na mile → server start hi nahi hoga (weak fallback nahi).
 */
function getMasterSecret() {
  const explicit = env("ADMIN_SESSION_SECRET", "");
  if (explicit && explicit.length >= 16) return explicit;

  const email = env("ADMIN_EMAIL", "");
  const pass = env("ADMIN_PASSWORD", "");
  const project = env("FIREBASE_PROJECT_ID", "");
  if (email && pass) {
    return crypto
      .createHash("sha256")
      .update(`${email}:${pass}:${project}:shd_master_v1`)
      .digest("hex");
  }

  if (IS_PROD) {
    throw new Error(
      "❌ ADMIN_SESSION_SECRET missing. Set ADMIN_SESSION_SECRET (>=16 chars) — " +
        "without it Telegram tokens and admin sessions cannot be secured."
    );
  }
  // development only — stable per-process key
  if (!global.__shdDevSecret) {
    global.__shdDevSecret = "dev::" + crypto.randomBytes(24).toString("hex");
    console.warn("⚠️  dev mode: ADMIN_SESSION_SECRET missing → temporary random secret (sessions reset on restart)");
  }
  return global.__shdDevSecret;
}

function studentSessionSecret() {
  const explicit = env("STUDENT_SESSION_SECRET", "");
  if (explicit && explicit.length >= 16) return explicit;
  return `student::${getMasterSecret()}`;
}

/* =============================================================================
   SECTION 2 · 🔐 vault crypto + media token + Telegram link parsing
   ============================================================================= */

const VAULT_SALT = Buffer.from("shd_tg_media_vault_v3_2026", "utf8");
const SESSION_SALT = "shd_session_salt";
const TOKEN_TTL_DAYS = envNum("TG_MEDIA_TOKEN_TTL_DAYS", 30);

let cachedVaultKey = null;
function vaultKey() {
  if (!cachedVaultKey) {
    cachedVaultKey = crypto.scryptSync(getMasterSecret(), VAULT_SALT, 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
  }
  return cachedVaultKey;
}

/** AES-256-GCM encrypt → "v1.<iv>.<tag>.<ct>" (base64url) */
function encryptVaultJson(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

/** "v1.<iv>.<tag>.<ct>" → object | null (tamper/secret-mismatch par null) */
function decryptVaultJson(cipherText) {
  if (!cipherText || typeof cipherText !== "string") return null;
  const parts = cipherText.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch (_) {
    return null;
  }
}

/** Deterministic IV — same (chat,msg,kind,window) ka same token (reuse ke liye) */
function deterministicIv(seedText) {
  return crypto.createHash("sha256").update(`${getMasterSecret()}|${seedText}`).digest().subarray(0, 12);
}

/**
 * 🎬 Media token: ek node ke Telegram source ko chhupane ke liye.
 * kind: "v" = video, "p" = pdf, "t" = thumbnail
 * Format: tg_<iv>_<tag>_<ct>  (payload {c,m,k,s,n,mt,exp})
 */
function makeMediaToken({ chatId, messageId, kind = "v", size = 0, name = "", ttlDays = TOKEN_TTL_DAYS }) {
  // ttlDays > 0 → future expiry · 0 → kabhi expire nahi · < 0 → abhi expired (test)
  const exp = Number(ttlDays) === 0 ? 0 : Math.floor(Date.now() / 1000) + Math.floor(Number(ttlDays) * 86400);
  const window = ttlDays > 0 ? Math.floor(Date.now() / (ttlDays * 86400 * 1000)) : 0;
  const iv = deterministicIv(`${chatId}|${messageId}|${kind}|${window}`);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  const payload = JSON.stringify({
    c: String(chatId),
    m: Number(messageId),
    k: kind,
    s: Number(size) || 0,
    n: String(name || "").slice(0, 180),
    mt: Math.floor(Date.now()),
    exp,
  });
  const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return `tg_${iv.toString("base64url")}_${cipher.getAuthTag().toString("base64url")}_${ct.toString("base64url")}`;
}

/**
 * "tg_<iv>_<tag>_<ct>" → {chatId, messageId, kind, size, name, exp} | null
 *
 * ⚠️ base64url alphabet me `_` bhi aata hai, isliye split("_") galat hai.
 *    Lengths fixed hain: iv = 12 bytes → 16 chars, tag = 16 bytes → 22 chars.
 */
const TOKEN_IV_CHARS = 16; // 12 bytes base64url (no padding)
const TOKEN_TAG_CHARS = 22; // 16 bytes base64url (no padding)

function readMediaToken(token) {
  if (!token || typeof token !== "string" || !token.startsWith("tg_")) return null;
  const body = token.slice(3);
  const ivPart = body.slice(0, TOKEN_IV_CHARS);
  const tagPart = body.slice(TOKEN_IV_CHARS + 1, TOKEN_IV_CHARS + 1 + TOKEN_TAG_CHARS);
  const ctPart = body.slice(TOKEN_IV_CHARS + 1 + TOKEN_TAG_CHARS + 1);
  if (body[TOKEN_IV_CHARS] !== "_" || body[TOKEN_IV_CHARS + 1 + TOKEN_TAG_CHARS] !== "_" || !ctPart) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]);
    const data = JSON.parse(plain.toString("utf8"));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return {
      chatId: String(data.c || ""),
      messageId: Number(data.m || 0),
      kind: String(data.k || "v"),
      size: Number(data.s || 0),
      name: String(data.n || ""),
      exp: Number(data.exp || 0),
    };
  } catch (_) {
    return null;
  }
}

/**
 * 🔗 Telegram post link → {chatId, messageId}
 * Accepts:
 *   https://t.me/channelname/1234          (public)
 *   https://t.me/c/1234567890/1234         (private, numeric internal id)
 *   https://t.me/channelname/1234/5678     (forum topic)
 *   t.me/username/42
 */
function parseTelegramPostLink(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const text = raw.replace(/^@/, "");
  const match = text.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(c\/)?([A-Za-z][A-Za-z0-9_]{3,40}|-?\d{4,20})\/(\d{1,10})(?:\/(\d{1,10}))?\/?$/i
  );
  if (!match) return null;
  const isPrivate = Boolean(match[1]);
  const handle = match[2];
  const messageId = parseInt(match[4] || match[3], 10);
  if (!Number.isFinite(messageId) || messageId <= 0) return null;
  if (isPrivate) {
    // t.me/c/<internalId>/<msgId>  → real chatId = -100<internalId>
    const digits = String(handle).replace(/^-/, "");
    if (!/^\d{4,20}$/.test(digits)) return null;
    return { chatId: `-100${digits}`, messageId, kind: "private", link: raw };
  }
  return { chatId: `@${handle}`, messageId, kind: "public", link: raw };
}

/* =============================================================================
   SECTION 3 · 🗄️ store — Firebase RTDB (fallback: local JSON file for dev)
   ============================================================================= */

const LOCAL_STORE_PATH = env("LOCAL_STORE_PATH", path.join("/tmp", "shd_local_store.json"));

let rtdb = null;
let firebaseReady = false;

let firebaseAttempted = false;

function initFirebase() {
  if (firebaseAttempted) return firebaseReady; // serverless me double-call safe
  firebaseAttempted = true;
  const projectId = env("FIREBASE_PROJECT_ID", "");
  const clientEmail = env("FIREBASE_CLIENT_EMAIL", "");
  const key = privateKey();
  const databaseURL =
    env("FIREBASE_DATABASE_URL", "") ||
    (projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : "");

  if (!projectId || !clientEmail || !key) {
    console.warn("⚠️  Firebase creds missing → local JSON store (" + LOCAL_STORE_PATH + ")");
    return false;
  }
  try {
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: key,
        }),
        databaseURL,
      });
    }
    rtdb = admin.database();
    firebaseReady = true;
    console.log("✅ Firebase RTDB connected: " + databaseURL.replace(/^https:\/\//, ""));
  } catch (error) {
    console.error("❌ Firebase init failed → local JSON store:", error.message);
    rtdb = null;
  }
  return firebaseReady;
}

/* ── local file store (same path semantics, "/" separated) ───────────────── */
function localLoad() {
  try {
    const text = fs.readFileSync(LOCAL_STORE_PATH, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function localSave(root) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_STORE_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(root, null, 2), "utf8");
  } catch (error) {
    console.error("local store save failed:", error.message);
  }
}

function localNavigate(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (!node || typeof node !== "object") return undefined;
    node = node[seg];
  }
  return node;
}

function localAssign(root, segments, value) {
  if (!segments.length) return value;
  let node = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (typeof node[segments[i]] !== "object" || node[segments[i]] === null) node[segments[i]] = {};
    node = node[segments[i]];
  }
  node[segments[segments.length - 1]] = value;
  return root;
}

function splitPath(dbPath) {
  return String(dbPath || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** RTDB me undefined/function/NaN nahi ja sakta — pehle clean karo */
function cleanValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "function") return null;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const cleaned = cleanValue(item);
      if (cleaned !== null) out.push(cleaned);
    }
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "" || key.includes(".") || key.includes("#") || key.includes("$") || key.includes("[") || key.includes("]")) {
        continue;
      }
      const cleaned = cleanValue(item);
      if (cleaned !== null) out[key] = cleaned;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

const store = {
  get backend() {
    return firebaseReady ? "firebase" : "local";
  },

  async get(dbPath) {
    if (firebaseReady) {
      try {
        const snap = await rtdb.ref(dbPath).once("value");
        return snap.val();
      } catch (error) {
        console.error(`rtdb get(${dbPath}) failed:`, error.message);
        return null;
      }
    }
    const root = localLoad();
    const value = localNavigate(root, splitPath(dbPath));
    return value === undefined ? null : value;
  },

  async set(dbPath, value) {
    const cleaned = cleanValue(value);
    if (firebaseReady) {
      try {
        if (cleaned === null) await rtdb.ref(dbPath).remove();
        else await rtdb.ref(dbPath).set(cleaned);
        return true;
      } catch (error) {
        console.error(`rtdb set(${dbPath}) failed:`, error.message);
        return false;
      }
    }
    const root = localLoad();
    const segments = splitPath(dbPath);
    if (cleaned === null) {
      if (segments.length === 1) delete root[segments[0]];
      else {
        const parent = localNavigate(root, segments.slice(0, -1));
        if (parent && typeof parent === "object") delete parent[segments[segments.length - 1]];
      }
    } else {
      localAssign(root, segments, cleaned);
    }
    localSave(root);
    return true;
  },

  async update(dbPath, patch) {
    const cleaned = cleanValue(patch);
    if (!cleaned || typeof cleaned !== "object") return false;
    if (firebaseReady) {
      try {
        await rtdb.ref(dbPath).update(cleaned);
        return true;
      } catch (error) {
        console.error(`rtdb update(${dbPath}) failed:`, error.message);
        return false;
      }
    }
    const root = localLoad();
    const segments = splitPath(dbPath);
    const current = localNavigate(root, segments);
    localAssign(root, segments, Object.assign({}, current && typeof current === "object" ? current : {}, cleaned));
    localSave(root);
    return true;
  },

  async remove(dbPath) {
    return store.set(dbPath, null);
  },
};

/* =============================================================================
   SECTION 4 · ⚙️ site settings + bot config (RTDB)
   ============================================================================= */

const SETTINGS_PATH = "site_settings/global";
const BATCH_META_PATH = "site_settings/batch_meta";
const DELETED_PATH = "site_settings/deleted_batches";
const ACCOUNTS_PATH = "student_accounts";
const CUSTOM_BATCH_PATH = "custom_batches";
const REQUESTS_PATH = "tg_requests";
const GROUPS_PATH = "telegram_vault/groups";
const CREDS_PATH = "telegram_vault/encrypted_creds";
const BOT_CONFIG_PATH = "bot_state/config";
const BOT_TASKS_PATH = "bot_state/tasks";
const LOGS_PATH = "admin_logs";

/** Website ki public/app settings — bot config se alag cheez hai */
const DEFAULT_SETTINGS = {
  appName: "Study helper Doc",
  tagline: "Courses, lectures and PDFs — delivered on Telegram.",
  telegramUrl: "https://t.me/krishna84",
  telegramBotUsername: env("TELEGRAM_BOT_USERNAME", ""),
  creditUsername: "krishna84",
  contactUsername: "krishna84",
  dailyVideoLimit: 20,
  autoDeleteHours: 2,
  dailyResetHourIST: 0,
  loginRequired: true,
  allowSignup: false,
  maintenanceMode: false,
  maintenanceMessage: "",
};

async function getSettings() {
  const saved = (await store.get(SETTINGS_PATH)) || {};
  const merged = Object.assign({}, DEFAULT_SETTINGS, saved && typeof saved === "object" ? saved : {});
  merged.dailyVideoLimit = Number(merged.dailyVideoLimit) || 20;
  merged.autoDeleteHours = Number(merged.autoDeleteHours) || 2;
  return merged;
}

/** Bot ka live config (bot_state/config) — website isi ko padh kar deep link banati hai */
async function getBotConfig() {
  const cfg = (await store.get(BOT_CONFIG_PATH)) || {};
  return cfg && typeof cfg === "object" ? cfg : {};
}

async function writeLog(kind, data) {
  try {
    const stamp = Date.now();
    await store.set(`${LOGS_PATH}/${kind}/${stamp}`, Object.assign({ at: stamp }, data || {}));
  } catch (_) {
    /* log failure kabhi request fail na kare */
  }
}

/* =============================================================================
   SECTION 5 · 📂 courses — data/batches/*.json (read-only) + DB overrides
   ============================================================================= */

const DATA_DIR = path.join(HERE, "data", "batches");
let fileBatchCache = null;
let fileBatchCacheAt = 0;

function isFileBackedBatch(batchId) {
  const id = String(batchId || "");
  if (!id) return false;
  try {
    if (!fs.existsSync(DATA_DIR)) return false;
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".json"))
      .some((f) => f.endsWith(`_${id}.json`));
  } catch (_) {
    return false;
  }
}

function loadFileBatches() {
  const now = Date.now();
  if (fileBatchCache && now - fileBatchCacheAt < 15000) return fileBatchCache;
  const out = new Map();
  try {
    if (fs.existsSync(DATA_DIR)) {
      for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"))) {
        try {
          const text = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
          const data = JSON.parse(text);
          if (!data || typeof data !== "object") continue;
          const id = String(data.id ?? file.replace(/\.json$/, "").split("_").pop());
          data.__file = file;
          data.__fileBacked = true;
          out.set(id, data);
        } catch (error) {
          console.error(`skip ${file}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.error("data dir read failed:", error.message);
  }
  fileBatchCache = out;
  fileBatchCacheAt = now;
  return out;
}

/** Ek node ki counts (videos/files) — tree UI ke liye */
function countNode(node) {
  let videos = 0;
  let files = 0;
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    const type = String(current.type || "").toUpperCase();
    if (type === "VIDEO") videos += 1;
    else if (type === "FILE" || type === "PDF") files += 1;
    if (Array.isArray(current.children)) stack.push(...current.children);
  }
  return { videos, files };
}

/** Node ko website-safe shape me badlo (token decrypt karke sirf flags bhejo) */
function publicNode(node, parentPath) {
  const type = String(node.type || "FOLDER").toUpperCase();
  const trail = [...(parentPath || []), String(node.title || "")];
  const videoToken = node.tg_video_token || "";
  const pdfToken = node.tg_pdf_token || "";
  const source = readMediaToken(videoToken) || readMediaToken(pdfToken);
  const mediaKind = videoToken ? "video" : pdfToken ? "pdf" : "";
  const out = {
    id: String(node.id || ""),
    title: String(node.title || ""),
    type,
    thumbnail: String(node.thumbnail || ""),
    uploadedAt: String(node.uploaded_at || node.uploadedAt || ""),
    path: trail.filter(Boolean),
    source: String(node.source || (mediaKind ? "telegram" : "file")),
    hasTelegram: Boolean(videoToken),
    hasTelegramPdf: Boolean(pdfToken),
    mediaKind,
    hasPdf: Boolean(pdfToken || node.pdf_link_enc),
    youtubeOnly: Boolean(node.youtube_url || node.youtubeUrl) && !mediaKind,
    sizeMb: source && source.size ? Math.round((source.size / (1024 * 1024)) * 10) / 10 : 0,
    available: Boolean(mediaKind) || Boolean(node.youtube_url || node.youtubeUrl) || type !== "VIDEO",
  };
  if (type !== "VIDEO" && Array.isArray(node.children)) {
    const counts = countNode(node);
    out.videosCount = counts.videos;
    out.filesCount = counts.files;
    out.children = node.children.map((child) => publicNode(child, trail));
  }
  return out;
}

/** DB-only custom batches (bot scan / admin add) + file batches merge */
async function listBatches() {
  const [custom, deletedIds, meta, settings] = await Promise.all([
    store.get(CUSTOM_BATCH_PATH),
    store.get(DELETED_PATH),
    store.get(BATCH_META_PATH),
    getSettings(),
  ]);
  const deleted = new Set(Object.keys(deletedIds && typeof deletedIds === "object" ? deletedIds : {}));
  const metaMap = meta && typeof meta === "object" ? meta : {};
  const out = [];

  for (const [id, data] of loadFileBatches().entries()) {
    if (deleted.has(String(id))) continue;
    const tree = Array.isArray(data.tree) ? data.tree : [];
    const counts = tree.reduce(
      (acc, node) => {
        const c = countNode(node);
        acc.videos += c.videos;
        acc.files += c.files;
        return acc;
      },
      { videos: 0, files: 0 }
    );
    const override = metaMap[String(id)] || {};
    out.push({
      id: String(id),
      name: String(override.name || data.name || `Course ${id}`),
      slug: String(override.slug || data.slug || ""),
      thumbnail: String(override.thumbnail || data.thumbnail || ""),
      price: override.price !== undefined ? override.price : data.price ?? "",
      source: String(override.source || data.source || "file"),
      fileBacked: true,
      hidden: Boolean(override.hidden),
      videos: counts.videos,
      files: counts.files,
      folders: tree.length,
      updatedAt: Number(override.updatedAt || 0),
    });
  }

  for (const [id, data] of Object.entries(custom && typeof custom === "object" ? custom : {})) {
    if (!data || typeof data !== "object") continue;
    if (deleted.has(String(id))) continue;
    if (loadFileBatches().has(String(id))) continue; // file-backed already listed
    const tree = Array.isArray(data.tree) ? data.tree : [];
    const counts = tree.reduce(
      (acc, node) => {
        const c = countNode(node);
        acc.videos += c.videos;
        acc.files += c.files;
        return acc;
      },
      { videos: 0, files: 0 }
    );
    out.push({
      id: String(id),
      name: String(data.name || `Course ${id}`),
      slug: String(data.slug || ""),
      thumbnail: String(data.thumbnail || ""),
      price: data.price ?? "",
      source: String(data.source || "custom"),
      fileBacked: false,
      hidden: Boolean(data.hidden),
      videos: counts.videos,
      files: counts.files,
      folders: tree.length,
      updatedAt: Number(data.updatedAt || data.createdAt || 0),
    });
  }

  return out
    .filter((b) => !b.hidden || envBool("ADMIN_SHOW_HIDDEN", false))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Ek course ka poora tree (file + DB override/custom merge) */
async function getBatchTree(batchId) {
  const id = String(batchId || "");
  const [custom, deletedIds, meta, settings] = await Promise.all([
    store.get(`${CUSTOM_BATCH_PATH}/${id}`),
    store.get(DELETED_PATH),
    store.get(`${BATCH_META_PATH}/${id}`),
    getSettings(),
  ]);
  const deleted = deletedIds && typeof deletedIds === "object" && deletedIds[id];
  if (deleted) return null;

  const files = loadFileBatches();
  const fileData = files.get(id);
  const customData = custom && typeof custom === "object" ? custom : null;

  const base = fileData || customData;
  if (!base) return null;

  // ⚠️ file cache ko mutate na karein → tree ki COPY par kaam karo
  let tree = JSON.parse(JSON.stringify(Array.isArray(base.tree) ? base.tree : []));

  const override = (fileData && meta) || {};
  const merged = {
    id,
    name: String(override.name || (customData && customData.name) || base.name || `Course ${id}`),
    slug: String(override.slug || (customData && customData.slug) || base.slug || ""),
    thumbnail: String(override.thumbnail || (customData && customData.thumbnail) || base.thumbnail || ""),
    price: override.price !== undefined ? override.price : base.price ?? "",
    source: String((customData && customData.source) || override.source || base.source || "file"),
    fileBacked: Boolean(fileData),
    purgedTelegramAt: Number(base.purgedTelegramAt || (customData && customData.purgedTelegramAt) || 0),
    createdAt: Number((customData && customData.createdAt) || 0),
    updatedAt: Number((customData && customData.updatedAt) || override.updatedAt || 0),
    tree,
  };

  // file-backed course par DB ke custom nodes (admin add-by-url / bot scan) DEEP merge
  if (fileData && customData && Array.isArray(customData.tree) && customData.tree.length) {
    merged.tree = mergeOverlay(merged.tree, customData.tree);
  }

  return Object.assign(merged, {
    publicTree: merged.tree.map((node) => publicNode(node, [])),
    counts: merged.tree.reduce(
      (acc, node) => {
        const c = countNode(node);
        acc.videos += c.videos;
        acc.files += c.files;
        return acc;
      },
      { videos: 0, files: 0 }
    ),
    settings,
  });
}

/** Tree ke saare nodes ka id → node index (recursive) */
function indexTree(nodes, map = new Map(), depth = 0) {
  if (depth > 40) return map;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== "object") continue;
    map.set(String(node.id), node);
    if (Array.isArray(node.children)) indexTree(node.children, map, depth + 1);
  }
  return map;
}

/**
 * 🧩 DB overlay ko file-backed tree par merge karo.
 * Same id → DB ke fields jeet-te hain (jaise attach kiya hua tg_video_token).
 * Naya node → apne parent_id ke andar, warna root par append.
 * NOTE: `base` ko mutate karta hai — hamesha COPY bhejiye (file cache safe rahe).
 */
function mergeOverlay(base, overlay) {
  const baseIndex = indexTree(base);
  const fresh = [];
  const walk = (nodes, depth) => {
    if (depth > 40) return;
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== "object") continue;
      const target = baseIndex.get(String(node.id));
      if (!target) {
        fresh.push(node);
        continue;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "children" || key === "id") continue;
        if (value === undefined) continue;
        target[key] = value;
      }
      if (Array.isArray(node.children)) {
        target.children = Array.isArray(target.children) ? target.children : [];
        walk(node.children, depth + 1);
        const have = new Set(target.children.map((c) => String(c && c.id)));
        for (const child of node.children) {
          if (child && typeof child === "object" && !have.has(String(child.id))) {
            target.children.push(child);
            baseIndex.set(String(child.id), child);
          }
        }
      }
    }
  };
  walk(overlay, 0);

  for (const node of fresh) {
    const parentId = String(node.parent_id || "");
    const parent = parentId ? baseIndex.get(parentId) : null;
    if (parent) {
      parent.children = Array.isArray(parent.children) ? parent.children : [];
      parent.children.push(node);
      baseIndex.set(String(node.id), node);
    } else {
      base.push(node);
      baseIndex.set(String(node.id), node);
    }
  }
  return base;
}

/** Tree me ek node dhoondho + uska folder-path (titles) bhi */
function findNodeById(tree, nodeId) {
  const target = String(nodeId || "");
  if (!target) return null;
  const walk = (nodes, trail) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== "object") continue;
      const nextTrail = [...trail, String(node.title || "")];
      if (String(node.id) === target) return { node, trail: nextTrail };
      const found = walk(node.children, nextTrail);
      if (found) return found;
    }
    return null;
  };
  return walk(tree, []);
}

/* =============================================================================
   SECTION 6 · 🔑 sessions (student + admin) aur rate limits
   ============================================================================= */

const STUDENT_COOKIE = "shd_student_token";
const ADMIN_COOKIE = "shd_admin_token";
const STUDENT_TTL_SEC = 7 * 24 * 60 * 60;
const ADMIN_TTL_SEC = 24 * 60 * 60;

function signBody(body) {
  return crypto.createHmac("sha256", studentSessionSecret()).update(body).digest("base64url");
}

function createStudentSession({ uid, name = "", email = "", phone = "" }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid: String(uid), name, email, phone, paid: false, iat: now, exp: now + STUDENT_TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `s1.${body}.${signBody(body)}`;
}

function verifyStudentSession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "s1") return null;
  const expected = signBody(parts[1]);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || !payload.uid) return null;
    if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function createAdminSession() {
  const key = crypto.scryptSync(getMasterSecret(), SESSION_SALT, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const payload = JSON.stringify({
    role: "shd_super_admin",
    iat: Date.now(),
    exp: Date.now() + ADMIN_TTL_SEC * 1000,
    nonce: crypto.randomBytes(8).toString("hex"),
  });
  const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

function verifyAdminSession(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const key = crypto.scryptSync(getMasterSecret(), SESSION_SALT, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]);
    const payload = JSON.parse(plain.toString("utf8"));
    return payload && payload.role === "shd_super_admin" && Date.now() < Number(payload.exp || 0);
  } catch (_) {
    return false;
  }
}

function isAdminEnvConfigured() {
  return Boolean(env("ADMIN_SESSION_SECRET") || (env("ADMIN_EMAIL") && env("ADMIN_PASSWORD")));
}

function safeEqual(a, b) {
  const key = getMasterSecret();
  const ha = crypto.createHmac("sha512", key).update(String(a)).digest();
  const hb = crypto.createHmac("sha512", key).update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyAdminCredentials(email, password) {
  if (!isAdminEnvConfigured()) return false;
  const cleanEmail = String(email || "").trim().toLowerCase();
  const hashEmail = env("ADMIN_EMAIL_HASH", "");
  const hashPass = env("ADMIN_PASSWORD_HASH", "");
  const salt = env("ADMIN_SALT", "");
  if (hashEmail && hashPass && salt) {
    const e = crypto.pbkdf2Sync(cleanEmail, `${salt}:email`, 100000, 64, "sha512").toString("hex");
    const p = crypto.pbkdf2Sync(String(password || ""), `${salt}:pass`, 100000, 64, "sha512").toString("hex");
    return safeEqual(e, hashEmail) && safeEqual(p, hashPass);
  }
  const envEmail = env("ADMIN_EMAIL", "").toLowerCase();
  const envPass = env("ADMIN_PASSWORD", "");
  if (!envEmail || !envPass) return false;
  return safeEqual(cleanEmail, envEmail) && safeEqual(String(password || ""), envPass);
}

/**
 * RTDB key me `.` `#` `$` `[` `]` allowed nahi hote → login id ko safe key me badlo.
 * Write aur read DONO jagah yahi helper use hota hai ( warna account kabhi nahi milega).
 */
function accountKey(uid) {
  return String(uid || "").trim().toLowerCase().replace(/[.#$[\]]/g, "_");
}

/* ── password hashing (student accounts, scrypt) ─────────────────────────── */
function hashPassword(password, salt) {
  return crypto
    .scryptSync(String(password), String(salt), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    .toString("hex");
}

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { passwordHash: hashPassword(password, salt), passwordSalt: salt };
}

/* ── 🚦 rate limits (in-memory sliding window + RTDB mirror for admin) ───── */
const rateBuckets = new Map();

function rateHit(key, limit, windowSec) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < windowSec * 1000);
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets.entries()) {
      if (!v.some((t) => now - t < windowSec * 1000)) rateBuckets.delete(k);
    }
  }
  return { allowed: bucket.length <= limit, hits: bucket.length, retryAfterSec: bucket.length > limit ? Math.ceil((windowSec * 1000 - (now - bucket[0])) / 1000) : 0 };
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function ipKey(ip) {
  return String(ip || "unknown").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || "");
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

function setCookie(res, name, value, maxAgeSec) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (IS_PROD) bits.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
  list.push(bits.join("; "));
  res.setHeader("Set-Cookie", list);
}

function clearCookie(res, name) {
  setCookie(res, name, "", 0);
}

function getStudent(req) {
  return verifyStudentSession(cookieValue(req, STUDENT_COOKIE));
}

function isAdmin(req) {
  return verifyAdminSession(cookieValue(req, ADMIN_COOKIE));
}

/* =============================================================================
   SECTION 7 · 🌐 express app
   ============================================================================= */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

/* ── security headers ───────────────────────────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  const allowed = env("CORS_ALLOWED_ORIGINS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = String(req.headers.origin || "");
  if (origin && (!allowed.length || allowed.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function fail(res, status, code, message, extra) {
  return json(res, status, Object.assign({ ok: false, error: code, message }, extra || {}));
}

/* ── public config ─────────────────────────────────────────────────────── */
app.get("/api/health", async (req, res) => {
  json(res, 200, {
    ok: true,
    app: env("APP_NAME", "Study helper Doc"),
    backend: store.backend,
    firebase: firebaseReady,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
  });
});

app.get("/api/config", async (req, res) => {
  try {
    const [settings, botCfg] = await Promise.all([getSettings(), getBotConfig()]);
    const quota = effectiveQuota(settings, botCfg);
    json(res, 200, {
      ok: true,
      appName: settings.appName,
      tagline: settings.tagline,
      telegramUrl: settings.telegramUrl,
      botUsername: String(botCfg.botUsername || settings.telegramBotUsername || "").replace(/^@/, ""),
      creditUsername: settings.creditUsername,
      contactUsername: settings.contactUsername,
      dailyLimit: quota.limit,
      autoDeleteHours: Number(botCfg.autoDeleteHours || settings.autoDeleteHours || 2),
      resetTimeIST: resetLabel(quota.resetHour),
      loginRequired: Boolean(settings.loginRequired),
      maintenanceMode: Boolean(settings.maintenanceMode),
      maintenanceMessage: String(settings.maintenanceMessage || ""),
      version: "5.0.0",
    });
  } catch (error) {
    fail(res, 500, "CONFIG_FAILED", error.message);
  }
});

/**
 * 🕛 Effective daily limit + reset hour.
 * Bot ka live config (admin BOT tab) authority hai; website settings sirf
 * fallback. Dono jagah SAME numbers dikhne chahiye — warna student confuse.
 */
function effectiveQuota(settings, botCfg) {
  const fromBot = Number((botCfg || {}).dailyLimit || 0);
  const fromSite = Number((settings || {}).dailyVideoLimit || 0);
  const limit = fromBot > 0 ? fromBot : fromSite > 0 ? fromSite : 20;
  const botHour = (botCfg || {}).dailyResetHourIST;
  const siteHour = (settings || {}).dailyResetHourIST;
  const hour = botHour !== undefined && botHour !== null && botHour !== "" ? Number(botHour) : Number(siteHour || 0);
  return { limit, resetHour: Number.isFinite(hour) ? hour : 0 };
}

/** 🕛 "12:00 AM" (IST) label — website ki ek-line quota UI ke liye */
function resetLabel(hour) {
  const h = ((Number(hour) || 0) % 24 + 24) % 24;
  if (h === 0) return "12:00 AM";
  if (h === 12) return "12:00 PM";
  return `${h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
}

/* ── student auth ──────────────────────────────────────────────────────── */
app.post("/api/auth/login", async (req, res) => {
  const ip = clientIp(req);
  const guard = rateHit(`student_login/${ipKey(ip)}`, 10, 600);
  if (!guard.allowed) return fail(res, 429, "RATE_LIMITED", "Too many login attempts. Try again in a few minutes.", { retryAfterSec: guard.retryAfterSec });

  const body = req.body || {};
  const identifier = String(body.identifier || body.email || body.userId || body.mobile || body.loginId || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!identifier || !password) return fail(res, 400, "MISSING_FIELDS", "Login id and password are required.");

  try {
    const accounts = (await store.get(ACCOUNTS_PATH)) || {};
    const account = accounts[accountKey(identifier)] || accounts[identifier];
    if (!account || typeof account !== "object") {
      await writeLog("login_failed", { identifier, ip, reason: "no_account" });
      return fail(res, 401, "INVALID_CREDENTIALS", "Wrong login id or password.");
    }
    if (account.disabled) return fail(res, 403, "ACCOUNT_DISABLED", "This account is disabled.");

    const expected = hashPassword(password, account.passwordSalt || "");
    const given = Buffer.from(String(account.passwordHash || ""), "hex");
    const actual = Buffer.from(expected, "hex");
    const ok = given.length === actual.length && crypto.timingSafeEqual(given, actual);
    if (!ok) {
      await writeLog("login_failed", { identifier, ip, reason: "bad_password" });
      return fail(res, 401, "INVALID_CREDENTIALS", "Wrong login id or password.");
    }

    const token = createStudentSession({
      uid: identifier,
      name: account.name || identifier,
      email: account.email || "",
      phone: account.phone || account.mobile || "",
    });
    setCookie(res, STUDENT_COOKIE, token, STUDENT_TTL_SEC);
    await store.update(`${ACCOUNTS_PATH}/${accountKey(identifier)}`, { lastLoginAt: Date.now(), lastLoginIp: ip });
    await writeLog("login_ok", { identifier, ip });
    return json(res, 200, { ok: true, uid: identifier, name: account.name || identifier });
  } catch (error) {
    return fail(res, 500, "LOGIN_FAILED", error.message);
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearCookie(res, STUDENT_COOKIE);
  json(res, 200, { ok: true });
});

app.get("/api/auth/session", async (req, res) => {
  const session = getStudent(req);
  if (!session) return json(res, 200, { ok: true, loggedIn: false });
  const [settings, botCfg] = await Promise.all([getSettings(), getBotConfig()]);
  const quota = effectiveQuota(settings, botCfg);
  return json(res, 200, {
    ok: true,
    loggedIn: true,
    uid: session.uid,
    name: session.name || session.uid,
    isAdmin: isAdmin(req),
    quota: { limit: quota.limit, resetTimeIST: resetLabel(quota.resetHour) },
  });
});

/* ── admin auth ────────────────────────────────────────────────────────── */
app.post("/api/admin/login", async (req, res) => {
  const ip = clientIp(req);
  const key = `local_paths/rate_limits/admin_login/${ipKey(ip)}`;
  const mirror = (await store.get(key)) || {};
  const now = Date.now();
  const recent = Array.isArray(mirror.hits) ? mirror.hits.filter((t) => now - Number(t) < 300000) : [];
  if (recent.length >= 5) {
    return fail(res, 429, "ADMIN_RATE_LIMITED", "Too many failed admin logins. Try again in 5 minutes.", {
      retryAfterSec: Math.ceil((300000 - (now - recent[0])) / 1000),
    });
  }

  const body = req.body || {};
  const ok = verifyAdminCredentials(String(body.email || ""), String(body.password || ""));
  if (!ok) {
    recent.push(now);
    await store.set(key, { hits: recent, ip });
    await writeLog("admin_login_failed", { ip, email: String(body.email || "").slice(0, 120) });
    return fail(res, 401, "INVALID_ADMIN", "Wrong admin email or password.");
  }

  await store.remove(key);
  setCookie(res, ADMIN_COOKIE, createAdminSession(), ADMIN_TTL_SEC);
  await writeLog("admin_login_ok", { ip });
  return json(res, 200, { ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  clearCookie(res, ADMIN_COOKIE);
  json(res, 200, { ok: true });
});

app.get("/api/admin/session", (req, res) => {
  json(res, 200, { ok: true, loggedIn: isAdmin(req), configured: isAdminEnvConfigured() });
});

/* ── guards ────────────────────────────────────────────────────────────── */
function requireStudent(req, res, next) {
  const session = getStudent(req);
  if (!session) return fail(res, 401, "LOGIN_REQUIRED", "Please login first.");
  req.student = session;
  return next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return fail(res, 403, "ADMIN_REQUIRED", "Admin login required.");
  return next();
}

/* ── courses ───────────────────────────────────────────────────────────── */
app.get("/api/batches", requireStudent, async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) return fail(res, 503, "MAINTENANCE", settings.maintenanceMessage || "Site under maintenance.");
    const batches = await listBatches();
    return json(res, 200, { ok: true, count: batches.length, batches });
  } catch (error) {
    return fail(res, 500, "LIST_FAILED", error.message);
  }
});

app.get("/api/batches/:id", requireStudent, async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(res, 400, "BAD_ID", "Invalid course id.");
  try {
    const batch = await getBatchTree(id);
    if (!batch) return fail(res, 404, "NOT_FOUND", "Course not found.");
    return json(res, 200, {
      ok: true,
      id: batch.id,
      name: batch.name,
      slug: batch.slug,
      thumbnail: batch.thumbnail,
      price: batch.price,
      source: batch.source,
      fileBacked: batch.fileBacked,
      counts: batch.counts,
      tree: batch.publicTree,
    });
  } catch (error) {
    return fail(res, 500, "TREE_FAILED", error.message);
  }
});

/* =============================================================================
   SECTION 8 · 🎬 Telegram delivery request (website → bot)
   ============================================================================= */

/** Bot ke request record ke liye safe (serializable) shape */
function serializableRequest(record) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value === undefined || typeof value === "function") continue;
    out[key] = value;
  }
  return out;
}

function shortId() {
  return crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * 🔁 Same lecture ki request pehle se active ho to NAYI request mat banao —
 *    wahi purani reuse karo (spam aur quota-waste dono rukte hain).
 *    Match key: uid + batchId + nodeId (nodeId course me unique hota hai).
 */
async function findReusableRequest({ uid, batchId, nodeId }) {
  if (!uid || !batchId || !nodeId) return null;
  const all = (await store.get(REQUESTS_PATH)) || {};
  const now = Date.now();
  for (const [id, record] of Object.entries(all && typeof all === "object" ? all : {})) {
    if (!record || typeof record !== "object") continue;
    if (String(record.uid || "") !== String(uid)) continue;
    if (String(record.batchId || "") !== String(batchId)) continue;
    if (String(record.nodeId || "") !== String(nodeId)) continue;
    const created = Number(record.createdAt || 0);
    if (!created || now - created > 6 * 3600 * 1000) continue; // 6h se purani nahi
    if (Number(record.usedCount || 0) >= Number(record.reuseLimit || 1)) continue; // already used up
    return { id, record };
  }
  return null;
}

async function cleanupExpiredRequests() {
  try {
    const all = (await store.get(REQUESTS_PATH)) || {};
    const ttlHours = 168;
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of Object.entries(all && typeof all === "object" ? all : {})) {
      const created = Number((record && record.createdAt) || 0);
      const used = Number((record && record.usedCount) || 0);
      const limit = Number((record && record.reuseLimit) || 1);
      if ((created && (now - created) / 3600000 > ttlHours) || used >= limit) {
        await store.remove(`${REQUESTS_PATH}/${id}`);
        removed += 1;
      }
    }
    return removed;
  } catch (_) {
    return 0;
  }
}

/** 🕛 IST day-window: aaj ke video count + midnight tak ka bacha waqt */
function istDayWindow(resetHour = 0) {
  const IST = 5 * 3600 + 30 * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const local = nowSec + IST;
  let dayStart = Math.floor(local / 86400) * 86400 + (Number(resetHour) || 0) * 3600;
  if (local < dayStart) dayStart -= 86400;
  const startUtc = dayStart - IST;
  return { startMs: startUtc * 1000, endMs: (startUtc + 86400) * 1000, resetInSec: startUtc + 86400 - nowSec };
}

app.get("/api/tg/quota", requireStudent, async (req, res) => {
  try {
    const [settings, botCfg] = await Promise.all([getSettings(), getBotConfig()]);
    const quota = effectiveQuota(settings, botCfg);
    const limit = quota.limit;
    const window = istDayWindow(quota.resetHour);
    // user ne aaj kitni request bheji (website side count)
    const all = (await store.get(REQUESTS_PATH)) || {};
    let used = 0;
    for (const record of Object.values(all && typeof all === "object" ? all : {})) {
      if (!record || typeof record !== "object") continue;
      if (String(record.uid || "") !== String(req.student.uid)) continue;
      if (Number(record.createdAt || 0) >= window.startMs && record.webQuota) used += 1;
    }
    return json(res, 200, {
      ok: true,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetTimeIST: resetLabel(quota.resetHour),
      resetInSec: window.resetInSec,
    });
  } catch (error) {
    return fail(res, 500, "QUOTA_FAILED", error.message);
  }
});

/**
 * 🛡️ POST /api/tg/request — anti-theft gate (order matters)
 *  1 login            401 LOGIN_REQUIRED
 *  2 per-user rate    429 RATE_LIMITED      (15 / 10 min)
 *  3 reuse            200 reused:true       (naya record nahi banta)
 *  4 per-IP rate      429 IP_RATE_LIMITED   (30 / 10 min)
 *  5 global breaker   503 GLOBAL_LIMIT
 *  6 daily limit      429 DAILY_LIMIT       (20/day, IST midnight reset)
 *  7 pending cap      429 TOO_MANY_PENDING
 *  8 source token     409 NO_SOURCE / YOUTUBE_ONLY
 */
app.post("/api/tg/request", requireStudent, async (req, res) => {
  const uid = String(req.student.uid);
  const ip = clientIp(req);
  const body = req.body || {};
  const batchId = String(body.batchId || "");
  const nodeId = String(body.nodeId || "");

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(batchId)) return fail(res, 400, "BAD_BATCH", "Invalid course id.");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(nodeId)) return fail(res, 400, "BAD_NODE", "Invalid lecture id.");

  try {
    const [settings, botCfg, batch] = await Promise.all([getSettings(), getBotConfig(), getBatchTree(batchId)]);
    if (!batch) return fail(res, 404, "NOT_FOUND", "Course not found.");

    // layer 2 — per-user
    const perUser = rateHit(`tg_user/${uid}`, 15, 600);
    if (!perUser.allowed) return fail(res, 429, "RATE_LIMITED", "Too many requests. Please wait a few minutes.", { retryAfterSec: perUser.retryAfterSec });

    // layer 3 — 🔁 REUSE: is lecture ki request pehle se active hai to wahi
    //   deep link wapas do. Naya record banta nahi, isliye yeh check daily/pending
    //   cap se PEHLE hai — warna student apni hi active request dobara na khol paye.
    const reusable = await findReusableRequest({ uid, batchId, nodeId });
    if (reusable) {
      return json(res, 200, {
        ok: true,
        reused: true,
        requestId: reusable.id,
        deepLink: botDeepLink(botCfg, reusable.id),
        message: "Your request is already active — open it in Telegram.",
      });
    }

    // layer 3 — per-IP
    const perIp = rateHit(`tg_ip/${ipKey(ip)}`, 30, 600);
    if (!perIp.allowed) return fail(res, 429, "IP_RATE_LIMITED", "Too many requests from this network.", { retryAfterSec: perIp.retryAfterSec });

    // layer 4 — global breaker
    const globalLimit = Number(botCfg.globalDailyLimit || 500);
    if (globalLimit > 0) {
      const window = istDayWindow(effectiveQuota(settings, botCfg).resetHour);
      const all = (await store.get(REQUESTS_PATH)) || {};
      let today = 0;
      for (const record of Object.values(all && typeof all === "object" ? all : {})) {
        if (record && typeof record === "object" && Number(record.createdAt || 0) >= window.startMs) today += 1;
      }
      if (today >= globalLimit) return fail(res, 503, "GLOBAL_LIMIT", "Daily delivery limit reached for the site. Try again after midnight.");
    }

    // layer 5 — daily per-user limit (20/day, IST midnight reset)
    const quotaCfg = effectiveQuota(settings, botCfg);
    const dailyLimit = quotaCfg.limit;
    const window = istDayWindow(quotaCfg.resetHour);
    const all = (await store.get(REQUESTS_PATH)) || {};
    let usedToday = 0;
    let pending = 0;
    for (const record of Object.values(all && typeof all === "object" ? all : {})) {
      if (!record || typeof record !== "object") continue;
      if (String(record.uid || "") !== uid) continue;
      const created = Number(record.createdAt || 0);
      if (created >= window.startMs && record.webQuota) usedToday += 1;
      if (String(record.status || "pending") === "pending") pending += 1;
    }
    if (dailyLimit > 0 && usedToday >= dailyLimit) {
      return fail(res, 429, "DAILY_LIMIT", `You have used all ${dailyLimit} videos for today. The limit resets at ${resetLabel(Number(settings.dailyResetHourIST || 0))} (Indian time).`, {
        resetInSec: window.resetInSec,
        resetTimeIST: resetLabel(quotaCfg.resetHour),
      });
    }

    // layer 6 — pending cap
    const maxPending = Number(botCfg.maxPendingPerUser || 3);
    if (maxPending > 0 && pending >= maxPending) {
      return fail(res, 429, "TOO_MANY_PENDING", "You already have requests waiting. Open Telegram and let them finish first.");
    }

    // layer 7 — source token
    const located = findNodeById(batch.tree, nodeId);
    if (!located) return fail(res, 404, "NODE_NOT_FOUND", "This lecture is not in the course.");
    const node = located.node;
    // 📄 Video token na ho to PDF token chalta hai — dono Telegram se hi jaate hain
    const videoToken = String(node.tg_video_token || "");
    const pdfToken = String(node.tg_pdf_token || "");
    const token = videoToken || pdfToken;
    const mediaKind = videoToken ? "video" : pdfToken ? "pdf" : "";
    if (!token) {
      const youtubeOnly = Boolean(node.youtube_url || node.youtubeUrl);
      return fail(
        res,
        409,
        youtubeOnly ? "YOUTUBE_ONLY" : "NO_SOURCE",
        youtubeOnly
          ? "This lecture is not available on Telegram yet. It will be uploaded soon."
          : "This lecture has no Telegram source yet. It will be uploaded soon."
      );
    }
    const source = readMediaToken(token);
    if (!source || !source.chatId || !source.messageId) {
      return fail(res, 409, "NO_SOURCE", "This lecture link is not valid any more. Please ask admin to re-add it.");
    }

    const id = shortId();
    const record = {
      id,
      uid,
      ip: ipKey(ip),
      title: String(node.title || body.title || "Lecture"),
      mediaKind,
      courseName: String(batch.name || ""),
      course: String(batch.name || ""),
      batchId,
      nodeId,
      topic: located.trail.slice(0, -1).join(" > "),
      folderPath: located.trail.slice(0, -1).join(" > "),
      part: Number(node.part || 0) || undefined,
      fileType: mediaKind === "pdf" ? "document" : undefined,
      fileSize: Number(source.size || 0) || undefined,
      chatId: source.chatId,
      messageId: source.messageId,
      status: "pending",
      usedCount: 0,
      reuseLimit: Number(botCfg.requestReuseLimit || 1),
      boundTgUid: "",
      webQuota: true,
      createdAt: Date.now(),
      source: "website",
    };
    await store.set(`${REQUESTS_PATH}/${id}`, serializableRequest(record));
    await writeLog("tg_request", { uid, batchId, nodeId, requestId: id, ip: ipKey(ip) });
    cleanupExpiredRequests().catch(() => {});

    return json(res, 200, {
      ok: true,
      requestId: id,
      deepLink: botDeepLink(botCfg, id),
      remaining: Math.max(0, dailyLimit - (usedToday + 1)),
      limit: dailyLimit,
      resetTimeIST: resetLabel(quotaCfg.resetHour),
      message: "Request created. Open it in Telegram to receive the video.",
    });
  } catch (error) {
    await writeLog("tg_request_error", { uid, batchId, nodeId, error: String(error.message || error).slice(0, 300) });
    return fail(res, 500, "REQUEST_FAILED", error.message);
  }
});

/** t.me/<bot>?start=req_<id> */
function botDeepLink(botCfg, requestId) {
  const username = String(botCfg.botUsername || env("TELEGRAM_BOT_USERNAME", "")).replace(/^@/, "");
  if (!username) return "";
  return `https://t.me/${username}?start=req_${requestId}`;
}

app.get("/api/tg/request/:id", requireStudent, async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return fail(res, 400, "BAD_REQUEST_ID", "Invalid request id.");
  const record = await store.get(`${REQUESTS_PATH}/${id}`);
  if (!record || typeof record !== "object") return fail(res, 404, "NOT_FOUND", "Request not found or expired.");
  if (String(record.uid || "") !== String(req.student.uid)) {
    return fail(res, 403, "FORBIDDEN", "This request belongs to another account.");
  }
  const [settings, botCfg] = await Promise.all([getSettings(), getBotConfig()]);
  return json(res, 200, {
    ok: true,
    id,
    title: record.title,
    courseName: record.courseName,
    status: record.status || "pending",
    usedCount: Number(record.usedCount || 0),
    boundTgUid: record.boundTgUid ? "***" : "",
    createdAt: Number(record.createdAt || 0),
    deepLink: botDeepLink(botCfg, id),
    autoDeleteHours: Number(settings.autoDeleteHours || 2),
  });
});

/* =============================================================================
   SECTION 9 · 🛠 admin API
   ============================================================================= */

app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  try {
    const [batches, requests, accounts, botState, botCfg, settings] = await Promise.all([
      listBatches(),
      store.get(REQUESTS_PATH),
      store.get(ACCOUNTS_PATH),
      store.get("bot_state"),
      getBotConfig(),
      getSettings(),
    ]);
    const reqMap = requests && typeof requests === "object" ? requests : {};
    const users = (botState && botState.users) || {};
    const quota = effectiveQuota(settings, botCfg);
    const window = istDayWindow(quota.resetHour);
    let today = 0;
    for (const record of Object.values(reqMap)) {
      if (record && typeof record === "object" && Number(record.createdAt || 0) >= window.startMs) today += 1;
    }
    return json(res, 200, {
      ok: true,
      courses: batches.length,
      videos: batches.reduce((sum, b) => sum + Number(b.videos || 0), 0),
      requests: Object.keys(reqMap).length,
      requestsToday: today,
      students: Object.keys(accounts && typeof accounts === "object" ? accounts : {}).length,
      botUsers: Object.keys(users && typeof users === "object" ? users : {}).length,
      heartbeat: (botState && botState.heartbeat) || null,
      backend: store.backend,
      deliveryMode: String(botCfg.deliveryMode || "auto"),
      dailyLimit: quota.limit,
      resetTimeIST: resetLabel(quota.resetHour),
    });
  } catch (error) {
    return fail(res, 500, "OVERVIEW_FAILED", error.message);
  }
});

/* ── settings ──────────────────────────────────────────────────────────── */
app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  const [settings, botCfg] = await Promise.all([getSettings(), getBotConfig()]);
  json(res, 200, { ok: true, settings, botConfig: botCfg });
});

app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    "appName", "tagline", "telegramUrl", "telegramBotUsername", "creditUsername", "contactUsername",
    "dailyVideoLimit", "autoDeleteHours", "dailyResetHourIST", "loginRequired", "allowSignup",
    "maintenanceMode", "maintenanceMessage",
  ];
  const clean = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (["dailyVideoLimit", "autoDeleteHours", "dailyResetHourIST"].includes(key)) {
      const value = Number(patch[key]);
      if (!Number.isFinite(value)) continue;
      clean[key] = Math.max(0, Math.min(key === "dailyResetHourIST" ? 23 : 10000, Math.round(value)));
      continue;
    }
    if (["loginRequired", "allowSignup", "maintenanceMode"].includes(key)) {
      clean[key] = Boolean(patch[key]);
      continue;
    }
    clean[key] = String(patch[key]).slice(0, 400);
  }
  await store.update(SETTINGS_PATH, clean);
  await writeLog("settings_update", Object.keys(clean).reduce((acc, k) => Object.assign(acc, { [k]: clean[k] }), {}));
  json(res, 200, { ok: true, updated: Object.keys(clean), settings: await getSettings() });
});

/* ── 🔗 Add by URL (Telegram post link → node par attach) ──────────────── */
app.post("/api/admin/telegram/attach", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const batchId = String(body.batchId || "");
  const nodeId = String(body.nodeId || "");
  const url = String(body.url || "").trim();
  const title = String(body.title || "").trim();
  // "video" (default) ya "pdf" — pdf par tg_pdf_token banta hai
  const wantsPdf = String(body.kind || body.type || "video").toLowerCase() === "pdf";

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(batchId)) return fail(res, 400, "BAD_BATCH", "Invalid course id.");
  const parsed = parseTelegramPostLink(url);
  if (!parsed) {
    return fail(res, 400, "BAD_LINK", "That is not a valid Telegram post link. Example: https://t.me/channelname/1234");
  }

  try {
    const batch = await getBatchTree(batchId);
    if (!batch) return fail(res, 404, "NOT_FOUND", "Course not found.");

    const token = makeMediaToken({
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      kind: wantsPdf ? "p" : "v",
      size: Number(body.size || 0),
      name: title || "",
    });
    const tokenField = wantsPdf ? "tg_pdf_token" : "tg_video_token";

    const meta = {
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      kind: parsed.kind,
      attachedAt: Date.now(),
      link: parsed.link,
    };

    // 🧩 MINIMAL OVERLAY: sirf badla hua node DB me jaata hai (poora tree copy nahi).
    //    File-backed course ki JSON file kabhi modify nahi hoti — read par overlay
    //    tree merge ho jaata hai (getBatchTree → mergeOverlay).
    let targetId = nodeId;
    let patchNode;
    if (targetId) {
      const located = findNodeById(batch.tree, targetId);
      if (!located) return fail(res, 404, "NODE_NOT_FOUND", "Lecture not found in this course.");
      patchNode = {
        id: targetId,
        [tokenField]: token,
        tg_meta: Object.assign({ media: wantsPdf ? "pdf" : "video" }, meta),
        source: "telegram_admin",
      };
      if (title) patchNode.title = title.slice(0, 200);
    } else {
      const parentId = String(body.parentNodeId || "");
      if (parentId && !findNodeById(batch.tree, parentId)) {
        return fail(res, 404, "PARENT_NOT_FOUND", "Folder not found in this course.");
      }
      targetId = `${wantsPdf ? "tgp" : "tgv"}_${parsed.messageId}_${Date.now().toString(36)}`;
      patchNode = {
        id: targetId,
        parent_id: parentId || "-1",
        title: (title || `Telegram ${wantsPdf ? "PDF" : "lecture"} ${parsed.messageId}`).slice(0, 200),
        type: wantsPdf ? "FILE" : "VIDEO",
        thumbnail: "",
        uploaded_at: new Date().toISOString(),
        [tokenField]: token,
        tg_meta: Object.assign({ media: wantsPdf ? "pdf" : "video" }, meta),
        source: "telegram_admin",
      };
    }

    const existing = (await store.get(`${CUSTOM_BATCH_PATH}/${batchId}`)) || {};
    const existingTree = Array.isArray(existing.tree) ? JSON.parse(JSON.stringify(existing.tree)) : [];
    const tree = mergeOverlay(existingTree, [patchNode]);

    await store.update(`${CUSTOM_BATCH_PATH}/${batchId}`, {
      id: batchId,
      name: String(existing.name || batch.name),
      tree,
      updatedAt: Date.now(),
      source: String(existing.source || batch.source || "custom"),
      telegramAttached: true,
    });
    await writeLog("telegram_attach", {
      batchId,
      nodeId: targetId,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      kind: parsed.kind,
      media: wantsPdf ? "pdf" : "video",
    });
    return json(res, 200, {
      ok: true,
      batchId,
      nodeId: targetId,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      channelKind: parsed.kind,
      media: wantsPdf ? "pdf" : "video",
      deliveryHint: parsed.kind === "public" ? "forward (public source)" : "download + upload (private source)",
    });
  } catch (error) {
    return fail(res, 500, "ATTACH_FAILED", error.message);
  }
});

/* ── 🤖 bot state/config/tasks ─────────────────────────────────────────── */
app.get("/api/admin/bot", requireAdmin, async (req, res) => {
  const [cfg, heartbeat, users, stats, requests, groups] = await Promise.all([
    getBotConfig(),
    store.get("bot_state/heartbeat"),
    store.get("bot_state/users"),
    store.get("bot_state/stats"),
    store.get(REQUESTS_PATH),
    store.get(GROUPS_PATH),
  ]);
  const safeUsers = Object.entries(users && typeof users === "object" ? users : {}).map(([id, u]) => ({
    id,
    username: (u && u.username) || "",
    totalVideos: Number((u && u.totalVideos) || 0),
    banned: Boolean(u && u.banned),
    lastSeen: Number((u && u.lastSeen) || 0),
  }));
  json(res, 200, {
    ok: true,
    config: cfg,
    heartbeat: heartbeat || null,
    stats: stats || {},
    users: safeUsers.slice(0, 200),
    requests: Object.entries(requests && typeof requests === "object" ? requests : {})
      .map(([id, r]) => ({
        id,
        uid: (r && r.uid) || "",
        title: (r && r.title) || "",
        courseName: (r && r.courseName) || "",
        status: (r && r.status) || "pending",
        usedCount: Number((r && r.usedCount) || 0),
        createdAt: Number((r && r.createdAt) || 0),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200),
    groups: Object.entries(groups && typeof groups === "object" ? groups : {}).map(([key, g]) => ({
      key,
      title: (g && g.title) || "",
      chatId: String((g && g.chatId) || ""),
      items: Number((g && g.itemCount) || 0),
      lastScanAt: Number((g && g.lastScanAt) || 0),
    })),
  });
});

app.put("/api/admin/bot/config", requireAdmin, async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    "dailyLimit", "autoDeleteHours", "maxUploadMb", "deliveryMode", "globalDailyLimit",
    "requestReuseLimit", "requestCooldownMin", "maxPendingPerUser", "requestTtlHours",
    "creditUsername", "contactUsername", "joinGateEnabled", "joinGateChannel", "joinGateInviteUrl",
    "paused", "dailyResetHourIST",
  ];
  const clean = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (["dailyLimit", "autoDeleteHours", "maxUploadMb", "globalDailyLimit", "requestReuseLimit", "requestCooldownMin", "maxPendingPerUser", "requestTtlHours", "dailyResetHourIST"].includes(key)) {
      const value = Number(patch[key]);
      if (!Number.isFinite(value)) continue;
      clean[key] = Math.max(0, value);
      continue;
    }
    if (["joinGateEnabled", "paused"].includes(key)) {
      clean[key] = Boolean(patch[key]);
      continue;
    }
    if (key === "deliveryMode") {
      const value = String(patch[key]).toLowerCase();
      if (!["auto", "clean", "forward"].includes(value)) continue;
      clean[key] = value;
      continue;
    }
    clean[key] = String(patch[key]).slice(0, 300);
  }
  await store.update(BOT_CONFIG_PATH, clean);
  await writeLog("bot_config", clean);
  json(res, 200, { ok: true, updated: Object.keys(clean), config: await getBotConfig() });
});

app.post("/api/admin/bot/tasks", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || "scan_group");
  if (type !== "scan_group") return fail(res, 400, "BAD_TASK", "Only scan_group tasks are supported.");
  const invite = String(body.invite || "").trim();
  const chatId = String(body.chatId || "").trim();
  const channelRegex = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{4,20})$/;
  const inviteRegex = /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\/[A-Za-z0-9_+/=-]{2,80}$/;
  if (!inviteRegex.test(invite) && !channelRegex.test(chatId)) {
    return fail(res, 400, "BAD_SOURCE", "Provide a valid invite link (https://t.me/+xxxx) or channel id (@name / -100xxxx).");
  }
  const id = `task_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  await store.set(`${BOT_TASKS_PATH}/${id}`, {
    id,
    type,
    invite: invite || undefined,
    chatId: chatId || undefined,
    batchId: String(body.batchId || "") || undefined,
    status: "queued",
    createdAt: Date.now(),
    createdBy: "admin_panel",
  });
  await writeLog("bot_task", { id, type, chatId, invite: invite ? "set" : "" });
  json(res, 200, { ok: true, taskId: id, message: "Task queued. The bot will pick it up when it is online." });
});

/* ── 👥 student accounts ───────────────────────────────────────────────── */
app.get("/api/admin/accounts", requireAdmin, async (req, res) => {
  const accounts = (await store.get(ACCOUNTS_PATH)) || {};
  const list = Object.entries(accounts && typeof accounts === "object" ? accounts : {})
    .filter(([, a]) => a && typeof a === "object" && (a.passwordHash || a.passwordSalt))
    .map(([key, a]) => ({
    uid: String((a && a.uid) || key),
    name: (a && a.name) || "",
    email: (a && a.email) || "",
    phone: (a && a.phone) || (a && a.mobile) || "",
    disabled: Boolean(a && a.disabled),
    createdAt: Number((a && a.createdAt) || 0),
    lastLoginAt: Number((a && a.lastLoginAt) || 0),
  }));
  json(res, 200, { ok: true, count: list.length, accounts: list.sort((a, b) => b.lastLoginAt - a.lastLoginAt) });
});

app.post("/api/admin/accounts", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const uid = String(body.uid || body.email || body.mobile || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[a-z0-9._@+-]{3,64}$/.test(uid)) return fail(res, 400, "BAD_UID", "Login id must be 3-64 chars (letters, numbers, . _ @ + -).");
  if (password.length < 4) return fail(res, 400, "BAD_PASSWORD", "Password must be at least 4 characters.");
  const accounts = (await store.get(ACCOUNTS_PATH)) || {};
  if (accounts[uid]) return fail(res, 409, "EXISTS", "That login id already exists.");
  const record = Object.assign(
    {
      uid,
      name: String(body.name || uid).slice(0, 120),
      email: String(body.email || "").slice(0, 160),
      phone: String(body.phone || body.mobile || "").slice(0, 30),
      disabled: false,
      createdAt: Date.now(),
    },
    makePassword(password)
  );
  await store.set(`${ACCOUNTS_PATH}/${accountKey(uid)}`, record);
  await writeLog("account_create", { uid });
  json(res, 200, { ok: true, uid, message: "Student account created." });
});

app.put("/api/admin/accounts/:uid", requireAdmin, async (req, res) => {
  const uid = accountKey(req.params.uid);
  const accounts = (await store.get(ACCOUNTS_PATH)) || {};
  if (!accounts[uid]) return fail(res, 404, "NOT_FOUND", "Account not found.");
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).slice(0, 120);
  if (req.body.disabled !== undefined) patch.disabled = Boolean(req.body.disabled);
  if (req.body.password) Object.assign(patch, makePassword(String(req.body.password)));
  await store.update(`${ACCOUNTS_PATH}/${uid}`, patch);
  await writeLog("account_update", { uid, fields: Object.keys(patch) });
  json(res, 200, { ok: true, updated: Object.keys(patch) });
});

app.delete("/api/admin/accounts/:uid", requireAdmin, async (req, res) => {
  const uid = accountKey(req.params.uid);
  await store.remove(`${ACCOUNTS_PATH}/${uid}`);
  await writeLog("account_delete", { uid });
  json(res, 200, { ok: true });
});

/* ── 📋 logs ───────────────────────────────────────────────────────────── */
app.get("/api/admin/logs", requireAdmin, async (req, res) => {
  const kind = String(req.query.kind || "");
  const logs = (await store.get(LOGS_PATH)) || {};
  const out = [];
  for (const [name, entries] of Object.entries(logs && typeof logs === "object" ? logs : {})) {
    if (kind && name !== kind) continue;
    for (const [stamp, entry] of Object.entries(entries && typeof entries === "object" ? entries : {})) {
      out.push({ kind: name, at: Number(stamp), data: entry });
    }
  }
  out.sort((a, b) => b.at - a.at);
  json(res, 200, { ok: true, count: out.length, logs: out.slice(0, Number(req.query.limit || 300)) });
});

/* ── 🗑 Telegram purge (danger zone) ───────────────────────────────────── */
const PURGE_DEFAULTS = {
  stripLinks: true,
  deleteTelegramNodes: false,
  deleteTelegramCourses: false,
  clearGroupRegistry: true,
  clearRequests: true,
  clearEmbeds: true,
  clearBotState: false,
};

function purgeOptions(body) {
  const out = {};
  for (const [key, value] of Object.entries(PURGE_DEFAULTS)) {
    out[key] = body && body[key] !== undefined ? Boolean(body[key]) : value;
  }
  return out;
}

const TELEGRAM_NODE_PREFIXES = ["tgv_", "tgp_", "tg_"];

function isTelegramNode(node) {
  const id = String((node && node.id) || "");
  return (
    Boolean(node && (node.tg_video_token || node.tg_pdf_token)) ||
    String((node && node.source) || "") === "telegram_auto_sync" ||
    TELEGRAM_NODE_PREFIXES.some((p) => id.startsWith(p))
  );
}

function walkTree(nodes, visit) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== "object") continue;
    visit(node);
    if (Array.isArray(node.children)) walkTree(node.children, visit);
  }
}

async function computePurge(options) {
  const [custom, meta, groups, requests, botState, deleted] = await Promise.all([
    store.get(CUSTOM_BATCH_PATH),
    store.get(BATCH_META_PATH),
    store.get(GROUPS_PATH),
    store.get(REQUESTS_PATH),
    store.get("bot_state"),
    store.get(DELETED_PATH),
  ]);
  const plan = {
    courses: [],
    nodesStripped: 0,
    nodesDeleted: 0,
    coursesDeleted: 0,
    groupsCleared: Object.keys(groups && typeof groups === "object" ? groups : {}).length,
    requestsCleared: Object.keys(requests && typeof requests === "object" ? requests : {}).length,
    botStateCleared: Boolean(botState),
    protectedCourses: [],
  };

  for (const [id, data] of Object.entries(custom && typeof custom === "object" ? custom : {})) {
    if (!data || typeof data !== "object") continue;
    const fileBacked = isFileBackedBatch(id);
    const telegramCourse = String(data.source || "") === "telegram_auto_sync" && !fileBacked;
    let nodes = 0;
    walkTree(data.tree, (node) => {
      if (isTelegramNode(node)) nodes += 1;
    });
    plan.courses.push({ id, name: String(data.name || id), fileBacked, telegramCourse, telegramNodes: nodes });
    if (fileBacked) plan.protectedCourses.push(String(data.name || id));
    if (options.deleteTelegramCourses && telegramCourse) plan.coursesDeleted += 1;
    if (options.stripLinks || options.deleteTelegramNodes) {
      if (options.deleteTelegramNodes) plan.nodesDeleted += nodes;
      else plan.nodesStripped += nodes;
    }
  }

  // file-backed courses: sirf DB override strip hoga, file kabhi touch nahi
  for (const [id, data] of loadFileBatches().entries()) {
    const override = (meta && meta[id]) || {};
    if (Object.keys(override).length) plan.protectedCourses.push(String(data.name || id));
  }

  return plan;
}

async function runPurge(options) {
  const result = { ok: true, errors: [], changed: {} };
  const custom = (await store.get(CUSTOM_BATCH_PATH)) || {};

  for (const [id, data] of Object.entries(custom && typeof custom === "object" ? custom : {})) {
    if (!data || typeof data !== "object") continue;
    const fileBacked = isFileBackedBatch(id);
    const telegramCourse = String(data.source || "") === "telegram_auto_sync" && !fileBacked;

    try {
      if (options.deleteTelegramCourses && telegramCourse) {
        await store.remove(`${CUSTOM_BATCH_PATH}/${id}`);
        await store.update(DELETED_PATH, { [id]: { at: Date.now(), reason: "telegram_purge" } });
        result.changed[`course_deleted:${id}`] = true;
        continue;
      }

      if (options.stripLinks || options.deleteTelegramNodes) {
        const tree = JSON.parse(JSON.stringify(Array.isArray(data.tree) ? data.tree : []));
        let stripped = 0;
        let removedNodes = 0;
        const prune = (nodes) => {
          const out = [];
          for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            if (Array.isArray(node.children)) node.children = prune(node.children);
            if (isTelegramNode(node)) {
              if (options.deleteTelegramNodes && !fileBacked) {
                removedNodes += 1;
                continue; // node hi hata do (DB-only course me safe)
              }
              delete node.tg_video_token;
              delete node.tg_pdf_token;
              delete node.tg_meta;
              node.pdf_link_enc = "";
              node.source = "purged";
              stripped += 1;
            }
            out.push(node);
          }
          return out;
        };
        const newTree = prune(tree);
        await store.update(`${CUSTOM_BATCH_PATH}/${id}`, {
          tree: newTree,
          purgedTelegramAt: Date.now(),
        });
        result.changed[`course:${id}`] = { stripped, removedNodes };
      }
    } catch (error) {
      result.errors.push(`${id}: ${error.message}`);
    }
  }

  if (options.clearGroupRegistry) {
    await store.remove(GROUPS_PATH);
    result.changed.groups = true;
  }
  if (options.clearRequests) {
    await store.remove(REQUESTS_PATH);
    result.changed.requests = true;
  }
  if (options.clearEmbeds) {
    await store.remove("telegram_vault/embeds");
    result.changed.embeds = true;
  }
  if (options.clearBotState) {
    for (const key of ["users", "deletions", "stats", "tasks", "events"]) {
      await store.remove(`bot_state/${key}`);
    }
    result.changed.botState = true; // config kabhi clear nahi hota
  }

  const stamp = Date.now();
  await store.set(`${LOGS_PATH}/telegram_purge/${stamp}`, { at: stamp, options, changed: result.changed, errors: result.errors });
  return result;
}

app.get("/api/admin/purge/preview", requireAdmin, async (req, res) => {
  try {
    const options = purgeOptions(req.query);
    const plan = await computePurge(options);
    json(res, 200, { ok: true, options, plan });
  } catch (error) {
    fail(res, 500, "PREVIEW_FAILED", error.message);
  }
});

app.post("/api/admin/purge", requireAdmin, async (req, res) => {
  const confirm = String((req.body || {}).confirm || "");
  if (confirm.toUpperCase() !== "PURGE") {
    return fail(res, 400, "CONFIRM_REQUIRED", 'Type "PURGE" in the confirm box to run this.');
  }
  try {
    const options = purgeOptions(req.body || {});
    const result = await runPurge(options);
    await writeLog("purge_run", { options, errors: result.errors.length });
    return json(res, 200, result);
  } catch (error) {
    return fail(res, 500, "PURGE_FAILED", error.message);
  }
});

/* ── 📁 admin course list (file-backed + custom, hidden ke saath) ──────── */
app.get("/api/admin/batches", requireAdmin, async (req, res) => {
  const batches = await listBatches();
  json(res, 200, { ok: true, count: batches.length, batches });
});

app.post("/api/admin/batches", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  if (!name) return fail(res, 400, "BAD_NAME", "Course name is required.");
  const id = String(body.id || `custom_${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
  if (isFileBackedBatch(id)) return fail(res, 409, "FILE_BACKED", "A file-backed course with this id exists. Use another id.");
  await store.set(`${CUSTOM_BATCH_PATH}/${id}`, {
    id,
    name: name.slice(0, 200),
    slug: String(body.slug || "").slice(0, 120),
    thumbnail: String(body.thumbnail || "").slice(0, 600),
    price: String(body.price || "").slice(0, 40),
    source: String(body.source || "custom"),
    tree: Array.isArray(body.tree) ? body.tree : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await writeLog("batch_create", { id, name });
  json(res, 200, { ok: true, id });
});

app.put("/api/admin/batches/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  const body = req.body || {};
  const patch = { updatedAt: Date.now() };
  for (const key of ["name", "slug", "thumbnail", "price", "hidden"]) {
    if (body[key] === undefined) continue;
    patch[key] = key === "hidden" ? Boolean(body[key]) : String(body[key]).slice(0, 600);
  }
  // file-backed course ki JSON file read-only hai → override site_settings/batch_meta me
  if (isFileBackedBatch(id)) {
    await store.update(`${BATCH_META_PATH}/${id}`, patch);
  } else {
    await store.update(`${CUSTOM_BATCH_PATH}/${id}`, patch);
  }
  await writeLog("batch_update", { id, fields: Object.keys(patch) });
  json(res, 200, { ok: true, id, updated: Object.keys(patch) });
});

app.delete("/api/admin/batches/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  if (isFileBackedBatch(id)) {
    // file delete nahi karni — sirf website se hide
    await store.update(DELETED_PATH, { [id]: { at: Date.now(), reason: "admin_hide" } });
    await writeLog("batch_hide", { id });
    return json(res, 200, { ok: true, id, hidden: true, message: "File-backed course hidden (file untouched)." });
  }
  await store.remove(`${CUSTOM_BATCH_PATH}/${id}`);
  await store.update(DELETED_PATH, { [id]: { at: Date.now(), reason: "admin_delete" } });
  await writeLog("batch_delete", { id });
  json(res, 200, { ok: true, id, deleted: true });
});

/* =============================================================================
   SECTION 10 · static site + start
   ============================================================================= */

// assets dono tarah serve hote hain: /site/style.css (Vercel static layer jaisa)
// aur /style.css (local express) — index.html /site/* use karta hai.
app.use("/site", express.static(path.join(HERE, "site"), { index: false, maxAge: IS_PROD ? "1h" : 0 }));
app.use(express.static(path.join(HERE, "site"), { index: false, maxAge: IS_PROD ? "1h" : 0 }));

app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(HERE, "index.html"));
});

// SPA-ish fallback: unknown GET (non-api) → index.html
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(HERE, "index.html"));
});

app.use((req, res) => {
  json(res, 404, { ok: false, error: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` });
});

app.use((error, req, res, next) => {
  console.error("server error:", error.message);
  if (res.headersSent) return next(error);
  return json(res, 500, { ok: false, error: "SERVER_ERROR", message: IS_PROD ? "Internal server error." : error.message });
});

function main() {
  try {
    getMasterSecret(); // prod me secret missing → loud fail
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  initFirebase();

  const server = app.listen(PORT, HOST, () => {
    console.log(`✅ Study helper Doc server on http://${HOST}:${PORT}  (backend: ${store.backend})`);
    console.log(`   courses: ${loadFileBatches().size} file-backed · admin: ${isAdminEnvConfigured() ? "configured" : "NOT configured"}`);
  });

  server.on("error", (error) => {
    console.error("❌ server failed to start:", error.message);
    process.exit(1);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      console.log(`\n${signal} received — closing server`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
  return server;
}

/* =============================================================================
   SECTION 11 · ✅ offline self-test — `node server.js --selftest`
   ============================================================================= */

function selfTest() {
  const failures = [];
  const check = (name, cond, extra) => {
    console.log(`   ${cond ? "✅" : "❌"} ${name}${!cond && extra !== undefined ? "  → " + JSON.stringify(extra) : ""}`);
    if (!cond) failures.push(name);
  };

  console.log("\n── 🔐 vault crypto (bot/bot.py ke saath byte-compatible) ──────");
  const secretOk = getMasterSecret().length >= 16;
  check("master secret available", secretOk);
  const payload = { c: "@physicswallah", m: 123456, k: "v", s: 400 * 1024 * 1024, n: "Solid State Part 1" };
  const cipherText = encryptVaultJson(payload);
  check("vault cipher format v1.iv.tag.ct", cipherText.split(".").length === 4 && cipherText.startsWith("v1."));
  const round = decryptVaultJson(cipherText);
  check("vault round-trip", round && round.c === payload.c && round.m === payload.m, round);
  const tampered = cipherText.slice(0, -4) + "AAAA";
  check("tampered vault rejected", decryptVaultJson(tampered) === null);
  check("garbage vault rejected", decryptVaultJson("v1.aa.bb.cc") === null && decryptVaultJson("") === null);

  console.log("\n── 🎬 media token (node ka Telegram source) ───────────────────");
  let tokenRoundTrips = 0;
  for (let i = 0; i < 40; i += 1) {
    const token = makeMediaToken({
      chatId: i % 2 ? `-100${1000000000 + i}` : `@channel_${i}`,
      messageId: 1000 + i * 7,
      kind: i % 3 === 0 ? "p" : "v",
      size: i * 1234567,
      name: `Lecture ${i} — ठोस अवस्था`,
    });
    const read = readMediaToken(token);
    if (read && read.messageId === 1000 + i * 7 && read.chatId === (i % 2 ? `-100${1000000000 + i}` : `@channel_${i}`)) {
      tokenRoundTrips += 1;
    }
  }
  check("40/40 token round-trips (base64url `_` safe)", tokenRoundTrips === 40, tokenRoundTrips);
  const stableA = makeMediaToken({ chatId: "@x", messageId: 5, kind: "v", ttlDays: 30 });
  const stableB = makeMediaToken({ chatId: "@x", messageId: 5, kind: "v", ttlDays: 30 });
  check("same source → same token (deterministic IV)", stableA === stableB);
  check("different message → different token", makeMediaToken({ chatId: "@x", messageId: 6 }) !== stableA);
  const expired = makeMediaToken({ chatId: "@x", messageId: 9, ttlDays: -1 });
  check("expired token rejected", readMediaToken(expired) === null, readMediaToken(expired));
  const neverExpires = makeMediaToken({ chatId: "@x", messageId: 10, ttlDays: 0 });
  check("ttlDays 0 = never expires", readMediaToken(neverExpires) !== null);
  check("garbage token rejected", readMediaToken("tg_a_b_c") === null && readMediaToken("") === null);

  console.log("\n── 🔗 Telegram post link parsing ─────────────────────────────");
  const pub = parseTelegramPostLink("https://t.me/physicswallah/123456");
  check("public link", pub && pub.chatId === "@physicswallah" && pub.messageId === 123456 && pub.kind === "public", pub);
  const prv = parseTelegramPostLink("https://t.me/c/1987654321/777");
  check("private link → -100 id", prv && prv.chatId === "-1001987654321" && prv.messageId === 777 && prv.kind === "private", prv);
  const forum = parseTelegramPostLink("https://t.me/somegroup/42/43");
  check("forum topic link (last id wins)", forum && forum.messageId === 43, forum);
  check("no scheme ok", parseTelegramPostLink("t.me/physicswallah/12") !== null, parseTelegramPostLink("t.me/physicswallah/12"));
  check("trailing slash ok", parseTelegramPostLink("https://t.me/physicswallah/12/") !== null);
  check("short handle rejected (Telegram rule: 5+ chars)", parseTelegramPostLink("https://t.me/abc/12") === null);
  check("youtube link rejected", parseTelegramPostLink("https://youtube.com/watch?v=abc") === null);
  check("channel-only link rejected", parseTelegramPostLink("https://t.me/physicswallah") === null);
  check("empty rejected", parseTelegramPostLink("") === null && parseTelegramPostLink("   ") === null);

  console.log("\n── 🕛 daily limit window (IST midnight) ──────────────────────");
  const win = istDayWindow(0);
  check("window is 24h", win.endMs - win.startMs === 86400000, win);
  check("start aligned to IST midnight", (Math.floor(win.startMs / 1000) + 5 * 3600 + 30 * 60) % 86400 === 0, win.startMs);
  check("now inside window", win.startMs <= Date.now() && Date.now() < win.endMs);
  check("resetInSec <= 24h", win.resetInSec > 0 && win.resetInSec <= 86400, win.resetInSec);
  check("reset label 0 → 12:00 AM", resetLabel(0) === "12:00 AM");
  check("reset label 18 → 6:00 PM", resetLabel(18) === "6:00 PM");
  check("reset label 12 → 12:00 PM", resetLabel(12) === "12:00 PM");
  const win18 = istDayWindow(18);
  check("custom reset hour aligned", (Math.floor(win18.startMs / 1000) + 5 * 3600 + 30 * 60) % 86400 === 18 * 3600, win18.startMs);

  console.log("\n── 🧩 overlay merge (file-backed course + DB attach) ─────────");
  const fileTree = [
    {
      id: "A", title: "Course Folder", type: "FOLDER",
      children: [
        { id: "A1", title: "Lecture 1", type: "VIDEO" },
        { id: "A2", title: "Lecture 2", type: "VIDEO", children: [] },
      ],
    },
  ];
  const overlay = [
    { id: "A1", tg_video_token: "tg_token_1", source: "telegram_admin" },
    { id: "NEW", parent_id: "A", title: "Added by URL", type: "VIDEO", tg_video_token: "tg_token_2" },
  ];
  const merged = mergeOverlay(JSON.parse(JSON.stringify(fileTree)), overlay);
  check("existing node gets token", merged[0].children[0].tg_video_token === "tg_token_1", merged[0].children[0]);
  check("existing node keeps title", merged[0].children[0].title === "Lecture 1");
  check("new node goes under parent_id", merged[0].children.some((n) => n.id === "NEW"), merged[0].children.map((n) => n.id));
  check("merge does not duplicate nodes", merged[0].children.length === 3, merged[0].children.length);
  const merged2 = mergeOverlay(JSON.parse(JSON.stringify(merged)), [{ id: "A2", tg_video_token: "tg_token_3" }]);
  check("second attach keeps first", merged2[0].children[0].tg_video_token === "tg_token_1");
  check("second attach applies", merged2[0].children[1].tg_video_token === "tg_token_3");
  const orphan = mergeOverlay(JSON.parse(JSON.stringify(fileTree)), [{ id: "X", parent_id: "ZZZ", type: "VIDEO", title: "orphan" }]);
  check("orphan node lands at root", orphan.some((n) => n.id === "X"), orphan.map((n) => n.id));
  const found = findNodeById(merged2, "NEW");
  check("findNodeById + trail", found && found.trail.join(" > ") === "Course Folder > Added by URL", found && found.trail);

  console.log("\n── 🧹 misc ───────────────────────────────────────────────────");
  check("cleanValue drops undefined/functions", JSON.stringify(cleanValue({ a: undefined, b: () => 1, c: 1 })) === '{"c":1}', cleanValue({ a: undefined, b: () => 1, c: 1 }));
  check("cleanValue drops bad RTDB keys", JSON.stringify(cleanValue({ "a.b": 1, ok: 2 })) === '{"ok":2}');
  check("accountKey escapes RTDB-illegal chars", accountKey("Ravi@Test.In") === "ravi@test_in", accountKey("Ravi@Test.In"));
  check("accountKey lowercases + escapes every illegal char", accountKey("A.B#C$D[E]") === "a_b_c_d_e_", accountKey("A.B#C$D[E]"));
  check("deep link uses bot username", botDeepLink({ botUsername: "shd_bot" }, "abc123") === "https://t.me/shd_bot?start=req_abc123");
  const savedBotEnv = process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.TELEGRAM_BOT_USERNAME;
  check("deep link empty without username", botDeepLink({}, "abc123") === "", botDeepLink({}, "abc123"));
  check("deep link strips leading @", botDeepLink({ botUsername: "@shd_bot" }, "x1") === "https://t.me/shd_bot?start=req_x1");
  if (savedBotEnv !== undefined) process.env.TELEGRAM_BOT_USERNAME = savedBotEnv;
  check("DEFAULT_SETTINGS limit is 20", DEFAULT_SETTINGS.dailyVideoLimit === 20, DEFAULT_SETTINGS.dailyVideoLimit);
  check("DEFAULT_SETTINGS reset is IST midnight", DEFAULT_SETTINGS.dailyResetHourIST === 0);
  check("purge defaults protect courses", PURGE_DEFAULTS.deleteTelegramCourses === false && PURGE_DEFAULTS.stripLinks === true);
  check("student session round-trip", (() => {
    const token = createStudentSession({ uid: "ravi@test.in", name: "Ravi" });
    const back = verifyStudentSession(token);
    return back && back.uid === "ravi@test.in";
  })());
  check("tampered student session rejected", !verifyStudentSession(createStudentSession({ uid: "a" }).replace(/.$/, "x")));
  check("admin session round-trip", verifyAdminSession(createAdminSession()) === true);
  check("garbage admin session rejected", verifyAdminSession("aa.bb.cc") === false);

  console.log("\n" + "=".repeat(70));
  if (failures.length) {
    console.log(`❌ SERVER SELF-TEST FAILED (${failures.length}): ${failures.join(", ")}`);
    console.log("=".repeat(70));
    return 1;
  }
  console.log("✅ SERVER SELF-TEST PASSED — crypto, links, quota window, merge sab theek");
  console.log("=".repeat(70) + "\n");
  return 0;
}

if (require.main === module) {
  if (process.argv.includes("--selftest")) process.exit(selfTest());
  // ⚠️ process.exit() yahan NAHI — warna server turant band ho jata hai
  main();
}

module.exports = {
  app,
  selfTest,
  initFirebase,
  parseTelegramPostLink,
  makeMediaToken,
  readMediaToken,
  encryptVaultJson,
  decryptVaultJson,
  resetLabel,
  istDayWindow,
  DEFAULT_SETTINGS,
};
