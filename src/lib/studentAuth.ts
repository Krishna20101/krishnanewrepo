import "server-only";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { cleanEnv } from "@/config/firebaseConfig";
import {
  ADMIN_COOKIE_NAME,
  verifyEncryptedAdminSession,
} from "@/lib/adminAuth";
import { saveUserLoginToDb } from "@/lib/db";

// ============================================================================
// 🔐 STUDENT SESSION (server-only)
// ----------------------------------------------------------------------------
// Pehle student ka session sirf localStorage me ek random string tha — koi bhi
// DevTools me daal kar "login" ho sakta tha aur content APIs khuli thi.
//
// Ab:
//  • Disha login SIRF server par hota hai (browser se seedha call nahi).
//  • Success par HMAC-signed, httpOnly cookie milti hai (JS padh nahi sakta).
//  • Session 7 din me expire hoti hai aur logout par server se clear hoti hai.
//  • Content APIs (batches / video / pdf) session ke bina 401 dete hain.
//
// Koi naya ENV var zaroori NAHI hai — secret pehle se maujood
// ADMIN_SESSION_SECRET se derive hota hai (fallback: ADMIN_EMAIL/PASSWORD).
// ============================================================================

export const STUDENT_COOKIE_NAME = "shd_student_token";
export const STUDENT_SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/** Per-process fallback (agar .env me kuch bhi set na ho) */
const EPHEMERAL_SECRET = crypto.randomBytes(64).toString("hex");

function getStudentSessionSecret(): string {
  const explicit = cleanEnv(process.env.STUDENT_SESSION_SECRET);
  if (explicit && explicit.length >= 16) return explicit;

  const adminSecret = cleanEnv(process.env.ADMIN_SESSION_SECRET);
  if (adminSecret && adminSecret.length >= 16) return `student::${adminSecret}`;

  const email = cleanEnv(process.env.ADMIN_EMAIL);
  const pass = cleanEnv(process.env.ADMIN_PASSWORD);
  if (email && pass) {
    return crypto
      .createHash("sha512")
      .update(`${email}::${pass}::shd_student_session_v1`)
      .digest("hex");
  }

  return EPHEMERAL_SECRET;
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface StudentSessionPayload {
  /** Disha user id */
  uid: string;
  name?: string;
  phone?: string;
  email?: string;
  /** Disha account paid hai ya free */
  paid?: boolean;
  iat: number;
  exp: number;
}

export interface DishaAccount {
  userId: string;
  token: string;
  name: string;
  email: string;
  phone: string;
  username: string;
  state: string;
  photo: string;
  appCategory: string;
  isPaidUser: boolean;
  isTester: string;
  aadharStatus: string;
  rawResponse: Record<string, unknown>;
}

// ── Signing / verification ──────────────────────────────────────────────────
function signBody(data: string): string {
  return crypto
    .createHmac("sha256", getStudentSessionSecret())
    .update(data)
    .digest("base64url");
}

export function createStudentSession(
  input: Omit<StudentSessionPayload, "iat" | "exp">
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: StudentSessionPayload = {
    ...input,
    iat: now,
    exp: now + STUDENT_SESSION_TTL_SEC,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `s1.${body}.${signBody(body)}`;
}

export function verifyStudentSession(
  token?: string | null
): StudentSessionPayload | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "s1") return null;

    const [, body, signature] = parts;
    const expected = signBody(body);

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as StudentSessionPayload;

    if (!parsed?.uid) return null;
    if (typeof parsed.exp !== "number") return null;
    if (Math.floor(Date.now() / 1000) > parsed.exp) return null;

    return parsed;
  } catch {
    return null;
  }
}

export function getStudentSessionFromRequest(
  req: NextRequest
): StudentSessionPayload | null {
  return verifyStudentSession(req.cookies.get(STUDENT_COOKIE_NAME)?.value);
}

/**
 * Batch / video / pdf API guard.
 * Student session YA admin session — dono me se koi ek valid ho to allowed.
 */
