// LeakOSINT, the primary leak source.
//
// Everything else in this tool asks an index whether an identity APPEARS somewhere.
// This one returns the records: which database, what that database was, and the rows
// themselves, names, phones, addresses, documents, credentials. That is why it is the
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
//   the single most useful thing it returns, which dump a fact came from.
//
//   AN ERROR IS NOT A RESULT. The endpoint answers HTTP 200 to everything, including a
//   refusal, and signals it only in the body, under two different keys. The published
//   documentation says "Error code"; the live endpoint sends "error". Both are read
//   here, before anything else touches the payload, because reading a refusal as data
//   is the worst bug this module can have: "the API refused" and "this person is clean"
//   are opposite findings that look identical from the outside. The vendor's own Python
//   sample checks only "Error code" and raises a KeyError on the live shape.
//
// The contract this implements is written down in docs/leakosint-api.md, including the
// places the documentation and the live endpoint disagree. Everything above is checked
// against it by tests/leakosint.test.ts, the price especially, because that number is
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
  /** what that breach was, the provenance line the API ships per database */
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
  /** the API said the query ran and matched nothing: NOT the same as an error */
  empty: boolean;
  /** when unreadable: the payload's top-level key names, so a shape change is diagnosable */
  shape?: string;
  /**
   * The endpoint answered with a body we could not read.
   *
   * This is a THIRD state, and conflating it with either of the other two is how the
   * module's whole purpose fails. The caller builds its report from `databases`, so a
   * payload the parser does not recognise produced an empty database list and rendered
   * as "nothing found", a clean bill of health off a response nobody understood. The
   * salvage harvester was supposed to catch this, but its output lands in `items`,
   * which no caller reads. So the fact is reported instead of being papered over.
   */
  unreadable?: boolean;
}

// ---- cost ----------------------------------------------------------------------

const DATE_RE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/**
 * Split a query the way the biller does.
 *
 * Double-quoted spans are ONE token, that is the documented escape hatch for keeping
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
  // drops them, so misreading one puts a date in front of the reader as a finding.
  { re: /last.?(active|seen|login|visit|update)|reg(istration)?.?date|sign.?up|joined|created.?at|updated.?at|modified/i, kind: "date" },
  // Platform IDs come BEFORE phone on purpose: "Telegram ID" contains "tel", so an
  // unanchored phone rule claimed every Telegram column as a phone number. Short
  // tokens here are word-bounded for the same reason.
  { re: /nick|login|user.?name|account|profile|telegram|facebook|instagram|twitter|\bvk\b|\bok\b|\buids?\b|user.?id|member.?id/i, kind: "identifier" },
  { re: /phone|telephone|\btel\b|mobile|msisdn|numero/i, kind: "phone" },
  { re: /full.?name|^name$|first.?name|last.?name|surname|patronymic|\bfio\b/i, kind: "name" },
  // IP BEFORE ADDRESS, because "ip_address" contains "address" and was being filed as
  // somewhere the subject lives. And the last alternative is deliberately
  // case-SENSITIVE: "OrderIP" and "RegIP" end in it, "zip" and "zips" end in the same
  // three letters and are postcodes. Nothing else tells those apart, there is no word
  // boundary inside "zip", and a case-insensitive suffix match claims both.
  { re: /\b[Ii][Pp]s?\b|[Ii][Pp][-_. ]?[Aa]ddr|_[Ii][Pp]s?$|IPs?$/, kind: "ip" },
  { re: /address|street|city|region|country|postal|\bzip\b|geo/i, kind: "address" },
  { re: /passport|document|\binn\b|snils|\bvin\b|licen[cs]e|id.?card|doc.?num/i, kind: "document" },
  { re: /date|birth|bday|created|registered|updated/i, kind: "date" },
  { re: /url|link|site|domain/i, kind: "login" },
];

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Is this value a phone number, when the column name would not say?
 *
 * A LONG RUN OF DIGITS IS NOT A PHONE NUMBER, and the rule this replaces said it was:
 * anything starting with a digit and running eight or more characters of digits and
 * punctuation. On one demo report that claimed a Facebook UID, a payment card and an
 * IPv4 address as three of the subject's five phone numbers, the same failure as
 * reading a card number out of a social network's user id, which is value shape
 * overruling the column that already told us what the field was.
 *
 * Two bounds do the work. E.164 caps a real number at fifteen digits, which excludes
 * every card (thirteen to nineteen) and most platform ids. And a BARE run of digits
 * with no formatting at all is only plausibly a phone while it is short enough that
 * nothing else is shaped like it; past eleven, an unformatted run is an identifier far
 * more often than it is a number anybody dialled.
 */
