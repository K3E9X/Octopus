// Durable job queue — collection that survives the platform it runs on.
//
// Real collection takes minutes: a deep sweep, a multi-hop expansion, a corpus scan.
// A serverless function is killed long before that, so today a long scan is simply
// impossible and the analyst has to babysit short bursts. Worse, when a run dies
// halfway its partial work is lost.
//
// This queue stores jobs and their PARTIAL RESULTS in Postgres. A job is a list of
// steps; each completed step is checkpointed, so a run that dies resumes at the next
// step instead of starting over. The UI polls state and can show progress and partial
// findings while the work is still going.

import { sql, dbEnabled } from "./db";
import type { Signal } from "./signals";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobStep {
  /** what to run, e.g. { kind: "scan", target: "johndoe" } */
  kind: string;
  target: string;
  done?: boolean;
  error?: string;
}

export interface QueuedJob {
  id: string;
  caseId?: string;
  operator?: string;
  status: JobStatus;
  steps: JobStep[];
  /** partial results accumulated so far — available while still running */
  signals: Signal[];
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export const queueEnabled = dbEnabled;

let ready: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      await q`CREATE TABLE IF NOT EXISTS octopus_jobs (
        id         text PRIMARY KEY,
        case_id    text,
        operator   text,
        status     text NOT NULL,
        steps      jsonb NOT NULL,
        signals    jsonb NOT NULL,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL,
        note       text
      )`;
      await q`CREATE INDEX IF NOT EXISTS octopus_jobs_status ON octopus_jobs (status, updated_at DESC)`;
    })();
  }
  await ready;
}

function newId(): string {
  return "job_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export async function enqueue(steps: JobStep[], meta: { caseId?: string; operator?: string; note?: string } = {}): Promise<QueuedJob | null> {
  if (!dbEnabled) return null;
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return null;
    const now = Date.now();
    const job: QueuedJob = {
      id: newId(), caseId: meta.caseId, operator: meta.operator, status: "queued",
      steps: steps.map((s) => ({ ...s, done: false })), signals: [],
      createdAt: now, updatedAt: now, note: meta.note,
    };
    await q`INSERT INTO octopus_jobs (id, case_id, operator, status, steps, signals, created_at, updated_at, note)
            VALUES (${job.id}, ${job.caseId || null}, ${job.operator || null}, ${job.status},
                    ${JSON.stringify(job.steps)}::jsonb, ${"[]"}::jsonb, ${now}, ${now}, ${job.note || null})`;
    return job;
  } catch {
    return null;
  }
}

export async function getJob(id: string): Promise<QueuedJob | null> {
  if (!dbEnabled) return null;
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return null;
    const rows = await q`SELECT * FROM octopus_jobs WHERE id = ${id} LIMIT 1`;
    const r = (rows as any[])[0];
    if (!r) return null;
    return {
      id: r.id, caseId: r.case_id || undefined, operator: r.operator || undefined,
      status: r.status, steps: r.steps, signals: r.signals,
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), note: r.note || undefined,
    };
  } catch {
    return null;
  }
}

/** Checkpoint after each step, so a killed run resumes instead of restarting. */
export async function checkpoint(id: string, steps: JobStep[], signals: Signal[], status: JobStatus): Promise<void> {
  if (!dbEnabled) return;
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return;
    await q`UPDATE octopus_jobs
            SET steps = ${JSON.stringify(steps)}::jsonb,
                signals = ${JSON.stringify(signals)}::jsonb,
                status = ${status},
                updated_at = ${Date.now()}
            WHERE id = ${id}`;
  } catch { /* best effort */ }
}

export async function cancelJob(id: string): Promise<void> {
  if (!dbEnabled) return;
  try {
    await ensureSchema();
    const q = sql();
    if (q) await q`UPDATE octopus_jobs SET status = 'cancelled', updated_at = ${Date.now()} WHERE id = ${id} AND status IN ('queued','running')`;
  } catch { /* best effort */ }
}

export async function listJobs(limit = 20, caseId?: string): Promise<QueuedJob[]> {
  if (!dbEnabled) return [];
  try {
    await ensureSchema();
    const q = sql();
    if (!q) return [];
    const rows = caseId
      ? await q`SELECT * FROM octopus_jobs WHERE case_id = ${caseId} ORDER BY updated_at DESC LIMIT ${limit}`
      : await q`SELECT * FROM octopus_jobs ORDER BY updated_at DESC LIMIT ${limit}`;
    return (rows as any[]).map((r) => ({
      id: r.id, caseId: r.case_id || undefined, operator: r.operator || undefined,
      status: r.status, steps: r.steps, signals: r.signals,
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), note: r.note || undefined,
    }));
  } catch {
    return [];
  }
}

export interface JobProgress { total: number; done: number; percent: number; remaining: JobStep[] }

export function progressOf(job: QueuedJob): JobProgress {
  const total = job.steps.length;
  const done = job.steps.filter((s) => s.done).length;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0, remaining: job.steps.filter((s) => !s.done) };
}

/**
 * Run the next pending steps within a time budget, checkpointing after each one.
 * Called repeatedly (by polling or a cron): each invocation advances the job as far
 * as it safely can, then returns — which is exactly how you do long work on a platform
 * that will kill you at 60 seconds.
 */
export async function advanceJob(
  id: string,
  runStep: (step: JobStep) => Promise<Signal[]>,
  budgetMs = 45_000,
): Promise<QueuedJob | null> {
  const job = await getJob(id);
  if (!job || job.status === "done" || job.status === "cancelled") return job;

  const started = Date.now();
  const steps = job.steps;
  let signals = job.signals;
  await checkpoint(id, steps, signals, "running");

  for (const step of steps) {
    if (step.done) continue;
    if (Date.now() - started > budgetMs) break; // out of budget: stop cleanly, resume next call
    try {
      const found = await runStep(step);
      const have = new Set(signals.map((s) => s.id));
      signals = [...signals, ...found.filter((s) => !have.has(s.id))];
      step.done = true;
    } catch (e) {
      step.done = true;
      step.error = String(e).slice(0, 200);
    }
    await checkpoint(id, steps, signals, "running");
  }

  const allDone = steps.every((s) => s.done);
  const status: JobStatus = allDone ? "done" : "running";
  await checkpoint(id, steps, signals, status);
  return { ...job, steps, signals, status, updatedAt: Date.now() };
}
