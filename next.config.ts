import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  typescript: {
    tsconfigPath: "tsconfig.netlify.json",
  },
};

export default nextConfig;
