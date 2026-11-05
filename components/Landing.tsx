"use client";

// The front door.
//
// One promise, one path to it: give it a selector, get back what breach data holds.
// The page sells the thing the product is actually better at than a lookup list —
// consolidating scattered rows into one subject with the source of every fact — and it
// states the limit in the same breath, because the limit is the reason to trust it.

import Link from "next/link";
import { OctoMark } from "./OctoMark";
import Sift from "./Sift";
import type { SearchReport } from "@/lib/report";
import Demo from "./Demo";
import dynamic from "next/dynamic";

// Decoration behind real markup: it never gates content, so it is loaded after it.
const DeepField = dynamic(() => import("./DeepField"), { ssr: false });

const UNCOVERS = [
  "Passwords", "Bank details · RIB / IBAN", "Full name & DOB", "Home address",
  "Email", "Phone", "Usernames", "Employer", "ID documents",
];

const STEPS = [
  {
    n: "01",
    t: "Enter a selector",
    d: "Email, phone, handle or name. The price is quoted before you spend it.",
  },
  {
    n: "02",
    t: "Declare why",
    d: "One line, from a closed list, written to a log that cannot be edited without the break showing.",
  },
  {
    n: "03",
    t: "Read the subject",
    d: "Every row genuinely about them, as one person. Anyone who merely shared part of the query is kept separate.",
  },
];

/**
 * What the tool does that a lookup list does not.
 *
 * These four shipped without a word on the page that sells them: a visitor had to buy a
 * search to find out they existed. They are the second thing on the page now, above how
 * it works and above the views, because a capability nobody can see is one nobody is
 * paying for.
 *
 * Each carries a KICKER — the claim in six words — because a reader scanning a grid of
 * equal-weight paragraphs reads none of them.
 */
const DOES = [
  {
    t: "Pivot",
    k: "Turn an ambiguous name into a person",
    d: "A name identifies nobody; the addresses and numbers inside its results do. One click searches them, several at once, priced before it runs.",
  },
  {
    t: "Cases and history",
    k: "Every hop filed under one reference",
    d: "File a search under a case and each pivot files with it. Your queries are yours to re-read; nobody else’s are, whatever their role.",
  },
  {
    t: "Export",
    k: "CSV, raw CSV and JSON that carries the query",
    d: "One line per fact, a raw variant with every column the dump returned, and JSON that keeps the question it answers.",
  },
  {
    t: "Password habits",
    k: "The pattern across leaks, not the passwords in one",
    d: "Three passwords that are one stem with a rotating year: changing the newest leaves the account guessable from the oldest.",
  },
];

export default function Landing({ signedIn, demo }: { signedIn: boolean; demo: SearchReport }) {
  return (
    <div className="lk2 lk2-home">
      <header className="lk2-top">
        <Link className="lk2-brand" href="/"><OctoMark size={30} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
        <nav>
          <a href="#demo">See a report</a>
          <a href="#what">Features</a>
          <a href="#how">How it works</a>
          <Link href="/search#plans">Plans</Link>
          {signedIn ? <Link href="/search">Search</Link> : <Link className="lk2-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="lk2-main">
        <section className="lk2-hero lk2-hero-deep">
          {/* The mass you cannot see into, and the few things a search pulls out of it.
              The background says what the page says. */}
          <DeepField className="lk2-hero-field" anchor={{ x: -0.015, y: 0.5 }} reachScale={1.05} />
          <div className="lk2-eyebrow">breach data lookup</div>
          <h1>What has leaked<br />about <span>this person</span>?</h1>
          <p>Search an email, a phone, a handle or a name. Get back the rows assembled into one person — with the database behind every fact.</p>
          <Link className="lk2-hero-cta" href="/search">Run a search →</Link>

          <div className="lk2-reveal">
            <span>what a report uncovers</span>
            <div>{UNCOVERS.map((t, i) => <em key={t} style={{ ["--i" as any]: i }}>{t}</em>)}</div>
          </div>
        </section>

        <section className="lk2-lp-sec lk2-demo-sec" id="demo">
          <h2>This is the report.</h2>
          <p className="lk2-sec-lead">Not a screenshot of one. Five invented dumps, run through the same code a paid search runs.</p>
          <Demo report={demo} />
        </section>

        <section className="lk2-lp-sec lk2-feats" id="what">
          <h2>Four things a list of hits cannot do.</h2>
          <p className="lk2-sec-lead">Finding the rows is the part everyone can do. What happens next is the product.</p>
          <div className="lk2-feat-grid">
            {DOES.map((d, i) => (
              <article className="lk2-feat" key={d.t}>
                <span className="lk2-feat-n">{String(i + 1).padStart(2, "0")}</span>
                <h3>{d.t}</h3>
                <p className="lk2-feat-k">{d.k}</p>
                <p>{d.d}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lk2-lp-sec" id="how">
          <h2>Three steps. The last one is the point.</h2>
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

        <section className="lk2-lp-trust">
          <h2>A result set is not a report.</h2>
          {/* The argument, drawn — because this one only lands once you see it happen. */}
          <Sift />
          <p>
            The index searches every word order, so a query comes back with rows that matched
            <em> something</em> — not rows about the person you asked for. Everything here is
            checked against the selector first: an address in every spelling a dump holds it
            in, a number matched past its country code, and anyone who merely shares a surname
            listed on their own rather than folded in.
          </p>
          <Link className="lk2-hero-cta" href="/search">Run a search →</Link>
        </section>

        <footer className="lk2-foot">
          <Link className="lk2-brand" href="/"><OctoMark size={26} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
          <span className="lk2-foot-note">One source. Every fact traceable to the dump it came from.</span>
        </footer>
      </main>
    </div>
  );
}
