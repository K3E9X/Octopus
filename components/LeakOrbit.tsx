"use client";

// The Orbit, what holds this identity together, and what breaks if one fact is wrong.
//
// It used to be a constellation: the subject in the middle, a ring of breaches around
// them, every field drawn as a satellite. Two things were wrong with it.
//
// It did not survive its own data. Every breach sat at an equal angle on one ellipse
// whose radius was capped, so past about a dozen the circles overlapped each other and
// their own labels, and the satellites, up to twelve per breach, turned the whole
// thing into a smear. Nobody had asked what the twentieth breach would look like.
//
// And it answered nothing. It was the same facts as the other views, arranged in a
// circle. A view has to earn its tab.
//
// WHAT IT IS FOR NOW. Every other view reads the facts; this is the only one that can
// read how they are JOINED. Two breaches belong to the same person because some value
// appears in both, so "these five databases are one person" is a graph, and graphs
// have load-bearing edges. Pull a thread and the view recomputes without it: if the
// identity falls into pieces, that fact was carrying the conclusion, and the operator
// should know which facts those are BEFORE they act on the report.
//
// The maths is in lib/orbit.ts, under test, including the thing the old version got
// wrong: that no two nodes overlap, asserted up to forty databases.
//
// The satellites are gone from the graph and live in the panel. The graph shows
// structure; focusing a node shows its contents. That is what keeps it readable when
// somebody appears in thirty dumps.

import { useMemo, useState } from "react";
import { buildGraph, layoutBipartite, pullThread, describeGraph, type OrbitSource } from "@/lib/orbit";

type Sev = "critical" | "high" | "medium" | "low";
interface Finding { category: string; severity: Sev; label: string; value: string; source: string; masked?: boolean }
interface SrcReport { name: string; info: string; date?: string; sortDate: number; findings: Finding[]; severity: Sev }
interface Report { subject: string; sources: SrcReport[]; breachCount: number; dataPoints: number }

const SEV_COLOR: Record<Sev, string> = { critical: "#ED455C", high: "#F06338", medium: "#F4B02A", low: "#56B5BD" };
const CAT_COLOR: Record<string, string> = {
  password: "#ED455C", financial: "#ED455C", document: "#F06338", identity: "#F06338",
  location: "#F4B02A", email: "#56B5BD", phone: "#56B5BD", online: "#9A8FD1",
  professional: "#C8A98A", other: "#7E9397",
};
const catColor = (c: string) => CAT_COLOR[c] || "#93A8AA";
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const W = 1000, H = 640;

