// Domain / infrastructure enrichment — the flowsint idea (automatic infra enrichers),
// folded into Octopus's identity engine. The smart part isn't "look up DNS": it's
// making infrastructure feed the PERSON graph. A personal domain gives up its
// registrant (name / email / org via RDAP), its mail + hosting (DNS), its other
// domains (shared TLS certs), and a hosting geolocation — each normalized into the
// same Signal graph and correlated/scored like everything else. All keyless, all
// graceful. This is what flowsint doesn't do: bridge infra → identity.

import type { Signal, Evidence } from "./signals";
import { fingerprintSite, infraSignals } from "./infrapivot";

const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";

// broad but bounded TLD set so we don't mistake "john.doe" for a domain
const TLDS = new Set([
  "com", "net", "org", "io", "co", "me", "dev", "app", "xyz", "info", "biz", "eu", "de", "fr",
  "uk", "us", "ca", "au", "nl", "it", "es", "ch", "se", "no", "ru", "pl", "in", "jp", "cn", "br",
  "tech", "site", "online", "store", "blog", "cloud", "ai", "gg", "tv", "id", "sh", "to", "cc",
  "email", "pro", "live", "life", "digital", "media", "agency", "studio", "art", "design",
]);

export function looksLikeDomain(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (t.includes("@") || /\s/.test(t)) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(t)) return false;
  const tld = t.split(".").pop() || "";
  return TLDS.has(tld);
}

