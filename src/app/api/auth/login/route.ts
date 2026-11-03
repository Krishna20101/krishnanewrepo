import { NextRequest, NextResponse } from "next/server";
import {
  checkStudentLoginRateLimit,
  clearStudentLoginAttempts,
  createStudentSession,
  getClientIp,
  loginOrRegisterStudent,
  recordStudentLogin,
  recordStudentLoginFailure,
  studentCookieOptions,
  STUDENT_COOKIE_NAME,
} from "@/lib/studentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ============================================================================
// POST /api/auth/login — simple student login (apna account)
// ----------------------------------------------------------------------------
// • Koi bhi Email / Mobile Number / User ID + Password chalega.
//   Kisi third-party (Disha/Firebase) account ki zaroorat NAHI.
// • Naya ID pehli baar aaya → AUTO REGISTER (account ban jata hai, turant login)
// • Purana ID → password verify (scrypt hash), galat par 401
// • Success → httpOnly signed cookie (7 din)
// ============================================================================

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  // ── Brute force protection ───────────────────────────────────────────────
  const rate = checkStudentLoginRateLimit(ip);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Bahut zyada galat koshish. ${Math.max(
          1,
          Math.ceil((rate.retryAfterSec || 60) / 60)
        )} minute baad try karein.`,
      },
      { status: 429 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const rawLoginId = String(
      body?.userId || body?.email || body?.mobile || body?.loginId || ""
    );
    const password = String(body?.password || "");

    const outcome = await loginOrRegisterStudent(rawLoginId, password);

    if (!outcome.ok || !outcome.account) {
      recordStudentLoginFailure(ip);
      return NextResponse.json(
        { ok: false, error: outcome.error || "Login failed. Please try again." },
        { status: 401 }
      );
    }

    clearStudentLoginAttempts(ip);

    const { loginId, displayName, isNewAccount } = outcome.account;

    // Admin panel ke "Saved Logins" ke liye record (password store NAHI hota)
    await recordStudentLogin({
      loginId,
      displayName,
      isNewAccount,
      ip,
      userAgent: req.headers.get("user-agent") || "unknown",
    });

    const sessionToken = createStudentSession({
      uid: loginId,
      name: displayName,
      phone: /^\d{6,15}$/.test(loginId) ? loginId : "",
      email: loginId.includes("@") ? loginId : "",
    });

    const res = NextResponse.json({
      ok: true,
      loginTime: Date.now(),
      isNewAccount,
      student: {
        userId: loginId,
        name: displayName,
        phone: /^\d{6,15}$/.test(loginId) ? loginId : "",
        email: loginId.includes("@") ? loginId : "",
        isPaidUser: false,
      },
    });

    res.cookies.set(STUDENT_COOKIE_NAME, sessionToken, studentCookieOptions());
    return res;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to process login right now." },
      { status: 500 }
    );
  }
}
