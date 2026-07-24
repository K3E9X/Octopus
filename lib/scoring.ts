// Honest scoring — replaces magic-number confidence with an evidence-class model.
// Every piece of evidence is classified hard / soft / weak, and the node gets a
// QUALITATIVE tier that an analyst can actually trust, plus a corroboration count
// (how many independent supporting signals). The numeric confidence is derived
// transparently from the classes — it is secondary to the tier.

export type EvidenceClass = "hard" | "soft" | "weak" | "contra";
export type Tier = "verified" | "probable" | "possible" | "weak" | "contradicted";

// hard = cryptographic / cross-verified / same-image ; weak = mere existence,
// inference, or derivation ; contra = evidence AGAINST the link ; everything else =
// soft (observed but not proof).
const HARD_RE = /matching avatar|matching face|rare handle reused|declared|pgp|fingerprint|cross-link|commit email|breach|leak/i;
const WEAK_RE = /presence detected|derived|near-match|account age|timezone|writing style|generated|candidate|partial|speculative|not a valid|name query|owner lookup|sensitive source|initials|age consistency|self-reported/i;
// A real investigation must be able to say NO. These lower the tier instead of raising it.
const CONTRA_RE = /divergent|different face|contradict|inconsistent|mismatch|conflicting|incompatible|refuted|disproved/i;

export function classify(name: string): EvidenceClass {
  // contradictions win over every other class — "Divergent avatar" is not soft evidence
  if (CONTRA_RE.test(name)) return "contra";
  if (HARD_RE.test(name)) return "hard";
  if (WEAK_RE.test(name)) return "weak";
  return "soft";
}

export interface Scored {
  tier: Tier;
  confidence: number;
  corroboration: number; // independent supporting signals (hard + soft)
  /** independent signals AGAINST the link */
  contradictions: number;
}

export function scoreEvidence(evidence: { name: string }[]): Scored {
  let hard = 0, soft = 0, weak = 0, contra = 0;
  for (const e of evidence) {
    const c = classify(e.name);
    if (c === "hard") hard++;
    else if (c === "soft") soft++;
    else if (c === "contra") contra++;
    else weak++;
  }

  let tier: Tier = hard >= 1 ? "verified" : soft >= 2 ? "probable" : soft === 1 ? "possible" : "weak";

  // Contradictions demote. One contradiction costs a tier; two or more, or a
  // contradiction with nothing hard behind it, marks the link as contradicted —
  // the analyst should see the conflict, not an unqualified "probable".
  if (contra > 0) {
    if (contra >= 2 || hard === 0) tier = "contradicted";
    else tier = tier === "verified" ? "possible" : "weak";
  }

  const corroboration = hard + soft;
  let confidence = 18 + Math.min(2, hard) * 34 + Math.min(3, soft) * 12 + Math.min(3, weak) * 4;
  confidence -= Math.min(3, contra) * 22; // a contradiction is worth more than a soft signal
  confidence = Math.max(5, Math.min(97, Math.round(confidence)));
  return { tier, confidence, corroboration, contradictions: contra };
}

export const TIER_LABEL: Record<Tier, string> = {
  verified: "VERIFIED",
  probable: "PROBABLE",
  possible: "POSSIBLE",
  weak: "WEAK",
  contradicted: "CONTRADICTED",
};
