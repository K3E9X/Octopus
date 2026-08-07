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
import { harvestText } from "./exposure";

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
    // One statement per row means 50 000 round trips for one dump — over an HTTP-based
    // Postgres driver that is minutes of latency for seconds of work. Insert in blocks
    // by passing parallel arrays and expanding them server-side with unnest().
    let n = 0;
    const BLOCK = 500;
    for (let i = 0; i < clean.length; i += BLOCK) {
      const slice = clean.slice(i, i + BLOCK);
      try {
        await q`INSERT INTO octopus_corpus (corpus, selector, selector_type, content, record_date, ingested_at)
                SELECT n, s, t, c, NULLIF(d, ''), ${at}
                FROM unnest(
                  ${slice.map((r) => r.corpus)}::text[],
                  ${slice.map((r) => r.selector)}::text[],
                  ${slice.map((r) => r.selectorType)}::text[],
                  ${slice.map((r) => r.content)}::text[],
                  ${slice.map((r) => r.recordDate || "")}::text[]
                ) AS x(n, s, t, c, d)`;
        n += slice.length;
      } catch {
        // array binding is driver-dependent; fall back to row-at-a-time rather than
        // losing the dump. Slower, but the data lands.
        for (const r of slice) {
          try {
            await q`INSERT INTO octopus_corpus (corpus, selector, selector_type, content, record_date, ingested_at)
                    VALUES (${r.corpus}, ${r.selector}, ${r.selectorType}, ${r.content}, ${r.recordDate || null}, ${at})`;
            n++;
          } catch { /* skip the bad row, keep the rest */ }
        }
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export type CorpusMode = "exact" | "domain" | "prefix";

/**
 * How should this selector be matched? Exact is the default and the only one that
 * yields an identity-grade hit; the other two are SWEEPS, and are labelled as such so
 * a "10 hits at @company.com" result is never mistaken for ten hits on one person.
 *
 *   exact  — the selector as given
 *   domain — "@company.com" or "company.com": every email at that domain
 *   prefix — "marie_dub": every selector starting with it (handle families)
 */
export function corpusMode(selector: string, requested?: CorpusMode): CorpusMode {
  if (requested) return requested;
  const sel = selector.trim().toLowerCase();
  if (sel.startsWith("@") && sel.includes(".")) return "domain";
  return "exact";
}

/**
 * Search the held corpora. Silent: nothing leaves the machine, and the source is never
 * told we looked — the property that makes a corpus worth holding in the first place.
 */
export async function searchCorpus(selector: string, limit = 25, mode?: CorpusMode): Promise<CorpusHit[]> {
  const sel = selector.trim().toLowerCase();
  if (!sel) return [];
  const m = corpusMode(sel, mode);
  // a domain sweep is written as a suffix match on the email's host part
  const domain = m === "domain" ? (sel.startsWith("@") ? sel : "@" + sel) : "";

  if (!dbEnabled) {
    const pred = m === "exact"
      ? (r: CorpusHit) => r.selector === sel
      : m === "domain"
        ? (r: CorpusHit) => r.selectorType === "email" && r.selector.endsWith(domain)
        : (r: CorpusHit) => r.selector.startsWith(sel);
    return MEM.filter(pred).slice(0, limit);
  }
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return [];
    const rows = m === "exact"
      ? await q`SELECT * FROM octopus_corpus WHERE selector = ${sel} ORDER BY id DESC LIMIT ${limit}`
      : m === "domain"
        ? await q`SELECT * FROM octopus_corpus WHERE selector_type = 'email' AND selector LIKE ${"%" + domain} ORDER BY id DESC LIMIT ${limit}`
        : await q`SELECT * FROM octopus_corpus WHERE selector LIKE ${sel + "%"} ORDER BY id DESC LIMIT ${limit}`;
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

/**
 * Detect the format and parse accordingly. Real material does not arrive as tidy
 * `email:password` lines: it arrives as a Telegram export, a CSV with a header, a
 * JSONL scrape, or a database dump pasted as text. Making the analyst pre-convert it
 * is how a corpus feature ends up unused.
 */
export function parseCorpus(text: string, corpus: string, max = 50_000): CorpusRecord[] {
  const head = text.slice(0, 4096).trim();
  if (!head) return [];

  // JSON: a Telegram/Discord export object, or an array of records
  if (head[0] === "{" || head[0] === "[") {
    const asJson = parseJsonCorpus(text, corpus, max);
    if (asJson.length) return asJson;
    // JSONL: one object per line
    const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
    if (lines.length > 1) {
      const out: CorpusRecord[] = [];
      for (const line of lines) {
        try { out.push(...recordsFromObject(JSON.parse(line), corpus)); } catch { /* skip */ }
        if (out.length >= max) break;
      }
      if (out.length) return out.slice(0, max);
    }
  }

  // CSV/TSV with a header naming the columns
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  if (/[;,\t]/.test(firstLine) && /\b(email|e-mail|mail|username|user|login|phone|tel|msisdn)\b/i.test(firstLine)) {
    const csv = parseDelimited(text, corpus, max);
    if (csv.length) return csv;
  }

  return parseDump(text, corpus, max);
}

function parseJsonCorpus(text: string, corpus: string, max: number): CorpusRecord[] {
  let data: any;
  try { data = JSON.parse(text); } catch { return []; }
  const out: CorpusRecord[] = [];
  // Telegram desktop export: { messages: [ { from, from_id, text, date } ] }
  const rows: any[] = Array.isArray(data) ? data
    : Array.isArray(data?.messages) ? data.messages
    : Array.isArray(data?.records) ? data.records
    : Array.isArray(data?.data) ? data.data
    : [];
  for (const row of rows) {
    out.push(...recordsFromObject(row, corpus));
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

const FIELD_MAP: { keys: RegExp; type: CorpusRecord["selectorType"] }[] = [
  { keys: /^(e-?mail|mail|email_address)$/i, type: "email" },
  { keys: /^(user(name)?|login|handle|nick(name)?|from|author|screen_?name)$/i, type: "username" },
  { keys: /^(phone|tel|telephone|mobile|msisdn|number)$/i, type: "phone" },
  { keys: /^(domain|host|site)$/i, type: "domain" },
  { keys: /^(wallet|address|btc|eth)$/i, type: "wallet" },
  { keys: /^(hash|password_hash|md5|sha1|sha256)$/i, type: "hash" },
];

/** Pull every recognisable selector out of one structured record. */
function recordsFromObject(obj: any, corpus: string): CorpusRecord[] {
  if (!obj || typeof obj !== "object") return [];
  const out: CorpusRecord[] = [];
  const date = String(obj.date || obj.timestamp || obj.created_at || "").slice(0, 32) || undefined;
  // the record's own text, kept verbatim for custody but bounded
  const body = typeof obj.text === "string" ? obj.text
    : Array.isArray(obj.text) ? obj.text.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("")
    : JSON.stringify(obj);
  const content = body.length > 300 ? body.slice(0, 300) + "…" : body;

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const val = String(v).trim();
    if (!val || val.length > 200) continue;
    const hit = FIELD_MAP.find((f) => f.keys.test(k));
    if (!hit) continue;
    // a "from" field holding a display name is not a selector — require selector shape
    if (hit.type === "username" && !/^[a-z0-9._-]{3,40}$/i.test(val)) continue;
    if (hit.type === "email" && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(val)) continue;
    out.push({ corpus, selector: val, selectorType: hit.type, content: redactIfCredential(content), recordDate: date });
  }
  return out;
}

/** CSV/TSV with a header row: index every column that names a selector. */
function parseDelimited(text: string, corpus: string, max: number): CorpusRecord[] {
  const lines = text.split(/\r?\n/);
  const header = lines[0];
  const delim = header.includes("\t") ? "\t" : header.includes(";") ? ";" : ",";
  const cols = header.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
  const wanted = cols.map((c) => FIELD_MAP.find((f) => f.keys.test(c))?.type || null);
  if (!wanted.some(Boolean)) return [];

  const out: CorpusRecord[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(delim);
    for (let i = 0; i < cells.length && i < wanted.length; i++) {
      const type = wanted[i];
      if (!type) continue;
      const val = cells[i].trim().replace(/^"|"$/g, "");
      if (!val || val.length > 200) continue;
      if (type === "email" && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(val)) continue;
      out.push({
        corpus, selector: val, selectorType: type,
        content: redactIfCredential(line.length > 300 ? line.slice(0, 300) + "…" : line),
      });
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/**
 * Redact only what looks like a credential. Blanket redaction destroys the value of a
 * message archive — "hey, call me on 06…" is intelligence, not a secret — so we mask
 * only when the tail after the delimiter is a single unbroken token, which is what a
 * password or hash looks like and a sentence does not.
 */
function redactIfCredential(line: string): string {
  return /^[^\s:;,\t|]+[:;,\t|]\S{3,}$/.test(line) ? redactSecrets(line) : line;
}

/** Mask anything after the first delimiter — that is where credentials live. */
function redactSecrets(line: string): string {
  const m = line.match(/^([^\s:;,\t|]+)([:;,\t|])(.+)$/);
  if (!m) return line;
  const secret = m[3];
  return `${m[1]}${m[2]}${secret.slice(0, 2)}${"*".repeat(Math.min(10, Math.max(0, secret.length - 2)))}`;
}

/**
 * Corpus hits as graph nodes.
 *
 * This used to report "N record(s) found" and then never show a record — the `content`
 * field, the entire reason the corpus exists, was dropped on the floor. The records are
 * now the node's exposure, and the addresses, URLs and IPs inside them are lifted out
 * so they can be read and pivoted on instead of sitting buried in a string.
 */
export function corpusSignals(hits: CorpusHit[], collectedAt: string): Signal[] {
  const byCorpus = new Map<string, CorpusHit[]>();
  for (const h of hits) {
    const arr = byCorpus.get(h.corpus) || [];
    arr.push(h);
    byCorpus.set(h.corpus, arr);
  }
  return [...byCorpus.entries()].map(([corpus, rows]) => {
    const exposure = harvestText(rows.map((r) => r.content), `Record · ${corpus}`);
    const creds = exposure.filter((e) => e.kind === "credential");
    const dates = [...new Set(rows.map((r) => r.recordDate).filter(Boolean) as string[])].sort();
    return {
      id: "corpus:" + corpus.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) + ":" + rows[0].selector.replace(/[^a-z0-9]/g, "").slice(0, 24),
      platform: "LOCAL CORPUS",
      handle: rows[0].selector,
      disc: "CP",
      kind: "leak" as const,
      confidence: 70,
      tier: "probable" as const,
      status: "review" as const,
      collectedAt,
      createdAt: dates[0],
      exposure,
      evidence: [
        {
          name: "Appears in held corpus",
          detail: `${rows.length} record(s) for "${rows[0].selector}" in "${corpus}"${dates.length ? ` (dated ${dates[0]}${dates.length > 1 ? ` → ${dates[dates.length - 1]}` : ""})` : ""}. Searched locally — nothing left this machine.`,
          source: `local corpus · ${corpus}`,
          weight: 76,
        },
        // the records ARE the finding: showing the first few here is what makes this
        // node worth opening, and the rest are in EXPOSURE
        {
          name: `Records (${rows.length})`,
          detail: rows.slice(0, 6).map((r) => r.content).join("\n") + (rows.length > 6 ? `\n… +${rows.length - 6} more in EXPOSURE` : ""),
          source: `local corpus · ${corpus}`,
          weight: 78,
        },
        ...(creds.length ? [{
          name: "Credentials in record",
          detail: creds.slice(0, 8).map((c) => c.value + (c.masked ? " (masked at ingest)" : "")).join("  ·  ") + (creds.length > 8 ? `  … +${creds.length - 8} more` : ""),
          source: `local corpus · ${corpus}`,
          weight: 84,
        }] : []),
        {
          name: "Sensitive source",
          detail: "Held breach/archive material — legal basis required, and it must never be redistributed. Credential tails are masked at ingest.",
          source: "guidance",
          weight: 15,
        },
      ],
    };
  });
}
