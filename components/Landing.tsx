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
    d: "An email address, a phone number, a handle or a name. The price is quoted before you spend it — a name costs more than an address, and you see why.",
  },
  {
    n: "02",
    t: "Declare why",
    d: "One line, from a closed list, written to a log that cannot be edited without the break showing. That record is what makes a search defensible afterwards.",
  },
  {
    n: "03",
    t: "Read the subject",
    d: "Every row that is genuinely about them, consolidated into one person — with the database behind each fact, and anyone who merely shared part of the query kept separate.",
  },
];

const VIEWS = [
  { t: "Subject", d: "The person the rows describe: name, addresses, phones, documents — each value naming the databases that carried it, ranked by how many independently agree." },
  { t: "By type", d: "Every field ranked worst-first — passwords and bank details at the top, each with what it means and what to do about it." },
  { t: "By breach", d: "Which leak exposed what, with that breach's own description and date." },
  { t: "Timeline", d: "When each compromise happened, oldest to newest." },
];

export default function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="lk2 lk2-home">
      <header className="lk2-top">
        <Link className="lk2-brand" href="/"><OctoMark size={30} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
        <nav>
          <a href="#how">How it works</a>
          <Link href="/search#plans">Plans</Link>
          {signedIn ? <Link href="/search">Search</Link> : <Link className="lk2-cta" href="/signin">Sign in</Link>}
        </nav>
      </header>

      <main className="lk2-main">
        <section className="lk2-hero lk2-hero-deep">
          {/* The mass you cannot see into, and the few things a search pulls out of it.
              The background says what the page says. */}
          <DeepField className="lk2-hero-field" />
          <div className="lk2-eyebrow">breach data lookup</div>
          <h1>What has leaked<br />about <span>this person</span>?</h1>
          <p>Search an email, a phone, a handle or a name across breach data, and get back more than a list of hits: the records assembled into one subject, with the dump every single fact came from.</p>
          <Link className="lk2-hero-cta" href="/search">Run a search →</Link>

          <div className="lk2-reveal">
            <span>what a report uncovers</span>
            <div>{UNCOVERS.map((t, i) => <em key={t} style={{ ["--i" as any]: i }}>{t}</em>)}</div>
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

        <section className="lk2-lp-sec">
          <h2>Four ways to read the same facts.</h2>
          <div className="lk2-views">
            {VIEWS.map((v) => (
              <div className="lk2-vcard" key={v.t}><h3>{v.t}</h3><p>{v.d}</p></div>
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
            checked against the selector before it is allowed to become a fact: an address
            matched in every spelling a dump holds it in, a number matched past the country
            code, and anyone who merely shares a surname listed on their own rather than
            folded in. A tool that quietly merges them produces a detailed, confident,
            wrong answer, which is worse than producing nothing.
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
