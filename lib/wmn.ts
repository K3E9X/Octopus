// WhatsMyName engine — checks a username against the maintained WhatsMyName
// detection ruleset. This is what powers Sherlock/Maigret-style presence discovery,
// and for an ordinary person with no developer account it is the ONLY thing that
// finds them: 718 sites, of which 203 are social, 74 gaming, 50 hobby, 25 shopping.
//
// The ruleset is BUNDLED. It used to be fetched at runtime with a 15-site sample as
// the fallback, so a blocked request silently turned a 700-site sweep into a
// dev-platform check — the exact failure mode that makes this tool useless on a
// normal human. Refresh it with `npm run fetch-wmn`.
//
// Presences found here are flagged `unverified` (detected by URL pattern, not by an
// official API) and scored low downstream — the human confirms. Coverage stays broad
// WITHOUT manufacturing false positives.

import bundled from "./wmn-data.json";
import type { RawProfile } from "./connectors";
import { fetchHTML, noteOutcome, type SourceHealth } from "./netfetch";

interface WmnSite {
  name: string;
  uri_check: string;
  uri_pretty?: string;
  e_code?: number;
  e_string?: string;
  m_code?: number;
  m_string?: string;
  cat?: string;
  valid?: boolean;
}

/** The bundled ruleset. No runtime fetch: coverage cannot depend on one. */
const SITES: WmnSite[] = (((bundled as any).sites || []) as WmnSite[]).filter((x) => x.uri_check);

/** The sweep plan: which sites, in which order. Exported so the ordering — the thing
 *  that decides whether an ordinary person is found — can be asserted, not assumed. */
export function wmnPlan(depth = 200): { name: string; cat: string }[] {
  return [...SITES].sort((a, b) => rank(a) - rank(b)).slice(0, Math.max(1, depth))
    .map((s) => ({ name: s.name, cat: (s.cat || "misc").toLowerCase() }));
}

/** What the analyst is actually sweeping, so a truncated sweep can never look full. */
export function wmnCatalogue(): { total: number; social: number } {
  return { total: SITES.length, social: SITES.filter((s) => /social|hobby|images|music|blog|shopping|dating/.test(s.cat || "")).length };
}

function disc(name: string): string {
  const a = name.replace(/[^A-Za-z0-9]/g, "");
  return (a.slice(0, 2) || "WM").toUpperCase();
}

// Popular / mainstream sites first, so the depth cap always covers where real
// people actually are (not just alphabetical/niche entries).
const POPULAR = [
  "instagram", "tiktok", "twitter", "x", "facebook", "snapchat", "youtube", "pinterest",
  "reddit", "telegram", "spotify", "soundcloud", "steam", "twitch", "github", "gitlab",
  "linktree", "linktr", "patreon", "onlyfans", "medium", "tumblr", "vimeo", "flickr",
  "gravatar", "keybase", "mastodon", "cashapp", "venmo", "paypal", "aboutme", "behance",
  "dribbble", "replit", "kaggle", "chess", "lichess", "strava", "goodreads", "letterboxd",
  "lastfm", "deviantart", "wattpad", "quora", "vk", "discord", "twitch", "ebay", "etsy",
];
/**
 * Exact-name matching, deliberately. This used to be a substring test, and "x" in the
 * list matched every site whose name merely contained the letter — which pulled adult
 * sites and random niche services into the first page of a sweep, spending the depth
 * budget on exactly the wrong places.
 */
const POP_INDEX = new Map(POPULAR.map((n, i) => [n, i]));
function popRank(name: string): number {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return POP_INDEX.get(n) ?? 999;
}

// After the named heavyweights, order by CATEGORY. The depth cap means the tail is
// never reached, so what sits in the first 200 decides whether an ordinary person is
// found at all — and "coding" and "tech" are where they are not.
const CAT_RANK: Record<string, number> = {
  social: 0, images: 1, music: 2, hobby: 3, shopping: 4, dating: 5, blog: 6, video: 7,
  gaming: 8, art: 9, misc: 12, business: 13, finance: 14, health: 15, political: 16,
  news: 17, sport: 18, tech: 20, coding: 22, archived: 26,
};
function rank(s: WmnSite): number {
  const cat = (s.cat || "misc").toLowerCase();
  // adult sites last, always: they are a large slice of the catalogue and would
  // otherwise eat the budget before a single mainstream network is reached
  if (cat.includes("nsfw") || cat.includes("adult")) return 100_000;
  const p = popRank(s.name);
  if (p < 999) return p; // the named heavyweights keep their exact order
  return 1000 + (CAT_RANK[cat] ?? 12) * 10;
}

async function checkSite(site: WmnSite, username: string, health?: SourceHealth): Promise<RawProfile | null> {
  const url = site.uri_check.replace(/\{account\}/g, encodeURIComponent(username));
  // Through lib/netfetch, so a sweep obeys the proxy and the posture. It also lets us
  // separate "this account does not exist" from "this site refused to answer" — the
  // old direct fetch turned every timeout and every 429 into a silent negative.
  const r = await fetchHTML(url, { timeoutMs: 4500, ttlMs: 10 * 60_000 });
  if (r.outcome === "rate-limited" || r.outcome === "blocked-by-policy") {
    let host = "site";
    try { host = new URL(url).host; } catch { /* keep */ }
    if (health) noteOutcome(health, host, r.outcome);
    return null;
  }
  if (r.outcome !== "ok") return null; // 404 / error → treat as absent
  const body = r.data || "";
  const status = r.status ?? 200;
  const eOk = (site.e_code == null || status === site.e_code) && (!site.e_string || body.includes(site.e_string));
  const mHit = (site.m_string ? body.includes(site.m_string) : false) || (site.m_code != null && status === site.m_code);
  if (!eOk || mHit) return null;
  const pretty = (site.uri_pretty || site.uri_check).replace(/\{account\}/g, username);
  let host = "";
  try { host = new URL(pretty).host; } catch { host = "web"; }
  return {
    id: "wmn:" + site.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    platform: site.name.toUpperCase(),
    disc: disc(site.name),
    handle: username,
    url: pretty,
    unverified: true,
    source: `${host} · WhatsMyName (URL pattern)`,
  };
}

async function pool<T, R>(items: T[], limit: number, worker: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx]); } catch { out[idx] = null as R; }
      }
    }),
  );
  return out;
}

/**
 * Scan a username across the WhatsMyName ruleset.
 * `depth` caps how many sites are checked per request (Vercel function time limit);
 * the cap is reported by the caller so coverage is never silently truncated.
 */
export async function scanWmn(
  username: string,
  depth = 120,
  concurrency = 40,
  health?: SourceHealth,
): Promise<{ hits: RawProfile[]; checked: number; total: number }> {
  const ordered = [...SITES].sort((a, b) => rank(a) - rank(b));
  const subset = ordered.slice(0, Math.max(1, depth));
  const results = await pool(subset, concurrency, (s) => checkSite(s, username, health));
  return { hits: results.filter((x): x is RawProfile => x != null), checked: subset.length, total: SITES.length };
}
