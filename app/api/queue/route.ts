import { NextRequest, NextResponse } from "next/server";
import { enqueue, getJob, advanceJob, listJobs, cancelJob, progressOf, queueEnabled, type JobStep } from "@/lib/queue";
import { scanUsername } from "@/lib/connectors";
import { newHealth } from "@/lib/netfetch";
import { setEgress } from "@/lib/netfetch";
import { recordQuery } from "@/lib/audit";
import type { Signal } from "@/lib/signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One step of durable work. Kept deliberately small so a checkpoint lands often.
async function runStep(step: JobStep): Promise<Signal[]> {
  if (step.kind !== "scan") return [];
  const health = newHealth();
  const profiles = await scanUsername(step.target, undefined, health);
  return profiles.map((p) => ({
    id: `q:${step.target}:${p.id}`, platform: p.platform, handle: p.handle, disc: p.disc,
    url: p.url || undefined, displayName: p.displayName || undefined, avatarUrl: p.avatar || undefined,
    kind: "platform" as const, confidence: 55, tier: "possible" as const, status: "candidate" as const,
    collectedAt: new Date().toISOString(),
    evidence: [{ name: "Queued collection", detail: `${p.handle} on ${p.platform} (durable job).`, source: p.source, weight: 55 }],
  }));
}

// POST /api/queue { targets: string[], caseId?, operator?, legalBasis? } → job
export async function POST(req: NextRequest) {
  if (!queueEnabled) return NextResponse.json({ configured: false, note: "Durable jobs need a database (POSTGRES_URL)." });
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
    const job = await enqueue(targets.map((t) => ({ kind: "scan", target: t })), { caseId: body?.caseId, operator, note: body?.note });
    return NextResponse.json({ configured: true, job });
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
  const job = advance ? await advanceJob(id, runStep) : await getJob(id);
  if (!job) return NextResponse.json({ configured: true, error: "job not found" }, { status: 404 });
  return NextResponse.json({ configured: true, job, progress: progressOf(job) });
}

// DELETE /api/queue?id=... → cancel
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await cancelJob(id);
  return NextResponse.json({ cancelled: true });
}
