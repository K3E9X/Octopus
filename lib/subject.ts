// What are we searching for?
//
// The API takes any string and searches every permutation of its words. That is more
// capable than an identifier-only lookup and it is also where the precision goes if
// nobody is careful: a multi-word query matches rows that contain only SOME of the
// words, so a result set is not automatically a result set ABOUT the subject. This
// module decides three things before a single request is billed.
//
//   WHAT KIND of selector this is, because that decides whether the answer can be a
//   report about one person at all. An email, a phone and a handle designate someone.
//   A name does not, thousands of people share one, so a name search returns
//   candidates to be told apart, never a merged profile. Rendering it as one person's
//   report would be a fabrication, and it is the single easiest way for a tool like
//   this to lie confidently.
//
//   WHAT TO SEND, which is not always what was typed. A phone number typed as
//   "06 12 34 56 78" and stored in a dump as "+33612345678" are the same number and
//   only one of them is a usable key.
//
//   WHAT TO MATCH ROWS AGAINST afterwards. Dumps store the same value in many shapes,
//   so attribution needs every shape, not the canonical one. This is the list that
//   lib/attribution.ts checks each returned row against.

import { looksLikePhone, phoneIntel } from "./phone";
import { canonicalEmail } from "./emailkey";

export type SubjectKind = "email" | "phone" | "username" | "name" | "free";

export interface Subject {
  /** exactly what the operator typed, preserved for display and for the audit trail */
  raw: string;
  kind: SubjectKind;
  /** the string actually sent as `request`, canonicalised, and quoted when exact */
  query: string;
  /** the normalised value a row has to contain to be attributable */
  canonical: string;
  /**
   * Every spelling a dump might hold this value in. Attribution matches on ALL of
   * these, because a number stored nationally and a number typed internationally are
   * the same fact and missing that is a false negative on the most useful row.
   */
  variants: string[];
  /** does this selector designate ONE person? A name does not. */
  unique: boolean;
  /** what the operator needs to know about how this query was shaped */
  note?: string;
}

// Permissive on the local part, strict on the shape: an address this rejects would not
// match in a dump either.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// A handle: no spaces, no @domain, and long enough not to be noise.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
// A handle that is ONLY letters is indistinguishable from a surname, and "Martin" is
// not an identifier. Anything carrying a digit, a dot, an underscore or a hyphen is
// shaped like something a person chose; a bare word is not.
const HANDLE_SHAPED = /[0-9._-]/;
// Two or more words that look like words, not identifiers.
const NAME_RE = /^[\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’.-]*){1,4}$/u;

export function isEmail(s: string): boolean {
  const t = String(s || "").trim();
  return t.length <= 254 && EMAIL_RE.test(t);
}

export function isPhone(s: string): boolean {
  return looksLikePhone(String(s || ""));
}

export function detectKind(s: string): SubjectKind {
  const t = String(s || "").trim();
  if (!t) return "free";
  if (isEmail(t)) return "email";
  if (isPhone(t)) return "phone";
  if (NAME_RE.test(t)) return "name";
  if (USERNAME_RE.test(t)) return "username";
  return "free";
}

// ---- the shapes a dump might store a value in -------------------------------------

/**
 * Gmail treats dots as nothing and everything after a `+` as a tag, so
 * `john.doe+shop@gmail.com` and `johndoe@gmail.com` are one mailbox. That equivalence
 * is real and worth matching on, unlike guessing that a local part is a username,
 * which is not, and which is why no such variant is produced here.
 */
// The rule itself lives in lib/emailkey, because registration needs the same one and
// must not pull libphonenumber in to get it.
export { canonicalEmail } from "./emailkey";

const DOTLESS_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function emailVariants(addr: string): string[] {
  const lower = addr.toLowerCase();
  const out = new Set<string>([lower]);
  const at = lower.lastIndexOf("@");
  if (at > 0) {
    const domain = lower.slice(at + 1);
    let local = lower.slice(0, at);
    const plus = local.indexOf("+");
    if (plus > 0) out.add(local.slice(0, plus) + "@" + domain);
    if (DOTLESS_DOMAINS.has(domain)) {
      local = (plus > 0 ? local.slice(0, plus) : local).replace(/\./g, "");
      if (local) out.add(local + "@" + domain);
    }
  }
  return [...out];
}

/**
 * A number lives in dumps as E.164, as a national string, as bare digits, and with
 * every separator a form has ever allowed. All of them are the same number.
 */
