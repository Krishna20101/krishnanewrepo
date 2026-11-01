import "server-only";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { cleanEnv } from "@/config/firebaseConfig";

// ============================================================================
// 100% STRICT .ENV SERVER-ONLY ADMIN AUTHENTICATION
// ZERO hardcoded fallback email, password, or session secret!
// If ADMIN_EMAIL / ADMIN_PASSWORD are not set in .env, Admin login is LOCKED.
// ============================================================================

export const ADMIN_COOKIE_NAME = "shd_admin_token";

const EPHEMERAL_FALLBACK_KEY = crypto.randomBytes(64).toString("hex");

function getSessionSecret(): string {
  const explicit = cleanEnv(process.env.ADMIN_SESSION_SECRET);
  if (explicit && explicit.length >= 16) return explicit;

  const envEmail = cleanEnv(process.env.ADMIN_EMAIL);
  const envPass = cleanEnv(process.env.ADMIN_PASSWORD);
  if (envEmail && envPass) {
    return crypto
      .createHash("sha512")
      .update(`${envEmail}::${envPass}::shd_aes256_vault`)
      .digest("hex");
  }

  return EPHEMERAL_FALLBACK_KEY;
}

export function isAdminEnvConfigured(): boolean {
  const hasPlain = Boolean(
    cleanEnv(process.env.ADMIN_EMAIL) && cleanEnv(process.env.ADMIN_PASSWORD)
  );
  const hasHashed = Boolean(
    cleanEnv(process.env.ADMIN_EMAIL_HASH) &&
      cleanEnv(process.env.ADMIN_PASSWORD_HASH) &&
      cleanEnv(process.env.ADMIN_SALT)
  );
  return hasPlain || hasHashed;
}

const loginAttempts = new Map<string, { count: number; lockUntil: number }>();

export function checkAdminRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.lockUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((record.lockUntil - now) / 1000),
    };
  }
  return { allowed: true };
}

export function recordFailedAdminAttempt(ip: string): void {
  const now = Date.now();
  const prev = loginAttempts.get(ip);
  const count = (prev && prev.lockUntil <= now ? 0 : prev?.count || 0) + 1;
  const lockUntil = count >= 5 ? now + 5 * 60 * 1000 : 0;
  loginAttempts.set(ip, { count, lockUntil });
}

export function clearAdminAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

function safeCompareStrings(input: string, secret: string): boolean {
  const key = getSessionSecret();
  const bufA = crypto.createHmac("sha512", key).update(input).digest();
  const bufB = crypto.createHmac("sha512", key).update(secret).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function verifyAdminCredentials(
  email: string,
  password: string
): Promise<boolean> {
  if (!isAdminEnvConfigured()) {
    return false;
  }

  const cleanEmail = email.trim().toLowerCase();

  const hashEmailEnv = cleanEnv(process.env.ADMIN_EMAIL_HASH);
  const hashPassEnv = cleanEnv(process.env.ADMIN_PASSWORD_HASH);
  const saltEnv = cleanEnv(process.env.ADMIN_SALT);

  if (hashEmailEnv && hashPassEnv && saltEnv) {
    const emailHash = crypto
      .pbkdf2Sync(cleanEmail, saltEnv + ":email", 100000, 64, "sha512")
      .toString("hex");
    const passHash = crypto
      .pbkdf2Sync(password, saltEnv + ":pass", 100000, 64, "sha512")
      .toString("hex");
    return (
      safeCompareStrings(emailHash, hashEmailEnv) &&
      safeCompareStrings(passHash, hashPassEnv)
    );
  }

  const envEmail = cleanEnv(process.env.ADMIN_EMAIL).toLowerCase();
  const envPass = cleanEnv(process.env.ADMIN_PASSWORD);
  if (!envEmail || !envPass) {
    return false;
  }

  return (
    safeCompareStrings(cleanEmail, envEmail) &&
    safeCompareStrings(password, envPass)
  );
}

export function createEncryptedAdminSession(): string {
  const secret = getSessionSecret();
  const key = crypto.scryptSync(secret, "shd_session_salt", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const payload = JSON.stringify({
    role: "shd_super_admin",
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(8).toString("hex"),
  });

  const encrypted = Buffer.concat([
    cipher.update(payload, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("base64url")}.${authTag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function verifyEncryptedAdminSession(token?: string | null): boolean {
  if (!token || !isAdminEnvConfigured()) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [ivB64, tagB64, dataB64] = parts;
    const secret = getSessionSecret();
    const key = crypto.scryptSync(secret, "shd_session_salt", 32);
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(tagB64, "base64url");
    const encrypted = Buffer.from(dataB64, "base64url");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");

    const parsed = JSON.parse(decrypted);
    if (parsed.role !== "shd_super_admin") return false;
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return false;
    return true;
  } catch {
    return false;
  }
}

export function isRequestAdminAuthorized(req: NextRequest): boolean {
  const cookieToken = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  if (verifyEncryptedAdminSession(cookieToken)) return true;

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (verifyEncryptedAdminSession(bearerToken)) return true;
  }
  return false;
}
