import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceOf, serviceGrid, gridSummary } from "../lib/services.ts";

// The grid every product in this category shows — built from the breaches already paid
// for rather than by probing sites. "Registered at Deezer" is a guess about today; "in
// Deezer's 2019 breach" is a fact about a file somebody already has.

test("a dump name reduces to the service and the year", () => {
  assert.deepEqual(serviceOf("Deezer 2019"), { name: "Deezer", kind: "service", year: 2019 });
  assert.deepEqual(serviceOf("MyFitnessPal (2018)"), { name: "MyFitnessPal", kind: "service", year: 2018 });
  assert.equal(serviceOf("Twitter v2").name, "Twitter");
  assert.equal(serviceOf("Wattpad").name, "Wattpad");
});

test("an aggregated list is NOT a service, and keeps its own name", () => {
  // telling somebody they have an account at "Collection #1" is telling them they have
  // an account at a company that does not exist
  for (const n of ["Collection #1", "COMB", "AntiPublic", "BreachCompilation", "Combolist 2021"]) {
    assert.equal(serviceOf(n).kind, "aggregate", n);
    assert.ok(serviceOf(n).name.length > 0, "and it is still named");
  }
});

test("a name it cannot confidently reduce is left alone", () => {
  // a wrong logo is worse than an unfamiliar string
  assert.equal(serviceOf("123").kind, "aggregate");
  assert.equal(serviceOf("").name, "Unnamed source");
});

const f = (v: string, s: any) => ({ value: v, severity: s });

test("several dumps of one company are one tile spanning the years", () => {
  const tiles = serviceGrid([
    { name: "Deezer 2019", info: "", severity: "high", findings: [f("a@b.c", "high")] },
    { name: "Deezer 2022", info: "", severity: "medium", findings: [f("Lyon", "medium")] },
  ]);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].firstYear, 2019);
  assert.equal(tiles[0].lastYear, 2022);
  assert.equal(tiles[0].dumps.length, 2);
  assert.equal(tiles[0].severity, "high", "the worst thing it gave up wins");
});

test("services are listed before aggregates — they answer the question being asked", () => {
  const tiles = serviceGrid([
    { name: "Collection #1", info: "", severity: "critical", findings: [f("pw", "critical")] },
    { name: "LinkedIn 2021", info: "", severity: "medium", findings: [f("Jane", "medium")] },
  ]);
  assert.equal(tiles[0].kind, "service", "even though the aggregate is more severe");
  assert.equal(tiles[1].kind, "aggregate");
});

test("the summary counts the two kinds separately and spans the years", () => {
  const tiles = serviceGrid([
    { name: "Deezer 2019", info: "", severity: "high", findings: [f("a", "high")] },
    { name: "LinkedIn 2021", info: "", severity: "low", findings: [f("b", "low")] },
    { name: "Collection #1", info: "published in 2019", severity: "critical", findings: [f("c", "critical")] },
  ]);
  const line = gridSummary(tiles);
  assert.match(line, /2 services/);
  assert.match(line, /1 aggregated list/);
  assert.match(line, /2019–2021/);
});

test("nothing found says so plainly", () => {
  assert.match(gridSummary([]), /No source named this subject/);
});

test("compound names are matched by prefix — a trailing boundary misses them", () => {
  // "Combolist" has no word boundary after "combo", it has the letter l, and these
  // names are compounds far more often than they are standalone words
  for (const n of ["Combolist 2021", "Combolists", "StealerLogs", "Collections", "Cracked.io"]) {
    assert.equal(serviceOf(n).kind, "aggregate", n);
  }
});

test("a real company whose name merely starts like one of them is still a service", () => {
  assert.equal(serviceOf("Combine Harvester Co").kind, "service");
});
