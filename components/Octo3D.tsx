"use client";

// Octo3D — React wrapper around the scene file at lib/octo3d.js.
//
// The scene file registers two custom elements (<octo-hero>, <source-orb>) and reads
// the page's --accent variable, so it re-themes itself for free. This wrapper loads
// that module once on the client and mounts the requested element.
//
// Two deviations from the handoff's version, both deliberate:
//
//   three is BUNDLED. The handoff ships the scene as a <script src="/octo3d.js"> that
//   imports three from esm.sh at runtime. Its own appendix sanctions bundling instead,
//   and for this app that is the right call: a tool whose entire egress posture is
//   about not announcing itself should not fetch a third-party script on every page
//   load. It also removes a supply chain that can change without notice.
//
//   The mount waits for a non-zero box. WebGL initialises against clientWidth/Height,
//   and a container that is still 0×0 on the frame the element is appended produces a
//   renderer sized 800×600 that never corrects — the ResizeObserver in the scene fires,
//   but resize() returns early on a zero box and the camera aspect is already wrong.

import { useEffect, useRef } from "react";

let loaderPromise: Promise<void> | null = null;
function loadScenes(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (customElements.get("octo-hero")) return Promise.resolve();
  if (!loaderPromise) loaderPromise = import("@/lib/octo3d").then(() => undefined);
  return loaderPromise;
}

type Props = {
  scene?: "hero" | "orb";
  className?: string;
  style?: React.CSSProperties;
};

export default function Octo3D({ scene = "hero", className, style }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let el: HTMLElement | null = null;
    let cancelled = false;
    let raf = 0;

    const mount = () => {
      if (cancelled || !host.current) return;
      // wait for layout: a 0×0 box makes the renderer pick its 800×600 fallback
      if (!host.current.clientWidth || !host.current.clientHeight) {
        raf = requestAnimationFrame(mount);
        return;
      }
      el = document.createElement(scene === "orb" ? "source-orb" : "octo-hero");
      el.style.position = "absolute";
      el.style.inset = "0";
      host.current.appendChild(el);
    };

    loadScenes().then(mount).catch(() => { /* no WebGL, no scene — the page still works */ });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (el && el.parentNode) el.parentNode.removeChild(el);   // triggers scene cleanup
    };
  }, [scene]);

  return (
    <div
      ref={host}
      aria-hidden="true"
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", ...style }}
    />
  );
}
