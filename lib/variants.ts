// Username variants — people rarely hold the exact same handle everywhere. If the seed
// is "john_doe", the same person is often "johndoe", "john.doe", "jdoe" or "johndoe93"
// elsewhere. Searching only the literal seed misses most of the footprint; this is the
// single biggest recall gap a username-based tool can have.
//
// Rules, deliberately conservative — every extra variant costs requests AND risks a
// false positive, so we only generate transformations a human would actually try, and
// downstream we score a variant hit strictly WEAKER than an exact match.

export interface Variant {
  handle: string;
  /** how it was derived, for the evidence trail */
  rule: string;
}

const SEPS = ["", ".", "_", "-"];

/** Split a handle into its word parts, using separators and camelCase. */
export function handleParts(handle: string): string[] {
  const h = handle.trim().replace(/^@/, "").replace(/^u\//, "");
  // strip a trailing number group first (john_doe93 → john_doe + 93)
  const core = h.replace(/\d+$/, "");
  const bySep = core.split(/[._\-]+/).filter(Boolean);
  if (bySep.length > 1) return bySep.map((p) => p.toLowerCase());
  // camelCase / PascalCase
  const byCamel = core.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/).filter(Boolean);
  if (byCamel.length > 1) return byCamel.map((p) => p.toLowerCase());
  return [core.toLowerCase()].filter(Boolean);
}

/**
 * Generate plausible variants of a handle, most-likely first, excluding the original.
 * `max` bounds the request cost.
 */
export function usernameVariants(handle: string, max = 6): Variant[] {
  const original = handle.trim().replace(/^@/, "").replace(/^u\//, "").toLowerCase();
  if (!original || original.length < 3) return [];
  const out: Variant[] = [];
  const seen = new Set<string>([original]);
  const push = (h: string, rule: string) => {
    const v = h.toLowerCase();
    if (!v || v.length < 3 || v.length > 30 || seen.has(v)) return;
    if (!/^[a-z0-9._-]+$/.test(v)) return;
    seen.add(v);
    out.push({ handle: v, rule });
  };

  const trailing = original.match(/(\d+)$/)?.[1] || "";
  const parts = handleParts(original);

  // 1) same words, different separator — by far the most common real variation
  if (parts.length > 1) {
    for (const sep of SEPS) push(parts.join(sep), sep ? `separator "${sep}"` : "no separator");
    // 2) first-initial + last (jdoe) and first + last-initial (johnd)
    push(parts[0][0] + parts[parts.length - 1], "initial + last name");
    push(parts[0] + parts[parts.length - 1][0], "first name + initial");
    // 3) reversed order (doejohn) — common on older platforms
    push([...parts].reverse().join(""), "reversed order");
  }

  // 4) drop / keep a trailing number (john_doe93 ↔ john_doe)
  if (trailing) {
    push(original.slice(0, -trailing.length).replace(/[._-]+$/, ""), "without trailing digits");
  }

  // 5) strip separators entirely from the literal handle
  if (/[._-]/.test(original)) push(original.replace(/[._-]/g, ""), "separators removed");

  return out.slice(0, max);
}
