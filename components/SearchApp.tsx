"use client";

// Octopus Leak — the search surface.
//
// One question: what does breach data hold about this subject? An operator enters an
// email, a phone, a handle or a name, declares why they are allowed to look, sees the
// price before spending it, and gets back everything the rows say — consolidated into
// a person, grouped by what it is, where it leaked and when.
//
// Two things in this interface exist to stop it lying, and they are not decoration:
//
//   The price is shown BEFORE the search. The upstream API bills per request on a
//   formula that makes a three-word name three times the cost of an address, and says
//   nothing about it until the money is gone.
//
//   A subject that does not designate one person is labelled as such, and the people
//   who merely share part of the query are shown in their own section. A name search
//   rendered as one person's report is a convincing document that is wrong.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { OctoMark } from "./OctoMark";

// the constellation view is SVG-heavy and only needed once a report exists
const LeakOrbit = dynamic(() => import("./LeakOrbit"), { ssr: false });

type Sev = "critical" | "high" | "medium" | "low";
type Kind = "email" | "phone" | "username" | "name" | "free";

interface Finding { category: string; severity: Sev; label: string; value: string; source: string; masked?: boolean }
interface CatReport { category: string; label: string; severity: Sev; meaning: string; action: string; findings: Finding[]; distinct: number }
interface SrcReport { name: string; info: string; date?: string; sortDate: number; findings: Finding[]; severity: Sev }
interface TLEntry { name: string; date: string; sortDate: number }
interface ConsolidatedValue { value: string; sources: string[]; occurrences: number; variants?: string[]; masked?: boolean }
interface Identity {
  facets: Record<string, ConsolidatedValue[] | undefined>;
  corroboration: { facets: number; corroborated: number; databases: number };
}
interface OtherSubject { anchor: string; matched: string[]; sources: string[]; findings: Finding[] }

interface Report {
  subject: { raw: string; kind: Kind; canonical: string; unique: boolean; note?: string };
  verdict: "clear" | "exposed" | "critical";
  identity: Identity;
  summary: string;
  dataPoints: number;
  breachCount: number;
  categories: CatReport[];
  sources: SrcReport[];
  timeline: TLEntry[];
  highlights: { financial: Finding[]; passwords: Finding[] };
  excluded: { partial: number; unrelated: number; total: number };
  others: OtherSubject[];
}

interface Quote {
  subject: { raw: string; kind: Kind; canonical: string; unique: boolean };
  limit: number;
  metered: boolean;
  exact: { query: string; complexity: number; formatted: string; note?: string };
  permutations: { query: string; complexity: number; formatted: string; note?: string } | null;
}

type Step = "enter" | "basis" | "loading" | "report";
type View = "identity" | "orbit" | "category" | "source" | "timeline";

const SEV_LABEL: Record<Sev, string> = { critical: "critical", high: "high", medium: "notable", low: "minor" };
const SENSITIVE = new Set(["password", "financial", "document"]);

// What each selector promises, in the operator's words. The honest half matters more
// than the capable half: only the first three pin a single person.
const KIND_LABEL: Record<Kind, string> = {
  email: "email address",
  phone: "phone number",
  username: "handle",
  name: "name",
  free: "free-text term",
};

const FACET_LABEL: Record<string, string> = {
  name: "Name", email: "Email", phone: "Phone", address: "Address", username: "Handle",
  document: "ID document", employer: "Employer", birthdate: "Date of birth",
  password: "Password", ip: "IP address",
};
const FACET_ORDER = ["name", "birthdate", "email", "phone", "address", "username", "document", "employer", "ip", "password"];

const LEGAL_BASES: { id: string; label: string; detail: string }[] = [
  { id: "own-data", label: "My own data", detail: "The subject is me, or an identifier I control." },
  { id: "consent", label: "With consent", detail: "The subject asked for this check." },
  { id: "investigation", label: "Investigation", detail: "Fraud, due diligence or threat intelligence, under a case reference." },
  { id: "legal-request", label: "Legal request", detail: "A warrant, tasking or court order." },
  { id: "security-research", label: "Security research", detail: "Defensive research, with the findings not redistributed." },
];

// Inline icons — a consistent 1.5px stroke set, never emoji.
const IconWarn = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
);
const IconScale = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v18" /><path d="M5 7h14" /><path d="M7 7 4 14h6L7 7Z" /><path d="M17 7l-3 7h6l-3-7Z" /><path d="M8 21h8" />
  </svg>
);

