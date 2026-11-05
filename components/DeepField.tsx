"use client";

// An animal searching dark water, and the fact that it feels you move through it.
//
// WHAT WAS WRONG WITH THE LAST ONE. It had a scanning laser, rings that bloomed where
// you clicked, and a mechanic where an arm would lock onto a record, "hold" it for
// seven hundred milliseconds and score it. Those are game feedback: they reward the
// visitor for touching the screen. Nothing here is a reward, and a product about
// breach data that plays with you is telling the visitor the wrong thing about itself.
// It also had a ringed eye with a pupil, which is the one mark that turns an animal
// into a mascot.
//
// All four are gone. What is left is an animal working, which is the only thing the
// picture ever needed to say.
//
// THE ARMS ARE ACTUAL GEOMETRY NOW, not a sine wave pretending. Each is a chain of
// twenty segments, and what is stored is the ANGLE of each one rather than its
// position — so the shape of an arm is twenty numbers, and bending it is arithmetic.
//
// It took three wrong geometries to get there, and the two failures are worth keeping
// written down, because both were plausible and both rendered the same thing.
//
// A sine wave along a straight line is a ribbon, not an arm. Solving the chain with
// FABRIK against an eased tip is correct on paper and renders eight straight spokes:
// one iteration with a hard turn limit, starting from a straight chain, contains
// nothing that can ever introduce curvature — a straight chain is a fixed point of that
// loop. And relaxing each segment toward the one before it, which is how a real whip
// propagates, is a twenty-stage low-pass filter: relax hard and the arm tracks the
// shoulder rigidly, relax gently and the wave is attenuated to nothing long before it
// reaches the tip. Straight either way.
//
// So the curvature is not a consequence of anything. It IS the state. Each segment is
// placed at a deliberate angle to the one before it — a coil that grows toward the tip,
// the way a tentacle actually curls, plus a wave traveling outward along it — and the
// chain cannot be straight because nothing ever asks it to be.
//
// HOW MUCH IT CURLS is the only control, and it carries all of the meaning. Left alone
// an arm holds a deep coil and undulates: an animal working. Attending to the pointer,
// the coil flattens — and flattening a chain of fixed length is the same thing as
// EXTENDING it, so the arm reaches out because it uncurled, not because something moved
// its tip there. When you leave, it coils back in. Nothing in the code says "reach".
//
// IT FEELS YOU RATHER THAN FOLLOWS YOU. Three things, and the third is the one that
// matters. An arm attends only to a pointer roughly in its own sector, so the far side
// of the animal carries on working whatever you do. Attention eases
// in over a second, so it reads as being noticed rather than as a cursor trail. And if
// you stop moving, attention DECAYS — it goes back to searching, because an animal that
// stares at a motionless thing forever is a cursor effect with extra steps.
//
// The water parts around you. Records within a radius of the pointer are displaced
// along their own axis, strongest at the centre, falling off square — so moving the
// mouse pushes the data aside and it closes behind you. That is the whole of the
// "it moves when I move" and it costs one distance check per record.
//
// A record resolves when an arm's last joints pass over it: it goes from hairline grey
// to the accent and fades back down. No catching, no holding, no score. Searching is
// continuous and happens everywhere at once, which is the claim the page is making.
//
// Three rules, because an effect that costs the page is not one worth having: it stops
// dead off-screen or on a hidden tab rather than throttling; it paints one still frame
// under prefers-reduced-motion and never animates; and it is decoration behind real
// markup, so a browser that runs none of it loses atmosphere and not a word.

import { useEffect, useRef } from "react";

const BONE = "232,220,206";      // the mark's arm colour, as channels — alpha varies per segment
const ACCENT = "255,138,61";
const HAIRLINE = "157,178,180";

const SEGMENTS = 20;             // enough to curl smoothly, few enough to cost nothing
const MAX_TURN = 0.17;           // radians between neighbouring segments: bend, never kink

interface Rec { x: number; y: number; w: number; v: number; dim: number; lit: number }

