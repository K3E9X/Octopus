"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { SIGNALS, SEED, BANDS, BAND_ORDER, type Signal, type Status } from "@/lib/signals";
import { listCases, saveCase, removeCase, caseToJSON, parseCase, backendMode, listSnapshots, type Case } from "@/lib/cases";
import { BUILTIN_APPS, MANUAL_APPS, type AppDef } from "@/lib/registry";
import { loadEnabled, saveEnabled } from "@/lib/apps";
import { normId } from "@/lib/extract";
import { buildDossier, type Dossier } from "@/lib/dossier";
import type { Verification } from "@/lib/verify";
import { scoreEvidence, TIER_LABEL } from "@/lib/scoring";
import { assessIndependence, independenceNote } from "@/lib/lineage";
import { reverseImageLinks } from "@/lib/reverseimage";
import { diffSnapshots, type MonitorDiff } from "@/lib/monitor";
import { loadDecisions, saveDecision, applyDecisionsFiltered, suppressedIds } from "@/lib/decisions";
import { shouldWipeBeforeScan } from "@/lib/board";
import { looksLikeName } from "@/lib/name";
import { buildTimeline } from "@/lib/timeline";
import { loadSettings, saveSettings, cfgHeaders, tradecraftHeaders, toClientConfig, type OctopusSettings } from "@/lib/settings";
import { migrateLegacyStorage } from "@/lib/migrate";
import { toGraphML } from "@/lib/graphexport";
import { Logo } from "./Logo";
import { loadCasefile, saveCasefile, addCard, updateCard, correlatable, emptyCasefile, sanitizeCasefile, type Casefile, type BoardCard, type OrbitLayout } from "@/lib/casefile";
import { Glyph, type GlyphName } from "./Glyph";
import { handleRarity } from "@/lib/rarity";
import { LLM_PRESETS } from "@/lib/llmconfig";
import type { AssistResult } from "@/lib/assist";

// Leaflet touches window on import — load the map only in the browser.
const MapView = dynamic(() => import("./MapView"), { ssr: false });
const CaseBoard = dynamic(() => import("./CaseBoard"), { ssr: false });

interface WorkNode extends Signal {
  x: number; y: number; vx: number; vy: number; op: number; a: number;
  /** frozen where the analyst put it — physics stops touching it */
  pinned?: boolean;
}

/** How the graph arranges itself. The analyst chooses; the physics obeys. */
export type OrbitMode = "orbit" | "cluster" | "type" | "free";
const ORBIT_MODES: { id: OrbitMode; label: string; hint: string }[] = [
  { id: "orbit", label: "Orbit", hint: "distance from the seed IS the confidence" },
  { id: "cluster", label: "Clusters", hint: "accounts resolved to one identity sit together" },
  { id: "type", label: "By type", hint: "platforms, emails, people, leaks in their own sectors" },
  { id: "free", label: "Free", hint: "no gravity — arrange it yourself" },
];

type RailId = "investigate" | "enrich" | "sources" | "cases" | "data" | "configure";

const RAIL: { id: RailId; glyph: GlyphName; label: string }[] = [
  { id: "investigate", glyph: "investigate", label: "Investigate" },
  { id: "enrich", glyph: "enrich", label: "Enrich" },
  { id: "sources", glyph: "sources", label: "Sources" },
  { id: "cases", glyph: "cases", label: "Cases" },
  { id: "data", glyph: "data", label: "Data" },
  { id: "configure", glyph: "configure", label: "Configure" },
];

/** One palette entry. `hint` is searched too, so "onion" finds "Open hidden service". */
interface Cmd { group: string; label: string; hint: string; run: () => void; key?: string }

