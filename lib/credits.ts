// Credits — the business layer.
//
// The product resells LeakOSINT: every query has a raw API cost, we charge the operator
// a marked-up price in credits, and the margin is the business. This module owns the
// balance, the ledger and the one rule that cannot be got wrong — you cannot spend
// credits you do not have, checked atomically so two requests racing cannot both pass.
//
// MONEY IS AN INTEGER. One credit is one micro-dollar (1 USD = 1_000_000 credits).
// Floating-point dollars drift, and a balance that drifts leaks money in one direction
// or another. Everything internal is micro-dollars; dollars exist only at the edges,
// for display and for the admin granting a round sum.
//
// Degradation is explicit: with no database there are no accounts, so there is no
// metering either. Single-operator mode runs unmetered and the UI says so, rather than
// pretending a balance it cannot keep.

import { sql, dbEnabled } from "./db";
import { estimateCost } from "./leakosint";
import { randomBytes } from "node:crypto";

export const MICRO = 1_000_000;                 // credits per dollar
export const creditsEnabled = dbEnabled;

/**
 * What a credit is worth in dollars, as a multiple of what the query costs upstream.
 *
 * IT IS NOT THE MARGIN DIAL ANY MORE, and calling it one was wrong. When a balance was
 * denominated in micro-dollars this multiplied what a customer was charged. It cannot
 * now: a credit buys one standard search, and `searchCredits` divides a cost by the
 * cost of that standard search — so the multiplier appears in the numerator and the
 * denominator and cancels. Setting it to 10 changes no credit price, no balance and no
 * trial; a three-word name is four credits because it is four times the work, which is
 * the right behaviour and the reason the cancellation is not a bug to reverse.
 *
 * What it still does, and all it does, is set the DOLLAR VALUATION of a credit — the
 * figure quoted alongside a price and used to size a grant made in dollars. The margin
 * now lives where it belongs: in what a pack of credits sells for.
 *
 * Bounded at both ends. Unbounded, 1e308 made CREDIT_MICRO Infinity, searchCredits NaN,
 * and every search a 500 from the database driver.
 */
export function markup(): number {
  const m = Number(process.env.OCTOPUS_MARKUP);
  return Number.isFinite(m) && m >= 1 && m <= 1000 ? m : 1.6;
}

export const toUSD = (micro: number) => micro / MICRO;
export const fromUSD = (usd: number) => Math.round(usd * MICRO);

/**
 * What we take off a balance for a query, in micro-dollars.
 *
 * Always a whole number of credits' worth, so a balance stays a whole number of
 * searches and "47 credits" never quietly becomes "46 and a bit".
 */
export function priceCredits(rawUsd: number): number {
  return creditsToMicro(searchCredits(rawUsd));
}

/** For display. */
export const fmtUSD = (micro: number) => (toUSD(micro) < 0.01 ? `$${toUSD(micro).toFixed(4)}` : `$${toUSD(micro).toFixed(3)}`);

// ---- the credit ------------------------------------------------------------------
//
// TWO UNITS, on purpose, and they are not the same thing.
//
// The LEDGER is in micro-dollars, because money that drifts leaks in one direction and
// an integer cannot drift. Nothing about that changes.
//
// What a person is shown and charged is a CREDIT: one standard search, at the default
// depth, on a one-word selector. A balance is only ever asked one question — "how many
// more searches do I have" — and "7,143 cr" cannot answer it. One credit can.
//
// Charges round UP to a whole credit, which is both what makes the number legible and
// what covers the variance in the upstream price. A query that costs more upstream
// still costs more here: a three-word name is four credits because it genuinely is
// about four times the work.

/** One standard search: a single word at the default depth, with the markup applied. */
export const CREDIT_MICRO = Math.ceil(estimateCost("standard", 300) * markup() * MICRO);

/** What a raw API cost is worth in whole credits. Never free, always rounded up. */
export function searchCredits(rawUsd: number): number {
  if (rawUsd <= 0) return 0;
  return Math.max(1, Math.ceil((rawUsd * markup() * MICRO) / CREDIT_MICRO));
}

export const creditsToMicro = (credits: number) => Math.round(credits * CREDIT_MICRO);

/** A balance in whole searches. Floored: a part-credit cannot buy a search. */
export const balanceCredits = (micro: number) =>
  Number.isFinite(micro) ? Math.floor(micro / CREDIT_MICRO) : micro;

