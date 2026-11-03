import { NextRequest, NextResponse } from "next/server";
import {
  DishaAccount,
  checkStudentLoginRateLimit,
  clearStudentLoginAttempts,
  createStudentSession,
  getClientIp,
  parseDishaLoginResponse,
  recordStudentLogin,
  recordStudentLoginFailure,
  studentCookieOptions,
  STUDENT_COOKIE_NAME,
} from "@/lib/studentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ============================================================================
// POST /api/auth/login — Disha 2-step login (SERVER-SIDE, same as do_login()
// in dishaplayer.py):
//   Step 1 → POST /post/userLogin             (okhttp headers)
//     status 200 → done
//     status 203 → Step 2
//   Step 2 → POST /post/userLogin?extra_details=0 (website headers)
//     status 200 → done
//     else      → error
//
// Browser se seedha Disha call karne ki zaroorat nahi — CORS/User-Agent ki
// dikkat khatam, aur token httpOnly cookie me safely set hota hai.
// ============================================================================

// Testing ke liye override (default: production Disha API — Vercel par kuch
// set karne ki zaroorat nahi hai)
const DISHA_API = (
  process.env.DISHA_API_BASE_URL || "https://dishaonlineclassesapi.classx.co.in"
).replace(/\/$/, "");
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
const REQUEST_TIMEOUT_MS = 20000;

async function postForm(
  path: string,
  body: URLSearchParams,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${DISHA_API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: body.toString(),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Kabhi kabhi HTML/JSON mixed aata hai — pehla {...} nikal lo
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      }
      return {};
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  // ── Rate limit (brute force se bachao) ───────────────────────────────────
  const rate = checkStudentLoginRateLimit(ip);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Bahut zyada galat koshish. ${Math.ceil(
          (rate.retryAfterSec || 60) / 60
        )} minute baad try karein.`,
      },
      { status: 429 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const inputId = String(
      body?.userId || body?.email || body?.mobile || ""
    ).trim();
    const password = String(body?.password || "").trim();

    if (!inputId || !password) {
      return NextResponse.json(
        { ok: false, error: "Please enter Mobile Number / ID and Password." },
        { status: 400 }
      );
    }

    if (inputId.length > 120 || password.length > 200) {
      return NextResponse.json(
        { ok: false, error: "Invalid input length." },
        { status: 400 }
      );
    }

    // ── STEP 1 ────────────────────────────────────────────────────────────
    let step1: Record<string, unknown> = {};
    try {
      const step1Body = new URLSearchParams();
      step1Body.append("email", inputId);
      step1Body.append("password", password);

      step1 = await postForm("/post/userLogin", step1Body, {
        "Auth-Key": "appxapi",
        "User-Id": "-2",
        Authorization: "",
        Language: "en",
        "User-Agent": "okhttp/4.9.1",
      });
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not reach Disha servers. Please try again." },
        { status: 502 }
      );
    }

    // Step 1 success
    const accountStep1 = parseDishaLoginResponse(step1);
    if (accountStep1) {
      return await finishLogin(req, accountStep1, inputId, ip);
    }

    // ── STEP 2 (status 203 → website flow) ─────────────────────────────────
    if (Number(step1?.status) === 203) {
      let step2: Record<string, unknown> = {};
      try {
        const step2Body = new URLSearchParams();
        step2Body.append("source", "website");
        step2Body.append("phone", inputId);
        step2Body.append("email", inputId);
        step2Body.append("password", password);
        step2Body.append("extra_details", "1");

        step2 = await postForm(
          "/post/userLogin?extra_details=0",
          step2Body,
          {
            "auth-key": "appxapi",
            "client-service": "Appx",
            source: "website",
            "user-agent": MOBILE_UA,
            accept: "*/*",
          }
        );
      } catch {
        return NextResponse.json(
          {
            ok: false,
            error: "Could not reach Disha servers. Please try again.",
          },
          { status: 502 }
        );
      }

      const accountStep2 = parseDishaLoginResponse(step2);
      if (accountStep2) {
        return await finishLogin(req, accountStep2, inputId, ip);
      }

      recordStudentLoginFailure(ip);
      const msg =
        String(step2?.message || "").trim() ||
        "Invalid User ID / Mobile Number or Password.";
      return NextResponse.json({ ok: false, error: msg }, { status: 401 });
    }

    // Kuch aur status — Disha ka message ya generic error
    recordStudentLoginFailure(ip);
    const errMsg =
      String(step1?.message || "").trim() ||
      "Invalid User ID / Mobile Number or Password.";
    return NextResponse.json({ ok: false, error: errMsg }, { status: 401 });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to process login right now." },
      { status: 500 }
    );
  }
}

async function finishLogin(
  req: NextRequest,
  account: DishaAccount,
  inputId: string,
  ip: string
) {
  clearStudentLoginAttempts(ip);

  // Admin panel ke "Saved Logins" ke liye record (password store NAHI hota)
  await recordStudentLogin({
    account,
    inputId,
    ip,
    userAgent: req.headers.get("user-agent") || "unknown",
  });

  const sessionToken = createStudentSession({
    uid: account.userId,
    name: account.name,
    phone: account.phone,
    email: account.email,
    paid: account.isPaidUser,
  });

  const res = NextResponse.json({
    ok: true,
    loginTime: Date.now(),
    student: {
      name: account.name,
      phone: account.phone,
      email: account.email,
      userId: account.userId,
      isPaidUser: account.isPaidUser,
    },
  });

  res.cookies.set(STUDENT_COOKIE_NAME, sessionToken, studentCookieOptions());
  return res;
}
