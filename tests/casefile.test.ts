import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyCasefile, addCard, updateCard, removeCard, linkCards, removeLink,
  tally, correlatable, freeSpot, sanitizeCasefile,
} from "../lib/casefile.ts";

test("cards land where they do not cover each other", () => {
  let f = emptyCasefile("seed");
  for (let i = 0; i < 6; i++) f = addCard(f, { kind: "lead", title: "lead " + i });
  for (let i = 0; i < f.cards.length; i++) {
    for (let j = i + 1; j < f.cards.length; j++) {
      const a = f.cards[i], b = f.cards[j];
      assert.ok(Math.abs(a.x - b.x) >= 230 || Math.abs(a.y - b.y) >= 130, `cards ${i} and ${j} overlap`);
    }
  }
  // and an explicit position is always honoured
  f = addCard(f, { kind: "note", title: "placed", x: 12, y: 34 });
  const placed = f.cards.find((c) => c.title === "placed")!;
  assert.deepEqual([placed.x, placed.y], [12, 34]);
  assert.ok(freeSpot([]).x > 0);
});

test("removing a card takes its links with it — no dangling edges", () => {
  let f = emptyCasefile("seed");
  f = addCard(f, { kind: "hypothesis", title: "H" });
  f = addCard(f, { kind: "evidence", title: "E" });
  const [h, e] = f.cards;
  f = linkCards(f, h.id, e.id, "supports");
  assert.equal(f.links.length, 1);
  f = removeCard(f, e.id);
  assert.equal(f.links.length, 0);
  assert.equal(f.cards.length, 1);
});

test("linking the same pair twice updates, never duplicates", () => {
  // two "supports" edges between the same cards would count twice in the tally —
  // that is exactly the confidence inflation this module exists to prevent
  let f = emptyCasefile("seed");
  f = addCard(f, { kind: "hypothesis", title: "H" });
  f = addCard(f, { kind: "evidence", title: "E" });
  const [h, e] = f.cards;
  f = linkCards(f, h.id, e.id, "supports");
  f = linkCards(f, e.id, h.id, "contradicts"); // reversed, same pair
  assert.equal(f.links.length, 1);
  assert.equal(f.links[0].kind, "contradicts");
  // self-links and unknown cards are refused
  assert.equal(linkCards(f, h.id, h.id, "supports").links.length, 1);
  assert.equal(linkCards(f, h.id, "ghost", "supports").links.length, 1);
  f = removeLink(f, f.links[0].id);
  assert.equal(f.links.length, 0);
});

test("a hypothesis gets a tally, never a probability", () => {
  let f = emptyCasefile("seed");
  f = addCard(f, { kind: "hypothesis", title: "Same person" });
  const h = f.cards[0].id;
  const mk = (title: string, status: any, kind: any) => {
    f = addCard(f, { kind: "evidence", title, status });
    f = linkCards(f, h, f.cards[f.cards.length - 1].id, kind);
  };

  assert.equal(tally(f, h).verdict, "nothing attached yet");

  mk("unchecked lead", "open", "supports");
  let t = tally(f, h);
  assert.deepEqual([t.supports, t.contradicts, t.open], [0, 0, 1], "an unconfirmed card is not evidence");
  assert.match(t.verdict, /unresolved/);

  mk("checked A", "confirmed", "supports");
  mk("checked B", "confirmed", "supports");
  t = tally(f, h);
  assert.equal(t.supports, 2);
  assert.match(t.verdict, /supported by 2/);

  mk("the alibi", "confirmed", "contradicts");
  t = tally(f, h);
  assert.equal(t.contradicts, 1);
  assert.match(t.verdict, /conflict/, "confirmed evidence on both sides must be surfaced, not averaged");
  // no number anywhere claims a probability
  assert.doesNotMatch(t.verdict, /\d+\s*%/);
});

test("a parked card is excluded from the count", () => {
  let f = emptyCasefile("seed");
  f = addCard(f, { kind: "hypothesis", title: "H" });
  f = addCard(f, { kind: "evidence", title: "set aside", status: "parked" });
  const [h, p] = f.cards;
  f = linkCards(f, h.id, p.id, "supports");
  assert.deepEqual(tally(f, h.id).supports, 0);
});

test("only a real identifier can be pushed into the correlation engine", () => {
  const base = { id: "c", kind: "lead" as const, body: "", x: 0, y: 0, status: "open" as const, createdAt: "" };
  assert.equal(correlatable({ ...base, title: "marie_dubois" }).ok, true);
  assert.equal(correlatable({ ...base, title: "marie.dubois@corp.fr" }).ok, true);
  assert.equal(correlatable({ ...base, title: "", url: "https://example.com/x" }).ok, true);
  const prose = correlatable({ ...base, title: "she posts on that forum a lot" });
  assert.equal(prose.ok, false, "prose is not a selector");
  assert.match(prose.reason || "", /identifier/);
  assert.equal(correlatable({ ...base, title: "" }).ok, false);
});

test("an imported board is sanitised, not trusted", () => {
  const f = sanitizeCasefile({
    cards: [
      { id: "a", kind: "lead", title: "ok", x: 1, y: 2, status: "confirmed", createdAt: "2026-01-01" },
      { id: "b", kind: "not-a-kind", title: "dropped" },
      { id: "c", kind: "note", title: "x".repeat(500), body: "y".repeat(9000), status: "nonsense" },
    ],
    links: [
      { id: "l1", from: "a", to: "c", kind: "supports" },
      { id: "l2", from: "a", to: "ghost", kind: "supports" },
      { id: "l3", from: "a", to: "c", kind: "invented" },
    ],
    orbit: { positions: { a: [1, 2] }, pinned: ["a", 7], mode: "banana" },
  }, "seed");

  assert.deepEqual(f.cards.map((c) => c.id), ["a", "c"], "unknown card kinds are dropped");
  assert.equal(f.cards[1].title.length, 160);
  assert.equal(f.cards[1].body.length, 4000);
  assert.equal(f.cards[1].status, "open", "an unknown status falls back, it does not pass through");
  assert.deepEqual(f.links.map((l) => l.id), ["l1"], "links to missing cards and unknown kinds are dropped");
  assert.deepEqual(f.orbit.pinned, ["a"]);
  assert.equal(f.orbit.mode, "orbit");
});

test("editing a card cannot change its identity", () => {
  let f = emptyCasefile("seed");
  f = addCard(f, { kind: "lead", title: "before" });
  const id = f.cards[0].id;
  f = updateCard(f, id, { title: "after", id: "hijacked" } as any);
  assert.equal(f.cards[0].id, id);
  assert.equal(f.cards[0].title, "after");
});
