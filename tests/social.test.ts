import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOG, SOCIAL_CONNECTOR_DEFS } from "../lib/connectors-social.ts";

test("parseOG reads OpenGraph in either attribute order, decodes entities", () => {
  const html = `
    <meta property="og:title" content="Marie Dubois &amp; Co">
    <meta content="Photographer in Lyon" property="og:description">
    <meta name="twitter:title" content="ignored">
    <meta property="og:image" content="https://x/y.jpg">`;
  const og = parseOG(html);
  assert.equal(og.title, "Marie Dubois & Co");
  assert.equal(og.description, "Photographer in Lyon");
  assert.equal(og.image, "https://x/y.jpg");
});

test("parseOG returns empty when there is no profile meta", () => {
  assert.deepEqual(parseOG("<html><body>nothing</body></html>"), { title: undefined, description: undefined, image: undefined });
});

test("the non-dev connector set is registered and broad", () => {
  const ids = SOCIAL_CONNECTOR_DEFS.map((d) => d.id);
  for (const must of ["steam", "telegram", "linktree", "lichess", "roblox", "spotify", "pinterest"]) {
    assert.ok(ids.includes(must), `missing ${must}`);
  }
  assert.ok(ids.length >= 12, `expected a broad set, got ${ids.length}`);
});

test("connectors never throw — they resolve to null when the network is unavailable", async () => {
  for (const d of SOCIAL_CONNECTOR_DEFS.slice(0, 4)) {
    const r = await d.fn("a_user_that_does_not_exist_zzq");
    assert.ok(r === null || typeof r === "object");
  }
});
