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
  | "login"       // a service the victim was signed into
  | "email"
  | "ip"
  | "machine"     // computer name, operating system
  | "malware"     // stealer family, dropper path, antivirus present
  | "date"
  | "count"
  | "record"      // a raw matched line out of a held corpus
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
  { re: /login|url|service|site|domain|resource/i, kind: "login" },
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
function looksMasked(v: string): boolean {
  return /\*{3,}|•{3,}|●{3,}|•{3,}|x{6,}|\[REDACTED\]/i.test(v);
}

function classify(key: string, value: string): { kind: ExposureKind; label: string } {
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

const ORDER: ExposureKind[] = ["credential", "login", "email", "record", "ip", "machine", "malware", "date", "count", "other"];

/** Credentials and services first: that is the order an analyst reads them in. */
export function sortExposure(items: ExposureItem[]): ExposureItem[] {
  return [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** One line saying what is actually in there, for the node subtitle and the dossier. */
export function exposureSummary(items: ExposureItem[]): string {
  const n = (k: ExposureKind) => items.filter((i) => i.kind === k).length;
  const parts: string[] = [];
  if (n("credential")) parts.push(`${n("credential")} credential${n("credential") > 1 ? "s" : ""}`);
  if (n("login")) parts.push(`${n("login")} service${n("login") > 1 ? "s" : ""}`);
  if (n("email")) parts.push(`${n("email")} address${n("email") > 1 ? "es" : ""}`);
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
    .map((i) => `${i.label}: ${i.value}${i.masked ? "  [masked at source]" : ""}`)
    .join("\n");
}
