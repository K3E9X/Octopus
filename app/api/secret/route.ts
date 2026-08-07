import { NextRequest, NextResponse } from "next/server";
import { searchBySecret } from "@/lib/breaches";
import { nodesFromExposure, applyReuse } from "@/lib/leaknodes";
import { normId } from "@/lib/extract";
import { exposureVerdict } from "@/lib/exposure";
import type { Signal } from "@/lib/signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Search by SECRET rather than by identity: who else used this password?
 *
 * A separate route on purpose. This is the one query in Octopus that starts from a
 * credential instead of a person, which makes it both the widest identity sweep
 * available and the easiest to misuse — so it is a deliberate action an analyst takes,
 * never something a scan does on its own initiative.
 *
 * The refusal path is the important one: on a common password the engine returns the
 * reason instead of results, because `123456` would come back as an unbounded set of
 * unrelated strangers, every one of them labelled as a lead.
 */
export async function GET(req: NextRequest) {
  const secret = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!secret) return NextResponse.json({ error: "no secret" }, { status: 400 });

  try {
    const { items, refused } = await searchBySecret(secret);
    if (refused) return NextResponse.json({ refused, signals: [] });
    if (!items.length) return NextResponse.json({ signals: [], count: 0 });

    const collectedAt = new Date().toISOString();
    const rootId = "secret:" + normId(secret).slice(0, 32);
    const root: Signal = {
      id: rootId,
      platform: "SHARED PASSWORD",
      handle: secret,
      disc: "PW",
      kind: "leak",
      confidence: 60,
      tier: "possible",
      status: "review",
      collectedAt,
      exposure: items,
      evidence: [{
        name: "Identities sharing this password",
        detail: `${new Set(items.filter((i) => i.kind === "identifier").map((i) => i.value)).size} account(s) appear in combolists with this exact secret. ${exposureVerdict(items)}. Sharing a password is behavioural evidence of ONE PERSON — it is not proof, and two of these may still be strangers who chose the same string.`,
        source: "proxynova · by-secret",
        weight: 70,
      }],
    };

    // the identities become nodes, then the reuse guard decides what actually links
    const { nodes } = nodesFromExposure(rootId, items, secret, [], collectedAt);
    const signals = [root, ...nodes];
    applyReuse(signals, items, rootId);

    return NextResponse.json({ signals, count: signals.length });
  } catch (e) {
    return NextResponse.json({ error: "search failed", detail: String(e) }, { status: 500 });
  }
}
