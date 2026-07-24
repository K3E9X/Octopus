// Local corpora — searching data you HOLD, not data you fetch.
//
// Everything else in Octopus queries the live surface web, which has three problems for
// serious work: it announces your interest to the source, it disappears when the page
// does, and it cannot reach material that was never on the surface web (breach dumps,
// forum archives, exported channel logs, leaked databases lawfully obtained).
//
// A corpus is a local dataset the operator has already acquired. Searching it is
// SILENT — nothing leaves the machine — and repeatable, because the data does not move
// under you. In practice this is where a lot of the decisive material actually lives.
//
// Storage: Postgres when configured (indexed, shared), else an in-memory index for the
// session. Records are normalized to a minimal shape so any source format can be
// ingested by mapping it once.

import { sql, dbEnabled } from "./db";
import type { Signal } from "./signals";

export interface CorpusRecord {
  /** which dataset this came from, e.g. "collection1-2019" or "forum-x-archive" */
  corpus: string;
  /** the indexed selector: email, username, phone, hash, wallet… lowercased */
  selector: string;
  /** what kind of selector it is */
  selectorType: "email" | "username" | "phone" | "domain" | "wallet" | "hash" | "other";
  /** the record's content — a line, a row, a message. Kept verbatim for custody. */
  content: string;
  /** optional ISO date of the record itself (not of ingestion) */
  recordDate?: string;
}

export interface CorpusHit extends CorpusRecord {
  ingestedAt: number;
}

// ---- in-memory fallback (session-scoped) ----
const MEM: CorpusHit[] = [];
const MEM_MAX = 200_000;

let ready: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      await q`CREATE TABLE IF NOT EXISTS octopus_corpus (
        id           bigserial PRIMARY KEY,
        corpus       text NOT NULL,
        selector     text NOT NULL,
        selector_type text NOT NULL,
        content      text NOT NULL,
        record_date  text,
        ingested_at  bigint NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS octopus_corpus_sel ON octopus_corpus (selector)`;
      await q`CREATE INDEX IF NOT EXISTS octopus_corpus_name ON octopus_corpus (corpus)`;
    })();
  }
  await ready;
}

export const corpusPersistent = dbEnabled;

/** Ingest records. Returns how many were stored. */
export async function ingestCorpus(records: CorpusRecord[]): Promise<number> {
  const clean = records
    .filter((r) => r.selector && r.corpus)
    .map((r) => ({ ...r, selector: r.selector.trim().toLowerCase() }));
  if (!clean.length) return 0;
  const at = Date.now();

  if (!dbEnabled) {
    for (const r of clean) {
      if (MEM.length >= MEM_MAX) break;
      MEM.push({ ...r, ingestedAt: at });
    }
    return clean.length;
  }
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return 0;
    // insert in modest batches — a dump can be large and we must not blow the statement
    let n = 0;
    for (const r of clean) {
      await q`INSERT INTO octopus_corpus (corpus, selector, selector_type, content, record_date, ingested_at)
              VALUES (${r.corpus}, ${r.selector}, ${r.selectorType}, ${r.content}, ${r.recordDate || null}, ${at})`;
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Exact-selector search. Silent: nothing leaves the machine. */
export async function searchCorpus(selector: string, limit = 25): Promise<CorpusHit[]> {
  const sel = selector.trim().toLowerCase();
  if (!sel) return [];
  if (!dbEnabled) return MEM.filter((r) => r.selector === sel).slice(0, limit);
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return [];
    const rows = await q`SELECT * FROM octopus_corpus WHERE selector = ${sel} ORDER BY id DESC LIMIT ${limit}`;
    return (rows as any[]).map((r) => ({
      corpus: r.corpus, selector: r.selector, selectorType: r.selector_type,
      content: r.content, recordDate: r.record_date || undefined, ingestedAt: Number(r.ingested_at),
    }));
  } catch {
    return [];
  }
}

export async function corpusStats(): Promise<{ corpora: { name: string; records: number }[]; total: number }> {
  if (!dbEnabled) {
    const m = new Map<string, number>();
    for (const r of MEM) m.set(r.corpus, (m.get(r.corpus) || 0) + 1);
    return { corpora: [...m].map(([name, records]) => ({ name, records })), total: MEM.length };
  }
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return { corpora: [], total: 0 };
    const rows = await q`SELECT corpus, COUNT(*)::int AS n FROM octopus_corpus GROUP BY corpus ORDER BY n DESC`;
    const corpora = (rows as any[]).map((r) => ({ name: r.corpus, records: Number(r.n) }));
    return { corpora, total: corpora.reduce((s, c) => s + c.records, 0) };
  } catch {
    return { corpora: [], total: 0 };
  }
}

