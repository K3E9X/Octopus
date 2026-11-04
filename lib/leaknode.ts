// LeakOSINT results → the investigation graph.
//
// The response is grouped BY DATABASE, and that grouping is the finding: "this person
// is in Collection #1" and "this person is in a 2023 Telegram dump" are different
// facts with different weight, and flattening them into one list throws that away.
// So each database becomes its own node, carrying its own rows and its own InfoLeak
// provenance, and they all hang off one parent for the identity.
//
// Everything downstream — the entity resolver, the lead generator, the credential
// reuse guard, the compromise timeline — already works on Signals and ExposureItems,
// so wiring this source in means it inherits all of it rather than growing a parallel
// pipeline.

import { normId } from "./extract";
import type { Signal, Evidence } from "./signals";
import { exposureSummary, exposureVerdict, usableCount, type ExposureItem } from "./exposure";
import { compromiseTimeline, hygiene } from "./compromise";
import { formatCost, type LeakOsintResult } from "./leakosint";

/** A short, honest label for what a database handed over. */
function dbVerdict(items: ExposureItem[]): string {
  const cred = usableCount(items);
  const parts: string[] = [];
  if (cred.clear) parts.push(`${cred.clear} credential(s) in clear`);
  const n = (k: ExposureItem["kind"]) => items.filter((i) => i.kind === k).length;
  if (n("name")) parts.push(`${n("name")} name(s)`);
  if (n("phone")) parts.push(`${n("phone")} phone(s)`);
  if (n("document")) parts.push(`${n("document")} document(s)`);
  if (n("address")) parts.push(`${n("address")} address(es)`);
  return parts.length ? parts.join(" · ") : "rows returned, no identity-grade field";
}

export function leakOsintSignals(term: string, res: LeakOsintResult, collectedAt: string): Signal[] {
  // An error is NOT an empty result. A bad token, an exhausted balance and a genuine
  // miss look identical downstream unless the difference is carried on the node.
  if (res.error) {
    return [{
      id: "lo:err:" + normId(term),
      platform: "LEAKOSINT",
      handle: term,
      disc: "LO",
      kind: "leak",
      confidence: 0,
      tier: "weak",
      status: "candidate",
      collectedAt,
      evidence: [{
        name: "Source did not answer",
        detail: `LeakOSINT returned "${res.error}". This is NOT a negative result — the query did not run, so nothing about this identity has been established either way.`,
        source: "leakosint",
        weight: 5,
      }],
    }];
  }

  if (res.empty && !res.items.length) {
    return [{
      id: "lo:none:" + normId(term),
      platform: "LEAKOSINT",
      handle: term,
      disc: "LO",
      kind: "leak",
      confidence: 0,
      tier: "weak",
      status: "candidate",
      collectedAt,
      evidence: [{
        name: "No match in the index",
        detail: `The query ran and matched nothing at the limit used. That bounds the search, it does not clear the identity — a higher limit searches a wider slice of the database. Cost ${formatCost(res.cost)}.`,
        source: "leakosint",
        weight: 8,
      }],
    }];
  }

  const rootId = "lo:" + normId(term);
  const out: Signal[] = [];

  // one node per database, each with its own rows and its own provenance
  for (const db of res.databases) {
    // res.items is already tagged per database, so the rows for this one are a filter
    const items: ExposureItem[] = res.items.filter((i) => i.source === `leakosint · ${db.name}`);

    const events = compromiseTimeline(items);
    const evidence: Evidence[] = [{
      name: `Present in ${db.name}`,
      detail: `${db.rows.length} row(s). ${dbVerdict(items)}.${db.info ? ` — ${db.info}` : ""}`,
      source: `leakosint · ${db.name}`,
      weight: 78,
    }];
    for (const h of hygiene(items, events)) {
      evidence.push({ name: h.headline, detail: h.detail, source: "octopus · compromise timeline", weight: h.weight });
    }

    out.push({
      id: "lo:db:" + normId(term) + ":" + normId(db.name).slice(0, 28),
      platform: db.name.toUpperCase().slice(0, 22),
      handle: term,
      disc: (db.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "DB").toUpperCase(),
      kind: "leak",
      tier: "probable",
      confidence: 72,
      status: "review",
      collectedAt,
      linkedIds: [rootId],
      exposure: items,
      compromise: events.length ? events : undefined,
      createdAt: events[0]?.date,
      evidence,
    });
  }

  const all = res.items;
  const events = compromiseTimeline(all);
  const root: Signal = {
    id: rootId,
    platform: "LEAKOSINT",
    handle: term,
    disc: "LO",
    kind: "leak",
    tier: res.databases.length > 1 ? "probable" : "possible",
    // more independent dumps is more corroboration, capped: a hundred dumps of the
    // same leaked table is still one observation of this person
    confidence: Math.min(86, 56 + res.databases.length * 6),
    status: "review",
    collectedAt,
    exposure: all,
    compromise: events.length ? events : undefined,
    createdAt: events[0]?.date,
    evidence: [
      {
        name: `Found in ${res.databases.length} database(s)`,
        detail: `${res.rowCount} row(s) across ${res.databases.map((d) => d.name).slice(0, 8).join(", ")}${res.databases.length > 8 ? ` and ${res.databases.length - 8} more` : ""}. ${exposureVerdict(all)}. Cost ${formatCost(res.cost)}.`,
        source: "leakosint",
        weight: 84,
      },
      {
        name: "Bounded by the limit",
        detail: "The limit caps BOTH how many rows come back and how wide a slice of the index is searched. A miss at a low limit is not an absence — it is an unfinished search.",
        source: "octopus",
        weight: 12,
      },
      {
        name: "Sensitive source",
        detail: "Aggregated breach data about a real person, including identity documents in some dumps. Defensive and lawful use only; it is not a target list.",
        source: "guidance",
        weight: 10,
      },
    ],
  };

  return [root, ...out];
}

/** One line for the node label: what this identity actually has behind it. */
export const leakSummary = (items: ExposureItem[]) => exposureSummary(items);
