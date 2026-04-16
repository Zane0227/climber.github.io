import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  turbopack: {},
  webpack: (config, { isServer }) => {
    if (isServer) {
      // 服务端把 @mediapipe/pose 替换为空模块
      config.resolve.alias = {
        ...config.resolve.alias,
        "@mediapipe/pose": false,
      };
    }
    return config;
  },
};

export default nextConfig;
