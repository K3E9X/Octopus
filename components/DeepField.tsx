"use client";

// The creature, the dark it works in, and the fact that it notices you.
//
// What the tool does, in one sentence: it reaches into a mass of breached records
// nobody can see into and pulls out the few that are genuinely about one person. The
// reaching is not the clever part — anybody can run a query. The choosing is.
//
// COMPOSITION. The body sits OFF the frame and only the arms come in. That is both the
// better picture and the better behaviour: you rarely see the whole animal, you see
// arms arriving out of the dark — and arms that enter from an edge wrap around type
// instead of sitting beside it competing for the same space. The first version was a
// small blob parked in a margin, which is where you put something you have not yet
// decided what to do with.
//
// IT NOTICES YOU. The three arms already pointing nearest the pointer lean toward it
// and ease back when it leaves — slowly, so it reads as attention rather than as a
// cursor trail, and only three so it reads as one animal rather than eight springs. A
// click is a GRASP: the best-placed arm commits to that point, flashes at the tip, and
// a ring opens where it took hold. On scroll the creature SINKS — arms dimming, body
// dropping out of frame — because you are descending past it, and because the sections
// below have their own things to say.
//
// The geometry is the mark's own rather than a second idea about the same animal: a
// wide arc of arms, one S-bend each, stroke only with round caps, tapering to the tip,
// suckers on the inner edge, warm bone against the single accent, the ringed eye.
//
// Three rules, because an effect that costs the page is not one worth having: it stops
// dead off-screen or on a hidden tab rather than throttling; it paints one still frame
// under prefers-reduced-motion and never animates; and it is decoration behind real
// markup, so a browser that runs none of it loses atmosphere and not a word.

import { useEffect, useRef } from "react";

const BONE = "#E9D9C8";      // the mark's arm colour
const ACCENT = "#FF7A33";
const HAIRLINE = "#9DB2B4";

interface Mark {
  x: number; y: number; w: number; v: number;
  dim: number; lit: number;
  catchable: boolean; claimed: boolean;
}

interface Arm {
  base: number;
  len: number;
  phase: number;
  freq: number;
  amp: number;
  /** a record it is fetching */
  target: Mark | null;
  /** 0 idle → 1 committed */
  reach: number;
  hold: number;
  /** how far this arm is leaning toward the pointer, 0..1 */
  lean: number;
  /** a click it is taking hold of, in canvas coordinates */
  grasp: { x: number; y: number } | null;
  graspT: number;
}

