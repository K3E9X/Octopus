import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordProblem, strength, STRENGTH_LABEL } from "../lib/pwrule.ts";
import { passwordProblem as serverRule } from "../lib/auth.ts";

// The whole reason lib/pwrule exists: the Access meter and the server must never
// disagree about what is acceptable. If they drift, someone types a passphrase the
// meter calls "descending", submits, and gets rejected with no idea why.
test("the client and the server enforce the SAME rule", () => {
  for (const pw of ["", "abc", "abcdefgh1", "abcdefghij", "abcdefghi1", "Kerguelen#88z", "0123456789", "abcdefghijkl"]) {
    assert.equal(passwordProblem(pw), serverRule(pw), `disagreement on ${JSON.stringify(pw)}`);
  }
});

test("the rule names what is missing rather than just refusing", () => {
  assert.match(passwordProblem("short1")!, /at least 10 characters/);
  assert.match(passwordProblem("abcdefghijkl")!, /letters and at least one digit/);
  assert.match(passwordProblem("0123456789")!, /letters and at least one digit/);
  assert.equal(passwordProblem("abcdefghi1"), null);
});

test("every strength score has a label — a non-empty passphrase never renders blank", () => {
  for (let s = 0; s <= 4; s++) assert.ok(STRENGTH_LABEL[s]?.length > 0, `score ${s} has no label`);
});

test("strength rises with length and variety, and is capped", () => {
  assert.ok(strength("Kerguelen#88z!x") > strength("abcdefgh1"));
  assert.ok(strength("abcdefgh1") > strength("abc"));
  assert.equal(strength("Kerguelen#88z!xxxxxx"), 4);
});
