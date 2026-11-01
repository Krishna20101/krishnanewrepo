"use client";

// Student login goes through our server (/api/auth/login), which runs the
// same 2-step Disha flow as dishaplayer.py. A browser cannot call that API
// directly: custom Auth-Key headers fail the CORS preflight.

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

export function readStudentSession(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(STUDENT_SESSION_KEY); } catch { return null; }
}

export function saveStudentSession(token: string): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(STUDENT_SESSION_KEY, token); } catch { /* ignore */ }
}

export function clearStudentSession(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(STUDENT_SESSION_KEY); } catch { /* ignore */ }
}

export function isStudentLoggedIn(): boolean {
  return Boolean(readStudentSession());
}

export async function loginStudentRequest(
  input: StudentLoginInput,
  apiBase = ""
): Promise<StudentLoginResult> {
  const userId = String(input.userId || "").trim();
  const password = String(input.password || "");

  if (!userId || !password.trim()) {
    return { ok: false, error: "Please enter your Mobile Number / ID and Password." };
  }

  try {
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, password }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      sessionToken?: string;
      error?: string;
    };
    if (!res.ok || !data.ok || !data.sessionToken) {
      return {
        ok: false,
        error: data.error || "Invalid User ID / Mobile Number or Password.",
      };
    }
    return { ok: true, sessionToken: data.sessionToken };
  } catch {
    return { ok: false, error: "Network error. Please check your connection." };
  }
}
