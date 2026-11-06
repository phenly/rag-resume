import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { VOYAGE_EMBEDDING_CONFIG } from './voyage';
import type { Extraction } from './extract';
import { buildLexicalStatistics, TOKENIZER_VERSION } from './lexical';
import { embeddingConfigKey, sealRetrievalIndex, validateRetrievalIndex, type EmbeddingConfig, type RetrievalIndex } from './index-schema';

export const EXTRACTOR_VERSION = '1';
export { TOKENIZER_VERSION } from './lexical';
export type DocumentEmbedder = {
  embed(texts: readonly string[], inputType: 'document', options?: { signal?: AbortSignal }): Promise<{ vectors: number[][]; inputTokens: number }>;
};
export type IndexSnapshot = { corpusVersion: string; extraction: Extraction };

/** No filesystem/network side effects except the explicitly injected embedder. */
export async function buildRetrievalIndex(options: {
  snapshot: IndexSnapshot;
  embedding: EmbeddingConfig;
  embedder: DocumentEmbedder;
  previous?: unknown;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<RetrievalIndex> {
  const { snapshot, embedding, embedder, signal } = options;
  const now = options.now ?? Date.now;
  const started = now();
  if (embeddingConfigKey(embedding) !== embeddingConfigKey(VOYAGE_EMBEDDING_CONFIG)) throw new Error('Index build: unsupported embedding configuration');
  signal?.throwIfAborted();
  const reusable = new Map<string, number[]>();
  const warnings: string[] = [];
  if (!embedding.revision) warnings.push('Hosted embedding model has no immutable revision; provider drift requires retrieval re-evaluation.');
  if (options.previous !== undefined) {
    // A corrupt or differently configured prior artifact is an error, never silently reused.
    const priorVersion = (options.previous as Partial<RetrievalIndex> | null)?.corpusVersion;
    const previous = validateRetrievalIndex(options.previous, { corpusVersion: priorVersion ?? '', embedding });
    if (previous.extractorVersion !== EXTRACTOR_VERSION) throw new Error('Index build: incompatible extractor version');
    for (const unit of previous.units) reusable.set(unit.indexedHash, unit.vector);
  }
  const units = snapshot.extraction.units.map(unit => ({ ...unit, vector: [] as number[] }));
  const missing: number[] = [];
  let reusedUnitCount = 0;
  units.forEach((unit, i) => {
    const vector = reusable.get(unit.indexedHash);
    if (vector) { unit.vector = [...vector]; reusedUnitCount++; }
    else missing.push(i);
  });
  let providerTokens = 0;
  // UTF-8 bytes are a conservative local budget, not a provider token measurement.
  // Oversize entries fail rather than truncating source text; actual tokens come from usage.
  const batches: number[][] = [];
  let batch: number[] = [];
  let bytes = 0;
  for (const i of missing) {
    const size = Buffer.byteLength(units[i].searchText, 'utf8');
    if (size > 8000) throw new Error('Index build: entry exceeds conservative 8000-byte batch budget');
    if (batch.length === 32 || bytes + size > 8000) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(i); bytes += size;
  }
  if (batch.length) batches.push(batch);
  for (const indexes of batches) {
    signal?.throwIfAborted();
    const result = await embedder.embed(indexes.map(i => units[i].searchText), 'document', { signal });
    if (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0 || result.vectors.length !== indexes.length) throw new Error('Index build: invalid embedding result');
    providerTokens += result.inputTokens;
    indexes.forEach((i, offset) => { units[i].vector = [...result.vectors[offset]]; });
  }
  signal?.throwIfAborted();
  const index = sealRetrievalIndex({
    schemaVersion: 1, corpusVersion: snapshot.corpusVersion, builtAt: new Date(started).toISOString(),
    extractorVersion: EXTRACTOR_VERSION, tokenizerVersion: TOKENIZER_VERSION, embedding,
    units, lexical: buildLexicalStatistics(units), globalRules: snapshot.extraction.globalRules,
    receipt: { sourceEntryCount: snapshot.extraction.sourceEntryCount, totalUnitCount: units.length,
      embeddedUnitCount: missing.length, reusedUnitCount, providerTokens,
      // Provider rate snapshot is configured below, with no free-credit assumptions.
      rateUsdPerMillionTokens: 0.12, costUsd: providerTokens * 0.12 / 1_000_000, elapsedMs: Math.max(0, now() - started), warnings },
  });
  return validateRetrievalIndex(index, { corpusVersion: snapshot.corpusVersion, embedding, units: snapshot.extraction.units, globalRules: snapshot.extraction.globalRules });
}

/** Caller supplies a fresh snapshot check; failures leave the destination untouched. */
export async function writeIndexAtomically(destination: string, index: RetrievalIndex, checkFresh: () => Promise<void>): Promise<void> {
  const temp = path.join(path.dirname(destination), `.retrieval-index-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(index) + '\n', 'utf8'); await file.sync(); }
    finally { await file.close(); }
    validateRetrievalIndex(JSON.parse(await readFile(temp, 'utf8')), { corpusVersion: index.corpusVersion, embedding: index.embedding });
    await checkFresh();
    await rename(temp, destination);
  } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Refuse to replace a file that the corpus itself reads, including aliases. */
export async function assertIndexOutputIsNotSource(destination: string, sources: string[]): Promise<void> {
  const output = path.resolve(destination);
  let existingOutput: string | undefined;
  try { existingOutput = await realpath(output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const source of sources) {
    const realSource = await realpath(source);
    if (path.resolve(source) === output || realSource === output || realSource === existingOutput) throw new Error('Index output collides with corpus source');
  }
}
