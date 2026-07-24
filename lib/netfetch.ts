// Shared network layer: every outbound collection request goes through here, so
// OPSEC posture, caching, rate-limit honesty and source health are enforced in ONE
// place rather than trusted to each connector.
//
//  - OPSEC (lib/egress): browser-shaped identity stable per case, optional proxy/Tor,
//    jitter, and a no-touch posture that refuses to contact target-observable hosts.
//  - HONESTY: a rate-limited source returns 403/429; treating that as "no account"
//    is a SILENT FALSE NEGATIVE — the worst failure mode for an investigation tool.
//    We distinguish not-found from blocked and report degradation upward.
//  - CACHE (lib/cachestore): shared across instances when a DB is configured, so deep
//    pivots stop re-fetching and stop burning rate limits.

import { cacheStore } from "./cachestore";
import { egressIdentity, egressHeaders, touchPolicy, proxyKind, torCapable, jitter, type EgressConfig, type Posture } from "./egress";
import { isOnion, onionVersion } from "./socks";
import { proxyFetch } from "./proxyfetch";

export type FetchOutcome = "ok" | "not-found" | "rate-limited" | "error" | "blocked-by-policy";

export interface FetchResult<T = any> {
  data: T | null;
  outcome: FetchOutcome;
  status?: number;
  cached?: boolean;
  /** set when the OPSEC posture refused the request */
  policyReason?: string;
}

const DEFAULT_TTL = 120_000; // long enough for a multi-hop pivot, short enough to stay fresh

// ---- ambient egress config (set per scan by the route) ----
let AMBIENT: EgressConfig = {};
export function setEgress(cfg: EgressConfig): void { AMBIENT = cfg || {}; }
export function currentPosture(): Posture { return egressIdentity(AMBIENT).posture; }
/** The proxy in force for this scan ("" = direct). */
export function currentProxy(): string { return egressIdentity(AMBIENT).proxy; }
/** True when this scan can reach hidden services (a SOCKS proxy is configured). */
export function torActive(): boolean { return torCapable(currentProxy()); }

export async function clearNetCache(): Promise<void> { await cacheStore().clear(); }

/** A 403 can mean "forbidden" or "rate limited" — the headers disambiguate. */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status === 403) {
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
    if (res.headers.get("retry-after")) return true;
  }
  return false;
}

export interface FetchOpts {
  timeoutMs?: number;
  ttlMs?: number;
  /** extra headers merged over the egress identity */
  headers?: Record<string, string>;
  noCache?: boolean;
  requireJson?: boolean;
  /** "html" shapes the Accept/Sec-Fetch headers like a real navigation */
  accept?: "json" | "html";
  /** override the ambient egress config for this call */
  egress?: EgressConfig;
}

/**
 * Can this request legally leave, given where it is going and what transport we have?
 * Split out from rawFetch so the rules are testable without a socket.
 *
 * The .onion rules are the sharp ones. A hidden-service request with no SOCKS proxy
 * cannot succeed — but far worse, attempting it performs a DNS lookup for the address,
 * handing the analyst's resolver (and ISP) the exact thing they were trying to look at
 * unobserved. So it fails closed, loudly, instead of "just failing".
 */
export function transportPolicy(url: string, proxy: string): { allowed: boolean; reason?: string } {
  if (!isOnion(url)) return { allowed: true };
  if (!torCapable(proxy)) {
    return {
      allowed: false,
      reason: "hidden service requires a SOCKS5 proxy (Tor) — refusing to attempt it over the clearnet, the DNS lookup alone would leak the address",
    };
  }
  if (onionVersion(url) === "v2") {
    return { allowed: false, reason: "v2 onion address — the Tor network stopped supporting these in 2021, the service is unreachable by design" };
  }
  if (onionVersion(url) === "invalid") {
    return { allowed: false, reason: "malformed onion address" };
  }
  return { allowed: true };
}

