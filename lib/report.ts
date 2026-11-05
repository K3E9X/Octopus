// The report — what the rows actually say about the subject.
//
// Three views of the same facts, plus the thing a pile of rows is not: a person.
//
//   IDENTITY    — the rows consolidated into one subject, every value citing the
//                 databases that carried it (lib/identity).
//   BY CATEGORY — what each datum IS, ranked by how much it should worry whoever it
//                 belongs to, deduped, with the concrete step to take on it.
//   BY SOURCE   — which breach exposed what, with that breach's own description.
//   TIMELINE    — the compromises in date order.
//
// The gate everything passes through first is ATTRIBUTION. The API searches every
// permutation of a query's words, so a result set contains rows that matched something
// without being about the person asked for. Those rows are counted and shown as what
// they are — other people — and never folded into the subject's identity. A tool that
// quietly merges them produces a confident, detailed, wrong answer, which is worse than
// producing nothing.
//
// Pure and synchronous: no network, no database, so it is testable and runs anywhere.

import type { ExposureItem } from "./exposure";
import type { Subject } from "./subject";
import type { LeakDatabase } from "./leakosint";
import { itemsFromRow } from "./leakosint";
import { attributeRow, type Attribution } from "./attribution";
import { consolidate, describe, type Identity } from "./identity";

export type Category =
  | "password" | "financial" | "document" | "identity"
  | "location" | "email" | "phone" | "online" | "professional" | "other";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  category: Category;
  severity: Severity;
  /** the column/field name as the breach labelled it, humanised */
  label: string;
  /** the leaked value, as it is (masked values stay masked) */
  value: string;
  /** which breach it came from (display name, no "leakosint · " prefix) */
  source: string;
  masked?: boolean;
}

export interface CategoryReport {
  category: Category;
  label: string;
  severity: Severity;
  /** what this means for the person, in plain words */
  meaning: string;
  /** the single most important thing to do about it */
  action: string;
  findings: Finding[];
  /** distinct values, so "7 rows of the same password" reads as one exposure */
  distinct: number;
}

export interface SourceReport {
  /** the breach / database name */
  name: string;
  /** what that breach was — the provenance line the API ships per database */
  info: string;
  /** a human date pulled from the description, when there is one */
  date?: string;
  /** sortable key for the timeline (YYYYMMDD-ish); 0 when undated */
  sortDate: number;
  /** the fields this breach exposed about the subject, worst-first */
  findings: Finding[];
  /** the worst severity in this breach, for the card accent */
  severity: Severity;
}

export interface TimelineEntry {
  name: string;
  date: string;
  sortDate: number;
}

export interface SearchReport {
  /** the selector this report is about, and what kind of thing it is */
  subject: { raw: string; kind: Subject["kind"]; canonical: string; unique: boolean; note?: string };
  /** how exposed, in one word, for the headline */
  verdict: "clear" | "exposed" | "critical";
  /** the rows consolidated into one person — every value citing its databases */
  identity: Identity;
  /** that identity in one readable line */
  summary: string;
  /** total distinct leaked data points attributed to the subject */
  dataPoints: number;
  /** how many breaches the subject appears in */
  breachCount: number;
  /** the "what" view: categories worst-first, deduped across sources */
  categories: CategoryReport[];
  /** the "where" view: per-breach, newest first */
  sources: SourceReport[];
  /** the "when" view: dated breaches, oldest first */
  timeline: TimelineEntry[];
  /** the critical pull-outs, surfaced above everything else */
  highlights: { financial: Finding[]; passwords: Finding[] };
  /**
   * What the API returned that is NOT about the subject.
   *
   * Reported rather than silently discarded, for two reasons. The operator paid for
   * these rows, and a count of what was set aside is the only way to tell "nothing was
   * found" apart from "everything found belonged to someone else". And on a name
   * search, `others` IS the answer: a list of the distinct people who share that name,
   * to be told apart rather than merged.
   */
  excluded: { partial: number; unrelated: number; total: number };
  /** on a non-unique subject: the other people the rows describe, kept separate */
  others: OtherSubject[];
}

