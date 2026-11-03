import { NextRequest, NextResponse } from "next/server";
import {
  recordStudentLogin,
  studentCookieOptions,
  STUDENT_COOKIE_NAME,
  createStudentSession,
  verifyStudentSession,
} from "@/lib/studentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/save-login
 *
 * ⚠️ Ye route AB sirf "login record refresh" ke liye hai.
 * Pehle isme client se aaya hua password store hota tha aur bina verify kiye
 * session token mil jata tha. Ab:
 *   • Password accept/store NAHI hota.
 *   • Body me client jo bhi bheje, usse session nahi banti.
 *   • Session sirf tab issue hoti hai jab valid httpOnly student session ho.
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

  const body = await req.json().catch(() => ({}));
  const dishaResponse = body?.dishaResponse;

  if (dishaResponse && typeof dishaResponse === "object") {
    await recordStudentLogin({
      account: {
        userId: session.uid,
        token: "session",
        name: session.name || "",
        email: session.email || "",
        phone: session.phone || "",
        username: "",
        state: "",
        photo: "",
        appCategory: "",
        isPaidUser: Boolean(session.paid),
        isTester: "",
        aadharStatus: "",
        rawResponse: dishaResponse as Record<string, unknown>,
      },
      inputId: session.uid,
      ip:
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        "unknown",
      userAgent: req.headers.get("user-agent") || "unknown",
    });
  }

  const res = NextResponse.json({ ok: true });
  // Session rotate = security upgrade
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
