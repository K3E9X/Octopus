"use client";

// Octopus Leak — the self-exposure product.
//
// One question, asked calmly: what has leaked about YOU? A person enters an email or
// phone they own, proves it is theirs, and gets the full picture back — every field the
// breach held, grouped three ways (what it is, where it leaked, when), with the critical
// things (passwords, bank details) pulled to the top and a next step on each.
//
// Nothing is shown before the proof passes. The input is always a verifiable identifier;
// the name, pseudonym, address and the rest come back IN the report, never as the search
// key — that is the line between "check yourself" and "look someone up".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { OctoMark } from "./OctoMark";

// the constellation view is SVG-heavy and only needed once a report exists
const LeakOrbit = dynamic(() => import("./LeakOrbit"), { ssr: false });

type Sev = "critical" | "high" | "medium" | "low";
interface Finding { category: string; severity: Sev; label: string; value: string; source: string; masked?: boolean }
interface CatReport { category: string; label: string; severity: Sev; meaning: string; action: string; findings: Finding[]; distinct: number }
interface SrcReport { name: string; info: string; date?: string; sortDate: number; findings: Finding[]; severity: Sev }
interface TLEntry { name: string; date: string; sortDate: number }
interface Report {
  subject: string;
  verdict: "clear" | "exposed" | "critical";
  dataPoints: number;
  breachCount: number;
  categories: CatReport[];
  sources: SrcReport[];
  timeline: TLEntry[];
  highlights: { financial: Finding[]; passwords: Finding[] };
}

type Step = "enter" | "verify" | "loading" | "report";
type View = "orbit" | "category" | "source" | "timeline";

const SEV_LABEL: Record<Sev, string> = { critical: "critical", high: "high", medium: "notable", low: "minor" };
const SENSITIVE = new Set(["password", "financial", "document"]);

// Inline icons — a consistent 1.5px stroke set, never emoji.
const IconWarn = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
);
const IconShield = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" />
  </svg>
);

export default function CheckApp() {
  const [step, setStep] = useState<Step>("enter");
  const [subject, setSubject] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [headline, setHeadline] = useState("");
  const [view, setView] = useState<View>("category");
  const [account, setAccount] = useState<{ authed: boolean; email?: string; balance?: number; metered: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth").then((r) => r.json()).then((d) =>
      setAccount({ authed: !!d.me, email: d.me?.email, balance: d.balance, metered: !!d.metered })).catch(() => {});
  }, []);

  const post = useCallback((bodyObj: Record<string, unknown>) =>
    fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) })
      .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })), []);

  const runCheck = useCallback(async () => {
    setErr(""); setMsg(""); setStep("loading");
    const started = Date.now();
    const { status, data } = await post({ action: "check", subject });
    // let the scan animation breathe for a beat so it never flickers
    const wait = Math.max(0, 1100 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
    if (status === 200 && data.report) {
      setReport(data.report); setHeadline(data.headline || "");
      setView(data.report.verdict === "clear" ? "category" : "orbit"); setStep("report");
      if (typeof data.balance === "number") setAccount((a) => (a ? { ...a, balance: data.balance } : a));
      return;
    }
    if (status === 403 && data.needsVerify) { setStep("enter"); setErr("Verify this identifier first."); return; }
    setStep("enter");
    setErr(data.error || "The check could not run.");
  }, [post, subject]);

  const begin = useCallback(async () => {
    const s = subject.trim();
    if (!s || busy) return;
    setBusy(true); setErr(""); setMsg("");
    const { status, data } = await post({ action: "verify-start", subject: s });
    setBusy(false);
    if (status === 401) { setErr("Sign in to check your exposure."); return; }
    if (data.status === "verified") { runCheck(); return; }
    if (data.status === "code-sent") { setStep("verify"); setMsg(data.message); return; }
    setErr(data.message || "Could not start verification.");
  }, [subject, busy, post, runCheck]);

  const confirm = useCallback(async () => {
    if (!code.trim() || busy) return;
    setBusy(true); setErr(""); setMsg("");
    const { status, data } = await post({ action: "verify-confirm", subject, code: code.trim() });
    setBusy(false);
    if (status === 200 && data.ok) { runCheck(); return; }
    setErr(data.message || "That code is not right.");
  }, [code, busy, post, subject, runCheck]);

  function reset() { setStep("enter"); setReport(null); setCode(""); setErr(""); setMsg(""); }

  return (
    <div className="lk2">
      <header className="lk2-top">
        <Link className="lk2-brand" href="/"><OctoMark size={30} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
        <nav>
          <a href="#plans">Plans</a>
          {account?.authed
            ? <>{account.metered && typeof account.balance === "number" && <span className="lk2-bal">{account.balance.toLocaleString("en-US")} cr</span>}<Link href="/app">Console</Link></>
            : <Link className="lk2-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="lk2-main">
        {step === "enter" && <Enter {...{ subject, setSubject, begin, busy, err }} />}
        {step === "verify" && <Verify {...{ subject, code, setCode, confirm, busy, err, msg, reset }} />}
        {step === "loading" && <Scanning subject={subject} />}
        {step === "report" && report && <ReportView {...{ report, headline, view, setView, reset }} />}

        {step !== "report" && step !== "loading" && <Plans authed={!!account?.authed} />}
      </main>
    </div>
  );
}

// ---- step: enter ----------------------------------------------------------------------

function Enter({ subject, setSubject, begin, busy, err }: any) {
  return (
    <section className="lk2-hero">
      <div className="lk2-eyebrow">breach exposure report</div>
      <h1>What has leaked<br />about <span>you</span>?</h1>
      <p>Enter an email or phone you own. Once you've proven it's yours, we reveal everything in breach data linked to you — your name, address, passwords, even bank details — grouped by what it is, where it leaked, and when.</p>

      <div className="lk2-box">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} spellCheck={false} autoComplete="off"
          placeholder="your email or phone number" onKeyDown={(e) => { if (e.key === "Enter") begin(); }} />
        <button onClick={begin} disabled={busy || !subject.trim()}>{busy ? "…" : "Reveal my exposure"}</button>
      </div>
      {err && <p className="lk2-err">{err}</p>}

      <div className="lk2-reveal">
        <span>what the report uncovers</span>
        <div>
          {["Passwords", "Bank details · RIB / IBAN", "Full name & DOB", "Home address", "Email", "Phone", "Usernames", "Employer", "ID documents"]
            .map((t, i) => <em key={t} style={{ ["--i" as any]: i }}>{t}</em>)}
        </div>
      </div>

      <p className="lk2-fine">You enter an email or phone so we can prove it is <b>yours</b> — your name, pseudonym and the rest then surface <b>in the report</b>. You can only check an identifier you control, never look someone else up.</p>
    </section>
  );
}

