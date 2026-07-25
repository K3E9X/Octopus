"use client";

// The investigator's board. A free surface for the work the scanner does not do:
// your own reading, your tips, your theories — pinned next to what the engine found,
// and correlated with it rather than kept in a separate text file.
//
// Interaction model, deliberately small:
//   drag background → pan          drag card → move it
//   click a card    → edit in place
//   LINK on a card  → then click another card, then pick what the link MEANS
//   CORRELATE       → pushes the card's identifier through the same engine as a scan
//
// The art direction is the app's: hairline borders, one accent, no fills, no icons
// that are not geometry. Cards are paper only in behaviour, never in decoration.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CARD_KINDS, LINK_KINDS, addCard, updateCard, removeCard, linkCards, removeLink,
  tally, correlatable, type BoardCard, type CardKind, type Casefile, type LinkKind,
} from "@/lib/casefile";
import type { Signal } from "@/lib/signals";

const CARD_W = 232;

interface Props {
  file: Casefile;
  onChange: (f: Casefile) => void;
  /** graph nodes, so a pinned card can show what the engine currently says */
  signals: Signal[];
  /** push a card's identifier through the correlation engine */
  onCorrelate: (card: BoardCard) => void;
  /** relaunch a full investigation FROM this card's identifier */
  onInvestigate: (card: BoardCard) => void;
  /** select a graph node (used when a pinned card is opened) */
  onSelectSignal: (id: string) => void;
  busyCardId?: string | null;
}

