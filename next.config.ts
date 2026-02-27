import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  logging: {
    incomingRequests: {
      ignore: [/\/api\/ollama\/metrics/],
    },
  },
};

export default nextConfig;
