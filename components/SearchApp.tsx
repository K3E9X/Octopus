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
import { FACET_ORDER, FACET_LABEL } from "@/lib/identity";
import { VIEWS, type ViewId } from "@/lib/views";

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
interface PasswordHabit { stem: string; values: string[] }
interface RecordGroup { database: string; info: string; rows: Record<string, string>[]; attribution: string[] }
interface PivotTarget { value: string; kind: "email" | "phone" | "username"; sources: string[] }
interface ServiceTile {
  name: string; dumps: string[]; kind: "social" | "service" | "aggregate";
  firstYear?: number; lastYear?: number; fields: number; severity: Sev;
}

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
  passwordHabits: PasswordHabit[];
  candidates: OtherSubject[];
  records: RecordGroup[];
  pivots: PivotTarget[];
  services: ServiceTile[];
  servicesSummary: string;
}

interface Quote {
  subject: { raw: string; kind: Kind; canonical: string; unique: boolean };
  limit: number;
  metered: boolean;
  exact: { query: string; complexity: number; formatted: string; note?: string };
  permutations: { query: string; complexity: number; formatted: string; note?: string } | null;
}

type Step = "enter" | "basis" | "loading" | "report";
// the list lives in lib/views, so the tabs and the landing cannot disagree about it
type View = ViewId;

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
  // A reference typed once holds for the session: an investigation is several searches
  // and retyping it each time is how half of them end up unfiled.
  const [caseRef, setCaseRef] = useState("");
  useEffect(() => { try { setCaseRef(localStorage.getItem("octopus:case") || ""); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("octopus:case", caseRef); } catch {} }, [caseRef]);
  // matches the route: a multi-word subject searches every word order unless the
  // operator chooses the cheaper exact phrase
  const [permutations, setPermutations] = useState(true);
  const [limit, setLimit] = useState(300);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [headline, setHeadline] = useState("");
  const [view, setView] = useState<View>("identity");
  // Each hop is kept, so an investigation can be walked back rather than only forward.
  const [trail, setTrail] = useState<{ label: string; report: Report; headline: string }[]>([]);
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
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setQuote(d)).catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [subject, limit]);

  const run = useCallback(async () => {
    if (!basis) return;
    setBusy(true); setErr(""); setStep("loading");
    const started = Date.now();
    const res = await fetch("/api/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: subject.trim(), legalBasis: basis, caseRef: caseRef.trim() || undefined, exact: !permutations, limit }),
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })).catch(() => ({ status: 0, data: {} as any }));

    // let the scan animation breathe for a beat so it never flickers
    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - (Date.now() - started))));

    if (res.status === 200 && res.data.report) {
      const rep: Report = res.data.report;
      setReport(rep); setHeadline(res.data.headline || "");
      setView(rep.verdict === "clear" ? (rep.others.length ? "category" : "identity") : "identity");
      setStep("report"); setBusy(false);
      setTrail([{ label: rep.subject.raw, report: rep, headline: res.data.headline || "" }]);
      if (typeof res.data.balance === "number") setAccount((a) => (a ? { ...a, balance: res.data.balance } : a));
      return;
    }
    setBusy(false);
    setStep("basis");
    setErr(res.data.error || "The search could not run.");
  }, [subject, basis, caseRef, permutations, limit]);

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
            ? <>{account.metered && typeof account.balance === "number" && <span className="lk2-bal" title="one credit is one standard search">{account.balance.toLocaleString("en-US")} credit{account.balance === 1 ? "" : "s"}</span>}<Link href="/admin">Admin</Link></>
            : <Link className="lk2-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="lk2-main">
        {step === "enter" && (
          <Enter subject={subject} setSubject={setSubject} quote={quote} err={err}
            next={() => { setErr(""); setStep("basis"); }} />
        )}
        {step === "basis" && (
          <Basis {...{ subject, quote, basis, setBasis, caseRef, setCaseRef, permutations, setPermutations, limit, setLimit, run, busy, err, reset }} />
        )}
        {step === "loading" && <Scanning subject={subject} />}
        {step === "report" && report && (
        <ReportView {...{ report, headline, view, setView, reset, trail, caseRef }}
          onHop={(label, rep, head) => {
            setReport(rep); setHeadline(head); setView("identity");
            setTrail((t) => [...t, { label, report: rep, headline: head }]);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onBack={(i) => {
            const hop = trail[i];
            setReport(hop.report); setHeadline(hop.headline); setView("identity");
            setTrail((t) => t.slice(0, i + 1));
          }}
          onBalance={(b) => setAccount((a) => (a ? { ...a, balance: b } : a))}
        />
      )}

        {step === "enter" && account?.authed && <QueryHistory onPick={(v) => setSubject(v)} caseRef={caseRef} />}

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

function Basis({ subject, quote, basis, setBasis, caseRef, setCaseRef, permutations, setPermutations, limit, setLimit, run, busy, err, reset }: any) {
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

      {/* A case reference belongs to any search, not only the two bases that used to
          reveal the field — an investigation groups its work whatever the basis was,
          and a reference typed once should carry across the whole session. */}
      <div className="lk2-box lk2-box-sm">
        <input value={caseRef} onChange={(e) => setCaseRef(e.target.value)}
          placeholder="case reference (optional)" aria-label="case reference" />
      </div>

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

      {/* Depth is not a page size: it decides how far into the dumps the query reaches,
          so it is the dial between "the cheapest answer" and "everything there is". */}
      <div className="lk2-depth lk2-depths">
        {[100, 300, 1000, 10000].map((n) => (
          <button key={n} className={limit === n ? "on" : ""} onClick={() => setLimit(n)}>
            <b>{n.toLocaleString("en-US")}</b>
            <em>{n === 100 ? "cheapest" : n === 300 ? "default" : n === 1000 ? "deeper" : "everything"}</em>
          </button>
        ))}
      </div>

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

function ReportView({ report, headline, view, setView, reset, trail, onHop, onBack, onBalance, caseRef }: {
  report: Report; headline: string; view: View; setView: (v: View) => void; reset: () => void; caseRef?: string;
  trail: { label: string; report: Report; headline: string }[];
  onHop: (label: string, r: Report, h: string) => void;
  onBack: (i: number) => void;
  onBalance: (b: number) => void;
}) {
  const hasHi = report.highlights.financial.length > 0 || report.highlights.passwords.length > 0;
  return (
    <section className="lk2-report">
      {trail.length > 1 && (
        <nav className="lk2-trail" aria-label="pivot trail">
          {trail.map((h, i) => (
            <button key={i} onClick={() => onBack(i)} className={i === trail.length - 1 ? "on" : ""}>
              {h.label}
            </button>
          ))}
        </nav>
      )}

      <Verdict report={report} headline={headline} />

      {hasHi && <Critical hi={report.highlights} />}

      {report.passwordHabits?.length > 0 && <Habits habits={report.passwordHabits} />}

      <div className="lk2-tabs">
        {VIEWS.map((v) => {
          // the count beside a label, where there is one worth showing
          const n =
            v.id === "services" ? report.services?.length ?? 0 :
            v.id === "category" ? report.categories.length :
            v.id === "source" ? report.breachCount :
            v.id === "records" ? report.records?.reduce((t, g) => t + g.rows.length, 0) ?? 0 :
            null;
          const empty =
            (v.id === "timeline" && report.timeline.length === 0) ||
            (v.id === "orbit" && report.verdict === "clear") ||
            (v.id === "records" && !report.records?.length);
          return (
            <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}
              disabled={empty} title={v.blurb}>
              {v.label}{n !== null ? ` · ${n}` : ""}
            </button>
          );
        })}
      </div>

      <div className={"lk2-view" + (view === "identity" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">Subject</h4>
        <IdentityPanel report={report} />
      </div>
      <div className={"lk2-view" + (view === "services" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">Services</h4>
        <Services tiles={report.services || []} summary={report.servicesSummary} />
      </div>

      {view === "orbit" && <LeakOrbit report={{ subject: report.subject.raw, sources: report.sources, breachCount: report.breachCount, dataPoints: report.dataPoints }} />}

      {/* Every view stays mounted; only the open one shows on screen. Print reveals them
          all, so the PDF is the whole report whichever tab happened to be open. */}
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
      <div className={"lk2-view" + (view === "records" ? "" : " lk2-off")}>
        <h4 className="lk2-print-h">Records</h4>
        <Records groups={report.records || []} />
      </div>

      {report.candidates?.length > 0 && <Candidates groups={report.candidates} subject={report.subject} />}

      {report.others.length > 0 && <Others others={report.others} subject={report.subject} />}

      {report.verdict === "clear" && (
        <p className="lk2-clear">Nothing surfaced at this search depth. A deeper search covers more of the index — raise the limit on a paid plan to widen it.</p>
      )}

      {report.pivots?.length > 0 && <Pivot targets={report.pivots} onHop={onHop} onBalance={onBalance} caseRef={caseRef} />}

      <div className="lk2-actions">
        <button className="lk2-print" onClick={() => window.print()}>Print / PDF</button>
        <Export report={report} />
        <button className="lk2-again" onClick={reset}>Search something else</button>
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
      {/* No silent cap. It used to stop at 40 and print "+N more" with no way to see
          them — a tool that tells you it is withholding something, and then withholds
          it. Past forty it collapses, and the control opens the rest. */}
      <CategoryValues findings={c.findings} />
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
      <p className="lk2-plans-sub"><b>One credit is one search.</b> A plain address at the default depth costs one; a multi-word name costs more because it genuinely is more work upstream, and so does a deeper sweep. Whatever it comes to, you see the figure before you spend it.</p>
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
                {o.findings.map((f, j) => (
                  <div className="lk2-row" key={j}><span className="lk2-row-k">{f.label}</span><RowValue f={f} /></div>
                ))}
              </div>
              <div className="lk2-fsrc">{o.sources.map((s) => <span key={s}>{s}</span>)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- password habits -------------------------------------------------------------
//
// A list of leaked passwords tells someone their passwords leaked. Noticing that three
// of them are one stem with a rotating year tells them something they did not know and
// can act on: rotating again changes nothing, because the next one is guessable from
// the last. It is string structure, not a judgement, so it is stated without a hedge.

function Habits({ habits }: { habits: PasswordHabit[] }) {
  const [shown, setShown] = useState(false);
  const n = habits.reduce((t, h) => t + h.values.length, 0);
  return (
    <div className="lk2-habit">
      <div className="lk2-habit-h">
        <b>{n} of these passwords are the same habit</b>
        <button onClick={() => setShown((x) => !x)}>{shown ? "hide" : "reveal"}</button>
      </div>
      <p>
        They share a stem and differ only in what follows it. Changing the newest one to
        the next variation leaves the account guessable from the old leak — the stem is
        what has to change.
      </p>
      {habits.map((h) => (
        <div className="lk2-habit-row" key={h.stem}>
          {h.values.map((v) => (
            <code key={v}>{shown ? v : "•".repeat(Math.min(14, Math.max(6, v.length)))}</code>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---- the rows, exactly as they came back ------------------------------------------
//
// Everything above this classifies, ranks and deduplicates, and all three involve a
// judgement that can be wrong. This is the row as the source returned it, with the
// dump's own column names and nothing removed — including the fields the categories
// drop as account metadata and the ones this code has never heard of. An analyst who
// thinks something was mis-filed reads here instead of taking the classification's
// word for it.

function Records({ groups }: { groups: RecordGroup[] }) {
  if (!groups.length) return <p className="lk2-clear">No record to show.</p>;
  return (
    <div className="lk2-recs">
      {groups.map((g) => (
        <div className="lk2-rec" key={g.database}>
          <div className="lk2-rec-h">
            <h3>{g.database}</h3>
            <span className="lk2-count">{g.rows.length} row{g.rows.length === 1 ? "" : "s"}</span>
          </div>
          {g.info && <p className="lk2-src-info">{g.info}</p>}
          {g.rows.map((row, i) => (
            <div className="lk2-rec-row" key={i}>
              {g.attribution[i] !== "direct" && (
                <span className="lk2-rec-tag">matched part of the query only — may be someone else</span>
              )}
              {Object.entries(row).map(([k, v]) => (
                <div className="lk2-row" key={k}>
                  <span className="lk2-row-k">{k}</span>
                  <code>{String(v)}</code>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---- candidate records -------------------------------------------------------------
//
// What a name search actually returns. Every one of these matched the whole selector;
// they are grouped by the identifier that holds them together and shown open, because
// they ARE the answer. Grouped, not merged: two groups may still be one person under
// two addresses, and nothing here knows which.

function Candidates({ groups, subject }: { groups: OtherSubject[]; subject: Report["subject"] }) {
  return (
    <div className="lk2-cands">
      <div className="lk2-cands-h">
        <b>{groups.length} candidate record{groups.length === 1 ? "" : "s"} for &ldquo;{subject.raw}&rdquo;</b>
      </div>
      <p className="lk2-others-note">
        A {KIND_LABEL[subject.kind]} does not identify one person, so these are kept apart
        rather than merged into a single profile. Two of them may still be the same
        person under two addresses — that call is yours, not the tool&rsquo;s.
      </p>
      <div className="lk2-others-grid">
        {groups.map((o) => (
          <div className="lk2-other" key={o.anchor}>
            <div className="lk2-other-h">
              <code>{o.anchor}</code>
              <span className="lk2-count">{o.findings.length}</span>
            </div>
            <div className="lk2-rows">
              {o.findings.map((f, j) => (
                <div className="lk2-row" key={j}><span className="lk2-row-k">{f.label}</span><RowValue f={f} /></div>
              ))}
            </div>
            <div className="lk2-fsrc">{o.sources.map((s) => <span key={s}>{s}</span>)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every value in a category. Collapses past forty, and says how to see the rest. */
function CategoryValues({ findings }: { findings: Finding[] }) {
  const [all, setAll] = useState(false);
  const cap = 40;
  const shown = all ? findings : findings.slice(0, cap);
  return (
    <div className="lk2-vals">
      {shown.map((f, j) => <Value key={j} f={f} showSource />)}
      {findings.length > cap && (
        <button className="lk2-more lk2-more-btn" onClick={() => setAll((x) => !x)}>
          {all ? "show fewer" : `show the other ${findings.length - cap}`}
        </button>
      )}
    </div>
  );
}

// ---- pivot ---------------------------------------------------------------------------
//
// The step that turns a result into an investigation.
//
// A name search ends with "two candidates who share a name". The addresses and numbers
// inside those candidates are exactly the selectors that DO identify somebody, so
// searching one of them turns the ambiguity into a person. The API takes several
// queries in one request and bills per query either way, so the whole hop is one round
// trip — and the total is shown before any of it is sent, like every other spend here.

function Pivot({ targets, onHop, onBalance, caseRef }: {
  targets: PivotTarget[];
  onHop: (label: string, r: Report, h: string) => void;
  onBalance: (b: number) => void;
  /** the pivot is part of the same investigation, so it files under the same case */
  caseRef?: string;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [quote, setQuote] = useState<{ total: { formatted: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState<{ selector: string; report: Report; headline: string }[]>([]);

  const toggle = (v: string) =>
    setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : p.length >= 8 ? p : [...p, v]));

  // priced as you choose, before anything is spent
  useEffect(() => {
    if (!picked.length) { setQuote(null); return; }
    const qs = picked.map((p) => `pivot=${encodeURIComponent(p)}`).join("&");
    const t = setTimeout(() => {
      fetch(`/api/search?${qs}`).then((r) => (r.ok ? r.json() : null)).then((d) => d && setQuote(d)).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [picked]);

  const run = async () => {
    if (!picked.length || busy) return;
    setBusy(true); setErr("");
    const res = await fetch("/api/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pivots: picked, legalBasis: "investigation", caseRef: caseRef || undefined }),
    }).then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) })).catch(() => ({ ok: false, d: {} as any }));
    setBusy(false);
    if (!res.ok) {
      // When the source answers in a shape this build cannot read, say which keys it
      // used. It is the difference between "it broke" and something actionable.
      setErr(res.d.shape ? `${res.d.error} (keys returned: ${res.d.shape})` : (res.d.error || "The pivot could not run."));
      return;
    }
    setResults(res.d.reports || []);
    if (typeof res.d.balance === "number") onBalance(res.d.balance);
  };

  return (
    <div className="lk2-pivot">
      <div className="lk2-pivot-h">
        <b>Pivot</b>
        <span>{targets.length} identifier{targets.length === 1 ? "" : "s"} found here can be searched in their own right</span>
      </div>
      <p className="lk2-others-note">
        A name identifies nobody; an address or a number does. Searching one of these is
        what turns this into a person — and they go out as a single request, billed per
        selector.
      </p>

      <div className="lk2-pivot-grid">
        {targets.map((t) => (
          <button key={t.kind + t.value} className={"lk2-pivot-t" + (picked.includes(t.value) ? " on" : "")}
            onClick={() => toggle(t.value)}>
            <span className="lk2-pivot-k">{t.kind}</span>
            <code>{t.value}</code>
            {t.sources.length > 1 && <em>{t.sources.length} dumps</em>}
          </button>
        ))}
      </div>

      <div className="lk2-spend">
        <span>pivot on</span><b>{picked.length || "—"}</b>
        <span>for</span><b>{quote?.total.formatted || "—"}</b>
        <button className="lk2-pivot-go" onClick={run} disabled={busy || !picked.length}>
          {busy ? "…" : "Run the pivot"}
        </button>
      </div>
      {err && <p className="lk2-err">{err}</p>}

      {results.length > 0 && (
        <div className="lk2-pivot-res">
          {results.map((r) => (
            <button className="lk2-pivot-card" key={r.selector} onClick={() => onHop(r.selector, r.report, r.headline)}>
              <div className="lk2-pivot-card-h">
                <code>{r.selector}</code>
                <span className={"lk2-sev s-" + r.report.verdict}>{r.report.verdict}</span>
              </div>
              <p>{r.headline}</p>
              <em>open this report →</em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- who holds this person's data ---------------------------------------------------
//
// The grid every product in this category shows — built from the breaches already paid
// for rather than by probing sites, which costs nothing extra and makes a claim that
// can be checked: not "registered at Deezer", which is a guess about today, but "in
// Deezer's 2019 breach", which is a fact about a file somebody already has.
//
// Aggregated credential lists are kept apart from real services. Rendering "Collection
// #1" as a service tile tells somebody they have an account at a company that does not
// exist, and it is the distinction the probing products structurally cannot make.

function Services({ tiles, summary }: { tiles: ServiceTile[]; summary: string }) {
  if (!tiles.length) return <p className="lk2-clear">No source named this subject.</p>;
  const social = tiles.filter((t) => t.kind === "social");
  const services = tiles.filter((t) => t.kind === "service");
  const aggregates = tiles.filter((t) => t.kind === "aggregate");

  const Tile = (t: ServiceTile) => (
    <div className={"lk2-svc s-" + t.severity} key={t.kind + t.name}>
      <div className="lk2-svc-n">{t.name}</div>
      <div className="lk2-svc-m">
        {t.firstYear && <span>{t.firstYear}{t.lastYear && t.lastYear !== t.firstYear ? `–${t.lastYear}` : ""}</span>}
        <span>{t.fields} field{t.fields === 1 ? "" : "s"}</span>
      </div>
      {t.dumps.length > 1 && <div className="lk2-svc-d">{t.dumps.length} files</div>}
    </div>
  );

  return (
    <div className="lk2-svcs">
      <p className="lk2-svc-sum">{summary}</p>

      {social.length > 0 && (
        <>
          <h5>Social networks</h5>
          <div className="lk2-svc-grid">{social.map(Tile)}</div>
        </>
      )}

      {services.length > 0 && (
        <>
          <h5>Other services</h5>
          <div className="lk2-svc-grid">{services.map(Tile)}</div>
        </>
      )}

      {aggregates.length > 0 && (
        <>
          <h5>Aggregated lists</h5>
          <p className="lk2-svc-note">
            Credential files assembled from other breaches, often from sources nobody has
            identified. They are named because that is all anyone can honestly say about
            them — being in one is not an account anywhere.
          </p>
          <div className="lk2-svc-grid">{aggregates.map(Tile)}</div>
        </>
      )}
    </div>
  );
}

// ---- getting it out -----------------------------------------------------------------
//
// A report that can only be read in the tab that produced it is not a deliverable. The
// files are built in the browser from the same object the screen renders — nothing is
// sent anywhere to produce them, which for this product is the point.

function Export({ report }: { report: Report }) {
  const [busy, setBusy] = useState(false);

  const save = async (kind: "csv" | "csv-raw" | "json") => {
    if (busy) return;
    setBusy(true);
    try {
      // The export lives server-side in lib/export so one implementation serves the
      // browser and anything that comes later — a scheduled report, an API client.
      const { toCSV, toJSON, exportName } = await import("@/lib/export");
      const r = report as any;
      const text = kind === "json" ? toJSON(r) : toCSV(r, { records: kind === "csv-raw" });
      const ext = kind === "json" ? "json" : "csv";
      const blob = new Blob([text], { type: kind === "json" ? "application/json" : "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportName(r, ext);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // revoked on the next tick: Safari needs the URL to still resolve when it fires
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="lk2-exports">
      <button className="lk2-again" onClick={() => save("csv")} disabled={busy}>CSV</button>
      <button className="lk2-again" onClick={() => save("csv-raw")} disabled={busy}
        title="every row as the source returned it, with the dump's own column names">CSV + raw rows</button>
      <button className="lk2-again" onClick={() => save("json")} disabled={busy}>JSON</button>
    </span>
  );
}

// ---- what you have already searched -------------------------------------------------
//
// The sign-in page has promised this since before it existed: "your balance and your
// query history are where you left them". There was no way to read either.
//
// It is NOT the audit trail with a friendlier face. That is oversight — every operator,
// the whole deployment, administrator-only. This answers the operator's own question:
// what did I search, and under which case. The server filters on the session's identity,
// never on anything the page sends.
//
// Clicking an entry FILLS THE FIELD rather than running it. A past search is a thing
// you want to look at again, and re-running it silently would spend credits on a click
// that looked like navigation.

interface HistoryEntry { at: number; selector: string; legalBasis: string; caseId?: string; kind: string }
interface CaseRow { caseId: string; searches: number; last: number }

function QueryHistory({ onPick, caseRef }: { onPick: (v: string) => void; caseRef?: string }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const q = filter ? `?case=${encodeURIComponent(filter)}` : "";
    fetch(`/api/history${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setEntries(d.entries || []);
        setCases(d.cases || []);
        setNote(d.configured ? "" : d.note || "");
      })
      .catch(() => {});
  }, [filter]);

  if (note) return <section className="lk2-hist"><p className="lk2-hist-note">{note}</p></section>;
  if (!entries.length && !cases.length) return null;

  const when = (t: number) => {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(t).toLocaleDateString();
  };

  return (
    <section className="lk2-hist">
      <div className="lk2-hist-h">
        <b>Your searches</b>
        {caseRef && <span className="lk2-hist-case">filing under {caseRef}</span>}
      </div>

      {cases.length > 0 && (
        <div className="lk2-hist-cases">
          <button className={filter ? "" : "on"} onClick={() => setFilter("")}>all</button>
          {cases.map((c) => (
            <button key={c.caseId} className={filter === c.caseId ? "on" : ""} onClick={() => setFilter(c.caseId)}>
              {c.caseId} <em>{c.searches}</em>
            </button>
          ))}
        </div>
      )}

      <div className="lk2-hist-rows">
        {entries.map((e, i) => (
          <button className="lk2-hist-row" key={i} onClick={() => onPick(e.selector)}
            title="put this back in the search field — it is not re-run, and nothing is charged">
            <code>{e.selector}</code>
            <span className="lk2-hist-basis">{e.legalBasis}</span>
            {e.caseId && <span className="lk2-hist-tag">{e.caseId}</span>}
            <span className="lk2-hist-when">{when(e.at)}</span>
          </button>
        ))}
        {!entries.length && <p className="lk2-hist-note">Nothing filed under {filter} yet.</p>}
      </div>
    </section>
  );
}
