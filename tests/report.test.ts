import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, headline, parseBreachDate, looksFinancial, precedenceOrder, ruleFor } from "../lib/report.ts";
import { buildSubject } from "../lib/subject.ts";
import type { LeakDatabase } from "../lib/leakosint.ts";

// These tests feed the report RAW ROWS with the dump's own column names, exactly as the
// API returns them, so the whole path is exercised, attribution, column classification,
// consolidation, rather than a convenient fiction half way down it.
const db = (name: string, info: string, ...rows: Record<string, string>[]): LeakDatabase =>
  ({ name, info, rows });

const cat = (r: ReturnType<typeof buildReport>, c: string) => r.categories.find((x) => x.category === c);

const JANE = buildSubject("jane.doe@example.com");

// ---- categorisation: the full field set from a real LeakOSINT record ----------------

test("every field type lands in the category the owner would expect", () => {
  const r = buildReport(JANE, [
    db("Collection #1", "A credential stuffing list.", {
      Email: "jane.doe@example.com",
      Password: "Kerguelen#88z",
      BankAccount: "FR7630006000011234567890189", // an IBAN the raw classifier calls an identifier
      FullName: "JANE DOE",
      BDay: "1990-01-01",
      Gender: "M",
      City: "SAMPLEVILLE",
      RegDate: "2014-01-23",                      // metadata, not a finding
      Phone: "+33600000000",
      NickName: "jane.doe.3",
      Link: "https://www.linkedin.com/in/jane-doe-example",
      JobTitle: "DATA ENGINEER",
      CompanyName: "Example Corp",
    }),
  ]);

  assert.deepEqual(cat(r, "password")!.findings.map((f) => f.value), ["Kerguelen#88z"]);
  assert.deepEqual(cat(r, "financial")!.findings.map((f) => f.value), ["FR7630006000011234567890189"]);
  assert.equal(cat(r, "financial")!.severity, "critical");
  assert.deepEqual(cat(r, "identity")!.findings.map((f) => f.value).sort(), ["1990-01-01", "JANE DOE", "M"].sort());
  assert.deepEqual(cat(r, "location")!.findings.map((f) => f.value), ["SAMPLEVILLE"]);
  assert.deepEqual(cat(r, "email")!.findings.map((f) => f.value), ["jane.doe@example.com"]);
  assert.deepEqual(cat(r, "phone")!.findings.map((f) => f.value), ["+33600000000"]);
  assert.deepEqual(cat(r, "online")!.findings.map((f) => f.value).sort(),
    ["https://www.linkedin.com/in/jane-doe-example", "jane.doe.3"].sort());
  assert.deepEqual(cat(r, "professional")!.findings.map((f) => f.value).sort(),
    ["DATA ENGINEER", "Example Corp"].sort());
});

test("a registration date is metadata and never a finding; a birthday is identity", () => {
  const r = buildReport(JANE, [
    db("X", "", { Email: "jane.doe@example.com", RegDate: "2014-01-23", LastActive: "2015-01-01", BDay: "1990-01-01" }),
  ]);
  assert.deepEqual(cat(r, "identity")!.findings.map((f) => f.value), ["1990-01-01"]);
  // the address is itself a finding, plus the birthday, the two activity dates are not
  assert.equal(r.dataPoints, 2);
});

test("a RIB, an IBAN and a card are all financial, the thing people most need told", () => {
  assert.equal(looksFinancial("RIB", "30004000031234567890143"), true);   // 23-digit French RIB
  assert.equal(looksFinancial("iban", "FR7630006000011234567890189"), true);
  assert.equal(looksFinancial("CardNumber", "4111111111111111"), true);   // passes Luhn
  assert.equal(looksFinancial("Nickname", "4111111111111112"), false);    // fails Luhn, not a card
});

test("the same password in ten rows is one exposure, not ten", () => {
  const rows = Array.from({ length: 10 }, () => ({ Email: "jane.doe@example.com", Password: "same-one" }));
  const r = buildReport(JANE, [db("X", "", ...rows)]);
  assert.equal(cat(r, "password")!.distinct, 1);
});

test("categories are ordered worst-first and the verdict reflects the worst", () => {
  const r = buildReport(JANE, [db("X", "", { Email: "jane.doe@example.com", Password: "p" })]);
  assert.equal(r.categories[0].category, "password");
  assert.equal(r.verdict, "critical");
});

