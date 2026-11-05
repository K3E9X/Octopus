"use client";

// The ground this product stands on, drawn — and the thing that works it.
//
// What the tool does, in one sentence: it reaches into a mass of breached records
// nobody can see into and pulls out the few that are genuinely about one person. The
// distinctive act is not the reaching, anybody can run a query — it is the telling
// apart, and then the going and getting.
//
// So the scene has two halves. The FIELD: records drifting in the dark as hairlines,
// far more than could be read, with a sweep passing every few seconds that ignites the
// handful it catches while the rest never light at all. And the CREATURE: eight arms
// that notice what lit and go for it, one arm per catch, curling out of the dark and
// retracting with it.
//
// The arms are the mark's own geometry rather than a new idea — S-curves, stroke only,
// round caps, the same warm bone against the same single accent, with a ringed eye at
// the anchor. A logo and a background that disagree about what the animal looks like
// is two brands.
//
// Three rules, because an effect that costs the page is not an effect worth having:
//
//   IT STOPS WHEN NOBODY IS WATCHING — off-screen or on a hidden tab the loop is
//   cancelled outright, not throttled. A canvas quietly draining a battery behind a
//   background tab is a thing users are right to resent.
//
//   IT RESPECTS A REFUSAL — under prefers-reduced-motion it paints one still frame,
//   arms extended and catches lit, and never animates.
//
//   IT NEVER GATES CONTENT — everything here is decoration behind real markup, so a
//   browser that runs none of it loses atmosphere and not a word.

import { useEffect, useRef } from "react";

const BONE = "#E9D9C8";      // the mark's arm colour
const ACCENT = "#FF7A33";
const HAIRLINE = "#9DB2B4";

interface Mark {
  x: number; y: number; w: number;
  v: number;
  dim: number;
  /** 0..1, how lit this mark currently is */
  lit: number;
  /** most marks never light: that is the point */
  catchable: boolean;
  /** an arm is on its way, or holding it */
  claimed: boolean;
}

interface Arm {
  /** resting direction, radians */
  base: number;
  len: number;
  phase: number;
  freq: number;
  /** undulation amplitude at the tip */
  amp: number;
  /** what it is reaching for, if anything */
  target: Mark | null;
  /** 0 idle → 1 fully extended at the target */
  reach: number;
  /** counts down while it holds a catch */
  hold: number;
}

