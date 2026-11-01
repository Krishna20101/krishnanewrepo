import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE_NAME,
  checkAdminRateLimit,
  clearAdminAttempts,
  createEncryptedAdminSession,
  isAdminEnvConfigured,
  recordFailedAdminAttempt,
  verifyAdminCredentials,
} from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!isAdminEnvConfigured()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Admin login is locked until ADMIN_EMAIL and ADMIN_PASSWORD are set in server Environment Variables (.env).",
        },
        { status: 503 }
      );
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    const rate = checkAdminRateLimit(ip);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `Too many failed attempts. Locked for ${rate.retryAfterSec}s.`,
        },
        { status: 429 }
      );
    }

    const body = await req.json();
    const email = String(body?.email || "").trim();
    const password = String(body?.password || "");

    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email and Password are required." },
        { status: 400 }
      );
    }

    const valid = await verifyAdminCredentials(email, password);
    if (!valid) {
      recordFailedAdminAttempt(ip);
      return NextResponse.json(
        { ok: false, error: "Invalid Admin credentials. Access denied." },
        { status: 401 }
      );
    }

    clearAdminAttempts(ip);
    const encryptedToken = createEncryptedAdminSession();

    const res = NextResponse.json({
      ok: true,
      adminToken: encryptedToken,
    });

    res.cookies.set(ADMIN_COOKIE_NAME, encryptedToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24,
    });

    return res;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Admin authentication failed." },
      { status: 500 }
    );
  }
}
