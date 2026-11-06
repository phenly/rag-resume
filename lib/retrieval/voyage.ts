/** Synchronous REST contract: https://docs.voyageai.com/reference/embeddings-api (checked 2026-11-06). */
export const VOYAGE_MODEL = 'voyage-4-large';
export const VOYAGE_DIMENSIONS = 1024;
export const VOYAGE_EMBEDDING_CONFIG = {
  provider: 'voyage', model: VOYAGE_MODEL, dimensions: VOYAGE_DIMENSIONS,
  encoding: 'float', normalization: 'l2', documentInputType: 'document',
  queryInputType: 'query', textFormatVersion: '1',
} as const;

export type EmbeddingResult = {
  vectors: number[][];
  model: typeof VOYAGE_MODEL;
  dimensions: typeof VOYAGE_DIMENSIONS;
  inputTokens: number;
};
export type Embedder = {
  embed(texts: readonly string[], inputType: 'document' | 'query', options?: { signal?: AbortSignal }): Promise<EmbeddingResult>;
};
export type VoyageErrorCode = 'configuration' | 'input' | 'cancelled' | 'timeout' | 'network' | 'http' | 'response';

/** Deliberately excludes provider bodies, source text, credentials, and underlying error causes. */
export class VoyageEmbeddingError extends Error {
  constructor(public readonly code: VoyageErrorCode, public readonly status?: number) {
    super(`Voyage embedding ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'VoyageEmbeddingError';
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new VoyageEmbeddingError('response'); };

function parseResponse(value: unknown, count: number): EmbeddingResult {
  if (!record(value) || (value.model !== undefined && value.model !== VOYAGE_MODEL) || !Array.isArray(value.data) || value.data.length !== count) return invalid();
  if (!record(value.usage) || !Number.isSafeInteger(value.usage.total_tokens) || (value.usage.total_tokens as number) < 0) return invalid();
  const vectors: number[][] = new Array(count);
  for (const item of value.data) {
    if (!record(item) || !Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= count || vectors[item.index as number] !== undefined) return invalid();
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length !== VOYAGE_DIMENSIONS || vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) return invalid();
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) return invalid();
    vectors[item.index as number] = vector.slice();
  }
  return { vectors, model: VOYAGE_MODEL, dimensions: VOYAGE_DIMENSIONS, inputTokens: value.usage.total_tokens as number };
}

/**
 * No implicit retries or batching: callers own accounting and any deliberate retry.
 * Raw provider vectors are retained; the index loader performs L2 normalization.
 * truncation:false makes provider context/batch token overflow fail instead of dropping text.
 */
export function createVoyageEmbedder(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): Embedder {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /\s/.test(options.apiKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new VoyageEmbeddingError('configuration');
  const request = options.fetch ?? globalThis.fetch;
  return {
    async embed(texts, inputType, callOptions = {}) {
      if (!Array.isArray(texts) || !texts.length || texts.length > 1000 || Array.from(texts).some(text => typeof text !== 'string' || !text.trim()) || (inputType !== 'document' && inputType !== 'query')) throw new VoyageEmbeddingError('input');
      if (callOptions.signal?.aborted) throw new VoyageEmbeddingError('cancelled');
      const controller = new AbortController();
      let abortCode: 'cancelled' | 'timeout' | undefined;
      let rejectAbort!: (error: VoyageEmbeddingError) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const abort = (code: 'cancelled' | 'timeout') => {
        if (abortCode) return;
        abortCode = code;
        rejectAbort(new VoyageEmbeddingError(code));
        controller.abort();
      };
      const cancel = () => abort('cancelled');
      callOptions.signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => abort('timeout'), timeoutMs);
      try {
        return await Promise.race([aborted, (async () => {
          const response = await request('https://api.voyageai.com/v1/embeddings', {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType, truncation: false, output_dimension: VOYAGE_DIMENSIONS, output_dtype: 'float', encoding_format: null }),
          });
          if (!response.ok) throw new VoyageEmbeddingError('http', response.status);
          let value: unknown;
          try { value = await response.json(); } catch { throw new VoyageEmbeddingError('response'); }
          return parseResponse(value, texts.length);
        })()]);
      } catch (error) {
        if (abortCode) throw new VoyageEmbeddingError(abortCode);
        if (error instanceof VoyageEmbeddingError) throw error;
        throw new VoyageEmbeddingError('network');
      } finally {
        clearTimeout(timer);
        callOptions.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
