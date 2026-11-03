"use client";

// ============================================================================
// 🔐 STUDENT LOGIN MODULE
// ----------------------------------------------------------------------------
// Flow (sab kuch hamare apne server se):
//   1. POST /api/auth/login  → server account check karta hai
//        • naya email/ID  → AUTO REGISTER (account ban jata hai)
//        • purana account → scrypt password verify
//   2. Success → server HMAC-signed httpOnly cookie set karta hai (7 din)
//   3. Session confirm → GET /api/auth/session
//
// Koi bhi email / mobile number / user ID + password chalega — koi third-party
// account (Disha/Firebase) hona zaroori nahi.
// ============================================================================

export const STUDENT_SESSION_KEY = "shd_student_session_v1";

const DEFAULT_ERROR = "Login failed. Please try again.";

export interface StudentLoginInput {
  userId: string;
  password: string;
}

export interface StudentProfile {
  userId: string;
  name: string;
  phone: string;
  email: string;
  isPaidUser: boolean;
}

export interface StudentLoginResult {
  ok: boolean;
  error?: string;
  student?: StudentProfile;
  /** true = pehli baar account bana (auto register) */
  isNewAccount?: boolean;
}

function apiBaseClean(apiBase?: string): string {
  if (!apiBase) return "";
  return apiBase.replace(/\/$/, "");
}

/** Purane localStorage token ko saaf karo (ab token sirf httpOnly cookie me hai) */
export function purgeLegacyStudentSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STUDENT_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ── Server se session check ─────────────────────────────────────────────────
export async function fetchStudentSession(
  apiBase?: string
): Promise<{ loggedIn: boolean; student?: StudentProfile }> {
  try {
    const res = await fetch(`${apiBaseClean(apiBase)}/api/auth/session`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return { loggedIn: false };
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      loggedIn?: boolean;
      student?: StudentProfile;
    };
    return {
      loggedIn: Boolean(data?.ok && data?.loggedIn),
      student: data?.student,
    };
  } catch {
    return { loggedIn: false };
  }
}

// ── Main login call ─────────────────────────────────────────────────────────
export async function loginStudentRequest(
  input: StudentLoginInput,
  apiBase = ""
): Promise<StudentLoginResult> {
  const userId = String(input.userId || "").trim();
  const password = String(input.password || "").trim();

  if (!userId || !password) {
    return {
      ok: false,
      error: "Please enter your Mobile Number / ID and Password.",
    };
  }

  try {
    const res = await fetch(`${apiBaseClean(apiBase)}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ userId, password }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      student?: StudentProfile;
      isNewAccount?: boolean;
    };

    if (!res.ok || !data?.ok) {
      return { ok: false, error: String(data?.error || DEFAULT_ERROR) };
    }

    // Cookie server ne set ki hai — confirm kar lo
    const session = await fetchStudentSession(apiBase);
    if (!session.loggedIn) {
      return {
        ok: false,
        error: "Login session could not be created. Please try again.",
      };
    }

    purgeLegacyStudentSession();
    return {
      ok: true,
      student: session.student || data.student,
      isNewAccount: Boolean(data.isNewAccount),
    };
  } catch {
    return { ok: false, error: "Network error. Please check your connection." };
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────
export async function logoutStudentRequest(apiBase = ""): Promise<void> {
  purgeLegacyStudentSession();
  try {
    await fetch(`${apiBaseClean(apiBase)}/api/auth/logout`, {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    /* ignore */
  }
}
