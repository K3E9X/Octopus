import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, describe } from "../lib/identity.ts";
import { phoneKey } from "../lib/phone.ts";
import type { RowSource } from "../lib/identity.ts";

const row = (database: string, items: [string, string, string][]): RowSource => ({
  database,
  items: items.map(([kind, label, value]) => ({ kind: kind as any, label, value })),
});

// ---- the rule: independent dumps agreeing is what makes a value worth more --------

test("a value carried by three dumps outranks one carried by one", () => {
  const id = consolidate([
    row("A", [["email", "Email", "rare@x.com"], ["name", "FullName", "Ada Lovelace"]]),
    row("B", [["name", "name", "Ada Lovelace"]]),
    row("C", [["name", "FullName", "Ada Lovelace"]]),
  ]);
  assert.equal(id.facets.name![0].value, "Ada Lovelace");
  assert.equal(id.facets.name![0].sources.length, 3);
  assert.equal(id.facets.email![0].sources.length, 1);
});

test("corroboration counts facets confirmed by more than one database, not a percentage", () => {
  const id = consolidate([
    row("A", [["name", "FullName", "Ada Lovelace"], ["phone", "Phone", "+33612345678"]]),
    row("B", [["name", "name", "Ada Lovelace"]]),
  ]);
  assert.equal(id.corroboration.databases, 2);
  assert.equal(id.corroboration.facets, 2, "a name and a phone");
  assert.equal(id.corroboration.corroborated, 1, "only the name is in two dumps");
});

// ---- the same fact written differently is one fact --------------------------------

test("accents do not split a name into two findings", () => {
  const id = consolidate([
    row("A", [["name", "FullName", "Jérôme Durand"]]),
    row("B", [["name", "name", "Jerome Durand"]]),
  ]);
  assert.equal(id.facets.name!.length, 1, "one person, one name");
  assert.equal(id.facets.name![0].sources.length, 2);
  assert.ok(id.facets.name![0].variants?.includes("Jérôme Durand"), "the other spelling is kept, not lost");
});

test("the same number written three ways consolidates, the trunk-prefix case", () => {
  const id = consolidate([
    row("A", [["phone", "Phone", "+33612345678"]]),
    row("B", [["phone", "Mobile", "06 12 34 56 78"]]),
    row("C", [["phone", "tel", "0612345678"]]),
  ]);
  assert.equal(id.facets.phone!.length, 1, "one subscriber");
  assert.equal(id.facets.phone![0].sources.length, 3);
});

test("the phone key is the national significant number, so notation cannot split it", () => {
  assert.equal(phoneKey("+33612345678"), phoneKey("0612345678"));
  assert.equal(phoneKey("+33 6 12 34 56 78"), phoneKey("33612345678"));
  assert.notEqual(phoneKey("+33612345678"), phoneKey("+33687654321"));
});

// ---- what must NOT count as corroboration -----------------------------------------

test("a value repeated inside one row is one observation, not several", () => {
  const id = consolidate([
    row("A", [["email", "Email", "a@x.com"], ["email", "AltEmail", "a@x.com"], ["email", "Login", "a@x.com"]]),
  ]);
  assert.equal(id.facets.email![0].occurrences, 1, "one row saw it once");
  assert.equal(id.facets.email![0].sources.length, 1);
});

test("repetition inside ONE dump is never corroboration by two", () => {
  const id = consolidate([
    row("A", [["name", "FullName", "Ada Lovelace"]]),
    row("A", [["name", "FullName", "Ada Lovelace"]]),
    row("A", [["name", "FullName", "Ada Lovelace"]]),
  ]);
  assert.equal(id.facets.name![0].sources.length, 1, "three rows, still one source");
  assert.equal(id.corroboration.corroborated, 0);
});

// ---- provenance and masking survive -----------------------------------------------

test("every value names the databases it came from", () => {
  const id = consolidate([
    row("Collection #1", [["email", "Email", "a@x.com"]]),
    row("LinkedIn 2021", [["email", "email", "a@x.com"]]),
  ]);
  assert.deepEqual(id.facets.email![0].sources, ["Collection #1", "LinkedIn 2021"]);
});

test("a masked value stays flagged as masked", () => {
  const id = consolidate([{ database: "A", items: [{ kind: "credential", label: "Password", value: "h****2", masked: true }] }]);
  assert.equal(id.facets.password![0].masked, true);
});

// ---- facets derived from the column name, not just the kind ------------------------

test("a birthday and an employer are their own facets", () => {
  const id = consolidate([
    row("A", [["date", "DateOfBirth", "1990-01-01"], ["other", "CompanyName", "Acme SA"]]),
  ]);
  assert.equal(id.facets.birthdate![0].value, "1990-01-01");
  assert.equal(id.facets.employer![0].value, "Acme SA");
});

// ---- the one-line summary ----------------------------------------------------------

test("the summary leads with the name and states what is corroborated", () => {
  const id = consolidate([
    row("A", [["name", "FullName", "Ada Lovelace"], ["email", "Email", "a@x.com"]]),
    row("B", [["name", "name", "Ada Lovelace"]]),
  ]);
  const line = describe(id);
  assert.match(line, /^Ada Lovelace/);
  assert.match(line, /across 2 databases/);
  assert.match(line, /1 of 2 facets/);
});

test("nothing identifying is said plainly, not dressed up as a result", () => {
  assert.match(describe(consolidate([])), /Nothing consolidated/);
});

test("a platform's internal id is an account id, never a handle", () => {
  // both arrive as kind "identifier"; only the column name still tells them apart
  const rows = [
    { source: "Facebook 2021", items: [
      { kind: "identifier" as const, label: "UID", value: "100008841220", source: "Facebook 2021" },
      { kind: "identifier" as const, label: "Username", value: "lmarchetti", source: "Facebook 2021" },
    ] },
  ];
  const id = consolidate(rows as any);
  assert.deepEqual(id.facets.accountid?.map((v) => v.value), ["100008841220"]);
  assert.deepEqual(id.facets.username?.map((v) => v.value), ["lmarchetti"]);
});
