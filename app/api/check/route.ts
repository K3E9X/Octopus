// Subject lookup — the product's one endpoint.
//
// A signed-in operator submits an email or a phone number and gets back everything
// breach data holds about it. There is no ownership gate: this is a lookup tool for
// investigators, the same shape as every commercial product in the category. What
// replaces the gate is accountability — every query is recorded against the operator
// who ran it and the legal basis they declared, in an append-only hash-chained trail
// (lib/audit). A query with no declared basis is refused, not logged as "unspecified".
//
// Two things are deliberately NOT accepted as a subject: a name and a free-text string.
// A name cannot be resolved to one person, so a name search returns somebody else's
// data as often as the target's — that is not a product, that is a liability.

import { NextRequest, NextResponse } from "next/server";
import { readClientConfig } from "@/lib/reqconfig";
import { currentUser } from "@/lib/session-server";
import { leakOsint, estimateCost } from "@/lib/leakosint";
import { buildReport, headline } from "@/lib/selfcheck";
import { recordQuery } from "@/lib/audit";
import { isEmail, isPhone } from "@/lib/selectors";
import { creditsEnabled, priceCredits, debit, refund, balanceOf } from "@/lib/credits";
import type { ExposureItem } from "@/lib/exposure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** The bases a lookup may be run under. Closed list: a free-text field is a field nobody reads. */
const LEGAL_BASES = new Set([
  "own-data",        // the operator is the subject
  "consent",         // the subject asked for it
  "investigation",   // fraud, due diligence, threat intel, with a case reference
  "legal-request",   // warrant, tasking, court order
  "security-research",
]);

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to run a search.", needsAuth: true }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const subject = String(body?.subject || "").trim();
  if (!subject) return NextResponse.json({ error: "Enter an email address or a phone number." }, { status: 400 });

  // The selector must be one we can actually resolve to a single person.
  if (!isEmail(subject) && !isPhone(subject)) {
    return NextResponse.json({
      error: "Search by email address or phone number. A name cannot identify one person.",
    }, { status: 400 });
  }

  // The accountability gate. It is cheap to satisfy and impossible to skip, which is
  // the point: the record of WHY has to exist before the data does.
  const legalBasis = String(body?.legalBasis || "");
  if (!LEGAL_BASES.has(legalBasis)) {
    return NextResponse.json({
      error: "Declare the basis for this search before running it.",
      needsBasis: true,
      bases: [...LEGAL_BASES],
    }, { status: 403 });
  }

  const cfg = readClientConfig(req);
  const token = cfg.leakosint || process.env.LEAKOSINT_TOKEN || "";
  if (!token) {
    return NextResponse.json({ error: "This deployment has no leak-data source configured.", configured: false }, { status: 400 });
  }

  const limit = Math.max(100, Math.min(10000, Number(body?.limit) || cfg.leakosintLimit || Number(process.env.LEAKOSINT_LIMIT) || 100));
  const price = priceCredits(estimateCost(subject, limit));

  // Recorded BEFORE the query runs, so an attempt that fails or is refused still leaves
  // a trace. A trail that only records successes is a trail that hides the interesting
  // half. Fire-and-forget: the record must never be able to block or break the search.
  recordQuery({
    operator: user.email,
    kind: "search",
    selector: subject,
    legalBasis,
    caseId: String(body?.caseRef || "") || undefined,
    note: `limit=${limit}`,
  }).catch(() => {});

  if (creditsEnabled) {
    const charge = await debit(user.id, price, `search: ${subject.slice(0, 48)}`);
    if (!charge.ok) {
      return NextResponse.json({ error: charge.error, insufficient: true, balance: charge.balance, price }, { status: 402 });
    }
  }

  try {
    const res = await leakOsint({ token, request: subject, limit, lang: cfg.leakosintLang || process.env.LEAKOSINT_LANG || "en" });
    if (res.error) {
      await refund(user.id, price, `refund: ${res.error}`);
      return NextResponse.json({ error: "The leak source did not answer — you were not charged.", balance: await balanceOf(user.id) }, { status: 502 });
    }

    const items: ExposureItem[] = res.items.filter((i) => i.kind !== "breach");
    const report = buildReport(subject, items, res.databases.map((d) => ({ name: d.name, info: d.info })));
    return NextResponse.json({
      report,
      headline: headline(report),
      charged: creditsEnabled ? price : 0,
      balance: creditsEnabled ? await balanceOf(user.id) : undefined,
    });
  } catch {
    await refund(user.id, price, "refund: search threw");
    return NextResponse.json({ error: "The search failed — you were not charged.", balance: await balanceOf(user.id) }, { status: 500 });
  }
}
