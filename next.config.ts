import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  async redirects() {
    return [
      { source: "/rwa-pairs", destination: "/app/rwa-pairs", permanent: true },
      { source: "/position-performance", destination: "/app/position-performance", permanent: true },
      { source: "/ai", destination: "/app/ai", permanent: true },
      { source: "/sign/:token", destination: "/app/sign/:token", permanent: true },
    ];
  },
};

export default nextConfig;
