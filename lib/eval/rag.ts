import { assertNever } from '../retrieval/assert-never';
import Anthropic from '@anthropic-ai/sdk';
import type { Corpus } from '../corpus';
import type { AskConfig } from '../claude';
import { buildRagSystemPrompt, buildSharedPromptPrefix, buildSystemPrompt, buildWideSystemPrompt } from '../prompt';
import { prepareProductionRagPipeline, createWholeFallbackGuard, UNAVAILABLE_ANSWER, activeRetrievalConfigVersion, generatorContextLimit } from '../retrieval/production';
import { RETRIEVAL_CONFIG_VERSION, type RagResolution } from '../retrieval/pipeline';
import { configuredStrategy, type RetrievalStrategy } from '../retrieval/load';
import { requestByteBound, fitsGeneratorContext } from '../retrieval/size-guard';
import { collectAnswer } from './whole';
import type { Answer, Approach } from './types';
import { evalHistory } from './cases';
import type { Turn } from '../history';

type History = readonly Pick<Turn, 'question' | 'answer'>[];
type Pipeline = { resolve(input: { question: string; verifiedHistory?: History }): Promise<RagResolution> };
/** Same prepared retrieval factory and fallback eligibility as the visitor route. */
export function ragApproach(config: AskConfig, options: {
  corpusDir: string;
  client?: Anthropic;
  strategy?: RetrievalStrategy;
  preparePipeline?: (corpus: Corpus) => Promise<Pipeline>;
  fallbackEligible?: (question: string, history?: History) => Promise<{ eligible: boolean }>;
}): Approach {
  const strategy = options.strategy ?? configuredStrategy();
  const unavailableResolution = (reason: string): RagResolution => ({ kind: 'unavailable', reason, trace: { strategy: 'wide', retrievalConfigVersion: activeRetrievalConfigVersion(strategy), elapsedMs: 0, stages: {}, unavailableReason: reason } });
  const client = options.client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
  let corpus: Corpus;
  let pipeline: Pipeline;
  let guard: (question: string, history?: History) => Promise<{ eligible: boolean }>;
  return {
    name: 'rag',
    // Keep legacy Jev receipts unchanged when the strategy is unset.
    ...(strategy === 'wide' ? { strategy } : {}),
    async prepare(input) {
      corpus = structuredClone(input);
      try { pipeline = await (options.preparePipeline?.(corpus) ?? prepareProductionRagPipeline({ corpus, corpusDir: options.corpusDir, config, client, strategy })); }
      catch { pipeline = { resolve: async () => strategy === 'wide' ? unavailableResolution('preparation') : ({ kind: 'fallback', reason: 'preparation', trace: { retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, elapsedMs: 0, stages: {}, fallbackReason: 'preparation' } }) }; }
      if (strategy !== 'wide') guard = options.fallbackEligible ?? ((question, history) => createWholeFallbackGuard({ corpus, corpusDir: options.corpusDir, config, client })({ question, history: evalHistory(history) }));
    },
    async answer(question, history): Promise<Answer> {
      if (!pipeline) throw new Error('RAG evaluation must be prepared');
      const turns = evalHistory(history).map(({ question, answer }) => ({ question, answer }));
      const start = performance.now();
      let resolved: RagResolution;
      try { resolved = await pipeline.resolve({ question, verifiedHistory: turns }); }
      catch (error) {
        if (strategy !== 'wide') throw error;
        const failure = error as { retrievalTrace?: RagResolution['trace'] } | undefined;
        resolved = unavailableResolution('resolve-error');
        if (failure?.retrievalTrace) resolved.trace = { ...failure.retrievalTrace, strategy: 'wide', unavailableReason: 'resolve-error' };
        else resolved.trace.elapsedMs = performance.now() - start;
      }
      const retrievalMs = performance.now() - start;
      const metadata = {
        retrievalTrace: resolved.trace,
        retrievedChunkIds: resolved.kind === 'evidence' ? [...(strategy === 'wide' ? resolved.always ?? [] : []), ...resolved.selected].map(unit => unit.id) : [],
        droppedByRerank: resolved.trace.rerank?.decisions.filter(item => item.reason !== 'selected').map(item => item.id) ?? [],
      };
      const unavailable = (reason: string): Answer => ({
        ...metadata, retrievedChunkIds: [], generationEligibility: { eligible: false, reason },
        text: UNAVAILABLE_ANSWER, effectiveApproach: 'unavailable', actualContext: 'none', suppliedEvidence: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        timings: { firstTokenMs: null, totalMs: performance.now() - start, stages: { retrieval: retrievalMs, generation: 0 } },
      });
      let system: ReturnType<typeof buildSystemPrompt>;
      switch (resolved.kind) {
      case 'cancelled': throw Object.assign(new Error('RAG evaluation cancelled'), metadata);
      case 'unavailable':
        if (strategy === 'wide') return unavailable(resolved.reason);
        return {
          ...metadata, generationEligibility: { eligible: false }, text: UNAVAILABLE_ANSWER, effectiveApproach: 'deterministic', actualContext: 'none',
          suppliedEvidence: buildSharedPromptPrefix(corpus).map(block => block.text).join('\n\n'),
          usage: { input_tokens: 0, output_tokens: 0 }, timings: { firstTokenMs: null, totalMs: performance.now() - start },
        };
      case 'route':
        if (strategy === 'wide') return unavailable('contract-violation:route');
        return {
          ...metadata, text: resolved.answer, effectiveApproach: 'deterministic', actualContext: 'none',
          suppliedEvidence: buildSharedPromptPrefix(corpus).map(block => block.text).join('\n\n'),
          usage: { input_tokens: 0, output_tokens: 0 },
          timings: { firstTokenMs: null, totalMs: performance.now() - start, stages: { retrieval: retrievalMs, generation: 0 } },
        };
      case 'evidence': system = strategy === 'wide' ? buildWideSystemPrompt(corpus, resolved.always ?? [], resolved.selected) : buildRagSystemPrompt(corpus, resolved.selected); break;
      case 'fallback':
        if (strategy === 'wide') return unavailable('contract-violation:fallback');
        system = buildSystemPrompt(corpus); break;
      default: assertNever(resolved);
      }
      try {
        if (strategy === 'wide') {
          const limit = generatorContextLimit();
          if (limit === undefined) return unavailable('context-limit-unconfigured');
          if (!fitsGeneratorContext({ byteBound: requestByteBound({ system, question, history: evalHistory(history) }), maxTokens: config.maxTokens, limit })) return unavailable('context-overflow');
        }
        const generationEligibility = strategy === 'wide' ? { eligible: true } : resolved.kind === 'fallback' || options.fallbackEligible ? await guard(question, turns) : await createWholeFallbackGuard({ corpus, corpusDir: options.corpusDir, config, client })({ question, system, history: evalHistory(turns) });
        if (!generationEligibility.eligible) return { ...metadata, generationEligibility, retrievedChunkIds: [], text: UNAVAILABLE_ANSWER, effectiveApproach: 'deterministic', actualContext: 'none', suppliedEvidence: buildSharedPromptPrefix(corpus).map(block => block.text).join('\n\n'), usage: { input_tokens: 0, output_tokens: 0 }, timings: { firstTokenMs: null, totalMs: performance.now() - start } };
        const generated = await collectAnswer(question, system, config, client, turns);
        return {
          ...generated, ...metadata, generationEligibility, effectiveApproach: resolved.kind === 'evidence' ? 'rag' : 'whole',
          actualContext: resolved.kind === 'evidence' ? strategy === 'wide' ? 'wide-evidence' : 'selected-evidence' : 'whole-corpus',
          timings: { firstTokenMs: generated.timings.firstTokenMs === null ? null : performance.now() - start - generated.timings.totalMs + generated.timings.firstTokenMs,
            totalMs: performance.now() - start, stages: { retrieval: retrievalMs, generation: generated.timings.totalMs } },
        };
      } catch (error) {
        throw Object.assign(error instanceof Object ? error : new Error('RAG generation failed'), metadata);
      }
    },
  };
}
