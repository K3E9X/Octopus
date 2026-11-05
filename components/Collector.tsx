"use client";

// Eight arms, reaching out into the dark and bringing back sources.
//
// WHAT THIS REPLACES, AND WHY. The last version drew an actual octopus: tapering arms
// with a coil, suckers on the inner edge, a soft body under the surface. It was a good
// drawing of an animal and the wrong picture for this product. Tentacles curling in
// dark water is an aquarium. Nobody looking at it learned anything about what the tool
// does, and a company whose whole argument is precision should not open with something
// soft and biological.
//
// The metaphor was never the animal. It is the COLLECTING: one thing with eight arms
// that reaches in several directions at once and pulls back what it finds. So that is
// what this draws, in the interface's own language rather than nature's. A hairline
// reaches out, closes on a source, and brings it back. No curl, no suckers, nothing
// organic. Straight lines, square tips, monospace labels, the same chips the rest of
// the product uses.
//
// THE SOURCES ARE NAMED, AND THE NAMES ARE INVENTED. They are the same fictional dumps
// the demo report below is built from, so the hero and the demo are about one thing.
// Real company logos are not here for two reasons, and the second is the one that
// matters: we have no licence to anybody's trademark, and more importantly the product
// deliberately refuses to claim "this person has an account at X". Lighting up a wall
// of real brands in the hero would be the product asserting, as decoration, exactly the
// thing it refuses to assert in a report.
//
// IT STILL NOTICES YOU. An arm picks the source nearest the pointer, within its own
// sector, so moving the mouse is what decides where it reaches next. The records part
// around the cursor and close behind it. Those were the two things worth keeping.
//
// Three rules, because an effect that costs the page is not one worth having: it stops
// dead off-screen or on a hidden tab rather than throttling; it paints one still frame
// under prefers-reduced-motion and never animates; and it is decoration behind real
// markup, so a browser that runs none of it loses atmosphere and not a word.

import { useEffect, useRef } from "react";

const BONE = "232,220,206";
const ACCENT = "255,138,61";
const HAIRLINE = "157,178,180";

/**
 * The sources an arm can bring back.
 *
 * Invented, and the same ones lib/demo.ts builds the demo report from. The aggregated
 * lists are in the mix on purpose: half of what a breach index returns is a combolist
 * assembled from other people's dumps, and that is a fact about this category that the
 * product states everywhere else.
 */
const SOURCES = [
  "Vectra Fitness", "Pixelhub", "Nordeste Retail", "Collection #2", "Kurowave",
  "Lumenbox", "Bricolink", "Tideway", "Olmavia", "Papernest", "Fernwell",
  "Sablier", "Zenith Rail", "Quickstand", "Combolist v4", "Hollowmark",
  "Cartolune", "Vespira", "Peyrat Group", "Nubra",
];

interface Rec { x: number; y: number; w: number; v: number; dim: number; lit: number }

interface Source {
  x: number; y: number;
  vx: number; vy: number;
  label: string;
  /** measured once, so the box is not re-measured every frame */
  w: number;
  /** an arm is on its way, so nothing else goes for it */
  taken: boolean;
  /** an arm has actually closed on it: the only moment it lights up */
  grab: boolean;
  /** 0 out in the field, 1 arrived at the body */
  home: number;
}

type Phase = "wait" | "reach" | "close" | "haul";

interface Arm {
  /** the direction it leaves the body in */
  slot: number;
  target: Source | null;
  phase: Phase;
  /** 0 retracted, 1 fully extended */
  t: number;
  /** seconds left in the current phase */
  timer: number;
  /** how fast this arm works, so eight arms never move together */
  speed: number;
  /** where the tip was when the haul started */
  from: { x: number; y: number };
}

