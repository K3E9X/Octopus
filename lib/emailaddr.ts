// The address itself — pure logic, no network, no connectors.
//
// Split out from lib/email so that what an address MEANS can be reasoned about (and
// tested) without dragging the whole collection graph behind it. The route needs this
// to build the email node; the collector needs it to decide what to search.

import { createHash } from "crypto";

// The big free providers: their domain tells you nothing about the person, so no
// organisational inference and no domain enrichment.
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr",
  "live.com", "live.fr", "msn.com", "yahoo.com", "yahoo.fr", "ymail.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "tutanota.com",
  "tuta.io", "gmx.com", "gmx.net", "gmx.fr", "web.de", "mail.com", "zoho.com", "yandex.ru",
  "yandex.com", "mail.ru", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net",
  "bbox.fr", "numericable.fr", "hushmail.com", "fastmail.com",
]);

// Throwaway providers. An address here is deliberately disposable: the person wanted no
// continuity, so treating it as an identity anchor is a mistake.
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "yopmail.com",
  "10minutemail.com", "temp-mail.org", "tempmail.com", "throwawaymail.com", "getnada.com",
  "dispostable.com", "trashmail.com", "maildrop.cc", "fakeinbox.com", "mailnesia.com",
  "spamgourmet.com", "mytemp.email", "moakt.com", "emailondeck.com", "tempr.email",
]);

// Shared mailboxes. These are the richest source of false positives in email OSINT:
// they exist, they answer, and they belong to an organisation, not a human.
const ROLE_LOCALS = new Set([
  "contact", "info", "hello", "admin", "administrator", "support", "help", "helpdesk",
  "sales", "marketing", "press", "media", "jobs", "career", "careers", "recruitment", "rh", "hr",
  "billing", "accounts", "accounting", "compta", "facturation", "noreply", "donotreply",
  "postmaster", "webmaster", "hostmaster", "abuse", "security", "privacy", "dpo", "legal",
  "office", "team", "service", "clients", "customer", "customerservice", "newsletter",
]);

export interface EmailShape {
  /** the address, lowercased and trimmed */
  normalized: string;
  /** everything before the @, as written */
  local: string;
  domain: string;
  /** local part with any +tag removed */
  base: string;
  /** the +tag itself, when present — often names where the address was given out */
  plusTag?: string;
  isFreemail: boolean;
  isDisposable: boolean;
  /** a shared mailbox (contact@, support@…) — an organisation, not a person */
  isRole: boolean;
  /** md5 of the normalized address: Gravatar's key, and a selector in its own right */
  gravatarMd5: string;
}

export function emailShape(email: string): EmailShape {
  const normalized = String(email || "").trim().toLowerCase();
  const [local = "", domain = ""] = normalized.split("@");
  const plus = local.indexOf("+");
  const base = plus > 0 ? local.slice(0, plus) : local;
  const plusTag = plus > 0 ? local.slice(plus + 1) : "";
  return {
    normalized,
    local,
    domain,
    base,
    plusTag: plusTag || undefined,
    isFreemail: FREEMAIL.has(domain),
    isDisposable: DISPOSABLE.has(domain),
    // separators are ignored when matching a role name: "no.reply@" is "noreply@"
    isRole: ROLE_LOCALS.has(base.replace(/[._-]/g, "")),
    gravatarMd5: createHash("md5").update(normalized).digest("hex"),
  };
}

export interface HandleCandidate {
  handle: string;
  /** how it was obtained, for the evidence trail */
  rule: string;
}

/**
 * Handle candidates from an address, best first.
 *
 * The important one is the DOTTED form. Gmail ignores dots for delivery, so the old
 * code stripped them — but that is a fact about the mailbox, not about the handle the
 * person uses elsewhere. Stripping them turned "marie.dubois" into "mariedubois": one
 * word, no separators, from which the variant generator (which works on word parts)
 * could then derive nothing at all — no marie_dubois, no mdubois, no marie-dubois.
 * A single misplaced normalisation was costing most of the email recall.
 */
export function handleCandidates(email: string, max = 3): HandleCandidate[] {
  const s = emailShape(email);
  // not an address at all: "not-an-email" has no domain, and treating its whole text
  // as a handle would search for something the caller never asked about
  if (!s.domain || !s.domain.includes(".") || !s.local) return [];
  // a shared mailbox is not a person's handle — do not go looking for one
  if (s.isRole) return [];
  const out: HandleCandidate[] = [];
  const seen = new Set<string>();
  const push = (h: string, rule: string) => {
    const v = h.replace(/[^a-z0-9_.\-]/g, "");
    if (!v || v.length < 3 || v.length > 40 || seen.has(v)) return;
    seen.add(v);
    out.push({ handle: v, rule });
  };
  push(s.base, "the address local part");
  if (s.base.includes(".")) push(s.base.replace(/\./g, ""), "local part without dots");
  if (s.local !== s.base) push(s.local, "local part including the +tag");
  return out.slice(0, max);
}

/** The primary candidate, for callers that only want one. */
export function deriveHandle(email: string): string {
  return handleCandidates(email, 1)[0]?.handle || "";
}

/** What DNS says about the mail domain (filled in by lib/email — declared here so the
 *  evidence builder stays free of anything that touches the network). */
export interface MailDomainIntel {
  domain: string;
  mx: boolean;
  mxHosts: string[];
  spf: boolean;
  dmarc: boolean;
}

export interface ShapeEvidence { name: string; detail: string; source: string; weight: number }

/**
 * Evidence about the ADDRESS itself. Mostly negative intelligence — the kind that stops
 * a wrong identification rather than starting one.
 */
export function emailShapeEvidence(shape: EmailShape, intel: MailDomainIntel): ShapeEvidence[] {
  const ev: ShapeEvidence[] = [];
  if (shape.isRole) {
    ev.push({
      name: "Role mailbox — contradicts a personal identification",
      detail: `"${shape.base}@" is a shared organisational mailbox. Accounts bearing this name belong to the organisation, not to an individual; do not attribute them to a person.`,
      source: "address shape",
      weight: 70,
    });
  }
  if (shape.isDisposable) {
    ev.push({
      name: "Disposable provider (speculative anchor)",
      detail: `${shape.domain} is a throwaway mail provider. The address was created to be discarded, so it anchors nothing durable about the person.`,
      source: "address shape",
      weight: 30,
    });
  }
  if (shape.plusTag) {
    ev.push({
      name: "Plus-tag present",
      detail: `The address carries the tag "+${shape.plusTag}". Tags are usually chosen to mark WHERE the address was given out — a lead about the service, not about the person.`,
      source: "address shape",
      weight: 35,
    });
  }
  ev.push(
    intel.mx
      ? {
          name: "Domain accepts mail",
          detail: `${intel.domain} publishes MX${intel.mxHosts.length ? ` (${intel.mxHosts.slice(0, 2).join(", ")})` : ""}${intel.spf ? ", SPF" : ""}${intel.dmarc ? ", DMARC" : ""} — the mailbox sits on a live, managed domain.`,
          source: "DNS",
          weight: 40,
        }
      : {
          name: "No mail exchanger — inconsistent with a live address",
          detail: `${intel.domain} publishes no MX record: nothing can receive mail there. The address is dead, mistyped, or was never real.`,
          source: "DNS",
          weight: 60,
        },
  );
  return ev;
}