function phoneVariants(input: string, defaultCountry: string): { canonical: string; variants: string[] } {
  const intel = phoneIntel(input, defaultCountry);
  const typedDigits = input.replace(/\D/g, "");
  const out = new Set<string>();
  // When the number does not parse, the digits are sent AS TYPED. Prefixing "+" to them
  // manufactures an E.164 number that belongs to somebody else, "2125551234" read as a
  // French number became "+332125551234", and the operator was then billed for a search
  // of a line nobody owns, under a note claiming it had been searched as typed.
  const canonical = intel.valid && intel.e164 ? intel.e164 : (typedDigits || input.trim());

  if (intel.e164) {
    out.add(intel.e164);                       // +33612345678
    out.add(intel.e164.slice(1));              // 33612345678
  }
  if (intel.national) {
    out.add(intel.national);                   // 06 12 34 56 78
    out.add(intel.national.replace(/\D/g, "")); // 0612345678
  }
  if (typedDigits) out.add(typedDigits);
  out.add(input.trim());
  return { canonical, variants: [...out].filter(Boolean) };
}

// ---- building the query ------------------------------------------------------------

export interface BuildOpts {
  /** how a national-format number is read; a real choice, not a default to ignore */
  defaultCountry?: string;
  /**
   * Quote a multi-word query so the API treats it as ONE word.
   *
   * This is not only a price lever, it changes what is searched. Unquoted, the API
   * runs every permutation of the words and finds "Doe John Q" too, thorough,
   * and sixteen times the complexity. Quoted, it matches the phrase as written, * a sixth of the price and strictly fewer rows. Neither is the right default for
   * everyone, so the caller chooses and the interface prices both.
   */
  exact?: boolean;
}

export function buildSubject(raw: string, opts: BuildOpts = {}): Subject {
  const trimmed = String(raw || "").trim();
  const kind = detectKind(trimmed);

  if (kind === "email") {
    const canonical = trimmed.toLowerCase();
    return {
      raw: trimmed, kind, query: canonical, canonical,
      variants: emailVariants(canonical), unique: true,
    };
  }

  if (kind === "phone") {
    const { canonical, variants } = phoneVariants(trimmed, opts.defaultCountry || "FR");
    const intel = phoneIntel(trimmed, opts.defaultCountry || "FR");
    return {
      raw: trimmed, kind, query: canonical, canonical, variants, unique: true,
      note: intel.valid
        ? `Read as ${intel.international} (${intel.country}). Dumps store numbers in several shapes; all of them are matched.`
        : `Not a valid number for region ${opts.defaultCountry || "FR"}, searched as typed, which may under-report.`,
    };
  }

  if (kind === "username") {
    const canonical = trimmed.toLowerCase();
    // "jdupont_75" is a handle somebody picked. "Martin" is a surname, and treating it
    // as a unique identifier is how every stranger who shares it gets merged into one
    // fabricated person. The shape is the only honest signal available here.
    const unique = HANDLE_SHAPED.test(trimmed);
    return {
      raw: trimmed, kind, query: trimmed, canonical, variants: [canonical], unique,
      note: unique
        ? "A handle usually belongs to one person, but it is not proof of one, unlike an address, nothing stops two people choosing the same name."
        : "A single word of letters could be a handle or could be a surname, and there is no way to tell from here. Results are grouped by who they appear to be rather than merged.",
    };
  }

  if (kind === "name") {
    const exact = opts.exact !== false; // quoting is the safer and cheaper default
    const words = trimmed.split(/\s+/).filter(Boolean);
    return {
      raw: trimmed, kind,
      query: exact ? `"${trimmed}"` : trimmed,
      canonical: trimmed.toLowerCase(),
      variants: [trimmed.toLowerCase(), ...words.map((w) => w.toLowerCase())],
      unique: false,
      note: exact
        ? "Searched as an exact phrase. Cheaper and narrower; it will not find the name written in another order."
        : "Searched across every word order. More thorough and several times the price, and it also returns rows that match only part of the name.",
    };
  }

  return {
    raw: trimmed, kind: "free", query: trimmed, canonical: trimmed.toLowerCase(),
    variants: [trimmed.toLowerCase()], unique: false,
    note: "Searched verbatim. A free-text term is not an identifier, so what comes back is material to read, not a report about a person.",
  };
}
