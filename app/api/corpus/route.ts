import { NextRequest, NextResponse } from "next/server";
import { ingestCorpus, searchCorpus, corpusStats, parseCorpus, corpusSignals, corpusMode, type CorpusMode } from "@/lib/corpus";
import { corpusPersistent } from "@/lib/corpus";
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
  const requested = (req.nextUrl.searchParams.get("mode") || "") as CorpusMode | "";
  const mode = corpusMode(q, requested || undefined);
  const limit = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "25", 10) || 25));
  await recordQuery({ operator, kind: "corpus", selector: q, legalBasis, note: `local corpus search (${mode})` });
  const hits = await searchCorpus(q, limit, mode);
  return NextResponse.json({
    query: q,
    mode,
    count: hits.length,
    hits,
    // a domain/prefix sweep returns records about DIFFERENT people; turning those into
    // identity nodes would be a fabrication, so only an exact match yields signals.
    signals: mode === "exact" ? corpusSignals(hits, new Date().toISOString()) : [],
    note: mode === "exact" ? "" : `${mode} sweep — these records belong to different people; pick a selector and search it exactly to attribute anything`,
  });
}

// POST /api/corpus { corpus, text } → ingest a dump (credentials redacted at ingest)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const corpus = String(body?.corpus || "").trim();
    const text = String(body?.text || "");
    if (!corpus || !text) return NextResponse.json({ error: "corpus and text required" }, { status: 400 });
    // format is detected, not declared: dumps arrive as CSV, JSONL, Telegram exports or
    // plain lines, and making the analyst convert them first is how this goes unused.
    const records = parseCorpus(text, corpus);
    const stored = await ingestCorpus(records);
    void readClientConfig(req);
    return NextResponse.json({
      corpus, parsed: records.length, stored, persistent: corpusPersistent,
      note: corpusPersistent ? "" : "no database configured — this corpus lives in memory for this session only",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
