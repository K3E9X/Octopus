// The administration surface. Every handler re-checks the caller's role: a UI that
// hides a button is not access control.

import { NextRequest, NextResponse } from "next/server";
import { listUsers, setRole, type Role } from "@/lib/auth";
import { requireAdmin, authEnabled } from "@/lib/session-server";
import { listAudit, verifyAuditChain, auditEnabled } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!authEnabled) return NextResponse.json({ configured: false });
  if (!(await requireAdmin())) return NextResponse.json({ error: "administrator only" }, { status: 403 });
  const [users, activity, chain] = await Promise.all([
    listUsers(),
    auditEnabled ? listAudit(60) : Promise.resolve([]),
    auditEnabled ? verifyAuditChain() : Promise.resolve(null),
  ]);
  return NextResponse.json({ configured: true, users, activity, chain });
}

export async function POST(req: NextRequest) {
  if (!authEnabled) return NextResponse.json({ configured: false }, { status: 501 });
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "administrator only" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  const role = String(body?.role || "") as Role;
  if (!id || !["admin", "analyst", "disabled"].includes(role)) {
    return NextResponse.json({ error: "id and a valid role are required" }, { status: 400 });
  }
  if (id === admin.id && role !== "admin") {
    return NextResponse.json({ error: "you cannot remove your own administrator role" }, { status: 400 });
  }
  const r = await setRole(id, role);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
