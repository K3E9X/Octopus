"use client";

// The Orbit view — a constellation of your own exposure.
//
// The operator console had an "orbit" that plotted an investigation's signals. This is
// that idea turned on the person themselves: YOU at the centre, each breach you appear in
// on its own orbit (sized by how much it holds, coloured by how bad it is), the fields it
// leaked as satellites, and a drawn arc wherever one value — an email, a handle — recurs
// across two breaches, because that recurrence is how separate leaks become one profile.
//
// Pure SVG fed by the SelfReport. No periphery, no network. Interactive: hover a breach to
// pull it forward and read its fields; the rest dims. Motion is a one-time draw-in plus a
// slow drift, and it all stops under prefers-reduced-motion (handled in CSS).

import { useMemo, useState } from "react";

type Sev = "critical" | "high" | "medium" | "low";
interface Finding { category: string; severity: Sev; label: string; value: string; source: string; masked?: boolean }
interface SrcReport { name: string; info: string; date?: string; sortDate: number; findings: Finding[]; severity: Sev }
interface Report { subject: string; sources: SrcReport[]; breachCount: number; dataPoints: number }

// aligned to the CSS severity ramp (hsl → hex), off the brand orange on purpose
const SEV_COLOR: Record<Sev, string> = { critical: "#ED455C", high: "#F06338", medium: "#F4B02A", low: "#56B5BD" };
const CAT_COLOR: Record<string, string> = {
  password: "#ED455C", financial: "#ED455C", document: "#F06338", identity: "#F06338",
  location: "#F4B02A", email: "#56B5BD", phone: "#56B5BD", online: "#9A8FD1",
  professional: "#C8A98A", other: "#7E9397",
};
const catColor = (c: string) => CAT_COLOR[c] || "#93A8AA";

const W = 1000, H = 560, CX = 500, CY = 288;

