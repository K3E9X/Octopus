import { test } from "node:test";
import assert from "node:assert/strict";
import { isIncidental, minimize, minimizationReport } from "../lib/audit.ts";
import type { Signal } from "../lib/signals.ts";

const mk = (id: string, kind: any): Signal => ({ id, platform: "X", handle: id, disc: "X", confidence: 50, status: "review", kind, evidence: [] });

test("third parties pulled in by the relationship graph are incidental", () => {
  assert.equal(isIncidental(mk("gh-person:alice", "person")), true);
  assert.equal(isIncidental(mk("mention:bob", "person")), true);
  assert.equal(isIncidental(mk("hub:carol", "person")), true);
  assert.equal(isIncidental(mk("gh-org:acme", "org")), true);
  // the subject's own accounts are NOT incidental
  assert.equal(isIncidental(mk("github", "platform")), false);
  assert.equal(isIncidental(mk("person:the-subject", "person")), false);
});

test("minimize strips incidental third parties and their dangling edges", () => {
  const sigs: Signal[] = [
    { ...mk("github", "platform"), linkedIds: ["gh-person:alice", "attr:email:x"] },
    mk("gh-person:alice", "person"),
    mk("attr:email:x", "email"),
  ];
  const out = minimize(sigs);
  assert.equal(out.length, 2, "the third party is removed");
  assert.deepEqual(out[0].linkedIds, ["attr:email:x"], "and so is the edge to it");
});

test("minimization report counts what would be purged", () => {
  const r = minimizationReport([mk("github", "platform"), mk("gh-person:a", "person"), mk("mention:b", "person")]);
  assert.equal(r.total, 3);
  assert.equal(r.incidental, 2);
});
