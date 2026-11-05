import { test } from "node:test";
import assert from "node:assert/strict";
import { outranks, isAtLeast, adminGrantCap } from "../lib/auth.ts";
import { canonicalEmail } from "../lib/emailkey.ts";

// ---- seniority -------------------------------------------------------------------
// The one line this model exists for: whoever spends money cannot mint it. An audit
// trail signed by somebody who can also create the budget proves nothing.

test("the ladder runs owner → admin → analyst → tester → disabled", () => {
  assert.equal(outranks("owner", "admin"), true);
  assert.equal(outranks("admin", "analyst"), true);
  assert.equal(outranks("analyst", "tester"), true);
  assert.equal(outranks("tester", "disabled"), true);
});

test("nobody outranks their own level — which is what stops self-promotion", () => {
  assert.equal(outranks("admin", "admin"), false);
  assert.equal(outranks("admin", "owner"), false);
  assert.equal(outranks("owner", "owner"), false);
});

test("an owner passes an admin gate; an analyst does not", () => {
  assert.equal(isAtLeast("owner", "admin"), true);
  assert.equal(isAtLeast("admin", "admin"), true);
  assert.equal(isAtLeast("analyst", "admin"), false);
  assert.equal(isAtLeast("tester", "admin"), false);
});

test("the admin grant cap is bounded and falls back on junk", () => {
  const before = process.env.OCTOPUS_ADMIN_GRANT_MAX;
  try {
    for (const [v, want] of [["1000", 1000], ["", 500], ["abc", 500], ["-5", 500], ["0", 500]] as const) {
      process.env.OCTOPUS_ADMIN_GRANT_MAX = v;
      assert.equal(adminGrantCap(), want, `cap for ${JSON.stringify(v)}`);
    }
  } finally {
    if (before === undefined) delete process.env.OCTOPUS_ADMIN_GRANT_MAX;
    else process.env.OCTOPUS_ADMIN_GRANT_MAX = before;
  }
});

// ---- one mailbox, one account ------------------------------------------------------
// Four spellings of one inbox were four accounts and four free trials, scripted in
// about a tenth of a second, each one spending the operator's own upstream balance.

test("a +tag is a tag everywhere", () => {
  assert.equal(canonicalEmail("victim+1@gmail.com"), "victim@gmail.com");
  assert.equal(canonicalEmail("user+anything@corp.example"), "user@corp.example");
  assert.equal(canonicalEmail("USER+X@Corp.Example"), "user@corp.example");
});

test("a dot is insignificant only at Google", () => {
  assert.equal(canonicalEmail("vic.tim@gmail.com"), "victim@gmail.com");
  assert.equal(canonicalEmail("vic.tim@googlemail.com"), "victim@googlemail.com");
  // elsewhere two dotted spellings can be two real people, and merging them would be
  // a worse failure than the one this prevents
  assert.equal(canonicalEmail("vic.tim@corp.example"), "vic.tim@corp.example");
});

test("four spellings of one inbox reduce to one key", () => {
  const keys = new Set(["victim@gmail.com", "victim+1@gmail.com", "vic.tim@gmail.com", "VICTIM+2@Gmail.com"].map(canonicalEmail));
  assert.equal(keys.size, 1);
});

test("a malformed address is left alone rather than mangled", () => {
  assert.equal(canonicalEmail("notanemail"), "notanemail");
  assert.equal(canonicalEmail("@nolocal.com"), "@nolocal.com");
  assert.equal(canonicalEmail(""), "");
});
