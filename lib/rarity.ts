// Handle rarity — the missing weight in username correlation.
//
// "Same handle on two platforms" is treated as one uniform signal almost everywhere,
// but the truth is entirely about RARITY: "xk9_zulu_42" on two sites is near-proof of
// one person, while "alex" on two sites is worth nothing — thousands of people hold it.
// Scoring both the same is how username-based tools manufacture false positives.
//
// This is a heuristic, computed locally and deterministically: length, character
// variety, word structure, and a list of very common handles/first names. It is honest
// about being an estimate — it shifts weight, it never asserts identity by itself.

export type RarityBand = "common" | "moderate" | "distinctive" | "unique";

export interface Rarity {
  /** 0..1 — higher means rarer / more identifying */
  score: number;
  band: RarityBand;
  reason: string;
}

// Handles so common that sharing one says nothing. Kept short and high-signal.
const COMMON = new Set([
  "admin", "root", "test", "user", "guest", "info", "contact", "mail", "me", "hello",
  "support", "dev", "team", "official", "real", "the", "my", "web", "app", "news",
  "alex", "sam", "max", "chris", "john", "mike", "dave", "nick", "tom", "dan", "ben",
  "anna", "maria", "sarah", "julia", "laura", "emma", "sophie", "lisa", "kate", "amy",
  "gamer", "player", "music", "photo", "design", "art", "code", "tech", "crypto", "trader",
]);

// Frequent English/French words that make a handle less identifying when they dominate.
const FILLER = /^(the|my|real|official|its|iam|im|mr|mrs|dr|xx|xo|le|la|les|un|une)$/;

function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h; // bits per character
}

/** Estimate how identifying a handle is. Pure and deterministic. */
export function handleRarity(handle: string): Rarity {
  const h = handle.trim().replace(/^@/, "").replace(/^u\//, "").toLowerCase();
  const core = h.replace(/[^a-z0-9]/g, "");
  if (!core) return { score: 0, band: "common", reason: "empty handle" };

  if (COMMON.has(core)) return { score: 0.05, band: "common", reason: `"${core}" is a very common handle` };

  const reasons: string[] = [];
  let score = 0;

  // length: short handles are heavily contested, long ones are nearly unique.
  // Calibrated so a distinctive single surname (8-9 chars, e.g. "torvalds") clears
  // the "common" band — under-weighting a real surname loses genuine evidence.
  const len = core.length;
  const lenScore = Math.max(0, Math.min(1, (len - 4) / 9)); // 4 → 0, 13+ → 1
  score += lenScore * 0.4;
  if (len >= 12) reasons.push("long");
  else if (len <= 5) reasons.push("short");

  // character variety: digits and mixed classes add identifying power
  const hasDigit = /\d/.test(core);
  const hasSep = /[._-]/.test(h);
  const entropy = shannon(core); // ~2.5 for repetitive, ~4+ for varied
  const entScore = Math.max(0, Math.min(1, (entropy - 2.2) / 2.0));
  score += entScore * 0.35;
  if (hasDigit) { score += 0.12; reasons.push("contains digits"); }
  if (hasSep) { score += 0.05; reasons.push("separated"); }
  if (entropy >= 3.6) reasons.push("varied characters");

  // structure: a handle made only of a filler + a common first name stays common
  const words = h.split(/[._\-]+/).filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.test(w) && !COMMON.has(w));
  if (meaningful.length === 0) {
    return { score: 0.12, band: "common", reason: "built only from common words / first names" };
  }
  if (words.length >= 2 && meaningful.length >= 2) { score += 0.08; reasons.push("multi-part"); }

  score = Math.max(0, Math.min(1, score));
  const band: RarityBand = score >= 0.75 ? "unique" : score >= 0.5 ? "distinctive" : score >= 0.28 ? "moderate" : "common";
  return { score: Math.round(score * 100) / 100, band, reason: reasons.join(", ") || "no distinctive features" };
}

/**
 * Evidence weight for "this handle appears on another platform", scaled by rarity.
 * A unique handle is near-hard evidence; a common one is not worth an edge at all
 * (null means: do not create the link).
 */
export function sharedHandleEvidence(handle: string): { name: string; weight: number; detail: string } | null {
  const r = handleRarity(handle);
  if (r.band === "common") return null; // refuse to link on a common handle — this is the false-positive guard
  const weight = r.band === "unique" ? 88 : r.band === "distinctive" ? 74 : 58;
  const name = r.band === "unique" ? "Rare handle reused" : "Same handle";
  return {
    name,
    weight,
    detail: `"${handle}" is ${r.band} (rarity ${r.score}${r.reason ? " · " + r.reason : ""}) — ${r.band === "unique" ? "collision by chance is very unlikely" : r.band === "distinctive" ? "unlikely to be a coincidence" : "could still be a coincidence"}.`,
  };
}
