// The deployment's LeakOSINT token, kept server-side.
//
// Until now the token could only arrive from the environment, which means a redeploy to
// change it, or from a header the browser sent, which makes it one analyst's key rather
// than the deployment's. Neither is what a hosted product needs: an administrator pastes
// the token once, in the admin screen, and every search on the instance uses it.
//
// Three rules this module exists to enforce.
//
//   THE TOKEN NEVER COMES BACK OUT. Read returns a fingerprint, the shape, the last
//   few characters, when it was set and by whom, never the value. An admin screen that
//   re-displays a secret is a secret that leaks through a screenshot, a support ticket
//   or a shoulder. Changing it means pasting a new one, which is the only operation
//   anybody actually needs.
//
//   IT IS NEVER LOGGED. Not in the audit trail, not in an error, not in a note.
//
//   ABSENCE IS A STATE, NOT AN ERROR. With no database there is nowhere to keep it, so
//   the environment variable is the only answer and the screen says so instead of
//   offering a field that would silently do nothing.

import { sql, dbEnabled } from "./db";

export const storedKeyAvailable = dbEnabled;

/** What a reader is allowed to know about the configured token. */
export interface KeyFingerprint {
  /** where the token in force actually comes from */
  source: "stored" | "environment" | "none";
  /** the last four characters, so an admin can tell two tokens apart */
  tail?: string;
  /** total length, which is enough to spot a truncated paste */
  length?: number;
  /** when it was stored, and by whom, the environment answers neither */
  setAt?: number;
  setBy?: string;
}

let ready: Promise<void> | null = null;
async function ensure(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      // one row per setting; the product has exactly one secret to keep, but a table
      // beats a column so the next one does not need a migration
      await q`CREATE TABLE IF NOT EXISTS octopus_config (
        name    text PRIMARY KEY,
        value   text NOT NULL,
        set_at  bigint NOT NULL,
        set_by  text
      )`;
    })();
  }
  await ready;
}

const NAME = "leakosint_token";

/** The raw token, for the one caller that has to make the request. Never returned to a client. */
export async function sourceToken(): Promise<{ token: string; from: "stored" | "environment" | "none" }> {
  if (dbEnabled) {
    try {
      await ensure();
      const q = sql();
      if (q) {
        const rows = await q`SELECT value FROM octopus_config WHERE name = ${NAME} LIMIT 1`;
        const stored = String((rows as any[])[0]?.value || "").trim();
        if (stored) return { token: stored, from: "stored" };
      }
    } catch { /* a database that will not answer must not take the env fallback down */ }
  }
  const env = String(process.env.LEAKOSINT_TOKEN || "").trim();
  return env ? { token: env, from: "environment" } : { token: "", from: "none" };
}

/** What the admin screen is allowed to display. */
export async function sourceFingerprint(): Promise<KeyFingerprint> {
  const { token, from } = await sourceToken();
  if (!token) return { source: "none" };
  const base: KeyFingerprint = { source: from, tail: token.slice(-4), length: token.length };
  if (from !== "stored") return base;
  try {
    const q = sql();
    if (!q) return base;
    const rows = await q`SELECT set_at, set_by FROM octopus_config WHERE name = ${NAME} LIMIT 1`;
    const r = (rows as any[])[0];
    return r ? { ...base, setAt: Number(r.set_at), setBy: r.set_by || undefined } : base;
  } catch {
    return base;
  }
}

/**
 * The documented token shape is `digits:alphanumerics`, as issued by the bot's /api
 * command. Checked before storing because the alternative is discovering the typo as a
 * failed search later, and because the endpoint penalises malformed requests with a
 * temporary block on the whole deployment's IP.
 */
export function tokenProblem(token: string): string | null {
  const t = String(token || "").trim();
  if (!t) return "paste the token from the bot's /api command";
  if (/\s/.test(t)) return "that contains whitespace, it looks like a partial paste";
  if (!t.includes(":")) return 'that is not the expected shape: a token looks like "123456789:AbCdEf12"';
  const [id, secret] = [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)];
  if (!/^\d+$/.test(id)) return "the part before the colon should be the numeric account id";
  if (secret.length < 6) return "the part after the colon is too short to be the secret";
  return null;
}

export async function setSourceToken(token: string, setBy: string): Promise<{ ok: boolean; error?: string }> {
  if (!dbEnabled) return { ok: false, error: "no database, set LEAKOSINT_TOKEN in the environment instead" };
  const problem = tokenProblem(token);
  if (problem) return { ok: false, error: problem };
  try {
    await ensure();
    const q = sql();
    if (!q) return { ok: false, error: "database unavailable" };
    await q`INSERT INTO octopus_config (name, value, set_at, set_by)
            VALUES (${NAME}, ${token.trim()}, ${Date.now()}, ${setBy})
            ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by`;
    return { ok: true };
  } catch {
    return { ok: false, error: "could not store the token" };
  }
}

/** Remove the stored token. The environment variable, if any, takes over again. */
export async function clearSourceToken(): Promise<{ ok: boolean; error?: string }> {
  if (!dbEnabled) return { ok: false, error: "no database" };
  try {
    await ensure();
    const q = sql();
    if (!q) return { ok: false, error: "database unavailable" };
    await q`DELETE FROM octopus_config WHERE name = ${NAME}`;
    return { ok: true };
  } catch {
    return { ok: false, error: "could not clear the token" };
  }
}
