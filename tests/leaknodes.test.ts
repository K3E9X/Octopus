import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../lib/hudsonrock.ts";
import { corpusSignals } from "../lib/corpus.ts";
import { exposureSummary } from "../lib/exposure.ts";

// The defect these lock down: a leak node that reports a compromise EXISTS and throws
// the compromise away. Every assertion here is "the content survived to the node".

const API = "https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-username?username=mnadour";
const DATA = {
  stealers: [
    {
      stealer_family: "RedLine",
      date_compromised: "2022-06-11T00:00:00.000Z",
      computer_name: "NADOUR Med",
      operating_system: "Windows 10 Enterprise x64",
      malware_path: "C:\\Users\\med\\AppData\\Local\\Temp\\setup.exe",
      ip: "197.230.44.12",
      top_logins: ["https://mail.acme.fr/owa/", "https://www.instagram.com/accounts/login/"],
      top_passwords: ["Soleil2019!"],
      total_user_services: 12,
    },
    // a second infection: reading only stealers[0] used to hide this entirely
    { date_compromised: "2023-02-02T00:00:00.000Z", ip: "88.12.4.9", top_logins: ["https://paypal.com/signin"] },
  ],
};

test("the infostealer node carries the credentials that leaked", () => {
  const [node] = build("mnadour", DATA, API);
  const creds = node.exposure!.filter((e) => e.kind === "credential");
  assert.deepEqual(creds.map((c) => c.value), ["Soleil2019!"]);
  const ev = node.evidence.find((e) => e.name === "Credentials exposed");
  assert.ok(ev && ev.detail.includes("Soleil2019!"), "credentials must appear in the evidence too");
});

test("every stealer record is read, not just the first", () => {
  const [node] = build("mnadour", DATA, API);
  const ips = node.exposure!.filter((e) => e.kind === "ip").map((e) => e.value);
  assert.deepEqual(ips.sort(), ["197.230.44.12", "88.12.4.9"]);
  const date = node.evidence.find((e) => e.name === "Compromise date");
  assert.match(date!.detail, /2022-06-11 → 2023-02-02 \(2 events\)/);
});

test("the node links back to the source that produced it", () => {
  const [node] = build("mnadour", DATA, API);
  assert.equal(node.url, API);
  assert.equal(node.evidence[0].url, API);
});

test("each exposed service becomes a pivotable node keeping its full URL", () => {
  const nodes = build("mnadour", DATA, API);
  const paypal = nodes.find((n) => n.platform === "PAYPAL.COM");
  assert.ok(paypal, "a service seen in the logs must become a node");
  assert.equal(paypal!.url, "https://paypal.com/signin", "the full URL, not a bare host");
  assert.equal(paypal!.linkedIds?.[0], nodes[0].id, "and it must hang off the compromise");
});

test("the headline says what was actually recovered", () => {
  const [full] = build("m", DATA, API);
  assert.match(full.evidence[0].detail, /1 credential\(s\) recovered in full/);
  const [thin] = build("m", { stealers: [{ date_compromised: "2020-01-01" }] }, API);
  assert.match(thin.evidence[0].detail, /returned no content/);
});

test("no stealers means no node at all", () => {
  assert.deepEqual(build("m", { stealers: [] }, API), []);
  assert.deepEqual(build("m", {}, API), []);
});

test("a corpus node carries the records, not just a count", () => {
  const hits = [
    { corpus: "collection1", selector: "mnadour", selectorType: "username" as const, content: "mnadour@acme.fr:Soleil2019!", ingestedAt: 1, recordDate: "2019-01-04" },
    { corpus: "collection1", selector: "mnadour", selectorType: "username" as const, content: "mnadour logged in from 10.0.0.9 via https://vpn.acme.fr/portal", ingestedAt: 1 },
  ];
  const [node] = corpusSignals(hits, "2026-08-07T00:00:00Z");
  const exp = node.exposure!;
  assert.ok(exp.some((e) => e.kind === "record" && e.value.includes("Soleil2019!")), "the record itself must be present");
  assert.ok(exp.some((e) => e.kind === "email" && e.value === "mnadour@acme.fr"), "the address must be liftable");
  assert.ok(exp.some((e) => e.kind === "login" && e.value === "https://vpn.acme.fr/portal"), "the URL must be liftable");
  assert.ok(exp.some((e) => e.kind === "ip" && e.value === "10.0.0.9"), "the IP must be liftable");
  const records = node.evidence.find((e) => e.name.startsWith("Records"));
  assert.ok(records && records.detail.includes("Soleil2019!"), "evidence must show a record");
  assert.match(exposureSummary(exp), /credential/);
});

test("a corpus node dates itself from the records", () => {
  const [node] = corpusSignals(
    [{ corpus: "c", selector: "x", selectorType: "username" as const, content: "x:y", ingestedAt: 1, recordDate: "2019-01-04" }],
    "2026-08-07T00:00:00Z",
  );
  assert.equal(node.createdAt, "2019-01-04");
});
