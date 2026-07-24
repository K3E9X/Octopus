import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnalytics, faviconHash, faviconUrlFrom, mmh3 } from "../lib/infrapivot.ts";

test("extracts account-scoped analytics identifiers", () => {
  const html = `
    <script>gtag('config','G-ABC12345XY')</script>
    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234"></script>
    <!-- UA-123456-1 -->
    <ins class="adsbygoogle" data-ad-client="ca-pub-1234567890123456"></ins>`;
  const ids = extractAnalytics(html).map((a) => a.id);
  assert.ok(ids.includes("G-ABC12345XY"));
  assert.ok(ids.includes("GTM-ABC1234"));
  assert.ok(ids.includes("UA-123456-1"));
  assert.ok(ids.includes("ca-pub-1234567890123456"));
});

test("does not invent identifiers from ordinary text", () => {
  assert.equal(extractAnalytics("<p>just a normal page about G-force and UA testing</p>").length, 0);
});

test("favicon hash is deterministic and Shodan-shaped (32-bit signed)", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const h1 = faviconHash(bytes), h2 = faviconHash(bytes);
  assert.equal(h1, h2, "must be deterministic");
  assert.ok(Number.isInteger(h1) && h1 >= -2147483648 && h1 <= 2147483647);
  assert.notEqual(faviconHash(new Uint8Array([9, 9, 9])), h1);
});

test("mmh3 matches known vectors", () => {
  assert.equal(mmh3(""), 0);
  assert.equal(mmh3("hello"), 613153351);
});

test("finds the declared favicon, else falls back", () => {
  assert.equal(faviconUrlFrom(`<link rel="icon" href="/static/f.png">`, "https://x.com"), "https://x.com/static/f.png");
  assert.equal(faviconUrlFrom("<html></html>", "https://x.com"), "https://x.com/favicon.ico");
});