export default function SearchApp() {
  const [step, setStep] = useState<Step>("enter");
  const [subject, setSubject] = useState("");
  const [basis, setBasis] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [permutations, setPermutations] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [headline, setHeadline] = useState("");
  const [view, setView] = useState<View>("identity");
  const [account, setAccount] = useState<{ authed: boolean; email?: string; balance?: number; metered: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth").then((r) => r.json()).then((d) =>
      setAccount({ authed: !!d.me, email: d.me?.email, balance: d.balance, metered: !!d.metered })).catch(() => {});
  }, []);

  // The quote is fetched as the operator types the subject, before anything is spent.
  // Debounced because it is a keystroke-rate request, even though it costs nothing.
  useEffect(() => {
    const q = subject.trim();
    if (!q) { setQuote(null); return; }
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setQuote(d)).catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [subject]);

  const run = useCallback(async () => {
    if (!basis) return;
    setErr(""); setStep("loading");
    const started = Date.now();
    const res = await fetch("/api/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: subject.trim(), legalBasis: basis, caseRef: caseRef.trim() || undefined, permutations }),
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })).catch(() => ({ status: 0, data: {} as any }));

    // let the scan animation breathe for a beat so it never flickers
    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - (Date.now() - started))));

    if (res.status === 200 && res.data.report) {
      const rep: Report = res.data.report;
      setReport(rep); setHeadline(res.data.headline || "");
      setView(rep.verdict === "clear" ? (rep.others.length ? "category" : "identity") : "identity");
      setStep("report");
      if (typeof res.data.balance === "number") setAccount((a) => (a ? { ...a, balance: res.data.balance } : a));
      return;
    }
    setStep("basis");
    setErr(res.data.error || "The search could not run.");
  }, [subject, basis, caseRef, permutations]);

  const reset = useCallback(() => {
    setStep("enter"); setReport(null); setErr(""); setBasis(""); setCaseRef(""); setPermutations(false);
  }, []);

  return (
    <div className="lk2">
      <header className="lk2-top">
        <Link className="lk2-brand" href="/"><OctoMark size={30} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
        <nav>
          <a href="#plans">Plans</a>
          {account?.authed
            ? <>{account.metered && typeof account.balance === "number" && <span className="lk2-bal">{account.balance.toLocaleString("en-US")} cr</span>}<Link href="/admin">Account</Link></>
            : <Link className="lk2-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="lk2-main">
        {step === "enter" && (
          <Enter subject={subject} setSubject={setSubject} quote={quote} err={err}
            next={() => { setErr(""); setStep("basis"); }} />
        )}
        {step === "basis" && (
          <Basis {...{ subject, quote, basis, setBasis, caseRef, setCaseRef, permutations, setPermutations, run, busy, err, reset }} />
        )}
        {step === "loading" && <Scanning subject={subject} />}
        {step === "report" && report && <ReportView {...{ report, headline, view, setView, reset }} />}

        {step !== "report" && step !== "loading" && <Plans authed={!!account?.authed} />}
      </main>
    </div>
  );
}

// ---- step: enter ----------------------------------------------------------------------

function Enter({ subject, setSubject, quote, next, err }: any) {
  const kind = quote?.subject?.kind as Kind | undefined;
  return (
    <section className="lk2-hero">
      <div className="lk2-eyebrow">breach data lookup</div>
      <h1>What has leaked<br />about <span>this subject</span>?</h1>
      <p>Enter an email address, a phone number, a handle or a name. You get back every record breach data holds — names, addresses, passwords, bank details — consolidated into one subject, with the database each fact came from.</p>

      <div className="lk2-box">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} spellCheck={false} autoComplete="off"
          placeholder="email, phone, handle or name" onKeyDown={(e) => { if (e.key === "Enter" && subject.trim()) next(); }} />
        <button onClick={next} disabled={!subject.trim()}>Continue</button>
      </div>
      {err && <p className="lk2-err">{err}</p>}

      {/* What the tool thinks it was given, and what that buys — before any money moves. */}
      {quote && (
        <div className={"lk2-read" + (quote.subject.unique ? "" : " ambiguous")}>
          <span className="lk2-read-k">read as</span>
          <b>{KIND_LABEL[kind || "free"]}</b>
          <code>{quote.subject.canonical}</code>
          <span className="lk2-read-p">{quote.exact.formatted}</span>
          {!quote.subject.unique && (
            <em>a {KIND_LABEL[kind || "free"]} does not designate one person — results will be grouped by who they appear to be</em>
          )}
        </div>
      )}

      <div className="lk2-reveal">
        <span>what a report uncovers</span>
        <div>
          {["Passwords", "Bank details · RIB / IBAN", "Full name & DOB", "Home address", "Email", "Phone", "Usernames", "Employer", "ID documents"]
            .map((t, i) => <em key={t} style={{ ["--i" as any]: i }}>{t}</em>)}
        </div>
      </div>

      <p className="lk2-fine">Every search is recorded against your account and the basis you declare, in a tamper-evident log. That record is what makes this defensible — use it accordingly.</p>
    </section>
  );
}

