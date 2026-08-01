"use client";

// The neural field.
//
// Every landing page with "particles and lines between them" is the same library
// (particles.js, tsParticles, Vanta) with a different hue. This is not that, and the
// difference is not cosmetic: these are neurons with a membrane potential, axons with
// a propagation delay, and a refractory period. A spike travels — you can watch it
// cross the gap — it charges the neurons downstream, and they fire only when their
// potential crosses threshold. What you see is conduction, not decoration.
//
// Five things make it alive rather than looping:
//
//   ignition      the field boots silent and flat. One spike at the input propagates
//                 outward and wakes the tissue. You watch it come online once.
//   excitability  a slow plane wave sweeps the field, raising and lowering threshold
//                 as it passes. Activity arrives in bands instead of evenly, which is
//                 what separates tissue from a screensaver.
//   stimulation   the pointer is an extracellular electrode. Neurons near it
//                 depolarise and fire, so the cursor drags a wake of activity.
//   potentiation  an axon that carries traffic strengthens and stays lit, and decays
//                 when it goes quiet. Repeated use carves visible pathways — which is
//                 also, exactly, what the product does with corroborated evidence.
//   release       each arrival flashes a hairline ring at the synapse and dies.
//
// It is also wired to the product. Typing in the search injects a stimulus at the
// input, the seed type is read by the ENGINE'S OWN code (lib/seedtype), and the
// capability clusters that this seed would actually reach are the ones that light.
// A visitor watching the field is watching the dispatch they would get.
//
// Art direction unchanged: void ground, one accent, hairlines, monospace. No gradient,
// no glass, no glow soup.

import { useEffect, useRef } from "react";
import { CAPABILITIES, type SeedKind } from "@/lib/seedtype";

interface Neuron {
  x: number; y: number;          // resting position
  ox: number; oy: number;        // drift offset
  phase: number;
  /** membrane potential, 0..1 — fires at 1 */
  v: number;
  /** ticks left of refractory silence */
  refractory: number;
  /** brightness of the last spike, decays */
  glow: number;
  r: number;
  /** capability cluster this neuron belongs to, if any */
  cap?: string;
  /** true for the one neuron that heads a cluster — the others are its satellites */
  head?: boolean;
  /** the input neuron: where a typed seed enters the field */
  input?: boolean;
}

/** `w` is the synaptic weight: raised by traffic, decayed by silence. */
interface Axon { a: number; b: number; len: number; w: number }
interface Spike { axon: number; from: number; t: number; speed: number }
/** A transmission event at the far end of an axon. */
interface Flash { x: number; y: number; t: number }

interface Props {
  kind: SeedKind;
  pulse: number;
  /** Called when a capability cluster head fires, throttled. Drives the DOM sparks. */
  onCapFire?: (cap: string) => void;
}