test("no findings is an honest 'clear at this depth', not a false all-clear", () => {
  const r = buildReport(JANE, []);
  assert.equal(r.verdict, "clear");
  assert.equal(r.dataPoints, 0);
  assert.match(headline(r), /No exposure found/);
});

// ---- the "where" view: grouping by breach -------------------------------------------

test("findings are grouped by the breach they came from, each with its description", () => {
  const r = buildReport(JANE, [
    db("Collection #1", "In 2019, a credential stuffing list was published.",
      { Email: "jane.doe@example.com", Password: "a" }),
    db("LinkedIn 2021", "In June 2021, LinkedIn scraped data appeared.",
      { Email: "jane.doe@example.com", FullName: "Jane Doe" }),
  ]);
  assert.equal(r.sources.length, 2);
  const linkedin = r.sources.find((s) => s.name === "LinkedIn 2021")!;
  assert.match(linkedin.info, /LinkedIn scraped data/);
  assert.equal(linkedin.date, "June 2021");
});

test("a breach that matched but surfaced no usable field is still a source line", () => {
  const r = buildReport(JANE, [db("Mystery Dump", "An undated dump.", { Email: "jane.doe@example.com" })]);
  assert.ok(r.sources.some((s) => s.name === "Mystery Dump"));
});

// ---- the "when" view: the timeline ---------------------------------------------------

test("breach-description dates are parsed for the timeline", () => {
  assert.equal(parseBreachDate("suffered a breach on March 19, 2025").date, "March 19, 2025");
  assert.equal(parseBreachDate("In late 2022 a dump appeared").date, "Late 2022");
  assert.equal(parseBreachDate("published 2019-01-01").date, "2019-01-01");
  assert.equal(parseBreachDate("no date here at all").sortDate, 0);
});

test("the timeline runs oldest breach first", () => {
  const r = buildReport(JANE, [
    db("New", "In 2023 something leaked.", { Email: "jane.doe@example.com", Password: "a" }),
    db("Old", "In 2012 something leaked.", { Email: "jane.doe@example.com", Password: "b" }),
  ]);
  assert.deepEqual(r.timeline.map((t) => t.name), ["Old", "New"]);
});

// ---- highlights ----------------------------------------------------------------------

test("financial and password findings are pulled out as highlights", () => {
  const r = buildReport(JANE, [
    db("X", "", { Email: "jane.doe@example.com", Password: "pw", IBAN: "FR7630006000011234567890189", City: "Paris" }),
  ]);
  assert.equal(r.highlights.passwords.length, 1);
  assert.equal(r.highlights.financial.length, 1);
});

// ---- attribution: the line between a report and a fabrication ------------------------

test("a row the API returned about somebody else never enters the subject's report", () => {
  const r = buildReport(JANE, [
    db("X", "", { Email: "jane.doe@example.com", Password: "hers" }),
    db("X", "", { Email: "someone.else@example.com", Password: "theirs" }),
  ]);
  assert.deepEqual(cat(r, "password")!.findings.map((f) => f.value), ["hers"]);
  assert.equal(r.excluded.unrelated, 1, "counted, not silently dropped");
});

test("rows that all belong to other people read as 'nothing about you', not 'nothing found'", () => {
  const r = buildReport(JANE, [db("X", "", { Email: "other@example.com", Password: "x" })]);
  assert.equal(r.verdict, "clear");
  assert.match(headline(r), /belonged to someone else/);
});

test("the identity consolidates only the subject's own rows, citing each database", () => {
  const r = buildReport(JANE, [
    db("Dump A", "", { Email: "jane.doe@example.com", FullName: "Jane Doe", Phone: "+33600000000" }),
    db("Dump B", "", { Email: "jane.doe@example.com", FullName: "Jane Doe" }),
    db("Dump C", "", { Email: "intruder@example.com", FullName: "Someone Else" }),
  ]);
  assert.equal(r.identity.facets.name!.length, 1);
  assert.deepEqual(r.identity.facets.name![0].sources, ["Dump A", "Dump B"], "Dump C is not hers");
  assert.equal(r.identity.corroboration.databases, 2);
  assert.match(r.summary, /^Jane Doe/);
});

// ---- a name search: the case where merging would be a fabrication --------------------

const MUSK = buildSubject("Elon Reeve Musk");

