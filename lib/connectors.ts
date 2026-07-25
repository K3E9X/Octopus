// Real connectors — query clean PUBLIC APIs only (no auth, no scraping, ToS-friendly).
// Each connector maps a username seed to a raw public profile when it exists.
// Confidence/evidence are computed downstream; connectors only report verifiable facts.
//
// Deliberately EXCLUDED: Instagram / X-Twitter / Facebook / LinkedIn / TikTok — their
// public APIs are closed and scraping breaks their ToS. Those belong to the "manual
// pivots" catalogue (cipher387), not to automated connectors.

import type { ImageMeta } from "./metadata";
import { fetchJSON, noteOutcome, type SourceHealth } from "./netfetch";
import { SOCIAL_CONNECTOR_DEFS } from "./connectors-social";

export interface ProfileLink {
  /** service identifier, e.g. "twitter", "github", "reddit" */
  service: string;
  /** the declared handle on that service, when known */
  handle?: string;
  url: string;
  /** display label */
  label: string;
}

export interface RawProfile {
  id: string;
  platform: string;
  disc: string;
  handle: string;
  url: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  /** perceptual hash (dHash) of the avatar, filled in by the enrichment step */
  avatarHash?: string;
  /** image metadata (EXIF/GPS/IPTC/XMP) extracted from the avatar, when present */
  exif?: ImageMeta;
  /** free-text location from the profile, when the source exposes it */
  location?: string;
  createdAt?: string;
  /** self-declared / verified links to other accounts (strong cross-signal) */
  links?: ProfileLink[];
  /** true when existence is inferred by URL pattern (WhatsMyName), not an official API */
  unverified?: boolean;
  /** true when the account was found via a handle derived from an email (weaker person-link) */
  derived?: boolean;
  /** which derivation rule produced it — the evidence must say how indirect the link is */
  derivedFrom?: string;
  /** true when this node was created from another account's declared/verified link */
  declared?: boolean;
  /** set when the profile was found via a VARIANT of the seed handle, not the seed
   *  itself — a weaker link that must be scored (and shown) as such */
  variantOf?: string;
  variantRule?: string;
  /** short provenance, e.g. "api.github.com · public API" */
  source: string;
}

const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";

// Health of the current scan — connectors record here when a source rate-limits or
// fails, so the response can say "incomplete" instead of implying "nothing found".
let CURRENT_HEALTH: SourceHealth | null = null;

async function getJSON(url: string, timeoutMs = 6000): Promise<any | null> {
  const r = await fetchJSON(url, { timeoutMs, headers: { "User-Agent": UA, Accept: "application/json" } });
  if (CURRENT_HEALTH && r.outcome !== "ok" && r.outcome !== "not-found") {
    let host = "source";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep */ }
    noteOutcome(CURRENT_HEALTH, host, r.outcome);
  }
  return r.data;
}

const enc = encodeURIComponent;

/** GitHub — public REST API (unauthenticated: 60 req/h/IP). */
async function github(u: string): Promise<RawProfile | null> {
  const d = await getJSON(`https://api.github.com/users/${enc(u)}`);
  if (!d?.login) return null;
  return {
    id: "github", platform: "GITHUB", disc: "GH", handle: d.login, url: d.html_url,
    displayName: d.name || undefined, bio: d.bio || undefined, avatar: d.avatar_url || undefined,
    location: d.location || undefined,
    createdAt: d.created_at || undefined,
    links: d.blog ? [{ service: "web", url: d.blog, label: "site" }] : undefined,
    source: "api.github.com · public API",
  };
}

/** GitLab — public users search API. */
async function gitlab(u: string): Promise<RawProfile | null> {
  const arr = await getJSON(`https://gitlab.com/api/v4/users?username=${enc(u)}`);
  const d = Array.isArray(arr) ? arr[0] : null;
  if (!d?.username) return null;
  return {
    id: "gitlab", platform: "GITLAB", disc: "GL", handle: d.username, url: d.web_url,
    displayName: d.name || undefined, bio: d.bio || undefined, avatar: d.avatar_url || undefined,
    source: "gitlab.com · public API",
  };
}

/** Reddit — public about.json. */
async function reddit(u: string): Promise<RawProfile | null> {
  const j = await getJSON(`https://www.reddit.com/user/${enc(u)}/about.json`);
  const d = j?.data;
  if (!d?.name) return null;
  return {
    id: "reddit", platform: "REDDIT", disc: "RD", handle: `u/${d.name}`,
    url: `https://www.reddit.com/user/${d.name}`,
    displayName: d.subreddit?.title || undefined, bio: d.subreddit?.public_description || undefined,
    avatar: (d.icon_img || d.snoovatar_img || "").split("?")[0] || undefined,
    createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
    source: "reddit.com · public about.json",
  };
}

