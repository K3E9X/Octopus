import { test } from "node:test";
import assert from "node:assert/strict";
import { emailShape, handleCandidates, deriveHandle, emailShapeEvidence } from "../lib/emailaddr.ts";
import { usernameVariants } from "../lib/variants.ts";
import { classify } from "../lib/scoring.ts";

test("the dotted local part survives — it is where the recall was being lost", () => {
  // Gmail ignores dots for DELIVERY. That says nothing about the handle the person
  // uses elsewhere, and stripping them destroyed the word boundaries the variant
  // generator needs.
  const cands = handleCandidates("marie.dubois@gmail.com");
  assert.equal(cands[0].handle, "marie.dubois", "the dotted form must be searched first");
  assert.ok(cands.some((c) => c.handle === "mariedubois"), "and the undotted form as well");

  const fromDotted = usernameVariants("marie.dubois", 6).map((v) => v.handle);
  const fromStripped = usernameVariants("mariedubois", 6).map((v) => v.handle);
  for (const expected of ["mariedubois", "marie_dubois", "marie-dubois", "mdubois"]) {
    assert.ok(fromDotted.includes(expected), `dotted form should yield ${expected}`);
  }
  assert.equal(fromStripped.length, 0, "the stripped form yields nothing — that was the bug");
});

test("a +tag is stripped for the handle but kept as its own candidate", () => {
  const s = emailShape("Marie.Dubois+netflix@Gmail.com");
  assert.equal(s.normalized, "marie.dubois+netflix@gmail.com");
  assert.equal(s.base, "marie.dubois");
  assert.equal(s.plusTag, "netflix");
  const cands = handleCandidates("marie.dubois+netflix@gmail.com").map((c) => c.handle);
  assert.equal(cands[0], "marie.dubois");
  assert.ok(cands.includes("marie.dubois+netflix".replace(/[^a-z0-9_.\-]/g, "")));
});

test("a role mailbox produces NO handle candidates at all", () => {
  // contact@ exists, answers, and belongs to an organisation. Deriving a person's
  // handle from it is the single richest source of false positives in email OSINT.
  for (const addr of ["contact@acme-corp.fr", "no.reply@acme-corp.fr", "SUPPORT@acme-corp.fr", "dpo@acme-corp.fr"]) {
    assert.deepEqual(handleCandidates(addr), [], addr + " must not be treated as a person");
    assert.equal(deriveHandle(addr), "");
    assert.equal(emailShape(addr).isRole, true);
  }
  assert.equal(emailShape("marie.dubois@acme-corp.fr").isRole, false);
});

test("freemail and disposable domains are told apart from a real one", () => {
  assert.equal(emailShape("x@gmail.com").isFreemail, true);
  assert.equal(emailShape("x@laposte.net").isFreemail, true);
  assert.equal(emailShape("x@acme-corp.fr").isFreemail, false, "a corporate domain names an employer");
  assert.equal(emailShape("x@yopmail.com").isDisposable, true);
  assert.equal(emailShape("x@mailinator.com").isDisposable, true);
  assert.equal(emailShape("x@acme-corp.fr").isDisposable, false);
});

test("the gravatar hash is the md5 of the normalized address", () => {
  // the well-known test vector: gravatar hashes the trimmed, lowercased address
  assert.equal(
    emailShape("  MyEmailAddress@example.com ").gravatarMd5,
    "0bc83cb571cd1c50ba6f3e8a78ef1346",
  );
});

test("address-shape evidence is scored as CONTRADICTION where it should be", () => {
  const role = emailShapeEvidence(emailShape("contact@acme-corp.fr"), { domain: "acme-corp.fr", mx: true, mxHosts: [], spf: true, dmarc: true });
  const roleEv = role.find((e) => /role mailbox/i.test(e.name))!;
  assert.equal(classify(roleEv.name), "contra", "a role mailbox must lower the tier, not raise it");

  const dead = emailShapeEvidence(emailShape("someone@nowhere.invalid"), { domain: "nowhere.invalid", mx: false, mxHosts: [], spf: false, dmarc: false });
  const deadEv = dead.find((e) => /mail exchanger/i.test(e.name))!;
  assert.equal(classify(deadEv.name), "contra", "an address that cannot receive mail contradicts a live one");

  const alive = emailShapeEvidence(emailShape("marie@acme-corp.fr"), { domain: "acme-corp.fr", mx: true, mxHosts: ["mx.acme-corp.fr"], spf: true, dmarc: false });
  assert.notEqual(classify(alive.find((e) => /accepts mail/i.test(e.name))!.name), "contra");

  const throwaway = emailShapeEvidence(emailShape("x@yopmail.com"), { domain: "yopmail.com", mx: true, mxHosts: [], spf: false, dmarc: false });
  assert.equal(classify(throwaway.find((e) => /disposable/i.test(e.name))!.name), "weak");
});

test("candidates are bounded, deduped and reject junk", () => {
  assert.ok(handleCandidates("marie.dubois+a+b@gmail.com").length <= 3);
  // no dot means no second candidate — nothing invented
  assert.deepEqual(handleCandidates("mariedubois@gmail.com").map((c) => c.handle), ["mariedubois"]);
  assert.deepEqual(handleCandidates("ab@gmail.com"), [], "too short to be a handle");
  assert.deepEqual(handleCandidates("not-an-email"), []);
  for (const c of handleCandidates("marie.dubois@gmail.com")) {
    assert.match(c.handle, /^[a-z0-9_.\-]+$/);
    assert.ok(c.rule.length > 0, "every candidate carries the rule that produced it");
  }
});