test("a name search groups into candidates and never merges them into one person", () => {
  // A name matched three rows and the report rendered them as one man holding three
  // mailboxes. A name identifies nobody, so a full hit on it is one CANDIDATE among the
  // people who share it, kept apart, but kept.
  const r = buildReport(MUSK, [
    db("Dump A", "", { FullName: "Elon Reeve Musk", Email: "elon@example.com" }),
    db("Dump B", "", { FullName: "Kimbal Musk", Email: "kimbal@example.com" }),
  ]);
  assert.deepEqual(r.identity.facets, {}, "nothing is merged into a single subject");
  assert.equal(r.candidates.length, 1, "the full-name match is a candidate");
  assert.equal(r.candidates[0].anchor, "elon@example.com");
  assert.equal(r.others.length, 1, "the shared surname is somebody else");
  assert.equal(r.others[0].anchor, "kimbal@example.com");
  assert.match(r.summary, /does not identify one person/);
});

test("a name search still reports WHAT LEAKED, the bank details are not hidden", () => {
  // The over-correction this pins: refusing to merge a name was implemented by filing
  // every row away behind a collapsed panel, so a search returning an IBAN and a RIB
  // rendered as "clear · 0 data points". Hiding what was found is not more careful than
  // overstating it.
  const r = buildReport(MUSK, [
    db("Bank 2023", "In 2023 a bank dump appeared.", {
      FullName: "Elon Reeve Musk", IBAN: "FR7630006000011234567890189",
      Address: "3500 Deer Creek Rd", City: "Palo Alto", Password: "x",
    }),
  ]);
  assert.notEqual(r.verdict, "clear", "an IBAN is not a clean bill of health");
  assert.ok(r.dataPoints > 0);
  assert.equal(r.highlights.financial.length, 1, "the IBAN is pulled to the top");
  assert.ok(cat(r, "location"), "the postal address is reported");
  assert.equal(r.breachCount, 1);
});

test("an email search DOES consolidate, it designates somebody", () => {
  const r = buildReport(JANE, [
    db("Dump A", "", { Email: "jane.doe@example.com", FullName: "Jane Doe" }),
    db("Dump B", "", { Email: "jane.doe@example.com", FullName: "Jane Doe" }),
  ]);
  assert.equal(r.identity.facets.name!.length, 1);
  assert.equal(r.identity.facets.name![0].sources.length, 2);
});

test("the headline states what leaked AND that it is not one person", () => {
  const r = buildReport(MUSK, [
    db("A", "", { FullName: "Elon Reeve Musk", Password: "x" }),
    db("B", "", { FullName: "Kimbal Musk", Email: "k@x.com" }),
    db("C", "", { FullName: "Maye Musk", Email: "m@x.com" }),
  ]);
  const h = headline(r);
  assert.match(h, /leaked data point/, "it says what was found");
  assert.match(h, /candidate record/, "and that the rows are not one person");
  assert.match(h, /a name does not identify one person/);
});

test("nothing attributable is dropped, the raw rows are kept verbatim", () => {
  const row = { FullName: "Elon Reeve Musk", LastLogin: "2021-09-30", InternalFlag: "A7" };
  const r = buildReport(MUSK, [db("X", "", row)]);
  assert.equal(r.records.length, 1);
  assert.deepEqual(r.records[0].rows[0], row, "the row survives exactly as it arrived");
  // even the activity timestamp the categories drop as metadata is still readable
  assert.ok(Object.keys(r.records[0].rows[0]).includes("LastLogin"));
});

test("a name is marked as not designating one person, so the UI cannot imply it does", () => {
  const r = buildReport(MUSK, []);
  assert.equal(r.subject.unique, false);
  assert.equal(buildReport(JANE, []).subject.unique, true);
});

// ---- activity metadata is not an exposure -------------------------------------------
// "LastLogin" contains "login", so the column that says WHEN an account was used was
// being read as the login itself and shown to the reader as a leaked detail.

test("activity timestamps are metadata, whatever the dump calls them", () => {
  const r = buildReport(JANE, [
    db("X", "", {
      Email: "jane.doe@example.com",
      LastActive: "2015-01-01", LastLogin: "2016-02-02", LastSeen: "2017-03-03",
      RegistrationDate: "2014-01-23", SignUp: "2014-01-23", created_at: "2014-01-23",
      updated_at: "2020-01-01", JoinedAt: "2014-01-23",
    }),
  ]);
  assert.equal(r.dataPoints, 1, "only the address leaked; the rest is account history");
  assert.equal(cat(r, "other"), undefined, "no timestamp lands in Other details");
});

