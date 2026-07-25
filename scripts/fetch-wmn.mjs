// Refresh the bundled WhatsMyName ruleset.
//
// The dataset is BUNDLED, not fetched at runtime: coverage must not depend on a
// network call that can fail. It used to, and the fallback was a 15-site sample —
// so a blocked request silently turned a 700-site sweep into a dev-platform check,
// which is exactly wrong for an ordinary person with no GitHub account.
//
//   node scripts/fetch-wmn.mjs

import { writeFileSync } from "node:fs";

const URL_ = "https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json";
const OUT = new URL("../lib/wmn-data.json", import.meta.url);

const res = await fetch(URL_);
if (!res.ok) { console.error("fetch failed:", res.status); process.exit(1); }
const raw = await res.json();
const sites = (raw.sites || []).filter((s) => s.valid !== false && s.uri_check);

// keep only the fields the engine reads — a third of the bytes, none of the meaning
const slim = sites.map((s) => {
  const o = { name: s.name, uri_check: s.uri_check, cat: s.cat || "misc" };
  if (s.uri_pretty) o.uri_pretty = s.uri_pretty;
  for (const k of ["e_code", "e_string", "m_code", "m_string"]) if (s[k] != null) o[k] = s[k];
  return o;
});

writeFileSync(OUT, JSON.stringify({ license: raw.license, authors: raw.authors, sites: slim }));
const cats = {};
for (const s of slim) cats[s.cat] = (cats[s.cat] || 0) + 1;
console.log(`wrote ${slim.length} sites`);
console.log(Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c}:${n}`).join("  "));
