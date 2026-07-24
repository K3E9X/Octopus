import { NextRequest, NextResponse } from "next/server";
import { listAudit, verifyAuditChain, auditEnabled } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/audit?limit=&selector=&verify=1
// The oversight surface: who queried what, when, under what authority — plus a
// verification of the hash chain, so tampering with the trail is detectable.
export async function GET(req: NextRequest) {
  if (!auditEnabled) {
    return NextResponse.json({ configured: false, note: "No database configured — queries are NOT being logged. Set POSTGRES_URL to enable the audit trail." });
  }
  const limit = Math.min(500, parseInt(req.nextUrl.searchParams.get("limit") || "100", 10) || 100);
  const selector = req.nextUrl.searchParams.get("selector") || undefined;
  const wantVerify = req.nextUrl.searchParams.get("verify") === "1";
  const entries = await listAudit(limit, selector);
  const chain = wantVerify ? await verifyAuditChain() : null;
  return NextResponse.json({ configured: true, count: entries.length, entries, chain });
}
