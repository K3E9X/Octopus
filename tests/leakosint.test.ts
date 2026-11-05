import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, isBillableWord, complexityOf, estimateCost, formatCost, refusalIn, itemsFromRow } from "../lib/leakosint.ts";
import { leakOsint } from "../lib/leakosint.ts";
import type { LeakOsintResult } from "../lib/leakosint.ts";

/**
 * Run leakOsint against a canned payload by standing in for fetch.
 *
 * The endpoint bills per request, so the parser is exercised against fixtures rather
 * than against the live API, the shapes below are the ones observed from it.
 */
async function parseFixture(payload: unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as any;
  try {
    return await leakOsint({ token: "1:aaaaaa", request: "probe", limit: 100 });
  } finally {
    globalThis.fetch = real;
  }
}


// ---- the billing rules ---------------------------------------------------------
// These are where the money is: a three-word query is 16x the complexity of a
// one-word query and a four-word one is 40x, so miscounting words overcharges the
// operator silently.

test("a double-quoted phrase is ONE word, the documented way to stay cheap", () => {
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
  // "Telegram ID" contains "tel", it must not be claimed by the phone rule
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

// ---- refusals, as the live endpoint actually sends them ---------------------------
// The API answers HTTP 200 to everything and puts the refusal in the body. These
// payloads are verbatim from the live endpoint; reading one as data would report "the
// API refused" and "this person is clean" as the same finding.

test("the rate-limit refusal the live API really sends is read as an error", () => {
  const live = { error: "You have made too many requests that have invalid data. You will be able to make requests again in 30 seconds. If you have a large list of queries that need to be completed, use file search in the bot." };
  assert.match(refusalIn(live) || "", /too many requests/);
});

test("every refusal key the API has used is recognised", () => {
  assert.equal(refusalIn({ error: "bad token" }), "bad token");
  assert.equal(refusalIn({ "Error code": "402" }), "402");
  assert.equal(refusalIn({ Error: "nope" }), "nope");
  assert.equal(refusalIn({ errorCode: 429 }), "429");
});

test("a real result carries no refusal marker", () => {
  assert.equal(refusalIn({ List: { "Some Dump": { Data: [{ Email: "a@b.c" }], InfoLeak: "x" } } }), null);
  assert.equal(refusalIn({ List: { "No results found": { Data: [] } } }), null);
});

test("an empty or absent error string is not a refusal", () => {
  assert.equal(refusalIn({ error: "   " }), null, "whitespace is not a reason");
  assert.equal(refusalIn({}), null);
  assert.equal(refusalIn(null), null);
});

// ---- the price, pinned to the published formula ----------------------------------
// This is what the business resells, so a drift here is a drift in the margin. The
// documentation states one figure outright, "with the default limit of 100, most
// requests cost $0.003", and that is the anchor every other case is derived from.

test("the documentation's own headline price is reproduced exactly", () => {
  assert.equal(estimateCost("example@gmail.com", 100), 0.003);
  assert.equal(estimateCost("google", 100), 0.003);
});

test("the complexity ladder prices each word count as published", () => {
  assert.equal(complexityOf("google"), 1);
  assert.equal(complexityOf("Petya Ivanov"), 5);
  assert.equal(complexityOf("Elon Reeve Musk"), 16);
  // every word here is four characters or longer, "one"/"two" would be free
  assert.equal(complexityOf("alpha bravo charlie delta"), 40);
});

test("short words are free, so a five-word name can bill as three", () => {
  // "De" and "La" are under four characters and are not words to the biller
  assert.equal(complexityOf("Jean Pierre De La Tour"), 16);
  assert.equal(estimateCost("Jean Pierre De La Tour", 100), estimateCost("Elon Reeve Musk", 100));
});

test("quoting a full name is the documented way to pay a sixth of the price", () => {
  const quoted = estimateCost('"Elon Reeve Musk"', 100);
  const bare = estimateCost("Elon Reeve Musk", 100);
  assert.equal(quoted, 0.003);
  assert.ok(bare > quoted * 2.9, "three bare words cost three times a quoted phrase");
});

test("a number under six digits is free; six digits is a word", () => {
  assert.equal(isBillableWord("12345"), false);
  assert.equal(isBillableWord("123456"), true);
  assert.equal(isBillableWord("01.01.1990"), false, "a date is never a word");
});

test("the live invalid-token shape is a refusal, keys and Status alike", () => {
  // verbatim from the endpoint: an invalid token with a well-formed request
  assert.match(refusalIn({ "Error code": "Invalid token. Get the correct token in the bot.", Status: "Error" }) || "", /Invalid token/);
  // and a Status:Error whose message field we do not recognise is still never a result
  assert.ok(refusalIn({ Status: "Error" }));
  assert.equal(refusalIn({ Status: "Success", List: {} }), null);
});

// ---- batch responses ---------------------------------------------------------------
// The documentation shows how to SEND several queries at once and never shows what one
// comes back as. It does not come back as a single top-level List, which is why the
// pivot shipped reporting a perfectly good answer as "a shape this version cannot read".

test("a single-query response still parses, unchanged", async () => {
  const res = await parseFixture({
    List: { "Dump A": { InfoLeak: "In 2019 something leaked.", Data: [{ Email: "a@b.c" }] } },
  });
  assert.equal(res.databases.length, 1);
  assert.equal(res.databases[0].rows.length, 1);
  assert.equal(res.unreadable, undefined);
});

test("a batch response nests a List per query, and all of it is read", async () => {
  const res = await parseFixture({
    "a@b.c": { List: { "Dump A": { InfoLeak: "x", Data: [{ Email: "a@b.c" }] } } },
    "+33612345678": { List: { "Dump B": { InfoLeak: "y", Data: [{ Phone: "+33612345678" }] } } },
  });
  assert.deepEqual(res.databases.map((d) => d.name).sort(), ["Dump A", "Dump B"]);
  assert.equal(res.rowCount, 2);
  assert.notEqual(res.unreadable, true, "a readable batch is not 'unreadable'");
});

test("the same dump hit by two queries is one dump, not two", async () => {
  const res = await parseFixture({
    q1: { List: { "Collection #1": { InfoLeak: "a stuffing list", Data: [{ Email: "a@b.c" }] } } },
    q2: { List: { "Collection #1": { InfoLeak: "a stuffing list", Data: [{ Email: "d@e.f" }] } } },
  });
  assert.equal(res.databases.length, 1, "merged by name");
  assert.equal(res.databases[0].rows.length, 2, "both rows kept");
});

test("a row returned by two queries in one batch counts once", async () => {
  const row = { Email: "a@b.c", Password: "x" };
  const res = await parseFixture({
    q1: { List: { D: { InfoLeak: "", Data: [row] } } },
    q2: { List: { D: { InfoLeak: "", Data: [row] } } },
  });
  assert.equal(res.databases[0].rows.length, 1);
});

test("a batch that matched nothing is empty, not unreadable", async () => {
  const res = await parseFixture({
    q1: { List: { "No results found": { InfoLeak: "No results found.", Data: [] } } },
    q2: { List: { "No results found": { InfoLeak: "No results found.", Data: [] } } },
  });
  assert.equal(res.rowCount, 0);
  assert.notEqual(res.unreadable, true);
});

test("a payload with no List anywhere is unreadable, and says what it saw", async () => {
  const res = await parseFixture({ somethingNew: 1, alsoThis: "x" });
  assert.equal(res.unreadable, true);
  assert.match(res.shape || "", /somethingNew/);
  // the SHAPE, never the content
  assert.ok(!(res.shape || "").includes("x"));
});

// ---- every shape this endpoint has been seen to answer in -------------------------
// The documentation describes exactly one, and the endpoint produces several. Two
// attempts to fix the pivot by naming the keys both shipped broken, because naming
// keys is guessing. A database entry is recognisable by its SHAPE, rows under `Data`,
// a provenance line under `InfoLeak`, and that is what the parser looks for now.

const ONE_DB = { "Dump A": { InfoLeak: "In 2019 a dump appeared.", Data: [{ Email: "a@b.c" }] } };

test("the documented shape: a top-level List", async () => {
  const r = await parseFixture({ List: ONE_DB });
  assert.equal(r.databases.length, 1);
  assert.notEqual(r.unreadable, true);
});

test("a batch nesting a List per query", async () => {
  const r = await parseFixture({ "a@b.c": { List: ONE_DB } });
  assert.equal(r.databases.length, 1);
  assert.equal(r.rowCount, 1);
  assert.notEqual(r.unreadable, true);
});

test("a batch nesting the databases directly, with no List key at all", async () => {
  // this is the one that kept the pivot broken: there is no `List` anywhere to find
  const r = await parseFixture({ "a@b.c": ONE_DB });
  assert.equal(r.databases.length, 1);
  assert.equal(r.rowCount, 1);
  assert.notEqual(r.unreadable, true);
});

test("databases at the root, with no wrapper", async () => {
  const r = await parseFixture(ONE_DB);
  assert.equal(r.databases.length, 1);
  assert.notEqual(r.unreadable, true);
});

test("several queries, each with its own databases", async () => {
  const r = await parseFixture({
    q1: ONE_DB,
    q2: { "Dump B": { InfoLeak: "another", Data: [{ Phone: "+33612345678" }] } },
  });
  assert.deepEqual(r.databases.map((d) => d.name).sort(), ["Dump A", "Dump B"]);
  assert.equal(r.rowCount, 2);
});

test("a nested empty answer is empty, not unreadable, it must not be refunded", async () => {
  const r = await parseFixture({ q1: { List: { "No results found": { InfoLeak: "nothing", Data: [] } } } });
  assert.equal(r.rowCount, 0);
  assert.notEqual(r.unreadable, true);
});

test("a genuinely unknown payload is flagged, and reports its keys and not its values", async () => {
  const r = await parseFixture({ somethingNew: "sensitive-value-here", alsoThis: 1 });
  assert.equal(r.unreadable, true);
  assert.match(r.shape || "", /somethingNew/);
  assert.ok(!(r.shape || "").includes("sensitive-value-here"), "key names only");
});

test("a row is never mistaken for a database, however deep it sits", async () => {
  // a record with an InfoLeak-ish column must not be read as a database map
  const r = await parseFixture({ List: { "Dump A": { InfoLeak: "x", Data: [{ Email: "a@b.c", Notes: "InfoLeak" }] } } });
  assert.equal(r.databases.length, 1);
  assert.equal(r.databases[0].rows.length, 1);
});

// ---- what a column is, when the column name does not say ----------------------------
//
// Every case here was produced by the landing page's demo report, which runs the real
// buildReport() over invented dumps. It claimed the subject had five phone numbers;
// one of them was a payment card, one was an IPv4 address and one was a social
// network's numeric user id. All three came from the same fallback.

test("a payment card is not a phone number", () => {
  const items = itemsFromRow({ name: "d" }, { CardNumber: "4111 1111 1111 1111" });
  assert.notEqual(items[0].kind, "phone");
});

test("a sixteen-digit run is past E.164 whatever its spacing", () => {
  const items = itemsFromRow({ name: "d" }, { Number: "5555 5555 5555 4444" });
  assert.notEqual(items[0].kind, "phone");
});

test("a platform user id is an identifier, not a number anybody dialled", () => {
  assert.equal(itemsFromRow({ name: "d" }, { UID: "100008841220" })[0].kind, "identifier");
  assert.equal(itemsFromRow({ name: "d" }, { user_id: "77120034" })[0].kind, "identifier");
});

test("a bare twelve-digit run is not claimed as a phone", () => {
  // no column rule matches "Ref", so this is the value fallback deciding alone
  assert.notEqual(itemsFromRow({ name: "d" }, { Ref: "100008841220" })[0].kind, "phone");
});

test("an IP is an IP even in a camel-cased column", () => {
  for (const col of ["OrderIP", "RegIP", "last_ip", "ip_address"]) {
    assert.equal(itemsFromRow({ name: "d" }, { [col]: "92.184.104.57" })[0].kind, "ip", col);
  }
});

test("a dotted quad in an unnamed column is an IP, not a phone", () => {
  assert.equal(itemsFromRow({ name: "d" }, { Value: "92.184.104.57" })[0].kind, "ip");
});

test("but 999.1.1.1 is not an IP, the octets have to be octets", () => {
  assert.notEqual(itemsFromRow({ name: "d" }, { Value: "999.1.1.1" })[0].kind, "ip");
});

test("real phone numbers still classify, formatted or bare", () => {
  for (const v of ["+33 6 39 98 41 02", "0639984102", "+1 (415) 555-0132", "020 7946 0018"]) {
    assert.equal(itemsFromRow({ name: "d" }, { Value: v })[0].kind, "phone", v);
  }
  // and a column that says so always wins over any of this
  assert.equal(itemsFromRow({ name: "d" }, { Phone: "100008841220" })[0].kind, "phone");
});

test("a zip column is still an address, not an IP", () => {
  assert.equal(itemsFromRow({ name: "d" }, { Zip: "69007" })[0].kind, "address");
});

test("'ip_address' is an IP, not somewhere the subject lives", () => {
  // it contains the word "address", and the address rule used to run first
  assert.equal(itemsFromRow({ name: "d" }, { ip_address: "92.184.104.57" })[0].kind, "ip");
  assert.equal(itemsFromRow({ name: "d" }, { ipAddress: "10.0.0.1" })[0].kind, "ip");
});

test("the IP suffix rule is case-sensitive, because 'zip' is not an IP", () => {
  for (const col of ["Zip", "zip", "zipcode", "Zips"]) {
    assert.notEqual(itemsFromRow({ name: "d" }, { [col]: "69007" })[0].kind, "ip", col);
  }
  for (const col of ["OrderIP", "RegIP"]) {
    assert.equal(itemsFromRow({ name: "d" }, { [col]: "92.184.104.57" })[0].kind, "ip", col);
  }
});
