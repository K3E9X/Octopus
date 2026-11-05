// What holds an identity together, and what happens if one fact is wrong.
//
// The orbit used to be a picture of the exposure: the subject in the middle, a ring of
// breaches around them, a dot for every field. It was decoration, and it told you
// nothing the other views did not already say better, worse, past about ten breaches
// the ring ran out of circumference and the whole thing collapsed into a smear.
//
// THE QUESTION IT CAN ANSWER THAT NOTHING ELSE CAN is structural. Every other view
// reads the facts; only this one reads how they are JOINED. Two breaches belong to the
// same person because some value appears in both, and that means the claim "these five
// databases are all about one person" is a graph, with load-bearing edges in it.
//
// Three things fall out of that, and all three are answers an analyst actually needs:
//
//   THE SPINE. The value that ties the most databases together is the one the whole
//   identity rests on, and it is also the best thing to pivot on.
//
//   FRAGMENTS. If the graph is not connected, the report is not one person, it is two
//   or more clusters that happen to share a selector, which is exactly the failure this
//   product claims to prevent. A breach alone in its own fragment is corroborated by
//   nothing, however many fields it leaked.
//
//   LOAD-BEARING FACTS. A value whose removal BREAKS the graph into more pieces is one
//   the conclusion depends on. If a shared address turns out to be a block of flats, or
//   a shared handle turns out to be a common word, the identity splits, and the
//   operator should be told which facts carry that weight before they act on the
//   report, not after.
//
// That last one is why this module exists rather than a prettier ring: the view can now
// be asked a counterfactual. Pull a thread, and it recomputes without it.
//
// All of it is pure and lives here rather than in the component, because "the identity
// splits if you remove this" is a claim, and claims in this product get tests.

export interface OrbitSource {
  name: string;
  severity: "critical" | "high" | "medium" | "low";
  date?: string;
  findings: { category: string; value: string; label: string; severity: string }[];
}

/** A value that appears in more than one database, the only thing that joins them. */
export interface Thread {
  /** stable id: category and the normalised value */
  id: string;
  value: string;
  category: string;
  /** the databases carrying it, sorted, always two or more */
  databases: string[];
  /** does removing this value break the graph into more pieces? */
  loadBearing: boolean;
}

export interface OrbitNode {
  name: string;
  severity: OrbitSource["severity"];
  date?: string;
  /** distinct values attributed to the subject in this database */
  weight: number;
  /** which fragment it belongs to, after the current threads are applied */
  component: number;
}

export interface OrbitEdge {
  a: string;
  b: string;
  /** the thread ids joining them */
  threads: string[];
  /** the worst category among those threads, for the edge's colour */
  category: string;
}

export interface OrbitGraph {
  nodes: OrbitNode[];
  edges: OrbitEdge[];
  threads: Thread[];
  /** fragments: each a list of database names */
  components: string[][];
  /** databases joined to nothing at all */
  isolated: string[];
}

/** Worst first, an edge carrying a password is not the same as one carrying a city. */
const CAT_RANK: Record<string, number> = {
  password: 0, financial: 1, document: 2, identity: 3,
  email: 4, phone: 5, location: 6, online: 7, professional: 8, other: 9,
};
const worst = (a: string, b: string) => ((CAT_RANK[a] ?? 9) <= (CAT_RANK[b] ?? 9) ? a : b);

/**
 * Which values are worth drawing a line for.
 *
 * NOT every shared value. A severity word, a country, a "yes", values that recur
 * because they are common, not because they are the same person, would join every
 * database to every other and make the graph a solid block that says nothing. A thread
 * has to be something that could identify somebody: long enough to be specific, and in
 * a category that carries identity rather than describing it.
 */
const JOINING = new Set(["email", "phone", "identity", "location", "online", "password", "document", "financial", "professional"]);
const MIN_LEN = 4;

