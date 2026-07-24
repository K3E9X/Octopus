import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scoreEvidence } from "../lib/scoring.ts";

test("contradictions are classified, and beat hard/soft matching", () => {
  assert.equal(classify("Divergent avatar"), "contra");
  assert.equal(classify("Different face"), "contra");
  assert.equal(classify("Incompatible timezone"), "contra");
  assert.equal(classify("Inconsistent geo"), "contra");
});

test("a contradiction demotes instead of adding", () => {
  const positive = scoreEvidence([{ name: "Public name" }, { name: "Public bio" }]);
  assert.equal(positive.tier, "probable");
  const conflicted = scoreEvidence([{ name: "Public name" }, { name: "Public bio" }, { name: "Different face" }]);
  assert.equal(conflicted.tier, "contradicted");
  assert.equal(conflicted.contradictions, 1);
  assert.ok(conflicted.confidence < positive.confidence);
});

test("one contradiction against hard evidence downgrades but does not erase", () => {
  const s = scoreEvidence([{ name: "Matching avatar" }, { name: "Incompatible timezone" }]);
  assert.equal(s.tier, "possible");
});

test("two contradictions always mark the link contradicted", () => {
  const s = scoreEvidence([{ name: "Matching avatar" }, { name: "Different face" }, { name: "Inconsistent geo" }]);
  assert.equal(s.tier, "contradicted");
});
