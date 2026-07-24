// Mock correlation data for the Orbit view.
// In production these objects are produced by the ingestion pipeline
// (connectors -> normalization -> matching engine) — never invented by the LLM.

export type Status = "confirmed" | "review" | "candidate" | "rejected";

export interface Evidence {
  /** short name of the signal, e.g. "Matching avatar" */
  name: string;
  /** human-readable detail */
  detail: string;
  /** provenance: how this fact was obtained (must be verifiable) */
  source: string;
  /** signal strength 0-100 */
  weight: number;
}

/** A typed edge to another node that is NOT "the same identity" — it maps the
 *  person's WORLD (who they know, where they belong). Distinct from linkedIds,
 *  which asserts same-person. These build the relationship/network graph. */
export type RelationKind =
  | "co-commit"   // authored commits in the same repo
  | "follows"     // seed follows this account
  | "follower"    // this account follows the seed
  | "member"      // seed and node belong to the same org/group
  | "mention"     // mentioned in the seed's content
  | "co-located"; // shares a resolved location with the seed

export interface Relation {
  /** id of the node on the other end of the edge */
  to: string;
  kind: RelationKind;
  /** short human label, e.g. "follows on GitHub" */
  label: string;
  /** provenance (verifiable) */
  source: string;
}

/** Resolved geographic point for the map view. */
export interface GeoPlace {
  lat: number;
  lon: number;
  /** reverse-geocoded human label, e.g. "Paris, Île-de-France, France" */
  label?: string;
}

export interface Signal {
  id: string;
  /** platform / source label, uppercase */
  platform: string;
  /** the handle / identifier found */
  handle: string;
  /** 2-3 letter monochrome disc tag */
  disc: string;
  /** aggregated match confidence 0-100 (from the matching engine, not the LLM) */
  confidence: number;
  status: Status;
  evidence: Evidence[];
  /** ids of other signals this account is linked to (declared/verified cross-links) */
  linkedIds?: string[];
  /** typed edges to other people/orgs — the relationship graph (see RelationKind) */
  relations?: Relation[];
  /** node type for styling: platform / email / alias / phone / location / leak / person / org / domain */
  kind?: "platform" | "email" | "alias" | "phone" | "person" | "location" | "leak" | "org" | "domain";
  /** public URL of the profile/source, when known (used by "open") */
  url?: string;
  /** real/display name from the profile, when known (used by the dossier) */
  displayName?: string;
  /** qualitative correlation tier (honest headline; confidence is secondary) */
  tier?: "verified" | "probable" | "possible" | "weak" | "contradicted";
  /** entity-resolution cluster this node belongs to (accounts of one identity) */
  clusterId?: string;
  clusterTier?: "verified" | "probable" | "possible";
  /** ISO date the account/footprint appeared (for the timeline), when known */
  createdAt?: string;
  /** chain of custody — ISO timestamp this fact was collected by Octopus */
  collectedAt?: string;
  /** resolved geo point (for location nodes) — drives the map view */
  place?: GeoPlace;
  /** public avatar URL (platform nodes) — enables reverse-image search pivots */
  avatarUrl?: string;
}

export const SEED = "j0hn_doe";

