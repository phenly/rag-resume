import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { loadCorpus } from '../lib/corpus';
import { evalHistory, validateCases } from '../lib/eval/cases';
import { wholeApproach } from '../lib/eval/whole';
import { ragApproach } from '../lib/eval/rag';
import { buildSystemPrompt } from '../lib/prompt';
import { RETRIEVAL_CONFIG_VERSION } from '../lib/retrieval/pipeline';

const config = { apiKey: 'fictional', model: 'fictional-model', effort: 'low' as const, maxTokens: 1000 };
const history = [{ question: 'What did Pat build at FictionalCo?', answer: 'Pat built widgets.' }];
const trace = { retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, elapsedMs: 1, stages: {} };
function api(resolvedModel = config.model) {
  const stream = vi.fn((_request: unknown) => { void _request; return {
    async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fictional result.' } }; },
    finalMessage: async () => ({ model: resolvedModel, stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } }), abort: vi.fn(),
  }; });
  return { stream, client: { beta: { messages: { stream, countTokens: vi.fn() } } } as unknown as Anthropic };
}

describe('trusted offline conversation fixtures', () => {
  it('validates production history bounds and snapshots fixture data', () => {
    expect(evalHistory(undefined)).toEqual([]);
    const turns = evalHistory(history);
    expect(turns).toEqual([{ ...history[0], sig: '' }]);
    expect(turns[0]).not.toBe(history[0]);
    expect(evalHistory(Array.from({ length: 6 }, () => ({ question: '', answer: '' })))).toHaveLength(6);
    expect(evalHistory([{ question: '', answer: 'x'.repeat(16000) }])).toHaveLength(1);
  });
  it.each([null, {}, [{ question: 'q' }], [{ question: 1, answer: 'a' }], [{ question: 'q', answer: 'a', sig: 'forged' }], Array.from({ length: 7 }, () => ({ question: 'q', answer: 'a' })), [{ question: 'q', answer: 'a'.repeat(16000) }]])('rejects invalid history before provider work: %j', value => {
    expect(() => evalHistory(value)).toThrow('Invalid eval history');
    expect(() => validateCases({ version: 1, cases: [{ id: 'MT1', question: 'more?', rubric: 'Grounded result', source: 'fictional', category: 'grounded', status: 'decided', goldChunks: [], mustSay: [], mustNotSay: [], history: value }] })).toThrow('Invalid eval cases');
  });
  it.each(['What was the result?', 'Tell me more.', 'Switch topics: what leadership experience does Pat have?'])('passes the identical full conversation to both generators: %s', async question => {
    const corpus = await loadCorpus('sample-corpus');
    const wholeApi = api(); const ragApi = api();
    const resolve = vi.fn(async () => ({ kind: 'fallback' as const, reason: 'fixture', trace }));
    const guard = vi.fn(async (_question: string, _history?: unknown) => { void _question; void _history; return { eligible: true }; });
    const whole = wholeApproach(config, wholeApi.client);
    const rag = ragApproach(config, { corpusDir: '.', client: ragApi.client, preparePipeline: async () => ({ resolve }), fallbackEligible: guard });
    await whole.prepare(corpus); await rag.prepare(corpus);
    const a = await whole.answer(question, history); const b = await rag.answer(question, history);
    const messages = [{ role: 'user', content: history[0].question }, { role: 'assistant', content: history[0].answer }, { role: 'user', content: question }];
    expect(wholeApi.stream.mock.calls[0][0]).toMatchObject({ messages });
    expect(ragApi.stream.mock.calls[0][0]).toMatchObject({ messages });
    expect(resolve).toHaveBeenCalledWith({ question, verifiedHistory: history });
    expect(guard).toHaveBeenCalledWith(question, history);
    expect(a.suppliedEvidence).toBe(buildSystemPrompt(corpus).map(block => block.text).join('\n\n'));
    expect(b.suppliedEvidence).toBe(a.suppliedEvidence);
    expect(a.resolvedModel).toBe(config.model);
    expect(a.resolvedModels).toEqual([config.model]);
  });
  it('passes history to exact selected-context counting and generation', async () => {
    vi.stubEnv('RAG_GENERATOR_CONTEXT_TOKENS', '1000000');
    try {
      const mock = api();
      const countTokens = vi.fn(async (_request: unknown) => { void _request; return { input_tokens: 1000 }; });
      (mock.client.beta.messages as unknown as { countTokens: typeof countTokens }).countTokens = countTokens;
      const unit = { id: 'EX-1', kind: 'entry' as const, document: 'FictionalCo', title: 'Scope', searchText: 'Widgets.', promptText: 'Built fictional widgets.', indexedHash: 'a'.repeat(64), promptHash: 'b'.repeat(64) };
      const approach = ragApproach(config, { corpusDir: '.', client: mock.client, preparePipeline: async () => ({ resolve: async () => ({ kind: 'evidence', selected: [unit], trace }) }) });
      await approach.prepare(await loadCorpus('sample-corpus'));
      const answer = await approach.answer('What was the result?', history);
      expect(countTokens.mock.calls[0][0]).toMatchObject({ messages: [{ role: 'user', content: history[0].question }, { role: 'assistant', content: history[0].answer }, { role: 'user', content: 'What was the result?' }] });
      expect(answer.actualContext).toBe('selected-evidence');
      expect(answer.suppliedEvidence).toContain('Built fictional widgets.');
    } finally { vi.unstubAllEnvs(); }
  });
  it('rejects malformed fixture history before retrieval or generation', async () => {
    const mock = api(); const resolve = vi.fn();
    const approach = ragApproach(config, { corpusDir: '.', client: mock.client, preparePipeline: async () => ({ resolve }) });
    await approach.prepare(await loadCorpus('sample-corpus'));
    await expect(approach.answer('more?', [{ question: 'q', answer: 'a', sig: 'forged' }] as never)).rejects.toThrow('Invalid eval history');
    expect(resolve).not.toHaveBeenCalled(); expect(mock.stream).not.toHaveBeenCalled();
  });
  it('retains the actual provider fallback model instead of claiming the requested model', async () => {
    const mock = api('fictional-fallback-model');
    const approach = wholeApproach(config, mock.client);
    await approach.prepare(await loadCorpus('sample-corpus'));
    const answer = await approach.answer('widgets?');
    expect(answer.resolvedModel).toBe('fictional-fallback-model');
    expect(answer.resolvedModels).toEqual(['fictional-fallback-model']);
  });
  it.each(['fictional-partial-model', undefined])('retains partial response model attribution %s on failure', async model => {
    const stream = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { model, usage: { input_tokens: 10, output_tokens: 1 } } };
        throw new Error('fictional stream failure');
      }, finalMessage: vi.fn(), abort: vi.fn(),
    });
    const client = { beta: { messages: { stream } } } as unknown as Anthropic;
    const approach = wholeApproach(config, client);
    await approach.prepare(await loadCorpus('sample-corpus'));
    await expect(approach.answer('widgets?')).rejects.toMatchObject({ resolvedModel: model, resolvedModels: [model ?? '__unknown__'], usageIncomplete: true, usage: { input_tokens: 10 } });
  });
});
