import { test } from "node:test";
import assert from "node:assert/strict";
import { harvest, harvestText, exposureSummary, exposureVerdict, exposureText, sortExposure, humanKey } from "../lib/exposure.ts";

// A stealer record shaped the way these feeds actually come back. The point of these
// tests is the property that matters: nothing in the payload disappears.
const STEALER = {
  stealer_family: "RedLine",
  date_compromised: "2022-06-11T00:00:00.000Z",
  computer_name: "NADOUR Med",
  operating_system: "Windows 10 Enterprise x64",
  malware_path: "C:\\Users\\med\\AppData\\Local\\Temp\\setup.exe",
  ip: "197.230.44.12",
  antiviruses: ["Windows Defender"],
  top_logins: ["https://mail.acme.fr/owa/", "https://www.instagram.com/accounts/login/"],
  top_passwords: ["Soleil2019!", "az****"],
  total_user_services: 12,
  total_corporate_services: 0,
};

test("harvest keeps every substantive field", () => {
  const items = harvest(STEALER);
  const values = items.map((i) => i.value);
  for (const expected of [
    "RedLine", "NADOUR Med", "Windows 10 Enterprise x64", "197.230.44.12",
    "Windows Defender", "Soleil2019!", "https://mail.acme.fr/owa/", "12",
  ]) {
    assert.ok(values.includes(expected), `dropped: ${expected}`);
  }
});

test("credentials are classified as credentials, not buried in 'other'", () => {
  const creds = harvest(STEALER).filter((i) => i.kind === "credential");
  assert.deepEqual(creds.map((c) => c.value).sort(), ["Soleil2019!", "az****"]);
});

test("a value masked by the source is flagged, and the mask is not re-applied", () => {
  const masked = harvest(STEALER).find((i) => i.value === "az****");
  assert.equal(masked?.masked, true);
  const plain = harvest(STEALER).find((i) => i.value === "Soleil2019!");
  assert.equal(plain?.masked, undefined, "an unmasked credential must be shown as-is");
});

test("login URLs keep the full path, not just the host", () => {
  const logins = harvest(STEALER).filter((i) => i.kind === "login");
  assert.ok(logins.some((l) => l.value === "https://mail.acme.fr/owa/"));
  assert.ok(logins.every((l) => l.url === l.value), "a URL item must be openable");
});

// The regression that produced this whole module: a hard-coded field list silently
// stops reporting the day the source renames or adds something.
test("an unknown field is still surfaced rather than dropped", () => {
  const items = harvest({ ...STEALER, some_new_field_2027: "brand new value" });
  const found = items.find((i) => i.value === "brand new value");
  assert.ok(found, "unrecognised fields must survive");
  assert.equal(found!.label, "Some new field 2027");
});

test("zero counts are noise, non-zero counts are findings", () => {
  const items = harvest(STEALER);
  assert.ok(!items.some((i) => i.kind === "count" && i.value === "0"));
  assert.ok(items.some((i) => i.kind === "count" && i.value === "12"));
});

test("empty, null and boolean leaves carry no content and are skipped", () => {
  const items = harvest({ a: "", b: null, c: undefined, d: true, e: "kept" });
  assert.deepEqual(items.map((i) => i.value), ["kept"]);
});

test("nested arrays of objects are walked", () => {
  const items = harvest({ stealers: [{ ip: "1.2.3.4" }, { ip: "5.6.7.8" }] });
  assert.deepEqual(items.filter((i) => i.kind === "ip").map((i) => i.value), ["1.2.3.4", "5.6.7.8"]);
});

test("duplicate values collapse to one row", () => {
  const items = harvest({ a: { ip: "1.2.3.4" }, b: { ip: "1.2.3.4" } });
  assert.equal(items.filter((i) => i.value === "1.2.3.4").length, 1);
});

test("harvestText lifts selectors out of a dumped line and keeps the line itself", () => {
  const items = harvestText(["marie.dubois@gmail.com:Soleil2019!"]);
  const kinds = (k: string) => items.filter((i) => i.kind === k).map((i) => i.value);
  assert.deepEqual(kinds("record"), ["marie.dubois@gmail.com:Soleil2019!"]);
  assert.deepEqual(kinds("email"), ["marie.dubois@gmail.com"]);
  assert.deepEqual(kinds("credential"), ["Soleil2019!"]);
});

test("harvestText pulls URLs and IPs out of a free-text record", () => {
  const items = harvestText(["logged in from 10.0.0.9 at https://vpn.acme.fr/portal today"]);
  assert.ok(items.some((i) => i.kind === "ip" && i.value === "10.0.0.9"));
  assert.ok(items.some((i) => i.kind === "login" && i.value === "https://vpn.acme.fr/portal"));
});

test("a prose line is a record, not a credential", () => {
  const items = harvestText(["hey, call me back tomorrow"]);
  assert.equal(items.filter((i) => i.kind === "credential").length, 0);
  assert.equal(items.filter((i) => i.kind === "record").length, 1);
});

test("sort puts credentials first and 'other' last", () => {
  const sorted = sortExposure(harvest(STEALER));
  assert.equal(sorted[0].kind, "credential");
});

test("the verdict distinguishes recovered from masked from empty", () => {
  assert.match(exposureVerdict(harvest(STEALER)), /1 credential\(s\) recovered in full/);
  assert.match(exposureVerdict(harvest({ pw: "ab****" })), /masked at source/);
  assert.match(exposureVerdict(harvest({ top_logins: ["https://a.fr/"] })), /no credentials returned/);
  assert.match(exposureVerdict(harvest({ date_compromised: "2022-01-01" })), /returned no content/);
  assert.equal(exposureVerdict([]), "confirmed exposure, but this source returned no content");
});

test("the summary counts what is there and says so when nothing is", () => {
  assert.match(exposureSummary(harvest(STEALER)), /credential/);
  assert.equal(exposureSummary([]), "nothing recovered");
});

test("copyable text carries the masking note", () => {
  const text = exposureText(harvest(STEALER));
  assert.ok(text.includes("Soleil2019!"));
  assert.ok(text.includes("[masked at source]"));
});

test("oversized values are truncated, not dropped", () => {
  const items = harvest({ blob: "x".repeat(5000) });
  assert.equal(items.length, 1);
  assert.ok(items[0].value.length < 500);
  assert.ok(items[0].value.endsWith("…"));
});

test("humanKey reads a payload key as a label", () => {
  assert.equal(humanKey("date_compromised"), "Date compromised");
  assert.equal(humanKey("operatingSystem"), "Operating System");
});
