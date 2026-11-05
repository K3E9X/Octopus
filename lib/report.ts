// The report, what the rows actually say about the subject.
//
// Several views of the same facts, plus the thing a pile of rows is not: a person.
// The list of them lives in lib/views, because a count written down in prose drifts the
// first time one is added, and it had drifted in four separate places.
//
//   IDENTITY, the rows consolidated into one subject, every value citing the
//                 databases that carried it (lib/identity).
//   BY CATEGORY, what each datum IS, ranked by how much it should worry whoever it
//                 belongs to, deduped, with the concrete step to take on it.
//   BY SOURCE, which breach exposed what, with that breach's own description.
//   TIMELINE, the compromises in date order.
//
// The gate everything passes through first is ATTRIBUTION. The API searches every
// permutation of a query's words, so a result set contains rows that matched something
// without being about the person asked for. Those rows are counted and shown as what
// they are, other people, and never folded into the subject's identity. A tool that
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
import { serviceGrid, gridSummary, type ServiceTile } from "./services";
import { patternGroups } from "./pwpattern";

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
  /** what that breach was, the provenance line the API ships per database */
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
  /** the rows consolidated into one person, every value citing its databases */
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
  /**
   * On a selector that does not identify one person: the records that matched it in
   * full, grouped by whoever they appear to be.
   *
   * These ARE the answer to a name search, so they are shown open rather than folded
   * away. They are grouped, not merged, two groups may still be the same person under
   * two addresses, and the tool does not know which.
   */
  candidates: OtherSubject[];
  /** people who matched only PART of the selector, a shared surname, nothing more */
  others: OtherSubject[];
  /**
   * Every attributed row, verbatim, column by column, grouped by database.
   *
   * The views above classify, rank and deduplicate, all of which involve judgement,
   * and judgement can be wrong. This is the row as the API returned it, with the
   * dump's own column names and nothing removed: the activity timestamps the
   * categories drop as metadata, the internal flags nobody can interpret, the fields
   * this code has never heard of. An analyst who suspects something was mis-filed, or
   * who just wants what the source actually said, reads here and does not have to
   * take the classification's word for anything.
   */
  records: RecordGroup[];
  /** the identifiers this report surfaced that are worth searching in their own right */
  pivots: PivotTarget[];
  /**
   * Who holds this person's data, one tile per service.
   *
   * The grid every product in this category shows, built from the breaches already
   * paid for rather than by probing sites, which costs nothing extra and makes a
   * claim that is checkable. Aggregated credential lists are kept apart from real
   * services, because telling somebody they have an account at "Collection #1" is
   * telling them they have an account at a company that does not exist.
   */
  services: ServiceTile[];
  servicesSummary: string;
  /**
   * Passwords that are the same habit wearing a different year.
   *
   * A list of leaked passwords tells someone their passwords leaked. Noticing that
   * three of them are one stem with a rotating suffix tells them something they did
   * not know and can act on: changing the current one changes nothing, because the
   * next one is guessable from the last. Deterministic, it is string structure, not
   * a judgement, so it can be shown without a hedge.
   */
  passwordHabits: PasswordHabit[];
}

export interface PasswordHabit {
  /** the shared stem, shown so the reader can see what the habit IS */
  stem: string;
  /** the leaked passwords that share it, in the order they were found */
  values: string[];
}

/**
 * Someone who is not the subject.
 *
 * A name search returns rows about everyone who shares the name. Each distinct person
 * the rows seem to describe is surfaced on their own, with what identifies them, so the
 * operator can say which one they meant. They are never consolidated into the subject.
 */
export interface RecordGroup {
  /** the database, and what that breach was */
  database: string;
  info: string;
  /** the rows, exactly as the source returned them */
  rows: Record<string, string>[];
  /** how each row was judged, so a reader can see why it is here */
  attribution: Attribution[];
}

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

/**
 * Columns that hold an identifier, never money.
 *
 * A platform's user id is a long number, and this is the column that says so. It is
 * checked FIRST and it is absolute: no value shape may overrule a field whose name
 * already told us what it is.
 */
const ID_LABEL = /\b(id|uid|guid|user.?id|profile|account.?id|facebook|fb|instagram|twitter|telegram|tiktok|snapchat|discord|steam|\bvk\b|\bok\b|member|customer.?no)\b/i;

