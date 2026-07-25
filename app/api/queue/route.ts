import { NextRequest, NextResponse } from "next/server";
import { enqueue, getJob, advanceJob, listJobs, cancelJob, progressOf, queueEnabled, queueDurable, type JobStep } from "@/lib/queue";
import { setEgress } from "@/lib/netfetch";
import { recordQuery } from "@/lib/audit";
import type { Signal } from "@/lib/signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One step of durable work: the REAL scan pipeline, not a reduced copy of it.
 *
 * The step used to call scanUsername directly, so a queued run skipped the 718-site
 * sweep, the variants, the correlation and the scoring — a long job produced worse
 * results than a short one, which defeats the purpose. Calling the app's own scan
 * endpoint reuses the whole pipeline without duplicating it, and works identically on
 * a serverless platform and a self-hosted process.
 */
async function runStep(step: JobStep, origin: string, headers: Record<string, string>): Promise<Signal[]> {
  if (step.kind !== "scan" || !origin) return [];
  const url = `${origin}/api/scan?username=${encodeURIComponent(step.target)}` +
    (step.connectors ? `&connectors=${encodeURIComponent(step.connectors)}` : "") +
    `&depth=${step.depth || 200}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 55_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers, cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    const sigs: Signal[] = Array.isArray(data?.signals) ? data.signals : [];
    // namespace the ids by target so two steps cannot collide on the same node id
    return sigs.map((x) => ({ ...x, id: `q:${step.target}:${x.id}` }));
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// POST /api/queue { targets: string[], caseId?, operator?, legalBasis? } → job
export async function POST(req: NextRequest) {
  if (!queueEnabled) return NextResponse.json({ configured: false });
  try {
    const body = await req.json();
    const targets: string[] = Array.isArray(body?.targets) ? body.targets.filter(Boolean).slice(0, 200) : [];
    if (!targets.length) return NextResponse.json({ error: "targets required" }, { status: 400 });
    const operator = req.headers.get("x-octopus-operator") || body?.operator || "unknown";
    const legalBasis = req.headers.get("x-octopus-legal-basis") || body?.legalBasis || "unspecified";
    setEgress({ caseId: body?.caseId, posture: body?.posture });
    for (const t of targets.slice(0, 20)) {
      await recordQuery({ operator, kind: "scan", selector: t, legalBasis, caseId: body?.caseId, note: "queued job" });
    }
    const job = await enqueue(
      targets.map((t) => ({ kind: "scan", target: t, connectors: body?.connectors, depth: body?.depth })),
      { caseId: body?.caseId, operator, note: body?.note, origin: req.nextUrl.origin },
    );
    return NextResponse.json({ configured: true, durable: queueDurable, job });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET /api/queue?id=...&advance=1 → poll (and optionally advance) a job
// GET /api/queue                  → list recent jobs
export async function GET(req: NextRequest) {
  if (!queueEnabled) return NextResponse.json({ configured: false });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ configured: true, jobs: await listJobs() });
  const advance = req.nextUrl.searchParams.get("advance") === "1";
  const existing = await getJob(id);
  if (!existing) return NextResponse.json({ configured: true, error: "job not found" }, { status: 404 });
  // forward the analyst's keys and tradecraft headers so a queued step collects with
  // exactly the same configuration as an interactive scan
  const fwd: Record<string, string> = {};
  for (const h of ["x-octopus-cfg", "x-octopus-posture", "x-octopus-proxy", "x-octopus-case", "x-octopus-operator", "x-octopus-legal-basis"]) {
    const v = req.headers.get(h);
    if (v) fwd[h] = v;
  }
  const origin = existing.origin || req.nextUrl.origin;
  const job = advance ? await advanceJob(id, (st) => runStep(st, origin, fwd)) : existing;
  if (!job) return NextResponse.json({ configured: true, error: "job not found" }, { status: 404 });
  return NextResponse.json({ configured: true, durable: queueDurable, job, progress: progressOf(job) });
}

// DELETE /api/queue?id=... → cancel
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await cancelJob(id);
  return NextResponse.json({ cancelled: true });
}
