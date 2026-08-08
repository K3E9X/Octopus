// The passphrase rule, in one place.
//
// It lives on its own because BOTH sides need it and they must not drift: the server
// enforces it in lib/auth.ts, and the Access screen has to tell the operator the truth
// while they type. A strength meter that says "descending" about a passphrase the
// server is going to reject is worse than no meter — it invites someone to submit,
// fail, and re-guess what the rule was.
//
// Pure: no node:crypto, no database, so the client can import it.

/** null when the passphrase is acceptable; otherwise the missing requirement. */
export function passwordProblem(pw: string): string | null {
  if (!pw || pw.length < 10) return "at least 10 characters";
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return "letters and at least one digit";
  return null;
}

/**
 * Depth as the metaphor: length first, then variety. This is a QUALITY score and is
 * deliberately separate from the rule above — passing the rule is the floor, not the
 * goal, and the meter's job past that point is to encourage rather than to gate.
 */
export function strength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/\d/.test(pw) && /[a-z]/i.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

export const STRENGTH_LABEL = [
  "too shallow to hold",
  "surface — too shallow",
  "descending",
  "deep",
  "abyssal — good",
];
