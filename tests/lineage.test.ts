import { test } from "node:test";
import assert from "node:assert/strict";
import { lineageOf, assessIndependence } from "../lib/lineage.ts";
import { scoreEvidence } from "../lib/scoring.ts";

test("evidence maps to its root observation", () => {
  assert.equal(lineageOf("Matching avatar", "pHash"), "image");
  assert.equal(lineageOf("GPS in image", "EXIF"), "image");
  assert.equal(lineageOf("Declared account", "keybase"), "declared-link");
  assert.equal(lineageOf("Domain registrant email", "RDAP"), "registry");
  assert.equal(lineageOf("Appears in leak / paste", "intelx.io"), "breach");
});

test("evidence from ONE image counts as ONE observation, not three", () => {
  const ind = assessIndependence([
    { name: "Matching avatar", source: "pHash" },
    { name: "GPS in image", source: "EXIF" },
    { name: "Camera", source: "EXIF" },
  ]);
  assert.equal(ind.independent, 1, "all three derive from the same file");
  assert.equal(ind.raw, 3);
  assert.ok(ind.inflated);
});

test("truly independent sources still count separately", () => {
  const ind = assessIndependence([
    { name: "Matching avatar", source: "pHash" },
    { name: "Domain registrant email", source: "RDAP" },
    { name: "Appears in leak", source: "intelx" },
  ]);
  assert.equal(ind.independent, 3);
  assert.equal(ind.inflated, false);
});

test("scoring refuses to call one observation 'probable'", () => {
  // two soft signals, but both read off the same profile page → not real corroboration
  const s = scoreEvidence([
    { name: "Public name", source: "api.github.com" },
    { name: "Public bio", source: "api.github.com" },
  ]);
  assert.equal(s.tier, "possible", "same-root signals must not reach probable");
  assert.equal(s.corroboration, 1);
});
