// Which services hold this person's data.
//
// The grid of logos is the thing this category is known for, and it is normally built
// by PROBING: ask each site's password-reset endpoint whether the address is
// registered. That answer rots, most of those endpoints are gone or behind a
// challenge, and it was never free.
//
// The breaches already answer a different question, and arguably a better one. A dump
// named "Deezer 2019" is a service, a date, and the fact that this person's record was
// in it. "Registered at Deezer" is a guess about today; "in Deezer's 2019 breach" is
// a fact about a file somebody already has.
//
// ONE DISTINCTION THE PROBING PRODUCTS CANNOT MAKE, and the reason this module is not
// just a string split. Half of what the index returns is not a service at all:
// "Collection #1", "COMB", "AntiPublic" are AGGREGATES, credential lists assembled
// from other breaches, often from sources nobody has ever identified. Rendering those
// as a logo tile would tell somebody they have an account at a company that does not
// exist. They are counted, named and kept, under their own heading, saying what they
// are.

export type SourceKind = "social" | "service" | "aggregate";

/**
 * The social networks, named.
 *
 * They get their own heading because they are what somebody actually scans for, a
 * breach at a bank and a breach at a forum are both "a service", but only one of them
 * is the question being asked when a person looks at this grid. Matching is on the
 * reduced name, so "Facebook 2021" and "facebook" land together.
 *
 * A closed list rather than a guess: a network wrongly filed as an ordinary service is
 * a cosmetic miss, while an ordinary service filed as a social network is a claim
 * about where somebody spends their time.
 */
const SOCIAL = new Set([
  "facebook", "instagram", "twitter", "x", "tiktok", "snapchat", "linkedin", "pinterest",
  "reddit", "tumblr", "vk", "vkontakte", "odnoklassniki", "ok.ru", "weibo", "qq", "wechat",
  "telegram", "whatsapp", "discord", "skype", "viber", "line", "kakaotalk", "signal",
  "myspace", "badoo", "tinder", "grindr", "bumble", "meetic", "okcupid", "plentyoffish", "pof",
  "youtube", "twitch", "flickr", "deviantart", "behance", "dribbble", "soundcloud",
  "last.fm", "lastfm", "mixcloud", "bandcamp", "goodreads", "wattpad", "quora", "medium",
  "nextdoor", "mastodon", "clubhouse", "foursquare", "swarm", "strava", "untappd",
]);

export interface ServiceTile {
  /** the service as a person would name it, "Deezer", not "Deezer 2019" */
  name: string;
  /** the dump names this came from; several years of one service collapse into one tile */
  dumps: string[];
  kind: SourceKind;
  /** earliest and latest year seen, when the dump names or descriptions carry one */
  firstYear?: number;
  lastYear?: number;
  /** how many distinct fields this source exposed about the subject */
  fields: number;
  /** the worst thing it exposed, for the tile's accent */
  severity: "critical" | "high" | "medium" | "low";
}

/**
 * Names that are not companies.
 *
 * A combolist is assembled from other people's breaches; its name describes the file,
 * not an account anybody holds. Matching is on the normalised name so "Collection #2"
 * and "collection 5" land together.
 */
// Written as a prefix match on purpose. A trailing \b after "combo" fails on
// "Combolist", the word boundary is not there, the letter "l" is, and these names
// are compounds far more often than they are standalone words.
const AGGREGATE = /\b(?:collections?|combo\w*|comb\b|compilations?|anti.?public|breach.?comp\w*|cracked|leakbase|stealer\w*|logs?\b|dumps?\b|mix\b|база|сборник)/i;