export default function LeakOrbit({ report }: { report: Report }) {
  const [focus, setFocus] = useState<string | null>(null);

  const layout = useMemo(() => {
    const srcs = report.sources.filter((s) => s.findings.length > 0);
    const n = Math.max(1, srcs.length);
    const ringR = Math.min(200, 140 + n * 8);
    const RX = 1.45, RY = 0.9;   // a wide ellipse fits the wide card

    // where each value lives, so a value in >1 breach can be drawn as a correlation
    const valueHomes = new Map<string, Set<string>>();
    for (const s of srcs) for (const f of s.findings) {
      const k = f.category + "|" + f.value.toLowerCase();
      (valueHomes.get(k) || valueHomes.set(k, new Set()).get(k)!).add(s.name);
    }

    const nodes = srcs.map((s, i) => {
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const x = CX + ringR * RX * Math.cos(ang), y = CY + ringR * RY * Math.sin(ang);
      const r = Math.max(18, Math.min(36, 14 + s.findings.length * 2.4));
      const show = s.findings.slice(0, 12);
      const sats = show.map((f, j) => {
        // satellites ride the upper arc only (-207° → +27°), keeping the label below the node clear
        const sa = -Math.PI * 1.15 + (show.length > 1 ? j / (show.length - 1) : 0.5) * Math.PI * 1.3;
        const sr = r + 16 + (j % 2) * 9;
        return { f, x: x + sr * Math.cos(sa), y: y + sr * Math.sin(sa) };
      });
      return { s, x, y, r, ang, sats };
    });

    // correlation arcs between breaches that share a value
    const posByName = new Map(nodes.map((nd) => [nd.s.name, nd]));
    const arcs: { a: string; b: string; value: string; category: string }[] = [];
    const pairSeen = new Set<string>();
    for (const [k, names] of valueHomes) {
      if (names.size < 2) continue;
      const arr = [...names];
      const [category, value] = [k.split("|")[0], k.slice(k.indexOf("|") + 1)];
      for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) {
        const pk = [arr[a], arr[b]].sort().join("¬");
        if (pairSeen.has(pk + "|" + category)) continue;
        pairSeen.add(pk + "|" + category);
        arcs.push({ a: arr[a], b: arr[b], value, category });
      }
    }
    return { nodes, arcs, posByName, count: srcs.length, rx: ringR * RX, ry: ringR * RY };
  }, [report]);

  if (!layout.count) return <p className="lk2-clear">Nothing to plot — no breach held a field tied to you.</p>;

  const focused = focus ? layout.nodes.find((n) => n.s.name === focus) : null;

  return (
    <div className="lk2-orbit">
      <svg viewBox={`0 0 ${W} ${H}`} className="lk2-orbit-svg" role="img" aria-label="Constellation of your exposure">
        <defs>
          <radialGradient id="lkCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.15" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <filter id="lkGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* faint orbit guide */}
        <ellipse cx={CX} cy={CY} rx={layout.rx} ry={layout.ry}
          className="lk2-orbit-ring" />

        {/* correlation arcs (behind nodes) */}
        <g className="lk2-orbit-arcs">
          {layout.arcs.map((arc, i) => {
            const a = layout.posByName.get(arc.a), b = layout.posByName.get(arc.b);
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const dim = focus && arc.a !== focus && arc.b !== focus;
            return (
              <path key={i} d={`M ${a.x} ${a.y} Q ${CX + (mx - CX) * 0.4} ${CY + (my - CY) * 0.4} ${b.x} ${b.y}`}
                className={"lk2-arc" + (dim ? " dim" : "")} stroke={catColor(arc.category)} style={{ ["--i" as any]: i }}>
                <title>{arc.value} — in {arc.a} and {arc.b}</title>
              </path>
            );
          })}
        </g>

        {/* links centre → breach */}
        <g>
          {layout.nodes.map((nd, i) => (
            <line key={i} x1={CX} y1={CY} x2={nd.x} y2={nd.y}
              className={"lk2-link" + (focus && focus !== nd.s.name ? " dim" : "")} style={{ ["--i" as any]: i }} />
          ))}
        </g>

        {/* satellites */}
        <g>
          {layout.nodes.map((nd) =>
            nd.sats.map((st, j) => {
              const dim = focus && focus !== nd.s.name;
              return <circle key={nd.s.name + j} cx={st.x} cy={st.y} r={focus === nd.s.name ? 4.5 : 3}
                className={"lk2-sat" + (dim ? " dim" : "")} fill={catColor(st.f.category)} style={{ ["--i" as any]: j }}>
                <title>{st.f.label}: {st.f.masked ? "(masked)" : st.f.category}</title>
              </circle>;
            })
          )}
        </g>

        {/* breach nodes */}
        <g>
          {layout.nodes.map((nd, i) => {
            const active = focus === nd.s.name;
            const dim = focus && !active;
            return (
              <g key={nd.s.name} className={"lk2-node" + (active ? " on" : "") + (dim ? " dim" : "")}
                style={{ ["--i" as any]: i }} onMouseEnter={() => setFocus(nd.s.name)} onMouseLeave={() => setFocus(null)}>
                <circle cx={nd.x} cy={nd.y} r={nd.r} className="lk2-node-c" stroke={SEV_COLOR[nd.s.severity]}
                  filter={nd.s.severity === "critical" ? "url(#lkGlow)" : undefined} />
                <text x={nd.x} y={nd.y + 1} className="lk2-node-n" textAnchor="middle">{nd.s.findings.length}</text>
                <text x={nd.x} y={nd.y + nd.r + 15} className="lk2-node-l" textAnchor="middle">
                  {nd.s.name.length > 16 ? nd.s.name.slice(0, 15) + "…" : nd.s.name}
                </text>
              </g>
            );
          })}
        </g>

        {/* the core — you */}
        <circle cx={CX} cy={CY} r="88" fill="url(#lkCore)" className="lk2-core-halo" />
        <circle cx={CX} cy={CY} r="30" className="lk2-core" filter="url(#lkGlow)" />
        <text x={CX} y={CY + 1} className="lk2-core-x" textAnchor="middle">YOU</text>
        <text x={CX} y={CY + 50} className="lk2-core-sub" textAnchor="middle">
          {report.subject.length > 30 ? report.subject.slice(0, 29) + "…" : report.subject}
        </text>
      </svg>

      <div className="lk2-orbit-side">
        {focused ? (
          <div className="lk2-orbit-card">
            <div className="lk2-orbit-card-h"><span className={"lk2-dot s-" + focused.s.severity} />{focused.s.name}</div>
            {focused.s.date && <div className="lk2-orbit-date">{focused.s.date}</div>}
            <ul>{focused.s.findings.slice(0, 14).map((f, j) => (
              <li key={j}><i style={{ background: catColor(f.category) }} />{f.label}</li>
            ))}</ul>
          </div>
        ) : (
          <div className="lk2-orbit-hint">
            <p>Hover a breach to read what it holds.</p>
            <div className="lk2-orbit-legend">
              {[["Passwords / financial", "#ED455C"], ["Identity / documents", "#F06338"], ["Address", "#F4B02A"], ["Contact", "#56B5BD"], ["Accounts / work", "#9A8FD1"]]
                .map(([l, c]) => <span key={l}><i style={{ background: c as string }} />{l}</span>)}
            </div>
            {layout.arcs.length > 0 && <p className="lk2-orbit-note">{layout.arcs.length} value(s) recur across breaches — the arcs — which is how separate leaks tie back to one person.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
