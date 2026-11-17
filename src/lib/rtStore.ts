import "server-only";
import {
  ref as webRef,
  get as webGet,
  set as webSet,
  remove as webRemove,
} from "firebase/database";
import {
  getAdminRtdb,
  getServerWebRtdb,
  readLocalStore,
  safeRtdbKey,
  withTimeout,
  writeLocalStore,
} from "./db";

// ============================================================================
// rtStore — GENERIC PATH-BASED DATABASE ACCESS  (Firebase RTDB → local fallback)
// ----------------------------------------------------------------------------
// db.ts me har feature ke liye alag 60-line function tha (RTDB → web SDK →
// local store). Naye features (Telegram Bot Delivery, rate limits, tasks) ke
// liye ye chhota generic layer banaya gaya hai:
//
//     await rtGet<Config>("bot_state/config")
//     await rtSet("bot_state/users/12345", {...})
//     await rtChildren<Row>("bot_state/users")
//     await rtRemove("tg_requests/abc123")
//
// Python bot (telegram-bot/store.py) BILKUL same paths use karta hai — isliye
// website aur bot ek hi state share karte hain (stats/limits/broadcast/tasks).
//
// ⚠️ Local fallback (data/local_store.json) sirf DEV ke liye hai — Vercel par
//    filesystem read-only + per-container hota hai, isliye production me
//    FIREBASE_* env vars zaroori hain.
// ============================================================================

export type RtBackend = "firebase-admin" | "firebase-web" | "local-fallback";

const DEFAULT_TIMEOUT_MS = 6000;

function cleanPath(path: string): string {
  return String(path || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function getRtBackend(): RtBackend {
  if (getAdminRtdb()) return "firebase-admin";
  if (getServerWebRtdb()) return "firebase-web";
  return "local-fallback";
}

/** Local fallback store me path-based data `local_paths` map me rehta hai. */
function localRead(path: string): unknown {
  const store = readLocalStore();
  const map = store.local_paths || {};
  return map[path] ?? null;
}

function localWrite(path: string, value: unknown | null): void {
  const store = readLocalStore();
  const map = { ...(store.local_paths || {}) };
  if (value === null || value === undefined) {
    delete map[path];
    for (const key of Object.keys(map)) {
      if (key.startsWith(`${path}/`)) delete map[key];
    }
  } else {
    map[path] = value;
  }
  store.local_paths = map;
  writeLocalStore(store);
}

function localChildren(path: string): Record<string, unknown> {
  const store = readLocalStore();
  const map = store.local_paths || {};
  const out: Record<string, unknown> = {};
  const exact = map[path];
  if (exact && typeof exact === "object" && !Array.isArray(exact)) {
    Object.assign(out, exact as Record<string, unknown>);
  }
  const prefix = `${path}/`;
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(prefix)) continue;
    const child = key.slice(prefix.length).split("/")[0];
    out[child] = value;
  }
  return out;
}

export async function rtGet<T = unknown>(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T | null> {
  const clean = cleanPath(path);
  if (!clean) return null;

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(rtdb.ref(clean).get(), timeoutMs);
      return (snap.exists() ? (snap.val() as T) : null) ?? null;
    } catch {
      // fall through to next backend
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(webGet(webRef(webDb, clean)), timeoutMs);
      return (snap.exists() ? (snap.val() as T) : null) ?? null;
    } catch {
      // fall through
    }
  }

  return (localRead(clean) as T | null) ?? null;
}

export async function rtSet(
  path: string,
  value: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const clean = cleanPath(path);
  if (!clean) return false;
  const payload = sanitizeForRtdb(value);

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(rtdb.ref(clean).set(payload), timeoutMs);
      return true;
    } catch {
      // fall through
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(webSet(webRef(webDb, clean), payload), timeoutMs);
      return true;
    } catch {
      // fall through
    }
  }

  try {
    localWrite(clean, payload);
    return true;
  } catch {
    return false;
  }
}

export async function rtRemove(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const clean = cleanPath(path);
  if (!clean) return false;

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      await withTimeout(rtdb.ref(clean).remove(), timeoutMs);
      return true;
    } catch {
      // fall through
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      await withTimeout(webRemove(webRef(webDb, clean)), timeoutMs);
      return true;
    } catch {
      // fall through
    }
  }

  try {
    localWrite(clean, null);
    return true;
  } catch {
    return false;
  }
}

export async function rtChildren<T = unknown>(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Record<string, T>> {
  const clean = cleanPath(path);
  if (!clean) return {};

  const rtdb = getAdminRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(rtdb.ref(clean).get(), timeoutMs);
      const val = snap.exists() ? snap.val() : null;
      return val && typeof val === "object" ? (val as Record<string, T>) : {};
    } catch {
      // fall through
    }
  }

  const webDb = getServerWebRtdb();
  if (webDb) {
    try {
      const snap = await withTimeout(webGet(webRef(webDb, clean)), timeoutMs);
      const val = snap.exists() ? snap.val() : null;
      return val && typeof val === "object" ? (val as Record<string, T>) : {};
    } catch {
      // fall through
    }
  }

  return localChildren(clean) as Record<string, T>;
}

