import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// The font files are committed in app/fonts and loaded with next/font/LOCAL, on purpose.
// next/font/google fetches font metadata from Google AT BUILD TIME, and that fetch fails
// intermittently on CI ("Cannot read properties of null" in the font loader), breaking the
// build for no reason in the code. Self-hosting the files removes the network from the
// build entirely — and keeps page loads from calling a third party, which this app's
// egress posture wants anyway. These are the variable woff2s (latin, which covers French),
// one file per family spanning its whole weight axis.
// A three-face system, each with one job: Space Grotesk is the DISPLAY face (headings +
// the big numerals only — a display grotesque hurts readability below ~16px); Inter is
// the neutral workhorse for body and UI text; JetBrains Mono carries the data, where the
// legibility of a raw value (an IBAN, a hash) and tabular figures are the whole job.
const display = localFont({ src: "./fonts/SpaceGrotesk.woff2", weight: "500 700", variable: "--font-display", display: "swap" });
const sans = localFont({ src: "./fonts/Inter.woff2", weight: "400 600", variable: "--font-sans", display: "swap" });
const mono = localFont({ src: "./fonts/JetBrainsMono.woff2", weight: "400 600", variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Octopus Leak",
  description:
    "Octopus Leak — see exactly what has leaked about you across known breaches, and what to do about each exposure.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#04080B" },
    { media: "(prefers-color-scheme: light)", color: "#FBF7F3" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Resolve the theme BEFORE first paint. Reading localStorage from React would happen
// after hydration and the page would show the wrong ground for a frame — on a
// void-black interface that is a white strobe, not a detail.
// It also RESOLVES the system preference into the attribute, so the light palette can
// be declared exactly once in CSS instead of a second time inside a media query — the
// duplicate had already drifted out of step with the original.
const THEME_BOOT =
  '(function(){var t;try{t=localStorage.getItem("octopus:theme")}catch(e){}' +
  'if(t!=="light"&&t!=="dark"){try{t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(e){t="dark"}}' +
  'document.documentElement.setAttribute("data-theme",t);' +
  'try{var d=localStorage.getItem("octopus:density");if(d==="large"||d==="xl")document.documentElement.setAttribute("data-density",d)}catch(e){}})()';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body>{children}</body>
    </html>
  );
}
