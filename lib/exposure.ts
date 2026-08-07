// What actually leaked.
//
// The bug this module exists to fix: every leak connector in Octopus was reporting the
// EXISTENCE of a compromise and throwing the compromise away. The Hudson Rock connector
// read five fields out of the stealer record and dropped the rest; the corpus connector
// said "3 record(s) found" and never showed a record. A node that says "INFOSTEALER"
// and then hands you nothing is worse than no node, because it costs a click to learn
// there is nothing behind it.
//
// So: harvest everything, classify it, and show it.
//
// The harvester is deliberately SCHEMA-AGNOSTIC. It classifies by key name and value
// shape rather than by a hard-coded field list, for two reasons. Breach sources change
// their payloads without notice and a fixed list silently starts dropping data the day
// they do — which is exactly how the original bug got in. And the fallback bucket is
// `other`, never `discard`: an unrecognised field is still shown, labelled by its own
// key, because an analyst can read a field this code has never heard of.

export type ExposureKind =
  | "credential"  // a password or hash — the thing an analyst is actually here for
  | "identifier"  // the login the credential belongs to (an address, a username)
  | "login"       // a service URL the victim was signed into
  | "email"
  | "ip"
  | "breach"      // a named dump this identity appears in
  | "field"       // a field CLASS a breach exposed ("passwords", "phone numbers")
  | "machine"     // computer name, operating system
  | "malware"     // stealer family, dropper path, antivirus present
  | "date"
  | "count"
  | "record"      // a raw matched line out of a held corpus or combolist
  | "other";

export interface ExposureItem {
  kind: ExposureKind;
  /** what this is, in the analyst's words */
  label: string;
  /** the datum itself — never summarised away */
  value: string;
  /** somewhere to go and look */
  url?: string;
  /** true when the SOURCE delivered it masked. Octopus does not mask on top. */
  masked?: boolean;
  /** which connector produced it — with several sources merged, per-row provenance is
   *  the difference between "this is usable" and "this came from the tier that masks" */
  source?: string;
}

const MAX_ITEMS = 400;
const MAX_DEPTH = 4;
const MAX_VALUE = 400;

/**
 * Key-name classifiers. ORDER IS THE CONTRACT, and it is subtle enough that the tests
 * pin it: `total_user_services` contains "service", so the count rule has to win before
 * the login rule ever sees it — otherwise a counter of 12 becomes a service named "12",
 * which is both wrong and unopenable.
 */
const RULES: { re: RegExp; kind: ExposureKind; label?: string }[] = [
  { re: /pass(word|wd)?|pwd|^pw$|credential|secret|hash/i, kind: "credential" },
  { re: /total|count|^num|_num$|amount|quantity/i, kind: "count" },
  { re: /malware_?path|file_?path|^path$/i, kind: "malware", label: "Dropper path" },
  { re: /antivirus|(^|_)av(s)?$/i, kind: "malware", label: "Antivirus present" },
  { re: /stealer|malware|family/i, kind: "malware" },
  // `top_logins` in a stealer record is the LOGIN the victim typed — an address or a
  // username — not the site. Real payloads return "n****@gmail.com" here, and calling
  // that a "service signed into" mislabels it on every single row.
  { re: /login|user_?name|^user$|account/i, kind: "identifier" },
  { re: /url|service|site|domain|resource|effected|affected/i, kind: "login" },
  { re: /breach|dump|leak|database/i, kind: "breach" },
  { re: /e?mail/i, kind: "email" },
  { re: /(^|_)ips?$|ip_?addr/i, kind: "ip" },
  { re: /computer|machine|host_?name|operating_?system|(^|_)os$|device/i, kind: "machine" },
  { re: /date|time|compromis|seen|created/i, kind: "date" },
];