// ---- step: declare a basis, see the price ---------------------------------------------

function Basis({ subject, quote, basis, setBasis, caseRef, setCaseRef, permutations, setPermutations, run, busy, err, reset }: any) {
  const q: Quote | null = quote;
  const chosen = permutations && q?.permutations ? q.permutations : q?.exact;
  return (
    <section className="lk2-verify lk2-basis">
      <div className="lk2-ico"><IconScale /></div>
      <h2>Why are you running this search?</h2>
      <p>It is recorded with the query, against your account, in a log that cannot be edited without the break showing. Pick the one that is true.</p>

      <div className="lk2-bases">
        {LEGAL_BASES.map((b) => (
          <button key={b.id} className={"lk2-basis-opt" + (basis === b.id ? " on" : "")} onClick={() => setBasis(b.id)}>
            <b>{b.label}</b><span>{b.detail}</span>
          </button>
        ))}
      </div>

      {(basis === "investigation" || basis === "legal-request") && (
        <div className="lk2-box lk2-box-sm">
          <input value={caseRef} onChange={(e) => setCaseRef(e.target.value)} placeholder="case or tasking reference (optional)" />
        </div>
      )}

      {/* Both ways of searching a multi-word subject, priced. Quoting is not only
          cheaper — it is narrower, and the interface has to say which it is buying. */}
      {q?.permutations && (
        <div className="lk2-depth">
          <button className={permutations ? "" : "on"} onClick={() => setPermutations(false)}>
            <b>Exact phrase</b><span>{q.exact.formatted}</span><em>{q.exact.note}</em>
          </button>
          <button className={permutations ? "on" : ""} onClick={() => setPermutations(true)}>
            <b>Every word order</b><span>{q.permutations.formatted}</span><em>{q.permutations.note}</em>
          </button>
        </div>
      )}

      <div className="lk2-spend">
        <span>searching</span><code>{chosen?.query || subject}</code>
        <span>for</span><b>{chosen?.formatted || "—"}</b>
      </div>

      <div className="lk2-box lk2-box-sm">
        <button onClick={run} disabled={busy || !basis}>{busy ? "…" : "Run the search"}</button>
      </div>
      {err && <p className="lk2-err">{err}</p>}
      <button className="lk2-link" onClick={reset}>search something else</button>
    </section>
  );
}

// ---- step: loading (the deep scan) ----------------------------------------------------

function Scanning({ subject }: { subject: string }) {
  const lines = ["Querying breach index…", "Matching records…", "Classifying exposure…", "Ranking by severity…"];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((n) => Math.min(n + 1, lines.length - 1)), 280); return () => clearInterval(t); }, []);
  return (
    <section className="lk2-scan">
      <div className="lk2-sonar"><span /><span /><span /><OctoMark size={48} glow /></div>
      <div className="lk2-scan-subject">{subject}</div>
      <div className="lk2-scan-line">{lines[i]}</div>
    </section>
  );
}

// ---- step: report ---------------------------------------------------------------------

