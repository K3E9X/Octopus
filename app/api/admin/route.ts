// The administration surface. Every handler re-checks the caller's role: a UI that
// hides a button is not access control.

import { NextRequest, NextResponse } from "next/server";
import { listUsers, setRole, type Role } from "@/lib/auth";
import { requireAdmin, authEnabled } from "@/lib/session-server";
import { listAudit, verifyAuditChain, auditEnabled } from "@/lib/audit";
import { grant, balanceOf, ledgerOf, creditsToMicro, balanceCredits, creditsEnabled, trialNote } from "@/lib/credits";
import { sourceFingerprint, setSourceToken, clearSourceToken, sourceToken, storedKeyAvailable } from "@/lib/sourcekey";
import { leakOsint, estimateCost, formatCost } from "@/lib/leakosint";
import { dbReachable } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!authEnabled) return NextResponse.json({ configured: false });
  if (!(await requireAdmin())) return NextResponse.json({ error: "administrator only" }, { status: 403 });
  const [users, activity, chain, source] = await Promise.all([
    listUsers(),
    auditEnabled ? listAudit(60) : Promise.resolve([]),
    auditEnabled ? verifyAuditChain() : Promise.resolve(null),
    // a FINGERPRINT, never the token: an admin screen that re-displays a secret is a
    // secret that leaks through a screenshot or a support ticket
    sourceFingerprint(),
  ]);
  // A connection string is a configuration, not a connection, and this screen is
  // exactly where that difference should be visible rather than inferred from a page
  // that half-loads.
  const database = await dbReachable();
  // balance per user, so the admin sees who is low without clicking into each
  const withBalance = creditsEnabled
    ? await Promise.all(users.map(async (u) => ({ ...u, credits: balanceCredits(await balanceOf(u.id)) })))
    : users;
  return NextResponse.json({
    configured: true, metered: creditsEnabled, users: withBalance, activity, chain,
    source, storable: storedKeyAvailable, database, trial: creditsEnabled ? trialNote() : "",
  });
}

export async function POST(req: NextRequest) {
  if (!authEnabled) return NextResponse.json({ configured: false }, { status: 501 });
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "administrator only" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");

  // ---- the source token ------------------------------------------------------------
  // Stored once by an administrator and used by every search on the deployment, so
  // changing it is a paste rather than a redeploy. The value is never echoed back.

  if (body?.action === "source-set") {
    const r = await setSourceToken(String(body?.token || ""), admin.email);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, source: await sourceFingerprint() });
  }

  if (body?.action === "source-clear") {
    const r = await clearSourceToken();
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, source: await sourceFingerprint() });
  }

  /**
   * Prove the token works, by using it.
   *
   * There is no free way to do this. A malformed request would be free and is exactly
   * what must not be sent: the endpoint answers repeated invalid data by blocking the
   * caller's IP for ~30 seconds, which would take the whole deployment down rather than
   * test anything. So the check is one real, well-formed query at the minimum limit —
   * about $0.003 — and the UI says so before the button is pressed.
   *
   * The term is a fixed, deliberately meaningless string: it has to be a valid query,
   * and it must not be anybody's identifier.
   */
  if (body?.action === "source-test") {
    const { token, from } = await sourceToken();
    if (!token) return NextResponse.json({ error: "no token is configured to test" }, { status: 400 });
    const term = "octopusleak-connectivity-probe";
    const cost = estimateCost(term, 100);
    try {
      const res = await leakOsint({ token, request: term, limit: 100, lang: "en", timeoutMs: 20000 });
      if (res.error) {
        return NextResponse.json({ ok: false, from, spent: formatCost(0), reason: res.error });
      }
      // The query ran. Whether it matched anything is irrelevant — reaching the index
      // at all is the entire question a connectivity test asks.
      return NextResponse.json({
        ok: true, from, spent: formatCost(cost),
        detail: `The index answered. ${res.databases.length} database(s) matched the probe term, which is expected to be none.`,
      });
    } catch {
      return NextResponse.json({ ok: false, from, spent: formatCost(0), reason: "the endpoint could not be reached" });
    }
  }

  // ---- balances --------------------------------------------------------------------
  // Granted in CREDITS — one credit, one search. Dollars were never the unit anybody
  // administering this thinks in: the question is "how many more searches should they
  // get", and the answer should be the number you type. Negative claws back.
  if (body?.action === "grant") {
    if (!creditsEnabled) return NextResponse.json({ error: "no database — the tool runs unmetered" }, { status: 400 });
    const n = Math.trunc(Number(body?.credits ?? body?.usd));
    if (!id || !Number.isFinite(n) || n === 0) {
      return NextResponse.json({ error: "a user and a non-zero whole number of credits are required" }, { status: 400 });
    }
    const r = await grant(id, creditsToMicro(n), `admin ${n > 0 ? "grant" : "clawback"} of ${Math.abs(n)} credit(s) by ${admin.email}`);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, balance: balanceCredits(r.balance ?? 0) });
  }

  if (body?.action === "ledger") {
    if (!id) return NextResponse.json({ error: "a user is required" }, { status: 400 });
    return NextResponse.json({ ok: true, ledger: await ledgerOf(id) });
  }

  const role = String(body?.role || "") as Role;
  if (!id || !["admin", "analyst", "tester", "disabled"].includes(role)) {
    return NextResponse.json({ error: "id and a valid role are required" }, { status: 400 });
  }
  if (id === admin.id && role !== "admin") {
    return NextResponse.json({ error: "you cannot remove your own administrator role" }, { status: 400 });
  }
  const r = await setRole(id, role);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
