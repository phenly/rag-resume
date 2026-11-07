import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { TokenBudgetError, type VerifiedProviderCounter } from './token-budget';
import { VOYAGE_MODEL } from './voyage';

/** Published tokenizer + runtime are pinned independently of the hosted model. */
export const VOYAGE_TOKENIZER = Object.freeze({
  repository: 'MongoDB/voyage-4-large',
  revision: 'bb931c2635a93efe400c24741363d8ff61d7bb32',
  runtime: '@huggingface/tokenizers@0.2.0',
  tokenizerSha256: 'c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539',
  configSha256: '58c4abbc36eeccd8b3c8453f262225e8f2803855c88790760b618f4cd9e43be9',
  queryPrefix: 'Represent the query for retrieving supporting documents: ',
  verificationSource: 'https://docs.voyageai.com/docs/tokenization; https://docs.voyageai.com/reference/embeddings-api',
});

let loaded: Promise<Tokenizer> | undefined;

async function loadTokenizer(): Promise<Tokenizer> {
  const directory = path.join(process.cwd(), 'assets', 'tokenizers', 'voyage-4-large');
  try {
    const [tokenizerBytes, configBytes] = await Promise.all([
      readFile(path.join(directory, 'tokenizer.json')),
      readFile(path.join(directory, 'tokenizer_config.json')),
    ]);
    if (createHash('sha256').update(tokenizerBytes).digest('hex') !== VOYAGE_TOKENIZER.tokenizerSha256
      || createHash('sha256').update(configBytes).digest('hex') !== VOYAGE_TOKENIZER.configSha256) throw new Error();
    const tokenizer = JSON.parse(tokenizerBytes.toString('utf8'));
    // Never silently truncate/pad the count. The pinned artifact has neither.
    if (tokenizer.truncation !== null || tokenizer.padding !== null) throw new Error();
    return new Tokenizer(tokenizer, JSON.parse(configBytes.toString('utf8')));
  } catch {
    throw new TokenBudgetError('unavailable');
  }
}

/**
 * Local, credential-free, no runtime downloads. Mirrors Voyage's published model
 * tokenizer; also includes the documented input_type=query prefix, unlike the
 * Python SDK's raw-text count_tokens helper. Counts the joined text rather than
 * adding independent counts. Hosted-model drift still requires re-verification.
 * Create once during prepare, before the per-request retrieval deadline starts.
 */
export async function createVoyageQueryTokenCounter(): Promise<VerifiedProviderCounter> {
  if (!loaded) {
    const pending = loadTokenizer();
    loaded = pending;
    void pending.catch(() => { if (loaded === pending) loaded = undefined; });
  }
  const tokenizer = await loaded;
  return Object.freeze({
    model: VOYAGE_MODEL,
    revision: `voyage-query-prefix-1:${VOYAGE_TOKENIZER.revision}:${VOYAGE_TOKENIZER.tokenizerSha256}:${VOYAGE_TOKENIZER.runtime}`,
    verificationSource: VOYAGE_TOKENIZER.verificationSource,
    async count(text: string, signal?: AbortSignal) {
      if (signal?.aborted) throw new TokenBudgetError('cancelled');
      // Rust tokenizers require valid UTF-8. Reject unpaired UTF-16 surrogates
      // rather than silently replacing them differently in the JavaScript port.
      if (typeof text !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new TokenBudgetError('input');
      try {
        const result = tokenizer.encode(VOYAGE_TOKENIZER.queryPrefix + text, { add_special_tokens: true }).ids.length;
        if (signal?.aborted) throw new TokenBudgetError('cancelled');
        return result;
      } catch (error) {
        if (error instanceof TokenBudgetError) throw error;
        throw new TokenBudgetError('count');
      }
    },
  });
}
