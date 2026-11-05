// Phone connector — deterministic, offline intel from a number (validity, country,
// line type, formats) via libphonenumber. Automated owner-identity lookup isn't free,
// so the node points to the Epieos / Truecaller / PhoneInfoga pivots (pre-filled).

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export function looksLikePhone(s: string): boolean {
  const t = s.trim();
  if (!/^\+?[\d\s().\-]{7,20}$/.test(t)) return false;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

export interface PhoneIntel {
  input: string;
  valid: boolean;
  e164?: string;
  international?: string;
  national?: string;
  country?: string;
  callingCode?: string;
  type?: string;
}

export function phoneIntel(input: string, defaultCountry = "FR"): PhoneIntel {
  try {
    const p = parsePhoneNumberFromString(input, defaultCountry as CountryCode);
    if (!p) return { input, valid: false };
    return {
      input,
      valid: p.isValid(),
      e164: p.number,
      international: p.formatInternational(),
      national: p.formatNational(),
      country: p.country,
      callingCode: p.countryCallingCode ? "+" + p.countryCallingCode : undefined,
      type: p.getType(),
    };
  } catch {
    return { input, valid: false };
  }
}

/**
 * The key two spellings of the same subscriber share.
 *
 * The national trunk prefix is the trap. In most of Europe the leading "0" of a
 * national number is not part of the number — the country code REPLACES it rather than
 * being prepended to it — so "+33612345678" and "0612345678" are one subscriber whose
 * digit strings have neither a common prefix nor a common suffix until that 0 is gone.
 *
 * Reducing to the last nine significant digits handles both that and a missing country
 * code at once. Nine is where a coincidental tail stops being plausible; below it the
 * whole digit string is the key, because a short number has nothing to spare.
 *
 * Shared by attribution (does this row concern the subject?) and consolidation (are
 * these two rows giving the same number?) so the two can never disagree.
 */
export const PHONE_SIGNIFICANT = 9;

export function phoneKey(raw: string): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  const trimmed = d.replace(/^0+/, "") || d;
  return trimmed.length > PHONE_SIGNIFICANT ? trimmed.slice(-PHONE_SIGNIFICANT) : trimmed;
}