async function getJSON(url: string, accept = "application/json", timeoutMs = 7000): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: accept }, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Pull registrant identity + dates from RDAP (modern WHOIS, keyless). */
function parseVcard(entity: any): { name?: string; email?: string; org?: string } {
  const arr = entity?.vcardArray?.[1];
  if (!Array.isArray(arr)) return {};
  const out: { name?: string; email?: string; org?: string } = {};
  for (const item of arr) {
    if (!Array.isArray(item)) continue;
    const [prop, , , value] = item;
    if (typeof value !== "string") continue;
    if (prop === "fn" && !/redacted|privacy|whois|domain admin/i.test(value)) out.name = value;
    else if (prop === "email" && !/redacted|privacy/i.test(value)) out.email = value.toLowerCase();
    else if (prop === "org" && !/redacted|privacy/i.test(value)) out.org = value;
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface DomainResult { signals: Signal[]; edges: [string, string][] }

/**
 * Enrich a domain and bridge it to the identity graph.
 * `personId` (optional) links everything back to a person node already on the board.
 */
export async function enrichDomain(domain: string, collectedAt: string, personId?: string): Promise<DomainResult> {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!looksLikeDomain(d)) return { signals: [], edges: [] };
  const domId = "domain:" + norm(d);
  const signals: Signal[] = [];
  const edges: [string, string][] = [];
  const have = new Set<string>();
  const add = (s: Signal) => { if (!have.has(s.id)) { have.add(s.id); signals.push(s); } };
  const link = (a: string, b: string) => { if (a !== b) edges.push([a, b]); };

  const domEvidence: Evidence[] = [{ name: "Domain", detail: `${d} — infrastructure root.`, source: "seed / extraction", weight: 40 }];
  const domNode: Signal = { id: domId, platform: "DOMAIN", handle: d, disc: "DN", kind: "domain", confidence: 45, tier: "possible", status: "review", url: `https://${d}`, collectedAt, evidence: domEvidence };
  add(domNode);
  if (personId) link(domId, personId);

  const [rdap, dnsA, dnsMX, dnsTXT, crt] = await Promise.all([
    getJSON(`https://rdap.org/domain/${encodeURIComponent(d)}`),
    getJSON(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=A`),
    getJSON(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=MX`),
    getJSON(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=TXT`),
    getJSON(`https://crt.sh/?q=${encodeURIComponent(d)}&output=json`, "application/json", 9000),
  ]);

  // --- RDAP: registrant identity + registration/expiry dates ---
  if (rdap) {
    const events = Array.isArray(rdap.events) ? rdap.events : [];
    const reg = events.find((e: any) => e.eventAction === "registration")?.eventDate;
    if (reg) { domNode.createdAt = String(reg).slice(0, 10); domEvidence.push({ name: "Domain registered", detail: `Registered ${String(reg).slice(0, 10)}.`, source: "RDAP", weight: 40 }); }
    const entities = Array.isArray(rdap.entities) ? rdap.entities : [];
    for (const ent of entities) {
      const roles = Array.isArray(ent.roles) ? ent.roles : [];
      if (!roles.includes("registrant") && !roles.includes("administrative")) continue;
      const v = parseVcard(ent);
      if (v.email) {
        const eid = "attr:email:" + norm(v.email);
        add({ id: eid, platform: "EMAIL", handle: v.email, disc: "EM", kind: "email", confidence: 62, tier: "probable", status: "review", collectedAt, evidence: [{ name: "Domain registrant email", detail: `Registrant of ${d} (WHOIS/RDAP) — a strong, declared link to the owner.`, source: "RDAP", weight: 74 }] });
        link(domId, eid); if (personId) link(eid, personId);
      }
      if (v.name) {
        const pid = "person:" + norm(v.name);
        add({ id: pid, platform: "PERSON", handle: v.name, disc: "PR", kind: "person", confidence: 58, tier: "probable", status: "review", collectedAt, evidence: [{ name: "Domain registrant name", detail: `Registrant of ${d} (RDAP).`, source: "RDAP", weight: 66 }] });
        link(domId, pid);
      }
      if (v.org) {
        const oid = "attr:org:" + norm(v.org).slice(0, 40);
        add({ id: oid, platform: "ORG", handle: v.org, disc: "OG", kind: "org", confidence: 50, tier: "possible", status: "review", collectedAt, evidence: [{ name: "Registrant organisation", detail: `${v.org} — registrant org of ${d}.`, source: "RDAP", weight: 55 }] });
        link(domId, oid);
      }
    }
  }

  // --- DNS: mail provider (MX) + hosting IP (A) + verification hints (TXT) ---
  const aRecords = (dnsA?.Answer || []).filter((r: any) => r.type === 1).map((r: any) => String(r.data)).slice(0, 2);
  const mx = (dnsMX?.Answer || []).map((r: any) => String(r.data).split(/\s+/).pop()).filter(Boolean).slice(0, 3);
  for (const host of mx) {
    const clean = String(host).replace(/\.$/, "");
    const mid = "domain:" + norm(clean);
    add({ id: mid, platform: "MAIL HOST", handle: clean, disc: "MX", kind: "domain", confidence: 40, tier: "weak", status: "candidate", collectedAt, evidence: [{ name: "Mail server (MX)", detail: `${d} routes mail via ${clean}.`, source: "DNS", weight: 40 }] });
    link(domId, mid);
  }
  const txt = (dnsTXT?.Answer || []).map((r: any) => String(r.data).replace(/^"|"$/g, "")).filter(Boolean);
  const providerHints = txt.filter((t: string) => /include:|google-site-verification|MS=|facebook-domain|atlassian|zoho|protonmail/i.test(t)).slice(0, 3);
  if (providerHints.length) domEvidence.push({ name: "Service hints (TXT/SPF)", detail: providerHints.join(" · ").slice(0, 180), source: "DNS TXT", weight: 38 });

  // --- IP → geolocation + ASN (hosting) ---
  if (aRecords.length) {
    const ip = aRecords[0];
    const ipId = "domain:ip:" + norm(ip);
    const ipNode: Signal = { id: ipId, platform: "IP", handle: ip, disc: "IP", kind: "domain", confidence: 38, tier: "weak", status: "candidate", collectedAt, evidence: [{ name: "Resolves to IP", detail: `${d} → ${ip}.`, source: "DNS A", weight: 40 }] };
    add(ipNode); link(domId, ipId);
    const geo = await getJSON(`https://ipwho.is/${encodeURIComponent(ip)}`);
    if (geo?.success) {
      if (geo.connection?.org || geo.connection?.asn) ipNode.evidence.push({ name: "Hosting / ASN", detail: `AS${geo.connection?.asn || "?"} · ${geo.connection?.org || geo.connection?.isp || ""}`.trim(), source: "ipwho.is", weight: 40 });
      if (typeof geo.latitude === "number" && typeof geo.longitude === "number") {
        const coords = `${geo.latitude.toFixed(5)}, ${geo.longitude.toFixed(5)}`;
        const locId = "attr:location:" + coords.replace(/[^0-9\-]/g, "");
        add({ id: locId, platform: "LOCATION", handle: coords, disc: "GEO", kind: "location", confidence: 34, tier: "weak", status: "candidate", collectedAt, place: { lat: geo.latitude, lon: geo.longitude, label: [geo.city, geo.country].filter(Boolean).join(", ") }, evidence: [{ name: "Server location", detail: `Hosting of ${d}: ${[geo.city, geo.country].filter(Boolean).join(", ")} — WEAK (server ≠ person, but converges).`, source: "ipwho.is", weight: 30 }] });
        link(ipId, locId);
      }
    }
  }

  // --- crt.sh: subdomains (attack surface) + a hint of related domains ---
  if (Array.isArray(crt)) {
    const subs = new Set<string>();
    for (const c of crt) {
      for (const nv of String(c.name_value || "").split("\n")) {
        const s = nv.trim().toLowerCase();
        if (s && !s.startsWith("*") && s.endsWith("." + d) && s !== d) subs.add(s);
      }
    }
    for (const s of [...subs].slice(0, 8)) {
      const sid = "domain:" + norm(s);
      add({ id: sid, platform: "SUBDOMAIN", handle: s, disc: "SD", kind: "domain", confidence: 36, tier: "weak", status: "candidate", collectedAt, url: `https://${s}`, evidence: [{ name: "Subdomain (cert transparency)", detail: `${s} — seen in a TLS certificate for ${d}.`, source: "crt.sh", weight: 38 }] });
      link(domId, sid);
    }
    if (subs.size) domEvidence.push({ name: "Attack surface", detail: `${subs.size} subdomain(s) via certificate transparency.`, source: "crt.sh", weight: 36 });
  }

  // --- infrastructure fingerprint: analytics account IDs + favicon hash ---
  // The strongest owner links available from one page fetch: an analytics ID is
  // per-account, so any other site carrying it belongs to the same operator.
  try {
    const fp = await fingerprintSite(d);
    const inf = infraSignals(d, fp, collectedAt);
    for (const s of inf.signals) add(s);
    for (const [a, b] of inf.edges) link(a, b);
    if (fp.analytics.length) {
      domEvidence.push({
        name: "Analytics account",
        detail: `${fp.analytics.map((a) => a.id).join(", ")} — pivot these to find sibling sites owned by the same operator.`,
        source: "page source", weight: 70,
      });
    }
  } catch { /* infra fingerprint is a bonus, never fatal */ }

  return { signals, edges };
}
