// Pure selector predicates — no network, no node builtins, no bundler surprises.
//
// These used to live inside the modules that USE them (lib/infra, lib/domain), which
// meant asking "is this a hash?" dragged node:net and node:tls behind it. That is fine
// on a server route and fatal in a client component: the landing page needs exactly
// these answers, and the build refused to bundle them.
//
// The dependency now points the right way — the server modules import from here.

export type HashKind = "md5" | "sha1" | "sha256" | "sha512";

/** A bare hex digest of a known length. Anything else is not a hash. */
export function hashKind(s: string): HashKind | null {
  const t = String(s || "").trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(t)) return null;
  if (t.length === 32) return "md5";
  if (t.length === 40) return "sha1";
  if (t.length === 64) return "sha256";
  if (t.length === 128) return "sha512";
  return null;
}

export function looksLikeHash(s: string): boolean {
  return hashKind(s) !== null;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/**
 * Loose IP recognition for the browser. The server uses node:net, which is stricter;
 * this only has to be right enough to name the mode a visitor would get.
 */
export function looksLikeIpLoose(s: string): boolean {
  const t = String(s || "").trim();
  if (IPV4.test(t)) return true;
  return t.includes(":") && /^[a-f0-9:]+$/i.test(t) && (t.match(/:/g) || []).length >= 2;
}

const TLD = /\.[a-z]{2,24}$/i;

/** A hostname, not a URL and not an email. */
export function looksLikeDomainName(s: string): boolean {
  const t = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!t || t.includes("@") || t.includes(" ")) return false;
  if (looksLikeIpLoose(t)) return false;
  return /^[a-z0-9.-]+$/.test(t) && t.includes(".") && TLD.test(t) && t.length <= 253;
}
