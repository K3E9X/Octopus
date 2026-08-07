import type { Metadata, Viewport } from "next";
import { Syne, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// next/font SELF-HOSTS these at build time. That matters more here than convenience:
// a <link> to Google Fonts would make every page load of an OSINT tool call a third
// party, which is the one thing this app's egress posture exists to avoid.
const display = Syne({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-display", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Octopus OSINT",
  description:
    "Octopus OSINT — resolve one identity across everything, and know when it cannot be resolved. Orbit is one view inside it.",
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
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${mono.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body>{children}</body>
    </html>
  );
}
