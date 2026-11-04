// The administration surface. Every handler re-checks the caller's role: a UI that
// hides a button is not access control.

import { NextRequest, NextResponse } from "next/server";
import { listUsers, setRole, type Role } from "@/lib/auth";
import { requireAdmin, authEnabled } from "@/lib/session-server";
import { listAudit, verifyAuditChain, auditEnabled } from "@/lib/audit";
import { grant, balanceOf, ledgerOf, fromUSD, creditsEnabled } from "@/lib/credits";

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
  // balance per user, so the admin sees who is low without clicking into each
  const withBalance = creditsEnabled
    ? await Promise.all(users.map(async (u) => ({ ...u, credits: await balanceOf(u.id) })))
    : users;
  return NextResponse.json({ configured: true, metered: creditsEnabled, users: withBalance, activity, chain });
}

export async function POST(req: NextRequest) {
  if (!authEnabled) return NextResponse.json({ configured: false }, { status: 501 });
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "administrator only" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");

  // top up (or claw back) a balance. Admin enters dollars; we store micro-dollars.
  if (body?.action === "grant") {
    if (!creditsEnabled) return NextResponse.json({ error: "no database — the tool runs unmetered" }, { status: 400 });
    const usd = Number(body?.usd);
    if (!id || !Number.isFinite(usd) || usd === 0) return NextResponse.json({ error: "a user and a non-zero dollar amount are required" }, { status: 400 });
    const r = await grant(id, fromUSD(usd), `admin ${usd > 0 ? "grant" : "clawback"} by ${admin.email}`);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, balance: r.balance });
  }

  if (body?.action === "ledger") {
    if (!id) return NextResponse.json({ error: "a user is required" }, { status: 400 });
    return NextResponse.json({ ok: true, ledger: await ledgerOf(id) });
  }

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
