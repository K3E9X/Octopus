// The live session — what you were working on when you closed the tab.
//
// Cases are saved deliberately. A session is saved CONTINUOUSLY, because losing an
// investigation to a page refresh is not a storage problem, it is the tool throwing
// your work away. Before this existed, a reload silently restored the demo graph under
// the demo seed: the analyst's board was still in localStorage, but keyed to their real
// seed, so it was intact and unreachable at the same time — which reads as "gone".
//
// Deliberately separate from lib/cases: a case is a decision to keep something, a
// session is just where you are. Restoring one must never overwrite the other.

import type { Signal } from "./signals";

const KEY = "octopus:session:v1";
/** localStorage is ~5 MB; stay well under it so a big graph cannot wedge the app. */
const MAX_BYTES = 2_000_000;
const MAX_SIGNALS = 600;

export interface LiveSession {
  seed: string;
  mode: string;
  signals: Signal[];
  view?: string;
  savedAt: number;
}

export function saveSession(s: Omit<LiveSession, "savedAt">): void {
  if (typeof window === "undefined") return;
  if (!s.seed || !s.signals?.length) return;
  try {
    const payload: LiveSession = { ...s, signals: s.signals.slice(0, MAX_SIGNALS), savedAt: Date.now() };
    const json = JSON.stringify(payload);
    // a graph too large to store is not a reason to store nothing: drop the weakest
    // nodes rather than lose the session
    if (json.length > MAX_BYTES) {
      const trimmed = [...payload.signals].sort((a, b) => b.confidence - a.confidence).slice(0, 200);
      window.localStorage.setItem(KEY, JSON.stringify({ ...payload, signals: trimmed }));
      return;
    }
    window.localStorage.setItem(KEY, json);
  } catch { /* quota or private mode — the session is a convenience, never a dependency */ }
}

export function loadSession(): LiveSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.seed !== "string" || !Array.isArray(s.signals) || !s.signals.length) return null;
    return s as LiveSession;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** "2 hours ago" — so the analyst knows whether what came back is still current. */
export function sessionAge(savedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - savedAt) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
