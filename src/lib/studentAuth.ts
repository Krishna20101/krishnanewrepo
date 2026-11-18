import "server-only";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { cleanEnv } from "@/config/firebaseConfig";
import {
  ADMIN_COOKIE_NAME,
  verifyEncryptedAdminSession,
} from "@/lib/adminAuth";
import { getServerMasterSecret } from "@/lib/serverSecrets";
import {
  getStudentAccount,
  saveStudentAccount,
  saveUserLoginToDb,
  StudentAccountEntry,
} from "@/lib/db";

// ============================================================================
// 🔐 STUDENT ACCOUNT + SESSION (server-only, 100% self-hosted)
// ----------------------------------------------------------------------------
// • Login = koi bhi email / mobile / user id + password
//   (koi third-party account hona zaroori NAHI).
// • Naya id pehli baar aata hai → AUTO REGISTER (account DB me ban jata hai).
// • Password scrypt (N=16384, r=8, p=1) se hash hoke salt ke saath save hota
//   hai — plaintext kabhi store nahi hota.
// • Success par HMAC-signed httpOnly cookie (7 din) — JS padh nahi sakta.
// • Content APIs (batches / video / pdf) session ke bina 401 dete hain.
//
// Koi naya ENV var zaroori NAHI hai — session secret maujood
// ADMIN_SESSION_SECRET se derive hota hai (fallback: ADMIN_EMAIL/PASSWORD).
// ============================================================================

export const STUDENT_COOKIE_NAME = "shd_student_token";
export const STUDENT_SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/**
 * 🔒 FIX (v5): pehle last fallback ek PER-MODULE random secret tha
 * (`crypto.randomBytes(64)`). Next.js dev me har route bundle ka apna module
 * instance hota hai → /api/auth/login ne jis secret se cookie sign ki,
 * /api/auth/session aur /api/batches use verify hi nahi kar pate the.
 * Natija: login 200 OK + cookie set, phir har content API 401
 * ("login ho gaya par kuch khul nahi raha" — silent loop, koi error nahi).
 *
 * Ab fallback `serverSecrets.getServerMasterSecret()` se aata hai:
 *   • production me secret missing → ServerConfigError (loud, clear 503)
 *   • development me → globalThis par STABLE random key (route-to-route same)
 *
 * Upar ke teen branches purane jaise hi hain (byte-identical), isliye pehle se
 * logged-in students ki cookies invalid NAHI hoti.
 */
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

  return `student::${getServerMasterSecret()}`;
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface StudentSessionPayload {
  /** Login id (lowercase email / mobile / custom id) */
  uid: string;
  name?: string;
  phone?: string;
  email?: string;
  /** Future use (paid/unpaid badge) */
  paid?: boolean;
  iat: number;
  exp: number;
}

export interface StudentAccountResult {
  loginId: string;
  displayName: string;
  /** true = pehli baar account bana (auto register) */
  isNewAccount: boolean;
}

// ── Signing / verification ──────────────────────────────────────────────────
function signBody(data: string): string {
  return crypto
    .createHmac("sha256", getStudentSessionSecret())
    .update(data)
    .digest("base64url");
}

/**
 * Cookie verify karte waqt secret missing hone par throw nahi karna —
 * guard simply "not logged in" maan lega (401), 500 nahi.
 */
