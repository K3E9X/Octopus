// Does this row actually concern the subject?
//
// The API searches every permutation of the words in a query, so what comes back is
// rows that matched SOMETHING, not rows that are about the person asked for. Three
// examples of what that means in practice:
//
//   A three-word name returns rows that carry only the surname, different people.
//   A phone number stored nationally does not look like the one typed internationally,
//   so the single most relevant row can fail a naive string compare.
//   A short handle appears inside longer strings it has nothing to do with.
//
// Every row therefore gets judged before it is allowed to become a fact about anyone:
//
//   DIRECT, a cell holds the subject itself. This row is about the subject.
//   PARTIAL, the row matched part of a multi-word query. It may be a different person
//              who shares a surname. It is shown, never merged.
//   NONE, nothing in the row carries the subject. Kept and counted, because the
//              operator paid for it and silently dropping paid-for rows is its own
//              kind of lie, but it is not evidence about the subject.
//
// Nothing here is heuristic scoring. A row either contains the value or it does not,
// and the answer is checkable by eye against the row that produced it.

import type { Subject } from "./subject";
import { canonicalEmail } from "./subject";

export type Attribution = "direct" | "partial" | "none";

export interface RowMatch {
  attribution: Attribution;
  /** the column whose value carried the subject, so a report can point at it */
  column?: string;
  /** the spelling the dump actually held, which is often not the one that was typed */
  matched?: string;
  /** for a multi-word subject: which words were present */
  words?: string[];
}

/**
 * Fold a value to the form both sides are compared in.
 *
 * Accents were not folded here while lib/identity DID fold them, so the two halves of
 * the pipeline disagreed: a search for "Jérôme Dupont" read a dump holding "Jerome
 * Dupont" as a DIFFERENT PERSON and reported the subject's own record under "someone
 * else matched part of this query". A dump is transliterated as often as not, and an
 * accent is a spelling, never a different human being.
 */
const COMBINING = /[\u0300-\u036f]/g;
const norm = (s: string) =>
  String(s ?? "").trim().toLowerCase().normalize("NFD").replace(COMBINING, "");
const digitsOf = (s: string) => String(s ?? "").replace(/\D/g, "");

/**
 * A value is present in a cell when the cell IS it, or contains it delimited by
 * something that is not a word character.
 *
 * The delimiter rule is what stops a three-letter handle matching inside every long
 * word in a bio. Plain substring containment would turn a precision tool into a
 * generator of plausible nonsense.
 */
