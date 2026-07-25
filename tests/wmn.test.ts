import { test } from "node:test";
import assert from "node:assert/strict";
import { wmnCatalogue, wmnPlan } from "../lib/wmn.ts";

test("the ruleset is bundled and large — coverage never depends on a network call", () => {
  const c = wmnCatalogue();
  assert.ok(c.total > 600, `expected the full ruleset, got ${c.total} sites`);
  assert.ok(c.social > 250, `expected a broad consumer catalogue, got ${c.social}`);
});

test("the sweep reaches ordinary people before it reaches developers", () => {
  // The depth cap means the tail is never checked, so the ORDER decides whether
  // someone with no GitHub account is found at all.
  const first = wmnPlan(60);
  const devFirst = first.filter((s) => s.cat === "coding" || s.cat === "tech").length;
  const consumer = first.filter((s) => ["social", "images", "music", "hobby", "shopping", "dating", "blog", "video"].includes(s.cat)).length;
  assert.ok(consumer > devFirst * 2, `first 60: ${consumer} consumer vs ${devFirst} developer sites`);

  const names = wmnPlan(40).map((s) => s.name.toLowerCase());
  for (const must of ["instagram", "tiktok", "facebook", "snapchat", "pinterest"]) {
    assert.ok(names.some((n) => n.includes(must)), `${must} should be swept early`);
  }
});

test("adult-content sites are swept last, not first", () => {
  const early = wmnPlan(120).filter((s) => s.cat.includes("nsfw")).length;
  assert.equal(early, 0, "NSFW entries must not consume the depth budget");
});

test("the plan is bounded by depth", () => {
  assert.equal(wmnPlan(25).length, 25);
  assert.ok(wmnPlan(10_000).length <= wmnCatalogue().total);
});
