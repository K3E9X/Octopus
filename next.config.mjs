/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // self-contained server bundle → tiny Docker image, runs anywhere (Linux/Windows,
  // Docker, Kubernetes) with just `node server.js`. No effect on Vercel.
  output: "standalone",
};

export default nextConfig;
