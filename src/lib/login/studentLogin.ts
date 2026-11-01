"use client";

// Login hits Disha directly from the browser, same request as the working
// player (batdisha): POST /post/userLogin?extra_details=0
// Headers: Auth-Key, Client-Service, Source, Accept
// Body: email + password only. CORS on that API allows these headers.

export const STUDENT_SESSION_KEY = "shd_student_session_v1";

const DISHA_LOGIN =
  "https://dishaonlineclassesapi.classx.co.in/post/userLogin?extra_details=0";

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

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch { /* ignore */ }
    }
  }
  return {};
}

export async function loginStudentRequest(
  input: StudentLoginInput,
  apiBase = ""
): Promise<StudentLoginResult> {
  const email = String(input.userId || "").trim();
  const password = String(input.password || "");

  if (!email || !password) {
    return { ok: false, error: "Please enter your Mobile Number / ID and Password." };
  }

  const body = new URLSearchParams();
  body.append("email", email);
  body.append("password", password);

  let dishaData: Record<string, unknown>;
  try {
    const res = await fetch(DISHA_LOGIN, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Auth-Key": "appxapi",
        "Client-Service": "Appx",
        Source: "website",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    dishaData = await readJson(res);
  } catch {
    return { ok: false, error: "Could not reach Disha servers. Please check your connection." };
  }

  const status = Number(dishaData?.status);
  const user =
    dishaData?.data && typeof dishaData.data === "object"
      ? (dishaData.data as Record<string, unknown>)
      : null;

  if (status !== 200 || !user) {
    const msg = String(dishaData?.message || dishaData?.msg || "").trim();
    return { ok: false, error: msg || "Invalid User ID / Mobile Number or Password." };
  }

  try {
    const saveRes = await fetch(`${apiBase}/api/auth/save-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, dishaResponse: dishaData }),
    });
    const saved = (await saveRes.json().catch(() => ({}))) as { sessionToken?: string };
    if (saved?.sessionToken) return { ok: true, sessionToken: String(saved.sessionToken) };
  } catch {
    // Local session still counts as logged in if our log endpoint is down.
  }

  const fallback = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return { ok: true, sessionToken: fallback };
}
