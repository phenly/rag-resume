import Anthropic from '@anthropic-ai/sdk';
import type { AskConfig } from '../claude';
import type { Corpus } from '../corpus';
import type { Turn } from '../history';
import { buildSystemPrompt } from '../prompt';
import { createVoyageEmbedder, type Embedder } from './voyage';
import { createJevClient } from './jev';
import { createRetrievalTokenBudgets, createGenerationTokenBudget } from './token-budget';
import { createVoyageQueryTokenCounter } from './voyage-tokenizer';
import { prepareRagPipeline, RETRIEVAL_CONFIG_VERSION, type RagPipeline } from './pipeline';
import { prepareWidePipeline, WIDE_CONFIG_VERSION } from './pipeline-wide';
import { configuredStrategy, type RetrievalStrategy, type inspectRetrievalIndex } from './load';

export const UNAVAILABLE_ANSWER = "I can't answer that right now. Please try again shortly.";
type Options = { corpus: Corpus; corpusDir: string; config: AskConfig; client?: Anthropic; env?: Record<string, string | undefined>; embedder?: Embedder; loadIndex?: typeof inspectRetrievalIndex };

/** Operator-supplied actual generator context limit; never infer it from a model name. */
export function generatorContextLimit(env: Record<string, string | undefined> = process.env): number | undefined {
  const value = env.RAG_GENERATOR_CONTEXT_TOKENS;
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : undefined;
}

/** Local preparation only: no embedding, judgment, or generator count calls. */
export async function prepareProductionRagPipeline(options: Options & { strategy?: RetrievalStrategy }): Promise<RagPipeline> {
  const env = options.env ?? process.env;
  if (generatorContextLimit(env) === undefined) throw new Error('RAG generator context limit is unconfigured');
  const strategy = options.strategy ?? configuredStrategy(env);
  const voyage = await createVoyageQueryTokenCounter();
  const budgets = createRetrievalTokenBudgets({ voyage });
  const shared = {
    corpus: options.corpus, corpusDir: options.corpusDir,
    embedder: options.embedder ?? createVoyageEmbedder({ apiKey: env.VOYAGE_API_KEY ?? '', timeoutMs: 2000 }),
    countQueryTokens: budgets.query, loadIndex: options.loadIndex,
  };
  if (strategy === 'wide') return prepareWidePipeline(shared);
  const client = options.client ?? new Anthropic({ apiKey: options.config.apiKey, maxRetries: 0 });
  const generation = createGenerationTokenBudget({ model: options.config.model, countTokens: client.beta.messages.countTokens.bind(client.beta.messages) });
  return prepareRagPipeline({
    ...shared,
    judge: createJevClient({ apiKey: env.TYPESAFE_API_KEY ?? '', budgetMode: 'provider-enforced', timeoutMs: 3000 }),
    countEvidenceTokens: generation.countEvidence,
  });
}

export function activeRetrievalConfigVersion(strategy: RetrievalStrategy): string {
  return strategy === 'wide' ? WIDE_CONFIG_VERSION : RETRIEVAL_CONFIG_VERSION;
}

export type WholeFallbackEligibility = { eligible: boolean; inputTokens?: number; reason?: 'context-limit-unconfigured' | 'context-overflow' | 'count-unavailable' | 'cancelled' };

/** Full rendered prompt, request framing, history and output reservation count together. */
export function createWholeFallbackGuard(options: Options) {
  const limit = generatorContextLimit(options.env);
  const client = options.client ?? new Anthropic({ apiKey: options.config.apiKey, maxRetries: 0 });
  const budget = createGenerationTokenBudget({ model: options.config.model, countTokens: client.beta.messages.countTokens.bind(client.beta.messages) });
  const system = buildSystemPrompt(options.corpus);
  return async (input: { question: string; history?: readonly Turn[]; signal?: AbortSignal; system?: ReturnType<typeof buildSystemPrompt> }): Promise<WholeFallbackEligibility> => {
    if (input.signal?.aborted) return { eligible: false, reason: 'cancelled' };
    if (limit === undefined) return { eligible: false, reason: 'context-limit-unconfigured' };
    try {
      const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(5000)]);
      const inputTokens = await budget.countRequest({ system: input.system ?? system, question: input.question, history: input.history }, { signal });
      return inputTokens + options.config.maxTokens <= limit
        ? { eligible: true, inputTokens }
        : { eligible: false, inputTokens, reason: 'context-overflow' };
    } catch {
      return { eligible: false, reason: input.signal?.aborted ? 'cancelled' : 'count-unavailable' };
    }
  };
}
