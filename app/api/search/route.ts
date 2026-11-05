// Subject lookup, the product's one endpoint.
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
import { sourceToken } from "@/lib/sourcekey";
import { creditsEnabled, priceCredits, searchCredits, balanceCredits, fmtPrice, debit, refund, balanceOf, fmtUSD } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** The bases a lookup may be run under. A closed list: a free-text field is a field nobody reads. */
const LEGAL_BASES = ["own-data", "consent", "investigation", "legal-request", "security-research"] as const;
const BASES = new Set<string>(LEGAL_BASES);

/**
 * Search depth.
 *
 * The documentation calls this a result limit, but it is also "la plage de recherche
 * dans la base de données", how far into the dumps the query reaches. 100 is the API's
 * own default and the cheapest; the vendor's reference bot ships 300, and the gap shows
 * up as rows you simply never see. 300 is the default here for the same reason, and the
 * price of every depth is quoted before it is spent.
 */
const DEFAULT_LIMIT = 300;
const clampLimit = (n: unknown) => Math.max(100, Math.min(10000, Number(n) || DEFAULT_LIMIT));

/**
 * The depth a request will actually run at.
 *
 * Shared by the quote and by the charge, because they used to resolve it separately:
 * the quote read only the query string, while the charge also consulted the browser's
 * config header and LEAKOSINT_LIMIT, a documented, compose-wired setting. On any
 * deployment that set it, every quote was priced at 300 and every search billed at the
 * configured depth. A price shown is a promise; two code paths deciding it is how the
 * promise gets broken without anybody writing a bug.
 */
function resolveLimit(req: NextRequest, explicit?: unknown): number {
  const cfg = readClientConfig(req);
  return clampLimit(explicit || cfg.leakosintLimit || process.env.LEAKOSINT_LIMIT || DEFAULT_LIMIT);
}

// ---- GET: what would this cost? ---------------------------------------------------

export async function GET(req: NextRequest) {
  const limit = resolveLimit(req, req.nextUrl.searchParams.get("limit"));

  // A pivot is quoted as a batch: several selectors, billed per selector, one round
  // trip. The operator sees the total before a single one of them is sent.
  const pivots = (req.nextUrl.searchParams.getAll("pivot") || []).map((x) => x.trim()).filter(Boolean);
  if (pivots.length) {
    const country = (req.nextUrl.searchParams.get("country") || "FR").toUpperCase();
    // `exact: false` to match what runPivot sends. buildSubject QUOTES by default, and
    // quoting collapses a multi-word selector to one token, so the quote was pricing
    // complexity 1 while the charge billed 5, 16 or 40. Up to six times the figure the
    // operator was shown, in the shipped interface, with nobody doing anything wrong.
    const subjects = pivots.slice(0, MAX_PIVOTS).map((p) => buildSubject(p, { defaultCountry: country, exact: false }));
    const each = subjects.map((s) => {
      const usd = estimateCost(s.query, limit);
      return { selector: s.raw, kind: s.kind, query: s.query, usd, credits: searchCredits(usd) };
    });
    const usdTotal = estimateCost(subjects.map((s) => s.query), limit);
    const credits = searchCredits(usdTotal);
    return NextResponse.json({
      pivot: true, limit, metered: creditsEnabled, each,
      total: { usd: usdTotal, credits, formatted: creditsEnabled ? fmtPrice(credits) : formatCost(usdTotal) },
    });
  }

  const raw = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!raw) return NextResponse.json({ error: "no query" }, { status: 400 });
  const country = (req.nextUrl.searchParams.get("country") || "FR").toUpperCase();

  // Both ways of searching a multi-word subject are priced, because the choice is the
  // operator's and it is not only about money: quoting is cheaper AND narrower.
  // `loose` is what a search runs by default; `exact` is the cheaper, narrower option.
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
      credits: searchCredits(usd),
      formatted: creditsEnabled ? fmtPrice(searchCredits(usd)) : formatCost(usd),
    };
  };

  const sameQuery = exact.query === loose.query;
  return NextResponse.json({
    subject: { raw: exact.raw, kind: exact.kind, canonical: exact.canonical, unique: exact.unique },
    limit,
    metered: creditsEnabled,
    exact: { ...quote(exact.query), note: exact.note },
    // only offered when quoting actually changes the query, on an address it does not
    permutations: sameQuery ? null : { ...quote(loose.query), note: loose.note },
    // which of the two a search will use if the operator changes nothing
    defaultMode: sameQuery ? "exact" : "permutations",
    usd: fmtUSD(priceCredits(estimateCost(sameQuery ? exact.query : loose.query, limit))),
  });
}

