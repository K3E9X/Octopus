// LeakOSINT — the primary leak source.
//
// Everything else in this tool asks an index whether an identity APPEARS somewhere.
// This one returns the records: which database, what that database was, and the rows
// themselves — names, phones, addresses, documents, credentials. That is why it is the
// source the tool is now built around rather than one connector among several.
//
// Three things the raw API does not give you, and this module does:
//
//   COST BEFORE YOU SPEND IT. The endpoint bills per request on a published formula and
//   says nothing about the price until the money is gone. The formula is reimplemented
//   here so the interface can quote the query before it runs. The word-counting rules
//   are the subtle part and they are where the money is: a three-word query is sixteen
//   times the complexity of a one-word query, and a four-word one is forty.
//
//   THE RATE LIMIT IS OURS TO RESPECT. Three requests per second per IP. A burst gets
//   refused, and a refusal that is not distinguished from "no result" is how a scan
//   silently under-reports. Requests are spaced locally instead.
//
//   PROVENANCE SURVIVES. The response is grouped BY DATABASE with an `InfoLeak`
//   description of what that breach was. Flattening that into one list would throw away
//   the single most useful thing it returns — which dump a fact came from.
//
//   AN ERROR IS NOT A RESULT. The endpoint answers HTTP 200 to everything, including a
//   refusal, and signals it only in the body — under two different keys. The published
//   documentation says "Error code"; the live endpoint sends "error". Both are read
//   here, before anything else touches the payload, because reading a refusal as data
//   is the worst bug this module can have: "the API refused" and "this person is clean"
//   are opposite findings that look identical from the outside. The vendor's own Python
//   sample checks only "Error code" and raises a KeyError on the live shape.
//
// The contract this implements is written down in docs/leakosint-api.md, including the
// places the documentation and the live endpoint disagree. Everything above is checked
// against it by tests/leakosint.test.ts — the price especially, because that number is
// what the business resells and a drift in it is a drift in the margin.

import { harvest, type ExposureItem, type ExposureKind } from "./exposure";

const ENDPOINT = process.env.LEAKOSINT_URL || "https://leakosintapi.com/";
const UA = "Octopus-OSINT/0.1";

export interface LeakOsintOpts {
  token: string;
  /** one query, or several run as a batch in a single billed request */
  request: string | string[];
  /** 100–10000. Raises both the result count and the price. */
  limit?: number;
  lang?: string;
  botName?: string;
  timeoutMs?: number;
}

export interface LeakDatabase {
  /** the dump's name, as the source gives it */
  name: string;
  /** what that breach was — the provenance line the API ships per database */
  info: string;
  /** the rows, column name → value, verbatim */
  rows: Record<string, string>[];
}

export interface LeakOsintResult {
  databases: LeakDatabase[];
  /** flattened, classified, ready for the graph */
  items: ExposureItem[];
  /** rows across every database */
  rowCount: number;
  /** the API's own error string, when it refused */
  error?: string;
  /** what this call was quoted at before it ran */
  cost: number;
  /** the API said the query ran and matched nothing — NOT the same as an error */
  empty: boolean;
}

// ---- cost ----------------------------------------------------------------------

const DATE_RE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/**
 * Split a query the way the biller does.
 *
 * Double-quoted spans are ONE token — that is the documented escape hatch for keeping
 * a phrase together, and it is also the cheapest way to query a full name, because it
 * drops complexity from 16 to 1.
 */
export function tokenize(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) out.push((m[1] ?? m[2]).trim());
  return out.filter(Boolean);
}

/** Does this token count towards complexity? Dates, short strings and short numbers do not. */
export function isBillableWord(tok: string): boolean {
  if (DATE_RE.test(tok)) return false;
  if (tok.length < 4) return false;
  if (/^\d+$/.test(tok) && tok.length < 6) return false;
  return true;
}

export function complexityOf(query: string): number {
  const n = tokenize(query).filter(isBillableWord).length;
  if (n <= 1) return 1;
  if (n === 2) return 5;
  if (n === 3) return 16;
  return 40;
}