export default function Collector({
  density = 1,
  /** where the body sits, in canvas fractions. Outside 0..1 puts it off the frame. */
  anchor = { x: -0.06, y: 0.5 },
  /** how far an arm can reach, as a fraction of the canvas's shorter side */
  reachScale = 1,
  /**
   * Where the page's own type sits, in canvas fractions: no source will land on it.
   *
   * A prop rather than a constant because the two pages that use this put their words
   * in different places. The landing is a centred column; the sign-in panel has its
   * claim in the bottom-left. A keep-out zone hard-coded to the middle is correct on
   * one of them and drops labels across the headline of the other.
   */
  clear = { x: 0.5, y: 0.52, rx: 0.29, ry: 0.44 },
  className = "",
}: {
  density?: number;
  anchor?: { x: number; y: number };
  reachScale?: number;
  clear?: { x: number; y: number; rx: number; ry: number };
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
    const wrap = (d: number) => {
      d %= Math.PI * 2;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    };
    /** ease-out: an arm leaves fast and arrives gently, which is what reaching looks like */
    const out = (t: number) => 1 - Math.pow(1 - t, 3);

    const FONT = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';

    let recs: Rec[] = [];
    let items: Source[] = [];
    let arms: Arm[] = [];
    let w = 0, h = 0, bx = 0, by = 0, unit = 1, reach = 1;
    /** the fan the arms work in: sources are seeded inside it, not across the whole frame */
    let fanCentre = 0, fanSpread = 2.5;
    let raf = 0, running = false, last = 0;

    const ptr = { x: 0, y: 0, on: false, idle: 9 };
    let sink = 0, sinkTarget = 0;

    /**
     * Where a source appears.
     *
     * INSIDE THE REACH, which is the whole of it. The first version scattered them
     * evenly across the frame while the body sat past the left edge, so all but one
     * were further away than any arm could go: seven of the eight arms had nothing to
     * pick and the page rendered no arms at all. A thing that collects has to be given
     * something within collecting distance.
     */
    /**
     * The middle of the frame belongs to the headline.
     *
     * The CSS mask already fades the canvas there, which is enough for hairlines and
     * not for a boxed label: a dimmed chip sitting across a word is still a box across
     * a word. Sources keep out of it entirely.
     */
    function overType(x: number, y: number): boolean {
      // the whole block of type, not just the headline: the paragraph, the button and
      // whatever sits under them are all words, and a label landing on any of them is
      // the same mistake
      const dx = (x - w * clear.x) / (w * clear.rx);
      const dy = (y - h * clear.y) / (h * clear.ry);
      return dx * dx + dy * dy < 1;
    }

    function place(s: Source) {
      for (let tries = 0; tries < 40; tries++) {
        const ang = fanCentre + (Math.random() - 0.5) * fanSpread * 1.1;
        const d = rand(reach * 0.34, reach * 0.9);
        const x = bx + Math.cos(ang) * d;
        const y = by + Math.sin(ang) * d;
        if (x < 70 || x > w - 70 || y < 34 || y > h - 34 || overType(x, y)) continue;
        // and clear of the others: two labels on top of each other is one unreadable
        // label, and the pair of them reads as a rendering fault rather than a crowd
        let clash = false;
        for (const o of items) {
          if (o === s) continue;
          if (Math.abs(o.x - x) < (o.w + s.w) / 2 + 26 && Math.abs(o.y - y) < 30) { clash = true; break; }
        }
        if (clash) continue;
        s.x = x; s.y = y; return;
      }
      // last resort: along the bottom, where nothing is ever set
      s.x = clamp(bx + reach * 0.45, 80, w - 80);
      s.y = h - rand(40, 110);
    }

    function build() {
      const rect = canvas!.getBoundingClientRect();
      // Cap the pixel ratio: a 3x canvas is four times the fill rate for a difference
      // nobody can see on a 1px hairline.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.font = FONT;

      bx = w * anchor.x;
      by = h * anchor.y;
      unit = Math.min(w, h);
      reach = unit * reachScale;

      // The fan faces INTO the frame, away from whichever edge the body sits past.
      fanCentre =
        anchor.y < 0 ? Math.PI / 2 :
        anchor.y > 1 ? -Math.PI / 2 :
        anchor.x < 0.5 ? 0 : Math.PI;
      arms = Array.from({ length: 8 }, (_, i) => ({
        slot: fanCentre + (-fanSpread / 2 + (i / 7) * fanSpread),
        target: null, phase: "wait" as Phase, t: 0,
        // staggered, but all within the first second: an eight-armed thing that
        // does nothing for two seconds has not introduced itself
        timer: (i / 8) * 0.7 + rand(0, 0.18), speed: rand(0.8, 1.5),
        from: { x: bx, y: by },
      }));

      const count = Math.round(Math.min(560, (w * h) / 3400) * density);
      recs = Array.from({ length: count }, () => ({
        x: rand(-80, w), y: rand(0, h), w: rand(16, 58), v: rand(2.5, 9),
        dim: rand(0.09, 0.26), lit: 0,
      }));

      // Enough that the field looks inhabited, few enough that it is not a word cloud.
      const n = clamp(Math.round((w * h) / 150000), 6, 13);
      const pool = [...SOURCES].sort(() => Math.random() - 0.5);
      items = Array.from({ length: n }, (_, i) => {
        const label = pool[i % pool.length];
        const s: Source = {
          x: 0, y: 0, vx: rand(2, 7), vy: rand(-0.5, 0.5),
          label, w: ctx!.measureText(label).width,
          taken: false, grab: false, home: 0,
        };
        place(s);
        return s;
      });
    }

    /**
     * Put the arms mid-work before the first frame is drawn.
     *
     * Everything here is a state machine, so its opening state is an empty frame: eight
     * arms retracted, nothing held, nothing to look at until a second has passed. On a
     * slow connection, or for somebody who glances at the page and scrolls, that second
     * is the whole impression. It opens part-way through instead, with arms out and one
     * source already closed on, and the animation carries on from there.
     *
     * It is also the only reason a screenshot of this page shows anything: a headless
     * browser composites a frame or two before it captures, which is plenty for a
     * drawing that depends only on the clock and nowhere near enough for one that has
     * to accumulate.
     */
    function openOn() {
      const free = items.filter((s) => !s.taken);
      arms.forEach((a, i) => {
        if (i >= 5) return;
        const pick = free[i];
        if (!pick) return;
        pick.taken = true;
        a.target = pick;
        a.phase = i === 0 ? "close" : "reach";
        a.t = i === 0 ? 1 : 0.42 + i * 0.14;
        a.timer = i === 0 ? 0.35 : 0;
        if (i === 0) pick.grab = true;
      });
    }

    /**
     * What this arm goes for next.
     *
     * Its own sector first, so eight arms do not all converge on one corner, and then
     * whichever source is nearest the POINTER. That is the whole of the interaction:
     * where you put the cursor is where the next arm goes.
     */
    function choose(a: Arm, oy: number): Source | null {
      let best: Source | null = null, bestScore = -Infinity;
      for (const s of items) {
        if (s.taken || s.home > 0) continue;
        const ang = Math.atan2(s.y - (by + oy), s.x - bx);
        const align = 1 - Math.abs(wrap(ang - a.slot)) / Math.PI;
        if (align < 0.42) continue;
        const d = Math.hypot(s.x - bx, s.y - (by + oy));
        if (d > reach) continue;
        const near = ptr.on ? 1 - Math.min(1, Math.hypot(s.x - ptr.x, s.y - ptr.y) / (unit * 0.75)) : 0;
        const score = align * 1.1 + near * 1.6 - (d / reach) * 0.5;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return best;
    }

    function drawChip(s: Source, held: boolean, fade: number) {
      const padX = 7, padY = 5, bw = s.w + padX * 2, bh = 11 + padY * 2;
      const x = s.x - bw / 2, y = s.y - bh / 2;
      const a = (held ? 1 : 0.62) * fade * (1 - s.home * 0.85);
      if (a <= 0.01) return;

      ctx!.globalAlpha = a * (held ? 0.1 : 0.055);
      ctx!.fillStyle = `rgb(${BONE})`;
      ctx!.fillRect(x, y, bw, bh);

      ctx!.globalAlpha = a * (held ? 0.9 : 0.3);
      ctx!.strokeStyle = held ? `rgb(${ACCENT})` : `rgb(${BONE})`;
      ctx!.lineWidth = 1;
      ctx!.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(bw), Math.round(bh));

      ctx!.globalAlpha = a * (held ? 1 : 0.72);
      ctx!.fillStyle = held ? `rgb(${ACCENT})` : `rgb(${BONE})`;
      ctx!.textBaseline = "middle";
      ctx!.fillText(s.label, x + padX, s.y + 0.5);

      // corner brackets while an arm has hold of it: the one moment of emphasis
      if (held) {
        const k = 5;
        ctx!.globalAlpha = a;
        ctx!.beginPath();
        ctx!.moveTo(x - 3, y + k); ctx!.lineTo(x - 3, y - 3); ctx!.lineTo(x + k, y - 3);
        ctx!.moveTo(x + bw - k, y + bh + 3); ctx!.lineTo(x + bw + 3, y + bh + 3); ctx!.lineTo(x + bw + 3, y + bh - k);
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;
    }

    function paint(dt: number) {
      sink += (sinkTarget - sink) * Math.min(1, dt * 3);
      const oy = sink * h * 0.3;
      const fade = 1 - sink * 0.85;
      ptr.idle += dt;
      ctx!.clearRect(0, 0, w, h);
      ctx!.font = FONT;

      // ---- the water, and the way it parts around the pointer ----------------------
      // Displacement is a render offset, never written back: data that stayed where a
      // cursor shoved it would drift into a heap over a minute of idle hovering.
      const R = unit * 0.26;
      for (const m of recs) {
        m.x += m.v * dt;
        if (m.x - m.w > w) { m.x = -m.w - rand(0, 90); m.y = rand(0, h); m.lit = 0; }
        if (m.lit > 0) m.lit = Math.max(0, m.lit - dt * 0.8);
        let dy = 0;
        if (ptr.on) {
          const ox = m.x + m.w / 2 - ptr.x, oyy = m.y - ptr.y;
          const d = Math.hypot(ox, oyy);
          if (d < R) {
            const f = 1 - d / R;
            dy = Math.sign(oyy || 1) * f * f * unit * 0.055;
          }
        }
        ctx!.globalAlpha = clamp(Math.min(1, m.dim + m.lit * 0.75) * fade, 0, 1);
        ctx!.fillStyle = m.lit > 0.03 ? `rgb(${ACCENT})` : `rgb(${HAIRLINE})`;
        ctx!.fillRect(m.x, m.y + dy, m.w, 1);
      }
      ctx!.globalAlpha = 1;

      // ---- the sources drift until something comes for them -------------------------
      for (const s of items) {
        if (!s.taken) {
          s.x += s.vx * dt; s.y += s.vy * dt;
          // drifting out of reach is how a source leaves: the field keeps moving, and
          // what the arms can get to keeps changing
          const d = Math.hypot(s.x - bx, s.y - (by + oy));
          if (d > reach * 0.96 || s.x - s.w > w + 30 || s.y < -30 || s.y > h + 30 || overType(s.x, s.y)) place(s);
        }
      }

      // Drift carries two sources into each other sooner or later, and two labels on
      // top of each other reads as a rendering fault rather than a crowd. One pass,
      // nine items, thirty-six pairs: cheaper than thinking about it.
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          if (a.taken || b.taken) continue;
          const minX = (a.w + b.w) / 2 + 24;
          const dxs = b.x - a.x, dys = b.y - a.y;
          if (Math.abs(dxs) > minX || Math.abs(dys) > 28) continue;
          const push = (28 - Math.abs(dys)) * 0.5 * Math.sign(dys || 1);
          a.y -= push; b.y += push;
        }
      }

      // ---- the arms ------------------------------------------------------------------
      for (const a of arms) {
        a.timer -= dt;
        const oyy = by + oy;

        if (a.phase === "wait") {
          a.t = Math.max(0, a.t - dt * 2.4);
          if (a.timer <= 0) {
            const pick = choose(a, oy);
            if (pick) {
              pick.taken = true;
              a.target = pick; a.phase = "reach"; a.t = 0;
            } else {
              a.timer = rand(0.2, 0.5);
            }
          }
        } else if (a.phase === "reach") {
          a.t = Math.min(1, a.t + dt * a.speed * 0.85);
          if (a.t >= 1) { a.phase = "close"; a.timer = rand(0.3, 0.55); }
        } else if (a.phase === "close") {
          if (a.timer <= 0 && a.target) {
            a.phase = "haul";
            a.from = { x: a.target.x, y: a.target.y };
          }
        } else if (a.phase === "haul" && a.target) {
          // the source travels back along the arm and dissolves at the body
          a.target.home = Math.min(1, a.target.home + dt * a.speed * 0.95);
          a.target.x = a.from.x + (bx - a.from.x) * out(a.target.home);
          a.target.y = a.from.y + (oyy - a.from.y) * out(a.target.home);
          a.t = 1 - a.target.home;
          if (a.target.home >= 1) {
            a.target.taken = false; a.target.grab = false; a.target.home = 0;
            place(a.target);
            a.target = null; a.phase = "wait"; a.timer = rand(0.35, 1.5);
          }
        }

        if (a.target) a.target.grab = a.phase === "close" || a.phase === "haul";

        // where the tip is
        let tipX: number, tipY: number;
        if (a.target) {
          const e = a.phase === "reach" ? out(a.t) : 1;
          tipX = bx + (a.target.x - bx) * e;
          tipY = oyy + (a.target.y - oyy) * e;
        } else {
          tipX = bx + Math.cos(a.slot) * reach * 0.3 * a.t;
          tipY = oyy + Math.sin(a.slot) * reach * 0.3 * a.t;
        }

        if (a.t > 0.002 && fade > 0.01) {
          // A hairline with ONE slight bend, straightening as it extends. A dead
          // straight line is a laser and a curve is a tentacle; the point is between
          // them, which is a thing reaching.
          const mx = (bx + tipX) / 2, my = (oyy + tipY) / 2;
          const dx = tipX - bx, dy2 = tipY - oyy;
          const d = Math.hypot(dx, dy2) || 1;
          const bend = (1 - out(Math.min(1, a.t))) * d * 0.16 + d * 0.035;
          const cx = mx + (-dy2 / d) * bend, cy = my + (dx / d) * bend;

          ctx!.globalAlpha = (a.phase === "close" ? 0.5 : 0.3) * fade;
          ctx!.strokeStyle = a.phase === "close" ? `rgb(${ACCENT})` : `rgb(${BONE})`;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.moveTo(bx, oyy);
          ctx!.quadraticCurveTo(cx, cy, tipX, tipY);
          ctx!.stroke();

          // the tip: a small square, because everything else on this page that marks a
          // position is a square or a hairline and nothing is a glowing orb
          ctx!.globalAlpha = (a.phase === "close" ? 1 : 0.6) * fade;
          ctx!.fillStyle = a.phase === "close" ? `rgb(${ACCENT})` : `rgb(${BONE})`;
          ctx!.fillRect(Math.round(tipX) - 1.5, Math.round(tipY) - 1.5, 3, 3);
          ctx!.globalAlpha = 1;
        }
      }

      // chips last, so a line never crosses a label
      for (const s of items) drawChip(s, s.grab, fade);
    }

    function frame(t: number) {
      if (!running) return;
      const dt = Math.min(0.05, (t - last) / 1000 || 0);
      last = t;
      paint(dt);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      if (running || still) return;
      running = true; last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }

    build();
    openOn();
    if (still) {
      // one frame, and never another: the arms are out, one source is held, and
      // nothing moves
      for (const m of recs) { m.v = 0; m.lit = Math.random() < 0.1 ? 0.8 : 0; }
      paint(0);
      return;
    }
    start();

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (Math.hypot(x - ptr.x, y - ptr.y) > 1.1) ptr.idle = 0;
      ptr.x = x; ptr.y = y;
      ptr.on = x > -120 && x < r.width + 120 && y > -120 && y < r.height + 120;
    };
    const onLeave = () => { ptr.on = false; };
    const onDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      // a click sends the first idle arm straight at whatever is nearest the click
      let best: Source | null = null, bd = Infinity;
      for (const s of items) {
        if (s.taken) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bd) { bd = d; best = s; }
      }
      const free = arms.find((a) => a.phase === "wait");
      if (best && free) { best.taken = true; free.target = best; free.phase = "reach"; free.t = 0; }
    };
    const onScroll = () => {
      const r = canvas.getBoundingClientRect();
      sinkTarget = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("scroll", onScroll, { passive: true });
    const onResize = () => { build(); openOn(); onScroll(); };
    const onVis = () => (document.hidden ? stop() : start());
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((e) => (e.some((x) => x.isIntersecting) ? start() : stop()), { threshold: 0 })
      : null;
    io?.observe(canvas);
    onScroll();

    return () => {
      stop();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, [density, anchor.x, anchor.y, reachScale, clear.x, clear.y, clear.rx, clear.ry]);

  return <canvas className={"deepfield " + className} ref={ref} aria-hidden />;
}
