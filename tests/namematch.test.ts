import { test } from "node:test";
import assert from "node:assert/strict";
import { matchName, namePairFromHandle, nameMatchEvidence, foldName, nameParts } from "../lib/namematch.ts";
import { classify } from "../lib/scoring.ts";
import { assessIndependence } from "../lib/lineage.ts";
import { scoreEvidence } from "../lib/scoring.ts";

test("the real case: same surname, different given name, is a CONTRADICTION", () => {
  // marie.dubois@gmail.com → variant "mdubois" → a live GitLab account owned by
  // Matthieu Dubois. The tool used to score that PROBABLE.
  const m = matchName(namePairFromHandle("marie.dubois"), "Matthieu Dubois");
  assert.equal(m.verdict, "conflicts");
  assert.match(m.detail, /matthieu/i);
  const ev = nameMatchEvidence(m, "gitlab.com")!;
  assert.equal(classify(ev.name), "contra", "it must lower the tier, not add to it");
});

test("both parts agreeing is corroboration, never proof", () => {
  const m = matchName(namePairFromHandle("marie.dubois"), "Marie Dubois");
  assert.equal(m.verdict, "agrees");
  const ev = nameMatchEvidence(m, "gitlab.com")!;
  assert.equal(classify(ev.name), "soft", "a name is not an identifier");
});

test("accents and case fold before comparison", () => {
  assert.equal(foldName("Müller-Schmidt"), "muller-schmidt");
  assert.deepEqual(nameParts("Marie   Dubois"), ["marie", "dubois"]);
  assert.equal(matchName(namePairFromHandle("jose.munoz"), "José Muñoz").verdict, "agrees");
});

test("it stays silent whenever a verdict would be a guess", () => {
  const silent = (expected: string, observed: string, why: string) =>
    assert.equal(matchName(namePairFromHandle(expected), observed).verdict, "unknown", why);

  silent("mdubois", "Matthieu Dubois", "an initial + surname says nothing about the given name");
  silent("marie.dubois", "M. Dubois", "an initial is compatible, not contradictory");
  silent("matthieu.dubois", "Matt Dubois", "a diminutive is an abbreviation of the full name");
  silent("christopher.smith", "Chris Smith", "same");
  silent("marie.dubois", "Sophie Martin", "a different surname is a pseudonym, not a conflict");
  silent("marie.dubois", "xX_dark_Xx", "a handle-shaped display name proves nothing");
  assert.equal(matchName(null, "Marie Dubois").verdict, "unknown");
  assert.equal(matchName(namePairFromHandle("marie.dubois"), undefined).verdict, "unknown");
  assert.equal(nameMatchEvidence({ verdict: "unknown", detail: "" }, "src"), null);
});

test("name pairs are only read from handles that carry two words", () => {
  assert.deepEqual(namePairFromHandle("marie.dubois"), { given: "marie", family: "dubois" });
  assert.deepEqual(namePairFromHandle("marie_dubois_87"), { given: "marie", family: "dubois" });
  assert.equal(namePairFromHandle("mariedubois"), null, "one word carries no pair");
  assert.equal(namePairFromHandle("mdubois"), null, "an initial is not a given name");
});

test("avatar presence no longer inflates a guessed handle to PROBABLE", () => {
  // exactly the evidence the false positive carried
  const evidence = [
    { name: "Handle variant (unconfirmed)", source: "gitlab.com" },
    { name: "Public name", source: "gitlab.com" },
    { name: "Avatar present", source: "gitlab.com" },
  ];
  const ind = assessIndependence(evidence);
  assert.equal(ind.independent, 1, "all three were read off one profile page");
  assert.notEqual(scoreEvidence(evidence).tier, "probable");

  // a real image COMPARISON is still an independent observation
  const withMatch = [...evidence, { name: "Matching avatar", source: "phash" }];
  assert.equal(assessIndependence(withMatch).independent, 2);
});
