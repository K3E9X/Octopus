"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { SIGNALS, SEED, BANDS, BAND_ORDER, type Signal, type Status } from "@/lib/signals";
import { listCases, saveCase, removeCase, caseToJSON, parseCase, backendMode, type Case } from "@/lib/cases";
import { BUILTIN_APPS, MANUAL_APPS, type AppDef } from "@/lib/registry";
import { loadEnabled, saveEnabled } from "@/lib/apps";
import { normId } from "@/lib/extract";
import { buildDossier, type Dossier } from "@/lib/dossier";
import type { Verification } from "@/lib/verify";
import { scoreEvidence, TIER_LABEL } from "@/lib/scoring";
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
import { handleRarity } from "@/lib/rarity";
import { LLM_PRESETS } from "@/lib/llmconfig";
import type { AssistResult } from "@/lib/assist";

// Leaflet touches window on import — load the map only in the browser.
const MapView = dynamic(() => import("./MapView"), { ssr: false });

interface WorkNode extends Signal {
  x: number; y: number; vx: number; vy: number; op: number; a: number;
}

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

  const [seed, setSeed] = useState(SEED);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [casesOpen, setCasesOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [addForm, setAddForm] = useState<{ platform: string; handle: string; url: string; via: string; note: string; screenshot: string; displayName: string; bio: string; location: string; email: string; avatar: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const ingestRef = useRef<(manual: Signal, extracted: Signal[], links: [string, string][]) => void>(() => {});
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [view, setView] = useState<"board" | "table" | "timeline" | "map">("board");
  const [monitor, setMonitor] = useState<MonitorDiff | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const [barMenu, setBarMenu] = useState<"tools" | "data" | null>(null);
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
    setAssistBusy(true); setAssist(null); setAssistVerdict(null); setBarMenu(null);
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
    setAppsOpen(false);
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
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cx = W / 2; cy = H / 2 + 10; baseR = Math.min(W, H);
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
      });
      el.addEventListener("pointermove", (e) => {
        if (!active) return;
        const mx = e.clientX - ox, my = e.clientY - oy;
        if (Math.abs(mx) + Math.abs(my) > 3) moved = true;
        d.x = px + mx; d.y = py + my;
      });
      const end = () => { if (!active) return; active = false; el.classList.remove("drag"); draggingRef.current = null; setTimeout(() => { moved = false; }, 40); };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("click", () => { if (!moved) setSelectedId(d.id); });
    }

    function makeEl(d: WorkNode) {
      const el = document.createElement("div");
      el.className = "body";
      el.dataset.kind = d.kind || "platform";
      const discContent = d.kind === "email" ? "✉" : d.kind === "alias" ? "~" : d.kind === "phone" ? "☎" : d.kind === "location" ? "⌖" : d.kind === "leak" ? "⚠" : d.kind === "person" ? "◆" : d.kind === "org" ? "▣" : d.kind === "domain" ? "◇" : d.disc;
      el.innerHTML = `<div class="disc">${discContent}</div><div class="tag">${escapeHtml(d.handle)}</div><div class="conf">${d.confidence}%</div>`;
      bodiesEl.appendChild(el);
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

    function step() {
      const nodes = nodesRef.current;
      const K_RAD = 0.02, K_REP = 1400, DAMP = 0.86;
      for (let i = 0; i < nodes.length; i++) {
        const d = nodes[i];
        if (d === draggingRef.current) continue;
        const dx = d.x - cx, dy = d.y - cy, dist = Math.hypot(dx, dy) || 0.001;
        const f = (targetRadius(d) - dist) * K_RAD;
        let fx = (dx / dist) * f, fy = (dy / dist) * f;
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
      ctx.clearRect(0, 0, W, H);
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

    resize();
    rebuild(SIGNALS, false);
    step();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
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
    setCasesOpen(false);
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
    const blob = new Blob([caseToJSON(c)], { type: "application/json" });
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
    setCasesOpen(false);
    flashMsg(`imported "${c.name}"`);
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

      <div className="chrome">
        <div className="wordmark"><Logo size={22} className="wm-logo" />OCTOPUS <small>ORBIT</small></div>
        <label className="seed-in">
          <span>seed</span>
          <input
            value={seed} spellCheck={false}
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runScan(); }}
            aria-label="seed"
          />
        </label>
        <div className="viewtoggle">
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>ORBIT</button>
          <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>TABLE</button>
          <button className={view === "timeline" ? "on" : ""} onClick={() => setView("timeline")}>TIMELINE</button>
          <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>MAP</button>
        </div>
        <div className="flex" />
        <div className="readout">
          {(deepStatus || scanMsg) && <span className="rd-msg">{deepStatus || scanMsg}</span>}
          {isDemo && <span className="demo-tag">sample data — scan a seed to start</span>}
          <span className="hide-sm"><span className="dotpulse" /><b>{total}</b> signals</span>
          <span className="hide-sm"><b style={{ color: "var(--confirm)" }}>{confirmedCount}</b> confirmed</span>

          <button className="btn btn-primary" onClick={investigate} disabled={scanning}>INVESTIGATE</button>
          <button className="btn" onClick={runScan} disabled={scanning}>{scanning ? "…" : "SCAN"}</button>

          <div className="cases-wrap">
            <button className={"btn" + (barMenu === "tools" ? " open" : "")} onClick={() => setBarMenu((m) => (m === "tools" ? null : "tools"))}>TOOLS ▾</button>
            {barMenu === "tools" && (
              <div className="menu-pop">
                <button className="menu-item" disabled={assistBusy} onClick={runAssist}><b>Ask the assistant</b><span>LLM reads the graph → conclusion, pivots, false positives</span></button>
                <button className="menu-item" onClick={() => { setBarMenu(null); deepScan(); }}><b>Deep scan</b><span>3000+ sites via the collector worker</span></button>
                <button className="menu-item" onClick={() => { setBarMenu(null); imageForensics(); }}><b>Image metadata</b><span>EXIF / GPS from a photo URL</span></button>
                <button className="menu-item" disabled={faceBusy} onClick={() => { setBarMenu(null); faceMatch(); }}><b>Face match</b><span>Same person across different photos</span></button>
                <button className="menu-item" onClick={() => { setBarMenu(null); openOnion(); }}><b>Open hidden service</b><span>Retrieve a .onion through Tor → emails, wallets, keys, handles</span></button>
                <button className="menu-item" disabled={monitoring} onClick={() => { setBarMenu(null); runMonitor(); }}><b>Monitor changes</b><span>Re-scan and diff since last snapshot</span></button>
              </div>
            )}
          </div>

          <button className="btn" onClick={openDossier}>DOSSIER</button>
          <button className="btn" onClick={() => openAddForm()}>ADD FINDING</button>

          <div className="cases-wrap">
            <button className={"btn" + (barMenu === "data" ? " open" : "")} onClick={() => setBarMenu((m) => (m === "data" ? null : "data"))}>DATA ▾</button>
            {barMenu === "data" && (
              <div className="menu-pop">
                <button className="menu-item" onClick={() => { setBarMenu(null); saveCurrent(); }}><b>Save case</b><span>Store the current board</span></button>
                <button className="menu-item" onClick={() => { setBarMenu(null); exportCurrent(); }}><b>Export JSON</b><span>Download the case file</span></button>
                <button className="menu-item" onClick={() => { setBarMenu(null); exportGraphML(); }}><b>Export graph (GraphML)</b><span>Open in flowsint / Maltego / Gephi</span></button>
                <button className="menu-item" onClick={() => { setBarMenu(null); fileRef.current?.click(); }}><b>Import JSON</b><span>Load a case file</span></button>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={importFile} style={{ display: "none" }} />

          <div className="cases-wrap">
            <button className="btn" onClick={() => setAppsOpen((o) => !o)}>
              APPS ({[...enabled].filter((id) => BUILTIN_APPS.some((a) => a.id === id)).length}/{BUILTIN_APPS.length})
            </button>
            {appsOpen && (
              <div className="apps-pop">
                <div className="cases-head">connectors — toggle to include in the scan</div>
                {BUILTIN_APPS.map((a) => (
                  <div className="app-row" key={a.id}>
                    <button className={"app-toggle" + (enabled.has(a.id) ? " on" : "")} onClick={() => toggleApp(a.id)} aria-label="toggle">
                      <span className="app-sw" />
                    </button>
                    <div className="app-info">
                      <span className="app-name">{a.name} <em>{a.category}</em></span>
                      <span className="app-desc">{a.desc}</span>
                    </div>
                  </div>
                ))}
                <div className="cases-head">manual pivots (cipher387) — add &amp; open with the seed</div>
                {MANUAL_APPS.map((a) => (
                  <div className="app-row" key={a.id}>
                    <button className={"app-add" + (enabled.has(a.id) ? " added" : "")} onClick={() => toggleApp(a.id)}>
                      {enabled.has(a.id) ? "✓" : "+"}
                    </button>
                    <div className="app-info">
                      <span className="app-name">{a.name} <em>{a.category}</em> <b className={"app-badge " + a.status}>{a.status}</b></span>
                      <span className="app-desc">{a.desc}</span>
                    </div>
                    {enabled.has(a.id) && <button className="app-open" onClick={() => openTool(a)} aria-label="open">↗</button>}
                    {enabled.has(a.id) && <button className="app-open" onClick={() => openAddForm(a.name)} aria-label="add result" title="add a result to the board">＋</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="cases-wrap">
            <button className="btn" onClick={async () => { setCases(await listCases()); setCasesOpen((o) => !o); }}>
              CASES{cases.length ? ` (${cases.length})` : ""}
            </button>
            {casesOpen && (
              <div className="cases-pop">
                <div className="cases-head">stored: {backendMode() || "…"}</div>
                {cases.length === 0 && <div className="cases-empty">no saved case</div>}
                {cases.map((c) => (
                  <div className="case-row" key={c.id}>
                    <button className="case-open" onClick={() => openCase(c)}>
                      <span className="case-name">{c.name}</span>
                      <span className="case-meta">{c.signals.length} signals · {new Date(c.savedAt).toLocaleDateString()}</span>
                    </button>
                    <button className="case-del" onClick={() => deleteCase(c.id)} aria-label="delete">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="btn" onClick={() => setApiOpen(true)}>API</button>
          <button className="btn" onClick={() => setGuideOpen(true)}>GUIDE</button>
          {barMenu && <div className="menu-backdrop" onClick={() => setBarMenu(null)} />}
        </div>
      </div>

      {view === "board" && (
        <>
          <div className="legend">
            {BAND_ORDER.map((k) => (
              <div className="l" key={k}><span className="tick" />{BANDS[k].label}</div>
            ))}
          </div>
          <div className="hint">Enter a seed (username, email, phone, name or domain) and press INVESTIGATE&nbsp;&nbsp;/&nbsp;&nbsp;click a node for its evidence&nbsp;&nbsp;/&nbsp;&nbsp;right-click to pivot&nbsp;&nbsp;/&nbsp;&nbsp;new here? open GUIDE</div>
        </>
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
              <li><b>Type a seed</b> in the top-left field and press <b>INVESTIGATE</b>. Octopus scans, correlates and expands automatically, then opens the dossier.</li>
              <li>Prefer manual control? Use <b>SCAN</b> for a single pass, then expand yourself.</li>
            </ol>

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
