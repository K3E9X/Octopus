// The compromise timeline, and what it says about the subject.
//
// The dates were already being collected and thrown away as decoration. They are the
// most operational thing in the whole exposure: WHEN someone was compromised, how many
// times, and — the finding that actually changes what you do next — whether the password
// they were using in 2019 is still the one they were using in 2023.
//
// That last one is not a nicety. A credential from a 2019 dump that the subject has
// since rotated is history; the same credential still appearing in a 2023 dump is a live
// exposure. Only the timeline can tell those apart, and without it every recovered
// password looks equally current.

import type { ExposureItem } from "./exposure";
import { pairsFrom } from "./reuse";
import { pwPattern } from "./pwpattern";

export interface CompromiseEvent {
  /** ISO date, truncated to the day */
  date: string;
  /** what happened, in the analyst's words */
  label: string;
  kind: "breach" | "stealer" | "record";
  source?: string;
  /** the secret observed at that date, when one was */
  secret?: string;
}

const ISO = /(\d{4})[-/](\d{2})(?:[-/](\d{2}))?/;

/** Pull a day-resolution date out of whatever shape the source used. */
export function dateOf(raw: string): string | null {
  const s = String(raw || "");
  const m = s.match(ISO);
  if (m) return `${m[1]}-${m[2]}-${m[3] || "01"}`;
  const year = s.match(/\b(19[89]\d|20[0-4]\d)\b/);
  return year ? `${year[1]}-01-01` : null;
}

/**
 * Build the chronology. Breach names very often carry their own date ("Collection #1
 * (2019-01)"), so the name is parsed as well as the date fields — dropping those would
 * lose most of the timeline on sources that never emit a date field at all.
 */
export function compromiseTimeline(items: ExposureItem[]): CompromiseEvent[] {
  const out: CompromiseEvent[] = [];
  const seen = new Set<string>();

  const add = (e: CompromiseEvent) => {
    const k = e.date + "|" + e.label;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  for (const it of items) {
    if (it.kind === "date") {
      const d = dateOf(it.value);
      if (d) add({ date: d, label: it.label, kind: "stealer", source: it.source });
    } else if (it.kind === "breach") {
      const d = dateOf(it.value);
      if (d) add({ date: d, label: it.value, kind: "breach", source: it.source });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface HygieneFinding {
  kind: "still-in-use" | "rotated" | "escalating" | "repeat-victim";
  headline: string;
  detail: string;
  /** 0-100 — how much this should change what the analyst does next */
  weight: number;
}

/**
 * What the chronology means.
 *
 * Every finding here is stated as a bounded claim. "Still in use" means the same secret
 * appears at two dates, which is evidence the subject did not rotate it — not proof the
 * account is live today, and the wording says so. A tool that reports "credential valid"
 * off a dump date would be inventing a fact nobody observed.
 */
export function hygiene(items: ExposureItem[], events: CompromiseEvent[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  const pairs = pairsFrom(items);

  // A secret seen at two different dates. Dates come from the events, so this needs at
  // least two of them to say anything at all.
  const span = events.length >= 2 ? { first: events[0].date, last: events[events.length - 1].date } : null;

  if (span && span.first.slice(0, 4) !== span.last.slice(0, 4)) {
    const years = Number(span.last.slice(0, 4)) - Number(span.first.slice(0, 4));
    const secrets = [...new Set(pairs.map((p) => p.secret))];
    if (secrets.length === 1 && pairs.length >= 2) {
      out.push({
        kind: "still-in-use",
        headline: "The same password across the whole exposure window",
        detail: `Every recovered credential over ${years} year(s) (${span.first.slice(0, 7)} → ${span.last.slice(0, 7)}) is the same string. The subject did not rotate after being compromised, which makes this credential materially more likely to still be live than its age suggests. It is still not proof the account works today — nobody tried it.`,
        weight: 82,
      });
    } else if (secrets.length > 1) {
      // did they actually change it, or just increment it?
      const roots = new Set(secrets.map((s) => pwPattern(s)?.root).filter(Boolean));
      if (roots.size === 1) {
        out.push({
          kind: "escalating",
          headline: "The password was incremented, not changed",
          detail: `${secrets.length} distinct secrets over ${years} year(s), all built on the stem "${[...roots][0]}". The subject responds to compromise by bumping a number. The next value is predictable in shape, which is exactly why this is worth writing down.`,
          weight: 74,
        });
      } else {
        out.push({
          kind: "rotated",
          headline: "Credentials were genuinely rotated",
          detail: `${secrets.length} unrelated secrets across ${years} year(s). Older recovered credentials are historical and should be treated as such.`,
          weight: 46,
        });
      }
    }
  }

  const stealerCount = events.filter((e) => e.kind === "stealer").length;
  if (stealerCount >= 2) {
    out.push({
      kind: "repeat-victim",
      headline: `Infected ${stealerCount} times`,
      detail: `${stealerCount} separate infostealer events. Repeat infection points at the machine or the habits, not one unlucky click — and each event is a fresh, complete capture of whatever was in the browser at the time.`,
      weight: 66,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** One line for the node subtitle: the shape of the exposure over time. */
export function timelineSummary(events: CompromiseEvent[]): string {
  if (!events.length) return "";
  if (events.length === 1) return events[0].date.slice(0, 7);
  return `${events[0].date.slice(0, 7)} → ${events[events.length - 1].date.slice(0, 7)} · ${events.length} events`;
}
