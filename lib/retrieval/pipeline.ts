import { createHash } from 'node:crypto';
import type { Corpus } from '../corpus';
import { buildSharedPromptPrefix, PROMPT_TEMPLATE_VERSION, renderRetrievalEvidence } from '../prompt';
import { redactContacts } from '../redact';
import { EXTRACTOR_VERSION, TOKENIZER_VERSION } from './build-index';
import type { RetrievalUnit } from './extract';
import { validateRetrievalIndex } from './index-schema';
import { JEV_BUDGET_POLICY, type JevClient } from './jev';
import { inspectRetrievalIndex } from './load';
import { buildRetrievalQuery, RETRIEVAL_QUERY_VERSION, type QueryTokenCounter, type VerifiedQueryTurn } from './query';
import { rerankEvidence, RERANK_CONFIG, type EvidenceTokenCounter, type RerankTrace } from './rerank';
import { HYBRID_SEARCH_CONFIG, prepareHybridSearch, type SearchTrace } from './search';
import { TOKEN_BUDGET_VERSION } from './token-budget';
import { VOYAGE_EMBEDDING_CONFIG, type Embedder } from './voyage';
import { VOYAGE_TOKENIZER } from './voyage-tokenizer';

/** Constants and rubric revisions are frozen together; thresholds remain provisional. */
export const RETRIEVAL_PIPELINE_CONFIG = Object.freeze({
  version: 'rag-pipeline-1', totalTimeoutMs: 5000, embeddingTimeoutMs: 2000,
  embeddingUsdPerMillionTokens: 0.12, routingResponses: 'safe-routes-1',
  query: RETRIEVAL_QUERY_VERSION, search: HYBRID_SEARCH_CONFIG, selection: RERANK_CONFIG,
  embedding: VOYAGE_EMBEDDING_CONFIG, tokenizer: VOYAGE_TOKENIZER,
  jevBudget: JEV_BUDGET_POLICY, jevMode: 'provider-enforced',
  tokenBudget: TOKEN_BUDGET_VERSION, prompt: PROMPT_TEMPLATE_VERSION,
});
export const RETRIEVAL_CONFIG_VERSION = createHash('sha256').update(JSON.stringify(RETRIEVAL_PIPELINE_CONFIG)).digest('hex');
export type RagTrace = {
  retrievalConfigVersion: string; indexVersion?: string; elapsedMs: number; stages: Record<string, number>;
  query?: { inputTokens: number; retainedTurns: number; droppedTurns: number; truncatedAnswer: boolean };
  search?: SearchTrace; rerank?: RerankTrace;
  embedding?: { status: 'complete'; inputTokens: number; costUsd: number } | { status: 'usage-unknown' };
  fallbackReason?: string;
};
export type RagResolution = (
  | { kind: 'evidence'; selected: RetrievalUnit[] }
  | { kind: 'route'; route: 'redirect' | 'decline'; answer: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'cancelled' }
) & { trace: RagTrace };
export type RagPipeline = { ready: boolean; resolve(options: { question: string; verifiedHistory?: readonly VerifiedQueryTurn[]; signal?: AbortSignal }): Promise<RagResolution> };
export type PrepareRagPipelineOptions = {
  corpus: Corpus; corpusDir: string; embedder: Embedder; judge: JevClient;
  countQueryTokens: QueryTokenCounter; countEvidenceTokens: EvidenceTokenCounter;
  /** Inject a fictional validated artifact for offline composition tests. */
  loadIndex?: typeof inspectRetrievalIndex;
};

