import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, headline } from "../lib/selfcheck.ts";
import { identifierChannel, normalizeIdentifier, issueChallenge, checkCode, newCode } from "../lib/ownership.ts";
import type { ExposureItem } from "../lib/exposure.ts";

const src = "leakosint · Collection #1";
const E = (kind: string, label: string, value: string, masked?: boolean): ExposureItem =>
  ({ kind: kind as any, label, value, source: src, masked });

// ---- categorisation ------------------------------------------------------------------

test("fields land in the category the owner would expect", () => {
  const r = buildReport("me@acme.fr", [
    E("credential", "Password", "Kerguelen#88z"),
    E("email", "Email", "me@acme.fr"),
    E("phone", "Phone", "+33612345678"),
    E("identifier", "NickName", "mdub_92"),
    E("address", "City", "Lyon"),
    E("document", "Passport", "12AB34567"),
  ], [{ name: "Collection #1", info: "x" }]);
  const cats = Object.fromEntries(r.categories.map((c) => [c.category, c.findings.map((f) => f.value)]));
  assert.deepEqual(cats.password, ["Kerguelen#88z"]);
  assert.deepEqual(cats.email, ["me@acme.fr"]);
  assert.deepEqual(cats.phone, ["+33612345678"]);
  assert.deepEqual(cats.login, ["mdub_92"]);
  assert.deepEqual(cats.address, ["Lyon"]);
  assert.deepEqual(cats.document, ["12AB34567"]);
});

test("a RIB, an IBAN and a card are recognised as financial — the thing people most need told", () => {
  const r = buildReport("me@acme.fr", [
    E("other", "RIB", "30004000031234567890143"),           // 23-digit French RIB
    E("other", "iban", "FR7630006000011234567890189"),       // IBAN
    E("other", "card", "4111111111111111"),                  // Luhn-valid card
    E("other", "note", "just a comment"),                    // not financial
  ], []);
  const fin = r.categories.find((c) => c.category === "financial");
  assert.ok(fin, "financial category must exist");
  assert.equal(fin!.distinct, 3);
  assert.equal(fin!.severity, "critical");
  assert.ok(r.categories.find((c) => c.category === "other"), "the plain note stays 'other'");
});

test("the same password in ten rows is one exposure, not ten", () => {
  const items = Array.from({ length: 10 }, () => E("credential", "Password", "Kerguelen#88z"));
  const r = buildReport("x", items, []);
  assert.equal(r.categories[0].distinct, 1);
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

test("breach-description, record and date rows never become findings", () => {
  const r = buildReport("x", [
    E("breach", "Collection #1", "2019 aggregation"),
    E("record", "Row", "a@b.fr:pw"),
    E("date", "Date", "2019-01-01"),
    E("email", "Email", "a@b.fr"),
  ], []);
  assert.equal(r.dataPoints, 1, "only the email counts");
});

test("a masked value stays masked in the report", () => {
  const r = buildReport("x", [E("credential", "Password", "Ker****z", true)], []);
  assert.equal(r.categories[0].findings[0].masked, true);
});

// ---- ownership proof -----------------------------------------------------------------

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
