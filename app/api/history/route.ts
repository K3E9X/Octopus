// An operator's own query history, and the cases they filed it under.
//
// The sign-in page has been promising this since before it existed, "your balance and
// your query history are where you left them", and there was no way to read either.
//
// It is NOT /api/audit with a looser gate. That endpoint is oversight: every operator,
// every selector, the whole deployment, and it is administrator-only for good reason.
// This one answers a different question, what did *I* search, and under which case, // and the operator it filters on is taken off the SESSION, never off the request, so
// no caller can widen it by asking for somebody else's.

import { NextRequest, NextResponse } from "next/server";
import { listAudit, listCases, auditEnabled } from "@/lib/audit";
import { currentUser, authEnabled } from "@/lib/session-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!authEnabled || !auditEnabled) {
    return NextResponse.json({
      configured: false,
      note: "No database configured, so nothing is recorded and there is no history to show.",
      entries: [], cases: [],
    });
  }
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to see your history.", needsAuth: true }, { status: 401 });

  const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get("limit") || "40", 10) || 40);
  const caseId = req.nextUrl.searchParams.get("case") || undefined;

  const [entries, cases] = await Promise.all([
    listAudit(limit, { operator: user.email, caseId }),
    listCases(user.email),
  ]);

  return NextResponse.json({
    configured: true,
    // the hash and the chain are oversight's business, not the operator's own view
    entries: entries.map((e) => ({ at: e.at, selector: e.selector, legalBasis: e.legalBasis, caseId: e.caseId, kind: e.kind })),
    cases,
  });
}