/** The published formula: 0.0002 * (5 + sqrt(limit * complexity)), in dollars. */
export function estimateCost(request: string | string[], limit = 100): number {
  // A newline separates queries whether it arrives inside the string form or inside an
  // element of the array form; only the string form was being split, so a batch like
  // ["a@b.com\nc@d.com"] was quoted as one query and billed us for two. Undercharging is
  // the only error here that loses real money, and the array form is the documented way
  // to send a batch.
  const queries = (Array.isArray(request) ? request : [request])
    .flatMap((q) => String(q ?? "").split("\n"));
  // a batch is billed per query; the caller sees the total it is about to spend
  return queries
    .map((q) => q.trim())
    .filter(Boolean)
    .reduce((sum, q) => sum + 0.0002 * (5 + Math.sqrt(limit * complexityOf(q))), 0);
}

/** Formatted for a human about to approve a spend. */
export const formatCost = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);

// ---- rate limit ------------------------------------------------------------------
// 3 requests per second per IP. Exceeding it gets refused, and a refusal that is not
// told apart from "no result" is how a sweep silently under-reports.

const MIN_GAP_MS = 350;
let lastCall = 0;
let chain: Promise<void> = Promise.resolve();

function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  });
  chain = run.catch(() => {});
  return run.then(fn);
}

// ---- column classification ---------------------------------------------------------
// The rows come back with the dump's OWN column names, which vary by database. These
// map the common ones onto the graph's vocabulary; anything unrecognised falls through
// to the generic harvester and is shown under its own column name rather than dropped.

const COLUMN_RULES: { re: RegExp; kind: ExposureKind }[] = [
  { re: /pass(word|wd)?|pwd|hash|secret/i, kind: "credential" },
  { re: /e-?mail/i, kind: "email" },
  // Activity timestamps, recognised BEFORE the identifier rule because "LastLogin"
  // contains "login" and would otherwise be read as the login itself. These are
  // metadata about an account, not data that leaked about a person, and the report
  // drops them — so misreading one puts a date in front of the reader as a finding.
  { re: /last.?(active|seen|login|visit|update)|reg(istration)?.?date|sign.?up|joined|created.?at|updated.?at|modified/i, kind: "date" },
  // Platform IDs come BEFORE phone on purpose: "Telegram ID" contains "tel", so an
  // unanchored phone rule claimed every Telegram column as a phone number. Short
  // tokens here are word-bounded for the same reason.
  { re: /nick|login|user.?name|account|profile|telegram|facebook|instagram|twitter|\bvk\b|\bok\b/i, kind: "identifier" },
  { re: /phone|telephone|\btel\b|mobile|msisdn|numero/i, kind: "phone" },
  { re: /full.?name|^name$|first.?name|last.?name|surname|patronymic|\bfio\b/i, kind: "name" },
  { re: /address|street|city|region|country|postal|\bzip\b|geo/i, kind: "address" },
  { re: /passport|document|\binn\b|snils|\bvin\b|licen[cs]e|id.?card|doc.?num/i, kind: "document" },
  { re: /(^|_)ips?$|ip.?addr/i, kind: "ip" },
  { re: /date|birth|bday|created|registered|updated/i, kind: "date" },
  { re: /url|link|site|domain/i, kind: "login" },
];

