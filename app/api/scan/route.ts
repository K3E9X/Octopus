import { NextRequest, NextResponse } from "next/server";
import { scanUsername, type RawProfile } from "@/lib/connectors";
import { scanWmn, wmnCatalogue } from "@/lib/wmn";
import { scanEmail, emailShapeEvidence, type EmailScan } from "@/lib/email";
import { dHashFromBuffer, fetchImageBuffer, avatarMatch } from "@/lib/phash";
import { metaFromBuffer, metaEvidence } from "@/lib/metadata";
import { extractFromText, normId } from "@/lib/extract";
import { collect, holeheAccounts, collectorEnabled } from "@/lib/collector";
import { searchIntelX, intelxConfigured } from "@/lib/intelx";
import { recordedFutureLookup, recordedFutureConfigured } from "@/lib/recordedfuture";
import { readClientConfig } from "@/lib/reqconfig";
import { hudsonRockEmail, hudsonRockUsername } from "@/lib/hudsonrock";
import { breachExposure, breachSignal } from "@/lib/breaches";
import { leadPlan, type Lead } from "@/lib/leads";
import { nodesFromExposure, applyReuse } from "@/lib/leaknodes";
import { leakApis, anyLeakKey } from "@/lib/leakapis";
import { compromiseTimeline, hygiene } from "@/lib/compromise";
import { looksLikePhone, phoneIntel, type PhoneIntel } from "@/lib/phone";
import { looksLikeName, nameSignals, nameCandidates } from "@/lib/name";
import { namePairFromHandle, matchName, nameMatchEvidence } from "@/lib/namematch";
import { looksLikeDomain, enrichDomain } from "@/lib/domain";
import { looksLikeIp, looksLikeHash, ipIntel, ipSignals, hashIntel, hashSignals, iocPivots } from "@/lib/infra";
import { usernameVariants } from "@/lib/variants";
import { sharedHandleEvidence, handleRarity } from "@/lib/rarity";
import { newHealth, healthNote, setEgress, torActive } from "@/lib/netfetch";
import { darkwebSearch, darkwebSignals } from "@/lib/darkweb";
import { recordQuery, minimizationReport } from "@/lib/audit";
import { searchCorpus, corpusSignals } from "@/lib/corpus";
import { scoreEvidence } from "@/lib/scoring";
import { resolveIdentities, type ResolveNode } from "@/lib/resolve";
import { githubNetwork, blueskyNetwork, mastodonNetwork, type NetworkResult } from "@/lib/relations";
import { mineContent } from "@/lib/content";
import { analyzeNetwork } from "@/lib/netanalysis";
import { inferTimezone } from "@/lib/temporal";
import { reverseGeocode, forwardGeocode, parseCoords, convergeLocations, type GeoPoint } from "@/lib/geo";
import type { Signal, Evidence, Status } from "@/lib/signals";

