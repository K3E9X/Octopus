// Egress OPSEC — how Octopus presents itself to the outside world.
//
// The default posture of a naive collector burns the operation: every request leaves
// from one IP, with one self-identifying User-Agent, in a tight machine-timed burst.
// A target with basic monitoring — or the platform itself — sees "an OSINT tool looked
// at this profile", and worse, the identical fingerprint makes every target of the same
// operation correlatable with each other.
//
// This module fixes the three observable dimensions:
//   WHO   — a realistic browser identity, STABLE per case (erratic UAs inside one case
//           look more anomalous than a consistent one) but DIFFERENT across cases.
//   WHERE — an outbound proxy (HTTP CONNECT or SOCKS; SOCKS is what Tor speaks, and is
//           therefore what makes .onion reachable), configurable per case. This module
//           only decides WHETHER a proxy is usable; lib/proxyfetch does the transport.
//   WHEN  — jitter, so requests do not arrive on a machine cadence.
//
// Plus a NO-TOUCH posture: in sensitive work you must be able to research a target
// without ever contacting infrastructure the target can observe. `touchPolicy` blocks
// direct requests to target-owned hosts and permits only third-party/archival sources.

import { isSocksUrl, parseSocks } from "./socks";

export type Posture = "direct" | "careful" | "no-touch";

export interface EgressIdentity {
  userAgent: string;
  acceptLanguage: string;
  /** proxy URL (http(s):// or socks5://), empty = direct */
  proxy: string;
  posture: Posture;
  /** milliseconds of random delay added before each request */
  jitterMs: number;
}

// Real, current browser User-Agents. A collector that announces itself is a collector
// that gets logged, profiled and blocked.
// The pool must be wide enough that two cases rarely collide — a shared fingerprint
// across cases is exactly the correlation we are trying to deny an observer.
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
];
const LANG_POOL = [
  "en-US,en;q=0.9", "en-GB,en;q=0.9", "fr-FR,fr;q=0.9,en;q=0.8", "de-DE,de;q=0.9,en;q=0.8",
  "es-ES,es;q=0.9,en;q=0.8", "it-IT,it;q=0.9,en;q=0.8", "nl-NL,nl;q=0.9,en;q=0.8", "pt-BR,pt;q=0.9,en;q=0.8",
];

/**
 * Stable non-cryptographic hash — same case id always yields the same identity.
 * FNV-1a alone leaves the LOW bits poorly mixed, which matters here because we select
 * from the pools with `% poolSize`: near-identical case ids ("case-1", "case-2") would
 * collide far more often than chance and undo the anti-correlation. The avalanche
 * finalizer spreads entropy into the low bits.
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface EgressConfig {
  /** case / operation id — anchors the identity so it is stable within one case */
  caseId?: string;
  proxy?: string;
  posture?: Posture;
  jitterMs?: number;
}

/** Build the egress identity for a case. Deterministic: same case → same fingerprint. */
export function egressIdentity(cfg: EgressConfig = {}): EgressIdentity {
  const anchor = cfg.caseId || process.env.OCTOPUS_CASE_ID || "default";
  const h = hash(anchor);
  // Language is drawn from a SEPARATE hash, not a shifted slice of the same one:
  // otherwise UA and language move together and the pair carries no more entropy
  // than the UA alone. Combined pool is 16 × 8 = 128 distinct fingerprints.
  const hl = hash(anchor + "|lang");
  const posture = cfg.posture || (process.env.OCTOPUS_POSTURE as Posture) || "direct";
  return {
    userAgent: UA_POOL[h % UA_POOL.length],
    acceptLanguage: LANG_POOL[hl % LANG_POOL.length],
    proxy: cfg.proxy || process.env.OCTOPUS_PROXY || "",
    posture,
    jitterMs: cfg.jitterMs ?? (posture === "direct" ? 0 : 400),
  };
}