function threadable(category: string, value: string): boolean {
  if (!JOINING.has(category)) return false;
  const v = value.trim();
  if (v.length < MIN_LEN) return false;
  // a masked value is not a value: "a***@b.com" matches every address at that domain
  if (/\*{2,}/.test(v)) return false;
  return true;
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/** Union-find, because "is this one person or three" is exactly a connectivity question. */
function componentsOf(names: string[], edges: { a: string; b: string }[]): string[][] {
  const parent = new Map(names.map((n) => [n, n]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const r = find(n);
    (groups.get(r) || groups.set(r, []).get(r)!).push(n);
  }
  // biggest fragment first, then alphabetically, so the order is stable across renders
  return [...groups.values()].sort((x, y) => y.length - x.length || x[0].localeCompare(y[0]));
}

/** The edges implied by a set of threads. */
function edgesFrom(threads: Thread[]): OrbitEdge[] {
  const by = new Map<string, OrbitEdge>();
  for (const t of threads) {
    for (let i = 0; i < t.databases.length; i++) {
      for (let j = i + 1; j < t.databases.length; j++) {
        const [a, b] = [t.databases[i], t.databases[j]].sort();
        const k = a + "¬" + b;
        const e = by.get(k);
        if (e) { e.threads.push(t.id); e.category = worst(e.category, t.category); }
        else by.set(k, { a, b, threads: [t.id], category: t.category });
      }
    }
  }
  return [...by.values()];
}

/**
 * The graph, with every thread in place.
 *
 * `dropped` lets the caller ask the counterfactual: give it a thread id and the graph
 * comes back as if that value had never been shared, which is what "pull a thread"
 * does, and what decides whether a thread is load-bearing.
 */
export function buildGraph(sources: OrbitSource[], dropped: string[] = []): OrbitGraph {
  const srcs = sources.filter((s) => s.findings.length > 0);
  const names = srcs.map((s) => s.name);

  const homes = new Map<string, { value: string; category: string; dbs: Set<string> }>();
  for (const s of srcs) {
    for (const f of s.findings) {
      if (!threadable(f.category, f.value)) continue;
      const id = f.category + "|" + norm(f.value);
      const h = homes.get(id) || { value: f.value, category: f.category, dbs: new Set<string>() };
      h.dbs.add(s.name);
      homes.set(id, h);
    }
  }

  const drop = new Set(dropped);
  const all: Thread[] = [...homes.entries()]
    .filter(([, h]) => h.dbs.size > 1)
    .map(([id, h]) => ({ id, value: h.value, category: h.category, databases: [...h.dbs].sort(), loadBearing: false }))
    // most-connecting first: the spine is simply the head of this list
    .sort((a, b) => b.databases.length - a.databases.length || CAT_RANK[a.category] - CAT_RANK[b.category] || a.value.localeCompare(b.value));

  const live = all.filter((t) => !drop.has(t.id));
  const edges = edgesFrom(live);
  const components = componentsOf(names, edges);

  // A thread is load-bearing if taking it out leaves more fragments than before. Worked
  // out by actually removing it, rather than by a rule about what looks important, // a bridge is a property of the graph, not of the value's category.
  for (const t of live) {
    const without = componentsOf(names, edgesFrom(live.filter((x) => x.id !== t.id)));
    t.loadBearing = without.length > components.length;
  }

  const joined = new Set(edges.flatMap((e) => [e.a, e.b]));
  const compOf = new Map<string, number>();
  components.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));

  return {
    nodes: srcs.map((s) => ({
      name: s.name,
      severity: s.severity,
      date: s.date,
      weight: new Set(s.findings.map((f) => norm(f.value))).size,
      component: compOf.get(s.name) ?? 0,
    })),
    edges,
    threads: live,
    components,
    isolated: names.filter((n) => !joined.has(n)),
  };
}

/** What pulling one thread would do, without committing to it. */
export function pullThread(sources: OrbitSource[], threadId: string): {
  before: number; after: number; isolates: string[];
} {
  const before = buildGraph(sources);
  const after = buildGraph(sources, [threadId]);
  return {
    before: before.components.length,
    after: after.components.length,
    isolates: after.isolated.filter((n) => !before.isolated.includes(n)),
  };
}

/** One line a reader can take away without touching anything. */
export function describeGraph(g: OrbitGraph): string {
  if (!g.nodes.length) return "Nothing to connect.";
  if (g.nodes.length === 1) return "One database. Nothing corroborates it.";
  const bearing = g.threads.filter((t) => t.loadBearing).length;
  const parts: string[] = [];
  if (g.components.length === 1) parts.push(`All ${g.nodes.length} databases are connected`);
  else parts.push(`${g.components.length} fragments, not one person yet`);
  if (g.isolated.length) parts.push(`${g.isolated.length} joined to nothing`);
  if (bearing) parts.push(`${bearing} fact${bearing === 1 ? "" : "s"} load-bearing`);
  return parts.join(" · ") + ".";
}

// ---- where the nodes go -------------------------------------------------------------
//
// The old layout put every breach on one ellipse at equal angles, with the radius capped
// at 200px. Twelve breaches fit. Twenty do not, and the report the user was looking at
// had enough that the circles overlapped their own labels, the ring simply ran out of
// circumference and nobody had checked what happened next.
//
// A ring is the wrong shape anyway once the graph means something. Connected databases
// should sit NEAR each other and fragments should sit apart, because that is the thing
// the view is now for; a ring puts two unrelated breaches side by side and draws a line
// across the middle between two that belong together.
//
// So: a small force relaxation, connected nodes pull together, every pair pushes apart,
// a weak pull to the centre keeps it on the canvas, followed by a collision pass that
// is not a force but a hard constraint. Forces get you a good arrangement; they do not
// get you a guarantee. The separation pass does, and it is the part under test.

