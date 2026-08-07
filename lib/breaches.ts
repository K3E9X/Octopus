// Breach sources that return CONTENT, not just a verdict.
//
// Why this file exists: Hudson Rock's free tier masks nearly everything it returns.
// A real lookup comes back as `M*********5`, `n*********@gmail.com`, `129.45.**.**`.
// That masking happens at their end and no amount of client code undoes it — pretending
// otherwise would be lying to the analyst. The honest answer is to go and get the same
// facts from sources that do not mask, and to state plainly, per row, which is which.
//
// The three here are keyless and free:
//
//   proxynova   COMB / combolist index. Returns `login:password` lines IN CLEAR. This is
//               the one that actually answers "can I have the password".
//   xposedornot breach catalogue: which breaches an address is in, and — the useful part —
//               WHICH FIELD CLASSES each breach exposed (passwords, addresses, phone…).
//   leakcheck   public endpoint: breach names and dates, plus the field list. No content
//               on the free tier, and it says so rather than implying otherwise.
//
// Everything is normalised into ExposureItem and merged with the other sources, so the
// analyst reads one list per identity instead of four panels that each know a third of
// the story.

import type { Signal } from "./signals";
import { normId } from "./extract";
import { harvest, mergeExposure, type ExposureItem } from "./exposure";

const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";

async function getJSON(url: string, ms = 12000): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- ProxyNova: combolist lines, unmasked -------------------------------------

const COMB = "https://api.proxynova.com/comb";

/**
 * Split a combolist line. The separator is normally ':' but the LOCAL PART of an email
 * can itself contain one, so split on the LAST colon that still leaves a plausible
 * identifier on the left — splitting on the first one silently corrupts the password.
 */
export function splitCombo(line: string): { login: string; secret: string } | null {
  const s = String(line || "").trim();
  if (!s) return null;
  const i = s.lastIndexOf(":");
  if (i <= 0 || i === s.length - 1) return null;
  const login = s.slice(0, i).trim();
  const secret = s.slice(i + 1).trim();
  if (!login || !secret) return null;
  return { login, secret };
}

/**
 * Find the combolist lines in a response without betting on the key they arrive under.
 * The documented field is `lines`, but a feed that renames it would otherwise turn into
 * a silent zero — the exact failure mode this whole area was rebuilt to remove. Any
 * array of `login:secret`-shaped strings is what we are after, wherever it sits.
 */
export function linesFrom(payload: any): string[] {
  if (Array.isArray(payload?.lines)) return payload.lines.filter((x: unknown) => typeof x === "string");
  const looksLikeCombo = (a: unknown[]) =>
    a.length > 0 && a.every((x) => typeof x === "string") && a.some((x) => splitCombo(x as string));
  for (const v of Object.values(payload || {})) {
    if (Array.isArray(v) && looksLikeCombo(v)) return v as string[];
  }
  return [];
}

export async function proxyNova(term: string, limit = 25): Promise<ExposureItem[]> {
  const d = await getJSON(`${COMB}?query=${encodeURIComponent(term)}&start=0&limit=${limit}`);
  const lines = linesFrom(d);
  const out: ExposureItem[] = [];
  for (const raw of lines) {
    const parts = splitCombo(raw);
    if (!parts) continue;
    out.push({ kind: "record", label: "COMB line", value: raw, source: "proxynova" });
    out.push({ kind: "identifier", label: "Login", value: parts.login, source: "proxynova" });
    // in clear — that is the whole point of this source
    out.push({ kind: "credential", label: "Password", value: parts.secret, source: "proxynova" });
  }
  return out;
}

// ---- XposedOrNot: which breaches, and which field classes leaked ----------------

const XON = "https://api.xposedornot.com/v1";

export async function xposedOrNot(email: string): Promise<ExposureItem[]> {
  const d = await getJSON(`${XON}/breach-analytics?email=${encodeURIComponent(email)}`);
  if (!d) return [];
  const out: ExposureItem[] = [];
  const details: any[] = d?.ExposedBreaches?.breaches_details || [];
  for (const b of details) {
    const name = String(b?.breach || "").trim();
    if (!name) continue;
    const when = String(b?.xposed_date || "").trim();
    out.push({ kind: "breach", label: "Breach", value: when ? `${name} (${when})` : name, source: "xposedornot" });
    // The field classes are the operational part: "this breach leaked passwords" tells
    // you whether it is worth chasing the dump, which a breach name alone does not.
    for (const f of String(b?.xposed_data || "").split(/[;,]/).map((x: string) => x.trim()).filter(Boolean)) {
      out.push({ kind: "field", label: `Leaked in ${name}`, value: f, source: "xposedornot" });
    }
  }
  // The documented shape gave us nothing but the endpoint answered: harvest the payload
  // rather than report a clean result off a response we simply failed to read.
  if (!out.length) return harvest(d).map((i) => ({ ...i, source: "xposedornot" }));
  return out;
}