function looksLikePhone(value: string): boolean {
  if (!/^\+?[\d\s().-]{7,}$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  return value.trim().startsWith("+") || /[\s()-]/.test(value) || digits.length <= 11;
}

function classifyColumn(column: string, value: string): ExposureKind {
  if (/^https?:\/\//i.test(value)) return "login";
  for (const r of COLUMN_RULES) if (r.re.test(column)) return r.kind;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  // before the phone test: a dotted quad is digits and punctuation, and reads as a
  // phone number to any rule loose enough to be useful on unlabelled columns
  if (IPV4.test(value)) return "ip";
  if (looksLikePhone(value)) return "phone";
  return "other";
}

/** Values the dumps use to mean "this column is empty". */
const NULLISH = new Set(["", "-", ",", "n/a", "na", "null", "none", "undefined", "0", "unknown"]);

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
  // to pair a login with a secret inside, the association only exists within a row
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

/** Pull the databases out of one `List` object. */
function databasesIn(list: any): LeakDatabase[] {
  if (!list || typeof list !== "object" || Array.isArray(list)) return [];
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

/**
 * Find the results, wherever this response put them.
 *
 * A single query answers `{"List": {"<database>": {...}}}`, which is what the
 * documentation describes and all it describes, it shows how to SEND a batch and
 * never shows what one comes BACK as. It does not come back as that: a batch nests a
 * `List` per query, so the top level is keyed by something other than a database and
 * the documented reader finds nothing at all. The pivot shipped broken for exactly
 * that reason, reporting a perfectly good answer as a shape it could not read.
 *
 * So: take the top-level `List` when there is one, and otherwise look one level down
 * for objects that carry their own. Databases are merged by name across queries, * two queries that both hit "Collection #1" are the same dump, and keeping two copies
 * of it would double every row in the per-breach view. Attribution then decides which
 * rows belong to which subject, which is the step that makes merging safe.
 */
/**
 * Does this object look like a map of DATABASES?
 *
 * Structural, not by key name, and that is the whole point. The documentation shows
 * one response shape and describes exactly one of the several this endpoint actually
 * produces: a single query answers under a top-level `List`, a batch nests per query,
 * and at least one of those nestings carries no `List` key at all. Two attempts to fix
 * the pivot by naming the keys both shipped broken, because naming keys is guessing.
 *
 * What never changes is what a database entry looks like: it has rows under `Data`, or
 * a provenance line under `InfoLeak`, or both. So that is what is looked for.
 */
function isDatabaseMap(o: any): boolean {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const vals = Object.values<any>(o);
  if (!vals.length) return false;
  return vals.some((v) => v && typeof v === "object" && !Array.isArray(v) && (Array.isArray(v.Data) || typeof v.InfoLeak === "string"));
}

/**
 * Every database map in the payload, however deep the response chose to put them.
 *
 * Three levels is enough for every shape observed and shallow enough that it cannot
 * wander into row data and mistake a record for a database.
 */
function listsIn(payload: any, depth = 0): any[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || depth > 2) return [];
  if (isDatabaseMap(payload)) return [payload];
  const out: any[] = [];
  if (payload.List) out.push(...listsIn(payload.List, depth + 1));
  for (const [k, v] of Object.entries<any>(payload)) {
    if (k === "List") continue;
    out.push(...listsIn(v, depth + 1));
  }
  return out;
}

/**
 * Did the endpoint run the query and match nothing?
 *
 * "No results found" arrives as a database NAME, in whichever List the response put it.
 * A batch that matched nothing has no readable database either, so without this it
 * takes the salvage path and a clean, correct, cheap answer is reported as an error
 * and refunded.
 */
function matchedNothing(payload: any): boolean {
  const lists = listsIn(payload);
  if (!lists.length) return false;
  return lists.every(
    (l) => Object.keys(l).length > 0 && Object.keys(l).every((k) => k === NO_RESULTS),
  );
}

function parseList(payload: any): LeakDatabase[] {
  const groups = listsIn(payload);
  if (!groups.length) return [];

  const merged = new Map<string, LeakDatabase>();
  for (const list of groups) {
    for (const db of databasesIn(list)) {
      const existing = merged.get(db.name);
      if (!existing) { merged.set(db.name, { ...db, rows: [...db.rows] }); continue; }
      if (!existing.info && db.info) existing.info = db.info;
      // the same row can be returned by two queries in one batch; it is one row
      const seen = new Set(existing.rows.map((r) => JSON.stringify(r)));
      for (const r of db.rows) {
        const k = JSON.stringify(r);
        if (!seen.has(k)) { seen.add(k); existing.rows.push(r); }
      }
    }
  }
  return [...merged.values()];
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
    // parseList skips, leaving `items` empty and sending the salvage harvester over the
    // payload, which faithfully turned "No results found. Try changing your request."
    // into a finding. That is the same mistake as reading a refusal as data, one layer
    // down. A recognised empty answer is an answer; it is never salvaged.
    if (matchedNothing(data)) return { databases: [], items: [], rowCount: 0, cost, empty: true };

    // The documented shape yielded nothing but the endpoint answered: harvest the raw
    // payload rather than report a clean result off a response we simply failed to read.
    if (!items.length && data && Object.keys(data).length) {
      const salvaged = harvest(data).map((i) => ({ ...i, source: "leakosint · unparsed" }));
      if (salvaged.length) {
        // The KEYS, never the values: enough to recognise a shape change from a bug
        // report, and nothing that could carry somebody's record into a log.
        const shape = Object.keys(data as object).slice(0, 8).join(", ");
        return { databases: [], items: salvaged, rowCount: 0, cost, empty: false, unreadable: true, shape };
      }
    }

    const rowCount = databases.reduce((n, d) => n + d.rows.length, 0);
    return { databases, items, rowCount, cost, empty: rowCount === 0 };
  } catch (e) {
    return { ...empty, error: String(e).includes("abort") ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}
