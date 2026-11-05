"use client";

// The ground this product stands on, drawn.
//
// What the tool does, in one sentence: it reaches into a mass of breached records you
// cannot see into, and pulls out the few that are genuinely about one person. The
// distinctive act is not the reaching — anybody can run a query — it is the telling
// apart.
//
// So the field is that. Records drift in the dark as faint marks, far more of them
// than you could read. Every so often a sweep passes, the way a search does, and the
// handful it touches ignite — then fall back into the dark while the rest never lit at
// all. It is the Sift illustration as weather rather than as diagram, and it means the
// background is saying the same thing as the copy instead of decorating it.
//
// Three rules, because an effect that costs the page is not an effect worth having:
//
//   IT STOPS WHEN NOBODY IS WATCHING. Off-screen or on a hidden tab, the loop is
//   cancelled outright rather than throttled — a canvas quietly burning a laptop
//   battery behind a background tab is a thing users are right to resent.
//
//   IT RESPECTS A REFUSAL. Under prefers-reduced-motion it paints one still frame,
//   already lit, and never animates. The picture still reads; it just holds.
//
//   IT NEVER DECIDES WHETHER CONTENT IS VISIBLE. Everything here is decoration behind
//   real markup, so a browser that runs none of it loses nothing but atmosphere.

import { useEffect, useRef } from "react";

interface Mark {
  x: number; y: number;
  w: number;
  /** drift speed, px/s — slower marks read as further away */
  v: number;
  /** base opacity in the dark */
  dim: number;
  /** 0..1, how lit this mark currently is */
  lit: number;
  /** marks that never light: most of them, which is the point */
  catchable: boolean;
}

export default function DeepField({ density = 1, className = "" }: { density?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    let marks: Mark[] = [];
    let w = 0, h = 0, dpr = 1;
    let raf = 0;
    let running = false;
    let last = 0;
    // the sweep: -1 when idle, otherwise its x position as a fraction of the width
    let sweep = -1;
    let nextSweep = 1.2;

    const rand = (a: number, b: number) => a + Math.random() * (b - a);

    function build() {
      const rect = canvas!.getBoundingClientRect();
      // Cap the pixel ratio: a 3x retina canvas at full window size is four times the
      // fill rate for a difference nobody can see on a 1px hairline.
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.round(Math.min(220, (w * h) / 5200) * density);
      marks = Array.from({ length: count }, () => ({
        x: rand(0, w),
        y: rand(0, h),
        w: rand(14, 46),
        v: rand(3, 11),
        dim: rand(0.05, 0.16),
        lit: 0,
        // roughly one in seven ever lights — a search that returns everything has
        // not told you anything
        catchable: Math.random() < 0.14,
      }));
    }

    function paint(dt: number) {
      ctx!.clearRect(0, 0, w, h);

      if (sweep >= 0) {
        sweep += dt * 0.55;
        if (sweep > 1.35) { sweep = -1; nextSweep = rand(2.6, 5.2); }
      } else {
        nextSweep -= dt;
        if (nextSweep <= 0) sweep = -0.1;
      }
      const sweepX = sweep >= 0 ? sweep * w : -1;

      for (const m of marks) {
        // drift right, wrap
        m.x += m.v * dt;
        if (m.x - m.w > w) { m.x = -m.w; m.y = rand(0, h); }

        // the sweep ignites what it passes over, if it is one of the few
        if (sweepX >= 0 && m.catchable && m.lit < 1) {
          const d = Math.abs(m.x - sweepX);
          if (d < 26) m.lit = 1;
        }
        if (m.lit > 0) m.lit = Math.max(0, m.lit - dt * 0.55);

        const a = m.dim + m.lit * 0.72;
        ctx!.globalAlpha = Math.min(1, a);
        // lit marks take the accent; everything else stays the cool hairline of the
        // rest of the interface, so the field uses exactly two colours like the UI
        ctx!.fillStyle = m.lit > 0.02 ? "#FF7A33" : "#9DB2B4";
        ctx!.fillRect(m.x, m.y, m.w, 1);
      }

      // the sweep itself: a single hairline, barely there
      if (sweepX >= 0) {
        const g = ctx!.createLinearGradient(sweepX - 70, 0, sweepX + 8, 0);
        g.addColorStop(0, "rgba(255,122,51,0)");
        g.addColorStop(1, "rgba(255,122,51,.16)");
        ctx!.globalAlpha = 1;
        ctx!.fillStyle = g;
        ctx!.fillRect(sweepX - 70, 0, 78, h);
      }
      ctx!.globalAlpha = 1;
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
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    build();
    if (still) {
      // one still frame, with the catches already lit, so the idea survives without motion
      for (const m of marks) m.lit = m.catchable ? 0.9 : 0;
      paint(0);
      return;
    }
    start();

    const onResize = () => { build(); };
    const onVis = () => (document.hidden ? stop() : start());
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVis);

    // and stop entirely once it has scrolled away
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
  }, [density]);

  return <canvas className={"deepfield " + className} ref={ref} aria-hidden />;
}
