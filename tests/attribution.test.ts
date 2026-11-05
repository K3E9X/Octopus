import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubject, detectKind } from "../lib/subject.ts";
import { attributeRow, containsValue, samePhone } from "../lib/attribution.ts";

// ---- what kind of selector is this ------------------------------------------------

test("each selector kind is recognised for what it is", () => {
  assert.equal(detectKind("john.doe@gmail.com"), "email");
  assert.equal(detectKind("+33 6 12 34 56 78"), "phone");
  assert.equal(detectKind("0612345678"), "phone");
  assert.equal(detectKind("Elon Reeve Musk"), "name");
  assert.equal(detectKind("Jean-Pierre Dupont"), "name");
  assert.equal(detectKind("n0rthwind"), "username");
});

test("only a selector that designates one person is marked unique", () => {
  assert.equal(buildSubject("a@b.com").unique, true);
  assert.equal(buildSubject("+33612345678").unique, true);
  // thousands of people share a name, a name search can never be one person's report
  assert.equal(buildSubject("Elon Reeve Musk").unique, false);
});

// ---- the shapes a dump stores a value in ------------------------------------------

test("a gmail address matches the dotted and tagged spellings of the same mailbox", () => {
  const s = buildSubject("johndoe@gmail.com");
  assert.ok(s.variants.includes("johndoe@gmail.com"));
  const dotted = buildSubject("john.doe+shop@gmail.com");
  assert.ok(dotted.variants.includes("johndoe@gmail.com"), "dots and +tags are the same inbox");
});

test("a dotted local part is NOT collapsed outside gmail, where dots are significant", () => {
  const s = buildSubject("john.doe@protonmail.com");
  assert.ok(!s.variants.includes("johndoe@protonmail.com"));
});

test("a phone is searched in E.164 and matched in every shape a dump holds", () => {
  const s = buildSubject("06 12 34 56 78", { defaultCountry: "FR" });
  assert.equal(s.query, "+33612345678", "E.164 is the key we send");
  assert.ok(s.variants.some((v) => v.replace(/\D/g, "") === "0612345678"), "the national form is still matched");
});

// ---- containment, and the false positives it must refuse --------------------------

test("a value is found when the cell is it, or delimits it", () => {
  assert.equal(containsValue("john@x.com", "john@x.com"), true);
  assert.equal(containsValue("contact: john@x.com (work)", "john@x.com"), true);
  assert.equal(containsValue("JOHN@X.COM", "john@x.com"), true);
});

test("a handle is not found inside a longer word, the whole point of the boundary", () => {
  assert.equal(containsValue("thornbird", "thorn"), false);
  assert.equal(containsValue("thorn_bird", "thorn"), true, "an underscore is a boundary");
  assert.equal(containsValue("my thorn here", "thorn"), true);
});

test("a short value is never matched inside anything", () => {
  assert.equal(containsValue("abcdef", "abc"), false, "three characters cannot be safely found");
});

// ---- phones compare as digits -----------------------------------------------------

test("the same subscriber matches across country-code notations", () => {
  assert.ok(samePhone("0612345678", ["33612345678"]));
  assert.ok(samePhone("+33 6 12 34 56 78", ["33612345678"]));
  assert.ok(samePhone("33612345678", ["33612345678"]));
});

test("a coincidental tail is not a match", () => {
  assert.equal(samePhone("12345678", ["99999995678"]), null, "a short shared tail proves nothing");
});

test("a long numeric field that is not a number is not a phone", () => {
  assert.equal(samePhone("4111111111111111111", ["33612345678"]), null, "too long to be a number");
});

// ---- the verdict on a row ---------------------------------------------------------

const subjEmail = buildSubject("john.doe@gmail.com");

test("a row carrying the address is about the subject, and says which column", () => {
  const m = attributeRow(subjEmail, { Email: "john.doe@gmail.com", Password: "hunter2" });
  assert.equal(m.attribution, "direct");
  assert.equal(m.column, "Email");
});

test("a row the API returned that does not carry the subject is NOT about the subject", () => {
  const m = attributeRow(subjEmail, { Email: "someone.else@gmail.com", FullName: "Someone Else" });
  assert.equal(m.attribution, "none");
});

