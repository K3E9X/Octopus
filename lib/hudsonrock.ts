// Hudson Rock (Cavalier) connector — infostealer intelligence. FREE public OSINT
// endpoints, no key.
//
// This connector used to read five fields out of the stealer record and drop the rest,
// so a node announced "INFOSTEALER" and then had nothing behind it: no credentials, no
// service URLs, no machine detail, nothing to click. It reported that a compromise
// exists and threw the compromise away.
//
// It now harvests the WHOLE record (lib/exposure), schema-agnostically. That is not
// laziness about the schema — it is the fix for how the bug got in. A hard-coded field
// list silently starts dropping data the day the source adds or renames a field, and
// nobody notices, because "no credentials shown" looks identical to "no credentials in
// the data". Harvesting by key-name and value-shape means a new field shows up as a new
// row instead of vanishing.
//
// Masking: whatever the free tier hands over masked stays exactly as it came, labelled
// "masked at source". Octopus does not mask on top of it — inventing a second layer of
// redaction over an already-redacted feed just hides how much the source gave you.

import { normId } from "./extract";
import type { Signal } from "./signals";
import { harvest, exposureVerdict, type ExposureItem } from "./exposure";

const BASE = "https://cavalier.hudsonrock.com/api/json/v2/osint-tools";
const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";

async function getJSON(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
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

/** Host of a login URL, for the node label — the FULL url is kept as the node's url. */
function hostOf(raw: string): string {
  try { return new URL(raw.includes("://") ? raw : "http://" + raw).host.replace(/^www\./, ""); } catch { return raw.slice(0, 40); }
}

function disc(name: string): string {
  return (name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "HR").toUpperCase();
}

/** Exported for tests: the network is the untestable half, the shaping is not. */
export function build(term: string, data: any, apiUrl: string): Signal[] {
  const stealers = Array.isArray(data?.stealers) ? data.stealers : [];
  if (!stealers.length) return [];
  const compId = "hr:comp:" + normId(term);

  // every record, not just the first: two infections on different dates are two
  // findings, and reading only stealers[0] hid the rest of them
  const exposure: ExposureItem[] = [];
  for (const s of stealers) exposure.push(...harvest(s));

  const creds = exposure.filter((e) => e.kind === "credential");
  const logins = exposure.filter((e) => e.kind === "login");
  const machines = exposure.filter((e) => e.kind === "machine");
  const malware = exposure.filter((e) => e.kind === "malware");
  const ips = exposure.filter((e) => e.kind === "ip");
  const dates = exposure.filter((e) => e.kind === "date").map((e) => e.value).sort();

  const ev = (name: string, detail: string, weight: number, url?: string) => ({ name, detail, source: "hudsonrock · cavalier", weight, url });

  const evidence = [
    { ...ev("Infostealer compromise", `${term} appears in ${stealers.length} infostealer log(s). ${exposureVerdict(exposure)}.`, 80, apiUrl) },
    // the credentials are the finding. Listing them as evidence, not just in a side
    // panel, is what makes the score defensible.
    ...(creds.length ? [ev("Credentials exposed",
      creds.slice(0, 12).map((c) => c.value + (c.masked ? " (masked at source)" : "")).join("  ·  ") +
      (creds.length > 12 ? `  … +${creds.length - 12} more` : ""), 88)] : []),
    ...(logins.length ? [ev("Services signed into",
      logins.slice(0, 10).map((l) => hostOf(l.value)).join(" · ") + (logins.length > 10 ? ` … +${logins.length - 10} more` : ""), 70)] : []),
    ...(dates.length ? [ev("Compromise date", dates.length > 1 ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)} (${dates.length} events)` : dates[0].slice(0, 10), 55)] : []),
    ...(machines.length ? [ev("Victim machine", machines.map((m) => m.value).slice(0, 4).join(" · "), 45)] : []),
    ...(malware.length ? [ev("Malware", malware.map((m) => `${m.label}: ${m.value}`).slice(0, 4).join(" · "), 50)] : []),
    ...(ips.length ? [ev("Victim IP", ips.map((i) => i.value).slice(0, 4).join(" · "), 48)] : []),
    { name: "Sensitive source", detail: "Infostealer data. Defensive / legal use only — this is a victim's stolen session, not a target list.", source: "guidance", weight: 15 },
  ];

  const compromised: Signal = {
    id: compId,
    platform: "INFOSTEALER",
    handle: term,
    disc: "HR",
    kind: "leak",
    tier: "probable",
    confidence: 70,
    status: "review",
    url: apiUrl,
    createdAt: dates[0] ? dates[0].slice(0, 10) : undefined,
    exposure,
    evidence,
  };

  // Services the victim logged into become real, pivotable account nodes. The FULL url
  // is kept: a bare host loses the subdomain, the tenant and the path, which is the part
  // that tells you WHICH instance of a service this was.
  const byHost = new Map<string, string>();
  for (const l of logins) {
    const h = hostOf(l.value);
    if (h && !byHost.has(h)) byHost.set(h, l.value);
  }
  const services: Signal[] = [...byHost.entries()].slice(0, 40).map(([host, full]) => ({
    id: "hr:svc:" + normId(host),
    platform: host.toUpperCase(),
    handle: term,
    disc: disc(host),
    kind: "platform" as const,
    tier: "possible" as const,
    confidence: 52,
    status: "candidate" as const,
    linkedIds: [compId],
    url: /^https?:\/\//i.test(full) ? full : undefined,
    evidence: [{
      name: "Service used", detail: `Signed into ${full} — seen in an infostealer log for this identifier.`,
      source: "hudsonrock · cavalier", weight: 60, url: /^https?:\/\//i.test(full) ? full : undefined,
    }],
  }));

  // Silent truncation is how you get a report that quietly under-counts. Say it.
  if (byHost.size > 40) {
    compromised.evidence.push({
      name: "Truncated", detail: `${byHost.size} distinct services in the logs; the graph shows the first 40. The full list is in EXPOSURE.`,
      source: "octopus", weight: 10,
    });
  }
  return [compromised, ...services];
}

export async function hudsonRockEmail(email: string): Promise<Signal[]> {
  const url = `${BASE}/search-by-email?email=${encodeURIComponent(email)}`;
  const d = await getJSON(url);
  return d ? build(email, d, url) : [];
}

export async function hudsonRockUsername(username: string): Promise<Signal[]> {
  const url = `${BASE}/search-by-username?username=${encodeURIComponent(username)}`;
  const d = await getJSON(url);
  return d ? build(username, d, url) : [];
}
