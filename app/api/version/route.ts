import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";
import { resolveCorpusDir } from "@/lib/corpus";
import { configuredApproach, configuredStrategy, inspectRetrievalIndex, retrievalMetadata } from "@/lib/retrieval/load";

import { RETRIEVAL_CONFIG_VERSION } from "@/lib/retrieval/pipeline";

import { activeRetrievalConfigVersion } from "@/lib/retrieval/production";
import { isAlwaysSupplied } from "@/lib/retrieval/wide-select";

export async function GET(request: Request): Promise<Response> {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  const headers = { "cache-control": "no-store" };
  try {
    const corpus = await getCorpus();
    const approach = configuredApproach();
    const state = await inspectRetrievalIndex(resolveCorpusDir(), corpus);
    let detail;
    if (new URL(request.url).searchParams.get("detail") === "1") {
      const strategy = configuredStrategy();
      const always = state.status === 'ready' && state.index
        ? state.index.units.filter(isAlwaysSupplied) : null;
      detail = { strategy, retrievalConfigVersion: activeRetrievalConfigVersion(strategy),
        alwaysSuppliedCount: always?.length ?? null,
        overviewPresent: always?.some(unit => unit.kind === 'entry' && unit.document === 'Career Overview') ?? null };
    }
    return Response.json({ version: corpus.version, approach, retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, retrieval: retrievalMetadata(state), ...(detail ? { detail } : {}) }, { headers });
  } catch (err) {
    logServerError("[version] corpus error", err);
    return Response.json({ error: "corpus" }, { status: 500, headers });
  }
}
