"use client";

// ============================================================================
// 🔐 STUDENT LOGIN MODULE  (ALAG FILE — future me login badalna ho to SIRF yahan)
// ============================================================================
// 👉 Bhai, aapne kaha tha "login system thoda alag karna hai, abhi kuch mat
//    karo, bas login wali file alag rakhna taaki baad me changes kar saku".
//
//    Isliye poora STUDENT login ab isi ek file me hai:
//      • session token kahan save hota hai            -> STUDENT_SESSION_KEY
//      • login API call                                -> loginStudentRequest()
//      • logout                                          -> clearStudentSession()
//      • login check                                     -> isStudentLoggedIn()
//      • login screen ka look/fields                     -> components/LoginGateCard.tsx
//      • server-side login route                         -> app/api/auth/login/route.ts
//
//    Baad me OTP / Firebase Auth / Google login / paid-access check lagana ho
//    to sirf `loginStudentRequest()` ka andar ka hissa badal dein — baki poori
//    website (home, batch, watch, pdf, downloads) apne aap usi ko follow karegi.
// ============================================================================

/** localStorage key jahan student ka login session save hota hai */
export const STUDENT_SESSION_KEY = "shd_student_session_v1";

export interface StudentLoginInput {
  userId: string;
  password: string;
}

export interface StudentLoginResult {
  ok: boolean;
  sessionToken?: string;
  error?: string;
}

/** Saved session token padho (browser me hi) */
export function readStudentSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STUDENT_SESSION_KEY);
  } catch {
    return null;
  }
}

/** Session token save karo */
export function saveStudentSession(token: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STUDENT_SESSION_KEY, token);
  } catch {
    // ignore (private mode / storage full)
  }
}

/** Logout — session hatao */
export function clearStudentSession(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STUDENT_SESSION_KEY);
  } catch {
    // ignore
  }
}

/** Kya student logged-in hai? */
export function isStudentLoggedIn(): boolean {
  return Boolean(readStudentSession());
}

/**
 * 👇 FUTURE ME LOGIN SYSTEM YAHAN BADLEIN 👇
 * Abhi: Mobile Number/ID + Password server par jata hai aur ek session token
 * milta hai. OTP / Firebase / paid-check lagana ho to sirf ye function badlein.
 */
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
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || "Login failed. Please try again.",
      };
    }

    return {
      ok: true,
      sessionToken: String(data.sessionToken || `sess_${Date.now()}`),
    };
  } catch {
    return { ok: false, error: "Network error. Please check your connection." };
  }
}