/**
 * Someone who is not the subject.
 *
 * A name search returns rows about everyone who shares the name. Each distinct person
 * the rows seem to describe is surfaced on their own, with what identifies them, so the
 * operator can say which one they meant. They are never consolidated into the subject.
 */
export interface OtherSubject {
  /** the identifying value that holds this group together (an address, a phone) */
  anchor: string;
  /** which words of the query this person matched */
  matched: string[];
  /** the databases these rows came from */
  sources: string[];
  findings: Finding[];
}

// ---- financial detection -------------------------------------------------------------
// A RIB / IBAN / card / crypto wallet is the thing a person most needs told, and the raw
// classifier often mislabels an IBAN column ("BankAccount") as a username. Detect it here
// from the column name and the value shape, and let it override everything.

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const FIN_LABEL = /\b(rib|iban|bic|swift|bank|banque|compte|card|carte|cc_?num|pan|cvv|ccv|paypal|crypto|wallet|btc|eth|routing|account.?number)\b/i;

export function looksFinancial(label: string, value: string): boolean {
  if (FIN_LABEL.test(label)) return true;
  const v = value.replace(/[\s-]/g, "");
  if (IBAN_RE.test(v)) return true;                  // an IBAN
  if (/^\d{13,19}$/.test(v) && luhn(v)) return true; // a plausible card number
  if (/^\d{23}$/.test(v)) return true;               // a French RIB is 23 digits
  return false;
}

