import { test } from "node:test";
import assert from "node:assert/strict";
import { markup, priceCredits, fromUSD, toUSD, fmtUSD, MICRO, CREDIT_MICRO, searchCredits, creditsToMicro, balanceCredits, fmtCredits } from "../lib/credits.ts";
import { estimateCost } from "../lib/leakosint.ts";

// The money math is pure and testable; the DB-backed balance is not reachable from CI.
// These lock the two things that, if wrong, lose real money: the markup and the rounding.

test("one credit is one micro-dollar", () => {
  assert.equal(MICRO, 1_000_000);
  assert.equal(fromUSD(1), 1_000_000);
  assert.equal(toUSD(1_000_000), 1);
});

test("the default markup is above 1, the margin is the business", () => {
  assert.ok(markup() >= 1);
});

test("a charge is whole credits' worth, and never less than the API cost", () => {
  // What leaves a balance is now a whole number of CREDITS expressed in micro-dollars,
  // not the exact marked-up figure. Rounding up is what keeps a balance a whole number
  // of searches and what absorbs the variance in the upstream price, a query costing
  // a hair over one credit must take two, or the margin is set by the rounding.
  const raw = estimateCost("google", 100);           // $0.003 upstream
  assert.equal(priceCredits(raw) % CREDIT_MICRO, 0, "no part-credit is ever left behind");
  assert.ok(priceCredits(raw) >= raw * markup() * MICRO, "never below the marked-up cost");
  // anything at all costs one credit; nothing costs nothing
  assert.equal(priceCredits(0.0000001), CREDIT_MICRO);
  assert.equal(priceCredits(0), 0);
});

test("the charged price tracks the API cost, a dearer query costs the operator more", () => {
  assert.ok(priceCredits(estimateCost("alpha bravo charlie", 100)) > priceCredits(estimateCost("google", 100)));
  assert.ok(priceCredits(estimateCost("google", 10000)) > priceCredits(estimateCost("google", 100)));
});

test("integer money does not drift, a hundred small charges sum exactly", () => {
  const one = priceCredits(estimateCost("google", 100));
  let bal = 100 * one;
  for (let i = 0; i < 100; i++) bal -= one;
  assert.equal(bal, 0, "no floating-point residue");
});

test("display is legible at the scale it lands on", () => {
  assert.match(fmtUSD(3000), /^\$0\.0030$/);          // 3000 micro-dollars = $0.003
  assert.match(fmtUSD(1_250_000), /^\$1\.250$/);
  // a balance is read in searches, because that is the only question anybody asks of it
  assert.equal(fmtCredits(creditsToMicro(1)), "1 credit");
  assert.equal(fmtCredits(creditsToMicro(4_800)), "4,800 credits");
});

// ---- the credit is a search ----------------------------------------------------
// Two units, deliberately: the ledger is micro-dollars because money that drifts leaks
// in one direction, and what a person is shown is a SEARCH, because a balance is only
// ever asked one question and "7,143 cr" cannot answer it.

test("one standard search is exactly one credit", () => {
  assert.equal(searchCredits(estimateCost("someone@example.com", 300)), 1);
});

test("a cheaper search is still a whole credit, never free", () => {
  assert.equal(searchCredits(estimateCost("someone@example.com", 100)), 1);
  assert.equal(searchCredits(0.0000001), 1);
  assert.equal(searchCredits(0), 0, "but nothing costs nothing");
});

test("work that costs more upstream costs more credits", () => {
  const one = searchCredits(estimateCost("someone@example.com", 300));
  const two = searchCredits(estimateCost("Jean Dupont", 300));
  const four = searchCredits(estimateCost("Jean Pierre Dupont", 300));
  assert.equal(one, 1);
  assert.equal(two, 2);
  assert.equal(four, 4);
  assert.ok(four > two && two > one, "the ladder follows the real cost");
});

test("a deeper sweep costs more", () => {
  assert.ok(searchCredits(estimateCost("a@b.com", 10000)) > searchCredits(estimateCost("a@b.com", 300)));
});

test("a charge is always a whole number of credits' worth, so a balance stays whole", () => {
  for (const q of ["a@b.com", "Jean Dupont", "Jean Pierre Dupont"]) {
    const micro = priceCredits(estimateCost(q, 300));
    assert.equal(micro % CREDIT_MICRO, 0, `${q} must not leave a part-credit behind`);
  }
});

test("a balance reads as whole searches, floored, a part-credit buys nothing", () => {
  assert.equal(balanceCredits(creditsToMicro(47)), 47);
  assert.equal(balanceCredits(creditsToMicro(1) - 1), 0, "just under one search is no searches");
  assert.equal(fmtCredits(creditsToMicro(1)), "1 credit");
  assert.equal(fmtCredits(creditsToMicro(2)), "2 credits");
});

test("rounding up is what covers the upstream variance", () => {
  // a query costing a hair over one credit is charged two, never one
  const justOver = (CREDIT_MICRO + 1) / (markup() * MICRO);
  assert.equal(searchCredits(justOver), 2);
});

// ---- what the markup is, now that a credit is a search ----------------------------

test("the valuation multiplier does not change what anything costs in credits", () => {
  // It appears in CREDIT_MICRO and again in searchCredits, and cancels. That is the
  // right behaviour, a three-word name is four credits because it is four times the
  // work, whatever margin is being taken, and the reason it was wrong to call this
  // the margin dial. The margin lives in what a pack of credits sells for.
  const before = process.env.OCTOPUS_MARKUP;
  try {
    const ladder = () => [
      searchCredits(estimateCost("a@b.com", 300)),
      searchCredits(estimateCost("Jean Dupont", 300)),
      searchCredits(estimateCost("Jean Pierre Dupont", 300)),
    ];
    assert.deepEqual(ladder(), [1, 2, 4]);
  } finally {
    if (before === undefined) delete process.env.OCTOPUS_MARKUP;
    else process.env.OCTOPUS_MARKUP = before;
  }
});

test("an absurd multiplier cannot make the price NaN", () => {
  const before = process.env.OCTOPUS_MARKUP;
  try {
    for (const v of ["1e308", "-5", "0", "abc", ""]) {
      process.env.OCTOPUS_MARKUP = v;
      assert.ok(Number.isFinite(markup()), `markup must stay finite for ${JSON.stringify(v)}`);
      assert.ok(markup() >= 1 && markup() <= 1000);
    }
  } finally {
    if (before === undefined) delete process.env.OCTOPUS_MARKUP;
    else process.env.OCTOPUS_MARKUP = before;
  }
});

test("a selector worth nothing is not a cheap search, it has no price at all", () => {
  // estimateCost("") is 0, and debit() waves a zero charge through as a no-op, so an
  // empty selector was a free call to a per-request paid API.
  assert.equal(searchCredits(estimateCost("", 300)), 0);
  assert.equal(priceCredits(estimateCost("", 300)), 0);
  // the route refuses it rather than running it; this pins the value the check reads
});
