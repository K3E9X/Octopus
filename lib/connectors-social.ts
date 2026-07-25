// Non-developer connectors — the coverage gap.
//
// Our first connector set skewed heavily to developer platforms (GitHub, GitLab, npm,
// Docker Hub, Codeforces): great for a maintainer, useless for everyone else. These
// connectors target where ordinary people actually are, using only endpoints that are
// public and keyless.
//
// Two techniques:
//  1. Open JSON APIs (Lichess, Roblox, Steam XML) — rich and verifiable.
//  2. OpenGraph metadata, which nearly every profile page exposes and which is far
//     more stable than scraping markup. It yields display name, bio and avatar — real
//     correlation material, not just "the account exists".
//
// Deliberately NOT here: Instagram, TikTok, Facebook, LinkedIn, X. They block
// datacenter IPs and their ToS forbids scraping, so a server-side check is unreliable
// by construction. For those, the honest routes are Holehe (email → account existence,
// via the collector worker) and analyst capture. Pretending otherwise would just
// manufacture false negatives.

import type { RawProfile } from "./connectors";
import { fetchJSON } from "./netfetch";

const UA = "Mozilla/5.0 (compatible; Octopus-OSINT/0.1; +https://github.com/K3E9X/Tusna)";
const enc = encodeURIComponent;

// ---------- OpenGraph helper ----------

export interface OG { title?: string; description?: string; image?: string; }

