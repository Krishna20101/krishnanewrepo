import "server-only";
import crypto from "crypto";
import { cleanEnv } from "@/config/firebaseConfig";

// ============================================================================
// SERVER-ONLY AES-256-GCM VAULT & ENCRYPTED TELEGRAM STREAM TOKENS
// Ensures NO Telegram group ID, username, URL, or Session String ever leaks!
// ============================================================================

const FALLBACK_RUNTIME_SALT = "shd_tg_media_vault_v3_2026";

function getVaultMasterKey(): Buffer {
  const secret =
    cleanEnv(process.env.ADMIN_SESSION_SECRET) ||
    `${cleanEnv(process.env.ADMIN_EMAIL)}:${cleanEnv(
      process.env.ADMIN_PASSWORD
    )}:${cleanEnv(process.env.FIREBASE_PROJECT_ID)}` ||
    "shd_local_dev_master_key_v3";

  return crypto.scryptSync(secret, FALLBACK_RUNTIME_SALT, 32);
}

export function encryptVaultJson(data: unknown): string {
  const key = getVaultMasterKey();
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
}

export function createTelegramMediaToken(
  payload: TelegramMediaTokenPayload
): string {
  const key = getVaultMasterKey();
  // Deterministic 12-byte IV per (chat, msg, kind) so identical videos cache cleanly on Cloudflare Edge!
  const iv = crypto
    .createHmac("sha256", key)
    .update(`${payload.c}:${payload.m}:${payload.k}`)
    .digest()
    .subarray(0, 12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(payload);
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
    return parsed;
  } catch {
    return null;
  }
}
