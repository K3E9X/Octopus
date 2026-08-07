// Credential reuse as a correlation signal.
//
// This is the strongest same-person evidence breach data contains, and Octopus was not
// computing it at all. If `marie.dubois@gmail.com` and `mdub_92` appear in dumps with
// the SAME password, that is one person who reused a password — a far harder link than
// a matching display name or a similar handle.
//
// It is also a trap, which is why the guard is the substance of this file. Two people
// both using `123456` are not the same person, and a tool that says they are is worse
// than a tool that says nothing. So the strength of the link is a function of how
// improbable the shared secret is, and a common password produces NO link at all —
// not a weak one. A weak link still ends up in a report.

import type { ExposureItem } from "./exposure";
import type { Evidence } from "./signals";

/**
 * The passwords that are shared by millions of unrelated people. Being on this list is
 * disqualifying, not merely weakening: a match on one carries no information about
 * identity whatsoever.
 */
const COMMON = new Set([
  "123456", "123456789", "12345678", "1234567890", "12345", "1234567", "111111", "000000",
  "password", "password1", "password123", "passw0rd", "motdepasse", "azerty", "azerty123",
  "qwerty", "qwerty123", "qwertyuiop", "abc123", "iloveyou", "admin", "administrator",
  "welcome", "welcome1", "monkey", "dragon", "sunshine", "princess", "football", "baseball",
  "letmein", "master", "shadow", "superman", "batman", "trustno1", "michael", "jordan",
  "soleil", "bonjour", "chocolat", "doudou", "nicolas", "camille", "loulou",
  "1q2w3e4r", "1qaz2wsx", "zaq12wsx", "asdfgh", "asdfghjkl", "qazwsx",
  "666666", "654321", "121212", "112233", "123123", "789456", "159753",
  "root", "toor", "test", "guest", "changeme", "secret", "temp", "default",
]);

export interface ReuseVerdict {
  /** may this shared secret be used to assert one person? */
  linkable: boolean;
  /** 0-100 — how improbable the coincidence is, given the secret */
  strength: number;
  /** the reason, in the words that go in the report */
  reason: string;
}

/**
 * How much does sharing THIS secret tell you? Everything here is about the secret, not
 * about the accounts: the same string is either improbable enough to be a fingerprint
 * or it is not.
 */
export function reuseStrength(secretRaw: string): ReuseVerdict {
  const secret = String(secretRaw || "");
  const lower = secret.toLowerCase();

  if (!secret || secret.length < 4) {
    return { linkable: false, strength: 0, reason: "too short to be distinctive" };
  }
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[!@#$%^&*_.\-]+$/, ""))) {
    return { linkable: false, strength: 0, reason: `"${secret}" is one of the most common passwords in use — millions of unrelated people share it` };
  }
  // a bare year, a date, a phone-shaped run of digits: guessable and widely collided
  if (/^\d+$/.test(secret)) {
    return { linkable: false, strength: 0, reason: "all digits — far too widely shared to identify anyone" };
  }
  // keyboard walks and single repeated characters survive the list above by being long
  if (/^(.)\1+$/.test(secret)) {
    return { linkable: false, strength: 0, reason: "a single repeated character" };
  }
  if (/^[a-z]+$/.test(lower) && secret.length < 8) {
    return { linkable: false, strength: 0, reason: "a short dictionary-shaped word" };
  }

  // Improbability, roughly: length plus how many character classes are in play. This is
  // not entropy in the information-theoretic sense and does not pretend to be — it is a
  // ranking of how unlikely two strangers are to have picked the same string.
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(secret)).length;
  const raw = Math.min(100, 30 + (secret.length - 6) * 6 + classes * 9);
  const strength = Math.max(35, Math.min(96, raw));
  return {
    linkable: true,
    strength,
    reason: `"${secret}" is ${secret.length} characters across ${classes} character class(es) — an unlikely coincidence between two unrelated people`,
  };
}

export interface ReuseLink {
  /** the two identifiers the shared secret ties together */
  a: string;
  b: string;
  secret: string;
  strength: number;
  reason: string;
  /** which sources each side came from */
  sources: string[];
}

/**
 * Find identities tied together by a reused secret.
 *
 * Pairing is done inside a single dump line — `login:password` — because that is the
 * only place the association is actually observed. Reading a password from one record
 * and an identifier from another and declaring them paired would be inventing evidence.
 */
export function reuseLinks(items: ExposureItem[]): ReuseLink[] {
  // secret -> identifiers observed with it
  const bySecret = new Map<string, { id: string; source?: string }[]>();

  for (const it of items) {
    if (it.kind !== "record" || it.masked) continue;
    const line = it.value.trim();
    const i = line.lastIndexOf(":");
    if (i <= 0 || i === line.length - 1) continue;
    const id = line.slice(0, i).trim();
    const secret = line.slice(i + 1).trim();
    if (!id || !secret) continue;
    const arr = bySecret.get(secret) || [];
    if (!arr.some((x) => x.id.toLowerCase() === id.toLowerCase())) arr.push({ id, source: it.source });
    bySecret.set(secret, arr);
  }

  const out: ReuseLink[] = [];
  for (const [secret, ids] of bySecret) {
    if (ids.length < 2) continue;
    const verdict = reuseStrength(secret);
    if (!verdict.linkable) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        out.push({
          a: ids[i].id, b: ids[j].id, secret,
          strength: verdict.strength, reason: verdict.reason,
          sources: [...new Set([ids[i].source, ids[j].source].filter(Boolean) as string[])],
        });
      }
    }
  }
  return out.sort((x, y) => y.strength - x.strength);
}

/** The evidence line an analyst can defend in a report. */
export function reuseEvidence(link: ReuseLink): Evidence {
  return {
    name: "Password reused across identities",
    detail: `${link.a} and ${link.b} appear in breach data with the same password. ${link.reason}. This is behavioural, not cryptographic: it asserts one PERSON, not one account.`,
    source: link.sources.join(" · ") || "breach data",
    weight: link.strength,
  };
}

/**
 * The counter-finding, and the reason this module is safe to run automatically: when a
 * shared secret is worthless, say so on the node instead of silently dropping it. An
 * analyst who sees two accounts with the same password WILL draw the conclusion
 * themselves, so the tool has to be the one that says "not this time".
 */
export function reuseRejections(items: ExposureItem[]): Evidence[] {
  const bySecret = new Map<string, Set<string>>();
  for (const it of items) {
    if (it.kind !== "record" || it.masked) continue;
    const line = it.value.trim();
    const i = line.lastIndexOf(":");
    if (i <= 0 || i === line.length - 1) continue;
    const set = bySecret.get(line.slice(i + 1).trim()) || new Set<string>();
    set.add(line.slice(0, i).trim().toLowerCase());
    bySecret.set(line.slice(i + 1).trim(), set);
  }
  const out: Evidence[] = [];
  for (const [secret, ids] of bySecret) {
    if (ids.size < 2) continue;
    const v = reuseStrength(secret);
    if (v.linkable) continue;
    out.push({
      name: "Shared password REFUSED as a link",
      detail: `${ids.size} identities share this password, but it proves nothing: ${v.reason}. Octopus does not link them.`,
      source: "octopus · reuse guard",
      weight: 12,
    });
  }
  return out;
}
