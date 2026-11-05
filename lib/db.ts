// Postgres, wherever it lives.
//
// Accounts, credits, the audit trail and the stored source token all need somewhere
// durable. Absent a connection string there is no database, and every module that
// depends on one degrades explicitly and says so, that is the one thing this file
// guarantees to callers.
//
// TWO DRIVERS, ONE INTERFACE. The original client was Neon's serverless driver, which
// does not speak the Postgres wire protocol at all: it posts SQL to Neon's HTTPS
// endpoint. That is right on Vercel and simply cannot reach a Postgres you run
// yourself, so `docker compose --profile db` promised a local database the application
// had no way to talk to. Now the connection string decides: a neon.tech host keeps the
// HTTP driver, anything else gets a normal pooled TCP connection, and both are handed
// back as the same tagged-template function so no caller knows or cares which it got.

import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";

const URL =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.NEON_DATABASE_URL ||
  "";

export const dbEnabled = URL.length > 0;

/**
 * The shape every caller uses:  await q`SELECT … WHERE id = ${value}`
 *
 * Interpolations are parameters, never string concatenation, in both drivers. That is
 * the whole reason the codebase speaks tagged templates and not strings.
 */
export type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

/** Neon's HTTP driver, used only for Neon's own hosts, which is all it can reach. */
const isNeonHost = (url: string) => /\.neon\.tech(?::|\/|$)/i.test(url) || /\bneon\.build\b/i.test(url);

let _sql: SqlFn | null = null;
let _pool: Pool | null = null;

function tcpDriver(url: string): SqlFn {
  if (!_pool) {
    _pool = new Pool({
      connectionString: url,
      // A serverless-ish runtime opens and drops connections constantly; a small pool
      // with a short idle timeout keeps a self-hosted Postgres from accumulating them.
      max: Number(process.env.PGPOOL_MAX) || 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // A local or in-compose Postgres has no certificate worth verifying; a managed one
      // reached over the internet does. Opt in explicitly rather than disabling globally.
      ssl: /\bsslmode=require\b/i.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    // A pool that throws on an idle client's error takes the process down with it.
    _pool.on("error", () => { /* the next query will surface a real failure */ });
  }
  const pool = _pool;
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // "SELECT … $1 … $2", the values never touch the SQL text
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
    const res = await pool.query(text, values as any[]);
    return res.rows;
  };
}

export function sql(): SqlFn | null {
  if (!dbEnabled) return null;
  if (!_sql) _sql = isNeonHost(URL) ? (neon(URL) as unknown as SqlFn) : tcpDriver(URL);
  return _sql;
}

/** Which driver is in use, for the admin screen, so "it is not connecting" is diagnosable. */
export const driverName = (): "neon-http" | "postgres-tcp" | "none" =>
  !dbEnabled ? "none" : isNeonHost(URL) ? "neon-http" : "postgres-tcp";

/**
 * Is the database actually reachable?
 *
 * A connection string is a configuration, not a connection. Every module here treats a
 * failed query as "degrade quietly", which is right in a request path and wrong on an
 * admin screen whose entire job is to tell an operator what is working.
 */
export async function dbReachable(): Promise<{ ok: boolean; driver: string; error?: string }> {
  const driver = driverName();
  if (!dbEnabled) return { ok: false, driver, error: "no connection string configured" };
  try {
    const q = sql();
    if (!q) return { ok: false, driver, error: "no driver" };
    await q`SELECT 1`;
    return { ok: true, driver };
  } catch (e) {
    return { ok: false, driver, error: String((e as Error)?.message || e).slice(0, 200) };
  }
}