// ---- step: verify ---------------------------------------------------------------------

function Verify({ subject, code, setCode, confirm, busy, err, msg, reset }: any) {
  return (
    <section className="lk2-verify">
      <div className="lk2-ico"><IconShield /></div>
      <h2>Prove it is yours</h2>
      <p>{msg || `We sent a code to ${subject}.`}</p>
      <div className="lk2-box lk2-box-sm">
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric"
          placeholder="6-digit code" onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} autoFocus />
        <button onClick={confirm} disabled={busy || code.length < 6}>{busy ? "…" : "Confirm"}</button>
      </div>
      {err && <p className="lk2-err">{err}</p>}
      <button className="lk2-link" onClick={reset}>use a different identifier</button>
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
        {([["orbit", "Orbit"], ["category", `By type · ${report.categories.length}`], ["source", `By breach · ${report.breachCount}`], ["timeline", "Timeline"]] as [View, string][])
          .map(([v, lbl]) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}
              disabled={(v === "timeline" && report.timeline.length === 0) || (v === "orbit" && report.verdict === "clear")}>{lbl}</button>
          ))}
      </div>

      {view === "orbit" && <LeakOrbit report={report} />}

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

function CountUp({ n }: { n: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (n <= 0) { setV(0); return; }
    let raf = 0; const t0 = performance.now(); const dur = 700;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setV(Math.round((1 - Math.pow(1 - p, 3)) * n));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return <>{v.toLocaleString("en-US")}</>;
}

function Verdict({ report, headline }: { report: Report; headline: string }) {
  const tag = report.verdict === "clear" ? "clear" : report.verdict === "critical" ? "critical exposure" : "exposed";
  return (
    <div className={"lk2-verdict v-" + report.verdict}>
      <div className="lk2-vring"><span className="lk2-vtag">{tag}</span></div>
      <h2>{report.subject}</h2>
      <p>{headline}</p>
      {report.verdict !== "clear" && (
        <div className="lk2-vstats">
          <div><b><CountUp n={report.dataPoints} /></b><span>data points</span></div>
          <div><b><CountUp n={report.breachCount} /></b><span>breaches</span></div>
          <div><b><CountUp n={report.categories.length} /></b><span>categories</span></div>
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
  { name: "Single check", price: "pay per search", blurb: "One identifier, the full report. Pay only for what you look up.", lines: ["Your email or phone", "Every field, grouped & dated", "PDF report"] },
  { name: "Watch", price: "monthly", blurb: "Re-check regularly and see what is new since last time.", lines: ["Everything in Single check", "Deeper search depth", "More identifiers"], featured: true },
  { name: "Business", price: "talk to us", blurb: "Check a team's addresses with a shared balance.", lines: ["Shared credit pool", "Admin top-ups & ledger", "Priority depth"] },
];

function Plans({ authed }: { authed: boolean }) {
  return (
    <section className="lk2-plans" id="plans">
      <h2>Plans</h2>
      <p className="lk2-plans-sub">Every search has a real cost, so a plan is a balance of credits you spend as you check. A deeper search of the index costs more.</p>
      <div className="lk2-plan-grid">
        {PLANS.map((p) => (
          <div className={"lk2-plan" + (p.featured ? " featured" : "")} key={p.name}>
            <h3>{p.name}</h3>
            <div className="lk2-price">{p.price}</div>
            <p>{p.blurb}</p>
            <ul>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            <Link className="lk2-plan-cta" href={authed ? "/app" : "/signin?mode=register"}>{authed ? "Open the console" : "Create an account"}</Link>
          </div>
        ))}
      </div>
      <p className="lk2-plans-fine">Credits are added by your deployment's administrator until self-serve billing is connected.</p>
    </section>
  );
}
