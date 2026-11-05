import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, pullThread, describeGraph, layoutGraph, layoutBipartite, type OrbitSource } from "../lib/orbit.ts";

const f = (category: string, value: string, severity = "medium") => ({ category, value, label: category, severity });
const src = (name: string, findings: ReturnType<typeof f>[], severity: OrbitSource["severity"] = "medium"): OrbitSource =>
  ({ name, severity, findings });

// A chain: A—B share an email, B—C share a phone. Nothing joins A to C directly, so the
// whole claim that these are one person rests on B.
const CHAIN = [
  src("A", [f("email", "lena@example.com"), f("identity", "Lena Marchetti")]),
  src("B", [f("email", "lena@example.com"), f("phone", "+33639984102")]),
  src("C", [f("phone", "+33639984102"), f("location", "Lyon 7e")]),
];

test("two databases sharing a value are joined; sharing nothing, they are not", () => {
  const g = buildGraph([
    src("A", [f("email", "lena@example.com")]),
    src("B", [f("email", "lena@example.com")]),
    src("C", [f("email", "someone@example.com")]),
  ]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.isolated, ["C"]);
  assert.equal(g.components.length, 2);
});

test("a value in one database only is not a thread — it joins nothing", () => {
  const g = buildGraph([src("A", [f("email", "lena@example.com")]), src("B", [f("phone", "+33639984102")])]);
  assert.deepEqual(g.threads, []);
  assert.equal(g.components.length, 2);
});

test("THE POINT: a thread whose removal splits the identity is load-bearing", () => {
  const g = buildGraph(CHAIN);
  assert.equal(g.components.length, 1, "the chain is connected to begin with");
  const bearing = g.threads.filter((t) => t.loadBearing).map((t) => t.value).sort();
  // both links in a chain carry weight; lose either and it is no longer one person
  assert.deepEqual(bearing, ["+33639984102", "lena@example.com"]);
});

test("a thread with a parallel path is NOT load-bearing", () => {
  // A and B share two independent values, so losing one changes nothing structural
  const g = buildGraph([
    src("A", [f("email", "lena@example.com"), f("phone", "+33639984102")]),
    src("B", [f("email", "lena@example.com"), f("phone", "+33639984102")]),
  ]);
  assert.equal(g.threads.length, 2);
  assert.deepEqual(g.threads.filter((t) => t.loadBearing), []);
});

test("pulling a thread reports what actually falls out", () => {
  const g = buildGraph(CHAIN);
  const email = g.threads.find((t) => t.value === "lena@example.com")!;
  const r = pullThread(CHAIN, email.id);
  assert.equal(r.before, 1);
  assert.equal(r.after, 2);
  assert.deepEqual(r.isolates, ["A"]);     // A was holding on by the email alone
});

test("the spine is the thread touching the most databases, and it comes first", () => {
  const g = buildGraph([
    src("A", [f("email", "lena@example.com"), f("location", "Lyon 7e")]),
    src("B", [f("email", "lena@example.com"), f("location", "Lyon 7e")]),
    src("C", [f("email", "lena@example.com")]),
  ]);
  assert.equal(g.threads[0].value, "lena@example.com");
  assert.equal(g.threads[0].databases.length, 3);
});

test("a masked value joins nothing — it matches every address at that domain", () => {
  const g = buildGraph([
    src("A", [f("email", "l***@example.com")]),
    src("B", [f("email", "l***@example.com")]),
  ]);
  assert.deepEqual(g.threads, []);
  assert.equal(g.components.length, 2);
});

test("a short or non-identifying value never joins two databases", () => {
  const g = buildGraph([
    src("A", [f("location", "FR"), f("other", "a long enough value, but not identifying")]),
    src("B", [f("location", "FR"), f("other", "a long enough value, but not identifying")]),
  ]);
  assert.deepEqual(g.threads, []);
});

test("the one-line description says which of the three states it is in", () => {
  assert.match(describeGraph(buildGraph(CHAIN)), /All 3 databases are connected/);
  assert.match(describeGraph(buildGraph(CHAIN)), /2 facts load-bearing/);
  assert.match(describeGraph(buildGraph([src("A", [f("email", "x@example.com")])])), /Nothing corroborates it/);
});

