import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrievalCorpusFixture } from './fixtures/retrieval-corpus';
import { loadCorpus } from '../lib/corpus';
import { prepareRagPipeline, RETRIEVAL_CONFIG_VERSION } from '../lib/retrieval/pipeline';
import type { JevQuestion } from '../lib/retrieval/jev';

async function setup(route = 'answer') {
  const f = await retrievalCorpusFixture();
  const corpus = await loadCorpus(f.dir);
  const embed = vi.fn(async () => ({ model: 'voyage-4-large' as const, dimensions: 1024 as const, vectors: [Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)], inputTokens: 20 }));
  const judge = vi.fn(async (questions: readonly JevQuestion[]) => ({ model: 'jev-1.13.0' as const, judgments: questions.map(({ id }) => ({ id, probability: id === `route_${route}` || id.startsWith('candidate_') || id === 'adequacy' ? 1 : 0 })), inputTokens: 100, outputTokens: 1, costUsd: .001 }));
  const options = { corpus, corpusDir: f.dir, embedder: { embed }, judge: { judge }, countQueryTokens: vi.fn(async () => 20), countEvidenceTokens: vi.fn(async () => 100) };
  return { f, options, embed, judge };
}
afterEach(() => vi.useRealTimers());
describe('request-scoped RAG composition', () => {
  it('searches and judges complete evidence with independent traces', async () => {
    const { options, embed, judge } = await setup();
    const pipeline = await prepareRagPipeline(options);
    const results = await Promise.all(['widgets', 'company'].map(question => pipeline.resolve({ question })));
    for (const result of results) {
      expect(result.kind).toBe('evidence');
      expect(result.trace).toMatchObject({ retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, embedding: { status: 'complete', inputTokens: 20 }, stages: { query: expect.any(Number), embedding: expect.any(Number), search: expect.any(Number), selection: expect.any(Number) } });
      expect(result.trace.rerank?.calls).toHaveLength(2);
    }
    expect(results[0].trace).not.toBe(results[1].trace);
    expect(embed).toHaveBeenCalledTimes(2); expect(judge).toHaveBeenCalledTimes(4);
  });
  it.each(['redirect', 'decline'])('returns reviewed %s text without a generator', async route => {
    const { options } = await setup(route);
    const pipeline = await prepareRagPipeline(options);
    expect(await pipeline.resolve({ question: 'private question' })).toMatchObject({ kind: 'route', route, answer: expect.stringContaining('Pat Example') });
  });
  it('falls back on stale index without paid calls', async () => {
    const { options, embed } = await setup();
    const pipeline = await prepareRagPipeline({ ...options, loadIndex: async () => ({ status: 'stale' }) });
    expect(await pipeline.resolve({ question: 'widgets' })).toMatchObject({ kind: 'fallback', reason: 'index-stale' }); expect(embed).not.toHaveBeenCalled();
  });
  it('preserves embedding bill when judgments fail', async () => {
    const { options } = await setup();
    options.judge.judge = vi.fn(async () => { throw new Error('fictional failure'); });
    const result = await (await prepareRagPipeline(options)).resolve({ question: 'widgets' });
    expect(result).toMatchObject({ kind: 'fallback', trace: { embedding: { status: 'complete' }, rerank: { calls: [{ status: 'usage-unknown' }] } } });
  });
  it('aborts embedding at two seconds even if an injected provider ignores its signal', async () => {
    const { options } = await setup(); const pipeline = await prepareRagPipeline({ ...options, embedder: { embed: () => new Promise(() => {}) } });
    vi.useFakeTimers(); const pending = pipeline.resolve({ question: 'widgets' });
    await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toMatchObject({ kind: 'fallback', trace: { embedding: { status: 'usage-unknown' } } });
  });
  it('enforces total deadline during query counting', async () => {
    const { options } = await setup(); const pipeline = await prepareRagPipeline({ ...options, countQueryTokens: () => new Promise(() => {}) });
    vi.useFakeTimers(); const pending = pipeline.resolve({ question: 'widgets' }); await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'retrieval-timeout' });
  });
  it('cancels without fallback and avoids providers on pre-abort', async () => {
    const { options, embed } = await setup(); const pipeline = await prepareRagPipeline(options);
    expect(await pipeline.resolve({ question: 'widgets', signal: AbortSignal.abort() })).toMatchObject({ kind: 'cancelled' }); expect(embed).not.toHaveBeenCalled();
  });
});
it('cancels mid-embedding and does not start selection or mutate the returned trace later', async () => {
  const { options, judge } = await setup();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let complete!: (result: Awaited<ReturnType<typeof options.embedder.embed>>) => void;
  const embedding = new Promise<Awaited<ReturnType<typeof options.embedder.embed>>>(resolve => { complete = resolve; });
  const pipeline = await prepareRagPipeline({ ...options, embedder: { embed: async () => { entered(); return embedding; } } });
  const abort = new AbortController(); const pending = pipeline.resolve({ question: 'widgets', signal: abort.signal });
  await started; abort.abort(); const result = await pending;
  expect(result.kind).toBe('cancelled'); const receipt = JSON.stringify(result.trace);
  complete({ model: 'voyage-4-large', dimensions: 1024, vectors: [Array(1024).fill(1)], inputTokens: 10 });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(JSON.stringify(result.trace)).toBe(receipt); expect(judge).not.toHaveBeenCalled();
});
it('rejects malformed embedding geometry and preserves its known charge', async () => {
  const { options, judge } = await setup();
  const pipeline = await prepareRagPipeline({ ...options, embedder: { embed: async () => ({ model: 'voyage-4-large', dimensions: 1024, vectors: [[1]], inputTokens: 10 }) } });
  expect(await pipeline.resolve({ question: 'widgets' })).toMatchObject({ kind: 'fallback', trace: { embedding: { status: 'complete', inputTokens: 10 } } }); expect(judge).not.toHaveBeenCalled();
});
