import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDump, parseCorpus, ingestCorpus, searchCorpus, corpusSignals, corpusMode } from "../lib/corpus.ts";

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

// ---- format detection: real material is not tidy `email:password` lines ----------

test("CSV with a header indexes every selector column", () => {
  const recs = parseCorpus(
    "id,email,username,phone,city\n1,marie.dubois@corp.fr,mdubois,+33612345678,Lyon\n2,not-an-email,jdoe,,Paris",
    "hr-export",
  );
  const byType = (t: string) => recs.filter((r) => r.selectorType === t).map((r) => r.selector);
  assert.deepEqual(byType("email"), ["marie.dubois@corp.fr"], "the malformed email is dropped, not indexed");
  assert.deepEqual(byType("username"), ["mdubois", "jdoe"]);
  assert.deepEqual(byType("phone"), ["+33612345678"]);
});

test("a Telegram-style JSON export is ingested with dates and message text", () => {
  const recs = parseCorpus(JSON.stringify({
    name: "channel",
    messages: [
      { id: 1, from: "xk9_zulu_42", date: "2025-03-04T18:22:11", text: "ping me at zulu@mail.tld" },
      { id: 2, from: "Displayed Name With Spaces", date: "2025-03-04T18:25:00", text: "ok" },
    ],
  }), "tg-archive");
  const handles = recs.filter((r) => r.selectorType === "username");
  assert.deepEqual(handles.map((r) => r.selector), ["xk9_zulu_42"], "a display name is not a selector");
  assert.equal(handles[0].recordDate, "2025-03-04T18:22:11");
  assert.ok(handles[0].content.includes("zulu@mail.tld"), "message text is kept — it is the intelligence");
});

test("JSONL is handled, and message text is NOT mangled by credential redaction", () => {
  const recs = parseCorpus(
    '{"username":"alias_87","text":"hey, call me on 06 12 34 56 78"}\n{"username":"other_91","text":"nope"}\n',
    "jsonl-archive",
  );
  assert.equal(recs.length, 2);
  assert.ok(recs[0].content.includes("hey, call me on 06 12 34 56 78"), "a sentence is not a credential");
});

test("credential lines are still redacted after the format widening", () => {
  const recs = parseCorpus("victim@example.com:SuperSecret99", "dump");
  assert.ok(!recs[0].content.includes("SuperSecret99"));
  assert.ok(recs[0].content.includes("*"));
});

// ---- search modes ----------------------------------------------------------------

test("a domain sweep is recognised and kept separate from an exact hit", async () => {
  await ingestCorpus(parseDump(["a.one@sweep-corp.fr:pw1", "b.two@sweep-corp.fr:pw2", "c@other.tld:pw3"].join("\n"), "sweep-corpus"));

  assert.equal(corpusMode("@sweep-corp.fr"), "domain");
  assert.equal(corpusMode("a.one@sweep-corp.fr"), "exact");

  const sweep = await searchCorpus("@sweep-corp.fr", 25);
  assert.deepEqual(sweep.map((h) => h.selector).sort(), ["a.one@sweep-corp.fr", "b.two@sweep-corp.fr"]);

  const exact = await searchCorpus("a.one@sweep-corp.fr");
  assert.equal(exact.length, 1);
});

test("prefix search finds a handle family without claiming they are one person", async () => {
  await ingestCorpus(parseDump(["mdubois87", "mdubois_pro", "unrelated"].join("\n"), "prefix-corpus"));
  const hits = await searchCorpus("mdubois", 25, "prefix");
  assert.deepEqual(hits.map((h) => h.selector).sort(), ["mdubois87", "mdubois_pro"]);
  // and the exact form of that prefix is absent, so it must return nothing
  assert.equal((await searchCorpus("mdubois")).length, 0);
});

test("corpus hits become sourced, sensitivity-flagged nodes", () => {
  const sigs = corpusSignals([{ corpus: "c1", selector: "a@b.c", selectorType: "email", content: "a@b.c:**", ingestedAt: 0 }], "2024-01-01T00:00:00Z");
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, "leak");
  assert.ok(sigs[0].evidence.some((e) => /sensitive source/i.test(e.name)));
  assert.ok(sigs[0].evidence.some((e) => /nothing left this machine/i.test(e.detail)));
});
