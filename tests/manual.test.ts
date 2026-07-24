import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManualSignal, correlateManual, type ManualInput } from "../lib/manual.ts";
import type { Signal } from "../lib/signals.ts";

const at = "2024-01-01T00:00:00Z";
const mk = (id: string, platform: string, handle: string, extra: Partial<Signal> = {}): Signal => ({
  id, platform, handle, disc: "XX", confidence: 50, status: "review", evidence: [], ...extra,
});

test("buildManualSignal carries custody + seed match", () => {
  const s = buildManualSignal({ platform: "Instagram", handle: "john.doe", note: "same face" }, at, "john.doe");
  assert.equal(s.kind, "platform");
  assert.ok(s.collectedAt === at);
  assert.ok(s.evidence.some((e) => e.name === "Analyst-captured"));
  assert.ok(s.evidence.some((e) => e.name === "Matches the seed"));
});

test("correlateManual links by shared handle when the handle is DISTINCTIVE", () => {
  const h = "xk9_zulu_42";
  const existing = [mk("github", "GITHUB", h), mk("reddit", "REDDIT", "u/" + h)];
  const manual = buildManualSignal({ platform: "Instagram", handle: h }, at);
  const r = correlateManual(manual, { platform: "Instagram", handle: h }, existing);
  assert.ok(r.matched >= 2, `expected >=2 links, got ${r.matched}`);
  assert.ok(r.addEvidence.some((e) => /handle/i.test(e.name)));
});

test("correlateManual REFUSES to link on a common handle (false-positive guard)", () => {
  const existing = [mk("github", "GITHUB", "alex"), mk("reddit", "REDDIT", "u/alex")];
  const manual = buildManualSignal({ platform: "Instagram", handle: "alex" }, at);
  const r = correlateManual(manual, { platform: "Instagram", handle: "alex" }, existing);
  assert.equal(r.matched, 0, "a shared common handle must NOT create a link");
});

test("correlateManual links by matching display name", () => {
  const existing = [mk("gh", "GITHUB", "xyz", { displayName: "Jean Dupont" })];
  const input: ManualInput = { platform: "Facebook", handle: "jd.1990", displayName: "Jean Dupont" };
  const manual = buildManualSignal(input, at);
  const r = correlateManual(manual, input, existing);
  assert.equal(r.matched, 1);
  assert.ok(r.addEvidence.some((e) => e.name === "Matching name"));
});

test("correlateManual extracts email + aliases from pasted bio", () => {
  const input: ManualInput = { platform: "Instagram", handle: "john", bio: "contact me john@proton.me or @john_dev" };
  const manual = buildManualSignal(input, at);
  const r = correlateManual(manual, input, []);
  assert.ok(r.extracted.some((s) => s.kind === "email" && s.handle === "john@proton.me"));
  assert.ok(r.extracted.some((s) => s.kind === "alias" && s.handle === "@john_dev"));
});