/** Prepare once per successfully loaded corpus. Failed preparation is safe whole fallback. */
export async function prepareRagPipeline(options: PrepareRagPipelineOptions): Promise<RagPipeline> {
  let index: Awaited<ReturnType<typeof inspectRetrievalIndex>>['index'];
  let search: ReturnType<typeof prepareHybridSearch> | undefined;
  let alwaysMaterial = '';
  let unavailable = 'preparation';
  let name = 'the subject';
  try {
    name = redactContacts(options.corpus.profile.name).trim() || name;
    alwaysMaterial = buildSharedPromptPrefix(options.corpus).map(block => block.text).join('\n\n');
    const state = await (options.loadIndex ?? inspectRetrievalIndex)(options.corpusDir, options.corpus);
    if (state.status !== 'ready' || !state.index) unavailable = `index-${state.status}`;
    else {
      validateRetrievalIndex(state.index, { corpusVersion: options.corpus.version, embedding: VOYAGE_EMBEDDING_CONFIG,
        extractorVersion: EXTRACTOR_VERSION, tokenizerVersion: TOKENIZER_VERSION });
      index = structuredClone(state.index);
      search = prepareHybridSearch(index);
    }
  } catch { unavailable = 'preparation'; }
  // Capture dependencies: external option mutation cannot replace them mid-request.
  const { embedder, judge, countQueryTokens, countEvidenceTokens } = options;
  return { ready: !!search && !!index, async resolve(input) {
    const started = performance.now();
    const trace: RagTrace = { retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, ...(index ? { indexVersion: index.indexVersion } : {}), elapsedMs: 0, stages: {} };
    const finish = (result: Omit<RagResolution, 'trace'>): RagResolution => {
      trace.elapsedMs = Math.max(0, performance.now() - started);
      // Late completions after abort cannot modify an already delivered receipt.
      return { ...result, trace: structuredClone(trace) } as RagResolution;
    };
    const fallback = (reason: string) => { trace.fallbackReason = reason; return finish({ kind: 'fallback', reason } as Omit<RagResolution, 'trace'>); };
    if (input.signal?.aborted) return finish({ kind: 'cancelled' });
    if (!search || !index) return fallback(unavailable);
    const controller = new AbortController();
    let stopped: 'cancelled' | 'timeout' | undefined;
    let rejectStop!: (error: Error) => void;
    const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (reason: 'cancelled' | 'timeout') => {
      if (stopped) return;
      stopped = reason;
      rejectStop(new Error(reason));
      controller.abort();
    };
    const cancel = () => stop('cancelled');
    input.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('timeout'), RETRIEVAL_PIPELINE_CONFIG.totalTimeoutMs);
    let stage = 'query';
    let stageStarted = performance.now();
    const changeStage = (next: string) => { trace.stages[stage] = performance.now() - stageStarted; stage = next; stageStarted = performance.now(); };
    const observedJudge: JevClient = { async judge(questions, callOptions) {
      trace.rerank ??= { configVersion: RERANK_CONFIG.version, decisions: [], relevance: [], calls: [] };
      const receiptIndex = trace.rerank.calls.push({ status: 'usage-unknown' }) - 1;
      const result = await judge.judge(questions, callOptions);
      if (!controller.signal.aborted) trace.rerank.calls[receiptIndex] = { status: 'complete', inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd, ...(result.budgetMode ? { budgetMode: result.budgetMode } : {}), ...(result.budgetPolicyVersion ? { budgetPolicyVersion: result.budgetPolicyVersion } : {}) };
      return result;
    } };
    const run = async (): Promise<RagResolution> => {
      const query = await buildRetrievalQuery({ question: input.question, verifiedHistory: input.verifiedHistory, countTokens: countQueryTokens, signal: controller.signal });
      if (!query.ok) return fallback(`query-${query.reason}`);
      if (controller.signal.aborted) throw new Error('aborted');
      trace.query = { inputTokens: query.inputTokens, retainedTurns: query.retainedTurns.length, droppedTurns: query.droppedTurns, truncatedAnswer: query.truncatedAnswer };
      changeStage('embedding');
      trace.embedding = { status: 'usage-unknown' };
      const embeddingController = new AbortController();
      const cancelEmbedding = () => embeddingController.abort();
      controller.signal.addEventListener('abort', cancelEmbedding, { once: true });
      let rejectEmbedding!: (error: Error) => void;
      const embeddingStop = new Promise<never>((_, reject) => { rejectEmbedding = reject; });
      const embeddingTimer = setTimeout(() => { rejectEmbedding(new Error('embedding-timeout')); embeddingController.abort(); }, RETRIEVAL_PIPELINE_CONFIG.embeddingTimeoutMs);
      let embedded;
      try {
        embedded = await Promise.race([embedder.embed([query.embeddingInput], 'query', { signal: embeddingController.signal }), embeddingStop]);
      } finally {
        clearTimeout(embeddingTimer);
        controller.signal.removeEventListener('abort', cancelEmbedding);
        embeddingController.abort();
      }
      if (controller.signal.aborted) throw new Error('aborted');
      if (embedded.model !== index!.embedding.model || embedded.dimensions !== index!.embedding.dimensions
        || embedded.vectors.length !== 1 || !Number.isSafeInteger(embedded.inputTokens) || embedded.inputTokens < 0) return fallback('embedding-response');
      trace.embedding = { status: 'complete', inputTokens: embedded.inputTokens, costUsd: embedded.inputTokens * RETRIEVAL_PIPELINE_CONFIG.embeddingUsdPerMillionTokens / 1_000_000 };
      changeStage('search');
      trace.search = search!.search({ question: query.question, context: query.context, vector: embedded.vectors[0] });
      const units = new Map(index!.units.map(unit => [unit.id, unit]));
      changeStage('selection');
      const selection = await rerankEvidence({ question: query.question, context: query.context, alwaysMaterial,
        candidates: trace.search.fused.map(match => ({ match, unit: units.get(match.id)! })), judge: observedJudge,
        countEvidenceTokens, renderEvidence: renderRetrievalEvidence, signal: controller.signal });
      changeStage('resolved');
      trace.rerank = selection.trace;
      if (controller.signal.aborted) throw new Error('aborted');
      if (selection.kind === 'fallback') return fallback(`selection-${selection.reason}`);
      if (selection.kind === 'route') return finish({ kind: 'route', route: selection.route,
        answer: selection.route === 'redirect' ? `That's one to ask ${name} directly.` : `I can answer questions about ${name}'s background, but I can't help with that request.` } as Omit<RagResolution, 'trace'>);
      return finish({ kind: 'evidence', selected: selection.selected } as Omit<RagResolution, 'trace'>);
    };
    try {
      return await Promise.race([run(), stopPromise]);
    } catch {
      if (stopped === 'cancelled' || input.signal?.aborted) return finish({ kind: 'cancelled' });
      trace.stages[stage] = performance.now() - stageStarted;
      return fallback(stopped === 'timeout' ? 'retrieval-timeout' : `${stage}-error`);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  } };
}