function trySignBody(data: string): string | null {
  try {
    return signBody(data);
  } catch {
    return null;
  }
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
    const expected = trySignBody(body);
    if (!expected) return null;

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

// ── Login rate limiting ─────────────────────────────────────────────────────
/**
 * 🔒 FIX (v5): pehle ye in-memory Map tha (`MAX_FAILURES = 8`, 10 min lock).
 * Vercel serverless par har container ka apna Map hota hai + containers
 * recycle hote rehte hain, isliye brute-force lock effectively kaam nahi karta
 * tha. Ab counters Firebase RTDB me rehte hain (`rtStore.rateLimitHit`), yaani
 * saare instances ek hi counter share karte hain.
 *
 * Same policy: 8 galat attempt / 10 minute window → 10 minute lock (per IP).
 */
export const STUDENT_LOGIN_MAX_FAILURES = 8;
export const STUDENT_LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const STUDENT_LOGIN_LOCK_MS = 10 * 60 * 1000;

// ── Login id normalisation ──────────────────────────────────────────────────
/**
 * Email / mobile / koi bhi user id accept hota hai.
 * Sirf lowercase + trim — taaki "Ravi@Mail.com" aur "ravi@mail.com" ek hi
 * account maane jayein (case-sensitive duplicate na bane).
 */
export function normaliseLoginId(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

export function validateLoginId(loginId: string): string | null {
  if (!loginId) return "Please enter your Email / Mobile Number / User ID.";
  if (loginId.length < 3) return "Email / User ID must be at least 3 characters.";
  if (loginId.length > 120) return "Email / User ID is too long.";
  if (/\s{2,}/.test(loginId)) return "Email / User ID cannot contain double spaces.";
  if (!/^[^\s@]+(@[^\s@]+)?$|^[^\s]+$/.test(loginId)) {
    return "Email / User ID is not valid.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return "Please enter your Password.";
  if (password.length < 4) return "Password must be at least 4 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

// ── Password hashing (scrypt, salt per account) ─────────────────────────────
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;

function scryptHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

async function buildPasswordRecord(password: string): Promise<{
  passwordHash: string;
  passwordSalt: string;
}> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scryptHash(password, salt);
  return { passwordHash: hash.toString("hex"), passwordSalt: salt };
}

async function verifyPassword(
  password: string,
  account: StudentAccountEntry
): Promise<boolean> {
  try {
    const expected = Buffer.from(account.passwordHash || "", "hex");
    if (!expected.length) return false;
    const actual = await scryptHash(password, account.passwordSalt || "");
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Login id se dikhne wala naam (display only) */
function deriveDisplayName(loginId: string): string {
  if (loginId.includes("@")) {
    const local = loginId.split("@")[0];
    return local.replace(/[._-]+/g, " ").trim() || loginId;
  }
  return loginId;
}

// ── LOGIN (galat password block, naya id auto register) ─────────────────────
export interface StudentAuthOutcome {
  ok: boolean;
  error?: string;
  account?: StudentAccountResult;
}

export async function loginOrRegisterStudent(
  rawLoginId: string,
  rawPassword: string
): Promise<StudentAuthOutcome> {
  const loginId = normaliseLoginId(rawLoginId);
  const password = String(rawPassword || "");

  const idError = validateLoginId(loginId);
  if (idError) return { ok: false, error: idError };

  const passError = validatePassword(password);
  if (passError) return { ok: false, error: passError };

  let existing: StudentAccountEntry | null = null;
  try {
    existing = await getStudentAccount(loginId);
  } catch {
    existing = null;
  }

  const now = new Date().toISOString();

  // ── Naya account → AUTO REGISTER ─────────────────────────────────────────
  if (!existing) {
    const record = await buildPasswordRecord(password);
    const account: StudentAccountEntry = {
      id: loginId,
      loginId,
      displayName: deriveDisplayName(loginId),
      passwordHash: record.passwordHash,
      passwordSalt: record.passwordSalt,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      loginCount: 1,
      provider: "password",
    };
    try {
      await saveStudentAccount(account);
    } catch {
      return {
        ok: false,
        error: "Could not create your account. Please try again in a moment.",
      };
    }
    return {
      ok: true,
      account: {
        loginId,
        displayName: account.displayName,
        isNewAccount: true,
      },
    };
  }

  // ── Purana account → password check ──────────────────────────────────────
  const valid = await verifyPassword(password, existing);
  if (!valid) {
    return {
      ok: false,
      error:
        "Wrong password. An account already exists for this Email / User ID. If this is your first login, use any new Email / User ID and your account will be created automatically.",
    };
  }

  try {
    await saveStudentAccount({
      ...existing,
      lastLoginAt: now,
      updatedAt: now,
      loginCount: (existing.loginCount || 0) + 1,
    });
  } catch {
    // login record fail ho jaye to bhi login rokna nahi
  }

  return {
    ok: true,
    account: {
      loginId,
      displayName: existing.displayName || deriveDisplayName(loginId),
      isNewAccount: false,
    },
  };
}

// ── Login record (admin panel → Saved Logins) ───────────────────────────────
export async function recordStudentLogin(params: {
  loginId: string;
  displayName: string;
  isNewAccount: boolean;
  ip: string;
  userAgent: string;
}): Promise<void> {
  try {
    await saveUserLoginToDb({
      userId: params.loginId,
      // ⚠️ Password kabhi store nahi hota (hash bhi nahi — alag vault me hai)
      password: "",
      ip: params.ip,
      userAgent: params.userAgent,
      createdAt: new Date().toISOString(),
      dishaUserId: "",
      dishaName: params.displayName,
      dishaEmail: params.loginId.includes("@") ? params.loginId : "",
      dishaPhone: /^\d{6,15}$/.test(params.loginId) ? params.loginId : "",
      dishaUsername: params.loginId,
      dishaState: "",
      dishaPhoto: "",
      dishaAppCategory: params.isNewAccount ? "new-account" : "login",
      dishaIsPaidUser: "0",
      dishaIsTester: "",
      dishaAadharStatus: "",
      dishaFullResponse: JSON.stringify({
        mode: "password",
        newAccount: params.isNewAccount,
      }),
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
