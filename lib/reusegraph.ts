// The reuse graph: who shares what with whom.
//
// The links exist on the nodes already, but reading them one inspector panel at a time
// means an analyst can never see the SHAPE — that six accounts hang off one password,
// or that two clusters touch at a single identity. That shape is the finding.
//
// Pure and synchronous: it takes the exposure from every leak node on the board and
// returns clusters, so the view is a rendering job rather than a second engine.

import { reuseLinks, pairsFrom, reuseStrength, type ReuseLink } from "./reuse";
import type { ExposureItem } from "./exposure";

export interface ReuseNode {
  id: string;
  /** how many distinct secrets this identity was observed with */
  secrets: number;
  /** how many other identities it is tied to */
  degree: number;
}

export interface ReuseCluster {
  id: string;
  members: ReuseNode[];
  links: ReuseLink[];
  /** the strongest link holding it together — what the cluster rests on */
  anchor: ReuseLink;
  /** exact links only, or does it depend on inferred habits */
  quality: "observed" | "inferred" | "mixed";
}

export interface ReuseGraph {
  clusters: ReuseCluster[];
  /** identities seen with a secret but tied to nobody — context, not noise */
  isolated: ReuseNode[];
  /** links the guard refused, and why. Reported, never silently dropped. */
  refused: { secret: string; ids: string[]; reason: string }[];
}

export function buildReuseGraph(items: ExposureItem[]): ReuseGraph {
  const links = reuseLinks(items);
  const pairs = pairsFrom(items);

  const secretsOf = new Map<string, Set<string>>();
  for (const p of pairs) {
    const k = p.id.toLowerCase();
    const set = secretsOf.get(k) || new Set<string>();
    set.add(p.secret);
    secretsOf.set(k, set);
  }

  // union-find over the links: a cluster is a connected component
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = parent.get(x)!;
    while (r !== parent.get(r)) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (const l of links) union(l.a.toLowerCase(), l.b.toLowerCase());

  const degree = new Map<string, Set<string>>();
  for (const l of links) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]] as [string, string][]) {
      const set = degree.get(x.toLowerCase()) || new Set<string>();
      set.add(y.toLowerCase());
      degree.set(x.toLowerCase(), set);
    }
  }

  const byRoot = new Map<string, { ids: Set<string>; links: ReuseLink[] }>();
  for (const l of links) {
    const r = find(l.a.toLowerCase());
    const c = byRoot.get(r) || { ids: new Set<string>(), links: [] };
    c.ids.add(l.a);
    c.ids.add(l.b);
    c.links.push(l);
    byRoot.set(r, c);
  }

  const node = (id: string): ReuseNode => ({
    id,
    secrets: secretsOf.get(id.toLowerCase())?.size || 0,
    degree: degree.get(id.toLowerCase())?.size || 0,
  });

  const clusters: ReuseCluster[] = [...byRoot.entries()].map(([root, c]) => {
    const sorted = [...c.links].sort((a, b) => b.strength - a.strength);
    const modes = new Set(sorted.map((l) => l.mode || "exact"));
    return {
      id: "reuse:" + root,
      members: [...c.ids].map(node).sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)),
      links: sorted,
      anchor: sorted[0],
      quality: (modes.size > 1 ? "mixed" : modes.has("pattern") ? "inferred" : "observed") as ReuseCluster["quality"],
    };
  }).sort((a, b) => b.members.length - a.members.length || b.anchor.strength - a.anchor.strength);

  // What the guard threw out. An analyst who cannot see the refusals cannot tell an
  // empty graph from a graph whose every link was disqualified — very different states.
  const bySecret = new Map<string, Set<string>>();
  for (const p of pairs) {
    const set = bySecret.get(p.secret) || new Set<string>();
    set.add(p.id);
    bySecret.set(p.secret, set);
  }
  const refused: ReuseGraph["refused"] = [];
  for (const [secret, ids] of bySecret) {
    if (ids.size < 2) continue;
    const v = reuseStrength(secret);
    if (!v.linkable) refused.push({ secret, ids: [...ids], reason: v.reason });
  }

  // "Refused" and "shares nothing" are opposite findings, and an identity listed under
  // both reads as a contradiction. An identity whose only collision was disqualified
  // belongs in the refusals, not here.
  const accountedFor = new Set([
    ...clusters.flatMap((c) => c.members.map((m) => m.id.toLowerCase())),
    ...refused.flatMap((r) => r.ids.map((id) => id.toLowerCase())),
  ]);
  const isolated = [...secretsOf.keys()].filter((id) => !accountedFor.has(id)).map(node);

  return { clusters, isolated, refused };
}