// ---- POST: run it -----------------------------------------------------------------

/**
 * Pivot, the step that turns a result into an investigation.
 *
 * A name search returns addresses, numbers and handles. Those DO identify somebody,
 * which the name never did, so searching them is where a list of leaks becomes a
 * person. The API takes an array of queries in one request, and it bills per query
 * either way, so the whole hop costs one round trip instead of N, and stays inside
 * the three-requests-per-second limit that N separate calls would walk straight into.
 *
 * The batch comes back as ONE merged result with no indication of which query produced
 * which row. That is fine here and nowhere else: every row is judged against every
 * pivot selector by the same attribution the single-subject path uses, so each report
 * contains exactly the rows that are about ITS subject. A merged response is only a
 * problem for a tool that trusts what it is handed.
 */
const MAX_PIVOTS = 8;

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
  // Judged on what SURVIVES filtering, not on what was sent. `pivots: ["  "]` passed
  // the old test, emptied on the way through, and fell into the single path with an
  // empty selector, which estimateCost prices at zero, which debit waves through as a
  // no-op. An unlimited free channel to a per-request paid API, and to the audit table.
  const pivotRaw: string[] = Array.isArray(body?.pivots)
    ? body.pivots.map((x: unknown) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!raw && !pivotRaw.length) return NextResponse.json({ error: "Enter something to search for." }, { status: 400 });
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

  const region = String(body?.country || "FR").toUpperCase();

  // --- pivot: several selectors, one billed round trip ------------------------------
  if (pivotRaw.length) {
    return runPivot(req, pivotRaw.slice(0, MAX_PIVOTS), { user, legalBasis, region, body });
  }

  const subject = buildSubject(raw, {
    defaultCountry: region,
    // UNQUOTED by default on a multi-word subject, which is what the vendor's own bot
    // sends. Quoting collapses the query to a single exact phrase: a third of the price
    // and a fraction of the rows, so a name searched that way misses every record that
    // stores it in another order or alongside a middle name. Narrow is not the same as
    // careful, the care belongs in attribution, which decides what a returned row is
    // allowed to mean, not in refusing to ask the question properly.
    exact: body?.exact === true,
  });

  const cfg = readClientConfig(req);
  // Precedence is deliberate: a token an ADMINISTRATOR stored for the deployment beats
  // the environment, which beats a key an individual browser supplied. The deployment's
  // answer is the deployment's answer, and it can be changed without a redeploy.
  const stored = await sourceToken();
  const token = stored.token || cfg.leakosint || "";
  if (!token) {
    return NextResponse.json({
      error: "This deployment has no leak source configured.",
      hint: "An administrator sets the LeakOSINT token in /admin, or LEAKOSINT_TOKEN in the environment.",
      configured: false,
    }, { status: 400 });
  }

  const limit = resolveLimit(req, body?.limit);
  const price = priceCredits(estimateCost(subject.query, limit));
  // Nothing reaches the paid endpoint for free. A selector the biller values at zero is
  // not a cheap search, it is not a search.
  if (price <= 0) {
    return NextResponse.json({ error: "That is not a selector anything can be searched for." }, { status: 400 });
  }

  if (creditsEnabled && user) {
    const charge = await debit(user.id, price, `search: ${subject.canonical.slice(0, 48)}`);
    if (!charge.ok) {
      return NextResponse.json({
        error: charge.error, insufficient: true,
        balance: balanceCredits(charge.balance ?? 0), price: searchCredits(estimateCost(subject.query, limit)),
      }, { status: 402 });
    }
  }

  // Recorded once the charge has cleared, because only then will the query actually
  // reach the source. Writing it first meant an account with no balance could grow the
  // trail without limit, for free, with an attacker-chosen case reference, and push
  // older entries out of the verification window on the way. A query that was refused
  // before it ran touched nobody, so there is nobody to record.
  //
  // Fire-and-forget beyond that: the trail must never be able to block collection.
  recordQuery({
    operator: user?.email || "single-operator",
    kind: "search",
    selector: subject.canonical,
    legalBasis,
    caseId: String(body?.caseRef || "") || undefined,
    note: `kind=${subject.kind} limit=${limit} query=${subject.query}`,
  }).catch(() => {});

  // Refunding is not idempotent and the ledger carries no "already refunded" marker, so
  // the money has to go back exactly once. The refusal path's refund used to sit INSIDE
  // the try: anything that threw after it, the ledger insert, the balance read,
  // building the response, fell into the catch and refunded a second time, creating a
  // full search price out of nothing on every flaky write.
  // Refunding is not idempotent and the ledger carries no "already refunded" marker,
  // so the money goes back exactly once, and we SAY WHETHER IT LANDED. Every error
  // response used to assert "you were not charged" while the refund swallowed its own
  // failures, which makes the one moment a customer most needs the truth the one
  // moment the answer was a constant.
  let attempted = false;
  let refunded = false;
  const giveBack = async (why: string) => {
    if (attempted || !user) { refunded = !user; return; }
    attempted = true;
    const r = await refund(user.id, price, why).catch(() => ({ ok: false }));
    refunded = r.ok;
  };
  /** What to tell them, truthfully, when something went wrong after the charge. */
  const settlement = () =>
    user && !refunded
      ? { refunded: false, note: "You were charged for this query and the refund did not go through. Contact the operator with the time of this request." }
      : { refunded: true };

  try {
    const res = await leakOsint({
      token, request: subject.query, limit,
      lang: cfg.leakosintLang || process.env.LEAKOSINT_LANG || "en",
    });

    // The API answers 200 even when it refuses. A refusal is not a clean result, and
    // the money goes back because the query did not run.
    if (res.error) {
      await giveBack(`refund: ${res.error}`);
      // The upstream's error text is a third party's string, produced by a request that
      // carried our token. Reflecting it verbatim hands the caller whatever that party
      // chose to put in it, and some APIs echo the credential back on an auth failure.
      // The operator gets a category and an instruction; the detail stays server-side.
      const reason = /token|auth|forbidden/i.test(res.error) ? "configuration"
        : /limit|too many|rate/i.test(res.error) ? "rate-limited"
        : /timed out|unreachable/i.test(res.error) ? "unreachable"
        : "refused";
      const says: Record<string, string> = {
        configuration: "The leak source rejected this deployment's credentials. An administrator needs to check the token in /admin.",
        "rate-limited": "The leak source is rate-limiting this deployment. Try again shortly.",
        unreachable: "The leak source did not answer in time.",
        refused: "The leak source refused the query.",
      };
      return NextResponse.json({
        error: says[reason], reason,
        ...settlement(), balance: user ? balanceCredits(await balanceOf(user.id).catch(() => NaN)) : undefined,
      }, { status: 502 });
    }

    // A body the parser could not read is not a clean result. The report is built from
    // `databases`, so an unrecognised shape yields an empty list and would otherwise
    // render as "nothing found about this person", the single most damaging thing this
    // product could say off a response nobody understood. The money goes back, because
    // what came back cannot be used.
    if (res.unreadable) {
      await giveBack("refund: unreadable response");
      return NextResponse.json({
        error: "The leak source answered in a shape this version cannot read. Nothing is claimed about this subject either way.",
        reason: "unreadable",
        // The payload's top-level KEY NAMES, never its values. Diagnosing a shape
        // change by guessing has now cost two shipped fixes; this is what makes the
        // third unnecessary, and key names cannot carry somebody's record.
        shape: res.shape,
        ...settlement(), balance: user ? balanceCredits(await balanceOf(user.id).catch(() => NaN)) : undefined,
      }, { status: 502 });
    }

    // The region travels with the report: deciding whether two rows give the same
    // number means parsing both, and parsing a national-format number needs the same
    // region the search was made under.
    const report = buildReport(subject, res.databases, region);
    return NextResponse.json({
      report,
      headline: headline(report),
      // what was actually asked of the API, so the price shown is explainable
      query: { sent: subject.query, limit, rowsReturned: res.rowCount, databases: res.databases.length },
      charged: creditsEnabled && user ? searchCredits(estimateCost(subject.query, limit)) : 0,
      // Never let silence imply a protection. A deployment with no database has no
      // accounts, no metering and no query log, and the interface must be able to say so.
      deployment: { metered: creditsEnabled && !!user, logged: auditEnabled, operator: user?.email || null },
      balance: user ? balanceCredits(await balanceOf(user.id)) : undefined,
    });
  } catch {
    // Reached when our own code fails AFTER the source answered, building the report,
    // reading the balance. The query ran and the vendor was paid, so a review flagged
    // refunding here as giving away money we genuinely spent. It is deliberate: the
    // customer has nothing to show for the charge, and the failure is ours. We eat the
    // upstream cost rather than bill somebody for a bug. What was NOT defensible, and
    // is fixed, is telling them they were not charged without checking.
    await giveBack("refund: search threw");
    return NextResponse.json({
      error: "The search failed.",
      ...settlement(), balance: user ? balanceCredits(await balanceOf(user.id).catch(() => NaN)) : undefined,
    }, { status: 500 });
  }
}

