// Infrastructure selectors — an IP, a file hash, a certificate fingerprint.
//
// A CTI analyst very often starts from an IOC, not from a handle: an address in a log,
// a hash from a sandbox, a certificate from a TLS scan. Until now none of those were
// even recognised as input — typing an IP got you a username search for "1.2.3.4".
//
// Everything here is keyless and passive. No connection is ever made to the address
// under investigation: RDAP answers about it, DNS answers about it, certificate
// transparency answers about it. Contacting the host itself would announce the
// investigation to the very infrastructure being investigated.

import { isIP } from "node:net";
import { hashKind, type HashKind } from "./selectors";
import { fetchJSON } from "./netfetch";
import type { Signal } from "./signals";

// ---- recognition -------------------------------------------------------------

/**
 * Node's own parser, not a regular expression. A hand-written IPv6 pattern has to get
 * :: compression right in every position, and mine did not — "2001:4860:4860::8888"
 * was rejected. There is no reason to reimplement something the runtime does correctly.
 */
export function looksLikeIp(s: string): boolean {
  return isIP(s.trim()) !== 0;
}

// the digest predicates are pure and live in lib/selectors, so a browser can ask too
export { hashKind, looksLikeHash } from "./selectors";
export type { HashKind } from "./selectors";

// ---- IP ----------------------------------------------------------------------

