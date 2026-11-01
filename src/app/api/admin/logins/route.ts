import { NextRequest, NextResponse } from "next/server";
import { isRequestAdminAuthorized } from "@/lib/adminAuth";
import { deleteAdminUserLogin, getAdminSavedUserLogins } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isRequestAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const logins = await getAdminSavedUserLogins();
  return NextResponse.json({
    ok: true,
    total: logins.length,
    logins,
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
      { ok: false, error: "Missing login id" },
      { status: 400 }
    );
  }

  await deleteAdminUserLogin(id);
  return NextResponse.json({ ok: true });
}
