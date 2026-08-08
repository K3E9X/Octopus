"use client";

// The front door — the Abyss landing, built to the reference.
//
// A depth dive: surface at the seed panel, −800 m at the reach, −2400 m at the verdict,
// −3900 m at the floor. The page darkens as you descend and the rail on the left reads
// out where you are.
//
// The one thing here that is not decoration: the seed panel runs the ENGINE'S own
// reader (lib/seedtype), so typing an address names the mode it would really dispatch
// to, lists the stages it would really run, and states the refusal that comes with that
// seed type. A showcase for an investigation tool that lies about the tool is worse than
// no showcase. The reference reimplements readSeed inline for its mock; here it is the
// real import, which is also why the capability list cannot drift from the engine.

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { OctoMark } from "./OctoMark";
import { readSeed, CAPABILITIES } from "@/lib/seedtype";

const Octo3D = dynamic(() => import("./Octo3D"), { ssr: false });
const MarineSnow = dynamic(() => import("./MarineSnow"), { ssr: false });
const AbyssMotion = dynamic(() => import("./AbyssMotion"), { ssr: false });

const EXAMPLES = ["marie.dubois@gmail.com", "xk9_zulu_42", "8.8.8.8", "acme-corp.fr", "+33 6 12 34 56 78", "d41d8cd98f00b204e9800998ecf8427e"];

/** The four honesty articles. Each takes the hue that types that idea in the graph. */
const HONEST = [
  { n: "01", tone: "var(--accent)", h: "A tier, not a percentage",
    p: <>Evidence is hard, soft, weak or <b>contradicting</b>, and the node gets a qualitative tier. The number comes second — a number invents precision the evidence has not earned.</> },
  { n: "02", tone: "var(--type-alias)", h: "Corroboration is independent",
    p: <>Three facts read off one profile page are <b>one</b> sighting. Every piece of evidence carries its root observation, and the same source is never counted twice.</> },
  { n: "03", tone: "var(--type-location)", h: "It can say no",
    p: <>A common handle is refused as a link. A role mailbox is not a person. A conflicting name lowers the score instead of raising it.</> },
  { n: "04", tone: "var(--ink)", h: "Silence is reported",
    p: <>A rate-limited source did not say &ldquo;no account&rdquo; — it refused to answer. Every scan states which sources were unreachable, so an incomplete sweep is never read as a negative.</> },
];