export interface Placed { name: string; x: number; y: number; r: number }

const SEED = 1013904223;

/**
 * Deterministic pseudo-random, because a layout that moves every time you switch tabs
 * is a layout the reader has to re-learn every time. Math.random() would also make the
 * "no two nodes overlap" test pass or fail by luck.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export interface LayoutOpts { width: number; height: number; iterations?: number; pad?: number }

export function layoutGraph(g: OrbitGraph, opts: LayoutOpts): Placed[] {
  const { width: W, height: H } = opts;
  const pad = opts.pad ?? 14;
  const n = g.nodes.length;
  if (!n) return [];

  const rand = rng(SEED + n);
  const radiusOf = (w: number) => Math.max(13, Math.min(34, 11 + Math.sqrt(w) * 5.2));

  // Start on a circle rather than at random: a relaxation from a sane arrangement
  // converges in far fewer passes, and it keeps the result recognisable between reports.
  const R0 = Math.min(W, H) * 0.33;
  const p: Placed[] = g.nodes.map((nd, i) => {
    const a = (i / n) * Math.PI * 2;
    return {
      name: nd.name,
      x: W / 2 + Math.cos(a) * R0 + (rand() - 0.5) * 8,
      y: H / 2 + Math.sin(a) * R0 * 0.8 + (rand() - 0.5) * 8,
      r: radiusOf(nd.weight),
    };
  });
  const at = new Map(p.map((q) => [q.name, q]));

  const iters = opts.iterations ?? 260;
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;

    // springs: a shared value pulls two databases together, and more shared values pull
    // harder, the distance between two nodes ends up meaning something
    for (const e of g.edges) {
      const a = at.get(e.a), b = at.get(e.b);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const rest = a.r + b.r + 56 - Math.min(26, e.threads.length * 9);
      const f = ((d - rest) / d) * 0.045 * cool;
      a.x += dx * f; a.y += dy * f;
      b.x -= dx * f; b.y -= dy * f;
    }

    // repulsion, every pair. n is the number of breaches one person appears in, tens,
    // not thousands, so the quadratic pass is cheaper than a quadtree would be.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = p[i], b = p[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const want = a.r + b.r + pad + 34;
        if (d2 > want * want) continue;
        const d = Math.sqrt(d2);
        const f = ((want - d) / d) * 0.5 * cool;
        a.x -= dx * f; a.y -= dy * f;
        b.x += dx * f; b.y += dy * f;
      }
    }

    // a weak pull home, so a fragment joined to nothing does not drift off the canvas
    for (const q of p) {
      q.x += (W / 2 - q.x) * 0.012 * cool;
      q.y += (H / 2 - q.y) * 0.012 * cool;
    }
  }

  // THE GUARANTEE. Forces produce a good arrangement; they do not promise one. This
  // pass is a hard constraint, repeated until it has nothing left to do, which is what
  // the test asserts, rather than asserting that the forces were tuned nicely.
  for (let pass = 0; pass < 220; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = p[i], b = p[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const want = a.r + b.r + pad;
        if (d >= want) continue;
        if (d < 0.01) { dx = (i % 2 ? 1 : -1) * 0.7; dy = 0.7; d = 1; }
        const push = (want - d) / d / 2;
        a.x -= dx * push; a.y -= dy * push;
        b.x += dx * push; b.y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // and finally inside the frame, label room included
  for (const q of p) {
    q.x = Math.max(q.r + 10, Math.min(W - q.r - 10, q.x));
    q.y = Math.max(q.r + 14, Math.min(H - q.r - 26, q.y));
  }
  return p;
}

// ---- drawing a hypergraph without drawing a hairball --------------------------------
//
// One value shared by twenty-two databases is not two hundred and thirty-one facts. It
// is ONE fact. Drawing it as pairwise edges says the opposite, a complete graph, every
// database tied to every other, and a complete graph on twenty-two nodes is an
// unreadable mat of lines whichever way you lay it out. There is no layout that fixes
// it, because the picture is wrong before the layout runs.
//
// So the value gets to be a node. Databases are circles, threads are hubs, and a line
// means "this database carried this value". Twenty-two lines instead of two hundred and
// thirty-one, and the shape now says the true thing: these databases are joined BY
// SOMETHING, and you can see what, and how many others are holding the same one.
//
// The pairwise edges stay in the model, connectivity, fragments and load-bearing are
// questions about the real graph and are computed on it. This is how it is DRAWN.

/** Grow the arrangement about its own centre until it uses the canvas. Never shrinks. */
function fit(all: Placed[], W: number, H: number, margin: number): void {
  if (all.length < 2) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of all) {
    x0 = Math.min(x0, q.x - q.r); x1 = Math.max(x1, q.x + q.r);
    y0 = Math.min(y0, q.y - q.r); y1 = Math.max(y1, q.y + q.r);
  }
  const w = x1 - x0, h = y1 - y0;
  if (w < 1 || h < 1) return;
  const k = Math.min((W - margin * 2) / w, (H - margin * 2) / h);
  if (k <= 1.001) return;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const q of all) {
    q.x = W / 2 + (q.x - cx) * k;
    q.y = H / 2 + (q.y - cy) * k;
  }
}