export default function DeepField({
  density = 1,
  anchor = { x: 0.06, y: 0.64 },
  className = "",
}: {
  density?: number;
  /** where the creature sits, as a fraction of the canvas */
  anchor?: { x: number; y: number };
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

    let marks: Mark[] = [];
    let arms: Arm[] = [];
    let w = 0, h = 0, ax = 0, ay = 0, scale = 1;
    let raf = 0, running = false, last = 0, clock = 0;
    let sweep = -1, nextSweep = 1.1;

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

      ax = w * anchor.x;
      ay = h * anchor.y;
      scale = Math.min(1.35, Math.max(0.6, Math.min(w, h) / 620));

      const count = Math.round(Math.min(210, (w * h) / 5400) * density);
      marks = Array.from({ length: count }, () => ({
        x: rand(0, w), y: rand(0, h), w: rand(14, 46), v: rand(3, 11),
        dim: rand(0.05, 0.16), lit: 0,
        // roughly one in seven: a search that returns everything has told you nothing
        catchable: Math.random() < 0.14,
        claimed: false,
      }));

      // Eight arms, fanned AWAY from the edge the creature sits against. A fan that
      // points off-canvas is seven arms nobody will ever see.
      // Spread across a wide arc, the way the mark draws them — a narrow fan reads as
      // a sea anemone, not an animal with eight arms. The arc faces away from whatever
      // edge the creature sits against, so none of it points off-canvas.
      const facing = anchor.x > 0.5 ? Math.PI : 0;
      const tilt = anchor.y < 0.45 ? 0.42 : -0.34;   // lean into the open space, not the copy
      const SPREAD = 2.95;                            // ~170°, as in the logo
      arms = Array.from({ length: 8 }, (_, i) => {
        const fanned = -SPREAD / 2 + (i / 7) * SPREAD;
        return {
          base: facing + tilt + fanned * (facing ? -1 : 1),
          len: rand(250, 430) * scale,
          phase: rand(0, Math.PI * 2),
          // ONE clear S-bend per arm rather than a ripple: the mark's arms are a single
          // curve out and back, and a higher frequency just reads as noise at this size
          freq: rand(0.5, 0.8),
          amp: rand(0.34, 0.55),
          target: null, reach: 0, hold: 0,
        };
      });
    }

    /** The arm's spine: a curve that undulates more towards the tip. */
    function spine(a: Arm, t: number): { x: number; y: number }[] {
      const pts: { x: number; y: number }[] = [];
      const N = 22;
      let dir = a.base;
      let tx = ax, ty = ay;

      // when reaching, bend the whole arm towards the target
      let aim = a.base;
      let len = a.len;
      if (a.target) {
        aim = Math.atan2(a.target.y - ay, a.target.x - ax);
        len = Math.max(a.len, Math.hypot(a.target.x - ax, a.target.y - ay) + 10);
      }

      for (let i = 0; i <= N; i++) {
        const u = i / N;
        // the undulation dies out as the arm commits to a target
        const wobble = Math.sin(u * a.freq * Math.PI * 2 + t * 1.5 + a.phase) * a.amp * u * (1 - a.reach * 0.75);
        dir = a.base * (1 - a.reach) + aim * a.reach + wobble;
        const step = (len * (0.45 + 0.55 * a.reach)) / N;
        tx += Math.cos(dir) * step;
        ty += Math.sin(dir) * step;
        pts.push({ x: tx, y: ty });
      }
      return pts;
    }

    function drawArm(a: Arm, t: number) {
      const pts = spine(a, t);
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      // tapered: drawn as segments with a shrinking width, the way the mark's strokes
      // thin towards the tips
      for (let i = 1; i < pts.length; i++) {
        const u = i / pts.length;
        ctx!.beginPath();
        ctx!.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx!.lineTo(pts[i].x, pts[i].y);
        ctx!.lineWidth = Math.max(0.6, (2.4 - u * 1.8) * scale);
        ctx!.globalAlpha = (0.34 + a.reach * 0.42) * (1 - u * 0.45);
        ctx!.strokeStyle = a.hold > 0 && u > 0.78 ? ACCENT : BONE;
        ctx!.stroke();
      }
      // suckers — what makes it read as an arm rather than a tendril
      ctx!.globalAlpha = 0.2 + a.reach * 0.3;
      ctx!.fillStyle = BONE;
      for (let i = 4; i < pts.length - 1; i += 3) {
        const u = i / pts.length;
        ctx!.beginPath();
        ctx!.arc(pts[i].x, pts[i].y, Math.max(0.5, (1.5 - u) * scale), 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    function paint(dt: number) {
      clock += dt;
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

        ctx!.globalAlpha = Math.min(1, m.dim + m.lit * 0.72);
        ctx!.fillStyle = m.lit > 0.02 ? ACCENT : HAIRLINE;
        ctx!.fillRect(m.x, m.y, m.w, 1);
      }
      ctx!.globalAlpha = 1;

      // --- the arms go and get what lit ---
      for (const a of arms) {
        if (!a.target) {
          // the nearest unclaimed catch, if it is within reach
          let best: Mark | null = null, bestD = Infinity;
          for (const m of marks) {
            if (!m.catchable || m.lit < 0.5 || m.claimed) continue;
            const d = Math.hypot(m.x - ax, m.y - ay);
            if (d < a.len * 1.5 && d < bestD) { best = m; bestD = d; }
          }
          if (best) { a.target = best; best.claimed = true; }
        }

        if (a.target) {
          a.reach = Math.min(1, a.reach + dt * 1.5);
          if (a.reach >= 1 && a.hold === 0) a.hold = 0.75;
          if (a.hold > 0) {
            a.hold -= dt;
            a.target.lit = 1;              // held bright while the arm has it
            if (a.hold <= 0) {
              a.target.claimed = false;
              a.target = null;
            }
          }
        } else if (a.reach > 0) {
          a.reach = Math.max(0, a.reach - dt * 0.9);
        }
        drawArm(a, clock);
      }

      // --- the eye, exactly as the mark draws it ---
      ctx!.globalAlpha = 0.75;
      ctx!.strokeStyle = ACCENT;
      ctx!.lineWidth = 1.2 * scale;
      ctx!.beginPath();
      ctx!.arc(ax, ay, 9 * scale, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.globalAlpha = 0.95;
      ctx!.fillStyle = ACCENT;
      ctx!.beginPath();
      ctx!.arc(ax, ay, 3.4 * scale, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.globalAlpha = 1;

      // --- the sweep itself: one hairline, barely there ---
      if (sweepX >= 0) {
        const g = ctx!.createLinearGradient(sweepX - 70, 0, sweepX + 8, 0);
        g.addColorStop(0, "rgba(255,122,51,0)");
        g.addColorStop(1, "rgba(255,122,51,.14)");
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
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }

    build();
    if (still) {
      // one still frame: arms out, catches lit, so the idea survives without motion
      for (const m of marks) m.lit = m.catchable ? 0.9 : 0;
      for (const a of arms) a.reach = 0.45;
      paint(0);
      return;
    }
    start();

    const onResize = () => build();
    const onVis = () => (document.hidden ? stop() : start());
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((e) => (e.some((x) => x.isIntersecting) ? start() : stop()), { threshold: 0 })
      : null;
    io?.observe(canvas);

    return () => {
      stop();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, [density, anchor.x, anchor.y]);

  return <canvas className={"deepfield " + className} ref={ref} aria-hidden />;
}