function classifyColumn(column: string, value: string): ExposureKind {
  if (/^https?:\/\//i.test(value)) return "login";
  for (const r of COLUMN_RULES) if (r.re.test(column)) return r.kind;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  if (/^\+?\d[\d\s().-]{7,}$/.test(value)) return "phone";
  return "other";
}

/** Values the dumps use to mean "this column is empty". */
const NULLISH = new Set(["", "-", "—", "n/a", "na", "null", "none", "undefined", "0", "unknown"]);

/**
 * One row → typed items, keeping the dump's own column name as the label.
 *
 * Exported because the report builder works from ROWS, not from the flattened item
 * list: attribution is a per-row judgement, and a row is the only place where the
 * association between a login and a secret actually exists.
 */
export function itemsFromRow(db: { name: string }, row: Record<string, string>): ExposureItem[] {
  const out: ExposureItem[] = [];
  const source = `leakosint · ${db.name}`;
  for (const [col, raw] of Object.entries(row)) {
    const value = String(raw ?? "").trim();
    if (!value || NULLISH.has(value.toLowerCase())) continue;
    out.push({ kind: classifyColumn(col, value), label: col, value, source });
  }
  // the whole row as one line, so credential reuse and the record view have something
  // to pair a login with a secret inside — the association only exists within a row
  const login = out.find((i) => i.kind === "email" || i.kind === "identifier" || i.kind === "phone");
  const secret = out.find((i) => i.kind === "credential");
  if (login && secret) {
    out.push({ kind: "record", label: `Row · ${db.name}`, value: `${login.value}:${secret.value}`, source });
  }
  return out;
}

// ---- the call -----------------------------------------------------------------------

/**
 * Did the endpoint refuse?
 *
 * It answers 200 with the reason in the body, and it has used more than one key for it:
 * "error" is what the live API sends for an invalid token and for the rate limit,
 * "Error code" is what the documentation describes. Both are read, plus the capitalised
 * variants, because the cost of missing one is reporting a refusal as a clean result.
 */
const ERROR_KEYS = ["error", "Error", "Error code", "error_code", "errorCode", "ErrorCode"];

export function refusalIn(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  for (const k of ERROR_KEYS) {
    const v = (payload as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  // Observed alongside "Error code": a sibling {"Status":"Error"}. Read as a backstop so
  // a refusal that renames its message field still cannot come back as a result.
  const status = (payload as Record<string, unknown>).Status;
  if (typeof status === "string" && status.toLowerCase() === "error") return "the source reported an error";
  return null;
}

/** The key the API uses to say "ran fine, matched nothing". */
const NO_RESULTS = "No results found";

function parseList(payload: any): LeakDatabase[] {
  const list = payload?.List;
  if (!list || typeof list !== "object") return [];
  const out: LeakDatabase[] = [];
  for (const [name, body] of Object.entries<any>(list)) {
    if (name === NO_RESULTS) continue;
    const rows: Record<string, string>[] = Array.isArray(body?.Data)
      ? body.Data.filter((r: any) => r && typeof r === "object")
      : [];
    out.push({ name, info: String(body?.InfoLeak || "").trim(), rows });
  }
  return out;
}

export async function leakOsint(opts: LeakOsintOpts): Promise<LeakOsintResult> {
  const limit = Math.max(100, Math.min(10000, opts.limit ?? 100));
  const cost = estimateCost(opts.request, limit);
  const empty: LeakOsintResult = { databases: [], items: [], rowCount: 0, cost, empty: true };

  if (!opts.token) return { ...empty, error: "no LeakOSINT token configured" };

  const body: Record<string, unknown> = {
    token: opts.token,
    request: opts.request,
    limit,
    lang: opts.lang || "en",
    type: "json",
  };
  if (opts.botName) body.bot_name = opts.botName;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25000);
  try {
    const res = await spaced(() =>
      fetch(ENDPOINT, {
        method: "POST",
        // the API answers 501 to a form-encoded body; it must be JSON
        headers: { "content-type": "application/json", Accept: "application/json", "User-Agent": UA },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      }),
    );
    if (!res.ok) return { ...empty, error: `HTTP ${res.status}` };
    const data = await res.json();
    const refusal = refusalIn(data);
    if (refusal) return { ...empty, error: refusal };

    const databases = parseList(data);
    const items: ExposureItem[] = [];
    for (const db of databases) {
      if (db.info) items.push({ kind: "breach", label: db.name, value: db.info, source: `leakosint · ${db.name}` });
      else items.push({ kind: "breach", label: "Database", value: db.name, source: "leakosint" });
      for (const row of db.rows) items.push(...itemsFromRow(db, row));
    }

    // A clean miss arrives as a database literally named "No results found", which
    // parseList skips — leaving `items` empty and sending the salvage harvester over the
    // payload, which faithfully turned "No results found. Try changing your request."
    // into a finding. That is the same mistake as reading a refusal as data, one layer
    // down. A recognised empty answer is an answer; it is never salvaged.
    const list = (data as any)?.List;
    const onlyEmpty = list && typeof list === "object" && Object.keys(list).every((k) => k === NO_RESULTS);
    if (onlyEmpty) return { databases: [], items: [], rowCount: 0, cost, empty: true };

    // The documented shape yielded nothing but the endpoint answered: harvest the raw
    // payload rather than report a clean result off a response we simply failed to read.
    if (!items.length && data && Object.keys(data).length) {
      const salvaged = harvest(data).map((i) => ({ ...i, source: "leakosint · unparsed" }));
      if (salvaged.length) return { databases: [], items: salvaged, rowCount: 0, cost, empty: false };
    }

    const rowCount = databases.reduce((n, d) => n + d.rows.length, 0);
    return { databases, items, rowCount, cost, empty: rowCount === 0 };
  } catch (e) {
    return { ...empty, error: String(e).includes("abort") ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}
