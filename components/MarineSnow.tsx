"use client";

// Marine snow — the drift of organic matter falling through the water column.
//
// This replaces the neural field on the landing, because the reference asks for the
// depth metaphor and the two cannot share a page: both are hairline line-work on a void
// ground, and stacked they read as noise rather than as either thing.
//
// It is not a particle library. Two behaviours make it snow rather than confetti:
// terminal velocity varies with the grain's size, so the near flakes fall faster than
// the far ones and the field has depth; and a slow horizontal current pushes everything
// sideways, reversing over minutes, so the fall is never a vertical rain.
//
// It also carries the page's own state: as you descend, the flakes thin out and dim —
// there is less falling matter and less light at 3900 m than at the surface, and the
// canvas reads --depth to know where it is.

import { useEffect, useRef } from "react";

interface Flake {
  x: number; y: number;
  /** 0 (far) → 1 (near): drives size, speed and opacity together */
  z: number;
  r: number;
  vy: number;
  /** phase of this grain's own sway, so they do not move in lockstep */
  sway: number;
  /** a few grains are accent-coloured — findings, not detritus */
  lit: boolean;
}

export default function MarineSnow() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0, raf = 0, t = 0;

    let root = getComputedStyle(document.documentElement);
    let cache: Record<string, string> = {};
    const cssv = (n: string) => (cache[n] ??= root.getPropertyValue(n).trim());
    const obs = new MutationObserver(() => { cache = {}; root = getComputedStyle(document.documentElement); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let flakes: Flake[] = [];

    function build() {
      // density by area, capped: a 4K screen must not get four times the work
      const n = Math.min(340, Math.round((W * H) / 7000));
      flakes = Array.from({ length: n }, () => spawn(Math.random() * H));
    }

    function spawn(y: number): Flake {
      const z = Math.pow(Math.random(), 1.6);       // most grains far, a few near
      return {
        x: Math.random() * W,
        y,
        z,
        r: 0.5 + z * 1.9,
        // terminal velocity rises with size — this is what gives the field depth
        vy: 0.12 + z * 0.55,
        sway: Math.random() * Math.PI * 2,
        lit: Math.random() < 0.06,
      };
    }

    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      cv.width = W * DPR; cv.height = H * DPR;
      cv.style.width = W + "px"; cv.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      build();
    }

    function frame() {
      t += 1;
      // a slow current that reverses over minutes, so the fall is never vertical rain
      const current = Math.sin(t * 0.0016) * 0.28;
      const depth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--depth")) || 0;
      // less matter and less light the deeper you are
      const visible = 1 - depth * 0.55;

      ctx.clearRect(0, 0, W, H);
      const accent = cssv("--accent") || "#FF8A3D";
      const ink = cssv("--ink-3") || "#5F7476";

      for (const f of flakes) {
        f.y += f.vy;
        f.sway += 0.006 + f.z * 0.004;
        f.x += current * f.z + Math.sin(f.sway) * 0.14;
        if (f.y - f.r > H) Object.assign(f, spawn(-f.r * 2));
        if (f.x < -8) f.x = W + 8;
        else if (f.x > W + 8) f.x = -8;

        ctx.globalAlpha = (0.1 + f.z * 0.42) * visible;
        ctx.fillStyle = f.lit ? accent : ink;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resize();
    if (still) {
      // draw the water column once and leave it: falling matter IS the animation
      const accent = cssv("--accent") || "#FF8A3D", ink = cssv("--ink-3") || "#5F7476";
      for (const f of flakes) {
        ctx.globalAlpha = 0.1 + f.z * 0.42;
        ctx.fillStyle = f.lit ? accent : ink;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      frame();
    }

    // a backgrounded tab must not keep integrating
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) raf = requestAnimationFrame(frame);
    };
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      obs.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="snow" aria-hidden="true" />;
}
