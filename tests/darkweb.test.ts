import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isOnion, onionVersion, extractOnions, parseOnionResults, darkwebSignals, onionPageSignals,
  onionEngines, type DarkwebSearch, type OnionResult,
} from "../lib/darkweb";
import { parseSocks, isSocksUrl, addressBlock } from "../lib/socks";
import { transportPolicy } from "../lib/netfetch";
import { torCapable } from "../lib/egress";
import { classify } from "../lib/scoring";
import { lineageOf } from "../lib/lineage";

const V3 = "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion";
const V2 = "expyuzz4wqqyqhjn.onion";

// ---- onion addressing --------------------------------------------------------

test("recognises onion addresses in every form we actually receive", () => {
  assert.equal(isOnion(V3), true);
  assert.equal(isOnion("http://" + V3 + "/search?q=x"), true);
  assert.equal(isOnion("HTTP://" + V3.toUpperCase() + ":8080/"), true);
  assert.equal(isOnion("example.com"), false);
  assert.equal(isOnion("https://notreally.onion.example.com/"), false, "onion must be the TLD, not a label");
  assert.equal(isOnion(""), false);
});

test("distinguishes live v3 from switched-off v2 and from garbage", () => {
  assert.equal(onionVersion(V3), "v3");
  assert.equal(onionVersion("http://" + V2), "v2");
  assert.equal(onionVersion("nope.onion"), "invalid");
  assert.equal(onionVersion("example.com"), "invalid");
});

test("extracts onion addresses out of page text", () => {
  const text = `contact us at http://${V3}/ or the mirror ${V2} — not example.onion`;
  const found = extractOnions(text);
  assert.ok(found.includes(V3));
  assert.ok(found.includes(V2));
  assert.ok(!found.includes("example.onion"));
});

// ---- transport: the OPSEC-critical rules ------------------------------------

test("a .onion request without a SOCKS proxy is REFUSED, not attempted", () => {
  // the failure mode this prevents: the DNS lookup for the address leaks the target
  // to the analyst's resolver before the connection can even fail.
  const v = transportPolicy("http://" + V3 + "/", "");
  assert.equal(v.allowed, false);
  assert.match(v.reason || "", /SOCKS5/);
});

test("an http:// proxy does not unlock .onion — only SOCKS can reach it", () => {
  assert.equal(torCapable("http://127.0.0.1:8080"), false);
  assert.equal(transportPolicy("http://" + V3 + "/", "http://127.0.0.1:8080").allowed, false);
});

test("with a SOCKS proxy, v3 is allowed and dead v2 is still refused", () => {
  assert.equal(transportPolicy("http://" + V3 + "/", "socks5://127.0.0.1:9050").allowed, true);
  const v2 = transportPolicy("http://" + V2 + "/", "socks5://127.0.0.1:9050");
  assert.equal(v2.allowed, false);
  assert.match(v2.reason || "", /2021|v2/);
});

test("clearnet requests are unaffected by the onion rules", () => {
  assert.equal(transportPolicy("https://ahmia.fi/search/?q=x", "").allowed, true);
});

// ---- SOCKS parsing -----------------------------------------------------------

test("parses every SOCKS scheme a Tor setup actually uses", () => {
  assert.equal(isSocksUrl("socks5://127.0.0.1:9050"), true);
  assert.equal(isSocksUrl("socks5h://127.0.0.1:9050"), true);
  assert.equal(isSocksUrl("socks4a://10.0.0.1"), true);
  assert.equal(isSocksUrl("http://127.0.0.1:8080"), false);

  const p = parseSocks("socks5://user:p%40ss@127.0.0.1:9150");
  assert.deepEqual(
    { v: p?.version, h: p?.host, port: p?.port, u: p?.username, pw: p?.password },
    { v: 5, h: "127.0.0.1", port: 9150, u: "user", pw: "p@ss" },
  );
  assert.equal(parseSocks("socks4://10.0.0.1")?.version, 4);
  assert.equal(parseSocks("socks5://10.0.0.1")?.port, 1080, "default SOCKS port");
  assert.equal(parseSocks("http://x")?.host, undefined);
});

test("hostnames go to the proxy as NAMES so DNS never resolves locally", () => {
  // ATYP 0x03 = domain name. This is the difference between "the proxy looks it up"
  // and "our resolver logs the target". .onion has no clearnet DNS at all.
  const named = addressBlock(V3);
  assert.equal(named[0], 0x03);
  assert.equal(named[1], V3.length);
  assert.equal(named.subarray(2).toString("utf8"), V3);

  const ipv4 = addressBlock("127.0.0.1");
  assert.deepEqual([...ipv4], [0x01, 127, 0, 0, 1]);

  const ipv6 = addressBlock("::1");
  assert.equal(ipv6[0], 0x04);
  assert.equal(ipv6.length, 17);
  assert.equal(ipv6[16], 1);
});

// ---- index parsing -----------------------------------------------------------

