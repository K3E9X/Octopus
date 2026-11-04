import { NextRequest, NextResponse } from "next/server";
import { readClientConfig } from "@/lib/reqconfig";
import { leakOsint, estimateCost, complexityOf, tokenize, isBillableWord, formatCost } from "@/lib/leakosint";
import { leakOsintSignals } from "@/lib/leaknode";
import { nodesFromExposure, applyReuse } from "@/lib/leaknodes";
import { normId } from "@/lib/extract";
import { currentUser } from "@/lib/session-server";
import { creditsEnabled, priceCredits, debit, refund, balanceOf, fmtCredits, fmtUSD, toUSD, markup } from "@/lib/credits";

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
    const raw = estimateCost(one, limit);
    return {
      query: one,
      words: toks.filter(isBillableWord),
      // the ones that are free: dates, anything under 4 characters, short numbers
      ignored: toks.filter((t) => !isBillableWord(t)),
      complexity: complexityOf(one),
      cost: raw,
      // what the operator actually pays, in credits, with the resale markup applied
      credits: priceCredits(raw),
    };
  });

  const rawTotal = estimateCost(queries, limit);
  const creditsTotal = breakdown.reduce((n, b) => n + b.credits, 0);
  return NextResponse.json({
    limit,
    metered: creditsEnabled,
    cost: rawTotal,
    credits: creditsTotal,
    formatted: creditsEnabled ? fmtCredits(creditsTotal) : formatCost(rawTotal),
    usd: fmtUSD(creditsTotal),
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

  const limit = Math.max(100, Math.min(10000, Number(body?.limit) || cfg.leakosintLimit || Number(process.env.LEAKOSINT_LIMIT) || 100));
  const lang = String(body?.lang || cfg.leakosintLang || process.env.LEAKOSINT_LANG || "en");
  const collectedAt = new Date().toISOString();

  // Metering. When a database is configured every query is charged to the signed-in
  // operator's balance BEFORE it runs, atomically, and refunded if the API does not
  // actually answer. Without a database the tool is single-operator and unmetered.
  const price = priceCredits(estimateCost(request, limit));
  const user = creditsEnabled ? await currentUser() : null;
  if (creditsEnabled) {
    if (!user) {
      return NextResponse.json({ error: "sign in to run a metered search", needsAuth: true }, { status: 401 });
    }
    const charge = await debit(user.id, price, `leak: ${(Array.isArray(request) ? request[0] : request).slice(0, 48)}`);
    if (!charge.ok) {
      return NextResponse.json({ error: charge.error, insufficient: true, balance: charge.balance, price }, { status: 402 });
    }
  }

  try {
    const res = await leakOsint({ token, request, limit, lang });
    // the money moved but the query did not run — give it back
    if (user && res.error) await refund(user.id, price, `refund: ${res.error}`);
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
        charged: creditsEnabled ? price : 0,
        balance: user ? await balanceOf(user.id) : undefined,
      });
    }

    return NextResponse.json({
      seed: term, signals, count: signals.length,
      databases: [], rowCount: 0, cost: res.cost, formatted: formatCost(res.cost), limit,
      error: res.error,
      // the query ran and matched nothing — bounded, not cleared
      empty: res.empty && !res.error,
      // a miss was still a real search: it is charged. an API error was refunded above.
      charged: creditsEnabled && !res.error ? price : 0,
      balance: user ? await balanceOf(user.id) : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: "search failed", detail: String(e) }, { status: 500 });
  }
}
