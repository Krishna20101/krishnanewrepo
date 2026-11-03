import { NextResponse } from "next/server";
import { STUDENT_COOKIE_NAME } from "@/lib/studentAuth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 * HttpOnly student cookie server se clear karta hai.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(STUDENT_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