export function containsValue(cell: string, value: string): boolean {
  const c = norm(cell), v = norm(value);
  if (!c || !v) return false;
  if (c === v) return true;
  if (v.length < 4) return false; // too short to be safely found inside anything
  let from = 0;
  for (;;) {
    const i = c.indexOf(v, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : c[i - 1];
    const after = i + v.length >= c.length ? "" : c[i + v.length];
    const open = !before || !/[a-z0-9]/.test(before);
    const close = !after || !/[a-z0-9]/.test(after);
    if (open && close) return true;
    from = i + 1;
  }
}

/**
 * Phone numbers compare as digits, never as text.
 *
 * Two things make this harder than it looks, and getting either wrong loses the single
 * most useful row in a result set.
 *
 * The country code may be absent: a dump holding "0612345678" and a search for
 * "+33612345678" are the same subscriber. A suffix comparison finds that, but only
 * after the NATIONAL TRUNK PREFIX is dealt with. In most of Europe the leading "0" of
 * the national form is not part of the number at all; it is replaced by the country
 * code, not appended to it. So "33612345678" does not end with "0612345678", and a
 * naive suffix test misses the match entirely. Both forms are reduced to the national
 * significant number first.
 *
 * And a tail can be a coincidence. The comparison needs at least nine significant
 * digits, which is where a shared ending stops being plausible, and the cell has to be
 * number-shaped rather than prose that happens to contain digits.
 */
function tails(d: string): string[] {
  const out = [d];
  const trimmed = d.replace(/^0+/, "");
  if (trimmed && trimmed !== d) out.push(trimmed);
  return out;
}

const MIN_SIGNIFICANT = 9;

export function samePhone(cell: string, variantDigits: string[]): string | null {
  // Dumps store a number behind a label ("Tel: 0612345678") and with separators nobody
  // anticipated ("06/12/34/56/78"). Requiring the WHOLE cell to be number-shaped threw
  // both away. Pull the digit runs out instead and test each one, a run of 7 to 17
  // digits is a candidate number wherever it sits in the cell.
  const runs = String(cell ?? "").match(/\d[\d\s().+\/.-]*\d/g) || [];
  const candidates = [digitsOf(cell), ...runs.map(digitsOf)]
    .filter((d) => d.length >= 7 && d.length <= 17);
  if (!candidates.length) return null;

  for (const c of candidates) {
    for (const v of variantDigits) {
      if (!v || v.length < 7) continue;
      for (const a of tails(c)) {
        for (const b of tails(v)) {
          if (a === b) return v;
          const short = a.length < b.length ? a : b;
          const long = a.length < b.length ? b : a;
          // A shared tail is only evidence when it is long enough AND the two are the
          // same KIND of string: at most a country code apart. Otherwise a nine-digit
          // fragment matches the end of every longer number that happens to finish the
          // same way, which is attribution by coincidence.
          if (short.length >= MIN_SIGNIFICANT && long.length - short.length <= 4 && long.endsWith(short)) return v;
        }
      }
    }
  }
  return null;
}

/**
 * Columns that carry a person's name. Nothing else can corroborate one: a street, a
 * town, an employer and a free-text note all contain names belonging to other people.
 */
const NAME_COLUMN = /full.?name|^name$|first.?name|last.?name|sur.?name|given|patronym|middle|\bfio\b|nom|prenom|display/i;

/** Judge one row. */
export function attributeRow(subject: Subject, row: Record<string, string>): RowMatch {
  const entries = Object.entries(row).filter(([, v]) => String(v ?? "").trim());

  if (subject.kind === "phone") {
    const variantDigits = subject.variants.map(digitsOf).filter((d) => d.length >= 7);
    for (const [col, raw] of entries) {
      const hit = samePhone(String(raw), variantDigits);
      if (hit) return { attribution: "direct", column: col, matched: String(raw).trim() };
    }
    return { attribution: "none" };
  }

  // email, username, free: a single value that is either there or not
  if (subject.kind !== "name") {
    // An address has to be compared in its canonical form on BOTH sides. Generating
    // spellings of the subject only works one way: searching the dotless form of a
    // gmail address would miss a dump that stored it dotted. Reducing each cell the
    // same way makes the comparison symmetric, which is the only way it is correct.
    const wantedMail = subject.kind === "email" ? canonicalEmail(subject.canonical) : null;
    for (const [col, raw] of entries) {
      const cell = String(raw);
      if (wantedMail && canonicalEmail(cell) === wantedMail) {
        return { attribution: "direct", column: col, matched: cell.trim() };
      }
      for (const v of subject.variants) {
        if (containsValue(cell, v)) {
          return { attribution: "direct", column: col, matched: cell.trim() };
        }
      }
    }
    return { attribution: "none" };
  }

  // A name. The full phrase present in one cell is direct; otherwise count how many of
  // its words appear anywhere in the row, that is a different person until proven not.
  const words = subject.canonical.split(/\s+/).filter((w) => w.length >= 2);
  for (const [col, raw] of entries) {
    if (containsValue(String(raw), subject.canonical)) {
      return { attribution: "direct", column: col, matched: String(raw).trim(), words };
    }
  }
  // WHERE the words were found decides what they mean. A row for Sophie Durand living
  // at "12 rue Alexandre Dumas" in a town called "Martin" contains both words of
  // "Alexandre Martin" and is not that person; counting any column made such a row a
  // direct hit. Only columns that carry a name can corroborate a name.
  const found = new Set<string>();
  const inNameColumn = new Set<string>();
  let column: string | undefined;
  for (const [col, raw] of entries) {
    const nameish = NAME_COLUMN.test(col);
    for (const w of words) {
      if (!containsValue(String(raw), w)) continue;
      found.add(w);
      if (nameish) { inNameColumn.add(w); column ??= col; }
      else column ??= col;
    }
  }
  if (!found.size) return { attribution: "none" };
  // Every word of the name, each one in a column that holds names, the ordinary case
  // of a dump with separate first-name and surname fields.
  const all = inNameColumn.size === words.length;
  return { attribution: all ? "direct" : "partial", column, words: [...found] };
}
