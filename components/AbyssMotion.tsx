"use client";

// The landing's motion layer: ignition, sonar cursor, depth.
//
// Three primitives from the handoff, all pure DOM/CSS — no library, no dependency.
// They are grouped in one component because they share the same two constraints and
// splitting them would mean repeating both:
//
//   reduced motion is a REFUSAL, not a softening. Every one of these is suppressed
//   entirely rather than slowed down: the loader never mounts, the cursor never
//   appears, the depth shade is applied statically at 0.
//
//   nothing here may cost a frame on scroll. The depth readout is driven from a
//   passive listener that only schedules a rAF, and the write goes to two CSS custom
//   properties — no layout, no React state, no re-render per pixel scrolled.

import { useEffect, useRef, useState } from "react";
import { OctoMark } from "./OctoMark";

const MAX_DEPTH = 3900; // metres at the bottom of the page — the abyssal plain

export default function AbyssMotion() {
  const [ignited, setIgnited] = useState(false);
  const still = useRef(false);

  useEffect(() => {
    still.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still.current) { setIgnited(true); return; }
    const t = setTimeout(() => setIgnited(true), 1750);
    return () => clearTimeout(t);
  }, []);

  // ---- depth gauge + darkening -------------------------------------------------
  const gaugeRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (still.current) return;
    let raf = 0;
    const write = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const t = Math.min(1, Math.max(0, window.scrollY / max));
      // the page literally gets darker as you descend
      doc.style.setProperty("--depth", String(t));
      if (readoutRef.current) readoutRef.current.textContent = `−${Math.round(t * MAX_DEPTH)} m`;
      if (barRef.current) barRef.current.style.transform = `scaleY(${t})`;
      if (gaugeRef.current) gaugeRef.current.classList.toggle("deep", t > 0.04);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(write); };
    write();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      document.documentElement.style.removeProperty("--depth");
    };
  }, []);

  // ---- sonar cursor -------------------------------------------------------------
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (still.current) return;
    // a coarse pointer has no cursor to decorate, and the ring would just lag a tap
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    const ring = ringRef.current;
    if (!ring) return;
    let x = innerWidth / 2, y = innerHeight / 2, rx = x, ry = y, over = false, raf = 0;

    const loop = () => {
      // lerp: the ring trails the pointer, which is what makes it read as a sweep
      rx += (x - rx) * 0.18;
      ry += (y - ry) * 0.18;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%) scale(${over ? 2.1 : 1})`;
      raf = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      x = e.clientX; y = e.clientY;
      const el = e.target as HTMLElement | null;
      over = !!el?.closest?.("a, button, input, [role='button']");
      ring.classList.add("on");
    };
    const leave = () => ring.classList.remove("on");
    const click = (e: PointerEvent) => {
      const r = document.createElement("i");
      r.className = "sonar-ping";
      r.style.left = e.clientX + "px";
      r.style.top = e.clientY + "px";
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 620);
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", leave);
    window.addEventListener("pointerdown", click, { passive: true });
    loop();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", leave);
      window.removeEventListener("pointerdown", click);
    };
  }, []);

  // ---- scroll reveals -------------------------------------------------------------
  useEffect(() => {
    if (still.current) {
      document.querySelectorAll(".rise").forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -12% 0px" },
    );
    document.querySelectorAll(".rise").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <>
      {!ignited && (
        <div className="ignition" data-fixed aria-hidden="true">
          <OctoMark size={66} className="ign-octo" />
          <div className="ign-bar"><i /></div>
          <div className="ign-label">descending</div>
        </div>
      )}
      <div className="depth-shade" data-fixed aria-hidden="true" />
      <div className="depth-gauge" data-fixed ref={gaugeRef} aria-hidden="true">
        <div className="dg-rail"><i ref={barRef} /></div>
        <div className="dg-out">
          <div className="dg-read" ref={readoutRef}>0 m</div>
          <div className="dg-cap">depth</div>
        </div>
      </div>
      <div className="sonar" data-fixed ref={ringRef} aria-hidden="true" />
    </>
  );
}
