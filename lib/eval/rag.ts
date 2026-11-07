import Anthropic from '@anthropic-ai/sdk';
import type { Corpus } from '../corpus';
import type { AskConfig } from '../claude';
import { buildRagSystemPrompt, buildSystemPrompt } from '../prompt';
import { prepareProductionRagPipeline, createWholeFallbackGuard, UNAVAILABLE_ANSWER } from '../retrieval/production';
import { RETRIEVAL_CONFIG_VERSION, type RagResolution } from '../retrieval/pipeline';
import { collectAnswer } from './whole';
import type { Answer, Approach } from './types';

type Pipeline = { resolve(input: { question: string }): Promise<RagResolution> };
/** Same prepared retrieval factory and fallback eligibility as the visitor route. */
export function ragApproach(config: AskConfig, options: {
  corpusDir: string;
  client?: Anthropic;
  preparePipeline?: (corpus: Corpus) => Promise<Pipeline>;
  fallbackEligible?: (question: string) => Promise<{ eligible: boolean }>;
}): Approach {
  const client = options.client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
  let corpus: Corpus;
  let pipeline: Pipeline;
  let guard: (question: string) => Promise<{ eligible: boolean }>;
  return {
    name: 'rag',
    async prepare(input) {
      corpus = structuredClone(input);
      try { pipeline = await (options.preparePipeline?.(corpus) ?? prepareProductionRagPipeline({ corpus, corpusDir: options.corpusDir, config, client })); }
      catch { pipeline = { resolve: async () => ({ kind: 'fallback', reason: 'preparation', trace: { retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, elapsedMs: 0, stages: {}, fallbackReason: 'preparation' } }) }; }
      const fallbackGuard = createWholeFallbackGuard({ corpus, corpusDir: options.corpusDir, config, client });
      guard = options.fallbackEligible ?? (question => fallbackGuard({ question }));
    },
    async answer(question): Promise<Answer> {
      if (!pipeline) throw new Error('RAG evaluation must be prepared');
      const start = performance.now();
      const resolved = await pipeline.resolve({ question });
      const retrievalMs = performance.now() - start;
      const metadata = {
        retrievalTrace: resolved.trace,
        retrievedChunkIds: resolved.kind === 'evidence' ? resolved.selected.map(unit => unit.id) : [],
        droppedByRerank: resolved.trace.rerank?.decisions.filter(item => item.reason !== 'selected').map(item => item.id) ?? [],
      };
      if (resolved.kind === 'cancelled') throw Object.assign(new Error('RAG evaluation cancelled'), metadata);
      if (resolved.kind === 'route') return {
        ...metadata, text: resolved.answer, effectiveApproach: 'deterministic', actualContext: 'none',
        usage: { input_tokens: 0, output_tokens: 0 },
        timings: { firstTokenMs: null, totalMs: performance.now() - start, stages: { retrieval: retrievalMs, generation: 0 } },
      };
      try {
        const system = resolved.kind === 'evidence' ? buildRagSystemPrompt(corpus, resolved.selected) : buildSystemPrompt(corpus);
        const generationEligibility = resolved.kind === 'fallback' || options.fallbackEligible ? await guard(question) : await createWholeFallbackGuard({ corpus, corpusDir: options.corpusDir, config, client })({ question, system });
        if (!generationEligibility.eligible) return { ...metadata, generationEligibility, retrievedChunkIds: [], text: UNAVAILABLE_ANSWER, effectiveApproach: 'deterministic', actualContext: 'none', usage: { input_tokens: 0, output_tokens: 0 }, timings: { firstTokenMs: null, totalMs: performance.now() - start } };
        const generated = await collectAnswer(question, system, config, client);
        return {
          ...generated, ...metadata, generationEligibility, effectiveApproach: resolved.kind === 'evidence' ? 'rag' : 'whole',
          actualContext: resolved.kind === 'evidence' ? 'selected-evidence' : 'whole-corpus',
          timings: { firstTokenMs: generated.timings.firstTokenMs === null ? null : performance.now() - start - generated.timings.totalMs + generated.timings.firstTokenMs,
            totalMs: performance.now() - start, stages: { retrieval: retrievalMs, generation: generated.timings.totalMs } },
        };
      } catch (error) {
        throw Object.assign(error instanceof Object ? error : new Error('RAG generation failed'), metadata);
      }
    },
  };
}
