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
  /** the input neuron: where a typed seed enters the field */
  input?: boolean;
}

interface Axon { a: number; b: number; len: number }
interface Spike { axon: number; from: number; t: number; speed: number }

export default function NeuralField({ kind, pulse }: { kind: SeedKind; pulse: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ kind, pulse });
  stateRef.current = { kind, pulse };

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0, raf = 0, t = 0, lastPulse = -1;

    let root = getComputedStyle(document.documentElement);
    let cache: Record<string, string> = {};
    const cssv = (n: string) => (cache[n] ??= root.getPropertyValue(n).trim());
    const themeObs = new MutationObserver(() => { cache = {}; root = getComputedStyle(document.documentElement); });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let neurons: Neuron[] = [];
    let axons: Axon[] = [];
    let spikes: Spike[] = [];

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
        neurons.push({ x: hx, y: hy, ox: 0, oy: 0, phase: Math.random() * 6.28, v: 0, refractory: 0, glow: 0, r: 3.2, cap: c.id });
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
          if (i < n.j) axons.push({ a: i, b: n.j, len: n.d });
        }
        // one long reach per cluster head
        if (neurons[i].cap && near.length > 6) {
          const far = near[near.length - 1];
          if (i < far.j) axons.push({ a: i, b: far.j, len: far.d });
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
        if (best >= 0) { axons.push({ a: i, b: best, len: bd }); degree[i]++; degree[best]++; }
      }
    }

    function resize() {
      const rect = cv.getBoundingClientRect();
      W = rect.width; H = rect.height;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      build();
    }

    /** Fire a neuron: emit a spike down every axon it owns. */
    function fire(i: number) {
      const n = neurons[i];
      n.v = 0;
      n.glow = 1;
      n.refractory = 28 + Math.random() * 26;
      for (let k = 0; k < axons.length; k++) {
        const ax = axons[k];
        if (ax.a !== i && ax.b !== i) continue;
        if (spikes.length > 260) break;
        spikes.push({ axon: k, from: i, t: 0, speed: 0.9 / Math.max(24, ax.len) });
      }
    }

    function step() {
      t += 1;
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

      // spontaneous activity, so the field is alive at rest without being busy
      if (t % 26 === 0) {
        const i = 1 + Math.floor(Math.random() * (neurons.length - 1));
        if (neurons[i].refractory <= 0) fire(i);
      }

      // conduction
      const arrived: number[] = [];
      spikes = spikes.filter((s) => {
        s.t += s.speed;
        if (s.t < 1) return true;
        const ax = axons[s.axon];
        arrived.push(s.from === ax.a ? ax.b : ax.a);
        return false;
      });
      for (const i of arrived) {
        const n = neurons[i];
        if (n.refractory > 0) continue;
        // a neuron on an active pathway integrates more of what reaches it
        n.v += n.cap && active.has(n.cap) ? 0.62 : 0.34;
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

      // axons — hairlines, brighter where the pathway is live
      for (const ax of axons) {
        const a = neurons[ax.a], b = neurons[ax.b];
        const live = Math.max(a.glow, b.glow);
        const onPath = (a.cap && active.has(a.cap)) || (b.cap && active.has(b.cap));
        ctx.globalAlpha = 0.3 + live * 0.5 + (onPath ? 0.2 : 0);
        ctx.strokeStyle = live > 0.12 || onPath ? accent : line;
        ctx.lineWidth = live > 0.12 ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x + a.ox, a.y + a.oy);
        ctx.lineTo(b.x + b.ox, b.y + b.oy);
        ctx.stroke();
      }

      // travelling spikes — the thing no particle library does
      ctx.globalAlpha = 1;
      for (const s of spikes) {
        const ax = axons[s.axon];
        const from = s.from === ax.a ? neurons[ax.a] : neurons[ax.b];
        const to = s.from === ax.a ? neurons[ax.b] : neurons[ax.a];
        const x = (from.x + from.ox) + ((to.x + to.ox) - (from.x + from.ox)) * s.t;
        const y = (from.y + from.oy) + ((to.y + to.oy) - (from.y + from.oy)) * s.t;
        // a short tail, drawn back along the axon: conduction has a direction
        const tx = x - ((to.x + to.ox) - (from.x + from.ox)) * 0.05;
        const ty = y - ((to.y + to.oy) - (from.y + from.oy)) * 0.05;
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.85 * (1 - Math.abs(s.t - 0.5) * 0.6);
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
      }

      // somas
      for (const n of neurons) {
        const x = n.x + n.ox, y = n.y + n.oy;
        const lit = n.glow > 0.04;
        const onPath = n.cap && active.has(n.cap);
        ctx.globalAlpha = lit ? 0.45 + n.glow * 0.55 : onPath ? 0.7 : 0.45 + n.v * 0.4;
        ctx.beginPath();
        ctx.arc(x, y, n.r + n.glow * 2.2, 0, Math.PI * 2);
        if (n.input) {
          ctx.fillStyle = accent;
          ctx.globalAlpha = 0.85 + n.glow * 0.15;
          ctx.fill();
          ctx.globalAlpha = 0.25 + n.glow * 0.5;
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
    if (still) draw(new Set());
    else step();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      themeObs.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="neural" aria-hidden="true" />;
}