export interface Bipartite { dbs: Placed[]; hubs: (Placed & { id: string })[] }

export function layoutBipartite(g: OrbitGraph, opts: LayoutOpts): Bipartite {
  const { width: W, height: H } = opts;
  const pad = opts.pad ?? 12;
  const rand = rng(SEED + g.nodes.length * 7 + g.threads.length);

  const dbR = (w: number) => Math.max(13, Math.min(32, 11 + Math.sqrt(w) * 5));
  const hubR = (n: number) => Math.max(6, Math.min(15, 4 + n * 0.9));

  // Hubs start in the middle and databases on a ring around them: that is roughly the
  // answer already, so the relaxation only has to separate things rather than discover
  // the shape.
  const hubs = g.threads.map((t, i) => {
    const a = (i / Math.max(1, g.threads.length)) * Math.PI * 2;
    return {
      id: t.id, name: t.value,
      x: W / 2 + Math.cos(a) * 70 + (rand() - 0.5) * 6,
      y: H / 2 + Math.sin(a) * 50 + (rand() - 0.5) * 6,
      r: hubR(t.databases.length),
    };
  });
  const R0 = Math.min(W, H) * 0.36;
  const dbs = g.nodes.map((nd, i) => {
    const a = (i / Math.max(1, g.nodes.length)) * Math.PI * 2 - Math.PI / 2;
    return {
      name: nd.name,
      x: W / 2 + Math.cos(a) * R0 * 1.25 + (rand() - 0.5) * 6,
      y: H / 2 + Math.sin(a) * R0 * 0.92 + (rand() - 0.5) * 6,
      r: dbR(nd.weight),
    };
  });

  const all: Placed[] = [...dbs, ...hubs];
  const byName = new Map(dbs.map((d) => [d.name, d]));
  const byId = new Map(hubs.map((h) => [h.id, h]));
  const links = g.threads.flatMap((t) =>
    t.databases.map((d) => ({ h: byId.get(t.id)!, d: byName.get(d) })).filter((l) => l.d),
  ) as { h: Placed; d: Placed }[];

  const iters = opts.iterations ?? 300;
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    for (const l of links) {
      const dx = l.d.x - l.h.x, dy = l.d.y - l.h.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const rest = l.h.r + l.d.r + 74;
      const f = ((dist - rest) / dist) * 0.05 * cool;
      // the hub moves less than the database: a hub shared by twenty is an anchor, not
      // something the twenty drag around
      l.h.x += dx * f * 0.35; l.h.y += dy * f * 0.35;
      l.d.x -= dx * f; l.d.y -= dy * f;
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const want = a.r + b.r + pad + 30;
        if (d2 > want * want) continue;
        const d = Math.sqrt(d2);
        const f = ((want - d) / d) * 0.48 * cool;
        a.x -= dx * f; a.y -= dy * f;
        b.x += dx * f; b.y += dy * f;
      }
    }
    for (const q of all) {
      q.x += (W / 2 - q.x) * 0.01 * cool;
      q.y += (H / 2 - q.y) * 0.01 * cool;
    }
  }

  // the same hard constraint as the other layout, over both kinds at once
  for (let pass = 0; pass < 260; pass++) {
    let moved = false;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const want = a.r + b.r + pad;
        if (d >= want) continue;
        if (d < 0.01) { dx = (i % 2 ? 1 : -1) * 0.7; dy = 0.7; d = 1; }
        const push = (want - d) / d / 2;
        a.x -= dx * push; a.y -= dy * push;
        b.x += dx * push; b.y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // FILL THE FRAME. The relaxation settles at whatever size its rest lengths imply,
  // which for twenty-two databases hanging off one hub was a disc about a quarter of
  // the canvas with the rest of it empty, correct, and a waste of every pixel the
  // reader has. Scaling up about the centre is safe in a way scaling down is not: it
  // only ever increases the distance between two nodes, so the separation guarantee
  // survives it.
  fit(all, W, H, 26);
  for (const q of all) {
    q.x = Math.max(q.r + 10, Math.min(W - q.r - 10, q.x));
    q.y = Math.max(q.r + 14, Math.min(H - q.r - 24, q.y));
  }
  return { dbs, hubs };
}
