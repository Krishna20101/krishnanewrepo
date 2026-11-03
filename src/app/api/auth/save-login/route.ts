import { NextRequest, NextResponse } from "next/server";
import {
  createStudentSession,
  recordStudentLogin,
  studentCookieOptions,
  STUDENT_COOKIE_NAME,
  verifyStudentSession,
} from "@/lib/studentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/save-login
 * Login record refresh + session rotation. Sirf valid httpOnly student session
 * hone par chalta hai — client bheje hue password ko kabhi accept nahi karta.
 */
export async function POST(req: NextRequest) {
  const session = verifyStudentSession(
    req.cookies.get(STUDENT_COOKIE_NAME)?.value
  );

  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Please login again." },
      { status: 401 }
    );
  }

  await recordStudentLogin({
    loginId: session.uid,
    displayName: session.name || session.uid,
    isNewAccount: false,
    ip:
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown",
    userAgent: req.headers.get("user-agent") || "unknown",
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    STUDENT_COOKIE_NAME,
    createStudentSession({
      uid: session.uid,
      name: session.name,
      phone: session.phone,
      email: session.email,
      paid: session.paid,
    }),
    studentCookieOptions()
  );
  return res;
}
