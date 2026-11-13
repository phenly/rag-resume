import { afterEach, expect, it, vi } from 'vitest';
import { corpusFixture } from './fixtures/corpus';
import { generateWideUnits, wideFixtureVector, wideRetrievalCorpusFixture } from './fixtures/wide-retrieval-corpus';
import { loadCorpus } from '../lib/corpus';
import { sealRetrievalIndex } from '../lib/retrieval/index-schema';
import { buildLexicalStatistics } from '../lib/retrieval/lexical';
import { EXTRACTOR_VERSION, TOKENIZER_VERSION } from '../lib/retrieval/build-index';
import { VOYAGE_EMBEDDING_CONFIG, type Embedder } from '../lib/retrieval/voyage';
import { prepareWidePipeline, WIDE_CONFIG_VERSION, type PrepareWidePipelineOptions } from '../lib/retrieval/pipeline-wide';
import { RETRIEVAL_CONFIG_VERSION } from '../lib/retrieval/pipeline';
import { assertNever } from '../lib/retrieval/assert-never';

async function setup() {
  const f = await corpusFixture(); const corpus = await loadCorpus(f.dir);
  const units = [...wideRetrievalCorpusFixture().units, ...generateWideUnits(128)];
  const index = sealRetrievalIndex({ schemaVersion: 1, corpusVersion: corpus.version, builtAt: new Date().toISOString(), extractorVersion: EXTRACTOR_VERSION,
    tokenizerVersion: TOKENIZER_VERSION, embedding: VOYAGE_EMBEDDING_CONFIG, units, lexical: buildLexicalStatistics(units), globalRules: '',
    receipt: { sourceEntryCount: units.filter(u => u.kind === 'entry').length, totalUnitCount: units.length, embeddedUnitCount: units.length,
      reusedUnitCount: 0, providerTokens: 0, rateUsdPerMillionTokens: .12, costUsd: 0, elapsedMs: 0, warnings: [] } });
  const response = { model: 'voyage-4-large' as const, dimensions: 1024 as const, vectors: [wideFixtureVector(0)], inputTokens: 20 };
  const embed = vi.fn<Embedder['embed']>(async () => response);
  const options: PrepareWidePipelineOptions = { corpus, corpusDir: f.dir, embedder: { embed }, countQueryTokens: vi.fn(async () => 20), loadIndex: async () => ({ status: 'ready', index }) };
  return { options, embed, index, response };
}
afterEach(() => vi.useRealTimers());
it('returns always and retrieved evidence and records the trace; embeds exactly once without a judge option', async () => {
  const { options, embed } = await setup();
  type NoJudge = 'judge' extends keyof PrepareWidePipelineOptions ? false : true;
  const noJudge: NoJudge = true; expect(noJudge).toBe(true);
  const result = await (await prepareWidePipeline(options)).resolve({ question: 'lantern' });
  expect(result.kind).toBe('evidence'); if (result.kind !== 'evidence') throw new Error('Expected evidence');
  expect(result.trace).toMatchObject({ strategy: 'wide', retrievalConfigVersion: WIDE_CONFIG_VERSION, wide: {
    alwaysIds: result.always!.map(u => u.id), retrievedIds: result.selected.map(u => u.id) } });
  expect(result.selected).toHaveLength(40); expect(embed).toHaveBeenCalledOnce(); expect(result.trace.rerank).toBeUndefined();
});
it('dense trace includes every unit, including ranks 72 and 128', async () => {
  const { options, index } = await setup(); const result = await (await prepareWidePipeline(options)).resolve({ question: 'orchard' });
  expect(result.trace.search?.dense).toHaveLength(index.units.length);
  expect(result.trace.search?.dense[71]).toBeDefined(); expect(result.trace.search?.dense[127]).toBeDefined();
});
it('index not ready is unavailable', async () => {
  const { options, embed } = await setup(); const pipeline = await prepareWidePipeline({ ...options, loadIndex: async () => ({ status: 'missing' }) });
  expect(pipeline.ready).toBe(false); expect(await pipeline.resolve({ question: 'lantern' })).toMatchObject({ kind: 'unavailable', reason: 'index-missing' }); expect(embed).not.toHaveBeenCalled();
});
it.each([{ model: 'wrong' }, { dimensions: 2 }])('rejects mismatched embedding response %j', async patch => {
  const { options, response, embed } = await setup(); embed.mockResolvedValue({ ...response, ...patch } as typeof response);
  expect(await (await prepareWidePipeline(options)).resolve({ question: 'lantern' })).toMatchObject({ kind: 'unavailable', reason: 'embedding-response' });
});
it('two embeddings each slower than 2000 ms are unavailable and aborted', async () => {
  const { options, embed } = await setup(); let signal: AbortSignal | undefined;
  embed.mockImplementation((_texts, _type, input) => { signal = input?.signal; return new Promise(() => {}); });
  const pipeline = await prepareWidePipeline(options); vi.useFakeTimers(); const pending = pipeline.resolve({ question: 'lantern' });
  await vi.advanceTimersByTimeAsync(4002); expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'embedding-error' }); expect(signal?.aborted).toBe(true); expect(embed).toHaveBeenCalledTimes(2);
});
it('abort before start returns cancelled', async () => {
  const { options, embed } = await setup(); expect(await (await prepareWidePipeline(options)).resolve({ question: 'lantern', signal: AbortSignal.abort() })).toMatchObject({ kind: 'cancelled' }); expect(embed).not.toHaveBeenCalled();
});
it('abort during embedding returns cancelled and late completion cannot mutate the trace', async () => {
  const { options, embed, response } = await setup(); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  let complete!: (value: typeof response) => void; const embedding = new Promise<typeof response>(r => { complete = r; });
  embed.mockImplementation(async () => { entered(); return embedding; }); const pipeline = await prepareWidePipeline(options);
  const controller = new AbortController(); const pending = pipeline.resolve({ question: 'lantern', signal: controller.signal }); await started; controller.abort();
  const result = await pending; expect(result.kind).toBe('cancelled'); const receipt = JSON.stringify(result.trace);
  complete(response); await new Promise(r => setTimeout(r, 0)); expect(JSON.stringify(result.trace)).toBe(receipt);
});
it('verified history reaches embedding and lexical context but never selected units', async () => {
  const { options, embed } = await setup(); const result = await (await prepareWidePipeline(options)).resolve({ question: 'more?', verifiedHistory: [{ question: 'prism', answer: 'Unique imaginary conversation.' }] });
  expect(embed.mock.calls[0][0][0]).toContain('Unique imaginary conversation.'); expect(result.trace.search?.lexical.some(m => m.id === 'LANTERN-PRISM')).toBe(true);
  expect(result.kind).toBe('evidence'); if (result.kind === 'evidence') expect(JSON.stringify([...result.selected, ...result.always!])).not.toContain('Unique imaginary conversation.');
});
it('existing Jev config version is unchanged', () => expect(RETRIEVAL_CONFIG_VERSION).toBe('738011460764090aa0079c77e14bf7d7158307482fd45cb69022d6fd90b8d758'));
it('assertNever rejects future kinds at compile time and runtime', () => {
  expect(() => {
    // @ts-expect-error Future resolutions must be handled before assertNever.
    assertNever({ kind: 'future' });
  }).toThrow('Unexpected RAG resolution');
});
it('retries a failed query embedding once and then serves evidence', async () => {
  const { options, embed, response } = await setup();
  embed.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response);
  const result = await (await prepareWidePipeline(options)).resolve({ question: 'lantern' });
  expect(result.kind).toBe('evidence'); expect(embed).toHaveBeenCalledTimes(2); expect(result.trace.embeddingRetries).toBe(1);
});
it('is unavailable with embedding-error after two failed embeddings, with no third call', async () => {
  const { options, embed } = await setup();
  embed.mockRejectedValue(new Error('network'));
  const result = await (await prepareWidePipeline(options)).resolve({ question: 'lantern' });
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'embedding-error' }); expect(embed).toHaveBeenCalledTimes(2);
});
