"use client";

// ============================================================================
// 🔐 STUDENT LOGIN MODULE
// ----------------------------------------------------------------------------
// Flow (sab kuch hamare apne server se, browser se seedha Disha call NAHI):
//   1. POST /api/auth/login  → server Disha ka 2-step login karta hai
//      (Step 1 okhttp headers, status 203 par Step 2 website headers)
//   2. Success → server httpOnly signed cookie set karta hai
//   3. Session confirm → GET /api/auth/session
//
// Pehle browser se seedha API call hoti thi (CORS + User-Agent ki wajah se
// fail hoti thi) aur localStorage token koi bhi bana sakta tha. Ab aisa nahi.
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
    return { ok: true, student: session.student || data.student };
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
