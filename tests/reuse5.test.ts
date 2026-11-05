import { test } from "node:test";
import assert from "node:assert/strict";
import { pwPattern, patternMatch, patternGroups } from "../lib/pwpattern.ts";
import { reuseLinks, reuseEvidence } from "../lib/reuse.ts";
import { compromiseTimeline, hygiene, dateOf, timelineSummary } from "../lib/compromise.ts";
import type { ExposureItem } from "../lib/exposure.ts";

// ---- 2. password patterns -----------------------------------------------------------

test("a secret decomposes into stem, trailing digits and tail", () => {
  const p = pwPattern("Soleil2019!")!;
  assert.equal(p.root, "soleil");
  assert.equal(p.digits, "2019");
  assert.equal(p.tail, "!");
  assert.equal(p.yearLike, true);
  assert.equal(p.capShape, "Title");
});

test("only a TRAILING digit run is stripped, an internal digit is part of the stem", () => {
  // stripping it would collapse "Tr0ubador" onto "trubador" and merge unrelated secrets
  assert.equal(pwPattern("Tr0ubador")!.root, "tr0ubador");
});

test("the same stem with a different year is one habit", () => {
  const v = patternMatch("Valoire2019!", "Valoire2021!");
  assert.equal(v.linkable, true);
  assert.match(v.reason, /differing only in the year/);
});

test("a pattern link is always weaker than exact reuse", () => {
  const pattern = patternMatch("Valoire2019!", "Valoire2021!");
  assert.ok(pattern.strength <= 58, "an inferred habit must never score like an observed string");
});

test("identical secrets are NOT a pattern match, that is exact reuse", () => {
  assert.equal(patternMatch("Valoire2019!", "Valoire2019!").linkable, false);
});

test("a common stem is refused: unrelated people land on it independently", () => {
  for (const [a, b] of [["Soleil2019!", "Soleil2021!"], ["Password2020", "Password2023"], ["Bonjour2019", "Bonjour2022"]]) {
    assert.equal(patternMatch(a, b).linkable, false, `${a}/${b} must not link`);
  }
});

test("a short stem is refused", () => {
  assert.equal(patternMatch("cat2019", "cat2021").linkable, false);
});

test("different habits do not match", () => {
  assert.equal(patternMatch("Valoire2019!", "Kerguelen2019!").linkable, false);
});

test("patternGroups only reports groups that contain a qualifying pair", () => {
  const g = patternGroups(["Valoire2019!", "Valoire2021!", "Soleil2019!", "Soleil2021!"]);
  const roots = [...g.keys()].map((k) => k.split("|")[0]);
  assert.ok(roots.includes("valoire"));
  assert.ok(!roots.includes("soleil"), "a common stem group is not reported");
});

test("a pattern link surfaces as its own, clearly weaker evidence line", () => {
  const items: ExposureItem[] = [
    { kind: "record", label: "COMB", value: "a@x.fr:Valoire2019!" },
    { kind: "record", label: "COMB", value: "b_handle:Valoire2021!" },
  ];
  const links = reuseLinks(items);
  assert.equal(links.length, 1);
  assert.equal(links[0].mode, "pattern");
  const ev = reuseEvidence(links[0]);
  assert.equal(ev.name, "Same password habit across identities");
  assert.match(ev.detail, /do NOT share a password/);
});

test("an exact link is never displaced by a weaker pattern restatement of itself", () => {
  const items: ExposureItem[] = [
    { kind: "record", label: "COMB", value: "a@x.fr:Valoire2019!" },
    { kind: "record", label: "COMB", value: "b_handle:Valoire2019!" },
    { kind: "record", label: "COMB", value: "b_handle:Valoire2021!" },
  ];
  const links = reuseLinks(items);
  const ab = links.filter((l) => [l.a, l.b].sort().join() === ["a@x.fr", "b_handle"].sort().join());
  assert.equal(ab.length, 1, "one pair, one link");
  assert.equal(ab[0].mode, "exact", "the stronger claim wins");
});

// ---- 4. compromise timeline ------------------------------------------------------------

test("a date is parsed out of whatever shape the source used", () => {
  assert.equal(dateOf("2022-06-11T00:00:00.000Z"), "2022-06-11");
  assert.equal(dateOf("Collection #1 (2019-01)"), "2019-01-01");
  assert.equal(dateOf("MyFitnessPal 2018"), "2018-01-01");
  assert.equal(dateOf("no date here"), null);
});

test("the timeline is ordered and merges breach names with date fields", () => {
  const items: ExposureItem[] = [
    { kind: "date", label: "Date compromised", value: "2022-06-11T00:00:00.000Z", source: "hudsonrock" },
    { kind: "breach", label: "Breach", value: "Collection #1 (2019-01)", source: "xposedornot" },
  ];
  const t = compromiseTimeline(items);
  assert.deepEqual(t.map((e) => e.date), ["2019-01-01", "2022-06-11"]);
  assert.match(timelineSummary(t), /2019-01 → 2022-06/);
});

test("one password across the whole window is reported as a live exposure, hedged", () => {
  const items: ExposureItem[] = [
    { kind: "date", label: "d", value: "2019-01-01" },
    { kind: "date", label: "d", value: "2023-05-01" },
    { kind: "record", label: "COMB", value: "a@x.fr:Xk9!vaLoire" },
    { kind: "record", label: "COMB", value: "a@x.fr:Xk9!vaLoire" },
  ];
  const h = hygiene(items, compromiseTimeline(items));
  const f = h.find((x) => x.kind === "still-in-use");
  assert.ok(f, "the same secret across years is the finding that changes what you do next");
  assert.match(f!.detail, /not proof the account works today/);
});

test("an incremented password is reported as incremented, not as rotation", () => {
  const items: ExposureItem[] = [
    { kind: "date", label: "d", value: "2019-01-01" },
    { kind: "date", label: "d", value: "2023-05-01" },
    { kind: "record", label: "COMB", value: "a@x.fr:Valoire2019!" },
    { kind: "record", label: "COMB", value: "a@x.fr:Valoire2023!" },
  ];
  const h = hygiene(items, compromiseTimeline(items));
  assert.equal(h.find((x) => x.kind === "escalating")?.kind, "escalating");
});

test("genuinely unrelated secrets are reported as rotation, and score lower", () => {
  const items: ExposureItem[] = [
    { kind: "date", label: "d", value: "2019-01-01" },
    { kind: "date", label: "d", value: "2023-05-01" },
    { kind: "record", label: "COMB", value: "a@x.fr:Valoire2019!" },
    { kind: "record", label: "COMB", value: "a@x.fr:Kerguelen#88z" },
  ];
  const h = hygiene(items, compromiseTimeline(items));
  const rot = h.find((x) => x.kind === "rotated");
  assert.ok(rot);
  assert.ok(rot!.weight < 60, "rotation is reassuring, not alarming");
});

test("repeat infection is called out", () => {
  const items: ExposureItem[] = [
    { kind: "date", label: "Date compromised", value: "2019-01-01" },
    { kind: "date", label: "Date compromised", value: "2023-05-01" },
  ];
  const h = hygiene(items, compromiseTimeline(items));
  assert.ok(h.some((x) => x.kind === "repeat-victim"));
});