/** RTDB `undefined`/`.`/`#`/`$`/`/` keys accept nahi karta → safe payload. */
export function sanitizeForRtdb(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForRtdb(v)).filter((v) => v !== null);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const key = safeRtdbKey(k);
      if (!key) continue;
      const clean = sanitizeForRtdb(v);
      if (clean === null && v !== null) continue;
      out[key] = clean;
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

// ============================================================================
// 🔒 DATABASE-BACKED RATE LIMITING
// ----------------------------------------------------------------------------
// Purana limit in-memory Map tha — Vercel par har container ka apna Map hota
// hai aur container recycle hote rehte hain, isliye brute-force protection
// effectively kaam hi nahi karti thi. Ab counters DATABASE me rehte hain
// (Firebase RTDB), yaani saare containers/instances share karte hain.
// ============================================================================

export interface RateLimitOptions {
  /** Window kitni der ki hai (ms) */
  windowMs: number;
  /** Window me kitne hit allowed hain */
  max: number;
  /** Max cross hone par kitni der ka lock (ms) */
  lockMs?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  hits: number;
  remaining: number;
  retryAfterSec: number;
  locked: boolean;
}

interface RateLimitRecord {
  hits: number;
  first: number;
  lockUntil: number;
}

export async function rateLimitHit(
  bucket: string,
  rawKey: string,
  options: RateLimitOptions
): Promise<RateLimitDecision> {
  const path = `rate_limits/${safeRtdbKey(bucket)}/${safeRtdbKey(rawKey)}`;
  const now = Date.now();
  const lockMs = options.lockMs ?? 10 * 60 * 1000;

  const existing = (await rtGet<RateLimitRecord>(path, 4000)) || null;
  let record: RateLimitRecord = {
    hits: 0,
    first: now,
    lockUntil: 0,
  };

  if (existing && typeof existing === "object") {
    const windowExpired = now - Number(existing.first || now) > options.windowMs;
    record = {
      hits: windowExpired ? 0 : Number(existing.hits || 0),
      first: windowExpired ? now : Number(existing.first || now),
      lockUntil: Number(existing.lockUntil || 0),
    };
  }

  if (record.lockUntil > now) {
    return {
      allowed: false,
      hits: record.hits,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((record.lockUntil - now) / 1000)),
      locked: true,
    };
  }

  record.hits += 1;
  if (record.hits > options.max) {
    record.lockUntil = now + lockMs;
    record.hits = 0;
    record.first = now;
    await rtSet(path, record, 4000);
    return {
      allowed: false,
      hits: options.max,
      remaining: 0,
      retryAfterSec: Math.ceil(lockMs / 1000),
      locked: true,
    };
  }

  await rtSet(path, record, 4000);
  return {
    allowed: true,
    hits: record.hits,
    remaining: Math.max(0, options.max - record.hits),
    retryAfterSec: 0,
    locked: false,
  };
}

/**
 * Read-only check (counter badhata nahi) — login jaisi jagah par pehle check,
 * phir FAIL hone par hi `rateLimitHit` se increment karte hain ( warna successful
 * logins bhi limit me gin jaate).
 */
export async function rateLimitCheck(
  bucket: string,
  rawKey: string,
  options: Pick<RateLimitOptions, "windowMs" | "max">
): Promise<RateLimitDecision> {
  const path = `rate_limits/${safeRtdbKey(bucket)}/${safeRtdbKey(rawKey)}`;
  const now = Date.now();
  const existing = (await rtGet<RateLimitRecord>(path, 4000)) || null;

  if (!existing || typeof existing !== "object") {
    return { allowed: true, hits: 0, remaining: options.max, retryAfterSec: 0, locked: false };
  }

  const windowExpired = now - Number(existing.first || now) > options.windowMs;
  const hits = windowExpired ? 0 : Number(existing.hits || 0);
  const lockUntil = Number(existing.lockUntil || 0);

  if (!windowExpired && lockUntil > now) {
    return {
      allowed: false,
      hits,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((lockUntil - now) / 1000)),
      locked: true,
    };
  }

  return {
    allowed: true,
    hits,
    remaining: Math.max(0, options.max - hits),
    retryAfterSec: 0,
    locked: false,
  };
}

export async function rateLimitReset(bucket: string, rawKey: string): Promise<void> {
  await rtRemove(`rate_limits/${safeRtdbKey(bucket)}/${safeRtdbKey(rawKey)}`, 4000);
}

/** Purane rate-limit records saaf karta hai (DB ko ganda hone se rokta hai). */
export async function rateLimitCleanup(bucket: string, maxAgeMs = 3600_000): Promise<number> {
  const base = `rate_limits/${safeRtdbKey(bucket)}`;
  const all = await rtChildren<RateLimitRecord>(base, 6000);
  const now = Date.now();
  let removed = 0;
  for (const [key, value] of Object.entries(all)) {
    const first = Number((value as RateLimitRecord)?.first || 0);
    if (!first || now - first > maxAgeMs) {
      await rtRemove(`${base}/${key}`, 4000);
      removed += 1;
    }
  }
  return removed;
}