/** Extract OpenGraph/twitter meta from an HTML page. Tolerant of attribute order. */
export function parseOG(html: string): OG {
  const pick = (prop: string): string | undefined => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|` +
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
      "i",
    );
    const m = html.match(re);
    const v = (m?.[1] ?? m?.[2] ?? "").trim();
    return v ? decodeEntities(v) : undefined;
  };
  return { title: pick("og:title") || pick("twitter:title"), description: pick("og:description") || pick("twitter:description"), image: pick("og:image") };
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function getHTML(url: string, timeoutMs = 7000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "text/html" }, cache: "no-store", redirect: "follow" });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 120_000); // profile meta lives in the head; cap the read
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Definition of an OpenGraph-based profile connector. */
interface OGSite {
  id: string;
  platform: string;
  disc: string;
  url: (u: string) => string;
  /** page is a "no such user" page when this matches the title/description */
  notFound?: RegExp;
  /** strip a boilerplate suffix from the OG title, e.g. " | Pinterest" */
  cleanTitle?: RegExp;
}

const OG_SITES: OGSite[] = [
  { id: "telegram", platform: "TELEGRAM", disc: "TG", url: (u) => `https://t.me/${enc(u)}`, notFound: /^Telegram(: Contact)?$/i, cleanTitle: /\s*[–|-]\s*Telegram$/i },
  { id: "linktree", platform: "LINKTREE", disc: "LT", url: (u) => `https://linktr.ee/${enc(u)}`, notFound: /page not found|doesn.t exist/i },
  { id: "soundcloud", platform: "SOUNDCLOUD", disc: "SC", url: (u) => `https://soundcloud.com/${enc(u)}`, notFound: /something went wrong|page not found/i, cleanTitle: /\s*\|\s*Free Listening on SoundCloud$/i },
  { id: "pinterest", platform: "PINTEREST", disc: "PI", url: (u) => `https://www.pinterest.com/${enc(u)}/`, notFound: /page not found|user not found/i, cleanTitle: /\s*\|\s*Pinterest$/i },
  { id: "behance", platform: "BEHANCE", disc: "BE", url: (u) => `https://www.behance.net/${enc(u)}`, notFound: /page not found|oops/i, cleanTitle: /\s*on Behance$/i },
  { id: "letterboxd", platform: "LETTERBOXD", disc: "LB", url: (u) => `https://letterboxd.com/${enc(u)}/`, notFound: /letterboxd • social film discovery|not found/i, cleanTitle: /^.*?’s profile\s*/i },
  { id: "spotify", platform: "SPOTIFY", disc: "SP", url: (u) => `https://open.spotify.com/user/${enc(u)}`, notFound: /page not found|couldn.t find/i, cleanTitle: /\s*\|\s*Spotify$/i },
  { id: "deviantart", platform: "DEVIANTART", disc: "DA", url: (u) => `https://www.deviantart.com/${enc(u)}`, notFound: /deviantart is the world|page not found/i, cleanTitle: /\s*\|\s*DeviantArt$/i },
  { id: "kofi", platform: "KO-FI", disc: "KO", url: (u) => `https://ko-fi.com/${enc(u)}`, notFound: /page not found|ko-fi\.com - buy/i, cleanTitle: /\s*\|\s*Ko-fi.*$/i },
  { id: "patreon", platform: "PATREON", disc: "PA", url: (u) => `https://www.patreon.com/${enc(u)}`, notFound: /page not found|patreon logo/i, cleanTitle: /\s*\|\s*Patreon$/i },
  // The second wave, chosen for reach among ordinary people rather than for being
  // interesting to a developer. All keyless, all public profile pages.
  { id: "snapchat", platform: "SNAPCHAT", disc: "SN", url: (u) => `https://www.snapchat.com/add/${enc(u)}`, notFound: /page not found|couldn.t find|snapchat$/i, cleanTitle: /\s*(?:on Snapchat|\| Snapchat)$/i },
  { id: "twitch", platform: "TWITCH", disc: "TW", url: (u) => `https://www.twitch.tv/${enc(u)}`, notFound: /page not found|sorry.*unavailable|twitch$/i, cleanTitle: /\s*-\s*Twitch$/i },
  { id: "tumblr", platform: "TUMBLR", disc: "TU", url: (u) => `https://${enc(u)}.tumblr.com/`, notFound: /nothing here|not found|tumblr$/i },
  { id: "flickr", platform: "FLICKR", disc: "FL", url: (u) => `https://www.flickr.com/people/${enc(u)}/`, notFound: /page not found|this page is private/i, cleanTitle: /\s*\|\s*Flickr$/i },
  { id: "vk", platform: "VK", disc: "VK", url: (u) => `https://vk.com/${enc(u)}`, notFound: /404|page not found|заблокирована/i, cleanTitle: /\s*\|\s*VK$/i },
  { id: "wattpad", platform: "WATTPAD", disc: "WP", url: (u) => `https://www.wattpad.com/user/${enc(u)}`, notFound: /page not found|oops/i, cleanTitle: /\s*-\s*Wattpad$/i },
  { id: "medium", platform: "MEDIUM", disc: "MD", url: (u) => `https://medium.com/@${enc(u)}`, notFound: /page not found|out of nothing/i, cleanTitle: /\s*[–|-]\s*Medium$/i },
  { id: "substack", platform: "SUBSTACK", disc: "SU", url: (u) => `https://${enc(u)}.substack.com/`, notFound: /page not found|no such publication/i, cleanTitle: /\s*\|\s*Substack$/i },
  { id: "bandcamp", platform: "BANDCAMP", disc: "BC", url: (u) => `https://${enc(u)}.bandcamp.com/`, notFound: /page not found|sorry, that something/i, cleanTitle: /\s*\|\s*Bandcamp$/i },
  { id: "vimeo", platform: "VIMEO", disc: "VM", url: (u) => `https://vimeo.com/${enc(u)}`, notFound: /page not found|410/i, cleanTitle: /\s*on Vimeo$/i },
  { id: "etsy", platform: "ETSY", disc: "ET", url: (u) => `https://www.etsy.com/people/${enc(u)}`, notFound: /page not found|sorry/i, cleanTitle: /\s*(?:-|\|)\s*Etsy$/i },
  { id: "goodreads", platform: "GOODREADS", disc: "GD", url: (u) => `https://www.goodreads.com/${enc(u)}`, notFound: /page not found|error/i, cleanTitle: /\s*\(.*\)$/i },
  { id: "trello", platform: "TRELLO", disc: "TR", url: (u) => `https://trello.com/u/${enc(u)}`, notFound: /page not found|nothing here/i, cleanTitle: /\s*\|\s*Trello$/i },
];