function luhn(num: string): boolean {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

// ---- category metadata ---------------------------------------------------------------

const META: Record<Category, { label: string; severity: Severity; meaning: string; action: string }> = {
  password: {
    label: "Passwords", severity: "critical",
    meaning: "A password tied to you is in a breach. If you reused it anywhere, those accounts are open to anyone holding this dump.",
    action: "Change it everywhere you used it, and turn on two-factor authentication.",
  },
  financial: {
    label: "Bank & financial", severity: "critical",
    meaning: "Bank, card or account details tied to you have leaked. This is what enables direct-debit fraud, unauthorised charges and account takeover.",
    action: "Tell your bank now, watch the account, and have a leaked card or RIB flagged.",
  },
  document: {
    label: "Identity documents", severity: "high",
    meaning: "An identity-document number tied to you is exposed. This is the raw material identity theft is built on.",
    action: "Note the number, and watch for accounts or credit opened in your name.",
  },
  identity: {
    label: "Identity", severity: "high",
    meaning: "Your real name, and often your date of birth and gender, are in the breach. On their own these are not secret; combined with the address and documents below, they are what lets someone impersonate you.",
    action: "Treat anyone who proves 'who you are' with only these details as unverified.",
  },
  location: {
    label: "Address & location", severity: "medium",
    meaning: "A physical address tied to you has leaked, sometimes down to the flat number.",
    action: "Weigh it when a caller or letter cites your address as proof they are legitimate — it no longer is.",
  },
  email: {
    label: "Email addresses", severity: "medium",
    meaning: "Your address is in a breach, so expect targeted phishing that already knows something true about you.",
    action: "Treat unexpected mail asking you to log in or pay as hostile until proven otherwise.",
  },
  phone: {
    label: "Phone numbers", severity: "medium",
    meaning: "Your number is exposed, which feeds SMS phishing and SIM-swap attempts.",
    action: "Be wary of codes you did not request, and ask your carrier about a SIM-swap lock.",
  },
  online: {
    label: "Online accounts", severity: "low",
    meaning: "Usernames, handles and profile links tied to you appear in breach data — this is how separate accounts get tied back to one person.",
    action: "Know these accounts can be linked to you; retire any you no longer use.",
  },
  professional: {
    label: "Work & employer", severity: "low",
    meaning: "Your employer, role or work details leaked. This is what makes a targeted work-email (BEC) scam convincing.",
    action: "Be sceptical of work requests about payments or credentials that lean on these details.",
  },
  other: {
    label: "Other details", severity: "low",
    meaning: "Other data tied to you appears in the breach.",
    action: "Review it and judge whether any of it is sensitive in your situation.",
  },
};

const ORDER: Category[] = [
  "password", "financial", "document", "identity",
  "location", "email", "phone", "online", "professional", "other",
];
const RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

// ---- classification ------------------------------------------------------------------
// Category is decided from the column LABEL first (it carries the most intent — a column
// called "BankAccount" or "JobTitle" says exactly what it is), then the raw kind, then
// the value shape. Order matters: financial overrides, identity beats online so a name
// does not land under "handles", location beats contact.

const BIRTHISH = /birth|\bdob\b|\bbday\b|born/i;

function categorize(it: ExposureItem): Category | null {
  // Humanise first so CamelCase / snake_case columns ("CompanyName", "bank_account")
  // become "company name" / "bank account" — otherwise \b-bounded keywords never match
  // inside a concatenated column name.
  const L = humanLabel(it.label).toLowerCase();
  const v = it.value;

  if (it.kind === "credential" || /\b(pass(word|wd)?|pwd|hash|secret|otp|pin)\b/.test(L)) return "password";
  if (looksFinancial(it.label, v)) return "financial";
  if (it.kind === "document" || /\b(passport|national.?id|\bssn\b|\binn\b|snils|licen[cs]e|id.?card|driver|tax.?id|nino)\b/.test(L)) return "document";
  if (it.kind === "name" || /\b(full.?name|^name$|first.?name|last.?name|surname|patronym|\bfio\b|gender|\bsex\b)\b/.test(L) || BIRTHISH.test(L)) return "identity";

  // A date that is not a birthday is account history — when it was opened, when it was
  // last used — and the person it belongs to learned nothing by being shown it.
  //
  // This check has to come HERE, before the label rules below, and that is the whole
  // point of its position. "LastLogin" contains "login", so the rule that recognises
  // handles claimed it first and a timestamp was being presented as an online account.
  // Kind beats label whenever the kind is already certain.
  if (it.kind === "date") return null;
  if (it.kind === "address" || /\b(address|street|city|region|country|postal|post.?code|\bzip\b|state|province|\bgeo\b|location)\b/.test(L)) return "location";
  if (it.kind === "email" || /e-?mail/.test(L)) return "email";
  if (it.kind === "phone" || /\b(phone|mobile|tel|msisdn|numero)\b/.test(L)) return "phone";
  if (/\b(company|employer|job.?title|occupation|industry|department|position|role|level|work|professional|business)\b/.test(L)) return "professional";
  if (it.kind === "identifier" || it.kind === "login" || /\b(nick|user.?name|login|profile|handle|telegram|facebook|instagram|twitter|\bvk\b|\bok\b|link|url|domain|site|\bip\b)\b/.test(L)) return "online";

  if (it.kind === "count" || it.kind === "field") return null;
  return "other";
}

function severityOf(c: Category): Severity { return c === "financial" ? "critical" : META[c].severity; }

function humanLabel(label: string): string {
  const s = String(label || "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Field";
}

const srcName = (s: string | undefined) => (s || "breach").replace(/^leakosint\s*·\s*/i, "").trim() || "breach";

// ---- breach date parsing -------------------------------------------------------------
// The InfoLeak description is prose: "suffered a breach on March 19, 2025", "On August 4,
// 2025…", "In late 2022…", "a backup published … in mid-2019". Pull a date out of it so
// the timeline can order the breaches. Returns a display string and a sortable key.

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function parseBreachDate(info: string): { date?: string; sortDate: number } {
  const text = String(info || "");
  // "March 19, 2025" / "March 2025"
  const m = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:(\d{1,2})\s*,?\s*)?(\d{4})\b/i);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    const day = m[2] ? Number(m[2]) : 0;
    const year = Number(m[3]);
    const date = day ? `${m[1]} ${day}, ${year}` : `${m[1]} ${year}`;
    return { date, sortDate: year * 10000 + mon * 100 + day };
  }
  // "ISO" 2019-01-01
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return { date: iso[0], sortDate: Number(iso[1]) * 10000 + Number(iso[2]) * 100 + Number(iso[3]) };
  }
  // bare year, with an optional "late/early/mid" qualifier
  const y = text.match(/\b(late|early|mid)[\s-]?((?:19|20)\d{2})\b/i) || text.match(/\b((?:19|20)\d{2})\b/);
  if (y) {
    const year = Number(y[2] || y[1]);
    const qual = y[2] ? y[1].toLowerCase() : "";
    const month = qual === "early" ? 2 : qual === "mid" ? 6 : qual === "late" ? 11 : 0;
    const date = qual ? `${qual.charAt(0).toUpperCase() + qual.slice(1)} ${year}` : String(year);
    return { date, sortDate: year * 10000 + month * 100 };
  }
  return { sortDate: 0 };
}

