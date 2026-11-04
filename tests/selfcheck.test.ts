import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, headline, parseBreachDate, looksFinancial } from "../lib/selfcheck.ts";
import { identifierChannel, normalizeIdentifier, issueChallenge, checkCode, newCode } from "../lib/ownership.ts";
import type { ExposureItem } from "../lib/exposure.ts";

// Build an ExposureItem the way lib/leakosint's rowItems would, so these tests exercise
// the real column → category path, not a convenient fiction.
const E = (kind: string, label: string, value: string, db = "Collection #1", masked?: boolean): ExposureItem =>
  ({ kind: kind as any, label, value, source: `leakosint · ${db}`, masked });

const cat = (r: ReturnType<typeof buildReport>, c: string) => r.categories.find((x) => x.category === c);

// ---- categorisation: the full field set from a real LeakOSINT record -----------------

test("every field type lands in the category the owner would expect", () => {
  const r = buildReport("jane.doe@example.com", [
    E("credential", "Password", "Kerguelen#88z"),
    E("identifier", "BankAccount", "FR7630006000011234567890189"),  // IBAN mislabelled by the raw classifier
    E("name", "FullName", "JANE DOE"),
    E("date", "BDay", "1990-01-01"),
    E("other", "Gender", "M"),
    E("address", "City", "SAMPLEVILLE"),
    E("date", "RegDate", "2014-01-23"),                              // metadata, not a finding
    E("email", "Email", "jane.doe@example.com"),
    E("phone", "Phone", "+33600000000"),
    E("identifier", "NickName", "jane.doe.3"),
    E("login", "Link", "https://www.linkedin.com/in/jane-doe-example"),
    E("other", "JobTitle", "DATA ENGINEER"),
    E("other", "CompanyName", "Example Corp"),
  ], [{ name: "Collection #1", info: "x" }]);

  assert.deepEqual(cat(r, "password")!.findings.map((f) => f.value), ["Kerguelen#88z"]);
  assert.deepEqual(cat(r, "financial")!.findings.map((f) => f.value), ["FR7630006000011234567890189"]);
  assert.equal(cat(r, "financial")!.severity, "critical");
  // identity collects the real name, the birthday and the gender
  assert.deepEqual(cat(r, "identity")!.findings.map((f) => f.value).sort(), ["1990-01-01", "M", "JANE DOE"].sort());
  assert.deepEqual(cat(r, "location")!.findings.map((f) => f.value), ["SAMPLEVILLE"]);
  assert.deepEqual(cat(r, "email")!.findings.map((f) => f.value), ["jane.doe@example.com"]);
  assert.deepEqual(cat(r, "phone")!.findings.map((f) => f.value), ["+33600000000"]);
  assert.deepEqual(cat(r, "online")!.findings.map((f) => f.value).sort(),
    ["https://www.linkedin.com/in/jane-doe-example", "jane.doe.3"].sort());
  assert.deepEqual(cat(r, "professional")!.findings.map((f) => f.value).sort(),
    ["DATA ENGINEER", "Example Corp"].sort());
});

test("a registration date is metadata and never a finding; a birthday is identity", () => {
  const r = buildReport("x", [
    E("date", "RegDate", "2014-01-23"),
    E("date", "LastActive", "2015-01-01"),
    E("date", "BDay", "1990-01-01"),
  ], []);
  const ident = cat(r, "identity");
  assert.ok(ident, "birthday makes an identity category");
  assert.deepEqual(ident!.findings.map((f) => f.value), ["1990-01-01"]);
  assert.equal(r.dataPoints, 1, "only the birthday counts");
});

test("a RIB, an IBAN and a card are all financial — the thing people most need told", () => {
  assert.equal(looksFinancial("RIB", "30004000031234567890143"), true);   // 23-digit French RIB
  assert.equal(looksFinancial("iban", "FR7630006000011234567890189"), true);
  assert.equal(looksFinancial("card", "4111111111111111"), true);          // Luhn-valid
  assert.equal(looksFinancial("note", "just a comment"), false);
});

test("the same password in ten rows is one exposure, not ten", () => {
  const items = Array.from({ length: 10 }, () => E("credential", "Password", "Kerguelen#88z"));
  const r = buildReport("x", items, []);
  assert.equal(cat(r, "password")!.distinct, 1);
});

test("categories are ordered worst-first and the verdict reflects the worst", () => {
  const r = buildReport("x", [E("email", "Email", "a@b.fr"), E("credential", "Password", "pw")], []);
  assert.equal(r.categories[0].category, "password", "password outranks email");
  assert.equal(r.verdict, "critical");
});

test("no findings is an honest 'clear at this depth', not a false all-clear", () => {
  const r = buildReport("nobody@x.fr", [], []);
  assert.equal(r.verdict, "clear");
  assert.match(headline(r), /at this search depth/);
});

