// Manual intake → correlation. When an analyst finds something Octopus can't reach
// automatically (an Instagram / Facebook / LinkedIn account, a fact from a paywalled
// source), they capture it here — and it flows through the SAME correlation machinery
// as automated collection: it links to existing nodes by handle / name / email, its
// pasted bio is mined for identifiers, its avatar is hashed and geo is resolved
// (async, in the route). The manual node is a first-class citizen of the graph, not a
// sticky note — with chain of custody attached.

import { extractFromText } from "./extract";
import { sharedHandleEvidence } from "./rarity";
import type { Signal, Evidence } from "./signals";

export interface ManualInput {
  platform: string;
  handle: string;
  url?: string;
  displayName?: string;
  bio?: string;
  location?: string;
  email?: string;
  avatar?: string;
  note?: string;
  screenshot?: string;
  via?: string;
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const stripHandle = (s: string) => s.replace(/^@/, "").replace(/^u\//, "");

/** Build the manual node, with chain-of-custody evidence. Pure. */
export function buildManualSignal(input: ManualInput, collectedAt: string, seed?: string): Signal {
  const platform = input.platform.trim();
  const handle = input.handle.trim();
  const via = (input.via || "").trim() || "manual research";
  const evidence: Evidence[] = [{
    name: "Analyst-captured",
    detail: `${handle} on ${platform} — found via ${via} and attested by the analyst${input.note?.trim() ? " — " + input.note.trim() : ""} (to confirm).`,
    source: `manual capture · ${collectedAt.slice(0, 16).replace("T", " ")} UTC` + (input.url?.trim() ? ` · ${input.url.trim()}` : ""),
    weight: 60,
  }];
  if (input.screenshot?.trim()) {
    evidence.push({ name: "Evidence snapshot", detail: "Screenshot archived by the analyst.", source: input.screenshot.trim(), weight: 58 });
  }
  if (input.displayName?.trim()) evidence.push({ name: "Public name", detail: input.displayName.trim(), source: `${platform} · analyst`, weight: 55 });
  if (input.bio?.trim()) evidence.push({ name: "Public bio", detail: input.bio.trim().slice(0, 160), source: `${platform} · analyst`, weight: 44 });
  const seedN = norm(seed || "");
  if (seedN && seedN === norm(stripHandle(handle))) {
    evidence.push({ name: "Matches the seed", detail: "Handle equals the seed.", source: "correlation", weight: 78 });
  }
  return {
    id: "manual:" + norm(stripHandle(handle) + platform),
    platform: platform.toUpperCase(),
    handle,
    disc: (platform.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "MN").toUpperCase(),
    kind: "platform",
    confidence: 55,
    tier: "possible",
    status: "review",
    url: input.url?.trim() || undefined,
    displayName: input.displayName?.trim() || undefined,
    avatarUrl: input.avatar?.trim() || undefined,
    collectedAt,
    evidence,
  };
}

export interface ManualCorrelation {
  /** id-pairs to link on the board (manual node ↔ existing / new node) */
  links: [string, string][];
  /** evidence to append to the manual node (correlation findings) */
  addEvidence: Evidence[];
  /** new attribute nodes discovered from the input (email / alias / location) */
  extracted: Signal[];
  /** how many existing nodes this input correlated with */
  matched: number;
}

/**
 * Correlate the manual node against everything already on the board — deterministic,
 * sourced, no guessing. Same signals the automated engine uses: shared handle, shared
 * public name, shared/derived email, aliases mined from the pasted bio.
 */
export function correlateManual(manual: Signal, input: ManualInput, existing: Signal[]): ManualCorrelation {
  const links: [string, string][] = [];
  const addEvidence: Evidence[] = [];
  const extracted: Signal[] = [];
  const linked = new Set<string>();
  const link = (id: string) => { if (id !== manual.id && !linked.has(id)) { linked.add(id); links.push([manual.id, id]); } };

  const hN = norm(stripHandle(manual.handle));
  const nameN = manual.displayName ? norm(manual.displayName) : "";

  for (const s of existing) {
    if (s.id === manual.id) continue;
    // 1) same handle across platforms — but ONLY when the handle is rare enough to
    // mean something. Linking on a common handle ("alex") manufactures false positives.
    if (hN && hN.length >= 3 && norm(stripHandle(s.handle)) === hN) {
      const ev = sharedHandleEvidence(manual.handle);
      if (ev) {
        link(s.id);
        addEvidence.push({ name: ev.name, detail: `${ev.detail} Also present on ${s.platform}.`, source: "cross-source correlation · handle rarity", weight: ev.weight });
      }
    }
    // 2) same public name
    else if (nameN && s.displayName && norm(s.displayName) === nameN) {
      link(s.id);
      addEvidence.push({ name: "Matching name", detail: `Public name identical to ${s.platform}.`, source: "cross-source correlation", weight: 68 });
    }
  }

  // 3) explicit email provided by the analyst → email node + link to anything using it
  const emailsFound = new Set<string>();
  if (input.email?.trim()) emailsFound.add(input.email.trim().toLowerCase());
  // 4) mine the pasted bio / note for identifiers (emails, @aliases)
  const ex = extractFromText(input.bio, input.note, input.displayName);
  ex.emails.forEach((e) => emailsFound.add(e));

  for (const email of emailsFound) {
    const eid = "attr:email:" + norm(email);
    const enode: Signal = {
      id: eid, platform: "EMAIL", handle: email, disc: "EM", kind: "email",
      confidence: 58, tier: "possible", status: "review", collectedAt: manual.collectedAt,
      evidence: [{ name: "Email (analyst)", detail: `Tied to ${manual.platform} · ${manual.handle}.`, source: "manual capture", weight: 60 }],
    };
    extracted.push(enode);
    links.push([manual.id, eid]);
    // link the email to any existing node that already references the same address
    for (const s of existing) {
      if (norm(stripHandle(s.handle)) === norm(email) || (s.kind === "email" && s.handle.toLowerCase() === email)) links.push([eid, s.id]);
    }
  }

  for (const alias of ex.aliases) {
    if (norm(alias) === hN) continue; // it's this handle
    const aid = "attr:alias:" + norm(alias);
    extracted.push({
      id: aid, platform: "ALIAS", handle: "@" + alias, disc: "AL", kind: "alias",
      confidence: 52, tier: "possible", status: "candidate", collectedAt: manual.collectedAt,
      evidence: [{ name: "Alias (analyst)", detail: `Mentioned on ${manual.platform} · ${manual.handle} — pivot to expand.`, source: "manual capture", weight: 55 }],
    });
    links.push([manual.id, aid]);
  }

  return { links, addEvidence, extracted, matched: linked.size };
}
