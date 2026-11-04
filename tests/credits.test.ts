import { test } from "node:test";
import assert from "node:assert/strict";
import { MICRO, priceCredits, markup, toUSD, fromUSD, fmtUSD, fmtCredits } from "../lib/credits.ts";
import { estimateCost } from "../lib/leakosint.ts";

// The money math is pure and testable; the DB-backed balance is not reachable from CI.
// These lock the two things that, if wrong, lose real money: the markup and the rounding.

test("one credit is one micro-dollar", () => {
  assert.equal(MICRO, 1_000_000);
  assert.equal(fromUSD(1), 1_000_000);
  assert.equal(toUSD(1_000_000), 1);
});

test("the default markup is above 1 — the margin is the business", () => {
  assert.ok(markup() >= 1);
});

test("price is the raw cost times markup, rounded UP so we never undercharge", () => {
  const raw = estimateCost("google", 100);           // $0.003
  const expected = Math.ceil(raw * markup() * MICRO);
  assert.equal(priceCredits(raw), expected);
  // rounding is always up, never down: a fraction of a micro-dollar still costs one
  assert.equal(priceCredits(0.0000001), 1);
  assert.equal(priceCredits(0), 0);
});

test("the charged price tracks the API cost — a dearer query costs the operator more", () => {
  assert.ok(priceCredits(estimateCost("alpha bravo charlie", 100)) > priceCredits(estimateCost("google", 100)));
  assert.ok(priceCredits(estimateCost("google", 10000)) > priceCredits(estimateCost("google", 100)));
});

test("integer money does not drift — a hundred small charges sum exactly", () => {
  const one = priceCredits(estimateCost("google", 100));
  let bal = 100 * one;
  for (let i = 0; i < 100; i++) bal -= one;
  assert.equal(bal, 0, "no floating-point residue");
});

test("display is legible at the scale it lands on", () => {
  assert.match(fmtUSD(3000), /^\$0\.0030$/);          // 3000 micro-dollars = $0.003
  assert.match(fmtUSD(1_250_000), /^\$1\.250$/);
  assert.equal(fmtCredits(4800), "4,800 cr");
  assert.equal(fmtCredits(1_000_000), "1,000,000 cr");
});