/** Hacker News — public Firebase user endpoint. */
async function hackernews(u: string): Promise<RawProfile | null> {
  const d = await getJSON(`https://hacker-news.firebaseio.com/v0/user/${enc(u)}.json`);
  if (!d?.id) return null;
  return {
    id: "hn", platform: "HACKER NEWS", disc: "HN", handle: d.id,
    url: `https://news.ycombinator.com/user?id=${d.id}`,
    bio: d.about ? String(d.about).replace(/<[^>]+>/g, " ").slice(0, 200) : undefined,
    createdAt: d.created ? new Date(d.created * 1000).toISOString() : undefined,
    source: "news.ycombinator.com · public API",
  };
}

/** Keybase — lists cryptographically-verified linked accounts (strong cross-signal). */
async function keybase(u: string): Promise<RawProfile | null> {
  const j = await getJSON(`https://keybase.io/_/api/1.0/user/lookup.json?usernames=${enc(u)}&fields=basics,profile,pictures,proofs_summary`);
  const d = Array.isArray(j?.them) ? j.them[0] : j?.them;
  if (!d?.basics?.username) return null;
  const proofs = Array.isArray(d.proofs_summary?.all) ? d.proofs_summary.all : [];
  const links: ProfileLink[] = proofs
    .filter((p: any) => p?.nametag && p?.proof_type)
    .slice(0, 6)
    .map((p: any) => ({ service: p.proof_type, handle: p.nametag, url: p.service_url || p.proof_url || "", label: `${p.proof_type}:${p.nametag}` }));
  return {
    id: "keybase", platform: "KEYBASE", disc: "KB", handle: d.basics.username,
    url: `https://keybase.io/${d.basics.username}`,
    displayName: d.profile?.full_name || undefined, bio: d.profile?.bio || undefined,
    avatar: d.pictures?.primary?.url || undefined,
    links: links.length ? links : undefined,
    source: "keybase.io · public API (verified accounts)",
  };
}

/** Gravatar — profile slug JSON; often declares linked accounts. */
async function gravatar(u: string): Promise<RawProfile | null> {
  const j = await getJSON(`https://gravatar.com/${enc(u)}.json`);
  const e = Array.isArray(j?.entry) ? j.entry[0] : null;
  if (!e?.hash) return null;
  const accounts = Array.isArray(e.accounts) ? e.accounts : [];
  const links: ProfileLink[] = accounts.slice(0, 6).map((a: any) => ({ service: a.shortname || a.name || "account", handle: a.username || a.display || undefined, url: a.url || "", label: a.shortname || a.name || "account" }));
  return {
    id: "gravatar", platform: "GRAVATAR", disc: "GR", handle: e.preferredUsername || u,
    url: e.profileUrl || `https://gravatar.com/${u}`,
    displayName: e.displayName || e.name?.formatted || undefined,
    bio: e.aboutMe || undefined, avatar: e.thumbnailUrl || undefined,
    location: e.currentLocation || undefined,
    links: links.length ? links : undefined,
    source: "gravatar.com · public API",
  };
}

/** Bluesky — public AppView (no auth). */
async function bluesky(u: string): Promise<RawProfile | null> {
  const actor = u.includes(".") ? u : `${u}.bsky.social`;
  const d = await getJSON(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${enc(actor)}`);
  if (!d?.handle) return null;
  return {
    id: "bluesky", platform: "BLUESKY", disc: "BS", handle: d.handle,
    url: `https://bsky.app/profile/${d.handle}`,
    displayName: d.displayName || undefined, bio: d.description || undefined, avatar: d.avatar || undefined,
    createdAt: d.createdAt || undefined, source: "public.api.bsky.app · public API",
  };
}

/** Mastodon (mastodon.social instance) — public account lookup. */
async function mastodon(u: string): Promise<RawProfile | null> {
  const d = await getJSON(`https://mastodon.social/api/v1/accounts/lookup?acct=${enc(u)}`);
  if (!d?.username) return null;
  return {
    id: "mastodon", platform: "MASTODON", disc: "MA", handle: `@${d.username}@mastodon.social`,
    url: d.url, displayName: d.display_name || undefined,
    bio: d.note ? String(d.note).replace(/<[^>]+>/g, " ").slice(0, 200) : undefined,
    avatar: d.avatar || undefined, createdAt: d.created_at || undefined,
    source: "mastodon.social · public API",
  };
}

