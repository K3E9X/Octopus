// The investigator's board — the half of an investigation the tool does not run.
//
// An analyst does not only wait for a scanner. They read a forum thread, recognise a
// face, get a tip, form a theory, and hold half a dozen loose ends at once. None of
// that fits in a node graph produced by connectors, and when there is nowhere to put
// it, it ends up in a text file next to the tool — which is where correlation dies.
//
// This is that place: free cards you write yourself, links you draw yourself, on the
// same case as the automatic graph. Two rules keep it honest:
//
//  1. A card is YOUR claim until it is corroborated. Cards never acquire a tier by
//     being written confidently; a card promoted into the graph goes through the same
//     correlation engine as everything else and is scored by the same rules.
//  2. A hypothesis is never given a probability. It gets a TALLY — what supports it,
//     what contradicts it, what is still open. A number would invent a confidence the
//     evidence has not earned; a tally is countable and arguable.
//
// The board also stores the Orbit layout (positions, pins, layout mode), because both
// are the analyst's arrangement of the same case and should travel together.

export type CardKind = "lead" | "note" | "source" | "person" | "hypothesis" | "question" | "evidence";
export type CardStatus = "open" | "confirmed" | "refuted" | "parked";

export interface BoardCard {
  id: string;
  kind: CardKind;
  title: string;
  body: string;
  url?: string;
  x: number;
  y: number;
  status: CardStatus;
  createdAt: string;
  /** set when the card was pinned FROM the graph — keeps the card tied to that node */
  ref?: string;
  /** graph node ids this card produced when it was correlated */
  produced?: string[];
}

/**
 * Typed links. "supports" and "contradicts" are the two that matter: a board where
 * everything is merely "related" cannot tell you when your own theory is in trouble.
 */
export type LinkKind = "supports" | "contradicts" | "leads-to" | "same-as" | "related";

export interface BoardLink {
  id: string;
  from: string;
  to: string;
  kind: LinkKind;
  note?: string;
}

export interface OrbitLayout {
  /** manual positions, world coordinates relative to the seed */
  positions: Record<string, [number, number]>;
  /** nodes the analyst froze in place */
  pinned: string[];
  mode: "orbit" | "cluster" | "type" | "free";
}

export interface Casefile {
  seed: string;
  cards: BoardCard[];
  links: BoardLink[];
  orbit: OrbitLayout;
  updatedAt: number;
}

export const CARD_KINDS: { id: CardKind; label: string; hint: string }[] = [
  { id: "lead", label: "Lead", hint: "Something to chase" },
  { id: "source", label: "Source", hint: "A page, post or document you found" },
  { id: "person", label: "Person", hint: "A human in the picture" },
  { id: "evidence", label: "Evidence", hint: "A fact you can point at" },
  { id: "hypothesis", label: "Hypothesis", hint: "A theory to be supported or killed" },
  { id: "question", label: "Question", hint: "What you still do not know" },
  { id: "note", label: "Note", hint: "Anything else" },
];

export const LINK_KINDS: { id: LinkKind; label: string }[] = [
  { id: "supports", label: "supports" },
  { id: "contradicts", label: "contradicts" },
  { id: "leads-to", label: "leads to" },
  { id: "same-as", label: "same as" },
  { id: "related", label: "related" },
];

export function emptyCasefile(seed: string): Casefile {
  return { seed, cards: [], links: [], orbit: { positions: {}, pinned: [], mode: "orbit" }, updatedAt: Date.now() };
}

