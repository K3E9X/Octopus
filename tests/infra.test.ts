import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeIp, looksLikeHash, hashKind, ipSignals, hashSignals, iocPivots } from "../lib/infra.ts";
import { classify } from "../lib/scoring.ts";

test("an IOC is recognised as a seed, and junk is not", () => {
  for (const ip of ["8.8.8.8", "192.168.1.1", "2001:4860:4860::8888", "::1"]) assert.ok(looksLikeIp(ip), ip);
  for (const no of ["999.1.1.1", "1.2.3", "example.com", "marie.dubois", "1.2.3.4.5"]) assert.equal(looksLikeIp(no), false, no);

  assert.equal(hashKind("d41d8cd98f00b204e9800998ecf8427e"), "md5");
  assert.equal(hashKind("da39a3ee5e6b4b0d3255bfef95601890afd80709"), "sha1");
  assert.equal(hashKind("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "sha256");
  assert.equal(hashKind("abc"), null, "too short");
  assert.equal(hashKind("z3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), null, "not hex");
  assert.equal(looksLikeHash("torvalds"), false);
});

test("a private address says so, and says why it is a dead end", () => {
  const [s] = ipSignals({ ip: "192.168.1.10", version: 4, private: true, ptr: [] }, "2026-07-25T00:00:00Z");
  const ev = s.evidence[0];
  assert.match(ev.name, /private address/i);
  assert.equal(classify(ev.name), "contra", "it must not read as a finding about an internet host");
});

test("a public address yields the registration, the abuse contact and its PTR as a pivot", () => {
  const sigs = ipSignals({
    ip: "8.8.8.8", version: 4, private: false, ptr: ["dns.google"],
    network: "8.8.8.0 – 8.8.8.255", org: "Google LLC", country: "US", abuse: "network-abuse@google.com",
  }, "2026-07-25T00:00:00Z");
  const ip = sigs[0];
  assert.ok(ip.evidence.some((e) => /rdap/i.test(e.source) && /Google LLC/.test(e.detail)));
  assert.ok(ip.evidence.some((e) => /abuse contact/i.test(e.name)));
  const host = sigs.find((s) => s.platform === "HOSTNAME");
  assert.ok(host, "the PTR name must become its own pivotable node");
  assert.equal(host!.handle, "dns.google");
  // the PTR names the hosting, not the tenant — the evidence has to say so
  assert.match(ip.evidence.find((e) => /reverse dns/i.test(e.name))!.detail, /not necessarily the tenant/i);
});

test("a digest that was not checked never reads as a clean file", () => {
  const [s] = hashSignals({
    hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    kind: "sha256", known: false, unchecked: "source did not answer",
  }, "2026-07-25T00:00:00Z");
  const ev = s.evidence.find((e) => /not checked/i.test(e.name))!;
  assert.match(ev.detail, /absence of a check/i);
  assert.equal(classify(ev.name), "weak");
  assert.match(s.evidence[0].detail, /identifies BYTES, not a person/);
});

test("external pivots are offered, never claimed as results", () => {
  const p = iocPivots("8.8.8.8", "ip");
  assert.ok(p.length >= 4);
  for (const s of p) {
    assert.equal(s.tier, "weak");
    assert.equal(s.status, "candidate");
    assert.match(s.evidence[0].name, /not queried/i);
    assert.ok(s.url?.includes("8.8.8.8"));
  }
  assert.ok(iocPivots("d41d8cd98f00b204e9800998ecf8427e", "hash").some((s) => /virustotal/i.test(s.platform)));
});