export default function NeuralField({ kind, pulse, onCapFire }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ kind, pulse, onCapFire });
  stateRef.current = { kind, pulse, onCapFire };

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0, raf = 0, t = 0, lastPulse = -1;
    /** 0 → 1 over the ignition, then pinned at 1 */
    let boot = 0;
    let scrollY = window.scrollY || 0;
    const pointer = { x: -1e5, y: -1e5, on: false };
    const capLast: Record<string, number> = {};
    /** The tissue lags the page: a fixed canvas that never moves reads as wallpaper. */
    const parallax = () => -scrollY * 0.05;

    let root = getComputedStyle(document.documentElement);
    let cache: Record<string, string> = {};
    const cssv = (n: string) => (cache[n] ??= root.getPropertyValue(n).trim());
    const themeObs = new MutationObserver(() => { cache = {}; root = getComputedStyle(document.documentElement); });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let neurons: Neuron[] = [];
    let axons: Axon[] = [];
    let spikes: Spike[] = [];
    let flashes: Flash[] = [];
    /** axon indices touching each neuron — the per-frame scan over every axon was the
        one thing here that would not have scaled past a few hundred cells */
    let outgoing: number[][] = [];

    /**
     * Build the field. Neurons sit on a jittered ring lattice rather than at random:
     * a random cloud reads as noise, a perfect grid reads as a screensaver, and a
     * lattice with disorder reads as tissue.
     */
    function build() {
      const cx = W * 0.5, cy = H * 0.48;
      // Spread on each axis independently. A single min(W,H) radius collapses the field
      // into a narrow disc in the middle of a wide viewport — tissue, not a medallion.
      const RX = W * 0.52, RY = H * 0.52;
      const R = Math.min(W, H);
      neurons = [];

      // the input neuron: the seed enters here
      neurons.push({ x: cx, y: cy, ox: 0, oy: 0, phase: 0, v: 0, refractory: 0, glow: 0, r: 4.5, input: true });

      // capability clusters on the second ring, each a small constellation
      CAPABILITIES.forEach((c, i) => {
        const a = -Math.PI / 2 + (i / CAPABILITIES.length) * Math.PI * 2;
        const k = 0.52 + (i % 3) * 0.07;
        const hx = cx + Math.cos(a) * RX * k, hy = cy + Math.sin(a) * RY * k;
        neurons.push({ x: hx, y: hy, ox: 0, oy: 0, phase: Math.random() * 6.28, v: 0, refractory: 0, glow: 0, r: 3.2, cap: c.id, head: true });
        for (let s = 0; s < 3; s++) {
          const sa = a + (Math.random() - 0.5) * 0.7;
          const sk = k + 0.1 + Math.random() * 0.18;
          neurons.push({
            x: cx + Math.cos(sa) * RX * sk, y: cy + Math.sin(sa) * RY * sk,
            ox: 0, oy: 0, phase: Math.random() * 6.28, v: 0, refractory: 0, glow: 0, r: 1.9, cap: c.id,
          });
        }
      });

      // interneurons filling the field, so conduction has somewhere to go
      const fill = Math.round((W * H) / 15000);
      for (let i = 0; i < fill; i++) {
        const a = Math.random() * Math.PI * 2;
        const k = 0.16 + Math.pow(Math.random(), 0.6) * 0.88;
        neurons.push({
          x: cx + Math.cos(a) * RX * k, y: cy + Math.sin(a) * RY * k,
          ox: 0, oy: 0, phase: Math.random() * 6.28, v: 0, refractory: 0, glow: 0, r: 1.4,
        });
      }

      // axons: nearest neighbours, capped per neuron. Long-range connections are what
      // make it a network instead of a mesh, so a few are kept deliberately.
      axons = [];
      const maxLen = R * 0.15;
      for (let i = 0; i < neurons.length; i++) {
        const near: { j: number; d: number }[] = [];
        for (let j = 0; j < neurons.length; j++) {
          if (i === j) continue;
          const d = Math.hypot(neurons[i].x - neurons[j].x, neurons[i].y - neurons[j].y);
          if (d < maxLen) near.push({ j, d });
        }
        near.sort((p, q) => p.d - q.d);
        for (const n of near.slice(0, 3)) {
          if (i < n.j) axons.push({ a: i, b: n.j, len: n.d, w: 0 });
        }
        // one long reach per cluster head
        if (neurons[i].cap && near.length > 6) {
          const far = near[near.length - 1];
          if (i < far.j) axons.push({ a: i, b: far.j, len: far.d, w: 0 });
        }
      }

      // No orphans. A neuron outside every neighbour radius is an unconnected dot —
      // it reads as dust, and conduction can never reach it. Wire it to its nearest.
      const degree = new Uint16Array(neurons.length);
      for (const ax of axons) { degree[ax.a]++; degree[ax.b]++; }
      for (let i = 0; i < neurons.length; i++) {
        if (degree[i]) continue;
        let best = -1, bd = Infinity;
        for (let j = 0; j < neurons.length; j++) {
          if (i === j) continue;
          const d = Math.hypot(neurons[i].x - neurons[j].x, neurons[i].y - neurons[j].y);
          if (d < bd) { bd = d; best = j; }
        }
        if (best >= 0) { axons.push({ a: i, b: best, len: bd, w: 0 }); degree[i]++; degree[best]++; }
      }

      outgoing = neurons.map(() => []);
      axons.forEach((ax, k) => { outgoing[ax.a].push(k); outgoing[ax.b].push(k); });

      spikes = []; flashes = [];
    }

    function resize() {
      const rect = cv.getBoundingClientRect();
      W = rect.width; H = rect.height;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      build();
    }

    /**
     * Fire a neuron: emit a spike down every axon it owns, and potentiate those axons.
     * A pathway that keeps carrying traffic stays lit; one that goes quiet fades.
     */
    function fire(i: number) {
      const n = neurons[i];
      n.v = 0;
      n.glow = 1;
      n.refractory = 28 + Math.random() * 26;
      if (n.head && n.cap) {
        // Throttled, because a DOM class change per spike would thrash layout.
        const now = t;
        if (!capLast[n.cap] || now - capLast[n.cap] > 34) {
          capLast[n.cap] = now;
          stateRef.current.onCapFire?.(n.cap);
        }
      }
      for (const k of outgoing[i]) {
        if (spikes.length > 320) break;
        const ax = axons[k];
        ax.w = Math.min(1, ax.w + 0.14);
        spikes.push({ axon: k, from: i, t: 0, speed: 0.9 / Math.max(24, ax.len) });
      }
    }

    function step() {
      t += 1;
      if (boot < 1) boot = Math.min(1, boot + 0.012);
      const { kind: seedKind, pulse } = stateRef.current;

      // a new keystroke injects a stimulus at the input neuron
      if (pulse !== lastPulse) {
        lastPulse = pulse;
        const input = neurons.findIndex((n) => n.input);
        if (input >= 0) fire(input);
      }

      // which clusters this seed would actually reach
      const active = new Set(
        CAPABILITIES.filter((c) => seedKind !== "empty" && c.kinds.includes(seedKind)).map((c) => c.id),
      );

      // Excitability: a slow plane wave sweeping the tissue. Neurons in the crest sit
      // closer to threshold, so spontaneous activity arrives in bands. Without it the
      // field fires uniformly at random, which is precisely how a screensaver looks.
      const wk = 0.0042, wa = t * 0.011;
      const exc = (n: Neuron) => 0.5 + 0.5 * Math.sin((n.x + n.y * 0.55) * wk - wa);

      // spontaneous activity, gated by the wave. Silent until ignition has spread.
      if (boot > 0.3 && t % 9 === 0) {
        for (let s = 0; s < 3; s++) {
          const i = 1 + Math.floor(Math.random() * (neurons.length - 1));
          const n = neurons[i];
          if (n.refractory <= 0 && Math.random() < exc(n) * 0.5) fire(i);
        }
      }

      // Stimulation: the pointer is an extracellular electrode. Neurons inside its
      // field depolarise, so moving the cursor drags a wake of firing behind it.
      if (pointer.on) {
        const R = Math.min(W, H) * 0.26;
        for (let i = 0; i < neurons.length; i++) {
          const n = neurons[i];
          const d = Math.hypot(n.x + n.ox - pointer.x, n.y + n.oy - pointer.y);
          if (d > R || n.refractory > 0) continue;
          // falls off with the square of distance, as a real extracellular field does:
          // a linear ramp lights the whole disc evenly and reads as a spotlight
          const k = 1 - d / R;
          n.v += 0.16 * k * k;
          if (n.v >= 1) fire(i);
        }
      }

      // conduction
      const arrived: number[] = [];
      spikes = spikes.filter((s) => {
        s.t += s.speed;
        if (s.t < 1) return true;
        const ax = axons[s.axon];
        const to = s.from === ax.a ? ax.b : ax.a;
        arrived.push(to);
        if (flashes.length < 90) flashes.push({ x: neurons[to].x + neurons[to].ox, y: neurons[to].y + neurons[to].oy, t: 0 });
        return false;
      });
      for (const i of arrived) {
        const n = neurons[i];
        if (n.refractory > 0) continue;
        // a neuron on an active pathway integrates more of what reaches it, and the
        // excitability wave decides whether a marginal input is enough
        n.v += (n.cap && active.has(n.cap) ? 0.62 : 0.34) * (0.7 + exc(n) * 0.6);
        if (n.v >= 1) fire(i);
      }

      // decay
      for (const n of neurons) {
        if (n.refractory > 0) n.refractory--;
        n.v *= 0.982;
        n.glow *= 0.94;
        n.phase += 0.004;
        n.ox = Math.cos(n.phase) * 3.2;
        n.oy = Math.sin(n.phase * 1.3) * 2.6;
      }
      for (const ax of axons) ax.w *= 0.99;
      flashes = flashes.filter((f) => (f.t += 0.075) < 1);

      draw(active);
      raf = requestAnimationFrame(step);
    }

    function draw(active: Set<string>) {
      const accent = cssv("--accent") || "#8FD6D0";
      // --line, not --line-soft: at rest the axons must still read as a network. The
      // softest token disappears entirely on the light ground and leaves scattered dots.
      const line = cssv("--line") || "rgba(255,255,255,.14)";
      const ink = cssv("--ink-3") || "#6C6C78";
      ctx.clearRect(0, 0, W, H);

      const par = parallax();
      const px = (n: Neuron) => n.x + n.ox;
      const py = (n: Neuron) => n.y + n.oy + par;

      // axons — hairlines, brighter where the pathway is live or potentiated
      for (const ax of axons) {
        const a = neurons[ax.a], b = neurons[ax.b];
        const live = Math.max(a.glow, b.glow);
        const onPath = (a.cap && active.has(a.cap)) || (b.cap && active.has(b.cap));
        const hot = live > 0.12 || ax.w > 0.22 || onPath;
        ctx.globalAlpha = (0.3 + live * 0.5 + ax.w * 0.34 + (onPath ? 0.2 : 0)) * boot;
        ctx.strokeStyle = hot ? accent : line;
        ctx.lineWidth = 1 + ax.w * 0.7 + (live > 0.12 ? 0.4 : 0);
        ctx.beginPath();
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
        ctx.stroke();
      }

      // travelling spikes — the thing no particle library does
      for (const s of spikes) {
        const ax = axons[s.axon];
        const from = s.from === ax.a ? neurons[ax.a] : neurons[ax.b];
        const to = s.from === ax.a ? neurons[ax.b] : neurons[ax.a];
        const fx = px(from), fy = py(from), dx = px(to) - fx, dy = py(to) - fy;
        const x = fx + dx * s.t, y = fy + dy * s.t;
        // a short tail, drawn back along the axon: conduction has a direction
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.85 * (1 - Math.abs(s.t - 0.5) * 0.6) * boot;
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(x - dx * 0.055, y - dy * 0.055); ctx.lineTo(x, y); ctx.stroke();
      }

      // release — a hairline ring at each arrival, expanding and gone in ~13 frames
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      for (const f of flashes) {
        ctx.globalAlpha = (1 - f.t) * 0.42 * boot;
        ctx.beginPath(); ctx.arc(f.x, f.y + par, 2 + f.t * 13, 0, Math.PI * 2); ctx.stroke();
      }

      // somas
      for (const n of neurons) {
        const x = px(n), y = py(n);
        const lit = n.glow > 0.04;
        const onPath = n.cap && active.has(n.cap);
        ctx.globalAlpha = (lit ? 0.45 + n.glow * 0.55 : onPath ? 0.7 : 0.45 + n.v * 0.4) * boot;
        ctx.beginPath();
        ctx.arc(x, y, n.r + n.glow * 2.2, 0, Math.PI * 2);
        if (n.input) {
          ctx.fillStyle = accent;
          ctx.globalAlpha = (0.85 + n.glow * 0.15) * boot;
          ctx.fill();
          ctx.globalAlpha = (0.25 + n.glow * 0.5) * boot;
          ctx.beginPath(); ctx.arc(x, y, 13 + n.glow * 10, 0, Math.PI * 2);
          ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.stroke();
        } else if (lit || onPath) {
          ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.stroke();
        } else {
          ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Respect a reduced-motion preference: draw the tissue, do not animate it.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resize();

    // Viewport coordinates, corrected back out of the parallax offset, so the electrode
    // sits where the tissue is drawn rather than where it rests.
    const onMove = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY - parallax(); pointer.on = true; };
    const onLeave = () => { pointer.on = false; };
    const onScroll = () => { scrollY = window.scrollY || 0; };
    // A backgrounded tab must not keep integrating: it burns battery and comes back
    // with a queued burst of activity that looks like a glitch.
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) raf = requestAnimationFrame(step);
    };

    if (still) {
      boot = 1;
      draw(new Set());
    } else {
      // ignition: one spike at the input wakes the tissue, and you see it happen
      fire(0);
      step();
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerleave", onLeave);
      window.addEventListener("scroll", onScroll, { passive: true });
      document.addEventListener("visibilitychange", onVis);
    }
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVis);
      themeObs.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="neural" aria-hidden="true" />;
}
