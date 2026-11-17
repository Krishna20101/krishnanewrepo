import { NextRequest, NextResponse } from "next/server";
import { rateLimitCheck, rateLimitHit, rateLimitReset } from "@/lib/rtStore";
import { ServerConfigError } from "@/lib/serverSecrets";
import {
  STUDENT_LOGIN_LOCK_MS,
  STUDENT_LOGIN_MAX_FAILURES,
  STUDENT_LOGIN_WINDOW_MS,
  STUDENT_COOKIE_NAME,
  createStudentSession,
  getClientIp,
  loginOrRegisterStudent,
  recordStudentLogin,
  studentCookieOptions,
  verifyStudentSession,
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
//
// 🔒 v5 FIXES
//   1) Brute-force limit ab DATABASE-backed hai (Vercel ke saare containers
//      ek hi counter share karte hain — pehle in-memory tha = bekaar).
//   2) Cookie banne ke turant baad SELF-VERIFY hoti hai. Agar session secret
//      misconfigured hai to "login successful + har API 401" wala silent loop
//      nahi chalega — seedha clear 503 error dikhega.
// ============================================================================

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  try {
    // ── Brute force protection ────────────────────────────────────────────
    const state = await rateLimitCheck("student_login", ip, {
      windowMs: STUDENT_LOGIN_WINDOW_MS,
      max: STUDENT_LOGIN_MAX_FAILURES,
    });
    if (!state.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `Too many wrong attempts. Please try again in ${Math.max(
            1,
            Math.ceil(state.retryAfterSec / 60)
          )} minute(s).`,
        },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const rawLoginId = String(
      body?.userId || body?.email || body?.mobile || body?.loginId || ""
    );
    const password = String(body?.password || "");

    const outcome = await loginOrRegisterStudent(rawLoginId, password);

    if (!outcome.ok || !outcome.account) {
      const failed = await rateLimitHit("student_login", ip, {
        windowMs: STUDENT_LOGIN_WINDOW_MS,
        max: STUDENT_LOGIN_MAX_FAILURES,
        lockMs: STUDENT_LOGIN_LOCK_MS,
      });
      return NextResponse.json(
        {
          ok: false,
          error: failed.locked
            ? `Too many wrong attempts. Please try again in ${Math.max(
                1,
                Math.ceil(failed.retryAfterSec / 60)
              )} minute(s).`
            : outcome.error || "Login failed. Please try again.",
        },
        { status: failed.locked ? 429 : 401 }
      );
    }

    await rateLimitReset("student_login", ip);

    const { loginId, displayName, isNewAccount } = outcome.account;

    // Admin panel ke "Login History" ke liye record (password store NAHI hota)
    await recordStudentLogin({
      loginId,
      displayName,
      isNewAccount,
      ip,
      userAgent: req.headers.get("user-agent") || "unknown",
    });

    const studentPayload = {
      uid: loginId,
      name: displayName,
      phone: /^\d{6,15}$/.test(loginId) ? loginId : "",
      email: loginId.includes("@") ? loginId : "",
    };

    const sessionToken = createStudentSession(studentPayload);

    // 🔒 SELF-VERIFY: token isi secret se verify ho raha hai ya nahi?
    // (misconfigured deployment me silent 401-loop ki jagah clear error)
    if (!verifyStudentSession(sessionToken)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Server configuration error: session signing is not working. " +
            "Please set ADMIN_SESSION_SECRET in your environment variables and redeploy.",
          code: "SESSION_SECRET_MISSING",
        },
        { status: 503 }
      );
    }

    const res = NextResponse.json({
      ok: true,
      loginTime: Date.now(),
      isNewAccount,
      student: {
        userId: loginId,
        name: displayName,
        phone: studentPayload.phone,
        email: studentPayload.email,
        isPaidUser: false,
      },
    });

    res.cookies.set(STUDENT_COOKIE_NAME, sessionToken, studentCookieOptions());
    return res;
  } catch (err) {
    if (err instanceof ServerConfigError) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Server configuration error: ADMIN_SESSION_SECRET is not set, so login sessions cannot be signed. " +
            "Add it in Vercel → Settings → Environment Variables (generate with `npm run hash-admin`), then redeploy.",
          code: "SESSION_SECRET_MISSING",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "Unable to process login right now." },
      { status: 500 }
    );
  }
}