let counter = 0;
function newId(prefix: string): string {
  counter = (counter + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * Place a new card where it will not land on top of another. Cheap spiral search —
 * a board that stacks cards invisibly is a board that loses them.
 */
export function freeSpot(cards: BoardCard[], w = 230, h = 130): { x: number; y: number } {
  const clash = (x: number, y: number) =>
    cards.some((c) => Math.abs(c.x - x) < w && Math.abs(c.y - y) < h);
  // fill ROWS first: a board is wider than it is tall, and stacking cards in a column
  // makes every link between neighbours run straight through them
  const perRow = 5;
  for (let i = 0; i < 200; i++) {
    const x = 60 + (i % perRow) * w;
    const y = 60 + Math.floor(i / perRow) * h;
    if (!clash(x, y)) return { x, y };
  }
  return { x: 60, y: 60 };
}

export function addCard(file: Casefile, card: Partial<BoardCard> & { kind: CardKind }): Casefile {
  const spot = card.x != null && card.y != null ? { x: card.x, y: card.y } : freeSpot(file.cards);
  const c: BoardCard = {
    id: card.id || newId("card"),
    kind: card.kind,
    title: (card.title || "").slice(0, 160),
    body: (card.body || "").slice(0, 4000),
    url: card.url,
    x: spot.x,
    y: spot.y,
    status: card.status || "open",
    createdAt: card.createdAt || new Date().toISOString(),
    ref: card.ref,
    produced: card.produced,
  };
  return { ...file, cards: [...file.cards, c], updatedAt: Date.now() };
}

export function updateCard(file: Casefile, id: string, patch: Partial<BoardCard>): Casefile {
  return {
    ...file,
    cards: file.cards.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)),
    updatedAt: Date.now(),
  };
}

/** Removing a card removes the links that hang off it — never leave dangling edges. */
export function removeCard(file: Casefile, id: string): Casefile {
  return {
    ...file,
    cards: file.cards.filter((c) => c.id !== id),
    links: file.links.filter((l) => l.from !== id && l.to !== id),
    updatedAt: Date.now(),
  };
}

/**
 * Link two cards. Self-links are refused, and an existing pair is UPDATED rather than
 * duplicated — two "supports" edges between the same cards would double-count in the
 * tally, which is exactly the inflation this module exists to avoid.
 */
export function linkCards(file: Casefile, from: string, to: string, kind: LinkKind): Casefile {
  if (from === to) return file;
  if (!file.cards.some((c) => c.id === from) || !file.cards.some((c) => c.id === to)) return file;
  const existing = file.links.find(
    (l) => (l.from === from && l.to === to) || (l.from === to && l.to === from),
  );
  if (existing) {
    return { ...file, links: file.links.map((l) => (l.id === existing.id ? { ...l, kind } : l)), updatedAt: Date.now() };
  }
  return { ...file, links: [...file.links, { id: newId("link"), from, to, kind }], updatedAt: Date.now() };
}

export function removeLink(file: Casefile, id: string): Casefile {
  return { ...file, links: file.links.filter((l) => l.id !== id), updatedAt: Date.now() };
}

export interface Tally {
  supports: number;
  contradicts: number;
  open: number;
  /** plain-language verdict — never a percentage */
  verdict: string;
}

/**
 * Count what stands for and against a hypothesis. Only cards that are themselves
 * CONFIRMED count as settled support or opposition; anything still open is counted
 * separately, because "three leads I have not checked" is not three pieces of evidence.
 */
export function tally(file: Casefile, hypothesisId: string): Tally {
  let supports = 0, contradicts = 0, open = 0;
  for (const l of file.links) {
    if (l.from !== hypothesisId && l.to !== hypothesisId) continue;
    const otherId = l.from === hypothesisId ? l.to : l.from;
    const other = file.cards.find((c) => c.id === otherId);
    if (!other || other.status === "parked") continue;
    if (l.kind === "supports") { other.status === "confirmed" ? supports++ : open++; }
    else if (l.kind === "contradicts") { other.status === "confirmed" ? contradicts++ : open++; }
  }
  let verdict: string;
  if (contradicts > 0 && supports === 0) verdict = "contradicted — the evidence points the other way";
  else if (contradicts > 0) verdict = "in conflict — confirmed evidence on both sides, resolve it before reporting";
  else if (supports >= 2) verdict = "supported by " + supports + " confirmed item(s)";
  else if (supports === 1) verdict = "one confirmed item — not yet corroborated";
  else if (open > 0) verdict = "unresolved — " + open + " item(s) still unconfirmed";
  else verdict = "nothing attached yet";
  return { supports, contradicts, open, verdict };
}