// ---- the pivot run ------------------------------------------------------------------

interface PivotCtx {
  user: { id: string; email: string } | null;
  legalBasis: string;
  region: string;
  body: any;
}

async function runPivot(req: NextRequest, selectors: string[], ctx: PivotCtx) {
  const { user, legalBasis, region, body } = ctx;

  // Each selector is a query about a person and gets its own line in the trail. One
  // audit row for "a pivot happened" would record none of the people it was about.
  const subjects = selectors.map((raw) => buildSubject(raw, { defaultCountry: region, exact: body?.exact === true }));

  const cfg = readClientConfig(req);
  const stored = await sourceToken();
  const token = stored.token || cfg.leakosint || "";
  if (!token) {
    return NextResponse.json({ error: "This deployment has no leak source configured.", configured: false }, { status: 400 });
  }

  const limit = resolveLimit(req, body?.limit);
  const queries = subjects.map((s) => s.query);
  const price = priceCredits(estimateCost(queries, limit));
  if (price <= 0) {
    return NextResponse.json({ error: "No selector here can be searched for." }, { status: 400 });
  }

  if (creditsEnabled && user) {
    const charge = await debit(user.id, price, `pivot: ${selectors.length} selectors`);
    if (!charge.ok) {
      return NextResponse.json({
        error: charge.error, insufficient: true,
        balance: balanceCredits(charge.balance ?? 0), price: searchCredits(estimateCost(queries, limit)),
      }, { status: 402 });
    }
  }

  // One line per selector, written once the charge has cleared. A single row saying
  // "a pivot happened" would record none of the people it was about.
  for (const s of subjects) {
    recordQuery({
      operator: user?.email || "single-operator",
      kind: "search",
      selector: s.canonical,
      legalBasis,
      caseId: String(body?.caseRef || "") || undefined,
      note: `pivot kind=${s.kind} limit=${limit} query=${s.query}`,
    }).catch(() => {});
  }

  // Refunding is not idempotent and the ledger carries no "already refunded" marker,
  // so the money goes back exactly once, and we SAY WHETHER IT LANDED. Every error
  // response used to assert "you were not charged" while the refund swallowed its own
  // failures, which makes the one moment a customer most needs the truth the one
  // moment the answer was a constant.
  let attempted = false;
  let refunded = false;
  const giveBack = async (why: string) => {
    if (attempted || !user) { refunded = !user; return; }
    attempted = true;
    const r = await refund(user.id, price, why).catch(() => ({ ok: false }));
    refunded = r.ok;
  };
  /** What to tell them, truthfully, when something went wrong after the charge. */
  const settlement = () =>
    user && !refunded
      ? { refunded: false, note: "You were charged for this query and the refund did not go through. Contact the operator with the time of this request." }
      : { refunded: true };

  try {
    const res = await leakOsint({
      token, request: queries, limit,
      lang: cfg.leakosintLang || process.env.LEAKOSINT_LANG || "en",
    });
    if (res.error) {
      await giveBack(`refund: ${res.error}`);
      return NextResponse.json({ error: "The leak source refused the pivot.", reason: "refused", ...settlement() }, { status: 502 });
    }
    if (res.unreadable) {
      await giveBack("refund: unreadable response");
      return NextResponse.json({
        error: "The leak source answered in a shape this version cannot read.",
        reason: "unreadable", shape: res.shape, ...settlement(),
      }, { status: 502 });
    }

    // One merged response, judged separately per selector. A row only reaches a report
    // if it is about THAT report's subject.
    const reports = subjects.map((s) => {
      const report = buildReport(s, res.databases, region);
      return { selector: s.raw, kind: s.kind, report, headline: headline(report) };
    });

    return NextResponse.json({
      pivot: true,
      reports,
      query: { sent: queries, limit, rowsReturned: res.rowCount, databases: res.databases.length },
      charged: creditsEnabled && user ? searchCredits(estimateCost(queries, limit)) : 0,
      balance: user ? balanceCredits(await balanceOf(user.id)) : undefined,
    });
  } catch {
    await giveBack("refund: pivot threw");
    return NextResponse.json({ error: "The pivot failed.", ...settlement() }, { status: 500 });
  }
}
