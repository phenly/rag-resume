import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, type Turn } from '../history';

export const RETRIEVAL_QUERY_VERSION = 'context-query-1';
export const RETRIEVAL_QUERY_MAX_TOKENS = 1024;
export type VerifiedQueryTurn = Pick<Turn, 'question' | 'answer'>;
/** Must count with the embedding provider's tokenizer, including serialized labels. */
export type QueryTokenCounter = (text: string, options: { signal?: AbortSignal }) => Promise<number>;
export type RetrievalQueryResult = {
  ok: true;
  question: string;
  /** Retained question/answer text only, for BM25; never includes serialization labels. */
  context: string;
  embeddingInput: string;
  inputTokens: number;
  /** Newest first. Authentic prior answers are context, never factual evidence. */
  retainedTurns: VerifiedQueryTurn[];
  droppedTurns: number;
  truncatedAnswer: boolean;
} | { ok: false; reason: 'invalid-input' | 'question-over-budget' | 'token-counter' | 'cancelled' };

class QueryFailure extends Error {
  constructor(readonly reason: 'token-counter' | 'cancelled') { super(reason); }
}

/** JSON keeps embedded labels/delimiters in visitor text inside data fields. */
function serialize(question: string, history: readonly VerifiedQueryTurn[]): string {
  return history.length ? JSON.stringify({ currentQuestion: question, conversationContextNewestFirst: history }) : question;
}

/** Complete sentence prefixes only; never slice a code point or an unfinished sentence. */
function shorterSentencePrefixes(answer: string): string[] {
  const prefixes: string[] = [];
  const endings = /[.!?。！？](?:["'”’)\]]*)(?=\s|$)|[。！？]/gu;
  for (const match of answer.matchAll(endings)) {
    const prefix = answer.slice(0, match.index! + match[0].length).trimEnd();
    if (prefix.length < answer.length) prefixes.push(prefix);
  }
  return prefixes.reverse();
}

/**
 * Caller must pass only history accepted by the existing signature/limit checks.
 * This helper does not authenticate turns or perform provider calls. It snapshots
 * inputs before awaiting, counts the actual embedding string, and never drops any
 * part of the current question. Token-count failures require whole fallback.
 */
export async function buildRetrievalQuery(options: {
  question: string;
  verifiedHistory?: readonly VerifiedQueryTurn[];
  countTokens: QueryTokenCounter;
  signal?: AbortSignal;
  /** A smaller cap is useful for tests; callers cannot raise the production cap. */
  maxTokens?: number;
}): Promise<RetrievalQueryResult> {
  const { signal, countTokens } = options;
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  const maxTokens = options.maxTokens ?? RETRIEVAL_QUERY_MAX_TOKENS;
  const history = options.verifiedHistory ?? [];
  if (typeof options.question !== 'string' || !options.question.trim() || typeof countTokens !== 'function'
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > RETRIEVAL_QUERY_MAX_TOKENS
    || !Array.isArray(history) || history.length > MAX_HISTORY_TURNS
    || Array.from(history).some(turn => !turn || typeof turn.question !== 'string' || typeof turn.answer !== 'string')
    || history.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0) > MAX_HISTORY_CHARS) {
    return { ok: false, reason: 'invalid-input' };
  }
  const question = options.question.trim();
  const historyLength = history.length;
  const retained = history.slice(-2).reverse().map(turn => ({ question: turn.question.trim(), answer: turn.answer.trim() }));
  const measure = async (text: string): Promise<number> => {
    if (signal?.aborted) throw new QueryFailure('cancelled');
    let cancel: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(new QueryFailure('cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
      });
      const count = await Promise.race([Promise.resolve().then(() => countTokens(text, { signal })), aborted]);
      if (signal?.aborted) throw new QueryFailure('cancelled');
      if (!Number.isSafeInteger(count) || count < 0) throw new QueryFailure('token-counter');
      return count;
    } catch (error) {
      if (signal?.aborted || error instanceof QueryFailure && error.reason === 'cancelled') throw new QueryFailure('cancelled');
      throw new QueryFailure('token-counter');
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  };
  const result = (turns: VerifiedQueryTurn[], embeddingInput: string, inputTokens: number, truncatedAnswer = false): RetrievalQueryResult => ({
    ok: true, question, context: turns.flatMap(turn => [turn.question, turn.answer]).join('\n'), embeddingInput, inputTokens,
    retainedTurns: turns, droppedTurns: historyLength - turns.length, truncatedAnswer,
  });
  try {
    const questionTokens = await measure(question);
    if (questionTokens > maxTokens) return { ok: false, reason: 'question-over-budget' };
    // Drop the oldest complete turn before shortening the newest answer.
    while (retained.length) {
      const input = serialize(question, retained);
      const tokens = await measure(input);
      if (tokens <= maxTokens) return result(retained, input, tokens);
      if (retained.length > 1) { retained.pop(); continue; }
      const newest = retained[0];
      for (const answer of shorterSentencePrefixes(newest.answer)) {
        const turns = [{ question: newest.question, answer }];
        const shortened = serialize(question, turns);
        const shortenedTokens = await measure(shortened);
        if (shortenedTokens <= maxTokens) return result(turns, shortened, shortenedTokens, true);
      }
      // No complete sentence fits: omit that turn rather than clipping its text.
      retained.pop();
    }
    return result([], question, questionTokens);
  } catch (error) {
    return { ok: false, reason: error instanceof QueryFailure ? error.reason : 'token-counter' };
  }
}