// ---- the layout --------------------------------------------------------------------
//
// The old ring put every breach at an equal angle on an ellipse capped at 200px, so
// past about a dozen the circles overlapped each other and their own labels. This is
// the assertion that was missing.

const many = (n: number): OrbitSource[] =>
  Array.from({ length: n }, (_, i) =>
    src(`Breach ${i}`, [
      f("email", "lena@example.com"),
      f("identity", `value ${i}`),
      ...(i % 3 === 0 ? [f("phone", "+33639984102")] : []),
    ]),
  );

for (const n of [1, 2, 7, 18, 40]) {
  test(`${n} databases: no two nodes overlap`, () => {
    const g = buildGraph(many(n));
    const p = layoutGraph(g, { width: 1000, height: 640 });
    assert.equal(p.length, n);
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const d = Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y);
        assert.ok(d >= p[i].r + p[j].r, `${p[i].name} and ${p[j].name} overlap: ${d.toFixed(1)} < ${p[i].r + p[j].r}`);
      }
    }
  });
}

test("every node stays inside the frame, with room for its label", () => {
  const p = layoutGraph(buildGraph(many(26)), { width: 1000, height: 640 });
  for (const q of p) {
    assert.ok(q.x - q.r >= 0 && q.x + q.r <= 1000, `${q.name} out horizontally`);
    assert.ok(q.y - q.r >= 0 && q.y + q.r <= 640, `${q.name} out vertically`);
  }
});

test("the layout is deterministic — a tab switch must not reshuffle it", () => {
  const g = buildGraph(many(14));
  const a = layoutGraph(g, { width: 1000, height: 640 });
  const b = layoutGraph(g, { width: 1000, height: 640 });
  assert.deepEqual(a, b);
});

test("databases that share values end up closer than ones that do not", () => {
  // two tight pairs, nothing between them
  const s = [
    src("A1", [f("email", "a@example.com")]), src("A2", [f("email", "a@example.com")]),
    src("B1", [f("email", "b@example.com")]), src("B2", [f("email", "b@example.com")]),
  ];
  const g = buildGraph(s);
  const p = layoutGraph(g, { width: 900, height: 600 });
  const at = (n: string) => p.find((q) => q.name === n)!;
  const d = (x: string, y: string) => Math.hypot(at(x).x - at(y).x, at(x).y - at(y).y);
  assert.ok(d("A1", "A2") < d("A1", "B1"), "joined nodes should sit closer than unjoined ones");
  assert.ok(d("B1", "B2") < d("B1", "A2"));
});

// ---- the bipartite drawing ----------------------------------------------------------
//
// One value shared by n databases is one fact, not n(n-1)/2 of them. Drawn pairwise it
// is a complete graph, and no layout makes K₂₂ readable — the picture is wrong before
// the layout runs. These assert the thing that replaces it.

test("a thread shared by every database is drawn as ONE hub, not a complete graph", () => {
  const g = buildGraph(many(22));
  // the model still knows the pairwise truth, which is what connectivity needs
  assert.equal(g.edges.length, (22 * 21) / 2);
  const b = layoutBipartite(g, { width: 1000, height: 640 });
  assert.equal(b.dbs.length, 22);
  // and the drawing has one hub per shared value — the email, the phone
  assert.ok(b.hubs.length <= 4, `${b.hubs.length} hubs`);
});

for (const n of [1, 2, 9, 22, 40]) {
  test(`bipartite at ${n} databases: nothing overlaps, hubs included`, () => {
    const b = layoutBipartite(buildGraph(many(n)), { width: 1000, height: 640 });
    const all = [...b.dbs, ...b.hubs];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = Math.hypot(all[j].x - all[i].x, all[j].y - all[i].y);
        assert.ok(d >= all[i].r + all[j].r, `${all[i].name} / ${all[j].name}: ${d.toFixed(1)}`);
      }
    }
    for (const q of all) {
      assert.ok(q.x - q.r >= 0 && q.x + q.r <= 1000, `${q.name} out horizontally`);
      assert.ok(q.y - q.r >= 0 && q.y + q.r <= 640, `${q.name} out vertically`);
    }
  });
}

test("the bipartite layout is deterministic too", () => {
  const g = buildGraph(many(16));
  assert.deepEqual(layoutBipartite(g, { width: 1000, height: 640 }), layoutBipartite(g, { width: 1000, height: 640 }));
});
