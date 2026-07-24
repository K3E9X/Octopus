// Shared network layer for the collectors: a TTL cache plus rate-limit detection.
//
// Two problems this fixes.
//  1. HONESTY. A rate-limited source (GitHub unauthenticated is 60 req/h/IP) returns
//     403/429. Treating that as "no account here" produces a SILENT FALSE NEGATIVE —
//     the worst failure mode for an investigation tool. We now distinguish
//     "not found" from "we were blocked" and report the degradation upward.
//  2. WASTE. Every pivot re-ran identical calls, which is slow AND burns the very
//     rate limit above. A short TTL cache makes deep pivots viable.

export type FetchOutcome = "ok" | "not-found" | "rate-limited" | "error";

export interface FetchResult<T = any> {
  data: T | null;
  outcome: FetchOutcome;
  status?: number;
  cached?: boolean;
}

// ---- TTL cache (per server instance; short-lived by design) ----
interface Entry { at: number; result: FetchResult }
const CACHE = new Map<string, Entry>();
const DEFAULT_TTL = 120_000; // 2 min: long enough for a multi-hop pivot, short enough to stay fresh
const MAX_ENTRIES = 500;

function cacheGet(key: string, ttl: number): FetchResult | null {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ttl) { CACHE.delete(key); return null; }
  return { ...e.result, cached: true };
}

function cacheSet(key: string, result: FetchResult): void {
  if (CACHE.size >= MAX_ENTRIES) {
    // drop the oldest ~10% so we never grow unbounded
    const drop = Math.ceil(MAX_ENTRIES * 0.1);
    let i = 0;
    for (const k of CACHE.keys()) { CACHE.delete(k); if (++i >= drop) break; }
  }
  CACHE.set(key, { at: Date.now(), result });
}

export function clearNetCache(): void { CACHE.clear(); }

/** A 403 can mean "forbidden" or "rate limited" — the headers disambiguate. */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") return true;
    if (res.headers.get("retry-after")) return true;
  }
  return false;
}

export interface FetchOpts {
  timeoutMs?: number;
  ttlMs?: number;
  headers?: Record<string, string>;
  /** skip the cache entirely (e.g. a liveness ping) */
  noCache?: boolean;
  /** require a JSON content-type (default true) */
  requireJson?: boolean;
}

/**
 * Fetch JSON with caching and an explicit outcome. Never throws.
 * `outcome` lets the caller tell "this account does not exist" (not-found) apart from
 * "we could not check" (rate-limited / error) — which the UI must surface differently.
 */
export async function fetchJSON<T = any>(url: string, opts: FetchOpts = {}): Promise<FetchResult<T>> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  if (!opts.noCache) {
    const hit = cacheGet(url, ttl);
    if (hit) return hit as FetchResult<T>;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  let result: FetchResult<T>;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: opts.headers, cache: "no-store" });
    if (isRateLimited(res)) {
      result = { data: null, outcome: "rate-limited", status: res.status };
    } else if (res.status === 404 || res.status === 410) {
      result = { data: null, outcome: "not-found", status: res.status };
    } else if (!res.ok) {
      result = { data: null, outcome: "error", status: res.status };
    } else {
      const ct = res.headers.get("content-type") || "";
      if ((opts.requireJson ?? true) && !ct.includes("json")) {
        result = { data: null, outcome: "error", status: res.status };
      } else {
        result = { data: (await res.json()) as T, outcome: "ok", status: res.status };
      }
    }
  } catch {
    result = { data: null, outcome: "error" };
  } finally {
    clearTimeout(t);
  }
  // never cache a rate-limit: the limit lifts and we want to retry on the next scan
  if (!opts.noCache && result.outcome !== "rate-limited") cacheSet(url, result);
  return result;
}

// ---- per-scan source health, so the response can be honest about coverage ----
export interface SourceHealth {
  /** sources that refused us (rate limit) — results from them are INCOMPLETE */
  rateLimited: string[];
  /** sources that errored (network/5xx) */
  failed: string[];
}

export function newHealth(): SourceHealth {
  return { rateLimited: [], failed: [] };
}

export function noteOutcome(health: SourceHealth, source: string, outcome: FetchOutcome): void {
  if (outcome === "rate-limited") { if (!health.rateLimited.includes(source)) health.rateLimited.push(source); }
  else if (outcome === "error") { if (!health.failed.includes(source)) health.failed.push(source); }
}

/** Human sentence for the UI. Empty string when everything answered. */
export function healthNote(health: SourceHealth): string {
  const parts: string[] = [];
  if (health.rateLimited.length) parts.push(`${health.rateLimited.join(", ")} rate-limited — results incomplete, retry later`);
  if (health.failed.length) parts.push(`${health.failed.join(", ")} unreachable`);
  return parts.join(" · ");
}