/** Trailing or embedded edition markers that are not part of the service's name. */
const EDITION = /\s*(?:[#№]\s*\d+|\bv\d+\b|\bpart\s*\d+\b|\b20\d{2}\b|\b19\d{2}\b|\(\s*20\d{2}\s*\)|\[\s*20\d{2}\s*\])\s*/gi;

/** A year anywhere in the dump name or its description. */
function yearIn(text: string): number | undefined {
  const m = String(text || "").match(/\b(19[89]\d|20[0-3]\d)\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * The service a dump belongs to, and whether it is one at all.
 *
 * Deliberately conservative: anything it cannot confidently reduce keeps its full name
 * rather than being trimmed into something that reads like a company. A wrong logo is
 * worse than an unfamiliar string.
 */
export function serviceOf(dumpName: string, info = ""): { name: string; kind: SourceKind; year?: number } {
  const raw = String(dumpName || "").trim();
  const year = yearIn(raw) ?? yearIn(info);
  if (!raw) return { name: "Unnamed source", kind: "aggregate", year };

  if (AGGREGATE.test(raw)) {
    // keep the file's own name, it identifies the list, and nothing else does
    return { name: raw.replace(/\s+/g, " "), kind: "aggregate", year };
  }

  const trimmed = raw.replace(EDITION, " ").replace(/[\s_.-]+$/g, "").replace(/\s+/g, " ").trim();
  // a name reduced to nothing, or to a bare number, was never a service name
  if (!trimmed || /^\d+$/.test(trimmed)) return { name: raw, kind: "aggregate", year };
  const key = trimmed.toLowerCase().replace(/\s+/g, "");
  return { name: trimmed, kind: SOCIAL.has(key) ? "social" : "service", year };
}

const RANK = { critical: 3, high: 2, medium: 1, low: 0 } as const;

export interface SourceLike {
  name: string;
  info: string;
  findings: { value: string; severity: ServiceTile["severity"] }[];
  severity: ServiceTile["severity"];
}

/**
 * Collapse a report's sources into one tile per service.
 *
 * Several dumps of one company, a 2012 breach and a 2019 one, are one tile with a
 * span of years, because the question a reader has is "who holds my data", not "how
 * many files is it spread across". The files are still listed on the tile.
 */
export function serviceGrid(sources: SourceLike[]): ServiceTile[] {
  const by = new Map<string, ServiceTile>();

  for (const s of sources) {
    const { name, kind, year } = serviceOf(s.name, s.info);
    const key = kind + ":" + name.toLowerCase();
    const distinct = new Set(s.findings.map((f) => f.value.toLowerCase())).size;
    const tile = by.get(key);
    if (!tile) {
      by.set(key, {
        name, kind, dumps: [s.name],
        firstYear: year, lastYear: year,
        fields: distinct,
        severity: s.severity,
      });
      continue;
    }
    if (!tile.dumps.includes(s.name)) tile.dumps.push(s.name);
    tile.fields += distinct;
    if (RANK[s.severity] > RANK[tile.severity]) tile.severity = s.severity;
    if (year) {
      tile.firstYear = tile.firstYear ? Math.min(tile.firstYear, year) : year;
      tile.lastYear = tile.lastYear ? Math.max(tile.lastYear, year) : year;
    }
  }

  // Social networks first, they are what somebody scans this grid for, then other
  // services, then the aggregated lists, which are not places anybody has an account.
  // Within each, the source that gave up the most is read first.
  const ORDER: Record<SourceKind, number> = { social: 0, service: 1, aggregate: 2 };
  return [...by.values()].sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] ||
      RANK[b.severity] - RANK[a.severity] ||
      b.fields - a.fields ||
      a.name.localeCompare(b.name),
  );
}

/** One line a reader can take away without opening a tile. */
export function gridSummary(tiles: ServiceTile[]): string {
  if (!tiles.length) return "No source named this subject.";
  const n = (k: SourceKind) => tiles.filter((t) => t.kind === k).length;
  const social = n("social"), services = n("service"), aggregates = n("aggregate");
  const parts: string[] = [];
  if (social) parts.push(`${social} social network${social === 1 ? "" : "s"}`);
  if (services) parts.push(`${services} other service${services === 1 ? "" : "s"}`);
  if (aggregates) parts.push(`${aggregates} aggregated list${aggregates === 1 ? "" : "s"}`);
  const years = tiles.flatMap((t) => [t.firstYear, t.lastYear]).filter(Boolean) as number[];
  const span = years.length ? `, ${Math.min(...years)}–${Math.max(...years)}` : "";
  const list = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
  return `${list} hold data about this subject${span}.`;
}