test("a masked value stays masked in the report", () => {
  const r = buildReport("x", [E("credential", "Password", "Ker****z", "Collection #1", true)], []);
  assert.equal(cat(r, "password")!.findings[0].masked, true);
});

// ---- the "where" view: grouping by breach --------------------------------------------

test("findings are grouped by the breach they came from, each with its description", () => {
  const r = buildReport("jane.doe@example.com", [
    E("identifier", "BankAccount", "FR7630006000011234567890189", "BOUYGUES TELECOM"),
    E("name", "FullName", "DOE JANE", "BOUYGUES TELECOM"),
    E("name", "FullName", "JANE DOE", "BOULANGER.COM"),
    E("address", "City", "SAMPLEVILLE", "BOULANGER.COM"),
  ], [
    { name: "BOUYGUES TELECOM", info: "On August 4, 2025, the French operator Bouygues Telecom suffered a cyberattack… IBAN bank account numbers." },
    { name: "BOULANGER.COM", info: "The French website Boulanger suffered a breach on March 19, 2025." },
  ]);

  assert.equal(r.sources.length, 2);
  const bouygues = r.sources.find((s) => s.name === "BOUYGUES TELECOM")!;
  assert.equal(bouygues.date, "August 4, 2025");
  assert.equal(bouygues.severity, "critical", "the IBAN makes this breach critical");
  // worst-first inside the breach: the financial finding comes before the name
  assert.equal(bouygues.findings[0].category, "financial");
  // newest breach first across the report
  assert.equal(r.sources[0].name, "BOUYGUES TELECOM");
});

test("a breach with no surfaced field still appears as a source line", () => {
  const r = buildReport("x", [E("email", "Email", "a@b.fr", "KNOWN")], [
    { name: "KNOWN", info: "In late 2022 something happened." },
    { name: "EMPTYISH", info: "A 2019 aggregation." },
  ]);
  assert.ok(r.sources.find((s) => s.name === "EMPTYISH"), "named breach is still listed");
});

// ---- the "when" view: the timeline ---------------------------------------------------

test("breach-description dates are parsed for the timeline", () => {
  assert.deepEqual(parseBreachDate("suffered a breach on March 19, 2025.").date, "March 19, 2025");
  assert.deepEqual(parseBreachDate("On August 4, 2025, …").date, "August 4, 2025");
  assert.equal(parseBreachDate("In late 2022 Deezer reported…").date, "Late 2022");
  assert.equal(parseBreachDate("a backup published … in mid-2019").date, "Mid 2019");
  assert.equal(parseBreachDate("2019-01-01 aggregation").date, "2019-01-01");
  assert.equal(parseBreachDate("no date here").sortDate, 0);
});

test("the timeline runs oldest breach first", () => {
  const r = buildReport("x", [
    E("email", "Email", "a@b.fr", "DEEZER"),
    E("email", "Email", "a@b.fr", "BOUYGUES"),
  ], [
    { name: "DEEZER", info: "In late 2022 …" },
    { name: "BOUYGUES", info: "On August 4, 2025 …" },
  ]);
  assert.deepEqual(r.timeline.map((t) => t.name), ["DEEZER", "BOUYGUES"]);
});

// ---- highlights ----------------------------------------------------------------------

test("financial and password findings are pulled out as highlights", () => {
  const r = buildReport("x", [
    E("identifier", "BankAccount", "FR7630006000011234567890189"),
    E("credential", "Password", "hunter2"),
    E("email", "Email", "a@b.fr"),
  ], []);
  assert.equal(r.highlights.financial.length, 1);
  assert.equal(r.highlights.passwords.length, 1);
});

// ---- ownership proof (unchanged behaviour, kept under test) --------------------------

test("an email and a phone are verifiable; a username is not", () => {
  assert.equal(identifierChannel("me@acme.fr"), "email");
  assert.equal(identifierChannel("+33 6 12 34 56 78"), "phone");
  assert.equal(identifierChannel("mdub_92"), null);
});

test("identifiers normalise so a check and its proof match", () => {
  assert.equal(normalizeIdentifier("Me@Acme.FR", "email"), "me@acme.fr");
  assert.equal(normalizeIdentifier("+33 6 12 34 56 78", "phone"), "+33612345678");
});

test("the right code verifies; a wrong one does not", () => {
  const { challenge, code } = issueChallenge("me@acme.fr", "email");
  assert.equal(checkCode({ ...challenge }, "000000" === code ? "111111" : "000000").ok, false);
  assert.equal(checkCode({ ...challenge }, code).ok, true);
});

test("a code expires, and brute force is capped at five attempts", () => {
  const { challenge, code } = issueChallenge("x", "email");
  assert.deepEqual(checkCode({ ...challenge, expires: Date.now() - 1 }, code), { ok: false, reason: "expired" });
  const ch = { ...challenge, attempts: 5 };
  assert.deepEqual(checkCode(ch, code), { ok: false, reason: "too-many" });
});

test("a code is six digits — the space that makes five guesses hopeless", () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^\d{6}$/);
});
