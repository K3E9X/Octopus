// Darkweb / hidden services — searching what the surface web does not index.
//
// Scope, honestly stated. Tor is not a database you can query; there is no crawl of
// "everything". What is actually achievable, and what this module does:
//
//   1. DISCOVERY via onion search indexes. Ahmia is reachable from the clearnet, which
//      means darkweb discovery works with NO Tor installed — that is deliberate, because
//      an OSINT tool that silently does nothing unless a daemon is running is worse than
//      one that says what it can and cannot see. Torch and Haystak are onion-only and are
//      queried only when Tor is configured.
//   2. RETRIEVAL of a specific hidden service through Tor, with identifier extraction
//      (emails, PGP keys, wallets, handles, other onions) so a hit becomes a pivot.
//   3. REFUSAL. A .onion request without a SOCKS proxy cannot succeed and must never be
//      attempted over the clearnet — the DNS lookup alone tells a resolver what you are
//      looking for. lib/netfetch fails those closed.
//
// What this is NOT: it is not "we searched the dark web". It is "these indexes, which
// see a fraction of it, answered this". Every signal produced here says so, and none of
// it is scored above POSSIBLE on its own — an index entry is a mention, not an identity.
//
// Onion addresses rot constantly. The engine list is overridable with the
// OCTOPUS_ONION_ENGINES env var (comma-separated `name=url-template-with-{q}`).

import { fetchHTML } from "./netfetch";
import { extractFromText } from "./extract";
import { isOnion, onionVersion, type OnionVersion } from "./socks";
import type { Signal } from "./signals";

// Onion addressing lives in lib/socks (the transport knows ".onion needs SOCKS"),
// re-exported here because this is where analysts will look for it.
export { isOnion, onionVersion };
export type { OnionVersion };

// v2 (16 chars) is dead since 2021 but still litters old index entries.
const ONION_ANY = /\b([a-z2-7]{16}|[a-z2-7]{56})\.onion\b/gi;

/** Every onion address mentioned in a blob of text (deduped, lowercased). */
export function extractOnions(text: string): string[] {
  const out = new Set<string>();
  ONION_ANY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ONION_ANY.exec(String(text || ""))) !== null) out.add((m[1] + ".onion").toLowerCase());
  return [...out];
}

// ---- search engines ----------------------------------------------------------

export interface OnionEngine {
  id: string;
  name: string;
  /** {q} is replaced with the URL-encoded query */
  url: string;
  /** true when the engine itself lives on an onion address (needs Tor) */
  needsTor: boolean;
}

export const AHMIA_CLEARNET = "https://ahmia.fi/search/?q={q}";
export const AHMIA_ONION = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/search/?q={q}";

const DEFAULT_ENGINES: OnionEngine[] = [
  // Ahmia indexes hidden services and filters abuse material; reachable both ways.
  { id: "ahmia", name: "Ahmia", url: AHMIA_CLEARNET, needsTor: false },
  { id: "ahmia-onion", name: "Ahmia (onion)", url: AHMIA_ONION, needsTor: true },
  { id: "torch", name: "Torch", url: "http://torchdeedp3i2jigzjdmfpn5ttjhthh5wbmda2rr3jvqjg5p77c54dqd.onion/search?query={q}", needsTor: true },
  { id: "haystak", name: "Haystak", url: "http://haystak5njsmn2hqkewecpaxetahtwhsbsa64jom2k22z5afxhnpxfid.onion/?q={q}", needsTor: true },
];

/** Engine list, with env override for when an address inevitably changes. */
export function onionEngines(): OnionEngine[] {
  const raw = process.env.OCTOPUS_ONION_ENGINES;
  if (!raw) return DEFAULT_ENGINES;
  const out: OnionEngine[] = [];
  for (const part of raw.split(",")) {
    const [name, url] = part.split("=");
    if (!name || !url || !url.includes("{q}")) continue;
    out.push({ id: name.trim().toLowerCase(), name: name.trim(), url: url.trim(), needsTor: isOnion(url) });
  }
  return out.length ? out : DEFAULT_ENGINES;
}

