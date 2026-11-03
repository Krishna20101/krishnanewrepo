import { NextRequest, NextResponse } from "next/server";
import { getStudentSessionFromRequest } from "@/lib/studentAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session
 * Client isse check karta hai ki httpOnly cookie ke hisaab se student
 * logged-in hai ya nahi (localStorage par bharosa nahi).
 */
export async function GET(req: NextRequest) {
  const session = getStudentSessionFromRequest(req);

  if (!session) {
    return NextResponse.json({ ok: true, loggedIn: false });
  }

  return NextResponse.json({
    ok: true,
    loggedIn: true,
    student: {
      userId: session.uid,
      name: session.name || "",
      phone: session.phone || "",
      email: session.email || "",
      isPaidUser: Boolean(session.paid),
    },
  });
}
