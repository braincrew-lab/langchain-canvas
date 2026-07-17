/** @type {import('next').NextConfig} */
const nextConfig = {
  // The React SDK ships as source-friendly ESM; let Next transpile it in dev.
  transpilePackages: ["@langchain-canvas/react"],
};

export default nextConfig;