interface Ripple { x: number; y: number; t: number }

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
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const angleDiff = (a: number, b: number) => {
      let d = (a - b) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    };

    let marks: Mark[] = [];
    let arms: Arm[] = [];
    let ripples: Ripple[] = [];
    let w = 0, h = 0, bx = 0, by = 0, unit = 1;
    let raf = 0, running = false, last = 0, clock = 0;
    let sweep = -1, nextSweep = 1.1;

    const pointer = { x: 0, y: 0, on: false };
    // how far the page has scrolled past this canvas, 0..1 — the creature sinks with it
    let sink = 0, sinkTarget = 0;

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

      const count = Math.round(Math.min(230, (w * h) / 5200) * density);
      marks = Array.from({ length: count }, () => ({
        x: rand(0, w), y: rand(0, h), w: rand(14, 48), v: rand(3, 11),
        dim: rand(0.05, 0.16), lit: 0,
        // roughly one in seven: a search that returns everything has told you nothing
        catchable: Math.random() < 0.14,
        claimed: false,
      }));

      // The arc faces INTO the frame, away from whichever edge the body sits past, so
      // no arm is drawn where nobody can see it.
      const centre =
        anchor.y < 0 ? Math.PI / 2 :
        anchor.y > 1 ? -Math.PI / 2 :
        anchor.x < 0.5 ? 0 : Math.PI;
      const SPREAD = 2.9;                        // ~166°, the way the mark fans them
      arms = Array.from({ length: 8 }, (_, i) => ({
        base: centre + (-SPREAD / 2 + (i / 7) * SPREAD),
        len: unit * reachScale * rand(0.74, 1.14),
        phase: rand(0, Math.PI * 2),
        // ONE clear S-bend per arm: a higher frequency reads as noise at this size
        freq: rand(0.5, 0.82),
        amp: rand(0.3, 0.52),
        target: null, reach: 0, hold: 0, lean: 0, grasp: null, graspT: 0,
      }));
    }

    /** Where this arm is trying to point, and how hard. A click outranks a catch, a catch outranks attention. */
    function intent(a: Arm, oy: number): { aim: number; weight: number; dist: number } {
      const from = (tx: number, ty: number, weight: number) => ({
        aim: Math.atan2(ty - (by + oy), tx - bx),
        weight,
        dist: Math.hypot(tx - bx, ty - (by + oy)),
      });
      if (a.grasp) return from(a.grasp.x, a.grasp.y, 1);
      if (a.target) return from(a.target.x, a.target.y, a.reach);
      if (a.lean > 0.01 && pointer.on) return from(pointer.x, pointer.y, a.lean * 0.78);
      return { aim: a.base, weight: 0, dist: a.len };
    }

    function drawArm(a: Arm, t: number, oy: number) {
      const { aim, weight, dist } = intent(a, oy);
      const len = weight > 0 ? lerp(a.len, Math.max(a.len * 0.7, dist + 14), weight) : a.len;
      const N = 26;
      const pts: { x: number; y: number }[] = [];
      let tx = bx, ty = by + oy;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        // the S dies down as the arm commits — a committed arm is a straight reach
        const wobble = Math.sin(u * a.freq * Math.PI * 2 + t * 1.3 + a.phase) * a.amp * u * (1 - weight * 0.8);
        const dir = lerp(a.base, aim, weight) + wobble;
        const step = (len * (0.5 + 0.5 * weight)) / N;
        tx += Math.cos(dir) * step;
        ty += Math.sin(dir) * step;
        pts.push({ x: tx, y: ty });
      }

      const hot = a.hold > 0 || a.graspT > 0;
      const fade = 1 - sink * 0.8;
      const thick = Math.max(1.6, unit * 0.006);
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      for (let i = 1; i < pts.length; i++) {
        const u = i / pts.length;
        ctx!.beginPath();
        ctx!.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx!.lineTo(pts[i].x, pts[i].y);
        ctx!.lineWidth = Math.max(0.6, thick * (1 - u * 0.78));
        ctx!.globalAlpha = (0.3 + a.reach * 0.3 + a.lean * 0.22) * (1 - u * 0.4) * fade;
        ctx!.strokeStyle = hot && u > 0.74 ? ACCENT : BONE;
        ctx!.stroke();
      }
      // suckers — what makes it read as an arm rather than a tendril
      ctx!.globalAlpha = (0.18 + a.reach * 0.26) * fade;
      ctx!.fillStyle = BONE;
      for (let i = 5; i < pts.length - 1; i += 3) {
        const u = i / pts.length;
        ctx!.beginPath();
        ctx!.arc(pts[i].x, pts[i].y, Math.max(0.5, thick * 0.55 * (1 - u)), 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    function paint(dt: number) {
      clock += dt;
      sink += (sinkTarget - sink) * Math.min(1, dt * 3);
      const oy = sink * h * 0.32;              // the body drops as the page leaves
      ctx!.clearRect(0, 0, w, h);

      // --- the sweep ---
      if (sweep >= 0) {
        sweep += dt * 0.5;
        if (sweep > 1.4) { sweep = -1; nextSweep = rand(2.4, 4.8); }
      } else {
        nextSweep -= dt;
        if (nextSweep <= 0) sweep = -0.1;
      }
      const sweepX = sweep >= 0 ? sweep * w : -1;

      // --- the field ---
      for (const m of marks) {
        m.x += m.v * dt;
        if (m.x - m.w > w) { m.x = -m.w; m.y = rand(0, h); m.lit = 0; m.claimed = false; }
        if (sweepX >= 0 && m.catchable && m.lit < 1 && Math.abs(m.x - sweepX) < 26) m.lit = 1;
        if (m.lit > 0 && !m.claimed) m.lit = Math.max(0, m.lit - dt * 0.5);
        ctx!.globalAlpha = Math.min(1, m.dim + m.lit * 0.72) * (1 - sink * 0.7);
        ctx!.fillStyle = m.lit > 0.02 ? ACCENT : HAIRLINE;
        ctx!.fillRect(m.x, m.y, m.w, 1);
      }
      ctx!.globalAlpha = 1;

      // Only the three arms already pointing nearest the cursor lean toward it. All
      // eight would read as a cursor effect; three reads as an animal noticing.
      const toPointer = Math.atan2(pointer.y - (by + oy), pointer.x - bx);
      const leaning = new Set(
        arms.map((a, i) => ({ i, d: Math.abs(angleDiff(a.base, toPointer)) }))
          .sort((p, q) => p.d - q.d).slice(0, 3).map((x) => x.i),
      );

      arms.forEach((a, i) => {
        const want = pointer.on && leaning.has(i) && !a.target && !a.grasp ? 1 : 0;
        a.lean += (want - a.lean) * Math.min(1, dt * (want ? 2.2 : 1.4));

        if (a.grasp) {
          a.graspT -= dt;
          a.reach = Math.min(1, a.reach + dt * 4);
          if (a.graspT <= 0) a.grasp = null;
        } else if (!a.target) {
          let best: Mark | null = null, bestD = Infinity;
          for (const m of marks) {
            if (!m.catchable || m.lit < 0.5 || m.claimed) continue;
            const d = Math.hypot(m.x - bx, m.y - (by + oy));
            if (d < a.len * 1.3 && d < bestD) { best = m; bestD = d; }
          }
          if (best) { a.target = best; best.claimed = true; }
        }

        if (a.target) {
          a.reach = Math.min(1, a.reach + dt * 1.5);
          if (a.reach >= 1 && a.hold === 0) a.hold = 0.7;
          if (a.hold > 0) {
            a.hold -= dt;
            a.target.lit = 1;                   // held bright while an arm has it
            if (a.hold <= 0) { a.target.claimed = false; a.target = null; }
          }
        } else if (!a.grasp && a.reach > 0) {
          a.reach = Math.max(0, a.reach - dt * 0.9);
        }
        drawArm(a, clock, oy);
      });

      // --- rings where a click was taken hold of ---
      ripples = ripples.filter((r) => (r.t += dt) < 0.9);
      for (const r of ripples) {
        const p = r.t / 0.9;
        ctx!.globalAlpha = (1 - p) * 0.5 * (1 - sink);
        ctx!.strokeStyle = ACCENT;
        ctx!.lineWidth = 1.4;
        ctx!.beginPath();
        ctx!.arc(r.x, r.y, 6 + p * unit * 0.09, 0, Math.PI * 2);
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;

      // --- the eye, drawn only when the body is actually in frame ---
      const ey = by + oy;
      if (bx > -40 && bx < w + 40 && ey > -40 && ey < h + 40) {
        const r = Math.max(7, unit * 0.016);
        ctx!.globalAlpha = 0.7 * (1 - sink);
        ctx!.strokeStyle = ACCENT;
        ctx!.lineWidth = Math.max(1.1, r * 0.14);
        ctx!.beginPath(); ctx!.arc(bx, ey, r, 0, Math.PI * 2); ctx!.stroke();
        ctx!.globalAlpha = 0.95 * (1 - sink);
        ctx!.fillStyle = ACCENT;
        ctx!.beginPath(); ctx!.arc(bx, ey, r * 0.38, 0, Math.PI * 2); ctx!.fill();
        ctx!.globalAlpha = 1;
      }

      // --- the sweep itself: one hairline, barely there ---
      if (sweepX >= 0) {
        const g = ctx!.createLinearGradient(sweepX - 70, 0, sweepX + 8, 0);
        g.addColorStop(0, "rgba(255,122,51,0)");
        g.addColorStop(1, `rgba(255,122,51,${(0.14 * (1 - sink)).toFixed(3)})`);
        ctx!.fillStyle = g;
        ctx!.fillRect(sweepX - 70, 0, 78, h);
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
      // one still frame: arms out, catches lit, so the idea survives without motion
      for (const m of marks) m.lit = m.catchable ? 0.9 : 0;
      for (const a of arms) a.reach = 0.4;
      paint(0);
      return;
    }
    start();

    // ---- what it reacts to ----------------------------------------------------------
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.on = pointer.x > -90 && pointer.x < r.width + 90 && pointer.y > -90 && pointer.y < r.height + 90;
    };
    const onLeave = () => { pointer.on = false; };
    const onDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      // the arm already closest to that direction takes it, and one already busy
      // fetching a record is passed over rather than yanked off the job
      const aim = Math.atan2(y - by, x - bx);
      let pick = arms[0], best = Infinity;
      for (const a of arms) {
        const d = Math.abs(angleDiff(a.base, aim)) + (a.target ? 1.2 : 0);
        if (d < best) { best = d; pick = a; }
      }
      pick.grasp = { x, y };
      pick.graspT = 0.85;
      ripples.push({ x, y, t: 0 });
      if (ripples.length > 6) ripples.shift();
    };
    const onScroll = () => {
      const r = canvas.getBoundingClientRect();
      // 0 while the canvas owns the screen, 1 once it has gone past the top
      sinkTarget = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
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
