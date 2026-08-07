"use client";

// REUSE — who shares a password with whom.
//
// The links already existed on the nodes, but reading them one inspector panel at a
// time means you never see the SHAPE: that six accounts hang off one secret, or that two
// clusters touch at a single identity. That shape is the finding, and it is invisible
// unless something draws it.
//
// Three things this view refuses to do, all for the same reason — a reuse link is
// behavioural evidence and behaves badly when it is overstated:
//   - it never calls a cluster an identity. It is a set of accounts that share a habit.
//   - it separates OBSERVED links (the same string, seen) from INFERRED ones (the same
//     habit, deduced), and says which holds each cluster together.
//   - it shows what the guard REFUSED. An analyst who cannot see the refusals cannot
//     tell an empty graph from one whose every link was disqualified.

import { useMemo } from "react";
import { buildReuseGraph } from "@/lib/reusegraph";
import type { Signal } from "@/lib/signals";

export default function ReuseView({ signals, onPivot }: { signals: Signal[]; onPivot: (v: string) => void }) {
  const graph = useMemo(() => {
    const items = signals.flatMap((s) => s.exposure || []);
    return buildReuseGraph(items);
  }, [signals]);

  const nothing = !graph.clusters.length && !graph.refused.length && !graph.isolated.length;

  return (
    <div className="reuse-wrap">
      <div className="reuse-head">
        <h2>CREDENTIAL REUSE</h2>
        <p>
          Accounts tied together because the same person reused a password. This is behavioural evidence:
          it asserts one <b>person</b>, not one account, and it is only ever as good as how improbable the
          shared secret is.
        </p>
      </div>

      {nothing && (
        <div className="reuse-empty">
          No credential pairs recovered yet. This view fills in when a source returns <b>login:password</b> lines
          in clear — the free breach indexes do, Hudson Rock&rsquo;s free tier does not.
        </div>
      )}

      {graph.clusters.map((c) => (
        <div className="reuse-c" key={c.id}>
          <div className="reuse-ch">
            <span className={"reuse-q q-" + c.quality}>
              {c.quality === "observed" ? "observed" : c.quality === "inferred" ? "inferred habit" : "mixed"}
            </span>
            <span className="reuse-cn">{c.members.length} identities · {c.links.length} link(s)</span>
            <span className="reuse-cs">strongest {c.anchor.strength}</span>
          </div>
          <div className="reuse-members">
            {c.members.map((m) => (
              <button key={m.id} className="reuse-m" onClick={() => onPivot(m.id)} title="scan this identity">
                <span className="reuse-mid">{m.id}</span>
                <span className="reuse-md">{m.degree} link{m.degree > 1 ? "s" : ""}{m.secrets > 1 ? ` · ${m.secrets} secrets` : ""}</span>
              </button>
            ))}
          </div>
          <div className="reuse-links">
            {c.links.slice(0, 8).map((l, i) => (
              <div className={"reuse-l" + (l.mode === "pattern" ? " is-pattern" : "")} key={i}>
                <span className="reuse-lw">{l.strength}</span>
                <span className="reuse-lt">
                  {l.mode === "pattern"
                    ? <>same habit: <b>{l.secret}</b> / <b>{l.secretB}</b></>
                    : <>same password: <b>{l.secret}</b></>}
                </span>
                <span className="reuse-lp">{l.a} ↔ {l.b}</span>
              </div>
            ))}
            {c.links.length > 8 && <div className="reuse-lmore">+{c.links.length - 8} more link(s)</div>}
          </div>
        </div>
      ))}

      {graph.refused.length > 0 && (
        <div className="reuse-refused">
          <div className="reuse-rh">REFUSED BY THE GUARD ({graph.refused.length})</div>
          <p>
            These identities DO share a password. Octopus does not link them, because the secret proves nothing —
            and an analyst who saw the collision without this note would draw the conclusion anyway.
          </p>
          {graph.refused.map((r, i) => (
            <div className="reuse-r" key={i}>
              <div className="reuse-rids">{r.ids.join(" · ")}</div>
              <div className="reuse-rr">{r.reason}</div>
            </div>
          ))}
        </div>
      )}

      {graph.isolated.length > 0 && (
        <div className="reuse-iso">
          <div className="reuse-rh">NO SHARED SECRET ({graph.isolated.length})</div>
          <div className="reuse-isolist">
            {graph.isolated.slice(0, 40).map((m) => <span key={m.id}>{m.id}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}