interface Arm {
  /** the ABSOLUTE angle of each segment. The shape of the arm is this array. */
  ang: number[];
  /** the joints, recomputed from the angles every frame — derived, never stored shape */
  pts: { x: number; y: number }[];
  seg: number;
  /** the direction this arm leaves the body in when nothing has its attention */
  slot: number;
  /** the current shoulder angle, eased — an arm does not pivot instantly */
  root: number;
  /** two incommensurate drift seeds, so the idle wander never visibly repeats */
  d1: number; d2: number;
  /** how fast this arm answers. Different per arm, or eight arms move in lockstep. */
  speed: number;
  /** which way it coils at rest, and how hard. Signed, so the eight do not all curl alike. */
  coil: number;
  /** the rate of the wave travelling out along it */
  rate: number;
  /**
   * How near this arm is, 0 far → 1 near.
   *
   * Eight arms drawn at one weight and one brightness read as eight lines on a plane.
   * An animal has arms in front of and behind its own body, and the only thing that
   * says so on a flat canvas is that the far ones are thinner, dimmer and cooler.
   */
  depth: number;
  /** 0 working → 1 attending to the pointer */
  attn: number;
  /** tip glow just after it passed over a record */
  found: number;
}

export default function DeepField({
  density = 1,
  /** where the body sits, in canvas fractions. Outside 0..1 puts it off the frame. */
  anchor = { x: -0.06, y: 0.44 },
  /** arm length as a fraction of the canvas's shorter side */
  reachScale = 0.78,
  className = "",
}: {
  density?: number;
  anchor?: { x: number; y: number };
  reachScale?: number;
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

    let recs: Rec[] = [];
    let arms: Arm[] = [];
    let w = 0, h = 0, bx = 0, by = 0, unit = 1, reach = 1;   // reach: arm length, set at build
    let raf = 0, running = false, last = 0, clock = 0;

    // The pointer, in canvas coordinates, plus how long it has been motionless —
    // attention is a function of movement, not of presence.
    const ptr = { x: 0, y: 0, on: false, idle: 9, speed: 0 };
    // how far the page has scrolled past this canvas, 0..1
    let depth = 0, depthTarget = 0;
    // a click makes the animal draw in and let go. One number, no rings.
    let flinch = 0;

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

      bx = w * anchor.x;
      by = h * anchor.y;
      unit = Math.min(w, h);
      reach = unit * reachScale;

      const count = Math.round(Math.min(560, (w * h) / 3400) * density);
      recs = Array.from({ length: count }, () => ({
        x: rand(-80, w), y: rand(0, h), w: rand(16, 58), v: rand(2.5, 9),
        dim: rand(0.09, 0.26), lit: 0,
      }));

      // The fan faces INTO the frame, away from whichever edge the body sits past, so
      // no arm is solved for a place nobody can see.
      const centre =
        anchor.y < 0 ? Math.PI / 2 :
        anchor.y > 1 ? -Math.PI / 2 :
        anchor.x < 0.5 ? 0 : Math.PI;
      const SPREAD = 2.25;                       // ~129°. At 172° the outermost two left
      // the frame before they had curled, so the animal read as five arms, not eight.
      arms = Array.from({ length: 8 }, (_, i) => {
        const slot = centre + (-SPREAD / 2 + (i / 7) * SPREAD);
        // A WIDE SPREAD OF LENGTHS, not a fan of equal spokes. Eight arms within a
        // third of each other in length is a sea anemone; an octopus has some drawn in
        // and curled and one or two reaching right across the frame, and that variety
        // is most of what makes the silhouette read as an animal rather than a burst.
        const len = reach * rand(0.42, 1.18);
        const seg = len / SEGMENTS;
        return {
          ang: Array.from({ length: SEGMENTS }, () => slot),
          pts: Array.from({ length: SEGMENTS + 1 }, () => ({ x: bx, y: by })),
          seg, slot, root: slot,
          d1: rand(0, Math.PI * 2), d2: rand(0, Math.PI * 2),
          speed: rand(0.72, 1.5),
          // alternating handedness with a random magnitude: eight arms curling the same
          // way is a flower, and the eye reads a flower as a logo rather than an animal
          coil: (i % 2 ? 1 : -1) * rand(0.55, 1.15),
          rate: rand(0.5, 0.95),
          depth: rand(0.12, 1),
          attn: 0, found: 0,
        };
      });
    }

    /**
     * The direction this arm leaves the body in when nothing has its attention.
     *
     * Two sine terms at rates that do not divide into each other, so the wander has no
     * period a viewer can learn. One term alone is a metronome.
     */
    function searching(a: Arm) {
      return a.slot
        + Math.sin(clock * 0.19 + a.d1) * 0.62
        + Math.sin(clock * 0.117 + a.d2) * 0.34;
    }

    /**
     * Lay the chain out from the shoulder, one deliberate bend at a time.
     *
     * `straight` is 0 at rest and 1 when the arm is attending: at 0 it holds a coil of
     * roughly eighty degrees that deepens toward the tip, which is where a tentacle
     * curls; at 1 the bends go to nothing and the arm is a reach.
     */
    function shape(a: Arm, straight: number, oy: number) {
      a.ang[0] = a.root;
      const coil = a.coil * (0.62 + 0.38 * Math.sin(clock * 0.23 + a.d2));
      for (let i = 1; i < SEGMENTS; i++) {
        const u = i / (SEGMENTS - 1);
        // the coil deepens along the arm; the wave travels outward and dies at the base
        // CURL IS PER JOINT, so the same total bend spread over a longer arm reads as
        // a straighter line. A long arm needs a tighter coil, not the same one.
        const bend =
          coil * (0.3 + u) * 0.21 +
          Math.sin(clock * a.rate * 2.1 - i * 0.52 + a.d1) * 0.07 * u;
        const b = bend * (1 - straight * 0.93);
        a.ang[i] = a.ang[i - 1] + (b > MAX_TURN ? MAX_TURN : b < -MAX_TURN ? -MAX_TURN : b);
      }
      let x = bx, y = by + oy;
      a.pts[0].x = x; a.pts[0].y = y;
      for (let i = 0; i < SEGMENTS; i++) {
        x += Math.cos(a.ang[i]) * a.seg;
        y += Math.sin(a.ang[i]) * a.seg;
        a.pts[i + 1].x = x; a.pts[i + 1].y = y;
      }
    }

    /**
     * Two colours and a dissolve.
     *
     * The arms were one flat bone grey from shoulder to tip, which is why they read as
     * wire rather than as an animal: nothing in a living thing is one value along its
     * whole length. The stroke warms toward the tip — bone into the accent, barely, far
     * short of orange — and the last sixth fades to nothing instead of stopping at a
     * round cap, so the tip goes into the dark rather than ending in it.
     */
    function armColor(u: number, found: number): string {
      const warm = Math.min(1, u * 0.55 + found * Math.max(0, u - 0.6) * 2.4);
      const r = Math.round(232 + (255 - 232) * warm);
      const g = Math.round(220 + (138 - 220) * warm);
      const b = Math.round(206 + (61 - 206) * warm);
      return `rgb(${r},${g},${b})`;
    }

    function drawArm(a: Arm) {
      const n = a.pts, L = n.length;
      const fade = 1 - depth * 0.85;
      if (fade <= 0.01) return;
      // near arms are thicker and brighter; far ones recede
      const near = 0.68 + a.depth * 0.32;
      const thick = Math.max(1.3, unit * 0.0068) * near;

      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      for (let i = 1; i < L; i++) {
        const u = i / (L - 1);
        // the tip dissolves rather than ending
        const tip = u > 0.84 ? Math.max(0, 1 - (u - 0.84) / 0.16) : 1;
        ctx!.beginPath();
        ctx!.moveTo(n[i - 1].x, n[i - 1].y);
        ctx!.lineTo(n[i].x, n[i].y);
        ctx!.lineWidth = Math.max(0.5, thick * (1 - u * 0.8));
        ctx!.globalAlpha = clamp((0.34 + a.attn * 0.3) * near * (1 - u * 0.22) * tip * fade, 0, 1);
        ctx!.strokeStyle = armColor(u, a.found);
        ctx!.stroke();
      }

      // Suckers, on the INNER edge. They sat on the centreline, which is where a row of
      // beads goes and not where suckers go — offsetting them perpendicular, on the side
      // the arm curls toward, is most of what makes the shape read as an arm at all.
      const side = a.coil >= 0 ? 1 : -1;
      ctx!.fillStyle = `rgb(${BONE})`;
      for (let i = 4; i < L - 2; i += 2) {
        const u = i / (L - 1);
        const ang = a.ang[Math.min(i, SEGMENTS - 1)];
        const px = -Math.sin(ang) * side, py = Math.cos(ang) * side;
        const off = thick * 0.62 * (1 - u * 0.7);
        ctx!.globalAlpha = (0.14 + a.attn * 0.1) * near * (1 - u * 0.5) * fade;
        ctx!.beginPath();
        ctx!.arc(n[i].x + px * off, n[i].y + py * off, Math.max(0.4, thick * 0.34 * (1 - u * 0.8)), 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    function paint(dt: number) {
      clock += dt;
      ptr.idle += dt;
      depth += (depthTarget - depth) * Math.min(1, dt * 3);
      flinch = Math.max(0, flinch - dt * 2.2);
      const oy = depth * h * 0.3;               // the body drops as the page leaves it
      ctx!.clearRect(0, 0, w, h);

      // THE BODY. Eight strokes meeting at a point is a starburst, and that is exactly
      // what the convergence looked like once it sat near enough the edge to be seen.
      // It is not a drawn body — an outline would be a mascot, and the thing works
      // because you never quite see the animal — it is a soft lightening of the ground
      // where the mass is, the way something large reads just under the surface.
      {
        const ey = by + oy;
        const rr = unit * 0.3;
        if (bx > -rr && bx < w + rr && ey > -rr && ey < h + rr) {
          const gl = ctx!.createRadialGradient(bx, ey, 0, bx, ey, rr);
          gl.addColorStop(0, `rgba(${BONE},${(0.052 * (1 - depth)).toFixed(4)})`);
          gl.addColorStop(0.45, `rgba(${BONE},${(0.018 * (1 - depth)).toFixed(4)})`);
          gl.addColorStop(1, `rgba(${BONE},0)`);
          ctx!.fillStyle = gl;
          ctx!.fillRect(bx - rr, ey - rr, rr * 2, rr * 2);
        }
      }

      // ---- the water, and the way it parts around the pointer --------------------
      // Displacement is a render offset, never written back: data that stayed where a
      // cursor shoved it would drift into a heap over a minute of idle hovering.
      const R = unit * 0.26;
      const fieldFade = 1 - depth * 0.75;
      for (const m of recs) {
        m.x += m.v * dt;
        if (m.x - m.w > w) { m.x = -m.w - rand(0, 90); m.y = rand(0, h); m.lit = 0; }
        if (m.lit > 0) m.lit = Math.max(0, m.lit - dt * 0.85);

        let dy = 0;
        if (ptr.on) {
          const ox = m.x + m.w / 2 - ptr.x, oyy = m.y - ptr.y;
          const d = Math.hypot(ox, oyy);
          if (d < R) {
            const f = 1 - d / R;
            dy = Math.sign(oyy || 1) * f * f * unit * 0.055;
          }
        }
        ctx!.globalAlpha = clamp(Math.min(1, m.dim + m.lit * 0.75) * fieldFade, 0, 1);
        ctx!.fillStyle = m.lit > 0.03 ? `rgb(${ACCENT})` : `rgb(${HAIRLINE})`;
        ctx!.fillRect(m.x, m.y + dy, m.w, 1);
      }
      ctx!.globalAlpha = 1;

      // ---- who is attending ------------------------------------------------------
      // An arm attends only if the pointer is in its sector and inside its reach, and
      // only the three best-placed at once. The rest keep working, which is the whole
      // difference between an animal noticing you and a cursor trail.
      let rank: number[] = [];
      if (ptr.on) {
        const toPtr = Math.atan2(ptr.y - (by + oy), ptr.x - bx);
        const dist = Math.hypot(ptr.x - bx, ptr.y - (by + oy));
        // Nearness is measured against the FRAME, not against the arm's reach. Scoring
        // it against reach meant that once the body was pushed properly off-screen,
        // most of the canvas sat outside every arm's range and the animal never noticed
        // the pointer at all — on a page whose whole effect is that it notices you. An
        // animal watches things it cannot touch; reaching is a separate question, and
        // the arm answers it by straightening as far as it goes.
        const near = clamp(1 - dist / (Math.hypot(w, h) * 0.92), 0.18, 1);
        rank = arms
          .map((a, i) => {
            const align = 1 - Math.abs(wrap(a.slot - toPtr)) / Math.PI;
            return { i, score: align * align * near };
          })
          .filter((x) => x.score > 0.12)
          .sort((p, q) => q.score - p.score)
          .slice(0, 3)
          .map((x) => x.i);
      }
      // Interest fades when you stop moving. Full for the first second of stillness,
      // then down to a quarter — it has looked, and it has gone back to work.
      const gate = ptr.on ? clamp(1 - (ptr.idle - 1.0) / 2.2, 0.22, 1) : 0;

      // far arms first: an arm in front of another has to be drawn over it, and with
      // eight arms arriving from one point that overlap is most of the volume
      const order = arms.map((_, i) => i).sort((p, q) => arms[p].depth - arms[q].depth);
      for (const i of order) {
        const a = arms[i];
        const want = rank.includes(i) ? gate : 0;
        // in quickly, out slowly: noticing is fast, losing interest is not
        a.attn += (want - a.attn) * Math.min(1, dt * (want > a.attn ? 1.3 : 0.45));
        a.found = Math.max(0, a.found - dt * 1.6);

        // where the shoulder wants to point, and how fast it gets there
        let aim = searching(a);
        if (a.attn > 0.004) {
          const toPtr = Math.atan2(ptr.y - (by + oy), ptr.x - bx);
          aim += wrap(toPtr - aim) * a.attn;
        }
        // a click pulls every shoulder back toward its own slot and lets go — the whole
        // animal draws in for a moment. A breath, not a score.
        if (flinch > 0) aim += wrap(a.slot - aim) * flinch * 0.4;
        a.root += wrap(aim - a.root) * Math.min(1, dt * a.speed * (1 + a.attn * 2.2));

        // THE ONE CONTROL. Deeply coiled while it works; flattening — and so reaching
        // further out — while it is attending to you.
        shape(a, a.attn * 0.9, oy);

        // ---- what the arm found on its way through ------------------------------
        // The last joints only: an arm resolves records with its tip, the way it would.
        for (let j = SEGMENTS - 4; j <= SEGMENTS; j++) {
          const p = a.pts[j];
          for (const m of recs) {
            if (m.lit > 0.25) continue;
            if (p.y < m.y - 7 || p.y > m.y + 7) continue;
            if (p.x < m.x - 10 || p.x > m.x + m.w + 10) continue;
            m.lit = 1;
            a.found = 1;
          }
        }

        drawArm(a);
      }
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
    if (still) {
      // One still frame, solved a few times so the arms are curled rather than straight
      // spokes: the idea has to survive without any motion at all.
      for (const a of arms) { a.root = searching(a); shape(a, 0, 0); }
      for (const m of recs) m.lit = Math.random() < 0.12 ? 0.9 : 0;
      for (const m of recs) m.v = 0;
      paint(0);
      return;
    }
    start();

    // ---- what it reacts to ----------------------------------------------------------
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      ptr.speed = Math.hypot(x - ptr.x, y - ptr.y);
      // Below a pixel is a trackpad resting, not a hand moving. Without this floor the
      // animal stares forever at a cursor nobody is touching.
      if (ptr.speed > 1.1) ptr.idle = 0;
      ptr.x = x; ptr.y = y;
      ptr.on = x > -120 && x < r.width + 120 && y > -120 && y < r.height + 120;
    };
    const onLeave = () => { ptr.on = false; };
    const onDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      flinch = 1;
      ptr.idle = 0;
    };
    const onScroll = () => {
      const r = canvas.getBoundingClientRect();
      // 0 while the canvas owns the screen, 1 once it has gone past the top
      depthTarget = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("scroll", onScroll, { passive: true });
    const onResize = () => { build(); onScroll(); };
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
  }, [density, anchor.x, anchor.y, reachScale]);

  return <canvas className={"deepfield " + className} ref={ref} aria-hidden />;
}