test("a birthday survives the timestamp rule, it is identity, not metadata", () => {
  for (const col of ["BDay", "DateOfBirth", "birth_date", "dob"]) {
    const r = buildReport(JANE, [db("X", "", { Email: "jane.doe@example.com", [col]: "1990-01-01" })]);
    assert.ok(cat(r, "identity"), `${col} must still read as identity`);
  }
});

test("an empty answer from the index is empty, not a finding", () => {
  // "No results found" arrives as a database NAME. parseList skips it, which left the
  // item list empty, which sent the salvage harvester over the payload, and it
  // faithfully turned "No results found. Try changing your request." into a finding.
  const r = buildReport(JANE, []);
  assert.equal(r.dataPoints, 0);
  assert.equal(r.verdict, "clear");
});

test("two different North American numbers are two numbers, not one corroborated one", () => {
  const r = buildReport(JANE, [
    db("A", "", { Email: "jane.doe@example.com", Phone: "+1 212 555 1234" }),
    db("B", "", { Email: "jane.doe@example.com", Phone: "+1 312 555 1234" }),
  ], "US");
  assert.equal(r.identity.facets.phone!.length, 2, "different area codes are different people's lines");
  assert.equal(r.identity.facets.phone!.every((p) => p.sources.length === 1), true, "neither is corroborated");
});

test("one mailbox written two ways is one corroborated address", () => {
  const r = buildReport(buildSubject("johndoe@gmail.com"), [
    db("A", "", { Email: "John.Doe@Gmail.com", FullName: "John Doe" }),
    db("B", "", { Email: "johndoe@gmail.com", FullName: "John Doe" }),
  ]);
  assert.equal(r.identity.facets.email!.length, 1);
  assert.equal(r.identity.facets.email![0].sources.length, 2);
});

test("a non-Latin name survives consolidation", () => {
  // Reducing a name key to [a-z0-9] deleted every Cyrillic, Arabic and CJK name
  // outright, on a source whose strength is Russian-language dumps.
  const r = buildReport(buildSubject("ivan@mail.ru"), [
    db("DumpRU", "", { Email: "ivan@mail.ru", FullName: "Иван Иванов" }),
    db("DumpRU2", "", { Email: "ivan@mail.ru", FullName: "Иван Иванов" }),
  ]);
  assert.equal(r.identity.facets.name![0].value, "Иван Иванов");
  assert.equal(r.identity.facets.name![0].sources.length, 2);
});

test("passwords that are one habit with a rotating suffix are called out as one habit", () => {
  const r = buildReport(JANE, [
    db("A", "", { Email: "jane.doe@example.com", Password: "Kerguelen2019" }),
    db("B", "", { Email: "jane.doe@example.com", Password: "Kerguelen2021" }),
    db("C", "", { Email: "jane.doe@example.com", Password: "Kerguelen2024" }),
  ]);
  assert.equal(r.passwordHabits.length, 1);
  assert.equal(r.passwordHabits[0].values.length, 3);
  // this is the point: changing the newest one changes nothing if the stem is the same
  assert.match(r.passwordHabits[0].stem, /kerguelen/i);
});

test("unrelated passwords are not a habit", () => {
  const r = buildReport(JANE, [
    db("A", "", { Email: "jane.doe@example.com", Password: "xK9#mqz2Lp" }),
    db("B", "", { Email: "jane.doe@example.com", Password: "7vTb!rwQe4" }),
  ]);
  assert.deepEqual(r.passwordHabits, []);
});

// ---- a social network's user ids are not bank cards ---------------------------------
// Reported from a real report: fourteen values from a Facebook dump filed under
// "Bank & financial", at critical severity, under the words "this is what enables
// direct-debit fraud". Two mistakes stacked: Luhn treated as an identity rather than
// a checksum, and a value shape allowed to overrule a column that had already said
// what it was.

test("a column naming a platform is an identifier, whatever its digits look like", () => {
  // this IS a valid test card number, and in a column called Facebook it is an id
  assert.equal(looksFinancial("Facebook", "4111111111111111"), false);
  assert.equal(looksFinancial("uid", "5500005555555559"), false);
  assert.equal(looksFinancial("profile_id", "4111111111111111"), false);
});

test("passing Luhn is not being a card, it is a checksum one number in ten passes", () => {
  let hits = 0;
  for (let i = 0; i < 2000; i++) {
    const id = "1000" + String(Math.floor(Math.random() * 1e11)).padStart(11, "0");
    if (looksFinancial("SomeColumn", id)) hits++;
  }
  assert.equal(hits, 0, "Facebook-shaped ids must never read as cards");
});

