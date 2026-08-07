// Password patterns as a behavioural fingerprint.
//
// `Soleil2019!` and `Soleil2021!` are not the same secret, so exact-match reuse misses
// them entirely — and they are almost certainly the same person. People do not pick a
// fresh password, they increment the one they had. The root, the shape of the numeric
// part and the punctuation tail together form a habit, and a habit is evidence.
//
// It is strictly WEAKER than an exact match and the code says so everywhere: an exact
// reuse is one observed string, a pattern match is an inference about how someone
// behaves. Two people can independently land on "Marseille2020!" — a city and a year is
// a very popular way to build a password — so the guard here is harsher than the one in
// lib/reuse.ts, not softer.

export interface PwPattern {
  /** the alphabetic stem, lowercased */
  root: string;
  /** the numeric run that was stripped, if any */
  digits?: string;
  /** the punctuation tail that was stripped, if any */
  tail?: string;
  /** true when the digits look like a year — the commonest increment */
  yearLike: boolean;
  /** did the stem keep any internal capitalisation pattern worth matching */
  capShape: string;
  /** the comparable key: same key = same habit */
  key: string;
}

/**
 * Decompose a secret into root + digits + tail.
 *
 * Only a TRAILING numeric run is stripped. A digit in the middle is part of the stem
 * ("Tr0ubador") and removing it would collapse unrelated secrets onto one root.
 */
export function pwPattern(secretRaw: string): PwPattern | null {
  const secret = String(secretRaw || "");
  if (!secret) return null;

  const m = secret.match(/^(.*?)(\d+)?([^A-Za-z0-9]*)$/);
  if (!m) return null;
  const stem = m[1] || "";
  const digits = m[2] || "";
  const tail = m[3] || "";

  const root = stem.toLowerCase();
  if (!root) return null;

  // A capitalisation shape is part of the habit: someone who writes "Soleil" every time
  // is a different signal from someone who writes "soleil".
  const capShape = /^[A-Z][a-z]+$/.test(stem) ? "Title" : /^[A-Z]+$/.test(stem) ? "UPPER" : /^[a-z]+$/.test(stem) ? "lower" : "mixed";
  const yearLike = /^(19|20)\d{2}$/.test(digits);

  return {
    root, digits: digits || undefined, tail: tail || undefined, yearLike, capShape,
    // the digits are deliberately NOT in the key — varying them is the whole point
    key: `${root}|${capShape}|${tail}|${digits ? digits.length : 0}`,
  };
}

/**
 * Roots so common that sharing one is meaningless. This is deliberately broader than
 * the common-password list in lib/reuse.ts: there, the whole string had to collide;
 * here only the stem does, which happens far more often by chance.
 */
const WEAK_ROOTS = new Set([
  "password", "passwd", "pass", "motdepasse", "azerty", "qwerty", "admin", "login",
  "welcome", "bonjour", "hello", "test", "user", "guest", "root", "secret", "changeme",
  "soleil", "sunshine", "summer", "winter", "spring", "autumn", "monkey", "dragon",
  "football", "baseball", "iloveyou", "princess", "master", "shadow", "letmein",
  "abc", "abcd", "aaa", "qwe", "asd", "zxc", "temp", "default", "france", "paris",
  "january", "february", "december", "janvier", "septembre", "chocolat", "amour",
]);

export interface PatternVerdict {
  linkable: boolean;
  strength: number;
  reason: string;
}

/**
 * May these two secrets be treated as one person's habit?
 *
 * The bar: same key, different actual secret (an identical secret is exact reuse and
 * belongs to lib/reuse.ts), a root that is not a common word, and a root long enough
 * that a collision means something. A month plus a year is not a fingerprint.
 */
export function patternMatch(a: string, b: string): PatternVerdict {
  const pa = pwPattern(a), pb = pwPattern(b);
  if (!pa || !pb) return { linkable: false, strength: 0, reason: "not decomposable" };
  if (a === b) return { linkable: false, strength: 0, reason: "identical secrets — that is exact reuse, not a pattern" };
  if (pa.key !== pb.key) return { linkable: false, strength: 0, reason: "different habit" };
  if (pa.root.length < 5) return { linkable: false, strength: 0, reason: `root "${pa.root}" is too short to be distinctive` };
  if (WEAK_ROOTS.has(pa.root)) {
    return { linkable: false, strength: 0, reason: `"${pa.root}" is a very common password stem — unrelated people land on it independently` };
  }
  if (/^[a-z]+$/.test(pa.root) && pa.root.length < 7 && !pa.tail) {
    return { linkable: false, strength: 0, reason: `a short all-lowercase stem with no punctuation is too weak a habit to link on` };
  }

  // Strength: the longer and more structured the habit, the less likely two strangers
  // share it. Capped well below exact reuse — this is an inference, not an observation.
  let s = 26 + Math.min(20, (pa.root.length - 5) * 3);
  if (pa.tail) s += 8;                        // a punctuation tail is a personal tic
  if (pa.capShape === "mixed") s += 6;
  if (pa.yearLike && pb.yearLike) s += 6;     // the classic increment
  const strength = Math.max(25, Math.min(58, s));

  return {
    linkable: true,
    strength,
    reason: `"${a}" and "${b}" share the stem "${pa.root}"${pa.tail ? ` and the tail "${pa.tail}"` : ""}${pa.yearLike ? `, differing only in the year` : ", differing only in the numeric part"} — the same password habit, incremented`,
  };
}

/** Group secrets by habit. Only groups with more than one distinct secret matter. */
export function patternGroups(secrets: string[]): Map<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const s of secrets) {
    const p = pwPattern(s);
    if (!p) continue;
    const set = by.get(p.key) || new Set<string>();
    set.add(s);
    by.set(p.key, set);
  }
  const out = new Map<string, string[]>();
  for (const [k, set] of by) {
    if (set.size < 2) continue;
    const arr = [...set];
    // a group is only worth reporting if at least one PAIR in it qualifies
    if (arr.some((x, i) => arr.slice(i + 1).some((y) => patternMatch(x, y).linkable))) out.set(k, arr);
  }
  return out;
}
