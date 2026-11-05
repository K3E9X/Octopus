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
import { randomBytes } from "node:crypto";

export const MICRO = 1_000_000;                 // credits per dollar
export const creditsEnabled = dbEnabled;

/**
 * Resale markup over the raw API cost. The business is the margin, so this is a real
 * dial, read from the environment, defaulting to 1.6x. It is applied once, here, so the
 * quote the operator sees and the amount actually debited can never disagree.
 */
export function markup(): number {
  const m = Number(process.env.OCTOPUS_MARKUP);
  return Number.isFinite(m) && m >= 1 ? m : 1.6;
}

export const toUSD = (micro: number) => micro / MICRO;
export const fromUSD = (usd: number) => Math.round(usd * MICRO);

/** The price we charge, in credits, for a raw API cost in dollars. Rounded UP: never
 *  undercharge, because the API bills us the real cost regardless. */
export function priceCredits(rawUsd: number): number {
  return Math.ceil(rawUsd * markup() * MICRO);
}

/** For display. */
export const fmtUSD = (micro: number) => (toUSD(micro) < 0.01 ? `$${toUSD(micro).toFixed(4)}` : `$${toUSD(micro).toFixed(3)}`);
export const fmtCredits = (micro: number) => `${micro.toLocaleString("en-US")} cr`;

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

function entry(userId: string, delta: number, balance: number, kind: string, note?: string) {
  const q = sql()!;
  return q`INSERT INTO octopus_ledger (id, user_id, delta, balance, kind, note, at)
           VALUES (${"led_" + randomBytes(9).toString("hex")}, ${userId}, ${delta}, ${balance}, ${kind}, ${note || null}, ${Date.now()})`;
}

/** Admin tops up (or claws back, with a negative amount). Returns the new balance. */
export async function grant(userId: string, deltaMicro: number, note?: string): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (!creditsEnabled) return { ok: false, error: "no database — the tool runs unmetered" };
  if (!Number.isInteger(deltaMicro) || deltaMicro === 0) return { ok: false, error: "a non-zero whole amount is required" };
  await ensure();
  const q = sql();
  if (!q) return { ok: false, error: "database unavailable" };
  // clamp at zero: a claw-back cannot drive a balance negative
  const rows = await q`UPDATE octopus_users
    SET credits = GREATEST(0, credits + ${deltaMicro})
    WHERE id = ${userId} RETURNING credits`;
  const bal = Number((rows as any[])[0]?.credits ?? NaN);
  if (!Number.isFinite(bal)) return { ok: false, error: "no such user" };
  await entry(userId, deltaMicro, bal, deltaMicro > 0 ? "grant" : "clawback", note);
  return { ok: true, balance: bal };
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
  // the WHERE clause is the lock: the row only updates when it still covers the charge
  const rows = await q`UPDATE octopus_users
    SET credits = credits - ${amountMicro}
    WHERE id = ${userId} AND credits >= ${amountMicro}
    RETURNING credits`;
  const after = (rows as any[])[0];
  if (!after) {
    const bal = await balanceOf(userId);
    return { ok: false, balance: bal, error: `insufficient credits — this query costs ${fmtCredits(amountMicro)} (${fmtUSD(amountMicro)}), balance is ${fmtCredits(bal)}` };
  }
  const bal = Number(after.credits);
  await entry(userId, -amountMicro, bal, "debit", note);
  return { ok: true, charged: amountMicro, balance: bal };
}

/** Put credits back when a charged query did not actually run (API error, timeout). */
export async function refund(userId: string, amountMicro: number, note?: string): Promise<void> {
  if (!creditsEnabled || amountMicro <= 0) return;
  await ensure();
  const q = sql();
  if (!q) return;
  const rows = await q`UPDATE octopus_users SET credits = credits + ${amountMicro} WHERE id = ${userId} RETURNING credits`;
  const bal = Number((rows as any[])[0]?.credits ?? 0);
  await entry(userId, amountMicro, bal, "refund", note);
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
 * Sized in SEARCHES rather than in dollars, because dollars mean nothing to whoever is
 * setting it and a price that moves with the depth setting would quietly change what
 * "two free searches" buys. Two is the default; a deployment that wants none sets zero
 * and new accounts simply start empty.
 *
 * It is approximate on purpose and the interface says so: a one-word query at the
 * default depth is the unit, and a three-word name costs about twice that. Overstating
 * it would be worse than being vague — somebody would run two names and find the
 * second one refused.
 */
export const TRIAL_SEARCHES = Math.max(0, Number(process.env.OCTOPUS_TRIAL_SEARCHES ?? 2));

/** The raw API cost of one plain one-word query at the default depth. */
const ONE_SEARCH_USD = 0.0002 * (5 + Math.sqrt(300));

export const TRIAL_CREDITS = TRIAL_SEARCHES > 0 ? priceCredits(ONE_SEARCH_USD * TRIAL_SEARCHES) : 0;

/** Kept for deployments that set an explicit dollar figure; it wins when present. */
const EXPLICIT_STARTER = Number(process.env.OCTOPUS_STARTER_USD);
export const STARTER_CREDITS = Number.isFinite(EXPLICIT_STARTER) && EXPLICIT_STARTER > 0
  ? fromUSD(EXPLICIT_STARTER)
  : TRIAL_CREDITS;

export async function seedStarter(userId: string): Promise<void> {
  if (!creditsEnabled || STARTER_CREDITS <= 0) return;
  await grant(userId, STARTER_CREDITS, `trial: about ${TRIAL_SEARCHES} search${TRIAL_SEARCHES === 1 ? "" : "es"}`);
}

/** What the trial is worth, for the interface to state without recomputing it. */
export const trialNote = () =>
  TRIAL_SEARCHES > 0
    ? `New accounts start with about ${TRIAL_SEARCHES} search${TRIAL_SEARCHES === 1 ? "" : "es"} (${fmtCredits(STARTER_CREDITS)}). A multi-word name costs more than a single address, so the figure is approximate.`
    : "New accounts start with no balance; an administrator grants credits.";
