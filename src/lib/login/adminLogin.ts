"use client";

// ============================================================================
// 🔐 ADMIN LOGIN MODULE  (ALAG FILE — admin login badalna ho to SIRF yahan)
// ============================================================================
// Admin login server-side cookie + bcrypt hash par chalta hai:
//   • server logic      -> src/lib/adminAuth.ts   (hash verify, cookie, guard)
//   • API routes        -> src/app/api/admin/login | logout | me
//   • admin panel UI    -> src/app/admin/page.tsx (sirf form)
//
// Ye file client-side helper deti hai taaki Admin Panel ka login code ek jagah
// rahe aur baad me aasani se badla ja sake (2FA / Google admin / IP-lock etc).
//
// ⚠️ SECURITY RULE (aapka standing instruction):
//    Koi bhi default/fallback admin email ya password JS me nahi hona chahiye.
//    Sirf `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` env/Firebase vault se aate hain.
// ============================================================================

export interface AdminLoginResult {
  ok: boolean;
  error?: string;
}

export async function adminLoginRequest(
  email: string,
  password: string,
  apiBase = ""
): Promise<AdminLoginResult> {
  try {
    const res = await fetch(`${apiBase}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(email || "").trim(),
        password: String(password || ""),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error || "Admin login failed." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error while logging in." };
  }
}

export async function adminLogoutRequest(apiBase = ""): Promise<void> {
  try {
    await fetch(`${apiBase}/api/admin/logout`, { method: "POST" });
  } catch {
    // ignore
  }
}

export async function adminMeRequest(
  apiBase = ""
): Promise<{ ok: boolean; email?: string }> {
  try {
    const res = await fetch(`${apiBase}/api/admin/me`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return { ok: Boolean(data?.ok), email: data?.email };
  } catch {
    return { ok: false };
  }
}
