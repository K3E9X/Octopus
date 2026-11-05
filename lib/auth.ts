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
import { canonicalEmail } from "./emailkey";

const scrypt = promisify(_scrypt) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>;

export const authEnabled = dbEnabled;
export const SESSION_COOKIE = "octopus_session";
const SESSION_DAYS = 14;

/**
 * Roles, and the one line that matters: WHOEVER SPENDS MONEY CANNOT MINT IT.
 *
 * An audit trail signed by someone who can also create the budget proves nothing. So
 * the two powers are split, and the split is the point of this list rather than a
 * tidier way to label people:
 *
 *   owner    claims the deployment (once, atomically, at the first registration).
 *            Grants credit without limit, holds the source token, makes other owners.
 *            This is the account that pays the upstream bill, so it is the only one
 *            that may decide how much of it gets spent.
 *   admin    runs the day to day: users, roles below owner, the audit trail. May
 *            grant credit TO OTHERS, bounded — and never to itself, which is the
 *            whole reason the role exists separately.
 *   analyst  searches.
 *   tester   searches, on a trial allowance. Where every new account starts, because
 *            registration is open and an open door that hands out a working balance
 *            is how a paid API gets drained by a script.
 *   disabled nobody.
 *
 * `analyst` and `tester` are deliberately the same code path with different balances.
 * Two code paths is how one of them ends up unguarded.
 */
export type Role = "owner" | "admin" | "analyst" | "tester" | "disabled";

/** Seniority, for comparisons. Nobody may act on a role at or above their own. */
const RANK: Record<Role, number> = { owner: 4, admin: 3, analyst: 2, tester: 1, disabled: 0 };
export const outranks = (a: Role, b: Role) => RANK[a] > RANK[b];
export const isAtLeast = (r: Role, min: Role) => RANK[r] >= RANK[min];

