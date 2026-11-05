// Audit trail and authorization, the difference between a research toy and a tool
// whose output can be defended.
//
// Any system that queries selectors against real people must be able to answer, months
// later: WHO ran this query, WHEN, against WHICH selector, and under WHAT authority.
// Without that record there is no oversight, no way to investigate misuse, and nothing
// to produce when the collection is challenged.
//
// Design notes:
//  - The log is APPEND-ONLY and each row carries a hash chained to the previous one,
//    so a deletion or edit in the middle breaks the chain and is detectable. This is
//    tamper-EVIDENT, not tamper-proof, an honest claim: it survives challenge, it does
//    not survive an attacker with database write access and time.
//  - Every query must carry a legal basis. It is a required field, not a comment.
//  - Degrades to a no-op when no database is configured, so the open-source/solo use
//    case still runs, but `auditEnabled` tells the UI whether the trail exists.

import { createHmac, timingSafeEqual } from "node:crypto";
import { sql, dbEnabled } from "./db";

export const auditEnabled = dbEnabled;

// The product runs one kind of query, a subject lookup, plus the operations around it
// that also touch a subject. Keep this list closed: an open string here is how an
// unaccounted-for query path gets into the trail without anyone noticing.
export type QueryKind = "search" | "platforms" | "leaks" | "export";

export interface AuditEntry {
  /** analyst / operator identity (from the request, never guessed) */
  operator: string;
  kind: QueryKind;
  /** the selector queried, the thing that touches a real person */
  selector: string;
  /** why this query is lawful: warrant/tasking reference, consent, own-data, research… */
  legalBasis: string;
  caseId?: string;
  /** OPSEC posture used, so the trail records how loud we were */
  posture?: string;
  note?: string;
}

let ready: Promise<void> | null = null;

async function ensureAuditSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      await q`CREATE TABLE IF NOT EXISTS octopus_audit (
        id         bigserial PRIMARY KEY,
        at         bigint NOT NULL,
        operator   text NOT NULL,
        kind       text NOT NULL,
        selector   text NOT NULL,
        legal_basis text NOT NULL,
        case_id    text,
        posture    text,
        note       text,
        prev_hash  text,
        hash       text NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS octopus_audit_at ON octopus_audit (at DESC)`;
      await q`CREATE INDEX IF NOT EXISTS octopus_audit_sel ON octopus_audit (selector)`;
      // One row may follow any given row. Two concurrent writers that read the same
      // predecessor now collide here instead of silently forking the chain.
      await q`CREATE UNIQUE INDEX IF NOT EXISTS octopus_audit_prev ON octopus_audit (prev_hash)`;
    })();
  }
  await ready;
}

/**
 * The signing key. Falls back to the session secret so a deployment that already has
 * one gets a keyed chain without further configuration; absent both, the chain is
 * unkeyed and `auditKeyed` says so rather than implying a protection it does not have.
 */
const auditSecret = () =>
  process.env.OCTOPUS_AUDIT_SECRET || process.env.OCTOPUS_SESSION_SECRET || process.env.AUTH_SECRET || "";
export const auditKeyed = () => auditSecret().length >= 16;

/** Length-prefixed so no field's content can shift into the next one's. */
function preimage(e: AuditEntry, at: number, prev: string): string {
  const parts = [prev, String(at), e.operator, e.kind, e.selector, e.legalBasis, e.caseId || "", e.posture || "", e.note || ""];
  return parts.map((x) => `${x.length}:${x}`).join("");
}

function rowHash(e: AuditEntry, at: number, prev: string): string {
  return createHmac("sha256", auditSecret() || "unkeyed-audit-chain").update(preimage(e, at, prev)).digest("hex");
}

