/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // self-contained server bundle → tiny Docker image, runs anywhere (Linux/Windows,
  // Docker, Kubernetes) with just `node server.js`. No effect on Vercel.
  output: "standalone",

  /**
   * The routes this product used to have.
   *
   * /app was the investigator console and /check was the self-exposure report; both
   * were removed when the product became one thing. Leaving them to 404 breaks three
   * groups of people at once: anyone holding a bookmark, anyone following an old link,
   * and — the one that actually bit — anyone whose browser still had the previous
   * client bundle cached, because that bundle sends you to /app the moment you sign in.
   * They get a 404 on a page they just authenticated into, with nothing to suggest the
   * tool still exists.
   *
   * Temporary rather than permanent on purpose: a 308 is cached hard and for a long
   * time, and the last thing a surface that has just been renamed needs is another
   * instruction baked into everybody's browser.
   */
  async redirects() {
    return [
      { source: "/app", destination: "/search", permanent: false },
      { source: "/app/:path*", destination: "/search", permanent: false },
      { source: "/check", destination: "/search", permanent: false },
      { source: "/check/:path*", destination: "/search", permanent: false },
    ];
  },
};

export default nextConfig;
