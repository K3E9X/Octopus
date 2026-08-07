"use client";

// EXPOSURE — what actually leaked.
//
// The complaint this answers: a node announced INFOSTEALER, and behind it were a
// compromise date, an OS string and a line explaining that credentials would not be
// shown. No addresses, no passwords, no service URLs, nothing to click, nothing to
// pivot on. It cost a click to find out there was nothing there.
//
// So this panel sits ABOVE the evidence list, groups the contents by what they are,
// puts credentials first, and makes every item do something: copy it, open it, or make
// it the next seed. If the source masked something, it says the SOURCE masked it —
// which is a different fact from "we chose not to show you".

import { useMemo, useState } from "react";
import { sortExposure, exposureText, type ExposureItem, type ExposureKind } from "@/lib/exposure";

const GROUPS: { kind: ExposureKind; label: string }[] = [
  { kind: "credential", label: "Credentials" },
  { kind: "login", label: "Services signed into" },
  { kind: "email", label: "Addresses" },
  { kind: "record", label: "Records" },
  { kind: "ip", label: "IP addresses" },
  { kind: "machine", label: "Victim machine" },
  { kind: "malware", label: "Malware" },
  { kind: "date", label: "Dates" },
  { kind: "count", label: "Counts" },
  { kind: "other", label: "Other fields" },
];

/** Values worth using as a new seed. Pivoting on an OS string helps nobody. */
const PIVOTABLE: ExposureKind[] = ["email", "login", "ip", "credential"];

const PER_GROUP = 12;

export default function ExposurePanel({ items, onPivot }: { items: ExposureItem[]; onPivot: (v: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const sorted = useMemo(() => sortExposure(items), [items]);

  const grouped = useMemo(() => {
    return GROUPS.map((g) => ({ ...g, rows: sorted.filter((i) => i.kind === g.kind) })).filter((g) => g.rows.length);
  }, [sorted]);

  function copy(text: string, tag: string) {
    navigator.clipboard?.writeText(text).then(
      () => { setCopied(tag); setTimeout(() => setCopied(null), 1400); },
      () => setCopied(null),
    );
  }

  return (
    <>
      <div className="sect sect-exp">
        EXPOSURE
        <button className="exp-copyall" onClick={() => copy(exposureText(items), "__all")}>
          {copied === "__all" ? "copied" : `copy all (${items.length})`}
        </button>
      </div>
      <div className="exp">
        {grouped.map((g) => {
          const showAll = open[g.kind];
          const rows = showAll ? g.rows : g.rows.slice(0, PER_GROUP);
          return (
            <div className="exp-g" key={g.kind}>
              <div className="exp-gh">
                <span className={"exp-gl k-" + g.kind}>{g.label}</span>
                <span className="exp-gn">{g.rows.length}</span>
              </div>
              {rows.map((it, i) => (
                <div className="exp-row" key={i}>
                  <div className="exp-main">
                    <div className="exp-v">
                      {it.url
                        ? <a href={it.url} target="_blank" rel="noopener noreferrer">{it.value}</a>
                        : it.value}
                      {/* the source redacted this, not us — the distinction matters when
                          you are deciding whether to go buy the paid tier */}
                      {it.masked && <em className="exp-mask">masked at source</em>}
                    </div>
                    <div className="exp-l">{it.label}</div>
                  </div>
                  <div className="exp-acts">
                    <button onClick={() => copy(it.value, g.kind + i)}>{copied === g.kind + i ? "ok" : "copy"}</button>
                    {PIVOTABLE.includes(it.kind) && !it.masked && (
                      <button className="exp-pivot" onClick={() => onPivot(it.value)}>pivot</button>
                    )}
                  </div>
                </div>
              ))}
              {g.rows.length > PER_GROUP && (
                <button className="exp-more" onClick={() => setOpen((o) => ({ ...o, [g.kind]: !showAll }))}>
                  {showAll ? "show less" : `show all ${g.rows.length}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
