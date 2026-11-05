// Subject lookup — the product's one endpoint.
//
// GET  quotes. It costs nothing, calls nothing, and returns what the query WOULD cost
//      with the billing broken down, because the upstream API bills per request and
//      says nothing about the price until the money is gone. An operator about to run
//      a four-word name at limit 10000 should find out beforehand.
// POST runs it. Spends.
//
// There is no ownership gate. This is a lookup tool, the same shape as every commercial
// product in the category, and what replaces the gate is accountability rather than
// nothing: every query carries a declared legal basis from a closed list and is written
// to the append-only, hash-chained trail (lib/audit) BEFORE it runs, so a refused or
// failed attempt leaves a trace too. A trail that records only successes hides the
// interesting half.

import { NextRequest, NextResponse } from "next/server";
import { readClientConfig } from "@/lib/reqconfig";
import { currentUser, authEnabled } from "@/lib/session-server";
import { leakOsint, estimateCost, complexityOf, tokenize, isBillableWord, formatCost } from "@/lib/leakosint";
import { buildReport, headline } from "@/lib/report";
import { buildSubject } from "@/lib/subject";
import { recordQuery, auditEnabled } from "@/lib/audit";
import { creditsEnabled, priceCredits, debit, refund, balanceOf, fmtCredits, fmtUSD } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** The bases a lookup may be run under. A closed list: a free-text field is a field nobody reads. */
const LEGAL_BASES = ["own-data", "consent", "investigation", "legal-request", "security-research"] as const;
const BASES = new Set<string>(LEGAL_BASES);

const clampLimit = (n: unknown) => Math.max(100, Math.min(10000, Number(n) || 100));

// ---- GET: what would this cost? ---------------------------------------------------

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!raw) return NextResponse.json({ error: "no query" }, { status: 400 });
  const limit = clampLimit(req.nextUrl.searchParams.get("limit"));
  const country = (req.nextUrl.searchParams.get("country") || "FR").toUpperCase();

  // Both ways of searching a multi-word subject are priced, because the choice is the
  // operator's and it is not only about money: quoting is cheaper AND narrower.
  const exact = buildSubject(raw, { defaultCountry: country, exact: true });
  const loose = buildSubject(raw, { defaultCountry: country, exact: false });

  const quote = (query: string) => {
    const usd = estimateCost(query, limit);
    const toks = tokenize(query);
    return {
      query,
      complexity: complexityOf(query),
      words: toks.filter(isBillableWord),
      // the ones that are free: dates, anything under 4 characters, short numbers
      ignored: toks.filter((t) => !isBillableWord(t)),
      usd,
      credits: priceCredits(usd),
      formatted: creditsEnabled ? fmtCredits(priceCredits(usd)) : formatCost(usd),
    };
  };

  const sameQuery = exact.query === loose.query;
  return NextResponse.json({
    subject: { raw: exact.raw, kind: exact.kind, canonical: exact.canonical, unique: exact.unique },
    limit,
    metered: creditsEnabled,
    exact: { ...quote(exact.query), note: exact.note },
    // only offered when quoting actually changes the query — on an address it does not
    permutations: sameQuery ? null : { ...quote(loose.query), note: loose.note },
    usd: fmtUSD(priceCredits(estimateCost(exact.query, limit))),
  });
}

// ---- POST: run it -----------------------------------------------------------------

export async function POST(req: NextRequest) {
  // Without a database there is nowhere to keep accounts, so the deployment is
  // SINGLE-OPERATOR: the tool runs, unmetered and unlogged, and the response says so
  // on every search rather than implying a protection that does not exist. Demanding
  // a sign-in here instead would make a database-less deployment simply not work,
  // which is what the container and compose files promise it does.
  const user = authEnabled ? await currentUser() : null;
  if (authEnabled && !user) {
    return NextResponse.json({ error: "Sign in to run a search.", needsAuth: true }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const raw = String(body?.subject || "").trim();
  if (!raw) return NextResponse.json({ error: "Enter something to search for." }, { status: 400 });
  if (raw.length > 256) return NextResponse.json({ error: "That query is too long to be a selector." }, { status: 400 });

  // The accountability gate. Cheap to satisfy, impossible to skip: the record of WHY
  // has to exist before the data does.
  const legalBasis = String(body?.legalBasis || "");
  if (!BASES.has(legalBasis)) {
    return NextResponse.json({
      error: "Declare the basis for this search before running it.",
      needsBasis: true, bases: LEGAL_BASES,
    }, { status: 403 });
  }

  const subject = buildSubject(raw, {
    defaultCountry: String(body?.country || "FR").toUpperCase(),
    // quoting is the default for a multi-word subject: cheaper, and narrower is the
    // safer error to make when the alternative is returning strangers' records
    exact: body?.permutations !== true,
  });

  const cfg = readClientConfig(req);
  const token = cfg.leakosint || process.env.LEAKOSINT_TOKEN || "";
  if (!token) {
    return NextResponse.json({ error: "This deployment has no leak-data source configured.", configured: false }, { status: 400 });
  }

  const limit = clampLimit(body?.limit || cfg.leakosintLimit || process.env.LEAKOSINT_LIMIT);
  const price = priceCredits(estimateCost(subject.query, limit));

  // Recorded before the query runs. Fire-and-forget: the trail must never be able to
  // block or break collection, but it must exist whether or not the query succeeds.
  recordQuery({
    operator: user?.email || "single-operator",
    kind: "search",
    selector: subject.canonical,
    legalBasis,
    caseId: String(body?.caseRef || "") || undefined,
    note: `kind=${subject.kind} limit=${limit} query=${subject.query}`,
  }).catch(() => {});

  if (creditsEnabled && user) {
    const charge = await debit(user.id, price, `search: ${subject.canonical.slice(0, 48)}`);
    if (!charge.ok) {
      return NextResponse.json({ error: charge.error, insufficient: true, balance: charge.balance, price }, { status: 402 });
    }
  }

  try {
    const res = await leakOsint({
      token, request: subject.query, limit,
      lang: cfg.leakosintLang || process.env.LEAKOSINT_LANG || "en",
    });

    // The API answers 200 even when it refuses. A refusal is not a clean result, and
    // the money goes back because the query did not run.
    if (res.error) {
      if (user) await refund(user.id, price, `refund: ${res.error}`);
      return NextResponse.json({
        error: `The leak source refused the query: ${res.error}`,
        refunded: true, balance: user ? await balanceOf(user.id) : undefined,
      }, { status: 502 });
    }

    const report = buildReport(subject, res.databases);
    return NextResponse.json({
      report,
      headline: headline(report),
      // what was actually asked of the API, so the price shown is explainable
      query: { sent: subject.query, limit, rowsReturned: res.rowCount, databases: res.databases.length },
      charged: creditsEnabled && user ? price : 0,
      // Never let silence imply a protection. A deployment with no database has no
      // accounts, no metering and no query log, and the interface must be able to say so.
      deployment: { metered: creditsEnabled && !!user, logged: auditEnabled, operator: user?.email || null },
      balance: user ? await balanceOf(user.id) : undefined,
    });
  } catch {
    if (user) await refund(user.id, price, "refund: search threw");
    return NextResponse.json({
      error: "The search failed — you were not charged.",
      refunded: true, balance: user ? await balanceOf(user.id) : undefined,
    }, { status: 500 });
  }
}