/** Compare digests without leaking where they diverge. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(String(a || ""), "utf8"), y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Record a query. Returns false when no trail exists (no DB configured). */
export async function recordQuery(e: AuditEntry): Promise<boolean> {
  if (!dbEnabled) return false;
  try {
    await ensureAuditSchema();
    const q = sql();
    if (!q) return false;
    // Two writers that read the same predecessor both try to claim it; the UNIQUE index
    // on prev_hash lets exactly one win and the loser simply tries again against the row
    // that did. Bounded, because a loop here would be a denial of service on ourselves.
    for (let attempt = 0; attempt < 6; attempt++) {
      const at = Date.now();
      const last = await q`SELECT hash FROM octopus_audit ORDER BY id DESC LIMIT 1`;
      const prev = (last as any[])[0]?.hash || "genesis";
      const h = rowHash(e, at, prev);
      try {
        await q`INSERT INTO octopus_audit (at, operator, kind, selector, legal_basis, case_id, posture, note, prev_hash, hash)
                VALUES (${at}, ${e.operator}, ${e.kind}, ${e.selector}, ${e.legalBasis},
                        ${e.caseId || null}, ${e.posture || null}, ${e.note || null}, ${prev}, ${h})`;
        return true;
      } catch (err) {
        // 23505 = unique_violation: somebody else chained onto `prev` first.
        const code = (err as any)?.code;
        if (code !== "23505" && !/duplicate key|unique/i.test(String((err as any)?.message || ""))) throw err;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface AuditRow {
  id: number; at: number; operator: string; kind: string; selector: string;
  legalBasis: string; caseId?: string; posture?: string; note?: string;
  prevHash?: string; hash: string;
}

export interface AuditFilter {
  /** restrict to one operator. The ONLY way a non-administrator reads this table. */
  operator?: string;
  /** restrict to one case reference */
  caseId?: string;
  selector?: string;
}

/**
 * Read the trail.
 *
 * `operator` is not a convenience filter, it is the access control for the history an
 * ordinary analyst is allowed to see: their own queries and nobody else's. It is
 * applied here, from a value the route takes off the session rather than off the
 * request, so no caller can widen it by asking.
 */
export async function listAudit(limit = 100, filter: AuditFilter | string = {}): Promise<AuditRow[]> {
  if (!dbEnabled) return [];
  const f: AuditFilter = typeof filter === "string" ? { selector: filter } : filter;
  try {
    await ensureAuditSchema();
    const q = sql();
    if (!q) return [];
    const rows = await q`SELECT * FROM octopus_audit
      WHERE (${f.operator ?? null}::text IS NULL OR operator = ${f.operator ?? null})
        AND (${f.caseId ?? null}::text  IS NULL OR case_id  = ${f.caseId ?? null})
        AND (${f.selector ?? null}::text IS NULL OR selector = ${f.selector ?? null})
      ORDER BY id DESC LIMIT ${limit}`;
    return (rows as any[]).map((r) => ({
      id: Number(r.id), at: Number(r.at), operator: r.operator, kind: r.kind, selector: r.selector,
      legalBasis: r.legal_basis, caseId: r.case_id || undefined, posture: r.posture || undefined,
      note: r.note || undefined, prevHash: r.prev_hash || undefined, hash: r.hash,
    }));
  } catch {
    return [];
  }
}

/** The case references an operator has used, most recent first. */
export async function listCases(operator: string, limit = 40): Promise<{ caseId: string; searches: number; last: number }[]> {
  if (!dbEnabled) return [];
  try {
    await ensureAuditSchema();
    const q = sql();
    if (!q) return [];
    const rows = await q`SELECT case_id, count(*)::int AS n, max(at) AS last
      FROM octopus_audit
      WHERE operator = ${operator} AND case_id IS NOT NULL AND case_id <> ''
      GROUP BY case_id ORDER BY max(at) DESC LIMIT ${limit}`;
    return (rows as any[]).map((r) => ({ caseId: r.case_id, searches: Number(r.n), last: Number(r.last) }));
  } catch {
    return [];
  }
}

export interface ChainVerdict {
  intact: boolean;
  checked: number;
  brokenAt?: number;
  /** false when no signing secret is set: the chain is then editable by anyone who can write to it */
  keyed?: boolean;
  /** why the verdict could not be reached, a verdict that cannot be reached is not "intact" */
  error?: string;
}

/** Re-walk the hash chain. A break means a row was altered or removed. */
export async function verifyAuditChain(limit = 5000): Promise<ChainVerdict> {
  if (!dbEnabled) return { intact: true, checked: 0 };
  try {
    await ensureAuditSchema();
    const q = sql();
    if (!q) return { intact: false, checked: 0, error: "no database" };

    // The NEWEST rows, not the oldest. Ordering ASC with a 5 000 cap meant that once a
    // deployment passed five thousand entries, everything recorded after that was never
    // looked at, and the verdict still came back green. An attacker only had to grow
    // the table past the window, which a zero-balance account could do for free, and
    // then edit anything newer undetected. One extra row is fetched so the first row in
    // the window can be chained to its real predecessor rather than assumed.
    const rows = (await q`SELECT * FROM octopus_audit ORDER BY id DESC LIMIT ${limit + 1}`) as any[];
    rows.reverse();
    if (!rows.length) return { intact: true, checked: 0, keyed: auditKeyed() };

    let prev: string | null = rows.length > limit ? rows[0].hash : "genesis";
    let n = 0;
    for (const r of rows.slice(rows.length > limit ? 1 : 0)) {
      const expect = rowHash(
        {
          operator: r.operator, kind: r.kind, selector: r.selector, legalBasis: r.legal_basis,
          caseId: r.case_id || undefined, posture: r.posture || undefined, note: r.note || undefined,
        },
        Number(r.at), prev!,
      );
      if (r.prev_hash !== prev || !sameHash(r.hash, expect)) {
        return { intact: false, checked: n, brokenAt: Number(r.id), keyed: auditKeyed() };
      }
      prev = r.hash;
      n++;
    }
    return { intact: true, checked: n, keyed: auditKeyed() };
  } catch (e) {
    // FAIL CLOSED. Returning "intact" on an exception painted the admin screen green
    // for a database that would not answer, which is the one moment it matters most.
    return { intact: false, checked: 0, error: String((e as Error)?.message || e).slice(0, 160) };
  }
}
