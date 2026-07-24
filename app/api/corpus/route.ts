import { NextRequest, NextResponse } from "next/server";
import { ingestCorpus, searchCorpus, corpusStats, parseDump, corpusSignals, corpusPersistent } from "@/lib/corpus";
import { recordQuery } from "@/lib/audit";
import { readClientConfig } from "@/lib/reqconfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/corpus            → stats
// GET /api/corpus?q=selector → silent local search (nothing leaves the machine)
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) {
    const stats = await corpusStats();
    return NextResponse.json({ persistent: corpusPersistent, ...stats });
  }
  const operator = req.headers.get("x-octopus-operator") || "unknown";
  const legalBasis = req.headers.get("x-octopus-legal-basis") || "unspecified";
  await recordQuery({ operator, kind: "corpus", selector: q, legalBasis, note: "local corpus search" });
  const hits = await searchCorpus(q);
  return NextResponse.json({ query: q, count: hits.length, hits, signals: corpusSignals(hits, new Date().toISOString()) });
}

// POST /api/corpus { corpus, text } → ingest a dump (credentials redacted at ingest)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const corpus = String(body?.corpus || "").trim();
    const text = String(body?.text || "");
    if (!corpus || !text) return NextResponse.json({ error: "corpus and text required" }, { status: 400 });
    const records = parseDump(text, corpus);
    const stored = await ingestCorpus(records);
    void readClientConfig(req);
    return NextResponse.json({ corpus, parsed: records.length, stored, persistent: corpusPersistent });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
