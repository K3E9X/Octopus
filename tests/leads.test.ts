import { test } from "node:test";
import assert from "node:assert/strict";
import { leadsFrom, leadPlan } from "../lib/leads.ts";
import { reuseStrength, reuseLinks, reuseRejections } from "../lib/reuse.ts";
import { nodesFromExposure, applyReuse } from "../lib/leaknodes.ts";
import type { ExposureItem } from "../lib/exposure.ts";
import type { Signal } from "../lib/signals.ts";

// ---- leads ------------------------------------------------------------------------

const EXP: ExposureItem[] = [
  { kind: "credential", label: "Password", value: "Soleil2019!", source: "proxynova" },
  { kind: "identifier", label: "Login", value: "marie.dubois@acme-corp.fr", source: "proxynova" },
  { kind: "identifier", label: "Login", value: "mdub_92", source: "proxynova" },
  { kind: "email", label: "Address", value: "marie.perso@gmail.com", source: "leakcheck" },
  { kind: "login", label: "Service", value: "https://vpn.acme-corp.fr/portal", source: "hudsonrock" },
  { kind: "login", label: "Service", value: "https://paypal.com/signin", source: "hudsonrock" },
  { kind: "ip", label: "Ip", value: "88.12.4.9", source: "hudsonrock" },
  { kind: "machine", label: "Operating system", value: "Windows 10", source: "hudsonrock" },
];

test("a recovered address becomes a lead, ranked above infrastructure", () => {
  const leads = leadsFrom(EXP, "mnadour");
  assert.equal(leads[0].kind, "email");
  const kinds = leads.map((l) => l.kind);
  assert.ok(kinds.indexOf("email") < kinds.indexOf("ip"), "an address outranks an IP");
});

test("a recovered login becomes a username lead", () => {
  const leads = leadsFrom(EXP, "mnadour");
  assert.ok(leads.some((l) => l.kind === "username" && l.value === "mdub_92"));
});

test("a masked value is never a lead — it cannot be queried", () => {
  const leads = leadsFrom([{ kind: "email", label: "Address", value: "n*****@gmail.com", masked: true }], "x");
  assert.deepEqual(leads, []);
});

test("the seed is not chased again", () => {
  const leads = leadsFrom(EXP, "marie.perso@gmail.com");
  assert.ok(!leads.some((l) => l.value === "marie.perso@gmail.com"), "re-scanning the seed burns the budget going nowhere");
});

test("selectors already on the graph are not chased again", () => {
  const leads = leadsFrom(EXP, "x", ["mdub_92"]);
  assert.ok(!leads.some((l) => l.value === "mdub_92"));
});

test("a freemail host is not a domain lead, a corporate one is", () => {
  const doms = leadsFrom(EXP, "x").filter((l) => l.kind === "domain").map((l) => l.value);
  assert.ok(doms.includes("acme-corp.fr"), "the employer behind a work address is a finding");
  assert.ok(!doms.includes("gmail.com"), "a freemail host names no employer");
});

test("a platform host is not enriched — the victim used it, they do not own it", () => {
  const doms = leadsFrom(EXP, "x").filter((l) => l.kind === "domain").map((l) => l.value);
  assert.ok(!doms.includes("paypal.com"), "enriching PayPal spends the budget on a registrar record for PayPal");
});

test("the plan is bounded and says what it deferred", () => {
  const leads = leadsFrom(EXP, "x");
  const { run, deferred } = leadPlan(leads, 2);
  assert.equal(run.length, 2);
  assert.equal(run.length + deferred.length, leads.length, "nothing is silently dropped");
});

// ---- credential reuse --------------------------------------------------------------

test("a common password is REFUSED as a link, not merely weakened", () => {
  for (const pw of ["123456", "password", "azerty", "qwerty123", "motdepasse"]) {
    const v = reuseStrength(pw);
    assert.equal(v.linkable, false, `${pw} must not link two people`);
    assert.equal(v.strength, 0);
  }
});

test("all-digit and repeated-character secrets are refused", () => {
  assert.equal(reuseStrength("19870412").linkable, false);
  assert.equal(reuseStrength("aaaaaaaaaa").linkable, false);
});

test("an improbable secret links, and scores on length and character classes", () => {
  const weak = reuseStrength("Tr0ub4dor");
  const strong = reuseStrength("Tr0ub4dor&3-correct-horse");
  assert.equal(weak.linkable, true);
  assert.ok(strong.strength > weak.strength, "a longer, richer secret is a stronger coincidence");
});

