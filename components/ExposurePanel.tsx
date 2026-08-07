"use client";

// EXPOSURE — what actually leaked, and how much of it you can use.
//
// The first version of this panel showed everything a source returned, in order. On real
// Hudson Rock data that turned out to be five rows of `M*********5`, two rows of
// `\***********************_`, and a masked IP — a full-looking panel with nothing in it.
// Counting five credentials when all five are masked is the same lie as not showing
// them at all.
//
// So the panel now leads with the only number that decides anything: how many values are
// CLEAR. Masked rows are kept — a mask still constrains the first character and the
// length — but demoted below the usable ones and folded away by default. Rows carry the
// source that produced them, because with several indexes merged, "which one gave me
// this" is what tells you whether to go and buy the paid tier.
//
// What Octopus cannot do, and does not pretend to: unmask. Hudson Rock's free tier masks
// at their end. The answer to "give me it in clear" is a different source, not a clever
// client.

import { useMemo, useState } from "react";
import {
  sortExposure, exposureText, credentialsText, usableCount, maskPattern,
  type ExposureItem, type ExposureKind,
} from "@/lib/exposure";
import { leadsFrom } from "@/lib/leads";

const GROUPS: { kind: ExposureKind; label: string }[] = [
  { kind: "credential", label: "Credentials" },
  { kind: "identifier", label: "Logins" },
  { kind: "login", label: "Services" },
  { kind: "email", label: "Addresses" },
  { kind: "record", label: "Records" },
  { kind: "breach", label: "Named breaches" },
  { kind: "field", label: "Field classes exposed" },
  { kind: "ip", label: "IP addresses" },
  { kind: "machine", label: "Victim machine" },
  { kind: "malware", label: "Malware" },
  { kind: "date", label: "Dates" },
  { kind: "count", label: "Counts" },
  { kind: "other", label: "Other fields" },
];

/** Values worth using as a new seed. Pivoting on an OS string helps nobody. */
const PIVOTABLE: ExposureKind[] = ["email", "identifier", "login", "ip"];

const PER_GROUP = 10;

export default function ExposurePanel({ items, onPivot, seed, known }: { items: ExposureItem[]; onPivot: (v: string) => void; seed?: string; known?: string[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showMasked, setShowMasked] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const sorted = useMemo(() => sortExposure(items), [items]);
  const cred = useMemo(() => usableCount(items), [items]);
  const creds = useMemo(() => credentialsText(items), [items]);
  // the same extraction the scan uses, so what the panel offers and what the engine
  // chases can never drift apart
  const leads = useMemo(() => leadsFrom(items, seed || "", known || []), [items, seed, known]);

  const grouped = useMemo(
    () => GROUPS
      .map((g) => ({
        ...g,
        clear: sorted.filter((i) => i.kind === g.kind && !i.masked),
        masked: sorted.filter((i) => i.kind === g.kind && i.masked),
      }))
      .filter((g) => g.clear.length || g.masked.length),
    [sorted],
  );

  function copy(text: string, tag: string) {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => { setCopied(tag); setTimeout(() => setCopied(null), 1400); },
      () => setCopied(null),
    );
  }

  function row(it: ExposureItem, key: string) {
    return (
      <div className={"exp-row" + (it.masked ? " is-masked" : "")} key={key}>
        <div className="exp-main">
          <div className="exp-v">
            {it.url
              ? <a href={it.url} target="_blank" rel="noopener noreferrer">{it.value}</a>
              : it.value}
          </div>
          <div className="exp-l">
            {it.label}
            {it.source && <span className="exp-src">{it.source}</span>}
            {/* all a mask actually leaves you: the surviving characters and a length */}
            {it.masked && <span className="exp-pat">{maskPattern(it.value)}</span>}
          </div>
        </div>
        <div className="exp-acts">
          <button onClick={() => copy(it.value, key)}>{copied === key ? "ok" : "copy"}</button>
          {PIVOTABLE.includes(it.kind) && !it.masked && (
            <button className="exp-pivot" onClick={() => onPivot(it.value)}>pivot</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sect sect-exp">EXPOSURE</div>

      {/* The verdict, before the data. This is the line that decides whether the node is
          worth an afternoon, and it was the thing the panel never said. */}
      <div className={"exp-verdict" + (cred.clear ? " is-usable" : "")}>
        <b>{cred.clear ? `${cred.clear} credential${cred.clear > 1 ? "s" : ""} in clear` : "no usable credential"}</b>
        {cred.masked > 0 && <span>{cred.masked} masked at source — the source redacted these, not Octopus</span>}
        {!cred.total && <span>no source returned a credential for this identity</span>}
      </div>

      {/* What this leak gives you to investigate NEXT. Showing the contents without
          showing what to do with them was half the job. */}
      {leads.length > 0 && (
        <div className="exp-leads">
          <div className="exp-lh">{leads.length} lead{leads.length > 1 ? "s" : ""} to investigate</div>
          {leads.slice(0, 6).map((l, i) => (
            <button key={i} className="exp-lead" onClick={() => onPivot(l.value)} title={l.why}>
              <span className={"exp-lk k-" + l.kind}>{l.kind}</span>
              <span className="exp-lv">{l.value}</span>
              <span className="exp-lgo">scan →</span>
            </button>
          ))}
          {leads.length > 6 && <div className="exp-lmore">+{leads.length - 6} more in the groups below</div>}
        </div>
      )}

      <div className="exp-bar">
        <button onClick={() => copy(exposureText(items), "__all")}>
          {copied === "__all" ? "copied" : `copy all (${items.length})`}
        </button>
        {cred.clear > 0 && (
          <button className="exp-pivot" onClick={() => copy(creds, "__cred")}>
            {copied === "__cred" ? "copied" : `copy ${cred.clear} credential${cred.clear > 1 ? "s" : ""}`}
          </button>
        )}
      </div>

      <div className="exp">
        {grouped.map((g) => {
          const all = open[g.kind];
          const rows = all ? g.clear : g.clear.slice(0, PER_GROUP);
          const masksOpen = showMasked[g.kind];
          return (
            <div className="exp-g" key={g.kind}>
              <div className="exp-gh">
                <span className={"exp-gl k-" + g.kind}>{g.label}</span>
                <span className="exp-gn">{g.clear.length}{g.masked.length ? ` +${g.masked.length} masked` : ""}</span>
              </div>
              {rows.map((it, i) => row(it, g.kind + i))}
              {g.clear.length > PER_GROUP && (
                <button className="exp-more" onClick={() => setOpen((o) => ({ ...o, [g.kind]: !all }))}>
                  {all ? "show less" : `show all ${g.clear.length}`}
                </button>
              )}
              {g.masked.length > 0 && (
                <>
                  <button className="exp-more exp-maskbtn" onClick={() => setShowMasked((o) => ({ ...o, [g.kind]: !masksOpen }))}>
                    {masksOpen ? "hide" : "show"} {g.masked.length} masked at source
                  </button>
                  {masksOpen && g.masked.map((it, i) => row(it, g.kind + "m" + i))}
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
