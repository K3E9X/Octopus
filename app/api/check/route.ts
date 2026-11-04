// Self-exposure check — the consumer product.
//
// A signed-in person checks what has leaked about an identifier THEY CONTROL. The whole
// endpoint is built around that one rule: it will not run a search for an identifier the
// caller has not proven they own. Proving it, running it, and reading the result are the
// three actions below.
//
// This is deliberately NOT a general lookup. There is no "search by name": a name cannot
// be owned or verified, and returning a named stranger's leaked passwords and bank
// details is the thing this product exists to not be.

import { NextRequest, NextResponse } from "next/server";
import { readClientConfig } from "@/lib/reqconfig";
import { currentUser } from "@/lib/session-server";
import { leakOsint, estimateCost } from "@/lib/leakosint";
import { buildReport, headline } from "@/lib/selfcheck";
import { startVerification, confirmVerification, isVerified } from "@/lib/ownership-store";
import { creditsEnabled, priceCredits, debit, refund, balanceOf } from "@/lib/credits";
import type { ExposureItem } from "@/lib/exposure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  // The consumer product requires accounts: a self-check has to anchor to an identity we
  // can verify ownership against, and that is what an account is.
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to check your exposure.", needsAuth: true }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "check");
  const subject = String(body?.subject || "").trim();
  if (!subject) return NextResponse.json({ error: "Enter an email or phone to check." }, { status: 400 });

  // --- step 1: begin proving ownership --------------------------------------------
  if (action === "verify-start") {
    const r = await startVerification(user.id, user.email, subject);
    const code = r.status === "verified" ? 200 : r.status === "error" ? 500 : 200;
    return NextResponse.json(r, { status: code });
  }

  // --- step 2: confirm the code ---------------------------------------------------
  if (action === "verify-confirm") {
    const r = await confirmVerification(user.id, subject, String(body?.code || ""));
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }

  // --- step 3: the check itself ---------------------------------------------------
  // the gate: no verified ownership, no search.
  if (!(await isVerified(user.id, user.email, subject))) {
    return NextResponse.json({
      error: "Verify that this identifier is yours before checking it.",
      needsVerify: true,
    }, { status: 403 });
  }

  const cfg = readClientConfig(req);
  const token = cfg.leakosint || process.env.LEAKOSINT_TOKEN || "";
  if (!token) {
    return NextResponse.json({ error: "This deployment has no leak-data source configured.", configured: false }, { status: 400 });
  }

  const limit = Math.max(100, Math.min(10000, Number(body?.limit) || cfg.leakosintLimit || Number(process.env.LEAKOSINT_LIMIT) || 100));
  const price = priceCredits(estimateCost(subject, limit));

  if (creditsEnabled) {
    const charge = await debit(user.id, price, `check: ${subject.slice(0, 48)}`);
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
    await refund(user.id, price, "refund: check threw");
    return NextResponse.json({ error: "The check failed — you were not charged.", balance: await balanceOf(user.id) }, { status: 500 });
  }
}
