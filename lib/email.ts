// Email → identity. Public sources only, no key required.
//
// What an email actually gives you, in order of strength:
//   1. GRAVATAR by hash — a verified anchor: the person themselves attached a profile
//      (and often a list of accounts) to that exact address.
//   2. THE DOMAIN — for a corporate address the domain identifies the organisation,
//      which is frequently the most useful fact in the whole scan and costs one DNS
//      lookup. Freemail domains say nothing and are skipped.
//   3. THE LOCAL PART, as a handle candidate. This is inference, not evidence: the
//      account may exist and belong to someone else entirely. Everything from here is
//      marked `derived` and scored strictly weaker.
//   4. THE SHAPE of the address — role account, disposable domain, plus-tag. Mostly
//      NEGATIVE intelligence, and the useful kind: "contact@" is not a person, and
//      correlating it to one is how a report gets embarrassing.
//
// Everything goes through lib/netfetch, so the email path obeys the same OPSEC posture,
// proxy, cache and rate-limit honesty as the rest of the tool. It used to carry its own
// fetch with a self-identifying User-Agent, which meant a rate-limited Gravatar read as
// "no Gravatar" — a silent false negative on the one verified anchor an email has.

import { createHash } from "crypto";
import { promises as dns } from "dns";
import { scanUsername, type RawProfile, type ProfileLink } from "./connectors";
import { scanWmn } from "./wmn";
import { fetchJSON, noteOutcome, type SourceHealth } from "./netfetch";
import { emailShape, handleCandidates, type EmailShape, type HandleCandidate, type MailDomainIntel } from "./emailaddr";

// the address logic lives in ./emailaddr — re-exported so callers have one import
export { emailShape, handleCandidates, deriveHandle, emailShapeEvidence } from "./emailaddr";
export type { EmailShape, HandleCandidate, ShapeEvidence, MailDomainIntel } from "./emailaddr";

/** Gravatar profile from an email (md5, then sha256 fallback). The verified anchor. */
export async function gravatarByEmail(email: string, health?: SourceHealth): Promise<RawProfile | null> {
  const s = emailShape(email);
  let r = await fetchJSON<any>(`https://gravatar.com/${s.gravatarMd5}.json`, { timeoutMs: 6000 });
  let algo = "md5";
  if (r.outcome !== "ok" && r.outcome !== "not-found") {
    const sha = createHash("sha256").update(s.normalized).digest("hex");
    r = await fetchJSON<any>(`https://gravatar.com/${sha}.json`, { timeoutMs: 6000 });
    algo = "sha256";
  }
  // "we could not check" must never be recorded as "there is nothing there"
  if (health) noteOutcome(health, "gravatar.com", r.outcome);
  if (r.outcome !== "ok") return null;

  const e = Array.isArray(r.data?.entry) ? r.data.entry[0] : null;
  if (!e?.hash) return null;
  const accounts = Array.isArray(e.accounts) ? e.accounts : [];
  const links: ProfileLink[] = accounts.slice(0, 6).map((a: any) => ({
    service: a.shortname || a.name || "account",
    handle: a.username || a.display || undefined,
    url: a.url || "",
    label: a.shortname || a.name || "account",
  }));
  return {
    id: "gravatar", platform: "GRAVATAR", disc: "GR",
    handle: e.preferredUsername || s.base,
    url: e.profileUrl || `https://gravatar.com/${s.gravatarMd5}`,
    displayName: e.displayName || e.name?.formatted || undefined,
    bio: e.aboutMe || undefined, avatar: e.thumbnailUrl || undefined,
    links: links.length ? links : undefined,
    source: `gravatar.com · via email (${algo})`,
  };
}

/**
 * What the domain itself says. All of it is DNS — the target is never contacted, so
 * this is safe under every posture, including no-touch.
 */
export async function mailDomainIntel(domain: string): Promise<MailDomainIntel> {
  const out: MailDomainIntel = { domain, mx: false, mxHosts: [], spf: false, dmarc: false };
  if (!domain) return out;
  const [mx, txt, dmarc] = await Promise.all([
    dns.resolveMx(domain).catch(() => [] as any[]),
    dns.resolveTxt(domain).catch(() => [] as string[][]),
    dns.resolveTxt("_dmarc." + domain).catch(() => [] as string[][]),
  ]);
  out.mx = Array.isArray(mx) && mx.length > 0;
  out.mxHosts = (mx as any[]).map((r) => String(r.exchange || "").toLowerCase()).filter(Boolean).slice(0, 4);
  out.spf = (txt as string[][]).some((r) => r.join("").toLowerCase().startsWith("v=spf1"));
  out.dmarc = (dmarc as string[][]).some((r) => r.join("").toLowerCase().includes("v=dmarc1"));
  return out;
}

/** Kept for the existing response shape. */
export async function mxValid(email: string): Promise<boolean> {
  return (await mailDomainIntel(emailShape(email).domain)).mx;
}

export interface EmailScan {
  profiles: RawProfile[];
  wmnHits: RawProfile[];
  wmnChecked: number;
  wmnTotal: number;
  /** the primary handle candidate ("" for a role account) */
  handle: string;
  candidates: HandleCandidate[];
  shape: EmailShape;
  domainIntel: MailDomainIntel;
  mxValid: boolean;
}

export async function scanEmail(
  email: string,
  depth = 100,
  enabled?: Set<string>,
  health?: SourceHealth,
): Promise<EmailScan> {
  const shape = emailShape(email);
  const candidates = handleCandidates(email);
  const primary = candidates[0]?.handle || "";
  const wmnOn = !enabled || enabled.has("whatsmyname");

  const [grav, byCandidate, wmn, domainIntel] = await Promise.all([
    gravatarByEmail(email, health),
    // every candidate is searched, not just one — and each hit records WHICH rule
    // produced it, so the evidence can state how indirect the link is
    Promise.all(candidates.map((c) =>
      scanUsername(c.handle, enabled, health).then((ps) => ({ c, ps })).catch(() => ({ c, ps: [] as RawProfile[] })),
    )),
    primary && wmnOn ? scanWmn(primary, depth) : Promise.resolve({ hits: [] as RawProfile[], checked: 0, total: 0 }),
    mailDomainIntel(shape.domain),
  ]);

  const profiles: RawProfile[] = [];
  if (grav) profiles.push(grav); // the one verified anchor: not derived
  const seen = new Set<string>();
  for (const { c, ps } of byCandidate) {
    for (const p of ps) {
      if (p.id === "gravatar") continue; // already anchored above
      const key = p.platform.toLowerCase() + "|" + p.handle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      p.derived = true;
      p.derivedFrom = c.rule;
      if (c.handle !== primary) p.id = "cand:" + c.handle + ":" + p.id;
      profiles.push(p);
    }
  }
  const wmnHits = wmn.hits.map((h) => ({ ...h, derived: true, derivedFrom: "the address local part" }));

  return {
    profiles, wmnHits,
    wmnChecked: wmn.checked, wmnTotal: wmn.total,
    handle: primary, candidates, shape, domainIntel,
    mxValid: domainIntel.mx,
  };
}