// ---- LeakCheck public: breach names, explicitly no content ----------------------

export async function leakCheckPublic(email: string): Promise<ExposureItem[]> {
  const d = await getJSON(`https://leakcheck.io/api/public?check=${encodeURIComponent(email)}`);
  if (!d?.success || !d?.found) return [];
  const out: ExposureItem[] = [];
  for (const s of (Array.isArray(d.sources) ? d.sources : [])) {
    const name = String(s?.name || "").trim();
    if (!name) continue;
    out.push({ kind: "breach", label: "Breach", value: s?.date ? `${name} (${s.date})` : name, source: "leakcheck" });
  }
  for (const f of (Array.isArray(d.fields) ? d.fields : [])) {
    out.push({ kind: "field", label: "Field class exposed", value: String(f), source: "leakcheck" });
  }
  if (!out.length) return harvest(d).map((i) => ({ ...i, source: "leakcheck" }));
  return out;
}

// ---- one node per identity ------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Query every keyless breach source for one selector and fold the answers together.
 * Sources run concurrently and a failure is a missing source, never a failed scan —
 * a rate-limited index did not say "clean", it said nothing, and the caller has to be
 * able to tell those apart.
 */
export async function breachExposure(term: string): Promise<{ items: ExposureItem[]; reached: string[]; silent: string[] }> {
  const isEmail = EMAIL_RE.test(term);
  const jobs: { id: string; run: () => Promise<ExposureItem[]> }[] = [
    { id: "proxynova", run: () => proxyNova(term) },
    ...(isEmail ? [
      { id: "xposedornot", run: () => xposedOrNot(term) },
      { id: "leakcheck", run: () => leakCheckPublic(term) },
    ] : []),
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const items: ExposureItem[] = [];
  const reached: string[] = [];
  const silent: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") { reached.push(jobs[i].id); items.push(...r.value); }
    else silent.push(jobs[i].id);
  });
  return { items, reached, silent };
}

export function breachSignal(term: string, res: { items: ExposureItem[]; reached: string[]; silent: string[] }, collectedAt: string): Signal[] {
  const { reached, silent } = res;
  // fold the sources together: one row per fact, crediting every index that had it, and
  // preferring the unmasked copy wherever two sources disagree about how much to show
  const items = mergeExposure(res.items);
  if (!items.length) return [];
  const creds = items.filter((i) => i.kind === "credential" && !i.masked);
  const breaches = [...new Set(items.filter((i) => i.kind === "breach").map((i) => i.value))];

  return [{
    id: "breach:" + normId(term),
    platform: "BREACH DATA",
    handle: term,
    disc: "BR",
    kind: "leak",
    tier: creds.length ? "probable" : "possible",
    confidence: creds.length ? 74 : 55,
    status: "review",
    collectedAt,
    exposure: items,
    evidence: [
      {
        name: creds.length ? "Credentials recovered in clear" : "Present in breach data",
        detail: creds.length
          ? creds.slice(0, 10).map((c) => c.value).join("  ·  ") + (creds.length > 10 ? `  … +${creds.length - 10} more` : "")
          : `${term} appears in breach indexes, but no source returned a usable credential.`,
        source: [...new Set(items.map((i) => i.source).filter(Boolean))].join(" · ") || "breach indexes",
        weight: creds.length ? 86 : 58,
      },
      ...(breaches.length ? [{
        name: `Named breaches (${breaches.length})`,
        detail: breaches.slice(0, 12).join(" · ") + (breaches.length > 12 ? ` … +${breaches.length - 12} more` : ""),
        source: "xposedornot · leakcheck",
        weight: 64,
      }] : []),
      // A source that did not answer did NOT say "clean". Saying which ones were silent
      // is what stops an incomplete sweep from reading as a negative result.
      ...(silent.length ? [{
        name: "Sources that did not answer",
        detail: `${silent.join(", ")} — unreachable or rate-limited. This is not a negative result.`,
        source: "octopus", weight: 10,
      }] : []),
      { name: "Sources reached", detail: reached.join(", ") || "none", source: "octopus", weight: 10 },
    ],
  }];
}