test("a number must start like a card somebody could have been issued", () => {
  // correct length, passes Luhn, no issuer on earth starts 9999
  assert.equal(looksFinancial("value", "9999999999999995"), false);
  // right issuer, wrong length for it
  assert.equal(looksFinancial("value", "411111111111111111"), false);
});

test("real cards are still caught, across the issuers", () => {
  for (const [label, card] of [
    ["CardNumber", "4111111111111111"],   // Visa
    ["cc", "5500005555555559"],           // Mastercard
    ["card", "371449635398431"],          // Amex
    ["pan", "6011111111111117"],          // Discover
  ] as const) {
    assert.equal(looksFinancial(label, card), true, `${label} ${card}`);
  }
});

test("an IBAN and a RIB are still financial", () => {
  assert.equal(looksFinancial("IBAN", "FR7630006000011234567890189"), true);
  assert.equal(looksFinancial("RIB", "30004000031234567890143"), true);
});

test("end to end: a Facebook dump produces no bank findings", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    Email: "jane.doe@example.com",
    Facebook: "1000" + String(10000000000 + i * 7919),
  }));
  const r = buildReport(JANE, [db("Facebook 2021", "A scraped Facebook set.", ...rows)]);
  assert.equal(cat(r, "financial"), undefined, "not one of them is a bank detail");
  assert.equal(r.highlights.financial.length, 0);
  assert.ok(cat(r, "online"), "they are online identifiers, which is what they are");
});

// ======================================================================================
// THE PRECEDENCE ITSELF.
//
// The order these rules run in is load-bearing, and while it was implicit it was wrong
// three times in one session, each time producing a confident, alarming, false
// statement. These tests assert the ORDER, not only the outcome, so moving a rule is a
// decision somebody has to make on purpose rather than an accident of editing.
// ======================================================================================

const item = (kind: string, label: string, value: string) => ({ kind: kind as any, label, value });

test("the precedence is what it is, and changing it has to be deliberate", () => {
  assert.deepEqual(precedenceOrder(), [
    "password",        // nothing outranks a leaked secret
    "financial",       // what a person most needs told
    "document",        // the raw material of identity theft
    "identity",        // above the date rule, so a birthday is identity
    "activity-date",   // above every label rule below it, see "LastLogin"
    "location",
    "email",
    "phone",
    "professional",    // above the catch-all, so JobTitle is work
    "online",          // the broadest label rule, so it matches last
    "counters",
  ]);
});

test("REGRESSION: a timestamp is account history, not an online account", () => {
  // "LastLogin" contains "login". The handle rule used to reach it first.
  assert.equal(ruleFor(item("date", "LastLogin", "2021-09-30"))?.id, "activity-date");
  assert.equal(ruleFor(item("date", "LastSeen", "2021-09-30"))?.category, null);
});

test("REGRESSION: a birthday is identity, even though it is also a date", () => {
  assert.equal(ruleFor(item("date", "BDay", "1990-01-01"))?.id, "identity");
  assert.equal(ruleFor(item("date", "DateOfBirth", "1990-01-01"))?.category, "identity");
});

test("REGRESSION: an identifier column beats a card-shaped value", () => {
  // a real test card number, in a column called Facebook, is an id
  assert.equal(ruleFor(item("identifier", "Facebook", "4111111111111111"))?.id, "online");
  // and the same digits in a column that says card are a card
  assert.equal(ruleFor(item("other", "CardNumber", "4111111111111111"))?.id, "financial");
});

test("REGRESSION: BankAccount stays financial despite being typed an identifier", () => {
  // the upstream classifier types it that way for containing the word "account"
  assert.equal(ruleFor(item("identifier", "BankAccount", "FR7630006000011234567890189"))?.id, "financial");
});

test("a password outranks everything, including a card-shaped value", () => {
  assert.equal(ruleFor(item("credential", "Password", "4111111111111111"))?.id, "password");
});

test("JobTitle is work, not a profile, the catch-all must not reach it first", () => {
  assert.equal(ruleFor(item("other", "JobTitle", "Data Engineer"))?.id, "professional");
});

test("a field nothing recognises is still shown, under its own name", () => {
  const r = ruleFor(item("other", "InternalFlag", "A7"));
  assert.equal(r, null, "no rule claims it");
  const rep = buildReport(JANE, [db("X", "", { Email: "jane.doe@example.com", InternalFlag: "A7" })]);
  assert.ok(cat(rep, "other"), "and it lands in Other details rather than being dropped");
});