/** Value-shape classifiers, for when the key name says nothing useful. */
function byShape(v: string): ExposureKind | null {
  if (/^https?:\/\//i.test(v)) return "login";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v) || /^[0-9a-f:]{7,39}$/i.test(v) && v.includes(":")) return "ip";
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
  if (/^[A-Za-z]:\\/.test(v)) return "malware";
  return null;
}

/** Humanise a payload key: `date_compromised` → `Date compromised`. */
export function humanKey(k: string): string {
  const s = k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Did the source hand this over already masked? Then we leave it exactly as it came. */
export function looksMasked(v: string): boolean {
  return /\*{2,}|•{2,}|●{2,}|x{6,}|\[REDACTED\]/i.test(v);
}

/**
 * Some masked values survive with NO information left in them at all — real Hudson Rock
 * rows come back as `_|` and `\***********************_`. Showing those is worse than
 * showing nothing: they pad the panel out and make an empty result look like a full one.
 *
 * The bar is deliberately at the floor rather than "looks useful". `M*********5` keeps
 * two real characters and a length, which is a weak but genuine constraint on the
 * password; that gets demoted in the UI, not deleted. Only a value with nothing left
 * but mask and punctuation is dropped.
 */
export function isContentFree(v: string): boolean {
  return v.replace(/[*•●\s\\/_|.,;:'"`~^\-–—+=()[\]{}<>!?@#$%&]/g, "").length < 1;
}

/** All a masked value actually tells you: the characters that survived, and a length. */
export function maskPattern(v: string): string {
  const kept = v.replace(/[*•●]/g, "");
  return `${kept || "—"} · ${v.length} chars`;
}

export interface Usable { clear: number; masked: number; total: number }

/**
 * How much of this is actually usable? The single most important thing a leak panel can
 * say, and the thing that was missing: five masked passwords and five real ones look
 * identical in a count, and only one of them is worth an analyst's afternoon.
 */
export function usableCount(items: ExposureItem[], kind: ExposureKind = "credential"): Usable {
  const rows = items.filter((i) => i.kind === kind);
  const masked = rows.filter((i) => i.masked).length;
  return { clear: rows.length - masked, masked, total: rows.length };
}

function classify(key: string, value: string): { kind: ExposureKind; label: string } {
  // A URL is a service no matter which key carries it. `top_logins` holds masked
  // ADDRESSES in a real stealer record but full URLs in other feeds, so the key alone
  // cannot decide — the value can, and unambiguously.
  if (/^https?:\/\//i.test(value)) return { kind: "login", label: humanKey(key) };
  for (const r of RULES) {
    if (r.re.test(key)) return { kind: r.kind, label: r.label || humanKey(key) };
  }
  const shape = byShape(value);
  return { kind: shape || "other", label: humanKey(key) };
}

/**
 * Walk an arbitrary payload and pull out every leaf worth showing. Nothing is dropped
 * for being unrecognised — an unknown field is emitted under its own key.
 */
export function harvest(payload: unknown, opts: { skip?: RegExp } = {}): ExposureItem[] {
  const out: ExposureItem[] = [];
  const seen = new Set<string>();

  const push = (key: string, raw: unknown) => {
    if (out.length >= MAX_ITEMS) return;
    if (raw === null || raw === undefined || raw === "") return;
    if (typeof raw === "boolean") return;                    // flags carry no content
    let value = typeof raw === "number" ? String(raw) : String(raw).trim();
    if (!value || value === "null" || value === "undefined" || value === "N/A") return;
    if (value.length > MAX_VALUE) value = value.slice(0, MAX_VALUE) + "…";
    // masked down to nothing: a row that pads the panel out and says nothing at all
    if (isContentFree(value)) return;
    const { kind, label } = classify(key, value);
    // a count of zero is noise; a count of anything else is a finding
    if (kind === "count" && /^0+$/.test(value)) return;
    const dedupe = kind + "\u0000" + value;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({
      kind, label, value,
      url: /^https?:\/\//i.test(value) ? value : undefined,
      masked: looksMasked(value) || undefined,
    });
  };

  const walk = (node: unknown, key: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_ITEMS) return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, key, depth + 1);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (opts.skip?.test(k)) continue;
        walk(v, k, depth + 1);
      }
    } else {
      push(key, node);
    }
  };

  walk(payload, "value", 0);
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>,;]{4,}/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * Pull the selectors out of raw lines. A corpus hit is a line of text, and the line
 * itself is the evidence — but the addresses, URLs and hosts inside it are what the
 * analyst pivots on next, so they are lifted out as their own items rather than left
 * buried in a string nobody can click.
 */
export function harvestText(lines: string[], label = "Record"): ExposureItem[] {
  const out: ExposureItem[] = [];
  const seen = new Set<string>();
  const add = (kind: ExposureKind, l: string, value: string, url?: string) => {
    const k = kind + " " + value;
    if (seen.has(k) || out.length >= MAX_ITEMS) return;
    seen.add(k);
    out.push({ kind, label: l, value, url, masked: looksMasked(value) || undefined });
  };
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;
    add("record", label, line.length > MAX_VALUE ? line.slice(0, MAX_VALUE) + "…" : line);
    for (const m of line.match(EMAIL_RE) || []) add("email", "Address in record", m.toLowerCase());
    for (const m of line.match(URL_RE) || []) add("login", "URL in record", m, m);
    for (const m of line.match(IPV4_RE) || []) add("ip", "IP in record", m);
    // `selector:secret` is the shape of a credential dump line; the tail is the secret
    const cred = line.match(/^([^\s:;,\t|]+)[:;,\t|](\S{3,})$/);
    if (cred) add("credential", "Credential for " + cred[1], cred[2]);
  }
  return out;
}

