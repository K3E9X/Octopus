import { test } from "node:test";
import assert from "node:assert/strict";
import { usernameVariants, handleParts } from "../lib/variants.ts";

test("handleParts splits separators and camelCase, drops trailing digits", () => {
  assert.deepEqual(handleParts("john_doe"), ["john", "doe"]);
  assert.deepEqual(handleParts("johnDoe"), ["john", "doe"]);
  assert.deepEqual(handleParts("john.doe93"), ["john", "doe"]);
});

test("generates the classic variants, never the original", () => {
  const v = usernameVariants("john_doe").map((x) => x.handle);
  assert.ok(v.includes("johndoe"), "no-separator variant");
  assert.ok(v.includes("john.doe"), "dot variant");
  assert.ok(v.includes("jdoe"), "initial + last");
  assert.ok(!v.includes("john_doe"), "must exclude the original");
});

test("drops trailing digits as a variant", () => {
  const v = usernameVariants("johndoe93").map((x) => x.handle);
  assert.ok(v.includes("johndoe"));
});

test("refuses too-short handles and bounds the count", () => {
  assert.equal(usernameVariants("ab").length, 0);
  assert.ok(usernameVariants("john_doe", 3).length <= 3);
});