export default function Landing({ signedIn }: { signedIn: boolean }) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const read = useMemo(() => readSeed(q), [q]);
  const active = useMemo(
    () => new Set(CAPABILITIES.filter((c) => read.kind !== "empty" && c.kinds.includes(read.kind)).map((c) => c.id)),
    [read.kind],
  );

  // A capability row sparks when the seed actually reaches it. The class is written
  // straight onto the node — driving it through React would mean a re-render per spark.
  const capRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const spark = useCallback((cap: string) => {
    const el = capRefs.current[cap];
    if (!el) return;
    el.classList.remove("spark");
    void el.offsetWidth;               // restart the animation; without the reflow it never replays
    el.classList.add("spark");
  }, []);

  function type(v: string) {
    setQ(v);
    // the seed lights what it would reach, one cluster at a time, at dispatch pace
    const kind = readSeed(v).kind;
    if (kind === "empty") return;
    CAPABILITIES.filter((c) => c.kinds.includes(kind))
      .forEach((c, i) => setTimeout(() => spark(c.id), 60 + i * 55));
  }

  const cta = signedIn ? "Open the tool" : "Create access";
  const ctaHref = signedIn ? "/app" : "/signin?mode=register";

  return (
    <div className="lp">
      <MarineSnow />
      <AbyssMotion />

      <header className="lp-top">
        <Link className="lp-brand" href="/">
          <OctoMark size={44} float glow />
          <span><b>OCTOPUS</b><small>OSINT</small></span>
        </Link>
        <nav className="lp-nav">
          <a href="#reach">The reach</a>
          <a href="#verdict">The verdict</a>
          {!signedIn && <Link href="/signin">Sign in</Link>}
          <Link className="lp-cta" href={ctaHref}>{cta}</Link>
        </nav>
      </header>

      {/* ---- 0 m · surface -------------------------------------------------------- */}
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <div className="lp-eyebrow"><span className="lp-pip" />0 m — surface · the seed goes in here</div>

          <h1 className="lp-h1">Eight arms.<br />One <span>verdict</span>.</h1>

          <p className="lp-lead">
            Octopus sends proven collectors into every corner of the open web — then does the part nobody
            does well: it decides, on evidence, which findings are the <b>same person</b>. And it tells you
            when it can&rsquo;t.
          </p>

          <div className="lp-engine">
            <div className="lp-engine-head">
              <span className="lp-pip sm" />
              engine read — live
              <span key={read.kind} className={"lp-kind k-" + read.kind}>{read.kind === "empty" ? "waiting" : read.label}</span>
            </div>
            <div className="lp-engine-in">
              <label htmlFor="lp-q">seed</label>
              <input
                id="lp-q" ref={inputRef} value={q} spellCheck={false} autoComplete="off"
                placeholder="username · email · phone · name · domain · IP · hash"
                onChange={(e) => type(e.target.value)}
              />
            </div>
            <div className={"lp-engine-out" + (read.kind === "empty" ? " idle" : "")}>
              <p className="lp-what">{read.what}</p>
              {read.stages.length > 0 && (
                <ol className="lp-stages" key={read.kind}>
                  {read.stages.map((s, i) => (
                    <li key={i} style={{ ["--i" as string]: i }}><i>{String(i + 1).padStart(2, "0")}</i>{s}</li>
                  ))}
                </ol>
              )}
              {read.caveat && <p className="lp-caveat">{read.caveat}</p>}
            </div>
          </div>

          <div className="lp-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => { type(ex); inputRef.current?.focus(); }}>{ex}</button>
            ))}
          </div>
        </div>

        <div className="lp-hero-3d">
          <Octo3D scene="hero" />
          <span className="lp-3d-cap">arms out · sources adrift · findings carried home</span>
        </div>
      </section>

      {/* ---- −800 m · the reach --------------------------------------------------- */}
      <section className="lp-reach rise" id="reach">
        <div className="lp-orb"><Octo3D scene="orb" /></div>
        <div>
          <div className="lp-depth-label">−800 m — the reach</div>
          <h2>The sweep reaches wide.<br />Only answers become <span>evidence</span>.</h2>
          <p>
            The sweep touches each source in order — mainstream first, tail last — and reports which ones
            stayed silent. These are the collection stages the engine dispatches; the lit ones are what
            your seed above would actually reach.
          </p>
          <ul className="lp-caps">
            {CAPABILITIES.map((c) => (
              <li key={c.id} ref={(el) => { capRefs.current[c.id] = el; }} className={"cap" + (active.has(c.id) ? " on" : "")}>
                <span className="capdot" />{c.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---- −2400 m · the verdict ------------------------------------------------ */}
      <section className="lp-verdict rise" id="verdict">
        <div className="lp-depth-label">−2400 m — the verdict</div>
        <h2>Down here, the light you carry is the only light. It stays <span>honest</span>.</h2>
        <div className="lp-honest-grid">
          {HONEST.map((a) => (
            <article key={a.n}>
              <div className="lp-art-head">
                <span className="lp-art-n">{a.n}</span>
                <h3 style={{ color: a.tone }}>{a.h}</h3>
              </div>
              <p>{a.p}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- −3900 m · the floor --------------------------------------------------- */}
      <section className="lp-floor rise" id="floor">
        <div className="lp-depth-label">−3900 m — the floor</div>
        <h2>This is where it lives.</h2>
        <p>
          Orbit — the gravitational graph where confidence is distance — is one view inside it. The table,
          the timeline, the dossier and the board are the others.
        </p>
        <Link className="lp-floor-cta" href={ctaHref}>{cta}</Link>
        <div className="lp-foot">
          <span>OCTOPUS · OSINT</span><span aria-hidden="true">·</span>
          <span>delegate collection, own correlation</span><span aria-hidden="true">·</span>
          <span>the engine runs on your deployment</span>
        </div>
      </section>
    </div>
  );
}
