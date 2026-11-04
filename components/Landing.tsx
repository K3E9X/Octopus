"use client";

// The front door for Octopus Leak.
//
// Not the old OSINT-engine pitch (collectors across the open web, seed any selector) —
// that marketed a different, investigator-facing tool. This is the consumer product's
// landing: one promise, "see what has leaked about you", and a single path to it at
// /check. Built in the same design system as the product so the two read as one thing.

import Link from "next/link";
import { OctoMark } from "./OctoMark";

const UNCOVERS = [
  "Passwords", "Bank details · RIB / IBAN", "Full name & DOB", "Home address",
  "Email", "Phone", "Usernames", "Employer", "ID documents",
];

const STEPS = [
  { n: "01", t: "Enter your email or phone", d: "The identifier you want to check — and nothing else. There is no name to look anyone up by." },
  { n: "02", t: "Prove it is yours", d: "Your account email is already proof; any other address or number gets a one-time code. Only the owner of that inbox gets in." },
  { n: "03", t: "See the full report", d: "Everything breach data holds about you, grouped by what it is, where it leaked and when — with the one thing to do about each." },
];

const VIEWS = [
  { t: "By type", d: "Every field ranked worst-first — passwords and bank details at the top, each with what it means and what to do." },
  { t: "By breach", d: "Which leak exposed what, with that breach's own description and date." },
  { t: "Timeline", d: "When each compromise happened, oldest to newest." },
  { t: "Orbit", d: "A constellation of your exposure, with a drawn link wherever one value ties two breaches together." },
];

export default function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="lk2 lk2-home">
      <header className="lk2-top">
        <Link className="lk2-brand" href="/"><OctoMark size={30} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
        <nav>
          <a href="#how">How it works</a>
          <Link href="/check#plans">Plans</Link>
          {signedIn ? <Link href="/app">Console</Link> : <Link className="lk2-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="lk2-main">
        <section className="lk2-hero">
          <div className="lk2-eyebrow">breach exposure report</div>
          <h1>What has leaked<br />about <span>you</span>?</h1>
          <p>Enter an email or phone you own, prove it's yours, and see everything in breach data that's tied to you — your name, address, passwords, even bank details — with a clear step to take on each.</p>
          <Link className="lk2-hero-cta" href="/check">Check your exposure →</Link>

          <div className="lk2-reveal">
            <span>what the report uncovers</span>
            <div>{UNCOVERS.map((t, i) => <em key={t} style={{ ["--i" as any]: i }}>{t}</em>)}</div>
          </div>
        </section>

        <section className="lk2-lp-sec" id="how">
          <h2>Three steps. The middle one is the point.</h2>
          <div className="lk2-steps">
            {STEPS.map((s) => (
              <div className="lk2-step" key={s.n}>
                <div className="lk2-step-n">{s.n}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lk2-lp-sec">
          <h2>Four ways to read the same facts.</h2>
          <div className="lk2-views">
            {VIEWS.map((v) => (
              <div className="lk2-vcard" key={v.t}><h3>{v.t}</h3><p>{v.d}</p></div>
            ))}
          </div>
        </section>

        <section className="lk2-lp-trust">
          <h2>Only you, only your data.</h2>
          <p>You can only ever run a check on an identifier you have proven you control. There is no search by name, and no way to look up anyone else — the proof of ownership is the whole point, and the reason this is a report you can trust rather than a tool for someone to misuse.</p>
          <Link className="lk2-hero-cta" href="/check">Check your exposure →</Link>
        </section>

        <footer className="lk2-foot">
          <Link className="lk2-brand" href="/"><OctoMark size={26} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
          <span className="lk2-foot-note">A breach-exposure report for the one person it's about.</span>
        </footer>
      </main>
    </div>
  );
}
