"use client";

// The landing's motion layer — pared back.
//
// It used to carry four effects: an ignition loader, a sonar cursor, a depth gauge and
// scroll reveals. Two of those hurt the thing a landing is for. The ignition loader
// gated first paint for 1.75s — a storefront that makes you wait before you can read
// it. The sonar cursor replaced the real pointer with a lagging ring, which fights
// every click. Both are gone.
//
// What remains is quiet and functional: the page darkens slightly as you descend (a
// fixed tint, one compositor property, never a layout), and sections rise in once as
// they enter view. Reduced motion removes even those.

import { useEffect, useRef } from "react";

const MAX_DEPTH = 3900;

export default function AbyssMotion() {
  const still = useRef(false);
  const readoutRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const gaugeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    still.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // depth tint + a quiet left-rail readout
  useEffect(() => {
    if (still.current) return;
    let raf = 0;
    const write = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const t = Math.min(1, Math.max(0, window.scrollY / max));
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

  // scroll reveals
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
      <div className="depth-shade" data-fixed aria-hidden="true" />
      <div className="depth-gauge" data-fixed ref={gaugeRef} aria-hidden="true">
        <div className="dg-rail"><i ref={barRef} /></div>
        <div className="dg-out">
          <div className="dg-read" ref={readoutRef}>0 m</div>
          <div className="dg-cap">depth</div>
        </div>
      </div>
    </>
  );
}
