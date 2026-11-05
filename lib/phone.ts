// Phone connector, deterministic, offline intel from a number (validity, country,
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
 * This decides whether two rows are giving the SAME number, which is what turns into a
 * claim that two independent databases corroborate each other. Getting it wrong in the
 * generous direction does not merely lose a match, it fabricates the exact corroboration
 * this product exists to be careful about.
 *
 * It used to reduce every number to its last nine digits. That handles the European
 * trunk prefix, where the leading 0 of a national number is REPLACED by the country code
 * rather than appended to it, so "+33612345678" and "0612345678" are one subscriber whose
 * digit strings share neither a prefix nor a suffix until the 0 is gone.
 *
 * But a North American national significant number is TEN digits, not nine, so nine cut
 * the first digit of the area code off: +1 212 555 1234 and +1 312 555 1234 both reduced
 * to "125551234", and two strangers in two different dumps were reported as one person
 * whose number both agreed on.
 *
 * So the number is parsed properly, and E.164, which is unambiguous by construction, is
 * the key whenever it can be had. The digit fallback is only for input no library can
 * make sense of, and there it keeps every digit rather than guessing which ones matter.
 *
 * PARSING IS THE TEST, NOT VALIDITY. This used to demand isValid() before trusting the
 * E.164, and those are two different questions. isValid() asks whether the range is
 * assignable to a subscriber today; identity asks whether two strings denote the same
 * number. A range reserved for fiction, a block allocated after the library's metadata
 * was cut, an unusual MVNO, all parse to exactly the right E.164 and all answer false.
 * Each one fell through to the digit fallback, where a national number and the same
 * number written internationally share neither prefix nor suffix, so one subscriber was
 * reported as two numbers from two databases. The landing page's demo is what caught
 * it: the page claims a number is matched past its country code, directly above a
 * report listing one number twice.
 *
 * Trusting the parse is also the SAFER direction. The E.164 is a function of the digits
 * and the region, so two different subscribers cannot produce the same one; the digit
 * fallback, which strips leading zeros, genuinely can.
 */
export function phoneKey(raw: string, region = "FR"): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  const intel = phoneIntel(t, region);
  if (intel.e164) return intel.e164;
  const d = t.replace(/\D/g, "");
  return d.replace(/^0+/, "") || d;
}
