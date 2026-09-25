import type { NextConfig } from "next";

const apiBaseUrl = process.env.API_INTERNAL_BASE_URL ?? "http://localhost:8320";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  async rewrites() {
    return [
      {
        source: "/v1/:path*",
        destination: `${apiBaseUrl}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