export default function LeakOrbit({ report }: { report: Report }) {
  const [focus, setFocus] = useState<string | null>(null);
  /** the thread the operator is asking the counterfactual about */
  const [pulled, setPulled] = useState<string | null>(null);

  const sources: OrbitSource[] = useMemo(
    () => report.sources.map((s) => ({ name: s.name, severity: s.severity, date: s.date, findings: s.findings })),
    [report.sources],
  );

  // The graph as it stands, and the graph as it would be without the pulled thread.
  // Both are kept: the panel has to say what CHANGED, not only what is true now.
  const full = useMemo(() => buildGraph(sources), [sources]);
  const g = useMemo(() => (pulled ? buildGraph(sources, [pulled]) : full), [sources, pulled, full]);
  const consequence = useMemo(() => (pulled ? pullThread(sources, pulled) : null), [sources, pulled]);

  // Laid out from the FULL graph on purpose: the counterfactual must not move anything.
  // If the nodes jumped as well, the reader could not tell which change was the answer.
  const { dbs: placed, hubs } = useMemo(() => layoutBipartite(full, { width: W, height: H }), [full]);
  const at = useMemo(() => new Map(placed.map((p) => [p.name, p])), [placed]);
  const hubAt = useMemo(() => new Map(hubs.map((h) => [h.id, h])), [hubs]);
  /** labels stop fitting somewhere around fifteen; past that they are shown on demand */
  const labelAll = placed.length <= 14;

  const nodeOf = useMemo(() => new Map(g.nodes.map((n) => [n.name, n])), [g]);
  const focused = focus ? report.sources.find((s) => s.name === focus) : null;
  const liveThreads = full.threads;
  const spine = liveThreads[0];
  const bearing = full.threads.filter((t) => t.loadBearing);

  /** which nodes a hovered thread touches, so hovering a thread lights its path */
  const [hotThread, setHotThread] = useState<string | null>(null);
  const hotNodes = useMemo(() => {
    const t = liveThreads.find((x) => x.id === hotThread);
    return t ? new Set(t.databases) : null;
  }, [hotThread, liveThreads]);

  if (!g.nodes.length) {
    return <div className="lk2-orbit-empty">No database named this subject, so there is nothing to connect.</div>;
  }

  return (
    <div className="lk2-orbit">
      <svg className="lk2-orbit-svg" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Connection graph: ${describeGraph(g)}`}>
        <defs>
          <filter id="lkGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* One line per database that carried a value, meeting at the value itself.
            Drawn pairwise this was a complete graph, twenty-two databases sharing one
            email is two hundred and thirty-one lines saying one thing. */}
        <g>
          {full.threads.map((t) => {
            const h = hubAt.get(t.id);
            if (!h) return null;
            const gone = pulled === t.id;
            return t.databases.map((dbName) => {
              const d = at.get(dbName);
              if (!d) return null;
              const lit = hotThread ? hotThread === t.id : !focus || focus === dbName;
              return (
                <line key={t.id + dbName} x1={h.x} y1={h.y} x2={d.x} y2={d.y}
                  className={"lk2-edge" + (lit && !gone ? "" : " dim") + (gone ? " cut" : "")}
                  stroke={catColor(t.category)} strokeWidth={t.loadBearing ? 1.7 : 1.1}>
                  <title>{dbName} carried {t.value}</title>
                </line>
              );
            });
          })}
        </g>

        {/* the values themselves, the thing that makes these databases one person */}
        <g>
          {full.threads.map((t) => {
            const h = hubAt.get(t.id);
            if (!h) return null;
            const gone = pulled === t.id;
            const hot = hotThread === t.id;
            return (
              <g key={t.id} className={"lk2-hub" + (gone ? " cut" : "") + (hot ? " on" : "") + (hotThread && !hot ? " dim" : "")}
                onMouseEnter={() => setHotThread(t.id)} onMouseLeave={() => setHotThread(null)}
                onClick={() => setPulled(pulled === t.id ? null : t.id)}>
                {/* Load-bearing is a property of the VALUE, so it is drawn on the value.
                    Dashing its lines instead meant the spine, which joins everything, dashed most of the graph, and an exception that covers the picture
                    has stopped being one. */}
                {t.loadBearing && <circle cx={h.x} cy={h.y} r={h.r + 5} className="lk2-hub-ring" stroke={catColor(t.category)} />}
                <circle cx={h.x} cy={h.y} r={h.r} fill={catColor(t.category)} className="lk2-hub-c" />
                {/* On hover only. A label under a hub that twenty databases surround is
                    printed on top of them; the panel names every thread anyway. */}
                {hot && <text x={h.x} y={h.y + h.r + 14} className="lk2-hub-l" textAnchor="middle">{short(t.value, 26)}</text>}
                <title>{t.value}, in {t.databases.length} databases{t.loadBearing ? ". Load-bearing: remove it and the identity splits." : ""}</title>
              </g>
            );
          })}
        </g>

        {/* the databases */}
        <g>
          {placed.map((p) => {
            const nd = nodeOf.get(p.name)!;
            const alone = g.isolated.includes(p.name);
            const active = focus === p.name;
            const dim = (focus && !active) || (!!hotNodes && !hotNodes.has(p.name));
            return (
              <g key={p.name} className={"lk2-node" + (active ? " on" : "") + (dim ? " dim" : "") + (alone ? " alone" : "")}
                onMouseEnter={() => setFocus(p.name)} onMouseLeave={() => setFocus(null)}>
                <circle cx={p.x} cy={p.y} r={p.r} className="lk2-node-c" stroke={SEV_COLOR[nd.severity]}
                  filter={nd.severity === "critical" ? "url(#lkGlow)" : undefined} />
                <text x={p.x} y={p.y + 1} className="lk2-node-n" textAnchor="middle">{nd.weight}</text>
                {(labelAll || active || alone) &&
                  <text x={p.x} y={p.y + p.r + 15} className="lk2-node-l" textAnchor="middle">{short(p.name, 18)}</text>}
                <title>{p.name}, {nd.weight} distinct values{alone ? ", joined to nothing" : ""}</title>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="lk2-orbit-side">
        <div className="lk2-orbit-card">
          <div className="lk2-orbit-verdict">{describeGraph(g)}</div>
          {/* Without this the picture is a puzzle. Two kinds of circle and a line
              between them is only obvious to whoever drew it. */}
          <p className="lk2-orbit-key">
            <b>Circles</b> are databases, sized by how much they hold.
            <b>Dots</b> are values. A line means that database carried that value.
          </p>

          {/* The counterfactual, stated in full. This is the view's whole argument, so it
              says what the operator asked, what happened, and how to undo it. */}
          {pulled && consequence && (
            <div className={"lk2-pulled" + (consequence.after > consequence.before ? " broke" : "")}>
              <p>
                Without <b>{short(liveThreads.find((t) => t.id === pulled)?.value || "", 34)}</b>:{" "}
                {consequence.after > consequence.before
                  ? <>the identity falls into <b>{consequence.after} fragments</b>
                      {consequence.isolates.length > 0 && <>, {consequence.isolates.join(", ")} connect to nothing else</>}.</>
                  : <>nothing changes. Other values still join the same databases, so the conclusion does not rest on this one.</>}
              </p>
              <button onClick={() => setPulled(null)}>Put it back</button>
            </div>
          )}

          {spine && !pulled && (
            <p className="lk2-orbit-spine">
              <span>spine</span>
              <code>{short(spine.value, 30)}</code>
              ties {spine.databases.length} of {g.nodes.length} databases. It is also the best thing to pivot on.
            </p>
          )}

          {liveThreads.length > 0 ? (
            <>
              <h5>Pull a thread</h5>
              <p className="lk2-orbit-why">Each is a value two or more databases agree on. Take one away and see whether the person survives it.</p>
              <ul className="lk2-threads">
                {liveThreads.slice(0, 14).map((t) => (
                  <li key={t.id}>
                    <button
                      className={(pulled === t.id ? "on " : "") + (t.loadBearing ? "load" : "")}
                      onMouseEnter={() => setHotThread(t.id)} onMouseLeave={() => setHotThread(null)}
                      title={t.value}
                      onClick={() => setPulled(pulled === t.id ? null : t.id)}>
                      <i style={{ background: catColor(t.category) }} />
                      <code>{t.value}</code>
                      <span>{t.databases.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {bearing.length > 0 && (
                <p className="lk2-orbit-note">
                  {bearing.length} of these {liveThreads.length} are load-bearing, marked, and ringed in the graph.
                  If one turns out to be a coincidence rather than the same person, the report is no longer about one person.
                </p>
              )}
            </>
          ) : (
            <p className="lk2-orbit-note">
              No value appears in more than one database, so nothing here corroborates anything else.
              Every row is a single unverified claim.
            </p>
          )}

          {focused && (
            <div className="lk2-orbit-focus">
              <div className="lk2-orbit-card-h"><span className={"lk2-dot s-" + focused.severity} />{focused.name}</div>
              {focused.date && <div className="lk2-orbit-date">{focused.date}</div>}
              <ul>{focused.findings.slice(0, 12).map((f, j) => (
                <li key={j}><i style={{ background: catColor(f.category) }} />{f.label}</li>
              ))}</ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