/** Browser-plausible header set. Order and completeness both matter to fingerprinting. */
export function egressHeaders(id: EgressIdentity, accept = "application/json"): Record<string, string> {
  return {
    "User-Agent": id.userAgent,
    "Accept": accept === "html"
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      : accept,
    "Accept-Language": id.acceptLanguage,
    "Sec-Fetch-Dest": accept === "html" ? "document" : "empty",
    "Sec-Fetch-Mode": accept === "html" ? "navigate" : "cors",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  };
}

// ---- touch policy -----------------------------------------------------------

// Hosts the TARGET can observe: their own profile pages. Requesting these puts our
// egress in a log the target may control or be shown (analytics, follower views).
const TARGET_OBSERVABLE = [
  /(^|\.)instagram\.com$/i, /(^|\.)facebook\.com$/i, /(^|\.)tiktok\.com$/i,
  /(^|\.)linkedin\.com$/i, /(^|\.)x\.com$/i, /(^|\.)twitter\.com$/i,
  /(^|\.)t\.me$/i, /(^|\.)telegram\.me$/i, /(^|\.)linktr\.ee$/i,
  /(^|\.)patreon\.com$/i, /(^|\.)ko-fi\.com$/i, /(^|\.)onlyfans\.com$/i,
];

// Sources that are third-party or archival: querying them tells the target nothing.
const SAFE_SOURCES = [
  /(^|\.)rdap\.org$/i, /(^|\.)crt\.sh$/i, /(^|\.)dns\.google$/i, /(^|\.)archive\.org$/i,
  /(^|\.)hudsonrock\.com$/i, /(^|\.)intelx\.io$/i, /(^|\.)openstreetmap\.org$/i,
  // onion index: a third-party crawl, so querying it tells the indexed service nothing
  /(^|\.)ahmia\.fi$/i,
];

export interface TouchVerdict { allowed: boolean; reason?: string }

/**
 * May we contact this host under the current posture?
 *  - direct   : everything (fastest, loudest)
 *  - careful  : everything, but jittered and browser-shaped (set by egressIdentity)
 *  - no-touch : only sources the target cannot observe. A profile page the target
 *               controls is refused, and the caller must fall back to archives.
 */
export function touchPolicy(url: string, posture: Posture): TouchVerdict {
  if (posture !== "no-touch") return { allowed: true };
  let host = "";
  try { host = new URL(url).hostname; } catch { return { allowed: false, reason: "unparsable url" }; }
  if (SAFE_SOURCES.some((re) => re.test(host))) return { allowed: true };
  if (TARGET_OBSERVABLE.some((re) => re.test(host))) {
    return { allowed: false, reason: `no-touch posture: ${host} is target-observable` };
  }
  // unknown host under no-touch: refuse by default. Silence is the whole point.
  return { allowed: false, reason: `no-touch posture: ${host} not on the safe-source list` };
}

/** An archival stand-in for a page we refuse to fetch directly. */
export function archiveUrl(url: string): string {
  return `https://web.archive.org/web/2/${url}`;
}

// ---- proxy ------------------------------------------------------------------

export type ProxyKind = "none" | "socks" | "http" | "invalid";

/**
 * Classify the configured proxy. Transport lives in lib/proxyfetch; this is only the
 * question "what did the analyst ask for, and can we honour it".
 */
export function proxyKind(proxy: string): { kind: ProxyKind; error?: string } {
  if (!proxy) return { kind: "none" };
  if (isSocksUrl(proxy)) {
    return parseSocks(proxy) ? { kind: "socks" } : { kind: "invalid", error: "unparsable SOCKS proxy URL" };
  }
  try {
    const u = new URL(proxy);
    if (u.protocol === "http:" || u.protocol === "https:") return { kind: "http" };
    return { kind: "invalid", error: `unsupported proxy scheme ${u.protocol}` };
  } catch {
    return { kind: "invalid", error: "unparsable proxy URL" };
  }
}

/**
 * True when the configured proxy can reach hidden services. Only SOCKS can: an HTTP
 * CONNECT proxy has no way to resolve .onion, and Tor speaks SOCKS and nothing else.
 */
export function torCapable(proxy: string): boolean {
  return proxyKind(proxy).kind === "socks";
}

export function jitter(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * ms)));
}
