// Does the name on the account we found match the person we were looking for?
//
// This is the check that was missing, and it is the one that matters most when a
// handle was GUESSED. Searching "marie.dubois@gmail.com" produces the variant
// "mdubois", which finds a real GitLab account — belonging to Matthieu Dubois. Same
// surname, different person. Without this check the tool read two facts off that
// profile (a name, an avatar) and called the link PROBABLE.
//
// The rule is deliberately narrow, because a name check that fires too often is worse
// than none:
//   - same surname + clearly different given name → CONTRADICTION. This is the common
//     collision (family members, namesakes) and the one that produces confident errors.
//   - both parts agree → corroboration, but only ever soft: a name is not an identifier.
//   - anything ambiguous (initials, a single word, a nickname, a non-Latin script we
//     cannot fold) → NO verdict at all. Silence beats a guess.

/** Fold accents and case so "Müller" and "muller" compare equal. */
export function foldName(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a display name into comparable word parts. */
export function nameParts(s: string): string[] {
  return foldName(s).split(/[\s'-]+/).filter((p) => p.length > 1);
}

/**
 * Pull a probable given/family pair out of a handle-ish string such as an email local
 * part ("marie.dubois", "marie_dubois", "mdubois"). Returns null when the string does
 * not clearly carry two name parts — "mdubois" alone is an initial plus a surname and
 * tells us nothing about the given name.
 */
export function namePairFromHandle(handle: string): { given: string; family: string } | null {
  const parts = foldName(handle).split(/[\s._-]+/).filter(Boolean);
  const words = parts.filter((p) => p.length > 1);
  if (words.length < 2) return null;
  return { given: words[0], family: words[words.length - 1] };
}

export type NameVerdict = "agrees" | "conflicts" | "unknown";

export interface NameMatch {
  verdict: NameVerdict;
  /** analyst-facing sentence, empty when unknown */
  detail: string;
}

/**
 * Compare what we expected (from the seed) with what the profile actually says.
 * `expected` is a name pair; `observed` is the profile's display name.
 */
export function matchName(expected: { given: string; family: string } | null, observed?: string): NameMatch {
  if (!expected || !observed) return { verdict: "unknown", detail: "" };
  const obs = nameParts(observed);
  if (obs.length < 2) return { verdict: "unknown", detail: "" }; // a mononym proves nothing

  const family = expected.family;
  const given = expected.given;
  const hasFamily = obs.some((w) => w === family);
  if (!hasFamily) return { verdict: "unknown", detail: "" }; // different surname: could be a pseudonym, not a contradiction

  // the surname matches — now the given name decides
  const givenMatch = obs.some((w) => w === given);
  if (givenMatch) {
    return {
      verdict: "agrees",
      detail: `The profile name "${observed}" carries both parts expected from the seed (${given} ${family}).`,
    };
  }
  // an initial is not a mismatch: "m. dubois" is compatible with "marie dubois"
  const initialOnly = obs.some((w) => w.length === 1 || (w.length === 2 && w.endsWith(".")));
  if (initialOnly) return { verdict: "unknown", detail: "" };
  const otherGiven = obs.find((w) => w !== family) || "";
  // A diminutive is an ABBREVIATION: "matt" of "matthieu", "chris" of "christopher".
  // Sharing an initial is not enough — "marie" and "matthieu" share one letter and are
  // plainly different names, and that is precisely the collision this check exists for.
  const prefixOf = (a: string, b: string) => a.length >= 3 && b.startsWith(a);
  if (otherGiven && (prefixOf(otherGiven, given) || prefixOf(given, otherGiven))) {
    return { verdict: "unknown", detail: "" };
  }
  return {
    verdict: "conflicts",
    detail: `The profile name is "${observed}" — same family name, but the given name is "${otherGiven}", not "${given}". On a guessed handle this usually means a different person (a relative or a namesake). Dismiss it only if "${otherGiven}" is a known nickname for "${given}".`,
  };
}

export interface NameEvidence { name: string; detail: string; source: string; weight: number }

/** Evidence for the graph, or null when there is nothing defensible to say. */
export function nameMatchEvidence(m: NameMatch, source: string): NameEvidence | null {
  if (m.verdict === "unknown") return null;
  if (m.verdict === "conflicts") {
    return {
      // "conflicting" is what lib/scoring classifies as a contradiction
      name: "Conflicting given name on a guessed handle",
      detail: m.detail,
      source,
      weight: 65,
    };
  }
  return {
    name: "Profile name agrees with the seed",
    detail: m.detail,
    source,
    weight: 55,
  };
}