export interface IpIntel {
  ip: string;
  version: 4 | 6;
  /** RFC1918 / loopback / link-local — nothing public will ever answer about these */
  private: boolean;
  ptr: string[];
  /** the allocated network, from RDAP */
  network?: string;
  org?: string;
  country?: string;
  /** abuse contact, the one field that actually gets things taken down */
  abuse?: string;
  /** RDAP registration/last-change dates */
  registered?: string;
  updated?: string;
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return /^(::1|fe80:|fc|fd)/i.test(ip);
  const p = ip.split(".").map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

/** Reverse DNS over DoH — no resolver of ours is asked, and the host is never touched. */
async function reverseDns(ip: string): Promise<string[]> {
  if (ip.includes(":")) return [];
  const arpa = ip.split(".").reverse().join(".") + ".in-addr.arpa";
  const r = await fetchJSON<any>(`https://dns.google/resolve?name=${encodeURIComponent(arpa)}&type=PTR`, { timeoutMs: 6000 });
  if (r.outcome !== "ok") return [];
  return (r.data?.Answer || [])
    .filter((a: any) => a.type === 12)
    .map((a: any) => String(a.data || "").replace(/\.$/, ""))
    .slice(0, 4);
}

export async function ipIntel(ip: string): Promise<IpIntel> {
  const t = ip.trim();
  const out: IpIntel = { ip: t, version: t.includes(":") ? 6 : 4, private: isPrivateIp(t), ptr: [] };
  if (out.private) return out;

  const [rdap, ptr] = await Promise.all([
    fetchJSON<any>(`https://rdap.org/ip/${encodeURIComponent(t)}`, { timeoutMs: 8000 }),
    reverseDns(t),
  ]);
  out.ptr = ptr;
  if (rdap.outcome === "ok" && rdap.data) {
    const d = rdap.data;
    out.network = [d.startAddress, d.endAddress].filter(Boolean).join(" – ") || d.handle || undefined;
    out.country = d.country || undefined;
    out.org = d.name || undefined;
    for (const e of d.entities || []) {
      const roles: string[] = e.roles || [];
      const vcard: any[] = e.vcardArray?.[1] || [];
      const fn = vcard.find((x) => x[0] === "fn")?.[3];
      const email = vcard.find((x) => x[0] === "email")?.[3];
      if (roles.includes("abuse") && email) out.abuse = email;
      if (!out.org && (roles.includes("registrant") || roles.includes("administrative")) && fn) out.org = fn;
    }
    for (const ev of d.events || []) {
      if (ev.eventAction === "registration") out.registered = ev.eventDate;
      if (ev.eventAction === "last changed") out.updated = ev.eventDate;
    }
  }
  return out;
}

export function ipSignals(i: IpIntel, collectedAt: string): Signal[] {
  const id = "ip:" + i.ip.replace(/[^a-z0-9]/gi, "");
  const ev: Signal["evidence"] = [];

  if (i.private) {
    ev.push({
      name: "Private address — nothing public can be learned (contradicts an internet host)",
      detail: `${i.ip} is in a private, loopback or link-local range. It identifies a machine inside someone's network, and no registry or resolver on the internet can say whose. It is only meaningful next to the logs it came from.`,
      source: "address space",
      weight: 70,
    });
  } else {
    ev.push({
      name: "Network registration (RDAP)",
      detail: `${i.network || "network unknown"}${i.org ? ` — ${i.org}` : ""}${i.country ? ` (${i.country})` : ""}` +
        `${i.registered ? `, registered ${String(i.registered).slice(0, 10)}` : ""}.`,
      source: "rdap.org",
      weight: 70,
    });
    if (i.abuse) {
      ev.push({
        name: "Abuse contact published",
        detail: `${i.abuse} — the address the network operator publishes for reports about this range.`,
        source: "rdap.org",
        weight: 55,
      });
    }
    if (i.ptr.length) {
      ev.push({
        name: "Reverse DNS",
        detail: `${i.ip} resolves back to ${i.ptr.join(", ")}. A PTR is set by the network operator, so it names the HOSTING, which is not necessarily the tenant.`,
        source: "DNS (PTR)",
        weight: 50,
      });
    } else {
      ev.push({
        name: "No reverse DNS (presence detected only)",
        detail: "The operator publishes no PTR for this address. Common on residential and cloud ranges; it says nothing either way about what runs there.",
        source: "DNS (PTR)",
        weight: 20,
      });
    }
  }

  const out: Signal[] = [{
    id, platform: "IP ADDRESS", handle: i.ip, disc: "IP",
    kind: "domain", confidence: 55, status: "review", collectedAt, evidence: ev,
  }];

  // each PTR name is a pivot in its own right: it is a hostname you can enrich
  for (const name of i.ptr.slice(0, 3)) {
    out.push({
      id: "host:" + name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      platform: "HOSTNAME", handle: name, disc: "HN",
      kind: "domain", confidence: 40, status: "candidate", collectedAt,
      url: `https://crt.sh/?q=${encodeURIComponent(name)}`,
      evidence: [{
        name: "Reverse DNS name",
        detail: `Published by the operator of ${i.ip}. Enrich it as a domain to reach the registrant and the certificate history.`,
        source: "DNS (PTR)",
        weight: 45,
      }],
    });
  }
  return out;
}

// ---- file hash ---------------------------------------------------------------

export interface HashIntel {
  hash: string;
  kind: HashKind;
  /** MalwareBazaar: a public sample repository that answers without a key when open */
  known: boolean;
  fileName?: string;
  fileType?: string;
  signature?: string;
  firstSeen?: string;
  tags?: string[];
  /** set when the source refused rather than answered — never treat as "unknown sample" */
  unchecked?: string;
}

export async function hashIntel(hash: string): Promise<HashIntel> {
  const kind = hashKind(hash)!;
  const h = hash.trim().toLowerCase();
  const out: HashIntel = { hash: h, kind, known: false };
  // MalwareBazaar answers on md5/sha1/sha256; anything else it cannot index
  if (kind === "sha512") { out.unchecked = "no keyless source indexes sha512 digests"; return out; }

  const r = await fetchJSON<any>("https://mb-api.abuse.ch/api/v1/", {
    timeoutMs: 9000,
    noCache: false,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  // The endpoint is POST-only; a GET tells us only whether it is reachable. Rather than
  // pretend, we record honestly that the sample was NOT checked and leave the pivot.
  if (r.outcome !== "ok") {
    out.unchecked = "MalwareBazaar did not answer — the sample was not checked, which is not the same as unknown";
  } else {
    out.unchecked = "MalwareBazaar requires an authenticated POST for lookups — pivot manually";
  }
  return out;
}

export function hashSignals(i: HashIntel, collectedAt: string): Signal[] {
  const short = i.hash.slice(0, 12) + "…";
  const ev: Signal["evidence"] = [{
    name: "File digest",
    detail: `${i.kind.toUpperCase()} ${i.hash}. A digest identifies BYTES, not a person: it ties a file to wherever else those exact bytes appear.`,
    source: "input",
    weight: 60,
  }];
  if (i.unchecked) {
    ev.push({
      name: "Not checked against a sample repository (presence detected only)",
      detail: `${i.unchecked}. Absence of a result here is absence of a check, not evidence the file is unknown.`,
      source: "malwarebazaar",
      weight: 15,
    });
  }
  if (i.known) {
    ev.push({
      name: "Known sample",
      detail: `${i.fileName || "sample"}${i.fileType ? ` (${i.fileType})` : ""}${i.signature ? ` — attributed to ${i.signature}` : ""}${i.firstSeen ? `, first seen ${i.firstSeen}` : ""}.`,
      source: "malwarebazaar",
      weight: 80,
    });
  }
  return [{
    id: "hash:" + i.hash.slice(0, 20),
    platform: `${i.kind.toUpperCase()} DIGEST`,
    handle: short,
    disc: "HS",
    kind: "leak",
    confidence: 45,
    status: "review",
    collectedAt,
    url: `https://www.virustotal.com/gui/file/${i.hash}`,
    evidence: ev,
  }];
}

/** External pivots for an IOC, opened by the analyst. Free tiers, no key stored. */
export function iocPivots(value: string, kind: "ip" | "hash"): Signal[] {
  const targets = kind === "ip"
    ? [
        { name: "Shodan", url: `https://www.shodan.io/host/${value}` },
        { name: "Censys", url: `https://search.censys.io/hosts/${value}` },
        { name: "AbuseIPDB", url: `https://www.abuseipdb.com/check/${value}` },
        { name: "GreyNoise", url: `https://viz.greynoise.io/ip/${value}` },
        { name: "VirusTotal", url: `https://www.virustotal.com/gui/ip-address/${value}` },
      ]
    : [
        { name: "VirusTotal", url: `https://www.virustotal.com/gui/file/${value}` },
        { name: "MalwareBazaar", url: `https://bazaar.abuse.ch/browse.php?search=${value}` },
        { name: "Hybrid Analysis", url: `https://www.hybrid-analysis.com/search?query=${value}` },
        { name: "Triage", url: `https://tria.ge/s?q=${value}` },
      ];
  return targets.map((t) => ({
    id: `pivot:${kind}:${t.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    platform: t.name.toUpperCase(),
    handle: t.name,
    disc: t.name.slice(0, 2).toUpperCase(),
    kind: "alias" as const,
    confidence: 20,
    tier: "weak" as const,
    status: "candidate" as const,
    url: t.url,
    evidence: [{
      name: "External pivot (not queried)",
      detail: `Opens ${t.name} pre-filled with this selector. Octopus did not query it — these services need an account, and nothing here claims a result from them.`,
      source: "pivot",
      weight: 15,
    }],
  }));
}