export const fmtCredits = (micro: number) => {
  const n = balanceCredits(micro);
  return `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;
};

/** For a price rather than a balance, where the figure is already whole. */
export const fmtPrice = (credits: number) => `${credits} credit${credits === 1 ? "" : "s"}`;

let ready: Promise<void> | null = null;
async function ensure(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      // credits live ON the user row — one balance per account, the obvious shape
      await q`ALTER TABLE IF EXISTS octopus_users ADD COLUMN IF NOT EXISTS credits bigint NOT NULL DEFAULT 0`;
      // and every movement is recorded, so a balance is always explainable
      await q`CREATE TABLE IF NOT EXISTS octopus_ledger (
        id         text PRIMARY KEY,
        user_id    text NOT NULL,
        delta      bigint NOT NULL,
        balance    bigint NOT NULL,
        kind       text NOT NULL,
        note       text,
        at         bigint NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS octopus_ledger_user ON octopus_ledger (user_id, at DESC)`;
    })();
  }
  await ready;
}

export interface LedgerRow { id: string; delta: number; balance: number; kind: string; note?: string; at: number; }

export async function balanceOf(userId: string): Promise<number> {
  if (!creditsEnabled) return Infinity;         // unmetered without a database
  await ensure();
  const q = sql();
  if (!q) return 0;
  const rows = await q`SELECT credits FROM octopus_users WHERE id = ${userId} LIMIT 1`;
  return Number((rows as any[])[0]?.credits ?? 0);
}

const ledgerId = () => "led_" + randomBytes(9).toString("hex");

/**
 * Move a balance AND record the movement, in one statement.
 *
 * They used to be two, outside any transaction: the balance moved, and if the ledger
 * insert then failed the exception escaped the route as a 500 while the money had
 * already gone — leaving the two permanently disagreeing, which defeats this module's
 * one stated guarantee that a balance is always explainable.
 *
 * A CTE makes it atomic without a transaction, which matters because the two drivers
 * this runs on do not share one: an UPDATE that matches no row produces no ledger row
 * either, so a refused charge leaves nothing behind. `guard` is what makes a debit a
 * debit — the row only moves while it still covers the amount, which is also the lock
 * that stops two concurrent requests both passing on a balance that covers one.
 */
async function move(
  userId: string, deltaMicro: number, kind: string, note: string | undefined, guard: "covers" | "none",
): Promise<{ ok: boolean; balance?: number; moved?: number }> {
  const q = sql();
  if (!q) return { ok: false };
  const rows = guard === "covers"
    ? await q`WITH moved AS (
        UPDATE octopus_users SET credits = credits + ${deltaMicro}
        WHERE id = ${userId} AND credits >= ${-deltaMicro}
        RETURNING credits
      )
      INSERT INTO octopus_ledger (id, user_id, delta, balance, kind, note, at)
      SELECT ${ledgerId()}, ${userId}, ${deltaMicro}, credits, ${kind}, ${note || null}, ${Date.now()} FROM moved
      RETURNING balance`
    // Two single-row CTEs joined, rather than a CTE referring to itself. Every CTE in
    // a statement reads the same snapshot, so `prev` is the balance before the update
    // and `moved` RETURNING is the balance after — which makes `after - before` what
    // ACTUALLY moved, including when the clamp at zero swallowed part of a claw-back.
    : await q`WITH prev AS (
        SELECT credits AS c FROM octopus_users WHERE id = ${userId}
      ), moved AS (
        UPDATE octopus_users SET credits = GREATEST(0, credits + ${deltaMicro})
        WHERE id = ${userId}
        RETURNING credits AS c
      )
      INSERT INTO octopus_ledger (id, user_id, delta, balance, kind, note, at)
      SELECT ${ledgerId()}, ${userId}, moved.c - prev.c, moved.c, ${kind}, ${note || null}, ${Date.now()}
      FROM moved, prev
      RETURNING balance, delta`;
  const row = (rows as any[])[0];
  if (!row) return { ok: false };
  return { ok: true, balance: Number(row.balance), moved: row.delta === undefined ? deltaMicro : Number(row.delta) };
}

/** Admin tops up (or claws back, with a negative amount). Returns the new balance. */
export async function grant(userId: string, deltaMicro: number, note?: string): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (!creditsEnabled) return { ok: false, error: "no database — the tool runs unmetered" };
  if (!Number.isInteger(deltaMicro) || deltaMicro === 0) return { ok: false, error: "a non-zero whole amount is required" };
  await ensure();
  const q = sql();
  if (!q) return { ok: false, error: "database unavailable" };
  // Clamped at zero — a claw-back cannot drive a balance negative — and the ledger
  // records WHAT ACTUALLY MOVED, not what was asked for, so an over-clawback leaves
  // the two still agreeing.
  const r = await move(userId, deltaMicro, deltaMicro > 0 ? "grant" : "clawback",
    note, "none");
  if (!r.ok) return { ok: false, error: "no such user" };
  return { ok: true, balance: r.balance };
}

/**
 * Charge for a query. ATOMIC: the balance check and the deduction are one statement, so
 * two requests racing on the same account cannot both succeed against a balance that
 * only covers one. Returns the charge and the new balance, or refuses.
 */
export async function debit(userId: string, amountMicro: number, note?: string): Promise<{ ok: boolean; charged?: number; balance?: number; error?: string }> {
  if (!creditsEnabled) return { ok: true, charged: 0, balance: Infinity };   // unmetered
  if (amountMicro <= 0) return { ok: true, charged: 0, balance: await balanceOf(userId) };
  await ensure();
  const q = sql();
  if (!q) return { ok: false, error: "database unavailable" };
  const r = await move(userId, -amountMicro, "debit", note, "covers");
  if (!r.ok) {
    const bal = await balanceOf(userId);
    return { ok: false, balance: bal, error: `insufficient credits — this query costs ${fmtCredits(amountMicro)} (${fmtUSD(amountMicro)}), balance is ${fmtCredits(bal)}` };
  }
  return { ok: true, charged: amountMicro, balance: r.balance };
}

/**
 * Put credits back when a charged query did not actually run.
 *
 * It REPORTS whether it landed, and that is the whole change. Every error response was
 * hard-coded to say "you were not charged" while this returned void and swallowed its
 * own failures — so the one moment a customer most needs the truth was the one moment
 * the answer was a constant.
 */
export async function refund(userId: string, amountMicro: number, note?: string): Promise<{ ok: boolean; balance?: number }> {
  if (!creditsEnabled) return { ok: true };
  if (amountMicro <= 0) return { ok: true, balance: await balanceOf(userId).catch(() => undefined) };
  try {
    await ensure();
    return await move(userId, amountMicro, "refund", note, "none");
  } catch {
    return { ok: false };
  }
}

export async function ledgerOf(userId: string, limit = 40): Promise<LedgerRow[]> {
  if (!creditsEnabled) return [];
  await ensure();
  const q = sql();
  if (!q) return [];
  const rows = await q`SELECT id, delta, balance, kind, note, at FROM octopus_ledger WHERE user_id = ${userId} ORDER BY at DESC LIMIT ${limit}`;
  return (rows as any[]).map((r) => ({ id: r.id, delta: Number(r.delta), balance: Number(r.balance), kind: r.kind, note: r.note || undefined, at: Number(r.at) }));
}

/**
 * The trial.
 *
 * Counted in searches, which is now also the unit it is charged in — so "two free
 * searches" is exactly what the balance says, with none of the arithmetic that made
 * "14,286 cr" mean two of anything.
 */
/**
 * `??` only catches undefined, and `${X:-}` in a compose file produces an EMPTY
 * STRING — which Number() reads as 0. So a deployment that merely listed the variable
 * without setting it silently turned the trial off, and every signup met "insufficient
 * credits" on their first search with nothing in any log to explain it. Blank, junk and
 * absurd values all fall back to the default now, and the ceiling stops a typo from
 * handing out a billion free searches.
 */
function trialSearches(): number {
  const raw = String(process.env.OCTOPUS_TRIAL_SEARCHES ?? "").trim();
  if (!raw) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.min(10_000, Math.floor(n));
}

export const TRIAL_SEARCHES = trialSearches();
export const TRIAL_CREDITS = creditsToMicro(TRIAL_SEARCHES);

/** A deployment that prefers to set a dollar figure still can; it wins when present. */
const EXPLICIT_STARTER = Number(process.env.OCTOPUS_STARTER_USD);
export const STARTER_CREDITS = Number.isFinite(EXPLICIT_STARTER) && EXPLICIT_STARTER > 0
  ? fromUSD(EXPLICIT_STARTER)
  : TRIAL_CREDITS;

export async function seedStarter(userId: string): Promise<void> {
  if (!creditsEnabled || STARTER_CREDITS <= 0) return;
  await grant(userId, STARTER_CREDITS, `trial: ${TRIAL_SEARCHES} search${TRIAL_SEARCHES === 1 ? "" : "es"}`);
}

/** What the trial is worth, for the interface to state without recomputing it. */
export const trialNote = () =>
  TRIAL_SEARCHES > 0
    ? `New accounts start with ${fmtCredits(STARTER_CREDITS)}. One credit is one standard search; a multi-word name costs more, and so does a deeper one.`
    : "New accounts start with no balance; an administrator grants credits.";
