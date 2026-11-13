import { createHash } from 'node:crypto';
import { PROMPT_TEMPLATE_VERSION } from '../prompt';
import { EXTRACTOR_VERSION, TOKENIZER_VERSION } from './build-index';
import { validateRetrievalIndex } from './index-schema';
import { inspectRetrievalIndex } from './load';
import { buildRetrievalQuery, RETRIEVAL_QUERY_VERSION } from './query';
import { prepareHybridSearch } from './search';
import { VOYAGE_EMBEDDING_CONFIG } from './voyage';
import { VOYAGE_TOKENIZER } from './voyage-tokenizer';
import { selectWideEvidence, WIDE_SELECTION_CONFIG } from './wide-select';
import type { PrepareRagPipelineOptions, RagPipeline, RagResolution, RagTrace } from './pipeline';

export const WIDE_PIPELINE_CONFIG = Object.freeze({
  version: 'wide-pipeline-1', strategy: 'wide',
  totalTimeoutMs: 5000, embeddingTimeoutMs: 2000, embeddingAttempts: 2, embeddingUsdPerMillionTokens: 0.12,
  search: { denseLimit: 'all-units', lexicalLimit: 24, candidateLimit: 24,
    k1: 1.2, b: 0.75, rrfK: 60, questionWeight: 2, contextWeight: 1 },
  promptLayout: { version: 'wide-prompt-1', order: ['shared-prefix', 'always', 'retrieved'],
    alwaysHeading: '# Career context supplied with every answer\n\n',
    cache: { block: 'always', type: 'ephemeral', ttl: '1h' }, omitEmptyRetrieved: true },
  selection: WIDE_SELECTION_CONFIG, query: RETRIEVAL_QUERY_VERSION,
  embedding: VOYAGE_EMBEDDING_CONFIG, tokenizer: VOYAGE_TOKENIZER, prompt: PROMPT_TEMPLATE_VERSION,
});
export const WIDE_CONFIG_VERSION: string = createHash('sha256').update(JSON.stringify(WIDE_PIPELINE_CONFIG)).digest('hex');
export type PrepareWidePipelineOptions = Omit<PrepareRagPipelineOptions, 'judge' | 'countEvidenceTokens'>;

/** Prepare wide retrieval without judges or whole-corpus fallback. */
export async function prepareWidePipeline(options: PrepareWidePipelineOptions): Promise<RagPipeline> {
  let index: Awaited<ReturnType<typeof inspectRetrievalIndex>>['index'];
  let search: ReturnType<typeof prepareHybridSearch> | undefined;
  let unavailable = 'preparation';
  try {
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
  const { embedder, countQueryTokens } = options;
  return { ready: !!search && !!index, async resolve(input) {
    const started = performance.now();
    const trace: RagTrace = { strategy: 'wide', retrievalConfigVersion: WIDE_CONFIG_VERSION, ...(index ? { indexVersion: index.indexVersion } : {}), elapsedMs: 0, stages: {} };
    const finish = (result: Omit<RagResolution, 'trace'>): RagResolution => {
      trace.elapsedMs = Math.max(0, performance.now() - started);
      // Late completions after abort cannot modify an already delivered receipt.
      return { ...result, trace: structuredClone(trace) } as RagResolution;
    };
    const unavailableResult = (reason: string) => { trace.unavailableReason = reason; return finish({ kind: 'unavailable', reason } as Omit<RagResolution, 'trace'>); };
    if (input.signal?.aborted) return finish({ kind: 'cancelled' });
    if (!search || !index) return unavailableResult(unavailable);
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
    const timer = setTimeout(() => stop('timeout'), WIDE_PIPELINE_CONFIG.totalTimeoutMs);
    let stage = 'query';
    let stageStarted = performance.now();
    const changeStage = (next: string) => { trace.stages[stage] = performance.now() - stageStarted; stage = next; stageStarted = performance.now(); };
    const run = async (): Promise<RagResolution> => {
      const query = await buildRetrievalQuery({ question: input.question, verifiedHistory: input.verifiedHistory, countTokens: countQueryTokens, signal: controller.signal });
      if (!query.ok) return unavailableResult(`query-${query.reason}`);
      if (controller.signal.aborted) throw new Error('aborted');
      trace.query = { inputTokens: query.inputTokens, retainedTurns: query.retainedTurns.length, droppedTurns: query.droppedTurns, truncatedAnswer: query.truncatedAnswer };
      changeStage('embedding');
      trace.embedding = { status: 'usage-unknown' };
      // The query embedding is the only network call here; one retry inside the total deadline absorbs a slow or dropped first call.
      const embedOnce = async () => {
        const embeddingController = new AbortController();
        const cancelEmbedding = () => embeddingController.abort();
        controller.signal.addEventListener('abort', cancelEmbedding, { once: true });
        let rejectEmbedding!: (error: Error) => void;
        const embeddingStop = new Promise<never>((_, reject) => { rejectEmbedding = reject; });
        const embeddingTimer = setTimeout(() => { rejectEmbedding(new Error('embedding-timeout')); embeddingController.abort(); }, WIDE_PIPELINE_CONFIG.embeddingTimeoutMs);
        try {
          return await Promise.race([embedder.embed([query.embeddingInput], 'query', { signal: embeddingController.signal }), embeddingStop]);
        } finally {
          clearTimeout(embeddingTimer);
          controller.signal.removeEventListener('abort', cancelEmbedding);
          embeddingController.abort();
        }
      };
      let embedded;
      for (let attempt = 1; ; attempt++) {
        try { embedded = await embedOnce(); break; } catch (error) {
          if (controller.signal.aborted || attempt >= WIDE_PIPELINE_CONFIG.embeddingAttempts) throw error;
          trace.embeddingRetries = attempt;
        }
      }
      if (controller.signal.aborted) throw new Error('aborted');
      if (embedded.model !== index!.embedding.model || embedded.dimensions !== index!.embedding.dimensions
        || embedded.vectors.length !== 1 || !Number.isSafeInteger(embedded.inputTokens) || embedded.inputTokens < 0) return unavailableResult('embedding-response');
      trace.embedding = { status: 'complete', inputTokens: embedded.inputTokens, costUsd: embedded.inputTokens * WIDE_PIPELINE_CONFIG.embeddingUsdPerMillionTokens / 1_000_000 };
      changeStage('search');
      trace.search = search!.search({ question: query.question, context: query.context, vector: embedded.vectors[0] },
        { denseLimit: index!.units.length, lexicalLimit: 24, candidateLimit: 24 });
      changeStage('selection');
      const selection = selectWideEvidence({ units: index!.units, dense: trace.search.dense });
      changeStage('resolved');
      if (controller.signal.aborted) throw new Error('aborted');
      if (selection.kind === 'unavailable') return unavailableResult(`selection-${selection.reason}`);
      trace.wide = { alwaysIds: selection.always.map(unit => unit.id), retrievedIds: selection.retrieved.map(unit => unit.id),
        droppedIds: selection.droppedIds, evidenceBytes: selection.evidenceBytes, overviewPresent: selection.overviewPresent };
      return finish({ kind: 'evidence', selected: selection.retrieved, always: selection.always } as Omit<RagResolution, 'trace'>);
    };
    try {
      return await Promise.race([run(), stopPromise]);
    } catch {
      if (stopped === 'cancelled' || input.signal?.aborted) return finish({ kind: 'cancelled' });
      trace.stages[stage] = performance.now() - stageStarted;
      return unavailableResult(stopped === 'timeout' ? 'retrieval-timeout' : `${stage}-error`);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  } };
}
