import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRarity, sharedHandleEvidence } from "../lib/rarity.ts";

test("common first names / words score as common", () => {
  assert.equal(handleRarity("alex").band, "common");
  assert.equal(handleRarity("admin").band, "common");
});

test("a long varied handle with digits is distinctive or unique", () => {
  const r = handleRarity("xk9_zulu_42");
  assert.ok(r.band === "unique" || r.band === "distinctive", `got ${r.band}`);
  assert.ok(r.score > 0.4);
});

test("rare beats common in score", () => {
  assert.ok(handleRarity("zephyr_qx77").score > handleRarity("sam").score);
});

test("sharedHandleEvidence REFUSES to link on a common handle (false-positive guard)", () => {
  assert.equal(sharedHandleEvidence("alex"), null);
  const e = sharedHandleEvidence("xk9_zulu_42");
  assert.ok(e && e.weight >= 74);
});

test("calibration: bands land where an analyst would expect", () => {
  assert.equal(handleRarity("alex").band, "common");        // refuse to link
  assert.equal(handleRarity("torvalds").band, "moderate");  // real surname = real evidence
  assert.equal(handleRarity("xk9_zulu_42").band, "distinctive");
  assert.equal(handleRarity("marie_dubois_87").band, "unique"); // near-proof
});
