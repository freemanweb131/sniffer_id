import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  // Ensure bundled fonts are included in the Vercel serverless function.
  outputFileTracingIncludes: {
    "/api/generate": ["./assets/fonts/**/*"],
  },
};

export default nextConfig;
