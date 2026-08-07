// Turning what leaked into what to do next.
//
// The gap this closes: exposure data was DATA ON a node, never nodes. `chainFromNode`
// walks handles, display names and linked email/alias NODES — so an address recovered
// from a combolist sat in a panel and was never scanned, never clustered, never on the
// timeline or the map. The single most productive thing a breach can give you, a second
// identifier for the same person, was being displayed and dropped.
//
// A lead is a selector worth spending a request on, with the reason attached. Ranking
// matters because the budget is finite: an address recovered in clear from a combolist
// outranks a masked one that cannot be queried at all, and both outrank the victim's
// operating system.

import { normId } from "./extract";
import type { ExposureItem } from "./exposure";

export type LeadKind = "email" | "username" | "domain" | "ip";

export interface Lead {
  kind: LeadKind;
  /** the selector to run */
  value: string;
  /** why an analyst would chase it — shown in the UI, not decoration */
  why: string;
  /** higher runs first when the budget is short */
  rank: number;
  /** which index produced the datum */
  source?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Freemail hosts name no employer, so they are never worth a domain enrichment. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "hotmail.com", "hotmail.fr",
  "outlook.com", "outlook.fr", "live.com", "live.fr", "msn.com", "aol.com", "icloud.com",
  "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "mail.com", "yandex.ru", "zoho.com", "orange.fr", "free.fr", "wanadoo.fr", "sfr.fr",
  "laposte.net", "hotmail.co.uk", "yahoo.co.uk", "web.de", "t-online.de", "qq.com",
  "163.com", "126.com", "naver.com", "hanmail.net", "mail.ru", "bk.ru", "inbox.ru",
]);

/**
 * Hosts that are the SERVICE, not the subject's infrastructure. A stealer log full of
 * paypal.com and instagram.com says the victim used those sites, not that they own
 * them, and enriching them burns the budget on a registrar record for Meta.
 */
const PLATFORM_HOSTS = /(^|\.)(google|gmail|facebook|instagram|paypal|amazon|apple|microsoft|live|netflix|steampowered|roblox|discord|twitter|x|tiktok|snapchat|linkedin|reddit|twitch|spotify|ebay|booking|airbnb|uber|coinbase|binance)\.[a-z.]+$/i;

function hostOf(raw: string): string | null {
  try { return new URL(raw.includes("://") ? raw : "http://" + raw).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}

/**
 * Extract the leads from a set of exposure items.
 *
 * `seed` and `known` suppress work already done — re-scanning the seed you started from
 * is the classic way an auto-expansion burns its whole budget going nowhere.
 */
export function leadsFrom(items: ExposureItem[], seed: string, known: Iterable<string> = []): Lead[] {
  const seen = new Set<string>([normId(seed), ...[...known].map(normId)]);
  const out: Lead[] = [];

  const push = (l: Lead) => {
    const key = l.kind + ":" + normId(l.value);
    if (seen.has(key) || seen.has(normId(l.value))) return;
    seen.add(key);
    out.push(l);
  };

  for (const it of items) {
    // A masked value cannot be queried. Chasing `n*****@gmail.com` returns nothing and
    // spends a request saying so.
    if (it.masked) continue;
    const v = it.value.trim();
    if (!v) continue;

    if (it.kind === "email" || (it.kind === "identifier" && EMAIL_RE.test(v))) {
      const addr = v.toLowerCase();
      push({ kind: "email", value: addr, why: `address exposed in ${it.source || "breach data"}`, rank: 90, source: it.source });
      const host = addr.split("@")[1];
      // the employer behind a work address is a finding; a freemail host is not
      if (host && !FREEMAIL.has(host) && !PLATFORM_HOSTS.test(host)) {
        push({ kind: "domain", value: host, why: `mail domain of an exposed address`, rank: 55, source: it.source });
      }
      continue;
    }

    if (it.kind === "identifier") {
      // a username the subject used elsewhere: a second handle for the same person is
      // the most productive thing a breach hands you
      if (/^[A-Za-z0-9][\w.\-]{2,29}$/.test(v)) {
        push({ kind: "username", value: v, why: `login used in ${it.source || "breach data"}`, rank: 80, source: it.source });
      }
      continue;
    }

    if (it.kind === "login") {
      const host = hostOf(v);
      if (host && !PLATFORM_HOSTS.test(host) && !FREEMAIL.has(host)) {
        push({ kind: "domain", value: host, why: `service seen in the logs`, rank: 45, source: it.source });
      }
      continue;
    }

    if (it.kind === "ip" && IPV4_RE.test(v)) {
      // passive only: registries answer about it, the address is never contacted
      push({ kind: "ip", value: v, why: `victim address at compromise time`, rank: 40, source: it.source });
    }
  }

  return out.sort((a, b) => b.rank - a.rank);
}

/** Split by what the scan engine can do with them, highest rank first within each. */
export function leadPlan(leads: Lead[], budget = 6): { run: Lead[]; deferred: Lead[] } {
  const run = leads.slice(0, budget);
  return { run, deferred: leads.slice(budget) };
}
