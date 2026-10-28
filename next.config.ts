import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The corpus is read with fs at runtime from a path set by env, so the tracer can't see it.
  // scripts/stage-deploy-corpus.sh fills deploy-corpus/ (gitignored) before a deploy.
  outputFileTracingIncludes: {
    "/*": ["./deploy-corpus/**/*"],
    "/api/*": ["./deploy-corpus/**/*"],
  },
};

export default nextConfig;