function ReportView({ report, headline, view, setView, reset }: {
  report: Report; headline: string; view: View; setView: (v: View) => void; reset: () => void;
}) {
  const hasHi = report.highlights.financial.length > 0 || report.highlights.passwords.length > 0;
  return (
    <section className="lk2-report">
      <Verdict report={report} headline={headline} />

      {hasHi && <Critical hi={report.highlights} />}

      <div className="lk2-tabs">
        {([
          ["identity", "Subject"],
          ["orbit", "Orbit"],
          ["category", `By type · ${report.categories.length}`],
          ["source", `By breach · ${report.breachCount}`],
          ["timeline", "Timeline"],
        ] as [View, string][]).map(([v, lbl]) => (
          <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}
            disabled={(v === "timeline" && report.timeline.length === 0) || (v === "orbit" && report.verdict === "clear")}>{lbl}</button>
        ))}
      </div>

      <div className={"lk2-view" + (view === "identity" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">Subject</h4>
        <IdentityPanel report={report} />
      </div>

      {view === "orbit" && <LeakOrbit report={{ subject: report.subject.raw, sources: report.sources, breachCount: report.breachCount, dataPoints: report.dataPoints }} />}

      {/* All three views stay mounted; only the open one shows on screen. Print shows
          every view so the PDF is the complete report whichever tab was open. */}
      <div className={"lk2-view" + (view === "category" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">By type</h4>
        <div className="lk2-cats">
          {report.categories.map((c, i) => <CategoryCard key={c.category} c={c} i={i} />)}
        </div>
      </div>
      <div className={"lk2-view" + (view === "source" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">By breach</h4>
        <div className="lk2-srcs">
          {report.sources.map((s, i) => <SourceCard key={s.name} s={s} i={i} />)}
        </div>
      </div>
      <div className={"lk2-view" + (view === "timeline" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">Timeline</h4>
        <Timeline sources={report.sources} />
      </div>

      {report.others.length > 0 && <Others others={report.others} subject={report.subject} />}

      {report.verdict === "clear" && (
        <p className="lk2-clear">Nothing surfaced at this search depth. A deeper search covers more of the index — raise the limit on a paid plan to widen it.</p>
      )}

      <div className="lk2-actions">
        <button className="lk2-print" onClick={() => window.print()}>Download report (PDF)</button>
        <button className="lk2-again" onClick={reset}>Check another identifier</button>
      </div>
    </section>
  );
}

/**
 * The figure, stated.
 *
 * This used to count up from zero over 600ms. It was removed rather than repaired,
 * twice over. The animation showed a WRONG NUMBER on every frame before it finished —
 * a report with three categories rendered "0 CATEGORIES" — and anything that stopped
 * it reaching the end left that wrong number on screen for good: a print, a headless
 * screenshot, a paused tab, a device where requestAnimationFrame never got a frame.
 * Seeding the real value first and animating away from it only narrowed the window.
 *
 * A product whose whole claim is that it does not assert what it cannot support has no
 * business animating through figures it knows to be false, for decoration. The number
 * is simply the number.
 */
function Stat({ n }: { n: number }) {
  return <>{n.toLocaleString("en-US")}</>;
}

function Verdict({ report, headline }: { report: Report; headline: string }) {
  const tag = report.verdict === "clear" ? "clear" : report.verdict === "critical" ? "critical exposure" : "exposed";
  return (
    <div className={"lk2-verdict v-" + report.verdict}>
      <div className="lk2-vring"><span className="lk2-vtag">{tag}</span></div>
      <h2>{report.subject.raw}</h2>
      <p>{headline}</p>
      {report.verdict !== "clear" && (
        <div className="lk2-vstats">
          <div><b><Stat n={report.dataPoints} /></b><span>data points</span></div>
          <div><b><Stat n={report.breachCount} /></b><span>breaches</span></div>
          <div><b><Stat n={report.categories.length} /></b><span>categories</span></div>
        </div>
      )}
    </div>
  );
}

function Critical({ hi }: { hi: Report["highlights"] }) {
  return (
    <div className="lk2-critical">
      <div className="lk2-crit-h"><IconWarn /> Act on these first</div>
      <div className="lk2-crit-grid">
        {hi.financial.map((f, i) => <Value key={"f" + i} f={f} tag="bank / financial" />)}
        {hi.passwords.map((f, i) => <Value key={"p" + i} f={f} tag="password" />)}
      </div>
    </div>
  );
}

function CategoryCard({ c, i }: { c: CatReport; i: number }) {
  return (
    <div className={"lk2-cat s-" + c.severity} style={{ ["--i" as any]: i }}>
      <div className="lk2-cat-h">
        <span className="lk2-sev">{SEV_LABEL[c.severity]}</span>
        <h3>{c.label}</h3>
        <span className="lk2-count">{c.distinct}</span>
      </div>
      <p className="lk2-meaning">{c.meaning}</p>
      <div className="lk2-vals">
        {c.findings.slice(0, 40).map((f, j) => <Value key={j} f={f} showSource />)}
        {c.findings.length > 40 && <div className="lk2-more">+{c.findings.length - 40} more</div>}
      </div>
      <p className="lk2-action"><b>Do this:</b> {c.action}</p>
    </div>
  );
}

function SourceCard({ s, i }: { s: SrcReport; i: number }) {
  return (
    <div className={"lk2-src s-" + s.severity} style={{ ["--i" as any]: i }}>
      <div className="lk2-src-h">
        <h3>{s.name}</h3>
        {s.date && <span className="lk2-src-date">{s.date}</span>}
        <span className="lk2-count">{s.findings.length}</span>
      </div>
      {s.info && <p className="lk2-src-info">{s.info}</p>}
      <div className="lk2-rows">
        {s.findings.map((f, j) => (
          <div className="lk2-row" key={j}>
            <span className="lk2-row-k">{f.label}</span>
            <RowValue f={f} />
          </div>
        ))}
        {!s.findings.length && <div className="lk2-more">No field tied to you in this breach — listed for completeness.</div>}
      </div>
    </div>
  );
}

function Timeline({ sources }: { sources: SrcReport[] }) {
  const dated = sources.filter((s) => s.sortDate > 0 && s.date).sort((a, b) => a.sortDate - b.sortDate);
  if (!dated.length) return <p className="lk2-clear">No dated breaches to place on a timeline.</p>;
  return (
    <div className="lk2-timeline">
      {dated.map((s, i) => (
        <div className={"lk2-tl s-" + s.severity} key={s.name} style={{ ["--i" as any]: i }}>
          <div className="lk2-tl-dot" />
          <div className="lk2-tl-body">
            <div className="lk2-tl-date">{s.date}</div>
            <div className="lk2-tl-name">{s.name}</div>
            <div className="lk2-tl-fields">{s.findings.length} field(s){s.severity === "critical" ? " · includes critical data" : ""}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// a value with a per-item reveal toggle for sensitive data (the owner's own, but not for
// a shoulder to read); non-sensitive values show in clear.
function Value({ f, tag, showSource }: { f: Finding; tag?: string; showSource?: boolean }) {
  return (
    <div className="lk2-val">
      {tag && <span className="lk2-val-tag">{tag}</span>}
      <RowValue f={f} />
      {showSource && <span className="lk2-src-chip">{f.source}</span>}
    </div>
  );
}

function RowValue({ f }: { f: Finding }) {
  const sensitive = SENSITIVE.has(f.category);
  const [shown, setShown] = useState(!sensitive);
  if (f.masked) return <code className="masked">{f.value}</code>;
  if (!sensitive) return <code>{f.value}</code>;
  return (
    <button className={"lk2-reveal-btn" + (shown ? " shown" : "")} onClick={() => setShown((s) => !s)}
      title={shown ? "hide" : "reveal"}>
      <code>{shown ? f.value : "•".repeat(Math.min(14, Math.max(6, f.value.length)))}</code>
      <span>{shown ? "hide" : "reveal"}</span>
    </button>
  );
}

// ---- plans (business layer — kept light; detailed pricing comes later) ----------------

const PLANS = [
  {
    name: "Pay as you go",
    price: "per search",
    blurb: "One selector, the full report. The price is quoted before each search, and a query the index refuses is refunded.",
    lines: ["Email, phone, handle or name", "Consolidated subject + every source", "PDF report"],
  },
  {
    name: "Analyst",
    price: "monthly",
    blurb: "A balance that renews, and deeper searches — the depth limit is what decides how much of the index a query actually reaches.",
    lines: ["Everything in pay as you go", "Higher search depth", "Full query history and audit export"],
    featured: true,
  },
  {
    name: "Team",
    price: "talk to us",
    blurb: "A shared balance across analysts, with every search attributable to the person who ran it.",
    lines: ["Shared credit pool", "Per-analyst audit trail", "API access"],
  },
];

function Plans({ authed }: { authed: boolean }) {
  return (
    <section className="lk2-plans" id="plans">
      <h2>Plans</h2>
      <p className="lk2-plans-sub">Every search costs real money upstream, so a plan is a balance of credits you spend as you search. A wider query and a deeper one both cost more, and both are priced before you run them.</p>
      <div className="lk2-plan-grid">
        {PLANS.map((p) => (
          <div className={"lk2-plan" + (p.featured ? " featured" : "")} key={p.name}>
            <h3>{p.name}</h3>
            <div className="lk2-price">{p.price}</div>
            <p>{p.blurb}</p>
            <ul>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            <Link className="lk2-plan-cta" href={authed ? "/search" : "/signin?mode=register"}>{authed ? "Run a search" : "Create an account"}</Link>
          </div>
        ))}
      </div>
      <p className="lk2-plans-fine">Credits are added by your deployment&rsquo;s administrator until self-serve billing is connected. A deployment with no database runs unmetered and unlogged — fine for one operator, never for anything public.</p>
    </section>
  );
}

// ---- the subject, consolidated --------------------------------------------------------
// The answer to "who is this", assembled from the rows that are actually about them.
// Every value names the databases that carried it, because a fact from three
// independent dumps and a fact from one are different kinds of fact and the interface
// is the only place a reader can see which they are looking at.

function IdentityPanel({ report }: { report: Report }) {
  const { identity, summary } = report;
  const facets = FACET_ORDER
    .map((f) => [f, identity.facets[f]] as const)
    .filter(([, v]) => v && v.length) as [string, ConsolidatedValue[]][];

  if (!facets.length) {
    return (
      <p className="lk2-clear">
        No identifying field was recovered for {report.subject.raw}
        {report.excluded.total > 0 && ` — the ${report.excluded.total} row${report.excluded.total === 1 ? "" : "s"} returned belonged to someone else`}.
      </p>
    );
  }

  const { corroborated, facets: total, databases } = identity.corroboration;
  return (
    <div className="lk2-ident">
      <div className="lk2-ident-sum">
        <p>{summary}</p>
        {/* Deliberately a count, not a percentage. Nobody calibrated a percentage, and
            a number out of 100 gets read as a probability it has not earned. */}
        <div className="lk2-corr">
          <b>{corroborated}/{total}</b>
          <span>facets confirmed by more than one of the {databases} database{databases === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="lk2-facets">
        {facets.map(([facet, values]) => (
          <div className="lk2-facet" key={facet}>
            <h3>{FACET_LABEL[facet] || facet}</h3>
            {values.map((v, i) => (
              <div className={"lk2-fval" + (v.sources.length >= 2 ? " corroborated" : "")} key={i}>
                <FacetValue facet={facet} v={v} />
                <div className="lk2-fsrc">
                  {v.sources.map((src) => <span key={src}>{src}</span>)}
                </div>
                {v.variants && v.variants.length > 0 && (
                  <div className="lk2-fvar">also written {v.variants.slice(0, 3).map((x) => <code key={x}>{x}</code>)}</div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FacetValue({ facet, v }: { facet: string; v: ConsolidatedValue }) {
  const sensitive = facet === "password" || facet === "document";
  const [shown, setShown] = useState(!sensitive);
  if (v.masked) return <code className="masked">{v.value}</code>;
  if (!sensitive) return <code>{v.value}</code>;
  return (
    <button className={"lk2-reveal-btn" + (shown ? " shown" : "")} onClick={() => setShown((x) => !x)}>
      <code>{shown ? v.value : "•".repeat(Math.min(14, Math.max(6, v.value.length)))}</code>
      <span>{shown ? "hide" : "reveal"}</span>
    </button>
  );
}

// ---- everybody else the query turned up ------------------------------------------------
// The section that keeps a name search honest. These rows matched part of the query and
// belong to other people; folding them into the subject above would produce a detailed,
// confident, wrong answer. They are shown because the operator paid for them.

function Others({ others, subject }: { others: OtherSubject[]; subject: Report["subject"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lk2-others">
      <button className="lk2-others-h" onClick={() => setOpen((o) => !o)}>
        <IconWarn />
        <b>{others.length} other {others.length === 1 ? "person" : "people"} matched part of &ldquo;{subject.raw}&rdquo;</b>
        <span>{open ? "hide" : "show"}</span>
      </button>
      <p className="lk2-others-note">
        These rows matched some of the words searched for, not the subject. They are listed
        separately and are <b>not</b> part of the report above.
      </p>
      {open && (
        <div className="lk2-others-grid">
          {others.map((o) => (
            <div className="lk2-other" key={o.anchor}>
              <div className="lk2-other-h">
                <code>{o.anchor}</code>
                <span className="lk2-count">{o.findings.length}</span>
              </div>
              <div className="lk2-other-m">matched on {o.matched.map((w) => <em key={w}>{w}</em>)}</div>
              <div className="lk2-rows">
                {o.findings.slice(0, 8).map((f, j) => (
                  <div className="lk2-row" key={j}><span className="lk2-row-k">{f.label}</span><RowValue f={f} /></div>
                ))}
                {o.findings.length > 8 && <div className="lk2-more">+{o.findings.length - 8} more</div>}
              </div>
              <div className="lk2-fsrc">{o.sources.map((s) => <span key={s}>{s}</span>)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
