import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, headline, parseBreachDate, looksFinancial } from "../lib/report.ts";
import { buildSubject } from "../lib/subject.ts";
import type { LeakDatabase } from "../lib/leakosint.ts";

// These tests feed the report RAW ROWS with the dump's own column names, exactly as the
// API returns them, so the whole path is exercised — attribution, column classification,
// consolidation — rather than a convenient fiction half way down it.
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
  // the address is itself a finding, plus the birthday — the two activity dates are not
  assert.equal(r.dataPoints, 2);
});

test("a RIB, an IBAN and a card are all financial — the thing people most need told", () => {
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

test("a name search keeps people who merely share a surname separate", () => {
  const r = buildReport(MUSK, [
    db("Dump A", "", { FullName: "Elon Reeve Musk", Email: "elon@example.com" }),
    db("Dump B", "", { FullName: "Kimbal Musk", Email: "kimbal@example.com" }),
  ]);
  assert.equal(r.identity.facets.email!.length, 1, "only the subject's own address");
  assert.equal(r.identity.facets.email![0].value, "elon@example.com");
  assert.equal(r.others.length, 1, "the other Musk is listed, not merged");
  assert.equal(r.others[0].anchor, "kimbal@example.com");
  assert.deepEqual(r.others[0].matched, ["musk"]);
});

test("the headline says how many other people matched, because that changes how it reads", () => {
  const r = buildReport(MUSK, [
    db("A", "", { FullName: "Elon Reeve Musk", Password: "x" }),
    db("B", "", { FullName: "Kimbal Musk", Email: "k@x.com" }),
    db("C", "", { FullName: "Maye Musk", Email: "m@x.com" }),
  ]);
  assert.match(headline(r), /2 other people matched part of this query/);
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

test("a birthday survives the timestamp rule — it is identity, not metadata", () => {
  for (const col of ["BDay", "DateOfBirth", "birth_date", "dob"]) {
    const r = buildReport(JANE, [db("X", "", { Email: "jane.doe@example.com", [col]: "1990-01-01" })]);
    assert.ok(cat(r, "identity"), `${col} must still read as identity`);
  }
});