// ---- build ---------------------------------------------------------------------------

/** Turn the items of one attributed row into findings. */
function findingsFrom(items: ExposureItem[], database: string): Finding[] {
  const out: Finding[] = [];
  for (const it of items) {
    if (it.kind === "breach" || it.kind === "record") continue;
    const category = categorize(it);
    if (!category) continue;
    out.push({
      category,
      severity: severityOf(category),
      label: humanLabel(it.label),
      value: it.value,
      source: srcName(it.source) || database,
      masked: it.masked,
    });
  }
  return out;
}

/** The value that identifies one of the other people a name search turned up. */
function anchorOf(items: ExposureItem[]): string | null {
  for (const kind of ["email", "phone", "identifier"] as const) {
    const hit = items.find((i) => i.kind === kind && String(i.value || "").trim());
    if (hit) return hit.value.trim();
  }
  const name = items.find((i) => i.kind === "name" && String(i.value || "").trim());
  return name ? name.value.trim() : null;
}

/**
 * Build the report.
 *
 * Works from the DATABASES rather than from a flattened item list, because attribution
 * is a per-row judgement and because the association between a login and a secret only
 * exists inside one row. Every row is judged before it contributes anything:
 *
 *   direct   → the subject's identity, categories, sources and timeline
 *   partial  → `others`, grouped by whoever they appear to be
 *   none     → counted in `excluded`, and nothing more
 */
