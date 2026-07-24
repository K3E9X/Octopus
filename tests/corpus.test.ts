import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDump, ingestCorpus, searchCorpus, corpusSignals } from "../lib/corpus.ts";

test("parseDump classifies selectors and REDACTS credentials", () => {
  const recs = parseDump([
    "john@example.com:hunter2secret",
    "+33612345678",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "someuser",
  ].join("\n"), "test-dump");
  const types = recs.map((r) => r.selectorType);
  assert.deepEqual(types, ["email", "phone", "wallet", "username"]);
  const cred = recs[0].content;
  assert.ok(!cred.includes("hunter2secret"), "the password must never be stored verbatim");
  assert.ok(cred.includes("*"), "it must be visibly redacted");
});

test("ingest then silent search returns the record", async () => {
  await ingestCorpus(parseDump("target@example.org:pw123456", "unit-corpus"));
  const hits = await searchCorpus("target@example.org");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].corpus, "unit-corpus");
});

test("corpus hits become sourced, sensitivity-flagged nodes", () => {
  const sigs = corpusSignals([{ corpus: "c1", selector: "a@b.c", selectorType: "email", content: "a@b.c:**", ingestedAt: 0 }], "2024-01-01T00:00:00Z");
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, "leak");
  assert.ok(sigs[0].evidence.some((e) => /sensitive source/i.test(e.name)));
  assert.ok(sigs[0].evidence.some((e) => /nothing left this machine/i.test(e.detail)));
});
