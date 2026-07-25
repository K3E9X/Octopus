import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Octopus — Orbit",
  description:
    "Octopus — OSINT identity correlation platform. Orbit view: matching confidence as gravitational pull.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0B0B0D" },
    { media: "(prefers-color-scheme: light)", color: "#F7F7F5" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Resolve the theme BEFORE first paint. Reading localStorage from React would happen
// after hydration and the page would show the wrong ground for a frame — on a
// void-black interface that is a white strobe, not a detail.
const THEME_BOOT =
  '(function(){try{var t=localStorage.getItem("octopus:theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})()';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body>{children}</body>
    </html>
  );
}
