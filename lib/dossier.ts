// Dossier — the intelligence layer. Aggregates the correlated graph into a single
// "who is this person" summary: likely name, emails, phones, locations, aliases,
// accounts, leaks + an identification confidence. Pure & deterministic — it only
// consolidates verified nodes, it does not invent anything.

import type { Signal } from "./signals";
import { scoreEvidence, type Tier } from "./scoring";

export interface DossierAccount {
  platform: string;
  handle: string;
  confidence: number;
  status: string;
  tier: Tier;
  url?: string;
}

export interface Dossier {
  name?: string;
  nameAlts: string[];
  emails: string[];
  phones: string[];
  locations: string[];
  aliases: string[];
  accounts: DossierAccount[];
  leaks: { platform: string; handle: string }[];
  confirmedCount: number;
  identificationScore: number;
  /** the strongest resolved identity: how many accounts were merged into one person */
  primaryCluster: { size: number; tier: string } | null;
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

export function buildDossier(signals: Signal[]): Dossier {
  const accountsSig = signals.filter((s) => !s.kind || s.kind === "platform");
  const emails = uniq(signals.filter((s) => s.kind === "email").map((s) => s.handle));
  const phones = uniq(signals.filter((s) => s.kind === "phone").map((s) => s.handle));
  const locations = uniq(signals.filter((s) => s.kind === "location").map((s) => s.handle));
  const aliases = uniq(signals.filter((s) => s.kind === "alias").map((s) => s.handle));
  const leaks = signals.filter((s) => s.kind === "leak").map((s) => ({ platform: s.platform, handle: s.handle }));

  // likely real name: from display names, weighted by status + confidence, favoring "First Last"
  const nameScore = new Map<string, number>();
  for (const s of accountsSig) {
    const n = (s.displayName || "").trim();
    if (n && /\s/.test(n) && n.length <= 60) {
      const w = (s.status === "confirmed" ? 3 : s.status === "review" ? 2 : 1) + s.confidence / 100;
      nameScore.set(n, (nameScore.get(n) || 0) + w);
    }
  }
  const namesRanked = [...nameScore.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);

  // contradicted sorts last — a conflicted link belongs at the bottom of the dossier
  const tierRank: Record<Tier, number> = { verified: 0, probable: 1, possible: 2, weak: 3, contradicted: 4 };
  const tierOf = (s: Signal): Tier => s.tier || scoreEvidence(s.evidence).tier;
  const accounts: DossierAccount[] = accountsSig
    .filter((s) => s.status !== "rejected")
    .map((s) => ({ platform: s.platform, handle: s.handle, confidence: s.confidence, status: s.status, tier: tierOf(s), url: s.url }))
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.confidence - a.confidence);

  const confirmedCount = accountsSig.filter((s) => s.status === "confirmed").length;
  const verifiedCount = accounts.filter((a) => a.tier === "verified").length;

  // strongest resolved identity cluster (prefer verified, then size)
  const clusters = new Map<string, { size: number; tier: string }>();
  const cRank: Record<string, number> = { verified: 0, probable: 1, possible: 2 };
  for (const s of accountsSig) {
    if (!s.clusterId) continue;
    const cur = clusters.get(s.clusterId);
    if (cur) cur.size++;
    else clusters.set(s.clusterId, { size: 1, tier: s.clusterTier || "possible" });
  }
  let primaryCluster: { size: number; tier: string } | null = null;
  for (const c of clusters.values()) {
    if (c.size < 2) continue;
    if (!primaryCluster || cRank[c.tier] < cRank[primaryCluster.tier] || (c.tier === primaryCluster.tier && c.size > primaryCluster.size)) {
      primaryCluster = c;
    }
  }

  // identification score: driven by the resolved cluster + corroborating attributes
  let score = 0;
  if (namesRanked.length) score += 20;
  if (emails.length) score += 18;
  if (phones.length) score += 12;
  if (locations.length) score += 12;
  if (primaryCluster) score += primaryCluster.tier === "verified" ? 34 : primaryCluster.tier === "probable" ? 20 : 10;
  score += Math.min(14, verifiedCount * 8 + confirmedCount * 5);
  score = Math.min(99, score);

  return {
    name: namesRanked[0],
    nameAlts: namesRanked.slice(1, 3),
    emails, phones, locations, aliases, accounts, leaks,
    confirmedCount,
    identificationScore: score,
    primaryCluster,
  };
}