test("the same improbable password across two logins links those identities", () => {
  const items: ExposureItem[] = [
    { kind: "record", label: "COMB", value: "marie.dubois@acme-corp.fr:Xk9!vaLoire2019", source: "proxynova" },
    { kind: "record", label: "COMB", value: "mdub_92:Xk9!vaLoire2019", source: "proxynova" },
  ];
  const links = reuseLinks(items);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].a, links[0].b].sort(), ["marie.dubois@acme-corp.fr", "mdub_92"]);
  assert.ok(links[0].strength > 50);
});

test("the same COMMON password across two logins produces no link but IS reported", () => {
  const items: ExposureItem[] = [
    { kind: "record", label: "COMB", value: "alice@a.fr:123456" },
    { kind: "record", label: "COMB", value: "bob@b.fr:123456" },
  ];
  assert.deepEqual(reuseLinks(items), []);
  const rej = reuseRejections(items);
  assert.equal(rej.length, 1);
  assert.match(rej[0].detail, /proves nothing/);
});

test("a login and a secret from DIFFERENT lines are never paired", () => {
  // the association is only observed inside one dump line; pairing across lines
  // would be inventing evidence
  const items: ExposureItem[] = [
    { kind: "identifier", label: "Login", value: "alice@a.fr" },
    { kind: "credential", label: "Password", value: "Xk9!vaLoire2019" },
  ];
  assert.deepEqual(reuseLinks(items), []);
});

// ---- exposure becomes graph ---------------------------------------------------------

test("recovered selectors become nodes hanging off the leak that produced them", () => {
  const { nodes } = nodesFromExposure("leak1", EXP, "mnadour");
  const mail = nodes.find((n) => n.handle === "marie.perso@gmail.com");
  assert.ok(mail, "a recovered address must become a node the resolver can see");
  assert.equal(mail!.kind, "email");
  assert.deepEqual(mail!.linkedIds, ["leak1"]);
  assert.ok(nodes.some((n) => n.kind === "alias" && n.handle === "mdub_92"));
  assert.ok(nodes.some((n) => n.kind === "domain" && n.handle === "acme-corp.fr"));
});

test("a recovered node states it is a lead, not an established link", () => {
  const { nodes } = nodesFromExposure("leak1", EXP, "mnadour");
  const mail = nodes.find((n) => n.kind === "email")!;
  assert.match(mail.evidence[0].detail, /a lead, not an established link/);
  assert.ok(mail.confidence < 70, "a dump neighbour is not a confirmed identity");
});

test("applyReuse links the two nodes and writes the finding on both", () => {
  const items: ExposureItem[] = [
    { kind: "record", label: "COMB", value: "marie.dubois@acme-corp.fr:Xk9!vaLoire2019" },
    { kind: "record", label: "COMB", value: "mdub_92:Xk9!vaLoire2019" },
  ];
  const signals: Signal[] = [
    { id: "n1", platform: "EMAIL", handle: "marie.dubois@acme-corp.fr", disc: "EM", confidence: 60, status: "review", evidence: [] },
    { id: "n2", platform: "ALIAS", handle: "mdub_92", disc: "AL", confidence: 52, status: "review", evidence: [] },
    { id: "leak1", platform: "BREACH DATA", handle: "x", disc: "BR", confidence: 50, status: "review", evidence: [] },
  ];
  assert.equal(applyReuse(signals, items, "leak1"), 1);
  assert.ok(signals[0].linkedIds?.includes("n2"));
  assert.ok(signals[1].linkedIds?.includes("n1"));
  assert.match(signals[0].evidence[0].detail, /asserts one PERSON, not one account/);
});

test("a refused reuse is written onto the leak node so the analyst is told", () => {
  const items: ExposureItem[] = [
    { kind: "record", label: "COMB", value: "alice@a.fr:123456" },
    { kind: "record", label: "COMB", value: "bob@b.fr:123456" },
  ];
  const signals: Signal[] = [
    { id: "leak1", platform: "BREACH DATA", handle: "x", disc: "BR", confidence: 50, status: "review", evidence: [] },
  ];
  applyReuse(signals, items, "leak1");
  assert.ok(signals[0].evidence.some((e) => e.name === "Shared password REFUSED as a link"));
});