/**
 * Parse a plain-text dump into records. Handles the common shapes:
 *   email:password / email;password / user@host,hash / one selector per line.
 * Credentials are NEVER stored in the selector, and the content is truncated —
 * we index the fact of exposure, not a usable credential set.
 */
export function parseDump(text: string, corpus: string, max = 50_000): CorpusRecord[] {
  const out: CorpusRecord[] = [];
  const lines = text.split(/\r?\n/);
  const EMAIL = /^[^\s@:;,]+@[^\s@:;,]+\.[a-z]{2,}$/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length > 2000) continue;
    const first = line.split(/[:;,\t|]/)[0]?.trim();
    if (!first) continue;
    let type: CorpusRecord["selectorType"] = "other";
    if (EMAIL.test(first)) type = "email";
    else if (/^\+?\d[\d\s.-]{6,}$/.test(first)) type = "phone";
    else if (/^(0x[a-f0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{25,62})$/i.test(first)) type = "wallet";
    else if (/^[a-f0-9]{32,64}$/i.test(first)) type = "hash";
    else if (/^[a-z0-9._-]{3,30}$/i.test(first)) type = "username";
    else continue;
    out.push({
      corpus,
      selector: first,
      selectorType: type,
      // keep provenance, drop the secret: a password is not intelligence, its
      // existence is. This also keeps the store from becoming a credential dump.
      content: line.length > 200 ? line.slice(0, 200) + "…" : redactSecrets(line),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Mask anything after the first delimiter — that is where credentials live. */
function redactSecrets(line: string): string {
  const m = line.match(/^([^\s:;,\t|]+)([:;,\t|])(.+)$/);
  if (!m) return line;
  const secret = m[3];
  return `${m[1]}${m[2]}${secret.slice(0, 2)}${"*".repeat(Math.min(10, Math.max(0, secret.length - 2)))}`;
}

/** Corpus hits as graph nodes — sourced, and flagged as sensitive. */
export function corpusSignals(hits: CorpusHit[], collectedAt: string): Signal[] {
  const byCorpus = new Map<string, CorpusHit[]>();
  for (const h of hits) {
    const arr = byCorpus.get(h.corpus) || [];
    arr.push(h);
    byCorpus.set(h.corpus, arr);
  }
  return [...byCorpus.entries()].map(([corpus, rows]) => ({
    id: "corpus:" + corpus.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) + ":" + rows[0].selector.replace(/[^a-z0-9]/g, "").slice(0, 24),
    platform: "LOCAL CORPUS",
    handle: rows[0].selector,
    disc: "CP",
    kind: "leak" as const,
    confidence: 70,
    tier: "probable" as const,
    status: "review" as const,
    collectedAt,
    evidence: [
      {
        name: "Appears in held corpus",
        detail: `${rows.length} record(s) for "${rows[0].selector}" in "${corpus}"${rows[0].recordDate ? ` (record dated ${rows[0].recordDate})` : ""}. Searched locally — nothing left this machine.`,
        source: `local corpus · ${corpus}`,
        weight: 76,
      },
      {
        name: "Sensitive source",
        detail: "Held breach/archive material — legal basis required; credentials are redacted at ingest and must never be redistributed.",
        source: "guidance",
        weight: 15,
      },
    ],
  }));
}