/** The most an `admin` may hand out in one grant. An owner is not bounded. */
export function adminGrantCap(): number {
  const n = Number(process.env.OCTOPUS_ADMIN_GRANT_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

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

      // The address as typed is kept — mail has to reach it — but UNIQUENESS is on the
      // canonical form, so one mailbox is one account however it is spelled.
      await q`ALTER TABLE octopus_users ADD COLUMN IF NOT EXISTS email_key text`;
      const unkeyed = await q`SELECT id, email FROM octopus_users WHERE email_key IS NULL`;
      for (const r of unkeyed as any[]) {
        await q`UPDATE octopus_users SET email_key = ${canonicalEmail(r.email)} WHERE id = ${r.id}`;
      }
      // Best effort: a deployment that already collected aliases cannot take the index
      // until they are merged, and the check in createUser still blocks new ones.
      try {
        await q`CREATE UNIQUE INDEX IF NOT EXISTS octopus_users_email_key ON octopus_users (email_key)`;
      } catch { /* pre-existing duplicates — see createUser */ }

      // WHO GOT THE ADMIN SEAT. One row, claimed once, by whoever actually got there
      // first. "Is the table empty" read and then acted on is a race, and six
      // simultaneous registrations on a fresh instance all won it.
      await q`CREATE TABLE IF NOT EXISTS octopus_bootstrap (
        id         int PRIMARY KEY CHECK (id = 1),
        claimed_by text NOT NULL,
        at         bigint NOT NULL
      )`;
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

  // One mailbox, one account. Checked on the canonical form so "+tags" and Gmail dots
  // cannot be used to collect another free trial, and backed by a unique index so two
  // simultaneous attempts cannot both pass this check.
  const key = canonicalEmail(mail);
  const existing = await q`SELECT id FROM octopus_users WHERE email_key = ${key} OR email = ${mail} LIMIT 1`;
  if ((existing as any[]).length) return { error: "that address already has an account" };

  const id = "usr_" + randomBytes(9).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const pw = await hash(password, salt);
  const now = Date.now();

  // Created as a tester, ALWAYS. The administrator seat is claimed separately and
  // atomically below, so a failed insert here cannot burn it and a race cannot share it.
  try {
    await q`INSERT INTO octopus_users (id, email, email_key, name, role, pw_hash, pw_salt, created_at)
            VALUES (${id}, ${mail}, ${key}, ${name || null}, ${"tester"}, ${pw}, ${salt}, ${now})`;
  } catch (e) {
    const msg = String((e as any)?.message || e);
    if (/duplicate key|unique/i.test(msg)) return { error: "that address already has an account" };
    throw e;
  }

  // Exactly one row can exist here, so exactly one account can ever claim the
  // deployment. Every later owner is promoted deliberately, by one who already is.
  let role: Role = "tester";
  try {
    const claimed = await q`INSERT INTO octopus_bootstrap (id, claimed_by, at)
                            VALUES (1, ${id}, ${now})
                            ON CONFLICT (id) DO NOTHING
                            RETURNING claimed_by`;
    if ((claimed as any[]).length) {
      await q`UPDATE octopus_users SET role = 'owner' WHERE id = ${id}`;
      role = "owner";
    }
  } catch { /* the seat stays unclaimed; an existing admin can still promote */ }

  return { user: { id, email: mail, name: name || undefined, role, createdAt: now } };
}

/** Has the administrator seat been taken? Used to decide what the sign-in page may say. */
export async function bootstrapClaimed(): Promise<boolean> {
  if (!authEnabled) return true;
  await ensureSchema();
  const q = sql();
  if (!q) return true;
  const rows = await q`SELECT 1 FROM octopus_bootstrap WHERE id = 1 LIMIT 1`;
  return (rows as any[]).length > 0;
}

/**
 * A dummy salt, so an unknown address costs the same as a known one.
 *
 * verifyUser used to return the moment no row matched, which meant scrypt only ran for
 * accounts that exist. Measured on a live instance: 27.9 ms for a real address against
 * 1.4 ms for an unknown one — a twentyfold gap that machine-reads perfectly and undoes
 * the route's careful single error message. For a breach-data product the customer list
 * is itself sensitive, and it was readable by anyone who could time a login.
 */
const DECOY_SALT = "0".repeat(32);

export async function verifyUser(email: string, password: string): Promise<User | null> {
  if (!authEnabled) return null;
  await ensureSchema();
  const q = sql();
  if (!q) return null;
  // Found by canonical key as well, so whoever registered as "vic.tim@gmail.com" can
  // sign in as "victim@gmail.com" — it is the same mailbox and the same account.
  const typed = String(email || "").trim().toLowerCase();
  const rows = await q`SELECT * FROM octopus_users WHERE email = ${typed} OR email_key = ${canonicalEmail(typed)} LIMIT 1`;
  const r = (rows as any[])[0];
  // The work happens either way; only the comparison's outcome differs.
  const candidate = await hash(password, r?.pw_salt || DECOY_SALT);
  if (!r) return null;
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
export async function setRole(id: string, role: Role, actor: User): Promise<{ ok: boolean; error?: string }> {
  if (!authEnabled) return { ok: false, error: "no database" };
  await ensureSchema();
  const q = sql();
  if (!q) return { ok: false, error: "no database" };
  const target = await getUser(id);
  if (!target) return { ok: false, error: "no such user" };

  // Nobody may act on a role at or above their own, in either direction. Without this
  // an admin promotes itself to owner and the separation is decoration.
  if (!outranks(actor.role, target.role) && actor.id !== id) {
    return { ok: false, error: "you cannot change an account at or above your own level" };
  }
  if (!outranks(actor.role, role)) {
    return { ok: false, error: `you cannot grant the ${role} role` };
  }
  if (actor.id === id && role !== actor.role) {
    return { ok: false, error: "you cannot change your own role" };
  }
  if (target.role === "owner" && role !== "owner") {
    const rows = await q`SELECT count(*)::int AS n FROM octopus_users WHERE role = 'owner'`;
    if (((rows as any[])[0]?.n ?? 0) <= 1) return { ok: false, error: "this is the last owner" };
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
