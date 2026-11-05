import { test } from "node:test";
import assert from "node:assert/strict";
import { VIEWS, VIEW_COUNT, viewCountWord } from "../lib/views.ts";

// There were four claims about how many views a report has, "three views" in the
// report module, "Four ways to read the same facts" on the landing, "three views stay
// mounted" above four mounted divs, and "the three views" in the README, while the
// interface rendered seven. Each was true when written and stale by the next commit.

test("every view has an id, a label and something it answers", () => {
  for (const v of VIEWS) {
    assert.ok(v.id, "id");
    assert.ok(v.label.length > 0, `${v.id} label`);
    assert.ok(v.blurb.length > 20, `${v.id} needs to say what it answers`);
  }
});

test("ids are unique, two tabs sharing one would silently hide a view", () => {
  assert.equal(new Set(VIEWS.map((v) => v.id)).size, VIEWS.length);
});

test("the count is derived, not written down", () => {
  assert.equal(VIEW_COUNT, VIEWS.length);
  assert.equal(viewCountWord(), "seven");
});

test("adding a view changes the word the landing prints", () => {
  // the guarantee this file exists for: the headline cannot go stale on its own
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  assert.equal(viewCountWord(), words[VIEWS.length],
    "if this fails, the landing is about to claim a number it does not have");
});

test("the subject view comes first, it is the answer, the rest are readings of it", () => {
  assert.equal(VIEWS[0].id, "identity");
});

test("records comes last: everything above it judges, and it does not", () => {
  assert.equal(VIEWS[VIEWS.length - 1].id, "records");
});
