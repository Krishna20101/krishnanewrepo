import "server-only";
import crypto from "crypto";
import { cleanEnv } from "@/config/firebaseConfig";
import { getServerMasterSecret, getServerMasterSecretSafe } from "@/lib/serverSecrets";

// ============================================================================
// SERVER-ONLY AES-256-GCM VAULT & ENCRYPTED TELEGRAM STREAM TOKENS
// Ensures NO Telegram group ID, username, URL, or Session String ever leaks!
//
// 🔒 FIX (v5): pehle master key ka fallback chain silent-broken tha —
//    `A || `${B}:${C}:${D}` || "dev-key"` me beech wala expression hamesha
//    truthy ("::") hota tha, isliye env khaali hone par key "::" se banti thi
//    aur koi bhi stream-token FORGE kar sakta tha. Ab key derivation
//    `src/lib/serverSecrets.ts` me ek jagah hai: production me secret missing
//    hone par vault DISABLED (loud error), silent weak key kabhi nahi.
// ============================================================================

const FALLBACK_RUNTIME_SALT = "shd_tg_media_vault_v3_2026";

/** Media stream token kitne din valid rahe (default 30 din). */
const MEDIA_TOKEN_TTL_DAYS = Math.max(
  1,
  Number(cleanEnv(process.env.TG_MEDIA_TOKEN_TTL_DAYS) || 30)
);
const MEDIA_TOKEN_TTL_SEC = MEDIA_TOKEN_TTL_DAYS * 24 * 60 * 60;

/** Production me secret missing → null (vault disabled, forge kabhi nahi). */
function getVaultMasterKey(): Buffer | null {
  const secret = getServerMasterSecretSafe();
  if (!secret) return null;
  return crypto.scryptSync(secret, FALLBACK_RUNTIME_SALT, 32);
}

function requireVaultMasterKey(): Buffer {
  const key = getVaultMasterKey();
  if (!key) {
    // Explicit throw: sync/admin action par clear error dikhe, silent "" nahi
    getServerMasterSecret();
    throw new Error(
      "Encrypted media vault is unavailable: ADMIN_SESSION_SECRET is not set."
    );
  }
  return key;
}

export function encryptVaultJson(data: unknown): string {
  const key = requireVaultMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(data);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString(
    "base64url"
  )}.${enc.toString("base64url")}`;
}

export function decryptVaultJson<T = unknown>(cipherText?: string | null): T | null {
  if (!cipherText || !cipherText.startsWith("v1.")) return null;
  try {
    const parts = cipherText.split(".");
    if (parts.length !== 4) return null;
    const [, ivB64, tagB64, dataB64] = parts;
    const key = getVaultMasterKey();
    if (!key) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(dec) as T;
  } catch {
    return null;
  }
}

export interface TelegramMediaTokenPayload {
  /** Chat identifier: -100xxxx or @username */
  c: string;
  /** Telegram message ID */
  m: number;
  /** Media kind: v = video, p = pdf, t = thumbnail */
  k: "v" | "p" | "t";
  /** Byte size (if known) */
  s?: number;
  /** Clean display filename */
  n?: string;
  /** MIME type */
  mt?: string;
  /**
   * 🔒 Unix seconds me expiry (v5 se har naya token expiry ke saath banta hai).
   * Purane (bina `exp` wale) tokens valid rehte hain taaki already-synced
   * courses toote na — dubara sync karne par naye expiry wale tokens ban jate hain.
   */
  exp?: number;
}

export function createTelegramMediaToken(
  payload: TelegramMediaTokenPayload
): string {
  const key = requireVaultMasterKey();
  // Deterministic 12-byte IV per (chat, msg, kind, expiry-window) so identical
  // videos cache cleanly on Cloudflare Edge within the same validity window.
  const exp =
    payload.exp ??
    Math.floor(Date.now() / 1000 / (MEDIA_TOKEN_TTL_SEC / 4) + 1) *
      (MEDIA_TOKEN_TTL_SEC / 4);
  const iv = crypto
    .createHmac("sha256", key)
    .update(`${payload.c}:${payload.m}:${payload.k}:${exp}`)
    .digest()
    .subarray(0, 12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify({ ...payload, exp });
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `tg_${iv.toString("base64url")}_${tag.toString(
    "base64url"
  )}_${enc.toString("base64url")}`;
}

export function verifyTelegramMediaToken(
  token?: string | null
): TelegramMediaTokenPayload | null {
  if (!token || !token.startsWith("tg_")) return null;
  try {
    const raw = token.slice(3);
    const firstSep = raw.indexOf("_");
    if (firstSep === -1) return null;
    const rest = raw.slice(firstSep + 1);
    const secondSep = rest.indexOf("_");
    if (secondSep === -1) return null;

    const ivB64 = raw.slice(0, firstSep);
    const tagB64 = rest.slice(0, secondSep);
    const dataB64 = rest.slice(secondSep + 1);

    const key = getVaultMasterKey();
    if (!key) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    const parsed = JSON.parse(dec) as TelegramMediaTokenPayload;
    if (!parsed.c || typeof parsed.m !== "number") return null;

    // 🔒 Token expiry (naye tokens me `exp` hota hai; purane legacy tokens
    //    bina exp ke valid rehte hain taaki synced courses kaam karte rahein).
    if (typeof parsed.exp === "number" && parsed.exp > 0) {
      if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