export default function OrbitBoard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodiesRef = useRef<HTMLDivElement>(null);
  const seedRef = useRef<string>(SEED);
  const selectedRef = useRef<string | null>(null);
  const nodesRef = useRef<WorkNode[]>([]);
  const elsRef = useRef<Record<string, HTMLDivElement>>({});
  const draggingRef = useRef<WorkNode | null>(null);
  const metaRef = useRef({ cx: 0, cy: 0 });
  const rebuildRef = useRef<(sigs: Signal[], spawn?: boolean) => void>(() => {});
  const addNodeRef = useRef<(s: Signal) => void>(() => {});
  const mergeRef = useRef<(sigs: Signal[], originId: string, qkey: string) => number>(() => 0);
  const removeNodeRef = useRef<(id: string) => void>(() => {});
  const focusRef = useRef<string | null>(null);
  // viewport (pan/zoom) and layout mode live in refs: the animation loop reads them
  // every frame and must never be the reason React re-renders
  const viewRef = useRef({ x: 0, y: 0, z: 1 });
  const modeRef = useRef<OrbitMode>("orbit");
  const fitRef = useRef<() => void>(() => {});
  const layoutRef = useRef<(m: OrbitMode) => void>(() => {});
  // the animation loop cannot read React state, so the casefile bridge is a pair of refs
  const saveLayoutRef = useRef<(l: OrbitLayout) => void>(() => {});
  const readLayoutRef = useRef<() => OrbitLayout | null>(() => null);

  const [seed, setSeed] = useState(SEED);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  // One navigation model: a rail of GROUPS on the left, each opening one popover, plus
  // a command palette over everything. It replaces the twelve competing top-bar buttons
  // — nothing was removed, it was given a place.
  const [rail, setRail] = useState<{ id: RailId; top: number } | null>(null);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [addForm, setAddForm] = useState<{ platform: string; handle: string; url: string; via: string; note: string; screenshot: string; displayName: string; bio: string; location: string; email: string; avatar: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const ingestRef = useRef<(manual: Signal, extracted: Signal[], links: [string, string][]) => void>(() => {});
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [view, setView] = useState<"board" | "case" | "table" | "timeline" | "map">("board");
  const [monitor, setMonitor] = useState<MonitorDiff | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [apiOpen, setApiOpen] = useState(false);
  const [settings, setSettings] = useState<OctopusSettings>({});
  const [pings, setPings] = useState<Record<string, { ok: boolean; detail: string } | "loading">>({});
  const [assist, setAssist] = useState<AssistResult | null>(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistVerdict, setAssistVerdict] = useState<Verification | null>(null);
  const [isDemo, setIsDemo] = useState(true); // the board starts with demo data
  const demoRef = useRef(true);
  const lastScanRef = useRef<string>("");
  const suppressedRef = useRef<Set<string>>(new Set()); // rejected/removed → never re-propose
  const chainedRef = useRef<Set<string>>(new Set());    // queries already auto-chained
  const [tableSort, setTableSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "tier", dir: 1 });
  const [tableFilter, setTableFilter] = useState("");
  const [narrative, setNarrative] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);

  const deepRef = useRef(false);
  const [deepStatus, setDeepStatus] = useState<string | null>(null);
  const seedInputRef = useRef<HTMLInputElement>(null);
  const [orbitMode, setOrbitModeState] = useState<OrbitMode>("orbit");
  const [palQuery, setPalQuery] = useState("");
  const [palIndex, setPalIndex] = useState(0);
  const [modKey, setModKey] = useState("Ctrl ");

  // Every save appends an immutable snapshot — the chain of custody. It was being
  // written and never shown, which makes an audit trail you cannot audit.
  const [snapCounts, setSnapCounts] = useState<Record<string, number>>({});
  async function loadSnapCounts(list: Case[]) {
    const out: Record<string, number> = {};
    await Promise.all(list.slice(0, 20).map(async (c) => {
      try { out[c.id] = (await listSnapshots(c.id)).length; } catch { /* local fallback */ }
    }));
    setSnapCounts(out);
  }

  function setOrbitMode(m: OrbitMode) {
    setOrbitModeState(m);
    layoutRef.current(m);
  }

  /** Release every pin: the graph re-forms itself under the current layout. */
  function unpinAll() {
    for (const n of nodesRef.current) n.pinned = false;
    for (const el of Object.values(elsRef.current)) el.classList.remove("pinned");
    saveLayoutRef.current({ positions: {}, pinned: [], mode: orbitMode });
    flashMsg("all nodes released");
  }

  function openRail(e: React.MouseEvent<HTMLButtonElement>, id: RailId) {
    if (rail?.id === id) return setRail(null);
    // anchor the popover to the button, but never let it run off the bottom
    const r = e.currentTarget.getBoundingClientRect();
    setRail({ id, top: Math.max(66, Math.min(r.top, window.innerHeight - 360)) });
    if (id === "cases") listCases().then((l) => { setCases(l); loadSnapCounts(l); }).catch(() => {});
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { window.localStorage.setItem("octopus:theme", next); } catch { /* private mode */ }
  }

  // Resolve the theme once: an explicit choice wins, otherwise follow the system — and
  // keep following it until the analyst actually chooses.
  useEffect(() => {
    setModKey(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl ");
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("octopus:theme"); } catch { /* private mode */ }
    if (stored === "light" || stored === "dark") { setTheme(stored); return; }
    setTheme(mq.matches ? "light" : "dark");
    const onSys = (ev: MediaQueryListEvent) => setTheme(ev.matches ? "light" : "dark");
    mq.addEventListener("change", onSys);
    return () => mq.removeEventListener("change", onSys);
  }, []);

  // Case count is shown on the rail, so it has to be known before anything is clicked.
  useEffect(() => { listCases().then(setCases).catch(() => {}); }, []);

  /** Everything the interface can do, in one searchable list. */
  const COMMANDS: Cmd[] = [
    { group: "Investigate", label: "Investigate", hint: "Scan, auto-expand one hop, open the dossier", run: investigate, key: "⏎" },
    { group: "Investigate", label: "Scan the seed", hint: "Collect presences without expanding", run: runScan },
    { group: "Investigate", label: "Deep scan", hint: "3000+ sites via the collector worker", run: deepScan },
    { group: "Investigate", label: "Ask the assistant", hint: "LLM reads the graph: conclusion, pivots, false positives", run: runAssist },
    { group: "Investigate", label: "Monitor changes", hint: "Re-scan and diff since the last snapshot", run: runMonitor },
    { group: "Investigate", label: "Open dossier", hint: "The synthesized identity and grounded brief", run: openDossier },
    { group: "Enrich", label: "Image metadata", hint: "EXIF, GPS and camera from a photo URL", run: imageForensics },
    { group: "Enrich", label: "Face match", hint: "The same person across different photos", run: faceMatch },
    { group: "Enrich", label: "Open hidden service", hint: "Retrieve a .onion through Tor — emails, wallets, keys, handles", run: openOnion },
    { group: "Enrich", label: "Add a finding", hint: "Your manual discovery, run through the same engine", run: () => openAddForm() },
    { group: "View", label: "Orbit", hint: "The correlation graph — confidence as gravity", run: () => setView("board"), key: "1" },
    { group: "View", label: "Investigator's board", hint: "Your own cards, links and theories, correlated with the graph", run: () => setView("case"), key: "2" },
    { group: "View", label: "Table", hint: "Every node, sortable and filterable", run: () => setView("table"), key: "3" },
    { group: "View", label: "Timeline", hint: "The chronology of the footprint", run: () => setView("timeline"), key: "4" },
    { group: "View", label: "Map", hint: "Resolved locations and where they converge", run: () => setView("map"), key: "5" },
    { group: "Graph", label: "Fit the graph to the view", hint: "Frame every node currently on the board", run: () => { setView("board"); fitRef.current(); }, key: "F" },
    { group: "Graph", label: "Layout: orbit", hint: "Distance from the seed IS the confidence", run: () => { setView("board"); setOrbitMode("orbit"); } },
    { group: "Graph", label: "Layout: clusters", hint: "Accounts resolved to one identity sit together", run: () => { setView("board"); setOrbitMode("cluster"); } },
    { group: "Graph", label: "Layout: by type", hint: "Platforms, emails, people and leaks in their own sectors", run: () => { setView("board"); setOrbitMode("type"); } },
    { group: "Graph", label: "Layout: free", hint: "No gravity — arrange the graph yourself", run: () => { setView("board"); setOrbitMode("free"); } },
    { group: "Graph", label: "Release all pins", hint: "Let the graph re-form itself", run: unpinAll },
    { group: "Data", label: "Local corpora", hint: "Load and search datasets you hold — silent, offline", run: () => { setCorpusOpen(true); loadCorpusStats(); } },
    { group: "Data", label: "Save the case", hint: "Append an immutable snapshot", run: saveCurrent },
    { group: "Data", label: "Export JSON", hint: "Download the case file", run: exportCurrent },
    { group: "Data", label: "Export graph (GraphML)", hint: "Open in flowsint / Maltego / Gephi", run: exportGraphML },
    { group: "Data", label: "Import JSON", hint: "Load a case file", run: () => fileRef.current?.click() },
    { group: "Configure", label: "Sources & apps", hint: "Connectors to run, manual pivots to open", run: (e2?: any) => setRail({ id: "sources", top: 90 }) },
    { group: "Configure", label: "API keys & tradecraft", hint: "LLM, leak sources, collector, OPSEC posture, proxy / Tor", run: () => setApiOpen(true) },
    { group: "Configure", label: "Usage guide", hint: "Where to start and how to run an investigation", run: () => setGuideOpen(true) },
    { group: "Configure", label: "Toggle light / dark", hint: "Follows your system until you choose", run: toggleTheme },
  ];

  const palResults = (() => {
    const q = palQuery.trim().toLowerCase();
    if (!q) return COMMANDS;
    const words = q.split(/\s+/);
    return COMMANDS.filter((c) => {
      const hay = (c.group + " " + c.label + " " + c.hint).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  })();

  function onPaletteKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setPalIndex((i) => Math.min(i + 1, palResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPalIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const c = palResults[palIndex];
      if (c) { setPalette(false); c.run(); }
    } else if (e.key === "Escape") { setPalette(false); }
  }

  // Global keys. Deliberately few, and none of them steal a keystroke from a field:
  // an interface that swallows what you type is worse than one with no shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalQuery(""); setPalIndex(0); setPalette((p) => !p);
        return;
      }
      if (e.key === "Escape") { setPalette(false); setRail(null); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); seedInputRef.current?.focus(); seedInputRef.current?.select(); return; }
      if (e.key === "f" || e.key === "F") { fitRef.current(); return; }
      const views = { "1": "board", "2": "case", "3": "table", "4": "timeline", "5": "map" } as const;
      const v = views[e.key as keyof typeof views];
      if (v) setView(v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- the investigator's board: the analyst's own material, per seed ---
  const [casefile, setCasefile] = useState<Casefile>(() => emptyCasefile(SEED));
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const casefileRef = useRef<Casefile>(casefile);

  function applyCasefile(f: Casefile) {
    casefileRef.current = f;
    setCasefile(f);
    saveCasefile(f);
  }

  // The Orbit arrangement is stored with the board: both are the analyst's layout of
  // the same case, and they should travel together on export.
  // Load the stored board BEFORE the canvas effect runs its first rebuild — effects
  // fire in declaration order, and rebuild() restores the saved arrangement from
  // casefileRef. Without this the board (and every pin) was lost on reload.
  useEffect(() => { loadBoardFor(seedRef.current); }, []);

  useEffect(() => {
    saveLayoutRef.current = (orbit: OrbitLayout) => {
      const f = { ...casefileRef.current, orbit };
      casefileRef.current = f;
      setCasefile(f);
      saveCasefile(f);
    };
    readLayoutRef.current = () => casefileRef.current.orbit || null;
  }, []);

  /** Load the board that belongs to a seed (each investigation keeps its own). */
  function loadBoardFor(seed: string) {
    const f = loadCasefile(seed);
    casefileRef.current = f;
    setCasefile(f);
  }

  // Push a card's identifier through the SAME correlation engine a scan uses. The
  // card does not become a node by being written — it becomes one by being correlated
  // and scored like everything else.
  async function correlateCard(card: BoardCard) {
    const c = correlatable(card);
    if (!c.ok || cardBusy) { if (!c.ok) flashMsg(c.reason || "not correlatable"); return; }
    setCardBusy(card.id);
    try {
      const platform = card.kind === "person" ? "PERSON" : (card.url ? hostLabel(card.url) : "MANUAL");
      const res = await fetch("/api/correlate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: {
            platform, handle: c.handle, url: card.url || "",
            via: "investigator board", note: card.body || "",
          },
          signals: currentSignals(),
          seed: seedRef.current.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.manual) { flashMsg(data?.error || "correlation failed"); return; }
      ingestRef.current(data.manual as Signal, (data.extracted || []) as Signal[], (data.links || []) as [string, string][]);
      const produced = [data.manual.id, ...((data.extracted || []) as Signal[]).map((e) => e.id)];
      applyCasefile(updateCard(casefileRef.current, card.id, { produced, ref: card.ref || data.manual.id }));
      flashMsg(data.summary || `card correlated → ${produced.length} node(s)`);
    } catch {
      flashMsg("network unavailable — the card is kept, nothing was correlated");
    } finally {
      setCardBusy(null);
    }
  }

  function hostLabel(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, "").toUpperCase().slice(0, 24); } catch { return "SOURCE"; }
  }

  /** Pin a graph node onto the board so it can be reasoned about by hand. */
  function pinToBoard(n: Signal) {
    const f = casefileRef.current;
    if (f.cards.some((c) => c.ref === n.id)) { flashMsg("already on the board"); setView("case"); return; }
    applyCasefile(addCard(f, {
      kind: "evidence",
      title: n.handle,
      body: `${n.platform} · ${(n.tier || n.status).toUpperCase()}` + (n.evidence[0] ? ` — ${n.evidence[0].name}` : ""),
      url: n.url,
      ref: n.id,
    }));
    flashMsg(`pinned "${n.handle}" to the board`);
    setView("case");
  }

  // --- local corpora: datasets the analyst already holds ---
  const [corpusOpen, setCorpusOpen] = useState(false);
  const [corpusStats, setCorpusStats] = useState<{ corpora: { name: string; records: number }[]; total: number; persistent: boolean } | null>(null);
  const [corpusName, setCorpusName] = useState("");
  const [corpusText, setCorpusText] = useState("");
  const [corpusBusy, setCorpusBusy] = useState(false);
  const [corpusMsg, setCorpusMsg] = useState("");
  const [corpusQuery, setCorpusQuery] = useState("");
  const [corpusHits, setCorpusHits] = useState<{ hits: any[]; mode: string; note: string; signals: any[] } | null>(null);
  const corpusFileRef = useRef<HTMLInputElement>(null);

  async function loadCorpusStats() {
    try {
      const r = await fetch("/api/corpus");
      setCorpusStats(await r.json());
    } catch { setCorpusStats(null); }
  }

  // Ingestion is chunked: a dump can be tens of megabytes, and one giant request body
  // is what makes a serverless deploy reject the whole thing.
  async function ingestCorpusText() {
    const name = corpusName.trim();
    if (!name) { setCorpusMsg("name the corpus first — provenance is part of the evidence"); return; }
    if (!corpusText.trim()) { setCorpusMsg("nothing to ingest"); return; }
    setCorpusBusy(true);
    setCorpusMsg("ingesting…");
    try {
      const structured = /^\s*[[{]/.test(corpusText);
      // structured files must go whole (they are one document); line dumps are chunked
      const chunks: string[] = [];
      if (structured) chunks.push(corpusText);
      else {
        const lines = corpusText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 4000) chunks.push(lines.slice(i, i + 4000).join("\n"));
      }
      let parsed = 0, stored = 0, note = "";
      for (let i = 0; i < chunks.length; i++) {
        const res = await fetch("/api/corpus", {
          method: "POST",
          headers: { "content-type": "application/json", ...tradecraftHeaders() },
          body: JSON.stringify({ corpus: name, text: chunks[i] }),
        });
        const d = await res.json();
        if (!res.ok) { setCorpusMsg(d?.error || "ingest failed"); setCorpusBusy(false); return; }
        parsed += d.parsed || 0; stored += d.stored || 0; note = d.note || note;
        setCorpusMsg(`ingesting… ${i + 1}/${chunks.length} chunk(s), ${stored} record(s)`);
      }
      setCorpusText("");
      setCorpusMsg(`${stored} record(s) indexed from ${parsed} parsed${note ? ` · ${note}` : ""}`);
      loadCorpusStats();
    } catch {
      setCorpusMsg("ingest failed");
    } finally {
      setCorpusBusy(false);
    }
  }

  async function searchCorpusUI() {
    const q = corpusQuery.trim();
    if (!q) return;
    setCorpusBusy(true);
    setCorpusHits(null);
    try {
      const r = await fetch(`/api/corpus?q=${encodeURIComponent(q)}&limit=100`, { headers: tradecraftHeaders() });
      const d = await r.json();
      setCorpusHits({ hits: d.hits || [], mode: d.mode || "exact", note: d.note || "", signals: d.signals || [] });
      setCorpusMsg(`${d.count || 0} record(s) · ${d.mode} match`);
    } catch {
      setCorpusMsg("search failed");
    } finally {
      setCorpusBusy(false);
    }
  }

  async function deepScan() {
    if (deepRef.current) return;
    const q = seedRef.current.trim();
    if (!q) return;
    const isEmailSeed = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
    const isDomain = !isEmailSeed && !q.includes(" ") && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(q);
    const type = isDomain ? "spiderfoot" : isEmailSeed ? "holehe" : "maigret";
    deepRef.current = true; setDeepStatus(`deep scan (${type}) starting…`);
    try {
      const start = await fetch("/api/job", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, target: q }) });
      const sd = await start.json();
      if (!sd.configured) { setDeepStatus("deep scan needs the collector worker (COLLECTOR_URL)"); return; }
      if (!sd.jobId) { setDeepStatus("could not start deep scan"); return; }
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const pr = await fetch(`/api/job?id=${encodeURIComponent(sd.jobId)}&target=${encodeURIComponent(q)}`);
        const pd = await pr.json();
        if (pd.status === "done") {
          if (pd.signals?.length) { mergeRef.current(pd.signals, "deep:" + normId(q), normId(q)); setDeepStatus(`deep scan done · +${pd.signals.length} (${pd.elapsed}s)`); }
          else setDeepStatus(`deep scan done · nothing new (${pd.elapsed}s)`);
          break;
        }
        if (pd.status === "error" || pd.status === "not_found") { setDeepStatus("deep scan failed"); break; }
        setDeepStatus(`deep scan (${type}) running… ${Math.round(pd.elapsed || i * 4)}s`);
      }
    } catch {
      setDeepStatus("deep scan error");
    } finally {
      deepRef.current = false;
      setTimeout(() => setDeepStatus(null), 6000);
    }
  }

  async function synthesizeDossier() {
    if (llmBusy) return;
    setLlmBusy(true); setNarrative(null); setVerification(null);
    try {
      const res = await fetch("/api/synthesize", {
        method: "POST", headers: { "content-type": "application/json", ...cfgHeaders(), ...tradecraftHeaders() },
        body: JSON.stringify({ signals: currentSignals() }),
      });
      const data = await res.json();
      if (!data.configured) { setNarrative("⚙ LLM not configured — set LLM_API_URL and LLM_MODEL (Ollama / Groq / OpenRouter…) as Vercel env vars."); return; }
      setNarrative(data.narrative || "no narrative returned.");
      setVerification(data.verification || null);
    } catch {
      setNarrative("LLM request failed.");
    } finally {
      setLlmBusy(false);
    }
  }

  useEffect(() => { focusRef.current = focusId; }, [focusId]);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(BUILTIN_APPS.map((a) => a.id)));
  const builtinOn = [...enabled].filter((id) => BUILTIN_APPS.some((a) => a.id === id)).length;
  const enabledRef = useRef(enabled);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { migrateLegacyStorage(); listCases().then(setCases).catch(() => {}); setEnabled(loadEnabled()); setSettings(loadSettings()); }, []);

  function updateSettings(patch: Partial<OctopusSettings>) {
    setSettings((s) => { const n = { ...s, ...patch }; saveSettings(n); return n; });
  }

  async function ping(service: string) {
    setPings((p) => ({ ...p, [service]: "loading" }));
    try {
      // the proxy is not part of the key config, but the Tor test needs it
      const cfg = { ...toClientConfig(settings), proxy: settings.proxy || "" };
      const res = await fetch("/api/ping", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service, cfg }) });
      const d = await res.json();
      setPings((p) => ({ ...p, [service]: { ok: !!d.ok, detail: String(d.detail || "") } }));
    } catch {
      setPings((p) => ({ ...p, [service]: { ok: false, detail: "network error" } }));
    }
  }

  // LLM investigative assistant: reads the current graph, proposes a conclusion, the
  // next pivots to chase, and suspected false positives. Grounded + verified.
  async function runAssist() {
    if (assistBusy) return;
    const sigs = currentSignals();
    if (!sigs.length) { flashMsg("scan something first, then ask the assistant"); return; }
    setAssistBusy(true); setAssist(null); setAssistVerdict(null); setRail(null);
    try {
      const res = await fetch("/api/assist", { method: "POST", headers: { "content-type": "application/json", ...cfgHeaders(), ...tradecraftHeaders() }, body: JSON.stringify({ signals: sigs }) });
      const d = await res.json();
      if (!d.configured) { setAssist({ conclusion: "LLM not configured. Open API (top-right) and set a provider + key — free options: OpenRouter, z.ai, Qwen.", pivots: [], falsePositives: [], uncertainties: [], confidence: "low" }); return; }
      if (d.error || !d.result) { flashMsg(d.error || "assistant failed"); return; }
      setAssist(d.result); setAssistVerdict(d.verification || null);
    } catch {
      flashMsg("network unavailable");
    } finally {
      setAssistBusy(false);
    }
  }

  // chase a pivot the assistant proposed: scan it and merge the leads onto the board
  async function chasePivot(query: string) {
    if (scanning) return;
    setScanning(true); setScanMsg(`chasing ${query}…`);
    try {
      const cids = [...enabledRef.current].join(",");
      const res = await fetch(`/api/scan?username=${encodeURIComponent(query)}&connectors=${encodeURIComponent(cids)}`, { headers: { ...cfgHeaders(), ...tradecraftHeaders() } });
      const data = await res.json().catch(() => null);
      const added = data?.signals?.length ? mergeRef.current(data.signals, "assist:" + normId(query), normId(query)) : 0;
      setScanMsg(added ? `+${added} from ${query}` : "nothing new");
    } catch { setScanMsg("network unavailable"); } finally { setScanning(false); setTimeout(() => setScanMsg(null), 4000); }
  }

  // select a node the assistant flagged as a likely false positive, by its handle
  function selectByHandle(h: string) {
    const n = nodesRef.current.find((x) => x.handle.toLowerCase() === h.toLowerCase() || x.handle.replace(/^[@]|^u\//, "").toLowerCase() === h.replace(/^[@]/, "").toLowerCase());
    if (n) setSelectedId(n.id); else flashMsg(`"${h}" not on the board`);
  }
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  function toggleApp(id: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveEnabled(next);
      return next;
    });
  }

  function openTool(app: AppDef) {
    const s = encodeURIComponent(seedRef.current.trim());
    const url = app.url ? app.url.replace(/\{seed\}/g, s) : "#";
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openAddForm(via?: string, platform?: string) {
    setAddForm({ platform: platform || "", handle: "", url: "", via: via || "", note: "", screenshot: "", displayName: "", bio: "", location: "", email: "", avatar: "" });
    setRail(null);
  }

  // Capture a manually-found account/fact and run it through the SAME correlation
  // engine as automated collection — links by handle/name/email/avatar, mines the
  // pasted bio for identifiers, geocodes a location. Falls back to a bare local node
  // if the correlation route is unreachable.
  async function submitAdd() {
    if (!addForm || capturing) return;
    const platform = addForm.platform.trim();
    const handle = addForm.handle.trim();
    if (!platform || !handle) { flashMsg("platform & handle required"); return; }
    setCapturing(true);
    try {
      const res = await fetch("/api/correlate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: {
            platform, handle, url: addForm.url.trim(), via: addForm.via.trim(),
            note: addForm.note.trim(), screenshot: addForm.screenshot.trim(),
            displayName: addForm.displayName.trim(), bio: addForm.bio.trim(),
            location: addForm.location.trim(), email: addForm.email.trim(), avatar: addForm.avatar.trim(),
          },
          signals: currentSignals(),
          seed: seedRef.current.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.manual) { flashMsg(data?.error || "capture failed"); return; }
      ingestRef.current(data.manual as Signal, (data.extracted || []) as Signal[], (data.links || []) as [string, string][]);
      setAddForm(null);
      flashMsg(data.summary || "evidence captured");
    } catch {
      // offline fallback: at least record the node with custody, no correlation
      const now = new Date().toISOString();
      const key = (handle.replace(/^u\//, "") + platform).toLowerCase().replace(/[^a-z0-9]/g, "");
      addNodeRef.current({
        id: "manual:" + key, platform: platform.toUpperCase(), handle,
        disc: (platform.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "MN").toUpperCase(),
        confidence: 55, status: "review", collectedAt: now, url: addForm.url.trim() || undefined,
        evidence: [{ name: "Analyst-captured", detail: "Added by the analyst (correlation offline).", source: "manual capture", weight: 60 }],
      });
      setAddForm(null);
      flashMsg("captured (offline · no correlation)");
    } finally {
      setCapturing(false);
    }
  }

  function flashMsg(m: string) { setScanMsg(m); setTimeout(() => setScanMsg(null), 3000); }

  // Face recognition: match the SAME PERSON across DIFFERENT photos (not just the same
  // file). Runs in the browser via a face-embedding model; adds "Matching face" links.
  const [faceBusy, setFaceBusy] = useState(false);
  async function faceMatch() {
    if (faceBusy) return;
    const items = currentSignals().filter((s) => s.avatarUrl).map((s) => ({ id: s.id, url: s.avatarUrl! }));
    if (items.length < 2) { flashMsg("need ≥2 nodes with a photo for face matching"); return; }
    setFaceBusy(true); setScanMsg("loading face model…");
    try {
      const { ensureFaceModels, matchFaces } = await import("@/lib/face");
      const ok = await ensureFaceModels();
      if (!ok) { setScanMsg("face model missing — run: npm run fetch-face-models"); return; }
      const { matches, described, scanned, mismatches } = await matchFaces(items, (d, t) => setScanMsg(`analysing faces ${d}/${t}…`));
      let applied = 0;
      for (const m of matches) {
        const A = nodesRef.current.find((n) => n.id === m.a);
        const B = nodesRef.current.find((n) => n.id === m.b);
        if (!A || !B) continue;
        const detail = `Same face as ${B.platform} / ${A.platform} (descriptor distance ${m.distance.toFixed(2)}).`;
        const ev = { name: m.strong ? "Matching face" : "Near-match face", detail, source: "face recognition · local model", weight: m.strong ? 90 : 74 };
        A.evidence = [...A.evidence, ev]; B.evidence = [...B.evidence, { ...ev, detail: `Same face as ${A.platform} / ${B.platform} (descriptor distance ${m.distance.toFixed(2)}).` }];
        A.linkedIds = [...new Set([...(A.linkedIds || []), B.id])];
        B.linkedIds = [...new Set([...(B.linkedIds || []), A.id])];
        for (const N of [A, B]) { const r = scoreEvidence(N.evidence); N.tier = r.tier; N.confidence = r.confidence; }
        applied++;
      }
      // a face detected in BOTH photos that is clearly a different person is evidence
      // AGAINST the link — record it so the tier gets demoted, not silently ignored.
      let contra = 0;
      for (const m of mismatches) {
        const A = nodesRef.current.find((n) => n.id === m.a);
        const B = nodesRef.current.find((n) => n.id === m.b);
        if (!A || !B) continue;
        for (const [x, y] of [[A, B], [B, A]] as const) {
          x.evidence = [...x.evidence, {
            name: "Different face",
            detail: `A face was detected in both photos and they do not match ${y.platform} (descriptor distance ${m.distance.toFixed(2)}) — evidence against the same person.`,
            source: "face recognition · local model", weight: 72,
          }];
          const r = scoreEvidence(x.evidence); x.tier = r.tier; x.confidence = r.confidence;
        }
        contra++;
      }
      setDataVersion((v) => v + 1);
      setScanMsg(`${applied} same-face link(s)${contra ? ` · ${contra} different-face contradiction(s)` : ""} · ${described}/${scanned} faces read`);
    } catch {
      setScanMsg("face matching failed");
    } finally {
      setFaceBusy(false);
      setTimeout(() => setScanMsg(null), 6000);
    }
  }

  // On-demand image forensics: extract the maximum metadata (EXIF/GPS/camera/date) from
  // any image URL. If GPS is embedded, drop a precise location node onto the board.
  // Open a specific hidden service and harvest the selectors published on it. A
  // deliberate act, separate from the scan: it is recorded in the audit trail, and it
  // is refused outright without Tor rather than attempted over the clearnet.
  async function openOnion() {
    const url = (window.prompt("Hidden service address (.onion) — retrieve through Tor and extract identifiers:") || "").trim();
    if (!url) return;
    if (!/\.onion(\/|:|$)/i.test(url.replace(/^https?:\/\//i, ""))) { flashMsg("a .onion address is required"); return; }
    setScanMsg("retrieving through Tor…");
    try {
      const res = await fetch("/api/onion", {
        method: "POST",
        headers: { "content-type": "application/json", ...tradecraftHeaders() },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) { setScanMsg(data?.detail || data?.error || "unreachable"); return; }
      const page = data.page as { title: string; emails: string[]; onions: string[]; wallets: string[]; handles: string[]; pgp: boolean };
      for (const s of (data.signals || [])) addNodeRef.current(s);
      const found = [
        page.emails.length ? `${page.emails.length} email(s)` : "",
        page.wallets.length ? `${page.wallets.length} wallet(s)` : "",
        page.handles.length ? `${page.handles.length} handle(s)` : "",
        page.onions.length ? `${page.onions.length} linked onion(s)` : "",
        page.pgp ? "public key block" : "",
      ].filter(Boolean);
      setScanMsg(`${page.title || url} · ${found.length ? found.join(" · ") : "no identifiers published"}`);
    } catch {
      setScanMsg("network unavailable");
    }
  }

  async function imageForensics() {
    const url = (window.prompt("Image URL — extract EXIF / GPS / camera metadata:") || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { flashMsg("http(s) image url required"); return; }
    setScanMsg("reading metadata…");
    try {
      const res = await fetch(`/api/metadata?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) { setScanMsg(data?.error || "metadata read failed"); return; }
      if (!data.found) { setScanMsg("no metadata — image was stripped clean"); return; }
      const m = data.meta as { gps?: { lat: number; lon: number }; make?: string; model?: string; dateTaken?: string; software?: string };
      const parts: string[] = [];
      if (m.make || m.model) parts.push([m.make, m.model].filter(Boolean).join(" "));
      if (m.dateTaken) parts.push(m.dateTaken);
      if (m.software) parts.push(m.software);
      if (m.gps) {
        const coords = `${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}`;
        addNodeRef.current({
          id: "attr:location:" + coords.replace(/[^0-9\-]/g, ""),
          platform: "LOCATION", handle: coords, disc: "GEO", kind: "location",
          confidence: 74, tier: "probable", status: "review",
          place: { lat: m.gps.lat, lon: m.gps.lon }, // plot it on the map
          collectedAt: new Date().toISOString(),
          evidence: [
            { name: "GPS from image", detail: `Coordinates ${coords} embedded in the image EXIF — precise, not self-reported.`, source: "EXIF · exifr", weight: 88 },
            ...(parts.length ? [{ name: "Image context", detail: parts.join(" · "), source: "EXIF", weight: 45 }] : []),
          ],
        });
        setScanMsg(`GPS ${coords} → location node added` + (parts.length ? ` · ${parts.join(" · ")}` : ""));
      } else {
        setScanMsg("metadata: " + (parts.join(" · ") || "camera/date only, no GPS"));
      }
    } catch {
      setScanMsg("network unavailable");
    } finally {
      setTimeout(() => setScanMsg(null), 6000);
    }
  }

  useEffect(() => { seedRef.current = seed; }, [seed]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  const selected = useMemo(
    () => (selectedId ? nodesRef.current.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, dataVersion],
  );
  const total = nodesRef.current.length;
  const confirmedCount = nodesRef.current.filter((n) => n.status === "confirmed").length;

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;
    const bodiesEl = bodiesRef.current!;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0, cx = 0, cy = 0, baseR = 1, raf = 0;

    let root = getComputedStyle(document.documentElement);
    let cache: Record<string, string> = {};
    const cssv = (n: string) => (cache[n] ??= root.getPropertyValue(n).trim());
    const refreshCss = () => { cache = {}; root = getComputedStyle(document.documentElement); };
    const themeObs = new MutationObserver(refreshCss);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      cv.width = W * DPR; cv.height = H * DPR; cv.style.width = W + "px"; cv.style.height = H + "px";
      // the graph centres on the space it actually has: the rail owns the left edge,
      // so a naive W/2 would push the seed permanently off-centre
      const rail = parseInt(cssv("--rail-w")) || 0;
      cx = (W + rail) / 2; cy = H / 2 + 10; baseR = Math.min(W - rail, H);
      metaRef.current = { cx, cy };
    }

    function targetRadius(d: WorkNode) {
      const b = BANDS[d.status];
      const lo = b.r0 * baseR * 0.5, hi = b.r1 * baseR * 0.5;
      const t = 1 - Math.max(0, Math.min(1, d.confidence / 100));
      return lo + (hi - lo) * t;
    }

    function attachDrag(el: HTMLDivElement, d: WorkNode) {
      let ox = 0, oy = 0, px = 0, py = 0, active = false, pid = 0, moved = false;
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        active = true; draggingRef.current = d; moved = false;
        el.classList.add("drag"); pid = e.pointerId; el.setPointerCapture(pid);
        ox = e.clientX; oy = e.clientY; px = d.x; py = d.y; d.vx = 0; d.vy = 0; e.preventDefault();
        e.stopPropagation(); // do not start a canvas pan underneath
      });
      el.addEventListener("pointermove", (e) => {
        if (!active) return;
        // screen delta ÷ zoom = world delta, or the node lags the cursor when zoomed
        const mx = (e.clientX - ox) / viewRef.current.z, my = (e.clientY - oy) / viewRef.current.z;
        if (Math.abs(mx) + Math.abs(my) > 3) moved = true;
        d.x = px + mx; d.y = py + my;
      });
      const end = () => {
        if (!active) return;
        active = false; el.classList.remove("drag"); draggingRef.current = null;
        // Moving a node is a statement about where it belongs. Honour it: pin it, or
        // the springs drag it back and the arrangement was theatre.
        if (moved) { d.pinned = true; el.classList.add("pinned"); persistLayout(); }
        setTimeout(() => { moved = false; }, 40);
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("click", () => { if (!moved) setSelectedId(d.id); });
      el.addEventListener("dblclick", (e) => {
        e.preventDefault(); e.stopPropagation();
        d.pinned = !d.pinned;
        el.classList.toggle("pinned", !!d.pinned);
        persistLayout();
      });
    }

    /** Remember the arrangement with the case — it is analytic work, not decoration. */
    function persistLayout() {
      const nodes = nodesRef.current;
      const positions: Record<string, [number, number]> = {};
      const pinned: string[] = [];
      for (const n of nodes) {
        if (!n.pinned) continue;
        positions[n.id] = [Math.round(n.x - cx), Math.round(n.y - cy)];
        pinned.push(n.id);
      }
      saveLayoutRef.current({ positions, pinned, mode: modeRef.current });
    }

    /** Re-apply a saved arrangement after a rebuild. */
    function restoreLayout() {
      const l = readLayoutRef.current();
      if (!l) return;
      modeRef.current = l.mode || "orbit";
      const pins = new Set(l.pinned || []);
      for (const n of nodesRef.current) {
        const p = l.positions?.[n.id];
        if (p) { n.x = cx + p[0]; n.y = cy + p[1]; n.op = 1; }
        if (pins.has(n.id)) {
          n.pinned = true;
          elsRef.current[n.id]?.classList.add("pinned");
        }
      }
    }

    function makeEl(d: WorkNode) {
      const el = document.createElement("div");
      el.className = "body";
      el.dataset.kind = d.kind || "platform";
      const discContent = d.kind === "email" ? "✉" : d.kind === "alias" ? "~" : d.kind === "phone" ? "☎" : d.kind === "location" ? "⌖" : d.kind === "leak" ? "⚠" : d.kind === "person" ? "◆" : d.kind === "org" ? "▣" : d.kind === "domain" ? "◇" : d.disc;
      el.innerHTML = `<div class="disc">${discContent}</div><div class="tag">${escapeHtml(d.handle)}</div><div class="conf">${d.confidence}%</div>`;
      bodiesEl.appendChild(el);
      // a node announces its arrival once — on a graph that grows while you work, this
      // is what tells you something appeared without you having to diff the screen
      el.classList.add("spawn");
      setTimeout(() => el.classList.remove("spawn"), 600);
      elsRef.current[d.id] = el;
      attachDrag(el, d);
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: d.id }); });
      return el;
    }

    function rebuild(sigs: Signal[], spawn = false) {
      const nodes: WorkNode[] = sigs.map((s, i) => {
        const a = -Math.PI / 2 + i * ((2 * Math.PI) / Math.max(1, sigs.length));
        const edge = spawn ? Math.max(W, H) * 0.7 : 300;
        return { ...s, a, x: cx + Math.cos(a) * edge, y: cy + Math.sin(a) * edge, vx: 0, vy: 0, op: spawn ? 0 : 1 };
      });
      nodesRef.current = nodes;
      elsRef.current = {};
      bodiesEl.innerHTML = "";
      nodes.forEach((d, i) => {
        makeEl(d);
        if (spawn) setTimeout(() => { const a = Math.random() * Math.PI * 2; const edge = Math.max(W, H) * 0.7; d.x = cx + Math.cos(a) * edge; d.y = cy + Math.sin(a) * edge; d.op = 0; }, i * 110);
      });
      restoreLayout();
      setSelectedId(null);
      setDataVersion((v) => v + 1);
    }
    rebuildRef.current = rebuild;

    // append a single node into the live sim (used by "add presence")
    function addNode(s: Signal) {
      if (suppressedRef.current.has(s.id)) return; // analyst rejected/removed it
      if (nodesRef.current.some((n) => n.id === s.id)) return; // no dup
      const a = Math.random() * Math.PI * 2;
      const edge = Math.max(W, H) * 0.7;
      const d: WorkNode = { ...s, a, x: cx + Math.cos(a) * edge, y: cy + Math.sin(a) * edge, vx: 0, vy: 0, op: 0 };
      nodesRef.current.push(d);
      makeEl(d);
      setDataVersion((v) => v + 1);
      setSelectedId(s.id);
    }
    addNodeRef.current = addNode;

    // ingest a correlated manual capture: add the node + any extracted identifier
    // nodes, then apply the correlation links (same linkedIds the engine uses)
    function ingestCorrelation(manual: Signal, extracted: Signal[], links: [string, string][]) {
      const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
      const spawnNear = (s: Signal, near?: WorkNode) => {
        if (byId.has(s.id) || suppressedRef.current.has(s.id)) return;
        const ang = Math.random() * Math.PI * 2, r = 60 + Math.random() * 40;
        const ox = near ? near.x : cx, oy = near ? near.y : cy;
        const d: WorkNode = { ...s, a: ang, x: ox + Math.cos(ang) * r, y: oy + Math.sin(ang) * r, vx: 0, vy: 0, op: 0 };
        nodesRef.current.push(d); byId.set(d.id, d); makeEl(d);
      };
      spawnNear(manual);
      const mNode = byId.get(manual.id);
      for (const e of extracted) spawnNear(e, mNode);
      for (const [a, b] of links) {
        const A = byId.get(a), B = byId.get(b);
        if (!A || !B || a === b) continue;
        A.linkedIds = A.linkedIds || []; B.linkedIds = B.linkedIds || [];
        if (!A.linkedIds.includes(b)) A.linkedIds.push(b);
        if (!B.linkedIds.includes(a)) B.linkedIds.push(a);
      }
      setDataVersion((v) => v + 1);
      setSelectedId(manual.id);
    }
    ingestRef.current = ingestCorrelation;

    // merge a rescan's results into the live board, linked to the pivoted node
    function mergeNodes(sigs: Signal[], originId: string, qkey: string) {
      const nk = (s: { platform: string; handle: string }) =>
        s.platform.toLowerCase().replace(/[^a-z0-9]/g, "") + "|" + s.handle.replace(/^u\//, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
      const byKey = new Map(nodesRef.current.map((n) => [nk(n), n]));
      const remap: Record<string, string> = {};
      for (const s of sigs) {
        const k = nk(s);
        remap[s.id] = byKey.has(k) ? byKey.get(k)!.id : "pv:" + qkey + ":" + s.id;
      }
      const link = (aId: string, bId: string) => {
        const A = byId.get(aId), B = byId.get(bId);
        if (!A || !B || aId === bId) return;
        A.linkedIds = A.linkedIds || []; B.linkedIds = B.linkedIds || [];
        if (!A.linkedIds.includes(bId)) A.linkedIds.push(bId);
        if (!B.linkedIds.includes(aId)) B.linkedIds.push(aId);
      };
      const origin = byId.get(originId);
      const ox = origin ? origin.x : cx, oy = origin ? origin.y : cy;
      let added = 0;
      for (const s of sigs) {
        const fid = remap[s.id];
        if (suppressedRef.current.has(fid) || suppressedRef.current.has(s.id)) continue; // rejected/removed
        if (!byId.has(fid)) {
          const ang = Math.random() * Math.PI * 2, r = 55 + Math.random() * 45;
          const d: WorkNode = {
            ...s, id: fid, linkedIds: (s.linkedIds || []).map((x) => remap[x] || x),
            a: ang, x: ox + Math.cos(ang) * r, y: oy + Math.sin(ang) * r, vx: 0, vy: 0, op: 0,
          };
          nodesRef.current.push(d); byId.set(fid, d); makeEl(d); added++;
        }
        link(originId, fid);
        for (const lid of s.linkedIds || []) link(fid, remap[lid] || lid);
      }
      setDataVersion((v) => v + 1);
      return added;
    }
    mergeRef.current = mergeNodes;

    function removeNode(id: string) {
      const i = nodesRef.current.findIndex((n) => n.id === id);
      if (i < 0) return;
      nodesRef.current.splice(i, 1);
      const el = elsRef.current[id];
      if (el) { el.remove(); delete elsRef.current[id]; }
      setSelectedId((cur) => (cur === id ? null : cur));
      setDataVersion((v) => v + 1);
      // remembering the removal: never propose it again on this seed
      suppressedRef.current.add(id);
      const seed = seedRef.current.trim();
      if (seed) saveDecision(seed, id, "removed").catch(() => {});
    }
    removeNodeRef.current = removeNode;

    /**
     * Where a node wants to sit, per layout mode. Orbit is the honest default —
     * distance from the seed IS the confidence, so the picture cannot lie about it.
     * The others trade that reading for a different one, and say so in the legend.
     */
    function anchorFor(d: WorkNode, groups: Map<string, number>, groupCount: number): { ax: number; ay: number; k: number } | null {
      const mode = modeRef.current;
      if (mode === "free") return null;
      if (mode === "orbit") return null; // handled by the radial spring below
      const key = mode === "cluster"
        ? (d.clusterId || "unclustered")
        : (d.kind || "platform");
      const idx = groups.get(key) ?? 0;
      const ang = -Math.PI / 2 + (idx / Math.max(1, groupCount)) * Math.PI * 2;
      const r = baseR * 0.26;
      return { ax: cx + Math.cos(ang) * r, ay: cy + Math.sin(ang) * r, k: 0.014 };
    }

    function step() {
      const nodes = nodesRef.current;
      const K_RAD = 0.02, K_REP = 1400, DAMP = 0.86;
      const mode = modeRef.current;

      // group index, recomputed per frame: cheap for graph-sized data, and always
      // correct after a node arrives or is re-clustered
      const groups = new Map<string, number>();
      if (mode === "cluster" || mode === "type") {
        for (const n of nodes) {
          const key = mode === "cluster" ? (n.clusterId || "unclustered") : (n.kind || "platform");
          if (!groups.has(key)) groups.set(key, groups.size);
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        const d = nodes[i];
        if (d === draggingRef.current) continue;
        // a pinned node stays exactly where it was put — that is the whole contract
        if (d.pinned) { if (d.op < 1) d.op = Math.min(1, d.op + 0.02); continue; }

        let fx = 0, fy = 0;
        const anchor = anchorFor(d, groups, groups.size);
        if (anchor) {
          fx += (anchor.ax - d.x) * anchor.k;
          fy += (anchor.ay - d.y) * anchor.k;
        } else if (mode === "orbit") {
          const dx = d.x - cx, dy = d.y - cy, dist = Math.hypot(dx, dy) || 0.001;
          const f = (targetRadius(d) - dist) * K_RAD;
          fx += (dx / dist) * f; fy += (dy / dist) * f;
        }

        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const o = nodes[j];
          const rx = d.x - o.x, ry = d.y - o.y, r2 = rx * rx + ry * ry + 40;
          const rf = K_REP / r2, rd = Math.sqrt(r2);
          fx += (rx / rd) * rf; fy += (ry / rd) * rf;
        }
        d.vx = (d.vx + fx) * DAMP; d.vy = (d.vy + fy) * DAMP;
        const sp = Math.hypot(d.vx, d.vy); if (sp > 7) { d.vx *= 7 / sp; d.vy *= 7 / sp; }
        d.x += d.vx; d.y += d.vy;
        if (d.op < 1) d.op = Math.min(1, d.op + 0.02);
      }
      draw();
      raf = requestAnimationFrame(step);
    }

    function draw() {
      const nodes = nodesRef.current;
      const v = viewRef.current;
      // one transform for both layers: the canvas gets it in the matrix, the DOM node
      // layer gets the identical CSS transform, so they can never drift apart
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(DPR * v.z, 0, 0, DPR * v.z, DPR * v.x, DPR * v.y);
      bodiesEl.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
      const selId = selectedRef.current;
      // focus mode: dim everything not linked to the focused node
      let keep: Set<string> | null = null;
      if (focusRef.current) {
        const fn = nodes.find((n) => n.id === focusRef.current);
        keep = new Set([focusRef.current, ...(fn?.linkedIds || [])]);
      }
      const dim = (id: string) => (keep && !keep.has(id) ? 0.1 : 1);
      BAND_ORDER.forEach((k) => {
        const b = BANDS[k];
        const rMid = ((b.r0 + b.r1) / 2) * baseR * 0.5;
        ctx.beginPath(); ctx.arc(cx, cy, rMid, 0, Math.PI * 2);
        ctx.strokeStyle = cssv("--line-soft"); ctx.lineWidth = 1; ctx.setLineDash([2, 7]); ctx.stroke(); ctx.setLineDash([]);
      });
      nodes.forEach((d) => {
        let col: string, w: number, alpha: number;
        if (d.status === "confirmed") { col = cssv("--confirm"); w = 1.2; alpha = 0.55; }
        else if (d.status === "rejected") { col = cssv("--reject"); w = 1; alpha = 0.14; }
        else if (d.id === selId) { col = cssv("--accent"); w = 1.2; alpha = 0.6; }
        else { col = cssv("--ink-3"); w = 1; alpha = 0.3; }
        ctx.globalAlpha = alpha * d.op * dim(d.id);
        const mx = (cx + d.x) / 2, my = (cy + d.y) / 2;
        const nx = d.y - cy, ny = cx - d.x, nl = Math.hypot(nx, ny) || 1, bend = 14;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(mx + (nx / nl) * bend, my + (ny / nl) * bend, d.x, d.y);
        ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.setLineDash(d.status === "candidate" ? [1, 5] : []);
        ctx.stroke(); ctx.setLineDash([]);
      });
      // inter-node edges: declared / verified cross-links between accounts
      const byId: Record<string, WorkNode> = {};
      nodes.forEach((n) => (byId[n.id] = n));
      nodes.forEach((d) => {
        if (!d.linkedIds) return;
        d.linkedIds.forEach((lid) => {
          if (d.id >= lid) return; // draw each pair once
          const e = byId[lid];
          if (!e) return;
          ctx.globalAlpha = 0.5 * Math.min(d.op, e.op) * Math.min(dim(d.id), dim(e.id));
          const mx = (d.x + e.x) / 2, my = (d.y + e.y) / 2;
          const nx = e.y - d.y, ny = d.x - e.x, nl = Math.hypot(nx, ny) || 1, bend = 18;
          ctx.beginPath(); ctx.moveTo(d.x, d.y);
          ctx.quadraticCurveTo(mx + (nx / nl) * bend, my + (ny / nl) * bend, e.x, e.y);
          ctx.strokeStyle = cssv("--accent"); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
          ctx.stroke(); ctx.setLineDash([]);
        });
      });
      // relationship edges (network: follows / member / mention) — deliberately
      // muted and differently dashed so "who they know" never reads as "same person"
      nodes.forEach((d) => {
        if (!d.relations) return;
        d.relations.forEach((rel) => {
          const e = byId[rel.to];
          if (!e) return;
          ctx.globalAlpha = 0.28 * Math.min(d.op, e.op) * Math.min(dim(d.id), dim(e.id));
          ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(e.x, e.y);
          ctx.strokeStyle = cssv("--ink-3"); ctx.lineWidth = 0.8; ctx.setLineDash([1, 4]);
          ctx.stroke(); ctx.setLineDash([]);
        });
      });
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fillStyle = cssv("--accent"); ctx.fill();
      ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.strokeStyle = cssv("--accent"); ctx.lineWidth = 1; ctx.stroke();
      ctx.globalAlpha = 0.12; ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = cssv("--ink-2"); ctx.font = "9px ui-monospace, monospace"; ctx.textAlign = "center";
      ctx.fillText("SEED", cx, cy + 44);
      ctx.fillStyle = cssv("--accent"); ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(seedRef.current || "—", cx, cy - 38);
      nodes.forEach((d) => {
        const el = elsRef.current[d.id];
        if (!el) return;
        el.style.left = d.x + "px"; el.style.top = d.y + "px"; el.style.opacity = String(d.op * dim(d.id));
        el.classList.toggle("confirmed", d.status === "confirmed");
        el.classList.toggle("rejected", d.status === "rejected");
        el.classList.toggle("sel", d.id === selId);
      });
    }

    // ---- viewport: wheel to zoom about the cursor, drag the void to pan ----
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const z = Math.max(0.25, Math.min(3, v.z * factor));
      // keep the point under the cursor fixed — anything else feels broken
      v.x = e.clientX - ((e.clientX - v.x) * z) / v.z;
      v.y = e.clientY - ((e.clientY - v.y) * z) / v.z;
      v.z = z;
    }

    let panning = false, pox = 0, poy = 0, pvx = 0, pvy = 0;
    function onDown(e: PointerEvent) {
      if (e.button !== 0) return;
      panning = true; pox = e.clientX; poy = e.clientY;
      pvx = viewRef.current.x; pvy = viewRef.current.y;
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = "grabbing";
    }
    function onMove(e: PointerEvent) {
      if (!panning) return;
      viewRef.current.x = pvx + (e.clientX - pox);
      viewRef.current.y = pvy + (e.clientY - poy);
    }
    function onUp() { panning = false; cv.style.cursor = ""; }

    /** Frame everything currently on the graph. */
    function fit() {
      const nodes = nodesRef.current;
      const v = viewRef.current;
      if (!nodes.length) { v.x = 0; v.y = 0; v.z = 1; return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
      const pad = 90;
      const rail = parseInt(cssv("--rail-w")) || 0;
      const availW = W - rail - pad * 2, availH = H - 120 - pad;
      const z = Math.max(0.25, Math.min(2, Math.min(availW / Math.max(1, x1 - x0), availH / Math.max(1, y1 - y0))));
      v.z = z;
      v.x = rail + pad + availW / 2 - ((x0 + x1) / 2) * z;
      v.y = 90 + availH / 2 - ((y0 + y1) / 2) * z;
    }
    fitRef.current = fit;
    layoutRef.current = (m: OrbitMode) => {
      modeRef.current = m;
      // switching layout releases the springs but never the analyst's own pins
      for (const n of nodesRef.current) { n.vx = 0; n.vy = 0; }
      persistLayout();
    };

    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);

    resize();
    rebuild(SIGNALS, false);
    step();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onUp);
      themeObs.disconnect();
      bodiesEl.innerHTML = "";
    };
  }, []);

  function escapeHtml(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  }

  function setStatus(id: string, status: Status) {
    const n = nodesRef.current.find((x) => x.id === id);
    if (!n) return;
    n.status = status;
    setDataVersion((v) => v + 1);
    // feedback loop: remember this judgment for the current seed so re-scans respect it
    const seed = seedRef.current.trim();
    if (seed) saveDecision(seed, id, status).catch(() => {});
    // rejecting = don't propose again (this session's merges skip it too)
    if (status === "rejected") suppressedRef.current.add(id);
    // confirming a lead = follow it: chain the investigation onto its new identifiers
    if (status === "confirmed") chainFromNode(n);
  }

  // OSINT chaining: confirming a node means "this is really them" — so take the NEW
  // identifiers it exposes (a different username, a real name, a linked email/alias)
  // and search from those, merging the leads onto the confirmed node. This is how an
  // investigation walks from one fact to the next instead of staying on the seed.
  async function chainFromNode(node: WorkNode) {
    if (scanning) return;
    const seedN = normId(seedRef.current.trim());
    const queries: { q: string; why: string }[] = [];
    const handle = node.handle.replace(/^@/, "").replace(/^u\//, "").trim();
    if (handle && normId(handle) !== seedN && !chainedRef.current.has("h:" + normId(handle))) {
      queries.push({ q: handle, why: `username ${node.handle}` });
    }
    if (node.displayName && looksLikeName(node.displayName) && !chainedRef.current.has("n:" + normId(node.displayName))) {
      queries.push({ q: node.displayName, why: `name "${node.displayName}"` });
    }
    for (const lid of node.linkedIds || []) {
      const ln = nodesRef.current.find((x) => x.id === lid);
      if (ln && (ln.kind === "email" || ln.kind === "alias")) {
        const q = ln.handle.replace(/^@/, "").trim();
        if (q && !chainedRef.current.has("x:" + normId(q))) queries.push({ q, why: `${ln.kind} ${ln.handle}` });
      }
    }
    const pick = queries.slice(0, 2);
    if (!pick.length) return;
    setScanning(true); setScanMsg(`chaining from ${node.handle}: ${pick.map((p) => p.why).join(", ")}…`);
    let added = 0;
    try {
      const cids = [...enabledRef.current].join(",");
      for (const { q } of pick) {
        chainedRef.current.add("h:" + normId(q)); chainedRef.current.add("n:" + normId(q)); chainedRef.current.add("x:" + normId(q));
        const res = await fetch(`/api/scan?username=${encodeURIComponent(q)}&connectors=${encodeURIComponent(cids)}`, { headers: { ...cfgHeaders(), ...tradecraftHeaders() } });
        const data = await res.json().catch(() => null);
        if (data?.signals?.length) added += mergeRef.current(data.signals, node.id, normId(q));
      }
      setScanMsg(added ? `chained ${pick.length} lead(s) → +${added} new node(s) to review` : "chain: nothing new found");
    } catch {
      setScanMsg("network unavailable");
    } finally {
      setScanning(false);
      setTimeout(() => setScanMsg(null), 5000);
    }
  }

  function clearDemoState() {
    if (demoRef.current) { demoRef.current = false; setIsDemo(false); }
  }

  async function runScan() {
    const u = seedRef.current.trim();
    if (!u || scanning) return;
    // A scan is a FRESH investigation of the seed. If the board still holds the demo,
    // or we're now targeting a different seed, wipe it first so nothing stale (the demo
    // "john_doe", or a previous target) mixes into — or gets auto-expanded from — the
    // new results. Re-scanning the SAME seed keeps the board on empty/error.
    if (shouldWipeBeforeScan(demoRef.current, u, lastScanRef.current)) { rebuildRef.current([], false); clearDemoState(); }
    setScanning(true); setScanMsg("scanning…");
    try {
      const cids = [...enabledRef.current].join(",");
      const res = await fetch(`/api/scan?username=${encodeURIComponent(u)}&connectors=${encodeURIComponent(cids)}`, { headers: { ...cfgHeaders(), ...tradecraftHeaders() } });
      const data = await res.json();
      if (!res.ok) { setScanMsg(data?.error || "scan failed"); return; }
      lastScanRef.current = u;
      loadBoardFor(u); // each investigation carries its own board
      if (!data.signals?.length) { setScanMsg("no public presence found"); return; }
      // feedback loop: drop what the analyst rejected/removed, re-apply confirmations
      let suppressed = 0;
      let sigs = data.signals as Signal[];
      try {
        const dec = await loadDecisions(u);
        suppressedRef.current = suppressedIds(dec);
        const r = applyDecisionsFiltered(sigs, dec);
        sigs = r.signals; suppressed = r.suppressed;
      } catch { /* none */ }
      rebuildRef.current(sigs, true);
      // honesty: if a source rate-limited us it did NOT say "no account" — say so,
      // otherwise the analyst reads an incomplete scan as a negative result.
      const warn = data?.health?.note ? ` · ⚠ ${data.health.note}` : "";
      // darkweb coverage is always partial — the caveat travels with the result, so a
      // quiet onion search is never mistaken for "nothing on the darkweb".
      const dw = data?.darkweb?.note ? ` · onion: ${data.darkweb.note}` : "";
      setScanMsg(`${sigs.length} real presence(s)` + (suppressed ? ` · ${suppressed} suppressed (your prior decisions)` : "") + warn + dw);
    } catch {
      setScanMsg("network unavailable");
    } finally {
      setScanning(false);
      setTimeout(() => setScanMsg(null), 4000);
    }
  }

  function openDossier() {
    setDossier(buildDossier(currentSignals()));
  }

  // Monitoring: re-scan the seed and diff against the current board — what appeared,
  // vanished, or changed since. Turns a one-shot recon into an investigation over time.
  async function runMonitor() {
    const u = seedRef.current.trim();
    const before = currentSignals();
    if (!u || monitoring || !before.length) { if (!before.length) flashMsg("scan first, then monitor for changes"); return; }
    setMonitoring(true); setScanMsg("monitoring · re-scanning…");
    try {
      const cids = [...enabledRef.current].join(",");
      const res = await fetch(`/api/scan?username=${encodeURIComponent(u)}&connectors=${encodeURIComponent(cids)}`, { headers: { ...cfgHeaders(), ...tradecraftHeaders() } });
      const data = await res.json();
      if (!res.ok || !data.signals) { setScanMsg("monitor scan failed"); return; }
      let sigs = data.signals as Signal[];
      try { const dec = await loadDecisions(u); suppressedRef.current = suppressedIds(dec); sigs = applyDecisionsFiltered(sigs, dec).signals; } catch { /* none */ }
      const diff = diffSnapshots(before, sigs);
      setMonitor(diff);
      rebuildRef.current(sigs, false); // adopt the fresh state as current
      setScanMsg(diff.summary);
    } catch {
      setScanMsg("network unavailable");
    } finally {
      setMonitoring(false);
      setTimeout(() => setScanMsg(null), 5000);
    }
  }

  function dossierBlock(label: string, items: string[]) {
    return (
      <div className="dossier-block">
        <div className="db-label">{label} ({items.length})</div>
        {items.length === 0 ? <div className="db-empty">—</div> : items.map((v, i) => <div className="db-item" key={i}>{v}</div>)}
      </div>
    );
  }

  async function investigate() {
    if (scanning) return;
    await runScan();
    // one automated expansion from a discovered identifier, then synthesize
    const pivotable = nodesRef.current.find((n) => n.kind === "email" || n.kind === "alias");
    if (pivotable) await autoExpand(pivotable);
    setDossier(buildDossier(currentSignals()));
  }

  async function pivotOn(node: Signal) {
    // pivot query: the email value, or the handle stripped of @ / u/
    const q = node.handle.replace(/^@/, "").replace(/^u\//, "").trim();
    if (!q || scanning) return;
    setScanning(true); setScanMsg(`pivoting on ${q}…`);
    try {
      const cids = [...enabledRef.current].join(",");
      const res = await fetch(`/api/scan?username=${encodeURIComponent(q)}&connectors=${encodeURIComponent(cids)}`, { headers: { ...cfgHeaders(), ...tradecraftHeaders() } });
      const data = await res.json();
      if (!res.ok || !data.signals?.length) { setScanMsg("nothing new to pivot"); return; }
      mergeRef.current(data.signals, node.id, normId(q));
      setScanMsg(`+ hop from ${q} (${data.signals.length})`);
    } catch {
      setScanMsg("network unavailable");
    } finally {
      setScanning(false);
      setTimeout(() => setScanMsg(null), 4000);
    }
  }

  async function autoExpand(startNode: Signal) {
    if (scanning) return;
    const MAX_HOPS = 2, CAP = 40, BREADTH = 5;
    const visited = new Set<string>();
    const scanOne = async (q: string, originId: string): Promise<number> => {
      const cids = [...enabledRef.current].join(",");
      const res = await fetch(`/api/scan?username=${encodeURIComponent(q)}&connectors=${encodeURIComponent(cids)}`, { headers: { ...cfgHeaders(), ...tradecraftHeaders() } });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.signals?.length) return 0;
      return mergeRef.current(data.signals, originId, normId(q));
    };
    setScanning(true);
    try {
      let frontier = [{ id: startNode.id, q: startNode.handle.replace(/^@/, "").replace(/^u\//, "").trim() }];
      let total = 0;
      for (let hop = 1; hop <= MAX_HOPS && total < CAP; hop++) {
        setScanMsg(`auto-expand · hop ${hop}…`);
        for (const f of frontier) {
          if (total >= CAP) break;
          const qk = normId(f.q);
          if (!f.q || visited.has(qk)) continue;
          visited.add(qk);
          total += await scanOne(f.q, f.id);
        }
        // next hop: rank the newly discovered identifiers by INVESTIGATIVE VALUE, so
        // the scan budget goes to what actually advances the case (an email opens
        // breach + account lookups; a rare handle is far more identifying than a
        // common one; a contradicted node is a dead end).
        frontier = nodesRef.current
          .filter((n) => n.kind === "email" || n.kind === "alias")
          .map((n) => {
            const q = n.handle.replace(/^@/, "").trim();
            const rarity = handleRarity(q).score;
            const kindWeight = n.kind === "email" ? 1.0 : 0.55;       // an email unlocks more
            const tierWeight = n.tier === "verified" ? 1.0 : n.tier === "probable" ? 0.85
              : n.tier === "contradicted" ? 0.1 : n.tier === "weak" ? 0.4 : 0.6;
            const statusWeight = n.status === "confirmed" ? 1.15 : n.status === "rejected" ? 0 : 1;
            return { id: n.id, q, score: kindWeight * tierWeight * statusWeight * (0.45 + rarity) };
          })
          .filter((f) => f.q && f.score > 0 && !visited.has(normId(f.q)))
          .sort((a, b) => b.score - a.score)
          .slice(0, BREADTH);
        if (!frontier.length) break;
      }
      setScanMsg(`auto-expand done · +${total}`);
    } catch {
      setScanMsg("network unavailable");
    } finally {
      setScanning(false);
      setTimeout(() => setScanMsg(null), 4000);
    }
  }

  function currentSignals(): Signal[] {
    return nodesRef.current.map((n) => {
      const { x, y, vx, vy, op, a, ...s } = n; // strip physics fields
      return s;
    });
  }

  async function saveCurrent() {
    const sigs = currentSignals();
    if (!sigs.length) return;
    const s = seedRef.current.trim() || "case";
    await saveCase(s, s, s.includes("@") ? "email" : "username", sigs);
    setCases(await listCases());
    flashMsg(backendMode() === "server" ? "case saved (server)" : "case saved (local)");
  }

  function openCase(c: Case) {
    setSeed(c.seed);
    seedRef.current = c.seed;
    lastScanRef.current = c.seed;
    clearDemoState();
    rebuildRef.current(c.signals, true);
    loadBoardFor(c.seed);
    setRail(null);
    flashMsg(`loaded "${c.name}"`);
  }

  async function deleteCase(id: string) {
    await removeCase(id);
    setCases(await listCases());
  }

  function exportCurrent() {
    const sigs = currentSignals();
    if (!sigs.length) return;
    const s = seedRef.current.trim() || "case";
    const c: Case = { id: "export", name: s, seed: s, mode: s.includes("@") ? "email" : "username", savedAt: Date.now(), signals: sigs };
    // the analyst's own board travels with the case — it is half the investigation
    const payload = JSON.stringify({ ...JSON.parse(caseToJSON(c)), casefile: casefileRef.current });
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `octopus-case-${s.replace(/[^\w.@-]/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flashMsg("case exported");
  }

  function exportGraphML() {
    const sigs = currentSignals();
    if (!sigs.length) { flashMsg("nothing to export"); return; }
    const s = seedRef.current.trim() || "case";
    const blob = new Blob([toGraphML(sigs, (x) => x.tier || scoreEvidence(x.evidence).tier)], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `octopus-graph-${s.replace(/[^\w.@-]/g, "_")}.graphml`;
    a.click();
    URL.revokeObjectURL(url);
    flashMsg("graph exported (GraphML)");
  }

  async function importFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const text = await f.text();
    const c = parseCase(text);
    if (!c) { flashMsg("invalid case file"); return; }
    setSeed(c.seed);
    seedRef.current = c.seed;
    lastScanRef.current = c.seed;
    clearDemoState();
    rebuildRef.current(c.signals, true);
    // a board in an imported file is untrusted input: keep only what we understand
    let board: Casefile | null = null;
    try {
      const raw = JSON.parse(text);
      if (raw?.casefile) board = sanitizeCasefile(raw.casefile, c.seed);
    } catch { /* the case itself already parsed */ }
    if (board && (board.cards.length || board.links.length)) applyCasefile(board);
    else loadBoardFor(c.seed);
    setRail(null);
    flashMsg(`imported "${c.name}"` + (board?.cards.length ? ` · ${board.cards.length} board card(s)` : ""));
  }

  return (
    <>
      <div id="stage" style={{ visibility: view === "board" ? "visible" : "hidden" }}>
        <canvas ref={canvasRef} />
        <div className="bodies" ref={bodiesRef} />
      </div>

      {view === "table" && (() => {
        const tierRank: Record<string, number> = { verified: 0, probable: 1, possible: 2, weak: 3, contradicted: 4 };
        const rows = currentSignals()
          .map((s) => ({ s, tier: s.tier || scoreEvidence(s.evidence).tier, corr: scoreEvidence(s.evidence).corroboration }))
          .filter((r) => {
            const q = tableFilter.trim().toLowerCase();
            return !q || r.s.platform.toLowerCase().includes(q) || r.s.handle.toLowerCase().includes(q) || (r.s.kind || "").includes(q);
          });
        const sk = tableSort.key, dir = tableSort.dir;
        rows.sort((a, b) => {
          let d = 0;
          if (sk === "tier") d = tierRank[a.tier] - tierRank[b.tier];
          else if (sk === "platform") d = a.s.platform.localeCompare(b.s.platform);
          else if (sk === "handle") d = a.s.handle.localeCompare(b.s.handle);
          else if (sk === "type") d = (a.s.kind || "platform").localeCompare(b.s.kind || "platform");
          else if (sk === "corr") d = b.corr - a.corr;
          else if (sk === "status") d = a.s.status.localeCompare(b.s.status);
          return d * dir || tierRank[a.tier] - tierRank[b.tier];
        });
        const sortBtn = (key: string, label: string) => (
          <th onClick={() => setTableSort((p) => ({ key, dir: p.key === key ? (p.dir === 1 ? -1 : 1) : 1 }))}>
            {label}{sk === key ? (dir === 1 ? " ▲" : " ▼") : ""}
          </th>
        );
        return (
          <div className="tablewrap">
            <div className="table-toolbar">
              <input className="table-filter" placeholder="filter by platform / handle / type…" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />
              <span className="table-count">{rows.length} nodes</span>
            </div>
            <div className="table-scroll">
              <table className="datatable">
                <thead>
                  <tr>
                    {sortBtn("tier", "TIER")}
                    {sortBtn("type", "TYPE")}
                    {sortBtn("platform", "PLATFORM")}
                    {sortBtn("handle", "HANDLE / VALUE")}
                    {sortBtn("corr", "SIGNALS")}
                    {sortBtn("status", "STATUS")}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.s.id} className={selectedId === r.s.id ? "sel" : ""} onClick={() => setSelectedId(r.s.id)}>
                      <td><span className={"da-tier t-" + r.tier}>{r.tier}</span></td>
                      <td className="t-type">{r.s.kind || "platform"}</td>
                      <td className="t-plat">{r.s.platform}</td>
                      <td className="t-handle">{r.s.handle}</td>
                      <td className="t-num">{r.corr}</td>
                      <td className="t-status">{r.s.status}</td>
                      <td>{r.s.url && <a href={r.s.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>↗</a>}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={7} className="t-empty">no nodes — run a scan / investigate</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {view === "timeline" && (() => {
        const all = currentSignals();
        const events = buildTimeline(all, (s) => s.tier || scoreEvidence(s.evidence).tier);
        const years: { y: string; rows: typeof events }[] = [];
        for (const e of events) { const g = years.find((x) => x.y === e.year); if (g) g.rows.push(e); else years.push({ y: e.year, rows: [e] }); }
        const span = events.length ? `${events[0].year}–${events[events.length - 1].year}` : "";
        const typeLabel: Record<string, string> = { account: "created", photo: "photo", leak: "leak", record: "event" };
        return (
          <div className="tablewrap">
            <div className="table-toolbar">
              <span className="table-count">{events.length} dated event(s){span ? ` · ${span}` : ""}</span>
              <span className="map-hint">account creation · EXIF capture dates · breach dates</span>
            </div>
            <div className="table-scroll">
              {events.length === 0 && <div className="t-empty" style={{ padding: 40, textAlign: "center" }}>No dated footprint yet. Scan accounts that expose a creation date (GitHub, Reddit, HN, Bluesky…), run a leak source, or use Image metadata on a photo with an EXIF date.</div>}
              {events.length > 0 && (
                <div className="tline">
                  {years.map((g) => (
                    <div className="tline-year" key={g.y}>
                      <div className="tline-ymark">{g.y}</div>
                      <div className="tline-events">
                        {g.rows.map((e, i) => (
                          <div className={"tline-ev tv-" + e.type} key={i} onClick={() => setSelectedId(e.signalId)}>
                            <span className="tline-dot" />
                            <span className="tline-date">{e.iso}</span>
                            <span className={"tline-type k-" + e.type}>{typeLabel[e.type]}</span>
                            <span className="tline-label">{e.label}</span>
                            <span className="tline-who">{e.platform} · {e.handle}</span>
                            <span className={"da-tier t-" + e.tier}>{e.tier}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {view === "map" && <MapView signals={currentSignals()} onSelect={(id) => setSelectedId(id)} />}

      {view === "case" && (
        <CaseBoard
          file={casefile}
          onChange={applyCasefile}
          signals={currentSignals()}
          onCorrelate={correlateCard}
          onSelectSignal={(id) => { setSelectedId(id); setView("board"); }}
          busyCardId={cardBusy}
        />
      )}

      <nav className="rail" aria-label="workspace">
        <div className="wordmark rail-brand"><Logo size={22} /></div>
        {RAIL.map((g) => (
          <button
            key={g.id}
            className={"rail-item" + (rail?.id === g.id ? " on" : "")}
            aria-label={g.label} aria-expanded={rail?.id === g.id}
            onClick={(e) => openRail(e, g.id)}
          >
            <Glyph name={g.glyph} />
            <span>{g.label}</span>
            {g.id === "sources" && builtinOn < BUILTIN_APPS.length && <i className="rail-count">{builtinOn}</i>}
            {g.id === "cases" && cases.length > 0 && <i className="rail-count">{cases.length}</i>}
          </button>
        ))}
        <div className="rail-sep" />
        <button className="rail-item" aria-label={theme === "dark" ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
          <Glyph name={theme === "dark" ? "sun" : "moon"} />
          <span>{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
        <button className="rail-item" aria-label="Guide" onClick={() => { setRail(null); setGuideOpen(true); }}>
          <Glyph name="help" />
          <span>Guide</span>
        </button>
      </nav>

      {rail && <div className="menu-backdrop" onClick={() => setRail(null)} />}

      {rail?.id === "investigate" && (
        <div className="rail-pop" style={{ top: rail.top }}>
          <div className="pop-head">investigate — from a seed to a story</div>
          <button className="menu-item" disabled={scanning} onClick={() => { setRail(null); investigate(); }}><b>Investigate</b><span>Scan, auto-expand one hop, open the dossier</span></button>
          <button className="menu-item" disabled={scanning} onClick={() => { setRail(null); runScan(); }}><b>Scan the seed</b><span>Collect presences without expanding</span></button>
          <button className="menu-item" onClick={() => { setRail(null); deepScan(); }}><b>Deep scan</b><span>3000+ sites via the collector worker</span></button>
          <button className="menu-item" disabled={assistBusy} onClick={() => { setRail(null); runAssist(); }}><b>Ask the assistant</b><span>LLM reads the graph: conclusion, pivots, false positives</span></button>
          <button className="menu-item" disabled={monitoring} onClick={() => { setRail(null); runMonitor(); }}><b>Monitor changes</b><span>Re-scan and diff since the last snapshot</span></button>
          <button className="menu-item" onClick={() => { setRail(null); openDossier(); }}><b>Open dossier</b><span>The synthesized identity, with an optional grounded brief</span></button>
        </div>
      )}

      {rail?.id === "enrich" && (
        <div className="rail-pop" style={{ top: rail.top }}>
          <div className="pop-head">enrich — turn a node into more evidence</div>
          <button className="menu-item" onClick={() => { setRail(null); imageForensics(); }}><b>Image metadata</b><span>EXIF / GPS / camera from a photo URL</span></button>
          <button className="menu-item" disabled={faceBusy} onClick={() => { setRail(null); faceMatch(); }}><b>Face match</b><span>The same person across different photos</span></button>
          <button className="menu-item" onClick={() => { setRail(null); openOnion(); }}><b>Open hidden service</b><span>Retrieve a .onion through Tor: emails, wallets, keys, handles</span></button>
          <button className="menu-item" onClick={() => { setRail(null); openAddForm(); }}><b>Add a finding</b><span>Your manual discovery, run through the same engine</span></button>
        </div>
      )}

      {rail?.id === "sources" && (
        <div className="rail-pop wide" style={{ top: Math.min(rail.top, 90) }}>
          <div className="pop-head sticky">connectors — {builtinOn}/{BUILTIN_APPS.length} enabled, toggle to include in the scan</div>
          {BUILTIN_APPS.map((a) => (
            <div className="app-row" key={a.id}>
              <button className={"app-toggle" + (enabled.has(a.id) ? " on" : "")} onClick={() => toggleApp(a.id)} aria-label={`toggle ${a.name}`}>
                <span className="app-sw" />
              </button>
              <div className="app-info">
                <span className="app-name">{a.name} <em>{a.category}</em></span>
                <span className="app-desc">{a.desc}</span>
              </div>
            </div>
          ))}
          <div className="pop-head">manual pivots — add, then open pre-filled with the seed</div>
          {MANUAL_APPS.map((a) => (
            <div className="app-row" key={a.id}>
              <button className={"app-add" + (enabled.has(a.id) ? " added" : "")} onClick={() => toggleApp(a.id)} aria-label={`add ${a.name}`}>
                {enabled.has(a.id) ? "✓" : "+"}
              </button>
              <div className="app-info">
                <span className="app-name">{a.name} <em>{a.category}</em> <b className={"app-badge " + a.status}>{a.status}</b></span>
                <span className="app-desc">{a.desc}</span>
              </div>
              {enabled.has(a.id) && <button className="app-open" onClick={() => openTool(a)} aria-label="open">↗</button>}
              {enabled.has(a.id) && <button className="app-open" onClick={() => openAddForm(a.name)} aria-label="add a result" title="add a result to the board">＋</button>}
            </div>
          ))}
        </div>
      )}

      {rail?.id === "cases" && (
        <div className="rail-pop" style={{ top: rail.top }}>
          <div className="pop-head">cases — stored: {backendMode() || "…"}</div>
          <button className="menu-item" onClick={() => { setRail(null); saveCurrent(); }}><b>Save the current board</b><span>Appends an immutable snapshot to the case history</span></button>
          {cases.length === 0 && <div className="cases-empty">no saved case yet</div>}
          {cases.map((c) => (
            <div className="case-row" key={c.id}>
              <button className="case-open" onClick={() => openCase(c)}>
                <span className="case-name">{c.name}</span>
                <span className="case-meta">
                  {c.signals.length} signals · {new Date(c.savedAt).toLocaleDateString()}
                  {snapCounts[c.id] ? ` · ${snapCounts[c.id]} snapshot(s) in history` : ""}
                </span>
              </button>
              <button className="case-del" onClick={() => deleteCase(c.id)} aria-label={`delete ${c.name}`}>✕</button>
            </div>
          ))}
        </div>
      )}

      {rail?.id === "data" && (
        <div className="rail-pop" style={{ top: rail.top }}>
          <div className="pop-head">data — in, out, and what you already hold</div>
          <button className="menu-item" onClick={() => { setRail(null); setCorpusOpen(true); loadCorpusStats(); }}><b>Local corpora</b><span>Load and search datasets you hold — silent, nothing leaves the machine</span></button>
          <button className="menu-item" onClick={() => { setRail(null); exportCurrent(); }}><b>Export JSON</b><span>Download the case file</span></button>
          <button className="menu-item" onClick={() => { setRail(null); exportGraphML(); }}><b>Export graph (GraphML)</b><span>Open in flowsint / Maltego / Gephi</span></button>
          <button className="menu-item" onClick={() => { setRail(null); fileRef.current?.click(); }}><b>Import JSON</b><span>Load a case file</span></button>
        </div>
      )}

      {rail?.id === "configure" && (
        <div className="rail-pop" style={{ top: rail.top }}>
          <div className="pop-head">configure — keys, tradecraft, help</div>
          <button className="menu-item" onClick={() => { setRail(null); setApiOpen(true); }}><b>API keys &amp; tradecraft</b><span>LLM, leak sources, collector, OPSEC posture, proxy / Tor</span></button>
          <button className="menu-item" onClick={() => { setRail(null); setGuideOpen(true); }}><b>Usage guide</b><span>Where to start and how to run an investigation</span></button>
          <button className="menu-item" onClick={() => { setRail(null); toggleTheme(); }}><b>{theme === "dark" ? "Light" : "Dark"} theme</b><span>Currently {theme}; follows your system until you choose</span></button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="application/json,.json" onChange={importFile} style={{ display: "none" }} />

      <div className="chrome">
        <div className="wordmark">OCTOPUS <small>ORBIT</small></div>
        <div className="cmdbar">
          <label htmlFor="seed-input">seed</label>
          <input
            id="seed-input" ref={seedInputRef} value={seed} spellCheck={false}
            placeholder="username, email, phone, name or domain"
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); investigate(); } }}
            aria-label="seed"
          />
          <button className="go" onClick={investigate} disabled={scanning}>{scanning ? "WORKING" : "INVESTIGATE"}</button>
        </div>
        <button className="kbd" onClick={() => setPalette(true)} aria-label="open the command palette">
          <Glyph name="command" size={13} />{modKey}K
        </button>
        <div className="flex" />
        <div className="statusline">
          {/* the strip never wraps, so the full text lives in the tooltip — a truncated
              "sources unreachable" warning that cannot be read is not a warning */}
          {(deepStatus || scanMsg) && <span className="st-msg" title={deepStatus || scanMsg || ""}>{deepStatus || scanMsg}</span>}
          {isDemo && !scanMsg && !deepStatus && <span className="demo-tag hide-md">sample data — scan a seed to start</span>}
          <span className="hide-md"><span className="dotpulse" /><b>{total}</b> signals</span>
          <span className="hide-md"><b style={{ color: "var(--confirm)" }}>{confirmedCount}</b> confirmed</span>
        </div>
        <div className="viewtoggle">
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>ORBIT</button>
          <button className={view === "case" ? "on" : ""} onClick={() => setView("case")}>BOARD</button>
          <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>TABLE</button>
          <button className={view === "timeline" ? "on" : ""} onClick={() => setView("timeline")}>TIMELINE</button>
          <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>MAP</button>
        </div>
      </div>
      {scanning && <div className="scanline"><i /></div>}

      {palette && (
        <div className="pal-overlay" onClick={() => setPalette(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              className="pal-input" autoFocus value={palQuery} spellCheck={false}
              placeholder="Type a command — scan, dossier, onion, corpora, keys, theme…"
              onChange={(e) => { setPalQuery(e.target.value); setPalIndex(0); }}
              onKeyDown={onPaletteKey}
              aria-label="command"
            />
            <div className="pal-list">
              {palResults.length === 0 && <div className="pal-empty">nothing matches “{palQuery}”</div>}
              {palResults.map((c, i) => (
                <div key={c.group + c.label}>
                  {(i === 0 || palResults[i - 1].group !== c.group) && <div className="pal-group">{c.group}</div>}
                  <button
                    className={"pal-item" + (i === palIndex ? " on" : "")}
                    onMouseEnter={() => setPalIndex(i)}
                    onClick={() => { setPalette(false); c.run(); }}
                  >
                    <div className="pi-main"><b>{c.label}</b><small>{c.hint}</small></div>
                    {c.key && <span className="pi-key">{c.key}</span>}
                  </button>
                </div>
              ))}
            </div>
            <div className="pal-foot"><span>↑↓ move</span><span>⏎ run</span><span>esc close</span></div>
          </div>
        </div>
      )}

      {view === "board" && (
        <>
          <div className="orbit-tools">
            <div className="ot-modes">
              {ORBIT_MODES.map((m) => (
                <button
                  key={m.id} className={orbitMode === m.id ? "on" : ""} title={m.hint}
                  onClick={() => setOrbitMode(m.id)}
                >{m.label}</button>
              ))}
            </div>
            <div className="ot-row">
              <button className="ot-act" onClick={() => fitRef.current()}>Fit</button>
              <button className="ot-act" onClick={unpinAll}>Release pins</button>
              <span className="ot-hint">wheel zooms · drag the void pans · drag a node pins it · double-click un-pins</span>
            </div>
          </div>

          <div className="legend">
            {/* The legend has to describe the layout actually on screen. In clusters or
                by-type, distance no longer encodes confidence, and a legend that kept
                claiming it did would be the picture lying about the evidence. */}
            {orbitMode === "orbit" ? (
              BAND_ORDER.map((k) => (
                <div className="l" key={k}><span className="tick" />{BANDS[k].label}</div>
              ))
            ) : (
              <>
                <div className="l"><span className="tick" />
                  {orbitMode === "cluster" ? "grouped by resolved identity" : orbitMode === "type" ? "grouped by node type" : "free arrangement"}
                </div>
                <div className="l ot-warn">distance no longer means confidence — read the tier on the node</div>
              </>
            )}
          </div>
          <div className="hint">
            Type a seed and press <b>Enter</b>&nbsp;&nbsp;/&nbsp;&nbsp;click a node for its evidence, right-click to pivot
            &nbsp;&nbsp;/&nbsp;&nbsp;<b>{modKey}K</b> for every command&nbsp;&nbsp;/&nbsp;&nbsp;<b>/</b> to focus the seed,
            <b> 1-5</b> to switch view&nbsp;&nbsp;/&nbsp;&nbsp;new here? the rail ends with the guide
          </div>
        </>
      )}

      {corpusOpen && (
        <div className="add-overlay" onClick={() => setCorpusOpen(false)}>
          <div className="apicard" onClick={(e) => e.stopPropagation()}>
            <button className="insp-close" onClick={() => setCorpusOpen(false)} aria-label="close">✕</button>
            <div className="insp-plat">LOCAL CORPORA · data you hold</div>
            <div className="add-sub">
              Everything else in Octopus queries the live web, which tells the source you looked and vanishes when
              the page does. A corpus is a dataset you already have — a breach dump, a forum archive, an exported
              channel. Searching it is <b>silent</b>: nothing leaves this machine and no source is told you looked.
              Credentials are redacted at ingest; hold this material only under a lawful basis, and never redistribute it.
            </div>

            <div className="guide-sect">Load a dataset</div>
            <div className="field-row">
              <label className="add-field"><span>corpus name — its provenance is part of the evidence</span>
                <input value={corpusName} placeholder="collection1-2019 / forum-x-archive" onChange={(e) => setCorpusName(e.target.value)} />
              </label>
              <button className="ping-btn" onClick={() => corpusFileRef.current?.click()}>Choose file</button>
            </div>
            <input
              ref={corpusFileRef} type="file" accept=".txt,.csv,.tsv,.json,.jsonl,.log,text/plain" style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (!corpusName.trim()) setCorpusName(f.name.replace(/\.[a-z0-9]+$/i, ""));
                setCorpusMsg(`reading ${f.name}…`);
                const text = await f.text();
                setCorpusText(text);
                setCorpusMsg(`${f.name} loaded (${Math.round(text.length / 1024)} KB) — review, then Ingest`);
                e.target.value = "";
              }}
            />
            <label className="add-field"><span>or paste records — plain lines, CSV/TSV with a header, JSON or JSONL (Telegram exports included); the format is detected</span>
              <textarea
                className="api-textarea" rows={6} value={corpusText.slice(0, 20000)}
                placeholder={"user@example.com:hunter2\n+33612345678\nalias_87"}
                onChange={(e) => setCorpusText(e.target.value)}
              />
            </label>
            <div className="field-row">
              <button className="ping-btn" disabled={corpusBusy} onClick={ingestCorpusText}>{corpusBusy ? "working…" : "Ingest"}</button>
              {corpusMsg && <span className="ping-res">{corpusMsg}</span>}
            </div>

            <div className="guide-sect">Held corpora</div>
            {corpusStats ? (
              corpusStats.total ? (
                <ul className="guide-list">
                  {corpusStats.corpora.map((c) => <li key={c.name}><b>{c.name}</b> — {c.records.toLocaleString()} record(s)</li>)}
                </ul>
              ) : <div className="api-note">Nothing held yet.</div>
            ) : <div className="api-note">…</div>}
            {corpusStats && !corpusStats.persistent && (
              <div className="api-note">
                No database configured — a corpus lives only in the server process that received it, and a serverless
                deploy (Vercel) will usually have lost it by the next request. Set <b>POSTGRES_URL</b> to hold corpora
                for real. Self-hosted (Docker / <b>node server.js</b>), it survives as long as the process does.
              </div>
            )}

            <div className="guide-sect">Search (silent)</div>
            <div className="field-row">
              <label className="add-field"><span>exact email / handle / phone — or <b>@domain.com</b> to sweep a domain</span>
                <input
                  value={corpusQuery} placeholder="marie.dubois@example.com"
                  onChange={(e) => setCorpusQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") searchCorpusUI(); }}
                />
              </label>
              <button className="ping-btn" disabled={corpusBusy} onClick={searchCorpusUI}>Search</button>
            </div>
            {corpusHits && (
              <div>
                {corpusHits.note && <div className="api-note">{corpusHits.note}</div>}
                {corpusHits.hits.length === 0 && <div className="api-note">No record for this selector in the held corpora.</div>}
                {corpusHits.hits.length > 0 && (
                  <ul className="guide-list">
                    {corpusHits.hits.slice(0, 50).map((h: any, i: number) => (
                      <li key={i}><b>{h.selector}</b> <span className="cx-meta">({h.selectorType} · {h.corpus}{h.recordDate ? ` · ${h.recordDate}` : ""})</span><br /><span className="cx-meta">{h.content}</span></li>
                    ))}
                  </ul>
                )}
                {corpusHits.signals.length > 0 && (
                  <button className="ping-btn" onClick={() => { for (const s of corpusHits.signals) addNodeRef.current(s); setCorpusOpen(false); flashMsg(`${corpusHits.signals.length} corpus node(s) added`); }}>
                    Add {corpusHits.signals.length} node(s) to the board
                  </button>
                )}
              </div>
            )}
            <div className="api-note">
              A domain or prefix sweep returns records about <b>different people</b> — it is a lead list, not an
              identity. Only an exact-selector hit becomes a node, and it stays PROBABLE until something independent
              corroborates it.
            </div>
          </div>
        </div>
      )}

      {apiOpen && (() => {
        const PingDot = ({ svc }: { svc: string }) => {
          const p = pings[svc];
          return (
            <span className="ping">
              <button className="ping-btn" onClick={() => ping(svc)} disabled={p === "loading"}>{p === "loading" ? "testing…" : "Test"}</button>
              {p && p !== "loading" && <span className={"ping-res " + (p.ok ? "ok" : "bad")}>{p.ok ? "● pong" : "● fail"} · {p.detail}</span>}
            </span>
          );
        };
        return (
          <div className="add-overlay" onClick={() => setApiOpen(false)}>
            <div className="apicard" onClick={(e) => e.stopPropagation()}>
              <button className="insp-close" onClick={() => setApiOpen(false)} aria-label="close">✕</button>
              <div className="insp-plat">API · keys &amp; connections</div>
              <div className="add-sub">Keys are stored in your browser only, sent per request — never saved on the server. Every field has a live Test (ping/pong). Scroll for all sections:</div>
              <div className="api-nav">
                <button onClick={() => document.getElementById("api-opsec")?.scrollIntoView({ behavior: "smooth" })}>Tradecraft · OPSEC</button>
                <button onClick={() => document.getElementById("api-llm")?.scrollIntoView({ behavior: "smooth" })}>LLM assistant</button>
                <button onClick={() => document.getElementById("api-leak")?.scrollIntoView({ behavior: "smooth" })}>Leak sources · IntelX · RF</button>
                <button onClick={() => document.getElementById("api-collector")?.scrollIntoView({ behavior: "smooth" })}>Collector</button>
              </div>

              <div className="guide-sect" id="api-opsec">Tradecraft — how you look, and what gets logged</div>
              <div className="api-sub">
                By default a collector announces itself from one address, which tells the target you looked and makes
                all your cases correlatable. Set a <b>case id</b> and Octopus adopts a browser-realistic identity that is
                consistent within the case and different across cases.
              </div>
              <div className="add-cols">
                <label className="add-field"><span>posture</span>
                  <select className="api-select" value={settings.posture || "direct"} onChange={(e) => updateSettings({ posture: e.target.value })}>
                    <option value="direct">direct — fastest, loudest</option>
                    <option value="careful">careful — browser-shaped, jittered</option>
                    <option value="no-touch">no-touch — never contact the target</option>
                  </select>
                </label>
                <label className="add-field"><span>case id (egress anchor)</span>
                  <input value={settings.caseId || ""} placeholder="op-2026-014" onChange={(e) => updateSettings({ caseId: e.target.value })} />
                </label>
              </div>
              <label className="add-field"><span>outbound proxy — socks5:// for Tor and .onion, http:// otherwise</span>
                <input value={settings.proxy || ""} placeholder="socks5://127.0.0.1:9050" onChange={(e) => updateSettings({ proxy: e.target.value })} />
              </label>
              <div className="api-free"><span>Tor / hidden services</span> — Test asks check.torproject.org whether the request really left through Tor. <PingDot svc="tor" /></div>
              <div className="api-note">
                Without a SOCKS5 proxy, darkweb search still runs against the clearnet-reachable index (Ahmia) and the
                onion-only engines are reported as <b>skipped</b>, never as &quot;nothing found&quot;. A <b>.onion</b> request is
                refused rather than attempted: the DNS lookup alone would leak the address. If a proxy is set and cannot be
                built, requests are blocked instead of quietly going out direct.
              </div>
              <div className="add-cols">
                <label className="add-field"><span>operator (audit)</span>
                  <input value={settings.operator || ""} placeholder="your identifier" onChange={(e) => updateSettings({ operator: e.target.value })} />
                </label>
                <label className="add-field"><span>legal basis (audit)</span>
                  <input value={settings.legalBasis || ""} placeholder="tasking ref / consent / own-data" onChange={(e) => updateSettings({ legalBasis: e.target.value })} />
                </label>
              </div>
              <div className="api-note">
                Every selector query is written to an append-only, hash-chained audit trail with these fields (needs a
                database). <b>no-touch</b> refuses any host the target can observe and falls back to archival sources.
              </div>

              <div className="guide-sect" id="api-llm">Investigation assistant (LLM)</div>
              <div className="api-sub">Free: OpenRouter (<b>:free</b> models), z.ai GLM-4-Flash, Qwen, or local Ollama.</div>
              <label className="add-field"><span>preset</span>
                <select className="api-select" value="" onChange={(e) => { const pr = LLM_PRESETS.find((x) => x.id === e.target.value); if (pr) updateSettings({ llmUrl: pr.url, llmModel: pr.model, llmWeb: pr.web }); }}>
                  <option value="">— choose a provider —</option>
                  {LLM_PRESETS.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                </select>
              </label>
              <div className="add-cols">
                <label className="add-field"><span>base url</span><input value={settings.llmUrl || ""} placeholder="https://openrouter.ai/api/v1" onChange={(e) => updateSettings({ llmUrl: e.target.value })} /></label>
                <label className="add-field"><span>model</span><input value={settings.llmModel || ""} placeholder="deepseek/deepseek-chat-v3.1:free" onChange={(e) => updateSettings({ llmModel: e.target.value })} /></label>
              </div>
              <label className="add-field"><span>api key</span><input type="password" value={settings.llmKey || ""} placeholder="sk-…" onChange={(e) => updateSettings({ llmKey: e.target.value })} /></label>
              <label className="api-check"><input type="checkbox" checked={!!settings.llmWeb} onChange={(e) => updateSettings({ llmWeb: e.target.checked })} /> allow web search (OpenRouter <b>:online</b>) — lets the assistant look up what our connectors can&apos;t reach</label>
              <PingDot svc="llm" />

              <div className="guide-sect" id="api-leak">Leak / breach sources</div>
              <div className="add-cols">
                <label className="add-field"><span>Intelligence X key</span><input type="password" value={settings.intelx || ""} placeholder="freemium key" onChange={(e) => updateSettings({ intelx: e.target.value })} /></label>
                <div className="api-testcol"><PingDot svc="intelx" /></div>
              </div>
              <div className="add-cols">
                <label className="add-field"><span>Recorded Future key</span><input type="password" value={settings.recordedfuture || ""} placeholder="enterprise (bonus)" onChange={(e) => updateSettings({ recordedfuture: e.target.value })} /></label>
                <div className="api-testcol"><PingDot svc="recordedfuture" /></div>
              </div>
              <div className="api-free"><span>Hudson Rock (infostealer intel)</span> — free, no key. <PingDot svc="hudsonrock" /></div>

              <div className="guide-sect" id="api-collector">Deep-scan collector (Maigret / Holehe / SpiderFoot)</div>
              <div className="add-cols">
                <label className="add-field"><span>collector url</span><input value={settings.collectorUrl || ""} placeholder="https://…onrender.com" onChange={(e) => updateSettings({ collectorUrl: e.target.value })} /></label>
                <label className="add-field"><span>token</span><input type="password" value={settings.collectorToken || ""} placeholder="optional" onChange={(e) => updateSettings({ collectorToken: e.target.value })} /></label>
              </div>
              <PingDot svc="collector" />
              <div className="api-note">Note: the collector URL is read from the server env (COLLECTOR_URL) for scans; the Test here checks reachability of what you entered.</div>
            </div>
          </div>
        );
      })()}

      {assist && (
        <div className="assist-panel">
          <button className="insp-close" onClick={() => setAssist(null)} aria-label="close">✕</button>
          <div className="mon-title">ASSISTANT · investigative read</div>
          <div className={"assist-conf c-" + assist.confidence}>identification confidence: {assist.confidence}</div>
          <div className="assist-concl">{assist.conclusion}</div>
          {assistVerdict && (
            <div className={"verify " + assistVerdict.verdict}>
              {assistVerdict.verdict === "grounded"
                ? <span>✓ grounded · {assistVerdict.validCitations}/{assistVerdict.totalCitations} citations valid</span>
                : <span>⚠ {assistVerdict.validCitations}/{assistVerdict.totalCitations} citations valid{assistVerdict.unsupportedFacts.length ? ` · ${assistVerdict.unsupportedFacts.length} unsupported` : ""}</span>}
            </div>
          )}
          {assist.pivots.length > 0 && <>
            <div className="assist-sect">Next pivots to chase</div>
            {assist.pivots.map((p, i) => (
              <div className="assist-row" key={i}>
                <button className="assist-act" disabled={scanning} onClick={() => chasePivot(p.query)}>chase</button>
                <span className="assist-main"><b>{p.query}</b><span>{p.why}</span></span>
              </div>
            ))}
          </>}
          {assist.falsePositives.length > 0 && <>
            <div className="assist-sect">Suspected false positives</div>
            {assist.falsePositives.map((p, i) => (
              <div className="assist-row" key={i}>
                <button className="assist-act warn" onClick={() => selectByHandle(p.node)}>inspect</button>
                <span className="assist-main"><b>{p.node}</b><span>{p.why}</span></span>
              </div>
            ))}
          </>}
          {assist.uncertainties.length > 0 && <>
            <div className="assist-sect">Uncertainties</div>
            <ul className="assist-unc">{assist.uncertainties.map((u, i) => <li key={i}>{u}</li>)}</ul>
          </>}
          <div className="assist-foot">The assistant proposes; you decide. Confirming a chased lead continues the chain; rejecting a false positive removes it for good.</div>
        </div>
      )}

      {guideOpen && (
        <div className="add-overlay" onClick={() => setGuideOpen(false)}>
          <div className="guide" onClick={(e) => e.stopPropagation()}>
            <button className="insp-close" onClick={() => setGuideOpen(false)} aria-label="close">✕</button>
            <div className="insp-plat">GUIDE · how to run an investigation</div>
            <div className="guide-lead">
              Octopus takes one <b>seed</b> — a username, email, phone, full name or domain — collects public
              footprint across many sources, and correlates it into a single identity: the accounts,
              emails, locations, relationships and leaks that belong to one person. You stay in control;
              nothing is auto-confirmed.
            </div>

            <div className="guide-sect">Start</div>
            <ol className="guide-steps">
              <li><b>Type a seed</b> in the bar and press <b>Enter</b>. Octopus scans, correlates and expands
                automatically, then opens the dossier. A username, email, phone, full name or domain all work.</li>
              <li>Prefer manual control? <b>Investigate → Scan the seed</b> runs a single pass and expands nothing.</li>
            </ol>

            <div className="guide-sect">Finding things</div>
            <div className="guide-lead">
              Everything lives in two places, and nothing is hidden in a third.
            </div>
            <ul className="guide-list">
              <li>The <b>rail</b> on the left groups every tool by intent — Investigate, Enrich, Sources, Cases, Data,
                Configure. Hover a glyph to see its name; click it to open the group.</li>
              <li><b>{modKey}K</b> opens the command palette: one searchable list of every action, including the ones
                you would otherwise have to remember where to find. Arrows to move, Enter to run.</li>
              <li><b>/</b> jumps to the seed field, <b>1-4</b> switch view, <b>Esc</b> closes whatever is open.</li>
            </ul>

            <div className="guide-sect">Read the graph</div>
            <ol className="guide-steps">
              <li><b>Click any node</b> to open the inspector: its evidence, sources, and honest tier (VERIFIED / PROBABLE / POSSIBLE / WEAK — derived from evidence, not a fake percentage).</li>
              <li><b>Read the tier honestly</b>: it is derived from evidence, and a handle counts for as much as it is <b>rare</b> — a shared &quot;alex&quot; proves nothing, a shared &quot;xk9_zulu_42&quot; almost proves it. <b>CONTRADICTED</b> means Octopus found evidence <em>against</em> the link (a different face, an incompatible activity timezone) — treat it as a conflict, not a weak yes.</li>
              <li><b>Judge it</b>: CONFIRM, REVIEW or REJECT. <b>Confirming a lead chains the investigation</b> — Octopus takes its new identifiers (a different username, a real name, a linked email) and searches from them, adding the leads for you to review. <b>Rejecting or removing a node suppresses it</b>: it is never proposed again on this seed.</li>
              <li><b>Right-click a node</b> to Pivot, Auto-expand, set it as the new seed, or focus its sub-graph.</li>
            </ol>

            <div className="guide-sect">Switch views (top-left, next to the seed)</div>
            <ul className="guide-list">
              <li><b>ORBIT</b> — the identity as a gravitational map (confidence = distance to the seed).</li>
              <li><b>TABLE</b> — the workhorse: every node, sortable and filterable. Start here if you want a plain list.</li>
              <li><b>TIMELINE</b> — footprint ordered by account-creation date.</li>
              <li><b>MAP</b> — every resolved location on a real map.</li>
            </ul>

            <div className="guide-sect">Let the assistant help (TOOLS → Ask the assistant)</div>
            <div className="guide-lead">
              With an LLM configured (API panel — free options: OpenRouter, z.ai, Qwen), the assistant reads the
              whole graph and returns a grounded read: a factual <b>conclusion</b>, the <b>next pivots</b> to chase
              (click to run them), and <b>suspected false positives</b> to inspect. Every claim is cited and verified
              against the evidence — it proposes, you decide. With web search on, it can look up what our connectors can&apos;t reach.
            </div>

            <div className="guide-sect">Enrich (TOOLS menu)</div>
            <ul className="guide-list">
              <li><b>Deep scan</b> — 3000+ sites with profile data (needs the collector worker).</li>
              <li><b>Image metadata</b> — pull EXIF / GPS from any photo URL.</li>
              <li><b>Face match</b> — find the same person across different photos.</li>
              <li><b>Monitor changes</b> — re-scan and see what appeared, vanished or changed.</li>
              <li><b>Open hidden service</b> — retrieve a .onion through Tor and harvest the emails, wallets, keys and handles published on it.</li>
            </ul>

            <div className="guide-sect">Your own data (DATA → Local corpora)</div>
            <div className="guide-lead">
              Load datasets you already hold — a breach dump, a forum archive, an exported channel — and every scan
              searches them <b>silently</b>: nothing leaves the machine and no source is told you looked. Plain lines,
              CSV/TSV with a header, JSON and JSONL (Telegram exports included) are detected automatically; credentials
              are redacted at ingest. Search an exact selector to attribute, or <b>@domain.com</b> to sweep a domain —
              a sweep is a lead list about different people, so it never becomes a node.
            </div>

            <div className="guide-sect">Shaping the graph (Orbit)</div>
            <ul className="guide-list">
              <li><b>Wheel</b> zooms about the cursor, <b>dragging the void</b> pans, <b>F</b> frames everything.</li>
              <li><b>Drag a node</b> and it stays where you put it — moving it pins it, because an arrangement the
                physics undoes was never an arrangement. <b>Double-click</b> releases it.</li>
              <li>Four layouts: <b>Orbit</b> (distance from the seed IS the confidence), <b>Clusters</b> (accounts
                resolved to one identity sit together), <b>By type</b>, and <b>Free</b> (no gravity at all). Outside
                Orbit the legend says so — distance stops meaning confidence, and the picture must not pretend otherwise.</li>
              <li>Your arrangement is saved with the case and comes back with it.</li>
            </ul>

            <div className="guide-sect">Your side of it (BOARD)</div>
            <div className="guide-lead">
              You are also working by hand — reading a thread, taking a tip, forming a theory. <b>BOARD</b> is where
              that goes, on the same case as the graph instead of in a file next to it.
            </div>
            <ul className="guide-list">
              <li><b>Add card</b> — a lead, a source, a person, a piece of evidence, a hypothesis, a question.</li>
              <li><b>Link</b> two cards and say what the link <b>means</b>: supports, contradicts, leads to, same as.
                A theory you cannot contradict is not a theory.</li>
              <li>A <b>hypothesis</b> card shows a tally, never a probability — what is confirmed for it, what is
                confirmed against it, what is still open.</li>
              <li><b>Correlate</b> pushes a card whose title is a handle, email or URL through the same engine a scan
                uses. It becomes real graph nodes, scored by the same rules — not by how sure you felt writing it.</li>
              <li>Right-click any graph node to <b>pin it to the board</b>; the card keeps showing what the engine
                currently says about it.</li>
            </ul>

            <div className="guide-sect">Darkweb and .onion</div>
            <div className="guide-lead">
              Darkweb search runs on every scan and needs nothing installed: the onion indexes reachable from
              the clearnet are queried directly. What it finds are <b>mentions</b> — a selector appearing in an
              index entry is never treated as attribution, only verbatim matches become nodes, and they stay at
              WEAK until something independent corroborates them.
            </div>
            <ul className="guide-list">
              <li><b>Without Tor</b> — Ahmia is queried; the onion-only engines are reported as <i>skipped</i>. The
                scan message always states what was and was not covered, so quiet is never read as &quot;nothing there&quot;.</li>
              <li><b>With Tor</b> — set a SOCKS5 proxy in the API panel (Tor: <b>socks5://127.0.0.1:9050</b>, Tor
                Browser: <b>:9150</b>) and Test it. Torch and Haystak join in, Ahmia is reached through its onion
                mirror, and you can open a specific hidden service to harvest addresses, keys and handles from it.</li>
              <li><b>A .onion request without Tor is refused, not attempted</b> — the DNS lookup alone would tell
                your resolver what you were looking for.</li>
            </ul>

            <div className="guide-sect">Add your own findings</div>
            <div className="guide-lead">
              Found an Instagram, Facebook or LinkedIn account by hand? <b>ADD FINDING</b>. Octopus runs
              it through the same engine — linking it by handle, name, email and avatar, mining the bio,
              and mapping the location — so your manual work fuses with what Octopus found on its own.
            </div>

            <div className="guide-sect">Finish</div>
            <ul className="guide-list">
              <li><b>DOSSIER</b> — the synthesized identity, plus an optional grounded LLM brief (every claim cited, verified against the evidence).</li>
              <li><b>DATA menu</b> — Save the case, Export or Import as JSON.</li>
            </ul>
          </div>
        </div>
      )}

      {addForm && (
        <div className="add-overlay" onClick={() => setAddForm(null)}>
          <div className="add-card" onClick={(e) => e.stopPropagation()}>
            <div className="add-title">CAPTURE &amp; CORRELATE{addForm.via ? <em> · via {addForm.via}</em> : null}</div>
            <div className="add-sub">Found an Instagram / Facebook / LinkedIn account yourself? Enter what you saw. Octopus runs it through the same engine — links it by handle, name, email &amp; avatar, mines the bio, and maps the location.</div>
            <div className="add-cols">
              <label className="add-field"><span>platform *</span>
                <input autoFocus value={addForm.platform} placeholder="e.g. INSTAGRAM" onChange={(e) => setAddForm({ ...addForm, platform: e.target.value })} />
              </label>
              <label className="add-field"><span>handle *</span>
                <input value={addForm.handle} placeholder="e.g. john.doe" onChange={(e) => setAddForm({ ...addForm, handle: e.target.value })} />
              </label>
            </div>
            <label className="add-field"><span>url</span>
              <input value={addForm.url} placeholder="https://instagram.com/john.doe" onChange={(e) => setAddForm({ ...addForm, url: e.target.value })} />
            </label>
            <div className="add-cols">
              <label className="add-field"><span>display name</span>
                <input value={addForm.displayName} placeholder="John Doe" onChange={(e) => setAddForm({ ...addForm, displayName: e.target.value })} />
              </label>
              <label className="add-field"><span>email seen</span>
                <input value={addForm.email} placeholder="john@…" onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} />
              </label>
            </div>
            <label className="add-field"><span>bio / text (mined for identifiers)</span>
              <input value={addForm.bio} placeholder="paste the profile bio — @handles &amp; emails get extracted" onChange={(e) => setAddForm({ ...addForm, bio: e.target.value })} />
            </label>
            <div className="add-cols">
              <label className="add-field"><span>location</span>
                <input value={addForm.location} placeholder="Paris — or 48.85, 2.35" onChange={(e) => setAddForm({ ...addForm, location: e.target.value })} />
              </label>
              <label className="add-field"><span>avatar url (pHash match)</span>
                <input value={addForm.avatar} placeholder="https://…/photo.jpg" onChange={(e) => setAddForm({ ...addForm, avatar: e.target.value })} />
              </label>
            </div>
            <label className="add-field"><span>note · screenshot url (custody)</span>
              <input value={addForm.note} placeholder="what you saw / why it matches" onChange={(e) => setAddForm({ ...addForm, note: e.target.value })} />
            </label>
            <label className="add-field"><span></span>
              <input value={addForm.screenshot} placeholder="archived screenshot link (optional)" onChange={(e) => setAddForm({ ...addForm, screenshot: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }} />
            </label>
            <div className="add-actions">
              <button className="btn" onClick={() => setAddForm(null)}>CANCEL</button>
              <button className="btn add-primary" onClick={submitAdd} disabled={capturing}>{capturing ? "CORRELATING…" : "CAPTURE &amp; CORRELATE"}</button>
            </div>
          </div>
        </div>
      )}

      <aside className={"inspector" + (selected ? " open" : "")} aria-hidden={!selected}>
        {selected && (
          <>
            <button className="insp-close" onClick={() => setSelectedId(null)} aria-label="close">✕</button>
            <div className="insp-plat">{selected.platform}</div>
            <div className="insp-handle">{selected.handle}</div>
            {(() => {
              const tier = selected.tier || scoreEvidence(selected.evidence).tier;
              return (
                <div className="insp-score">
                  <div className={"tier-badge t-" + tier}>{TIER_LABEL[tier]}</div>
                  <span className="tier-sub">{scoreEvidence(selected.evidence).corroboration} corroborating signal(s) · derived confidence {selected.confidence}</span>
                </div>
              );
            })()}
            <div className="track">
              <i style={{ width: selected.confidence + "%", background: selected.status === "rejected" ? "var(--reject)" : "var(--accent)" }} />
            </div>
            <div className="pivot-row">
              <button className="pivot-btn" onClick={() => pivotOn(selected)} disabled={scanning}>PIVOT</button>
              <button className="pivot-btn" onClick={() => autoExpand(selected)} disabled={scanning}>AUTO-EXPAND · 2 hops</button>
            </div>
            <div className="sect">VERIFIED EVIDENCE</div>
            <div className="evs">
              {selected.evidence.map((e, idx) => (
                <div className="ev" key={idx}>
                  <div>
                    <div className="en">{e.name}</div>
                    <div className="ed">{e.detail}</div>
                    <div className="es">{e.source}</div>
                  </div>
                  <div className="ew">{e.weight}%</div>
                </div>
              ))}
            </div>
            <div className="grounded">
              <b>{selected.evidence.length} evidence items</b> tied to a verifiable source. The score aggregates only these
              signals — <b>no unsourced inference</b> is produced by the LLM.
              {/* corroboration is only worth something when the sources are independent —
                  three facts read off one profile page are one sighting, and saying so
                  here is what stops a node from looking better corroborated than it is */}
              <div className="grounded-ind">{independenceNote(assessIndependence(selected.evidence))}</div>
            </div>
            {selected.place && (
              <>
                <div className="sect">LOCATION</div>
                <div className="insp-geo">
                  <span className="geo-coord">{selected.place.lat.toFixed(4)}, {selected.place.lon.toFixed(4)}</span>
                  {selected.place.label && <span className="geo-label">{selected.place.label}</span>}
                  <button className="mini-link" onClick={() => setView("map")}>view on map →</button>
                </div>
              </>
            )}
            {selected.relations && selected.relations.length > 0 && (
              <>
                <div className="sect">RELATIONSHIPS ({selected.relations.length})</div>
                <div className="insp-rels">
                  {selected.relations.slice(0, 24).map((r, i) => (
                    <button className="rel-chip" key={i} onClick={() => setSelectedId(r.to)} title={r.source}>
                      <b>{r.kind}</b> {r.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {selected.avatarUrl && (
              <>
                <div className="sect">REVERSE IMAGE · find the same person elsewhere</div>
                <div className="insp-rev">
                  {reverseImageLinks(selected.avatarUrl).map((l) => (
                    <a className="rev-eng" key={l.id} href={l.url} target="_blank" rel="noopener noreferrer" title={l.note}>{l.label} ↗</a>
                  ))}
                  <div className="rev-note">pHash matches the same file; these engines find the same <b>face</b> across different photos. You confirm the visual match.</div>
                </div>
              </>
            )}
            {selected.collectedAt && (
              <div className="insp-custody">⛓ collected {new Date(selected.collectedAt).toLocaleString()} · chain of custody</div>
            )}
            <div className="verbs">
              <button className={"verb on-confirm" + (selected.status === "confirmed" ? " is-confirm" : "")} onClick={() => setStatus(selected.id, "confirmed")}>CONFIRM</button>
              <button className={"verb on-review" + (selected.status === "review" ? " is-review" : "")} onClick={() => setStatus(selected.id, "review")}>REVIEW</button>
              <button className={"verb on-reject" + (selected.status === "rejected" ? " is-reject" : "")} onClick={() => setStatus(selected.id, "rejected")}>REJECT</button>
            </div>
          </>
        )}
      </aside>

      {menu && (() => {
        const n = nodesRef.current.find((x) => x.id === menu.id);
        if (!n) return null;
        const q = n.handle.replace(/^@/, "").replace(/^u\//, "");
        return (
          <>
            <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
            <div className="ctx-menu" style={{ left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 200), top: menu.y }}>
              <div className="ctx-head">{n.platform}</div>
              <button onClick={() => { setSelectedId(n.id); setMenu(null); }}>Inspect evidence</button>
              <button onClick={() => { setMenu(null); pivotOn(n); }}>Pivot</button>
              <button onClick={() => { setMenu(null); autoExpand(n); }}>Auto-expand · 2 hops</button>
              {n.url && <button onClick={() => { window.open(n.url, "_blank", "noopener,noreferrer"); setMenu(null); }}>Open profile</button>}
              <button onClick={() => { seedRef.current = q; setSeed(q); setMenu(null); runScan(); }}>Set as seed &amp; rescan</button>
              <button onClick={() => { setFocusId((f) => (f === n.id ? null : n.id)); setMenu(null); }}>Focus sub-graph</button>
              <button onClick={() => { setMenu(null); pinToBoard(n); }}>Pin to the board</button>
              <button className="ctx-danger" onClick={() => { removeNodeRef.current(n.id); setMenu(null); }}>✕ Remove</button>
            </div>
          </>
        );
      })()}

      {focusId && (
        <button className="focus-chip" onClick={() => setFocusId(null)}>focus active · clear</button>
      )}

      {monitor && (
        <div className="monitor-panel">
          <button className="insp-close" onClick={() => setMonitor(null)} aria-label="close">✕</button>
          <div className="mon-title">CHANGES SINCE LAST SNAPSHOT</div>
          <div className="mon-sum">{monitor.summary}</div>
          {!monitor.hasChanges && <div className="mon-empty">Nothing moved. The footprint is stable.</div>}
          {monitor.added.map((c, i) => (
            <div className={"mon-row " + (c.kind === "new-leak" ? "mon-leak" : "mon-add")} key={"a" + i} onClick={() => { setSelectedId(c.id); setMonitor(null); }}>
              <span className="mon-tag">{c.kind === "new-leak" ? "＋LEAK" : "＋NEW"}</span><span className="mon-label">{c.label}</span><span className="mon-detail">{c.detail}</span>
            </div>
          ))}
          {monitor.changed.map((c, i) => (
            <div className="mon-row mon-chg" key={"c" + i} onClick={() => { setSelectedId(c.id); setMonitor(null); }}>
              <span className="mon-tag">±CHG</span><span className="mon-label">{c.label}</span><span className="mon-detail">{c.detail}</span>
            </div>
          ))}
          {monitor.removed.map((c, i) => (
            <div className="mon-row mon-rem" key={"r" + i}>
              <span className="mon-tag">−GONE</span><span className="mon-label">{c.label}</span><span className="mon-detail">{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {dossier && (
        <div className="add-overlay" onClick={() => { setDossier(null); setNarrative(null); setVerification(null); }}>
          <div className="dossier" onClick={(e) => e.stopPropagation()}>
            <button className="insp-close" onClick={() => { setDossier(null); setNarrative(null); setVerification(null); }} aria-label="close">✕</button>
            <div className="insp-plat">DOSSIER · synthesized identity</div>
            <div className="dossier-name">{dossier.name || "— name not established —"}</div>
            {dossier.nameAlts.length > 0 && <div className="dossier-alts">also: {dossier.nameAlts.join(" · ")}</div>}
            <div className="dossier-score">
              <b>{dossier.identificationScore}</b><span>IDENTIFICATION<br />CONFIDENCE</span>
              <span className="dossier-note">rule-based synthesis of verified nodes — no unsourced inference</span>
            </div>
            {dossier.primaryCluster && (
              <div className={"dossier-cluster t-" + dossier.primaryCluster.tier}>
                {dossier.primaryCluster.size} accounts resolved as one identity · {dossier.primaryCluster.tier.toUpperCase()}
              </div>
            )}
            <button className="pivot-btn" style={{ marginTop: 16 }} onClick={synthesizeDossier} disabled={llmBusy}>
              {llmBusy ? "synthesizing…" : "SYNTHESIZE (grounded LLM brief)"}
            </button>
            {narrative && <div className="narrative">{narrative}</div>}
            {verification && (
              <div className={"verify " + verification.verdict}>
                {verification.verdict === "grounded" ? (
                  <span>✓ grounded · {verification.validCitations}/{verification.totalCitations} citations valid · no unsupported facts</span>
                ) : (
                  <>
                    <span>⚠ {verification.validCitations}/{verification.totalCitations} citations valid
                      {verification.unsupportedFacts.length > 0 && ` · ${verification.unsupportedFacts.length} unsupported fact(s) flagged`}</span>
                    {verification.citations.filter((c) => !c.valid).length > 0 && (
                      <div className="verify-list">unknown citations: {verification.citations.filter((c) => !c.valid).map((c) => c.label).join(", ")}</div>
                    )}
                    {verification.unsupportedFacts.length > 0 && (
                      <div className="verify-list">not in evidence: {verification.unsupportedFacts.join(", ")}</div>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="dossier-grid">
              {dossierBlock("EMAILS", dossier.emails)}
              {dossierBlock("PHONES", dossier.phones)}
              {dossierBlock("LOCATIONS", dossier.locations)}
              {dossierBlock("ALIASES", dossier.aliases)}
            </div>
            <div className="sect">ACCOUNTS ({dossier.accounts.length})</div>
            <div className="dossier-accts">
              {dossier.accounts.length === 0 && <div className="dossier-empty">no accounts yet — run a scan / investigate</div>}
              {dossier.accounts.map((a, i) => (
                <div className="dossier-acct" key={i}>
                  <span className={"da-tier t-" + a.tier}>{a.tier}</span>
                  <span className="da-plat">{a.platform}</span>
                  <span className="da-handle">{a.handle}</span>
                  {a.url && <a className="da-open" href={a.url} target="_blank" rel="noopener noreferrer">↗</a>}
                </div>
              ))}
            </div>
            {dossier.leaks.length > 0 && (
              <>
                <div className="sect">LEAKS ({dossier.leaks.length})</div>
                <div className="dossier-accts">
                  {dossier.leaks.map((l, i) => (
                    <div className="dossier-acct" key={i}><span className="da-plat">{l.platform}</span><span className="da-handle">{l.handle}</span></div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
