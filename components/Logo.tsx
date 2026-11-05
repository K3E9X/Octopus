// Octopus mark, the product's own Orbit view as a logo: a cyan seed node with its
// halo, growing eight monoline tentacles that end in the nodes it correlates. Theme-
// aware through the app's CSS variables (--ink-2 / --ink-3 / --ink-4 / --accent), so it
// sits identically on the void and light grounds. Pure SVG, no dependencies.

const CX = 50, CY = 45, HEAD_R = 8.6, N = 8;
const A0 = (16 * Math.PI) / 180, A1 = (164 * Math.PI) / 180;
const f = (n: number) => Number(n.toFixed(2));

const ARMS = Array.from({ length: N }, (_, i) => {
  const a = A0 + ((A1 - A0) * i) / (N - 1);
  const dx = Math.cos(a), dy = Math.sin(a), px = -dy, py = dx;
  const L = 33 + 10 * Math.sin(a);
  const rx = CX + dx * HEAD_R * 0.78, ry = CY + dy * HEAD_R * 0.78;
  const ex = CX + dx * L, ey = CY + dy * L;
  const c1x = rx + dx * L * 0.36 + px * 5.5, c1y = ry + dy * L * 0.36 + py * 5.5;
  const c2x = ex - dx * L * 0.26 - px * 9.5, c2y = ey - dy * L * 0.26 - py * 9.5;
  return { d: `M${f(rx)},${f(ry)} C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(ex)},${f(ey)}`, ex: f(ex), ey: f(ey) };
});

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} role="img" aria-label="Octopus">
      {ARMS.map((a, i) => (
        <path key={i} d={a.d} fill="none" stroke="var(--ink-2)" strokeWidth={2.1} strokeLinecap="round" />
      ))}
      <circle cx={CX} cy={CY} r={HEAD_R} fill="none" stroke="var(--ink-3)" strokeWidth={1.3} />
      <circle cx={CX} cy={CY} r={HEAD_R * 0.62} fill="none" stroke="var(--ink-4)" strokeWidth={1} />
      {ARMS.map((a, i) => (
        <circle key={i} cx={a.ex} cy={a.ey} r={1.7} fill="var(--ink-3)" />
      ))}
      <circle cx={CX} cy={CY} r={3.5} fill="var(--accent)" />
    </svg>
  );
}
