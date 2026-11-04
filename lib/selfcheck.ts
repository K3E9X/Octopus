// Self-exposure report — what a person's own breach data means to them.
//
// This is the product: someone proves they own an email / phone / login, and this turns
// the raw LeakOSINT rows into a report they can act on. Three views of the same facts:
//
//   BY CATEGORY — what the datum IS (password, bank detail, identity, address…), ranked
//     by how much it should worry them, deduped, each with a concrete next step.
//   BY SOURCE   — which breach each fact came from, with that breach's description and
//     date, so "where did this leak" has an answer.
//   TIMELINE    — the breaches in date order, the compromise history at a glance.
//
// It speaks to the OWNER of the data ("your password", "change it"), not to an
// investigator. The gate — that you only reach this for an identifier you have verified
// you control — lives in the route; this module assumes that has already passed.
//
// Pure and synchronous: no network, no database, so it is testable and runs anywhere.

import type { ExposureItem } from "./exposure";

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

export interface SelfReport {
  /** the verified identifier this report is about */
  subject: string;
  /** how exposed, in one word, for the headline */
  verdict: "clear" | "exposed" | "critical";
  /** total distinct leaked data points */
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
  if (it.kind === "address" || /\b(address|street|city|region|country|postal|post.?code|\bzip\b|state|province|\bgeo\b|location)\b/.test(L)) return "location";
  if (it.kind === "email" || /e-?mail/.test(L)) return "email";
  if (it.kind === "phone" || /\b(phone|mobile|tel|msisdn|numero)\b/.test(L)) return "phone";
  if (/\b(company|employer|job.?title|occupation|industry|department|position|role|level|work|professional|business)\b/.test(L)) return "professional";
  if (it.kind === "identifier" || it.kind === "login" || /\b(nick|user.?name|login|profile|handle|telegram|facebook|instagram|twitter|\bvk\b|\bok\b|link|url|domain|site|\bip\b)\b/.test(L)) return "online";

  // Dates that are not birthdays are metadata (registration, last-seen) — not findings.
  if (it.kind === "date") return null;
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

/**
 * Build the report from the exposure items of a verified subject.
 *
 * `items` are the fields LeakOSINT returned for this identifier; `breaches` is the per-
 * database {name, info} provenance. Nothing here decides WHETHER the person may see this;
 * the route already proved they own `subject`.
 */
export function buildReport(
  subject: string,
  items: ExposureItem[],
  breaches: { name: string; info: string }[],
): SelfReport {
  const infoByName = new Map(breaches.map((b) => [b.name, b.info] as const));

  // Build findings once; feed both the category view and the source view from them.
  const findings: Finding[] = [];
  for (const it of items) {
    if (it.kind === "breach" || it.kind === "record") continue;
    const category = categorize(it);
    if (!category) continue;
    findings.push({
      category,
      severity: severityOf(category),
      label: humanLabel(it.label),
      value: it.value,
      source: srcName(it.source),
      masked: it.masked,
    });
  }

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
  // breaches named in `breaches` but with no surfaced field still count as a source line
  for (const b of breaches) {
    if (!bySrc.has(b.name)) {
      const { date, sortDate } = parseBreachDate(b.info);
      sources.push({ name: b.name, info: b.info, date, sortDate, findings: [], severity: "low" });
    }
  }
  sources.sort((a, b) => (b.sortDate - a.sortDate) || a.name.localeCompare(b.name));

  // --- timeline (dated breaches, oldest first) ---
  const timeline: TimelineEntry[] = sources
    .filter((s) => s.sortDate > 0 && s.date)
    .map((s) => ({ name: s.name, date: s.date!, sortDate: s.sortDate }))
    .sort((a, b) => a.sortDate - b.sortDate);

  // --- verdict + highlights ---
  const dataPoints = categories.reduce((n, c) => n + c.distinct, 0);
  const breachCount = new Set([...bySrc.keys(), ...breaches.map((b) => b.name)]).size;
  const worst = categories.reduce<Severity>((w, c) => (RANK[c.severity] > RANK[w] ? c.severity : w), "low");
  const verdict: SelfReport["verdict"] = !categories.length ? "clear" : RANK[worst] >= 3 ? "critical" : "exposed";

  const dedupeHi = (c: Category) => {
    const seen = new Set<string>();
    return findings.filter((f) => f.category === c && !seen.has(f.value.toLowerCase()) && seen.add(f.value.toLowerCase()));
  };
  const highlights = { financial: dedupeHi("financial"), passwords: dedupeHi("password") };

  return { subject, verdict, dataPoints, breachCount, categories, sources, timeline, highlights };
}

/** One-line headline for the report card. */
export function headline(r: SelfReport): string {
  if (r.verdict === "clear") return "No exposure found at this search depth.";
  const crit = r.categories.find((c) => c.severity === "critical");
  const base = `${r.dataPoints} leaked data point${r.dataPoints === 1 ? "" : "s"} across ${r.breachCount} breach${r.breachCount === 1 ? "" : "es"}`;
  return crit ? `${base}, including ${crit.label.toLowerCase()}.` : `${base}.`;
}
