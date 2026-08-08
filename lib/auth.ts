// Accounts, sessions and roles.
//
// Deliberately small and dependency-free: scrypt from node:crypto for passwords, an
// HMAC-signed cookie for sessions. No JWT library, no auth framework — this guards one
// application with one table, and every extra dependency here is extra surface.
//
// Degradation is explicit, because getting it wrong silently would be the worst
// outcome: without POSTGRES_URL there is nowhere to keep accounts, so the deployment
// runs in SINGLE-OPERATOR mode — the tool is open, and `authEnabled` is false so the
// interface says so instead of implying a protection that does not exist. Anyone
// exposing an instance publicly needs the database.

import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { sql, dbEnabled } from "./db";
import { passwordProblem } from "./pwrule";

const scrypt = promisify(_scrypt) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>;

export const authEnabled = dbEnabled;
export const SESSION_COOKIE = "octopus_session";
const SESSION_DAYS = 14;

export type Role = "admin" | "analyst" | "disabled";

export interface User {
  id: string;
  email: string;
  name?: string;
  role: Role;
  createdAt: number;
  lastSeen?: number;
}

/**
 * The signing secret. A missing secret must NOT fall back to a constant: that would
 * make every deployment forge each other's sessions. Absent, sessions are refused.
 */
function secret(): string {
  return process.env.OCTOPUS_SESSION_SECRET || process.env.AUTH_SECRET || "";
}
export const sessionsUsable = () => authEnabled && secret().length >= 16;

let ready: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      await q`CREATE TABLE IF NOT EXISTS octopus_users (
        id         text PRIMARY KEY,
        email      text UNIQUE NOT NULL,
        name       text,
        role       text NOT NULL DEFAULT 'analyst',
        pw_hash    text NOT NULL,
        pw_salt    text NOT NULL,
        created_at bigint NOT NULL,
        last_seen  bigint
      )`;
      await q`CREATE INDEX IF NOT EXISTS octopus_users_email ON octopus_users (email)`;
    })();
  }
  await ready;
}

// ---- passwords ---------------------------------------------------------------

async function hash(password: string, salt: string): Promise<string> {
  return (await scrypt(password, salt, 64)).toString("hex");
}

/** Constant-time compare; a length mismatch must not short-circuit. */
function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// the rule itself lives in lib/pwrule so the Access screen enforces the SAME one
export { passwordProblem } from "./pwrule";


// ---- accounts ----------------------------------------------------------------

function rowToUser(r: any): User {
  return {
    id: r.id, email: r.email, name: r.name || undefined, role: r.role,
    createdAt: Number(r.created_at), lastSeen: r.last_seen ? Number(r.last_seen) : undefined,
  };
}

export async function countUsers(): Promise<number> {
  if (!authEnabled) return 0;
  await ensureSchema();
  const q = sql();
  if (!q) return 0;
  const rows = await q`SELECT count(*)::int AS n FROM octopus_users`;
  return (rows as any[])[0]?.n ?? 0;
}

export interface CreateResult { user?: User; error?: string }

/**
 * Register. The FIRST account is the administrator — a fresh deployment with no way
 * to reach the admin panel would be a deployment nobody can administer.
 */
export async function createUser(email: string, password: string, name?: string): Promise<CreateResult> {
  if (!authEnabled) return { error: "accounts need a database (POSTGRES_URL)" };
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: "a valid email address is required" };
  const pwProblem = passwordProblem(password);
  if (pwProblem) return { error: `password: ${pwProblem}` };

  await ensureSchema();
  const q = sql();
  if (!q) return { error: "database unavailable" };
  const existing = await q`SELECT id FROM octopus_users WHERE email = ${mail} LIMIT 1`;
  if ((existing as any[]).length) return { error: "that address already has an account" };

  const first = (await countUsers()) === 0;
  const id = "usr_" + randomBytes(9).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const pw = await hash(password, salt);
  const now = Date.now();
  const role: Role = first ? "admin" : "analyst";
  await q`INSERT INTO octopus_users (id, email, name, role, pw_hash, pw_salt, created_at)
          VALUES (${id}, ${mail}, ${name || null}, ${role}, ${pw}, ${salt}, ${now})`;
  return { user: { id, email: mail, name: name || undefined, role, createdAt: now } };
}

export async function verifyUser(email: string, password: string): Promise<User | null> {
  if (!authEnabled) return null;
  await ensureSchema();
  const q = sql();
  if (!q) return null;
  const rows = await q`SELECT * FROM octopus_users WHERE email = ${String(email || "").trim().toLowerCase()} LIMIT 1`;
  const r = (rows as any[])[0];
  if (!r) return null;
  const candidate = await hash(password, r.pw_salt);
  if (!sameHash(candidate, r.pw_hash)) return null;
  if (r.role === "disabled") return null;
  await q`UPDATE octopus_users SET last_seen = ${Date.now()} WHERE id = ${r.id}`;
  return rowToUser(r);
}

export async function getUser(id: string): Promise<User | null> {
  if (!authEnabled) return null;
  await ensureSchema();
  const q = sql();
  if (!q) return null;
  const rows = await q`SELECT * FROM octopus_users WHERE id = ${id} LIMIT 1`;
  const r = (rows as any[])[0];
  return r ? rowToUser(r) : null;
}

export async function listUsers(limit = 200): Promise<User[]> {
  if (!authEnabled) return [];
  await ensureSchema();
  const q = sql();
  if (!q) return [];
  const rows = await q`SELECT * FROM octopus_users ORDER BY created_at DESC LIMIT ${limit}`;
  return (rows as any[]).map(rowToUser);
}

/**
 * Change a role. The last administrator cannot be demoted or disabled — locking
 * everyone out of the admin panel is not a state the UI should be able to reach.
 */
export async function setRole(id: string, role: Role): Promise<{ ok: boolean; error?: string }> {
  if (!authEnabled) return { ok: false, error: "no database" };
  await ensureSchema();
  const q = sql();
  if (!q) return { ok: false, error: "no database" };
  const target = await getUser(id);
  if (!target) return { ok: false, error: "no such user" };
  if (target.role === "admin" && role !== "admin") {
    const rows = await q`SELECT count(*)::int AS n FROM octopus_users WHERE role = 'admin'`;
    if (((rows as any[])[0]?.n ?? 0) <= 1) return { ok: false, error: "this is the last administrator" };
  }
  await q`UPDATE octopus_users SET role = ${role} WHERE id = ${id}`;
  return { ok: true };
}

// ---- sessions ----------------------------------------------------------------
// A signed cookie, not a session table: one HMAC verification instead of a query on
// every request, and revocation is handled by the role check that follows it.

export function signSession(userId: string): string {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const body = `${userId}.${exp}`;
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readSession(token?: string | null): string | null {
  if (!token || !sessionsUsable()) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, expRaw, mac] = parts;
  const expected = createHmac("sha256", secret()).update(`${id}.${expRaw}`).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expRaw) < Date.now()) return null;
  return id;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;
