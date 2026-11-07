import type Anthropic from '@anthropic-ai/sdk';
import type { Turn } from '../history';
import type { QueryTokenCounter } from './query';
import type { EvidenceTokenCounter } from './rerank';
import { VOYAGE_MODEL } from './voyage';
import { JEV_MODEL } from './jev';

export const TOKEN_BUDGET_VERSION = 'provider-counts-1';
export type TokenBudgetErrorCode = 'unavailable' | 'configuration' | 'input' | 'count' | 'cancelled';
/** Never attach provider errors, request text, or credentials. */
export class TokenBudgetError extends Error {
  constructor(readonly code: TokenBudgetErrorCode) {
    super(`Token budget ${code}`);
    this.name = 'TokenBudgetError';
  }
}

/**
 * An integration must independently verify these claims before supplying a counter.
 * Metadata records that verification; it cannot establish tokenizer correctness.
 * Jev's counter must cover provider framing for the entire serialized request.
 */
export type VerifiedProviderCounter = {
  model: string;
  revision: string;
  verificationSource: string;
  count: (text: string, signal?: AbortSignal) => Promise<number>;
};
export type BudgetReadiness = { configured: true; model: string; revision: string; verificationSource: string; verification: 'caller-supplied' }
  | { configured: false; model: string; reason: 'verified-counter-missing' };

const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

async function guardedCount(operation: () => PromiseLike<{ input_tokens: number }> | Promise<number>, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw new TokenBudgetError('cancelled');
  let cancel: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(new TokenBudgetError('cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(async () => {
      if (signal?.aborted) throw new TokenBudgetError('cancelled');
      return await operation();
    }), aborted]);
    if (signal?.aborted) throw new TokenBudgetError('cancelled');
    const tokens = typeof result === 'number' ? result : result?.input_tokens;
    if (!validCount(tokens)) throw new TokenBudgetError('count');
    return tokens;
  } catch {
    throw new TokenBudgetError(signal?.aborted ? 'cancelled' : 'count');
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

/**
 * No default approximate tokenizer. Voyage documents its published model tokenizer:
 * https://docs.voyageai.com/docs/tokenization (checked 2026-11-06).
 * TypeSafe's System One/models/reference index documents context limits but no
 * tokenizer, preflight count endpoint, or framing upper bound (checked 2026-11-06):
 * https://docs.typesafe.ai/api/system-one, https://docs.typesafe.ai/models,
 * https://docs.typesafe.ai/llms.txt. That absence blocks a built-in Jev counter.
 * Do not substitute character/byte ratios, another provider's tokenizer, or usage
 * from an earlier request for either provider's verified preflight count.
 */
export function createRetrievalTokenBudgets(options: {
  voyage?: VerifiedProviderCounter;
  jev?: VerifiedProviderCounter;
} = {}): {
  query: QueryTokenCounter;
  jev: (serializedContext: string, signal?: AbortSignal) => Promise<number>;
  readiness: { query: BudgetReadiness; jev: BudgetReadiness };
} {
  const bind = (counter: VerifiedProviderCounter | undefined, model: string) => {
    if (counter && (counter.model !== model || typeof counter.revision !== 'string' || !counter.revision.trim()
      || typeof counter.verificationSource !== 'string' || !counter.verificationSource.trim() || typeof counter.count !== 'function')) {
      throw new TokenBudgetError('configuration');
    }
    // Snapshot configuration so external mutation cannot change a prepared adapter.
    const count = counter?.count;
    const readiness: BudgetReadiness = counter
      ? { configured: true, model, revision: counter.revision, verificationSource: counter.verificationSource, verification: 'caller-supplied' }
      : { configured: false, model, reason: 'verified-counter-missing' };
    return { readiness, count: async (text: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new TokenBudgetError('cancelled');
      if (typeof text !== 'string') throw new TokenBudgetError('input');
      if (!count) throw new TokenBudgetError('unavailable');
      return guardedCount(() => count(text, signal), signal);
    } };
  };
  const query = bind(options.voyage, VOYAGE_MODEL);
  const jev = bind(options.jev, JEV_MODEL);
  return {
    query: (text, { signal }) => query.count(text, signal),
    jev: jev.count,
    readiness: { query: query.readiness, jev: jev.readiness },
  };
}

type System = Anthropic.Beta.BetaTextBlockParam[];
type CountMethod = Anthropic['beta']['messages']['countTokens'];

/**
 * Counts the actual rendered text with the configured generator's API, not a byte
 * estimate. The endpoint itself describes counts as estimates, not a mathematical
 * bound: https://platform.claude.com/docs/en/build-with-claude/token-counting
 * (checked 2026-11-06). Evidence counts retain the complete request/probe overhead
 * rather than subtracting independent counts, which need not be additive.
 * No caching, hidden retries, raw errors, or model fallbacks. The caller's retrieval
 * deadline must encompass these network calls; abort wins even if a mock ignores it.
 */
/** Pass countTokens as a bound SDK method or a closure preserving its client receiver. */
export function createGenerationTokenBudget(options: { model: string; countTokens: CountMethod }) {
  if (typeof options.model !== 'string' || !options.model.trim() || typeof options.countTokens !== 'function') throw new TokenBudgetError('configuration');
  const model = options.model;
  const countTokens = options.countTokens;
  const countRequest = async (input: { system: System; question: string; history?: readonly Pick<Turn, 'question' | 'answer'>[] }, callOptions: { signal?: AbortSignal } = {}) => {
    if (typeof input.question !== 'string' || !input.question.trim() || !Array.isArray(input.system)
      || input.system.some(block => block?.type !== 'text' || typeof block.text !== 'string')
      || (input.history !== undefined && (!Array.isArray(input.history) || Array.from(input.history).some(turn => !turn || typeof turn.question !== 'string' || typeof turn.answer !== 'string')))) throw new TokenBudgetError('input');
    const system = structuredClone(input.system);
    const messages = [
      ...(input.history ?? []).flatMap(turn => [{ role: 'user' as const, content: turn.question }, { role: 'assistant' as const, content: turn.answer }]),
      { role: 'user' as const, content: input.question },
    ];
    return guardedCount(() => countTokens({ model, ...(system.length ? { system } : {}), messages }, { signal: callOptions.signal, maxRetries: 0 }), callOptions.signal);
  };
  const countEvidence: EvidenceTokenCounter = (text, { signal }) => {
    if (typeof text !== 'string') return Promise.reject(new TokenBudgetError('input'));
    return countRequest({ system: [{ type: 'text', text }], question: '.' }, { signal });
  };
  return { model, version: TOKEN_BUDGET_VERSION, countEvidence, countRequest };
}