test("the dotted spelling of a gmail address still attributes", () => {
  const m = attributeRow(buildSubject("johndoe@gmail.com"), { Email: "john.doe@gmail.com" });
  assert.equal(m.attribution, "direct", "same mailbox, different spelling");
});

// ---- the case that makes a name search honest -------------------------------------

const subjName = buildSubject("Elon Reeve Musk");

test("a row carrying the whole name is direct", () => {
  const m = attributeRow(subjName, { FullName: "Elon Reeve Musk", City: "Austin" });
  assert.equal(m.attribution, "direct");
});

test("a name split across first-name and surname columns is still direct", () => {
  const m = attributeRow(subjName, { FirstName: "Elon", MiddleName: "Reeve", LastName: "Musk" });
  assert.equal(m.attribution, "direct", "every word present, just not in one cell");
});

test("a row matching only the surname is a DIFFERENT PERSON until proven otherwise", () => {
  const m = attributeRow(subjName, { FullName: "Kimbal Musk", Email: "k@x.com" });
  assert.equal(m.attribution, "partial", "shares a surname, never merged into the subject");
  assert.deepEqual(m.words, ["musk"]);
});

test("a row matching none of the name is not about anyone we asked for", () => {
  const m = attributeRow(subjName, { FullName: "Jane Smith" });
  assert.equal(m.attribution, "none");
});

// ======================================================================================
// Regressions. Every test below reproduces a defect that shipped, each one a case where
// the tool stated something it could not support, which is the only kind of bug that
// matters here.
// ======================================================================================

test("a bare word is not a unique identifier, a surname is not a handle", () => {
  // "Martin" was read as a handle and marked unique, so every stranger sharing it was
  // merged into one fabricated person holding all their addresses and passwords.
  assert.equal(buildSubject("Martin").unique, false);
  assert.equal(buildSubject("elon").unique, false);
  // something a person actually chose still is
  assert.equal(buildSubject("jdupont_75").unique, true);
  assert.equal(buildSubject("n0rthwind").unique, true);
});

test("an accented name matches its transliterated spelling, both ways", () => {
  // attribution did not fold accents while identity did, so the two halves of the
  // pipeline disagreed and the subject's own row was reported as someone else's
  const accented = buildSubject("Jérôme Dupont");
  assert.equal(attributeRow(accented, { FullName: "Jerome Dupont" }).attribution, "direct");
  const plain = buildSubject("Jerome Dupont");
  assert.equal(attributeRow(plain, { FullName: "Jérôme Dupont" }).attribution, "direct");
});

test("a name is only corroborated by columns that hold names", () => {
  const s = buildSubject("Alexandre Martin");
  // a street and a town containing both words is a different person entirely
  const m = attributeRow(s, { FullName: "Sophie Durand", Address: "12 rue Alexandre Dumas", City: "Martin" });
  assert.notEqual(m.attribution, "direct", "a street name cannot confirm a person");
  // but first-name and surname columns are exactly how a dump stores a name
  const split = attributeRow(s, { FirstName: "Alexandre", LastName: "Martin" });
  assert.equal(split.attribution, "direct");
});

test("a number no library can parse is searched as typed, never invented", () => {
  // "2125551234" read with a French default became "+332125551234", a line nobody
  // owns, and the operator was billed for searching it
  assert.equal(buildSubject("2125551234", { defaultCountry: "FR" }).query, "2125551234");
  assert.equal(buildSubject("1234567", { defaultCountry: "FR" }).query, "1234567");
  // a number that DOES parse is still normalised
  assert.equal(buildSubject("06 12 34 56 78", { defaultCountry: "FR" }).query, "+33612345678");
});

test("a phone behind a label or an unusual separator still matches", () => {
  const s = buildSubject("+33612345678");
  for (const cell of ["Tel: 0612345678", "06/12/34/56/78", "+33 (0)6 12 34 56 78", "0612345678"]) {
    assert.equal(attributeRow(s, { Phone: cell }).attribution, "direct", cell);
  }
});

test("a short tail shared with a much longer number is not a match", () => {
  // nine digits matching the end of an eleven-digit number is attribution by coincidence
  assert.equal(samePhone("125551234", ["99991125551234"]), null);
});
