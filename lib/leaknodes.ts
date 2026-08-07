// Exposure → graph.
//
// Everything downstream of a scan works on Signals: the entity resolver clusters them,
// the timeline dates them, the map places them, `chainFromNode` walks them. Exposure
// items were none of those things — they were fields on one node — so an address
// recovered from a combolist was invisible to every one of those stages.
//
// This promotes the usable selectors out of exposure into real nodes hanging off the
// leak that produced them, and applies the reuse guard so a shared password links two
// identities only when the secret is improbable enough to mean anything.

import { normId } from "./extract";
import type { Signal } from "./signals";
import { leadsFrom, type Lead } from "./leads";
import { reuseLinks, reuseEvidence, reuseRejections } from "./reuse";
import type { ExposureItem } from "./exposure";

/**
 * Promote leads into nodes attached to their leak. Confidence is deliberately modest:
 * an address found in a dump alongside the seed is a strong LEAD and a weak CLAIM, and
 * the graph has to say which. Nothing here asserts same-person on its own — that is the
 * resolver's job, and the reuse links below are what feed it.
 */
export function nodesFromExposure(
  leakId: string,
  items: ExposureItem[],
  seed: string,
  known: Iterable<string> = [],
  collectedAt?: string,
): { nodes: Signal[]; leads: Lead[] } {
  const leads = leadsFrom(items, seed, known);
  const nodes: Signal[] = [];

  for (const l of leads) {
    if (l.kind === "email") {
      nodes.push({
        id: "lk:mail:" + normId(l.value),
        platform: "EMAIL", handle: l.value, disc: "EM", kind: "email",
        confidence: 60, tier: "possible", status: "review",
        linkedIds: [leakId], collectedAt,
        evidence: [{
          name: "Address recovered from breach data",
          detail: `${l.value} — ${l.why}. It appears alongside the seed in a dump; that it belongs to the same person is a lead, not an established link.`,
          source: l.source || "breach data", weight: 62,
        }],
      });
    } else if (l.kind === "username") {
      nodes.push({
        id: "lk:alias:" + normId(l.value),
        platform: "ALIAS", handle: l.value, disc: "AL", kind: "alias",
        confidence: 52, tier: "possible", status: "candidate",
        linkedIds: [leakId], collectedAt,
        evidence: [{
          name: "Login recovered from breach data",
          detail: `${l.value} — ${l.why}. Pivot it to find where else this handle exists.`,
          source: l.source || "breach data", weight: 55,
        }],
      });
    } else if (l.kind === "domain") {
      nodes.push({
        id: "lk:dom:" + normId(l.value),
        platform: "DOMAIN", handle: l.value, disc: "DN", kind: "domain",
        confidence: 45, tier: "weak", status: "candidate",
        linkedIds: [leakId], collectedAt,
        evidence: [{
          name: "Domain seen in breach data",
          detail: `${l.value} — ${l.why}.`,
          source: l.source || "breach data", weight: 45,
        }],
      });
    } else if (l.kind === "ip") {
      nodes.push({
        id: "lk:ip:" + normId(l.value),
        platform: "IP", handle: l.value, disc: "IP", kind: "location",
        confidence: 42, tier: "weak", status: "candidate",
        linkedIds: [leakId], collectedAt,
        evidence: [{
          name: "Address seen in breach data",
          detail: `${l.value} — ${l.why}. Registries answer about it; the address itself is never contacted.`,
          source: l.source || "breach data", weight: 42,
        }],
      });
    }
  }

  return { nodes, leads };
}

/**
 * Apply credential reuse. A qualifying shared secret links the two identity nodes and
 * puts the finding on both; a disqualified one is REPORTED as refused rather than
 * dropped, because an analyst reading two accounts with the same password will draw the
 * conclusion themselves unless the tool is the thing that says "not this time".
 */
export function applyReuse(signals: Signal[], items: ExposureItem[], leakId: string): number {
  const byHandle = new Map<string, Signal>();
  for (const s of signals) byHandle.set(normId(s.handle), s);

  let linked = 0;
  for (const link of reuseLinks(items)) {
    const a = byHandle.get(normId(link.a));
    const b = byHandle.get(normId(link.b));
    if (!a || !b || a.id === b.id) continue;
    a.linkedIds = [...new Set([...(a.linkedIds || []), b.id])];
    b.linkedIds = [...new Set([...(b.linkedIds || []), a.id])];
    const ev = reuseEvidence(link);
    a.evidence.push(ev);
    b.evidence.push(ev);
    linked++;
  }

  const leak = signals.find((s) => s.id === leakId);
  if (leak) leak.evidence.push(...reuseRejections(items));
  return linked;
}
