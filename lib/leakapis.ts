// Breach sources that need a key — the ones that return everything in clear.
//
// The free tier is where this tool starts, not where it stops. Hudson Rock masks,
// ProxyNova only holds the COMB corpus, and LeakCheck's public endpoint deliberately
// withholds content. An analyst with a budget can have all of it, and the difference is
// an API key, not a different tool.
//
// Four providers, one shape. Each returns ExposureItem so everything merges into the
// same panel as the keyless sources, with per-row attribution — so you can see exactly
// what the paid key bought you over what was already free.
//
// Keys arrive per request from the analyst's browser (lib/reqconfig) or from the
// environment. They are never logged, never persisted, and a provider with no key is
// simply absent — never a silent empty result, because "no key configured" and "no
// breach found" are opposite findings.

import { harvest, type ExposureItem } from "./exposure";

export interface LeakKeys {
  /** Dehashed: "email:apikey" — their auth is HTTP basic with the account email */
  dehashed?: string;
  /** Snusbase activation token */
  snusbase?: string;
  /** LeakCheck Pro API key */
  leakcheck?: string;
  /** Hudson Rock paid API key — same endpoints, unmasked */
  hudsonrock?: string;
}

export type ProviderId = "dehashed" | "snusbase" | "leakcheck-pro" | "hudsonrock-pro";

export interface ProviderResult {
  id: ProviderId;
  items: ExposureItem[];
  /** absent key, HTTP error, quota — anything that is NOT "no result" */
  problem?: string;
}

const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";

async function req(url: string, init: RequestInit, ms = 15000): Promise<{ data?: any; problem?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return { problem: "key rejected" };
    if (res.status === 429) return { problem: "rate limited or quota exhausted" };
    if (!res.ok) return { problem: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { problem: String(e).includes("abort") ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Every provider returns records shaped like flat objects with wildly different field
 * names. Rather than four hand-written mappers that go stale, harvest each record and
 * stamp the provenance — the same schema-agnostic approach that fixed the original
 * drop-everything bug, applied to sources whose schemas we cannot test against here.
 */
function fromRecords(records: any[], source: string, cap = 200): ExposureItem[] {
  const out: ExposureItem[] = [];
  for (const r of records.slice(0, cap)) {
    for (const item of harvest(r)) {
      out.push({ ...item, source });
      if (out.length >= 600) return out;
    }
  }
  return out;
}

/** Pull the record array out of a response without betting on its key. */
function recordsFrom(d: any): any[] {
  if (!d || typeof d !== "object") return [];
  for (const k of ["entries", "results", "result", "found", "records", "data", "lines"]) {
    const v = (d as any)[k];
    if (Array.isArray(v)) return v;
    // Snusbase nests results per database: { results: { "DumpName": [ ... ] } }
    if (v && typeof v === "object") {
      const nested = Object.values(v).filter(Array.isArray).flat();
      if (nested.length) return nested as any[];
    }
  }
  return [];
}

// ---- Dehashed ------------------------------------------------------------------

export async function dehashed(term: string, key: string): Promise<ProviderResult> {
  const [email, apiKey] = key.includes(":") ? [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)] : ["", key];
  if (!email || !apiKey) {
    return { id: "dehashed", items: [], problem: 'Dehashed needs "account-email:api-key" — their auth is HTTP basic' };
  }
  const auth = typeof btoa === "function" ? btoa(`${email}:${apiKey}`) : Buffer.from(`${email}:${apiKey}`).toString("base64");
  const { data, problem } = await req(
    `https://api.dehashed.com/search?query=${encodeURIComponent(term)}&size=100`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (problem) return { id: "dehashed", items: [], problem };
  return { id: "dehashed", items: fromRecords(recordsFrom(data), "dehashed") };
}

// ---- Snusbase ------------------------------------------------------------------

export async function snusbase(term: string, key: string, type = "email"): Promise<ProviderResult> {
  const { data, problem } = await req("https://api.snusbase.com/data/search", {
    method: "POST",
    headers: { Auth: key, "Content-Type": "application/json" },
    body: JSON.stringify({ terms: [term], types: [type], wildcard: false }),
  });
  if (problem) return { id: "snusbase", items: [], problem };
  return { id: "snusbase", items: fromRecords(recordsFrom(data), "snusbase") };
}

// ---- LeakCheck Pro --------------------------------------------------------------

export async function leakCheckPro(term: string, key: string): Promise<ProviderResult> {
  const { data, problem } = await req(
    `https://leakcheck.io/api/v2/query/${encodeURIComponent(term)}`,
    { headers: { "X-API-Key": key } },
  );
  if (problem) return { id: "leakcheck-pro", items: [], problem };
  return { id: "leakcheck-pro", items: fromRecords(recordsFrom(data), "leakcheck-pro") };
}

// ---- Hudson Rock, paid ----------------------------------------------------------

export async function hudsonRockPro(term: string, key: string, isEmail: boolean): Promise<ProviderResult> {
  const path = isEmail ? `search-by-email?email=${encodeURIComponent(term)}` : `search-by-username?username=${encodeURIComponent(term)}`;
  const { data, problem } = await req(
    `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/${path}`,
    { headers: { "api-key": key } },
  );
  if (problem) return { id: "hudsonrock-pro", items: [], problem };
  const stealers = Array.isArray(data?.stealers) ? data.stealers : [];
  return { id: "hudsonrock-pro", items: fromRecords(stealers, "hudsonrock-pro") };
}

// ---- all of them ----------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const anyLeakKey = (k: LeakKeys) => Boolean(k.dehashed || k.snusbase || k.leakcheck || k.hudsonrock);

/**
 * Query every configured provider concurrently.
 *
 * A provider with no key is NOT reported as a problem — it was never asked. A provider
 * that WAS asked and did not answer is reported, because a rejected key and a clean
 * record look identical from the outside and only one of them means "nothing found".
 */
export async function leakApis(term: string, keys: LeakKeys): Promise<{ items: ExposureItem[]; problems: { id: string; problem: string }[]; reached: string[] }> {
  const isEmail = EMAIL_RE.test(term);
  const jobs: Promise<ProviderResult>[] = [];
  if (keys.dehashed) jobs.push(dehashed(term, keys.dehashed));
  if (keys.snusbase) jobs.push(snusbase(term, keys.snusbase, isEmail ? "email" : "username"));
  if (keys.leakcheck) jobs.push(leakCheckPro(term, keys.leakcheck));
  if (keys.hudsonrock) jobs.push(hudsonRockPro(term, keys.hudsonrock, isEmail));
  if (!jobs.length) return { items: [], problems: [], reached: [] };

  const settled = await Promise.allSettled(jobs);
  const items: ExposureItem[] = [];
  const problems: { id: string; problem: string }[] = [];
  const reached: string[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") { problems.push({ id: "provider", problem: "threw" }); continue; }
    if (r.value.problem) problems.push({ id: r.value.id, problem: r.value.problem });
    else reached.push(r.value.id);
    items.push(...r.value.items);
  }
  return { items, problems, reached };
}