async function rawFetch(url: string, opts: FetchOpts): Promise<FetchResult<any>> {
  const id = egressIdentity(opts.egress || AMBIENT);

  // Hidden services are exempt from the no-touch host rules but not from transport:
  // reaching one THROUGH Tor tells its operator only that "someone via Tor" looked,
  // which is precisely the anonymity no-touch is trying to buy.
  const onion = isOnion(url);
  const verdict = onion ? { allowed: true } : touchPolicy(url, id.posture);
  if (!verdict.allowed) {
    return { data: null, outcome: "blocked-by-policy", policyReason: verdict.reason };
  }

  const transport = transportPolicy(url, id.proxy);
  if (!transport.allowed) {
    return { data: null, outcome: "blocked-by-policy", policyReason: transport.reason };
  }

  await jitter(id.jitterMs);

  // Fail CLOSED on a misconfigured proxy. The analyst asked for that egress path for a
  // reason; sending the request direct instead would leak from their real address.
  const pk = proxyKind(id.proxy);
  if (pk.kind === "invalid") {
    return { data: null, outcome: "blocked-by-policy", policyReason: `proxy unusable (${pk.error}) — refusing to send this request direct` };
  }

  const timeoutMs = opts.timeoutMs ?? 6000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { ...egressHeaders(id, opts.accept === "html" ? "html" : "application/json"), ...(opts.headers || {}) };

    // Two transports. Direct uses the platform fetch; proxied goes through our own
    // HTTP-over-socket client, because Node's fetch has no way to use a proxy at all.
    const res = pk.kind === "none"
      ? await fetch(url, { signal: ctrl.signal, headers, cache: "no-store", redirect: "follow" })
      : await proxyFetch(url, id.proxy, { headers, timeoutMs });
    if (isRateLimited(res)) return { data: null, outcome: "rate-limited", status: res.status };
    if (res.status === 404 || res.status === 410) return { data: null, outcome: "not-found", status: res.status };
    if (!res.ok) return { data: null, outcome: "error", status: res.status };

    if (opts.accept === "html") {
      const text = await res.text();
      return { data: text.slice(0, 200_000) as any, outcome: "ok", status: res.status };
    }
    const ct = res.headers.get("content-type") || "";
    if ((opts.requireJson ?? true) && !ct.includes("json")) return { data: null, outcome: "error", status: res.status };
    return { data: await res.json(), outcome: "ok", status: res.status };
  } catch {
    return { data: null, outcome: "error" };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch with caching, OPSEC posture and an explicit outcome. Never throws.
 * `outcome` lets the caller tell "this account does not exist" (not-found) apart from
 * "we could not check" (rate-limited / blocked / error) — which the UI must show
 * differently, or it reports a false negative.
 */
export async function fetchJSON<T = any>(url: string, opts: FetchOpts = {}): Promise<FetchResult<T>> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const store = cacheStore();
  const key = (opts.accept === "html" ? "H:" : "J:") + url;

  if (!opts.noCache) {
    const hit = await store.get(key, ttl);
    if (hit !== null) {
      try { return { ...(JSON.parse(hit) as FetchResult<T>), cached: true }; } catch { /* fall through */ }
    }
  }

  const result = await rawFetch(url, opts);

  // Never cache a rate-limit or a policy refusal: the limit lifts, and the posture may
  // change — caching either would freeze a temporary condition into a permanent answer.
  if (!opts.noCache && result.outcome !== "rate-limited" && result.outcome !== "blocked-by-policy") {
    try { await store.set(key, JSON.stringify(result)); } catch { /* best effort */ }
  }
  return result as FetchResult<T>;
}

/** HTML convenience wrapper (profile pages, OpenGraph, favicon discovery). */
export async function fetchHTML(url: string, opts: FetchOpts = {}): Promise<FetchResult<string>> {
  return fetchJSON<string>(url, { ...opts, accept: "html", requireJson: false, timeoutMs: opts.timeoutMs ?? 7000 });
}

// ---- per-scan source health, so coverage claims stay honest ----
export interface SourceHealth {
  /** sources that refused us (rate limit) — results from them are INCOMPLETE */
  rateLimited: string[];
  /** sources that errored (network/5xx) */
  failed: string[];
  /** sources not contacted because the OPSEC posture forbade it */
  blocked: string[];
}

export function newHealth(): SourceHealth {
  return { rateLimited: [], failed: [], blocked: [] };
}

export function noteOutcome(health: SourceHealth, source: string, outcome: FetchOutcome): void {
  const push = (arr: string[]) => { if (!arr.includes(source)) arr.push(source); };
  if (outcome === "rate-limited") push(health.rateLimited);
  else if (outcome === "error") push(health.failed);
  else if (outcome === "blocked-by-policy") push(health.blocked);
}

/** Human sentence for the UI. Empty string when everything answered. */
export function healthNote(health: SourceHealth): string {
  const parts: string[] = [];
  if (health.rateLimited.length) parts.push(`${health.rateLimited.join(", ")} rate-limited — results incomplete, retry later`);
  if (health.failed.length) parts.push(`${health.failed.join(", ")} unreachable`);
  if (health.blocked.length) parts.push(`${health.blocked.length} source(s) not contacted (no-touch posture)`);
  return parts.join(" · ");
}
