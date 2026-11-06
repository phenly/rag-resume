import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";
import { resolveCorpusDir } from "@/lib/corpus";
import { configuredApproach, inspectRetrievalIndex, retrievalMetadata } from "@/lib/retrieval/load";

export async function GET(request: Request): Promise<Response> {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  const headers = { "cache-control": "no-store" };
  try {
    const corpus = await getCorpus();
    const approach = configuredApproach();
    const state = await inspectRetrievalIndex(resolveCorpusDir(), corpus);
    return Response.json({ version: corpus.version, approach, retrieval: retrievalMetadata(state) }, { headers });
  } catch (err) {
    logServerError("[version] corpus error", err);
    return Response.json({ error: "corpus" }, { status: 500, headers });
  }
}
