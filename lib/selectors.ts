// What kind of subject is this?
//
// The product accepts exactly two selectors: an email address and a phone number. Both
// resolve to ONE person — that is the whole reason they are the only two. A name does
// not, which is why there is no name search: it would return a stranger's data as often
// as the subject's, and no amount of interface makes that a product.
//
// Pure and dependency-light on purpose: the landing page, the search form and the API
// route all have to agree on what a valid subject is, and a client component cannot
// drag a server module in to find out.

import { looksLikePhone, phoneIntel } from "./phone";

export type SubjectKind = "email" | "phone";

// Deliberately permissive on the local part and strict on the shape. An address this
// rejects is one the leak source would not match either.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(s: string): boolean {
  const t = String(s || "").trim();
  return t.length <= 254 && EMAIL_RE.test(t);
}

/** A phone number in any common notation — "+33 6 12 34 56 78", "06.12.34.56.78", "+1 (415) 555-0100". */
export function isPhone(s: string): boolean {
  return looksLikePhone(String(s || ""));
}

/** The kind, or null when the input is neither — which is what the form has to say. */
export function subjectKind(s: string): SubjectKind | null {
  const t = String(s || "").trim();
  if (!t) return null;
  if (isEmail(t)) return "email";
  if (isPhone(t)) return "phone";
  return null;
}

/**
 * The canonical form we search on and bill for.
 *
 * An email is lower-cased — addresses are case-insensitive in practice and a dump that
 * stored "John@" must still match a search for "john@". A phone is normalised to E.164
 * when it parses, because a dump holding "+33612345678" and a user typing "06 12 34 56 78"
 * are the same number and only one of them is a stable key. `defaultCountry` decides how
 * a national-format number is read; it is a real choice, not a default to ignore.
 */
export function canonicalSubject(s: string, defaultCountry = "FR"): string {
  const t = String(s || "").trim();
  if (isEmail(t)) return t.toLowerCase();
  if (isPhone(t)) {
    const intel = phoneIntel(t, defaultCountry);
    return intel.e164 || t.replace(/[^\d+]/g, "");
  }
  return t;
}