export function buildReport(subject: Subject, databases: LeakDatabase[]): SearchReport {
  const infoByName = new Map(databases.map((d) => [d.name, d.info] as const));

  const findings: Finding[] = [];
  const ownRows: { database: string; items: ExposureItem[] }[] = [];
  const foreign = new Map<string, { anchor: string; matched: Set<string>; sources: Set<string>; findings: Finding[] }>();
  let partial = 0, unrelated = 0;

  for (const db of databases) {
    for (const row of db.rows) {
      const verdict = attributeRow(subject, row);
      const items = itemsFromRow(db, row);

      if (verdict.attribution === "direct") {
        ownRows.push({ database: db.name, items });
        findings.push(...findingsFrom(items, db.name));
        continue;
      }
      if (verdict.attribution === "none") { unrelated += 1; continue; }

      // partial: somebody else who matched part of the query
      partial += 1;
      const anchor = anchorOf(items) || "(unidentified)";
      const key = anchor.toLowerCase();
      const group = foreign.get(key) ?? { anchor, matched: new Set<string>(), sources: new Set<string>(), findings: [] };
      foreign.set(key, group);
      for (const w of verdict.words || []) group.matched.add(w);
      group.sources.add(db.name);
      group.findings.push(...findingsFrom(items, db.name));
    }
  }

  // --- the subject, consolidated into one person ---
  const identity = consolidate(ownRows);
  const summary = describe(identity);

  // --- by category (deduped on value within a category) ---
  const byCat = new Map<Category, Map<string, Finding>>();
  for (const f of findings) {
    const bucket = byCat.get(f.category) || new Map<string, Finding>();
    const key = f.value.toLowerCase();
    if (!bucket.has(key)) bucket.set(key, f);
    byCat.set(f.category, bucket);
  }
  const categories: CategoryReport[] = ORDER
    .filter((c) => byCat.has(c))
    .map((c) => {
      const fs = [...byCat.get(c)!.values()];
      return { category: c, ...META[c], findings: fs, distinct: fs.length };
    });

  // --- by source (keep every field, ordered worst-first within the breach) ---
  const bySrc = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = bySrc.get(f.source) || [];
    arr.push(f);
    bySrc.set(f.source, arr);
  }
  const sources: SourceReport[] = [...bySrc.entries()].map(([name, fs]) => {
    const info = infoByName.get(name) || "";
    const { date, sortDate } = parseBreachDate(info);
    fs.sort((a, b) => RANK[b.severity] - RANK[a.severity] || ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
    const severity = fs.reduce<Severity>((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), "low");
    return { name, info, date, sortDate, findings: fs, severity };
  });
  // A database that matched the subject but surfaced no usable field is still a
  // breach the subject is in, and saying so is the honest reading of an empty row.
  for (const db of databases) {
    if (bySrc.has(db.name)) continue;
    if (!ownRows.some((r) => r.database === db.name)) continue;
    const { date, sortDate } = parseBreachDate(db.info);
    sources.push({ name: db.name, info: db.info, date, sortDate, findings: [], severity: "low" });
  }
  sources.sort((a, b) => (b.sortDate - a.sortDate) || a.name.localeCompare(b.name));

  // --- timeline (dated breaches, oldest first) ---
  const timeline: TimelineEntry[] = sources
    .filter((s) => s.sortDate > 0 && s.date)
    .map((s) => ({ name: s.name, date: s.date!, sortDate: s.sortDate }))
    .sort((a, b) => a.sortDate - b.sortDate);

  // --- verdict + highlights ---
  const dataPoints = categories.reduce((n, c) => n + c.distinct, 0);
  const breachCount = sources.length;
  const worst = categories.reduce<Severity>((w, c) => (RANK[c.severity] > RANK[w] ? c.severity : w), "low");
  const verdict: SearchReport["verdict"] = !categories.length ? "clear" : RANK[worst] >= 3 ? "critical" : "exposed";

  const dedupeHi = (c: Category) => {
    const seen = new Set<string>();
    return findings.filter((f) => f.category === c && !seen.has(f.value.toLowerCase()) && seen.add(f.value.toLowerCase()));
  };

  const others: OtherSubject[] = [...foreign.values()]
    .map((g) => ({ anchor: g.anchor, matched: [...g.matched], sources: [...g.sources].sort(), findings: g.findings }))
    .sort((a, b) => b.findings.length - a.findings.length || a.anchor.localeCompare(b.anchor));

  return {
    subject: { raw: subject.raw, kind: subject.kind, canonical: subject.canonical, unique: subject.unique, note: subject.note },
    verdict,
    identity,
    summary,
    dataPoints,
    breachCount,
    categories,
    sources,
    timeline,
    highlights: { financial: dedupeHi("financial"), passwords: dedupeHi("password") },
    excluded: { partial, unrelated, total: partial + unrelated },
    others,
  };
}

/**
 * One line for the report card.
 *
 * On a subject that does not designate one person, the count of other people found is
 * part of the headline rather than a footnote — it is the single most important thing
 * to know before reading a name search's results as if they were one person's.
 */
export function headline(r: SearchReport): string {
  const extra = r.others.length
    ? ` ${r.others.length} other ${r.others.length === 1 ? "person" : "people"} matched part of this query and ${r.others.length === 1 ? "is" : "are"} listed separately.`
    : "";
  if (r.verdict === "clear") {
    const nothing = r.excluded.total
      ? `No row found that is about ${r.subject.raw} — ${r.excluded.total} returned row${r.excluded.total === 1 ? "" : "s"} belonged to someone else.`
      : "No exposure found at this search depth.";
    return nothing + extra;
  }
  const crit = r.categories.find((c) => c.severity === "critical");
  const base = `${r.dataPoints} leaked data point${r.dataPoints === 1 ? "" : "s"} across ${r.breachCount} breach${r.breachCount === 1 ? "" : "es"}`;
  return (crit ? `${base}, including ${crit.label.toLowerCase()}.` : `${base}.`) + extra;
}