/** Link-in-bio pages exist to list someone's other accounts — extract them all.
 *  These are DECLARED links: the person published them, so they are strong pivots. */
function extractDeclaredLinks(html: string, self: string): { service: string; url: string; label: string }[] {
  const out: { service: string; url: string; label: string }[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'\\<>]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[0].replace(/[.,);\]]+$/, "");
    let host: string;
    try { host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); } catch { continue; }
    // skip the host itself and the usual asset/CDN/analytics noise
    if (host.includes(self)) continue;
    if (/(googleapis|gstatic|cloudflare|cloudfront|jsdelivr|unpkg|fontawesome|schema\.org|w3\.org|sentry|segment|google-analytics|googletagmanager|doubleclick|akamai|licdn\.com\/sc|typekit)/i.test(host)) continue;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|mp4|json)$/i.test(raw)) continue;
    const key = host;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ service: host.split(".")[0], url: raw, label: host });
    if (out.length >= 10) break;
  }
  return out;
}

function ogConnector(site: OGSite) {
  return async (u: string): Promise<RawProfile | null> => {
    const url = site.url(u);
    const html = await getHTML(url);
    if (!html) return null;
    const og = parseOG(html);
    if (!og.title) return null;
    const blob = `${og.title} ${og.description || ""}`;
    if (site.notFound && site.notFound.test(blob)) return null;
    // a profile page whose OG title is just the site name is a generic/landing page
    const title = site.cleanTitle ? og.title.replace(site.cleanTitle, "").trim() : og.title.trim();
    if (!title || title.toLowerCase() === site.platform.toLowerCase()) return null;
    const host = new URL(url).hostname.replace(/^www\./, "");
    // link-in-bio pages publish the person's other accounts — harvest them as
    // DECLARED links, which the graph treats as strong cross-account evidence
    const links = site.id === "linktree" ? extractDeclaredLinks(html, "linktr.ee") : undefined;
    return {
      id: site.id,
      platform: site.platform,
      disc: site.disc,
      handle: u,
      url,
      displayName: title !== u ? title : undefined,
      bio: og.description ? og.description.slice(0, 200) : undefined,
      avatar: og.image || undefined,
      links: links && links.length ? links : undefined,
      source: `${host} · public page (OpenGraph)`,
    };
  };
}

// ---------- open JSON APIs (richest, fully verifiable) ----------

/** Lichess — fully open API, exposes bio, country and declared social links. */
async function lichess(u: string): Promise<RawProfile | null> {
  const r = await fetchJSON<any>(`https://lichess.org/api/user/${enc(u)}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const d = r.data;
  if (!d?.id || d.closed) return null;
  const p = d.profile || {};
  const links: { service: string; url: string; label: string }[] = [];
  if (p.links) {
    for (const raw of String(p.links).split(/\s+/)) {
      if (/^https?:\/\//i.test(raw)) links.push({ service: "web", url: raw, label: raw });
    }
  }
  return {
    id: "lichess", platform: "LICHESS", disc: "LI", handle: d.username || u,
    url: d.url || `https://lichess.org/@/${d.username || u}`,
    displayName: [p.firstName, p.lastName].filter(Boolean).join(" ") || undefined,
    bio: p.bio ? String(p.bio).slice(0, 200) : undefined,
    location: p.location || p.country || undefined,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
    links: links.length ? links : undefined,
    source: "lichess.org · open API",
  };
}

