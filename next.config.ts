import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { spawnSync } from "node:child_process";
import path from "node:path";

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

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const dir = process.env.VERCEL ? "deploy-corpus" : (process.env.CORPUS_DIR?.trim() || "sample-corpus");
    // This also runs for direct `next build` / Vercel builds, with no network calls.
    const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/retrieval-status.ts", path.resolve(dir)], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Production build requires a fresh validated corpus/retrieval index. Stage it before building.");
    if (process.env.VERCEL && path.resolve(process.env.CORPUS_DIR || "sample-corpus") !== path.resolve(dir)) {
      throw new Error("Vercel CORPUS_DIR must select the validated deploy-corpus snapshot.");
    }
  }
  return nextConfig;
}
