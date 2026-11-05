import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, isBillableWord, complexityOf, estimateCost, formatCost } from "../lib/leakosint.ts";
import type { LeakOsintResult } from "../lib/leakosint.ts";

// ---- the billing rules ---------------------------------------------------------
// These are where the money is: a three-word query is 16x the complexity of a
// one-word query and a four-word one is 40x, so miscounting words overcharges the
// operator silently.

test("a double-quoted phrase is ONE word — the documented way to stay cheap", () => {
  assert.deepEqual(tokenize('"Elon Reeve Musk"'), ["Elon Reeve Musk"]);
  assert.equal(complexityOf('"Elon Reeve Musk"'), 1);
  // the same name unquoted is three words, which is sixteen times the complexity
  assert.equal(complexityOf("Elon Reeve Musk"), 16);
});

test("dates, short strings and short numbers are not billable words", () => {
  assert.equal(isBillableWord("1990-01-01"), false);
  assert.equal(isBillableWord("01.01.1990"), false);
  assert.equal(isBillableWord("abc"), false, "under 4 characters");
  assert.equal(isBillableWord("12345"), false, "a number under 6 digits");
  assert.equal(isBillableWord("123456"), true, "6 digits counts");
  assert.equal(isBillableWord("abcd"), true, "4 characters counts");
});

test("free tokens do not raise the complexity of a query", () => {
  // "Ivanov 1990-01-01 42" is one billable word, not three
  assert.equal(complexityOf("Ivanov 1990-01-01 42"), 1);
  assert.equal(complexityOf("Ivanov Petrov"), 5);
});

test("complexity follows the published ladder", () => {
  assert.equal(complexityOf("google"), 1);
  assert.equal(complexityOf("alpha bravo"), 5);
  assert.equal(complexityOf("alpha bravo charlie"), 16);
  assert.equal(complexityOf("alpha bravo charlie delta"), 40);
  assert.equal(complexityOf("alpha bravo charlie delta echo"), 40, "capped past three");
  assert.equal(complexityOf(""), 1);
});

test("the cost formula matches the published one", () => {
  // 0.0002 * (5 + sqrt(limit * complexity))
  const expected = 0.0002 * (5 + Math.sqrt(100 * 1));
  assert.ok(Math.abs(estimateCost("google", 100) - expected) < 1e-12);
  // the documented default lands at the documented price
  assert.equal(Number(estimateCost("google", 100).toFixed(3)), 0.003);
});

test("cost rises with the limit and with the word count", () => {
  assert.ok(estimateCost("google", 10000) > estimateCost("google", 100));
  assert.ok(estimateCost("alpha bravo charlie", 100) > estimateCost("google", 100));
});

test("a batch is billed per query, and newlines are a batch", () => {
  const one = estimateCost("google", 100);
  assert.ok(Math.abs(estimateCost("google\ngoogle", 100) - one * 2) < 1e-12);
  assert.ok(Math.abs(estimateCost(["google", "google"], 100) - one * 2) < 1e-12);
});

test("the quote is readable at the scale it actually lands on", () => {
  assert.match(formatCost(0.003), /^\$0\.0030$/);
  assert.match(formatCost(1.25), /^\$1\.250$/);
});

// ---- the parser, against a payload shaped like the documentation ------------------
// The endpoint is unreachable from CI, so the wire format is exercised by stubbing
// fetch. This is the part that would break silently if the response shape moved.

async function withFetch<T>(reply: unknown, status = 200, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: status < 400, status, json: async () => reply });
  try { return await fn(); } finally { (globalThis as any).fetch = real; }
}

test("the documented response shape parses into databases, rows and provenance", async () => {
  const { leakOsint } = await import("../lib/leakosint.ts");
  const payload = {
    List: {
      "Collection #1": {
        InfoLeak: "2019 credential aggregation.",
        Data: [{ Email: "marie@acme.fr", Password: "Kerguelen#88z", FullName: "Marie Dubois", Phone: "+33612345678", Address: "Lyon" }],
      },
      "Telegram 2023": { InfoLeak: "Channel export.", Data: [{ NickName: "mdub_92", "Telegram ID": "123456789" }] },
    },
  };
  const res = await withFetch(payload, 200, () => leakOsint({ token: "t", request: "marie@acme.fr" }));
  assert.equal(res.error, undefined);
  assert.equal(res.databases.length, 2);
  assert.equal(res.rowCount, 2);
  assert.equal(res.databases[0].info, "2019 credential aggregation.");

  const kind = (k: string) => res.items.filter((i) => i.kind === k).map((i) => i.value);
  assert.deepEqual(kind("email"), ["marie@acme.fr"]);
  assert.deepEqual(kind("credential"), ["Kerguelen#88z"]);
  assert.deepEqual(kind("name"), ["Marie Dubois"]);
  assert.deepEqual(kind("phone"), ["+33612345678"]);
  assert.deepEqual(kind("address"), ["Lyon"]);
  assert.ok(kind("identifier").includes("mdub_92"));
  // "Telegram ID" contains "tel" — it must not be claimed by the phone rule
  assert.ok(kind("identifier").includes("123456789"), "a platform ID is not a phone number");
  // the row is paired so credential reuse has a login:secret to work on
  assert.ok(kind("record").includes("marie@acme.fr:Kerguelen#88z"));
  // every item carries which database it came from
  assert.ok(res.items.every((i) => i.source?.startsWith("leakosint · ")));
});

test('"No results found" is a clean empty answer, not a database', async () => {
  const { leakOsint } = await import("../lib/leakosint.ts");
  const res = await withFetch({ List: { "No results found": { InfoLeak: "", Data: [] } } }, 200,
    () => leakOsint({ token: "t", request: "nobody" }));
  assert.deepEqual(res.databases, []);
  assert.equal(res.empty, true);
  assert.equal(res.error, undefined, "an empty result is not an error");
});

test('an "Error code" reply is an error, never an empty result', async () => {
  const { leakOsint } = await import("../lib/leakosint.ts");
  const res = await withFetch({ "Error code": "Invalid token" }, 200, () => leakOsint({ token: "t", request: "x" }));
  assert.equal(res.error, "Invalid token");
  assert.equal(res.databases.length, 0);
});

test("empty and nullish cells are dropped, real values kept", async () => {
  const { leakOsint } = await import("../lib/leakosint.ts");
  const res = await withFetch({ List: { db: { InfoLeak: "", Data: [{ Email: "a@b.fr", Phone: "-", City: "", Note: "null", Zip: "69000" }] } } },
    200, () => leakOsint({ token: "t", request: "x" }));
  const vals = res.items.filter((i) => i.label !== "Database").map((i) => i.value);
  assert.deepEqual(vals.sort(), ["69000", "a@b.fr"]);
});

test("an unrecognised payload is harvested rather than reported as empty", async () => {
  const { leakOsint } = await import("../lib/leakosint.ts");
  const res = await withFetch({ unexpected: { shape: "value-that-survives" } }, 200,
    () => leakOsint({ token: "t", request: "x" }));
  assert.ok(res.items.some((i) => i.value === "value-that-survives"), "a renamed field must not vanish");
  assert.equal(res.empty, false);
});

test("a missing token never reaches the network", async () => {
  const { leakOsint } = await import("../lib/leakosint.ts");
  let called = false;
  const real = globalThis.fetch;
  (globalThis as any).fetch = async () => { called = true; throw new Error("should not be called"); };
  try {
    const res = await leakOsint({ token: "", request: "x" });
    assert.match(res.error!, /no LeakOSINT token/);
    assert.equal(called, false);
  } finally { (globalThis as any).fetch = real; }
});
