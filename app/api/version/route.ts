import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";
import { resolveCorpusDir } from "@/lib/corpus";
import { configuredApproach, configuredStrategy, inspectRetrievalIndex, retrievalMetadata } from "@/lib/retrieval/load";

import { RETRIEVAL_CONFIG_VERSION } from "@/lib/retrieval/pipeline";

import { retrievalDetail } from "@/lib/retrieval/detail";

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
      detail = retrievalDetail({
        strategy: configuredStrategy(),
        index: state.status === 'ready' ? state.index ?? null : null,
      });
    }
    return Response.json({ version: corpus.version, approach, retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, retrieval: retrievalMetadata(state), ...(detail ? { detail } : {}) }, { headers });
  } catch (err) {
    logServerError("[version] corpus error", err);
    return Response.json({ error: "corpus" }, { status: 500, headers });
  }
}