/**
 * Card issuer prefixes, with the lengths each actually issues.
 *
 * This is the half that was missing, and the reason a social network's user ids were
 * reported as leaked bank cards. Luhn is a CHECKSUM, not an identity: roughly one
 * random number in ten passes it. A dump of a hundred-odd Facebook rows therefore
 * produced about fourteen "credit cards", each rendered as critical, under the words
 * "this is what enables direct-debit fraud".
 *
 * Luhn is still required, it rules out typos, but it is now the last test rather
 * than the only one. A number must also start like a card somebody could actually
 * have been issued, and be a length that issuer uses.
 */
const CARD_ISSUERS: { re: RegExp; lengths: number[] }[] = [
  { re: /^4/, lengths: [13, 16, 19] },                        // Visa
  { re: /^5[1-5]/, lengths: [16] },                           // Mastercard
  { re: /^2(2[2-9]|[3-6]\d|7[01]|720)/, lengths: [16] },      // Mastercard, 2-series
  { re: /^3[47]/, lengths: [15] },                            // American Express
  { re: /^3(0[0-5]|095|6|8|9)/, lengths: [14, 16, 19] },      // Diners
  { re: /^35(2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },    // JCB
  { re: /^(6011|64[4-9]|65)/, lengths: [16, 17, 18, 19] },    // Discover
];

function looksLikeCard(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  return CARD_ISSUERS.some((i) => i.re.test(digits) && i.lengths.includes(digits.length)) && luhn(digits);
}

export function looksFinancial(label: string, value: string): boolean {
  // The label is normalised FIRST. These patterns are \b-bounded, and an underscore is
  // a word character, so "profile_id" never matched \bprofile\b, and "BankAccount"
  // never matched \baccount.?number\b either. Both arrive from dumps in exactly those
  // shapes, and categorize() was already humanising for its own rules while passing the
  // raw string here.
  const L = humanLabel(label).toLowerCase();

  // A field whose NAME says identifier is an identifier, whatever its digits look like
  //, unless the same name also says money, which is how "BankAccount" stays financial
  // despite containing "account".
  if (ID_LABEL.test(L) && !FIN_LABEL.test(L)) return false;
  if (FIN_LABEL.test(L)) return true;
  const v = value.replace(/[\s-]/g, "");
  if (IBAN_RE.test(v)) return true;
  if (looksLikeCard(v)) return true;
  // A French RIB is 23 digits and nothing else of that length is common, but it is
  // still only read as one when no column name has claimed the field already.
  if (/^\d{23}$/.test(v)) return true;
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
    action: "Weigh it when a caller or letter cites your address as proof they are legitimate, it no longer is.",
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
    meaning: "Usernames, handles and profile links tied to you appear in breach data, this is how separate accounts get tied back to one person.",
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
// Category is decided from the column LABEL first (it carries the most intent, a column
// called "BankAccount" or "JobTitle" says exactly what it is), then the raw kind, then
// the value shape. Order matters: financial overrides, identity beats online so a name
// does not land under "handles", location beats contact.

const BIRTHISH = /birth|\bdob\b|\bbday\b|born/i;

/**
 * What a field is, decided by an ORDERED TABLE rather than a run of if-statements.
 *
 * The order here is load-bearing, and when it was implicit it was wrong three times in
 * one working session, each time producing a confident, alarming, false statement,
 * which is the only kind of defect that really matters in this product:
 *
 *   "LastLogin" was shown as an online account, because the rule that recognises
 *   handles matched the word "login" before anything looked at the field's type.
 *
 *   A street called "rue Alexandre Dumas" confirmed a person named Alexandre, because
 *   the value was read before the column was weighed.
 *
 *   A social network's user ids were reported as leaked bank cards, because a
 *   card-shaped value outranked a column that had already said it held an identifier.
 *
 * Writing the precedence down as data fixes the class rather than the three instances.
 * Each rule carries the reason it sits where it does, so moving one is a decision
 * somebody has to make on purpose instead of an accident of editing; and the ordering
 * itself becomes testable, "an identifier column beats a card-shaped value" is an
 * assertion, where "do not move line 14" is a hope.
 *
 * Read top to bottom; the first match wins. A rule returning `null` means the field is
 * metadata and belongs in no category at all.
 */
interface Rule {
  /** what this rule is, for the test that pins the order */
  id: string;
  /** why it sits HERE and not lower, the thing the old comments had to carry */
  why: string;
  category: Category | null;
  match: (c: { kind: ExposureItem["kind"]; label: string; rawLabel: string; value: string }) => boolean;
}

const PRECEDENCE: Rule[] = [
  {
    id: "password",
    why: "The most dangerous thing a dump can hold. Nothing should ever outrank it.",
    category: "password",
    match: (c) => c.kind === "credential" || /\b(pass(word|wd)?|pwd|hash|secret|otp|pin)\b/.test(c.label),
  },
  {
    id: "financial",
    why:
      "Second because bank details are what a person most needs told. looksFinancial " +
      "weighs the column name AGAINST the value shape internally, an earlier fix that " +
      "skipped this rule for anything typed `identifier` also skipped BankAccount, " +
      "which the upstream classifier types that way for containing the word 'account'.",
    category: "financial",
    match: (c) => looksFinancial(c.rawLabel, c.value),
  },
  {
    id: "document",
    why: "An identity-document number is the raw material identity theft is built on.",
    category: "document",
    match: (c) =>
      c.kind === "document" ||
      /\b(passport|national.?id|\bssn\b|\binn\b|snils|licen[cs]e|id.?card|driver|tax.?id|nino)\b/.test(c.label),
  },
  {
    id: "identity",
    why: "Before the date rule below, so a birthday is identity rather than metadata.",
    category: "identity",
    match: (c) =>
      c.kind === "name" ||
      /\b(full.?name|^name$|first.?name|last.?name|surname|patronym|\bfio\b|gender|\bsex\b)\b/.test(c.label) ||
      BIRTHISH.test(c.label),
  },
  {
    id: "activity-date",
    why:
      "ABOVE every label rule below it, and that is the whole point of its position. " +
      "'LastLogin' contains 'login', so the handle rule claimed it and a timestamp was " +
      "presented as an online account. A date that is not a birthday is account history, " +
      "and the person it belongs to learns nothing from being shown it.",
    category: null,
    match: (c) => c.kind === "date",
  },
  {
    id: "location",
    why: "Before contact details: an address is more specific than the email beside it.",
    category: "location",
    match: (c) =>
      c.kind === "address" ||
      /\b(address|street|city|region|country|postal|post.?code|\bzip\b|state|province|\bgeo\b|location)\b/.test(c.label),
  },
  {
    id: "email",
    why: "A contact detail, below the things that identify or endanger.",
    category: "email",
    match: (c) => c.kind === "email" || /e-?mail/.test(c.label),
  },
  {
    id: "phone",
    why: "As email.",
    category: "phone",
    match: (c) => c.kind === "phone" || /\b(phone|mobile|tel|msisdn|numero)\b/.test(c.label),
  },
  {
    id: "professional",
    why: "Above the catch-all for handles, so 'JobTitle' is work and not a profile.",
    category: "professional",
    match: (c) =>
      /\b(company|employer|job.?title|occupation|industry|department|position|role|level|work|professional|business)\b/.test(c.label),
  },
  {
    id: "online",
    why:
      "The broadest label rule, so it goes last among the matches, it recognises " +
      "'login', 'profile' and every platform name, which appear inside fields that are " +
      "really something else.",
    category: "online",
    match: (c) =>
      c.kind === "identifier" || c.kind === "login" ||
      /\b(nick|user.?name|login|profile|handle|telegram|facebook|instagram|twitter|\bvk\b|\bok\b|link|url|domain|site|\bip\b)\b/.test(c.label),
  },
  {
    id: "counters",
    why: "A tally is not a leaked detail about anybody.",
    category: null,
    match: (c) => c.kind === "count" || c.kind === "field",
  },
];

/** The rule ids in order, so a test can pin the precedence itself. */
export const precedenceOrder = (): string[] => PRECEDENCE.map((r) => r.id);

/** Which rule claims a field, exported so a test can name the winner, not just the outcome. */
export function ruleFor(it: ExposureItem): Rule | null {
  // Humanised first so CamelCase / snake_case columns ("CompanyName", "bank_account")
  // become "company name" / "bank account", otherwise \b-bounded keywords never match
  // inside a concatenated column name.
  const c = {
    kind: it.kind,
    label: humanLabel(it.label).toLowerCase(),
    rawLabel: it.label,
    value: it.value,
  };
  return PRECEDENCE.find((r) => r.match(c)) ?? null;
}

function categorize(it: ExposureItem): Category | null {
  const rule = ruleFor(it);
  // Nothing matched: it is something this code has never seen, and it is shown under
  // its own column name rather than dropped.
  return rule ? rule.category : "other";
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
export function buildReport(subject: Subject, databases: LeakDatabase[], region = "FR"): SearchReport {
  const infoByName = new Map(databases.map((d) => [d.name, d.info] as const));

  const findings: Finding[] = [];
  const ownRows: { database: string; items: ExposureItem[] }[] = [];
  // `full` separates the two populations that end up here: records that matched the
  // WHOLE selector (candidates for who you meant) from records that matched only part
  // of it (people who merely share a word).
  const foreign = new Map<string, { anchor: string; matched: Set<string>; sources: Set<string>; findings: Finding[]; full: boolean }>();
  let partial = 0, unrelated = 0;
  const byDatabase = new Map<string, RecordGroup>();

  for (const db of databases) {
    for (const row of db.rows) {
      const verdict = attributeRow(subject, row);
      const items = itemsFromRow(db, row);

      // Kept before anything is classified, so the raw view cannot inherit a mistake
      // made downstream. Rows belonging to nobody we asked for stay out, those are
      // the API's collateral, not the subject's record.
      if (verdict.attribution !== "none") {
        const g = byDatabase.get(db.name) ?? { database: db.name, info: db.info, rows: [], attribution: [] };
        byDatabase.set(db.name, g);
        g.rows.push(row);
        g.attribution.push(verdict.attribution);
      }

      if (verdict.attribution === "none") { unrelated += 1; continue; }

      // EVERY row that genuinely matched the selector contributes to what leaked. The
      // categories, the per-breach view, the timeline and the critical pull-outs are
      // facts about the DATA, and they do not depend on whether the selector happens to
      // designate one person.
      //
      // Refusing to merge a name into one identity is right. Refusing to show its rows
      // at all was an over-correction with a worse failure mode than the one it fixed:
      // a search returning an IBAN and a RIB rendered as "clear · 0 data points",
      // because every row had been filed away behind a collapsed panel. A tool that
      // hides what it found is not more careful than one that overstates it.
      if (verdict.attribution === "direct") {
        findings.push(...findingsFrom(items, db.name));
        if (subject.unique) {
          // only a selector that identifies somebody earns a consolidated identity
          ownRows.push({ database: db.name, items });
          continue;
        }
        // otherwise the row is one CANDIDATE record among the people who share the
        // name, shown in full, grouped, and never folded into a single person
        const anchor = anchorOf(items) || "(unidentified)";
        const key = "cand:" + anchor.toLowerCase();
        const group = foreign.get(key) ?? { anchor, matched: new Set<string>(), sources: new Set<string>(), findings: [], full: true };
        foreign.set(key, group);
        for (const w of verdict.words || []) group.matched.add(w);
        group.sources.add(db.name);
        group.findings.push(...findingsFrom(items, db.name));
        continue;
      }

      partial += 1;
      const anchor = anchorOf(items) || "(unidentified)";
      const key = anchor.toLowerCase();
      const group = foreign.get(key) ?? { anchor, matched: new Set<string>(), sources: new Set<string>(), findings: [], full: false };
      foreign.set(key, group);
      for (const w of verdict.words || []) group.matched.add(w);
      group.sources.add(db.name);
      group.findings.push(...findingsFrom(items, db.name));
    }
  }

  // --- the subject, consolidated into one person ---
  // Only ever from rows proven to be about ONE person. For any other selector this is
  // empty on purpose, and the summary says why rather than leaving a blank panel.
  const identity = consolidate(ownRows, { region });
  const candidateCount = [...foreign.values()].filter((g) => g.full).length;
  const summary = subject.unique
    ? describe(identity)
    : `"${subject.raw}" does not identify one person, so nothing is merged into a single profile. Everything found is below, grouped into ${candidateCount} candidate record${candidateCount === 1 ? "" : "s"}.`;

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

  // The passwords attributed to the subject, read for structure rather than listed.
  const secrets = [...new Set(findings.filter((f) => f.category === "password").map((f) => f.value))];
  const passwordHabits: PasswordHabit[] = [...patternGroups(secrets)]
    .map(([stem, values]) => ({ stem, values }))
    .sort((a, b) => b.values.length - a.values.length);

  // one tile per service, collapsing several dumps of the same company
  const tiles = serviceGrid(sources);

  const grouped = [...foreign.values()]
    .map((g) => ({ anchor: g.anchor, matched: [...g.matched], sources: [...g.sources].sort(), findings: g.findings, full: g.full }))
    .sort((a, b) => b.findings.length - a.findings.length || a.anchor.localeCompare(b.anchor));
  const candidates: OtherSubject[] = grouped.filter((g) => g.full);
  const others: OtherSubject[] = grouped.filter((g) => !g.full);

  const built: SearchReport = {
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
    records: [...byDatabase.values()],
    candidates,
    others,
    passwordHabits,
    pivots: [],
    services: tiles,
    servicesSummary: gridSummary(tiles),
  };
  // computed from the finished report, so it sees the consolidated identity AND the
  // candidate groups rather than a half-built version of either
  built.pivots = pivotTargets(built);
  return built;
}

/**
 * One line for the report card.
 *
 * On a subject that does not designate one person, the count of other people found is
 * part of the headline rather than a footnote, it is the single most important thing
 * to know before reading a name search's results as if they were one person's.
 */
export function headline(r: SearchReport): string {
  // A selector that cannot identify one person leads with that fact. Everything else in
  // the report reads differently once you know it, so it cannot be a closing footnote.
  if (!r.subject.unique) {
    const n = r.candidates.length;
    if (!n && !r.dataPoints) return `Nothing found for "${r.subject.raw}" at this search depth.`;
    const crit = r.categories.find((c) => c.severity === "critical");
    const base = `${r.dataPoints} leaked data point${r.dataPoints === 1 ? "" : "s"} across ${r.breachCount} breach${r.breachCount === 1 ? "" : "es"}`;
    const what = crit ? `${base}, including ${crit.label.toLowerCase()}` : base;
    return `${what}, grouped into ${n} candidate record${n === 1 ? "" : "s"}, because a name does not identify one person.`;
  }
  const extra = r.others.length
    ? ` ${r.others.length} other ${r.others.length === 1 ? "person" : "people"} matched part of this query and ${r.others.length === 1 ? "is" : "are"} listed separately.`
    : "";
  if (r.verdict === "clear") {
    const nothing = r.excluded.total
      ? `No row found that is about ${r.subject.raw}, ${r.excluded.total} returned row${r.excluded.total === 1 ? "" : "s"} belonged to someone else.`
      : "No exposure found at this search depth.";
    return nothing + extra;
  }
  const crit = r.categories.find((c) => c.severity === "critical");
  const base = `${r.dataPoints} leaked data point${r.dataPoints === 1 ? "" : "s"} across ${r.breachCount} breach${r.breachCount === 1 ? "" : "es"}`;
  return (crit ? `${base}, including ${crit.label.toLowerCase()}.` : `${base}.`) + extra;
}

// ---- what is worth pivoting on -------------------------------------------------------

export interface PivotTarget {
  value: string;
  kind: "email" | "phone" | "username";
  /** which databases carried it, a value three dumps agree on is the better hop */
  sources: string[];
}

/**
 * The identifiers a report surfaced that are worth searching in their own right.
 *
 * This is the whole point of the pivot: a name search ends with "two candidates who
 * share a name", and the addresses and numbers inside those candidates are exactly the
 * selectors that DO identify somebody. Searching one of them turns the ambiguity into
 * a person.
 *
 * The subject is never offered back, pivoting onto the query you just ran is a round
 * trip that buys nothing and bills for it. Most-corroborated first, because a value
 * three independent dumps agree on is the hop least likely to be a typo in one of them.
 */
export function pivotTargets(report: SearchReport): PivotTarget[] {
  const out = new Map<string, PivotTarget>();
  const subjectKeys = new Set([report.subject.canonical, report.subject.raw.toLowerCase()]);

  const add = (value: string, kind: PivotTarget["kind"], sources: string[]) => {
    const v = value.trim();
    const key = kind + ":" + v.toLowerCase();
    if (!v || subjectKeys.has(v.toLowerCase())) return;
    const existing = out.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, ...sources])];
      return;
    }
    out.set(key, { value: v, kind, sources: [...new Set(sources)] });
  };

  // a consolidated identity already knows which databases agreed on what
  for (const [facet, kind] of [["email", "email"], ["phone", "phone"], ["username", "username"]] as const) {
    for (const v of report.identity.facets[facet] || []) add(v.value, kind, v.sources);
  }

  // on a name search the identity is empty by design, so the candidates carry them
  for (const group of [...report.candidates, ...report.others]) {
    for (const f of group.findings) {
      if (f.category === "email") add(f.value, "email", [f.source]);
      else if (f.category === "phone") add(f.value, "phone", [f.source]);
    }
  }

  return [...out.values()].sort(
    (a, b) => b.sources.length - a.sources.length || a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
  );
}
