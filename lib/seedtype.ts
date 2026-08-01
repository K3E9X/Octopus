// What kind of selector is this, and what would Octopus actually do with it?
//
// The dispatch order lived inside the scan route, which meant nothing else could ask
// the question. The landing page needs exactly this: when a visitor types something,
// the answer they see must be the ENGINE'S answer, not a marketing approximation of
// it. A showcase that lies about the product is worse than no showcase.
//
// Pure and synchronous: no network, no keys, runs in the browser.

import { looksLikePhone } from "./phone";
import { looksLikeName } from "./name";
import { hashKind, looksLikeIpLoose, looksLikeDomainName } from "./selectors";
import { emailShape } from "./emailaddr";

export type SeedKind = "email" | "phone" | "ip" | "hash" | "domain" | "name" | "username" | "empty";

export interface SeedRead {
  kind: SeedKind;
  /** what the engine calls this mode */
  label: string;
  /** one line an analyst would accept, not a slogan */
  what: string;
  /** the collection stages this actually triggers, in order */
  stages: string[];
  /** the honest caveat that comes with this seed type */
  caveat?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readSeed(raw: string): SeedRead {
  const q = String(raw || "").trim();
  if (!q) {
    return { kind: "empty", label: "seed", what: "A username, an email, a phone, a name, a domain, an IP or a file hash.", stages: [] };
  }

  if (EMAIL_RE.test(q)) {
    const s = emailShape(q);
    return {
      kind: "email",
      label: "email",
      what: s.isRole
        ? `"${s.base}@" is a shared organisational mailbox — an organisation, not a person.`
        : `Anchored on the address itself, then on what the local part suggests.`,
      stages: [
        "Gravatar by hash — the one verified anchor an address has",
        s.isFreemail ? "domain skipped: a freemail domain names no employer" : "domain enrichment — RDAP, DNS, certificates: the employer",
        "MX / SPF / DMARC — is the mailbox live and managed",
        s.isRole ? "no handle is derived: a role mailbox is not a person" : "handle candidates, dotted form first, then variants",
        "breach corpora and onion indexes",
      ],
      caveat: s.isRole
        ? "Octopus refuses to derive a person from it — that is the commonest false positive in email OSINT."
        : "A handle guessed from a local part is inference. It is scored weaker, and a conflicting name on the profile counts against it.",
    };
  }

  if (looksLikeIpLoose(q)) {
    return {
      kind: "ip",
      label: "IP address",
      what: "Passive only. The address is never contacted — registries answer about it.",
      stages: ["RDAP: allocated network, organisation, country", "the published abuse contact", "reverse DNS, each PTR name becoming its own pivot", "pre-filled pivots to Shodan, Censys, GreyNoise — never queried for you"],
      caveat: "A PTR names the hosting, not the tenant. A private range says so and stops.",
    };
  }

  if (hashKind(q)) {
    return {
      kind: "hash",
      label: `${hashKind(q)!.toUpperCase()} digest`,
      what: "A digest identifies bytes, not a person.",
      stages: ["your own local corpora, searched silently", "sample-repository pivots, pre-filled"],
      caveat: "If nothing keyless answered, the node says the sample was NOT CHECKED — which is not the same as unknown.",
    };
  }

  if (looksLikePhone(q)) {
    return {
      kind: "phone",
      label: "phone",
      what: "Deterministic, offline: validity, country, line type, every format.",
      stages: ["libphonenumber parse — no network, nothing leaves", "pre-filled pivots for the sources that need a human"],
      caveat: "No free source resolves an owner from a number. Octopus does not pretend one exists.",
    };
  }

  if (looksLikeDomainName(q)) {
    return {
      kind: "domain",
      label: "domain",
      what: "The infrastructure behind a name, and the people registered against it.",
      stages: ["RDAP registrant", "DNS and mail exchangers", "subdomains via certificate transparency", "analytics IDs and favicon hash — the fingerprints that link separate sites to one owner"],
    };
  }

  if (looksLikeName(q)) {
    return {
      kind: "name",
      label: "full name",
      what: "A name is the weakest seed there is, and Octopus says so.",
      stages: ["candidate handles generated from the name", "each one pivotable, none of them claimed", "pre-filled name pivots for public records"],
      caveat: "No free source resolves a person from a name. What you get are leads to verify, not an identity.",
    };
  }

  return {
    kind: "username",
    label: "username",
    what: "The broad sweep: where this handle exists, and which of them are the same person.",
    stages: [
      "28 keyless connectors returning real profile data — name, bio, city",
      "718 sites swept by URL pattern, consumer platforms first",
      "plausible variants of the handle, scored strictly weaker",
      "avatars hashed and compared, declared links followed",
      "breach corpora, onion indexes, relationship graph, activity timezone",
    ],
    caveat: "A common handle is refused as a link: two people can share it. Rarity is measured, not assumed.",
  };
}

/** The capability clusters shown on the landing field, and the seeds that light them. */
export const CAPABILITIES: { id: string; label: string; kinds: SeedKind[] }[] = [
  { id: "identity", label: "identity resolution", kinds: ["username", "email", "name"] },
  { id: "coverage", label: "718-site sweep", kinds: ["username", "email"] },
  { id: "email", label: "address intelligence", kinds: ["email"] },
  { id: "infra", label: "infrastructure", kinds: ["domain", "ip", "hash"] },
  { id: "leaks", label: "breach corpora", kinds: ["username", "email", "hash"] },
  { id: "darkweb", label: "onion indexes", kinds: ["username", "email", "domain"] },
  { id: "graph", label: "relationship graph", kinds: ["username", "email"] },
  { id: "geo", label: "geo convergence", kinds: ["username", "email", "ip"] },
  { id: "time", label: "activity timezone", kinds: ["username"] },
  { id: "image", label: "avatar and face", kinds: ["username", "email"] },
  { id: "scoring", label: "honest scoring", kinds: ["username", "email", "phone", "name", "domain", "ip", "hash"] },
  { id: "opsec", label: "opsec egress", kinds: ["username", "email", "phone", "name", "domain", "ip", "hash"] },
];
