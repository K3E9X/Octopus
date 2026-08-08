// The octopus mark from the Abyss references: eight arms reaching out, a ringed eye.
//
// It is drawn rather than imported so it can inherit the palette — the arms take a
// warm bone, the eye takes the accent — and so the same geometry serves the 40px
// header lockup and the 66px ignition mark without a second asset.
//
// `float` and `glow` are opt-in: the mark is used inside the cockpit chrome too, where
// a drifting logo would be a distraction rather than an identity.

export function OctoMark({
  size = 44, className, float = false, glow = false,
}: { size?: number; className?: string; float?: boolean; glow?: boolean }) {
  const cls = [className, float ? "octo-float" : "", glow ? "octo-glow" : ""].filter(Boolean).join(" ");
  return (
    <svg
      width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Octopus"
      className={cls || undefined} focusable="false"
    >
      <g fill="none" stroke="var(--arm, #E9D9C8)" strokeWidth="2.1" strokeLinecap="round">
        <path d="M56.45,46.85 C67.31,55.68 78.05,43.16 84.37,54.86" />
        <path d="M55.35,49.05 C63.23,61.92 78.76,54.87 81.12,68.57" />
        <path d="M53.53,50.71 C56.7,66.31 74.23,66.13 71.82,80.31" />
        <path d="M51.23,51.59 C48.65,67.76 65.15,74.41 57.86,87.1" />
        <path d="M48.77,51.59 C40.53,65.74 53.52,77.9 42.14,87.1" />
        <path d="M46.47,50.71 C33.94,60.53 41.94,76.12 28.18,80.31" />
        <path d="M44.65,49.05 C30.13,53.15 32.71,70.02 18.88,68.57" />
        <path d="M43.55,46.85 C29.66,45.11 27.18,61.43 15.63,54.86" />
      </g>
      <circle cx="50" cy="45" r="8.6" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      <circle cx="50" cy="45" r="3.5" fill="var(--accent)" />
    </svg>
  );
}
