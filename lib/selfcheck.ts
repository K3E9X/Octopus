// Self-exposure report — what a person's own breach data means to them.
//
// This is the consumer product: someone proves they own an email / phone / login, and
// this turns the raw LeakOSINT rows into a report they can act on — grouped by what the
// datum IS, ranked by how much it should worry them, each with a concrete next step.
//
// It deliberately speaks to the OWNER of the data ("your password", "change it"), not to
// an investigator. The gate that you only ever reach this for an identifier you have
// verified you control lives in the route; this module assumes that has already passed.
//
// Pure and synchronous: no network, no database, so it is testable and runs anywhere.

import type { ExposureItem } from "./exposure";

export type Category = "password" | "financial" | "document" | "email" | "phone" | "address" | "login" | "other";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  category: Category;
  severity: Severity;
  /** the leaked value, as it is (masked values stay masked) */
  value: string;
  /** which breach it came from */
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

export interface SelfReport {
  /** the verified identifier this report is about */
  subject: string;
  /** how exposed, in one word, for the headline */
  verdict: "clear" | "exposed" | "critical";
  /** breaches the subject appears in, newest-looking first */
  breaches: { name: string; info: string }[];
  categories: CategoryReport[];
  /** total distinct leaked data points */
  dataPoints: number;
}

// ---- financial detection -------------------------------------------------------------
// The base exposure classifier has no "financial" kind, but a RIB / IBAN / card is the
// thing a person most needs told. Detect it here from the column name and the shape.

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const FIN_LABEL = /\b(rib|iban|bic|swift|bank|banque|compte|card|carte|cc_?num|pan|ccv|cvv|paypal|crypto|wallet)\b/i;

function looksFinancial(label: string, value: string): boolean {
  if (FIN_LABEL.test(label)) return true;
  const v = value.replace(/[\s-]/g, "");
  if (IBAN_RE.test(v)) return true;                 // an IBAN
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
    meaning: "A password tied to you is in a breach. If you reused it anywhere, those accounts are open to anyone with this dump.",
    action: "Change it everywhere you used it, and turn on two-factor authentication.",
  },
  financial: {
    label: "Financial", severity: "critical",
    meaning: "Bank or card details tied to you have leaked. This is what enables fraud and unauthorised charges.",
    action: "Tell your bank, watch the account, and have a leaked card reissued.",
  },
  document: {
    label: "Identity documents", severity: "high",
    meaning: "An identity document number tied to you is exposed, which is what identity theft is built on.",
    action: "Note the number, and be alert to accounts or credit opened in your name.",
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
  address: {
    label: "Postal address", severity: "medium",
    meaning: "A physical address tied to you has leaked.",
    action: "Factor it into how much you trust mail or callers who cite it as proof of identity.",
  },
  login: {
    label: "Usernames", severity: "low",
    meaning: "A handle linked to you appears in breach data, which is how separate accounts get tied back to one person.",
    action: "Nothing urgent, but know these accounts can be connected to you.",
  },
  other: {
    label: "Other fields", severity: "low",
    meaning: "Other data tied to you appears in the breach.",
    action: "Review it and judge whether any of it is sensitive in your situation.",
  },
};

const ORDER: Category[] = ["password", "financial", "document", "email", "phone", "address", "login", "other"];
const RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function categorize(it: ExposureItem): Category {
  if (it.kind === "credential") return "password";
  if (looksFinancial(it.label, it.value)) return "financial";
  if (it.kind === "document") return "document";
  if (it.kind === "email") return "email";
  if (it.kind === "phone") return "phone";
  if (it.kind === "address") return "address";
  if (it.kind === "identifier") return "login";
  if (it.kind === "name") return "other";
  return "other";
}

/**
 * Build the report from the exposure items of a verified subject.
 *
 * `items` are the fields LeakOSINT returned for this identifier (breach lines excluded —
 * they are passed separately). Nothing here decides WHETHER the person may see this; the
 * route already proved they own `subject`.
 */
export function buildReport(subject: string, items: ExposureItem[], breaches: { name: string; info: string }[]): SelfReport {
  const byCat = new Map<Category, Map<string, Finding>>();

  for (const it of items) {
    if (it.kind === "breach" || it.kind === "record" || it.kind === "field" || it.kind === "date") continue;
    const category = categorize(it);
    const sev = category === "financial" ? "critical" : META[category].severity;
    const bucket = byCat.get(category) || new Map<string, Finding>();
    // dedupe on value within a category: the same password in ten rows is one exposure
    const key = it.value.toLowerCase();
    if (!bucket.has(key)) {
      bucket.set(key, { category, severity: sev, value: it.value, source: it.source || "breach", masked: it.masked });
    }
    byCat.set(category, bucket);
  }

  const categories: CategoryReport[] = ORDER
    .filter((c) => byCat.has(c))
    .map((c) => {
      const findings = [...byCat.get(c)!.values()];
      return { category: c, ...META[c], findings, distinct: findings.length };
    });

  const dataPoints = categories.reduce((n, c) => n + c.distinct, 0);
  const worst = categories.reduce<Severity>((w, c) => (RANK[c.severity] > RANK[w] ? c.severity : w), "low");
  const verdict: SelfReport["verdict"] = !categories.length ? "clear" : RANK[worst] >= 3 ? "critical" : "exposed";

  return { subject, verdict, breaches, categories, dataPoints };
}

/** One-line headline for the report card and the share-nothing summary. */
export function headline(r: SelfReport): string {
  if (r.verdict === "clear") return "No exposure found at this search depth.";
  const hi = r.categories.find((c) => c.severity === "critical");
  if (hi) return `${r.dataPoints} leaked data point(s) across ${r.breaches.length} breach(es), including ${hi.label.toLowerCase()}.`;
  return `${r.dataPoints} leaked data point(s) across ${r.breaches.length} breach(es).`;
}
