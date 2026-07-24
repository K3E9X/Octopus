// Infrastructure pivots — the highest-yield technique in practical OSINT, and the one
// most tools skip.
//
// People reuse infrastructure far more carelessly than they reuse usernames. Two sites
// with nothing visibly in common are the same operator when they share:
//   - an ANALYTICS ID (Google Analytics UA-/G-, Tag Manager GTM-, AdSense pub-):
//     these are per-ACCOUNT, so the same ID across domains means the same owner. It is
//     the single strongest infrastructure link that costs one page fetch.
//   - a FAVICON HASH: the Shodan-style trick. An operator's sibling infrastructure —
//     panels, staging, alternate domains — usually ships the identical favicon.
//
// Both are computed from a single fetch of the homepage, deterministic, and produce
// pivotable identifiers rather than guesses.

import { fetchHTML } from "./netfetch";
import type { Signal } from "./signals";

export interface InfraFingerprint {
  analytics: { id: string; kind: string }[];
  faviconHash?: string;
  faviconUrl?: string;
}

// Analytics identifiers are account-scoped, which is exactly why they are such a
// strong owner link. Each pattern is anchored to avoid catching random strings.
const ANALYTICS_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "Google Analytics", re: /\bUA-\d{4,10}-\d{1,4}\b/g },
  { kind: "Google Analytics 4", re: /\bG-[A-Z0-9]{8,12}\b/g },
  { kind: "Google Tag Manager", re: /\bGTM-[A-Z0-9]{6,9}\b/g },
  { kind: "Google AdSense", re: /\bca-pub-\d{12,20}\b/g },
  { kind: "Yandex Metrica", re: /\byandex_metrika[^\d]{0,20}(\d{6,10})\b/gi },
  { kind: "Facebook Pixel", re: /fbq\(\s*['"]init['"]\s*,\s*['"](\d{13,17})['"]/g },
  { kind: "Hotjar", re: /hjid\s*[:=]\s*(\d{6,9})/g },
  { kind: "Matomo/Piwik", re: /setSiteId['"\s,\]]+(\d{1,6})/g },
];

export function extractAnalytics(html: string): { id: string; kind: string }[] {
  const out: { id: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const { kind, re } of ANALYTICS_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = (m[1] ?? m[0]).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, kind });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/**
 * MurmurHash3 (32-bit) over the base64 of the icon bytes — the exact convention
 * Shodan uses for `http.favicon.hash`, so the value can be pasted straight into a
 * Shodan/Censys query to find sibling infrastructure.
 */
export function mmh3(input: string): number {
  const data = Buffer.from(input, "utf8");
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  let h1 = 0;
  const len = data.length;
  const rounded = len & ~0x3;
  for (let i = 0; i < rounded; i += 4) {
    let k1 = (data[i] & 0xff) | ((data[i + 1] & 0xff) << 8) | ((data[i + 2] & 0xff) << 16) | ((data[i + 3] & 0xff) << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }
  let k1 = 0;
  switch (len & 3) {
    case 3: k1 ^= (data[rounded + 2] & 0xff) << 16; // falls through
    case 2: k1 ^= (data[rounded + 1] & 0xff) << 8;  // falls through
    case 1:
      k1 ^= data[rounded] & 0xff;
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 | 0;
}

/** Shodan encodes the icon as base64 WITH line breaks every 76 chars before hashing. */
export function faviconHash(bytes: Uint8Array): number {
  const b64 = Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\n");
  return mmh3(b64.endsWith("\n") ? b64 : b64 + "\n");
}

/** Find the favicon URL declared in the page, falling back to /favicon.ico. */
export function faviconUrlFrom(html: string, base: string): string {
  const m = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i);
  try { return new URL(m?.[1] || "/favicon.ico", base).toString(); } catch { return base.replace(/\/$/, "") + "/favicon.ico"; }
}

/** Fetch a site's homepage and compute its pivotable infrastructure fingerprint. */
export async function fingerprintSite(domain: string): Promise<InfraFingerprint> {
  const base = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  const page = await fetchHTML(base, { timeoutMs: 8000 });
  const out: InfraFingerprint = { analytics: [] };
  if (page.outcome !== "ok" || !page.data) return out;
  out.analytics = extractAnalytics(page.data);
  const icon = faviconUrlFrom(page.data, base);
  out.faviconUrl = icon;
  // The icon is binary, so it bypasses the JSON/HTML cache layer and is fetched
  // directly. Failure is fine — the favicon is a bonus pivot, not a requirement.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(icon, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > 0 && buf.length < 2_000_000) out.faviconHash = String(faviconHash(buf));
      }
    } finally { clearTimeout(t); }
  } catch { /* favicon is optional */ }
  return out;
}

/** Turn a fingerprint into pivotable graph nodes with honest, sourced evidence. */
export function infraSignals(domain: string, fp: InfraFingerprint, collectedAt: string): { signals: Signal[]; edges: [string, string][] } {
  const domId = "domain:" + domain.toLowerCase().replace(/[^a-z0-9]/g, "");
  const signals: Signal[] = [];
  const edges: [string, string][] = [];

  for (const a of fp.analytics) {
    const id = "infra:analytics:" + a.id.toLowerCase().replace(/[^a-z0-9-]/g, "");
    signals.push({
      id, platform: "ANALYTICS ID", handle: a.id, disc: "AN", kind: "domain",
      confidence: 72, tier: "probable", status: "review", collectedAt,
      evidence: [{
        name: "Shared analytics account",
        detail: `${a.kind} ${a.id} on ${domain}. This identifier is per-ACCOUNT, so any other site carrying it is operated by the same person — search it to find sibling properties.`,
        source: "page source · deterministic", weight: 80,
      }],
    });
    edges.push([domId, id]);
  }

  if (fp.faviconHash) {
    const id = "infra:favicon:" + fp.faviconHash.replace("-", "n");
    signals.push({
      id, platform: "FAVICON HASH", handle: fp.faviconHash, disc: "FV", kind: "domain",
      confidence: 58, tier: "possible", status: "review", collectedAt,
      url: `https://www.shodan.io/search?query=http.favicon.hash%3A${encodeURIComponent(fp.faviconHash)}`,
      evidence: [{
        name: "Favicon fingerprint",
        detail: `Shodan-convention favicon hash ${fp.faviconHash} for ${domain}. Sibling infrastructure (panels, staging, alternate domains) usually ships the identical icon — pivot via Shodan/Censys.`,
        source: "favicon · mmh3 (Shodan convention)", weight: 60,
      }],
    });
    edges.push([domId, id]);
  }

  return { signals, edges };
}
