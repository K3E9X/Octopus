import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneKey } from "../lib/phone.ts";

// ---- validity is not identity ------------------------------------------------------

test("a number is matched past its country code even when the range is unassignable", () => {
  // ARCEP reserves 06 39 98 xx xx for fiction, so libphonenumber answers isValid()
  // false, while parsing it to exactly the right E.164. These are one subscriber.
  assert.equal(phoneKey("+33 6 39 98 41 02", "FR"), phoneKey("0639984102", "FR"));
  // Ofcom's drama range, same story
  assert.equal(phoneKey("+44 7700 900123", "GB"), phoneKey("07700 900123", "GB"));
  assert.equal(phoneKey("07700900123", "GB"), phoneKey("07700 900123", "GB"));
});

test("and two different subscribers still do not collide", () => {
  assert.notEqual(phoneKey("+1 212 555 0132", "US"), phoneKey("+1 312 555 0132", "US"));
  assert.notEqual(phoneKey("0639984102", "FR"), phoneKey("0639984103", "FR"));
  // the case that broke the nine-digit reduction this module used to do
  assert.notEqual(phoneKey("+1 212 555 1234", "US"), phoneKey("+1 312 555 1234", "US"));
});

test("junk does not collide with a subscriber, and text keys to nothing", () => {
  // Trusting the parse means the parser now also stamps a region code onto short junk:
  // "12" keys as "+3312". That is harmless, it cannot collide with a real number, and
  // two dumps holding the same junk SHOULD consolidate rather than read as two facts.
  assert.notEqual(phoneKey("12", "FR"), phoneKey("+33 6 39 98 41 02", "FR"));
  assert.equal(phoneKey("abc", "FR"), "");
  assert.equal(phoneKey("", "FR"), "");
});