export interface OnionResult {
  /** onion host, e.g. xxx.onion */
  onion: string;
  /** full URL as indexed */
  url: string;
  title: string;
  snippet: string;
  engine: string;
  version: OnionVersion;
  /** true when the selector appears as a whole token in the title/snippet */
  exact: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Ahmia wraps result links in /search/redirect?...&redirect_url=<target>. */
function unwrapRedirect(href: string): string {
  const m = href.match(/[?&]redirect_url=([^&]+)/);
  if (!m) return href;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Parse an onion-index results page. Written against Ahmia's markup but deliberately
 * tolerant: every one of these engines rewrites its HTML without warning, so we fall
 * back to "any anchor pointing at an onion" rather than returning nothing.
 */
export function parseOnionResults(html: string, engine: string, selector: string): OnionResult[] {
  const out: OnionResult[] = [];
  const seen = new Set<string>();
  const sel = selector.trim().toLowerCase();
  const push = (rawUrl: string, title: string, snippet: string) => {
    let url = unwrapRedirect(rawUrl.trim());
    if (!/^https?:\/\//i.test(url)) url = "http://" + url.replace(/^\/+/, "");
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
    if (!host.endsWith(".onion")) return;
    if (seen.has(host)) return;
    seen.add(host);
    const hay = (title + " " + snippet).toLowerCase();
    out.push({
      onion: host,
      url,
      title: title || host,
      snippet: snippet.slice(0, 320),
      engine,
      version: onionVersion(host),
      exact: !!sel && new RegExp(`(^|[^a-z0-9])${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(hay),
    });
  };

  // Preferred path: structured result blocks.
  const blocks = html.split(/<li[^>]*class="[^"]*result[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/<\/li>/i)[0];
    const a = body.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const cite = body.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    const p = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const href = a ? a[1] : cite ? stripTags(cite[1]) : "";
    if (!href) continue;
    push(decodeEntities(href), a ? stripTags(a[2]) : "", p ? stripTags(p[1]) : "");
  }
  if (out.length) return out;

  // Fallback: any anchor whose href is an onion.
  const ANCHOR = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR.exec(html)) !== null) {
    const href = decodeEntities(m[1]);
    if (!/\.onion/i.test(href)) continue;
    push(href, stripTags(m[2]), "");
    if (out.length >= 40) break;
  }
  return out;
}

export interface DarkwebSearch {
  results: OnionResult[];
  /** engines actually queried */
  engines: string[];
  /** engines skipped because Tor is not configured */
  skipped: string[];
  torCapable: boolean;
  /** analyst-facing statement of coverage — never let the UI imply completeness */
  note: string;
}

/**
 * Search the onion indexes for a selector. Works without Tor (clearnet Ahmia only);
 * with Tor, queries the onion-only engines too and no longer tells Ahmia's clearnet
 * front-end who is asking.
 */
export async function darkwebSearch(selector: string, opts: { tor?: boolean; limit?: number } = {}): Promise<DarkwebSearch> {
  const q = selector.trim();
  const tor = !!opts.tor;
  const limit = opts.limit ?? 12;
  if (!q) return { results: [], engines: [], skipped: [], torCapable: tor, note: "no selector" };

  const engines = onionEngines().filter((e) => {
    if (e.needsTor && !tor) return false;
    // with Tor available, prefer the onion mirror over the clearnet front-end
    if (tor && e.id === "ahmia") return false;
    return true;
  });
  const skipped = onionEngines().filter((e) => e.needsTor && !tor).map((e) => e.name);

  const results: OnionResult[] = [];
  const used: string[] = [];
  for (const e of engines) {
    const url = e.url.replace("{q}", encodeURIComponent(q));
    // Onion engines are slow and flaky; a short timeout would manufacture false negatives.
    const r = await fetchHTML(url, { timeoutMs: e.needsTor ? 45000 : 12000, ttlMs: 15 * 60_000 });
    if (r.outcome !== "ok" || !r.data) continue;
    used.push(e.name);
    for (const hit of parseOnionResults(r.data, e.name, q)) {
      if (results.some((x) => x.onion === hit.onion)) continue;
      results.push(hit);
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  const note = used.length
    ? `Queried ${used.join(", ")}. These indexes cover a fraction of hidden services — absence here is not absence from the darkweb.${skipped.length ? ` ${skipped.join(", ")} skipped (no Tor proxy configured).` : ""}`
    : `No onion index answered.${skipped.length ? ` ${skipped.join(", ")} need a SOCKS5/Tor proxy.` : ""} Treat this as "not checked", not "nothing found".`;

  return { results, engines: used, skipped, torCapable: tor, note };
}

// ---- retrieval of a specific hidden service ---------------------------------

export interface OnionPage {
  url: string;
  title: string;
  text: string;
  emails: string[];
  onions: string[];
  /** BTC / ETH / XMR addresses found on the page */
  wallets: string[];
  /** PGP public key blocks present (fingerprint material for a hard link) */
  pgp: boolean;
  handles: string[];
}

const BTC = /\b(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{25,62})\b/g;
const ETH = /\b0x[a-fA-F0-9]{40}\b/g;
const XMR = /\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/g;

/**
 * Fetch a hidden service through Tor and pull the pivotable identifiers off it.
 * Never call this without Tor — netfetch refuses it, which is the point.
 */
export async function fetchOnion(url: string): Promise<OnionPage | null> {
  const full = /^https?:\/\//i.test(url) ? url : "http://" + url;
  if (!isOnion(full)) return null;
  const r = await fetchHTML(full, { timeoutMs: 45000, ttlMs: 30 * 60_000 });
  if (r.outcome !== "ok" || !r.data) return null;
  const html = r.data;
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").slice(0, 200);
  const text = stripTags(html).slice(0, 20_000);
  const ex = extractFromText(text);
  const wallets = [
    ...new Set([...(text.match(BTC) || []), ...(text.match(ETH) || []), ...(text.match(XMR) || [])]),
  ].slice(0, 20);
  return {
    url: full,
    title,
    text,
    emails: ex.emails.slice(0, 20),
    onions: extractOnions(text).filter((o) => !full.includes(o)).slice(0, 20),
    wallets,
    pgp: /-----BEGIN PGP PUBLIC KEY BLOCK-----/.test(html),
    handles: ex.aliases.slice(0, 20),
  };
}

// ---- graph signals -----------------------------------------------------------

/**
 * Turn index hits into graph nodes.
 *
 * Deliberately conservative. A selector appearing on an indexed hidden service is a
 * MENTION: it does not establish that the person owns, runs or visited that service.
 * Non-exact matches are not emitted at all — a substring hit on a darkweb index is the
 * kind of evidence that ends up in a report and cannot be defended.
 */
export function darkwebSignals(search: DarkwebSearch, selector: string, collectedAt: string): Signal[] {
  const exact = search.results.filter((r) => r.exact);
  if (!exact.length) return [];
  return exact.slice(0, 6).map((r) => ({
    id: "onion:" + r.onion.replace(/\.onion$/, "").slice(0, 24),
    platform: "HIDDEN SERVICE",
    handle: r.title.slice(0, 60) || r.onion,
    disc: "ON",
    kind: "leak" as const,
    confidence: 34,
    tier: "weak" as const,
    status: "candidate" as const,
    url: r.url,
    collectedAt,
    evidence: [
      {
        name: "Darkweb mention — presence detected on an indexed hidden service",
        detail: `"${selector}" appears verbatim in ${r.engine}'s index entry for ${r.onion} (${r.version}). Index text: "${r.snippet || r.title}".`,
        source: `onion index · ${r.engine}`,
        weight: 40,
      },
      {
        name: "Attribution not established (speculative)",
        detail: "A mention on a hidden service does not establish ownership, authorship or visits. Corroborate with a second, independent observation before treating this as the subject's.",
        source: "guidance",
        weight: 8,
      },
      ...(r.version === "v2" ? [{
        name: "Obsolete address (stale record)",
        detail: "v2 onion addresses were switched off by the Tor network in 2021 — this index entry is historical and the service is unreachable.",
        source: "onion address format",
        weight: 5,
      }] : []),
    ],
  }));
}

/** Nodes for identifiers harvested off a retrieved hidden service. */
export function onionPageSignals(page: OnionPage, collectedAt: string): Signal[] {
  const host = (() => { try { return new URL(page.url).hostname; } catch { return page.url; } })();
  const out: Signal[] = [];
  for (const w of page.wallets.slice(0, 6)) {
    out.push({
      id: "wallet:" + w.slice(0, 16).toLowerCase(),
      platform: "WALLET",
      handle: w,
      disc: "WL",
      kind: "alias" as const,
      confidence: 30,
      tier: "weak" as const,
      status: "candidate" as const,
      collectedAt,
      evidence: [{
        name: "Darkweb mention — wallet published on a hidden service",
        detail: `Address found on ${host}. Chain analysis is out of scope here; recorded as a selector to pivot on.`,
        source: `hidden service · ${host}`,
        weight: 34,
      }],
    });
  }
  if (page.pgp) {
    out.push({
      id: "pgp:" + host.slice(0, 20),
      platform: "PGP KEY",
      handle: host,
      disc: "PG",
      kind: "alias" as const,
      confidence: 40,
      tier: "weak" as const,
      status: "candidate" as const,
      collectedAt,
      evidence: [{
        // deliberately NOT named "PGP fingerprint": the presence of a key block is not
        // itself a cryptographic link. Only comparing the key to one held elsewhere is,
        // and that comparison has not happened yet.
        name: "Public key block published on a hidden service (darkweb mention)",
        detail: `A public key block is published on ${host}. Its fingerprint would be a hard selector — the same key seen elsewhere is a cryptographic link — but that comparison has not been made here.`,
        source: `hidden service · ${host}`,
        weight: 44,
      }],
    });
  }
  return out;
}
