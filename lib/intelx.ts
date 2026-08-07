// Intelligence X connector — breaches / pastes / darkweb / historical data.
// Requires an API key (freemium): set INTELX_API_KEY (and optionally INTELX_URL).
// Sensitive source — use under a legal basis; never redistribute credentials.

import { normId } from "./extract";
import type { Signal } from "./signals";
import { harvest } from "./exposure";

const ENV_KEY = process.env.INTELX_API_KEY || "";
const DEFAULT_BASE = (process.env.INTELX_URL || "https://2.intelx.io").replace(/\/$/, "");
const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";

export interface IntelxCreds { key?: string; url?: string; }
export const intelxConfigured = (c?: IntelxCreds) => (c?.key || ENV_KEY).length > 0;

function ix(path: string, key: string, base: string, init: RequestInit = {}) {
  return fetch(base + path, { ...init, headers: { ...(init.headers || {}), "x-key": key, "User-Agent": UA }, cache: "no-store" });
}

/**
 * A record as a node. The whole record is harvested rather than three fields off the
 * top: a leak node that names a dump and shows nothing from it is a dead end, and the
 * `systemid` gives a direct link back into Intelligence X for the item itself.
 */
function toNode(rec: any): Signal {
  const name = String(rec.name || rec.systemid || "leak record").slice(0, 48);
  const bucket = String(rec.bucket || "leak");
  const date = rec.date ? String(rec.date).slice(0, 10) : "";
  const link = rec.systemid ? `https://intelx.io/?did=${encodeURIComponent(String(rec.systemid))}` : undefined;
  const exposure = harvest(rec);
  return {
    id: "leak:" + (rec.systemid || normId(name)),
    platform: bucket.toUpperCase().slice(0, 18),
    handle: name,
    disc: "LK",
    kind: "leak",
    confidence: 50,
    tier: "possible",
    status: "review",
    url: link,
    createdAt: date || undefined,
    exposure,
    evidence: [
      { name: "Appears in leak / paste", detail: `${name} · ${bucket}${date ? " · " + date : ""}`, source: "intelx.io", weight: 62, url: link },
      ...(link ? [{ name: "Open the record", detail: "The item itself on Intelligence X — content requires your account's access level.", source: "intelx.io", weight: 20, url: link }] : []),
      { name: "Sensitive source", detail: "Breach/leak data — handle under a legal basis; do not redistribute credentials.", source: "guidance", weight: 15 },
    ],
  };
}

export async function searchIntelX(term: string, creds?: IntelxCreds, max = 8): Promise<Signal[]> {
  const key = creds?.key || ENV_KEY;
  const base = (creds?.url || DEFAULT_BASE).replace(/\/$/, "");
  if (!key || !term) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const start = await ix("/intelligent/search", key, base, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ term, maxresults: max, media: 0, sort: 2, timeout: 5, terminate: [] }),
      });
      if (!start.ok) return [];
      const { id } = await start.json();
      if (!id) return [];
      let records: any[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await ix(`/intelligent/search/result?id=${encodeURIComponent(id)}&limit=${max}`, key, base, { signal: ctrl.signal });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.records) && d.records.length) { records = d.records; break; }
          if (d.status === 1 || d.status === 2) break; // done / not found
        }
        await new Promise((res) => setTimeout(res, 700));
      }
      return records.slice(0, max).map(toNode);
    } finally {
      clearTimeout(t);
    }
  } catch {
    return [];
  }
}
