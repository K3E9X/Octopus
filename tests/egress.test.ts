import { test } from "node:test";
import assert from "node:assert/strict";
import { egressIdentity, egressHeaders, touchPolicy } from "../lib/egress.ts";

test("identity is STABLE per case and DIFFERENT across cases", () => {
  const a1 = egressIdentity({ caseId: "case-a" });
  const a2 = egressIdentity({ caseId: "case-a" });
  assert.equal(a1.userAgent, a2.userAgent, "same case must look consistent");
  const others = ["b", "c", "d", "e", "f", "g", "h"].map((c) => egressIdentity({ caseId: c }).userAgent);
  assert.ok(new Set(others).size > 1, "different cases must not all share one fingerprint");
});

test("we never announce ourselves as a scanner", () => {
  const h = egressHeaders(egressIdentity({ caseId: "x" }));
  assert.ok(!/octopus|osint|bot|crawler/i.test(h["User-Agent"]), "UA must not identify the tool");
  assert.ok(h["Accept-Language"], "a real browser sends Accept-Language");
});

test("no-touch posture refuses target-observable hosts, allows archival sources", () => {
  assert.equal(touchPolicy("https://www.instagram.com/someone/", "no-touch").allowed, false);
  assert.equal(touchPolicy("https://t.me/someone", "no-touch").allowed, false);
  assert.equal(touchPolicy("https://rdap.org/domain/x.com", "no-touch").allowed, true);
  assert.equal(touchPolicy("https://crt.sh/?q=x", "no-touch").allowed, true);
  // unknown hosts are refused by default — silence is the point
  assert.equal(touchPolicy("https://random-site.example/x", "no-touch").allowed, false);
});

test("direct posture allows everything", () => {
  assert.equal(touchPolicy("https://www.instagram.com/x/", "direct").allowed, true);
});

test("fingerprint pool is wide enough to resist cross-case correlation", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const id = egressIdentity({ caseId: `case-${i}` });
    seen.add(id.userAgent + "|" + id.acceptLanguage);
  }
  // 40 cases must not collapse into a handful of fingerprints
  assert.ok(seen.size >= 25, `only ${seen.size} distinct fingerprints across 40 cases`);
});
