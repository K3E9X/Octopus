// Ownership verification, persisted.
//
// Ties the pure code logic in lib/ownership to the database and to the signed-in account.
// A verification, once passed, is remembered for a window so the person is not challenged
// on every check of the same identifier — but it is scoped to their account, so proving
// ownership for one user never grants it to another.

import { sql, dbEnabled } from "./db";
import { randomBytes } from "node:crypto";
import {
  identifierChannel, normalizeIdentifier, issueChallenge, checkCode, sendCode,
  channelConfigured, type Challenge, type Channel,
} from "./ownership";

const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;   // a passed check lasts a month

let ready: Promise<void> | null = null;
async function ensure(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const q = sql();
      if (!q) return;
      await q`CREATE TABLE IF NOT EXISTS octopus_verifs (
        id          text PRIMARY KEY,
        user_id     text NOT NULL,
        subject     text NOT NULL,
        channel     text NOT NULL,
        hash        text NOT NULL,
        expires     bigint NOT NULL,
        attempts    int NOT NULL DEFAULT 0,
        verified_at bigint,
        at          bigint NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS octopus_verifs_u ON octopus_verifs (user_id, subject)`;
    })();
  }
  await ready;
}

export interface StartResult {
  status: "verified" | "code-sent" | "no-channel" | "unverifiable" | "error";
  channel?: Channel;
  message: string;
}

/**
 * Begin proving ownership of `subject` for this account.
 *  - the account's own email is already proven (they signed in with it).
 *  - another email/phone gets a one-time code, if a channel is configured.
 *  - a username cannot receive a code, so it is not offered here.
 */
export async function startVerification(userId: string, accountEmail: string, rawSubject: string): Promise<StartResult> {
  const channel = identifierChannel(rawSubject);
  if (!channel) {
    return { status: "unverifiable", message: "A username can't be verified — there's nowhere to send a code. Check your email or phone instead." };
  }
  const subject = normalizeIdentifier(rawSubject, channel);

  // shortcut: your account email is already your proven identity
  if (channel === "email" && subject === accountEmail.trim().toLowerCase()) {
    await markVerified(userId, subject, channel);
    return { status: "verified", channel, message: "This is your account email — already verified." };
  }

  if (!dbEnabled) return { status: "error", message: "verification needs a database" };
  if (!channelConfigured(channel)) {
    return {
      status: "no-channel",
      channel,
      message: channel === "email"
        ? "Sending codes by email isn't configured on this deployment. You can still check the email you signed in with."
        : "Sending codes by SMS isn't configured on this deployment yet.",
    };
  }

  await ensure();
  const q = sql()!;
  const { challenge, code } = issueChallenge(subject, channel);
  const sent = await sendCode(channel, subject, code);
  if (!sent) return { status: "error", message: "the verification code could not be sent — try again shortly" };

  // one live challenge per (user, subject): replace any previous
  await q`DELETE FROM octopus_verifs WHERE user_id = ${userId} AND subject = ${subject} AND verified_at IS NULL`;
  await q`INSERT INTO octopus_verifs (id, user_id, subject, channel, hash, expires, attempts, at)
          VALUES (${"vrf_" + randomBytes(9).toString("hex")}, ${userId}, ${subject}, ${channel}, ${challenge.hash}, ${challenge.expires}, 0, ${Date.now()})`;
  return { status: "code-sent", channel, message: `A code was sent to ${channel === "email" ? "that address" : "that number"}. It expires in 10 minutes.` };
}

export interface ConfirmResult { ok: boolean; message: string; }

export async function confirmVerification(userId: string, rawSubject: string, code: string): Promise<ConfirmResult> {
  const channel = identifierChannel(rawSubject);
  if (!channel) return { ok: false, message: "nothing to confirm" };
  const subject = normalizeIdentifier(rawSubject, channel);
  if (!dbEnabled) return { ok: false, message: "verification needs a database" };
  await ensure();
  const q = sql()!;
  const rows = await q`SELECT * FROM octopus_verifs WHERE user_id = ${userId} AND subject = ${subject} AND verified_at IS NULL ORDER BY at DESC LIMIT 1`;
  const r = (rows as any[])[0];
  if (!r) return { ok: false, message: "no pending code — request a new one" };

  const ch: Challenge = { subject, channel, hash: r.hash, expires: Number(r.expires), attempts: Number(r.attempts) };
  const res = checkCode(ch, code);
  await q`UPDATE octopus_verifs SET attempts = ${ch.attempts} WHERE id = ${r.id}`;
  if (!res.ok) {
    const msg = res.reason === "expired" ? "that code has expired — request a new one"
      : res.reason === "too-many" ? "too many attempts — request a new code"
      : "that code is not right";
    return { ok: false, message: msg };
  }
  await q`UPDATE octopus_verifs SET verified_at = ${Date.now()} WHERE id = ${r.id}`;
  return { ok: true, message: "verified" };
}

async function markVerified(userId: string, subject: string, channel: Channel): Promise<void> {
  if (!dbEnabled) return;
  await ensure();
  const q = sql()!;
  const rows = await q`SELECT id FROM octopus_verifs WHERE user_id = ${userId} AND subject = ${subject} AND verified_at IS NOT NULL LIMIT 1`;
  if ((rows as any[]).length) return;
  await q`INSERT INTO octopus_verifs (id, user_id, subject, channel, hash, expires, attempts, verified_at, at)
          VALUES (${"vrf_" + randomBytes(9).toString("hex")}, ${userId}, ${subject}, ${channel}, ${"account"}, ${0}, ${0}, ${Date.now()}, ${Date.now()})`;
}

/** Has this account proven ownership of this identifier, recently enough to still count? */
export async function isVerified(userId: string, accountEmail: string, rawSubject: string): Promise<boolean> {
  const channel = identifierChannel(rawSubject);
  if (!channel) return false;
  const subject = normalizeIdentifier(rawSubject, channel);
  if (channel === "email" && subject === accountEmail.trim().toLowerCase()) return true;
  if (!dbEnabled) return false;
  await ensure();
  const q = sql()!;
  const rows = await q`SELECT verified_at FROM octopus_verifs
    WHERE user_id = ${userId} AND subject = ${subject} AND verified_at IS NOT NULL
    ORDER BY verified_at DESC LIMIT 1`;
  const r = (rows as any[])[0];
  return r ? Date.now() - Number(r.verified_at) < REMEMBER_MS : false;
}
