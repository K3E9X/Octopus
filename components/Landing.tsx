"use client";

// The front door.
//
// A showcase for an investigation tool has one job: prove the thing works before
// anyone signs up. So the search box here is not a mock — it runs the ENGINE'S seed
// reader, names the mode it would dispatch to, lists the stages it would actually
// run, and states the refusal that comes with that seed type. The neural field
// behind it lights the capability clusters that seed would really reach.
//
// What it deliberately is not: a hero gradient, a glass card, a rotating testimonial,
// a "trusted by" strip, or three feature boxes with rounded icons.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "./Logo";
import NeuralField from "./NeuralField";
import { readSeed, CAPABILITIES } from "@/lib/seedtype";

const EXAMPLES = ["marie.dubois@gmail.com", "xk9_zulu_42", "8.8.8.8", "acme-corp.fr", "+33 6 12 34 56 78", "d41d8cd98f00b204e9800998ecf8427e"];

export default function Landing({ signedIn }: { signedIn: boolean }) {
  const [q, setQ] = useState("");
  const [pulse, setPulse] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const read = useMemo(() => readSeed(q), [q]);
  const active = useMemo(
    () => new Set(CAPABILITIES.filter((c) => read.kind !== "empty" && c.kinds.includes(read.kind)).map((c) => c.id)),
    [read.kind],
  );

  function type(v: string) {
    setQ(v);
    setPulse((p) => p + 1); // every keystroke injects a stimulus at the input neuron
  }

  return (
    <div className="lp">
      <NeuralField kind={read.kind} pulse={pulse} />

      <header className="lp-top">
        <div className="lp-brand">
          <Logo size={30} />
          <span><b>OCTOPUS</b><small>OSINT</small></span>
        </div>
        <nav className="lp-nav">
          <a href="#what">What it does</a>
          <a href="#honest">How it stays honest</a>
          {signedIn
            ? <Link className="lp-cta" href="/app">Open the tool</Link>
            : <><Link href="/signin">Sign in</Link><Link className="lp-cta" href="/signin?mode=register">Create an account</Link></>}
        </nav>
      </header>

      <main className="lp-main">
        <h1 className="lp-h1">
          One identity,<br />resolved across everything.
        </h1>
        <p className="lp-lead">
          Octopus does not just find accounts. It decides which of them are the same person — and tells you when
          it cannot. Type anything below: the engine reads it here, exactly as it would inside the tool.
        </p>

        <div className="lp-search">
          <label htmlFor="lp-q">seed</label>
          <input
            id="lp-q" ref={inputRef} value={q} spellCheck={false} autoComplete="off"
            placeholder="a username, an email, a phone, a name, a domain, an IP, a hash"
            onChange={(e) => type(e.target.value)}
          />
          <span className={"lp-kind k-" + read.kind}>{read.kind === "empty" ? "waiting" : read.label}</span>
        </div>

        <div className="lp-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { type(ex); inputRef.current?.focus(); }}>{ex}</button>
          ))}
        </div>

        <div className={"lp-read" + (read.kind === "empty" ? " idle" : "")}>
          <p className="lp-what">{read.what}</p>
          {read.stages.length > 0 && (
            <ol className="lp-stages">
              {read.stages.map((s, i) => <li key={i}><i>{String(i + 1).padStart(2, "0")}</i>{s}</li>)}
            </ol>
          )}
          {read.caveat && <p className="lp-caveat">{read.caveat}</p>}
        </div>
      </main>

      <section className="lp-caps" id="what">
        <h2>What lights up</h2>
        <ul>
          {CAPABILITIES.map((c) => (
            <li key={c.id} className={active.has(c.id) ? "on" : ""}>
              <span className="lp-dot" />{c.label}
            </li>
          ))}
        </ul>
        <p className="lp-capnote">
          Those are not marketing categories. They are the collection stages the engine dispatches, and the
          highlighted ones are what your seed above would actually reach.
        </p>
      </section>

      <section className="lp-honest" id="honest">
        <h2>How it stays honest</h2>
        <div className="lp-grid">
          <article>
            <h3>A tier, not a percentage</h3>
            <p>
              Evidence is classified hard, soft, weak or <b>contradicting</b>, and the node gets a qualitative tier.
              A confidence number derived from that is shown second, because a number invents a precision the
              evidence has not earned.
            </p>
          </article>
          <article>
            <h3>Corroboration must be independent</h3>
            <p>
              Three facts read off one profile page are <b>one</b> sighting. Octopus tracks the root observation
              behind each piece of evidence and refuses to count the same source twice.
            </p>
          </article>
          <article>
            <h3>It can say no</h3>
            <p>
              A common handle is refused as a link. A role mailbox is not a person. A name that conflicts with the
              one you were looking for lowers the score instead of raising it.
            </p>
          </article>
          <article>
            <h3>Silence is reported</h3>
            <p>
              A rate-limited source did not say “no account” — it refused to answer. Every scan states which
              sources were unreachable, so an incomplete sweep is never read as a negative result.
            </p>
          </article>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-brand"><Logo size={22} /><span><b>OCTOPUS</b><small>OSINT</small></span></div>
        <span>Orbit, the gravitational graph, is one view inside it.</span>
        {signedIn
          ? <Link className="lp-cta" href="/app">Open the tool</Link>
          : <Link className="lp-cta" href="/signin?mode=register">Create an account</Link>}
      </footer>
    </div>
  );
}
