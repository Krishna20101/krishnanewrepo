import "server-only";
import crypto from "crypto";
import { cleanEnv } from "@/config/firebaseConfig";

// ============================================================================
// 🔗 TELEGRAM BOT HANDOFF TOKENS  (server-only, encrypted + expiring)
// ----------------------------------------------------------------------------
// Jab student "Open in Telegram" dabata hai:
//   site  →  short-lived token banti hai (chat id + message id + link ki details)
//   bot   →  ?start=<token> se aata hai, decrypt karke SAME message forward karta hai
//
// Token AES-256-GCM se encrypted hai → user URL me chat id / message id ko
// tamper nahi kar sakta, aur har link 20 minute me expire ho jata hai.
// (Vercel /api/video route aur Render bot — dono same ADMIN_SESSION_SECRET use
//  karte hain, isliye same key derive hoti hai.)
// ============================================================================

const FALLBACK_SALT = "shd_bot_handoff_v1_2026";

function masterKey(): Buffer {
  const secret =
    cleanEnv(process.env.ADMIN_SESSION_SECRET) ||
    `${cleanEnv(process.env.ADMIN_EMAIL)}:${cleanEnv(
      process.env.ADMIN_PASSWORD
    )}:${cleanEnv(process.env.FIREBASE_PROJECT_ID)}` ||
    "shd_local_dev_master_key_v3";
  return crypto.scryptSync(secret, FALLBACK_SALT, 32);
}

export interface BotHandoffPayload {
  /** Telegram chat id (course group/channel) */
  c: string;
  /** Message id of the video */
  m: number;
  /** Display title (caption me dikhane ke liye) */
  t?: string;
  /** Batch / course name */
  b?: string;
  /** Chapter / topic */
  f?: string;
  /** Issued-at (epoch seconds) */
  iat: number;
}

/** 20 minute valid link token */
export const HANDOFF_TTL_SEC = 20 * 60;

export function createBotHandoffToken(payload: BotHandoffPayload): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const plain = JSON.stringify(payload);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // URL-safe: dots se separate (base64url me dot nahi aata)
  return `${iv.toString("base64url")}.${tag.toString(
    "base64url"
  )}.${enc.toString("base64url")}`;
}

export function verifyBotHandoffToken(
  token?: string | null
): BotHandoffPayload | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      Buffer.from(ivB64, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    const parsed = JSON.parse(dec) as BotHandoffPayload;
    if (!parsed?.c || !parsed?.m) return null;
    if (typeof parsed.iat !== "number") return null;
    if (Math.floor(Date.now() / 1000) - parsed.iat > HANDOFF_TTL_SEC) {
      return null; // expired
    }
    return parsed;
  } catch {
    return null;
  }
}

// ── Bot deep-link username (site ko pata hona chahiye kis bot par bhejna hai) ─
export function getBotUsername(): string {
  const raw =
    cleanEnv(process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME) ||
    cleanEnv(process.env.TELEGRAM_BOT_USERNAME) ||
    "";
  return raw.replace(/^@/, "");
}

export function getBotChannelUrl(): string {
  return (
    cleanEnv(process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL) ||
    cleanEnv(process.env.TELEGRAM_CHANNEL_URL) ||
    ""
  );
}
