import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE_NAME,
  createEncryptedAdminSession,
  isAdminEnvConfigured,
  verifyAdminCredentials,
} from "@/lib/adminAuth";
import { rateLimitCheck, rateLimitHit, rateLimitReset } from "@/lib/rtStore";
import { ServerConfigError } from "@/lib/serverSecrets";

export const dynamic = "force-dynamic";

/** 5 galat attempt / 5 minute window → 5 minute lock (per IP, DATABASE-backed). */
const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

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

    // ── Brute force protection (shared across all serverless instances) ────
    const state = await rateLimitCheck("admin_login", ip, {
      windowMs: WINDOW_MS,
      max: MAX_FAILURES,
    });
    if (!state.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `Too many failed attempts. Locked for ${state.retryAfterSec}s.`,
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
      const failed = await rateLimitHit("admin_login", ip, {
        windowMs: WINDOW_MS,
        max: MAX_FAILURES,
        lockMs: LOCK_MS,
      });
      return NextResponse.json(
        {
          ok: false,
          error: failed.locked
            ? `Invalid Admin credentials. Locked for ${failed.retryAfterSec}s.`
            : `Invalid Admin credentials. ${failed.remaining} attempt(s) left before a temporary lock.`,
        },
        { status: failed.locked ? 429 : 401 }
      );
    }

    await rateLimitReset("admin_login", ip);
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
  } catch (err) {
    if (err instanceof ServerConfigError) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Server configuration error: ADMIN_SESSION_SECRET is not set. Add it in Vercel → Settings → Environment Variables (generate one with `npm run hash-admin`), then redeploy.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "Admin authentication failed." },
      { status: 500 }
    );
  }
}
