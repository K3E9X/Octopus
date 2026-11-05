// A sourced claim.
//
// The one rule the whole product rests on: nothing is asserted without saying where it
// came from. Every fact we show about a subject carries the source that produced it and
// a weight, so a reader can tell a breach record apart from an inference, and so a
// wrong answer can be traced back to the thing that produced it rather than to "the
// tool said so".
//
// Deliberately tiny and dependency-free: it is imported by the report builder, the
// probe engine and the leak layer alike, and anything heavier here would couple them.

export interface Evidence {
  /** short name of the signal, e.g. "Account exists" */
  name: string;
  /** human-readable detail */
  detail: string;
  /** provenance: how this fact was obtained (must be verifiable) */
  source: string;
  /** signal strength 0-100 */
  weight: number;
  /** where to go and check it yourself, "verifiable" is worth more when it is one click */
  url?: string;
}
