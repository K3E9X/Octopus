import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCombo, breachSignal } from "../lib/breaches.ts";
import {
  harvest, mergeExposure, usableCount, isContentFree, maskPattern,
  exposureSummary, credentialsText, sortExposure, looksMasked,
} from "../lib/exposure.ts";

// ---- combolist parsing ---------------------------------------------------------

test("a combolist line splits on the LAST colon, not the first", () => {
  // an email local part may legally contain ':' and passwords very often do; splitting
  // on the first separator silently truncates the secret and nobody notices
  assert.deepEqual(splitCombo("marie@acme.fr:Soleil2019!"), { login: "marie@acme.fr", secret: "Soleil2019!" });
  assert.deepEqual(splitCombo("user:name@acme.fr:pa:ss"), { login: "user:name@acme.fr:pa", secret: "ss" });
});

test("a line with no usable separator is refused rather than half-parsed", () => {
  assert.equal(splitCombo("justatoken"), null);
  assert.equal(splitCombo(":leading"), null);
  assert.equal(splitCombo("trailing:"), null);
  assert.equal(splitCombo(""), null);
});

// ---- what the real Hudson Rock free tier returns --------------------------------
// These are the shapes observed in a live lookup: masked passwords, masked logins that
// are ADDRESSES not URLs, a masked IP, and rows with nothing left in them at all.

const REAL_MASKED = {
  top_passwords: ["M*********5", "m*****5", "M**********@"],
  top_logins: ["n*********@gmail.com", "_|", "m*******r", "\\***********************_"],
  ip: "129.45.**.**",
  computer_name: "NADOUR Med",
  operating_system: "Windows 10 Enterprise x64",
};

test("values masked down to nothing are dropped, not shown as rows", () => {
  assert.equal(isContentFree("_|"), true);
  assert.equal(isContentFree("\\***********************_"), true);
  assert.equal(isContentFree("M*********5"), false, "a mask still constrains first char and length");
  const values = harvest(REAL_MASKED).map((i) => i.value);
  assert.ok(!values.includes("_|"));
  assert.ok(!values.includes("\\***********************_"));
  assert.ok(values.includes("M*********5"));
});

test("top_logins are identifiers, not services signed into", () => {
  // real payloads put "n****@gmail.com" here. Calling that a service mislabels every row.
  const items = harvest(REAL_MASKED);
  const id = items.find((i) => i.value === "n*********@gmail.com");
  assert.equal(id?.kind, "identifier");
  assert.equal(items.filter((i) => i.kind === "login").length, 0);
});

test("a masked value is flagged and only its surviving characters are claimed", () => {
  assert.equal(looksMasked("129.45.**.**"), true);
  assert.equal(maskPattern("M*********5"), "M5 · 11 chars");
});

test("the summary reports USABLE credentials, not a raw count", () => {
  // three masked passwords is not three credentials, and the old count said it was
  const masked = harvest(REAL_MASKED);
  assert.equal(usableCount(masked).clear, 0);
  assert.equal(usableCount(masked).masked, 3);
  assert.match(exposureSummary(masked), /3 credentials \(masked\)/);
  const clear = harvest({ top_passwords: ["Soleil2019!"] });
  assert.match(exposureSummary(clear), /1 credential in clear/);
});

// ---- merging several sources -----------------------------------------------------

test("a clear value from one source replaces the masked copy from another", () => {
  const merged = mergeExposure([
    { kind: "credential", label: "Top passwords", value: "S**********!", masked: true, source: "hudsonrock" },
    { kind: "credential", label: "Password", value: "Soleil2019!", source: "proxynova" },
  ]);
  const creds = merged.filter((i) => i.kind === "credential");
  assert.equal(creds.length, 2, "different strings stay distinct rows");
  assert.equal(usableCount(merged).clear, 1);
});

test("the same fact from two sources merges into one row crediting both", () => {
  const merged = mergeExposure([
    { kind: "email", label: "Email", value: "m@acme.fr", source: "leakcheck" },
    { kind: "email", label: "Email", value: "m@acme.fr", source: "xposedornot" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "leakcheck · xposedornot");
});

test("clear rows sort above masked rows inside a group", () => {
  const sorted = sortExposure([
    { kind: "credential", label: "a", value: "m****d", masked: true },
    { kind: "credential", label: "b", value: "clear" },
  ]);
  assert.equal(sorted[0].value, "clear");
});

// ---- the node ---------------------------------------------------------------------

test("credentialsText emits login:password when the identity is unambiguous", () => {
  const items = [
    { kind: "identifier" as const, label: "Login", value: "marie@acme.fr" },
    { kind: "credential" as const, label: "Password", value: "Soleil2019!" },
  ];
  assert.equal(credentialsText(items), "marie@acme.fr:Soleil2019!");
});

test("credentialsText never emits a masked secret", () => {
  const items = [
    { kind: "identifier" as const, label: "Login", value: "marie@acme.fr" },
    { kind: "credential" as const, label: "Password", value: "S****!", masked: true },
  ];
  assert.equal(credentialsText(items), "");
});

test("a silent source is reported as silent, never as a clean result", () => {
  const [node] = breachSignal("marie@acme.fr", {
    items: [{ kind: "breach", label: "Breach", value: "Collection #1", source: "xposedornot" }],
    reached: ["xposedornot"], silent: ["proxynova"],
  }, "2026-08-07T00:00:00Z");
  const ev = node.evidence.find((e) => e.name === "Sources that did not answer");
  assert.ok(ev, "a source that did not answer must be named");
  assert.match(ev!.detail, /not a negative result/);
});

test("the node headline distinguishes clear credentials from mere presence", () => {
  const [withCred] = breachSignal("m", {
    items: [{ kind: "credential", label: "Password", value: "Soleil2019!", source: "proxynova" }],
    reached: ["proxynova"], silent: [],
  }, "t");
  assert.equal(withCred.evidence[0].name, "Credentials recovered in clear");
  assert.ok(withCred.evidence[0].detail.includes("Soleil2019!"));

  const [without] = breachSignal("m", {
    items: [{ kind: "breach", label: "Breach", value: "Collection #1", source: "leakcheck" }],
    reached: ["leakcheck"], silent: [],
  }, "t");
  assert.equal(without.evidence[0].name, "Present in breach data");
  assert.match(without.evidence[0].detail, /no source returned a usable credential/);
});

test("no items means no node", () => {
  assert.deepEqual(breachSignal("m", { items: [], reached: [], silent: [] }, "t"), []);
});
