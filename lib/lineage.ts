// Source independence — the quiet way confidence gets inflated.
//
// Corroboration only means something when the corroborating sources are INDEPENDENT.
// Ours frequently are not: Maigret, WhatsMyName and our own connector may all be
// reading the same profile page; aggregators mirror each other; a "declared link" and
// the page it was declared on are one observation, not two. Counting them separately
// turns one fact into three and manufactures a "probable" out of a single sighting.
//
// This module maps each evidence item to its ROOT observation. Corroboration is then
// the number of distinct roots — which is the number of times the world independently
// told us the same thing.

/** Root observation classes. Two evidence items sharing a root are NOT independent. */
export type LineageRoot =
  | "profile-page"     // anything read off the subject's own profile page
  | "declared-link"    // a link the subject published (same page, same act)
  | "image"            // avatar bytes: pHash, EXIF and face all derive from ONE file
  | "registry"         // WHOIS/RDAP/DNS — authoritative registries
  | "breach"           // leak/infostealer corpora
  | "darkweb"          // onion index entries / hidden-service pages
  | "platform-api"     // an official API answering about itself
  | "analyst"          // the human's own attestation
  | "derived"          // computed by us from other evidence (never independent)
  | "content"          // the subject's posts
  | "network"          // follow graph / relationships
  | "temporal";        // activity-time statistics

/**
 * Which root does this evidence come from? Keyed on the evidence NAME and SOURCE we
 * already record, so no collector has to change.
 */
export function lineageOf(name: string, source = ""): LineageRoot {
  const n = name.toLowerCase();
  const s = source.toLowerCase();

  if (/analyst|manual capture|evidence snapshot/.test(n + s)) return "analyst";
  if (/avatar|face|exif|gps in image|camera|photo taken|software/.test(n)) return "image";
  if (/declared|verified account|linked account/.test(n)) return "declared-link";
  // darkweb before breach: onion indexes surface leak-site pages, and an index entry is
  // its own kind of observation — mirrored across every engine that crawled it.
  if (/onion|darkweb|hidden service/.test(n + s)) return "darkweb";
  if (/breach|leak|infostealer|credential exposure|compromis/.test(n + s)) return "breach";
  if (/rdap|whois|registrant|dns|subdomain|mail server|resolves to ip|hosting|certificate/.test(n + s)) return "registry";
  if (/timezone|activity/.test(n)) return "temporal";
  if (/mention|network mapped|shared connection|shared audience|follow/.test(n)) return "network";
  if (/post|content mining|self-reported/.test(n + s)) return "content";
  if (/rarity|convergence|correlation|resolution|deterministic/.test(s)) return "derived";
  if (/public api|official api/.test(s)) return "platform-api";
  return "profile-page";
}

export interface Independence {
  /** distinct root observations — the honest corroboration count */
  independent: number;
  /** raw evidence count, for comparison */
  raw: number;
  roots: LineageRoot[];
  /** true when several evidence items collapse into one observation */
  inflated: boolean;
}

/**
 * Count how many INDEPENDENT observations a body of evidence really represents.
 * "derived" never counts: something we computed from other evidence is not a new
 * sighting, it is a restatement of one we already have.
 */
export function assessIndependence(evidence: { name: string; source?: string }[]): Independence {
  const roots = new Set<LineageRoot>();
  for (const e of evidence) {
    const r = lineageOf(e.name, e.source);
    if (r === "derived") continue;
    roots.add(r);
  }
  const list = [...roots];
  return {
    independent: list.length,
    raw: evidence.length,
    roots: list,
    inflated: evidence.length > list.length + 1,
  };
}

/** Short human note for the inspector when corroboration is weaker than it looks. */
export function independenceNote(ind: Independence): string {
  if (ind.independent === 0) return "No independent observation.";
  if (!ind.inflated) return `${ind.independent} independent observation(s).`;
  return `${ind.raw} evidence items, but only ${ind.independent} INDEPENDENT observation(s) (${ind.roots.join(", ")}) — the rest restate the same source.`;
}
