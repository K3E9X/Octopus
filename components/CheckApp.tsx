"use client";

// The self-check product — a radically different, consumer-facing surface.
//
// Not the investigator cockpit. One question, asked calmly: what has leaked about YOU?
// A person enters their own email or phone, proves it is theirs, and gets a plain report
// — what leaked, how much it should worry them, and the one thing to do about each.
//
// The flow is three steps and the middle one is the point: enter → prove it's yours →
// see it. Nothing is shown before the proof passes.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { OctoMark } from "./OctoMark";

type Sev = "critical" | "high" | "medium" | "low";
interface Finding { category: string; severity: Sev; value: string; source: string; masked?: boolean }
interface Cat { category: string; label: string; severity: Sev; meaning: string; action: string; findings: Finding[]; distinct: number }
interface Report { subject: string; verdict: "clear" | "exposed" | "critical"; breaches: { name: string; info: string }[]; categories: Cat[]; dataPoints: number }

type Step = "enter" | "verify" | "report";

const SEV_LABEL: Record<Sev, string> = { critical: "critical", high: "high", medium: "notable", low: "minor" };

export default function CheckApp() {
  const [step, setStep] = useState<Step>("enter");
  const [subject, setSubject] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [headline, setHeadline] = useState("");
  const [account, setAccount] = useState<{ authed: boolean; email?: string; balance?: number; metered: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth").then((r) => r.json()).then((d) =>
      setAccount({ authed: !!d.me, email: d.me?.email, balance: d.balance, metered: !!d.metered })).catch(() => {});
  }, []);

  const post = useCallback((bodyObj: Record<string, unknown>) =>
    fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) })
      .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })), []);

  const runCheck = useCallback(async () => {
    setBusy(true); setErr(""); setMsg("");
    const { status, data } = await post({ action: "check", subject });
    setBusy(false);
    if (status === 200 && data.report) { setReport(data.report); setHeadline(data.headline || ""); setStep("report");
      if (typeof data.balance === "number") setAccount((a) => (a ? { ...a, balance: data.balance } : a)); return; }
    if (status === 403 && data.needsVerify) { setStep("enter"); setErr("Verify this identifier first."); return; }
    setErr(data.error || "The check could not run.");
  }, [post, subject]);

  const begin = useCallback(async () => {
    const s = subject.trim();
    if (!s || busy) return;
    setBusy(true); setErr(""); setMsg("");
    const { status, data } = await post({ action: "verify-start", subject: s });
    setBusy(false);
    if (status === 401) { setErr("Sign in to check your exposure."); return; }
    if (data.status === "verified") { runCheck(); return; }        // account email — straight through
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
    <div className="chk">
      <header className="chk-top">
        <Link className="chk-brand" href="/"><OctoMark size={30} /><span><b>OCTOPUS</b><small>CHECK</small></span></Link>
        <nav>
          <a href="#plans">Plans</a>
          {account?.authed
            ? <>{account.metered && typeof account.balance === "number" && <span className="chk-bal">{account.balance.toLocaleString("en-US")} cr</span>}<Link href="/app">Console</Link></>
            : <Link className="chk-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="chk-main">
        {step === "enter" && (
          <section className="chk-hero">
            <h1>What has leaked<br />about <span>you</span>?</h1>
            <p>Enter your own email or phone. We confirm it is yours, then show you exactly what is exposed in breach data — and what to do about it.</p>

            <div className="chk-box">
              <input
                value={subject} onChange={(e) => setSubject(e.target.value)} spellCheck={false} autoComplete="off"
                placeholder="your email or phone number"
                onKeyDown={(e) => { if (e.key === "Enter") begin(); }}
              />
              <button onClick={begin} disabled={busy || !subject.trim()}>{busy ? "…" : "Check my exposure"}</button>
            </div>
            {err && <p className="chk-err">{err}</p>}
            <p className="chk-fine">Only you can run this, and only for an address or number you can prove you control. We do not look people up by name.</p>
          </section>
        )}

        {step === "verify" && (
          <section className="chk-verify">
            <h2>Prove it is yours</h2>
            <p>{msg || `We sent a code to ${subject}.`}</p>
            <div className="chk-box">
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric" placeholder="6-digit code" onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} />
              <button onClick={confirm} disabled={busy || code.length < 6}>{busy ? "…" : "Confirm"}</button>
            </div>
            {err && <p className="chk-err">{err}</p>}
            <button className="chk-link" onClick={reset}>use a different identifier</button>
          </section>
        )}

        {step === "report" && report && (
          <section className="chk-report">
            <div className={"chk-verdict v-" + report.verdict}>
              <span className="chk-vtag">{report.verdict === "clear" ? "clear" : report.verdict === "critical" ? "critical exposure" : "exposed"}</span>
              <h2>{report.subject}</h2>
              <p>{headline}</p>
            </div>

            {report.breaches.length > 0 && (
              <div className="chk-breaches">
                <span>found in</span>
                {report.breaches.map((b) => <span className="chk-breach" key={b.name} title={b.info}>{b.name}</span>)}
              </div>
            )}

            {report.categories.map((c) => (
              <div className={"chk-cat s-" + c.severity} key={c.category}>
                <div className="chk-cat-h">
                  <span className="chk-sev">{SEV_LABEL[c.severity]}</span>
                  <h3>{c.label}</h3>
                  <span className="chk-count">{c.distinct}</span>
                </div>
                <p className="chk-meaning">{c.meaning}</p>
                <div className="chk-values">
                  {c.findings.slice(0, 20).map((f, i) => (
                    <div className="chk-val" key={i}>
                      <code className={f.masked ? "masked" : ""}>{f.value}</code>
                      <span className="chk-src">{f.source.replace("leakosint · ", "")}</span>
                    </div>
                  ))}
                  {c.findings.length > 20 && <div className="chk-more">+{c.findings.length - 20} more</div>}
                </div>
                <p className="chk-action"><b>Do this:</b> {c.action}</p>
              </div>
            ))}

            {report.verdict === "clear" && (
              <p className="chk-clear-note">Nothing surfaced at this depth. A deeper search covers more of the index — raise the limit on a paid plan to widen it.</p>
            )}

            <button className="chk-again" onClick={reset}>Check another identifier</button>
          </section>
        )}

        <Plans authed={!!account?.authed} />
      </main>
    </div>
  );
}

// ---- plans -----------------------------------------------------------------------------
// Honest about the money: there is no fake checkout. A plan is a bundle of credits, and
// how you get them depends on the deployment — self-serve billing is a provider the
// operator wires in, so until then the page says so instead of pretending to charge.

const PLANS = [
  { name: "Single check", price: "from a few credits", blurb: "One identifier, one report. Pay only for what you search.", lines: ["Your email or phone", "Full categorised report", "Remediation steps"] },
  { name: "Watch", price: "a monthly bundle", blurb: "Re-check regularly and see what is new since last time.", lines: ["Everything in Single check", "Deeper search limit", "More identifiers"], featured: true },
  { name: "Business", price: "talk to us", blurb: "Check a team's addresses, with a shared balance and an admin.", lines: ["Shared credit pool", "Admin top-ups & ledger", "Priority depth"] },
];

function Plans({ authed }: { authed: boolean }) {
  return (
    <section className="chk-plans" id="plans">
      <h2>Plans</h2>
      <p className="chk-plans-sub">Every search has a real cost, so a plan is a balance of credits you spend as you check. Cheaper searches cost less; a deeper search of the index costs more.</p>
      <div className="chk-plan-grid">
        {PLANS.map((p) => (
          <div className={"chk-plan" + (p.featured ? " featured" : "")} key={p.name}>
            <h3>{p.name}</h3>
            <div className="chk-price">{p.price}</div>
            <p>{p.blurb}</p>
            <ul>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {authed ? <Link className="chk-plan-cta" href="/app">Open the console</Link>
                    : <Link className="chk-plan-cta" href="/signin?mode=register">Create an account</Link>}
          </div>
        ))}
      </div>
      <p className="chk-plans-fine">Credits are added by your deployment's administrator. Self-serve billing is a payment provider the operator connects — until then, your admin tops up your balance.</p>
    </section>
  );
}
