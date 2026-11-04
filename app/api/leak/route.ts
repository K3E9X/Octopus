import { NextRequest, NextResponse } from "next/server";
import { readClientConfig } from "@/lib/reqconfig";
import { leakOsint, estimateCost, complexityOf, tokenize, isBillableWord, formatCost } from "@/lib/leakosint";
import { leakOsintSignals } from "@/lib/leaknode";
import { nodesFromExposure, applyReuse } from "@/lib/leaknodes";
import { normId } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * The primary leak endpoint.
 *
 * GET  — quote only. Costs nothing, calls nothing, and returns what the query WOULD
 *        cost with the billing breakdown. This exists because the upstream API bills
 *        per request and says nothing about the price until the money is gone; an
 *        operator running a four-word name query at limit 10000 should find out
 *        beforehand, not afterwards.
 * POST  — run it. Spends.
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  const limit = Math.max(100, Math.min(10000, Number(req.nextUrl.searchParams.get("limit")) || 100));
  if (!q) return NextResponse.json({ error: "no query" }, { status: 400 });

  const queries = q.split("\n").map((x) => x.trim()).filter(Boolean);
  const breakdown = queries.map((one) => {
    const toks = tokenize(one);
    return {
      query: one,
      words: toks.filter(isBillableWord),
      // the ones that are free: dates, anything under 4 characters, short numbers
      ignored: toks.filter((t) => !isBillableWord(t)),
      complexity: complexityOf(one),
      cost: estimateCost(one, limit),
    };
  });

  return NextResponse.json({
    limit,
    total: estimateCost(queries, limit),
    formatted: formatCost(estimateCost(queries, limit)),
    breakdown,
  });
}

export async function POST(req: NextRequest) {
  const cfg = readClientConfig(req);
  const token = cfg.leakosint || process.env.LEAKOSINT_TOKEN || "";
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is a bad request below */ }

  const request: string | string[] = body?.request ?? body?.q ?? "";
  const flat = Array.isArray(request) ? request.join("\n") : String(request || "");
  if (!flat.trim()) return NextResponse.json({ error: "no query" }, { status: 400 });

  // A missing token is a CONFIGURATION state, not a failed search. Saying "nothing
  // found" here would be the worst possible answer.
  if (!token) {
    return NextResponse.json({
      error: "no LeakOSINT token configured",
      hint: "Run /api in the bot to get a token, then paste it under Sources → LeakOSINT.",
      configured: false,
    }, { status: 400 });
  }

  const limit = Math.max(100, Math.min(10000, Number(body?.limit) || cfg.leakosintLimit || 100));
  const lang = String(body?.lang || cfg.leakosintLang || "en");
  const collectedAt = new Date().toISOString();

  try {
    const res = await leakOsint({ token, request, limit, lang });
    const term = Array.isArray(request) ? request[0] : String(request);
    const signals = leakOsintSignals(term, res, collectedAt);

    // The recovered selectors become their own nodes and the reuse guard runs over
    // them, so a leak hit immediately becomes something to investigate rather than
    // something to read.
    const root = signals[0];
    if (root?.exposure?.length) {
      const { nodes, leads } = nodesFromExposure(root.id, root.exposure, term, [], collectedAt);
      for (const n of nodes) if (!signals.some((s) => s.id === n.id)) signals.push(n);
      applyReuse(signals, root.exposure, root.id);
      return NextResponse.json({
        seed: term, signals, count: signals.length,
        databases: res.databases.map((d) => ({ name: d.name, info: d.info, rows: d.rows.length })),
        rowCount: res.rowCount, cost: res.cost, formatted: formatCost(res.cost), limit,
        leads: leads.map((l) => ({ kind: l.kind, value: l.value, why: l.why })),
        error: res.error,
      });
    }

    return NextResponse.json({
      seed: term, signals, count: signals.length,
      databases: [], rowCount: 0, cost: res.cost, formatted: formatCost(res.cost), limit,
      error: res.error,
      // the query ran and matched nothing — bounded, not cleared
      empty: res.empty && !res.error,
    });
  } catch (e) {
    return NextResponse.json({ error: "search failed", detail: String(e) }, { status: 500 });
  }
}
