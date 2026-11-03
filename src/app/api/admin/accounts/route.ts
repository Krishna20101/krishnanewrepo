import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import { deleteStudentAccount, getAllStudentAccounts } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET    /api/admin/accounts           → saare student accounts (password hash
 *                                        kabhi client ko nahi bhejta)
 * DELETE /api/admin/accounts?id=xyz    → account delete
 */
export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const accounts = await getAllStudentAccounts();

  return NextResponse.json({
    ok: true,
    total: accounts.length,
    // 🔐 hash/salt kabhi client tak nahi jate
    accounts: accounts.map((a) => ({
      loginId: a.loginId,
      displayName: a.displayName,
      createdAt: a.createdAt,
      lastLoginAt: a.lastLoginAt || "",
      loginCount: a.loginCount || 0,
      provider: a.provider || "password",
      hasPassword: Boolean(a.passwordHash),
    })),
  });
}

export async function DELETE(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Missing account id" },
      { status: 400 }
    );
  }

  await deleteStudentAccount(id);
  return NextResponse.json({ ok: true });
}