/** Chess.com — public player API. */
async function chesscom(u: string): Promise<RawProfile | null> {
  const d = await getJSON(`https://api.chess.com/pub/player/${enc(u.toLowerCase())}`);
  if (!d?.username) return null;
  return {
    id: "chesscom", platform: "CHESS.COM", disc: "CH", handle: d.username, url: d.url,
    displayName: d.name || undefined, avatar: d.avatar || undefined,
    createdAt: d.joined ? new Date(d.joined * 1000).toISOString() : undefined,
    source: "api.chess.com · public API",
  };
}

/** Codeforces — public user info API. */
async function codeforces(u: string): Promise<RawProfile | null> {
  const j = await getJSON(`https://codeforces.com/api/user.info?handles=${enc(u)}`);
  const d = j?.status === "OK" && Array.isArray(j.result) ? j.result[0] : null;
  if (!d?.handle) return null;
  const name = [d.firstName, d.lastName].filter(Boolean).join(" ") || undefined;
  return {
    id: "codeforces", platform: "CODEFORCES", disc: "CF", handle: d.handle,
    url: `https://codeforces.com/profile/${d.handle}`,
    displayName: name, avatar: d.titlePhoto ? `https:${d.titlePhoto}` : undefined,
    source: "codeforces.com · public API",
  };
}

/** npm — public registry user document. */
async function npm(u: string): Promise<RawProfile | null> {
  const d = await getJSON(`https://registry.npmjs.org/-/user/org.couchdb.user:${enc(u)}`);
  if (!d?.name) return null;
  return {
    id: "npm", platform: "NPM", disc: "NP", handle: d.name,
    url: `https://www.npmjs.com/~${d.name}`,
    source: "registry.npmjs.org · public API",
  };
}

/** Docker Hub — public user endpoint. */
async function dockerhub(u: string): Promise<RawProfile | null> {
  const d = await getJSON(`https://hub.docker.com/v2/users/${enc(u)}/`);
  if (!d?.username) return null;
  return {
    id: "dockerhub", platform: "DOCKER HUB", disc: "DK", handle: d.username,
    url: `https://hub.docker.com/u/${d.username}`,
    displayName: d.full_name || undefined, avatar: d.gravatar_url || undefined,
    createdAt: d.date_joined || undefined, source: "hub.docker.com · public API",
  };
}

/** Wikipedia — public MediaWiki users query. */
async function wikipedia(u: string): Promise<RawProfile | null> {
  const j = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=users&ususers=${enc(u)}&usprop=editcount|registration&format=json`);
  const d = j?.query?.users?.[0];
  if (!d || d.missing !== undefined || d.invalid !== undefined || !d.name) return null;
  return {
    id: "wikipedia", platform: "WIKIPEDIA", disc: "WK", handle: d.name,
    url: `https://en.wikipedia.org/wiki/User:${enc(d.name)}`,
    bio: typeof d.editcount === "number" ? `${d.editcount} contributions` : undefined,
    createdAt: d.registration || undefined, source: "en.wikipedia.org · public API",
  };
}

export const CONNECTOR_DEFS: Array<{ id: string; fn: (u: string) => Promise<RawProfile | null> }> = [
  { id: "github", fn: github }, { id: "gitlab", fn: gitlab }, { id: "reddit", fn: reddit },
  { id: "hn", fn: hackernews }, { id: "keybase", fn: keybase }, { id: "gravatar", fn: gravatar },
  { id: "bluesky", fn: bluesky }, { id: "mastodon", fn: mastodon }, { id: "chesscom", fn: chesscom },
  { id: "codeforces", fn: codeforces }, { id: "npm", fn: npm }, { id: "dockerhub", fn: dockerhub },
  { id: "wikipedia", fn: wikipedia },
];

// Non-developer platforms live in their own module (see the note there on why
// Instagram/TikTok/Facebook are deliberately absent).
export const ALL_CONNECTOR_DEFS = [...CONNECTOR_DEFS, ...SOCIAL_CONNECTOR_DEFS];

/** Run the enabled connectors for a username; never throws — failed ones drop to null.
 *  `enabled` = allowlist of connector ids; omit to run all.
 *  `health` (optional) collects rate-limit / failure notes so the caller can report
 *  honestly that coverage was incomplete rather than implying "nothing found". */
export async function scanUsername(username: string, enabled?: Set<string>, health?: SourceHealth): Promise<RawProfile[]> {
  const defs = enabled ? ALL_CONNECTOR_DEFS.filter((d) => enabled.has(d.id)) : ALL_CONNECTOR_DEFS;
  const prev = CURRENT_HEALTH;
  if (health) CURRENT_HEALTH = health;
  try {
    const settled = await Promise.allSettled(defs.map((d) => d.fn(username)));
    return settled
      .map((s) => (s.status === "fulfilled" ? s.value : null))
      .filter((x): x is RawProfile => x != null);
  } finally {
    CURRENT_HEALTH = prev;
  }
}
