// Proof of ownership — the gate the whole self-check product rests on.
//
// A person may only see the leaked data for an identifier they have proven they control.
// Two ways to prove it:
//
//   1. It is the email on their account. They signed in with it; it is their identity on
//      this deployment. No extra step.
//   2. Any other email or phone: a one-time code is sent to it. Receiving the code is the
//      proof — only the owner of that inbox or number gets it.
//
// A login/username cannot be verified by a code (there is nowhere to send one), so the
// self-check product does not offer username lookups: that path only makes sense for an
// investigator searching someone else, which is the opposite of this product.
//
// The code itself is never stored — only a hash of it, with a short expiry and an attempt
// cap, so a stored secret cannot leak and a guesser cannot brute-force it. Sending is
// pluggable; with no channel configured the deployment can still verify the account's own
// email, and says plainly that other identifiers need a channel.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export type Channel = "email" | "phone";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function identifierChannel(id: string): Channel | null {
  const s = id.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "email";
  if (/^\+?\d[\d\s().-]{7,}$/.test(s)) return "phone";
  return null;   // a username/login has no channel to receive a code — not verifiable
}

export const normalizeIdentifier = (id: string, ch: Channel) =>
  ch === "email" ? id.trim().toLowerCase() : id.replace(/[^\d+]/g, "");

// ---- code lifecycle ------------------------------------------------------------------

function secret(): string {
  return process.env.OCTOPUS_SESSION_SECRET || process.env.AUTH_SECRET || "octopus-ownership-fallback";
}

function hashCode(subject: string, code: string): string {
  return createHmac("sha256", secret()).update(`${subject}:${code}`).digest("hex");
}

export interface Challenge {
  subject: string;
  channel: Channel;
  hash: string;
  expires: number;
  attempts: number;
}

/** A six-digit code: enough space that five guesses in ten minutes is hopeless. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function issueChallenge(subject: string, channel: Channel): { challenge: Challenge; code: string } {
  const code = newCode();
  return {
    code,
    challenge: { subject, channel, hash: hashCode(subject, code), expires: Date.now() + CODE_TTL_MS, attempts: 0 },
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "expired" | "too-many" | "mismatch" };

/** Check a submitted code against a challenge. Mutates `attempts`; the caller persists it. */
export function checkCode(ch: Challenge, submitted: string): VerifyResult {
  if (Date.now() > ch.expires) return { ok: false, reason: "expired" };
  if (ch.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too-many" };
  ch.attempts++;
  const want = Buffer.from(ch.hash);
  const got = Buffer.from(hashCode(ch.subject, submitted.trim()));
  if (want.length === got.length && timingSafeEqual(want, got)) return { ok: true };
  return { ok: false, reason: "mismatch" };
}

// ---- sending -------------------------------------------------------------------------
// Pluggable. A deployment wires a real sender; without one, only the account's own email
// can be checked (no code needed), and other identifiers report the channel as missing.

export const emailSenderConfigured = () => Boolean(process.env.OCTOPUS_NOTIFY_URL || process.env.SMTP_URL);
export const phoneSenderConfigured = () => Boolean(process.env.OCTOPUS_NOTIFY_URL || process.env.SMS_URL);

export function channelConfigured(ch: Channel): boolean {
  return ch === "email" ? emailSenderConfigured() : phoneSenderConfigured();
}

/**
 * Deliver a code. The default transport is a generic webhook (OCTOPUS_NOTIFY_URL) that a
 * deployment points at its own mail/SMS provider — Octopus never holds those credentials.
 * Returns whether it was accepted; a failure is reported, never swallowed as "sent".
 */
export async function sendCode(channel: Channel, to: string, code: string): Promise<boolean> {
  const url = process.env.OCTOPUS_NOTIFY_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.OCTOPUS_NOTIFY_TOKEN ? { authorization: `Bearer ${process.env.OCTOPUS_NOTIFY_TOKEN}` } : {}) },
      body: JSON.stringify({
        channel, to,
        subject: "Your Octopus verification code",
        text: `Your Octopus code is ${code}. It expires in 10 minutes. If you did not request it, ignore this message.`,
        code,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