export function isContentRequestAuthorized(req: NextRequest): boolean {
  if (getStudentSessionFromRequest(req)) return true;

  const adminCookie = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  if (verifyEncryptedAdminSession(adminCookie)) return true;

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    if (verifyEncryptedAdminSession(authHeader.slice(7).trim())) return true;
  }
  return false;
}

export function studentCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STUDENT_SESSION_TTL_SEC,
  };
}

// ── Login rate limiting (in-memory, per server instance) ────────────────────
const MAX_FAILURES = 8;
const LOCK_MS = 10 * 60 * 1000; // 10 min
const WINDOW_MS = 10 * 60 * 1000;

const loginAttempts = new Map<
  string,
  { count: number; windowStart: number; lockUntil: number }
>();

export function checkStudentLoginRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) return { allowed: true };

  if (rec.lockUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000),
    };
  }
  if (now - rec.windowStart > WINDOW_MS) {
    loginAttempts.delete(ip);
  }
  return { allowed: true };
}

export function recordStudentLoginFailure(ip: string): void {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  const fresh =
    !rec || now - rec.windowStart > WINDOW_MS || rec.lockUntil > 0
      ? { count: 0, windowStart: now, lockUntil: 0 }
      : rec;

  const count = fresh.count + 1;
  const lockUntil = count >= MAX_FAILURES ? now + LOCK_MS : 0;
  loginAttempts.set(ip, { count, windowStart: fresh.windowStart, lockUntil });
}

export function clearStudentLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// ── Disha response parsing (strict) ─────────────────────────────────────────
function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * Disha /post/userLogin ka response validate karta hai.
 * Sirf tab account return hota hai jab status 200 ho aur userid + token dono
 * valid hon — warna null (bogus/partial response kabhi session nahi banata).
 */
export function parseDishaLoginResponse(
  response: unknown
): DishaAccount | null {
  if (!response || typeof response !== "object") return null;
  const res = response as Record<string, unknown>;

  if (Number(res.status) !== 200) return null;
  if (!res.data || typeof res.data !== "object" || Array.isArray(res.data)) {
    return null;
  }

  const data = res.data as Record<string, unknown>;
  const userId = str(data.userid);
  const token = str(data.token);

  if (!userId || userId === "0") return null;
  if (!token || token.length < 8 || token.length > 4096) return null;
  if (/\s{2,}/.test(token)) return null;

  return {
    userId,
    token,
    name: str(data.name),
    email: str(data.email),
    phone: str(data.phone),
    username: str(data.username),
    state: str(data.state),
    photo: str(data.photo),
    appCategory: str(data.app_category),
    isPaidUser: ["1", "true", "yes"].includes(
      str(data.is_paid_user).toLowerCase()
    ),
    isTester: str(data.is_tester),
    aadharStatus: str(data.aadhar_status),
    rawResponse: res,
  };
}

// ── Login record (admin panel → Saved Logins) ───────────────────────────────
export async function recordStudentLogin(params: {
  account: DishaAccount;
  inputId: string;
  ip: string;
  userAgent: string;
}): Promise<void> {
  const { account } = params;
  try {
    await saveUserLoginToDb({
      userId: account.username || account.phone || account.email || params.inputId,
      // ⚠️ Security: student ka password kabhi store nahi hota.
      password: "",
      ip: params.ip,
      userAgent: params.userAgent,
      createdAt: new Date().toISOString(),
      dishaUserId: account.userId,
      dishaName: account.name,
      dishaEmail: account.email,
      dishaPhone: account.phone,
      dishaUsername: account.username,
      dishaState: account.state,
      dishaPhoto: account.photo,
      dishaAppCategory: account.appCategory,
      dishaIsPaidUser: account.isPaidUser ? "1" : "0",
      dishaIsTester: account.isTester,
      dishaAadharStatus: account.aadharStatus,
      dishaFullResponse: JSON.stringify(account.rawResponse),
    });
  } catch {
    // DB fail hone par bhi login block nahi hona chahiye
  }
}

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}