const AHMIA_HTML = `
<ol class="searchResults">
  <li class="result">
    <h4><a href="/search/redirect?search_term=zulu&redirect_url=http%3A%2F%2F${V3}%2Fprofile">Zulu market profile</a></h4>
    <cite>http://${V3}/profile</cite>
    <p>Vendor page mentioning xk9_zulu_42 and a contact address</p>
  </li>
  <li class="result">
    <h4><a href="/search/redirect?search_term=zulu&redirect_url=http%3A%2F%2F${V2}%2F">Old mirror</a></h4>
    <p>Archived listing, nothing relevant</p>
  </li>
</ol>`;

test("parses index results and flags exact-token matches", () => {
  const rows = parseOnionResults(AHMIA_HTML, "Ahmia", "xk9_zulu_42");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].onion, V3);
  assert.equal(rows[0].url, `http://${V3}/profile`, "the redirect wrapper is unwrapped");
  assert.equal(rows[0].title, "Zulu market profile");
  assert.equal(rows[0].version, "v3");
  assert.equal(rows[0].exact, true);
  assert.equal(rows[1].version, "v2");
  assert.equal(rows[1].exact, false, "no verbatim selector in this entry");
});

test("falls back to raw anchors when an engine changes its markup", () => {
  const html = `<div><a href="http://${V3}/x">Some hidden service</a><a href="https://example.com">not onion</a></div>`;
  const rows = parseOnionResults(html, "Torch", "irrelevant");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onion, V3);
});

test("substring hits are not exact matches", () => {
  // "lyd" inside "lydia" must not be reported as a verbatim hit — that is exactly the
  // kind of evidence that cannot be defended in a report.
  const html = `<div><a href="http://${V3}/">lydiaX vendor</a></div>`;
  assert.equal(parseOnionResults(html, "Ahmia", "lyd")[0].exact, false);
  assert.equal(parseOnionResults(html, "Ahmia", "lydiaX")[0].exact, true);
});

// ---- signals: conservative by construction ----------------------------------

function search(results: OnionResult[]): DarkwebSearch {
  return { results, engines: ["Ahmia"], skipped: [], torCapable: false, note: "n/a" };
}
const hit = (over: Partial<OnionResult> = {}): OnionResult => ({
  onion: V3, url: "http://" + V3 + "/", title: "Vendor page", snippet: "mentions xk9_zulu_42",
  engine: "Ahmia", version: "v3", exact: true, ...over,
});

test("non-exact index hits produce NO nodes at all", () => {
  assert.equal(darkwebSignals(search([hit({ exact: false })]), "xk9_zulu_42", "2026-07-24T00:00:00Z").length, 0);
});

test("an index mention is WEAK and carries its own attribution caveat", () => {
  const [s] = darkwebSignals(search([hit()]), "xk9_zulu_42", "2026-07-24T00:00:00Z");
  assert.equal(s.tier, "weak");
  assert.equal(s.status, "candidate");
  assert.ok(s.confidence < 50, "a darkweb mention must never look like a strong result");
  assert.ok(s.evidence.some((e) => /not established/i.test(e.name)));
  // and the scorer must agree it is weak, not silently promote it
  for (const e of s.evidence) assert.notEqual(classify(e.name), "hard");
});

test("a v2 index entry is labelled historical", () => {
  const [s] = darkwebSignals(search([hit({ onion: V2, version: "v2" })]), "xk9_zulu_42", "2026-07-24T00:00:00Z");
  assert.ok(s.evidence.some((e) => /obsolete/i.test(e.name)));
});

test("a published key block is not scored as a cryptographic link", () => {
  const sigs = onionPageSignals(
    { url: "http://" + V3 + "/", title: "t", text: "", emails: [], onions: [], wallets: ["bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"], pgp: true, handles: [] },
    "2026-07-24T00:00:00Z",
  );
  const key = sigs.find((s) => s.platform === "PGP KEY")!;
  assert.equal(key.tier, "weak");
  // the trap: an evidence name containing "pgp"/"fingerprint" would be classed HARD and
  // the node would jump to VERIFIED off nothing but the presence of a key block.
  for (const e of key.evidence) assert.notEqual(classify(e.name), "hard");
  assert.ok(sigs.some((s) => s.platform === "WALLET"));
});

test("darkweb evidence has its own lineage root — it does not fake corroboration", () => {
  assert.equal(lineageOf("Darkweb mention — presence detected on an indexed hidden service", "onion index · Ahmia"), "darkweb");
});

// ---- engine registry ---------------------------------------------------------

test("onion-only engines are marked as needing Tor, clearnet ones are not", () => {
  const e = onionEngines();
  const ahmia = e.find((x) => x.id === "ahmia")!;
  assert.equal(ahmia.needsTor, false, "darkweb search must work with no Tor installed");
  assert.ok(e.some((x) => x.needsTor), "and must use the onion-only engines when Tor is there");
  for (const eng of e) assert.ok(eng.url.includes("{q}"));
});