export default function CaseBoard({ file, onChange, signals, onCorrelate, onInvestigate, onSelectSignal, busyCardId }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ from: string; to: string } | null>(null);
  const [addKind, setAddKind] = useState<CardKind>("lead");
  const [editLink, setEditLink] = useState<string | null>(null);
  const dragRef = useRef<{ id: string | null; ox: number; oy: number; px: number; py: number } | null>(null);

  const byId = useMemo(() => new Map(signals.map((s) => [s.id, s])), [signals]);

  // Esc cancels whatever gesture is half-finished, which on a board is most of them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setLinkFrom(null); setPendingLink(null); setEditing(null); setEditLink(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onBackgroundDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    // Pan capture must never swallow a control. Capturing the pointer on the canvas
    // retargets the following click to the canvas, so anything inside it would never
    // receive its own click — that silently ate the link-kind picker, and then the link
    // edit handles. A blocklist of tag names missed SVG entirely, so every interactive
    // element now carries data-ui and this is an allowlist.
    const t = e.target as Element;
    if (t.closest?.(".bc-card, .bl-picker, [data-ui]")) return;
    setEditing(null);
    dragRef.current = { id: null, ox: e.clientX, oy: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onCardDown(e: React.PointerEvent, c: BoardCard) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a, select")) return;
    e.stopPropagation();
    dragRef.current = { id: c.id, ox: e.clientX, oy: e.clientY, px: c.x, py: c.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.ox, dy = e.clientY - d.oy;
    if (d.id === null) setPan({ x: d.px + dx, y: d.py + dy });
    else if (Math.abs(dx) + Math.abs(dy) > 2) onChange(updateCard(file, d.id, { x: d.px + dx, y: d.py + dy }));
  }

  function onUp() { dragRef.current = null; }

  function add(kind: CardKind) {
    const next = addCard(file, { kind, title: "", body: "" });
    onChange(next);
    setEditing(next.cards[next.cards.length - 1].id);
  }

  function onCardClick(c: BoardCard) {
    if (linkFrom && linkFrom !== c.id) { setPendingLink({ from: linkFrom, to: c.id }); setLinkFrom(null); return; }
    if (linkFrom === c.id) { setLinkFrom(null); return; }
    setEditing(c.id);
  }

  function commitLink(kind: LinkKind) {
    if (!pendingLink) return;
    onChange(linkCards(file, pendingLink.from, pendingLink.to, kind));
    setPendingLink(null);
  }

  const cardById = new Map(file.cards.map((c) => [c.id, c]));
  const anchor = (id: string) => {
    const c = cardById.get(id);
    return c ? { x: c.x + CARD_W / 2, y: c.y + 46 } : { x: 0, y: 0 };
  };

  return (
    <div className="bwrap">
      <div className="board-toolbar">
        <select className="api-select bc-kind" value={addKind} onChange={(e) => setAddKind(e.target.value as CardKind)} aria-label="card kind">
          {CARD_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label} — {k.hint}</option>)}
        </select>
        <button className="ping-btn" onClick={() => add(addKind)}>Add card</button>
        <span className="board-count">{file.cards.length} card(s) · {file.links.length} link(s)</span>
        <span className="flex" />
        {linkFrom && <span className="board-mode">linking — click the other card, or Esc</span>}
        <button className="ping-btn" onClick={() => setPan({ x: 0, y: 0 })}>Recentre</button>
      </div>

      <div className="bcanvas" ref={wrapRef} onPointerDown={onBackgroundDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {file.cards.length === 0 && (
          <div className="board-empty">
            <b>Your side of the investigation.</b>
            <p>
              The graph holds what the connectors found. This holds what <i>you</i> found: a forum thread, a tip,
              a name you recognised, a theory you are trying to kill. Add a card, link it to another, and say what the
              link <b>means</b> — supports, contradicts, leads to.
            </p>
            <p>
              A card whose title is a handle, an email or a URL can be pushed through the same correlation engine as a
              scan with <b>Correlate</b>: it becomes real graph nodes, scored by the same rules, not by how sure you felt.
              And any node on the graph can be pinned here from its right-click menu.
            </p>
            <p className="board-empty-note">
              Hypothesis cards are never given a probability. They get a tally — what supports them, what contradicts
              them, what is still open.
            </p>
          </div>
        )}

        <div className="bplane" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          {file.cards.map((c) => {
            const sig = c.ref ? byId.get(c.ref) : undefined;
            const t = c.kind === "hypothesis" ? tally(file, c.id) : null;
            const corr = correlatable(c);
            const isEditing = editing === c.id;
            return (
              <div
                key={c.id}
                className={"bc-card k-" + c.kind + " s-" + c.status + (linkFrom === c.id ? " linking" : "") + (isEditing ? " open" : "")}
                style={{ left: c.x, top: c.y }}
                onPointerDown={(e) => onCardDown(e, c)}
                onClick={() => onCardClick(c)}
              >
                <div className="bc-head">
                  <span className="bc-kind">{CARD_KINDS.find((k) => k.id === c.kind)?.label}</span>
                  <button
                    className="bc-status" title="cycle status"
                    onClick={(e) => {
                      e.stopPropagation();
                      const order = ["open", "confirmed", "refuted", "parked"] as const;
                      const next = order[(order.indexOf(c.status) + 1) % order.length];
                      onChange(updateCard(file, c.id, { status: next }));
                    }}
                  >{c.status}</button>
                </div>

                {isEditing ? (
                  <>
                    <input
                      className="bc-title-in" autoFocus value={c.title} placeholder="handle, email, URL or a short title"
                      onChange={(e) => onChange(updateCard(file, c.id, { title: e.target.value }))}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <textarea
                      className="bc-body-in" rows={3} value={c.body} placeholder="what you know, and how you know it"
                      onChange={(e) => onChange(updateCard(file, c.id, { body: e.target.value }))}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <input
                      className="bc-title-in bc-url-in" value={c.url || ""} placeholder="source url (optional)"
                      onChange={(e) => onChange(updateCard(file, c.id, { url: e.target.value }))}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </>
                ) : (
                  <>
                    <div className="bc-title">{c.title || <i>untitled</i>}</div>
                    {c.body && <div className="bc-body">{c.body}</div>}
                  </>
                )}

                {sig && (
                  <button
                    className="bc-ref" onClick={(e) => { e.stopPropagation(); onSelectSignal(sig.id); }}
                    title="open this node's evidence"
                  >
                    on the graph · {sig.platform} · {(sig.tier || "").toUpperCase() || sig.status}
                  </button>
                )}
                {c.ref && !sig && <div className="bc-ref gone">the node it was pinned from is no longer on the graph</div>}
                {c.produced?.length ? <div className="bc-ref">produced {c.produced.length} graph node(s)</div> : null}

                {t && <div className={"bc-tally" + (t.contradicts ? " conflict" : "")}>{t.verdict}</div>}

                <div className="bc-actions">
                  <button
                    disabled={!corr.ok || busyCardId === c.id}
                    title={corr.ok ? "run a full scan from this identifier and link what it finds to this card" : corr.reason}
                    onClick={(e) => { e.stopPropagation(); onInvestigate(c); }}
                  >{busyCardId === c.id ? "working…" : "Investigate"}</button>
                  <button
                    disabled={!corr.ok || busyCardId === c.id}
                    title={corr.ok ? "correlate this identifier against the current graph, without a new scan" : corr.reason}
                    onClick={(e) => { e.stopPropagation(); onCorrelate(c); }}
                  >Correlate</button>
                  <button className={linkFrom === c.id ? "on" : ""} onClick={(e) => { e.stopPropagation(); setLinkFrom(linkFrom === c.id ? null : c.id); }}>Link</button>
                  {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open</a>}
                  <button className="bc-del" onClick={(e) => { e.stopPropagation(); onChange(removeCard(file, c.id)); }}>Remove</button>
                </div>
              </div>
            );
          })}
          <svg className="blinks">
            {file.links.map((l) => {
              const a = anchor(l.from), b = anchor(l.to);
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              const label = LINK_KINDS.find((k) => k.id === l.kind)?.label;
              return (
                <g key={l.id} className={"bl bl-" + l.kind + (editLink === l.id ? " on" : "")}>
                  <path d={`M${a.x},${a.y} L${b.x},${b.y}`} />
                  {/* a fat invisible path gives the hairline a real hit area — a 1px
                      line you have to hit exactly is a line you cannot edit */}
                  <path
                    className="bl-hit" data-ui="link" d={`M${a.x},${a.y} L${b.x},${b.y}`}
                    onClick={(e) => { e.stopPropagation(); setEditLink(editLink === l.id ? null : l.id); }}
                  />
                  <text x={mx} y={my - 5} textAnchor="middle" data-ui="link"
                    onClick={(e) => { e.stopPropagation(); setEditLink(editLink === l.id ? null : l.id); }}
                  >{label}</text>
                  {editLink === l.id && (
                    <g className="bl-tools" transform={`translate(${mx}, ${my + 12})`}>
                      <text x={-22} y={0} textAnchor="middle" className="bl-retype" data-ui="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          const order = LINK_KINDS.map((k) => k.id);
                          onChange(linkCards(file, l.from, l.to, order[(order.indexOf(l.kind) + 1) % order.length]));
                        }}>retype</text>
                      <text x={22} y={0} textAnchor="middle" className="bl-del" data-ui="link"
                        onClick={(e) => { e.stopPropagation(); onChange(removeLink(file, l.id)); setEditLink(null); }}>remove</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

        </div>

        {pendingLink && (
          <div className="bl-picker" onClick={(e) => e.stopPropagation()}>
            <div className="pop-head">what does this link mean?</div>
            {LINK_KINDS.map((k) => (
              <button key={k.id} className="menu-item" onClick={() => commitLink(k.id)}>
                <b>{k.label}</b>
                <span>
                  {k.id === "supports" ? "the target backs this claim" :
                   k.id === "contradicts" ? "the target argues against it — say so, it is how a theory dies" :
                   k.id === "leads-to" ? "following this got you there" :
                   k.id === "same-as" ? "the same entity under another name" : "connected, without claiming how"}
                </span>
              </button>
            ))}
            <button className="menu-item" onClick={() => setPendingLink(null)}><b>Cancel</b></button>
          </div>
        )}
      </div>

      {file.links.length > 0 && (
        <div className="blist">
          {file.links.map((l) => {
            const a = cardById.get(l.from), b = cardById.get(l.to);
            if (!a || !b) return null;
            return (
              <span key={l.id} className={"blist-chip bl-" + l.kind}>
                {a.title || "untitled"} <em>{LINK_KINDS.find((k) => k.id === l.kind)?.label}</em> {b.title || "untitled"}
                <button onClick={() => onChange(removeLink(file, l.id))} aria-label="remove link">✕</button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
