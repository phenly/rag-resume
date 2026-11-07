import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { loadCorpus } from '../lib/corpus';
import { ragApproach } from '../lib/eval/rag';
import { retrievalCost, runApproach } from '../lib/eval/runner';
import { summarize } from '../lib/eval/report';
import { createWholeFallbackGuard, generatorContextLimit } from '../lib/retrieval/production';
import { RETRIEVAL_CONFIG_VERSION, type RagTrace } from '../lib/retrieval/pipeline';
import type { EvalCase } from '../lib/eval/types';
const config = { apiKey: 'fictional', model: 'fictional', effort: 'low' as const, maxTokens: 1000 };
const trace = (): RagTrace => ({ retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, elapsedMs: 1, stages: {}, embedding: { status: 'complete', inputTokens: 100, costUsd: .01 }, rerank: { configVersion: 'fictional', calls: [{ status: 'usage-unknown' }], relevance: [], decisions: [] } });
const corpus = () => loadCorpus('sample-corpus');
const client = (countTokens: (request: unknown) => Promise<{ input_tokens: number }> = vi.fn(async () => ({ input_tokens: 1000 }))) => ({ beta: { messages: { countTokens } } }) as unknown as Anthropic;
const c: EvalCase = { id: 'G1', question: 'widgets?', rubric: 'Use facts', category: 'grounded', status: 'decided', goldChunks: [], mustSay: [], mustNotSay: [], source: 'fictional' };
describe('RAG generation context guard', () => {
  it.each([undefined, '', '0', '-1', '1.5', 'NaN', '200k'])('rejects unverified limit %s', value => expect(generatorContextLimit({ RAG_GENERATOR_CONTEXT_TOKENS: value })).toBeUndefined());
  it('counts full request with history and output reservation at the boundary', async () => {
    const count = vi.fn(async (_request: unknown) => { void _request; return { input_tokens: 1000 }; });
    const guard = createWholeFallbackGuard({ corpus: await corpus(), corpusDir: '.', config, client: client(count), env: { RAG_GENERATOR_CONTEXT_TOKENS: '2000' } });
    expect(await guard({ question: 'widgets?', history: [{ question: 'first', answer: 'answer', sig: 'fictional' }] })).toEqual({ eligible: true, inputTokens: 1000 });
    expect(count.mock.calls[0][0]).toMatchObject({ messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user', content: 'widgets?' }] });
  });
  it('fails closed on missing limit, context overflow and API failure', async () => {
    const base = { corpus: await corpus(), corpusDir: '.', config, client: client() };
    expect(await createWholeFallbackGuard({ ...base, env: {} })({ question: 'widgets?' })).toMatchObject({ eligible: false, reason: 'context-limit-unconfigured' });
    expect(await createWholeFallbackGuard({ ...base, env: { RAG_GENERATOR_CONTEXT_TOKENS: '1999' } })({ question: 'widgets?' })).toMatchObject({ eligible: false, reason: 'context-overflow' });
    const failed = client(vi.fn(async () => { throw new Error('private provider detail'); }));
    expect(await createWholeFallbackGuard({ ...base, client: failed, env: { RAG_GENERATOR_CONTEXT_TOKENS: '2000' } })({ question: 'widgets?' })).toEqual({ eligible: false, reason: 'count-unavailable' });
  });
});
it('retains known retrieval charges without declaring interrupted calls free', () => {
  expect(retrievalCost(trace())).toEqual({ dollars: null, knownDollars: .01, incomplete: true });
});
it('returns deterministic eval answers with zero generator usage and retained retrieval bills', async () => {
  const approach = ragApproach(config, { corpusDir: '.', client: client(), preparePipeline: async () => ({ resolve: async () => ({ kind: 'route', route: 'redirect', answer: 'Ask Pat directly.', trace: trace() }) }), fallbackEligible: async () => ({ eligible: true }) });
  const result = await runApproach({ approach, corpus: await corpus(), cases: [c], concurrency: 1, model: config.model, judgeModel: '' });
  expect(result.cases[0].answer).toMatchObject({ text: 'Ask Pat directly.', effectiveApproach: 'deterministic', retrievedChunkIds: [], usage: { input_tokens: 0, output_tokens: 0 }, timings: { firstTokenMs: null } });
  expect(summarize(result)).toMatchObject({ retrievalDollars: null, totalDollars: null, costIncomplete: true, knownDollars: .01 });
});
it('records safe inability response when fallback cannot fit', async () => {
  const approach = ragApproach(config, { corpusDir: '.', client: client(), preparePipeline: async () => ({ resolve: async () => ({ kind: 'fallback', reason: 'index-stale', trace: trace() }) }), fallbackEligible: async () => ({ eligible: false }) });
  await approach.prepare(await corpus()); const answer = await approach.answer('widgets?'); expect(answer.actualContext).toBe('none'); expect(answer.retrievedChunkIds).toEqual([]); expect(answer.usage.output_tokens).toBe(0);
});
it.each(['evidence', 'fallback'] as const)('generates %s answers with local usage and accurate context attribution', async kind => {
  const stream = vi.fn((_request: unknown) => { void _request; return {
    async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fictional answer' } }; },
    finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } }), abort: vi.fn(),
  }; });
  const api = { beta: { messages: { stream, countTokens: vi.fn() } } } as unknown as Anthropic;
  const unit = { id: 'EX-1', kind: 'entry' as const, document: 'FictionalCo', title: 'Scope', searchText: 'Widgets.', promptText: 'Built fictional widgets.', indexedHash: 'a'.repeat(64), promptHash: 'b'.repeat(64) };
  const approach = ragApproach(config, { corpusDir: '.', client: api, preparePipeline: async () => ({ resolve: async () => kind === 'evidence' ? { kind, selected: [unit], trace: trace() } : { kind, reason: 'fictional', trace: trace() } }), fallbackEligible: async () => ({ eligible: true }) });
  await approach.prepare(await corpus()); const result = await approach.answer('widgets?');
  expect(result).toMatchObject({ text: 'Fictional answer', effectiveApproach: kind === 'evidence' ? 'rag' : 'whole', actualContext: kind === 'evidence' ? 'selected-evidence' : 'whole-corpus', retrievedChunkIds: kind === 'evidence' ? ['EX-1'] : [], usage: { input_tokens: 50, output_tokens: 10 } });
  expect(stream).toHaveBeenCalledOnce();
});
