import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Maia: server-only; no static export
  serverExternalPackages: ["sql.js"],
  turbopack: {},
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.module ??= {};
      config.module.noParse = /node_modules[\\/]sql\.js/;
    }
    return config;
  },
};

export default nextConfig;
