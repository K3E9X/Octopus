// Monoline glyphs for the navigation rail and the bar. Deliberately geometric and
// stroke-only: the art direction is one hairline weight, one accent, no fills and no
// pictograms. Everything is drawn on a 24-unit grid with currentColor, so a glyph
// inherits the state colour of whatever it sits in and needs no theme handling.

export type GlyphName =
  | "investigate" | "enrich" | "sources" | "cases" | "data" | "configure"
  | "command" | "sun" | "moon" | "help" | "chevron";

const P: Record<GlyphName, React.ReactNode> = {
  // a seed node with its orbit — the product's own metaphor
  investigate: <><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8.2" opacity=".55" /><path d="M12 3.8v-2M12 22.2v-2M3.8 12h-2M22.2 12h2" opacity=".55" /></>,
  // a signal being amplified: three rising strokes
  enrich: <><path d="M5 16.5V12M12 16.5V6.5M19 16.5V9.5" /><path d="M3.5 20h17" opacity=".45" /></>,
  // a grid of sources
  sources: <><rect x="4" y="4" width="6.4" height="6.4" rx="1" /><rect x="13.6" y="4" width="6.4" height="6.4" rx="1" opacity=".55" /><rect x="4" y="13.6" width="6.4" height="6.4" rx="1" opacity=".55" /><rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1" /></>,
  // a case file
  cases: <><path d="M3.6 7.4a1.6 1.6 0 0 1 1.6-1.6h3.4l1.8 2.2h7.9a1.6 1.6 0 0 1 1.6 1.6v8.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z" /><path d="M3.6 12.2h16.8" opacity=".45" /></>,
  // in and out
  data: <><path d="M8 3.6v9.2M8 12.8 5 9.8M8 12.8l3-3" /><path d="M16 20.4v-9.2M16 11.2l3 3M16 11.2l-3 3" opacity=".65" /></>,
  // sliders
  configure: <><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2" /><circle cx="9" cy="16" r="2" /></>,
  // command key
  command: <><path d="M9 9h6v6H9z" /><path d="M9 9a2.4 2.4 0 1 0-2.4-2.4V9zM15 9h2.4A2.4 2.4 0 1 0 15 6.6zM9 15H6.6A2.4 2.4 0 1 0 9 17.4zM15 15v2.4A2.4 2.4 0 1 0 17.4 15z" opacity=".7" /></>,
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" opacity=".7" /></>,
  moon: <><path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" /></>,
  help: <><circle cx="12" cy="12" r="8.6" opacity=".55" /><path d="M9.7 9.4a2.4 2.4 0 1 1 3 2.3v1.6" /><path d="M12.7 16.4h-1.4v-1.3h1.4z" fill="currentColor" stroke="none" /></>,
  chevron: <><path d="m9 5 6 7-6 7" /></>,
};

export function Glyph({ name, size = 17, className }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"
    >
      {P[name]}
    </svg>
  );
}