const ORDER: ExposureKind[] = ["credential", "identifier", "login", "email", "record", "breach", "field", "ip", "machine", "malware", "date", "count", "other"];

/** Credentials first, and inside every group the CLEAR values before the masked ones. */
export function sortExposure(items: ExposureItem[]): ExposureItem[] {
  return [...items].sort((a, b) =>
    ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || Number(!!a.masked) - Number(!!b.masked));
}

/**
 * Merge the same fact reported by several sources into one row that credits all of them,
 * and prefer the UNMASKED copy. This is the payoff for querying more than one index: if
 * Hudson Rock masks a password and a combolist has it in clear, the analyst should see
 * the clear one once, not both versions in two panels.
 */
export function mergeExposure(items: ExposureItem[]): ExposureItem[] {
  const byKey = new Map<string, ExposureItem>();
  for (const it of items) {
    // masked and clear copies of one secret differ as strings, so they cannot dedupe by
    // value; they collapse on the group + the characters that survived the mask
    const key = it.kind + " " + (it.masked ? it.value.replace(/[*•●]+/g, "*") : it.value);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...it }); continue; }
    if (prev.masked && !it.masked) byKey.set(key, { ...it, source: joinSource(prev.source, it.source) });
    else prev.source = joinSource(prev.source, it.source);
  }
  return [...byKey.values()];
}

function joinSource(a?: string, b?: string): string | undefined {
  const all = [...new Set([...(a || "").split(" · "), ...(b || "").split(" · ")].filter(Boolean))];
  return all.length ? all.join(" · ") : undefined;
}

/** One line saying what is actually in there, for the node subtitle and the dossier. */
export function exposureSummary(items: ExposureItem[]): string {
  const n = (k: ExposureKind) => items.filter((i) => i.kind === k).length;
  const cred = usableCount(items);
  const parts: string[] = [];
  // the count that matters is the USABLE one — five masked passwords and five real ones
  // are the same number and completely different findings
  if (cred.total) parts.push(cred.clear ? `${cred.clear} credential${cred.clear > 1 ? "s" : ""} in clear` : `${cred.total} credential${cred.total > 1 ? "s" : ""} (masked)`);
  if (n("login")) parts.push(`${n("login")} service${n("login") > 1 ? "s" : ""}`);
  if (n("breach")) parts.push(`${n("breach")} breach${n("breach") > 1 ? "es" : ""}`);
  if (n("email") + n("identifier")) parts.push(`${n("email") + n("identifier")} identifier${n("email") + n("identifier") > 1 ? "s" : ""}`);
  if (n("record")) parts.push(`${n("record")} record${n("record") > 1 ? "s" : ""}`);
  if (n("ip")) parts.push(`${n("ip")} IP${n("ip") > 1 ? "s" : ""}`);
  if (!parts.length) return items.length ? `${items.length} field(s), no credentials or services` : "nothing recovered";
  return parts.join(" · ");
}

/**
 * The honest headline for a leak node. "Appears in a breach" with nothing behind it and
 * "appears in a breach, here are the credentials" are different findings, and the node
 * has to say which one it is before the analyst spends a click on it.
 */
export function exposureVerdict(items: ExposureItem[]): string {
  const cred = items.filter((i) => i.kind === "credential");
  const usable = cred.filter((i) => !i.masked);
  if (usable.length) return `${usable.length} credential(s) recovered in full`;
  if (cred.length) return `${cred.length} credential(s), masked at source`;
  const svc = items.filter((i) => i.kind === "login").length;
  if (svc) return `no credentials returned — ${svc} exposed service(s) instead`;
  return "confirmed exposure, but this source returned no content";
}

/** A copyable block, so the whole finding leaves the tool in one keystroke. */
export function exposureText(items: ExposureItem[]): string {
  return sortExposure(items)
    .map((i) => `${i.label}: ${i.value}${i.masked ? "  [masked at source]" : ""}${i.source ? `  (${i.source})` : ""}`)
    .join("\n");
}

/** Just the usable credentials, one per line — the format a password audit wants. */
export function credentialsText(items: ExposureItem[]): string {
  const byId = new Map<string, string>();
  for (const i of items) if (i.kind === "identifier" || i.kind === "email") byId.set(i.value, i.value);
  const ids = [...byId.keys()];
  return items
    .filter((i) => i.kind === "credential" && !i.masked)
    .map((c) => (ids.length === 1 ? `${ids[0]}:${c.value}` : c.value))
    .join("\n");
}
