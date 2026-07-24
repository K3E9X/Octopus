// Hidden-service operations: search the onion indexes, and retrieve a specific
// .onion page to pull pivotable identifiers off it.
//
// Retrieval is separated from the scan on purpose. Fetching a hidden service is a
// deliberate act with its own risk profile — the analyst decides which one to touch,
// it is recorded in the audit trail, and it is refused outright without Tor.

import { NextRequest, NextResponse } from "next/server";
import { setEgress, torActive } from "@/lib/netfetch";
import { darkwebSearch, fetchOnion, onionPageSignals, isOnion, onionVersion } from "@/lib/darkweb";
import { recordQuery } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function applyEgress(req: NextRequest): string | undefined {
  const caseId = req.headers.get("x-octopus-case") || undefined;
  const posture = (req.headers.get("x-octopus-posture") || undefined) as any;
  setEgress({ caseId, posture, proxy: req.headers.get("x-octopus-proxy") || undefined });
  return caseId;
}

// GET /api/onion?q=selector → index search
export async function GET(req: NextRequest) {
  const caseId = applyEgress(req);
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q || q.length > 128) return NextResponse.json({ error: "missing selector" }, { status: 400 });

  recordQuery({
    operator: req.headers.get("x-octopus-operator") || "unknown",
    kind: "darkweb-search",
    selector: q,
    legalBasis: req.headers.get("x-octopus-legal-basis") || "unspecified",
    caseId,
    posture: req.headers.get("x-octopus-posture") || "direct",
  }).catch(() => {});

  const out = await darkwebSearch(q, { tor: torActive() });
  return NextResponse.json(out);
}

// POST { url } → retrieve one hidden service through Tor
export async function POST(req: NextRequest) {
  const caseId = applyEgress(req);
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad request" }, { status: 400 }); }
  const url = String(body?.url || "").trim();
  if (!url || !isOnion(url)) return NextResponse.json({ error: "not an onion address" }, { status: 400 });
  if (!torActive()) {
    return NextResponse.json({
      error: "no Tor proxy configured",
      detail: "Set a SOCKS5 proxy (e.g. socks5://127.0.0.1:9050) in the API panel. Octopus will not attempt a hidden service over the clearnet — the DNS lookup alone would leak the address.",
    }, { status: 412 });
  }
  if (onionVersion(url) !== "v3") {
    return NextResponse.json({ error: "unusable onion address", detail: "v2 addresses were switched off by the Tor network in 2021." }, { status: 400 });
  }

  recordQuery({
    operator: req.headers.get("x-octopus-operator") || "unknown",
    kind: "onion-fetch",
    selector: url,
    legalBasis: req.headers.get("x-octopus-legal-basis") || "unspecified",
    caseId,
    posture: req.headers.get("x-octopus-posture") || "direct",
  }).catch(() => {});

  const page = await fetchOnion(url);
  if (!page) return NextResponse.json({ error: "unreachable", detail: "The service did not answer through Tor (hidden services go down constantly)." }, { status: 502 });
  return NextResponse.json({ page, signals: onionPageSignals(page, new Date().toISOString()) });
}