function phoneSignal(intel: PhoneIntel): Signal {
  const valid = intel.valid;
  const typeLabel = (intel.type || "unknown type").toLowerCase().replace(/_/g, " ");
  const evidence: Evidence[] = [
    {
      name: valid ? "Valid number" : "Not a valid number",
      detail: `${intel.country || "unknown region"} · ${typeLabel}${intel.callingCode ? " · " + intel.callingCode : ""}`,
      source: "libphonenumber · offline, deterministic",
      weight: valid ? 72 : 30,
    },
  ];
  if (intel.e164) {
    evidence.push({ name: "Formats", detail: `E.164 ${intel.e164}${intel.national ? " · national " + intel.national : ""}`, source: "libphonenumber", weight: 58 });
  }
  evidence.push({
    name: "Owner lookup",
    detail: "Automated owner identity isn't free — use the Epieos / Truecaller / PhoneInfoga pivots (pre-filled with this number).",
    source: "guidance",
    weight: 20,
  });
  return {
    id: "phone:" + (intel.e164 || intel.input).replace(/\D/g, ""),
    platform: "PHONE",
    handle: intel.international || intel.input,
    disc: "TEL",
    kind: "phone",
    confidence: valid ? 68 : 30,
    tier: valid ? "possible" : "weak",
    status: "review",
    evidence,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One lead, one selector: keep the highest-ranked reason when two agree. */
function dedupeLeads(leads: Lead[]): Lead[] {
  const by = new Map<string, Lead>();
  for (const l of leads) {
    const k = l.kind + ":" + norm(l.value);
    const prev = by.get(k);
    if (!prev || l.rank > prev.rank) by.set(k, l);
  }
  return [...by.values()].sort((a, b) => b.rank - a.rank);
}

/**
 * Follow a lead, cheaply.
 *
 * Deliberately NOT a full connector sweep: this runs inside one request that already
 * has a 60s ceiling, and four full sweeps would turn a scan into a timeout. What it
 * does instead is the high-yield, low-cost half — ask the breach indexes about the new
 * selector, and resolve infrastructure passively. The heavy sweep is what the client
 * runs afterwards on the leads this returns, which is also what keeps the scan
 * interactive instead of blocking on a request that got greedy.
 */
async function chaseLead(lead: Lead, collectedAt: string): Promise<Signal[]> {
  if (lead.kind === "email" || lead.kind === "username") {
    const out: Signal[] = [];
    const [hr, br] = await Promise.allSettled([
      lead.kind === "email" ? hudsonRockEmail(lead.value) : hudsonRockUsername(lead.value),
      breachExposure(lead.value).then((r) => breachSignal(lead.value, r, collectedAt)),
    ]);
    if (hr.status === "fulfilled") out.push(...hr.value);
    if (br.status === "fulfilled") out.push(...br.value);
    return out;
  }
  if (lead.kind === "domain") {
    const d = await enrichDomain(lead.value, collectedAt);
    return d.signals;
  }
  if (lead.kind === "ip") {
    const intel = await ipIntel(lead.value);
    return ipSignals(intel, collectedAt);
  }
  return [];
}

const SERVICE_TO_PLATFORM: Record<string, string> = {
  twitter: "X / TWITTER", x: "X / TWITTER", github: "GITHUB", gitlab: "GITLAB",
  reddit: "REDDIT", hackernews: "HACKER NEWS", facebook: "FACEBOOK", mastodon: "MASTODON",
  bluesky: "BLUESKY", keybase: "KEYBASE", telegram: "TELEGRAM", instagram: "INSTAGRAM",
  youtube: "YOUTUBE", twitch: "TWITCH", stackoverflow: "STACK OVERFLOW", hackerone: "HACKERONE",
  wordpress: "WORDPRESS", tumblr: "TUMBLR", vimeo: "VIMEO", flickr: "FLICKR", medium: "MEDIUM",
};
const SKIP_SERVICE = new Set(["web", "dns", "http", "https", "pgp", "gpg", "bitcoin", "zcash", "generic_web_site"]);
const serviceToPlatform = (s: string) => SERVICE_TO_PLATFORM[s.toLowerCase()] || s.toUpperCase();
const isRealService = (s: string) => !SKIP_SERVICE.has(s.toLowerCase());
const disc2 = (name: string) => (name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "LK").toUpperCase();

/**
 * Enrich profiles that expose an avatar: fetch each image once, then extract BOTH
 * the perceptual hash (for cross-account matching) and the maximum image metadata
 * (EXIF/GPS/IPTC/XMP). Bounded and fully graceful — any failure just skips.
 */
async function enrichAvatars(profiles: RawProfile[], max = 14): Promise<void> {
  const targets = profiles.filter((p) => p.avatar).slice(0, max);
  await Promise.all(
    targets.map(async (p) => {
      try {
        const buf = await fetchImageBuffer(p.avatar!);
        if (!buf) return;
        const [hash, meta] = await Promise.all([dHashFromBuffer(buf), metaFromBuffer(buf)]);
        if (hash) p.avatarHash = hash;
        if (meta) p.exif = meta;
      } catch { /* skip */ }
    }),
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // allow the WhatsMyName sweep to finish (Vercel Pro)

function norm(s?: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Turn verifiable public profiles into scored Signals.
 * Confidence reflects "how strongly this account ties to the seed" — computed
 * only from observed facts. No account is auto-confirmed; a human decides.
 */
function correlate(matchTarget: string, profiles: RawProfile[]): Signal[] {
  const seedN = norm(matchTarget);
  return profiles.map((p) => {
    const evidence: Evidence[] = [];
    const handleN = norm(p.handle.replace(/^u\//, ""));

    // exact / near username match against the target (username, or email-derived handle)
    const exact = handleN === seedN;
    if (p.unverified) {
      evidence.push({
        name: "Presence detected",
        detail: `${p.handle} found on ${p.platform} by URL pattern (WhatsMyName) — existence not verified by an API.`,
        source: p.source,
        weight: 45,
      });
    } else if (p.declared) {
      evidence.push({
        name: "Declared account",
        detail: `${p.handle} on ${p.platform} — ${p.source}.`,
        source: p.source,
        weight: 85,
      });
    } else if (p.derived) {
      evidence.push({
        name: "Handle derived from email",
        detail: `${p.handle} on ${p.platform}, from ${p.derivedFrom || "the address local part"}. The account exists; that it belongs to the owner of this address is NOT established — a local part is a guess at a handle, not a link to a person.`,
        source: p.source,
        weight: 50,
      });
    } else if (p.variantOf) {
      // found via a VARIANT of the seed handle — the account exists, but that it
      // belongs to the same person is unproven. Deliberately weak.
      evidence.push({
        name: "Handle variant (unconfirmed)",
        detail: `${p.handle} on ${p.platform} — a ${p.variantRule} variant of "${p.variantOf}". The account exists; the link to this person is NOT established.`,
        source: p.source,
        weight: 42,
      });
      const r = handleRarity(p.handle);
      if (r.band === "unique" || r.band === "distinctive") {
        evidence.push({
          name: "Rare handle reused",
          detail: `"${p.handle}" is ${r.band} (rarity ${r.score}) — a variant this distinctive is unlikely to be an unrelated person.`,
          source: "handle rarity · deterministic",
          weight: r.band === "unique" ? 80 : 66,
        });
      }
    } else {
      // an EXACT handle match is only as strong as the handle is rare: "alex" says
      // nothing, "xk9_zulu_42" is near-proof. This is the main false-positive guard.
      const r = handleRarity(p.handle);
      const w = exact ? (r.band === "unique" ? 86 : r.band === "distinctive" ? 76 : r.band === "moderate" ? 62 : 46) : 52;
      evidence.push({
        name: exact ? (r.band === "unique" ? "Rare handle reused" : "Exact username") : "Near-match username",
        detail: `${p.handle} ${exact ? "=" : "≈"} target "${matchTarget}", public account exists. Handle is ${r.band} (rarity ${r.score}${r.reason ? " · " + r.reason : ""})${r.band === "common" ? " — a shared common handle is weak on its own." : "."}`,
        source: p.source,
        weight: w,
      });
    }

    if (p.displayName) evidence.push({ name: "Public name", detail: p.displayName, source: p.source, weight: 55 });
    if (p.bio) evidence.push({ name: "Public bio", detail: p.bio.slice(0, 140), source: p.source, weight: 44 });
    if (p.avatar) evidence.push({ name: "Avatar present", detail: p.avatarHash ? "Public profile image (hashed for correlation)." : "Public profile image.", source: p.source, weight: 48 });

    // image metadata that survived on the avatar (GPS/camera/date/author) — rare on
    // social platforms (they strip it) but pure gold when it leaks through
    if (p.exif) {
      for (const me of metaEvidence(p.exif)) {
        evidence.push({ name: me.name, detail: me.detail, source: `${me.source} · from ${p.platform} avatar`, weight: me.weight });
      }
    }
    if (p.createdAt) evidence.push({ name: "Account age", detail: `Account created on ${p.createdAt.slice(0, 10)}.`, source: p.source, weight: 30 });

    // cross-signal: display name shared with another platform (SOFT — a shared name
    // alone is a hint, not proof; it must be corroborated to lift the tier)
    const other = profiles.find((q) => q.id !== p.id && q.displayName && p.displayName && norm(q.displayName) === norm(p.displayName));
    if (other) {
      evidence.push({ name: "Matching name", detail: `Public name identical to ${other.platform}.`, source: "cross-source correlation", weight: 82 });
    }

    // strong cross-signal: matching avatar (perceptual hash) with another platform (HARD)
    if (p.avatarHash) {
      let best: { platform: string; distance: number; strong: boolean } | null = null;
      for (const q of profiles) {
        if (q.id === p.id || !q.avatarHash) continue;
        const m = avatarMatch(p.avatarHash, q.avatarHash);
        if (m.near && (!best || m.distance < best.distance)) best = { platform: q.platform, distance: m.distance, strong: m.match };
      }
      if (best) {
        evidence.push({
          name: best.strong ? "Matching avatar" : "Near-match avatar",
          detail: `Profile photo matches ${best.platform} (pHash distance ${best.distance}/64).`,
          source: "avatar correlation · local pHash",
          weight: best.strong ? 92 : 78,
        });
      }
    }

    // strong cross-signal: self-declared / verified linked accounts (Keybase, Gravatar) (HARD)
    if (p.links?.length) {
      for (const l of p.links.slice(0, 4)) {
        evidence.push({ name: "Declared linked account", detail: l.label + (l.url ? ` → ${l.url}` : ""), source: `${p.source} · declared link`, weight: 85 });
      }
    }

    // A handle we GUESSED, on a profile that shows a name, has to be checked against
    // the name we were looking for. "marie.dubois@" → variant "mdubois" → a real
    // account belonging to Matthieu Dubois: same surname, different person. Without
    // this the tool read a name and an avatar off that page and called it PROBABLE.
    if ((p.derived || p.variantOf) && p.displayName) {
      const expected = namePairFromHandle(matchTarget);
      const ev = nameMatchEvidence(matchName(expected, p.displayName), p.source);
      if (ev) evidence.push(ev);
    }

    // honest, evidence-driven score: qualitative tier + derived confidence
    const scored = scoreEvidence(evidence);
    const confidence = scored.confidence;
    const tier = scored.tier;
    const status: Status = (tier === "verified" || tier === "probable") ? "review" : "candidate";

    return {
      id: p.id,
      platform: p.platform,
      handle: p.handle,
      disc: p.disc,
      url: p.url || undefined,
      displayName: p.displayName || undefined,
      createdAt: p.createdAt || undefined,
      tier,
      confidence,
      status,
      evidence,
      avatarUrl: p.avatar || undefined,
    };
  });
}

export async function GET(req: NextRequest) {
  const clientCfg = readClientConfig(req); // keys from the API panel (override env)
  const q = (req.nextUrl.searchParams.get("username") || "").trim();

  // --- OPSEC: set the egress posture for every request this scan makes ---
  // Identity is stable per case (consistent looks less anomalous than erratic) and
  // differs across cases, so our targets are not correlatable with each other.
  const caseId = req.nextUrl.searchParams.get("case") || req.headers.get("x-octopus-case") || undefined;
  const posture = (req.nextUrl.searchParams.get("posture") || req.headers.get("x-octopus-posture") || undefined) as any;
  setEgress({ caseId, posture, proxy: req.headers.get("x-octopus-proxy") || undefined });

  // --- AUDIT: every selector query is recorded with its legal basis ---
  const operator = req.headers.get("x-octopus-operator") || "unknown";
  const legalBasis = req.headers.get("x-octopus-legal-basis") || "unspecified";
  if (q) {
    // fire-and-forget: the trail must never slow or break collection
    recordQuery({ operator, kind: "scan", selector: q, legalBasis, caseId, posture: posture || "direct" }).catch(() => {});
  }
  const depth = clamp(parseInt(req.nextUrl.searchParams.get("depth") || "200", 10) || 200, 1, 718);
  if (!q || q.length > 128) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const isEmail = EMAIL_RE.test(q);
  const isPhone = !isEmail && looksLikePhone(q);

  // --- infrastructure selectors: an IOC is a legitimate seed -------------------
  // A CTI analyst starts from an address or a digest at least as often as from a
  // handle. Typing one used to run a USERNAME search for "1.2.3.4".
  if (looksLikeIp(q)) {
    const collectedAt = new Date().toISOString();
    const intel = await ipIntel(q);
    const signals = [...ipSignals(intel, collectedAt), ...iocPivots(q, "ip")];
    for (const sig of signals) {
      const sc = scoreEvidence(sig.evidence);
      sig.tier = sig.tier || sc.tier;
      sig.confidence = sig.tier === "weak" ? sig.confidence : sc.confidence;
    }
    return NextResponse.json({ seed: q, mode: "ip", count: signals.length, signals, ip: intel });
  }

  if (looksLikeHash(q)) {
    const collectedAt = new Date().toISOString();
    const intel = await hashIntel(q);
    const signals = [...hashSignals(intel, collectedAt), ...iocPivots(q, "hash")];
    // a digest can also be a selector we already hold locally
    try {
      const hits = await searchCorpus(q);
      if (hits.length) signals.push(...corpusSignals(hits, collectedAt));
    } catch { /* corpus optional */ }
    for (const sig of signals) {
      const sc = scoreEvidence(sig.evidence);
      sig.tier = sig.tier || sc.tier;
      sig.confidence = sig.tier === "weak" ? sig.confidence : sc.confidence;
    }
    return NextResponse.json({ seed: q, mode: "hash", count: signals.length, signals, hash: intel });
  }

  // phone mode: deterministic offline intel + pivots (no free owner lookup)
  if (isPhone) {
    const country = (req.nextUrl.searchParams.get("country") || "FR").toUpperCase();
    const intel = phoneIntel(q, country);
    const sig = phoneSignal(intel);
    return NextResponse.json({ seed: q, mode: "phone", count: 1, signals: [sig], phone: intel });
  }

  // name mode: a full name is a weak seed, so we don't just GUESS handles — we
  // generate candidate handles AND scan them, then surface the accounts that actually
  // exist. When a found account's public NAME matches the searched name (the classic
  // "same person under a different pseudo"), that's a strong, honest hit.
  if (!isEmail && !isPhone && looksLikeName(q)) {
    const base = nameSignals(q); // [person, ...candidate leads]
    const personId = base[0].id;
    const cands = nameCandidates(q).slice(0, 5);
    const enabledName = req.nextUrl.searchParams.get("connectors");
    const enabledSet = enabledName != null ? new Set(enabledName.split(",").filter(Boolean)) : undefined;
    const nameN = norm(q);
    const settled = await Promise.all(cands.map((c) => scanUsername(c, enabledSet).then((ps) => ({ c, ps })).catch(() => ({ c, ps: [] as RawProfile[] }))));
    const seenAcct = new Set<string>();
    const hits: Signal[] = [];
    for (const { c, ps } of settled) {
      for (const p of ps) {
        const key = norm(p.platform) + "|" + norm(p.handle.replace(/^u\//, ""));
        if (seenAcct.has(key)) continue;
        seenAcct.add(key);
        const nameMatch = p.displayName ? norm(p.displayName) === nameN : false;
        const ev: Evidence[] = [{
          name: "Handle derived from name",
          detail: `${p.handle} exists on ${p.platform} — from the candidate "${c}" built from "${q}". Link to this person is unconfirmed.`,
          source: p.source, weight: 45,
        }];
        if (p.displayName) ev.push({ name: nameMatch ? "Matching name" : "Public name", detail: p.displayName + (nameMatch ? ` — matches the searched name` : ""), source: p.source, weight: nameMatch ? 82 : 50 });
        if (p.location) ev.push({ name: "Location", detail: p.location, source: p.source, weight: 44 });
        const scored = scoreEvidence(ev);
        hits.push({
          id: "namehit:" + key, platform: p.platform, handle: p.handle, disc: p.disc, url: p.url || undefined,
          displayName: p.displayName || undefined, avatarUrl: p.avatar || undefined, kind: "platform",
          tier: scored.tier, confidence: scored.confidence, status: "candidate", linkedIds: [personId], evidence: ev,
        });
      }
    }
    // found real accounts → show the person + those; otherwise fall back to the raw
    // candidate leads so the analyst still has something to pivot on.
    const signals = hits.length ? [base[0], ...hits] : base;
    return NextResponse.json({ seed: q, mode: "name", count: hits.length, signals });
  }

  // domain mode: infrastructure enrichment that FEEDS the identity graph — registrant
  // (RDAP), mail/hosting (DNS), subdomains (cert transparency), hosting geolocation.
  if (!isEmail && !isPhone && looksLikeDomain(q)) {
    const { signals, edges } = await enrichDomain(q, new Date().toISOString());
    const byId = new Map(signals.map((s) => [s.id, s]));
    for (const [a, b] of edges) {
      const A = byId.get(a), B = byId.get(b);
      if (!A || !B) continue;
      A.linkedIds = [...new Set([...(A.linkedIds || []), b])];
      B.linkedIds = [...new Set([...(B.linkedIds || []), a])];
    }
    signals.sort((x, y) => y.confidence - x.confidence);
    return NextResponse.json({ seed: q, mode: "domain", count: signals.length, signals });
  }

  if (!isEmail && /[^\w.\-@]/.test(q)) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  // enabled apps allowlist (omit → run everything)
  const cParam = req.nextUrl.searchParams.get("connectors");
  const enabled = cParam != null ? new Set(cParam.split(",").filter(Boolean)) : null;
  const wmnOn = !enabled || enabled.has("whatsmyname");
  const phashOn = !enabled || enabled.has("phash");
  const networkOn = !enabled || enabled.has("network");
  const geoOn = !enabled || enabled.has("geo");
  const domainOn = !enabled || enabled.has("domain");
  const variantsOn = !enabled || enabled.has("variants");
  const collectedAt = new Date().toISOString(); // chain of custody: one stamp per scan
  const health = newHealth(); // records rate-limits/failures so coverage stays honest
  let darkwebNote = ""; // what the onion indexes did and did not cover
  try {
    let apiProfiles: RawProfile[];
    let wmnHits: RawProfile[];
    let checked = 0, totalSites = 0;
    let matchTarget = q;
    let email: { handle: string; mxValid: boolean } | undefined;
    let emailScan: EmailScan | undefined;

    if (isEmail) {
      // health is threaded through so a rate-limited Gravatar is reported as
      // "not checked", never as "no profile"
      const r = await scanEmail(q, depth, enabled ?? undefined, health);
      apiProfiles = r.profiles;
      wmnHits = r.wmnHits;
      checked = r.wmnChecked; totalSites = r.wmnTotal;
      matchTarget = r.handle || q;
      email = { handle: r.handle, mxValid: r.mxValid };
      emailScan = r;

      // The variant generator was username-only, so an email got exactly one handle
      // tried. Now the primary candidate is expanded the same way — this is where most
      // of the missing email recall was.
      if (variantsOn && r.handle) {
        const vars = usernameVariants(r.handle, 5);
        const have = new Set(apiProfiles.map((p) => norm(p.platform) + "|" + norm(p.handle)));
        const results = await Promise.all(vars.map((v) => scanUsername(v.handle, enabled ?? undefined, health).then((ps) => ({ v, ps })).catch(() => ({ v, ps: [] as RawProfile[] }))));
        for (const { v, ps } of results) {
          for (const p of ps) {
            const key = norm(p.platform) + "|" + norm(p.handle);
            if (have.has(key)) continue;
            have.add(key);
            p.id = "var:" + v.handle + ":" + p.id;
            p.variantOf = r.handle;
            p.variantRule = v.rule + ", from the email";
            apiProfiles.push(p);
          }
        }
      }
    } else {
      const [api, wmn] = await Promise.all([
        scanUsername(q, enabled ?? undefined, health),
        wmnOn ? scanWmn(q, depth, 40, health) : Promise.resolve({ hits: [] as RawProfile[], checked: 0, total: 0 }),
      ]);
      apiProfiles = api; wmnHits = wmn.hits;
      checked = wmn.checked; totalSites = wmn.total;

      // --- username variants: people rarely keep the exact same handle everywhere.
      // Scan plausible variants (separators, initials, trailing digits) and mark the
      // hits as variant-derived so they score strictly WEAKER than the exact match.
      if (variantsOn) {
        const vars = usernameVariants(q, 5);
        const have = new Set(apiProfiles.map((p) => norm(p.platform) + "|" + norm(p.handle)));
        const results = await Promise.all(vars.map((v) => scanUsername(v.handle, enabled ?? undefined, health).then((ps) => ({ v, ps })).catch(() => ({ v, ps: [] as RawProfile[] }))));
        for (const { v, ps } of results) {
          for (const p of ps) {
            const key = norm(p.platform) + "|" + norm(p.handle);
            if (have.has(key)) continue;
            have.add(key);
            p.id = "var:" + v.handle + ":" + p.id;
            p.variantOf = q;
            p.variantRule = v.rule;
            apiProfiles.push(p);
          }
        }
      }
    }

    // deep collection via the Maigret worker (rich profile data + discovered
    // identifiers), when a COLLECTOR_URL is configured and the app is enabled
    if (collectorEnabled && (!enabled || enabled.has("maigret"))) {
      const mg = await collect(matchTarget);
      if (isEmail) mg.forEach((p) => (p.derived = true));
      apiProfiles = [...apiProfiles, ...mg];
    }

    // dedupe: prefer the richer API profile per platform, then collapse duplicates
    // by id AND by platform+handle (community WhatsMyName data has near-dup entries)
    const seen = new Set(apiProfiles.map((p) => norm(p.platform)));
    const mergedRaw = [...apiProfiles, ...wmnHits.filter((w) => !seen.has(norm(w.platform)))];
    const byId = new Map<string, RawProfile>();
    const byKey = new Set<string>();
    const merged: RawProfile[] = [];
    for (const p of mergedRaw) {
      const key = norm(p.platform) + "|" + norm(p.handle.replace(/^u\//, ""));
      if (byId.has(p.id) || byKey.has(key)) continue;
      byId.set(p.id, p); byKey.add(key); merged.push(p);
    }

    // expand declared/verified links (Keybase, Gravatar) into connected nodes + edges
    const edges = new Map<string, Set<string>>();
    const addEdge = (a: string, b: string) => {
      if (a === b) return;
      (edges.get(a) ?? edges.set(a, new Set()).get(a)!).add(b);
      (edges.get(b) ?? edges.set(b, new Set()).get(b)!).add(a);
    };
    for (const p of [...merged]) {
      if (!p.links?.length) continue;
      for (const l of p.links) {
        if (!isRealService(l.service)) continue;
        const platN = norm(serviceToPlatform(l.service));
        let target = merged.find(
          (q) => q.id !== p.id && (norm(q.platform) === platN || (l.handle && norm(q.handle.replace(/^u\//, "")) === norm(l.handle))),
        );
        if (!target && l.handle) {
          const id = `decl:${l.service.toLowerCase()}:${norm(l.handle)}`;
          target = byId.get(id);
          if (!target) {
            target = {
              id, platform: serviceToPlatform(l.service), disc: disc2(serviceToPlatform(l.service)),
              handle: l.handle, url: l.url, declared: true, source: `declared & verified via ${p.platform}`,
            };
            merged.push(target); byId.set(id, target);
          }
        }
        if (target) addEdge(p.id, target.id);
      }
    }

    // link accounts by avatar (perceptual hash) before scoring
    if (phashOn) await enrichAvatars(merged);

    const signals = correlate(matchTarget, merged);

    // entity extraction: mine collected bios/names for emails, aliases, links →
    // typed nodes wired to their source, growing the knowledge graph.
    const sigById = new Map(signals.map((s) => [s.id, s]));
    const byHandle = new Map(signals.map((s) => [norm(s.handle.replace(/^u\//, "")), s]));
    type AttrKind = "EMAIL" | "ALIAS" | "LOCATION";
    const attrs = new Map<string, { id: string; kind: AttrKind; value: string; sources: Set<string> }>();
    for (const p of merged) {
      const ex = extractFromText(p.bio, p.displayName);
      const items: Array<{ kind: AttrKind; value: string }> = [
        ...ex.emails.map((v) => ({ kind: "EMAIL" as const, value: v })),
        ...ex.aliases.map((v) => ({ kind: "ALIAS" as const, value: v })),
        ...(p.location ? [{ kind: "LOCATION" as const, value: p.location.trim() }] : []),
        // GPS embedded in the avatar → a hard, coordinate-precise location node
        ...(p.exif?.gps ? [{ kind: "LOCATION" as const, value: `${p.exif.gps.lat.toFixed(5)}, ${p.exif.gps.lon.toFixed(5)}` }] : []),
      ];
      for (const it of items) {
        const vn = normId(it.value);
        if (vn.length < (it.kind === "LOCATION" ? 2 : 3)) continue;
        if (it.kind === "ALIAS") {
          const existing = byHandle.get(vn);
          if (existing && existing.id !== p.id) { addEdge(p.id, existing.id); continue; } // link, no dup
          if (vn === norm((matchTarget || "").replace(/^u\//, ""))) continue; // it's the seed handle
        }
        const id = `attr:${it.kind.toLowerCase()}:${vn}`;
        if (!attrs.has(id)) attrs.set(id, { id, kind: it.kind, value: it.value, sources: new Set() });
        attrs.get(id)!.sources.add(p.id);
      }
    }
    const ATTR_META: Record<AttrKind, { disc: string; kind: Signal["kind"]; label: string }> = {
      EMAIL: { disc: "EM", kind: "email", label: "Email discovered" },
      ALIAS: { disc: "AL", kind: "alias", label: "Alias discovered" },
      LOCATION: { disc: "GEO", kind: "location", label: "Location" },
    };
    const GPS_RE = /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/;
    for (const a of attrs.values()) {
      const plats = [...a.sources].map((id) => sigById.get(id)?.platform).filter(Boolean) as string[];
      const meta = ATTR_META[a.kind];
      const isGps = a.kind === "LOCATION" && GPS_RE.test(a.value);
      signals.push({
        id: a.id,
        platform: a.kind,
        handle: a.kind === "ALIAS" ? "@" + a.value : a.value,
        disc: meta.disc,
        kind: meta.kind,
        confidence: isGps ? 70 : a.kind === "LOCATION" ? 58 : 52,
        tier: "possible",
        status: "candidate",
        evidence: [ isGps ? {
          name: "GPS from image",
          detail: `Coordinates ${a.value} embedded in the avatar EXIF on ${plats.slice(0, 3).join(", ") || "a collected profile"} — precise, not self-reported.`,
          source: "EXIF · exifr",
          weight: 82,
        } : {
          name: meta.label,
          detail: `From the profile ${a.kind === "LOCATION" ? "location field" : "text"} on ${plats.slice(0, 3).join(", ") || "a collected profile"}.`,
          source: "entity extraction · from collected profiles",
          weight: 55,
        }],
      });
      for (const sid of a.sources) addEdge(sid, a.id);
    }

    // breach / leak search (Intelligence X) when a key is configured (env or API panel)
    if (intelxConfigured(clientCfg.intelx ? { key: clientCfg.intelx, url: clientCfg.intelxUrl } : undefined) && (!enabled || enabled.has("intelx"))) {
      const leaks = await searchIntelX(isEmail ? q : matchTarget, { key: clientCfg.intelx, url: clientCfg.intelxUrl });
      signals.push(...leaks);
    }

    // infostealer intel (Hudson Rock — free) — reveals compromise + services used
    if (!enabled || enabled.has("hudsonrock")) {
      const hr = isEmail ? await hudsonRockEmail(q) : await hudsonRockUsername(matchTarget);
      signals.push(...hr);
    }

    // Breach indexes that return CONTENT. Hudson Rock's free tier masks nearly
    // everything it hands over, so the answer to "give me the password in clear" is a
    // different source, not a cleverer client. These are keyless.
    if (!enabled || enabled.has("breaches")) {
      try {
        const term = isEmail ? q : matchTarget;
        const res = await breachExposure(term);
        // Paid providers, when the analyst has configured a key. They return everything
        // in clear, and their rows merge into the same node with their own attribution
        // so you can see exactly what the key bought over what was already free.
        const keys = {
          dehashed: clientCfg.dehashed || process.env.DEHASHED_KEY,
          snusbase: clientCfg.snusbase || process.env.SNUSBASE_KEY,
          leakcheck: clientCfg.leakcheckPro || process.env.LEAKCHECK_KEY,
          hudsonrock: clientCfg.hudsonrockPro || process.env.HUDSONROCK_KEY,
        };
        if (anyLeakKey(keys)) {
          const paid = await leakApis(term, keys);
          res.items.push(...paid.items);
          res.reached.push(...paid.reached);
          // a rejected key is not a clean record, and only one of those means "nothing"
          for (const p of paid.problems) res.silent.push(`${p.id} (${p.problem})`);
        }
        signals.push(...breachSignal(term, res, collectedAt));
      } catch { /* a silent index is a missing source, never a failed scan */ }
    }

    // --- local corpora: SILENT search of datasets we already hold ---
    // Nothing leaves the machine, the source is never told we looked, and the data
    // does not vanish when a page does. Often where the decisive material actually is.
    if (!enabled || enabled.has("corpus")) {
      try {
        const hits = await searchCorpus(isEmail ? q : matchTarget);
        if (hits.length) signals.push(...corpusSignals(hits, collectedAt));
      } catch { /* corpus is optional */ }
    }

    // --- what leaked becomes something to investigate -------------------------------
    // Exposure used to be fields on one node, invisible to the resolver, the timeline,
    // the map and the chaining logic. Promote its usable selectors into real nodes, and
    // chase the strongest ones so the graph that comes back already contains what the
    // breach pointed at instead of waiting for a manual click on each row.
    const leakBearing = signals.filter((s) => s.exposure && s.exposure.length);
    let chased: { value: string; kind: string; why: string; added: number }[] = [];
    let deferredLeads: Lead[] = [];
    if (leakBearing.length) {
      const known = new Set<string>(signals.map((s) => norm(s.handle)));
      const allLeads: Lead[] = [];
      for (const leak of leakBearing) {
        const { nodes, leads } = nodesFromExposure(leak.id, leak.exposure!, q, known, collectedAt);
        for (const n of nodes) { if (!signals.some((s) => s.id === n.id)) signals.push(n); }
        allLeads.push(...leads);
        // reuse runs per leak: the association between a login and a secret is only
        // observed inside one dump line, and pooling lines across sources would invent it
        applyReuse(signals, leak.exposure!, leak.id);

        // The dates were being collected and used as decoration. What they actually
        // answer is whether a recovered credential is history or a live exposure.
        const events = compromiseTimeline(leak.exposure!);
        if (events.length) {
          leak.compromise = events;
          if (!leak.createdAt) leak.createdAt = events[0].date;
          for (const h of hygiene(leak.exposure!, events)) {
            leak.evidence.push({ name: h.headline, detail: h.detail, source: "octopus · compromise timeline", weight: h.weight });
          }
        }
      }

      // Chase the best leads. Bounded hard: this runs inside one request, and an
      // unbounded expansion is how a scan turns into a timeout.
      // `|| 4` would read "0" as absent — "0" is falsy — and a lead-scan that chases
      // its own leads is an expansion storm, not an investigation.
      const raw = req.nextUrl.searchParams.get("leadBudget");
      const budget = raw === null ? 4 : Math.max(0, Math.min(8, Number(raw) || 0));
      const plan = leadPlan(dedupeLeads(allLeads), budget);
      deferredLeads = plan.deferred;
      for (const lead of plan.run) {
        try {
          const found = await chaseLead(lead, collectedAt);
          if (found.length) {
            const parent = signals.find((s) => norm(s.handle) === norm(lead.value));
            for (const f of found) {
              if (signals.some((s) => s.id === f.id)) continue;
              if (parent) f.linkedIds = [...new Set([...(f.linkedIds || []), parent.id])];
              signals.push(f);
            }
          }
          chased.push({ value: lead.value, kind: lead.kind, why: lead.why, added: found.length });
        } catch {
          chased.push({ value: lead.value, kind: lead.kind, why: lead.why, added: 0 });
        }
      }
    }

    // --- the address itself, and the organisation behind it ---
    // Two things the email path never surfaced. First the SHAPE of the address, which
    // is mostly negative intelligence: a role mailbox is an organisation and must not
    // be attributed to a person, a dead domain contradicts a live address. Second the
    // DOMAIN: for a corporate address it names the employer, which is often the single
    // most useful fact of the scan, and it costs DNS + RDAP with no contact to the target.
    if (emailScan) {
      const sh = emailScan.shape;
      signals.push({
        id: "attr:email:" + norm(sh.normalized),
        platform: "EMAIL",
        handle: sh.normalized,
        disc: "EM",
        kind: "email",
        confidence: 50,
        status: "review",
        collectedAt,
        evidence: emailShapeEvidence(sh, emailScan.domainIntel),
      });
      // score it through the same model as everything else — it was the one node
      // shipping without a tier, which reads in the UI as "no assessment"
      const en = signals[signals.length - 1];
      const es = scoreEvidence(en.evidence);
      en.tier = es.tier; en.confidence = es.confidence;

      if (!sh.isFreemail && !sh.isDisposable && looksLikeDomain(sh.domain) && (!enabled || enabled.has("domain"))) {
        try {
          const dres = await enrichDomain(sh.domain, collectedAt, "attr:email:" + norm(sh.normalized));
          const have = new Set(signals.map((x) => x.id));
          for (const d of dres.signals) if (!have.has(d.id)) signals.push(d);
          for (const [a, b] of dres.edges) addEdge(a, b);
          addEdge("attr:email:" + norm(sh.normalized), "domain:" + norm(sh.domain));
        } catch { /* domain enrichment is best effort */ }
      }
    }

    // --- darkweb / hidden services ---
    // Works without Tor (clearnet-reachable index), works better with it. Only verbatim
    // matches become nodes, and never above WEAK: an index entry is a mention, not
    // attribution. The coverage caveat is attached to the scan so the UI cannot imply
    // "we searched the dark web".
    if (!enabled || enabled.has("darkweb")) {
      try {
        const dw = await darkwebSearch(isEmail ? q : matchTarget, { tor: torActive() });
        darkwebNote = dw.note;
        signals.push(...darkwebSignals(dw, isEmail ? q : matchTarget, collectedAt));
      } catch { /* onion indexes are best-effort by nature */ }
    }

    // OPTIONAL bonus: Recorded Future (enterprise) — only if a key is configured.
    // Never a base source; absent key → silently skipped, nothing breaks.
    if (recordedFutureConfigured(clientCfg.recordedfuture) && (!enabled || enabled.has("recordedfuture"))) {
      const rf = await recordedFutureLookup(isEmail ? q : matchTarget, isEmail, clientCfg.recordedfuture);
      signals.push(...rf);
    }

    // email → registered accounts on mainstream sites (holehe, via the worker)
    if (isEmail && collectorEnabled && (!enabled || enabled.has("holehe"))) {
      const acc = await holeheAccounts(q);
      // dedupe against platforms already present
      const have = new Set(signals.map((s) => norm(s.platform)));
      signals.push(...acc.filter((a) => !have.has(norm(a.platform))));
    }

    for (const s of signals) {
      const set = edges.get(s.id);
      if (set?.size) s.linkedIds = [...set];
    }

    // --- relationship graph + temporal analysis (multi-platform, keyless) ---
    // Map the person's world (followers / following / orgs) and infer their timezone
    // from WHEN they post. NOT GitHub-only: any account whose platform exposes a
    // public social graph feeds the network. Each fetcher degrades gracefully.
    if (networkOn) {
      const fetchers: { sig: Signal; run: () => Promise<NetworkResult>; src: string }[] = [];
      const gh = signals.find((s) => s.id === "github");
      const bs = signals.find((s) => s.id === "bluesky");
      const ma = signals.find((s) => s.id === "mastodon");
      if (gh) fetchers.push({ sig: gh, src: "GitHub", run: () => githubNetwork(gh.handle, gh.id, collectedAt) });
      if (bs) fetchers.push({ sig: bs, src: "Bluesky", run: () => blueskyNetwork(bs.handle, collectedAt) });
      if (ma) fetchers.push({ sig: ma, src: "Mastodon", run: () => mastodonNetwork(ma.handle, collectedAt) });

      const empty = (): NetworkResult => ({ nodes: [], relations: [], activityTimestamps: [], repos: [], postTexts: [], connectionHandles: [] });
      const results = await Promise.all(fetchers.map((f) => f.run().catch(empty)));
      const have = new Set(signals.map((s) => s.id));
      const connSets: { sig: Signal; handles: Set<string> }[] = [];
      const tzByNode: { sig: Signal; offset: number; label: string; src: string }[] = [];
      results.forEach((net, i) => {
        const { sig, src } = fetchers[i];
        if (net.nodes.length) {
          for (const n of net.nodes) if (!have.has(n.id)) { signals.push(n); have.add(n.id); }
          sig.relations = [...(sig.relations || []), ...net.relations];
          sig.evidence.push({
            name: "Network mapped",
            detail: `${net.relations.length} relation(s) via ${src}: follows / followers${src === "GitHub" ? " / org membership" : ""}.`,
            source: `${src} · public API`, weight: 40,
          });
        }
        if (net.connectionHandles.length) connSets.push({ sig, handles: new Set(net.connectionHandles) });
        const tz = inferTimezone(net.activityTimestamps);
        if (tz && tz.confidence >= 0.25) {
          sig.evidence.push({
            name: "Activity timezone",
            detail: `Public activity peaks consistent with ${tz.label} (from ${tz.samples} events on ${src}, confidence ${(tz.confidence * 100).toFixed(0)}%).`,
            source: "temporal analysis · deterministic", weight: Math.round(40 + tz.confidence * 25),
          });
          if (tz.confidence >= 0.45) tzByNode.push({ sig, offset: tz.offset, label: tz.label, src });
        }

        // --- content mining (#1): read WHAT they wrote, not just when ---
        if (net.postTexts.length) {
          const mined = mineContent(net.postTexts, sig.handle);
          const sr = `content mining · ${src} posts`;
          for (const mn of mined.mentions.slice(0, 8)) {
            const id = "mention:" + normId(mn.handle);
            if (!have.has(id)) {
              have.add(id);
              signals.push({
                id, platform: `${src.toUpperCase()} · MENTION`, handle: "@" + mn.handle, disc: "@", kind: "person",
                confidence: 42, tier: "possible", status: "candidate", collectedAt,
                evidence: [{ name: "Mentioned in posts", detail: `@${mn.handle} mentioned ${mn.count}× by the seed on ${src}.`, source: sr, weight: 46 }],
              });
            }
            sig.relations = [...(sig.relations || []), { to: id, kind: "mention", label: `mentions @${mn.handle} (${mn.count}×)`, source: sr }];
          }
          for (const em of mined.emails.slice(0, 4)) {
            const id = "attr:email:" + normId(em);
            if (!have.has(id)) { have.add(id); signals.push({ id, platform: "EMAIL", handle: em, disc: "EM", kind: "email", confidence: 56, tier: "possible", status: "review", collectedAt, evidence: [{ name: "Email in post", detail: `Found in ${src} post text.`, source: sr, weight: 60 }] }); }
            sig.linkedIds = [...new Set([...(sig.linkedIds || []), id])];
          }
          for (const pl of mined.places) {
            const id = "attr:location:" + normId(pl).slice(0, 40);
            if (!have.has(id)) { have.add(id); signals.push({ id, platform: "LOCATION", handle: pl, disc: "GEO", kind: "location", confidence: 40, tier: "weak", status: "candidate", collectedAt, evidence: [{ name: "Self-reported location", detail: `"${pl}" — stated in ${src} post text (weak, self-reported).`, source: sr, weight: 42 }] }); }
            sig.linkedIds = [...new Set([...(sig.linkedIds || []), id])];
          }
          for (const emp of mined.employers) {
            const id = "attr:org:" + normId(emp).slice(0, 40);
            if (!have.has(id)) { have.add(id); signals.push({ id, platform: "EMPLOYER", handle: emp, disc: "▣", kind: "org", confidence: 40, tier: "weak", status: "candidate", collectedAt, evidence: [{ name: "Self-reported employer", detail: `"${emp}" — stated in ${src} post text (weak, self-reported).`, source: sr, weight: 42 }] }); }
            sig.linkedIds = [...new Set([...(sig.linkedIds || []), id])];
          }
        }
      });

      // --- contradiction detector: incompatible activity timezones ---
      // Two accounts claimed as one person whose confident activity clocks sit hours
      // apart is real evidence AGAINST the link. An investigation must be able to say
      // no — this demotes the tier instead of quietly adding another "signal".
      for (let i = 0; i < tzByNode.length; i++) {
        for (let j = i + 1; j < tzByNode.length; j++) {
          const a = tzByNode[i], b = tzByNode[j];
          let diff = Math.abs(a.offset - b.offset);
          if (diff > 12) diff = 24 - diff; // wrap around the clock
          if (diff >= 6) {
            for (const [x, y] of [[a, b], [b, a]] as const) {
              x.sig.evidence.push({
                name: "Incompatible timezone",
                detail: `Activity clock ${x.label} (${x.src}) conflicts with ${y.label} (${y.src}) — ${diff}h apart. Hard to reconcile as one person.`,
                source: "temporal analysis · contradiction", weight: 70,
              });
              const rescored = scoreEvidence(x.sig.evidence);
              x.sig.tier = rescored.tier; x.sig.confidence = rescored.confidence;
            }
          }
        }
      }

      // --- mutual-connection analysis (#2): who links the accounts together ---
      if (connSets.length) {
        for (const ev of analyzeNetwork(connSets)) {
          if (ev.kind === "shared-connection") {
            const id = "hub:" + normId(ev.handle);
            if (!have.has(id)) {
              have.add(id);
              signals.push({
                id, platform: "SHARED CONTACT", handle: "@" + ev.handle, disc: "◎", kind: "person",
                confidence: 62, tier: "probable", status: "review", collectedAt,
                evidence: [{ name: "Shared connection", detail: ev.detail, source: "network analysis · deterministic", weight: 74 }],
              });
            }
            for (const s of ev.sigs) s.linkedIds = [...new Set([...(s.linkedIds || []), id])];
          } else if (ev.kind === "audience-overlap") {
            // two of the seed's accounts share an audience → strong same-person signal
            for (const s of ev.sigs) {
              s.evidence.push({ name: "Shared audience", detail: ev.detail, source: "network analysis · Jaccard overlap", weight: 84 });
              const rescored = scoreEvidence(s.evidence); s.tier = rescored.tier; s.confidence = rescored.confidence;
            }
            if (ev.sigs.length === 2) {
              const [a, b] = ev.sigs;
              a.linkedIds = [...new Set([...(a.linkedIds || []), b.id])];
              b.linkedIds = [...new Set([...(b.linkedIds || []), a.id])];
            }
          }
        }
      }
    }

    // --- domain / infrastructure bridge (flowsint idea, wired to identity) ---
    // If the person exposes a PERSONAL site, enrich its domain and fold the results
    // (registrant email/name, hosting, subdomains, server geo) into the graph — so
    // infrastructure becomes evidence about the PERSON.
    if (domainOn) {
      const PROVIDERS = /(github|gitlab|twitter|x|keybase|gravatar|linkedin|facebook|instagram|youtube|mastodon|bsky|bluesky|medium|dev|reddit|t|telegram|tumblr|wordpress|blogspot|google|bitly|linktr|patreon|substack)\./i;
      const domainFromUrl = (u?: string): string | null => {
        if (!u) return null;
        try { const h = new URL(u.includes("://") ? u : "https://" + u).hostname.replace(/^www\./, ""); return looksLikeDomain(h) && !PROVIDERS.test(h + ".") ? h : null; } catch { return null; }
      };
      const cands = new Set<string>();
      for (const p of merged) {
        for (const l of p.links || []) { const dm = domainFromUrl(l.url); if (dm) cands.add(dm); }
        for (const u of extractFromText(p.bio).urls) { const dm = domainFromUrl(u); if (dm) cands.add(dm); }
      }
      const cand = [...cands][0];
      if (cand) {
        const anchor = signals.find((s) => s.id === "github") || signals.find((s) => !s.kind || s.kind === "platform");
        const dres = await enrichDomain(cand, collectedAt, anchor?.id);
        const haveIds = new Set(signals.map((s) => s.id));
        for (const s of dres.signals) { s.linkedIds = undefined; if (!haveIds.has(s.id)) { signals.push(s); haveIds.add(s.id); } }
        const byId = new Map(signals.map((s) => [s.id, s]));
        for (const [a, b] of dres.edges) {
          const A = byId.get(a), B = byId.get(b);
          if (!A || !B || a === b) continue;
          A.linkedIds = [...new Set([...(A.linkedIds || []), b])];
          B.linkedIds = [...new Set([...(B.linkedIds || []), a])];
        }
      }
    }

    // --- geospatial resolution + convergence ---
    // Turn every location signal into a real coordinate (reverse/forward geocode),
    // then reward locations that several independent sources agree on.
    if (geoOn) {
      const locSigs = signals.filter((s) => s.kind === "location");
      await Promise.all(locSigs.map(async (s) => {
        const coords = parseCoords(s.handle);
        try {
          const place = coords ? await reverseGeocode(coords.lat, coords.lon) : await forwardGeocode(s.handle);
          if (place) {
            s.place = place;
            if (place.label && !coords) s.evidence.push({ name: "Geocoded", detail: place.label, source: "nominatim · OSM", weight: 40 });
          }
        } catch { /* offline → skip, node still stands */ }
      }));
      const pts: GeoPoint[] = locSigs
        .filter((s) => s.place)
        .map((s) => ({ id: s.id, lat: s.place!.lat, lon: s.place!.lon, label: s.place!.label, source: (s.linkedIds || [])[0] || s.id }));
      const clusters = convergeLocations(pts, 25);
      for (const c of clusters) {
        if (c.sources < 2) continue; // convergence = several distinct sources agree
        for (const m of c.members) {
          const s = signals.find((x) => x.id === m.id);
          if (!s) continue;
          s.evidence.push({
            name: "Location convergence",
            detail: `${c.sources} independent sources point to the same area (~${c.radiusKm.toFixed(0)} km spread).`,
            source: "geo convergence · deterministic", weight: 80,
          });
          const rescored = scoreEvidence(s.evidence);
          s.tier = rescored.tier; s.confidence = rescored.confidence;
        }
      }
    }

    // chain of custody: stamp everything with the collection time of this scan
    for (const s of signals) if (!s.collectedAt) s.collectedAt = collectedAt;

    // --- entity resolution: cluster the accounts into distinct identities ---
    const platIds = new Set(signals.filter((s) => !s.kind || s.kind === "platform").map((s) => s.id));
    const rnodes: ResolveNode[] = merged
      .filter((p) => platIds.has(p.id))
      .map((p) => ({
        id: p.id,
        handleN: norm(p.handle.replace(/^u\//, "")),
        nameN: p.displayName ? norm(p.displayName) : undefined,
        locN: p.location ? norm(p.location) : undefined,
        avatarHash: p.avatarHash,
      }));
    const declaredPairs: [string, string][] = [];
    for (const p of merged) {
      if (!platIds.has(p.id) || !p.links) continue;
      for (const l of p.links) {
        const platN = norm(serviceToPlatform(l.service));
        const q = merged.find((x) => x.id !== p.id && platIds.has(x.id) &&
          (norm(x.platform) === platN || (l.handle && norm(x.handle.replace(/^u\//, "")) === norm(l.handle))));
        if (q) declaredPairs.push([p.id, q.id]);
      }
    }
    const sharedAttr = signals
      .filter((s) => s.kind === "email" || s.kind === "phone")
      .map((s) => (s.linkedIds || []).filter((id) => platIds.has(id)))
      .filter((g) => g.length >= 2);
    const resolution = resolveIdentities(rnodes, declaredPairs, sharedAttr);
    const clusterTierOf: Record<string, "verified" | "probable" | "possible"> = {};
    for (const c of resolution.clusters) clusterTierOf[c.id] = c.tier;
    for (const s of signals) {
      if (platIds.has(s.id)) {
        const c = resolution.clusterOf[s.id];
        if (c) { s.clusterId = c; s.clusterTier = clusterTierOf[c]; }
      }
    }
    // attribute nodes inherit the cluster of their first resolved platform neighbor
    for (const s of signals) {
      if (platIds.has(s.id)) continue;
      const nb = (s.linkedIds || []).find((id) => platIds.has(id));
      if (nb && resolution.clusterOf[nb]) { s.clusterId = resolution.clusterOf[nb]; s.clusterTier = clusterTierOf[resolution.clusterOf[nb]]; }
    }

    signals.sort((a, b) => b.confidence - a.confidence);
    return NextResponse.json({
      seed: q,
      mode: isEmail ? "email" : "username",
      count: signals.length,
      signals,
      email,
      sources: { api: apiProfiles.length, web: wmnHits.length },
      // coverage transparency — never silently truncate
      coverage: { checked, available: totalSites, capped: checked < totalSites, catalogue: wmnCatalogue() },
      // honesty: a rate-limited source did NOT report "no account" — it refused to
      // answer. Surfacing this is what stops a silent false negative.
      health: { rateLimited: health.rateLimited, failed: health.failed, blocked: health.blocked, note: healthNote(health) },
      // What the leaks pointed at. `chased` is what this request already enriched
      // cheaply; `deferred` is what did not fit the budget, returned so the client can
      // run the full sweep on it instead of it being silently dropped.
      leads: (chased.length || deferredLeads.length)
        ? { chased, deferred: deferredLeads.map((l) => ({ kind: l.kind, value: l.value, why: l.why })) }
        : undefined,
      // darkweb coverage is always partial — say so rather than let silence read as
      // "nothing is out there". Includes which engines were skipped for lack of Tor.
      darkweb: darkwebNote ? { note: darkwebNote, tor: torActive() } : undefined,
      // minimization: how much of this graph is incidental third parties, which must
      // be access-limited and aged off rather than retained as ordinary intelligence
      minimization: minimizationReport(signals),
    });
  } catch (e) {
    return NextResponse.json({ error: "scan failed", detail: String(e) }, { status: 500 });
  }
}
