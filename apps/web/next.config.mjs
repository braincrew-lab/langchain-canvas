/** @type {import('next').NextConfig} */
const nextConfig = {
  // The React SDK ships as source-friendly ESM; let Next transpile it in dev.
  transpilePackages: ["@braincrew-lab/langchain-canvas"],
};

export default nextConfig;