/** Roblox — open users API (huge, very young user base). */
async function roblox(u: string): Promise<RawProfile | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST", signal: ctrl.signal, cache: "no-store",
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ usernames: [u], excludeBannedUsers: false }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const d = Array.isArray(j?.data) ? j.data[0] : null;
    if (!d?.id) return null;
    return {
      id: "roblox", platform: "ROBLOX", disc: "RB", handle: d.name || u,
      url: `https://www.roblox.com/users/${d.id}/profile`,
      displayName: d.displayName && d.displayName !== d.name ? d.displayName : undefined,
      source: "users.roblox.com · open API",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Steam — public community XML profile (real name, location, avatar when set). */
async function steam(u: string): Promise<RawProfile | null> {
  const xml = await getHTML(`https://steamcommunity.com/id/${enc(u)}?xml=1`);
  if (!xml || !/<steamID64>/i.test(xml)) return null;
  const tag = (n: string): string | undefined => {
    const m = xml.match(new RegExp(`<${n}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`, "i"));
    const v = (m?.[1] || "").trim();
    return v || undefined;
  };
  const name = tag("steamID");
  if (!name) return null;
  const summary = tag("summary");
  return {
    id: "steam", platform: "STEAM", disc: "ST", handle: u,
    url: `https://steamcommunity.com/id/${u}`,
    displayName: tag("realname") || (name !== u ? name : undefined),
    bio: summary ? summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200) : undefined,
    avatar: tag("avatarFull") || tag("avatarMedium"),
    location: tag("location"),
    source: "steamcommunity.com · public XML profile",
  };
}

/**
 * Duolingo — an open API and a user base of ordinary people rather than developers.
 * Returns a display name, the account creation date and the courses studied, which
 * says something real about the person (target language, likely country).
 */
async function duolingo(u: string): Promise<RawProfile | null> {
  const r = await fetchJSON<any>(`https://www.duolingo.com/2017-06-30/users?username=${enc(u)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const d = Array.isArray(r.data?.users) ? r.data.users[0] : null;
  if (!d?.username) return null;
  const courses: string[] = Array.isArray(d.courses)
    ? d.courses.map((c: any) => `${c.fromLanguage}→${c.learningLanguage}`).slice(0, 4)
    : [];
  return {
    id: "duolingo", platform: "DUOLINGO", disc: "DU", handle: d.username,
    url: `https://www.duolingo.com/profile/${d.username}`,
    displayName: d.name || undefined,
    bio: courses.length ? `learning ${courses.join(", ")}` : undefined,
    avatar: d.picture ? (String(d.picture).startsWith("//") ? "https:" + d.picture : d.picture) : undefined,
    createdAt: d.creationDate ? new Date(d.creationDate * 1000).toISOString() : undefined,
    source: "duolingo.com · open API",
  };
}

/** Mixcloud — open API exposing name, city and country. */
async function mixcloud(u: string): Promise<RawProfile | null> {
  const r = await fetchJSON<any>(`https://api.mixcloud.com/${enc(u)}/`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const d = r.data;
  if (!d?.username || d.error) return null;
  const loc = [d.city, d.country].filter(Boolean).join(", ");
  return {
    id: "mixcloud", platform: "MIXCLOUD", disc: "MX", handle: d.username,
    url: d.url || `https://www.mixcloud.com/${d.username}/`,
    displayName: d.name || undefined,
    bio: d.biog ? String(d.biog).slice(0, 200) : undefined,
    location: loc || undefined,
    avatar: d.pictures?.large || d.pictures?.medium || undefined,
    createdAt: d.created_time || undefined,
    source: "mixcloud.com · open API",
  };
}

export const SOCIAL_CONNECTOR_DEFS: Array<{ id: string; fn: (u: string) => Promise<RawProfile | null> }> = [
  { id: "lichess", fn: lichess },
  { id: "roblox", fn: roblox },
  { id: "steam", fn: steam },
  { id: "duolingo", fn: duolingo },
  { id: "mixcloud", fn: mixcloud },
  ...OG_SITES.map((s) => ({ id: s.id, fn: ogConnector(s) })),
];
