// The oversight surface: who queried what, when, and under what authority.
//
// ADMINISTRATOR ONLY. This endpoint shipped with no authentication at all, which made
// the single most sensitive table in the deployment world-readable: every operator's
// address, every selector anyone had ever searched, the real people this tool was
// pointed at, plus the declared basis and case reference for each. A breach-lookup
// product leaking its own query log is worse than most of what it searches for.

import { NextRequest, NextResponse } from "next/server";
import { listAudit, verifyAuditChain, auditEnabled } from "@/lib/audit";
import { requireAdmin, authEnabled } from "@/lib/session-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // No database means no accounts, so there is nobody to authorise, and also no trail
  // to read. Saying so is the honest answer; serving the endpoint open is not.
  if (!authEnabled || !auditEnabled) {
    return NextResponse.json({
      configured: false,
      note: "No database configured. Queries are NOT being logged, and there are no accounts to authorise this view. Set POSTGRES_URL.",
    });
  }
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "administrator only" }, { status: 403 });
  }

  const limit = Math.min(500, parseInt(req.nextUrl.searchParams.get("limit") || "100", 10) || 100);
  const selector = req.nextUrl.searchParams.get("selector") || undefined;
  const wantVerify = req.nextUrl.searchParams.get("verify") === "1";
  const entries = await listAudit(limit, selector);
  const chain = wantVerify ? await verifyAuditChain() : null;
  return NextResponse.json({ configured: true, count: entries.length, entries, chain });
}