/** A card can be pushed into the correlation engine only if it names an identifier. */
export function correlatable(card: BoardCard): { ok: boolean; handle?: string; reason?: string } {
  const text = (card.title || "").trim();
  if (card.url && /^https?:\/\//i.test(card.url)) return { ok: true, handle: text || card.url };
  if (!text) return { ok: false, reason: "give the card a handle, email or URL first" };
  if (/\s/.test(text) && !/@/.test(text)) return { ok: false, reason: "a title with spaces is not an identifier — put the handle or email in the title, or add a URL" };
  return { ok: true, handle: text };
}

// ---- persistence -------------------------------------------------------------
// Per seed, in the browser. The board is the analyst's own working material; it lives
// where their keys live, and it travels inside the case file on export.

const KEY = "octopus:casefile:v1";

type Store = Record<string, Casefile>;

function read(): Store {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(window.localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}

export function loadCasefile(seed: string): Casefile {
  const s = (seed || "").trim().toLowerCase();
  const all = read();
  return all[s] ? { ...emptyCasefile(s), ...all[s] } : emptyCasefile(s);
}

export function saveCasefile(file: Casefile): void {
  if (typeof window === "undefined") return;
  const s = (file.seed || "").trim().toLowerCase();
  if (!s) return;
  try {
    const all = read();
    all[s] = { ...file, seed: s, updatedAt: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* quota */ }
}

/** Accept a casefile from an imported case file, keeping only what we understand. */
export function sanitizeCasefile(raw: any, seed: string): Casefile {
  const base = emptyCasefile(seed);
  if (!raw || typeof raw !== "object") return base;
  const kinds = new Set(CARD_KINDS.map((k) => k.id));
  const linkKinds = new Set(LINK_KINDS.map((k) => k.id));
  const cards: BoardCard[] = Array.isArray(raw.cards)
    ? raw.cards.filter((c: any) => c && typeof c.id === "string" && kinds.has(c.kind)).map((c: any) => ({
        id: String(c.id), kind: c.kind,
        title: String(c.title || "").slice(0, 160),
        body: String(c.body || "").slice(0, 4000),
        url: typeof c.url === "string" ? c.url.slice(0, 500) : undefined,
        x: Number(c.x) || 0, y: Number(c.y) || 0,
        status: ["open", "confirmed", "refuted", "parked"].includes(c.status) ? c.status : "open",
        createdAt: String(c.createdAt || new Date().toISOString()),
        ref: typeof c.ref === "string" ? c.ref : undefined,
        produced: Array.isArray(c.produced) ? c.produced.filter((p: any) => typeof p === "string") : undefined,
      }))
    : [];
  const ids = new Set(cards.map((c) => c.id));
  const links: BoardLink[] = Array.isArray(raw.links)
    ? raw.links
        .filter((l: any) => l && ids.has(l.from) && ids.has(l.to) && linkKinds.has(l.kind))
        .map((l: any) => ({ id: String(l.id || newId("link")), from: l.from, to: l.to, kind: l.kind, note: l.note }))
    : [];
  const orbit: OrbitLayout = {
    positions: raw.orbit && typeof raw.orbit.positions === "object" ? raw.orbit.positions : {},
    pinned: Array.isArray(raw.orbit?.pinned) ? raw.orbit.pinned.filter((p: any) => typeof p === "string") : [],
    mode: ["orbit", "cluster", "type", "free"].includes(raw.orbit?.mode) ? raw.orbit.mode : "orbit",
  };
  return { ...base, cards, links, orbit };
}
