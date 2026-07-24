import { test } from "node:test";
import assert from "node:assert/strict";
import { newHealth, noteOutcome, healthNote } from "../lib/netfetch.ts";

test("health records rate limits and failures separately", () => {
  const h = newHealth();
  noteOutcome(h, "api.github.com", "rate-limited");
  noteOutcome(h, "api.github.com", "rate-limited"); // dedupe
  noteOutcome(h, "gitlab.com", "error");
  noteOutcome(h, "reddit.com", "not-found");       // not a degradation
  assert.deepEqual(h.rateLimited, ["api.github.com"]);
  assert.deepEqual(h.failed, ["gitlab.com"]);
});

test("healthNote says INCOMPLETE, never implies a negative result", () => {
  const h = newHealth();
  assert.equal(healthNote(h), "");
  noteOutcome(h, "api.github.com", "rate-limited");
  const note = healthNote(h);
  assert.ok(note.includes("rate-limited"));
  assert.ok(note.includes("incomplete"));
});