export const SIGNALS: Signal[] = [
  {
    id: "x", platform: "X / TWITTER", handle: "@j0hn_doe", disc: "X", confidence: 96, status: "confirmed", createdAt: "2013-04-11",
    linkedIds: ["gh"],
    evidence: [
      { name: "Matching avatar", detail: "Perceptual hash of the portrait — near-exact collision.", source: "pHash · computed locally", weight: 98 },
      { name: "Explicit cross-link", detail: "Bio points to github.com/j0hndoe.", source: "observed · public page", weight: 95 },
      { name: "Exact username", detail: "j0hn_doe = seed, no variation.", source: "deterministic", weight: 90 },
    ],
  },
  {
    id: "gh", platform: "GITHUB", handle: "j0hndoe", disc: "GH", confidence: 92, status: "confirmed", createdAt: "2015-09-02",
    evidence: [
      { name: "Commit email", detail: "j***@proton.me reused across 3 linked accounts.", source: "observed · git metadata", weight: 93 },
      { name: "Matching avatar", detail: "pHash 97% with the X portrait.", source: "pHash", weight: 97 },
      { name: "Cross-link", detail: "README -> X profile.", source: "observed", weight: 88 },
    ],
  },
  {
    id: "ma", platform: "MASTODON", handle: "@johndoe@infosec.exchange", disc: "MA", confidence: 81, status: "review",
    evidence: [
      { name: "Duplicated bio", detail: "Bio text copied verbatim from X.", source: "text similarity", weight: 88 },
      { name: "Near-match avatar", detail: "pHash 95%.", source: "pHash", weight: 95 },
      { name: "Activity timezone", detail: "Activity peaks consistent with UTC+1.", source: "statistical · weak signal", weight: 55 },
    ],
  },
  {
    id: "kb", platform: "KEYBASE", handle: "johndoe", disc: "KB", confidence: 88, status: "review",
    linkedIds: ["x", "gh", "rd"],
    evidence: [
      { name: "PGP key", detail: "Fingerprint tied to the known email.", source: "cryptographic", weight: 92 },
      { name: "Verified accounts", detail: "Declares and proves X, GitHub, Reddit.", source: "keybase · cryptographic proofs", weight: 90 },
      { name: "Near-match username", detail: "johndoe.", source: "deterministic", weight: 70 },
    ],
  },
  {
    id: "rd", platform: "REDDIT", handle: "u/john_doe_", disc: "RD", confidence: 74, status: "review", createdAt: "2018-06-20",
    evidence: [
      { name: "Fuzzy username", detail: "john_doe_ · distance 0.82.", source: "deterministic", weight: 72 },
      { name: "Writing style", detail: "Recurring phrasings (signal, not proof).", source: "stylometry · weak signal", weight: 60 },
    ],
  },
  {
    id: "hf", platform: "FORUM", handle: "d0e", disc: "HF", confidence: 62, status: "candidate",
    evidence: [
      { name: "PGP fragment", detail: "Last 4 bytes identical.", source: "cryptographic · partial", weight: 65 },
      { name: "Timezone", detail: "UTC+1.", source: "statistical · weak signal", weight: 55 },
    ],
  },
  {
    id: "st", platform: "STEAM", handle: "johndoe1990", disc: "ST", confidence: 58, status: "candidate",
    evidence: [
      { name: "Root + year", detail: "johndoe + 1990.", source: "deterministic", weight: 60 },
      { name: "Age consistency", detail: "1990 aligned with other profiles.", source: "weak correlation", weight: 50 },
    ],
  },
  {
    id: "tg", platform: "TELEGRAM", handle: "@jd_1990", disc: "TG", confidence: 46, status: "candidate",
    evidence: [
      { name: "Partial phone", detail: "+33 6 ** ** *1 90.", source: "observed · partial", weight: 48 },
      { name: "Initials + year", detail: "jd + 1990.", source: "speculative", weight: 40 },
    ],
  },
  {
    id: "ig", platform: "INSTAGRAM", handle: "john.doe.real", disc: "IG", confidence: 21, status: "rejected",
    evidence: [
      { name: "Divergent avatar", detail: "pHash 21% — different face.", source: "pHash · contradiction", weight: 21 },
      { name: "Inconsistent geo", detail: "Profile based in Texas.", source: "observed · contradiction", weight: 15 },
    ],
  },
  {
    id: "em", platform: "EMAIL", handle: "j***@proton.me", disc: "EM", kind: "email", confidence: 70, status: "review",
    linkedIds: ["gh", "x"],
    evidence: [
      { name: "Email discovered", detail: "Extracted from GitHub commit metadata and the X bio.", source: "entity extraction · from collected bios", weight: 72 },
    ],
  },
  {
    id: "al", platform: "ALIAS", handle: "@johndoe_dev", disc: "AL", kind: "alias", confidence: 58, status: "candidate",
    linkedIds: ["gh"],
    evidence: [
      { name: "Alias discovered", detail: "Mentioned in the GitHub bio — pivot to expand.", source: "entity extraction · from collected bios", weight: 60 },
    ],
  },
];

export const BANDS: Record<Status, { r0: number; r1: number; label: string }> = {
  confirmed: { r0: 0.16, r1: 0.27, label: "CONFIRMED" },
  review: { r0: 0.32, r1: 0.47, label: "TO REVIEW" },
  candidate: { r0: 0.52, r1: 0.70, label: "CANDIDATE" },
  rejected: { r0: 0.86, r1: 0.98, label: "COLD ORBIT" },
};

export const BAND_ORDER: Status[] = ["confirmed", "review", "candidate", "rejected"];
