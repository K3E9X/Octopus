import { test } from "node:test";
import assert from "node:assert/strict";
import { readSeed, CAPABILITIES } from "../lib/seedtype.ts";

test("the landing page reads a seed the way the engine dispatches it", () => {
  assert.equal(readSeed("marie.dubois@gmail.com").kind, "email");
  assert.equal(readSeed("8.8.8.8").kind, "ip");
  assert.equal(readSeed("2001:4860:4860::8888").kind, "ip");
  assert.equal(readSeed("d41d8cd98f00b204e9800998ecf8427e").kind, "hash");
  assert.equal(readSeed("+33 6 12 34 56 78").kind, "phone");
  assert.equal(readSeed("acme-corp.fr").kind, "domain");
  assert.equal(readSeed("Marie Dubois").kind, "name");
  assert.equal(readSeed("xk9_zulu_42").kind, "username");
  assert.equal(readSeed("   ").kind, "empty");
});

test("what it promises is what the engine actually does — including the refusals", () => {
  const role = readSeed("contact@acme-corp.fr");
  assert.match(role.what, /organisation, not a person/i);
  assert.ok(role.stages.some((s) => /no handle is derived/i.test(s)));

  const freemail = readSeed("someone@gmail.com");
  assert.ok(freemail.stages.some((s) => /domain skipped/i.test(s)), "a freemail domain names no employer");

  const corporate = readSeed("someone@acme-corp.fr");
  assert.ok(corporate.stages.some((s) => /domain enrichment/i.test(s)));

  // every seed type that cannot deliver says so up front
  for (const q of ["+33612345678", "Marie Dubois", "8.8.8.8", "d41d8cd98f00b204e9800998ecf8427e"]) {
    assert.ok(readSeed(q).caveat, `${q} must carry its caveat`);
  }
  assert.match(readSeed("+33612345678").caveat!, /does not pretend/i);
  assert.match(readSeed("Marie Dubois").caveat!, /leads to verify, not an identity/i);
});

test("every capability is reachable by at least one seed type", () => {
  const kinds = new Set(CAPABILITIES.flatMap((c) => c.kinds));
  for (const k of ["username", "email", "domain", "ip", "hash", "name", "phone"]) {
    assert.ok(kinds.has(k as any), `${k} lights nothing on the field`);
  }
  for (const c of CAPABILITIES) assert.ok(c.kinds.length > 0, c.id);
});
